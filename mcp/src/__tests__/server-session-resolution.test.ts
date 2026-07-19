import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockState = vi.hoisted(() => ({
  disconnect: vi.fn(),
  pruneDisconnectedSessions: vi.fn(() => [] as string[]),
  resolveSession: vi.fn<(id?: string) => unknown>(() => ({ kind: 'none' as const })),
}))

vi.mock('../session.js', () => ({
  connect: vi.fn(),
  connectThroughProxy: vi.fn(),
  ensureSessionConnected: vi.fn(),
  disconnect: mockState.disconnect,
  pruneDisconnectedSessions: mockState.pruneDisconnectedSessions,
  resolveSession: mockState.resolveSession,
  listSessions: vi.fn(() => []),
  getDefaultSessionId: vi.fn(() => null),
  prewarmProxy: vi.fn(),
  sendClick: vi.fn(),
  sendFillFields: vi.fn(),
  sendFillOtp: vi.fn(),
  sendType: vi.fn(),
  sendKey: vi.fn(),
  sendFileUpload: vi.fn(),
  sendFieldText: vi.fn(),
  sendFieldChoice: vi.fn(),
  sendListboxPick: vi.fn(),
  sendSelectOption: vi.fn(),
  sendSetChecked: vi.fn(),
  sendWheel: vi.fn(),
  sendScreenshot: vi.fn(),
  sendPdfGenerate: vi.fn(),
  buildA11yTree: vi.fn(),
  buildCompactUiIndex: vi.fn(() => ({ nodes: [], context: {} })),
  buildFormRequiredSnapshot: vi.fn(() => []),
  buildPageModel: vi.fn(),
  buildFormSchemas: vi.fn(() => []),
  expandPageSection: vi.fn(),
  buildUiDelta: vi.fn(() => ({})),
  hasUiDelta: vi.fn(() => false),
  nodeIdForPath: vi.fn(),
  nodeContextForNode: vi.fn(),
  parseSectionId: vi.fn(),
  findNodeByPath: vi.fn(),
  summarizeCompactIndex: vi.fn(() => ''),
  summarizePageModel: vi.fn(() => ''),
  summarizeUiDelta: vi.fn(() => ''),
  waitForUiCondition: vi.fn(),
}))

const { createServer } = await import('../server.js')

function getToolHandler(name: string) {
  const server = createServer() as unknown as {
    _registeredTools: Record<string, { handler: (input: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }> }>
  }
  return server._registeredTools[name]!.handler
}

describe('server session resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockState.pruneDisconnectedSessions.mockReturnValue([])
    mockState.resolveSession.mockReturnValue({ kind: 'none' as const })
  })

  it('prunes disconnected sessions before resolving explicit session ids', async () => {
    const handler = getToolHandler('geometra_query')
    mockState.pruneDisconnectedSessions.mockReturnValue(['s7'])
    mockState.resolveSession.mockReturnValue({
      kind: 'not_found' as const,
      id: 's7',
      activeIds: [],
    })

    const result = await handler({ sessionId: 's7', role: 'button' })
    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toContain('session_not_found: no active session with id "s7"')
    expect(result.content[0]!.text).toContain('disconnected or expired')
    expect(mockState.pruneDisconnectedSessions).toHaveBeenCalledTimes(1)
    expect(mockState.resolveSession).toHaveBeenCalledWith('s7')
  })

  it('preserves ambiguous-session errors after pruning disconnected sessions', async () => {
    const handler = getToolHandler('geometra_query')
    mockState.pruneDisconnectedSessions.mockReturnValue(['s3'])
    mockState.resolveSession.mockReturnValue({
      kind: 'ambiguous' as const,
      activeIds: ['s1', 's2'],
      isolatedIds: ['s2'],
    })

    const result = await handler({ role: 'button' })
    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toContain('multiple_active_sessions_provide_id')
    expect(result.content[0]!.text).toContain('s1, s2')
    expect(result.content[0]!.text).toContain('isolated: s2')
    expect(mockState.pruneDisconnectedSessions).toHaveBeenCalledTimes(1)
    expect(mockState.resolveSession).toHaveBeenCalledWith(undefined)
  })

  it('refuses an unscoped disconnect when multiple sessions are active', async () => {
    const handler = getToolHandler('geometra_disconnect')
    mockState.resolveSession.mockReturnValue({
      kind: 'ambiguous' as const,
      activeIds: ['s1', 's2'],
      isolatedIds: [],
    })

    const result = await handler({ closeBrowser: true })

    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toContain('multiple_active_sessions_provide_id')
    expect(mockState.disconnect).not.toHaveBeenCalled()
  })

  it('disconnects only the explicitly resolved session browser', async () => {
    const handler = getToolHandler('geometra_disconnect')
    const session = { id: 's1', isolated: false }
    mockState.resolveSession.mockReturnValue({ kind: 'ok' as const, session })

    const result = await handler({ sessionId: 's1', closeBrowser: true })

    expect(result.isError).not.toBe(true)
    expect(result.content[0]!.text).toContain('Disconnected session s1 and closed its browser')
    expect(mockState.disconnect).toHaveBeenCalledTimes(1)
    expect(mockState.disconnect).toHaveBeenCalledWith({ sessionId: 's1', closeProxy: true })
  })
})
