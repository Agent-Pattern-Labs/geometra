import { canonicalJson, toJsonValue } from './json.js'

export function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}

export function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('hex string must have an even length')
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  const base64 =
    typeof btoa === 'function'
      ? btoa(String.fromCharCode(...bytes))
      : Buffer.from(bytes).toString('base64')
  return base64.replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

export function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replaceAll('-', '+').replaceAll('_', '/').padEnd(Math.ceil(value.length / 4) * 4, '=')
  if (typeof atob === 'function') {
    return Uint8Array.from(atob(padded), character => character.charCodeAt(0))
  }
  return new Uint8Array(Buffer.from(padded, 'base64'))
}

export async function sha256Hex(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === 'string' ? utf8(value) : value
  const digest = await subtle().digest('SHA-256', webCryptoBytes(bytes))
  return bytesToHex(new Uint8Array(digest))
}

export async function hashJson(value: unknown): Promise<string> {
  return sha256Hex(canonicalJson(toJsonValue(value)))
}

export function webCryptoBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(bytes.byteLength)
  out.set(bytes)
  return out
}

function subtle(): SubtleCrypto {
  const crypto = globalThis.crypto
  if (!crypto?.subtle) {
    throw new Error('Web Crypto subtle API is required for Geometra evidence hashing')
  }
  return crypto.subtle
}
