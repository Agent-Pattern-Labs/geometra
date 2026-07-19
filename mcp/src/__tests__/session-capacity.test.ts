import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket as WsClient, WebSocketServer } from 'ws'
import {
  connect,
  disconnect,
  listSessions,
  shutdownAllSessionsAndProxies,
} from '../session.js'

async function createFramePeer(): Promise<{ wss: WebSocketServer; wsUrl: string }> {
  const wss = new WebSocketServer({ port: 0 })
  wss.on('connection', ws => {
    ws.send(JSON.stringify({
      type: 'frame',
      protocolVersion: 1,
      geometryProtocolVersion: 1,
      layout: { x: 0, y: 0, width: 100, height: 100, children: [] },
      tree: { kind: 'box', props: {}, semantic: { tag: 'body', role: 'group' }, children: [] },
    }))
  })
  const port = await new Promise<number>((resolve, reject) => {
    wss.once('listening', () => {
      const address = wss.address()
      if (typeof address === 'object' && address) resolve(address.port)
      else reject(new Error('Failed to resolve ephemeral WebSocket port'))
    })
    wss.once('error', reject)
  })
  return { wss, wsUrl: `ws://127.0.0.1:${port}` }
}

async function closePeer(wss: WebSocketServer): Promise<void> {
  for (const client of wss.clients) client.close()
  await new Promise<void>((resolve, reject) => wss.close(err => (err ? reject(err) : resolve())))
}

describe('session ownership capacity', () => {
  afterEach(() => {
    shutdownAllSessionsAndProxies()
  })

  it('rejects capacity pressure without evicting an active owner', async () => {
    const { wss, wsUrl } = await createFramePeer()
    try {
      const sessions = await Promise.all(Array.from({ length: 5 }, () => connect(wsUrl)))

      await expect(connect(wsUrl)).rejects.toThrow(/5 active sessions.*limit 5/)
      expect(listSessions()).toHaveLength(5)
      for (const session of sessions) {
        expect(session.ws.readyState).toBe(WsClient.OPEN)
      }
    } finally {
      shutdownAllSessionsAndProxies()
      await closePeer(wss)
    }
  })

  it('atomically reserves capacity across simultaneous direct connects', async () => {
    const { wss, wsUrl } = await createFramePeer()
    try {
      const results = await Promise.allSettled(
        Array.from({ length: 6 }, () => connect(wsUrl)),
      )
      const fulfilled = results.filter(
        (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof connect>>> => result.status === 'fulfilled',
      )
      const rejected = results.filter(
        (result): result is PromiseRejectedResult => result.status === 'rejected',
      )

      expect(fulfilled).toHaveLength(5)
      expect(rejected).toHaveLength(1)
      expect(rejected[0]!.reason).toBeInstanceOf(Error)
      expect((rejected[0]!.reason as Error).message).toMatch(/pending connection.*limit 5/i)
      expect(listSessions().map(session => session.id).sort()).toEqual(
        fulfilled.map(result => result.value.id).sort(),
      )
      for (const result of fulfilled) {
        expect(result.value.ws.readyState).toBe(WsClient.OPEN)
      }
    } finally {
      shutdownAllSessionsAndProxies()
      await closePeer(wss)
    }
  })

  it('releases a failed connection reservation for later owners', async () => {
    const rejectingPeer = new WebSocketServer({ port: 0 })
    rejectingPeer.on('connection', ws => {
      ws.send(JSON.stringify({ type: 'error', message: 'peer refused initialization' }))
    })
    const rejectingPort = await new Promise<number>((resolve, reject) => {
      rejectingPeer.once('listening', () => {
        const address = rejectingPeer.address()
        if (typeof address === 'object' && address) resolve(address.port)
        else reject(new Error('Failed to resolve rejecting WebSocket port'))
      })
      rejectingPeer.once('error', reject)
    })
    const healthyPeer = await createFramePeer()

    try {
      await expect(connect(`ws://127.0.0.1:${rejectingPort}`)).rejects.toThrow('peer refused initialization')
      const sessions = await Promise.all(Array.from({ length: 5 }, () => connect(healthyPeer.wsUrl)))
      expect(listSessions()).toHaveLength(5)
      for (const session of sessions) expect(session.ws.readyState).toBe(WsClient.OPEN)
    } finally {
      shutdownAllSessionsAndProxies()
      await Promise.all([closePeer(rejectingPeer), closePeer(healthyPeer.wss)])
    }
  })

  it('does not guess which owner to disconnect when routing is ambiguous', async () => {
    const { wss, wsUrl } = await createFramePeer()
    try {
      const sessions = await Promise.all([connect(wsUrl), connect(wsUrl)])

      expect(() => disconnect()).toThrow('explicit sessionId')
      expect(listSessions()).toHaveLength(2)
      for (const session of sessions) {
        expect(session.ws.readyState).toBe(WsClient.OPEN)
      }
    } finally {
      shutdownAllSessionsAndProxies()
      await closePeer(wss)
    }
  })
})
