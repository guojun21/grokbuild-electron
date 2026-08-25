import { readFile, stat, writeFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import {
  approvedIgnorePointers,
  compareCanonicalJson
} from './lib/canonical-diff.mjs'

const MAX_INPUT_BYTES = 64 * 1024 * 1024

try {
  const args = parseArguments(process.argv.slice(2))
  const [expected, actual, knownDifferences] = await Promise.all([
    readBoundedJson(args.expected),
    readBoundedJson(args.actual),
    readBoundedJson(args.knownDifferences)
  ])
  const ignoredPointers = approvedIgnorePointers(args.waivers, knownDifferences)
  const report = {
    schemaVersion: 1,
    expected: basename(args.expected),
    actual: basename(args.actual),
    ...compareCanonicalJson(expected, actual, { ignoredPointers })
  }
  if (args.output) await writeFile(args.output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  process.stdout.write(
    report.equal
      ? `Canonical parity matched (${report.visitedNodes} nodes).\n`
      : `Canonical parity differs (${report.differences.length}${report.truncated ? '+' : ''} difference(s)).\n`
  )
  if (!report.equal) process.exitCode = 1
} catch (error) {
  process.stderr.write('Canonical comparison could not run.\n')
  process.exitCode = 2
}

function parseArguments(argv) {
  const result = {
    knownDifferences: resolve('qa/contracts/known-differences.json'),
    waivers: []
  }
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    const next = argv[++index]
    if (!next) throw new Error(`Missing value for ${value}`)
    if (value === '--expected') result.expected = resolve(next)
    else if (value === '--actual') result.actual = resolve(next)
    else if (value === '--output') result.output = resolve(next)
    else if (value === '--known-differences') result.knownDifferences = resolve(next)
    else if (value === '--waive') {
      const separator = next.indexOf(':')
      if (separator <= 0) throw new Error('Waivers use KD-0000:/json/pointer')
      result.waivers.push({
        differenceId: next.slice(0, separator),
        pointer: next.slice(separator + 1)
      })
    } else throw new Error(`Unknown argument ${value}`)
  }
  if (!result.expected || !result.actual) {
    throw new Error('Usage: --expected FILE --actual FILE [--output FILE] [--waive KD-0000:/pointer]')
  }
  return result
}

async function readBoundedJson(path) {
  const info = await stat(path)
  if (!info.isFile() || info.size > MAX_INPUT_BYTES) throw new Error('Canonical input is unavailable or too large')
  return JSON.parse(await readFile(path, 'utf8'))
}
