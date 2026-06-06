import type { JsonArray, JsonObject, JsonValue } from './schema.js'

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) return true
  const type = typeof value
  if (type === 'string' || type === 'number' || type === 'boolean') {
    return type !== 'number' || Number.isFinite(value)
  }
  if (Array.isArray(value)) return value.every(isJsonValue)
  if (isJsonObject(value)) return Object.values(value).every(isJsonValue)
  return false
}

export function toJsonValue(value: unknown): JsonValue {
  const normalized = JSON.parse(JSON.stringify(value)) as unknown
  if (!isJsonValue(normalized)) {
    throw new Error('value is not JSON serializable')
  }
  return normalized
}

export function canonicalJson(value: unknown): string {
  const json = toJsonValue(value)
  return writeCanonicalJson(json)
}

export function jsonObject(value: unknown, path: string): JsonObject {
  const normalized = toJsonValue(value)
  if (!isJsonObject(normalized)) {
    throw new Error(`${path} must be a JSON object`)
  }
  return normalized
}

function writeCanonicalJson(value: JsonValue): string {
  if (value === null) return 'null'
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('canonical JSON cannot encode non-finite numbers')
    return JSON.stringify(value)
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (Array.isArray(value)) return `[${value.map(writeCanonicalJson).join(',')}]`
  return `{${Object.keys(value)
    .sort()
    .map(key => `${JSON.stringify(key)}:${writeCanonicalJson(value[key]!)}`)
    .join(',')}}`
}

export function cloneJsonObject<T>(value: T): T {
  return toJsonValue(value) as T
}

export function objectWithoutKey(value: JsonObject, keyToRemove: string): JsonObject {
  const next: JsonObject = {}
  for (const [key, child] of Object.entries(value)) {
    if (key !== keyToRemove) next[key] = child
  }
  return next
}

export function asJsonArray(value: JsonValue): JsonArray {
  return Array.isArray(value) ? value : [value]
}
