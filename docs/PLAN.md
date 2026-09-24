# dsh-qwen-image — DSH 对话式生图 / 改图插件开发计划

> **这是一份开发过程文档（设计 + 决策记录），不是使用手册。**
> 只想把插件用起来请看根目录的 `README.md` 与 `使用说明.txt`；安装与排障看 `docs/INSTALL.md`、`docs/TROUBLESHOOTING.md`。
>
> 文中的实测数字是**当时的测量记录**，部分已被后续复测修正 —— **当前权威口径以 `docs/HARDWARE.md` 为准**
> （尤其档位耗时：draft 2.5 分钟 / standard 5.0 分钟 / native 43 分钟）。文中保留原始记录是为了呈现决策依据。

> 目标：在 DSH Web GUI 里用对话完成「生图 / 改图」，专用于 **Qwen-Image-2.1**。
> 权重文件不进项目（开发时的 `qwen-image-2.1/` 权重目录仅作参考基准，不随仓库分发）；插件负责**体检、指引下载、可代办下载命令**。
> 本文档 = 开发计划 + 已核实事实 + 验收标准 + 待决策项。除标注「待验证」的条目外，§1 的事实均已在标定机实测或由已安装的 dsh 包源码/类型声明确认。

---

## ⚠️ M0 实测修正（2026-09-21，P40 资源释放后完成）

M0 尖峰已完成，**实测推翻本文档两处关键假设**，后续实现以修正值为准。
完整数据见 `dsh-qwen-image/docs/HARDWARE.md` 与 `dsh-qwen-image/acceptance/LOG.md`。

| 原假设（本文档） | 实测结论 | 影响 |
| --- | --- | --- |
| §1.1/§6.1「P40 无原生 bf16、**fp16 算力极低（1/64 速率）**，sm_6.x 必须 fp32 + sequential offload」 | **证伪**。裸 matmul 实测：fp32 8.64 TFLOPS、**fp16 10.01 TFLOPS（更快）**、bf16 5.05。cuBLAS 在 Pascal 上对 fp16 GEMM 走高效通路 | **fp16 成为本机最优精度**，且把 RAM/VRAM 需求减半 —— 这是能在 32GB RAM + 24GB VRAM 上跑通的决定性因素。bf16 必须避免 |
| §11「Pascal 无 bf16、fp16 算力极低 → 精度/速度两难」 | 同上，风险**已消除** | — |
| §6「支持独立 mask 的局部编辑」 | `QwenImage21Pipeline` **没有 mask 参数**（读源码确认）。局部编辑只能走官方「圆圈/涂抹标注图作为条件图」路径 | 插件把独立 mask 合成红色半透明标注后并入条件图；`capabilities.supports.mask=false` |
| §1.3「guidance」 | 实际参数名是 **`true_cfg_scale`**，默认 1.0（模型设计为无引导采样）；仅 >1 且给 negative_prompt 时 CFG 才生效 | 工具参数改为 `trueCfgScale`，默认 1.0 |
| §9 M0 决策门：P40 不可用则默认后端改 `openai-images` | **P40 可用**（~5 分/张，无 OOM，显存余量 7.3 GB） | **默认后端保持 `diffusers`**，不启用 openai-images（与用户既定选择一致） |

### 实测耗时真相（四段式模型）

```
total ≈ loadExtra + firstStep + (steps−1) × steady + vaeDecode
```

| 分量 | 实测 |
| --- | --- |
| 权重加载 | **55 – 141 s**（mmap 按需分页，随页缓存状态波动） |
| 加载后 RSS | 629 MiB（权重未常驻） |
| `loadExtra`（加载后首张图额外） | ≈ **+100 s** |
| `firstStep`（**每图重付**） | **78 – 93 s** |
| `steady`（**超线性**于像素） | `≈ 8.96 × MP^1.34`（1.05 MP→8.82 s，4.19 MP→60.7 s） |
| `vaeDecode` | 24 s @768² / 26 s @1024² / 69 s @2048² |
| 峰值显存 | **恒定 16767 MiB**（vae tiling 生效，与尺寸无关） |

| 档位 | 实测总耗时 |
| --- | --- |
| `draft` 768²/12步 | **≈ 2.5 分** |
| `standard` 1024²/24步 | **≈ 5.1 分**（3 次实测 304.2/301.6/303.4 s） |
| `native` 2048²/40步 | **≈ 43 分钟**（原文「67 分」是线性外推的误算） |

**为什么首步每图都重付**：权重 30.86 GB vs RAM 31.95 GB（OS 占约 7 GB）→
`enable_model_cpu_offload()` 每张图都要把 text_encoder（16.33 GB）搬上 GPU，
而页缓存被内存压力逐出，于是每次重新从磁盘读入。**预热无法消除**；
根治只能加 RAM 到 64 GB 或改用 GGUF 量化权重（§2.1 的 comfyui 后端）。

### 一处测量方法的错误（已修正）

首轮标定把 tqdm 的**累计均值**当成单步耗时，得出「512² 稳态 9–10 s/步」，
实际仅 1.7 s/步 —— **高估约 5 倍**。此后所有测量一律用 `callback_on_step_end` 逐点计时，
并产出 `scripts/preset-bench.mjs` 作为可复跑的标定工具。

### 其他新发现（影响实现）

- **`callback_on_step_end` 必须返回 dict** —— 管道内部会对其 `.pop("latents")`，返回 `None` 直接崩。
- **取消必须靠回调内抛异常** —— `self._interrupt` 标志只被重置（L637）和暴露（L501），去噪循环内**并不检查**。
- **`image` 是一个扁平列表，对批次内所有 prompt 共享**，不可按 prompt 嵌套。
- `output_resolution` 默认 1024，既推导缺省宽高也**缩放条件图**，插件须显式传入目标边长。
- `use_kv_cache` 默认 True；文档明确说明切换它会改变（但同样有效的）采样结果。
- GTX 1660S 因 `CUDA_VISIBLE_DEVICES=0` **对 torch 不可见**（`device_count=1`），未标定。

---

## 0. 交付物定义

| 项 | 内容 |
| --- | --- |
| 组合包名 | `@lisonevf/dsh-qwen-image`（目录 `dsh-qwen-image/`，与既有 `@lisonevf/dsh-stock-panel` 同命名空间） |
| 安装方式 | **一键**：双击 `install.bat`（Windows）/ `sh install.sh`（Linux、macOS）→ 自动体检、备 Python、装依赖、下权重、注册插件；高级用户仍可 `dsh plugin --profile web add ./dsh-qwen-image`（或 `pnpm pack` 出的 `.tgz`） |
| 用户可见能力 | ① 对话「画一张…」→ 对话流里直接出图；② 对话「把这张的背景换成…」→ 改图；③ 权重体检 + 下载指引/代办；④ 作品画廊与 worker 显存控制 |
| 非目标 | 不分发权重；不做训练/LoRA；不做通用多模型平台（只做 Qwen-Image-2.1 专用，但后端可换） |

---

## 1. 已核实的环境与约束（决定架构的硬事实）

### 1.1 本机硬件 / 软件（实测）

| 项 | 实测值 | 影响 |
| --- | --- | --- |
| GPU0 | **Tesla P40**，sm_61，24GB，驱动 576.80 | Pascal，**无原生 bf16**、fp16 算力极低（1/64 速率，待 M0 实测确认） |
| GPU0 占用 | **`llama-server.exe` (pid 6600) 占 23.98GB / 24GB** | 当前**根本跑不下**扩散模型 → 必须先停 llama-server 或换设备 |
| GPU1 | GTX 1660 SUPER，sm_75，6GB（空闲约 4.8GB） | fp16 友好，但装不下 13.25GB transformer，只能逐层 offload |
| `CUDA_VISIBLE_DEVICES` | `0`（即 P40 默认可见） | 插件需显式 `device` 配置，不能想当然用 cuda:0 |
| 内存 | 32GB | 权重 30.86GB 全量驻留 RAM 也不宽裕 |
| 磁盘可用 | C: 435GB | 够 |
| Python | 3.12.10（Windows Store 版，`WindowsApps\python.exe`） | 需要稳健的 python 定位策略 |
| 已装 | `torch 2.7.1+cu128`、`transformers 5.17.0`、`huggingface_hub 1.32.0`、pillow、numpy | transformers 已满足模型要求的 `>=5.17` |
| **未装** | `diffusers`（`pip show` 不存在）、`accelerate` | `QwenImage21Pipeline` 在 diffusers **主分支**（模型卡要求 `pip install git+...diffusers`） |
| `hf` CLI | 1.32.0 可用；`modelscope` CLI 未装 | 代办下载走 `hf download` |
| nvcc | CUDA 12.8 | 与 torch cu128 一致 |

### 1.2 权重（本工作区实测盘点，作为「标准目录」基准）

| 组件 | 文件数 | 体积 |
| --- | --- | --- |
| `text_encoder`（Qwen3VLForConditionalGeneration，4 分片） | 7 | 16.33 GB |
| `transformer`（QwenImage21Transformer2DModel，2 分片） | 4 | 13.25 GB |
| `vae`（AutoencoderKLQwenImage21） | 2 | 1.26 GB |
| `processor` + `scheduler` + `model_index.json` | 13 | 0.02 GB |
| **合计** | 27 | **30.86 GB** |

`model_index.json` 声明：`QwenImage21Pipeline` / `Qwen3VLProcessor` / `FlowMatchEulerDiscreteScheduler` / `Qwen3VLForConditionalGeneration` / `QwenImage21Transformer2DModel` / `AutoencoderKLQwenImage21`，`_diffusers_version: 0.37.0.dev0`。

### 1.3 模型能力（官方 GitHub/HF 核实）

- 架构：32 层单流 DiT（7B，block-causal attention）+ **Qwen3-VL 8B 文本编码器** + 64 通道 RGBA VAE（16× 压缩）+ FlowMatch Euler 调度。
- 统一 T2I 与编辑；**最多 10 张参考图**；支持圆圈/涂抹标注或独立 mask 的局部编辑；**原生透明（RGBA）输出**；原生 2K。
- 官方默认：`num_inference_steps=40`，`width/height=2048×2048`；推荐比例表：1:1 (2048²)、4:3、3:4、3:2、2:3、16:9 (2752×1536)、9:16。
- 官方内存优化：`pipe.enable_model_cpu_offload()`。
- 透明图建议 prompt 模板：`This is an RGBA image with transparency. <描述>. The image has alpha channel and the background is transparent.`
- 可选（本项目**不**默认启用）：官方 prompt 改写模型 `Qwen-Image-2.1-PE-T2I` / `-PE-I2I`（Qwen3.5-VL 9B）；低显存可选 GGUF（社区 `Abiray/Qwen-Image-2.1-GGUF`）或 vLLM-Omni / SGLang / LightX2V。

### 1.4 DSH 侧可用能力（读已安装包源码/类型 + 实测确认）

| 能力 | 结论 | 证据 |
| --- | --- | --- |
| `ctx.attachments` | **已挂载**（`dsh-base` 挂了 `dsh-attachment-local`）→ `saveImage()` 拿到不可变 `ImageAttachmentRef` | `dsh-base/cordis.patch.yml:118` |
| 图像内容块 | `ImageBlock = { type:'image', attachment: ImageAttachmentRef }`；工具 `output.render` 与卡片 `content` 都是 `ContentBlock[]` | `dsh-llm`/`dsh-tools` 类型 |
| **当前模型路由不能看图** | **实测**：`read_image` 报 `model "deepseek-v4-flash" does not declare image input` | 本会话实测 |
| 工具超时 | 逐工具 `timeoutMs` 声明，由 `dsh-tool-call-timeout-policy` 包装；插件默认预算 **60s**，远不够生图 | 包源码 + config-catalog |
| 后台任务 | `ctx.jobs` 可注册自定义 kind；内置 `job_output`/`job_list`/`job_kill` 按 owner agent 读任意 kind 的任务；完成会发通知 | `dsh-tool-jobs/lib/index.js:151,274,299` |
| 同源 HTTP 路由 | `ctx.webServer.register({kind:'exact'|'prefix', path, handler})` 在宿主进程内挂路由 | 本机 `@lisonevf/dsh-stock-panel` 现网用法 |
| 子进程 | `ctx.subprocess`（`dsh-subprocess-local` 已挂载）提供受管 env 与 pipe/collect 输出模式 | config dump |
| 技能随包分发 | `ctx.skills.register({name,description,whenToUse,source:'runtime',content,resourceBase})` | `dsh-plugin-dev-kb/lib/index.js` |
| 客户端半 | `package.json` 的 `dsh.client` + `exports["./client"]`；构建产物经 `/plugins/??...` combo 路由加载 | `dsh-client-modules` 文档 |
| **工具专属卡片** | 槽 `tool.call.toolview` 是 **keyed slot**，`key: '<工具名>'` 即可接管该工具的对话内渲染；owner props = `{callId, toolName, block, cwd, home, openFile, inspect}` | `dsh-client-ui-tool/lib/types/client/contract/slots.d.ts` |
| 合并视图槽 | `conversation.view`（会话区整页视图，`@lisonevf/dsh-stock-panel` 已在用） | stock-panel `cordis.patch.yml` |
| 默认工具卡不渲染图 | 默认 tool 卡把非 text 块 `JSON.stringify`（`client-ui-tool` 的 `resultText`），**图像块只在 trajectory 视图与消息内容里被投影渲染** | `dsh-client-ui-tool/lib/client.js:107-113`；`dsh-client-ui-trajectory/lib/client.js:7421` |

> **关键推论 1**：对话流里「默认工具卡」不会把图片画出来 → 出图必须由**我们自己的 `tool.call.toolview` 卡片**渲染。
> **关键推论 2**：当前路由（deepseek-v4-flash）不能看图，所以「模型可见的图」必须按 `assertImageCapableRoute` 能力门控，`output.render` 默认只给文本；而**界面可见的图**走卡片 + 自控同源路由，不受模型视觉能力限制。

---

## 2. 总体架构

```
┌─────────────────────────── DSH Web GUI (浏览器) ───────────────────────────┐
│  client 半（本插件 lib/client.js，React）                                    │
│   ├─ tool.call.toolview  key=image_generate / image_edit  → 内联出图卡片     │
│   │     · pending：进度条(step i/N、耗时、ETA)、取消按钮                      │
│   │     · settled：图片 + 元信息(尺寸/seed/步数/耗时/显存) + 操作按钮          │
│   └─ conversation.view   key=qwen-image  → 「画室」画廊页（历史/参数/复用）     │
└───────────────▲──────────────────────────────────┬─────────────────────────┘
                │ fetch 同源 /api/qwen-image/*      │ 工具调用（模型发起）
┌───────────────┴──────────────────────────────────▼─────────────────────────┐
│  host 半（Cordis 插件 lib/index.js）                                        │
│   ├─ tools: image_status / image_worker / image_generate / image_edit       │
│   │         / image_result /(可选) image_model_fetch                        │
│   ├─ 串行任务队列 + ctx.jobs 注册（后台模式）+ 取消传播                       │
│   ├─ worker 管理器：懒启动 / 健康探活 / 空闲卸载 / 崩溃退避重启 / 退出清理      │
│   ├─ 图像注册表 id→{file,meta}（manifest.json）+ 结果注入 ctx.attachments     │
│   ├─ webServer 路由：raw / thumb / progress(SSE) / gallery.json / cancel     │
│   └─ skills.register('dsh-qwen-image', 含 {{MODEL_DIR}} 注入)                │
└───────────────┬───────────────────────────────────────────────────────────┘
                │ HTTP 127.0.0.1:<port>（Bearer token，仅回环）
┌───────────────▼───────────────────────────────────────────────────────────┐
│  Python worker（worker/server.py，常驻单例）                                 │
│   QwenImage21Pipeline + 串行推理队列 + dtype/device/offload 策略 + 显存守卫    │
│   /health /capabilities /load /unload /generate /edit /progress /cancel      │
└───────────────┬───────────────────────────────────────────────────────────┘
                │ 本地读取
        【权重目录（项目外）】$DSH_HOME/models/Qwen-Image-2.1 或用户指定路径
```

### 2.1 后端 seam（同一工具面，可换执行体）

| backend | 说明 | 适用 |
| --- | --- | --- |
| `diffusers`（默认） | 本项目自带 Python worker 直连 diffusers `QwenImage21Pipeline` | 权重在本地；控制力最强（mask/多参考/RGBA/进度/取消） |
| `openai-images` | 任意 OpenAI 兼容 images 端点（如 `vllm serve Qwen/Qwen-Image-2.1 --omni --port 8091`，或局域网/云端 GPU） | 本机弱卡时的**推荐逃生通道**，实现成本低 |
| `comfyui`（可选，后置） | ComfyUI HTTP API + `ComfyUI-GGUF`，可用 int4/int8 量化权重 | 6–8GB 显存档位 |

> 结论：先做 `diffusers`，**同时**把 `openai-images` 作为一等后端纳入 M7（本机 P40 被 llama-server 占死时，这是唯一能让用户当天用上 2K 出图的路径）。

---

## 3. 仓库布局

```
dsh-qwen-image/
├─ package.json                 # dsh.bundle.patch + dsh.client(platform:web, inject:[slots])
├─ cordis.patch.yml             # insert 一行 host entry，config 暴露全部可调参数
├─ tsdown.config.ts             # host 半打包（照抄 stock-panel 的 tsdown 用法）
├─ src/
│  ├─ index.ts                  # host 入口：inject=['tools','webServer','subprocess','attachments']（可选项用声明式 ctx.inject）
│  ├─ host/
│  │  ├─ config.ts              # Schemastery Config（§4）
│  │  ├─ tools/                 # 每个工具一个文件 + 统一 output schema/presenter
│  │  ├─ worker-manager.ts      # spawn/健康/空闲卸载/重启/日志落盘
│  │  ├─ client-http.ts         # worker HTTP 客户端（含 SSE/轮询、token、超时、重试）
│  │  ├─ queue.ts               # 串行队列 + 取消 + 进度广播
│  │  ├─ registry.ts            # 图像注册表 + manifest.json + 附件注入
│  │  ├─ routes.ts              # /api/qwen-image/* 同源路由
│  │  ├─ model-inspect.ts       # 权重目录体检（分片/index/safetensors 头）
│  │  ├─ model-fetch.ts         # hf download / modelscope 命令构造与代办
│  │  └─ skill.ts               # 技能注册（{{MODEL_DIR}}/{{OUT_DIR}} 注入）
│  └─ client/
│     ├─ index.ts               # 注册 toolview(×2) + conversation.view(画室)
│     ├─ cards/GenerateCard.tsx EditCard.tsx StatusCard.tsx
│     ├─ studio/StudioView.tsx  # 画廊页
│     └─ api.ts                 # 与 host 路由通信 + SSE 进度
├─ worker/
│  ├─ server.py                 # 回环 HTTP 服务（stdlib ThreadingHTTPServer 即可）
│  ├─ pipeline_qwen21.py        # 加载/offload/dtype/尺寸预设/推理/取消/显存守卫
│  ├─ model_check.py            # 体检（与 host 双端一致，host 侧为快速版）
│  ├─ bootstrap.py              # venv/依赖自检与安装建议
│  └─ requirements.txt          # 锁定 diffusers commit + accelerate + pillow
├─ install.bat                  # ★ Windows 一键入口（双击；末尾 pause，ComfyUI 便携版同款体验）
├─ install.sh                   # ★ Linux / macOS 一键入口
├─ 使用说明.txt                  # ★ 普通用户先读这一页（30 秒；三步走 + 常见问题 + 许可）
├─ installer/                   # ★ 跨平台安装器（零 npm 依赖，只用 Node 内建模块）
│  ├─ install.mjs               # 编排：体检 → 计划 → 解释器 → venv → 依赖 → 权重 → 注册 → 核验
│  └─ lib/
│     ├─ util.mjs               # 进程/文件/网络/下载/解压（自己实现，不引第三方）
│     ├─ ui.mjs                 # 中文提示、颜色降级、日志落盘、交互问答（--yes 自动作答）
│     ├─ detect.mjs             # 环境探测 + 纯函数解析（nvidia-smi / py -0p / 解释器探针）
│     ├─ plan.mjs               # ★ 纯决策层：torch 矩阵、Python 策略、精度/offload/档位、阻塞项
│     ├─ pystep.mjs             # uv 阶梯、venv、site-packages 复用(.pth)、依赖安装阶梯、核验
│     ├─ modelstep.mjs          # 权重体检复用 + hf/hf-mirror/ModelScope 三级下载
│     └─ pluginstep.mjs         # pnpm 保障、dsh plugin add、profile 配置块幂等写入、dump-config 复核
├─ skills/dsh-qwen-image.md     # 随包技能：提示词工艺、RGBA 模板、比例表、硬件降级、下载指引
├─ scripts/
│  ├─ build-client.mjs          # esbuild → CJS → window.__ModuleLoader__.load({...})（照抄 stock-panel）
│  ├─ smoke-host.mjs            # 假 worker 驱动，离线冒烟（无 GPU 也能跑）
│  ├─ smoke-client-view.mjs     # 卡片/画室结构冒烟
│  ├─ hw-probe.mjs              # 采集 GPU/RAM/权重/依赖事实（M0 与排障共用）
│  └─ sync-profile.mjs          # 一键 link 进 profile 并 --dump-config 校验
├─ docs/  INSTALL.md / MODEL-DOWNLOAD.md / HARDWARE.md / TOOLS.md / TROUBLESHOOTING.md
└─ acceptance/  证据日志与截图（照抄 stock-panel 的 acceptance 习惯）
```

---

## 4. 插件配置（`cordis.patch.yml` → Config schema，全部可调，无硬编码）

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `backend` | `'diffusers'` | `diffusers` \| `openai-images` \| `comfyui` |
| `modelDir` | `$DSH_HOME/models/Qwen-Image-2.1` | 权重目录；本机可指向既有 `…\dsh-qwen-image-2.1\qwen-image-2.1` |
| `pythonExe` | 自动探测 | 显式优先，其次 `$DSH_HOME/dsh-qwen-image/venv/Scripts/python.exe`，最后 PATH |
| `device` | `'auto'` | `auto`\|`cuda:0`\|`cuda:1`\|`cpu`；auto 需按「空闲显存最多者」选择并记日志 |
| `dtype` | `'auto'` | auto 依据 compute capability 决策（sm<80 不用 bf16） |
| `offload` | `'auto'` | `none` \| `model` \| `sequential`；auto 按可用显存估算 |
| `preset` | `'standard'` | `draft`(768²,12步) \| `standard`(1024²,24步) \| `native`(2048²,40步) \| `custom` |
| `defaultSteps` / `maxPixels` | 24 / 1024×1024 | 越界即拒绝并给出可操作提示 |
| `outputDir` | `$DSH_HOME/dsh-qwen-image/outputs` | 落盘位置（PNG + sidecar JSON） |
| `keepAliveMinutes` | 15 | 空闲多久自动 unload 释放显存（0=立即） |
| `maxConcurrent` | 1 | worker 串行；>1 只作为排队上限 |
| `toolTimeoutMs` | 1800000 | `image_generate`/`image_edit` 的 `timeoutMs`（30 分钟） |
| `workerPort` | 0（自动） | 固定端口便于排障 |
| `routePrefix` | `/api/qwen-image` | 同源路由前缀 |
| `allowModelFetch` | true | `image_model_fetch` 是否可用 |
| `hfEndpoint` | `https://hf-mirror.com` | 大陆镜像（可空表示官方站） |
| `modelRepo` | `Qwen/Qwen-Image-2.1` | 下载仓库 id（HF/ModelScope 同名） |
| `maxReferenceImages` | 10 | 与模型上限一致 |
| `lowVramGuardMiB` | 1024 | 低于此空闲显存直接拒绝并提示 |

---

## 5. 工具面（模型可见 API）

统一约定：`execute` 只返回**规范 JSON 值**；`output.render` 给模型**文本**（含 id、路径、尺寸、seed、耗时——因为当前路由不能看图，文本必须自解释）；`presentCall/presentResult` 给**界面**（`content` 里放 `ImageBlock`，并投影 `presentationMeta` 供刷新回放）；`timeoutMs` 仅生图/改图设长。

### 5.1 `image_generate`
```
prompt: string (required)           # 中文/英文均可；透明图走 RGBA 模板
preset | width/height | ratio       # 三选一，交集校验（比例表见 §1.3）
steps, seed, guidance                # 可选，默认按 preset / 随机 seed
transparent: boolean                 # 原生 RGBA
count: 1..4                          # 批量
mode: 'wait' | 'background'          # background → ctx.jobs，返回 jobId
reference: 'latest' | imageId        # 风格/主体参考（走 image 条件通道）
```
规范值：`{ id, file, width, height, bytes, seed, steps, preset, elapsedMs, peakVramMiB, hasAlpha, images[] }`

### 5.2 `image_edit`
```
prompt: string (required)
image: string (required)             # 文件路径 | imageId | 'latest'（本插件注册表内）
images: string[]                     # 多参考图，≤ maxReferenceImages
mask: string                         # 独立 mask 路径（可选；像素级局部改）
scale | ratio | width/height, steps, seed, transparent, mode
```
规范值同 `image_generate`，另附 `inputImage`、`usedReferences`。

### 5.3 `image_status`
体检 + 指引，**永不失败**（缺啥就说啥）：
- 权重：逐组件（processor/scheduler/text_encoder/transformer/vae）核对存在性、分片齐全性、index 一致性、safetensors 头可读性 → `ok | partial | missing`。
- 环境：python 路径/版本、torch/transformers/diffusers 版本、CUDA 可用性、每张 GPU 的**空闲**显存。
- worker：未启动 / 加载中(带进度) / ready / 出错（带最近 50 行日志）。
- 缺失时给出**可直接复制的命令**（见 §8）。
- 规范值：`{ model:{state,components[],missing[]}, env:{...}, worker:{...}, guidance:[...], commands:[] }`

### 5.4 `image_worker`
`action: 'start'|'stop'|'unload'|'warm'|'status'|'logs'`
用途：生图前预热（避免首图等加载）、用完释放显存（把 P40 还给 llama-server）、拿日志排障。

### 5.5 `image_result`
`id?: string`（缺省取本次会话最新）→ 返回同一规范值 + 附带图片的卡片（后台模式与「再给我看一次」的正规入口）。

### 5.6 `image_model_fetch`（可选，默认开但**强制确认**）
- 构造 `hf download <repo> --local-dir <modelDir> [--include <pattern>]`（带 `HF_ENDPOINT` 镜像），或输出 ModelScope 等价命令。
- `confirm: true` 必填；可用时经 `ctx.approval.request()` 再确认一次；以 `ctx.jobs` 后台跑，进度进卡片。
- 仅下载，不修改权重；项目不携带任何权重。

---

## 6. Python worker 规格

```
GET  /health        → {ok, state:'idle|loading|ready|error', device, dtype, offload, vram:{free,total,peak}}
GET  /capabilities  → {backend:'diffusers', diffusersVersion, commit, transformers, torch, cuda, supports:{rgba, mask, multiRef, maxRefs}}
POST /load          → {modelDir, device, dtype, offload, attnSlicing, vaeTiling}  (幂等)
POST /unload
POST /generate      → {prompt,width,height,steps,seed,transparent,count}  → {jobId}
POST /edit          → {prompt, images:[base64|本地路径], mask, ...}       → {jobId}
GET  /progress/:job → SSE：{step, total, elapsedMs, etaMs, peakVramMiB}
POST /cancel/:job   → 协作取消
```
实现要点：
1. **单例常驻**：30.86GB 权重，加载 1 次；进程内串行队列（`maxConcurrent=1`）。
2. **dtype/device/offload 策略**：
   - sm ≥ 80 → `bf16`；sm 7.x → `fp16`；sm 6.x（P40）→ 默认 `fp32`，但 7B 的 fp32 transformer ≈ 28GB > 24GB，**必须** `offload=sequential`（待 M0 实测标定，可能不可用 → 明确报「本卡不支持，请换 1660S/远端」）。
   - 显存足够 → `none`；否则 `enable_model_cpu_offload()`；再不够 → `enable_sequential_cpu_offload()`。
   - 必开 `vae.enable_tiling()`（2048² 解码是显存杀手）；可配 attention slicing。
3. **显存守卫**：推理前 `torch.cuda.mem_get_info()`，不足则**拒绝并给出中文可操作建议**（含「检测到 llama-server 占用 23.9GB，请停止后重试」这类具体归因），绝不 OOM 崩栈。
4. **取消**：`callback_on_step_end` 检查 flag → 抛 `CancelledError`；保证 `torch.cuda.empty_cache()` 与队列释放。
5. **输出**：PNG（RGBA 保留 alpha）+ 同名 `.json` sidecar（prompt/seed/steps/size/耗时/峰值显存/模型组件哈希摘要/worker 版本）。
6. **日志**：滚动文件 `$DSH_HOME/dsh-qwen-image/logs/worker-<date>.log`；host 侧保留尾部供 `image_worker action=logs`。
7. **依赖隔离**：独立 venv（默认）或复用系统 python（`--system-site-packages` 变体）。`bootstrap.py` 自检并打印缺失依赖与安装命令；diffusers 锁定到含 `QwenImage21Pipeline` 的 **commit**（PR #14804 之后），避免主分支漂移。

---

## 7. 客户端半（浏览器）

### 7.1 工具卡：`tool.call.toolview`，key = `image_generate` / `image_edit`
```ts
ctx.slots.inject('tool.call.toolview', () => ctx.slots.register(
  { name: 'tool.call.toolview', key: 'image_generate', locale: CONVERSATION_NS },
  GenerateCard,   // props: { callId, toolName, block, cwd, home, openFile, inspect }
))
```
- **pending**：进度条（来自 SSE `/progress`）+「取消」+ 已用时/ETA；支持折叠。
- **settled**：`<img src="/api/qwen-image/raw?id=…">` + 元信息徽章（尺寸/seed/步数/耗时/峰值显存/RGBA）+ 操作（打开原图、复制 prompt、以此图再改、重新生成=同 seed 复跑）。
- **图片显示双通道**（互为兜底）：
  1. 自控同源路由 `/api/qwen-image/raw?id=…`（**保底，必成**，与模型视觉能力无关）；
  2. 结果同时注入 `ctx.attachments` 并在卡片 `content` 里给 `ImageBlock`（原生，刷新/回放更稳）。
- **画室视图**：`ctx.slots.inject('conversation.view', …)` 注册「画室」标签页 —— 历史网格、按 id 复用改图、批量导出、worker 状态与显存控制面板。
- 构建：esbuild → CJS → `window.__ModuleLoader__.load({ name, inject:['slots'], apply })`，`react` 保持 external（沿用 stock-panel 的 `scripts/build-client.mjs` 骨架）。

### 7.2 与模型视觉能力解耦
- `deepseek-v4-flash` 不能看图 → `output.render` 只回文本（含 id/路径/参数），**不**塞 `ImageBlock`；
- 若检测到当前路由**确实**声明 image 输入，则 `finalizeContent` 追加 `ImageBlock`，让模型能「自审图并迭代」；
- 可选增强（配置开关）：接入一个 image-capable 路由（`ctx.llm`）做「审图 → 自动重跑」，不配则跳过。

---

## 8. 权重获取（项目外，插件负责引导 / 代办）

**目录约定**：`modelDir` 默认 `$DSH_HOME/models/Qwen-Image-2.1`；体检按 §1.2 的组件清单核对，缺件精确到文件名。

三条路径（`image_status` 会按当前状态给出其中一条的具体命令）：

1. **指向已有目录**（本机最快）：
   ```yaml
   # profile 的 cordis.patch.yml
   - id: qwen-image
     config:
       modelDir: 'D:/models/Qwen-Image-2.1'
   ```
2. **手动下载**（大陆建议镜像）：
   ```powershell
   $env:HF_ENDPOINT='https://hf-mirror.com'
   hf download Qwen/Qwen-Image-2.1 --local-dir "$env:USERPROFILE\.dsh\models\Qwen-Image-2.1"
   # 或 ModelScope（需先 pip install modelscope）
   modelscope download --model Qwen/Qwen-Image-2.1 --local_dir <dir>
   ```
3. **插件代办**：`image_model_fetch` → 后台任务运行同一条 `hf download`（支持 `--include` 断点补分片），进度进卡片。
   - 预期：约 **30.9GB**、27 个文件；磁盘与耗时提示由插件按实时速度估算。
   - 许可提示：Qwen Research License（非商用限制需在文档中显著说明）。

---

## 9. 里程碑

| # | 目标 | 交付 | 验收证据 | 估时 |
| --- | --- | --- | --- | --- |
| **M0** | **可行性尖峰**：本机 diffusers 加载 + 单图实测，标定 dtype/device/offload/预设与耗时 | `docs/HARDWARE.md`、`scripts/hw-probe.mjs`、acceptance 日志 | ① 在 1660S 与/或停掉 llama-server 的 P40 上各出 1 张图；② 记录 512/768/1024/2048 的**秒/步**与峰值显存；③ 结论写清「本机可用的最大档位」 | 0.5–1 天 |
| **M1** | 骨架 + 体检 + 技能 | host 入口、Config、`image_status`、`model-inspect`、随包技能 | `image_status` 在「权重缺失」与「权重齐全」两种盘面都给出正确输出与命令 | 1 天 |
| **M2** | Python worker | §6 全部端点 + 队列 + 取消 + 显存守卫 + sidecar | 手工 curl 全流程通过；取消后显存回落；OOM 场景输出中文归因 | 2–3 天 |
| **M3** | host 工具面 + worker 管理 | `image_generate`/`image_edit`/`image_worker`/`image_result`、队列、超时、`ctx.jobs` 后台模式 | 对话里连续生图/改图不串味；后台模式经 `job_output` 可读 | 2 天 |
| **M4** | **显示闭环（关键）** | `image_generate` 卡片 + `/api/qwen-image/raw` 路由 + 附件注入 + SSE 进度 | **GUI 截图**：对话流内出现图片卡片、有进度、可取消；刷新页面图仍在 | 1–2 天 |
| **M5** | 画室视图 + 交互完善 | `conversation.view` 画廊、复用改图、导出、worker 面板 | GUI 截图 + 交互冒烟脚本 | 2–3 天 |
| **M6** | 打包 / 安装 / 文档 | ✅ 一键安装器（`install.bat` / `install.sh` + `installer/*.mjs`，含设备矩阵离线冒烟 108 项）、INSTALL/TROUBLESHOOTING 重写；⏳ 剩余：`pnpm pack` 与干净 profile 从零出图 | 在干净 profile 上从零安装并出图 | 1 天 |
| **M7** | 硬化 + 多后端 | 崩溃恢复、并发/取消压测、`openai-images` 后端（vLLM-Omni）、（可选）comfyui | 冒烟矩阵全绿；远端后端出图 | 2–3 天 |

> **M0 决策门**：若 P40 实测不可用且 1660S 慢到不可接受 → 默认后端改为 `openai-images`（本机起 vLLM-Omni 或指向局域网大卡机器），`diffusers` 降级为可选后端；此决策只影响默认值与文档，不改工具面。

---

## 10. 验收标准（可执行清单）

- **A1 安装**：`dsh plugin --profile web add ./dsh-qwen-image` 后 `dsh --profile web --dump-config` 出现本插件层；HMR 改配置不残留旧注册。
- **A2 体检**：`image_status` 在缺权重时给出可复制命令；权重齐全时逐组件 OK；`modelDir` 写错时报错指出期望路径。
- **A3 生图**：对话「画一只戴墨镜的柴犬」→ 卡片出进度 → 出图 → **页面刷新后图仍在**。
- **A4 改图**：对 A3 的图说「背景换成黄昏海滩」→ 新图；再试 mask 局部改与 2 张参考图。
- **A5 显存守卫**：llama-server 占满 P40 时，工具返回**具体归因 + 处置建议**，进程不崩、无 OOM 栈。
- **A6 取消**：生图中点取消 → worker 停下、队列释放、显存回落、无僵尸 python 进程。
- **A7 生命周期**：插件卸载/HMR → worker 被杀、路由撤销、无重复注册；`keepAliveMinutes` 到期自动 unload。
- **A8 离线冒烟**：`scripts/smoke-*.mjs` 用假 worker 跑通工具面与卡片结构，**无 GPU 也能过**。
- **A9 无硬编码**：抽查每个可调参数都能在 `cordis.patch.yml` 改到，不需要改代码。

---

## 11. 风险与对策

| 风险 | 影响 | 对策 |
| --- | --- | --- |
| P40 被 llama-server 占满（当前 23.98/24GB） | 完全跑不动 | 显存守卫 + 明确归因；`device` 可选 1660S；默认后端可切 `openai-images` |
| Pascal 无 bf16、fp16 算力极低 | 精度/速度两难 | M0 实测标定；提供 `draft` 低分辨率档；文档给出「本机可用档位」结论 |
| 32GB RAM + 30.86GB 权重 | 加载/换页抖动 | mmap 加载、sequential offload、常驻不重启、空闲卸载权衡（写进 HARDWARE.md） |
| diffusers 主分支漂移 | 某天装不上/接口变 | 锁 commit；`/capabilities` 上报版本；失败时给固定 commit 的安装命令 |
| 当前路由不能看图（已实测） | 模型无法自审图 | 卡片显示与模型能力解耦；文本回传全部关键参数；可选 vision 路由自审 |
| 默认工具卡不渲染图像块（已实测） | 「以为出图了其实看不见」 | 必须实现自己的 `tool.call.toolview` 卡片（M4 有 GUI 截图验收） |
| tool 超时 | 长任务被 60s 掐断 | 逐工具 `timeoutMs` 声明；后台模式走 `ctx.jobs` |
| 权重下载慢/中断 | 用户放弃 | `hf` 断点续传 + 镜像 endpoint + 分片 `--include` 补下 + 进度卡片 |
| venv 重装 torch（约 3GB） | 安装门槛 | **已实现**：探测到已有 torch+diffusers（含 ComfyUI 便携版/conda/商店版 Python）时，用它建 venv 并写 `.pth` 借用其 site-packages —— 本机实测 55 秒装完、零下载；不借用时 `--no-reuse` |
| 用户机器上没有 Python | 装不下去 | 自动下载 uv（单文件，官方 + 国内代理三级 URL）并 `uv python install 3.12`；3.9/3.14 等不可用版本也会改走这条路 |
| 驱动版本千差万别 | 轮子选错→ 看不到 CUDA | 按 nvidia-smi 的 CUDA 版本选 cu128/cu126/cu124/cu121/cu118/ROCm/CPU，装不上自动降级重试；CPU 兜底时明确警告速度 |
| 国内网络 / 内网 | 依赖与权重下不动 | pip 源按**实测延迟**自动选（官方/清华）、PyTorch 轮子有阿里云镜像、权重 hf-mirror → 官方 → ModelScope 三级兜底；都可用 `--pip-index` / `--endpoint` 覆盖 |
| 许可（Qwen Research License） | 合规 | INSTALL.md 显著提示；不随包分发权重 |

---

## 12. 已决策（用户已拍板，作为实现基线）

| 决策 | 结论 |
| --- | --- |
| 默认后端 + 预设 | **`diffusers` + `standard(1024², 24 步)`**；显存不足时自动降级到 `draft(768²,12步)` 并明确告知；`native(2048²,40步)` 仅在实测可用的设备上放开 |
| `modelDir` 默认值 | **`$DSH_HOME/models/Qwen-Image-2.1`**；本机在 `cordis.patch.yml` 覆写到既有目录 `…/dsh-qwen-image-2.1/qwen-image-2.1` |
| 代办下载 | `image_model_fetch` **默认开**，强制 `confirm: true`，可用时叠加 `ctx.approval` 审批；未确认则只输出可复制命令 |
| 交付渠道 | **本地 `link:`** —— `dsh plugin --profile web add ./dsh-qwen-image`；M6 仍产出 `pnpm pack` 的 tgz 作为附带产物 |
| 「审图自迭代」 | 暂不做；仅保留配置开关位（接入 image-capable 路由后可用于自动重跑） |

---

## 13. 下一步（M0 首日清单）

1. `mkdir dsh-qwen-image && pnpm init`，拷入 stock-panel 的 `tsdown.config.ts` / `scripts/build-client.mjs` 骨架并跑通空插件 `link:` 挂载（验 A1 前半）。
2. 建 `worker/` 独立 venv，装 `diffusers@<锁定 commit>` + `accelerate`，本地加载既有权重跑通官方 Quick Start（1024²/24 步）。
3. `scripts/hw-probe.mjs` 采集：每张卡空闲显存、各 dtype/offload 组合能否加载、512/768/1024/2048 的秒/步与峰值显存、加载耗时。
4. 把结论写进 `docs/HARDWARE.md`，并据此确定 `preset` 的实际可选档位与默认值（如 1024² 在本机不可接受 → 默认改 `draft` 并在此文档说明原因）。
5. 顺手验证「显示闭环」最小样机：一张现成 PNG 经 `presentResult` 的 `content` 与自控路由两种方式各在一个 `tool.call.toolview` 卡片里渲染出来，确认哪种在对话流里稳定可见（M4 依据）。

---

## 附：本文档的事实来源

- 本机实测：`nvidia-smi`、磁盘/内存、`python -m pip list`、`hf --version`、`dsh --profile web --dump-config`、`read_image` 路由门控实测。
- dsh 已安装包源码/类型：`dsh-tools`（ToolDefinition/ContentBlock/presentation）、`dsh-tool-call-timeout-policy`、`dsh-tool-jobs`、`dsh-tool-fs/read-image`、`dsh-client-ui-tool`（keyed slot 契约）、`dsh-client-ui-chat`/`-trajectory`（图像块投影）、`dsh-base`/`dsh-web-app`（bundle 装配）。
- 官方模型资料：`Qwen/Qwen-Image-2.1` 模型卡与 [GitHub README](https://github.com/QwenLM/Qwen-Image-2.1)（架构、快速开始、比例表、内存优化、[diffusers PR #14804](https://github.com/huggingface/diffusers/pull/14804)、[vLLM-Omni recipe](https://recipes.vllm.ai/Qwen/Qwen-Image-2.1)、[GGUF 量化](https://huggingface.co/Abiray/Qwen-Image-2.1-GGUF)）。
- 同命名空间既有实现参考：`<本地参考实现>`（host/client 双半、`tool.call.toolview`/`conversation.view` 槽用法、esbuild→`__ModuleLoader__.load` 客户端构建、Python sidecar + 冒烟/验收习惯）。
