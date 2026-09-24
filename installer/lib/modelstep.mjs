/**
 * 权重步骤：先体检（可能已经有一份了）→ 需要才下载 → 下完再体检。
 *
 * 关键设计：
 * - **先找后下**：很多人机器上已经有这份权重（甚至已经指向了别的模型盘），
 *   安装器绝不覆盖、绝不重复下载 30.9GB。
 * - 体检用 worker/model_check.py（纯标准库），所以**任何 Python 都能跑**，
 *   连 venv 都还没建好时也能先判断。
 * - 下载交给 worker/fetch_model.py（huggingface_hub，断点续传），
 *   huggingface.co 官方 → hf-mirror → ModelScope 三级兜底。
 */

import { join } from 'node:path'
import { MODEL_SIZE_BYTES } from './detect.mjs'
import { humanBytes, isDir, isExecutablePath, isFile, run, runStream } from './util.mjs'

/**
 * 权重体检（用任意可用的 python；优先 venv）。
 * @returns {{state: string, missing: string[], raw: any|null}}
 */
export function checkModel(ctx, modelDir, python) {
  const exe = python || ctx.venvPython
  if (!exe || !isExecutablePath(exe)) return { state: 'unknown', missing: [], raw: null }
  const script = join(ctx.paths.workerDir, 'model_check.py')
  if (!isFile(script)) return { state: 'unknown', missing: [], raw: null }
  const r = run(exe, [script, '--model-dir', modelDir, '--json'], { timeoutMs: 300000 })
  const text = (r.stdout || '') + '\n' + (r.stderr || '')
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return { state: 'unknown', missing: [], raw: null }
  try {
    const parsed = JSON.parse(text.slice(start, end + 1))
    return { state: parsed.state || 'unknown', missing: parsed.missing || [], raw: parsed }
  } catch {
    return { state: 'unknown', missing: [], raw: null }
  }
}

/** 给用户可复制的手动下载命令（三条路径，与 image_status 的口径一致）。 */
export function manualCommands(modelDir, endpoint) {
  const dir = String(modelDir).replace(/\\/g, '/')
  const ep = endpoint || 'https://hf-mirror.com'
  return [
    "$env:HF_ENDPOINT='" + ep + "'; hf download Qwen/Qwen-Image-2.1 --local-dir '" + dir + "'",
    "python -c \"import os;os.environ['HF_ENDPOINT']='" + ep + "';from huggingface_hub import snapshot_download;snapshot_download('Qwen/Qwen-Image-2.1',local_dir=r'" + dir + "')\"",
    'modelscope download --model Qwen/Qwen-Image-2.1 --local_dir "' + dir + '"',
  ]
}

/**
 * 下载权重（多后端阶梯）。
 * @returns {Promise<{ok: boolean, action: string, backend?: string}>}
 */
async function downloadModel(ctx, modelDir, opts) {
  const ui = ctx.ui
  const fetchScript = join(ctx.paths.workerDir, 'fetch_model.py')
  const endpoints = []
  if (opts.endpoint !== undefined && opts.endpoint !== null) endpoints.push(opts.endpoint)
  else {
    if (ctx.plan.model.endpoint) endpoints.push(ctx.plan.model.endpoint)
    endpoints.push(null)
  }
  const tried = []
  for (const endpoint of endpoints) {
    const args = [fetchScript, '--local-dir', modelDir, '--repo', opts.repo || 'Qwen/Qwen-Image-2.1']
    if (endpoint) args.push('--endpoint', endpoint)
    const label = endpoint ? endpoint : 'huggingface.co（官方）'
    ui.info('从 ' + label + ' 下载（支持断点续传，中断后可重跑续传）…')
    const env = Object.assign({}, process.env)
    if (endpoint) env.HF_ENDPOINT = endpoint
    const r = await runStream(ctx.venvPython, args, { env: env, timeoutMs: 0, ui: ui })
    if (r.code === 0) return { ok: true, action: 'downloaded', backend: label }
    tried.push(label)
    ui.warn(label + ' 下载失败（退出码 ' + r.code + '）')
  }

  if (opts.mirror !== 'huggingface') {
    ui.info('改用 ModelScope 兜底…')
    const installRes = await runStream(ctx.venvPython, ['-m', 'pip', 'install', '--upgrade', 'modelscope'], { env: process.env, timeoutMs: 900000, ui: ui })
    if (installRes.code === 0) {
      const code = 'from modelscope import snapshot_download;snapshot_download(' + JSON.stringify(opts.repo || 'Qwen/Qwen-Image-2.1') + ', local_dir=r"' + String(modelDir).replace(/\\/g, '/') + '")'
      const r = await runStream(ctx.venvPython, ['-c', code], { env: process.env, timeoutMs: 0, ui: ui })
      if (r.code === 0) return { ok: true, action: 'downloaded', backend: 'ModelScope' }
    }
    tried.push('ModelScope')
  }
  ui.err('权重下载失败，已尝试：' + tried.join('、'))
  return { ok: false, action: 'failed' }
}

/**
 * 确保权重就位。
 * @param {{modelDir: string, noModel?: boolean, force?: boolean, repo?: string, endpoint?: string|null, mirror?: string}} opts
 */
export async function ensureModel(ctx, opts) {
  const o = opts || {}
  const ui = ctx.ui
  const modelDir = o.modelDir
  const state = checkModel(ctx, modelDir, ctx.venvPython || (ctx.interpreter && ctx.interpreter.path))

  if (state.state === 'ok' && !o.force) {
    ui.ok('权重已就位：' + modelDir + (state.raw && state.raw.totalBytes ? '（' + humanBytes(state.raw.totalBytes) + '）' : ''))
    return { ok: true, action: 'reused', state: state }
  }
  if (state.state === 'partial') {
    const missing = state.missing || []
    ui.warn('权重不完整：缺 ' + missing.length + ' 个文件' + (missing.length ? '（如 ' + missing.slice(0, 3).join('、') + '）' : ''))
  } else if (state.state === 'missing') {
    ui.info('权重目录还没有内容：' + modelDir)
  } else {
    ui.info('权重状态未知（体检脚本没给出结果），按「需要下载」处理')
  }

  if (o.noModel) {
    ui.warn('按你的要求跳过权重下载')
    ui.info('需要时随时可以补下（也可以在 GUI 里让我代办）：')
    for (const cmd of manualCommands(modelDir, ctx.plan.model.endpoint)) ui.cmd(cmd)
    return { ok: false, action: 'skipped', state: state }
  }

  const free = ctx.facts.disk && ctx.facts.disk.free
  if (free != null && free < MODEL_SIZE_BYTES * 1.05) {
    ui.err('磁盘空间不够下载权重：需要约 ' + humanBytes(MODEL_SIZE_BYTES) + '，当前可用 ' + humanBytes(free))
    ui.hint('换一个盘： --model-dir D:/models/Qwen-Image-2.1')
    return { ok: false, action: 'no-space', state: state }
  }

  const proceed = await ui.confirm('现在下载 Qwen-Image-2.1 权重吗？约 ' + humanBytes(MODEL_SIZE_BYTES) + '，视网速几十分钟到数小时（可随时中断，重跑会续传）', true)
  if (!proceed) {
    ui.info('跳过下载。之后可以在 GUI 里说「下载权重」，或手动执行：')
    for (const cmd of manualCommands(modelDir, ctx.plan.model.endpoint)) ui.cmd(cmd)
    return { ok: false, action: 'skipped', state: state }
  }

  const res = await downloadModel(ctx, modelDir, o)
  if (!res.ok) {
    ui.hint('可重跑同一条安装命令继续（已下载的分片会跳过）；或手动执行：')
    for (const cmd of manualCommands(modelDir, ctx.plan.model.endpoint)) ui.cmd(cmd)
    return { ok: false, action: 'failed', state: state }
  }

  const after = checkModel(ctx, modelDir, ctx.venvPython)
  if (after.state === 'ok') {
    ui.ok('权重下载完成并校验通过：' + modelDir + (after.raw && after.raw.totalBytes ? '（' + humanBytes(after.raw.totalBytes) + '）' : ''))
    return { ok: true, action: 'downloaded', state: after, backend: res.backend }
  }
  ui.warn('下载结束，但体检仍有缺件：' + (after.missing || []).slice(0, 5).join('、'))
  ui.hint('重跑安装器可续传补齐；若反复失败请把日志发给支持：' + (ui.logPath || '<安装日志>'))
  return { ok: false, action: 'incomplete', state: after }
}

export { isDir }
