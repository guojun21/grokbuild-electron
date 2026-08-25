import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { MemorySettings } from '../../src/renderer/src/components/MemorySettings'
import {
  formatMemoryBytes,
  formatMemoryDate,
  groupMemorySummaries,
  memorySummaryDisplay,
  utf8ByteLength
} from '../../src/renderer/src/memoryPresentation'
import type { PublicMemoryFileSummary } from '../../src/shared/memory'
import { createPrivacyDisplayResolver } from '../../src/shared/privacy'

const TOKEN = 'A'.repeat(43)

function summary(
  scope: PublicMemoryFileSummary['scope'],
  overrides: Partial<PublicMemoryFileSummary> = {}
): PublicMemoryFileSummary {
  return {
    token: TOKEN,
    scope,
    title: `${scope} notes`,
    modifiedAt: '2026-08-25T09:30:00.000Z',
    byteLength: 1_536,
    canDelete: scope === 'session',
    ...overrides
  }
}

describe('Memory renderer projection', () => {
  it('omits capability tokens and filesystem identities from display metadata', () => {
    const absolutePath = '/Users/private/.grok/memory/secret-slug/MEMORY.md'
    const display = memorySummaryDisplay(summary('workspace', {
      workspaceLabel: 'Workspace 1'
    }))

    expect(display).toEqual({
      scope: 'workspace',
      scopeLabel: 'Workspace',
      title: 'workspace notes',
      workspaceLabel: 'Workspace 1',
      sizeLabel: '1.5 KB',
      dateLabel: 'Aug 25, 2026'
    })
    expect(Object.keys(display)).not.toContain('token')
    expect(JSON.stringify(display)).not.toContain(TOKEN)
    expect(JSON.stringify(display)).not.toContain(absolutePath)
  })

  it('groups compact rows in the stable global, workspace, session order', () => {
    const groups = groupMemorySummaries([
      summary('session', { token: 'C'.repeat(43) }),
      summary('global', { token: 'B'.repeat(43) }),
      summary('workspace')
    ])
    expect(groups.map((group) => [group.scope, group.label, group.entries.length])).toEqual([
      ['global', 'Global', 1],
      ['workspace', 'Workspaces', 1],
      ['session', 'Sessions', 1]
    ])
  })

  it('formats bounded size/date labels and measures UTF-8 note bytes', () => {
    expect(formatMemoryBytes(0)).toBe('0 B')
    expect(formatMemoryBytes(1_024)).toBe('1 KB')
    expect(formatMemoryBytes(2.5 * 1_024 * 1_024)).toBe('2.5 MB')
    expect(formatMemoryBytes(-1)).toBe('Size unavailable')
    expect(formatMemoryDate(undefined)).toBe('Date unavailable')
    expect(formatMemoryDate('not-a-date')).toBe('Date unavailable')
    expect(utf8ByteLength('记忆')).toBe(6)
  })

  it('renders only fixed Memory copy and no editor in Privacy Mode', () => {
    const html = renderToStaticMarkup(
      <MemorySettings
        active
        memoryEnabled
        privacy={createPrivacyDisplayResolver(true)}
        onApplySetting={async () => undefined}
        onList={async () => []}
        onRead={async () => {
          throw new Error('not called during server rendering')
        }}
        onRemember={async () => undefined}
        onDelete={async () => ({ state: 'cancelled' })}
      />
    )
    expect(html).toContain('Memory details hidden')
    expect(html).toContain('Apply &amp; Restart Sessions')
    expect(html).not.toContain('<textarea')
    expect(html).not.toContain('aria-label="Memory files"')
    expect(html).not.toContain(TOKEN)
  })
})
