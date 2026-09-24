# 硬件与可行性（M0 标定 — 实测完成）

> 本文档由 `worker/hw_probe.py` 在本机实测产出，决定 `preset` 默认档位与 dtype/offload 策略。
> 证据日志：`acceptance/m0-microbench.log`、`acceptance/m0-calib-fp16-model.log`、`acceptance/m0-single-standard.log`
>
> 本文所有「本机」均指作者的标定机：Windows 11 / Tesla P40 (24GB) / 32GB RAM / CUDA 12.8。

---

## 1. 本机实测配置

| 项 | 实测值 |
| --- | --- |
| GPU0 | **Tesla P40**，sm_61（Pascal），24473 MiB，驱动 576.80，TCC 模式 |
| GPU1 | GTX 1660 SUPER，sm_75，6144 MiB — **当前不可见**（`CUDA_VISIBLE_DEVICES=0`），torch 报 `device_count=1` |
| 内存 | 31.95 GB 总 / 24.9 GB 空闲（加载中一度降至 3.55 GB，为 mmap 页缓存，可回收） |
| 磁盘 | C: 435 GB 可用 |
| Python | 3.12.10（Windows Store），`WindowsApps\python.exe` |
| torch | **2.7.1+cu128**，CUDA 12.8，cuDNN 90701 |
| transformers | 5.17.0 |
| diffusers | **0.41.0.dev0**（main 分支，`QwenImage21Pipeline` 可用 ✅） |
| accelerate | 1.15.0 |
| 权重 | 30.86 GB / 27 文件（既有权重目录直接可用） |

---

## 2. 🔑 关键发现：**P40 的 fp16 完全可用**（推翻 PLAN 原假设）

docs/PLAN.md §1.1/§6.1 曾假设「P40 无原生 bf16、fp16 算力极低（1/64 速率）」，据此计划 sm_6.x 走 `fp32 + sequential offload`。**实测证明该假设错误**。

微基准（4096² 方阵 matmul，20 次迭代，`--microbench`）：

| dtype | 实测算力 | 相对 fp32 |
| --- | --- | --- |
| fp32 | **8.642 TFLOPS** | 1.00× |
| **fp16** | **10.009 TFLOPS** | **1.16×（更快）** |
| bf16 | 5.053 TFLOPS | 0.58×（软件模拟） |

**结论**：
1. **fp16 是 P40 上的正确选择** —— 不仅可用，还比 fp32 更快。cuBLAS 在 Pascal 上对 fp16 GEMM 走的是高效路径（fp32 累加），并非 1/64 的向量半精度通路。
2. **bf16 必须避免** —— sm_61 无原生 bf16，软件模拟导致约一半吞吐。
3. fp16 存储把 RAM/VRAM 需求减半，这是能在 32GB RAM + 24GB VRAM 上跑通的决定性因素。

> 这一发现同时修正了 docs/PLAN.md §6.1「sm 6.x（P40）→ 默认 fp32，必须 sequential offload」与 §11 风险表中「Pascal 无 bf16、fp16 算力极低 → 精度/速度两难」两条。

---

## 3. dtype / device / offload 标定

**最终生效配置：`fp16` + `cuda:0`(P40) + `offload=model`（`enable_model_cpu_offload`）**

理由：
- **fp16**：见上，最快的可用精度。
- **`offload=model`**：把 transformer（13.25 GB）/ text_encoder（16.33 GB）/ vae 按模块轮流上卡。P40 的 24 GB 能容纳任一单模块，因此无需更激进的 `sequential`。
- **`offload=sequential` 不需要**：那是为「单模块都装不下」的极小显存准备的；本机模型 offload 已足够，且 sequential 会显著增加 PCIe 往返。

**加载实测**：

| 指标 | 实测值 |
| --- | --- |
| 首次加载耗时 | **55.6 – 67.1 s**（远低于预期，得益于 safetensors mmap 按需分页） |
| 加载后 RSS | **629 MiB**（权重走 mmap，未常驻物理内存） |
| 推理后 RSS | ~14.3 GB |
| 峰值显存 | **16767 – 16773 MiB**（恒定，与尺寸无关 —— transformer 主导，VAE 由 tiling 处理） |
| 空闲显存余量 | ~7.3 GB |

> 峰值显存恒定在 ~16.8 GB 说明：**2048² 也不会因 VAE 解码而 OOM**（`vae.enable_tiling()` 生效）。24 GB 有充足余量。

---

## 4. 尺寸 × 耗时标定（fp16 / P40 / model offload）

⚠️ **本节的数字全部来自 `callback_on_step_end` 逐点计时。** 第一轮标定曾把 tqdm 的
**累计均值**当成单步耗时，得出「512² 稳态 9–10 s/步」的结论，实际仅 1.7 s/步 —— 高估约 5 倍。
该错误已修正，此后所有测量都走逐点计时。

### 四段式耗时模型（实测拟合）

```
total ≈ loadExtra + firstStep + (steps−1) × steadyStep + vaeDecode
```

| 分量 | 含义 | 实测值 |
| --- | --- | --- |
| `loadExtra` | **加载后首次**推理的额外页换入 | **≈ +100 s**（仅每次 load 后的第一张图） |
| `firstStep` | 每张图都付的冷启动（权重上传） | **78 – 93 s**（区间；见 §4.3） |
| `steadyStep` | 稳态步，**超线性**于像素数 | `steady ≈ 8.96 × MP^1.34` |
| `vaeDecode` | 末步之后的 VAE 解码 + 后处理 | 15 s @768² / **26 s @1024²** / 104 s @2048² |

### 4.1 逐点计时实测（`acceptance/m0-preset-bench.log`）

| 档位 | 像素 | 步数 | 实测总耗时 | 首步 | 稳态/步 | 峰值显存 |
| --- | --- | --- | --- | --- | --- | --- |
| draft 768² | 0.59 MP | 12 | 250.67 s | 177.79 s ⚠️ | **4.426 s** | 16767 MiB |
| standard 1024² | 1.05 MP | 24 | 302.80 s | 78.07 s | **8.819 s** | 16771 MiB |
| native 2048² | 4.19 MP | 3 | 283.58 s | 93.46 s | **60.705 s** | 16771 MiB |

> draft 的首步 177.79 s 是因为它是**加载后的第一张图**（多付了 `loadExtra`）。
> standard 跑在其后，页已热，首步回落到 78 s。这正好把 `loadExtra` 单独量了出来。

### 4.2 稳态步是**超线性**的（注意力 O(n²)）

| 像素 | 稳态秒/步 | 每 MP 秒 |
| --- | --- | --- |
| 0.59 MP (768²) | 4.43 | 7.5 |
| 1.05 MP (1024²) | 8.82 | 8.4 |
| 4.19 MP (2048²) | 60.71 | 14.5 |

像素 7.1×（0.59→4.19 MP）时步耗时 **13.7×**。原因是序列长度随像素增长，注意力开销 O(n²)。

**用幂律拟合 `steady ≈ 8.96 × MP^1.34`，比线性拟合准确得多** ——
线性拟合会让 2048² 低估约 40%。插件即按幂律外推 ETA。

### 4.3 首步冷启动区间与「每图重付」

连续 3 次 1024²/24 步实测（`acceptance/m0-repeat-3.log`）：

| 次序 | 总耗时 | 首步 | 稳态 | 峰值显存 | RSS |
| --- | --- | --- | --- | --- | --- |
| #1 | 311.7 s | 83.1 s | 8.84 s/步 | 16767 MiB | 23062 MiB |
| #2 | 301.6 s | 72.1 s | 8.97 s/步 | 16771 MiB | 14167 MiB |
| #3 | 303.4 s | 73.0 s | 9.01 s/步 | 16771 MiB | 6563 MiB |

**结论：每张图都要重新支付 78–93 s 冷启动，预热不能消除它。**

归因：权重 30.86 GB，RAM 仅 31.95 GB（OS 常驻约 7 GB）。
`enable_model_cpu_offload()` 每次推理都要把 text_encoder（16.33 GB）搬上 GPU；
RSS 从 23 GB 逐次降到 6.5 GB，说明**页缓存被内存压力逐出**，
于是每次都重新从磁盘读入。这是内存容量决定的稳态行为，不是偶发抖动。

**影响与对策**：

- 每图成本 ≈ **85 s（首步）+ (steps−1) × 稳态 + VAE**。步数越少，固定成本占比越高。
- 权重**加载**耗时也不稳定：实测 **55 – 141 s**（取决于加载前页缓存状态）。
- `image_worker action=warm` 收益有限（页会被再次逐出），**UI 不得承诺预热能显著提速**，
  只应表述为「把首次等待提前」。
- 根治手段只有一个：**RAM 加到 64 GB** 让权重常驻；或改用更小的文本编码器 / 量化权重
  （GGUF int4/int8，即 docs/PLAN.md §2.1 的 comfyui 后端）。
- 当前**不阻塞交付**：功能完整、结果正确，只是慢。

### 4.4 各档位总耗时（实测/推算）

| 档位 | 实测 | 推算（非首张） | 说明 |
| --- | --- | --- | --- |
| `draft` 768²/12步 | 250.67 s（含 loadExtra） | **≈ 148 s ≈ 2.5 分钟** | 交互首选 |
| `standard` 1024²/24步 | **303 s（3 次：304.2/301.6/303.4）** | ≈ 303 s ≈ **5.0 分钟** | 质量更好 |
| `native` 2048²/40步 | 3 步实测 284 s | **≈ 2575 s ≈ 43 分钟** | 仅后台任务 |

> 早先估的「native ≈ 67 分」是基于错误的线性外推；按幂律外推的 61.19 s/步重算为 **≈ 2575 s ≈ 43 分钟**。

### 各预设的推算耗时（三段式：首步 + 步数×稳态 + VAE）

| 档位 | 配置 | 稳态秒/步 | 实测/推算总耗时 |
| --- | --- | --- | --- |
| `draft` | 768², 12 步 | 4.42 s | **≈ 2.5 分钟**（非首张；首张 4.2 分） |
| `standard` | 1024², 24 步 | 9.55 s | **≈ 5.0 分钟**（实测 3 次：304.2/301.6/303.4 s） |
| `native` | 2048², 40 步 | 61.19 s | **≈ 43 分钟** |

---

## 5. 输出特性

- **原生 RGBA**：模型直接输出 4 通道（实测 `imageMode=RGBA`），无需后处理。alpha 实测范围 183–255（mean 254.4）。
- **图像有效性**：fp16 生成的 512² 图实测 77101 种唯一颜色、rgbMin=0/rgbMax=255、直方图 16 桶均匀铺开 → 正常可用，非退化。
- **良性警告**：diffusers `image_processor.py:142` 会打印 `RuntimeWarning: invalid value encountered in cast`（`(images*255).round().astype("uint8")`）。实测不影响图像质量，属边界值而非 NaN。**插件不应把该警告当作失败**，但应在日志中说明。

---

## 6. diffusers 管道契约（读源码确认，影响实现）

`QwenImage21Pipeline.__call__` 的确切签名（`pipeline_qwenimage21.py:505`）：

```python
__call__(prompt, image=None, negative_prompt=None, true_cfg_scale=1.0,
         height=None, width=None, num_inference_steps=40, sigmas=None,
         num_images_per_prompt=1, generator=None, latents=None,
         prompt_embeds=None, prompt_embeds_mask=None,
         negative_prompt_embeds=None, negative_prompt_embeds_mask=None,
         output_type="pil", return_dict=True, attention_kwargs=None,
         callback_on_step_end=None,
         callback_on_step_end_tensor_inputs=["latents"],
         output_resolution=1024, use_kv_cache=True)
```

必须注意的 6 点（与 PLAN 原设想不同）：

1. **没有 `mask` 参数**。Qwen-Image-2.1 的 `qwenimage21/` 下只有这一个统一管道，
   局部编辑的正规路径是**「在图上画圆圈/涂抹标注，把标注后的图作为条件图传入」**，
   而不是传独立的 mask 张量。→ 插件把独立 mask 合成为红色半透明标注后并入条件图。
2. **引导参数是 `true_cfg_scale`（默认 1.0 = 无引导）**，不是 `guidance_scale`。
   仅当 `true_cfg_scale > 1` 且提供 `negative_prompt` 时 CFG 才生效。
   模型设计为无引导采样，故插件默认保持 1.0。
3. **`callback_on_step_end` 必须返回 dict** —— 管道内部会对其 `.pop("latents")`，
   返回 `None` 会直接崩。
4. **取消靠回调内抛异常**：`self._interrupt` 标志只被重置（第 637 行）和暴露（第 501 行），
   去噪循环内**并不检查**它。故 `CancelledError` 必须在回调中抛出。
5. **`image` 是一个扁平列表，对该批次所有 prompt 共享**，不可按 prompt 嵌套；
   需要不同条件图时须逐 prompt 单独调用。
6. `output_resolution` 默认 1024，既用于推导缺省宽高，也用于**缩放条件图** ——
   插件显式传入目标边长以免条件图被误缩。

---

## 7. M0 结论：本机可用档位

| 档位 | 可用性 | 实测耗时 | 建议 |
| --- | --- | --- | --- |
| `draft`（768², 12 步） | ✅ 可用 | **≈ 2.5 分钟** | **推荐作为交互默认** |
| `standard`（1024², 24 步） | ✅ 可用 | **≈ 5.0 分钟**（3 次实测一致） | 质量更好，适合「认真出一张」 |
| `native`（2048², 40 步） | ⚠️ 可用但过慢 | **≈ 43 分钟** | 仅适合 mode=background 后台任务 |

**默认值**：docs/PLAN.md §12 原定 `standard(1024², 24步)`。实测 ~5.0 分钟/张，
对对话式交互偏慢，但**功能与质量都正常**，故保留 `standard` 为配置默认，
并在 `image_status`、工具描述、卡片提示、画室面板四处**显式给出各档位实测耗时**，
让用户在知情的前提下按需选择（想快就说「用 draft」）。

**M0 决策门判定（docs/PLAN.md §9）**：P40 实测**可用**（~5 分/张，无 OOM，显存余量 7.3 GB），
因此**默认后端保持 `diffusers`**，不启用 `openai-images` 逃生通道 —— 与用户的既定选择一致。

## 8. 待办与风险更新

| 项 | 状态 |
| --- | --- |
| GTX 1660S 标定 | ⏸ 未做 —— `CUDA_VISIBLE_DEVICES=0` 使其不可见。需设 `CUDA_VISIBLE_DEVICES=0,1` 后重跑才能标定 |
| 显存守卫实测 | ✅ 已验：阈值调到 999999 MiB 时正确拒绝并给出归因（含占用进程名/pid/显存与处置建议） |
| 取消/中断实测 | ⏸ 部分：/cancel 端点可达且对未知 job 安全返回；**真取消一次长任务**尚未验 |
| 长时间稳定性 | ⏸ 待做 —— 已连续 3 张无劣化，更长序列未测 |
| /health 在卸载后 500 | ✅ 已修 —— `mem_get_info` 未捕获导致；现全程防御 |

### 风险更新

| 原风险 | 更新后 |
| --- | --- |
| ~~Pascal fp16 算力 1/64~~ | **已消除**：实测 fp16 10.0 TFLOPS，是最优精度 |
| ~~P40 被 llama-server 占满~~ | 已释放；但该风险仍真实 —— 插件保留了显存守卫与具体归因 |
| ~~32GB RAM 装不下 30.86GB 权重~~ | **部分缓解**：mmap 使加载后 RSS 仅 629 MiB；但页缓存被逐出导致每图 ~85 s 冷启动，无法根除 |
| 2048² VAE 解码 OOM | **已消除**：vae tiling 生效，峰值显存恒定 16.77 GB |
| diffusers 主分支漂移 | 仍存在 —— 已装 0.41.0.dev0，建议锁 commit 后写进 requirements.txt |
| **超线性耗时** | **新增认知**：稳态步 ≈ 8.96 × MP^1.34，2048² 达 61.19 s/步。UI 必须按幂律外推，线性外推会低估 40% |
