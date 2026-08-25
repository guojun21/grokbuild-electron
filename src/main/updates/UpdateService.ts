import { z } from 'zod'

const MAX_RELEASE_RESPONSE_BYTES = 2 * 1024 * 1024
const MAX_RELEASES = 30
const MAX_ASSETS = 64

const httpsUrl = z.string().url().max(4_096).refine((value) => new URL(value).protocol === 'https:')
const assetSchema = z.object({
  name: z.string().min(1).max(512),
  browser_download_url: httpsUrl,
  size: z.number().int().nonnegative().max(2 * 1024 * 1024 * 1024).optional(),
  digest: z.string().regex(/^sha256:[0-9a-f]{64}$/i).nullable().optional()
}).passthrough()
const releaseSchema = z.object({
  tag_name: z.string().min(1).max(128),
  name: z.string().max(512).nullable().optional(),
  body: z.string().max(512 * 1024).nullable().optional(),
  html_url: httpsUrl,
  published_at: z.string().datetime({ offset: true }).nullable().optional(),
  draft: z.boolean().default(false),
  prerelease: z.boolean().default(false),
  assets: z.array(assetSchema).max(MAX_ASSETS)
}).passthrough()
const releaseListSchema = z.array(releaseSchema).max(MAX_RELEASES)

const cliUpdateSchema = z.object({
  currentVersion: z.string().min(1).max(128),
  latestVersion: z.string().min(1).max(128),
  updateAvailable: z.boolean().default(false),
  channel: z.string().max(128).nullable().optional(),
  installer: z.string().max(256).nullable().optional(),
  error: z.string().max(8_192).nullable().optional()
}).passthrough()

export interface AppUpdateRelease {
  installedVersion: string
  latestVersion: string
  tagName: string
  releaseUrl: string
  assetName?: string | undefined
  downloadUrl?: string | undefined
  assetDigest?: string | undefined
  assetSize?: number | undefined
  publishedAt?: string | undefined
  updateAvailable: boolean
  notarizationClaimed: boolean
}

export type GrokCliUpdateStatus =
  | { state: 'up-to-date'; current: string; latest: string; channel?: string }
  | { state: 'update-available'; current: string; latest: string; channel?: string }
  | { state: 'failed'; message: string }

export interface AppUpdateCheckOptions {
  installedVersion: string
  releasesUrl: string
  /** Exact product stem. Prevents this Electron app from selecting the Swift app's asset. */
  productAssetStem: string
  fetchImpl?: typeof fetch | undefined
  timeoutMs?: number | undefined
}

export async function checkAppUpdate(options: AppUpdateCheckOptions): Promise<AppUpdateRelease> {
  const url = new URL(options.releasesUrl)
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('Update feed must be an authenticated-free HTTPS URL')
  }
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(options.productAssetStem)) {
    throw new Error('Update product asset stem is invalid')
  }
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 12_000)
  try {
    const response = await (options.fetchImpl ?? fetch)(url, {
      signal: controller.signal,
      headers: { accept: 'application/vnd.github+json' },
      redirect: 'error'
    })
    if (!response.ok) throw new Error(`Update feed returned HTTP ${response.status}`)
    const declaredLength = Number(response.headers.get('content-length'))
    if (Number.isFinite(declaredLength) && declaredLength > MAX_RELEASE_RESPONSE_BYTES) {
      throw new Error('Update feed response is too large')
    }
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength > MAX_RELEASE_RESPONSE_BYTES) throw new Error('Update feed response is too large')
    const releases = releaseListSchema.parse(JSON.parse(new TextDecoder().decode(bytes)))
    const release = releases
      .filter((candidate) =>
        !candidate.draft && !candidate.prerelease &&
        exactReleaseVersion(candidate.tag_name) !== undefined &&
        isNotarizationClaimed(candidate.name, candidate.body)
      )
      .reduce<(typeof releases)[number] | undefined>((latest, candidate) =>
        !latest || compareVersions(candidate.tag_name, latest.tag_name) > 0 ? candidate : latest
      , undefined)
    if (!release) throw new Error('No stable release claiming notarization was found')
    const expected = `${options.productAssetStem}-${release.tag_name}.app.zip`
    // Discovery never guesses across versions. Installation will eventually require
    // this exact asset plus digest, code-signature, Team ID, Gatekeeper and stapler checks.
    const asset = release.assets.find((candidate) => candidate.name === expected)
    const latestVersion = exactReleaseVersion(release.tag_name)
    if (!latestVersion) throw new Error('Stable release version is invalid')
    return {
      installedVersion: normalizeVersion(options.installedVersion),
      latestVersion,
      tagName: release.tag_name,
      releaseUrl: release.html_url,
      ...(asset
        ? {
            assetName: asset.name,
            downloadUrl: asset.browser_download_url,
            ...(asset.digest ? { assetDigest: asset.digest } : {}),
            ...(asset.size !== undefined ? { assetSize: asset.size } : {})
          }
        : {}),
      ...(release.published_at ? { publishedAt: release.published_at } : {}),
      updateAvailable: compareVersions(latestVersion, options.installedVersion) > 0,
      notarizationClaimed: true
    }
  } finally {
    clearTimeout(timeout)
  }
}

export function parseGrokCliUpdateCheck(stdout: string): GrokCliUpdateStatus {
  try {
    const raw: unknown = JSON.parse(stdout)
    const parsed = cliUpdateSchema.parse(raw)
    if (parsed.error?.trim()) return { state: 'failed', message: 'The Grok CLI update check reported a failure.' }
    const common = {
      current: parsed.currentVersion.trim(),
      latest: parsed.latestVersion.trim(),
      ...(parsed.channel?.trim() ? { channel: parsed.channel.trim() } : {})
    }
    return parsed.updateAvailable
      ? { state: 'update-available', ...common }
      : { state: 'up-to-date', ...common }
  } catch {
    return { state: 'failed', message: 'Could not parse Grok CLI update status.' }
  }
}

export function isNotarizationClaimed(name?: string | null, body?: string | null): boolean {
  return Boolean(
    name?.includes('(Notarized)') ||
    body?.toLowerCase().includes('properly code-signed and notarized')
  )
}

export function normalizeVersion(value: string): string {
  return value.trim().replace(/^[vV]/, '')
}

export function compareVersions(left: string, right: string): number {
  const a = versionComponents(left)
  const b = versionComponents(right)
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0)
    if (difference !== 0) return difference < 0 ? -1 : 1
  }
  return 0
}

function versionComponents(value: string): number[] {
  return normalizeVersion(value).split('.').map((component) => {
    const numeric = /^\d+/.exec(component)?.[0]
    return numeric ? Number(numeric) : 0
  })
}

function exactReleaseVersion(value: string): string | undefined {
  const match = /^[vV]?(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/.exec(value)
  return match?.[1] && match[2] && match[3]
    ? `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}`
    : undefined
}
