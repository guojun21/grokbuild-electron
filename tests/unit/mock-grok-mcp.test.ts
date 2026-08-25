import { execFile } from 'node:child_process'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ))
})

describe('qa mock Grok MCP commands', () => {
  it('persists list/add/toggle/remove and runs doctor only when invoked', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'grokbuild-mock-mcp-'))
    temporaryDirectories.push(directory)
    const statePath = join(directory, 'mcp-state.json')
    const doctorMarker = join(directory, 'doctor-launched')
    const environment = {
      ...process.env,
      GROKBUILD_MOCK_MCP_STATE: statePath,
      GROKBUILD_MOCK_MCP_DOCTOR_MARKER: doctorMarker,
      GROKBUILD_MOCK_MCP_CANARY: 'MOCK_MCP_CANARY'
    }

    const initial = await runMock(['mcp', 'list', '--json'], environment)
    expect(JSON.parse(initial)).toMatchObject([{ name: 'qa-seeded', env: { QA_SECRET: 'MOCK_MCP_CANARY' } }])
    await expect(access(doctorMarker)).rejects.toMatchObject({ code: 'ENOENT' })

    await runMock([
      'mcp', 'add', '--transport', 'stdio', '--scope', 'project',
      '-e', 'TOKEN=secret-value',
      'local-test', '--', 'npx', '-y', '@example/mcp'
    ], environment)
    let state = JSON.parse(await readFile(statePath, 'utf8')) as Array<Record<string, unknown>>
    expect(state).toContainEqual(expect.objectContaining({
      name: 'local-test',
      scope: 'project',
      command: 'npx',
      args: ['-y', '@example/mcp'],
      env: { TOKEN: 'secret-value' }
    }))

    await runMock(['mcp', 'disable', 'local-test'], environment)
    state = JSON.parse(await runMock(['mcp', 'list', '--json'], environment))
    expect(state.find((server) => server.name === 'local-test')?.enabled).toBe(false)
    await runMock(['mcp', 'enable', 'local-test'], environment)

    const doctor = JSON.parse(await runMock(
      ['mcp', 'doctor', '--json', 'local-test'],
      environment
    )) as { servers: Array<{ name: string }> }
    expect(doctor.servers).toEqual([expect.objectContaining({ name: 'local-test' })])
    await expect(readFile(doctorMarker, 'utf8')).resolves.toBe('doctor launched')

    await runMock(['mcp', 'remove', 'local-test', '--scope', 'project'], environment)
    state = JSON.parse(await runMock(['mcp', 'list', '--json'], environment))
    expect(state.some((server) => server.name === 'local-test')).toBe(false)
  })
})

async function runMock(args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  const result = await execFileAsync(resolve('qa/mock-grok.mjs'), args, {
    cwd: resolve('.'),
    env,
    maxBuffer: 1024 * 1024
  })
  return result.stdout
}
