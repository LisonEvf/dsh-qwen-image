import type { Context } from '@deepseek-ai/cordis'
import type { Config } from './config'

/**
 * worker HTTP 客户端（宿主 → Python worker）。
 *
 * worker 是回环 HTTP 服务，Bearer token 鉴权。本模块负责：
 * - 端口发现（从 worker 启动时打印的 `PORT=` 行解析）
 * - 请求封装（超时、重试、错误归一化）
 * - SSE 进度订阅
 *
 * 注意：宿主进程内使用全局 fetch（Node 18+ 内置）。
 */

export interface WorkerEndpoint {
  baseUrl: string
  token: string
}

export interface WorkerHealth {
  ok: boolean
  state: 'idle' | 'loading' | 'ready' | 'error'
  error?: string | null
  device: string
  dtype: string
  offload: string
  loadSec?: number | null
  warmed?: boolean
  vram: { free: number | null; total: number | null; peak: number | null }
  queueDepth: number
}

export class WorkerClient {
  constructor(private readonly ep: WorkerEndpoint) {}

  private url(path: string): string {
    return `${this.ep.baseUrl}${path}`
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' }
    if (this.ep.token) h['Authorization'] = `Bearer ${this.ep.token}`
    return h
  }

  /** 通用 JSON 请求，带超时与错误归一化。 */
  async request<T = unknown>(
    path: string,
    init: { method?: string; body?: unknown; timeoutMs?: number } = {},
  ): Promise<T> {
    const controller = new AbortController()
    const timeout = init.timeoutMs ?? 120000
    const timer = setTimeout(() => controller.abort(), timeout)
    try {
      const res = await fetch(this.url(path), {
        method: init.method ?? 'GET',
        headers: this.headers(),
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: controller.signal,
      })
      const text = await res.text()
      let data: unknown
      try {
        data = text ? JSON.parse(text) : {}
      } catch {
        data = { raw: text }
      }
      if (!res.ok) {
        const err = data as { error?: string }
        throw new Error(`worker ${path} 返回 ${res.status}：${err?.error ?? text.slice(0, 300)}`)
      }
      return data as T
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        throw new Error(`worker ${path} 请求超时（${Math.round(timeout / 1000)}s）`)
      }
      throw err
    } finally {
      clearTimeout(timer)
    }
  }

  health(): Promise<WorkerHealth> {
    return this.request<WorkerHealth>('/health', { timeoutMs: 15000 })
  }

  capabilities(): Promise<Record<string, unknown>> {
    return this.request('/capabilities', { timeoutMs: 15000 })
  }

  logs(count = 50): Promise<{ lines: string[] }> {
    return this.request<{ lines: string[] }>(`/logs?count=${count}`, { timeoutMs: 15000 })
  }

  load(body: {
    modelDir: string
    device: string
    dtype: string
    offload: string
    vaeTiling?: boolean
    attnSlicing?: boolean
    minFreeMiB?: number
  }): Promise<{ loaded: boolean; state: string; loadSec?: number }> {
    // 加载 30GB 权重实测 55–67s，给足余量
    return this.request('/load', { method: 'POST', body, timeoutMs: 15 * 60 * 1000 })
  }

  unload(): Promise<{ unloaded: boolean }> {
    return this.request('/unload', { method: 'POST', body: {}, timeoutMs: 60000 })
  }

  warm(): Promise<{ warmed: boolean; sec?: number; detail?: string }> {
    return this.request('/warm', { method: 'POST', body: {}, timeoutMs: 10 * 60 * 1000 })
  }

  /** 生图/改图入队，立即返回 jobId。 */
  generate(body: Record<string, unknown>): Promise<{ jobId: string; status: string }> {
    return this.request('/generate', { method: 'POST', body, timeoutMs: 60000 })
  }

  edit(body: Record<string, unknown>): Promise<{ jobId: string; status: string }> {
    return this.request('/edit', { method: 'POST', body, timeoutMs: 60000 })
  }

  job(id: string): Promise<{
    id: string
    kind: string
    status: 'queued' | 'completed' | 'failed' | 'cancelled'
    detail?: string
    progress?: ProgressUpdate
    result?: GenResult
  }> {
    return this.request(`/job/${encodeURIComponent(id)}`, { timeoutMs: 30000 })
  }

  cancel(id: string): Promise<{ cancelled: boolean }> {
    return this.request(`/cancel/${encodeURIComponent(id)}`, { method: 'POST', body: {}, timeoutMs: 30000 })
  }

  /** 轮询等待任务完成（SSE 由客户端半直接连 worker 路由，宿主侧用轮询更稳）。 */
  async waitForJob(
    id: string,
    opts: { timeoutMs?: number; intervalMs?: number; onProgress?: (p: ProgressUpdate) => void } = {},
  ): Promise<GenResult> {
    const timeoutMs = opts.timeoutMs ?? 3 * 60 * 60 * 1000
    const interval = opts.intervalMs ?? 2000
    const started = Date.now()
    let lastStep = -1

    while (Date.now() - started < timeoutMs) {
      const snap = await this.job(id)
      if (snap.progress && snap.progress.step !== lastStep) {
        lastStep = snap.progress.step
        opts.onProgress?.(snap.progress)
      }
      if (snap.status === 'completed') {
        if (!snap.result) throw new Error('worker 报告完成但未返回结果')
        return snap.result
      }
      if (snap.status === 'failed') throw new Error(`生成失败：${snap.detail ?? '未知错误'}`)
      if (snap.status === 'cancelled') throw new Error('生成已被取消')
      await sleep(interval)
    }
    throw new Error(`等待任务 ${id} 超时（${Math.round(timeoutMs / 1000)}s）`)
  }
}

export interface ProgressUpdate {
  step: number
  total: number
  elapsedMs: number
  etaMs?: number | null
  steadyStepMs?: number | null
  peakVramMiB?: number | null
}

export interface SavedImage {
  id: string
  file: string
  sidecar: string
  /** 缩略图路径（worker 存图时生成）；缺失时相册回退到原图 */
  thumb?: string | null
  /** 缩略图的实际媒体类型（WebP 优先，可能回退 PNG） */
  thumbMediaType?: string | null
  width: number
  height: number
  bytes: number
  thumbBytes?: number | null
  hasAlpha: boolean
}

export interface GenResult {
  images: SavedImage[]
  seed: number
  steps: number
  elapsedSec: number
  gateSec: number
  firstStepSec?: number | null
  steadyStepSec?: number | null
  /** 末步之后的 VAE 解码 + 后处理耗时（秒） */
  vaeDecodeSec?: number | null
  peakVramMiB?: number | null
  device?: string
  dtype?: string
  offload?: string
  hasAlpha: boolean
  usedReferences: number
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 从 worker stdout 解析 `PORT=<n>` 行（worker 以 --port 0 启动时自动分配）。
 */
export function parsePortLine(text: string): number | undefined {
  const m = text.match(/^PORT=(\d+)\s*$/m)
  return m ? Number(m[1]) : undefined
}

/**
 * 生成随机 token（仅回环，用于避免本机其它进程误调）。
 */
export function makeToken(): string {
  const bytes = new Uint8Array(24)
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(bytes)
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256)
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

export { sleep }
export type { Context, Config }
