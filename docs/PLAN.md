# AgentUI 项目规划 (Roadmap)

参考桌面标杆：**Codex Desktop**、**DeepSeek Harness (`dsh`)**、**`am-will/gooey-pi` (MIT)** 与 **`zhukunpenglinyutong/desktop-cc-gui`**。

---

## Phase 1 — MVP 最小可用闭环（当前阶段）

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

## Phase 2 — 多协议扩展与高效工作区

目标：补齐 Codex / Claude / ACP / DSH 生态接入，提升长任务会话管理与编辑器协同体验。

1. **通用 Harness / 协议扩展层**：
   - 抽象传输接口，在现有 Pi/OMP/Prime RPC 之外新增 **ACP (`Agent Client Protocol`)**、**Claude Code (`stream-json`)**、**Codex App Server** 与 **`dsh`** 引擎接入。
   - 在 `SettingsModal` 展示引擎能力矩阵（是否支持 steer、worktree/extension UI、context stats、fork）。
2. **会话分支与历史增强**：
   - 利用 Pi `fork` / OMP `branch` 协议构建分支树与「从此处分叉」按钮，实现一题多解对比。
   - 本地会话索引与全文检索（在无 MSVC 时可选 WASM SQLite，或仅保留增量 JSONL 索引）。
3. **高效输入与文件关联**：
   - Composer 支持 `@file` 工作区文件模糊补全、`/` 斜杠命令提示与剪贴板图片粘贴。
   - 右侧面板增加「文件树 + 只读代码高亮」及可选内嵌终端。
   - 使用 `@tanstack/react-virtual` 优化超长 Tool 输出与千条级时间线渲染性能。

---

## Phase 3 — 安全治理、浏览器协同与桌面分发

1. **工具权限与项目信任策略引擎**：
   - 可配置每个项目的权限预设（只读观察 / 常规读写需审批 / 全自动沙盒）。
   - 对敏感 Bash / 删改命令或 Prime 非交互路径增加策略提示与工作区白名单。
2. **`ego-browser` / 浏览器与 MCP 协同面板**：
   - 为浏览器型 MCP 或本地 `ego-browser` 调试会话增加状态徽标与一键唤醒/截屏回贴入口。
3. **自动化测试与安装包分发**：
   - 引入基于 Playwright (`_electron.launch`) 的真实端到端回归套件。
   - 配置 `electron-builder` 生成 Windows NSIS 安装包 / 绿色便携包及版本号注入脚本。
