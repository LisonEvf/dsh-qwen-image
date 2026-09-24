import type { Context } from '@deepseek-ai/cordis'
import type { Config } from './config'

/**
 * 环境探测（§5.3 环境部分）。采集 python / torch / transformers / diffusers
 * / CUDA / 各 GPU 空闲显存，供 image_status 汇总。
 *
 * 采集通过 ctx.subprocess 完成：
 * - python 定位：显式 pythonExe → venv/Scripts/python.exe → PATH 中的 python。
 * - 各包版本：`python -c "import X; print(X.__version__)"`。
 * - CUDA 可用性：`python -c "import torch; print(torch.cuda.is_available())"`。
 * - GPU 显存：`nvidia-smi --query-gpu=index,memory.free,memory.total,utilization.gpu --format=csv,noheader,nounits`。
 *
 * 本模块同时提供纯函数（不依赖 ctx），供 smoke 测试复用。
 */

export interface GpuInfo {
  index: number
  freeMiB: number
  totalMiB: number
  utilizationPct: number
  name?: string
}

export interface EnvProbe {
  pythonExe: string | null
  pythonVersion: string | null
  torch: string | null
  transformers: string | null
  diffusers: string | null
  cudaAvailable: boolean | null
  cudaVersion?: string
  gpus: GpuInfo[]
  /**
   * 主机内存（MiB）。
   *
   * 为什么要采集：权重 30.86 GB 走 mmap 加载，**内存/提交空间不足时不会报错，
   * 而是直接段错误（0xC0000005）**，现场只有一句「进程崩了」。
   * 本机实测踩过：一个残留 python 进程占着 65.7 GB 提交内存，
   * 导致之后每次加载模型都在去噪开始时崩溃、且没有任何 Python traceback。
   * 采集它是为了在动手前就把这种情况讲清楚。
   */
  memory?: {
    totalMiB: number
    availableMiB: number
    commitUsedMiB?: number
    commitLimitMiB?: number
  }
  error?: string
}

// subprocess 服务的子集类型（避免 unknown 滥用）
interface SubprocessHandle {
  readonly pid: number
  readonly done: Promise<{ exitCode: number | null; signal: string | null }>
  readonly collected: { stdout?: { readFrom(offset: number): Promise<{ text: string; nextOffset: number; lossy: boolean; spillPath?: string }> } }
  terminate(): void
}
interface SubprocessService {
  spawn(spec: {
    argv: readonly string[]
    cwd: string
    stdio: { stdin: 'ignore' | 'pipe'; stdout: { maxBytes: number }; stderr: { maxBytes: number } }
    graceMs: number
  }): SubprocessHandle
}

/**
 * 计算「空闲显存最多」的 GPU（供 device=auto 决策）。
 */
export function pickFreeGpu(gpus: GpuInfo[]): GpuInfo | undefined {
  return gpus
    .filter((g) => g.freeMiB > 0)
    .sort((a, b) => b.freeMiB - a.freeMiB)[0]
}

/**
 * 依据 compute capability 推荐 dtype。
 *
 * ⚠️ 与 PLAN 原假设不同 —— M0 本机实测（Tesla P40, sm_61, torch 2.7.1+cu128）：
 *   fp32 = 8.642 TFLOPS
 *   fp16 = 10.009 TFLOPS  ← 比 fp32 更快
 *   bf16 = 5.053 TFLOPS   （软件模拟，约半速）
 *
 * 即 Pascal 上的 fp16 并不受「1/64 速率」限制（cuBLAS 走 fp32 累加的高效通路），
 * 因此 sm 6.x 应选 fp16 而非 fp32：既最快，又把 RAM/VRAM 需求减半。
 * bf16 在 sm<80 上必须避免。
 */
export function recommendDtype(smMajor: number): 'bf16' | 'fp16' | 'fp32' {
  if (smMajor >= 8) return 'bf16' // Ampere+：原生 bf16
  if (smMajor >= 6) return 'fp16' // Pascal/Turing/Volta：无 bf16，实测 fp16 最优
  return 'fp32' // Maxwell 及更早
}

/**
 * 依据空闲显存推荐 offload 档位。
 *
 * M0 实测标定值（fp16, P40）：
 *   offload=model 峰值显存 16767 MiB（transformer 13.25GB + 激活，与尺寸无关）
 *   offload=none 需容纳 text_encoder 16.33GB + transformer 13.25GB ≈ 30GB+
 */
export function recommendOffload(freeMiB: number): 'none' | 'model' | 'sequential' {
  if (freeMiB > 32 * 1024) return 'none' // 整条 pipeline 可常驻
  if (freeMiB > 18 * 1024) return 'model' // 单模块可容纳（实测峰值 16.8GB）
  return 'sequential' // 单模块都装不下，逐层流式
}

/**
 * 采集环境（依赖 ctx.subprocess）。永不抛异常——失败收敛为 env.error。
 */
export async function collectEnv(ctx: Context, config: Config): Promise<EnvProbe> {
  const probe: EnvProbe = {
    pythonExe: resolvePythonExe(config.pythonExe),
    pythonVersion: null,
    torch: null,
    transformers: null,
    diffusers: null,
    cudaAvailable: null,
    gpus: [],
  }

  const subprocess = ctx.get('subprocess') as SubprocessService | undefined
  if (!subprocess || !probe.pythonExe) {
    if (!subprocess) probe.error = 'subprocess 服务不可用'
    else probe.error = '未找到 python 可执行文件（请配置 pythonExe 或确保 venv 已创建）'
    return probe
  }

  const python = probe.pythonExe

  probe.pythonVersion = await runPythonVersion(subprocess, python)
  probe.torch = await runPythonImport(subprocess, python, 'torch')
  probe.transformers = await runPythonImport(subprocess, python, 'transformers')
  probe.diffusers = await runPythonImport(subprocess, python, 'diffusers')
  probe.cudaAvailable = await runPythonCuda(subprocess, python)
  probe.gpus = await probeGpus(subprocess)
  probe.memory = await probeMemory(subprocess, python)

  return probe
}

/**
 * 采集主机内存与提交空间。
 *
 * 优先用 psutil（本机已装）；失败则退回 `wmic`/`Get-CimInstance` 都不可靠，
 * 干脆返回 undefined —— 这只是**提示性**信息，不能因为它失败而影响体检。
 */
async function probeMemory(
  subprocess: SubprocessService,
  python: string,
): Promise<EnvProbe['memory'] | undefined> {
  const py = [
    'import json',
    'out={"totalMiB":0,"availableMiB":0}',
    'try:',
    '    import psutil; m=psutil.virtual_memory(); out["totalMiB"]=m.total//2**20; out["availableMiB"]=m.available//2**20',
    '    try:',
    '        s=psutil.swap_memory(); out["commitUsedMiB"]=(m.used+s.used)//2**20',
    '    except Exception: pass',
    'except Exception: pass',
    'print(json.dumps(out))',
  ].join('\n')
  const raw = await safeRun(subprocess, [python, '-c', py])
  if (!raw) return undefined
  try {
    const parsed = JSON.parse(raw.trim().split('\n').pop() ?? '{}') as EnvProbe['memory']
    if (!parsed || !parsed.totalMiB) return undefined
    return parsed
  } catch {
    return undefined
  }
}

function resolvePythonExe(explicit: string): string | null {
  if (explicit && explicit.trim()) return explicit
  // venv 优先
  const dshHome = process.env.DSH_HOME ?? ''
  if (dshHome) return `${dshHome}/dsh-qwen-image/venv/Scripts/python.exe`
  return 'python' // PATH 兜底
}

async function runPythonImport(subprocess: SubprocessService, python: string, mod: string): Promise<string | null> {
  const code = `import ${mod}; print(getattr(${mod}, '__version__', 'unknown'))`
  const out = await safeRun(subprocess, [python, '-c', code])
  return out?.trim() || null
}

async function runPythonVersion(subprocess: SubprocessService, python: string): Promise<string | null> {
  const out = await safeRun(subprocess, [python, '--version'])
  const m = out?.match(/Python\s+([\d.]+)/)
  return m ? m[1] : null
}

async function runPythonCuda(subprocess: SubprocessService, python: string): Promise<boolean | null> {
  const code = `import torch; print(torch.cuda.is_available())`
  const out = await safeRun(subprocess, [python, '-c', code])
  return out?.trim() === 'True' ? true : out?.trim() === 'False' ? false : null
}

async function probeGpus(subprocess: SubprocessService): Promise<GpuInfo[]> {
  const out = await safeRun(subprocess, ['nvidia-smi', '--query-gpu=index,memory.free,memory.total,utilization.gpu,name --format=csv,noheader,nounits'])
  if (!out) return []
  const gpus: GpuInfo[] = []
  for (const line of out.split('\n')) {
    const parts = line.split(',').map((s) => s.trim())
    if (parts.length < 5) continue
    gpus.push({
      index: Number(parts[0]),
      freeMiB: Number(parts[1]),
      totalMiB: Number(parts[2]),
      utilizationPct: Number(parts[3]),
      name: parts[4],
    })
  }
  return gpus
}

/**
 * 安全运行子进程，捕获异常返回 null。
 */
async function safeRun(subprocess: SubprocessService, argv: string[]): Promise<string | null> {
  try {
    const handle = subprocess.spawn({
      argv,
      cwd: process.env.DSH_HOME ?? process.cwd(),
      stdio: { stdin: 'ignore', stdout: { maxBytes: 1 << 20 }, stderr: { maxBytes: 1 << 20 } },
      graceMs: 15000,
    })
    const outcome = await handle.done
    if (outcome.exitCode !== 0) return null
    const stdout = handle.collected.stdout
    if (!stdout) return null
    const chunks: string[] = []
    let offset = 0
    while (true) {
      const read = await stdout.readFrom(offset)
      if (read.text) {
        chunks.push(read.text)
        offset = read.nextOffset
      }
      if (!read.lossy && read.nextOffset <= offset) break
    }
    return chunks.join('')
  } catch {
    return null
  }
}
