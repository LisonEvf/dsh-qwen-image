/**
 * 自包含的 Config schema（替代 `@deepseek-ai/schemastery`）。
 *
 * ── 为什么不用官方 schemastery ──────────────────────────────────────────
 * 同 tool-dsl.ts 的理由：插件以 `link:` 装入 profile，Node 按 realpath 解析，
 * `@deepseek-ai/*` 从插件目录**解析不到**。这是本仓库既有约定。
 *
 * ── 契约（实测官方 schemastery 3.18.2 的产物）──────────────────────────
 * Cordis 需要的是一个 **Standard Schema**（v1）：
 *
 *   {
 *     '~standard': {
 *       version: 1,
 *       vendor: '<name>',
 *       validate(value) {
 *         // 成功：{ value: <校验+填充默认值后的对象> }
 *         // 失败：{ issues: [{ message, path }] }
 *       }
 *     }
 *   }
 *
 * 实测官方行为：
 *   validate({})                  → { value: { a:'x', b:3 } }   ← 填充默认值
 *   validate({ a:'hi', b:9 })     → { value: { a:'hi', b:9 } }
 *   validate({ a:123 })           → { issues:[{ message:'$.a expected string but got 123', path:['a'] }] }
 *
 * 注意：**不能**导出普通对象当 Config —— 它不满足 Standard Schema 接口，
 * 故这里实现一个最小但完备的版本。
 */

export interface StandardIssue {
  message: string
  path: (string | number)[]
}

export type StandardResult<T> = { value: T } | { issues: StandardIssue[] }

export interface StandardSchemaV1<T> {
  '~standard': {
    version: 1
    vendor: string
    validate(value: unknown): StandardResult<T>
  }
}

type FieldKind = 'string' | 'number' | 'boolean' | 'enum'

interface FieldSpec {
  kind: FieldKind
  /** 缺省值（仅当其 !== undefined 时才会被填充） */
  def?: unknown
  required?: boolean
  /** number 专用 */
  int?: boolean
  min?: number
  max?: number
  /** enum 专用 */
  values?: readonly string[]
  desc?: string
}

// ---------------------------------------------------------------------------
// 字段构造器（链式，形态贴近 schemastery，便于阅读）
// ---------------------------------------------------------------------------
class FieldBuilder {
  constructor(private readonly spec: FieldSpec) {}

  default(v: unknown): FieldBuilder {
    this.spec.def = v
    return this
  }
  required(): FieldBuilder {
    this.spec.required = true
    return this
  }
  int(): FieldBuilder {
    this.spec.int = true
    return this
  }
  minimum(v: number): FieldBuilder {
    this.spec.min = v
    return this
  }
  maximum(v: number): FieldBuilder {
    this.spec.max = v
    return this
  }
  description(_v: string): FieldBuilder {
    this.spec.desc = _v
    return this
  }
  /** 供内部取用 */
  get __spec(): FieldSpec {
    return this.spec
  }
}

function field(kind: FieldKind, extra: Partial<FieldSpec> = {}): FieldBuilder {
  return new FieldBuilder({ kind, ...extra })
}

export const S = {
  string: () => field('string'),
  number: () => field('number'),
  boolean: () => field('boolean'),
  union: (values: readonly string[]) => field('enum', { values }),
}

// ---------------------------------------------------------------------------
// object schema
// ---------------------------------------------------------------------------
export interface ObjectSchema<T> extends StandardSchemaV1<T> {
  /** 供测试/文档取用的字段表 */
  readonly __fields: Record<string, FieldSpec>
}

export function object<T extends Record<string, unknown>>(fields: Record<string, FieldBuilder>): ObjectSchema<T> {
  const specs: Record<string, FieldSpec> = {}
  for (const [k, v] of Object.entries(fields)) specs[k] = v.__spec

  return {
    __fields: specs,
    '~standard': {
      version: 1,
      vendor: 'dsh-qwen-image',
      validate(input: unknown): StandardResult<T> {
        const issues: StandardIssue[] = []
        const out: Record<string, unknown> = {}

        const source =
          input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {}

        for (const [key, spec] of Object.entries(specs)) {
          const raw = source[key]

          if (raw === undefined || raw === null) {
            if (spec.def !== undefined) {
              out[key] = spec.def
              continue
            }
            if (spec.required) {
              issues.push({ message: `$.${key} is required`, path: [key] })
              continue
            }
            // 可选且无默认值：留空（由插件侧的 `?? fallback` 处理）
            continue
          }

          const problem = checkField(key, raw, spec)
          if (problem) {
            issues.push({ message: problem, path: [key] })
            continue
          }
          out[key] = raw
        }

        if (issues.length) return { issues }
        return { value: out as T }
      },
    },
  }
}

function checkField(key: string, value: unknown, spec: FieldSpec): string | undefined {
  switch (spec.kind) {
    case 'string':
      if (typeof value !== 'string') return `$.${key} expected string but got ${describe(value)}`
      return undefined

    case 'boolean':
      if (typeof value !== 'boolean') return `$.${key} expected boolean but got ${describe(value)}`
      return undefined

    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return `$.${key} expected number but got ${describe(value)}`
      }
      if (spec.int && !Number.isInteger(value)) {
        return `$.${key} expected integer but got ${value}`
      }
      if (spec.min !== undefined && value < spec.min) {
        return `$.${key} expected >= ${spec.min} but got ${value}`
      }
      if (spec.max !== undefined && value > spec.max) {
        return `$.${key} expected <= ${spec.max} but got ${value}`
      }
      return undefined
    }

    case 'enum': {
      if (typeof value !== 'string') return `$.${key} expected string but got ${describe(value)}`
      if (spec.values && !spec.values.includes(value)) {
        return `$.${key} expected one of ${spec.values.join(' | ')} but got ${JSON.stringify(value)}`
      }
      return undefined
    }

    default:
      return `$.${key} has an unknown field kind`
  }
}

function describe(v: unknown): string {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array'
  return typeof v
}
