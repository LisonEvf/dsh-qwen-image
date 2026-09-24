"""
Qwen-Image-2.1 Python worker —— 回环 HTTP 服务（§6）。

单例常驻：
- 30.86GB 权重加载 1 次（实测 55–67s，mmap 按需分页）
- 进程内**串行**队列（maxConcurrent=1）
- dtype/device/offload 策略 + 显存守卫 + 协作取消 + sidecar 落盘
- 仅回环监听，Bearer token 鉴权

端点：
  GET  /health              -> {ok,state,device,dtype,offload,vram:{free,total,peak},warmed}
  GET  /capabilities        -> {backend,diffusersVersion,transformers,torch,cuda,supports}
  POST /load                -> {modelDir,device,dtype,offload,vaeTiling,attnSlicing,minFreeMiB}  (幂等)
  POST /unload
  POST /warm                -> 预热（把冷启动代价提前）
  POST /generate            -> {prompt,width,height,steps,seed,count,transparent,...} -> {jobId}
  POST /edit                -> {prompt,images:[...],mask,...} -> {jobId}
  GET  /job/:id             -> 任务状态与结果
  GET  /progress/:id        -> SSE 进度流
  POST /cancel/:id          -> 协作取消
  GET  /logs?count=N        -> 最近日志行

启动：
  python worker/server.py --port 0 --model-dir <dir> --token <token>
  启动后打印 "PORT=<实际端口>"，供宿主解析。
"""

from __future__ import annotations

import argparse
import base64
import io
import json
import logging
import os
import queue
import re
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

# 允许以脚本方式直接运行（worker/ 目录下）
sys_path = os.path.dirname(os.path.abspath(__file__))
if sys_path not in os.sys.path:
    os.sys.path.insert(0, sys_path)

from pipeline_qwen21 import (  # noqa: E402
    CancelledError,
    GenSpec,
    LoadSpec,
    QwenImage21Engine,
    guard_vram,
    save_outputs,
    vram_info,
)

# ---------------------------------------------------------------------------
# 全局状态
# ---------------------------------------------------------------------------
ENGINE = QwenImage21Engine()
CONFIG: dict = {}
LOG_LINES: list[str] = []
LOG_LOCK = threading.Lock()
MAX_LOG_LINES = 2000

JOB_QUEUE: "queue.Queue[str]" = queue.Queue()
JOBS: dict[str, dict] = {}
JOBS_LOCK = threading.Lock()
JOB_COUNTER = [0]
TOKEN = ""
OUT_DIR = ""

# 已落盘产物名里的序号：`generate-3.png` / `edit-12.thumb.webp` → 3 / 12。
_ARTIFACT_INDEX_RE = re.compile(r"^(?:generate|edit)-(\d+)\.")


def log(msg: str):
    line = f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {msg}"
    print(line, flush=True)
    with LOG_LOCK:
        LOG_LINES.append(line)
        if len(LOG_LINES) > MAX_LOG_LINES:
            del LOG_LINES[: len(LOG_LINES) - MAX_LOG_LINES]
    logging.info(msg)


def recent_logs(count: int = 50) -> list[str]:
    with LOG_LOCK:
        return LOG_LINES[-count:]


def _write_rolling_log():
    """日志同时落滚动文件（§6.6）。"""
    path = CONFIG.get("logFile")
    if not path:
        return
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        handler = logging.FileHandler(path, encoding="utf-8")
        handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
        logging.getLogger().addHandler(handler)
    except Exception:
        pass


# ---------------------------------------------------------------------------
# 串行任务执行器
# ---------------------------------------------------------------------------
def worker_loop():
    """单线程串行消费任务队列（maxConcurrent=1）。"""
    while True:
        job_id = JOB_QUEUE.get()
        if job_id is None:
            break
        with JOBS_LOCK:
            job = JOBS.get(job_id)
        if job is None:
            continue
        try:
            kind = job["kind"]
            payload = job["payload"]
            spec = _build_gen_spec(payload, kind)
            progress = _make_progress_sink(job_id)

            t0 = time.perf_counter()
            result = ENGINE.run(spec, job_id, on_progress=progress, log=log)
            gen_sec = round(time.perf_counter() - t0, 2)

            saved = save_outputs(
                result,
                OUT_DIR,
                image_id=job_id,
                meta={
                    "prompt": spec.prompt,
                    "kind": kind,
                    "negativePrompt": spec.negative_prompt,
                    "trueCfgScale": spec.true_cfg_scale,
                    "requestedWidth": spec.width,
                    "requestedHeight": spec.height,
                },
                thumb_max=int(CONFIG.get("thumbMax", 384)),
                thumb_format=CONFIG.get("thumbFormat", "webp"),
                thumb_quality=int(CONFIG.get("thumbQuality", 82)),
                log=log,
            )

            with JOBS_LOCK:
                job["status"] = "completed"
                job["result"] = {
                    "images": saved,
                    "seed": result["seed"],
                    "steps": result["steps"],
                    "elapsedSec": result["elapsedSec"],
                    "gateSec": gen_sec,
                    "firstStepSec": result.get("firstStepSec"),
                    "steadyStepSec": result.get("steadyStepSec"),
                    "vaeDecodeSec": result.get("vaeDecodeSec"),
                    "peakVramMiB": result.get("peakVramMiB"),
                    "device": result.get("device"),
                    "dtype": result.get("dtype"),
                    "offload": result.get("offload"),
                    "hasAlpha": saved[0]["hasAlpha"] if saved else False,
                    "usedReferences": result.get("usedReferences", 0),
                }
                job["finishedAt"] = time.time()
                # saved 里已含每张的 thumb 路径（save_outputs 生成），
                # 上面的 images 投影直接带上，宿主据此持久化到 manifest。
        except CancelledError:
            with JOBS_LOCK:
                job["status"] = "cancelled"
                job["detail"] = "用户取消"
                job["finishedAt"] = time.time()
            log(f"任务 {job_id} 已取消，队列继续")
            _release_memory()
        except Exception as e:
            with JOBS_LOCK:
                job["status"] = "failed"
                job["detail"] = f"{type(e).__name__}: {e}"
                job["traceback"] = traceback.format_exc()
                job["finishedAt"] = time.time()
            log(f"任务 {job_id} 失败：{job['detail']}")
            _release_memory()


def _release_memory():
    try:
        import gc

        import torch

        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:
        pass


def _make_progress_sink(job_id: str):
    def sink(update: dict):
        with JOBS_LOCK:
            job = JOBS.get(job_id)
            if job is None:
                return
            job["progress"] = update
            job["progressHistory"].append(update)
            if len(job["progressHistory"]) > 5000:
                del job["progressHistory"][: len(job["progressHistory"]) - 5000]

    return sink


def _build_gen_spec(payload: dict, kind: str) -> GenSpec:
    images = []
    if kind == "edit":
        images = _load_images(payload)
    return GenSpec(
        prompt=payload.get("prompt", ""),
        width=int(payload.get("width") or 1024),
        height=int(payload.get("height") or 1024),
        steps=int(payload.get("steps") or 24),
        seed=payload.get("seed"),
        count=int(payload.get("count") or 1),
        negative_prompt=payload.get("negativePrompt"),
        true_cfg_scale=float(payload.get("trueCfgScale") or 1.0),
        images=images,
        output_resolution=payload.get("outputResolution"),
        transparent=bool(payload.get("transparent")),
    )


def _load_images(payload: dict):
    """
    载入条件图。

    ⚠️ QwenImage21Pipeline **没有 mask 参数**（读源码确认）。局部编辑的正规路径是
    「在图上画圆圈/涂抹标注，再把标注后的图作为条件图传入」。因此这里把独立的 mask
    叠加到图上（半透明红色标注）后一起作为条件图，符合官方「标注」语义。
    """
    from PIL import Image

    imgs = []
    for item in payload.get("images") or []:
        imgs.append(_load_one_image(item, Image))

    mask_spec = payload.get("mask")
    if mask_spec:
        base = imgs[0] if imgs else None
        mask_img = _load_one_image(mask_spec, Image)
        if base is not None:
            imgs[0] = _overlay_mask(base, mask_img)
            log("已把 mask 叠加为首张条件图的标注（QwenImage21Pipeline 无独立 mask 参数）")
        else:
            imgs.append(mask_img)
    return imgs


def _load_one_image(item, Image):
    """支持 base64 data-uri、纯 base64、或本地路径。"""
    if isinstance(item, str):
        if item.startswith("data:"):
            _, _, b64 = item.partition(",")
            return Image.open(io.BytesIO(base64.b64decode(b64))).convert("RGBA")
        if os.path.exists(item):
            return Image.open(item).convert("RGBA")
        # 当作纯 base64
        try:
            return Image.open(io.BytesIO(base64.b64decode(item))).convert("RGBA")
        except Exception:
            raise ValueError(f"无法识别的图像输入（既非路径也非 base64）：{item[:64]}...")
    raise ValueError(f"不支持的图像输入类型：{type(item)}")


def _overlay_mask(base, mask):
    """把 mask 的白色区域以半透明红色叠加到 base 上，形成「涂抹标注」。"""
    from PIL import Image

    base = base.convert("RGBA")
    mask = mask.convert("L").resize(base.size)
    overlay = Image.new("RGBA", base.size, (255, 0, 0, 0))
    # mask 白色 = 需修改区域 → 红色半透明标注
    red = Image.new("RGBA", base.size, (255, 0, 0, 110))
    overlay = Image.composite(red, overlay, mask)
    return Image.alpha_composite(base, overlay)


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------
class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "qwen-image-worker/0.1"

    def log_message(self, fmt, *args):
        # 静默常规请求日志，避免刷屏；错误仍由 log() 记录
        pass

    # ---- 工具 ----
    def _auth_ok(self) -> bool:
        if not TOKEN:
            return True
        got = self.headers.get("Authorization", "")
        return got == f"Bearer {TOKEN}"

    def _json(self, data, status=200):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return {}
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode("utf-8"))
        except Exception:
            return {}

    def _guard(self) -> bool:
        if not self._auth_ok():
            self._json({"error": "unauthorized"}, status=401)
            return False
        return True

    # ---- 路由 ----
    def do_GET(self):
        parsed = urlparse(self.path)
        path, qs = parsed.path, parse_qs(parsed.query)
        if not self._guard():
            return
        try:
            if path == "/health":
                self._json(
                    {
                        "ok": True,
                        "state": ENGINE.state,
                        "error": ENGINE.error,
                        "device": ENGINE.device,
                        "dtype": ENGINE.dtype,
                        "offload": ENGINE.offload,
                        "loadSec": ENGINE.load_sec,
                        "warmed": ENGINE._warmed,
                        "vram": vram_info(ENGINE.device or "cuda:0"),
                        "queueDepth": JOB_QUEUE.qsize(),
                    }
                )
            elif path == "/capabilities":
                self._json(_capabilities())
            elif path.startswith("/job/"):
                job_id = path[len("/job/") :]
                with JOBS_LOCK:
                    job = JOBS.get(job_id)
                if job is None:
                    self._json({"error": "job not found", "id": job_id}, status=404)
                else:
                    self._json(
                        {
                            "id": job_id,
                            "kind": job["kind"],
                            "status": job["status"],
                            "detail": job.get("detail"),
                            "progress": job.get("progress"),
                            "result": job.get("result"),
                        }
                    )
            elif path.startswith("/progress/"):
                self._sse(path[len("/progress/") :])
            elif path == "/logs":
                count = int((qs.get("count") or ["50"])[0])
                self._json({"lines": recent_logs(count)})
            else:
                self._json({"error": "not found", "path": path}, status=404)
        except Exception as e:
            self._json({"ok": False, "error": f"{type(e).__name__}: {e}"}, status=500)

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path
        if not self._guard():
            return
        try:
            if path == "/load":
                body = self._body()
                spec = LoadSpec(
                    model_dir=body.get("modelDir") or CONFIG.get("modelDir", ""),
                    device=body.get("device", "auto"),
                    dtype=body.get("dtype", "auto"),
                    offload=body.get("offload", "auto"),
                    vae_tiling=bool(body.get("vaeTiling", True)),
                    attn_slicing=bool(body.get("attnSlicing", False)),
                    min_free_mib=int(body.get("minFreeMiB") or CONFIG.get("minFreeMiB", 1024)),
                )
                self._json(ENGINE.load(spec, log=log))
            elif path == "/unload":
                self._json(ENGINE.unload(log=log))
            elif path == "/warm":
                self._json(ENGINE.warm(log=log))
            elif path == "/generate":
                self._enqueue("generate", self._body())
            elif path == "/edit":
                self._enqueue("edit", self._body())
            elif path.startswith("/cancel/"):
                job_id = path[len("/cancel/") :]
                ok = ENGINE.request_cancel(job_id)
                with JOBS_LOCK:
                    if job_id in JOBS and JOBS[job_id]["status"] == "queued":
                        JOBS[job_id]["status"] = "cancelled"
                        JOBS[job_id]["detail"] = "排队中取消"
                        ok = True
                self._json({"cancelled": ok, "id": job_id})
            else:
                self._json({"error": "not found", "path": path}, status=404)
        except Exception as e:
            log(f"POST {path} 失败：{e}\n{traceback.format_exc()}")
            self._json({"ok": False, "error": f"{type(e).__name__}: {e}"}, status=500)

    # ---- 生成/编辑入队 ----
    def _enqueue(self, kind: str, body: dict):
        if ENGINE.state != "ready":
            self._json(
                {"error": f"worker 未就绪（state={ENGINE.state}）。请先 POST /load。", "state": ENGINE.state},
                status=503,
            )
            return
        ok, msg = guard_vram(ENGINE.device, int(CONFIG.get("minFreeMiB", 1024)))
        if not ok:
            log(f"显存守卫拒绝入队：{msg}")
            self._json({"error": msg, "guard": "vram"}, status=429)
            return

        JOB_COUNTER[0] += 1
        job_id = f"{kind}-{JOB_COUNTER[0]}"
        with JOBS_LOCK:
            JOBS[job_id] = {
                "kind": kind,
                "status": "queued",
                "payload": body,
                "progress": None,
                "progressHistory": [],
                "queuedAt": time.time(),
            }
        JOB_QUEUE.put(job_id)
        log(f"任务 {job_id} 已入队（{kind}，队列深度 {JOB_QUEUE.qsize()}）")
        self._json({"jobId": job_id, "status": "queued"}, status=202)

    # ---- SSE 进度 ----
    def _sse(self, job_id: str):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.end_headers()

        last_sent = -1
        idle = 0
        try:
            while True:
                with JOBS_LOCK:
                    job = JOBS.get(job_id)
                    if job is None:
                        self.wfile.write(b"event: error\ndata: {\"error\":\"job not found\"}\n\n")
                        self.wfile.flush()
                        return
                    status = job["status"]
                    history = list(job["progressHistory"])
                    result = job.get("result")
                    detail = job.get("detail")
                    progress = job.get("progress")

                # 发送新增的进度
                for upd in history[last_sent + 1 :]:
                    self.wfile.write(f"event: progress\ndata: {json.dumps(upd, ensure_ascii=False)}\n\n".encode())
                    last_sent += 1
                if progress and last_sent < 0:
                    self.wfile.write(f"event: progress\ndata: {json.dumps(progress, ensure_ascii=False)}\n\n".encode())
                self.wfile.flush()

                if status in ("completed", "failed", "cancelled"):
                    payload = {"status": status, "detail": detail, "result": result}
                    self.wfile.write(f"event: done\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n".encode())
                    self.wfile.flush()
                    return

                idle += 1
                if idle > 3600:  # 约 30 分钟无终止则断开
                    self.wfile.write(b"event: timeout\ndata: {}\n\n")
                    self.wfile.flush()
                    return
                time.sleep(0.5)
        except (BrokenPipeError, ConnectionResetError):
            return  # 客户端断开，任务继续


def _capabilities() -> dict:
    def ver(mod):
        try:
            m = __import__(mod)
            return getattr(m, "__version__", "unknown")
        except Exception:
            return None

    cuda_ver = None
    try:
        import torch

        cuda_ver = torch.version.cuda
    except Exception:
        pass

    return {
        "backend": "diffusers",
        "diffusersVersion": ver("diffusers"),
        "diffusersCommit": getattr(__import__("diffusers"), "__git_commit__", None) if ver("diffusers") else None,
        "transformers": ver("transformers"),
        "torch": ver("torch"),
        "cuda": cuda_ver,
        "supports": {
            "rgba": True,
            "mask": False,  # QwenImage21Pipeline 无独立 mask 参数；走标注图路径
            "maskViaAnnotation": True,
            "multiRef": True,
            "maxRefs": 10,
            "negativePrompt": True,
            "trueCfgScale": True,
            "numImagesPerPrompt": True,
        },
    }


# ---------------------------------------------------------------------------
def resume_job_counter(out_dir: str) -> int:
    """
    把任务计数器续到已有产物的最大序号之后。

    ⚠️ 实测教训（2026-09-22）：`JOB_COUNTER` 是**进程内**变量，每次重启都从 0 开始，
    而产物名直接取自 `f"{kind}-{n}"`（`_enqueue` 的 job_id → pipeline 的
    `image_id=job_id`）。于是「重启后再生成的第一张」必然复用 `generate-1`，
    **静默覆盖**上一批同名 PNG，并让插件的注册表出现重复 id
    （`image_result list` / 相册会显示两行 generate-1）。

    启动时扫一遍产物目录即可根治：新 worker 的编号永远不撞已存在的文件。
    只认 `generate-<n>.` / `edit-<n>.` 前缀，缩略图 `…-1.thumb.webp` 也命中同一序号。
    """
    highest = 0
    try:
        names = os.listdir(out_dir)
    except OSError:
        return 0
    for name in names:
        m = _ARTIFACT_INDEX_RE.match(name)
        if m:
            highest = max(highest, int(m.group(1)))
    if highest:
        JOB_COUNTER[0] = highest
        log(f"任务计数器续号：已有产物最大序号 {highest}，下一个任务从 {highest + 1} 开始")
    return highest


def main():
    global TOKEN, OUT_DIR, CONFIG

    parser = argparse.ArgumentParser(description="Qwen-Image-2.1 worker")
    parser.add_argument("--host", default="127.0.0.1", help="仅回环")
    parser.add_argument("--port", type=int, default=0, help="0 = 自动分配")
    parser.add_argument("--model-dir", default=os.environ.get("QWI_MODEL_DIR", ""))
    parser.add_argument("--output-dir", default=os.environ.get("QWI_OUTPUT_DIR", ""))
    parser.add_argument("--token", default=os.environ.get("QWI_TOKEN", ""))
    parser.add_argument("--min-vram", type=int, default=int(os.environ.get("QWI_MIN_VRAM", "1024")))
    parser.add_argument("--log-file", default=os.environ.get("QWI_LOG_FILE", ""))
    parser.add_argument("--device", default=os.environ.get("QWI_DEVICE", "auto"))
    parser.add_argument("--dtype", default=os.environ.get("QWI_DTYPE", "auto"))
    parser.add_argument("--offload", default=os.environ.get("QWI_OFFLOAD", "auto"))
    parser.add_argument("--autoload", action="store_true", help="启动即加载模型")
    args = parser.parse_args()

    CONFIG = {
        "modelDir": args.model_dir,
        "minFreeMiB": args.min_vram,
        "logFile": args.log_file,
    }
    TOKEN = args.token
    OUT_DIR = args.output_dir or os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "outputs")
    OUT_DIR = os.path.abspath(OUT_DIR)

    _write_rolling_log()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    log(f"worker 启动：modelDir={args.model_dir} outDir={OUT_DIR} minVram={args.min_vram}MiB")
    log(f"鉴权：{'Bearer token 已启用' if TOKEN else '未启用（仅回环）'}")

    # 续号必须早于任何入队（worker_loop 已起，但入队只可能来自 HTTP 请求）
    resume_job_counter(OUT_DIR)

    # 串行执行线程
    t = threading.Thread(target=worker_loop, name="qwen-worker", daemon=True)
    t.start()

    if args.autoload and args.model_dir:
        try:
            ENGINE.load(
                LoadSpec(
                    model_dir=args.model_dir,
                    device=args.device,
                    dtype=args.dtype,
                    offload=args.offload,
                    min_free_mib=args.min_vram,
                ),
                log=log,
            )
        except Exception as e:
            log(f"自动加载失败（worker 仍在线，可稍后 POST /load）：{e}")

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    actual_port = server.server_address[1]
    log(f"监听 http://{args.host}:{actual_port}")
    print(f"PORT={actual_port}", flush=True)

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log("收到退出信号")
    finally:
        JOB_QUEUE.put(None)
        try:
            ENGINE.unload(log=log)
        except Exception:
            pass
        server.shutdown()
        log("worker 已退出")


if __name__ == "__main__":
    main()
