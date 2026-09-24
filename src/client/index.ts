import * as React from 'react'
import { ImageToolCard } from './cards'
import { AlbumView } from './album'
import { CARD_CSS } from './styles'

/**
 * 客户端半入口（package.json dsh.client → exports["./client"] → lib/client.js）。
 *
 * 构建产物用官方 __ModuleLoader__.load({ id, factory }) 包装，factory 返回
 * { name, inject, apply }；'react' 保持 external，与宿主渲染器共享同一实例。
 *
 * ── 两个界面注册点，职责分明 ────────────────────────────────────────
 *  1. `tool.call.toolview`（key = image_generate / image_edit）—— **主路径**：
 *     生图/改图就在对话流里出卡片，当场看到图。
 *  2. `conversation.view`（id = qwen-image，label = 相册）—— **辅助**：
 *     只读的历史回顾界面，用于「回头看一眼以前生成过什么」，
 *     免得翻聊天记录。它不提供生图/改图入口（那是对话的事），
 *     以免出现两套入口与两套语义。
 *
 * 槽位事实（本机 slot 树实测）：
 *   - `tool.call.toolview` 是 keyed，keyDomain 开放；已占用键里不含
 *     image_generate / image_edit，故该注册是**新增**而非覆盖。
 *   - `conversation.view` 是 list，注册项为 { id(必填), order?, label? }。
 *   - 卡片 props 为 ToolCallOwnerProps：{ callId, toolName, block: ToolCallBlock,
 *     cwd?, home?, openFile, inspect? }（见 cards.tsx）。
 */

interface ClientContext {
  get(name: string): unknown
}

interface SlotRegistry {
  inject(name: string, callback: () => void): void
  register(
    options: Record<string, unknown>,
    component: (props: Record<string, unknown>) => unknown,
  ): () => void
}

export const name = '@lisonevf/dsh-qwen-image/client'
export const inject = ['slots']

export function apply(ctx: ClientContext): void {
  // 注入本插件自己的样式（qw- 前缀，不改全局主题）
  try {
    const styles = ctx.get('styles') as { insert?(css: string): () => void } | undefined
    if (styles && typeof styles.insert === 'function') {
      styles.insert(CARD_CSS)
    } else {
      const el = document.createElement('style')
      el.setAttribute('data-qwen-image', '')
      el.textContent = CARD_CSS
      document.head.appendChild(el)
    }
  } catch {
    // 样式失败不应阻断注册
  }

  const slots = ctx.get('slots') as SlotRegistry | undefined
  if (!slots) {
    console.warn('[qwen-image/client] slots 服务不可用，未注册任何界面')
    return
  }

  // ---- 1. 主路径：两个工具的内联卡片 ----
  for (const toolName of ['image_generate', 'image_edit']) {
    try {
      slots.inject('tool.call.toolview', () => {
        slots.register(
          { name: 'tool.call.toolview', key: toolName },
          (props: Record<string, unknown>) =>
            React.createElement(ImageToolCard, { ...(props as never), toolName: toolName as never }),
        )
      })
    } catch (err) {
      console.warn(`[qwen-image/client] 注册 ${toolName} 卡片失败：`, (err as Error).message)
    }
  }

  // ---- 2. 辅助：历史相册（只读回顾）----
  try {
    slots.inject('conversation.view', () => {
      slots.register(
        // order 6：排在宿主内置视图之后，不与它们争位置
        { name: 'conversation.view', id: 'qwen-image', order: 6, label: '相册' },
        (props: Record<string, unknown>) => React.createElement(AlbumView, props as never),
      )
    })
  } catch (err) {
    console.warn('[qwen-image/client] 注册相册视图失败：', (err as Error).message)
  }
}
