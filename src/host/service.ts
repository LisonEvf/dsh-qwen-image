import type { Context } from '@deepseek-ai/cordis'
import type { Config } from './config'
import { WorkerManager } from './worker-manager'
import { ImageRegistry } from './registry'

/**
 * 插件运行时服务集合：worker 管理器 + 图像注册表。
 * 工具共享同一实例，保证串行与「最新图」语义一致。
 */
export interface Runtime {
  ctx: Context
  config: Config
  manager: WorkerManager
  registry: ImageRegistry
}

export function createRuntime(ctx: Context, config: Config): Runtime {
  const manager = new WorkerManager(ctx, config)
  const registry = new ImageRegistry(ctx, config)

  // 恢复历史（进程重启/HMR 后画廊不空）
  ctx.effect(() => {
    let cancelled = false
    registry
      .restore()
      .then(async (n) => {
        // 回收站索引也要恢复：否则重启后「删除」就变成不可撤销了
        const t = await registry.restoreTrashIndex()
        if (!cancelled && (n > 0 || t > 0)) {
          console.log(`[qwen-image] 已从 manifest 恢复 ${n} 条图像记录、回收站 ${t} 条`)
        }
      })
      .catch((err) => console.warn(`[qwen-image] 历史恢复失败：${(err as Error).message}`))
    return () => {
      cancelled = true
    }
  })

  // 卸载时终止 worker（不留僵尸 python）
  ctx.effect(() => {
    return () => {
      manager.dispose().catch((err) => {
        console.error('[qwen-image] worker 清理失败：', (err as Error).message)
      })
    }
  })

  return { ctx, config, manager, registry }
}
