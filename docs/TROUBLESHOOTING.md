# 排障（@lisonevf/dsh-qwen-image）

先跑 `image_status` —— 它永不失败，缺什么就说什么，并给出可直接复制的命令。

---

## 🔴 生图突然全部失败、**没有任何 Python 报错**（进程直接崩）

**症状**：worker 能启动、模型能加载（日志有「加载完成」），但在**去噪刚开始**时进程就没了。
HTTP 侧表现为 `fetch failed` / `ECONNREFUSED`，Windows 退出码 **3221225477（0xC0000005，段错误）**。
Python 侧**没有 traceback** —— 因为它不是异常，是进程被干掉了。

**根因**：模型权重 30.86 GB 走 **mmap** 加载。当系统**提交内存（commit）不足**时，
触及无法后备的页会直接崩进程，而不是抛一个可捕获的 Python 异常。

**本机实测踩过一次**：一个**残留的 python 进程**占着 **65.7 GB 私有（提交）内存**、
工作集却只有 8 MB（几乎全被换出）。它把提交上限吃满后，此后**每一次**加载模型都在
去噪开始的瞬间段错误 —— 看起来像「代码坏了」，其实是机器没内存了。

同时出现的一个迷惑现象：`hw_probe` 报「加载 60s，RSS 32MiB」——
正常应是数百 MB；页被大量换出时 RSS 会异常低。**RSS 异常低是内存吃紧的旁证。**

**怎么确认**：

```powershell
# 1) 提交内存与上限（committed 接近 limit 就是它）
Get-Counter '\Memory\Committed Bytes','\Memory\Commit Limit' |
  ForEach-Object { $_.CounterSamples } |
  Format-Table Path, @{N='GB';E={[math]::Round($_.CookedValue/1GB,2)}}

# 2) 谁占着几十 GB（按私有内存排序）
Get-Process | Sort-Object PrivateMemorySize64 -Descending |
  Select-Object -First 5 Name, Id, @{N='PrivateGB';E={[math]::Round($_.PrivateMemorySize64/1GB,2)}}, @{N='WS_MB';E={[math]::Round($_.WorkingSet64/1MB,0)}}
```

**怎么修**：停掉那个占着几十 GB 的残留进程：

```powershell
Get-Process python -ErrorAction SilentlyContinue | Select-Object Id, PrivateMemorySize64
Stop-Process -Id <pid> -Force
```

释放后提交内存立刻回落（实测 **78.7 GB → 12.6 GB**），生图随即恢复正常。

> `image_status` 现在会**前置报告**可用内存与提交占用：低于 20 GB 给红色告警并提示排查
> 残留 python 进程；低于 32 GB 给黄色提示。这条守卫是专为上面这个「无报错崩溃」加的
> —— 它是本机最难定位的一次故障。

**预防**：不要在 worker 加载/推理时并发跑别的吃内存任务
（本机曾因并发跑一个逐像素构造大图的 Python 脚本，与正在加载 30 GB 的 worker 争内存，
直接把 worker 拖死）。插件正常路径会在卸载/停用时终止 worker，
但被强制杀掉的 DSH 进程可能留下孤儿 python —— 那就是上表第一步要查的东西。

---

## 🔴 启动即失败：`Cannot find module '@deepseek-ai/dsh-tools'`

**症状**（整个插件树加载失败，**不是降级而是启动中止**）：

```
Error: dsh: plugin tree failed to load: failed to apply loader entry include (cordis:include):
failed to import loader entry qwen-image (@lisonevf/dsh-qwen-image):
Cannot find module '@deepseek-ai/dsh-tools'
```

**根因**：插件以 `link:` 装入 profile 时，Node 按 **realpath** 解析 `require()`，
解析基准是插件的真实目录。而 `@deepseek-ai/*` 住在 **dsh 安装目录内**，不在插件的解析链上：

| 解析起点 | `@deepseek-ai/dsh-tools` |
| --- | --- |
| 插件目录 | ✗ 找不到 |
| profile 目录 | ✓ |

**这是本仓库的既有约定** —— `dsh-plugin-dev-kb` 源码里写得很明确：

> 依赖纪律：本模块不 import 任何 `@deepseek-ai/*` 运行时包
> （插件以 `link:` 方式装入 profile，Node ESM 按 realpath 解析链接包，
> 外部依赖从插件目录解析不到）。

**正确做法**：host 半产物必须**零外部依赖**（只允许 `node:` 内建）。本插件用两个自包含
模块解决了这点：
- `src/host/tool-dsl.ts` —— 替代 `defineTool`（自实现 DSL→JSON Schema）
- `src/host/config-schema.ts` —— 替代 `schemastery`（自实现 Standard Schema v1）

**自检**：

```powershell
node scripts/check-host-deps.mjs           # 断言零裸包 require + 可独立 require
node scripts/check-profile-resolution.cjs  # 从 profile 视角解析并加载两个半
```

---

## 🔴 工具注册失败：`unsupported JSON schema: ...`

官方参数/输出 schema DSL 是**受限子集**，不是完整 JSON Schema。两个实测高频坑：

| 报错 | 原因 | 修法 |
| --- | --- | --- |
| `parameters.count.minimum is not supported by the value schema DSL` | 参数 DSL **不支持** `minimum`/`maximum`/`minLength`/`maxLength`/`pattern`/`format` | 写进 `description`，在 `execute` 内自行校验 |
| `schema.additionalProperties must be explicitly true or false` | **每个** object 节点都必须显式声明（含数组 `items` 内、嵌套对象、裸 `{type:'object'}`） | 补 `additionalProperties: true`（宽容）或 `false`（严格） |

**支持的参数 DSL 键**（实测白名单）：
`type` / `description` / `required` / `enum` / `default` / `examples` / `title` /
`items` / `additionalProperties` / `oneOf`（至少两个分支）

**支持的 type**：`string` / `number` / `integer` / `boolean` / `array` / `object` / `null`

**自检**（用**真实的** dsh-tools 校验我们的 schema）：

```powershell
node scripts/verify-against-real-dsh.mjs
```

> ⚠️ 教训：**别用 identity stub 去测工具定义**。stub 掉的契约就是没测的契约 ——
> 真实的 `assertSupportedJsonSchema` 会在 `register()` 时抛错，而 stub 让"能注册"变成假象。
> 本插件的 e2e 测试因此改为**直接加载产物、不做任何 stub**。

---

## 🔴 运行时报：`non-string provider`（技能注册）

```
skill provider "dsh-qwen-image" returned skill "dsh-qwen-image" with a non-string provider
```

**根因**：用了 `ctx.skills.registerProvider(factory)`。该路径的 `validateCandidate`
要求 `list()` 返回的**每个 candidate** 都带 `provider` 字段，**且必须等于 provider 自己的 `name`**
—— 很容易漏。

**正确做法**：改用**运行时注册**（`dsh-plugin-dev-kb` 用的就是这条）：

```js
ctx.skills.register({
  name,            // 必须匹配 /^[a-z0-9]+(?:-[a-z0-9]+)*$/
  description,     // 非空
  whenToUse,
  source: 'runtime',
  content,         // 必须是字符串
  resourceBase: { kind: 'directory', path },
})
```

缺省项由 registry 补齐，无候选校验。`register()` 返回 disposer，挂到 `ctx.effect` 上即可随卸载注销。

**provider 路径的完整候选契约**（确实要用 provider 时）：

| 字段 | 要求 |
| --- | --- |
| `name` | string，匹配 `/^[a-z0-9]+(?:-[a-z0-9]+)*$/` |
| `description` | 非空 string |
| `invocation` | 可选；`{modelInvocable: boolean, userInvocable: boolean}` |
| `whenToUse` | 可选 string |
| `source` | string |
| `rank` | 有限 number |
| `provider` | **string，且 `=== provider.name`** |
| `path` | 可选 string |

> 教训：**同一能力有多条注册路径时，抄本仓库里已被验证可用那一条的形状**，
> 而不是照最"完整"的接口自己拼。

---

## 插件没生效 / GUI 里看不到卡片

**客户端半只在 DSH 进程启动时加载。** 安装插件后必须**重启 profile**：

```powershell
# 停掉当前 dsh web，然后重新启动
dsh --profile web
```

验证插件层已装配：

```powershell
dsh --profile web --dump-config    # 应出现 "# == @lisonevf/dsh-qwen-image"
```

验证客户端半已注册（在 GUI 会话里让我查 `tool.call.toolview` 的 occupants）：
应看到 `image_generate` 与 `image_edit` 两个键。若没有，检查
`package.json` 的 `dsh.client` 与 `exports["./client"]` 指向 `lib/client.js`，
以及 `lib/client.js` 是否存在（`node scripts/build-client.mjs`）。

---

## 权重问题

- **`image_status` 报 `missing`**：`modelDir` 没指对，或权重没下全。
  配置里指向你自己已经下好的权重目录即可：
  ```yaml
  # profile 的 cordis.patch.yml
  - id: qwen-image
    config:
      modelDir: 'D:/models/Qwen-Image-2.1'   # 换成你自己的权重目录
  ```
- **缺分片**：只补缺的那个，别重下 30 GB：
  ```powershell
  $env:HF_ENDPOINT='https://hf-mirror.com'
  hf download Qwen/Qwen-Image-2.1 --local-dir "<dir>" --include "text_encoder/model-00003-of-00004.safetensors"
  ```

---

## 生图很慢（这是本机的物理现实，不是 bug）

实测（P40 / fp16 / 32 GB RAM）：

| 档位 | 耗时 |
| --- | --- |
| draft 768²/12 步 | ≈ 2.5 分钟 |
| standard 1024²/24 步 | ≈ 5.0 分钟 |
| native 2048²/40 步 | ≈ 43 分钟 |

耗时构成：**首步 78–93 秒（每张都重付）+ (步数−1) × 稳态 + VAE 解码 24–26 秒**。

**为什么首步每张都要重付**：权重 30.86 GB，RAM 只有 31.95 GB（OS 占约 7 GB）。
`enable_model_cpu_offload()` 每张图都要把 text_encoder（16.33 GB）搬上 GPU，
而页缓存被内存压力逐出，于是每次都重新从磁盘读入。**这是内存容量决定的，预热无法消除。**

想更快只有三条路：
1. RAM 加到 64 GB（让权重常驻）—— 唯一根治手段；
2. 用 `draft` 档位；
3. 改用量化权重（GGUF int4/int8，即 `docs/PLAN.md` §2.1 的 comfyui 后端）。

`image_worker action=warm` 只能把首次等待提前，**不要指望它显著提速**。

---

## 显存不足 / OOM

插件**不会 OOM 崩栈**。`guard_vram()` 会在推理前检查，不足时拒绝并给出**具体归因**，
例如：

> 空闲显存仅 120 MiB（总 24473 MiB），低于阈值 1024 MiB。
> 检测到占用进程：llama-server.exe(pid 6600, 23980 MiB)。
> 建议：停止占用进程（如 llama-server）后重试，或把 device 切到其它卡（如 cuda:1）。

处理：停掉占用进程，或把 `device` 改成 `cuda:1`（若第二张卡可见）。

**注意**：`CUDA_VISIBLE_DEVICES=0` 会让 GTX 1660S 对 torch 不可见（`device_count=1`）。
要用 1660S 需设 `CUDA_VISIBLE_DEVICES=0,1` 后重启 worker。

---

## 输出里的 `invalid value encountered in cast` 警告

来自 diffusers `image_processor.py:142`（`(images * 255).round().astype("uint8")`）。
**实测为良性的边界舍入，不是 NaN，不影响图像质量**（见 `acceptance/m0-verify-fp16.log`：
77101 种唯一颜色、全色域分布、直方图均匀）。不要把它当作失败。

---

## diffusers 装不上 / 报没有 `QwenImage21Pipeline`

需 Git 版（`QwenImage21Pipeline` 尚未进 PyPI 发行版），但**必须锁定 commit**：
本项目锁定的是 `9f1246971270c84dcbe71233edb7a519596a5d02`
（`installer/lib/pystep.mjs` 的 `DIFFUSERS_COMMIT`，已实测含 `QwenImage21Pipeline`）。
**不要装主分支** —— 主分支会漂移，接口可能已变，与 worker 里的调用对不上。

```powershell
pip install "git+https://github.com/huggingface/diffusers.git@9f1246971270c84dcbe71233edb7a519596a5d02"
pip install accelerate pillow
```

没有 git 时改用同 commit 的源码包：

```powershell
pip install https://github.com/huggingface/diffusers/archive/9f1246971270c84dcbe71233edb7a519596a5d02.tar.gz
```

`python worker/bootstrap.py` 会自检并打印缺失依赖与安装命令。
安装器默认装的就是这个 commit，换 commit 用 `--diffusers-commit <sha>`。

---

## worker 起不来 / 中途挂掉

1. 先看 `image_worker action=logs`（最近日志）。
2. worker 管理器有**崩溃退避重启**（最多 3 次），超过后标记不可用并在错误里带启动日志。
3. 手动验证 worker 能独立跑起来：
   ```powershell
   python worker/bootstrap.py
   python worker/server.py --model-dir "<dir>" --port 8099
   # 另开一个窗口
   curl http://127.0.0.1:8099/health
   ```
4. 滚动日志：`$DSH_HOME/dsh-qwen-image/logs/worker.log`。

---

## `/health` 相关

- worker 的 `/health` 全程防御，**卸载后也一定可用**（曾因 `mem_get_info()` 未捕获而在
  unload 后返回 500，已修）。
- 插件侧的 `/api/qwen-image/health` 汇总管理器状态与 worker 状态，供画室页轮询。

### 🔴 `worker 已启动但 /health 在 60s 内未就绪` —— worker 明明活着（2026-09-22 实测根因）

**症状**：`image_generate` / `image_worker start` 每次都失败并抛
`worker 退出（exitCode=1 … wasReady=false）`；但同一时刻
`$DSH_HOME/dsh-qwen-image/logs/worker-spawn.log` 里 worker 已正常
`监听 http://127.0.0.1:<port>` 且打出 `PORT=`，python 进程也确实在监听。
`image_status` 甚至可能在失败过程中报「管理器 ready」。

**根因（不是 worker 的问题，是 host 半一行 JS）**：`WorkerManager.scheduleIdleUnload()`
调用 `this.ctx.timeout(...)`。cordis 里**服务必须由本行 `inject` 声明才会挂到 `ctx` 上**，
而本插件刻意只 inject `tools`/`webServer`/`skills`，于是 `ctx.timeout` 这个 accessor 的
getter 直接抛 `cannot get property "timeout" without inject`
（见 `@deepseek-ai/cordis/lib/index.js` 的 `ReflectService.handler.get`）。

致命的是它**恰好落在健康探活成功分支的第一步**：

```js
if ((await this.client.health()).ok) {
  this.state = 'ready'
  this.touch()
  this.scheduleIdleUnload()   // ← 这里抛错
  return this.client          // ← 永远到不了
}
// 外面包着 try { … } catch {}  → 错误被静默吞掉，循环继续下一轮
```

于是「每秒都收到 200」和「60 秒后判定未就绪」同时成立，最后管理器把一个**健康的
worker 杀掉**，并把 lastError 覆盖成 `worker 退出(…)`，真因被两层静默（`catch {}`
+ 错误文本截断到首行）彻底埋掉。

**排查手法（可复用）**：临时在 worker 的 `Handler._guard` / `_json` 里把
`method + path + auth + peer + 响应码` 追加写到文件。若看到 60 次 `RESP=200`，
就说明**网络与鉴权都没问题**，问题一定在 host 半的 JS —— 不要再往 worker 上查。

**修复**：定时器一律走 `ctx.get('timer')`（`ctx.get` 是**不需要 inject** 的读取口，
与 `subprocess`/`fs` 同一约定），拿不到就退回 Node 原生 `setTimeout`。
已改动 `src/host/worker-manager.ts` 的 `scheduleIdleUnload()`（新增 `setTimer()` 助手）。

---

## 🔴 重启后「第一张图」覆盖了旧图（id 复用）

**症状**：重启 dsh 后再出图，新图叫 `generate-1`，把上一批的 `generate-1.png`
**静默覆盖**；`image_result list` / 相册里同一张图还会显示成两行。

**根因**：`JOB_COUNTER` 是 worker **进程内**变量，每次重启从 0 开始，而产物名直接
取自 `f"{kind}-{n}"`（`server.py:_enqueue` 的 `job_id` → pipeline 的
`image_id=job_id`），所以「新 worker 的第一个任务」必然是 `generate-1`。
插件侧 `ImageRegistry.addAll` 用 `byId.set` 覆盖旧记录、却仍 `order.push` 同一个 id，
于是列表出现重复行。

**修复**：
1. `worker/server.py` 启动时扫产物目录，把计数器续到已有最大序号之后：

   ```
   [worker 启动] 任务计数器续号：已有产物最大序号 3，下一个任务从 4 开始
   ```

   只认 `generate-<n>.` / `edit-<n>.` 前缀（`generate-1.thumb.webp` 命中同一序号），
   改完**下次 spawn 即生效**，不需要重启宿主。
2. `src/host/registry.ts` 的 `addAll` 在 `byId.set` 前先 `order.splice` 掉旧位置，
   id 复用时列表不会再出现重复行（防御性；正常路径已由 1 消除）。

---

## 🔴 作品历史不跨重启（manifest 写不进去，且毫无报错）

**症状**：相册里本次会话生成的图，重启后全没了；磁盘上的 `manifest.json`
时间戳一直停在很久以前，而 worker 明明正常写了 PNG。

**根因（读能过、写被围栏，且被静默吞掉）**：

1. 本机 `ctx.fs` 是 `@deepseek-ai/dsh-fs-sandbox`（见 `dsh-base/cordis.patch.yml`
   的 `fs-sandbox` 行）。它的 `writeText` 先过 `checkedTarget(target, sandboxPolicy)`：
   **省略 per-call 策略时回落到 `ctx.sandboxPolicy.resolve()`**。
2. `dsh-sandbox-policy.resolve()` 在**没有 session**（插件调用正是这种）时返回
   部署默认值：`mode = defaultMode = 'workspace-write'`、
   `workspaceRoot = process.cwd()`（dsh-base 里就是 `workspace-write` + `process.cwd()`）。
   ⚠️ 注意：**agent 会话自己拿到的 `danger-full-access` 并不适用于插件调用**。
3. `writableRoots(policy)` 只给 `[workspaceRoot, /tmp, tmpdir()]`；`manifest.json`
   住在 `$DSH_HOME/dsh-qwen-image/outputs/`，不在任一可写根下
   → 抛 `FS_SANDBOX_DENIED`。
4. `persist()` 把它 `catch` 成一句 `console.warn` —— 宿主控制台看不到，
   于是「历史不跨重启」被当成玄学。**读不受围栏**（`restore()` 用同一个 fs 一直正常），
   这个「读通写不通」的不对称就是最关键的线索。

**修复**（`src/host/registry.ts` 的 `persist()`）：

```ts
await fs.writeText(target, text, undefined, undefined, {
  mode: 'workspace-write',
  workspaceRoot: this.outputDir, // 把围栏根收窄到插件自己的产物目录
})
```

同时把失败写进 `$DSH_HOME/dsh-qwen-image/logs/registry.log`（新增 `registryDiagLog()`），
不再只有看不见的 `console.warn`。

**可复核的判定**（用 dsh 自己的 `writableRoots()` / `canonicalPath()` 计算）：

| 策略 | 判定 |
| --- | --- |
| 省略（回落 `workspace-write` + 你的工作目录） | `manifest.json` **不在**任何可写根下 → 拒绝 |
| 显式 `workspaceRoot = <outputDir>` | 命中 `<outputDir>` → **放行** |
| 显式 `<outputDir>`，目标却指向 `C:\Windows\...` | 仍拒绝（围栏没有被放宽） |

---

## 取消不管用

- `POST /api/qwen-image/cancel?job=<workerJobId>` 或 `image_worker` 之外的 `job_kill`。
- worker 的取消是**协作式**：`callback_on_step_end` 里检查标志并抛 `CancelledError`。
  注意 `QwenImage21Pipeline` 的 `_interrupt` 标志**只被重置、循环内并不检查**，
  所以必须靠抛异常取消。
- 取消后队列会释放并 `empty_cache()`，可以继续下一条。

---

## 图片显示不出来

卡片走 `/api/qwen-image/raw?id=…`（同源路由，与模型视觉能力无关）。逐步排查：

1. `image_result id='list'` 看注册表里是否有记录；
2. 直接访问 `http://127.0.0.1:3080/api/qwen-image/raw?id=<id>` 看是否 200；
3. 若 404 → 文件不在注册表或 `manifest.json` 被清；若 500 → 看 DSH 日志；
4. 若改了 `routePrefix`，确认 `window.__QWEN_IMAGE__` 已注入（宿主 tapIndex）——
   客户端读不到会回退到默认 `/api/qwen-image`，此时若前缀不同就会 404。

---

## 安装器（install.bat / install.sh）常见问题

先记住两件事：**`--check` 只读、不会崩、不改任何文件**（缺什么说什么；发现硬性问题时退出码为 2，属正常诊断结果），
以及安装日志在 `<DSH_HOME>/dsh-qwen-image/logs/install-<时间戳>.log`。
本节的每条都给出「现象 → 原因 → 怎么办」。

### 双击 install.bat 后窗口一闪而过
批处理末尾有 `pause`，正常情况下不会一闪而过；真的闪了说明连 Node 都没起来。
用 PowerShell 手动跑一次看完整输出：

```powershell
cd <插件目录>
node installer/install.mjs --check
```

### 「没有找到 Node.js 18+」
安装器自己需要 Node（dsh 也需要）。装 Node 后重跑：
官网 https://nodejs.org/en/download ，国内镜像 https://npmmirror.com/mirrors/node/ 。

### 「没有找到可用的 Python 3.10-3.13」
安装器会尝试下载 `uv` 并托管 Python 3.12；如果连 uv 都下不下来（内网/代理），
三条路任选：手动装 Python 3.12 后重跑、`--python <已有解释器>`、或设 `DSH_QWEN_UV_MIRROR`
指向内网的 uv 发布镜像。

### 「dsh plugin add 失败」/ 提到 pnpm
`dsh plugin` 是 pnpm 的转发器。装 pnpm 后重跑安装器：`npm install -g pnpm`
（也可以 `corepack enable pnpm`）。

若是 pnpm 报网络/仓库错误（内网、或 npm 官方源很慢），换国内源后重跑：

```powershell
npm config set registry https://registry.npmmirror.com
```

（pnpm 会把插件的 peer 依赖也从仓库里解析，所以这一步需要能访问 npm 仓库。）

### 装完 GUI 里没有卡片、也没有「相册」标签
客户端半只在 dsh 进程启动时加载 —— **必须重启 dsh**：

```powershell
# 停掉当前 dsh web，然后
dsh --profile web
```

### 想确认配置块写得对不对
`<DSH_HOME>/profiles/<profile>/cordis.patch.yml` 里应有 `- id: qwen-image` 一段。
patch 是**整块替换 config**，所以那段必须写全 20 个键（安装器生成的就是完整的）。
写错了可以删掉那一段、再跑一次安装器；或恢复 `.bak-<时间戳>` 备份。

### 显存被别的程序占着
安装器 `--check` 会打印每张卡的**空闲**显存；多卡时会自动选空闲最多的那张，
并明确告诉你「大卡被谁占着」。把占用程序（常见是本地大模型 `llama-server`）停掉再试，
或在配置里把 `device` 指向空卡。

### 权重下载中断/很慢
直接重跑安装器即可续传（已完成分片会跳过）。端点可换：

```powershell
node installer/install.mjs --model-dir "D:\models\Qwen-Image-2.1" --endpoint https://huggingface.co
```

内网机器可以把权重整体拷到 `--model-dir` 指定的目录，安装器体检通过就不会再下载。

### 「借用」了别的环境，以后想断开
删掉这个文件即可（安装器**没有**改动被借用的环境）：

```text
<DSH_HOME>/dsh-qwen-image/venv/Lib/site-packages/_dsh_qwen_image_reuse.pth
```

### 想彻底重来
`install.bat --force`（Linux / macOS：`sh install.sh --force`）重建 venv；或按 `docs/INSTALL.md` §8 卸载后重装。
