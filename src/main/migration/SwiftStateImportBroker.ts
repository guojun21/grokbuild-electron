import { randomUUID } from 'node:crypto'
import type {
  SwiftImportPreview,
  SwiftImportSourceCounts
} from '../../shared/swiftImport'
import type { PersistedState } from '../persistence/AppStateStore'
import {
  SwiftStateMigrationService,
  type SwiftStateMigrationData,
  type SwiftStateMigrationSummary
} from './SwiftStateMigrationService'
import {
  mergeSwiftState,
  type SwiftStateMergeResult
} from './mergeSwiftState'

const DEFAULT_PREVIEW_TTL_MS = 5 * 60_000
const MAX_PENDING_PREVIEWS = 4

interface PendingPreview {
  data: SwiftStateMigrationData
  expiresAt: number
}

/**
 * Keeps decoded Swift data in main memory behind short-lived opaque tokens.
 * Renderer receives counts only, never plist paths or imported transcript text.
 */
export class SwiftStateImportBroker {
  private readonly pending = new Map<string, PendingPreview>()

  constructor(
    private readonly migration = new SwiftStateMigrationService(),
    private readonly now: () => number = Date.now,
    private readonly createToken: () => string = randomUUID,
    private readonly ttlMs = DEFAULT_PREVIEW_TTL_MS
  ) {}

  async preview(plistPath: string, current: PersistedState): Promise<SwiftImportPreview> {
    this.purgeExpired()
    const imported = await this.migration.importFromPlist(plistPath)
    if (!imported.ok) return {
      ok: false,
      error: imported.error,
      source: publicSourceCounts(imported.summary)
    }

    while (this.pending.size >= MAX_PENDING_PREVIEWS) {
      const oldest = this.pending.keys().next().value as string | undefined
      if (!oldest) break
      this.pending.delete(oldest)
    }
    const token = this.createToken()
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(token)) {
      throw new Error('Could not create an import preview token')
    }
    const merge = mergeSwiftState(current, imported.data)
    this.pending.set(token, {
      data: structuredClone(imported.data),
      expiresAt: this.now() + this.ttlMs
    })
    return {
      ok: true,
      token,
      source: publicSourceCounts(imported.summary),
      merge: merge.summary
    }
  }

  consume(token: string, current: PersistedState): SwiftStateMergeResult {
    this.purgeExpired()
    const preview = this.pending.get(token)
    if (!preview) throw new Error('The Swift import preview expired; preview it again')
    this.pending.delete(token)
    return mergeSwiftState(current, preview.data)
  }

  cancel(token: string): void {
    this.pending.delete(token)
  }

  clear(): void {
    this.pending.clear()
  }

  private purgeExpired(): void {
    const now = this.now()
    for (const [token, preview] of this.pending) {
      if (preview.expiresAt <= now) this.pending.delete(token)
    }
  }
}

function publicSourceCounts(summary: SwiftStateMigrationSummary): SwiftImportSourceCounts {
  return {
    projectsImported: summary.projectsImported,
    projectsSkipped: summary.projectsSkipped,
    sessionsImported: summary.sessionsImported,
    sessionsSkipped: summary.sessionsSkipped,
    transcriptItemsImported: summary.transcriptItemsImported,
    transcriptItemsSkipped: summary.transcriptItemsSkipped,
    unavailableSections: summary.unavailableSections.length
  }
}
