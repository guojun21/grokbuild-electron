import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  MANAGED_TOML_BEGIN,
  MANAGED_TOML_END,
  ManagedTomlError,
  parseManagedToml,
  projectPublicModelCatalog,
  renderManagedEnvelope,
  rewriteManagedToml,
  type ManagedCustomModel,
  type ManagedModelCatalog,
  type ManagedModelProvider
} from '../../src/main/models/managedToml'

const fixturePath = resolve('tests/fixtures/models/unmanaged-complex.toml')

describe('managed Grok TOML core', () => {
  it('retains a complex unmanaged CRLF prefix byte-for-byte across targeted edits', async () => {
    const fixture = await readFile(fixturePath, 'utf8')
    const original = fixture.replaceAll('\n', '\r\n')

    const withProvider = rewriteManagedToml(original, {
      type: 'upsert-provider',
      provider: provider()
    })
    const withModel = rewriteManagedToml(withProvider.text, {
      type: 'upsert-model',
      model: model()
    })
    const updated = rewriteManagedToml(withModel.text, {
      type: 'upsert-provider',
      provider: { ...provider(), contextWindow: 256_000 }
    })

    expect(Buffer.from(updated.text).subarray(0, Buffer.byteLength(original)))
      .toEqual(Buffer.from(original))
    const managedSuffix = updated.text.slice(original.length)
    expect(managedSuffix.replaceAll('\r\n', '')).not.toContain('\n')
    expect(managedSuffix).toContain('\r\n#')
    expect(parseManagedToml(updated.text)).toMatchObject({
      hasManagedEnvelope: true,
      newline: '\r\n',
      catalog: {
        providers: [{ id: 'openai-compatible', contextWindow: 256_000 }],
        models: [{ id: 'custom-reasoner', providerId: 'openai-compatible' }]
      }
    })
  })

  it('keeps an explicit empty managed envelope after deleting the final records', () => {
    const original = 'theme = "system"'
    const addedProvider = rewriteManagedToml(original, {
      type: 'upsert-provider', provider: provider()
    })
    const addedModel = rewriteManagedToml(addedProvider.text, {
      type: 'upsert-model', model: model()
    })
    const deletedModel = rewriteManagedToml(addedModel.text, {
      type: 'delete-model', modelId: model().id
    })
    const deletedProvider = rewriteManagedToml(deletedModel.text, {
      type: 'delete-provider', providerId: provider().id
    })

    expect(deletedProvider.text.startsWith(`${original}\n`)).toBe(true)
    expect(deletedProvider.text.endsWith(`${MANAGED_TOML_BEGIN}\n${MANAGED_TOML_END}\n`)).toBe(true)
    expect(parseManagedToml(deletedProvider.text).catalog).toEqual({ providers: [], models: [] })
  })

  it('does not claim ownership or alter bytes for a no-op deletion', () => {
    const source = '# untouched\nvalue = true\n'
    expect(rewriteManagedToml(source, {
      type: 'delete-model', modelId: 'missing-model'
    })).toEqual({
      text: source,
      catalog: { providers: [], models: [] },
      changed: false
    })
  })

  it('fails closed on unknown, non-canonical, misplaced, or duplicated managed content', () => {
    const valid = renderManagedEnvelope({ providers: [provider()], models: [] })
    const forbiddenCredentialKey = ['api', 'key'].join('_')
    const unknown = valid.replace(
      'api_backend =',
      `${forbiddenCredentialKey} = "private-canary"\napi_backend =`
    )
    expectCode(() => parseManagedToml(unknown), 'invalid-managed-block')

    const nonCanonical = valid.replace('context_window = 128000', 'context_window = 128_000')
    expectCode(() => parseManagedToml(nonCanonical), 'invalid-managed-block')

    const markerInsideString = [
      'note = """',
      MANAGED_TOML_BEGIN,
      MANAGED_TOML_END,
      '"""',
      ''
    ].join('\n')
    expectCode(() => parseManagedToml(markerInsideString), 'invalid-managed-block')

    const duplicate = [
      '[model_providers.same]',
      'base_url = "https://one.example.test/v1"',
      '',
      '[model_providers.same]',
      'base_url = "https://two.example.test/v1"',
      ''
    ].join('\n')
    expectCode(() => parseManagedToml(duplicate), 'malformed-toml')
  })

  it('validates all user TOML and refuses a managed ID that collides with an unmanaged table', () => {
    expectCode(() => parseManagedToml('value = "unterminated'), 'malformed-toml')

    const existing = [
      '[model_providers.openai-compatible]',
      'base_url = "https://user.example.test/v1"',
      ''
    ].join('\n')
    expectCode(() => rewriteManagedToml(existing, {
      type: 'upsert-provider', provider: provider()
    }), 'malformed-toml')
  })

  it('requires valid provider relationships and prevents provider deletion while in use', () => {
    expectCode(() => rewriteManagedToml('', {
      type: 'upsert-model', model: model()
    }), 'invalid-reference')

    const withProvider = rewriteManagedToml('', {
      type: 'upsert-provider', provider: provider()
    })
    const withModel = rewriteManagedToml(withProvider.text, {
      type: 'upsert-model', model: model()
    })
    expectCode(() => rewriteManagedToml(withModel.text, {
      type: 'delete-provider', providerId: provider().id
    }), 'provider-in-use')
  })

  it('uses exact semantic unmanaged references only when deleting an owned provider', () => {
    const unmanagedExactReference = [
      '[model."quoted.id"]',
      `model_provider = ${JSON.stringify(provider().id)}`,
      ''
    ].join('\n')
    expect(rewriteManagedToml(unmanagedExactReference, {
      type: 'delete-provider', providerId: provider().id
    })).toEqual({
      text: unmanagedExactReference,
      catalog: { providers: [], models: [] },
      changed: false
    })

    const unmanagedDifferentReference = [
      '[model.dotted.id]',
      `model_provider = ${JSON.stringify(`${provider().id}-other`)}`,
      ''
    ].join('\n')
    const withManagedProvider = rewriteManagedToml(unmanagedDifferentReference, {
      type: 'upsert-provider', provider: provider()
    })
    expect(rewriteManagedToml(withManagedProvider.text, {
      type: 'delete-provider', providerId: provider().id
    }).catalog.providers).toEqual([])
  })

  it('projects a strict public catalog without environment names or accidental secret fields', () => {
    const catalog: ManagedModelCatalog = {
      providers: [provider({ baseUrl: 'https://api.example.test:8443/v1' })],
      models: [model()]
    }
    const projected = projectPublicModelCatalog(catalog, {
      environmentAvailable: (name) => name === 'CUSTOM_PROVIDER_TOKEN',
      defaultModelId: model().id
    })

    expect(projected).toEqual({
      providers: [{
        id: 'openai-compatible',
        name: 'openai-compatible',
        endpointClass: 'remote',
        originRedacted: 'https://api.example.test',
        backend: 'responses',
        credentialState: 'environment',
        isManagedCursor: false,
        modelCount: 1,
        status: 'configured'
      }],
      models: [{
        id: 'custom-reasoner',
        upstreamModel: 'vendor/reasoner-v1',
        name: 'Custom Reasoner',
        providerId: 'openai-compatible',
        backend: 'responses',
        contextWindow: 128_000,
        supportsReasoningEffort: true,
        isDefault: true
      }]
    })
    expect(JSON.stringify(projected)).not.toContain('CUSTOM_PROVIDER_TOKEN')

    const privateCanary = 'private-value-must-never-project'
    const polluted = {
      providers: [{ ...provider(), secretValue: privateCanary }],
      models: []
    } as unknown as ManagedModelCatalog
    let message = ''
    try {
      projectPublicModelCatalog(polluted)
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toBe('The managed model change is invalid.')
    expect(message).not.toContain(privateCanary)
  })

  it('requires one to eight unique bounded environment names in an env-key array', () => {
    for (const envKey of [
      [],
      ['TOKEN_A', 'TOKEN_A'],
      Array.from({ length: 9 }, (_, index) => `TOKEN_${index}`)
    ]) {
      expectCode(() => rewriteManagedToml('', {
        type: 'upsert-provider',
        provider: { ...provider(), envKey } as ManagedModelProvider
      }), 'invalid-mutation')
    }
  })
})

function provider(overrides: Partial<ManagedModelProvider> = {}): ManagedModelProvider {
  return {
    id: 'openai-compatible',
    baseUrl: 'https://api.example.test/v1',
    envKey: 'CUSTOM_PROVIDER_TOKEN',
    apiBackend: 'responses',
    contextWindow: 128_000,
    ...overrides
  }
}

function model(overrides: Partial<ManagedCustomModel> = {}): ManagedCustomModel {
  return {
    id: 'custom-reasoner',
    upstreamModel: 'vendor/reasoner-v1',
    name: 'Custom Reasoner',
    providerId: 'openai-compatible',
    contextWindow: 128_000,
    supportsReasoningEffort: true,
    ...overrides
  }
}

function expectCode(operation: () => unknown, code: ManagedTomlError['code']): void {
  let thrown: unknown
  try {
    operation()
  } catch (error) {
    thrown = error
  }
  expect(thrown).toBeInstanceOf(ManagedTomlError)
  expect(thrown).toMatchObject({ code })
}
