/**
 * Integration tests for safe-by-default proxy session isolation.
 *
 * Setup: a tiny HTTP server serves an HTML page that, on first visit, writes
 * a path-tagged marker to `localStorage` if one isn't already set, then
 * renders the marker text into an `<h1>`. The marker is therefore set ONCE
 * per browser instance, regardless of how many navigations happen.
 *
 * Two scenarios verify the isolation contract:
 *
 * 1. **Explicit warm reuse** (`isolated: false`): connect to `/page-a`, disconnect (the proxy
 *    enters the reusable pool), then connect to `/page-b`. The second
 *    connect attaches to the same pooled proxy, which navigates the
 *    existing Chromium from /page-a to /page-b — but the browser's
 *    localStorage still has `marker-from-/page-a`, so the second session
 *    SEES THE FIRST SESSION'S MARKER. This documents the contamination
 *    that breaks parallel form submission against real apply flows.
 *
 * 2. **Default isolated**: the same connect/disconnect/connect sequence with
 *    the flag omitted. Each connect spawns a brand-new Chromium with
 *    empty storage, so the second session sees its own marker, not the
 *    first's. This is the fix.
 *
 * The point of having both cases in one test file is so that future edits
 * to the pool code can't quietly break the isolation guarantee — both
 * paths run end-to-end against real Chromium and assert on the actual
 * post-navigation a11y tree the MCP would expose to a tool call.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  buildA11yTree,
  connectThroughProxy,
  disconnect,
  getDefaultSessionId,
  resolveSession,
  shutdownAllSessionsAndProxies,
} from '../session.js'
import type { A11yNode, Session } from '../session.js'

const PAGE_HTML = `<!doctype html>
<html>
  <head><title>isolation-fixture</title></head>
  <body>
    <h1 id="marker"></h1>
    <script>
      const stored = localStorage.getItem('isolation-marker')
      if (!stored) {
        // First visit in this browser instance — set a path-tagged marker.
        localStorage.setItem('isolation-marker', 'marker-from-' + location.pathname)
      }
      document.getElementById('marker').textContent =
        localStorage.getItem('isolation-marker') || 'marker-missing'
    </script>
  </body>
</html>`

let baseUrl: string
let server: http.Server

function findHeadingText(node: A11yNode | null | undefined): string | undefined {
  if (!node) return undefined
  if (node.role === 'heading') {
    const name = (node.name ?? '').trim()
    if (name) return name
  }
  for (const child of node.children ?? []) {
    const found = findHeadingText(child)
    if (found) return found
  }
  return undefined
}

function currentA11y(session: Session): A11yNode | null {
  if (!session.tree || !session.layout) return null
  return buildA11yTree(session.tree, session.layout)
}

async function waitForMarkerText(
  session: Session,
  expectedPrefix: string,
  timeoutMs = 6_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const text = findHeadingText(currentA11y(session))
    if (text && text.startsWith(expectedPrefix)) return text
    await new Promise(r => setTimeout(r, 100))
  }
  throw new Error(
    `Timed out waiting for heading text starting with "${expectedPrefix}". ` +
    `Last seen: ${JSON.stringify(findHeadingText(currentA11y(session)) ?? null)}`,
  )
}

describe('connectThroughProxy session isolation', () => {
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const url = req.url ?? '/'
      if (url === '/page-a' || url === '/page-b') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(PAGE_HTML)
        return
      }
      res.writeHead(404)
      res.end()
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve())
    })
    const address = server.address() as AddressInfo
    baseUrl = `http://127.0.0.1:${address.port}`
  })

  afterEach(() => {
    // Force-close everything so the next test starts with no pooled proxies.
    shutdownAllSessionsAndProxies()
  })

  it('browser sessions are isolated by default and get independent localStorage between connects', async () => {
    // Omission must choose the safe, isolated default.
    const sessionA = await connectThroughProxy({
      pageUrl: `${baseUrl}/page-a`,
      headless: true,
    })
    expect(sessionA.isolated).toBe(true)
    const markerA = await waitForMarkerText(sessionA, 'marker-from-')
    expect(markerA).toBe('marker-from-/page-a')

    // Disconnect — because the session is isolated, this MUST destroy the
    // underlying Chromium. The next connect cannot attach to it.
    disconnect({ sessionId: sessionA.id })

    // Second isolated session against /page-b. Because each isolated
    // session gets its own brand-new Chromium, /page-b's first-visit
    // script runs against an empty localStorage and writes its own marker.
    const sessionB = await connectThroughProxy({
      pageUrl: `${baseUrl}/page-b`,
      headless: true,
    })
    expect(sessionB.isolated).toBe(true)
    const markerB = await waitForMarkerText(sessionB, 'marker-from-')
    // Critical assertion: sessionB does NOT see sessionA's marker.
    expect(markerB).toBe('marker-from-/page-b')
    expect(markerB).not.toBe(markerA)

    disconnect({ sessionId: sessionB.id })
  }, 30_000)

  it('only explicit isolated:false opts into sequential warm state reuse', async () => {
    // First explicitly pooled session. The proxy becomes eligible for reuse
    // after disconnect.
    const sessionA = await connectThroughProxy({
      pageUrl: `${baseUrl}/page-a`,
      headless: true,
      isolated: false,
    })
    expect(sessionA.isolated).toBeFalsy()
    const markerA = await waitForMarkerText(sessionA, 'marker-from-')
    expect(markerA).toBe('marker-from-/page-a')

    // Disconnect WITHOUT closing the proxy — leaves it in the reusable pool.
    disconnect({ sessionId: sessionA.id, closeProxy: false })

    // Second pooled session against a *different* URL. The pool will
    // attach the existing Chromium and navigate it to /page-b, but the
    // browser still has /page-a's localStorage, so /page-b's first-visit
    // script sees the existing marker and doesn't overwrite it.
    const sessionB = await connectThroughProxy({
      pageUrl: `${baseUrl}/page-b`,
      headless: true,
      isolated: false,
    })
    const markerB = await waitForMarkerText(sessionB, 'marker-from-')
    // Documents the contamination: the second session sees the first
    // session's marker because they share a browser via the pool.
    expect(markerB).toBe('marker-from-/page-a')

    disconnect({ sessionId: sessionB.id, closeProxy: true })
  }, 30_000)

  it('never gives concurrent warm-pool callers the same Session owner', async () => {
    // Regression for the per-proxy attach race. Two concurrent callers may
    // initially select the same idle pool entry. The attach lock lets only
    // one claim it; the second must re-pick and start or claim a different
    // runtime. No active browser ever has two Session owners.
    //
    // Step 1: warm the pool with a single connect+disconnect so the next
    // connects find an existing entry. Cold-start parallel connects
    // legitimately create separate browsers (no shared state to leak), so
    // the race only matters when the pool is already populated.
    const warmup = await connectThroughProxy({
      pageUrl: `${baseUrl}/page-a`,
      headless: true,
      isolated: false,
    })
    disconnect({ sessionId: warmup.id, closeProxy: false })

    // Step 2: fire two concurrent connects. Without the lock, both would
    // call connect(proxy.wsUrl) and create distinct sessions bound to the
    // same browser. With the lock, the second waits, sees that browser is
    // owned, and starts or claims a different runtime.
    const [sessionA, sessionB] = await Promise.all([
      connectThroughProxy({ pageUrl: `${baseUrl}/page-a`, headless: true, isolated: false }),
      connectThroughProxy({ pageUrl: `${baseUrl}/page-a`, headless: true, isolated: false }),
    ])

    expect(sessionA.id).not.toBe(sessionB.id)
    expect(sessionA).not.toBe(sessionB)
    expect(sessionA.proxyRuntime).not.toBe(sessionB.proxyRuntime)

    disconnect({ sessionId: sessionA.id, closeProxy: true })
    disconnect({ sessionId: sessionB.id, closeProxy: true })
  }, 30_000)

  // ── Bug #1 regression: parallel isolated sessions must never share a
  // default pointer, and tool-call resolution must refuse to implicitly
  // route to an isolated session when no sessionId is passed.
  it(
    'three parallel isolated sessions stay strictly independent — no shared default, strict id routing',
    async () => {
      // Spawn three isolated sessions in parallel, each pinned to a
      // different local URL. Each session gets its own Chromium instance
      // (isolated: true forces a fresh proxy every time), and each tool
      // call in real usage would address its session by the returned id.
      const [sessionA, sessionB, sessionC] = await Promise.all([
        connectThroughProxy({
          pageUrl: `${baseUrl}/page-a`,
          headless: true,
        }),
        connectThroughProxy({
          pageUrl: `${baseUrl}/page-b`,
          headless: true,
        }),
        connectThroughProxy({
          pageUrl: `${baseUrl}/page-a`,
          headless: true,
        }),
      ])

      try {
        // Invariant 1: every isolated session is flagged, and all three got
        // distinct session ids (no collision).
        expect(sessionA.isolated).toBe(true)
        expect(sessionB.isolated).toBe(true)
        expect(sessionC.isolated).toBe(true)
        expect(new Set([sessionA.id, sessionB.id, sessionC.id]).size).toBe(3)

        // Invariant 2: the implicit default-session pointer must not be set
        // to any of these isolated sessions. This is the contamination fix —
        // before v1.43, `connect()` unconditionally set defaultSessionId to
        // whichever session most recently finished connecting, so parallel
        // workers without an explicit sessionId would race onto each
        // other's browsers.
        const implicitDefault = getDefaultSessionId()
        expect(implicitDefault).toBeNull()

        // Invariant 3: resolveSession() with no id must refuse to pick any
        // of these isolated sessions. Callers that omit sessionId get an
        // ambiguous error and are forced to pass an explicit id.
        const ambiguous = resolveSession()
        expect(ambiguous.kind).toBe('ambiguous')
        if (ambiguous.kind === 'ambiguous') {
          expect(ambiguous.activeIds).toEqual(
            expect.arrayContaining([sessionA.id, sessionB.id, sessionC.id]),
          )
          expect(ambiguous.isolatedIds).toEqual(
            expect.arrayContaining([sessionA.id, sessionB.id, sessionC.id]),
          )
        }

        // Invariant 4: explicit id routing must return exactly the
        // requested session — never a peer — even under parallel load.
        const lookupA = resolveSession(sessionA.id)
        const lookupB = resolveSession(sessionB.id)
        const lookupC = resolveSession(sessionC.id)
        expect(lookupA.kind).toBe('ok')
        expect(lookupB.kind).toBe('ok')
        expect(lookupC.kind).toBe('ok')
        if (lookupA.kind === 'ok') expect(lookupA.session).toBe(sessionA)
        if (lookupB.kind === 'ok') expect(lookupB.session).toBe(sessionB)
        if (lookupC.kind === 'ok') expect(lookupC.session).toBe(sessionC)

        // Invariant 5: each session's page still reads its own per-URL
        // marker. This is the end-to-end "different browsers" check —
        // even though they share the same MCP server process, the
        // underlying Chromium / localStorage is distinct per session.
        const [markerA, markerB, markerC] = await Promise.all([
          waitForMarkerText(sessionA, 'marker-from-'),
          waitForMarkerText(sessionB, 'marker-from-'),
          waitForMarkerText(sessionC, 'marker-from-'),
        ])
        expect(markerA).toBe('marker-from-/page-a')
        expect(markerB).toBe('marker-from-/page-b')
        expect(markerC).toBe('marker-from-/page-a')

        // Invariant 6: looking up a session id that no longer exists must
        // return `not_found` with the full active-id list, NEVER silently
        // fall back to the default. This is the v1.42-era contamination
        // vector: workers were seeing their tool calls routed to whatever
        // the "most recent" session happened to be.
        disconnect({ sessionId: sessionB.id, closeProxy: true })
        const afterDisconnect = resolveSession(sessionB.id)
        expect(afterDisconnect.kind).toBe('not_found')
        if (afterDisconnect.kind === 'not_found') {
          expect(afterDisconnect.id).toBe(sessionB.id)
        }

        // And the implicit default is STILL null — disconnecting one
        // isolated session doesn't promote the next one to default.
        expect(getDefaultSessionId()).toBeNull()
      } finally {
        disconnect({ sessionId: sessionA.id, closeProxy: true })
        disconnect({ sessionId: sessionC.id, closeProxy: true })
      }
    },
    60_000,
  )

  it('a single non-isolated session DOES become the implicit default (back-compat)', async () => {
    // Single pooled session — the default-fallback behavior is retained
    // for callers that don't pass sessionId and aren't running in
    // parallel. This preserves every existing single-worker script.
    const session = await connectThroughProxy({
      pageUrl: `${baseUrl}/page-a`,
      headless: true,
      isolated: false,
    })
    try {
      expect(session.isolated).toBeFalsy()
      expect(getDefaultSessionId()).toBe(session.id)
      const resolved = resolveSession()
      expect(resolved.kind).toBe('ok')
      if (resolved.kind === 'ok') expect(resolved.session.id).toBe(session.id)
    } finally {
      disconnect({ sessionId: session.id, closeProxy: true })
    }
  }, 30_000)
})
