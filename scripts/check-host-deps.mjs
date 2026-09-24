// 校验 host 半产物**没有任何不可解析的外部 require**。
//
// 这是插件以 `link:` 装入 profile 时的硬约束：Node 按 realpath 解析链接包，
// 从插件目录向上查找时**够不到** dsh 安装目录里的 `@deepseek-ai/*`。
// 一旦产物里出现这类 require，启动就会报
//   "Cannot find module '@deepseek-ai/dsh-tools'" 并导致整个插件树加载失败。
//
// 运行：node scripts/check-host-deps.mjs
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BUNDLE = join(ROOT, 'lib', 'index.cjs')
const require = createRequire(import.meta.url)

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

/**
 * 去掉注释与字符串字面量，避免把文档里的示例文本（如 `require('@deepseek-ai/...')`）
 * 误判成真实依赖。保留正则能识别的结构。
 */
function stripCommentsAndStrings(code) {
  let out = ''
  let i = 0
  const n = code.length
  while (i < n) {
    const c = code[i]
    const c2 = code[i + 1]
    // 行注释
    if (c === '/' && c2 === '/') {
      while (i < n && code[i] !== '\n') i++
      continue
    }
    // 块注释
    if (c === '/' && c2 === '*') {
      i += 2
      while (i < n && !(code[i] === '*' && code[i + 1] === '/')) i++
      i += 2
      continue
    }
    // 字符串 / 模板串：整体替换为占位，避免内容被当代码
    if (c === '"' || c === "'" || c === '`') {
      const quote = c
      out += quote
      i++
      while (i < n) {
        if (code[i] === '\\') {
          i += 2
          continue
        }
        if (code[i] === quote) break
        i++
      }
      out += quote
      i++
      continue
    }
    out += c
    i++
  }
  return out
}

console.log('\n=== host 半外部依赖检查 ===\n')
const raw = readFileSync(BUNDLE, 'utf8')
const code = stripCommentsAndStrings(raw)

// 收集所有 require("...") 的裸模块名（只看真实代码，不看注释/字符串）
const specs = new Set()
for (const m of code.matchAll(/require\(\s*["'`]([^"'`]+)["'`]\s*\)/g)) specs.add(m[1])

console.log(`产物：lib/index.cjs（${raw.length} B）`)
console.log(`真实外部 require（${specs.size}）：${[...specs].join(', ') || '（无）'}\n`)

const bare = [...specs].filter((s) => !s.startsWith('.') && !s.startsWith('node:'))
const nodeBuiltins = [...specs].filter((s) => s.startsWith('node:'))

check(
  '没有任何裸包 require（不可解析的外部依赖）',
  bare.length === 0,
  bare.length ? `发现：${bare.join(', ')} —— 必须内联或改用 node: 内建` : '',
)
check(
  '不存在 @deepseek-ai/* 运行时依赖',
  ![...specs].some((s) => s.startsWith('@deepseek-ai/')),
  [...specs].filter((s) => s.startsWith('@deepseek-ai/')).join(', '),
)
check('node: 内建形态合法', nodeBuiltins.every((s) => /^node:[a-z/]+$/.test(s)), nodeBuiltins.join(', '))

// 契约面：工具与配置仍完整导出
check('导出 name', /exports\.name\s*=/.test(code) || /name:\s*"@lisonevf/.test(code))
check('导出 apply', /exports\.apply\s*=/.test(code) || /function apply\(/.test(code))
check('导出 Config（Standard Schema）', raw.includes('~standard'))
check('导出 inject 声明', raw.includes('"tools"') && raw.includes('"webServer"'))

// 自包含的 DSL 确实被打进去了
check('内联了工具 DSL', raw.includes('is not supported by the value schema DSL'))
check('内联了 Standard Schema 校验', raw.includes('expected string but got') || raw.includes('expected oneOf'))

// 真实代码里不应残留官方包引用
check('代码中未引用 @deepseek-ai/dsh-tools', !code.includes('@deepseek-ai/dsh-tools'))
check('代码中未引用 @deepseek-ai/schemastery', !code.includes('@deepseek-ai/schemastery'))
check('代码中未引用 @deepseek-ai/cordis（类型已擦除）', !code.includes('@deepseek-ai/cordis'))

// 实际加载一次（除 node: 内建外无外部依赖，理应可独立 require）
console.log('')
try {
  const mod = require(BUNDLE)
  check('产物可被独立 require（无外部依赖）', typeof mod.apply === 'function', `exports: ${Object.keys(mod).join(', ')}`)
  check('Config 是 Standard Schema', !!(mod.Config && mod.Config['~standard']))
  if (mod.Config && mod.Config['~standard']) {
    const r = mod.Config['~standard'].validate({})
    const count = 'value' in r ? Object.keys(r.value).length : -1
    check('Config 空输入填充全部 20 个默认值', count === 20, `实际 ${count}`)
    if ('value' in r) {
      check('默认 backend=diffusers', r.value.backend === 'diffusers', r.value.backend)
      check('默认 dtype=auto（由 worker 按卡决策）', r.value.dtype === 'auto', r.value.dtype)
      check('默认 routePrefix=/api/qwen-image', r.value.routePrefix === '/api/qwen-image', r.value.routePrefix)
    }
    const bad = mod.Config['~standard'].validate({ backend: 'nope' })
    check(
      '非法枚举被拒绝并给出可读 issue',
      'issues' in bad && /backend/.test(bad.issues[0].message),
      JSON.stringify(bad).slice(0, 200),
    )
    const badNum = mod.Config['~standard'].validate({ defaultSteps: 9999 })
    check('超范围数字被拒绝', 'issues' in badNum && /defaultSteps/.test(badNum.issues[0].message), JSON.stringify(badNum).slice(0, 200))
  }
} catch (err) {
  check('产物可被独立 require（无外部依赖）', false, err.message)
}

console.log(`\n=== 结果：${pass} 通过，${fail} 失败 ===\n`)
process.exit(fail > 0 ? 1 : 0)
