# AgentUI 项目规划 (Roadmap)

参考桌面标杆：**Codex Desktop**、**DeepSeek Harness (`dsh`)**、**`am-will/gooey-pi` (MIT)** 与 **`zhukunpenglinyutong/desktop-cc-gui`**。

---

## Phase 1 — MVP 最小可用闭环（已完成）

目标：跑通「三引擎自动探测与并发切换 + 流式对话 / Thinking / Tool Call / 审批弹窗 + Git Worktree 与 Diff 审阅」。

- [x] **工程底座**：Electron 35 + TypeScript + React 19 + `electron-vite` + Vitest，零 C++ 原生依赖。
- [x] **Windows 免 Shell 启动与环境隔离**：
  - [x] `pi.cmd`（官方受管安装布局 `install/current-version` + npm shim）直接定位 `node.exe` + JS 入口
  - [x] `prime-agent.cmd` 直接解析 `..\share\prime-agent\prime-agent.exe`
  - [x] `omp.exe` 清除绝对 `PI_CONFIG_DIR` 冲突并固定 `PI_CODING_AGENT_DIR`
- [x] **原生 RPC 运行时与三引擎适配**：
  - [x] Strict LF JSONL 解码与 OMP v2 `rpc_chunk` Base64 重组
  - [x] Pi / OMP / Prime Agent（TS & Rust 0.10.x）四适配器及并发 `RuntimeManager`
  - [x] 单次探测缓存优化、部分状态更新保护与会话清理回收
- [x] **工作台核心 UI**：
  - [x] 三引擎状态条、项目目录管理、侧栏搜索过滤与双击内联重命名
  - [x] CLI 历史 `.jsonl` 会话扫描与一键恢复
  - [x] Markdown (GFM) 渲染 + 代码块一键复制、可折叠 Thinking、Tool Call 参数/输出/耗时卡片
  - [x] 多线程并发 `extension_ui_request` 排队审批弹窗
  - [x] 模型下拉切换、Thinking 档位、Compact、Steer、Follow-up、Abort
- [x] **Git 审阅与 Worktree 隔离**：
  - [x] Staged / Unstaged / Untracked 列表、防竞态 Diff 预览、Stage / Unstage / Discard / Commit
  - [x] Worktree 一键创建并绑定新会话、从已有 Worktree 快速新开对话、清理 Worktree
- [x] **质量保障与文档**：单元测试、`typecheck`、`build`、三引擎真实 CLI 握手验证、Electron 实窗启动冒烟、`AGENTS.md` / `STATUS.md` / `PLAN.md`。

---

## Phase 2 — 多协议扩展与高效工作区（已完成，2026-11-20）

目标：补齐 Codex / Claude / ACP / DSH 生态接入，提升长任务会话管理与编辑器协同体验。

1. **通用 Harness / 协议扩展层**：
   - [x] 抽象传输接口 `ProtocolBridge`（[electron/main/rpc/bridge.ts](../electron/main/rpc/bridge.ts)），在现有 Pi/OMP/Prime RPC 之外新增 **ACP (`Agent Client Protocol`)**、**Claude Code (`stream-json`)**、**Codex App Server** 与 **`dsh --profile acp`** 引擎接入；`RpcRuntime` / `RuntimeManager` / 事件归约 / UI 保持引擎无关。
   - [x] 在 `SettingsModal` 展示 7 引擎 × 11 项能力矩阵（steer、follow-up、compact、thinking、模型热切换、fork、审批弹窗、context stats、历史回放、图片、斜杠命令）及桥接引擎限制说明。
   - [x] Claude Code 历史会话回放（内容嗅探区分 Pi/Claude `.jsonl`，uuid/parentUuid 活跃链重建）；Codex/ACP/dsh 会话由 Agent 端管理，分叉与文件级回放给出友好降级提示。
   - 验证状态：Claude Code 2.1.325 本机真实 CLI 握手 + 实窗冒烟通过；**Codex / ACP / dsh 适配器按公开协议实现，本机未安装对应 CLI，尚未端到端验证（实验性）**。
2. **会话分支与历史增强**：
   - [x] 利用 Pi `fork` / OMP `branch` 协议与 `.jsonl` 活跃分支树构建「分叉节点树 + 多方案并行对比」面板，支持从任意历史提问跨引擎分叉并保留原对话。
   - [ ] 本地会话索引与全文检索（在无 MSVC 时可选 WASM SQLite，或仅保留增量 JSONL 索引）。
3. **高效输入与文件关联**：
   - [x] Composer 支持 `@file` 工作区文件模糊补全、`/` 斜杠命令提示（内置命令 + 引擎 `get_commands` Skill/模板）与剪贴板图片粘贴/拖拽上传。
   - [x] 右侧面板增加「文件树 + 只读代码高亮」（`Ctrl+Shift+E`，highlight.js 高亮、512KB 截断、二进制检测、路径越界防护、`@引用` 回注输入框）及可选内嵌终端（`Ctrl+Shift+T`）。
   - [x] 使用 `@tanstack/react-virtual` 优化超长 Tool 输出（>400 行按行虚拟滚动）与千条级时间线（动态测高虚拟滚动 + 贴底跟随）渲染性能。

### 内嵌终端的技术取舍与 PTY 升级路径

- 受「零 C++ 原生模块」铁律约束（目标机无 MSVC/Rust 工具链），当前终端为**非 PTY 命令运行器**：每条命令经显式 shell 进程执行（Windows `cmd.exe /d /s /c`，POSIX `/bin/sh -c`），Node `spawn` 本身保持 `shell: false`；支持并发上限 4、10 分钟超时自动终止、进程树强杀、输出缓冲节流渲染。交互式 TTY 程序（vim、top 等）不在当前能力范围内，UI 已明示。
- 升级路径：待确认编译工具链或 prebuild 可用性后，引入 `@lydell/node-pty`（预编译二进制分发）或 `node-pty-prebuilt-multiarch`，替换 `TerminalService` 的 spawn 层并接入 xterm.js；IPC 契约（`terminal:start/stop` + 输出/退出事件）可保持不变。

---

## Phase 3 — 安全治理、浏览器协同与桌面分发

1. **工具权限与项目信任策略引擎**（已完成，2026-11-21）：
   - [x] 按项目配置权限预设：**只读观察 / 写操作需审批（默认）/ 自动模式**（[src/shared/tool-policy.ts](../src/shared/tool-policy.ts) 纯函数策略模块 + 侧栏盾牌按钮 `ProjectTrustModal`，`projects:setTrust` IPC 持久化）。
   - [x] 高风险命令拦截：约 21 条规则（`rm -rf`、`del /f /s /q`、`Remove-Item -Recurse -Force`、格式化/`diskpart`/`mkfs`/`dd of=/dev/`、关机重启、`reg delete`、`git push --force` / `reset --hard` / `clean -f`、`curl | sh` / `iwr | iex`、`chmod 777 /`、删库 SQL、fork 炸弹、`find -delete` 等），审批弹窗红色警告横幅列出命中原因；**自动模式下高风险操作仍强制人工确认**。
   - [x] 策略在 `RuntimeManager` 的审批边界（`extension_ui_request` confirm/select）统一拦截：只读预设自动放行只读命令/读取类工具并自动拒绝写操作（时间线留痕提示）；自动预设放行常规操作；input/editor 始终交由用户。select 型审批自动匹配允许/拒绝选项（中英文），无法匹配拒绝项时取消请求；自动应答失败时降级为人工弹窗。
   - 已知边界：策略是**审批层尽力而为**——引擎自身配置为静默自动执行、不发起审批请求时无法在此拦截（UI 与文档已明示）；工作区白名单未实现（后续可选）。
2. **`ego-browser` / 浏览器与 MCP 协同面板**（已完成，2026-11-21）：
   - [x] [electron/main/browser-companion.ts](../electron/main/browser-companion.ts)：ego-browser CLI 探测（PATH + `~/.local/share/ego/active_version_dir`，`--version` 缓存 60s）；只读扫描 `~/.claude.json`（含 per-project）、项目 `.mcp.json`、`~/.codex/config.toml`（`[mcp_servers.*]`）、`~/.gemini/settings.json` 并按名称/命令/URL 分类浏览器型 MCP。
   - [x] 顶栏「浏览器」面板：ego 状态徽标、浏览器型 MCP 列表（仅状态展示，由各引擎自行连接）、快捷控制——在专属 `agentui-workbench` 空间打开 http(s) URL、列出标签页、**截图一键回贴输入框**（遵守 4 张 / 10MB 图片上限）。
   - [x] 脚本经临时 `.mjs` 文件 + `ego-browser nodejs -e "await import(...)"` 执行（`shell: false`、超时进程树强杀、串行队列、URL `JSON.stringify` 注入且仅允许 http(s)）；已处理 ego-browser（Chromium 系）管道模式下 console 输出走 **stderr** 的差异。
   - 验证状态：本机 ego-browser 0.6.3.14 真实打开 example.com → 标签页 → PNG 截图端到端通过（测试后空间已清理）。
3. **自动化测试与安装包分发**：
   - 引入基于 Playwright (`_electron.launch`) 的真实端到端回归套件。
   - 配置 `electron-builder` 生成 Windows NSIS 安装包 / 绿色便携包及版本号注入脚本。
