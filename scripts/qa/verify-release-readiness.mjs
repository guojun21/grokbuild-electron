import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  evaluateReleaseReadiness,
  parseParityMatrix,
  validateEvidenceManifest,
  validateIntentionalDifferenceLinks,
  validateKnownDifferences
} from './lib/parity-contracts.mjs'

const root = resolve(import.meta.dirname, '../..')

try {
  const matrixEntries = parseParityMatrix(
    await readFile(resolve(root, 'docs/PARITY_MATRIX.md'), 'utf8')
  )
  const manifest = JSON.parse(
    await readFile(resolve(root, 'qa/contracts/parity-evidence.json'), 'utf8')
  )
  const knownDifferences = JSON.parse(
    await readFile(resolve(root, 'qa/contracts/known-differences.json'), 'utf8')
  )
  const contractErrors = [
    ...await validateEvidenceManifest({ matrixEntries, manifest, root }),
    ...validateKnownDifferences(knownDifferences, matrixEntries),
    ...validateIntentionalDifferenceLinks(manifest, knownDifferences)
  ]
  if (contractErrors.length > 0) {
    console.error('Release readiness could not be evaluated because parity contracts are invalid.')
    console.error('Run npm run qa:contracts for repository-relative diagnostics.')
    process.exit(1)
  }

  const readiness = evaluateReleaseReadiness(matrixEntries, manifest, knownDifferences)
  if (!readiness.releaseReady) {
    for (const blocker of readiness.blockers) {
      console.error(`RELEASE_BLOCKER ${blocker.id} ${blocker.status}`)
    }
    console.error(`Release readiness failed: ${readiness.blockers.length} blocker(s).`)
    process.exit(1)
  }
  console.log('Release readiness passed: every P0/P1 row is verified or has an approved difference.')
} catch {
  console.error('Release readiness could not be evaluated because parity contracts are unreadable.')
  process.exit(1)
}
