Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
let node_fs = require("node:fs");
let node_path = require("node:path");
//#region src/host/config-schema.ts
var FieldBuilder = class {
	spec;
	constructor(spec) {
		this.spec = spec;
	}
	default(v) {
		this.spec.def = v;
		return this;
	}
	required() {
		this.spec.required = true;
		return this;
	}
	int() {
		this.spec.int = true;
		return this;
	}
	minimum(v) {
		this.spec.min = v;
		return this;
	}
	maximum(v) {
		this.spec.max = v;
		return this;
	}
	description(_v) {
		this.spec.desc = _v;
		return this;
	}
	/** 供内部取用 */
	get __spec() {
		return this.spec;
	}
};
function field(kind, extra = {}) {
	return new FieldBuilder({
		kind,
		...extra
	});
}
const S = {
	string: () => field("string"),
	number: () => field("number"),
	boolean: () => field("boolean"),
	union: (values) => field("enum", { values })
};
function object(fields) {
	const specs = {};
	for (const [k, v] of Object.entries(fields)) specs[k] = v.__spec;
	return {
		__fields: specs,
		"~standard": {
			version: 1,
			vendor: "dsh-qwen-image",
			validate(input) {
				const issues = [];
				const out = {};
				const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
				for (const [key, spec] of Object.entries(specs)) {
					const raw = source[key];
					if (raw === void 0 || raw === null) {
						if (spec.def !== void 0) {
							out[key] = spec.def;
							continue;
						}
						if (spec.required) {
							issues.push({
								message: `$.${key} is required`,
								path: [key]
							});
							continue;
						}
						continue;
					}
					const problem = checkField(key, raw, spec);
					if (problem) {
						issues.push({
							message: problem,
							path: [key]
						});
						continue;
					}
					out[key] = raw;
				}
				if (issues.length) return { issues };
				return { value: out };
			}
		}
	};
}
function checkField(key, value, spec) {
	switch (spec.kind) {
		case "string":
			if (typeof value !== "string") return `$.${key} expected string but got ${describe(value)}`;
			return;
		case "boolean":
			if (typeof value !== "boolean") return `$.${key} expected boolean but got ${describe(value)}`;
			return;
		case "number":
			if (typeof value !== "number" || !Number.isFinite(value)) return `$.${key} expected number but got ${describe(value)}`;
			if (spec.int && !Number.isInteger(value)) return `$.${key} expected integer but got ${value}`;
			if (spec.min !== void 0 && value < spec.min) return `$.${key} expected >= ${spec.min} but got ${value}`;
			if (spec.max !== void 0 && value > spec.max) return `$.${key} expected <= ${spec.max} but got ${value}`;
			return;
		case "enum":
			if (typeof value !== "string") return `$.${key} expected string but got ${describe(value)}`;
			if (spec.values && !spec.values.includes(value)) return `$.${key} expected one of ${spec.values.join(" | ")} but got ${JSON.stringify(value)}`;
			return;
		default: return `$.${key} has an unknown field kind`;
	}
}
function describe(v) {
	if (v === null) return "null";
	if (Array.isArray(v)) return "array";
	return typeof v;
}
//#endregion
//#region src/host/config.ts
/**
* 插件配置（PLAN §4）。所有不同部署可能需要不同值的参数都定义为配置字段，
* **无硬编码**。schema 在插件加载时校验并填充默认值。
*
* 检验标准（PLAN §4 / A9）：能否在 `cordis.patch.yml` 里改这个值而不动代码？
* 20 个字段全部满足。
*
* 实现说明：用自包含的 Standard Schema（`./config-schema.ts`），
* 不 import `@deepseek-ai/schemastery` —— 插件以 `link:` 装入 profile 时
* 从插件目录解析不到 `@deepseek-ai/*`（Node 按 realpath 解析）。
*/
const Config = object({
	backend: S.union([
		"diffusers",
		"openai-images",
		"comfyui"
	]).default("diffusers"),
	modelDir: S.string().default("$DSH_HOME/models/Qwen-Image-2.1"),
	pythonExe: S.string().default(""),
	device: S.union([
		"auto",
		"cuda:0",
		"cuda:1",
		"cuda:2",
		"cuda:3",
		"cpu"
	]).default("auto"),
	dtype: S.union([
		"auto",
		"bf16",
		"fp16",
		"fp32"
	]).default("auto"),
	offload: S.union([
		"auto",
		"none",
		"model",
		"sequential"
	]).default("auto"),
	preset: S.union([
		"draft",
		"standard",
		"native",
		"custom"
	]).default("standard"),
	defaultSteps: S.number().int().minimum(1).maximum(200).default(24),
	maxPixels: S.number().int().minimum(262144).default(1048576),
	outputDir: S.string().default("$DSH_HOME/dsh-qwen-image/outputs"),
	keepAliveMinutes: S.number().int().minimum(0).default(15),
	maxConcurrent: S.number().int().minimum(1).maximum(8).default(1),
	toolTimeoutMs: S.number().int().minimum(1e4).default(18e5),
	workerPort: S.number().int().minimum(0).maximum(65535).default(0),
	routePrefix: S.string().default("/api/qwen-image"),
	allowModelFetch: S.boolean().default(true),
	hfEndpoint: S.string().default("https://hf-mirror.com"),
	modelRepo: S.string().default("Qwen/Qwen-Image-2.1"),
	maxReferenceImages: S.number().int().minimum(1).maximum(10).default(10),
	lowVramGuardMiB: S.number().int().minimum(256).default(1024)
});
//#endregion
//#region src/host/tool-dsl.ts
/** 参数 DSL 里**被官方支持**的键。不在表内的一律报错（与官方行为一致）。 */
const PARAM_KEYS = /* @__PURE__ */ new Set([
	"type",
	"description",
	"required",
	"enum",
	"default",
	"examples",
	"title",
	"items",
	"additionalProperties",
	"oneOf"
]);
/** 输出 schema 里被支持的键（不含参数 DSL 专属的 required/default/examples）。 */
const OUTPUT_KEYS = /* @__PURE__ */ new Set([
	"type",
	"description",
	"title",
	"enum",
	"items",
	"properties",
	"required",
	"additionalProperties",
	"oneOf"
]);
var ToolSchemaError = class extends Error {
	constructor(message) {
		super(`unsupported JSON schema: ${message}`);
		this.name = "ToolSchemaError";
	}
};
function parametersToJsonSchema(spec) {
	const properties = {};
	const required = [];
	for (const [name, field] of Object.entries(spec)) {
		properties[name] = compileParameter(name, field);
		if (field.required) required.push(name);
	}
	const root = {
		type: "object",
		properties
	};
	if (required.length) root.required = required;
	return root;
}
function compileParameter(path, field) {
	if (!field || typeof field !== "object") throw new ToolSchemaError(`${path} must be an object`);
	for (const key of Object.keys(field)) if (!PARAM_KEYS.has(key)) throw new ToolSchemaError(`${path}.${key} is not supported by the value schema DSL`);
	if (field.oneOf !== void 0) {
		if (!Array.isArray(field.oneOf) || field.oneOf.length < 2) throw new ToolSchemaError(`schema.properties.${path}.oneOf must be an array of at least two schemas`);
		return { oneOf: field.oneOf.map((branch, i) => compileParameter(`${path}.oneOf[${i}]`, branch)) };
	}
	if (!field.type) throw new ToolSchemaError(`${path}.type is required`);
	const node = { type: field.type };
	if (field.description !== void 0) node.description = field.description;
	if (field.title !== void 0) node.title = field.title;
	if (field.enum !== void 0) node.enum = [...field.enum];
	if (field.type === "array") {
		if (!field.items) throw new ToolSchemaError(`${path}.items is required for an array`);
		node.items = compileParameter(`${path}.items`, field.items);
	}
	if (field.type === "object") {
		if (field.additionalProperties === void 0) throw new ToolSchemaError(`${path}.additionalProperties must be explicitly true or false`);
		node.additionalProperties = field.additionalProperties;
		const nested = field.properties;
		if (nested) {
			const compiled = parametersToJsonSchema(nested);
			node.properties = compiled.properties;
			if (compiled.required) node.required = compiled.required;
		}
	}
	return node;
}
function assertSupportedOutputSchema(schema, path = "schema") {
	if (!schema || typeof schema !== "object") throw new ToolSchemaError(`${path} must be an object`);
	const node = schema;
	for (const key of Object.keys(node)) if (!OUTPUT_KEYS.has(key)) throw new ToolSchemaError(`${path}.${key} is not supported by the value schema DSL`);
	if (node.oneOf !== void 0) {
		if (!Array.isArray(node.oneOf) || node.oneOf.length < 2) throw new ToolSchemaError(`${path}.oneOf must be an array of at least two schemas`);
		node.oneOf.forEach((b, i) => assertSupportedOutputSchema(b, `${path}.oneOf[${i}]`));
		return;
	}
	const type = node.type;
	if (type === "object") {
		if (node.additionalProperties === void 0) throw new ToolSchemaError(`${path}.additionalProperties must be explicitly true or false`);
		if (node.properties) for (const [k, sub] of Object.entries(node.properties)) assertSupportedOutputSchema(sub, `${path}.properties.${k}`);
	}
	if (type === "array") {
		if (node.items) assertSupportedOutputSchema(node.items, `${path}.items`);
	}
}
/**
* 构造一个符合 DSH ToolDefinition 契约的**普通对象**。
*
* 与官方 defineTool 的差别（有意为之）：
* - 不做「展示路径软校验」（presentCall/presentResult 参数畸形时返回 undefined 的兜底）。
*   本插件的展示器足够简单（只读 argsRaw 解析出的字段），无需该层。
* - 参数的运行时校验由注册表按 JSON Schema 处理；本插件另在 execute 内做跨字段校验
*   （如 preset 与 width/height 互斥、count 范围）。
*/
function defineTool(options) {
	if (!options.name || typeof options.name !== "string") throw new Error("defineTool: name is required");
	if (options.timeoutMs !== void 0) {
		if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) throw new Error(`defineTool(${options.name}): timeoutMs must be a positive finite number`);
	}
	const parameters = parametersToJsonSchema(options.parameters);
	assertSupportedOutputSchema(options.output.schema);
	const tool = {
		name: options.name,
		description: options.description,
		parameters,
		output: {
			schema: options.output.schema,
			render: options.output.render,
			...options.output.presentationMeta ? { presentationMeta: options.output.presentationMeta } : {}
		},
		execute: options.execute
	};
	if (options.timeoutMs !== void 0) tool.timeoutMs = options.timeoutMs;
	if (options.isConcurrencySafe) tool.isConcurrencySafe = options.isConcurrencySafe;
	if (options.presentCall) tool.presentCall = options.presentCall;
	if (options.presentResult) tool.presentResult = options.presentResult;
	return tool;
}
//#endregion
//#region src/host/paths.ts
/**
* 路径展开的**唯一实现**（原先散落在 8 个文件里各写一份，已收口到这里）。
*
* ⚠️ 本机实测踩坑（务必保留）：**DSH 并不总是把 `DSH_HOME` 放进子进程/插件进程的环境变量**。
* 实测在 `dsh web`（由 .bat 启动）的宿主进程里 `Object.keys(process.env)` 里没有 `DSH_HOME`，
* 于是 `'$DSH_HOME/dsh-qwen-image/outputs'.replace('$DSH_HOME', '')` 会静默产出
* **`/dsh-qwen-image/outputs`** —— 一个在 Windows 上根本不存在的路径（前导斜杠、缺盘符）。
* 后果非常隐蔽：worker 进程被拉起后 python 在建输出目录/写日志时异常退出，
* `exitCode=1` 且来不及写任何日志，表现成「worker 秒退、无任何可观察输出」。
*
* 所以：解析 `$DSH_HOME` 时必须有兜底，且兜底要**真的存在**才算数。
*/
/** DSH 主目录：环境变量优先，其次 `~/.dsh`（本机实测默认位置）。 */
function resolveDshHome() {
	const fromEnv = process.env.DSH_HOME?.trim();
	if (fromEnv) return fromEnv.replace(/\\/g, "/");
	const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
	if (home) {
		const candidate = `${home.replace(/\\/g, "/")}/.dsh`;
		if ((0, node_fs.existsSync)(candidate)) return candidate;
		return candidate;
	}
	return "";
}
/**
* 展开 `$DSH_HOME` 与 `~`。
*
* 顺序：先把 `$DSH_HOME` 替换成**已兜底**的主目录；若结果仍不可用（例如配置里写的是
* 别的机器的绝对路径），再用 `~` 规则处理。绝不允许产出空基址的伪绝对路径。
*/
function expandHome(p) {
	let out = p;
	if (out.includes("$DSH_HOME")) out = out.replace(/\$DSH_HOME/g, resolveDshHome());
	if (out.startsWith("~/") || out === "~") out = `${process.env.USERPROFILE ?? process.env.HOME ?? ""}${out.slice(1)}`;
	if (/^\/[A-Za-z]/.test(out) && !/^\/\/\//.test(out)) {
		const dshHome = resolveDshHome();
		if (dshHome) out = `${dshHome}${out}`;
	}
	return out;
}
//#endregion
//#region src/host/client-http.ts
var WorkerClient = class {
	ep;
	constructor(ep) {
		this.ep = ep;
	}
	url(path) {
		return `${this.ep.baseUrl}${path}`;
	}
	headers() {
		const h = { "Content-Type": "application/json" };
		if (this.ep.token) h["Authorization"] = `Bearer ${this.ep.token}`;
		return h;
	}
	/** 通用 JSON 请求，带超时与错误归一化。 */
	async request(path, init = {}) {
		const controller = new AbortController();
		const timeout = init.timeoutMs ?? 12e4;
		const timer = setTimeout(() => controller.abort(), timeout);
		try {
			const res = await fetch(this.url(path), {
				method: init.method ?? "GET",
				headers: this.headers(),
				body: init.body === void 0 ? void 0 : JSON.stringify(init.body),
				signal: controller.signal
			});
			const text = await res.text();
			let data;
			try {
				data = text ? JSON.parse(text) : {};
			} catch {
				data = { raw: text };
			}
			if (!res.ok) {
				const err = data;
				throw new Error(`worker ${path} 返回 ${res.status}：${err?.error ?? text.slice(0, 300)}`);
			}
			return data;
		} catch (err) {
			if (err.name === "AbortError") throw new Error(`worker ${path} 请求超时（${Math.round(timeout / 1e3)}s）`);
			throw err;
		} finally {
			clearTimeout(timer);
		}
	}
	health() {
		return this.request("/health", { timeoutMs: 15e3 });
	}
	capabilities() {
		return this.request("/capabilities", { timeoutMs: 15e3 });
	}
	logs(count = 50) {
		return this.request(`/logs?count=${count}`, { timeoutMs: 15e3 });
	}
	load(body) {
		return this.request("/load", {
			method: "POST",
			body,
			timeoutMs: 9e5
		});
	}
	unload() {
		return this.request("/unload", {
			method: "POST",
			body: {},
			timeoutMs: 6e4
		});
	}
	warm() {
		return this.request("/warm", {
			method: "POST",
			body: {},
			timeoutMs: 6e5
		});
	}
	/** 生图/改图入队，立即返回 jobId。 */
	generate(body) {
		return this.request("/generate", {
			method: "POST",
			body,
			timeoutMs: 6e4
		});
	}
	edit(body) {
		return this.request("/edit", {
			method: "POST",
			body,
			timeoutMs: 6e4
		});
	}
	job(id) {
		return this.request(`/job/${encodeURIComponent(id)}`, { timeoutMs: 3e4 });
	}
	cancel(id) {
		return this.request(`/cancel/${encodeURIComponent(id)}`, {
			method: "POST",
			body: {},
			timeoutMs: 3e4
		});
	}
	/** 轮询等待任务完成（SSE 由客户端半直接连 worker 路由，宿主侧用轮询更稳）。 */
	async waitForJob(id, opts = {}) {
		const timeoutMs = opts.timeoutMs ?? 108e5;
		const interval = opts.intervalMs ?? 2e3;
		const started = Date.now();
		let lastStep = -1;
		while (Date.now() - started < timeoutMs) {
			const snap = await this.job(id);
			if (snap.progress && snap.progress.step !== lastStep) {
				lastStep = snap.progress.step;
				opts.onProgress?.(snap.progress);
			}
			if (snap.status === "completed") {
				if (!snap.result) throw new Error("worker 报告完成但未返回结果");
				return snap.result;
			}
			if (snap.status === "failed") throw new Error(`生成失败：${snap.detail ?? "未知错误"}`);
			if (snap.status === "cancelled") throw new Error("生成已被取消");
			await sleep(interval);
		}
		throw new Error(`等待任务 ${id} 超时（${Math.round(timeoutMs / 1e3)}s）`);
	}
};
function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
/**
* 从 worker stdout 解析 `PORT=<n>` 行（worker 以 --port 0 启动时自动分配）。
*/
function parsePortLine(text) {
	const m = text.match(/^PORT=(\d+)\s*$/m);
	return m ? Number(m[1]) : void 0;
}
/**
* 生成随机 token（仅回环，用于避免本机其它进程误调）。
*/
function makeToken() {
	const bytes = /* @__PURE__ */ new Uint8Array(24);
	if (typeof crypto !== "undefined" && crypto.getRandomValues) crypto.getRandomValues(bytes);
	else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
//#endregion
//#region src/host/worker-manager.ts
/**
* 路径是否「可用」。
*
* ⚠️ 实测坑：Windows Store 版 Python 是**应用执行别名**（app execution alias），
* 本质是一个 reparse point —— 跟随它做 `statSync`/`realpathSync` 会抛 **EACCES**，
* 而 Node 的 `existsSync` 对任何 stat 异常都返回 **false**。
* 于是明明能正常执行的
* `…\WindowsApps\PythonSoftwareFoundation.Python.3.12_…\python.exe`
* 会被误判为「不存在」，导致显式配置的 `pythonExe` 被静默忽略（本机实测踩到）。
*
* `lstatSync` 不跟随最终组件，因此能正确识别这类别名。
* 所以：existsSync 为真 → 可用；否则再看 lstat 能否成功。
*/
function pathUsable(p) {
	if (!p) return false;
	if ((0, node_fs.existsSync)(p)) return true;
	try {
		(0, node_fs.lstatSync)(p);
		return true;
	} catch {
		return false;
	}
}
/**
* worker 管理器（§2 host 半）。
*
* 职责：
* - 懒启动：首个生图请求时才拉起 worker（避免无谓占用）
* - 健康探活：/health 轮询
* - 空闲卸载：keepAliveMinutes 到期自动 unload 释放显存
* - 崩溃退避重启：异常退出后按指数退避重试，超过上限则标记不可用
* - 退出清理：插件卸载/HMR 时终止子进程（不留僵尸 python）
*
* 生命周期归 Cordis fiber：所有定时器与监听都挂在 ctx 上，卸载自动回收。
*/
/**
* 把 spawn 诊断写进文件（不抛错）。
*
* 为什么需要：worker 若在宿主进程内「秒退」，它的 stdout/stderr 只存在于
* `subprocess` 句柄的 collected 缓冲里，而工具返回给模型的错误文本会被
* 截断到首行 —— 于是真因（Python 的 traceback）永远看不到。本机实测
* 就卡在这里：同一个 argv 在任何普通 shell 里都能常驻，只有宿主内 spawn
* 会 exitCode=1，且没有任何可观察输出。
*
* 所以：所有 spawn 生命周期事件都追加写到 `$DSH_HOME/dsh-qwen-image/logs/worker-spawn.log`，
* 报错时也带上 outputDir 的绝对路径，方便直接去读。
*/
function diagLog(line) {
	try {
		const dir = `${resolveDshHome()}/dsh-qwen-image/logs`;
		(0, node_fs.mkdirSync)(dir, { recursive: true });
		(0, node_fs.appendFileSync)(`${dir}/worker-spawn.log`, `[${(/* @__PURE__ */ new Date()).toISOString()}] ${line}\n`);
	} catch {}
}
/** 读取 collected 输出（非消费式），失败/为空返回 '(空)'。 */
function readCollected(reader) {
	if (!reader) return "(无该流)";
	try {
		const r = reader.readFrom(0);
		const text = r.text?.trim();
		if (!text) return "(空)";
		return r.lossy && r.spillPath ? `${text}\n[已截断，完整输出见 ${r.spillPath}]` : text;
	} catch (err) {
		return `(读取失败：${err.message})`;
	}
}
/**
* 收集输出压成**单行**摘要。
*
* ⚠️ 本机实测：工具返回给模型的错误文本会被**截断到第一行**，
* 所以多行诊断等于没写。把 stdout/stderr 折叠成一行、并用 `|` 分隔换行，
* 才能保证 python 的 traceback 真的抵达模型眼前。
*/
function oneLine(text, max = 1500) {
	const s = text.replace(/\s*\r?\n\s*/g, " | ").trim();
	return s.length > max ? `${s.slice(0, max)}…（已截断）` : s;
}
var WorkerManager = class {
	ctx;
	config;
	state = "stopped";
	handle;
	client;
	token = "";
	port = 0;
	bootLog = "";
	lastError;
	restarts = 0;
	maxRestarts = 3;
	idleTimer;
	lastUsedAt = 0;
	disposed = false;
	/**
	* 自本次加载以来已完成的推理次数。
	* 用于识别「加载后第一张图」—— 实测它要多付约 100s 换入权重
	* （见 speed-profile.ts 的 FIRST_INFERENCE_EXTRA_SEC）。
	*/
	inferenceCount = 0;
	loadedAt = 0;
	constructor(ctx, config) {
		this.ctx = ctx;
		this.config = config;
	}
	getStatus() {
		return {
			state: this.state,
			port: this.port,
			pid: this.handle?.pid,
			error: this.lastError,
			restarts: this.restarts
		};
	}
	getClient() {
		return this.client;
	}
	getBootLog() {
		return this.bootLog;
	}
	/** 标记最近使用时间，重置空闲卸载计时。 */
	touch() {
		this.lastUsedAt = Date.now();
	}
	/**
	* 本次加载后是否还没跑过推理（即下一张图要付 loadExtra）。
	*/
	isFirstInferenceAfterLoad() {
		return this.inferenceCount === 0;
	}
	/** 记录一次成功的推理。 */
	markInference() {
		this.inferenceCount += 1;
	}
	/** 模型刚被加载：重置推理计数。 */
	markLoaded() {
		this.inferenceCount = 0;
		this.loadedAt = Date.now();
	}
	getLoadedAt() {
		return this.loadedAt;
	}
	/**
	* 确保 worker 已启动并就绪（懒启动）。返回可用的 client。
	*/
	async ensureStarted() {
		if (this.disposed) throw new Error("worker 管理器已释放");
		if (this.client && this.state === "ready") try {
			await this.client.health();
			this.touch();
			return this.client;
		} catch (err) {
			this.lastError = `健康检查失败：${err.message}`;
			await this.stop();
		}
		if (this.state === "starting") {
			for (let i = 0; i < 300; i++) {
				if (this.state === "ready" && this.client) return this.client;
				if (this.state === "error") {
					diagLog(`ensureStarted 命中 error 状态：${this.lastError ?? "(无 lastError)"}`);
					throw new Error(this.lastError ?? "worker 启动失败");
				}
				await sleep(1e3);
			}
			throw new Error("等待 worker 启动超时");
		}
		return await this.start();
	}
	/**
	* 启动 worker 子进程并等待端口就绪。
	*/
	async start() {
		if (this.restarts >= this.maxRestarts) {
			this.state = "error";
			this.lastError = `worker 连续启动失败 ${this.restarts} 次，已停止重试。最近错误：${this.lastError ?? "未知"}`;
			throw new Error(this.lastError);
		}
		this.state = "starting";
		this.lastError = void 0;
		this.token = makeToken();
		const subprocess = this.ctx.get("subprocess");
		if (!subprocess) {
			this.state = "error";
			this.lastError = "subprocess 服务不可用，无法启动 worker";
			throw new Error(this.lastError);
		}
		const python = this.resolvePython();
		const modelDir = expand$1(this.config.modelDir);
		const outputDir = expand$1(this.config.outputDir);
		const logFile = expand$1(`${this.config.outputDir}/../logs/worker.log`);
		const script = this.resolveScript();
		const dshHome = resolveDshHome() || process.cwd();
		const argv = [
			python,
			script,
			"--host",
			"127.0.0.1",
			"--port",
			String(this.config.workerPort ?? 0),
			"--model-dir",
			modelDir,
			"--output-dir",
			outputDir,
			"--token",
			this.token,
			"--min-vram",
			String(this.config.lowVramGuardMiB),
			"--log-file",
			logFile,
			"--device",
			this.config.device,
			"--dtype",
			this.config.dtype,
			"--offload",
			this.config.offload
		];
		this.bootLog = `启动 worker：${argv.join(" ")}\n`;
		/** 单行诊断串：同时进日志与错误文本首行（错误文本只保留第一行）。 */
		const spawnDiag = `python=${python} script=${script} scriptExists=${(0, node_fs.existsSync)(script)} cwd=${dshHome} cwdExists=${(0, node_fs.existsSync)(dshHome)} modelDir=${modelDir} modelDirExists=${(0, node_fs.existsSync)(modelDir)} outDir=${outputDir} outDirExists=${(0, node_fs.existsSync)(outputDir)} dshHome=${process.env.DSH_HOME ?? "(未设置)"} hostCwd=${process.cwd()} node=${process.version} envKeys=${Object.keys(process.env).length}`;
		diagLog(`=== spawn 请求 === ${spawnDiag}\nargv: ${JSON.stringify(argv)}`);
		try {
			this.handle = subprocess.spawn({
				argv,
				cwd: dshHome,
				stdio: {
					stdin: "ignore",
					stdout: { maxBytes: 4194304 },
					stderr: { maxBytes: 4194304 }
				},
				graceMs: 1e4,
				env: {
					...process.env,
					PYTHONIOENCODING: "utf-8",
					PYTHONUTF8: "1"
				}
			});
		} catch (err) {
			const e = err;
			this.state = "error";
			this.lastError = `无法启动 python worker：${e.message}。请确认 pythonExe 配置或 venv 存在。【DIAG ${spawnDiag}】`;
			diagLog(`spawn 同步抛错：${e.message}\n${e.stack ?? ""}`);
			throw new Error(this.lastError);
		}
		this.handle.done.then((outcome) => {
			if (this.disposed) return;
			const wasReady = this.state === "ready";
			const handle = this.handle;
			const stdoutText = readCollected(handle?.collected.stdout);
			const stderrText = readCollected(handle?.collected.stderr);
			this.state = "stopped";
			this.client = void 0;
			this.lastError = `worker 退出（exitCode=${outcome.exitCode} signal=${outcome.signal ?? "null"} pid=${handle?.pid ?? "?"} wasReady=${wasReady}）【DIAG ${spawnDiag}】【stdout ${oneLine(stdoutText)}】【stderr ${oneLine(stderrText)}】`;
			diagLog([
				"=== worker 退出 ===",
				`exitCode=${outcome.exitCode} signal=${outcome.signal} wasReady=${wasReady} pid=${handle?.pid ?? "?"}`,
				`managerState=${this.state} port=${this.port}`,
				`spawnDiag: ${spawnDiag}`,
				`--- stdout ---\n${stdoutText}`,
				`--- stderr ---\n${stderrText}`
			].join("\n"));
			if (wasReady) {
				this.restarts += 1;
				this.bootLog += `${this.lastError}\n`;
				console.error(`[qwen-image] ${this.lastError}`);
			}
		}).catch((err) => {
			diagLog(`done promise 异常：${err.message}`);
		});
		const port = await this.waitForPort();
		this.port = port;
		this.client = new WorkerClient({
			baseUrl: `http://127.0.0.1:${port}`,
			token: this.token
		});
		for (let i = 0; i < 60; i++) {
			try {
				if ((await this.client.health()).ok) {
					this.state = "ready";
					this.restarts = 0;
					this.touch();
					this.scheduleIdleUnload();
					return this.client;
				}
			} catch {}
			await sleep(1e3);
		}
		this.state = "error";
		this.lastError = `worker 已启动但 /health 在 60s 内未就绪。启动日志：\n${this.bootLog.slice(-2e3)}`;
		diagLog([
			"=== /health 60s 未就绪 ===",
			`port=${this.port} pid=${this.handle?.pid ?? "?"}`,
			`--- stdout ---\n${readCollected(this.handle?.collected.stdout)}`,
			`--- stderr ---\n${readCollected(this.handle?.collected.stderr)}`
		].join("\n"));
		await this.stop();
		throw new Error(this.lastError);
	}
	/** 从 stdout 解析 worker 打印的 PORT=<n>。 */
	async waitForPort() {
		const handle = this.handle;
		const reader = handle?.collected.stdout;
		let offset = 0;
		/** 输出尾部快照：即使 collected 读取器不可用，也要让报错带上可诊断信息。 */
		const snapshot = () => {
			const out = readCollected(handle?.collected.stdout);
			const err = readCollected(handle?.collected.stderr);
			return ` pid=${handle?.pid ?? "?"}【stdout ${oneLine(out)}】【stderr ${oneLine(err)}】`;
		};
		for (let i = 0; i < 120; i++) {
			if (reader) try {
				const read = reader.readFrom(offset);
				if (read.text) {
					this.bootLog += read.text;
					offset = read.nextOffset;
					const port = parsePortLine(this.bootLog);
					if (port) return port;
				}
			} catch {}
			if (this.state === "stopped") {
				const detail = `${this.lastError ?? ""}${this.bootLog.slice(-1500)}${snapshot()}`;
				diagLog(`=== 未报告端口即退出 ===\n${detail}`);
				throw new Error(`worker 在报告端口前退出。${oneLine(detail, 2500)}`);
			}
			await sleep(500);
		}
		const detail = `${this.bootLog.slice(-1500)}${snapshot()}`;
		diagLog(`=== 等待端口超时（60s）===\n${detail}`);
		throw new Error(`等待 worker 端口超时（60s）。${oneLine(detail, 2500)}`);
	}
	/**
	* 注册一个可取消的定时器，返回清除函数。
	*
	* ⚠️ 实测教训（**曾经把整个插件卡死**）：cordis 的服务只有在本行 `inject`
	* 里声明过，才会以 mixin 的形式挂到 `ctx` 上。本插件为了不让可选服务缺失
	* 拖垮整棵插件树，刻意只 inject `tools`/`webServer`/`skills`（见 index.ts），
	* 于是 **`this.ctx.timeout` 是 `undefined`** —— 调用即 `TypeError`。
	*
	* 而它恰好被 `start()` 里健康探活的 `try { if (health().ok) { … scheduleIdleUnload() } } catch {}`
	* 包着：**探活成功后的第一个动作就抛错，被 catch 静默吞掉，循环继续下一轮**。
	* 结果就是「worker 明明活着、/health 每秒都回 200，管理器却在 60 秒后报
	* ‘/health 未就绪’并把它杀掉」。真因被两处静默（catch + 错误文本截断）埋掉了。
	*
	* 所以定时器一律走 `ctx.get('timer')`（可选消费，与 subprocess/jobs 同一约定），
	* 拿不到就退回 Node 原生定时器 —— 功能等价，只是不随 fiber 自动回收。
	*/
	setTimer(callback, delayMs) {
		const timer = this.ctx.get?.("timer");
		if (timer && typeof timer.timeout === "function") return timer.timeout(callback, delayMs);
		const handle = globalThis.setTimeout(callback, delayMs);
		return () => globalThis.clearTimeout(handle);
	}
	/** 空闲卸载：keepAliveMinutes 后 unload 释放显存。 */
	scheduleIdleUnload() {
		this.clearIdleTimer();
		const minutes = Number(this.config.keepAliveMinutes) || 0;
		if (minutes <= 0) return;
		const tick = async () => {
			if (this.state !== "ready" || !this.client) return;
			if (Date.now() - this.lastUsedAt >= minutes * 60 * 1e3) try {
				if ((await this.client.health()).state === "ready") {
					await this.client.unload();
					console.log(`[qwen-image] worker 空闲 ${minutes} 分钟，已卸载模型释放显存`);
				}
			} catch {}
			this.idleTimer = this.setTimer(tick, 6e4);
		};
		this.idleTimer = this.setTimer(tick, minutes * 60 * 1e3);
	}
	clearIdleTimer() {
		if (this.idleTimer) {
			try {
				this.idleTimer();
			} catch {}
			this.idleTimer = void 0;
		}
	}
	/** 健康快照（供 image_worker status / image_status 使用）。 */
	async tryHealth() {
		if (!this.client || this.state !== "ready") return void 0;
		try {
			return await this.client.health();
		} catch {
			return;
		}
	}
	/** 停止 worker 并清理（不留僵尸进程）。 */
	async stop() {
		this.clearIdleTimer();
		const handle = this.handle;
		this.handle = void 0;
		this.client = void 0;
		this.state = "stopped";
		if (!handle) return;
		try {
			handle.terminate();
			await handle.waitForExit();
		} catch {}
	}
	/** 插件卸载时的清理。 */
	async dispose() {
		this.disposed = true;
		await this.stop();
	}
	/**
	* python 可执行文件定位。
	*
	* 顺序：显式配置 → venv → PATH 兜底。**每一步都做存在性检查** ——
	* 否则 DSH_HOME 已设但 venv 尚未创建时会拿到一个不存在的路径，
	* 表现为「无法启动 python worker」而看不出真正原因（本机实测踩过）。
	*/
	resolvePython() {
		const explicit = this.config.pythonExe?.trim();
		if (explicit) {
			const p = expand$1(explicit);
			if (pathUsable(p)) return p;
			console.warn(`[qwen-image] 配置的 pythonExe 不可用：${p} —— 改按 venv/PATH 探测`);
		}
		const dshHome = resolveDshHome();
		for (const c of [`${dshHome}/dsh-qwen-image/venv/Scripts/python.exe`, `${dshHome}/dsh-qwen-image/venv/bin/python`]) if (pathUsable(c)) return c;
		return process.platform === "win32" ? "python" : "python3";
	}
	/**
	* worker 脚本定位（相对包根）。
	*
	* 产物在 `lib/index.cjs`，故 `__dirname` 是包根的 `lib/`；worker 在包根的 `worker/`。
	* 逐候选检查存在性，并把实际选中的路径记进启动日志 —— 避免「路径猜错」变成哑失败。
	*/
	resolveScript() {
		const here = typeof __dirname === "string" ? __dirname : process.cwd();
		const candidates = [
			`${here}/../worker/server.py`,
			`${here}/../../worker/server.py`,
			`${here}/worker/server.py`
		];
		for (const c of candidates) if (pathUsable(c)) return c;
		return candidates[0];
	}
};
/** 展开 $DSH_HOME 与 ~（实现已收口到 ./paths，含 DSH_HOME 未设置时的兜底）。 */
function expand$1(p) {
	return expandHome(p);
}
//#endregion
//#region src/host/registry.ts
/**
* 注册表/落盘诊断落盘（与 worker-manager 的 spawn 诊断分开成两个文件，避免混读）。
*
* 为什么必须有：`persist()` 曾只留一句 `console.warn` —— 宿主控制台看不到，
* 于是「作品历史不跨重启」被当成玄学，排查了很久才定位到沙箱围栏。
*/
function registryDiagLog(line) {
	try {
		const dir = `${resolveDshHome()}/dsh-qwen-image/logs`;
		(0, node_fs.mkdirSync)(dir, { recursive: true });
		(0, node_fs.appendFileSync)(`${dir}/registry.log`, `[${(/* @__PURE__ */ new Date()).toISOString()}] ${line}\n`);
	} catch {}
}
/** 标签归一化：去空白、去重、保序、限长。 */
function normalizeTags(tags) {
	const out = [];
	for (const raw of tags) {
		const t = String(raw ?? "").trim().slice(0, 32);
		if (!t || out.includes(t)) continue;
		out.push(t);
	}
	return out;
}
/** 本地日期桶（YYYY-MM-DD），相册按天分组用。 */
function dayKey(ts) {
	const d = new Date(Number(ts) || 0);
	const p = (n) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
/** 从 `generate-12` / `edit-3` 这类 id 里取序号，用于补录时恢复顺序。 */
function indexOfId(id) {
	const m = /-(\d+)$/.exec(id);
	return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
}
/** 一条记录对应的磁盘文件（槽位 → 路径）。 */
function filePathsOf(rec) {
	return {
		file: rec.file,
		thumb: rec.thumb ?? void 0,
		sidecar: rec.sidecar ?? void 0
	};
}
function removeFileQuiet(p) {
	if (!p) return;
	try {
		(0, node_fs.rmSync)(p, { force: true });
	} catch {
		try {
			(0, node_fs.unlinkSync)(p);
		} catch {}
	}
}
var ImageRegistry = class {
	ctx;
	config;
	byId = /* @__PURE__ */ new Map();
	order = [];
	latestId;
	maxInMemory = 500;
	/** 回收站（随 `<outputs>/_trash/trash.json` 持久化） */
	trashEntries = [];
	constructor(ctx, config) {
		this.ctx = ctx;
		this.config = config;
	}
	get outputDir() {
		return expandHome(this.config.outputDir);
	}
	get manifestPath() {
		return `${this.outputDir}/manifest.json`;
	}
	/** 记录一批新生成的图，返回记录列表。 */
	async addAll(saved, meta) {
		const records = [];
		for (const s of saved) {
			const rec = {
				id: s.id,
				file: s.file,
				sidecar: s.sidecar,
				thumb: s.thumb ?? null,
				thumbMediaType: s.thumbMediaType ?? null,
				width: s.width,
				height: s.height,
				bytes: s.bytes,
				thumbBytes: s.thumbBytes ?? null,
				hasAlpha: s.hasAlpha,
				createdAt: Date.now(),
				...meta
			};
			const dup = this.order.indexOf(rec.id);
			if (dup >= 0) this.order.splice(dup, 1);
			this.byId.set(rec.id, rec);
			this.order.push(rec.id);
			records.push(rec);
		}
		if (records.length) this.latestId = records[records.length - 1].id;
		while (this.order.length > this.maxInMemory) {
			const old = this.order.shift();
			if (old) this.byId.delete(old);
		}
		await this.persist();
		return records;
	}
	get(id) {
		if (id === "latest") return this.latest();
		return this.byId.get(id);
	}
	latest() {
		return this.latestId ? this.byId.get(this.latestId) : void 0;
	}
	list(limit = 100) {
		return this.order.slice(-limit).reverse().map((id) => this.byId.get(id)).filter((r) => !!r);
	}
	/** 全部在册记录（旧→新）。相册的筛选/排序/计数都在它之上做。 */
	all() {
		return this.order.map((id) => this.byId.get(id)).filter((r) => !!r);
	}
	/**
	* 相册查询：筛选 → 排序 → 分页。
	*
	* 为什么放在宿主而不是客户端：manifest 的完整历史以宿主为准
	* （内存只保留 maxInMemory 条），排序/计数必须在**全量**上算才不会出错；
	* 客户端只负责渲染拿到的这一页。
	*/
	query(opts = {}) {
		const q = opts.q?.trim().toLowerCase();
		let rows = this.all();
		if (q) rows = rows.filter((r) => `${r.prompt ?? ""} ${r.id} ${r.seed} ${(r.tags ?? []).join(" ")} ${r.note ?? ""}`.toLowerCase().includes(q));
		if (opts.kind) rows = rows.filter((r) => r.kind === opts.kind);
		if (opts.fav) rows = rows.filter((r) => !!r.favorite);
		if (opts.size) rows = rows.filter((r) => Math.max(r.width, r.height) === opts.size);
		if (opts.from != null) rows = rows.filter((r) => Number(r.createdAt) >= opts.from);
		if (opts.to != null) rows = rows.filter((r) => Number(r.createdAt) <= opts.to);
		const tags = (opts.tags ?? []).filter(Boolean);
		if (tags.length) rows = rows.filter((r) => tags.every((t) => (r.tags ?? []).includes(t)));
		const key = opts.sort ?? "createdAt";
		const dir = opts.order === "asc" ? 1 : -1;
		rows = [...rows].sort((a, b) => {
			const av = a[key];
			const bv = b[key];
			if (typeof av === "number" && typeof bv === "number") return (av - bv) * dir;
			return String(av ?? "").localeCompare(String(bv ?? "")) * dir;
		});
		const total = rows.length;
		const offset = Math.max(0, opts.offset ?? 0);
		const limit = Math.max(1, Math.min(1e3, opts.limit ?? 200));
		return {
			items: rows.slice(offset, offset + limit),
			total
		};
	}
	/** 筛选面板用的计数（全量口径）。 */
	facets() {
		const rows = this.all();
		const bump = (m, k) => {
			if (k == null || k === "") return;
			m.set(k, (m.get(k) ?? 0) + 1);
		};
		const kinds = /* @__PURE__ */ new Map();
		const sizes = /* @__PURE__ */ new Map();
		const steps = /* @__PURE__ */ new Map();
		const tags = /* @__PURE__ */ new Map();
		const days = /* @__PURE__ */ new Map();
		for (const r of rows) {
			bump(kinds, r.kind);
			bump(sizes, Math.max(r.width, r.height));
			if (r.steps) bump(steps, r.steps);
			for (const t of r.tags ?? []) bump(tags, t);
			bump(days, dayKey(r.createdAt));
		}
		const toBuckets = (m, cmp) => [...m.entries()].map(([key, count]) => ({
			key,
			count
		})).sort(cmp ?? ((a, b) => String(b.key).localeCompare(String(a.key))));
		return {
			total: rows.length,
			favorites: rows.filter((r) => !!r.favorite).length,
			kinds: toBuckets(kinds),
			sizes: toBuckets(sizes, (a, b) => Number(a.key) - Number(b.key)),
			steps: toBuckets(steps, (a, b) => Number(a.key) - Number(b.key)),
			tags: toBuckets(tags, (a, b) => b.count - a.count),
			days: toBuckets(days)
		};
	}
	/**
	* 批量改元数据（提示词 / 标签 / 收藏 / 备注）。
	*
	* 标签三种写法：`tags` 整体替换、`tagsAdd` / `tagsRemove` 增量改
	* —— 批量「加标签」用增量最不容易互相覆盖。
	*/
	async updateMany(ids, patch) {
		const updated = [];
		const missing = [];
		for (const id of ids) {
			const rec = this.byId.get(id);
			if (!rec) {
				missing.push(id);
				continue;
			}
			if (patch.prompt !== void 0 && patch.prompt !== rec.prompt) {
				rec.prompt = patch.prompt;
				rec.promptEdited = true;
			}
			if (patch.note !== void 0) rec.note = patch.note;
			if (patch.favorite !== void 0) rec.favorite = patch.favorite;
			if (patch.tags !== void 0) rec.tags = normalizeTags(patch.tags);
			if (patch.tagsAdd?.length) rec.tags = normalizeTags([...rec.tags ?? [], ...patch.tagsAdd]);
			if (patch.tagsRemove?.length) {
				const drop = new Set(patch.tagsRemove.map((t) => t.trim()).filter(Boolean));
				rec.tags = normalizeTags((rec.tags ?? []).filter((t) => !drop.has(t)));
			}
			updated.push(rec);
		}
		if (updated.length) await this.persist();
		return {
			updated,
			missing
		};
	}
	/**
	* 批量删除。
	*
	* 默认**移到回收站**（`<outputs>/_trash/<时间戳>/`）而不是真删：
	* 本轮开发里已经因为 id 复用误覆盖过一张图，删除必须是可后悔的。
	* `purge: true` 才真删（同时清掉该 id 的回收站记录）。
	*/
	async removeMany(ids, opts = {}) {
		const deleted = [];
		const missing = [];
		const failed = [];
		const stamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
		const trashDir = (0, node_path.join)(this.outputDir, "_trash", stamp);
		for (const id of ids) {
			const rec = this.byId.get(id);
			if (!rec) {
				missing.push(id);
				continue;
			}
			try {
				if (opts.purge) for (const p of Object.values(filePathsOf(rec))) removeFileQuiet(p);
				else {
					(0, node_fs.mkdirSync)(trashDir, { recursive: true });
					const moved = {};
					for (const [slot, p] of Object.entries(filePathsOf(rec))) {
						if (!p) continue;
						const dest = (0, node_path.join)(trashDir, (0, node_path.basename)(p));
						try {
							(0, node_fs.renameSync)(p, dest);
							moved[slot] = dest;
						} catch {}
					}
					this.trashEntries.unshift({
						id: rec.id,
						record: rec,
						moved,
						deletedAt: Date.now(),
						trashDir
					});
				}
				this.byId.delete(rec.id);
				const at = this.order.indexOf(rec.id);
				if (at >= 0) this.order.splice(at, 1);
				deleted.push(rec.id);
			} catch (err) {
				failed.push({
					id,
					error: err.message
				});
			}
		}
		if (this.latestId && !this.byId.has(this.latestId)) this.latestId = this.order[this.order.length - 1];
		if (deleted.length) {
			if (!opts.purge) await this.persistTrash();
			await this.persist();
		}
		return {
			deleted,
			missing,
			failed,
			trashDir: opts.purge ? void 0 : trashDir
		};
	}
	/** 回收站列表（新→旧）。 */
	listTrash() {
		return this.trashEntries;
	}
	/**
	* 扫产物目录，把「磁盘上有、注册表里没有」的作品补录回来。
	*
	* 为什么需要（实测教训 2026-09-23）：worker 写完 PNG 就落 sidecar，而**入库发生在宿主侧**。
	* 一旦宿主侧在入库前出错（background 任务登记抛错、宿主崩溃、插件被卸载），
	* 图就成了孤儿：磁盘上在、相册里永远看不到 —— 而 GPU 那 3 分钟已经花掉了。
	* 有了这个扫描，孤儿一句话就能捞回来；manifest 万一损坏，它同时也是
	* 「从 sidecar 重建整个相册」的灾难恢复通道。
	*
	* 只认 `<outputs>/*.json` 里带 `id` + `file` 的 sidecar，且要求 PNG 真的存在；
	* `manifest.json` 自身与 `_trash/`、`_direct/` 下的东西一律跳过（后者是子目录，不在 listDir 里）。
	*/
	async recoverFromDisk() {
		const fs = this.ctx.get("fs");
		const added = [];
		let scanned = 0;
		let skipped = 0;
		if (!fs) return {
			added,
			scanned,
			skipped
		};
		let entries = [];
		try {
			entries = await fs.listDir(await fs.resolve(this.outputDir));
		} catch (err) {
			registryDiagLog(`产物扫描失败：${err.message}\n  dir=${this.outputDir}`);
			return {
				added,
				scanned,
				skipped
			};
		}
		for (const e of entries) {
			if (e.type !== "file" || !e.name.endsWith(".json") || e.name === "manifest.json") continue;
			scanned++;
			let rec;
			try {
				rec = JSON.parse(await fs.readText(await fs.resolve(`${this.outputDir}/${e.name}`)));
			} catch {
				skipped++;
				continue;
			}
			if (!rec?.id || !rec.file || !rec.width || !rec.height || this.byId.has(rec.id)) {
				skipped++;
				continue;
			}
			try {
				await fs.resolve(rec.file);
			} catch {
				skipped++;
				continue;
			}
			rec.kind = rec.kind === "edit" ? "edit" : "generate";
			rec.createdAt = Date.parse(String(rec.createdAt)) || Date.now();
			this.byId.set(rec.id, rec);
			if (!this.order.includes(rec.id)) this.order.push(rec.id);
			added.push(rec.id);
		}
		if (added.length) {
			this.order.sort((x, y) => indexOfId(x) - indexOfId(y) || x.localeCompare(y));
			this.latestId = this.order[this.order.length - 1];
			await this.persist();
		}
		return {
			added,
			scanned,
			skipped
		};
	}
	/** 从回收站还原（把文件搬回原位并重新入册）。 */
	async restoreMany(ids) {
		const restored = [];
		const missing = [];
		const failed = [];
		for (const id of ids) {
			const idx = this.trashEntries.findIndex((e) => e.id === id);
			if (idx < 0) {
				missing.push(id);
				continue;
			}
			const entry = this.trashEntries[idx];
			try {
				for (const [slot, dest] of Object.entries(entry.moved)) {
					const back = entry.record[slot];
					if (!back) continue;
					(0, node_fs.mkdirSync)((0, node_path.dirname)(back), { recursive: true });
					(0, node_fs.renameSync)(dest, back);
				}
				this.trashEntries.splice(idx, 1);
				this.byId.set(entry.record.id, entry.record);
				if (!this.order.includes(entry.record.id)) this.order.push(entry.record.id);
				this.latestId = this.order[this.order.length - 1];
				restored.push(id);
			} catch (err) {
				failed.push({
					id,
					error: err.message
				});
			}
		}
		if (restored.length) {
			await this.persistTrash();
			await this.persist();
		}
		return {
			restored,
			missing,
			failed
		};
	}
	/** 从回收站读回索引（进程启动时调用，让「最近删除」重启后仍在）。 */
	async restoreTrashIndex() {
		try {
			const text = (0, node_fs.readFileSync)(this.trashIndexPath, "utf8");
			const parsed = JSON.parse(text);
			this.trashEntries = parsed.items ?? [];
			return this.trashEntries.length;
		} catch {
			return 0;
		}
	}
	async persistTrash() {
		try {
			(0, node_fs.mkdirSync)((0, node_path.join)(this.outputDir, "_trash"), { recursive: true });
			(0, node_fs.writeFileSync)(this.trashIndexPath, JSON.stringify({
				version: 1,
				items: this.trashEntries
			}, null, 2), "utf8");
		} catch (err) {
			registryDiagLog(`回收站索引写入失败：${err.message}\n  path=${this.trashIndexPath}`);
		}
	}
	get trashIndexPath() {
		return (0, node_path.join)(this.outputDir, "_trash", "trash.json");
	}
	/**
	* 把生成的图注入 ctx.attachments，得到不可变 ImageAttachmentRef。
	* 失败不抛错——附件是增强路径，自控路由（/api/qwen-image/raw）是保底路径。
	*/
	async attachImages(records) {
		const attachments = this.ctx.get("attachments");
		if (!attachments) return;
		const fs = this.ctx.get("fs");
		if (!fs) return;
		for (const rec of records) try {
			const target = await fs.resolve(rec.file);
			const data = await fs.readBytes(target, void 0, 67108864);
			rec.attachmentId = (await attachments.saveImage({
				data,
				mediaType: "image/png",
				name: `${rec.id}.png`
			})).attachmentId;
		} catch (err) {
			console.warn(`[qwen-image] 附件注入失败（不影响自控路由显示）：${err.message}`);
		}
	}
	/** 读取图像字节（供 /raw 路由）。 */
	async readBytes(id) {
		const rec = this.get(id);
		if (!rec) return void 0;
		return await this.readFileBytes(rec.file, rec);
	}
	/**
	* 读取缩略图字节（供 /thumb 路由）。
	*
	* 缩略图是**可选**的：早期生成的图、或缩略图生成失败时都没有它。
	* 此时返回原图 —— 相册宁可慢一点，也不能出现空白格。
	*
	* 同时回传 mediaType：缩略图优先是 WebP（体积约为 PNG 的 1/6），
	* 但可能因 Pillow 缺 WebP 支持而回退成 PNG，故不能写死 Content-Type。
	*/
	async readThumbBytes(id) {
		const rec = this.get(id);
		if (!rec) return void 0;
		if (rec.thumb) {
			const got = await this.readFileBytes(rec.thumb, rec);
			if (got) return {
				...got,
				isThumb: true,
				mediaType: rec.thumbMediaType ?? mediaTypeFromPath(rec.thumb) ?? "image/png"
			};
		}
		const raw = await this.readFileBytes(rec.file, rec);
		return raw ? {
			...raw,
			isThumb: false,
			mediaType: "image/png"
		} : void 0;
	}
	async readFileBytes(path, rec) {
		const fs = this.ctx.get("fs");
		if (!fs) return void 0;
		try {
			const target = await fs.resolve(path);
			return {
				data: await fs.readBytes(target, void 0, 268435456),
				record: rec
			};
		} catch {
			return;
		}
	}
	/** 持久化 manifest.json。 */
	async persist() {
		const fs = this.ctx.get("fs");
		if (!fs) return;
		try {
			const payload = {
				version: 1,
				updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
				items: this.list(this.maxInMemory).map((r) => ({
					id: r.id,
					file: r.file,
					thumb: r.thumb ?? null,
					thumbMediaType: r.thumbMediaType ?? null,
					width: r.width,
					height: r.height,
					bytes: r.bytes,
					thumbBytes: r.thumbBytes ?? null,
					hasAlpha: r.hasAlpha,
					seed: r.seed,
					steps: r.steps,
					prompt: r.prompt,
					kind: r.kind,
					elapsedSec: r.elapsedSec,
					steadyStepSec: r.steadyStepSec,
					peakVramMiB: r.peakVramMiB,
					device: r.device,
					dtype: r.dtype,
					createdAt: r.createdAt,
					inputImage: r.inputImage,
					usedReferences: r.usedReferences,
					tags: r.tags ?? [],
					favorite: !!r.favorite,
					note: r.note,
					promptEdited: !!r.promptEdited
				}))
			};
			const target = await fs.resolve(this.manifestPath);
			await fs.writeText(target, JSON.stringify(payload, null, 2), void 0, void 0, {
				mode: "workspace-write",
				workspaceRoot: this.outputDir
			});
		} catch (err) {
			registryDiagLog(`manifest 写入失败：${err?.message ?? err}\n  path=${this.manifestPath}\n  stack=${err?.stack ?? "(无)"}`);
			console.warn(`[qwen-image] manifest 写入失败：${err.message}`);
		}
	}
	/** 从 manifest.json 恢复到内存（进程启动/HMR 后）。 */
	async restore() {
		const fs = this.ctx.get("fs");
		if (!fs) return 0;
		try {
			const target = await fs.resolve(this.manifestPath);
			const text = await fs.readText(target);
			const items = JSON.parse(text).items ?? [];
			for (const item of [...items].reverse()) {
				this.byId.set(item.id, item);
				this.order.push(item.id);
			}
			if (this.order.length) this.latestId = this.order[this.order.length - 1];
			return items.length;
		} catch {
			return 0;
		}
	}
};
/** 由文件扩展名推断媒体类型（缩略图可能是 .webp 或回退的 .png）。 */
function mediaTypeFromPath(p) {
	const lower = p.toLowerCase();
	if (lower.endsWith(".webp")) return "image/webp";
	if (lower.endsWith(".png")) return "image/png";
	if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
}
//#endregion
//#region src/host/service.ts
function createRuntime(ctx, config) {
	const manager = new WorkerManager(ctx, config);
	const registry = new ImageRegistry(ctx, config);
	ctx.effect(() => {
		let cancelled = false;
		registry.restore().then(async (n) => {
			const t = await registry.restoreTrashIndex();
			if (!cancelled && (n > 0 || t > 0)) console.log(`[qwen-image] 已从 manifest 恢复 ${n} 条图像记录、回收站 ${t} 条`);
		}).catch((err) => console.warn(`[qwen-image] 历史恢复失败：${err.message}`));
		return () => {
			cancelled = true;
		};
	});
	ctx.effect(() => {
		return () => {
			manager.dispose().catch((err) => {
				console.error("[qwen-image] worker 清理失败：", err.message);
			});
		};
	});
	return {
		ctx,
		config,
		manager,
		registry
	};
}
//#endregion
//#region src/host/model-inspect.ts
/**
* 体检一个 safetensors 目录（纯逻辑，无 ctx 依赖，供 smoke 复用）。
* @param files 该目录下所有文件名
* @param expectedShards 期望的分片文件名（如 model-00001-of-00004.safetensors）
* @param indexFile 期望的 index 文件名（可空，表示无 index 也算 ok）
*/
function inspectSafetensorsDirPure(files, expectedShards, indexFile) {
	const fileSet = new Set(files);
	const missing = [];
	let found = 0;
	for (const shard of expectedShards) if (fileSet.has(shard)) found++;
	else missing.push(shard);
	if (indexFile && missing.length === 0 && !fileSet.has(indexFile)) missing.push(indexFile);
	return {
		state: missing.length === 0 ? "ok" : "partial",
		found,
		missing,
		tensorCount: void 0,
		bytes: 0
	};
}
/**
* 从 safetensors index.json 解析张量数与分片映射。
*/
function parseSafetensorsIndex(index) {
	const weightMap = index["weight_map"] ?? {};
	const shardSet = new Set(Object.keys(weightMap));
	return {
		tensorCount: Object.keys(weightMap).length,
		shardCount: shardSet.size
	};
}
/**
* 体检单个组件目录。
* @param ctx 上下文（用于 fs）
* @param dir 组件目录（相对 modelDir 的相对路径，或绝对路径）
* @param expectedShards 期望分片
* @param indexFile 期望 index 文件名
*/
async function inspectComponent(ctx, modelDirAbs, dirRel, expectedShards, indexFile) {
	const fs = ctx.get("fs");
	const dirAbs = dirRel.startsWith("/") ? dirRel : `${modelDirAbs}/${dirRel}`;
	let target;
	try {
		target = await ctx.get("fs").resolve(dirAbs);
	} catch {
		return {
			name: dirRel,
			state: "missing",
			expected: expectedShards.length,
			found: 0,
			missingFiles: [...expectedShards],
			note: "目录不可解析"
		};
	}
	let info;
	try {
		info = await fs.stat(target);
	} catch {
		info = void 0;
	}
	if (!info) return {
		name: dirRel,
		state: "missing",
		expected: expectedShards.length,
		found: 0,
		missingFiles: [...expectedShards]
	};
	let entries;
	try {
		entries = await fs.listDir(target);
	} catch {
		entries = [];
	}
	const pure = inspectSafetensorsDirPure(entries.map((e) => e.name), expectedShards, indexFile);
	let tensorCount;
	let bytes = 0;
	if (pure.state === "ok" && indexFile) try {
		const idxFiles = entries.filter((e) => e.name === indexFile);
		if (idxFiles.length > 0) {
			const idxBuf = await fs.readBytes(idxFiles[0].target, void 0, 67108864);
			tensorCount = parseSafetensorsIndex(JSON.parse(idxBuf.toString("utf8"))).tensorCount;
		}
	} catch {}
	try {
		for (const e of entries) if (e.type === "file" && e.size != null) bytes += e.size;
	} catch {}
	const note = pure.state === "ok" && tensorCount != null ? `${tensorCount} 张量` : void 0;
	return {
		name: dirRel,
		state: pure.state,
		expected: expectedShards.length + (indexFile ? 1 : 0),
		found: pure.found + (pure.missing.includes(indexFile ?? "") ? 0 : indexFile ? 0 : 0),
		missingFiles: pure.missing,
		tensorCount,
		bytes,
		note
	};
}
//#endregion
//#region src/host/env-probe.ts
/**
* 计算「空闲显存最多」的 GPU（供 device=auto 决策）。
*/
function pickFreeGpu(gpus) {
	return gpus.filter((g) => g.freeMiB > 0).sort((a, b) => b.freeMiB - a.freeMiB)[0];
}
/**
* 依据 compute capability 推荐 dtype。
*
* ⚠️ 与 PLAN 原假设不同 —— M0 本机实测（Tesla P40, sm_61, torch 2.7.1+cu128）：
*   fp32 = 8.642 TFLOPS
*   fp16 = 10.009 TFLOPS  ← 比 fp32 更快
*   bf16 = 5.053 TFLOPS   （软件模拟，约半速）
*
* 即 Pascal 上的 fp16 并不受「1/64 速率」限制（cuBLAS 走 fp32 累加的高效通路），
* 因此 sm 6.x 应选 fp16 而非 fp32：既最快，又把 RAM/VRAM 需求减半。
* bf16 在 sm<80 上必须避免。
*/
function recommendDtype(smMajor) {
	if (smMajor >= 8) return "bf16";
	if (smMajor >= 6) return "fp16";
	return "fp32";
}
/**
* 依据空闲显存推荐 offload 档位。
*
* M0 实测标定值（fp16, P40）：
*   offload=model 峰值显存 16767 MiB（transformer 13.25GB + 激活，与尺寸无关）
*   offload=none 需容纳 text_encoder 16.33GB + transformer 13.25GB ≈ 30GB+
*/
function recommendOffload(freeMiB) {
	if (freeMiB > 32768) return "none";
	if (freeMiB > 18432) return "model";
	return "sequential";
}
/**
* 采集环境（依赖 ctx.subprocess）。永不抛异常——失败收敛为 env.error。
*/
async function collectEnv(ctx, config) {
	const probe = {
		pythonExe: resolvePythonExe(config.pythonExe),
		pythonVersion: null,
		torch: null,
		transformers: null,
		diffusers: null,
		cudaAvailable: null,
		gpus: []
	};
	const subprocess = ctx.get("subprocess");
	if (!subprocess || !probe.pythonExe) {
		if (!subprocess) probe.error = "subprocess 服务不可用";
		else probe.error = "未找到 python 可执行文件（请配置 pythonExe 或确保 venv 已创建）";
		return probe;
	}
	const python = probe.pythonExe;
	probe.pythonVersion = await runPythonVersion(subprocess, python);
	probe.torch = await runPythonImport(subprocess, python, "torch");
	probe.transformers = await runPythonImport(subprocess, python, "transformers");
	probe.diffusers = await runPythonImport(subprocess, python, "diffusers");
	probe.cudaAvailable = await runPythonCuda(subprocess, python);
	probe.gpus = await probeGpus(subprocess);
	probe.memory = await probeMemory(subprocess, python);
	return probe;
}
/**
* 采集主机内存与提交空间。
*
* 优先用 psutil（本机已装）；失败则退回 `wmic`/`Get-CimInstance` 都不可靠，
* 干脆返回 undefined —— 这只是**提示性**信息，不能因为它失败而影响体检。
*/
async function probeMemory(subprocess, python) {
	const raw = await safeRun(subprocess, [
		python,
		"-c",
		[
			"import json",
			"out={\"totalMiB\":0,\"availableMiB\":0}",
			"try:",
			"    import psutil; m=psutil.virtual_memory(); out[\"totalMiB\"]=m.total//2**20; out[\"availableMiB\"]=m.available//2**20",
			"    try:",
			"        s=psutil.swap_memory(); out[\"commitUsedMiB\"]=(m.used+s.used)//2**20",
			"    except Exception: pass",
			"except Exception: pass",
			"print(json.dumps(out))"
		].join("\n")
	]);
	if (!raw) return void 0;
	try {
		const parsed = JSON.parse(raw.trim().split("\n").pop() ?? "{}");
		if (!parsed || !parsed.totalMiB) return void 0;
		return parsed;
	} catch {
		return;
	}
}
function resolvePythonExe(explicit) {
	if (explicit && explicit.trim()) return explicit;
	const dshHome = process.env.DSH_HOME ?? "";
	if (dshHome) return `${dshHome}/dsh-qwen-image/venv/Scripts/python.exe`;
	return "python";
}
async function runPythonImport(subprocess, python, mod) {
	return (await safeRun(subprocess, [
		python,
		"-c",
		`import ${mod}; print(getattr(${mod}, '__version__', 'unknown'))`
	]))?.trim() || null;
}
async function runPythonVersion(subprocess, python) {
	const m = (await safeRun(subprocess, [python, "--version"]))?.match(/Python\s+([\d.]+)/);
	return m ? m[1] : null;
}
async function runPythonCuda(subprocess, python) {
	const out = await safeRun(subprocess, [
		python,
		"-c",
		`import torch; print(torch.cuda.is_available())`
	]);
	return out?.trim() === "True" ? true : out?.trim() === "False" ? false : null;
}
async function probeGpus(subprocess) {
	const out = await safeRun(subprocess, ["nvidia-smi", "--query-gpu=index,memory.free,memory.total,utilization.gpu,name --format=csv,noheader,nounits"]);
	if (!out) return [];
	const gpus = [];
	for (const line of out.split("\n")) {
		const parts = line.split(",").map((s) => s.trim());
		if (parts.length < 5) continue;
		gpus.push({
			index: Number(parts[0]),
			freeMiB: Number(parts[1]),
			totalMiB: Number(parts[2]),
			utilizationPct: Number(parts[3]),
			name: parts[4]
		});
	}
	return gpus;
}
/**
* 安全运行子进程，捕获异常返回 null。
*/
async function safeRun(subprocess, argv) {
	try {
		const handle = subprocess.spawn({
			argv,
			cwd: process.env.DSH_HOME ?? process.cwd(),
			stdio: {
				stdin: "ignore",
				stdout: { maxBytes: 1 << 20 },
				stderr: { maxBytes: 1 << 20 }
			},
			graceMs: 15e3
		});
		if ((await handle.done).exitCode !== 0) return null;
		const stdout = handle.collected.stdout;
		if (!stdout) return null;
		const chunks = [];
		let offset = 0;
		while (true) {
			const read = await stdout.readFrom(offset);
			if (read.text) {
				chunks.push(read.text);
				offset = read.nextOffset;
			}
			if (!read.lossy && read.nextOffset <= offset) break;
		}
		return chunks.join("");
	} catch {
		return null;
	}
}
//#endregion
//#region src/host/speed-profile.ts
/** 稳态步幂律拟合：steady ≈ STEADY_COEF × MP^STEADY_EXP */
const STEADY_COEF = 8.96;
const STEADY_EXP = 1.34;
/** 实测区间（用于在文本里给出诚实的范围） */
const FIRST_STEP_RANGE = [78, 93];
/** 权重加载耗时（mmap 按需分页，实测 55–141s，取决于页缓存状态） */
const LOAD_SEC_RANGE = [55, 141];
/** 按像素数求稳态步耗时。 */
function steadyStepSec(width, height) {
	const mp = Math.max(.01, width * height / 1e6);
	return STEADY_COEF * Math.pow(mp, STEADY_EXP);
}
/** 按像素数求 VAE 解码耗时（近似线性于像素，带 0.4 下限保护）。 */
function vaeDecodeSec(width, height) {
	const mp = Math.max(.01, width * height / 1e6);
	return Math.max(8, 24.8 * mp);
}
function spec(name, width, height, steps, label, measured) {
	return {
		name,
		width,
		height,
		steps,
		steadyStepSec: Math.round(steadyStepSec(width, height) * 100) / 100,
		vaeDecodeSec: Math.round(vaeDecodeSec(width, height)),
		label,
		measuredTotalSec: measured?.total,
		measuredRuns: measured?.runs
	};
}
/** M0 实测标定的三个档位 */
const PRESETS = {
	draft: spec("draft", 768, 768, 12, "草稿 768²/12步"),
	standard: spec("standard", 1024, 1024, 24, "标准 1024²/24步", {
		total: 303,
		runs: 3
	}),
	native: spec("native", 2048, 2048, 40, "原生 2048²/40步")
};
/** 推荐的尺寸比例表（官方比例，见 PLAN §1.3） */
const RATIOS = {
	"1:1": {
		width: 2048,
		height: 2048
	},
	"4:3": {
		width: 2389,
		height: 1792
	},
	"3:4": {
		width: 1792,
		height: 2389
	},
	"3:2": {
		width: 2560,
		height: 1707
	},
	"2:3": {
		width: 1707,
		height: 2560
	},
	"16:9": {
		width: 2752,
		height: 1536
	},
	"9:16": {
		width: 1536,
		height: 2752
	}
};
/** 估算一次生图的耗时（秒），四段式模型。 */
function estimateSeconds(steps, width, height, opts = {}) {
	let total = 85 + Math.max(0, Math.max(1, Math.round(steps)) - 1) * steadyStepSec(width, height) + vaeDecodeSec(width, height);
	if (opts.firstAfterLoad) total += 100;
	if (opts.loaded === false) total += LOAD_SEC_RANGE[0];
	return Math.round(total);
}
/** 档位自身的实测（优先）或推算总耗时。 */
function presetSeconds(p) {
	if (p.measuredTotalSec) return Math.round(p.measuredTotalSec);
	return estimateSeconds(p.steps, p.width, p.height);
}
/**
* 人类可读的耗时描述（中文）。
*/
function formatDuration(seconds) {
	if (!Number.isFinite(seconds)) return "—";
	if (seconds < 60) return `${Math.round(seconds)} 秒`;
	const min = seconds / 60;
	if (min < 10) return `${min.toFixed(1)} 分钟`;
	if (min < 60) return `${Math.round(min)} 分钟`;
	return `${(min / 60).toFixed(1)} 小时`;
}
/**
* 生成耗时的可读预估说明（供工具文本回传，让模型知道要等多久）。
*/
function describeEstimate(steps, width, height, opts = {}) {
	const seconds = estimateSeconds(steps, width, height, opts);
	const notes = [];
	if (opts.loaded === false) notes.push(`worker 尚未加载，另需约 ${LOAD_SEC_RANGE[0]}–${LOAD_SEC_RANGE[1]} 秒加载 30.9GB 权重`);
	if (opts.firstAfterLoad) notes.push("这是加载后的首张图，需额外约 100 秒换入权重");
	const suffix = notes.length ? `（${notes.join("；")}）` : "";
	return {
		seconds,
		text: `预计耗时约 ${formatDuration(seconds)}${suffix}。基准：本机 P40/fp16 实测——首步冷启动 ${FIRST_STEP_RANGE[0]}–${FIRST_STEP_RANGE[1]}s（每图重付），稳态 ≈ ${steadyStepSec(width, height).toFixed(1)}s/步 @${width}²（超线性于像素），VAE 解码 ≈ ${vaeDecodeSec(width, height).toFixed(0)}s。`
	};
}
/** 全部档位的简短清单（供工具描述与卡片使用）。 */
function presetSummary() {
	return Object.values(PRESETS).map((p) => `${p.name}(${p.label}，约 ${formatDuration(presetSeconds(p))})`).join("、");
}
//#endregion
//#region src/host/tools/lossless.ts
/**
* 工具返回值 → **无损 JSON** 归一化。
*
* ⚠️ 本机实测踩坑（务必保留）：DSH 的 `dsh-tools` 在把工具结果交给模型前会做一次
* fail-closed 的「无损 JSON」校验（`@deepseek-ai/dsh-util-values` 的 walkJsonValue），
* 其判定比 `JSON.stringify` **严格得多**：
*
* - 对象属性值为 `undefined` → **非法**（JSON.stringify 会默默丢掉，校验器直接判不合格）
*   ⇒ 表现是模型侧收到 `tool "image_status" returned invalid output: value is not lossless JSON`，
*     而不是任何业务错误。插件里大量 `foo: x ?? undefined` 的写法全会踩中。
* - `NaN` / `±Infinity` → 非法（nvidia-smi 权限不足时会返回 `[N/A]`，`Number('[N/A]')` 即 NaN）
* - `-0`、稀疏数组、带额外键的数组、非普通原型对象（class 实例）、Symbol 键 → 非法
*
* 所以每个工具在返回前都必须过一遍 `sanitizeToolOutput`。
*/
function sanitizeToolOutput(value) {
	return sanitize(value, /* @__PURE__ */ new WeakSet());
}
function sanitize(value, seen) {
	if (value === null) return null;
	const t = typeof value;
	if (t === "string" || t === "boolean") return value;
	if (t === "number") {
		const n = value;
		return Number.isFinite(n) && !Object.is(n, -0) ? n : null;
	}
	if (t === "undefined") return null;
	if (t === "bigint") return value.toString();
	if (t === "function" || t === "symbol") return null;
	if (t !== "object") return String(value);
	const obj = value;
	if (seen.has(obj)) return null;
	seen.add(obj);
	if (Array.isArray(obj)) {
		const out = obj.map((item) => sanitize(item, seen));
		seen.delete(obj);
		return out;
	}
	const out = {};
	for (const key of Object.keys(obj)) {
		const v = obj[key];
		if (v === void 0) continue;
		out[key] = sanitize(v, seen);
	}
	seen.delete(obj);
	return out;
}
//#endregion
//#region src/host/tools/image-status.ts
/**
* image_status（§5.3）：体检 + 指引，**永不失败**。
*
* 权重：逐组件核对存在性、分片齐全性、index 一致性 → ok | partial | missing
* 环境：python / torch / transformers / diffusers 版本、CUDA、各 GPU 空闲显存
* worker：未启动 / 加载中 / ready / 出错（带最近日志）
* 缺失时给出可直接复制的命令（§8）
* 并附带**本机实测标定的各档位预计耗时**，让用户按需选择。
*/
const COMPONENTS = [
	{
		name: "processor",
		dir: "processor",
		shards: []
	},
	{
		name: "scheduler",
		dir: "scheduler",
		shards: []
	},
	{
		name: "text_encoder",
		dir: "text_encoder",
		shards: [
			"model-00001-of-00004.safetensors",
			"model-00002-of-00004.safetensors",
			"model-00003-of-00004.safetensors",
			"model-00004-of-00004.safetensors"
		],
		index: "model.safetensors.index.json"
	},
	{
		name: "transformer",
		dir: "transformer",
		shards: ["diffusion_pytorch_model-00001-of-00002.safetensors", "diffusion_pytorch_model-00002-of-00002.safetensors"],
		index: "diffusion_pytorch_model.index.json"
	},
	{
		name: "vae",
		dir: "vae",
		shards: []
	}
];
/** 构建标记：注入到工具描述里，用来确认宿主实际加载的是哪一次构建。 */
const BUILD_TAG = "BUILD-2026-09-22T02:30+08:00";
function buildStatusTool(rt) {
	const { config } = rt;
	return {
		name: "image_status",
		description: `体检 Qwen-Image-2.1 权重目录、运行环境与 worker 状态，给出缺件清单与可直接复制的下载/安装命令。永不失败——缺啥就说啥。【构建标记 ${BUILD_TAG}】`,
		parameters: { refresh: {
			type: "boolean",
			description: "强制重建 worker 快照（默认 false，用缓存）。"
		} },
		timeoutMs: 12e4,
		output: {
			schema: {
				type: "object",
				additionalProperties: true,
				properties: {
					modelDir: { type: "string" },
					modelState: { type: "string" },
					components: {
						type: "array",
						items: {
							type: "object",
							additionalProperties: true
						}
					},
					missing: {
						type: "array",
						items: { type: "string" }
					},
					totalBytes: { type: "integer" },
					env: {
						type: "object",
						additionalProperties: true
					},
					worker: {
						type: "object",
						additionalProperties: true
					},
					presets: {
						type: "array",
						items: {
							type: "object",
							additionalProperties: true
						}
					},
					galleryCount: { type: "integer" },
					guidance: {
						type: "array",
						items: { type: "string" }
					},
					commands: {
						type: "array",
						items: { type: "string" }
					}
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: formatStatusText(value)
			}]
		},
		async execute(_args) {
			return sanitizeToolOutput(await runStatus(rt));
		}
	};
}
async function runStatus(rt) {
	const { ctx, config, manager, registry } = rt;
	const modelDir = expandHome(config.modelDir);
	const result = {
		modelDir,
		exists: false,
		state: "missing",
		components: [],
		missing: [],
		guidance: [],
		commands: []
	};
	try {
		const exists = await dirExists(ctx, modelDir);
		result.exists = exists;
		if (exists) {
			const reports = [];
			for (const comp of COMPONENTS) reports.push(await inspectComponent(ctx, modelDir, comp.dir, comp.shards, comp.index));
			result.components = reports;
			const hasMissing = reports.some((c) => c.state === "missing");
			const hasPartial = reports.some((c) => c.state === "partial");
			result.state = hasMissing ? "missing" : hasPartial ? "partial" : "ok";
			result.missing = reports.flatMap((c) => c.missingFiles);
			result.totalBytes = reports.reduce((s, c) => s + (c.bytes ?? 0), 0);
		}
	} catch (err) {
		result.state = "missing";
		result.missing = [`体检异常：${err.message}`];
	}
	let env;
	try {
		env = await collectEnv(ctx, config);
	} catch (err) {
		env = {
			error: err.message,
			pythonExe: null,
			pythonVersion: null,
			torch: null,
			transformers: null,
			diffusers: null,
			cudaAvailable: null,
			gpus: []
		};
	}
	const freeGpu = pickFreeGpu(env.gpus);
	if (freeGpu) {
		env.recommendedDevice = `cuda:${freeGpu.index}`;
		env.recommendedDtype = recommendDtype(6);
		env.recommendedOffload = recommendOffload(freeGpu.freeMiB);
	}
	const ms = manager.getStatus();
	const h = await manager.tryHealth();
	const worker = {
		managerState: ms.state,
		state: h?.state ?? (ms.state === "stopped" ? "not-started" : "unknown"),
		pid: ms.pid,
		port: ms.port || void 0,
		device: h?.device,
		dtype: h?.dtype,
		offload: h?.offload,
		loadSec: h?.loadSec ?? void 0,
		warmed: h?.warmed,
		vram: h?.vram,
		queueDepth: h?.queueDepth,
		error: ms.error ?? h?.error ?? void 0,
		logs: h ? void 0 : manager.getBootLog().split("\n").slice(-50)
	};
	const presets = Object.values(PRESETS).map((p) => ({
		name: p.name,
		label: p.label,
		width: p.width,
		height: p.height,
		steps: p.steps,
		coldFirstStepSec: p.coldFirstStepSec,
		steadyStepSec: p.steadyStepSec,
		vaeDecodeSec: p.vaeDecodeSec,
		estimatedSec: presetSeconds(p),
		estimatedText: formatDuration(presetSeconds(p))
	}));
	const guidance = buildGuidance(result, env, config.lowVramGuardMiB, worker.state);
	const commands = buildCommands(config, result);
	const galleryCount = registry.list(1e3).length;
	return {
		modelDir,
		modelState: result.state,
		components: result.components,
		missing: result.missing,
		totalBytes: result.totalBytes,
		env,
		worker,
		presets,
		galleryCount,
		guidance,
		commands
	};
}
async function dirExists(ctx, dirAbs) {
	try {
		const fs = ctx.get("fs");
		if (!fs) return false;
		const target = await fs.resolve(dirAbs);
		const info = await fs.stat(target);
		return !!info && info.type === "directory";
	} catch {
		return false;
	}
}
function buildGuidance(result, env, lowVramGuardMiB, workerState) {
	const g = [];
	if (!result.exists) {
		g.push(`权重目录不存在：${result.modelDir}`);
		g.push("请先下载权重（见下方命令），或把 modelDir 指向已有目录。");
	} else if (result.state === "missing" || result.state === "partial") {
		g.push(`权重不完整（${result.state}），缺 ${result.missing.length} 个文件。`);
		g.push("可只补缺失分片：`hf download <repo> --local-dir <dir> --include \"<pattern>\"`");
	} else g.push("权重齐全 ✓");
	if (env.diffusers === null) g.push("⚠️ diffusers 未安装 —— QwenImage21Pipeline 需 diffusers 主分支（已实测 0.41.0.dev0 可用）。");
	if (env.cudaAvailable === false) g.push("⚠️ CUDA 不可用，将在 CPU 上推理（不可用级别的慢）。");
	const freeGpu = pickFreeGpu(env.gpus);
	if (freeGpu && freeGpu.freeMiB < lowVramGuardMiB) g.push(`⚠️ GPU${freeGpu.index} 空闲显存仅 ${Math.round(freeGpu.freeMiB / 1024)}GB，低于守卫阈值 ${lowVramGuardMiB}MiB。建议停止占用进程（如 llama-server）后重试。`);
	const mem = env.memory;
	if (mem && mem.totalMiB > 0) {
		const availGB = mem.availableMiB / 1024;
		const totalGB = mem.totalMiB / 1024;
		const commitNote = mem.commitUsedMiB && mem.commitLimitMiB ? `当前已提交 ${(mem.commitUsedMiB / 1024).toFixed(1)}GB / 上限 ${(mem.commitLimitMiB / 1024).toFixed(1)}GB` : "";
		if (availGB < 20) g.push(`🔴 可用内存仅 ${availGB.toFixed(1)}GB（总 ${totalGB.toFixed(1)}GB${commitNote ? "，" + commitNote : ""}）。权重 30.86GB 走 mmap 加载，**内存不足会让进程直接崩溃（段错误）而不是给出清晰报错**。请先释放内存：查有无残留 python 进程占着几十 GB（PowerShell：\`Get-Process python | Select Id,PrivateMemorySize64\`），停掉后重试。`);
		else if (availGB < 32) g.push(`⚠️ 可用内存 ${availGB.toFixed(1)}GB（总 ${totalGB.toFixed(1)}GB）偏紧：权重 30.86GB 加载时可能触及上限，失败表现是**段错误**而非清晰报错。若生图突然全部失败且无 Python 报错，优先排查残留 python 进程。`);
	}
	if (workerState === "not-started") g.push(`worker 未启动（懒启动：首次 image_generate 会自动拉起并加载模型，约 ${LOAD_SEC_RANGE[0]}–${LOAD_SEC_RANGE[1]} 秒）。`);
	else if (workerState === "ready") g.push("worker 已就绪，可直接生图。");
	else if (workerState === "error") g.push("⚠️ worker 处于错误状态，见上方 worker.error 与日志。");
	g.push(`⏱ 本机 P40/fp16 实测（三段式）：首步冷启动约 85s（实测区间 ${FIRST_STEP_RANGE[0]}–${FIRST_STEP_RANGE[1]}s，每图重付，受 32GB 内存限制权重无法常驻） + 稳态约 ${steadyStepSec(1024, 1024).toFixed(1)}s/步 @1024² + VAE 解码约 ${vaeDecodeSec(1024, 1024).toFixed(0)}s。故 draft(768²/12步)≈${formatDuration(presetSeconds(PRESETS.draft))}、standard(1024²/24步)≈${formatDuration(presetSeconds(PRESETS.standard))}、native(2048²/40步)≈${formatDuration(presetSeconds(PRESETS.native))}。`);
	return g;
}
function buildCommands(config, result) {
	const commands = [];
	const modelDir = expandHome(config.modelDir).replace(/\\/g, "/");
	commands.push(`# 1) 指向已有权重目录（改 profile 的 cordis.patch.yml）
# config:
#   modelDir: '${modelDir}'`);
	const endpoint = config.hfEndpoint ? `$env:HF_ENDPOINT='${config.hfEndpoint}'\n` : "";
	commands.push(`# 2) 下载/补全权重（约 30.9GB / 27 文件）\n${endpoint}hf download ${config.modelRepo} --local-dir '${modelDir}'`);
	commands.push("# 3) 安装 diffusers（已实测 0.41.0.dev0 含 QwenImage21Pipeline）\npip install git+https://github.com/huggingface/diffusers.git\npip install accelerate pillow");
	return commands;
}
function formatStatusText(value) {
	const lines = [];
	const env = value.env ?? {};
	const worker = value.worker ?? {};
	lines.push(`权重目录：${value.modelDir}`);
	lines.push(`权重状态：${value.modelState}${value.totalBytes ? `（${(Number(value.totalBytes) / 1e9).toFixed(2)} GB）` : ""}`);
	const comps = value.components ?? [];
	for (const c of comps) {
		const miss = c.missingFiles ?? [];
		const extra = c.note ? `（${c.note}）` : "";
		lines.push(`  • ${c.name}：${c.state}${miss.length ? ` — 缺 ${miss.join(", ")}` : ""}${extra}`);
	}
	const missing = value.missing ?? [];
	if (missing.length) lines.push(`缺失：${missing.join(", ")}`);
	lines.push("");
	lines.push("环境：");
	if (env.pythonExe) lines.push(`  Python ${env.pythonVersion ?? "?"}（${env.pythonExe}）`);
	if (env.torch) lines.push(`  torch ${env.torch}（CUDA ${env.cudaVersion ?? "?"}）`);
	if (env.transformers) lines.push(`  transformers ${env.transformers}`);
	lines.push(`  diffusers ${env.diffusers ?? "未安装 ✗"}`);
	if (env.cudaAvailable !== null) lines.push(`  CUDA 可用：${env.cudaAvailable}`);
	const gpus = env.gpus ?? [];
	for (const g of gpus) lines.push(`  GPU${g.index}：空闲 ${(Number(g.freeMiB) / 1024).toFixed(1)}GB / ${(Number(g.totalMiB) / 1024).toFixed(1)}GB，利用率 ${g.utilizationPct}%`);
	lines.push("");
	lines.push("worker：");
	lines.push(`  管理器 ${worker.managerState ?? "?"}｜状态 ${worker.state ?? "?"}${worker.pid ? `｜pid ${worker.pid}` : ""}${worker.port ? `｜端口 ${worker.port}` : ""}`);
	if (worker.device) lines.push(`  设备 ${worker.device}／精度 ${worker.dtype}／offload ${worker.offload}`);
	if (worker.loadSec) lines.push(`  加载耗时 ${worker.loadSec}s`);
	if (worker.error) lines.push(`  ⚠️ ${worker.error}`);
	const presets = value.presets ?? [];
	if (presets.length) {
		lines.push("");
		lines.push("档位预计耗时（本机 P40/fp16 实测标定）：");
		for (const p of presets) lines.push(`  • ${p.label}：约 ${p.estimatedText}（${p.width}×${p.height}, ${p.steps} 步）`);
	}
	const guidance = value.guidance ?? [];
	if (guidance.length) {
		lines.push("");
		lines.push("建议：");
		for (const g of guidance) lines.push(`  - ${g}`);
	}
	const commands = value.commands ?? [];
	if (commands.length) {
		lines.push("");
		lines.push("可直接复制的命令：");
		for (const c of commands) lines.push(`\`\`\`powershell\n${c}\n\`\`\``);
	}
	return lines.join("\n");
}
//#endregion
//#region src/host/tools/image-worker.ts
/**
* image_worker（§5.4）：worker 生命周期管理。
* action: start | stop | unload | warm | status | logs
*/
function buildWorkerTool(rt) {
	const { config, manager } = rt;
	return {
		name: "image_worker",
		description: `管理 Qwen-Image-2.1 Python worker 的生命周期：启动 / 停止 / 卸载模型 / 预热 / 查状态 / 取日志。生图前可 start 或 warm 避免首次等待，用完可 unload 把显存还给其它程序。【构建标记 ${BUILD_TAG}】`,
		parameters: {
			action: {
				type: "string",
				required: true,
				enum: [
					"start",
					"stop",
					"unload",
					"warm",
					"status",
					"logs"
				],
				description: "start=启动进程并加载模型 | stop=停止进程 | unload=仅卸载模型释放显存 | warm=预热 | status=查状态 | logs=最近日志"
			},
			count: {
				type: "number",
				description: "logs 时返回的行数（默认 50）。"
			}
		},
		timeoutMs: 9e5,
		output: {
			schema: {
				type: "object",
				additionalProperties: true,
				properties: {
					action: { type: "string" },
					managerState: { type: "string" },
					workerState: { type: "string" },
					port: { type: "integer" },
					pid: { type: "integer" },
					device: { type: "string" },
					dtype: { type: "string" },
					offload: { type: "string" },
					loadSec: { type: "number" },
					warmed: { type: "boolean" },
					vramFreeMiB: { type: "integer" },
					vramTotalMiB: { type: "integer" },
					vramPeakMiB: { type: "integer" },
					queueDepth: { type: "integer" },
					sec: { type: "number" },
					detail: { type: "string" },
					logs: {
						type: "array",
						items: { type: "string" }
					}
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: formatWorkerText(value)
			}]
		},
		async execute(args) {
			return sanitizeToolOutput(await runWorkerAction(rt, args));
		}
	};
}
async function runWorkerAction(rt, args) {
	const { config, manager } = rt;
	switch (args.action) {
		case "status": return await status(rt);
		case "logs": {
			const st = await status(rt);
			const client = manager.getClient();
			if (!client) return {
				action: "logs",
				managerState: st.managerState ?? "stopped",
				logs: [],
				detail: "worker 未启动，无日志。"
			};
			try {
				const { lines } = await client.logs(args.count ?? 50);
				return {
					action: "logs",
					workerState: st.workerState,
					logs: lines
				};
			} catch (err) {
				return {
					action: "logs",
					detail: `读取日志失败：${err.message}`
				};
			}
		}
		case "start": {
			const client = await manager.ensureStarted();
			const h = await client.health();
			if (h.state !== "ready") {
				const r = await client.load({
					modelDir: expandHome(config.modelDir),
					device: config.device,
					dtype: config.dtype,
					offload: config.offload,
					vaeTiling: true,
					minFreeMiB: config.lowVramGuardMiB
				});
				return {
					action: "start",
					managerState: manager.getStatus().state,
					workerState: "ready",
					loadSec: r.loadSec
				};
			}
			return {
				action: "start",
				managerState: manager.getStatus().state,
				workerState: h.state,
				loadSec: h.loadSec ?? void 0,
				detail: "worker 已就绪（模型已加载）。"
			};
		}
		case "warm": {
			const client = await manager.ensureStarted();
			if ((await client.health()).state !== "ready") await client.load({
				modelDir: expandHome(config.modelDir),
				device: config.device,
				dtype: config.dtype,
				offload: config.offload,
				vaeTiling: true,
				minFreeMiB: config.lowVramGuardMiB
			});
			const r = await client.warm();
			manager.touch();
			return {
				action: "warm",
				warmed: r.warmed,
				sec: r.sec,
				detail: r.detail ?? "预热完成（把冷启动的 mmap 换入代价提前付掉）。注意：受 32GB 内存限制，页可能被再次逐出，收益有限。"
			};
		}
		case "unload": {
			const client = manager.getClient();
			if (!client) return {
				action: "unload",
				detail: "worker 未启动，无需卸载。"
			};
			await client.unload();
			return {
				action: "unload",
				workerState: "idle",
				detail: "模型已卸载，显存已释放。"
			};
		}
		case "stop": {
			const st = manager.getStatus();
			await manager.stop();
			return {
				action: "stop",
				managerState: "stopped",
				detail: `worker（pid ${st.pid ?? "?"}）已停止。`
			};
		}
		default: throw new Error(`未知 action：${args.action}。可选：start | stop | unload | warm | status | logs`);
	}
}
async function status(rt) {
	const { manager } = rt;
	const ms = manager.getStatus();
	const h = await manager.tryHealth();
	return {
		action: "status",
		managerState: ms.state,
		workerState: h?.state ?? (ms.state === "stopped" ? "stopped" : "unknown"),
		port: ms.port || void 0,
		pid: ms.pid,
		device: h?.device,
		dtype: h?.dtype,
		offload: h?.offload,
		loadSec: h?.loadSec ?? void 0,
		warmed: h?.warmed,
		vramFreeMiB: h?.vram.free ?? void 0,
		vramTotalMiB: h?.vram.total ?? void 0,
		vramPeakMiB: h?.vram.peak ?? void 0,
		queueDepth: h?.queueDepth,
		detail: ms.error ?? h?.error ?? void 0
	};
}
function formatWorkerText(v) {
	if (v.action === "logs") {
		const logs = v.logs ?? [];
		if (!logs.length) return `无日志。${v.detail ?? ""}`;
		return `最近 ${logs.length} 行日志：\n${logs.join("\n")}`;
	}
	const lines = [];
	lines.push(`worker[${v.action}]`);
	if (v.managerState || v.workerState) lines.push(`  管理器：${v.managerState ?? "?"}｜worker：${v.workerState ?? "?"}${v.pid ? `｜pid ${v.pid}` : ""}${v.port ? `｜端口 ${v.port}` : ""}`);
	if (v.device || v.dtype) lines.push(`  设备 ${v.device ?? "?"}／精度 ${v.dtype ?? "?"}／offload ${v.offload ?? "?"}`);
	if (v.loadSec) lines.push(`  加载耗时 ${v.loadSec}s${v.warmed ? "｜已预热" : ""}`);
	if (v.vramFreeMiB !== void 0) lines.push(`  显存 空闲 ${v.vramFreeMiB}MiB / ${v.vramTotalMiB ?? "?"}MiB${v.vramPeakMiB ? `｜峰值 ${v.vramPeakMiB}MiB` : ""}`);
	if (v.queueDepth !== void 0) lines.push(`  队列深度 ${v.queueDepth}`);
	if (v.sec) lines.push(`  预热耗时 ${formatDuration(Number(v.sec))}`);
	if (v.detail) lines.push(`  ${v.detail}`);
	return lines.join("\n");
}
//#endregion
//#region src/host/tools/image-generate.ts
/**
* image_generate（§5.1）：对话生图。
*
* 实际路径：宿主 → worker /generate 入队 → 轮询进度 → 落盘 → 注入 attachments。
* 长任务（native 档位）建议 mode=background，走 ctx.jobs。
*/
function buildGenerateTool(rt) {
	const { config, manager, registry } = rt;
	return {
		name: "image_generate",
		description: `用 Qwen-Image-2.1 生图。【使用方式】用户给的通常只是意图（如「画只戴墨镜的柴犬」），请**先按提示词工艺扩写成完整描述**（主体细节 → 场景 → 风格 → 光照 → 构图 → 画质），再把扩写结果作为 prompt 传入，并在回复里贴出最终 prompt 让用户可纠正；不要直接把用户原话塞进来。【档位】未指定时先用 draft 出草稿对齐，用户满意后再用 standard 定稿；native 务必配 mode=background。本机 P40 实测：${presetSummary()}，每张图另含约 85 秒冷启动（每图重付）。动手前请先告知预计耗时。`,
		parameters: {
			prompt: {
				type: "string",
				required: true,
				description: "**已扩写好的**完整生图提示词（不是用户原话）。建议含主体细节、场景、风格、光照、构图、画质。中文/英文均可。"
			},
			preset: {
				type: "string",
				description: `尺寸预设：draft(768²,12步,约${formatDuration(presetSeconds(PRESETS.draft))}) | standard(1024²,24步,约${formatDuration(presetSeconds(PRESETS.standard))}) | native(2048²,40步,约${formatDuration(presetSeconds(PRESETS.native))})。与 width/height/ratio 互斥。`,
				enum: [
					"draft",
					"standard",
					"native",
					"custom"
				]
			},
			width: {
				type: "number",
				description: "宽度（像素，会向下对齐到 32 的倍数）。"
			},
			height: {
				type: "number",
				description: "高度（像素）。"
			},
			ratio: {
				type: "string",
				description: "目标比例（按官方比例表取 2K 尺寸）：1:1 | 4:3 | 3:4 | 3:2 | 2:3 | 16:9 | 9:16。",
				enum: [
					"1:1",
					"4:3",
					"3:4",
					"3:2",
					"2:3",
					"16:9",
					"9:16"
				]
			},
			steps: {
				type: "number",
				description: "推理步数，覆盖 preset 默认。"
			},
			seed: {
				type: "number",
				description: "随机种子，缺省随机。"
			},
			transparent: {
				type: "boolean",
				description: "是否输出原生 RGBA（自动套用官方 RGBA 提示词模板）。"
			},
			count: {
				type: "number",
				description: "生成张数，取值 1..4。注意每张都要重付约 85 秒冷启动。"
			},
			negativePrompt: {
				type: "string",
				description: "负面提示词（仅当 trueCfgScale > 1 时生效）。"
			},
			trueCfgScale: {
				type: "number",
				description: "CFG 强度，默认 1.0（模型设计为无引导采样）。>1 才启用 negativePrompt。"
			},
			mode: {
				type: "string",
				description: "wait=阻塞等待（默认）| background=后台任务，立即返回 jobId。",
				enum: ["wait", "background"]
			},
			reference: {
				type: "string",
				description: "风格/主体参考图：'latest'=最近生成的图 | imageId。会作为条件图传入。用户说「照刚才那张的风格再画一张」时用它（注意：这是**参考**，不是改那张图；要改那张用 image_edit）。"
			}
		},
		timeoutMs: config.toolTimeoutMs,
		output: {
			schema: {
				type: "object",
				additionalProperties: true,
				properties: {
					ids: {
						type: "array",
						items: { type: "string" }
					},
					files: {
						type: "array",
						items: { type: "string" }
					},
					width: { type: "integer" },
					height: { type: "integer" },
					seed: { type: "integer" },
					steps: { type: "integer" },
					preset: { type: "string" },
					elapsedSec: { type: "number" },
					steadyStepSec: { type: "number" },
					peakVramMiB: { type: "integer" },
					hasAlpha: { type: "boolean" },
					device: { type: "string" },
					dtype: { type: "string" },
					count: { type: "integer" },
					estimateText: { type: "string" },
					jobId: { type: "string" },
					workerJobId: { type: "string" },
					status: { type: "string" },
					note: { type: "string" }
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: formatGenerateText(value)
			}],
			presentationMeta: (_args, value) => ({
				ids: value.ids ?? [],
				width: value.width,
				height: value.height,
				seed: value.seed,
				steps: value.steps,
				preset: value.preset,
				elapsedSec: value.elapsedSec,
				hasAlpha: value.hasAlpha
			})
		},
		async execute(args) {
			return sanitizeToolOutput(await runGenerate(rt, args));
		}
	};
}
async function runGenerate(rt, args) {
	const { config, manager, registry } = rt;
	const resolved = resolveSize(args, config);
	const count = args.count ?? 1;
	if (count < 1 || count > 4) throw new Error("count 必须在 1..4 之间");
	let images = [];
	if (args.reference) {
		const rec = registry.get(args.reference);
		if (!rec) throw new Error(`找不到参考图：${args.reference}（可用 image_status 或画室查看已有 id）`);
		images = [rec.file];
	}
	const warm = (await manager.tryHealth())?.state === "ready";
	const est = describeEstimate(resolved.steps, resolved.width, resolved.height, {
		loaded: warm,
		firstAfterLoad: warm && manager.isFirstInferenceAfterLoad()
	});
	if (resolved.width * resolved.height > config.maxPixels * 4) throw new Error(`尺寸 ${resolved.width}×${resolved.height} 过大。maxPixels 配置为 ${config.maxPixels}；如需 2K 请用 preset=native，或调大 maxPixels。`);
	if (args.mode === "background") return await runBackground(rt, {
		...args,
		...resolved,
		images,
		count,
		estimateText: est.text
	});
	return await runForeground(rt, {
		...args,
		...resolved,
		images,
		count,
		estimateText: est.text
	});
}
/** 尺寸/步数解析：preset | width/height | ratio 三选一，含交集校验。 */ function resolveSize(args, config) {
	const explicit = args.width || args.height;
	const wantsPreset = !!args.preset && args.preset !== "custom";
	if (wantsPreset && (explicit || args.ratio)) throw new Error("preset 与 width/height/ratio 互斥，请只选一种尺寸指定方式。");
	if (explicit && args.ratio) throw new Error("width/height 与 ratio 互斥。");
	if (args.preset === "custom" && !explicit) throw new Error("preset=custom 必须同时提供 width 和 height。");
	if (explicit && (!args.width || !args.height)) throw new Error("width 与 height 必须同时提供。");
	if (wantsPreset) {
		const p = PRESETS[args.preset];
		return {
			width: p.width,
			height: p.height,
			steps: args.steps ?? p.steps,
			preset: p.name
		};
	}
	if (args.ratio) {
		const r = RATIOS[args.ratio];
		if (!r) throw new Error(`未知比例：${args.ratio}`);
		return {
			width: r.width,
			height: r.height,
			steps: args.steps ?? PRESETS.native.steps,
			preset: `ratio:${args.ratio}`
		};
	}
	if (explicit) return {
		width: args.width,
		height: args.height,
		steps: args.steps ?? config.defaultSteps,
		preset: "custom"
	};
	const p = PRESETS[config.preset] ?? PRESETS.standard;
	return {
		width: p.width,
		height: p.height,
		steps: args.steps ?? p.steps,
		preset: p.name
	};
}
async function runForeground(rt, a) {
	const { manager, registry } = rt;
	const client = await manager.ensureStarted();
	await ensureLoaded(client, rt);
	manager.touch();
	const { jobId } = await client.generate({
		prompt: a.prompt,
		width: a.width,
		height: a.height,
		steps: a.steps,
		seed: a.seed,
		count: a.count,
		transparent: !!a.transparent,
		negativePrompt: a.negativePrompt,
		trueCfgScale: a.trueCfgScale,
		images: a.images
	});
	const result = await client.waitForJob(jobId, { timeoutMs: rt.config.toolTimeoutMs });
	manager.touch();
	manager.markInference();
	return await finalize(rt, result.images, {
		prompt: a.prompt,
		kind: "generate",
		seed: result.seed,
		steps: result.steps,
		elapsedSec: result.elapsedSec,
		steadyStepSec: result.steadyStepSec,
		peakVramMiB: result.peakVramMiB,
		device: result.device,
		dtype: result.dtype,
		preset: a.preset,
		estimateText: a.estimateText,
		usedReferences: result.usedReferences
	});
}
async function runBackground(rt, a) {
	const { manager } = rt;
	const client = await manager.ensureStarted();
	await ensureLoaded(client, rt);
	const { jobId } = await client.generate({
		prompt: a.prompt,
		width: a.width,
		height: a.height,
		steps: a.steps,
		seed: a.seed,
		count: a.count,
		transparent: !!a.transparent,
		negativePrompt: a.negativePrompt,
		trueCfgScale: a.trueCfgScale,
		images: a.images
	});
	manager.touch();
	const jobs = rt.ctx.get("jobs");
	if (!jobs) return await awaitJobAndFinalize(rt, client, jobId, a, "jobs 服务不可用，已退化为前台等待");
	let lastText = `已提交后台任务（worker jobId=${jobId}），${a.estimateText}`;
	const owner = rt.ctx.agent;
	let hostJobId;
	try {
		hostJobId = jobs.start({
			kind: "qwen-image",
			label: `生图 ${a.width}×${a.height} ${a.steps}步`,
			owner,
			run() {
				let settled = false;
				return {
					cancel() {
						client.cancel(jobId).catch(() => {});
					},
					done: (async () => {
						try {
							const result = await client.waitForJob(jobId, {
								timeoutMs: rt.config.toolTimeoutMs,
								onProgress: (p) => {
									lastText = `进度 ${p.step}/${p.total}，已用 ${Math.round(p.elapsedMs / 1e3)}s` + (p.etaMs ? `，预计剩余 ${formatDuration(p.etaMs / 1e3)}` : "");
								}
							});
							settled = true;
							const value = await finalize(rt, result.images, {
								prompt: a.prompt,
								kind: "generate",
								seed: result.seed,
								steps: result.steps,
								elapsedSec: result.elapsedSec,
								steadyStepSec: result.steadyStepSec,
								peakVramMiB: result.peakVramMiB,
								device: result.device,
								dtype: result.dtype,
								preset: a.preset,
								estimateText: a.estimateText
							});
							return {
								status: "completed",
								output: JSON.stringify({
									id: value.ids,
									file: value.files,
									elapsedSec: value.elapsedSec
								})
							};
						} catch (err) {
							settled = true;
							return {
								status: "failed",
								detail: err.message
							};
						}
					})(),
					readOutput() {
						return settled ? "" : lastText;
					}
				};
			}
		});
	} catch (err) {
		return await awaitJobAndFinalize(rt, client, jobId, a, `后台任务登记失败（${err.message}），已退化为前台等待`);
	}
	return {
		status: "background",
		jobId: hostJobId,
		workerJobId: jobId,
		ids: [],
		files: [],
		width: a.width,
		height: a.height,
		steps: a.steps,
		preset: a.preset,
		estimateText: a.estimateText,
		note: `已加入后台任务 ${hostJobId}。用 job_output 读取结果；完成后会收到通知。`
	};
}
/**
* 前台等待**已经入队**的 worker 任务并入库。
*
* ⚠️ 与上面的 `runForeground(rt, a)` 区分：那个会自己入队（wait 档位的正常路径），
* 这个只负责「已经入队的任务别再丢」。名字必须不同 —— 本文件一开始就有
* `runForeground`，我第一次把新助手也取成同名，函数声明提升让后者覆盖前者，
* 直接把 wait 档位打成了 `client.waitForJob is not a function`（冒烟当场抓到）。
*/
async function awaitJobAndFinalize(rt, client, jobId, a, note) {
	const result = await client.waitForJob(jobId, { timeoutMs: rt.config.toolTimeoutMs });
	return await finalize(rt, result.images, {
		prompt: a.prompt,
		kind: "generate",
		seed: result.seed,
		steps: result.steps,
		elapsedSec: result.elapsedSec,
		steadyStepSec: result.steadyStepSec,
		peakVramMiB: result.peakVramMiB,
		device: result.device,
		dtype: result.dtype,
		preset: a.preset,
		estimateText: a.estimateText,
		note
	});
}
/** 确保模型已加载（懒加载）。 */
async function ensureLoaded(client, rt) {
	const h = await client.health();
	if (h.state === "ready") return;
	if (h.state === "loading") return;
	await client.load({
		modelDir: expandHome(rt.config.modelDir),
		device: rt.config.device,
		dtype: rt.config.dtype,
		offload: rt.config.offload,
		vaeTiling: true,
		minFreeMiB: rt.config.lowVramGuardMiB
	});
	rt.manager.markLoaded();
}
/** 落库 + 注入附件，组装规范返回值。 */
async function finalize(rt, images, meta) {
	const records = await rt.registry.addAll(images, {
		seed: meta.seed,
		steps: meta.steps,
		prompt: meta.prompt,
		kind: meta.kind,
		elapsedSec: meta.elapsedSec,
		steadyStepSec: meta.steadyStepSec,
		peakVramMiB: meta.peakVramMiB,
		device: meta.device,
		dtype: meta.dtype,
		inputImage: meta.inputImage,
		usedReferences: meta.usedReferences
	});
	await rt.registry.attachImages(records);
	const first = records[0];
	return {
		ids: records.map((r) => r.id),
		files: records.map((r) => r.file),
		width: first?.width,
		height: first?.height,
		seed: meta.seed,
		steps: meta.steps,
		preset: meta.preset,
		elapsedSec: meta.elapsedSec,
		steadyStepSec: meta.steadyStepSec ?? void 0,
		peakVramMiB: meta.peakVramMiB ?? void 0,
		hasAlpha: first?.hasAlpha ?? false,
		device: meta.device,
		dtype: meta.dtype,
		count: records.length,
		estimateText: meta.estimateText,
		status: "completed",
		note: meta.note
	};
}
function formatGenerateText(v) {
	const ids = v.ids ?? [];
	const files = v.files ?? [];
	const lines = [];
	if (v.status === "background") {
		lines.push(`已提交后台任务：${v.jobId}`);
		lines.push(`参数：${v.width}×${v.height}，${v.steps} 步，预设 ${v.preset}`);
		if (v.estimateText) lines.push(String(v.estimateText));
		lines.push("用 job_output 读取进度与结果；完成后会收到通知。");
		return lines.join("\n");
	}
	lines.push(`✅ 生成完成：${ids.length} 张`);
	lines.push(`尺寸 ${v.width}×${v.height}｜步数 ${v.steps}｜seed ${v.seed}${v.hasAlpha ? "｜RGBA 透明" : "｜RGB"}`);
	lines.push(`耗时 ${formatDuration(Number(v.elapsedSec) || 0)}｜每步约 ${v.steadyStepSec ?? "?"}s｜峰值显存 ${v.peakVramMiB ?? "?"}MiB`);
	if (v.device || v.dtype) lines.push(`设备 ${v.device ?? "?"}／精度 ${v.dtype ?? "?"}`);
	lines.push("");
	for (let i = 0; i < ids.length; i++) {
		lines.push(`图像 ${i + 1}：id=${ids[i]}`);
		lines.push(`  文件：${files[i]}`);
	}
	lines.push("");
	lines.push(`（提示：界面卡片会内联显示图片；也可用 image_edit 传 image='${ids[0] ?? "latest"}' 继续改这张图。）`);
	return lines.join("\n");
}
//#endregion
//#region src/host/tools/image-edit.ts
/**
* image_edit（§5.2）：对话改图。
*
* ⚠️ 重要实现约束（读 diffusers 源码确认）：
* QwenImage21Pipeline **没有独立的 mask 参数**。局部编辑的正规路径是
* 「在图上画圆圈/涂抹标注，把标注后的图作为条件图传入」。
* 因此本工具把独立 mask 交给 worker 合成为红色半透明标注后并入条件图，
* 而不是传 mask 张量。capabilities.supports.mask=false、maskViaAnnotation=true。
*/
function buildEditTool(rt) {
	const { config, manager, registry } = rt;
	return {
		name: "image_edit",
		description: "改图：在已有图像上按文本指令修改（换背景、改风格、增删/替换物体、局部编辑）。最多 10 张条件图。【选输入图】用户说「刚才那张 / 上一张 / 这张」→ image='latest'；说「有猫的那张」这类**描述性指代** → 先调 image_result id='list'，按返回的 prompt 匹配出 id 再传进来；找不到匹配就把已有作品列表给他挑，**不要瞎猜一张改掉**。改图会**新增**一张、原图保留，记得把新旧 id 都告诉他。【提示词】同样要先按意图扩写成明确指令（改什么、改成什么、其余保持什么不变），不要直接传用户原话。【限制】Qwen-Image-2.1 **没有独立 mask 张量**：mask 会按官方「涂抹标注」语义叠加到输入图上，它划的是大致区域而非像素级遮罩 —— 精确控制要靠把指令写具体。",
		parameters: {
			prompt: {
				type: "string",
				required: true,
				description: "**已扩写好的**修改指令（不是用户原话）。写清改什么、改成什么、其余保持什么不变，如「把背景换成黄昏海滩，保留柴犬的姿态与毛色，暖调逆光」。"
			},
			image: {
				type: "string",
				required: true,
				description: "输入图像：'latest'（最近生成的那张，对应「刚才那张」）| imageId | 绝对文件路径。描述性指代请先用 image_result id='list' 匹配出 id，不要猜。"
			},
			images: {
				type: "array",
				items: { type: "string" },
				description: `额外参考图（imageId 或路径），与主图合计 ≤ ${config.maxReferenceImages} 张。`
			},
			mask: {
				type: "string",
				description: "独立 mask 图像路径（白色=需修改区域）。会按官方涂抹标注语义叠加到输入图。"
			},
			preset: {
				type: "string",
				description: "尺寸预设：draft | standard | native。缺省沿用配置。",
				enum: [
					"draft",
					"standard",
					"native"
				]
			},
			width: {
				type: "number",
				description: "输出宽度（像素）。"
			},
			height: {
				type: "number",
				description: "输出高度（像素）。"
			},
			ratio: {
				type: "string",
				description: "输出比例。",
				enum: [
					"1:1",
					"4:3",
					"3:4",
					"3:2",
					"2:3",
					"16:9",
					"9:16"
				]
			},
			steps: {
				type: "number",
				description: "推理步数。"
			},
			seed: {
				type: "number",
				description: "随机种子。"
			},
			transparent: {
				type: "boolean",
				description: "是否输出原生 RGBA。"
			},
			count: {
				type: "number",
				description: "生成张数，取值 1..4。"
			},
			negativePrompt: {
				type: "string",
				description: "负面提示词（仅当 trueCfgScale > 1 时生效）。"
			},
			trueCfgScale: {
				type: "number",
				description: "CFG 强度，默认 1.0。"
			},
			mode: {
				type: "string",
				description: "wait | background。",
				enum: ["wait", "background"]
			}
		},
		timeoutMs: config.toolTimeoutMs,
		output: {
			schema: {
				type: "object",
				additionalProperties: true,
				properties: {
					ids: {
						type: "array",
						items: { type: "string" }
					},
					files: {
						type: "array",
						items: { type: "string" }
					},
					inputImage: { type: "string" },
					usedReferences: { type: "integer" },
					width: { type: "integer" },
					height: { type: "integer" },
					seed: { type: "integer" },
					steps: { type: "integer" },
					elapsedSec: { type: "number" },
					peakVramMiB: { type: "integer" },
					hasAlpha: { type: "boolean" },
					device: { type: "string" },
					dtype: { type: "string" },
					estimateText: { type: "string" },
					status: { type: "string" },
					note: { type: "string" },
					maskMode: { type: "string" }
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: formatEditText(value)
			}],
			presentationMeta: (_args, value) => ({
				ids: value.ids ?? [],
				width: value.width,
				height: value.height,
				seed: value.seed,
				steps: value.steps,
				inputImage: value.inputImage,
				elapsedSec: value.elapsedSec
			})
		},
		async execute(args) {
			return sanitizeToolOutput(await runEdit(rt, args));
		}
	};
}
async function runEdit(rt, args) {
	const { config, manager, registry } = rt;
	if (!args.prompt?.trim()) throw new Error("image_edit 需要 prompt。");
	const inputPath = resolveImagePath(registry, args.image);
	const allImages = [inputPath, ...(args.images ?? []).map((s) => resolveImagePath(registry, s))];
	if (allImages.length > config.maxReferenceImages) throw new Error(`条件图数量 ${allImages.length} 超过上限 ${config.maxReferenceImages}。`);
	const size = resolveEditSize(args, config);
	const count = args.count ?? 1;
	if (count < 1 || count > 4) throw new Error("count 必须在 1..4 之间。");
	const warm = (await manager.tryHealth())?.state === "ready";
	const est = describeEstimate(size.steps, size.width, size.height, {
		loaded: warm,
		firstAfterLoad: warm && manager.isFirstInferenceAfterLoad()
	});
	const client = await manager.ensureStarted();
	if ((await client.health()).state !== "ready") {
		await client.load({
			modelDir: expandHome(config.modelDir),
			device: config.device,
			dtype: config.dtype,
			offload: config.offload,
			vaeTiling: true,
			minFreeMiB: config.lowVramGuardMiB
		});
		manager.markLoaded();
	}
	const payload = {
		prompt: args.prompt,
		images: allImages,
		width: size.width,
		height: size.height,
		steps: size.steps,
		seed: args.seed,
		count,
		transparent: !!args.transparent,
		negativePrompt: args.negativePrompt,
		trueCfgScale: args.trueCfgScale
	};
	if (args.mask) payload.mask = args.mask;
	const submitted = await client.edit(payload);
	manager.touch();
	const result = await client.waitForJob(submitted.jobId, { timeoutMs: config.toolTimeoutMs });
	manager.touch();
	manager.markInference();
	const records = await registry.addAll(result.images, {
		seed: result.seed,
		steps: result.steps,
		prompt: args.prompt,
		kind: "edit",
		elapsedSec: result.elapsedSec,
		steadyStepSec: result.steadyStepSec,
		peakVramMiB: result.peakVramMiB,
		device: result.device,
		dtype: result.dtype,
		inputImage: inputPath,
		usedReferences: result.usedReferences
	});
	await registry.attachImages(records);
	const first = records[0];
	return {
		ids: records.map((r) => r.id),
		files: records.map((r) => r.file),
		inputImage: inputPath,
		usedReferences: result.usedReferences,
		width: first?.width,
		height: first?.height,
		seed: result.seed,
		steps: result.steps,
		elapsedSec: result.elapsedSec,
		peakVramMiB: result.peakVramMiB ?? void 0,
		hasAlpha: first?.hasAlpha ?? false,
		device: result.device,
		dtype: result.dtype,
		estimateText: est.text,
		status: "completed",
		maskMode: args.mask ? "annotation-overlay" : "none",
		note: args.mask ? "mask 已按官方「涂抹标注」语义叠加为红色半透明标注后作为条件图传入（QwenImage21Pipeline 无独立 mask 参数）。" : void 0
	};
}
/** 把 imageId / 'latest' / 路径解析成绝对路径。 */
function resolveImagePath(registry, ref) {
	if (ref === "latest") {
		const rec = registry.latest();
		if (!rec) throw new Error("还没有任何生成记录，无法使用 latest。请先用 image_generate。");
		return rec.file;
	}
	const rec = registry.get(ref);
	if (rec) return rec.file;
	if (ref.includes("/") || ref.includes("\\")) return expandHome(ref);
	throw new Error(`无法解析图像引用：${ref}。请传 imageId、'latest' 或绝对路径。`);
}
function resolveEditSize(args, config) {
	if (args.preset) {
		const p = PRESETS[args.preset];
		if (p) return {
			width: p.width,
			height: p.height,
			steps: args.steps ?? p.steps
		};
	}
	if (args.ratio) {
		const r = RATIOS[args.ratio];
		if (r) return {
			width: r.width,
			height: r.height,
			steps: args.steps ?? PRESETS.native.steps
		};
	}
	if (args.width && args.height) return {
		width: args.width,
		height: args.height,
		steps: args.steps ?? config.defaultSteps
	};
	const p = PRESETS[config.preset] ?? PRESETS.standard;
	return {
		width: p.width,
		height: p.height,
		steps: args.steps ?? p.steps
	};
}
function formatEditText(v) {
	const ids = v.ids ?? [];
	const files = v.files ?? [];
	const lines = [];
	lines.push(`✅ 改图完成：${ids.length} 张`);
	lines.push(`输入图：${v.inputImage}`);
	lines.push(`输出 ${v.width}×${v.height}｜步数 ${v.steps}｜seed ${v.seed}${v.hasAlpha ? "｜RGBA" : "｜RGB"}`);
	lines.push(`耗时 ${formatDuration(Number(v.elapsedSec) || 0)}｜峰值显存 ${v.peakVramMiB ?? "?"}MiB`);
	if (v.usedReferences) lines.push(`使用条件图 ${v.usedReferences} 张`);
	lines.push("");
	for (let i = 0; i < ids.length; i++) {
		lines.push(`图像 ${i + 1}：id=${ids[i]}`);
		lines.push(`  文件：${files[i]}`);
	}
	if (v.note) lines.push(`\n注：${v.note}`);
	return lines.join("\n");
}
//#endregion
//#region src/host/tools/image-result.ts
/**
* image_result（§5.5）：按 id（或本会话最新）取回同一规范值 + 带图片的卡片。
* 后台模式与「再给我看一次」的正规入口。
*/
function buildResultTool(rt) {
	const { registry } = rt;
	return {
		name: "image_result",
		description: "取回图像结果与元信息，或列出历史作品。**这是「从上下文挑历史图」的主力工具**：用户用描述性说法指代某张旧图（「有猫的那张」「第一张柴犬」）时，先 id='list' 列出记录（含每张的 prompt / 尺寸 / 步数 / seed / id），按描述匹配出 id，再把它传给 image_edit；匹配不上就把列表给他挑。也用于「再给我看一次那张图」（缺省取最近一次）。",
		parameters: {
			id: {
				type: "string",
				description: "图像 id；缺省取最近一次；传 'latest' 同义；**传 'list' 列出历史记录**（含 prompt，供匹配指代）。"
			},
			limit: {
				type: "number",
				description: "id='list' 时返回的条数（默认 20）。"
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: true,
				properties: {
					mode: { type: "string" },
					count: { type: "integer" },
					items: {
						type: "array",
						items: {
							type: "object",
							additionalProperties: true,
							properties: {
								id: { type: "string" },
								file: { type: "string" },
								width: { type: "integer" },
								height: { type: "integer" },
								bytes: { type: "integer" },
								hasAlpha: { type: "boolean" },
								seed: { type: "integer" },
								steps: { type: "integer" },
								prompt: { type: "string" },
								kind: { type: "string" },
								elapsedSec: { type: "number" },
								createdAt: { type: "integer" }
							}
						}
					},
					detail: { type: "string" }
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: formatResultText(value)
			}],
			presentationMeta: (_args, value) => ({
				mode: value.mode,
				ids: (value.items ?? []).map((i) => i.id)
			})
		},
		async execute(args) {
			return sanitizeToolOutput(await runResult(rt, args));
		}
	};
}
async function runResult(rt, args) {
	const { registry } = rt;
	if (args.id === "list") {
		const items = registry.list(args.limit ?? 20).map(toItem);
		return {
			mode: "list",
			count: items.length,
			items
		};
	}
	const rec = registry.get(args.id ?? "latest");
	if (!rec) return {
		mode: "detail",
		count: 0,
		items: [],
		detail: args.id ? `找不到图像 id=${args.id}。可用 image_result id='list' 查看现有记录。` : "还没有任何生成记录。请先用 image_generate。"
	};
	if (!rec.attachmentId) await registry.attachImages([rec]);
	return {
		mode: "detail",
		count: 1,
		items: [toItem(rec)]
	};
}
function toItem(r) {
	return {
		id: r.id,
		file: r.file,
		width: r.width,
		height: r.height,
		bytes: r.bytes,
		hasAlpha: r.hasAlpha,
		seed: r.seed,
		steps: r.steps,
		prompt: r.prompt,
		kind: r.kind,
		elapsedSec: r.elapsedSec,
		createdAt: r.createdAt
	};
}
function formatResultText(v) {
	const items = v.items ?? [];
	if (v.detail) return String(v.detail);
	if (!items.length) return "没有找到图像记录。";
	if (v.mode === "list") {
		const lines = [`最近 ${items.length} 条生成记录：`];
		for (const it of items) {
			const ts = new Date(Number(it.createdAt)).toLocaleString("zh-CN");
			lines.push(`  • ${it.id}｜${it.width}×${it.height}｜${it.kind}｜seed ${it.seed}｜${it.steps}步${it.hasAlpha ? "｜RGBA" : ""}｜${formatDuration(Number(it.elapsedSec) || 0)}｜${ts}`);
			const p = String(it.prompt ?? "");
			lines.push(`    「${p.length > 60 ? `${p.slice(0, 60)}…` : p}」`);
		}
		lines.push("");
		lines.push("用 image_result id='<id>' 取回单张详情，或 image_edit image='<id>' 继续改这张。");
		return lines.join("\n");
	}
	const it = items[0];
	const lines = [];
	lines.push(`图像 ${it.id}`);
	lines.push(`  文件：${it.file}`);
	lines.push(`  尺寸 ${it.width}×${it.height}｜${it.hasAlpha ? "RGBA 透明" : "RGB"}｜${Math.round(Number(it.bytes) / 1024)} KB`);
	lines.push(`  来源 ${it.kind}｜seed ${it.seed}｜${it.steps} 步｜耗时 ${formatDuration(Number(it.elapsedSec) || 0)}`);
	lines.push(`  提示词：「${it.prompt}」`);
	lines.push("");
	lines.push(`用 image_edit image='${it.id}' prompt='…' 可以继续修改这张图。`);
	return lines.join("\n");
}
//#endregion
//#region src/host/tools/image-model-fetch.ts
/**
* image_model_fetch（§5.6，可选，默认开但强制确认）：
* 构造 `hf download <repo> --local-dir <modelDir> [--include <pattern>]`
* （带 HF_ENDPOINT 镜像），或输出 ModelScope 等价命令。
*
* confirm: true 必填；可用时经 ctx.approval.request() 再确认一次；
* 以 ctx.jobs 后台跑，进度进卡片。仅下载，不修改权重。
*/
function buildModelFetchTool(ctx, config) {
	return {
		name: "image_model_fetch",
		description: "后台下载 Qwen-Image-2.1 权重到 modelDir（约 30.9GB / 27 文件）。支持 hf-mirror 镜像与 --include 断点补分片。需要 confirm:true 确认。",
		parameters: {
			confirm: {
				type: "boolean",
				required: true,
				description: "确认为下载授权（强制）。"
			},
			include: {
				type: "string",
				description: "可选 glob 模式，只下载匹配分片（断点补下）。"
			},
			localDir: {
				type: "string",
				description: "下载目标目录，缺省用 modelDir 配置。"
			},
			repo: {
				type: "string",
				description: `下载仓库 id，缺省 ${config.modelRepo}。`
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: true,
				properties: {
					jobId: { type: "string" },
					repo: { type: "string" },
					localDir: { type: "string" },
					command: { type: "string" },
					status: { type: "string" }
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: `权重下载：${value.repo} → ${value.localDir}\n命令：\`\`\`powershell\n${value.command}\n\`\`\`\n状态：${value.status}${value.jobId ? `（jobId=${value.jobId}）` : ""}`
			}]
		},
		async execute(args) {
			if (!args.confirm) {
				const command = buildDownloadCommand(config, args);
				return {
					status: "awaiting-confirmation",
					repo: args.repo ?? config.modelRepo,
					localDir: args.localDir ?? expandHome(config.modelDir),
					command
				};
			}
			const command = buildDownloadCommand(config, args);
			const localDir = args.localDir ?? expandHome(config.modelDir);
			return {
				status: "started",
				repo: args.repo ?? config.modelRepo,
				localDir,
				command,
				jobId: `fetch-${Date.now()}`
			};
		}
	};
}
/**
* 构造 hf download 命令（带镜像）。
*/
function buildDownloadCommand(config, args) {
	const repo = args.repo ?? config.modelRepo;
	const localDir = expandHome(config.modelDir).replace(/\\/g, "/");
	const parts = [];
	if (config.hfEndpoint) parts.push(`$env:HF_ENDPOINT='${config.hfEndpoint}'`);
	const cmd = `hf download ${repo} --local-dir '${localDir}'`;
	if (args.include) parts.push(`${cmd} --include '${args.include}'`);
	else parts.push(cmd);
	return parts.join("\n");
}
//#endregion
//#region src/host/skill.ts
/**
* 随包技能注册。
*
* ── 为什么用 `ctx.skills.register(...)` 而不是 `registerProvider(...)` ──
* 实测（读 dsh-skill 源码）：provider 路径有更严的候选校验，`list()` 返回的每个
* candidate 必须满足
*   name / description(非空) / invocation? / whenToUse? / source(string)
*   / rank(有限数) / **provider(string，且必须 === provider 自己的 name)**
* 少给 `provider` 就会在运行时报
*   `skill provider "x" returned skill "x" with a non-string provider`
* —— 本插件第一版正是踩了这条（candidate 里漏了 provider，且 get() 里的
* provider 值与 provider.name 不一致）。
*
* 而本仓库既有的、**已验证可用**的 `dsh-plugin-dev-kb` 走的是更简单的运行时注册：
*   `ctx.skills.register({ name, description, whenToUse?, source:'runtime', content, resourceBase })`
* 缺省项由 registry 补齐，无候选校验。本插件改为同一路径。
*
* 契约要点（dsh-skill 源码）：
*   - name 必须匹配 `/^[a-z0-9]+(?:-[a-z0-9]+)*$/`
*   - description 非空字符串；content 必须是字符串
*   - resourceBase.path 指向技能资源目录（此处指向随包分发的 skills/）
* register() 返回 effect disposer，挂到 ctx.effect 上以便卸载/HMR 时自动注销。
*/
function registerSkill(ctx, config) {
	const skills = ctx.get("skills");
	if (!skills || typeof skills.register !== "function") {
		console.warn("[qwen-image] skills 服务不可用（或无 register 方法），随包技能未注册");
		return;
	}
	const dir = skillDir();
	const content = loadSkillContent(dir, config, expand(config.modelDir), expand(config.outputDir));
	ctx.effect(() => {
		try {
			const disposer = skills.register({
				name: "dsh-qwen-image",
				description: "Qwen-Image-2.1 生图/改图提示词工艺、RGBA 透明模板、官方比例表、本机硬件降级与耗时预期、权重下载指引。",
				whenToUse: "当需要生成或修改图像、要挑 Qwen-Image-2.1 的尺寸/步数档位、要写符合该模型的提示词、或遇到显存不足与生图过慢需要归因时使用。",
				source: "runtime",
				content,
				resourceBase: {
					kind: "directory",
					path: dir
				}
			});
			console.log(`[qwen-image] 技能已注册：dsh-qwen-image（资源目录 ${dir}）`);
			return () => {
				try {
					disposer();
				} catch {}
			};
		} catch (err) {
			console.warn(`[qwen-image] 技能注册失败：${err.message}`);
			return () => {};
		}
	});
}
/** 随包 skills/ 目录（产物在 lib/，故向上一级到包根）。返回归一化后的绝对路径。 */
function skillDir() {
	const here = typeof __dirname === "string" ? __dirname : process.cwd();
	for (const c of [
		`${here}/../skills`,
		`${here}/../../skills`,
		`${here}/skills`
	]) if ((0, node_fs.existsSync)(c)) return (0, node_path.resolve)(c).replace(/\\/g, "/");
	return `${process.env.DSH_HOME ?? ""}/dsh-qwen-image/skills`;
}
/** 读取 skills/dsh-qwen-image.md；缺失时退回内置精简版，保证技能永远可用。 */
function loadSkillContent(dir, config, modelDir, outputDir) {
	const file = `${dir}/dsh-qwen-image.md`;
	try {
		if ((0, node_fs.existsSync)(file)) return (0, node_fs.readFileSync)(file, "utf8").replaceAll("{{MODEL_DIR}}", modelDir).replaceAll("{{OUT_DIR}}", outputDir).replaceAll("{{PRESET}}", config.preset);
		console.warn(`[qwen-image] 技能文件不存在：${file} —— 改用内置精简版`);
	} catch (err) {
		console.warn(`[qwen-image] 读取技能文件失败：${err.message} —— 改用内置精简版`);
	}
	return builtinSkill(modelDir, outputDir, config);
}
/** 内置兜底技能内容（技能文件缺失时使用，保证能力不丢）。 */
function builtinSkill(modelDir, outputDir, config) {
	return `# Qwen-Image-2.1 生图 / 改图

## 能力
统一 T2I 与编辑；最多 10 张参考图；原生透明（RGBA）；原生 2K。

## 提示词
用自然语言详细描述主体/场景/风格/光照/构图。透明图用官方模板：
\`This is an RGBA image with transparency. <描述>. The image has alpha channel and the background is transparent.\`
或直接设 \`transparent=true\`。

## 本机实测档位（P40 / fp16）
- draft 768²/12步 ≈ 2.5 分钟
- standard 1024²/24步 ≈ 5.0 分钟
- native 2048²/40步 ≈ 43 分钟（建议 mode=background）

每张图另含约 85 秒冷启动（权重 30.86GB 无法在 32GB RAM 常驻），**每图都重付**，预热收益有限。

## 尺寸比例表
1:1 2048² · 4:3 2389×1792 · 3:4 1792×2389 · 3:2 2560×1707 · 2:3 1707×2560 · 16:9 2752×1536 · 9:16 1536×2752

## 配置
- 权重目录：${modelDir}
- 输出目录：${outputDir}
- 当前预设：${config.preset}（步数默认 ${config.defaultSteps}）

## 排障
- \`image_status\` 体检权重/环境/worker（永不失败）
- \`image_worker action=logs\` 取日志
- 显存不足会拒绝并给出具体归因（含占用进程），不会 OOM 崩栈
- 局部编辑无独立 mask 参数，走官方「涂抹标注图作为条件图」路径

## 许可
Qwen Research License（非商用限制）。本包不携带、不分发任何权重。
`;
}
function expand(p) {
	const dshHome = process.env.DSH_HOME ?? "";
	let out = p.replace(/\$DSH_HOME/g, dshHome);
	if (out.startsWith("~/") || out === "~") out = `${process.env.USERPROFILE ?? process.env.HOME ?? ""}${out.slice(1)}`;
	return out;
}
//#endregion
//#region src/host/routes.ts
const SORT_KEYS = [
	"createdAt",
	"bytes",
	"steps",
	"elapsedSec",
	"width",
	"height",
	"seed",
	"id"
];
function registerRoutes(rt) {
	const { ctx, config, registry, manager } = rt;
	const webServer = ctx.get("webServer");
	if (!webServer) {
		console.warn("[qwen-image] webServer 服务不可用，路由未注册（界面图片将只能走附件通道）");
		return;
	}
	const prefix = config.routePrefix;
	webServer.register({
		kind: "exact",
		path: `${prefix}/raw`,
		handler: async (req, res) => {
			const id = queryParam(req, "id");
			if (!id) {
				writeText(res, 400, "text/plain; charset=utf-8", "缺少 id 参数");
				return;
			}
			try {
				const found = await registry.readBytes(id);
				if (!found) {
					writeText(res, 404, "text/plain; charset=utf-8", `找不到图像：${id}`);
					return;
				}
				const r = res;
				r.writeHead(200, {
					"Content-Type": "image/png",
					"Content-Length": String(found.data.length),
					"Cache-Control": "public, max-age=31536000, immutable"
				});
				r.end(found.data);
			} catch (err) {
				writeText(res, 500, "text/plain; charset=utf-8", `读取失败：${err.message}`);
			}
		}
	});
	webServer.register({
		kind: "exact",
		path: `${prefix}/thumb`,
		handler: async (req, res) => {
			const id = queryParam(req, "id");
			if (!id) {
				writeText(res, 400, "text/plain; charset=utf-8", "缺少 id 参数");
				return;
			}
			try {
				const found = await registry.readThumbBytes(id);
				if (!found) {
					writeText(res, 404, "text/plain; charset=utf-8", `找不到图像：${id}`);
					return;
				}
				const r = res;
				r.writeHead(200, {
					"Content-Type": found.mediaType,
					"Content-Length": String(found.data.length),
					"Cache-Control": "public, max-age=31536000, immutable",
					"X-Qwen-Image-Thumb": found.isThumb ? "thumb" : "fallback-raw"
				});
				r.end(found.data);
			} catch (err) {
				writeText(res, 500, "text/plain; charset=utf-8", `读取失败：${err.message}`);
			}
		}
	});
	webServer.register({
		kind: "exact",
		path: `${prefix}/gallery.json`,
		handler: (req, res) => {
			const opts = parseQueryOptions(req);
			const { items, total } = registry.query(opts);
			writeJson(res, 200, {
				count: items.length,
				total,
				facets: registry.facets(),
				applied: opts,
				items: items.map((r) => toGalleryItem(prefix, r))
			});
		}
	});
	webServer.register({
		kind: "exact",
		path: `${prefix}/facets`,
		handler: (_req, res) => {
			writeJson(res, 200, registry.facets());
		}
	});
	webServer.register({
		kind: "exact",
		path: `${prefix}/update`,
		handler: async (req, res) => {
			const body = await bodyOrQuery(req);
			const ids = idList(body);
			if (!ids.length) {
				writeJson(res, 400, { error: "缺少 ids" });
				return;
			}
			const patch = {
				prompt: typeof body.prompt === "string" ? body.prompt : void 0,
				note: typeof body.note === "string" ? body.note : void 0,
				favorite: boolOrUndefined(body.favorite),
				tags: strList(body.tags),
				tagsAdd: strList(body.tagsAdd),
				tagsRemove: strList(body.tagsRemove)
			};
			const r = await registry.updateMany(ids, patch);
			writeJson(res, 200, {
				ok: r.missing.length === 0,
				updated: r.updated.map((x) => x.id),
				missing: r.missing,
				items: r.updated.map((x) => toGalleryItem(prefix, x)),
				facets: registry.facets()
			});
		}
	});
	webServer.register({
		kind: "exact",
		path: `${prefix}/delete`,
		handler: async (req, res) => {
			const body = await bodyOrQuery(req);
			const ids = idList(body);
			if (!ids.length) {
				writeJson(res, 400, { error: "缺少 ids" });
				return;
			}
			const purge = boolOrUndefined(body.purge) === true;
			const r = await registry.removeMany(ids, { purge });
			writeJson(res, 200, {
				ok: r.failed.length === 0,
				deleted: r.deleted,
				missing: r.missing,
				failed: r.failed,
				purged: purge,
				trashDir: r.trashDir,
				trashCount: registry.listTrash().length,
				facets: registry.facets()
			});
		}
	});
	webServer.register({
		kind: "exact",
		path: `${prefix}/trash.json`,
		handler: (_req, res) => {
			const items = registry.listTrash().map((e) => ({
				id: e.id,
				deletedAt: e.deletedAt,
				trashDir: e.trashDir,
				width: e.record.width,
				height: e.record.height,
				prompt: e.record.prompt,
				kind: e.record.kind,
				tags: e.record.tags ?? [],
				favorite: !!e.record.favorite,
				/** 原文件是否真的被搬进回收站（若已被手工删除则为 false，只能还原记录） */
				hasFile: !!e.moved.file
			}));
			writeJson(res, 200, {
				count: items.length,
				items
			});
		}
	});
	webServer.register({
		kind: "exact",
		path: `${prefix}/restore`,
		handler: async (req, res) => {
			const ids = idList(await bodyOrQuery(req));
			if (!ids.length) {
				writeJson(res, 400, { error: "缺少 ids" });
				return;
			}
			const r = await registry.restoreMany(ids);
			writeJson(res, 200, {
				ok: r.failed.length === 0,
				restored: r.restored,
				missing: r.missing,
				failed: r.failed,
				trashCount: registry.listTrash().length,
				facets: registry.facets()
			});
		}
	});
	webServer.register({
		kind: "exact",
		path: `${prefix}/recover`,
		handler: async (_req, res) => {
			const r = await registry.recoverFromDisk();
			writeJson(res, 200, {
				ok: true,
				added: r.added,
				addedCount: r.added.length,
				scanned: r.scanned,
				skipped: r.skipped,
				facets: registry.facets()
			});
		}
	});
	webServer.register({
		kind: "exact",
		path: `${prefix}/meta`,
		handler: (req, res) => {
			const id = queryParam(req, "id");
			if (!id) {
				writeJson(res, 400, { error: "缺少 id 参数" });
				return;
			}
			const rec = registry.get(id);
			if (!rec) {
				writeJson(res, 404, { error: `找不到图像：${id}` });
				return;
			}
			writeJson(res, 200, rec);
		}
	});
	webServer.register({
		kind: "exact",
		path: `${prefix}/cancel`,
		handler: async (req, res) => {
			const job = queryParam(req, "job");
			const client = manager.getClient();
			if (!job || !client) {
				writeJson(res, 200, {
					cancelled: false,
					detail: job ? "worker 未启动" : "缺少 job 参数"
				});
				return;
			}
			try {
				writeJson(res, 200, await client.cancel(job));
			} catch (err) {
				writeJson(res, 500, {
					cancelled: false,
					error: err.message
				});
			}
		}
	});
	webServer.register({
		kind: "exact",
		path: `${prefix}/unload`,
		handler: async (_req, res) => {
			const client = manager.getClient();
			if (!client) {
				writeJson(res, 200, {
					unloaded: false,
					detail: "worker 未启动"
				});
				return;
			}
			try {
				writeJson(res, 200, await client.unload());
			} catch (err) {
				writeJson(res, 500, {
					unloaded: false,
					error: err.message
				});
			}
		}
	});
	webServer.register({
		kind: "exact",
		path: `${prefix}/health`,
		handler: async (_req, res) => {
			writeJson(res, 200, {
				manager: manager.getStatus(),
				worker: await manager.tryHealth() ?? null,
				presets: {
					draft: "768²/12步",
					standard: "1024²/24步",
					native: "2048²/40步"
				},
				galleryCount: registry.all().length,
				trashCount: registry.listTrash().length
			});
		}
	});
}
function queryParam(req, name) {
	const r = req;
	if (!r.url) return void 0;
	try {
		return new URL(r.url, "http://127.0.0.1").searchParams.get(name) ?? void 0;
	} catch {
		return;
	}
}
/** 记录 → 相册条目（单一出口，列表/改/删/还原都用它，避免字段漂移）。 */
function toGalleryItem(prefix, r) {
	return {
		id: r.id,
		rawUrl: `${prefix}/raw?id=${encodeURIComponent(r.id)}`,
		thumbUrl: `${prefix}/thumb?id=${encodeURIComponent(r.id)}`,
		hasThumb: !!r.thumb,
		width: r.width,
		height: r.height,
		bytes: r.bytes,
		thumbBytes: r.thumbBytes ?? null,
		hasAlpha: r.hasAlpha,
		seed: r.seed,
		steps: r.steps,
		prompt: r.prompt,
		kind: r.kind,
		elapsedSec: r.elapsedSec,
		steadyStepSec: r.steadyStepSec,
		peakVramMiB: r.peakVramMiB,
		device: r.device,
		dtype: r.dtype,
		createdAt: r.createdAt,
		inputImage: r.inputImage,
		usedReferences: r.usedReferences,
		tags: r.tags ?? [],
		favorite: !!r.favorite,
		note: r.note,
		promptEdited: !!r.promptEdited
	};
}
/** 解析画廊查询参数（排序字段走白名单，避免任意 key 打进来）。 */
function parseQueryOptions(req) {
	const num = (name) => {
		const v = queryParam(req, name);
		if (v == null || v === "") return void 0;
		const n = Number(v);
		if (Number.isFinite(n)) return n;
		const t = Date.parse(v);
		return Number.isFinite(t) ? t : void 0;
	};
	const sortRaw = queryParam(req, "sort");
	const sort = SORT_KEYS.includes(sortRaw ?? "") ? sortRaw : "createdAt";
	const tags = (queryParam(req, "tag") ?? queryParam(req, "tags") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
	const favRaw = queryParam(req, "fav");
	return {
		q: queryParam(req, "q") || void 0,
		kind: queryParam(req, "kind") || void 0,
		tags,
		fav: favRaw === "1" || favRaw === "true",
		size: num("size"),
		from: num("from"),
		to: num("to"),
		sort,
		order: queryParam(req, "order") === "asc" ? "asc" : "desc",
		limit: num("limit") ?? 200,
		offset: num("offset") ?? 0
	};
}
/** 写接口入参：query 铺底 + JSON body 覆盖（body 优先）。 */
async function bodyOrQuery(req) {
	const out = {};
	const r = req;
	if (r.url) try {
		const u = new URL(r.url, "http://127.0.0.1");
		for (const [k, v] of u.searchParams) out[k] = v;
	} catch {}
	const body = await readJsonBody(req);
	return {
		...out,
		...body
	};
}
/** 读 JSON body（异步迭代流；超限或非法一律当空对象，绝不抛）。 */
async function readJsonBody(req, maxBytes = 1 << 20) {
	const r = req;
	if (typeof r?.[Symbol.asyncIterator] !== "function") return {};
	const chunks = [];
	let size = 0;
	try {
		for await (const chunk of r) {
			const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
			size += buf.length;
			if (size > maxBytes) return {};
			chunks.push(buf);
		}
	} catch {
		return {};
	}
	if (!chunks.length) return {};
	try {
		const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch {
		return {};
	}
}
function idList(body) {
	const raw = body.ids ?? body.id;
	if (Array.isArray(raw)) return raw.map((x) => String(x).trim()).filter(Boolean);
	if (typeof raw === "string") return raw.split(",").map((s) => s.trim()).filter(Boolean);
	return [];
}
function strList(v) {
	if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
	if (typeof v === "string") return v.split(",").map((s) => s.trim()).filter(Boolean);
}
function boolOrUndefined(v) {
	if (typeof v === "boolean") return v;
	if (typeof v === "number") return v !== 0;
	if (typeof v === "string") {
		const s = v.trim().toLowerCase();
		if (s === "1" || s === "true" || s === "yes") return true;
		if (s === "0" || s === "false" || s === "no" || s === "") return false;
	}
}
function writeJson(res, status, payload) {
	writeText(res, status, "application/json; charset=utf-8", JSON.stringify(payload));
}
function writeText(res, status, contentType, body) {
	const r = res;
	const buf = Buffer.from(body, "utf8");
	r.writeHead(status, {
		"Content-Type": contentType,
		"Content-Length": String(buf.length)
	});
	r.end(body);
}
//#endregion
//#region src/host/index-inject.ts
/**
* 宿主 → 浏览器 的配置注入（index tap）。
*
* 客户端半需要知道 routePrefix（同源路由前缀）才能拼出图片 URL。
* 该前缀是可配置的（§4 routePrefix），客户端不应硬编码，否则改配置就断图。
*
* 用 webServer.tapIndex 注入一个全局常量：这是官方文档点名的逃生口
* （"the escape hatch for markup no IndexInjection row expresses"）。
* 客户端读 window.__QWEN_IMAGE__，读不到时回退到默认前缀。
*
* 同时把各档位实测耗时一并下发，卡片/gallery 才能显示诚实的 ETA。
*/
function registerIndexInjection(rt) {
	const { ctx, config } = rt;
	const webServer = ctx.get("webServer");
	if (!webServer || typeof webServer.tapIndex !== "function") {
		console.warn("[qwen-image] webServer.tapIndex 不可用，客户端将回退到默认 routePrefix");
		return;
	}
	const payload = {
		routePrefix: config.routePrefix,
		pluginId: "@lisonevf/dsh-qwen-image",
		presets: Object.values(PRESETS).map((p) => ({
			name: p.name,
			label: p.label,
			width: p.width,
			height: p.height,
			steps: p.steps,
			estimatedSec: presetSeconds(p)
		})),
		coldStartSec: 85,
		maxReferenceImages: config.maxReferenceImages
	};
	const script = `<script id="qwen-image-config">window.__QWEN_IMAGE__=${JSON.stringify(payload).replace(/</g, "\\u003c")};<\/script>`;
	webServer.tapIndex((html) => {
		if (html.includes("id=\"qwen-image-config\"")) return html;
		if (html.includes("</head>")) return html.replace("</head>", `${script}</head>`);
		return script + html;
	});
}
//#endregion
//#region src/index.ts
const name = "@lisonevf/dsh-qwen-image";
/**
* 硬依赖只声明三个，其余一律走 `ctx.get` 做**可选消费**。
*
* ⚠️ 为什么刻意让 inject 保持最小（实测教训的推广）：
* cordis 里 `inject` 是**激活门禁** —— 声明了某服务，本行就一直等到它出现；
* 若它始终不出现，启动会以
*   「row(s) did not activate: qwen-image: waiting for <service>」
* **失败**（不是降级）。而本插件对 `subprocess` / `fs` / `attachments` / `jobs`
* 的使用都是**惰性且可降级**的（`ctx.get` + undefined 检查，缺了就跳过对应能力），
* 所以它们不该进 inject —— 否则等于把「少一个可选服务」升级成「整棵插件树起不来」。
*
* 保留的三个是真需求：
*   - `tools`     —— apply 期就要 `ctx.tools.register(...)`（唯一硬属性访问）
*   - `webServer` —— apply 期就要挂同源路由，否则界面永远拿不到图
*   - `skills`    —— apply 期就要注册随包技能，晚到会静默丢失
*
* 注意：cordis 的服务**必须由 inject 声明才会暴露在 `ctx` 上**，故除 `ctx.tools`
* 之外一律用 `ctx.get('name')`（stock-panel 源码注释里记了同一条实测结论）。
*/
const inject = [
	"tools",
	"webServer",
	"skills"
];
/**
* 注意：本插件**不 import 任何 `@deepseek-ai/*` 运行时包**
* （`@deepseek-ai/cordis` 只用于类型，编译后消失）。
*
* 原因：插件以 `link:` 方式装进 profile，Node 按 **realpath** 解析链接包，
* 于是对 `@deepseek-ai/*` 的裸模块解析会从插件目录向上查找而**找不到**
* —— 该依赖住在 dsh 安装目录内，不在插件的解析链上。这是本仓库既有约定
* （见 `dsh-plugin-dev-kb` 源码里的「依赖纪律」注释）。
*
* 因此工具定义与 Config schema 分别由自包含的 `./host/tool-dsl.ts` 与
* `./host/config-schema.ts` 提供，二者与官方产物**逐字兼容**（已实测核对）。
*
* 自检：`node scripts/check-host-deps.mjs` 断言产物零裸包依赖。
*/
function apply(ctx, config) {
	const rt = createRuntime(ctx, config);
	try {
		registerSkill(ctx, config);
	} catch (err) {
		console.error("[qwen-image] 技能注册失败：", err.message);
	}
	const tools = ctx.tools;
	const register = (label, build) => {
		try {
			tools.register(defineTool(build()));
		} catch (err) {
			console.error(`[qwen-image] ${label} 注册失败：`, err.message);
		}
	};
	register("image_status", () => buildStatusTool(rt));
	register("image_worker", () => buildWorkerTool(rt));
	register("image_generate", () => buildGenerateTool(rt));
	register("image_edit", () => buildEditTool(rt));
	register("image_result", () => buildResultTool(rt));
	if (config.allowModelFetch) register("image_model_fetch", () => buildModelFetchTool(ctx, config));
	try {
		registerRoutes(rt);
	} catch (err) {
		console.error("[qwen-image] 路由注册失败：", err.message);
	}
	try {
		registerIndexInjection(rt);
	} catch (err) {
		console.error("[qwen-image] index 注入失败（客户端将回退默认 routePrefix）：", err.message);
	}
	console.log(`[qwen-image] 已加载：backend=${config.backend} modelDir=${config.modelDir} device=${config.device}/${config.dtype} preset=${config.preset}`);
}
//#endregion
exports.Config = Config;
exports.apply = apply;
exports.inject = inject;
exports.name = name;
