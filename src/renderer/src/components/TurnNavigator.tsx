import { useEffect, useRef } from 'react'
import { AlertCircle, GitCompareArrows, ListOrdered } from 'lucide-react'
import type { TurnNavEntry } from '@shared/turn-navigator'

export function TurnNavigator({
  turns,
  onJumpToTurn,
  onOpenTurnDiff,
}: {
  turns: readonly TurnNavEntry[]
  onJumpToTurn: (timelineIndex: number) => void
  onOpenTurnDiff?: (summaryId: string) => void
}) {
  const detailsRef = useRef<HTMLDetailsElement>(null)

  useEffect(() => {
    function closeOutside(event: PointerEvent) {
      const menu = detailsRef.current
      if (menu?.open && event.target instanceof Node && !menu.contains(event.target)) {
        menu.open = false
      }
    }
    document.addEventListener('pointerdown', closeOutside)
    return () => document.removeEventListener('pointerdown', closeOutside)
  }, [])

  if (turns.length === 0) return null

  function closeMenu() {
    if (detailsRef.current) detailsRef.current.open = false
  }

  return (
    <details
      ref={detailsRef}
      className="turn-nav-menu"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && event.currentTarget.open) {
          event.stopPropagation()
          event.currentTarget.open = false
          event.currentTarget.querySelector('summary')?.focus()
        }
      }}
    >
      <summary className="turn-nav-trigger" title="会话轮次导航（快速跳转到指定提问）" aria-label="轮次导航">
        <ListOrdered size={14} />
        <span>{turns.length} 轮</span>
      </summary>
      <div className="turn-nav-card floating-card" role="region" aria-label="轮次列表">
        <div className="turn-nav-header">
          <span>轮次导航</span>
          <small>共 {turns.length} 轮对话</small>
        </div>
        <div className="turn-nav-list">
          {turns.map((turn) => (
            <div className="turn-nav-item" key={turn.userItemId}>
              <button
                type="button"
                className="turn-nav-jump"
                onClick={() => {
                  closeMenu()
                  onJumpToTurn(turn.timelineIndex)
                }}
              >
                <span className="turn-nav-num">#{turn.turnNumber}</span>
                <span className="turn-nav-text">
                  <span className="turn-nav-preview">{turn.promptPreview}</span>
                  {(turn.toolCount > 0 || turn.hasError) && (
                    <small className="turn-nav-meta">
                      {turn.toolCount > 0 ? `${turn.toolCount} 次工具` : ''}
                      {turn.hasError && (
                        <span className="turn-nav-err">
                          <AlertCircle size={11} /> 有异常
                        </span>
                      )}
                    </small>
                  )}
                </span>
              </button>
              {turn.changes && turn.summaryItemId && onOpenTurnDiff && (
                <button
                  type="button"
                  className="turn-nav-diff-btn"
                  title={`查看第 ${turn.turnNumber} 轮的文件差异（变更 ${turn.changes.files} 个文件）`}
                  onClick={() => {
                    closeMenu()
                    onOpenTurnDiff(turn.summaryItemId!)
                  }}
                >
                  <GitCompareArrows size={11} />
                  <span className="turn-changes-added">+{turn.changes.added}</span>
                  <span className="turn-changes-removed">−{turn.changes.removed}</span>
                </button>
              )}
            </div>
          ))}
        </div>
      </div>
    </details>
  )
}
