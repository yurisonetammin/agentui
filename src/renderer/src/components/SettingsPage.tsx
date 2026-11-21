import { useEffect, useRef, useState } from 'react'
import {
  Activity,
  AppWindow,
  Check,
  ChevronRight,
  CircleAlert,
  Cpu,
  FolderOpen,
  Gauge,
  Keyboard,
  Monitor,
  Puzzle,
  RefreshCw,
  Search,
  Server,
  Shield,
  Sparkles,
  SquareTerminal,
} from 'lucide-react'
import { CAPABILITY_LABELS, CAPABILITY_NOTES, HARNESS_CAPABILITIES, type CapabilitySupport } from '@shared/capabilities'
import {
  EXTENSION_ENGINE_LABELS,
  EXTENSION_ENGINES,
  isExtensionEngine,
  type ExtensionEngine,
} from '@shared/extensions'
import {
  CODE_FONT_SIZES, DEFAULT_APPEARANCE, DEFAULT_HARNESS_SETTINGS, THINKING_LABELS,
  type AppearanceSettings, type ConversationSettings, type HarnessDefaults,
} from '@shared/settings'
import type { TrustPreset } from '@shared/tool-policy'
import { HARNESS_IDS, HARNESS_LABELS, THINKING_LEVELS, type HarnessId, type HarnessStatus, type ModelCatalogResult, type ProjectEntry, type ThinkingLevel } from '@shared/types'
import { errorText, Segments, SettingsRow } from './SettingsControls'
import { ConversationPage, DiagnosticsPage, ProjectPermissionsPage } from './SettingsWorkflowPages'
import { BrowserSettingsPage, HerdrSettingsPage, McpSettingsPage, PluginsSettingsPage, SkillsSettingsPage, UsageSettingsPage } from './SettingsExtensionsPages'

const SETTINGS_SECTIONS = {
  engines: { label: '引擎与模型', icon: Cpu },
  mcp: { label: 'MCP 服务器', icon: Server },
  plugins: { label: '插件', icon: Puzzle },
  skills: { label: '技能', icon: Sparkles },
  usage: { label: '使用情况', icon: Gauge },
  browser: { label: '浏览器', icon: AppWindow },
  herdr: { label: 'Herdr', icon: SquareTerminal },
  appearance: { label: '外观与布局', icon: Monitor },
  conversation: { label: '会话与快捷键', icon: Keyboard },
  projects: { label: '项目与权限', icon: Shield },
  diagnostics: { label: '诊断与关于', icon: Activity },
}
type SettingsSection = keyof typeof SETTINGS_SECTIONS

export function settingsSectionLabel(section: SettingsSection) {
  return SETTINGS_SECTIONS[section].label
}

export interface SettingsDestination {
  section: SettingsSection
  harness?: HarnessId
  anchor?: string
}

export const SETTINGS_LINKS: Array<SettingsDestination & { label: string; keywords?: string }> = [
  { section: 'engines', label: '引擎与模型', keywords: 'CLI 检测 默认 Thinking' },
  { section: 'mcp', label: 'MCP 服务器', keywords: 'mcp 服务器 配置 来源 覆盖 stdio http 认证' },
  ...EXTENSION_ENGINES.map((engine) => ({
    section: 'mcp' as const, harness: engine,
    label: `MCP · ${EXTENSION_ENGINE_LABELS[engine]}`, keywords: 'mcp 用户级 项目级 第三方',
  })),
  { section: 'plugins', label: '插件', keywords: '插件 包 安装 卸载 更新 plugin package' },
  ...EXTENSION_ENGINES.map((engine) => ({
    section: 'plugins' as const, harness: engine,
    label: `插件 · ${EXTENSION_ENGINE_LABELS[engine]}`, keywords: '安装 卸载 更新 包',
  })),
  { section: 'skills', label: '技能', keywords: '技能 skill 预览 插入 斜杠命令 SKILL.md' },
  ...EXTENSION_ENGINES.map((engine) => ({
    section: 'skills' as const, harness: engine,
    label: `技能 · ${EXTENSION_ENGINE_LABELS[engine]}`, keywords: '技能 预览 SKILL.md',
  })),
  { section: 'usage', label: '使用情况', keywords: '用量 token 费用 额度 统计 报表 上下文' },
  { section: 'browser', label: '浏览器', keywords: '浏览器 独立窗口 标签页 分享 登录隔离 ego' },
  { section: 'herdr', label: 'Herdr 终端', keywords: 'herdr 持久终端 终端 观察接管 分屏 工作区' },
  { section: 'herdr', anchor: 'herdr-path', label: 'Herdr 路径', keywords: 'herdr 可执行文件 CLI' },
  { section: 'herdr', anchor: 'herdr-session', label: 'Herdr 会话', keywords: 'herdr 默认 独立 agentui' },
  ...HARNESS_IDS.map((harness) => ({
    section: 'engines' as const, harness, anchor: 'engine-path',
    label: `${HARNESS_LABELS[harness]} 路径`, keywords: 'CLI 探测 可执行文件',
  })),
  ...HARNESS_IDS.map((harness) => ({
    section: 'engines' as const, harness, anchor: 'engine-defaults',
    label: `${HARNESS_LABELS[harness]} 默认模型`, keywords: 'Thinking 推理',
  })),
  { section: 'appearance', label: '外观与布局' },
  { section: 'appearance', anchor: 'appearance-theme', label: '主题', keywords: '深色 浅色 系统' },
  { section: 'appearance', anchor: 'appearance-width', label: '对话列宽', keywords: '宽度 满宽' },
  { section: 'appearance', anchor: 'appearance-font', label: '代码字号', keywords: '字体 font' },
  { section: 'appearance', anchor: 'appearance-motion', label: '减少动效', keywords: '动画 motion' },
  { section: 'appearance', anchor: 'appearance-terminal', label: '默认终端位置', keywords: '停靠 底部 terminal' },
  { section: 'conversation', label: '会话与快捷键' },
  { section: 'conversation', anchor: 'conversation-send', label: '运行时 Enter', keywords: '排队 引导 Follow-up Steer 发送' },
  { section: 'conversation', anchor: 'conversation-tools', label: '默认折叠工具过程', keywords: '展开 时间线' },
  { section: 'conversation', anchor: 'conversation-shortcuts', label: '快捷键速查', keywords: '键盘' },
  { section: 'projects', label: '项目与权限', keywords: '信任' },
  { section: 'projects', anchor: 'projects-default', label: '新项目默认预设', keywords: '只读 自动 权限' },
  { section: 'projects', anchor: 'projects-trust', label: '项目审批预设', keywords: '工具 只读 自动 信任' },
  { section: 'diagnostics', label: '诊断与关于' },
  { section: 'diagnostics', anchor: 'diagnostics-about', label: '应用版本与诊断摘要', keywords: '系统 GitHub 复制' },
  { section: 'diagnostics', anchor: 'diagnostics-engines', label: '引擎探测结果', keywords: 'CLI 版本 诊断' },
  { section: 'diagnostics', anchor: 'diagnostics-startup', label: '最近启动错误', keywords: '失败 日志 诊断' },
  { section: 'diagnostics', anchor: 'diagnostics-browser', label: '浏览器与 MCP', keywords: 'ego-browser 状态' },
]

interface Props {
  destination: SettingsDestination
  activeHarness: HarnessId
  appearance: AppearanceSettings
  conversation: ConversationSettings
  projects: ProjectEntry[]
  activeProjectId: string | null
  defaultProjectTrust: TrustPreset
  harnesses: Record<HarnessId, HarnessStatus>
  customPaths: Partial<Record<HarnessId, string>>
  defaults: Partial<Record<HarnessId, HarnessDefaults>>
  catalogs: Partial<Record<HarnessId, ModelCatalogResult>>
  catalogLoading: Partial<Record<HarnessId, boolean>>
  /** 当前活动会话已注册的斜杠命令名（技能页「会话已加载」标记）。 */
  sessionCommands: string[]
  /** 当前活动会话所属引擎：技能页只在引擎一致时才标「会话已加载」。 */
  sessionEngine: HarnessId | null
  onInsertToComposer: (text: string) => void
  onOpenBrowserWindow: () => Promise<void>
  onNavigate: (destination: SettingsDestination) => void
  onSavePath: (id: HarnessId, path: string | null) => Promise<void>
  onRefreshHarnesses: () => Promise<void>
  onRefreshCatalog: (id: HarnessId) => Promise<void>
  onSaveDefaults: (id: HarnessId, settings: HarnessDefaults) => Promise<void>
  onSaveAppearance: (patch: Partial<AppearanceSettings>) => Promise<void>
  onSaveConversation: (patch: Partial<ConversationSettings>) => Promise<void>
  onSaveProjectTrust: (id: string, preset: TrustPreset) => Promise<void>
  onSaveDefaultProjectTrust: (preset: TrustPreset) => Promise<void>
}


function AppearancePage({ settings, onSave }: { settings: AppearanceSettings; onSave: Props['onSaveAppearance'] }) {
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function save(patch: Partial<AppearanceSettings>) {
    setSaving(true)
    setError(null)
    try { await onSave(patch) } catch (err) { setError(errorText(err)) } finally { setSaving(false) }
  }

  return (
    <>
      <div className="settings-page-heading"><h1>外观与布局</h1><p>调整工作台在这台设备上的显示和停靠方式。</p></div>
      {error && <p className="settings-feedback is-error" role="alert"><CircleAlert size={14} />{error}</p>}
      <fieldset className="settings-card settings-appearance" disabled={saving}>
        <SettingsRow id="appearance-theme" label="主题" description="同时应用到界面和窗口标题栏。">
          <Segments labelId="appearance-theme-label" value={settings.theme} onChange={(theme) => void save({ theme })}
            options={[{ value: 'system', label: '跟随系统' }, { value: 'light', label: '浅色' }, { value: 'dark', label: '深色' }]} />
        </SettingsRow>
        <SettingsRow id="appearance-width" label="对话列宽" description="时间线、输入区和最近项目共用同一宽度。">
          <Segments labelId="appearance-width-label" value={settings.conversationWidth}
            onChange={(conversationWidth) => void save({ conversationWidth })}
            options={[{ value: 'standard', label: '标准' }, { value: 'wide', label: '宽' }, { value: 'full', label: '满宽' }]} />
        </SettingsRow>
        <SettingsRow id="appearance-font" label="代码字号" description="适用于代码块、文件预览、差异、工具输出和终端。">
          <Segments labelId="appearance-font-label" value={settings.codeFontSize}
            onChange={(codeFontSize) => void save({ codeFontSize })}
            options={CODE_FONT_SIZES.map((value) => ({ value, label: `${value} px` }))} />
        </SettingsRow>
        <SettingsRow id="appearance-motion" label="减少动效" description="可主动关闭界面动效。系统的减少动效偏好也会生效。">
          <button className="settings-switch" type="button" role="switch" aria-labelledby="appearance-motion-label"
            aria-checked={settings.reduceMotion} onClick={() => void save({ reduceMotion: !settings.reduceMotion })}><span /></button>
        </SettingsRow>
        <SettingsRow id="appearance-terminal" label="默认终端位置" description="在下次打开终端时使用。">
          <Segments labelId="appearance-terminal-label" value={settings.terminalPlacement}
            onChange={(terminalPlacement) => void save({ terminalPlacement })}
            options={[{ value: 'right', label: '右侧面板' }, { value: 'bottom', label: '底部' }]} />
        </SettingsRow>
      </fieldset>
      <button className="btn-small settings-reset" type="button" disabled={saving} onClick={() => void save(DEFAULT_APPEARANCE)}>
        恢复默认外观
      </button>
    </>
  )
}

function CapabilityMark({ support }: { support: CapabilitySupport }) {
  const label = support === 'yes' ? '支持' : support === 'partial' ? '部分支持' : '不支持'
  return <span className={`settings-capability ${support}`} aria-label={label} title={label}>
    {support === 'yes' ? '✓' : support === 'partial' ? '◐' : '—'}
  </span>
}

function EngineDetails({ id, props }: { id: HarnessId; props: Props }) {
  const status = props.harnesses[id]
  const catalog = props.catalogs[id]
  const catalogBusy = props.catalogLoading[id]
  const savedPath = props.customPaths[id] ?? ''
  const savedDefaults = props.defaults[id] ?? DEFAULT_HARNESS_SETTINGS
  const agentManaged = id === 'acp' || id === 'dsh'
  const supportsThinking = HARNESS_CAPABILITIES[id].thinking !== 'no'
  const [path, setPath] = useState(savedPath)
  const [result, setResult] = useState<HarnessStatus | null>(null)
  const [pathBusy, setPathBusy] = useState(false)
  const [pathFeedback, setPathFeedback] = useState<{ text: string; error: boolean } | null>(null)
  const [defaults, setDefaults] = useState(savedDefaults)
  const [savingDefaults, setSavingDefaults] = useState(false)
  const [defaultFeedback, setDefaultFeedback] = useState<{ text: string; error: boolean } | null>(null)
  const selectedModel = catalog?.models.find((model) => model.provider === defaults.model?.provider && model.id === defaults.model?.id)
  const availableLevels = selectedModel?.availableThinkingLevels ?? THINKING_LEVELS
  const canUseDefaultLevel = availableLevels.includes('medium')
  const modelValue = defaults.model ? JSON.stringify([defaults.model.provider, defaults.model.id]) : ''
  const defaultIsDirty = JSON.stringify(defaults) !== JSON.stringify(savedDefaults)

  async function pathAction(action: 'browse' | 'test' | 'apply' | 'reset') {
    setPathBusy(true)
    setPathFeedback(null)
    try {
      if (action === 'browse') {
        const picked = await window.agentui.pickExecutable()
        if (picked) { setPath(picked); setResult(null) }
      } else if (action === 'test') {
        const next = await window.agentui.testHarnessPath(id, path.trim())
        setResult(next)
        setPathFeedback(next.ready
          ? { text: next.version ? `版本检查通过 · ${next.version}` : '版本命令运行成功', error: false }
          : { text: next.error ?? '版本检查失败', error: true })
      } else {
        const nextPath = action === 'reset' ? null : path.trim()
        await props.onSavePath(id, nextPath)
        setPath(nextPath ?? '')
        setResult(null)
        setPathFeedback({ text: nextPath ? '路径已应用，将用于下次启动引擎。' : '已恢复自动探测。', error: false })
      }
    } catch (error) {
      setResult(null)
      setPathFeedback({ text: errorText(error), error: true })
    } finally {
      setPathBusy(false)
    }
  }

  async function saveDefaults() {
    setSavingDefaults(true)
    setDefaultFeedback(null)
    try {
      await props.onSaveDefaults(id, defaults)
      setDefaultFeedback({ text: '已保存，将用于之后创建的会话。', error: false })
    } catch (error) {
      setDefaultFeedback({ text: errorText(error), error: true })
    } finally {
      setSavingDefaults(false)
    }
  }

  const catalogLabel = agentManaged ? '由引擎管理' : !status.ready ? '等待 CLI 就绪' : catalogBusy ? '正在读取…'
    : id === 'claude' ? 'CLI 内置模型别名' : catalog?.models.length ? `${catalog.models.length} 个可选模型` : '暂无可选模型'

  return (
    <div className="settings-engine-details">
      <section id="engine-path" tabIndex={-1} className="settings-card settings-section">
        <div className="settings-section-heading"><h2>{HARNESS_LABELS[id]}</h2>
          <span className="settings-indicator"><span className={`dot ${status.ready ? 'dot-ready' : 'dot-idle'}`} />
            {status.ready ? (status.version ? `版本 ${status.version}` : 'CLI 就绪') : status.path ? '启动失败' : '未找到 CLI'}
          </span>
        </div>
        <dl className="settings-engine-meta">
          <dt>当前可执行文件</dt><dd>{status.path ?? '未找到'}</dd>
          {status.sessionRoot && <><dt>会话目录</dt><dd>{status.sessionRoot}</dd></>}
        </dl>
        {status.error && <p className="settings-feedback is-error"><CircleAlert size={14} />{status.error}</p>}
        {savedPath && savedPath !== status.path && <p className="settings-feedback is-error">已保存的自定义路径不可用，当前显示自动探测结果。</p>}
        <label className="settings-form-label" htmlFor="custom-cli-path">自定义可执行文件</label>
        <div className="settings-path-entry">
          <input id="custom-cli-path" className="text-input" placeholder="留空时自动探测" value={path} disabled={pathBusy}
            onChange={(event) => { setPath(event.target.value); setResult(null); setPathFeedback(null) }} />
          <button className="btn-small" type="button" disabled={pathBusy} onClick={() => void pathAction('browse')}><FolderOpen size={14} />选择文件</button>
        </div>
        <div className="settings-actions">
          <button className="btn-small" type="button" disabled={pathBusy || !path.trim()} onClick={() => void pathAction('test')}>测试路径</button>
          <button className="btn-primary" type="button" disabled={pathBusy || !result?.ready || path.trim() === savedPath}
            onClick={() => void pathAction('apply')}>应用路径</button>
          {savedPath && <button className="btn-small" type="button" disabled={pathBusy} onClick={() => void pathAction('reset')}>恢复自动探测</button>}
        </div>
        {pathBusy && <p className="settings-feedback" role="status">正在处理路径…</p>}
        {pathFeedback && <p role={pathFeedback.error ? 'alert' : 'status'} className={`settings-feedback${pathFeedback.error ? ' is-error' : ' is-success'}`}>
          {pathFeedback.error ? <CircleAlert size={14} /> : <Check size={14} />}{pathFeedback.text}
        </p>}
      </section>

      <section id="engine-defaults" tabIndex={-1} className="settings-card settings-section">
        <div className="settings-section-heading"><h2>新会话默认值</h2>
          <button type="button" className="btn-small" disabled={!status.ready || catalogBusy || agentManaged}
            onClick={() => void props.onRefreshCatalog(id)}><RefreshCw size={13} />刷新模型</button>
        </div>
        <p className="settings-caption">模型目录 · {catalogLabel}</p>
        {catalog?.warning && <p className="settings-caption">{catalog.warning}</p>}
        {!agentManaged && <>
          <div className="settings-default-fields">
            <label>默认模型
              <select className="text-input" value={modelValue} disabled={savingDefaults}
                onChange={(event) => {
                  const choice = catalog?.models.find((model) => JSON.stringify([model.provider, model.id]) === event.target.value)
                  setDefaults((previous) => {
                    const levels = choice?.availableThinkingLevels
                    const thinking = previous.thinkingLevel ?? 'medium'
                    return {
                      model: choice ? { provider: choice.provider, id: choice.id } : null,
                      thinkingLevel: levels && !levels.includes(thinking)
                        ? (levels.includes('medium') ? null : levels[0] ?? 'off') : previous.thinkingLevel,
                    }
                  })
                  setDefaultFeedback(null)
                }}>
                <option value="">随引擎默认</option>
                {modelValue && !selectedModel && <option value={modelValue}>{defaults.model?.provider}/{defaults.model?.id} · 暂未列出</option>}
                {catalog?.models.map((model) => {
                  const value = JSON.stringify([model.provider, model.id])
                  return <option key={value} value={value}>{model.name} · {model.provider}</option>
                })}
              </select>
            </label>
            {supportsThinking && <label>默认 Thinking
              <select className="text-input" disabled={savingDefaults} value={defaults.thinkingLevel ?? ''}
                onChange={(event) => {
                  setDefaults({ ...defaults, thinkingLevel: (event.target.value || null) as ThinkingLevel | null })
                  setDefaultFeedback(null)
                }}>
                <option value="" disabled={!canUseDefaultLevel}>沿用默认档位</option>
                {defaults.thinkingLevel && !availableLevels.includes(defaults.thinkingLevel) && (
                  <option value={defaults.thinkingLevel}>{THINKING_LABELS[defaults.thinkingLevel]} · 暂不可用</option>
                )}
                {availableLevels.map((level) => <option key={level} value={level}>{THINKING_LABELS[level]}</option>)}
              </select>
            </label>}
          </div>
          <div className="settings-actions">
            <button type="button" className="btn-primary" disabled={savingDefaults || !defaultIsDirty}
              onClick={() => void saveDefaults()}>{savingDefaults ? '保存中…' : '保存默认值'}</button>
          </div>
          {defaultFeedback && <p role={defaultFeedback.error ? 'alert' : 'status'} className={`settings-feedback${defaultFeedback.error ? ' is-error' : ' is-success'}`}>{defaultFeedback.text}</p>}
        </>}
      </section>
      {CAPABILITY_NOTES[id] && <section className="settings-card settings-section">
        <h2>使用说明</h2><p className="settings-caption">{CAPABILITY_NOTES[id]}</p>
      </section>}
    </div>
  )
}

export function SettingsPage(props: Props) {
  const [query, setQuery] = useState('')
  const [probing, setProbing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [comparedDestination, setComparedDestination] = useState<SettingsDestination | null>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  // MCP / 插件 / 技能共用同一个引擎切换器状态
  const [extensionEngine, setExtensionEngine] = useState<ExtensionEngine>(
    () => (isExtensionEngine(props.activeHarness) ? props.activeHarness : 'pi'),
  )
  const { destination, onNavigate } = props
  const compare = comparedDestination === destination
  const selected = destination.harness ?? props.activeHarness
  const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean)
  const matches = terms.length ? SETTINGS_LINKS.filter((entry) =>
    terms.every((term) => `${entry.label} ${entry.keywords ?? ''}`.toLowerCase().includes(term))) : []

  const extensionHarnesses = {
    pi: { ready: props.harnesses.pi.ready, version: props.harnesses.pi.version },
    omp: { ready: props.harnesses.omp.ready, version: props.harnesses.omp.version },
    prime: { ready: props.harnesses.prime.ready, version: props.harnesses.prime.version },
  }

  function switchExtensionEngine(next: ExtensionEngine) {
    setExtensionEngine(next)
    if (destination.section === 'mcp' || destination.section === 'plugins' || destination.section === 'skills') {
      onNavigate({ ...destination, harness: next })
    }
  }

  // 从设置搜索 / 命令面板跳转到「MCP · OMP」等带引擎的入口时，切换器跟随目标引擎
  useEffect(() => {
    if ((destination.section === 'mcp' || destination.section === 'plugins' || destination.section === 'skills')
      && isExtensionEngine(destination.harness)) {
      setExtensionEngine(destination.harness)
    }
  }, [destination])

  useEffect(() => { searchRef.current?.focus() }, [])
  useEffect(() => {
    setQuery('')
    const content = contentRef.current
    const anchor = destination.anchor
    if (!content) return
    if (!anchor) {
      content.scrollTo(0, 0)
      return
    }
    const focusRow = () => {
      const element = document.getElementById(anchor)
      if (!element) return false
      element.scrollIntoView({ block: 'nearest' })
      element.focus({ preventScroll: true })
      return true
    }
    if (focusRow()) return
    const observer = new MutationObserver(() => { if (focusRow()) observer.disconnect() })
    observer.observe(content, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [destination])

  function navigate(next: SettingsDestination) {
    setComparedDestination(null)
    setQuery('')
    onNavigate(next)
  }

  async function refresh() {
    setProbing(true)
    setError(null)
    try { await props.onRefreshHarnesses() } catch (err) { setError(errorText(err)) } finally { setProbing(false) }
  }

  return (
    <div className="settings-page">
      <aside className="settings-sidebar" aria-label="设置分类">
        <label className="settings-search"><Search size={15} />
          <input ref={searchRef} aria-label="搜索设置" placeholder="搜索设置" value={query} onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (!event.nativeEvent.isComposing && event.key === 'Enter' && matches[0]) navigate(matches[0])
            }} />
        </label>
        {terms.length ? <div className="settings-search-results">
          {matches.map((entry) => <button type="button" key={entry.label} onClick={() => navigate(entry)}>
            {entry.label}<small>{settingsSectionLabel(entry.section)}</small>
          </button>)}
          {!matches.length && <p>没有匹配的设置</p>}
        </div> : <nav className="settings-nav">
          {(Object.keys(SETTINGS_SECTIONS) as SettingsSection[]).map((section) => {
            const { icon: Icon, label } = SETTINGS_SECTIONS[section]
            return <button type="button" key={section} aria-current={destination.section === section ? 'page' : undefined}
              onClick={() => navigate({ section })}><Icon size={16} />{label}</button>
          })}
        </nav>}
      </aside>
      <main ref={contentRef} className="settings-scroll">
        <div className="settings-content">
          {destination.section === 'appearance' && <AppearancePage settings={props.appearance} onSave={props.onSaveAppearance} />}
          {destination.section === 'conversation' && <ConversationPage settings={props.conversation} onSave={props.onSaveConversation} />}
          {destination.section === 'projects' && <ProjectPermissionsPage projects={props.projects} activeProjectId={props.activeProjectId}
            defaultPreset={props.defaultProjectTrust} onSaveProject={props.onSaveProjectTrust} onSaveDefault={props.onSaveDefaultProjectTrust} />}
          {destination.section === 'diagnostics' && <DiagnosticsPage />}
          {destination.section === 'mcp' && <McpSettingsPage engine={extensionEngine} onEngineChange={switchExtensionEngine}
            projects={props.projects} activeProjectId={props.activeProjectId} harnesses={extensionHarnesses} />}
          {destination.section === 'plugins' && <PluginsSettingsPage engine={extensionEngine} onEngineChange={switchExtensionEngine}
            projects={props.projects} activeProjectId={props.activeProjectId} harnesses={extensionHarnesses} />}
          {destination.section === 'skills' && <SkillsSettingsPage engine={extensionEngine} onEngineChange={switchExtensionEngine}
            projects={props.projects} activeProjectId={props.activeProjectId} harnesses={extensionHarnesses}
            sessionEngine={props.sessionEngine} sessionCommands={props.sessionCommands} onInsertToComposer={props.onInsertToComposer} />}
          {destination.section === 'usage' && <UsageSettingsPage projects={props.projects} />}
          {destination.section === 'browser' && <BrowserSettingsPage onOpenBrowserWindow={props.onOpenBrowserWindow} />}
          {destination.section === 'herdr' && <HerdrSettingsPage projects={props.projects} />}
          {destination.section === 'engines' && <>
            <div className="settings-page-heading settings-engine-heading">
              <div><h1>引擎与模型</h1><p>查看本机 CLI，配置启动路径和新会话默认值。</p></div>
              <div className="settings-actions">
                <button type="button" className="btn-small" disabled={probing} onClick={() => void refresh()}>
                  <RefreshCw size={13} className={probing ? 'spin' : undefined} />{probing ? '探测中…' : '重新探测'}
                </button>
                <button type="button" className="btn-small" aria-expanded={compare} onClick={() => setComparedDestination(compare ? null : destination)}>
                  {compare ? '返回引擎设置' : '对比引擎'}
                </button>
              </div>
            </div>
            {error && <p className="settings-feedback is-error" role="alert"><CircleAlert size={14} />{error}</p>}
            {compare ? <section className="settings-card settings-section">
              <h2>引擎能力对比</h2><p className="settings-caption">✓ 支持 · ◐ 部分支持 · — 不支持</p>
              <div className="settings-matrix"><table className="capability-matrix"><thead><tr><th scope="col">能力</th>
                {HARNESS_IDS.map((id) => <th scope="col" key={id}>{HARNESS_LABELS[id]}</th>)}
              </tr></thead><tbody>{CAPABILITY_LABELS.map(({ key, label }) => <tr key={key}>
                <th scope="row">{label}</th>{HARNESS_IDS.map((id) => <td key={id}><CapabilityMark support={HARNESS_CAPABILITIES[id][key]} /></td>)}
              </tr>)}</tbody></table></div>
            </section> : <div className="settings-engine-layout">
              <div className="settings-engine-list" role="group" aria-label="选择引擎">
                {HARNESS_IDS.map((id) => {
                  const status = props.harnesses[id]
                  return <button key={id} type="button" aria-pressed={selected === id} onClick={() => navigate({ section: 'engines', harness: id })}>
                    <span className={`dot ${status.ready ? 'dot-ready' : 'dot-idle'}`} />
                    <span>{HARNESS_LABELS[id]}<small>{status.ready ? status.version ?? '就绪' : status.path ? '探测失败' : '未找到'}</small></span>
                    <ChevronRight size={13} />
                  </button>
                })}
              </div>
              <EngineDetails key={selected} id={selected} props={props} />
            </div>}
          </>}
        </div>
      </main>
    </div>
  )
}
