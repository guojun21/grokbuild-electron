import { chmod, mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AttachmentBroker,
  AttachmentBrokerError,
  type AttachmentBrokerOptions
} from '../../src/main/attachments/AttachmentBroker'

const temporaryDirectories: string[] = []
const brokers: AttachmentBroker[] = []
const SECRET = 'ordinary-file-content-must-not-be-read-5f98'

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(brokers.splice(0).map((broker) => broker.dispose()))
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ))
})

describe('AttachmentBroker', () => {
  it('builds Swift-parity relative/basename notes without returning paths or file content', async () => {
    const root = await temporaryProject()
    const source = join(root.project, 'src', 'main.ts')
    const outside = join(root.parent, 'outside.txt')
    await mkdir(join(root.project, 'src'))
    await writeFile(source, SECRET)
    await writeFile(outside, `${SECRET}-outside`)
    await chmod(source, 0o000)
    await chmod(outside, 0o000)
    const broker = makeBroker()

    const summary = await broker.stage({
      sessionId: 'session-a',
      projectRoot: root.project,
      paths: [source, outside]
    })

    expect(summary.attachments).toEqual([
      { kind: 'file', displayName: 'main.ts' },
      { kind: 'file', displayName: 'outside.txt' }
    ])
    expect(summary.token).toMatch(/^[A-Za-z0-9_-]{20,128}$/)
    expect(JSON.stringify(summary)).not.toContain(root.parent)
    expect(JSON.stringify(summary)).not.toContain(SECRET)

    await expect(broker.consume('session-a', summary.token)).resolves.toEqual({
      blocks: [{
        type: 'text',
        text: 'Attached files:\n- src/main.ts\n- outside.txt'
      }]
    })
  })

  it('consumes PNG, JPEG, GIF, and WebP once as bounded ACP image blocks', async () => {
    const root = await temporaryProject()
    const images = [
      ['one.PNG', pngBytes()],
      ['two.jpeg', Buffer.from([0xff, 0xd8, 0xff, 0x01])],
      ['three.gif', Buffer.from('GIF89a payload')],
      ['four.webp', Buffer.from('RIFFxxxxWEBPpayload')]
    ] as const
    const paths: string[] = []
    for (const [name, bytes] of images) {
      const path = join(root.project, name)
      await writeFile(path, bytes)
      paths.push(path)
    }
    const broker = makeBroker()

    const summary = await broker.stage({
      sessionId: 'vision-session',
      projectRoot: root.project,
      paths
    })

    expect(summary.attachments).toEqual(images.map(([name]) => ({
      kind: 'image', displayName: name
    })))
    const serializedSummary = JSON.stringify(summary)
    expect(serializedSummary).not.toContain(root.parent)
    for (const [, bytes] of images) expect(serializedSummary).not.toContain(bytes.toString('base64'))

    await expect(broker.consume('vision-session', summary.token)).resolves.toEqual({
      blocks: [
        { type: 'text', text: 'Attached images: one.PNG, two.jpeg, three.gif, four.webp' },
        { type: 'image', data: images[0][1].toString('base64'), mimeType: 'image/png' },
        { type: 'image', data: images[1][1].toString('base64'), mimeType: 'image/jpeg' },
        { type: 'image', data: images[2][1].toString('base64'), mimeType: 'image/gif' },
        { type: 'image', data: images[3][1].toString('base64'), mimeType: 'image/webp' }
      ]
    })
    await expect(broker.consume('vision-session', summary.token)).rejects.toMatchObject({
      code: 'invalid-token',
      message: 'The attachment selection is no longer available.'
    })
  })

  it('binds opaque tokens to one session without burning them on a cross-session attempt', async () => {
    const root = await temporaryProject()
    const path = join(root.project, 'README.md')
    await writeFile(path, 'private')
    const broker = makeBroker()
    const summary = await broker.stage({
      sessionId: 'owner-session', projectRoot: root.project, paths: [path]
    })

    await expect(broker.consume('other-session', summary.token)).rejects.toMatchObject({
      code: 'invalid-token'
    })
    await expect(broker.consume('owner-session', summary.token)).resolves.toEqual({
      blocks: [{ type: 'text', text: 'Attached file: README.md' }]
    })
  })

  it('expires, cancels, clears, and disposes pending leases', async () => {
    vi.useFakeTimers()
    const root = await temporaryProject()
    const path = join(root.project, 'asset.png')
    await writeFile(path, pngBytes())
    const broker = makeBroker({ ttlMs: 20 })
    const expired = await broker.stage({
      sessionId: 'session-expired', projectRoot: root.project, paths: [path]
    })
    await vi.advanceTimersByTimeAsync(21)
    await expect(broker.consume('session-expired', expired.token)).rejects.toMatchObject({
      code: 'invalid-token'
    })

    const cancelled = await broker.stage({
      sessionId: 'session-cancel', projectRoot: root.project, paths: [path]
    })
    await expect(broker.cancel('wrong-session', cancelled.token)).resolves.toBe(false)
    await expect(broker.cancel('session-cancel', cancelled.token)).resolves.toBe(true)
    await expect(broker.cancel('session-cancel', cancelled.token)).resolves.toBe(false)

    const first = await broker.stage({
      sessionId: 'session-clear', projectRoot: root.project, paths: [path]
    })
    const secondPath = join(root.project, 'second.png')
    await writeFile(secondPath, pngBytes())
    const second = await broker.stage({
      sessionId: 'session-clear', projectRoot: root.project, paths: [secondPath]
    })
    await expect(broker.clearSession('session-clear')).resolves.toBe(2)
    await expect(broker.consume('session-clear', first.token)).rejects.toMatchObject({ code: 'invalid-token' })
    await expect(broker.consume('session-clear', second.token)).rejects.toMatchObject({ code: 'invalid-token' })
  })

  it('enforces selection, per-image, and aggregate image limits before bytes escape', async () => {
    const root = await temporaryProject()
    const paths = await Promise.all(['a.txt', 'b.txt', 'c.txt'].map(async (name) => {
      const path = join(root.project, name)
      await writeFile(path, name)
      return path
    }))
    const countBroker = makeBroker({ limits: { count: 2 } })
    await expect(countBroker.stage({
      sessionId: 'limit-session', projectRoot: root.project, paths
    })).rejects.toMatchObject({ code: 'too-many-attachments' })

    const largeImage = join(root.project, 'large.png')
    await writeFile(largeImage, Buffer.concat([pngBytes(), Buffer.from([0x01])]))
    const perImageBroker = makeBroker({ limits: { imageBytes: 8 } })
    await expect(perImageBroker.stage({
      sessionId: 'limit-session', projectRoot: root.project, paths: [largeImage]
    })).rejects.toMatchObject({ code: 'image-too-large' })

    const imageA = join(root.project, 'a.png')
    const imageB = join(root.project, 'b.png')
    const nineBytes = Buffer.concat([pngBytes(), Buffer.from([0x01])])
    await writeFile(imageA, nineBytes)
    await writeFile(imageB, nineBytes)
    const totalBroker = makeBroker({ limits: { imageBytes: 16, totalImageBytes: 17 } })
    await expect(totalBroker.stage({
      sessionId: 'limit-session', projectRoot: root.project, paths: [imageA, imageB]
    })).rejects.toMatchObject({ code: 'total-too-large' })
  })

  it('resolves symlinks and rejects an image changed in place between stage and consume', async () => {
    const root = await temporaryProject()
    const target = join(root.project, 'target.png')
    const link = join(root.project, 'alias.png')
    await writeFile(target, pngBytes())
    await symlink(target, link)
    const broker = makeBroker()
    const summary = await broker.stage({
      sessionId: 'toctou-session', projectRoot: root.project, paths: [link]
    })
    expect(summary.attachments).toEqual([{ kind: 'image', displayName: 'alias.png' }])

    await writeFile(target, Buffer.from('RIFFxxxxWEBPchanged'))
    await expect(broker.consume('toctou-session', summary.token)).rejects.toMatchObject({
      code: 'attachment-unavailable',
      message: 'A selected attachment is unavailable.'
    })
  })

  it('keeps filesystem, image, and diagnostic details out of public errors', async () => {
    const root = await temporaryProject()
    const missing = join(root.project, `missing-${SECRET}.txt`)
    const broker = makeBroker()

    const missingError = await rejection(broker.stage({
      sessionId: 'safe-error-session', projectRoot: root.project, paths: [missing]
    }))
    expect(missingError).toBeInstanceOf(AttachmentBrokerError)
    expect(missingError).toMatchObject({
      code: 'attachment-unavailable',
      message: 'A selected attachment is unavailable.'
    })
    expect(serializeError(missingError)).not.toContain(root.parent)
    expect(serializeError(missingError)).not.toContain(SECRET)

    const fakeImage = join(root.project, `fake-${SECRET}.png`)
    await writeFile(fakeImage, SECRET)
    const summary = await broker.stage({
      sessionId: 'safe-error-session', projectRoot: root.project, paths: [fakeImage]
    })
    const imageError = await rejection(broker.consume('safe-error-session', summary.token))
    expect(imageError).toMatchObject({
      code: 'invalid-image',
      message: 'A selected image is not a supported image file.'
    })
    expect(serializeError(imageError)).not.toContain(root.parent)
    expect(serializeError(imageError)).not.toContain(SECRET)
    expect(serializeError(imageError)).not.toContain(Buffer.from(SECRET).toString('base64'))
  })

  it('rejects path replacement after staging instead of reading replacement bytes', async () => {
    const root = await temporaryProject()
    const path = join(root.project, 'stable.png')
    const moved = join(root.project, 'moved.png')
    const original = pngBytes()
    await writeFile(path, original)
    const broker = makeBroker()
    const summary = await broker.stage({
      sessionId: 'stable-session', projectRoot: root.project, paths: [path]
    })

    await rename(path, moved)
    await writeFile(path, Buffer.from('GIF89areplacement'))

    await expect(broker.consume('stable-session', summary.token)).rejects.toMatchObject({
      code: 'attachment-unavailable',
      message: 'A selected attachment is unavailable.'
    })
  })
})

function makeBroker(options: AttachmentBrokerOptions = {}): AttachmentBroker {
  let counter = 0
  const broker = new AttachmentBroker({
    ...options,
    tokenFactory: () => `opaque_attachment_token_${String(counter += 1).padStart(4, '0')}`
  })
  brokers.push(broker)
  return broker
}

async function temporaryProject(): Promise<{ parent: string; project: string }> {
  const parent = await mkdtemp(join(tmpdir(), 'grokbuild-attachment-test-'))
  temporaryDirectories.push(parent)
  const project = join(parent, 'project')
  await mkdir(project)
  return { parent, project }
}

function pngBytes(): Buffer {
  return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
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
  if (error instanceof Error) return `${String(error)} ${JSON.stringify(error)} ${error.stack ?? ''}`
  return String(error)
}
