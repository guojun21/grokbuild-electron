import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  MacAppIdentityError,
  MacAppIdentityService
} from '../../src/main/updates/MacAppIdentityService'

const BUNDLE_ID = 'com.oasmet.grokbuild-electron'
const APP_NAME = 'GrokBuild Electron'
const TEAM_ID = 'A1B2C3D4E5'
const SHORT_VERSION = '0.2.0'
const BUNDLE_VERSION = '20260825.1'
const ARCHITECTURES = ['arm64', 'x86_64'] as const
const PRIVATE_CANARY = 'QA_IDENTITY_PRIVATE_CANARY_8f7d'

type ServiceOptions = NonNullable<ConstructorParameters<typeof MacAppIdentityService>[0]>
type ToolRunner = NonNullable<ServiceOptions['runner']>
type ToolRequest = Parameters<ToolRunner['run']>[0]
type ToolResult = Awaited<ReturnType<ToolRunner['run']>>
type ToolFailure = Exclude<ToolResult['failure'], null>

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })
  ))
})

describe('MacAppIdentityService', () => {
  it('derives the canonical app root and returns one verified Developer ID identity', async () => {
    const fixture = await appFixture()
    const runner = new FixtureRunner()
    const service = new MacAppIdentityService({ runner })

    await expect(service.inspect({
      executablePath: fixture.executablePath,
      isPackaged: true
    })).resolves.toEqual({
      appPath: fixture.appPath,
      executablePath: fixture.executablePath,
      bundleId: BUNDLE_ID,
      appName: APP_NAME,
      shortVersion: SHORT_VERSION,
      bundleVersion: BUNDLE_VERSION,
      teamId: TEAM_ID,
      designatedRequirement: designatedRequirement(),
      architectures: ARCHITECTURES
    })

    expect(runner.requests.map((request) => request.executable)).toEqual([
      '/usr/bin/codesign',
      '/usr/bin/codesign',
      '/usr/bin/codesign',
      '/usr/bin/plutil',
      '/usr/bin/plutil',
      '/usr/bin/plutil',
      '/usr/bin/plutil',
      '/usr/bin/plutil',
      '/usr/bin/lipo'
    ])
    expect(runner.requests[0]?.args).toEqual([
      '--verify', '--deep', '--strict', '--verbose=2', fixture.appPath
    ])
    expect(runner.requests[1]?.args).toEqual(['-d', '--verbose=4', fixture.appPath])
    expect(runner.requests[2]?.args).toEqual(['-d', '-r-', fixture.appPath])
    expect(runner.requests[8]?.args).toEqual(['-archs', fixture.executablePath])
    expect(runner.requests.every((request) => request.cwd === fixture.root)).toBe(true)
    expect(runner.requests.every((request) => request.timeoutMs === 15_000)).toBe(true)
    expect(runner.requests.every((request) => request.maxOutputBytes === 256 * 1024)).toBe(true)
  })

  it('rejects development builds and unsafe paths before invoking a tool', async () => {
    const fixture = await appFixture()
    const runner = new FixtureRunner()
    const service = new MacAppIdentityService({ runner })

    await expect(service.inspect({
      executablePath: fixture.executablePath,
      isPackaged: false
    })).rejects.toMatchObject({ code: 'not-packaged' })

    const nonAppExecutable = join(fixture.root, 'bin', 'GrokBuild')
    await mkdir(join(fixture.root, 'bin'))
    await writeFile(nonAppExecutable, '')
    await expect(service.inspect({
      executablePath: nonAppExecutable,
      isPackaged: true
    })).rejects.toMatchObject({ code: 'invalid-app-path' })

    const aliasPath = join(fixture.root, 'Alias.app')
    await symlink(fixture.appPath, aliasPath)
    await expect(service.inspect({
      executablePath: join(aliasPath, 'Contents', 'MacOS', APP_NAME),
      isPackaged: true
    })).rejects.toMatchObject({ code: 'invalid-app-path' })

    expect(runner.requests).toEqual([])
  })

  it.each([
    ['unsigned verification', { verifyExitCode: 1 }, 'signature-ineligible'],
    ['ad-hoc signature', { identityOutput: validIdentityOutput('Signature=adhoc') }, 'signature-ineligible'],
    ['missing runtime', { identityOutput: validIdentityOutput('', { runtime: false }) }, 'signature-ineligible'],
    ['missing timestamp', { identityOutput: validIdentityOutput('', { timestamp: false }) }, 'signature-ineligible'],
    ['wrong authority team', { identityOutput: validIdentityOutput('', { authorityTeam: 'Z9Y8X7W6V5' }) }, 'signature-ineligible'],
    ['duplicate identifier', { identityOutput: `${validIdentityOutput()}\nIdentifier=${BUNDLE_ID}` }, 'identity-invalid'],
    ['missing designated requirement', { requirementOutput: 'not a designated requirement' }, 'identity-invalid'],
    ['wrong plist identifier', { plist: { CFBundleIdentifier: 'com.attacker.replacement' } }, 'metadata-invalid'],
    ['invalid short version', { plist: { CFBundleShortVersionString: '../0.2.0' } }, 'metadata-invalid'],
    ['wrong bundle executable', { plist: { CFBundleExecutable: 'AttackerHelper' } }, 'metadata-invalid'],
    ['empty architecture output', { lipoOutput: '' }, 'metadata-invalid'],
    ['unsupported architecture', { lipoOutput: 'arm64 i386' }, 'metadata-invalid'],
    ['duplicate architecture', { lipoOutput: 'arm64 arm64' }, 'metadata-invalid']
  ] as const)('fails closed for %s', async (_label, options, expectedCode) => {
    const fixture = await appFixture()
    const runner = new FixtureRunner(options)
    const service = new MacAppIdentityService({ runner })

    await expect(service.inspect({
      executablePath: fixture.executablePath,
      isPackaged: true
    })).rejects.toMatchObject({ code: expectedCode })
  })

  it.each([
    ['spawn', 'tool-unavailable'],
    ['timeout', 'timeout'],
    ['output-limit', 'output-limit']
  ] as const)('maps %s tool failures to fixed public errors', async (failure, code) => {
    const fixture = await appFixture()
    const runner = new FixtureRunner({ toolFailure: failure })
    const service = new MacAppIdentityService({ runner })
    const error = await rejection(service.inspect({
      executablePath: fixture.executablePath,
      isPackaged: true
    }))

    expect(error).toBeInstanceOf(MacAppIdentityError)
    expect(error).toMatchObject({ code })
    const publicView = JSON.stringify({
      name: (error as Error).name,
      message: (error as Error).message,
      code: (error as MacAppIdentityError).code
    })
    expect(publicView).not.toContain(PRIVATE_CANARY)
    expect(publicView).not.toContain(fixture.root)
    expect(publicView).not.toContain(TEAM_ID)
  })

  it('never includes path, command output, argv, or Team ID in fixed errors', async () => {
    const fixture = await appFixture()
    const runner = new FixtureRunner({
      verifyExitCode: 1,
      privateOutput: `${PRIVATE_CANARY} ${fixture.appPath} ${TEAM_ID} --deep --strict`
    })
    const error = await rejection(new MacAppIdentityService({ runner }).inspect({
      executablePath: fixture.executablePath,
      isPackaged: true
    }))
    expect(String(error)).toBe(
      'MacAppIdentityError: The running application is not eligible for trusted updates.'
    )
    const publicView = JSON.stringify({
      name: (error as Error).name,
      message: (error as Error).message,
      code: (error as MacAppIdentityError).code
    })
    expect(publicView).not.toContain(PRIVATE_CANARY)
    expect(publicView).not.toContain(fixture.appPath)
    expect(publicView).not.toContain(TEAM_ID)
    expect(publicView).not.toContain('--deep')
  })

  it('validates bounded process settings without exposing arbitrary values', () => {
    expect(() => new MacAppIdentityService({ timeoutMs: 0 })).toThrow(
      'The running application identity could not be verified.'
    )
    expect(() => new MacAppIdentityService({ maxOutputBytes: 8 * 1024 * 1024 })).toThrow(
      'The running application identity could not be verified.'
    )
    expect(() => new MacAppIdentityService({ terminateGraceMs: 0 })).toThrow(
      'The running application identity could not be verified.'
    )
  })
})

class FixtureRunner implements ToolRunner {
  readonly requests: ToolRequest[] = []
  private readonly verifyExitCode: number
  private readonly identityOutput: string
  private readonly requirementOutput: string
  private readonly plist: Record<string, string>
  private readonly lipoOutput: string
  private readonly toolFailure: ToolFailure | undefined
  private readonly privateOutput: string

  constructor(options: {
    verifyExitCode?: number
    identityOutput?: string
    requirementOutput?: string
    plist?: Partial<Record<
      | 'CFBundleIdentifier'
      | 'CFBundleName'
      | 'CFBundleShortVersionString'
      | 'CFBundleVersion'
      | 'CFBundleExecutable',
      string
    >>
    lipoOutput?: string
    toolFailure?: ToolFailure
    privateOutput?: string
  } = {}) {
    this.verifyExitCode = options.verifyExitCode ?? 0
    this.identityOutput = options.identityOutput ?? validIdentityOutput()
    this.requirementOutput = options.requirementOutput ?? `designated => ${designatedRequirement()}`
    this.plist = {
      CFBundleIdentifier: BUNDLE_ID,
      CFBundleName: APP_NAME,
      CFBundleShortVersionString: SHORT_VERSION,
      CFBundleVersion: BUNDLE_VERSION,
      CFBundleExecutable: APP_NAME,
      ...options.plist
    }
    this.lipoOutput = options.lipoOutput ?? ARCHITECTURES.join(' ')
    this.toolFailure = options.toolFailure
    this.privateOutput = options.privateOutput ?? PRIVATE_CANARY
  }

  async run(request: ToolRequest): Promise<ToolResult> {
    this.requests.push(request)
    if (this.toolFailure) return failed(this.toolFailure, this.privateOutput)
    if (request.executable === '/usr/bin/codesign' && request.args[0] === '--verify') {
      return result(this.verifyExitCode, '', this.verifyExitCode === 0 ? '' : this.privateOutput)
    }
    if (request.executable === '/usr/bin/codesign' && request.args[1] === '--verbose=4') {
      return result(0, '', this.identityOutput)
    }
    if (request.executable === '/usr/bin/codesign' && request.args[1] === '-r-') {
      return result(0, '', this.requirementOutput)
    }
    if (request.executable === '/usr/bin/plutil') {
      const key = request.args[1]
      return result(0, `${this.plist[key ?? ''] ?? ''}\n`)
    }
    if (request.executable === '/usr/bin/lipo') {
      return result(0, `${this.lipoOutput}\n`)
    }
    return result(1, '', this.privateOutput)
  }
}

async function appFixture(): Promise<{
  root: string
  appPath: string
  executablePath: string
}> {
  const rawRoot = await mkdtemp(join(tmpdir(), 'grokbuild-app-identity-'))
  const root = await realpath(rawRoot)
  temporaryRoots.push(root)
  const appPath = join(root, `${APP_NAME}.app`)
  const executableDirectory = join(appPath, 'Contents', 'MacOS')
  const executablePath = join(executableDirectory, APP_NAME)
  await mkdir(executableDirectory, { recursive: true })
  await writeFile(executablePath, '#!/bin/sh\n')
  return { root, appPath, executablePath }
}

function validIdentityOutput(
  extra = '',
  options: {
    runtime?: boolean
    timestamp?: boolean
    authorityTeam?: string
  } = {}
): string {
  return [
    `Identifier=${BUNDLE_ID}`,
    `CodeDirectory v=20500 size=512 flags=0x${options.runtime === false ? '0' : '10000'}(${options.runtime === false ? 'none' : 'runtime'}) hashes=4+7 location=embedded`,
    `Authority=Developer ID Application: GrokBuild QA (${options.authorityTeam ?? TEAM_ID})`,
    'Authority=Developer ID Certification Authority',
    'Authority=Apple Root CA',
    `TeamIdentifier=${TEAM_ID}`,
    ...(options.timestamp === false ? [] : ['Timestamp=Aug 25, 2026 at 12:00:00']),
    ...(extra ? [extra] : [])
  ].join('\n')
}

function designatedRequirement(): string {
  return `identifier "${BUNDLE_ID}" and anchor apple generic and certificate leaf[subject.OU] = "${TEAM_ID}"`
}

function result(exitCode: number, stdout = '', stderr = ''): ToolResult {
  return {
    stdout: Buffer.from(stdout),
    stderr: Buffer.from(stderr),
    exitCode,
    signal: null,
    failure: null
  }
}

function failed(failure: ToolFailure, output: string): ToolResult {
  return {
    stdout: Buffer.from(output),
    stderr: Buffer.from(output),
    exitCode: null,
    signal: null,
    failure
  }
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('Expected rejection')
}
