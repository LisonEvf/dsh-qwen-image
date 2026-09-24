import type { Context } from '@deepseek-ai/cordis'
import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { Config } from './config'
import type { SavedImage } from './client-http'
import { expandHome, resolveDshHome } from './paths'

/**
 * 注册表/落盘诊断落盘（与 worker-manager 的 spawn 诊断分开成两个文件，避免混读）。
 *
 * 为什么必须有：`persist()` 曾只留一句 `console.warn` —— 宿主控制台看不到，
 * 于是「作品历史不跨重启」被当成玄学，排查了很久才定位到沙箱围栏。
 */
function registryDiagLog(line: string): void {
  try {
    const dir = `${resolveDshHome()}/dsh-qwen-image/logs`
    mkdirSync(dir, { recursive: true })
    appendFileSync(`${dir}/registry.log`, `[${new Date().toISOString()}] ${line}\n`)
  } catch {
    // 诊断失败绝不影响主流程
  }
}

/**
 * 图像注册表（§2 host 半）。
 *
 * 职责：
 * - id → { file, meta } 映射，落盘 manifest.json（供画廊与 image_result 取回）
 * - 结果注入 ctx.attachments（原生 ImageBlock，刷新/回放更稳）
 * - 「最新」指针（image_result 缺省、image_edit image='latest'）
 *
 * 内存中只保留有界的近期条目；完整历史以 manifest.json 为准。
 */

export interface ImageRecord {
  id: string
  file: string
  sidecar?: string
  /** 缩略图路径（worker 存图时生成）；缺失时历史相册回退原图 */
  thumb?: string | null
  /** 缩略图的实际媒体类型（WebP 优先，可能回退 PNG） */
  thumbMediaType?: string | null
  width: number
  height: number
  bytes: number
  thumbBytes?: number | null
  hasAlpha: boolean
  seed: number
  steps: number
  prompt: string
  kind: 'generate' | 'edit'
  elapsedSec?: number
  steadyStepSec?: number | null
  peakVramMiB?: number | null
  device?: string
  dtype?: string
  createdAt: number
  /** 注入 attachments 后拿到的附件引用（不可变；仅内存，不持久化到 manifest） */
  attachmentId?: string
  inputImage?: string
  usedReferences?: number

  // ---- 相册增强：用户侧元数据（全部随 manifest 持久化）------------------
  /** 用户标签（手工分类；相册可据此筛选/分组） */
  tags?: string[]
  /** 收藏 */
  favorite?: boolean
  /** 用户备注 */
  note?: string
  /** 提示词是否被手工改写过（保留「原始提示词即产出该图的提示词」这一事实） */
  promptEdited?: boolean
}

/** 相册查询/排序的字段白名单。 */
export type SortKey = 'createdAt' | 'bytes' | 'steps' | 'elapsedSec' | 'width' | 'height' | 'seed' | 'id'

export interface QueryOptions {
  /** 自由文本：匹配提示词 / id / seed / 标签 / 备注 */
  q?: string
  kind?: string
  /** 需要同时命中的标签（AND） */
  tags?: string[]
  fav?: boolean
  /** 最长边（对齐 preset 档位：768 / 1024 / 2048） */
  size?: number
  /** createdAt 区间（epoch ms） */
  from?: number
  to?: number
  sort?: SortKey
  order?: 'asc' | 'desc'
  limit?: number
  offset?: number
}

export interface FacetBucket<K = string | number> {
  key: K
  count: number
}

/** 相册筛选面板的计数（在**全量**记录上算，不受当前页/当前筛选影响）。 */
export interface AlbumFacets {
  total: number
  favorites: number
  kinds: FacetBucket<string>[]
  sizes: FacetBucket<number>[]
  steps: FacetBucket<number>[]
  tags: FacetBucket<string>[]
  days: FacetBucket<string>[]
}

/** 回收站条目：记住原路径，才可能「还原」。 */
export interface TrashEntry {
  id: string
  record: ImageRecord
  /** 槽位 → 回收站里的实际路径（file / thumb / sidecar） */
  moved: Record<string, string>
  deletedAt: number
  trashDir: string
}

/** 标签归一化：去空白、去重、保序、限长。 */
function normalizeTags(tags: string[]): string[] {
  const out: string[] = []
  for (const raw of tags) {
    const t = String(raw ?? '').trim().slice(0, 32)
    if (!t || out.includes(t)) continue
    out.push(t)
  }
  return out
}

/** 本地日期桶（YYYY-MM-DD），相册按天分组用。 */
function dayKey(ts: number): string {
  const d = new Date(Number(ts) || 0)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 从 `generate-12` / `edit-3` 这类 id 里取序号，用于补录时恢复顺序。 */
function indexOfId(id: string): number {
  const m = /-(\d+)$/.exec(id)
  return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER
}

/** 一条记录对应的磁盘文件（槽位 → 路径）。 */
function filePathsOf(rec: ImageRecord): Record<string, string | undefined> {
  return { file: rec.file, thumb: rec.thumb ?? undefined, sidecar: rec.sidecar ?? undefined }
}

function removeFileQuiet(p: string | undefined): void {
  if (!p) return
  try {
    rmSync(p, { force: true })
  } catch {
    try {
      unlinkSync(p)
    } catch {
      /* 已经不在了 */
    }
  }
}

export class ImageRegistry {
  private readonly byId = new Map<string, ImageRecord>()
  private order: string[] = []
  private latestId: string | undefined
  private readonly maxInMemory = 500
  /** 回收站（随 `<outputs>/_trash/trash.json` 持久化） */
  private trashEntries: TrashEntry[] = []

  constructor(
    private readonly ctx: Context,
    private readonly config: Config,
  ) {}

  get outputDir(): string {
    return expandHome(this.config.outputDir)
  }

  private get manifestPath(): string {
    return `${this.outputDir}/manifest.json`
  }

  /** 记录一批新生成的图，返回记录列表。 */
  async addAll(saved: SavedImage[], meta: Omit<ImageRecord, 'id' | 'file' | 'width' | 'height' | 'bytes' | 'hasAlpha' | 'createdAt'>): Promise<ImageRecord[]> {
    const records: ImageRecord[] = []
    for (const s of saved) {
      const rec: ImageRecord = {
        id: s.id,
        file: s.file,
        sidecar: s.sidecar,
        thumb: s.thumb ?? null,
        thumbMediaType: s.thumbMediaType ?? null,
        width: s.width,
        height: s.height,
        bytes: s.bytes,
        thumbBytes: s.thumbBytes ?? null,
        hasAlpha: s.hasAlpha,
        createdAt: Date.now(),
        ...meta,
      }
      // id 复用（老 worker 计数器重启后从 1 重来、或用户手工删过产物）时，
      // byId 会被新记录覆盖，而 order 里会留下一个重复项 —— 列表与相册
      // 就会把同一张图显示两行。先摘掉旧位置，保证 order 里 id 唯一。
      const dup = this.order.indexOf(rec.id)
      if (dup >= 0) this.order.splice(dup, 1)
      this.byId.set(rec.id, rec)
      this.order.push(rec.id)
      records.push(rec)
    }
    if (records.length) this.latestId = records[records.length - 1].id

    // 有界内存：超出则丢弃最旧
    while (this.order.length > this.maxInMemory) {
      const old = this.order.shift()
      if (old) this.byId.delete(old)
    }

    await this.persist()
    return records
  }

  get(id: string): ImageRecord | undefined {
    if (id === 'latest') return this.latest()
    return this.byId.get(id)
  }

  latest(): ImageRecord | undefined {
    return this.latestId ? this.byId.get(this.latestId) : undefined
  }

  list(limit = 100): ImageRecord[] {
    return this.order
      .slice(-limit)
      .reverse()
      .map((id) => this.byId.get(id))
      .filter((r): r is ImageRecord => !!r)
  }

  /** 全部在册记录（旧→新）。相册的筛选/排序/计数都在它之上做。 */
  all(): ImageRecord[] {
    return this.order.map((id) => this.byId.get(id)).filter((r): r is ImageRecord => !!r)
  }

  /**
   * 相册查询：筛选 → 排序 → 分页。
   *
   * 为什么放在宿主而不是客户端：manifest 的完整历史以宿主为准
   * （内存只保留 maxInMemory 条），排序/计数必须在**全量**上算才不会出错；
   * 客户端只负责渲染拿到的这一页。
   */
  query(opts: QueryOptions = {}): { items: ImageRecord[]; total: number } {
    const q = opts.q?.trim().toLowerCase()
    let rows = this.all()

    if (q) {
      rows = rows.filter((r) =>
        `${r.prompt ?? ''} ${r.id} ${r.seed} ${(r.tags ?? []).join(' ')} ${r.note ?? ''}`
          .toLowerCase()
          .includes(q),
      )
    }
    if (opts.kind) rows = rows.filter((r) => r.kind === opts.kind)
    if (opts.fav) rows = rows.filter((r) => !!r.favorite)
    if (opts.size) rows = rows.filter((r) => Math.max(r.width, r.height) === opts.size)
    if (opts.from != null) rows = rows.filter((r) => Number(r.createdAt) >= opts.from!)
    if (opts.to != null) rows = rows.filter((r) => Number(r.createdAt) <= opts.to!)
    const tags = (opts.tags ?? []).filter(Boolean)
    if (tags.length) rows = rows.filter((r) => tags.every((t) => (r.tags ?? []).includes(t)))

    const key = opts.sort ?? 'createdAt'
    const dir = opts.order === 'asc' ? 1 : -1
    rows = [...rows].sort((a, b) => {
      const av = a[key] as unknown
      const bv = b[key] as unknown
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir
      return String(av ?? '').localeCompare(String(bv ?? '')) * dir
    })

    const total = rows.length
    const offset = Math.max(0, opts.offset ?? 0)
    const limit = Math.max(1, Math.min(1000, opts.limit ?? 200))
    return { items: rows.slice(offset, offset + limit), total }
  }

  /** 筛选面板用的计数（全量口径）。 */
  facets(): AlbumFacets {
    const rows = this.all()
    const bump = <K extends string | number>(m: Map<K, number>, k: K | undefined | null) => {
      if (k == null || k === '') return
      m.set(k, (m.get(k) ?? 0) + 1)
    }
    const kinds = new Map<string, number>()
    const sizes = new Map<number, number>()
    const steps = new Map<number, number>()
    const tags = new Map<string, number>()
    const days = new Map<string, number>()
    for (const r of rows) {
      bump(kinds, r.kind)
      bump(sizes, Math.max(r.width, r.height))
      if (r.steps) bump(steps, r.steps)
      for (const t of r.tags ?? []) bump(tags, t)
      bump(days, dayKey(r.createdAt))
    }
    const toBuckets = <K extends string | number>(m: Map<K, number>, cmp?: (a: K, b: K) => number) =>
      [...m.entries()]
        .map(([key, count]) => ({ key, count }))
        .sort(cmp ?? ((a, b) => String(b.key).localeCompare(String(a.key))))
    return {
      total: rows.length,
      favorites: rows.filter((r) => !!r.favorite).length,
      kinds: toBuckets(kinds),
      sizes: toBuckets(sizes, (a, b) => Number(a.key) - Number(b.key)),
      steps: toBuckets(steps, (a, b) => Number(a.key) - Number(b.key)),
      tags: toBuckets(tags, (a, b) => b.count - a.count),
      days: toBuckets(days),
    }
  }

  /**
   * 批量改元数据（提示词 / 标签 / 收藏 / 备注）。
   *
   * 标签三种写法：`tags` 整体替换、`tagsAdd` / `tagsRemove` 增量改
   * —— 批量「加标签」用增量最不容易互相覆盖。
   */
  async updateMany(
    ids: string[],
    patch: {
      prompt?: string
      note?: string
      favorite?: boolean
      tags?: string[]
      tagsAdd?: string[]
      tagsRemove?: string[]
    },
  ): Promise<{ updated: ImageRecord[]; missing: string[] }> {
    const updated: ImageRecord[] = []
    const missing: string[] = []
    for (const id of ids) {
      const rec = this.byId.get(id)
      if (!rec) {
        missing.push(id)
        continue
      }
      if (patch.prompt !== undefined && patch.prompt !== rec.prompt) {
        rec.prompt = patch.prompt
        // 记下「已手改」：原始提示词是产图依据，改过就不再等价于产出参数
        rec.promptEdited = true
      }
      if (patch.note !== undefined) rec.note = patch.note
      if (patch.favorite !== undefined) rec.favorite = patch.favorite
      if (patch.tags !== undefined) rec.tags = normalizeTags(patch.tags)
      if (patch.tagsAdd?.length) rec.tags = normalizeTags([...(rec.tags ?? []), ...patch.tagsAdd])
      if (patch.tagsRemove?.length) {
        const drop = new Set(patch.tagsRemove.map((t) => t.trim()).filter(Boolean))
        rec.tags = normalizeTags((rec.tags ?? []).filter((t) => !drop.has(t)))
      }
      updated.push(rec)
    }
    if (updated.length) await this.persist()
    return { updated, missing }
  }

  /**
   * 批量删除。
   *
   * 默认**移到回收站**（`<outputs>/_trash/<时间戳>/`）而不是真删：
   * 本轮开发里已经因为 id 复用误覆盖过一张图，删除必须是可后悔的。
   * `purge: true` 才真删（同时清掉该 id 的回收站记录）。
   */
  async removeMany(
    ids: string[],
    opts: { purge?: boolean } = {},
  ): Promise<{ deleted: string[]; missing: string[]; failed: { id: string; error: string }[]; trashDir?: string }> {
    const deleted: string[] = []
    const missing: string[] = []
    const failed: { id: string; error: string }[] = []
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const trashDir = join(this.outputDir, '_trash', stamp)

    for (const id of ids) {
      const rec = this.byId.get(id)
      if (!rec) {
        missing.push(id)
        continue
      }
      try {
        if (opts.purge) {
          // 注意用 Object.values：filePathsOf 返回的是普通对象，不是可迭代对象
          // （冒烟里正是这里被抓到 `filePathsOf is not a function or its return value is not iterable`）
          for (const p of Object.values(filePathsOf(rec))) removeFileQuiet(p)
        } else {
          mkdirSync(trashDir, { recursive: true })
          const moved: Record<string, string> = {}
          for (const [slot, p] of Object.entries(filePathsOf(rec))) {
            if (!p) continue
            const dest = join(trashDir, basename(p))
            try {
              renameSync(p, dest)
              moved[slot] = dest
            } catch {
              /* 文件可能已被手工删除；记录里仍要删掉这条 */
            }
          }
          this.trashEntries.unshift({
            id: rec.id,
            record: rec,
            moved,
            deletedAt: Date.now(),
            trashDir,
          })
        }
        this.byId.delete(rec.id)
        const at = this.order.indexOf(rec.id)
        if (at >= 0) this.order.splice(at, 1)
        deleted.push(rec.id)
      } catch (err) {
        failed.push({ id, error: (err as Error).message })
      }
    }

    if (this.latestId && !this.byId.has(this.latestId)) {
      this.latestId = this.order[this.order.length - 1]
    }
    if (deleted.length) {
      if (!opts.purge) await this.persistTrash()
      await this.persist()
    }
    return { deleted, missing, failed, trashDir: opts.purge ? undefined : trashDir }
  }

  /** 回收站列表（新→旧）。 */
  listTrash(): TrashEntry[] {
    return this.trashEntries
  }

  /**
   * 扫产物目录，把「磁盘上有、注册表里没有」的作品补录回来。
   *
   * 为什么需要（实测教训 2026-09-23）：worker 写完 PNG 就落 sidecar，而**入库发生在宿主侧**。
   * 一旦宿主侧在入库前出错（background 任务登记抛错、宿主崩溃、插件被卸载），
   * 图就成了孤儿：磁盘上在、相册里永远看不到 —— 而 GPU 那 3 分钟已经花掉了。
   * 有了这个扫描，孤儿一句话就能捞回来；manifest 万一损坏，它同时也是
   * 「从 sidecar 重建整个相册」的灾难恢复通道。
   *
   * 只认 `<outputs>/*.json` 里带 `id` + `file` 的 sidecar，且要求 PNG 真的存在；
   * `manifest.json` 自身与 `_trash/`、`_direct/` 下的东西一律跳过（后者是子目录，不在 listDir 里）。
   */
  async recoverFromDisk(): Promise<{ added: string[]; scanned: number; skipped: number }> {
    const fs = this.ctx.get('fs') as
      | {
          resolve(path: string): Promise<unknown>
          readText(target: unknown): Promise<string>
          listDir(target: unknown): Promise<{ name: string; type: string }[]>
        }
      | undefined
    const added: string[] = []
    let scanned = 0
    let skipped = 0
    if (!fs) return { added, scanned, skipped }

    let entries: { name: string; type: string }[] = []
    try {
      entries = await fs.listDir(await fs.resolve(this.outputDir))
    } catch (err) {
      registryDiagLog(`产物扫描失败：${(err as Error).message}\n  dir=${this.outputDir}`)
      return { added, scanned, skipped }
    }

    for (const e of entries) {
      if (e.type !== 'file' || !e.name.endsWith('.json') || e.name === 'manifest.json') continue
      scanned++
      let rec: ImageRecord | undefined
      try {
        rec = JSON.parse(await fs.readText(await fs.resolve(`${this.outputDir}/${e.name}`))) as ImageRecord
      } catch {
        skipped++
        continue
      }
      if (!rec?.id || !rec.file || !rec.width || !rec.height || this.byId.has(rec.id)) {
        skipped++
        continue
      }
      try {
        // 存在性探测：resolve 抛错即视为文件不在（readBytes 太贵，不读内容）
        await fs.resolve(rec.file)
      } catch {
        skipped++
        continue
      }
      rec.kind = rec.kind === 'edit' ? 'edit' : 'generate'
      rec.createdAt = Date.parse(String(rec.createdAt)) || Date.now()
      this.byId.set(rec.id, rec)
      if (!this.order.includes(rec.id)) this.order.push(rec.id)
      added.push(rec.id)
    }

    if (added.length) {
      // 按 id 里的序号排（补录的记录是追加的，直接 persist 会把顺序打乱）
      this.order.sort((x, y) => indexOfId(x) - indexOfId(y) || x.localeCompare(y))
      this.latestId = this.order[this.order.length - 1]
      await this.persist()
    }
    return { added, scanned, skipped }
  }

  /** 从回收站还原（把文件搬回原位并重新入册）。 */
  async restoreMany(ids: string[]): Promise<{ restored: string[]; missing: string[]; failed: { id: string; error: string }[] }> {
    const restored: string[] = []
    const missing: string[] = []
    const failed: { id: string; error: string }[] = []
    for (const id of ids) {
      const idx = this.trashEntries.findIndex((e) => e.id === id)
      if (idx < 0) {
        missing.push(id)
        continue
      }
      const entry = this.trashEntries[idx]
      try {
        for (const [slot, dest] of Object.entries(entry.moved)) {
          const back = (entry.record as unknown as Record<string, string | null>)[slot]
          if (!back) continue
          mkdirSync(dirname(back), { recursive: true })
          renameSync(dest, back)
        }
        this.trashEntries.splice(idx, 1)
        this.byId.set(entry.record.id, entry.record)
        if (!this.order.includes(entry.record.id)) this.order.push(entry.record.id)
        this.latestId = this.order[this.order.length - 1]
        restored.push(id)
      } catch (err) {
        failed.push({ id, error: (err as Error).message })
      }
    }
    if (restored.length) {
      await this.persistTrash()
      await this.persist()
    }
    return { restored, missing, failed }
  }

  /** 从回收站读回索引（进程启动时调用，让「最近删除」重启后仍在）。 */
  async restoreTrashIndex(): Promise<number> {
    try {
      const text = readFileSync(this.trashIndexPath, 'utf8')
      const parsed = JSON.parse(text) as { items?: TrashEntry[] }
      this.trashEntries = parsed.items ?? []
      return this.trashEntries.length
    } catch {
      return 0
    }
  }

  private async persistTrash(): Promise<void> {
    try {
      mkdirSync(join(this.outputDir, '_trash'), { recursive: true })
      writeFileSync(this.trashIndexPath, JSON.stringify({ version: 1, items: this.trashEntries }, null, 2), 'utf8')
    } catch (err) {
      registryDiagLog(`回收站索引写入失败：${(err as Error).message}\n  path=${this.trashIndexPath}`)
    }
  }

  private get trashIndexPath(): string {
    return join(this.outputDir, '_trash', 'trash.json')
  }

  /**
   * 把生成的图注入 ctx.attachments，得到不可变 ImageAttachmentRef。
   * 失败不抛错——附件是增强路径，自控路由（/api/qwen-image/raw）是保底路径。
   */
  async attachImages(records: ImageRecord[]): Promise<void> {
    const attachments = this.ctx.get('attachments') as
      | {
          saveImage(input: { data: Uint8Array; mediaType: string; name?: string }): Promise<{ attachmentId: string }>
        }
      | undefined
    if (!attachments) return

    const fs = this.ctx.get('fs') as
      | {
          resolve(path: string): Promise<unknown>
          readBytes(target: unknown, signal: undefined, maxBytes: number): Promise<Uint8Array>
        }
      | undefined
    if (!fs) return

    for (const rec of records) {
      try {
        const target = await fs.resolve(rec.file)
        const data = await fs.readBytes(target, undefined, 64 * 1024 * 1024)
        const ref = await attachments.saveImage({
          data,
          mediaType: 'image/png',
          name: `${rec.id}.png`,
        })
        rec.attachmentId = ref.attachmentId
      } catch (err) {
        console.warn(`[qwen-image] 附件注入失败（不影响自控路由显示）：${(err as Error).message}`)
      }
    }
  }

  /** 读取图像字节（供 /raw 路由）。 */
  async readBytes(id: string): Promise<{ data: Uint8Array; record: ImageRecord } | undefined> {
    const rec = this.get(id)
    if (!rec) return undefined
    return await this.readFileBytes(rec.file, rec)
  }

  /**
   * 读取缩略图字节（供 /thumb 路由）。
   *
   * 缩略图是**可选**的：早期生成的图、或缩略图生成失败时都没有它。
   * 此时返回原图 —— 相册宁可慢一点，也不能出现空白格。
   *
   * 同时回传 mediaType：缩略图优先是 WebP（体积约为 PNG 的 1/6），
   * 但可能因 Pillow 缺 WebP 支持而回退成 PNG，故不能写死 Content-Type。
   */
  async readThumbBytes(
    id: string,
  ): Promise<{ data: Uint8Array; record: ImageRecord; isThumb: boolean; mediaType: string } | undefined> {
    const rec = this.get(id)
    if (!rec) return undefined
    if (rec.thumb) {
      const got = await this.readFileBytes(rec.thumb, rec)
      if (got) {
        return {
          ...got,
          isThumb: true,
          mediaType: rec.thumbMediaType ?? mediaTypeFromPath(rec.thumb) ?? 'image/png',
        }
      }
    }
    const raw = await this.readFileBytes(rec.file, rec)
    // 原图始终是 PNG
    return raw ? { ...raw, isThumb: false, mediaType: 'image/png' } : undefined
  }

  private async readFileBytes(
    path: string,
    rec: ImageRecord,
  ): Promise<{ data: Uint8Array; record: ImageRecord } | undefined> {
    const fs = this.ctx.get('fs') as
      | {
          resolve(path: string): Promise<unknown>
          readBytes(target: unknown, signal: undefined, maxBytes: number): Promise<Uint8Array>
        }
      | undefined
    if (!fs) return undefined
    try {
      const target = await fs.resolve(path)
      const data = await fs.readBytes(target, undefined, 256 * 1024 * 1024)
      return { data, record: rec }
    } catch {
      return undefined
    }
  }

  /** 持久化 manifest.json。 */
  private async persist(): Promise<void> {
    const fs = this.ctx.get('fs') as
      | {
          resolve(path: string): Promise<unknown>
          writeText(
            target: unknown,
            content: string,
            expected?: unknown,
            signal?: unknown,
            sandboxPolicy?: { mode: string; workspaceRoot: string },
          ): Promise<unknown>
        }
      | undefined
    if (!fs) return
    try {
      const payload = {
        version: 1,
        updatedAt: new Date().toISOString(),
        items: this.list(this.maxInMemory).map((r) => ({
          id: r.id,
          file: r.file,
          thumb: r.thumb ?? null,
          thumbMediaType: r.thumbMediaType ?? null,
          width: r.width,
          height: r.height,
          bytes: r.bytes,
          thumbBytes: r.thumbBytes ?? null,
          hasAlpha: r.hasAlpha,
          seed: r.seed,
          steps: r.steps,
          prompt: r.prompt,
          kind: r.kind,
          elapsedSec: r.elapsedSec,
          steadyStepSec: r.steadyStepSec,
          peakVramMiB: r.peakVramMiB,
          device: r.device,
          dtype: r.dtype,
          createdAt: r.createdAt,
          inputImage: r.inputImage,
          usedReferences: r.usedReferences,
          // 相册增强：用户元数据也要落盘，否则重启后标签/收藏全丢
          tags: r.tags ?? [],
          favorite: !!r.favorite,
          note: r.note,
          promptEdited: !!r.promptEdited,
        })),
      }
      const target = await fs.resolve(this.manifestPath)
      // ⚠️ 必须显式传 per-call 沙箱策略。省略它就回落到**会话策略**
      // （dsh-fs-sandbox 的 checkedTarget），而 workspace-write 只放行 workspace
      // 根下的路径 —— manifest 住在 $DSH_HOME 下，于是抛 FS_SANDBOX_DENIED。
      // 关键不对称：**读不受围栏**（restore() 一直正常），只有写被挡，
      // 又被下面的 catch 吞掉 → 「历史不跨重启」而毫无报错。
      // 这里把围栏的根收窄到插件自己的 outputDir：放行本文件，不放开别的路径。
      await fs.writeText(target, JSON.stringify(payload, null, 2), undefined, undefined, {
        mode: 'workspace-write',
        workspaceRoot: this.outputDir,
      })
    } catch (err) {
      registryDiagLog(
        `manifest 写入失败：${(err as Error)?.message ?? err}\n  path=${this.manifestPath}\n  stack=${(err as Error)?.stack ?? '(无)'}`,
      )
      console.warn(`[qwen-image] manifest 写入失败：${(err as Error).message}`)
    }
  }

  /** 从 manifest.json 恢复到内存（进程启动/HMR 后）。 */
  async restore(): Promise<number> {
    const fs = this.ctx.get('fs') as
      | {
          resolve(path: string): Promise<unknown>
          readText(target: unknown): Promise<string>
        }
      | undefined
    if (!fs) return 0
    try {
      const target = await fs.resolve(this.manifestPath)
      const text = await fs.readText(target)
      const parsed = JSON.parse(text) as { items?: ImageRecord[] }
      const items = parsed.items ?? []
      // manifest 按新→旧排列，反转后按序 add
      for (const item of [...items].reverse()) {
        this.byId.set(item.id, item)
        this.order.push(item.id)
      }
      if (this.order.length) this.latestId = this.order[this.order.length - 1]
      return items.length
    } catch {
      return 0
    }
  }
}

// expandHome 已收口到 ./paths（含 DSH_HOME 未设置时的兜底）
export { expandHome }

/** 由文件扩展名推断媒体类型（缩略图可能是 .webp 或回退的 .png）。 */
function mediaTypeFromPath(p: string): string | undefined {
  const lower = p.toLowerCase()
  if (lower.endsWith('.webp')) return 'image/webp'
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  return undefined
}
