import type { Context } from '@deepseek-ai/cordis'

import { Config } from './host/config'
import type { Config as ConfigType } from './host/config'
import { defineTool } from './host/tool-dsl'
import { createRuntime } from './host/service'
import { buildStatusTool } from './host/tools/image-status'
import { buildWorkerTool } from './host/tools/image-worker'
import { buildGenerateTool } from './host/tools/image-generate'
import { buildEditTool } from './host/tools/image-edit'
import { buildResultTool } from './host/tools/image-result'
import { buildModelFetchTool } from './host/tools/image-model-fetch'
import { registerSkill } from './host/skill'
import { registerRoutes } from './host/routes'
import { registerIndexInjection } from './host/index-inject'

export const name = '@lisonevf/dsh-qwen-image'

/**
 * 硬依赖只声明三个，其余一律走 `ctx.get` 做**可选消费**。
 *
 * ⚠️ 为什么刻意让 inject 保持最小（实测教训的推广）：
 * cordis 里 `inject` 是**激活门禁** —— 声明了某服务，本行就一直等到它出现；
 * 若它始终不出现，启动会以
 *   「row(s) did not activate: qwen-image: waiting for <service>」
 * **失败**（不是降级）。而本插件对 `subprocess` / `fs` / `attachments` / `jobs`
 * 的使用都是**惰性且可降级**的（`ctx.get` + undefined 检查，缺了就跳过对应能力），
 * 所以它们不该进 inject —— 否则等于把「少一个可选服务」升级成「整棵插件树起不来」。
 *
 * 保留的三个是真需求：
 *   - `tools`     —— apply 期就要 `ctx.tools.register(...)`（唯一硬属性访问）
 *   - `webServer` —— apply 期就要挂同源路由，否则界面永远拿不到图
 *   - `skills`    —— apply 期就要注册随包技能，晚到会静默丢失
 *
 * 注意：cordis 的服务**必须由 inject 声明才会暴露在 `ctx` 上**，故除 `ctx.tools`
 * 之外一律用 `ctx.get('name')`（stock-panel 源码注释里记了同一条实测结论）。
 */
export const inject = ['tools', 'webServer', 'skills']

/**
 * 注意：本插件**不 import 任何 `@deepseek-ai/*` 运行时包**
 * （`@deepseek-ai/cordis` 只用于类型，编译后消失）。
 *
 * 原因：插件以 `link:` 方式装进 profile，Node 按 **realpath** 解析链接包，
 * 于是对 `@deepseek-ai/*` 的裸模块解析会从插件目录向上查找而**找不到**
 * —— 该依赖住在 dsh 安装目录内，不在插件的解析链上。这是本仓库既有约定
 * （见 `dsh-plugin-dev-kb` 源码里的「依赖纪律」注释）。
 *
 * 因此工具定义与 Config schema 分别由自包含的 `./host/tool-dsl.ts` 与
 * `./host/config-schema.ts` 提供，二者与官方产物**逐字兼容**（已实测核对）。
 *
 * 自检：`node scripts/check-host-deps.mjs` 断言产物零裸包依赖。
 */
export function apply(ctx: Context, config: ConfigType) {
  // 运行时：worker 管理器 + 图像注册表（共享给所有工具）
  const rt = createRuntime(ctx, config)

  // 1. 随包技能
  try {
    registerSkill(ctx, config)
  } catch (err) {
    console.error('[qwen-image] 技能注册失败：', (err as Error).message)
  }

  // 2. 工具面（PLAN §5）。逐个 try/catch，单个失败不拖垮其余。
  const tools = ctx.tools
  const register = (label: string, build: () => unknown) => {
    try {
      tools.register(defineTool(build() as never))
    } catch (err) {
      console.error(`[qwen-image] ${label} 注册失败：`, (err as Error).message)
    }
  }

  register('image_status', () => buildStatusTool(rt))
  register('image_worker', () => buildWorkerTool(rt))
  register('image_generate', () => buildGenerateTool(rt))
  register('image_edit', () => buildEditTool(rt))
  register('image_result', () => buildResultTool(rt))
  if (config.allowModelFetch) {
    register('image_model_fetch', () => buildModelFetchTool(ctx, config))
  }

  // 3. 同源 HTTP 路由
  try {
    registerRoutes(rt)
  } catch (err) {
    console.error('[qwen-image] 路由注册失败：', (err as Error).message)
  }

  // 4. 把配置下发给浏览器（客户端据此拼图片 URL，避免硬编码 routePrefix）
  try {
    registerIndexInjection(rt)
  } catch (err) {
    console.error('[qwen-image] index 注入失败（客户端将回退默认 routePrefix）：', (err as Error).message)
  }

  console.log(
    `[qwen-image] 已加载：backend=${config.backend} modelDir=${config.modelDir} ` +
      `device=${config.device}/${config.dtype} preset=${config.preset}`,
  )
}

export { Config }
export type { ConfigType }
