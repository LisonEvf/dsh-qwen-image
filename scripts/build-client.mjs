// 生成器：src/client/index.ts → lib/client.js（随插件分发的 browser bundle）。
//
// 官方 __ModuleLoader__.load 契约：factory 返回 { name, inject, apply }，
// client 内核挂载时调用 apply(ctx)。'react' 保持 external —— 运行时经 loader
// 模块表（平台种子）解析，与宿主渲染器共享同一 React 实例（hooks 才能工作）。
// JSX 用经典转换（React.createElement），只依赖 'react' 一个外部模块。
//
// 依赖：esbuild（devDependency）。不可用时跳过并给出提示，不硬失败——
// 这样 host 半仍可单独构建与使用（只是没有界面卡片）。

import { mkdirSync, readFileSync, unlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ENTRY = join(ROOT, 'src', 'client', 'index.ts')
const OUTPUT = join(ROOT, 'lib', 'client.js')
const PLUGIN_ID = '@lisonevf/dsh-qwen-image'

/** 包装头/尾：让 esbuild 直接产出完整文件（banner+body+footer），sourcemap 行号才对得上。 */
const WRAP_HEAD =
  'window.__ModuleLoader__.load({\n' +
  '\tid: ' + JSON.stringify(PLUGIN_ID) + ',\n' +
  '\tfactory: (require) => {\n' +
  '\t\tvar module = { exports: {} };\n' +
  '\t\tvar exports = module.exports;\n'

const WRAP_TAIL =
  '\n\t\treturn module.exports;\n' +
  '\t}\n' +
  '});\n'

const MINIFY = process.env.CLIENT_MINIFY !== '0'

function buildConfig(outfile, { sourcemap = false } = {}) {
  return {
    entryPoints: [ENTRY],
    bundle: true,
    format: 'cjs',
    platform: 'browser',
    target: 'es2020',
    external: ['react'],
    jsx: 'transform',
    jsxFactory: 'React.createElement',
    jsxFragment: 'React.Fragment',
    minify: MINIFY,
    // 保留 UTF-8 原字符：默认 charset=ascii 会把中文转成 \uXXXX，
    // 既不利于人工核对，也让 bundle 更大（我们的文案大量是中文）。
    charset: 'utf8',
    ...(sourcemap ? { sourcemap: true } : {}),
    banner: { js: WRAP_HEAD },
    footer: { js: WRAP_TAIL },
    outfile,
    logLevel: 'warning',
  }
}

async function esbuildAvailable() {
  try {
    await import('esbuild')
    return true
  } catch {
    return false
  }
}

export async function generate({ check = false } = {}) {
  if (!(await esbuildAvailable())) {
    return { ok: true, skipped: 'esbuild 不可用：请在项目内安装 devDependencies（npm install）' }
  }
  const { build } = await import('esbuild')

  if (!check) {
    mkdirSync(join(ROOT, 'lib'), { recursive: true })
    await build(buildConfig(OUTPUT, { sourcemap: true }))
    return { ok: true }
  }

  const tmpOut = OUTPUT + '.tmp'
  await build(buildConfig(tmpOut, { sourcemap: false }))
  const fresh = readFileSync(tmpOut, 'utf8')
  try {
    unlinkSync(tmpOut)
  } catch {
    /* ignore */
  }
  let committed = null
  try {
    committed = readFileSync(OUTPUT, 'utf8')
  } catch {
    return { ok: false, errors: [`${OUTPUT} 不存在：先运行 node scripts/build-client.mjs`] }
  }
  const strip = (s) => s.replace(/\/\/# sourceMappingURL=.*\n?$/, '')
  if (strip(committed) !== strip(fresh)) {
    return { ok: false, errors: ['lib/client.js 与生成器输出不一致：重新运行 node scripts/build-client.mjs（禁止手改生成物）'] }
  }
  return { ok: true }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const check = process.argv.includes('--check')
  const result = await generate({ check })
  if (result.skipped) {
    console.log(`[build-client] SKIP：${result.skipped}`)
    process.exit(0)
  }
  if (!result.ok) {
    for (const e of result.errors ?? []) console.error(`[build-client] ${e}`)
    process.exit(1)
  }
  console.log(check ? '[build-client] client.js 新鲜（--check OK）' : '[build-client] client.js 已生成')
}
