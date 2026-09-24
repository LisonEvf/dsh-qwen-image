/**
 * 自包含的工具定义 DSL（替代 `@deepseek-ai/dsh-tools` 的 `defineTool`）。
 *
 * ── 为什么不直接 import 官方的 defineTool ──────────────────────────────
 * 本插件以 `link:` 方式装进 profile，Node 按 **realpath** 解析链接包，
 * 于是 `require('@deepseek-ai/dsh-tools')` 会从插件目录向上查找而**找不到**
 * （该包住在 dsh 安装目录内，不在插件的解析链上）。
 * 这是本仓库既有约定，`dsh-plugin-dev-kb` 的源码里写得很明确：
 *
 *   「依赖纪律：本模块不 import 任何 @deepseek-ai/* 运行时包
 *     （插件以 link: 方式装入 profile，Node ESM 按 realpath 解析链接包，
 *      外部依赖从插件目录解析不到）」
 *
 * 而且 `Tools.register()` 只要求一个**结构上**符合 ToolDefinition 的对象：
 *   - `name`
 *   - `output = { schema, render, presentationMeta? }`（schema 必须是受支持的 JSON Schema）
 *   - 若有 `timeoutMs`，须为正的有限数
 * 所以这里自己实现同等转换即可，不损失任何能力。
 *
 * ── 与官方 DSL 的**逐字兼容**（已实测官方产物核对）────────────────────
 * 参数 DSL 支持的键（实测量出的白名单）：
 *   支持：type / description / required / enum / default / examples / title /
 *         items / additionalProperties / oneOf（至少两个分支）
 *   **不支持**：minimum / maximum / minLength / maxLength / pattern / format
 * 支持的 type：string / number / integer / boolean / array / object / null
 *
 * 产物形状与官方一致：根为 `{ type:'object', properties, required[] }`，
 * 根**不带** additionalProperties（隐式根对象保持开放），字段级 `required`
 * 被提升为根的 `required` 数组。
 *
 * 输出 schema 另有一条硬规则（实测）：**每个 object 节点都必须显式声明
 * `additionalProperties: true | false`**，嵌套对象与数组 items 内的对象也不例外。
 * 本模块在注册前校验并**响亮失败**，避免运行时才发现。
 */

export type JsonSchemaType = 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object' | 'null'

/** 参数 DSL 里**被官方支持**的键。不在表内的一律报错（与官方行为一致）。 */
const PARAM_KEYS = new Set([
  'type',
  'description',
  'required',
  'enum',
  'default',
  'examples',
  'title',
  'items',
  'additionalProperties',
  'oneOf',
])

/** 输出 schema 里被支持的键（不含参数 DSL 专属的 required/default/examples）。 */
const OUTPUT_KEYS = new Set(['type', 'description', 'title', 'enum', 'items', 'properties', 'required', 'additionalProperties', 'oneOf'])

export interface ParameterSpec {
  type: JsonSchemaType
  description?: string
  required?: boolean
  enum?: readonly (string | number | boolean | null)[]
  default?: unknown
  examples?: unknown
  title?: string
  items?: ParameterSpec
  additionalProperties?: boolean
  oneOf?: readonly ParameterSpec[]
}

export type ParametersSpec = Record<string, ParameterSpec>

export interface JsonSchemaNode {
  type?: JsonSchemaType | JsonSchemaType[]
  description?: string
  title?: string
  enum?: readonly unknown[]
  items?: JsonSchemaNode
  properties?: Record<string, JsonSchemaNode>
  required?: string[]
  additionalProperties?: boolean
  oneOf?: JsonSchemaNode[]
}

export class ToolSchemaError extends Error {
  constructor(message: string) {
    super(`unsupported JSON schema: ${message}`)
    this.name = 'ToolSchemaError'
  }
}

// ---------------------------------------------------------------------------
// 参数 DSL → JSON Schema
// ---------------------------------------------------------------------------
export function parametersToJsonSchema(spec: ParametersSpec): JsonSchemaNode {
  const properties: Record<string, JsonSchemaNode> = {}
  const required: string[] = []

  for (const [name, field] of Object.entries(spec)) {
    const node = compileParameter(name, field)
    properties[name] = node
    if (field.required) required.push(name)
  }

  const root: JsonSchemaNode = { type: 'object', properties }
  if (required.length) root.required = required
  return root
}

function compileParameter(path: string, field: ParameterSpec): JsonSchemaNode {
  if (!field || typeof field !== 'object') {
    throw new ToolSchemaError(`${path} must be an object`)
  }

  for (const key of Object.keys(field)) {
    if (!PARAM_KEYS.has(key)) {
      throw new ToolSchemaError(`${path}.${key} is not supported by the value schema DSL`)
    }
  }

  if (field.oneOf !== undefined) {
    if (!Array.isArray(field.oneOf) || field.oneOf.length < 2) {
      throw new ToolSchemaError(`schema.properties.${path}.oneOf must be an array of at least two schemas`)
    }
    return {
      oneOf: field.oneOf.map((branch, i) => compileParameter(`${path}.oneOf[${i}]`, branch)),
    }
  }

  if (!field.type) {
    throw new ToolSchemaError(`${path}.type is required`)
  }

  const node: JsonSchemaNode = { type: field.type }

  if (field.description !== undefined) node.description = field.description
  if (field.title !== undefined) node.title = field.title
  if (field.enum !== undefined) node.enum = [...field.enum]

  if (field.type === 'array') {
    if (!field.items) throw new ToolSchemaError(`${path}.items is required for an array`)
    node.items = compileParameter(`${path}.items`, field.items)
  }

  if (field.type === 'object') {
    if (field.additionalProperties === undefined) {
      throw new ToolSchemaError(`${path}.additionalProperties must be explicitly true or false`)
    }
    node.additionalProperties = field.additionalProperties
    // 嵌套对象也允许声明 properties（本插件暂未用到，但保持能力）
    const nested = (field as unknown as { properties?: ParametersSpec }).properties
    if (nested) {
      const compiled = parametersToJsonSchema(nested)
      node.properties = compiled.properties
      if (compiled.required) node.required = compiled.required
    }
  }

  return node
}

// ---------------------------------------------------------------------------
// 输出 schema 校验（与官方 assertSupportedJsonSchema 同口径）
// ---------------------------------------------------------------------------
export function assertSupportedOutputSchema(schema: unknown, path = 'schema'): void {
  if (!schema || typeof schema !== 'object') {
    throw new ToolSchemaError(`${path} must be an object`)
  }
  const node = schema as JsonSchemaNode & Record<string, unknown>

  for (const key of Object.keys(node)) {
    if (!OUTPUT_KEYS.has(key)) {
      throw new ToolSchemaError(`${path}.${key} is not supported by the value schema DSL`)
    }
  }

  if (node.oneOf !== undefined) {
    if (!Array.isArray(node.oneOf) || node.oneOf.length < 2) {
      throw new ToolSchemaError(`${path}.oneOf must be an array of at least two schemas`)
    }
    node.oneOf.forEach((b, i) => assertSupportedOutputSchema(b, `${path}.oneOf[${i}]`))
    return
  }

  const type = node.type

  if (type === 'object') {
    if (node.additionalProperties === undefined) {
      throw new ToolSchemaError(`${path}.additionalProperties must be explicitly true or false`)
    }
    if (node.properties) {
      for (const [k, sub] of Object.entries(node.properties)) {
        assertSupportedOutputSchema(sub, `${path}.properties.${k}`)
      }
    }
  }

  if (type === 'array') {
    if (node.items) assertSupportedOutputSchema(node.items, `${path}.items`)
  }
}

// ---------------------------------------------------------------------------
// 工具定义
// ---------------------------------------------------------------------------
export interface ToolOutputDefinition {
  schema: JsonSchemaNode
  render(args: unknown, value: never): unknown[]
  presentationMeta?(args: unknown, value: never): unknown
}

export interface ToolDefinition {
  name: string
  description: string
  parameters: JsonSchemaNode
  output: ToolOutputDefinition
  execute(args: never, exec: unknown): Promise<unknown>
  timeoutMs?: number
  isConcurrencySafe?(args: unknown): boolean
  presentCall?(args: unknown): unknown
  presentResult?(args: unknown, result: unknown): unknown
}

export interface DefineToolOptions {
  name: string
  description: string
  parameters: ParametersSpec
  output: {
    schema: JsonSchemaNode
    render(args: never, value: never): unknown[]
    presentationMeta?(args: never, value: never): unknown
  }
  execute(args: never, exec: never): Promise<unknown>
  timeoutMs?: number
  isConcurrencySafe?(args: unknown): boolean
  presentCall?(args: unknown): unknown
  presentResult?(args: unknown, result: unknown): unknown
}

/**
 * 构造一个符合 DSH ToolDefinition 契约的**普通对象**。
 *
 * 与官方 defineTool 的差别（有意为之）：
 * - 不做「展示路径软校验」（presentCall/presentResult 参数畸形时返回 undefined 的兜底）。
 *   本插件的展示器足够简单（只读 argsRaw 解析出的字段），无需该层。
 * - 参数的运行时校验由注册表按 JSON Schema 处理；本插件另在 execute 内做跨字段校验
 *   （如 preset 与 width/height 互斥、count 范围）。
 */
export function defineTool(options: DefineToolOptions): ToolDefinition {
  if (!options.name || typeof options.name !== 'string') {
    throw new Error('defineTool: name is required')
  }
  if (options.timeoutMs !== undefined) {
    if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
      throw new Error(`defineTool(${options.name}): timeoutMs must be a positive finite number`)
    }
  }

  // 参数：DSL → JSON Schema（不支持的键在此响亮失败）
  const parameters = parametersToJsonSchema(options.parameters)

  // 输出：校验受支持的子集（object 必须显式 additionalProperties）
  assertSupportedOutputSchema(options.output.schema)

  const tool: ToolDefinition = {
    name: options.name,
    description: options.description,
    parameters,
    output: {
      schema: options.output.schema,
      render: options.output.render as ToolOutputDefinition['render'],
      ...(options.output.presentationMeta
        ? { presentationMeta: options.output.presentationMeta as ToolOutputDefinition['presentationMeta'] }
        : {}),
    },
    execute: options.execute as ToolDefinition['execute'],
  }

  if (options.timeoutMs !== undefined) tool.timeoutMs = options.timeoutMs
  if (options.isConcurrencySafe) tool.isConcurrencySafe = options.isConcurrencySafe
  if (options.presentCall) tool.presentCall = options.presentCall
  if (options.presentResult) tool.presentResult = options.presentResult

  return tool
}
