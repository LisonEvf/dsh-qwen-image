// 安装器离线冒烟：把「不同用户、不同设备」的机型矩阵全部用 fixture 跑一遍。
//
// 为什么必须离线：安装器要面对的正是「用户机器上没有 GPU / 没有 Python / 驱动老旧 /
// 磁盘不够 / 网络受限」这些情况 —— 这些机器我们不可能都有，只能靠构造 facts 来回归。
// 本脚本不联网、不起进程、不写 %DSH_HOME%，只验证**决策与幂等逻辑**。
//
// 运行：node scripts/smoke-installer.mjs
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

import {
  buildPlan,
  choosePython,
  isUsableVersion,
  parseCuda,
  pickMainGpu,
  pickProfile,
  pickTorchIndex,
  pickTorchVersion,
  recommendDtype,
  recommendOffload,
} from '../installer/lib/plan.mjs'
import { findReadyPython, guessComputeCapability, parseCudaVersion, parseNvidiaSmiQuery, parsePyLauncherList } from '../installer/lib/detect.mjs'
import { parseArgs } from '../installer/install.mjs'
import { pickPipMirror, uvAssetName, uvDownloadUrls, DIFFUSERS_COMMIT } from '../installer/lib/pystep.mjs'
import { renderConfigBlock, upsertConfigBlock, findPluginRoot } from '../installer/lib/pluginstep.mjs'
import { childEnv } from '../installer/lib/util.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
let pass = 0
let fail = 0
const check = (name, ok, detail) => {
  if (ok) {
    pass++
    console.log('  ok   ' + name)
  } else {
    fail++
    console.error('  FAIL ' + name + (detail ? '\n       ' + detail : ''))
  }
}
const eq = (name, actual, expected) => check(name, Object.is(actual, expected), 'actual=' + JSON.stringify(actual) + ' expected=' + JSON.stringify(expected))

/** 造一份「某台机器」的 facts。 */
function factsOf(patch) {
  const base = {
    platform: 'win32',
    arch: 'x64',
    isWin: true,
    isMac: false,
    isLinux: false,
    cpu: 'Test CPU',
    cpuCount: 8,
    ramBytes: 32 * 1024 ** 3,
    home: 'C:/Users/tester/.dsh',
    homeWritable: true,
    profiles: [{ name: 'web', dir: 'C:/x/web', hasManifest: true, hasPatch: true }],
    node: { version: '22.0.0', ok: true },
    tools: { npm: 'C:/npm.cmd', pnpm: 'C:/pnpm.cmd', git: 'C:/git.exe', uv: null, hf: null, dsh: 'C:/dsh.cmd' },
    gpus: [],
    gpuVendor: 'none',
    cudaDriverVersion: null,
    pythons: [],
    comfyui: [],
    net: {},
    disk: { free: 500 * 1024 ** 3, total: 1000 * 1024 ** 3 },
    warnings: [],
  }
  return Object.assign(base, patch || {})
}

function nvidia(name, vram, free, cap, driver, cuda) {
  return { index: 0, name: name, vramMiB: vram, freeMiB: free, driver: driver, computeCapability: cap, cudaVersion: cuda, vendor: 'nvidia' }
}

function py(path, version, extra) {
  return Object.assign(
    {
      path: path,
      version: version,
      minor: Number(String(version).split('.')[1]),
      sitePackages: path.replace(/python(\.exe)?$/, 'site-packages'),
      kind: 'system',
      source: 'PATH',
      torch: null,
      diffusers: null,
      hasQwen21: undefined,
    },
    extra || {},
  )
}

console.log('\n=== 安装器离线冒烟（设备矩阵）===\n')

// ── 1. nvidia-smi 解析 ────────────────────────────────────────────────────
console.log('-- 解析 --')
const smi = parseNvidiaSmiQuery(
  ['0, Tesla P40, 24576 MiB, 205 MiB, 576.80, 6.1', '1, NVIDIA GeForce GTX 1660 SUPER, 6144 MiB, 4800 MiB, 576.80, 7.5'].join('\n'),
  '12.9',
)
eq('两台卡的 CSV 解析出 2 条', smi.length, 2)
eq('显存解析为数字', smi[0].vramMiB, 24576)
eq('compute_cap 解析', smi[1].computeCapability, 7.5)
eq('CUDA 版本带下来', smi[0].cudaVersion, '12.9')
const smiOld = parseNvidiaSmiQuery('0, Tesla P40, 24576 MiB, 24466 MiB, 441.22, [N/A]', '11.4')
eq('老驱动的 [N/A] 不炸', smiOld.length, 1)
eq('[N/A] 时 capability 为 null', smiOld[0].computeCapability, null)
eq('CUDA 版本正则', parseCudaVersion('| NVIDIA-SMI 576.80   Driver Version: 576.80   CUDA Version: 12.9 |'), '12.9')
eq('按显卡名兜底 P40', guessComputeCapability('Tesla P40'), 6.1)
eq('按显卡名兜底 4090', guessComputeCapability('NVIDIA GeForce RTX 4090'), 8.9)
const pyList = parsePyLauncherList(' -V:3.12 *        C:\\Python312\\python.exe\n -V:3.9          C:\\Python39\\python.exe\n')
eq('py -0p 解析条数', pyList.length, 2)
eq('py -0p 解析路径', pyList[0].path, 'C:\\Python312\\python.exe')

// ── 2. torch 索引选择矩阵 ─────────────────────────────────────────────────
console.log('-- PyTorch 轮子选择 --')
eq('CUDA 12.9 → cu128', pickTorchIndex(factsOf({ gpuVendor: 'nvidia', cudaDriverVersion: '12.9' })).key, 'cu128')
eq('CUDA 12.6 → cu126', pickTorchIndex(factsOf({ gpuVendor: 'nvidia', cudaDriverVersion: '12.6' })).key, 'cu126')
eq('CUDA 12.4 → cu124', pickTorchIndex(factsOf({ gpuVendor: 'nvidia', cudaDriverVersion: '12.4' })).key, 'cu124')
eq('CUDA 12.1 → cu121', pickTorchIndex(factsOf({ gpuVendor: 'nvidia', cudaDriverVersion: '12.1' })).key, 'cu121')
eq('CUDA 11.8 → cu118', pickTorchIndex(factsOf({ gpuVendor: 'nvidia', cudaDriverVersion: '11.8' })).key, 'cu118')
eq('CUDA 11.4 太旧 → CPU 兜底', pickTorchIndex(factsOf({ gpuVendor: 'nvidia', cudaDriverVersion: '11.4' })).key, 'cpu')
eq('无 GPU → CPU', pickTorchIndex(factsOf({ gpuVendor: 'none' })).key, 'cpu')
eq('Linux + AMD → ROCm', pickTorchIndex(factsOf({ platform: 'linux', isWin: false, isLinux: true, gpuVendor: 'amd' })).key, 'rocm63')
eq('macOS → PyPI 默认轮子', pickTorchIndex(factsOf({ platform: 'darwin', isWin: false, isMac: true, gpuVendor: 'apple' })).key, 'pypi')
eq('用户显式 --torch cpu 优先', pickTorchIndex(factsOf({ gpuVendor: 'nvidia', cudaDriverVersion: '12.9' }), 'cpu').key, 'cpu')
eq('cu118 只有 2.4.1', pickTorchVersion('cu118', 12), '2.4.1')
eq('cu128 在 3.12 上取 2.7.1', pickTorchVersion('cu128', 12), '2.7.1')
eq('cu128 在 3.13 上仍可', pickTorchVersion('cu128', 13), '2.7.1')
eq('cu124 在 3.13 上落到 2.6.0（该版有 cp313 轮子）', pickTorchVersion('cu124', 13), '2.6.0')

// ── 3. 精度 / offload / 档位建议 ──────────────────────────────────────────
console.log('-- 精度与档位 --')
eq('sm 8.9 → bf16', recommendDtype(8.9).dtype, 'bf16')
eq('sm 6.1 → fp16（P40 实测更快）', recommendDtype(6.1).dtype, 'fp16')
eq('sm 5.2 → fp32', recommendDtype(5.2).dtype, 'fp32')
eq('24GB 显存 → model offload + standard', recommendOffload(24576).offload + '/' + recommendOffload(24576).preset, 'model/standard')
eq('16GB → 仍是 standard', recommendOffload(16384).preset, 'standard')
eq('12GB → sequential + draft', recommendOffload(12288).offload + '/' + recommendOffload(12288).preset, 'sequential/draft')
eq('6GB → draft 且提示紧张', recommendOffload(6144).preset, 'draft')
eq('无显存信息 → draft', recommendOffload(null).preset, 'draft')

// ── 4. 主卡选择（P40 被占满要自动落到另一张）────────────────────────────
console.log('-- 多卡 --')
const gpus = [nvidia('Tesla P40', 24576, 200, 6.1, '576.80', '12.9'), Object.assign(nvidia('GTX 1660 SUPER', 6144, 4800, 7.5, '576.80', '12.9'), { index: 1 })]
eq('按空闲显存选主卡', pickMainGpu({ gpus: gpus, gpuVendor: 'nvidia' }).name, 'GTX 1660 SUPER')

// ── 5. buildPlan 端到端（几台典型机器）───────────────────────────────────
console.log('-- 完整计划 --')
const winReady = buildPlan(
  factsOf({
    gpuVendor: 'nvidia',
    cudaDriverVersion: '12.9',
    gpus: [nvidia('NVIDIA GeForce RTX 4090', 24576, 24000, 8.9, '576.80', '12.9')],
    pythons: [py('C:/Python312/python.exe', '3.12.10', { torch: '2.7.1+cu128', diffusers: '0.41.0.dev0', hasQwen21: true })],
  }),
  { withModel: true },
)
check('4090 + 现成环境 → 计划可行', winReady.ok)
eq('4090 → 复用现成环境', winReady.python.strategy, 'reuse-site')
eq('4090 → cu128', winReady.torch.key, 'cu128')
eq('4090 → bf16', winReady.gpu.dtype, 'bf16')
eq('4090 有现成 diffusers → 依赖清单里没有 diffusers', winReady.deps.some((d) => d.special === 'diffusers'), false)
eq('4090 有现成 torch → 依赖清单里没有 torch', winReady.deps.some((d) => /^torch==/.test(d.spec)), false)
eq('默认 profile 选 web', winReady.plugin.profile, 'web')

const p40Busy = buildPlan(
  factsOf({
    gpuVendor: 'nvidia',
    cudaDriverVersion: '12.9',
    gpus: [nvidia('Tesla P40', 24576, 205, 6.1, '576.80', '12.9'), Object.assign(nvidia('GTX 1660 SUPER', 6144, 4800, 7.5, '576.80', '12.9'), { index: 1 })],
    pythons: [],
  }),
  { withModel: true },
)
eq('P40 被占满 → 主卡落到 1660S', p40Busy.gpu.main.name, 'GTX 1660 SUPER')
eq('1660S → sequential', p40Busy.gpu.offload, 'sequential')
eq('1660S → draft', p40Busy.gpu.preset, 'draft')
eq('没有 Python → 走 uv 托管', p40Busy.python.strategy === 'uv-needed' || p40Busy.python.strategy === 'uv', true)
check('计划里给出显存偏小的提示', p40Busy.gpu.notes.some((n) => /显存/.test(n)), JSON.stringify(p40Busy.gpu.notes))

const oldDriver = buildPlan(factsOf({ gpuVendor: 'nvidia', cudaDriverVersion: '11.4', gpus: [nvidia('GTX 1080', 8192, 8000, 6.1, '441.22', '11.4')], pythons: [py('C:/Python312/python.exe', '3.12.10')] }), {})
eq('老驱动 → CPU 轮子', oldDriver.torch.key, 'cpu')
check('老驱动 → 提示升级驱动', oldDriver.warnings.some((w) => /驱动过旧/.test(w)))

const noGpu = buildPlan(factsOf({ gpuVendor: 'none', pythons: [py('C:/Python312/python.exe', '3.12.10')] }), {})
eq('无独显 → CPU 轮子', noGpu.torch.key, 'cpu')
check('无独显 → 警告 CPU 很慢', noGpu.warnings.some((w) => /CPU 版 torch/.test(w)))

const comfy = buildPlan(
  factsOf({
    gpuVendor: 'nvidia',
    cudaDriverVersion: '12.9',
    gpus: [nvidia('RTX 3060', 12288, 11000, 8.6, '576.80', '12.9')],
    pythons: [
      py('C:/ComfyUI_windows_portable/python_embeded/python.exe', '3.12.7', { torch: '2.6.0+cu124', diffusers: '0.41.0.dev0', hasQwen21: true, kind: 'comfyui-embedded', source: 'comfyui' }),
    ],
    comfyui: [{ dir: 'C:/ComfyUI_windows_portable', embedded: true, venv: false, modelsDir: true }],
  }),
  {},
)
eq('ComfyUI 便携版 → 复用它的 site-packages', comfy.python.strategy, 'reuse-site')
check('复用说明里点名 ComfyUI', /ComfyUI/.test(comfy.python.note), comfy.python.note)
eq('借用路径指向它的包目录', comfy.python.donorSitePackages, 'C:/ComfyUI_windows_portable/python_embeded/site-packages')
check('检测到 ComfyUI 时给出复用提示', comfy.python.note.indexOf('省去约 3GB') >= 0)

const smallDisk = buildPlan(factsOf({ pythons: [py('C:/Python312/python.exe', '3.12.10')], disk: { free: 5 * 1024 ** 3, total: 100 * 1024 ** 3 } }), { withModel: true })
check('磁盘不够 → 硬阻塞', smallDisk.blockers.some((b) => b.code === 'disk-too-small'))
check('阻塞项带可操作修复建议', /--model-dir/.test((smallDisk.blockers.find((b) => b.code === 'disk-too-small') || {}).fix || ''))
const smallDiskButNoModel = buildPlan(factsOf({ pythons: [py('C:/Python312/python.exe', '3.12.10')], disk: { free: 12 * 1024 ** 3, total: 100 * 1024 ** 3 } }), { withModel: false })
check('--no-model 时磁盘不再阻塞（只装依赖）', !smallDiskButNoModel.blockers.some((b) => b.code === 'disk-too-small'))

const roHome = buildPlan(factsOf({ homeWritable: false, pythons: [py('C:/Python312/python.exe', '3.12.10')] }), {})
check('DSH_HOME 不可写 → 硬阻塞', roHome.blockers.some((b) => b.code === 'home-not-writable'))

const modelReady = buildPlan(factsOf({ pythons: [py('C:/Python312/python.exe', '3.12.10')] }), { modelState: { state: 'ok', missing: [] }, withModel: true })
eq('权重已就位 → 不需要下载', modelReady.model.needDownload, false)
eq('权重已就位 → 磁盘需求显著下降', modelReady.disk.required < 12 * 1024 ** 3, true)

// ── 6. Python 策略与版本闸门 ─────────────────────────────────────────────
console.log('-- Python 策略 --')
eq('3.9 太旧 → 不可用', isUsableVersion('3.9.13'), false)
eq('3.10 可用', isUsableVersion('3.10.11'), true)
eq('3.13 可用', isUsableVersion('3.13.1'), true)
eq('3.14 太新 → 不可用', isUsableVersion('3.14.0'), false)
const onlyOld = choosePython(factsOf({ pythons: [py('C:/Python39/python.exe', '3.9.13')] }), {})
eq('只有 3.9 → 走 uv 托管', onlyOld.strategy === 'uv-needed' || onlyOld.strategy === 'uv', true)
const explicit = choosePython(factsOf({ pythons: [] }), { pythonOverride: { path: 'D:/py/python.exe', info: { version: '3.12.1' } } })
eq('--python 优先生效', explicit.strategy, 'explicit')
const noTorch = choosePython(factsOf({ pythons: [py('C:/Python312/python.exe', '3.12.10')] }), {})
eq('有 Python 但没 torch → 全新 venv', noTorch.strategy, 'clean')
const noReuse = choosePython(factsOf({ pythons: [py('C:/Python312/python.exe', '3.12.10', { torch: '2.7.1', diffusers: '0.41.0.dev0', hasQwen21: true })] }), { reuse: false })
eq('--no-reuse → 不借用', noReuse.strategy, 'clean')
eq('findReadyPython 没装 torch 时返回 null', findReadyPython({ pythons: [py('C:/Python312/python.exe', '3.12.10')] }), null)
eq('pickProfile 优先 web', pickProfile([{ name: 'sdk' }, { name: 'web' }]), 'web')
eq('pickProfile 单个 profile 时用它', pickProfile([{ name: 'tui' }]), 'tui')
eq('pickProfile 无 profile 时回落 web', pickProfile([]), 'web')
eq('parseCuda 解析', JSON.stringify(parseCuda('12.9')), '[12,9]')

// ── 7. uv 资产名与下载阶梯 ───────────────────────────────────────────────
console.log('-- uv --')
eq('Windows x64 资产名', uvAssetName('win32', 'x64'), 'uv-x86_64-pc-windows-msvc.zip')
eq('Windows arm64 资产名', uvAssetName('win32', 'arm64'), 'uv-aarch64-pc-windows-msvc.zip')
eq('Linux x64 资产名', uvAssetName('linux', 'x64'), 'uv-x86_64-unknown-linux-gnu.tar.gz')
eq('macOS arm64 资产名', uvAssetName('darwin', 'arm64'), 'uv-aarch64-apple-darwin.tar.gz')
const urls = uvDownloadUrls('win32', 'x64', {})
check('默认至少给两条下载路径（官方 + 代理兜底）', urls.length >= 2 && /^https:\/\/github.com\//.test(urls[0]), urls.join(' , '))
const urlsCustom = uvDownloadUrls('win32', 'x64', { uvUrl: 'https://mirror.example/uv.zip' })
eq('自定义 uv 源排第一', urlsCustom[0], 'https://mirror.example/uv.zip')

// ── 8. pip 镜像测速选择 ──────────────────────────────────────────────────
console.log('-- 镜像 --')
eq('官方快 → 用官方', pickPipMirror({ net: { pypi: { ok: true, ms: 200 }, tuna: { ok: true, ms: 900 } } }, {}).name, 'PyPI 官方')
eq('官方慢 → 用清华', pickPipMirror({ net: { pypi: { ok: true, ms: 3000 }, tuna: { ok: true, ms: 150 } } }, {}).name, '清华 TUNA')
eq('--pip-index 覆盖测速', pickPipMirror({ net: {} }, { pipIndex: 'https://my/simple' }).url, 'https://my/simple')
eq('都不可达 → 回落官方', pickPipMirror({ net: { pypi: { ok: false }, tuna: { ok: false } } }, {}).url, null)

// ── 9. profile 配置块幂等 ────────────────────────────────────────────────
console.log('-- 配置写入 --')
const tmp = mkdtempSync(join(tmpdir(), 'dshqwen-smoke-'))
const patchPath = join(tmp, 'cordis.patch.yml')
const block = renderConfigBlock({ modelDir: 'D:/models/Qwen-Image-2.1', pythonExe: 'D:/venv/Scripts/python.exe', preset: 'draft' })
check('配置块含 20 个键', (block.match(/^ {4}[a-zA-Z]+:/gm) || []).length === 20, String((block.match(/^ {4}[a-zA-Z]+:/gm) || []).length))
check('配置块里 modelDir 写成了正斜杠', block.indexOf("'D:/models/Qwen-Image-2.1'") >= 0)
writeFileSync(patchPath, '# 用户自己的 patch\n- id: other-plugin\n  config:\n    a: 1\n', 'utf8')
const first = upsertConfigBlock(patchPath, block)
eq('首次写入是追加（不是替换）', first.replaced, false)
const afterFirst = readFileSync(patchPath, 'utf8')
check('原有其它插件配置没被动', afterFirst.indexOf('other-plugin') >= 0)
check('新块已写入', afterFirst.indexOf('- id: qwen-image') >= 0)
const second = upsertConfigBlock(patchPath, block)
eq('再次写入识别为替换', second.replaced, true)
const afterSecond = readFileSync(patchPath, 'utf8')
eq('重复写入不产生第二份块', (afterSecond.match(/- id: qwen-image/g) || []).length, 1)
eq('重复写入内容稳定（幂等）', afterSecond.replace(/\r\n/g, '\n'), afterFirst.replace(/\r\n/g, '\n'))
check('写入前留了备份文件', !!second.backup)
const emptyPatch = join(tmp, 'empty.yml')
writeFileSync(emptyPatch, '[]\n', 'utf8')
upsertConfigBlock(emptyPatch, block)
check('空数组 patch 也能正确落地（不会被残留的 [] 干扰）', readFileSync(emptyPatch, 'utf8').indexOf('[]') < 0)
// dsh 新建 profile 的真实模板形态：注释 + []，直接追加会产出非法 YAML
const tplPatch = join(tmp, 'tpl.yml')
writeFileSync(tplPatch, '# Your patch layer for this dsh profile\n# a top-level YAML array\n[]\n', 'utf8')
upsertConfigBlock(tplPatch, block)
const tplAfter = readFileSync(tplPatch, 'utf8')
check('模板（注释 + []）写入后不再残留顶级 []', !/^\s*\[\s*\]\s*$/m.test(tplAfter))
check('模板写入后 id 行是唯一的顶级数组元素', (tplAfter.match(/^- /gm) || []).length === 1, JSON.stringify(tplAfter.slice(0, 200)))
check('模板原有的说明注释被保留', tplAfter.indexOf('Your patch layer for this dsh profile') >= 0)
// 已经写坏的历史文件（[] 残留在块之前）重跑安装器也要能被修好
const broken = join(tmp, 'broken.yml')
writeFileSync(broken, '# comments\n[]\n\n' + block, 'utf8')
upsertConfigBlock(broken, block)
const brokenAfter = readFileSync(broken, 'utf8')
check('历史上被写坏的 patch（残留 []）重跑后被修好', !/^\s*\[\s*\]\s*$/m.test(brokenAfter))
eq('修复后仍只有一份 qwen-image 块', (brokenAfter.match(/- id: qwen-image/g) || []).length, 1)
rmSync(tmp, { recursive: true, force: true })

// ── 10. CLI 解析与路径 ───────────────────────────────────────────────────
console.log('-- CLI --')
const args = parseArgs(['--check', '--profile', 'tui', '--no-model', '--yes', '--model-dir', 'D:/m'])
eq('--check 解析', args.check, true)
eq('--profile 取值', args.profile, 'tui')
eq('--no-model 解析', args.noModel, true)
eq('--yes 解析', args.yes, true)
eq('--model-dir 取值', args.modelDir, 'D:/m')
const args2 = parseArgs(['--torch=cu118'])
eq('= 形式暂不支持时不影响其它解析', args2.torch, null)
eq('插件根目录能被找到', findPluginRoot(new URL('../installer/lib/pluginstep.mjs', import.meta.url).href), ROOT)
eq('diffusers commit 已锁定', /^[0-9a-f]{40}$/.test(DIFFUSERS_COMMIT), true)
const env = childEnv({ FOO: 'bar' })
eq('子进程强制 UTF-8（PYTHONUTF8）', env.PYTHONUTF8, '1')
eq('子进程保留原环境变量', env.FOO, 'bar')

console.log('\n=== 结果：' + pass + ' 通过，' + fail + ' 失败 ===\n')
process.exit(fail > 0 ? 1 : 0)
