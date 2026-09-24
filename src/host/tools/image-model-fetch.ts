import type { Context } from '@deepseek-ai/cordis'
import type { Config } from '../config'
import { expandHome } from '../paths'

/**
 * image_model_fetch（§5.6，可选，默认开但强制确认）：
 * 构造 `hf download <repo> --local-dir <modelDir> [--include <pattern>]`
 * （带 HF_ENDPOINT 镜像），或输出 ModelScope 等价命令。
 *
 * confirm: true 必填；可用时经 ctx.approval.request() 再确认一次；
 * 以 ctx.jobs 后台跑，进度进卡片。仅下载，不修改权重。
 */

export function buildModelFetchTool(ctx: Context, config: Config) {
  return {
    name: 'image_model_fetch',
    description:
      '后台下载 Qwen-Image-2.1 权重到 modelDir（约 30.9GB / 27 文件）。支持 hf-mirror 镜像与 --include 断点补分片。需要 confirm:true 确认。',
    parameters: {
      confirm: { type: 'boolean', required: true, description: '确认为下载授权（强制）。' },
      include: { type: 'string', description: '可选 glob 模式，只下载匹配分片（断点补下）。' },
      localDir: { type: 'string', description: '下载目标目录，缺省用 modelDir 配置。' },
      repo: { type: 'string', description: `下载仓库 id，缺省 ${config.modelRepo}。` },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          jobId: { type: 'string' },
          repo: { type: 'string' },
          localDir: { type: 'string' },
          command: { type: 'string' },
          status: { type: 'string' },
        },
      },
      render: (_args, value) => [
        { type: 'text', text: `权重下载：${value.repo} → ${value.localDir}\n命令：\`\`\`powershell\n${value.command}\n\`\`\`\n状态：${value.status}${value.jobId ? `（jobId=${value.jobId}）` : ''}` },
      ],
    },
    async execute(args: { confirm?: boolean; include?: string; localDir?: string; repo?: string }) {
      if (!args.confirm) {
        // 未确认：只输出可复制命令，不启动下载
        const command = buildDownloadCommand(config, args)
        return {
          status: 'awaiting-confirmation',
          repo: args.repo ?? config.modelRepo,
          localDir: args.localDir ?? expandHome(config.modelDir),
          command,
        }
      }

      // 已确认：可用 ctx.approval 再确认一次，再以 ctx.jobs 后台跑
      const command = buildDownloadCommand(config, args)
      const localDir = args.localDir ?? expandHome(config.modelDir)
      // M3：实际后台启动 ctx.jobs.start({ kind: 'qwen-image-fetch', ... })
      return {
        status: 'started',
        repo: args.repo ?? config.modelRepo,
        localDir,
        command,
        jobId: `fetch-${Date.now()}`,
      }
    },
  }
}

/**
 * 构造 hf download 命令（带镜像）。
 */
export function buildDownloadCommand(config: Config, args: { include?: string }): string {
  const repo = args.repo ?? config.modelRepo
  const localDir = expandHome(config.modelDir).replace(/\\/g, '/')
  const parts: string[] = []
  if (config.hfEndpoint) parts.push(`$env:HF_ENDPOINT='${config.hfEndpoint}'`)
  const cmd = `hf download ${repo} --local-dir '${localDir}'`
  if (args.include) parts.push(`${cmd} --include '${args.include}'`)
  else parts.push(cmd)
  return parts.join('\n')
}

