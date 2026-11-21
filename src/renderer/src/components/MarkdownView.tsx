import { isValidElement, useState, type ComponentPropsWithoutRef, type ReactNode } from 'react'
import { Check, Copy } from 'lucide-react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'

function extractText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(extractText).join('')
  if (isValidElement<{ children?: ReactNode }>(node)) return extractText(node.props.children)
  return ''
}

function CodePre({ children, ...props }: ComponentPropsWithoutRef<'pre'>) {
  const [copied, setCopied] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const raw = extractText(children).replace(/\n$/, '')
  const lines = raw.split('\n').length
  const foldable = lines > 12

  function handleCopy() {
    if (!raw || !navigator.clipboard?.writeText) return
    void navigator.clipboard
      .writeText(raw)
      .then(() => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1600)
      })
      .catch(() => undefined)
  }

  return (
    <div className="code-block-wrap">
      <button type="button" className="code-copy-btn" onClick={handleCopy} title="复制代码">
        {copied ? <Check size={11} /> : <Copy size={11} />}
        <span>{copied ? '已复制' : '复制'}</span>
      </button>
      <pre {...props} className={foldable && !expanded ? 'code-preview' : undefined}>{children}</pre>
      {foldable && <button type="button" className="output-toggle" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
        {expanded ? '收起代码' : `展开全部 ${lines.toLocaleString()} 行`}
      </button>}
    </div>
  )
}

const markdownComponents: Components = {
  pre: ({ node: _node, ...props }) => <CodePre {...props} />,
  a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer noopener" />,
}

export function MarkdownView({ content, streaming = false }: { content: string; streaming?: boolean }) {
  return (
    <div className={`markdown-body${streaming ? ' is-streaming' : ''}`} aria-busy={streaming || undefined}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
        {content}
      </ReactMarkdown>
    </div>
  )
}
