"""
M0 图像有效性验证（判断 fp16 在 P40 上是否产生 NaN/坏图）。

对给定 dtype 生成一张图，输出像素统计并落盘，便于人工核对。
用法：
  python worker/verify_image.py --dtype fp16 --size 512 --steps 4
"""

import argparse
import json
import os
import sys
import time

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
    parser.add_argument("--steps", type=int, default=4)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--offload", default="model")
    parser.add_argument("--out", default="")
    args = parser.parse_args()

    import torch
    from diffusers import QwenImage21Pipeline

    dtype_map = {"fp32": torch.float32, "fp16": torch.float16, "bf16": torch.bfloat16}
    torch_dtype = dtype_map[args.dtype]

    report = {"dtype": args.dtype, "size": args.size, "steps": args.steps, "seed": args.seed}

    print(f"加载 pipeline（{args.dtype}）...", file=sys.stderr, flush=True)
    t0 = time.perf_counter()
    pipe = QwenImage21Pipeline.from_pretrained(args.model_dir, torch_dtype=torch_dtype, low_cpu_mem_usage=True)
    if args.offload == "model":
        pipe.enable_model_cpu_offload(device=0)
    elif args.offload == "sequential":
        pipe.enable_sequential_cpu_offload(device=0)
    else:
        pipe = pipe.to("cuda:0")
    try:
        pipe.vae.enable_tiling()
    except Exception:
        pass
    report["loadSec"] = round(time.perf_counter() - t0, 2)

    print(f"推理 {args.size}² / {args.steps} 步 ...", file=sys.stderr, flush=True)
    gen = torch.Generator(device="cpu").manual_seed(args.seed)
    t0 = time.perf_counter()
    out = pipe(
        prompt="a red apple on a wooden table, photorealistic, sharp focus",
        width=args.size,
        height=args.size,
        num_inference_steps=args.steps,
        generator=gen,
    )
    report["genSec"] = round(time.perf_counter() - t0, 2)

    img = out.images[0]
    arr = np.asarray(img)
    report["mode"] = img.mode
    report["shape"] = list(arr.shape)
    report["dtype"] = str(arr.dtype)

    # 像素统计（只对 RGB(A) 通道，排除 alpha 全 0 的干扰）
    rgb = arr[..., :3]
    report["rgbMin"] = int(rgb.min())
    report["rgbMax"] = int(rgb.max())
    report["rgbMean"] = round(float(rgb.mean()), 2)
    report["rgbStd"] = round(float(rgb.std()), 2)
    report["uniqueColors"] = int(len(np.unique(rgb.reshape(-1, 3), axis=0)))
    report["allBlack"] = bool(rgb.max() == 0)
    report["allWhite"] = bool(rgb.min() == 255)

    # NaN / Inf 检查（在 uint8 之前无法直接看，改查灰度直方图是否退化）
    hist = np.histogram(rgb, bins=16, range=(0, 255))[0]
    report["histogram16"] = hist.tolist()

    # alpha 通道统计
    if arr.shape[-1] == 4:
        alpha = arr[..., 3]
        report["alphaMin"] = int(alpha.min())
        report["alphaMax"] = int(alpha.max())
        report["alphaMean"] = round(float(alpha.mean()), 2)
        report["alphaUnique"] = int(len(np.unique(alpha)))

    out_path = args.out or os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        "outputs",
        f"m0-verify-{args.dtype}-{args.size}.png",
    )
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    img.save(out_path)
    report["savedTo"] = out_path
    report["fileBytes"] = os.path.getsize(out_path)

    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
