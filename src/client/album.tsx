import * as React from 'react'
import {
  deleteImages,
  fetchGallery,
  fetchHealth,
  fetchTrash,
  formatBytes,
  formatDuration,
  relativeTime,
  recoverImages,
  requestUnload,
  restoreImages,
  thumbUrl,
  rawUrl,
  updateImages,
  type AlbumFacets,
  type GalleryItem,
  type SortKey,
  type TrashItem,
  type WorkerHealth,
} from './api'

/**
 * 「相册」视图（`conversation.view`，id = qwen-image，label = 相册）。
 *
 * ── 定位 ───────────────────────────────────────────────────────────────
 * 生图/改图的**主路径仍在对话里**（用户说需求 → LLM 扩写提示词 → 出图；
 * 要用历史图当输入时由 LLM 在上下文里挑）。相册负责另一半：
 * **回头翻、找得到、管得住**。
 *
 * 能力（v2 增强）：
 *   · 查询：提示词 / id / seed / 标签 / 备注 全文；时间范围；类型；尺寸；标签组合
 *   · 排序：时间 / 大小 / 步数 / 耗时 / 尺寸 / seed / 编号，升降序切换
 *   · 分类：按日期 / 标签 / 类型 / 尺寸分组，筛选面板带**全量计数**
 *   · 改：编辑提示词、备注、标签（单个或批量）、收藏
 *   · 删：删除（**默认移入回收站可还原**）、回收站还原、彻底删除
 *
 * ── 取舍 ───────────────────────────────────────────────────────────────
 *   · 不做生图/改图的表单：那是对话的事，做了就有两套入口、两套语义
 *   · 筛选/排序/计数走宿主 `/gallery.json`：完整历史以 manifest 为准，
 *     必须在**全量**上算，客户端只渲染拿到的这一页
 *   · 删除一律先入回收站：产物是用户的作品，误删必须可后悔
 *
 * 槽位契约（本机 slot 树实测）：`conversation.view` 是 list，
 * 注册项为 { id(必填), order?, label? }。
 */

const h = React.createElement

const CHECKER =
  'linear-gradient(45deg,#8884 25%,transparent 25%),linear-gradient(-45deg,#8884 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#8884 75%),linear-gradient(-45deg,transparent 75%,#8884 75%)'

const SORTS: { key: SortKey; label: string }[] = [
  { key: 'createdAt', label: '时间' },
  { key: 'bytes', label: '文件大小' },
  { key: 'steps', label: '步数' },
  { key: 'elapsedSec', label: '耗时' },
  { key: 'width', label: '宽度' },
  { key: 'seed', label: 'seed' },
  { key: 'id', label: '编号' },
]

type GroupKey = 'none' | 'day' | 'tag' | 'kind' | 'size'

const GROUPS: { key: GroupKey; label: string }[] = [
  { key: 'day', label: '按日期' },
  { key: 'tag', label: '按标签' },
  { key: 'kind', label: '按类型' },
  { key: 'size', label: '按尺寸' },
  { key: 'none', label: '不分组' },
]

const RANGES: { days?: number; label: string }[] = [
  { days: undefined, label: '全部时间' },
  { days: 1, label: '今天' },
  { days: 7, label: '近 7 天' },
  { days: 30, label: '近 30 天' },
]

interface ViewProps {
  sessionId?: string
}

export function AlbumView(_props: ViewProps) {
  const [items, setItems] = React.useState<GalleryItem[]>([])
  const [facets, setFacets] = React.useState<AlbumFacets | null>(null)
  const [total, setTotal] = React.useState(0)
  const [health, setHealth] = React.useState<WorkerHealth | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [toast, setToast] = React.useState<string | null>(null)
  const [loading, setLoading] = React.useState(true)

  // ---- 查询条件 ----
  const [q, setQ] = React.useState('')
  const [dq, setDq] = React.useState('')
  const [sort, setSort] = React.useState<SortKey>('createdAt')
  const [order, setOrder] = React.useState<'asc' | 'desc'>('desc')
  const [group, setGroup] = React.useState<GroupKey>('day')
  const [kind, setKind] = React.useState('')
  const [size, setSize] = React.useState<number | undefined>(undefined)
  const [tagFilter, setTagFilter] = React.useState<string[]>([])
  const [favOnly, setFavOnly] = React.useState(false)
  const [rangeDays, setRangeDays] = React.useState<number | undefined>(undefined)

  // ---- 选择与弹窗 ----
  const [selectMode, setSelectMode] = React.useState(false)
  const [selected, setSelected] = React.useState<string[]>([])
  const [openId, setOpenId] = React.useState<string | null>(null)
  const [tagDialog, setTagDialog] = React.useState<{ ids: string[] } | null>(null)
  const [promptDialog, setPromptDialog] = React.useState<GalleryItem | null>(null)
  const [confirmDel, setConfirmDel] = React.useState<string[] | null>(null)
  const [trashOpen, setTrashOpen] = React.useState(false)

  const flash = React.useCallback((msg: string) => {
    setToast(msg)
    window.setTimeout(() => setToast((cur) => (cur === msg ? null : cur)), 2600)
  }, [])

  // 搜索防抖：每敲一个字就打后端会白跑很多次
  React.useEffect(() => {
    const t = window.setTimeout(() => setDq(q.trim()), 250)
    return () => window.clearTimeout(t)
  }, [q])

  const refresh = React.useCallback(async () => {
    try {
      const from = rangeDays ? Date.now() - rangeDays * 86400_000 : undefined
      const g = await fetchGallery({
        q: dq || undefined,
        kind: kind || undefined,
        tags: tagFilter.length ? tagFilter : undefined,
        fav: favOnly || undefined,
        size,
        from,
        sort,
        order,
        limit: 500,
      })
      setItems(g.items ?? [])
      setFacets(g.facets ?? null)
      setTotal(g.total ?? (g.items?.length ?? 0))
      setError(null)
      const hh = await fetchHealth().catch(() => null)
      setHealth(hh)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }, [dq, kind, tagFilter, favOnly, size, rangeDays, sort, order])

  React.useEffect(() => {
    void refresh()
  }, [refresh])

  // 相册是回顾用的：低频轮询即可，不必实时
  React.useEffect(() => {
    const id = window.setInterval(() => void refresh(), 15000)
    return () => window.clearInterval(id)
  }, [refresh])

  // 选择集随列表收敛，避免删掉的 id 一直挂在「已选」里
  React.useEffect(() => {
    setSelected((prev) => {
      const alive = prev.filter((id) => items.some((it) => it.id === id))
      return alive.length === prev.length ? prev : alive
    })
  }, [items])

  /** 用宿主回传的新记录就地更新，省一次全量刷新。 */
  const patchLocal = React.useCallback((updated: GalleryItem[], newFacets?: AlbumFacets) => {
    setItems((prev) => prev.map((it) => updated.find((u) => u.id === it.id) ?? it))
    if (newFacets) setFacets(newFacets)
  }, [])

  const toggleFav = React.useCallback(
    async (it: GalleryItem) => {
      try {
        const r = await updateImages({ ids: [it.id], favorite: !it.favorite })
        patchLocal(r.items ?? [], r.facets)
        flash(!it.favorite ? `已收藏 ${it.id}` : `已取消收藏 ${it.id}`)
      } catch (err) {
        flash(`收藏失败：${(err as Error).message}`)
      }
    },
    [patchLocal, flash],
  )

  const applyTags = React.useCallback(
    async (ids: string[], add: string[], remove: string[] = []) => {
      try {
        const r = await updateImages({ ids, tagsAdd: add, tagsRemove: remove })
        patchLocal(r.items ?? [], r.facets)
        flash(`已更新 ${r.updated?.length ?? 0} 张的标签`)
      } catch (err) {
        flash(`标签更新失败：${(err as Error).message}`)
      }
    },
    [patchLocal, flash],
  )

  const doDelete = React.useCallback(
    async (ids: string[], purge = false) => {
      try {
        const r = await deleteImages(ids, purge)
        setItems((prev) => prev.filter((it) => !r.deleted.includes(it.id)))
        setSelected([])
        if (r.facets) setFacets(r.facets)
        setTotal((t) => Math.max(0, t - r.deleted.length))
        flash(
          purge
            ? `已彻底删除 ${r.deleted.length} 张`
            : `已移入回收站 ${r.deleted.length} 张（可还原）`,
        )
        void refresh()
      } catch (err) {
        flash(`删除失败：${(err as Error).message}`)
      }
    },
    [flash, refresh],
  )

  const toggleSelected = React.useCallback((id: string) => {
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  }, [])

  /** 批量收藏/取消收藏（错误必须冒到 toast，不能变成未处理的 rejection）。 */
  const setFavBatch = React.useCallback(
    async (value: boolean) => {
      if (!selected.length) return
      try {
        const r = await updateImages({ ids: selected, favorite: value })
        patchLocal(r.items ?? [], r.facets)
        flash(`${value ? '已收藏' : '已取消收藏'} ${r.updated?.length ?? 0} 张`)
      } catch (err) {
        flash(`操作失败：${(err as Error).message}`)
      }
    },
    [selected, patchLocal, flash],
  )

  const groups = React.useMemo(() => groupItems(items, group), [items, group])
  const selectedSet = React.useMemo(() => new Set(selected), [selected])
  const openIdx = openId ? items.findIndex((x) => x.id === openId) : -1
  const open = openIdx >= 0 ? items[openIdx] : null
  const workerState = health?.worker?.state ?? health?.manager?.state ?? '未启动'
  const vramFree = health?.worker?.vram?.free
  const anyFilter = !!(dq || kind || size || tagFilter.length || favOnly || rangeDays)

  return h(
    'div',
    { className: 'qw-album' },

    // ═══ 顶栏：标题 / 搜索 / 排序 / 分组 / 选择 ═══
    h(
      'header',
      { className: 'qw-album__head' },
      h(
        'div',
        { className: 'qw-album__titlebox' },
        h('h2', { className: 'qw-album__title' }, '历史相册'),
        h(
          'span',
          { className: 'qw-album__sub' },
          [
            `共 ${facets?.total ?? items.length} 张`,
            anyFilter ? `显示 ${total} 张` : null,
            selected.length ? `已选 ${selected.length} 张` : null,
          ]
            .filter(Boolean)
            .join(' · '),
        ),
      ),
      h('input', {
        className: 'qw-album__search',
        type: 'search',
        value: q,
        placeholder: '搜索提示词 / id / seed / 标签 / 备注…',
        onChange: (e: React.ChangeEvent<HTMLInputElement>) => setQ(e.target.value),
      }),
      h(
        'label',
        { className: 'qw-field', title: '排序字段' },
        h('span', { className: 'qw-field__label' }, '排序'),
        h(
          'select',
          {
            className: 'qw-select',
            value: sort,
            onChange: (e: React.ChangeEvent<HTMLSelectElement>) => setSort(e.target.value as SortKey),
          },
          SORTS.map((s) => h('option', { key: s.key, value: s.key }, s.label)),
        ),
      ),
      h(
        'button',
        {
          className: 'qw-btn qw-btn--mini',
          title: order === 'desc' ? '当前：新→旧（点击切换）' : '当前：旧→新（点击切换）',
          onClick: () => setOrder((o) => (o === 'desc' ? 'asc' : 'desc')),
        },
        order === 'desc' ? '↓ 降序' : '↑ 升序',
      ),
      h(
        'label',
        { className: 'qw-field', title: '分组（分类）方式' },
        h('span', { className: 'qw-field__label' }, '分组'),
        h(
          'select',
          {
            className: 'qw-select',
            value: group,
            onChange: (e: React.ChangeEvent<HTMLSelectElement>) => setGroup(e.target.value as GroupKey),
          },
          GROUPS.map((g) => h('option', { key: g.key, value: g.key }, g.label)),
        ),
      ),
      h(
        'button',
        {
          className: selectMode ? 'qw-btn qw-btn--mini qw-btn--on' : 'qw-btn qw-btn--mini',
          onClick: () => {
            setSelectMode((v) => !v)
            setSelected([])
          },
        },
        selectMode ? '退出选择' : '选择',
      ),
      h('button', { className: 'qw-btn qw-btn--mini', onClick: () => void refresh() }, '刷新'),
    ),

    // ═══ 筛选条（计数取全量，不受当前筛选影响）═══
    h(
      'div',
      { className: 'qw-filters' },
      chip('fav', '★ 收藏', facets?.favorites ?? 0, favOnly, () => setFavOnly((v) => !v)),
      sep(),
      h('span', { className: 'qw-filters__label' }, '类型'),
      chip('kind', '全部', facets?.total ?? 0, !kind, () => setKind('')),
      ...(facets?.kinds ?? []).map((k) =>
        chip('kind', kindLabel(k.key), k.count, kind === k.key, () => setKind(kind === k.key ? '' : k.key)),
      ),
      sep(),
      h('span', { className: 'qw-filters__label' }, '尺寸'),
      chip('size', '全部', facets?.total ?? 0, size == null, () => setSize(undefined)),
      ...(facets?.sizes ?? []).map((s) =>
        chip('size', `${s.key}²`, s.count, size === s.key, () => setSize(size === s.key ? undefined : s.key)),
      ),
      sep(),
      h('span', { className: 'qw-filters__label' }, '时间'),
      ...RANGES.map((r) =>
        chip('range', r.label, 0, rangeDays === r.days, () => setRangeDays(r.days), true),
      ),
      (facets?.tags?.length ?? 0) > 0 ? sep() : null,
      (facets?.tags?.length ?? 0) > 0 ? h('span', { className: 'qw-filters__label' }, '标签') : null,
      ...(facets?.tags ?? []).map((t) =>
        chip('tag', t.key, t.count, tagFilter.includes(t.key), () =>
          setTagFilter((prev) =>
            prev.includes(t.key) ? prev.filter((x) => x !== t.key) : [...prev, t.key],
          ),
        ),
      ),
      anyFilter
        ? h(
            'button',
            {
              className: 'qw-btn qw-btn--mini qw-btn--ghost',
              onClick: () => {
                setQ('')
                setKind('')
                setSize(undefined)
                setTagFilter([])
                setFavOnly(false)
                setRangeDays(undefined)
              },
            },
            '清除筛选',
          )
        : null,
    ),

    // ═══ 批量操作条 ═══
    selectMode || selected.length
      ? h(
          'div',
          { className: 'qw-batch' },
          h('span', { className: 'qw-batch__count' }, `已选 ${selected.length} / ${items.length} 张`),
          h(
            'button',
            {
              className: 'qw-btn qw-btn--mini',
              onClick: () => setSelected(items.map((it) => it.id)),
            },
            '全选当前列表',
          ),
          h('button', { className: 'qw-btn qw-btn--mini', onClick: () => setSelected([]) }, '清除选择'),
          h(
            'button',
            {
              className: 'qw-btn qw-btn--mini',
              disabled: !selected.length,
              onClick: () => setTagDialog({ ids: selected }),
            },
            '加标签',
          ),
          h(
            'button',
            {
              className: 'qw-btn qw-btn--mini',
              disabled: !selected.length,
              onClick: () => void setFavBatch(true),
            },
            '收藏',
          ),
          h(
            'button',
            {
              className: 'qw-btn qw-btn--mini',
              disabled: !selected.length,
              onClick: () => void setFavBatch(false),
            },
            '取消收藏',
          ),
          h(
            'button',
            {
              className: 'qw-btn qw-btn--mini qw-btn--danger',
              disabled: !selected.length,
              onClick: () => setConfirmDel(selected),
            },
            '删除',
          ),
        )
      : null,

    error ? h('div', { className: 'qw-alert' }, error) : null,
    loading && !items.length ? h('div', { className: 'qw-empty' }, '载入中…') : null,

    !loading && !items.length && !error
      ? h(
          'div',
          { className: 'qw-empty' },
          anyFilter
            ? '没有符合当前筛选条件的作品。'
            : '还没有作品。回到对话里说一句「画一只戴墨镜的柴犬」就会出现在这里。',
        )
      : null,

    // ═══ 分组网格 ═══
    groups.map((g) =>
      h(
        'section',
        { className: 'qw-grp', key: g.key },
        group !== 'none'
          ? h(
              'h3',
              { className: 'qw-grp__head' },
              h('span', null, g.label),
              h('span', { className: 'qw-grp__count' }, `${g.items.length} 张`),
            )
          : null,
        h(
          'div',
          { className: 'qw-album__grid' },
          g.items.map((it) =>
            h(Tile, {
              key: it.id,
              item: it,
              selected: selectedSet.has(it.id),
              selectMode,
              onOpen: () => setOpenId(it.id),
              onToggleSelect: () => toggleSelected(it.id),
              onToggleFav: () => void toggleFav(it),
              onEditPrompt: () => setPromptDialog(it),
              onAddTag: (t: string) => void applyTags([it.id], [t]),
              onDelete: () => setConfirmDel([it.id]),
              onFilterTag: (t: string) =>
                setTagFilter((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t])),
            }),
          ),
        ),
      ),
    ),

    // ═══ 页脚 ═══
    h(
      'footer',
      { className: 'qw-album__foot' },
      h(
        'span',
        { className: 'qw-album__foot-item' },
        `worker：${workerState}`,
        vramFree != null ? `，空闲显存 ${(vramFree / 1024).toFixed(1)}G` : '',
      ),
      h(
        'button',
        {
          className: 'qw-btn qw-btn--mini',
          title: '删除默认只是移入回收站；这里可以把误删的作品整条还原',
          onClick: () => setTrashOpen(true),
        },
        `回收站${health?.trashCount ? `（${health.trashCount}）` : ''}`,
      ),
      h(
        'button',
        {
          className: 'qw-btn qw-btn--mini',
          title:
            '扫描产物目录：把「磁盘上有、相册里没有」的作品补录进来（宿主在入库前出错留下的孤儿图；manifest 损坏时也是重建通道）',
          onClick: async () => {
            try {
              const r = await recoverImages()
              flash(
                r.addedCount
                  ? `补录了 ${r.addedCount} 张：${r.added.join('、')}`
                  : `扫描 ${r.scanned} 个 sidecar，没有孤儿作品`,
              )
              if (r.addedCount) void refresh()
            } catch (err) {
              flash(`扫描失败：${(err as Error).message}`)
            }
          },
        },
        '扫描产物',
      ),
      h(
        'button',
        {
          className: 'qw-btn qw-btn--mini',
          title: '卸载模型，把显存还给其它程序（如 llama-server）',
          onClick: async () => {
            await requestUnload().catch(() => {})
            flash('已请求卸载模型')
            void refresh()
          },
        },
        '释放显存',
      ),
      h('span', { className: 'qw-album__foot-hint' }, '生成与改图请直接在对话里说'),

      // 回收站：默认删除是「移入回收站」，这里给后悔药
      trashOpen
        ? h(TrashPanel, {
            onClose: () => setTrashOpen(false),
            onRestored: () => {
              flash('已还原')
              void refresh()
            },
            onPurge: (ids: string[]) => void doDelete(ids, true),
          })
        : null,
    ),

    // ═══ 灯箱 ═══
    open
      ? h(Lightbox, {
          item: open,
          onClose: () => setOpenId(null),
          onPrev: openIdx > 0 ? () => setOpenId(items[openIdx - 1].id) : undefined,
          onNext: openIdx < items.length - 1 ? () => setOpenId(items[openIdx + 1].id) : undefined,
          onToggleFav: () => void toggleFav(open),
          onAddTag: (t: string) => void applyTags([open.id], [t]),
          onRemoveTag: (t: string) => void applyTags([open.id], [], [t]),
          onEditPrompt: () => setPromptDialog(open),
          onDelete: () => setConfirmDel([open.id]),
        })
      : null,

    // ═══ 弹窗 ═══
    tagDialog
      ? h(TagDialog, {
          count: tagDialog.ids.length,
          known: facets?.tags?.map((t) => t.key) ?? [],
          onCancel: () => setTagDialog(null),
          onSubmit: (tags: string[]) => {
            const ids = tagDialog.ids
            setTagDialog(null)
            if (tags.length) void applyTags(ids, tags)
          },
        })
      : null,

    promptDialog
      ? h(PromptDialog, {
          item: promptDialog,
          onCancel: () => setPromptDialog(null),
          onSubmit: async (patch: { prompt: string; note: string }) => {
            const id = promptDialog.id
            setPromptDialog(null)
            try {
              const r = await updateImages({ ids: [id], prompt: patch.prompt, note: patch.note })
              patchLocal(r.items ?? [], r.facets)
              flash(`已保存 ${id} 的修改`)
            } catch (err) {
              flash(`保存失败：${(err as Error).message}`)
            }
          },
        })
      : null,

    confirmDel
      ? h(ConfirmDialog, {
          title: `删除 ${confirmDel.length} 张？`,
          message: '默认移入回收站（可还原）；只有「彻底删除」才会真的从磁盘抹掉。',
          confirmLabel: '移入回收站',
          danger: true,
          onCancel: () => setConfirmDel(null),
          onConfirm: () => {
            const ids = confirmDel
            setConfirmDel(null)
            void doDelete(ids, false)
          },
        })
      : null,

    toast ? h('div', { className: 'qw-toast' }, toast) : null,
  )
}

// ---------------------------------------------------------------------------
// 瓦片
// ---------------------------------------------------------------------------
interface TileProps {
  item: GalleryItem
  selected: boolean
  selectMode: boolean
  onOpen: () => void
  onToggleSelect: () => void
  onToggleFav: () => void
  onEditPrompt: () => void
  onAddTag: (t: string) => void
  onDelete: () => void
  onFilterTag: (t: string) => void
}

function Tile(props: TileProps) {
  const { item: it, selected, selectMode } = props
  const stop = (fn: () => void) => (e: React.MouseEvent) => {
    e.stopPropagation()
    fn()
  }
  const tags = it.tags ?? []
  return h(
    'figure',
    {
      className: `qw-tile${selected ? ' qw-tile--sel' : ''}`,
      title: it.prompt,
      onClick: () => (selectMode ? props.onToggleSelect() : props.onOpen()),
    },
    h(
      'div',
      { className: 'qw-tile__wrap' },
      h('img', {
        className: 'qw-tile__img',
        src: thumbUrl(it.id),
        alt: it.prompt || it.id,
        loading: 'lazy',
        decoding: 'async',
        style: it.hasAlpha ? { backgroundImage: CHECKER } : undefined,
      }),
      it.favorite ? h('span', { className: 'qw-tile__star', title: '已收藏' }, '★') : null,
      it.promptEdited ? h('span', { className: 'qw-tile__flag', title: '提示词或元数据被手工改过' }, '✎') : null,
      selectMode
        ? h('input', {
            type: 'checkbox',
            className: 'qw-tile__check',
            checked: selected,
            onChange: () => props.onToggleSelect(),
            onClick: (e: React.MouseEvent) => e.stopPropagation(),
          })
        : null,
      h(
        'div',
        { className: 'qw-tile__hover' },
        h('button', { className: 'qw-btn qw-btn--mini', onClick: stop(props.onToggleFav) }, it.favorite ? '取消收藏' : '收藏'),
        h('button', { className: 'qw-btn qw-btn--mini', onClick: stop(props.onEditPrompt) }, '改'),
        h('button', { className: 'qw-btn qw-btn--mini qw-btn--danger', onClick: stop(props.onDelete) }, '删'),
      ),
    ),
    h(
      'figcaption',
      { className: 'qw-tile__cap' },
      h('span', { className: 'qw-tile__prompt' }, it.prompt || '（无提示词）'),
      tags.length
        ? h(
            'span',
            { className: 'qw-tile__tags' },
            tags.slice(0, 3).map((t) =>
              h(
                'em',
                { key: t, className: 'qw-tag', title: `按标签「${t}」筛选`, onClick: stop(() => props.onFilterTag(t)) },
                t,
              ),
            ),
            tags.length > 3 ? h('em', { className: 'qw-tag qw-tag--more' }, `+${tags.length - 3}`) : null,
          )
        : null,
      h(
        'span',
        { className: 'qw-tile__meta' },
        [
          `${it.width}×${it.height}`,
          it.steps ? `${it.steps}步` : null,
          relativeTime(it.createdAt),
          it.kind === 'edit' ? '改图' : null,
          it.hasAlpha ? 'RGBA' : null,
        ]
          .filter(Boolean)
          .join(' · '),
      ),
    ),
  )
}

// ---------------------------------------------------------------------------
// 灯箱
// ---------------------------------------------------------------------------
interface LightboxProps {
  item: GalleryItem
  onClose: () => void
  onPrev?: () => void
  onNext?: () => void
  onToggleFav: () => void
  onAddTag: (t: string) => void
  onRemoveTag: (t: string) => void
  onEditPrompt: () => void
  onDelete: () => void
}

function Lightbox(props: LightboxProps) {
  const { item, onClose, onPrev, onNext } = props
  const [copied, setCopied] = React.useState<string | null>(null)
  const [tagInput, setTagInput] = React.useState('')

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      if (e.key === 'ArrowLeft' && onPrev) onPrev()
      if (e.key === 'ArrowRight' && onNext) onNext()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, onPrev, onNext])

  const copy = (label: string, text: string) => {
    void navigator.clipboard?.writeText(text).then(
      () => {
        setCopied(label)
        window.setTimeout(() => setCopied(null), 1500)
      },
      () => {},
    )
  }

  const stop = (fn: () => void) => (e: React.MouseEvent) => {
    e.stopPropagation()
    fn()
  }

  const tags = item.tags ?? []

  return h(
    'div',
    { className: 'qw-lightbox', onClick: onClose },
    h('img', { className: 'qw-lightbox__img', src: rawUrl(item.id), alt: item.prompt }),
    h(
      'div',
      { className: 'qw-lightbox__panel', onClick: (e: React.MouseEvent) => e.stopPropagation() },
      h('div', { className: 'qw-lightbox__prompt' }, item.prompt || '（无提示词）'),
      item.note ? h('div', { className: 'qw-lightbox__note' }, `备注：${item.note}`) : null,
      h(
        'div',
        { className: 'qw-lightbox__facts' },
        [
          `${item.width}×${item.height}`,
          `${item.steps} 步`,
          `seed ${item.seed}`,
          formatDuration(item.elapsedSec),
          item.steadyStepSec ? `稳态 ${item.steadyStepSec}s/步` : null,
          formatBytes(item.bytes),
          item.peakVramMiB ? `峰值显存 ${item.peakVramMiB}MiB` : null,
          item.device ? `${item.device}/${item.dtype}` : null,
          item.kind === 'edit' ? '改图' : '生图',
          item.promptEdited ? '提示词已手改' : null,
        ]
          .filter(Boolean)
          .join(' · '),
      ),
      h(
        'div',
        { className: 'qw-lightbox__tags' },
        tags.map((t) =>
          h(
            'em',
            { key: t, className: 'qw-tag' },
            t,
            h('button', { className: 'qw-tag__x', title: '移除该标签', onClick: stop(() => props.onRemoveTag(t)) }, '×'),
          ),
        ),
        h('input', {
          className: 'qw-input qw-input--mini',
          value: tagInput,
          placeholder: '加标签，回车确认',
          onChange: (e: React.ChangeEvent<HTMLInputElement>) => setTagInput(e.target.value),
          onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => {
            if (e.key !== 'Enter') return
            const t = tagInput.trim()
            if (!t) return
            props.onAddTag(t)
            setTagInput('')
          },
        }),
      ),
      h(
        'div',
        { className: 'qw-lightbox__actions' },
        onPrev ? h('button', { className: 'qw-btn qw-btn--mini', onClick: onPrev }, '← 上一张') : null,
        props.onToggleFav
          ? h(
              'button',
              { className: 'qw-btn qw-btn--mini', onClick: props.onToggleFav },
              item.favorite ? '★ 取消收藏' : '☆ 收藏',
            )
          : null,
        h('button', { className: 'qw-btn qw-btn--mini', onClick: props.onEditPrompt }, '改提示词/备注'),
        h('button', { className: 'qw-btn qw-btn--mini', onClick: () => copy('id', item.id) }, copied === 'id' ? '已复制 id' : '复制 id'),
        h(
          'button',
          { className: 'qw-btn qw-btn--mini', onClick: () => copy('prompt', item.prompt ?? '') },
          copied === 'prompt' ? '已复制提示词' : '复制提示词',
        ),
        h('a', { className: 'qw-btn qw-btn--mini', href: rawUrl(item.id), download: `${item.id}.png` }, '下载原图'),
        h('button', { className: 'qw-btn qw-btn--mini qw-btn--danger', onClick: props.onDelete }, '删除'),
        onNext ? h('button', { className: 'qw-btn qw-btn--mini', onClick: onNext }, '下一张 →') : null,
      ),
      h('code', { className: 'qw-lightbox__id' }, item.id),
      h('div', { className: 'qw-lightbox__hint' }, 'Esc 关闭 · ←/→ 翻页 · 点背景关闭'),
    ),
  )
}

// ---------------------------------------------------------------------------
// 弹窗
// ---------------------------------------------------------------------------
function ConfirmDialog(props: {
  title: string
  message: string
  confirmLabel: string
  danger?: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  return h(
    'div',
    { className: 'qw-modal', onClick: props.onCancel },
    h(
      'div',
      { className: 'qw-modal__box', onClick: (e: React.MouseEvent) => e.stopPropagation() },
      h('h3', { className: 'qw-modal__title' }, props.title),
      h('p', { className: 'qw-modal__msg' }, props.message),
      h(
        'div',
        { className: 'qw-modal__actions' },
        h('button', { className: 'qw-btn', onClick: props.onCancel }, '取消'),
        h(
          'button',
          { className: props.danger ? 'qw-btn qw-btn--danger' : 'qw-btn', onClick: props.onConfirm },
          props.confirmLabel,
        ),
      ),
    ),
  )
}

function TagDialog(props: {
  count: number
  known: string[]
  onCancel: () => void
  onSubmit: (tags: string[]) => void
}) {
  const [text, setText] = React.useState('')
  const parsed = React.useMemo(
    () =>
      text
        .split(/[,，\s]+/)
        .map((s) => s.trim())
        .filter(Boolean),
    [text],
  )
  return h(
    'div',
    { className: 'qw-modal', onClick: props.onCancel },
    h(
      'div',
      { className: 'qw-modal__box', onClick: (e: React.MouseEvent) => e.stopPropagation() },
      h('h3', { className: 'qw-modal__title' }, `给 ${props.count} 张加标签`),
      h('p', { className: 'qw-modal__msg' }, '逗号或空格分隔可一次加多个；已存在的标签会自动去重。'),
      h('input', {
        className: 'qw-input',
        autoFocus: true,
        value: text,
        placeholder: '例如：柴犬, 已定稿',
        onChange: (e: React.ChangeEvent<HTMLInputElement>) => setText(e.target.value),
        onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => {
          if (e.key === 'Enter' && parsed.length) props.onSubmit(parsed)
        },
      }),
      props.known.length
        ? h(
            'div',
            { className: 'qw-modal__known' },
            h('span', { className: 'qw-field__label' }, '已有标签：'),
            props.known.slice(0, 20).map((t) =>
              h(
                'em',
                { key: t, className: 'qw-tag qw-tag--click', onClick: () => setText((cur) => (cur ? `${cur}, ${t}` : t)) },
                t,
              ),
            ),
          )
        : null,
      h(
        'div',
        { className: 'qw-modal__actions' },
        h('button', { className: 'qw-btn', onClick: props.onCancel }, '取消'),
        h(
          'button',
          { className: 'qw-btn', disabled: !parsed.length, onClick: () => props.onSubmit(parsed) },
          parsed.length ? `加 ${parsed.length} 个标签` : '加标签',
        ),
      ),
    ),
  )
}

function PromptDialog(props: {
  item: GalleryItem
  onCancel: () => void
  onSubmit: (patch: { prompt: string; note: string }) => void
}) {
  const [prompt, setPrompt] = React.useState(props.item.prompt ?? '')
  const [note, setNote] = React.useState(props.item.note ?? '')
  return h(
    'div',
    { className: 'qw-modal', onClick: props.onCancel },
    h(
      'div',
      { className: 'qw-modal__box qw-modal__box--wide', onClick: (e: React.MouseEvent) => e.stopPropagation() },
      h('h3', { className: 'qw-modal__title' }, `改 ${props.item.id} 的提示词 / 备注`),
      h(
        'p',
        { className: 'qw-modal__msg' },
        '只改**记录**，不动已生成的图；改过的记录会标 ✎，原提示词不再等于产出参数。',
      ),
      h('textarea', {
        className: 'qw-textarea',
        rows: 6,
        value: prompt,
        onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => setPrompt(e.target.value),
      }),
      h('input', {
        className: 'qw-input',
        value: note,
        placeholder: '备注（可选）',
        onChange: (e: React.ChangeEvent<HTMLInputElement>) => setNote(e.target.value),
      }),
      h(
        'div',
        { className: 'qw-modal__actions' },
        h('button', { className: 'qw-btn', onClick: props.onCancel }, '取消'),
        h('button', { className: 'qw-btn', onClick: () => props.onSubmit({ prompt, note }) }, '保存'),
      ),
    ),
  )
}

function TrashPanel(props: {
  onClose: () => void
  onRestored: () => void
  onPurge: (ids: string[]) => void
}) {
  const [items, setItems] = React.useState<TrashItem[] | null>(null)
  const [busy, setBusy] = React.useState(false)

  const load = React.useCallback(async () => {
    const t = await fetchTrash().catch(() => null)
    setItems(t?.items ?? [])
  }, [])

  React.useEffect(() => {
    void load()
  }, [load])

  return h(
    'div',
    { className: 'qw-modal', onClick: props.onClose },
    h(
      'div',
      { className: 'qw-modal__box qw-modal__box--wide', onClick: (e: React.MouseEvent) => e.stopPropagation() },
      h('h3', { className: 'qw-modal__title' }, `回收站（${items?.length ?? 0}）`),
      h(
        'p',
        { className: 'qw-modal__msg' },
        '删除默认是移到这里，PNG/缩略图/sidecar 都按原文件名存放，可以整条还原。「彻底删除」不可撤销。',
      ),
      items == null
        ? h('div', { className: 'qw-empty' }, '载入中…')
        : items.length === 0
          ? h('div', { className: 'qw-empty' }, '回收站是空的。')
          : h(
              'ul',
              { className: 'qw-trash' },
              items.map((t) =>
                h(
                  'li',
                  { key: t.id, className: 'qw-trash__row' },
                  h('code', { className: 'qw-trash__id' }, t.id),
                  h('span', { className: 'qw-trash__meta' }, `${t.width}×${t.height} · ${relativeTime(t.deletedAt)}`),
                  h('span', { className: 'qw-trash__prompt' }, t.prompt || '（无提示词）'),
                  h(
                    'button',
                    {
                      className: 'qw-btn qw-btn--mini',
                      disabled: busy,
                      onClick: async () => {
                        setBusy(true)
                        await restoreImages([t.id]).catch(() => {})
                        await load()
                        setBusy(false)
                        props.onRestored()
                      },
                    },
                    '还原',
                  ),
                  h(
                    'button',
                    {
                      className: 'qw-btn qw-btn--mini qw-btn--danger',
                      disabled: busy,
                      onClick: async () => {
                        setBusy(true)
                        props.onPurge([t.id])
                        await load()
                        setBusy(false)
                      },
                    },
                    '彻底删除',
                  ),
                ),
              ),
            ),
      h(
        'div',
        { className: 'qw-modal__actions' },
        h('button', { className: 'qw-btn', onClick: props.onClose }, '关闭'),
      ),
    ),
  )
}

// ---------------------------------------------------------------------------
// 分组（分类）
// ---------------------------------------------------------------------------
function groupItems(items: GalleryItem[], group: GroupKey): { key: string; label: string; items: GalleryItem[] }[] {
  if (group === 'none') return [{ key: 'all', label: '全部', items }]

  const buckets = new Map<string, { label: string; items: GalleryItem[] }>()
  const push = (key: string, label: string, it: GalleryItem) => {
    const b = buckets.get(key) ?? { label, items: [] }
    b.items.push(it)
    buckets.set(key, b)
  }

  for (const it of items) {
    if (group === 'day') {
      const d = new Date(Number(it.createdAt) || 0)
      const p = (n: number) => String(n).padStart(2, '0')
      const key = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
      push(key, `${key}（${relativeTime(it.createdAt)}）`, it)
    } else if (group === 'kind') {
      push(it.kind || 'generate', it.kind === 'edit' ? '改图' : '生图', it)
    } else if (group === 'size') {
      const s = Math.max(it.width, it.height)
      push(String(s), `${s}²`, it)
    } else {
      // 标签分组：一张图可能多个标签 —— 只归到**第一个**标签，其余不重复计入，
      // 否则同一张图会在多个分组里各出现一次，看起来像多了几张。
      const tags = it.tags ?? []
      if (tags.length) push(tags[0], `#${tags[0]}`, it)
      else push('__none__', '未分类', it)
    }
  }

  const order = group === 'day' ? 'desc' : group === 'size' ? 'asc' : 'count'
  const list = [...buckets.entries()].map(([key, v]) => ({
    key,
    label: v.label,
    items: v.items,
  }))
  if (order === 'desc') list.sort((a, b) => b.key.localeCompare(a.key))
  else if (order === 'asc') list.sort((a, b) => Number(a.key) - Number(b.key))
  else list.sort((a, b) => (a.key === '__none__' ? 1 : b.key === '__none__' ? -1 : b.items.length - a.items.length))
  return list
}

function kindLabel(kind: string): string {
  if (kind === 'edit') return '改图'
  if (kind === 'generate') return '生图'
  return kind || '未标注'
}

/**
 * 筛选 chip。
 *
 * ⚠️ key 必须带**分组前缀**：类型行和尺寸行都有一个「全部」，
 * 若只用 `${label}-${count}` 做 key，两行的 key 会相同
 * （它们同处一个扁平的 children 数组），React 会报重复 key 并可能错渲染。
 */
function chip(
  group: string,
  label: string,
  count: number,
  active: boolean,
  onClick: () => void,
  plain = false,
): React.ReactElement {
  return h(
    'button',
    {
      key: `${group}:${label}`,
      className: `qw-chip${active ? ' qw-chip--on' : ''}`,
      onClick,
    },
    label,
    !plain && count ? h('span', { className: 'qw-chip__n' }, count) : null,
  )
}

function sep(): React.ReactElement {
  return h('span', { className: 'qw-filters__sep' })
}
