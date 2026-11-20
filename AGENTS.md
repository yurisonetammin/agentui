# AGENTS.md — AgentUI 开发与协作指南

本文件为后续接手的 AI Coding Agent 与人类开发者提供代码结构、硬性约束（Invariants）、已解决的 Windows 踩坑点及标准验证流程。开始改动前请同步阅读 [STATUS.md](docs/STATUS.md) 与 [PLAN.md](docs/PLAN.md)。

## 1. 项目定位与技术栈

- **目标**：轻量、完全自主可控的 Codex / DeepSeek Harness (`dsh`) 风格编码 Agent 桌面工作台，支持 **Pi**、**OMP (`oh-my-pi`)**、**Prime Agent** 三引擎原生 RPC，以及经统一传输层桥接的 **Claude Code (`stream-json`)**、**Codex App Server**、**ACP (Agent Client Protocol)**、**dsh (`--profile acp`)** 共 7 引擎自动探测、并发运行与实时代码变更审阅。能力矩阵见 [src/shared/capabilities.ts](src/shared/capabilities.ts)。
- **技术栈**：Electron (`^35.2.0`) + TypeScript (`^5.8.3`) + `electron-vite` (`^3.1.0`) + React (`^19.1.0`) + Vite (`^6.3.5`) + Vitest (`^3.1.3`) + `@tanstack/react-virtual`（时间线/Tool 输出虚拟滚动）+ `highlight.js`（只读文件预览高亮）。
- **重要约束 — 零 C++ 原生模块**：目标开发机当前无 Rust (`rustc`/`cargo`) 与 MSVC Build Tools (`cl.exe`/`link.exe`/Windows SDK)。严禁引入 `node-pty`、`better-sqlite3`、`keytar` 等需要 `node-gyp` 编译的原生依赖；当前内嵌终端为**非 PTY 命令运行器**（见铁律 8），升级 PTY 需确认编译工具链或选用 prebuild 方案（路径见 [docs/PLAN.md](docs/PLAN.md)）。
- **保留目录**：仓库内的 `.workbuddy/` 为用户原有目录，任何任务都**不要删除或修改**。

## 2. 目录与模块映射

| 路径 | 职责 |
| :--- | :--- |
| [electron.vite.config.ts](electron.vite.config.ts) | `main` / `preload`（强制作 CJS `.cjs` 输出）/ `renderer`（环境感知 CSP 注入）构建配置 |
| [src/shared/types.ts](src/shared/types.ts) | Main、Preload、Renderer 共享的 IPC 契约 `AgentUiApi` 与域模型定义 |
| [src/shared/event-reducer.ts](src/shared/event-reducer.ts) | 纯函数 `applyRpcEventToTimeline()`，将 RPC 事件归约成时间线条目 |
| [src/shared/ui-queue.ts](src/shared/ui-queue.ts) | 纯函数多会话 `ExtensionUiRequest` 队列管理 |
| [src/shared/shortcuts.ts](src/shared/shortcuts.ts) | 纯函数全局快捷键匹配与速查清单 `SHORTCUT_HINTS` |
| [src/shared/composer-autocomplete.ts](src/shared/composer-autocomplete.ts) | 纯函数 `@file` / `/slash` 触发检测、路径模糊评分与内置斜杠命令解析 |
| [src/shared/capabilities.ts](src/shared/capabilities.ts) | 7 引擎 × 11 项能力矩阵 `HARNESS_CAPABILITIES` 与桥接限制脚注（设置弹窗展示） |
| [src/shared/tool-policy.ts](src/shared/tool-policy.ts) | 纯函数项目信任策略：`TrustPreset`（只读/审批/自动）、只读命令分类、约 21 条高风险规则、`assessToolRequest` / `decideApproval` / `pickSelectOption` |
| [assets/](assets/) | 应用透明圆角图标资源（`icon.ico` 多分辨率 16–256px、`icon.png` 512px） |
| [electron/main/index.ts](electron/main/index.ts) | Electron 入口、窗口创建与图标绑定、`AppUserModelId`、`sandbox: true`、`.cjs` preload、`will-navigate` 安全拦截、`AGENTUI_STATE_PATH` |
| [electron/main/ipc.ts](electron/main/ipc.ts) | 注册所有 `ipcMain.handle` 路由 |
| [electron/main/store.ts](electron/main/store.ts) | 原子临时文件+重命名持久化的 JSON `StateStore`（默认 `~/.agentui/state.json`） |
| [electron/main/process-utils.ts](electron/main/process-utils.ts) | 7 引擎路径候选表、安全环境变量、`prepareExecutableSpawn()`（Windows `.cmd`/launcher 解析，禁用 `shell: true`）、进程树强杀 |
| [electron/main/discovery.ts](electron/main/discovery.ts) | `HarnessDiscoveryService`，并发 `--version` 探测（兼容 `2.1.325 (Claude Code)` 后缀）及 Prime Rust vs TS 版本分类 |
| [electron/main/model-catalog.ts](electron/main/model-catalog.ts) | 模型目录读取（OMP `omp models --json`，Pi/Prime 有界 RPC `get_available_models`，Claude 内置别名，Codex `model/list`，ACP/dsh 由 Agent 端管理） |
| [electron/main/rpc/jsonl.ts](electron/main/rpc/jsonl.ts) | 严格按 `LF` (`0x0A`) 切分的 UTF-8 解码器 `StrictJsonlDecoder` |
| [electron/main/rpc/chunk-assembly.ts](electron/main/rpc/chunk-assembly.ts) | OMP v2 Base64 `rpc_chunk` 帧重组器 `RpcChunkAssembler` |
| [electron/main/rpc/adapters.ts](electron/main/rpc/adapters.ts) | Pi / OMP / Prime(TS & Rust) 原生 RPC 适配器 + Claude / Codex / ACP / dsh 桥接适配器（`createBridge`），统一命令参数、状态与事件语义 |
| [electron/main/rpc/bridge.ts](electron/main/rpc/bridge.ts) | 统一传输层抽象：`ProtocolBridge` / `BridgeContext` / `BridgeStartInfo` 与 `JsonRpcPeer`（Codex/ACP 用 JSON-RPC 2.0 客户端） |
| [electron/main/rpc/bridges/](electron/main/rpc/bridges/) | `claude.ts`（stream-json + control_request 审批）、`codex.ts`（app-server v2 thread/turn/item）、`acp.ts`（ACP v1，dsh 复用；只读 fs 守卫） |
| [electron/main/rpc/runtime.ts](electron/main/rpc/runtime.ts) | 单会话子进程生命周期、`negotiate_protocol` 握手（原生）或 `bridge.initialize`（桥接）、请求 ID 关联、优雅退出 + `taskkill /T /F` |
| [electron/main/rpc/manager.ts](electron/main/rpc/manager.ts) | `RuntimeManager`，多会话并发隔离进程池、乐观消息插入与时间线缓存；`handleExtensionUiRequest` 按项目信任预设在审批边界拦截 confirm/select（自动放行/拒绝留痕、高风险强制弹窗） |
| [electron/main/sessions/catalog.ts](electron/main/sessions/catalog.ts) | 扫描与回放 CLI 原生 `.jsonl` 历史会话（Pi 风格 + Claude uuid/parentUuid 链，内容嗅探区分）、活跃分支树解析与非破坏性分叉文件生成；桥接引擎会话降级提示 |
| [electron/main/workspace-files.ts](electron/main/workspace-files.ts) | `WorkspaceFileService`：基于 `git ls-files -z`（含非 Git 目录回退）与短缓存的 `@file` 文件索引 |
| [electron/main/workspace-browser.ts](electron/main/workspace-browser.ts) | `WorkspaceBrowserService`：文件树懒加载 listing 与只读预览（路径越界守卫、隐藏目录过滤、512KB 截断、二进制检测、语言识别） |
| [electron/main/terminal-service.ts](electron/main/terminal-service.ts) | `TerminalService`：零原生非 PTY 命令运行器（显式 shell 进程、并发上限 4、10 分钟超时、进程树强杀） |
| [electron/main/browser-companion.ts](electron/main/browser-companion.ts) | `BrowserCompanionService`：ego-browser 探测与快捷控制（临时 `.mjs` + `nodejs -e import`、串行队列、仅 http(s)、stdout/stderr 双流搜结果）、4 类 MCP 配置只读扫描与浏览器型分类 |
| [electron/main/git/git-service.ts](electron/main/git/git-service.ts) | `GitService`：`status -z`、staged/unstaged/untracked diff、Stage/Unstage/Discard/Commit、Worktree 增删 |
| [electron/preload/index.ts](electron/preload/index.ts) | 通过 `contextBridge.exposeInMainWorld('agentui', api)` 暴露只读安全 API |
| [src/renderer/src/App.tsx](src/renderer/src/App.tsx) | 根工作台：事件流订阅、时间线虚拟滚动（react-virtual 动态测高 + 贴底跟随）、`@file`/`/slash` 补全、图片粘贴/拖拽、分叉树与对比、排队式 `ExtensionUiModal`、模型/Thinking 切换、Steer/Follow-up/Abort |
| [src/renderer/src/components/](src/renderer/src/components/) | `Sidebar`（品牌图标、搜索、双击重命名、分叉徽标与项目信任盾牌按钮）、`ComposerAutocomplete`、`ForkTreeModal`（节点树与多分支并排对比）、`DiffPanel`（四页抽屉：变更/Worktrees/文件/终端，防竞态 Diff）、`WorkspaceFilesPanel`（文件树 + highlight.js 只读预览 + `@引用`）、`TerminalPanel`（多运行切换、输出节流缓冲、命令历史）、`MarkdownView`（代码块复制）、`ThinkingBlock`、`ToolCallCard`（>400 行输出虚拟滚动）、`SettingsModal`（引擎路径 + 能力矩阵）、`ShortcutsModal`、`ExtensionUiModal`（高风险红色警告横幅 + 预设徽标）、`ProjectTrustModal`（三预设配置）、`BrowserPanel`（ego 状态 / MCP 列表 / 打开 URL / 标签页 / 截图回贴） |
| [tests/](tests/) | Vitest 单元测试套件（当前 18 个测试文件；`claude-live-handshake.test.ts` 为真实 CLI 集成测试，未安装时自动跳过；`browser-companion.test.ts` 含真实 ego 探测与 `AGENTUI_LIVE_BROWSER=1` 门控的打开/截图端到端用例） |

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
7. **桥接引擎必须转译为规范内部协议**：
   Claude / Codex / ACP / dsh 的原生协议差异只允许存在于 [electron/main/rpc/bridges/](electron/main/rpc/bridges/) 内；桥接器经 `BridgeContext` 的 `respond`（立即应答规范命令，原生长请求自行跟踪）/ `emit`（规范事件）/ `state`（局部状态）与运行时交互。严禁让 `RpcRuntime` / `RuntimeManager` / `event-reducer` / UI 感知具体桥接引擎的线协议。新增引擎时同步更新 `HARNESS_IDS`、`HARNESS_CAPABILITIES` 与适配器表。
8. **内嵌终端保持零原生、非 PTY 实现**：
   `TerminalService` 以显式 shell 进程（Windows `cmd.exe /d /s /c`，POSIX `/bin/sh -c`）执行单条命令，Node `spawn` 本身仍为 `shell: false`。严禁引入 `node-pty` 等需编译依赖；PTY 升级须先确认 prebuild/工具链（见 PLAN.md）。工作区文件访问（`WorkspaceBrowserService` 与 ACP `fs/read_text_file`）必须保留 `isPathInside` 越界守卫，ACP 客户端声明为只读（拒绝 `fs/write_text_file`）。
9. **Claude Code 的 `system/init` 时序**：
   实测 2.1.325 的 `system/init` 在**首条用户消息之后**才发出；启动阶段只有 SessionStart hook 帧（携带 `session_id`）。桥接器对任意 `system` 帧捕获会话 ID，不要假设启动即有 init。Thinking 档位经 `MAX_THINKING_TOKENS` 环境变量在 spawn 时注入，会话内切换需重连生效。
10. **信任策略只在审批边界生效，高风险必须人工确认**：
   策略拦截统一位于 `RuntimeManager.handleExtensionUiRequest`（confirm/select），策略逻辑保持在 [src/shared/tool-policy.ts](src/shared/tool-policy.ts) 纯函数内。任何预设下 `level === 'high'` 都必须弹窗（auto 也不例外）；input/editor 永远交由用户；自动应答失败必须降级为人工弹窗。引擎静默自动执行时无法拦截——不要向用户承诺超出审批层的强制力。
11. **ego-browser 脚本执行约束**：
   经 `BrowserCompanionService` 的临时 `.mjs` 文件 + `ego-browser nodejs -e "await import('file:///...')"` 执行（`shell: false`、超时 `killProcessTree`、串行队列）；URL 必须校验仅 http(s) 且经 `JSON.stringify` 注入，严禁向渲染端暴露任意脚本执行接口。ego-browser（Chromium 系）在管道 stdio 下把脚本 console 输出写到 **stderr**（退出码 0），结果标记必须双流搜索；版本号可为四段（`0.6.3.14`）。

## 4. 常用命令

```bash
npm run typecheck   # tsc --noEmit 检查 node(main/preload/shared/tests) 与 web(renderer)
npm test            # Vitest 单元测试
npm run build       # electron-vite 构建至 out/
npm run dev         # Electron + Vite HMR 开发模式
```
