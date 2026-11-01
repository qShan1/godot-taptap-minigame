/**
 * smoke.js — 在 Node 里模拟一个「没有 BOM/DOM 的小游戏 VM」，验证适配层能把
 * Godot 的 engine.js 加载起来。
 *
 * 为什么要这么做：真机自测是最后一步，但**加载阶段的失败最贵**（一次上传要等）。
 * 这个 harness 用 `vm` 造一个干净上下文（默认没有 document / window / navigator），
 * 只注入 Tap API 的 mock，然后按小游戏的真实顺序（adapter → engine → startGame）跑一遍。
 *
 * 用法：
 *   node tools/smoke.js --web <Godot Web 导出目录>
 * 退出码 0 = 加载阶段没炸；非 0 = 适配层缺口，并打印缺哪个全局。
 */

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function parseArgs(argv) {
	const a = { web: null };
	for (let i = 2; i < argv.length; i++) {
		if (argv[i] === "--web") a.web = argv[++i];
	}
	return a;
}

/* ---------------- Tap API mock ---------------- */

function makeTapMock(canvasW, canvasH) {
	const noop = () => {};
	const canvas = {
		width: canvasW,
		height: canvasH,
		getContext: () => ({ /* 只要 typeof 是 object 就够引擎探测用 */ }),
		addEventListener: noop,
		removeEventListener: noop,
		getBoundingClientRect: () => ({ x: 0, y: 0, top: 0, left: 0, right: canvasW, bottom: canvasH, width: canvasW, height: canvasH }),
		toDataURL: () => "data:",
	};
	let created = 0;
	const files = new Map();
	return {
		createCanvas: () => { created++; return canvas; },
		createImage: () => ({ src: "", width: 0, height: 0, onload: null,
			addEventListener: noop, removeEventListener: noop }),
		getFileSystemManager: () => ({
			readFileSync: (fp) => {
				if (!files.has(fp)) throw new Error("no such file: " + fp);
				return files.get(fp);
			},
			readFile: (o) => { try { o.success && o.success({ data: files.get(o.filePath) }); } catch (e) { o.fail && o.fail(e); } },
		}),
		showToast: noop,
		vibrateShort: noop,
		getSystemInfoSync: () => ({ language: "zh_CN", platform: "android", screenWidth: canvasW, screenHeight: canvasH, pixelRatio: 1 }),
		requestAnimationFrame: (cb) => setImmediate(() => cb(Date.now())),
		cancelAnimationFrame: (id) => clearImmediate(id),
		onShow: noop, onHide: noop,
		env: { USER_DATA_PATH: "/user" },
		__files: files,
		__canvas: canvas,
		__created: () => created,
	};
}

/* ---------------- 沙箱 ---------------- */

function makeSandbox(tapMock) {
	// 只给 ECMAScript 标准的东西 + Tap API。**故意不给** document / window / navigator。
	const sandbox = {
		console,
		setTimeout, clearTimeout, setInterval, clearInterval, setImmediate, clearImmediate,
		TextDecoder, TextEncoder, URL, URLSearchParams,
		WebAssembly, ArrayBuffer, Uint8Array, Uint16Array, Uint32Array, Int8Array, Int16Array, Int32Array,
		Float32Array, Float64Array, DataView, SharedArrayBuffer,
		Math, JSON, Date, RegExp, Error, TypeError, RangeError, Symbol, Proxy, Reflect,
		Map, Set, WeakMap, WeakSet, Promise, Array, Object, String, Number, Boolean, Function,
		performance: { now: () => Date.now() },
		tap: tapMock,
	};
	sandbox.globalThis = sandbox;
	return vm.createContext(sandbox);
}

function run(ctx, file) {
	const code = fs.readFileSync(file, "utf8");
	return vm.runInContext(code, ctx, { filename: path.basename(file) });
}

/* ---------------- 主流程 ---------------- */

async function main() {
	const args = parseArgs(process.argv);
	if (!args.web) {
		console.log("用法: node tools/smoke.js --web <Godot Web 导出目录>");
		process.exit(1);
	}
	const adapterPath = path.join(__dirname, "..", "runtime", "tap-adapter.js");
	const enginePath = path.join(args.web, "index.js");
	const wasmPath = path.join(args.web, "index.wasm");
	const pckPath = path.join(args.web, "index.pck");

	const tapMock = makeTapMock(1280, 800);
	tapMock.__files.set("index.wasm", fs.readFileSync(wasmPath));
	tapMock.__files.set("index.pck", fs.readFileSync(pckPath));

	const ctx = makeSandbox(tapMock);
	let pass = 0;
	let fail = 0;
	const ok = (cond, msg) => {
		if (cond) { pass++; console.log("  [PASS] " + msg); }
		else { fail++; console.log("  [FAIL] " + msg); }
	};
	const step = (name, fn) => {
		try { fn(); } catch (e) { fail++; console.log("  [FAIL] " + name + " → " + (e && e.message || e)); return false; }
		return true;
	};

	console.log("=== 1. 沙箱确实没有 DOM ===");
	ok(vm.runInContext("typeof document", ctx) === "undefined", "初始无 document");
	ok(vm.runInContext("typeof window", ctx) === "undefined", "初始无 window");
	ok(vm.runInContext("typeof navigator", ctx) === "undefined", "初始无 navigator");

	console.log("=== 2. 加载适配层 ===");
	step("adapter", () => run(ctx, adapterPath));
	ok(vm.runInContext("typeof document", ctx) === "object", "适配后 document 存在");
	ok(vm.runInContext("typeof window", ctx) === "object", "适配后 window 存在");
	ok(vm.runInContext("typeof navigator", ctx) === "object", "适配后 navigator 存在");
	ok(vm.runInContext("typeof fetch", ctx) === "function", "适配后 fetch 存在");
	ok(vm.runInContext("typeof requestAnimationFrame", ctx) === "function", "适配后 rAF 存在");
	ok(tapMock.__created() >= 1, "适配层拿到了 tap.createCanvas（调用 " + tapMock.__created() + " 次）");

	console.log("=== 3. 加载 Godot engine.js ===");
	const loaded = step("engine", () => run(ctx, enginePath));
	ok(loaded, "engine.js 在无 DOM 沙箱里加载成功");
	ok(vm.runInContext("typeof window.Engine", ctx) === "function" || vm.runInContext("typeof Engine", ctx) === "function",
		"window.Engine 已挂上");

	console.log("=== 4. 特性探测不抛 ===");
	const feats = step("features", () => vm.runInContext(
		"JSON.stringify([Engine.isWebGLAvailable(1), Engine.isFetchAvailable(), Engine.isSecureContext(), Engine.isCrossOriginIsolated()])", ctx));
	if (feats) {
		const v = vm.runInContext("[			Engine.isWebGLAvailable(1), Engine.isFetchAvailable(), Engine.isSecureContext(), Engine.isCrossOriginIsolated()]", ctx);
		ok(true, "探测结果 = " + JSON.stringify(v.slice ? v : v) + "（mock 环境不追求真值，只求不抛）");
	}

	console.log("=== 5. 适配层的 fetch 能喂出可编译的 wasm ===");
	// 这是整条链路里最容易静默失败的一环：Emscripten 走 `WebAssembly.instantiateStreaming(fetch(url))`，
	// 小游戏没有 fetch，靠适配层用 FileSystemManager 兜。下面用**适配层自己的 fetch** 取 wasm 并编译，
	// 编译成功 = 包内 wasm 完好 + 假 Response 的 body.getReader() 契约成立。
	const fetchInSandbox = vm.runInContext("fetch", ctx);
	fetchInSandbox("index.wasm").then((res) => {
		ok(res.ok === true, "fetch('index.wasm') 返回 ok=true");
		ok(res.body && typeof res.body.getReader === "function", "返回体带 body.getReader（instantiateStreaming 的前提）");
		// Node 的 WebAssembly.compileStreaming 只吃真 Response，所以这里退一步：
		// 先用适配层的 body.getReader() 把字节流读出来，再 compile —— 等价验证「流式契约成立」。
		const reader = res.body.getReader();
		const chunks = [];
		const pump = () => reader.read().then((step) => {
			if (step.done) return Buffer.concat(chunks);
			chunks.push(Buffer.from(step.value));
			return pump();
		});
		return pump().then((buf) => WebAssembly.compile(buf));
	}).then((mod) => {
		ok(mod instanceof WebAssembly.Module, "wasm 编译成功（WebAssembly.Module）");
		ok(WebAssembly.Module.imports(mod).length >= 0, "imports 可读出（" + WebAssembly.Module.imports(mod).length + " 项）");
		return fetchInSandbox("index.pck").then((r) => r.arrayBuffer()).then((buf) => {
			ok(buf.byteLength > 0, "pck 能取到字节（" + (buf.byteLength / 1024 / 1024).toFixed(2) + " MB）");
		});
	}).catch((e) => {
		fail++;
		console.log("  [FAIL] 资源喂给引擎失败: " + (e && e.message || e));
	}).then(() => {
		console.log("\n=== SMOKE: " + pass + " PASS / " + fail + " FAIL ===");
		process.exitCode = fail === 0 ? 0 : 1;
	});
}

main();
