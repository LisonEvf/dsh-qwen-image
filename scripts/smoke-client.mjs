// 客户端 bundle 契约校验（离线，无需浏览器）。
// 断言 lib/client.js 满足官方 __ModuleLoader__.load 契约与我们的槽位注册意图。
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CLIENT = join(ROOT, 'lib', 'client.js')

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  if (ok) {
    pass++
    console.log(`  ok   ${name}`)
  } else {
    fail++
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

console.log('\n=== 客户端 bundle 契约校验 ===\n')
console.log('lib/ 内容：')
for (const f of readdirSync(join(ROOT, 'lib'))) {
  console.log(`  ${f}  ${statSync(join(ROOT, 'lib', f)).size} bytes`)
}
console.log('')

let c
try {
  c = readFileSync(CLIENT, 'utf8')
} catch (err) {
  console.error(`找不到 ${CLIENT}：先运行 node scripts/build-client.mjs`)
  process.exit(1)
}

// ---- 官方 module loader 契约 ----
check('以 window.__ModuleLoader__.load( 开头', c.startsWith('window.__ModuleLoader__.load('), c.slice(0, 60))
check('声明正确的插件 id', c.includes('"@lisonevf/dsh-qwen-image"'))
check('factory 形态为 (require) => {...}', /factory:\s*\(require\)\s*=>/.test(c))
check('factory 返回 module.exports', c.includes('return module.exports'))
// esbuild 会把 sourceMappingURL 追加在 footer 之后，故先剥掉再判断收尾。
const body = c.replace(/\/\/# sourceMappingURL=.*\s*$/, '')
check('以 }); 收尾（忽略 sourcemap 注释）', body.trimEnd().endsWith('});'), JSON.stringify(body.slice(-30)))
check('带 sourceMappingURL 指向 client.js.map', c.includes('sourceMappingURL=client.js.map'))

// ---- react 必须 external（与宿主共享实例，hooks 才能工作）----
check("react 保持 external（require(\"react\")）", c.includes('require("react")'))
check('未把 react 打进 bundle（无 React 内部实现标记）', !c.includes('react-dom') && !c.includes('ReactCurrentDispatcher'))

// ---- 槽位注册 ----
check("注册 tool.call.toolview", c.includes('tool.call.toolview'))
check("卡片键 image_generate", c.includes('image_generate'))
check("卡片键 image_edit", c.includes('image_edit'))

// ---- 相册：conversation.view（回顾 + 管理，但仍不是生图入口）----
check("注册 conversation.view（历史相册）", c.includes('conversation.view'))
check("相册视图 id=qwen-image", c.includes('qwen-image'))
check("相册标签「相册」", c.includes('相册'))
check("order 声明", /order:\s*6/.test(c))
// 网格必须走缩略图（否则几十张图每张拉 1MB 原图，回顾会卡）
check("网格使用 /thumb 缩略图", c.includes('/thumb?id='))
check("灯箱使用 /raw 原图", c.includes('/raw?id='))
// 相册只管**管理**，不该出现生图/改图的表单入口（生成永远在对话里）
check("相册不含生图/改图提交入口（管理≠生成）", !/生成张数|生成按钮/.test(c))
// v2 管理能力必须在 bundle 里（防止构建时被摇掉）
check("相册带查询输入框", /搜索提示词/.test(c))
check("相册带排序/分组控件", c.includes('按标签') && c.includes('按日期'))
check("相册带批量操作（加标签/删除）", c.includes('全选当前列表') && c.includes('加标签'))
check("相册带回收站（删除可还原）", c.includes('回收站') && c.includes('还原'))
check("相册带产物扫描入口（孤儿图补录）", c.includes('扫描产物') && c.includes('/recover'))
check("相册调用 /update 与 /delete 路由", c.includes('/update') && c.includes('/delete'))

// ---- 显示闭环：必须用同源 /raw 路由拼图片 URL ----
check("使用同源 /raw?id= 拼图片 URL", c.includes('/raw?id='))
check("读取宿主注入的 routePrefix", c.includes('__QWEN_IMAGE__'))
check("routePrefix 默认回退值存在", c.includes('/api/qwen-image'))

// ---- 工具契约对齐（读 block.meta / isError / tool-result）----
check("识别 settled 形态 kind==='tool-result'", c.includes('tool-result'))
check("读取 block.meta（presentationMeta 投影）", c.includes('.meta'))
check("处理 isError", c.includes('isError'))
check("从 argsRaw 解析参数", c.includes('argsRaw'))

// ---- 不该出现的东西 ----
check('未引入 import/require 之外的 node 内建', !c.includes('require("fs")') && !c.includes('require("path")'))
check('未使用 JSX 残留（<> 语法）', !/<[A-Z][A-Za-z]*\s*\/>/.test(c))

console.log(`\n=== 结果：${pass} 通过，${fail} 失败 ===\n`)
process.exit(fail > 0 ? 1 : 0)
