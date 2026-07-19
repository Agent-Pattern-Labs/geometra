import type { ComputedLayout } from 'textura'
import { isFinitePlainNumber, type UIElement } from '@geometra/core'

/** Increment when the shared geometry frame/event wire changes incompatibly. */
export const GEOMETRY_PROTOCOL_VERSION = 1

/**
 * Backward-compatible name for the geometry protocol version.
 *
 * Browser-only automation has its own version in `@geometra/proxy`; do not
 * reuse this value for proxy actions.
 */
export const PROTOCOL_VERSION = GEOMETRY_PROTOCOL_VERSION

/** WebSocket close code: connection rejected by onConnection hook. */
export const CLOSE_AUTH_FAILED = 4001

/** WebSocket close code: message rejected by onMessage hook. */
export const CLOSE_FORBIDDEN = 4003

/**
 * Protocol compatibility rule:
 * - `undefined` means legacy v1 and is accepted.
 * - newer peer versions are rejected explicitly (`peerVersion > currentVersion`).
 * - equal/older finite versions are accepted for backward compatibility.
 *
 * Non-finite numeric `peerVersion` values (`NaN`, `±Infinity`) yield `false` — they are not treated as legacy
 * — so corrupt wire numbers fail closed instead of connecting.
 *
 * Non-number runtime values (e.g. `BigInt` from a malformed decoder) are rejected via
 * {@link isFinitePlainNumber} — same primitive-finite rule as layout patches; we never coerce wire values
 * (global `isFinite` throws on `BigInt`).
 *
 * `currentVersion` is not validated: `NaN` makes `peerVersion <= currentVersion` false for every
 * defined peer (while `undefined` peers still short-circuit to `true`). `±Infinity` follows normal
 * numeric ordering (`finite <= Infinity` is `true`; `finite <= -Infinity` is `false`).
 */
export function isProtocolCompatible(
  peerVersion: number | undefined,
  currentVersion = PROTOCOL_VERSION,
): boolean {
  if (peerVersion === undefined) return true
  if (!isFinitePlainNumber(peerVersion)) return false
  return peerVersion <= currentVersion
}

export interface ProtocolCapabilities {
  /** Which implementation owns this WebSocket endpoint. */
  transport?: 'native' | 'proxy'
  /** This peer can correlate action results with `requestId`. */
  requestScopedAcks?: boolean
  /** This peer implements browser-only automation messages. */
  proxyActions?: boolean
  /** Browser actions can resolve exact authored field identities. */
  exactFieldIdentity?: boolean
  /** This peer supports binary geometry frames after resize negotiation. */
  binaryFraming?: boolean
}

interface VersionedMessage {
  /** Legacy version field. For native messages this is the geometry version. */
  protocolVersion?: number
  /** Explicit version of the shared geometry frame/event wire. */
  geometryProtocolVersion?: number
  /** Explicit version of the browser-only action wire, when supported. */
  proxyActionProtocolVersion?: number
  /** Explicitly advertised wire capabilities. */
  protocolCapabilities?: ProtocolCapabilities
}

interface CorrelatedMessage {
  requestId?: string
}

/**
 * Arbitrary JSON-serializable payload on the same WebSocket as layout frames.
 * Use namespaced `channel` strings (e.g. `geom.tracker.snapshot`) so clients and headless agents
 * can subscribe without a second HTTP API.
 */
export type ServerDataMessage = VersionedMessage & {
  type: 'data'
  /** Non-empty namespaced id (e.g. `geom.tracker.snapshot`). */
  channel: string
  /** Must be JSON-serializable (structured clone / JSON.stringify safe). */
  payload: unknown
}

/** Messages sent from server to client. */
export type ServerMessage =
  | (VersionedMessage & { type: 'frame'; layout: ComputedLayout; tree: UIElement })
  | (VersionedMessage & { type: 'patch'; patches: LayoutPatch[] })
  | (VersionedMessage & CorrelatedMessage & { type: 'ack'; result?: unknown })
  | (VersionedMessage & CorrelatedMessage & { type: 'error'; message: string; code?: number })
  | ServerDataMessage

/**
 * Messages sent from client to server.
 * For `type: 'event'`, `x` and `y` must be finite plain numbers; the server ignores events whose
 * coordinates are null (e.g. JSON-serialized `NaN`), strings, or otherwise non-finite.
 */
export type ClientMessage =
  | (VersionedMessage & CorrelatedMessage & { type: 'event'; eventType: string; x: number; y: number })
  | (VersionedMessage & CorrelatedMessage & {
      type: 'key'
      eventType: 'onKeyDown' | 'onKeyUp'
      key: string
      code: string
      shiftKey: boolean
      ctrlKey: boolean
      metaKey: boolean
      altKey: boolean
    })
  | (VersionedMessage & CorrelatedMessage & {
      type: 'composition'
      eventType: 'onCompositionStart' | 'onCompositionUpdate' | 'onCompositionEnd'
      data: string
    })
  | (VersionedMessage & CorrelatedMessage & {
      type: 'resize'
      width: number
      height: number
      /** Optional transport capability negotiation (v1+). */
      capabilities?: { binaryFraming?: boolean }
    })
  /**
   * Attach local file(s) to a file input. Implemented by `@geometra/proxy` (Playwright);
   * the native Textura server responds with `error` — not applicable to DOM-free apps.
   *
   * `paths` are absolute paths on the machine that runs the browser (the proxy process).
   * With `x`/`y`, the proxy clicks first to trigger a native file chooser; with `fieldLabel`,
   * it prefers a matching labeled file input; otherwise it attaches to the first `input[type=file]`
   * in any frame.
   */
  | (VersionedMessage & CorrelatedMessage & {
      type: 'file'
      paths: string[]
      x?: number
      y?: number
      fieldLabel?: string
      exact?: boolean
      strategy?: 'auto' | 'chooser' | 'hidden' | 'drop'
      dropX?: number
      dropY?: number
    })
  /**
   * Set a labeled text-like field (`<input>`, `<textarea>`, contenteditable, ARIA textbox).
   * Implemented by `@geometra/proxy`.
   */
  | (VersionedMessage & CorrelatedMessage & {
      type: 'setFieldText'
      fieldLabel: string
      value: string
      exact?: boolean
    })
  /**
   * Choose a value for a labeled choice control (native `<select>`, custom combobox/listbox, or radio-style group).
   * Implemented by `@geometra/proxy`.
   */
  | (VersionedMessage & CorrelatedMessage & {
      type: 'setFieldChoice'
      fieldLabel: string
      value: string
      query?: string
      exact?: boolean
    })
  /**
   * Fill several labeled fields in one browser-side batch. Implemented by `@geometra/proxy`.
   * This is the lowest-overhead semantic form-fill path because it avoids one request/ack cycle per field.
   */
  | (VersionedMessage & CorrelatedMessage & {
      type: 'fillFields'
      fields: Array<
        | { kind: 'text'; fieldLabel: string; value: string; exact?: boolean }
        | { kind: 'choice'; fieldLabel: string; value: string; query?: string; exact?: boolean }
        | { kind: 'toggle'; label: string; checked?: boolean; exact?: boolean; controlType?: 'checkbox' | 'radio' }
        | { kind: 'file'; fieldLabel: string; paths: string[]; exact?: boolean }
      >
    })
  /**
   * Choose an option on a native `<select>` after focusing it (click `x`,`y` on the control).
   */
  | (VersionedMessage & CorrelatedMessage & {
      type: 'selectOption'
      x: number
      y: number
      value?: string
      label?: string
      index?: number
    })
  /**
   * Set a checkbox/radio by accessible label. Implemented by `@geometra/proxy`.
   */
  | (VersionedMessage & CorrelatedMessage & {
      type: 'setChecked'
      label: string
      checked?: boolean
      exact?: boolean
      controlType?: 'checkbox' | 'radio'
    })
  /**
   * Custom dropdown / listbox / searchable combobox. Implemented by `@geometra/proxy`.
   * Can optionally open a control by field label and type a search query before picking.
   */
  | (VersionedMessage & CorrelatedMessage & {
      type: 'listboxPick'
      label: string
      exact?: boolean
      openX?: number
      openY?: number
      fieldLabel?: string
      query?: string
    })
  /** Mouse wheel / scroll delta at optional viewport coordinates. */
  | (VersionedMessage & CorrelatedMessage & {
      type: 'wheel'
      deltaX?: number
      deltaY?: number
      x?: number
      y?: number
    })

/** A patch describing a change to a single node's geometry. */
export interface LayoutPatch {
  path: number[]
  x?: number
  y?: number
  width?: number
  height?: number
}

/**
 * True when two layout scalars are unchanged for diffing.
 *
 * Uses `===` for ordinary numbers (so `+0` and `-0` still compare equal like `!==` would).
 * Treats `NaN` as equal to `NaN` so corrupt snapshots that repeat non-finite geometry do not emit
 * perpetual patches (`NaN !== NaN` in JS would otherwise always look "changed").
 */
function sameLayoutScalar(a: number, b: number): boolean {
  if (Number.isNaN(a) && Number.isNaN(b)) return true
  return a === b
}

/** Finite primitive `number` with `>= 0` for layout width/height (matches GEOM v1 client patch validation). */
function isNonNegativePatchDimension(value: unknown): value is number {
  return isFinitePlainNumber(value) && value >= 0
}

/**
 * Stable `Map` key for patch `path` arrays. Plain `JSON.stringify([NaN])` and `JSON.stringify([null])` both
 * yield `"[null]"`, so a replacer tags NaN segments — keep in sync with `packages/proxy/src/diff-layout.ts`.
 */
function layoutPatchPathKey(path: ReadonlyArray<unknown>): string {
  return JSON.stringify(path, (_key, value) => {
    if (typeof value === 'number' && Number.isNaN(value)) {
      return '\uFFFD__GEOM_PATH_NaN__'
    }
    return value
  })
}

/**
 * Coalesce multiple patches on the same path (last write wins per field).
 * Paths are keyed with `JSON.stringify` (via {@link layoutPatchPathKey}) so distinct index sequences never alias
 * (e.g. `[0, 1]` vs `[0.1]` would both stringify to `"0.1"` under a naive `join('.')` key), and NaN segments do not
 * collide with null.
 * Entries with a missing or non-array `path` (including `null` list slots), or paths that `JSON.stringify`
 * rejects (`BigInt` segments, circular arrays, etc.), are skipped so corrupt hand-built batches cannot throw.
 * `x` / `y` apply when the incoming value is a finite primitive `number`. `width` / `height` additionally require
 * `>= 0` (IEEE `−0` counts as non-negative) so negative sizes from corrupt streams cannot overwrite good dimensions
 * or produce coalesced patches the GEOM v1 client rejects. JSON `null`, `NaN`, `±Infinity`, boxed numbers, and other
 * garbage are ignored per field (last valid write still wins).
 */
export function coalescePatches(patches: LayoutPatch[]): LayoutPatch[] {
  const byPath = new Map<string, LayoutPatch>()
  const order: string[] = []
  for (const patch of patches) {
    if (patch == null || !Array.isArray(patch.path)) continue
    let key: string
    try {
      key = layoutPatchPathKey(patch.path)
    } catch {
      continue
    }
    if (!byPath.has(key)) {
      byPath.set(key, { path: [...patch.path] })
      order.push(key)
    }
    const next = byPath.get(key)!
    if (isFinitePlainNumber(patch.x)) next.x = patch.x
    if (isFinitePlainNumber(patch.y)) next.y = patch.y
    if (isNonNegativePatchDimension(patch.width)) next.width = patch.width
    if (isNonNegativePatchDimension(patch.height)) next.height = patch.height
  }
  return order.map(k => byPath.get(k)!)
}

/**
 * Diff two computed layouts and return patches for changed nodes.
 *
 * Only pairs existing children by index: if `prev.children` and `next.children` differ in length,
 * extra slots on either side are ignored (no patches for “added” or “removed” subtrees). The server
 * only uses patches when the UI tree JSON is unchanged (`createServer` sends full `frame` messages
 * whenever the tree changes), so callers should not rely on this function across structural layout
 * mismatches.
 *
 * When `prev` and `next` are the same object reference (including a shared child subtree), returns
 * `[]` immediately without walking — safe for immutable layout snapshots.
 *
 * Non-array `children` on either side (corrupt snapshots / bad deserialization) is treated as `[]` for
 * subtree pairing so patch generation does not throw; root `x`/`y`/`width`/`height` are still compared.
 *
 * `NaN` on a field compares equal to `NaN` on the same field (no patch) so repeated corrupt geometry
 * does not spam patches. When a scalar **changes**, only **wire-safe** target values are emitted:
 * finite primitive `x` / `y`, and non-negative finite `width` / `height` (same rules as GEOM v1 client
 * patch validation in `@geometra/client`). If the new snapshot has corrupt
 * `next` coordinates for a field (e.g. `NaN` or negative size), that field is omitted from the patch
 * so `createServer` never sends patch messages the client would reject — callers keep prior geometry
 * for that field until a valid update arrives (full `frame` messages may still carry corrupt layouts;
 * those are a separate validation path).
 */
export function diffLayout(
  prev: ComputedLayout,
  next: ComputedLayout,
  path: number[] = [],
): LayoutPatch[] {
  if (prev === next) return []

  const patches: LayoutPatch[] = []

  const patch: LayoutPatch = { path }
  let changed = false

  if (!sameLayoutScalar(prev.x, next.x)) {
    if (isFinitePlainNumber(next.x)) {
      patch.x = next.x
      changed = true
    }
  }
  if (!sameLayoutScalar(prev.y, next.y)) {
    if (isFinitePlainNumber(next.y)) {
      patch.y = next.y
      changed = true
    }
  }
  if (!sameLayoutScalar(prev.width, next.width)) {
    if (isNonNegativePatchDimension(next.width)) {
      patch.width = next.width
      changed = true
    }
  }
  if (!sameLayoutScalar(prev.height, next.height)) {
    if (isNonNegativePatchDimension(next.height)) {
      patch.height = next.height
      changed = true
    }
  }

  if (changed) patches.push(patch)

  const prevChildren = Array.isArray(prev.children) ? prev.children : []
  const nextChildren = Array.isArray(next.children) ? next.children : []
  const maxChildren = Math.max(prevChildren.length, nextChildren.length)
  for (let i = 0; i < maxChildren; i++) {
    const prevChild = prevChildren[i]
    const nextChild = nextChildren[i]
    if (prevChild && nextChild) {
      patches.push(...diffLayout(prevChild, nextChild, [...path, i]))
    }
  }

  return patches
}
