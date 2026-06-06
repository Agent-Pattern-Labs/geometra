import type { EvidenceRedactionContext, EvidenceRedactionOptions, JsonArray, JsonObject, JsonValue } from './schema.js'
import { isJsonObject, toJsonValue } from './json.js'

const DEFAULT_REPLACEMENT = '[redacted]'
const DEFAULT_KEY_PATTERN = /(?:password|passcode|secret|token|api[_-]?key|authorization|auth|credential|ssn|social|credit|card|cvv)/i

export function redactJson(value: unknown, options: EvidenceRedactionOptions = {}): JsonValue {
  const json = toJsonValue(value)
  const replacement = options.replacement ?? DEFAULT_REPLACEMENT
  const keySet = new Set((options.keys ?? []).map(key => key.toLowerCase()))
  const pathSet = new Set(options.paths ?? [])
  const keyPattern = options.keyPattern ?? DEFAULT_KEY_PATTERN

  const walk = (current: JsonValue, path: string, key?: string): JsonValue => {
    const context: EvidenceRedactionContext = { path, ...(key !== undefined ? { key } : {}) }
    if (pathSet.has(path) || (key !== undefined && (keySet.has(key.toLowerCase()) || keyPattern.test(key)))) {
      return options.redactor?.(current, context) ?? replacement
    }
    if (typeof current === 'string' && options.maxStringLength && current.length > options.maxStringLength) {
      const shortened = `${current.slice(0, options.maxStringLength)}...`
      return options.redactor?.(shortened, context) ?? shortened
    }
    if (Array.isArray(current)) {
      const array: JsonArray = current.map((child, index) => walk(child, `${path}/${index}`))
      return options.redactor?.(array, context) ?? array
    }
    if (isJsonObject(current)) {
      const object: JsonObject = {}
      for (const [childKey, child] of Object.entries(current)) {
        object[childKey] = walk(child, `${path}/${escapePointer(childKey)}`, childKey)
      }
      return options.redactor?.(object, context) ?? object
    }
    return options.redactor?.(current, context) ?? current
  }

  return walk(json, '')
}

function escapePointer(value: string): string {
  return value.replaceAll('~', '~0').replaceAll('/', '~1')
}
