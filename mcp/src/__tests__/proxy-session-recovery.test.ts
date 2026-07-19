import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocketServer, type WebSocket } from 'ws'

const mockState = vi.hoisted(() => ({
  startEmbeddedGeometraProxy: vi.fn(),
  spawnGeometraProxy: vi.fn(),
}))

vi.mock('../proxy-spawn.js', () => ({
  resolveStealthMode: (stealth?: boolean) => stealth ?? false,
  startEmbeddedGeometraProxy: mockState.startEmbeddedGeometraProxy,
  spawnGeometraProxy: mockState.spawnGeometraProxy,
}))

const { connectThroughProxy, disconnect, listSessions, prewarmProxy, shutdownAllSessionsAndProxies } = await import('../session.js')

const AUTH_TOKEN = 'proxy-session-recovery-capability-000000000000'
const PROXY_METADATA = {
  protocolVersion: 1,
  geometryProtocolVersion: 1,
  proxyActionProtocolVersion: 2,
  protocolCapabilities: {
    transport: 'proxy',
    authenticatedController: true,
    requestScopedAcks: true,
    proxyActions: true,
    exactFieldIdentity: true,
  },
} as const

function frame(pageUrl: string) {
  return {
    type: 'frame',
    ...PROXY_METADATA,
    layout: { x: 0, y: 0, width: 1280, height: 720, children: [] },
    tree: {
      kind: 'box',
      props: {},
      semantic: {
        tag: 'body',
        role: 'group',
        pageUrl,
      },
      children: [],
    },
  }
}

async function createProxyPeer(options?: {
  pageUrl: string
  sendInitialFrame?: boolean
  onNavigate?: (ws: WebSocket, msg: { requestId?: string; url?: string }) => void
  onResize?: (ws: WebSocket, msg: { requestId?: string; width?: number; height?: number }) => void
}) {
  const wss = new WebSocketServer({ port: 0 })
  wss.on('connection', ws => {
    ws.send(JSON.stringify({ type: 'hello', ...PROXY_METADATA }))
    if (options?.sendInitialFrame !== false) {
      ws.send(JSON.stringify(frame(options?.pageUrl ?? 'https://jobs.example.com/original')))
    }

    ws.on('message', raw => {
      const msg = JSON.parse(String(raw)) as {
        type?: string
        requestId?: string
        url?: string
        width?: number
        height?: number
      }
      if (msg.type === 'navigate') {
        options?.onNavigate?.(ws, msg)
      } else if (msg.type === 'resize') {
        options?.onResize?.(ws, msg)
      }
    })
  })

  const port = await new Promise<number>((resolve, reject) => {
    wss.once('listening', () => {
      const address = wss.address()
      if (typeof address === 'object' && address) resolve(address.port)
      else reject(new Error('Failed to resolve ephemeral WebSocket port'))
    })
    wss.once('error', reject)
  })

  return {
    wss,
    wsUrl: `ws://127.0.0.1:${port}`,
  }
}

afterEach(async () => {
  shutdownAllSessionsAndProxies()
  vi.clearAllMocks()
})

async function closePeer(wss: WebSocketServer): Promise<void> {
  for (const client of wss.clients) {
    client.close()
  }
  await new Promise<void>((resolve, reject) => wss.close(err => (err ? reject(err) : resolve())))
}

describe('connectThroughProxy recovery', () => {
  it('restarts from a fresh proxy when a reused browser session was already closed', async () => {
    const stalePeer = await createProxyPeer({
      pageUrl: 'https://jobs.example.com/original',
      onNavigate(ws, msg) {
        ws.send(JSON.stringify({
          type: 'error',
          requestId: msg.requestId,
          message: 'page.goto: Target page, context or browser has been closed',
        }))
      },
    })
    const freshPeer = await createProxyPeer({
      pageUrl: 'https://jobs.example.com/recovered',
    })

    const staleRuntime = {
      wsUrl: stalePeer.wsUrl,
      authToken: AUTH_TOKEN,
      ready: Promise.resolve(),
      closed: false,
      close: vi.fn(async () => {
        staleRuntime.closed = true
      }),
    }
    const freshRuntime = {
      wsUrl: freshPeer.wsUrl,
      authToken: AUTH_TOKEN,
      ready: Promise.resolve(),
      closed: false,
      close: vi.fn(async () => {
        freshRuntime.closed = true
      }),
    }

    mockState.startEmbeddedGeometraProxy
      .mockResolvedValueOnce({ runtime: staleRuntime, wsUrl: stalePeer.wsUrl })
      .mockResolvedValueOnce({ runtime: freshRuntime, wsUrl: freshPeer.wsUrl })
    mockState.spawnGeometraProxy.mockRejectedValue(new Error('spawn fallback should not be used'))

    try {
      const firstSession = await connectThroughProxy({
        pageUrl: 'https://jobs.example.com/original',
        headless: true,
        isolated: false,
      })
      expect(firstSession.proxyRuntime).toBe(staleRuntime)
      disconnect({ sessionId: firstSession.id, closeProxy: false })

      const recoveredSession = await connectThroughProxy({
        pageUrl: 'https://jobs.example.com/recovered',
        headless: true,
        isolated: false,
      })

      expect(recoveredSession.proxyRuntime).toBe(freshRuntime)
      expect(mockState.startEmbeddedGeometraProxy).toHaveBeenCalledTimes(2)
      expect(staleRuntime.close).toHaveBeenCalledTimes(1)
      expect(mockState.spawnGeometraProxy).not.toHaveBeenCalled()
    } finally {
      shutdownAllSessionsAndProxies()
      await closePeer(stalePeer.wss)
      await closePeer(freshPeer.wss)
    }
  })

  it('reserves ownership before simultaneous fresh browser startups', async () => {
    const peers = await Promise.all(Array.from({ length: 5 }, (_, index) => createProxyPeer({
      pageUrl: `https://jobs.example.com/capacity-${index}`,
    })))
    const runtimes = peers.map((peer) => {
      const runtime = {
        wsUrl: peer.wsUrl,
        authToken: AUTH_TOKEN,
        ready: Promise.resolve(),
        closed: false,
        close: vi.fn(async () => {
          runtime.closed = true
        }),
      }
      return runtime
    })
    let runtimeIndex = 0
    mockState.startEmbeddedGeometraProxy.mockImplementation(async () => {
      const runtime = runtimes[runtimeIndex++]
      if (!runtime) throw new Error('capacity guard allowed an excess browser startup')
      return { runtime, wsUrl: runtime.wsUrl }
    })
    mockState.spawnGeometraProxy.mockRejectedValue(new Error('spawn fallback should not be used'))

    try {
      const results = await Promise.allSettled(Array.from({ length: 6 }, (_, index) => connectThroughProxy({
        pageUrl: `https://jobs.example.com/capacity-${index}`,
        headless: true,
      })))
      const fulfilled = results.filter(
        (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof connectThroughProxy>>> => result.status === 'fulfilled',
      )
      const rejected = results.filter(
        (result): result is PromiseRejectedResult => result.status === 'rejected',
      )

      expect(fulfilled).toHaveLength(5)
      expect(rejected).toHaveLength(1)
      expect((rejected[0]!.reason as Error).message).toMatch(/pending connection.*limit 5/i)
      expect(mockState.startEmbeddedGeometraProxy).toHaveBeenCalledTimes(5)
      expect(mockState.spawnGeometraProxy).not.toHaveBeenCalled()
      expect(listSessions().map(session => session.id).sort()).toEqual(
        fulfilled.map(result => result.value.id).sort(),
      )
    } finally {
      shutdownAllSessionsAndProxies()
      for (const runtime of runtimes) expect(runtime.close).toHaveBeenCalledTimes(1)
      await Promise.all(peers.map(peer => closePeer(peer.wss)))
    }
  })

  it('settles the losing embedded connect before reusing its lease for child fallback', async () => {
    const embeddedPeer = await createProxyPeer({
      pageUrl: 'https://jobs.example.com/embedded-failure',
      sendInitialFrame: false,
    })
    const childPeer = await createProxyPeer({
      pageUrl: 'https://jobs.example.com/child-fallback',
    })
    let embeddedPeerClosed = false
    const readyFailure = new Error('embedded runtime failed before its first frame')
    const embeddedRuntime = {
      wsUrl: embeddedPeer.wsUrl,
      authToken: AUTH_TOKEN,
      ready: Promise.reject(readyFailure),
      closed: false,
      close: vi.fn(async () => {
        embeddedRuntime.closed = true
        await closePeer(embeddedPeer.wss)
        embeddedPeerClosed = true
      }),
    }
    // The session installs a rejection observer immediately, but retain an
    // explicit test observer as well so Vitest never treats this deliberate
    // ready failure as an unhandled rejection.
    void embeddedRuntime.ready.catch(() => {})
    const child = {
      killed: false,
      exitCode: null,
      signalCode: null,
      kill: vi.fn(() => {
        child.killed = true
        return true
      }),
      once: vi.fn(),
    }
    mockState.startEmbeddedGeometraProxy.mockResolvedValue({
      runtime: embeddedRuntime,
      wsUrl: embeddedPeer.wsUrl,
    })
    mockState.spawnGeometraProxy.mockResolvedValue({
      child,
      wsUrl: childPeer.wsUrl,
      authToken: AUTH_TOKEN,
    })

    try {
      const session = await connectThroughProxy({
        pageUrl: 'https://jobs.example.com/child-fallback',
        headless: true,
      })

      expect(session.proxyChild).toBe(child)
      expect(session.proxyRuntime).toBeUndefined()
      expect(embeddedRuntime.close).toHaveBeenCalledTimes(1)
      expect(mockState.spawnGeometraProxy).toHaveBeenCalledTimes(1)
      expect(listSessions()).toEqual([{ id: session.id, url: childPeer.wsUrl }])
    } finally {
      shutdownAllSessionsAndProxies()
      if (!embeddedPeerClosed) await closePeer(embeddedPeer.wss)
      await closePeer(childPeer.wss)
    }
  })

  it('keeps separate warm proxies for compatible headed and headless reuse', async () => {
    const headedPeer = await createProxyPeer({
      pageUrl: 'https://jobs.example.com/headed',
    })
    const headlessPeer = await createProxyPeer({
      pageUrl: 'https://jobs.example.com/headless',
    })

    const headedRuntime = {
      wsUrl: headedPeer.wsUrl,
      authToken: AUTH_TOKEN,
      ready: Promise.resolve(),
      closed: false,
      close: vi.fn(async () => {
        headedRuntime.closed = true
      }),
    }
    const headlessRuntime = {
      wsUrl: headlessPeer.wsUrl,
      authToken: AUTH_TOKEN,
      ready: Promise.resolve(),
      closed: false,
      close: vi.fn(async () => {
        headlessRuntime.closed = true
      }),
    }

    mockState.startEmbeddedGeometraProxy
      .mockResolvedValueOnce({ runtime: headedRuntime, wsUrl: headedPeer.wsUrl })
      .mockResolvedValueOnce({ runtime: headlessRuntime, wsUrl: headlessPeer.wsUrl })
    mockState.spawnGeometraProxy.mockRejectedValue(new Error('spawn fallback should not be used'))

    try {
      const headedSession = await connectThroughProxy({
        pageUrl: 'https://jobs.example.com/headed',
        headless: false,
        isolated: false,
      })
      expect(headedSession.proxyRuntime).toBe(headedRuntime)

      disconnect()

      const headlessSession = await connectThroughProxy({
        pageUrl: 'https://jobs.example.com/headless',
        headless: true,
        isolated: false,
      })
      expect(headlessSession.proxyRuntime).toBe(headlessRuntime)

      disconnect()

      const reusedHeadedSession = await connectThroughProxy({
        pageUrl: 'https://jobs.example.com/headed',
        headless: false,
        isolated: false,
      })

      expect(reusedHeadedSession.proxyRuntime).toBe(headedRuntime)
      expect(mockState.startEmbeddedGeometraProxy).toHaveBeenCalledTimes(2)
      expect(headedRuntime.close).not.toHaveBeenCalled()
      expect(headlessRuntime.close).not.toHaveBeenCalled()
    } finally {
      shutdownAllSessionsAndProxies()
      expect(headedRuntime.close).toHaveBeenCalledTimes(1)
      expect(headlessRuntime.close).toHaveBeenCalledTimes(1)
      await closePeer(headedPeer.wss)
      await closePeer(headlessPeer.wss)
    }
  })

  it('keeps separate warm proxies for stock and stealth browser modes', async () => {
    const stockPeer = await createProxyPeer({
      pageUrl: 'https://jobs.example.com/application',
    })
    const stealthPeer = await createProxyPeer({
      pageUrl: 'https://jobs.example.com/application',
    })

    const stockRuntime = {
      wsUrl: stockPeer.wsUrl,
      authToken: AUTH_TOKEN,
      ready: Promise.resolve(),
      closed: false,
      close: vi.fn(async () => {
        stockRuntime.closed = true
      }),
    }
    const stealthRuntime = {
      wsUrl: stealthPeer.wsUrl,
      authToken: AUTH_TOKEN,
      ready: Promise.resolve(),
      closed: false,
      close: vi.fn(async () => {
        stealthRuntime.closed = true
      }),
    }

    mockState.startEmbeddedGeometraProxy
      .mockResolvedValueOnce({ runtime: stockRuntime, wsUrl: stockPeer.wsUrl })
      .mockResolvedValueOnce({ runtime: stealthRuntime, wsUrl: stealthPeer.wsUrl })
    mockState.spawnGeometraProxy.mockRejectedValue(new Error('spawn fallback should not be used'))

    try {
      const stockSession = await connectThroughProxy({
        pageUrl: 'https://jobs.example.com/application',
        headless: true,
        stealth: false,
        isolated: false,
      })
      expect(stockSession.proxyRuntime).toBe(stockRuntime)

      disconnect()

      const stealthSession = await connectThroughProxy({
        pageUrl: 'https://jobs.example.com/application',
        headless: true,
        stealth: true,
        isolated: false,
      })
      expect(stealthSession.proxyRuntime).toBe(stealthRuntime)

      disconnect()

      const reusedStockSession = await connectThroughProxy({
        pageUrl: 'https://jobs.example.com/application',
        headless: true,
        stealth: false,
        isolated: false,
      })

      expect(reusedStockSession.proxyRuntime).toBe(stockRuntime)
      expect(mockState.startEmbeddedGeometraProxy).toHaveBeenCalledTimes(2)
      expect(mockState.spawnGeometraProxy).not.toHaveBeenCalled()
      expect(stockRuntime.close).not.toHaveBeenCalled()
      expect(stealthRuntime.close).not.toHaveBeenCalled()
    } finally {
      shutdownAllSessionsAndProxies()
      expect(stockRuntime.close).toHaveBeenCalledTimes(1)
      expect(stealthRuntime.close).toHaveBeenCalledTimes(1)
      await closePeer(stockPeer.wss)
      await closePeer(stealthPeer.wss)
    }
  })

  it('can prewarm a reusable proxy before the first measured task', async () => {
    const preparedPeer = await createProxyPeer({
      pageUrl: 'https://jobs.example.com/prepared',
    })

    const preparedRuntime = {
      wsUrl: preparedPeer.wsUrl,
      authToken: AUTH_TOKEN,
      ready: Promise.resolve(),
      closed: false,
      close: vi.fn(async () => {
        preparedRuntime.closed = true
      }),
    }

    mockState.startEmbeddedGeometraProxy.mockResolvedValue({
      runtime: preparedRuntime,
      wsUrl: preparedPeer.wsUrl,
    })
    mockState.spawnGeometraProxy.mockRejectedValue(new Error('spawn fallback should not be used'))

    try {
      const prepared = await prewarmProxy({
        pageUrl: 'https://jobs.example.com/prepared',
        headless: true,
      })
      expect(prepared).toMatchObject({
        prepared: true,
        reused: false,
        transport: 'embedded',
        pageUrl: 'https://jobs.example.com/prepared',
      })

      const session = await connectThroughProxy({
        pageUrl: 'https://jobs.example.com/prepared',
        headless: true,
        isolated: false,
      })

      expect(session.proxyRuntime).toBe(preparedRuntime)
      expect(mockState.startEmbeddedGeometraProxy).toHaveBeenCalledTimes(1)
      expect(mockState.spawnGeometraProxy).not.toHaveBeenCalled()
    } finally {
      shutdownAllSessionsAndProxies()
      expect(preparedRuntime.close).toHaveBeenCalledTimes(1)
      await closePeer(preparedPeer.wss)
    }
  })

  it('prewarms with headless stock Chromium defaults when browser flags are omitted', async () => {
    const preparedPeer = await createProxyPeer({
      pageUrl: 'https://jobs.example.com/defaults',
    })

    const preparedRuntime = {
      wsUrl: preparedPeer.wsUrl,
      authToken: AUTH_TOKEN,
      ready: Promise.resolve(),
      closed: false,
      close: vi.fn(async () => {
        preparedRuntime.closed = true
      }),
    }

    mockState.startEmbeddedGeometraProxy.mockResolvedValue({
      runtime: preparedRuntime,
      wsUrl: preparedPeer.wsUrl,
    })
    mockState.spawnGeometraProxy.mockRejectedValue(new Error('spawn fallback should not be used'))

    try {
      const prepared = await prewarmProxy({
        pageUrl: 'https://jobs.example.com/defaults',
      })

      expect(mockState.startEmbeddedGeometraProxy).toHaveBeenCalledWith(expect.objectContaining({
        pageUrl: 'https://jobs.example.com/defaults',
        headless: undefined,
        stealth: undefined,
      }))
      expect(prepared).toMatchObject({
        prepared: true,
        pageUrl: 'https://jobs.example.com/defaults',
        headless: true,
        stealth: false,
      })
    } finally {
      shutdownAllSessionsAndProxies()
      expect(preparedRuntime.close).toHaveBeenCalledTimes(1)
      await closePeer(preparedPeer.wss)
    }
  })

  it('starts without an eager initial extract when the caller defers the first frame', async () => {
    const lazyPeer = await createProxyPeer({
      pageUrl: 'https://jobs.example.com/lazy',
      sendInitialFrame: false,
    })

    const lazyRuntime = {
      wsUrl: lazyPeer.wsUrl,
      authToken: AUTH_TOKEN,
      ready: Promise.resolve(),
      closed: false,
      close: vi.fn(async () => {
        lazyRuntime.closed = true
      }),
    }

    mockState.startEmbeddedGeometraProxy.mockResolvedValueOnce({
      runtime: lazyRuntime,
      wsUrl: lazyPeer.wsUrl,
    })
    mockState.spawnGeometraProxy.mockRejectedValue(new Error('spawn fallback should not be used'))

    try {
      const session = await connectThroughProxy({
        pageUrl: 'https://jobs.example.com/lazy',
        headless: true,
        isolated: false,
        awaitInitialFrame: false,
      })

      expect(session.proxyRuntime).toBe(lazyRuntime)
      expect(mockState.startEmbeddedGeometraProxy).toHaveBeenCalledWith(expect.objectContaining({
        pageUrl: 'https://jobs.example.com/lazy',
        headless: true,
        eagerInitialExtract: false,
      }))
      expect(session.tree).toBeNull()
    } finally {
      shutdownAllSessionsAndProxies()
      expect(lazyRuntime.close).toHaveBeenCalledTimes(1)
      await closePeer(lazyPeer.wss)
    }
  })

})
