# godot-taptap-minigame

把 **Godot 4 的 Web 导出产物** 转成一个 **TapTap 小游戏** 可上传的 zip 包。

TapTap 小游戏的运行环境是一个**只有 `tap` API、没有 BOM/DOM** 的 JS VM
（[官方原文](https://developer.taptap.cn/minigameapidoc/dev/tutorial/overview/)：
“不同于浏览器，这个运行环境没有 `BOM` 和 `DOM` API”）。
而 Godot 的 `index.js` 把 DOM 写死在 Emscripten 胶水层里 —— 直接传上去必然白屏/报错。

这个工具做两件事：

1. **运行时桥接层**（`runtime/tap-adapter.js`）：在 Godot 脚本加载**之前**，用 Tap API
   造一份最小可用的 DOM 假面（canvas / document / window / navigator / fetch），
   让 Emscripten 以为自己还在浏览器里。
2. **打包器**（`tools/build.js`）：把 `index.js / index.wasm / index.pck` 重新排成
   小游戏规定的包结构（`game.js` + `game.json` + `project.config.json`），并给出
   压缩后首包体积与平台线的判定。

---

## 快速开始

```bash
# 0. 前置：Godot 里装好 Web 导出模板（project.godot → 导出 → Web）
#    必须在 project.godot 里确认用的是 gl_compatibility 渲染器

# 1. 用 Web 预设导出（无头也行）
godot --headless --path . --export-release "Web" build/web/index.html

# 2. 转成小游戏包
git clone https://github.com/<you>/godot-taptap-minigame.git
cd godot-taptap-minigame
node tools/build.js --web <你的项目>/build/web --out ./build/minigame.zip --name "你的游戏"
```

输出会直接告诉你首包能不能过：

```
=== 打包完成 ===
  engine.js                       0.27 MB → 0.07 MB
  game.js                         0.00 MB → 0.00 MB
  game.json                       0.00 MB → 0.00 MB
  index.pck                       9.28 MB → 8.76 MB
  index.wasm                     37.68 MB → 9.68 MB
  tap-adapter.js                  0.01 MB → 0.00 MB
  ----------------------------------------------------
  首包 18.68 MB  ✓ 在 20MB 优秀线内
```

然后去开发者中心 **包体管理 → 开发版本 → 上传**，用扫码自测跑一遍。

---

## 命令行

```bash
node tools/build.js --web <Web导出目录> --out <zip 路径> [选项]

  --web <dir>            必填。Godot Web 导出目录（含 index.html/js/wasm/pck）
  --out <path>           必填。输出 zip 路径
  --name <str>           游戏名，写进 project.config.json 的 description
  --orientation <o>      landscape（默认）| portrait
  --no-zip               只输出目录（便于本地改一改再传）
  --scan                 只做产物扫描 + 体积预估，不写文件
  --quiet                静音

node tools/smoke.js --web <Web导出目录>
  在没有 DOM 的 Node 沙箱里验证适配层（见下）
```

退出码：`0` 正常，`1` 参数错误，`2` **首包超过平台 60MB 准入线**。

---

## 这个适配层到底补了什么

不猜、不凑数：下面每个数字都来自对 **Godot 4.7.1** `index.js` 的静态扫描
（`node tools/build.js --scan` 可复现）。

| 引擎用到的 | 次数 | 适配层怎么给 |
| --- | --- | --- |
| `document.*` | 27 | 造一个 document 假面：`createElement / getElementById / querySelector / getElementsByTagName` |
| `window.*` | 29 | 小游戏里全局对象就是 window，逐项补 `innerWidth / devicePixelRatio / requestAnimationFrame / addEventListener` |
| `navigator.*` | 33 | `userAgent / language / hardwareConcurrency / getGamepads / vibrate` 等 |
| `requestAnimationFrame` | 19 | 直接转发到小游戏同名 API |
| `canvas.getContext` | 10 | 全部指向 `tap.createCanvas()` 的**那块真画布** |
| `fetch` | 4 | 用 `tap.getFileSystemManager().readFileSync` 读包内文件，返回**带 `body.getReader()` 的假 Response**（Emscripten 的流式编译路径依赖它） |
| `XMLHttpRequest` | 5 | 不用补：Emscripten 只在 Worker 分支走 XHR，我们不开线程 |
| `AudioWorkletNode` | 4 | 不强补：引擎自己会探测 `ctx.audioWorklet`，缺了自动退 ScriptProcessor |

**故意不补**的：`localStorage`、`matchMedia`、`OffscreenCanvas`、`createImageBitmap`。
理由：Godot 的 Web 路径根本不走这些；补了反而会掩盖「某条分支悄悄走了浏览器路径」的问题。

### 一个容易踩的坑：`document.createElement('canvas')` 是引擎的 WebGL 探测入口

`Features.isWebGLAvailable()` 的实现是
`document.createElement('canvas').getContext('webgl')`。
如果给它一个**空壳**对象，返回 null → 引擎判定「浏览器不支持 WebGL」→ 直接不启动，
而报错信息只会说「缺少特性」，看着像小游戏环境的问题。

所以适配层的 `createElement('canvas')` 返回的是 **`tap.createCanvas()` 本身**，
`getContext` 自然是小游戏的真实现。

---

## 自检：没有真机也能先跑一遍

```bash
node tools/smoke.js --web <Web导出目录>
```

它会用 Node 的 `vm` 造一个**真的没有 `document/window/navigator`** 的上下文
（不是把 Node 的全局删掉，而是白名单式只给 ECMAScript 标准 + `tap` mock），然后：

1. 断言初始确实没有 DOM
2. 加载 `tap-adapter.js` → 断言 DOM 假面出现、拿到 `tap.createCanvas`
3. 加载 Godot 的 `index.js` → 断言无 DOM 环境下能加载且 `window.Engine` 挂上
4. 调 `Engine.isWebGLAvailable / isFetchAvailable ...` → 断言不抛
5. 用**适配层自己的 fetch** 取 `index.wasm` 并 `WebAssembly.compile` → 断言 wasm 可编译、`imports` 可读；再取 `index.pck` 断言字节可取

第 5 步是关键：**wasm 编译不过 = 传上去也是黑屏**，这里先拦住。

实测（一个 47MB 的 Godot 4.7.1 项目）：

```
=== SMOKE: 17 PASS / 0 FAIL ===
  [PASS] wasm 编译成功（WebAssembly.Module）
  [PASS] imports 可读出（337 项）
  [PASS] pck 能取到字节（9.28 MB）
```

---

## 体积：平台线和这个工具实测的数

平台线（[引擎接入文档](https://developer.taptap.cn/minigameapidoc/quick-start/guide/performance/)）：
**首包压缩后 < 60MB 是准入，20MB 算优秀**。

Godot 的 `index.wasm` 是**未压缩**的（Web 服务器靠 gzip/brotli 传输层压，小游戏包里没有这一层），
所以打包器对每个条目做 **deflate level 9**：

| | 原始 | 压缩后 |
| --- | --- | --- |
| index.wasm | 37.68 MB | **9.68 MB** |
| index.pck | 9.28 MB | 8.76 MB |
| **首包合计** | 47.59 MB | **18.68 MB** |

一个 47MB 的 Web 导出能落到 18.68MB，进了优秀线。
如果你的项目超 60MB，优先级是：换 `ogg` 音频（不要 `wav`）→ PTEX/ETC2 压缩纹理 → 拆资源按需下载。

---

## 限制（先看清楚再动手）

1. **不支持多线程**。小游戏 VM 没有 `SharedArrayBuffer` 那套。必须用
   `web_nothreads_release` 模板导出（`variant/thread_support=false`）。
   打包器会检查 `GODOT_THREADS_ENABLED`，是 `true` 就直接报错让你重导。
2. **性能约为原生的 1/3**。官方建议：**先导 Web，在手机浏览器里跑一遍**，
   确认能接受再上小游戏。
3. **iOS 内存更紧**。Godot 4 的 wasm 体积本身不小，wasm 超过 10MB 时官方建议上 wasm 分包；
   本工具**还没有做分包**（见 Roadmap）。
4. **没有平台能力对接**。TapTap 登录 / 成就 / 排行榜 / 激励视频都没有桥接 —— 这个工具只解决
   「能不能跑起来」，不解决「能不能用平台 SDK」。Godot 侧目前没有官方 TapTap 小游戏 SDK。
5. **自检 ≠ 真机验证**。`smoke.js` 证明的是**加载链路**（DOM 假面够不够、wasm 能不能编译、
   包能不能读），证明不了**渲染/触摸/音频在真机上的表现**。最后一定要走平台的扫码自测。

---

## 它做了什么、没做什么

**做了**

- 重新组织包结构（`game.js` 入口 / `game.json` 配置 / `project.config.json` 工程描述）
- 运行时 DOM 假面 + canvas 直连 + 触摸事件翻译 + `fetch` 兜底
- 包内 deflate 压缩与首包体积判定
- 无 DOM 沙箱自检

**没做**（有意留白，避免过度承诺）

- 不改 Godot 产物一个字节（`index.js/wasm/pck` 原样搬运，只改名 `index.js → engine.js`）
- 不做 wasm 分包
- 不做 TapTap 平台 SDK 桥接
- 不替你上传（平台上传走开发者中心或用 `taptap-cli upload-mini-app-package`）

---

## 包结构对照

```
小游戏要求（官方）            这个工具产出
├── game.js         入口  →   game.js            （require adapter → engine → startGame）
├── game.json       配置  →   game.json          （deviceOrientation）
└── project.config.json     →   project.config.json
                             tap-adapter.js      （本工具新增：DOM 假面）
                             engine.js           （Godot 的 index.js 改名）
                             index.wasm          （原样）
                             index.pck           （原样）
                             index.audio.*.js    （原样，可选）
                             index.png           （原样，可选）
```

`game.js` 的顺序**不可换**：适配层必须早于 `engine.js` 被 `require`，
因为 Emscripten 胶水层在**加载时**（不是运行时）就会碰 `document`。

---

## Roadmap

- [ ] wasm 分包（`game_wasm_split.zip` 那种），给大项目降首包
- [ ] 音频/纹理在打包阶段自动转档（ogg / ETC2），进一步压首包
- [ ] `game.json` 更多字段（`subPackages` / `networkTimeout`）走参数透传
- [ ] 把 `tap` 的能力包一层极简 JS API（登录/分享/广告）供 Godot 用 `JavaScriptBridge` 调

欢迎 issue / PR。

---

## 许可

MIT。`runtime/tap-adapter.js` 与 `tools/` 全部原创；不含任何 Godot 或 TapTap 的闭源产物。
