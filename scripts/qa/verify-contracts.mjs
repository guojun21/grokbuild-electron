import { readFile, readdir } from 'node:fs/promises'
import { extname, join, relative, resolve } from 'node:path'
import {
  parseParityMatrix,
  validateEvidenceManifest,
  validateIntentionalDifferenceLinks,
  validateKnownDifferences
} from './lib/parity-contracts.mjs'

const root = resolve(import.meta.dirname, '../..')
const scenariosRoot = resolve(root, 'qa/scenarios')
const requiredReference = JSON.parse(await readFile(resolve(root, 'reference/upstream.json'), 'utf8'))
const matrixEntries = parseParityMatrix(
  await readFile(resolve(root, 'docs/PARITY_MATRIX.md'), 'utf8')
)
const evidenceManifest = JSON.parse(
  await readFile(resolve(root, 'qa/contracts/parity-evidence.json'), 'utf8')
)
const knownDifferences = JSON.parse(
  await readFile(resolve(root, 'qa/contracts/known-differences.json'), 'utf8')
)
const scenarioFiles = await jsonFiles(scenariosRoot)
const ids = new Set()
const errors = []

errors.push(...await validateEvidenceManifest({
  matrixEntries,
  manifest: evidenceManifest,
  root
}))
errors.push(...validateKnownDifferences(knownDifferences, matrixEntries))
errors.push(...validateIntentionalDifferenceLinks(evidenceManifest, knownDifferences))

for (const file of scenarioFiles) {
  const scenario = JSON.parse(await readFile(file, 'utf8'))
  if (!/^[a-z0-9][a-z0-9-]+$/.test(scenario.id ?? '')) errors.push(`${show(file)}: invalid id`)
  if (ids.has(scenario.id)) errors.push(`${show(file)}: duplicate id ${scenario.id}`)
  ids.add(scenario.id)
  if (!['P0', 'P1', 'P2'].includes(scenario.priority)) errors.push(`${show(file)}: invalid priority`)
  if (scenario.reference?.swiftCommit !== requiredReference.commit) errors.push(`${show(file)}: Swift reference is not pinned to ${requiredReference.commit}`)
  if (!Array.isArray(scenario.steps) || scenario.steps.length === 0) errors.push(`${show(file)}: no deterministic steps`)
  if (!scenario.assert || Object.keys(scenario.assert).length === 0) errors.push(`${show(file)}: no assertions`)
  for (const artifact of ['state', 'rpc', 'filesystem', 'accessibility']) {
    if (scenario.assert?.[artifact]) await requireFile(file, scenario.assert[artifact])
  }
  for (const screenshot of scenario.assert?.screenshots ?? []) {
    await requireFile(file, screenshot)
  }
}

const ndjsonFiles = (await allFiles(resolve(root, 'qa/fixtures'))).filter((file) => extname(file) === '.ndjson')
for (const file of ndjsonFiles) {
  const lines = (await readFile(file, 'utf8')).split('\n').filter(Boolean)
  if (lines.length === 0) errors.push(`${show(file)}: empty NDJSON fixture`)
  for (const [index, line] of lines.entries()) {
    try {
      const frame = JSON.parse(line)
      if (frame.jsonrpc !== '2.0') errors.push(`${show(file)}:${index + 1}: missing jsonrpc 2.0`)
    } catch (error) {
      errors.push(`${show(file)}:${index + 1}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

if (errors.length > 0) {
  console.error(errors.join('\n'))
  process.exit(1)
}
console.log(
  `Parity contracts passed: ${matrixEntries.length} matrix row(s), ` +
  `${evidenceManifest.entries.length} evidence record(s), ${scenarioFiles.length} scenario(s), ` +
  `${ndjsonFiles.length} NDJSON fixture(s), ${knownDifferences.length} known difference(s).`
)

async function requireFile(scenarioFile, path) {
  try {
    await readFile(resolve(root, path))
  } catch {
    errors.push(`${show(scenarioFile)}: referenced artifact is missing: ${path}`)
  }
}

async function jsonFiles(directory) {
  return (await allFiles(directory)).filter((file) => extname(file) === '.json')
}

async function allFiles(directory) {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await allFiles(path))
    else files.push(path)
  }
  return files
}

function show(path) {
  return relative(root, path)
}
