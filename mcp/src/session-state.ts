import {
  accessSync,
  chmodSync,
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  openSync,
  type Stats,
} from 'node:fs'
import path from 'node:path'
import {
  ParallelMcpOrchestrator,
  SqliteParallelMcpStore,
  type JsonObject,
  type JsonValue,
} from '@razroo/parallel-mcp'
import {
  sanitizeRetainedCode,
  sanitizeRetainedError,
  sanitizeRetainedState,
} from './state-privacy.js'

interface SessionLifecycleTarget {
  id: string
  url: string
  isolated?: boolean
  proxyReusable?: boolean
  updateRevision: number
  layout: Record<string, unknown> | null
  tree: Record<string, unknown> | null
  ws: { readyState: number }
  connectTrace?: { mode?: string } | null
  cachedA11y?: { meta?: { pageUrl?: string } } | null
  lifecycleTaskId?: string
  lifecycleTaskKind?: string
  lifecycleLeaseId?: string
  lifecycleWorkerId?: string
  lifecycleFinalized?: boolean
}

const SESSION_NAMESPACE = 'geometra-mcp-session'
const SESSION_TASK_KEY = 'session.live'
const SESSION_LEASE_MS = 60_000
const SESSION_SWEEP_MS = 15_000
const SESSION_WORKER_PREFIX = `geometra-mcp:${process.pid}`
const SECURE_DIRECTORY_MODE = 0o700
const SECURE_FILE_MODE = 0o600

interface SessionStateStorage {
  filename: string
  persistentPath: string | null
}

interface SessionLifecycleRegistry {
  available: boolean
  orchestrator: ParallelMcpOrchestrator | null
  secureArtifacts: () => void
  close: () => void
}

class SessionStateConfigurationError extends Error {}

let lifecycleRegistry: SessionLifecycleRegistry | null = null

function configurationError(message: string): SessionStateConfigurationError {
  return new SessionStateConfigurationError(`Refusing GEOMETRA_MCP_STATE_FILE: ${message}`)
}

function lstatIfPresent(targetPath: string, description: string): Stats | null {
  try {
    return lstatSync(targetPath)
  } catch (error) {
    if ((error as { code?: unknown }).code === 'ENOENT') return null
    throw configurationError(`${description} could not be inspected securely`)
  }
}

function assertCurrentProcessOwns(stats: Stats, description: string): void {
  if (typeof process.geteuid === 'function' && stats.uid !== process.geteuid()) {
    throw configurationError(`${description} must be owned by the current user`)
  }
}

function assertSecureStateDirectory(directory: string): void {
  const stats = lstatIfPresent(directory, 'parent directory')
  if (!stats) throw configurationError('parent directory does not exist')
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw configurationError('parent must be a real directory, not a symbolic link')
  }
  assertCurrentProcessOwns(stats, 'parent directory')
  if ((stats.mode & 0o077) !== 0) {
    throw configurationError('existing parent directory must not grant group or other access (mode 0700 or stricter)')
  }
  try {
    accessSync(directory, constants.R_OK | constants.W_OK | constants.X_OK)
  } catch {
    throw configurationError('parent directory must be readable, writable, and searchable by the current user')
  }
}

function assertRegularOwnedArtifact(stats: Stats, description: string): void {
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw configurationError(`${description} must be a regular file, not a symbolic link or special file`)
  }
  assertCurrentProcessOwns(stats, description)
  if (stats.nlink !== 1) {
    throw configurationError(`${description} must not have multiple hard links`)
  }
}

function secureExistingArtifact(artifactPath: string, description: string): boolean {
  const stats = lstatIfPresent(artifactPath, description)
  if (!stats) return false
  assertRegularOwnedArtifact(stats, description)
  try {
    chmodSync(artifactPath, SECURE_FILE_MODE)
  } catch {
    throw configurationError(`${description} permissions could not be restricted to mode 0600`)
  }
  const secured = lstatIfPresent(artifactPath, description)
  if (!secured) throw configurationError(`${description} disappeared while permissions were secured`)
  assertRegularOwnedArtifact(secured, description)
  if ((secured.mode & 0o077) !== 0) {
    throw configurationError(`${description} permissions are not private`)
  }
  return true
}

function sqliteSidecarPaths(filename: string): Array<[string, string]> {
  return [
    [`${filename}-wal`, 'WAL file'],
    [`${filename}-shm`, 'shared-memory file'],
    [`${filename}-journal`, 'rollback journal'],
  ]
}

function preparePersistentStateFile(filename: string): void {
  const directory = path.dirname(filename)
  if (!lstatIfPresent(directory, 'parent directory')) {
    try {
      mkdirSync(directory, { recursive: true, mode: SECURE_DIRECTORY_MODE })
    } catch {
      throw configurationError('parent directory could not be created securely')
    }
  }
  assertSecureStateDirectory(directory)

  for (const [sidecarPath, description] of sqliteSidecarPaths(filename)) {
    secureExistingArtifact(sidecarPath, description)
  }

  if (!secureExistingArtifact(filename, 'database file')) {
    let descriptor: number | undefined
    try {
      const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0
      descriptor = openSync(
        filename,
        constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | noFollow,
        SECURE_FILE_MODE,
      )
    } catch {
      throw configurationError('database file could not be created exclusively and securely')
    } finally {
      if (descriptor !== undefined) closeSync(descriptor)
    }
    secureExistingArtifact(filename, 'database file')
  }
}

function securePersistentArtifacts(filename: string): void {
  assertSecureStateDirectory(path.dirname(filename))
  if (!secureExistingArtifact(filename, 'database file')) {
    throw configurationError('database file disappeared while storage was active')
  }
  for (const [sidecarPath, description] of sqliteSidecarPaths(filename)) {
    secureExistingArtifact(sidecarPath, description)
  }
}

function resolveSessionStateStorage(): SessionStateStorage {
  const raw = process.env.GEOMETRA_MCP_STATE_FILE?.trim()
  if (!raw || raw === ':memory:') {
    return { filename: ':memory:', persistentPath: null }
  }
  if (raw.includes('\0')) throw configurationError('path contains an invalid null byte')

  const filename = path.resolve(raw)
  preparePersistentStateFile(filename)
  return { filename, persistentPath: filename }
}

function isSessionLifecycleDisabled(): boolean {
  const raw = process.env.GEOMETRA_MCP_DISABLE_SESSION_LIFECYCLE?.trim().toLowerCase()
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on'
}

function formatSessionLifecycleInitError(error: unknown): string {
  if (error instanceof SessionStateConfigurationError) return error.message
  if (
    error instanceof Error &&
    (error as { code?: unknown }).code === 'ERR_DLOPEN_FAILED' &&
    error.message.includes('better_sqlite3.node')
  ) {
    return 'The SQLite native module is unavailable. Rebuild it with `npm rebuild better-sqlite3` in the MCP package directory, or reinstall dependencies for the current Node.js version.'
  }
  return 'Secure session lifecycle storage could not be initialized'
}

function createSessionLifecycleRegistry(): SessionLifecycleRegistry {
  if (isSessionLifecycleDisabled()) {
    process.stderr.write(
      '[geometra-mcp] session lifecycle disabled via GEOMETRA_MCP_DISABLE_SESSION_LIFECYCLE\n',
    )
    return {
      available: false,
      orchestrator: null,
      secureArtifacts: () => {},
      close: () => {},
    }
  }

  const configuredStateFile = process.env.GEOMETRA_MCP_STATE_FILE?.trim()
  const persistentStorageRequested = Boolean(configuredStateFile && configuredStateFile !== ':memory:')
  let orchestrator: ParallelMcpOrchestrator | null = null
  try {
    const storage = resolveSessionStateStorage()
    orchestrator = new ParallelMcpOrchestrator(
      new SqliteParallelMcpStore({ filename: storage.filename }),
      { defaultLeaseMs: SESSION_LEASE_MS },
    )

    const secureArtifacts = storage.persistentPath
      ? () => securePersistentArtifacts(storage.persistentPath as string)
      : () => {}
    secureArtifacts()

    let closed = false
    let leaseSweep: ReturnType<typeof setInterval> | null = null
    const close = () => {
      if (closed) return
      closed = true
      if (leaseSweep) clearInterval(leaseSweep)
      try {
        secureArtifacts()
      } finally {
        orchestrator?.close()
      }
    }

    leaseSweep = setInterval(() => {
      if (closed) return
      try {
        orchestrator?.expireLeases()
        secureArtifacts()
      } catch {
        process.stderr.write(
          '[geometra-mcp] session lifecycle storage failed a background security check and was closed\n',
        )
        try {
          close()
        } catch {
          /* already failed closed */
        }
      }
    }, SESSION_SWEEP_MS)
    leaseSweep.unref()

    return {
      get available() {
        return !closed
      },
      orchestrator,
      secureArtifacts,
      close,
    }
  } catch (error) {
    try {
      orchestrator?.close()
    } catch {
      /* initialization already failed */
    }
    const safeError = formatSessionLifecycleInitError(error)
    if (persistentStorageRequested) {
      // The caught cause can contain the configured path or native-module
      // filesystem details; attaching it would defeat this privacy boundary.
      // eslint-disable-next-line preserve-caught-error
      throw new Error(safeError)
    }
    process.stderr.write(`[geometra-mcp] session lifecycle unavailable: ${safeError}\n`)
    return {
      available: false,
      orchestrator: null,
      secureArtifacts: () => {},
      close: () => {},
    }
  }
}

function getSessionLifecycleRegistry(): SessionLifecycleRegistry {
  if (!lifecycleRegistry) lifecycleRegistry = createSessionLifecycleRegistry()
  return lifecycleRegistry
}

function currentSessionLifecycleRegistry(): SessionLifecycleRegistry | null {
  return lifecycleRegistry?.available && lifecycleRegistry.orchestrator
    ? lifecycleRegistry
    : null
}

function extractPageUrl(target: SessionLifecycleTarget): string | null {
  const cached = target.cachedA11y?.meta?.pageUrl
  if (typeof cached === 'string' && cached.length > 0) return cached
  const semantic = (target.tree as { semantic?: { pageUrl?: unknown } } | null | undefined)?.semantic
  if (semantic && typeof semantic.pageUrl === 'string' && semantic.pageUrl.length > 0) return semantic.pageUrl
  return null
}

function toRetainedJsonValue(value: unknown): JsonValue {
  return sanitizeRetainedState(value) as JsonValue
}

function toRetainedJsonObject(value: Record<string, unknown>): JsonObject {
  const retained = sanitizeRetainedState(value)
  if (retained && typeof retained === 'object' && !Array.isArray(retained)) {
    return retained as JsonObject
  }
  return {}
}

function buildSessionContext(
  target: SessionLifecycleTarget,
  label: string,
  extra?: Record<string, unknown>,
): JsonObject {
  return toRetainedJsonObject({
    sessionId: target.id,
    label,
    transportUrl: target.url,
    pageUrl: extractPageUrl(target),
    isolated: target.isolated === true,
    proxyReusable: target.proxyReusable === true,
    wsReadyState: target.ws.readyState,
    updateRevision: target.updateRevision,
    hasLayout: target.layout !== null,
    hasTree: target.tree !== null,
    connectMode: target.connectTrace?.mode ?? null,
    ...(extra ? { extra } : {}),
  })
}

function liveTaskIdFor(sessionId: string): string {
  return `${sessionId}:live`
}

function liveTaskKindFor(sessionId: string): string {
  return `session.live:${sessionId}`
}

function workerIdFor(sessionId: string): string {
  return `${SESSION_WORKER_PREFIX}:${sessionId}`
}

function secureAfterWrite(registry: SessionLifecycleRegistry): void {
  try {
    registry.secureArtifacts()
  } catch {
    try {
      registry.close()
    } catch {
      /* fail closed even if SQLite close also fails */
    }
    throw new Error('Session lifecycle storage failed a security check and was closed')
  }
}

export function initializeSessionLifecycle(
  target: SessionLifecycleTarget,
  options?: { pageUrl?: string; transportMode?: string },
): void {
  const registry = getSessionLifecycleRegistry()
  if (!registry.available || !registry.orchestrator) {
    target.lifecycleFinalized = true
    target.lifecycleTaskId = undefined
    target.lifecycleTaskKind = undefined
    target.lifecycleLeaseId = undefined
    target.lifecycleWorkerId = undefined
    return
  }

  const orchestrator = registry.orchestrator
  const sessionId = target.id
  const taskId = liveTaskIdFor(sessionId)
  const taskKind = liveTaskKindFor(sessionId)
  const workerId = workerIdFor(sessionId)

  orchestrator.createRun({
    id: sessionId,
    namespace: SESSION_NAMESPACE,
    metadata: toRetainedJsonValue({
      transportMode: options?.transportMode ?? 'direct-ws',
      isolated: target.isolated === true,
    }),
    context: buildSessionContext(target, 'session.initialized', {
      requestedPageUrl: options?.pageUrl ?? null,
    }),
  })

  orchestrator.enqueueTask({
    id: taskId,
    runId: sessionId,
    key: SESSION_TASK_KEY,
    kind: taskKind,
    input: toRetainedJsonValue({
      transportUrl: target.url,
      requestedPageUrl: options?.pageUrl ?? null,
    }),
  })

  const claimed = orchestrator.claimNextTask({
    workerId,
    kinds: [taskKind],
    leaseMs: SESSION_LEASE_MS,
  })

  if (!claimed || claimed.task.id !== taskId) {
    throw new Error('Failed to initialize session lifecycle task')
  }

  orchestrator.markTaskRunning({
    taskId,
    leaseId: claimed.lease.id,
    workerId,
  })
  secureAfterWrite(registry)

  target.lifecycleTaskId = taskId
  target.lifecycleTaskKind = taskKind
  target.lifecycleLeaseId = claimed.lease.id
  target.lifecycleWorkerId = workerId
  target.lifecycleFinalized = false
}

export function heartbeatSessionLifecycle(target: SessionLifecycleTarget): void {
  const registry = currentSessionLifecycleRegistry()
  if (!registry?.orchestrator) return
  if (target.lifecycleFinalized || !target.lifecycleTaskId || !target.lifecycleLeaseId || !target.lifecycleWorkerId) return
  registry.orchestrator.heartbeatLease({
    taskId: target.lifecycleTaskId,
    leaseId: target.lifecycleLeaseId,
    workerId: target.lifecycleWorkerId,
    leaseMs: SESSION_LEASE_MS,
  })
  secureAfterWrite(registry)
}

export function recordSessionSnapshot(
  target: SessionLifecycleTarget,
  label: string,
  extra?: Record<string, unknown>,
): void {
  const registry = currentSessionLifecycleRegistry()
  if (!registry?.orchestrator || !target.lifecycleTaskId) return
  const retainedLabel = sanitizeRetainedCode(label)
  registry.orchestrator.appendContextSnapshot({
    runId: target.id,
    taskId: target.lifecycleTaskId,
    scope: 'run',
    label: retainedLabel,
    payload: buildSessionContext(target, retainedLabel, extra),
  })
  secureAfterWrite(registry)
}

export function completeSessionLifecycle(
  target: SessionLifecycleTarget,
  reason: string,
  extra?: Record<string, unknown>,
): void {
  const registry = currentSessionLifecycleRegistry()
  if (!registry?.orchestrator) return
  if (target.lifecycleFinalized || !target.lifecycleTaskId || !target.lifecycleLeaseId || !target.lifecycleWorkerId) return
  const retainedReason = sanitizeRetainedCode(reason)
  registry.orchestrator.completeTask({
    taskId: target.lifecycleTaskId,
    leaseId: target.lifecycleLeaseId,
    workerId: target.lifecycleWorkerId,
    output: toRetainedJsonValue({
      reason: retainedReason,
      ...(extra ? { extra } : {}),
    }),
    nextContext: buildSessionContext(target, 'session.completed', {
      reason: retainedReason,
      ...(extra ? { ...extra } : {}),
    }),
    nextContextLabel: 'session.completed',
  })
  secureAfterWrite(registry)
  target.lifecycleFinalized = true
}

export function failSessionLifecycle(
  target: SessionLifecycleTarget,
  error: string,
  extra?: Record<string, unknown>,
): void {
  const registry = currentSessionLifecycleRegistry()
  if (!registry?.orchestrator) return
  if (target.lifecycleFinalized || !target.lifecycleTaskId || !target.lifecycleLeaseId || !target.lifecycleWorkerId) return
  const retainedError = sanitizeRetainedError(error)
  recordSessionSnapshot(target, 'session.failed', {
    error: retainedError,
    ...(extra ? { ...extra } : {}),
  })
  registry.orchestrator.failTask({
    taskId: target.lifecycleTaskId,
    leaseId: target.lifecycleLeaseId,
    workerId: target.lifecycleWorkerId,
    error: retainedError,
    metadata: extra ? toRetainedJsonValue(extra) : undefined,
  })
  secureAfterWrite(registry)
  target.lifecycleFinalized = true
}

export function shutdownSessionLifecycleRegistry(): void {
  const registry = lifecycleRegistry
  lifecycleRegistry = null
  registry?.close()
}
