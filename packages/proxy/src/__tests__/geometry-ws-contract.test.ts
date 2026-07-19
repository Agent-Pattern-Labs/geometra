import { describe, expect, it, vi } from 'vitest'
import type { Page } from 'playwright'
import type { WebSocket } from 'ws'
import { createFillLookupCache } from '../dom-actions.ts'
import { handleClientMessage } from '../geometry-ws.ts'

// Source modules intentionally use .js specifiers for ESM build output; map
// this dependency back to the live TypeScript source for the unit test.
vi.mock('../types.js', async () => await import('../types.ts'))

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
