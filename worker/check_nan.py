"""
M0 严格有效性检验：直接检查 uint8 转换前的浮点张量。

diffusers 的 image_processor 会打印
  RuntimeWarning: invalid value encountered in cast
说明在 (images * 255).round().astype("uint8") 时存在非有限值。
本脚本 hook 该转换点，精确统计 NaN / Inf 的数量与空间分布，
从而判定 fp16 是否真的损害图像质量。

用法：
  python worker/check_nan.py --dtype fp16 --size 512 --steps 8
"""

import argparse
import json
import os
import sys
import time
import warnings

import numpy as np

# 缺省权重目录：$DSH_QWEN_MODEL_DIR > $DSH_HOME/models/Qwen-Image-2.1 > ~/.dsh/models/Qwen-Image-2.1
# （刻意不写死任何人的本机路径，换台机器直接能跑）
DEFAULT_MODEL_DIR = os.environ.get("DSH_QWEN_MODEL_DIR") or os.path.join(
    os.environ.get("DSH_HOME") or os.path.join(os.path.expanduser("~"), ".dsh"),
    "models",
    "Qwen-Image-2.1",
)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-dir", default=DEFAULT_MODEL_DIR)
    parser.add_argument("--dtype", default="fp16")
    parser.add_argument("--size", type=int, default=512)
    parser.add_argument("--steps", type=int, default=8)
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()

    import torch
    from diffusers import QwenImage21Pipeline
    import diffusers.image_processor as ip

    dtype_map = {"fp32": torch.float32, "fp16": torch.float16, "bf16": torch.bfloat16}
    torch_dtype = dtype_map[args.dtype]

    report = {"dtype": args.dtype, "size": args.size, "steps": args.steps, "seed": args.seed}

    # ---- hook 转换点：捕获 uint8 转换前的浮点张量 ----
    captured = {}
    orig_numpy_to_pil = ip.numpy_to_pil

    def spy_numpy_to_pil(images):
        arr = np.asarray(images)
        captured["shape"] = list(arr.shape)
        captured["dtype"] = str(arr.dtype)
        captured["nanCount"] = int(np.isnan(arr).sum())
        captured["infCount"] = int(np.isinf(arr).sum())
        captured["totalElements"] = int(arr.size)
        finite = np.isfinite(arr)
        captured["nonFinitePct"] = round(100.0 * (~finite).sum() / arr.size, 6)
        if finite.any():
            fv = arr[finite]
            captured["finiteMin"] = round(float(fv.min()), 5)
            captured["finiteMax"] = round(float(fv.max()), 5)
            captured["outOfRangeLow"] = int((fv < 0).sum())
            captured["outOfRangeHigh"] = int((fv > 1).sum())
        # NaN 的空间分布
        if captured["nanCount"] > 0:
            nan_mask = np.isnan(arr)
            if arr.ndim == 4:  # (N, H, W, C)
                per_channel = nan_mask.sum(axis=(0, 1, 2)).tolist()
                nan_h, nan_w = np.where(nan_mask[0, :, :, 0])
                captured["nanPerChannel"] = per_channel
                captured["nanBBox"] = {
                    "minH": int(nan_h.min()), "maxH": int(nan_h.max()),
                    "minW": int(nan_w.min()), "maxW": int(nan_w.max()),
                } if len(nan_h) else None
                captured["nanRows"] = int(len(np.unique(nan_h)))
        return orig_numpy_to_pil(images)

    ip.numpy_to_pil = spy_numpy_to_pil

    print(f"加载 pipeline（{args.dtype}）...", file=sys.stderr, flush=True)
    pipe = QwenImage21Pipeline.from_pretrained(args.model_dir, torch_dtype=torch_dtype, low_cpu_mem_usage=True)
    pipe.enable_model_cpu_offload(device=0)
    try:
        pipe.vae.enable_tiling()
    except Exception:
        pass

    print(f"推理 {args.size}² / {args.steps} 步（捕获警告）...", file=sys.stderr, flush=True)
    gen = torch.Generator(device="cpu").manual_seed(args.seed)
    with warnings.catch_warnings(record=True) as wlist:
        warnings.simplefilter("always")
        t0 = time.perf_counter()
        out = pipe(
            prompt="a red apple on a wooden table, photorealistic, sharp focus",
            width=args.size,
            height=args.size,
            num_inference_steps=args.steps,
            generator=gen,
        )
        report["genSec"] = round(time.perf_counter() - t0, 2)
        report["warnings"] = [
            {"category": w.category.__name__, "message": str(w.message)[:200]}
            for w in wlist
            if "invalid value" in str(w.message).lower()
        ]

    report["preCast"] = captured

    # 最终图像统计
    arr = np.asarray(out.images[0])
    rgb = arr[..., :3]
    report["finalImage"] = {
        "shape": list(arr.shape),
        "uniqueColors": int(len(np.unique(rgb.reshape(-1, 3), axis=0))),
        "rgbMean": round(float(rgb.mean()), 2),
        "rgbStd": round(float(rgb.std()), 2),
        "allBlack": bool(rgb.max() == 0),
    }

    # 判定
    cap = captured
    nan = cap.get("nanCount", 0)
    total = cap.get("totalElements", 1)
    pct = cap.get("nonFinitePct", 0.0)
    if nan == 0 and cap.get("infCount", 0) == 0:
        verdict = "clean"
        note = "无 NaN/Inf —— fp16 完全干净"
    elif pct < 0.001:
        verdict = "negligible"
        note = f"非有限值占比 {pct}%（{nan} 个 / {total}），属边界舍入，视觉不可见"
    elif pct < 0.1:
        verdict = "minor"
        note = f"非有限值占比 {pct}%，可能有轻微伪影，需目视复核"
    else:
        verdict = "corrupt"
        note = f"非有限值占比 {pct}%，图像已损坏"
    report["verdict"] = verdict
    report["verdictNote"] = note

    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
