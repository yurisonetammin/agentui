import { useEffect, useRef, useState } from 'react'
import { Loader2, Play, Square, TerminalSquare, Trash2 } from 'lucide-react'

/**
 * Embedded command runner panel (zero-native, non-PTY).
 * Each command runs via an explicit shell process in the main process;
 * interactive TUI programs are not supported (see PLAN.md upgrade path).
 */

const MAX_OUTPUT_CHARS = 300_000
const TRUNC_HEADER = /^\[输出过长，已截断前 (\d+) 字符\]\n/

/** Cap output, keeping a single cumulative truncation header. */
function capOutput(raw: string): string {
  if (raw.length <= MAX_OUTPUT_CHARS) return raw
  const m = raw.match(TRUNC_HEADER)
  const prior = m ? Number(m[1]) : 0
  const body = m ? raw.slice(m[0].length) : raw
  const drop = Math.max(0, body.length - MAX_OUTPUT_CHARS)
  return `[输出过长，已截断前 ${prior + drop} 字符]\n${body.slice(drop)}`
}
const MAX_RUNS_KEPT = 20

interface TerminalRunView {
  runId: string
  command: string
  output: string
  status: 'running' | 'done'
  exitCode: number | null
  timedOut: boolean
}

export function TerminalPanel({ cwd }: { cwd: string }) {
  const [runs, setRuns] = useState<TerminalRunView[]>([])
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [command, setCommand] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [history, setHistory] = useState<string[]>([])
  const [historyIdx, setHistoryIdx] = useState(-1)
  const outputRef = useRef<HTMLPreElement | null>(null)
  const ownedRunsRef = useRef<Set<string>>(new Set())
  const bufferRef = useRef<Map<string, string>>(new Map())
  const orphanOutRef = useRef<Map<string, string>>(new Map())
  const orphanExitRef = useRef<Map<string, { code: number | null; timedOut: boolean }>>(new Map())
  const stickToBottomRef = useRef(true)

  // Flush buffered output at ~8fps to avoid re-render storms on heavy output
  useEffect(() => {
    const flush = () => {
      if (bufferRef.current.size === 0) return
      const pending = bufferRef.current
      bufferRef.current = new Map()
      setRuns((prev) =>
        prev.map((run) => {
          const chunk = pending.get(run.runId)
          if (!chunk) return run
          const output = capOutput(run.output + chunk)
          return { ...run, output }
        }),
      )
    }
    const timer = setInterval(flush, 120)
    return () => clearInterval(timer)
  }, [])

  useEffect(() => {
    const unsubOutput = window.agentui.onTerminalOutput((event) => {
      if (!ownedRunsRef.current.has(event.runId)) {
        // Events can arrive before terminalStart() resolves; stash them for adoption.
        orphanOutRef.current.set(event.runId, (orphanOutRef.current.get(event.runId) ?? '') + event.text)
        return
      }
      const prev = bufferRef.current.get(event.runId) ?? ''
      bufferRef.current.set(event.runId, prev + event.text)
    })
    const unsubExit = window.agentui.onTerminalExit((event) => {
      if (!ownedRunsRef.current.has(event.runId)) {
        orphanExitRef.current.set(event.runId, { code: event.code, timedOut: event.timedOut })
        return
      }
      // Flush any buffered output first so it never lands after the exit badge.
      const tail = bufferRef.current.get(event.runId)
      bufferRef.current.delete(event.runId)
      setRuns((prev) =>
        prev.map((run) =>
          run.runId === event.runId
            ? {
                ...run,
                output: tail ? capOutput(run.output + tail) : run.output,
                status: 'done',
                exitCode: event.code,
                timedOut: event.timedOut,
              }
            : run,
        ),
      )
    })
    return () => {
      unsubOutput()
      unsubExit()
    }
  }, [])

  const selectedRun = runs.find((r) => r.runId === selectedRunId) ?? runs[runs.length - 1] ?? null

  useEffect(() => {
    if (stickToBottomRef.current && outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight
    }
  }, [selectedRun?.output, selectedRun?.runId])

  async function runCommand() {
    const trimmed = command.trim()
    if (!trimmed) return
    setError(null)
    try {
      const runId = await window.agentui.terminalStart(cwd, trimmed)
      ownedRunsRef.current.add(runId)
      const earlyOut = orphanOutRef.current.get(runId) ?? ''
      const earlyExit = orphanExitRef.current.get(runId)
      orphanOutRef.current.delete(runId)
      orphanExitRef.current.delete(runId)
      setRuns((prev) =>
        [
          ...prev,
          {
            runId,
            command: trimmed,
            output: capOutput(earlyOut),
            status: earlyExit ? ('done' as const) : ('running' as const),
            exitCode: earlyExit ? earlyExit.code : null,
            timedOut: earlyExit?.timedOut ?? false,
          },
        ].slice(-MAX_RUNS_KEPT),
      )
      setSelectedRunId(runId)
      setHistory((prev) => [...prev.filter((h) => h !== trimmed), trimmed].slice(-50))
      setHistoryIdx(-1)
      setCommand('')
      stickToBottomRef.current = true
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div className="terminal-panel">
      <div className="terminal-note">
        <TerminalSquare size={12} />
        非交互式命令运行器（零原生依赖，非 PTY）：支持 git / npm / 构建等命令，不支持 vim 等全屏交互程序。
      </div>

      {runs.length > 0 && (
        <div className="terminal-run-list">
          {runs.map((run) => (
            <button
              key={run.runId}
              type="button"
              className={`terminal-run-chip ${selectedRun?.runId === run.runId ? 'active' : ''}`}
              onClick={() => {
                setSelectedRunId(run.runId)
                stickToBottomRef.current = true
              }}
              title={run.command}
            >
              {run.status === 'running' ? (
                <Loader2 size={10} className="spin" />
              ) : (
                <span
                  className="dot"
                  style={{ background: run.exitCode === 0 ? 'var(--success)' : 'var(--danger)' }}
                />
              )}
              <span className="terminal-run-cmd">{run.command}</span>
            </button>
          ))}
        </div>
      )}

      <div className="terminal-output-wrap">
        {selectedRun ? (
          <pre
            ref={outputRef}
            className="terminal-output"
            onScroll={(e) => {
              const el = e.currentTarget
              stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
            }}
          >
            {selectedRun.output || '(等待输出...)'}
            {selectedRun.status === 'done' && (
              <span className={selectedRun.exitCode === 0 ? 'terminal-exit-ok' : 'terminal-exit-err'}>
                {`\n[退出码 ${selectedRun.exitCode ?? '?'}${selectedRun.timedOut ? ' · 超时终止' : ''}]`}
              </span>
            )}
          </pre>
        ) : (
          <div className="ws-preview-empty">在下方输入命令并回车执行，例如 `git status`、`npm test`。</div>
        )}
        {selectedRun?.status === 'running' && (
          <button
            type="button"
            className="btn-small terminal-stop-btn"
            title="终止此命令（含子进程）"
            onClick={() => void window.agentui.terminalStop(selectedRun.runId).catch((e) => setError(String(e)))}
          >
            <Square size={11} />
            停止
          </button>
        )}
      </div>

      {error && <div className="msg-notice error" style={{ margin: '0 8px' }}>{error}</div>}

      <div className="terminal-input-row">
        <span className="terminal-prompt">$</span>
        <input
          type="text"
          className="text-input terminal-input"
          placeholder={`在 ${cwd.split(/[\\/]/).pop() || cwd} 中执行命令...`}
          value={command}
          onChange={(e) => {
            setCommand(e.target.value)
            setHistoryIdx(-1)
          }}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return
            if (e.key === 'Enter') {
              e.preventDefault()
              void runCommand()
            } else if (e.key === 'ArrowUp' && history.length > 0) {
              e.preventDefault()
              const nextIdx = historyIdx < 0 ? history.length - 1 : Math.max(0, historyIdx - 1)
              setHistoryIdx(nextIdx)
              setCommand(history[nextIdx])
            } else if (e.key === 'ArrowDown' && historyIdx >= 0) {
              e.preventDefault()
              const nextIdx = historyIdx + 1
              if (nextIdx >= history.length) {
                setHistoryIdx(-1)
                setCommand('')
              } else {
                setHistoryIdx(nextIdx)
                setCommand(history[nextIdx])
              }
            }
          }}
        />
        <button type="button" className="btn-primary" disabled={!command.trim()} onClick={() => void runCommand()}>
          <Play size={12} />
          运行
        </button>
        <button
          type="button"
          className="icon-btn"
          title="清空已结束的命令记录"
          disabled={runs.length === 0}
          onClick={() => {
            setRuns((prev) => prev.filter((r) => r.status === 'running'))
            setSelectedRunId(null)
          }}
        >
          <Trash2 size={13} />
        </button>
      </div>
    </div>
  )
}