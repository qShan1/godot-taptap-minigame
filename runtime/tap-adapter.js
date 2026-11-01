/**
 * Godot 4 → TapTap 小游戏 运行时桥接层
 *
 * 小游戏 VM 里**没有 BOM / DOM**（https://developer.taptap.cn/minigameapidoc/dev/tutorial/overview/），
 * 而 Godot 的 Web 导出产物（index.js）把 DOM 写死在 Emscripten 胶水层里。本文件在
 * Godot 脚本加载**之前**执行，用 Tap API 造一份最小可用的 DOM 假面，再把
 * `document.createElement('canvas').getContext(...)` 指向 `tap.createCanvas()` 的真画布。
 *
 * 名字面来自对 Godot 4.7.1 index.js 的静态扫描（工具侧 `scan` 子命令可复现）：
 *   document.* 27 处 / window.* 29 处 / navigator.* 33 处 / requestAnimationFrame 19 处。
 * 这里只补**引擎真正会走到**的那些，没出现的（如 localStorage、matchMedia）故意不补 ——
 * 补了反而会掩盖「某条分支悄悄走了浏览器路径」的问题。
 */

/* ------------------------------------------------------------------ */
/* 一、画布：唯一真正的显示面                                          */
/* ------------------------------------------------------------------ */

/** 小游戏里第一个 tap.createCanvas() 是上屏画布，之后是离屏画布。 */
let mainCanvas = null;

function getMainCanvas() {
	if (mainCanvas === null) {
		mainCanvas = tap.createCanvas();
	}
	return mainCanvas;
}

/** Emscripten 只需要 `width/height/getContext/addEventListener/style` 这几样。 */
function makeCanvasLike() {
	const canvas = getMainCanvas();
	if (!canvas.style) {
		// 引擎会写 `canvas.style.cursor`、`canvas.style.width` 等；小游戏画布没有 style，
		// 用一个无副作用的吸收对象替它吃掉这些赋值。
		canvas.style = new Proxy({}, {
			get: () => "",
			set: () => true,
		});
	}
	if (!canvas.getBoundingClientRect) {
		canvas.getBoundingClientRect = () => ({
			x: 0, y: 0,
			top: 0, left: 0,
			right: canvas.width, bottom: canvas.height,
			width: canvas.width, height: canvas.height,
		});
	}
	if (!canvas.addEventListener) {
		canvas.addEventListener = () => {};
		canvas.removeEventListener = () => {};
	}
	return canvas;
}

/* ------------------------------------------------------------------ */
/* 二、事件：把 tap 的触摸回调翻译成 DOM 事件                          */
/* ------------------------------------------------------------------ */

const listeners = new Map(); // "type" -> Set<fn>

function fire(type, event) {
	const set = listeners.get(type);
	if (!set) return;
	for (const fn of set) {
		try { fn(event); } catch (e) { console.error("[tap-adapter] listener", type, e); }
	}
}

function addListener(type, fn) {
	if (!listeners.has(type)) listeners.set(type, new Set());
	listeners.get(type).add(fn);
}

function removeListener(type, fn) {
	const set = listeners.get(type);
	if (set) set.delete(fn);
}

/** 触摸坐标换算成「逻辑像素」，这里 1:1，hidpi 由引擎自己按 devicePixelRatio 处理。 */
function touchToEvent(kind, t) {
	return {
		type: kind,
		clientX: t.clientX, clientY: t.clientY,
		pageX: t.clientX, pageY: t.clientY,
		screenX: t.clientX, screenY: t.clientY,
		identifier: t.identifier,
		pointerId: t.identifier,
		pointerType: "touch",
		isPrimary: t.identifier === 0,
		button: kind === "pointerdown" ? 0 : -1,
		buttons: kind === "pointerdown" || kind === "pointermove" ? 1 : 0,
		target: getMainCanvas(),
		currentTarget: getMainCanvas(),
		defaultPrevented: false,
		preventDefault() { this.defaultPrevented = true; },
		stopPropagation() {},
		stopImmediatePropagation() {},
	};
}

function bindTouch() {
	const c = getMainCanvas();
	if (typeof c.addEventListener !== "function") return; // 极端情况下无触摸（纯桌面调试）

	c.addEventListener("touchstart", (res) => {
		const touches = (res.touches || res.changedTouches || []);
		for (const t of touches) {
			fire("pointerdown", touchToEvent("pointerdown", t));
			fire("touchstart", touchToEvent("touchstart", t));
		}
	});
	c.addEventListener("touchmove", (res) => {
		const touches = (res.touches || res.changedTouches || []);
		for (const t of touches) {
			fire("pointermove", touchToEvent("pointermove", t));
			fire("touchmove", touchToEvent("touchmove", t));
		}
	});
	const end = (res) => {
		const touches = (res.touches || res.changedTouches || []);
		for (const t of touches) {
			fire("pointerup", touchToEvent("pointerup", t));
			fire("touchend", touchToEvent("touchend", t));
		}
	};
	c.addEventListener("touchend", end);
	c.addEventListener("touchcancel", end);
}

/* ------------------------------------------------------------------ */
/* 三、DOM 假面                                                       */
/* ------------------------------------------------------------------ */

/** 引擎会 `document.createElement('canvas')` 做 WebGL 能力探测 —— 必须回真画布。 */
function createElement(tag) {
	if (String(tag).toLowerCase() === "canvas") {
		return makeCanvasLike();
	}
	// 其它元素（input 软键盘、div IME）在小游戏里没有对应物，给个空壳吸收属性赋值。
	const stub = {
		style: {}, classList: { add() {}, remove() {}, toggle() {} },
		appendChild() {}, removeChild() {}, insertBefore() {},
		setAttribute() {}, getAttribute() { return null; },
		addEventListener() {}, removeEventListener() {},
		focus() {}, blur() {},
		children: [], childNodes: [],
		innerHTML: "", textContent: "",
	};
	return stub;
}

function installDom() {
	const canvas = makeCanvasLike();

	const documentShim = {
		createElement,
		getElementById: (id) => (String(id) === "canvas" ? canvas : null),
		querySelector: (sel) => (String(sel) === "#canvas" ? canvas : null),
		getElementsByTagName: (tag) => (String(tag).toLowerCase() === "canvas" ? [canvas] : []),
		addEventListener: addListener,
		removeEventListener: removeListener,
		body: { style: {}, appendChild() {}, removeChild() {} },
		head: { appendChild() {} },
		documentElement: { style: {} },
		activeElement: null,
		title: "TapTap MiniGame",
		currentScript: { src: "game.js" },
		createTextNode: (t) => ({ nodeValue: t }),
		hasFocus: () => true,
		exitPointerLock() {}, exitFullscreen() {},
		fullscreenElement: null, fullscreenEnabled: false, pointerLockElement: null,
		hidden: false, visibilityState: "visible",
	};

	const windowShim = {
		document: documentShim,
		devicePixelRatio: 1,
		innerWidth: canvas.width, innerHeight: canvas.height,
		outerWidth: canvas.width, outerHeight: canvas.height,
		screen: { width: canvas.width, height: canvas.height, orientation: { angle: 0, type: "landscape-primary" } },
		addEventListener: addListener,
		removeEventListener: removeListener,
		requestAnimationFrame: (cb) => requestAnimationFrame(cb),
		cancelAnimationFrame: (id) => cancelAnimationFrame(id),
		alert: (msg) => { try { tap.showToast({ title: String(msg), duration: 2000 }); } catch (e) {} },
		open: () => null,
		setTimeout, clearTimeout, setInterval, clearInterval,
		URL: globalThis.URL,
		TextDecoder: globalThis.TextDecoder,
		TextEncoder: globalThis.TextEncoder,
		isSecureContext: true,
		crossOriginIsolated: false,
		Worker: globalThis.Worker,
	};

	globalThis.document = documentShim;
	globalThis.window = globalThis.window || globalThis;
	for (const k of Object.keys(windowShim)) {
		// 小游戏 VM 里全局对象就是 window，逐项补上去即可。
		try {
			if (globalThis[k] === undefined) globalThis[k] = windowShim[k];
		} catch (e) { /* 只读全局，跳过 */ }
	}
	// 这几个是引擎硬依赖，无条件覆盖
	globalThis.document = documentShim;
	try { globalThis.window = globalThis; } catch (e) {}
	globalThis.devicePixelRatio = 1;
	globalThis.innerWidth = canvas.width;
	globalThis.innerHeight = canvas.height;

	const nav = globalThis.navigator || {};
	const defaults = {
		userAgent: "TapTapMiniGame",
		platform: "TapTapMiniGame",
		language: navigator_lang(),
		languages: [navigator_lang()],
		hardwareConcurrency: 4,
		onLine: true,
		mediaDevices: undefined,
		getGamepads: () => [],
		vibrate: (ms) => { try { tap.vibrateShort && tap.vibrateShort(); } catch (e) {} return true; },
		clipboard: undefined,
		serviceWorker: undefined,
		xr: undefined,
	};
	for (const k of Object.keys(defaults)) {
		try {
			if (nav[k] === undefined) nav[k] = defaults[k];
		} catch (e) {}
	}
	globalThis.navigator = nav;

	// 音频：小游戏支持 WebAudio，但 AudioWorklet 不一定有 —— 缺了就关掉，
	// 引擎会走 ScriptProcessor 兜底。
	if (globalThis.AudioContext === undefined && globalThis.webkitAudioContext !== undefined) {
		globalThis.AudioContext = globalThis.webkitAudioContext;
	}
	return canvas;
}

function navigator_lang() {
	try {
		const info = tap.getSystemInfoSync ? tap.getSystemInfoSync() : null;
		return (info && info.language) || "zh_CN";
	} catch (e) {
		return "zh_CN";
	}
}

/* ------------------------------------------------------------------ */
/* 四、资源加载：把小游戏包内文件喂给 Emscripten 的 fetch / XHR        */
/* ------------------------------------------------------------------ */

/**
 * Emscripten 的 `fetch` 分支要 `Response` + `body.getReader()`（流式读进度）。
 * 小游戏没有 fetch，但 `tap.getFileSystemManager()` 能读包内文件 —— 于是我们实现一个
 * 最小的 `fetch(url)`，返回一个带 `body.getReader()` 的假 Response。
 */
const fsm = (() => {
	try { return tap.getFileSystemManager(); } catch (e) { return null; }
})();

function readFileAsArrayBufferSync(path) {
	if (fsm === null) throw new Error("[tap-adapter] FileSystemManager 不可用");
	const data = fsm.readFileSync(path, "binary"); // 返回 ArrayBuffer（见文档 FileSystemManager.readFileSync）
	return data instanceof ArrayBuffer ? data : new Uint8Array(data);
}

function normalizeUrl(url) {
	// 引擎传进来的是 `index.wasm` / `index.pck` 这类相对路径，直接落到包根目录。
	return String(url).replace(/^\.\//, "");
}

function makeFakeResponse(buffer, url) {
	const bytes = buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : buffer;
	let sent = false;
	const body = {
		getReader: () => ({
			read: () => {
				if (sent) return Promise.resolve({ done: true, value: undefined });
				sent = true;
				return Promise.resolve({ done: false, value: bytes });
			},
			cancel: () => Promise.resolve(),
			releaseLock: () => {},
		}),
	};
	return {
		ok: true, status: 200, statusText: "OK", url: String(url), redirected: false,
		headers: { get: () => null },
		body,
		arrayBuffer: () => Promise.resolve(bytes),
		text: () => Promise.resolve(new TextDecoder().decode(bytes)),
		json: () => Promise.resolve(JSON.parse(new TextDecoder().decode(bytes))),
	};
}

function installFetch() {
	if (typeof globalThis.fetch === "function") return; // 有些 VM 自带
	globalThis.fetch = function (input) {
		const url = typeof input === "string" ? input : (input && input.url) || "";
		try {
			const buf = readFileAsArrayBufferSync(normalizeUrl(url));
			return Promise.resolve(makeFakeResponse(buf, url));
		} catch (e) {
			console.error("[tap-adapter] fetch failed:", url, e);
			return Promise.reject(e);
		}
	};
	if (globalThis.Response === undefined) {
		globalThis.Response = function () { /* 仅用于 typeof 判定 */ };
	}
}

/* ------------------------------------------------------------------ */
/* 五、启动                                                           */
/* ------------------------------------------------------------------ */

function boot() {
	installDom();
	bindTouch();
	installFetch();
	console.log("[tap-adapter] ready: canvas=" + getMainCanvas().width + "x" + getMainCanvas().height);
}

boot();
