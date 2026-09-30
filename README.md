# 端口管理 / Port Manager

CC GUI 插件：按工作区/进程分组展示本机监听中的 TCP 端口，支持一键打开浏览器和关闭端口。

A CC GUI plugin that lists local listening TCP ports grouped by workspace (process cwd) or process name, with one-click "open in browser" and "close port" actions.

## 功能 / Features

- ⚡ 状态栏实时显示监中端口数，点击直达端口页签（5 秒自动刷新）
- 📁 按工作区分组（取进程工作目录的目录名）；无法定位 cwd 的归入「外部端口」
- 🔗 每个端口一键在浏览器打开 `http://localhost:<port>`
- 🛑 关闭端口（结束监听进程），两段式确认防误杀
- 🌍 自动适配 macOS / Linux / Windows，界面支持中文 / English

| 能力 | macOS | Linux | Windows |
|---|---|---|---|
| 列端口 | `lsof` | `lsof`，缺失时回落 `ss -tlnp` | `netstat -ano` + `tasklist` |
| 分组依据 | 进程 cwd | 有 lsof → cwd；无 → 进程名 | 进程名 |
| 打开浏览器 | `open` | `xdg-open` | `cmd /c start` |
| 关闭端口 | `kill -TERM` | `kill -TERM` | `taskkill /T /F` |

## 权限说明 / Permissions

本插件**不发起任何网络请求**，所有数据均来自本机命令输出，仅在本地渲染：

| 权限 | 用途 |
|---|---|
| `ui:center-tab` / `ui:status-bar` / `ui:command` | 端口页签、状态栏计数 chip、命令面板入口 |
| `storage` | 持久化分组折叠状态（键 `collapsed`，仅存组名布尔值） |
| `exec:uname` | 探测操作系统平台 |
| `exec:lsof` / `exec:ss` | 列出监听端口与进程 cwd（macOS/Linux） |
| `exec:netstat` / `exec:tasklist` | 列出监听端口与进程名（Windows） |
| `exec:open` / `exec:xdg-open` / `exec:cmd` | 调用系统默认浏览器打开 localhost 地址 |
| `exec:kill` / `exec:taskkill` | 结束所选端口的监听进程 |

数据去向：所有命令输出仅在插件内存中解析展示；唯一持久化数据是分组折叠状态（经 `ctx.storage`，随插件卸载 30 天后清理）。无遥测、无上报。

## 安装 / Install

**市场**：CC GUI → 插件 → 搜索「端口管理」。

**本地**：CC GUI → 插件 → 从本地目录安装 → 选择本仓库根目录（含 `manifest.json`）。

## 开发 / Development

纯单文件 ESM（`main.js`），无第三方依赖、无构建步骤；`node --check main.js` 即可校验语法。

发版：`manifest.json` 的 `version` 改好后打同名 tag（无 `v` 前缀）推送，GitHub Action 会把 `main.js` 与 `manifest.json` 附加到对应 Release。

## License

MIT
