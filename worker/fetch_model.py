#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
权重下载器（安装器与插件共用）：断点续传 + 国内镜像 + 进度行。

用法：
  python worker/fetch_model.py --local-dir D:/models/Qwen-Image-2.1
  python worker/fetch_model.py --local-dir ... --endpoint https://hf-mirror.com
  python worker/fetch_model.py --local-dir ... --include "transformer/*"   # 补下分片
  python worker/fetch_model.py --list                                      # 只列出文件与体积

设计要点：
- 只依赖 huggingface_hub（装 diffusers 时必然带上）；缺了就给出可照抄的 pip 命令。
- 进度用「扫描目录体积」实现，不依赖 tqdm 回调 —— hf 的进度回调在
  snapshot_download 的多线程下不稳定，扫描法在任何版本都能给出可信数字。
- 断点续传交给 huggingface_hub 的 .incomplete 机制（同一 local-dir 重跑即可）。
"""

import argparse
import json
import os
import sys
import threading
import time


def human(n):
    units = ["B", "KiB", "MiB", "GiB", "TiB"]
    i = 0
    v = float(n)
    while v >= 1024 and i < len(units) - 1:
        v /= 1024.0
        i += 1
    return "%.1f %s" % (v, units[i])


def dir_bytes(path):
    total = 0
    for root, _dirs, files in os.walk(path):
        for f in files:
            try:
                total += os.path.getsize(os.path.join(root, f))
            except OSError:
                pass
    return total


def repo_total_bytes(api, repo, token):
    """仓库总字节数（拿不到就返回 None，不阻断下载）。"""
    try:
        info = api.model_info(repo, files_metadata=True, token=token)
        total = 0
        for s in info.siblings or []:
            size = getattr(s, "size", None)
            if size:
                total += size
        return total or None
    except Exception:  # noqa: BLE001
        return None


def main():
    ap = argparse.ArgumentParser(description="Qwen-Image-2.1 权重下载")
    ap.add_argument("--repo", default="Qwen/Qwen-Image-2.1")
    ap.add_argument("--local-dir", required=True)
    ap.add_argument("--endpoint", default=os.environ.get("HF_ENDPOINT") or "https://hf-mirror.com")
    ap.add_argument("--include", default=None, help="glob，只下匹配文件（补分片用）")
    ap.add_argument("--token", default=os.environ.get("HF_TOKEN"))
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    if args.endpoint:
        os.environ["HF_ENDPOINT"] = args.endpoint
    os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
    os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")

    try:
        from huggingface_hub import HfApi, snapshot_download
    except Exception as exc:  # noqa: BLE001
        print("缺少 huggingface_hub：%s" % exc, file=sys.stderr)
        print("安装：pip install -U huggingface_hub", file=sys.stderr)
        return 2

    api = HfApi(endpoint=args.endpoint or None)
    os.makedirs(args.local_dir, exist_ok=True)

    total = repo_total_bytes(api, args.repo, args.token)
    if args.list:
        try:
            info = api.model_info(args.repo, files_metadata=True, token=args.token)
            files = [(s.rfilename, getattr(s, "size", None)) for s in (info.siblings or [])]
        except Exception as exc:  # noqa: BLE001
            print("列文件失败：%s" % exc, file=sys.stderr)
            return 3
        if args.json:
            print(json.dumps({"repo": args.repo, "files": files, "totalBytes": total}, ensure_ascii=False))
        else:
            for name, size in files:
                print("%-60s %s" % (name, human(size) if size else "?"))
            print("合计 %s" % (human(total) if total else "?"))
        return 0

    print("仓库      %s" % args.repo)
    print("目标目录  %s" % args.local_dir)
    print("端点      %s" % (args.endpoint or "https://huggingface.co（官方）"))
    print("预计体积  %s" % (human(total) if total else "未知"))
    sys.stdout.flush()

    stop = threading.Event()

    def monitor():
        start = time.time()
        last_bytes = dir_bytes(args.local_dir)
        last_time = start
        while not stop.wait(10):
            now_bytes = dir_bytes(args.local_dir)
            now_time = time.time()
            speed = (now_bytes - last_bytes) / max(0.001, now_time - last_time)
            last_bytes, last_time = now_bytes, now_time
            if total:
                pct = 100.0 * now_bytes / total
                print("PROGRESS %s / %s (%.1f%%)  %s/s" % (human(now_bytes), human(total), pct, human(speed)))
            else:
                print("PROGRESS %s  %s/s" % (human(now_bytes), human(speed)))
            sys.stdout.flush()

    thread = threading.Thread(target=monitor, daemon=True)
    thread.start()

    kwargs = {
        "repo_id": args.repo,
        "local_dir": args.local_dir,
        "max_workers": max(1, args.workers),
        "token": args.token,
    }
    if args.include:
        kwargs["allow_patterns"] = [args.include]
    try:
        snapshot_download(**kwargs)
    except TypeError:
        # 老版本 huggingface_hub 不认识某些参数
        kwargs.pop("max_workers", None)
        snapshot_download(**kwargs)
    except Exception as exc:  # noqa: BLE001
        stop.set()
        print("下载失败：%s" % exc, file=sys.stderr)
        print("可重跑同一条命令续传（已下载的分片会被跳过）；或换端点：--endpoint https://huggingface.co", file=sys.stderr)
        return 4
    finally:
        stop.set()

    got = dir_bytes(args.local_dir)
    print("完成：%s 已落盘于 %s" % (human(got), args.local_dir))
    if args.json:
        print(json.dumps({"ok": True, "localDir": args.local_dir, "bytes": got, "totalBytes": total}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
