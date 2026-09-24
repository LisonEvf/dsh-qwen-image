/**
 * worker 落盘逻辑的**离线**测试（不需要 GPU、不加载模型）。
 *
 * 为什么单独做这一层：`save_outputs` 里有不少「不容易在真跑时看出来」的分支
 * —— 缩略图格式探测与回退、sidecar 字段完整性、媒体类型推断。
 * 曾经就是一个 `Image` 忘了 import 让缩略图**静默**走进回退分支，
 * 只有真跑一次 30GB 模型才会暴露（耗时数分钟）。
 * 这里用合成图直接调用，秒级给出结论。
 *
 * 运行：node scripts/smoke-worker-offline.mjs
 */
import { execFileSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  if (ok) {
    pass++
    console.log(`  ok   ${name}`)
  } else {
    fail++
    console.error(`  FAIL ${name}${detail ? `\n       ${detail}` : ''}`)
  }
}

console.log('\n=== worker 落盘逻辑离线测试（无 GPU）===\n')

// 这段 Python 直接驱动真实的 save_outputs，检查产物形状与回退行为。
const PY = String.raw`
import json, os, sys, tempfile
sys.path.insert(0, os.path.join(r"${ROOT}", "worker"))
from PIL import Image, features
import pipeline_qwen21 as P

def photo_like(w, h, alpha=False):
    """
    造一张**接近照片**的合成图。

    两个刻意的选择：

    1. 用**噪声**而不是平滑渐变。渐变在 PNG 里压得极好（768² 只要约 4KB），
       会让「缩略图比原图小」的断言失真（实测 ratio > 1）。照片是高频细节。
    2. 用 os.urandom + Image.frombytes **一次性**构造，不要逐像素 Python 循环 ——
       后者要跑几十万次解释器迭代，既慢又吃内存。本机实测：它与正在加载
       30GB 权重的 worker 争内存，能把 worker 拖死（踩过一次）。
    """
    if alpha:
        data = bytearray(os.urandom(w * h * 4))
        # alpha 做成变化的：全 255 的不透明通道会被 WebP 优化掉，
        # 读回来变成 RGB —— 那是正确行为，不是丢 alpha。
        for i in range(3, len(data), 4):
            data[i] = ((i // 4) % 251) + 1
        return Image.frombytes("RGBA", (w, h), bytes(data))
    return Image.frombytes("RGB", (w, h), os.urandom(w * h * 3))

def meta():
    return {"seed": 42, "steps": 12, "elapsedSec": 1.5, "device": "cuda:0", "dtype": "fp16", "offload": "model"}

logs = []
out = {}

# ---- 1. 常规：应有 WebP 缩略图 ----
d1 = tempfile.mkdtemp()
res1 = {"images": [photo_like(768, 768)], **meta()}
saved1 = P.save_outputs(res1, d1, "g1", {"prompt": "hello"}, log=logs.append)
s1 = saved1[0]
out["saved_keys"] = sorted(s1.keys())
out["thumb_path"] = os.path.basename(s1["thumb"] or "")
out["thumb_media"] = s1["thumbMediaType"]
out["has_thumb_file"] = bool(s1["thumb"]) and os.path.exists(s1["thumb"])
out["webp_available"] = bool(features.check("webp"))
with open(s1["sidecar"], encoding="utf-8") as f:
    sc = json.load(f)
out["sidecar_keys"] = sorted(sc.keys())
out["sidecar_thumb_matches"] = sc["thumb"] == s1["thumb"] and sc["thumbMediaType"] == s1["thumbMediaType"]
out["sidecar_prompt"] = sc.get("prompt")
out["thumb_ratio"] = (s1["thumbBytes"] / s1["bytes"]) if s1["thumbBytes"] else None
out["raw_is_png"] = open(s1["file"], "rb").read(4) == b"\x89PNG"
if s1["thumb"]:
    head = open(s1["thumb"], "rb").read(12)
    out["thumb_is_webp"] = head[:4] == b"RIFF" and head[8:12] == b"WEBP"
    th = Image.open(s1["thumb"])
    out["thumb_max_side"] = max(th.size)

# ---- 2. RGBA 原图：缩略图必须保留 alpha（用**变化**的 alpha 才测得出）----
d2 = tempfile.mkdtemp()
res2 = {"images": [photo_like(512, 512, alpha=True)], **meta()}
saved2 = P.save_outputs(res2, d2, "g2", {"prompt": "transparent", "transparent": True}, log=logs.append)
s2 = saved2[0]
out["rgba_hasAlpha"] = s2["hasAlpha"]
if s2["thumb"]:
    th2 = Image.open(s2["thumb"])
    out["rgba_thumb_mode"] = th2.mode
    out["rgba_thumb_has_alpha_channel"] = th2.mode in ("RGBA", "LA")
    if th2.mode in ("RGBA", "LA"):
        alphas = sorted({th2.getpixel((x, 0))[3] for x in range(0, th2.size[0], 8)})
        out["rgba_alpha_distinct"] = len(alphas)

# ---- 3. 批量 count=2：命名与数量 ----
d3 = tempfile.mkdtemp()
res3 = {"images": [photo_like(256, 256), photo_like(256, 256)], **meta()}
saved3 = P.save_outputs(res3, d3, "g3", {"prompt": "batch"}, log=logs.append)
out["batch_ids"] = [x["id"] for x in saved3]
out["batch_files"] = sorted(os.listdir(d3))

# ---- 4. 强制回退 PNG ----
d4 = tempfile.mkdtemp()
res4 = {"images": [photo_like(256, 256)], **meta()}
saved4 = P.save_outputs(res4, d4, "g4", {"prompt": "png-fallback"}, thumb_format="png", log=logs.append)
s4 = saved4[0]
out["png_fallback_path"] = os.path.basename(s4["thumb"] or "")
out["png_fallback_media"] = s4["thumbMediaType"]

out["log_lines"] = logs
print(json.dumps(out, ensure_ascii=False))
`

let r
try {
  const stdout = execFileSync('python', ['-c', PY], {
    encoding: 'utf8',
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    maxBuffer: 8 * 1024 * 1024,
  })
  r = JSON.parse(stdout.trim().split('\n').pop())
} catch (err) {
  check('save_outputs 可离线执行', false, String(err.stdout ?? '') + String(err.stderr ?? err.message))
  console.log(`\n=== 结果：${pass} 通过，${fail} 失败 ===\n`)
  process.exit(1)
}

check('save_outputs 可离线执行（无 GPU）', true)

// ---- 返回结构 ----
check(
  '返回项含 file/sidecar/thumb/thumbMediaType/bytes/thumbBytes/hasAlpha',
  ['file', 'sidecar', 'thumb', 'thumbMediaType', 'bytes', 'thumbBytes', 'hasAlpha'].every((k) => r.saved_keys.includes(k)),
  r.saved_keys.join(','),
)

// ---- 缩略图真的生成了（回归「Image 忘了 import → 静默回退」）----
check('缩略图文件真实存在', r.has_thumb_file === true, `thumb_path=${r.thumb_path}`)
check('缩略图不是被静默跳过的空值', !!r.thumb_path, '若为 None 说明走了失败分支（曾因漏 import PIL 而静默失败）')
if (r.webp_available) {
  check('WebP 可用时缩略图用 .webp', r.thumb_path.endsWith('.thumb.webp'), r.thumb_path)
  check('缩略图确实是 WebP（RIFF/WEBP magic）', r.thumb_is_webp === true)
  check('媒体类型报 image/webp', r.thumb_media === 'image/webp', String(r.thumb_media))
} else {
  check('无 WebP 支持时回退 .thumb.png', r.thumb_path.endsWith('.thumb.png'), r.thumb_path)
  check('媒体类型报 image/png', r.thumb_media === 'image/png', String(r.thumb_media))
}
check('缩略图长边 ≤ 384', typeof r.thumb_max_side === 'number' && r.thumb_max_side <= 384, String(r.thumb_max_side))
check('原图始终是 PNG', r.raw_is_png === true)
// 照片类内容（噪声模拟）下，缩略图必须明显小于原图。
// 注意：平滑渐变图在 PNG 里压得极好，那种素材下 WebP 反而更大 —— 这是格式特性，不是缺陷。
check(
  '缩略图显著小于原图（相册才拉得动）',
  typeof r.thumb_ratio === 'number' && r.thumb_ratio < 0.15,
  `ratio=${r.thumb_ratio}`,
)

// ---- sidecar ----
check(
  'sidecar 含缩略图与耗时等字段',
  ['thumb', 'thumbMediaType', 'thumbBytes', 'prompt', 'seed', 'steps', 'elapsedSec', 'createdAt'].every((k) => r.sidecar_keys.includes(k)),
  r.sidecar_keys.join(','),
)
check('sidecar 的 thumb 与返回值一致', r.sidecar_thumb_matches === true)
check('sidecar 记录了 prompt（相册搜索依赖它）', r.sidecar_prompt === 'hello', String(r.sidecar_prompt))

// ---- RGBA ----
check('原图 hasAlpha 为真', r.rgba_hasAlpha === true)
check('透明图的缩略图保留 alpha 通道', r.rgba_thumb_has_alpha_channel === true, `mode=${r.rgba_thumb_mode}`)
check(
  '透明图缩略图的 alpha 不是单一值（真保留了信息）',
  typeof r.rgba_alpha_distinct === 'number' && r.rgba_alpha_distinct > 1,
  `distinct=${r.rgba_alpha_distinct}`,
)

// ---- 批量 ----
check('批量 count=2 产出两个 id', JSON.stringify(r.batch_ids) === JSON.stringify(['g3-1', 'g3-2']), JSON.stringify(r.batch_ids))
check(
  '批量落盘为 6 个文件（2×(png+json+thumb)）',
  r.batch_files.length === 6 && r.batch_files.filter((f) => f.endsWith('.thumb.webp')).length === 2,
  r.batch_files.join(','),
)

// ---- 强制 PNG 回退 ----
check('thumb_format=png 时产出 .thumb.png', r.png_fallback_path === 'g4.thumb.png', r.png_fallback_path)
check('thumb_format=png 时媒体类型为 image/png', r.png_fallback_media === 'image/png', String(r.png_fallback_media))

// ---- 日志应当报告格式与占比（便于排障）----
check(
  '日志含缩略图格式与占比',
  r.log_lines.some((l) => /缩略图 (WebP|PNG) \d+ bytes（原图 [\d.]+%）/.test(l)),
  r.log_lines.join(' | ').slice(0, 300),
)

console.log(`\n=== 结果：${pass} 通过，${fail} 失败 ===\n`)
process.exit(fail > 0 ? 1 : 0)
