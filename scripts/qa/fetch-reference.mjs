import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../..')
const manifest = JSON.parse(readFileSync(resolve(root, 'reference/upstream.json'), 'utf8'))
const destination = resolve(root, '.reference/grok-build-desktop')

if (!existsSync(destination)) {
  execFileSync('git', ['clone', '--depth=1', '--branch', manifest.tag, manifest.repository, destination], {
    stdio: 'inherit'
  })
}

const actual = execFileSync('git', ['-C', destination, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
if (actual !== manifest.commit) {
  throw new Error(`Reference mismatch: expected ${manifest.commit}, got ${actual}`)
}

console.log(`Swift reference ready at ${destination} (${actual})`)

