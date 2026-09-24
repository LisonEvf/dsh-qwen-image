# 安装与配置（@lisonevf/dsh-qwen-image）

> 面向两种读者：
> **普通用户**只看 §0–§5（双击一个文件就能装完）；
> **要改代码/接自己环境的人**看 §6 以后。

---

## 0. 最快路径（普通用户，一分钟看完）

**第 0 步：把插件下载到本地**

```bash
git clone https://github.com/lisonevf/dsh-qwen-image.git
```

或在仓库页面点 `Code` → `Download ZIP` 后解压。下面说的 `install.bat` / `install.sh` 都在这个目录里。

**Windows**：双击插件目录里的 `install.bat`

**Linux / macOS**：`sh install.sh`

装完之后**重启 dsh**（客户端界面半只在进程启动时加载）：

```powershell
dsh --profile web
```

打开 GUI（默认 http://127.0.0.1:3080），在对话里直接说「画一只戴墨镜的柴犬」即可。

先看看会发生什么、什么都不改（**出问题时第一步就跑这个**）：

```powershell
install.bat --check          # 只体检：系统/显卡/驱动/内存/磁盘/Python/dsh/网络/权重
install.bat --dry-run        # 只打印将要执行的每一步，不执行
install.bat --yes            # 全部用默认答案（无人值守/脚本化）
```

Linux / macOS 把 `install.bat` 换成 `sh install.sh`（选项完全一样）。

⚠️ 装完后请不要删除或移动本插件目录（插件是链接安装，删掉目录会导致启动失败）；要彻底移除见 §8。

---

## 1. 前置条件

| 项 | 要求 | 不满足会怎样 |
| --- | --- | --- |
| Node.js | 18 或更高 | 安装器直接提示去哪下载（dsh 本身也需要它，所以装了 dsh 就一定有） |
| dsh | 已安装（`npm install -g @deepseek-ai/dsh`） | 依赖与权重照装，只是**插件注册**这一步跳过，之后可重跑安装器补上 |
| pnpm | 推荐有（dsh plugin 是 pnpm 的转发器） | 安装器会自动尝试 `corepack enable pnpm` / `npm i -g pnpm` |
| 磁盘 | 约 **40GB**（权重 30.9GB + 依赖 8.4GB；安装器判定时会再留 5% 余量，实际需约 41GB 可用） | 报「磁盘空间不足」并给出 `--model-dir` 的换盘建议 |
| 显卡 | NVIDIA 推荐（16GB 显存以上体验最好） | 会自动装 CPU 版 torch 并明确警告「会很慢」；AMD 在 Linux 上走 ROCm |
| 网络 | 能访问 PyPI / PyTorch / HuggingFace（或它们的国内镜像） | 自动测速切镜像；权重还有 ModelScope 兜底 |
| 管理员权限 | **不需要** | 安装器只在 `%USERPROFILE%\.dsh`（或 `$DSH_HOME`）下面建东西 |

---

## 2. 安装器做了什么（7 步）

| # | 步骤 | 具体动作 | 幂等性 |
| --- | --- | --- | --- |
| 1 | 环境探测 | 系统/架构/内存/磁盘、每张显卡的型号·显存·**空闲显存**·驱动·compute capability、dsh/Node/pnpm/git/uv、所有候选 Python 及其已装包、ComfyUI 位置、各镜像延迟 | 只读 |
| 2 | 生成计划 | 选 Python 策略、选 PyTorch 轮子（按驱动 CUDA 版本）、给精度/offload/档位建议、算磁盘需求、给硬阻塞与警告 | 纯函数（可离线回归） |
| 3 | Python 解释器 | 优先复用本机已有解释器；一个都没有时下载 `uv` 并托管 Python 3.12 | 已有就直接用 |
| 4 | venv | 在 `<DSH_HOME>/dsh-qwen-image/venv` 建隔离环境；复用模式下写一个 `.pth` 借用已有包目录 | 已有可用 venv 就复用（`--force` 可重建） |
| 5 | 依赖 | torch（按驱动选 cu128/cu126/cu124/cu121/cu118/ROCm/CPU）+ transformers + accelerate + pillow + numpy + safetensors + huggingface_hub + diffusers（含 `QwenImage21Pipeline`） | 逐个 import 检查，缺什么装什么 |
| 6 | 权重 | 先体检（可能已经有一份，或你想指向别处的现成权重）；需要才下载，支持断点续传 | 完整体检通过即跳过 |
| 7 | 注册插件 | `dsh plugin --profile <p> add <本插件目录>`，然后幂等写入 profile 的 `cordis.patch.yml` 配置块（原文件先备份 `.bak-<时间戳>`） | 重复运行只更新配置块 |

每一步失败都会给出：**中文原因 + 可直接复制的修复命令 + 日志路径**。

---

## 3. 它怎么适配「不同用户、不同设备」

### 3.1 按驱动选 PyTorch 轮子

驱动报的 CUDA 版本是向后兼容的：驱动 12.9 可以跑 cu128/cu126/cu124 的轮子。

| nvidia-smi 里的 CUDA 版本 | 选用 | 轮子 |
| --- | --- | --- |
| ≥ 12.8 | cu128 | torch 2.7.1 |
| ≥ 12.6 | cu126 | torch 2.7.1 |
| ≥ 12.4 | cu124 | torch 2.6.0 |
| ≥ 12.1 | cu121 | torch 2.5.1 |
| ≥ 11.8 | cu118 | torch 2.4.1 |
| 更低 / 没有 N 卡 | CPU | 能用但极慢 |
| Linux + AMD | ROCm 6.3 | torch 2.6.0 |
| macOS | PyPI 默认轮子 | 按 CPU 推理（本插件暂不支持 MPS） |

选中的轮子装不上时会**自动降级重试**：官方源 → 国内轮子镜像（阿里云 `pytorch-wheels`）→ CPU 版 → PyPI 默认。
想强制指定：`--torch cu118` / `--torch cpu`。

### 3.2 Python 从哪来（阶梯）

1. 本插件自己的 venv（修复/重装时优先）
2. PATH 上的 python / python3 / python3.12…
3. Windows 的 `py -0p` 列出的所有版本
4. **ComfyUI**（便携版 `python_embeded`、源码版 `venv`）—— 常见安装位置都会扫
5. uv 托管的解释器
6. 都没有：自动下载 `uv`（约 35MB）并 `uv python install 3.12`

支持 Python **3.10 – 3.13**：3.9 太旧（torch 2.7 / transformers 5.x 要 3.10+），3.14 还没有轮子。
碰到这两种情况会自动改用 uv 托管的 3.12，而不是硬着头皮用。

### 3.3 「借用」而不是「重装」：省 3GB

如果探测到某个解释器**已经有 torch + 含 QwenImage21Pipeline 的 diffusers**
（你自己的环境、conda、ComfyUI 便携版都算），安装器会：

- 用**它**当基座建 venv（保证 ABI 版本完全一致）
- 往 venv 的 site-packages 里写一个 `_dsh_qwen_image_reuse.pth`，把它的包目录挂进来
- **不动它本身的任何文件**（想撤销：删掉那个 .pth 即可）

实测（本机 2026-09-23）：这样建出来的 venv 里 `torch 2.7.1+cu128` 直接可用、
`torch.cuda.is_available() == True`、P40 可见，全过程 55 秒，没有下载任何东西。

不想复用时加 `--no-reuse`（全新安装），或 `--python <路径>` 指定用哪个解释器。

### 3.4 网络：自动测速 + 三级兜底

- **pip 源**：启动时对 PyPI 官方 / 清华 TUNA 各发一次探测，**按实测延迟选快的**
  （可用 `--pip-index` 覆盖；公司内网源也行）
- **权重端点**：默认 `https://hf-mirror.com`，失败自动回落 huggingface.co，再失败回落 ModelScope
- **断点续传**：权重下载中断后重跑同一条命令即可续传（不会重下已完成的分片）

### 3.5 显存与内存 → 档位建议

安装器会打印建议（并写进 profile 配置的 `preset`）：

| 显存 | offload | 默认档位 | 说明 |
| --- | --- | --- | --- |
| ≥ 20GB | model | standard（1024²） | 舒适 |
| 16GB | model | standard | 峰值显存实测约 16.8GB，刚好 |
| 10–16GB | sequential | draft（768²） | 慢，但能跑 |
| 6–10GB | sequential | draft | 很慢，建议只在草稿档用 |
| < 6GB / 无独显 | sequential / CPU | draft | 基本不可用，建议换设备 |

内存 < 24GB 时会额外提示：权重 30.9GB 装不进内存缓存，**每张图都要重新读盘**
（本机实测每图多等 80–90 秒），建议 64GB。

多卡时按**空闲显存最多**的那张规划；如果发现大卡被别的程序占着，会明确说出来
（例如「P40 空闲只剩 205MB，本次改用 1660 SUPER；停掉占用程序可以换回大卡」）。

---

## 4. 常见场景速查

```powershell
# 只想体检，什么都不改
install.bat --check

# 已经装好 torch/diffusers（比如另一个插件装的），直接复用
install.bat --yes

# 强制全新环境，不借任何东西
install.bat --no-reuse --yes

# 用指定的解释器（内网 python、conda、ComfyUI 便携版都行）
install.bat --python "D:\ComfyUI_windows_portable\python_embeded\python.exe"

# 指定权重放在别的盘（空间不够时最有用）
install.bat --model-dir "D:\models\Qwen-Image-2.1"

# 先不下载 30.9GB 权重，只把环境装好
install.bat --no-model

# 公司内网 pip 源 + 离线权重（权重自己拷到 --model-dir）
install.bat --pip-index https://pypi.my-corp.com/simple --endpoint https://huggingface.co

# 强制重装 venv
install.bat --force

# 装到别的 dsh profile（默认自动选，通常是 web）
install.bat --profile tui

# 完全不碰 dsh（只装环境与权重，插件之后自己注册）
install.bat --no-plugin
```

Linux / macOS：把上面每条 `install.bat` 换成 `sh install.sh`，选项完全一样（例如 `sh install.sh --check`）。

---

## 5. 全部选项

| 选项 | 作用 |
| --- | --- |
| `--check` / `--doctor` | 只体检不修改 |
| `--dry-run` | 打印将要做什么，不执行 |
| `-y` / `--yes` | 全部使用默认答案（无人值守） |
| `--profile <name>` | 目标 dsh profile（默认自动挑选：有 web 就用 web，否则用唯一的那个 profile） |
| `--home <dir>` | DSH_HOME（默认环境变量 `DSH_HOME` 或 `~/.dsh`） |
| `--model-dir <dir>` | 权重目录（默认 `<DSH_HOME>/models/Qwen-Image-2.1`） |
| `--python <exe>` | 指定解释器 |
| `--torch <key>` | 强制轮子：cu128/cu126/cu124/cu121/cu118/rocm63/cpu/pypi（未知值回落 cu128 并给出提示） |
| `--reuse` / `--no-reuse` | 是否借用已有 torch/diffusers（默认借用） |
| `--pip-index <url>` | 指定 pip 源 |
| `--endpoint <url>` | 权重下载端点 |
| `--diffusers-commit <sha>` | 指定 diffusers commit |
| `--no-model` / `--no-plugin` / `--no-net` / `--no-uv` | 跳过对应步骤 |
| `--force` | 强制重装（忽略已有 venv / 权重） |
| `--json` | 以 JSON 输出最终报告（给脚本/支持人员） |
| `--quiet` / `-q` | 精简输出（只留结论与错误） |
| `--uv-url <url>` | 指定 uv 可执行文件的下载地址（内网/代理） |
| `--python-mirror <url>` | uv 下载 Python 用的镜像（等价环境变量 `DSH_QWEN_PYTHON_MIRROR`） |
| `-h` / `--help` | 打印帮助 |

别名：`--dry` = `--dry-run`、`--skip-model` = `--no-model`、`--skip-plugin` = `--no-plugin`。

---

## 6. 安装之后

### 6.1 校验（三件事）

```powershell
# 1) 再跑一次安装器体检：全部 ok 就说明环境没问题
install.bat --check                # Windows；Linux / macOS 用 sh install.sh --check

# 2) 重启后的 dsh 里，让插件自己报一次体检
#    在对话里说：「体检一下 qwen-image 环境」 → 会调用 image_status 工具

# 3) 出一张草稿图（768²，约 2-3 分钟）
#    在对话里说：「画一只戴墨镜的柴犬」
```

### 6.2 装在哪了

| 内容 | 位置 |
| --- | --- |
| venv | `<DSH_HOME>/dsh-qwen-image/venv` |
| uv 与托管 Python | `<DSH_HOME>/dsh-qwen-image/runtime` |
| 权重 | `<DSH_HOME>/models/Qwen-Image-2.1` |
| 输出图片 | `<DSH_HOME>/dsh-qwen-image/outputs` |
| 安装日志 | `<DSH_HOME>/dsh-qwen-image/logs/install-<时间戳>.log` |
| 安装状态 | `<DSH_HOME>/dsh-qwen-image/install-state.json`（记着当时选的 Python/torch/镜像，排障用） |
| profile 配置块 | `<DSH_HOME>/profiles/<profile>/cordis.patch.yml`（改动前的备份 `.bak-<时间戳>`） |

---

## 7. 手动安装（高级用户 / 二次开发）

### 7.1 以插件形式装进 profile

```powershell
# 从本地 checkout（link）
dsh plugin --profile web add ./dsh-qwen-image

# 或从 tarball
dsh plugin --profile web add ./lisonevf-dsh-qwen-image-0.1.0.tgz
```

**安装后必须重启 profile**：客户端半（界面卡片与相册视图）只在 DSH 进程启动时加载。

```powershell
dsh --profile web --dump-config     # 应出现 qwen-image 这一层
```

### 7.2 从源码构建

```powershell
npm install
node scripts/build.mjs          # host 半 → lib/index.cjs
node scripts/build-client.mjs   # client 半 → lib/client.js
```

### 7.3 自检（离线也能跑）

```powershell
node scripts/check-host-deps.mjs   # host 产物无外部依赖
node scripts/smoke-host.mjs        # 纯函数与参数校验
node scripts/smoke-host-e2e.mjs    # 假 worker 端到端（无 GPU）
node scripts/smoke-client.mjs      # 客户端 bundle 契约
node scripts/smoke-installer.mjs   # 安装器设备矩阵（纯 fixture，不联网）
node scripts/smoke-worker.mjs      # 真 GPU worker 协议端到端
```

### 7.4 配置项（profile 的 `cordis.patch.yml`）

安装器会写一份完整配置块；也可以手改。**注意：patch 是整块替换 config**，
所以要改就写全（或删掉整块回落到包内默认值）。

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `backend` | `'diffusers'` | `diffusers` \| `openai-images` \| `comfyui` |
| `modelDir` | `$DSH_HOME/models/Qwen-Image-2.1` | 权重目录 |
| `pythonExe` | 空（自动探测） | 显式优先，其次 `<DSH_HOME>/dsh-qwen-image/venv`，最后 PATH |
| `device` | `'auto'` | `auto` \| `cuda:0`…`cuda:3` \| `cpu` |
| `dtype` | `'auto'` | auto 按 compute capability 决策（sm<80 不用 bf16） |
| `offload` | `'auto'` | `none`\|`model`\|`sequential` |
| `preset` | `'standard'` | `draft`\|`standard`\|`native`\|`custom` |
| `defaultSteps` / `maxPixels` | 24 / 1048576 | 越界即拒绝并给出可操作提示 |
| `outputDir` | `$DSH_HOME/dsh-qwen-image/outputs` | PNG + 同名 sidecar JSON |
| `keepAliveMinutes` | 15 | 空闲多久自动卸载模型（0=立即） |
| `maxConcurrent` / `toolTimeoutMs` | 1 / 1800000 | worker 串行；生图工具超时 30 分钟 |
| `workerPort` / `routePrefix` | 0（自动）/ `/api/qwen-image` | 排障时可固定端口 |
| `allowModelFetch` | true | `image_model_fetch` 是否可用 |
| `hfEndpoint` / `modelRepo` | hf-mirror / Qwen/Qwen-Image-2.1 | 下载端点与仓库 |
| `maxReferenceImages` | 10 | 与模型上限一致 |
| `lowVramGuardMiB` | 1024 | 低于此空闲显存直接拒绝并说明原因 |

本机（P40）实测配置可参考 `docs/PLAN.md` §12。

---

## 8. 卸载与回滚

```powershell
# 1) 从 profile 移除插件
dsh plugin --profile web remove @lisonevf/dsh-qwen-image

# 2) 删掉配置块（或直接删掉整个 profile 的 cordis.patch.yml 里 qwen-image 那一段）
#    安装器改动前的备份：cordis.patch.yml.bak-<时间戳>

# 3) 删掉环境与输出（权重如果还想留就单独保留）
Remove-Item -Recurse -Force "$env:USERPROFILE\.dsh\dsh-qwen-image"
Remove-Item -Recurse -Force "$env:USERPROFILE\.dsh\models\Qwen-Image-2.1"
```

如果你借用了别的环境（复用模式），删除 `<venv>/Lib/site-packages/_dsh_qwen_image_reuse.pth`
即可断开借用关系 —— 安装器**没有**改过那个环境里的任何文件。

---

## 9. 排障

| 现象 | 先做什么 |
| --- | --- |
| 想知道到底缺什么 | `--check` 只读、不会崩、不改任何文件（缺什么说什么；发现硬性问题时退出码为 2，属正常诊断结果） |
| 双击后窗口一闪而过 | 用 PowerShell 跑 `node installer/install.mjs` 看完整输出；日志也在 §6.2 的路径 |
| dsh plugin 报 pnpm 错误 | `npm install -g pnpm` 后重跑 |
| 权重下载慢/断 | 换端点 `--endpoint https://huggingface.co`；或重跑续传（断点续传）；或改用 ModelScope：`modelscope download --model Qwen/Qwen-Image-2.1 --local_dir "<权重目录>"` |
| 装完看不到图片卡片 | 必须重启 dsh（客户端半只在启动时加载） |
| 显存不足 | 关掉占用显卡的程序（本地大模型最常见），或用 `--check` 看空闲显存 |
| 更多疑难 | 见 `docs/TROUBLESHOOTING.md` 与 `docs/HARDWARE.md` |

---

## 10. 许可

Qwen-Image-2.1 采用 **Qwen Research License**（非商用限制；商用需另行获得授权）。
本插件不携带、不分发任何权重文件；权重由使用者在安装时自行下载。
