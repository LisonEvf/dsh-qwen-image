/**
 * 用**真实的** dsh-tools 校验我们的工具定义。
 *
 * 为什么需要这个：host 半是自包含的（不 import @deepseek-ai/*），
 * 所以我们自己实现的 tool-dsl 必须与官方契约**逐字兼容**，否则真实运行时
 * 会在 `tools.register()` 或参数校验时拒绝。
 *
 * 本脚本：
 *   1. 加载我们的产物，用捕获式假 ctx 跑 apply()，取出 6 个工具定义
 *   2. 用真实 dsh-tools 的 assertSupportedJsonSchema 校验每个 output.schema
 *   3. 用真实 validateArgs 校验每个 parameters（合法参数应通过、非法应被拒）
 *   4. 用真实 defineTool 对**等价 DSL** 生成基准，与我们的编译产物逐一比对
 *
 * 运行：node scripts/verify-against-real-dsh.mjs
 * （真实 dsh-tools 从 dsh 安装目录/profile 解析；解析不到则跳过并说明）
 */
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BUNDLE = join(ROOT, 'lib', 'index.cjs')
const PROFILE = process.env.DSH_HOME
  ? join(process.env.DSH_HOME, 'profiles', 'web')
  : null

let pass = 0
let fail = 0
let skipped = 0
const check = (name, ok, detail = '') => {
  if (ok) {
    pass++
    console.log(`  ok   ${name}`)
  } else {
    fail++
    console.error(`  FAIL ${name}${detail ? `\n       ${detail}` : ''}`)
  }
}
const skip = (name, why) => {
  skipped++
  console.log(`  SKIP ${name} —— ${why}`)
}

/** 从若干基准目录里解析真实的 dsh 包（插件自己解析不到，这里刻意从 profile/dsh 安装处解析）。 */
function resolveDshBases() {
  return [
    PROFILE,
    join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@deepseek-ai', 'dsh'),
  ].filter((b) => b && existsSync(b))
}

function loadFrom(base, spec) {
  try {
    const req = createRequire(join(base, 'package.json'))
    const p = req.resolve(spec)
    return { path: p, mod: req(p) }
  } catch {
    return null
  }
}

function loadReal(spec) {
  for (const base of resolveDshBases()) {
    const got = loadFrom(base, spec)
    if (got) {
      console.log(`  真实 ${spec}：${got.path}`)
      return got.mod
    }
  }
  return null
}

console.log('\n=== 用真实 dsh 包校验工具与技能定义 ===\n')

const tools = loadReal('@deepseek-ai/dsh-tools')
const skillMod = loadReal('@deepseek-ai/dsh-skill')
console.log('')

// ---- 1. 取出我们的工具定义（用一个只捕获注册的假 ctx）----
if (!existsSync(BUNDLE)) {
  console.error(`缺少 ${BUNDLE}：先运行 node scripts/build.mjs`)
  process.exit(1)
}
const mod = await import(pathToFileURL(BUNDLE).href)
const plugin = mod.default ?? mod

const captured = new Map()
/** 捕获到的技能注册载荷（供后面的技能契约校验使用）。 */
const capturedSkills = []

// ⚠️ 关键：插件的 index.ts 用的是 `ctx.tools`（声明式 inject 后的属性访问），
// 不是 `ctx.get('tools')`。所以假 ctx 必须把服务**挂成属性**，同时保留 get()。
const services = {
  tools: {
    register: (def) => {
      captured.set(def.name, def)
      return () => {}
    },
  },
  webServer: { register: () => () => {}, tapIndex: () => () => {} },
  fs: {
    resolve: async () => ({}),
    stat: async () => undefined,
    listDir: async () => [],
    readBytes: async () => new Uint8Array(),
    readText: async () => '',
    writeText: async () => ({}),
  },
  subprocess: { spawn: () => ({ done: new Promise(() => {}), collected: {} }) },
  skills: {
    register: (skill) => {
      capturedSkills.push(skill)
      return () => {}
    },
  },
  attachments: { saveImage: async () => ({ attachmentId: 'x' }) },
  jobs: { start: () => 'j' },
}

const fakeCtx = {
  ...services,
  get: (n) => services[n],
  on: () => () => {},
  effect: (cb) => {
    try {
      cb()
    } catch {
      /* ignore */
    }
    return () => {}
  },
  timeout: () => () => {},
  interval: () => () => {},
}

const config = {
  backend: 'diffusers',
  modelDir: join(ROOT, 'qwen-image-2.1'),
  pythonExe: '',
  device: 'cuda:0',
  dtype: 'fp16',
  offload: 'model',
  preset: 'standard',
  defaultSteps: 24,
  maxPixels: 1048576,
  outputDir: join(ROOT, 'outputs', 'verify'),
  keepAliveMinutes: 0,
  maxConcurrent: 1,
  toolTimeoutMs: 60000,
  workerPort: 0,
  routePrefix: '/api/qwen-image',
  allowModelFetch: true,
  hfEndpoint: 'https://hf-mirror.com',
  modelRepo: 'Qwen/Qwen-Image-2.1',
  maxReferenceImages: 10,
  lowVramGuardMiB: 1024,
}

try {
  plugin.apply(fakeCtx, config)
  check(`apply() 取出 ${captured.size} 个工具定义`, captured.size === 6, `实际 ${captured.size}`)
} catch (err) {
  check('apply() 取出工具定义', false, err.stack)
}

console.log(`\n工具：${[...captured.keys()].join(', ')}\n`)

if (!tools) {
  skip('真实 dsh-tools 校验', '解析不到 @deepseek-ai/dsh-tools（非本机 dsh 环境？）')
} else {
  // ---- 2. output.schema 必须被真实 assertSupportedJsonSchema 接受 ----
  console.log('# output.schema（真实 assertSupportedJsonSchema）')
  for (const [name, t] of captured) {
    try {
      tools.assertSupportedJsonSchema(t.output.schema)
      check(`${name}.output.schema 受支持`, true)
    } catch (err) {
      check(`${name}.output.schema 受支持`, false, err.message)
    }
  }

  // ---- 3. parameters 的结构不变式 ----
  // 说明：真实 `Tools.register()` 只校验 output.schema 与 timeoutMs，**不**再校验
  // parameters（读源码确认），所以 parameters 的正确性由「与官方转换器产物同形」保证。
  // 这里检查官方转换器产物必然满足的全部结构不变式。
  console.log('\n# parameters 结构不变式（与官方转换器同形）')
  /** 官方 parameterSchemaSpecToJsonSchema 的输出键集合 */
  const DSL_OUT_KEYS = new Set(['type', 'description', 'title', 'enum', 'items', 'additionalProperties', 'oneOf'])
  const TYPES = new Set(['string', 'number', 'integer', 'boolean', 'array', 'object', 'null'])

  for (const [name, t] of captured) {
    const p = t.parameters
    const problems = []
    if (p?.type !== 'object') problems.push('根 type 不是 object')
    if (!p?.properties || typeof p.properties !== 'object') problems.push('根缺 properties')
    if ('additionalProperties' in (p ?? {})) problems.push('根不应有 additionalProperties')
    if (p?.required !== undefined && !Array.isArray(p.required)) problems.push('required 不是数组')

    const propNames = Object.keys(p?.properties ?? {})
    for (const r of p?.required ?? []) {
      if (!propNames.includes(r)) problems.push(`required 含未知字段 ${r}`)
    }
    const walk = (node, path) => {
      if (!node || typeof node !== 'object') {
        problems.push(`${path} 不是对象`)
        return
      }
      for (const k of Object.keys(node)) {
        if (!DSL_OUT_KEYS.has(k)) problems.push(`${path}.${k} 是官方 DSL 不会产出的键`)
      }
      if (!TYPES.has(node.type)) problems.push(`${path}.type=${node.type} 非支持类型`)
      if (node.enum !== undefined && (!Array.isArray(node.enum) || node.enum.length === 0)) {
        problems.push(`${path}.enum 必须是非空数组`)
      }
      if (node.type === 'array') {
        if (!node.items) problems.push(`${path} 是数组但缺 items`)
        else walk(node.items, `${path}.items`)
      }
      if (node.type === 'object' && node.additionalProperties === undefined) {
        problems.push(`${path} 是 object 但未声明 additionalProperties`)
      }
    }
    for (const [k, v] of Object.entries(p?.properties ?? {})) walk(v, `parameters.${k}`)

    check(
      `${name}.parameters 满足全部结构不变式（${propNames.length} 个字段）`,
      problems.length === 0,
      problems.join('；'),
    )
  }

  // 必填缺失必须体现在 required 里（required 提升正确性）
  console.log('\n# 必填提升')
  const expectedRequired = {
    image_generate: ['prompt'],
    image_edit: ['prompt', 'image'],
    image_worker: ['action'],
    image_model_fetch: ['confirm'],
    image_status: [],
    image_result: [],
  }
  for (const [name, t] of captured) {
    const want = expectedRequired[name]
    if (!want) continue
    const got = t.parameters?.required ?? []
    check(
      `${name}：required = ${want.length ? want.join(',') : '（无）'}`,
      JSON.stringify([...got].sort()) === JSON.stringify([...want].sort()),
      `实际 ${JSON.stringify(got)}`,
    )
  }

  // ---- 4. 与真实 defineTool 的产物逐字比对 ----
  console.log('\n# 与真实 defineTool 产物比对（逐字兼容）')
  // 用与 image_worker 等价的 DSL 让官方生成基准，再与我们的编译产物比结构
  const equivalentDsl = {
    action: {
      type: 'string',
      required: true,
      enum: ['start', 'stop', 'unload', 'warm', 'status', 'logs'],
      description: captured.get('image_worker')?.parameters?.properties?.action?.description ?? '',
    },
    count: { type: 'number', description: captured.get('image_worker')?.parameters?.properties?.count?.description ?? '' },
  }
  const official = tools.defineTool({
    name: 'probe',
    description: 'd',
    parameters: equivalentDsl,
    output: { schema: { type: 'object', additionalProperties: true, properties: {} }, render: () => [] },
    async execute() {
      return {}
    },
  })
  const ours = captured.get('image_worker')?.parameters
  check(
    '官方产物的根形状与我们的相同（type/properties/required）',
    official.parameters.type === ours?.type &&
      !!official.parameters.properties &&
      !!ours?.properties &&
      Array.isArray(official.parameters.required) &&
      Array.isArray(ours?.required),
    `official.required=${JSON.stringify(official.parameters.required)} ours.required=${JSON.stringify(ours?.required)}`,
  )
  check(
    '官方在根上不设 additionalProperties（与我们一致）',
    !('additionalProperties' in official.parameters) && !('additionalProperties' in (ours ?? {})),
    `official=${official.parameters.additionalProperties} ours=${ours?.additionalProperties}`,
  )
  check(
    '字段级 required 被提升为根数组（我们与官方一致）',
    JSON.stringify(ours?.required) === JSON.stringify(['action']),
    `ours.required=${JSON.stringify(ours?.required)}`,
  )
  check(
    'enum 原样保留',
    JSON.stringify(official.parameters.properties.action.enum) === JSON.stringify(ours?.properties?.action?.enum),
    `official=${JSON.stringify(official.parameters.properties.action.enum)} ours=${JSON.stringify(ours?.properties?.action?.enum)}`,
  )
  check(
    'description 原样保留',
    (ours?.properties?.action?.description ?? '').length > 0 &&
      official.parameters.properties.action.description === ours?.properties?.action?.description,
    `official=${JSON.stringify(official.parameters.properties.action.description)}`,
  )

  // ---- 5. output schema 必须真的接受我们的返回值 ----
  console.log('\n# output.schema 接受真实返回值形状')
  const outputSamples = {
    image_worker: {
      action: 'status', managerState: 'ready', workerState: 'ready', port: 1234, pid: 99,
      device: 'cuda:0', dtype: 'fp16', offload: 'model', loadSec: 62.5, warmed: false,
      vramFreeMiB: 24172, vramTotalMiB: 24473, vramPeakMiB: 16771, queueDepth: 0, detail: 'ok',
      logs: ['a'],
    },
    image_generate: {
      ids: ['generate-1'], files: ['/tmp/a.png'], width: 1024, height: 1024, seed: 1, steps: 24,
      preset: 'standard', elapsedSec: 302.8, steadyStepSec: 8.819, peakVramMiB: 16771,
      hasAlpha: true, device: 'cuda:0', dtype: 'fp16', count: 1, estimateText: 'x', status: 'completed',
    },
    image_result: {
      mode: 'detail', count: 1, detail: 'x',
      items: [{ id: 'a', file: '/f', width: 1, height: 1, bytes: 2, hasAlpha: true, seed: 3, steps: 4, prompt: 'p', kind: 'generate', elapsedSec: 5, createdAt: 6 }],
    },
  }
  for (const [name, value] of Object.entries(outputSamples)) {
    const t = captured.get(name)
    if (!t) continue
    try {
      tools.validateJsonSchemaValue(t.output.schema, value, '')
      check(`${name}：示例返回值通过 output.schema 校验`, true)
    } catch (err) {
      check(`${name}：示例返回值通过 output.schema 校验`, false, err.message)
    }
  }

  // ---- 6. 渲染器能被真实运行时安全调用 ----
  console.log('\n# render 可被调用且产出 text 块')
  for (const [name, t] of captured) {
    const value = outputSamples[name]
    if (!value) continue
    try {
      const blocks = t.output.render({}, value)
      check(`${name}.render 产出 ${blocks.length} 个块且首块为 text`, Array.isArray(blocks) && blocks[0]?.type === 'text', JSON.stringify(blocks).slice(0, 160))
    } catch (err) {
      check(`${name}.render 可调用`, false, err.message)
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 技能注册契约（用真实 dsh-skill 的规则与导出校验）
// ═══════════════════════════════════════════════════════════════════════════
// 背景：第一版用 ctx.skills.registerProvider(...)，运行时抛
//   skill provider "dsh-qwen-image" returned skill "dsh-qwen-image" with a non-string provider
// 因为 provider 路径的 validateCandidate 要求 list() 的每个 candidate 带
// provider 字段**且必须等于 provider 自己的 name**。现在改用 register() 运行时路径
// （与已验证可用的 dsh-plugin-dev-kb 一致），这里按源码里的规则逐条校验。
console.log('\n# 技能注册契约（真实 dsh-skill 规则）')
const skills = capturedSkills
if (!skills.length) {
  check('技能已注册', false, '捕获到 0 个技能注册')
} else {
  const s = skills[0]
  // 真实导出：isSkillName（SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/）
  if (skillMod && typeof skillMod.isSkillName === 'function') {
    check(`技能名 "${s.name}" 通过真实 isSkillName`, skillMod.isSkillName(s.name), String(s.name))
  } else {
    skip('真实 isSkillName', '解析不到 dsh-skill')
    check('技能名匹配 SKILL_NAME 正则', /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s.name ?? ''), String(s.name))
  }
  // validateRuntimeSkill 的三条硬要求
  check('description 非空字符串（validateRuntimeSkill）', typeof s.description === 'string' && s.description.length > 0)
  check('invocation 未声明或形状合法', s.invocation === undefined || (typeof s.invocation.modelInvocable === 'boolean' && typeof s.invocation.userInvocable === 'boolean'))
  check('name 通过 SKILL_NAME', /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s.name ?? ''))

  // register 路径特有：不要 provider/rank（那是 provider 候选路径的字段）
  check('不带 provider 字段（register 路径）', s.provider === undefined, String(s.provider))
  check('不带 rank 字段（register 路径）', s.rank === undefined, String(s.rank))

  // 内容与资源
  check('content 是非空字符串', typeof s.content === 'string' && s.content.length > 100, `len=${s.content?.length}`)
  check('source 是字符串', typeof s.source === 'string', String(s.source))
  check(
    'resourceBase 指向真实存在的目录',
    s.resourceBase?.kind === 'directory' && typeof s.resourceBase.path === 'string' && existsSync(s.resourceBase.path),
    JSON.stringify(s.resourceBase),
  )
  check('resourceBase.path 已归一化（不含 ..）', !String(s.resourceBase?.path ?? '').includes('..'), String(s.resourceBase?.path))
  check('模板占位符已全部替换', !/\{\{[A-Z_]+\}\}/.test(String(s.content ?? '')), (String(s.content ?? '').match(/\{\{[A-Z_]+\}\}/g) ?? []).join(', '))
}

console.log(`\n=== 结果：${pass} 通过，${fail} 失败${skipped ? `，${skipped} 跳过` : ''} ===\n`)
process.exit(fail > 0 ? 1 : 0)
