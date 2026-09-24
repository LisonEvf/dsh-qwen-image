import type { Runtime } from '../service'
import { sanitizeToolOutput } from './lossless'
import { expandHome } from '../paths'
import {
  FIRST_STEP_SEC,
  PRESETS,
  RATIOS,
  describeEstimate,
  formatDuration,
  presetSeconds,
  presetSummary,
} from '../speed-profile'
import type { SavedImage, WorkerClient } from '../client-http'

/**
 * image_generate（§5.1）：对话生图。
 *
 * 实际路径：宿主 → worker /generate 入队 → 轮询进度 → 落盘 → 注入 attachments。
 * 长任务（native 档位）建议 mode=background，走 ctx.jobs。
 */

export function buildGenerateTool(rt: Runtime) {
  const { config, manager, registry } = rt

  return {
    name: 'image_generate',
    description:
      '用 Qwen-Image-2.1 生图。' +
      '【使用方式】用户给的通常只是意图（如「画只戴墨镜的柴犬」），请**先按提示词工艺扩写成完整描述**' +
      '（主体细节 → 场景 → 风格 → 光照 → 构图 → 画质），再把扩写结果作为 prompt 传入，' +
      '并在回复里贴出最终 prompt 让用户可纠正；不要直接把用户原话塞进来。' +
      '【档位】未指定时先用 draft 出草稿对齐，用户满意后再用 standard 定稿；native 务必配 mode=background。' +
      `本机 P40 实测：${presetSummary()}，每张图另含约 ${FIRST_STEP_SEC} 秒冷启动（每图重付）。` +
      '动手前请先告知预计耗时。',
    parameters: {
      prompt: {
        type: 'string',
        required: true,
        description:
          '**已扩写好的**完整生图提示词（不是用户原话）。建议含主体细节、场景、风格、光照、构图、画质。中文/英文均可。',
      },
      preset: {
        type: 'string',
        description:
          `尺寸预设：draft(768²,12步,约${formatDuration(presetSeconds(PRESETS.draft))}) | ` +
          `standard(1024²,24步,约${formatDuration(presetSeconds(PRESETS.standard))}) | ` +
          `native(2048²,40步,约${formatDuration(presetSeconds(PRESETS.native))})。与 width/height/ratio 互斥。`,
        enum: ['draft', 'standard', 'native', 'custom'],
      },
      width: { type: 'number', description: '宽度（像素，会向下对齐到 32 的倍数）。' },
      height: { type: 'number', description: '高度（像素）。' },
      ratio: {
        type: 'string',
        description: '目标比例（按官方比例表取 2K 尺寸）：1:1 | 4:3 | 3:4 | 3:2 | 2:3 | 16:9 | 9:16。',
        enum: ['1:1', '4:3', '3:4', '3:2', '2:3', '16:9', '9:16'],
      },
      steps: { type: 'number', description: '推理步数，覆盖 preset 默认。' },
      seed: { type: 'number', description: '随机种子，缺省随机。' },
      transparent: { type: 'boolean', description: '是否输出原生 RGBA（自动套用官方 RGBA 提示词模板）。' },
      count: {
        type: 'number',
        // ⚠️ 参数 DSL **不支持** minimum/maximum（实测官方白名单：type/description/
        // required/enum/default/examples/title/items/additionalProperties/oneOf）。
        // 故范围写进描述，并在 execute 内强制校验（越界即抛可操作错误）。
        description: '生成张数，取值 1..4。注意每张都要重付约 85 秒冷启动。',
      },
      negativePrompt: { type: 'string', description: '负面提示词（仅当 trueCfgScale > 1 时生效）。' },
      trueCfgScale: { type: 'number', description: 'CFG 强度，默认 1.0（模型设计为无引导采样）。>1 才启用 negativePrompt。' },
      mode: {
        type: 'string',
        description: 'wait=阻塞等待（默认）| background=后台任务，立即返回 jobId。',
        enum: ['wait', 'background'],
      },
      reference: {
        type: 'string',
        description:
          "风格/主体参考图：'latest'=最近生成的图 | imageId。会作为条件图传入。" +
          '用户说「照刚才那张的风格再画一张」时用它（注意：这是**参考**，不是改那张图；要改那张用 image_edit）。',
      },
    },
    timeoutMs: config.toolTimeoutMs,
    output: {
      schema: {
        type: 'object',
        // 每个 object 节点必须显式声明 additionalProperties（实测硬规则）。
        // 用 true 保持宽容：可选/条件字段（note/jobId/preset 等）会按情形缺省。
        additionalProperties: true,
        properties: {
          ids: { type: 'array', items: { type: 'string' } },
          files: { type: 'array', items: { type: 'string' } },
          width: { type: 'integer' },
          height: { type: 'integer' },
          seed: { type: 'integer' },
          steps: { type: 'integer' },
          preset: { type: 'string' },
          elapsedSec: { type: 'number' },
          steadyStepSec: { type: 'number' },
          peakVramMiB: { type: 'integer' },
          hasAlpha: { type: 'boolean' },
          device: { type: 'string' },
          dtype: { type: 'string' },
          count: { type: 'integer' },
          estimateText: { type: 'string' },
          jobId: { type: 'string' },
          workerJobId: { type: 'string' },
          status: { type: 'string' },
          note: { type: 'string' },
        },
      },
      render: (_args: unknown, value: Record<string, unknown>) => [{ type: 'text', text: formatGenerateText(value) }],
      presentationMeta: (_args: unknown, value: Record<string, unknown>) => ({
        ids: value.ids ?? [],
        width: value.width,
        height: value.height,
        seed: value.seed,
        steps: value.steps,
        preset: value.preset,
        elapsedSec: value.elapsedSec,
        hasAlpha: value.hasAlpha,
      }),
    },

    async execute(args: {
      prompt: string
      preset?: string
      width?: number
      height?: number
      ratio?: string
      steps?: number
      seed?: number
      transparent?: boolean
      count?: number
      negativePrompt?: string
      trueCfgScale?: number
      mode?: string
      reference?: string
    }) {
      // 必经 sanitize：DSH 侧对 undefined/NaN 的 fail-closed 校验会让整个工具失败
      return sanitizeToolOutput(await runGenerate(rt, args)) as never
    },
  }
}

async function runGenerate(
  rt: Runtime,
  args: {
    prompt: string
    preset?: string
    width?: number
    height?: number
    ratio?: string
    steps?: number
    seed?: number
    transparent?: boolean
    count?: number
    negativePrompt?: string
    trueCfgScale?: number
    mode?: string
    reference?: string
  },
) {
  const { config, manager, registry } = rt
  // ---- 参数解析与校验 ----
  const resolved = resolveSize(args, config)
  const count = args.count ?? 1
  if (count < 1 || count > 4) throw new Error('count 必须在 1..4 之间')

  // 参考图
  let images: string[] = []
  if (args.reference) {
    const rec = registry.get(args.reference)
    if (!rec) throw new Error(`找不到参考图：${args.reference}（可用 image_status 或画室查看已有 id）`)
    images = [rec.file]
  }

  const warm = (await manager.tryHealth())?.state === 'ready'
  const est = describeEstimate(resolved.steps, resolved.width, resolved.height, {
    loaded: warm,
    firstAfterLoad: warm && manager.isFirstInferenceAfterLoad(),
  })

  // 输入尺寸与像素校验
  if (resolved.width * resolved.height > config.maxPixels * 4) {
    throw new Error(
      `尺寸 ${resolved.width}×${resolved.height} 过大。maxPixels 配置为 ${config.maxPixels}；` +
        `如需 2K 请用 preset=native，或调大 maxPixels。`,
    )
  }

  if (args.mode === 'background') {
    return await runBackground(rt, { ...args, ...resolved, images, count, estimateText: est.text })
  }

  return await runForeground(rt, { ...args, ...resolved, images, count, estimateText: est.text })
}

/** 尺寸/步数解析：preset | width/height | ratio 三选一，含交集校验。 */function resolveSize(
  args: { preset?: string; width?: number; height?: number; ratio?: string; steps?: number },
  config: Runtime['config'],
): { width: number; height: number; steps: number; preset: string } {
  const explicit = args.width || args.height
  const wantsPreset = !!args.preset && args.preset !== 'custom'

  if (wantsPreset && (explicit || args.ratio)) {
    throw new Error('preset 与 width/height/ratio 互斥，请只选一种尺寸指定方式。')
  }
  if (explicit && args.ratio) {
    throw new Error('width/height 与 ratio 互斥。')
  }
  if (args.preset === 'custom' && !explicit) {
    throw new Error('preset=custom 必须同时提供 width 和 height。')
  }
  if (explicit && (!args.width || !args.height)) {
    throw new Error('width 与 height 必须同时提供。')
  }

  if (wantsPreset) {
    const p = PRESETS[args.preset as 'draft' | 'standard' | 'native']
    return { width: p.width, height: p.height, steps: args.steps ?? p.steps, preset: p.name }
  }
  if (args.ratio) {
    const r = RATIOS[args.ratio]
    if (!r) throw new Error(`未知比例：${args.ratio}`)
    return { width: r.width, height: r.height, steps: args.steps ?? PRESETS.native.steps, preset: `ratio:${args.ratio}` }
  }
  if (explicit) {
    return { width: args.width!, height: args.height!, steps: args.steps ?? config.defaultSteps, preset: 'custom' }
  }
  const p = PRESETS[config.preset as 'draft' | 'standard' | 'native'] ?? PRESETS.standard
  return { width: p.width, height: p.height, steps: args.steps ?? p.steps, preset: p.name }
}

interface RunArgs {
  prompt: string
  width: number
  height: number
  steps: number
  preset: string
  seed?: number
  transparent?: boolean
  count: number
  negativePrompt?: string
  trueCfgScale?: number
  images: string[]
  estimateText: string
}

async function runForeground(rt: Runtime, a: RunArgs): Promise<Record<string, unknown>> {
  const { manager, registry } = rt
  const client = await manager.ensureStarted()
  await ensureLoaded(client, rt)
  manager.touch()

  const { jobId } = await client.generate({
    prompt: a.prompt,
    width: a.width,
    height: a.height,
    steps: a.steps,
    seed: a.seed,
    count: a.count,
    transparent: !!a.transparent,
    negativePrompt: a.negativePrompt,
    trueCfgScale: a.trueCfgScale,
    images: a.images,
  })

  const result = await client.waitForJob(jobId, { timeoutMs: rt.config.toolTimeoutMs })
  manager.touch()
  manager.markInference()
  return await finalize(rt, result.images, {
    prompt: a.prompt,
    kind: 'generate',
    seed: result.seed,
    steps: result.steps,
    elapsedSec: result.elapsedSec,
    steadyStepSec: result.steadyStepSec,
    peakVramMiB: result.peakVramMiB,
    device: result.device,
    dtype: result.dtype,
    preset: a.preset,
    estimateText: a.estimateText,
    usedReferences: result.usedReferences,
  })
}

async function runBackground(rt: Runtime, a: RunArgs): Promise<Record<string, unknown>> {
  const { manager } = rt
  const client = await manager.ensureStarted()
  await ensureLoaded(client, rt)

  const { jobId } = await client.generate({
    prompt: a.prompt,
    width: a.width,
    height: a.height,
    steps: a.steps,
    seed: a.seed,
    count: a.count,
    transparent: !!a.transparent,
    negativePrompt: a.negativePrompt,
    trueCfgScale: a.trueCfgScale,
    images: a.images,
  })
  manager.touch()

  // 宿主侧注册一个后台任务，让 job_output 能读到进度
  const jobs = rt.ctx.get('jobs') as
    | {
        start(spec: {
          kind: string
          label: string
          owner?: unknown
          run(): {
            cancel(reason?: string): void
            done: Promise<{ status: string; detail?: string; output?: string }>
            readOutput?(): string
          }
        }): string
      }
    | undefined

  if (!jobs) {
    return await awaitJobAndFinalize(rt, client, jobId, a, 'jobs 服务不可用，已退化为前台等待')
  }

  let lastText = `已提交后台任务（worker jobId=${jobId}），${a.estimateText}`
  const owner = (rt.ctx as unknown as { agent?: unknown }).agent
  let hostJobId: string
  try {
    hostJobId = jobs.start({
      kind: 'qwen-image',
      label: `生图 ${a.width}×${a.height} ${a.steps}步`,
      owner,
      run() {
        let settled = false
        const done = (async () => {
          try {
            const result = await client.waitForJob(jobId, {
              timeoutMs: rt.config.toolTimeoutMs,
              onProgress: (p) => {
                lastText = `进度 ${p.step}/${p.total}，已用 ${Math.round(p.elapsedMs / 1000)}s` +
                  (p.etaMs ? `，预计剩余 ${formatDuration(p.etaMs / 1000)}` : '')
              },
            })
            settled = true
            const value = await finalize(rt, result.images, {
              prompt: a.prompt,
              kind: 'generate',
              seed: result.seed,
              steps: result.steps,
              elapsedSec: result.elapsedSec,
              steadyStepSec: result.steadyStepSec,
              peakVramMiB: result.peakVramMiB,
              device: result.device,
              dtype: result.dtype,
              preset: a.preset,
              estimateText: a.estimateText,
            })
            return {
              status: 'completed' as const,
              output: JSON.stringify({ id: value.ids, file: value.files, elapsedSec: value.elapsedSec }),
            }
          } catch (err) {
            settled = true
            return { status: 'failed' as const, detail: (err as Error).message }
          }
        })()

        return {
          cancel() {
            client.cancel(jobId).catch(() => {})
          },
          done,
          readOutput() {
            return settled ? '' : lastText
          },
        }
      },
    })
  } catch (err) {
    // ⚠️ 实测教训（2026-09-23）：`dsh-jobs-local.start()` 会因为 owner 不被它服务而抛
    // 「background jobs unavailable: no job controller serves this agent」。
    // 而**图已经在 worker 里跑了** —— 旧代码在这里直接抛出，于是：调用报失败、
    // GPU 却把图跑完、产物还没有注册记录（孤儿图，相册里永远看不到）。
    // 所以登记失败必须降级为前台等待：把已经在跑的任务等回来并正常入库。
    return await awaitJobAndFinalize(
      rt,
      client,
      jobId,
      a,
      `后台任务登记失败（${(err as Error).message}），已退化为前台等待`,
    )
  }

  return {
    status: 'background',
    jobId: hostJobId,
    workerJobId: jobId,
    ids: [],
    files: [],
    width: a.width,
    height: a.height,
    steps: a.steps,
    preset: a.preset,
    estimateText: a.estimateText,
    note: `已加入后台任务 ${hostJobId}。用 job_output 读取结果；完成后会收到通知。`,
  }
}

/**
 * 前台等待**已经入队**的 worker 任务并入库。
 *
 * ⚠️ 与上面的 `runForeground(rt, a)` 区分：那个会自己入队（wait 档位的正常路径），
 * 这个只负责「已经入队的任务别再丢」。名字必须不同 —— 本文件一开始就有
 * `runForeground`，我第一次把新助手也取成同名，函数声明提升让后者覆盖前者，
 * 直接把 wait 档位打成了 `client.waitForJob is not a function`（冒烟当场抓到）。
 */
async function awaitJobAndFinalize(
  rt: Runtime,
  client: WorkerClient,
  jobId: string,
  a: RunArgs,
  note: string,
): Promise<Record<string, unknown>> {
  const result = await client.waitForJob(jobId, { timeoutMs: rt.config.toolTimeoutMs })
  return await finalize(rt, result.images, {
    prompt: a.prompt,
    kind: 'generate',
    seed: result.seed,
    steps: result.steps,
    elapsedSec: result.elapsedSec,
    steadyStepSec: result.steadyStepSec,
    peakVramMiB: result.peakVramMiB,
    device: result.device,
    dtype: result.dtype,
    preset: a.preset,
    estimateText: a.estimateText,
    note,
  })
}

/** 确保模型已加载（懒加载）。 */
async function ensureLoaded(client: WorkerClient, rt: Runtime): Promise<void> {
  const h = await client.health()
  if (h.state === 'ready') return
  if (h.state === 'loading') return
  await client.load({
    modelDir: expandHome(rt.config.modelDir),
    device: rt.config.device,
    dtype: rt.config.dtype,
    offload: rt.config.offload,
    vaeTiling: true,
    minFreeMiB: rt.config.lowVramGuardMiB,
  })
  // 记录「刚加载」——下一张图要付换入代价
  rt.manager.markLoaded()
}

/** 落库 + 注入附件，组装规范返回值。 */
async function finalize(
  rt: Runtime,
  images: SavedImage[],
  meta: {
    prompt: string
    kind: 'generate' | 'edit'
    seed: number
    steps: number
    elapsedSec: number
    steadyStepSec?: number | null
    peakVramMiB?: number | null
    device?: string
    dtype?: string
    preset?: string
    estimateText: string
    usedReferences?: number
    note?: string
    inputImage?: string
  },
): Promise<Record<string, unknown>> {
  const records = await rt.registry.addAll(images, {
    seed: meta.seed,
    steps: meta.steps,
    prompt: meta.prompt,
    kind: meta.kind,
    elapsedSec: meta.elapsedSec,
    steadyStepSec: meta.steadyStepSec,
    peakVramMiB: meta.peakVramMiB,
    device: meta.device,
    dtype: meta.dtype,
    inputImage: meta.inputImage,
    usedReferences: meta.usedReferences,
  })
  await rt.registry.attachImages(records)

  const first = records[0]
  return {
    ids: records.map((r) => r.id),
    files: records.map((r) => r.file),
    width: first?.width,
    height: first?.height,
    seed: meta.seed,
    steps: meta.steps,
    preset: meta.preset,
    elapsedSec: meta.elapsedSec,
    steadyStepSec: meta.steadyStepSec ?? undefined,
    peakVramMiB: meta.peakVramMiB ?? undefined,
    hasAlpha: first?.hasAlpha ?? false,
    device: meta.device,
    dtype: meta.dtype,
    count: records.length,
    estimateText: meta.estimateText,
    status: 'completed',
    note: meta.note,
  }
}

function formatGenerateText(v: Record<string, unknown>): string {
  const ids = (v.ids as string[]) ?? []
  const files = (v.files as string[]) ?? []
  const lines: string[] = []

  if (v.status === 'background') {
    lines.push(`已提交后台任务：${v.jobId}`)
    lines.push(`参数：${v.width}×${v.height}，${v.steps} 步，预设 ${v.preset}`)
    if (v.estimateText) lines.push(String(v.estimateText))
    lines.push('用 job_output 读取进度与结果；完成后会收到通知。')
    return lines.join('\n')
  }

  lines.push(`✅ 生成完成：${ids.length} 张`)
  lines.push(`尺寸 ${v.width}×${v.height}｜步数 ${v.steps}｜seed ${v.seed}${v.hasAlpha ? '｜RGBA 透明' : '｜RGB'}`)
  lines.push(`耗时 ${formatDuration(Number(v.elapsedSec) || 0)}｜每步约 ${v.steadyStepSec ?? '?'}s｜峰值显存 ${v.peakVramMiB ?? '?'}MiB`)
  if (v.device || v.dtype) lines.push(`设备 ${v.device ?? '?'}／精度 ${v.dtype ?? '?'}`)
  lines.push('')
  for (let i = 0; i < ids.length; i++) {
    lines.push(`图像 ${i + 1}：id=${ids[i]}`)
    lines.push(`  文件：${files[i]}`)
  }
  lines.push('')
  lines.push(`（提示：界面卡片会内联显示图片；也可用 image_edit 传 image='${ids[0] ?? 'latest'}' 继续改这张图。）`)
  return lines.join('\n')
}

