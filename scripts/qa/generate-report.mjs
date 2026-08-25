import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { extname, join, relative, resolve } from 'node:path'
import {
  countParityStatuses,
  evaluateReleaseReadiness,
  parseParityMatrix,
  validateEvidenceManifest,
  validateIntentionalDifferenceLinks,
  validateKnownDifferences
} from './lib/parity-contracts.mjs'

const root = resolve(import.meta.dirname, '../..')
const reportDirectory = resolve(root, 'qa/reports')
const reference = JSON.parse(await readFile(resolve(root, 'reference/upstream.json'), 'utf8'))
const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
const matrixEntries = parseParityMatrix(
  await readFile(resolve(root, 'docs/PARITY_MATRIX.md'), 'utf8')
)
const evidenceManifest = JSON.parse(
  await readFile(resolve(root, 'qa/contracts/parity-evidence.json'), 'utf8')
)
const knownDifferences = JSON.parse(
  await readFile(resolve(root, 'qa/contracts/known-differences.json'), 'utf8')
)
const contractErrors = [
  ...await validateEvidenceManifest({ matrixEntries, manifest: evidenceManifest, root }),
  ...validateKnownDifferences(knownDifferences, matrixEntries),
  ...validateIntentionalDifferenceLinks(evidenceManifest, knownDifferences)
]
if (contractErrors.length > 0) {
  throw new Error(`Cannot generate a parity report from invalid contracts:\n${contractErrors.join('\n')}`)
}

const scenarios = await loadScenarios(resolve(root, 'qa/scenarios'))
const fixtureFiles = (await allFiles(resolve(root, 'qa/fixtures')))
  .filter((path) => extname(path) === '.ndjson')
  .map(show)
const unitTests = (await allFiles(resolve(root, 'tests/unit')))
  .filter((path) => path.endsWith('.test.ts') || path.endsWith('.test.tsx'))
  .map(show)
const e2eTests = (await allFiles(resolve(root, 'tests/e2e')))
  .filter((path) => path.endsWith('.spec.ts'))
  .map(show)
const readiness = evaluateReleaseReadiness(matrixEntries, evidenceManifest, knownDifferences)
const statusCounts = countParityStatuses(evidenceManifest.entries)
const knownDifferenceCounts = {
  pending: knownDifferences.filter((difference) => difference.approvalStatus === 'pending').length,
  approved: knownDifferences.filter((difference) => difference.approvalStatus === 'approved').length
}
const report = {
  schemaVersion: 2,
  application: { name: packageJson.name, version: packageJson.version },
  reference: {
    repository: reference.repository,
    tag: reference.tag,
    commit: reference.commit,
    license: reference.license
  },
  source: {
    matrix: evidenceManifest.matrix,
    evidence: 'qa/contracts/parity-evidence.json',
    knownDifferences: 'qa/contracts/known-differences.json'
  },
  summary: {
    parityDomains: evidenceManifest.entries.length,
    statusCounts,
    releaseReady: readiness.releaseReady,
    releaseBlockers: readiness.blockers,
    deterministicScenarios: scenarios.length,
    ndjsonFixtures: fixtureFiles.length,
    unitTestFiles: unitTests.length,
    e2eTestFiles: e2eTests.length,
    knownDifferences: knownDifferences.length,
    knownDifferenceCounts
  },
  domains: evidenceManifest.entries,
  scenarios,
  fixtures: fixtureFiles,
  tests: { unit: unitTests, e2e: e2eTests },
  knownDifferences
}

await mkdir(reportDirectory, { recursive: true })
await writeFile(
  resolve(reportDirectory, 'migration-coverage.json'),
  `${JSON.stringify(report, null, 2)}\n`
)
await writeFile(resolve(reportDirectory, 'migration-coverage.md'), renderMarkdown(report))
console.log(
  `Migration coverage report: ${report.summary.parityDomains} matrix domain(s), ` +
  `${statusSummary(statusCounts)}, releaseReady=${String(readiness.releaseReady)}.`
)

async function loadScenarios(directory) {
  const files = (await allFiles(directory)).filter((path) => extname(path) === '.json')
  const values = await Promise.all(files.map(async (path) => {
    const scenario = JSON.parse(await readFile(path, 'utf8'))
    return {
      id: scenario.id,
      priority: scenario.priority,
      path: show(path),
      swiftCommit: scenario.reference?.swiftCommit,
      grokVersion: scenario.reference?.grokVersion,
      assertions: Object.keys(scenario.assert ?? {}).sort()
    }
  }))
  return values.sort((left, right) => left.id.localeCompare(right.id))
}

function renderMarkdown(report) {
  const rows = report.domains
    .map((domain) => {
      const evidence = [...domain.testPaths, ...domain.artifactPaths]
      return `| ${domain.id} | ${domain.priority} | ${domain.status} | ` +
        `${escapeCell(evidence.length > 0 ? evidence.join('; ') : 'none')} | ${escapeCell(domain.gap)} |`
    })
    .join('\n')
  const blockerLines = report.summary.releaseBlockers.length > 0
    ? report.summary.releaseBlockers.map((blocker) => `- \`${blocker.id}\` — \`${blocker.status}\``).join('\n')
    : '- None'
  return `# Generated migration coverage\n\n` +
    `Reference: \`${report.reference.tag}\` / \`${report.reference.commit}\`\n\n` +
    `Source of truth: \`${report.source.evidence}\`\n\n` +
    `Release ready: **${report.summary.releaseReady ? 'yes' : 'no'}**\n\n` +
    `${statusSummary(report.summary.statusCounts)}\n\n` +
    `Deterministic scenarios: ${report.summary.deterministicScenarios} · ` +
    `NDJSON fixtures: ${report.summary.ndjsonFixtures} · ` +
    `Unit files: ${report.summary.unitTestFiles} · ` +
    `E2E files: ${report.summary.e2eTestFiles} · ` +
    `Known differences: ${report.summary.knownDifferences} ` +
    `(pending: ${report.summary.knownDifferenceCounts.pending}, ` +
    `approved: ${report.summary.knownDifferenceCounts.approved})\n\n` +
    `## Release blockers\n\n${blockerLines}\n\n` +
    `## Matrix evidence\n\n` +
    `| ID | Priority | Status | Tests / artifacts | Gap |\n` +
    `| --- | --- | --- | --- | --- |\n${rows}\n`
}

function statusSummary(counts) {
  return Object.entries(counts).map(([status, count]) => `${status}: ${count}`).join(' · ')
}

function escapeCell(value) {
  return String(value).replaceAll('|', '\\|').replaceAll('\n', ' ')
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
