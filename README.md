# @lisonevf/dsh-qwen-image

[![License](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/Node-%E2%89%A518-339933.svg)](https://nodejs.org/)
[![Model](https://img.shields.io/badge/Model-Qwen--Image--2.1-6f42c1.svg)](https://huggingface.co/Qwen)

> **在 AI 会话窗口里直接生图 / 改图，模型跑在你自己的显卡上。**

给 [dsh](https://www.npmjs.com/package/@deepseek-ai/dsh)（DeepSeek Harness）用的**对话式生图 / 改图**插件，专用于 Qwen-Image-2.1（原生 2K、原生透明 PNG、支持改图）。

- 在对话里说「画一只戴墨镜的柴犬」→ **对话流直接出图**，不用切终端、不用另开 WebUI
- 「把刚才那张的背景换成黄昏海滩」→ 改图（最多 10 张参考图）
- 权重体检 + 下载代办、作品相册、worker 显存控制（`image_worker unload`）

## 快速开始

**第 0 步：把插件下载到本地**

```bash
git clone https://github.com/lisonevf/dsh-qwen-image.git
```

或在仓库页面点 **Code → Download ZIP** 再解压。下面提到的 `install.bat` / `install.sh` 都在这个目录里。

> 前置：Node.js 18+ 与 dsh（`npm install -g @deepseek-ai/dsh`）。缺 dsh 时安装器仍会装好环境与权重，只是不注册插件，之后装好 dsh 重跑一次即可。

**Windows**：双击 `install.bat`　|　**Linux / macOS**：`sh install.sh`

装完**重启 dsh**（客户端界面半只在进程启动时加载；用哪个 profile 安装器收尾会打印，通常是 `web`）：

```powershell
dsh --profile web        # 若安装时挑的是别的 profile，把 web 换成它打印的那个
```

先体检不修改：`install.bat --check`　|　只看要做什么：`install.bat --dry-run`（Linux / macOS 换成 `sh install.sh --check` / `sh install.sh --dry-run`）

出图大概要等多久（P40 实测）：draft 768²/12步 ≈ 2.5 分钟、standard 1024²/24步 ≈ 5.0 分钟、native 2048²/40步 ≈ 43 分钟。

普通用户请先读 `使用说明.txt`；完整文档见 `docs/INSTALL.md`。

> ⚠️ 装完后请不要删除或移动本插件目录（插件是链接安装，删掉目录会导致 dsh 启动时加载失败）。

## 为什么做成插件，而不是自己拉个脚本跑

本地跑 Qwen-Image-2.1 的难点从来不是"调一次 API"，而是**装**和**管**：

| 问题 | 本插件的做法 |
| --- | --- |
| 我该装哪个 CUDA 版本的 torch？ | 安装器探测驱动，自动在 cu128/cu126/cu124/cu121/cu118 之间选，装不上逐级降级 |
| 我已经有 ComfyUI / conda 环境了 | 复用它的 site-packages，省约 3GB 下载，且**不动它本身** |
| 机器上没有 Python | 自动下载 `uv` 并托管 Python 3.12 |
| 权重 30GB 从哪下、断了下不动 | 权重体检 + 下载代办，走 hf-mirror，失败回落官方 / ModelScope |
| 显存被占了，我想把它还回去 | `image_worker unload` 一条命令卸载模型 |
| 出过的图去哪了 | 对话内联卡片 + 作品相册 + `/raw?id=` 直链，可回放 |

## 它怎么适配不同的机器

| 情况 | 安装器的做法 |
| --- | --- |
| 已有 torch + diffusers（含 ComfyUI 便携版/conda） | 借它的 site-packages 建 venv，省约 3GB 下载，不动它本身 |
| 完全没有 Python | 自动下载 uv 并托管 Python 3.12 |
| 驱动从 CUDA 11.8 到 12.9 | 自动选 cu128/cu126/cu124/cu121/cu118，装不上逐级降级到 CPU；Linux + AMD 走 ROCm 6.3 |
| 没有 NVIDIA 显卡 | 装 CPU 版并明确警告速度 |
| macOS | 装 PyPI 版 torch，但本插件只认 NVIDIA CUDA，实际按 CPU 推理（1024² 一张要数小时，仅供试跑） |
| 国内网络 | pip 源按实测延迟选镜像；权重走 hf-mirror，失败回落官方/ModelScope |
| 磁盘不够 / 想换盘 | `--model-dir`，并在下载前就报出空间需求 |

## 硬件门槛（实测，不是估算）

数据来自本机 **P40 / fp16 / 32GB RAM** 的实测记录（完整口径见 `docs/HARDWARE.md` 与 `acceptance/LOG.md`）：

| 项 | 实测 | 说明 |
| --- | --- | --- |
| 峰值显存（单条件图） | **~17 GB** | 1024×1536 |
| 峰值显存（双条件图） | **~21.6 GB** | 已逼近 24 GB 上限 |
| worker 卸载后常驻内存 | **20.2 GB** | 32GB 机器上建议每 3–4 张图重启一次 worker |
| 冷启动 | **每张约 85 秒** | 每图重付，32GB 内存装不下 30.86GB 权重的必然结果 |

> 一句话结论：**24GB 显存的卡能舒服跑，显存更小请先看 `docs/HARDWARE.md` 再决定。**
> 我们不在这里给你一个乐观的数字。

## 开发

```powershell
npm install
npm run build             # host 半 + client 半 → lib/
npm test                  # 离线冒烟（含安装器设备矩阵 108 项）
npm run test:gpu          # 真 GPU worker 协议端到端
npm run test:integration   # host × 真 worker 全链路（能真出一张图）
npm run check:release     # ★ 发布闸门：一键安装所依赖的硬约束（见下）
```

### 改完 `src/` 必须重建并提交 `lib/`

本项目是**零依赖一键安装**：普通用户下载后直接双击 `install.bat`，**不会**跑 `npm install`。
所以 `lib/index.cjs` 与 `lib/client.js` 是**随仓库分发的构建产物，必须入库**（`.gitignore` 里是刻意不忽略 `lib/` 的）。
改了 `src/` 却忘了重建并提交 `lib/`，用户装到的就是旧代码 —— 发布前用下面这条兜住：

```powershell
npm run check:release:full   # 重建 lib/ 并核对已提交的产物是否过期；另查 gitignore/行尾/占位符/本机路径/权重泄漏
```

架构与决策记录见 `docs/PLAN.md`，实测数据见 `docs/HARDWARE.md` 与 `acceptance/LOG.md`。

## English

**Conversational image generation and editing inside your AI session — running Qwen-Image-2.1 on your own GPU.**

A plugin for [dsh](https://www.npmjs.com/package/@deepseek-ai/dsh). Say "draw a shiba inu wearing sunglasses" in the chat and the image appears inline; say "change the background of the last one to a sunset beach" to edit it (up to 10 reference images). Native 2K output, native transparent PNG.

The hard part of running Qwen-Image-2.1 locally is never the single call — it's the setup. The installer probes your driver and picks the right CUDA build (cu128 → cu118, degrading to CPU), reuses an existing torch/diffusers install (ComfyUI portable, conda) to save ~3GB of downloads, bootstraps Python via `uv` if you have none, and mirrors the 30GB of weights via hf-mirror. `image_worker unload` gives your VRAM back.

Measured on a P40 (fp16, 32GB RAM): ~85s cold start per image, ~17GB peak VRAM for a single-condition image, ~21.6GB for dual-condition. See `docs/HARDWARE.md` before you commit a small GPU.

## 许可

- **本插件代码**：Apache-2.0（见 `LICENSE`）。
- **Qwen-Image-2.1 权重**：采用 **Qwen Research License**（仅限研究用途，**商用需另行授权**）。
  本仓库**不携带、不分发任何权重文件**，权重由使用者在安装时自行从 HuggingFace / ModelScope 下载；
  使用权重与生成内容须同时遵守模型自身的许可条款。
