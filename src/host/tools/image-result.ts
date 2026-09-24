import type { Runtime } from '../service'
import { formatDuration } from '../speed-profile'
import { sanitizeToolOutput } from './lossless'

/**
 * image_result（§5.5）：按 id（或本会话最新）取回同一规范值 + 带图片的卡片。
 * 后台模式与「再给我看一次」的正规入口。
 */

export function buildResultTool(rt: Runtime) {
  const { registry } = rt

  return {
    name: 'image_result',
    description:
      '取回图像结果与元信息，或列出历史作品。' +
      "**这是「从上下文挑历史图」的主力工具**：用户用描述性说法指代某张旧图（「有猫的那张」「第一张柴犬」）时，" +
      "先 id='list' 列出记录（含每张的 prompt / 尺寸 / 步数 / seed / id），按描述匹配出 id，" +
      '再把它传给 image_edit；匹配不上就把列表给他挑。' +
      '也用于「再给我看一次那张图」（缺省取最近一次）。',
    parameters: {
      id: {
        type: 'string',
        description:
          "图像 id；缺省取最近一次；传 'latest' 同义；**传 'list' 列出历史记录**（含 prompt，供匹配指代）。",
      },
      limit: { type: 'number', description: "id='list' 时返回的条数（默认 20）。" },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          mode: { type: 'string' },
          count: { type: 'integer' },
          items: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: true,
              properties: {
                id: { type: 'string' },
                file: { type: 'string' },
                width: { type: 'integer' },
                height: { type: 'integer' },
                bytes: { type: 'integer' },
                hasAlpha: { type: 'boolean' },
                seed: { type: 'integer' },
                steps: { type: 'integer' },
                prompt: { type: 'string' },
                kind: { type: 'string' },
                elapsedSec: { type: 'number' },
                createdAt: { type: 'integer' },
              },
            },
          },
          detail: { type: 'string' },
        },
      },
      render: (_args: unknown, value: Record<string, unknown>) => [{ type: 'text', text: formatResultText(value) }],
      presentationMeta: (_args: unknown, value: Record<string, unknown>) => ({
        mode: value.mode,
        ids: ((value.items as Array<{ id: string }>) ?? []).map((i) => i.id),
      }),
    },

    async execute(args: { id?: string; limit?: number }) {      return sanitizeToolOutput(await runResult(rt, args))
    },
  }
}

async function runResult(rt: Runtime, args: { id?: string; limit?: number }): Promise<Record<string, unknown>> {
  const { registry } = rt
  if (args.id === 'list') {
    const items = registry.list(args.limit ?? 20).map(toItem)
    return { mode: 'list', count: items.length, items }
  }

  const rec = registry.get(args.id ?? 'latest')
  if (!rec) {
    return {
      mode: 'detail',
      count: 0,
      items: [],
      detail: args.id
        ? `找不到图像 id=${args.id}。可用 image_result id='list' 查看现有记录。`
        : '还没有任何生成记录。请先用 image_generate。',
    }
  }
  // 确保附件已注入（老记录可能没有）
  if (!rec.attachmentId) await registry.attachImages([rec])
  return { mode: 'detail', count: 1, items: [toItem(rec)] }
}

function toItem(r: {
  id: string
  file: string
  width: number
  height: number
  bytes: number
  hasAlpha: boolean
  seed: number
  steps: number
  prompt: string
  kind: string
  elapsedSec?: number
  createdAt: number
}) {
  return {
    id: r.id,
    file: r.file,
    width: r.width,
    height: r.height,
    bytes: r.bytes,
    hasAlpha: r.hasAlpha,
    seed: r.seed,
    steps: r.steps,
    prompt: r.prompt,
    kind: r.kind,
    elapsedSec: r.elapsedSec,
    createdAt: r.createdAt,
  }
}

function formatResultText(v: Record<string, unknown>): string {
  const items = (v.items as Array<Record<string, unknown>>) ?? []

  if (v.detail) return String(v.detail)
  if (!items.length) return '没有找到图像记录。'

  if (v.mode === 'list') {
    const lines = [`最近 ${items.length} 条生成记录：`]
    for (const it of items) {
      const ts = new Date(Number(it.createdAt)).toLocaleString('zh-CN')
      lines.push(
        `  • ${it.id}｜${it.width}×${it.height}｜${it.kind}｜seed ${it.seed}｜${it.steps}步` +
          `${it.hasAlpha ? '｜RGBA' : ''}｜${formatDuration(Number(it.elapsedSec) || 0)}｜${ts}`,
      )
      const p = String(it.prompt ?? '')
      lines.push(`    「${p.length > 60 ? `${p.slice(0, 60)}…` : p}」`)
    }
    lines.push('')
    lines.push("用 image_result id='<id>' 取回单张详情，或 image_edit image='<id>' 继续改这张。")
    return lines.join('\n')
  }

  const it = items[0]
  const lines: string[] = []
  lines.push(`图像 ${it.id}`)
  lines.push(`  文件：${it.file}`)
  lines.push(`  尺寸 ${it.width}×${it.height}｜${it.hasAlpha ? 'RGBA 透明' : 'RGB'}｜${Math.round(Number(it.bytes) / 1024)} KB`)
  lines.push(`  来源 ${it.kind}｜seed ${it.seed}｜${it.steps} 步｜耗时 ${formatDuration(Number(it.elapsedSec) || 0)}`)
  lines.push(`  提示词：「${it.prompt}」`)
  lines.push('')
  lines.push(`用 image_edit image='${it.id}' prompt='…' 可以继续修改这张图。`)
  return lines.join('\n')
}
