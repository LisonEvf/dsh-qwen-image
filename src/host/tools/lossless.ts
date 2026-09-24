/**
 * 工具返回值 → **无损 JSON** 归一化。
 *
 * ⚠️ 本机实测踩坑（务必保留）：DSH 的 `dsh-tools` 在把工具结果交给模型前会做一次
 * fail-closed 的「无损 JSON」校验（`@deepseek-ai/dsh-util-values` 的 walkJsonValue），
 * 其判定比 `JSON.stringify` **严格得多**：
 *
 * - 对象属性值为 `undefined` → **非法**（JSON.stringify 会默默丢掉，校验器直接判不合格）
 *   ⇒ 表现是模型侧收到 `tool "image_status" returned invalid output: value is not lossless JSON`，
 *     而不是任何业务错误。插件里大量 `foo: x ?? undefined` 的写法全会踩中。
 * - `NaN` / `±Infinity` → 非法（nvidia-smi 权限不足时会返回 `[N/A]`，`Number('[N/A]')` 即 NaN）
 * - `-0`、稀疏数组、带额外键的数组、非普通原型对象（class 实例）、Symbol 键 → 非法
 *
 * 所以每个工具在返回前都必须过一遍 `sanitizeToolOutput`。
 */
export function sanitizeToolOutput<T>(value: T): T {
  return sanitize(value, new WeakSet()) as T
}

function sanitize(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null) return null
  const t = typeof value
  if (t === 'string' || t === 'boolean') return value
  if (t === 'number') {
    const n = value as number
    // 非有限数与 -0 都非法：转成 null 让模型看到「未知」而不是让整个工具失败
    return Number.isFinite(n) && !Object.is(n, -0) ? n : null
  }
  if (t === 'undefined') return null
  if (t === 'bigint') return (value as bigint).toString()
  if (t === 'function' || t === 'symbol') return null
  if (t !== 'object') return String(value)

  const obj = value as object
  if (seen.has(obj)) return null // 循环引用
  seen.add(obj)

  if (Array.isArray(obj)) {
    const out = obj.map((item) => sanitize(item, seen))
    seen.delete(obj)
    return out
  }

  // class 实例等非普通对象：降级为可枚举自有属性的普通对象
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(obj as Record<string, unknown>)) {
    const v = (obj as Record<string, unknown>)[key]
    if (v === undefined) continue // 直接剔除，而不是写成 null
    out[key] = sanitize(v, seen)
  }
  seen.delete(obj)
  return out
}
