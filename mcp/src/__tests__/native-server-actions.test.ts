import { afterEach, describe, expect, it } from 'vitest'
import { box } from '@geometra/core'
import { createStandaloneTestServer } from '../../../packages/server/src/__tests__/test-helpers.js'
import { connect, disconnect, sendClick } from '../session.js'

describe('native Geometra server actions', () => {
  afterEach(() => {
    disconnect()
  })

  it('negotiates GEOM v1 separately from proxy actions and dispatches a click', async () => {
    let clicked = false
    const { server, port } = await createStandaloneTestServer(
      () => box({
        width: 40,
        height: 20,
        onClick: () => { clicked = true },
      }, []),
      { width: 200, height: 100 },
    )

    try {
      const session = await connect(`ws://127.0.0.1:${port}`)

      expect(session).toMatchObject({
        peerTransport: 'native',
        peerGeometryProtocolVersion: 1,
      })
      expect(session.peerProxyActionProtocolVersion).toBeUndefined()
      await expect(sendClick(session, 10, 10, 500)).resolves.toMatchObject({
        status: expect.stringMatching(/updated|acknowledged/),
      })
      expect(clicked).toBe(true)
    } finally {
      disconnect()
      server.close()
    }
  })
})
