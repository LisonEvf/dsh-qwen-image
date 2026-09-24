#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
环境体检报告（安装器与排障共用）。

与 worker/model_check.py 的分工：
  model_check.py  —— 只查**权重**（纯标准库，任何 python 都能跑）
  env_report.py   —— 只查**运行环境**（torch / diffusers / 显卡 / site-packages 复用）

用法：
  python worker/env_report.py                     # 人类可读
  python worker/env_report.py --json               # 机器可读（安装器内部用）
  python worker/env_report.py --quick              # 不导入 torch（快很多）

设计约束：**永不抛异常**。所有 import 都包在 try 里，
缺什么就报什么 —— 它存在的意义就是在环境坏掉的时候还能说出话来。
"""

import argparse
import json
import os
import sys


def _try(fn, default=None):
    try:
        return fn()
    except Exception as exc:  # noqa: BLE001
        return default if default is not None else ("!error: " + str(exc)[:200])


def ver(name):
    """取模块版本，未安装返回 None。"""
    try:
        mod = __import__(name)
        return getattr(mod, "__version__", "?")
    except Exception:  # noqa: BLE001
        return None


def collect(quick=False, model_dir=None):
    report = {
        "python": {
            "executable": sys.executable,
            "version": "%d.%d.%d" % sys.version_info[:3],
            "isVenv": sys.prefix != getattr(sys, "base_prefix", sys.prefix),
            "prefix": sys.prefix,
        },
        "packages": {},
        "gpu": {"cudaAvailable": False, "devices": []},
        "reusePaths": [],
        "problems": [],
        "advice": [],
    }

    for name in ("torch", "diffusers", "transformers", "accelerate", "huggingface_hub", "safetensors", "numpy"):
        report["packages"][name] = ver(name)
    report["packages"]["pillow"] = ver("PIL")

    # site-packages 复用（安装器会把「借来的」site-packages 写成 .pth）
    try:
        import site

        for p in sys.path:
            if p.endswith("site-packages") and p not in site.getsitepackages():
                report["reusePaths"].append(p)
    except Exception:  # noqa: BLE001
        pass

    if not quick and report["packages"]["torch"]:
        try:
            import torch

            report["packages"]["torch"] = torch.__version__
            report["gpu"]["cudaAvailable"] = bool(torch.cuda.is_available())
            report["gpu"]["torchCuda"] = getattr(torch.version, "cuda", None)
            report["gpu"]["deviceCount"] = torch.cuda.device_count()
            if torch.cuda.is_available():
                for i in range(torch.cuda.device_count()):
                    entry = {
                        "index": i,
                        "name": torch.cuda.get_device_name(i),
                        "capability": list(torch.cuda.get_device_capability(i)),
                    }
                    try:
                        free, total = torch.cuda.mem_get_info(i)
                        entry["freeMiB"] = int(free // (1024 * 1024))
                        entry["totalMiB"] = int(total // (1024 * 1024))
                    except Exception:  # noqa: BLE001
                        pass
                    report["gpu"]["devices"].append(entry)
        except Exception as exc:  # noqa: BLE001
            report["problems"].append("import torch 失败：" + str(exc)[:200])

    if not quick and report["packages"]["diffusers"]:
        try:
            from diffusers import QwenImage21Pipeline  # noqa: F401

            report["packages"]["hasQwenImage21"] = True
        except Exception:  # noqa: BLE001
            report["packages"]["hasQwenImage21"] = False
            report["problems"].append("当前 diffusers 不含 QwenImage21Pipeline（需要主分支 / 锁定 commit）")

    # ── 判定 ──
    if not report["packages"]["torch"]:
        report["problems"].append("未安装 torch")
        report["advice"].append("安装：pip install torch --index-url https://download.pytorch.org/whl/cu128")
    elif not quick and not report["gpu"]["cudaAvailable"]:
        report["advice"].append("torch 看不到 CUDA：可能是装了 CPU 版轮子，或显卡驱动过旧")
    if not report["packages"]["diffusers"]:
        report["problems"].append("未安装 diffusers")
    if not report["packages"]["accelerate"]:
        report["advice"].append("未安装 accelerate：显存 offload 不可用，可能 OOM")

    if model_dir:
        try:
            sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
            import model_check

            report["model"] = model_check.check_model_dir(model_dir)
        except Exception as exc:  # noqa: BLE001
            report["problems"].append("权重体检失败：" + str(exc)[:200])

    report["ok"] = (
        bool(report["packages"]["torch"])
        and bool(report["packages"]["diffusers"])
        and report["packages"].get("hasQwenImage21", True)
    )
    return report


def main():
    ap = argparse.ArgumentParser(description="Qwen-Image-2.1 环境体检")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--quick", action="store_true")
    ap.add_argument("--model-dir", default=None)
    args = ap.parse_args()

    report = collect(quick=args.quick, model_dir=args.model_dir)
    if args.json:
        print("<<<ENVREPORT>>>" + json.dumps(report, ensure_ascii=False))
        return 0

    print("=== Qwen-Image-2.1 环境体检 ===")
    print("Python      %s (%s)" % (report["python"]["version"], report["python"]["executable"]))
    for name, value in report["packages"].items():
        flag = "ok  " if value else "MISS"
        print("%-14s %s %s" % (name, flag, value if value is not None else "未安装"))
    if report["gpu"]["devices"]:
        for d in report["gpu"]["devices"]:
            print("GPU %-10s %s  capability=%s  空闲=%s MiB" % (
                d.get("index"), d.get("name"), d.get("capability"), d.get("freeMiB")))
    elif not args.quick:
        print("GPU         没有可用的 CUDA 设备")
    if report["reusePaths"]:
        print("复用 site-packages：%s" % ", ".join(report["reusePaths"]))
    for p in report["problems"]:
        print("问题：%s" % p)
    for a in report["advice"]:
        print("建议：%s" % a)
    print("结论：%s" % ("可运行" if report["ok"] else "尚不可运行"))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
