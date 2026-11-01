#!/usr/bin/env node
/**
 * build.js — 把 Godot 的 Web 导出产物转换成一个 TapTap 小游戏 zip。
 *
 * 用法：
 *   node tools/build.js --web ./build/web --out ./build/minigame.zip --name 背包修仙
 *   node tools/build.js --web ./build/web --out ./build/minigame/ --no-zip     # 只出目录，便于自测
 *   node tools/build.js --web ./build/web --scan                                # 只做静态扫描报告
 *
 * 设计原则：
 *   1. **不改 Godot 产物**，只在外面套一层小游戏外壳（game.js / game.json / adapter）。
 *   2. **不猜字段**：game.json 里只写文档明确列出的键，其余留给调用方 --game-json 覆盖。
 *   3. **可校验**：输出体积、首包、文件清单，超限直接红色报错。
 */

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

function parseArgs(argv) {
	const a = { web: null, out: null, name: "", scan: false, zip: true, orientation: "landscape", quiet: false };
	for (let i = 2; i < argv.length; i++) {
		const k = argv[i];
		const next = () => argv[++i];
		switch (k) {
			case "--web": a.web = next(); break;
			case "--out": a.out = next(); break;
			case "--name": a.name = next(); break;
			case "--orientation": a.orientation = next(); break;
			case "--scan": a.scan = true; break;
			case "--no-zip": a.zip = false; break;
			case "--quiet": a.quiet = true; break;
			case "-h": case "--help": a.help = true; break;
			default: throw new Error("未知参数: " + k);
		}
	}
	return a;
}

const LIMIT_FIRST_PACK = 60 * 1024 * 1024; // 平台「准入标准：压缩后 < 60M」
const LIMIT_GOOD = 20 * 1024 * 1024;       // 官方「优秀参考：20M」

const log = (s) => { if (!QUIET) console.log(s); };
let QUIET = false;
const c = {
	g: (s) => "\x1b[32m" + s + "\x1b[0m",
	y: (s) => "\x1b[33m" + s + "\x1b[0m",
	r: (s) => "\x1b[31m" + s + "\x1b[0m",
};
function human(n) {
	return (n / 1024 / 1024).toFixed(2) + " MB";
}

/* ---------------- 1. 校验输入 ---------------- */

function readWebDir(webDir) {
	if (!fs.existsSync(webDir)) throw new Error("找不到 Web 导出目录: " + webDir);
	const need = ["index.html", "index.js", "index.wasm", "index.pck"];
	const files = fs.readdirSync(webDir);
	for (const f of need) {
		if (!files.includes(f)) throw new Error("Web 目录缺必需文件: " + f + "（请用 Godot Web 预设导出）");
	}
	return files;
}

/* ---------------- 2. 扫描产物，决定要不要告警 ---------------- */

function scanIndexJs(jsPath) {
	const src = fs.readFileSync(jsPath, "utf8");
	const probes = {
		"document.*": (src.match(/document\.\w+/g) || []).length,
		"window.*": (src.match(/window\.\w+/g) || []).length,
		"navigator.*": (src.match(/navigator\.\w+/g) || []).length,
		"requestAnimationFrame": (src.split("requestAnimationFrame").length - 1),
		"AudioWorkletNode": (src.split("AudioWorkletNode").length - 1),
		"XMLHttpRequest": (src.split("XMLHttpRequest").length - 1),
		"GODOT_THREADS_ENABLED": (src.split("GODOT_THREADS_ENABLED").length - 1),
	};
	const threadsOn = /const GODOT_THREADS_ENABLED\s*=\s*true/.test(src);
	return { probes, threadsOn, bytes: Buffer.byteLength(src, "utf8") };
}

/* ---------------- 3. 生成小游戏外壳 ---------------- */

function godotConfigFromHtml(htmlPath) {
	// Godot 把配置写在 index.html 的 `const GODOT_CONFIG = {...}` 里；直接抠出来最准。
	const html = fs.readFileSync(htmlPath, "utf8");
	const m = html.match(/const GODOT_CONFIG = (\{.*?\});/s);
	if (!m) throw new Error("index.html 里找不到 GODOT_CONFIG");
	const cfg = JSON.parse(m[1]);
	cfg.canvasResizePolicy = 0; // 小游戏画布由适配层给定，不参与 resize
	return cfg;
}

function writeExports(ctx, webDir, outDir, opts) {
	const cfg = godotConfigFromHtml(path.join(webDir, "index.html"));

	// engine.js = index.js 改名；fileName 指向它自己会很怪，所以把配置里的路径都改成包内相对名
	fs.copyFileSync(path.join(webDir, "index.js"), path.join(outDir, "engine.js"));
	fs.copyFileSync(path.join(webDir, "index.wasm"), path.join(outDir, "index.wasm"));
	fs.copyFileSync(path.join(webDir, "index.pck"), path.join(outDir, "index.pck"));

	// Godot 的音频 worklet 是可选的：小游戏 AudioWorklet 不一定可用，带上无害（引擎会探测）。
	for (const f of ["index.audio.worklet.js", "index.audio.position.worklet.js"]) {
		const src = path.join(webDir, f);
		if (fs.existsSync(src)) fs.copyFileSync(src, path.join(outDir, f));
	}
	// 启动图：改成可选，缺了不致命
	const png = path.join(webDir, "index.png");
	if (fs.existsSync(png)) fs.copyFileSync(png, path.join(outDir, "index.png"));

	const tmpl = fs.readFileSync(path.join(__dirname, "..", "runtime", "game.js.tmpl"), "utf8");
	const gameJs = tmpl.replace("__GODOT_CONFIG__", JSON.stringify(cfg, null, 0));
	fs.writeFileSync(path.join(outDir, "game.js"), gameJs, "utf8");

	const gameJson = { deviceOrientation: opts.orientation === "portrait" ? "portrait" : "landscape" };
	fs.writeFileSync(path.join(outDir, "game.json"), JSON.stringify(gameJson, null, 2) + "\n", "utf8");

	const projectConfig = {
		description: opts.name || "Godot Game",
		setting: { es6: true },
	};
	fs.writeFileSync(path.join(outDir, "project.config.json"), JSON.stringify(projectConfig, null, 2) + "\n", "utf8");

	return cfg;
}

/* ---------------- 4. 打 zip（手写 store 模式，零依赖） ---------------- */

const CRC_TABLE = (() => {
	const t = new Uint32Array(256);
	for (let i = 0; i < 256; i++) {
		let ch = i;
		for (let j = 0; j < 8; j++) ch = (ch & 1) ? (0xEDB88320 ^ (ch >>> 1)) : (ch >>> 1);
		t[i] = ch >>> 0;
	}
	return t;
})();

function crc32(buf) {
	let crc = 0xFFFFFFFF;
	for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
	return (crc ^ 0xFFFFFFFF) >>> 0;
}

function dosTime(d) {
	const time = ((d.getHours() & 0x1F) << 11) | ((d.getMinutes() & 0x3F) << 5) | ((d.getSeconds() / 2) & 0x1F);
	const date = (((d.getFullYear() - 1980) & 0x7F) << 9) | (((d.getMonth() + 1) & 0x0F) << 5) | (d.getDate() & 0x1F);
	return { time, date };
}

function makeZip(dir) {
	const entries = [];
	for (const name of fs.readdirSync(dir).sort()) {
		const fp = path.join(dir, name);
		const st = fs.statSync(fp);
		if (!st.isFile()) continue;
		const raw = fs.readFileSync(fp);
		const data = zlib.deflateRawSync(raw, { level: 9 }); // deflate：首包体积是硬指标
		entries.push({ name, raw, data, crc: crc32(raw), mtime: st.mtime });
	}

	const chunks = [];
	const central = [];
	let offset = 0;
	for (const e of entries) {
		const nameBuf = Buffer.from(e.name, "utf8");
		const { time, date } = dosTime(e.mtime);
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);          // version needed
		local.writeUInt16LE(0x0800, 6);      // UTF-8 flag
		local.writeUInt16LE(8, 8);           // deflate
		local.writeUInt16LE(time, 10);
		local.writeUInt16LE(date, 12);
		local.writeUInt32LE(e.crc, 14);
		local.writeUInt32LE(e.data.length, 18);
		local.writeUInt32LE(e.raw.length, 22);
		local.writeUInt16LE(nameBuf.length, 26);
		local.writeUInt16LE(0, 28);
		chunks.push(local, nameBuf, e.data);

		const cen = Buffer.alloc(46);
		cen.writeUInt32LE(0x02014b50, 0);
		cen.writeUInt16LE(20, 4);
		cen.writeUInt16LE(20, 6);
		cen.writeUInt16LE(0x0800, 8);
		cen.writeUInt16LE(8, 10);
		cen.writeUInt16LE(time, 12);
		cen.writeUInt16LE(date, 14);
		cen.writeUInt32LE(e.crc, 16);
		cen.writeUInt32LE(e.data.length, 20);
		cen.writeUInt32LE(e.raw.length, 24);
		cen.writeUInt16LE(nameBuf.length, 28);
		cen.writeUInt16LE(0, 30);
		cen.writeUInt16LE(0, 32);
		cen.writeUInt16LE(0, 34);
		cen.writeUInt16LE(0, 36);
		cen.writeUInt32LE(0, 38);
		cen.writeUInt32LE(offset, 42);
		central.push(cen, nameBuf);
		offset += local.length + nameBuf.length + e.data.length;
	}
	const centralBuf = Buffer.concat(central);
	const eocd = Buffer.alloc(22);
	eocd.writeUInt32LE(0x06054b50, 0);
	eocd.writeUInt16LE(entries.length, 8);
	eocd.writeUInt16LE(entries.length, 10);
	eocd.writeUInt32LE(centralBuf.length, 12);
	eocd.writeUInt32LE(offset, 16);
	return { buffer: Buffer.concat([...chunks, centralBuf, eocd]), entries };
}

/* ---------------- 5. 主流程 ---------------- */

function main() {
	const args = parseArgs(process.argv);
	if (args.help || (!args.web)) {
		console.log(`用法:
  node tools/build.js --web <Godot Web 导出目录> --out <输出 zip 或目录> [--name 游戏名] [--orientation landscape|portrait] [--no-zip] [--scan]`);
		process.exit(args.help ? 0 : 1);
	}
	QUIET = args.quiet;

	const files = readWebDir(args.web);
	// 只保留实际需要的：Godot Web 目录里 index.html 只用来抠配置
	const keep = ["index.js", "index.wasm", "index.pck", "index.audio.worklet.js", "index.audio.position.worklet.js", "index.png"];
	const extra = files.filter((f) => !keep.includes(f) && !f.startsWith("."));
	if (extra.length) log(c.y("  跳过（不属于小游戏包）: ") + extra.join(", "));

	const scan = scanIndexJs(path.join(args.web, "index.js"));
	log("=== 产物扫描 ===");
	for (const [k, v] of Object.entries(scan.probes)) log("  " + k.padEnd(24) + v);
	if (scan.threadsOn) throw new Error("检测到 GODOT_THREADS_ENABLED=true —— 小游戏不支持多线程，请用 web_nothreads_release 模板重新导出");
	log(c.g("  threads: disabled ✓"));

	const rawTotal = fs.readdirSync(args.web)
		.filter((f) => keep.includes(f))
		.reduce((s, f) => s + fs.statSync(path.join(args.web, f)).size, 0);
	log("  原始大小: " + human(rawTotal));

	if (args.scan) {
		// 只算压缩后体积，不写文件
		const dir = fs.mkdtempSync(path.join(require("os").tmpdir(), "mgscan-"));
		writeExports({}, args.web, dir, args);
		for (const f of ["game.js", "game.json", "project.config.json"]) {
			const src = path.join(__dirname, "..", "runtime", "tap-adapter.js");
			if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dir, f + ".adapter"));
		}
		fs.copyFileSync(path.join(__dirname, "..", "runtime", "tap-adapter.js"), path.join(dir, "tap-adapter.js"));
		const z = makeZip(dir);
		log("  压缩后: " + human(z.buffer.length) + (z.buffer.length > LIMIT_FIRST_PACK ? c.r("  ✗ 超 60M") :
			(z.buffer.length > LIMIT_GOOD ? c.y("  ⚠ 未进优秀线(20M)") : c.g("  ✓ 优秀"))));
		fs.rmSync(dir, { recursive: true, force: true });
		return;
	}

	const outDir = args.zip ? args.out.replace(/\\/g, "/") : args.out;
	if (args.zip) {
		const scratch = fs.mkdtempSync(path.join(require("os").tmpdir(), "mgbuild-"));
		writeExports({}, args.web, scratch, args);
		// 适配层进包（必须在 game.js 之前被 require，靠 require 顺序保证，不是靠文件名前缀）
		fs.copyFileSync(path.join(__dirname, "..", "runtime", "tap-adapter.js"), path.join(scratch, "tap-adapter.js"));
		const z = makeZip(scratch);
		fs.mkdirSync(path.dirname(outDir), { recursive: true });
		fs.writeFileSync(outDir, z.buffer);
		log("\n=== 打包完成 ===");
		for (const e of z.entries) log("  " + e.name.padEnd(32) + human(e.raw.length) + " → " + human(e.data.length));
		log("  " + "-".repeat(52));
		const verdict = z.buffer.length > LIMIT_FIRST_PACK
			? c.r("✗ 超过首包准入线 60MB，会被平台拒绝")
			: (z.buffer.length > LIMIT_GOOD ? c.y("⚠ 通过准入但未进 20MB 优秀线") : c.g("✓ 在 20MB 优秀线内"));
		log("  首包 " + human(z.buffer.length) + "  " + verdict);
		log("  输出 " + path.resolve(outDir));
		fs.rmSync(scratch, { recursive: true, force: true });
		if (z.buffer.length > LIMIT_FIRST_PACK) process.exitCode = 2;
	} else {
		fs.mkdirSync(outDir, { recursive: true });
		writeExports({}, args.web, outDir, args);
		fs.copyFileSync(path.join(__dirname, "..", "runtime", "tap-adapter.js"), path.join(outDir, "tap-adapter.js"));
		log("\n=== 输出目录（可直接用平台自测）===\n  " + path.resolve(outDir));
	}
}

main();
