#!/usr/bin/env node
/**
 * dsh-qwen-image 一键安装器（跨平台：Windows / Linux / macOS）。
 *
 * 用法（Windows 双击 install.bat 即是同一件事）：
 *   node installer/install.mjs              # 完整安装（会先体检、再问你要不要下 30.9GB 权重）
 *   node installer/install.mjs --check      # 只体检，什么都不改（排障第一步）
 *   node installer/install.mjs --dry-run    # 只打印将要做什么，一步都不执行
 *   node installer/install.mjs --yes        # 全部使用默认答案（无人值守）
 *
 * 设计原则（对应「普通用户一键装」）：
 * 1. **幂等**：任何一步已经满足就跳过，重跑只补缺的。
 * 2. **零依赖**：只用 Node 内建模块 —— dsh 需要 Node，所以有 dsh 就有 Node。
 * 3. **失败可读**：每个失败都给「原因 + 可复制的修复命令 + 日志路径」。
 * 4. **不动别人的东西**：借用已有环境时只写一个可删的 .pth 文件；
 *    注册插件走官方 dsh plugin 命令；改 profile 配置前先备份。
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createUI } from './lib/ui.mjs'
import { detectEnvironment, findReadyPython, findTorchPython, MODEL_SIZE_BYTES, DEPS_SIZE_BYTES } from './lib/detect.mjs'
import { buildPlan } from './lib/plan.mjs'
import { DIFFUSERS_COMMIT, ensureInterpreter, ensureVenv, installDeps, resolvePaths, verifyInstall, writeState } from './lib/pystep.mjs'
import { checkModel, ensureModel, manualCommands } from './lib/modelstep.mjs'
import { configureProfile, findPluginRoot, readPluginManifest, registerPlugin, verifyRegistration } from './lib/pluginstep.mjs'
import { humanBytes, isDir, isFile, run, stamp, which } from './lib/util.mjs'

const VERSION = '0.1.0'

/** 解析命令行。 */
export function parseArgs(argv) {
  const opts = {
    check: false,
    dryRun: false,
    yes: false,
    json: false,
    quiet: false,
    force: false,
    noModel: false,
    noPlugin: false,
    noNet: false,
    noUv: false,
    profile: null,
    home: null,
    modelDir: null,
    python: null,
    torch: null,
    reuse: null,
    pipIndex: null,
    uvUrl: null,
    pythonMirror: null,
    diffusersCommit: null,
    endpoint: undefined,
    help: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => argv[++i]
    if (a === '--check' || a === '--doctor') opts.check = true
    else if (a === '--dry-run' || a === '--dry') opts.dryRun = true
    else if (a === '-y' || a === '--yes') opts.yes = true
    else if (a === '--json') opts.json = true
    else if (a === '--quiet' || a === '-q') opts.quiet = true
    else if (a === '--force') opts.force = true
    else if (a === '--no-model' || a === '--skip-model') opts.noModel = true
    else if (a === '--no-plugin' || a === '--skip-plugin') opts.noPlugin = true
    else if (a === '--no-net') opts.noNet = true
    else if (a === '--no-uv') opts.noUv = true
    else if (a === '--reuse') opts.reuse = true
    else if (a === '--no-reuse') opts.reuse = false
    else if (a === '--profile') opts.profile = next()
    else if (a === '--home') opts.home = next()
    else if (a === '--model-dir') opts.modelDir = next()
    else if (a === '--python') opts.python = next()
    else if (a === '--torch') opts.torch = next()
    else if (a === '--pip-index') opts.pipIndex = next()
    else if (a === '--uv-url') opts.uvUrl = next()
    else if (a === '--python-mirror') opts.pythonMirror = next()
    else if (a === '--diffusers-commit') opts.diffusersCommit = next()
    else if (a === '--endpoint') opts.endpoint = next()
    else if (a === '--help' || a === '-h') opts.help = true
  }
  return opts
}

const HELP = [
  'dsh-qwen-image 安装器 ' + VERSION,
  '',
  '用法：node installer/install.mjs [选项]',
  '',
  '  --check              只体检不修改（排障第一步；等价 --doctor）',
  '  --dry-run            只打印将要做什么，什么都不执行（等价 --dry）',
  '  -y, --yes            全部使用默认答案（无人值守安装）',
  '  --profile <name>     目标 dsh profile（默认自动挑选，通常为 web）',
  '  --home <dir>         DSH_HOME（默认环境变量 DSH_HOME 或 ~/.dsh）',
  '  --model-dir <dir>    权重目录（默认 <DSH_HOME>/models/Qwen-Image-2.1）',
  '  --python <exe>       指定 Python 解释器（复用已装好的环境）',
  '  --torch <key>        强制 torch 轮子：cu128/cu126/cu124/cu121/cu118/rocm63/cpu/pypi（未知值回落 cu128）',
  '  --reuse / --no-reuse 是否复用已装好的 torch/diffusers（默认复用）',
  '  --pip-index <url>    指定 pip 源（默认按实测延迟自动选）',
  '  --endpoint <url>     权重下载端点（默认 https://hf-mirror.com）',
  '  --no-model           跳过权重下载（约 30.9GB；等价 --skip-model）',
  '  --no-plugin          跳过插件注册（等价 --skip-plugin）',
  '  --no-net             跳过网络测速（离线体检更快）',
  '  --no-uv              不使用 uv（只用系统 Python + venv）',
  '  --uv-url <url>       指定 uv 可执行文件的下载地址（内网/代理）',
  '  --python-mirror <url>  uv 下载 Python 用的镜像（等价环境变量 DSH_QWEN_PYTHON_MIRROR）',
  '  --diffusers-commit <sha>  指定 diffusers commit',
  '  --json               以 JSON 输出最终报告',
  '  -q, --quiet          精简输出（只留结论与错误）',
  '  --force              强制重装（忽略已有的 venv / 权重）',
  '  -h, --help           打印本帮助',
  '',
  '文档：docs/INSTALL.md     排障：--check --json',
].join('\n')

/**
 * 主流程。
 * @returns {Promise<number>} 退出码（0 成功 / 1 失败 / 2 环境不满足）
 */
export async function runInstaller(argv) {
  const opts = parseArgs(argv || [])
  if (opts.help) {
    process.stdout.write(HELP + '\n')
    return 0
  }

  const pluginRoot = findPluginRoot(import.meta.url)
  const manifest = readPluginManifest(pluginRoot)
  const paths = resolvePaths(opts.home || process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh'), pluginRoot)
  // DSH_HOME 的最终解析交给 detect（它同时会读环境变量）
  const ui = createUI({ yes: opts.yes, json: opts.json, quiet: opts.quiet })
  const started = Date.now()
  const report = {
    ok: false,
    version: VERSION,
    pluginRoot: pluginRoot,
    pluginVersion: manifest ? manifest.version : null,
    steps: [],
    blockers: [],
    warnings: [],
    facts: null,
    plan: null,
  }

  ui.title('dsh-qwen-image 一键安装器 v' + VERSION)
  ui.info('插件目录：' + pluginRoot)
  if (!manifest) {
    ui.err('这里看起来不是插件目录（找不到 package.json）')
    ui.hint('请从插件根目录运行：node installer/install.mjs')
    return 1
  }

  // ── 1/7 环境探测 ──
  ui.step(1, 7, '环境探测')
  const facts = await detectEnvironment({ home: opts.home, net: !opts.noNet, pythonExe: opts.python, maxDeepProbes: 4 })
  report.facts = facts

  // 日志落在插件自己的 logs 目录里，方便用户「把日志发出来」
  const logDir = join(facts.home, 'dsh-qwen-image', 'logs')
  const logPath = join(logDir, 'install-' + stamp() + '.log')
  ui.setLogPath(logPath)

  const mainGpu = facts.gpus.find((g) => g.vendor === 'nvidia') || facts.gpus[0] || null
  ui.table([
    { label: '系统', value: facts.platform + ' ' + facts.arch + '（' + facts.cpu + '，' + facts.cpuCount + ' 核）' },
    { label: '内存', value: humanBytes(facts.ramBytes) },
    { label: '磁盘可用', value: facts.disk.free == null ? '未知' : humanBytes(facts.disk.free), note: '装完约需 ' + humanBytes(MODEL_SIZE_BYTES + DEPS_SIZE_BYTES) },
    { label: '显卡', value: mainGpu ? mainGpu.name + '（' + (mainGpu.vramMiB || '?') + 'MB，空闲 ' + (mainGpu.freeMiB == null ? '?' : mainGpu.freeMiB + 'MB') + '）' : '未检测到' },
    { label: '驱动', value: (mainGpu && mainGpu.driver) || '无', note: facts.cudaDriverVersion ? 'CUDA ' + facts.cudaDriverVersion : '' },
    { label: 'DSH_HOME', value: facts.home },
    { label: 'dsh', value: facts.tools.dsh || '未找到', note: facts.dshVersion || '' },
    { label: 'Python', value: facts.pythons.length ? facts.pythons.map((p) => p.version + '(' + p.kind + ')').join('、') : '未找到' },
    { label: '日志', value: logPath },
  ])
  if (facts.comfyui && facts.comfyui.length) {
    ui.info('检测到 ComfyUI：' + facts.comfyui.map((c) => c.dir).join('、'))
    ui.detail('如果它的 Python 里已经有 torch，安装器会直接借用（省下约 3GB 下载），不会改动它。')
  }

  // ── 2/7 生成计划 ──
  ui.step(2, 7, '安装计划')
  const modelDir = opts.modelDir || join(facts.home, 'models', 'Qwen-Image-2.1')
  const preModelState = checkModel({ paths: paths, venvPython: null }, modelDir, (findReadyPython(facts) || {}).path || (facts.pythons[0] || {}).path)
  const plan = buildPlan(facts, {
    profile: opts.profile,
    modelDir: modelDir,
    torch: opts.torch,
    reuse: opts.reuse,
    withModel: !opts.noModel,
    pluginRoot: pluginRoot,
    modelState: preModelState,
    pythonOverride: opts.python ? { path: opts.python } : null,
    uvAvailable: !!facts.tools.uv,
  })
  report.plan = plan
  report.blockers = plan.blockers
  report.warnings = plan.warnings

  ui.table([
    { label: 'Python 策略', value: describeStrategy(plan.python.strategy), note: plan.python.interpreter || '' },
    { label: 'PyTorch', value: plan.torch.version + ' / ' + plan.torch.label },
    { label: '精度 / offload', value: plan.gpu.dtype + ' / ' + plan.gpu.offload, note: plan.gpu.dtypeNote },
    { label: '默认档位', value: plan.gpu.preset, note: plan.gpu.offloadNote },
    { label: '权重目录', value: modelDir, note: preModelState.state === 'ok' ? '已存在，跳过下载' : '需要下载' },
    { label: '目标 profile', value: plan.plugin.profile },
  ])
  for (const n of plan.notes) ui.detail(n)
  for (const g of plan.gpu.notes) ui.warn(g)
  for (const w of plan.warnings) ui.warn(w)
  for (const b of plan.blockers) {
    ui.err(b.message)
    ui.hint(b.fix)
  }

  if (opts.check) {
    ui.rule()
    ui.title('体检结论')
    if (plan.blockers.length) ui.err('有 ' + plan.blockers.length + ' 项硬性问题需要先解决（见上）')
    const ready = findReadyPython(facts)
    const torchOnly = findTorchPython(facts)
    for (const p of facts.pythons) {
      const bits = [
        'Python ' + p.version,
        p.torch ? 'torch ' + p.torch : '无 torch',
        p.diffusers ? 'diffusers ' + p.diffusers + (p.hasQwen21 ? '(含 QwenImage21)' : '(不含 QwenImage21)') : '无 diffusers',
      ]
      ui.info('解释器：' + p.path)
      ui.detail(bits.join('  |  '))
    }
    if (ready) {
      ui.ok('可直接复用这个环境：' + ready.path)
      ui.detail('复用时只借它的 site-packages，不动它本身的文件；想强制全新安装：--no-reuse')
    } else if (torchOnly) {
      ui.info('这个环境已有 torch（' + torchOnly.torch + '），只差 diffusers：' + torchOnly.path)
    }
    const modelStateText = preModelState.state === 'ok' ? '已就位' : preModelState.state === 'missing' ? '尚未下载（约 30.9GB）' : preModelState.state
    ui.info('权重：' + modelStateText)
    ui.info('下一步：去掉 --check 就是真正的安装；加 --dry-run 可以先看它要做什么。')
    // 体检模式下 ok 表示「环境满足安装条件」，而不是「安装已完成」
    report.mode = 'check'
    report.ok = plan.blockers.length === 0
    if (opts.json) ui.jsonOut(report)
    return plan.blockers.length ? 2 : 0
  }

  if (plan.blockers.length && !opts.yes) {
    ui.err('存在阻塞项，安装无法继续')
    return 2
  }

  if (opts.dryRun) {
    printDryRun(ui, { facts, plan, opts, paths, modelDir, preModelState })
    report.mode = 'dry-run'
    report.ok = plan.blockers.length === 0
    if (opts.json) ui.jsonOut(report)
    return 0
  }

  const ctx = {
    facts: facts,
    plan: plan,
    ui: ui,
    opts: opts,
    paths: paths,
    dryRun: false,
    venvPython: null,
    uv: null,
    interpreter: null,
    env: null,
  }

  // ── 3/7 解释器 ──
  ui.step(3, 7, 'Python 解释器')
  if (plan.python.strategy === 'reuse-site' && plan.python.interpreter) {
    ui.info('发现可复用的环境：' + plan.python.interpreter)
    const useIt = await ui.confirm('复用它（借它的包目录，省约 3GB 下载、不动它本身的文件）？', true)
    if (!useIt) plan.python = { strategy: 'clean', interpreter: plan.python.interpreter, minor: plan.python.minor, version: plan.python.version, donorSitePackages: null, note: '按要求改为全新安装' }
  }
  const interpreter = await ensureInterpreter(ctx, opts)
  if (!interpreter) {
    ui.err('拿不到可用的 Python 解释器，安装无法继续')
    ui.hint('手动装一个 Python 3.12 后重跑：https://www.python.org/downloads/（国内镜像 https://mirrors.huaweicloud.com/python/）')
    report.steps.push({ step: 'python', ok: false })
    if (opts.json) ui.jsonOut(report)
    return 1
  }
  ctx.interpreter = interpreter
  report.steps.push({ step: 'python', ok: true, interpreter: interpreter.path, version: interpreter.version })

  // ── 4/7 venv ──
  ui.step(4, 7, '隔离环境（venv）')
  const venv = await ensureVenv(ctx, {
    interpreter: interpreter.path,
    donorSitePackages: plan.python.donorSitePackages,
    force: opts.force,
  })
  if (!venv) {
    report.steps.push({ step: 'venv', ok: false })
    if (opts.json) ui.jsonOut(report)
    return 1
  }
  ctx.venvPython = venv.python
  report.steps.push({ step: 'venv', ok: true, dir: venv.dir, created: venv.created })

  // ── 5/7 依赖 ──
  ui.step(5, 7, '安装 Python 依赖（torch / diffusers / transformers …）')
  ui.detail('预计下载 3-6GB，视网速 5-40 分钟。中途可以 Ctrl+C，重跑会接着装。')
  const deps = await installDeps(ctx, opts)
  report.steps.push({ step: 'deps', ok: deps.ok, failures: deps.failures })
  if (!deps.ok) {
    ui.warn('依赖没装全，后面会给出补救指引')
  }

  // ── 6/7 权重 ──
  ui.step(6, 7, '权重（Qwen-Image-2.1）')
  const model = await ensureModel(ctx, { modelDir: modelDir, noModel: opts.noModel, force: opts.force, endpoint: opts.endpoint })
  report.steps.push({ step: 'model', ok: model.ok, action: model.action, dir: modelDir })

  // ── 7/7 注册插件 ──
  ui.step(7, 7, '注册插件到 dsh profile')
  let registered = { ok: false }
  if (opts.noPlugin) {
    ui.warn('按要求跳过插件注册（手动命令见下方）')
  } else {
    registered = await registerPlugin(ctx, { profile: plan.plugin.profile, pluginRoot: pluginRoot, force: opts.force })
    if (registered.ok) {
      configureProfile(ctx, {
        profile: plan.plugin.profile,
        modelDir: modelDir,
        pythonExe: ctx.venvPython,
        preset: plan.gpu.preset,
        hfEndpoint: plan.model.endpoint,
      })
      writeState(paths, {
        version: VERSION,
        profile: plan.plugin.profile,
        modelDir: modelDir,
        venv: ctx.paths.venvDir,
        venvPython: ctx.venvPython,
        interpreter: interpreter.path,
        torch: plan.torch.version,
        torchIndex: plan.torch.label,
        preset: plan.gpu.preset,
      })
      verifyRegistration(ctx, { profile: plan.plugin.profile, modelDir: modelDir })
    }
  }
  report.steps.push({ step: 'plugin', ok: registered.ok, profile: plan.plugin.profile })

  // ── 收尾核验 ──
  ui.rule()
  ui.title('核验')
  const verified = verifyInstall(ctx, isDir(modelDir) ? modelDir : null)
  report.verified = verified.report
  // 显式跳过的步骤不算失败：环境本身可用就算装成功
  report.ok = verified.ok && (registered.ok || opts.noPlugin)
  report.durationSec = Math.round((Date.now() - started) / 1000)

  ui.title('完成情况')
  ui.table([
    { label: 'Python', value: interpreter.version + '（' + interpreter.path + '）' },
    { label: 'venv', value: ctx.paths.venvDir },
    { label: '权重', value: modelDir + '（' + model.action + '）' },
    { label: 'profile', value: plan.plugin.profile + (registered.ok ? '（已注册）' : '（未注册）') },
    { label: '日志', value: logPath },
    { label: '耗时', value: report.durationSec + ' 秒' },
  ])

  ui.title('下一步')
  ui.info('1) 重启 dsh 让插件生效（客户端半只在进程启动时加载）：')
  ui.cmd('dsh --profile ' + plan.plugin.profile)
  ui.info('2) 打开 Web GUI，在对话里直接说：画一只戴墨镜的柴犬')
  ui.info('3) 想先试试深浅：draft 档（768²/12 步）最快；满意后再要 1024² 定稿')
  let nextIndex = 4
  if (!model.ok) {
    ui.info(nextIndex++ + ') 权重还没齐，按上面的命令补下（重跑安装器也会续传）')
  }
  if (!registered.ok) {
    ui.info(nextIndex++ + ') 手动注册插件：')
    ui.cmd('dsh plugin --profile ' + plan.plugin.profile + ' add "' + pluginRoot + '"')
  }

  if (opts.json) ui.jsonOut(report)
  return report.ok ? 0 : 1
}

/** 计划里的策略名 → 中文说明。 */
function describeStrategy(strategy) {
  const table = {
    'explicit': '使用 --python 指定的解释器',
    'reuse-site': '复用已装好的环境（借包目录）',
    'clean': '新建独立 venv 全量安装',
    'uv': 'uv 托管 Python',
    'uv-needed': '需要先获取 uv 再托管 Python',
    'none': '没有可用解释器',
  }
  return table[strategy] || strategy
}

/** --dry-run：把将要执行的每一步打印出来，一步都不做。 */
function printDryRun(ui, bag) {
  const plan = bag.plan
  const opts = bag.opts
  ui.title('将要做的事（--dry-run，未执行任何操作）')
  ui.info('1) 解释器：' + describeStrategy(plan.python.strategy) + (plan.python.interpreter ? ' → ' + plan.python.interpreter : ''))
  if (plan.python.strategy === 'uv' || plan.python.strategy === 'uv-needed') {
    ui.cmd('uv python install 3.12    （uv 会先被自动下载到 ' + bag.paths.runtimeDir + '）')
  }
  ui.info('2) venv：' + bag.paths.venvDir)
  ui.cmd('python -m venv "' + bag.paths.venvDir + '"')
  if (plan.python.donorSitePackages) ui.cmd('echo "' + plan.python.donorSitePackages + '" > <venv>/site-packages/_dsh_qwen_image_reuse.pth')
  ui.info('3) 依赖：')
  for (const d of plan.deps) ui.cmd('pip install ' + d.spec + (d.index ? ' --index-url ' + d.index : ''))
  ui.cmd('pip install https://github.com/huggingface/diffusers/archive/' + (opts.diffusersCommit || DIFFUSERS_COMMIT) + '.tar.gz')
  if (plan.model.needDownload) {
    ui.info('4) 权重：下载 ' + humanBytes(MODEL_SIZE_BYTES) + ' → ' + bag.modelDir)
    for (const cmd of manualCommands(bag.modelDir, plan.model.endpoint)) ui.cmd(cmd)
  } else {
    ui.info('4) 权重：已存在，跳过')
  }
  if (!opts.noPlugin) {
    ui.info('5) 注册插件：')
    ui.cmd('dsh plugin --profile ' + plan.plugin.profile + ' add "' + bag.paths.pluginRoot + '"')
    ui.info('6) 写配置：' + join(bag.facts.home, 'profiles', plan.plugin.profile, 'cordis.patch.yml'))
  }
}

// 作为脚本直接运行时执行
const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (invokedDirectly) {
  runInstaller(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write('\n安装器异常终止：' + (err && err.stack ? err.stack : String(err)) + '\n')
      process.stderr.write('请把上面的错误和日志文件一起反馈。\n')
      process.exit(1)
    })
}

export { HELP, VERSION }
