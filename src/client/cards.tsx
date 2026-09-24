import * as React from 'react'
import { formatDuration, hostConfig, rawUrl, safeParseArgs } from './api'

/**
 * 工具内联卡片（tool.call.toolview，key = image_generate / image_edit）。
 *
 * owner props（查询确认的契约）：
 *   { callId, toolName, block: ToolCallBlock, cwd?, home?, openFile, inspect? }
 *   ToolCallBlock = RunningToolCall | ToolResultNode
 *     RunningToolCall: { callId, name, argsRaw, turn, step, time, subCalls }   ← 无 kind 字段
 *     ToolResultNode:  { kind:'tool-result', callId, call, content, isError, meta?, ... }
 *
 * 显示闭环的关键：
 * - 运行中：无图片可显，展示进度态（提示 + 已用时 + 实测标定的预计耗时）
 * - 已完成：从 **block.meta**（宿主 output.presentationMeta 的持久化投影）取 ids，
 *   再用同源路由 `/api/qwen-image/raw?id=…` 渲染 <img>。
 *   这条通道与模型视觉能力完全无关，因此即使当前路由不能看图，界面也一定能看到图。
 */

interface CardProps {
  callId?: string
  toolName?: string
  block?: unknown
  cwd?: string
  home?: string
  openFile?: (path: string) => void
  inspect?: () => void
}

const h = React.createElement

export function ImageToolCard(props: CardProps) {
  const block = props.block as Record<string, unknown> | undefined
  const isSettled = !!block && block.kind === 'tool-result'

  return isSettled ? h(SettledCard, props) : h(RunningCard, props)
}

// ---------------------------------------------------------------------------
// 运行中
// ---------------------------------------------------------------------------
function RunningCard(props: CardProps) {
  const block = props.block as Record<string, unknown> | undefined
  const args = safeParseArgs(block?.argsRaw)
  const prompt = String(args.prompt ?? '')
  const [elapsed, setElapsed] = React.useState(0)

  const startRef = React.useRef<number>(typeof block?.time === 'number' ? (block.time as number) : Date.now())
  React.useEffect(() => {
    const id = window.setInterval(() => {
      setElapsed((Date.now() - startRef.current) / 1000)
    }, 1000)
    return () => window.clearInterval(id)
  }, [])

  const est = estimateFromArgs(args)
  const progressPct = est ? Math.min(97, Math.round((elapsed / est) * 100)) : null

  return h(
    'div',
    { className: 'qw-card qw-card--running' },
    h(
      'div',
      { className: 'qw-card__head' },
      h('span', { className: 'qw-spinner' }),
      h('span', { className: 'qw-card__title' }, props.toolName === 'image_edit' ? '正在改图' : '正在生图'),
      h('span', { className: 'qw-card__meta' }, `已用 ${formatDuration(elapsed)}`),
    ),
    prompt ? h('div', { className: 'qw-card__prompt' }, prompt) : null,
    est
      ? h(
          'div',
          { className: 'qw-progress' },
          h('div', { className: 'qw-progress__bar', style: { width: `${progressPct ?? 0}%` } }),
        )
      : null,
    h(
      'div',
      { className: 'qw-card__hint' },
      est
        ? `预计约 ${formatDuration(est)}（本机实测标定；每图另含约 ${Math.round(hostConfig().coldStartSec)} 秒冷启动）。可切换到「画室」查看进度，或让模型用 image_worker action=logs 查日志。`
        : '生成中… 本机 P40 实测每张约 3–5 分钟，请耐心等待。',
    ),
  )
}

/** 依据参数与实测标定估算总耗时（秒）。 */
function estimateFromArgs(args: Record<string, unknown>): number | null {
  const cfg = hostConfig()
  const presets = cfg.presets ?? []
  if (!presets.length) return null

  const presetName = typeof args.preset === 'string' ? args.preset : undefined
  if (presetName) {
    const p = presets.find((x) => x.name === presetName)
    if (p) return p.estimatedSec
  }
  const steps = typeof args.steps === 'number' ? args.steps : undefined
  const std = presets.find((x) => x.name === 'standard')
  if (steps && std) {
    // 按步数比例粗估（扣除固定冷启动）
    const steady = (std.estimatedSec - cfg.coldStartSec) / Math.max(1, std.steps - 1)
    return Math.round(cfg.coldStartSec + steps * steady)
  }
  return std?.estimatedSec ?? null
}

// ---------------------------------------------------------------------------
// 已完成
// ---------------------------------------------------------------------------
interface PresentationMeta {
  ids?: string[]
  width?: number
  height?: number
  seed?: number
  steps?: number
  preset?: string
  elapsedSec?: number
  hasAlpha?: boolean
  inputImage?: string
}

function SettledCard(props: CardProps) {
  const block = props.block as Record<string, unknown> | undefined
  const meta = (block?.meta ?? {}) as PresentationMeta
  const isError = block?.isError === true

  // meta 缺失时（例如旧日志）退回从模型可见内容里兜底解析 id
  const ids = React.useMemo(() => {
    if (Array.isArray(meta.ids) && meta.ids.length) return meta.ids.filter((x) => typeof x === 'string')
    return extractIdsFromContent(block?.content)
  }, [meta.ids, block?.content])

  const [openId, setOpenId] = React.useState<string | null>(null)

  if (isError) {
    return h(
      'div',
      { className: 'qw-card qw-card--error' },
      h('div', { className: 'qw-card__title' }, '生成失败'),
      h('div', { className: 'qw-card__hint' }, contentText(block?.content) || '未知错误'),
    )
  }

  return h(
    'div',
    { className: 'qw-card qw-card--done' },
    h(
      'div',
      { className: 'qw-card__head' },
      h('span', { className: 'qw-badge qw-badge--ok' }, '完成'),
      h(
        'span',
        { className: 'qw-card__meta' },
        [
          meta.width && meta.height ? `${meta.width}×${meta.height}` : null,
          meta.steps ? `${meta.steps} 步` : null,
          meta.seed != null ? `seed ${meta.seed}` : null,
          meta.elapsedSec ? formatDuration(meta.elapsedSec) : null,
          meta.hasAlpha ? 'RGBA 透明' : null,
        ]
          .filter(Boolean)
          .join(' · '),
      ),
    ),

    ids.length
      ? h(
          'div',
          { className: 'qw-grid' },
          ids.map((id) =>
            h(
              'figure',
              { key: id, className: 'qw-figure' },
              h('img', {
                className: 'qw-img',
                src: rawUrl(id),
                alt: `生成图像 ${id}`,
                loading: 'lazy',
                // 透明图用棋盘底衬托 alpha
                style: meta.hasAlpha ? { backgroundImage: CHECKER } : undefined,
                onClick: () => setOpenId(id),
              }),
              h(
                'figcaption',
                { className: 'qw-figcaption' },
                h('code', null, id),
                h(
                  'button',
                  {
                    className: 'qw-btn qw-btn--mini',
                    onClick: () => void navigator.clipboard?.writeText(rawUrl(id)).catch(() => {}),
                    title: '复制图片链接',
                  },
                  '复制链接',
                ),
              ),
            ),
          ),
        )
      : h('div', { className: 'qw-card__hint' }, '结果已生成，但未附带可显示的图像 id（可让模型调用 image_result 取回）。'),

    h(
      'div',
      { className: 'qw-card__hint' },
      props.toolName === 'image_edit'
        ? `可直接说「再改一次…」继续编辑；或让模型用 image_edit image='${ids[0] ?? 'latest'}'。`
        : `可说「把这张的背景换成黄昏海滩」继续改图；或让模型用 image_generate seed=${meta.seed ?? '?'} 复现同款。`,
    ),

    // 灯箱
    openId
      ? h(
          'div',
          { className: 'qw-lightbox', onClick: () => setOpenId(null) },
          h('img', { className: 'qw-lightbox__img', src: rawUrl(openId), alt: openId }),
          h('div', { className: 'qw-lightbox__hint' }, '点击任意处关闭'),
        )
      : null,
  )
}

const CHECKER =
  'linear-gradient(45deg,#8884 25%,transparent 25%),linear-gradient(-45deg,#8884 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#8884 75%),linear-gradient(-45deg,transparent 75%,#8884 75%)'

/** 从模型可见内容里兜底抽取形如 `id=xxx` 或 `id: xxx` 的标识。 */
function extractIdsFromContent(content: unknown): string[] {
  const text = contentText(content)
  if (!text) return []
  const ids = new Set<string>()
  for (const m of text.matchAll(/id[=:]\s*([A-Za-z0-9_-]+)/g)) {
    if (m[1] && m[1] !== 'latest') ids.add(m[1])
  }
  return [...ids]
}

/** 把 ContentBlock[] 里的 text 块拼起来。 */
export function contentText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const b of content) {
    if (b && typeof b === 'object' && (b as { type?: string }).type === 'text') {
      const t = (b as { text?: unknown }).text
      if (typeof t === 'string') parts.push(t)
    }
  }
  return parts.join('\n')
}
