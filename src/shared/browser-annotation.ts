/**
 * Pure types and Composer formatter for standalone browser DOM element picking
 * and visual annotation sharing.
 */

export interface BrowserElementRect {
  x: number
  y: number
  width: number
  height: number
  viewportWidth: number
  viewportHeight: number
}

export interface BrowserPickedElement {
  selector: string
  tag: string
  id?: string
  classes: string[]
  role?: string
  text: string
  rect: BrowserElementRect
  url: string
  title: string
  /** Base64-encoded PNG of the cropped element region (no data: prefix). */
  imageData?: string
  mimeType?: string
}

export interface BrowserAnnotationShareInput {
  threadId: string
  element: BrowserPickedElement
  note: string
}

const MAX_TEXT_SNIPPET = 220

/**
 * Format a picked DOM element and optional user annotation note into a compact
 * markdown block suitable for insertion into the Composer draft.
 */
export function formatBrowserAnnotationForComposer(
  element: BrowserPickedElement,
  note: string,
): string {
  const lines: string[] = []
  const trimmedNote = note.trim()
  if (trimmedNote) {
    lines.push(trimmedNote, '')
  }

  const pageLabel = element.title?.trim()
    ? `[${element.title.trim()}](${element.url})`
    : element.url || '当前网页'
  lines.push(`> **页面元素批注** · ${pageLabel}`)
  lines.push(`> - 选择器：\`${element.selector}\``)

  const metaParts: string[] = [`标签 \`<${element.tag.toLowerCase()}>\``]
  if (element.role) metaParts.push(`role=\`${element.role}\``)
  const w = Math.max(0, Math.round(element.rect.width))
  const h = Math.max(0, Math.round(element.rect.height))
  const x = Math.round(element.rect.x)
  const y = Math.round(element.rect.y)
  metaParts.push(`尺寸 ${w}×${h} @ (${x}, ${y})`)
  lines.push(`> - 节点信息：${metaParts.join(' · ')}`)

  const excerpt = element.text.replace(/\s+/g, ' ').trim()
  if (excerpt) {
    const clipped = excerpt.length > MAX_TEXT_SNIPPET ? `${excerpt.slice(0, MAX_TEXT_SNIPPET)}…` : excerpt
    lines.push(`> - 文本摘要：${clipped}`)
  }

  return lines.join('\n')
}
