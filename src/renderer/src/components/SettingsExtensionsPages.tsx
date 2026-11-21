import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AppWindow,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Eye,
  FolderGit2,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Upload,
} from 'lucide-react'
import type {
  BrowserStatus,
  HarnessId,
  ProjectEntry,
} from '@shared/types'
import {
  EXTENSION_ENGINE_CAPABILITIES,
  EXTENSION_ENGINE_LABELS,
  EXTENSION_ENGINES,
  type EnginePackageSnapshot,
  type EngineSkillEntry,
  type EngineSkillSnapshot,
  type ExtensionEngine,
  type McpEngineSnapshot,
  type UsageFilters,
  type UsageReport,
} from '@shared/extensions'
import { errorText, Segments } from './SettingsControls'
import { MarkdownView } from './MarkdownView'

export function EngineSwitcher({ engine, onChange }: { engine: ExtensionEngine; onChange: (engine: ExtensionEngine) => void }) {
  return <Segments
    labelId="extension-engine-label"
    value={engine}
    onChange={(next) => onChange(next as ExtensionEngine)}
    options={EXTENSION_ENGINES.map((id) => ({ value: id, label: EXTENSION_ENGINE_LABELS[id] }))}
  />
}

function ProjectBadge({ projects, activeProjectId }: { projects: ProjectEntry[]; activeProjectId: string | null }) {
  const project = projects.find((p) => p.id === activeProjectId)
  if (!project) {
    return <span className="settings-indicator"><FolderGit2 size={13} />未选择项目（仅用户级配置）</span>
  }
  return <span className="settings-indicator" title={project.path}><FolderGit2 size={13} />当前项目：{project.name}</span>
}

function EngineHeader({ engine, projectPath, ready, version, onRefresh, busy, children }: {
  engine: ExtensionEngine
  projectPath: string | null
  ready: boolean
  version: string | null
  onRefresh: () => void
  busy: boolean
  children?: React.ReactNode
}) {
  return <div className="settings-page-heading settings-engine-heading">
    <div>
      <h1>{EXTENSION_ENGINE_LABELS[engine]}</h1>
      <p>
        {ready ? `CLI 就绪${version ? ` · ${version}` : ''}` : '引擎未就绪：请先在「引擎与模型」中配置 CLI 路径'}
        {projectPath ? ` · 项目 ${projectPath.split(/[\\/]/).pop()}` : ' · 未选择项目'}
      </p>
    </div>
    <div className="settings-actions">
      {children}
      <button type="button" className="btn-small" disabled={busy} onClick={onRefresh}>
        <RefreshCw size={13} className={busy ? 'spin' : undefined} />{busy ? '刷新中…' : '刷新'}
      </button>
    </div>
  </div>
}

// ─────────────────────────────────────────────────────────────────────────────
// MCP
// ─────────────────────────────────────────────────────────────────────────────

interface McpFormState {
  open: boolean
  scope: 'user' | 'project'
  transport: 'stdio' | 'http'
  name: string
  command: string
  args: string
  cwd: string
  env: string
  url: string
  headers: string
  bearerTokenEnvVar: string
  description: string
}

const EMPTY_MCP_FORM: McpFormState = {
  open: false, scope: 'user', transport: 'stdio', name: '', command: '', args: '', cwd: '',
  env: '', url: '', headers: '', bearerTokenEnvVar: '', description: '',
}

function parseKeyValueLines(text: string): Array<{ key: string; value: string }> {
  return text.split(/\r?\n/).map((line) => {
    const idx = line.indexOf('=')
    return idx === -1 ? { key: line.trim(), value: '' } : { key: line.slice(0, idx).trim(), value: line.slice(idx + 1) }
  }).filter((pair) => pair.key)
}

function McpServerRow({ server, onRemove, busy }: { server: McpEngineSnapshot['servers'][number]; onRemove: (scope: 'user' | 'project', name: string) => void; busy: boolean }) {
  const [expanded, setExpanded] = useState(false)
  const scopeLabel = server.scope === 'user' ? '用户级' : server.scope === 'project' ? '项目级' : '第三方'
  const endpoint = server.transport === 'stdio'
    ? [server.command, ...(server.args ?? [])].join(' ')
    : server.url ?? ''
  return <div className="ext-server-row">
    <button type="button" className="ext-server-main" aria-expanded={expanded} onClick={() => setExpanded((v) => !v)}>
      <ChevronRight size={13} className={expanded ? 'project-chevron expanded' : 'project-chevron'} />
      <div className="ext-server-copy">
        <div>
          <strong>{server.name}</strong>
          <span className={`ext-badge${server.managed ? ' managed' : ''}`}>{scopeLabel} · {server.transport}</span>
          {server.enabled === false && <span className="ext-badge">已停用</span>}
          {server.live?.state && <span className="ext-badge">{server.live.state}{server.live.toolCount !== undefined ? ` · ${server.live.toolCount} 工具` : ''}</span>}
          {server.live?.error && <span className="ext-badge is-error">连接失败</span>}
          {server.shadowedBy && <span className="ext-badge is-shadow" title={`同名配置由 ${server.shadowedBy} 提供，当前不生效`}>被覆盖</span>}
        </div>
        <small>{server.sourceLabel}</small>
        <code className="ext-endpoint">{endpoint || '(无端点)'}</code>
      </div>
    </button>
    {server.deletable && !server.shadowedBy && (
      <button type="button" className="icon-btn" title={`删除 ${server.name}`} aria-label={`删除 ${server.name}`}
        disabled={busy} onClick={() => onRemove(server.scope === 'project' ? 'project' : 'user', server.name)}>
        <Trash2 size={13} />
      </button>
    )}
    {expanded && <div className="ext-server-detail">
      <dl className="settings-engine-meta">
        <dt>来源文件</dt><dd>{server.source}</dd>
        {server.transport === 'stdio' && server.cwd && <><dt>工作目录</dt><dd>{server.cwd}</dd></>}
        {server.envKeys?.length && <><dt>环境变量</dt><dd>{server.envKeys.join(', ')}（值由引擎管理）</dd></>}
        {server.headerKeys?.length && <><dt>请求头</dt><dd>{server.headerKeys.join(', ')}（值由引擎管理）</dd></>}
        {server.description && <><dt>描述</dt><dd>{server.description}</dd></>}
        {server.live?.error && <><dt>实况错误</dt><dd>{server.live.error}</dd></>}
        {server.shadowedBy && <><dt>覆盖关系</dt><dd>同名/同端点配置由「{server.shadowedBy}」提供，本条不生效</dd></>}
      </dl>
    </div>}
  </div>
}

export function McpSettingsPage({ engine, onEngineChange, projects, activeProjectId, harnesses }: {
  engine: ExtensionEngine
  onEngineChange: (engine: ExtensionEngine) => void
  projects: ProjectEntry[]
  activeProjectId: string | null
  harnesses: Record<ExtensionEngine, { ready: boolean; version: string | null }>
}) {
  const projectPath = useMemo(() => projects.find((p) => p.id === activeProjectId)?.path ?? null, [projects, activeProjectId])
  const [snapshot, setSnapshot] = useState<McpEngineSnapshot | null>(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [feedback, setFeedback] = useState<string | null>(null)
  const [form, setForm] = useState<McpFormState>(EMPTY_MCP_FORM)
  const requestRef = useRef(0)

  const caps = EXTENSION_ENGINE_CAPABILITIES[engine]
  const load = useCallback(async (engineArg: ExtensionEngine, path: string | null) => {
    const request = ++requestRef.current
    setLoading(true)
    setError(null)
    try {
      const snap = await window.agentui.getEngineMcp(engineArg, path)
      if (requestRef.current === request) setSnapshot(snap)
    } catch (err) {
      if (requestRef.current === request) setError(errorText(err))
    } finally {
      if (requestRef.current === request) setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load(engine, projectPath)
    return () => { requestRef.current += 1 }
  }, [engine, projectPath, load])

  async function removeServer(scope: 'user' | 'project', name: string) {
    setBusy(true)
    setError(null)
    setFeedback(null)
    try {
      const snap = await window.agentui.mcpRemoveServer(engine, scope, name, projectPath)
      setSnapshot(snap)
      setFeedback(`已删除 ${name}。`)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  async function checkLive() {
    setBusy(true)
    setError(null)
    try {
      const snap = await window.agentui.mcpCheckLive(engine, projectPath)
      setSnapshot(snap)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  async function submitAdd() {
    setBusy(true)
    setError(null)
    setFeedback(null)
    try {
      const input = {
        engine,
        scope: form.scope,
        name: form.name.trim(),
        transport: form.transport,
        command: form.command.trim() || undefined,
        args: form.args.trim() ? form.args.trim().split(/\s+/) : undefined,
        cwd: form.cwd.trim() || undefined,
        env: parseKeyValueLines(form.env),
        url: form.url.trim() || undefined,
        headers: parseKeyValueLines(form.headers),
        bearerTokenEnvVar: form.bearerTokenEnvVar.trim() || undefined,
        description: form.description.trim() || undefined,
      }
      const snap = await window.agentui.mcpAddServer(input, projectPath)
      setSnapshot(snap)
      setForm(EMPTY_MCP_FORM)
      setFeedback(`已添加 ${input.name}。${snap.sessionState.detail}`)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  const managed = snapshot?.servers.filter((s) => s.scope !== 'third-party') ?? []
  const thirdParty = snapshot?.servers.filter((s) => s.scope === 'third-party') ?? []

  return <div className="settings-extensions-page">
    <EngineHeader engine={engine} projectPath={projectPath} ready={harnesses[engine].ready}
      version={harnesses[engine].version} onRefresh={() => void load(engine, projectPath)} busy={loading || busy}>
      <ProjectBadge projects={projects} activeProjectId={activeProjectId} />
      <EngineSwitcher engine={engine} onChange={onEngineChange} />
    </EngineHeader>

    {error && <p className="settings-feedback is-error" role="alert"><CircleAlert size={14} />{error}</p>}
    {feedback && <p className="settings-feedback is-success" role="status"><Check size={14} />{feedback}</p>}

    {snapshot && <>
      <section className="settings-card settings-section">
        <div className="settings-section-heading">
          <h2>生效状态</h2>
          <span className="settings-indicator"><span className={`dot ${snapshot.sessionState.hasLiveSession ? 'dot-ready' : 'dot-idle'}`} />
            {snapshot.sessionState.hasLiveSession ? '有运行中会话' : '无运行中会话'}</span>
        </div>
        <p className="settings-caption">{snapshot.sessionState.detail}</p>
        {caps.mcp.note && <p className="settings-caption">{caps.mcp.note}</p>}
        {engine === 'pi' && caps.mcp.liveCheck && <div className="settings-actions">
          <button type="button" className="btn-small" disabled={busy || !snapshot.engineReady} onClick={() => void checkLive()}>
            <RefreshCw size={12} className={busy ? 'spin' : undefined} />检查服务器实况（会实际连接）
          </button>
        </div>}
        {snapshot.errors.length > 0 && snapshot.errors.map((err) => (
          <p key={err} className="settings-feedback is-error"><CircleAlert size={13} />{err}</p>
        ))}
      </section>

      <section className="settings-card settings-section">
        <h2>配置来源</h2>
        <div className="ext-source-list">
          {snapshot.configFiles.map((file) => (
            <div key={`${file.path}-${file.label}`} className="ext-source-row">
              <span className={`dot ${file.exists ? 'dot-ready' : 'dot-idle'}`} />
              <div className="ext-server-copy">
                <div>
                  <strong>{file.label}</strong>
                  {file.writable && <span className="ext-badge managed">AgentUI 可编辑</span>}
                  {file.scope === 'third-party' && <span className="ext-badge">只读展示</span>}
                </div>
                <code className="ext-endpoint">{file.path}</code>
                {file.note && <small>{file.note}</small>}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="settings-card settings-section">
        <div className="settings-section-heading">
          <h2>服务器（用户级 / 项目级）</h2>
          <button type="button" className="btn-small" onClick={() => setForm((prev) => ({ ...EMPTY_MCP_FORM, open: !prev.open }))}>
            <Plus size={13} />{form.open ? '收起' : '添加服务器'}
          </button>
        </div>
        {form.open && (
          <div className="ext-add-form">
            <div className="ext-form-grid">
              <label>作用范围
                <select className="text-input" value={form.scope} disabled={busy}
                  onChange={(event) => setForm((prev) => ({ ...prev, scope: event.target.value as 'user' | 'project' }))}>
                  <option value="user">用户级</option>
                  {caps.mcp.manageProject && <option value="project">项目级</option>}
                </select>
              </label>
              <label>类型
                <select className="text-input" value={form.transport} disabled={busy}
                  onChange={(event) => setForm((prev) => ({ ...prev, transport: event.target.value as 'stdio' | 'http' }))}>
                  <option value="stdio">本地命令（stdio）</option>
                  <option value="http">远程服务器（http）</option>
                </select>
              </label>
              <label>名称
                <input className="text-input" value={form.name} disabled={busy} placeholder="如 github-mcp"
                  onChange={(event) => setForm((prev) => ({ ...prev, name: event.target.value }))} />
              </label>
            </div>
            {form.transport === 'stdio' ? <div className="ext-form-grid">
              <label>启动命令
                <input className="text-input" value={form.command} disabled={busy} placeholder="npx"
                  onChange={(event) => setForm((prev) => ({ ...prev, command: event.target.value }))} />
              </label>
              <label>参数（空格分隔）
                <input className="text-input" value={form.args} disabled={busy} placeholder="-y @scope/server"
                  onChange={(event) => setForm((prev) => ({ ...prev, args: event.target.value }))} />
              </label>
              <label>环境变量（每行 KEY=VALUE）
                <input className="text-input" value={form.env} disabled={busy} placeholder="API_KEY=xxx"
                  onChange={(event) => setForm((prev) => ({ ...prev, env: event.target.value }))} />
              </label>
            </div> : <div className="ext-form-grid">
              <label>URL
                <input className="text-input" value={form.url} disabled={busy} placeholder="https://example.com/mcp"
                  onChange={(event) => setForm((prev) => ({ ...prev, url: event.target.value }))} />
              </label>
              <label>请求头（每行 KEY=VALUE）
                <input className="text-input" value={form.headers} disabled={busy}
                  onChange={(event) => setForm((prev) => ({ ...prev, headers: event.target.value }))} />
              </label>
              <label>Bearer Token 环境变量名
                <input className="text-input" value={form.bearerTokenEnvVar} disabled={busy} placeholder="MY_TOKEN"
                  onChange={(event) => setForm((prev) => ({ ...prev, bearerTokenEnvVar: event.target.value }))} />
              </label>
            </div>}
            <div className="ext-form-grid">
              <label>描述（可选，写入系统提示）
                <input className="text-input" value={form.description} disabled={busy}
                  onChange={(event) => setForm((prev) => ({ ...prev, description: event.target.value }))} />
              </label>
            </div>
            <div className="settings-actions">
              <button type="button" className="btn-primary" disabled={busy || !form.name.trim()} onClick={() => void submitAdd()}>
                {busy ? '添加中…' : '添加'}
              </button>
            </div>
            <p className="settings-caption">
              {engine === 'pi' && '经 pi mcp add 写入引擎自己的配置；认证与 OAuth 登录由 pi 管理（pi mcp login）。添加本地服务器展示的命令与参数会原样传给引擎。'}
              {engine === 'omp' && '写入 OMP 自有配置（用户级 mcp.json 或项目 .omp/mcp.json）；第三方来源的文件只读展示。'}
              {engine === 'prime' && '经 prime-agent mcp add 管理；服务器通过 Python 运行环境供引擎调用，认证交给 Prime。'}
            </p>
          </div>
        )}
        {managed.length === 0 && <p className="settings-caption">暂无用户级或项目级服务器。</p>}
        {managed.map((server) => (
          <McpServerRow key={`${server.source}|${server.name}`} server={server} busy={busy} onRemove={(scope, name) => void removeServer(scope, name)} />
        ))}
      </section>

      {thirdParty.length > 0 && <section className="settings-card settings-section">
        <h2>第三方发现来源（被 OMP 识别的配置）</h2>
        <p className="settings-caption">同名配置第一次定义获胜：更高优先级来源的同名/同端点条目会把下面这些标记为「被覆盖」。项目级条目在用户级之前生效。</p>
        {thirdParty.map((server) => (
          <McpServerRow key={`${server.source}|${server.name}`} server={server} busy={busy} onRemove={() => undefined} />
        ))}
      </section>}
    </>}
    {loading && !snapshot && <p className="settings-caption" role="status">正在读取 MCP 配置…</p>}
  </div>
}

// ─────────────────────────────────────────────────────────────────────────────
// 插件
// ─────────────────────────────────────────────────────────────────────────────

export function PluginsSettingsPage({ engine, onEngineChange, projects, activeProjectId, harnesses }: {
  engine: ExtensionEngine
  onEngineChange: (engine: ExtensionEngine) => void
  projects: ProjectEntry[]
  activeProjectId: string | null
  harnesses: Record<ExtensionEngine, { ready: boolean; version: string | null }>
}) {
  const projectPath = useMemo(() => projects.find((p) => p.id === activeProjectId)?.path ?? null, [projects, activeProjectId])
  const [snapshot, setSnapshot] = useState<EnginePackageSnapshot | null>(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [feedback, setFeedback] = useState<string | null>(null)
  const [source, setSource] = useState('')
  const [scope, setScope] = useState<'user' | 'project'>('user')
  const [expanded, setExpanded] = useState<string | null>(null)
  /** 两步确认：点击「安装」后先展示来源/作用范围摘要。 */
  const [confirmSource, setConfirmSource] = useState<string | null>(null)

  const caps = EXTENSION_ENGINE_CAPABILITIES[engine]
  const installScope = caps.packages.projectScope ? scope : 'user'
  const load = useCallback(async (engineArg: ExtensionEngine, path: string | null) => {
    setLoading(true)
    setError(null)
    try {
      const snap = await window.agentui.getEnginePackages(engineArg, path)
      setSnapshot(snap)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    setConfirmSource(null)
    void load(engine, projectPath)
  }, [engine, projectPath, load])

  async function action(fn: () => Promise<EnginePackageSnapshot>, successText: string) {
    setBusy(true)
    setError(null)
    setFeedback(null)
    try {
      const snap = await fn()
      setSnapshot(snap)
      setFeedback(successText)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return <div className="settings-extensions-page">
    <EngineHeader engine={engine} projectPath={projectPath} ready={harnesses[engine].ready}
      version={harnesses[engine].version} onRefresh={() => void load(engine, projectPath)} busy={loading || busy}>
      <ProjectBadge projects={projects} activeProjectId={activeProjectId} />
      <EngineSwitcher engine={engine} onChange={onEngineChange} />
    </EngineHeader>

    {error && <p className="settings-feedback is-error" role="alert"><CircleAlert size={14} />{error}</p>}
    {feedback && <p className="settings-feedback is-success" role="status"><Check size={14} />{feedback}</p>}

    <section className="settings-card settings-section">
      <div className="settings-section-heading">
        <h2>安装插件</h2>
      </div>
      <div className="ext-add-form">
        <div className="ext-form-grid">
          <label>包来源
            <input className="text-input" value={source} disabled={busy || !snapshot?.engineReady}
              placeholder={engine === 'omp' ? 'marketplace:name 或本地路径' : engine === 'pi' ? 'npm:@scope/pkg 或 git:github.com/user/repo' : 'npm:@scope/pkg 或本地路径'}
              onChange={(event) => setSource(event.target.value)} />
          </label>
          <label>作用范围
            <select className="text-input" value={installScope} disabled={busy || !caps.packages.projectScope}
              onChange={(event) => setScope(event.target.value as 'user' | 'project')}>
              <option value="user">用户级</option>
              {caps.packages.projectScope && <option value="project">项目级</option>}
            </select>
          </label>
        </div>
        <div className="settings-actions">
          <button type="button" className="btn-primary" disabled={busy || !source.trim() || !snapshot?.engineReady || confirmSource !== null}
            onClick={() => setConfirmSource(source.trim())}>
            <Upload size={13} />{busy ? '安装中…' : '安装'}
          </button>
          {caps.packages.update && <button type="button" className="btn-small" disabled={busy || !snapshot?.engineReady}
            onClick={() => void action(() => window.agentui.packageUpdate(engine, null, 'user', projectPath), '已开始更新全部用户级插件。')}>
            更新全部
          </button>}
        </div>
        {confirmSource && (
          <div className="ext-confirm-panel" role="group" aria-label="安装确认">
            <dl className="settings-engine-meta">
              <dt>来源</dt><dd>{confirmSource}</dd>
              <dt>作用范围</dt><dd>{installScope === 'project' ? '项目级（仅当前项目生效）' : '用户级（全部会话）'}</dd>
              <dt>引擎</dt><dd>{EXTENSION_ENGINE_LABELS[engine]}</dd>
            </dl>
            <p className="settings-caption">
              版本与包含的可执行资源（技能 / 提示模板 / 主题）由引擎在安装后解析，完成后可在下方列表展开查看；
              资源在下次启动会话时加载。
            </p>
            <div className="settings-actions">
              <button type="button" className="btn-primary" disabled={busy}
                onClick={() => {
                  const target = confirmSource
                  setConfirmSource(null)
                  void action(
                    () => window.agentui.packageInstall(engine, target, installScope, projectPath),
                    `已安装 ${target}。安装的资源在下次启动会话时加载。`,
                  )
                }}>
                确认安装
              </button>
              <button type="button" className="btn-small" disabled={busy} onClick={() => setConfirmSource(null)}>取消</button>
            </div>
          </div>
        )}
        <p className="settings-caption">{caps.packages.note}</p>
      </div>
    </section>

    <section className="settings-card settings-section">
      <h2>已安装插件</h2>
      {snapshot?.errors.map((err) => <p key={err} className="settings-feedback is-error"><CircleAlert size={13} />{err}</p>)}
      {snapshot?.raw && <pre className="ext-raw">{snapshot.raw}</pre>}
      {snapshot && snapshot.packages.length === 0 && <p className="settings-caption">暂无已安装插件。</p>}
      {snapshot?.packages.map((pkg) => (
        <div key={pkg.id} className="ext-server-row">
          <button type="button" className="ext-server-main" aria-expanded={expanded === pkg.id}
            onClick={() => setExpanded(expanded === pkg.id ? null : pkg.id)}>
            <ChevronRight size={13} className={expanded === pkg.id ? 'project-chevron expanded' : 'project-chevron'} />
            <div className="ext-server-copy">
              <div>
                <strong>{pkg.name}</strong>
                {pkg.version && <span className="ext-badge">v{pkg.version}</span>}
                <span className="ext-badge">{pkg.scope === 'project' ? '项目级' : pkg.scope === 'local' ? '本地目录' : '用户级'}</span>
                <span className="ext-badge">{pkg.manager}</span>
              </div>
              <small>{pkg.description ?? pkg.path ?? ''}</small>
            </div>
          </button>
          <div className="settings-actions">
            {caps.packages.update && <button type="button" className="btn-small" disabled={busy}
              onClick={() => void action(
                () => window.agentui.packageUpdate(engine, pkg.name, pkg.scope === 'project' ? 'project' : 'user', projectPath),
                `已更新 ${pkg.name}。`,
              )}>更新</button>}
            {caps.packages.remove && <button type="button" className="btn-small" disabled={busy} title={`卸载 ${pkg.name}`}
              onClick={() => void action(() => window.agentui.packageRemove(engine, pkg.name, pkg.scope === 'project' ? 'project' : 'user', projectPath), `已卸载 ${pkg.name}。`)}>
              <Trash2 size={12} /> 卸载
            </button>}
          </div>
          {expanded === pkg.id && <div className="ext-server-detail">
            <dl className="settings-engine-meta">
              <dt>来源</dt><dd>{pkg.id}</dd>
              <dt>作用范围</dt><dd>{pkg.scope === 'project' ? '项目级（仅当前项目生效）' : pkg.scope === 'local' ? '本地目录链接' : '用户级（全部会话）'}</dd>
              {pkg.path && <><dt>安装位置</dt><dd>{pkg.path}</dd></>}
              {pkg.resources?.length ? <><dt>包含资源</dt><dd>{pkg.resources.join('、')}</dd></> : null}
              <dt>可执行扩展</dt><dd>技能 / 模板 / 主题资源在下次启动会话时加载；技能可在「技能」页预览。</dd>
            </dl>
          </div>}
        </div>
      ))}
    </section>
  </div>
}

// ─────────────────────────────────────────────────────────────────────────────
// 技能
// ─────────────────────────────────────────────────────────────────────────────

export function SkillsSettingsPage({ engine, onEngineChange, projects, activeProjectId, harnesses, sessionEngine, sessionCommands, onInsertToComposer }: {
  engine: ExtensionEngine
  onEngineChange: (engine: ExtensionEngine) => void
  projects: ProjectEntry[]
  activeProjectId: string | null
  harnesses: Record<ExtensionEngine, { ready: boolean; version: string | null }>
  /** 当前活动会话所属引擎：只有与技能页引擎一致时才用命令名标记「会话已加载」。 */
  sessionEngine: HarnessId | null
  /** 当前活动会话已注册的斜杠命令名（用于标记「会话已加载」）。 */
  sessionCommands: string[]
  onInsertToComposer: (text: string) => void
}) {
  const projectPath = useMemo(() => projects.find((p) => p.id === activeProjectId)?.path ?? null, [projects, activeProjectId])
  const [snapshot, setSnapshot] = useState<EngineSkillSnapshot | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [preview, setPreview] = useState<{ name: string; content: string; truncated: boolean } | null>(null)
  const [previewBusy, setPreviewBusy] = useState(false)

  const load = useCallback(async (engineArg: ExtensionEngine, path: string | null) => {
    setLoading(true)
    setError(null)
    try {
      const snap = await window.agentui.getEngineSkills(engineArg, path)
      setSnapshot(snap)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load(engine, projectPath)
  }, [engine, projectPath, load])

  const filtered = useMemo(() => {
    const skills = snapshot?.skills ?? []
    const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean)
    if (!terms.length) return skills
    return skills.filter((skill) => terms.every((term) =>
      `${skill.name} ${skill.description ?? ''} ${skill.originLabel}`.toLowerCase().includes(term)))
  }, [snapshot, query])

  const commandSet = useMemo(() => new Set(sessionCommands.map((name) => name.toLowerCase())), [sessionCommands])

  async function openPreview(skill: EngineSkillEntry) {
    setPreviewBusy(true)
    setError(null)
    try {
      const file = await window.agentui.readSkillFile(skill.filePath)
      setPreview({ name: skill.name, content: file.content, truncated: file.truncated })
    } catch (err) {
      setError(errorText(err))
    } finally {
      setPreviewBusy(false)
    }
  }

  /** Pi 文档规定的强制调用形式是 /skill:名称；其他引擎优先用会话里注册的原名。 */
  function insertSkill(skill: EngineSkillEntry) {
    if (skill.engine === 'pi') {
      onInsertToComposer(`/skill:${skill.name}`)
      return
    }
    const registered = commandSet.has(skill.name.toLowerCase())
    onInsertToComposer(registered ? `/${skill.name}` : `/skill:${skill.name}`)
  }

  return <div className="settings-extensions-page">
    <EngineHeader engine={engine} projectPath={projectPath} ready={harnesses[engine].ready}
      version={harnesses[engine].version} onRefresh={() => void load(engine, projectPath)} busy={loading}>
      <ProjectBadge projects={projects} activeProjectId={activeProjectId} />
      <EngineSwitcher engine={engine} onChange={onEngineChange} />
    </EngineHeader>

    {error && <p className="settings-feedback is-error" role="alert"><CircleAlert size={14} />{error}</p>}
    {snapshot?.errors.map((err) => <p key={err} className="settings-feedback is-error"><CircleAlert size={13} />{err}</p>)}
    {snapshot?.note && <section className="settings-card settings-section"><p className="settings-caption">{snapshot.note}</p></section>}

    <section className="settings-card settings-section">
      <div className="settings-section-heading">
        <h2>技能目录（{filtered.length}）</h2>
        <label className="settings-search ext-skill-search">
          <Search size={14} />
          <input aria-label="搜索技能" placeholder="搜索名称、描述或来源" value={query} onChange={(event) => setQuery(event.target.value)} />
        </label>
      </div>
      {filtered.length === 0 && <p className="settings-caption">{loading ? '正在扫描技能…' : '没有匹配的技能。'}</p>}
      {filtered.map((skill) => {
        // 只有当前活动会话就属于该引擎时，命令名匹配才有意义；跨引擎同名技能不误标
        const loaded = sessionEngine === engine && commandSet.has(skill.name.toLowerCase())
        return <div key={`${skill.filePath}|${skill.name}`} className="ext-server-row">
          <div className="ext-server-main">
            <div className="ext-server-copy">
              <div>
                <strong>{skill.name}</strong>
                <span className="ext-badge">{skill.originLabel}</span>
                {skill.executable && <span className="ext-badge">{loaded ? '会话已加载' : '可调用'}</span>}
                {!skill.executable && <span className="ext-badge is-shadow">项目指令 · 不可斜杠调用</span>}
              </div>
              <small className="ext-skill-desc">{skill.description ?? ''}</small>
              <code className="ext-endpoint">{skill.filePath}</code>
            </div>
          </div>
          <div className="settings-actions">
            <button type="button" className="btn-small" disabled={previewBusy} onClick={() => void openPreview(skill)}>
              <Eye size={12} />{previewBusy ? '加载中…' : '预览'}
            </button>
            {skill.executable && <button type="button" className="btn-small" title="插入到输入框"
              onClick={() => insertSkill(skill)}>
              插入 /{skill.name}
            </button>}
          </div>
        </div>
      })}
    </section>

    {preview && (
      <section className="settings-card settings-section">
        <div className="settings-section-heading">
          <h2>预览：{preview.name}</h2>
          <button type="button" className="btn-small" onClick={() => setPreview(null)}><ChevronDown size={13} />收起</button>
        </div>
        {preview.truncated && <p className="settings-caption">内容过长，仅显示前 256KB。</p>}
        <div className="ext-skill-preview"><MarkdownView content={preview.content} /></div>
      </section>
    )}
  </div>
}

// ─────────────────────────────────────────────────────────────────────────────
// 使用情况
// ─────────────────────────────────────────────────────────────────────────────

function formatTokens(value: number | null): string {
  if (value === null) return '未提供'
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return String(value)
}

function formatCost(value: number | null): string {
  if (value === null) return '未提供'
  return `$${value.toFixed(value < 1 ? 4 : 2)}`
}

/** 费用标签：缺数据「未提供」；只覆盖部分调用时明确标注，避免误读为完整估算。 */
function costLabel(row: { costTotal: number | null; costCalls: number; calls: number }): string {
  if (row.costTotal === null) return '未提供'
  const base = formatCost(row.costTotal)
  return row.costCalls < row.calls ? `${base}（部分：${row.costCalls}/${row.calls} 次调用含费用）` : base
}

export function UsageSettingsPage({ projects }: { projects: ProjectEntry[] }) {
  const [filters, setFilters] = useState<UsageFilters>({})
  const [report, setReport] = useState<UsageReport | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (nextFilters: UsageFilters, refresh: boolean) => {
    setLoading(true)
    setError(null)
    try {
      const data = await window.agentui.getUsageReport(nextFilters, refresh)
      setReport(data)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load(filters, false)
  }, [filters, load])

  const patch = (next: Partial<UsageFilters>) => setFilters((prev) => ({ ...prev, ...next }))

  return <div className="settings-extensions-page">
    <div className="settings-page-heading settings-engine-heading">
      <div><h1>使用情况</h1><p>本地报表：按日期、项目、引擎和模型筛选。项目统计按单次模型调用去重，恢复会话、分叉和历史回放不会重复入账。</p></div>
      <div className="settings-actions">
        <button type="button" className="btn-small" disabled={loading} onClick={() => void load(filters, true)}>
          <RefreshCw size={13} className={loading ? 'spin' : undefined} />{loading ? '刷新中…' : '刷新'}
        </button>
      </div>
    </div>

    <section className="settings-card settings-section">
      <h2>筛选</h2>
      <div className="ext-usage-filters">
        <label>开始日期<input type="date" className="text-input" value={filters.from ?? ''} onChange={(e) => patch({ from: e.target.value || null })} /></label>
        <label>结束日期<input type="date" className="text-input" value={filters.to ?? ''} onChange={(e) => patch({ to: e.target.value || null })} /></label>
        <label>项目
          <select className="text-input" value={filters.projectId ?? ''} onChange={(e) => patch({ projectId: e.target.value || null })}>
            <option value="">全部项目</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        <label>引擎
          <select className="text-input" value={filters.engine ?? 'all'} onChange={(e) => patch({ engine: (e.target.value || 'all') as UsageFilters['engine'] })}>
            <option value="all">全部引擎</option>
            <option value="pi">Pi</option>
            <option value="omp">OMP</option>
            <option value="prime">Prime Agent</option>
            <option value="claude">Claude Code</option>
          </select>
        </label>
        <label>模型
          <select className="text-input" value={filters.model ?? ''} onChange={(e) => patch({ model: e.target.value || null })}>
            <option value="">全部模型</option>
            {(report?.byModel ?? []).map((row) => <option key={`${row.engine}/${row.model}`} value={row.model}>{row.model}</option>)}
          </select>
        </label>
      </div>
    </section>

    {error && <p className="settings-feedback is-error" role="alert"><CircleAlert size={14} />{error}</p>}
    {report?.warnings.map((w) => <p key={w} className="settings-caption"><CircleAlert size={12} /> {w}</p>)}

    {report && <>
      <div className="ext-usage-cards">
        <section className="settings-card settings-section">
          <h2>Token 消耗</h2>
          <dl className="settings-engine-meta">
            <dt>输入</dt><dd>{formatTokens(report.totals.input)}</dd>
            <dt>输出</dt><dd>{formatTokens(report.totals.output)}</dd>
            <dt>缓存读取</dt><dd>{formatTokens(report.totals.cacheRead)}</dd>
            <dt>缓存写入</dt><dd>{formatTokens(report.totals.cacheWrite)}</dd>
            <dt>模型调用</dt><dd>{report.totals.calls} 次</dd>
            <dt>估算费用</dt><dd>{costLabel(report.totals)}</dd>
          </dl>
        </section>
        <section className="settings-card settings-section">
          <h2>上下文占用（活动会话）</h2>
          {report.contextUsage.length === 0 && <p className="settings-caption">暂无运行中的会话。</p>}
          <dl className="settings-engine-meta">
            {report.contextUsage.map((ctx) => (
              <div className="settings-meta-pair" key={ctx.threadId}>
                <dt>{ctx.title.slice(0, 18)} · {ctx.engine}</dt>
                <dd>{ctx.tokens !== null
                  ? `${ctx.tokens.toLocaleString()} / ${ctx.contextWindow.toLocaleString()}${ctx.percent === null ? '' : ` (${ctx.percent}%)`}`
                  : `窗口 ${ctx.contextWindow.toLocaleString()}`}
                </dd>
              </div>
            ))}
          </dl>
        </section>
        <section className="settings-card settings-section">
          <h2>账户额度</h2>
          {report.accountQuota?.available
            ? <dl className="settings-engine-meta">
              {report.accountQuota.providers.map((provider) => (
                <div className="settings-meta-pair" key={provider.provider}>
                  <dt>{provider.label ?? provider.provider}</dt>
                  <dd>{provider.usedPercent != null ? `${Math.round(provider.usedPercent)}%` : '额度详情见引擎'}</dd>
                </div>
              ))}
            </dl>
            : <p className="settings-caption">{report.accountQuota?.note ?? '本机引擎未提供账户额度接口（OMP 的 omp usage 除外）。'}</p>}
          <p className="settings-caption">来源：{report.accountQuota?.source ?? '不可用'}</p>
        </section>
      </div>

      <section className="settings-card settings-section">
        <h2>按项目</h2>
        {report.byProject.length === 0 && <p className="settings-caption">暂无数据。</p>}
        <dl className="settings-engine-meta">
          {report.byProject.map((row) => (
            <div className="settings-meta-pair" key={row.projectId ?? 'none'}>
              <dt>{row.projectName}（{row.calls} 次调用）</dt>
              <dd>
                {formatTokens(row.totalTokens)} tokens · {costLabel(row)}
                {' · '}{Object.entries(row.engines).map(([engineId, tokens]) => `${engineId} ${formatTokens(tokens)}`).join(' · ')}
              </dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="settings-card settings-section">
        <h2>按模型</h2>
        {report.byModel.length === 0 && <p className="settings-caption">暂无数据。</p>}
        <dl className="settings-engine-meta">
          {report.byModel.map((row) => (
            <div className="settings-meta-pair" key={`${row.engine}/${row.model}`}>
              <dt>{row.engine} · {row.model}</dt>
              <dd>输入 {formatTokens(row.input)} · 输出 {formatTokens(row.output)} · 缓存 {formatTokens(row.cacheRead + row.cacheWrite)} · 合计 {formatTokens(row.totalTokens)} · {costLabel(row)}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="settings-card settings-section">
        <h2>按日期</h2>
        {report.byDay.length === 0 && <p className="settings-caption">暂无数据。</p>}
        <dl className="settings-engine-meta">
          {report.byDay.map((row) => (
            <div className="settings-meta-pair" key={row.date}>
              <dt>{row.date}</dt>
              <dd>{formatTokens(row.totalTokens)} tokens · {row.calls} 次调用 · {costLabel(row)}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="settings-card settings-section">
        <h2>引擎全局统计（与项目明细分开展示，不重叠相加）</h2>
        {report.engineGlobals.length === 0 && <p className="settings-caption">无可用引擎统计。</p>}
        {report.engineGlobals.map((global) => (
          <div key={global.engine} className="ext-server-row">
            <div className="ext-server-main">
              <div className="ext-server-copy">
                <div>
                  <strong>{global.label}</strong>
                  <span className={`ext-badge${global.available ? '' : ' is-shadow'}`}>{global.available ? '可用' : '不可用'}</span>
                </div>
                {global.available && <small>
                  请求 {global.requests ?? '未提供'} · 输入 {formatTokens(global.inputTokens ?? null)} · 输出 {formatTokens(global.outputTokens ?? null)}
                  {' · '}缓存读 {formatTokens(global.cacheReadTokens ?? null)} · 缓存写 {formatTokens(global.cacheWriteTokens ?? null)}
                  {global.cost !== null && global.cost !== undefined ? ` · ${formatCost(global.cost)}` : ' · 费用未提供'}
                </small>}
                {global.note && <small>{global.note}</small>}
                <code className="ext-endpoint">{global.source}</code>
              </div>
            </div>
          </div>
        ))}
      </section>

      <section className="settings-card settings-section">
        <h2>会话明细</h2>
        <p className="settings-caption">「引擎回报」为 get_session_stats / tokenUsage 校验的会话总量；与明细合计差异说明有重复键或引擎未计数的调用。</p>
        {report.sessions.length === 0 && <p className="settings-caption">暂无数据。</p>}
        <dl className="settings-engine-meta">
          {report.sessions.slice(0, 30).map((row) => (
            <div className="settings-meta-pair" key={row.threadId}>
              <dt>{row.title.slice(0, 22)} · {row.engine}{row.date ? ` · ${row.date}` : ''}</dt>
              <dd>
                {formatTokens(row.totalTokens)} tokens · {costLabel(row)}
                {row.liveContextTokens !== null ? ` · 引擎回报 ${formatTokens(row.liveContextTokens)}` : ''}
                {row.validated ? ' · 已校验' : ''}
              </dd>
            </div>
          ))}
        </dl>
      </section>
    </>}
    {!report && loading && <p className="settings-caption" role="status">正在汇总用量…</p>}
  </div>
}

// ─────────────────────────────────────────────────────────────────────────────
// 浏览器
// ─────────────────────────────────────────────────────────────────────────────

export function BrowserSettingsPage({ onOpenBrowserWindow }: { onOpenBrowserWindow: () => Promise<void> }) {
  const [opening, setOpening] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [ego, setEgo] = useState<BrowserStatus | null>(null)

  useEffect(() => {
    void window.agentui.browserStatus(false).then(setEgo).catch(() => undefined)
  }, [])

  async function open() {
    setOpening(true)
    setError(null)
    try {
      await onOpenBrowserWindow()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setOpening(false)
    }
  }

  return <div className="settings-extensions-page">
    <div className="settings-page-heading"><h1>浏览器</h1><p>AgentUI 自己的多标签浏览器窗口，与工作台登录状态隔离。</p></div>
    {error && <p className="settings-feedback is-error" role="alert"><CircleAlert size={14} />{error}</p>}
    <section className="settings-card settings-section">
      <div className="settings-section-heading">
        <h2>独立浏览器窗口</h2>
        <button type="button" className="btn-primary" disabled={opening} onClick={() => void open()}>
          <AppWindow size={14} />{opening ? '打开中…' : '打开独立浏览器'}
        </button>
      </div>
      <ul className="ext-browser-notes">
        <li>多标签 + 地址栏 + 前进后退；页面运行在独立的浏览器会话（persist 分区）中，登录状态与工作台完全隔离。</li>
        <li>「分享到会话」：把当前页链接、选中文本或截图发送到选中的会话输入框，由你确认后发送——三个引擎都能接收。</li>
        <li>可从工作台顶栏按钮或 <kbd>Ctrl+K</kbd> 命令面板打开。</li>
        <li>权限请求（摄像头、通知等）默认拒绝；弹窗会转为新标签页。</li>
      </ul>
    </section>
    <section className="settings-card settings-section">
      <h2>外部浏览器集成（可选）</h2>
      <dl className="settings-engine-meta">
        <dt>ego-browser</dt>
        <dd>{ego ? (ego.ego.available ? `可用 · ${ego.ego.version ?? ''}` : ego.ego.error ?? '未安装') : '检测中…'}</dd>
        <dt>发现的 MCP 配置</dt>
        <dd>{ego ? `${ego.mcpServers.filter((s) => s.browserLike).length} 个浏览器型 / ${ego.mcpServers.length} 个总数` : '—'}</dd>
      </dl>
      <p className="settings-caption">ego-browser 是独立于窗口浏览器的可选外部入口（工作区「浏览器」面板）；后续按引擎接入主动浏览工具与标签页授权。</p>
    </section>
  </div>
}
