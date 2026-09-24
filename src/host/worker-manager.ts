import type { Context } from '@deepseek-ai/cordis'
import { appendFileSync, existsSync, lstatSync, mkdirSync } from 'node:fs'
import type { Config } from './config'
import { expandHome as expandConfigPath, resolveDshHome } from './paths'
import { WorkerClient, makeToken, parsePortLine, sleep, type WorkerHealth } from './client-http'

/**
 * 路径是否「可用」。
 *
 * ⚠️ 实测坑：Windows Store 版 Python 是**应用执行别名**（app execution alias），
 * 本质是一个 reparse point —— 跟随它做 `statSync`/`realpathSync` 会抛 **EACCES**，
 * 而 Node 的 `existsSync` 对任何 stat 异常都返回 **false**。
 * 于是明明能正常执行的
 * `…\WindowsApps\PythonSoftwareFoundation.Python.3.12_…\python.exe`
 * 会被误判为「不存在」，导致显式配置的 `pythonExe` 被静默忽略（本机实测踩到）。
 *
 * `lstatSync` 不跟随最终组件，因此能正确识别这类别名。
 * 所以：existsSync 为真 → 可用；否则再看 lstat 能否成功。
 */
function pathUsable(p: string): boolean {
  if (!p) return false
  if (existsSync(p)) return true
  try {
    lstatSync(p)
    return true // 别名 / reparse point：能 lstat 到就算可用
  } catch {
    return false
  }
}

/**
 * worker 管理器（§2 host 半）。
 *
 * 职责：
 * - 懒启动：首个生图请求时才拉起 worker（避免无谓占用）
 * - 健康探活：/health 轮询
 * - 空闲卸载：keepAliveMinutes 到期自动 unload 释放显存
 * - 崩溃退避重启：异常退出后按指数退避重试，超过上限则标记不可用
 * - 退出清理：插件卸载/HMR 时终止子进程（不留僵尸 python）
 *
 * 生命周期归 Cordis fiber：所有定时器与监听都挂在 ctx 上，卸载自动回收。
 */

/**
 * 把 spawn 诊断写进文件（不抛错）。
 *
 * 为什么需要：worker 若在宿主进程内「秒退」，它的 stdout/stderr 只存在于
 * `subprocess` 句柄的 collected 缓冲里，而工具返回给模型的错误文本会被
 * 截断到首行 —— 于是真因（Python 的 traceback）永远看不到。本机实测
 * 就卡在这里：同一个 argv 在任何普通 shell 里都能常驻，只有宿主内 spawn
 * 会 exitCode=1，且没有任何可观察输出。
 *
 * 所以：所有 spawn 生命周期事件都追加写到 `$DSH_HOME/dsh-qwen-image/logs/worker-spawn.log`，
 * 报错时也带上 outputDir 的绝对路径，方便直接去读。
 */
function diagLog(line: string): void {
  try {
    const dshHome = resolveDshHome()
    const dir = `${dshHome}/dsh-qwen-image/logs`
    mkdirSync(dir, { recursive: true })
    appendFileSync(`${dir}/worker-spawn.log`, `[${new Date().toISOString()}] ${line}\n`)
  } catch {
    // 诊断失败绝不影响主流程
  }
}

/** 读取 collected 输出（非消费式），失败/为空返回 '(空)'。 */
function readCollected(reader: OutputReader | undefined): string {
  if (!reader) return '(无该流)'
  try {
    const r = reader.readFrom(0)
    const text = r.text?.trim()
    if (!text) return '(空)'
    return r.lossy && r.spillPath ? `${text}\n[已截断，完整输出见 ${r.spillPath}]` : text
  } catch (err) {
    return `(读取失败：${(err as Error).message})`
  }
}

/**
 * 收集输出压成**单行**摘要。
 *
 * ⚠️ 本机实测：工具返回给模型的错误文本会被**截断到第一行**，
 * 所以多行诊断等于没写。把 stdout/stderr 折叠成一行、并用 `|` 分隔换行，
 * 才能保证 python 的 traceback 真的抵达模型眼前。
 */
function oneLine(text: string, max = 1500): string {
  const s = text.replace(/\s*\r?\n\s*/g, ' | ').trim()
  return s.length > max ? `${s.slice(0, max)}…（已截断）` : s
}

export type ManagerState = 'stopped' | 'starting' | 'ready' | 'error'

interface SubprocessHandle {
  readonly pid: number
  readonly done: Promise<{ exitCode: number | null; signal: string | null }>
  readonly collected: { stdout?: OutputReader; stderr?: OutputReader }
  terminate(): void
  waitForExit(signal?: AbortSignal): Promise<boolean>
}

interface OutputReader {
  readFrom(offset: number): { text: string; nextOffset: number; lossy: boolean; spillPath?: string }
}

interface SubprocessService {
  spawn(spec: {
    argv: readonly string[]
    cwd: string
    stdio: { stdin: 'ignore'; stdout: { maxBytes: number }; stderr: { maxBytes: number } }
    graceMs: number
    env?: Record<string, string>
  }): SubprocessHandle
}

export class WorkerManager {
  private state: ManagerState = 'stopped'
  private handle: SubprocessHandle | undefined
  private client: WorkerClient | undefined
  private token = ''
  private port = 0
  private bootLog = ''
  private lastError: string | undefined
  private restarts = 0
  private readonly maxRestarts = 3
  private idleTimer: (() => void) | undefined
  private lastUsedAt = 0
  private disposed = false
  /**
   * 自本次加载以来已完成的推理次数。
   * 用于识别「加载后第一张图」—— 实测它要多付约 100s 换入权重
   * （见 speed-profile.ts 的 FIRST_INFERENCE_EXTRA_SEC）。
   */
  private inferenceCount = 0
  private loadedAt = 0

  constructor(
    private readonly ctx: Context,
    private readonly config: Config,
  ) {}

  getStatus(): { state: ManagerState; port: number; pid?: number; error?: string; restarts: number } {
    return {
      state: this.state,
      port: this.port,
      pid: this.handle?.pid,
      error: this.lastError,
      restarts: this.restarts,
    }
  }

  getClient(): WorkerClient | undefined {
    return this.client
  }

  getBootLog(): string {
    return this.bootLog
  }

  /** 标记最近使用时间，重置空闲卸载计时。 */
  touch(): void {
    this.lastUsedAt = Date.now()
  }

  /**
   * 本次加载后是否还没跑过推理（即下一张图要付 loadExtra）。
   */
  isFirstInferenceAfterLoad(): boolean {
    return this.inferenceCount === 0
  }

  /** 记录一次成功的推理。 */
  markInference(): void {
    this.inferenceCount += 1
  }

  /** 模型刚被加载：重置推理计数。 */
  markLoaded(): void {
    this.inferenceCount = 0
    this.loadedAt = Date.now()
  }

  getLoadedAt(): number {
    return this.loadedAt
  }

  /**
   * 确保 worker 已启动并就绪（懒启动）。返回可用的 client。
   */
  async ensureStarted(): Promise<WorkerClient> {
    if (this.disposed) throw new Error('worker 管理器已释放')

    if (this.client && this.state === 'ready') {
      // 探活；失败则尝试重启
      try {
        await this.client.health()
        this.touch()
        return this.client
      } catch (err) {
        this.lastError = `健康检查失败：${(err as Error).message}`
        await this.stop()
      }
    }

    if (this.state === 'starting') {
      // 等待另一个调用完成启动
      for (let i = 0; i < 300; i++) {
        if (this.state === 'ready' && this.client) return this.client
        if (this.state === 'error') {
          diagLog(`ensureStarted 命中 error 状态：${this.lastError ?? '(无 lastError)'}`)
          throw new Error(this.lastError ?? 'worker 启动失败')
        }
        await sleep(1000)
      }
      throw new Error('等待 worker 启动超时')
    }

    return await this.start()
  }

  /**
   * 启动 worker 子进程并等待端口就绪。
   */
  private async start(): Promise<WorkerClient> {
    if (this.restarts >= this.maxRestarts) {
      this.state = 'error'
      this.lastError = `worker 连续启动失败 ${this.restarts} 次，已停止重试。最近错误：${this.lastError ?? '未知'}`
      throw new Error(this.lastError)
    }

    this.state = 'starting'
    this.lastError = undefined
    this.token = makeToken()

    const subprocess = this.ctx.get('subprocess') as SubprocessService | undefined
    if (!subprocess) {
      this.state = 'error'
      this.lastError = 'subprocess 服务不可用，无法启动 worker'
      throw new Error(this.lastError)
    }

    const python = this.resolvePython()
    const modelDir = expand(this.config.modelDir)
    const outputDir = expand(this.config.outputDir)
    const logFile = expand(`${this.config.outputDir}/../logs/worker.log`)
    const script = this.resolveScript()
    const dshHome = resolveDshHome() || process.cwd()

    const argv = [
      python,
      script,
      '--host',
      '127.0.0.1',
      '--port',
      String(this.config.workerPort ?? 0),
      '--model-dir',
      modelDir,
      '--output-dir',
      outputDir,
      '--token',
      this.token,
      '--min-vram',
      String(this.config.lowVramGuardMiB),
      '--log-file',
      logFile,
      '--device',
      this.config.device,
      '--dtype',
      this.config.dtype,
      '--offload',
      this.config.offload,
    ]

    this.bootLog = `启动 worker：${argv.join(' ')}\n`

    /** 单行诊断串：同时进日志与错误文本首行（错误文本只保留第一行）。 */
    const spawnDiag = `python=${python} script=${script} scriptExists=${existsSync(script)} cwd=${dshHome} cwdExists=${existsSync(dshHome)} modelDir=${modelDir} modelDirExists=${existsSync(modelDir)} outDir=${outputDir} outDirExists=${existsSync(outputDir)} dshHome=${process.env.DSH_HOME ?? '(未设置)'} hostCwd=${process.cwd()} node=${process.version} envKeys=${Object.keys(process.env).length}`

    diagLog(`=== spawn 请求 === ${spawnDiag}\nargv: ${JSON.stringify(argv)}`)

    try {
      this.handle = subprocess.spawn({
        argv,
        cwd: dshHome,
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: 4 * 1024 * 1024 },
          stderr: { maxBytes: 4 * 1024 * 1024 },
        },
        graceMs: 10000,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } as Record<string, string>,
      })
    } catch (err) {
      const e = err as Error
      this.state = 'error'
      // 单行：否则会被截断到首行，模型看不到真因
      this.lastError = `无法启动 python worker：${e.message}。请确认 pythonExe 配置或 venv 存在。【DIAG ${spawnDiag}】`
      diagLog(`spawn 同步抛错：${e.message}\n${e.stack ?? ''}`)
      throw new Error(this.lastError)
    }

    // 子进程退出监听：崩溃则按退避重启
    this.handle.done.then((outcome) => {
      if (this.disposed) return
      const wasReady = this.state === 'ready'
      const handle = this.handle
      const stdoutText = readCollected(handle?.collected.stdout)
      const stderrText = readCollected(handle?.collected.stderr)
      this.state = 'stopped'
      this.client = undefined
      // 单行：把 python 的 stdout/stderr 摘要塞进首行，模型才看得到
      this.lastError =
        `worker 退出（exitCode=${outcome.exitCode} signal=${outcome.signal ?? 'null'} pid=${handle?.pid ?? '?'} wasReady=${wasReady}）` +
        `【DIAG ${spawnDiag}】【stdout ${oneLine(stdoutText)}】【stderr ${oneLine(stderrText)}】`
      // 无论是否 ready 都记诊断：失败恰恰发生在 ready 之前，此前这段是盲区。
      diagLog(
        [
          '=== worker 退出 ===',
          `exitCode=${outcome.exitCode} signal=${outcome.signal} wasReady=${wasReady} pid=${handle?.pid ?? '?'}`,
          `managerState=${this.state} port=${this.port}`,
          `spawnDiag: ${spawnDiag}`,
          `--- stdout ---\n${stdoutText}`,
          `--- stderr ---\n${stderrText}`,
        ].join('\n'),
      )
      if (wasReady) {
        this.restarts += 1
        this.bootLog += `${this.lastError}\n`
        console.error(`[qwen-image] ${this.lastError}`)
      }
    }).catch((err) => {
      diagLog(`done promise 异常：${(err as Error).message}`)
    })

    // 等待 PORT= 行出现
    const port = await this.waitForPort()
    this.port = port
    this.client = new WorkerClient({ baseUrl: `http://127.0.0.1:${port}`, token: this.token })

    // 等待 /health 可用
    for (let i = 0; i < 60; i++) {
      try {
        const h = await this.client.health()
        if (h.ok) {
          this.state = 'ready'
          this.restarts = 0
          this.touch()
          this.scheduleIdleUnload()
          return this.client
        }
      } catch {
        // 继续等待
      }
      await sleep(1000)
    }

    this.state = 'error'
    this.lastError = `worker 已启动但 /health 在 60s 内未就绪。启动日志：\n${this.bootLog.slice(-2000)}`
    diagLog(
      [
        '=== /health 60s 未就绪 ===',
        `port=${this.port} pid=${this.handle?.pid ?? '?'}`,
        `--- stdout ---\n${readCollected(this.handle?.collected.stdout)}`,
        `--- stderr ---\n${readCollected(this.handle?.collected.stderr)}`,
      ].join('\n'),
    )
    await this.stop()
    throw new Error(this.lastError)
  }

  /** 从 stdout 解析 worker 打印的 PORT=<n>。 */
  private async waitForPort(): Promise<number> {
    const handle = this.handle
    const reader = handle?.collected.stdout
    let offset = 0
    /** 输出尾部快照：即使 collected 读取器不可用，也要让报错带上可诊断信息。 */
    const snapshot = (): string => {
      const out = readCollected(handle?.collected.stdout)
      const err = readCollected(handle?.collected.stderr)
      return ` pid=${handle?.pid ?? '?'}【stdout ${oneLine(out)}】【stderr ${oneLine(err)}】`
    }
    for (let i = 0; i < 120; i++) {
      if (reader) {
        try {
          const read = reader.readFrom(offset)
          if (read.text) {
            this.bootLog += read.text
            offset = read.nextOffset
            const port = parsePortLine(this.bootLog)
            if (port) return port
          }
        } catch {
          // 忽略读取异常，继续等待
        }
      }
      if (this.state === 'stopped') {
        const detail = `${this.lastError ?? ''}${this.bootLog.slice(-1500)}${snapshot()}`
        diagLog(`=== 未报告端口即退出 ===\n${detail}`)
        // 单行：错误文本只保留第一行，多行内容会被截断丢失
        throw new Error(`worker 在报告端口前退出。${oneLine(detail, 2500)}`)
      }
      await sleep(500)
    }
    const detail = `${this.bootLog.slice(-1500)}${snapshot()}`
    diagLog(`=== 等待端口超时（60s）===\n${detail}`)
    throw new Error(`等待 worker 端口超时（60s）。${oneLine(detail, 2500)}`)
  }

  /**
   * 注册一个可取消的定时器，返回清除函数。
   *
   * ⚠️ 实测教训（**曾经把整个插件卡死**）：cordis 的服务只有在本行 `inject`
   * 里声明过，才会以 mixin 的形式挂到 `ctx` 上。本插件为了不让可选服务缺失
   * 拖垮整棵插件树，刻意只 inject `tools`/`webServer`/`skills`（见 index.ts），
   * 于是 **`this.ctx.timeout` 是 `undefined`** —— 调用即 `TypeError`。
   *
   * 而它恰好被 `start()` 里健康探活的 `try { if (health().ok) { … scheduleIdleUnload() } } catch {}`
   * 包着：**探活成功后的第一个动作就抛错，被 catch 静默吞掉，循环继续下一轮**。
   * 结果就是「worker 明明活着、/health 每秒都回 200，管理器却在 60 秒后报
   * ‘/health 未就绪’并把它杀掉」。真因被两处静默（catch + 错误文本截断）埋掉了。
   *
   * 所以定时器一律走 `ctx.get('timer')`（可选消费，与 subprocess/jobs 同一约定），
   * 拿不到就退回 Node 原生定时器 —— 功能等价，只是不随 fiber 自动回收。
   */
  private setTimer(callback: () => void, delayMs: number): () => void {
    const timer = this.ctx.get?.('timer') as
      | { timeout?: (cb: () => void, delay: number) => () => void }
      | undefined
    if (timer && typeof timer.timeout === 'function') {
      return timer.timeout(callback, delayMs)
    }
    const handle = globalThis.setTimeout(callback, delayMs)
    return () => globalThis.clearTimeout(handle)
  }

  /** 空闲卸载：keepAliveMinutes 后 unload 释放显存。 */
  private scheduleIdleUnload(): void {
    this.clearIdleTimer()
    const minutes = Number(this.config.keepAliveMinutes) || 0
    if (minutes <= 0) return

    const tick = async () => {
      if (this.state !== 'ready' || !this.client) return
      const idleMs = Date.now() - this.lastUsedAt
      if (idleMs >= minutes * 60 * 1000) {
        try {
          const h = await this.client.health()
          if (h.state === 'ready') {
            await this.client.unload()
            console.log(`[qwen-image] worker 空闲 ${minutes} 分钟，已卸载模型释放显存`)
          }
        } catch {
          // 忽略
        }
      }
      this.idleTimer = this.setTimer(tick, 60000)
    }
    this.idleTimer = this.setTimer(tick, minutes * 60 * 1000)
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      try {
        this.idleTimer()
      } catch {
        // 忽略
      }
      this.idleTimer = undefined
    }
  }

  /** 健康快照（供 image_worker status / image_status 使用）。 */
  async tryHealth(): Promise<WorkerHealth | undefined> {
    if (!this.client || this.state !== 'ready') return undefined
    try {
      return await this.client.health()
    } catch {
      return undefined
    }
  }

  /** 停止 worker 并清理（不留僵尸进程）。 */
  async stop(): Promise<void> {
    this.clearIdleTimer()
    const handle = this.handle
    this.handle = undefined
    this.client = undefined
    this.state = 'stopped'
    if (!handle) return
    try {
      handle.terminate()
      await handle.waitForExit()
    } catch {
      // 已退出
    }
  }

  /** 插件卸载时的清理。 */
  async dispose(): Promise<void> {
    this.disposed = true
    await this.stop()
  }

  /**
   * python 可执行文件定位。
   *
   * 顺序：显式配置 → venv → PATH 兜底。**每一步都做存在性检查** ——
   * 否则 DSH_HOME 已设但 venv 尚未创建时会拿到一个不存在的路径，
   * 表现为「无法启动 python worker」而看不出真正原因（本机实测踩过）。
   */
  private resolvePython(): string {
    const explicit = this.config.pythonExe?.trim()
    if (explicit) {
      const p = expand(explicit)
      // 用 pathUsable（而非 existsSync）以免误杀 Windows Store 的应用执行别名
      if (pathUsable(p)) return p
      console.warn(`[qwen-image] 配置的 pythonExe 不可用：${p} —— 改按 venv/PATH 探测`)
    }

    const dshHome = resolveDshHome()
    for (const c of [
      `${dshHome}/dsh-qwen-image/venv/Scripts/python.exe`, // Windows venv
      `${dshHome}/dsh-qwen-image/venv/bin/python`, // POSIX venv
    ]) {
      if (pathUsable(c)) return c
    }

    // PATH 兜底（本机现状：系统 Python 已装 torch/diffusers，可直接用）
    return process.platform === 'win32' ? 'python' : 'python3'
  }

  /**
   * worker 脚本定位（相对包根）。
   *
   * 产物在 `lib/index.cjs`，故 `__dirname` 是包根的 `lib/`；worker 在包根的 `worker/`。
   * 逐候选检查存在性，并把实际选中的路径记进启动日志 —— 避免「路径猜错」变成哑失败。
   */
  private resolveScript(): string {
    const here = typeof __dirname === 'string' ? __dirname : process.cwd()
    const candidates = [
      `${here}/../worker/server.py`, // lib/ → ../worker/
      `${here}/../../worker/server.py`, // 产物若被移到 lib/host/ 下
      `${here}/worker/server.py`,
    ]
    for (const c of candidates) {
      if (pathUsable(c)) return c
    }
    return candidates[0] // 都不存在也返回首个，让 python 报错时带上这个路径
  }
}

/** 展开 $DSH_HOME 与 ~（实现已收口到 ./paths，含 DSH_HOME 未设置时的兜底）。 */
export function expand(p: string): string {
  return expandConfigPath(p)
}
