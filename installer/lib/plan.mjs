/**
 * 决策层：把 detect.mjs 的事实（facts）翻译成一份**可执行的安装计划**。
 *
 * 本文件刻意写成**纯函数**：不碰文件系统、不起进程、不读环境变量。
 * 这样 scripts/smoke-installer.mjs 能用 fixture 覆盖
 * 「新驱动 N 卡 / 老驱动 N 卡 / A 卡 / 无独显 / Mac / 已装 ComfyUI / 只剩 3GB 磁盘」
 * 等一整张设备矩阵，全部离线跑通 —— 这正是「不同用户不同设备」的回归测试。
 */

import { DEPS_SIZE_BYTES, MODEL_SIZE_BYTES } from './detect.mjs'

/** PyTorch 官方 wheel 索引（按 CUDA 版本）与各索引可用的版本、最低驱动要求。 */
export const TORCH_INDEXES = {
  cu128: { url: 'https://download.pytorch.org/whl/cu128', versions: ['2.7.1', '2.6.0'], minCuda: [12, 8], label: 'CUDA 12.8' },
  cu126: { url: 'https://download.pytorch.org/whl/cu126', versions: ['2.7.1', '2.6.0'], minCuda: [12, 6], label: 'CUDA 12.6' },
  cu124: { url: 'https://download.pytorch.org/whl/cu124', versions: ['2.6.0', '2.5.1'], minCuda: [12, 4], label: 'CUDA 12.4' },
  cu121: { url: 'https://download.pytorch.org/whl/cu121', versions: ['2.5.1', '2.4.1'], minCuda: [12, 1], label: 'CUDA 12.1' },
  cu118: { url: 'https://download.pytorch.org/whl/cu118', versions: ['2.4.1'], minCuda: [11, 8], label: 'CUDA 11.8' },
  rocm63: { url: 'https://download.pytorch.org/whl/rocm6.3', versions: ['2.6.0'], minCuda: null, label: 'ROCm 6.3（Linux + AMD）' },
  cpu: { url: 'https://download.pytorch.org/whl/cpu', versions: ['2.7.1', '2.6.0'], minCuda: null, label: 'CPU' },
  pypi: { url: null, versions: ['2.7.1', '2.6.0'], minCuda: null, label: 'PyPI 默认（macOS / Apple GPU）' },
}

/** torch 版本 → 支持的 Python 次版本区间 [minMinor, maxMinor]（Python 3.x）。 */
export const TORCH_PY_SUPPORT = {
  '2.4.1': [8, 12],
  '2.5.1': [9, 12],
  '2.6.0': [9, 13],
  '2.7.1': [9, 13],
}

/** 中国大陆可用的 PyPI / PyTorch 轮子镜像（按顺序尝试）。 */
export const PIP_MIRRORS = [
  { name: 'PyPI 官方', url: null },
  { name: '清华 TUNA', url: 'https://pypi.tuna.tsinghua.edu.cn/simple' },
  { name: '阿里云', url: 'https://mirrors.aliyun.com/pypi/simple' },
]

/** diffusers 安装源阶梯（从上到下尝试，任何一个装上且能 import QwenImage21Pipeline 即通过）。 */
export const DIFFUSERS_SOURCES = [
  { kind: 'git', label: 'GitHub（锁定 commit）' },
  { kind: 'tarball', label: 'GitHub 源码包（不需要 git）' },
  { kind: 'pypi', label: 'PyPI 最新版' },
]

// ────────────────────────────────────────────────────────────────────────────
// 纯决策函数
// ────────────────────────────────────────────────────────────────────────────

/** 把 "12.9" / "11.8" 解析成 [major, minor]。 */
export function parseCuda(text) {
  const m = String(text == null ? '' : text).match(/^([0-9]+)\.([0-9]+)/)
  return m ? [Number(m[1]), Number(m[2])] : null
}

/** 比较 [major,minor] >= [major,minor]。 */
export function gteVersion(a, b) {
  if (!a || !b) return false
  if (a[0] !== b[0]) return a[0] > b[0]
  return a[1] >= b[1]
}

/**
 * 按驱动版本选 PyTorch wheel 索引。驱动 CUDA 版本是**向后兼容**的：
 * 驱动报 12.9 时，cu128 / cu126 / cu124 的轮子都能跑。
 * @param {{platform: string, gpuVendor: string, cudaDriverVersion: string|null, gpus: any[]}} facts
 * @param {string} [override] 用户显式指定（cu128 / cpu / …）
 */
export function pickTorchIndex(facts, override) {
  const notes = []
  if (override) {
    if (!TORCH_INDEXES[override]) return { index: 'cu128', key: 'cu128', notes: ['未知的 --torch 值 ' + override + '，改用 cu128'] }
    return { index: TORCH_INDEXES[override].url, key: override, notes: ['用户显式指定 ' + TORCH_INDEXES[override].label] }
  }
  // macOS：PyPI 默认轮子（torch 自带 MPS，但本项目的 worker 只认 CUDA/CPU，
  // 见 worker/pipeline_qwen21.py 的 resolve_device()——所以实际会按 CPU 推理）
  if (facts.isMac || facts.platform === 'darwin') {
    return { index: null, key: 'pypi', notes: ['macOS 使用 PyPI 默认轮子（本插件仅支持 CUDA/CPU，将按 CPU 推理，速度很慢）'] }
  }
  // Linux + AMD：ROCm 轮子
  if (facts.isLinux && facts.gpuVendor === 'amd') {
    return { index: TORCH_INDEXES.rocm63.url, key: 'rocm63', notes: ['检测到 AMD 显卡，使用 ROCm 6.3 轮子'] }
  }
  if (facts.gpuVendor !== 'nvidia') {
    notes.push('未检测到 NVIDIA 显卡，安装 CPU 版 torch（只能跑 CPU 推理，速度极慢）')
    if (facts.gpuVendor === 'amd' && facts.isWin) notes.push('Windows 上的 AMD 显卡没有官方 CUDA/ROCm 轮子：建议改用 CPU 或把推理放到 NVIDIA 机器上')
    if (facts.gpuVendor === 'intel') notes.push('Intel 核显/独显暂不支持，使用 CPU 版 torch')
    if (facts.gpuVendor === 'apple') notes.push('Apple GPU（MPS）本插件暂不支持：会按 CPU 推理，速度很慢')
    return { index: TORCH_INDEXES.cpu.url, key: 'cpu', notes: notes }
  }
  const cuda = parseCuda(facts.cudaDriverVersion)
  if (!cuda) {
    // 有 N 卡但拿不到 CUDA Version 行：按驱动号粗判
    const drv = Number((facts.gpus[0] && facts.gpus[0].driver) || 0)
    const guess = drv >= 570 ? 'cu128' : drv >= 550 ? 'cu126' : drv >= 525 ? 'cu124' : 'cu118'
    notes.push('拿不到 nvidia-smi 的 CUDA 版本，按驱动号 ' + drv + ' 推定 ' + TORCH_INDEXES[guess].label)
    return { index: TORCH_INDEXES[guess].url, key: guess, notes: notes }
  }
  const order = ['cu128', 'cu126', 'cu124', 'cu121', 'cu118']
  for (const key of order) {
    const spec = TORCH_INDEXES[key]
    if (gteVersion(cuda, spec.minCuda)) return { index: spec.url, key: key, notes: notes }
  }
  notes.push('驱动过旧（CUDA ' + facts.cudaDriverVersion + '）：请升级显卡驱动到 525 以上，否则只能用 CPU 版')
  return { index: TORCH_INDEXES.cpu.url, key: 'cpu', notes: notes }
}

/**
 * 选一个「装了就能用」的 torch 版本：既要该索引里有，又要支持目标 Python。
 * @param {string} indexKey
 * @param {number} pyMinor Python 3.x 的 x
 */
export function pickTorchVersion(indexKey, pyMinor) {
  const spec = TORCH_INDEXES[indexKey] || TORCH_INDEXES.cu128
  for (const v of spec.versions) {
    const range = TORCH_PY_SUPPORT[v]
    if (!range) continue
    if (pyMinor == null) return v
    if (pyMinor >= range[0] && pyMinor <= range[1]) return v
  }
  return null
}

/** 精度建议：sm >= 8.0 用 bf16，其余用 fp16（P40 实测 fp16 最快）。 */
export function recommendDtype(capability) {
  if (capability == null) return { dtype: 'auto', note: '由 worker 按显卡能力决定' }
  if (capability >= 8.0) return { dtype: 'bf16', note: 'Ampere 及以后：bf16' }
  if (capability >= 6.0) return { dtype: 'fp16', note: 'Pascal/Turing/Volta：fp16（P40 实测比 fp32 更快）' }
  return { dtype: 'fp32', note: '计算能力 < 6.0：只能 fp32，速度很慢' }
}

/** 显存 → offload 与档位建议（峰值显存实测恒定约 16.8GB）。 */
export function recommendOffload(vramMiB) {
  if (vramMiB == null) return { offload: 'auto', preset: 'draft', note: '显存未知，先用最小档试探' }
  if (vramMiB >= 20480) return { offload: 'model', preset: 'standard', note: '显存充足，可跑 1024²' }
  if (vramMiB >= 16384) return { offload: 'model', preset: 'standard', note: '显存刚好够 1024²（峰值约 16.8GB）' }
  if (vramMiB >= 10240) return { offload: 'sequential', preset: 'draft', note: '显存偏小：逐层 offload + 768² 草稿档' }
  if (vramMiB >= 6144) return { offload: 'sequential', preset: 'draft', note: '显存紧张：能跑但很慢，建议只在草稿档使用' }
  return { offload: 'sequential', preset: 'draft', note: '显存过小（< 6GB）：基本跑不动，建议换设备或改用远端后端' }
}

/**
 * 生成安装计划。
 * @param {any} facts detectEnvironment() 的结果
 * @param {{
 *   profile?: string,
 *   modelDir?: string,
 *   pythonExe?: string,
 *   torch?: string,
 *   reuse?: boolean|null,
 *   withModel?: boolean,
 *   pluginRoot?: string,
 *   pluginSpec?: string,
 *   modelState?: {state: string, missing?: string[]}|null,
 *   diffusersRef?: {commit?: string|null},
 *   pythonOverride?: {path: string, source?: string}|null,
 * }} opts
 */
export function buildPlan(facts, opts) {
  const o = opts || {}
  const blockers = []
  const warnings = []
  const notes = []

  // ── 磁盘 ──
  const modelDir = o.modelDir || joinPath(facts.home, 'models', 'Qwen-Image-2.1')
  const needModel = o.withModel !== false && !(o.modelState && o.modelState.state === 'ok')
  const requiredBytes = DEPS_SIZE_BYTES + (needModel ? MODEL_SIZE_BYTES : 0)
  const free = facts.disk && Number.isFinite(facts.disk.free) ? facts.disk.free : null
  const disk = { free: free, required: requiredBytes, ok: free == null ? true : free > requiredBytes * 1.05 }
  if (free != null && !disk.ok) {
    blockers.push({
      code: 'disk-too-small',
      message: '磁盘空间不足：需要约 ' + gb(requiredBytes) + '，当前可用 ' + gb(free),
      fix: '清理磁盘后重试，或用 --model-dir 指到空间更大的盘；只想先跑起来可加 --no-model 后单独下载权重',
    })
  }

  // ── DSH_HOME ──
  if (facts.homeWritable === false) {
    blockers.push({
      code: 'home-not-writable',
      message: 'DSH_HOME 不可写：' + facts.home,
      fix: '检查目录权限，或用 --home <可写目录> 指定（同时设置环境变量 DSH_HOME 让 dsh 也用同一处）',
    })
  }

  // ── GPU / torch 索引 ──
  const indexPick = pickTorchIndex(facts, o.torch)
  for (const n of indexPick.notes) warnings.push(n)

  const mainGpu = pickMainGpu(facts)
  const vram = mainGpu ? mainGpu.vramMiB : null
  const capability = mainGpu ? mainGpu.computeCapability : null
  const dtypeAdvice = recommendDtype(capability)
  const offloadAdvice = recommendOffload(vram)
  const gpuNotes = []
  if (!mainGpu) gpuNotes.push('没有可用 GPU：CPU 推理 1024²/24 步需要数小时，强烈建议换机器')
  else if (vram != null && vram < 6144) gpuNotes.push('显存 ' + vram + 'MB 过小：会频繁换页，基本不可用')
  if (facts.ramBytes != null && facts.ramBytes < 24 * 1024 ** 3) {
    gpuNotes.push('内存 ' + gb(facts.ramBytes) + '：模型权重 30.9GB 无法缓存，每张图都要重新读盘（实测每图多等 80-90 秒），建议 64GB')
  }
  if (mainGpu && facts.gpus && facts.gpus.length > 1) {
    const biggest = facts.gpus.slice().sort((a, b) => (b.vramMiB || 0) - (a.vramMiB || 0))[0]
    if (biggest && biggest.name !== mainGpu.name) {
      gpuNotes.push('检测到多张显卡：' + biggest.name + ' 的显存被其它程序占用（空闲 ' + (biggest.freeMiB == null ? '?' : biggest.freeMiB + 'MB') + '），本次按空闲显存最多的 ' + mainGpu.name + ' 规划；把占用程序停掉可以换回大卡')
    }
  }
  if (mainGpu && mainGpu.freeMiB != null && mainGpu.vramMiB && mainGpu.freeMiB < mainGpu.vramMiB * 0.4) {
    gpuNotes.push('当前主卡空闲显存只有 ' + mainGpu.freeMiB + 'MB / ' + mainGpu.vramMiB + 'MB，疑似被别的程序占用：生图前请先释放显存，否则会被显存守卫拒绝')
  }
  if (mainGpu && mainGpu.name && /p40/i.test(mainGpu.name)) {
    gpuNotes.push('Tesla P40：无 bf16，实测 fp16 最快（1024²/24 步约 5 分钟/张）')
  }

  // ── Python 策略 ──
  const py = choosePython(facts, o)
  if (py.strategy === 'none') {
    blockers.push({
      code: 'no-python',
      message: '没有找到可用的 Python 3.10-3.13 解释器',
      fix: '安装 Python 3.12（https://www.python.org/downloads/ 或国内镜像 https://mirrors.huaweicloud.com/python/），安装时勾选 "Add python.exe to PATH"，然后重新运行本安装器；安装器也会尝试自动下载 uv 来托管 Python',
    })
  } else if (py.note) {
    notes.push(py.note)
  }

  // ── torch 版本 ──
  const pyMinor = py.minor == null ? 12 : py.minor
  let torchVersion = pickTorchVersion(indexPick.key, pyMinor)
  if (!torchVersion) {
    warnings.push('索引 ' + indexPick.key + ' 没有支持 Python 3.' + pyMinor + ' 的 torch：将改用 Python 3.12 新建环境')
    torchVersion = pickTorchVersion(indexPick.key, 12) || '2.7.1'
    py.forcePythonMinor = 12
  }

  // ── 依赖清单 ──
  const pip = Array.isArray(facts.pythons) ? facts.pythons.find((p) => p.path === py.interpreter) : null
  const deps = []
  if (py.strategy !== 'reuse-site' || !pip || !pip.torch) {
    deps.push({ spec: 'torch==' + torchVersion, index: indexPick.index, label: 'PyTorch ' + torchVersion + '（' + TORCH_INDEXES[indexPick.key].label + '）', big: true })
  }
  if (!pip || !pip.transformers) deps.push({ spec: 'transformers>=5.17', label: 'transformers' })
  if (!pip || !pip.accelerate) deps.push({ spec: 'accelerate', label: 'accelerate（显存 offload）' })
  if (!pip || !pip.pillow) deps.push({ spec: 'pillow', label: 'pillow' })
  if (!pip || !pip.numpy) deps.push({ spec: 'numpy', label: 'numpy' })
  if (!pip || !pip.huggingface_hub) deps.push({ spec: 'huggingface_hub', label: 'huggingface_hub（下载权重）' })
  if (!pip || !pip.safetensors) deps.push({ spec: 'safetensors', label: 'safetensors' })
  if (!pip || !pip.diffusers || !pip.hasQwen21) deps.push({ spec: 'diffusers', label: 'diffusers（含 QwenImage21Pipeline）', special: 'diffusers' })

  // ── 权重 ──
  const netOk = facts.net || {}
  let endpoint = 'https://hf-mirror.com'
  if (netOk.hfMirror && !netOk.hfMirror.ok && netOk.hf && netOk.hf.ok) endpoint = null
  const model = {
    dir: modelDir,
    needDownload: needModel,
    state: o.modelState ? o.modelState.state : 'unknown',
    missing: (o.modelState && o.modelState.missing) || [],
    endpoint: endpoint,
    bytes: MODEL_SIZE_BYTES,
  }
  if (needModel && netOk.hfMirror && !netOk.hfMirror.ok && (!netOk.hf || !netOk.hf.ok) && netOk.modelscope && netOk.modelscope.ok) {
    model.method = 'modelscope'
    warnings.push('HuggingFace 与镜像都不可达，但 ModelScope 可达：权重将走 ModelScope 下载')
  } else {
    model.method = 'huggingface'
  }

  // ── 插件注册 ──
  const profiles = facts.profiles || []
  const profile = o.profile || pickProfile(profiles)
  const pluginRoot = o.pluginRoot || null
  const plugin = {
    profile: profile,
    root: pluginRoot,
    spec: o.pluginSpec || pluginRoot,
    dsh: facts.tools ? facts.tools.dsh : null,
    pnpm: facts.tools ? facts.tools.pnpm : null,
    npm: facts.tools ? facts.tools.npm : null,
    profileExists: profiles.some((p) => p.name === profile),
  }
  if (!plugin.dsh) {
    warnings.push('PATH 里没有 dsh：依赖与权重会照常装好，但插件无法自动注册（装好 dsh 后重跑本安装器，或手动执行 dsh plugin --profile ' + profile + ' add）')
  }
  if (!plugin.pnpm && !plugin.npm) {
    warnings.push('既没有 pnpm 也没有 npm：无法注册插件（dsh plugin 依赖 pnpm 转发）')
  }

  return {
    ok: blockers.length === 0,
    blockers: blockers,
    warnings: warnings,
    notes: notes,
    disk: disk,
    gpu: {
      vendor: facts.gpuVendor,
      main: mainGpu,
      vramMiB: vram,
      capability: capability,
      dtype: dtypeAdvice.dtype,
      dtypeNote: dtypeAdvice.note,
      offload: offloadAdvice.offload,
      offloadNote: offloadAdvice.note,
      preset: offloadAdvice.preset,
      notes: gpuNotes,
    },
    python: py,
    torch: { index: indexPick.index, key: indexPick.key, version: torchVersion, label: TORCH_INDEXES[indexPick.key].label },
    deps: deps,
    model: model,
    plugin: plugin,
    reuse: py.strategy === 'reuse-site',
  }
}

function joinPath() {
  const parts = []
  for (let i = 0; i < arguments.length; i++) parts.push(String(arguments[i]).replace(/[\\/]+$/, ''))
  const sep = parts[0] && /^[A-Za-z]:/.test(parts[0]) ? '\\' : '/'
  return parts.join(sep)
}

function gb(bytes) {
  return (bytes / 1024 ** 3).toFixed(1) + ' GB'
}

/** 选主显卡：空闲显存最多的那张（P40 被占满时应自动落到另一张）。 */
export function pickMainGpu(facts) {
  const gpus = (facts.gpus || []).filter((g) => g.vendor === 'nvidia' || g.vendor == null)
  if (!gpus.length) return null
  const sorted = gpus.slice().sort((a, b) => (b.freeMiB || b.vramMiB || 0) - (a.freeMiB || a.vramMiB || 0))
  return sorted[0]
}

/** 选默认 profile：优先 web，其次唯一存在的 profile，最后回落到 web。 */
export function pickProfile(profiles) {
  const names = (profiles || []).map((p) => p.name)
  if (names.includes('web')) return 'web'
  if (names.length === 1) return names[0]
  return 'web'
}

/**
 * 选 Python 策略。
 * - explicit：用户用 --python 指定
 * - reuse-site：某个解释器已装好 torch + diffusers（含 QwenImage21Pipeline）→
 *   用它建 venv 并把它的 site-packages 挂进来，能省下 3GB 的 torch 下载
 * - clean：全新 venv 全量安装
 * - none：既没有可用解释器，又不能自动获取
 */
export function choosePython(facts, opts) {
  const o = opts || {}
  if (o.pythonOverride && o.pythonOverride.path) {
    const info = o.pythonOverride.info || null
    return {
      strategy: 'explicit',
      interpreter: o.pythonOverride.path,
      minor: info && info.version ? Number(String(info.version).split('.')[1]) : null,
      version: info ? info.version : null,
      donorSitePackages: null,
      note: '使用 --python 指定的解释器：' + o.pythonOverride.path,
    }
  }
  const pythons = facts.pythons || []
  const usable = pythons.filter((p) => isUsableVersion(p.version))
  const ready = usable.find((p) => p.torch && p.diffusers && p.hasQwen21)
  const partial = usable.find((p) => p.torch && p.hasQwen21 === undefined && p.diffusers)
  const torchOnly = usable.find((p) => p.torch)

  const allowReuse = o.reuse !== false
  if (ready && allowReuse) {
    return {
      strategy: 'reuse-site',
      interpreter: ready.path,
      minor: Number(String(ready.version).split('.')[1]),
      version: ready.version,
      donorSitePackages: ready.sitePackages || null,
      donorKind: ready.kind,
      donorSource: ready.source,
      note: '复用已装好的 Python 环境（' + describeKind(ready.kind) + '，torch ' + ready.torch + '、diffusers ' + ready.diffusers + '）：用它的 site-packages，省去约 3GB 的 torch 下载',
    }
  }
  if (torchOnly && allowReuse && torchOnly.cudaAvailable !== false) {
    return {
      strategy: 'reuse-site',
      interpreter: torchOnly.path,
      minor: Number(String(torchOnly.version).split('.')[1]),
      version: torchOnly.version,
      donorSitePackages: torchOnly.sitePackages || null,
      donorKind: torchOnly.kind,
      donorSource: torchOnly.source,
      note: '复用已有的 torch ' + torchOnly.torch + '（' + describeKind(torchOnly.kind) + '），只补装缺的部分',
    }
  }
  const any = usable[0]
  if (any) {
    return {
      strategy: 'clean',
      interpreter: any.path,
      minor: Number(String(any.version).split('.')[1]),
      version: any.version,
      donorSitePackages: null,
      donorKind: any.kind,
      donorSource: any.source,
      note: '用 ' + describeKind(any.kind) + ' 的 Python ' + any.version + ' 新建独立 venv（不改动系统环境）',
    }
  }
  // 没有 3.10-3.13 的解释器：交给 uv 托管（install.mjs 会先尝试下载 uv）
  const tooOld = pythons.find((p) => p.version && String(p.version).split('.')[0] === '3' && Number(String(p.version).split('.')[1]) < 10)
  const tooNew = pythons.find((p) => p.version && String(p.version).split('.')[0] === '3' && Number(String(p.version).split('.')[1]) > 13)
  const why = tooOld ? '本机 Python ' + tooOld.version + ' 太旧（torch 2.7 / transformers 5.x 需要 3.10+）' : tooNew ? '本机 Python ' + tooNew.version + ' 太新（还没有对应的 torch 轮子）' : '没有可用的本机 Python'
  return {
    strategy: o.uvAvailable ? 'uv' : 'uv-needed',
    interpreter: null,
    minor: null,
    version: null,
    donorSitePackages: null,
    note: why + '：将用 uv 下载并托管 Python 3.12（约 30MB）',
  }
}

function describeKind(kind) {
  const table = {
    system: '系统',
    store: '微软商店版',
    conda: 'conda',
    venv: 'venv',
    'plugin-venv': '本插件 venv',
    'comfyui-embedded': 'ComfyUI 便携版',
    'comfyui-venv': 'ComfyUI venv',
    uv: 'uv 托管',
    explicit: '指定',
  }
  return table[kind] || kind || '未知来源'
}

/** 支持的 Python 版本区间：3.10 – 3.13（3.9 太旧、3.14 没有轮子）。 */
export function isUsableVersion(version) {
  if (!version) return false
  const parts = String(version).split('.')
  if (parts[0] !== '3') return false
  const minor = Number(parts[1])
  return minor >= 10 && minor <= 13
}

export { MODEL_SIZE_BYTES, DEPS_SIZE_BYTES }
