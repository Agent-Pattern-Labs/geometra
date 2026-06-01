import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { chromium, type Browser, type Page } from 'playwright'
import {
  primeDomObserver,
  startGeometryWebSocket,
  type GeometryWsHub,
  type GeometryWsTrace,
} from './geometry-ws.js'

const require = createRequire(import.meta.url)
const AUTO_INSTALL_ENV = 'GEOMETRA_PROXY_AUTO_INSTALL_BROWSERS'
const PLAYWRIGHT_INSTALL_HINT =
  'Install Chromium with the Playwright version bundled in this package: npm run browsers:install -w @geometra/proxy (repo checkout) or npx --no-install playwright install chromium.'
const PROCESS_OUTPUT_TAIL_LIMIT = 6_000

export interface ProxyRuntimeTrace {
  browserFlavor?: 'chromium' | 'stealth'
  browserLaunchMs?: number
  newPageMs?: number
  wsListeningMs?: number
  initialNavigationMs?: number
  observerInstallMs?: number
  readyMs?: number
  geometry?: GeometryWsTrace
}

export interface ProxyRuntimeHandle {
  browser?: Browser
  page?: Page
  hub: GeometryWsHub
  pageUrl: string
  wsUrl: string
  ready: Promise<void>
  getTrace: () => ProxyRuntimeTrace
  closed: boolean
  close: () => Promise<void>
}

/**
 * Outbound proxy config for the Chromium that geometra-proxy launches.
 *
 * Set `server` to a single URL like `http://proxy.example.com:8080`,
 * `https://...`, or `socks5://...`. Authenticate via `username` / `password`
 * if the proxy requires it. `bypass` is a comma-separated host pattern list
 * Playwright passes through to Chromium (e.g. `"*.internal,localhost"`).
 *
 * Use case: residential / mobile proxies that present non-datacenter IPs to
 * the target site so anti-bot fingerprinting (Ashby, Lever Mapbox geocoder,
 * Cloudflare Bot Management, etc.) is less likely to flag the session as
 * automation. Geometra is the wire — the user supplies the proxy.
 */
export interface ProxyConfig {
  server: string
  username?: string
  password?: string
  bypass?: string
}

export interface LaunchProxyRuntimeOptions {
  url: string
  port: number
  width?: number
  height?: number
  headed?: boolean
  slowMo?: number
  debounceMs?: number
  eagerInitialExtract?: boolean
  /** Use CloakBrowser's patched Chromium binary instead of stock Playwright Chromium. */
  stealth?: boolean
  /** Outbound HTTP/SOCKS proxy for Chromium (BYO residential/mobile IP). */
  proxy?: ProxyConfig
  onListening?: (wsUrl: string) => void
  onError?: (err: unknown) => void
}

export function parseHttpPageUrl(raw: string): string {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new Error(`Invalid URL: ${raw}`)
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Unsupported URL protocol: ${parsed.protocol}. geometra-proxy only opens http:// or https:// pages.`)
  }

  return parsed.toString()
}

export function formatProxyFatalError(err: unknown): string {
  const base = err instanceof Error ? err.message : String(err)
  if (/Executable doesn't exist|playwright install chromium|browserType\.launch/i.test(base)) {
    return `${base}\n${PLAYWRIGHT_INSTALL_HINT}`
  }
  if (/cloakbrowser|CLOAKBROWSER|ERR_MODULE_NOT_FOUND|Cannot find package/i.test(base)) {
    return `${base}\nStealth mode uses CloakBrowser. Install dependencies with: npm install, or disable stealth with --no-stealth / GEOMETRA_STEALTH=0. To prefetch the patched Chromium binary, run: npx cloakbrowser install`
  }
  return base
}

export function resolveStealthMode(stealth?: boolean): boolean {
  return stealth ?? true
}

function createDeferred<T>(): {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
  reject: (reason?: unknown) => void
} {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function truthyEnv(value: string | undefined): boolean {
  return value != null && /^(1|true|yes|on)$/i.test(value)
}

function falseyEnv(value: string | undefined): boolean {
  return value != null && /^(0|false|no|off)$/i.test(value)
}

function autoInstallBrowsersEnabled(): boolean {
  if (falseyEnv(process.env[AUTO_INSTALL_ENV])) return false
  if (truthyEnv(process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD)) return false
  return true
}

function isMissingPlaywrightChromiumExecutableError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return (
    /Executable doesn't exist/i.test(message) &&
    /(chromium|chrome|headless)/i.test(message)
  ) || /Looks like Playwright was just installed or updated/i.test(message)
}

function resolvedPlaywrightCliPath(): string {
  const packageJsonPath = require.resolve('playwright/package.json')
  return path.join(path.dirname(packageJsonPath), 'cli.js')
}

function appendTail(existing: string, chunk: Buffer): string {
  const next = existing + chunk.toString()
  return next.length > PROCESS_OUTPUT_TAIL_LIMIT
    ? next.slice(-PROCESS_OUTPUT_TAIL_LIMIT)
    : next
}

let playwrightChromiumInstallPromise: Promise<void> | undefined

function installPlaywrightChromiumForResolvedPackage(): Promise<void> {
  playwrightChromiumInstallPromise ??= new Promise<void>((resolve, reject) => {
    let stdoutTail = ''
    let stderrTail = ''
    const child = spawn(process.execPath, [resolvedPlaywrightCliPath(), 'install', 'chromium'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PLAYWRIGHT_SKIP_BROWSER_GC: process.env.PLAYWRIGHT_SKIP_BROWSER_GC ?? '1',
      },
    })

    child.stdout?.on('data', chunk => {
      stdoutTail = appendTail(stdoutTail, chunk)
    })
    child.stderr?.on('data', chunk => {
      stderrTail = appendTail(stderrTail, chunk)
    })
    child.on('error', reject)
    child.on('exit', (code, signal) => {
      if (code === 0) {
        resolve()
        return
      }

      const detail = [stdoutTail.trim(), stderrTail.trim()].filter(Boolean).join('\n')
      reject(
        new Error(
          `Playwright browser install failed (code=${code} signal=${signal}).${detail ? ` Output tail:\n${detail}` : ''}`,
        ),
      )
    })
  }).finally(() => {
    playwrightChromiumInstallPromise = undefined
  })

  return playwrightChromiumInstallPromise
}

async function launchChromiumWithBrowserInstallRetry(
  launchOpts: Parameters<typeof chromium.launch>[0],
): Promise<Browser> {
  try {
    return await chromium.launch(launchOpts)
  } catch (err) {
    if (!autoInstallBrowsersEnabled() || !isMissingPlaywrightChromiumExecutableError(err)) {
      throw err
    }

    try {
      await installPlaywrightChromiumForResolvedPackage()
      return await chromium.launch(launchOpts)
    } catch (retryErr) {
      const original = err instanceof Error ? err.message : String(err)
      const retry = retryErr instanceof Error ? retryErr.message : String(retryErr)
      throw new Error(
        `Chromium launch failed because the Playwright browser revision was missing. Geometra attempted to install the browser for the resolved Playwright package and retry once, but launch still failed.\nOriginal error: ${original}\nRetry error: ${retry}\n${PLAYWRIGHT_INSTALL_HINT}`,
        { cause: retryErr },
      )
    }
  }
}

export async function launchProxyRuntime(options: LaunchProxyRuntimeOptions): Promise<ProxyRuntimeHandle> {
  const runtimeStartedAt = performance.now()
  const pageUrl = parseHttpPageUrl(options.url)
  const eagerInitialExtract = options.eagerInitialExtract !== false
  const trace: ProxyRuntimeTrace = {}
  const pageReady = createDeferred<Page>()

  let resolveListening!: (wsUrl: string) => void
  let rejectListening!: (err: Error) => void
  const listeningPromise = new Promise<string>((resolve, reject) => {
    resolveListening = resolve
    rejectListening = reject
  })

  let resolveBeforeInput!: () => void
  let rejectBeforeInput!: (err: unknown) => void
  const beforeInput = new Promise<void>((resolve, reject) => {
    resolveBeforeInput = resolve
    rejectBeforeInput = reject
  })

  let wsUrl = options.port === 0 ? '' : `ws://127.0.0.1:${options.port}`
  let closed = false
  let closing = false
  let browser: Browser | undefined
  let page: Page | undefined

  const reportError = (err: unknown) => {
    options.onError?.(err)
    if (!wsUrl) {
      rejectListening(new Error(formatProxyFatalError(err)))
    }
  }

  const hub = startGeometryWebSocket({
    port: options.port,
    page: pageReady.promise,
    debounceMs: options.debounceMs ?? 50,
    beforeInput,
    onListening(port) {
      wsUrl = `ws://127.0.0.1:${port}`
      resolveListening(wsUrl)
      options.onListening?.(wsUrl)
    },
    onError: reportError,
  })

  const handleUnexpectedClosure = (source: 'page' | 'browser') => {
    if (closed || closing) return
    closed = true
    const message =
      source === 'browser'
        ? 'Playwright browser was closed while geometra-proxy was still expected to serve MCP actions.'
        : 'Playwright page or context was closed while geometra-proxy was still expected to serve MCP actions.'
    const error = new Error(message)
    rejectBeforeInput(error)
    rejectListening(error)
    options.onError?.(error)
    void hub.close().catch(() => {})
  }

  const launchTask = (async () => {
    const viewport = {
      width: options.width ?? 1280,
      height: options.height ?? 720,
    }
    const stealth = resolveStealthMode(options.stealth)
    trace.browserFlavor = stealth ? 'stealth' : 'chromium'
    const browserLaunchStartedAt = performance.now()
    const headless = options.headed !== true
    const args = [
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-web-security',
      '--disable-features=IsolateOrigins,site-per-process',
    ]
    const proxy = options.proxy?.server
      ? {
          server: options.proxy.server,
          ...(options.proxy.username !== undefined && { username: options.proxy.username }),
          ...(options.proxy.password !== undefined && { password: options.proxy.password }),
          ...(options.proxy.bypass !== undefined && { bypass: options.proxy.bypass }),
        }
      : undefined

    if (stealth) {
      const cloak = await import('cloakbrowser') as {
        launch(options?: {
          headless?: boolean
          args?: string[]
          proxy?: ProxyConfig
          launchOptions?: Record<string, unknown>
        }): Promise<Browser>
      }
      const launchOptions: Record<string, unknown> = {}
      if (options.slowMo && options.slowMo > 0) launchOptions.slowMo = options.slowMo
      browser = await cloak.launch({
        headless,
        args,
        ...(proxy && { proxy }),
        ...(Object.keys(launchOptions).length > 0 && { launchOptions }),
      })
    } else {
      const launchOpts: Parameters<typeof chromium.launch>[0] = {
        headless,
        args: [
          ...args,
        ],
      }
      if (options.slowMo && options.slowMo > 0) launchOpts.slowMo = options.slowMo
      if (proxy) launchOpts.proxy = proxy
      browser = await launchChromiumWithBrowserInstallRetry(launchOpts)
    }
    trace.browserLaunchMs = performance.now() - browserLaunchStartedAt
    browser?.on('disconnected', () => {
      handleUnexpectedClosure('browser')
    })

    const newPageStartedAt = performance.now()
    page = await browser.newPage({ viewport })
    trace.newPageMs = performance.now() - newPageStartedAt
    page.on('close', () => {
      handleUnexpectedClosure('page')
    })
    pageReady.resolve(page)

    const observerInstallStartedAt = performance.now()
    await primeDomObserver(page, hub.scheduleExtract)
    trace.observerInstallMs = performance.now() - observerInstallStartedAt

    const initialNavigationStartedAt = performance.now()
    await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    trace.initialNavigationMs = performance.now() - initialNavigationStartedAt
    resolveBeforeInput()
    if (eagerInitialExtract) {
      await hub.flushExtract()
    }
    trace.readyMs = performance.now() - runtimeStartedAt
  })()

  const ready = launchTask.catch(err => {
    pageReady.reject(err)
    rejectBeforeInput(err)
    reportError(err)
    void hub.close().catch(() => {})
    throw err
  })
  void ready.catch(() => {})

  const listeningWsUrl = await listeningPromise
  trace.wsListeningMs = performance.now() - runtimeStartedAt

  const getTrace = (): ProxyRuntimeTrace => ({
    ...trace,
    geometry: hub.getTrace(),
  })

  const close = async () => {
    if (closed || closing) return
    closing = true
    try {
      await hub.close()
    } catch {
      /* ignore */
    }
    try {
      await ready.catch(() => {})
      if (browser?.isConnected()) {
        await browser.close()
      }
    } catch {
      /* ignore */
    }
    closed = true
    closing = false
  }

  return {
    get browser() {
      return browser
    },
    get page() {
      return page
    },
    hub,
    pageUrl,
    wsUrl: listeningWsUrl,
    ready,
    getTrace,
    get closed() {
      return closed
    },
    close,
  }
}
