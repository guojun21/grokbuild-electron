/// <reference lib="dom" />

import { describe, expect, it } from 'vitest'
import { shouldApplyModalInitialFocus } from '../../src/renderer/src/components/ModalSurface'

describe('ModalSurface initial focus arbitration', () => {
  it('replaces only the browser-selected opening focus', () => {
    expect(shouldApplyModalInitialFocus({
      hadUserInteraction: false,
      hasDialogFocus: true,
      focusChangedSinceOpen: false
    })).toBe(true)
    expect(shouldApplyModalInitialFocus({
      hadUserInteraction: false,
      hasDialogFocus: false,
      focusChangedSinceOpen: false
    })).toBe(true)
  })

  it('preserves focus established by a user or another dialog child', () => {
    expect(shouldApplyModalInitialFocus({
      hadUserInteraction: true,
      hasDialogFocus: true,
      focusChangedSinceOpen: false
    })).toBe(false)
    expect(shouldApplyModalInitialFocus({
      hadUserInteraction: false,
      hasDialogFocus: true,
      focusChangedSinceOpen: true
    })).toBe(false)
  })
})
