/**
 * 安装器基础工具层：进程、文件、网络、下载、解压。
 *
 * 硬约束：**只用 Node 内建模块**（零 npm 依赖）——
 * 安装器必须在「刚装完 Node、什么都没装」的机器上直接跑起来。
 * 因此不引入 yaml / axios / tar 之类的包，全部自己实现最小可用版本。
 */

import { spawn, spawnSync } from 'node:child_process'
import { createWriteStream, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import http from 'node:http'
import https from 'node:https'

/** 是否为 Windows。 */
export const IS_WIN = process.platform === 'win32'
/** 是否为 macOS。 */
export const IS_MAC = process.platform === 'darwin'
/** 是否为 Linux。 */
export const IS_LINUX = process.platform === 'linux'

/** 可执行文件后缀。 */
export const EXE = IS_WIN ? '.exe' : ''

/** 人类可读的字节数。 */
export function humanBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '?'
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let i = 0
  let v = n
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(i === 0 ? 0 : v < 10 ? 2 : 1)} ${units[i]}`
}

/** 时间戳（用于日志文件名与报告）。 */
export function stamp(d = new Date()) {
  const p = (x) => String(x).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

export function exists(p) {
  try {
    return existsSync(p)
  } catch {
    return false
  }
}

export function isDir(p) {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

export function isFile(p) {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

/**
 * 「看起来像可执行文件」的判定。
 *
 * 为什么不能只用 statSync().isFile()：Windows 的**应用执行别名**
 * （Microsoft\WindowsApps\python.exe 这类微软商店应用入口）是 0 字节的
 * reparse point，statSync 跟随它会失败，于是被误判成「不存在」——
 * 本机实测就踩到了：明明 PATH 上有 python，探测却一个都没找到。
 */
export function isExecutablePath(p) {
  if (!p) return false
  // 必须用 lstat：别名/软链的**目标**可能读不到（EACCES），
  // existsSync/statSync 在这种情况下会返回 false，把可用的解释器当成不存在。
  let st
  try {
    st = lstatSync(p)
  } catch {
    return false
  }
  return !st.isDirectory()
}

export function ensureDir(p) {
  if (!exists(p)) mkdirSync(p, { recursive: true })
  return p
}

export function readJsonSafe(p, fallback = null) {
  try {
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return fallback
  }
}

export function writeFileSafe(p, text) {
  ensureDir(dirname(p))
  const tmp = `${p}.tmp-${process.pid}`
  writeFileSync(tmp, text, 'utf8')
  try {
    rmSync(p, { force: true })
  } catch {
    /* ignore */
  }
  renameSync(tmp, p)
}

/** 目录体积（递归累加，忽略链接与权限错误）。 */
export function dirSize(p, budget = 200000) {
  let total = 0
  let seen = 0
  const stack = [p]
  while (stack.length && seen < budget) {
    const cur = stack.pop()
    let entries
    try {
      entries = readdirSync(cur, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      seen++
      if (seen > budget) break
      const full = join(cur, e.name)
      try {
        if (e.isDirectory()) stack.push(full)
        else if (e.isFile()) total += statSync(full).size
      } catch {
        /* ignore */
      }
    }
  }
  return total
}

/** 在 PATH 中查找可执行文件，返回绝对路径或 null。 */
export function which(cmd, env = process.env) {
  const pathext = IS_WIN ? (env.PATHEXT || '.EXE;.CMD;.BAT;.PS1').split(';').filter(Boolean) : ['']
  const dirs = (env.PATH || env.Path || '').split(IS_WIN ? ';' : ':').filter(Boolean)
  // Windows 上同一个命令可能有多个入口：dsh / dsh.cmd / dsh.ps1。
  // 裸名的那个是 sh 脚本（CreateProcess 跑不起来），必须让扩展名版本排前面。
  const names = []
  if (IS_WIN && !/\.[a-z0-9]+$/i.test(cmd)) {
    for (const ext of pathext) names.push(cmd + ext.toLowerCase(), cmd + ext.toUpperCase())
  }
  names.push(cmd)
  for (const d of dirs) {
    for (const n of names) {
      const full = join(d, n)
      if (isExecutablePath(full)) return full
    }
  }
  return null
}

/**
 * 同步执行并捕获输出（用于快速探测；长任务用 runStream）。
 * 永不抛异常：失败以 exit code / error 字段返回。
 */
/**
 * 把命令翻译成 Node 真正能 spawn 的形式。
 *
 * Windows 的坑：npm 装的 CLI（dsh / pnpm / hf …）落地的是 .cmd 批处理，
 * 而 child_process 在 shell:false 下**不能直接执行 .cmd/.bat**（CreateProcess 不认）。
 * 于是这里统一改走 cmd.exe /d /s /c，并按 cmd 的规则把整行再包一层引号
 * （/s 会剥掉首尾引号，所以必须先包一层，否则带空格的路径会被拆坏）。
 * @returns {{cmd: string, args: string[], verbatim: boolean}}
 */
export function toSpawnSpec(cmd, args) {
  const list = (args || []).map((a) => String(a))
  if (!IS_WIN) return { cmd: cmd, args: list, verbatim: false }
  const lower = String(cmd).toLowerCase()
  if (lower.endsWith('.ps1')) {
    const shell = which('pwsh') || 'powershell'
    return { cmd: shell, args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', cmd].concat(list), verbatim: false }
  }
  if (lower.endsWith('.cmd') || lower.endsWith('.bat')) {
    const comspec = process.env.ComSpec || 'cmd.exe'
    const q = (s) => (/[\s&|<>^"]/.test(s) ? '"' + s.replace(/"/g, '') + '"' : s)
    const line = '"' + q(cmd) + (list.length ? ' ' + list.map(q).join(' ') : '') + '"'
    return { cmd: comspec, args: ['/d', '/s', '/c', line], verbatim: true }
  }
  return { cmd: cmd, args: list, verbatim: false }
}

/**
 * 子进程环境：统一打开 UTF-8。
 *
 * 中文 Windows 上，Python 写管道时默认用 GBK，pipe 到 Node 再按 UTF-8 解码
 * 就会变成乱码（本机实测：model_check.py 的中文提示全花）。
 * PYTHONUTF8/PYTHONIOENCODING 对所有子进程都无害，索性统一加上。
 */
export function childEnv(env) {
  return Object.assign({}, env || process.env, { PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' })
}

export function run(cmd, args = [], opts = {}) {
  const started = Date.now()
  const spec = toSpawnSpec(cmd, args)
  const r = spawnSync(spec.cmd, spec.args, {
    cwd: opts.cwd,
    env: childEnv(opts.env),
    encoding: 'utf8',
    timeout: opts.timeoutMs ?? 60_000,
    windowsHide: true,
    windowsVerbatimArguments: spec.verbatim,
    maxBuffer: opts.maxBuffer ?? 32 * 1024 * 1024,
    input: opts.input,
    shell: false,
  })
  return {
    cmd,
    args,
    code: r.status === null ? -1 : r.status,
    signal: r.signal ?? null,
    stdout: (r.stdout ?? '').toString(),
    stderr: (r.stderr ?? '').toString(),
    error: r.error ? String(r.error.message || r.error) : null,
    ms: Date.now() - started,
    ok: r.status === 0,
  }
}

/** 把命令渲染成可复制粘贴的一行（Windows 用 PowerShell 口径）。 */
export function renderCmd(cmd, args = []) {
  const q = (s) => (/[\s"']/.test(s) ? `"${String(s).replace(/"/g, '\\"')}"` : s)
  return [cmd, ...args].map(q).join(' ')
}

/**
 * 流式执行：stdout/stderr 边跑边打印（同时写入日志），返回尾部输出。
 * 用于 pip / uv / hf 这类耗时长、用户需要看到进度的命令。
 */
export function runStream(cmd, args = [], opts = {}) {
  return new Promise((resolvePromise) => {
    const ui = opts.ui
    if (ui) ui.cmd(renderCmd(cmd, args))
    const spec = toSpawnSpec(cmd, args)
    const child = spawn(spec.cmd, spec.args, {
      cwd: opts.cwd,
      env: childEnv(opts.env),
      windowsHide: true,
      windowsVerbatimArguments: spec.verbatim,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    })
    let tail = ''
    let killedByTimeout = false
    const push = (chunk) => {
      const text = chunk.toString()
      tail = (tail + text).slice(-20000)
      if (ui) ui.raw(text)
      else process.stdout.write(text)
    }
    child.stdout.on('data', push)
    child.stderr.on('data', push)
    let timer = null
    if (opts.timeoutMs) {
      timer = setTimeout(() => {
        killedByTimeout = true
        try {
          child.kill('SIGKILL')
        } catch {
          /* ignore */
        }
      }, opts.timeoutMs)
    }
    child.on('error', (err) => {
      if (timer) clearTimeout(timer)
      resolvePromise({ code: -1, error: String(err.message || err), tail, killedByTimeout })
    })
    child.on('close', (code) => {
      if (timer) clearTimeout(timer)
      resolvePromise({ code: code === null ? -1 : code, error: null, tail, killedByTimeout })
    })
  })
}

/** 单次 HTTP(S) 探测：只关心「能不能连上」。 */
export function probeUrl(url, { timeoutMs = 6000, method = 'HEAD' } = {}) {
  return new Promise((resolvePromise) => {
    const started = Date.now()
    let settled = false
    const done = (ok, status, error) => {
      if (settled) return
      settled = true
      resolvePromise({ url, ok, status: status ?? null, ms: Date.now() - started, error: error ?? null })
    }
    let req
    try {
      const mod = url.startsWith('https:') ? https : http
      req = mod.request(url, { method, timeout: timeoutMs, headers: { 'user-agent': 'dsh-qwen-image-installer' } }, (res) => {
        const status = res.statusCode ?? 0
        res.resume()
        // 405/403 说明「连得上但不喜欢 HEAD」——依然算可达
        done(status < 500, status, null)
      })
    } catch (err) {
      done(false, null, String(err.message || err))
      return
    }
    req.on('timeout', () => {
      req.destroy()
      done(false, null, 'timeout')
    })
    req.on('error', (err) => done(false, null, String(err.message || err)))
    req.end()
  })
}

/**
 * 下载文件到磁盘（自动跟随跳转、流式进度、失败自动换镜像）。
 * @returns {Promise<{ok: boolean, path?: string, bytes?: number, error?: string}>}
 */
export function download(url, destPath, { timeoutMs = 120_000, onProgress, tries = 3, log } = {}) {
  return new Promise((resolvePromise) => {
    const attempt = (n) => {
      ensureDir(dirname(destPath))
      const part = `${destPath}.part`
      let received = 0
      let total = 0
      let settled = false
      const fail = (error) => {
        if (settled) return
        settled = true
        try {
          rmSync(part, { force: true })
        } catch {
          /* ignore */
        }
        if (n < tries) {
          if (log) log(`    下载失败（${error}），重试 ${n}/${tries} …`)
          setTimeout(() => attempt(n + 1), 1500)
        } else {
          resolvePromise({ ok: false, error })
        }
      }
      let req
      const handle = (res) => {
        const status = res.statusCode ?? 0
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume()
          settled = true
          const next = new URL(res.headers.location, url).toString()
          download(next, destPath, { timeoutMs, onProgress, tries: 1, log }).then(resolvePromise)
          return
        }
        if (status !== 200) {
          res.resume()
          fail(`HTTP ${status}`)
          return
        }
        total = Number(res.headers['content-length'] || 0)
        const out = createWriteStream(part)
        res.on('data', (c) => {
          received += c.length
          if (onProgress) onProgress(received, total)
        })
        res.pipe(out)
        out.on('finish', () => {
          out.close(() => {
            if (settled) return
            settled = true
            try {
              rmSync(destPath, { force: true })
            } catch {
              /* ignore */
            }
            renameSync(part, destPath)
            resolvePromise({ ok: true, path: destPath, bytes: received })
          })
        })
        out.on('error', (err) => fail(String(err.message || err)))
      }
      try {
        const mod = url.startsWith('https:') ? https : http
        req = mod.get(url, { timeout: timeoutMs, headers: { 'user-agent': 'dsh-qwen-image-installer' } }, handle)
      } catch (err) {
        fail(String(err.message || err))
        return
      }
      req.on('timeout', () => {
        req.destroy()
        fail('timeout')
      })
      req.on('error', (err) => fail(String(err.message || err)))
    }
    attempt(1)
  })
}

/** 解压 .zip / .tar.gz（用系统自带 tar/unzip，不引第三方库）。 */
export function extractArchive(archivePath, destDir) {
  ensureDir(destDir)
  const lower = archivePath.toLowerCase()
  if (lower.endsWith('.zip')) {
    if (IS_WIN) {
      const t = run('tar', ['-xf', archivePath, '-C', destDir], { timeoutMs: 180_000 })
      if (t.ok) return { ok: true, via: 'tar' }
      const ps = run('powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${archivePath}' -DestinationPath '${destDir}' -Force`], { timeoutMs: 300_000 })
      return ps.ok ? { ok: true, via: 'Expand-Archive' } : { ok: false, error: ps.stderr || t.stderr }
    }
    const u = run('unzip', ['-oq', archivePath, '-d', destDir], { timeoutMs: 180_000 })
    if (u.ok) return { ok: true, via: 'unzip' }
    const t = run('tar', ['-xf', archivePath, '-C', destDir], { timeoutMs: 180_000 })
    return t.ok ? { ok: true, via: 'tar' } : { ok: false, error: t.stderr || u.stderr }
  }
  const t = run('tar', ['-xzf', archivePath, '-C', destDir], { timeoutMs: 180_000 })
  return t.ok ? { ok: true, via: 'tar' } : { ok: false, error: t.stderr }
}

/** 递归查找第一个满足条件的文件（限制深度，避免在大目录里迷路）。 */
export function findFile(root, predicate, maxDepth = 4) {
  const stack = [{ dir: root, depth: 0 }]
  while (stack.length) {
    const { dir, depth } = stack.pop()
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      const full = join(dir, e.name)
      if (e.isFile() && predicate(full, e.name)) return full
      if (e.isDirectory() && depth < maxDepth) stack.push({ dir: full, depth: depth + 1 })
    }
  }
  return null
}

/** 临时目录下的一次性工作目录。 */
export function tempDir(tag = 'dsh-qwen-image') {
  const dir = join(tmpdir(), `${tag}-${process.pid}-${Date.now()}`)
  ensureDir(dir)
  return dir
}

export { resolve, join, dirname }
