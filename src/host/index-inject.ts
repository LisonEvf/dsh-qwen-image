import type { Runtime } from './service'
import { FIRST_STEP_SEC, PRESETS, presetSeconds } from './speed-profile'

/**
 * 宿主 → 浏览器 的配置注入（index tap）。
 *
 * 客户端半需要知道 routePrefix（同源路由前缀）才能拼出图片 URL。
 * 该前缀是可配置的（§4 routePrefix），客户端不应硬编码，否则改配置就断图。
 *
 * 用 webServer.tapIndex 注入一个全局常量：这是官方文档点名的逃生口
 * （"the escape hatch for markup no IndexInjection row expresses"）。
 * 客户端读 window.__QWEN_IMAGE__，读不到时回退到默认前缀。
 *
 * 同时把各档位实测耗时一并下发，卡片/gallery 才能显示诚实的 ETA。
 */
export function registerIndexInjection(rt: Runtime): void {
  const { ctx, config } = rt
  const webServer = ctx.get('webServer') as
    | { tapIndex(transform: (html: string) => string): () => void }
    | undefined
  if (!webServer || typeof webServer.tapIndex !== 'function') {
    console.warn('[qwen-image] webServer.tapIndex 不可用，客户端将回退到默认 routePrefix')
    return
  }

  const payload = {
    routePrefix: config.routePrefix,
    pluginId: '@lisonevf/dsh-qwen-image',
    presets: Object.values(PRESETS).map((p) => ({
      name: p.name,
      label: p.label,
      width: p.width,
      height: p.height,
      steps: p.steps,
      estimatedSec: presetSeconds(p),
    })),
    coldStartSec: FIRST_STEP_SEC,
    maxReferenceImages: config.maxReferenceImages,
  }

  const script =
    `<script id="qwen-image-config">window.__QWEN_IMAGE__=${JSON.stringify(payload).replace(/</g, '\\u003c')};</script>`

  webServer.tapIndex((html: string) => {
    if (html.includes('id="qwen-image-config"')) return html
    // 注入到 </head> 前；无 head 则前置
    if (html.includes('</head>')) return html.replace('</head>', `${script}</head>`)
    return script + html
  })
}
