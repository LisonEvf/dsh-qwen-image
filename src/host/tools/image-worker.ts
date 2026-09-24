import type { Runtime } from '../service'
import { formatDuration } from '../speed-profile'
import { BUILD_TAG } from './image-status'
import { sanitizeToolOutput } from './lossless'
import { expandHome } from '../paths'

/**
 * image_worker（§5.4）：worker 生命周期管理。
 * action: start | stop | unload | warm | status | logs
 */

export function buildWorkerTool(rt: Runtime) {
  const { config, manager } = rt

  return {
    name: 'image_worker',
    description:
      '管理 Qwen-Image-2.1 Python worker 的生命周期：启动 / 停止 / 卸载模型 / 预热 / 查状态 / 取日志。' +
      `生图前可 start 或 warm 避免首次等待，用完可 unload 把显存还给其它程序。【构建标记 ${BUILD_TAG}】`,
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['start', 'stop', 'unload', 'warm', 'status', 'logs'],
        description:
          'start=启动进程并加载模型 | stop=停止进程 | unload=仅卸载模型释放显存 | warm=预热 | status=查状态 | logs=最近日志',
      },
      count: { type: 'number', description: 'logs 时返回的行数（默认 50）。' },
    },
    timeoutMs: 15 * 60 * 1000,
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          action: { type: 'string' },
          managerState: { type: 'string' },
          workerState: { type: 'string' },
          port: { type: 'integer' },
          pid: { type: 'integer' },
          device: { type: 'string' },
          dtype: { type: 'string' },
          offload: { type: 'string' },
          loadSec: { type: 'number' },
          warmed: { type: 'boolean' },
          vramFreeMiB: { type: 'integer' },
          vramTotalMiB: { type: 'integer' },
          vramPeakMiB: { type: 'integer' },
          queueDepth: { type: 'integer' },
          sec: { type: 'number' },
          detail: { type: 'string' },
          logs: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args: unknown, value: Record<string, unknown>) => [{ type: 'text', text: formatWorkerText(value) }],
    },

    async execute(args: { action: string; count?: number }) {
      // 必经 sanitize：DSH 侧对 undefined/NaN 的 fail-closed 校验会让整个工具失败
      return sanitizeToolOutput(await runWorkerAction(rt, args))
    },
  }
}

async function runWorkerAction(rt: Runtime, args: { action: string; count?: number }): Promise<Record<string, unknown>> {
  const { config, manager } = rt
  switch (args.action) {
    case 'status':
      return await status(rt)
    case 'logs': {
      const st = await status(rt)
      const client = manager.getClient()
      if (!client) {
        return { action: 'logs', managerState: st.managerState ?? 'stopped', logs: [], detail: 'worker 未启动，无日志。' }
      }
      try {
        const { lines } = await client.logs(args.count ?? 50)
        return { action: 'logs', workerState: st.workerState, logs: lines }
      } catch (err) {
        return { action: 'logs', detail: `读取日志失败：${(err as Error).message}` }
      }
    }
    case 'start': {
      const client = await manager.ensureStarted()
      const h = await client.health()
      if (h.state !== 'ready') {
        const r = await client.load({
          modelDir: expandHome(config.modelDir),
          device: config.device,
          dtype: config.dtype,
          offload: config.offload,
          vaeTiling: true,
          minFreeMiB: config.lowVramGuardMiB,
        })
        return { action: 'start', managerState: manager.getStatus().state, workerState: 'ready', loadSec: r.loadSec }
      }
      return { action: 'start', managerState: manager.getStatus().state, workerState: h.state, loadSec: h.loadSec ?? undefined, detail: 'worker 已就绪（模型已加载）。' }
    }
    case 'warm': {
      const client = await manager.ensureStarted()
      const h0 = await client.health()
      if (h0.state !== 'ready') {
        await client.load({
          modelDir: expandHome(config.modelDir),
          device: config.device,
          dtype: config.dtype,
          offload: config.offload,
          vaeTiling: true,
          minFreeMiB: config.lowVramGuardMiB,
        })
      }
      const r = await client.warm()
      manager.touch()
      return {
        action: 'warm',
        warmed: r.warmed,
        sec: r.sec,
        detail: r.detail ?? '预热完成（把冷启动的 mmap 换入代价提前付掉）。注意：受 32GB 内存限制，页可能被再次逐出，收益有限。',
      }
    }
    case 'unload': {
      const client = manager.getClient()
      if (!client) return { action: 'unload', detail: 'worker 未启动，无需卸载。' }
      await client.unload()
      return { action: 'unload', workerState: 'idle', detail: '模型已卸载，显存已释放。' }
    }
    case 'stop': {
      const st = manager.getStatus()
      await manager.stop()
      return { action: 'stop', managerState: 'stopped', detail: `worker（pid ${st.pid ?? '?'}）已停止。` }
    }
    default:
      throw new Error(`未知 action：${args.action}。可选：start | stop | unload | warm | status | logs`)
  }
}

async function status(rt: Runtime): Promise<Record<string, unknown>> {
  const { manager } = rt
  const ms = manager.getStatus()
  const h = await manager.tryHealth()
  return {
    action: 'status',
    managerState: ms.state,
    workerState: h?.state ?? (ms.state === 'stopped' ? 'stopped' : 'unknown'),
    port: ms.port || undefined,
    pid: ms.pid,
    device: h?.device,
    dtype: h?.dtype,
    offload: h?.offload,
    loadSec: h?.loadSec ?? undefined,
    warmed: h?.warmed,
    vramFreeMiB: h?.vram.free ?? undefined,
    vramTotalMiB: h?.vram.total ?? undefined,
    vramPeakMiB: h?.vram.peak ?? undefined,
    queueDepth: h?.queueDepth,
    detail: ms.error ?? h?.error ?? undefined,
  }
}

function formatWorkerText(v: Record<string, unknown>): string {
  if (v.action === 'logs') {
    const logs = (v.logs as string[]) ?? []
    if (!logs.length) return `无日志。${v.detail ?? ''}`
    return `最近 ${logs.length} 行日志：\n${logs.join('\n')}`
  }

  const lines: string[] = []
  lines.push(`worker[${v.action}]`)
  if (v.managerState || v.workerState) {
    lines.push(`  管理器：${v.managerState ?? '?'}｜worker：${v.workerState ?? '?'}${v.pid ? `｜pid ${v.pid}` : ''}${v.port ? `｜端口 ${v.port}` : ''}`)
  }
  if (v.device || v.dtype) lines.push(`  设备 ${v.device ?? '?'}／精度 ${v.dtype ?? '?'}／offload ${v.offload ?? '?'}`)
  if (v.loadSec) lines.push(`  加载耗时 ${v.loadSec}s${v.warmed ? '｜已预热' : ''}`)
  if (v.vramFreeMiB !== undefined) {
    lines.push(`  显存 空闲 ${v.vramFreeMiB}MiB / ${v.vramTotalMiB ?? '?'}MiB${v.vramPeakMiB ? `｜峰值 ${v.vramPeakMiB}MiB` : ''}`)
  }
  if (v.queueDepth !== undefined) lines.push(`  队列深度 ${v.queueDepth}`)
  if (v.sec) lines.push(`  预热耗时 ${formatDuration(Number(v.sec))}`)
  if (v.detail) lines.push(`  ${v.detail}`)
  return lines.join('\n')
}

