import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocketServer, type WebSocket } from 'ws'

const mockState = vi.hoisted(() => ({
  startEmbeddedGeometraProxy: vi.fn(),
  spawnGeometraProxy: vi.fn(),
}))

vi.mock('../proxy-spawn.js', () => ({
  resolveStealthMode: (stealth?: boolean) => stealth ?? true,
  startEmbeddedGeometraProxy: mockState.startEmbeddedGeometraProxy,
  spawnGeometraProxy: mockState.spawnGeometraProxy,
}))

const { connectThroughProxy, disconnect, prewarmProxy } = await import('../session.js')

function frame(pageUrl: string) {
  return {
    type: 'frame',
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
  disconnect({ closeProxy: true })
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
      ready: Promise.resolve(),
      closed: false,
      close: vi.fn(async () => {
        staleRuntime.closed = true
      }),
    }
    const freshRuntime = {
      wsUrl: freshPeer.wsUrl,
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
      })
      expect(firstSession.proxyRuntime).toBe(staleRuntime)

      const recoveredSession = await connectThroughProxy({
        pageUrl: 'https://jobs.example.com/recovered',
        headless: true,
      })

      expect(recoveredSession.proxyRuntime).toBe(freshRuntime)
      expect(mockState.startEmbeddedGeometraProxy).toHaveBeenCalledTimes(2)
      expect(staleRuntime.close).toHaveBeenCalledTimes(1)
      expect(mockState.spawnGeometraProxy).not.toHaveBeenCalled()
    } finally {
      disconnect({ closeProxy: true })
      await closePeer(stalePeer.wss)
      await closePeer(freshPeer.wss)
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
      ready: Promise.resolve(),
      closed: false,
      close: vi.fn(async () => {
        headedRuntime.closed = true
      }),
    }
    const headlessRuntime = {
      wsUrl: headlessPeer.wsUrl,
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
      })
      expect(headedSession.proxyRuntime).toBe(headedRuntime)

      disconnect()

      const headlessSession = await connectThroughProxy({
        pageUrl: 'https://jobs.example.com/headless',
        headless: true,
      })
      expect(headlessSession.proxyRuntime).toBe(headlessRuntime)

      disconnect()

      const reusedHeadedSession = await connectThroughProxy({
        pageUrl: 'https://jobs.example.com/headed',
        headless: false,
      })

      expect(reusedHeadedSession.proxyRuntime).toBe(headedRuntime)
      expect(mockState.startEmbeddedGeometraProxy).toHaveBeenCalledTimes(2)
      expect(headedRuntime.close).not.toHaveBeenCalled()
      expect(headlessRuntime.close).not.toHaveBeenCalled()
    } finally {
      disconnect({ closeProxy: true })
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
      ready: Promise.resolve(),
      closed: false,
      close: vi.fn(async () => {
        stockRuntime.closed = true
      }),
    }
    const stealthRuntime = {
      wsUrl: stealthPeer.wsUrl,
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
      })
      expect(stockSession.proxyRuntime).toBe(stockRuntime)

      disconnect()

      const stealthSession = await connectThroughProxy({
        pageUrl: 'https://jobs.example.com/application',
        headless: true,
        stealth: true,
      })
      expect(stealthSession.proxyRuntime).toBe(stealthRuntime)

      disconnect()

      const reusedStockSession = await connectThroughProxy({
        pageUrl: 'https://jobs.example.com/application',
        headless: true,
        stealth: false,
      })

      expect(reusedStockSession.proxyRuntime).toBe(stockRuntime)
      expect(mockState.startEmbeddedGeometraProxy).toHaveBeenCalledTimes(2)
      expect(mockState.spawnGeometraProxy).not.toHaveBeenCalled()
      expect(stockRuntime.close).not.toHaveBeenCalled()
      expect(stealthRuntime.close).not.toHaveBeenCalled()
    } finally {
      disconnect({ closeProxy: true })
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
      })

      expect(session.proxyRuntime).toBe(preparedRuntime)
      expect(mockState.startEmbeddedGeometraProxy).toHaveBeenCalledTimes(1)
      expect(mockState.spawnGeometraProxy).not.toHaveBeenCalled()
    } finally {
      disconnect({ closeProxy: true })
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
      disconnect({ closeProxy: true })
      expect(lazyRuntime.close).toHaveBeenCalledTimes(1)
      await closePeer(lazyPeer.wss)
    }
  })

})
