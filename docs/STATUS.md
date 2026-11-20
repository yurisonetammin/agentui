# AgentUI 开发进展与变更记录 (STATUS)

最后更新：2026-11-21

## 1. 当前进度总览

- **当前阶段**：**Phase 1 MVP + 第 1 步（图标/快捷键/断线重连）+ 第 2 步（`@file` / `/slash` / 图片粘贴 / 会话分叉对比）+ Phase 2（多协议桥接扩展 + 工作区文件树/终端 + 虚拟滚动）+ Phase 3 第 1/2 项（项目信任与工具权限策略 + ego-browser / 浏览器型 MCP 协同）已全部完成并通过实窗验证**（具体观察指标见第 5 节）。
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

## 2.5 Phase 2 关键变更 (2026-11-20)

| 类别 | 变更文件 | 说明 |
| :--- | :--- | :--- |
| **统一传输层抽象** | [rpc/bridge.ts](electron/main/rpc/bridge.ts), [rpc/runtime.ts](electron/main/rpc/runtime.ts), [rpc/adapters.ts](electron/main/rpc/adapters.ts), [rpc/manager.ts](electron/main/rpc/manager.ts) | 新增 `ProtocolBridge` / `BridgeContext` / `JsonRpcPeer` 抽象：桥接器把原生协议转译为内部 Pi 风格 JSONL 词汇（命令立即 `respond`、事件 `emit`、状态 `state`），`RpcRuntime` 在 spawn 后按适配器 `createBridge` 走桥接握手/帧分发/UI 审批路由，其余运行时机制（pending 关联、时间线缓存、断线重连）保持引擎无关。 |
| **Claude Code 接入** | [rpc/bridges/claude.ts](electron/main/rpc/bridges/claude.ts), [model-catalog.ts](electron/main/model-catalog.ts), [sessions/catalog.ts](electron/main/sessions/catalog.ts) | `stream-json` 双向协议：`content_block_*` 流式增量 → `message_update`；`assistant`/`user(tool_result)` → `message_end`/`tool_execution_end`；`control_request can_use_tool` ↔ 审批弹窗 allow/deny；interrupt/set_model 控制请求；`MAX_THINKING_TOKENS` 映射 Thinking 档位；内置 sonnet/opus/haiku 模型别名目录；历史回放按内容嗅探识别 Claude `.jsonl` 并重建 uuid/parentUuid 活跃链（含图片与 tool_result 回填）。实测 2.1.325 的 `system/init` 在首条用户消息后才发出，SessionStart hook 帧提前携带 `session_id`，桥接器两者均捕获。 |
| **Codex App Server 接入（实验性）** | [rpc/bridges/codex.ts](electron/main/rpc/bridges/codex.ts), [model-catalog.ts](electron/main/model-catalog.ts) | app-server v2 JSON-RPC：initialize→initialized→thread/start\|resume→turn/start\|steer；item/turn 通知 → 规范事件；命令/文件变更审批 → confirm 弹窗 `{decision}`；tokenUsage → 上下文统计；图片落盘为 `localImage`；`model/list` 动态模型目录。**本机未安装 Codex CLI，未端到端验证。** |
| **ACP / dsh 接入（实验性）** | [rpc/bridges/acp.ts](electron/main/rpc/bridges/acp.ts), [rpc/adapters.ts](electron/main/rpc/adapters.ts) | ACP v1：initialize→session/new\|load（loadSession 能力时回放历史）；`session/prompt` 长请求独立跟踪、规范命令立即应答；`session/update` 全类型映射；`session/request_permission` → select 弹窗；`fs/read_text_file` 仅限工作区内（越界 -32602）、`fs/write_text_file` 一律拒绝（只读客户端）；gemini/qwen 自动加 `--experimental-acp`，dsh 走 `--profile acp`。**本机未安装对应 CLI，未端到端验证。** |
| **引擎能力矩阵** | [src/shared/capabilities.ts](src/shared/capabilities.ts), [SettingsModal.tsx](src/renderer/src/components/SettingsModal.tsx) | 7 引擎 × 11 能力（✓/◐/—）静态矩阵 + 桥接引擎限制脚注，设置弹窗宽版展示。 |
| **工作区文件树 + 只读高亮预览** | [workspace-browser.ts](electron/main/workspace-browser.ts), [WorkspaceFilesPanel.tsx](src/renderer/src/components/WorkspaceFilesPanel.tsx), [DiffPanel.tsx](src/renderer/src/components/DiffPanel.tsx) | 右侧抽屉新增「文件」页（`Ctrl+Shift+E`）：懒加载目录树（隐藏 `.git`/`node_modules`/`.workbuddy` 等噪声目录、目录优先排序、2000 条上限）、highlight.js 高亮预览（512KB 截断、二进制检测、防竞态请求序号）、一键 `@引用` 回注输入框。 |
| **零原生内嵌终端** | [terminal-service.ts](electron/main/terminal-service.ts), [TerminalPanel.tsx](src/renderer/src/components/TerminalPanel.tsx) | 右侧抽屉新增「终端」页（`Ctrl+Shift+T`）：非 PTY 命令运行器（显式 `cmd.exe /d /s /c` 或 `/bin/sh -c`，Node spawn 保持 `shell:false`），并发上限 4、10 分钟超时、进程树强杀、120ms 输出缓冲节流、300k 字符头部裁剪、命令历史与多运行切换；文件/终端面板常挂载隐藏，切页不丢树状态与运行中命令。PTY 升级路径见 PLAN.md。 |
| **虚拟滚动性能优化** | [App.tsx](src/renderer/src/App.tsx), [ToolCallCard.tsx](src/renderer/src/components/ToolCallCard.tsx) | 时间线改用 `@tanstack/react-virtual` 动态测高虚拟滚动（overscan 6 + 贴底跟随，距底 <80px 自动吸附）；Tool 输出 >400 行按 17px 行高虚拟渲染（横向 max-content 滚动），参数 >20k 字符截断提示。 |
| **探测与文案修正** | [discovery.ts](electron/main/discovery.ts), [index.html](src/renderer/index.html), [index.ts](electron/main/index.ts) | `parseHarnessVersion` 反向扫描 token，兼容 `2.1.325 (Claude Code)` 后缀；窗口/页面标题更新为「多引擎编码 Agent 工作台」。 |

## 2.6 Phase 3 关键变更 (2026-11-21)

| 类别 | 变更文件 | 说明 |
| :--- | :--- | :--- |
| **项目信任预设与策略引擎** | [src/shared/tool-policy.ts](src/shared/tool-policy.ts), [rpc/manager.ts](electron/main/rpc/manager.ts), [store.ts](electron/main/store.ts), [ipc.ts](electron/main/ipc.ts), [types.ts](src/shared/types.ts) | 纯函数策略模块：`TrustPreset`（只读观察/写操作需审批/自动模式）、保守只读命令分类（拒绝链式/重定向/命令替换，git/npm 只读子命令白名单）、约 21 条高风险规则、`decideApproval` 决策矩阵与 select 选项匹配（中英文）。`RuntimeManager.handleExtensionUiRequest` 在审批边界统一拦截：只读自动放行/拒绝（时间线 notify 留痕）、自动模式放行常规操作但高风险仍弹窗、input/editor 始终交用户、自动应答失败降级人工弹窗。新增 `projects:setTrust` IPC，`ProjectEntry.trustPreset` 持久化并在加载时归一化（默认 approval）。 |
| **高风险审批警告 UI** | [ProjectTrustModal.tsx](src/renderer/src/components/ProjectTrustModal.tsx), [Sidebar.tsx](src/renderer/src/components/Sidebar.tsx), [ExtensionUiModal.tsx](src/renderer/src/components/ExtensionUiModal.tsx), [App.tsx](src/renderer/src/App.tsx) | 侧栏每个项目新增盾牌按钮（只读绿盾/审批灰盾/自动黄盾）打开信任配置弹窗（三预设单选 + 说明 + 拦截边界提示）；审批弹窗高风险时展示红色警告横幅与命中原因列表，并显示当前项目预设徽标。 |
| **修复 activeHarness 重载丢失** | [store.ts](electron/main/store.ts) | 旧归一化只接受 omp/prime，重启后 claude/codex/acp/dsh 被重置为 pi；改为按 `HARNESS_IDS` 全集校验。 |
| **浏览器协同服务** | [browser-companion.ts](electron/main/browser-companion.ts), [ipc.ts](electron/main/ipc.ts), [index.ts](electron/main/index.ts), [preload/index.ts](electron/preload/index.ts) | `BrowserCompanionService`：ego-browser 探测（PATH + `~/.local/share/ego/active_version_dir`，`--version` 60s 缓存）；只读扫描 4 类 MCP 配置（`~/.claude.json` 含 per-project、项目 `.mcp.json`、`~/.codex/config.toml` 极简 TOML 段解析、`~/.gemini/settings.json`）并分类浏览器型服务器；快捷控制经临时 `.mjs` + `nodejs -e "await import(...)"` 执行（`shell:false`、超时进程树强杀、串行队列、仅 http(s) URL、`JSON.stringify` 注入），专属 `agentui-workbench` 空间按 ownership 自动 claim/takeOver。新增 `browser:status/spaces/tabs/open/screenshot` 5 个 IPC。 |
| **浏览器协同面板** | [BrowserPanel.tsx](src/renderer/src/components/BrowserPanel.tsx), [App.tsx](src/renderer/src/App.tsx) | 顶栏「浏览器」按钮打开面板：ego 状态徽标（版本/路径/未安装提示）、浏览器型 MCP 列表（仅状态展示）与非浏览器 MCP 计数、URL 打开、标签页列表刷新、截图一键回贴输入框（遵守 4 张/10MB 图片上限，成功后聚焦 Composer）。 |

## 3. 已完成文件清单

- **配置、资源与文档**：`package.json`、`tsconfig.json`、`tsconfig.node.json`、`tsconfig.web.json`、`electron.vite.config.ts`、`vitest.config.ts`、`assets/{icon.ico,icon.png}`、`AGENTS.md`、`README.md`、`docs/PLAN.md`、`docs/STATUS.md`
- **共享层 (`src/shared/`)**：`types.ts`、`event-reducer.ts`、`ui-queue.ts`、`shortcuts.ts`、`composer-autocomplete.ts`、`capabilities.ts`、`tool-policy.ts`
- **主进程 (`electron/main/`)**：`index.ts`、`ipc.ts`、`store.ts`、`discovery.ts`、`model-catalog.ts`、`process-utils.ts`、`workspace-files.ts`、`workspace-browser.ts`、`browser-companion.ts`、`terminal-service.ts`、`git/git-service.ts`、`sessions/catalog.ts`、`rpc/jsonl.ts`、`rpc/chunk-assembly.ts`、`rpc/adapters.ts`、`rpc/bridge.ts`、`rpc/bridges/{claude,codex,acp}.ts`、`rpc/runtime.ts`、`rpc/manager.ts`
- **预加载 (`electron/preload/`)**：`index.ts`、`index.d.ts`
- **渲染端 (`src/renderer/`)**：`index.html`、`src/main.tsx`、`src/App.tsx`、`src/styles.css`、`src/assets/brand-icon.png`、`src/components/{Sidebar,ComposerAutocomplete,ForkTreeModal,DiffPanel,WorkspaceFilesPanel,TerminalPanel,MarkdownView,ThinkingBlock,ToolCallCard,ExtensionUiModal,SettingsModal,ShortcutsModal,ProjectTrustModal,BrowserPanel}.tsx`
- **单元测试 (`tests/`)**：`adapters.test.ts`、`bridges.test.ts`、`browser-companion.test.ts`（含本机装有 ego-browser 时的真实探测与 `AGENTUI_LIVE_BROWSER=1` 门控的打开/截图端到端用例）、`chunk-assembly.test.ts`、`claude-live-handshake.test.ts`（本机装有 Claude CLI 时运行，否则跳过）、`claude-session-catalog.test.ts`、`composer-autocomplete.test.ts`、`event-reducer.test.ts`、`git-service.test.ts`、`jsonl.test.ts`、`process-utils.test.ts`、`shortcuts.test.ts`、`store-and-sessions.test.ts`、`tool-policy.test.ts`、`trust-policy-manager.test.ts`、`ui-queue-and-manager.test.ts`、`workspace-browser-and-terminal.test.ts`、`workspace-files-and-fork.test.ts`

## 4. 已踩过的 Windows 环境坑（供后续参考）

1. **Electron 安装下载失败**：国内网络环境下直接 `npm install` 时 `electron/install.js` 可能触发 `RequestError` / `ReadError`。解决方式为配置代理环境变量或 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`，必要时校验 SHA-256 后手动解压至 `node_modules/electron/dist` 并写入 `path.txt`。
2. **Windows Shim 启动无须 `cmd.exe`**：官方受管安装的 `pi.cmd` 会读取 `install/current-version` 并引导至 `dist/bundle/cli.js`，`prime-agent.cmd` 则指向 `..\share\prime-agent\prime-agent.exe`。直接解析目标并设 `shell: false` 可彻底规避命令注入与 `stdin` 转发问题。
3. **OMP `PI_CONFIG_DIR` 绝对路径崩溃**：本机系统变量包含 `PI_CONFIG_DIR=D:\Tools\Apps\oh-my-pi\config`，OMP 18.x 会按相对路径拼接到 `%USERPROFILE%` 下导致 `mkdir ENOENT`。已在 `harnessChildEnvironment('omp', ...)` 中自动剔除并钉死 `PI_CODING_AGENT_DIR`。
4. **Claude Code `system/init` 并非启动即发**：实测 2.1.325 以 `stream-json` 拉起后，启动阶段只输出 SessionStart hook 帧（`hook_started`/`hook_response`，携带 `session_id`），`system/init` 要等首条用户消息；stdin 立即 EOF 则进程直接退出。桥接器已改为对任意 `system` 帧捕获会话 ID，集成测试只等待会话帧、不发 prompt。
5. **`claude --version` 输出带后缀**：格式为 `2.1.325 (Claude Code)`，旧版「取最后一个 token」的版本解析会失败；`parseHarnessVersion` 已改为从尾部反向扫描首个版本号 token。
6. **ego-browser 管道模式下 console 输出走 stderr**：ego-browser 是 Chromium 系控制台程序，从 Node `spawn`（stdio pipe）拉起 `nodejs` 脚本时，脚本 `console.log` 的结果出现在 **stderr** 而非 stdout（Git Bash 终端里两者混排不易察觉），且退出码为 0。`BrowserCompanionService` 已改为在两条流中搜索结果标记；版本号格式为四段（如 `0.6.3.14`），解析正则需支持任意段数。

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

### 5.3 Phase 2 验证记录 (2026-11-20)

- `npm run typecheck`：通过（node/web 两套 tsconfig 零错误）。
- `npm test`：通过（**15 个测试文件、77 个用例全部通过、0 跳过**，耗时约 2.2s）。新增覆盖：三桥接器协议转译与审批往返（29 例）、能力矩阵完整性、Claude 历史回放/嗅探/分叉降级（5 例）、工作区浏览与终端服务（9 例，含真实 `cmd.exe` 命令执行与进程树终止）、Claude 版本后缀解析。
- **真实 Claude Code CLI 握手**（`tests/claude-live-handshake.test.ts`）：以适配器参数拉起本机 `claude.exe`（v2.1.325），1.4s 内收到携带 `session_id` 的 `system` 帧；不发送 prompt、不消耗模型额度；未安装 CLI 的机器自动跳过。
- `npm run build`：通过，`out/main/index.js` 203.31 kB、CommonJS `out/preload/index.cjs` 4.47 kB（CJS 铁律保持）、renderer 1,664.81 kB（含 highlight.js 与 react-virtual）。
- Electron 实窗冒烟（CDP 驱动 + 隔离 `AGENTUI_STATE_PATH` 临时目录）：**SMOKE PASS** —— `window.agentui` 挂载 **44 个 IPC 方法**；7 引擎探测（pi/omp/prime/claude 就绪，claude 版本 2.1.325 正确解析；codex/acp/dsh 本机未安装显示未就绪）；`listWorkspaceDir` 目录优先且隐藏 `.workbuddy`；`readWorkspaceFile('package.json')` 语言识别 json；`../` 越界读取被拒；内嵌终端 `echo` 命令 exit 0 且输出回传；Claude 模型目录返回 3 个内置别名并带提示。
- **验证边界**：Codex / ACP / dsh 桥接器按公开协议文档实现并通过单元测试，但本机无对应 CLI，**未做真实进程端到端验证**；Claude Code 仅验证到启动握手与会话帧解析，未发送真实 prompt（避免消耗用户订阅额度），完整对话链路待用户首次使用时确认。

### 5.4 Phase 3 验证记录 (2026-11-21)

- `npm run typecheck`：通过（node/web 两套 tsconfig 零错误）。
- `npm test`：通过（**18 个测试文件、140 个用例通过、2 个门控跳过**，耗时约 2.7s）。新增覆盖：工具策略纯函数（41 例：高风险规则逐条、只读命令分类、三预设决策矩阵、select 选项匹配）、`RuntimeManager` 审批拦截与 `StateStore` 归一化（14 例：自动放行/拒绝留痕、高风险强制弹窗、select 取消降级、input 直通、应答失败降级、activeHarness 全集）、浏览器协同（10 例：MCP 四类配置解析/去重/坏 JSON 容错、候选路径、真实 ego 探测 + 门控端到端）。
- **真实 ego-browser 端到端**（`AGENTUI_LIVE_BROWSER=1`）：本机 ego-browser 0.6.3.14，`openUrl('https://example.com')` → `listTabs` 命中 → `listSpaces` 含 `agentui-workbench` → `screenshot()` 返回合法 PNG base64，全程约 3.5s；验证后已 `finish({ keep: [] })` 清理临时空间。非 http(s) URL（`file://`、`javascript:`）在 spawn 前被拒。
- `npm run build`：通过，CommonJS `out/preload/index.cjs` 4.96 kB（CJS 铁律保持）、renderer 1,687.05 kB。
- Electron 实窗冒烟（CDP + 隔离 `AGENTUI_STATE_PATH`）：**SMOKE PASS** —— `window.agentui` 挂载 **50 个 IPC 方法**；`addProject` 默认 `trustPreset: 'approval'`，`setProjectTrust('readonly')` 更新并持久化、非法预设被拒、可切回 approval；`browserStatus(true)` 探测 ego 0.6.3.14 可用；重载后侧栏项目盾牌按钮与顶栏「浏览器」按钮均在 DOM 中；Phase 2 各项（工作区/终端/越界防护/7 引擎探测）回归通过。
- **验证边界**：策略拦截在审批层生效——引擎静默自动执行（不发起审批）时无法拦截，UI 已明示；高风险审批弹窗的红色横幅由单元测试覆盖请求富化（`risk.level/reasons`），未在实窗触发真实引擎高风险审批（避免消耗额度）；MCP 扫描本机当前配置未发现浏览器型服务器（解析逻辑由 fixture 单测覆盖）。
