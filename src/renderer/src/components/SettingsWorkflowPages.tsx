import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, CircleAlert, ClipboardCopy, ExternalLink, FolderGit2, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { diagnosticHarnessState, formatDiagnosticsReport, type AppDiagnostics } from '@shared/diagnostics'
import type { ConversationSettings } from '@shared/settings'
import { shortcutHints } from '@shared/shortcuts'
import {
  PERMISSION_RULE_ACTION_LABELS,
  PERMISSION_RULE_TARGET_LABELS,
  TRUST_PRESETS,
  TRUST_PRESET_DESCRIPTIONS,
  TRUST_PRESET_LABELS,
  type PermissionRuleAction,
  type PermissionRuleTarget,
  type ToolPermissionRule,
  type TrustPreset,
} from '@shared/tool-policy'
import { HARNESS_IDS, HARNESS_LABELS, type ProjectEntry } from '@shared/types'
import { errorText, Segments, SettingsRow } from './SettingsControls'

export function ConversationPage({ settings, onSave }: {
  settings: ConversationSettings
  onSave: (patch: Partial<ConversationSettings>) => Promise<void>
}) {
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const hints = shortcutHints(settings.enterWhileRunning)

  async function save(patch: Partial<ConversationSettings>) {
    setSaving(true)
    setError(null)
    try { await onSave(patch) } catch (err) { setError(errorText(err)) } finally { setSaving(false) }
  }

  return (
    <>
      <div className="settings-page-heading"><h1>会话与快捷键</h1><p>调整运行时发送方式和时间线的默认展示。</p></div>
      {error && <p className="settings-feedback is-error" role="alert"><CircleAlert size={14} />{error}</p>}
      <fieldset className="settings-card settings-appearance" disabled={saving} aria-label="会话行为">
        <SettingsRow id="conversation-send" label="运行时 Enter" description="Ctrl+Enter 使用另一种方式。空闲时两个快捷键均发送指令。">
          <Segments labelId="conversation-send-label" value={settings.enterWhileRunning}
            options={[{ value: 'followUp', label: '排队 · Follow-up' }, { value: 'steer', label: '引导 · Steer' }]}
            onChange={(enterWhileRunning) => void save({ enterWhileRunning })} />
        </SettingsRow>
        <SettingsRow id="conversation-tools" label="默认折叠工具过程" description="仅控制工具组初始状态，单个工具的参数和输出可按需展开。">
          <button className="settings-switch" type="button" role="switch" aria-labelledby="conversation-tools-label"
            aria-checked={settings.collapseToolGroups}
            onClick={() => void save({ collapseToolGroups: !settings.collapseToolGroups })}><span /></button>
        </SettingsRow>
      </fieldset>
      <section id="conversation-shortcuts" tabIndex={-1} className="settings-card settings-section settings-page-block">
        <h2>快捷键</h2>
        <div className="settings-shortcuts">
          {(['global', 'composer'] as const).map((scope) => (
            <section key={scope}>
              <h3>{scope === 'global' ? '全局工作台' : '指令输入框'}</h3>
              {hints.filter((hint) => hint.scope === scope).map((hint) => (
                <div className="settings-shortcut-row" key={hint.keys.join('+')}>
                  <span>{hint.description}</span>
                  <span className="shortcut-keys">{hint.keys.map((key) => <kbd key={key} className="kbd-key">{key}</kbd>)}</span>
                </div>
              ))}
            </section>
          ))}
        </div>
      </section>
    </>
  )
}

function TrustSelect({ value, label, disabled, onChange }: {
  value: TrustPreset
  label: string
  disabled: boolean
  onChange: (value: TrustPreset) => void
}) {
  return <select className="text-input settings-trust-select" aria-label={label} value={value} disabled={disabled}
    onChange={(event) => onChange(event.target.value as TrustPreset)}>
    {TRUST_PRESETS.map((preset) => <option key={preset} value={preset}>{TRUST_PRESET_LABELS[preset]}</option>)}
  </select>
}

const RULE_PLACEHOLDERS: Record<PermissionRuleTarget, string> = {
  command: '命令前缀或通配，例如 npm test* / cargo check*',
  tool: '工具名或通配，例如 Bash / Edit / mcp__*',
  path: '路径前缀或文件名，例如 src/** / .env*',
}

export function ProjectPermissionsPage({ projects, activeProjectId, defaultPreset, onSaveDefault, onSaveProject, onSaveProjectRules }: {
  projects: ProjectEntry[]
  activeProjectId: string | null
  defaultPreset: TrustPreset
  onSaveDefault: (preset: TrustPreset) => Promise<void>
  onSaveProject: (id: string, preset: TrustPreset) => Promise<void>
  onSaveProjectRules: (id: string, rules: ToolPermissionRule[]) => Promise<void>
}) {
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [ruleProjectId, setRuleProjectId] = useState<string>(() => activeProjectId ?? projects[0]?.id ?? '')
  const [ruleAction, setRuleAction] = useState<PermissionRuleAction>('allow')
  const [ruleTarget, setRuleTarget] = useState<PermissionRuleTarget>('command')
  const [rulePattern, setRulePattern] = useState('')
  const [ruleNote, setRuleNote] = useState('')

  useEffect(() => {
    if (!projects.some((p) => p.id === ruleProjectId)) {
      setRuleProjectId(activeProjectId ?? projects[0]?.id ?? '')
    }
  }, [projects, activeProjectId, ruleProjectId])

  const selectedRuleProject = projects.find((p) => p.id === ruleProjectId) ?? projects[0] ?? null
  const currentRules = selectedRuleProject?.permissionRules ?? []

  async function save(action: () => Promise<void>) {
    setSaving(true)
    setError(null)
    try { await action() } catch (err) { setError(errorText(err)) } finally { setSaving(false) }
  }

  async function handleAddRule() {
    if (!selectedRuleProject) return
    const trimmed = rulePattern.trim()
    if (!trimmed) {
      setError('请输入匹配模式（例如 npm test*）')
      return
    }
    const nextRule: ToolPermissionRule = {
      id: `rule-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      action: ruleAction,
      target: ruleTarget,
      pattern: trimmed,
      note: ruleNote.trim() || undefined,
      createdAt: Date.now(),
    }
    await save(async () => {
      await onSaveProjectRules(selectedRuleProject.id, [...currentRules, nextRule])
      setRulePattern('')
      setRuleNote('')
    })
  }

  async function handleDeleteRule(ruleId: string) {
    if (!selectedRuleProject) return
    await save(() =>
      onSaveProjectRules(
        selectedRuleProject.id,
        currentRules.filter((r) => r.id !== ruleId),
      ),
    )
  }

  return (
    <>
      <div className="settings-page-heading"><h1>项目与权限</h1><p>为每个项目配置工具审批预设与细粒度 Allow / Ask / Deny 规则。</p></div>
      {error && <p className="settings-feedback is-error" role="alert"><CircleAlert size={14} />{error}</p>}
      <section className="settings-card settings-appearance">
        <SettingsRow id="projects-default" label="新项目默认预设" description="仅用于此后首次添加的项目。">
          <TrustSelect label="新项目默认预设" value={defaultPreset} disabled={saving}
            onChange={(preset) => void save(() => onSaveDefault(preset))} />
        </SettingsRow>
      </section>
      <section id="projects-trust" tabIndex={-1} className="settings-card settings-section settings-page-block">
        <h2>项目审批预设</h2>
        {projects.length === 0 && <p className="settings-caption">工作台添加的项目会显示在这里。</p>}
        {projects.map((project) => (
          <div className="settings-project-row" key={project.id}>
            <FolderGit2 size={16} />
            <div className="settings-project-name">
              <strong>{project.name}</strong>{project.id === activeProjectId && <span>当前项目</span>}
              <small title={project.path}>{project.path}</small>
            </div>
            <TrustSelect label={`${project.name} 权限预设`} value={project.trustPreset ?? 'approval'} disabled={saving}
              onChange={(preset) => void save(() => onSaveProject(project.id, preset))} />
          </div>
        ))}
      </section>
      <section id="projects-rules" tabIndex={-1} className="settings-card settings-section settings-page-block">
        <div className="settings-section-heading">
          <div>
            <h2>细粒度权限规则（Allow / Ask / Deny）</h2>
            <p className="settings-caption">优先级：高风险规则兜底 &gt; 拒绝 (Deny) &gt; 询问 (Ask) &gt; 允许 (Allow) &gt; 项目预设。命令类「允许」规则会自动拦截管道/链式拼接命令。</p>
          </div>
          {projects.length > 0 && selectedRuleProject && (
            <select
              className="text-input settings-trust-select"
              aria-label="选择配置规则的项目"
              value={selectedRuleProject.id}
              onChange={(e) => setRuleProjectId(e.target.value)}
            >
              {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          )}
        </div>
        {!selectedRuleProject ? (
          <p className="settings-caption">请先添加项目后再配置细粒度规则。</p>
        ) : (
          <>
            <div className="perm-rule-form">
              <select
                className="text-input perm-rule-select"
                aria-label="规则动作"
                value={ruleAction}
                disabled={saving}
                onChange={(e) => setRuleAction(e.target.value as PermissionRuleAction)}
              >
                <option value="allow">允许 (Allow)</option>
                <option value="ask">询问 (Ask)</option>
                <option value="deny">拒绝 (Deny)</option>
              </select>
              <select
                className="text-input perm-rule-select"
                aria-label="匹配目标"
                value={ruleTarget}
                disabled={saving}
                onChange={(e) => setRuleTarget(e.target.value as PermissionRuleTarget)}
              >
                <option value="command">命令 (Command)</option>
                <option value="tool">工具 (Tool)</option>
                <option value="path">路径 (Path)</option>
              </select>
              <input
                type="text"
                className="text-input perm-rule-pattern"
                aria-label="规则匹配模式"
                placeholder={RULE_PLACEHOLDERS[ruleTarget]}
                value={rulePattern}
                disabled={saving}
                onChange={(e) => setRulePattern(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    void handleAddRule()
                  }
                }}
              />
              <input
                type="text"
                className="text-input perm-rule-note"
                aria-label="备注（可选）"
                placeholder="备注（可选）"
                value={ruleNote}
                disabled={saving}
                onChange={(e) => setRuleNote(e.target.value)}
              />
              <button
                type="button"
                className="btn-primary"
                disabled={saving || !rulePattern.trim()}
                onClick={() => void handleAddRule()}
              >
                <Plus size={13} />
                添加规则
              </button>
            </div>

            {currentRules.length === 0 ? (
              <p className="settings-caption">当前项目暂无自定义规则。也可在审批卡片中一键点击「加入项目允许规则」。</p>
            ) : (
              <div className="perm-rule-list">
                {currentRules.map((rule) => (
                  <div className="perm-rule-row" key={rule.id}>
                    <span className={`perm-badge perm-action-${rule.action}`}>
                      {PERMISSION_RULE_ACTION_LABELS[rule.action]}
                    </span>
                    <span className="mono-chip">{PERMISSION_RULE_TARGET_LABELS[rule.target]}</span>
                    <code className="perm-pattern">{rule.pattern}</code>
                    {rule.note && <span className="perm-note">{rule.note}</span>}
                    <button
                      type="button"
                      className="icon-btn"
                      title="删除规则"
                      aria-label={`删除规则 ${rule.pattern}`}
                      disabled={saving}
                      onClick={() => void handleDeleteRule(rule.id)}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </section>
      <section className="settings-card settings-section settings-page-block">
        <h2>审批如何生效</h2>
        <dl className="settings-engine-meta">
          {TRUST_PRESETS.map((preset) => (
            <div className="settings-meta-pair" key={preset}>
              <dt>{TRUST_PRESET_LABELS[preset]}</dt><dd>{TRUST_PRESET_DESCRIPTIONS[preset]}</dd>
            </div>
          ))}
        </dl>
        <p className="settings-caption">预设与规则在引擎发起审批时生效。静默执行的工具由引擎自身控制。高风险命令始终要求人工确认（或被显式拒绝规则拦截）。</p>
      </section>
    </>
  )
}

const PLATFORM_LABELS: Record<string, string> = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' }

export function DiagnosticsPage() {
  const [data, setData] = useState<AppDiagnostics | null>(null)
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'error'>('idle')
  const requestRef = useRef(0)

  const load = useCallback(async (refresh: boolean) => {
    const request = ++requestRef.current
    setChecking(true)
    setError(null)
    setCopyStatus('idle')
    try {
      const snapshot = await window.agentui.getDiagnostics(refresh)
      if (requestRef.current === request) setData(snapshot)
    } catch (err) {
      if (requestRef.current === request) setError(errorText(err))
    } finally {
      if (requestRef.current === request) setChecking(false)
    }
  }, [])

  useEffect(() => {
    void load(false)
    return () => { requestRef.current += 1 }
  }, [load])

  async function copyReport() {
    if (!data) return
    try {
      await navigator.clipboard.writeText(formatDiagnosticsReport(data))
      setCopyStatus('copied')
    } catch {
      setCopyStatus('error')
    }
  }

  return (
    <>
      <div className="settings-page-heading settings-engine-heading">
        <div><h1>诊断与关于</h1><p>查看本机运行状态并生成可分享的诊断摘要。</p></div>
        <div className="settings-actions">
          <button className="btn-small" type="button" disabled={checking} onClick={() => void load(true)}>
            <RefreshCw size={13} className={checking ? 'spin' : undefined} />{checking ? '检查中…' : '刷新诊断'}
          </button>
          <button className="btn-primary" type="button" disabled={!data || checking} onClick={() => void copyReport()}>
            {copyStatus === 'copied' ? <Check size={14} /> : <ClipboardCopy size={14} />}复制诊断摘要
          </button>
        </div>
      </div>
      {error && <p className="settings-feedback is-error" role="alert"><CircleAlert size={14} />{error}</p>}
      {copyStatus === 'copied' && <p className="settings-feedback is-success" role="status"><Check size={14} />已复制诊断摘要。</p>}
      {copyStatus === 'error' && <p className="settings-feedback is-error" role="alert">无法访问剪贴板，可展开下方的摘要手动复制。</p>}
      {data && <>
        <section id="diagnostics-about" tabIndex={-1} className="settings-card settings-section">
          <div className="settings-section-heading">
            <h2>关于 AgentUI</h2>
            <a className="btn-small settings-external" href="https://github.com/yurisonetammin/agentui" target="_blank" rel="noreferrer">GitHub <ExternalLink size={13} /></a>
          </div>
          <dl className="settings-engine-meta">
            <dt>应用版本</dt><dd>{data.version}</dd>
            <dt>运行环境</dt><dd>Electron {data.electron} · {PLATFORM_LABELS[data.platform] ?? data.platform} {data.osRelease} ({data.arch})</dd>
            <dt>采集时间</dt><dd><time dateTime={new Date(data.checkedAt).toISOString()}>{new Date(data.checkedAt).toLocaleString()}</time></dd>
          </dl>
          <details className="settings-report">
            <summary>预览可分享的摘要</summary>
            <p className="settings-caption">摘要包含版本、探测状态和错误次数。本机路径及错误详情留在此页面。</p>
            <pre tabIndex={0}>{formatDiagnosticsReport(data)}</pre>
          </details>
        </section>
        <section id="diagnostics-engines" tabIndex={-1} className="settings-card settings-section settings-page-block">
          <h2>引擎探测</h2>
          <div className="settings-diagnostic-list">
            {HARNESS_IDS.map((id) => {
              const status = data.harnesses[id]
              return <div className="settings-diagnostic-engine" key={id}>
                <div><span className={`dot ${status.ready ? 'dot-ready' : 'dot-idle'}`} /><strong>{HARNESS_LABELS[id]}</strong>
                  <span>{diagnosticHarnessState(status)}{status.version ? ` · ${status.version}` : ''}</span></div>
                {status.error && <details className="settings-report"><summary>探测详情</summary><p>{status.error}</p></details>}
              </div>
            })}
          </div>
        </section>
        <section id="diagnostics-startup" tabIndex={-1} className="settings-card settings-section settings-page-block">
          <h2>最近启动错误</h2>
          {data.startupIssues.length ? data.startupIssues.map((issue) => <details key={issue.id} className="settings-report">
            <summary>{HARNESS_LABELS[issue.harness]} · {new Date(issue.occurredAt).toLocaleString()}</summary>
            <pre>{issue.message}</pre>
          </details>) : <p className="settings-caption">本次运行暂无启动错误。</p>}
        </section>
        <section id="diagnostics-browser" tabIndex={-1} className="settings-card settings-section settings-page-block">
          <h2>浏览器与 MCP</h2>
          {data.browser ? <dl className="settings-engine-meta">
            <dt>ego-browser</dt><dd>{data.browser.available ? `可用${data.browser.version ? ` · ${data.browser.version}` : ''}` : '未就绪'}</dd>
            <dt>发现的 MCP 配置</dt><dd>浏览器型 {data.browser.browserMcpCount} 个 · 其他 {data.browser.otherMcpCount} 个</dd>
          </dl> : <p className="settings-caption">暂无法读取浏览器和 MCP 状态。</p>}
        </section>
      </>}
      {!data && checking && <p className="settings-caption" role="status">正在加载诊断信息…</p>}
    </>
  )
}
