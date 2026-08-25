import { createHash } from 'node:crypto'

const DEFAULT_MAX_DIFFERENCES = 1_000
const DEFAULT_MAX_NODES = 250_000
const DEFAULT_MAX_DEPTH = 64

export function compareCanonicalJson(expected, actual, options = {}) {
  const ignoredPointers = normalizePointers(options.ignoredPointers ?? [])
  const maximumDifferences = bounded(options.maximumDifferences, DEFAULT_MAX_DIFFERENCES, 10_000)
  const maximumNodes = bounded(options.maximumNodes, DEFAULT_MAX_NODES, 1_000_000)
  const maximumDepth = bounded(options.maximumDepth, DEFAULT_MAX_DEPTH, 128)
  const differences = []
  let visitedNodes = 0
  let truncated = false

  const visit = (left, right, pointer, depth) => {
    if (isIgnored(pointer, ignoredPointers)) return
    visitedNodes += 1
    if (visitedNodes > maximumNodes) throw new Error('Canonical comparison exceeded its node budget')
    if (depth > maximumDepth) throw new Error('Canonical comparison exceeded its depth budget')
    if (differences.length >= maximumDifferences) {
      truncated = true
      return
    }
    if (Object.is(left, right)) return

    const leftKind = jsonKind(left)
    const rightKind = jsonKind(right)
    if (leftKind !== rightKind) {
      differences.push(difference(pointer, 'type', left, right))
      return
    }
    if (leftKind === 'array') {
      const leftArray = left
      const rightArray = right
      if (leftArray.length !== rightArray.length) {
        differences.push(difference(pointer, 'array-length', leftArray, rightArray))
        if (differences.length >= maximumDifferences) {
          truncated = true
          return
        }
      }
      const maximum = Math.max(leftArray.length, rightArray.length)
      for (let index = 0; index < maximum; index += 1) {
        const child = `${pointer}/${index}`
        if (index >= leftArray.length) differences.push(difference(child, 'added', undefined, rightArray[index]))
        else if (index >= rightArray.length) differences.push(difference(child, 'removed', leftArray[index], undefined))
        else visit(leftArray[index], rightArray[index], child, depth + 1)
        if (differences.length >= maximumDifferences) {
          truncated = index < maximum - 1
          return
        }
      }
      return
    }
    if (leftKind === 'object') {
      const leftObject = left
      const rightObject = right
      const keys = [...new Set([...Object.keys(leftObject), ...Object.keys(rightObject)])].sort()
      for (const key of keys) {
        const child = `${pointer}/${escapePointer(key)}`
        if (!Object.hasOwn(leftObject, key)) differences.push(difference(child, 'added', undefined, rightObject[key]))
        else if (!Object.hasOwn(rightObject, key)) differences.push(difference(child, 'removed', leftObject[key], undefined))
        else visit(leftObject[key], rightObject[key], child, depth + 1)
        if (differences.length >= maximumDifferences) {
          truncated = keys.at(-1) !== key
          return
        }
      }
      return
    }
    differences.push(difference(pointer, 'value', left, right))
  }

  visit(expected, actual, '', 0)
  return {
    equal: differences.length === 0,
    differences,
    ignoredPointers,
    visitedNodes,
    truncated
  }
}

export function approvedIgnorePointers(waivers, knownDifferences, today = new Date()) {
  if (!Array.isArray(waivers) || !Array.isArray(knownDifferences)) {
    throw new Error('Canonical comparison waivers must use the known-difference registry')
  }
  const byId = new Map(knownDifferences.map((entry) => [entry?.id, entry]))
  const pointers = []
  for (const waiver of waivers) {
    if (!waiver || typeof waiver !== 'object' || Array.isArray(waiver)) {
      throw new Error('Canonical comparison waiver is invalid')
    }
    const entry = byId.get(waiver.differenceId)
    if (!entry || entry.approvalStatus !== 'approved') {
      throw new Error(`Canonical comparison waiver ${String(waiver.differenceId)} is not approved`)
    }
    if (!validDate(entry.expiresOn) || new Date(`${entry.expiresOn}T23:59:59.999Z`) < today) {
      throw new Error(`Canonical comparison waiver ${String(waiver.differenceId)} is expired`)
    }
    pointers.push(validPointer(waiver.pointer))
  }
  return normalizePointers(pointers)
}

function difference(pointer, kind, expected, actual) {
  return {
    pointer: pointer || '/',
    kind,
    expected: summarize(expected),
    actual: summarize(actual)
  }
}

function summarize(value) {
  const kind = value === undefined ? 'missing' : jsonKind(value)
  const encoded = stableJson(value)
  return {
    kind,
    ...(kind === 'string' ? { length: value.length } : {}),
    ...(kind === 'array' ? { length: value.length } : {}),
    ...(kind === 'object' ? { keys: Object.keys(value).length } : {}),
    sha256: createHash('sha256').update(encoded).digest('hex')
  }
}

function stableJson(value) {
  if (value === undefined) return '<missing>'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${stableJson(value[key])}`
  ).join(',')}}`
}

function jsonKind(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value === 'object' ? 'object' : typeof value
}

function normalizePointers(values) {
  return [...new Set(values.map(validPointer))].sort()
}

function validPointer(value) {
  if (typeof value !== 'string' || (value !== '' && !value.startsWith('/'))) {
    throw new Error(`Invalid JSON pointer ${String(value)}`)
  }
  if (value.length > 4_096 || /~(?![01])/.test(value)) {
    throw new Error(`Invalid JSON pointer ${String(value)}`)
  }
  return value.length > 1 ? value.replace(/\/$/, '') : value
}

function isIgnored(pointer, ignoredPointers) {
  return ignoredPointers.some((ignored) =>
    ignored === '' || pointer === ignored || pointer.startsWith(`${ignored}/`)
  )
}

function escapePointer(value) {
  return value.replace(/~/g, '~0').replace(/\//g, '~1')
}

function bounded(value, fallback, maximum) {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error('Canonical comparison budget is invalid')
  }
  return value
}

function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(new Date(`${value}T00:00:00Z`).getTime())
}
