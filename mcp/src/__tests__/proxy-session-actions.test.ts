import { afterAll, describe, expect, it, vi } from 'vitest'
import { WebSocket as WsClient, WebSocketServer } from 'ws'

const lifecycleMocks = vi.hoisted(() => ({
  recordSessionSnapshot: vi.fn(),
}))

vi.mock('../session-state.js', () => ({
  completeSessionLifecycle: vi.fn(),
  failSessionLifecycle: vi.fn(),
  heartbeatSessionLifecycle: vi.fn(),
  initializeSessionLifecycle: vi.fn(),
  recordSessionSnapshot: lifecycleMocks.recordSessionSnapshot,
}))

import {
  connect,
  disconnect,
  sendClick,
  sendFileUpload,
  sendFillFields,
  sendKey,
  sendListboxPick,
  sendNavigate,
  sendType,
} from '../session.js'

const MODERN_PROXY_METADATA = {
  protocolVersion: 2,
  geometryProtocolVersion: 1,
  proxyActionProtocolVersion: 2,
  protocolCapabilities: {
    transport: 'proxy',
    authenticatedController: true,
    requestScopedAcks: true,
    actionDeadlines: true,
    idempotentRequestIds: true,
    proxyActions: true,
    exactFieldIdentity: true,
    verifiedFileUploads: true,
  },
} as const
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

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
            ...MODERN_PROXY_METADATA,
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

  it('preserves semantic file-target constraints on the proxy wire', async () => {
    const wss = new WebSocketServer({ port: 0 })
    let seenFileMessage: Record<string, unknown> | undefined
    wss.on('connection', ws => {
      ws.on('message', raw => {
        const msg = JSON.parse(String(raw)) as { type?: string; requestId?: string }
        if (msg.type === 'resize') {
          ws.send(JSON.stringify({
            type: 'frame',
            layout: { x: 0, y: 0, width: 1024, height: 768, children: [] },
            tree: { kind: 'box', props: {}, semantic: { tag: 'body', role: 'group' }, children: [] },
            ...MODERN_PROXY_METADATA,
          }))
          return
        }
        if (msg.type === 'file') {
          seenFileMessage = msg as Record<string, unknown>
          ws.send(JSON.stringify({
            type: 'frame',
            layout: { x: 0, y: 0, width: 1024, height: 768, children: [] },
            tree: {
              kind: 'box',
              props: {},
              semantic: { tag: 'body', role: 'group', ariaLabel: 'Resume attached' },
              children: [],
            },
            ...MODERN_PROXY_METADATA,
          }))
          ws.send(JSON.stringify({ type: 'ack', requestId: msg.requestId, ...MODERN_PROXY_METADATA }))
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
      await expect(sendFileUpload(session, ['/tmp/resume.pdf'], {
        fieldLabel: 'Resume',
        exact: true,
        strategy: 'hidden',
        contextText: 'Upload your resume',
        sectionText: 'Application documents',
      }, 80)).resolves.toMatchObject({ status: 'updated', timeoutMs: 80 })
      expect(seenFileMessage).toMatchObject({
        type: 'file',
        paths: ['/tmp/resume.pdf'],
        fieldLabel: 'Resume',
        exact: true,
        strategy: 'hidden',
        contextText: 'Upload your resume',
        sectionText: 'Application documents',
      })
    } finally {
      disconnect()
      await new Promise<void>((resolve, reject) => wss.close(err => (err ? reject(err) : resolve())))
    }
  })

  it('refuses direct and batched file mutations before sending to an unverified proxy', async () => {
    const wss = new WebSocketServer({ port: 0 })
    let fileMutationCount = 0
    const unsafeProxyMetadata = {
      ...MODERN_PROXY_METADATA,
      protocolCapabilities: {
        ...MODERN_PROXY_METADATA.protocolCapabilities,
        verifiedFileUploads: undefined,
      },
    }
    wss.on('connection', ws => {
      ws.on('message', raw => {
        const msg = JSON.parse(String(raw)) as { type?: string }
        if (msg.type === 'file' || msg.type === 'fillFields') fileMutationCount += 1
        if (msg.type !== 'resize') return
        ws.send(JSON.stringify({
          type: 'frame',
          layout: { x: 0, y: 0, width: 1024, height: 768, children: [] },
          tree: { kind: 'box', props: {}, semantic: { tag: 'body', role: 'group' }, children: [] },
          ...unsafeProxyMetadata,
        }))
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
      await expect(sendFileUpload(session, ['/tmp/resume.pdf'], {
        fieldLabel: 'Resume',
      })).rejects.toThrow('file_upload_capability_required')
      await expect(sendFillFields(session, [{
        kind: 'file',
        fieldLabel: 'Resume',
        paths: ['/tmp/resume.pdf'],
      }])).rejects.toThrow('file_upload_capability_required')
      expect(fileMutationCount).toBe(0)
    } finally {
      disconnect()
      await new Promise<void>((resolve, reject) => wss.close(err => (err ? reject(err) : resolve())))
    }
  })

  it('does not let unrelated revisions or acknowledgements confirm a modern correlated action', async () => {
    const wss = new WebSocketServer({ port: 0 })
    wss.on('connection', ws => {
      ws.on('message', raw => {
        const msg = JSON.parse(String(raw)) as { type?: string; requestId?: string }

        if (msg.type === 'resize') {
          ws.send(JSON.stringify({
            type: 'frame',
            layout: { x: 0, y: 0, width: 1024, height: 768, children: [] },
            tree: { kind: 'box', props: {}, semantic: { tag: 'body', role: 'group' }, children: [] },
            ...MODERN_PROXY_METADATA,
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
              semantic: { tag: 'body', role: 'group', ariaLabel: 'Unrelated update' },
              children: [],
            },
            ...MODERN_PROXY_METADATA,
          }))
          ws.send(JSON.stringify({
            type: 'ack',
            requestId: `${msg.requestId}-other`,
            result: { wrongAction: true },
            ...MODERN_PROXY_METADATA,
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
      await expect(sendClick(session, 5, 5, 60)).resolves.toMatchObject({
        status: 'timed_out',
        timeoutMs: 60,
        requestId: expect.any(String),
        actionId: expect.any(String),
      })
    } finally {
      disconnect()
      await new Promise<void>((resolve, reject) => wss.close(err => (err ? reject(err) : resolve())))
    }
  })

  it('correlates every type/key phase and waits for the final scoped acknowledgement', async () => {
    const wss = new WebSocketServer({ port: 0 })
    const keyMessages: Array<{ eventType?: string; key?: string; requestId?: string }> = []
    wss.on('connection', ws => {
      ws.on('message', raw => {
        const msg = JSON.parse(String(raw)) as {
          type?: string
          eventType?: string
          key?: string
          requestId?: string
        }

        if (msg.type === 'resize') {
          ws.send(JSON.stringify({
            type: 'frame',
            layout: { x: 0, y: 0, width: 1024, height: 768, children: [] },
            tree: { kind: 'box', props: {}, semantic: { tag: 'body', role: 'group' }, children: [] },
            ...MODERN_PROXY_METADATA,
          }))
          return
        }
        if (msg.type !== 'key') return

        keyMessages.push(msg)
        if (msg.key === 'b' && msg.eventType === 'onKeyUp') {
          ws.send(JSON.stringify({
            type: 'ack',
            requestId: keyMessages[0]!.requestId,
            result: { phase: 'first' },
            ...MODERN_PROXY_METADATA,
          }))
          setTimeout(() => {
            ws.send(JSON.stringify({
              type: 'ack',
              requestId: msg.requestId,
              result: { phase: 'final' },
              ...MODERN_PROXY_METADATA,
            }))
          }, 20)
        } else if (msg.key === 'Enter') {
          ws.send(JSON.stringify({
            type: 'ack',
            requestId: msg.requestId,
            result: { key: 'Enter' },
            ...MODERN_PROXY_METADATA,
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
      await expect(sendType(session, 'ab', 100)).resolves.toMatchObject({
        status: 'acknowledged',
        result: { phase: 'final' },
      })
      await expect(sendKey(session, 'Enter', undefined, 100)).resolves.toMatchObject({
        status: 'acknowledged',
        result: { key: 'Enter' },
      })

      expect(keyMessages.slice(0, 4).map(message => message.eventType)).toEqual([
        'onKeyDown',
        'onKeyUp',
        'onKeyDown',
        'onKeyUp',
      ])
      expect(keyMessages.every(message => typeof message.requestId === 'string')).toBe(true)
      expect(new Set(keyMessages.map(message => message.requestId)).size).toBe(keyMessages.length)
    } finally {
      disconnect()
      await new Promise<void>((resolve, reject) => wss.close(err => (err ? reject(err) : resolve())))
    }
  })

  it('uses one bounded idempotent typeText request when the proxy advertises atomic typing', async () => {
    const wss = new WebSocketServer({ port: 0 })
    const actions: Array<Record<string, unknown>> = []
    const atomicMetadata = {
      ...MODERN_PROXY_METADATA,
      protocolCapabilities: {
        ...MODERN_PROXY_METADATA.protocolCapabilities,
        atomicTypeText: true,
      },
    }
    wss.on('connection', ws => {
      ws.on('message', raw => {
        const msg = JSON.parse(String(raw)) as { type?: string; requestId?: string }
        if (msg.type === 'resize') {
          ws.send(JSON.stringify({
            type: 'frame',
            layout: { x: 0, y: 0, width: 1024, height: 768, children: [] },
            tree: { kind: 'box', props: {}, semantic: { tag: 'body', role: 'group' }, children: [] },
            ...atomicMetadata,
          }))
          return
        }
        if (msg.type !== 'typeText') return
        actions.push(msg as Record<string, unknown>)
        ws.send(JSON.stringify({
          type: 'ack',
          requestId: msg.requestId,
          result: { typed: true },
          ...atomicMetadata,
        }))
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
      await expect(sendType(session, 'atomic text', 80)).resolves.toMatchObject({
        status: 'acknowledged',
        result: { typed: true },
      })
      expect(actions).toHaveLength(1)
      expect(actions[0]).toMatchObject({
        type: 'typeText',
        text: 'atomic text',
        actionTimeoutMs: 80,
        requestId: expect.stringMatching(UUID_PATTERN),
      })
    } finally {
      disconnect()
      await new Promise<void>((resolve, reject) => wss.close(err => (err ? reject(err) : resolve())))
    }
  })

  it('shares one action identity across concurrent identical mutations', async () => {
    const wss = new WebSocketServer({ port: 0 })
    const actions: Array<Record<string, unknown>> = []
    let mutationCount = 0
    wss.on('connection', ws => {
      ws.on('message', raw => {
        const msg = JSON.parse(String(raw)) as { type?: string; requestId?: string }
        if (msg.type === 'resize') {
          ws.send(JSON.stringify({
            type: 'frame',
            layout: { x: 0, y: 0, width: 1024, height: 768, children: [] },
            tree: { kind: 'box', props: {}, semantic: { tag: 'body', role: 'group' }, children: [] },
            ...MODERN_PROXY_METADATA,
          }))
          return
        }
        if (msg.type !== 'event') return
        actions.push(msg as Record<string, unknown>)
        if (actions.length === 1) {
          mutationCount += 1
          setTimeout(() => ws.send(JSON.stringify({
            type: 'ack',
            requestId: msg.requestId,
            result: { clickedOnce: true },
            ...MODERN_PROXY_METADATA,
          })), 25)
        } else {
          ws.send(JSON.stringify({
            type: 'error',
            code: 'DUPLICATE_REQUEST',
            requestId: msg.requestId,
            message: 'Duplicate requestId; action was not repeated',
            ...MODERN_PROXY_METADATA,
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
      const [first, second] = await Promise.all([
        sendClick(session, 7, 8, 100),
        sendClick(session, 7, 8, 100),
      ])
      expect(first).toMatchObject({ status: 'acknowledged', result: { clickedOnce: true } })
      expect(second).toMatchObject({
        status: 'acknowledged',
        requestId: first.requestId,
        actionId: first.actionId,
        result: { clickedOnce: true },
      })
      expect(actions).toHaveLength(2)
      expect(actions[1]).toEqual(actions[0])
      expect(mutationCount).toBe(1)
    } finally {
      disconnect()
      await new Promise<void>((resolve, reject) => wss.close(err => (err ? reject(err) : resolve())))
    }
  })

  it('pins a shared identity when one concurrent caller times out before the other receives its ACK', async () => {
    const wss = new WebSocketServer({ port: 0 })
    const actions: Array<Record<string, unknown>> = []
    let mutationCount = 0
    wss.on('connection', ws => {
      ws.on('message', raw => {
        const msg = JSON.parse(String(raw)) as { type?: string; requestId?: string }
        if (msg.type === 'resize') {
          ws.send(JSON.stringify({
            type: 'frame',
            layout: { x: 0, y: 0, width: 1024, height: 768, children: [] },
            tree: { kind: 'box', props: {}, semantic: { tag: 'body', role: 'group' }, children: [] },
            ...MODERN_PROXY_METADATA,
          }))
          return
        }
        if (msg.type !== 'event') return
        actions.push(msg as Record<string, unknown>)
        if (actions.length === 1) {
          mutationCount += 1
          setTimeout(() => ws.send(JSON.stringify({
            type: 'ack',
            requestId: msg.requestId,
            result: { clickedOnce: true },
            ...MODERN_PROXY_METADATA,
          })), 35)
        } else {
          ws.send(JSON.stringify({
            type: 'error',
            code: 'DUPLICATE_REQUEST',
            requestId: msg.requestId,
            message: 'Duplicate requestId; action was not repeated',
            ...MODERN_PROXY_METADATA,
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
      const longerCaller = sendClick(session, 17, 18, 100)
      const shorterCaller = sendClick(session, 17, 18, 10)
      const shortResult = await shorterCaller
      expect(shortResult).toMatchObject({ status: 'timed_out' })

      const longResult = await longerCaller
      expect(longResult).toMatchObject({
        status: 'acknowledged',
        requestId: shortResult.requestId,
        actionId: shortResult.actionId,
        result: { clickedOnce: true },
      })

      const recovery = await sendClick(session, 17, 18, 50)
      const laterIdenticalIntent = await sendClick(session, 17, 18, 50)
      expect(recovery).toEqual(longResult)
      expect(laterIdenticalIntent).toEqual(longResult)
      expect(actions).toHaveLength(2)
      expect(actions[1]).toEqual(actions[0])
      expect(mutationCount).toBe(1)
    } finally {
      disconnect()
      await new Promise<void>((resolve, reject) => wss.close(err => (err ? reject(err) : resolve())))
    }
  })

  it('fails a type sequence when an earlier key phase errors even if the final phase acks', async () => {
    const wss = new WebSocketServer({ port: 0 })
    let keyPhase = 0
    wss.on('connection', ws => {
      ws.on('message', raw => {
        const msg = JSON.parse(String(raw)) as { type?: string; requestId?: string; eventType?: string }
        if (msg.type === 'resize') {
          ws.send(JSON.stringify({
            type: 'frame',
            layout: { x: 0, y: 0, width: 1024, height: 768, children: [] },
            tree: { kind: 'box', props: {}, semantic: { tag: 'body', role: 'group' }, children: [] },
            ...MODERN_PROXY_METADATA,
          }))
          return
        }
        if (msg.type !== 'key') return
        keyPhase += 1
        if (keyPhase === 1) {
          ws.send(JSON.stringify({
            type: 'error',
            code: 'KEY_PHASE_FAILED',
            requestId: msg.requestId,
            message: 'first key phase failed',
            ...MODERN_PROXY_METADATA,
          }))
        } else if (keyPhase === 4) {
          ws.send(JSON.stringify({
            type: 'ack',
            requestId: msg.requestId,
            result: { finalPhase: true },
            ...MODERN_PROXY_METADATA,
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
      let failure: unknown
      try {
        await sendType(session, 'ab', 100)
      } catch (error) {
        failure = error
      }
      expect(failure).toBeInstanceOf(Error)
      expect((failure as Error).message).toContain('first key phase failed')
      expect(failure).toMatchObject({ code: 'KEY_PHASE_FAILED' })
      await expect(sendType(session, 'ab', 100)).rejects.toMatchObject({ code: 'KEY_PHASE_FAILED' })
      expect(keyPhase).toBe(4)
    } finally {
      disconnect()
      await new Promise<void>((resolve, reject) => wss.close(err => (err ? reject(err) : resolve())))
    }
  })

  it('keeps a multi-phase type ambiguous when a later phase expires after an earlier phase ran', async () => {
    const wss = new WebSocketServer({ port: 0 })
    let keyPhase = 0
    wss.on('connection', ws => {
      ws.on('message', raw => {
        const msg = JSON.parse(String(raw)) as { type?: string; requestId?: string }
        if (msg.type === 'resize') {
          ws.send(JSON.stringify({
            type: 'frame',
            layout: { x: 0, y: 0, width: 1024, height: 768, children: [] },
            tree: { kind: 'box', props: {}, semantic: { tag: 'body', role: 'group' }, children: [] },
            ...MODERN_PROXY_METADATA,
          }))
          return
        }
        if (msg.type !== 'key') return
        keyPhase += 1
        if (keyPhase === 3) {
          ws.send(JSON.stringify({
            type: 'error',
            code: 'ACTION_EXPIRED',
            requestId: msg.requestId,
            message: 'Later key phase expired before execution',
            ...MODERN_PROXY_METADATA,
          }))
        } else if (keyPhase === 4) {
          ws.send(JSON.stringify({
            type: 'ack',
            requestId: msg.requestId,
            ...MODERN_PROXY_METADATA,
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
      await expect(sendType(session, 'ab', 100)).rejects.toMatchObject({ code: 'ACTION_EXPIRED' })
      await expect(sendType(session, 'ab', 100)).rejects.toMatchObject({ code: 'ACTION_EXPIRED' })
      expect(keyPhase).toBe(4)
    } finally {
      disconnect()
      await new Promise<void>((resolve, reject) => wss.close(err => (err ? reject(err) : resolve())))
    }
  })

  it('never resends after timeout and promotes a later ACK under the original identity', async () => {
    const wss = new WebSocketServer({ port: 0 })
    const actions: Array<Record<string, unknown>> = []
    wss.on('connection', ws => {
      ws.on('message', raw => {
        const msg = JSON.parse(String(raw)) as { type?: string; requestId?: string }
        if (msg.type === 'resize') {
          ws.send(JSON.stringify({
            type: 'frame',
            layout: { x: 0, y: 0, width: 1024, height: 768, children: [] },
            tree: { kind: 'box', props: {}, semantic: { tag: 'body', role: 'group' }, children: [] },
            ...MODERN_PROXY_METADATA,
          }))
          return
        }
        if (msg.type !== 'event') return

        actions.push(msg as Record<string, unknown>)
        if (actions.length === 1) {
          setTimeout(() => {
            ws.send(JSON.stringify({
              type: 'ack',
              requestId: msg.requestId,
              result: { originalCompleted: true },
              ...MODERN_PROXY_METADATA,
            }))
          }, 90)
        } else {
          ws.send(JSON.stringify({
            type: 'error',
            code: 'DUPLICATE_REQUEST',
            requestId: msg.requestId,
            message: 'Duplicate requestId; action was not repeated',
            ...MODERN_PROXY_METADATA,
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
      const first = await sendClick(session, 8, 9, 30)
      expect(first).toMatchObject({
        status: 'timed_out',
        requestId: expect.stringMatching(UUID_PATTERN),
        actionId: expect.stringMatching(UUID_PATTERN),
      })

      const pendingRetry = await sendClick(session, 8, 9, 200)
      expect(pendingRetry).toMatchObject({
        status: 'timed_out',
        timeoutMs: 30,
        requestId: first.requestId,
        actionId: first.actionId,
      })
      await new Promise(resolve => setTimeout(resolve, 75))
      const settledRetry = await sendClick(session, 8, 9, 200)
      expect(settledRetry).toMatchObject({
        status: 'acknowledged',
        requestId: first.requestId,
        actionId: first.actionId,
        result: { originalCompleted: true },
      })
      await expect(sendClick(session, 8, 9, 200)).resolves.toEqual(settledRetry)
      expect(actions).toHaveLength(1)
      expect(actions[0]!.actionTimeoutMs).toBe(30)
    } finally {
      disconnect()
      await new Promise<void>((resolve, reject) => wss.close(err => (err ? reject(err) : resolve())))
    }
  })

  it('returns a cached late acknowledgement without replaying the mutation', async () => {
    const wss = new WebSocketServer({ port: 0 })
    let actionCount = 0
    wss.on('connection', ws => {
      ws.on('message', raw => {
        const msg = JSON.parse(String(raw)) as { type?: string; requestId?: string }
        if (msg.type === 'resize') {
          ws.send(JSON.stringify({
            type: 'frame',
            layout: { x: 0, y: 0, width: 1024, height: 768, children: [] },
            tree: { kind: 'box', props: {}, semantic: { tag: 'body', role: 'group' }, children: [] },
            ...MODERN_PROXY_METADATA,
          }))
          return
        }
        if (msg.type !== 'event') return
        actionCount += 1
        setTimeout(() => {
          ws.send(JSON.stringify({
            type: 'ack',
            requestId: msg.requestId,
            result: { late: true },
            ...MODERN_PROXY_METADATA,
          }))
        }, 55)
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
      const first = await sendClick(session, 11, 12, 20)
      expect(first.status).toBe('timed_out')
      await new Promise(resolve => setTimeout(resolve, 70))

      const retry = await sendClick(session, 11, 12, 20)
      expect(retry).toMatchObject({
        status: 'acknowledged',
        requestId: first.requestId,
        actionId: first.actionId,
        result: { late: true },
      })
      expect(actionCount).toBe(1)
    } finally {
      disconnect()
      await new Promise<void>((resolve, reject) => wss.close(err => (err ? reject(err) : resolve())))
    }
  })

  it('compacts an oversized late terminal result under the ambiguity retention cap', async () => {
    const wss = new WebSocketServer({ port: 0 })
    let actionCount = 0
    wss.on('connection', ws => {
      ws.on('message', raw => {
        const msg = JSON.parse(String(raw)) as { type?: string; requestId?: string }
        if (msg.type === 'resize') {
          ws.send(JSON.stringify({
            type: 'frame',
            layout: { x: 0, y: 0, width: 1024, height: 768, children: [] },
            tree: { kind: 'box', props: {}, semantic: { tag: 'body', role: 'group' }, children: [] },
            ...MODERN_PROXY_METADATA,
          }))
          return
        }
        if (msg.type !== 'event') return
        actionCount += 1
        setTimeout(() => ws.send(JSON.stringify({
          type: 'ack',
          requestId: msg.requestId,
          result: { pdf: 'x'.repeat(1_100_000) },
          ...MODERN_PROXY_METADATA,
        })), 25)
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
      const first = await sendClick(session, 29, 30, 10)
      expect(first.status).toBe('timed_out')
      await new Promise(resolve => setTimeout(resolve, 40))

      const retained = await sendClick(session, 29, 30, 30)
      expect(retained).toMatchObject({
        status: 'acknowledged',
        requestId: first.requestId,
        actionId: first.actionId,
        result: {
          retained: false,
          reason: expect.stringContaining('1 MiB'),
        },
      })
      await expect(sendClick(session, 29, 30, 30)).resolves.toEqual(retained)
      expect(actionCount).toBe(1)
    } finally {
      disconnect()
      await new Promise<void>((resolve, reject) => wss.close(err => (err ? reject(err) : resolve())))
    }
  })

  it('keeps a late terminal error ambiguity-classified under the original identity', async () => {
    const wss = new WebSocketServer({ port: 0 })
    let actionCount = 0
    wss.on('connection', ws => {
      ws.on('message', raw => {
        const msg = JSON.parse(String(raw)) as { type?: string; requestId?: string }
        if (msg.type === 'resize') {
          ws.send(JSON.stringify({
            type: 'frame',
            layout: { x: 0, y: 0, width: 1024, height: 768, children: [] },
            tree: { kind: 'box', props: {}, semantic: { tag: 'body', role: 'group' }, children: [] },
            ...MODERN_PROXY_METADATA,
          }))
          return
        }
        if (msg.type !== 'event') return
        actionCount += 1
        setTimeout(() => {
          ws.send(JSON.stringify({
            type: 'error',
            code: 'SNAPSHOT_FAILED',
            requestId: msg.requestId,
            message: 'snapshot failed after the browser action',
            ...MODERN_PROXY_METADATA,
          }))
        }, 45)
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
      const first = await sendClick(session, 21, 22, 15)
      expect(first.status).toBe('timed_out')
      await new Promise(resolve => setTimeout(resolve, 65))

      let retryError: unknown
      try {
        await sendClick(session, 21, 22, 30)
      } catch (error) {
        retryError = error
      }
      expect(retryError).toMatchObject({
        code: 'SNAPSHOT_FAILED',
        requestId: first.requestId,
        actionId: first.actionId,
      })
      expect((retryError as Error).message).toContain(
        `Outcome is ambiguous for actionId ${first.actionId} (requestId ${first.requestId})`,
      )
      expect(actionCount).toBe(1)
    } finally {
      disconnect()
      await new Promise<void>((resolve, reject) => wss.close(err => (err ? reject(err) : resolve())))
    }
  })

  it('keeps a late protocol-mismatch acknowledgement ambiguity-classified', async () => {
    const wss = new WebSocketServer({ port: 0 })
    let actionCount = 0
    wss.on('connection', ws => {
      ws.on('message', raw => {
        const msg = JSON.parse(String(raw)) as { type?: string; requestId?: string }
        if (msg.type === 'resize') {
          ws.send(JSON.stringify({
            type: 'frame',
            layout: { x: 0, y: 0, width: 1024, height: 768, children: [] },
            tree: { kind: 'box', props: {}, semantic: { tag: 'body', role: 'group' }, children: [] },
            ...MODERN_PROXY_METADATA,
          }))
          return
        }
        if (msg.type !== 'file') return
        actionCount += 1
        setTimeout(() => {
          ws.send(JSON.stringify({
            type: 'ack',
            requestId: msg.requestId,
            ...MODERN_PROXY_METADATA,
            proxyActionProtocolVersion: 1,
          }))
        }, 45)
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
      const first = await sendFileUpload(session, ['/tmp/resume.pdf'], {
        fieldKey: 'ff:0.0',
        fieldLabel: 'Resume',
      }, 15)
      expect(first.status).toBe('timed_out')
      await new Promise(resolve => setTimeout(resolve, 65))

      await expect(sendFileUpload(session, ['/tmp/resume.pdf'], {
        fieldKey: 'ff:0.0',
        fieldLabel: 'Resume',
      }, 30)).rejects.toMatchObject({
        code: 'ACTION_OUTCOME_AMBIGUOUS',
        requestId: first.requestId,
        actionId: first.actionId,
        message: expect.stringContaining(
          `Outcome is ambiguous for actionId ${first.actionId} (requestId ${first.requestId})`,
        ),
      })
      expect(actionCount).toBe(1)
    } finally {
      disconnect()
      await new Promise<void>((resolve, reject) => wss.close(err => (err ? reject(err) : resolve())))
    }
  })

  it('keeps a late safe non-execution error non-ambiguous', async () => {
    const wss = new WebSocketServer({ port: 0 })
    let actionCount = 0
    const requestIds: string[] = []
    wss.on('connection', ws => {
      ws.on('message', raw => {
        const msg = JSON.parse(String(raw)) as { type?: string; requestId?: string }
        if (msg.type === 'resize') {
          ws.send(JSON.stringify({
            type: 'frame',
            layout: { x: 0, y: 0, width: 1024, height: 768, children: [] },
            tree: { kind: 'box', props: {}, semantic: { tag: 'body', role: 'group' }, children: [] },
            ...MODERN_PROXY_METADATA,
          }))
          return
        }
        if (msg.type !== 'event') return
        actionCount += 1
        requestIds.push(msg.requestId!)
        if (actionCount === 1) setTimeout(() => {
          ws.send(JSON.stringify({
            type: 'error',
            code: 'ACTION_EXPIRED',
            requestId: msg.requestId,
            message: 'action expired before execution',
            ...MODERN_PROXY_METADATA,
          }))
        }, 45)
        else ws.send(JSON.stringify({
          type: 'ack',
          requestId: msg.requestId,
          result: { executedFreshIntent: true },
          ...MODERN_PROXY_METADATA,
        }))
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
      const first = await sendClick(session, 23, 24, 15)
      expect(first.status).toBe('timed_out')
      await new Promise(resolve => setTimeout(resolve, 65))

      let retryError: unknown
      try {
        await sendClick(session, 23, 24, 30)
      } catch (error) {
        retryError = error
      }
      expect(retryError).toMatchObject({
        code: 'ACTION_EXPIRED',
        requestId: first.requestId,
        actionId: first.actionId,
      })
      expect((retryError as Error).message).toBe('action expired before execution')
      const fresh = await sendClick(session, 23, 24, 30)
      expect(fresh).toMatchObject({
        status: 'acknowledged',
        result: { executedFreshIntent: true },
      })
      expect(fresh.requestId).not.toBe(first.requestId)
      expect(fresh.actionId).not.toBe(first.actionId)
      expect(requestIds).toEqual([first.requestId, fresh.requestId])
      expect(actionCount).toBe(2)
    } finally {
      disconnect()
      await new Promise<void>((resolve, reject) => wss.close(err => (err ? reject(err) : resolve())))
    }
  })

  it('forgets a safe non-execution tombstone after an active waiter receives it', async () => {
    const wss = new WebSocketServer({ port: 0 })
    const requestIds: string[] = []
    wss.on('connection', ws => {
      ws.on('message', raw => {
        const msg = JSON.parse(String(raw)) as { type?: string; requestId?: string }
        if (msg.type === 'resize') {
          ws.send(JSON.stringify({
            type: 'frame',
            layout: { x: 0, y: 0, width: 1024, height: 768, children: [] },
            tree: { kind: 'box', props: {}, semantic: { tag: 'body', role: 'group' }, children: [] },
            ...MODERN_PROXY_METADATA,
          }))
          return
        }
        if (msg.type !== 'event') return
        requestIds.push(msg.requestId!)
        ws.send(JSON.stringify(requestIds.length === 1
          ? {
              type: 'error',
              code: 'ACTION_EXPIRED',
              requestId: msg.requestId,
              message: 'action expired before execution',
              ...MODERN_PROXY_METADATA,
            }
          : {
              type: 'ack',
              requestId: msg.requestId,
              result: { executedFreshIntent: true },
              ...MODERN_PROXY_METADATA,
            }))
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
      await expect(sendClick(session, 27, 28, 50)).rejects.toMatchObject({ code: 'ACTION_EXPIRED' })
      const fresh = await sendClick(session, 27, 28, 50)
      expect(fresh).toMatchObject({ status: 'acknowledged', result: { executedFreshIntent: true } })
      expect(requestIds).toHaveLength(2)
      expect(requestIds[1]).not.toBe(requestIds[0])
    } finally {
      disconnect()
      await new Promise<void>((resolve, reject) => wss.close(err => (err ? reject(err) : resolve())))
    }
  })

  it('retains action identity when extraction fails after a mutation', async () => {
    const wss = new WebSocketServer({ port: 0 })
    const actions: Array<Record<string, unknown>> = []
    let mutationCount = 0
    wss.on('connection', ws => {
      ws.on('message', raw => {
        const msg = JSON.parse(String(raw)) as { type?: string; requestId?: string }
        if (msg.type === 'resize') {
          ws.send(JSON.stringify({
            type: 'frame',
            layout: { x: 0, y: 0, width: 1024, height: 768, children: [] },
            tree: { kind: 'box', props: {}, semantic: { tag: 'body', role: 'group' }, children: [] },
            ...MODERN_PROXY_METADATA,
          }))
          return
        }
        if (msg.type !== 'event') return

        actions.push(msg as Record<string, unknown>)
        if (actions.length === 1) {
          mutationCount += 1
          ws.send(JSON.stringify({
            type: 'error',
            code: 'ACTION_OUTCOME_AMBIGUOUS',
            requestId: msg.requestId,
            message: 'snapshot extraction failed after click',
            ...MODERN_PROXY_METADATA,
          }))
        } else {
          ws.send(JSON.stringify({
            type: 'error',
            code: 'DUPLICATE_REQUEST',
            requestId: msg.requestId,
            message: 'Duplicate requestId; action was not repeated',
            ...MODERN_PROXY_METADATA,
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
      await expect(sendClick(session, 13, 14, 30)).rejects.toThrow(
        /snapshot extraction failed after click.*Outcome is ambiguous for actionId [0-9a-f-]+ \(requestId [0-9a-f-]+\); do not retry blindly/i,
      )

      await expect(sendClick(session, 13, 14, 40)).rejects.toMatchObject({
        code: 'ACTION_OUTCOME_AMBIGUOUS',
        requestId: actions[0]!.requestId,
        actionId: expect.stringMatching(UUID_PATTERN),
      })
      expect(actions).toHaveLength(1)
      expect(mutationCount).toBe(1)
    } finally {
      disconnect()
      await new Promise<void>((resolve, reject) => wss.close(err => (err ? reject(err) : resolve())))
    }
  })

  it('never resends a multi-phase type after its outcome times out', async () => {
    const wss = new WebSocketServer({ port: 0 })
    const keyMessages: Array<Record<string, unknown>> = []
    wss.on('connection', ws => {
      ws.on('message', raw => {
        const msg = JSON.parse(String(raw)) as { type?: string; requestId?: string; eventType?: string; key?: string }
        if (msg.type === 'resize') {
          ws.send(JSON.stringify({
            type: 'frame',
            layout: { x: 0, y: 0, width: 1024, height: 768, children: [] },
            tree: { kind: 'box', props: {}, semantic: { tag: 'body', role: 'group' }, children: [] },
            ...MODERN_PROXY_METADATA,
          }))
          return
        }
        if (msg.type !== 'key') return

        keyMessages.push(msg as Record<string, unknown>)
        if (keyMessages.length === 4) {
          setTimeout(() => {
            ws.send(JSON.stringify({
              type: 'ack',
              requestId: msg.requestId,
              result: { typedOnce: true },
              ...MODERN_PROXY_METADATA,
            }))
          }, 90)
        } else if (keyMessages.length > 4) {
          ws.send(JSON.stringify({
            type: 'error',
            code: 'DUPLICATE_REQUEST',
            requestId: msg.requestId,
            message: 'Duplicate requestId; action was not repeated',
            ...MODERN_PROXY_METADATA,
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
      const first = await sendType(session, 'ab', 30)
      expect(first.status).toBe('timed_out')
      const pendingRetry = await sendType(session, 'ab', 200)
      expect(pendingRetry).toMatchObject({
        status: 'timed_out',
        timeoutMs: 30,
        requestId: first.requestId,
        actionId: first.actionId,
      })
      await new Promise(resolve => setTimeout(resolve, 75))
      const settledRetry = await sendType(session, 'ab', 200)
      expect(settledRetry).toMatchObject({
        status: 'acknowledged',
        requestId: first.requestId,
        actionId: first.actionId,
        result: { typedOnce: true },
      })
      await expect(sendType(session, 'ab', 200)).resolves.toEqual(settledRetry)
      expect(keyMessages).toHaveLength(4)
      expect(new Set(keyMessages.slice(0, 4).map(message => message.requestId)).size).toBe(4)
      expect(keyMessages.slice(0, 4).every(message => message.actionTimeoutMs === 30)).toBe(true)
    } finally {
      disconnect()
      await new Promise<void>((resolve, reject) => wss.close(err => (err ? reject(err) : resolve())))
    }
  })

  it('pins concurrent identical intent for a peer without idempotent request IDs', async () => {
    const wss = new WebSocketServer({ port: 0 })
    const actions: Array<Record<string, unknown>> = []
    wss.on('connection', ws => {
      ws.on('message', raw => {
        const msg = JSON.parse(String(raw)) as { type?: string; requestId?: string }
        if (msg.type === 'resize') {
          ws.send(JSON.stringify({
            type: 'frame',
            protocolVersion: 1,
            geometryProtocolVersion: 1,
            protocolCapabilities: {
              transport: 'native',
              requestScopedAcks: true,
              proxyActions: false,
            },
            layout: { x: 0, y: 0, width: 1024, height: 768, children: [] },
            tree: { kind: 'box', props: {}, semantic: { tag: 'body', role: 'group' }, children: [] },
          }))
          return
        }
        if (msg.type === 'event') {
          actions.push(msg as Record<string, unknown>)
          setTimeout(() => ws.send(JSON.stringify({
            type: 'ack',
            requestId: msg.requestId,
            protocolVersion: 1,
            geometryProtocolVersion: 1,
            protocolCapabilities: {
              transport: 'native',
              requestScopedAcks: true,
              proxyActions: false,
            },
            result: { completedOnce: true },
          })), 35)
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
      const original = sendClick(session, 20, 20, 100)
      const concurrent = await sendClick(session, 20, 20, 10)
      expect(concurrent).toMatchObject({
        status: 'timed_out',
        timeoutMs: 100,
      })
      const confirmed = await original
      expect(confirmed).toMatchObject({
        status: 'acknowledged',
        requestId: concurrent.requestId,
        actionId: concurrent.actionId,
        result: { completedOnce: true },
      })
      await expect(sendClick(session, 20, 20, 20)).resolves.toEqual(confirmed)
      expect(actions).toHaveLength(1)
      expect(actions[0]).not.toHaveProperty('actionTimeoutMs')
    } finally {
      disconnect()
      await new Promise<void>((resolve, reject) => wss.close(err => (err ? reject(err) : resolve())))
    }
  })

  it('falls back to the latest observed update for an explicitly negotiated legacy peer', async () => {
    const wss = new WebSocketServer({ port: 0 })
    wss.on('connection', ws => {
      ws.on('message', raw => {
        const msg = JSON.parse(String(raw)) as { type?: string }

        if (msg.type === 'resize') {
          ws.send(JSON.stringify({
            type: 'frame',
            layout: { x: 0, y: 0, width: 1024, height: 768, children: [] },
            tree: { kind: 'box', props: {}, semantic: { tag: 'body', role: 'group' }, children: [] },
            protocolVersion: 1,
            geometryProtocolVersion: 1,
            protocolCapabilities: {
              transport: 'native',
              requestScopedAcks: false,
              proxyActions: false,
            },
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
    const sensitiveTarget = 'https://jobs.example.com/application/private?candidate=taylor%40example.com#resume'
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
            result: { pageUrl: msg.url, submittedEmail: 'taylor@example.com' },
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
      lifecycleMocks.recordSessionSnapshot.mockClear()
      await expect(sendNavigate(session, sensitiveTarget, 80)).resolves.toMatchObject({
        status: 'updated',
        timeoutMs: 80,
        result: { pageUrl: sensitiveTarget, submittedEmail: 'taylor@example.com' },
      })
      expect(received.some(message => message.type === 'navigate' && message.url === sensitiveTarget)).toBe(true)

      const navigationSnapshot = lifecycleMocks.recordSessionSnapshot.mock.calls.find(
        call => call[1] === 'session.navigate',
      )
      expect(navigationSnapshot?.[2]).toEqual({
        requestedOrigin: 'https://jobs.example.com',
        status: 'updated',
      })
      const persistedSnapshot = JSON.stringify(navigationSnapshot?.[2])
      expect(persistedSnapshot).not.toContain('/application/private')
      expect(persistedSnapshot).not.toContain('candidate=')
      expect(persistedSnapshot).not.toContain('taylor@example.com')
    } finally {
      disconnect()
      await new Promise<void>((resolve, reject) => wss.close(err => (err ? reject(err) : resolve())))
    }
  })

  it('does not promote a late navigation ACK without a fresh post-action frame', async () => {
    const wss = new WebSocketServer({ port: 0 })
    const navigateMessages: Array<Record<string, unknown>> = []
    wss.on('connection', ws => {
      ws.on('message', raw => {
        const msg = JSON.parse(String(raw)) as { type?: string; requestId?: string; url?: string }
        if (msg.type === 'resize') {
          ws.send(JSON.stringify({
            type: 'frame',
            layout: { x: 0, y: 0, width: 1024, height: 768, children: [] },
            tree: { kind: 'box', props: {}, semantic: { tag: 'body', role: 'group' }, children: [] },
            ...MODERN_PROXY_METADATA,
          }))
          return
        }
        if (msg.type !== 'navigate') return
        navigateMessages.push(msg as Record<string, unknown>)
        if (navigateMessages.length === 1) {
          setTimeout(() => ws.send(JSON.stringify({
            type: 'ack',
            requestId: msg.requestId,
            result: { pageUrl: msg.url },
            ...MODERN_PROXY_METADATA,
          })), 35)
        } else {
          ws.send(JSON.stringify({
            type: 'error',
            code: 'DUPLICATE_REQUEST',
            requestId: msg.requestId,
            message: 'Duplicate requestId; action was not repeated',
            ...MODERN_PROXY_METADATA,
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
      const first = await sendNavigate(session, 'https://jobs.example.com/late', 15)
      expect(first.status).toBe('timed_out')
      await new Promise(resolve => setTimeout(resolve, 45))
      const retry = await sendNavigate(session, 'https://jobs.example.com/late', 25)
      expect(retry).toMatchObject({
        status: 'timed_out',
        timeoutMs: 15,
        requestId: first.requestId,
        actionId: first.actionId,
      })
      expect(navigateMessages).toHaveLength(1)
    } finally {
      disconnect()
      await new Promise<void>((resolve, reject) => wss.close(err => (err ? reject(err) : resolve())))
    }
  })

  it('ignores stale ACKs and capability metadata from a replaced transport', async () => {
    const wss = new WebSocketServer({ port: 0 })
    let resolveEventSeen!: () => void
    const eventSeen = new Promise<void>(resolve => { resolveEventSeen = resolve })
    wss.on('connection', ws => {
      ws.on('message', raw => {
        const msg = JSON.parse(String(raw)) as { type?: string; requestId?: string }
        if (msg.type === 'resize') {
          ws.send(JSON.stringify({
            type: 'frame',
            layout: { x: 0, y: 0, width: 1024, height: 768, children: [] },
            tree: { kind: 'box', props: {}, semantic: { tag: 'body', role: 'group' }, children: [] },
            ...MODERN_PROXY_METADATA,
          }))
          return
        }
        if (msg.type !== 'event') return
        resolveEventSeen()
        setTimeout(() => ws.send(JSON.stringify({
          type: 'ack',
          requestId: msg.requestId,
          protocolVersion: 1,
          geometryProtocolVersion: 1,
          protocolCapabilities: {
            transport: 'native',
            requestScopedAcks: false,
            proxyActions: false,
          },
        })), 15)
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

    let original: WsClient | undefined
    try {
      const url = `ws://127.0.0.1:${port}`
      const session = await connect(url)
      original = session.ws
      const pending = sendClick(session, 9, 10, 45)
      await eventSeen
      const replacement = new WsClient(url)
      await new Promise<void>((resolve, reject) => {
        replacement.once('open', resolve)
        replacement.once('error', reject)
      })
      session.ws = replacement

      await expect(pending).resolves.toMatchObject({ status: 'timed_out' })
      expect(session.peerTransport).toBe('proxy')
    } finally {
      disconnect()
      original?.close()
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
      session.cachedA11y = { role: 'group', name: 'Old cached UI' } as never
      session.cachedA11yRevision = session.updateRevision
      session.cachedFormSchemas?.set('old', { revision: session.updateRevision, forms: [] })
      await new Promise<void>(resolve => {
        if (session.ws.readyState === session.ws.CLOSED) {
          resolve()
          return
        }
        session.ws.once('close', () => resolve())
        session.ws.close()
      })

      expect(session.hasFreshFrame).toBe(false)
      expect(session.tree).toBeNull()
      expect(session.layout).toBeNull()
      expect(session.cachedA11y).toBeNull()
      expect(session.cachedFormSchemas?.size).toBe(0)

      await expect(sendClick(session, 5, 5, 150)).resolves.toMatchObject({
        status: 'updated',
        timeoutMs: 150,
        result: { ok: true },
      })
      expect(connectionCount).toBeGreaterThanOrEqual(2)
      expect(session.hasFreshFrame).toBe(true)
      expect((session.tree?.semantic as { ariaLabel?: string } | undefined)?.ariaLabel).toBe('Reconnected')
    } finally {
      disconnect()
      await new Promise<void>((resolve, reject) => wss.close(err => (err ? reject(err) : resolve())))
    }
  })

  it('does not let a disconnected Session handle reconnect and resurrect itself', async () => {
    const wss = new WebSocketServer({ port: 0 })
    let connectionCount = 0
    wss.on('connection', ws => {
      connectionCount += 1
      ws.on('message', raw => {
        const msg = JSON.parse(String(raw)) as { type?: string }
        if (msg.type !== 'resize') return
        ws.send(JSON.stringify({
          type: 'frame',
          layout: { x: 0, y: 0, width: 1024, height: 768, children: [] },
          tree: { kind: 'box', props: {}, semantic: { tag: 'body', role: 'group' }, children: [] },
        }))
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
      disconnect({ sessionId: session.id })

      await expect(sendClick(session, 5, 5, 100)).rejects.toThrow(
        'disconnected or no longer owns its transport',
      )
      expect(connectionCount).toBe(1)
      expect(session.disposed).toBe(true)
      expect(session.hasFreshFrame).toBe(false)
    } finally {
      await new Promise<void>((resolve, reject) => wss.close(err => (err ? reject(err) : resolve())))
    }
  })

  it('keeps the proxy capability private and reuses it on reconnect', async () => {
    const wss = new WebSocketServer({ port: 0 })
    const token = 'mcp-private-proxy-capability-0000000000000000'
    const authorizationHeaders: Array<string | undefined> = []
    const proxyMetadata = {
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
    }
    wss.on('connection', (ws, request) => {
      authorizationHeaders.push(request.headers.authorization)
      ws.send(JSON.stringify({ type: 'hello', ...proxyMetadata }))
      ws.on('message', raw => {
        const msg = JSON.parse(String(raw)) as { type?: string; requestId?: string }
        if (msg.type !== 'event') return
        ws.send(JSON.stringify({
          type: 'frame',
          layout: { x: 0, y: 0, width: 1024, height: 768, children: [] },
          tree: { kind: 'box', props: {}, semantic: { tag: 'body', role: 'group' }, children: [] },
          ...proxyMetadata,
        }))
        ws.send(JSON.stringify({
          type: 'ack',
          requestId: msg.requestId,
          result: { ok: true },
          ...proxyMetadata,
        }))
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
      const url = `ws://127.0.0.1:${port}`
      const session = await connect(url, { authToken: token, awaitInitialFrame: false })
      expect(session.url).toBe(url)
      expect(session.url).not.toContain(token)
      await new Promise<void>(resolve => {
        session.ws.once('close', () => resolve())
        session.ws.close()
      })

      await expect(sendClick(session, 5, 5, 150)).resolves.toMatchObject({
        status: 'updated',
        result: { ok: true },
      })
      expect(authorizationHeaders).toEqual([
        `Bearer ${token}`,
        `Bearer ${token}`,
      ])
    } finally {
      disconnect()
      await new Promise<void>((resolve, reject) => wss.close(err => (err ? reject(err) : resolve())))
    }
  })

  it('re-attests the proxy after reconnect before retrying an action', async () => {
    const wss = new WebSocketServer({ port: 0 })
    const token = 'mcp-reconnect-proxy-capability-000000000000000'
    let connectionCount = 0
    let actionReachedReplacement = false
    wss.on('connection', ws => {
      connectionCount += 1
      if (connectionCount === 1) {
        ws.send(JSON.stringify({
          type: 'hello',
          protocolVersion: 1,
          geometryProtocolVersion: 1,
          proxyActionProtocolVersion: 2,
          protocolCapabilities: {
            transport: 'proxy',
            authenticatedController: true,
          },
        }))
      }
      ws.on('message', raw => {
        const msg = JSON.parse(String(raw)) as { type?: string }
        if (connectionCount !== 2) return
        if (msg.type === 'event') actionReachedReplacement = true
        if (msg.type === 'resize') {
          // Simulate an older unauthenticated proxy taking over the same
          // endpoint. A stale capability cache must not bless this frame.
          ws.send(JSON.stringify({
            type: 'frame',
            protocolVersion: 2,
            layout: { x: 0, y: 0, width: 1024, height: 768, children: [] },
            tree: { kind: 'box', props: {}, children: [] },
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
      const session = await connect(`ws://127.0.0.1:${port}`, {
        authToken: token,
        awaitInitialFrame: false,
      })
      await new Promise<void>(resolve => {
        session.ws.once('close', () => resolve())
        session.ws.close()
      })

      await expect(sendClick(session, 5, 5, 150)).rejects.toThrow(
        'unauthenticated proxy transports are refused',
      )
      expect(connectionCount).toBe(2)
      expect(actionReachedReplacement).toBe(false)
    } finally {
      disconnect()
      await new Promise<void>((resolve, reject) => wss.close(err => (err ? reject(err) : resolve())))
    }
  })

  it('re-checks verified file-upload capability after reconnect before sending a file', async () => {
    const wss = new WebSocketServer({ port: 0 })
    const token = 'mcp-reconnect-file-capability-00000000000000000'
    let connectionCount = 0
    let fileReachedReplacement = false
    const replacementMetadata = {
      ...MODERN_PROXY_METADATA,
      protocolCapabilities: {
        ...MODERN_PROXY_METADATA.protocolCapabilities,
        verifiedFileUploads: undefined,
      },
    }
    wss.on('connection', ws => {
      const connectionIndex = ++connectionCount
      if (connectionIndex === 1) {
        ws.send(JSON.stringify({ type: 'hello', ...MODERN_PROXY_METADATA }))
      }
      ws.on('message', raw => {
        const msg = JSON.parse(String(raw)) as { type?: string }
        if (connectionIndex !== 2) return
        if (msg.type === 'file') fileReachedReplacement = true
        if (msg.type === 'resize') {
          ws.send(JSON.stringify({
            type: 'frame',
            layout: { x: 0, y: 0, width: 1024, height: 768, children: [] },
            tree: { kind: 'box', props: {}, children: [] },
            ...replacementMetadata,
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
      const session = await connect(`ws://127.0.0.1:${port}`, {
        authToken: token,
        awaitInitialFrame: false,
      })
      expect(session.peerProtocolCapabilities?.verifiedFileUploads).toBe(true)
      await new Promise<void>(resolve => {
        session.ws.once('close', () => resolve())
        session.ws.close()
      })

      await expect(sendFileUpload(session, ['/tmp/resume.pdf'], {
        fieldLabel: 'Resume',
      }, 150)).rejects.toThrow('file_upload_capability_required')
      expect(connectionCount).toBe(2)
      expect(fileReachedReplacement).toBe(false)
    } finally {
      disconnect()
      await new Promise<void>((resolve, reject) => wss.close(err => (err ? reject(err) : resolve())))
    }
  })

  it('refuses a spawned-style proxy that cannot attest authenticated control', async () => {
    const wss = new WebSocketServer({ port: 0 })
    wss.on('connection', ws => {
      ws.send(JSON.stringify({
        type: 'frame',
        protocolVersion: 2,
        layout: { x: 0, y: 0, width: 10, height: 10, children: [] },
        tree: { kind: 'box', props: {}, children: [] },
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

    try {
      await expect(connect(`ws://127.0.0.1:${port}`, {
        authToken: 'mcp-private-proxy-capability-0000000000000000',
        awaitInitialFrame: false,
      })).rejects.toThrow('unauthenticated proxy transports are refused')
    } finally {
      disconnect()
      await new Promise<void>((resolve, reject) => wss.close(err => (err ? reject(err) : resolve())))
    }
  })

  it('rejects a server frame from a newer unnegotiated protocol', async () => {
    const wss = new WebSocketServer({ port: 0 })
    wss.on('connection', ws => {
      ws.send(JSON.stringify({
        type: 'frame',
        protocolVersion: 999,
        layout: { x: 0, y: 0, width: 10, height: 10, children: [] },
        tree: { kind: 'box', props: {}, children: [] },
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

    try {
      await expect(connect(`ws://127.0.0.1:${port}`)).rejects.toThrow(
        "Server protocol 999 is newer than MCP's supported geometry/proxy protocols",
      )
    } finally {
      disconnect()
      await new Promise<void>((resolve, reject) => wss.close(err => (err ? reject(err) : resolve())))
    }
  })

  it('surfaces an initial wire error instead of timing out', async () => {
    const wss = new WebSocketServer({ port: 0 })
    wss.on('connection', ws => {
      ws.send(JSON.stringify({
        type: 'error',
        message: 'explicit compatibility failure',
        protocolVersion: 1,
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

    try {
      await expect(connect(`ws://127.0.0.1:${port}`)).rejects.toThrow('explicit compatibility failure')
    } finally {
      disconnect()
      await new Promise<void>((resolve, reject) => wss.close(err => (err ? reject(err) : resolve())))
    }
  })

  it('closes a connected peer that later sends an incompatible frame', async () => {
    const wss = new WebSocketServer({ port: 0 })
    wss.on('connection', ws => {
      ws.on('message', raw => {
        const msg = JSON.parse(String(raw)) as { type?: string }
        if (msg.type !== 'resize') return
        ws.send(JSON.stringify({
          type: 'frame',
          protocolVersion: 1,
          layout: { x: 0, y: 0, width: 10, height: 10, children: [] },
          tree: { kind: 'box', props: {}, children: [] },
        }))
        setTimeout(() => {
          ws.send(JSON.stringify({
            type: 'frame',
            protocolVersion: 999,
            layout: { x: 0, y: 0, width: 999, height: 10, children: [] },
            tree: { kind: 'box', props: {}, children: [] },
          }))
        }, 10)
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
      await new Promise<void>(resolve => session.ws.once('close', () => resolve()))
      expect(session.layout).toBeNull()
      expect(session.tree).toBeNull()
    } finally {
      disconnect()
      await new Promise<void>((resolve, reject) => wss.close(err => (err ? reject(err) : resolve())))
    }
  })
})
