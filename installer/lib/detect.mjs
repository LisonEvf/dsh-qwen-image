/**
 * 环境探测：把「这台机器长什么样」变成一份结构化事实（facts）。
 *
 * 设计原则（为了「不同用户、不同设备」都能给出正确路径）：
 * 1. **只读**：本模块绝不修改任何文件、绝不安装任何东西。
 * 2. **纯函数解析**：所有文本输出（nvidia-smi / 驱动版本 / py -0p）的解析都拆成
 *    独立导出的纯函数，便于 scripts/smoke-installer.mjs 用 fixture 覆盖各种机型。
 * 3. **软失败**：任何一项探测失败都只记 warning，绝不让安装器崩掉 ——
 *    用户机器上缺 nvidia-smi、没有 GPU、没有 python 都是合法状态。
 */

import { existsSync, readdirSync, statfsSync, statSync, writeFileSync, rmSync } from 'node:fs'
import { homedir, totalmem, arch as osArch, cpus, release, platform as osPlatform, tmpdir } from 'node:os'
import { join } from 'node:path'
import { IS_MAC, IS_WIN, ensureDir, isDir, isExecutablePath, isFile, probeUrl, run, which } from './util.mjs'

/** 权重体积（30.86 GiB）—— 用于磁盘评估，与 worker/model_check.py 口径一致。 */
export const MODEL_SIZE_BYTES = 33150000000

/** 依赖环境（venv + torch cu128 轮子）的粗估占用。 */
export const DEPS_SIZE_BYTES = 9000000000

// ────────────────────────────────────────────────────────────────────────────
// 纯解析函数（smoke-installer.mjs 用 fixture 覆盖）
// ────────────────────────────────────────────────────────────────────────────

/**
 * 解析 nvidia-smi --query-gpu=index,name,memory.total,memory.free,driver_version,compute_cap
 * --format=csv,noheader 的输出。老驱动不认识 compute_cap 列，会返回 "[N/A]"。
 * @param {string} csv
 * @param {string|null} cudaVersion nvidia-smi 头部里的 "CUDA Version: 12.9"
 */
export function parseNvidiaSmiQuery(csv, cudaVersion) {
  const gpus = []
  for (const rawLine of String(csv == null ? '' : csv).split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    if (/error|not found|no devices|not supported/i.test(line) && !/,/.test(line)) continue
    const cols = line.split(',').map((s) => s.trim())
    if (cols.length < 5) continue
    const num = (s) => {
      const m = String(s == null ? '' : s).match(/([0-9][0-9.]*)/)
      return m ? Number(m[1]) : null
    }
    const capRaw = cols[5] == null ? '' : cols[5]
    const capMatch = capRaw.match(/^([0-9]+)\.([0-9]+)$/)
    gpus.push({
      index: Number(cols[0]) || gpus.length,
      name: cols[1],
      vramMiB: num(cols[2]),
      freeMiB: num(cols[3]),
      driver: cols[4] || null,
      computeCapability: capMatch ? Number(capMatch[1] + '.' + capMatch[2]) : null,
      cudaVersion: cudaVersion == null ? null : cudaVersion,
    })
  }
  return gpus
}

/** 从 nvidia-smi 的完整输出里取 "CUDA Version: X.Y"。 */
export function parseCudaVersion(text) {
  const m = String(text == null ? '' : text).match(/CUDA Version:\s*([0-9.]+)/i)
  return m ? m[1] : null
}

/** 解析 Windows "py -0p" 的输出，拿到所有已注册解释器路径。 */
export function parsePyLauncherList(text) {
  const out = []
  for (const line of String(text == null ? '' : text).split(/\r?\n/)) {
    const m = line.match(/^\s*(-[Vv]?:?[0-9.]+(?:-[0-9]+)?\s*\*?)\s+(.+?)\s*$/)
    if (m) out.push({ tag: m[1].replace('*', '').trim(), path: m[2].trim() })
  }
  return out
}

/** 解析 python 探针的 JSON 输出；失败返回 null。 */
export function parsePyProbe(stdout) {
  const text = String(stdout == null ? '' : stdout)
  const marker = text.lastIndexOf('<<<PYPROBE>>>')
  const body = marker >= 0 ? text.slice(marker + 13) : text
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(body.slice(start, end + 1))
  } catch {
    return null
  }
}

/** 常见显卡名 → compute capability（只在 nvidia-smi 给不出时兜底）。 */
export function guessComputeCapability(name) {
  const n = String(name == null ? '' : name).toLowerCase()
  const table = [
    [/p40|p4 |p100|gtx (10|9)[0-9][0-9]|tesla p/, 6.1],
    [/v100/, 7.0],
    [/t4|rtx 20[0-9][0-9]|quadro rtx|tesla t4/, 7.5],
    [/a100/, 8.0],
    [/a10|a40|rtx 30[0-9][0-9]|rtx a[0-9][0-9][0-9]/, 8.6],
    [/h100|h200/, 9.0],
    [/rtx 40[0-9][0-9]|l40|l4|ada/, 8.9],
    [/rtx 50[0-9][0-9]|b100|b200|blackwell/, 12.0],
  ]
  for (const pair of table) if (pair[0].test(n)) return pair[1]
  return null
}

// ────────────────────────────────────────────────────────────────────────────
// 解释器探测
// ────────────────────────────────────────────────────────────────────────────

/** 打进目标解释器的探针脚本（只用标准库；torch 相关全部 try 包裹）。 */
const PY_PROBE = [
  'import json,sys,os,platform',
  'def _ver(n):',
  '    try:',
  '        m=__import__(n); return getattr(m,"__version__","?")',
  '    except Exception: return None',
  'info={"executable":sys.executable,"version":"%d.%d.%d"%sys.version_info[:3],',
  ' "versionFull":sys.version.split()[0],"prefix":sys.prefix,',
  ' "basePrefix":getattr(sys,"base_prefix",sys.prefix),',
  ' "isVenv":sys.prefix!=getattr(sys,"base_prefix",sys.prefix),',
  ' "machine":platform.machine(),"bits":64 if sys.maxsize>2**32 else 32,',
  ' "sitePackages":next((p for p in sys.path if p.endswith("site-packages")),None)}',
  'for _n in ("torch","transformers","diffusers","accelerate","huggingface_hub","safetensors","numpy"):',
  '    info[_n]=_ver(_n)',
  'info["pillow"]=_ver("PIL")',
  'if info["torch"]:',
  '    try:',
  '        import torch',
  '        info["torchCuda"]=torch.version.cuda',
  '        info["cudaAvailable"]=bool(torch.cuda.is_available())',
  '        info["deviceCount"]=torch.cuda.device_count()',
  '        if torch.cuda.is_available():',
  '            info["deviceNames"]=[torch.cuda.get_device_name(i) for i in range(torch.cuda.device_count())]',
  '            info["capabilities"]=[list(torch.cuda.get_device_capability(i)) for i in range(torch.cuda.device_count())]',
  '    except Exception as e:',
  '        info["torchError"]=str(e)[:200]',
  'if info["diffusers"]:',
  '    try:',
  '        from diffusers import QwenImage21Pipeline  # noqa: F401',
  '        info["hasQwen21"]=True',
  '    except Exception:',
  '        info["hasQwen21"]=False',
  'print("<<<PYPROBE>>>"+json.dumps(info))',
].join('\n')

/** 轻量探针（不导入 torch，用于候选很多时的快速筛选）。 */
const PY_PROBE_LIGHT = [
  'import json,sys,platform',
  'print("<<<PYPROBE>>>"+json.dumps({"executable":sys.executable,',
  ' "version":"%d.%d.%d"%sys.version_info[:3],"versionFull":sys.version.split()[0],',
  ' "isVenv":sys.prefix!=getattr(sys,"base_prefix",sys.prefix),',
  ' "machine":platform.machine(),"bits":64 if sys.maxsize>2**32 else 32}))',
].join('\n')

/**
 * 探测一个 Python 解释器。
 * @param {string} exe
 * @param {{deep?: boolean, timeoutMs?: number}} [opts] deep=false 时跳过 torch 导入（快很多）
 */
export function probePython(exe, opts) {
  const o = opts || {}
  const deep = o.deep !== false
  const script = deep ? PY_PROBE : PY_PROBE_LIGHT
  const r = run(exe, ['-c', script], { timeoutMs: o.timeoutMs == null ? 180000 : o.timeoutMs })
  if (!r.ok && !r.stdout) return null
  const info = parsePyProbe(r.stdout)
  if (!info) return null
  return Object.assign({}, info, { path: exe, kind: classifyPython(exe, info) })
}

/** 给解释器打标签：告诉用户「复用了什么」。 */
export function classifyPython(exe, info) {
  const p = String(exe).toLowerCase().replace(/\\/g, '/')
  if (/python_embeded|python_embedded/.test(p)) return 'comfyui-embedded'
  if (/comfyui/.test(p)) return 'comfyui-venv'
  if (/windowsapps|windowspackages/.test(p)) return 'store'
  if (/uv\/python|astral/.test(p)) return 'uv'
  if (/conda|miniconda|anaconda/.test(p)) return 'conda'
  if (/\/venv\/|\/\.venv\//.test(p)) return 'venv'
  if (info && info.isVenv) return 'venv'
  return 'system'
}

/** 找出候选解释器（含 ComfyUI 便携版、uv 安装的、py 启动器注册的）。 */
export function findPythonCandidates(home) {
  const found = []
  const add = (p, source) => {
    if (!p) return
    const norm = String(p)
    if (!isExecutablePath(norm)) return
    const key = norm.toLowerCase()
    if (found.some((f) => f.path.toLowerCase() === key)) return
    found.push({ path: norm, source })
  }

  // 1) 本插件自己的 venv（重装/修复时优先复用）
  const pluginHome = join(home, 'dsh-qwen-image')
  add(IS_WIN ? join(pluginHome, 'venv', 'Scripts', 'python.exe') : join(pluginHome, 'venv', 'bin', 'python'), 'plugin-venv')

  // 2) PATH 上的常规名字
  const names = ['python', 'python3', 'python3.13', 'python3.12', 'python3.11', 'python3.10']
  for (const name of names) {
    const p = which(name)
    if (p) add(p, 'PATH')
  }

  // 3) Windows py 启动器（一次列出所有已装版本）
  if (IS_WIN) {
    const r = run('py', ['-0p'], { timeoutMs: 20000 })
    if (r.ok) for (const item of parsePyLauncherList(r.stdout)) add(item.path, 'py ' + item.tag)
  }

  // 4) ComfyUI（桌面便携版 / 源码版；复用它的 torch 能省 3GB 下载）
  for (const dir of comfyuiCandidateDirs()) {
    add(IS_WIN ? join(dir, 'python_embeded', 'python.exe') : join(dir, 'python_embeded', 'bin', 'python3'), 'comfyui')
    add(IS_WIN ? join(dir, 'venv', 'Scripts', 'python.exe') : join(dir, 'venv', 'bin', 'python'), 'comfyui-venv')
    add(IS_WIN ? join(dir, '.venv', 'Scripts', 'python.exe') : join(dir, '.venv', 'bin', 'python'), 'comfyui-venv')
  }

  // 5) uv 托管的解释器
  const uvRoots = [
    process.env.UV_PYTHON_INSTALL_DIR,
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'uv', 'python') : null,
    join(homedir(), '.local', 'share', 'uv', 'python'),
    join(homedir(), 'Library', 'Application Support', 'uv', 'python'),
  ].filter(Boolean)
  for (const root of uvRoots) {
    if (!isDir(root)) continue
    let entries = []
    try {
      entries = readdirSync(root, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue
      const base = join(root, e.name)
      add(IS_WIN ? join(base, 'python.exe') : join(base, 'bin', 'python3'), 'uv')
    }
  }
  return found
}

/** ComfyUI 常见安装位置（含环境变量覆盖）。 */
export function comfyuiCandidateDirs() {
  const dirs = []
  if (process.env.COMFYUI_PATH) dirs.push(process.env.COMFYUI_PATH)
  if (process.env.COMFYUI_DIR) dirs.push(process.env.COMFYUI_DIR)
  const home = homedir()
  const bases = [join(home, 'Desktop'), join(home, 'Documents'), home, 'C:\\', 'D:\\', 'E:\\']
  for (const b of bases) {
    dirs.push(join(b, 'ComfyUI'))
    dirs.push(join(b, 'ComfyUI_windows_portable'))
    dirs.push(join(b, 'ComfyUI', 'ComfyUI'))
  }
  if (IS_WIN && process.env.LOCALAPPDATA) {
    dirs.push(join(process.env.LOCALAPPDATA, 'Programs', '@comfyorgcomfyui-electron', 'resources', 'ComfyUI'))
  }
  const seen = new Set()
  const out = []
  for (const d of dirs) {
    const key = String(d).toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    if (isDir(d)) out.push(d)
  }
  return out
}

/** 探测目标路径所在卷的可用空间。 */
export function volumeFreeBytes(path) {
  try {
    if (typeof statfsSync === 'function') {
      const st = statfsSync(path)
      return { free: st.bavail * st.bsize, total: st.blocks * st.bsize }
    }
  } catch {
    /* 落到平台命令兜底 */
  }
  if (IS_WIN) {
    const drive = /^([A-Za-z]):/.exec(path)
    if (drive) {
      const ps = run('powershell', ['-NoProfile', '-Command', '(Get-PSDrive ' + drive[1] + ').Free'], { timeoutMs: 30000 })
      const free = Number((ps.stdout || '').trim())
      if (Number.isFinite(free)) return { free: free, total: null }
    }
  } else {
    const df = run('df', ['-Pk', path], { timeoutMs: 20000 })
    const lines = (df.stdout || '').trim().split(/\r?\n/)
    const cols = (lines[lines.length - 1] || '').split(/\s+/)
    if (cols.length >= 4) return { free: Number(cols[3]) * 1024, total: Number(cols[1]) * 1024 }
  }
  return { free: null, total: null }
}

// ────────────────────────────────────────────────────────────────────────────
// 顶层探测
// ────────────────────────────────────────────────────────────────────────────

/** 解析 DSH_HOME：显式参数 > 环境变量 > ~/.dsh。 */
export function resolveDshHome(explicit) {
  if (explicit) return explicit
  if (process.env.DSH_HOME) return process.env.DSH_HOME
  return join(homedir(), '.dsh')
}

/** 列出 profile 目录（web / tui / ...）。 */
export function listProfiles(home) {
  const dir = join(home, 'profiles')
  if (!isDir(dir)) return []
  let entries = []
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const out = []
  for (const e of entries) {
    if (!e.isDirectory() || e.name === 'node_modules') continue
    out.push({
      name: e.name,
      dir: join(dir, e.name),
      hasManifest: isFile(join(dir, e.name, 'package.json')),
      hasPatch: isFile(join(dir, e.name, 'cordis.patch.yml')),
    })
  }
  return out
}

/**
 * 完整探测。耗时主要在 Python 深度探针（导入 torch 要几秒）。
 * @param {{home?: string, net?: boolean, pythonExe?: string, maxDeepProbes?: number}} opts
 */
export async function detectEnvironment(opts) {
  const o = opts || {}
  const home = resolveDshHome(o.home)
  const facts = {
    time: new Date().toISOString(),
    platform: osPlatform(),
    arch: osArch(),
    osRelease: release(),
    isWin: IS_WIN,
    isMac: IS_MAC,
    isLinux: !IS_WIN && !IS_MAC,
    cpu: String((cpus() && cpus()[0] && cpus()[0].model) || 'unknown').trim(),
    cpuCount: (cpus() || []).length,
    ramBytes: totalmem(),
    tempDir: tmpdir(),
    home: home,
    homeWritable: null,
    profiles: listProfiles(home),
    node: { version: process.versions.node, ok: Number(process.versions.node.split('.')[0]) >= 18 },
    tools: {},
    dshVersion: null,
    gpus: [],
    gpuVendor: 'none',
    cudaDriverVersion: null,
    pythons: [],
    comfyui: [],
    net: {},
    disk: { free: null, total: null },
    warnings: [],
  }

  // —— 命令行工具 ——
  facts.tools.npm = which('npm')
  facts.tools.pnpm = which('pnpm')
  facts.tools.git = which('git')
  facts.tools.uv = which('uv')
  facts.tools.hf = which('hf')
  facts.tools.dsh = which('dsh') || which('dsh.cmd') || which('dsh.ps1')
  if (facts.tools.dsh) {
    const v = run(facts.tools.dsh, ['--version'], { timeoutMs: 90000 })
    const lines = ((v.stdout || '') + (v.stderr || '')).trim().split(/\r?\n/)
    facts.dshVersion = lines.length ? lines[lines.length - 1].trim() : null
  }

  // —— GPU ——
  const smi = run('nvidia-smi', ['--query-gpu=index,name,memory.total,memory.free,driver_version,compute_cap', '--format=csv,noheader'], { timeoutMs: 30000 })
  if (smi.ok && smi.stdout.trim() && !/not recognized|command not found/i.test(smi.stderr)) {
    const full = run('nvidia-smi', [], { timeoutMs: 30000 })
    facts.cudaDriverVersion = parseCudaVersion(full.stdout)
    facts.gpus = parseNvidiaSmiQuery(smi.stdout, facts.cudaDriverVersion)
    for (const g of facts.gpus) if (g.computeCapability == null) g.computeCapability = guessComputeCapability(g.name)
    facts.gpuVendor = 'nvidia'
  } else {
    facts.gpus = detectOtherGpus(facts)
  }
  if (facts.gpuVendor === 'none' && facts.gpus.length === 0) facts.warnings.push('no-gpu-detected')

  // —— Python 候选 ——
  const candidates = []
  if (o.pythonExe) candidates.push({ path: o.pythonExe, source: 'explicit' })
  for (const c of findPythonCandidates(home)) {
    if (!candidates.some((x) => x.path.toLowerCase() === c.path.toLowerCase())) candidates.push(c)
  }
  const deepLimit = o.maxDeepProbes == null ? 4 : o.maxDeepProbes
  const probed = []
  const seenReal = new Set()
  for (let i = 0; i < candidates.length && probed.length < deepLimit; i++) {
    const info = probePython(candidates[i].path, { deep: true, timeoutMs: 180000 })
    if (!info) continue
    // 同一个解释器的多个入口（python / python3 / 应用别名）只保留一条
    const key = String(info.executable || candidates[i].path).toLowerCase()
    if (seenReal.has(key)) continue
    seenReal.add(key)
    probed.push(Object.assign({}, info, { source: candidates[i].source }))
  }
  facts.pythons = probed
  facts.pythonCandidates = candidates.length
  if (!probed.length) facts.warnings.push('no-python')

  // —— ComfyUI ——
  facts.comfyui = comfyuiCandidateDirs().map((dir) => ({
    dir: dir,
    embedded: IS_WIN ? isExecutablePath(join(dir, 'python_embeded', 'python.exe')) : isExecutablePath(join(dir, 'python_embeded', 'bin', 'python3')),
    venv: IS_WIN ? isExecutablePath(join(dir, 'venv', 'Scripts', 'python.exe')) : isExecutablePath(join(dir, 'venv', 'bin', 'python')),
    modelsDir: isDir(join(dir, 'models')),
  }))

  // —— 磁盘 ——
  facts.disk = volumeFreeBytes(home)
  if (facts.disk.free == null) facts.warnings.push('disk-unknown')

  // —— DSH_HOME 可写性 ——
  try {
    ensureDir(home)
    const probeFile = join(home, '.dsh-qwen-image-write-test-' + process.pid)
    writeFileSync(probeFile, 'ok')
    rmSync(probeFile, { force: true })
    facts.homeWritable = true
  } catch {
    facts.homeWritable = false
    facts.warnings.push('home-not-writable')
  }

  // —— 网络可达性（约 6 秒，可 --no-net 跳过） ——
  if (o.net !== false) {
    const targets = {
      pypi: 'https://pypi.org/simple/',
      tuna: 'https://pypi.tuna.tsinghua.edu.cn/simple/',
      pytorch: 'https://download.pytorch.org/whl/cu128/',
      hfMirror: 'https://hf-mirror.com/',
      hf: 'https://huggingface.co/',
      github: 'https://github.com/',
      modelscope: 'https://www.modelscope.cn/',
    }
    const results = await Promise.all(
      Object.keys(targets).map(async (k) => [k, await probeUrl(targets[k], { timeoutMs: 6000 })]),
    )
    for (const pair of results) facts.net[pair[0]] = { ok: pair[1].ok, status: pair[1].status, ms: pair[1].ms, error: pair[1].error }
  }

  return facts
}

/** 非 NVIDIA 机器上的显卡识别（AMD / Intel / Apple），用于给出正确建议。 */
function detectOtherGpus(facts) {
  const gpus = []
  if (IS_WIN) {
    const ps = run('powershell', ['-NoProfile', '-Command', 'Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM,DriverVersion | ConvertTo-Json -Compress'], { timeoutMs: 60000 })
    const text = (ps.stdout || '').trim()
    if (text) {
      try {
        const parsed = JSON.parse(text)
        const list = Array.isArray(parsed) ? parsed : [parsed]
        for (let i = 0; i < list.length; i++) {
          const g = list[i]
          const name = String(g.Name || '')
          const vendor = /nvidia/i.test(name) ? 'nvidia' : /amd|radeon/i.test(name) ? 'amd' : /intel/i.test(name) ? 'intel' : 'other'
          gpus.push({ index: i, name: name, vendor: vendor, vramMiB: g.AdapterRAM ? Math.round(Number(g.AdapterRAM) / 1048576) : null, freeMiB: null, driver: g.DriverVersion || null, computeCapability: null, cudaVersion: null })
        }
      } catch {
        /* ignore */
      }
    }
  } else if (IS_MAC) {
    const sp = run('system_profiler', ['SPDisplaysDataType', '-json'], { timeoutMs: 90000 })
    try {
      const parsed = JSON.parse(sp.stdout || '{}')
      const list = parsed.SPDisplaysDataType || []
      for (let i = 0; i < list.length; i++) {
        const g = list[i]
        gpus.push({ index: i, name: g.sppci_model || g._name || 'Apple GPU', vendor: 'apple', vramMiB: null, freeMiB: null, driver: null, computeCapability: null, cudaVersion: null })
      }
    } catch {
      /* ignore */
    }
  } else {
    const lspci = run('lspci', [], { timeoutMs: 20000 })
    for (const line of (lspci.stdout || '').split(/\r?\n/)) {
      if (!/vga|3d controller/i.test(line)) continue
      const vendor = /nvidia/i.test(line) ? 'nvidia' : /amd|ati/i.test(line) ? 'amd' : /intel/i.test(line) ? 'intel' : 'other'
      gpus.push({ index: gpus.length, name: line.replace(/^[0-9a-f:.]+\s*/i, '').trim(), vendor: vendor, vramMiB: null, freeMiB: null, driver: null, computeCapability: null, cudaVersion: null })
    }
  }
  const primary = gpus.find((g) => g.vendor === 'nvidia') || gpus.find((g) => g.vendor === 'amd') || gpus.find((g) => g.vendor === 'intel') || gpus[0]
  facts.gpuVendor = primary ? primary.vendor : 'none'
  return gpus
}

/** 便捷判断：facts 里有没有「已经能跑」的解释器。 */
export function findReadyPython(facts) {
  const list = facts.pythons || []
  return (
    list.find((p) => p.torch && p.diffusers && p.hasQwen21) ||
    list.find((p) => p.torch && p.diffusers) ||
    null
  )
}

/** 有没有那种「有 torch 但缺 diffusers」的环境（可以补装而不是全重装）。 */
export function findTorchPython(facts) {
  const list = facts.pythons || []
  return list.find((p) => p.torch && !(p.diffusers && p.hasQwen21)) || null
}

export { existsSync, statSync }
