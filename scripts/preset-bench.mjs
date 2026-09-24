/**
 * 预设耗时精确标定（经真实 worker 路径）。
 *
 * 修正 M0 首轮的测量误差：首轮把 tqdm 的**累计均值**当成了单步耗时，
 * 导致 512²/768² 的稳态步耗时被高估数倍。本脚本让 worker 用
 * callback_on_step_end 逐点计时，分别报告：
 *   - firstStepSec  首步（mmap 换入 + 权重上传，固定冷启动）
 *   - steadyStepSec 稳态步（后续步，与像素数近似线性）
 *   - vaeDecodeSec  末步之后的 VAE 解码 + 后处理（固定开销）
 * 并据此拟合 ETA 模型：total ≈ firstStep + steps × steady + vaeDecode
 *
 * 用法：node scripts/preset-bench.mjs [--only draft|standard|native] [--keep]
 */

import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const getArg = (n, d) => {
  const i = argv.indexOf(`--${n}`)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d
}
/** 缺省权重目录：$DSH_QWEN_MODEL_DIR > $DSH_HOME/models/... > ~/.dsh/models/...（不写死任何人的机器） */
const DEFAULT_MODEL_DIR = process.env.DSH_QWEN_MODEL_DIR || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'models', 'Qwen-Image-2.1')
const ONLY = getArg('only', '')
const MODEL_DIR = getArg('model', DEFAULT_MODEL_DIR)
const TOKEN = 'bench-' + Math.random().toString(16).slice(2)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 待测矩阵：native 用 3 步测稳态，再用模型外推 40 步（跑满 40 步约 67 分钟，不划算）
const MATRIX = [
  { name: 'draft', size: 768, steps: 12, label: '草稿 768²/12步' },
  { name: 'standard', size: 1024, steps: 24, label: '标准 1024²/24步' },
  { name: 'native-probe', size: 2048, steps: 3, label: '原生 2048²/3步（测稳态用）' },
].filter((m) => !ONLY || m.name === ONLY)

async function req(base, path, { method = 'GET', body, timeoutMs = 60000 } = {}) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
    })
    return { status: res.status, data: JSON.parse((await res.text()) || '{}') }
  } finally {
    clearTimeout(t)
  }
}

console.log('\n=== 预设耗时精确标定 ===\n')

const child = spawn('python', [
  join(ROOT, 'worker', 'server.py'),
  '--host', '127.0.0.1', '--port', '0',
  '--model-dir', MODEL_DIR,
  '--output-dir', join(ROOT, 'outputs', 'bench'),
  '--token', TOKEN,
  '--log-file', join(ROOT, 'outputs', 'bench-worker.log'),
], {
  cwd: ROOT,
  env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
})

let out = ''
child.stdout.on('data', (d) => { out += d.toString('utf8') })
child.stderr.on('data', (d) => { out += d.toString('utf8') })

let port
for (let i = 0; i < 120; i++) {
  const m = out.match(/^PORT=(\d+)/m)
  if (m) { port = Number(m[1]); break }
  await sleep(500)
}
if (!port) {
  console.error('worker 未报告端口\n', out.slice(-2000))
  child.kill()
  process.exit(1)
}
const base = `http://127.0.0.1:${port}`
console.log(`worker: ${base}`)

const results = []
try {
  const t0 = Date.now()
  const load = await req(base, '/load', {
    method: 'POST',
    body: { modelDir: MODEL_DIR, device: 'cuda:0', dtype: 'fp16', offload: 'model', vaeTiling: true },
    timeoutMs: 15 * 60 * 1000,
  })
  if (!load.data.loaded) throw new Error(`加载失败：${JSON.stringify(load.data)}`)
  console.log(`加载完成：${((Date.now() - t0) / 1000).toFixed(1)}s（worker 上报 ${load.data.loadSec}s）\n`)

  for (const m of MATRIX) {
    console.log(`--- ${m.label} ---`)
    const g = await req(base, '/generate', {
      method: 'POST',
      body: { prompt: 'a red apple on a wooden table, photorealistic', width: m.size, height: m.size, steps: m.steps, seed: 7, count: 1 },
    })
    const jobId = g.data.jobId
    let final
    for (let i = 0; i < 3600; i++) {
      const j = await req(base, `/job/${jobId}`)
      if (['completed', 'failed', 'cancelled'].includes(j.data.status)) { final = j.data; break }
      await sleep(2000)
    }
    if (final?.status !== 'completed') {
      console.log(`  失败：${final?.detail ?? '超时'}\n`)
      results.push({ ...m, ok: false, error: final?.detail ?? 'timeout' })
      continue
    }
    const r = final.result
    const row = {
      name: m.name, label: m.label, width: m.size, height: m.size, steps: m.steps, ok: true,
      totalSec: r.elapsedSec,
      firstStepSec: r.firstStepSec,
      steadyStepSec: r.steadyStepSec,
      vaeDecodeSec: r.vaeDecodeSec ?? null,
      peakVramMiB: r.peakVramMiB,
    }
    results.push(row)
    console.log(`  总 ${r.elapsedSec}s = 首步 ${r.firstStepSec}s + ${m.steps - 1}×${r.steadyStepSec}s + VAE ${r.vaeDecodeSec ?? '?'}s`)
    console.log(`  峰值显存 ${r.peakVramMiB}MiB\n`)
  }

  await req(base, '/unload', { method: 'POST', body: {}, timeoutMs: 120000 })

  // ---- 拟合 ETA 模型 ----
  console.log('=== 拟合结果 ===\n')
  const ok = results.filter((r) => r.ok)
  for (const r of ok) {
    const modeled = r.firstStepSec + (r.steps - 1) * r.steadyStepSec + (r.vaeDecodeSec ?? 0)
    const err = (((modeled - r.totalSec) / r.totalSec) * 100).toFixed(1)
    console.log(`${r.label}: 模型 ${modeled.toFixed(0)}s vs 实测 ${r.totalSec}s（误差 ${err}%）`)
  }

  // 按像素数拟合稳态步耗时（线性）
  if (ok.length >= 2) {
    const pts = ok.map((r) => ({ px: r.width * r.height, steady: r.steadyStepSec }))
    console.log('\n稳态步耗时 vs 像素数：')
    for (const p of pts) console.log(`  ${(p.px / 1e6).toFixed(2)} MP → ${p.steady}s/步`)
    // 最小二乘过原点：steady ≈ k × px
    const k = pts.reduce((s, p) => s + p.px * p.steady, 0) / pts.reduce((s, p) => s + p.px * p.px, 0)
    console.log(`  拟合斜率 k = ${(k * 1e6).toFixed(4)} s/MP（steady ≈ ${(k * 1e6).toFixed(3)} × MP）`)

    const std = ok.find((r) => r.name === 'standard')
    if (std) {
      console.log(`\n各档位推算（cold=${std.firstStepSec}s + steps×steady + vae=${std.vaeDecodeSec ?? '?'}s）：`)
      for (const [nm, px, steps] of [['draft', 768 * 768, 12], ['standard', 1024 * 1024, 24], ['native', 2048 * 2048, 40]]) {
        const steady = k * px
        const vae = std.vaeDecodeSec ?? 0
        const total = std.firstStepSec + (steps - 1) * steady + vae
        console.log(`  ${nm} (${steps} 步): steady=${steady.toFixed(2)}s → 总 ≈ ${(total / 60).toFixed(1)} 分钟`)
      }
    }
  }

  console.log('\n--- JSON ---')
  console.log(JSON.stringify({ results, fitted: ok.length >= 2 ? 'see above' : null }, null, 2))
} finally {
  if (!argv.includes('--keep')) {
    child.kill()
    await sleep(1500)
  } else {
    console.log(`\n--keep：worker 仍在 ${base}`)
  }
}
