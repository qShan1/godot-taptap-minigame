# 用法示例

## 1. 最小可用（无头导出 → 打包 → 自检）

```bash
# 在 Godot 项目根
godot --headless --path . --export-release "Web" build/web/index.html

# 转小游戏包
node tools/build.js --web ./build/web --out ./build/minigame.zip --name "我的游戏"

# 本地自检（不需要真机）
node tools/smoke.js --web ./build/web
```

## 2. 只出目录，改完再打

```bash
node tools/build.js --web ./build/web --out ./build/minigame/ --no-zip
# ……改 game.json / 换适配层……
node tools/build.js --web ./build/web --out ./build/minigame.zip --name "我的游戏"
```

## 3. 只评估体积，不写文件

```bash
node tools/build.js --web ./build/web --scan
```

输出会告诉你卡在哪：`✓ 优秀(<20M)` / `⚠ 过准入但未进优秀线` / `✗ 超 60M`。

## 4. 上传

开发者中心 → 包体管理 → 开发版本 → 上传 zip → 扫码自测。
或者 CLI：

```bash
taptap-cli upload-mini-app-package ./build/minigame.zip --app-id <appId> --dev-id <devId> --yes
```

## 5. Godot 导出设置对照

| 设置 | 值 | 为什么 |
| --- | --- | --- |
| 渲染器 | `gl_compatibility` | 小游戏走 WebGL2/GLES，Forward+ 用不了 |
| Web 预设 `variant/thread_support` | `false` | 小游戏不支持多线程 |
| 导出模板 | `web_nothreads_release.zip` | 同上 |
| 音频 | 优先 `ogg` | `wav` 在 Web 里不压缩，直接吃首包 |
