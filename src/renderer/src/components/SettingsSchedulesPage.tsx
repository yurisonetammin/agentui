import { useCallback, useEffect, useState } from 'react'
import {
  Activity,
  Check,
  CircleAlert,
  Clock,
  Loader2,
  Play,
  Plus,
  RefreshCw,
  Trash2,
} from 'lucide-react'
import {
  CRON_PRESETS,
  isValidCronExpression,
  type PrimeHeartbeatStatus,
  type ScheduleSnapshot,
} from '@shared/scheduler'
import type { AppearanceSettings } from '@shared/settings'
import { TRUST_PRESETS, TRUST_PRESET_LABELS, type TrustPreset } from '@shared/tool-policy'
import { HARNESS_IDS, HARNESS_LABELS, type HarnessId, type ProjectEntry } from '@shared/types'
import { errorText, SettingsRow } from './SettingsControls'

function formatTime(ms: number | null | undefined): string {
  if (!ms) return '—'
  return new Date(ms).toLocaleString()
}

export function SchedulesSettingsPage({
  projects,
  activeProjectId,
  activeHarness,
  appearance,
  onSaveAppearance,
}: {
  projects: ProjectEntry[]
  activeProjectId: string | null
  activeHarness: HarnessId
  appearance: AppearanceSettings
  onSaveAppearance: (patch: Partial<AppearanceSettings>) => Promise<void>
}) {
  const [snapshot, setSnapshot] = useState<ScheduleSnapshot | null>(null)
  const [primeStatus, setPrimeStatus] = useState<PrimeHeartbeatStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [primeLoading, setPrimeLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [feedback, setFeedback] = useState<string | null>(null)

  const [name, setName] = useState('')
  const [cron, setCron] = useState('0 9 * * *')
  const [projectId, setProjectId] = useState(() => activeProjectId ?? projects[0]?.id ?? '')
  const [harness, setHarness] = useState<HarnessId>(activeHarness)
  const [trustPreset, setTrustPreset] = useState<TrustPreset>('readonly')
  const [prompt, setPrompt] = useState('')
  const [notifyOnFailure, setNotifyOnFailure] = useState(true)

  useEffect(() => {
    if (!projectId && projects[0]) setProjectId(activeProjectId ?? projects[0].id)
  }, [projects, activeProjectId, projectId])

  const loadAll = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const snap = await window.agentui.schedulesList()
      setSnapshot(snap)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setLoading(false)
    }
  }, [])

  const loadPrimeHeartbeat = useCallback(async () => {
    setPrimeLoading(true)
    try {
      setPrimeStatus(await window.agentui.schedulesPrimeHeartbeat())
    } catch {
      setPrimeStatus(null)
    } finally {
      setPrimeLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadAll()
    void loadPrimeHeartbeat()
    return window.agentui.onScheduleUpdated((next) => setSnapshot(next))
  }, [loadAll, loadPrimeHeartbeat])

  const cronValid = isValidCronExpression(cron)

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim() || !cronValid || !projectId || !prompt.trim() || saving) return
    setSaving(true)
    setError(null)
    setFeedback(null)
    try {
      const next = await window.agentui.schedulesUpsert({
        name: name.trim(),
        cron: cron.trim(),
        projectId,
        harness,
        trustPreset,
        prompt: prompt.trim(),
        enabled: true,
        notifyOnFailure,
      })
      setSnapshot(next)
      setName('')
      setPrompt('')
      setFeedback('定时任务已创建并加入调度队列。')
    } catch (err) {
      setError(errorText(err))
    } finally {
      setSaving(false)
    }
  }

  async function handleToggle(taskId: string, enabled: boolean) {
    setError(null)
    try {
      setSnapshot(await window.agentui.schedulesToggle(taskId, enabled))
    } catch (err) {
      setError(errorText(err))
    }
  }

  async function handleDelete(taskId: string) {
    setError(null)
    try {
      setSnapshot(await window.agentui.schedulesDelete(taskId))
    } catch (err) {
      setError(errorText(err))
    }
  }

  async function handleRunNow(taskId: string) {
    setError(null)
    setFeedback(null)
    try {
      const rec = await window.agentui.schedulesRunNow(taskId)
      setFeedback(
        rec.status === 'success'
          ? `任务「${rec.taskName}」手动执行成功`
          : `任务「${rec.taskName}」执行失败：${rec.error ?? '未知错误'}`,
      )
    } catch (err) {
      setError(errorText(err))
    }
  }

  const projectNameMap = new Map(projects.map((p) => [p.id, p.name]))

  return (
    <>
      <div className="settings-page-heading">
        <h1>定时任务与心跳</h1>
        <p>配置按 Cron 自动触发的后台巡检、仓库摘要任务，查看 Prime Agent 原生后台服务状态。</p>
      </div>

      {error && <p className="settings-feedback is-error" role="alert"><CircleAlert size={14} />{error}</p>}
      {feedback && <p className="settings-feedback is-success" role="status"><Check size={14} />{feedback}</p>}

      <section id="schedules-tray" tabIndex={-1} className="settings-card settings-section">
        <SettingsRow
          id="schedules-tray-row"
          label="关闭窗口时最小化到系统托盘"
          description="开启后点击主窗口关闭按钮会驻留在系统托盘，保持后台定时任务按时触发；从托盘右键菜单可彻底退出。"
        >
          <button
            className="settings-switch"
            type="button"
            role="switch"
            aria-labelledby="schedules-tray-row-label"
            aria-checked={appearance.closeToTray}
            onClick={() => void onSaveAppearance({ closeToTray: !appearance.closeToTray }).catch((err) => setError(errorText(err)))}
          >
            <span />
          </button>
        </SettingsRow>
      </section>

      <section id="schedules-create" tabIndex={-1} className="settings-card settings-section">
        <div className="settings-section-heading">
          <h2>新建定时任务</h2>
        </div>
        <form className="schedule-form" onSubmit={(e) => void handleCreate(e)}>
          <div className="schedule-form-grid">
            <label>
              任务名称
              <input
                type="text"
                className="text-input"
                placeholder="例如：每日代码变更摘要"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
            </label>
            <label>
              Cron 表达式（分 时 日 月 周）
              <input
                type="text"
                className="text-input"
                placeholder="0 9 * * *"
                value={cron}
                onChange={(e) => setCron(e.target.value)}
                aria-invalid={!cronValid}
                required
              />
            </label>
          </div>
          <div className="schedule-preset-row">
            {CRON_PRESETS.map((p) => (
              <button
                key={p.expr}
                type="button"
                className={`btn-small${cron.trim() === p.expr ? ' is-selected' : ''}`}
                title={p.description}
                onClick={() => setCron(p.expr)}
              >
                {p.label}
              </button>
            ))}
            {!cronValid && <span className="schedule-cron-err">表达式格式无效</span>}
          </div>
          <div className="schedule-form-grid schedule-form-grid-3">
            <label>
              目标项目
              <select className="text-input" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                {projects.length === 0 && <option value="">请先添加项目</option>}
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </label>
            <label>
              执行引擎
              <select className="text-input" value={harness} onChange={(e) => setHarness(e.target.value as HarnessId)}>
                {HARNESS_IDS.map((id) => (
                  <option key={id} value={id}>{HARNESS_LABELS[id]}</option>
                ))}
              </select>
            </label>
            <label>
              权限预设（无人值守建议只读）
              <select className="text-input" value={trustPreset} onChange={(e) => setTrustPreset(e.target.value as TrustPreset)}>
                {TRUST_PRESETS.map((preset) => (
                  <option key={preset} value={preset}>{TRUST_PRESET_LABELS[preset]}</option>
                ))}
              </select>
            </label>
          </div>
          <label>
            执行指令
            <textarea
              className="text-input"
              rows={3}
              placeholder="例如：检查最近 24 小时的 git log 与 TODO 注释，汇总一份简短巡检报告。"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              required
            />
          </label>
          <div className="schedule-form-footer">
            <label className="schedule-checkbox">
              <input
                type="checkbox"
                checked={notifyOnFailure}
                onChange={(e) => setNotifyOnFailure(e.target.checked)}
              />
              <span>执行失败时发送系统桌面通知</span>
            </label>
            <button
              type="submit"
              className="btn-primary"
              disabled={saving || !name.trim() || !cronValid || !projectId || !prompt.trim()}
            >
              <Plus size={13} />
              {saving ? '创建中…' : '添加定时任务'}
            </button>
          </div>
        </form>
      </section>

      <section id="schedules-list" tabIndex={-1} className="settings-card settings-section">
        <div className="settings-section-heading">
          <h2>已配置任务（{snapshot?.tasks.length ?? 0}）</h2>
          <button type="button" className="btn-small" onClick={() => void loadAll()}>
            <RefreshCw size={12} /> 刷新
          </button>
        </div>
        {loading && !snapshot ? (
          <p className="settings-caption">正在加载定时任务…</p>
        ) : !snapshot || snapshot.tasks.length === 0 ? (
          <p className="settings-caption">还没有定时任务，可在上方创建每日巡检或定时摘要。</p>
        ) : (
          <div className="schedule-task-list">
            {snapshot.tasks.map((task) => {
              const running = snapshot.runningTaskIds.includes(task.id)
              const nextRun = snapshot.nextRuns[task.id]
              return (
                <div key={task.id} className="schedule-task-item">
                  <div className="schedule-task-main">
                    <div className="schedule-task-title-row">
                      <strong>{task.name}</strong>
                      <span className="mono-chip">{task.cron}</span>
                      <span className={`harness-tag tag-${task.harness}`}>{HARNESS_LABELS[task.harness]}</span>
                      <span className="mono-chip">{TRUST_PRESET_LABELS[task.trustPreset]}</span>
                      {running && (
                        <span className="schedule-badge is-running">
                          <Loader2 size={11} className="spin" /> 运行中
                        </span>
                      )}
                      {!running && task.lastStatus === 'success' && (
                        <span className="schedule-badge is-ok">上次成功</span>
                      )}
                      {!running && task.lastStatus === 'error' && (
                        <span className="schedule-badge is-err">上次失败</span>
                      )}
                    </div>
                    <p className="schedule-task-prompt">{task.prompt}</p>
                    <div className="schedule-task-meta">
                      <span>项目：{projectNameMap.get(task.projectId) ?? task.projectId}</span>
                      <span><Clock size={11} /> 下次运行：{task.enabled ? formatTime(nextRun) : '已暂停'}</span>
                      {task.lastRunAt && <span>最近运行：{formatTime(task.lastRunAt)}</span>}
                    </div>
                    {task.lastError && <p className="settings-feedback is-error">{task.lastError}</p>}
                  </div>
                  <div className="schedule-task-actions">
                    <button
                      type="button"
                      className="settings-switch"
                      role="switch"
                      aria-label={`启用任务 ${task.name}`}
                      aria-checked={task.enabled}
                      onClick={() => void handleToggle(task.id, !task.enabled)}
                    >
                      <span />
                    </button>
                    <button
                      type="button"
                      className="btn-small"
                      disabled={running}
                      title="立即运行一次"
                      onClick={() => void handleRunNow(task.id)}
                    >
                      <Play size={12} /> 立即运行
                    </button>
                    <button
                      type="button"
                      className="icon-btn"
                      title="删除任务"
                      aria-label={`删除任务 ${task.name}`}
                      onClick={() => void handleDelete(task.id)}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </section>

      <section id="schedules-prime" tabIndex={-1} className="settings-card settings-section">
        <div className="settings-section-heading">
          <h2><Activity size={14} style={{ verticalAlign: -2, marginRight: 6 }} />Prime Agent 后台服务与原生心跳</h2>
          <button type="button" className="btn-small" disabled={primeLoading} onClick={() => void loadPrimeHeartbeat()}>
            <RefreshCw size={12} className={primeLoading ? 'spin' : undefined} /> 检测
          </button>
        </div>
        {!primeStatus ? (
          <p className="settings-caption">正在检测 Prime Agent 后台服务…</p>
        ) : (
          <div className="schedule-prime-box">
            <div className="schedule-prime-status">
              <span className={`dot ${primeStatus.daemonRunning ? 'dot-ready' : 'dot-idle'}`} />
              <span>
                {!primeStatus.installed
                  ? '未安装 Prime Agent'
                  : primeStatus.daemonRunning
                    ? `后台服务运行中（Prime ${primeStatus.version ?? ''}）`
                    : `后台服务未运行（Prime ${primeStatus.version ?? ''}）`}
              </span>
            </div>
            {primeStatus.note && <p className="settings-caption">{primeStatus.note}</p>}
            {primeStatus.daemons.length > 0 && (
              <div className="schedule-prime-daemons">
                {primeStatus.daemons.map((d, idx) => (
                  <div key={`${d.socketPath}-${idx}`} className="schedule-prime-row">
                    <code>{d.socketPath || 'default'}</code>
                    <span className="mono-chip">{d.status}</span>
                    {d.hasTrackedWorkers && <span className="mono-chip">tracked workers</span>}
                  </div>
                ))}
              </div>
            )}
            {primeStatus.nativeSchedules.length > 0 && (
              <div className="schedule-prime-list">
                <h3>Prime 原生计划任务（{primeStatus.nativeSchedules.length}）</h3>
                {primeStatus.nativeSchedules.map((item, idx) => (
                  <div key={item.id ?? idx} className="schedule-prime-row">
                    <span>{item.agent ?? 'default'}</span>
                    {item.schedule && <span className="mono-chip">{item.schedule}</span>}
                    <span className="schedule-prime-prompt">{item.prompt ?? item.raw}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </section>

      <section id="schedules-history" tabIndex={-1} className="settings-card settings-section">
        <div className="settings-section-heading">
          <h2>最近执行记录（{snapshot?.runs.length ?? 0}）</h2>
        </div>
        {!snapshot || snapshot.runs.length === 0 ? (
          <p className="settings-caption">暂无执行记录。</p>
        ) : (
          <div className="schedule-run-list">
            {snapshot.runs.slice(0, 20).map((run) => (
              <details key={run.id} className="schedule-run-item">
                <summary>
                  <span className={`schedule-badge ${run.status === 'success' ? 'is-ok' : 'is-err'}`}>
                    {run.status === 'success' ? '成功' : '失败'}
                  </span>
                  <strong>{run.taskName}</strong>
                  <span className="mono-chip">{run.trigger === 'manual' ? '手动' : 'Cron'}</span>
                  <span className="mono-chip">{HARNESS_LABELS[run.harness]}</span>
                  <span className="schedule-run-time">{formatTime(run.startedAt)}</span>
                </summary>
                <div className="schedule-run-body">
                  {run.error && <p className="settings-feedback is-error">{run.error}</p>}
                  {run.summary && <pre className="schedule-run-summary">{run.summary}</pre>}
                </div>
              </details>
            ))}
          </div>
        )}
      </section>
    </>
  )
}
