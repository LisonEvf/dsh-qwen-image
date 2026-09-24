/**
 * 终端输出层：统一的中文提示、缩进、颜色、日志落盘、交互问答。
 *
 * 之所以自己写而不引 chalk/ora：安装器零依赖（见 util.mjs 的说明）。
 * 颜色只在 TTY 下开启，重定向到文件时自动降级为纯文本，
 * 这样「把 install.log 发给我」永远是可读、可检索的。
 */

import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import readline from 'node:readline'
import { humanBytes } from './util.mjs'

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[36m',
}

/**
 * 创建 UI。
 * @param {{logPath?: string, yes?: boolean, quiet?: boolean, json?: boolean, plain?: boolean}} opts
 */
export function createUI(opts = {}) {
  const useColor = !opts.plain && !opts.json && !!process.stdout.isTTY && !process.env.NO_COLOR
  const paint = (color, text) => (useColor ? `${color}${text}${C.reset}` : text)
  let logPath = opts.logPath ?? null
  if (logPath) {
    try {
      mkdirSync(dirname(logPath), { recursive: true })
      appendFileSync(logPath, `\n===== dsh-qwen-image 安装器 ${new Date().toISOString()} =====\n`, 'utf8')
    } catch {
      logPath = null
    }
  }

  const log = (text) => {
    if (!logPath) return
    try {
      appendFileSync(logPath, text, 'utf8')
    } catch {
      /* 日志写不进去也不该打断安装 */
    }
  }
  const emit = (text) => {
    if (opts.json) return
    process.stdout.write(text)
    log(text)
  }

  const api = {
    get logPath() {
      return logPath
    },
    setLogPath(p) {
      logPath = p
      log(`===== 切换日志到 ${p} =====\n`)
    },
    /** 原样输出（子进程输出用，保留缩进与换行）。 */
    raw(text) {
      emit(text)
    },
    line(text = '') {
      emit(`${text}\n`)
    },
    title(text) {
      emit(`\n${paint(C.bold + C.blue, text)}\n`)
    },
    /** 步骤标题：`[2/7] 创建 Python 环境` */
    step(index, total, text) {
      emit(`\n${paint(C.bold, `[${index}/${total}] ${text}`)}${logPath ? '' : ''}\n`)
    },
    info(text) {
      emit(`  ${text}\n`)
    },
    detail(text) {
      emit(`    ${paint(C.dim, text)}\n`)
    },
    ok(text) {
      emit(`  ${paint(C.green, '✓')} ${text}\n`)
    },
    warn(text) {
      emit(`  ${paint(C.yellow, '!')} ${text}\n`)
    },
    err(text) {
      emit(`  ${paint(C.red, '×')} ${text}\n`)
    },
    /** 用户需要照抄的命令块。 */
    cmd(text) {
      if (opts.json) return
      emit(`    ${paint(C.dim, '$')} ${text}\n`)
    },
    hint(text) {
      emit(`    ${paint(C.blue, '→')} ${text}\n`)
    },
    kv(key, value, note) {
      emit(`    ${String(key).padEnd(16)} ${value}${note ? paint(C.dim, `  ${note}`) : ''}\n`)
    },
    rule() {
      emit(`\n${paint(C.dim, '─'.repeat(66))}\n`)
    },
    bytes(n) {
      return humanBytes(n)
    },
    /**
     * 交互确认。`--yes` 或非交互终端下直接返回默认值，
     * 保证「双击运行」和「CI 里跑」都不会卡住。
     */
    async confirm(question, defaultValue = true) {
      if (opts.yes) {
        emit(`  ? ${question} → ${defaultValue ? '是' : '否'}（--yes 自动选择）\n`)
        return defaultValue
      }
      if (!process.stdin.isTTY) {
        emit(`  ? ${question} → ${defaultValue ? '是' : '否'}（非交互终端，取默认）\n`)
        return defaultValue
      }
      const answer = await api.ask(`${question} [${defaultValue ? 'Y/n' : 'y/N'}] `)
      if (!answer.trim()) return defaultValue
      return /^y(es)?$/i.test(answer.trim())
    },
    /** 自由输入。 */
    async ask(question, defaultValue = '') {
      if (opts.yes || !process.stdin.isTTY) return defaultValue
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
      const answer = await new Promise((res) => rl.question(`  ${question}`, (a) => res(a)))
      rl.close()
      return answer.trim() || defaultValue
    },
    /** 汇总表：`[{label, value, note?}]` */
    table(rows) {
      const width = rows.reduce((w, r) => Math.max(w, String(r.label).length), 0)
      for (const r of rows) {
        const note = r.note ? paint(C.dim, `  ${r.note}`) : ''
        emit(`  ${String(r.label).padEnd(width)}  ${r.value}${note}\n`)
      }
    },
    /** JSON 模式的最终输出（给脚本/支持人员用）。 */
    jsonOut(value) {
      process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
      log(`\n[JSON]\n${JSON.stringify(value, null, 2)}\n`)
    },
  }
  return api
}

/** 判断日志目录是否可写（安装器会尽早创建）。 */
export function ensureLogDir(dir) {
  try {
    mkdirSync(dir, { recursive: true })
    return existsSync(dir)
  } catch {
    return false
  }
}
