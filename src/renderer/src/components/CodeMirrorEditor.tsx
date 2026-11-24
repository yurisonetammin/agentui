import { useEffect, useRef } from 'react'
import { basicSetup, EditorView } from 'codemirror'
import { Compartment, EditorState, type Extension } from '@codemirror/state'
import { keymap } from '@codemirror/view'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags } from '@lezer/highlight'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { css } from '@codemirror/lang-css'
import { html } from '@codemirror/lang-html'
import { python } from '@codemirror/lang-python'

export interface CodeSelectionRange {
  startLine: number
  endLine: number
}

const agentUiTheme = EditorView.theme({
  '&': {
    height: '100%',
    backgroundColor: 'var(--bg-root)',
    color: 'var(--text-primary)',
    fontSize: 'var(--code-font-size, 12px)',
    fontFamily: 'var(--mono)',
  },
  '.cm-scroller': {
    overflow: 'auto',
    fontFamily: 'var(--mono)',
    lineHeight: '1.55',
  },
  '.cm-content': {
    padding: '8px 0',
    caretColor: 'var(--accent)',
  },
  '.cm-cursor, .cm-dropCursor': {
    borderLeftColor: 'var(--accent)',
  },
  '.cm-gutters': {
    backgroundColor: 'var(--bg-panel)',
    color: 'var(--text-muted)',
    borderRight: '1px solid var(--border)',
    userSelect: 'none',
  },
  '.cm-activeLine': {
    backgroundColor: 'rgba(127, 127, 127, 0.08)',
  },
  '.cm-activeLineGutter': {
    backgroundColor: 'rgba(127, 127, 127, 0.12)',
    color: 'var(--text-primary)',
  },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'rgba(59, 130, 246, 0.28)',
  },
  '.cm-panels': {
    backgroundColor: 'var(--bg-elevated)',
    color: 'var(--text-primary)',
    borderColor: 'var(--border)',
  },
  '.cm-tooltip': {
    backgroundColor: 'var(--bg-elevated)',
    border: '1px solid var(--border)',
    color: 'var(--text-primary)',
  },
  '&.cm-focused': {
    outline: 'none',
  },
})

const agentUiHighlight = HighlightStyle.define([
  { tag: [tags.keyword, tags.operatorKeyword, tags.modifier], color: 'var(--cm-keyword, #c084fc)' },
  { tag: [tags.string, tags.special(tags.string)], color: 'var(--cm-string, #34d399)' },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], color: 'var(--cm-comment, #6b7280)', fontStyle: 'italic' },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], color: 'var(--cm-number, #f59e0b)' },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: 'var(--cm-fn, #60a5fa)' },
  { tag: [tags.typeName, tags.className, tags.namespace], color: 'var(--cm-type, #38bdf8)' },
  { tag: [tags.tagName, tags.attributeName], color: 'var(--cm-tag, #f472b6)' },
  { tag: [tags.propertyName], color: 'var(--cm-prop, #93c5fd)' },
])

function languageExtensionFor(filePath: string, language?: string): Extension[] {
  const lower = filePath.toLowerCase()
  if (lower.endsWith('.tsx')) return [javascript({ typescript: true, jsx: true })]
  if (lower.endsWith('.ts') || lower.endsWith('.mts') || lower.endsWith('.cts') || language === 'typescript') {
    return [javascript({ typescript: true })]
  }
  if (lower.endsWith('.jsx')) return [javascript({ jsx: true })]
  if (lower.endsWith('.js') || lower.endsWith('.mjs') || lower.endsWith('.cjs') || language === 'javascript') {
    return [javascript()]
  }
  if (lower.endsWith('.json') || lower.endsWith('.jsonc') || language === 'json') return [json()]
  if (lower.endsWith('.md') || lower.endsWith('.markdown') || language === 'markdown') return [markdown()]
  if (lower.endsWith('.css') || lower.endsWith('.scss') || lower.endsWith('.less') || language === 'css') return [css()]
  if (lower.endsWith('.html') || lower.endsWith('.htm') || lower.endsWith('.xml') || lower.endsWith('.svg') || lower.endsWith('.vue')) {
    return [html()]
  }
  if (lower.endsWith('.py') || language === 'python') return [python()]
  return []
}

export function CodeMirrorEditor({
  filePath,
  language,
  value,
  readOnly = false,
  onChange,
  onSave,
  onSelectionChange,
}: {
  filePath: string
  language?: string
  value: string
  readOnly?: boolean
  onChange: (next: string) => void
  onSave?: () => void
  onSelectionChange?: (range: CodeSelectionRange | null) => void
}) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<EditorView | null>(null)
  const readOnlyCompRef = useRef(new Compartment())
  const onChangeRef = useRef(onChange)
  const onSaveRef = useRef(onSave)
  const onSelectionRef = useRef(onSelectionChange)
  const lastExternalValueRef = useRef(value)

  onChangeRef.current = onChange
  onSaveRef.current = onSave
  onSelectionRef.current = onSelectionChange

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const readOnlyComp = readOnlyCompRef.current
    const state = EditorState.create({
      doc: value,
      extensions: [
        basicSetup,
        agentUiTheme,
        syntaxHighlighting(agentUiHighlight, { fallback: true }),
        ...languageExtensionFor(filePath, language),
        readOnlyComp.of(EditorState.readOnly.of(readOnly)),
        keymap.of([
          {
            key: 'Mod-s',
            run: () => {
              onSaveRef.current?.()
              return true
            },
          },
        ]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            const nextDoc = update.state.doc.toString()
            lastExternalValueRef.current = nextDoc
            onChangeRef.current(nextDoc)
          }
          if (update.selectionSet || update.docChanged) {
            const sel = update.state.selection.main
            if (sel.empty) {
              onSelectionRef.current?.(null)
            } else {
              const startLine = update.state.doc.lineAt(sel.from).number
              const endPos = sel.to > sel.from ? sel.to - 1 : sel.to
              const endLine = update.state.doc.lineAt(endPos).number
              onSelectionRef.current?.({ startLine, endLine })
            }
          }
        }),
      ],
    })

    const view = new EditorView({ state, parent: host })
    viewRef.current = view
    lastExternalValueRef.current = value
    onSelectionRef.current?.(null)

    return () => {
      view.destroy()
      viewRef.current = null
    }
  }, [filePath, language])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({
      effects: readOnlyCompRef.current.reconfigure(EditorState.readOnly.of(readOnly)),
    })
  }, [readOnly])

  useEffect(() => {
    const view = viewRef.current
    if (!view || value === lastExternalValueRef.current) return
    const currentDoc = view.state.doc.toString()
    if (currentDoc === value) {
      lastExternalValueRef.current = value
      return
    }
    lastExternalValueRef.current = value
    view.dispatch({
      changes: { from: 0, to: currentDoc.length, insert: value },
    })
  }, [value])

  return <div ref={hostRef} className="cm-editor-host" />
}
