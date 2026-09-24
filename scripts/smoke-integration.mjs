/**
 * 宿主半 × 真实 worker 的集成冒烟（离线于 DSH，但全链路真实）。
 *
 * 之前的两类测试各覆盖一半：
 *   - smoke-host-e2e.mjs：真实插件产物 + **假** worker（验证工具/路由/注册表逻辑）
 *   - smoke-worker.mjs  ：**真** worker + 直接 HTTP（验证 Python 侧协议）
 * 但**「管理器 spawn 真 Python 进程 → 解析 PORT → 真加载 → 真推理 → 注册表 → /raw」**
 * 这条集成路径一直没被验证过。本脚本补上这一段：用一个真实
 * `ctx.subprocess` 适配器（基于 node:child_process）驱动真实插件产物。
 *
 * 覆盖点：
 *   1. resolvePython / resolveScript 解析出的路径**真的能跑**
 *   2. spawn → stdout 解析 `PORT=<n>` → WorkerClient 打通
 *   3. /load 真加载（约 75s）
 *   4. image_generate 真推理（默认 512²/4 步，约 1.5 分钟）→ 落盘 PNG
 *   5. 注册表记录 + manifest.json + /raw 路由返回合法 PNG
 *   6. image_result 能列出并取回该图
 *   7. image_worker stop 后进程真的退出（无僵尸）
 *
 * 运行：node scripts/smoke-integration.mjs [--size 512] [--steps 4]
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BUNDLE = join(ROOT, 'lib', 'index.cjs')

const argv = process.argv.slice(2)
const getArg = (n, d) => {
  const i = argv.indexOf(`--${n}`)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d
}
const SIZE = Number(getArg('size', '512'))
const STEPS = Number(getArg('steps', '4'))
/** 缺省权重目录：$DSH_QWEN_MODEL_DIR > $DSH_HOME/models/... > ~/.dsh/models/...（不写死任何人的机器） */
const DEFAULT_MODEL_DIR = process.env.DSH_QWEN_MODEL_DIR || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'models', 'Qwen-Image-2.1')
const MODEL_DIR = getArg('model', DEFAULT_MODEL_DIR)
// 缺省解释器：显式 --python > $DSH_QWEN_PYTHON > 插件自己的 venv（若安装过）> PATH 上的 python
const VENV_PYTHON =
  process.platform === 'win32'
    ? join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'dsh-qwen-image', 'venv', 'Scripts', 'python.exe')
    : join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'dsh-qwen-image', 'venv', 'bin', 'python')
const PYTHON = getArg('python', process.env.DSH_QWEN_PYTHON || (existsSync(VENV_PYTHON) ? VENV_PYTHON : 'python'))

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  if (ok) {
    pass++
    console.log(`  ok   ${name}`)
  } else {
    fail++
    console.error(`  FAIL ${name}${detail ? `\n       ${detail}` : ''}`)
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 捕获插件发出的 warn，供断言使用（例如「pythonExe 不可用」这类静默降级）
const warnings = []
const origWarn = console.warn
console.warn = (...a) => {
  const line = a.map((x) => (typeof x === 'string' ? x : String(x))).join(' ')
  warnings.push(line)
  origWarn(...a)
}

if (!existsSync(BUNDLE)) {
  console.error(`缺少 ${BUNDLE}：先运行 node scripts/build.mjs`)
  process.exit(1)
}

const OUT_DIR = join(mkdtempSync(join(tmpdir(), 'qw-integ-')), 'outputs')

console.log('\n=== 宿主半 × 真实 worker 集成冒烟 ===\n')
console.log(`权重目录：${MODEL_DIR}`)
console.log(`python  ：${PYTHON}`)
console.log(`输出目录：${OUT_DIR}`)
console.log(`生成参数：${SIZE}² / ${STEPS} 步\n`)

// ═══════════════════════════════════════════════════════════════════════════
// 真实 subprocess 适配器（实现 dsh-subprocess 的契约子集）
// ═══════════════════════════════════════════════════════════════════════════
const liveChildren = new Set()
/** 保留每个子进程的输出，失败时打印尾部便于定位。 */
const childLogs = []

function makeRealSubprocess() {
  return {
    resolveExecutable: async (cmd) => cmd,
    spawn(spec) {
      const [stdinMode, stdoutMode, stderrMode] = [spec.stdio.stdin, spec.stdio.stdout, spec.stdio.stderr]
      const child = spawn(spec.argv[0], spec.argv.slice(1), {
        cwd: spec.cwd,
        env: spec.env ?? process.env,
        stdio: [
          stdinMode === 'ignore' ? 'ignore' : 'pipe',
          stdoutMode === 'inherit' ? 'inherit' : 'pipe',
          stderrMode === 'inherit' ? 'inherit' : 'pipe',
        ],
        windowsHide: true,
      })
      liveChildren.add(child)

      // collect 模式：累积到内存，readFrom(offset) 按**非消费**语义返回增量
      const acc = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }
      childLogs.push(acc)
      const capOf = (mode) => (typeof mode === 'object' && mode ? mode.maxBytes : 1 << 20)
      const capOut = capOf(stdoutMode)
      const capErr = capOf(stderrMode)
      if (child.stdout) {
        child.stdout.on('data', (d) => {
          acc.stdout = Buffer.concat([acc.stdout, d])
          if (acc.stdout.length > capOut) acc.stdout = acc.stdout.subarray(acc.stdout.length - capOut)
        })
      }
      if (child.stderr) {
        child.stderr.on('data', (d) => {
          acc.stderr = Buffer.concat([acc.stderr, d])
          if (acc.stderr.length > capErr) acc.stderr = acc.stderr.subarray(acc.stderr.length - capErr)
        })
      }

      const reader = (key) => ({
        readFrom(fromByte) {
          const buf = acc[key]
          const slice = buf.subarray(Math.max(0, fromByte))
          return { text: slice.toString('utf8'), nextOffset: buf.length, lossy: false }
        },
      })

      const done = new Promise((res) => {
        child.on('close', (code, signal) => {
          liveChildren.delete(child)
          res({ exitCode: code, signal: signal ?? null })
        })
        child.on('error', () => {
          liveChildren.delete(child)
          res({ exitCode: -1, signal: null })
        })
      })

      return {
        pid: child.pid,
        stdin: child.stdin ?? undefined,
        stdout: child.stdout ?? undefined,
        stderr: child.stderr ?? undefined,
        collected: { stdout: reader('stdout'), stderr: reader('stderr') },
        done,
        terminate() {
          try {
            if (process.platform === 'win32') {
              spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
            } else {
              child.kill('SIGKILL')
            }
          } catch {
            /* ignore */
          }
        },
        async waitForExit(signal) {
          if (signal) {
            return await Promise.race([done.then(() => true), new Promise((r) => signal.addEventListener('abort', () => r(false)))])
          }
          await done
          return true
        },
      }
    },
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 最小可用 ctx（tools/webServer/skills 捕获，fs 真实，subprocess 真实）
// ═══════════════════════════════════════════════════════════════════════════
const captured = { tools: new Map(), routes: new Map(), taps: [], skills: [] }

const services = {
  tools: {
    register: (def) => {
      captured.tools.set(def.name, def)
      return () => {}
    },
  },
  webServer: {
    register: (route) => {
      captured.routes.set(`${route.kind}:${route.path}`, route)
      return () => {}
    },
    tapIndex: (fn) => {
      captured.taps.push(fn)
      return () => {}
    },
  },
  skills: {
    register: (s) => {
      captured.skills.push(s)
      return () => {}
    },
  },
  subprocess: makeRealSubprocess(),
  fs: {
    resolve: async (p) => ({ targetKey: p, displayPath: p }),
    stat: async (t) => {
      try {
        const s = statSync(t.targetKey)
        return { version: 'v1', type: s.isDirectory() ? 'directory' : 'file', size: s.size }
      } catch {
        return undefined
      }
    },
    listDir: async () => [],
    readBytes: async (t) => new Uint8Array(readFileSync(t.targetKey)),
    readText: async (t) => readFileSync(t.targetKey, 'utf8'),
    writeText: async (t, content) => {
      const { mkdirSync, writeFileSync } = await import('node:fs')
      mkdirSync(dirname(t.targetKey), { recursive: true })
      writeFileSync(t.targetKey, content, 'utf8')
      return { operation: 'create', version: 'v1', before: null, after: content }
    },
  },
  attachments: {
    saveImage: async (i) => ({ attachmentId: `att-${i.data.length}`, mediaType: i.mediaType, bytes: i.data.length }),
  },
  jobs: { start: () => 'qwen-image-1' },
}

const ctx = {
  ...services,
  get: (n) => services[n],
  on: () => () => {},
  effect: (cb) => {
    try {
      cb()
    } catch {
      /* ignore */
    }
    return () => {}
  },
  timeout: (cb, d) => {
    const t = setTimeout(cb, d)
    return () => clearTimeout(t)
  },
  interval: () => () => {},
}

const config = {
  backend: 'diffusers',
  modelDir: MODEL_DIR,
  pythonExe: PYTHON,
  device: 'cuda:0',
  dtype: 'fp16',
  offload: 'model',
  preset: 'draft',
  defaultSteps: STEPS,
  maxPixels: 1048576,
  outputDir: OUT_DIR,
  keepAliveMinutes: 0,
  maxConcurrent: 1,
  toolTimeoutMs: 20 * 60 * 1000,
  workerPort: 0,
  routePrefix: '/api/qwen-image',
  allowModelFetch: true,
  hfEndpoint: 'https://hf-mirror.com',
  modelRepo: 'Qwen/Qwen-Image-2.1',
  maxReferenceImages: 10,
  lowVramGuardMiB: 1024,
}

// ═══════════════════════════════════════════════════════════════════════════
const plugin = await import(pathToFileURL(BUNDLE).href)
const mod = plugin.default ?? plugin
mod.apply(ctx, config)

check(`插件 apply 后注册 ${captured.tools.size} 个工具`, captured.tools.size === 6)

let ok = true
try {
  // ---- 1. image_worker start：spawn 真进程 + 真加载 ----
  console.log('\n# image_worker start（spawn 真 Python + 加载 30GB 权重，约 60–90s）')
  const workerTool = captured.tools.get('image_worker')
  const t0 = Date.now()
  const started = await workerTool.execute({ action: 'start' }, {})
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
  check('worker 启动并加载完成', started.workerState === 'ready', JSON.stringify(started).slice(0, 300))
  check('拿到 loadSec', typeof started.loadSec === 'number' && started.loadSec > 10, String(started.loadSec))
  check('PID 存在（真进程）', typeof started.pid === 'number' || liveChildren.size > 0, `pid=${started.pid} children=${liveChildren.size}`)
  console.log(`      实测 ${elapsed}s（worker 上报 ${started.loadSec}s），活跃子进程 ${liveChildren.size}`)
  // 显式配置的 pythonExe 必须被采纳。
  // 回归点：Windows Store 的 python 是「应用执行别名」（reparse point），
  // 跟随它 stat 会 EACCES 而使 existsSync 返回 false —— 曾被误判为「不存在」而静默忽略配置。
  check(
    '显式配置的 pythonExe 未被误判为不存在',
    !warnings.some((w) => /pythonExe 不可用/.test(w)),
    warnings.join(' | '),
  )

  // ---- 2. 真推理 ----
  console.log(`\n# image_generate（真推理 ${SIZE}²/${STEPS} 步，约 1.5–3 分钟）`)
  const genTool = captured.tools.get('image_generate')
  const g = await genTool.execute({ prompt: 'a red apple on a wooden table, photorealistic', width: SIZE, height: SIZE, steps: STEPS }, {})
  check('image_generate 返回 ids', Array.isArray(g.ids) && g.ids.length === 1, JSON.stringify(g.ids))
  check('status=completed', g.status === 'completed', String(g.status))
  check('带回耗时与稳态步', typeof g.elapsedSec === 'number' && typeof g.steadyStepSec === 'number', JSON.stringify({ e: g.elapsedSec, s: g.steadyStepSec }))
  check('设备/精度正确', g.device === 'cuda:0' && g.dtype === 'fp16', `${g.device}/${g.dtype}`)
  console.log(`      实测总耗时 ${g.elapsedSec}s，稳态 ${g.steadyStepSec}s/步，峰值显存 ${g.peakVramMiB}MiB`)

  // ---- 3. 落盘 + 注册表 ----
  console.log('\n# 落盘与注册表')
  const file = g.files[0]
  check('PNG 真实落盘', existsSync(file), file)
  const bytes = existsSync(file) ? readFileSync(file) : Buffer.alloc(0)
  check('是合法 PNG（magic 校验）', bytes.length > 8 && bytes[0] === 0x89 && bytes.subarray(1, 4).toString() === 'PNG', `len=${bytes.length}`)
  check('manifest.json 已写', existsSync(join(OUT_DIR, 'manifest.json')))
  check('sidecar JSON 已写', existsSync(file.replace(/\.png$/, '.json')))
  console.log(`      输出 ${file}  ${bytes.length} bytes`)

  // ---- 缩略图：worker 存图时生成（历史相册网格靠它才不卡）----
  console.log('\n# 缩略图（历史相册网格用）')
  // 优先 WebP（体积约为 PNG 的 1/6）；Pillow 缺 WebP 支持时回退 .thumb.png
  const thumbWebp = file.replace(/\.png$/, '.thumb.webp')
  const thumbPng = file.replace(/\.png$/, '.thumb.png')
  const thumbPath = existsSync(thumbWebp) ? thumbWebp : thumbPng
  check('缩略图已落盘', existsSync(thumbPath), `${thumbWebp} 或 ${thumbPng}`)
  check('缩略图用的是 WebP 格式（体积优先）', existsSync(thumbWebp), `实际 ${thumbPath}`)
  if (existsSync(thumbPath)) {
    const tb = readFileSync(thumbPath)
    const isPng = tb[0] === 0x89 && tb.subarray(1, 4).toString() === 'PNG'
    const isWebp = tb.subarray(0, 4).toString() === 'RIFF' && tb.subarray(8, 12).toString() === 'WEBP'
    check('缩略图 magic 合法（PNG 或 WebP）', isPng || isWebp, `head=${tb.subarray(0, 12).toString('hex')}`)
    const ratio = (tb.length / bytes.length) * 100
    check('缩略图 ≤ 原图 12%（相册网格才拉得动）', ratio <= 12, `thumb=${tb.length} raw=${bytes.length} ratio=${ratio.toFixed(1)}%`)
    console.log(`      缩略图 ${tb.length} bytes（原图的 ${ratio.toFixed(1)}%，${existsSync(thumbWebp) ? 'WebP' : 'PNG'}）`)
  }

  // ---- /thumb 路由真能发缩略图（而非回退原图），且媒体类型正确 ----
  const thumbRoute = captured.routes.get('exact:/api/qwen-image/thumb')
  check('/thumb 路由已注册', !!thumbRoute)
  if (thumbRoute) {
    const cap = { status: 0, headers: {}, body: null }
    await thumbRoute.handler(
      { url: `/api/qwen-image/thumb?id=${g.ids[0]}` },
      { writeHead: (s, hh) => { cap.status = s; cap.headers = hh }, end: (b) => { cap.body = b } },
    )
    check('/thumb 返回 200', cap.status === 200, String(cap.status))
    check(
      '/thumb 走的是**缩略图**而非原图回退',
      cap.headers['X-Qwen-Image-Thumb'] === 'thumb',
      `X-Qwen-Image-Thumb=${cap.headers['X-Qwen-Image-Thumb']}`,
    )
    check(
      'Content-Type 与实际格式一致（WebP→image/webp）',
      cap.headers['Content-Type'] === 'image/webp',
      String(cap.headers['Content-Type']),
    )
    const served = Buffer.isBuffer(cap.body) ? cap.body : Buffer.from(cap.body ?? [])
    check('/thumb 字节数与磁盘缩略图一致', served.length === readFileSync(thumbPath).length, `served=${served.length}`)
  }

  // ---- 4. /raw 路由真能吐这张图 ----
  console.log('\n# 同源路由')
  const raw = captured.routes.get('exact:/api/qwen-image/raw')
  check('/raw 路由已注册', !!raw)
  if (raw) {
    const cap = { status: 0, headers: {}, body: null }
    await raw.handler(
      { url: `/api/qwen-image/raw?id=${g.ids[0]}` },
      { writeHead: (s, h) => { cap.status = s; cap.headers = h }, end: (b) => { cap.body = b } },
    )
    const served = Buffer.isBuffer(cap.body) ? cap.body : Buffer.from(cap.body ?? [])
    check('/raw 200 + image/png', cap.status === 200 && cap.headers['Content-Type'] === 'image/png', `${cap.status} ${cap.headers['Content-Type']}`)
    check('/raw 返回的字节与磁盘一致', served.length === bytes.length, `served=${served.length} disk=${bytes.length}`)
  }

  // ---- 5. image_result 能列能取 ----
  console.log('\n# image_result')
  const resTool = captured.tools.get('image_result')
  const list = await resTool.execute({ id: 'list' }, {})
  check("id='list' 列出本次记录", list.mode === 'list' && list.count >= 1, JSON.stringify(list).slice(0, 200))
  const one = await resTool.execute({ id: g.ids[0] }, {})
  check('按 id 取回', one.count === 1 && one.items[0].id === g.ids[0], JSON.stringify(one).slice(0, 200))

  // ---- 6. stop：确认无僵尸 ----
  console.log('\n# image_worker stop')
  const before = liveChildren.size
  await workerTool.execute({ action: 'stop' }, {})
  for (let i = 0; i < 30 && liveChildren.size > 0; i++) await sleep(500)
  check(`停止后子进程全部退出（${before} → ${liveChildren.size}）`, liveChildren.size === 0)
} catch (err) {
  ok = false
  check('集成流程未抛异常', false, err.stack ?? String(err))
  // 失败时把 worker 的输出尾部打出来 —— 「fetch failed」只说明连接断了，
  // 真正的原因（崩溃栈 / Python 异常）在 worker 自己的输出里。
  console.error('\n--- worker 输出尾部（诊断用）---')
  for (const acc of childLogs) {
    const out = acc.stdout.toString('utf8').trim()
    const errOut = acc.stderr.toString('utf8').trim()
    if (out) console.error(`[stdout 尾]\n${out.split('\n').slice(-25).join('\n')}`)
    if (errOut) console.error(`[stderr 尾]\n${errOut.split('\n').slice(-40).join('\n')}`)
  }
  console.error('--- worker 输出结束 ---\n')
} finally {
  for (const c of liveChildren) {
    try {
      if (process.platform === 'win32') spawn('taskkill', ['/pid', String(c.pid), '/T', '/F'], { windowsHide: true })
      else c.kill('SIGKILL')
    } catch {
      /* ignore */
    }
  }
}

console.log(`\n=== 结果：${pass} 通过，${fail} 失败 ===\n`)
process.exit(fail > 0 || !ok ? 1 : 0)
