# AgentUI 开发进展与变更记录 (STATUS)

最后更新：2026-11-20

## 1. 当前进度总览

- **当前阶段**：**Phase 1 MVP + 第 1 步（图标/快捷键/断线重连）+ 第 2 步（`@file` / `/slash` / 图片粘贴 / 会话分叉对比）已全部完成并通过实窗验证**（具体观察指标见第 5 节）。
- **架构路线确认**：
  - 从空项目目录开始构建自主可控的编码工作台；
  - 经环境检查本机无 Rust (`rustc`/`cargo`) 与 MSVC Build Tools (`cl.exe`/`link.exe`) 后，确认采用 **Electron 35 + TypeScript + React 19 + `electron-vite`**（零原生 C++ 插件）。

## 2. 本阶段关键修正与增强 (2026-11-19)

| 类别 | 变更文件 | 说明 |
| :--- | :--- | :--- |
| **修复 Preload 与沙箱不兼容** | [electron.vite.config.ts](electron.vite.config.ts), [electron/main/index.ts](electron/main/index.ts) | 因 `package.json` 启用 `"type": "module"`，原默认产物 `index.mjs` 无法在 `sandbox: true` 下执行；现强制编译为 CommonJS `out/preload/index.cjs` 并对齐加载路径。 |
| **修复 Dev/Prod CSP 冲突** | [electron.vite.config.ts](electron.vite.config.ts), [src/renderer/index.html](src/renderer/index.html) | 将静态 `<meta http-equiv="Content-Security-Policy">` 改为 Vite 插件按环境注入：Dev 模式放行 Vite HMR / React Refresh；Prod 构建严格 `script-src 'self'`（适配 `file://` 协议）。 |
| **主进程安全与测试隔离** | [electron/main/index.ts](electron/main/index.ts) | 新增 `will-navigate` 导航白名单拦截外跳；支持 `AGENTUI_STATE_PATH` 环境变量覆盖状态文件路径。 |
| **修复运行中状态被局部更新误重置** | [electron/main/rpc/manager.ts](electron/main/rpc/manager.ts) | `onStateChange` 仅在显式携带 `isStreaming` / `isCompacting` 时变更运行状态，`contextUsage` / `statusText` / `thinkingLevel` 等局部更新不再把 `'streaming'` / `'waiting_ui'` 误翻回 `'idle'`。 |
| **避免重复探测 CLI 与缓存泄漏** | [electron/main/rpc/manager.ts](electron/main/rpc/manager.ts), [electron/main/ipc.ts](electron/main/ipc.ts) | `startRuntime` 优先复用 `discovery.snapshot()` 缓存，仅在目标引擎未就绪时重新探测；新增 `removeThread()` 在删除会话/移除项目时同步释放内存时间线缓存。 |
| **多线程并发 UI 审批队列** | [src/shared/ui-queue.ts](src/shared/ui-queue.ts), [src/renderer/src/App.tsx](src/renderer/src/App.tsx), [src/renderer/src/components/ExtensionUiModal.tsx](src/renderer/src/components/ExtensionUiModal.tsx) | 将单一 `pendingUi` 改为 FIFO 队列，并展示请求来源引擎/会话标题及待确认数量，在 `runtime_exit` / `abortThread` / `deleteThread` / `removeProject` 时自动清理过期项；以 `request.id` 作为 Modal `key` 确保状态重置。 |
| **修复 Diff 竞态与 Worktree 联动** | [src/renderer/src/components/DiffPanel.tsx](src/renderer/src/components/DiffPanel.tsx), [src/renderer/src/App.tsx](src/renderer/src/App.tsx) | 提升 `diffPanelTab` 受控状态，Composer 的 `Worktree` 按钮直达 `Worktrees` 标签页；新增请求序号校验消除快速切换目录/文件导致的旧 Diff 覆盖；Worktree 卡片新增当前标识与一键「新对话」按钮。 |
| **MVP 体验打磨** | [Sidebar.tsx](src/renderer/src/components/Sidebar.tsx), [MarkdownView.tsx](src/renderer/src/components/MarkdownView.tsx), [styles.css](src/renderer/src/styles.css) | 侧栏增加项目/会话/分支实时搜索过滤与会话双击内联重命名；Markdown 代码块右上角增加复制按钮；Topbar 展示扩展状态文本及完整异常 `.catch` 反馈。 |
| **自定义应用图标（方案 D 三引擎编织核）** | [assets/icon.ico](assets/icon.ico), [assets/icon.png](assets/icon.png), [brand-icon.png](src/renderer/src/assets/brand-icon.png), [electron/main/index.ts](electron/main/index.ts), [Sidebar.tsx](src/renderer/src/components/Sidebar.tsx) | 裁切超椭圆透明圆角，生成 7 档分辨率 `.ico`（16–256px）及 `.png`；接入 `BrowserWindow` 图标与 Windows `AppUserModelId`、替换侧栏品牌图标，并更新桌面 `AgentUI.lnk` 快捷方式图标。 |
| **全局与输入框快捷键 + 速查面板** | [src/shared/shortcuts.ts](src/shared/shortcuts.ts), [ShortcutsModal.tsx](src/renderer/src/components/ShortcutsModal.tsx), [App.tsx](src/renderer/src/App.tsx) | 新增 `Ctrl+N` / `Ctrl+K` / `Ctrl+L` / `Ctrl+1~3` / `Ctrl+Shift+D` / `Ctrl+Shift+W` / `Ctrl+,` / `Ctrl+/` / `Esc` 全局快捷键，及输入框 `Ctrl+Enter`（Steer 引导）与空输入 `↑` 回填上条指令；提供快捷键速查弹窗并避开中文 IME 组合键与内联重命名冲突。 |
| **子进程意外退出断线重连与一键重试** | [runtime.ts](electron/main/rpc/runtime.ts), [manager.ts](electron/main/rpc/manager.ts), [event-reducer.ts](src/shared/event-reducer.ts), [ipc.ts](electron/main/ipc.ts), [preload/index.ts](electron/preload/index.ts), [App.tsx](src/renderer/src/App.tsx) | 区分主动停止与意外退出（标记运行中工具失败、追加断线提示、`status: 'disconnected'` + `RuntimeDisconnectInfo`），新增 `reconnectThread` / `retryLastPrompt` IPC 与输入框上方恢复横幅（含可折叠 stderr 日志、重新连接与重试上一条指令）。 |
| **`@file` 工作区文件模糊引用与 `/` 斜杠命令补全** | [composer-autocomplete.ts](src/shared/composer-autocomplete.ts), [workspace-files.ts](electron/main/workspace-files.ts), [ComposerAutocomplete.tsx](src/renderer/src/components/ComposerAutocomplete.tsx), [manager.ts](electron/main/rpc/manager.ts), [App.tsx](src/renderer/src/App.tsx) | 基于 `git ls-files -z`（含非 Git 目录回退与 6s 缓存）提供 `@file` 模糊补全；合并内置工作台命令（`/compact`、`/fork`、`/clone`、`/new`、`/thinking`、`/diff`、`/worktree`、`/reconnect`、`/retry`、`/shortcuts`、`/settings`）与引擎原生 `get_commands`（Skill/模板/扩展）补全，支持 `↑↓`/`Tab`/`Enter`/`Esc` 键盘操作。 |
| **图片粘贴、拖拽与多模态发送** | [types.ts](src/shared/types.ts), [event-reducer.ts](src/shared/event-reducer.ts), [catalog.ts](electron/main/sessions/catalog.ts), [manager.ts](electron/main/rpc/manager.ts), [App.tsx](src/renderer/src/App.tsx) | 支持 `Ctrl+V` 剪贴板截图粘贴、拖拽图片与选择器上传（单条最多 4 张、单张 10MB 上限），缩略图预览与点击放大灯箱，按标准 RPC `ImageContent`（`{ type: 'image', data, mimeType }`）随 `prompt`/`steer`/`follow_up` 发送并在时间线与历史会话回放中持久显示。 |
| **会话分叉树与一题多解并行对比** | [catalog.ts](electron/main/sessions/catalog.ts), [manager.ts](electron/main/rpc/manager.ts), [ForkTreeModal.tsx](src/renderer/src/components/ForkTreeModal.tsx), [Sidebar.tsx](src/renderer/src/components/Sidebar.tsx), [App.tsx](src/renderer/src/App.tsx) | 解析 `.jsonl` 会话活跃分支树并融合 `get_fork_messages` / OMP `get_branch_messages`；支持任意用户提问节点「从此处分叉对比」（非破坏性生成带 `parentSession` 的新 `.jsonl` 分支，可跨 Pi/OMP/Prime 引擎切换并自动回填原提问）与「原地分叉」（原生 `fork`/`branch` RPC），内置多分支并排对比视图展示模型、Tool 次数、Token/费用与最新回复。 |
| **完善团队与 Agent 文档** | [AGENTS.md](AGENTS.md), [docs/PLAN.md](docs/PLAN.md), [docs/STATUS.md](docs/STATUS.md), [README.md](README.md) | 沉淀架构图、核心不变量、Windows 代理/镜像安装说明与分阶段路线图。 |

## 3. 已完成文件清单

- **配置、资源与文档**：`package.json`、`tsconfig.json`、`tsconfig.node.json`、`tsconfig.web.json`、`electron.vite.config.ts`、`vitest.config.ts`、`assets/{icon.ico,icon.png}`、`AGENTS.md`、`README.md`、`docs/PLAN.md`、`docs/STATUS.md`
- **共享层 (`src/shared/`)**：`types.ts`、`event-reducer.ts`、`ui-queue.ts`、`shortcuts.ts`、`composer-autocomplete.ts`
- **主进程 (`electron/main/`)**：`index.ts`、`ipc.ts`、`store.ts`、`discovery.ts`、`model-catalog.ts`、`process-utils.ts`、`workspace-files.ts`、`git/git-service.ts`、`sessions/catalog.ts`、`rpc/jsonl.ts`、`rpc/chunk-assembly.ts`、`rpc/adapters.ts`、`rpc/runtime.ts`、`rpc/manager.ts`
- **预加载 (`electron/preload/`)**：`index.ts`、`index.d.ts`
- **渲染端 (`src/renderer/`)**：`index.html`、`src/main.tsx`、`src/App.tsx`、`src/styles.css`、`src/assets/brand-icon.png`、`src/components/{Sidebar,ComposerAutocomplete,ForkTreeModal,DiffPanel,MarkdownView,ThinkingBlock,ToolCallCard,ExtensionUiModal,SettingsModal,ShortcutsModal}.tsx`
- **单元测试 (`tests/`)**：`adapters.test.ts`、`chunk-assembly.test.ts`、`composer-autocomplete.test.ts`、`event-reducer.test.ts`、`git-service.test.ts`、`jsonl.test.ts`、`process-utils.test.ts`、`shortcuts.test.ts`、`store-and-sessions.test.ts`、`ui-queue-and-manager.test.ts`、`workspace-files-and-fork.test.ts`

## 4. 已踩过的 Windows 环境坑（供后续参考）

1. **Electron 安装下载失败**：国内网络环境下直接 `npm install` 时 `electron/install.js` 可能触发 `RequestError` / `ReadError`。解决方式为配置代理环境变量或 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`，必要时校验 SHA-256 后手动解压至 `node_modules/electron/dist` 并写入 `path.txt`。
2. **Windows Shim 启动无须 `cmd.exe`**：官方受管安装的 `pi.cmd` 会读取 `install/current-version` 并引导至 `dist/bundle/cli.js`，`prime-agent.cmd` 则指向 `..\share\prime-agent\prime-agent.exe`。直接解析目标并设 `shell: false` 可彻底规避命令注入与 `stdin` 转发问题。
3. **OMP `PI_CONFIG_DIR` 绝对路径崩溃**：本机系统变量包含 `PI_CONFIG_DIR=D:\Tools\Apps\oh-my-pi\config`，OMP 18.x 会按相对路径拼接到 `%USERPROFILE%` 下导致 `mkdir ENOENT`。已在 `harnessChildEnvironment('omp', ...)` 中自动剔除并钉死 `PI_CODING_AGENT_DIR`。

## 5. 验证记录

### 5.1 真实 CLI 引擎端到端握手（前期已跑通）

- `Pi (1.5.2)`：探测位置 `D:\Tools\Apps\pi\agent\bin\pi.cmd`，识别 **93** 个模型，RPC `handshake()` 成功。
- `OMP (18.18.9)`：探测位置 `D:\Tools\Apps\oh-my-pi\bin\omp.exe`，识别 **65** 个模型，Protocol v2 `negotiate_protocol` + `handshake()` 成功。
- `Prime Agent (0.10.3, rust)`：探测位置 `D:\Tools\Apps\prime-agent\bin\prime-agent.cmd`，识别 **66** 个模型，RPC `handshake()` 成功。

### 5.2 最新构建、单测与 Electron 实窗冒烟结果

- `npm run typecheck`：通过（exit 0，`tsconfig.node.json` 与 `tsconfig.web.json` 零错误）。
- `npm test`：通过（**11 个测试文件、33 个用例全部通过、0 跳过**，耗时 2.29s）。
- `npm run build`：通过，生成 `out/main/index.js`（124.79 kB）、CommonJS `out/preload/index.cjs`（3.96 kB）、`out/renderer/index.html`（含生产 CSP `script-src 'self'`）及 `brand-icon` 等前端资源包。
- Electron 实窗启动冒烟（`electron.exe` + 隔离 `AGENTUI_STATE_PATH`）：通过（exit 0，`ok: true`，`window.agentui` 成功挂载 **38 个 IPC 方法**含 `listWorkspaceFiles` / `getThreadCommands` / `getThreadForkTree` / `forkThread`，真实仓库 `listWorkspaceFiles('App')` 精准首位命中 `src/renderer/src/App.tsx`，输入框键入 `/fo` 弹出 `.autocomplete-popover`，Pi 1.5.2 / OMP 18.18.9 / Prime Agent 0.10.3 rust 就绪，`.brand-icon` 与 `Ctrl+/`/`Esc` 快捷键弹窗验证通过，Renderer 控制台 0 error / 0 warning / 0 page failure）。
