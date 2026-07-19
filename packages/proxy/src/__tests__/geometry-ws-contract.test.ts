import type { IncomingMessage } from 'node:http'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { chromium, type Page } from 'playwright'
import WsClient, { type RawData, type WebSocket } from 'ws'
import { createFillLookupCache, resolveExistingFiles } from '../dom-actions.ts'
import {
  createActionRequestLedger,
  handleClientMessage,
  installDomObserver,
  startGeometryWebSocket,
  type GeometryWsHub,
} from '../geometry-ws.ts'

// Source modules intentionally use .js specifiers for ESM build output; map
// this dependency back to the live TypeScript source for the unit test.
vi.mock('../types.js', async () => await import('../types.ts'))
vi.mock('../dom-actions.js', async () => await import('../dom-actions.ts'))

describe('proxy WebSocket action contract', () => {
  it('applies typeText as one bounded proxy action', async () => {
    const sent: string[] = []
    const ws = { send: (value: string) => sent.push(value) } as unknown as WebSocket
    const type = vi.fn(async () => {})
    const page = { keyboard: { type } } as unknown as Page
    const onViewportOrInput = vi.fn()

    await handleClientMessage(
      async () => page,
      ws,
      JSON.stringify({
        type: 'typeText',
        text: 'one atomic request',
        requestId: 'atomic-type-1',
        actionTimeoutMs: 1_000,
      }),
      createFillLookupCache(),
      async () => {},
      onViewportOrInput,
      () => {},
      { actionRequestLedger: createActionRequestLedger() },
    )

    expect(type).toHaveBeenCalledOnce()
    expect(type).toHaveBeenCalledWith('one atomic request')
    expect(onViewportOrInput).toHaveBeenCalledWith('input', 'atomic-type-1')
    expect(sent).toEqual([])
  })

  it('expires queued actions after waits and before Playwright mutation', async () => {
    const sent: string[] = []
    const ws = { send: (value: string) => sent.push(value) } as unknown as WebSocket
    const setViewportSize = vi.fn(async () => {})
    const page = { setViewportSize } as unknown as Page
    let now = 100
    const performanceNow = vi.spyOn(performance, 'now').mockImplementation(() => now)

    try {
      await handleClientMessage(
        async () => {
          now = 101
          return page
        },
        ws,
        JSON.stringify({
          type: 'resize',
          width: 640,
          height: 480,
          requestId: 'expired-after-page-wait',
          actionTimeoutMs: 1,
        }),
        createFillLookupCache(),
        async () => {},
        () => {},
        () => {},
        { receivedAt: 100 },
      )
    } finally {
      performanceNow.mockRestore()
    }

    expect(setViewportSize).not.toHaveBeenCalled()
    expect(JSON.parse(sent[0]!)).toMatchObject({
      type: 'error',
      code: 'ACTION_EXPIRED',
      requestId: 'expired-after-page-wait',
    })
  })

  it('deduplicates semantic action payloads before expiry and rejects request-id conflicts', async () => {
    const sent: string[] = []
    const ws = { send: (value: string) => sent.push(value) } as unknown as WebSocket
    const waitForPage = vi.fn(async () => { throw new Error('must not acquire page') }) as unknown as () => Promise<Page>
    const onHandlerError = vi.fn()
    const ledger = createActionRequestLedger()
    const run = async (payload: Record<string, unknown>) => await handleClientMessage(
      waitForPage,
      ws,
      JSON.stringify(payload),
      createFillLookupCache(),
      async () => {},
      () => {},
      onHandlerError,
      { actionRequestLedger: ledger },
    )

    await run({
      type: 'resize',
      width: 640,
      height: 480,
      requestId: 'dedupe-resize',
      actionTimeoutMs: 0,
      protocolVersion: 1,
    })
    await run({
      actionTimeoutMs: 10_000,
      requestId: 'dedupe-resize',
      height: 480,
      width: 640,
      type: 'resize',
      protocolVersion: 2,
    })
    await run({
      type: 'resize',
      width: 641,
      height: 480,
      requestId: 'dedupe-resize',
      actionTimeoutMs: 10_000,
    })

    expect(waitForPage).not.toHaveBeenCalled()
    expect(onHandlerError).not.toHaveBeenCalled()
    expect(sent.map(value => JSON.parse(value))).toEqual([
      expect.objectContaining({ type: 'error', code: 'ACTION_EXPIRED', requestId: 'dedupe-resize' }),
      expect.objectContaining({ type: 'error', code: 'DUPLICATE_REQUEST', requestId: 'dedupe-resize' }),
      expect.objectContaining({ type: 'error', code: 'REQUEST_ID_CONFLICT', requestId: 'dedupe-resize' }),
    ])
  })

  it('never evicts an accepted request when the bounded ledger reaches capacity', () => {
    const ledger = createActionRequestLedger(1)
    const first = { type: 'resize', width: 1, height: 1 } as const
    const second = { type: 'resize', width: 2, height: 2 } as const

    expect(ledger.remember('first', first)).toBe('accepted')
    expect(ledger.remember('second', second)).toBe('capacity')
    ledger.complete('first')
    expect(ledger.remember('second', second)).toBe('capacity')
    expect(ledger.remember('first', first)).toBe('duplicate')
    expect(ledger.remember('first', second)).toBe('conflict')
  })

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

async function nextWireMessage(
  ws: WsClient,
  predicate: (message: Record<string, unknown>) => boolean,
  timeoutMs = 2_000,
): Promise<Record<string, unknown>> {
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error('timed out waiting for proxy wire message'))
    }, timeoutMs)
    const onMessage = (raw: RawData) => {
      const message = JSON.parse(String(raw)) as Record<string, unknown>
      if (!predicate(message)) return
      cleanup()
      resolve(message)
    }
    const cleanup = () => {
      clearTimeout(timeout)
      ws.off('message', onMessage)
    }
    ws.on('message', onMessage)
  })
}

describe('proxy action acknowledgement liveness', () => {
  it('keeps one idempotency ledger for the lifetime of a hub', async () => {
    const browser = await chromium.launch({ headless: true })
    const page = await browser.newPage({ viewport: { width: 640, height: 480 } })
    await page.setContent('<main>request ledger probe</main>')
    const setViewportSize = vi.spyOn(page, 'setViewportSize')
    let resolvePort!: (port: number) => void
    const portPromise = new Promise<number>(resolve => { resolvePort = resolve })
    const hub = startGeometryWebSocket({
      port: 0,
      authToken: AUTH_TOKEN,
      page,
      onListening: resolvePort,
    })
    let controller: WsClient | undefined

    try {
      controller = await openAuthorized(`ws://127.0.0.1:${await portPromise}`)
      const first = {
        type: 'resize',
        width: 700,
        height: 500,
        requestId: 'hub-resize-once',
        actionTimeoutMs: 10_000,
      }
      controller.send(JSON.stringify(first))
      await vi.waitFor(() => expect(setViewportSize).toHaveBeenCalledTimes(1))

      const duplicate = nextWireMessage(
        controller,
        message => message.type === 'error' && message.requestId === first.requestId,
      )
      controller.send(JSON.stringify({ ...first, actionTimeoutMs: 20_000 }))
      await expect(duplicate).resolves.toMatchObject({
        code: 'DUPLICATE_REQUEST',
        requestId: first.requestId,
      })

      const conflict = nextWireMessage(
        controller,
        message => message.type === 'error' && message.requestId === first.requestId,
      )
      controller.send(JSON.stringify({ ...first, width: 701 }))
      await expect(conflict).resolves.toMatchObject({
        code: 'REQUEST_ID_CONFLICT',
        requestId: first.requestId,
      })
      expect(setViewportSize).toHaveBeenCalledTimes(1)
    } finally {
      controller?.close()
      await hub.close()
      await browser.close()
    }
  })

  it('flushes a fresh snapshot for a pending action despite continuous DOM mutations', async () => {
    const browser = await chromium.launch({ headless: true })
    const page = await browser.newPage({ viewport: { width: 640, height: 480 } })
    await page.setContent('<main><input aria-label="Typing target"><span id="tick">0</span></main>')

    let resolvePort!: (port: number) => void
    const portPromise = new Promise<number>(resolve => { resolvePort = resolve })
    const hub = startGeometryWebSocket({
      port: 0,
      authToken: AUTH_TOKEN,
      page,
      // Deliberately longer than the action-ack bound. The regular trailing
      // debounce must not become the minimum wait for a correlated ack.
      debounceMs: 1_000,
      onListening: resolvePort,
    })
    let controller: WsClient | undefined

    try {
      await installDomObserver(page, hub.scheduleExtract)
      const port = await portPromise
      controller = await openAuthorized(`ws://127.0.0.1:${port}`)

      const requestId = 'continuous-mutation-key'
      const ackPromise = new Promise<Record<string, unknown>>((resolve, reject) => {
        const timeout = setTimeout(() => {
          cleanup()
          reject(new Error('correlated acknowledgement was starved by continuous mutations'))
        }, 1_500)
        const onMessage = (raw: RawData) => {
          const message = JSON.parse(String(raw)) as Record<string, unknown>
          if (message.type !== 'ack' || message.requestId !== requestId) return
          cleanup()
          resolve(message)
        }
        const cleanup = () => {
          clearTimeout(timeout)
          controller?.off('message', onMessage)
        }
        controller!.on('message', onMessage)
      })

      await page.evaluate(() => {
        const state = window as unknown as { __geometraMutationTimer?: number }
        let tick = 0
        state.__geometraMutationTimer = window.setInterval(() => {
          document.getElementById('tick')!.textContent = String(++tick)
        }, 5)
      })

      // Mutation-only traffic remains trailing-edge debounced; the bounded
      // timer exists solely to make a pending action acknowledgement live.
      await new Promise(resolve => setTimeout(resolve, 320))
      expect(hub.getTrace().extractCount).toBe(0)

      const startedAt = Date.now()
      controller.send(JSON.stringify({
        type: 'key',
        eventType: 'onKeyDown',
        key: 'a',
        code: 'KeyA',
        shiftKey: false,
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        requestId,
        protocolVersion: 2,
        geometryProtocolVersion: 1,
        proxyActionProtocolVersion: 2,
      }))

      await expect(ackPromise).resolves.toMatchObject({
        type: 'ack',
        requestId,
        protocolCapabilities: {
          requestScopedAcks: true,
          actionDeadlines: true,
          idempotentRequestIds: true,
        },
      })
      expect(Date.now() - startedAt).toBeLessThan(900)

      const resizeRequestId = 'correlated-resize'
      const resizeAck = nextWireMessage(
        controller,
        message => message.type === 'ack' && message.requestId === resizeRequestId,
      )
      controller.send(JSON.stringify({
        type: 'resize',
        width: 600,
        height: 420,
        requestId: resizeRequestId,
        protocolVersion: 2,
        geometryProtocolVersion: 1,
        proxyActionProtocolVersion: 2,
      }))
      await expect(resizeAck).resolves.toMatchObject({
        type: 'ack',
        requestId: resizeRequestId,
      })
    } finally {
      await page.evaluate(() => {
        const state = window as unknown as { __geometraMutationTimer?: number }
        if (state.__geometraMutationTimer !== undefined) {
          clearInterval(state.__geometraMutationTimer)
        }
      }).catch(() => {})
      controller?.close()
      await hub.close()
      await browser.close()
    }
  })
})

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
