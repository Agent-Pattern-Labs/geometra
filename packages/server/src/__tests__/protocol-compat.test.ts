import { describe, it, expect } from 'vitest'
import WebSocket from 'ws'
import { box } from '@geometra/core'
import { createStandaloneTestServer } from './test-helpers.js'

describe('protocol compatibility', () => {
  it('accepts unversioned client messages as v1-compatible', async () => {
    const { server, port } = await createStandaloneTestServer(
      () => box({ width: 40, height: 20 }, []),
      { width: 200, height: 100 },
    )

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`)
      let sentResize = false
      const timeout = setTimeout(() => reject(new Error('timed out waiting for unversioned compatibility response')), 5000)

      ws.on('message', (raw) => {
        const msg = JSON.parse(String(raw)) as { type: string; message?: string }
        if (msg.type === 'frame') {
          if (!sentResize) {
            // Unversioned resize should be accepted and trigger a new frame/patch without error.
            ws.send(JSON.stringify({ type: 'resize', width: 180, height: 120 }))
            sentResize = true
            return
          }
          clearTimeout(timeout)
          ws.close()
          resolve()
          return
        }
        if (msg.type === 'error') {
          clearTimeout(timeout)
          reject(new Error(`unexpected protocol error: ${msg.message ?? 'unknown'}`))
          return
        }
      })

      ws.on('error', (err) => {
        clearTimeout(timeout)
        reject(err)
      })
    }).finally(() => {
      server.close()
    })
  })

  it('returns explicit error for newer client protocol versions', async () => {
    const { server, port } = await createStandaloneTestServer(
      () => box({ width: 40, height: 20 }, []),
      { width: 200, height: 100 },
    )

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`)
      const timeout = setTimeout(() => reject(new Error('timed out waiting for protocol mismatch error')), 5000)

      ws.on('open', () => {
        ws.send(JSON.stringify({
          type: 'event',
          eventType: 'onClick',
          x: 1,
          y: 1,
          protocolVersion: 999,
        }))
      })

      ws.on('message', (raw) => {
        const msg = JSON.parse(String(raw)) as { type: string; message?: string }
        if (msg.type !== 'error') return
        clearTimeout(timeout)
        expect(msg.message).toContain('newer than server geometry protocol')
        ws.close()
        resolve()
      })

      ws.on('error', (err) => {
        clearTimeout(timeout)
        reject(err)
      })
    }).finally(() => {
      server.close()
    })
  })

  it('accepts the v1.64 MCP legacy v2 envelope for native input messages', async () => {
    let clicked = false
    const { server, port } = await createStandaloneTestServer(
      () => box({
        width: 40,
        height: 20,
        onClick: () => { clicked = true },
      }, []),
      { width: 200, height: 100 },
    )

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`)
      let sent = false
      const timeout = setTimeout(() => reject(new Error('timed out waiting for compatibility ack')), 5000)

      ws.on('message', raw => {
        const msg = JSON.parse(String(raw)) as { type?: string; requestId?: string; message?: string }
        if (msg.type === 'frame' && !sent) {
          sent = true
          ws.send(JSON.stringify({
            type: 'event',
            eventType: 'onClick',
            x: 10,
            y: 10,
            requestId: 'legacy-v164-click',
            protocolVersion: 2,
          }))
          return
        }
        if (msg.type === 'ack' && msg.requestId === 'legacy-v164-click') {
          clearTimeout(timeout)
          ws.close()
          resolve()
          return
        }
        if (msg.type === 'error') {
          clearTimeout(timeout)
          reject(new Error(msg.message ?? 'unexpected error'))
        }
      })
      ws.on('error', reject)
    }).finally(() => server.close())

    expect(clicked).toBe(true)
  })

  it('sends request-scoped ack for handled no-op actions', async () => {
    const { server, port } = await createStandaloneTestServer(
      () => box({ width: 40, height: 20, onClick: () => undefined }, []),
      { width: 200, height: 100 },
    )

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`)
      let sentClick = false
      const timeout = setTimeout(() => reject(new Error('timed out waiting for request-scoped ack')), 5000)

      ws.on('message', (raw) => {
        const msg = JSON.parse(String(raw)) as { type: string; requestId?: string; message?: string }
        if (msg.type === 'frame' && !sentClick) {
          ws.send(JSON.stringify({
            type: 'event',
            eventType: 'onClick',
            x: 10,
            y: 10,
            requestId: 'req-click',
          }))
          sentClick = true
          return
        }
        if (msg.type === 'ack') {
          clearTimeout(timeout)
          expect(msg.requestId).toBe('req-click')
          ws.close()
          resolve()
          return
        }
        if (msg.type === 'error') {
          clearTimeout(timeout)
          reject(new Error(`unexpected error: ${msg.message ?? 'unknown'}`))
        }
      })

      ws.on('error', (err) => {
        clearTimeout(timeout)
        reject(err)
      })
    }).finally(() => {
      server.close()
    })
  })

  it('echoes requestId on proxy-only message errors', async () => {
    const { server, port } = await createStandaloneTestServer(
      () => box({ width: 40, height: 20 }, []),
      { width: 200, height: 100 },
    )

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`)
      const timeout = setTimeout(() => reject(new Error('timed out waiting for unsupported-message error')), 5000)

      ws.on('open', () => {
        ws.send(JSON.stringify({
          type: 'wheel',
          deltaY: 120,
          requestId: 'req-wheel',
        }))
      })

      ws.on('message', (raw) => {
        const msg = JSON.parse(String(raw)) as { type: string; requestId?: string; message?: string }
        if (msg.type !== 'error') return
        clearTimeout(timeout)
        expect(msg.requestId).toBe('req-wheel')
        expect(msg.message).toContain('not supported on the native Textura server')
        ws.close()
        resolve()
      })

      ws.on('error', (err) => {
        clearTimeout(timeout)
        reject(err)
      })
    }).finally(() => {
      server.close()
    })
  })
})
