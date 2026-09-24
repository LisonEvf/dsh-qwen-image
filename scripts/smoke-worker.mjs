/**
 * worker HTTP 协议端到端冒烟（M2 验收）。
 *
 * 不做假 worker —— 真启动 Python worker，走完 /load → /generate → /job → 落盘，
 * 验证宿主半将依赖的每个契约点：
 *   1. worker 启动并打印 PORT=<n>
 *   2. Bearer token 鉴权生效（错 token 应 401）
 *   3. /health /capabilities 结构正确
 *   4. /load 幂等且返回 loadSec
 *   5. /generate 返回 jobId（202）
 *   6. /job 轮询到 completed 并带回 images/sidecar
 *   7. 落盘的 PNG 真实存在且可解码（尺寸/模式/字节）
 *   8. 显存守卫与 /cancel 端点可达
 *
 * 运行：node scripts/smoke-worker.mjs [--size 512] [--steps 4] [--keep]
 * 退出码：0 全绿，1 有失败
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '..')

const argv = process.argv.slice(2)
const getArg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt
}
const SIZE = Number(getArg('size', '512'))
const STEPS = Number(getArg('steps', '4'))
const KEEP = argv.includes('--keep')
const TOKEN = 'smoke-token-' + Math.random().toString(16).slice(2)
/** 缺省权重目录：$DSH_QWEN_MODEL_DIR > $DSH_HOME/models/... > ~/.dsh/models/...（不写死任何人的机器） */
const DEFAULT_MODEL_DIR = process.env.DSH_QWEN_MODEL_DIR || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'models', 'Qwen-Image-2.1')
const MODEL_DIR = getArg('model', DEFAULT_MODEL_DIR)
const OUT_DIR = join(root, 'outputs', 'smoke')

let passed = 0
let failed = 0
const check = (name, ok, detail = '') => {
  if (ok) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    console.error(`  ✗ ${name}${detail ? `\n    ${detail}` : ''}`)
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function req(base, path, { method = 'GET', body, token = TOKEN, timeoutMs = 60000 } = {}) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
    })
    const text = await res.text()
    let data
    try {
      data = text ? JSON.parse(text) : {}
    } catch {
      data = { raw: text }
    }
    return { status: res.status, data }
  } finally {
    clearTimeout(t)
  }
}

console.log('\n=== M2 worker 协议端到端冒烟 ===\n')
console.log(`配置：model=${MODEL_DIR}`)
console.log(`      size=${SIZE} steps=${STEPS} out=${OUT_DIR}\n`)

// ---- 1. 启动 worker ----
console.log('# 启动 worker')
const child = spawn(
  'python',
  [
    join(root, 'worker', 'server.py'),
    '--host', '127.0.0.1',
    '--port', '0',
    '--model-dir', MODEL_DIR,
    '--output-dir', OUT_DIR,
    '--token', TOKEN,
    '--min-vram', '1024',
    '--log-file', join(root, 'outputs', 'smoke-worker.log'),
  ],
  {
    cwd: root,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
)

let stdout = ''
let stderr = ''
child.stdout.on('data', (d) => {
  stdout += d.toString('utf8')
  process.stdout.write(`  [worker] ${d.toString('utf8').trimEnd()}\n`)
})
child.stderr.on('data', (d) => {
  stderr += d.toString('utf8')
})

let exited = false
child.on('exit', (code) => {
  exited = true
  if (code !== 0 && code !== null) console.error(`  [worker] 退出码 ${code}`)
})

// 等待 PORT=
let port
for (let i = 0; i < 120; i++) {
  const m = stdout.match(/^PORT=(\d+)/m)
  if (m) {
    port = Number(m[1])
    break
  }
  if (exited) break
  await sleep(500)
}

check('worker 启动并报告端口', !!port, stderr.slice(-1500) || stdout.slice(-1500))
if (!port) {
  child.kill()
  console.log(`\n=== 结果：${passed} 通过，${failed} 失败 ===\n`)
  process.exit(1)
}
const base = `http://127.0.0.1:${port}`
console.log(`  → ${base}\n`)

try {
  // ---- 2. 鉴权 ----
  console.log('# 鉴权')
  const bad = await req(base, '/health', { token: 'wrong-token' })
  check('错误 token 被拒绝（401）', bad.status === 401, `实际 ${bad.status}`)
  const noTok = await req(base, '/health', { token: '' })
  check('缺失 token 被拒绝（401）', noTok.status === 401, `实际 ${noTok.status}`)

  // ---- 3. health / capabilities ----
  console.log('\n# health / capabilities')
  const h0 = await req(base, '/health')
  check('/health 返回 ok', h0.status === 200 && h0.data.ok === true, JSON.stringify(h0.data).slice(0, 300))
  check('/health 初始状态为 idle', h0.data.state === 'idle', `实际 ${h0.data.state}`)
  check('/health 带 vram 字段', typeof h0.data.vram === 'object', JSON.stringify(h0.data.vram))

  const caps = await req(base, '/capabilities')
  check('/capabilities 报告 diffusers 后端', caps.data.backend === 'diffusers')
  check('/capabilities 声明 maxRefs=10', caps.data.supports?.maxRefs === 10)
  check('/capabilities 诚实声明 mask=false（管道无独立 mask 参数）', caps.data.supports?.mask === false)
  console.log(`      diffusers=${caps.data.diffusersVersion} torch=${caps.data.torch} cuda=${caps.data.cuda}`)

  // ---- 4. 显存守卫（先制造一个不足场景：阈值设为极高）----
  console.log('\n# 显存守卫')
  const guard = await req(base, '/load', {
    method: 'POST',
    body: { modelDir: MODEL_DIR, device: 'cuda:0', dtype: 'fp16', offload: 'model', minFreeMiB: 999999 },
    timeoutMs: 120000,
  })
  check(
    '空闲显存低于阈值时拒绝加载并给出归因',
    guard.status === 500 && /低于阈值|显存/.test(guard.data.error ?? ''),
    JSON.stringify(guard.data).slice(0, 300),
  )

  // ---- 5. 正常加载 ----
  console.log('\n# /load（真实加载 30GB 权重，约 55–70s）')
  const t0 = Date.now()
  const load = await req(base, '/load', {
    method: 'POST',
    body: { modelDir: MODEL_DIR, device: 'cuda:0', dtype: 'fp16', offload: 'model', vaeTiling: true, minFreeMiB: 1024 },
    timeoutMs: 15 * 60 * 1000,
  })
  const loadSec = ((Date.now() - t0) / 1000).toFixed(1)
  check('/load 成功', load.status === 200 && load.data.loaded === true, JSON.stringify(load.data).slice(0, 300))
  check('/load 返回 loadSec', typeof load.data.loadSec === 'number', `实际 ${JSON.stringify(load.data)}`)
  console.log(`      实测加载 ${loadSec}s（worker 上报 ${load.data.loadSec}s）`)

  const h1 = await req(base, '/health')
  check('加载后状态为 ready', h1.data.state === 'ready', `实际 ${h1.data.state}`)
  check('加载后 dtype 解析为 fp16（P40 实测最优）', h1.data.dtype === 'fp16', `实际 ${h1.data.dtype}`)
  check('加载后 offload 解析为 model', h1.data.offload === 'model', `实际 ${h1.data.offload}`)

  // 幂等
  const load2 = await req(base, '/load', {
    method: 'POST',
    body: { modelDir: MODEL_DIR, device: 'cuda:0', dtype: 'fp16', offload: 'model' },
    timeoutMs: 60000,
  })
  check('/load 幂等（二次调用不重载）', load2.data.alreadyLoaded === true, JSON.stringify(load2.data).slice(0, 200))

  // ---- 6. 生成 ----
  console.log(`\n# /generate（${SIZE}², ${STEPS} 步 —— 真推理）`)
  const gen = await req(base, '/generate', {
    method: 'POST',
    body: { prompt: 'a red apple on a wooden table, photorealistic', width: SIZE, height: SIZE, steps: STEPS, seed: 42, count: 1 },
    timeoutMs: 60000,
  })
  check('/generate 返回 202 与 jobId', gen.status === 202 && !!gen.data.jobId, JSON.stringify(gen.data))
  const jobId = gen.data.jobId

  const j0 = await req(base, `/job/${jobId}`)
  check('/job 可查询', j0.status === 200 && j0.data.id === jobId)
  console.log(`      jobId=${jobId} status=${j0.data.status}`)

  // 轮询
  let final
  const tGen = Date.now()
  for (let i = 0; i < 900; i++) {
    const j = await req(base, `/job/${jobId}`)
    if (j.data.status === 'completed' || j.data.status === 'failed' || j.data.status === 'cancelled') {
      final = j.data
      break
    }
    if (j.data.progress && i % 6 === 0) {
      const p = j.data.progress
      process.stdout.write(`\r      进度 ${p.step}/${p.total}  已用 ${(p.elapsedMs / 1000).toFixed(0)}s${p.etaMs ? `  预计剩余 ${(p.etaMs / 1000).toFixed(0)}s` : ''}   `)
    }
    await sleep(1000)
  }
  process.stdout.write('\n')

  check('任务在超时内完成', final?.status === 'completed', final ? JSON.stringify(final).slice(0, 400) : '轮询超时')
  if (final?.status === 'completed') {
    const r = final.result
    console.log(
      `      实测总耗时 ${r.elapsedSec}s｜首步 ${r.firstStepSec}s｜稳态 ${r.steadyStepSec}s/步` +
        `｜VAE 解码 ${r.vaeDecodeSec ?? '未上报 ⚠️'}s｜峰值显存 ${r.peakVramMiB}MiB`,
    )
    check('结果带 images 数组', Array.isArray(r.images) && r.images.length === 1, JSON.stringify(r.images).slice(0, 300))
    check('结果带 seed/steps/steadyStepSec', typeof r.seed === 'number' && r.steps === STEPS && typeof r.steadyStepSec === 'number')
    check(
      '结果带 vaeDecodeSec（ETA 模型的关键分量）',
      typeof r.vaeDecodeSec === 'number' && r.vaeDecodeSec >= 0,
      `实际 ${JSON.stringify(r.vaeDecodeSec)}`,
    )
    // 三段之和应接近总耗时（允许 VAE 后处理与计时的少量误差）
    const modeled = r.firstStepSec + (STEPS - 1) * r.steadyStepSec + r.vaeDecodeSec
    const errPct = Math.abs(modeled - r.elapsedSec) / r.elapsedSec
    check(
      `三段式模型与实测吻合（误差 ${(errPct * 100).toFixed(1)}%）`,
      errPct < 0.15,
      `模型 ${modeled.toFixed(1)}s vs 实测 ${r.elapsedSec}s`,
    )
    check('设备报告为 cuda:0 / fp16', r.device === 'cuda:0' && r.dtype === 'fp16', `${r.device}/${r.dtype}`)

    const img = r.images[0]
    check('PNG 已落盘', existsSync(img.file), img.file)
    check('sidecar JSON 已落盘', existsSync(img.sidecar), img.sidecar)
    if (existsSync(img.file)) {
      const bytes = statSync(img.file).size
      const head = readFileSync(img.file).subarray(0, 8)
      const isPng = head[0] === 0x89 && head.subarray(1, 4).toString() === 'PNG'
      check('落盘文件是合法 PNG（magic 校验）', isPng, `magic=${head.toString('hex')}`)
      check('PNG 字节数与上报一致', bytes === img.bytes, `磁盘 ${bytes} vs 上报 ${img.bytes}`)
      console.log(`      输出 ${img.file}  ${img.width}x${img.height}  ${bytes} bytes  hasAlpha=${img.hasAlpha}`)
    }
    if (existsSync(img.sidecar)) {
      const sidecar = JSON.parse(readFileSync(img.sidecar, 'utf8'))
      check('sidecar 含 prompt/seed/steps/耗时/峰值显存', 
        !!sidecar.prompt && typeof sidecar.seed === 'number' && typeof sidecar.steps === 'number' &&
        typeof sidecar.elapsedSec === 'number' && typeof sidecar.peakVramMiB === 'number',
        JSON.stringify(sidecar).slice(0, 400))
    }
  }

  // ---- 7. 日志端点 ----
  console.log('\n# /logs')
  const logs = await req(base, '/logs?count=10')
  check('/logs 返回日志行', Array.isArray(logs.data.lines) && logs.data.lines.length > 0)

  // ---- 8. cancel 端点可达 ----
  console.log('\n# /cancel')
  const cancel = await req(base, '/cancel/nonexistent-job', { method: 'POST', body: {} })
  check('/cancel 对未知 job 返回 cancelled=false（不崩）', cancel.status === 200 && cancel.data.cancelled === false, JSON.stringify(cancel.data))

  // ---- 9. unload 释放显存 ----
  console.log('\n# /unload')
  const unload = await req(base, '/unload', { method: 'POST', body: {}, timeoutMs: 120000 })
  check('/unload 成功', unload.status === 200 && unload.data.unloaded === true, JSON.stringify(unload.data).slice(0, 300))

  const h2 = await req(base, '/health')
  check(
    '卸载后状态回到 idle',
    h2.status === 200 && h2.data.state === 'idle',
    `HTTP ${h2.status}，body=${JSON.stringify(h2.data).slice(0, 400)}`,
  )
  if (h2.data.vram?.free != null) console.log(`      卸载后空闲显存 ${h2.data.vram.free} MiB`)

  // 再查一次，区分「瞬时异常」与「持续故障」
  await sleep(1200)
  const h3 = await req(base, '/health')
  check(
    '健康检查可持续访问（非瞬时异常）',
    h3.status === 200 && h3.data.ok === true,
    `HTTP ${h3.status}，body=${JSON.stringify(h3.data).slice(0, 400)}`,
  )
} finally {
  if (!KEEP) {
    console.log('\n# 停止 worker')
    child.kill()
    for (let i = 0; i < 20 && !exited; i++) await sleep(500)
    check('worker 已退出（无僵尸进程）', exited)
  } else {
    console.log(`\n# --keep 已指定，worker 仍在运行：${base}`)
  }
}

console.log(`\n=== 结果：${passed} 通过，${failed} 失败 ===\n`)
process.exit(failed > 0 ? 1 : 0)
