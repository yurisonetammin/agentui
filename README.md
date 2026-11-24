# AgentUI

轻量、本地可控的多引擎 AI 编码 Agent 桌面工作台（Electron 35 + TypeScript + React 19），零 C++ 原生编译依赖，面向真实工程开发提供从 **多引擎并行编码 → 代码审阅/轻度编辑 → Git 推送与 PR → 浏览器元素批注 → 后台定时巡检** 的完整桌面闭环。

- 开发者与 Agent 协作约定：[AGENTS.md](AGENTS.md)
- 开发进度与版本变更日志：[docs/STATUS.md](docs/STATUS.md)
- 分阶段产品路线图：[docs/PLAN.md](docs/PLAN.md)

---

## AgentUI 能做什么？

### 1. 七大编码 Agent 统一控制面与并发工作台
- **原生 RPC 三引擎 + 统一桥接四引擎**：自动探测并接入本机 **Pi**、**OMP (`oh-my-pi`)**、**Prime Agent**（原生 RPC），以及经统一传输层桥接的 **Claude Code (`stream-json`)**、**Codex App Server**、**ACP (Agent Client Protocol)**、**dsh (`--profile acp`)**，并在设置页提供「7 引擎 × 11 项能力对比矩阵」与自定义 CLI 路径检测。
- **多会话后台并发 + 全局状态横条**：每个会话拥有独立子进程与隔离上下文，切换项目或会话不中断后台运行；侧栏顶部常驻 **「待审批 / 运行中」全局状态条**，即使项目已折叠也能第一时间发现 `waiting_ui` 审批请求并一键跳转处理。
- **双会话实时分屏赛马（Split View）**：顶栏或侧栏一键开启左右双栏实时分屏，配合两个 Git Worktree 或不同引擎/模型并行解题，支持左右互换、独立审批卡片、实时流式对比与直接向右侧会话发指令。
- **Subagent 树状进度卡与完整对话控制**：自动识别 `Task` / `subagent` / `Agent` 等子代理委派调用，渲染为独立的嵌套进度卡片（展示角色、模型、任务摘要、状态耗时与返回结果）；支持流式 Markdown 与代码块复制、可折叠 Thinking 推理块、超长工具输出虚拟滚动、Steer（中途引导）/ Follow-up（排队追问）/ Abort / Compact 与模型、Thinking 档位热切换。

### 2. 代码审阅、轻度编辑与 Git 交付闭环
- **Git Worktree 隔离开发**：一键为任务创建独立 Git Worktree 分支并绑定新会话，支持在已有 Worktree 上快速新开对话或安全清理 Worktree。
- **单栏 / 并排 Diff + 逐行批注回贴**：右侧「变更」面板支持暂存/未暂存/未跟踪文件列表及回合级 Diff 预览，提供 **单栏 / 并排（Side-by-Side）** 视图切换；在两种视图中均可点击、Shift 多选或拖拽行号区间，直接写下修改意见并自动格式化为 `@path#L12-L20` + Diff 代码块回贴输入框。
- **AI 提交信息 + Push + 一键 PR / Linked PR**：支持 Stage / Unstage / Discard / Commit、**AI 一键生成 Conventional Commits 提交信息**（无可用引擎时自动降级启发式摘要）、首次推送自动设置上游（`-u`）、分支 ahead/behind 同步提示；装有 GitHub CLI (`gh`) 时可直接创建 PR 并在顶栏显示 **Linked PR 状态徽标**，未安装 `gh` 时自动拼接 GitHub/GitLab Compare URL 打开浏览器。
- **CodeMirror 6 可编辑代码视图 + 一键外部 IDE 跳转**：内置纯 JS CodeMirror 6 编辑器（支持 JS/TS/JSX/TSX/JSON/Markdown/CSS/HTML/Python 语法高亮与深浅主题自适应），可直接轻度编辑并以 `Ctrl+S` 原子保存，选中代码段一键生成 `@path#Lstart-Lend` 引用；在文件面板、Diff 面板与工具调用卡片上均支持一键唤起 **VS Code / Cursor / 系统资源管理器** 并精准跳转到目标行号。

### 3. 细粒度权限网关与高风险安全兜底
- **三级项目信任预设**：按项目配置 **只读观察 / 写操作需审批（默认）/ 自动模式**，在引擎发起审批边界统一拦截执行。
- **Allow / Ask / Deny 规则表 +「本会话记住」**：在设置页「项目与权限」可视化配置按 **命令前缀（glob）/ 工具名 / 文件路径前缀** 匹配的细粒度规则（优先级：`高风险兜底 > deny > ask > allow > 项目预设`）；审批卡片提供一键 **「本会话允许该命令前缀」** 与 **「加入项目允许规则」**，告别反复确认 `npm test` 等安全命令。
- **高风险命令强制确认**：内置约 21 条高风险拦截规则（如 `rm -rf`、`git push --force`、`git reset --hard`、`curl | sh`、删库 SQL、格式化磁盘等），即便在自动模式下也会弹出醒目警告强制人工确认。

### 4. 独立隔离浏览器、DOM 元素点选批注与 `ego-browser` 协同
- **登录态隔离的多标签独立浏览器**：内置独立多标签浏览器窗口（`persist:agentui-browser` 独立会话分区，与工作台登录态完全隔离、权限请求默认拒绝、弹窗自动转新标签），一键将当前页面链接、选中文本或整页截图写入指定会话草稿。
- **DOM 元素点选 & 视觉圈选批注**：点击浏览器工具栏 **「点选批注」**，在网页上悬停高亮任意 DOM 元素并点击，即可自动抓取 **CSS 选择器、标签/role、坐标尺寸、文本摘要与裁切后的元素局部截图**，写上修改说明一键送入目标会话输入框（由用户确认后发送，绝不静默提交），大幅提升前端联调效率。
- **`ego-browser` 与浏览器型 MCP 协同**：工作区「浏览器」面板可探测本机 `ego-browser` 与多端浏览器型 MCP 配置，支持快捷打开网页、切换标签页与截图一键回贴输入框。

### 5. 会话历史、轮次导航、跨引擎分叉与全文检索
- **会话内轮次导航（Turn Navigator）**：长会话顶栏提供紧凑「N 轮」大纲浮层，列出每轮用户提问摘要、工具调用数与 `+X/−Y` 变更统计，一键定位虚拟滚动列表并高亮目标行。
- **分叉节点树与多方案对比**：支持从任意历史提问节点分叉新分支（甚至切换至不同引擎继续探索），保留原会话记录并可在分叉面板中并排对比不同分支结果。
- **零原生会话全文检索**：内置增量 JSONL 索引（自动覆盖内存会话及 Pi / OMP / Prime / Claude 本地 `.jsonl` 历史），按 `Ctrl+K` 在命令面板中即可毫秒级全文检索并高亮命中片段，一键恢复打开。

### 6. 定时 / Cron 自动任务、Prime 原生心跳与系统托盘驻留
- **纯 JS Cron 定时调度器**：在设置页「定时任务」支持标准 5 段 Cron 表达式与常用预设（每 15 分钟 / 每小时 / 每日 09:00 / 工作日 / 每周一），绑定 **目标项目 + 引擎 + 权限预设（默认只读）+ 指令**，自动后台运行代码巡检、每日变更摘要等任务，支持立即运行、启停、查看运行历史与失败桌面系统通知。
- **Prime Agent 原生心跳检测**：只读探测本机 `prime-agent status --json` 与 `schedule list`，直观展示 Prime 后台服务状态与原生计划任务。
- **可选系统托盘后台驻留**：开启「关闭窗口时最小化到系统托盘」后，关闭主窗口可在后台继续触发定时任务，通过托盘菜单随时唤回窗口或彻底退出。

### 7. 扩展生态管理、用量统计与双模式内嵌终端
- **MCP / 插件 / 技能一站式管理**：在设置页统一管理 Pi / OMP / Prime 的 **MCP 服务器**（增删自有配置、只读汇总并标注 Claude/Codex/Gemini/Cursor 等第三方来源的覆盖关系、密钥仅显键名不显值）、**插件/包安装卸载更新**、**技能 `SKILL.md` 在线预览与一键插入输入框**。
- **使用情况与费用报表**：解析 `.jsonl` 会话记录并按单次模型调用全局去重（恢复/分叉不重复入账），按时间、项目、引擎维度统计 Token 与费用，与引擎全局统计（`omp stats` / `prime-agent sessions`）分栏呈现。
- **双模式内嵌终端**：
  - **命令运行器（内置、零原生依赖）**：显式 shell 执行单条命令，支持并发上限、超时终止、进程树强杀与底部/右侧停靠。
  - **Herdr 持久交互终端（可选）**：接入本机 [Herdr](https://herdr.dev/tui/docs/) 复用器，以 `xterm.js` 实时渲染观察/接管后台真实 PTY 会话，关闭面板自动释放控制权且不终止后台终端进程。

### 8. 高效输入与桌面体验
- Composer 支持 `@file` 工作区文件模糊补全、`/` 内置与引擎斜杠命令补全、剪贴板截图粘贴与拖拽图片上传（最多 4 张 / 单张 10MB）。
- 支持浅色 / 深色 / 跟随系统主题、对话列宽（标准/宽/满宽）、代码字号、减少动效、全局命令面板（`Ctrl+K`）与快捷键速查（`Ctrl+/`）。

---

## 支持的引擎与接入方式

| 引擎 | 协议 / 接入方式 | 典型特色 | 说明 |
| :--- | :--- | :--- | :--- |
| **Pi** | 原生 RPC (`--mode rpc`) | 模型/Thinking 热切换、原生 fork、MCP/插件/技能管理 | 已验证（含 Windows `pi.cmd` 受管布局解析） |
| **OMP (`oh-my-pi`)** | 原生 RPC v2 (`rpc_chunk` 重组) | 模型目录、分支、OMP 插件/技能/用量统计 | 已验证（自动规避绝对 `PI_CONFIG_DIR` 陷阱） |
| **Prime Agent** | 原生 RPC (`--mode rpc`) | 兼容 Rust 0.10.x、MCP/包管理、后台心跳状态查询 | 已验证（自动解析 `prime-agent.cmd`） |
| **Claude Code** | `stream-json` 协议桥接 | 审批控制帧联动、Subagent `Task` 卡片、历史回放 | 已实机验证（2.1.x） |
| **Codex** | `app-server` JSON-RPC 2.0 桥接 | Thread/Turn/Item 映射、模型列表、信任预设联动 | 按公开协议实现（实验性） |
| **ACP** | Agent Client Protocol v1 桥接 | 兼容 Gemini / Qwen / 通用 ACP Agent，客户端只读 fs 守卫 | 按公开协议实现（实验性） |
| **dsh** | `dsh --profile acp` 桥接 | 复用 ACP 传输层接入 DeepSeek Harness | 按公开协议实现（实验性） |

---

## 常用快捷键

| 快捷键 | 功能 |
| :--- | :--- |
| `Ctrl+K` | 打开命令面板（快速跳转设置、会话切换、**会话全文检索**） |
| `Ctrl+N` | 新建空白对话草稿 |
| `Ctrl+L` | 聚焦指令输入框 |
| `Ctrl+Shift+D` | 切换右侧变更（Git Diff）面板 |
| `Ctrl+Shift+E` | 打开工作区文件树（CodeMirror 6 编辑器） |
| `Ctrl+Shift+T` | 打开内嵌终端 |
| `Ctrl+Shift+W` | 打开 Git Worktree 管理 |
| `Ctrl+1` / `2` / `3` | 快速切换 Pi / OMP / Prime Agent |
| `Ctrl+,` | 打开设置页 |
| `Ctrl+/` | 查看快捷键速查 |

---

## 安全与架构约束

- **零 C++ 原生模块**：不依赖 `node-pty`、`better-sqlite3`、`keytar` 等需 MSVC/Rust 编译的原生包，Windows 开箱即构建。
- **Electron 沙箱与 CSP 防护**：渲染进程开启 `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`，Preload 强制编译为 CommonJS (`.cjs`)；生产构建通过 Vite 插件注入严格 CSP，主进程拦截非法 `will-navigate` 与外部弹窗。
- **免 Shell 子进程与路径越界守卫**：所有 Agent CLI、Git、`gh`、外部编辑器、Herdr 与 `ego-browser` 均经路径解析后以 `shell: false` 启动；文件读写与外部编辑器打开均受 `isPathInside` + `realpath` 符号链接越界校验。
- **严格 LF JSONL 解码**：拒绝 Node `readline` 截断 `U+2028`/`U+2029` 字符，内置最大帧 16 MiB 的字节级 LF 解码器。

---

## 开发、测试与打包

### 常用命令

```bash
npm install                    # 安装依赖
npm run dev                    # 启动 Electron + Vite HMR 开发模式
npm run typecheck              # 检查 node(main/preload/shared/tests) 与 web(renderer) 类型
npm test                       # 运行 Vitest 单元测试套件
npm run build                  # 构建生产产物至 out/
npm run test:e2e               # 运行 Playwright Electron 端到端回归测试
npm run dist:win               # 构建并打包 Windows NSIS 安装包与绿色便携包至 release/
npm run version:set -- 0.2.0   # 同步更新版本号（支持 semver / patch / minor / major / --print）
```

### Windows 环境与验证提示

- **镜像加速**：若首次安装因 GitHub Release 连接重置无法下载 Electron，可指定国内镜像：
  ```powershell
  $env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
  npm install
  ```
- **打包产物**：运行 `npm run dist:win` 后会在 `release/` 生成：
  - `AgentUI-Setup-<version>-x64.exe`（NSIS 向导安装版，支持自定义目录、桌面/开始菜单快捷方式与卸载）
  - `AgentUI-Portable-<version>-x64.exe`（免安装绿色便携版）
  - `win-unpacked/AgentUI.exe`（可直接用于自动化验收）
- **验证打包后的可执行文件**：
  ```powershell
  $env:AGENTUI_E2E_EXECUTABLE="release\win-unpacked\AgentUI.exe"
  npm run test:e2e
  ```
- **状态隔离**：自动化测试或临时试跑可设置 `AGENTUI_STATE_PATH` 指向临时路径，避免影响默认的 `~/.agentui/state.json`、`schedules.json` 与 `session-index.json`。
