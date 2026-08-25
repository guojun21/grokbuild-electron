import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../..')
const manifest = JSON.parse(readFileSync(resolve(root, 'reference/upstream.json'), 'utf8'))
const destination = resolve(root, '.reference/grok-build-desktop')

if (!existsSync(destination)) {
  throw new Error('Reference missing. Run npm run reference:fetch first.')
}

const actual = execFileSync('git', ['-C', destination, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
if (actual !== manifest.commit) {
  throw new Error(`Reference mismatch: expected ${manifest.commit}, got ${actual}`)
}

const dirty = execFileSync(
  'git',
  ['-C', destination, 'status', '--porcelain', '--untracked-files=no'],
  { encoding: 'utf8' }
).trim()
if (dirty) throw new Error(`Pinned Swift reference has tracked modifications:\n${dirty}`)

const license = readFileSync(resolve(destination, 'LICENSE'), 'utf8')
if (manifest.license === 'Apache-2.0' && !/Apache License[\s\S]*Version 2\.0/i.test(license)) {
  throw new Error('Pinned Swift reference no longer contains the declared Apache-2.0 license')
}

console.log(`Reference verified: ${manifest.tag} ${actual}`)
