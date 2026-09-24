/**
 * M0 实测速度档案（speed profile）—— 全部来自逐点计时的真实 worker 路径。
 *
 * 证据：`acceptance/m0-preset-bench.log`、`acceptance/m0-single-standard.log`、
 *       `acceptance/m0-repeat-3.log`、`acceptance/m0-calib-fp16-model.log`
 * 环境：Tesla P40 (sm_61) / **fp16** / offload=model / vae tiling /
 *       diffusers 0.41.0.dev0 / torch 2.7.1+cu128 / 32GB RAM
 *
 * ══ 耗时模型（四段式，实测拟合）═══════════════════════════════════════
 *   total ≈ loadExtra + firstStep + (steps−1) × steady + vaeDecode
 *
 * | 分量        | 含义                                   | 值                                        |
 * |-------------|----------------------------------------|-------------------------------------------|
 * | loadExtra   | **加载后首次**推理的额外页换入         | ≈ +100s（仅每次 load 后的第一张图）        |
 * | firstStep   | 每张图都付的冷启动（权重上传）         | 78 – 93s（中值 85s = FIRST_STEP_SEC）      |
 * | steady      | 稳态步，**超线性**于像素数             | steady ≈ 8.96 × MP^1.34（拟合）           |
 * | vaeDecode   | 末步之后的 VAE 解码 + 后处理           | ≈ 24.8 × MP（拟合，下限 8s）              |
 *
 * ── 实测锚点 vs 幂律拟合（**两者不同源，勿混用**）───────────────────
 * 标定只测了 3 个点，而 ETA 要对任意尺寸可用，所以 steady/vaeDecode 走
 * 平滑拟合；拟合在每个标定点上都与实测有偏差，这是刻意的取舍：
 *
 *   尺寸            稳态步实测 → 拟合         VAE 实测 → 拟合
 *   0.59 MP (768²)  4.43 → 4.42 s/步         24 → 15 s
 *   1.05 MP (1024²) 8.82 → 9.55 s/步         26 → 26 s
 *   4.19 MP (2048²) 60.71 → 61.19 s/步       69 → 104 s
 *
 * 拟合值可能比实测高（1024² 稳态 +8%、2048² VAE +51%）或低（768² VAE −37%），
 * 但对总耗时的净影响在 ±6% 以内 —— 远小于 firstStep 本身的抖动（78–93s）。
 * 相比之下线性拟合会让 2048² 低估约 40%，那才是不可接受的。
 *
 * 重要：**`standard` 档有 3 次真实实测，用实测均值 303s 覆盖拟合结果**
 * （见下方 PRESETS 的 measuredTotalSec）；draft/native 没有可用的常态实测，
 * 只能走拟合。文档与技能里引用的「2.5 / 5.0 / 43 分钟」就是这个口径。
 *
 * ── 注意：稳态超线性来自注意力 O(n²)，不是笔误 ──────────────────────
 * 像素 7.1×（768²→2048²）时步耗时约 13.7×（4.43 → 60.71 s/步）。
 *
 * ── 各档位实测/推算总耗时（用户可见口径）────────────────────────────
 *   draft    768²/12步 ：拟合 **148s ≈ 2.5 分钟**（实测首张 251s，含 loadExtra）
 *   standard 1024²/24步：实测 **303s ≈ 5.0 分钟**（3 次独立测量：304.2/301.6/303.4）
 *   native   2048²/40步：拟合 **2575s ≈ 43 分钟**（3 步实测 284s 后按幂律外推）
 *
 * ── 首轮测量的重要教训 ─────────────────────────────────────────────
 * 首轮把 tqdm 的**累计均值**当单步耗时，得出「512² 稳态 9–10s」，
 * 实际仅 1.7s —— 高估约 5 倍。此后一律用 callback_on_step_end 逐点计时。
 *
 * 换卡/换 dtype 后应重跑 `node scripts/preset-bench.mjs` 并更新本文件。
 */

export interface PresetSpec {
  name: 'draft' | 'standard' | 'native'
  width: number
  height: number
  steps: number
  /** 稳态每步耗时（秒），由像素数按幂律求得 */
  steadyStepSec: number
  /** 末步之后 VAE 解码 + 后处理（秒） */
  vaeDecodeSec: number
  label: string
  /** 实测总耗时（秒），仅在有实测时给出 */
  measuredTotalSec?: number
  /** 实测总耗时的采样次数 */
  measuredRuns?: number
}

/** 稳态步幂律拟合：steady ≈ STEADY_COEF × MP^STEADY_EXP */
const STEADY_COEF = 8.96
const STEADY_EXP = 1.34

/** 每张图都付的首步冷启动（权重上传 + 部分页换入），实测区间中值 */
export const FIRST_STEP_SEC = 85
/** 实测区间（用于在文本里给出诚实的范围） */
export const FIRST_STEP_RANGE: [number, number] = [78, 93]

/** 加载后**首次**推理的额外开销（把剩余权重换入内存），只付一次 */
export const FIRST_INFERENCE_EXTRA_SEC = 100

/** 权重加载耗时（mmap 按需分页，实测 55–141s，取决于页缓存状态） */
export const LOAD_SEC_RANGE: [number, number] = [55, 141]

/** 按像素数求稳态步耗时。 */
export function steadyStepSec(width: number, height: number): number {
  const mp = Math.max(0.01, (width * height) / 1e6)
  return STEADY_COEF * Math.pow(mp, STEADY_EXP)
}

/** 按像素数求 VAE 解码耗时（近似线性于像素，带 0.4 下限保护）。 */
export function vaeDecodeSec(width: number, height: number): number {
  const mp = Math.max(0.01, (width * height) / 1e6)
  // 实测锚点：1024²(1.05MP) = 26s ⇒ ≈ 24.8 s/MP
  return Math.max(8, 24.8 * mp)
}

function spec(
  name: PresetSpec['name'],
  width: number,
  height: number,
  steps: number,
  label: string,
  measured?: { total: number; runs: number },
): PresetSpec {
  return {
    name,
    width,
    height,
    steps,
    steadyStepSec: Math.round(steadyStepSec(width, height) * 100) / 100,
    vaeDecodeSec: Math.round(vaeDecodeSec(width, height)),
    label,
    measuredTotalSec: measured?.total,
    measuredRuns: measured?.runs,
  }
}

/** M0 实测标定的三个档位 */
export const PRESETS: Record<'draft' | 'standard' | 'native', PresetSpec> = {
  // draft：唯一一次实测是 250.67s，但那次是**加载后首张**（含 loadExtra ≈ +100s），
  // 不代表常态，故不写 measuredTotalSec —— 让 presetSeconds() 按三段式算（≈158s ≈ 2.6 分），
  // 与 standard 的口径保持一致。
  draft: spec('draft', 768, 768, 12, '草稿 768²/12步'),
  standard: spec('standard', 1024, 1024, 24, '标准 1024²/24步', {
    total: 303.0, // 3 次独立实测均值：304.2 / 301.6 / 303.4
    runs: 3,
  }),
  native: spec('native', 2048, 2048, 40, '原生 2048²/40步'),
}

/** 推荐的尺寸比例表（官方比例，见 PLAN §1.3） */
export const RATIOS: Record<string, { width: number; height: number }> = {
  '1:1': { width: 2048, height: 2048 },
  '4:3': { width: 2389, height: 1792 },
  '3:4': { width: 1792, height: 2389 },
  '3:2': { width: 2560, height: 1707 },
  '2:3': { width: 1707, height: 2560 },
  '16:9': { width: 2752, height: 1536 },
  '9:16': { width: 1536, height: 2752 },
}

export interface EstimateOptions {
  /** worker 是否已加载模型（未加载则另需 loadSec） */
  loaded?: boolean
  /** 是否为加载后的**首次**推理（需付 loadExtra） */
  firstAfterLoad?: boolean
}

/** 估算一次生图的耗时（秒），四段式模型。 */
export function estimateSeconds(
  steps: number,
  width: number,
  height: number,
  opts: EstimateOptions = {},
): number {
  const n = Math.max(1, Math.round(steps))
  let total = FIRST_STEP_SEC + Math.max(0, n - 1) * steadyStepSec(width, height) + vaeDecodeSec(width, height)
  if (opts.firstAfterLoad) total += FIRST_INFERENCE_EXTRA_SEC
  if (opts.loaded === false) total += LOAD_SEC_RANGE[0]
  return Math.round(total)
}

/** 档位自身的实测（优先）或推算总耗时。 */
export function presetSeconds(p: PresetSpec): number {
  if (p.measuredTotalSec) return Math.round(p.measuredTotalSec)
  return estimateSeconds(p.steps, p.width, p.height)
}

/** 档位在「非首张」情形下的稳态耗时（更贴近连续出图的体验）。 */
export function presetSteadySeconds(p: PresetSpec): number {
  const total = FIRST_STEP_SEC + Math.max(0, p.steps - 1) * steadyStepSec(p.width, p.height)
  return Math.round(total + vaeDecodeSec(p.width, p.height))
}

/**
 * 人类可读的耗时描述（中文）。
 */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return '—'
  if (seconds < 60) return `${Math.round(seconds)} 秒`
  const min = seconds / 60
  if (min < 10) return `${min.toFixed(1)} 分钟`
  if (min < 60) return `${Math.round(min)} 分钟`
  return `${(min / 60).toFixed(1)} 小时`
}

/**
 * 生成耗时的可读预估说明（供工具文本回传，让模型知道要等多久）。
 */
export function describeEstimate(
  steps: number,
  width: number,
  height: number,
  opts: EstimateOptions = {},
): { seconds: number; text: string } {
  const seconds = estimateSeconds(steps, width, height, opts)
  const notes: string[] = []
  if (opts.loaded === false) notes.push(`worker 尚未加载，另需约 ${LOAD_SEC_RANGE[0]}–${LOAD_SEC_RANGE[1]} 秒加载 30.9GB 权重`)
  if (opts.firstAfterLoad) notes.push('这是加载后的首张图，需额外约 100 秒换入权重')
  const suffix = notes.length ? `（${notes.join('；')}）` : ''

  return {
    seconds,
    text:
      `预计耗时约 ${formatDuration(seconds)}${suffix}。` +
      `基准：本机 P40/fp16 实测——首步冷启动 ${FIRST_STEP_RANGE[0]}–${FIRST_STEP_RANGE[1]}s（每图重付），` +
      `稳态 ≈ ${steadyStepSec(width, height).toFixed(1)}s/步 @${width}²（超线性于像素），` +
      `VAE 解码 ≈ ${vaeDecodeSec(width, height).toFixed(0)}s。`,
  }
}

/** 全部档位的简短清单（供工具描述与卡片使用）。 */
export function presetSummary(): string {
  return Object.values(PRESETS)
    .map((p) => `${p.name}(${p.label}，约 ${formatDuration(presetSeconds(p))})`)
    .join('、')
}
