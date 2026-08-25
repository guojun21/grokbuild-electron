import { rm } from 'node:fs/promises'
import { basename, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../..')
const target = resolve(root, 'dist')
if (basename(target) !== 'dist' || target === root) {
  throw new Error(`Refusing to clean unexpected package output: ${target}`)
}
await rm(target, { recursive: true, force: true })
console.log(`Cleaned package output: ${target}`)

