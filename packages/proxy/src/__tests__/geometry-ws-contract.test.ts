import type { IncomingMessage } from 'node:http'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Page } from 'playwright'
import WsClient, { type WebSocket } from 'ws'
import { createFillLookupCache, resolveExistingFiles } from '../dom-actions.ts'
import {
  handleClientMessage,
  startGeometryWebSocket,
  type GeometryWsHub,
} from '../geometry-ws.ts'

// Source modules intentionally use .js specifiers for ESM build output; map
// this dependency back to the live TypeScript source for the unit test.
vi.mock('../types.js', async () => await import('../types.ts'))
vi.mock('../dom-actions.js', async () => await import('../dom-actions.ts'))

describe('proxy WebSocket action contract', () => {
  it('returns a correlated error before acquiring a page for a malformed action', async () => {
    const sent: string[] = []
    const ws = { send: (value: string) => sent.push(value) } as unknown as WebSocket
    const waitForPage = vi.fn(async () => { throw new Error('must not acquire page') }) as unknown as () => Promise<Page>

    await handleClientMessage(
      waitForPage,
      ws,
      JSON.stringify({ type: 'setChecked', requestId: 'action-17', checked: true }),
      createFillLookupCache(),
      async () => {},
      () => {},
      () => {},
    )

    expect(waitForPage).not.toHaveBeenCalled()
    expect(JSON.parse(sent[0]!)).toMatchObject({
      type: 'error',
      requestId: 'action-17',
      message: 'Invalid setChecked message: label must be a trimmed, non-empty string',
    })
  })

  it('rejects a newer explicit proxy-action protocol before acquiring a page', async () => {
    const sent: string[] = []
    const ws = { send: (value: string) => sent.push(value) } as unknown as WebSocket
    const waitForPage = vi.fn(async () => { throw new Error('must not acquire page') }) as unknown as () => Promise<Page>

    await handleClientMessage(
      waitForPage,
      ws,
      JSON.stringify({
        type: 'resize',
        width: 100,
        height: 100,
        protocolVersion: 1,
        geometryProtocolVersion: 1,
        proxyActionProtocolVersion: 999,
      }),
      createFillLookupCache(),
      async () => {},
      () => {},
      () => {},
    )

    expect(waitForPage).not.toHaveBeenCalled()
    expect(JSON.parse(sent[0]!)).toMatchObject({
      type: 'error',
      geometryProtocolVersion: 1,
      proxyActionProtocolVersion: 2,
      protocolCapabilities: { transport: 'proxy' },
      message: 'Client proxy-action protocol 999 is newer than proxy action protocol 2',
    })
  })
})

const AUTH_TOKEN = 'geometra-test-capability-token-000000000000'

async function rejectedStatus(
  url: string,
  options?: ConstructorParameters<typeof WsClient>[1],
): Promise<number | undefined> {
  return await new Promise((resolve, reject) => {
    const ws = new WsClient(url, options)
    ws.once('unexpected-response', (_request, response: IncomingMessage) => {
      response.resume()
      resolve(response.statusCode)
    })
    ws.once('open', () => {
      ws.close()
      reject(new Error('expected WebSocket upgrade to be rejected'))
    })
    ws.once('error', () => {
      // `unexpected-response` is authoritative for an HTTP rejection. Some
      // ws versions also emit error; leave resolution to that first event.
    })
  })
}

async function openAuthorized(url: string): Promise<WsClient> {
  return await new Promise((resolve, reject) => {
    const ws = new WsClient(url, {
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
    })
    ws.once('open', () => resolve(ws))
    ws.once('error', reject)
  })
}

describe('proxy WebSocket security boundary', () => {
  let hub: GeometryWsHub | undefined

  afterEach(async () => {
    await hub?.close()
    hub = undefined
  })

  it('binds loopback, requires a bearer capability, rejects browser origins, and permits one controller', async () => {
    let resolvePort!: (port: number) => void
    const portPromise = new Promise<number>(resolve => { resolvePort = resolve })
    hub = startGeometryWebSocket({
      port: 0,
      authToken: AUTH_TOKEN,
      page: new Promise<Page>(() => {}),
      onListening: resolvePort,
    })
    const port = await portPromise
    const url = `ws://127.0.0.1:${port}`

    expect(hub.host).toBe('127.0.0.1')
    expect(hub.authToken).toBe(AUTH_TOKEN)
    await expect(rejectedStatus(url)).resolves.toBe(401)
    await expect(rejectedStatus(url, {
      headers: {
        Authorization: `Bearer ${AUTH_TOKEN}`,
        Origin: 'https://attacker.example',
      },
    })).resolves.toBe(403)

    const controller = await openAuthorized(url)
    await expect(rejectedStatus(url, {
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
    })).resolves.toBe(409)

    await new Promise<void>(resolve => {
      controller.once('close', () => resolve())
      controller.close()
    })
    const replacement = await openAuthorized(url)
    replacement.close()
  })
})

describe('proxy upload file policy', () => {
  it('requires approved roots and rejects sibling-prefix and symlink escapes', async () => {
    const base = await mkdtemp(join(tmpdir(), 'geometra-file-policy-'))
    const allowedRoot = join(base, 'approved')
    const siblingRoot = join(base, 'approved-sibling')
    await mkdir(allowedRoot)
    await mkdir(siblingRoot)
    const approvedFile = join(allowedRoot, 'resume.pdf')
    const outsideFile = join(siblingRoot, 'secret.txt')
    const escapeLink = join(allowedRoot, 'linked-secret.txt')
    await writeFile(approvedFile, 'resume')
    await writeFile(outsideFile, 'secret')
    await symlink(outsideFile, escapeLink)

    try {
      expect(() => resolveExistingFiles([approvedFile])).toThrow('uploads are disabled')
      expect(resolveExistingFiles([approvedFile], [allowedRoot])).toEqual([await realpath(approvedFile)])
      expect(() => resolveExistingFiles([outsideFile], [allowedRoot])).toThrow(
        'outside configured upload roots',
      )
      expect(() => resolveExistingFiles([escapeLink], [allowedRoot])).toThrow(
        'outside configured upload roots',
      )
    } finally {
      await rm(base, { recursive: true, force: true })
    }
  })
})
