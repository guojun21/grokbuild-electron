import { readFile, readdir } from 'node:fs/promises'
import { extname, join, relative, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../..')
const violations = []

for (const file of await sourceFiles(resolve(root, 'src/renderer'))) {
  const source = await readFile(file, 'utf8')
  checkImports(file, source, (specifier) => {
    if (specifier === 'electron' || specifier.startsWith('node:')) return 'renderer imports a privileged runtime module'
    if (/(^|\/)main(\/|$)|(^|\/)preload(\/|$)/.test(specifier)) return 'renderer crosses the main/preload boundary'
    return undefined
  })
  if (/\b(ipcRenderer|child_process|process\.env|require\s*\()/.test(source)) {
    violations.push(`${display(file)}: renderer contains a forbidden privileged identifier`)
  }
  if (/dangerouslySetInnerHTML|\beval\s*\(|new\s+Function\s*\(/.test(source)) {
    violations.push(`${display(file)}: renderer contains an unsafe dynamic-code or raw-HTML sink`)
  }
}

for (const file of await sourceFiles(resolve(root, 'src/preload'))) {
  const source = await readFile(file, 'utf8')
  checkImports(file, source, (specifier) => {
    if (specifier === 'electron' || specifier.startsWith('../shared') || specifier.startsWith('@shared')) return undefined
    return `preload dependency is outside the electron/shared allowlist: ${specifier}`
  })
}

for (const directory of ['qa', 'tests']) {
  for (const file of await sourceFiles(resolve(root, directory), true)) {
    const source = await readFile(file, 'utf8')
    if (/\b(xai-[A-Za-z0-9_-]{16,}|sk-[A-Za-z0-9_-]{16,}|api[_-]?key\s*[=:]\s*["'][^"']{8,})/i.test(source)) {
      violations.push(`${display(file)}: fixture/test appears to contain a secret`)
    }
  }
}

const electronEntry = await readFile(resolve(root, 'src/main/index.ts'), 'utf8')
for (const [pattern, reason] of [
  [/contextIsolation:\s*true/, 'main window must enable contextIsolation'],
  [/nodeIntegration:\s*false/, 'main window must disable nodeIntegration'],
  [/sandbox:\s*true/, 'main window must enable renderer sandboxing'],
  [/webSecurity:\s*true/, 'main window must retain webSecurity']
]) {
  if (!pattern.test(electronEntry)) violations.push(`src/main/index.ts: ${reason}`)
}

for (const file of await sourceFiles(resolve(root, 'src/main'))) {
  const source = await readFile(file, 'utf8')
  if (/shell:\s*true/.test(source)) {
    violations.push(`${display(file)}: privileged child process enables a shell`)
  }
}

if (violations.length > 0) {
  console.error(violations.join('\n'))
  process.exit(1)
}
console.log('Architecture boundaries and fixture secret scan passed.')

function checkImports(file, source, policy) {
  const pattern = /(?:import|export)\s+(?:type\s+)?(?:[^'";]+?\s+from\s+)?["']([^"']+)["']/g
  for (const match of source.matchAll(pattern)) {
    const specifier = match[1]
    if (!specifier) continue
    const reason = policy(specifier)
    if (reason) violations.push(`${display(file)}: ${reason} (${specifier})`)
  }
}

async function sourceFiles(directory, includeData = false) {
  const results = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) results.push(...await sourceFiles(path, includeData))
    else if (['.ts', '.tsx', '.js', '.mjs', ...(includeData ? ['.json', '.ndjson'] : [])].includes(extname(path))) results.push(path)
  }
  return results
}

function display(path) {
  return relative(root, path)
}
