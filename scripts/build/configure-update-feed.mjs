import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const repository = process.argv[2]
if (!repository || !/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(repository)) {
  throw new Error('Expected one safe GitHub owner/repository argument.')
}

const releasesUrl = `https://api.github.com/repos/${repository}/releases`
const destination = resolve(import.meta.dirname, '../../build/update-feed.json')
await writeFile(destination, `${JSON.stringify({ releasesUrl }, null, 2)}\n`, {
  encoding: 'utf8',
  mode: 0o644
})
console.log('Production update feed configured for the release repository.')
