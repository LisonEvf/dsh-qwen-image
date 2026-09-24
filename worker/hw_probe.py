"""
M0 硬件标定探针（§9 M0）。

注意：diffusers 的 enable_*_cpu_offload(device=...) 与部分 torch.cuda API
需要 int 设备索引，故统一用 device_index() 归一化。

用途：采集每张卡的算力/显存事实，标定 dtype/device/offload 与尺寸档位。

模式：
  --microbench   快速微基准：裸 matmul 测 fp32/fp16/bf16 TFLOPS（不加载模型，秒级）
  --env          环境盘点（版本/GPU/显存）
  --load         尝试加载 pipeline（按 --device/--dtype/--offload），测加载耗时与显存
  --calibrate    完整标定：加载一次，跑多尺寸，测秒/步与峰值显存
  --all          以上全部

输出：JSON（stdout）+ 人类可读报告（stderr）
"""

import argparse
import gc
import json
import os
import sys
import time
import traceback

# 缺省权重目录：$DSH_QWEN_MODEL_DIR > $DSH_HOME/models/Qwen-Image-2.1 > ~/.dsh/models/Qwen-Image-2.1
# （刻意不写死任何人的本机路径，换台机器直接能跑）
MODEL_DIR_DEFAULT = os.environ.get("DSH_QWEN_MODEL_DIR") or os.path.join(
    os.environ.get("DSH_HOME") or os.path.join(os.path.expanduser("~"), ".dsh"),
    "models",
    "Qwen-Image-2.1",
)


def device_index(device: str) -> int:
    """把 'cuda:0' / 'cuda' / '0' 归一化为 int 索引。"""
    if not device or device == "cpu":
        return 0
    if ":" in device:
        try:
            return int(device.split(":")[1])
        except (ValueError, IndexError):
            return 0
    try:
        return int(device)
    except ValueError:
        return 0


def cuda_reset_peak(device: str) -> None:
    """
    复位峰值显存统计。

    注意（torch 2.7.1 实测）：在 CUDA context 刚初始化时，首次调用带 int 设备参数的
    reset_peak_memory_stats 会抛 "Invalid device argument"；先用 set_device 固定当前
    设备再调用无参形式则稳定可用。故此处统一走无参路径。
    """
    import torch

    if not device.startswith("cuda"):
        return
    try:
        torch.cuda.set_device(device_index(device))
        torch.cuda.empty_cache()
        torch.cuda.reset_peak_memory_stats()
    except Exception:
        pass


def cuda_peak_mib(device: str) -> int:
    """读取当前设备峰值显存分配（MiB）。"""
    import torch

    if not device.startswith("cuda"):
        return 0
    try:
        torch.cuda.set_device(device_index(device))
        return torch.cuda.max_memory_allocated() // (1024 * 1024)
    except Exception:
        return 0


def cuda_free_mib(device: str) -> int:
    """读取当前设备空闲显存（MiB）。"""
    import torch

    if not device.startswith("cuda"):
        return 0
    try:
        free, _ = torch.cuda.mem_get_info(device_index(device))
        return free // (1024 * 1024)
    except Exception:
        return 0


# ---------------------------------------------------------------------------
# 环境盘点
# ---------------------------------------------------------------------------
def probe_env() -> dict:
    import torch

    env = {
        "python": sys.version.split()[0],
        "executable": sys.executable,
        "torch": torch.__version__,
        "cuda_available": torch.cuda.is_available(),
        "cuda_version": torch.version.cuda,
        "cudnn": torch.backends.cudnn.version() if torch.backends.cudnn.is_available() else None,
        "gpu_count": torch.cuda.device_count(),
        "gpus": [],
    }

    for i in range(torch.cuda.device_count()):
        props = torch.cuda.get_device_properties(i)
        free, total = torch.cuda.mem_get_info(i)
        env["gpus"].append({
            "index": i,
            "name": props.name,
            "sm": f"{props.major}.{props.minor}",
            "smMajor": props.major,
            "totalMiB": total // (1024 * 1024),
            "freeMiB": free // (1024 * 1024),
            "multiProcessorCount": props.multi_processor_count,
            "supportsBf16": props.major >= 8,
        })

    try:
        import transformers
        env["transformers"] = transformers.__version__
    except Exception:
        env["transformers"] = None

    try:
        import diffusers
        env["diffusers"] = getattr(diffusers, "__version__", "unknown")
        env["diffusers_commit"] = getattr(diffusers, "__git_commit__", None)
        try:
            from diffusers import QwenImage21Pipeline  # noqa: F401
            env["hasQwenImage21Pipeline"] = True
        except Exception as e:
            env["hasQwenImage21Pipeline"] = False
            env["pipelineError"] = str(e)
    except Exception as e:
        env["diffusers"] = None
        env["diffusersError"] = str(e)

    try:
        import accelerate
        env["accelerate"] = accelerate.__version__
    except Exception:
        env["accelerate"] = None

    return env


# ---------------------------------------------------------------------------
# 微基准：裸 matmul 算力
# ---------------------------------------------------------------------------
def microbench(dtype_name: str, device: str, size: int = 4096, iters: int = 20) -> dict:
    """
    用 size×size 的方阵 matmul 测实际 TFLOPS。
    这是回答「P40 的 fp16 能不能用」的最快方式。
    """
    import torch

    dtype_map = {
        "fp32": torch.float32,
        "fp16": torch.float16,
        "bf16": torch.bfloat16,
    }
    dtype = dtype_map[dtype_name]
    result = {"dtype": dtype_name, "device": device, "size": size, "iters": iters}

    try:
        if device.startswith("cuda") and not torch.cuda.is_available():
            result["error"] = "CUDA 不可用"
            return result

        if dtype_name == "bf16":
            props = torch.cuda.get_device_properties(int(device.split(":")[1]) if ":" in device else 0)
            if props.major < 8:
                result["skipped"] = f"sm_{props.major}{props.minor} 无原生 bf16（仍会尝试，结果仅供参考）"

        torch.cuda.empty_cache()

        a = torch.randn(size, size, dtype=dtype, device=device)
        b = torch.randn(size, size, dtype=dtype, device=device)

        # warmup
        for _ in range(3):
            c = a @ b
        if device.startswith("cuda"):
            torch.cuda.synchronize()

        t0 = time.perf_counter()
        for _ in range(iters):
            c = a @ b
        if device.startswith("cuda"):
            torch.cuda.synchronize()
        elapsed = time.perf_counter() - t0

        flops = 2.0 * size**3 * iters
        result["elapsedSec"] = round(elapsed, 4)
        result["tflops"] = round(flops / elapsed / 1e12, 3)

        del a, b, c
        torch.cuda.empty_cache()
    except Exception as e:
        result["error"] = f"{type(e).__name__}: {e}"

    return result


def run_microbench(gpus: list) -> dict:
    """对每张卡测 fp32/fp16/bf16 算力。"""
    out = {"devices": []}
    for g in gpus:
        dev = f"cuda:{g['index']}"
        entry = {"index": g["index"], "name": g["name"], "sm": g["sm"], "results": []}
        for dt in ["fp32", "fp16", "bf16"]:
            r = microbench(dt, dev)
            entry["results"].append(r)
            status = r.get("error") or f"{r.get('tflops', '?')} TFLOPS"
            print(f"  [{g['name']}] {dt}: {status}", file=sys.stderr, flush=True)
        out["devices"].append(entry)
    return out


# ---------------------------------------------------------------------------
# Pipeline 加载与推理
# ---------------------------------------------------------------------------
def load_pipeline(model_dir: str, device: str, dtype: str, offload: str, vae_tiling: bool = True) -> dict:
    """
    加载 QwenImage21Pipeline。返回 {pipe, loadSec, peakVramMiB, dtype, device, offload}。
    异常时抛错，由调用方捕获。
    """
    import torch
    from diffusers import QwenImage21Pipeline

    dtype_map = {"fp32": torch.float32, "fp16": torch.float16, "bf16": torch.bfloat16}
    torch_dtype = dtype_map[dtype]
    dev_idx = device_index(device)

    cuda_reset_peak(device)

    t0 = time.perf_counter()
    pipe = QwenImage21Pipeline.from_pretrained(model_dir, torch_dtype=torch_dtype, low_cpu_mem_usage=True)
    load_sec = time.perf_counter() - t0

    # offload 策略（diffusers 需要 int 设备索引）
    applied = "none"
    if offload == "sequential":
        pipe.enable_sequential_cpu_offload(device=dev_idx)
        applied = "sequential"
    elif offload == "model":
        pipe.enable_model_cpu_offload(device=dev_idx)
        applied = "model"
    else:
        pipe = pipe.to(device)

    if vae_tiling:
        try:
            pipe.vae.enable_tiling()
        except Exception:
            pass

    peak = cuda_peak_mib(device)

    return {
        "pipe": pipe,
        "loadSec": round(load_sec, 2),
        "peakVramMiB": peak,
        "rssMiB": rss_mib(),
        "dtype": dtype,
        "device": device,
        "offload": applied,
    }


def run_generate(loaded: dict, width: int, height: int, steps: int, seed: int = 42, tag: str = "") -> dict:
    """
    跑一次推理，测耗时与峰值显存。

    同时通过 callback_on_step_end 采集**逐步耗时**，用于区分：
    - 首步（含 mmap 磁盘换入 + 首次上传权重，通常显著更慢）
    - 稳态步（后续步，代表持续吞吐）
    插件的 ETA 应基于稳态步而非平均值。
    """
    import torch

    pipe = loaded["pipe"]
    device = loaded["device"]
    result = {"width": width, "height": height, "steps": steps, "tag": tag}

    cuda_reset_peak(device)

    step_times: list[float] = []
    last = [time.perf_counter()]

    def on_step_end(pipeline, step, timestep, callback_kwargs):
        now = time.perf_counter()
        step_times.append(round(now - last[0], 3))
        last[0] = now
        return callback_kwargs

    gen = torch.Generator(device="cpu").manual_seed(seed)
    t0 = time.perf_counter()
    try:
        out = pipe(
            prompt="a red apple on a wooden table, photorealistic",
            width=width,
            height=height,
            num_inference_steps=steps,
            generator=gen,
            callback_on_step_end=on_step_end,
        )
        elapsed = time.perf_counter() - t0
        result["ok"] = True
        result["elapsedSec"] = round(elapsed, 2)
        result["secPerStep"] = round(elapsed / steps, 3)
        result["stepTimes"] = step_times
        if step_times:
            result["firstStepSec"] = step_times[0]
            # 稳态 = 除首步外的均值（若只有 1 步则退化为首步）
            rest = step_times[1:]
            result["steadyStepSec"] = round(sum(rest) / len(rest), 3) if rest else step_times[0]
        result["imageSize"] = list(out.images[0].size)
        result["imageMode"] = out.images[0].mode
        if device.startswith("cuda"):
            result["peakVramMiB"] = cuda_peak_mib(device)
            result["freeAfterMiB"] = cuda_free_mib(device)
        del out
    except Exception as e:
        result["ok"] = False
        result["error"] = f"{type(e).__name__}: {e}"
        result["elapsedSec"] = round(time.perf_counter() - t0, 2)
        result["stepTimes"] = step_times
        if device.startswith("cuda"):
            result["peakVramMiB"] = cuda_peak_mib(device)

    return result


def free_pipeline(loaded: dict):
    try:
        del loaded["pipe"]
    except Exception:
        pass
    gc.collect()
    try:
        import torch
        torch.cuda.empty_cache()
        torch.cuda.ipc_collect()
    except Exception:
        pass


def rss_mib() -> int:
    """当前进程 RSS（MiB），用于观察权重是否真的常驻内存。"""
    try:
        import ctypes
        import ctypes.wintypes

        class PROCESS_MEMORY_COUNTERS(ctypes.Structure):
            _fields_ = [
                ("cb", ctypes.wintypes.DWORD),
                ("PageFaultCount", ctypes.wintypes.DWORD),
                ("PeakWorkingSetSize", ctypes.c_size_t),
                ("WorkingSetSize", ctypes.c_size_t),
                ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
                ("QuotaPagedPoolUsage", ctypes.c_size_t),
                ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
                ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
                ("PagefileUsage", ctypes.c_size_t),
                ("PeakPagefileUsage", ctypes.c_size_t),
            ]

        counters = PROCESS_MEMORY_COUNTERS()
        counters.cb = ctypes.sizeof(counters)
        handle = ctypes.windll.kernel32.GetCurrentProcess()
        if ctypes.windll.psapi.GetProcessMemoryInfo(handle, ctypes.byref(counters), counters.cb):
            return counters.WorkingSetSize // (1024 * 1024)
    except Exception:
        pass
    try:
        import os
        import psutil
        return psutil.Process(os.getpid()).memory_info().rss // (1024 * 1024)
    except Exception:
        return 0


# ---------------------------------------------------------------------------
# 标定流程
# ---------------------------------------------------------------------------
SIZES = [
    # (宽, 高, 步数, 标签)
    (512, 512, 4, "512²"),
    (768, 768, 4, "768²"),
    (1024, 1024, 4, "1024²"),
    (2048, 2048, 2, "2048²"),
]


def run_calibrate(model_dir: str, device: str, dtype: str, offload: str) -> dict:
    """加载一次，跑多尺寸，测秒/步与峰值显存。"""
    out = {"device": device, "dtype": dtype, "offload": offload, "runs": []}

    try:
        print(f"\n>>> 加载 pipeline: device={device} dtype={dtype} offload={offload}", file=sys.stderr, flush=True)
        loaded = load_pipeline(model_dir, device, dtype, offload)
        out["loadSec"] = loaded["loadSec"]
        out["loadPeakVramMiB"] = loaded["peakVramMiB"]
        out["rssAfterLoadMiB"] = loaded["rssMiB"]
        print(f"    加载完成：{loaded['loadSec']}s，峰值显存 {loaded['peakVramMiB']}MiB，RSS {loaded['rssMiB']}MiB", file=sys.stderr, flush=True)
    except Exception as e:
        out["loadOk"] = False
        out["loadError"] = f"{type(e).__name__}: {e}"
        out["traceback"] = traceback.format_exc()
        print(f"    加载失败：{e}", file=sys.stderr, flush=True)
        return out

    out["loadOk"] = True

    for w, h, steps, tag in SIZES:
        print(f"    推理 {tag} ({steps} 步)...", file=sys.stderr, flush=True)
        r = run_generate(loaded, w, h, steps, tag=tag)
        r["rssMiB"] = rss_mib()
        out["runs"].append(r)
        if r.get("ok"):
            print(f"      ✓ {r['elapsedSec']}s ({r['secPerStep']}s/步)，峰值显存 {r.get('peakVramMiB')}MiB，RSS {r['rssMiB']}MiB", file=sys.stderr, flush=True)
        else:
            print(f"      ✗ {r.get('error')}", file=sys.stderr, flush=True)

    free_pipeline(loaded)
    return out


def main():
    parser = argparse.ArgumentParser(description="M0 硬件标定探针")
    parser.add_argument("--model-dir", default=MODEL_DIR_DEFAULT)
    parser.add_argument("--microbench", action="store_true")
    parser.add_argument("--env", action="store_true")
    parser.add_argument("--calibrate", action="store_true")
    parser.add_argument("--all", action="store_true")
    parser.add_argument("--device", default="cuda:0")
    parser.add_argument("--dtype", default="fp16")
    parser.add_argument("--offload", default="model")
    parser.add_argument(
        "--single",
        default="",
        help="单次实跑，格式 WxH:steps（如 1024x1024:24），用于测真实预设端到端耗时",
    )
    parser.add_argument(
        "--repeat",
        type=int,
        default=1,
        help="配合 --single：连续生成次数，用于判断首步 mmap 代价是否每图重复",
    )
    args = parser.parse_args()

    if not any([args.microbench, args.env, args.calibrate, args.all, args.single]):
        args.all = True

    report = {"modelDir": args.model_dir}

    # 单次实跑（真实预设端到端）
    if args.single:
        print(f"=== 单次实跑 {args.single} ===", file=sys.stderr, flush=True)
        try:
            spec, steps_s = args.single.split(":")
            w_s, h_s = spec.lower().split("x")
            width, height, steps = int(w_s), int(h_s), int(steps_s)
        except Exception:
            print("  --single 格式应为 WxH:steps，如 1024x1024:24", file=sys.stderr)
            sys.exit(2)

        print(f"  加载 pipeline（{args.dtype}）...", file=sys.stderr, flush=True)
        loaded = load_pipeline(args.model_dir, args.device, args.dtype, args.offload)
        print(f"  加载 {loaded['loadSec']}s，RSS {loaded['rssMiB']}MiB", file=sys.stderr, flush=True)

        runs = []
        for i in range(max(1, args.repeat)):
            r = run_generate(loaded, width, height, steps, seed=42 + i, tag=f"{width}x{height}#{i + 1}")
            r["rssMiB"] = rss_mib()
            r["loadSec"] = loaded["loadSec"]
            runs.append(r)
            print(
                f"  [{i + 1}/{args.repeat}] 总 {r.get('elapsedSec')}s"
                f"（首步 {r.get('firstStepSec')}s，稳态 {r.get('steadyStepSec')}s/步）"
                f" 峰值显存 {r.get('peakVramMiB')}MiB RSS {r['rssMiB']}MiB",
                file=sys.stderr,
                flush=True,
            )

        report["single"] = runs[0]
        if len(runs) > 1:
            report["repeat"] = runs
            # 首步代价是否重复：比较各次的首步耗时
            report["firstStepByRun"] = [r.get("firstStepSec") for r in runs]
            report["totalByRun"] = [r.get("elapsedSec") for r in runs]
            slows = [r.get("firstStepSec", 0) for r in runs]
            report["firstStepRecurs"] = bool(len(slows) > 1 and slows[1] > slows[0] * 0.5)
        free_pipeline(loaded)
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return

    # 环境
    if args.env or args.all:
        print("=== 环境盘点 ===", file=sys.stderr, flush=True)
        report["env"] = probe_env()
        e = report["env"]
        print(f"  torch {e['torch']}, cuda {e['cuda_version']}, diffusers {e['diffusers']}", file=sys.stderr, flush=True)
        print(f"  QwenImage21Pipeline 可用：{e.get('hasQwenImage21Pipeline')}", file=sys.stderr, flush=True)
        for g in e["gpus"]:
            print(f"  GPU{g['index']} {g['name']} sm_{g['sm']} 空闲 {g['freeMiB']}MiB / {g['totalMiB']}MiB", file=sys.stderr, flush=True)

    # 微基准
    if args.microbench or args.all:
        print("\n=== 微基准（裸 matmul 算力）===", file=sys.stderr, flush=True)
        gpus = report.get("env", {}).get("gpus") or probe_env()["gpus"]
        report["microbench"] = run_microbench(gpus)

    # 标定
    if args.calibrate or args.all:
        print("\n=== Pipeline 标定 ===", file=sys.stderr, flush=True)
        report["calibration"] = run_calibrate(args.model_dir, args.device, args.dtype, args.offload)

    # JSON 输出（stdout）
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
