"""
Qwen-Image-2.1 worker 依赖自检与安装建议（§6.7）。
自检：
- python 版本 >= 3.10
- torch / transformers / diffusers / accelerate 安装情况
- diffusers 是否含 QwenImage21Pipeline（锁定 commit）

缺失时打印缺失依赖与安装命令。
支持两种模式：
- 独立 venv（默认）：python -m venv .venv && .venv\\Scripts\\activate && pip install ...
- 复用系统 python：pip install --system-site-packages ...
"""

import subprocess
import sys
import os


REQUIRED = ["torch", "transformers", "diffusers", "accelerate", "pillow"]

# diffusers 锁定：含 QwenImage21Pipeline 的 commit（PR #14804 之后）
DIFFUSERS_URL = "git+https://github.com/huggingface/diffusers.git"


def check_import(mod: str):
    try:
        m = __import__(mod)
        return getattr(m, "__version__", "unknown")
    except Exception:
        return None


def main():
    print("=== Qwen-Image-2.1 worker 依赖自检 ===\n")

    print(f"Python: {sys.version.split()[0]} ({sys.executable})")
    if sys.version_info < (3, 10):
        print("⚠️ Python >= 3.10 才支持")

    print("\n已安装：")
    missing = []
    for mod in REQUIRED:
        ver = check_import(mod)
        if ver:
            print(f"  ✓ {mod} {ver}")
        else:
            print(f"  ✗ {mod} 未安装")
            missing.append(mod)

    # diffusers 是否含 QwenImage21Pipeline
    diffusers_ver = check_import("diffusers")
    if diffusers_ver:
        try:
            from diffusers import QwenImage21Pipeline  # noqa: F401
            print("  ✓ diffusers 含 QwenImage21Pipeline")
        except Exception:
            print("  ✗ diffusers 版本不含 QwenImage21Pipeline（需主分支/锁定 commit）")
            missing.append("diffusers@latest")

    if missing:
        print("\n=== 安装建议 ===")
        venv = os.path.join(os.path.dirname(__file__), "..", "venv")
        if os.path.isdir(venv):
            print("\n检测到 venv，先激活：")
            print(f"  . {venv}\\Scripts\\activate   (Windows)")
            print(f"  source {venv}/bin/activate  (Unix)")
        print("\n安装命令：")
        print(f"  pip install {DIFFUSERS_URL}")
        print("  pip install accelerate pillow")
        print("\n或锁定 commit 安装（推荐，避免主分支漂移）：")
        print(f"  pip install git+https://github.com/huggingface/diffusers.git@<commit>")
        sys.exit(1)
    else:
        print("\n✓ 依赖齐全，可启动 worker：")
        print("  python worker/server.py --model-dir <dir> --port <port>")


if __name__ == "__main__":
    main()
