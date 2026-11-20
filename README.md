# AgentUI

轻量、完全自主可控的多引擎编码 Agent 桌面工作台（Electron 35 + TypeScript + React 19），原生支持 **Pi**、**OMP (`oh-my-pi`)** 与 **Prime Agent** 切换与并发运行。

- 开发者与 Agent 协作约定：[AGENTS.md](AGENTS.md)
- 当前开发进度与变更日志：[docs/STATUS.md](docs/STATUS.md)
- 分阶段路线图：[docs/PLAN.md](docs/PLAN.md)

## 核心能力

- **三引擎自动探测与并发切换**：免 Shell 自动探测本地 `pi`、`omp`、`prime-agent`（含 Windows `pi.cmd` / `install/current-version` / `prime-agent.cmd` 解析与 OMP `PI_CONFIG_DIR` 修复），按会话绑定引擎，后台多进程并行互不干扰。
- **原生 RPC 协议适配**：
  - 严格按 `LF` 切分的 UTF-8 JSONL 解码器（安全保留 `U+2028`/`U+2029`）。
  - **Pi** (`--mode rpc`)、**OMP** (`--mode rpc` + 协议 v2 握手 + `rpc_chunk` Base64 分片重组)、**Prime Agent** (`--mode rpc`，兼容 Rust 0.10.x)。
  - 实时流式 Markdown（支持代码块一键复制）、可折叠 Thinking 过程、Tool Call 参数/结果/耗时卡片、多会话排队式 `extension_ui_request` 交互审批弹窗、Steer / Follow-up 排队与 Abort 中断。
- **Git Worktree 与 Diff 审阅**：
  - 为任务创建隔离 Git Worktree 并立即开启对应会话，支持在已有 Worktree 中快速新开对话。
  - 右侧审阅抽屉实时刷新变更文件、预览暂存/未暂存/未跟踪文件 Diff、支持 Stage / Unstage / Discard / Commit。
- **历史会话恢复与快捷管理**：
  - 扫描各引擎原生 `.jsonl` 会话并一键恢复；支持侧栏项目/分支搜索过滤与会话双击内联重命名。

## 开发与验证

```bash
npm install
npm run typecheck
npm test
npm run build
npm run dev
```

### Windows 环境补充说明

- 若安装阶段因 GitHub Release 连接重置无法下载 Electron 二进制包，可通过代理或国内镜像安装：
  ```powershell
  $env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
  npm install
  ```
- 运行隔离测试或冒烟脚本时，可设置 `AGENTUI_STATE_PATH` 指定独立的持久化状态文件，避免覆盖 `~/.agentui/state.json`。
