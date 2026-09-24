/**
 * 插件注册步骤：把本插件装进目标 dsh profile，并写好它的配置。
 *
 * 对应的官方接口：
 *   dsh plugin --profile <p> add <包目录或 tgz>  —— 转发给 profile 里的 pnpm，
 *   随后 dsh 自己会把声明了 dsh.bundle 的依赖加入 dsh.profile.bundles。
 * 所以安装器**不直接改 profile 的 package.json**，只负责：
 *   1) 保证 pnpm 存在（dsh plugin 依赖它）
 *   2) 调一次官方命令
 *   3) 幂等地写入/更新 profile 的 cordis.patch.yml 配置块
 *   4) 用 dsh --dump-config 复核
 */

import { copyFileSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { IS_WIN, ensureDir, isDir, isFile, renderCmd, run, runStream, stamp, which, writeFileSafe } from './util.mjs'
import { venvPython } from './pystep.mjs'

/** 插件包名（与 package.json 的 name 一致）。 */
export const PACKAGE_NAME = '@lisonevf/dsh-qwen-image'

/**
 * 从任意文件位置向上找插件根目录。
 * 必须「向上找 package.json」而不是写死层数：调用它的既可能是
 * installer/install.mjs（上 1 层），也可能是 installer/lib/*.mjs（上 2 层）。
 */
export function findPluginRoot(fromUrl) {
  const file = fileURLToPath(fromUrl || import.meta.url)
  let dir = dirname(file)
  for (let i = 0; i < 6; i++) {
    const pkg = join(dir, 'package.json')
    if (isFile(pkg)) {
      try {
        const manifest = JSON.parse(readFileSync(pkg, 'utf8'))
        if (manifest && (manifest.name === PACKAGE_NAME || (manifest.dsh && manifest.dsh.bundle))) return dir
      } catch {
        /* 继续向上找 */
      }
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return resolve(dirname(file), '..')
}

/** 读取插件自己的 package.json（用于版本号等）。 */
export function readPluginManifest(pluginRoot) {
  try {
    return JSON.parse(readFileSync(join(pluginRoot, 'package.json'), 'utf8'))
  } catch {
    return null
  }
}

/** 确保 pnpm 可用（dsh plugin 是 pnpm 的转发器）。 */
export async function ensurePnpm(ctx) {
  const ui = ctx.ui
  const found = which('pnpm')
  if (found) {
    const v = run(found, ['--version'], { timeoutMs: 60000 })
    if (v.ok) {
      ui.ok('pnpm ' + (v.stdout || '').trim())
      return found
    }
  }
  ui.warn('没有找到 pnpm，dsh 的插件管理需要它')
  const corepack = which('corepack')
  if (corepack) {
    ui.info('尝试用 corepack 启用 pnpm…')
    const r = await runStream(corepack, ['enable', 'pnpm'], { env: process.env, timeoutMs: 180000, ui: ui })
    if (r.code === 0) {
      const again = which('pnpm')
      if (again) {
        ui.ok('pnpm 已通过 corepack 启用')
        return again
      }
    }
  }
  const npm = which('npm')
  if (npm) {
    ui.info('尝试用 npm 全局安装 pnpm…')
    const r = await runStream(npm, ['install', '-g', 'pnpm'], { env: process.env, timeoutMs: 900000, ui: ui })
    if (r.code === 0) {
      const again = which('pnpm')
      if (again) {
        ui.ok('pnpm 安装完成')
        return again
      }
    }
  }
  ui.err('无法自动准备 pnpm')
  ui.hint('手动安装后重跑：npm install -g pnpm   （或 corepack enable pnpm）')
  return null
}

/** 目标 profile 的 cordis.patch.yml 路径。 */
export function profilePatchPath(home, profile) {
  return join(home, 'profiles', profile, 'cordis.patch.yml')
}

/** 生成配置块（键与包内 cordis.patch.yml 完全一致；patch 会整块替换 config）。 */
export function renderConfigBlock(opts) {
  const o = opts || {}
  const modelDir = String(o.modelDir).replace(/\\/g, '/')
  const pythonExe = String(o.pythonExe || '').replace(/\\/g, '/')
  const lines = [
    '# ── @lisonevf/dsh-qwen-image：由安装器写入（' + (o.date || new Date().toISOString().slice(0, 10)) + '） ──',
    '# 注意：patch 会**整块替换**目标行的 config，所以这里写全了 20 个键。',
    '# 想改回默认值：删掉本块即可（包内 cordis.patch.yml 的默认值随即生效）。',
    '- id: qwen-image',
    '  config:',
    '    backend: diffusers',
    "    modelDir: '" + modelDir + "'",
  ]
  if (pythonExe) lines.push("    pythonExe: '" + pythonExe + "'")
  else lines.push("    pythonExe: ''")
  const rest = [
    '    device: auto',
    '    dtype: auto',
    '    offload: auto',
    '    preset: ' + (o.preset || 'standard'),
    '    defaultSteps: ' + (o.defaultSteps || 24),
    '    maxPixels: ' + (o.maxPixels || 1048576),
    "    outputDir: '$DSH_HOME/dsh-qwen-image/outputs'",
    '    keepAliveMinutes: ' + (o.keepAliveMinutes == null ? 15 : o.keepAliveMinutes),
    '    maxConcurrent: 1',
    '    toolTimeoutMs: 1800000',
    '    workerPort: 0',
    '    routePrefix: /api/qwen-image',
    '    allowModelFetch: true',
    '    hfEndpoint: ' + (o.hfEndpoint === null ? "''" : "'" + (o.hfEndpoint || 'https://hf-mirror.com') + "'"),
    '    modelRepo: ' + (o.modelRepo || 'Qwen/Qwen-Image-2.1'),
    '    maxReferenceImages: 10',
    '    lowVramGuardMiB: 1024',
  ]
  return lines.concat(rest).join('\n') + '\n'
}

/**
 * 幂等写入 profile 配置块：
 * - 已有 id 为 qwen-image 的块 → 整块替换
 * - 没有 → 追加到文件末尾
 * 写入前留一份 .bak-<时间戳>，用户可以随时回退。
 */
export function upsertConfigBlock(patchPath, block) {
  ensureDir(dirname(patchPath))
  const existed = isFile(patchPath)
  const original = existed ? readFileSync(patchPath, 'utf8') : '# 本 profile 的 patch 层：顶层是一个 YAML 数组\n[]\n'
  let backup = null
  if (existed) {
    backup = patchPath + '.bak-' + stamp()
    try {
      copyFileSync(patchPath, backup)
    } catch {
      backup = null
    }
  }
  // dsh 新建 profile 的模板是「几行注释 + 一个空的 YAML 数组 []」。
  // 若把 '- id: ...' 直接追加在 [] 后面，就变成**两个没有分隔符的 YAML 文档**，
  // dsh 会直接拒绝加载整个 profile：
  //   failed to parse overlay ... end of the stream or a document separator is expected
  // —— 本机实测踩到过（先用新 profile 试装，再回看 web profile 才没把线上搞坏）。
  // 所以：先统一把「独占一行的空数组」清掉（注释保留），再做替换/追加。
  const lines = original.split(/\r?\n/).filter((l) => !/^\s*\[\s*\]\s*$/.test(l))
  const idIndex = lines.findIndex((l) => /^-\s*id:\s*['"]?qwen-image['"]?\s*$/.test(l.trim()))
  let startIndex = idIndex
  let next
  if (idIndex >= 0) {
    // 本块自带的注释行紧贴在 id 行上方，替换时必须一起吃掉，
    // 否则每跑一次安装器就会多堆一份注释（幂等就破了）。
    while (startIndex > 0 && /^\s*#/.test(lines[startIndex - 1])) startIndex--
    // 块尾必须从**原来的 id 行**往后找：注释被吃掉后，
    // startIndex+1 出发的第一个 '- ' 行就是本块自己的 id 行。
    let endIndex = lines.length
    for (let i = idIndex + 1; i < lines.length; i++) {
      if (/^-\s/.test(lines[i])) {
        endIndex = i
        break
      }
    }
    const before = lines.slice(0, startIndex)
    const after = lines.slice(endIndex)
    next = before.concat(block.trimEnd().split('\n')).concat(after).join('\n')
  } else {
    const trimmed = lines.join('\n').replace(/\s*$/, '')
    next = trimmed === '' ? block : trimmed + '\n\n' + block
  }
  writeFileSafe(patchPath, next.endsWith('\n') ? next : next + '\n')
  return { path: patchPath, replaced: startIndex >= 0, backup: backup }
}

/**
 * 注册插件到 profile。
 * @param {{profile: string, pluginRoot: string, spec?: string}} opts
 */
export async function registerPlugin(ctx, opts) {
  const o = opts || {}
  const ui = ctx.ui
  const pluginRoot = o.pluginRoot
  const profile = o.profile
  const dsh = which('dsh')

  const spec = o.spec || pluginRoot
  if (!dsh) {
    ui.err('PATH 里没有 dsh，无法注册插件')
    ui.hint('先安装 dsh（npm install -g @deepseek-ai/dsh），装好后重跑本安装器即可')
    return { ok: false, reason: 'no-dsh' }
  }
  const pnpm = await ensurePnpm(ctx)
  if (!pnpm) return { ok: false, reason: 'no-pnpm' }

  const installedDir = join(ctx.facts.home, 'profiles', profile, 'node_modules', PACKAGE_NAME)
  if (isDir(installedDir) && !o.force) {
    ui.detail('profile 里已经有这个插件的副本，仍会执行一次 add 以确保是最新版')
  }

  ui.info('注册到 profile「' + profile + '」：' + spec)
  const env = Object.assign({}, process.env, { DSH_HOME: ctx.facts.home })
  const r = await runStream(dsh, ['plugin', '--profile', profile, 'add', spec], { env: env, timeoutMs: 1800000, ui: ui })
  if (r.code !== 0) {
    ui.err('dsh plugin add 失败（退出码 ' + r.code + '）')
    ui.hint('可手动执行：' + renderCmd('dsh', ['plugin', '--profile', profile, 'add', spec]))
    ui.hint('若报 pnpm 相关错误：先 npm install -g pnpm 再重试')
    return { ok: false, reason: 'add-failed' }
  }
  if (!isDir(installedDir)) {
    ui.warn('命令成功，但没在 profile 的 node_modules 里看到插件目录，稍后用 dump-config 复核')
  }
  return { ok: true, installedDir: installedDir }
}

/** 写入配置块（把 modelDir / pythonExe / 档位写进 profile patch）。 */
export function configureProfile(ctx, opts) {
  const o = opts || {}
  const ui = ctx.ui
  const patchPath = profilePatchPath(ctx.facts.home, o.profile)
  const block = renderConfigBlock(o)
  const res = upsertConfigBlock(patchPath, block)
  if (res.replaced) ui.ok('已更新 profile 配置块：' + patchPath)
  else ui.ok('已写入 profile 配置块：' + patchPath)
  if (res.backup) ui.detail('原文件备份：' + res.backup)
  return res
}

/** 用 dsh --dump-config 复核注册结果（这一步不过，重启后也看不到插件）。 */
export function verifyRegistration(ctx, opts) {
  const o = opts || {}
  const ui = ctx.ui
  const dsh = which('dsh')
  if (!dsh) return { ok: false, reason: 'no-dsh' }
  ui.info('复核配置树（dsh --profile ' + o.profile + ' --dump-config）…')
  const r = run(dsh, ['--profile', o.profile, '--dump-config'], { timeoutMs: 900000, env: Object.assign({}, process.env, { DSH_HOME: ctx.facts.home }) })
  const text = (r.stdout || '') + (r.stderr || '')
  // 解析失败时错误信息里**也会**出现 qwen-image（来自我们写的那一行），
  // 所以必须先判错，否则会把失败当成功报出去。
  if (/failed to parse|YAMLException/.test(text)) {
    ui.err('配置树解析失败：安装器写入的 patch 文件格式有问题')
    const firstErr = text.split(/\r?\n/).filter((l) => /failed to parse|YAMLException/.test(l))[0] || ''
    ui.detail(firstErr.trim().slice(0, 300))
    ui.hint('可用备份恢复：' + profilePatchPath(ctx.facts.home, o.profile) + '.bak-<时间戳>（同目录）')
    return { ok: false, parseError: true, dump: text.slice(0, 4000) }
  }
  const hasEntry = /qwen-image/.test(text)
  const hasModelDir = o.modelDir ? text.indexOf(String(o.modelDir).replace(/\\/g, '/')) >= 0 || text.indexOf(String(o.modelDir)) >= 0 : true
  if (!r.ok) ui.warn('dump-config 退出码 ' + r.code + '（profile 尚未初始化时也会这样，重启 dsh 会自动创建）')
  if (hasEntry) ui.ok('配置树里能看到 qwen-image 这一层')
  else ui.warn('配置树里没看到 qwen-image：重启 dsh 后再确认一次，仍没有就把日志发出来')
  if (!hasModelDir) ui.detail('提示：配置树里没匹配到 modelDir ' + o.modelDir + '（可能只是路径写法差异）')
  return { ok: hasEntry, dump: text.slice(0, 4000) }
}

export { venvPython, IS_WIN }
