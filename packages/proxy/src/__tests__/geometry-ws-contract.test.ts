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

function wireMessageHasWidth(message: Record<string, unknown>, expected: number): boolean {
  if (message.type === 'patch' && Array.isArray(message.patches)) {
    return message.patches.some(patch => {
      if (typeof patch !== 'object' || patch === null) return false
      const width = (patch as { width?: unknown }).width
      return typeof width === 'number' && Math.abs(width - expected) < 1
    })
  }
  if (message.type !== 'frame') return false
  const visit = (layout: unknown): boolean => {
    if (typeof layout !== 'object' || layout === null) return false
    const candidate = layout as { width?: unknown; children?: unknown }
    if (typeof candidate.width === 'number' && Math.abs(candidate.width - expected) < 1) return true
    return Array.isArray(candidate.children) && candidate.children.some(visit)
  }
  return visit(message.layout)
}

function wireMessageHasX(message: Record<string, unknown>, expected: number): boolean {
  if (message.type === 'patch' && Array.isArray(message.patches)) {
    return message.patches.some(patch => {
      if (typeof patch !== 'object' || patch === null) return false
      const x = (patch as { x?: unknown }).x
      return typeof x === 'number' && Math.abs(x - expected) < 1
    })
  }
  if (message.type !== 'frame') return false
  const visit = (layout: unknown): boolean => {
    if (typeof layout !== 'object' || layout === null) return false
    const candidate = layout as { x?: unknown; children?: unknown }
    if (typeof candidate.x === 'number' && Math.abs(candidate.x - expected) < 1) return true
    return Array.isArray(candidate.children) && candidate.children.some(visit)
  }
  return visit(message.layout)
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
          verifiedFileUploads: true,
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

describe('proxy geometry freshness instrumentation', () => {
  it('coalesces sustained mutation notifications before they reach the Playwright bridge', async () => {
    const browser = await chromium.launch({ headless: true })
    const page = await browser.newPage()
    await page.setContent('<main><span id="tick">0</span></main>')
    const scheduleExtract = vi.fn()

    try {
      await installDomObserver(page, scheduleExtract)
      // Let the one bounded document-font settle window finish so only the
      // mutation burst below contributes to the bridge-call count.
      await new Promise(resolve => setTimeout(resolve, 650))
      scheduleExtract.mockClear()

      const mutationCount = await page.evaluate(async () => {
        let tick = 0
        const interval = window.setInterval(() => {
          document.getElementById('tick')!.textContent = String(++tick)
        }, 1)
        await new Promise(resolve => setTimeout(resolve, 250))
        clearInterval(interval)
        return tick
      })
      await new Promise(resolve => setTimeout(resolve, 100))

      expect(mutationCount).toBeGreaterThan(25)
      expect(scheduleExtract).toHaveBeenCalled()
      // The page-side bridge admits at most one call per 25ms plus one final
      // trailing call; hundreds of observer callbacks must not become a
      // protocol-message flood.
      expect(scheduleExtract.mock.calls.length).toBeLessThanOrEqual(15)

      const afterBurst = scheduleExtract.mock.calls.length
      await page.evaluate(() => {
        document.getElementById('tick')!.textContent = 'final mutation'
      })
      await vi.waitFor(() => {
        expect(scheduleExtract.mock.calls.length).toBeGreaterThan(afterBurst)
      })

      scheduleExtract.mockClear()
      await page.evaluate(() => {
        document.dispatchEvent(new Event('transitionstart'))
      })
      await vi.waitFor(
        () => expect(scheduleExtract).toHaveBeenCalledWith(true),
        { timeout: 1_500 },
      )
    } finally {
      await browser.close()
    }
  })

  it('refreshes an AX-only closed-root label and preserves its delayed retry across flush', async () => {
    const browser = await chromium.launch({ headless: true })
    const page = await browser.newPage({ viewport: { width: 640, height: 480 } })
    await page.setContent(`
      <button>Healthy A</button><button>Healthy B</button>
      <div id="late-host" style="position:relative;width:1px;height:1px"></div>
    `)
    await page.evaluate(() => {
      const root = document.getElementById('late-host')!.attachShadow({ mode: 'closed' })
      root.innerHTML = `
        <style>button { position:absolute;left:260px;top:100px;width:170px;height:42px }</style>
        <button aria-label="Delete account">Delete account</button>
      `
      ;(globalThis as unknown as { __geometraLateClosedAction: HTMLButtonElement })
        .__geometraLateClosedAction = root.querySelector('button')!
    })
    let resolvePort!: (port: number) => void
    const portPromise = new Promise<number>(resolve => { resolvePort = resolve })
    const hub = startGeometryWebSocket({
      port: 0,
      authToken: AUTH_TOKEN,
      page,
      debounceMs: 20,
      onListening: resolvePort,
    })
    let controller: WsClient | undefined
    const frameHasLabel = (message: Record<string, unknown>, label: string): boolean => {
      if (message.type !== 'frame') return false
      const visit = (node: unknown): boolean => {
        if (!node || typeof node !== 'object') return false
        const candidate = node as {
          semantic?: { ariaLabel?: unknown }
          children?: unknown
        }
        if (candidate.semantic?.ariaLabel === label) return true
        return Array.isArray(candidate.children) && candidate.children.some(visit)
      }
      return visit(message.tree)
    }

    try {
      // Install after the root exists: the page MutationObserver cannot pierce
      // it, so this exercises the trusted host CDP revision signal.
      await installDomObserver(page, hub.scheduleExtract)
      controller = await openAuthorized(`ws://127.0.0.1:${await portPromise}`)
      const initialAxFrame = nextWireMessage(
        controller,
        message => frameHasLabel(message, 'Delete account'),
        5_000,
      )
      await hub.flushExtract()
      await initialAxFrame

      const staleRemoval = nextWireMessage(
        controller,
        message => message.type === 'frame' && !frameHasLabel(message, 'Delete account'),
        3_000,
      )
      await page.evaluate(() => {
        const action = (globalThis as unknown as { __geometraLateClosedAction: HTMLButtonElement })
          .__geometraLateClosedAction
        action.setAttribute('aria-label', 'Submit')
        action.textContent = 'Submit'
      })
      await staleRemoval

      // A manual flush before the 10s cadence must not cancel the host-owned
      // one-shot retry that will discover the fresh AX-only label.
      await hub.flushExtract()
      const refreshedAxFrame = nextWireMessage(
        controller,
        message => frameHasLabel(message, 'Submit'),
        15_000,
      )
      await refreshedAxFrame
    } finally {
      controller?.close()
      await hub.close()
      await browser.close()
    }
  })

  it('captures closed shadow roots before application code in every new document', async () => {
    const browser = await chromium.launch({ headless: true })
    const page = await browser.newPage()
    const scheduleExtract = vi.fn()

    try {
      await installDomObserver(page, scheduleExtract)
      const navigateWithClosedRoot = async (label: string) => {
        const html = `<!doctype html><html><body><div id="host"></div><script>
          const host = document.getElementById('host');
          const root = host.attachShadow({ mode: 'closed' });
          const button = document.createElement('button');
          button.textContent = ${JSON.stringify(label)};
          root.append(button);
        </script></body></html>`
        await page.goto(`data:text/html,${encodeURIComponent(html)}`, { waitUntil: 'domcontentloaded' })
        return await page.evaluate(() => {
          const host = document.getElementById('host')!
          const registry = (globalThis as unknown as Record<symbol, unknown>)[
            Symbol.for('geometra.closedShadowRoots')
          ]
          const root = registry instanceof WeakMap
            ? registry.get(host) as ShadowRoot | undefined
            : undefined
          return {
            registryIsWeakMap: registry instanceof WeakMap,
            publicRootIsClosed: host.shadowRoot === null,
            text: root?.querySelector('button')?.textContent,
            hostAttributes: host.getAttributeNames(),
            attachShadowName: Element.prototype.attachShadow.name,
            attachShadowLength: Element.prototype.attachShadow.length,
          }
        })
      }

      await expect(navigateWithClosedRoot('first document')).resolves.toEqual({
        registryIsWeakMap: true,
        publicRootIsClosed: true,
        text: 'first document',
        hostAttributes: ['id'],
        attachShadowName: 'attachShadow',
        attachShadowLength: 1,
      })
      await expect(navigateWithClosedRoot('second document')).resolves.toEqual({
        registryIsWeakMap: true,
        publicRootIsClosed: true,
        text: 'second document',
        hostAttributes: ['id'],
        attachShadowName: 'attachShadow',
        attachShadowLength: 1,
      })
      expect(scheduleExtract).toHaveBeenCalled()
    } finally {
      await browser.close()
    }
  })

  it('keeps freshness signals alive when the closed-root registry symbol is locked by a collision', async () => {
    const browser = await chromium.launch({ headless: true })
    const page = await browser.newPage()
    const scheduleExtract = vi.fn()

    try {
      await page.evaluate(() => {
        Object.defineProperty(globalThis, Symbol.for('geometra.closedShadowRoots'), {
          value: 'preexisting-non-registry',
          configurable: false,
          enumerable: false,
          writable: false,
        })
      })
      await installDomObserver(page, scheduleExtract)
      const result = await page.evaluate(() => {
        const host = document.createElement('div')
        const root = host.attachShadow({ mode: 'closed' })
        root.innerHTML = '<button>still native</button>'
        document.body.append(host)
        document.body.dataset.freshnessProbe = 'mutated'
        return {
          collision: (globalThis as unknown as Record<symbol, unknown>)[
            Symbol.for('geometra.closedShadowRoots')
          ],
          closed: host.shadowRoot === null,
          buttonText: root.querySelector('button')?.textContent,
        }
      })

      expect(result).toEqual({
        collision: 'preexisting-non-registry',
        closed: true,
        buttonText: 'still native',
      })
      await vi.waitFor(() => expect(scheduleExtract).toHaveBeenCalled())
    } finally {
      await browser.close()
    }
  })

  it('ignores a page-preseeded legacy freshness sentinel', async () => {
    const browser = await chromium.launch({ headless: true })
    const page = await browser.newPage()
    const scheduleExtract = vi.fn()

    try {
      await page.setContent('<main id="target">Hostile sentinel probe</main>')
      await page.evaluate(() => {
        Object.defineProperty(globalThis, Symbol.for('geometra.proxyFreshnessInstalled'), {
          value: true,
          configurable: false,
          enumerable: false,
          writable: false,
        })
        Object.defineProperty(globalThis, '__geometraProxyNotify', {
          value: () => undefined,
          configurable: false,
          enumerable: false,
          writable: false,
        })
      })

      await installDomObserver(page, scheduleExtract)
      await new Promise(resolve => setTimeout(resolve, 50))
      scheduleExtract.mockClear()
      await page.evaluate(() => {
        document.getElementById('target')!.setAttribute('data-updated', 'true')
      })

      await vi.waitFor(() => expect(scheduleExtract).toHaveBeenCalled())
    } finally {
      await browser.close()
    }
  })

  it('rate-limits direct immediate extraction hints from untrusted page code', async () => {
    const browser = await chromium.launch({ headless: true })
    const page = await browser.newPage({ viewport: { width: 640, height: 480 } })
    await page.setContent('<main><button>Bridge target</button></main>')
    const hub = startGeometryWebSocket({
      port: 0,
      authToken: AUTH_TOKEN,
      page,
      debounceMs: 25,
    })

    try {
      await installDomObserver(page, hub.scheduleExtract)
      await new Promise(resolve => setTimeout(resolve, 650))
      await hub.flushExtract()
      const baseline = hub.getTrace().extractCount

      await page.evaluate(() => {
        const globals = globalThis as unknown as Record<string, unknown>
        const bindingName = Object.getOwnPropertyNames(globalThis)
          .find(name => name.startsWith('__geometraProxyNotify_'))
        const notify = bindingName
          ? globals[bindingName] as ((urgency?: 'settled') => Promise<void>) | undefined
          : undefined
        for (let index = 0; index < 200; index++) void notify?.('settled')
      })

      await vi.waitFor(
        () => expect(hub.getTrace().extractCount - baseline).toBeGreaterThan(0),
        { timeout: 5_000 },
      )
      // Let any single coalesced post-completion refresh become eligible. The
      // assertion remains stable on loaded CI hosts without weakening the
      // hard upper bound on a finite untrusted hint burst.
      await new Promise(resolve => setTimeout(resolve, 350))

      const forcedExtracts = hub.getTrace().extractCount - baseline
      expect(forcedExtracts).toBeLessThanOrEqual(2)
    } finally {
      await hub.close()
      await browser.close()
    }
  })

  it('keeps a post-completion cooldown under sustained immediate page spam', async () => {
    const browser = await chromium.launch({ headless: true })
    const page = await browser.newPage({ viewport: { width: 640, height: 480 } })
    await page.setContent('<main><button>Sustained bridge target</button></main>')
    let releaseBeforeInput!: () => void
    const beforeInput = new Promise<void>(resolve => { releaseBeforeInput = resolve })
    const hub = startGeometryWebSocket({
      port: 0,
      authToken: AUTH_TOKEN,
      page,
      debounceMs: 25,
      beforeInput,
    })

    try {
      await installDomObserver(page, hub.scheduleExtract)
      await page.evaluate(() => {
        const globals = globalThis as unknown as Record<string, unknown>
        const bindingName = Object.getOwnPropertyNames(globalThis)
          .find(name => name.startsWith('__geometraProxyNotify_'))
        const notify = bindingName
          ? globals[bindingName] as ((urgency?: 'settled') => Promise<void>) | undefined
          : undefined
        const state = globalThis as unknown as { __geometraImmediateSpam?: number }
        state.__geometraImmediateSpam = window.setInterval(() => void notify?.('settled'), 5)
      })
      await new Promise(resolve => setTimeout(resolve, 350))
      expect(hub.getTrace().extractCount).toBe(0)

      releaseBeforeInput()
      await vi.waitFor(
        () => expect(hub.getTrace().extractCount).toBeGreaterThan(0),
        { timeout: 5_000 },
      )
      const afterFirstCompletion = hub.getTrace().extractCount
      const observationStartedAt = performance.now()
      await new Promise(resolve => setTimeout(resolve, 100))
      // Spam observed during the slow extract is coalesced behind a full
      // post-completion cooldown rather than keeping the extraction loop hot.
      // Use actual monotonic elapsed time: under full-suite load a requested
      // 100ms Node timer can resume after one or more 250ms cadence windows.
      const observationElapsedMs = performance.now() - observationStartedAt
      const additionalExtracts = hub.getTrace().extractCount - afterFirstCompletion
      const maximumAdditionalExtracts = Math.floor((observationElapsedMs + 75) / 250)
      expect(additionalExtracts).toBeLessThanOrEqual(maximumAdditionalExtracts)
    } finally {
      await page.evaluate(() => {
        const state = globalThis as unknown as { __geometraImmediateSpam?: number }
        if (state.__geometraImmediateSpam !== undefined) clearInterval(state.__geometraImmediateSpam)
      }).catch(() => {})
      releaseBeforeInput()
      await hub.close()
      await browser.close()
    }
  })

  it('broadcasts geometry after a stylesheet rule changes without a DOM mutation', async () => {
    const browser = await chromium.launch({ headless: true })
    const page = await browser.newPage({ viewport: { width: 640, height: 480 } })
    await page.setContent(`
      <style id="rules">#target { box-sizing: border-box; width: 80px; height: 30px; }</style>
      <button id="target">Resize from CSSOM</button>
    `)
    let resolvePort!: (port: number) => void
    const portPromise = new Promise<number>(resolve => { resolvePort = resolve })
    const hub = startGeometryWebSocket({
      port: 0,
      authToken: AUTH_TOKEN,
      page,
      debounceMs: 25,
      onListening: resolvePort,
    })
    let controller: WsClient | undefined

    try {
      await installDomObserver(page, hub.scheduleExtract)
      controller = await openAuthorized(`ws://127.0.0.1:${await portPromise}`)
      const initialFrame = nextWireMessage(controller, message => message.type === 'frame')
      await hub.flushExtract()
      await expect(initialFrame).resolves.toSatisfy(message => wireMessageHasWidth(message, 80))

      const updatedGeometry = nextWireMessage(
        controller,
        message => wireMessageHasWidth(message, 180),
        3_000,
      )
      await page.evaluate(() => {
        const sheet = (document.getElementById('rules') as HTMLStyleElement).sheet!
        sheet.insertRule('#target { width: 180px !important; }', sheet.cssRules.length)
      })

      await expect(updatedGeometry).resolves.toSatisfy(message => wireMessageHasWidth(message, 180))
    } finally {
      controller?.close()
      await hub.close()
      await browser.close()
    }
  })

  it('observes a cached CSS rule declaration assigned through a direct property setter', async () => {
    const browser = await chromium.launch({ headless: true })
    const page = await browser.newPage({ viewport: { width: 640, height: 480 } })
    await page.setContent(`
      <style>#target { position: absolute; left: 20px; top: 20px; width: 90px; height: 30px; }</style>
      <button id="target">Transform from cached CSS declaration</button>
    `)
    let resolvePort!: (port: number) => void
    const portPromise = new Promise<number>(resolve => { resolvePort = resolve })
    const hub = startGeometryWebSocket({
      port: 0,
      authToken: AUTH_TOKEN,
      page,
      debounceMs: 25,
      onListening: resolvePort,
    })
    let controller: WsClient | undefined

    try {
      await installDomObserver(page, hub.scheduleExtract)
      controller = await openAuthorized(`ws://127.0.0.1:${await portPromise}`)
      const initialFrame = nextWireMessage(controller, message => message.type === 'frame')
      await hub.flushExtract()
      await initialFrame

      await page.evaluate(() => {
        const state = globalThis as unknown as { __geometraCachedRuleStyle?: CSSStyleDeclaration }
        state.__geometraCachedRuleStyle = (document.styleSheets[0]!.cssRules[0] as CSSStyleRule).style
      })
      // Let the bounded getter sampler finish. The later assignment must be
      // detected by the declaration setter itself; transforms do not trigger
      // ResizeObserver and CSSOM edits do not trigger MutationObserver.
      await new Promise(resolve => setTimeout(resolve, 650))
      await hub.flushExtract()

      const transformedGeometry = nextWireMessage(
        controller,
        message => wireMessageHasX(message, 140),
        3_000,
      )
      const assignmentStartedAt = Date.now()
      await page.evaluate(() => {
        const state = globalThis as unknown as { __geometraCachedRuleStyle: CSSStyleDeclaration }
        state.__geometraCachedRuleStyle.transform = 'translateX(120px)'
      })

      await expect(transformedGeometry).resolves.toSatisfy(message => wireMessageHasX(message, 140))
      expect(Date.now() - assignmentStartedAt).toBeLessThan(1_000)
      await expect(page.locator('#target').evaluate(element => element.getBoundingClientRect().x)).resolves.toBeCloseTo(140, 0)
    } finally {
      controller?.close()
      await hub.close()
      await browser.close()
    }
  })

  it('broadcasts the final bounds of a CSS transition', async () => {
    const browser = await chromium.launch({ headless: true })
    const page = await browser.newPage({ viewport: { width: 640, height: 480 } })
    await page.setContent(`
      <style>
        #target {
          box-sizing: border-box;
          width: 80px;
          height: 30px;
          transition: width 180ms linear;
        }
      </style>
      <button id="target">Animated resize</button>
    `)
    let resolvePort!: (port: number) => void
    const portPromise = new Promise<number>(resolve => { resolvePort = resolve })
    const hub = startGeometryWebSocket({
      port: 0,
      authToken: AUTH_TOKEN,
      page,
      debounceMs: 25,
      onListening: resolvePort,
    })
    let controller: WsClient | undefined

    try {
      await installDomObserver(page, hub.scheduleExtract)
      controller = await openAuthorized(`ws://127.0.0.1:${await portPromise}`)
      const initialFrame = nextWireMessage(controller, message => message.type === 'frame')
      await hub.flushExtract()
      await initialFrame

      const finalGeometry = nextWireMessage(
        controller,
        message => wireMessageHasWidth(message, 220),
        3_000,
      )
      await page.evaluate(() => {
        document.getElementById('target')!.style.width = '220px'
      })

      await expect(finalGeometry).resolves.toSatisfy(message => wireMessageHasWidth(message, 220))
      await expect(page.locator('#target').evaluate(element => element.getBoundingClientRect().width)).resolves.toBeCloseTo(220, 0)
    } finally {
      controller?.close()
      await hub.close()
      await browser.close()
    }
  })

  it('stops settle sampling instead of extracting continuously on an idle page', async () => {
    const browser = await chromium.launch({ headless: true })
    const page = await browser.newPage({ viewport: { width: 640, height: 480 } })
    await page.setContent('<main><button>Idle target</button></main>')
    const scheduleExtract = vi.fn()

    try {
      // Observe the page bridge directly. Hub extraction also owns an
      // independent background AX/CDP refresh cadence, which is not evidence
      // that the page-side settle sampler stayed alive.
      await installDomObserver(page, scheduleExtract)
      // document.fonts.ready and ResizeObserver may legitimately start one
      // bounded settle window during installation. Wait on the renderer's
      // own RAF/performance clock: a loaded host can advance a Node timer
      // while Chromium has not yet delivered the sampler's final frame.
      await page.evaluate(async () => {
        const deadline = performance.now() + 600
        await new Promise<void>(resolve => {
          const afterRendererHorizon = () => {
            if (performance.now() >= deadline) {
              resolve()
            } else {
              requestAnimationFrame(afterRendererHorizon)
            }
          }
          requestAnimationFrame(afterRendererHorizon)
        })
      })
      // Drain the page-side 25ms notification cadence before taking the
      // strict idle baseline.
      await new Promise(resolve => setTimeout(resolve, 75))
      expect(scheduleExtract).toHaveBeenCalled()
      const settledCallCount = scheduleExtract.mock.calls.length
      await new Promise(resolve => setTimeout(resolve, 350))
      expect(scheduleExtract.mock.calls.length).toBe(settledCallCount)
    } finally {
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
