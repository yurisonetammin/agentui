// Herdr（终端复用器）接入的共享类型与纯函数。
// 线协议形状基于本机 herdr 0.9.5 实测：JSON 响应为单行
// `{"id":"cli:<cmd>","result":{...}}` 或 `{"id":"cli:<cmd>","error":{"code","message"}}`。

export type HerdrPaneStatus = 'working' | 'blocked' | 'done' | 'idle' | 'unknown'

export interface HerdrWorkspaceInfo {
  workspaceId: string
  label: string
  number: number
  tabCount: number
  paneCount: number
  agentStatus: HerdrPaneStatus
  focused: boolean
  activeTabId: string | null
}

export interface HerdrTabInfo {
  tabId: string
  workspaceId: string
  label: string
  number: number
  paneCount: number
  agentStatus: HerdrPaneStatus
  focused: boolean
}

export interface HerdrPaneInfo {
  paneId: string
  workspaceId: string
  tabId: string
  terminalId: string | null
  label: string | null
  cwd: string | null
  agentStatus: HerdrPaneStatus
  focused: boolean
}

export interface HerdrAgentInfo {
  name: string
  paneId: string | null
  status: HerdrPaneStatus
}

export interface HerdrSnapshotView {
  version: string | null
  workspaces: HerdrWorkspaceInfo[]
  tabs: HerdrTabInfo[]
  panes: HerdrPaneInfo[]
  agents: HerdrAgentInfo[]
  focusedWorkspaceId: string | null
}

export interface HerdrStatus {
  available: boolean
  path: string | null
  version: string | null
  error: string | null
}

export interface HerdrServerStatus {
  running: boolean
  version: string | null
  error: string | null
}

export type HerdrSessionMode = 'default' | 'agentui'

export interface HerdrAssociation {
  workspaceId: string
  label: string
  cwd: string
  savedAt: number
}

export interface HerdrSettings {
  customPath: string | null
  session: HerdrSessionMode
  /** projectId → 手动关联的 Herdr 工作区 */
  associations: Record<string, HerdrAssociation>
}

export type HerdrLaunchKind = 'pi' | 'omp' | 'prime'

export interface HerdrLaunchResult {
  ok: boolean
  workspaceId: string | null
  paneId: string | null
  agentName: string | null
  error: string | null
}

export type HerdrStreamMode = 'observe' | 'control'

export interface HerdrAttachOptions {
  mode: HerdrStreamMode
  cols: number
  rows: number
  takeover?: boolean
  connectionId?: number
}

/** `agentui:herdrFrame` 事件载荷：base64 ANSI 字节，直接写入 xterm.js。 */
export interface HerdrFrameEvent {
  streamId: string
  paneId: string
  data: string
  seq: number
  cols: number
  rows: number
  full: boolean
}

/** `agentui:herdrStreamClosed` 事件载荷：replaced 表示被同面板新流取代。 */
export interface HerdrStreamClosedEvent {
  streamId: string
  paneId: string
  reason: 'released' | 'closed' | 'error' | 'replaced'
  message: string | null
}

/** 设置页/面板顶部的整体状态：CLI 检测 + 服务运行状态 + 当前会话模式。 */
export interface HerdrStatusReport {
  status: HerdrStatus
  server: HerdrServerStatus
  session: HerdrSessionMode
  connectionId: number
}

export const HERDR_SESSION_AGENTUI = 'agentui'
export const HERDR_AGENT_KINDS: readonly HerdrLaunchKind[] = ['pi', 'omp', 'prime']
export const HERDR_AGENT_KIND_LABELS: Record<HerdrLaunchKind, string> = { pi: 'Pi', omp: 'OMP', prime: 'Prime' }

export const HERDR_STATUS_LABELS: Record<HerdrPaneStatus, string> = {
  working: '运行中',
  blocked: '等待确认',
  done: '已完成',
  idle: '空闲',
  unknown: '未知',
}

export const DEFAULT_HERDR_SETTINGS: HerdrSettings = {
  customPath: null,
  session: 'default',
  associations: {},
}

/** Windows/POSIX 统一的路径比较形式：小写、正斜杠、去尾部分隔符。 */
export function normalizeHerdrPath(value: string | null | undefined): string {
  if (!value) return ''
  let out = value.trim().replace(/\\/g, '/').toLowerCase()
  if (out.length > 3 && out.endsWith('/')) out = out.replace(/\/+$/, '')
  return out
}

type Unknown = Record<string, unknown>

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function asBool(value: unknown): boolean {
  return value === true
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function parsePaneStatus(value: unknown): HerdrPaneStatus {
  return value === 'working' || value === 'blocked' || value === 'done' || value === 'idle' ? value : 'unknown'
}

function asRecord(value: unknown): Unknown | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Unknown) : null
}

/**
 * 从 CLI 输出中提取 herdr JSON 响应信封。herdr 对大多数命令打印单行 JSON，
 * 这里做容错提取（首个 `{` 到末个 `}`），解析失败返回 null。
 */
export function parseHerdrEnvelope(text: string): { result: Unknown | null; error: { code: string; message: string } | null } | null {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1))
    const record = asRecord(parsed)
    if (!record) return null
    const errorRecord = asRecord(record.error)
    if (errorRecord && typeof errorRecord.code === 'string') {
      return {
        result: null,
        error: {
          code: errorRecord.code,
          message: typeof errorRecord.message === 'string' ? errorRecord.message : errorRecord.code,
        },
      }
    }
    return { result: asRecord(record.result), error: null }
  } catch {
    return null
  }
}

/** 展平 CLI 的 result 包装：workspace.list → {workspaces:[…]} / api snapshot → {snapshot:{…}}。 */
function unwrapPayload(result: Unknown | null, key: string): Unknown | null {
  const direct = asRecord(result?.[key])
  if (direct) return direct
  const nested = asRecord(result?.snapshot)
  return asRecord(nested?.[key])
}

export function parseHerdrSnapshot(result: Unknown | null): HerdrSnapshotView {
  // 兼容两种形态：裸载荷（含 workspaces/tabs/…）或 CLI 信封的 result.snapshot 包装。
  const payload = asRecord(result?.snapshot) ?? result
  const workspacesRaw = Array.isArray(payload?.workspaces) ? (payload!.workspaces as unknown[]) : []
  const tabsRaw = Array.isArray(payload?.tabs) ? (payload!.tabs as unknown[]) : []
  const panesRaw = Array.isArray(payload?.panes) ? (payload!.panes as unknown[]) : []
  const agentsRaw = Array.isArray(payload?.agents) ? (payload!.agents as unknown[]) : []
  return {
    version: asString(payload?.version),
    workspaces: workspacesRaw.map(parseWorkspace).filter((w) => w.workspaceId !== ''),
    tabs: tabsRaw.map(parseTab).filter((t) => t.tabId !== ''),
    panes: panesRaw.map(parsePane).filter((p) => p.paneId !== ''),
    agents: agentsRaw.map(parseAgent).filter((a) => a.name !== ''),
    focusedWorkspaceId: asString(payload?.focused_workspace_id),
  }
}

function parseWorkspace(value: unknown): HerdrWorkspaceInfo {
  const rec = asRecord(value)
  return {
    workspaceId: asString(rec?.workspace_id) ?? '',
    label: asString(rec?.label) ?? '未命名',
    number: asNumber(rec?.number, 0),
    tabCount: asNumber(rec?.tab_count, 0),
    paneCount: asNumber(rec?.pane_count, 0),
    agentStatus: parsePaneStatus(rec?.agent_status),
    focused: asBool(rec?.focused),
    activeTabId: asString(rec?.active_tab_id),
  }
}

function parseTab(value: unknown): HerdrTabInfo {
  const rec = asRecord(value)
  return {
    tabId: asString(rec?.tab_id) ?? '',
    workspaceId: asString(rec?.workspace_id) ?? '',
    label: asString(rec?.label) ?? '未命名',
    number: asNumber(rec?.number, 0),
    paneCount: asNumber(rec?.pane_count, 0),
    agentStatus: parsePaneStatus(rec?.agent_status),
    focused: asBool(rec?.focused),
  }
}

function parsePane(value: unknown): HerdrPaneInfo {
  const rec = asRecord(value)
  return {
    paneId: asString(rec?.pane_id) ?? '',
    workspaceId: asString(rec?.workspace_id) ?? '',
    tabId: asString(rec?.tab_id) ?? '',
    terminalId: asString(rec?.terminal_id),
    label: asString(rec?.label),
    cwd: asString(rec?.cwd),
    agentStatus: parsePaneStatus(rec?.agent_status),
    focused: asBool(rec?.focused),
  }
}

function parseAgent(value: unknown): HerdrAgentInfo {
  const rec = asRecord(value)
  return {
    name: asString(rec?.name) ?? '',
    paneId: asString(rec?.pane_id),
    status: parsePaneStatus(rec?.status ?? rec?.agent_status),
  }
}

/** workspace create 响应中的三个 ID：.result.workspace / .result.tab / .result.root_pane。 */
export function parseWorkspaceCreated(result: Unknown | null): { workspaceId: string; tabId: string; paneId: string } | null {
  const workspace = asRecord(result?.workspace)
  const tab = asRecord(result?.tab)
  const pane = asRecord(result?.root_pane ?? result?.pane)
  const workspaceId = asString(workspace?.workspace_id)
  const tabId = asString(tab?.tab_id) ?? asString(workspace?.active_tab_id)
  const paneId = asString(pane?.pane_id)
  if (!workspaceId || !tabId || !paneId) return null
  return { workspaceId, tabId, paneId }
}

/**
 * 为项目挑选 Herdr 工作区：手动关联优先（需仍存在于快照），否则按 cwd 自动匹配
 * ——面板 cwd 等于项目路径，或位于项目路径之下。匹配不到返回 null。
 */
export function matchWorkspaceForProject(
  snapshot: HerdrSnapshotView,
  projectPath: string,
  association?: HerdrAssociation | null,
): HerdrWorkspaceInfo | null {
  if (association?.workspaceId) {
    const saved = snapshot.workspaces.find((w) => w.workspaceId === association.workspaceId)
    if (saved) return saved
  }
  const project = normalizeHerdrPath(projectPath)
  if (!project) return null
  const workspaceIds = new Set(snapshot.workspaces.map((w) => w.workspaceId))
  const exact = new Set<string>()
  const nested = new Set<string>()
  for (const pane of snapshot.panes) {
    const cwd = normalizeHerdrPath(pane.cwd)
    if (!cwd || !workspaceIds.has(pane.workspaceId)) continue
    if (cwd === project) exact.add(pane.workspaceId)
    else if (cwd.startsWith(`${project}/`)) nested.add(pane.workspaceId)
  }
  const pick = (ids: Set<string>): HerdrWorkspaceInfo | null => {
    for (const w of snapshot.workspaces) {
      if (ids.has(w.workspaceId)) return w
    }
    return null
  }
  return pick(exact) ?? pick(nested)
}

export function normalizeHerdrAssociation(value: unknown): HerdrAssociation | null {
  const rec = asRecord(value)
  const workspaceId = asString(rec?.workspaceId)
  if (!workspaceId) return null
  return {
    workspaceId,
    label: asString(rec?.label) ?? '未命名',
    cwd: asString(rec?.cwd) ?? '',
    savedAt: asNumber(rec?.savedAt, 0),
  }
}

/**
 * 解析 `herdr status server` 的 YAML 风格输出（无服务时也能输出）：
 * `status: running|not running`，运行时另有 `version:` 行。
 */
export function parseHerdrStatusServerOutput(text: string): HerdrServerStatus {
  const statusMatch = /^status:\s*(.+?)\s*$/m.exec(text)
  const versionMatch = /^version:\s*(\S+)\s*$/m.exec(text)
  const status = statusMatch?.[1]?.toLowerCase()
  if (status === 'running') return { running: true, version: versionMatch?.[1] ?? null, error: null }
  if (status === 'not running') return { running: false, version: versionMatch?.[1] ?? null, error: null }
  return { running: false, version: null, error: text.trim().slice(0, 240) || null }
}

export function normalizeHerdrSettings(value?: Partial<HerdrSettings> | null): HerdrSettings {
  const associations: Record<string, HerdrAssociation> = {}
  const raw = asRecord(value?.associations)
  if (raw) {
    for (const [projectId, entry] of Object.entries(raw)) {
      const normalized = normalizeHerdrAssociation(entry)
      if (normalized) associations[projectId] = normalized
    }
  }
  return {
    customPath: typeof value?.customPath === 'string' && value.customPath.trim().length > 0 ? value.customPath.trim() : null,
    session: value?.session === 'agentui' ? 'agentui' : 'default',
    associations,
  }
}
