import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, realpathSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const READY_SIGNAL_TYPE = 'geometra-proxy-ready'
const READY_TIMEOUT_MS = 45_000
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url))
const PLAYWRIGHT_INSTALL_HINT =
  'Install Chromium with the Playwright version bundled in this package: npm run browsers:install -w @geometra/proxy (repo checkout) or npx --no-install playwright install chromium.'

export interface EmbeddedProxyRuntime {
  wsUrl: string
  ready: Promise<void>
  getTrace?: () => Record<string, unknown>
  closed: boolean
  close: () => Promise<void>
}

/** Resolve bundled @geometra/proxy CLI entry (dist/index.js). */
export function resolveProxyScriptPath(): string {
  return resolveProxyScriptPathWith(require)
}

export function resolveProxyScriptPathWith(customRequire: NodeRequire, moduleDir = MODULE_DIR): string {
  return resolveProxyDistPathWith(customRequire, moduleDir, 'index.js')
}

export function resolveProxyRuntimePath(): string {
  return resolveProxyRuntimePathWith(require)
}

export function resolveProxyRuntimePathWith(customRequire: NodeRequire, moduleDir = MODULE_DIR): string {
  return resolveProxyDistPathWith(customRequire, moduleDir, 'runtime.js')
}

function resolveProxyDistPathWith(customRequire: NodeRequire, moduleDir: string, entryFile: string): string {
  const errors: string[] = []
  const workspaceDist = path.resolve(moduleDir, `../../packages/proxy/dist/${entryFile}`)
  const bundledDependencyDir = path.resolve(moduleDir, '../node_modules/@geometra/proxy')

  const packageDir = resolveProxyPackageDir(customRequire)
  if (packageDir) {
    if (shouldPreferWorkspaceDist(packageDir, bundledDependencyDir) && existsSync(workspaceDist)) {
      return workspaceDist
    }

    const packagedDist = path.join(packageDir, 'dist', entryFile)
    if (existsSync(packagedDist)) return packagedDist

    const builtLocalDist = buildLocalProxyDistIfPossible(packageDir, entryFile, errors)
    if (builtLocalDist) return builtLocalDist

    errors.push(`Resolved @geometra/proxy package at ${packageDir}, but dist/${entryFile} was missing`)
  } else {
    errors.push('Could not find @geometra/proxy/package.json via Node module search paths')
  }

  try {
    const pkgJson = customRequire.resolve('@geometra/proxy/package.json')
    const exportPackageDir = path.dirname(pkgJson)
    const packagedDist = path.join(exportPackageDir, 'dist', entryFile)
    if (existsSync(packagedDist)) return packagedDist

    const builtLocalDist = buildLocalProxyDistIfPossible(exportPackageDir, entryFile, errors)
    if (builtLocalDist) return builtLocalDist

    errors.push(`Resolved @geometra/proxy/package.json at ${pkgJson}, but dist/${entryFile} was missing`)
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err))
  }

  if (entryFile === 'index.js') {
    try {
    return customRequire.resolve('@geometra/proxy')
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err))
    }
  }

  const packagedSiblingDist = path.resolve(moduleDir, `../../proxy/dist/${entryFile}`)
  if (existsSync(packagedSiblingDist)) {
    return packagedSiblingDist
  }
  errors.push(`Packaged sibling fallback not found at ${packagedSiblingDist}`)

  if (existsSync(workspaceDist)) {
    return workspaceDist
  }
  errors.push(`Workspace fallback not found at ${workspaceDist}`)

  throw new Error(
    `Could not resolve @geometra/proxy dist/${entryFile}. Install it with the MCP package: npm install @geometra/proxy. Resolution errors: ${errors.join(' | ')}`,
  )
}

function resolveProxyPackageDir(customRequire: NodeRequire): string | undefined {
  const searchRoots = customRequire.resolve.paths('@geometra/proxy') ?? []
  for (const searchRoot of searchRoots) {
    const packageDir = path.join(searchRoot, '@geometra', 'proxy')
    if (existsSync(path.join(packageDir, 'package.json'))) return packageDir
  }
  return undefined
}

function shouldPreferWorkspaceDist(packageDir: string, bundledDependencyDir: string): boolean {
  try {
    return realpathSync(packageDir) === realpathSync(bundledDependencyDir)
  } catch {
    return false
  }
}

function buildLocalProxyDistIfPossible(packageDir: string, entryFile: string, errors: string[]): string | undefined {
  const distEntry = path.join(packageDir, 'dist', entryFile)
  const sourceEntry = path.join(packageDir, 'src/index.ts')
  const tsconfigPath = path.join(packageDir, 'tsconfig.build.json')

  if (!existsSync(sourceEntry) || !existsSync(tsconfigPath)) {
    return undefined
  }

  try {
    const realPackageDir = realpathSync(packageDir)
    const realTsconfigPath = path.join(realPackageDir, 'tsconfig.build.json')
    const realDistDir = path.join(realPackageDir, 'dist')
    const tscBin = require.resolve('typescript/bin/tsc')

    rmSync(realDistDir, { recursive: true, force: true })
    const result = spawnSync(process.execPath, [tscBin, '-p', realTsconfigPath], {
      cwd: realPackageDir,
      encoding: 'utf8',
      stdio: 'pipe',
    })

    if (result.status !== 0) {
      const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
      errors.push(
        `Failed to build local @geometra/proxy at ${realPackageDir}: ${detail || `exit ${result.status ?? 'unknown'}`}`,
      )
      return undefined
    }

    if (existsSync(distEntry)) return distEntry

    const realDistEntry = path.join(realPackageDir, 'dist', entryFile)
    if (existsSync(realDistEntry)) return realDistEntry

    errors.push(`Built local @geometra/proxy at ${realPackageDir}, but dist/${entryFile} is still missing`)
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err))
  }

  return undefined
}

/**
 * BYO outbound proxy for the spawned Chromium. JobForge sets this when the
 * user configures a residential / mobile / SOCKS proxy in `profile.yml` to
 * bypass datacenter-IP fingerprinting on apply portals (Ashby class B,
 * Lever Mapbox geocoder, Cloudflare Bot Management, etc.). Geometra is the
 * wire — the user supplies the proxy.
 */
export interface SpawnProxyConfig {
  server: string
  username?: string
  password?: string
  bypass?: string
}

export interface SpawnProxyParams {
  pageUrl: string
  port: number
  headless?: boolean
  width?: number
  height?: number
  slowMo?: number
  stealth?: boolean
  eagerInitialExtract?: boolean
  proxy?: SpawnProxyConfig
}

export function resolveStealthMode(stealth?: boolean): boolean {
  return stealth ?? true
}

export async function startEmbeddedGeometraProxy(
  opts: SpawnProxyParams,
): Promise<{ runtime: EmbeddedProxyRuntime; wsUrl: string }> {
  const runtimePath = resolveProxyRuntimePath()
  const runtimeModule = await import(pathToFileURL(runtimePath).href) as {
    launchProxyRuntime?: (options: {
      url: string
      port: number
      width?: number
      height?: number
      headed?: boolean
      slowMo?: number
      stealth?: boolean
      eagerInitialExtract?: boolean
      proxy?: SpawnProxyConfig
    }) => Promise<EmbeddedProxyRuntime>
  }
  if (typeof runtimeModule.launchProxyRuntime !== 'function') {
    throw new Error(`Resolved ${runtimePath}, but it did not export launchProxyRuntime()`)
  }

  const runtime = await runtimeModule.launchProxyRuntime({
    url: opts.pageUrl,
    port: opts.port,
    width: opts.width,
    height: opts.height,
    headed: opts.headless === false,
    slowMo: opts.slowMo,
    ...(opts.stealth !== undefined && { stealth: opts.stealth }),
    eagerInitialExtract: opts.eagerInitialExtract,
    ...(opts.proxy && { proxy: opts.proxy }),
  })
  return { runtime, wsUrl: runtime.wsUrl }
}

export function parseProxyReadySignalLine(line: string, options?: { allowLegacy?: boolean }): string | undefined {
  const trimmed = line.trim()
  if (!trimmed) return undefined

  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as { type?: unknown; wsUrl?: unknown }
      if (
        parsed.type === READY_SIGNAL_TYPE &&
        typeof parsed.wsUrl === 'string' &&
        /^ws:\/\/127\.0\.0\.1:\d+$/.test(parsed.wsUrl)
      ) {
        return parsed.wsUrl
      }
    } catch {
      /* ignore non-JSON lines */
    }
  }

  if (options?.allowLegacy === false) return undefined

  const fallback = trimmed.match(/WebSocket listening on (ws:\/\/127\.0\.0\.1:\d+)/)
  return fallback?.[1]
}

export function formatProxyStartupFailure(message: string, opts: SpawnProxyParams): string {
  const hints: string[] = []

  if (/Executable doesn't exist|playwright install chromium|browserType\.launch/i.test(message)) {
    hints.push(PLAYWRIGHT_INSTALL_HINT)
  }

  if (/cloakbrowser|CLOAKBROWSER|ERR_MODULE_NOT_FOUND|Cannot find package/i.test(message)) {
    hints.push(
      'Stealth mode uses CloakBrowser. Install dependencies with npm install, or disable stealth with stealth=false / GEOMETRA_STEALTH=0. To prefetch the patched Chromium binary, run: npx cloakbrowser install',
    )
  }

  if (opts.port > 0 && /EADDRINUSE|address already in use/i.test(message)) {
    hints.push(
      `Requested port ${opts.port} is unavailable. Omit the port to use an ephemeral OS-assigned port, or choose another local port.`,
    )
  }

  if (hints.length === 0) return message
  return `${message}\nHint: ${hints.join(' ')}`
}

/**
 * Spawn geometra-proxy as a child process and resolve when it emits a structured ready signal.
 */
export function spawnGeometraProxy(opts: SpawnProxyParams): Promise<{ child: ChildProcess; wsUrl: string }> {
  const script = resolveProxyScriptPath()
  const args = [script, opts.pageUrl, '--port', String(opts.port)]
  if (opts.width != null && opts.width > 0) args.push('--width', String(opts.width))
  if (opts.height != null && opts.height > 0) args.push('--height', String(opts.height))
  if (opts.slowMo != null && opts.slowMo > 0) args.push('--slow-mo', String(opts.slowMo))
  if (opts.headless === false) args.push('--headed')
  else args.push('--headless')
  if (opts.stealth === true) args.push('--stealth')
  else if (opts.stealth === false) args.push('--no-stealth')
  if (opts.eagerInitialExtract === false) args.push('--lazy-initial-extract')
  if (opts.proxy?.server) {
    args.push('--proxy-server', opts.proxy.server)
    if (opts.proxy.username !== undefined) args.push('--proxy-username', opts.proxy.username)
    if (opts.proxy.password !== undefined) args.push('--proxy-password', opts.proxy.password)
    if (opts.proxy.bypass !== undefined) args.push('--proxy-bypass', opts.proxy.bypass)
  }

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GEOMETRA_PROXY_READY_JSON: '1' },
    })

    let settled = false
    let stdoutBuf = ''
    let stderrBuf = ''

    const cleanup = () => {
      clearTimeout(deadline)
      child.stdout?.removeAllListeners('data')
      child.stderr?.removeAllListeners('data')
    }

    const tryResolveReady = (line: string) => {
      const wsUrl = parseProxyReadySignalLine(line, { allowLegacy: false })
      if (!wsUrl || settled) return false
      settled = true
      cleanup()
      resolve({ child, wsUrl })
      return true
    }

    const consumeStdout = (chunk: Buffer) => {
      stdoutBuf += chunk.toString()
      const lines = stdoutBuf.split(/\r?\n/)
      stdoutBuf = lines.pop() ?? ''
      for (const line of lines) {
        if (tryResolveReady(line)) return
      }
    }

    const consumeStderr = (chunk: Buffer) => {
      stderrBuf += chunk.toString()
      const lines = stderrBuf.split(/\r?\n/)
      stderrBuf = lines.pop() ?? ''
      for (const line of lines) {
        if (tryResolveReady(line)) return
      }
    }

    const deadline = setTimeout(() => {
      if (!settled) {
        settled = true
        child.kill('SIGTERM')
        cleanup()
        reject(
          new Error(
            formatProxyStartupFailure('geometra-proxy did not emit a ready signal within 45s', opts),
          ),
        )
      }
    }, READY_TIMEOUT_MS)

    child.stdout?.on('data', consumeStdout)
    child.stderr?.on('data', consumeStderr)

    child.on('error', err => {
      if (!settled) {
        settled = true
        cleanup()
        reject(new Error(formatProxyStartupFailure(err.message, opts)))
      }
    })

    child.on('exit', (code, sig) => {
      if (!settled) {
        settled = true
        cleanup()
        const stderrTail = stderrBuf.trim().slice(-2000)
        reject(
          new Error(
            formatProxyStartupFailure(
              `geometra-proxy exited before ready (code=${code} signal=${sig}). Stderr (tail): ${stderrTail || '(empty)'}`,
              opts,
            ),
          ),
        )
      }
    })
  })
}
