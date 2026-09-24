"""
Qwen-Image-2.1 推理引擎（diffusers 后端）。

基于 M0 实测标定（见 docs/HARDWARE.md）：
- dtype：sm>=8 → bf16；sm>=6 → **fp16**（P40 实测 10.0 TFLOPS，比 fp32 的 8.6 更快）；
  sm<6 → fp32。bf16 在 sm<80 上必须避免（软件模拟，约半速）。
- offload：空闲显存 >32GB → none；>18GB → **model**（实测峰值 16767 MiB）；否则 sequential。
- vae tiling 恒开（2048² 解码不 OOM 的关键）。
- 首步显著慢（mmap 换入 + 权重上传，1024² 实测 76.5s），稳态 8.77s/步；
  故 ETA 基于稳态外推，且提供 warm 预热。

diffusers 契约要点（读 pipeline_qwenimage21.py 源码确认）：
- `QwenImage21Pipeline.__call__(prompt, image, negative_prompt, true_cfg_scale, height, width,
   num_inference_steps, num_images_per_prompt, generator, output_type, callback_on_step_end,
   callback_on_step_end_tensor_inputs, output_resolution, use_kv_cache)`
- **没有 `mask` 参数** —— 局部编辑走「标注图作为条件图」路径（image 传标注后的图）。
- `true_cfg_scale` 默认 1.0（模型设计为无引导采样）；仅当 >1 且给了 negative_prompt 才生效。
- `callback_on_step_end(self, i, t, kwargs)` **必须返回 dict**（内部对其 .pop()）。
- 取消：在回调内抛异常（`_interrupt` 标志只被重置，循环内不检查）。
- `image` 是一个扁平列表，对该批次所有 prompt 共享，不可按 prompt 嵌套。
"""

from __future__ import annotations

import json
import os
import time
import traceback
from dataclasses import dataclass, field
from typing import Any, Callable, Optional


class CancelledError(Exception):
    """协作取消。"""


@dataclass
class LoadSpec:
    model_dir: str
    device: str = "auto"
    dtype: str = "auto"
    offload: str = "auto"
    vae_tiling: bool = True
    attn_slicing: bool = False
    min_free_mib: int = 1024


@dataclass
class GenSpec:
    prompt: str
    width: int = 1024
    height: int = 1024
    steps: int = 24
    seed: Optional[int] = None
    count: int = 1
    negative_prompt: Optional[str] = None
    true_cfg_scale: float = 1.0
    images: list = field(default_factory=list)  # PIL.Image 条件图（含标注图）
    output_resolution: Optional[int] = None
    transparent: bool = False


# ---------------------------------------------------------------------------
# 设备 / 精度决策
# ---------------------------------------------------------------------------
def resolve_device(requested: str) -> str:
    """'auto' → 空闲显存最多的卡。"""
    import torch

    if not torch.cuda.is_available():
        return "cpu"
    if requested and requested != "auto":
        return requested

    best, best_free = 0, -1
    for i in range(torch.cuda.device_count()):
        free, _ = torch.cuda.mem_get_info(i)
        if free > best_free:
            best, best_free = i, free
    return f"cuda:{best}"


def resolve_dtype(requested: str, device: str) -> str:
    """按 compute capability 决策（M0 标定）。"""
    import torch

    if requested and requested != "auto":
        return requested
    if not device.startswith("cuda") or not torch.cuda.is_available():
        return "fp32"

    major = torch.cuda.get_device_properties(int(device.split(":")[1]) if ":" in device else 0).major
    if major >= 8:
        return "bf16"
    if major >= 6:
        return "fp16"  # M0 实测：P40 fp16 = 10.0 TFLOPS > fp32 8.6
    return "fp32"


def resolve_offload(requested: str, device: str) -> str:
    """按空闲显存决策（M0 标定：model offload 峰值 16.8GB）。"""
    import torch

    if requested and requested != "auto":
        return requested
    if not device.startswith("cuda") or not torch.cuda.is_available():
        return "none"

    idx = int(device.split(":")[1]) if ":" in device else 0
    free, _ = torch.cuda.mem_get_info(idx)
    free_mib = free // (1024 * 1024)
    if free_mib > 32 * 1024:
        return "none"
    if free_mib > 18 * 1024:
        return "model"
    return "sequential"


TORCH_DTYPES = {
    "fp32": "float32",
    "fp16": "float16",
    "bf16": "bfloat16",
}


def _torch_dtype(name: str):
    import torch

    return getattr(torch, TORCH_DTYPES.get(name, "float32"))


def vram_info(device: str) -> dict:
    """
    返回 {free, total, peak} MiB。

    刻意全程防御：/health 是排障入口，任何一步失败都不能让整个端点 500。
    实测教训：卸载（empty_cache + ipc_collect）之后紧接查询显存，
    某些驱动/torch 组合会短暂抛错，若不捕获就会让 /health 返回 500。
    """
    import torch

    out = {"free": None, "total": None, "peak": None}
    try:
        if not device.startswith("cuda") or not torch.cuda.is_available():
            return out
        idx = int(device.split(":")[1]) if ":" in device else 0
    except Exception:
        return out

    try:
        free, total = torch.cuda.mem_get_info(idx)
        out["free"] = free // (1024 * 1024)
        out["total"] = total // (1024 * 1024)
    except Exception:
        pass

    try:
        out["peak"] = torch.cuda.max_memory_allocated(idx) // (1024 * 1024)
    except Exception:
        pass

    return out


def guard_vram(device: str, min_free_mib: int) -> tuple[bool, str]:
    """
    显存守卫：空闲显存不足则拒绝，并给出**具体归因 + 可操作建议**（§6.3）。
    绝不 OOM 崩栈。
    """
    import torch

    if not device.startswith("cuda") or not torch.cuda.is_available():
        return True, "CUDA 不可用，将在 CPU 上推理（极慢）"

    idx = int(device.split(":")[1]) if ":" in device else 0
    free, total = torch.cuda.mem_get_info(idx)
    free_mib = free // (1024 * 1024)
    total_mib = total // (1024 * 1024)

    if free_mib >= min_free_mib:
        return True, f"空闲显存 {free_mib} MiB / {total_mib} MiB"

    # 归因：找出占用显存的进程
    occupiers = _gpu_processes(idx)
    detail = f"空闲显存仅 {free_mib} MiB（总 {total_mib} MiB），低于阈值 {min_free_mib} MiB。"
    if occupiers:
        top = ", ".join(f"{p['name']}(pid {p['pid']}, {p['usedMiB']} MiB)" for p in occupiers[:3])
        detail += f" 检测到占用进程：{top}。"
    detail += " 建议：停止占用进程（如 llama-server）后重试，或把 device 切到其它卡（如 cuda:1）。"
    return False, detail


def _gpu_processes(idx: int) -> list[dict]:
    """通过 nvidia-smi 查询占用指定 GPU 的进程（用于显存归因）。"""
    import subprocess

    try:
        out = subprocess.run(
            [
                "nvidia-smi",
                "--query-compute-apps=pid,process_name,used_memory",
                "--format=csv,noheader,nounits",
                "-i",
                str(idx),
            ],
            capture_output=True,
            text=True,
            timeout=10,
        )
        procs = []
        for line in (out.stdout or "").splitlines():
            parts = [p.strip() for p in line.split(",")]
            if len(parts) >= 3:
                try:
                    procs.append({"pid": int(parts[0]), "name": os.path.basename(parts[1]), "usedMiB": int(parts[2])})
                except ValueError:
                    continue
        return sorted(procs, key=lambda p: -p["usedMiB"])
    except Exception:
        return []


# ---------------------------------------------------------------------------
# 引擎
# ---------------------------------------------------------------------------
class QwenImage21Engine:
    """单例常驻引擎：加载一次，串行推理。"""

    def __init__(self):
        self.pipe = None
        self.device = ""
        self.dtype = ""
        self.offload = ""
        self.model_dir = ""
        self.state = "idle"  # idle | loading | ready | error
        self.error: Optional[str] = None
        self.load_sec: Optional[float] = None
        self._cancel_flags: dict[str, bool] = {}
        self._warmed = False

    # ---- 加载 ----
    def load(self, spec: LoadSpec, log: Callable[[str], None] = print) -> dict:
        import torch
        from diffusers import QwenImage21Pipeline

        if self.state == "ready" and self.model_dir == spec.model_dir:
            return {"loaded": True, "state": self.state, "alreadyLoaded": True}

        self.state = "loading"
        self.error = None

        device = resolve_device(spec.device)
        dtype = resolve_dtype(spec.dtype, device)
        offload = resolve_offload(spec.offload, device)

        log(f"加载 QwenImage21Pipeline：device={device} dtype={dtype} offload={offload}")
        log(f"权重目录：{spec.model_dir}")

        ok, msg = guard_vram(device, spec.min_free_mib)
        if not ok:
            self.state = "error"
            self.error = msg
            log(f"显存守卫拒绝加载：{msg}")
            raise RuntimeError(msg)

        t0 = time.perf_counter()
        try:
            pipe = QwenImage21Pipeline.from_pretrained(
                spec.model_dir,
                torch_dtype=_torch_dtype(dtype),
                low_cpu_mem_usage=True,
            )
            load_sec = time.perf_counter() - t0

            # offload（diffusers 需要 int 设备索引）
            idx = int(device.split(":")[1]) if ":" in device else 0
            if offload == "sequential":
                pipe.enable_sequential_cpu_offload(device=idx)
            elif offload == "model":
                pipe.enable_model_cpu_offload(device=idx)
            else:
                pipe = pipe.to(device)

            if spec.vae_tiling:
                try:
                    pipe.vae.enable_tiling()
                    log("VAE tiling 已启用")
                except Exception as e:
                    log(f"VAE tiling 启用失败（忽略）：{e}")

            if spec.attn_slicing:
                try:
                    pipe.enable_attention_slicing()
                    log("attention slicing 已启用")
                except Exception as e:
                    log(f"attention slicing 启用失败（忽略）：{e}")

            self.pipe = pipe
            self.device = device
            self.dtype = dtype
            self.offload = offload
            self.model_dir = spec.model_dir
            self.load_sec = round(load_sec, 2)
            self.state = "ready"
            log(f"加载完成：{self.load_sec}s，显存 {vram_info(device)}")
            return {"loaded": True, "state": self.state, "loadSec": self.load_sec}
        except Exception as e:
            self.state = "error"
            self.error = f"{type(e).__name__}: {e}"
            log(f"加载失败：{self.error}\n{traceback.format_exc()}")
            raise

    # ---- 卸载 ----
    def unload(self, log: Callable[[str], None] = print) -> dict:
        import gc

        import torch

        self.pipe = None
        self.state = "idle"
        self._warmed = False
        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
            try:
                torch.cuda.ipc_collect()
            except Exception:
                pass
        log("已卸载模型并释放显存")
        return {"unloaded": True, "state": self.state}

    # ---- 取消 ----
    def request_cancel(self, job_id: str) -> bool:
        if job_id in self._cancel_flags:
            self._cancel_flags[job_id] = True
            return True
        return False

    # ---- 预热 ----
    def warm(self, log: Callable[[str], None] = print) -> dict:
        """跑一次极小图，把 mmap/权重上传的冷启动代价提前付掉。"""
        if self.state != "ready":
            return {"warmed": False, "detail": f"worker 未就绪（state={self.state}）"}
        log("预热中（512²/2 步）...")
        t0 = time.perf_counter()
        try:
            self._run(
                GenSpec(prompt="warmup", width=512, height=512, steps=2, seed=0, count=1),
                job_id="__warm__",
                on_progress=None,
                log=log,
            )
            self._warmed = True
            sec = round(time.perf_counter() - t0, 2)
            log(f"预热完成：{sec}s")
            return {"warmed": True, "sec": sec}
        except Exception as e:
            log(f"预热失败（忽略）：{e}")
            return {"warmed": False, "detail": str(e)}

    # ---- 推理 ----
    def run(
        self,
        spec: GenSpec,
        job_id: str,
        on_progress: Optional[Callable[[dict], None]] = None,
        log: Callable[[str], None] = print,
    ) -> dict:
        if self.state != "ready" or self.pipe is None:
            raise RuntimeError(f"worker 未就绪（state={self.state}）。请先加载模型。")

        ok, msg = guard_vram(self.device, 1024)
        if not ok:
            raise RuntimeError(f"显存不足，已拒绝本次推理。{msg}")

        self._cancel_flags[job_id] = False
        try:
            return self._run(spec, job_id, on_progress, log)
        finally:
            self._cancel_flags.pop(job_id, None)

    def _run(
        self,
        spec: GenSpec,
        job_id: str,
        on_progress: Optional[Callable[[dict], None]],
        log: Callable[[str], None],
    ) -> dict:
        import torch

        prompt = spec.prompt
        if spec.transparent:
            prompt = _apply_rgba_template(prompt)

        # 采样器参数
        width = _align(spec.width)
        height = _align(spec.height)
        seed = spec.seed if spec.seed is not None else int(torch.randint(0, 2**31 - 1, (1,)).item())

        gen = torch.Generator(device="cpu").manual_seed(seed)

        # 条件图（多参考 / 标注图）
        condition = spec.images if spec.images else None

        kwargs: dict[str, Any] = {
            "prompt": prompt,
            "width": width,
            "height": height,
            "num_inference_steps": int(spec.steps),
            "num_images_per_prompt": int(spec.count),
            "generator": gen,
            "output_type": "pil",
            "output_resolution": int(spec.output_resolution or max(width, height)),
        }
        if condition is not None:
            kwargs["image"] = condition
        # true_cfg_scale 仅在 >1 且给了负面提示时才启用（模型设计为无引导采样）
        if spec.true_cfg_scale and spec.true_cfg_scale > 1.0:
            kwargs["true_cfg_scale"] = float(spec.true_cfg_scale)
            if spec.negative_prompt:
                kwargs["negative_prompt"] = spec.negative_prompt

        # 逐步进度 + 取消
        step_times: list[float] = []
        last = [time.perf_counter()]
        started = time.perf_counter()
        # 记录「最后一次 step 回调」的时刻：pipe() 返回后，其后的耗时即 VAE 解码 + 后处理。
        # 实测这一块在 512² 约 19s、1024² 约 26s，是 ETA 模型里不能忽略的固定项。
        last_step_at = [None]

        def on_step_end(pipe, i, t, cb_kwargs):
            now = time.perf_counter()
            step_times.append(now - last[0])
            last[0] = now
            last_step_at[0] = now

            if self._cancel_flags.get(job_id):
                raise CancelledError("用户取消")

            if on_progress is not None:
                elapsed_ms = int((now - started) * 1000)
                # ETA 基于**稳态步**外推（首步含 mmap 换入，不可用于外推）
                steady = step_times[1:] if len(step_times) > 1 else step_times
                avg = sum(steady) / len(steady) if steady else 0
                remaining = max(0, int(spec.steps) - (i + 1))
                on_progress(
                    {
                        "step": i + 1,
                        "total": int(spec.steps),
                        "elapsedMs": elapsed_ms,
                        "etaMs": int(avg * remaining * 1000) if avg else None,
                        "steadyStepMs": int(avg * 1000) if avg else None,
                        "peakVramMiB": vram_info(self.device).get("peak"),
                    }
                )
            # 契约要求：必须返回 dict（内部会 .pop()）
            return cb_kwargs

        kwargs["callback_on_step_end"] = on_step_end
        kwargs["callback_on_step_end_tensor_inputs"] = ["latents"]

        log(f"开始推理：{width}x{height} {spec.steps} 步 seed={seed} count={spec.count}"
            f"{' 条件图 ' + str(len(condition)) + ' 张' if condition else ''}")

        try:
            out = self.pipe(**kwargs)
        except CancelledError:
            log("推理已被用户取消")
            raise

        elapsed = time.perf_counter() - started
        images = out.images

        steady = step_times[1:] if len(step_times) > 1 else step_times
        avg_steady = round(sum(steady) / len(steady), 3) if steady else None

        # 最后一次 step 回调之后的时间 = VAE 解码 + 图像后处理（固定开销）
        vae_sec = None
        if last_step_at[0] is not None:
            vae_sec = round(time.perf_counter() - last_step_at[0], 2)

        return {
            "images": images,
            "width": width,
            "height": height,
            "steps": int(spec.steps),
            "seed": seed,
            "count": len(images),
            "elapsedSec": round(elapsed, 2),
            "firstStepSec": round(step_times[0], 3) if step_times else None,
            "steadyStepSec": avg_steady,
            "vaeDecodeSec": vae_sec,
            "peakVramMiB": vram_info(self.device).get("peak"),
            "device": self.device,
            "dtype": self.dtype,
            "offload": self.offload,
            "transparent": bool(spec.transparent),
            "usedReferences": len(condition) if condition else 0,
        }


def _align(value: int, multiple: int = 32) -> int:
    """尺寸对齐到 32 的倍数（VAE 16× 压缩 + patch 要求）。"""
    v = int(value)
    return max(multiple, (v // multiple) * multiple)


def _apply_rgba_template(prompt: str) -> str:
    """透明图提示词模板（PLAN §1.3 官方建议）。"""
    return (
        "This is an RGBA image with transparency. "
        f"{prompt}. "
        "The image has alpha channel and the background is transparent."
    )


def save_outputs(
    result: dict,
    out_dir: str,
    image_id: str,
    meta: dict,
    thumb_max: int = 384,
    thumb_format: str = "webp",
    thumb_quality: int = 82,
    log: Callable[[str], None] = print,
) -> list[dict]:
    """
    落盘 PNG（保留 alpha）+ 同名 .json sidecar（§6.5）+ **缩略图**。

    缩略图在这里生成而不是宿主侧按需生成，理由：
      - PIL 已经在本进程里（保存 PNG 就要用它），**零新增依赖**；
      - 生成一次即可，之后「历史相册」网格直接取缩略图，不必每次拉整张原图；
      - 宿主侧没有图像库，Node 标准库也不做缩放，按需生成会引入 native 依赖或
        每张一次的子进程开销。

    格式选择（实测定量）：
      1024² 原图 PNG ≈ 902 KB；384 长边缩略图 **PNG ≈ 212 KB（23.6%）**、
      **WebP(q82) ≈ 30 KB（3%）**。PNG 是无损格式，照片类内容压不动 ——
      对「网格里几十张一起扫」的相册来说 6× 的差距很明显（解码与内存同样受益）。
      WebP 同时支持 alpha，所以透明图也用它，无需按有无 alpha 分两种格式。

    写入失败（例如本机 Pillow 缺 WebP 支持）自动回退 PNG，不影响出图。
    返回每张图的 {id, file, sidecar, thumb, thumbMediaType, width, height, bytes, thumbBytes, hasAlpha}。
    """
    os.makedirs(out_dir, exist_ok=True)

    # PIL 在本模块里是按需导入的（保存本来就要用），这里显式取一次用于
    # 探测 WebP 编码支持 —— 注意别漏 import，否则会静默走回退分支（踩过一次）。
    from PIL import Image, features  # noqa: PLC0415

    webp_ok = False
    try:
        webp_ok = bool(features.check("webp"))
    except Exception:
        webp_ok = False

    saved = []
    for i, img in enumerate(result["images"]):
        suffix = "" if len(result["images"]) == 1 else f"-{i + 1}"
        img_id = f"{image_id}{suffix}"
        png_path = os.path.join(out_dir, f"{img_id}.png")
        sidecar_path = os.path.join(out_dir, f"{img_id}.json")

        img.save(png_path, format="PNG")  # 原图始终 PNG，保留 RGBA

        # 缩略图：等比缩放到长边 ≤ thumb_max。
        # WebP 优先（体积约为 PNG 的 1/6，且同样支持 alpha）；
        # 本机 Pillow 缺 WebP 时回退 PNG；WebP 写入若因任何原因失败，再试一次 PNG。
        thumb_path: str | None = None
        thumb_media: str | None = None
        try:
            thumb = img.copy()
            thumb.thumbnail((thumb_max, thumb_max))  # in-place，保持宽高比

            if thumb_format.lower() == "webp" and webp_ok:
                candidate = os.path.join(out_dir, f"{img_id}.thumb.webp")
                try:
                    thumb.save(candidate, format="WEBP", quality=thumb_quality, method=4)
                    thumb_path, thumb_media = candidate, "image/webp"
                except Exception as e:  # noqa: BLE001
                    log(f"WebP 缩略图写入失败，回退 PNG：{e}")

            if thumb_path is None:
                candidate = os.path.join(out_dir, f"{img_id}.thumb.png")
                thumb.save(candidate, format="PNG", optimize=True)
                thumb_path, thumb_media = candidate, "image/png"
        except Exception as e:  # noqa: BLE001
            log(f"缩略图生成失败（不影响出图，相册会回退原图）：{e}")
            thumb_path, thumb_media = None, None

        has_alpha = img.mode in ("RGBA", "LA") or (img.mode == "P" and "transparency" in img.info)
        sidecar = {
            "id": img_id,
            "file": png_path,
            "thumb": thumb_path,
            "thumbMediaType": thumb_media,
            "width": img.size[0],
            "height": img.size[1],
            "mode": img.mode,
            "hasAlpha": has_alpha,
            "bytes": os.path.getsize(png_path),
            "thumbBytes": os.path.getsize(thumb_path) if thumb_path else None,
            "seed": result["seed"],
            "steps": result["steps"],
            "elapsedSec": result["elapsedSec"],
            "firstStepSec": result.get("firstStepSec"),
            "steadyStepSec": result.get("steadyStepSec"),
            "peakVramMiB": result.get("peakVramMiB"),
            "device": result.get("device"),
            "dtype": result.get("dtype"),
            "offload": result.get("offload"),
            "usedReferences": result.get("usedReferences", 0),
            "createdAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
            **meta,
        }
        with open(sidecar_path, "w", encoding="utf-8") as f:
            json.dump(sidecar, f, ensure_ascii=False, indent=2)

        saved.append(
            {
                "id": img_id,
                "file": png_path,
                "sidecar": sidecar_path,
                "thumb": thumb_path,
                "thumbMediaType": thumb_media,
                "width": sidecar["width"],
                "height": sidecar["height"],
                "bytes": sidecar["bytes"],
                "thumbBytes": sidecar["thumbBytes"],
                "hasAlpha": has_alpha,
            }
        )
        if thumb_path:
            pct = sidecar["thumbBytes"] / sidecar["bytes"] * 100
            fmt = "WebP" if thumb_media == "image/webp" else "PNG"
            extra = f"，缩略图 {fmt} {sidecar['thumbBytes']} bytes（原图 {pct:.1f}%）"
        else:
            extra = "（无缩略图）"
        log(f"已保存 {png_path}（{sidecar['width']}x{sidecar['height']}, {sidecar['bytes']} bytes{extra}）")

    return saved
