import { afterAll, describe, expect, it } from 'vitest'
import { WebSocketServer } from 'ws'
import { connect, disconnect, sendClick, sendFillFields, sendListboxPick, sendNavigate } from '../session.js'

describe('proxy-backed MCP actions', () => {
  afterAll(() => {
    disconnect()
  })

  it('waits for final listbox outcome instead of resolving on intermediate updates', async () => {
    const wss = new WebSocketServer({ port: 0 })
    wss.on('connection', ws => {
      ws.on('message', raw => {
        const msg = JSON.parse(String(raw)) as {
          type?: string
          requestId?: string
        }

        if (msg.type === 'resize') {
          ws.send(JSON.stringify({
            type: 'frame',
            layout: { x: 0, y: 0, width: 1024, height: 768, children: [] },
            tree: { kind: 'box', props: {}, semantic: { tag: 'body', role: 'group' }, children: [] },
          }))
          return
        }

        if (msg.type === 'listboxPick') {
          ws.send(JSON.stringify({
            type: 'frame',
            layout: { x: 0, y: 0, width: 1024, height: 768, children: [] },
            tree: { kind: 'box', props: {}, semantic: { tag: 'body', role: 'group' }, children: [] },
          }))
          setTimeout(() => {
            ws.send(JSON.stringify({
              type: 'error',
              requestId: msg.requestId,
              message: 'listboxPick: no visible option matching "Japan"',
            }))
          }, 20)
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

    try {
      const session = await connect(`ws://127.0.0.1:${port}`)

      await expect(
        sendListboxPick(session, 'Japan', {
          fieldLabel: 'Country',
          exact: true,
        }),
      ).rejects.toThrow('listboxPick: no visible option matching "Japan"')
    } finally {
      disconnect()
      await new Promise<void>((resolve, reject) => wss.close(err => (err ? reject(err) : resolve())))
    }
  })

  it('falls back to the latest observed update when a legacy peer does not send request-scoped ack', async () => {
    const wss = new WebSocketServer({ port: 0 })
    wss.on('connection', ws => {
      ws.on('message', raw => {
        const msg = JSON.parse(String(raw)) as { type?: string }

        if (msg.type === 'resize') {
          ws.send(JSON.stringify({
            type: 'frame',
            layout: { x: 0, y: 0, width: 1024, height: 768, children: [] },
            tree: { kind: 'box', props: {}, semantic: { tag: 'body', role: 'group' }, children: [] },
          }))
          return
        }

        if (msg.type === 'event') {
          ws.send(JSON.stringify({
            type: 'frame',
            layout: { x: 0, y: 0, width: 1024, height: 768, children: [] },
            tree: { kind: 'box', props: {}, semantic: { tag: 'body', role: 'group', ariaLabel: 'Updated' }, children: [] },
          }))
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

    try {
      const session = await connect(`ws://127.0.0.1:${port}`)
      await expect(sendClick(session, 5, 5, 60)).resolves.toMatchObject({ status: 'updated', timeoutMs: 60 })
    } finally {
      disconnect()
      await new Promise<void>((resolve, reject) => wss.close(err => (err ? reject(err) : resolve())))
    }
  })

  it('waits for the post-batch update before resolving fillFields acks', async () => {
    const wss = new WebSocketServer({ port: 0 })
    let seenMessage: { type?: string; fields?: unknown[] } | undefined
    let ackProtocolVersion = 2
    wss.on('connection', ws => {
      ws.on('message', raw => {
        const msg = JSON.parse(String(raw)) as { type?: string; fields?: unknown[]; requestId?: string }

        if (msg.type === 'resize') {
          ws.send(JSON.stringify({
            type: 'frame',
            layout: { x: 0, y: 0, width: 1024, height: 768, children: [] },
            tree: { kind: 'box', props: {}, semantic: { tag: 'body', role: 'group' }, children: [] },
          }))
          return
        }

        if (msg.type === 'fillFields') {
          seenMessage = msg
          ws.send(JSON.stringify({
            type: 'frame',
            layout: { x: 0, y: 0, width: 1024, height: 768, children: [] },
            tree: {
              kind: 'box',
              props: {},
              semantic: { tag: 'body', role: 'group', ariaLabel: 'Filled' },
              children: [],
            },
          }))
          ws.send(JSON.stringify({
            type: 'ack',
            requestId: msg.requestId,
            protocolVersion: ackProtocolVersion,
            result: {
              pageUrl: 'https://jobs.example.com/application',
              invalidCount: 0,
              alertCount: 0,
              dialogCount: 0,
              busyCount: 0,
            },
          }))
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

    try {
      const session = await connect(`ws://127.0.0.1:${port}`)
      await expect(
        sendFillFields(session, [
          { kind: 'text', fieldId: 'ff:0.0', fieldKey: 'id:full-name', fieldLabel: 'Full name', value: 'Taylor Applicant' },
          { kind: 'choice', fieldId: 'ff:0.1', fieldKey: 'name:select:default:country', fieldLabel: 'Country', value: 'Germany' },
        ], 80),
      ).resolves.toMatchObject({
        status: 'updated',
        timeoutMs: 80,
        result: {
          pageUrl: 'https://jobs.example.com/application',
          invalidCount: 0,
          alertCount: 0,
        },
      })
      expect(seenMessage).toMatchObject({
        type: 'fillFields',
        fields: [
          { kind: 'text', fieldId: 'ff:0.0', fieldKey: 'id:full-name', fieldLabel: 'Full name', value: 'Taylor Applicant' },
          { kind: 'choice', fieldId: 'ff:0.1', fieldKey: 'name:select:default:country', fieldLabel: 'Country', value: 'Germany' },
        ],
      })

      ackProtocolVersion = 1
      await expect(
        sendFillFields(session, [
          { kind: 'text', fieldKey: 'id:full-name', fieldLabel: 'Full name', value: 'Taylor Applicant' },
        ], 80),
      ).rejects.toThrow('cannot guarantee exact field identity')
    } finally {
      disconnect()
      await new Promise<void>((resolve, reject) => wss.close(err => (err ? reject(err) : resolve())))
    }
  })

  it('ignores invalid patch paths instead of mutating ancestor layout nodes', async () => {
    const wss = new WebSocketServer({ port: 0 })
    wss.on('connection', ws => {
      ws.on('message', raw => {
        const msg = JSON.parse(String(raw)) as { type?: string }

        if (msg.type === 'resize') {
          ws.send(JSON.stringify({
            type: 'frame',
            layout: {
              x: 0,
              y: 0,
              width: 200,
              height: 100,
              children: [{ x: 10, y: 20, width: 30, height: 40, children: [] }],
            },
            tree: {
              kind: 'box',
              props: {},
              semantic: { tag: 'body', role: 'group' },
              children: [{ kind: 'box', props: {}, semantic: { tag: 'div', role: 'group' }, children: [] }],
            },
          }))
          setTimeout(() => {
            ws.send(JSON.stringify({
              type: 'patch',
              patches: [{ path: [9], x: 999, y: 999 }],
            }))
          }, 10)
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

    try {
      const session = await connect(`ws://127.0.0.1:${port}`)
      await new Promise(resolve => setTimeout(resolve, 30))
      expect(session.layout).toMatchObject({
        x: 0,
        y: 0,
        children: [{ x: 10, y: 20 }],
      })
    } finally {
      disconnect()
      await new Promise<void>((resolve, reject) => wss.close(err => (err ? reject(err) : resolve())))
    }
  })

  it('supports in-session navigation and waits for the resulting frame', async () => {
    const wss = new WebSocketServer({ port: 0 })
    const received: Array<Record<string, unknown>> = []
    wss.on('connection', ws => {
      ws.on('message', raw => {
        const msg = JSON.parse(String(raw)) as { type?: string; url?: string; requestId?: string }
        received.push(msg as Record<string, unknown>)

        if (msg.type === 'resize') {
          ws.send(JSON.stringify({
            type: 'frame',
            layout: { x: 0, y: 0, width: 1024, height: 768, children: [] },
            tree: { kind: 'box', props: {}, semantic: { tag: 'body', role: 'group' }, children: [] },
          }))
          return
        }

        if (msg.type === 'navigate') {
          ws.send(JSON.stringify({
            type: 'frame',
            layout: { x: 0, y: 0, width: 1024, height: 768, children: [] },
            tree: {
              kind: 'box',
              props: {},
              semantic: { tag: 'body', role: 'group' },
              children: [],
            },
          }))
          ws.send(JSON.stringify({
            type: 'ack',
            requestId: msg.requestId,
            result: { pageUrl: msg.url },
          }))
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

    try {
      const session = await connect(`ws://127.0.0.1:${port}`)
      await expect(sendNavigate(session, 'https://jobs.example.com/application', 80)).resolves.toMatchObject({
        status: 'updated',
        timeoutMs: 80,
        result: { pageUrl: 'https://jobs.example.com/application' },
      })
      expect(received.some(message => message.type === 'navigate' && message.url === 'https://jobs.example.com/application')).toBe(true)
    } finally {
      disconnect()
      await new Promise<void>((resolve, reject) => wss.close(err => (err ? reject(err) : resolve())))
    }
  })

  it('reconnects once when an action is sent on a closed socket', async () => {
    const wss = new WebSocketServer({ port: 0 })
    let connectionCount = 0
    wss.on('connection', ws => {
      connectionCount += 1
      ws.on('message', raw => {
        const msg = JSON.parse(String(raw)) as { type?: string; requestId?: string }
        if (msg.type === 'resize') {
          ws.send(JSON.stringify({
            type: 'frame',
            layout: { x: 0, y: 0, width: 1024, height: 768, children: [] },
            tree: { kind: 'box', props: {}, semantic: { tag: 'body', role: 'group' }, children: [] },
          }))
          return
        }
        if (msg.type === 'event') {
          ws.send(JSON.stringify({
            type: 'frame',
            layout: { x: 0, y: 0, width: 1024, height: 768, children: [] },
            tree: {
              kind: 'box',
              props: {},
              semantic: { tag: 'body', role: 'group', ariaLabel: 'Reconnected' },
              children: [],
            },
          }))
          ws.send(JSON.stringify({
            type: 'ack',
            requestId: msg.requestId,
            result: { ok: true },
          }))
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

    try {
      const session = await connect(`ws://127.0.0.1:${port}`)
      await new Promise<void>(resolve => {
        if (session.ws.readyState === session.ws.CLOSED) {
          resolve()
          return
        }
        session.ws.once('close', () => resolve())
        session.ws.close()
      })

      await expect(sendClick(session, 5, 5, 150)).resolves.toMatchObject({
        status: 'updated',
        timeoutMs: 150,
        result: { ok: true },
      })
      expect(connectionCount).toBeGreaterThanOrEqual(2)
    } finally {
      disconnect()
      await new Promise<void>((resolve, reject) => wss.close(err => (err ? reject(err) : resolve())))
    }
  })
})
