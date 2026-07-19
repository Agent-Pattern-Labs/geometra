import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

type SessionStateModule = typeof import('../session-state.js')

interface SqliteStatement {
  all: () => unknown[]
}

interface SqliteDatabase {
  prepare: (sql: string) => SqliteStatement
  close: () => void
}

type SqliteDatabaseConstructor = new (
  filename: string,
  options?: { readonly?: boolean },
) => SqliteDatabase

interface TestTarget {
  id: string
  url: string
  isolated: boolean
  proxyReusable: boolean
  updateRevision: number
  layout: Record<string, unknown> | null
  tree: Record<string, unknown> | null
  ws: { readyState: number }
  connectTrace: { mode: string }
  cachedA11y: { meta: { pageUrl: string } }
  lifecycleTaskId?: string
  lifecycleTaskKind?: string
  lifecycleLeaseId?: string
  lifecycleWorkerId?: string
  lifecycleFinalized?: boolean
}

const originalStateFile = process.env.GEOMETRA_MCP_STATE_FILE
const originalDisabled = process.env.GEOMETRA_MCP_DISABLE_SESSION_LIFECYCLE
const originalHome = process.env.HOME
const loadedModules: SessionStateModule[] = []
const temporaryRoots: string[] = []
const require = createRequire(import.meta.url)

function openReadonlyDatabase(filename: string): SqliteDatabase {
  const Database = require('better-sqlite3') as SqliteDatabaseConstructor
  return new Database(filename, { readonly: true })
}

function makeTemporaryRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'geometra-session-state-test-'))
  temporaryRoots.push(root)
  return root
}

function makeTarget(id: string): TestTarget {
  return {
    id,
    url: 'wss://controller.example.test:8443/socket/private?token=transport-secret',
    isolated: true,
    proxyReusable: false,
    updateRevision: 7,
    layout: { width: 1280 },
    tree: { semantic: { pageUrl: 'https://tree.example.test/private?secret=tree-secret' } },
    ws: { readyState: 1 },
    connectTrace: { mode: 'fresh-proxy' },
    cachedA11y: {
      meta: { pageUrl: 'https://jobs.example.test/apply/private?token=page-secret#profile' },
    },
  }
}

async function loadSessionState(): Promise<SessionStateModule> {
  vi.resetModules()
  const loaded = await import('../session-state.js')
  loadedModules.push(loaded)
  return loaded
}

function restoreEnvironment(): void {
  if (originalStateFile === undefined) delete process.env.GEOMETRA_MCP_STATE_FILE
  else process.env.GEOMETRA_MCP_STATE_FILE = originalStateFile
  if (originalDisabled === undefined) delete process.env.GEOMETRA_MCP_DISABLE_SESSION_LIFECYCLE
  else process.env.GEOMETRA_MCP_DISABLE_SESSION_LIFECYCLE = originalDisabled
  if (originalHome === undefined) delete process.env.HOME
  else process.env.HOME = originalHome
}

afterEach(() => {
  for (const loaded of loadedModules.splice(0)) {
    try {
      loaded.shutdownSessionLifecycleRegistry()
    } catch {
      /* a deliberately compromised registry may already be closed */
    }
  }
  vi.doUnmock('@razroo/parallel-mcp')
  vi.doUnmock('node:os')
  vi.resetModules()
  restoreEnvironment()
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('secure session lifecycle registry', () => {
  it('is lazy and keeps default lifecycle state in memory without filesystem side effects', async () => {
    const root = makeTemporaryRoot()
    const emptyHome = path.join(root, 'home')
    mkdirSync(emptyHome, { mode: 0o700 })
    process.env.HOME = emptyHome
    vi.doMock('node:os', async importOriginal => {
      const actual = await importOriginal<typeof import('node:os')>()
      return { ...actual, homedir: () => emptyHome }
    })
    const mockedOs = await import('node:os')
    expect(mockedOs.homedir()).toBe(emptyHome)
    delete process.env.GEOMETRA_MCP_STATE_FILE
    delete process.env.GEOMETRA_MCP_DISABLE_SESSION_LIFECYCLE

    const state = await loadSessionState()
    expect(readdirSync(emptyHome)).toEqual([])

    const target = makeTarget('s_default_memory')
    state.initializeSessionLifecycle(target, {
      pageUrl: 'https://jobs.example.test/private?token=never-write-this',
      transportMode: 'direct-ws',
    })
    state.recordSessionSnapshot(target, 'session.connected', { status: 'ready' })

    expect(target.lifecycleFinalized).toBe(false)
    expect(readdirSync(emptyHome)).toEqual([])
    expect(readdirSync(root)).toEqual(['home'])
  })

  it('persists only origins and redacted metadata with private DB/WAL/SHM permissions', async () => {
    const root = makeTemporaryRoot()
    const stateFile = path.join(root, 'private-state', 'sessions.sqlite')
    mkdirSync(path.dirname(stateFile), { mode: 0o700 })
    writeFileSync(stateFile, '', { mode: 0o644 })
    expect(lstatSync(stateFile).mode & 0o777).toBe(0o644)
    process.env.GEOMETRA_MCP_STATE_FILE = stateFile
    delete process.env.GEOMETRA_MCP_DISABLE_SESSION_LIFECYCLE
    const state = await loadSessionState()
    const target = makeTarget('s_secure_disk')

    state.initializeSessionLifecycle(target, {
      pageUrl: 'https://jobs.example.test/apply/private?token=request-secret',
      transportMode: 'direct-ws',
    })
    state.recordSessionSnapshot(target, 'session.navigate', {
      requestedOrigin: 'https://jobs.example.test',
      targetUrl: 'https://accounts.example.test/profile/alice?accessToken=url-secret',
      fieldValue: 'alice@example.test',
      salaryValue: 160_000,
      consentAnswer: true,
      accessToken: 'top-secret-token',
      localPath: '/Users/alice/Documents/private-resume.pdf',
      message: 'raw failure mentions alice@example.test and /Users/alice',
      nested: { arbitrary: 'private answer', status: 'pending' },
    })
    state.failSessionLifecycle(
      target,
      'Error opening /Users/alice/Documents/private-resume.pdf with secret-token',
      {
        errorMessage: 'socket failed for alice@example.test',
        values: ['Alice', '555-0100'],
      },
    )

    expect(lstatSync(path.dirname(stateFile)).mode & 0o777).toBe(0o700)
    expect(lstatSync(stateFile).mode & 0o777).toBe(0o600)
    for (const suffix of ['-wal', '-shm']) {
      const sidecar = `${stateFile}${suffix}`
      expect(existsSync(sidecar)).toBe(true)
      expect(lstatSync(sidecar).mode & 0o777).toBe(0o600)
    }

    const reader = openReadonlyDatabase(stateFile)
    const tables = ['runs', 'tasks', 'task_attempts', 'task_leases', 'context_snapshots', 'events']
    const retainedRows = tables.flatMap(table => reader.prepare(`SELECT * FROM ${table}`).all())
    const snapshotRows = reader.prepare('SELECT label, payload FROM context_snapshots').all() as Array<{
      label: string
      payload: string
    }>
    reader.close()
    const retained = JSON.stringify(retainedRows)
    const navigateSnapshot = snapshotRows.find(row => row.label === 'session.navigate')
    expect(navigateSnapshot).toBeDefined()
    expect(JSON.parse(navigateSnapshot?.payload ?? '{}').extra.requestedOrigin)
      .toBe('https://jobs.example.test')
    expect(JSON.parse(navigateSnapshot?.payload ?? '{}').extra.salaryValue)
      .toBe('[redacted]')
    expect(JSON.parse(navigateSnapshot?.payload ?? '{}').extra.consentAnswer)
      .toBe('[redacted]')

    expect(retained).toContain('wss://controller.example.test:8443')
    expect(retained).toContain('https://jobs.example.test')
    expect(retained).toContain('https://accounts.example.test')
    expect(retained).toContain('[redacted]')
    expect(retained).toContain('[redacted-path]')
    expect(retained).toContain('[redacted-error]')
    for (const secret of [
      '/socket/private',
      '/apply/private',
      '/profile/alice',
      'transport-secret',
      'request-secret',
      'url-secret',
      'top-secret-token',
      'alice@example.test',
      '/Users/alice',
      'private answer',
      'Alice',
      '555-0100',
    ]) {
      expect(retained).not.toContain(secret)
    }
  })

  it('retains only the allowlisted structured lifecycle error codes', async () => {
    const root = makeTemporaryRoot()
    const stateFile = path.join(root, 'private-state', 'sessions.sqlite')
    process.env.GEOMETRA_MCP_STATE_FILE = stateFile
    const state = await loadSessionState()

    const structured = makeTarget('s_structured_error')
    state.initializeSessionLifecycle(structured)
    state.failSessionLifecycle(structured, 'websocket_error')

    const tokenLikeRaw = makeTarget('s_token_error')
    state.initializeSessionLifecycle(tokenLikeRaw)
    state.failSessionLifecycle(tokenLikeRaw, 'secret-token')

    const reader = openReadonlyDatabase(stateFile)
    const errors = reader.prepare('SELECT error FROM tasks ORDER BY id').all() as Array<{ error: string }>
    reader.close()
    expect(errors.map(row => row.error)).toContain('websocket_error')
    expect(errors.map(row => row.error)).toContain('[redacted-error]')
    expect(JSON.stringify(errors)).not.toContain('secret-token')
  })

  it('rejects insecure directories and symbolic-link database targets without falling back', async () => {
    const root = makeTemporaryRoot()
    const insecureDirectory = path.join(root, 'shared-state')
    mkdirSync(insecureDirectory, { mode: 0o700 })
    chmodSync(insecureDirectory, 0o755)
    const insecureStateFile = path.join(insecureDirectory, 'sessions.sqlite')
    process.env.GEOMETRA_MCP_STATE_FILE = insecureStateFile
    const insecureState = await loadSessionState()

    expect(() => insecureState.initializeSessionLifecycle(makeTarget('s_insecure')))
      .toThrow(/must not grant group or other access/)
    expect(existsSync(insecureStateFile)).toBe(false)

    insecureState.shutdownSessionLifecycleRegistry()
    chmodSync(insecureDirectory, 0o700)
    const realFile = path.join(insecureDirectory, 'real.sqlite')
    const linkedFile = path.join(insecureDirectory, 'linked.sqlite')
    writeFileSync(realFile, '', { mode: 0o600 })
    symlinkSync(realFile, linkedFile)
    process.env.GEOMETRA_MCP_STATE_FILE = linkedFile

    expect(() => insecureState.initializeSessionLifecycle(makeTarget('s_symlink')))
      .toThrow(/regular file, not a symbolic link or special file/)
    expect(lstatSync(linkedFile).isSymbolicLink()).toBe(true)

    insecureState.shutdownSessionLifecycleRegistry()
    const sidecarStateFile = path.join(insecureDirectory, 'sidecar.sqlite')
    const maliciousSidecarTarget = path.join(insecureDirectory, 'malicious-wal-target')
    writeFileSync(sidecarStateFile, '', { mode: 0o600 })
    writeFileSync(maliciousSidecarTarget, 'must remain untouched', { mode: 0o600 })
    symlinkSync(maliciousSidecarTarget, `${sidecarStateFile}-wal`)
    process.env.GEOMETRA_MCP_STATE_FILE = sidecarStateFile

    expect(() => insecureState.initializeSessionLifecycle(makeTarget('s_sidecar_symlink')))
      .toThrow(/WAL file must be a regular file/)
    expect(lstatSync(`${sidecarStateFile}-wal`).isSymbolicLink()).toBe(true)
  })

  it('resets the singleton on shutdown so a later explicit store is honored', async () => {
    const root = makeTemporaryRoot()
    delete process.env.GEOMETRA_MCP_STATE_FILE
    const state = await loadSessionState()
    state.initializeSessionLifecycle(makeTarget('s_first_memory'))
    state.shutdownSessionLifecycleRegistry()

    const stateFile = path.join(root, 'private-state', 'sessions.sqlite')
    process.env.GEOMETRA_MCP_STATE_FILE = stateFile
    const target = makeTarget('s_after_shutdown')
    state.initializeSessionLifecycle(target)

    expect(existsSync(stateFile)).toBe(true)
    expect(target.lifecycleFinalized).toBe(false)
  })

  it('marks a registry unavailable after an active artifact security check fails', async () => {
    const root = makeTemporaryRoot()
    const directory = path.join(root, 'private-state')
    const stateFile = path.join(directory, 'sessions.sqlite')
    process.env.GEOMETRA_MCP_STATE_FILE = stateFile
    const state = await loadSessionState()
    const first = makeTarget('s_before_compromise')
    state.initializeSessionLifecycle(first)

    chmodSync(directory, 0o755)
    expect(() => state.recordSessionSnapshot(first, 'session.connected'))
      .toThrow(/failed a security check and was closed/)

    const afterFailure = makeTarget('s_after_compromise')
    state.initializeSessionLifecycle(afterFailure)
    expect(afterFailure.lifecycleFinalized).toBe(true)
    expect(afterFailure.lifecycleTaskId).toBeUndefined()
    chmodSync(directory, 0o700)
  })

  it('fails soft only for default in-memory native initialization failures', async () => {
    vi.doMock('@razroo/parallel-mcp', () => ({
      SqliteParallelMcpStore: class {
        constructor() {
          throw Object.assign(new Error('missing better_sqlite3.node'), { code: 'ERR_DLOPEN_FAILED' })
        }
      },
      ParallelMcpOrchestrator: class {},
    }))

    delete process.env.GEOMETRA_MCP_STATE_FILE
    const state = await loadSessionState()
    const defaultTarget = makeTarget('s_native_unavailable')
    expect(() => state.initializeSessionLifecycle(defaultTarget)).not.toThrow()
    expect(defaultTarget.lifecycleFinalized).toBe(true)

    state.shutdownSessionLifecycleRegistry()
    const root = makeTemporaryRoot()
    process.env.GEOMETRA_MCP_STATE_FILE = path.join(root, 'private-state', 'sessions.sqlite')
    expect(() => state.initializeSessionLifecycle(makeTarget('s_explicit_native_failure')))
      .toThrow(/SQLite native module is unavailable/)
  })
})
