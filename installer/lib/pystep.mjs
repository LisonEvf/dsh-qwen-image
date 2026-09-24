/**
 * Python 环境步骤：解释器获取 → venv → 依赖安装 → 核验。
 *
 * 这里是「普通用户一键装」的核心，也是「不同设备」差异最大的地方：
 *   - 用户机器上可能**完全没有 Python** → 用 uv 托管一个 3.12（ComfyUI 便携版同思路）
 *   - 用户可能已经装了能跑的环境（系统 Python / ComfyUI 便携版 / conda）
 *     → 直接**借它的 site-packages**（省 3GB 的 torch 下载），而不是重装一遍
 *   - N 卡驱动版本千差万别 → 按驱动选 cu128 / cu126 / cu124 / cu121 / cu118 / CPU
 *   - 国内网络 → pip 镜像与 PyTorch 轮子镜像自动测速切换
 * 每一步都**幂等**：重跑只补缺的，已经好的不动。
 */

import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { IS_WIN, download, ensureDir, extractArchive, findFile, isDir, isExecutablePath, isFile, readJsonSafe, run, runStream, which, writeFileSafe } from './util.mjs'
import { TORCH_INDEXES } from './plan.mjs'

/** 已被实测验证含 QwenImage21Pipeline 的 diffusers commit（PR #14804 之后）。 */
export const DIFFUSERS_COMMIT = '9f1246971270c84dcbe71233edb7a519596a5d02'

/** PyTorch 轮子的国内镜像（HTML flat 列表，用 --find-links 喂给 pip/uv）。 */
export const TORCH_MIRRORS = {
  cu128: 'https://mirrors.aliyun.com/pytorch-wheels/cu128/',
  cu126: 'https://mirrors.aliyun.com/pytorch-wheels/cu126/',
  cu124: 'https://mirrors.aliyun.com/pytorch-wheels/cu124/',
  cu121: 'https://mirrors.aliyun.com/pytorch-wheels/cu121/',
  cu118: 'https://mirrors.aliyun.com/pytorch-wheels/cu118/',
  cpu: 'https://mirrors.aliyun.com/pytorch-wheels/cpu/',
}

/** 插件私有目录（与 dsh 的其它数据分开，卸载时删一个目录就干净了）。 */
export function pluginHome(home) {
  return join(home, 'dsh-qwen-image')
}

/** venv 里的 python 路径。 */
export function venvPython(venvDir) {
  return IS_WIN ? join(venvDir, 'Scripts', 'python.exe') : join(venvDir, 'bin', 'python')
}

/** 插件默认读取的 venv 位置（必须与 src/host/worker-manager.ts 的探测顺序一致）。 */
export function defaultVenvDir(home) {
  return join(pluginHome(home), 'venv')
}

/** 解析安装器用到的全部路径。 */
export function resolvePaths(home, pluginRoot) {
  const ph = pluginHome(home)
  return {
    pluginHome: ph,
    pluginRoot: pluginRoot,
    runtimeDir: join(ph, 'runtime'),
    venvDir: defaultVenvDir(home),
    logDir: join(ph, 'logs'),
    statePath: join(ph, 'install-state.json'),
    workerDir: join(pluginRoot, 'worker'),
  }
}

/** 读安装状态（doctor/修复时用来知道上次装了什么）。 */
export function readState(paths) {
  return readJsonSafe(paths.statePath, {})
}

/** 写安装状态。 */
export function writeState(paths, patch) {
  const next = Object.assign({}, readState(paths), patch, { updatedAt: new Date().toISOString() })
  try {
    writeFileSafe(paths.statePath, JSON.stringify(next, null, 2) + '\n')
  } catch {
    /* 状态写不进去不是致命问题 */
  }
  return next
}

// ────────────────────────────────────────────────────────────────────────────
// uv：没有 Python 的机器靠它把 Python 带进来
// ────────────────────────────────────────────────────────────────────────────

/** uv 官方发布的资产名（按平台/架构）。 */
export function uvAssetName(platform, arch) {
  const a = String(arch || '')
  const isArm = a === 'arm64' || a === 'aarch64'
  if (platform === 'win32') return isArm ? 'uv-aarch64-pc-windows-msvc.zip' : 'uv-x86_64-pc-windows-msvc.zip'
  if (platform === 'darwin') return isArm ? 'uv-aarch64-apple-darwin.tar.gz' : 'uv-x86_64-apple-darwin.tar.gz'
  return isArm ? 'uv-aarch64-unknown-linux-gnu.tar.gz' : 'uv-x86_64-unknown-linux-gnu.tar.gz'
}

/** uv 下载地址阶梯：用户自定义 → 官方 → 常见国内代理。 */
export function uvDownloadUrls(platform, arch, opts) {
  const o = opts || {}
  const asset = uvAssetName(platform, arch)
  const urls = []
  if (o.uvUrl) urls.push(o.uvUrl)
  if (process.env.DSH_QWEN_UV_MIRROR) urls.push(process.env.DSH_QWEN_UV_MIRROR.replace(/\/+$/, '') + '/' + asset)
  urls.push('https://github.com/astral-sh/uv/releases/latest/download/' + asset)
  urls.push('https://ghfast.top/https://github.com/astral-sh/uv/releases/latest/download/' + asset)
  urls.push('https://gh-proxy.com/https://github.com/astral-sh/uv/releases/latest/download/' + asset)
  return urls
}

/**
 * 取得一个可用的 uv 可执行文件。
 * @returns {Promise<{path: string, source: string}|null>}
 */
export async function resolveUv(ctx, opts) {
  const o = opts || {}
  const paths = ctx.paths
  if (o.noUv) return null

  const onPath = which('uv')
  if (onPath) {
    const v = run(onPath, ['--version'], { timeoutMs: 30000 })
    if (v.ok) return { path: onPath, source: 'PATH' }
  }

  const localBin = IS_WIN ? join(paths.runtimeDir, 'uv.exe') : join(paths.runtimeDir, 'uv')
  if (isExecutablePath(localBin)) {
    const v = run(localBin, ['--version'], { timeoutMs: 30000 })
    if (v.ok) return { path: localBin, source: 'runtime' }
  }

  if (o.download === false) return null
  const ui = ctx.ui
  ui.info('没有现成的 uv，正在下载（约 35MB，用于托管 Python 解释器）…')
  const urls = uvDownloadUrls(process.platform, process.arch, o)
  const tmp = ensureDir(join(paths.runtimeDir, 'tmp'))
  for (const url of urls) {
    ui.detail('尝试：' + url)
    const isZip = /\.zip(\?|$)/.test(url)
    const archive = join(tmp, isZip ? 'uv.zip' : 'uv.tar.gz')
    const got = await download(url, archive, { timeoutMs: 180000, log: (t) => ui.detail(t) })
    if (!got.ok) {
      ui.detail('失败：' + got.error)
      continue
    }
    const dest = ensureDir(join(paths.runtimeDir, 'uv-dist'))
    const ex = extractArchive(archive, dest)
    if (!ex.ok) {
      ui.detail('解压失败：' + ex.error)
      continue
    }
    const found = findFile(dest, (full, name) => (IS_WIN ? name === 'uv.exe' : name === 'uv'))
    if (!found) {
      ui.detail('解压后没找到 uv 可执行文件')
      continue
    }
    try {
      ensureDir(dirname(localBin))
      if (IS_WIN) {
        // uv.exe 旁边还有 uvx.exe 等；整个目录一起搬，避免缺件
        const srcDir = dirname(found)
        for (const f of readdirSync(srcDir)) {
          const from = join(srcDir, f)
          const to = join(paths.runtimeDir, f)
          if (isFile(from)) writeFileSync(to, readFileSync(from))
        }
      } else {
        writeFileSync(localBin, readFileSync(found), { mode: 0o755 })
      }
    } catch (err) {
      ui.detail('安装 uv 失败：' + String(err && err.message))
      continue
    }
    const v = run(localBin, ['--version'], { timeoutMs: 30000 })
    if (v.ok) {
      ui.ok('uv 已就位：' + (v.stdout || '').trim())
      return { path: localBin, source: 'downloaded' }
    }
  }
  ui.warn('uv 没能自动获取（网络受限？）。若本机已有 Python 3.10-3.13，可用 --python <路径> 指定后重试。')
  return null
}

// ────────────────────────────────────────────────────────────────────────────
// 解释器
// ────────────────────────────────────────────────────────────────────────────

/** 轻量探测一个解释器（不导入 torch）。 */
export function quickProbe(exe) {
  const script = 'import json,sys;print("<<<P>>>"+json.dumps({"executable":sys.executable,"version":"%d.%d.%d"%sys.version_info[:3],"isVenv":sys.prefix!=getattr(sys,"base_prefix",sys.prefix)}))'
  const r = run(exe, ['-c', script], { timeoutMs: 60000 })
  if (!r.ok || !r.stdout) return null
  const marker = r.stdout.lastIndexOf('<<<P>>>')
  if (marker < 0) return null
  try {
    return JSON.parse(r.stdout.slice(marker + 7).trim())
  } catch {
    return null
  }
}

/**
 * 确保有一个可用的解释器。
 * @returns {Promise<{path: string, version: string, minor: number, source: string}|null>}
 */
export async function ensureInterpreter(ctx, opts) {
  const o = opts || {}
  const plan = ctx.plan
  const ui = ctx.ui

  // 1) 计划里已经选好了本机解释器
  if (plan.python.interpreter && plan.python.strategy !== 'uv' && plan.python.strategy !== 'uv-needed') {
    const info = quickProbe(plan.python.interpreter)
    if (info) {
      ui.ok('使用 Python ' + info.version + '（' + plan.python.interpreter + '）')
      return { path: info.executable, version: info.version, minor: Number(info.version.split('.')[1]), source: plan.python.donorSource || 'local' }
    }
    ui.warn('计划里的解释器不可用（' + plan.python.interpreter + '），改为找 uv 托管')
  }

  // 2) uv 托管 Python 3.12
  const uv = ctx.uv || (await resolveUv(ctx, o))
  if (!uv) return null
  ctx.uv = uv
  const pyDir = join(ctx.paths.runtimeDir, 'python')
  const env = Object.assign({}, process.env, { UV_PYTHON_INSTALL_DIR: pyDir, UV_NO_PROGRESS: '1' })
  if (o.pythonMirror || process.env.DSH_QWEN_PYTHON_MIRROR) {
    env.UV_PYTHON_INSTALL_MIRROR = o.pythonMirror || process.env.DSH_QWEN_PYTHON_MIRROR
  }
  const ver = o.pythonVersion || '3.12'
  const list = run(uv.path, ['python', 'list', '--only-installed'], { env: env, timeoutMs: 60000 })
  const already = list.ok && new RegExp('cpython-' + ver.replace('.', '\\.') + '\\.').test(list.stdout)
  if (!already) {
    ui.info('用 uv 下载并托管 Python ' + ver + '（约 30MB → ' + pyDir + '）…')
    const r = await runStream(uv.path, ['python', 'install', ver], { env: env, timeoutMs: 900000, ui: ui })
    if (r.code !== 0) {
      ui.err('uv 安装 Python 失败，退出码 ' + r.code)
      ui.hint('可手动安装 Python 3.12 后重跑：https://www.python.org/downloads/（国内镜像 https://mirrors.huaweicloud.com/python/）')
      return null
    }
  }
  const found = run(uv.path, ['python', 'find', ver], { env: env, timeoutMs: 60000 })
  const lines = (found.stdout || '').trim().split(/\r?\n/)
  const exe = lines[lines.length - 1]
  if (!found.ok || !exe || !isFile(exe)) {
    ui.err('uv 装好了 Python 但找不到它的路径')
    return null
  }
  const info = quickProbe(exe)
  if (!info) {
    ui.err('uv 托管的 Python 无法执行：' + exe)
    return null
  }
  ui.ok('uv 托管 Python ' + info.version + '（' + exe + '）')
  return { path: exe, version: info.version, minor: Number(info.version.split('.')[1]), source: 'uv' }
}

// ────────────────────────────────────────────────────────────────────────────
// venv
// ────────────────────────────────────────────────────────────────────────────

/**
 * 创建/复用 venv。
 * @param {{interpreter: string, donorSitePackages?: string|null, force?: boolean}} opts
 */
export async function ensureVenv(ctx, opts) {
  const o = opts || {}
  const ui = ctx.ui
  const dir = ctx.paths.venvDir
  const py = venvPython(dir)

  if (isExecutablePath(py) && !o.force) {
    const info = quickProbe(py)
    if (info) {
      ui.ok('复用已有 venv：' + dir)
      attachDonorSitePackages(ctx, py, o.donorSitePackages)
      return { dir: dir, python: py, created: false, version: info.version }
    }
    ui.warn('已有 venv 但不可用，重建：' + dir)
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }

  ui.info('创建独立 venv：' + dir)
  const viaUv = ctx.uv && !o.noUv
  let r
  if (viaUv) {
    r = run(ctx.uv.path, ['venv', '--python', o.interpreter, '--allow-existing', dir], { timeoutMs: 300000 })
  } else {
    r = run(o.interpreter, ['-m', 'venv', dir], { timeoutMs: 300000 })
  }
  if (!r.ok || !isFile(py)) {
    if (viaUv) {
      ui.detail('uv venv 失败（' + String(r.stderr || '').slice(0, 200) + '），改用 python -m venv')
      r = run(o.interpreter, ['-m', 'venv', dir], { timeoutMs: 300000 })
    }
  }
  if (!isFile(py)) {
    ui.err('venv 创建失败：' + String((r && (r.stderr || r.stdout)) || '').slice(0, 400))
    ui.hint('常见原因：系统 Python 缺 venv 组件（Debian/Ubuntu：sudo apt install python3-venv）')
    return null
  }
  const info = quickProbe(py)
  ui.ok('venv 就绪（Python ' + ((info && info.version) || '?') + '）')
  attachDonorSitePackages(ctx, py, o.donorSitePackages)
  return { dir: dir, python: py, created: true, version: (info && info.version) || null }
}

/**
 * 把「借来的」site-packages 挂进 venv（一个 .pth 文件即可）。
 *
 * 为什么需要它：ComfyUI 便携版 / conda / 微软商店版 Python 的包目录都不在
 * venv 的 base_prefix 里，标准库的 --system-site-packages 未必看得见。
 * 直接写 .pth 是唯一在所有形态下都成立的复用方式，而且**可逆**（删文件即可）。
 */
export function attachDonorSitePackages(ctx, venvPy, donorSitePackages) {
  if (!donorSitePackages || !isDir(donorSitePackages)) return null
  const ui = ctx.ui
  const siteResult = run(venvPy, ['-c', 'import site,json;print(json.dumps(site.getsitepackages()))'], { timeoutMs: 60000 })
  const lastLine = (siteResult.stdout || '').trim().split(/\r?\n/).pop()
  let target = null
  try {
    const list = JSON.parse(lastLine)
    target = list && list[0]
  } catch {
    target = null
  }
  if (!target) {
    ui.warn('拿不到 venv 的 site-packages 路径，跳过复用')
    return null
  }
  ensureDir(target)
  const pth = join(target, '_dsh_qwen_image_reuse.pth')
  try {
    writeFileSync(pth, donorSitePackages + '\n')
  } catch (err) {
    ui.warn('写入复用路径失败：' + String(err && err.message))
    return null
  }
  ui.ok('已挂载复用目录：' + donorSitePackages)
  return pth
}

/** 检查 venv 里能不能 import 某个模块（extra 用于附带断言）。 */
export function canImport(python, module, extra) {
  const code = extra ? 'import ' + module + ';' + extra : 'import ' + module
  const r = run(python, ['-c', code], { timeoutMs: 300000 })
  return r.ok
}

/** 用 venv 的 python 跑 worker/env_report.py，拿结构化环境报告。 */
export function envReport(paths, python, modelDir, opts) {
  const o = opts || {}
  const args = [join(paths.workerDir, 'env_report.py'), '--json']
  if (o.quick) args.push('--quick')
  if (modelDir) args.push('--model-dir', modelDir)
  const r = run(python, args, { timeoutMs: o.timeoutMs || 300000 })
  const text = (r.stdout || '') + '\n' + (r.stderr || '')
  const marker = text.lastIndexOf('<<<ENVREPORT>>>')
  if (marker < 0) return { ok: false, raw: text.slice(-1500), report: null }
  const line = text.slice(marker + 15).trim().split(/\r?\n/)[0]
  try {
    return { ok: true, report: JSON.parse(line) }
  } catch (err) {
    return { ok: false, raw: text.slice(-1500), report: null }
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 依赖安装
// ────────────────────────────────────────────────────────────────────────────

/** 选出最快的可用 PyPI 镜像（按实测延迟排序，国内用户自动走清华/阿里）。 */
export function pickPipMirror(facts, opts) {
  const o = opts || {}
  if (o.pipIndex) return { url: o.pipIndex, name: '用户指定' }
  const net = facts.net || {}
  const candidates = [
    { name: 'PyPI 官方', url: null, ms: net.pypi && net.pypi.ok ? net.pypi.ms : Infinity },
    { name: '清华 TUNA', url: 'https://pypi.tuna.tsinghua.edu.cn/simple', ms: net.tuna && net.tuna.ok ? net.tuna.ms : Infinity },
  ].filter((c) => Number.isFinite(c.ms))
  if (!candidates.length) return { url: null, name: 'PyPI 官方（未测速）' }
  candidates.sort((a, b) => a.ms - b.ms)
  return candidates[0]
}

/** 构造 pip / uv pip 的基础命令。 */
export function pipBase(ctx, venvPy) {
  if (ctx.uv) return { cmd: ctx.uv.path, base: ['pip', 'install', '--python', venvPy] }
  return { cmd: venvPy, base: ['-m', 'pip', 'install'] }
}

/** 把镜像/端点等环境变量备好。 */
function pipEnv(ctx, mirror) {
  const env = Object.assign({}, process.env, {
    PIP_DISABLE_PIP_VERSION_CHECK: '1',
    PIP_NO_INPUT: '1',
  })
  if (mirror && mirror.url) env.PIP_INDEX_URL = mirror.url
  if (ctx.plan && ctx.plan.model && ctx.plan.model.endpoint) env.HF_ENDPOINT = ctx.plan.model.endpoint
  return env
}

/** 执行一次安装（流式输出 + 长超时）。 */
async function runInstall(ctx, args, env, label) {
  const ui = ctx.ui
  ui.info(label)
  const base = pipBase(ctx, ctx.venvPython)
  const r = await runStream(base.cmd, base.base.concat(args), { env: env, timeoutMs: 5400000, ui: ui })
  return r.code === 0
}

/**
 * 安装全部依赖（含 PyTorch 索引阶梯与 diffusers 源阶梯）。
 * @returns {Promise<{ok: boolean, torch: string|null, diffusers: string|null, failures: string[]}>}
 */
export async function installDeps(ctx, opts) {
  const o = opts || {}
  const ui = ctx.ui
  const plan = ctx.plan
  const failures = []
  const venvPy = ctx.venvPython
  const mirror = pickPipMirror(ctx.facts, o)
  ui.detail('PyPI 源：' + mirror.name + (mirror.url ? '（' + mirror.url + '）' : ''))
  writeState(ctx.paths, { pipMirror: mirror.name })

  const require = (module, extra) => canImport(venvPy, module, extra)
  const needTorch = !o.skipTorch && !require('torch')

  if (needTorch) {
    const version = plan.torch.version
    const key = plan.torch.key
    const indexUrl = TORCH_INDEXES[key] ? TORCH_INDEXES[key].url : null
    const attemptList = []
    if (indexUrl) {
      attemptList.push({
        label: 'PyTorch 官方源（' + plan.torch.label + '）',
        args: ['torch==' + version, '--index-url', indexUrl].concat(mirror.url ? ['--extra-index-url', mirror.url] : []),
      })
    }
    if (TORCH_MIRRORS[key]) {
      attemptList.push({
        label: '国内轮子镜像（阿里云 ' + key + '）',
        args: ['torch==' + version, '--find-links', TORCH_MIRRORS[key]].concat(mirror.url ? ['--index-url', mirror.url] : []),
      })
    }
    if (key !== 'cpu') attemptList.push({ label: '降级为 CPU 版 torch', args: ['torch==' + version, '--index-url', TORCH_INDEXES.cpu.url] })
    attemptList.push({ label: 'PyPI 默认（Windows 上是 CPU 版）', args: ['torch==' + version].concat(mirror.url ? ['--index-url', mirror.url] : []) })

    let torchOk = false
    for (const attempt of attemptList) {
      const args = ['--upgrade'].concat(attempt.args)
      const ok = await runInstall(ctx, args, pipEnv(ctx, mirror), '安装 torch（' + attempt.label + '）…')
      if (ok && require('torch')) {
        torchOk = true
        const cuda = run(venvPy, ['-c', 'import torch;print(torch.version.cuda or "cpu")'], { timeoutMs: 300000 })
        const tag = (cuda.stdout || '').trim().split(/\r?\n/).pop() || '?'
        ui.ok('torch ' + version + ' 装好了（cuda=' + tag + '）')
        writeState(ctx.paths, { torch: version, torchIndex: attempt.label, torchCudaTag: tag })
        break
      }
      failures.push('torch（' + attempt.label + '）')
      ui.warn('这一路没成功，换下一路…')
    }
    if (!torchOk) {
      ui.err('PyTorch 安装失败：所有源都试过了')
      ui.hint('可手动下载轮子后重跑：pip install <轮子路径>；轮子列表 https://download.pytorch.org/whl/' + key + '/')
      return { ok: false, torch: null, diffusers: null, failures: failures }
    }
  } else {
    ui.ok('已检测到可用的 torch，跳过')
  }

  // —— 其余纯 Python 依赖 ——
  const plain = ['transformers>=5.17', 'accelerate', 'pillow', 'numpy', 'safetensors', 'huggingface_hub']
  const missing = plain.filter((spec) => {
    const mod = spec.split(/[><=]/)[0]
    return !require(mod === 'pillow' ? 'PIL' : mod)
  })
  if (missing.length) {
    const ok = await runInstall(ctx, ['--upgrade'].concat(missing), pipEnv(ctx, mirror), '安装 ' + missing.join('、') + ' …')
    if (!ok) {
      failures.push('基础依赖')
      ui.warn('基础依赖安装报错，稍后的核验会告诉你具体缺什么')
    }
  } else {
    ui.ok('transformers / accelerate / pillow / numpy / safetensors 已齐')
  }

  // —— diffusers（阶梯：git → 源码包 → PyPI） ——
  const hasQwen21 = () => require('diffusers', 'from diffusers import QwenImage21Pipeline')
  let diffusersOk = hasQwen21()
  if (!diffusersOk && !o.skipDiffusers) {
    const commit = o.diffusersCommit || DIFFUSERS_COMMIT
    const sources = []
    if (which('git') && o.diffusers !== 'tarball' && o.diffusers !== 'pypi') {
      sources.push({ label: 'GitHub git（commit ' + commit.slice(0, 8) + '）', spec: 'git+https://github.com/huggingface/diffusers.git@' + commit })
    }
    if (o.diffusers !== 'pypi') {
      sources.push({ label: 'GitHub 源码包（不需要 git）', spec: 'https://github.com/huggingface/diffusers/archive/' + commit + '.tar.gz' })
    }
    sources.push({ label: 'PyPI 最新发布版', spec: 'diffusers' })
    for (const src of sources) {
      const ok = await runInstall(ctx, ['--upgrade', src.spec], pipEnv(ctx, mirror), '安装 diffusers（' + src.label + '）…')
      if (ok && hasQwen21()) {
        diffusersOk = true
        ui.ok('diffusers 就绪（含 QwenImage21Pipeline）：' + src.label)
        writeState(ctx.paths, { diffusersSource: src.label, diffusersCommit: commit })
        break
      }
      if (ok) ui.warn('装上了这个来源的 diffusers，但它不含 QwenImage21Pipeline，换下一个来源…')
      failures.push('diffusers（' + src.label + '）')
    }
    if (!diffusersOk) {
      ui.err('diffusers 没能装到含 QwenImage21Pipeline 的版本')
      ui.hint('手动命令：pip install "git+https://github.com/huggingface/diffusers.git@' + commit + '"（需要 git）')
      ui.hint('或：pip install https://github.com/huggingface/diffusers/archive/' + commit + '.tar.gz')
    }
  } else if (diffusersOk) {
    ui.ok('diffusers 已就绪（含 QwenImage21Pipeline）')
  }

  return { ok: diffusersOk, torch: require('torch'), diffusers: diffusersOk, failures: failures }
}

/** 最终核验：跑 worker/env_report.py，并给出人类可读结论。 */
export function verifyInstall(ctx, modelDir) {
  const res = envReport(ctx.paths, ctx.venvPython, modelDir, {})
  if (!res.ok || !res.report) {
    ctx.ui.err('环境核验脚本没能给出结果（输出可能被截断）')
    if (res.raw) ctx.ui.detail(res.raw.slice(-600))
    return { ok: false, report: null }
  }
  const rep = res.report
  const ui = ctx.ui
  const pkgs = rep.packages || {}
  ui.table([
    { label: 'Python', value: rep.python.version + (rep.python.isVenv ? '（venv）' : '（非 venv）') },
    { label: 'torch', value: pkgs.torch ? pkgs.torch + (rep.gpu && rep.gpu.torchCuda ? '（cuda ' + rep.gpu.torchCuda + '）' : '') : '未安装' },
    { label: 'diffusers', value: pkgs.diffusers ? pkgs.diffusers + (pkgs.hasQwenImage21 ? '（含 QwenImage21Pipeline）' : '（缺 QwenImage21Pipeline）') : '未安装' },
    { label: 'transformers', value: pkgs.transformers || '未安装' },
    { label: 'CUDA 可用', value: rep.gpu && rep.gpu.cudaAvailable ? '是' : '否' },
  ])
  for (const d of (rep.gpu && rep.gpu.devices) || []) {
    ui.detail('GPU ' + d.index + '：' + d.name + '  capability ' + JSON.stringify(d.capability) + '  空闲 ' + (d.freeMiB == null ? '?' : d.freeMiB + ' MB'))
  }
  if (rep.reusePaths && rep.reusePaths.length) ui.detail('复用的包目录：' + rep.reusePaths.join('、'))
  if (pkgs.torch && rep.gpu && !rep.gpu.cudaAvailable && ctx.plan && ctx.plan.gpu && ctx.plan.gpu.vendor === 'nvidia') {
    ui.warn('torch 看不到 CUDA：可能是 CPU 版轮子或驱动不匹配，生图会退化到 CPU（极慢）')
  }
  for (const p of rep.problems || []) ui.warn(p)
  for (const a of rep.advice || []) ui.hint(a)
  return { ok: !!rep.ok, report: rep }
}
