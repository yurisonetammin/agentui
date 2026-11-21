// Herdr 内嵌交互终端：xterm.js 渲染 `herdr terminal session observe|control` 的
// terminal.frame 整屏流（base64 ANSI），接管输入后经 terminal.input 转发键盘/粘贴，
// terminal.resize 跟随窗口。默认只读观察；关闭面板即释放控制权，终端进程由 Herdr 继续。

import { useCallback, useEffect, useRef, useState } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { errorText } from './SettingsControls'
import type { HerdrFrameEvent, HerdrStreamClosedEvent, HerdrStreamMode } from '@shared/herdr'

interface HerdrTerminalViewProps {
  paneId: string
  connectionId: number
  label?: string | null
}

interface MountedTerminal {
  term: Terminal
  stream: { streamId: string; mode: HerdrStreamMode } | null
  attaching: boolean
  earlyFrames: HerdrFrameEvent[]
}

function releaseStream(streamId: string) {
  void window.agentui.herdrReleaseStream(streamId).catch(() => undefined)
}

function base64ToBytes(data: string): Uint8Array {
  const binary = atob(data)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function buildTheme(dark: boolean) {
  return dark
    ? { background: '#18191b', foreground: '#e9e9e7', cursor: '#e9e9e7' }
    : { background: '#1e1f21', foreground: '#e6e5e2', cursor: '#f2f1ee' }
}

export function HerdrTerminalView({ paneId, connectionId, label }: HerdrTerminalViewProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const mountedRef = useRef<MountedTerminal | null>(null)

  const [mode, setMode] = useState<HerdrStreamMode>('observe')
  const [connected, setConnected] = useState(false)
  const [closed, setClosed] = useState<{ reason: HerdrStreamClosedEvent['reason']; message: string | null } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirmTakeover, setConfirmTakeover] = useState(false)
  const [busy, setBusy] = useState(false)

  const attach = useCallback(async (nextMode: HerdrStreamMode, takeover: boolean) => {
    const mounted = mountedRef.current
    if (!mounted || mounted.attaching) return
    mounted.attaching = true
    mounted.earlyFrames = []
    if (mounted.stream) {
      releaseStream(mounted.stream.streamId)
      mounted.stream = null
    }
    setBusy(true)
    setError(null)
    setConfirmTakeover(false)
    const { term } = mounted
    try {
      const { streamId, mode: actualMode } = await window.agentui.herdrAttachStream(paneId, {
        mode: nextMode,
        cols: Math.max(10, term.cols),
        rows: Math.max(4, term.rows),
        takeover,
        connectionId,
      })
      if (mountedRef.current !== mounted) {
        releaseStream(streamId)
        return
      }
      mounted.stream = { streamId, mode: actualMode }
      setMode(actualMode)
      setClosed(null)
      setConnected(true)
      term.clear()
      term.write(`\x1b[2m[Herdr ${actualMode === 'observe' ? '观察模式' : '已接管输入'} · ${paneId}]\x1b[0m\r\n`)
      // 回放 attach 返回前到达的帧（仅本流；被替换旧流的帧丢弃）。
      for (const frame of mounted.earlyFrames) {
        if (frame.streamId === streamId) term.write(base64ToBytes(frame.data))
      }
    } catch (err) {
      if (mountedRef.current !== mounted) return
      const message = errorText(err)
      if (nextMode === 'control' && !takeover) {
        // 一个终端同时只允许一个控制端——询问是否抢占。
        setConfirmTakeover(true)
        setError(message)
      } else {
        setError(message)
        setConnected(false)
      }
    } finally {
      mounted.attaching = false
      mounted.earlyFrames = []
      if (mountedRef.current === mounted) setBusy(false)
    }
  }, [connectionId, paneId])

  // 组件挂载时创建 xterm 与事件订阅；paneId 变化重开流。
  useEffect(() => {
    const dark = window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? true
    const term = new Terminal({
      fontFamily: 'Consolas, "Cascadia Mono", monospace',
      fontSize: 12,
      cursorBlink: false,
      convertEol: false,
      scrollback: 4000,
      theme: buildTheme(dark),
      allowProposedApi: true,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    const mounted: MountedTerminal = { term, stream: null, earlyFrames: [], attaching: false }
    mountedRef.current = mounted
    if (hostRef.current) term.open(hostRef.current)

    const onFrame = (event: HerdrFrameEvent) => {
      const current = mounted.stream
      if (!current) {
        // 流 ID 还没拿到（attach 未返回）：先暂存本面板的帧，attach 成功后回放。
        if (mounted.attaching && event.paneId === paneId) mounted.earlyFrames.push(event)
        return
      }
      if (event.streamId !== current.streamId) return
      term.write(base64ToBytes(event.data))
    }
    const onClosed = (event: HerdrStreamClosedEvent) => {
      if (event.streamId !== mounted.stream?.streamId) return
      setConnected(false)
      setClosed({ reason: event.reason, message: event.message })
      mounted.stream = null
    }
    const unsubFrame = window.agentui.onHerdrFrame(onFrame)
    const unsubClosed = window.agentui.onHerdrStreamClosed(onClosed)
    const dataDisposable = term.onData((data) => {
      const current = mounted.stream
      if (current?.mode !== 'control') return
      void window.agentui.herdrStreamInput(current.streamId, data).catch((err) => {
        if (mountedRef.current === mounted) setError(errorText(err))
      })
    })
    const binaryDisposable = term.onBinary((data) => {
      const current = mounted.stream
      if (current?.mode !== 'control') return
      void window.agentui.herdrStreamInput(current.streamId, data).catch(() => undefined)
    })

    // 等到容器完成布局。StrictMode 清理试挂载时也会取消这次连接。
    const firstLayout = requestAnimationFrame(() => {
      if (mountedRef.current !== mounted) return
      try { fit.fit() } catch { /* fit 失败时先使用终端默认大小 */ }
      void attach('observe', false)
    })

    // 容器尺寸变化时重排；控制态把新尺寸同步给 Herdr。
    const observer = new ResizeObserver(() => {
      if (!hostRef.current || hostRef.current.clientWidth === 0) return
      try { fit.fit() } catch { /* ignore */ }
      const current = mounted.stream
      if (current?.mode === 'control') {
        void window.agentui.herdrStreamResize(current.streamId, term.cols, term.rows).catch(() => undefined)
      }
    })
    if (hostRef.current) observer.observe(hostRef.current)

    return () => {
      mountedRef.current = null
      cancelAnimationFrame(firstLayout)
      observer.disconnect()
      dataDisposable.dispose()
      binaryDisposable.dispose()
      unsubFrame()
      unsubClosed()
      if (mounted.stream) releaseStream(mounted.stream.streamId)
      term.dispose()
    }
  }, [attach, paneId])

  const inputEnabled = mode === 'control' && connected

  return (
    <div className="herdr-terminal-view">
      <div className="herdr-terminal-toolbar">
        <span className="herdr-terminal-title" title={paneId}>
          {label ? `${label} · ` : ''}{paneId}
        </span>
        <span className={`herdr-terminal-state ${connected ? 'is-live' : 'is-dead'}`}>
          {closed ? '已断开' : connected ? (mode === 'control' ? '已接管' : '观察中') : '连接中…'}
        </span>
        <div className="herdr-terminal-actions">
          {mode === 'observe' && (
            <button type="button" className="btn" disabled={busy || !connected}
              onClick={() => void attach('control', false)}>接管输入</button>
          )}
          {mode === 'control' && (
            <button type="button" className="btn" disabled={busy}
              onClick={() => { setConnected(false); void attach('observe', false) }}>退出接管</button>
          )}
          <button type="button" className="btn" disabled={busy}
            onClick={() => void attach(mode, false)}>重连</button>
        </div>
      </div>
      {confirmTakeover && (
        <div className="herdr-takeover-confirm">
          <span>{error ?? '该终端已被其他客户端控制。'}</span>
          <div>
            <button type="button" className="btn" disabled={busy}
              onClick={() => void attach('control', true)}>抢占接管</button>
            <button type="button" className="btn" onClick={() => { setConfirmTakeover(false); setError(null) }}>取消</button>
          </div>
        </div>
      )}
      {!inputEnabled && (
        <p className="herdr-terminal-hint">
          {closed
            ? `流已关闭${closed.message ? `：${closed.message}` : ''}。`
            : mode === 'observe' && connected
              ? '只读观察中——点击「接管输入」转发键盘与粘贴（Herdr 同一终端仅允许一个控制端）。'
              : '正在连接 Herdr 终端流…'}
        </p>
      )}
      <div ref={hostRef} className="herdr-terminal-host" />
    </div>
  )
}
