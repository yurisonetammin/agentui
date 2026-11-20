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

  function handleCopy() {
    const raw = extractText(children).replace(/\n$/, '')
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
      <pre {...props}>{children}</pre>
    </div>
  )
}

const markdownComponents: Components = {
  pre: ({ node: _node, ...props }) => <CodePre {...props} />,
  a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer noopener" />,
}

export function MarkdownView({ content }: { content: string }) {
  return (
    <div className="markdown-body">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
        {content}
      </ReactMarkdown>
    </div>
  )
}
