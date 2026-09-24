// host 半构建：src/index.ts → lib/index.cjs（CJS，外部依赖留给运行时解析）。
//
// 直接调用**本地**安装的 tsdown，避免依赖 npx 在 PATH 上存在
// （实测 Windows Store Python 环境下 `npx` 可能 spaw​n ENOENT）。
// 自包含：不假设旁边有 monorepo checkout，也不做类型检查。

import { existsSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 定位 tsdown 可执行文件（本地 node_modules → 再退回 npx）。 */
function resolveTsdown() {
  const candidates =
    process.platform === 'win32'
      ? [join(ROOT, 'node_modules', '.bin', 'tsdown.cmd'), join(ROOT, 'node_modules', '.bin', 'tsdown')]
      : [join(ROOT, 'node_modules', '.bin', 'tsdown')]
  for (const c of candidates) {
    if (existsSync(c)) return { cmd: c, args: [] }
  }
  // 回退：让 npx 去取（仅在本地没装 devDependencies 时走到）
  return { cmd: process.platform === 'win32' ? 'npx.cmd' : 'npx', args: ['-y', 'tsdown'] }
}

const { cmd, args } = resolveTsdown()
console.log(`[build] 构建 host 半 → lib/（${cmd}）`)

// 只清理 host 半自己的产物。lib/ 里还有 client.js（esbuild 生成的 client 半），
// 用 tsdown 的 clean 会把它一起删掉 —— 界面上卡片就消失了。
for (const stale of ['index.cjs', 'index.cjs.map', 'index.js', 'index.mjs']) {
  const p = join(ROOT, 'lib', stale)
  if (existsSync(p)) {
    try {
      rmSync(p)
    } catch {
      /* 删不掉就让 tsdown 覆盖 */
    }
  }
}

const r = spawnSync(cmd, [...args], {
  cwd: ROOT,
  stdio: 'inherit',
  env: process.env,
  shell: process.platform === 'win32',
})

if (r.error) {
  console.error(`[build] 无法执行 tsdown：${r.error.message}`)
  console.error('[build] 请先在项目内安装 devDependencies：npm install')
  process.exit(1)
}
if (r.status !== 0) {
  console.error(`[build] tsdown 退出码 ${r.status}`)
  process.exit(r.status ?? 1)
}

if (!existsSync(join(ROOT, 'lib', 'index.cjs'))) {
  console.error('[build] 构建结束但 lib/index.cjs 不存在 —— 检查 tsdown.config.mts')
  process.exit(1)
}
console.log('[build] 完成')
