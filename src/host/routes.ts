import type { Runtime } from './service'
import type { ImageRecord, QueryOptions, SortKey } from './registry'

/**
 * 同源 HTTP 路由（§7.1）—— 界面显示图片的**保底通道**。
 *
 * 与模型视觉能力解耦：即使当前模型路由不能看图，卡片也能通过
 * `<img src="/api/qwen-image/raw?id=…">` 稳定显示。
 *
 *   GET  /raw?id=…            原始 PNG（保底，必成）
 *   GET  /thumb?id=…          缩略图（缺缩略图时回退原图）
 *   GET  /gallery.json        相册：查询 + 排序 + 分页 + 筛选计数
 *   GET  /facets              仅筛选计数（面板单独刷新用）
 *   GET  /meta?id=…           单张元信息
 *   GET  /trash.json          回收站列表
 *   POST /update              改元数据（提示词 / 标签 / 收藏 / 备注）
 *   POST /delete              删除（默认移入回收站；purge=true 真删）
 *   POST /restore             从回收站还原
 *   POST /recover             扫产物目录，补录「磁盘上有、注册表没有」的孤儿作品
 *   POST /cancel?job=…        取消（转发给 worker）
 *   GET  /health              插件侧状态汇总
 *
 * 写接口同时接受 **JSON body** 与 **query 参数**（`?ids=a,b&favorite=1`）：
 * 前者给界面用，后者让 curl / PowerShell 也能一句话验证（本机排障常用）。
 *
 * 说明：SSE 进度由客户端半直连 worker 路由（/progress/:job）或在宿主侧轮询，
 * 本模块不重复实现，避免两条进度通道语义漂移。
 */

interface RouteRegistry {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: unknown, res: unknown) => void | Promise<void>
  }): () => void
}

const SORT_KEYS: SortKey[] = ['createdAt', 'bytes', 'steps', 'elapsedSec', 'width', 'height', 'seed', 'id']

export function registerRoutes(rt: Runtime): void {
  const { ctx, config, registry, manager } = rt
  const webServer = ctx.get('webServer') as RouteRegistry | undefined
  if (!webServer) {
    console.warn('[qwen-image] webServer 服务不可用，路由未注册（界面图片将只能走附件通道）')
    return
  }

  const prefix = config.routePrefix

  // ---- 原始图片（保底通道）----
  webServer.register({
    kind: 'exact',
    path: `${prefix}/raw`,
    handler: async (req, res) => {
      const id = queryParam(req, 'id')
      if (!id) {
        writeText(res, 400, 'text/plain; charset=utf-8', '缺少 id 参数')
        return
      }
      try {
        const found = await registry.readBytes(id)
        if (!found) {
          writeText(res, 404, 'text/plain; charset=utf-8', `找不到图像：${id}`)
          return
        }
        const r = res as {
          writeHead(status: number, headers: Record<string, string>): void
          end(body: Uint8Array): void
        }
        r.writeHead(200, {
          'Content-Type': 'image/png',
          'Content-Length': String(found.data.length),
          'Cache-Control': 'public, max-age=31536000, immutable', // 内容寻址，可长缓存
        })
        r.end(found.data)
      } catch (err) {
        writeText(res, 500, 'text/plain; charset=utf-8', `读取失败：${(err as Error).message}`)
      }
    },
  })

  // ---- 缩略图（历史相册网格用）----
  // 网格里几十张图若每张都拉整张 1024² PNG（约 1MB），回顾会很慢。
  // 缩略图由 worker 在**存图时**生成（<id>.thumb.png，长边 ≤384，PIL 已在进程内，零新依赖）；
  // 早期生成的图没有缩略图 → 回退原图，宁可慢一点也不留空白格。
  webServer.register({
    kind: 'exact',
    path: `${prefix}/thumb`,
    handler: async (req, res) => {
      const id = queryParam(req, 'id')
      if (!id) {
        writeText(res, 400, 'text/plain; charset=utf-8', '缺少 id 参数')
        return
      }
      try {
        const found = await registry.readThumbBytes(id)
        if (!found) {
          writeText(res, 404, 'text/plain; charset=utf-8', `找不到图像：${id}`)
          return
        }
        const r = res as {
          writeHead(status: number, headers: Record<string, string>): void
          end(body: Uint8Array): void
        }
        r.writeHead(200, {
          // 媒体类型来自实际文件：缩略图优先 WebP（≈PNG 的 1/6），可能回退 PNG
          'Content-Type': found.mediaType,
          'Content-Length': String(found.data.length),
          'Cache-Control': 'public, max-age=31536000, immutable',
          // 便于诊断：这张走的是缩略图还是原图回退
          'X-Qwen-Image-Thumb': found.isThumb ? 'thumb' : 'fallback-raw',
        })
        r.end(found.data)
      } catch (err) {
        writeText(res, 500, 'text/plain; charset=utf-8', `读取失败：${(err as Error).message}`)
      }
    },
  })

  // ---- 画廊列表（查询 + 排序 + 分页 + 计数）----
  webServer.register({
    kind: 'exact',
    path: `${prefix}/gallery.json`,
    handler: (req, res) => {
      const opts = parseQueryOptions(req)
      const { items, total } = registry.query(opts)
      writeJson(res, 200, {
        count: items.length,
        total,
        // 计数与列表一次带回：界面刷新筛选面板不必再多一个来回
        facets: registry.facets(),
        applied: opts,
        items: items.map((r) => toGalleryItem(prefix, r)),
      })
    },
  })

  // ---- 仅筛选计数（面板单独刷新用；画廊响应里也会带一份）----
  webServer.register({
    kind: 'exact',
    path: `${prefix}/facets`,
    handler: (_req, res) => {
      writeJson(res, 200, registry.facets())
    },
  })

  // ---- 改：提示词 / 标签 / 收藏 / 备注 ----
  webServer.register({
    kind: 'exact',
    path: `${prefix}/update`,
    handler: async (req, res) => {
      const body = await bodyOrQuery(req)
      const ids = idList(body)
      if (!ids.length) {
        writeJson(res, 400, { error: '缺少 ids' })
        return
      }
      const patch = {
        prompt: typeof body.prompt === 'string' ? body.prompt : undefined,
        note: typeof body.note === 'string' ? body.note : undefined,
        favorite: boolOrUndefined(body.favorite),
        tags: strList(body.tags),
        tagsAdd: strList(body.tagsAdd),
        tagsRemove: strList(body.tagsRemove),
      }
      const r = await registry.updateMany(ids, patch)
      writeJson(res, 200, {
        ok: r.missing.length === 0,
        updated: r.updated.map((x) => x.id),
        missing: r.missing,
        // 回传新状态，界面可以直接就地把卡片改掉（省一次全量刷新）
        items: r.updated.map((x) => toGalleryItem(prefix, x)),
        facets: registry.facets(),
      })
    },
  })

  // ---- 删：默认进回收站，purge 才真删 ----
  webServer.register({
    kind: 'exact',
    path: `${prefix}/delete`,
    handler: async (req, res) => {
      const body = await bodyOrQuery(req)
      const ids = idList(body)
      if (!ids.length) {
        writeJson(res, 400, { error: '缺少 ids' })
        return
      }
      const purge = boolOrUndefined(body.purge) === true
      const r = await registry.removeMany(ids, { purge })
      writeJson(res, 200, {
        ok: r.failed.length === 0,
        deleted: r.deleted,
        missing: r.missing,
        failed: r.failed,
        purged: purge,
        trashDir: r.trashDir,
        trashCount: registry.listTrash().length,
        facets: registry.facets(),
      })
    },
  })

  // ---- 回收站 ----
  webServer.register({
    kind: 'exact',
    path: `${prefix}/trash.json`,
    handler: (_req, res) => {
      const items = registry.listTrash().map((e) => ({
        id: e.id,
        deletedAt: e.deletedAt,
        trashDir: e.trashDir,
        width: e.record.width,
        height: e.record.height,
        prompt: e.record.prompt,
        kind: e.record.kind,
        tags: e.record.tags ?? [],
        favorite: !!e.record.favorite,
        /** 原文件是否真的被搬进回收站（若已被手工删除则为 false，只能还原记录） */
        hasFile: !!e.moved.file,
      }))
      writeJson(res, 200, { count: items.length, items })
    },
  })

  webServer.register({
    kind: 'exact',
    path: `${prefix}/restore`,
    handler: async (req, res) => {
      const body = await bodyOrQuery(req)
      const ids = idList(body)
      if (!ids.length) {
        writeJson(res, 400, { error: '缺少 ids' })
        return
      }
      const r = await registry.restoreMany(ids)
      writeJson(res, 200, {
        ok: r.failed.length === 0,
        restored: r.restored,
        missing: r.missing,
        failed: r.failed,
        trashCount: registry.listTrash().length,
        facets: registry.facets(),
      })
    },
  })

  // ---- 产物目录扫描 / 恢复 ----
  // 把「磁盘上有、注册表里没有」的作品补录回来：宿主侧在入库前出错（background 登记失败、
  // 崩溃、插件卸载）会留下孤儿图；manifest 损坏时它也是从 sidecar 重建相册的通道。
  webServer.register({
    kind: 'exact',
    path: `${prefix}/recover`,
    handler: async (_req, res) => {
      const r = await registry.recoverFromDisk()
      writeJson(res, 200, {
        ok: true,
        added: r.added,
        addedCount: r.added.length,
        scanned: r.scanned,
        skipped: r.skipped,
        facets: registry.facets(),
      })
    },
  })

  // ---- 单张元信息 ----
  webServer.register({
    kind: 'exact',
    path: `${prefix}/meta`,
    handler: (req, res) => {
      const id = queryParam(req, 'id')
      if (!id) {
        writeJson(res, 400, { error: '缺少 id 参数' })
        return
      }
      const rec = registry.get(id)
      if (!rec) {
        writeJson(res, 404, { error: `找不到图像：${id}` })
        return
      }
      writeJson(res, 200, rec)
    },
  })

  // ---- 取消 ----
  webServer.register({
    kind: 'exact',
    path: `${prefix}/cancel`,
    handler: async (req, res) => {
      const job = queryParam(req, 'job')
      const client = manager.getClient()
      if (!job || !client) {
        writeJson(res, 200, { cancelled: false, detail: job ? 'worker 未启动' : '缺少 job 参数' })
        return
      }
      try {
        const r = await client.cancel(job)
        writeJson(res, 200, r)
      } catch (err) {
        writeJson(res, 500, { cancelled: false, error: (err as Error).message })
      }
    },
  })

  // ---- 卸载模型释放显存（历史相册页脚的「释放显存」按钮）----
  webServer.register({
    kind: 'exact',
    path: `${prefix}/unload`,
    handler: async (_req, res) => {
      const client = manager.getClient()
      if (!client) {
        writeJson(res, 200, { unloaded: false, detail: 'worker 未启动' })
        return
      }
      try {
        const r = await client.unload()
        writeJson(res, 200, r)
      } catch (err) {
        writeJson(res, 500, { unloaded: false, error: (err as Error).message })
      }
    },
  })

  // ---- 插件侧状态（供画室页轮询）----
  webServer.register({
    kind: 'exact',
    path: `${prefix}/health`,
    handler: async (_req, res) => {
      const ms = manager.getStatus()
      const h = await manager.tryHealth()
      writeJson(res, 200, {
        manager: ms,
        worker: h ?? null,
        presets: { draft: '768²/12步', standard: '1024²/24步', native: '2048²/40步' },
        galleryCount: registry.all().length,
        trashCount: registry.listTrash().length,
      })
    },
  })
}

// ---------------------------------------------------------------------------
// 响应辅助
// ---------------------------------------------------------------------------
function queryParam(req: unknown, name: string): string | undefined {
  const r = req as { url?: string }
  if (!r.url) return undefined
  try {
    const u = new URL(r.url, 'http://127.0.0.1')
    return u.searchParams.get(name) ?? undefined
  } catch {
    return undefined
  }
}

/** 记录 → 相册条目（单一出口，列表/改/删/还原都用它，避免字段漂移）。 */
function toGalleryItem(prefix: string, r: ImageRecord) {
  return {
    id: r.id,
    rawUrl: `${prefix}/raw?id=${encodeURIComponent(r.id)}`,
    thumbUrl: `${prefix}/thumb?id=${encodeURIComponent(r.id)}`,
    hasThumb: !!r.thumb,
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
    // ---- 相册增强 ----
    tags: r.tags ?? [],
    favorite: !!r.favorite,
    note: r.note,
    promptEdited: !!r.promptEdited,
  }
}

/** 解析画廊查询参数（排序字段走白名单，避免任意 key 打进来）。 */
function parseQueryOptions(req: unknown): QueryOptions {
  const num = (name: string): number | undefined => {
    const v = queryParam(req, name)
    if (v == null || v === '') return undefined
    const n = Number(v)
    if (Number.isFinite(n)) return n
    // 日期字符串也接受（界面之外手敲 URL 时方便）
    const t = Date.parse(v)
    return Number.isFinite(t) ? t : undefined
  }
  const sortRaw = queryParam(req, 'sort')
  const sort = (SORT_KEYS as string[]).includes(sortRaw ?? '') ? (sortRaw as SortKey) : 'createdAt'
  const tags = (queryParam(req, 'tag') ?? queryParam(req, 'tags') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const favRaw = queryParam(req, 'fav')
  return {
    q: queryParam(req, 'q') || undefined,
    kind: queryParam(req, 'kind') || undefined,
    tags,
    fav: favRaw === '1' || favRaw === 'true',
    size: num('size'),
    from: num('from'),
    to: num('to'),
    sort,
    order: queryParam(req, 'order') === 'asc' ? 'asc' : 'desc',
    limit: num('limit') ?? 200,
    offset: num('offset') ?? 0,
  }
}

/** 写接口入参：query 铺底 + JSON body 覆盖（body 优先）。 */
async function bodyOrQuery(req: unknown): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {}
  const r = req as { url?: string }
  if (r.url) {
    try {
      const u = new URL(r.url, 'http://127.0.0.1')
      for (const [k, v] of u.searchParams) out[k] = v
    } catch {
      /* 非法 URL 就当没有 query */
    }
  }
  const body = await readJsonBody(req)
  return { ...out, ...body }
}

/** 读 JSON body（异步迭代流；超限或非法一律当空对象，绝不抛）。 */
async function readJsonBody(req: unknown, maxBytes = 1 << 20): Promise<Record<string, unknown>> {
  const r = req as { [Symbol.asyncIterator]?: () => AsyncIterator<Buffer | string> }
  if (typeof r?.[Symbol.asyncIterator] !== 'function') return {}
  const chunks: Buffer[] = []
  let size = 0
  try {
    for await (const chunk of r as AsyncIterable<Buffer | string>) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
      size += buf.length
      if (size > maxBytes) return {}
      chunks.push(buf)
    }
  } catch {
    return {}
  }
  if (!chunks.length) return {}
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function idList(body: Record<string, unknown>): string[] {
  const raw = body.ids ?? body.id
  if (Array.isArray(raw)) return raw.map((x) => String(x).trim()).filter(Boolean)
  if (typeof raw === 'string') return raw.split(',').map((s) => s.trim()).filter(Boolean)
  return []
}

function strList(v: unknown): string[] | undefined {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean)
  if (typeof v === 'string') return v.split(',').map((s) => s.trim()).filter(Boolean)
  return undefined
}

function boolOrUndefined(v: unknown): boolean | undefined {
  if (typeof v === 'boolean') return v
  if (typeof v === 'number') return v !== 0
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase()
    if (s === '1' || s === 'true' || s === 'yes') return true
    if (s === '0' || s === 'false' || s === 'no' || s === '') return false
  }
  return undefined
}

function writeJson(res: unknown, status: number, payload: unknown): void {
  writeText(res, status, 'application/json; charset=utf-8', JSON.stringify(payload))
}

function writeText(res: unknown, status: number, contentType: string, body: string): void {
  const r = res as {
    writeHead(status: number, headers: Record<string, string>): void
    end(body: string): void
  }
  const buf = Buffer.from(body, 'utf8')
  r.writeHead(status, { 'Content-Type': contentType, 'Content-Length': String(buf.length) })
  r.end(body)
}
