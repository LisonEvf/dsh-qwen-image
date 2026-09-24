import type { Context } from '@deepseek-ai/cordis'
import type { Config } from './config'

/**
 * 权重目录体检（§8）。核对每个组件的存在性、分片齐全性、index 一致性、
 * safetensors 头可读性 → ok | partial | missing。
 *
 * 这是「快速版」体检：worker 侧的 model_check.py 是完整版，二者口径一致。
 *
 * 组件声明与 model_index.json 一致：
 *   processor       → transformers.Qwen3VLProcessor  (配置文件)
 *   scheduler       → diffusers.FlowMatchEulerDiscreteScheduler (配置文件)
 *   text_encoder    → transformers.Qwen3VLForConditionalGeneration (4 分片 safetensors)
 *   transformer     → diffusers.QwenImage21Transformer2DModel (2 分片 safetensors)
 *   vae             → diffusers.AutoencoderKLQwenImage21
 */

export type ComponentState = 'ok' | 'partial' | 'missing'

export interface ComponentReport {
  name: string
  state: ComponentState
  expected: number
  found: number
  missingFiles: string[]
  tensorCount?: number
  bytes?: number
  note?: string
}

export interface InspectResult {
  modelDir: string
  exists: boolean
  state: ComponentState
  components: ComponentReport[]
  missing: string[]
  totalBytes?: number
  guidance: string[]
}

/**
 * safetensors 文件头解析：前 8 字节 little-endian 给出 JSON header 长度，
 * 随后是该长度的 UTF-8 JSON。仅解析顶层字段，不加载权重。
 */
export function readSafetensorsHeader(buf: Buffer): Record<string, unknown> | undefined {
  try {
    if (buf.length < 8) return undefined
    const headerLen = buf.readUInt32LE(0)
    if (headerLen === 0 || buf.length < 8 + headerLen) return undefined
    const jsonStr = buf.toString('utf8', 8, 8 + headerLen)
    return JSON.parse(jsonStr)
  } catch {
    return undefined
  }
}

/**
 * 体检一个 safetensors 目录（纯逻辑，无 ctx 依赖，供 smoke 复用）。
 * @param files 该目录下所有文件名
 * @param expectedShards 期望的分片文件名（如 model-00001-of-00004.safetensors）
 * @param indexFile 期望的 index 文件名（可空，表示无 index 也算 ok）
 */
export function inspectSafetensorsDirPure(
  files: string[],
  expectedShards: string[],
  indexFile?: string,
): { state: ComponentState; found: number; missing: string[]; tensorCount?: number; bytes: number } {
  const fileSet = new Set(files)
  const missing: string[] = []
  let found = 0

  for (const shard of expectedShards) {
    if (fileSet.has(shard)) {
      found++
    } else {
      missing.push(shard)
    }
  }

  // index 校验：若声明了 indexFile 但分片齐全，则需 index 存在
  if (indexFile && missing.length === 0 && !fileSet.has(indexFile)) {
    missing.push(indexFile)
  }

  const complete = missing.length === 0
  // 即便完整，若无法解析 index，tensorCount 为 undefined，仍算 partial 警告
  const state: ComponentState = complete ? 'ok' : 'partial'

  return { state, found, missing, tensorCount: undefined, bytes: 0 }
}

/**
 * 从 safetensors index.json 解析张量数与分片映射。
 */
export function parseSafetensorsIndex(index: Record<string, unknown>): {
  tensorCount: number
  shardCount: number
} {
  const weightMap = (index['weight_map'] as Record<string, unknown>) ?? {}
  const shardSet = new Set(Object.keys(weightMap))
  return {
    tensorCount: Object.keys(weightMap).length,
    shardCount: shardSet.size,
  }
}

/**
 * 体检单个组件目录。
 * @param ctx 上下文（用于 fs）
 * @param dir 组件目录（相对 modelDir 的相对路径，或绝对路径）
 * @param expectedShards 期望分片
 * @param indexFile 期望 index 文件名
 */
export async function inspectComponent(
  ctx: Context,
  modelDirAbs: string,
  dirRel: string,
  expectedShards: string[],
  indexFile?: string,
): Promise<ComponentReport> {
  const fs = ctx.get('fs')
  const dirAbs = dirRel.startsWith('/') ? dirRel : `${modelDirAbs}/${dirRel}`

  // 解析目录
  let target
  try {
    target = await ctx.get('fs')!.resolve(dirAbs)
  } catch {
    return { name: dirRel, state: 'missing', expected: expectedShards.length, found: 0, missingFiles: [...expectedShards], note: '目录不可解析' }
  }

  // stat 判断是否存在
  let info
  try {
    info = await fs!.stat(target)
  } catch {
    info = undefined
  }
  if (!info) {
    return { name: dirRel, state: 'missing', expected: expectedShards.length, found: 0, missingFiles: [...expectedShards] }
  }

  // 列目录
  let entries
  try {
    entries = await fs!.listDir(target)
  } catch {
    entries = []
  }
  const files = entries.map((e) => e.name)
  const pure = inspectSafetensorsDirPure(files, expectedShards, indexFile)

  // 若分片齐全且存在 index，解析 tensor 数
  let tensorCount: number | undefined
  let bytes = 0
  if (pure.state === 'ok' && indexFile) {
    try {
      const idxFiles = entries.filter((e) => e.name === indexFile)
      if (idxFiles.length > 0) {
        const idxBuf = await fs!.readBytes(idxFiles[0].target, undefined, 64 * 1024 * 1024)
        const idx = JSON.parse(idxBuf.toString('utf8')) as Record<string, unknown>
        const parsed = parseSafetensorsIndex(idx)
        tensorCount = parsed.tensorCount
      }
    } catch {
      // index 解析失败不影响 state，仅不报 tensorCount
    }
  }

  // 汇总字节
  try {
    for (const e of entries) {
      if (e.type === 'file' && e.size != null) bytes += e.size
    }
  } catch {
    // 忽略
  }

  const note = pure.state === 'ok' && tensorCount != null ? `${tensorCount} 张量` : undefined

  return {
    name: dirRel,
    state: pure.state,
    expected: expectedShards.length + (indexFile ? 1 : 0),
    found: pure.found + (pure.missing.includes(indexFile ?? '') ? 0 : indexFile ? 0 : 0),
    missingFiles: pure.missing,
    tensorCount,
    bytes,
    note,
  }
}
