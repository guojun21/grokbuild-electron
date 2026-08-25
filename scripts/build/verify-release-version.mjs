import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../..')
const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
const tag = process.argv[2] ?? process.env.GITHUB_REF_NAME
if (!tag || tag !== `v${manifest.version}`) {
  throw new Error(`Release tag ${tag ?? '(missing)'} does not match package version v${manifest.version}`)
}
console.log(`Release version verified: ${tag}`)

