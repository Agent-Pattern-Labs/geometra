import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CONNECT_TARGET_EXACTLY_ONE_ERROR,
  formatConnectFailureMessage,
  isHttpUrl,
  normalizeConnectTarget,
} from '../connect-utils.js'
import {
  formatProxyStartupFailure,
  parseProxyReadySignalLine,
  resolveProxyScriptPath,
  resolveProxyScriptPathWith,
} from '../proxy-spawn.js'

describe('normalizeConnectTarget', () => {
  it('accepts explicit pageUrl for http(s) pages', () => {
    const result = normalizeConnectTarget({ pageUrl: 'https://example.com/jobs/123' })

    expect(result).toEqual({
      ok: true,
      value: {
        kind: 'proxy',
        pageUrl: 'https://example.com/jobs/123',
        autoCoercedFromUrl: false,
      },
    })
  })

  it('rejects non-http pageUrl protocols', () => {
    const result = normalizeConnectTarget({ pageUrl: 'ws://127.0.0.1:3100' })

    expect(result).toEqual({
      ok: false,
      error: 'pageUrl must use http:// or https:// (received ws:)',
    })
  })

  it('auto-coerces http url input onto the proxy path', () => {
    const result = normalizeConnectTarget({ url: 'https://jobs.example.com/apply' })

    expect(result).toEqual({
      ok: true,
      value: {
        kind: 'proxy',
        pageUrl: 'https://jobs.example.com/apply',
        autoCoercedFromUrl: true,
      },
    })
  })

  it('accepts ws url input for already-running peers', () => {
    const result = normalizeConnectTarget({ url: 'ws://127.0.0.1:3100' })

    expect(result).toEqual({
      ok: true,
      value: {
        kind: 'ws',
        wsUrl: 'ws://127.0.0.1:3100/',
        autoCoercedFromUrl: false,
      },
    })
  })

  it('accepts wss url input for already-running peers (TLS WebSocket)', () => {
    const result = normalizeConnectTarget({ url: 'wss://example.com/socket' })

    expect(result).toEqual({
      ok: true,
      value: {
        kind: 'ws',
        wsUrl: 'wss://example.com/socket',
        autoCoercedFromUrl: false,
      },
    })
  })

  it('rejects ambiguous and empty connect inputs', () => {
    expect(normalizeConnectTarget({})).toEqual({
      ok: false,
      error: CONNECT_TARGET_EXACTLY_ONE_ERROR,
    })

    expect(normalizeConnectTarget({ url: 'ws://127.0.0.1:3100', pageUrl: 'https://example.com' })).toEqual({
      ok: false,
      error: CONNECT_TARGET_EXACTLY_ONE_ERROR,
    })
  })

  it('rejects invalid pageUrl strings (URL parser failure)', () => {
    const result = normalizeConnectTarget({ pageUrl: 'https://exam ple.com' })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.startsWith('Invalid pageUrl:')).toBe(true)
    }
  })

  it('rejects non-http(s) url when using pageUrl (explicit)', () => {
    expect(normalizeConnectTarget({ pageUrl: 'file:///tmp/x.html' })).toEqual({
      ok: false,
      error: 'pageUrl must use http:// or https:// (received file:)',
    })
  })

  it('rejects invalid url strings for the url field', () => {
    const result = normalizeConnectTarget({ url: ':::not-a-url' })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('Invalid url:')
      expect(result.error).toContain('ws://')
    }
  })

  it('rejects unsupported protocols on the url field (neither http(s) nor ws(s))', () => {
    expect(normalizeConnectTarget({ url: 'ftp://files.example.com/pub' })).toEqual({
      ok: false,
      error:
        'Unsupported url protocol ftp:. Use ws://... for an already-running Geometra server, or http:// / https:// for webpages.',
    })
  })

  it('trims whitespace-only inputs to empty (same as omitting url/pageUrl)', () => {
    expect(normalizeConnectTarget({ url: '   ', pageUrl: undefined })).toEqual({
      ok: false,
      error: CONNECT_TARGET_EXACTLY_ONE_ERROR,
    })
  })

  it('trims whitespace-only pageUrl to empty (symmetric with url-only whitespace)', () => {
    expect(normalizeConnectTarget({ pageUrl: '   ' })).toEqual({
      ok: false,
      error: CONNECT_TARGET_EXACTLY_ONE_ERROR,
    })
  })
})

describe('isHttpUrl', () => {
  it('accepts http and https URLs', () => {
    expect(isHttpUrl('https://example.com/path')).toBe(true)
    expect(isHttpUrl('http://localhost:8080/')).toBe(true)
  })

  it('accepts IPv6 literal hosts (URL parser canonical form)', () => {
    expect(isHttpUrl('https://[::1]:8443/')).toBe(true)
    expect(isHttpUrl('http://[2001:db8::1]/')).toBe(true)
  })

  it('rejects ws(s), file, and other schemes', () => {
    expect(isHttpUrl('ws://127.0.0.1:3100')).toBe(false)
    expect(isHttpUrl('wss://example.com')).toBe(false)
    expect(isHttpUrl('file:///tmp/x')).toBe(false)
  })

  it('rejects malformed strings', () => {
    expect(isHttpUrl('not a url')).toBe(false)
    expect(isHttpUrl('')).toBe(false)
  })
})

describe('formatConnectFailureMessage', () => {
  it('adds a targeted hint when ws connect fails for a normal webpage flow', () => {
    const message = formatConnectFailureMessage(
      new Error('WebSocket error connecting to ws://localhost:3100: connect ECONNREFUSED'),
      { kind: 'ws', wsUrl: 'ws://localhost:3100', autoCoercedFromUrl: false },
    )

    expect(message).toContain('ECONNREFUSED')
    expect(message).toContain('pageUrl: "https://…"')
  })

  it('adds the same hint when ws connect fails with DNS resolution errors (wrong host or offline resolver)', () => {
    const message = formatConnectFailureMessage(
      new Error('getaddrinfo ENOTFOUND bad.example.com'),
      { kind: 'ws', wsUrl: 'ws://bad.example.com:3100', autoCoercedFromUrl: false },
    )

    expect(message).toContain('ENOTFOUND')
    expect(message).toContain('pageUrl:')
  })

  it('adds an install hint when the proxy package cannot be resolved', () => {
    const message = formatConnectFailureMessage(
      new Error('Could not resolve @geometra/proxy from mcp'),
      { kind: 'proxy', pageUrl: 'https://example.com', autoCoercedFromUrl: false },
    )

    expect(message).toContain('Could not resolve @geometra/proxy')
    expect(message).toContain('@geometra/proxy')
  })
})

describe('proxy ready helpers', () => {
  it('resolves the bundled proxy CLI entry in the source tree', () => {
    const scriptPath = resolveProxyScriptPath()

    expect(existsSync(scriptPath)).toBe(true)
    expect(path.basename(scriptPath)).toBe('index.js')
    expect(scriptPath.includes(`${path.sep}proxy${path.sep}`)).toBe(true)
  })

  it('resolves the bundled proxy CLI entry from a packaged dependency layout', () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'geometra-proxy-resolve-'))

    try {
      const scopeDir = path.join(tempRoot, 'node_modules', '@geometra')
      const packageDir = path.join(scopeDir, 'proxy')
      const probePath = path.join(tempRoot, 'probe.cjs')
      mkdirSync(scopeDir, { recursive: true })
      mkdirSync(path.join(packageDir, 'src'), { recursive: true })
      writeFileSync(
        path.join(packageDir, 'package.json'),
        JSON.stringify({
          name: '@geometra/proxy',
          version: '0.0.0-test',
          type: 'module',
        }),
      )
      writeFileSync(
        path.join(packageDir, 'tsconfig.build.json'),
        JSON.stringify({
          extends: path.resolve(process.cwd(), 'tsconfig.base.json'),
          compilerOptions: {
            outDir: 'dist',
            rootDir: 'src',
            noEmit: false,
          },
          include: ['src'],
        }),
      )
      writeFileSync(path.join(packageDir, 'src', 'index.ts'), 'console.log("proxy");\n')
      writeFileSync(probePath, 'module.exports = {}')

      const customRequire = createRequire(probePath)
      const scriptPath = resolveProxyScriptPathWith(customRequire)

      expect(existsSync(scriptPath)).toBe(true)
      expect(path.basename(scriptPath)).toBe('index.js')
    } finally {
      rmSync(tempRoot, { recursive: true, force: true })
    }
  })

  it('prefers the current workspace proxy dist over a bundled nested dependency in source checkouts', () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'geometra-proxy-workspace-prefer-'))

    try {
      const workspaceDistDir = path.join(tempRoot, 'packages', 'proxy', 'dist')
      const bundledProxyDir = path.join(tempRoot, 'mcp', 'node_modules', '@geometra', 'proxy')
      const bundledDistDir = path.join(bundledProxyDir, 'dist')
      const mcpDistDir = path.join(tempRoot, 'mcp', 'dist')
      const probePath = path.join(mcpDistDir, 'proxy-spawn.cjs')

      mkdirSync(workspaceDistDir, { recursive: true })
      mkdirSync(bundledDistDir, { recursive: true })
      mkdirSync(mcpDistDir, { recursive: true })

      writeFileSync(path.join(workspaceDistDir, 'index.js'), 'export const source = "workspace";\n')
      writeFileSync(path.join(bundledDistDir, 'index.js'), 'export const source = "bundled";\n')
      writeFileSync(
        path.join(bundledProxyDir, 'package.json'),
        JSON.stringify({
          name: '@geometra/proxy',
          version: '0.0.0-test',
          type: 'module',
        }),
      )
      writeFileSync(probePath, 'module.exports = {};\n')

      const customRequire = createRequire(probePath)
      const scriptPath = resolveProxyScriptPathWith(customRequire, mcpDistDir)

      expect(scriptPath).toBe(path.join(workspaceDistDir, 'index.js'))
    } finally {
      rmSync(tempRoot, { recursive: true, force: true })
    }
  })

  it('falls back to the packaged sibling proxy dist when package exports are stale', () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'geometra-proxy-stale-exports-'))

    try {
      const proxyDir = path.join(tempRoot, 'node_modules', '@geometra', 'proxy')
      const mcpDistDir = path.join(tempRoot, 'node_modules', '@geometra', 'mcp', 'dist')
      const proxyDistDir = path.join(proxyDir, 'dist')
      const probePath = path.join(mcpDistDir, 'proxy-spawn.cjs')

      mkdirSync(proxyDistDir, { recursive: true })
      mkdirSync(mcpDistDir, { recursive: true })

      writeFileSync(
        path.join(proxyDir, 'package.json'),
        JSON.stringify(
          {
            name: '@geometra/proxy',
            type: 'module',
            exports: {
              '.': {
                import: './dist/index.js',
              },
            },
          },
          null,
          2,
        ),
      )
      writeFileSync(path.join(proxyDistDir, 'index.js'), 'export {};\n')
      writeFileSync(probePath, 'module.exports = {};\n')

      const customRequire = createRequire(probePath)
      const scriptPath = resolveProxyScriptPathWith(customRequire, mcpDistDir)

      expect(scriptPath).toBe(path.join(proxyDistDir, 'index.js'))
    } finally {
      rmSync(tempRoot, { recursive: true, force: true })
    }
  })

  it('parses structured proxy ready JSON', () => {
    const wsUrl = parseProxyReadySignalLine(
      '{"type":"geometra-proxy-ready","wsUrl":"ws://127.0.0.1:41237","pageUrl":"https://example.com"}',
    )

    expect(wsUrl).toBe('ws://127.0.0.1:41237')
  })

  it('still accepts legacy human-readable ready logs', () => {
    const wsUrl = parseProxyReadySignalLine('[geometra-proxy] WebSocket listening on ws://127.0.0.1:3200')

    expect(wsUrl).toBe('ws://127.0.0.1:3200')
  })

  it('can require structured ready JSON for managed child-process launches', () => {
    const listening = parseProxyReadySignalLine(
      '[geometra-proxy] WebSocket listening on ws://127.0.0.1:3200',
      { allowLegacy: false },
    )
    const ready = parseProxyReadySignalLine(
      '{"type":"geometra-proxy-ready","wsUrl":"ws://127.0.0.1:41237","pageUrl":"https://example.com"}',
      { allowLegacy: false },
    )

    expect(listening).toBeUndefined()
    expect(ready).toBe('ws://127.0.0.1:41237')
  })

  it('adds install and port conflict hints to proxy startup failures', () => {
    const chromiumHint = formatProxyStartupFailure(
      "browserType.launch: Executable doesn't exist at /tmp/chromium",
      { pageUrl: 'https://example.com', port: 0 },
    )
    expect(chromiumHint).toContain('npx --no-install playwright install chromium')

    const portHint = formatProxyStartupFailure(
      'listen EADDRINUSE: address already in use 127.0.0.1:3337',
      { pageUrl: 'https://example.com', port: 3337 },
    )
    expect(portHint).toContain('Requested port 3337 is unavailable')
  })
})
