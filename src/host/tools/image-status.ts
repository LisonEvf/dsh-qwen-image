import type { Runtime } from '../service'
import { inspectComponent, type InspectResult, type ComponentReport } from '../model-inspect'
import { collectEnv, pickFreeGpu, recommendDtype, recommendOffload, type EnvProbe } from '../env-probe'
import { PRESETS, FIRST_STEP_RANGE, FIRST_STEP_SEC, LOAD_SEC_RANGE, formatDuration, presetSeconds, steadyStepSec, vaeDecodeSec } from '../speed-profile'
import { sanitizeToolOutput } from './lossless'
import { expandHome } from '../paths'

/**
 * image_status（§5.3）：体检 + 指引，**永不失败**。
 *
 * 权重：逐组件核对存在性、分片齐全性、index 一致性 → ok | partial | missing
 * 环境：python / torch / transformers / diffusers 版本、CUDA、各 GPU 空闲显存
 * worker：未启动 / 加载中 / ready / 出错（带最近日志）
 * 缺失时给出可直接复制的命令（§8）
 * 并附带**本机实测标定的各档位预计耗时**，让用户按需选择。
 */

const COMPONENTS: Array<{ name: string; dir: string; shards: string[]; index?: string }> = [
  { name: 'processor', dir: 'processor', shards: [] },
  { name: 'scheduler', dir: 'scheduler', shards: [] },
  {
    name: 'text_encoder',
    dir: 'text_encoder',
    shards: [
      'model-00001-of-00004.safetensors',
      'model-00002-of-00004.safetensors',
      'model-00003-of-00004.safetensors',
      'model-00004-of-00004.safetensors',
    ],
    index: 'model.safetensors.index.json',
  },
  {
    name: 'transformer',
    dir: 'transformer',
    shards: [
      'diffusion_pytorch_model-00001-of-00002.safetensors',
      'diffusion_pytorch_model-00002-of-00002.safetensors',
    ],
    index: 'diffusion_pytorch_model.index.json',
  },
  { name: 'vae', dir: 'vae', shards: [] },
]

/** 构建标记：注入到工具描述里，用来确认宿主实际加载的是哪一次构建。 */
export const BUILD_TAG = 'BUILD-2026-09-22T02:30+08:00'

export function buildStatusTool(rt: Runtime) {
  const { config } = rt

  return {
    name: 'image_status',
    description: `体检 Qwen-Image-2.1 权重目录、运行环境与 worker 状态，给出缺件清单与可直接复制的下载/安装命令。永不失败——缺啥就说啥。【构建标记 ${BUILD_TAG}】`,
    parameters: {
      refresh: { type: 'boolean', description: '强制重建 worker 快照（默认 false，用缓存）。' },
    },
    timeoutMs: 120000,
    output: {
      schema: {
        type: 'object',
        // 每个 object 节点（含数组 items 内的）都必须显式声明 additionalProperties
        additionalProperties: true,
        properties: {
          modelDir: { type: 'string' },
          modelState: { type: 'string' },
          components: { type: 'array', items: { type: 'object', additionalProperties: true } },
          missing: { type: 'array', items: { type: 'string' } },
          totalBytes: { type: 'integer' },
          env: { type: 'object', additionalProperties: true },
          worker: { type: 'object', additionalProperties: true },
          presets: { type: 'array', items: { type: 'object', additionalProperties: true } },
          galleryCount: { type: 'integer' },
          guidance: { type: 'array', items: { type: 'string' } },
          commands: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args: unknown, value: Record<string, unknown>) => [{ type: 'text', text: formatStatusText(value) }],
    },
    async execute(_args: { refresh?: boolean }) {
      // 必经 sanitize：DSH 侧对 undefined/NaN/非普通原型 的 fail-closed 校验会让整个工具失败
      return sanitizeToolOutput(await runStatus(rt))
    },
  }
}

export async function runStatus(rt: Runtime): Promise<Record<string, unknown>> {
  const { ctx, config, manager, registry } = rt
  const modelDir = expandHome(config.modelDir)

  const result: InspectResult = {
    modelDir,
    exists: false,
    state: 'missing',
    components: [],
    missing: [],
    guidance: [],
    commands: [],
  }

  // 1. 权重体检（永不抛）
  try {
    const exists = await dirExists(ctx, modelDir)
    result.exists = exists
    if (exists) {
      const reports: ComponentReport[] = []
      for (const comp of COMPONENTS) {
        reports.push(await inspectComponent(ctx, modelDir, comp.dir, comp.shards, comp.index))
      }
      result.components = reports
      const hasMissing = reports.some((c) => c.state === 'missing')
      const hasPartial = reports.some((c) => c.state === 'partial')
      result.state = hasMissing ? 'missing' : hasPartial ? 'partial' : 'ok'
      result.missing = reports.flatMap((c) => c.missingFiles)
      result.totalBytes = reports.reduce((s, c) => s + (c.bytes ?? 0), 0)
    }
  } catch (err) {
    result.state = 'missing'
    result.missing = [`体检异常：${(err as Error).message}`]
  }

  // 2. 环境探测（永不抛）
  let env: EnvProbe
  try {
    env = await collectEnv(ctx, config)
  } catch (err) {
    env = {
      error: (err as Error).message,
      pythonExe: null,
      pythonVersion: null,
      torch: null,
      transformers: null,
      diffusers: null,
      cudaAvailable: null,
      gpus: [],
    }
  }

  // 3. 推荐（基于实测标定）
  const freeGpu = pickFreeGpu(env.gpus)
  if (freeGpu) {
    env.recommendedDevice = `cuda:${freeGpu.index}`
    env.recommendedDtype = recommendDtype(6) // P40 sm_61 保守值；实际由 worker 按卡决策
    env.recommendedOffload = recommendOffload(freeGpu.freeMiB)
  }

  // 4. worker 状态
  const ms = manager.getStatus()
  const h = await manager.tryHealth()
  const worker = {
    managerState: ms.state,
    state: h?.state ?? (ms.state === 'stopped' ? 'not-started' : 'unknown'),
    pid: ms.pid,
    port: ms.port || undefined,
    device: h?.device,
    dtype: h?.dtype,
    offload: h?.offload,
    loadSec: h?.loadSec ?? undefined,
    warmed: h?.warmed,
    vram: h?.vram,
    queueDepth: h?.queueDepth,
    error: ms.error ?? h?.error ?? undefined,
    logs: h ? undefined : manager.getBootLog().split('\n').slice(-50),
  }

  // 5. 各档位预计耗时（本机实测标定，三段式模型）
  const presets = Object.values(PRESETS).map((p) => ({
    name: p.name,
    label: p.label,
    width: p.width,
    height: p.height,
    steps: p.steps,
    coldFirstStepSec: p.coldFirstStepSec,
    steadyStepSec: p.steadyStepSec,
    vaeDecodeSec: p.vaeDecodeSec,
    estimatedSec: presetSeconds(p),
    estimatedText: formatDuration(presetSeconds(p)),
  }))

  // 6. 指引与命令
  const guidance = buildGuidance(result, env, config.lowVramGuardMiB, worker.state)
  const commands = buildCommands(config, result)

  const galleryCount = registry.list(1000).length

  return {
    modelDir,
    modelState: result.state,
    components: result.components,
    missing: result.missing,
    totalBytes: result.totalBytes,
    env,
    worker,
    presets,
    galleryCount,
    guidance,
    commands,
  }
}

async function dirExists(ctx: Runtime['ctx'], dirAbs: string): Promise<boolean> {
  try {
    const fs = ctx.get('fs') as { resolve(p: string): Promise<unknown>; stat(t: unknown): Promise<{ type: string } | undefined> } | undefined
    if (!fs) return false
    const target = await fs.resolve(dirAbs)
    const info = await fs.stat(target)
    return !!info && info.type === 'directory'
  } catch {
    return false
  }
}

export function buildGuidance(
  result: InspectResult,
  env: EnvProbe,
  lowVramGuardMiB: number,
  workerState: string,
): string[] {
  const g: string[] = []

  if (!result.exists) {
    g.push(`权重目录不存在：${result.modelDir}`)
    g.push('请先下载权重（见下方命令），或把 modelDir 指向已有目录。')
  } else if (result.state === 'missing' || result.state === 'partial') {
    g.push(`权重不完整（${result.state}），缺 ${result.missing.length} 个文件。`)
    g.push('可只补缺失分片：`hf download <repo> --local-dir <dir> --include "<pattern>"`')
  } else {
    g.push('权重齐全 ✓')
  }

  if (env.diffusers === null) {
    g.push('⚠️ diffusers 未安装 —— QwenImage21Pipeline 需 diffusers 主分支（已实测 0.41.0.dev0 可用）。')
  }
  if (env.cudaAvailable === false) {
    g.push('⚠️ CUDA 不可用，将在 CPU 上推理（不可用级别的慢）。')
  }

  const freeGpu = pickFreeGpu(env.gpus)
  if (freeGpu && freeGpu.freeMiB < lowVramGuardMiB) {
    g.push(
      `⚠️ GPU${freeGpu.index} 空闲显存仅 ${Math.round(freeGpu.freeMiB / 1024)}GB，低于守卫阈值 ${lowVramGuardMiB}MiB。` +
        '建议停止占用进程（如 llama-server）后重试。',
    )
  }

  // 内存守卫。
  // 权重 30.86 GB 走 mmap 加载：**内存/提交空间不足时不报错，而是直接段错误
  // （0xC0000005）**，现场只有一句「进程崩了」，没有任何 Python traceback。
  // 本机实测踩过：一个残留 python 进程占着 65.7 GB 提交内存，
  // 此后每次加载模型都在去噪开始瞬间崩溃。所以在动手前就把这件事讲清楚。
  const mem = env.memory
  if (mem && mem.totalMiB > 0) {
    const availGB = mem.availableMiB / 1024
    const totalGB = mem.totalMiB / 1024
    const commitNote =
      mem.commitUsedMiB && mem.commitLimitMiB
        ? `当前已提交 ${(mem.commitUsedMiB / 1024).toFixed(1)}GB / 上限 ${(mem.commitLimitMiB / 1024).toFixed(1)}GB`
        : ''
    if (availGB < 20) {
      g.push(
        `🔴 可用内存仅 ${availGB.toFixed(1)}GB（总 ${totalGB.toFixed(1)}GB${commitNote ? '，' + commitNote : ''}）。` +
          '权重 30.86GB 走 mmap 加载，**内存不足会让进程直接崩溃（段错误）而不是给出清晰报错**。' +
          '请先释放内存：查有无残留 python 进程占着几十 GB（PowerShell：`Get-Process python | Select Id,PrivateMemorySize64`），' +
          '停掉后重试。',
      )
    } else if (availGB < 32) {
      g.push(
        `⚠️ 可用内存 ${availGB.toFixed(1)}GB（总 ${totalGB.toFixed(1)}GB）偏紧：` +
          '权重 30.86GB 加载时可能触及上限，失败表现是**段错误**而非清晰报错。' +
          '若生图突然全部失败且无 Python 报错，优先排查残留 python 进程。',
      )
    }
  }

  if (workerState === 'not-started') {
    g.push(`worker 未启动（懒启动：首次 image_generate 会自动拉起并加载模型，约 ${LOAD_SEC_RANGE[0]}–${LOAD_SEC_RANGE[1]} 秒）。`)
  } else if (workerState === 'ready') {
    g.push('worker 已就绪，可直接生图。')
  } else if (workerState === 'error') {
    g.push('⚠️ worker 处于错误状态，见上方 worker.error 与日志。')
  }

  g.push(
    `⏱ 本机 P40/fp16 实测（三段式）：首步冷启动约 ${FIRST_STEP_SEC}s` +
      `（实测区间 ${FIRST_STEP_RANGE[0]}–${FIRST_STEP_RANGE[1]}s，每图重付，受 32GB 内存限制权重无法常驻）` +
      ` + 稳态约 ${steadyStepSec(1024, 1024).toFixed(1)}s/步 @1024² + VAE 解码约 ${vaeDecodeSec(1024, 1024).toFixed(0)}s。` +
      `故 draft(768²/12步)≈${formatDuration(presetSeconds(PRESETS.draft))}、` +
      `standard(1024²/24步)≈${formatDuration(presetSeconds(PRESETS.standard))}、` +
      `native(2048²/40步)≈${formatDuration(presetSeconds(PRESETS.native))}。`,
  )
  return g
}

export function buildCommands(config: Runtime['config'], result: InspectResult): string[] {
  const commands: string[] = []
  const modelDir = expandHome(config.modelDir).replace(/\\/g, '/')

  commands.push(
    `# 1) 指向已有权重目录（改 profile 的 cordis.patch.yml）\n` +
      `# config:\n` +
      `#   modelDir: '${modelDir}'`,
  )

  const endpoint = config.hfEndpoint ? `$env:HF_ENDPOINT='${config.hfEndpoint}'\n` : ''
  commands.push(
    `# 2) 下载/补全权重（约 30.9GB / 27 文件）\n` +
      `${endpoint}hf download ${config.modelRepo} --local-dir '${modelDir}'`,
  )

  commands.push(
    `# 3) 安装 diffusers（已实测 0.41.0.dev0 含 QwenImage21Pipeline）\n` +
      `pip install git+https://github.com/huggingface/diffusers.git\n` +
      `pip install accelerate pillow`,
  )

  return commands
}

export function formatStatusText(value: Record<string, unknown>): string {
  const lines: string[] = []
  const env = (value.env ?? {}) as Record<string, unknown>
  const worker = (value.worker ?? {}) as Record<string, unknown>

  lines.push(`权重目录：${value.modelDir}`)
  lines.push(`权重状态：${value.modelState}${value.totalBytes ? `（${(Number(value.totalBytes) / 1e9).toFixed(2)} GB）` : ''}`)

  const comps = (value.components as Array<Record<string, unknown>>) ?? []
  for (const c of comps) {
    const miss = (c.missingFiles as string[]) ?? []
    const extra = c.note ? `（${c.note}）` : ''
    lines.push(`  • ${c.name}：${c.state}${miss.length ? ` — 缺 ${miss.join(', ')}` : ''}${extra}`)
  }
  const missing = (value.missing as string[]) ?? []
  if (missing.length) lines.push(`缺失：${missing.join(', ')}`)

  lines.push('')
  lines.push('环境：')
  if (env.pythonExe) lines.push(`  Python ${env.pythonVersion ?? '?'}（${env.pythonExe}）`)
  if (env.torch) lines.push(`  torch ${env.torch}（CUDA ${env.cudaVersion ?? '?'}）`)
  if (env.transformers) lines.push(`  transformers ${env.transformers}`)
  lines.push(`  diffusers ${env.diffusers ?? '未安装 ✗'}`)
  if (env.cudaAvailable !== null) lines.push(`  CUDA 可用：${env.cudaAvailable}`)

  const gpus = (env.gpus as Array<Record<string, number>>) ?? []
  for (const g of gpus) {
    lines.push(
      `  GPU${g.index}：空闲 ${(Number(g.freeMiB) / 1024).toFixed(1)}GB / ${(Number(g.totalMiB) / 1024).toFixed(1)}GB，利用率 ${g.utilizationPct}%`,
    )
  }

  lines.push('')
  lines.push('worker：')
  lines.push(`  管理器 ${worker.managerState ?? '?'}｜状态 ${worker.state ?? '?'}${worker.pid ? `｜pid ${worker.pid}` : ''}${worker.port ? `｜端口 ${worker.port}` : ''}`)
  if (worker.device) lines.push(`  设备 ${worker.device}／精度 ${worker.dtype}／offload ${worker.offload}`)
  if (worker.loadSec) lines.push(`  加载耗时 ${worker.loadSec}s`)
  if (worker.error) lines.push(`  ⚠️ ${worker.error}`)

  const presets = (value.presets as Array<Record<string, unknown>>) ?? []
  if (presets.length) {
    lines.push('')
    lines.push('档位预计耗时（本机 P40/fp16 实测标定）：')
    for (const p of presets) {
      lines.push(`  • ${p.label}：约 ${p.estimatedText}（${p.width}×${p.height}, ${p.steps} 步）`)
    }
  }

  const guidance = (value.guidance as string[]) ?? []
  if (guidance.length) {
    lines.push('')
    lines.push('建议：')
    for (const g of guidance) lines.push(`  - ${g}`)
  }

  const commands = (value.commands as string[]) ?? []
  if (commands.length) {
    lines.push('')
    lines.push('可直接复制的命令：')
    for (const c of commands) lines.push(`\`\`\`powershell\n${c}\n\`\`\``)
  }

  return lines.join('\n')
}