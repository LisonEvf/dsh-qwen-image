import type { Runtime } from '../service'
import { sanitizeToolOutput } from './lossless'
import { expandHome } from '../paths'
import { PRESETS, RATIOS, describeEstimate, formatDuration } from '../speed-profile'

/**
 * image_edit（§5.2）：对话改图。
 *
 * ⚠️ 重要实现约束（读 diffusers 源码确认）：
 * QwenImage21Pipeline **没有独立的 mask 参数**。局部编辑的正规路径是
 * 「在图上画圆圈/涂抹标注，把标注后的图作为条件图传入」。
 * 因此本工具把独立 mask 交给 worker 合成为红色半透明标注后并入条件图，
 * 而不是传 mask 张量。capabilities.supports.mask=false、maskViaAnnotation=true。
 */

export function buildEditTool(rt: Runtime) {
  const { config, manager, registry } = rt

  return {
    name: 'image_edit',
    description:
      '改图：在已有图像上按文本指令修改（换背景、改风格、增删/替换物体、局部编辑）。最多 10 张条件图。' +
      '【选输入图】用户说「刚才那张 / 上一张 / 这张」→ image=\'latest\'；' +
      "说「有猫的那张」这类**描述性指代** → 先调 image_result id='list'，按返回的 prompt 匹配出 id 再传进来；" +
      '找不到匹配就把已有作品列表给他挑，**不要瞎猜一张改掉**。' +
      '改图会**新增**一张、原图保留，记得把新旧 id 都告诉他。' +
      '【提示词】同样要先按意图扩写成明确指令（改什么、改成什么、其余保持什么不变），不要直接传用户原话。' +
      '【限制】Qwen-Image-2.1 **没有独立 mask 张量**：mask 会按官方「涂抹标注」语义叠加到输入图上，' +
      '它划的是大致区域而非像素级遮罩 —— 精确控制要靠把指令写具体。',
    parameters: {
      prompt: {
        type: 'string',
        required: true,
        description:
          '**已扩写好的**修改指令（不是用户原话）。写清改什么、改成什么、其余保持什么不变，如「把背景换成黄昏海滩，保留柴犬的姿态与毛色，暖调逆光」。',
      },
      image: {
        type: 'string',
        required: true,
        description:
          "输入图像：'latest'（最近生成的那张，对应「刚才那张」）| imageId | 绝对文件路径。" +
          "描述性指代请先用 image_result id='list' 匹配出 id，不要猜。",
      },
      images: {
        type: 'array',
        items: { type: 'string' },
        description: `额外参考图（imageId 或路径），与主图合计 ≤ ${config.maxReferenceImages} 张。`,
      },
      mask: {
        type: 'string',
        description: '独立 mask 图像路径（白色=需修改区域）。会按官方涂抹标注语义叠加到输入图。',
      },
      preset: { type: 'string', description: '尺寸预设：draft | standard | native。缺省沿用配置。', enum: ['draft', 'standard', 'native'] },
      width: { type: 'number', description: '输出宽度（像素）。' },
      height: { type: 'number', description: '输出高度（像素）。' },
      ratio: { type: 'string', description: '输出比例。', enum: ['1:1', '4:3', '3:4', '3:2', '2:3', '16:9', '9:16'] },
      steps: { type: 'number', description: '推理步数。' },
      seed: { type: 'number', description: '随机种子。' },
      transparent: { type: 'boolean', description: '是否输出原生 RGBA。' },
      count: {
        type: 'number',
        // 参数 DSL 不支持 minimum/maximum（实测白名单），范围写描述 + execute 内强制校验
        description: '生成张数，取值 1..4。',
      },
      negativePrompt: { type: 'string', description: '负面提示词（仅当 trueCfgScale > 1 时生效）。' },
      trueCfgScale: { type: 'number', description: 'CFG 强度，默认 1.0。' },
      mode: { type: 'string', description: 'wait | background。', enum: ['wait', 'background'] },
    },
    timeoutMs: config.toolTimeoutMs,
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ids: { type: 'array', items: { type: 'string' } },
          files: { type: 'array', items: { type: 'string' } },
          inputImage: { type: 'string' },
          usedReferences: { type: 'integer' },
          width: { type: 'integer' },
          height: { type: 'integer' },
          seed: { type: 'integer' },
          steps: { type: 'integer' },
          elapsedSec: { type: 'number' },
          peakVramMiB: { type: 'integer' },
          hasAlpha: { type: 'boolean' },
          device: { type: 'string' },
          dtype: { type: 'string' },
          estimateText: { type: 'string' },
          status: { type: 'string' },
          note: { type: 'string' },
          maskMode: { type: 'string' },
        },
      },
      render: (_args: unknown, value: Record<string, unknown>) => [{ type: 'text', text: formatEditText(value) }],
      presentationMeta: (_args: unknown, value: Record<string, unknown>) => ({
        ids: value.ids ?? [],
        width: value.width,
        height: value.height,
        seed: value.seed,
        steps: value.steps,
        inputImage: value.inputImage,
        elapsedSec: value.elapsedSec,
      }),
    },

    async execute(args: {
      prompt: string
      image: string
      images?: string[]
      mask?: string
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
    }) {
      // 必经 sanitize：DSH 侧对 undefined/NaN 的 fail-closed 校验会让整个工具失败
      return sanitizeToolOutput(await runEdit(rt, args)) as never
    },
  }
}

async function runEdit(
  rt: Runtime,
  args: {
    prompt: string
    image: string
    images?: string[]
    mask?: string
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
  },
) {
  const { config, manager, registry } = rt
  if (!args.prompt?.trim()) throw new Error('image_edit 需要 prompt。')

      // 解析输入图
      const inputPath = resolveImagePath(registry, args.image)
      const extra = (args.images ?? []).map((s) => resolveImagePath(registry, s))
      const allImages = [inputPath, ...extra]

      if (allImages.length > config.maxReferenceImages) {
        throw new Error(`条件图数量 ${allImages.length} 超过上限 ${config.maxReferenceImages}。`)
      }

      // 尺寸
      const size = resolveEditSize(args, config)
      const count = args.count ?? 1
      if (count < 1 || count > 4) throw new Error('count 必须在 1..4 之间。')

      const warm = (await manager.tryHealth())?.state === 'ready'
      const est = describeEstimate(size.steps, size.width, size.height, {
        loaded: warm,
        firstAfterLoad: warm && manager.isFirstInferenceAfterLoad(),
      })

      const client = await manager.ensureStarted()
      const h = await client.health()
      if (h.state !== 'ready') {
        await client.load({
          modelDir: expandHome(config.modelDir),
          device: config.device,
          dtype: config.dtype,
          offload: config.offload,
          vaeTiling: true,
          minFreeMiB: config.lowVramGuardMiB,
        })
        manager.markLoaded()
      }

      const payload: Record<string, unknown> = {
        prompt: args.prompt,
        images: allImages,
        width: size.width,
        height: size.height,
        steps: size.steps,
        seed: args.seed,
        count,
        transparent: !!args.transparent,
        negativePrompt: args.negativePrompt,
        trueCfgScale: args.trueCfgScale,
      }
      if (args.mask) payload.mask = args.mask

      const submitted = await client.edit(payload)
      manager.touch()
      const result = await client.waitForJob(submitted.jobId, { timeoutMs: config.toolTimeoutMs })
      manager.touch()
      manager.markInference()

      const records = await registry.addAll(result.images, {
        seed: result.seed,
        steps: result.steps,
        prompt: args.prompt,
        kind: 'edit',
        elapsedSec: result.elapsedSec,
        steadyStepSec: result.steadyStepSec,
        peakVramMiB: result.peakVramMiB,
        device: result.device,
        dtype: result.dtype,
        inputImage: inputPath,
        usedReferences: result.usedReferences,
      })
      await registry.attachImages(records)
      const first = records[0]

      return {
        ids: records.map((r) => r.id),
        files: records.map((r) => r.file),
        inputImage: inputPath,
        usedReferences: result.usedReferences,
        width: first?.width,
        height: first?.height,
        seed: result.seed,
        steps: result.steps,
        elapsedSec: result.elapsedSec,
        peakVramMiB: result.peakVramMiB ?? undefined,
        hasAlpha: first?.hasAlpha ?? false,
        device: result.device,
        dtype: result.dtype,
        estimateText: est.text,
        status: 'completed',
        maskMode: args.mask ? 'annotation-overlay' : 'none',
        note: args.mask
          ? 'mask 已按官方「涂抹标注」语义叠加为红色半透明标注后作为条件图传入（QwenImage21Pipeline 无独立 mask 参数）。'
          : undefined,
      }
}

/** 把 imageId / 'latest' / 路径解析成绝对路径。 */
function resolveImagePath(registry: Runtime['registry'], ref: string): string {
  if (ref === 'latest') {
    const rec = registry.latest()
    if (!rec) throw new Error('还没有任何生成记录，无法使用 latest。请先用 image_generate。')
    return rec.file
  }
  const rec = registry.get(ref)
  if (rec) return rec.file
  // 当作路径
  if (ref.includes('/') || ref.includes('\\')) return expandHome(ref)
  throw new Error(`无法解析图像引用：${ref}。请传 imageId、'latest' 或绝对路径。`)
}

function resolveEditSize(
  args: { preset?: string; width?: number; height?: number; ratio?: string; steps?: number },
  config: Runtime['config'],
): { width: number; height: number; steps: number } {
  if (args.preset) {
    const p = PRESETS[args.preset as 'draft' | 'standard' | 'native']
    if (p) return { width: p.width, height: p.height, steps: args.steps ?? p.steps }
  }
  if (args.ratio) {
    const r = RATIOS[args.ratio]
    if (r) return { width: r.width, height: r.height, steps: args.steps ?? PRESETS.native.steps }
  }
  if (args.width && args.height) {
    return { width: args.width, height: args.height, steps: args.steps ?? config.defaultSteps }
  }
  const p = PRESETS[config.preset as 'draft' | 'standard' | 'native'] ?? PRESETS.standard
  return { width: p.width, height: p.height, steps: args.steps ?? p.steps }
}

function formatEditText(v: Record<string, unknown>): string {
  const ids = (v.ids as string[]) ?? []
  const files = (v.files as string[]) ?? []
  const lines: string[] = []
  lines.push(`✅ 改图完成：${ids.length} 张`)
  lines.push(`输入图：${v.inputImage}`)
  lines.push(`输出 ${v.width}×${v.height}｜步数 ${v.steps}｜seed ${v.seed}${v.hasAlpha ? '｜RGBA' : '｜RGB'}`)
  lines.push(`耗时 ${formatDuration(Number(v.elapsedSec) || 0)}｜峰值显存 ${v.peakVramMiB ?? '?'}MiB`)
  if (v.usedReferences) lines.push(`使用条件图 ${v.usedReferences} 张`)
  lines.push('')
  for (let i = 0; i < ids.length; i++) {
    lines.push(`图像 ${i + 1}：id=${ids[i]}`)
    lines.push(`  文件：${files[i]}`)
  }
  if (v.note) lines.push(`\n注：${v.note}`)
  return lines.join('\n')
}

