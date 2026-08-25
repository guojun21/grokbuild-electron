import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { AppSnapshot } from '../../src/shared/models'
import { canonicalizeRpcSequence } from '../../src/shared/qa/canonicalState'

test('uses only CLI-advertised model, mode, and context capabilities', async () => {
  const root = await mkdtemp(join(tmpdir(), 'grokbuild-capability-e2e-'))
  const workspace = join(root, 'qa-workspace')
  const transcriptPath = join(root, 'rpc.ndjson')
  await mkdir(workspace)
  const app = await electron.launch({
    args: ['.'],
    cwd: resolve('.'),
    env: {
      ...process.env,
      GROK_CLI_PATH: resolve('qa/mock-grok.mjs'),
      GROKBUILD_USER_DATA_DIR: join(root, 'profile'),
      GROKBUILD_E2E_PROJECT_PATH: workspace,
      GROKBUILD_E2E: '1',
      GROKBUILD_MOCK_PROFILE: 'capability-truth',
      GROKBUILD_MOCK_SCENARIO: resolve('qa/scenarios/p0/capability-truth.json'),
      GROKBUILD_MOCK_TRANSCRIPT: transcriptPath,
      TZ: 'UTC',
      LANG: 'en_US.UTF-8'
    }
  })

  try {
    const page = await app.firstWindow()
    await expect(page.getByTestId('app-shell')).toBeVisible()
    await page.getByRole('button', { name: 'New chat' }).last().click()
    const model = page.getByLabel('Model')
    await expect(model).toBeDisabled()
    await expect(model).toHaveAttribute(
      'title',
      'Model options become available after Grok connects.'
    )
    await expect(model).toHaveValue('grok-4.6')
    await expect(model.locator('option')).toHaveText(['grok-4.6'])
    // The composer exposes no mode picker: GrokBuild pins the CLI to `yolo`.
    await expect(page.getByLabel('Agent mode')).toHaveCount(0)
    await page.getByTestId('prompt-input').fill('Probe strict capabilities')
    await page.getByTestId('send-prompt').click()
    await expect(page.getByText('CAPABILITY_TRUTH_OK')).toBeVisible()

    await expect(model).toBeEnabled()
    await expect(model).toHaveValue('qa-solo-131k')
    await expect(model.locator('option')).toHaveCount(1)
    await expect(model.locator('option')).toHaveText(['QA Solo 131K'])

    await expect(page.getByLabel('Agent mode')).toHaveCount(0)

    const contextMeter = page.getByRole('button', { name: 'Context usage' })
    await expect(contextMeter).toHaveAttribute(
      'title',
      '12,345 / 131,072 tokens used'
    )
    await expect(contextMeter).toHaveText('12K/131K')

    const snapshot = await page.evaluate(() =>
      (globalThis as unknown as { grokbuild: { bootstrap: () => Promise<unknown> } })
        .grokbuild.bootstrap()
    ) as AppSnapshot
    const session = snapshot.sessions.find((item) => item.id === snapshot.selectedSessionId)
    expect(session).toMatchObject({
      model: 'qa-solo-131k',
      mode: 'ask',
      contextUsed: 12_345,
      contextLimit: 131_072,
      availableModels: [
        { id: 'qa-solo-131k', name: 'QA Solo 131K', contextLimit: 131_072 }
      ],
      availableModes: [{ id: 'ask', name: 'Ask only' }]
    })

    const actualRpc = canonicalizeRpcSequence(await readFile(transcriptPath, 'utf8'))
    const expectedRpc = JSON.parse(
      await readFile(resolve('qa/baselines/electron/capability-truth.rpc.json'), 'utf8')
    )
    expect(actualRpc).toEqual(expectedRpc)
  } finally {
    await app.close()
    await rm(root, { recursive: true, force: true })
  }
})
