/**
 * 宿主半端到端冒烟（A8 —— 无 GPU 也能跑）。
 *
 * 做法：真实加载编译后的 lib/index.cjs，用 stub 顶掉 DSH 运行时提供的三个外部模块
 * （dsh-tools / schemastery / cordis），再喂一个**假 worker**（本地 Node HTTP 服务，
 * 实现与 Python worker 相同的协议），然后完整跑通：
 *
 *   apply() → 工具注册 → image_status → image_worker → image_generate → image_result
 *          → 注册表落库 → /api/qwen-image/raw 路由取图 → 画廊
 *
 * 这样验证的是**真实代码路径**，不是重新实现的等价逻辑。
 *
 * 运行：node scripts/smoke-host-e2e.mjs
 * 退出码：0 全绿，1 有失败
 */

import { createServer } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BUNDLE = join(ROOT, 'lib', 'index.cjs')

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

if (!existsSync(BUNDLE)) {
  console.error(`缺少 ${BUNDLE}：先运行 node scripts/build.mjs`)
  process.exit(1)
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. 假 worker（实现 Python worker 的 HTTP 协议，返回罐装结果）
// ═══════════════════════════════════════════════════════════════════════════
const WORK = mkdtempSync(join(tmpdir(), 'qw-smoke-'))
const OUT_DIR = join(WORK, 'outputs')
mkdirSync(OUT_DIR, { recursive: true })

/** 造一个最小合法 PNG（8 字节签名 + 一个 IHDR 块即可被我们自己的 magic 校验通过）。 */
function fakePngBytes(size = 1024) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const rest = Buffer.alloc(Math.max(0, size - sig.length), 0x42)
  return Buffer.concat([sig, rest])
}

const workerState = {
  state: 'idle',
  loadSec: null,
  jobs: new Map(),
  counter: 0,
  calls: [],
  logLines: ['[smoke] 假 worker 启动'],
  minVramReject: false,
}

const fakeWorker = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  const send = (code, obj) => {
    const body = JSON.stringify(obj)
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) })
    res.end(body)
  }
  let raw = ''
  req.on('data', (c) => { raw += c })
  req.on('end', () => {
    workerState.calls.push(`${req.method} ${url.pathname}`)

    if (url.pathname === '/health') {
      return send(200, {
        ok: true,
        state: workerState.state,
        error: null,
        device: 'cuda:0',
        dtype: 'fp16',
        offload: 'model',
        loadSec: workerState.loadSec,
        warmed: false,
        vram: { free: 24172, total: 24473, peak: 16771 },
        queueDepth: 0,
      })
    }

    if (url.pathname === '/capabilities') {
      return send(200, {
        backend: 'diffusers',
        diffusersVersion: '0.41.0.dev0',
        transformers: '5.17.0',
        torch: '2.7.1+cu128',
        cuda: '12.8',
        supports: { rgba: true, mask: false, maskViaAnnotation: true, multiRef: true, maxRefs: 10 },
      })
    }

    if (url.pathname === '/load') {
      if (workerState.minVramReject) {
        return send(500, { error: '空闲显存仅 100 MiB（总 24473 MiB），低于阈值。建议停止占用进程后重试。' })
      }
      workerState.loadSec = 62.5
      workerState.state = 'ready'
      workerState.logLines.push('[smoke] 模型已加载')
      return send(200, { loaded: true, state: 'ready', loadSec: 62.5 })
    }

    if (url.pathname === '/unload') {
      workerState.state = 'idle'
      return send(200, { unloaded: true, state: 'idle' })
    }

    if (url.pathname === '/warm') {
      return send(200, { warmed: true, sec: 1.2 })
    }

    if (url.pathname === '/generate' || url.pathname === '/edit') {
      if (workerState.state !== 'ready') {
        return send(503, { error: `worker 未就绪（state=${workerState.state}）。请先 POST /load。` })
      }
      const payload = raw ? JSON.parse(raw) : {}
      workerState.counter += 1
      const jobId = `${url.pathname === '/edit' ? 'edit' : 'generate'}-${workerState.counter}`

      // 造一张真 PNG 落盘 + sidecar（与 Python worker 的产出形态一致）
      const png = join(OUT_DIR, `${jobId}.png`)
      const sidecar = join(OUT_DIR, `${jobId}.json`)
      const bytes = fakePngBytes(1024)
      writeFileSync(png, bytes)
      const meta = {
        id: jobId,
        file: png,
        width: payload.width ?? 1024,
        height: payload.height ?? 1024,
        mode: 'RGBA',
        hasAlpha: !!payload.transparent || true,
        bytes: bytes.length,
        seed: payload.seed ?? 12345,
        steps: payload.steps ?? 24,
        elapsedSec: 302.8,
        firstStepSec: 78.07,
        steadyStepSec: 8.819,
        vaeDecodeSec: 26,
        peakVramMiB: 16771,
        device: 'cuda:0',
        dtype: 'fp16',
        offload: 'model',
        usedReferences: (payload.images ?? []).length,
        prompt: payload.prompt ?? '',
        createdAt: new Date().toISOString(),
      }
      writeFileSync(sidecar, JSON.stringify(meta, null, 2))

      workerState.jobs.set(jobId, {
        id: jobId,
        kind: url.pathname === '/edit' ? 'edit' : 'generate',
        status: 'completed',
        progress: { step: meta.steps, total: meta.steps, elapsedMs: 302800, etaMs: 0, steadyStepMs: 8819, peakVramMiB: 16771 },
        result: {
          images: [{ id: jobId, file: png, sidecar, width: meta.width, height: meta.height, bytes: bytes.length, hasAlpha: meta.hasAlpha }],
          seed: meta.seed,
          steps: meta.steps,
          elapsedSec: meta.elapsedSec,
          gateSec: meta.elapsedSec,
          firstStepSec: meta.firstStepSec,
          steadyStepSec: meta.steadyStepSec,
          vaeDecodeSec: meta.vaeDecodeSec,
          peakVramMiB: meta.peakVramMiB,
          device: 'cuda:0',
          dtype: 'fp16',
          offload: 'model',
          hasAlpha: meta.hasAlpha,
          usedReferences: meta.usedReferences,
        },
      })
      return send(202, { jobId, status: 'queued' })
    }

    if (url.pathname.startsWith('/job/')) {
      const id = decodeURIComponent(url.pathname.slice('/job/'.length))
      const job = workerState.jobs.get(id)
      if (!job) return send(404, { error: 'job not found', id })
      return send(200, job)
    }

    if (url.pathname.startsWith('/cancel/')) {
      return send(200, { cancelled: false, id: url.pathname.slice('/cancel/'.length) })
    }

    if (url.pathname === '/logs') {
      return send(200, { lines: workerState.logLines })
    }

    send(404, { error: 'not found', path: url.pathname })
  })
})

await new Promise((r) => fakeWorker.listen(0, '127.0.0.1', r))
const FAKE_PORT = fakeWorker.address().port

// ═══════════════════════════════════════════════════════════════════════════
// 2. 直接加载产物 —— **不做任何模块 stub**
// ═══════════════════════════════════════════════════════════════════════════
// 这本身就是一条验收：插件以 link: 装入 profile 时，Node 按 realpath 解析，
// 从插件目录**够不到** dsh 安装目录里的 @deepseek-ai/*。所以 host 半产物必须
// **零外部依赖**。能直接 require 通过，就证明自包含的 tool-dsl / config-schema
// 已正确内联，且 DSL 用法合法（不支持的 schema 键会在 defineTool 时抛错 → 此处暴露）。
//
// ⚠️ 早期版本用 identity 的 defineTool stub，结果**掩盖了真实契约违规**：
//    · 参数 minimum/maximum 不被官方 DSL 支持
//    · output schema 的 object 必须显式 additionalProperties
// 现在不再 stub —— 这两类问题会在本测试里直接失败。


// ═══════════════════════════════════════════════════════════════════════════
// 3. 假 ctx（cordis 上下文）+ 假服务
// ═══════════════════════════════════════════════════════════════════════════
const registered = { tools: new Map(), routes: new Map(), indexTaps: [], skills: [] }
const effects = []
const timers = []

function makeCtx() {
  const services = {
    tools: {
      register: (def) => {
        if (registered.tools.has(def.name)) throw new Error(`duplicate tool ${def.name}`)
        registered.tools.set(def.name, def)
        return () => registered.tools.delete(def.name)
      },
    },
    webServer: {
      register: (route) => {
        const key = `${route.kind}:${route.path}`
        if (registered.routes.has(key)) throw new Error(`duplicate route ${key}`)
        registered.routes.set(key, route)
        return () => registered.routes.delete(key)
      },
      tapIndex: (fn) => {
        registered.indexTaps.push(fn)
        return () => {
          const i = registered.indexTaps.indexOf(fn)
          if (i >= 0) registered.indexTaps.splice(i, 1)
        }
      },
    },
    // 假 subprocess：区分两类调用
    //   1) worker 常驻进程（argv 含 worker/server.py）→ 立刻打印 PORT= 且永不退出
    //   2) 环境探针（python -c / --version / nvidia-smi）→ 立刻退出并返回罐装输出
    subprocess: {
      resolveExecutable: async (cmd) => cmd,
      spawn: (spec) => {
        const argv = spec.argv ?? []
        const isWorker = argv.some((a) => String(a).includes('server.py'))

        if (isWorker) {
          return {
            pid: 424242,
            done: new Promise(() => {}), // 永不 settle = 进程一直活着
            collected: {
              stdout: {
                readFrom: (offset) => {
                  const text = offset === 0 ? `PORT=${FAKE_PORT}\n` : ''
                  return { text, nextOffset: offset + text.length, lossy: false }
                },
              },
            },
            terminate() {},
            waitForExit: async () => true,
          }
        }

        // 探针：按 argv 内容给出确定性的罐装输出
        const joined = argv.join(' ')
        let stdout = ''
        let exitCode = 0
        if (joined.includes('nvidia-smi')) {
          stdout = '0, 24172, 24473, 0, Tesla P40\n'
        } else if (joined.includes('--version')) {
          stdout = 'Python 3.12.10\n'
        } else if (joined.includes('torch.cuda.is_available')) {
          stdout = 'True\n'
        } else if (joined.includes('psutil')) {
          // 内存探测（env-probe 的 probeMemory）
          stdout = JSON.stringify({ totalMiB: 32718, availableMiB: 26392, commitUsedMiB: 12890, commitLimitMiB: 87936 }) + '\n'
        } else if (joined.includes("import torch")) {
          stdout = '2.7.1+cu128\n'
        } else if (joined.includes("import transformers")) {
          stdout = '5.17.0\n'
        } else if (joined.includes("import diffusers")) {
          stdout = '0.41.0.dev0\n'
        } else {
          exitCode = 1
        }

        return {
          pid: 1000 + Math.floor(Math.random() * 1000),
          done: Promise.resolve({ exitCode, signal: null }),
          collected: {
            stdout: {
              readFrom: (offset) => {
                const text = offset === 0 ? stdout : ''
                return { text, nextOffset: offset + text.length, lossy: false }
              },
            },
          },
          terminate() {},
          waitForExit: async () => true,
        }
      },
    },
    // 假 skills：只实现 register（运行时技能注册路径）。
    // 刻意**不**实现 registerProvider —— 我们已从 provider 路径切换到 register 路径
    // （provider 的 candidate 需要 provider===provider.name 等更严的校验，
    //  第一版就是因此在运行时抛 "non-string provider"）。
    // 若代码退回 registerProvider，这里会直接暴露为 undefined 调用错误。
    skills: {
      register: (skill) => {
        registered.skills.push(skill)
        return () => {}
      },
    },
    // 假 fs：真的读写磁盘（基于 node:fs），与 dsh-subprocess-local 的执行世界一致
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
      listDir: async (t) => {
        const { readdirSync } = await import('node:fs')
        return readdirSync(t.targetKey, { withFileTypes: true }).map((e) => ({
          name: e.name,
          type: e.isDirectory() ? 'directory' : 'file',
          target: { targetKey: join(t.targetKey, e.name), displayPath: join(t.targetKey, e.name) },
        }))
      },
      readBytes: async (t) => new Uint8Array(readFileSync(t.targetKey)),
      readText: async (t) => readFileSync(t.targetKey, 'utf8'),
      writeText: async (t, content) => {
        mkdirSync(dirname(t.targetKey), { recursive: true })
        writeFileSync(t.targetKey, content, 'utf8')
        return { operation: 'create', version: 'v1', before: null, after: content }
      },
    },
    attachments: {
      saveImage: async (input) => ({
        attachmentId: `att-${Math.random().toString(16).slice(2, 10)}`,
        mediaType: input.mediaType,
        bytes: input.data.length,
      }),
    },
    jobs: {
      start: (spec) => {
        const hooks = spec.run()
        // 让后台任务真的跑完（冒烟里同步等）
        hooks.done.catch(() => {})
        return `qwen-image-1`
      },
    },
  }

  const ctx = {
    get: (name) => services[name],
    on: () => () => {},
    provide: () => () => {},
    effect: (cb) => {
      const disposer = cb()
      effects.push(disposer)
      return () => {}
    },
    timeout: (cb, delay) => {
      const t = setTimeout(cb, delay)
      timers.push(t)
      return () => clearTimeout(t)
    },
    interval: (cb, delay) => {
      const t = setInterval(cb, delay)
      timers.push(t)
      return () => clearInterval(t)
    },
  }
  // 让 ctx.xxx 也能取到服务（插件里用的是 ctx.get，但保险起见都挂上）
  Object.assign(ctx, services)
  return ctx
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. 加载真实插件并 apply
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n=== 宿主半端到端冒烟（假 worker）===\n')
console.log(`假 worker 端口：${FAKE_PORT}`)
console.log(`临时输出目录：${OUT_DIR}\n`)

const plugin = await import(pathToFileURL(BUNDLE).href)
const mod = plugin.default ?? plugin

check('插件模块导出 name', typeof mod.name === 'string' && mod.name.includes('qwen-image'), String(mod.name))
check('插件声明 inject 数组', Array.isArray(mod.inject) && mod.inject.includes('tools'))

const ctx = makeCtx()

// 用 Config 的默认值构造配置（stub schemastery 只做形态校验，这里直接给真实默认值）
const config = {
  backend: 'diffusers',
  modelDir: join(ROOT, 'qwen-image-2.1'), // 不存在的目录 → 测「缺权重」盘面
  pythonExe: '',
  device: 'cuda:0',
  dtype: 'fp16',
  offload: 'model',
  preset: 'standard',
  defaultSteps: 24,
  maxPixels: 1048576,
  outputDir: OUT_DIR,
  keepAliveMinutes: 0,
  maxConcurrent: 1,
  toolTimeoutMs: 60000,
  workerPort: 0,
  routePrefix: '/api/qwen-image',
  allowModelFetch: true,
  hfEndpoint: 'https://hf-mirror.com',
  modelRepo: 'Qwen/Qwen-Image-2.1',
  maxReferenceImages: 10,
  lowVramGuardMiB: 1024,
}

try {
  mod.apply(ctx, config)
  check('apply() 未抛异常', true)
} catch (err) {
  check('apply() 未抛异常', false, err.stack)
}

// ---- 注册结果 ----
console.log('\n# 注册结果')
const expectedTools = ['image_status', 'image_worker', 'image_generate', 'image_edit', 'image_result', 'image_model_fetch']
for (const t of expectedTools) {
  check(`工具 ${t} 已注册`, registered.tools.has(t))
}
check(`路由已注册（${registered.routes.size} 条）`, registered.routes.size >= 5, [...registered.routes.keys()].join(', '))
check('index tap 已注册（下发 routePrefix）', registered.indexTaps.length >= 1)

// ---- 技能注册（按 dsh-skill 源码的真实契约逐条校验）----
console.log('\n# 技能注册（真实契约）')
check('技能已注册', registered.skills.length === 1, `实际 ${registered.skills.length} 个`)
if (registered.skills.length) {
  const s = registered.skills[0]
  // dsh-skill: SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
  check('name 匹配 SKILL_NAME 正则', /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s.name ?? ''), String(s.name))
  check('description 是非空字符串', typeof s.description === 'string' && s.description.length > 0)
  check('content 是字符串且非空', typeof s.content === 'string' && s.content.length > 100, `len=${s.content?.length}`)
  check('source 是字符串', typeof s.source === 'string', String(s.source))
  check('whenToUse 是字符串', s.whenToUse === undefined || typeof s.whenToUse === 'string')
  check(
    'resourceBase 形状合法（directory + path）',
    s.resourceBase?.kind === 'directory' && typeof s.resourceBase.path === 'string' && s.resourceBase.path.length > 0,
    JSON.stringify(s.resourceBase),
  )
  // 模板占位符必须已被替换（否则模型会看到 {{MODEL_DIR}}）
  check('内容里的模板占位符已全部替换', !/\{\{[A-Z_]+\}\}/.test(s.content), (s.content.match(/\{\{[A-Z_]+\}\}/g) ?? []).join(', '))
  check(
    'register 路径不应带 provider/rank（那是 provider 路径的字段）',
    s.provider === undefined && s.rank === undefined,
    `provider=${s.provider} rank=${s.rank}`,
  )
  console.log(`       技能「${s.name}」content ${s.content.length} 字符，资源目录 ${s.resourceBase?.path}`)
}

// ---- index 注入内容 ----
console.log('\n# 配置下发')
if (registered.indexTaps.length) {
  const html = registered.indexTaps[0]('<html><head></head><body></body></html>')
  check('注入到 </head> 之前', html.includes('</head>') && html.indexOf('qwen-image-config') < html.indexOf('</head>'))
  const m = html.match(/window\.__QWEN_IMAGE__=(\{.*?\});<\/script>/s)
  check('注入的 JSON 可解析', !!m)
  if (m) {
    const injected = JSON.parse(m[1])
    check('下发 routePrefix', injected.routePrefix === '/api/qwen-image', injected.routePrefix)
    check('下发 presets（含实测耗时）', Array.isArray(injected.presets) && injected.presets.length === 3)
    const std = injected.presets?.find((p) => p.name === 'standard')
    check('standard 实测耗时约 303s', std && Math.abs(std.estimatedSec - 303) < 40, JSON.stringify(std))
  }
} else {
  check('index tap 存在', false)
}

// ---- image_status（缺权重盘面，永不失败）----
console.log('\n# image_status（缺权重盘面）')
const statusTool = registered.tools.get('image_status')
let statusValue
try {
  statusValue = await statusTool.execute({}, { signal: undefined })
  check('image_status 未抛异常（永不失败）', true)
} catch (err) {
  check('image_status 未抛异常（永不失败）', false, err.message)
}
if (statusValue) {
  check('modelState 为 missing（目录不存在）', statusValue.modelState === 'missing', String(statusValue.modelState))
  check('给出 guidance 数组', Array.isArray(statusValue.guidance) && statusValue.guidance.length > 0)
  check('给出可复制命令', Array.isArray(statusValue.commands) && statusValue.commands.length >= 3)
  check(
    '命令含 hf download',
    statusValue.commands.some((c) => c.includes('hf download')),
  )
  check('命令含 diffusers 安装', statusValue.commands.some((c) => c.includes('diffusers')))
  check('presets 三项齐全', Array.isArray(statusValue.presets) && statusValue.presets.length === 3)
  check(
    '采集了主机内存（内存不足会段错误而非报错，需前置提示）',
    !!statusValue.env?.memory && statusValue.env.memory.totalMiB > 0,
    JSON.stringify(statusValue.env?.memory),
  )
  check('worker 状态可查询（未启动）', typeof statusValue.worker?.state === 'string', JSON.stringify(statusValue.worker))
  const txt = statusTool.output.render({}, statusValue)
  check('render 产出文本块', Array.isArray(txt) && txt[0]?.type === 'text' && txt[0].text.length > 50)
}

// ---- model_fetch（未确认时只给命令）----
console.log('\n# image_model_fetch（强制确认）')
const fetchTool = registered.tools.get('image_model_fetch')
const unconfirmed = await fetchTool.execute({}, { signal: undefined })
check('未确认时状态为 awaiting-confirmation', unconfirmed.status === 'awaiting-confirmation', JSON.stringify(unconfirmed).slice(0, 200))
check('未确认时不启动下载', !unconfirmed.jobId)
check('给出带镜像的命令', String(unconfirmed.command).includes('hf-mirror.com'))
const confirmed = await fetchTool.execute({ confirm: true }, { signal: undefined })
check('确认后返回 started', confirmed.status === 'started', JSON.stringify(confirmed).slice(0, 200))

// ---- image_worker start（驱动假 worker 加载）----
console.log('\n# image_worker start')
const workerTool = registered.tools.get('image_worker')
let started
try {
  started = await workerTool.execute({ action: 'start' }, { signal: undefined })
  check('image_worker start 成功', started.workerState === 'ready', JSON.stringify(started).slice(0, 300))
  check('加载耗时被带回', started.loadSec === 62.5, String(started.loadSec))
} catch (err) {
  check('image_worker start 成功', false, err.message)
}

// ---- image_generate（完整走通）----
console.log('\n# image_generate（走通假 worker）')
const genTool = registered.tools.get('image_generate')
let genValue
try {
  genValue = await genTool.execute(
    { prompt: 'a red apple on a wooden table', preset: 'standard' },
    { signal: undefined, agent: undefined },
  )
  check('image_generate 未抛异常', true)
} catch (err) {
  check('image_generate 未抛异常', false, err.stack)
}
if (genValue) {
  check('返回 ids 数组', Array.isArray(genValue.ids) && genValue.ids.length === 1, JSON.stringify(genValue.ids))
  check('返回文件路径', Array.isArray(genValue.files) && genValue.files[0]?.endsWith('.png'))
  check('尺寸为 1024×1024（standard）', genValue.width === 1024 && genValue.height === 1024, `${genValue.width}x${genValue.height}`)
  check('回传耗时与稳态步', genValue.elapsedSec === 302.8 && genValue.steadyStepSec === 8.819)
  check('回传 estimateText（面向模型的自解释）', typeof genValue.estimateText === 'string' && genValue.estimateText.includes('预计耗时'))
  check('status 为 completed', genValue.status === 'completed')

  const meta = genTool.output.presentationMeta({}, genValue)
  check('presentationMeta 带 ids（卡片据此拼 URL）', Array.isArray(meta.ids) && meta.ids.length === 1, JSON.stringify(meta))
  const txt = genTool.output.render({}, genValue)
  check('render 文本含 id 与路径', txt[0].text.includes(genValue.ids[0]) && txt[0].text.includes('.png'))

  // 文件真的落盘了吗
  check('PNG 真实落盘', existsSync(genValue.files[0]))
  check('manifest.json 已写', existsSync(join(OUT_DIR, 'manifest.json')))
}

// ---- 参数校验 ----
console.log('\n# image_generate 参数校验')
const bad = [
  [{ prompt: 'x', preset: 'custom' }, /custom/],
  [{ prompt: 'x', width: 4000, height: 4000 }, /过大|maxPixels|超过/],
  [{ prompt: 'x', preset: 'standard', width: 512 }, /互斥/],
  [{ prompt: 'x', count: 9 }, /count/],
]
for (const [args, re] of bad) {
  let msg = ''
  try {
    await genTool.execute(args, { signal: undefined })
  } catch (err) {
    msg = err.message
  }
  check(`拒绝非法参数 ${JSON.stringify(args).slice(0, 46)}`, re.test(msg), `实际错误：${msg || '（未抛错）'}`)
}

// ---- image_result ----
console.log('\n# image_result')
const resTool = registered.tools.get('image_result')
const latest = await resTool.execute({}, { signal: undefined })
check('取回最新一张', latest.mode === 'detail' && latest.count === 1, JSON.stringify(latest).slice(0, 200))
const listed = await resTool.execute({ id: 'list' }, { signal: undefined })
check('list 模式返回记录', listed.mode === 'list' && listed.count >= 1, JSON.stringify(listed).slice(0, 200))
const missing = await resTool.execute({ id: 'no-such-id' }, { signal: undefined })
check('未知 id 给出友好提示而非崩溃', missing.count === 0 && String(missing.detail).includes('找不到'))
const lt = resTool.output.render({}, latest)
check('render 含 id 与提示词', lt[0].text.includes(latest.items[0].id))

// ---- image_edit（用刚生成的图当输入）----
console.log('\n# image_edit')
const editTool = registered.tools.get('image_edit')
let editValue
try {
  editValue = await editTool.execute(
    { prompt: '背景换成黄昏海滩', image: genValue.ids[0], preset: 'draft' },
    { signal: undefined },
  )
  check('image_edit 未抛异常', true)
  check('返回新 id（与输入不同）', editValue.ids[0] !== genValue.ids[0])
  check('记录 inputImage', typeof editValue.inputImage === 'string' && editValue.inputImage.endsWith('.png'))
  check('返回 usedReferences', typeof editValue.usedReferences === 'number')
} catch (err) {
  check('image_edit 未抛异常', false, err.stack)
}
const editMissing = await editTool.execute({ prompt: 'x', image: 'no-such-id' }, { signal: undefined }).catch((e) => e)
check('未知图像引用被拒绝并给出可用选项', editMissing instanceof Error && /无法解析|找不到/.test(editMissing.message), String(editMissing?.message))

// ---- 路由：/raw 真能吐图 ----
console.log('\n# 同源路由')
const rawRoute = registered.routes.get('exact:/api/qwen-image/raw')
check('/raw 路由已注册', !!rawRoute)
if (rawRoute && genValue) {
  const captured = { status: 0, headers: {}, body: null }
  const fakeRes = {
    writeHead(status, headers) {
      captured.status = status
      captured.headers = headers
    },
    end(body) {
      captured.body = body
    },
  }
  await rawRoute.handler({ url: `/api/qwen-image/raw?id=${genValue.ids[0]}` }, fakeRes)
  check('/raw 返回 200', captured.status === 200, `实际 ${captured.status}`)
  check('/raw Content-Type 为 image/png', captured.headers['Content-Type'] === 'image/png', captured.headers['Content-Type'])
  const buf = Buffer.isBuffer(captured.body) ? captured.body : Buffer.from(captured.body ?? [])
  check(
    '/raw 返回合法 PNG（magic 校验）',
    buf.length > 8 && buf[0] === 0x89 && buf.subarray(1, 4).toString() === 'PNG',
    `len=${buf.length}`,
  )
  check('/raw 可长缓存（内容寻址）', String(captured.headers['Cache-Control'] ?? '').includes('immutable'))

  // 未知 id → 404
  const cap404 = { status: 0 }
  await rawRoute.handler(
    { url: '/api/qwen-image/raw?id=nope' },
    { writeHead: (s) => { cap404.status = s }, end: () => {} },
  )
  check('/raw 未知 id 返回 404', cap404.status === 404, `实际 ${cap404.status}`)
}

const galleryRoute = registered.routes.get('exact:/api/qwen-image/gallery.json')
check('/gallery.json 路由已注册', !!galleryRoute)
if (galleryRoute) {
  const cap = { body: null }
  await galleryRoute.handler(
    { url: '/api/qwen-image/gallery.json' },
    { writeHead: () => {}, end: (b) => { cap.body = b } },
  )
  const parsed = JSON.parse(typeof cap.body === 'string' ? cap.body : '{}')
  check('gallery.json 返回条目', parsed.count >= 1, JSON.stringify(parsed).slice(0, 200))
  check('条目带 rawUrl（灯箱用）', String(parsed.items?.[0]?.rawUrl).startsWith('/api/qwen-image/raw?id='))
  check('条目带 thumbUrl（网格用）', String(parsed.items?.[0]?.thumbUrl).startsWith('/api/qwen-image/thumb?id='))
  check('条目带 hasThumb 标记', typeof parsed.items?.[0]?.hasThumb === 'boolean', String(parsed.items?.[0]?.hasThumb))
}

// ---- /thumb：有缩略图发缩略图，没有则回退原图（回顾时不留空白格）----
const thumbRoute = registered.routes.get('exact:/api/qwen-image/thumb')
check('/thumb 路由已注册', !!thumbRoute)
if (thumbRoute && genValue) {
  const cap = { status: 0, headers: {}, body: null }
  await thumbRoute.handler(
    { url: `/api/qwen-image/thumb?id=${genValue.ids[0]}` },
    { writeHead: (s, hh) => { cap.status = s; cap.headers = hh }, end: (b) => { cap.body = b } },
  )
  check('/thumb 返回 200 + image/png', cap.status === 200 && cap.headers['Content-Type'] === 'image/png', `${cap.status} ${cap.headers['Content-Type']}`)
  const tbuf = Buffer.isBuffer(cap.body) ? cap.body : Buffer.from(cap.body ?? [])
  check('/thumb 返回合法 PNG', tbuf.length > 8 && tbuf[0] === 0x89 && tbuf.subarray(1, 4).toString() === 'PNG', `len=${tbuf.length}`)
  check(
    '/thumb 标注走了缩略图还是原图回退',
    ['thumb', 'fallback-raw'].includes(String(cap.headers['X-Qwen-Image-Thumb'])),
    String(cap.headers['X-Qwen-Image-Thumb']),
  )
  console.log(`      假 worker 未提供缩略图 → 回退原图（X-Qwen-Image-Thumb=${cap.headers['X-Qwen-Image-Thumb']}）`)

  const cap404 = { status: 0 }
  await thumbRoute.handler(
    { url: '/api/qwen-image/thumb?id=nope' },
    { writeHead: (s) => { cap404.status = s }, end: () => {} },
  )
  check('/thumb 未知 id 返回 404', cap404.status === 404, `实际 ${cap404.status}`)
}

// ---- /unload（相册页脚的「释放显存」）----
// 注意：必须放在 image_worker 那一段**之后** —— 调用它会真的把假 worker 置为 idle，
// 会破坏前面「status 报告 ready」之类的断言。
const unloadRoute = registered.routes.get('exact:/api/qwen-image/unload')
check('/unload 路由已注册', !!unloadRoute)

const healthRoute = registered.routes.get('exact:/api/qwen-image/health')
if (healthRoute) {
  const cap = { body: null }
  await healthRoute.handler({ url: '/api/qwen-image/health' }, { writeHead: () => {}, end: (b) => { cap.body = b } })
  const parsed = JSON.parse(typeof cap.body === 'string' ? cap.body : '{}')
  check('插件 /health 汇总 worker 状态', parsed.worker?.state === 'ready', JSON.stringify(parsed).slice(0, 200))
  check('/health 带 galleryCount', typeof parsed.galleryCount === 'number')
}

// ---- image_worker 其余动作 ----
console.log('\n# image_worker 其他动作')
const st = await workerTool.execute({ action: 'status' }, { signal: undefined })
check('status 报告 ready + 显存', st.workerState === 'ready' && st.vramFreeMiB === 24172, JSON.stringify(st).slice(0, 250))
const logs = await workerTool.execute({ action: 'logs', count: 5 }, { signal: undefined })
check('logs 返回日志行', Array.isArray(logs.logs) && logs.logs.length > 0)
const unloaded = await workerTool.execute({ action: 'unload' }, { signal: undefined })
check('unload 成功', unloaded.workerState === 'idle', JSON.stringify(unloaded).slice(0, 200))

// ---- /unload 路由（历史相册页脚的「释放显存」按钮走这里）----
// 放在这里是因为它会真的把假 worker 置为 idle，不能早于上面的 status 断言。
if (unloadRoute) {
  const cap = { body: null }
  await unloadRoute.handler({ url: '/api/qwen-image/unload' }, { writeHead: () => {}, end: (b) => { cap.body = b } })
  const parsed = JSON.parse(typeof cap.body === 'string' ? cap.body : '{}')
  check('/unload 路由转发给 worker 并成功', parsed.unloaded === true, JSON.stringify(parsed).slice(0, 200))
}

const stopped = await workerTool.execute({ action: 'stop' }, { signal: undefined })
check('stop 后管理器状态为 stopped', stopped.managerState === 'stopped', JSON.stringify(stopped).slice(0, 200))

// 未就绪时 generate 应给可操作提示（而不是静默失败）
const notReady = await genTool.execute({ prompt: 'x', preset: 'draft' }, { signal: undefined }).catch((e) => e)
check('worker 未就绪时重新拉起（懒启动）', !(notReady instanceof Error), notReady instanceof Error ? notReady.message : '')

// ---- 相册增强 v2：查询 / 排序 / 分类 / 改 / 删 / 回收站 ----
console.log('\n# 相册增强（查询 / 排序 / 分类 / 改 / 删 / 回收站）')

/**
 * 以「node http 请求的样子」驱动已注册路由：status / headers / body 全收回来。
 * POST 的 body 用异步迭代器喂进去 —— 正好覆盖 routes.ts 里 readJsonBody 的路径。
 */
async function callRoute(url, opts = {}) {
  const path = url.split('?')[0]
  const route = registered.routes.get(`exact:${path}`)
  if (!route) throw new Error(`未注册路由：${path}`)
  const req = {
    url,
    method: opts.method ?? 'GET',
    [Symbol.asyncIterator]: async function* () {
      if (opts.body !== undefined) yield Buffer.from(JSON.stringify(opts.body), 'utf8')
    },
  }
  const cap = { status: 0, headers: {}, body: null }
  await route.handler(req, {
    writeHead: (status, headers) => {
      cap.status = status
      cap.headers = headers ?? {}
    },
    end: (b) => {
      cap.body = b
    },
  })
  const text = Buffer.isBuffer(cap.body) ? cap.body.toString('utf8') : String(cap.body ?? '')
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    /* 非 JSON 响应（图片等）留给调用方看 text */
  }
  return { ...cap, text, json }
}

const gallery = await callRoute('/api/qwen-image/gallery.json?limit=100')
check('gallery.json 返回 200', gallery.status === 200, `实际 ${gallery.status}`)
check(
  'gallery.json 带 items/total/facets',
  Array.isArray(gallery.json?.items) && typeof gallery.json?.total === 'number' && !!gallery.json?.facets,
  JSON.stringify(gallery.json).slice(0, 160),
)
const galleryItems = gallery.json?.items ?? []
check('相册里有前面生成的图', galleryItems.length >= 2, galleryItems.map((i) => i.id).join(','))
check(
  '每条都带相册增强字段',
  galleryItems.every((i) => Array.isArray(i.tags) && typeof i.favorite === 'boolean'),
  JSON.stringify(galleryItems[0]).slice(0, 160),
)

// ---- 排序 ----
const bySize = await callRoute('/api/qwen-image/gallery.json?sort=bytes&order=asc')
const sizeSeq = (bySize.json?.items ?? []).map((i) => i.bytes)
check(
  'sort=bytes&order=asc 单调不减',
  sizeSeq.every((v, i) => i === 0 || sizeSeq[i - 1] <= v),
  JSON.stringify(sizeSeq),
)
const bySteps = await callRoute('/api/qwen-image/gallery.json?sort=steps&order=desc')
const stepSeq = (bySteps.json?.items ?? []).map((i) => Number(i.steps) || 0)
check(
  'sort=steps&order=desc 单调不增',
  stepSeq.every((v, i) => i === 0 || stepSeq[i - 1] >= v),
  JSON.stringify(stepSeq),
)
const byId = await callRoute('/api/qwen-image/gallery.json?sort=id&order=asc')
check('sort=id 可用（字符串字段）', (byId.json?.items ?? []).length >= 2, JSON.stringify(byId.json?.applied).slice(0, 120))
const evilSort = await callRoute('/api/qwen-image/gallery.json?sort=__proto__&order=desc')
check('未知排序字段被白名单拒绝（回落到 createdAt）', evilSort.json?.applied?.sort === 'createdAt', JSON.stringify(evilSort.json?.applied).slice(0, 120))

// ---- 查询 ----
const target = galleryItems[0]
const needle = String(target?.prompt ?? '').slice(0, 5)
const hit = await callRoute(`/api/qwen-image/gallery.json?q=${encodeURIComponent(needle)}`)
check('按提示词片段查询命中', (hit.json?.items ?? []).some((i) => i.id === target.id), needle)
const miss = await callRoute('/api/qwen-image/gallery.json?q=zzz-no-such-thing')
check('查询无结果返回空列表而非报错', (miss.json?.count ?? -1) === 0, JSON.stringify(miss.json).slice(0, 120))
const bySeed = await callRoute(`/api/qwen-image/gallery.json?q=${target.seed}`)
check('可按 seed 查询（id/seed 也在检索域内）', (bySeed.json?.items ?? []).some((i) => i.id === target.id), String(target.seed))

// ---- 改：收藏 / 标签 / 提示词 ----
const upd = await callRoute('/api/qwen-image/update', {
  method: 'POST',
  body: { ids: [target.id], favorite: true, tagsAdd: ['冒烟', '柴犬'], prompt: 'smoke-updated prompt' },
})
check('/update 返回 200', upd.status === 200, `实际 ${upd.status}`)
check('/update 改到 1 条', (upd.json?.updated ?? []).length === 1, JSON.stringify(upd.json).slice(0, 160))
const updItem = upd.json?.items?.[0]
check('收藏已置位', updItem?.favorite === true, JSON.stringify(updItem?.favorite))
check(
  '标签已追加（去重保序）',
  Array.isArray(updItem?.tags) && updItem.tags.includes('冒烟') && updItem.tags.includes('柴犬'),
  JSON.stringify(updItem?.tags),
)
check(
  '提示词已改并标记 promptEdited',
  updItem?.prompt === 'smoke-updated prompt' && updItem?.promptEdited === true,
  String(updItem?.prompt),
)
const updQ = await callRoute(`/api/qwen-image/update?ids=${encodeURIComponent(target.id)}&favorite=0`, {
  method: 'POST',
})
check('/update 支持 query 传参（无 body，curl 友好）', updQ.json?.items?.[0]?.favorite === false, JSON.stringify(updQ.json).slice(0, 160))

// ---- 分类：facets 计数与筛选 ----
const facets = (await callRoute('/api/qwen-image/facets')).json
check(
  '/facets 给出 kinds/sizes/steps/days/tags',
  Array.isArray(facets?.kinds) && Array.isArray(facets?.sizes) && Array.isArray(facets?.days) && Array.isArray(facets?.steps),
  JSON.stringify(facets).slice(0, 180),
)
check('facets.total 与相册条数一致', (facets?.total ?? -1) === galleryItems.length, `${facets?.total} vs ${galleryItems.length}`)
check('facets.tags 收录新标签', (facets?.tags ?? []).some((t) => t.key === '冒烟'), JSON.stringify(facets?.tags))
const tagFiltered = await callRoute(`/api/qwen-image/gallery.json?tag=${encodeURIComponent('冒烟')}`)
check(
  '按标签筛选命中且唯一',
  (tagFiltered.json?.items ?? []).length === 1 && tagFiltered.json.items[0].id === target.id,
  JSON.stringify((tagFiltered.json?.items ?? []).map((i) => i.id)),
)
const tagMulti = await callRoute(`/api/qwen-image/gallery.json?tag=${encodeURIComponent('冒烟,柴犬')}`)
check('多标签按 AND 命中', (tagMulti.json?.items ?? []).length === 1, JSON.stringify(tagMulti.json?.count))
const sizeFiltered = await callRoute(`/api/qwen-image/gallery.json?size=${Math.max(target.width, target.height)}`)
check(
  '按尺寸（最长边）筛选命中',
  (sizeFiltered.json?.items ?? []).some((i) => i.id === target.id),
  `size=${Math.max(target.width, target.height)}`,
)
const kindFiltered = await callRoute(`/api/qwen-image/gallery.json?kind=${target.kind}`)
check('按类型（生图/改图）筛选命中', (kindFiltered.json?.items ?? []).some((i) => i.id === target.id), String(target.kind))
const future = await callRoute(`/api/qwen-image/gallery.json?from=${Date.now() + 86400_000}`)
check('时间范围（未来起点）筛掉全部', (future.json?.count ?? -1) === 0, JSON.stringify(future.json?.count))

// ---- 新字段必须落盘 ----
const man = JSON.parse(readFileSync(join(OUT_DIR, 'manifest.json'), 'utf8'))
const manItem = man.items.find((i) => i.id === target.id)
check(
  'manifest 持久化 tags / favorite / promptEdited',
  Array.isArray(manItem?.tags) && manItem.tags.includes('冒烟') && typeof manItem?.favorite === 'boolean' && manItem?.promptEdited === true,
  JSON.stringify(manItem?.tags),
)
const origFile = manItem?.file

// ---- 删：默认进回收站 ----
const del = await callRoute('/api/qwen-image/delete', { method: 'POST', body: { ids: [target.id] } })
check('/delete 返回 200 且删到 1 条', del.status === 200 && (del.json?.deleted ?? []).length === 1, JSON.stringify(del.json).slice(0, 160))
const afterDel = await callRoute('/api/qwen-image/gallery.json?limit=100')
check('删除后相册不再有该 id', !(afterDel.json?.items ?? []).some((i) => i.id === target.id))
check('原 PNG 已从原位置移走', origFile ? !existsSync(origFile) : false, String(origFile))
const trash = await callRoute('/api/qwen-image/trash.json')
check('回收站列出该条', (trash.json?.items ?? []).some((t) => t.id === target.id), JSON.stringify(trash.json).slice(0, 160))
check('回收站条目带 hasFile（说明文件真的被搬走了）', (trash.json?.items ?? []).find((t) => t.id === target.id)?.hasFile === true)
check('回收站索引 _trash/trash.json 已落盘', existsSync(join(OUT_DIR, '_trash', 'trash.json')))

// ---- 还原 ----
const rest = await callRoute('/api/qwen-image/restore', { method: 'POST', body: { ids: [target.id] } })
check('/restore 还原 1 条', (rest.json?.restored ?? []).length === 1, JSON.stringify(rest.json).slice(0, 160))
check('还原后原 PNG 回到原位', origFile ? existsSync(origFile) : false, String(origFile))
const afterRestore = await callRoute('/api/qwen-image/gallery.json?limit=100')
check('还原后重新出现在相册', (afterRestore.json?.items ?? []).some((i) => i.id === target.id))
check(
  '还原后标签仍在（记录没被重置）',
  (afterRestore.json?.items ?? []).find((i) => i.id === target.id)?.tags?.includes('冒烟') === true,
)

// ---- 彻底删除 ----
const del2 = await callRoute(`/api/qwen-image/delete?ids=${encodeURIComponent(target.id)}&purge=1`, { method: 'POST' })
check('purge 走真删路径', del2.json?.purged === true && (del2.json?.deleted ?? []).length === 1, JSON.stringify(del2.json).slice(0, 160))
check('purge 后文件真的没了', origFile ? !existsSync(origFile) : false, String(origFile))

// ---- 孤儿作品恢复（宿主侧在入库前出错留下的产物）----
console.log('\n# 产物目录扫描 / 孤儿恢复')
const orphanId = 'generate-99'
const orphanPng = join(OUT_DIR, `${orphanId}.png`)
const orphanSidecar = join(OUT_DIR, `${orphanId}.json`)
writeFileSync(orphanPng, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
writeFileSync(
  orphanSidecar,
  JSON.stringify({
    id: orphanId,
    file: orphanPng,
    width: 768,
    height: 768,
    mode: 'RGBA',
    hasAlpha: true,
    bytes: 8,
    seed: 42,
    steps: 12,
    elapsedSec: 100,
    device: 'cuda:0',
    dtype: 'fp16',
    createdAt: new Date().toISOString(),
    prompt: 'orphan artifact (never registered)',
    kind: 'generate',
  }),
  'utf8',
)
const beforeRecover = await callRoute('/api/qwen-image/gallery.json?limit=200')
check('恢复前相册看不到孤儿图', !(beforeRecover.json?.items ?? []).some((i) => i.id === orphanId))
const rec = await callRoute('/api/qwen-image/recover', { method: 'POST' })
check('/recover 返回 200', rec.status === 200, `实际 ${rec.status}`)
check('扫描到孤儿并补录', (rec.json?.added ?? []).includes(orphanId), JSON.stringify(rec.json).slice(0, 200))
const afterRecover = await callRoute('/api/qwen-image/gallery.json?limit=200')
const recItem = (afterRecover.json?.items ?? []).find((i) => i.id === orphanId)
check('恢复后出现在相册', !!recItem, JSON.stringify((afterRecover.json?.items ?? []).map((i) => i.id)))
check('补录记录带上 sidecar 里的元数据', recItem?.prompt === 'orphan artifact (never registered)' && recItem?.steps === 12)
const manAfter = JSON.parse(readFileSync(join(OUT_DIR, 'manifest.json'), 'utf8'))
check('补录结果落盘到 manifest', manAfter.items.some((i) => i.id === orphanId))
const recAgain = await callRoute('/api/qwen-image/recover', { method: 'POST' })
check('重复扫描不重复补录（幂等）', (recAgain.json?.added ?? []).length === 0, JSON.stringify(recAgain.json).slice(0, 200))
const cleanup = await callRoute(`/api/qwen-image/delete?ids=${orphanId}&purge=1`, { method: 'POST' })
check('清理孤儿（purge）成功', (cleanup.json?.deleted ?? []).includes(orphanId), JSON.stringify(cleanup.json).slice(0, 160))

// ---- background 登记失败必须降级，不能把已经入队的图丢了 ----
console.log('\n# background 登记失败 → 降级为前台等待（不丢图）')
// 复刻 dsh-jobs-local 的真实行为：owner 不被服务时 start() 直接抛错。
// 旧代码是「先 client.generate() 入队、后 jobs.start() 登记」，抛错时 GPU 已在跑、
// finalize 却永不执行 —— 实测因此留下过一张孤儿图（generate-4，樱花柴犬）。
const jobsStub = ctx.get('jobs')
const realJobsStart = jobsStub.start
jobsStub.start = () => {
  throw new Error(
    'background jobs unavailable: no job controller serves this agent (load @deepseek-ai/dsh-tool-jobs in its composition)',
  )
}
try {
  const bg = await genTool.execute(
    { prompt: 'background degrade probe', preset: 'draft', mode: 'background' },
    { signal: undefined },
  )
  check('登记失败时 background 调用不再抛错', !!bg, JSON.stringify(bg).slice(0, 200))
  check('降级后仍回传前台出图结果（带 ids）', Array.isArray(bg?.ids) && bg.ids.length === 1, JSON.stringify(bg?.ids))
  check('降级原因写进 note', String(bg?.note ?? '').includes('前台等待'), String(bg?.note))
  const afterBg = await callRoute('/api/qwen-image/gallery.json?limit=200')
  check(
    '降级路径也把图入库了（不再是孤儿）',
    (afterBg.json?.items ?? []).some((i) => i.id === bg?.ids?.[0]),
    JSON.stringify(bg?.ids),
  )
} catch (err) {
  check('登记失败时 background 调用不再抛错', false, err.message)
} finally {
  jobsStub.start = realJobsStart
}

// ---- 卸载清理 ----
console.log('\n# 卸载清理')
let disposed = 0
for (const d of effects) {
  if (typeof d === 'function') {
    try {
      d()
      disposed++
    } catch {
      /* ignore */
    }
  }
}
check(`已执行 ${disposed} 个 effect 清理器（worker 终止路径）`, disposed >= 1)

fakeWorker.close()
for (const t of timers) clearTimeout(t)

console.log(`\n=== 结果：${pass} 通过，${fail} 失败 ===\n`)
process.exit(fail > 0 ? 1 : 0)
