import type { Context } from '@deepseek-ai/cordis'
import { readFileSync, existsSync } from 'node:fs'
import { resolve as resolvePath } from 'node:path'
import type { Config } from './config'

/**
 * 随包技能注册。
 *
 * ── 为什么用 `ctx.skills.register(...)` 而不是 `registerProvider(...)` ──
 * 实测（读 dsh-skill 源码）：provider 路径有更严的候选校验，`list()` 返回的每个
 * candidate 必须满足
 *   name / description(非空) / invocation? / whenToUse? / source(string)
 *   / rank(有限数) / **provider(string，且必须 === provider 自己的 name)**
 * 少给 `provider` 就会在运行时报
 *   `skill provider "x" returned skill "x" with a non-string provider`
 * —— 本插件第一版正是踩了这条（candidate 里漏了 provider，且 get() 里的
 * provider 值与 provider.name 不一致）。
 *
 * 而本仓库既有的、**已验证可用**的 `dsh-plugin-dev-kb` 走的是更简单的运行时注册：
 *   `ctx.skills.register({ name, description, whenToUse?, source:'runtime', content, resourceBase })`
 * 缺省项由 registry 补齐，无候选校验。本插件改为同一路径。
 *
 * 契约要点（dsh-skill 源码）：
 *   - name 必须匹配 `/^[a-z0-9]+(?:-[a-z0-9]+)*$/`
 *   - description 非空字符串；content 必须是字符串
 *   - resourceBase.path 指向技能资源目录（此处指向随包分发的 skills/）
 * register() 返回 effect disposer，挂到 ctx.effect 上以便卸载/HMR 时自动注销。
 */
export function registerSkill(ctx: Context, config: Config): void {
  const skills = ctx.get('skills') as SkillRegistry | undefined
  if (!skills || typeof skills.register !== 'function') {
    console.warn('[qwen-image] skills 服务不可用（或无 register 方法），随包技能未注册')
    return
  }

  const dir = skillDir()
  const modelDir = expand(config.modelDir)
  const outputDir = expand(config.outputDir)
  const content = loadSkillContent(dir, config, modelDir, outputDir)

  ctx.effect(() => {
    try {
      const disposer = skills.register({
        name: 'dsh-qwen-image',
        description:
          'Qwen-Image-2.1 生图/改图提示词工艺、RGBA 透明模板、官方比例表、本机硬件降级与耗时预期、权重下载指引。',
        whenToUse:
          '当需要生成或修改图像、要挑 Qwen-Image-2.1 的尺寸/步数档位、要写符合该模型的提示词、或遇到显存不足与生图过慢需要归因时使用。',
        source: 'runtime',
        content,
        resourceBase: { kind: 'directory', path: dir },
      })
      console.log(`[qwen-image] 技能已注册：dsh-qwen-image（资源目录 ${dir}）`)
      return () => {
        try {
          disposer()
        } catch {
          /* 忽略卸载期异常 */
        }
      }
    } catch (err) {
      console.warn(`[qwen-image] 技能注册失败：${(err as Error).message}`)
      return () => {}
    }
  })
}

interface SkillRegistry {
  register(skill: {
    name: string
    description: string
    whenToUse?: string
    source?: string
    content: string
    resourceBase?:
      | { kind: 'directory'; path: string }
      | { kind: 'url'; url: string }
      | { kind: 'opaque'; description: string }
  }): () => void
}

/** 随包 skills/ 目录（产物在 lib/，故向上一级到包根）。返回归一化后的绝对路径。 */
function skillDir(): string {
  const here = typeof __dirname === 'string' ? __dirname : process.cwd()
  for (const c of [`${here}/../skills`, `${here}/../../skills`, `${here}/skills`]) {
    if (existsSync(c)) {
      // 归一化掉 `lib/../skills` 这类穿越，避免消费方拿到含 `..` 的路径
      return resolvePath(c).replace(/\\/g, '/')
    }
  }
  const dshHome = process.env.DSH_HOME ?? ''
  return `${dshHome}/dsh-qwen-image/skills`
}

/** 读取 skills/dsh-qwen-image.md；缺失时退回内置精简版，保证技能永远可用。 */
function loadSkillContent(dir: string, config: Config, modelDir: string, outputDir: string): string {
  const file = `${dir}/dsh-qwen-image.md`
  try {
    if (existsSync(file)) {
      return readFileSync(file, 'utf8')
        .replaceAll('{{MODEL_DIR}}', modelDir)
        .replaceAll('{{OUT_DIR}}', outputDir)
        .replaceAll('{{PRESET}}', config.preset)
    }
    console.warn(`[qwen-image] 技能文件不存在：${file} —— 改用内置精简版`)
  } catch (err) {
    console.warn(`[qwen-image] 读取技能文件失败：${(err as Error).message} —— 改用内置精简版`)
  }
  return builtinSkill(modelDir, outputDir, config)
}

/** 内置兜底技能内容（技能文件缺失时使用，保证能力不丢）。 */
function builtinSkill(modelDir: string, outputDir: string, config: Config): string {
  return `# Qwen-Image-2.1 生图 / 改图

## 能力
统一 T2I 与编辑；最多 10 张参考图；原生透明（RGBA）；原生 2K。

## 提示词
用自然语言详细描述主体/场景/风格/光照/构图。透明图用官方模板：
\`This is an RGBA image with transparency. <描述>. The image has alpha channel and the background is transparent.\`
或直接设 \`transparent=true\`。

## 本机实测档位（P40 / fp16）
- draft 768²/12步 ≈ 2.5 分钟
- standard 1024²/24步 ≈ 5.0 分钟
- native 2048²/40步 ≈ 43 分钟（建议 mode=background）

每张图另含约 85 秒冷启动（权重 30.86GB 无法在 32GB RAM 常驻），**每图都重付**，预热收益有限。

## 尺寸比例表
1:1 2048² · 4:3 2389×1792 · 3:4 1792×2389 · 3:2 2560×1707 · 2:3 1707×2560 · 16:9 2752×1536 · 9:16 1536×2752

## 配置
- 权重目录：${modelDir}
- 输出目录：${outputDir}
- 当前预设：${config.preset}（步数默认 ${config.defaultSteps}）

## 排障
- \`image_status\` 体检权重/环境/worker（永不失败）
- \`image_worker action=logs\` 取日志
- 显存不足会拒绝并给出具体归因（含占用进程），不会 OOM 崩栈
- 局部编辑无独立 mask 参数，走官方「涂抹标注图作为条件图」路径

## 许可
Qwen Research License（非商用限制）。本包不携带、不分发任何权重。
`
}

function expand(p: string): string {
  const dshHome = process.env.DSH_HOME ?? ''
  let out = p.replace(/\$DSH_HOME/g, dshHome)
  if (out.startsWith('~/') || out === '~') {
    out = `${process.env.USERPROFILE ?? process.env.HOME ?? ''}${out.slice(1)}`
  }
  return out
}
