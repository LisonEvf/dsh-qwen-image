import { object, S } from './config-schema'

/**
 * 插件配置（PLAN §4）。所有不同部署可能需要不同值的参数都定义为配置字段，
 * **无硬编码**。schema 在插件加载时校验并填充默认值。
 *
 * 检验标准（PLAN §4 / A9）：能否在 `cordis.patch.yml` 里改这个值而不动代码？
 * 20 个字段全部满足。
 *
 * 实现说明：用自包含的 Standard Schema（`./config-schema.ts`），
 * 不 import `@deepseek-ai/schemastery` —— 插件以 `link:` 装入 profile 时
 * 从插件目录解析不到 `@deepseek-ai/*`（Node 按 realpath 解析）。
 */

export const Config = object({
  // ── 执行后端 ──
  backend: S.union(['diffusers', 'openai-images', 'comfyui']).default('diffusers'),

  // ── 权重目录 ──
  modelDir: S.string().default('$DSH_HOME/models/Qwen-Image-2.1'),

  // ── Python ──
  // 显式优先，其次 venv，最后 PATH；空串表示自动探测
  pythonExe: S.string().default(''),

  // ── 设备 / 精度 / 显存 offload ──
  device: S.union(['auto', 'cuda:0', 'cuda:1', 'cuda:2', 'cuda:3', 'cpu']).default('auto'),
  // M0 实测：P40(sm_61) fp16 10.01 TFLOPS > fp32 8.64；bf16 仅 5.05（软件模拟）。
  // 故 auto 在 sm≥6 上解析为 fp16，sm≥8 才用 bf16。
  dtype: S.union(['auto', 'bf16', 'fp16', 'fp32']).default('auto'),
  offload: S.union(['auto', 'none', 'model', 'sequential']).default('auto'),

  // ── 尺寸预设 ──
  preset: S.union(['draft', 'standard', 'native', 'custom']).default('standard'),
  defaultSteps: S.number().int().minimum(1).maximum(200).default(24),
  maxPixels: S.number().int().minimum(262144).default(1048576),

  // ── 输出 ──
  outputDir: S.string().default('$DSH_HOME/dsh-qwen-image/outputs'),
  keepAliveMinutes: S.number().int().minimum(0).default(15),

  // ── Worker ──
  maxConcurrent: S.number().int().minimum(1).maximum(8).default(1),
  // 生图默认档位实测约 5.1 分钟；30 分钟给 native 档与排队留余量
  toolTimeoutMs: S.number().int().minimum(10000).default(1800000),
  workerPort: S.number().int().minimum(0).maximum(65535).default(0),
  routePrefix: S.string().default('/api/qwen-image'),

  // ── 权重下载（代办）──
  allowModelFetch: S.boolean().default(true),
  hfEndpoint: S.string().default('https://hf-mirror.com'),
  modelRepo: S.string().default('Qwen/Qwen-Image-2.1'),
  maxReferenceImages: S.number().int().minimum(1).maximum(10).default(10),

  // ── 显存守卫 ──
  lowVramGuardMiB: S.number().int().minimum(256).default(1024),
})

/** 配置项的类型（与上面的 schema 字段一一对应）。 */
export interface Config {
  backend: 'diffusers' | 'openai-images' | 'comfyui'
  modelDir: string
  pythonExe: string
  device: 'auto' | 'cuda:0' | 'cuda:1' | 'cuda:2' | 'cuda:3' | 'cpu'
  dtype: 'auto' | 'bf16' | 'fp16' | 'fp32'
  offload: 'auto' | 'none' | 'model' | 'sequential'
  preset: 'draft' | 'standard' | 'native' | 'custom'
  defaultSteps: number
  maxPixels: number
  outputDir: string
  keepAliveMinutes: number
  maxConcurrent: number
  toolTimeoutMs: number
  workerPort: number
  routePrefix: string
  allowModelFetch: boolean
  hfEndpoint: string
  modelRepo: string
  maxReferenceImages: number
  lowVramGuardMiB: number
}
