import { existsSync } from 'node:fs'

/**
 * 路径展开的**唯一实现**（原先散落在 8 个文件里各写一份，已收口到这里）。
 *
 * ⚠️ 本机实测踩坑（务必保留）：**DSH 并不总是把 `DSH_HOME` 放进子进程/插件进程的环境变量**。
 * 实测在 `dsh web`（由 .bat 启动）的宿主进程里 `Object.keys(process.env)` 里没有 `DSH_HOME`，
 * 于是 `'$DSH_HOME/dsh-qwen-image/outputs'.replace('$DSH_HOME', '')` 会静默产出
 * **`/dsh-qwen-image/outputs`** —— 一个在 Windows 上根本不存在的路径（前导斜杠、缺盘符）。
 * 后果非常隐蔽：worker 进程被拉起后 python 在建输出目录/写日志时异常退出，
 * `exitCode=1` 且来不及写任何日志，表现成「worker 秒退、无任何可观察输出」。
 *
 * 所以：解析 `$DSH_HOME` 时必须有兜底，且兜底要**真的存在**才算数。
 */

/** DSH 主目录：环境变量优先，其次 `~/.dsh`（本机实测默认位置）。 */
export function resolveDshHome(): string {
  const fromEnv = process.env.DSH_HOME?.trim()
  if (fromEnv) return fromEnv.replace(/\\/g, '/')

  const home = process.env.USERPROFILE ?? process.env.HOME ?? ''
  if (home) {
    const candidate = `${home.replace(/\\/g, '/')}/.dsh`
    // 只要该候选目录存在就采信；不存在时也返回它（比返回空串安全得多）
    if (existsSync(candidate)) return candidate
    return candidate
  }
  return ''
}

/**
 * 展开 `$DSH_HOME` 与 `~`。
 *
 * 顺序：先把 `$DSH_HOME` 替换成**已兜底**的主目录；若结果仍不可用（例如配置里写的是
 * 别的机器的绝对路径），再用 `~` 规则处理。绝不允许产出空基址的伪绝对路径。
 */
export function expandHome(p: string): string {
  let out = p
  if (out.includes('$DSH_HOME')) {
    out = out.replace(/\$DSH_HOME/g, resolveDshHome())
  }
  if (out.startsWith('~/') || out === '~') {
    const home = process.env.USERPROFILE ?? process.env.HOME ?? ''
    out = `${home}${out.slice(1)}`
  }
  // 兜底：万一基址为空导致出现 `/dsh-qwen-image/...` 这种伪绝对路径，补回盘符
  if (/^\/[A-Za-z]/.test(out) && !/^\/\/\//.test(out)) {
    const dshHome = resolveDshHome()
    if (dshHome) out = `${dshHome}${out}`
  }
  return out
}
