import { stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'

export const PARITY_STATUSES = Object.freeze([
  'verified',
  'partial',
  'missing',
  'external-blocked',
  'intentional-difference'
])

export const PARITY_PRIORITIES = Object.freeze(['P0', 'P1', 'P2'])
export const KNOWN_DIFFERENCE_APPROVALS = Object.freeze(['pending', 'approved'])

const manifestKeys = Object.freeze(['schemaVersion', 'matrix', 'entries'])
const entryKeys = Object.freeze([
  'id',
  'priority',
  'status',
  'implementationPaths',
  'testPaths',
  'artifactPaths',
  'gap'
])
const differenceKeys = new Set([
  'id',
  'scenario',
  'surface',
  'selector',
  'priority',
  'expectedSwift',
  'actualElectron',
  'reason',
  'owner',
  'issue',
  'introducedAt',
  'expiresOn',
  'approvalStatus',
  'approvedBy'
])
const requiredDifferenceKeys = Object.freeze([
  'id',
  'scenario',
  'surface',
  'selector',
  'priority',
  'expectedSwift',
  'actualElectron',
  'reason',
  'owner',
  'issue',
  'introducedAt',
  'expiresOn',
  'approvalStatus'
])
const surfaces = new Set([
  'state',
  'rpc',
  'filesystem',
  'accessibility',
  'visual',
  'packaging',
  'platform'
])

export function parseParityMatrix(markdown) {
  const entries = []
  const ids = new Set()
  for (const line of markdown.split('\n')) {
    if (!/^\|\s*PAR-[0-9]{3}\s*\|/.test(line)) continue
    const cells = line.slice(1, line.endsWith('|') ? -1 : undefined)
      .split('|')
      .map((cell) => cell.trim())
    const id = cells[0]
    const priority = cells.at(-1)?.match(/\bP[0-2]\b/)?.[0]
    if (!id || !priority) throw new Error(`Could not parse parity matrix row: ${line}`)
    if (ids.has(id)) throw new Error(`Parity matrix has duplicate ID ${id}`)
    ids.add(id)
    entries.push({ id, priority })
  }
  if (entries.length === 0) throw new Error('Parity matrix has no PAR entries')
  return entries
}

export async function validateEvidenceManifest({
  matrixEntries,
  manifest,
  root,
  expectedMatrixPath = 'docs/PARITY_MATRIX.md'
}) {
  const errors = []
  if (!isRecord(manifest)) return ['parity-evidence.json must be an object']
  strictKeys(manifest, manifestKeys, 'parity-evidence.json', errors)
  if (manifest.schemaVersion !== 1) errors.push('parity-evidence.json must use schemaVersion 1')
  if (manifest.matrix !== expectedMatrixPath) {
    errors.push(`parity-evidence.json matrix must be ${expectedMatrixPath}`)
  }
  if (!Array.isArray(manifest.entries)) {
    errors.push('parity-evidence.json entries must be an array')
    return errors
  }

  const matrixById = new Map(matrixEntries.map((entry) => [entry.id, entry]))
  const entriesById = new Map()
  for (const [index, entry] of manifest.entries.entries()) {
    const label = `parity-evidence.json entries[${index}]`
    if (!isRecord(entry)) {
      errors.push(`${label} must be an object`)
      continue
    }
    strictKeys(entry, entryKeys, label, errors)
    const id = typeof entry.id === 'string' ? entry.id : ''
    if (!/^PAR-[0-9]{3}$/.test(id)) errors.push(`${label} has invalid id ${id || '(missing)'}`)
    if (entriesById.has(id)) errors.push(`${label} duplicates id ${id}`)
    if (id) entriesById.set(id, entry)
    if (!PARITY_PRIORITIES.includes(entry.priority)) {
      errors.push(`${label} has invalid priority ${String(entry.priority)}`)
    }
    if (!PARITY_STATUSES.includes(entry.status)) {
      errors.push(`${label} has invalid status ${String(entry.status)}`)
    }
    if (typeof entry.gap !== 'string' || entry.gap.trim().length === 0 || entry.gap.length > 500) {
      errors.push(`${label} gap must be 1-500 characters`)
    }
    for (const key of ['implementationPaths', 'testPaths', 'artifactPaths']) {
      await validateEvidencePaths(entry[key], `${label}.${key}`, root, errors)
    }
    if (
      entry.status === 'verified' &&
      arrayLength(entry.testPaths) + arrayLength(entry.artifactPaths) === 0
    ) {
      errors.push(`${label} is verified but has no test or artifact evidence`)
    }
  }

  for (const matrixEntry of matrixEntries) {
    const evidence = entriesById.get(matrixEntry.id)
    if (!evidence) {
      errors.push(`parity-evidence.json is missing ${matrixEntry.id}`)
    } else if (evidence.priority !== matrixEntry.priority) {
      errors.push(
        `parity-evidence.json ${matrixEntry.id} priority ${String(evidence.priority)} ` +
        `does not match matrix ${matrixEntry.priority}`
      )
    }
  }
  for (const id of entriesById.keys()) {
    if (!matrixById.has(id)) errors.push(`parity-evidence.json has extra entry ${id}`)
  }
  return errors
}

export function validateKnownDifferences(value, matrixEntries, now = new Date()) {
  const errors = []
  if (!Array.isArray(value)) return ['known-differences.json must be an array']
  const ids = new Set()
  const matrixById = new Map(matrixEntries.map((entry) => [entry.id, entry]))
  for (const [index, difference] of value.entries()) {
    const label = `known-differences.json[${index}]`
    if (!isRecord(difference)) {
      errors.push(`${label} must be an object`)
      continue
    }
    for (const key of Object.keys(difference)) {
      if (!differenceKeys.has(key)) errors.push(`${label} has unknown key ${key}`)
    }
    for (const key of requiredDifferenceKeys) {
      if (typeof difference[key] !== 'string' || difference[key].trim().length === 0) {
        errors.push(`${label} is missing ${key}`)
      }
    }
    if (!/^KD-[0-9]{4}$/.test(difference.id ?? '')) {
      errors.push(`${label} has invalid id ${String(difference.id)}`)
    } else if (ids.has(difference.id)) {
      errors.push(`${label} duplicates id ${difference.id}`)
    } else {
      ids.add(difference.id)
    }
    const parityId = typeof difference.scenario === 'string'
      ? difference.scenario.match(/^PAR-[0-9]{3}/)?.[0]
      : undefined
    if (!parityId || !/^PAR-[0-9]{3}(?:\/[a-z0-9][a-z0-9-]*)?$/.test(difference.scenario)) {
      errors.push(`${label} has invalid scenario ${String(difference.scenario)}`)
    } else if (!matrixById.has(parityId)) {
      errors.push(`${label} references unknown parity ID ${parityId}`)
    } else if (difference.priority !== matrixById.get(parityId)?.priority) {
      errors.push(`${label} priority does not match ${parityId}`)
    }
    if (!surfaces.has(difference.surface)) {
      errors.push(`${label} has invalid surface ${String(difference.surface)}`)
    }
    if (!PARITY_PRIORITIES.includes(difference.priority)) {
      errors.push(`${label} has invalid priority ${String(difference.priority)}`)
    }
    if (typeof difference.selector === 'string' && /[*?]/.test(difference.selector)) {
      errors.push(`${label} selector must not contain wildcards`)
    }
    if (!KNOWN_DIFFERENCE_APPROVALS.includes(difference.approvalStatus)) {
      errors.push(`${label} has invalid approvalStatus ${String(difference.approvalStatus)}`)
    } else if (difference.approvalStatus === 'approved') {
      if (typeof difference.approvedBy !== 'string' || difference.approvedBy.trim().length === 0) {
        errors.push(`${label} is approved but is missing approvedBy`)
      }
    } else if (difference.approvedBy !== undefined) {
      errors.push(`${label} is pending and must not set approvedBy`)
    }
    const introducedAt = parseDateOnly(difference.introducedAt)
    const expiresOn = parseDateOnly(difference.expiresOn)
    if (!introducedAt) errors.push(`${label} has invalid introducedAt ${String(difference.introducedAt)}`)
    if (!expiresOn) {
      errors.push(`${label} has invalid expiresOn ${String(difference.expiresOn)}`)
    } else if (expiresOn.getTime() < startOfUtcDay(now).getTime()) {
      errors.push(`${label} expired on ${difference.expiresOn}`)
    }
    if (introducedAt && expiresOn && expiresOn < introducedAt) {
      errors.push(`${label} expires before it was introduced`)
    }
  }
  return errors
}

export function validateIntentionalDifferenceLinks(manifest, knownDifferences) {
  if (!isRecord(manifest) || !Array.isArray(manifest.entries) || !Array.isArray(knownDifferences)) {
    return []
  }
  const errors = []
  for (const entry of manifest.entries) {
    if (!isRecord(entry) || entry.status !== 'intentional-difference') continue
    if (!knownDifferences.some((difference) => differenceParityId(difference) === entry.id)) {
      errors.push(`parity-evidence.json ${String(entry.id)} is intentional-difference without a registry record`)
    }
  }
  return errors
}

export function evaluateReleaseReadiness(matrixEntries, manifest, knownDifferences) {
  const priorities = new Map(matrixEntries.map((entry) => [entry.id, entry.priority]))
  const differences = Array.isArray(knownDifferences) ? knownDifferences : []
  const blockers = []
  for (const entry of isRecord(manifest) && Array.isArray(manifest.entries) ? manifest.entries : []) {
    if (!isRecord(entry) || !['P0', 'P1'].includes(entry.priority)) continue
    if (['partial', 'missing', 'external-blocked'].includes(entry.status)) {
      blockers.push({ id: String(entry.id), status: String(entry.status) })
      continue
    }
    if (entry.status === 'intentional-difference') {
      const related = differences.filter((difference) => differenceParityId(difference) === entry.id)
      if (related.length === 0 || related.some((difference) => difference.approvalStatus !== 'approved')) {
        blockers.push({ id: String(entry.id), status: 'intentional-difference-unapproved' })
      }
    }
  }
  for (const difference of differences) {
    const parityId = differenceParityId(difference)
    const priority = parityId ? priorities.get(parityId) : undefined
    if (
      ['P0', 'P1'].includes(priority) &&
      isRecord(difference) &&
      difference.approvalStatus === 'pending'
    ) {
      blockers.push({ id: String(difference.id), status: 'pending' })
    }
  }
  blockers.sort((left, right) => left.id.localeCompare(right.id) || left.status.localeCompare(right.status))
  return { releaseReady: blockers.length === 0, blockers }
}

export function countParityStatuses(entries) {
  return Object.fromEntries(PARITY_STATUSES.map((status) => [
    status,
    entries.filter((entry) => entry.status === status).length
  ]))
}

function differenceParityId(difference) {
  return isRecord(difference) && typeof difference.scenario === 'string'
    ? difference.scenario.match(/^PAR-[0-9]{3}/)?.[0]
    : undefined
}

async function validateEvidencePaths(value, label, root, errors) {
  if (!Array.isArray(value)) {
    errors.push(`${label} must be an array`)
    return
  }
  const paths = new Set()
  for (const [index, path] of value.entries()) {
    if (typeof path !== 'string' || path.length === 0) {
      errors.push(`${label}[${index}] must be a non-empty string`)
      continue
    }
    if (paths.has(path)) errors.push(`${label} duplicates ${path}`)
    paths.add(path)
    if (isAbsolute(path) || path.includes('\\')) {
      errors.push(`${label}[${index}] must be a repository-relative POSIX path`)
      continue
    }
    const absolute = resolve(root, path)
    const relativePath = relative(root, absolute)
    if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
      errors.push(`${label}[${index}] escapes the repository root`)
      continue
    }
    try {
      const metadata = await stat(absolute)
      if (!metadata.isFile()) errors.push(`${label}[${index}] is not a file: ${path}`)
    } catch {
      errors.push(`${label}[${index}] does not exist: ${path}`)
    }
  }
}

function strictKeys(value, expected, label, errors) {
  const expectedSet = new Set(expected)
  for (const key of expected) {
    if (!(key in value)) errors.push(`${label} is missing ${key}`)
  }
  for (const key of Object.keys(value)) {
    if (!expectedSet.has(key)) errors.push(`${label} has unknown key ${key}`)
  }
}

function arrayLength(value) {
  return Array.isArray(value) ? value.length : 0
}

function parseDateOnly(value) {
  if (typeof value !== 'string' || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value)) return undefined
  const date = new Date(`${value}T00:00:00.000Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().startsWith(value) ? date : undefined
}

function startOfUtcDay(value) {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()))
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
