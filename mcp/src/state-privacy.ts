export type RetainedJsonValue =
  | null
  | string
  | number
  | boolean
  | RetainedJsonValue[]
  | { [key: string]: RetainedJsonValue }

export const REDACTED_STATE_VALUE = '[redacted]'
export const REDACTED_STATE_ERROR = '[redacted-error]'
export const REDACTED_STATE_PATH = '[redacted-path]'
export const REDACTED_STATE_URL = '[redacted-url]'

const MAX_RETAINED_DEPTH = 8
const MAX_RETAINED_ARRAY_ITEMS = 64
const MAX_RETAINED_OBJECT_ENTRIES = 64

const URL_KEY = /(?:^|[_-])(?:url|uri|href|location)(?:$|[_-])/i
const ERROR_KEY = /(?:^|[_-])(?:error|errors|message|messages|stack|cause|exception|failure)(?:$|[_-])/i
const PATH_KEY = /(?:^|[_-])(?:path|paths|file|files|filename|filenames|directory|dirname|cwd|root)(?:$|[_-])/i
const SECRET_KEY = /(?:^|[_-])(?:password|passwd|passcode|secret|token|authorization|auth|cookie|credential|api[_-]?key|access[_-]?key|private[_-]?key)(?:$|[_-])/i
const VALUE_KEY = /(?:^|[_-])(?:value|values|answer|answers|response|responses|content|text|body|result|results|payload|formdata|filled)(?:$|[_-])/i
const SAFE_STRING_KEY = /^(?:sessionId|label|connectMode|transportMode|proxyStartMode|mode|status|reason|type|kind|scope|format)$/i
const SAFE_PRIMITIVE_KEY = /^(?:isolated|proxyReusable|wsReadyState|updateRevision|hasLayout|hasTree|awaitInitialFrame|authenticatedProxyHandshake|lateInitialFrame|reconnectable|closeProxy|forceCloseProxy|reusedExistingSession|timeoutMs|proxyStartMs|connectMs|wsOpenMs|firstFrameMs|resizeKickoffMs|navigateMs|totalMs)$/i
const SAFE_TOKEN = /^[a-z0-9][a-z0-9_.:-]{0,127}$/i
const RETAINED_ERROR_CODES = new Set([
  'connect_timeout',
  'websocket_error',
  'websocket_closed_before_ready',
  'reconnect_failed',
])
const URL_PREFIX = /^(?:https?|wss?):\/\//i
const ABSOLUTE_PATH = /^(?:\/|[a-z]:[\\/]|\\\\)/i
const SAFE_OBJECT_KEY = /^[a-z][a-z0-9_.-]{0,63}$/i

/**
 * Retain only the network origin of a URL. Paths, queries, fragments, and
 * credentials are deliberately discarded. Non-network and malformed URLs
 * have no safe origin and are represented by a fixed redaction marker.
 */
export function sanitizeUrlToOrigin(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null
  if (typeof value !== 'string') return REDACTED_STATE_URL

  try {
    const parsed = new URL(value)
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(parsed.protocol)) {
      return REDACTED_STATE_URL
    }
    return parsed.origin === 'null' ? REDACTED_STATE_URL : parsed.origin
  } catch {
    return REDACTED_STATE_URL
  }
}

/** Retain a bounded, machine-readable lifecycle code, never a raw message. */
export function sanitizeRetainedCode(
  value: unknown,
  fallback = REDACTED_STATE_VALUE,
): string {
  return typeof value === 'string' && SAFE_TOKEN.test(value) ? value : fallback
}

/** Retain a structured error code while replacing free-form errors/messages. */
export function sanitizeRetainedError(value: unknown): string {
  return typeof value === 'string' && RETAINED_ERROR_CODES.has(value)
    ? value
    : REDACTED_STATE_ERROR
}

function classifyKey(key: string | undefined): 'url' | 'error' | 'path' | 'secret' | 'value' | 'safe' | 'primitive' | 'unknown' {
  if (!key) return 'unknown'
  if (URL_KEY.test(key) || /(?:url|uri|href|location|origin)$/i.test(key)) return 'url'
  if (ERROR_KEY.test(key) || /(?:error|message|stack|cause|exception|failure)$/i.test(key)) return 'error'
  if (PATH_KEY.test(key) || /(?:path|file|filename|directory|dirname|cwd|root)$/i.test(key)) return 'path'
  if (SECRET_KEY.test(key) || /(?:password|passwd|passcode|secret|token|authorization|auth|cookie|credential|apiKey|accessKey|privateKey)$/i.test(key)) return 'secret'
  if (VALUE_KEY.test(key) || /(?:value|values|answer|answers|response|responses|content|text|body|result|results|payload|formdata|filled)$/i.test(key)) return 'value'
  if (SAFE_STRING_KEY.test(key)) return 'safe'
  if (SAFE_PRIMITIVE_KEY.test(key)) return 'primitive'
  return 'unknown'
}

function sanitizeObjectKey(key: string, index: number): string {
  if (
    SAFE_OBJECT_KEY.test(key) &&
    key !== '__proto__' &&
    key !== 'prototype' &&
    key !== 'constructor'
  ) {
    return key
  }
  return `redactedKey${index + 1}`
}

function sanitizeString(value: string, key: string | undefined): string | null {
  switch (classifyKey(key)) {
    case 'url':
      return sanitizeUrlToOrigin(value)
    case 'error':
      return sanitizeRetainedError(value)
    case 'path':
      return REDACTED_STATE_PATH
    case 'secret':
    case 'value':
      return REDACTED_STATE_VALUE
    case 'safe':
      return sanitizeRetainedCode(value)
    default:
      if (URL_PREFIX.test(value)) return sanitizeUrlToOrigin(value)
      if (value.startsWith('file:') || ABSOLUTE_PATH.test(value)) return REDACTED_STATE_PATH
      return REDACTED_STATE_VALUE
  }
}

function sanitizeValue(
  value: unknown,
  key: string | undefined,
  depth: number,
  ancestors: WeakSet<object>,
): RetainedJsonValue {
  if (value === null || value === undefined) return null
  const classification = classifyKey(key)
  if (classification === 'url') {
    return sanitizeUrlToOrigin(value instanceof URL ? value.toString() : value)
  }
  if (classification === 'error') {
    return typeof value === 'string' ? sanitizeRetainedError(value) : REDACTED_STATE_ERROR
  }
  if (classification === 'path') return REDACTED_STATE_PATH
  if (classification === 'secret' || classification === 'value') return REDACTED_STATE_VALUE
  if (typeof value === 'boolean') {
    return classification === 'primitive' ? value : REDACTED_STATE_VALUE
  }
  if (typeof value === 'number') {
    return classification === 'primitive' && Number.isFinite(value)
      ? value
      : classification === 'primitive'
        ? null
        : REDACTED_STATE_VALUE
  }
  if (typeof value === 'string') return sanitizeString(value, key)
  if (value instanceof Date) return REDACTED_STATE_VALUE
  if (value instanceof URL) return sanitizeUrlToOrigin(value.toString())
  if (value instanceof Error) return REDACTED_STATE_ERROR
  if (typeof value !== 'object') return REDACTED_STATE_VALUE
  if (depth >= MAX_RETAINED_DEPTH || ancestors.has(value)) return REDACTED_STATE_VALUE

  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      return value
        .slice(0, MAX_RETAINED_ARRAY_ITEMS)
        .map(entry => sanitizeValue(entry, key, depth + 1, ancestors))
    }

    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      return REDACTED_STATE_VALUE
    }

    const output: { [key: string]: RetainedJsonValue } = {}
    const entries = Object.entries(value).slice(0, MAX_RETAINED_OBJECT_ENTRIES)
    entries.forEach(([entryKey, entryValue], index) => {
      const retainedKey = sanitizeObjectKey(entryKey, index)
      output[retainedKey] = sanitizeValue(entryValue, entryKey, depth + 1, ancestors)
    })
    return output
  } finally {
    ancestors.delete(value)
  }
}

/**
 * Convert arbitrary state into bounded JSON while defaulting all unknown
 * strings to redaction. This is intentionally stricter than a JSON serializer:
 * callers must use explicit metadata keys for the few strings worth retaining.
 */
export function sanitizeRetainedState(value: unknown): RetainedJsonValue {
  return sanitizeValue(value, undefined, 0, new WeakSet<object>())
}
