#!/usr/bin/env node
/**
 * 发布闸门：推送 GitHub 之前跑一遍，确认「普通用户一键安装」真的成立。
 *
 * 为什么需要它：本项目是**零依赖一键安装**（用户双击 install.bat，不跑 npm install），
 * 因此有几条只靠普通冒烟测不出来的硬约束，历史上全部踩过：
 *   1. `lib/` 是构建产物却必须入库 —— 否则用户拿到包裹后插件加载不了；
 *   2. `.gitignore` 里写过没有前导斜杠的 `lib/`，git 会匹配任意层级，
 *      把 `installer/lib/`（安装器源码）一起忽略掉，克隆后安装器直接崩；
 *   3. 缺 `.gitattributes` 时 Windows 的 autocrlf 会把 `install.sh` 转成 CRLF，
 *      shebang 变 `#!/usr/bin/env sh\r`，Linux/macOS 一键安装全废；
 *   4. 公开发布前要确认没有残留占位 URL 与作者本机绝对路径。
 *
 * 用法：
 *   node scripts/check-release.mjs          # 只读检查（可在任意机器上跑）
 *   node scripts/check-release.mjs --full   # 额外：重建 lib/ 并核对已入库产物是否过期
 *                                           #（--full 需要 devDependencies，且会改动 lib/）
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const FULL = process.argv.includes('--full')

let pass = 0
let fail = 0
const warnings = []
const check = (name, ok, detail = '') => {
  if (ok) {
    pass++
    console.log(`  ok   ${name}`)
  } else {
    fail++
    console.error(`  FAIL ${name}${detail ? `\n       ${detail}` : ''}`)
  }
}
const warn = (name, detail) => {
  warnings.push(`${name}${detail ? ' —— ' + detail : ''}`)
  console.log(`  warn ${name}${detail ? `\n       ${detail}` : ''}`)
}

/** 读取文本；文件不存在返回 null。 */
function readText(rel) {
  const p = join(ROOT, rel)
  return existsSync(p) ? readFileSync(p, 'utf8') : null
}

/** 递归收集文件（跳过 node_modules / lib / .git 等）。 */
function walk(dir, out = [], skip = /(^|[\\/])(node_modules|\.git|outputs|__pycache__|venv)([\\/]|$)/) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (skip.test(p)) continue
    if (entry.isDirectory()) walk(p, out, skip)
    else out.push(p)
  }
  return out
}

const git = (args) => {
  try {
    return { ok: true, out: execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }
  } catch (err) {
    return { ok: false, out: (err.stdout || '') + (err.stderr || ''), code: err.status }
  }
}

console.log('\n=== 发布闸门：dsh-qwen-image ===\n')
console.log(`项目目录：${ROOT}\n`)

// ────────────────────────────────────────────────────────────
console.log('【A】一键安装所必需的运行时文件（用户拿到包裹后不跑 npm install）')
// ────────────────────────────────────────────────────────────
const REQUIRED = [
  // 插件本体构建产物：package.json 的 main / exports["./client"] 直接指向它们
  ['lib/index.cjs', 'host 半产物（package.json 的 main）'],
  ['lib/client.js', 'client 半产物（exports["./client"]，界面卡片/相册靠它）'],
  // 安装器：全部是源码，必须随仓库分发
  ['installer/install.mjs', '安装器入口'],
  ['installer/lib/ui.mjs', '安装器──终端输出'],
  ['installer/lib/util.mjs', '安装器──进程/文件/下载'],
  ['installer/lib/detect.mjs', '安装器──环境探测'],
  ['installer/lib/plan.mjs', '安装器──决策层'],
  ['installer/lib/pystep.mjs', '安装器──Python/venv/依赖'],
  ['installer/lib/modelstep.mjs', '安装器──权重'],
  ['installer/lib/pluginstep.mjs', '安装器──插件注册'],
  // 双击入口与包元数据
  ['install.bat', 'Windows 双击入口'],
  ['install.sh', 'Linux/macOS 入口'],
  ['使用说明.txt', '普通用户第一页'],
  ['cordis.patch.yml', 'dsh.bundle.patch 声明的入口'],
  ['package.json', '包元数据'],
  ['README.md', '仓库门面'],
  ['LICENSE', '开源许可'],
  // worker（Python 侧）
  ['worker/server.py', 'worker HTTP 服务'],
  ['worker/pipeline_qwen21.py', '推理管道'],
  ['worker/requirements.txt', 'worker 依赖清单'],
  // 随包技能
  ['skills/dsh-qwen-image.md', '随包技能内容'],
]
for (const [rel, why] of REQUIRED) {
  check(`${rel}（${why}）`, existsSync(join(ROOT, rel)))
}

// ────────────────────────────────────────────────────────────
console.log('\n【B】.gitignore 不能误伤必须入库的文件')
// ────────────────────────────────────────────────────────────
const gitignore = readText('.gitignore')
check('.gitignore 存在', !!gitignore)
if (gitignore) {
  // 这条正是历史事故：无前导斜杠的 lib/ 会匹配 installer/lib/
  const broadLib = /^\s*lib\/?\s*$/m.test(gitignore)
  check(
    '.gitignore 没有「无前导斜杠的 lib/」这种会匹配到 installer/lib/ 的模式',
    !broadLib,
    broadLib ? '发现裸 `lib/` —— git 会匹配任意层级的 lib 目录，把 installer/lib/（安装器源码）一起忽略，克隆后安装器直接崩' : '',
  )
  check('.gitignore 未忽略 lib/index.cjs（构建产物必须入库）', !/^\s*\/?lib\/?\s*$/m.test(gitignore))
}
check('.gitattributes 存在（钉死行尾，否则 install.sh 在 Windows 上会被转成 CRLF）', existsSync(join(ROOT, '.gitattributes')))
const ga = readText('.gitattributes')
if (ga) {
  check('.gitattributes 声明了 shell 用 LF', /\*\.sh\s+text\s+eol=lf/.test(ga))
  check('.gitattributes 声明了批处理用 CRLF', /\*\.(bat|cmd)\s+text\s+eol=crlf/.test(ga))
}

// 在 git 仓库里时，用 git 自己的规则复核（最有说服力）
if (existsSync(join(ROOT, '.git'))) {
  const mustTrack = ['installer/lib/ui.mjs', 'installer/lib/plan.mjs', 'lib/index.cjs', 'lib/client.js', 'install.bat', 'install.sh', '使用说明.txt', 'LICENSE']
  for (const rel of mustTrack) {
    const ig = git(['check-ignore', '-q', rel])
    check(`git 不会忽略 ${rel}`, ig.ok === false || ig.code !== 0, '被 .gitignore 忽略了')
  }
} else {
  warn('尚未 git init', '跳过 git check-ignore 复核（git init 后重跑即可）')
}

// ────────────────────────────────────────────────────────────
console.log('\n【C】行尾：install.sh / install.bat 在克隆后必须仍然正确')
// ────────────────────────────────────────────────────────────
const shBuf = readFileSync(join(ROOT, 'install.sh'))
const shHasCR = shBuf.includes(0x0d)
check('install.sh 是纯 LF（含 CR 会被 Linux/macOS 报 bad interpreter）', !shHasCR, shHasCR ? '发现 CR 字节（0x0D）' : '')
check('install.sh 以 shebang 开头', shBuf.subarray(0, 2).toString() === '#!')
const batText = readText('install.bat')
check('install.bat 已填好真实仓库地址（不是空占位）', !!batText && /github\.com\/lisonevf\/dsh-qwen-image/.test(batText))

// ────────────────────────────────────────────────────────────
console.log('\n【D】公开发布前的洁净度：占位符与作者本机路径')
// ────────────────────────────────────────────────────────────
// 只看会随包分发/展示给用户的文件（源码注释与验收日志另有口径，见下）
const USER_FACING = [
  'README.md',
  '使用说明.txt',
  'install.bat',
  'install.sh',
  'package.json',
  'cordis.patch.yml',
  'LICENSE',
  'docs/INSTALL.md',
  'docs/TROUBLESHOOTING.md',
  'docs/HARDWARE.md',
  'docs/TOOLS.md',
  'skills/dsh-qwen-image.md',
]
const PLACEHOLDER = [/https:\/\/github\.com\/\s*$/, /https:\/\/github\.com\/\s+/, /\$\{[A-Z]\}/, /\byour-?name\b/i, /\bTODO\b/, /\bFIXME\b/]
for (const rel of USER_FACING) {
  const text = readText(rel)
  if (text == null) {
    warn(`${rel} 不存在`, '文件清单里列了但没找到')
    continue
  }
  const hits = []
  text.split(/\r?\n/).forEach((line, i) => {
    for (const re of PLACEHOLDER) {
      if (re.test(line)) hits.push(`${rel}:${i + 1}  ${line.trim().slice(0, 120)}`)
    }
  })
  check(`${rel} 无占位符残留`, hits.length === 0, hits.join('\n       '))
}

// 作者本机绝对路径：用户照抄必然失败，必须清掉
const PERSONAL = [/C:[\\/]Users[\\/]Lison/i, /EvfWorkSpace/i, /Desktop[\\/]EvfWork/i]
for (const rel of USER_FACING) {
  const text = readText(rel)
  if (text == null) continue
  const hits = []
  text.split(/\r?\n/).forEach((line, i) => {
    if (PERSONAL.some((re) => re.test(line))) hits.push(`${rel}:${i + 1}  ${line.trim().slice(0, 120)}`)
  })
  check(`${rel} 无作者本机绝对路径`, hits.length === 0, hits.join('\n       '))
}

// 开发脚本里的本机路径只警告（它们不随包安装，但公开仓库里同样不友好）
for (const rel of ['scripts/check-profile-resolution.cjs', 'scripts/verify-against-real-dsh.mjs']) {
  const text = readText(rel)
  if (text && PERSONAL.some((re) => re.test(text))) warn(`${rel} 含作者本机路径`, '建议改为读 DSH_HOME 或环境变量')
}

// ────────────────────────────────────────────────────────────
console.log('\n【E】包元数据自洽')
// ────────────────────────────────────────────────────────────
const pkg = JSON.parse(readText('package.json'))
check('name 与安装器里的 PACKAGE_NAME 一致', pkg.name === '@lisonevf/dsh-qwen-image', pkg.name)
check('version 已填', /^\d+\.\d+\.\d+/.test(pkg.version), pkg.version)
check('license 不是模型那边的 Qwen Research License', pkg.license === 'Apache-2.0', `实际 ${pkg.license}`)
check('main 指向 lib/index.cjs', pkg.main === './lib/index.cjs', pkg.main)
check('exports 声明了 ./client', !!(pkg.exports && pkg.exports['./client']), JSON.stringify(pkg.exports || {}))
check('dsh.bundle.patch 已声明', !!(pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch))
check('dsh.client.platform 是 web', !!(pkg.dsh && pkg.dsh.client && pkg.dsh.client.platform === 'web'))
check('files 清单包含 lib（构建产物要随包分发）', Array.isArray(pkg.files) && pkg.files.includes('lib'))
check('files 清单包含 LICENSE', Array.isArray(pkg.files) && pkg.files.includes('LICENSE'))
check('repository.url 指向真实仓库', !!(pkg.repository && /lisonevf\/dsh-qwen-image/.test(pkg.repository.url)), JSON.stringify(pkg.repository || {}))

// cordis.patch.yml 的配置项数量（安装器重写块与文档表都按这个数对齐）
const patch = readText('cordis.patch.yml') || ''
const patchKeys = [...patch.matchAll(/^\s{8}([a-zA-Z][a-zA-Z0-9]*):/gm)].map((m) => m[1])
check(`cordis.patch.yml 暴露 20 个配置项（实际 ${patchKeys.length}）`, patchKeys.length === 20, patchKeys.join(', '))

// ────────────────────────────────────────────────────────────
console.log('\n【F】文档里引用的仓库内文件确实存在')
// ────────────────────────────────────────────────────────────
for (const rel of ['docs/INSTALL.md', 'docs/TROUBLESHOOTING.md', 'docs/HARDWARE.md', 'docs/TOOLS.md', 'docs/PLAN.md']) {
  check(`${rel} 存在`, existsSync(join(ROOT, rel)))
}
// 引用 docs/PLAN.md 的地方要指向真实位置
for (const rel of ['README.md', 'docs/INSTALL.md', 'docs/TOOLS.md', 'docs/TROUBLESHOOTING.md', 'docs/HARDWARE.md']) {
  const text = readText(rel)
  if (!text) continue
  const bad = /仓库根目录的\s*`?PLAN\.md/.test(text)
  check(`${rel} 不再引用「仓库根目录的 PLAN.md」（已移到 docs/PLAN.md）`, !bad)
}

// ────────────────────────────────────────────────────────────
console.log('\n【G】耗时口径一致（文档 / 技能 / 代码三处必须同一个数）')
// ────────────────────────────────────────────────────────────
const speed = readText('src/host/speed-profile.ts') || ''
check('speed-profile.ts 首步常量是 85s（区间 78–93）', /FIRST_STEP_SEC\s*=\s*85/.test(speed) && /\[78,\s*93\]/.test(speed))
const skillTs = readText('src/host/skill.ts') || ''
check('skill.ts 内置兜底用 5.0 分钟（不是 5.1）', /standard 1024²\/24步 ≈ 5\.0 分钟/.test(skillTs), '残留 5.1 分钟')
check('skill.ts 内置兜底用 43 分钟（不是 42）', /native 2048²\/40步 ≈ 43 分钟/.test(skillTs), '残留 42 分钟')
const skillMd = readText('skills/dsh-qwen-image.md') || ''
check('技能文件用 2.5 分钟（不是 2.6）', /≈ 2\.5 分钟/.test(skillMd), '残留 2.6 分钟')
check('技能文件用 43 分钟（不是 42）', /≈ 43 分钟/.test(skillMd))
for (const rel of ['docs/HARDWARE.md', 'docs/TOOLS.md']) {
  const text = readText(rel) || ''
  const stale = text.split(/\r?\n/).map((l, i) => [l, i + 1]).filter(([l]) => /42\s*分|2530\s*s/.test(l))
  check(`${rel} 无「42 分 / 2530 s」过期耗时`, stale.length === 0, stale.map(([l, n]) => `${rel}:${n} ${l.trim().slice(0, 100)}`).join('\n       '))
}

// ────────────────────────────────────────────────────────────
console.log('\n【H】权重绝不能进仓库')
// ────────────────────────────────────────────────────────────
const bigOrWeight = walk(ROOT).filter((p) => /\.(safetensors|ckpt|onnx|pt|bin)$/i.test(p) || statSync(p).size > 5 * 1024 * 1024)
check('仓库内无权重文件 / 无 >5MB 的大文件', bigOrWeight.length === 0, bigOrWeight.map((p) => `${relative(ROOT, p)} (${(statSync(p).size / 1024 / 1024).toFixed(1)} MB)`).join('\n       '))
const gi = readText('.gitignore') || ''
check('.gitignore 忽略了 *.safetensors', /\*\.safetensors/.test(gi))
check('.gitignore 忽略了 outputs/', /^outputs\/?$/m.test(gi))

// ────────────────────────────────────────────────────────────
if (FULL) {
  console.log('\n【I】--full：重建 lib/ 并核对已入库的产物是否过期')
  // ────────────────────────────────────────────────────────────
  if (!existsSync(join(ROOT, 'node_modules'))) {
    warn('跳过重建核对', '本地没有 node_modules（需要 devDependencies 才能重建）')
  } else {
    try {
      console.log('  … 正在 npm run build')
      execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], { cwd: ROOT, stdio: 'ignore' })
      check('重建后 lib/index.cjs 仍是有效文件', statSync(join(ROOT, 'lib/index.cjs')).size > 1000)
      if (existsSync(join(ROOT, '.git'))) {
        const st = git(['status', '--porcelain', '--', 'lib'])
        const dirty = (st.out || '').trim()
        check(
          '已入库的 lib/ 与 src/ 一致（重建后 git diff 为空）',
          dirty === '',
          `重建改变了这些产物，说明提交的 lib/ 已过期，需要把 lib/ 一起提交：\n       ${dirty}`,
        )
      } else {
        warn('跳过 lib/ 过期核对', '尚未 git init')
      }
    } catch (err) {
      check('重建 lib/', false, String(err && err.message ? err.message : err))
    }
  }
} else {
  console.log('\n【I】--full：跳过（加 --full 可重建 lib/ 核对产物是否过期）')
}

// ────────────────────────────────────────────────────────────
console.log(`\n=== 结果：${pass} 通过，${fail} 失败，${warnings.length} 警告 ===`)
if (warnings.length) {
  console.log('\n警告：')
  for (const w of warnings) console.log('  - ' + w)
}
console.log(
  fail === 0
    ? '\n发布条件满足：可以推送到 GitHub。别忘了 `npm test` 与（有条件时）`npm run test:real` 也要绿。\n'
    : '\n尚有阻塞项，先修完再推。\n',
)
process.exit(fail > 0 ? 1 : 0)
