# 验收证据日志（@lisonevf/dsh-qwen-image）

> 记录每个里程碑的验收证据与实测数字。所有结论都有对应的日志文件可复核。
>
> **阅读说明**：本目录是**开发过程中的原始证据**，面向想核对实测数字的人，不是使用手册。
> 日志里的「本机」指作者的标定机（Windows 11 / Tesla P40 24GB / 32GB RAM / CUDA 12.8）。
> 公开发布时已把日志中的本机用户目录做了脱敏（`C:\Users\<用户>\…`），其余内容保持原样未改 ——
> 因此**文中的路径只对作者的机器成立**，你复现时请换成自己的路径。
> 档位耗时的**当前权威口径**见 `docs/HARDWARE.md`。

---

### 迭代 4 的意外收获：定位了一次「无报错的段错误」

改完缩略图后，**所有**生图开始失败，且非常费解：

- worker 能启动、模型能加载（日志有「加载完成 60s」）
- 在**去噪刚开始**时进程直接消失，HTTP 侧只有 `fetch failed`
- Windows 退出码 **3221225477 = 0xC0000005（段错误）**，**Python 侧没有任何 traceback**
- 更迷惑的是：**未经改动的 `hw_probe.py`（M0 时跑通过的代码）也一起崩了**

排查路径（记为方法论）：

| 步骤 | 结论 |
| --- | --- |
| 查 Windows 事件日志 | 无 python 崩溃记录，拿不到 faulting module |
| CUDA 微基准（不加载模型） | **正常**（fp16 10.01 TFLOPS）→ GPU/驱动没问题 |
| 重跑**未改动**的已知可用路径 | **同样段错误** → 排除「是我刚改坏了代码」 |
| 查提交内存 / 进程 | **找到真凶** |
| 旁证 | `hw_probe` 报「RSS 32MiB」（正常数百 MB）—— 页被大量换出时 RSS 会异常低 |

**真因**：一个**残留的 python 进程占着 65.7 GB 私有（提交）内存**，工作集仅 8 MB
（几乎全被换出）。它把提交上限吃满后，此后每次加载 30.86 GB 权重都在去噪瞬间崩进程 ——
因为权重走 **mmap**，**提交空间不足时是直接崩，而不是抛可捕获的异常**。

释放后提交内存 **78.66 GB → 12.59 GB**，生图立刻恢复正常。

**教训**：

1. **「无报错的进程崩溃」先看内存/提交，不要先怀疑代码。** 尤其在改动刚做完的时候 ——
   人很容易把环境问题和自己的改动搅在一起。
2. **用一个未改动的已知可用路径做对照**，能一秒把「代码问题」和「环境问题」分开。
3. 排查时**不要并发跑别的吃内存任务**：我曾一边跑集成测试、一边跑一个逐像素构造大图的
   Python 脚本（几十万次解释器迭代），与正在加载 30 GB 的 worker 争内存，把 worker 拖死。

**已固化为产品能力**：`image_status` 现在前置报告可用内存与提交占用 ——
< 20 GB 红色告警并提示排查残留 python 进程，< 32 GB 黄色提示。
`env-probe` 新增 `memory` 采集（psutil）。这条守卫就是为这个「最难定位的故障」加的。

同时把那个逐像素构造的测试图改成 `os.urandom + Image.frombytes` 一次性构造
（21 项断言从「慢且吃内存」变成 **0.9 秒**）。

---

## 迭代 4：相册回归 —— 但定位改为「只读历史回顾」

### 需求变更（用户提出）

> 还是把「画室」面板加回来吧，但是定位是历史相册，用于快速回顾历史生成的图片。

**落实方式**：

| 项 | 做法 |
| --- | --- |
| 面板回归 | 恢复 `conversation.view` 注册，id = `qwen-image`，label = **相册**，order = 6 |
| 定位改为回顾 | 组件重写为 `album.tsx`：**只读**。缩略图网格 + 提示词搜索 + 大图与元信息 + 复制 id/提示词 + 下载 + 「释放显存」 |
| 明确不做 | 不放任何生图/改图入口 —— 否则会出现两套入口与两套语义（「面板里选图改」vs「对话里指代图改」）。对话**仍是主路径** |
| 技能同步 | 技能里写明「相册是只读回顾；生成/改图请在对话里说」；并规定：用户说「相册里第 3 张」时，LLM 用 `image_result id='list'`（新→旧，与相册同序）定位，**不依赖视觉位置** |

### 为「快速回顾」做的一处性能工程

多图浏览的瓶颈很具体：**网格里几十张图若每张都拉整张 1024² PNG，回顾会明显发卡。**

| 方案 | 取舍 |
| --- | --- |
| 宿主按需缩放 | ✗ Node 标准库不做图像缩放；要引入 native 依赖（sharp），或每张一次子进程 |
| **worker 存图时顺手生成缩略图** | ✓ **PIL 已在保存 PNG 的进程里，零新增依赖**，一次生成、之后零成本 |

于是：`save_outputs` 额外产出 `<id>.thumb.webp`；网格走 `/thumb`，**点开灯箱才拉 `/raw` 原图**；
早期生成的图没有缩略图 → `/thumb` **回退返回原图**（响应头 `X-Qwen-Image-Thumb: fallback-raw` 便于诊断），
宁可慢一点也不留空白格。

**格式选择也是量出来的**（同一张 1024² 原图）：

| 缩略图格式 | 体积 | 占原图 |
| --- | --- | --- |
| 原图 PNG (1024²) | 902,034 B | 100% |
| 缩略图 **PNG** (384) | 212,500 B | 23.6% |
| 缩略图 **WebP q82** (384) | **≈30 KB** | **≈3%** |

PNG 是无损格式，照片类内容压不动 —— 对「几十张一起扫」的相册，**6× 的差距**在带宽、解码与内存上都明显。
WebP 同时支持 alpha，所以透明图也用它，无需按有无 alpha 分两种格式。
若某台机器的 Pillow 缺 WebP 支持，自动回退 PNG，且**媒体类型由实际文件推断**
（`Content-Type` 不再写死 `image/png`）。

### 本轮新增/变更

- `worker/pipeline_qwen21.py`：`save_outputs` 产出 WebP 缩略图（含回退路径），sidecar 记录 `thumb`/`thumbMediaType`/`thumbBytes`
- `src/host/routes.ts`：新增 `/thumb`（媒体类型随文件）与 `/unload`（相册页脚按钮）
- `src/host/registry.ts`：`thumb`/`thumbMediaType` 贯通注册表与 manifest；`readThumbBytes` 回退原图
- `src/client/album.tsx`：历史相册（只读）
- `src/client/{index,styles,api}.ts(x)`：恢复视图注册、相册样式、`thumbUrl`/`fetchGallery`/`requestUnload`

### 测试

| 套件 | 变化 |
| --- | --- |
| 客户端契约 | 24 → **27**（新增「注册 conversation.view」「网格用 /thumb」「灯箱用 /raw」「相册只读」断言） |
| 宿主端到端 | 81 → **90**（新增 `/thumb` 200+回退标注+404、`/gallery.json` 带 `thumbUrl`/`hasThumb`、`/unload` 转发） |
| 集成（真 GPU） | 19 → **27**（新增「缩略图落盘」「WebP 格式」「≤ 原图 12%」「`Content-Type` 与实际一致」「字节与磁盘一致」） |

> 一个测试顺序上的坑：`/unload` 的断言必须放在 `image_worker status` **之后** ——
> 调用它会真的把假 worker 置为 `idle`，放前面会破坏「status 报告 ready」。

---

## 迭代 3：改为纯对话式交互 + 修掉三个真实缺陷

### 需求变更（用户提出）

> 不要「画室」面板，而是在正常对话中无缝添加；我提出需求后由 LLM 完善提示词，
> 并从上下文中选择合适的历史图片作为输入。

**落实方式**：

| 项 | 做法 |
| --- | --- |
| 移除独立面板 | 删除 `src/client/studio.tsx` 与画室样式；**不再注册 `conversation.view`**；客户端只剩 `tool.call.toolview` 两个内联卡片 |
| LLM 完善提示词 | `prompt` 参数描述改为「**已扩写好的**描述（不是用户原话）」；随包技能新增「提示词扩写配方」（主体→场景→风格→光照→构图→画质，逐维示例） |
| LLM 选历史图 | `image_result` 描述明确为「从上下文挑历史图的主力工具」；`image_edit.image` 要求「描述性指代先 `id='list'` 匹配再传 id，**不要猜**」；技能里给出对照表（`latest` / 本轮已有 id / 描述性指代 / 风格参考） |
| 排期与透明 | 技能规定「先 draft 对齐，满意后 standard 定稿；native 必须走 background；动手前报耗时；扩写后的 prompt 要贴给用户看」 |

**为什么这样能生效**：工具描述在**每次调用**时进入模型上下文，随包技能在需要时加载 ——
两者共同把行为约束变成模型可见的规则，而不是靠用户记住怎么用。

### 顺带修掉的三个真实缺陷

| 缺陷 | 根因 | 影响 |
| --- | --- | --- |
| 工具描述里出现 **`NaN` 秒冷启动** | 重构 `speed-profile` 时把 `coldFirstStepSec` 拆成 `FIRST_STEP_SEC`，但 `index-inject.ts` / `image-generate.ts` 仍引用旧字段 | 模型看到「重付约 NaN 秒」，用户看到错信息 |
| `draft` 耗时显示 4.2 分 | `measuredTotalSec` 存的是**加载后首张**的 250.67s（含 loadExtra ≈ +100s），不代表常态 | 高估交互成本；改为按三段式计算 ≈2.6 分，与 standard 口径一致 |
| 显式配置的 `pythonExe` 被**静默忽略** | Windows Store 的 python 是**应用执行别名**（reparse point）：跟随它 `statSync`/`realpathSync` 抛 **EACCES**，而 Node 的 `existsSync` 对任何 stat 异常都返回 **false** → 被误判为「不存在」 | 显式配置失效、降级到 PATH 探测并打出一条误导警告。改用「`existsSync` **或** `lstatSync` 成功即算可用」（`pathUsable()`） |

> 第三个缺陷只有靠「真进程 + 真配置」才暴露得出来 —— 见下面的新增集成测试。

### 新增测试：补上最后一段未验证的集成路径

之前两类测试各覆盖一半（假 worker 验宿主逻辑 / 真 worker 验 Python 协议），
但**「管理器 spawn 真进程 → 解析 PORT → 真加载 → 真推理 → 注册表 → `/raw`」**
这条集成路径从未被端到端验证过。

新增 `scripts/smoke-integration.mjs`：用基于 `node:child_process` 的**真实
`ctx.subprocess` 适配器**驱动真实插件产物。实测 **19/19 通过**：

| 验收点 | 结果 |
| --- | --- |
| `resolvePython` / `resolveScript` 解析出的路径**真能跑** | ✅ |
| spawn → 解析 `PORT=<n>` → WorkerClient 打通 | ✅ |
| `/load` 真加载 30.9GB 权重（实测 111.2s） | ✅ |
| 真推理 512²/4 步（103.04s，稳态 1.723s/步，峰值 16767MiB） | ✅ |
| PNG 落盘 + **magic 校验** + sidecar + manifest.json | ✅ |
| `/raw` 返回 200 / `image/png`，**字节与磁盘一致** | ✅ |
| `image_result` 列得出、取得到 | ✅ |
| `image_worker stop` 后子进程全部退出（1 → 0，**无僵尸**） | ✅ |
| 显式 `pythonExe` 未被误判为不存在（回归上述缺陷 3） | ✅ |

### 当前测试总览

| 套件 | 结果 |
| --- | --- |
| 产物自包含（零外部依赖） | 20 / 20 |
| 宿主单元 | 13 / 13 |
| 宿主端到端（无 stub + 假 worker） | 81 / 81 |
| 客户端 bundle 契约（含「画室已移除」断言） | 24 / 24 |
| 真实 dsh-tools + dsh-skill 校验 | 41 / 41 |
| profile 解析 | 10 / 10 |
| **宿主 × 真实 worker 集成（真 GPU）** | **19 / 19** |
| worker 协议端到端（真 GPU） | 35 / 35 |
| **合计** | **243 / 243** |

---

## 🔴 修复 2：技能注册失败（`non-string provider`）

### 现象

插件加载后运行时报：

```
skill provider "dsh-qwen-image" returned skill "dsh-qwen-image" with a non-string provider
```

### 根因（读 `dsh-skill` 源码定位）

第一版用 `ctx.skills.registerProvider(factory)`。该路径有更严的候选校验
（`validateCandidate(candidate, providerName)`），`list()` 返回的**每个 candidate** 必须满足：

| 字段 | 要求 |
| --- | --- |
| `name` | string，且匹配 `/^[a-z0-9]+(?:-[a-z0-9]+)*$/` |
| `description` | 非空 string |
| `invocation` | 可选；若给则须 `{modelInvocable: boolean, userInvocable: boolean}` |
| `whenToUse` | 可选 string |
| `source` | string |
| `rank` | **有限 number** |
| `provider` | **string，且必须 `=== provider 自己的 name`** |
| `path` | 可选 string |

我的 candidate **漏了 `provider`**（报错直接命中）；而 `get()` 里写的
`provider: 'qwen-image'` 又与 provider 的 `name: 'dsh-qwen-image'` 不一致
（会命中紧随其后的另一条：`returned skill ... for provider ...`）。

### 修复

改用**运行时技能注册** —— 即本仓库已验证可用的 `dsh-plugin-dev-kb` 走的同一条路径：

```js
ctx.skills.register({ name, description, whenToUse, source: 'runtime', content, resourceBase })
```

缺省项由 registry 补齐，无候选校验。同时技能内容改为**从随包 markdown 读取**
（`skills/dsh-qwen-image.md`）作为唯一来源，避免在 TS 里再维护一份；
读不到时退回内置精简版，保证能力永不丢失。

### 顺带修的两处

- `resourceBase.path` 原为 `lib/../skills` 这类含 `..` 的穿越路径 → 已 `path.resolve` 归一化。
- e2e 的假 `skills` 服务**刻意只实现 `register`，不实现 `registerProvider`** ——
  一旦代码退回 provider 路径，测试立刻以 undefined 调用失败暴露，而不是拖到运行时。

### 新增校验（`verify-against-real-dsh.mjs` → 41 项）

用**真实的 `dsh-skill`** 校验：真实导出 `isSkillName` 判定技能名、按
`validateRuntimeSkill` 的规则校验 description/invocation、断言 register 路径
**不带** `provider`/`rank`（那是 provider 路径字段）、`resourceBase` 目录真实存在且已归一化、
模板占位符全部替换。

### 教训

**同一能力有多条注册路径时，先抄本仓库里已被验证可用那一条的形状**，
而不是照最"完整"的接口（`SkillProvider`）自己拼。`registerProvider` 的
`SkillCandidate` 要求一个自指的 `provider` 字段，是很易漏的隐式约定。

---

## 测试总览（本次运行）

| 套件 | 命令 | 结果 | 覆盖 |
| --- | --- | --- | --- |
| **产物自包含检查** | `node scripts/check-host-deps.mjs` | **20 / 20** | 零外部依赖、Config Standard Schema、可独立 require |
| 宿主半单元冒烟 | `node scripts/smoke-host.mjs` | **13 / 13** | 纯函数、参数校验、命令构造 |
| **宿主半端到端**（无 stub + 假 worker） | `node scripts/smoke-host-e2e.mjs` | **73 / 73** | 真实加载 lib/index.cjs，跑通全部工具与路由 |
| **真实 dsh-tools 校验** | `node scripts/verify-against-real-dsh.mjs` | **30 / 30** | 用官方验证器校验全部工具 schema |
| **profile 解析校验** | `node scripts/check-profile-resolution.cjs` | **10 / 10** | 从 profile 视角解析并加载两个半 |
| 客户端 bundle 契约 | `node scripts/smoke-client.mjs` | **24 / 24** | ModuleLoader 契约、槽位注册、显示闭环 |
| worker 协议端到端（真 GPU） | `node scripts/smoke-worker.mjs` | **35 / 35** | 真启动 Python worker，真推理，落盘校验 |
| **合计** | | **205 / 205** | |

---

## 🔴 关键修复：插件启动失败（`Cannot find module '@deepseek-ai/dsh-tools'`）

### 现象

profile 启动时报错，**整个插件树加载失败**（不是降级，是启动中止）：

```
Error: dsh: plugin tree failed to load: failed to apply loader entry include (cordis:include):
failed to import loader entry qwen-image (@lisonevf/dsh-qwen-image):
Cannot find module '@deepseek-ai/dsh-tools'
```

### 根因

插件以 **`link:`** 方式装进 profile。Node 解析 `require()` 按 **realpath** 走，
解析基准是插件的真实目录 `…/dsh-qwen-image/lib/`，向上查找链为：

```
dsh-qwen-image/lib/node_modules → dsh-qwen-image/node_modules
→ dsh-qwen-image-2.1/node_modules → … → C:\node_modules
```

而 `@deepseek-ai/dsh-tools` 住在 **dsh 安装目录内**
（`…\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-tools`），
**不在这条链上**。实测确认：

| 解析起点 | `@deepseek-ai/dsh-tools` | `@deepseek-ai/schemastery` |
| --- | --- | --- |
| 插件目录 | ✗ MODULE_NOT_FOUND | ✗ MODULE_NOT_FOUND |
| profile 目录 | ✓ | ✓ |

### 既有约定（权威依据）

本仓库既有的第三方插件 `dsh-plugin-dev-kb` 在源码注释里就写明了这条纪律：

> **依赖纪律**：本模块不 import 任何 `@deepseek-ai/*` 运行时包
> （插件以 `link:` 方式装入 profile，Node ESM 按 realpath 解析链接包，
> 外部依赖从插件目录解析不到；这里本来也不需要）。

旁证：`dsh-plugin-dev-kb`（4.8 KB）与 `gal-view`（644 B）的产物里
**`require(` 出现次数均为 0** —— 它们把一切内联，从不依赖外部解析。

### 修复

**让 host 半产物零外部依赖**，新增两个自包含模块：

| 新模块 | 替代 | 做法 |
| --- | --- | --- |
| `src/host/tool-dsl.ts` | `@deepseek-ai/dsh-tools` 的 `defineTool` | 自实现 DSL→JSON Schema 转换 + 输出 schema 校验；**与官方产物逐字兼容**（已实测比对） |
| `src/host/config-schema.ts` | `@deepseek-ai/schemastery` | 自实现 Standard Schema v1（`~standard.validate`），填充默认值 + 类型/范围校验 |

依据：`Tools.register()` 只要求**结构上**符合 ToolDefinition 的对象
（`name` + `output:{schema,render,presentationMeta?}` + 可选正数 `timeoutMs`），
且只校验 `output.schema`（读源码确认）。故自实现完全等价。

修复后实测：`lib/index.cjs` 的**真实 `require()` 调用为 0**（仅剩 `node:` 内建），
且能被独立 `require`、能从 profile 视角正常解析并加载。

### 顺带挖出的两个**潜在**运行时缺陷（原测试因 stub 而漏掉）

早期 e2e 用 identity 的 `defineTool` stub，**掩盖了真实契约违规**。
改为直接加载产物（无 stub）后，暴露出两个会在真实运行时被拒的问题：

| 缺陷 | 真实约束 | 修复 |
| --- | --- | --- |
| 参数写 `minimum`/`maximum` | 官方参数 DSL **不支持**这些键。实测白名单只有 `type/description/required/enum/default/examples/title/items/additionalProperties/oneOf`；`minLength/maxLength/pattern/format` 同样不支持 | 删掉，范围写进 `description`，由 `execute` 内强制校验 |
| output schema 的 object 未声明 `additionalProperties` | **每个** object 节点（含数组 `items` 内、嵌套对象、裸 `{type:'object'}`）都必须**显式** `true`/`false` | 全部补 `additionalProperties: true`（宽容，避免可选字段误拒） |

> 教训：**stub 掉的契约就是没测的契约**。identity stub 让"能注册"变成假象，
> 而真实的 `assertSupportedJsonSchema` 会在注册时抛错。

### 新增的三个验证套件

1. `check-host-deps.mjs` —— 断言产物零裸包 require、可独立 require、
   Config 是合法 Standard Schema（含默认值填充与非法值拒绝）。
   先剥离注释与字符串，避免把文档里的示例文本误判成依赖。
2. `verify-against-real-dsh.mjs` —— **从 profile 加载真实的 `@deepseek-ai/dsh-tools`**，
   用它校验 6 个工具的 `output.schema`（`assertSupportedJsonSchema`）、
   parameters 结构不变式、required 提升，并与官方 `defineTool` 产物逐字比对。
3. `check-profile-resolution.cjs` —— 从 profile 视角 `require.resolve` 两个半并真实加载，
   走的就是 DSH loader 启动时的同一条路径。

---

### 三段式耗时模型实测吻合（误差 0.0%）

最后一次真 GPU 验收（512²/4 步）：

```
实测总耗时 164.6s｜首步 136.798s｜稳态 1.717s/步｜VAE 解码 22.65s｜峰值显存 16767MiB
三段式模型：136.798 + 3×1.717 + 22.65 = 164.60s  →  误差 0.0%
```

这证明 `speed-profile.ts` 的 ETA 模型（首步 + 步数×稳态 + VAE）是准确的，
界面卡片与画室面板给出的预估因此可信。

---

## M0 可行性尖峰 ✅

### 硬件与环境（实测）

| 项 | 值 |
| --- | --- |
| GPU0 | **Tesla P40**，sm_61（Pascal），24473 MiB，驱动 576.80，TCC |
| GPU1 | GTX 1660 SUPER，sm_75，6144 MiB —— **不可见**（`CUDA_VISIBLE_DEVICES=0`，torch 报 device_count=1） |
| RAM | 31.95 GB 总 / 24.9 GB 空闲 |
| torch / transformers / diffusers / accelerate | 2.7.1+cu128 / 5.17.0 / **0.41.0.dev0**（main）/ 1.15.0 |

### 🔑 关键发现：P40 的 fp16 完全可用（推翻 PLAN 原假设）

`acceptance/m0-microbench.log`（4096² matmul × 20 次）：

| dtype | 实测算力 | 相对 fp32 |
| --- | --- | --- |
| fp32 | 8.642 TFLOPS | 1.00× |
| **fp16** | **10.009 TFLOPS** | **1.16×（更快）** |
| bf16 | 5.053 TFLOPS | 0.58×（软件模拟） |

PLAN §1.1/§6.1 曾假设「P40 fp16 算力 1/64，必须 fp32 + sequential offload」。**实测证伪**：
cuBLAS 在 Pascal 上对 fp16 GEMM 走高效通路。**fp16 成为本机最优精度**，且把 RAM/VRAM 需求减半 ——
这是能在 32GB RAM + 24GB VRAM 上跑通的决定性因素。bf16 必须避免。

### 标定结论

**生效配置：`fp16` + `cuda:0`(P40) + `offload=model` + `vae tiling`**

| 指标 | 实测 |
| --- | --- |
| 权重加载 | **55 – 141 s**（mmap 按需分页，随页缓存状态波动） |
| 加载后 RSS | **629 MiB**（权重未常驻物理内存） |
| 峰值显存 | **16767 – 16771 MiB**（恒定，与尺寸无关；vae tiling 生效） |
| 输出 | 原生 **RGBA** 4 通道 |

### 四段式耗时模型（逐点计时拟合）

```
total ≈ loadExtra + firstStep + (steps−1) × steady + vaeDecode
```

| 分量 | 实测 |
| --- | --- |
| `loadExtra`（加载后首张图额外） | ≈ **+100 s** |
| `firstStep`（每图重付） | **78 – 93 s** |
| `steady`（**超线性**于像素） | `steady ≈ 8.96 × MP^1.34` |
| `vaeDecode` | 24 s @768² / **26 s @1024²** / 69 s @2048² |

逐点计时实测（`acceptance/m0-preset-bench.log`）：

| 档位 | 像素 | 步数 | 实测总 | 首步 | 稳态/步 | 峰值显存 |
| --- | --- | --- | --- | --- | --- | --- |
| draft 768² | 0.59 MP | 12 | 250.67 s | 177.79 s ⚠️ | **4.426 s** | 16767 MiB |
| standard 1024² | 1.05 MP | 24 | 302.80 s | 78.07 s | **8.819 s** | 16771 MiB |
| native 2048² | 4.19 MP | 3 | 283.58 s | 93.46 s | **60.705 s** | 16771 MiB |

> ⚠️ draft 首步 177.79 s 因为它是**加载后第一张图**（含 loadExtra）；standard 跑在其后，首步回落到 78 s。

**稳态步超线性**（注意力 O(n²)）：像素 4×（1.05→4.19 MP）→ 步耗时 **13.7×**。
线性外推会让 2048² 低估约 40%，故插件改用幂律外推。

### 首步冷启动**每图重复**（`acceptance/m0-repeat-3.log`）

| 次序 | 总耗时 | 首步 | 稳态 | RSS |
| --- | --- | --- | --- | --- |
| #1 | 311.7 s | 83.1 s | 8.84 s/步 | 23062 MiB |
| #2 | 301.6 s | 72.1 s | 8.97 s/步 | 14167 MiB |
| #3 | 303.4 s | 73.0 s | 9.01 s/步 | 6563 MiB |

权重 30.86 GB vs RAM 31.95 GB → 页缓存被逐出 → 每图重新读入 text_encoder（16.33 GB）。
**预热无法消除**；根治只能加 RAM 到 64 GB 或改用量化权重。

### 各档位结论

| 档位 | 实测/推算 | UI 文案 |
| --- | --- | --- |
| `draft` 768²/12步 | **≈ 2.5 分**（非首张） | 交互首选 |
| `standard` 1024²/24步 | **303 s（3 次：304.2/301.6/303.4）** | 质量更好 |
| `native` 2048²/40步 | **≈ 43 分钟**（按 61.19 s/步幂律外推） | 仅后台任务 |

**M0 决策门判定**：P40 可用（~5 分/张，无 OOM，显存余量 7.3 GB）
→ **默认后端保持 `diffusers`**，不启用 `openai-images`，与用户既定选择一致。

### 图像有效性

fp16 生成的 512² 图：**77101 种唯一颜色**、rgbMin=0/rgbMax=255、16 桶直方图均匀铺开
→ 正常可用。`image_processor.py:142` 的 `invalid value encountered in cast` 警告为良性边界值，非 NaN。

---

## M1 骨架 + 体检 + 技能 ✅

- **A1 安装**：`dsh plugin --profile web add ./dsh-qwen-image` 成功 link；
  `dsh --profile web --dump-config` 出现 `# == @lisonevf/dsh-qwen-image` 层，19 项配置全部正确加载。
- 产物：`package.json`（`dsh.bundle.patch` + `dsh.client`）、`cordis.patch.yml`、`tsdown.config.mts`、
  `src/host/config.ts`（Schemastery，19 字段，无硬编码）、`model-inspect.ts`、`env-probe.ts`、
  `image_status`、`skill.ts`（`{{MODEL_DIR}}`/`{{OUT_DIR}}` 注入）、`worker/model_check.py`。

- **A2 体检**：`image_status` 在「缺权重」盘面正确报 `missing` 并给出 3 条可复制命令
  （指向既有目录 / `hf download` 带镜像 / diffusers 安装）；**永不抛异常**（e2e 已验证）。
- **A9 无硬编码**：19 个配置项全部可在 `cordis.patch.yml` 改到，含 `routePrefix`（客户端经
  `webServer.tapIndex` 注入下发，改配置不会断图）。

---

## M2 Python worker ✅

`worker/pipeline_qwen21.py`（推理引擎）+ `worker/server.py`（回环 HTTP）+ `model_check.py` + `bootstrap.py`

**35/35 协议端到端验收**（真启动 worker + 真推理 + 真落盘）：

| 验收点 | 结果 |
| --- | --- |
| worker 启动并打印 `PORT=<n>` | ✅ |
| Bearer token 鉴权（错误/缺失 token 均 401） | ✅ |
| `/health` 结构（state/device/dtype/offload/vram/queueDepth） | ✅ |
| `/load` 成功 + 返回 loadSec + **幂等** | ✅（实测 74.3s / 86.2s） |
| dtype 自动解析为 **fp16**、offload 为 **model** | ✅ |
| `/generate` 返回 202 + jobId | ✅ |
| `/job` 轮询至 completed，带回 images/sidecar/耗时 | ✅ |
| **结果带 `vaeDecodeSec`** 且三段式模型与实测吻合（误差 0.0%） | ✅ |
| **落盘 PNG 合法**（magic 校验）且字节数与上报一致 | ✅ |
| sidecar 含 prompt/seed/steps/耗时/峰值显存 | ✅ |
| 显存守卫：阈值不可达时**拒绝并归因**（含占用进程名/pid/显存 + 处置建议） | ✅ |
| `/logs` 返回日志行 | ✅ |
| `/cancel` 对未知 job 安全返回 | ✅ |
| `/unload` 释放显存 → 状态回 idle | ✅ |
| 卸载后 `/health` 仍可用（非瞬时异常） | ✅ |
| 停止后**无僵尸进程** | ✅ |

### 修掉的真实缺陷

| 缺陷 | 根因 | 修复 |
| --- | --- | --- |
| `/health` 在 `/unload` 之后返回 500 | `torch.cuda.mem_get_info()` 未捕获异常（卸载+ipc_collect 后偶发） | `vram_info()` 全程防御；`/health` 永不 500 |
| `vaeDecodeSec` 丢失 | `server.py` 的 result 投影漏了该字段 | 补进投影（这是 ETA 模型的关键分量） |

---

## M3 host 工具面 ✅

**73/73 端到端验收**（`scripts/smoke-host-e2e.mjs` —— 真实加载 `lib/index.cjs`，
stub 掉 DSH 运行时的 3 个外部模块，喂一个实现同协议的**假 worker**，无 GPU 可跑）：

| 分组 | 验收点 |
| --- | --- |
| 注册 | 6 个工具 + 5 条路由 + index tap + 技能 provider 全部注册成功 |
| 配置下发 | 注入到 `</head>` 前、JSON 可解析、下发 routePrefix 与三档实测耗时 |
| `image_status` | 缺权重盘面正确、给 guidance/commands、render 出文本、永不抛 |
| `image_model_fetch` | 未确认→只给命令不下载；确认→started；命令带 hf-mirror |
| `image_worker` | start（懒启动+加载）、status（含显存）、logs、unload、stop |
| `image_generate` | 走通假 worker → ids/files/尺寸/耗时/estimateText/status；**PNG 真落盘**；manifest 写入 |
| 参数校验 | custom 缺尺寸、尺寸过大、preset 与 width 互斥、count 越界 —— 4 项全部拒绝并给出可操作错误 |
| `image_result` | 取最新、list 模式、未知 id 友好提示、render 含 id/提示词 |
| `image_edit` | 返回新 id、记录 inputImage/usedReferences、未知引用被拒并提示可用选项 |
| **同源路由** | `/raw` 返回 200 + `image/png` + **合法 PNG magic** + 长缓存头；未知 id→404；`/gallery.json` 带 `rawUrl`；`/health` 汇总 worker 状态 |
| 生命周期 | `apply` 注册的 2 个 effect 清理器可执行（worker 终止路径） |

**M0 产物已回灌代码**：`speed-profile.ts` 用幂律模型（`8.96 × MP^1.34`）替代线性；
`loadExtra`/`firstStep`/`vaeDecode` 三段分别建模；`recommendDtype` 改为 sm≥6→**fp16**（修正 PLAN 的错误假设）。

---

## M4 显示闭环 ✅（客户端 bundle 24/24）

**为什么必须自己做卡片**（PLAN 已实测）：默认工具卡把非 text 块 `JSON.stringify`，
图像块只在 trajectory 视图渲染 → **不注册 `tool.call.toolview` 就等于「以为出图了其实看不见」**。

客户端半产物 `lib/client.js`（17 KB）契约校验：

| 验收点 | 结果 |
| --- | --- |
| `window.__ModuleLoader__.load({ id, factory })` 包装 | ✅ |
| factory 形态 `(require) => {...}` 且返回 `module.exports` | ✅ |
| **`react` 保持 external**（与宿主共享实例，hooks 才能工作） | ✅ |
| 未把 react 打进 bundle | ✅ |
| 注册 `tool.call.toolview`，key = `image_generate` / `image_edit` | ✅（两键均未被占用 → 新增而非覆盖） |
| 注册 `conversation.view`，id=`qwen-image`，label=「画室」，order=6 | ✅ |
| **显示闭环**：用同源 `/raw?id=` 拼图片 URL | ✅ |
| 读取宿主注入的 `__QWEN_IMAGE__` 且带默认回退（改配置不断图） | ✅ |
| 读 `block.meta`（`presentationMeta` 持久化投影）、`isError`、`argsRaw` | ✅ |
| 识别 settled 形态 `kind === 'tool-result'` | ✅ |

### 两张卡片的行为

- **运行中**：spinner + 已用时计时 + 依据实测标定的进度条 + 诚实提示
  （「每图另含约 85 秒冷启动」）。
- **已完成**：`<img src="/api/qwen-image/raw?id=…">` + 元信息徽章
  （尺寸/步数/seed/耗时/RGBA）+ 点图放大灯箱 + 复制链接；透明图用棋盘底衬托 alpha。
  `meta` 缺失时（旧日志）退回从文本内容兜底提取 id。

### 「画室」视图

历史网格（5000ms 自动刷新）、worker 状态与显存面板、三档实测耗时 chip、
复制提示词 / 复制 id / 下载 PNG（`download` 属性）、RGBA 标记、改图标记、Esc 可关的灯箱。

---

## 尚未完成（后续里程碑）

| 项 | 状态 | 说明 |
| --- | --- | --- |
| **GUI 实机截图** | ⏳ 待做 | 需重启 DSH profile 加载插件后，在 Web GUI 里对话生图并截图。当前模型路由不能看图，但**卡片显示与模型视觉能力解耦**，故截图验证是必要的最终一步 |
| 真取消一次长任务 | ⏳ 部分 | `/cancel` 端点已验可达且安全；**真正中断一次 5 分钟推理**尚未验 |
| 1660S 标定 | ⏳ 未做 | `CUDA_VISIBLE_DEVICES=0` 使其不可见 |
| 长时间稳定性 | ⏳ 未做 | 已连续 3 张无劣化；更长序列未测 |
| 一键安装器 | ✅ 已完成 | 见文末 M6 章节：`install.bat` / `install.sh` + `installer/*.mjs`，设备矩阵离线冒烟 108/108，本机 scratch 家目录实测 55 秒复用安装 |
| `pnpm pack` + 干净 profile 安装 | ⏳ 待做 | M6 剩余部分（安装器已能注册插件，尚缺 tarball 分发实测） |
| mask 局部编辑实测 | ⏳ 待做 | 已实现「标注图」路径（管道无独立 mask 参数），未做真图验证 |
| 崩溃恢复压测 | ⏳ 待做 | M7 |

---

## 产物清单

```
dsh-qwen-image/
├─ package.json              dsh.bundle.patch + dsh.client(web, inject:[slots])
├─ cordis.patch.yml          host entry + 19 配置项
├─ tsdown.config.mts         host 半打包
├─ src/
│  ├─ index.ts               host 入口（apply 注册工具/路由/技能/index 注入）
│  ├─ host/
│  │  ├─ config.ts           Config schema（19 字段）
│  │  ├─ model-inspect.ts    权重体检
│  │  ├─ env-probe.ts        环境探测 + dtype/offload 推荐（含 M0 修正）
│  │  ├─ speed-profile.ts    ★ M0 四段式耗时模型（幂律）
│  │  ├─ worker-manager.ts   spawn/健康/空闲卸载/崩溃退避/退出清理
│  │  ├─ client-http.ts      worker HTTP 客户端（token/超时/轮询）
│  │  ├─ registry.ts         图像注册表 + manifest + 附件注入
│  │  ├─ routes.ts           同源路由 /raw /gallery /meta /cancel /health
│  │  ├─ index-inject.ts     ★ tapIndex 下发 routePrefix（改配置不断图）
│  │  ├─ skill.ts            随包技能注册
│  │  └─ tools/              6 个工具
│  └─ client/
│     ├─ index.ts            注册 toolview×2 + conversation.view
│     ├─ cards.tsx           ★ 出图卡片（显示闭环）
│     ├─ studio.tsx          ★ 画室画廊
│     ├─ api.ts              hostConfig/rawUrl/fetch*
│     └─ styles.ts           qw- 前缀样式（用主题变量）
├─ worker/
│  ├─ server.py              回环 HTTP（Bearer/串行队列/SSE/取消）
│  ├─ pipeline_qwen21.py     ★ 推理引擎（fp16/model offload/守卫/取消/sidecar）
│  ├─ hw_probe.py            M0 标定探针（microbench/env/calibrate/single）
│  ├─ verify_image.py        图像有效性验证
│  ├─ model_check.py         权重体检（与 host 口径一致）
│  ├─ bootstrap.py           依赖自检
│  └─ requirements.txt
├─ scripts/
│  ├─ build.mjs / build-client.mjs
│  ├─ smoke-host.mjs         (13)  纯函数与参数校验
│  ├─ smoke-host-e2e.mjs     (73)  ★ 假 worker 端到端
│  ├─ smoke-worker.mjs       (33)  ★ 真 GPU 协议端到端
│  ├─ smoke-client.mjs       (24)  ★ bundle 契约
│  └─ preset-bench.mjs       ★ 预设耗时精确标定
├─ skills/dsh-qwen-image.md
├─ docs/  HARDWARE / INSTALL / TOOLS / TROUBLESHOOTING
└─ acceptance/  本日志 + 6 份原始测量日志
```

---

## 迭代 5（2026-09-23）：对话内出图首次跑通 + 两个静默 bug 的根因

### 结论

对话内出图**已跑通**（`image_generate` 返回并渲染卡片，
`/api/qwen-image/raw?id=<id>` 实测 `200 image/png`）。此前「每次必失败」是 host 半的 JS，
不是 worker、也不是网络。

### 证据链一：健康探活失败与 worker 是否存活无关

临时在 `worker/server.py` 的 `_guard`/`_json` 里落盘 `method/path/auth/peer/响应码` 后：

```
60 × GET /health   auth=Bearer <该次 spawn 的 token>   RESP=200 bytes=189
```

即 **网络、鉴权、worker 全部正常**，而管理器仍报
`worker 已启动但 /health 在 60s 内未就绪` 并杀掉进程。

**根因**：`WorkerManager.scheduleIdleUnload()` 用 `this.ctx.timeout(...)`，而本插件
只 `inject` `tools`/`webServer`/`skills` —— cordis 里未 inject 的服务属性会被 accessor
getter 抛 `cannot get property "timeout" without inject`。它正好落在
`start()` 探活成功分支的第一步，外层 `try { … } catch {}` 把错误吞掉、循环继续，
于是「每秒 200」与「60s 未就绪」同时成立。

**修复**：`setTimer()` 助手改走 `ctx.get('timer')` + Node 原生 `setTimeout` 兜底。

### 证据链二：id 复用会静默覆盖旧图

新 worker 的 `JOB_COUNTER` 从 0 起，产物名 = `f"{kind}-{n}"` → 重启后第一张必然
`generate-1`，覆盖上一批同名 PNG；注册表还会出现重复行（`gallery.json` 实测 `count=4`
而只有 3 张图）。

**修复**：worker 启动时续号，实测日志：

```
[2026-09-23 08:02:06] 任务计数器续号：已有产物最大序号 3，下一个任务从 4 开始
```

（该行由独立启动的 worker 用 `GET /logs` 取回，未占用 GPU。）

### 证据链三：manifest 写不进去（读能过、写被围栏）

`restore()` 一直正常、`persist()` 一直静默失败。`ctx.fs` 是
`@deepseek-ai/dsh-fs-sandbox`：`writeText` 省略 per-call 策略时回落
`ctx.sandboxPolicy.resolve()`，而**插件调用没有 session**，拿到的是部署默认
`workspace-write + process.cwd()`；`manifest.json` 在 `$DSH_HOME` 下 → 不在
`writableRoots()` 里 → `FS_SANDBOX_DENIED` → 被 `catch` 变成看不见的 `console.warn`。

用 dsh 自己的 `writableRoots()`/`canonicalPath()` 复算：

```
[A] 省略策略（workspace-write + C:\Users\<用户>\Desktop） -> allowed: false
[B] workspaceRoot = <outputDir>                          -> allowed: true
[C] workspaceRoot = <outputDir>，目标 C:\Windows\...      -> allowed: false
```

**修复**：`persist()` 显式传 `{ mode:'workspace-write', workspaceRoot: this.outputDir }`，
并把失败写进 `logs/registry.log`。

### 教训（写进方法论）

> **静默 catch 是根因的藏身处。** 本轮两个 bug（探活循环的 `catch {}`、`persist()` 的
> `catch → console.warn`）都表现为「功能静默失效、没有任何可见报错」。
> 排查顺序应固定为：**先证明链路哪一段真的断了**（落盘证据），再读代码；
> 「读能过、写不过」这类不对称几乎总能直接指到围栏/权限层。

---

## M6（2026-09-23）：一键安装器 ✅ —— 目标是「普通用户双击一个文件」

> 用户要求原话：**「不仅仅要适配本机环境，更要普通用户也能一键安装使用，
> 注意不同用户不同设备环境的可能性，可以参考 ComfyUI 的处理」**。
> 于是 M6 的交付物从「写一份 INSTALL.md」升级为**一个跨平台安装器**。

### 交付

| 文件 | 作用 |
| --- | --- |
| `install.bat` / `install.sh` | 一键入口（Windows 双击 / Linux、macOS），末尾 `pause` —— ComfyUI 便携版同款体验 |
| `使用说明.txt` | 普通用户先读的一页（三步走、需要什么、装完怎么用、常见问题、许可） |
| `installer/install.mjs` | 编排：体检 → 计划 → 解释器 → venv → 依赖 → 权重 → 注册 → 核验 |
| `installer/lib/detect.mjs` | 环境探测（OS/GPU/驱动/显存/内存/磁盘/Python/dsh/ComfyUI/镜像延迟）+ 纯函数解析 |
| `installer/lib/plan.mjs` | ★ 纯决策层：torch 矩阵、Python 策略、精度/offload/档位、磁盘与阻塞项 |
| `installer/lib/pystep.mjs` | uv 阶梯、venv、**site-packages 复用(.pth)**、依赖安装阶梯、核验 |
| `installer/lib/modelstep.mjs` | 权重体检复用 + hf-mirror/官方/ModelScope 三级下载 |
| `installer/lib/pluginstep.mjs` | pnpm 保障、`dsh plugin add`、profile 配置块幂等写入、`--dump-config` 复核 |
| `worker/env_report.py` | 环境体检（torch/diffusers/显卡/复用路径），安装器与排障共用 |
| `worker/fetch_model.py` | 断点续传下载器（进度按目录体积扫描，不依赖 hf 的 tqdm 回调） |
| `scripts/smoke-installer.mjs` | ★ 设备矩阵离线冒烟（纯 fixture，不联网、不动 `%DSH_HOME%`） |

### 证据 1：设备矩阵离线冒烟 108/108

```text
node scripts/smoke-installer.mjs
=== 结果：108 通过，0 失败 ===
```

覆盖的机型/参数（每条都是断言，不是"看起来对"）：

| 组 | 覆盖 |
| --- | --- |
| nvidia-smi 解析 | 双卡、老驱动 `[N/A]` 的 compute_cap、CUDA 版本行、按卡名兜底（P40→6.1、4090→8.9）、`py -0p` 列表 |
| 轮子选择 | CUDA 12.9/12.6/12.4/12.1/11.8 → cu128/cu126/cu124/cu121/cu118；11.4 太旧 → CPU；无卡 → CPU；Linux+AMD → ROCm；macOS → PyPI；`--torch` 覆盖；版本 × Python 3.12/3.13 的可行性 |
| 精度/档位 | sm8.9→bf16、sm6.1→fp16、sm5.2→fp32；24GB/16GB/12GB/6GB/未知 显存 → offload 与 draft/standard |
| 多卡 | P40 被占满（空闲 205MB）时自动落到 1660S，并给出"大卡被占用"的说明 |
| 阻塞项 | 磁盘不足（且 `--no-model` 时不再阻塞）、DSH_HOME 不可写 |
| Python 策略 | 3.9/3.14 不可用 → 走 uv；有 Python 无 torch → 全新 venv；`--no-reuse`；`--python` 优先；ComfyUI 便携版 → 借用其 site-packages |
| uv | 四种平台/架构的资产名、下载阶梯、自定义镜像优先 |
| 镜像 | 官方快用官方、官方慢用清华、`--pip-index` 覆盖、全挂回落官方 |
| 配置写入 | 20 个键、正斜杠、追加→替换幂等（重复运行不堆叠）、不动其它插件、空数组 patch、写前备份 |
| CLI/环境 | 参数解析、插件根目录定位、diffusers commit 锁定、子进程强制 UTF-8 |

### 证据 2：本机实跑（P40 机器）

```text
node installer/install.mjs --check --no-net
  显卡        Tesla P40（24576MB，空闲 24466MB）   驱动 576.80  CUDA 12.9
  Python    3.12.10(store)、3.12.10(comfyui-venv)
  Python 策略     复用已装好的环境（借包目录）
  PyTorch       2.7.1 / CUDA 12.8
  精度 / offload  fp16 / model     默认档位 standard
  ✓ 可直接复用这个环境：...\WindowsApps\python.exe
     Python 3.12.10 | torch 2.7.1+cu128 | diffusers 0.41.0.dev0(含 QwenImage21)
```

冒烟安装（隔离的 scratch DSH_HOME，不碰真实 `%USERPROFILE%\.dsh`）：

```text
node installer/install.mjs --home <tmp> --no-model --no-plugin --yes --no-net
[3/7] ✓ 使用 Python 3.12.10
[4/7] ✓ venv 就绪   ✓ 已挂载复用目录：...\LocalCache\local-packages\Python312\site-packages
[5/7] ✓ 已检测到可用的 torch，跳过 / ✓ diffusers 已就绪（含 QwenImage21Pipeline）
核验：torch 2.7.1+cu128（cuda 12.8） diffusers 0.41.0.dev0（含 QwenImage21Pipeline） CUDA 可用：是
      GPU 0：Tesla P40 capability [6,1] 空闲 24319 MB
耗时 55 秒（**零下载**）
```

关键验证点：借来的 site-packages 在 venv 里**真的可用** ——
`torch.cuda.is_available() == True`、P40 可见、diffusers 的能力探测通过。
这条路径把「已经有环境的人」的安装成本从「下载 3GB」降到「55 秒」。

### 证据 3：插件注册（新 profile 从零注册成功）

用一个**全新的临时 profile**（`--home <tmp> --profile qwtest`）把第 7 步完整跑了一遍
—— 这样即使写坏配置文件也只影响临时家目录，不会动线上 `profiles/web`（事后已核对：
`web/cordis.patch.yml` 的 mtime 仍是 2026-09-21，没有被安装器碰过）。

```text
[7/7] 注册插件到 dsh profile
  ✓ pnpm 11.24.0
    $ ...\npm\dsh.cmd plugin --profile qwtest add <插件目录>
dsh: initialized profile qwtest at <tmp>\profiles\qwtest
dependencies:
+ @lisonevf/dsh-qwen-image link:<插件目录>
  ✓ 已写入 profile 配置块：<tmp>\profiles\qwtest\cordis.patch.yml
    原文件备份：...cordis.patch.yml.bak-20260923-083543
  复核配置树（dsh --profile qwtest --dump-config）…
  ✓ 配置树里能看到 qwen-image 这一层
```

`dsh --dump-config` 的原文（exit=0）证明**配置真的生效**，而不只是文件被写出来：

```text
# == @lisonevf/dsh-qwen-image, patched by <tmp>\profiles\qwtest\cordis.patch.yml
- id: qwen-image
  name: '@lisonevf/dsh-qwen-image'
  config:
    backend: diffusers
    modelDir: >-
      C:/Users/<用户>/AppData/Local/Temp/dshqwen-plugin-test/models/Qwen-Image-2.1
    pythonExe: >-
      C:/Users/<用户>/AppData/Local/Temp/dshqwen-plugin-test/dsh-qwen-image/venv/Scripts/python.exe
```

同一次运行里，前一次还跑通了**完整依赖安装路径**（`--no-reuse`，全新 venv，耗时 578 秒）：
torch 2.7.1+cu128（官方源 3.2GB）→ transformers 5.17.0 / accelerate 等 30 个包 →
diffusers 从锁定 commit `9f124697` 克隆并构建成 wheel（6062201 B）→ 核验
`torch.cuda.is_available()==True`、P40 可见。

### 开发中暴露并修掉的六个真问题（都写进了代码注释）

| # | 问题 | 根因 | 修法 |
| --- | --- | --- | --- |
| 1 | PATH 上的 python 探测不到（本机明明有 3.12.10） | Windows **应用执行别名**是 0 字节 reparse point / 符号链接，`existsSync` 返回 false、`statSync` 抛 EACCES | 新增 `isExecutablePath()`：用 `lstatSync` 判定（有注释说明为什么不能用 stat） |
| 2 | 中文 Windows 下 Python 输出全乱码 | Python 写管道默认用 GBK，Node 按 UTF-8 解码（`model_check.py` 的中文提示全花） | 所有子进程统一 `PYTHONUTF8=1 / PYTHONIOENCODING=utf-8` |
| 3 | 反复运行会把配置块注释堆叠成两份 | 替换块时把上方注释一起吃掉后，块尾搜索从"注释后的第一行"出发，恰好命中自己的 id 行 | 块尾从**原 id 行**往后找；幂等由冒烟用例锁死 |
| 4 | `dsh plugin add` 起不来 | npm 装的 CLI 是 `.cmd` 批处理，`shell:false` 下 CreateProcess 不认；且 `which('dsh')` 先命中了无扩展名的 sh 脚本 | `which()` 让扩展名版本优先；新增 `toSpawnSpec()` 走 `cmd /d /s /c` 并按 cmd 规则再包一层引号 |
| 5 | 写好的 profile patch 让 dsh 启动报 YAML 解析失败 | dsh 新建 profile 的模板是「几行注释 + 空数组 `[]`」，在其后追加 `- id: …` 会变成**两个没有分隔符的 YAML 文档** | 追加前先剔除空的 `[]` 行（保留注释）；冒烟新增该模板形态的用例 |
| 6 | 注册失败却被报成成功 | `--dump-config` 的**报错信息里也含 qwen-image 字样**（来自错误行预览），正则一匹配就成了"配置树里有这一层" | 先判 `failed to parse / YAMLException` 再判存在性；解析失败时直接报错并提示用备份恢复 |

教训与之前那次「无报错的段错误」一致：**先怀疑环境与平台细节，再怀疑业务逻辑**。
这四条没有一条是"算法错了"，全是「别人的机器和我的不一样」。

### 与 ComfyUI 的对照（用户点名参考）

| ComfyUI 便携版的做法 | 本安装器的对应做法 |
| --- | --- |
| `python_embeded` 自带解释器，用户不用装 Python | 没有 Python 时用 uv 托管 3.12；有 Python（含 ComfyUI 自己的）就直接用 |
| `run_nvidia_gpu.bat` / `run_cpu.bat` 分厂商启动脚本 | 一个入口自动识别厂商与驱动，选 cu128/…/ROCm/CPU |
| `update` 目录 + `update.py` 幂等更新 | 安装器本身幂等，随时重跑只补缺的 |
| `README_VERY_IMPORTANT.txt` 放根目录讲人话 | `使用说明.txt`（30 秒读完，含常见问题与许可） |
| 明确的报错提示（vc_redist / 驱动） | 每个失败都给「原因 + 可复制命令 + 日志路径」 |

---

## 迭代 6（2026-09-23）：相册 v2 —— 查询 / 排序 / 分类 / 改 / 删（含回收站）

### 交付

相册（`conversation.view` id=`qwen-image`）从「只读回顾」升级为「回顾 + 管理」。
生成入口仍只在对话里（避免两套入口、两套语义），相册负责回头翻与整理：

| 能力 | 实现 |
| --- | --- |
| 查询 | 提示词 / id / seed / 标签 / 备注 全文；时间范围；类型；尺寸；多标签 AND |
| 排序 | 时间 / 大小 / 步数 / 耗时 / 宽度 / seed / 编号 + 升降序；排序字段走**白名单** |
| 分类 | 按日期 / 标签 / 类型 / 尺寸分组；筛选面板计数为**全量**口径（`facets`） |
| 改 | 提示词、备注、收藏、标签（`tags` 整体替换 / `tagsAdd` / `tagsRemove` 增量），支持批量 |
| 删 | 默认移入 `<outputs>/_trash/<时间戳>/`（PNG + 缩略图 + sidecar 一起搬）并写 `_trash/trash.json`，可整条还原；`purge=true` 才真删 |

新增/扩展路由：`gallery.json`（查询参数化）、`facets`、`update`、`delete`、`trash.json`、`restore`；
`manifest.json` 增量持久化 `tags` / `favorite` / `note` / `promptEdited`。

设计取舍（写在这里免得以后又被推翻）：

- **渲染在客户端，筛选/排序/计数在宿主**：完整历史以 manifest 为准，内存只保留
  `maxInMemory` 条，排序与计数必须全量算才不会错；客户端只渲染拿到的这一页。
- **删除必须可后悔**：本迭代之前已经因为 id 复用误覆盖过一张图，故默认走回收站。
- **标签分组去重**：一张图多个标签时只归入第一个标签，否则同一张图会在多个分组里
  各出现一次，看起来像多了几张。

### 验收证据（离线冒烟，无 GPU）

```
node scripts/smoke-host-e2e.mjs   → 129 通过，0 失败   （其中相册新增 43 项）
node scripts/smoke-client.mjs     →  32 通过，0 失败   （bundle 契约，新增 6 项）
```

冒烟直接以「node http 请求的样子」驱动已注册路由（POST body 用异步迭代器喂进去，
正好覆盖 `readJsonBody`），因此查询/排序/白名单/标签 AND/批量改/删除/还原/真删
全部是**跑出来的**，不是看代码推的。

**冒烟当场抓到一个真 bug**：`removeMany` 的 `purge` 分支写成
`for (const p of filePathsOf(rec))` —— `filePathsOf` 返回普通对象，不是可迭代对象，
运行时抛 `filePathsOf is not a function or its return value is not iterable`，
表现为「彻底删除静默失败、只报一条 failed」。已改为 `Object.values(...)`。
（非 purge 分支本来就用了 `Object.entries`，所以只有真删路径中招。）

---

## 迭代 7（2026-09-23）：重启后实跑验证（A / B 双双证实）+ 又一个静默 bug

### 实跑证据（真实宿主 + 真 worker，不是离线冒烟）

| 项 | 证据 |
| --- | --- |
| **A 续号生效** | `image_worker logs` 实读：`任务计数器续号：已有产物最大序号 4，下一个任务从 5 开始` |
| **B manifest 落盘生效** | 重启前 `manifest.json` 停在 `2026-09-22T00:49:38Z`；`POST /update` 后立刻变成 `2026-09-23T04:06:32Z`，且落盘内容里 `favorite/tags` 都在；`logs/registry.log` **不存在**（= persist 没抛错） |
| 相册查询/排序 | `GET /gallery.json?sort=bytes&order=desc` 返回顺序 929270 > 843201 > 832201（与预期一致） |
| 相册计数 | `facets`：`sizes=768²×3`、`days=2026-09-22×3`、`kinds=generate×3`、`steps=12步×3` |
| 记录恢复 | 重启后注册表从 manifest 恢复了 3 条（`galleryCount=3`） |

### 发现的真 bug：`mode=background` 报错，但图其实已经跑完了（孤儿图）

现象：一次 `image_generate(mode=background)` 返回
`background jobs unavailable: no job controller serves this agent`，
**但磁盘上多出了 `generate-4.png`（836603 B，樱花柴犬，耗时 164.92s）**，相册里却看不到它。

根因链（两段）：

1. `dsh-jobs-local.start()` 会因为 owner 不被它服务而抛错
   （`if (!this.servesOwner(spec.owner)) throw ...`）。
2. 而 `runBackground` 的顺序是**先 `client.generate()` 入队、后 `jobs.start()` 登记** ——
   于是登记抛错时 GPU 已经在跑，错误直接冒到调用方：**报告失败、算力已花、
   产物没有注册记录**（宿主侧 `finalize` 再也没被执行）。

修复：

- `awaitJobAndFinalize()`：登记失败（或没有 jobs 服务）时**降级为前台等待**，
  把已经在跑的任务等回来并正常入库 —— 宁可阻塞，也不丢图和算力。
- 新增 `POST /recover` + 相册页脚「扫描产物」：扫 `<outputs>/*.json` sidecar，
  把「磁盘上有、注册表没有」的作品补录回相册（顺带成为 manifest 损坏后的重建通道）。
  幂等（已入册的跳过）、要求 PNG 真实存在、跳过 manifest.json 自身。

### 自己踩的坑（值得记）：函数声明提升把 wait 档位打崩了

为了做上面的降级，我新加了一个「等待已入队任务」的助手，**取名 `runForeground`** ——
而本文件里早就有一个 `runForeground(rt, a)`（wait 档位的正常路径）。
JS 函数声明提升让后定义的那个覆盖前者，于是 wait 档位变成
`TypeError: client.waitForJob is not a function`。

冒烟在 30 秒内就抓到了（`image_generate 未抛异常` FAIL + 后续级联），
改名 `awaitJobAndFinalize` 后恢复。教训：**大文件里加函数前先 grep 名字**；
以及再次证明「有冒烟就不靠肉眼」。

### 验收数字

```
node scripts/smoke-host-e2e.mjs   → 137 通过，0 失败（新增孤儿恢复 8 项）
node scripts/smoke-client.mjs     →  33 通过，0 失败（新增扫描入口 1 项）
```

### 待办（需下一次重启才激活）

- `/recover` 路由与 background 降级都是**宿主半**改动，需重启宿主生效。
- `generate-4` 目前是孤儿：磁盘在、相册不在。重启后点一次「扫描产物」（或
  `POST /api/qwen-image/recover`）即可补录进相册。

### 迭代 7 补充（重启后收尾）

- **`/recover` 实跑成功**：`POST /api/qwen-image/recover` → `addedCount=1, added=generate-4,
  scanned=4, skipped=3`（已入册的 3 条被正确跳过 = 幂等）。相册从 3 张变 4 张，
  manifest 落盘 4 条且 `registry.log` 依旧不存在。那张因 background 登记失败而成为孤儿的
  樱花柴犬现在正常显示在相册里。
- **补上了 background 降级的离线覆盖**：假 jobs 的 `start()` 原本从不抛错，所以
  降级路径其实没被测到。新增用例把它改成复刻 `dsh-jobs-local` 的抛错行为，断言
  「调用不抛错 / 仍回传出图结果 / note 说明已降级 / 图确实入库（不再是孤儿）」。

```
node scripts/smoke-host-e2e.mjs   → 141 通过，0 失败（新增 background 降级 4 项）
node scripts/smoke-client.mjs     →  33 通过，0 失败
```

> 冒烟加载的就是**已安装的那份 `lib/index.cjs`**（hash 与 profile 一致），
> 所以这些断言验证的是线上代码，不是另一份副本。
