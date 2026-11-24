/**
 * Pure unified-diff line parser & Composer review comment formatter.
 * Supports both single-file git diffs and multi-file turn diffs.
 */

export type DiffLineKind = 'meta' | 'hunk' | 'context' | 'add' | 'del'

export interface ParsedDiffLine {
  index: number
  raw: string
  kind: DiffLineKind
  /** File path associated with this line (parsed from `+++ b/...` or fallback). */
  filePath: string | null
  oldLine: number | null
  newLine: number | null
}

function stripDiffPathPrefix(rawPath: string): string | null {
  const cleaned = rawPath.trim().replace(/^"(.*)"$/, '$1')
  if (!cleaned || cleaned === '/dev/null') return null
  return cleaned.replace(/^[ab]\//, '')
}

/**
 * Parse unified diff text into lines with accurate `oldLine`, `newLine`,
 * and per-line `filePath` (so multi-file turn diffs work seamlessly).
 */
export function parseUnifiedDiffLines(
  diffText: string,
  defaultFilePath?: string | null,
): ParsedDiffLine[] {
  if (!diffText.trim()) return []
  const rawLines = diffText.split(/\r?\n/)
  const out: ParsedDiffLine[] = []
  let currentFile: string | null = defaultFilePath ?? null
  let pendingOldFile: string | null = null
  let oldCursor = 0
  let newCursor = 0
  let inHunk = false

  for (let i = 0; i < rawLines.length; i += 1) {
    const raw = rawLines[i]

    if (raw.startsWith('diff --git ')) {
      inHunk = false
      const m = raw.match(/^diff --git a\/(.+?) b\/(.+)$/)
      if (m?.[2]) currentFile = m[2]
      pendingOldFile = m?.[1] ?? null
      out.push({ index: i, raw, kind: 'meta', filePath: currentFile, oldLine: null, newLine: null })
      continue
    }

    if (raw.startsWith('--- ')) {
      inHunk = false
      pendingOldFile = stripDiffPathPrefix(raw.slice(4)) ?? pendingOldFile
      out.push({ index: i, raw, kind: 'meta', filePath: currentFile ?? pendingOldFile, oldLine: null, newLine: null })
      continue
    }

    if (raw.startsWith('+++ ')) {
      inHunk = false
      const nextFile = stripDiffPathPrefix(raw.slice(4))
      // Deleted files have `+++ /dev/null`; fall back to the `--- a/...` path.
      currentFile = nextFile ?? pendingOldFile ?? currentFile
      out.push({ index: i, raw, kind: 'meta', filePath: currentFile, oldLine: null, newLine: null })
      continue
    }

    if (
      raw.startsWith('index ') ||
      raw.startsWith('new file mode ') ||
      raw.startsWith('deleted file mode ') ||
      raw.startsWith('old mode ') ||
      raw.startsWith('new mode ') ||
      raw.startsWith('rename from ') ||
      raw.startsWith('rename to ') ||
      raw.startsWith('similarity index ') ||
      raw.startsWith('Binary files ') ||
      raw.startsWith('\\ No newline at end of file')
    ) {
      out.push({ index: i, raw, kind: 'meta', filePath: currentFile, oldLine: null, newLine: null })
      continue
    }

    if (raw.startsWith('@@')) {
      const m = raw.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/)
      if (m) {
        oldCursor = Number(m[1])
        newCursor = Number(m[2])
        inHunk = true
      }
      out.push({ index: i, raw, kind: 'hunk', filePath: currentFile, oldLine: null, newLine: null })
      continue
    }

    if (inHunk && raw.startsWith('+')) {
      out.push({ index: i, raw, kind: 'add', filePath: currentFile, oldLine: null, newLine: newCursor })
      newCursor += 1
      continue
    }

    if (inHunk && raw.startsWith('-')) {
      out.push({ index: i, raw, kind: 'del', filePath: currentFile, oldLine: oldCursor, newLine: null })
      oldCursor += 1
      continue
    }

    if (inHunk) {
      // Context line (may be empty on trailing split newline — avoid incrementing on trailing empty EOF line)
      if (i === rawLines.length - 1 && raw === '') {
        continue
      }
      out.push({ index: i, raw, kind: 'context', filePath: currentFile, oldLine: oldCursor, newLine: newCursor })
      oldCursor += 1
      newCursor += 1
      continue
    }

    if (raw === '' && i === rawLines.length - 1) continue
    out.push({ index: i, raw, kind: 'meta', filePath: currentFile, oldLine: null, newLine: null })
  }

  return out
}

export interface DiffSelectionSummary {
  filePath: string
  startLine: number
  endLine: number
  side: 'new' | 'old'
  codeLines: string[]
}

/**
 * Compute the file path, effective line range, and code snippet for a selected slice
 * of parsed diff lines (restricting to code lines of the anchor's file).
 */
export function summarizeDiffSelection(
  lines: readonly ParsedDiffLine[],
  fromIdx: number,
  toIdx: number,
): DiffSelectionSummary | null {
  const start = Math.min(fromIdx, toIdx)
  const end = Math.max(fromIdx, toIdx)
  const anchor = lines[fromIdx]
  const targetFile = anchor?.filePath ?? lines.slice(start, end + 1).find((l) => l.filePath)?.filePath ?? null
  if (!targetFile) return null

  const picked = lines
    .slice(start, end + 1)
    .filter((l) => l.filePath === targetFile && (l.kind === 'context' || l.kind === 'add' || l.kind === 'del'))
  if (picked.length === 0) return null

  const newNums = picked.map((l) => l.newLine).filter((n): n is number => n !== null)
  const oldNums = picked.map((l) => l.oldLine).filter((n): n is number => n !== null)
  const side: 'new' | 'old' = newNums.length > 0 ? 'new' : 'old'
  const nums = side === 'new' ? newNums : oldNums
  if (nums.length === 0) return null

  return {
    filePath: targetFile,
    startLine: Math.min(...nums),
    endLine: Math.max(...nums),
    side,
    codeLines: picked.map((l) => l.raw),
  }
}

const MAX_COMMENT_DIFF_LINES = 30

/** Format a line-range diff review comment for injection into the Composer draft. */
export function formatDiffCommentForComposer(
  selection: DiffSelectionSummary,
  comment: string,
): string {
  const rangeTag =
    selection.startLine === selection.endLine
      ? `L${selection.startLine}`
      : `L${selection.startLine}-L${selection.endLine}`
  const sideNote = selection.side === 'old' ? '（删除前原行号）' : ''
  const header = `@${selection.filePath}#${rangeTag}${sideNote}`
  const trimmedComment = comment.trim()
  const snippet = selection.codeLines.slice(0, MAX_COMMENT_DIFF_LINES)
  const truncatedNote =
    selection.codeLines.length > MAX_COMMENT_DIFF_LINES
      ? `\n... (已省略其余 ${selection.codeLines.length - MAX_COMMENT_DIFF_LINES} 行)`
      : ''

  const lead = trimmedComment ? `${header} ${trimmedComment}` : `${header}`
  return `${lead}\n\`\`\`diff\n${snippet.join('\n')}${truncatedNote}\n\`\`\``
}

export interface SideBySideCell {
  parsedIndex: number
  lineNum: number | null
  text: string
  kind: 'context' | 'add' | 'del'
  filePath: string | null
}

export type SideBySideDiffRow =
  | { type: 'meta' | 'hunk'; parsedIndex: number; raw: string; filePath: string | null }
  | { type: 'pair'; left: SideBySideCell | null; right: SideBySideCell | null }

/**
 * Convert parsed unified diff lines into side-by-side rows by pairing
 * contiguous deletion and addition blocks while preserving each cell's
 * original `parsedIndex` so line selection & review comments still work.
 */
export function buildSideBySideDiffRows(lines: readonly ParsedDiffLine[]): SideBySideDiffRow[] {
  const rows: SideBySideDiffRow[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]!
    if (line.kind === 'meta' || line.kind === 'hunk') {
      rows.push({ type: line.kind, parsedIndex: i, raw: line.raw, filePath: line.filePath })
      i += 1
      continue
    }

    if (line.kind === 'context') {
      const text = line.raw.startsWith(' ') ? line.raw.slice(1) : line.raw
      rows.push({
        type: 'pair',
        left: { parsedIndex: i, lineNum: line.oldLine, text, kind: 'context', filePath: line.filePath },
        right: { parsedIndex: i, lineNum: line.newLine, text, kind: 'context', filePath: line.filePath },
      })
      i += 1
      continue
    }

    // Collect a contiguous block of `del` followed by `add` lines within the same file.
    const dels: Array<{ idx: number; line: ParsedDiffLine }> = []
    const adds: Array<{ idx: number; line: ParsedDiffLine }> = []
    const blockFile = line.filePath

    while (i < lines.length && lines[i]!.kind === 'del' && lines[i]!.filePath === blockFile) {
      dels.push({ idx: i, line: lines[i]! })
      i += 1
    }
    while (i < lines.length && lines[i]!.kind === 'add' && lines[i]!.filePath === blockFile) {
      adds.push({ idx: i, line: lines[i]! })
      i += 1
    }

    const pairCount = Math.max(dels.length, adds.length)
    for (let k = 0; k < pairCount; k += 1) {
      const d = dels[k]
      const a = adds[k]
      rows.push({
        type: 'pair',
        left: d
          ? {
              parsedIndex: d.idx,
              lineNum: d.line.oldLine,
              text: d.line.raw.startsWith('-') ? d.line.raw.slice(1) : d.line.raw,
              kind: 'del',
              filePath: d.line.filePath,
            }
          : null,
        right: a
          ? {
              parsedIndex: a.idx,
              lineNum: a.line.newLine,
              text: a.line.raw.startsWith('+') ? a.line.raw.slice(1) : a.line.raw,
              kind: 'add',
              filePath: a.line.filePath,
            }
          : null,
      })
    }
  }

  return rows
}
