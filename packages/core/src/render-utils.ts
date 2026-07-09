/**
 * Shared paint-backend helpers used by multiple `@geometra/renderer-*` packages so the same color
 * parsing and border-radius clamping math does not drift between targets. `parseColorRGBA` accepts
 * CSS `#rgb`/`#rrggbb` hex and `rgb()`/`rgba()` functional notation and returns channels in the
 * normalized `[0, 1]` range expected by WebGPU shaders — canvas callers can scale back to 0–255 with
 * `Math.round(c * 255)` at their single contrast callsite. `normalizeBorderRadius` produces the
 * `[tl, tr, br, bl]` tuple clamped to half the smaller box dimension that both Canvas2D's `Path2D`
 * round-rect and WebGPU's SDF box path consume. Keeping these in core means fixes to the parser
 * (e.g. additional color syntax support) land once for every target.
 */

/** Border-radius shape accepted by box elements — either a uniform number or per-corner overrides. */
export type BorderRadiusInput =
  | number
  | {
      topLeft?: number
      topRight?: number
      bottomLeft?: number
      bottomRight?: number
    }
  | undefined

/**
 * Parse a CSS color string into normalized `[r, g, b, a]` channels in the `[0, 1]` range.
 *
 * Accepts `#rgb`, `#rrggbb`, `rgb(r, g, b)`, and `rgba(r, g, b, a)` notations. Malformed input
 * falls back to opaque black `[0, 0, 0, 1]` so downstream shaders and Canvas2D fills never observe
 * `NaN` channels. This matches the pre-existing behavior of the WebGPU renderer's local parser.
 *
 * @param color — CSS color string from element props (e.g. `backgroundColor`, gradient stop).
 * @returns Four finite numbers in `[0, 1]`: red, green, blue, alpha. Alpha defaults to `1` when the
 *   input omits it (`rgb(…)` or hex).
 */
export function parseColorRGBA(color: string): [number, number, number, number] {
  if (color.startsWith('#')) {
    const hex = color.slice(1)
    const full = hex.length === 3
      ? hex[0]! + hex[0]! + hex[1]! + hex[1]! + hex[2]! + hex[2]!
      : hex
    const r = parseInt(full.slice(0, 2), 16) / 255
    const g = parseInt(full.slice(2, 4), 16) / 255
    const b = parseInt(full.slice(4, 6), 16) / 255
    return [r, g, b, 1]
  }
  const m = color.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([0-9.]+))?\s*\)/)
  if (m) {
    return [
      Number(m[1]) / 255,
      Number(m[2]) / 255,
      Number(m[3]) / 255,
      m[4] === undefined ? 1 : Number(m[4]),
    ]
  }
  return [0, 0, 0, 1]
}

/**
 * Clamp a {@link BorderRadiusInput} into the `[tl, tr, br, bl]` tuple consumed by paint backends.
 *
 * Per-corner radii are clamped to `min(w / 2, h / 2)` so a single corner can never exceed half the
 * smaller box dimension (matching CSS border-radius behavior for overlapping corners). Negative
 * inputs are clamped to `0`. An `undefined` input or an object with no corner fields yields
 * `[0, 0, 0, 0]`, letting callers skip the round-rect path when every corner is zero.
 *
 * @param r — Either a uniform radius number, a per-corner record, or `undefined`.
 * @param w — Box width in paint pixels.
 * @param h — Box height in paint pixels.
 * @returns Tuple `[topLeft, topRight, bottomRight, bottomLeft]` in paint pixels.
 */
export function normalizeBorderRadius(
  r: BorderRadiusInput,
  w: number,
  h: number,
): [number, number, number, number] {
  const maxR = Math.min(w / 2, h / 2)
  if (typeof r === 'number') {
    const v = Math.min(Math.max(0, r), maxR)
    return [v, v, v, v]
  }
  if (r && typeof r === 'object') {
    return [
      Math.min(Math.max(0, r.topLeft ?? 0), maxR),
      Math.min(Math.max(0, r.topRight ?? 0), maxR),
      Math.min(Math.max(0, r.bottomRight ?? 0), maxR),
      Math.min(Math.max(0, r.bottomLeft ?? 0), maxR),
    ]
  }
  return [0, 0, 0, 0]
}
