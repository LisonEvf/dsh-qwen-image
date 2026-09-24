# 工具面（@lisonevf/dsh-qwen-image）

模型可见工具（见 docs/PLAN.md §5）。所有耗时数字来自本机 P40/fp16 实测，见 `docs/HARDWARE.md`。

| 工具 | 用途 | 关键参数 |
| --- | --- | --- |
| `image_status` | 体检权重/环境/worker，给出可复制命令。**永不失败** | `refresh` |
| `image_worker` | worker 生命周期 | `action`: start/stop/unload/warm/status/logs |
| `image_generate` | 对话生图 | `prompt`, `preset`/`width`/`height`/`ratio`, `transparent`, `count`, `mode`, `reference` |
| `image_edit` | 对话改图 | `prompt`, `image`(必填), `images`, `mask`, `preset` |
| `image_result` | 取回结果 | `id`（缺省取最新；`'list'` 列历史） |
| `image_model_fetch` | 代办下载权重 | `confirm`(必填), `include`, `repo`, `localDir` |

## 实测耗时（决定用户该选哪个档位）

| 预设 | 尺寸/步数 | 实测总耗时 |
| --- | --- | --- |
| `draft` | 768² / 12 步 | **≈ 2.5 分钟** |
| `standard` | 1024² / 24 步 | **≈ 5.0 分钟**（3 次实测 304.2/301.6/303.4 s） |
| `native` | 2048² / 40 步 | **≈ 43 分钟**（建议 `mode=background`） |

耗时构成：**首步 78–93 s（每张图都重付）+ (步数−1) × 稳态 + VAE 解码 15–104 s**。
稳态步**超线性**于像素（`≈ 8.96 × MP^1.34`），2048² 达 61.19 s/步。

> 若 worker 尚未加载模型，另需 55–141 秒加载 30.9GB 权重；加载后的**第一张**图还要多约 100 秒。

## 输出规范值

```
image_generate / image_edit →
{ ids[], files[], width, height, seed, steps, preset,
  elapsedSec, steadyStepSec, peakVramMiB, hasAlpha,
  device, dtype, count, estimateText, status }
```

`image_edit` 另附 `inputImage`、`usedReferences`、`maskMode`。

`output.presentationMeta` 投影 `{ ids, width, height, seed, steps, elapsedSec, hasAlpha }`
—— **这是客户端卡片拼图片 URL 的唯一依据**，持久化在 `tool/result` 上，刷新/回放都能重现。

## 交互设计：对话负责生成，相册负责管理与回顾

两个界面注册点，职责分明：

| 注册点 | 角色 | 做什么 |
| --- | --- | --- |
| `tool.call.toolview`（key = `image_generate` / `image_edit`） | **主路径** | 生图/改图就在对话流里出卡片，当场看到图 |
| `conversation.view`（id = `qwen-image`，label = 相册） | **辅助** | 回顾 + 管理：查询/排序/分类/改元数据/删除（可还原） |

**为什么相册不放生成入口**：如果相册里也放一套生成/改图入口，就会有两套入口与两套语义
（「在面板里选图改」vs「在对话里指代图改」）。生成永远在对话里；相册只负责另一半——
**回头翻、找得到、管得住**：

| 能力 | 说明 |
| --- | --- |
| 查询 | 提示词 / id / seed / 标签 / 备注 全文；时间范围；类型；尺寸；**多标签 AND** |
| 排序 | 时间 / 文件大小 / 步数 / 耗时 / 宽度 / seed / 编号，升降序一键切换 |
| 分类 | 按日期 / 标签 / 类型 / 尺寸分组；筛选面板的计数是**全量**口径 |
| 改 | 改提示词、加/删标签（单个或批量）、收藏、备注；改过的记录标 ✎ |
| 删 | 删除**默认移入回收站**（`<outputs>/_trash/<时间戳>/`，连同 PNG/缩略图/sidecar 一起搬），可整条还原；`purge` 才真删 |

### 对话式工作流（由随包技能 + 工具描述共同驱动）

| 环节 | 谁做 | 怎么做 |
| --- | --- | --- |
| 提炼意图 | LLM | 用户说一句话（「画只戴墨镜的柴犬」），LLM 按「主体→场景→风格→光照→构图→画质」扩写成完整提示词 |
| 让用户可纠正 | LLM | 在回复里贴出最终 prompt，用户一句话就能改 |
| 选档位 | LLM | 未指定时先 `draft` 对齐，满意后 `standard` 定稿；`native` 必须走 background |
| 报耗时 | LLM | 动手前告知预计耗时（含每图约 85 秒冷启动） |
| **选历史图** | LLM | 「刚才那张」→ `image='latest'`；描述性指代（「有猫的那张」）→ 先 `image_result id='list'` 匹配后再传 id；匹配不上就把列表给用户挑，**不许猜** |
| 出图 | 卡片 | 图片经同源 `/raw?id=` 内联渲染，点图放大，可复制 id/链接 |
| 回顾/整理 | 相册 | 网格 + 搜索 + 排序 + 分组 + 批量打标签 + 删除（回收站） |

**为什么这样能成立**：

- **提示词扩写** —— `prompt` 参数的描述里明确写着「**已扩写好的**描述（不是用户原话）」，
  随包技能里给了扩写配方与逐维示例；模型每次调用都会看到这些约束。
- **历史图选择** —— `image_result id='list'` 返回每张图的 `prompt`/尺寸/步数/seed/id
  （新→旧，与相册同序），足以做语义匹配；`image_edit.image` 的描述里也明确要求
  「描述性指代先 list 匹配，不要猜」。
- **显示与模型视觉能力解耦** —— 卡片与相册都走宿主同源路由，与当前路由能否看图无关。

### 相册为什么加载快

网格里几十张图若每张都拉整张 1024² PNG（约 1MB），回顾会明显发卡。
所以：

- **worker 在存图时顺手生成缩略图**（`<id>.thumb.webp`，长边 ≤384；WebP 不可用时回落 `<id>.thumb.png`）——
  PIL 已在保存 PNG 的进程里，**零新增依赖**，一次生成、之后零成本。
  宿主侧不做按需缩放：Node 标准库不做图像缩放，引入 native 依赖或每张一次子进程都不划算。
- 网格走 `/thumb`，**点开灯箱才拉 `/raw` 原图**。
- 早期生成的图没有缩略图 → `/thumb` **回退返回原图**（响应头
  `X-Qwen-Image-Thumb: fallback-raw` 便于诊断），宁可慢一点也不留空白格。

### 工具内联卡片

- **运行中**：spinner + 已用时 + 依据实测标定的进度条 + 诚实的耗时提示。
- **已完成**：图片 + 元信息徽章（尺寸/步数/seed/耗时/RGBA）+ 点图放大 + 复制链接。
  透明图用棋盘底衬托 alpha；`meta` 缺失时（旧日志）退回从文本内容兜底提取 id。

## 同源路由

| 路由 | 用途 |
| --- | --- |
| `GET /api/qwen-image/raw?id=…` | 原始 PNG（**显示保底通道**，长缓存） |
| `GET /api/qwen-image/thumb?id=…` | 缩略图（相册网格用；无缩略图则回退原图） |
| `GET /api/qwen-image/gallery.json` | 相册列表：查询 + 排序 + 分页 + 筛选计数（一次带回） |
| `GET /api/qwen-image/facets` | 仅筛选计数（类型/尺寸/步数/标签/日期天数） |
| `GET /api/qwen-image/meta?id=…` | 单张元信息 |
| `GET /api/qwen-image/trash.json` | 回收站列表 |
| `POST /api/qwen-image/update` | 改元数据：`prompt` / `note` / `favorite` / `tags` / `tagsAdd` / `tagsRemove` |
| `POST /api/qwen-image/delete` | 删除：默认移入回收站；`purge=true` 真删 |
| `POST /api/qwen-image/restore` | 从回收站还原 |
| `POST /api/qwen-image/recover` | 扫产物目录，补录「磁盘上有、注册表没有」的孤儿作品（宿主入库前出错留下的；manifest 损坏时也是重建通道） |
| `GET /api/qwen-image/health` | 插件侧状态汇总（worker + 相册/回收站计数） |
| `POST /api/qwen-image/unload` | 卸载模型释放显存（相册页脚按钮） |
| `POST /api/qwen-image/cancel?job=…` | 取消（转发给 worker） |

`gallery.json` 的查询参数（都可组合）：

| 参数 | 说明 |
| --- | --- |
| `q` | 自由文本，匹配 提示词 / id / seed / 标签 / 备注 |
| `sort` / `order` | `createdAt`(默认) `bytes` `steps` `elapsedSec` `width` `height` `seed` `id`；`desc`(默认) / `asc`。白名单外的字段回落 `createdAt` |
| `kind` | `generate` / `edit` |
| `tag` | 标签，逗号分隔即 **AND** |
| `size` | 最长边（对齐 preset 档位：768 / 1024 / 2048） |
| `fav` | `1` 只看收藏 |
| `from` / `to` | `createdAt` 区间（epoch ms 或日期字符串） |
| `limit` / `offset` | 分页（limit ≤ 1000） |

写接口（`update` / `delete` / `restore`）**同时接受 JSON body 与 query 参数**
（`?ids=a,b&favorite=1`）：前者给界面用，后者让 curl / PowerShell 一句话就能验证。

路由前缀可配置（`routePrefix`）。宿主通过 `webServer.tapIndex` 把它注入
`window.__QWEN_IMAGE__`，客户端读到就用、读不到回退默认 —— **改配置不会断图**。

## 已知限制

- **无独立 mask 参数**：`QwenImage21Pipeline` 没有 mask 张量输入。局部编辑走官方
  「在图上画圆圈/涂抹标注，把标注图作为条件图传入」路径。插件把独立 mask 合成为
  红色半透明标注后并入条件图（`capabilities.supports.mask=false`、`maskViaAnnotation=true`）。
- **不支持 bf16 以下的 P40 走 fp32**：实测 fp16 更快，故 sm≥6 一律 fp16。
- **缩略图只对新生成的图有**：早期生成的图没有 `<id>.thumb.webp`，相册会回退原图
  （见 `/thumb` 的 `X-Qwen-Image-Thumb: fallback-raw`）。若要为旧图补缩略图，
  跑一次即可：`python -c "from PIL import Image; ..."`，或直接重新生成。
