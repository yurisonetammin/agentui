# AGENTS.md — AgentUI 开发与协作指南

本文件为后续接手的 AI Coding Agent 与人类开发者提供代码结构、硬性约束（Invariants）、已解决的 Windows 踩坑点及标准验证流程。开始改动前请同步阅读 [STATUS.md](docs/STATUS.md) 与 [PLAN.md](docs/PLAN.md)。

## 1. 项目定位与技术栈

- **目标**：轻量、完全自主可控的 Codex / DeepSeek Harness (`dsh`) 风格编码 Agent 桌面工作台，核心优先支持 **Pi**、**OMP (`oh-my-pi`)**、**Prime Agent** 三引擎自动探测、并发运行与实时代码变更审阅。
- **技术栈**：Electron (`^35.2.0`) + TypeScript (`^5.8.3`) + `electron-vite` (`^3.1.0`) + React (`^19.1.0`) + Vite (`^6.3.5`) + Vitest (`^3.1.3`)。
- **重要约束 — 零 C++ 原生模块**：目标开发机当前无 Rust (`rustc`/`cargo`) 与 MSVC Build Tools (`cl.exe`/`link.exe`/Windows SDK)。Phase 1 严禁引入 `node-pty`、`better-sqlite3`、`keytar` 等需要 `node-gyp` 编译的原生依赖；终端能力如在 Phase 2 引入，需确认编译工具链或选用 prebuild 方案。
- **保留目录**：仓库内的 `.workbuddy/` 为用户原有目录，任何任务都**不要删除或修改**。

## 2. 目录与模块映射

| 路径 | 职责 |
| :--- | :--- |
| [electron.vite.config.ts](electron.vite.config.ts) | `main` / `preload`（强制作 CJS `.cjs` 输出）/ `renderer`（环境感知 CSP 注入）构建配置 |
| [src/shared/types.ts](src/shared/types.ts) | Main、Preload、Renderer 共享的 IPC 契约 `AgentUiApi` 与域模型定义 |
| [src/shared/event-reducer.ts](src/shared/event-reducer.ts) | 纯函数 `applyRpcEventToTimeline()`，将 RPC 事件归约成时间线条目 |
| [src/shared/ui-queue.ts](src/shared/ui-queue.ts) | 纯函数多会话 `ExtensionUiRequest` 队列管理 |
| [src/shared/shortcuts.ts](src/shared/shortcuts.ts) | 纯函数全局快捷键匹配与速查清单 `SHORTCUT_HINTS` |
| [assets/](assets/) | 应用透明圆角图标资源（`icon.ico` 多分辨率 16–256px、`icon.png` 512px） |
| [electron/main/index.ts](electron/main/index.ts) | Electron 入口、窗口创建与图标绑定、`AppUserModelId`、`sandbox: true`、`.cjs` preload、`will-navigate` 安全拦截、`AGENTUI_STATE_PATH` |
| [electron/main/ipc.ts](electron/main/ipc.ts) | 注册所有 `ipcMain.handle` 路由 |
| [electron/main/store.ts](electron/main/store.ts) | 原子临时文件+重命名持久化的 JSON `StateStore`（默认 `~/.agentui/state.json`） |
| [electron/main/process-utils.ts](electron/main/process-utils.ts) | 三引擎路径候选表、安全环境变量、`prepareExecutableSpawn()`（Windows `.cmd`/launcher 解析，禁用 `shell: true`）、进程树强杀 |
| [electron/main/discovery.ts](electron/main/discovery.ts) | `HarnessDiscoveryService`，并发 `--version` 探测及 Prime Rust vs TS 版本分类 |
| [electron/main/model-catalog.ts](electron/main/model-catalog.ts) | 模型目录读取（OMP `omp models --json`，Pi/Prime 有界 RPC `get_available_models`） |
| [electron/main/rpc/jsonl.ts](electron/main/rpc/jsonl.ts) | 严格按 `LF` (`0x0A`) 切分的 UTF-8 解码器 `StrictJsonlDecoder` |
| [electron/main/rpc/chunk-assembly.ts](electron/main/rpc/chunk-assembly.ts) | OMP v2 Base64 `rpc_chunk` 帧重组器 `RpcChunkAssembler` |
| [electron/main/rpc/adapters.ts](electron/main/rpc/adapters.ts) | Pi / OMP / Prime(TS & Rust) 四套 RPC 适配器，统一命令参数、状态与事件语义 |
| [electron/main/rpc/runtime.ts](electron/main/rpc/runtime.ts) | 单会话子进程生命周期、`negotiate_protocol` 握手、请求 ID 关联、优雅退出 + `taskkill /T /F` |
| [electron/main/rpc/manager.ts](electron/main/rpc/manager.ts) | `RuntimeManager`，多会话并发隔离进程池、乐观消息插入与时间线缓存 |
| [electron/main/sessions/catalog.ts](electron/main/sessions/catalog.ts) | 扫描与回放 CLI 原生 `.jsonl` 历史会话 |
| [electron/main/git/git-service.ts](electron/main/git/git-service.ts) | `GitService`：`status -z`、staged/unstaged/untracked diff、Stage/Unstage/Discard/Commit、Worktree 增删 |
| [electron/preload/index.ts](electron/preload/index.ts) | 通过 `contextBridge.exposeInMainWorld('agentui', api)` 暴露只读安全 API |
| [src/renderer/src/App.tsx](src/renderer/src/App.tsx) | 根工作台：事件流订阅、排队式 `ExtensionUiModal`、模型/Thinking 切换、Steer/Follow-up/Abort |
| [src/renderer/src/components/](src/renderer/src/components/) | `Sidebar`（品牌图标、搜索、双击重命名与快捷键入口）、`DiffPanel`（防竞态 Diff + Worktree）、`MarkdownView`（代码块复制）、`ThinkingBlock`、`ToolCallCard`、`SettingsModal`、`ShortcutsModal`、`ExtensionUiModal` |
| [tests/](tests/) | Vitest 单元测试套件（当前 9 个测试文件） |

## 3. 核心工程铁律（修改代码时严禁破坏）

1. **Preload 必须编译为 CommonJS (`.cjs`)**：
   `package.json` 声明了 `"type": "module"`。若不显式在 `electron.vite.config.ts` 中指定 `preload.build.rollupOptions.output = { format: 'cjs', entryFileNames: '[name].cjs' }`，产物会变成 `.mjs`，在 `sandbox: true` 下会导致 `window.agentui` 加载失败。
2. **生产 CSP 必须在 Vite `transformIndexHtml` 中注入**：
   Chromium 的 `webRequest.onHeadersReceived` 无法作用于打包后的 `file://` 页面，因此 CSP 在 `electron.vite.config.ts` 的 `rendererCspPlugin()` 注入：开发期 (`ctx.server`) 允许 Vite HMR / React Refresh；生产构建严格限制 `script-src 'self'`。同时主进程配置了 `will-navigate` 与 `setWindowOpenHandler` 防护。
3. **严禁使用 Node `readline` 解析 RPC JSONL**：
   `readline` 会把 JSON 字符串里的 `U+2028` / `U+2029` 当作换行符截断帧。必须继续使用 [electron/main/rpc/jsonl.ts](electron/main/rpc/jsonl.ts) 的 `StrictJsonlDecoder`（仅按 `0x0A` 切分，最大帧 16 MiB 保护）。
4. **严禁使用 `shell: true` 拉起 Agent CLI 或 Git**：
   所有子进程必须经 [electron/main/process-utils.ts](electron/main/process-utils.ts) 解析后以 `shell: false` 启动：
   - **Pi**：支持官方 Windows 受管安装器（`pi.cmd` -> `install/current-version` -> `node.exe` + `dist/bundle/cli.js`）及 `pi-launcher.js` / npm shim。注意 Pi **没有** `--cwd` 参数，工作目录通过 `spawn(..., { cwd })` 传递。
   - **Prime Agent**：`prime-agent.cmd` 自动解析为 `..\share\prime-agent\prime-agent.exe`；0.9.9+/0.10.x Rust 版拒绝 `--extension`，不支持 `extension_ui_response`，失败信息位于 `agent_end.messages` 末尾 assistant 的 `stopReason === 'error'`。
5. **OMP 的 `PI_CONFIG_DIR` 陷阱**：
   OMP 18.x 会把环境变量 `PI_CONFIG_DIR` 拼接到 `homedir()` 下；Windows 上若系统设置了绝对路径（如 `D:\Tools\Apps\oh-my-pi\config`），会引发 `ENOENT: mkdir 'C:\Users\...\D:\...'`。必须保留 `harnessChildEnvironment('omp', ...)` 删除绝对 `PI_CONFIG_DIR` 并固定 `PI_CODING_AGENT_DIR` 的逻辑。
6. **测试隔离环境变量**：
   主进程初始化 `StateStore` 时读取 `process.env.AGENTUI_STATE_PATH`，跑自动化冒烟脚本时请务必指定临时路径，避免污染用户 `~/.agentui/state.json`。

## 4. 常用命令

```bash
npm run typecheck   # tsc --noEmit 检查 node(main/preload/shared/tests) 与 web(renderer)
npm test            # Vitest 单元测试
npm run build       # electron-vite 构建至 out/
npm run dev         # Electron + Vite HMR 开发模式
```
