import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SafeMarkdown } from '../../src/renderer/src/components/SafeMarkdown'

describe('SafeMarkdown', () => {
  it('renders GFM structure while refusing raw HTML and active links or images', () => {
    const html = renderToStaticMarkup(
      createElement(SafeMarkdown, { source: [
        '| Name | State |',
        '| --- | --- |',
        '| QA | green |',
        '',
        '`inline` and [docs](https://example.com/private?q=1)',
        '',
        '![private](https://example.com/private.png)',
        '',
        '<script>globalThis.compromised = true</script>'
      ].join('\n') })
    )

    expect(html).toContain('<table>')
    expect(html).toContain('<code>inline</code>')
    expect(html).toContain('class="markdown-link"')
    expect(html).not.toContain('<a ')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('<script')
    expect(html).not.toContain('globalThis.compromised')
    expect(html).toContain('[image: private]')
  })
})
