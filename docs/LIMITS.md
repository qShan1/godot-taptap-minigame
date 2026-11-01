# 已知限制与平台事实

本文件只记**实测/官方原文**的事实，不写推测。来源标注在每条后面。

## 包体积

- 准入：首包**压缩后 < 60MB**；优秀参考 **20MB**。（引擎接入文档 · 阶段四）
- wasm 单独建议 **< 10MB**，超过要开 wasm 分包。（同上）
- **不支持多线程**，性能约原生 1/3。（同上）

## 运行环境

- Android 基于 v8；iOS 基于 WKWebView（对标微信高性能模式），iOS 15.0+ 支持 WebGL 2.0。
- 没有 BOM / DOM，只有 `tap` API。（开发概览）
- 小游戏包必要时文件：`game.js`（入口）/ `game.json`（配置）/ `project.config.json`（工程配置）。
  （开发概览）

## 引擎支持现状

- 官方为 **Unity**（C# SDK + 转换插件）、**Cocos Creator 3.8+**（扩展插件）提供适配。
  文档的「游戏引擎」目录下**没有 Godot 条目**（`node tools/scan-routes` 式的全路由扫描：
  `/dev/engine/` 下仅 `Cocos-Laya-Egret` 与 `unity-adaptation`）。
- 因此本工具是在做**社区适配**：自己补 DOM 假面，而不是等官方 SDK。

## 本工具没解决的

1. TapTap 平台能力（登录/成就/排行榜/广告/支付）未桥接 —— Godot 侧无官方 SDK。
2. wasm 分包未实现。
3. 真机渲染/触摸/音频的最终表现只能靠平台扫码自测确认。
