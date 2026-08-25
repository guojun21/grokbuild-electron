import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  GrokAgentCatalogService,
  type GrokAgentCatalogCliService,
  type GrokAgentCatalogContext
} from '../../src/main/agents/GrokAgentCatalogService'
import {
  GROK_CLI_INSPECT_AGENTS_MAX_OUTPUT_BYTES,
  GrokCliRunError,
  GrokCliService,
  type GrokCliProcessRunner,
  type GrokCliRunRequest,
  type GrokCliRunResult
} from '../../src/main/grok/GrokCliService'
import { publicGrokAgentCatalogSchema } from '../../src/shared/agentCatalog'

const PATH_CANARY = 'agent-source-path-canary-8f31'
const ERROR_CANARY = 'agent-error-canary-c29a'
const temporaryRoots: string[] = []

class StubCatalogCli implements GrokAgentCatalogCliService {
  output = inspectOutput(defaultAgents())
  failure: unknown
  readonly calls: string[] = []

  async inspectAgents(cwd: string): Promise<string> {
    this.calls.push(cwd)
    if (this.failure !== undefined) throw this.failure
    return this.output
  }
}

class RecordingRunner implements GrokCliProcessRunner {
  readonly requests: GrokCliRunRequest[] = []
  result: GrokCliRunResult = {
    stdout: inspectOutput(defaultAgents()),
    stderr: '',
    exitCode: 0,
    signal: null
  }
  failure: unknown

  async run(request: GrokCliRunRequest): Promise<GrokCliRunResult> {
    this.requests.push(request)
    if (this.failure !== undefined) throw this.failure
    return this.result
  }
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(async (path) => {
    await rm(path, { recursive: true, force: true })
  }))
})

describe('GrokAgentCatalogService', () => {
  it('uses the fixed shell-free GrokCliService inspect operation and bounded output', async () => {
    const fixture = await makeFixture()
    const runner = new RecordingRunner()
    const service = new GrokCliService({
      cliPath: fixture.context.cliPath,
      runner,
      maxOutputBytes: 1024 * 1024
    })

    await expect(service.inspectAgents(fixture.context.canonicalCwd))
      .resolves.toBe(runner.result.stdout)
    expect(runner.requests).toHaveLength(1)
    expect(runner.requests[0]).toMatchObject({
      executable: await realpath(fixture.context.cliPath),
      args: ['inspect', '--json'],
      cwd: fixture.context.canonicalCwd,
      maxOutputBytes: GROK_CLI_INSPECT_AGENTS_MAX_OUTPUT_BYTES
    })
  })

  it('projects strict opaque entries and keeps selectors, source paths, and inspect siblings private', async () => {
    const fixture = await makeFixture()
    const sourceRoot = join(fixture.base, `${PATH_CANARY} source folder`)
    await mkdir(sourceRoot)
    const projectSource = join(sourceRoot, 'project-reviewer.md')
    const userSource = join(sourceRoot, 'personal-agent.md')
    const pluginSource = join(sourceRoot, 'plugin-reviewer.md')
    await Promise.all([
      writeFile(projectSource, 'project agent'),
      writeFile(userSource, 'user agent'),
      writeFile(pluginSource, 'plugin agent')
    ])
    const cli = new StubCatalogCli()
    cli.output = inspectOutput([
      {
        name: 'general-purpose',
        description: 'General purpose agent.',
        source: { type: 'builtin' }
      },
      {
        name: 'workspace-reviewer',
        description: `Review files under source:${projectSource}`,
        source: {
          type: 'project',
          path: projectSource
        }
      },
      {
        name: `personal:path:${userSource}`,
        description: 'Personal helper',
        source: {
          type: 'user',
          path: userSource
        }
      },
      {
        name: 'private-plugin:reviewer',
        description: 'Use Bearer VERYSECRETVALUE for nothing',
        source: {
          type: 'plugin',
          plugin_name: `review-tools path:${pluginSource}`,
          path: pluginSource
        }
      }
    ], {
      cwd: `/private/${PATH_CANARY}`,
      projectRoot: `/private/${PATH_CANARY}/root`,
      configSources: { path: `/private/${PATH_CANARY}/config.toml` },
      secretSibling: ERROR_CANARY
    })
    const service = new GrokAgentCatalogService({
      serviceProvider: () => cli,
      tokenFactory: tokenFactory()
    })

    const catalog = await service.list(fixture.context)

    expect(publicGrokAgentCatalogSchema.safeParse(catalog).success).toBe(true)
    expect(catalog).toHaveLength(4)
    expect(catalog[0]).toMatchObject({
      name: 'general-purpose',
      description: 'General purpose agent.',
      sourceKind: 'builtin'
    })
    expect(catalog[1]).toMatchObject({
      name: 'workspace-reviewer',
      description: 'Review files under source:[PATH REDACTED]',
      sourceKind: 'project'
    })
    expect(catalog[2]).toMatchObject({
      name: 'personal:path:[PATH REDACTED]',
      description: 'Personal helper',
      sourceKind: 'user'
    })
    expect(catalog[3]).toMatchObject({
      name: 'private-plugin:reviewer',
      description: 'Use Bearer [REDACTED] for nothing',
      sourceKind: 'plugin',
      pluginDisplayName: 'review-tools path:[PATH REDACTED]'
    })
    for (const entry of catalog) {
      expect(entry.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
      expect(Object.keys(entry).sort()).toEqual(entry.sourceKind === 'plugin'
        ? ['description', 'name', 'pluginDisplayName', 'sourceKind', 'token']
        : ['description', 'name', 'sourceKind', 'token'])
    }
    const wire = JSON.stringify(catalog)
    expect(wire).not.toContain(PATH_CANARY)
    expect(wire).not.toContain(ERROR_CANARY)
    expect(wire).not.toContain('"source":')
    expect(wire).not.toContain('"path":')
    expect(wire).not.toContain('selector')
    expect(wire).not.toContain(fixture.context.canonicalCwd)
    expect(wire).not.toContain(fixture.context.cliPath)

    await expect(service.resolve({ ...fixture.context, token: catalog[3]!.token }))
      .resolves.toEqual({ selector: 'private-plugin:reviewer' })
  })

  it('caches by canonical cwd and CLI identity revision, then revalidates context on resolve', async () => {
    const fixture = await makeFixture()
    const cli = new StubCatalogCli()
    const service = new GrokAgentCatalogService({
      serviceProvider: () => cli,
      tokenFactory: tokenFactory()
    })

    const first = await service.list(fixture.context)
    const cached = await service.list(fixture.context)
    expect(cached).toEqual(first)
    expect(cli.calls).toEqual([
      fixture.context.canonicalCwd,
      fixture.context.canonicalCwd
    ])

    const replacement = `${fixture.context.cliPath}.replacement`
    await writeExecutable(replacement, '#!/bin/sh\nexit 1\n')
    await rename(replacement, fixture.context.cliPath)

    await expect(service.resolve({ ...fixture.context, token: first[0]!.token }))
      .rejects.toMatchObject({ code: 'invalid-token' })
    const refreshed = await service.list(fixture.context)
    expect(refreshed[0]!.token).not.toBe(first[0]!.token)
    expect(cli.calls).toHaveLength(4)
  })

  it('binds non-builtin tokens to source file identity and rejects replacement or symlink races', async () => {
    const fixture = await makeFixture()
    const source = join(fixture.base, 'project-agent.md')
    const replacement = join(fixture.base, 'project-agent-replacement.md')
    await writeFile(source, 'first definition')
    const cli = new StubCatalogCli()
    cli.output = inspectOutput([{
      name: 'project-agent',
      description: 'Project agent',
      source: { type: 'project', path: source }
    }])
    const service = new GrokAgentCatalogService({
      serviceProvider: () => cli,
      tokenFactory: tokenFactory()
    })

    const [first] = await service.list(fixture.context)
    await writeFile(replacement, 'replacement definition')
    await rename(replacement, source)
    await expect(service.resolve({ ...fixture.context, token: first!.token }))
      .rejects.toMatchObject({ code: 'invalid-token' })

    const [second] = await service.list(fixture.context)
    await expect(service.resolve({ ...fixture.context, token: first!.token }))
      .rejects.toMatchObject({ code: 'invalid-token' })
    const moved = `${source}.regular`
    await rename(source, moved)
    await symlink(moved, source)
    await expect(service.resolve({ ...fixture.context, token: second!.token }))
      .rejects.toMatchObject({ code: 'invalid-token' })
  })

  it('rejects a source replacement between the first inspect read and identity binding', async () => {
    const fixture = await makeFixture()
    const source = join(fixture.base, 'dynamic-project-agent.md')
    const replacement = join(fixture.base, 'dynamic-project-agent-replacement.md')
    await writeFile(source, 'benign definition')
    await writeFile(replacement, 'replacement definition')
    const cli = new StubCatalogCli()
    let calls = 0
    cli.inspectAgents = async (cwd: string) => {
      cli.calls.push(cwd)
      const description = await readFile(source, 'utf8')
      calls += 1
      if (calls === 1) await rename(replacement, source)
      return inspectOutput([{
        name: 'dynamic-project-agent',
        description,
        source: { type: 'project', path: source }
      }])
    }
    const service = new GrokAgentCatalogService({
      serviceProvider: () => cli,
      tokenFactory: tokenFactory()
    })

    await expect(service.list(fixture.context))
      .rejects.toMatchObject({ code: 'invalid-context' })
    expect(cli.calls).toHaveLength(2)
  })

  it('freshly revalidates a selected definition and rejects replacement during resolve inspect', async () => {
    const fixture = await makeFixture()
    const source = join(fixture.base, 'resolve-project-agent.md')
    const replacement = join(fixture.base, 'resolve-project-agent-replacement.md')
    await writeFile(source, 'stable definition')
    const cli = new StubCatalogCli()
    let calls = 0
    let replaceOnCall = Number.MAX_SAFE_INTEGER
    cli.inspectAgents = async (cwd: string) => {
      cli.calls.push(cwd)
      const description = await readFile(source, 'utf8')
      calls += 1
      if (calls === replaceOnCall) await rename(replacement, source)
      return inspectOutput([{
        name: 'resolve-project-agent',
        description,
        source: { type: 'project', path: source }
      }])
    }
    const service = new GrokAgentCatalogService({
      serviceProvider: () => cli,
      tokenFactory: tokenFactory()
    })
    const [entry] = await service.list(fixture.context)
    await writeFile(replacement, 'replacement definition')
    replaceOnCall = 3

    await expect(service.resolve({ ...fixture.context, token: entry!.token }))
      .rejects.toMatchObject({ code: 'invalid-token' })
    expect(cli.calls).toHaveLength(3)
  })

  it('expires tokens within five minutes and detects workspace replacement at the same path', async () => {
    const fixture = await makeFixture()
    const cli = new StubCatalogCli()
    let now = 5_000
    const service = new GrokAgentCatalogService({
      serviceProvider: () => cli,
      tokenFactory: tokenFactory(),
      now: () => now,
      ttlMs: 25
    })
    const [entry] = await service.list(fixture.context)

    now += 24
    await expect(service.resolve({ ...fixture.context, token: entry!.token }))
      .resolves.toEqual({ selector: 'general-purpose' })
    now += 1
    await expect(service.resolve({ ...fixture.context, token: entry!.token }))
      .rejects.toMatchObject({ code: 'invalid-token' })

    const [replacementCheck] = await service.list(fixture.context)
    const moved = `${fixture.context.canonicalCwd}.old`
    await rename(fixture.context.canonicalCwd, moved)
    await mkdir(fixture.context.canonicalCwd)
    await expect(service.resolve({ ...fixture.context, token: replacementCheck!.token }))
      .rejects.toMatchObject({ code: 'invalid-token' })

    expect(() => new GrokAgentCatalogService({ ttlMs: 5 * 60_000 + 1 }))
      .toThrow(/5 minutes/)
    expect(() => new GrokAgentCatalogService({ ttlMs: 0 })).toThrow(/5 minutes/)
  })

  it('caps all cached catalogs at 64 entries and evicts the least-recently-used catalog', async () => {
    const fixture = await makeFixture()
    const cli = new StubCatalogCli()
    const outputs = new Map<string, string>([
      [fixture.context.canonicalCwd, inspectOutput(agentRange('first', 40))],
      [fixture.otherCwd, inspectOutput(agentRange('second', 30))]
    ])
    cli.inspectAgents = async (cwd: string) => {
      cli.calls.push(cwd)
      return outputs.get(cwd)!
    }
    const service = new GrokAgentCatalogService({
      serviceProvider: () => cli,
      tokenFactory: tokenFactory()
    })
    const first = await service.list(fixture.context)
    const secondContext = { ...fixture.context, canonicalCwd: fixture.otherCwd }
    const second = await service.list(secondContext)

    expect(first).toHaveLength(40)
    expect(second).toHaveLength(30)
    await expect(service.resolve({ ...fixture.context, token: first[0]!.token }))
      .rejects.toMatchObject({ code: 'invalid-token' })
    await expect(service.resolve({ ...secondContext, token: second[0]!.token }))
      .resolves.toEqual({ selector: 'second-0' })
  })

  it('deduplicates concurrent same-context refreshes without orphaning tokens or capacity', async () => {
    const fixture = await makeFixture()
    const cli = new StubCatalogCli()
    let releaseFirst!: () => void
    let markStarted!: () => void
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
    const firstStarted = new Promise<void>((resolve) => { markStarted = resolve })
    cli.inspectAgents = async (cwd: string) => {
      cli.calls.push(cwd)
      if (cli.calls.length === 1) {
        markStarted()
        await firstGate
      }
      return cli.output
    }
    const service = new GrokAgentCatalogService({
      serviceProvider: () => cli,
      tokenFactory: tokenFactory()
    })

    const pending = Array.from({ length: 40 }, () => service.list(fixture.context))
    await firstStarted
    await new Promise((resolve) => setTimeout(resolve, 10))
    releaseFirst()
    const catalogs = await Promise.all(pending)

    expect(cli.calls).toHaveLength(2)
    expect(catalogs.every((catalog) => JSON.stringify(catalog) === JSON.stringify(catalogs[0])))
      .toBe(true)

    const oldToken = catalogs[0]![0]!.token
    const replacementCli = `${fixture.context.cliPath}.replacement`
    await writeExecutable(replacementCli, '#!/bin/sh\nexit 0\n')
    await rename(replacementCli, fixture.context.cliPath)
    cli.output = inspectOutput(agentRange('refreshed', 64))
    const refreshed = await service.list(fixture.context)

    expect(refreshed).toHaveLength(64)
    expect(cli.calls).toHaveLength(4)
    await expect(service.resolve({ ...fixture.context, token: oldToken }))
      .rejects.toMatchObject({ code: 'invalid-token' })
    await expect(service.resolve({ ...fixture.context, token: refreshed[0]!.token }))
      .resolves.toEqual({ selector: 'refreshed-0' })
  })

  it('invalidates an in-flight refresh when clear starts a new generation', async () => {
    const fixture = await makeFixture()
    const cli = new StubCatalogCli()
    let releaseFirst!: () => void
    let markStarted!: () => void
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
    const firstStarted = new Promise<void>((resolve) => { markStarted = resolve })
    cli.inspectAgents = async (cwd: string) => {
      cli.calls.push(cwd)
      if (cli.calls.length === 1) {
        markStarted()
        await firstGate
      }
      return cli.output
    }
    const service = new GrokAgentCatalogService({
      serviceProvider: () => cli,
      tokenFactory: tokenFactory()
    })

    const stale = service.list(fixture.context)
    await firstStarted
    service.clear()
    releaseFirst()

    await expect(stale).rejects.toMatchObject({ code: 'catalog-unavailable' })
    await expect(service.list(fixture.context)).resolves.toHaveLength(1)
    expect(cli.calls).toHaveLength(3)
  })

  it('fails closed on malformed, empty, duplicate, unknown, and oversized inspect output', async () => {
    const fixture = await makeFixture()
    const cli = new StubCatalogCli()
    const service = new GrokAgentCatalogService({
      serviceProvider: () => cli,
      tokenFactory: tokenFactory()
    })
    const invalidOutputs = [
      'not-json',
      '{}',
      inspectOutput([]),
      inspectOutput([defaultAgents()[0]!, defaultAgents()[0]!]),
      inspectOutput([{
        name: 'future',
        description: 'Future source',
        source: { type: 'remote', path: '/private/future.md' }
      }]),
      inspectOutput([{
        name: 'extra-field',
        description: 'Strict record',
        source: { type: 'builtin' },
        selector: 'must-not-be-accepted'
      }]),
      inspectOutput(agentRange('overflow', 65)),
      JSON.stringify({
        agents: defaultAgents(),
        padding: 'x'.repeat(GROK_CLI_INSPECT_AGENTS_MAX_OUTPUT_BYTES)
      })
    ]
    for (const output of invalidOutputs) {
      service.clear()
      cli.output = output
      const error = await rejection(service.list(fixture.context))
      expect(error).toMatchObject({ code: 'invalid-catalog' })
      expect(serializeError(error)).not.toContain(output.slice(0, 64))
    }
  })

  it('maps nonzero, timeout, output-limit, and arbitrary diagnostics to fixed errors', async () => {
    const fixture = await makeFixture()
    const runner = new RecordingRunner()
    const cliService = new GrokCliService({ cliPath: fixture.context.cliPath, runner })

    runner.result = {
      stdout: ERROR_CANARY,
      stderr: `${ERROR_CANARY} /private/${PATH_CANARY}`,
      exitCode: 7,
      signal: null
    }
    let error = await rejection(cliService.inspectAgents(fixture.context.canonicalCwd))
    expect(error).toMatchObject({ code: 'command-failed', operation: 'inspect-agents', exitCode: 7 })
    expect(serializeError(error)).not.toContain(ERROR_CANARY)
    expect(serializeError(error)).not.toContain(PATH_CANARY)

    for (const kind of ['timeout', 'output-limit'] as const) {
      runner.failure = new GrokCliRunError(kind)
      error = await rejection(cliService.inspectAgents(fixture.context.canonicalCwd))
      expect(error).toMatchObject({ code: kind, operation: 'inspect-agents' })
      expect(serializeError(error)).not.toContain(ERROR_CANARY)
    }

    const cli = new StubCatalogCli()
    cli.failure = new Error(`${ERROR_CANARY} /private/${PATH_CANARY}`)
    const catalog = new GrokAgentCatalogService({ serviceProvider: () => cli })
    error = await rejection(catalog.list(fixture.context))
    expect(error).toMatchObject({ code: 'catalog-unavailable' })
    expect(serializeError(error)).not.toContain(ERROR_CANARY)
    expect(serializeError(error)).not.toContain(PATH_CANARY)
  })

  it('rejects malformed/colliding tokens without exposing a raw selector', async () => {
    const fixture = await makeFixture()
    const cli = new StubCatalogCli()
    const collision = Buffer.alloc(32, 9).toString('base64url')
    const service = new GrokAgentCatalogService({
      serviceProvider: () => cli,
      tokenFactory: () => collision
    })
    cli.output = inspectOutput(agentRange('agent', 2))
    const error = await rejection(service.list(fixture.context))
    expect(error).toMatchObject({ code: 'catalog-unavailable' })
    expect(serializeError(error)).not.toContain('agent-0')

    const usable = new GrokAgentCatalogService({
      serviceProvider: () => cli,
      tokenFactory: tokenFactory()
    })
    cli.output = inspectOutput(defaultAgents())
    const [entry] = await usable.list(fixture.context)
    for (const token of ['', 'not-a-token', `${entry!.token}x`]) {
      await expect(usable.resolve({ ...fixture.context, token }))
        .rejects.toMatchObject({ code: 'invalid-token' })
    }
  })
})

interface RawAgent {
  name: string
  description: string
  source: Record<string, unknown>
  [key: string]: unknown
}

function defaultAgents(): RawAgent[] {
  return [{
    name: 'general-purpose',
    description: 'General purpose agent.',
    source: { type: 'builtin' }
  }]
}

function agentRange(prefix: string, count: number): RawAgent[] {
  return Array.from({ length: count }, (_, index) => ({
    name: `${prefix}-${index}`,
    description: `Agent ${index}`,
    source: { type: 'builtin' }
  }))
}

function inspectOutput(
  agents: RawAgent[],
  siblings: Record<string, unknown> = {}
): string {
  return JSON.stringify({
    agents,
    grokVersion: '1.0.5',
    ...siblings
  })
}

async function makeFixture(): Promise<{
  base: string
  context: GrokAgentCatalogContext
  otherCwd: string
}> {
  const base = await realpath(await mkdtemp(join(await realpath(tmpdir()), 'grok-agent-catalog-')))
  temporaryRoots.push(base)
  const cwd = join(base, 'project-a')
  const otherCwd = join(base, 'project-b')
  const cliPath = join(base, 'grok')
  await mkdir(cwd)
  await mkdir(otherCwd)
  await writeExecutable(cliPath, '#!/bin/sh\nexit 0\n')
  return {
    base,
    context: { canonicalCwd: cwd, cliPath },
    otherCwd
  }
}

async function writeExecutable(path: string, contents: string): Promise<void> {
  await writeFile(path, contents)
  await chmod(path, 0o700)
}

function tokenFactory(): () => string {
  let index = 0
  return () => Buffer.alloc(32, (index += 1) % 256).toString('base64url')
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('Expected promise to reject')
}

function serializeError(error: unknown): string {
  return `${String(error)} ${JSON.stringify(error)}`
}
