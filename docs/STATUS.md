# AgentUI 开发进展与变更记录 (STATUS)

最后更新：2026-11-21

## 1. 当前进度总览

- **当前阶段**：**Phase 1 MVP + 第 1 步（图标/快捷键/断线重连）+ 第 2 步（`@file` / `/slash` / 图片粘贴 / 会话分叉对比）+ Phase 2（多协议桥接扩展 + 工作区文件树/终端 + 虚拟滚动）+ Phase 3 第 1/2 项（项目信任与工具权限策略 + ego-browser / 浏览器型 MCP 协同）+ P1 评审修复（见 2.7 节）+ 设置页五入口与独立浏览器窗口（MCP / 插件 / 技能 / 使用情况 / 浏览器，见 2.8 节）已全部完成并通过实窗验证**（具体观察指标见第 5 节）。
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

## 2.7 P1 评审修复 (2026-11-21)

| 类别 | 变更文件 | 说明 |
| :--- | :--- | :--- |
| **Claude 桥接三项修复** | [rpc/bridges/claude.ts](electron/main/rpc/bridges/claude.ts), [rpc/runtime.ts](electron/main/rpc/runtime.ts), [rpc/manager.ts](electron/main/rpc/manager.ts), [App.tsx](src/renderer/src/App.tsx) | ① `prompt/steer/follow_up` 以 `alreadyRunning` 守卫，运行中不再重复发 `agent_start`（compact 走 `compaction_start/end`）；② CLI 发 `control_cancel_request` 撤回审批时桥接器发 `method:'dismiss'` 事件，runtime 转译为 `dismissed:true` 请求、manager 直转渲染端、App 从队列移除卡片，消除取消后弹窗残留；③ `set_model` 经 `pendingModelSwitch` 记录前值，`control_response` 失败时桥接层回滚 `currentModel` 并向规范命令报错。 |
| **set_model 持久层回滚** | [rpc/manager.ts](electron/main/rpc/manager.ts) | `RuntimeManager.setModel` 乐观写入 store 后若引擎命令失败，恢复原 `modelProvider/modelId` 并 `emitStatus` 通知渲染端，UI 不再显示被拒绝的模型。 |
| **Codex 信任预设联动与审批清理** | [rpc/bridges/codex.ts](electron/main/rpc/bridges/codex.ts), [rpc/bridge.ts](electron/main/rpc/bridge.ts), [rpc/manager.ts](electron/main/rpc/manager.ts) | `BridgeStartInfo.getTrustPreset()` 每回合读取项目预设：只读观察 → `thread/start` `sandbox:'read-only'` + `turn/start` `sandboxPolicy:{type:'readOnly'}`，其余预设 → `workspaceWrite`；`approvalPolicy:'on-request'` 保证审批经统一策略边界。`turn/started` 去重 `agent_start`；`serverRequest/resolved` 通知与 `turn/completed` 会 dismiss 未决审批卡（中断回合后不残留），已撤销的审批不再回写 JSON-RPC 应答。 |
| **浏览器活动标签页与切换、openUrl 单轮** | [browser-companion.ts](electron/main/browser-companion.ts), [BrowserPanel.tsx](src/renderer/src/components/BrowserPanel.tsx), [ipc.ts](electron/main/ipc.ts), [preload/index.ts](electron/preload/index.ts), [types.ts](src/shared/types.ts) | `SPACE_PREAMBLE` 优先按 `task.tabs()` 的 active 标记匹配当前活动页（而非 `pages[0]`）；`openUrl` 一轮脚本同时返回 `{url,title,spaceId,tabs}`，面板不再追加第二轮 `browserTabs`；新增 `activateTab(label)`（`bringToFront`，单轮返回新标签列表）与 `browser:activateTab` IPC，标签页行可点击切换并高亮活动页。 |
| **MCP TOML 解析加固** | [browser-companion.ts](electron/main/browser-companion.ts) | `parseCodexMcpToml` 支持单引号字面量、跨行 `args` 数组（括号配平）、行尾注释、带引号服务器名与 `[mcp_servers.x.env]` 子表（保留服务器、忽略子表键）；`ego` 分类改为词边界匹配避免误伤 `category` 等词。 |

## 2.8 设置页五入口与独立浏览器窗口 (2026-11-21)

按 Codex 桌面版的「集中管理 / 插件详情 / 按会话分享网页内容」交互范式，为设置新增 **MCP 服务器、插件、技能、使用情况、浏览器** 五个入口；MCP / 插件 / 技能共用 Pi / OMP / Prime 引擎切换器，展示当前项目、配置来源与生效状态。以本机真实 CLI（Pi 1.5.2、OMP 18.18.9、Prime 0.10.3 Rust）逐条探测后按实际能力开放：

| 类别 | 变更文件 | 说明 |
| :--- | :--- | :--- |
| **共享纯函数层** | [src/shared/mcp-config.ts](../src/shared/mcp-config.ts), [src/shared/extensions.ts](../src/shared/extensions.ts), [src/shared/browser-url.ts](../src/shared/browser-url.ts) | MCP 配置解析（JSON/Codex TOML，browser-companion 改为 re-export 保持测试兼容）、rank 标注与同名/同端点覆盖合并 `resolveMcpShadowing`；三引擎能力门控 `EXTENSION_ENGINE_CAPABILITIES`、CLI 输出防御式解析（`pi mcp list --json`、`omp plugin/skill/stats/usage --json`、`prime-agent package/sessions`）、会话用量提取 `extractUsageRecordsFromSession`（Pi/OMP/Prime `usage.cost.total` 与 Claude `input_tokens` 双格式）与 `aggregateUsage`（按记录键去重，函数内部再做一层双保险；无费用时统一输出「未提供」）。 |
| **引擎扩展服务** | [electron/main/extensions/](../electron/main/extensions/) | `engine-cli.ts` 统一执行三引擎子命令（`harnessChildEnvironment` 修正 OMP `PI_CONFIG_DIR` 绝对路径崩溃——本机直跑 `omp stats` 复现该崩溃，经服务执行正常）。`mcp-service.ts`：Pi 经 `pi mcp add/remove [-l]`（用户级 + 信任项目级）、Prime 经 `prime-agent mcp add/list/remove`（用户级，认证交 Prime）、OMP 直接原子写自有配置（用户级 `mcp.json` / 项目 `.omp/mcp.json`），第三方来源（Claude `.claude.json` 按项目过滤、Codex TOML、Gemini、Cursor、Windsurf、VS Code `mcp.servers` 内层抽取、项目根回退）按 OMP mcp-config 文档 rank 只读展示覆盖关系；「生效状态」由 `RuntimeManager.getEngineSessionState` 对比配置 mtime 与运行时会话 `startedAt`，标注「启动后已修改需空闲重连」。`package-service.ts`：`pi install/remove/update`、`omp plugin install/uninstall/upgrade`、`prime-agent package install/remove/update`，解析文本/JSON 列表并标注作用范围。`skill-service.ts`：OMP `omp skill list --json`（含 `claude:user` 跨引擎来源）、Pi/Prime 技能目录扫描 + SKILL.md frontmatter、Prime 项目 Markdown 指令单独分类；`readSkillFile` 白名单预览（仅最近一次发现返回的路径，256KB 截断）。 |
| **用量报表** | [electron/main/usage-service.ts](../electron/main/usage-service.ts), [electron/main/rpc/manager.ts](../electron/main/rpc/manager.ts), [electron/main/rpc/runtime.ts](../electron/main/rpc/runtime.ts) | `UsageService` 扫描会话 `.jsonl`（mtime 缓存、400 文件上限），按记录键全局去重——恢复会话、分叉、重复回放共享同一条记录，最早会话入账；`getSessionUsageSnapshot` 经 `get_session_stats` 校验运行中会话总量；引擎全局统计 `omp stats --json` / `prime-agent sessions --json`（daemon 未运行时降级提示）**单独展示不与项目明细相加**；账户额度接 `omp usage --json`（Pi/Prime 标「未提供」）。 |
| **独立浏览器窗口** | [electron/main/browser-window-service.ts](../electron/main/browser-window-service.ts), [src/renderer/browser.html](../src/renderer/browser.html), [src/renderer/browser-src/](../src/renderer/browser-src/) | 第二 Vite 渲染入口 `browser.html`：每标签一个 `WebContentsView`，统一 `persist:agentui-browser` 分区会话（登录状态与工作台隔离）；权限请求默认拒绝、弹窗转新标签、仅 http(s)、`did-navigate` 拦 `file://`；`browserWin:setInsets` 由渲染端上报工具栏高度后挂载视图；分享面板把链接 / 选中文本 / 截图经 `agentui:shareToComposer` 填入目标会话输入框（目标会话校验 + 10MB 图片上限），三个引擎都能接收。CSP 插件为浏览器页放行 `img-src http(s)`（favicon）。 |
| **IPC 与渲染端** | [src/shared/types.ts](../src/shared/types.ts), [electron/main/ipc.ts](../electron/main/ipc.ts), [electron/preload/index.ts](../electron/preload/index.ts), [src/renderer/src/components/SettingsPage.tsx](../src/renderer/src/components/SettingsPage.tsx), [SettingsExtensionsPages.tsx](../src/renderer/src/components/SettingsExtensionsPages.tsx), [App.tsx](../src/renderer/src/App.tsx), [WorkbenchHeader.tsx](../src/renderer/src/components/WorkbenchHeader.tsx) | 新增 `ext:*` / `usage:getReport` / `browserWin:*` 路由与 preload API（实窗挂载 84 个方法）。设置导航新增五节；MCP/插件/技能页共用 `EngineSwitcher`（Segments Pi/OMP/Prime），展示当前项目徽标、配置来源清单（可编辑标注）、添加服务器表单（stdio/http 双形态，Pi 项目级需信任）、技能搜索/预览（MarkdownView）/插入 `/技能名`（会话已注册时用原名，否则回退 `/skill:名称`）；用量页提供日期/项目/引擎/模型筛选与「Token 消耗、上下文占用、账户额度」三卡 + 按项目/模型/日期/会话明细；顶栏新增独立浏览器按钮（AppWindow 图标），`Ctrl+K` 命令面板含「打开独立浏览器」。 |

## 2.9 五入口验收修复 (2026-11-21)

实窗验收发现的问题逐项修复（类型检查、构建、187 项测试与 19/19 实窗冒烟全部通过）：

| 问题 | 根因与修复 |
| :--- | :--- |
| **跨会话分享截图后附件被清空** | 切换会话的 effect 会清空 `attachedImages`，分享追加被其抹掉。现在跨会话分享截图时跳过该次清空并**整体替换**为该截图（同会话分享仍为追加，受 4 张上限约束）；以双会话实窗用例验证（chips=1 → 追加后 chips=2）。 |
| **Prime MCP 无法从界面删除** | 删除按钮此前绑定 `managed`（文件直写）标志，Prime 条目由 CLI 管理被误判不可删。`RawMcpEntry`/`McpFileSpec` 新增显式 `deletable` 标志：Prime settings.json 条目 `managed:false + deletable:true`（删除走 `prime-agent mcp remove`），OMP 第三方来源保持不可删。 |
| **费用缺失误报为 0** | 混合费用数据时聚合只累加有费用的记录，读起来像完整估算。`UsageUsageTotals` 新增 `costCalls`（携带费用的调用数），UI 的 `costLabel` 在 `costCalls < calls` 时标注「部分：x/y 次调用含费用」，`UsageSessionRow` 改为继承 totals 类型。 |
| **Pi 实况检查未传项目目录** | `pi mcp list --json` 现在携带 `cwd = 项目目录`，项目级服务器（信任项目）的实况状态才能对得上。 |
| **项目级插件更新未带项目语境** | `packageUpdate` 增加 `scope` 参数并透传项目目录：OMP 追加 `--scope=project`、Pi 在项目目录下执行；界面按包的 scope 调用，「更新全部」固定用户级。 |
| **Pi 技能目录遗漏** | 按 docs.pi.dev/latest/skills 补齐：`.agents/skills` 用户级（通用规范）与项目祖先目录（沿目录向上、遇仓库根即停）；扫描改为**递归**发现 SKILL.md（Agent Skills 规范）；技能插入固定用 Pi 文档规定的 `/skill:名称` 强制调用形式。 |
| **「会话已加载」跨引擎误标** | 技能页新增 `sessionEngine`（活动会话所属引擎），只有引擎一致时才按命令名标「会话已加载」。 |
| **插件安装前缺少摘要** | 「安装」改为两步确认：先展示来源 / 作用范围 / 引擎摘要与「版本、包含资源在安装后于列表详情查看」的说明，确认后才执行。 |

## 3. 已完成文件清单

- **配置、资源与文档**：`package.json`、`tsconfig.json`、`tsconfig.node.json`、`tsconfig.web.json`、`electron.vite.config.ts`、`vitest.config.ts`、`assets/{icon.ico,icon.png}`、`AGENTS.md`、`README.md`、`docs/PLAN.md`、`docs/STATUS.md`
- **共享层 (`src/shared/`)**：`types.ts`、`event-reducer.ts`、`ui-queue.ts`、`shortcuts.ts`、`composer-autocomplete.ts`、`capabilities.ts`、`tool-policy.ts`、`mcp-config.ts`、`extensions.ts`、`browser-url.ts`
- **主进程 (`electron/main/`)**：`index.ts`、`ipc.ts`、`store.ts`、`discovery.ts`、`model-catalog.ts`、`process-utils.ts`、`workspace-files.ts`、`workspace-browser.ts`、`browser-companion.ts`、`browser-window-service.ts`、`terminal-service.ts`、`usage-service.ts`、`extensions/{engine-cli,mcp-service,package-service,skill-service}.ts`、`git/git-service.ts`、`sessions/catalog.ts`、`rpc/jsonl.ts`、`rpc/chunk-assembly.ts`、`rpc/adapters.ts`、`rpc/bridge.ts`、`rpc/bridges/{claude,codex,acp}.ts`、`rpc/runtime.ts`、`rpc/manager.ts`
- **预加载 (`electron/preload/`)**：`index.ts`、`index.d.ts`
- **渲染端 (`src/renderer/`)**：`index.html`、`browser.html`（独立浏览器窗口入口）、`src/main.tsx`、`src/App.tsx`、`src/styles.css`、`src/assets/brand-icon.png`、`browser-src/{main.tsx,BrowserApp.tsx,browser.css}`、`src/components/{Sidebar,ComposerAutocomplete,ForkTreeModal,DiffPanel,WorkspaceFilesPanel,TerminalPanel,MarkdownView,ThinkingBlock,ToolCallCard,ExtensionUiModal,SettingsModal,ShortcutsModal,ProjectTrustModal,BrowserPanel,SettingsExtensionsPages}.tsx`
- **单元测试 (`tests/`)**：`adapters.test.ts`、`bridges.test.ts`、`browser-companion.test.ts`（含本机装有 ego-browser 时的真实探测与 `AGENTUI_LIVE_BROWSER=1` 门控的打开/截图端到端用例）、`chunk-assembly.test.ts`、`claude-live-handshake.test.ts`（本机装有 Claude CLI 时运行，否则跳过）、`claude-session-catalog.test.ts`、`composer-autocomplete.test.ts`、`diagnostics.test.ts`、`event-reducer.test.ts`、`extensions.test.ts`（MCP 覆盖合并 / OMP 配置读写 / CLI 输出解析 / 用量去重聚合 / 地址栏规范化）、`git-service.test.ts`、`jsonl.test.ts`、`p1-fixes.test.ts`（P1 评审修复：桥接去重/审批撤销/set_model 双层回滚/Codex 沙箱联动/TOML 解析）、`process-utils.test.ts`、`security-hardening.test.ts`、`shortcuts.test.ts`、`store-and-sessions.test.ts`、`tool-policy.test.ts`、`trust-policy-manager.test.ts`、`ui-queue-and-manager.test.ts`、`workspace-browser-and-terminal.test.ts`、`workspace-files-and-fork.test.ts`

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

### 5.5 P1 评审修复验证记录 (2026-11-21)

- `npm run typecheck`：通过（node/web 两套 tsconfig 零错误）。
- `npm test`：通过（**21 个测试文件、166 个用例通过、2 个门控跳过**，耗时约 3.9s）。`p1-fixes.test.ts` 12 例：Claude 运行中 steer/follow_up 不重复 `agent_start`、`control_cancel_request` → dismiss（未知 id 不发）、`set_model` 拒绝后 `get_state` 返回旧模型、compact 只发 compaction 事件；Codex `prompt`+`turn/started` 仅一次 `agent_start`（服务端自发回合仍发）、`serverRequest/resolved`/`turn/completed` dismiss 未决审批且不重复回写、readonly 预设 → `sandbox:'read-only'`+`sandboxPolicy:{type:'readOnly'}` 且预设切换下一回合即生效；`RuntimeManager.setModel` 失败恢复持久化模型并广播状态、成功保留新模型；TOML 多行数组/单引号/子表/引号名、`ego` 词边界、同名不同 args 去重与 claude per-project 过滤。
- `npm run build`：通过，CommonJS `out/preload/index.cjs` 5.87 kB（CJS 铁律保持）、renderer 1,779.41 kB。
- Electron 实窗冒烟（CDP + 隔离 `AGENTUI_STATE_PATH`）：**SMOKE PASS** —— `window.agentui` 挂载 **59 个 IPC 方法**（含 `browserActivateTab` / `setProjectTrust`）；信任预设 approval→readonly 持久化、非法预设被拒；`readWorkspaceFile('../../windows/win.ini')` 越界被拒；ego-browser 探测 **v0.6.3.17** 可用、`browserTabs` 单轮返回数组；7 引擎探测 pi/omp/prime/claude 就绪，codex/acp/dsh 本机未安装。
- **验证边界**：Codex 本机仍未安装 CLI，沙箱联动与审批撤销由单元测试按 app-server v2 协议覆盖，未做真实进程端到端验证；`activateTab` 的 `bringToFront` 行为依赖 ego-browser 页面 API（本机 0.6.3.17），真实多标签切换待用户使用时确认。

### 5.6 设置页五入口与独立浏览器窗口验证记录 (2026-11-21)

- **CLI 能力探测（实施前置）**：以本机真实 CLI 逐条验证 `pi mcp --help`（add/remove/list/login/logout + `--json`、`-l` 项目级）、`pi install/remove/list`、`omp plugin/skill/config/stats/usage --help` 与 JSON 输出、`prime-agent mcp/package/sessions`（确认 Prime 不支持 `--json`，需文本解析；`sessions --json` 依赖 daemon）。OMP 文档确认 MCP 第三方来源优先级（Claude > Codex > Gemini > Cursor/Windsurf > VS Code > 项目根回退，同名第一次定义获胜）。
- `npm run typecheck`：通过（node/web 两套 tsconfig 零错误）。
- `npm test`：通过（**22 个测试文件、183 个用例通过、2 个门控跳过**）。新增 `tests/extensions.test.ts` 17 例：MCP rank 覆盖合并（同名 + 同端点遮蔽、claude 按项目过滤、Codex TOML 回归）、OMP 用户级 `mcp.json` 原子写入与删除（临时目录 + 桩 discovery）、非法名称与 CLI 未就绪拒错、`pi mcp list --json` / `omp plugin` / `omp skill` / 文本包列表 / SKILL frontmatter 解析、Pi+Claude 双格式用量提取、`aggregateUsage` 去重与筛选与「未提供」语义、`omp stats/usage`、`prime sessions` 解析、地址栏规范化。
- `npm run build`：通过，双渲染入口产出 `out/renderer/index.html` 与 `out/renderer/browser.html`；CommonJS `out/preload/index.cjs` 8.50 kB（CJS 铁律保持）。
- Electron 实窗冒烟（CDP + 隔离 `AGENTUI_STATE_PATH` 临时目录）：**SMOKE PASS（15/15）** —— `window.agentui` 挂载 **84 个 IPC 方法**；三引擎 + Claude 就绪（pi 1.5.2 / omp 18.18.9 / prime 0.10.3 / claude 2.1.325）；OMP MCP 快照含 8 个配置来源（用户级 + Claude/Codex/Gemini/Cursor/Windsurf 第三方）与 2 个第三方服务器；Pi / Prime 快照各 1 个来源；OMP 技能发现 3 项（首个来源 `claude:user` 跨引擎目录）；Pi 技能扫描 1 项；OMP 插件列表（npm + marketplace）；用量报表返回 totals / sessions / 引擎全局（omp:true，prime 因 daemon 未运行降级）/ 账户额度（无报告标不可用）；设置导航含五个新入口；MCP 设置页渲染且三引擎切换器（Pi/OMP/Prime Agent）可切换；技能页渲染带来源徽标；独立浏览器窗口打开（`browser.html` + 1 个初始标签 + 地址栏 + 分享面板），向不存在会话分享被拒（「目标会话不存在」）。
- **验证边界**：MCP 添加/删除、插件安装/卸载、Pi `mcp list --json` 实况检查未在真实配置上执行（避免改动用户引擎配置），由 `tests/extensions.test.ts` 以临时目录与桩 discovery 覆盖读写逻辑；Prime daemon 未运行，`prime-agent sessions --json` 全局统计走降级提示；用量报表当前无本地用量数据（totals 为 0 且给出说明），聚合与去重由单元测试覆盖。

### 5.7 五入口验收修复验证记录 (2026-11-21)

- `npm run typecheck`：通过（node/web 零错误）。
- `npm test`：通过（**22 个测试文件、187 个用例通过、2 个门控跳过**）。`extensions.test.ts` 增至 21 例，新增：Prime 条目 `managed:false + deletable:true`、OMP 第三方来源 `deletable:false`、Pi 技能递归扫描（嵌套 SKILL.md）+ 项目祖先目录 `.agents/skills`（`.git` 仓库根截停）+ 白名单预览拒绝、Prime 项目指令 `executable:false`、`aggregateUsage` 的 `costCalls` 混合费用语义。
- `npm run build`：通过（双渲染入口，CJS preload 铁律保持）。
- Electron 实窗冒烟（CDP + 隔离临时 state）：**SMOKE PASS（19/19）** —— 新增用例：Prime MCP 快照所有条目 `deletable === true`（界面即有删除按钮）；Pi 技能扫描含 `.agents/skills（用户级，通用规范）` 来源且 note 含 `/skill:`；插件页「安装」进入两步确认摘要（来源/作用范围/引擎 + 安装后解析说明）；使用情况页三卡渲染；**双会话截图分享**：跨会话分享后附件为 1 张（替换语义，不再被切线程清空），同会话再分享追加为 2 张。既有 15 项检查全部回归通过。
- **验证边界**：Prime MCP 删除实际走 `prime-agent mcp remove`，界面按钮的出现逻辑已由快照断言（deletableAll=true）覆盖，真实删除未在用户配置上执行（避免改动本机 Prime 配置）；Pi `mcp list --json` 带 cwd 的实况检查仍属连接型操作，未做真实执行；OMP 账户额度仍取决于是否有已认证账户的用量报告。

### 5.8 草稿、费用与 Prime 插件复验 (2026-11-21)

- 浏览器分享按目标会话写入草稿，切换后可找回各自的文字和附件。实窗验证了两个会话分别保留草稿、截图追加和切回后恢复附件。
- 用量按每个分组判断价格数据是否存在。无费用数据的行显示「未提供」，已知费用为零时照常显示，混合总计标出覆盖的调用数。已用混合数据验证报表界面。
- Prime 0.10.3 Rust 只提供用户级插件操作。实窗验证了项目级请求被拒绝、临时配置中用户级本地包安装成功，以及 Pi 仍可选择项目级。Prime MCP 的添加和删除也已用临时配置复测。
- 类型检查和生产构建通过。188 项测试通过，2 项门控测试跳过。
