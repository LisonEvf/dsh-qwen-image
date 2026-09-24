/**
 * 客户端半 —— 与宿主同源路由通信，以及少量格式化工具。
 *
 * 契约：宿主用 `webServer.tapIndex` 注入 `window.__QWEN_IMAGE__`（含 routePrefix），
 * 读不到时回退到默认前缀，保证「改了配置也不断图」。
 *
 * 范围刻意收窄：卡片只需要「拼图片 URL」和「解析工具参数」两件事。
 * 历史浏览与选择**不走这里** —— 那是 LLM 在对话里用 `image_result` 完成的事
 * （见 index.ts 的设计取舍）。
 */

export interface PresetInfo {
  name: string
  label: string
  width: number
  height: number
  steps: number
  estimatedSec: number
}

export interface HostConfig {
  routePrefix: string
  pluginId: string
  presets: PresetInfo[]
  coldStartSec: number
  maxReferenceImages: number
}

const FALLBACK: HostConfig = {
  routePrefix: '/api/qwen-image',
  pluginId: '@lisonevf/dsh-qwen-image',
  presets: [],
  coldStartSec: 85,
  maxReferenceImages: 10,
}

/** 读取宿主注入的配置（缺失时回退默认值）。 */
export function hostConfig(): HostConfig {
  try {
    const injected = (window as unknown as { __QWEN_IMAGE__?: Partial<HostConfig> }).__QWEN_IMAGE__
    if (injected && typeof injected.routePrefix === 'string') {
      return { ...FALLBACK, ...injected } as HostConfig
    }
  } catch {
    // window 不可用（理论上不会发生）
  }
  return FALLBACK
}

/** 拼同源路由 URL。 */
export function apiUrl(path: string): string {
  const base = hostConfig().routePrefix.replace(/\/$/, '')
  return `${base}${path}`
}

/**
 * 图片原始 URL。
 *
 * 这是**界面显示图片的保底通道**：走宿主同源路由（`/raw?id=`），
 * 与当前模型路由能否看图完全无关 —— 所以即使模型看不见图，用户也一定看得到。
 */
export function rawUrl(id: string): string {
  return apiUrl(`/raw?id=${encodeURIComponent(id)}`)
}

/**
 * 缩略图 URL（历史相册网格用）。
 *
 * 缩略图由 worker 在存图时生成，长边 ≤384，通常几十 KB；
 * 早期生成的图没有缩略图时，宿主会**回退返回原图**（响应头
 * `X-Qwen-Image-Thumb: fallback-raw`），所以这里永远可以放心用。
 */
export function thumbUrl(id: string): string {
  return apiUrl(`/thumb?id=${encodeURIComponent(id)}`)
}

// ---------------------------------------------------------------------------
// 历史相册：数据获取
// ---------------------------------------------------------------------------

export interface GalleryItem {
  id: string
  rawUrl: string
  thumbUrl: string
  hasThumb: boolean
  width: number
  height: number
  bytes: number
  thumbBytes?: number | null
  hasAlpha: boolean
  seed: number
  steps: number
  prompt: string
  kind: string
  elapsedSec?: number
  steadyStepSec?: number
  peakVramMiB?: number
  device?: string
  dtype?: string
  createdAt: number
  inputImage?: string
  usedReferences?: number
  // ---- 相册增强（宿主随 manifest 持久化）----
  tags: string[]
  favorite: boolean
  note?: string
  promptEdited?: boolean
}

/** 排序字段白名单（与宿主 `SortKey` 必须一致）。 */
export type SortKey = 'createdAt' | 'bytes' | 'steps' | 'elapsedSec' | 'width' | 'height' | 'seed' | 'id'

export interface FacetBucket<K = string | number> {
  key: K
  count: number
}

export interface AlbumFacets {
  total: number
  favorites: number
  kinds: FacetBucket<string>[]
  sizes: FacetBucket<number>[]
  steps: FacetBucket<number>[]
  tags: FacetBucket<string>[]
  days: FacetBucket<string>[]
}

export interface GalleryQuery {
  q?: string
  kind?: string
  /** 需要同时命中的标签（AND） */
  tags?: string[]
  fav?: boolean
  size?: number
  from?: number
  to?: number
  sort?: SortKey
  order?: 'asc' | 'desc'
  limit?: number
  offset?: number
}

export interface GalleryResponse {
  count: number
  total: number
  facets: AlbumFacets
  applied: GalleryQuery
  items: GalleryItem[]
}

/** 把查询对象编成 query string（空值不写，避免噪声）。 */
function toQuery(params: Record<string, string | number | boolean | undefined>): string {
  const sp = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === '' || v === false) continue
    sp.set(k, String(v))
  }
  const s = sp.toString()
  return s ? `?${s}` : ''
}

/** 拉取历史相册（筛选 + 排序 + 分页 + 计数一次带回）。 */
export async function fetchGallery(query: GalleryQuery = {}): Promise<GalleryResponse> {
  const qs = toQuery({
    q: query.q,
    kind: query.kind,
    tag: query.tags?.length ? query.tags.join(',') : undefined,
    fav: query.fav ? 1 : undefined,
    size: query.size,
    from: query.from,
    to: query.to,
    sort: query.sort,
    order: query.order,
    limit: query.limit ?? 200,
    offset: query.offset,
  })
  const res = await fetch(apiUrl(`/gallery.json${qs}`))
  if (!res.ok) throw new Error(`读取相册失败：HTTP ${res.status}`)
  return (await res.json()) as GalleryResponse
}

export interface UpdateResult {
  ok: boolean
  updated: string[]
  missing: string[]
  items: GalleryItem[]
  facets: AlbumFacets
}

export interface DeleteResult {
  ok: boolean
  deleted: string[]
  missing: string[]
  failed: { id: string; error: string }[]
  purged: boolean
  trashDir?: string
  trashCount: number
  facets: AlbumFacets
}

export interface TrashItem {
  id: string
  deletedAt: number
  trashDir: string
  width: number
  height: number
  prompt: string
  kind: string
  tags: string[]
  favorite: boolean
  hasFile: boolean
}

async function postJson<T>(path: string, payload: unknown): Promise<T> {
  const res = await fetch(apiUrl(path), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const text = await res.text()
  let data: unknown = {}
  try {
    data = text ? JSON.parse(text) : {}
  } catch {
    data = { error: text.slice(0, 200) }
  }
  if (!res.ok) {
    const e = data as { error?: string }
    throw new Error(e?.error ?? `HTTP ${res.status}`)
  }
  return data as T
}

/** 改元数据：提示词 / 备注 / 收藏 / 标签（新增或移除）。 */
export function updateImages(payload: {
  ids: string[]
  prompt?: string
  note?: string
  favorite?: boolean
  tags?: string[]
  tagsAdd?: string[]
  tagsRemove?: string[]
}): Promise<UpdateResult> {
  return postJson<UpdateResult>('/update', payload)
}

/** 删除：默认进回收站（可还原），purge=true 才真删。 */
export function deleteImages(ids: string[], purge = false): Promise<DeleteResult> {
  return postJson<DeleteResult>('/delete', { ids, purge })
}

/** 回收站列表。 */
export async function fetchTrash(): Promise<{ count: number; items: TrashItem[] }> {
  const res = await fetch(apiUrl('/trash.json'))
  if (!res.ok) throw new Error(`读取回收站失败：HTTP ${res.status}`)
  return (await res.json()) as { count: number; items: TrashItem[] }
}

/** 从回收站还原。 */
export function restoreImages(ids: string[]): Promise<{
  ok: boolean
  restored: string[]
  missing: string[]
  trashCount: number
  facets: AlbumFacets
}> {
  return postJson('/restore', { ids })
}

/**
 * 扫产物目录，把「磁盘上有、注册表里没有」的作品补录回来。
 *
 * 两类用途：宿主侧在入库前出错留下的孤儿图（background 登记失败、崩溃、
 * 插件被卸载），以及 manifest 损坏后从 sidecar 重建相册。
 */
export function recoverImages(): Promise<{
  ok: boolean
  added: string[]
  addedCount: number
  scanned: number
  skipped: number
  facets: AlbumFacets
}> {
  return postJson('/recover', {})
}

export interface WorkerHealth {
  manager: { state: string; port: number; pid?: number; error?: string; restarts: number }
  worker: {
    ok: boolean
    state: string
    device: string
    dtype: string
    offload: string
    loadSec?: number | null
    warmed?: boolean
    vram: { free: number | null; total: number | null; peak: number | null }
    queueDepth: number
  } | null
  presets: Record<string, string>
  galleryCount: number
  /** 回收站条数（页脚「回收站」按钮上的角标） */
  trashCount?: number
}

/** 拉取插件侧状态（worker 状态 + 显存），相册页脚用。 */
export async function fetchHealth(): Promise<WorkerHealth> {
  const res = await fetch(apiUrl('/health'))
  if (!res.ok) throw new Error(`读取状态失败：HTTP ${res.status}`)
  return (await res.json()) as WorkerHealth
}

/** 请求卸载模型释放显存（把显卡还给别的程序）。 */
export async function requestUnload(): Promise<boolean> {
  const res = await fetch(apiUrl('/unload'), { method: 'POST' })
  return res.ok
}

/** 相对时间（「3 分钟前」），相册里比绝对时间更好扫。 */
export function relativeTime(ts: number): string {
  if (!Number.isFinite(ts)) return ''
  const sec = Math.max(0, (Date.now() - ts) / 1000)
  if (sec < 60) return '刚刚'
  if (sec < 3600) return `${Math.floor(sec / 60)} 分钟前`
  if (sec < 86400) return `${Math.floor(sec / 3600)} 小时前`
  return `${Math.floor(sec / 86400)} 天前`
}

/** 人类可读的耗时。 */
export function formatDuration(seconds?: number | null): string {
  if (seconds == null || !Number.isFinite(seconds)) return '—'
  if (seconds < 60) return `${Math.round(seconds)} 秒`
  const min = seconds / 60
  if (min < 10) return `${min.toFixed(1)} 分钟`
  return `${Math.round(min)} 分钟`
}

/** 字节数可读化。 */
export function formatBytes(bytes?: number | null): string {
  if (bytes == null || !Number.isFinite(bytes)) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** 从工具参数 JSON 里安全取出字段。 */
export function safeParseArgs(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string' || !raw.trim()) return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}
