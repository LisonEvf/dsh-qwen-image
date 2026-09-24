// 从 profile 视角验证包解析：Host 半与 Client 半都能被正确解析到实际文件。
// 这是 DSH 启动时真正走的路径（loader 从 profile/host 基准解析裸包名）。
//
// 用法：
//   node scripts/check-profile-resolution.cjs              # 自动取 DSH_HOME（默认 ~/.dsh）下的 web profile
//   node scripts/check-profile-resolution.cjs --profile tui
//   DSH_HOME=/path/to/.dsh node scripts/check-profile-resolution.cjs
//
// 前置：插件已经注册进该 profile（dsh plugin --profile <p> add <本目录>）。
// 这里**不写死任何人的本机路径** —— 换台机器直接就能跑。
const { createRequire } = require('node:module')
const { existsSync, statSync } = require('node:fs')
const path = require('node:path')
const os = require('node:os')

/** 解析目标 profile 目录：--profile <name> > DSH_HOME > ~/.dsh。 */
function resolveProfile() {
  const argv = process.argv.slice(2)
  const i = argv.findIndex((a) => a === '--profile' || a === '-p')
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  const name = i >= 0 && argv[i + 1] ? argv[i + 1] : 'web'
  return { home, name, dir: path.join(home, 'profiles', name) }
}

const target = resolveProfile()
const PROFILE = target.dir
if (!existsSync(PROFILE)) {
  console.error(`\n找不到 profile 目录：${PROFILE}`)
  console.error('请先注册插件，例如：')
  console.error(`  dsh plugin --profile ${target.name} add "${path.resolve(__dirname, '..')}"`)
  console.error('或用 --profile <名字> / DSH_HOME 指定别的位置。\n')
  process.exit(2)
}
const req = createRequire(path.join(PROFILE, 'package.json'))

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  if (ok) {
    pass++
    console.log(`  ok   ${name}`)
  } else {
    fail++
    console.error(`  FAIL ${name}${detail ? `\n       ${detail}` : ''}`)
  }
}

console.log('\n=== 从 profile 视角验证包解析 ===\n')
console.log(`profile: ${PROFILE}\n`)

const PKG = '@lisonevf/dsh-qwen-image'

// ---- host 半：裸包名 ----
try {
  const main = req.resolve(PKG)
  check(`解析 ${PKG}（host 半）`, existsSync(main) && statSync(main).size > 1000, `${main} (${existsSync(main) ? statSync(main).size : 0} B)`)
  console.log(`       → ${main}`)

  // 真正 require 一次（DSH 的 loader 等价动作）
  const mod = req(main)
  check('host 半可被 require 且导出 apply', typeof mod.apply === 'function', Object.keys(mod).join(', '))
  check('host 半导出 name', mod.name === PKG, String(mod.name))
  check('host 半导出 Standard Schema Config', !!(mod.Config && mod.Config['~standard']))
} catch (err) {
  check(`解析并加载 ${PKG}（host 半）`, false, err.message)
}

// ---- client 半：子路径 ----
try {
  const client = req.resolve(`${PKG}/client`)
  check(`解析 ${PKG}/client（client 半）`, existsSync(client) && statSync(client).size > 1000, `${client} (${existsSync(client) ? statSync(client).size : 0} B)`)
  console.log(`       → ${client}`)
} catch (err) {
  check(`解析 ${PKG}/client（client 半）`, false, err.message)
}

// ---- package.json 的 dsh 元数据 ----
try {
  const pj = req(`${PKG}/package.json`)
  check('dsh.bundle.patch 已声明', !!pj.dsh?.bundle?.patch, JSON.stringify(pj.dsh?.bundle))
  check('dsh.client 已声明（platform=web）', pj.dsh?.client?.platform === 'web', JSON.stringify(pj.dsh?.client))
  check('dsh.client.inject 含 slots', Array.isArray(pj.dsh?.client?.inject) && pj.dsh.client.inject.includes('slots'))
} catch (err) {
  check('读取 package.json 的 dsh 元数据', false, err.message)
}

// ---- patch 层引用的 id 一致 ----
try {
  const { readFileSync } = require('node:fs')
  const patchPath = req.resolve(`${PKG}/package.json`).replace(/package\.json$/, 'cordis.patch.yml')
  const yml = readFileSync(patchPath, 'utf8')
  check('cordis.patch.yml 可读且 id/name 匹配', yml.includes('id: qwen-image') && yml.includes(PKG))
  const cfgKeys = [...yml.matchAll(/^\s{8}([a-zA-Z][A-Za-z0-9]*):/gm)].map((m) => m[1])
  check(`cordis.patch.yml 暴露 ${cfgKeys.length} 个配置项`, cfgKeys.length >= 20, cfgKeys.join(', '))
} catch (err) {
  check('cordis.patch.yml 检查', false, err.message)
}

console.log(`\n=== 结果：${pass} 通过，${fail} 失败 ===\n`)
process.exit(fail > 0 ? 1 : 0)
