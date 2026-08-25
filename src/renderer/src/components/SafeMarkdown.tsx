import React from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

export function SafeMarkdown({ source }: { source: string }): React.JSX.Element {
  return (
    <div className="safe-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
          a: ({ href, children }) => (
            <span className="markdown-link" title={safeLinkTitle(href)}>{children}</span>
          ),
          img: ({ alt }) => (
            <span className="markdown-media-placeholder">[image{alt ? `: ${alt}` : ''}]</span>
          )
        }}
      >
        {source}
      </ReactMarkdown>
    </div>
  )
}

function safeLinkTitle(value: string | undefined): string | undefined {
  if (!value) return undefined
  try {
    const url = new URL(value)
    return ['https:', 'http:', 'mailto:'].includes(url.protocol) ? url.toString() : undefined
  } catch {
    return undefined
  }
}
