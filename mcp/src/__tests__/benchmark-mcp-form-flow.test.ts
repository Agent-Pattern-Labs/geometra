import { describe, expect, it, vi } from 'vitest'
import {
  cleanupGeometraSessions,
  runGeometraFlow,
} from '../../../scripts/benchmark-mcp-form-flow.mjs'

function mcpJson(value: unknown) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
  }
}

function benchmarkOptions() {
  return { headless: true, slowMo: 0 }
}

function benchmarkScenario() {
  return {
    steps: [{ kind: 'text', label: 'Full name', value: 'Taylor Applicant' }],
  }
}

describe('MCP form-flow benchmark session cleanup', () => {
  it('uses explicit warm reuse and tears down both payload session ids', async () => {
    const activeSessionIds = new Set<string>()
    const fillForm = vi
      .fn()
      .mockImplementationOnce(async () => {
        activeSessionIds.add('cold-session')
        return mcpJson({ sessionId: 'cold-session', final: { invalidCount: 0 } })
      })
      .mockImplementationOnce(async () => {
        activeSessionIds.add('warm-session')
        return mcpJson({ sessionId: 'warm-session', final: { invalidCount: 0 } })
      })
    const disconnect = vi.fn(async ({ sessionId }: { sessionId: string }) => {
      activeSessionIds.delete(sessionId)
      return mcpJson({ ok: true })
    })
    const listSessions = vi.fn(async () =>
      mcpJson({
        defaultSessionId: null,
        sessions: [...activeSessionIds].map(id => ({ id, url: 'http://benchmark.test/' })),
      }),
    )
    const createServer = () => ({
      _registeredTools: {
        geometra_fill_form: { handler: fillForm },
        geometra_disconnect: { handler: disconnect },
        geometra_list_sessions: { handler: listSessions },
      },
    })

    const result = await runGeometraFlow(
      'http://benchmark.test/',
      createServer,
      benchmarkScenario(),
      benchmarkOptions(),
    )

    expect(result.fillPayload.sessionId).toBe('cold-session')
    expect(result.warm.fillPayload.sessionId).toBe('warm-session')
    expect(fillForm).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ isolated: false, pageUrl: 'http://benchmark.test/' }),
    )
    expect(fillForm).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ isolated: false, pageUrl: 'http://benchmark.test/?bench=warm' }),
    )
    expect(disconnect.mock.calls).toEqual([
      [{ sessionId: 'cold-session' }],
      [{ sessionId: 'cold-session', closeBrowser: true }],
      [{ sessionId: 'warm-session', closeBrowser: true }],
    ])
    expect(activeSessionIds).toHaveLength(0)
    expect(listSessions).toHaveBeenCalledTimes(3)
  })

  it('preserves sessions that were active before the benchmark ownership baseline', async () => {
    const activeSessionIds = new Set<string>(['peer-session'])
    const fillForm = vi
      .fn()
      .mockImplementationOnce(async () => {
        activeSessionIds.add('cold-session')
        return mcpJson({ sessionId: 'cold-session', final: { invalidCount: 0 } })
      })
      .mockImplementationOnce(async () => {
        activeSessionIds.add('warm-session')
        return mcpJson({ sessionId: 'warm-session', final: { invalidCount: 0 } })
      })
    const disconnect = vi.fn(async ({ sessionId }: { sessionId: string }) => {
      activeSessionIds.delete(sessionId)
      return mcpJson({ ok: true })
    })
    const listSessions = vi.fn(async () =>
      mcpJson({
        defaultSessionId: 'peer-session',
        sessions: [...activeSessionIds].map(id => ({ id, url: 'http://benchmark.test/' })),
      }),
    )
    const createServer = () => ({
      _registeredTools: {
        geometra_fill_form: { handler: fillForm },
        geometra_disconnect: { handler: disconnect },
        geometra_list_sessions: { handler: listSessions },
      },
    })

    await runGeometraFlow(
      'http://benchmark.test/',
      createServer,
      benchmarkScenario(),
      benchmarkOptions(),
    )

    expect(activeSessionIds).toEqual(new Set(['peer-session']))
    expect(disconnect).not.toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'peer-session' }))
    expect(listSessions).toHaveBeenCalledTimes(3)
  })

  it('recovers and closes a session whose tool call failed before returning its payload', async () => {
    const activeSessionIds = new Set<string>()
    const fillForm = vi
      .fn()
      .mockImplementationOnce(async () => {
        activeSessionIds.add('cold-session')
        return mcpJson({ sessionId: 'cold-session', final: { invalidCount: 0 } })
      })
      .mockImplementationOnce(async () => {
        activeSessionIds.add('warm-session-without-payload')
        throw new Error('warm fill response failed')
      })
    const disconnect = vi.fn(async ({ sessionId }: { sessionId: string }) => {
      activeSessionIds.delete(sessionId)
      return mcpJson({ ok: true })
    })
    const listSessions = vi.fn(async () =>
      mcpJson({ sessions: [...activeSessionIds].map(id => ({ id, url: 'http://benchmark.test/' })) }),
    )
    const createServer = () => ({
      _registeredTools: {
        geometra_fill_form: { handler: fillForm },
        geometra_disconnect: { handler: disconnect },
        geometra_list_sessions: { handler: listSessions },
      },
    })

    await expect(
      runGeometraFlow(
        'http://benchmark.test/',
        createServer,
        benchmarkScenario(),
        benchmarkOptions(),
      ),
    ).rejects.toThrow('warm fill response failed')

    expect(disconnect).toHaveBeenCalledWith({
      sessionId: 'warm-session-without-payload',
      closeBrowser: true,
    })
    expect(activeSessionIds).toHaveLength(0)
  })

  it('fails the benchmark gate when an active session survives teardown', async () => {
    const disconnect = vi.fn(async () => mcpJson({ ok: false }))
    const listSessions = vi.fn(async () =>
      mcpJson({ sessions: [{ id: 'leaked-session', url: 'http://benchmark.test/' }] }),
    )

    await expect(
      cleanupGeometraSessions({
        disconnect,
        listSessions,
        sessionIds: ['leaked-session'],
      }),
    ).rejects.toThrow('Geometra benchmark leaked active sessions after cleanup: leaked-session')
    expect(disconnect).toHaveBeenCalledWith({ sessionId: 'leaked-session', closeBrowser: true })
  })
})
