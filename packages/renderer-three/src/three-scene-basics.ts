import * as THREE from 'three'
import type { WebGLRendererParameters } from 'three'
import {
  GEOMETRA_HEADLESS_RAW_DEVICE_PIXEL_RATIO,
  isPlainGeometraThreeViewSizingState,
  resizeGeometraThreePerspectiveView,
  resolveHostDevicePixelRatio,
  toPlainGeometraThreeViewSizingState,
  toPlainGeometraThreeViewSizingStateHeadless,
  type PlainGeometraThreeViewSizingState,
} from './utils.js'

const geometraDisposedWebGLRenderers = new WeakSet<object>()

/** Scene, camera, and clock bundle returned by {@link createGeometraThreeSceneBasics}. */
export interface GeometraThreeSceneBasics {
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  clock: THREE.Clock
}

/** Options shared by split/stacked hosts and {@link createGeometraThreeSceneBasics}. */
export interface GeometraThreeSceneBasicsOptions {
  /** Clear color for the Three.js scene. Default: `0x000000`. */
  threeBackground?: THREE.ColorRepresentation
  /** Perspective camera FOV in degrees. Default: 50. */
  cameraFov?: number
  /** Near plane. Default: 0.1. */
  cameraNear?: number
  /** Far plane. Default: 2000. */
  cameraFar?: number
  /** Initial camera position. Default: `(0, 0, 5)`. */
  cameraPosition?: THREE.Vector3Tuple
}

/**
 * Scene and camera defaults shared by {@link createThreeGeometraSplitHost},
 * {@link createThreeGeometraStackedHost}, and {@link createGeometraThreeSceneBasics}.
 * Use in headless or custom renderer setups so numbers stay aligned with those hosts
 * without copying literals from the README.
 */
export const GEOMETRA_THREE_HOST_SCENE_DEFAULTS: Required<GeometraThreeSceneBasicsOptions> = {
  threeBackground: 0x000000,
  cameraFov: 50,
  cameraNear: 0.1,
  cameraFar: 2000,
  cameraPosition: [0, 0, 5],
}

function coerceGeometraThreeSceneBasicsCamera(
  merged: Required<GeometraThreeSceneBasicsOptions>,
): Required<Pick<GeometraThreeSceneBasicsOptions, 'cameraFov' | 'cameraNear' | 'cameraFar' | 'cameraPosition'>> {
  const d = GEOMETRA_THREE_HOST_SCENE_DEFAULTS

  const cameraFov =
    Number.isFinite(merged.cameraFov) && merged.cameraFov > 0 && merged.cameraFov < 180
      ? merged.cameraFov
      : d.cameraFov

  const cameraNear =
    Number.isFinite(merged.cameraNear) && merged.cameraNear > 0 ? merged.cameraNear : d.cameraNear

  let cameraFar = merged.cameraFar
  if (!Number.isFinite(cameraFar) || cameraFar <= cameraNear) {
    cameraFar = d.cameraFar > cameraNear ? d.cameraFar : cameraNear * 2
  }

  const [px, py, pz] = merged.cameraPosition
  const [dx, dy, dz] = d.cameraPosition
  const cameraPosition: THREE.Vector3Tuple = [
    Number.isFinite(px) ? px : dx!,
    Number.isFinite(py) ? py : dy!,
    Number.isFinite(pz) ? pz : dz!,
  ]

  return { cameraFov, cameraNear, cameraFar, cameraPosition }
}

/**
 * Fully merged and coerced {@link GeometraThreeSceneBasicsOptions} using the same rules as
 * {@link createGeometraThreeSceneBasics} (and split/stacked hosts).
 *
 * Use when you need host-aligned numbers for logging, tests, or agent-side protocol payloads without
 * constructing a {@link THREE.Scene} or {@link THREE.PerspectiveCamera}.
 */
export function resolveGeometraThreeSceneBasicsOptions(
  options: GeometraThreeSceneBasicsOptions = {},
): Required<GeometraThreeSceneBasicsOptions> {
  const merged = { ...GEOMETRA_THREE_HOST_SCENE_DEFAULTS, ...options }
  const { cameraFov, cameraNear, cameraFar, cameraPosition } = coerceGeometraThreeSceneBasicsCamera(merged)
  return {
    threeBackground: merged.threeBackground,
    cameraFov,
    cameraNear,
    cameraFar,
    cameraPosition,
  }
}

/**
 * Host-aligned scene/camera numbers in a JSON-friendly shape: clear color as a single **sRGB hex**
 * integer (`0xRRGGBB`), same as {@link THREE.Color#getHex}.
 *
 * Use for logs, tests, or agent-side payloads where {@link GeometraThreeSceneBasicsOptions.threeBackground}
 * may be a string or other {@link THREE.ColorRepresentation} but you need a stable numeric field for
 * `JSON.stringify`.
 */
export interface PlainGeometraThreeSceneBasicsOptions {
  threeBackgroundHex: number
  cameraFov: number
  cameraNear: number
  cameraFar: number
  cameraPosition: THREE.Vector3Tuple
}

/**
 * Same coercion as {@link resolveGeometraThreeSceneBasicsOptions}, plus a hex background for stable JSON.
 */
export function toPlainGeometraThreeSceneBasicsOptions(
  options: GeometraThreeSceneBasicsOptions = {},
): PlainGeometraThreeSceneBasicsOptions {
  const resolved = resolveGeometraThreeSceneBasicsOptions(options)
  const threeBackgroundHex = new THREE.Color(resolved.threeBackground).getHex()
  return {
    threeBackgroundHex,
    cameraFov: resolved.cameraFov,
    cameraNear: resolved.cameraNear,
    cameraFar: resolved.cameraFar,
    cameraPosition: [...resolved.cameraPosition] as THREE.Vector3Tuple,
  }
}

/**
 * Build {@link GeometraThreeSceneBasics} from {@link PlainGeometraThreeSceneBasicsOptions} (for example
 * `JSON.parse` of logs, tests, or agent payloads). Maps `threeBackgroundHex` to {@link GeometraThreeSceneBasicsOptions.threeBackground}
 * and forwards camera fields through {@link createGeometraThreeSceneBasics}, so invalid numbers get the same
 * coercion as split/stacked hosts and {@link toPlainGeometraThreeSceneBasicsOptions} output round-trips when
 * re-applied here.
 */
export function createGeometraThreeSceneBasicsFromPlain(
  plain: PlainGeometraThreeSceneBasicsOptions,
): GeometraThreeSceneBasics {
  return createGeometraThreeSceneBasics({
    threeBackground: plain.threeBackgroundHex,
    cameraFov: plain.cameraFov,
    cameraNear: plain.cameraNear,
    cameraFar: plain.cameraFar,
    cameraPosition: [...plain.cameraPosition] as THREE.Vector3Tuple,
  })
}

/**
 * Single JSON-friendly object combining {@link PlainGeometraThreeViewSizingState} and
 * {@link PlainGeometraThreeSceneBasicsOptions} with the same coercion rules as
 * {@link toPlainGeometraThreeViewSizingState} and {@link toPlainGeometraThreeSceneBasicsOptions}.
 *
 * Use for logs, tests, or agent-side payloads when you want viewport + scene numbers in one
 * `JSON.stringify` without calling both helpers separately.
 */
export type PlainGeometraThreeHostSnapshot = PlainGeometraThreeViewSizingState &
  PlainGeometraThreeSceneBasicsOptions

function isPlainCameraPosition(value: unknown): value is THREE.Vector3Tuple {
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    value.every((n) => typeof n === 'number' && Number.isFinite(n))
  )
}

function isPlainGeometraThreeSceneBasicsOptionsRecord(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false
  const o = value as Record<string, unknown>
  if (typeof o.threeBackgroundHex !== 'number' || !Number.isFinite(o.threeBackgroundHex)) {
    return false
  }
  const fov = o.cameraFov
  if (typeof fov !== 'number' || !Number.isFinite(fov) || fov <= 0 || fov >= 180) {
    return false
  }
  const near = o.cameraNear
  const far = o.cameraFar
  if (typeof near !== 'number' || !Number.isFinite(near) || near <= 0) return false
  if (typeof far !== 'number' || !Number.isFinite(far) || far <= near) return false
  return isPlainCameraPosition(o.cameraPosition)
}

/**
 * Narrow `unknown` (e.g. `JSON.parse`) to {@link PlainGeometraThreeSceneBasicsOptions} — the scene/camera
 * fields from {@link toPlainGeometraThreeSceneBasicsOptions} without viewport sizing. Extra keys are allowed.
 * Pair with {@link isPlainGeometraThreeViewSizingState} when you need both slices before merging or calling
 * {@link createGeometraThreeSceneBasicsFromPlain}.
 */
export function isPlainGeometraThreeSceneBasicsOptions(
  value: unknown,
): value is PlainGeometraThreeSceneBasicsOptions {
  return isPlainGeometraThreeSceneBasicsOptionsRecord(value)
}

/**
 * Narrow `unknown` (e.g. `JSON.parse`) to {@link PlainGeometraThreeHostSnapshot} when the object matches
 * the shape from {@link toPlainGeometraThreeHostSnapshot} / {@link toPlainGeometraThreeHostSnapshotHeadless} /
 * {@link toPlainGeometraThreeHostSnapshotFromViewSizing}. Extra keys (e.g. hybrid layout fields) are allowed.
 * Composite payloads use {@link isPlainGeometraThreeSplitHostSnapshot} / {@link isPlainGeometraThreeStackedHostSnapshot}.
 */
export function isPlainGeometraThreeHostSnapshot(value: unknown): value is PlainGeometraThreeHostSnapshot {
  if (!isPlainGeometraThreeViewSizingState(value)) return false
  return isPlainGeometraThreeSceneBasicsOptionsRecord(value)
}

/**
 * Merge host-aligned viewport sizing and scene/camera plain fields for stable JSON.
 *
 * @see PlainGeometraThreeHostSnapshot
 */
export function toPlainGeometraThreeHostSnapshot(
  cssWidth: number,
  cssHeight: number,
  rawDevicePixelRatio: number,
  maxDevicePixelRatio?: number,
  sceneBasicsOptions: GeometraThreeSceneBasicsOptions = {},
): PlainGeometraThreeHostSnapshot {
  return {
    ...toPlainGeometraThreeViewSizingState(cssWidth, cssHeight, rawDevicePixelRatio, maxDevicePixelRatio),
    ...toPlainGeometraThreeSceneBasicsOptions(sceneBasicsOptions),
  }
}

/**
 * Same plain snapshot as {@link toPlainGeometraThreeHostSnapshot} with raw device pixel ratio **1** —
 * the baseline after `win.devicePixelRatio || 1` when the ratio is missing, and the same raw input as
 * {@link resolveHeadlessHostDevicePixelRatio} when you only apply an optional cap.
 *
 * Viewport fields match {@link toPlainGeometraThreeViewSizingStateHeadless}; for sizing-only JSON, call
 * that helper directly.
 *
 * For headless GL, Node, tests, or agent payloads without a browser `window`, call this instead of
 * passing a literal `1` as `rawDevicePixelRatio` everywhere.
 */
export function toPlainGeometraThreeHostSnapshotHeadless(
  cssWidth: number,
  cssHeight: number,
  maxDevicePixelRatio?: number,
  sceneBasicsOptions: GeometraThreeSceneBasicsOptions = {},
): PlainGeometraThreeHostSnapshot {
  return {
    ...toPlainGeometraThreeViewSizingStateHeadless(cssWidth, cssHeight, maxDevicePixelRatio),
    ...toPlainGeometraThreeSceneBasicsOptions(sceneBasicsOptions),
  }
}

/**
 * Merge an existing {@link PlainGeometraThreeViewSizingState} (from {@link toPlainGeometraThreeViewSizingState}
 * or your own pipeline) with {@link toPlainGeometraThreeSceneBasicsOptions} into one
 * {@link PlainGeometraThreeHostSnapshot}.
 *
 * Use in headless loops, tests, or agent payloads when layout/DPR sizing is computed once and scene/camera
 * options are added later, without re-running {@link toPlainGeometraThreeViewSizingState}.
 */
export function toPlainGeometraThreeHostSnapshotFromViewSizing(
  sizing: PlainGeometraThreeViewSizingState,
  sceneBasicsOptions: GeometraThreeSceneBasicsOptions = {},
): PlainGeometraThreeHostSnapshot {
  return {
    ...sizing,
    ...toPlainGeometraThreeSceneBasicsOptions(sceneBasicsOptions),
  }
}

/**
 * Combine an existing {@link PlainGeometraThreeViewSizingState} with an already-plain scene slice
 * {@link PlainGeometraThreeSceneBasicsOptions} (for example after {@link isPlainGeometraThreeViewSizingState}
 * and {@link isPlainGeometraThreeSceneBasicsOptions}) into one {@link PlainGeometraThreeHostSnapshot}.
 *
 * Same object shape as {@link toPlainGeometraThreeHostSnapshotFromViewSizing} when `scene` is the output of
 * {@link toPlainGeometraThreeSceneBasicsOptions}, but skips a redundant {@link THREE.Color} round-trip when
 * the scene fields are already JSON-stable.
 */
export function mergePlainGeometraThreeHostSnapshot(
  sizing: PlainGeometraThreeViewSizingState,
  scene: PlainGeometraThreeSceneBasicsOptions,
): PlainGeometraThreeHostSnapshot {
  return { ...sizing, ...scene }
}

/**
 * `WebGLRenderer` constructor options (excluding `canvas`) used by
 * {@link createThreeGeometraSplitHost} and {@link createThreeGeometraStackedHost}.
 *
 * Typed as {@link WebGLRendererParameters} minus `canvas` so custom renderers stay compatible with
 * Three’s constructor surface when you extend or mirror these flags.
 *
 * Spread into your own `new WebGLRenderer({ canvas, ...GEOMETRA_HOST_WEBGL_RENDERER_OPTIONS })` when
 * you manage the renderer (headless GL, offscreen canvas, tests) so flags stay aligned with those hosts.
 */
export const GEOMETRA_HOST_WEBGL_RENDERER_OPTIONS = {
  antialias: true,
  alpha: false,
} as const satisfies Omit<WebGLRendererParameters, 'canvas'>

/**
 * Full {@link WebGLRendererParameters} for `new WebGLRenderer(...)`, with the same flags as
 * {@link createThreeGeometraSplitHost} and {@link createThreeGeometraStackedHost} plus your `canvas`.
 *
 * Use in headless GL, offscreen canvas, or custom hosts so constructor input stays aligned with
 * those packages without copying {@link GEOMETRA_HOST_WEBGL_RENDERER_OPTIONS} at every call site.
 */
export function createGeometraHostWebGLRendererParams(
  canvas: NonNullable<WebGLRendererParameters['canvas']>,
): WebGLRendererParameters {
  return { canvas, ...GEOMETRA_HOST_WEBGL_RENDERER_OPTIONS }
}

/**
 * `new WebGLRenderer(createGeometraHostWebGLRendererParams(canvas))` with the same flags as
 * {@link createThreeGeometraSplitHost} and {@link createThreeGeometraStackedHost}.
 *
 * Use in the browser or any environment where Three can create a GL context (offscreen canvas,
 * custom hosts). Prefer {@link createGeometraHostWebGLRendererParams} when you need to spread
 * into a larger parameter object.
 */
export function createGeometraThreeWebGLRenderer(
  canvas: NonNullable<WebGLRendererParameters['canvas']>,
): THREE.WebGLRenderer {
  return new THREE.WebGLRenderer(createGeometraHostWebGLRendererParams(canvas))
}

/**
 * Create a scene, perspective camera, and clock with the same defaults as
 * {@link createThreeGeometraSplitHost} and {@link createThreeGeometraStackedHost}.
 *
 * Use this when you want Three.js state aligned with those hosts but manage your own
 * `WebGLRenderer` (for example headless GL, offscreen canvas, or custom render targets).
 *
 * Non-finite or invalid perspective settings fall back to {@link GEOMETRA_THREE_HOST_SCENE_DEFAULTS}
 * (or `far = max(default far, near × 2)` when the default far is not past a coerced near plane).
 *
 * @returns A {@link GeometraThreeSceneBasics} value aligned with split/stacked host defaults.
 */
export function createGeometraThreeSceneBasics(
  options: GeometraThreeSceneBasicsOptions = {},
): GeometraThreeSceneBasics {
  const resolved = resolveGeometraThreeSceneBasicsOptions(options)
  const { threeBackground, cameraFov, cameraNear, cameraFar, cameraPosition } = resolved

  const scene = new THREE.Scene()
  scene.background = new THREE.Color(threeBackground)

  const camera = new THREE.PerspectiveCamera(cameraFov, 1, cameraNear, cameraFar)
  camera.position.set(cameraPosition[0]!, cameraPosition[1]!, cameraPosition[2]!)

  const clock = new THREE.Clock()

  return { scene, camera, clock }
}

/** {@link createGeometraThreeSceneBasics} plus a host-aligned {@link THREE.WebGLRenderer} on the same canvas. */
export type GeometraThreeWebGLWithSceneBasics = GeometraThreeSceneBasics & {
  renderer: THREE.WebGLRenderer
}

/**
 * Create a {@link THREE.WebGLRenderer} and {@link GeometraThreeSceneBasics} in one call, using the same
 * constructor flags and scene defaults as {@link createThreeGeometraSplitHost} and
 * {@link createThreeGeometraStackedHost}.
 *
 * Equivalent to {@link createGeometraThreeWebGLRenderer} on `canvas` plus
 * {@link createGeometraThreeSceneBasics} with the same `options` — useful for offscreen canvas, custom hosts, or
 * agent-side bootstrap where you want parity without duplicating the two factories.
 *
 * Requires a WebGL-capable environment (same as `new WebGLRenderer(...)`).
 */
export function createGeometraThreeWebGLWithSceneBasics(
  canvas: NonNullable<WebGLRendererParameters['canvas']>,
  options: GeometraThreeSceneBasicsOptions = {},
): GeometraThreeWebGLWithSceneBasics {
  const renderer = createGeometraThreeWebGLRenderer(canvas)
  const { scene, camera, clock } = createGeometraThreeSceneBasics(options)
  return { renderer, scene, camera, clock }
}

/**
 * Same host-aligned renderer + scene bundle as {@link createGeometraThreeWebGLWithSceneBasics}, but scene and
 * camera are built from {@link PlainGeometraThreeSceneBasicsOptions} (for example `JSON.parse` of logs, tests,
 * or agent payloads) via {@link createGeometraThreeSceneBasicsFromPlain}, so invalid fields get the same coercion
 * as split/stacked hosts without manually mapping `threeBackgroundHex` into {@link GeometraThreeSceneBasicsOptions}.
 *
 * Requires a WebGL-capable environment (same as `new WebGLRenderer(...)`).
 */
export function createGeometraThreeWebGLWithSceneBasicsFromPlain(
  canvas: NonNullable<WebGLRendererParameters['canvas']>,
  plain: PlainGeometraThreeSceneBasicsOptions,
): GeometraThreeWebGLWithSceneBasics {
  const renderer = createGeometraThreeWebGLRenderer(canvas)
  const { scene, camera, clock } = createGeometraThreeSceneBasicsFromPlain(plain)
  return { renderer, scene, camera, clock }
}

/**
 * Tear down the {@link THREE.WebGLRenderer} from {@link createGeometraThreeWebGLWithSceneBasics}
 * (or any bundle that shares the same `renderer` reference).
 *
 * When `clock` is passed (for example the same bundle from {@link createGeometraThreeWebGLWithSceneBasics}),
 * calls {@link THREE.Clock.stop} before {@link THREE.WebGLRenderer.dispose} so `getDelta` / `elapsedTime`
 * do not keep advancing after teardown in headless ticks or agent loops.
 *
 * Calls {@link THREE.WebGLRenderer.dispose}; it does not traverse the scene or dispose meshes,
 * materials, or textures — keep that cleanup in app code or a future helper if you need it.
 *
 * Registers the renderer so {@link tickGeometraThreeWebGLWithSceneBasicsFrame} skips a subsequent
 * `render` when teardown runs inside `onFrame`, matching split/stacked hosts after {@link ThreeRuntimeContext.destroy}.
 */
export function disposeGeometraThreeWebGLWithSceneBasics(
  bundle: Pick<GeometraThreeWebGLWithSceneBasics, 'renderer'> &
    Partial<Pick<GeometraThreeWebGLWithSceneBasics, 'clock'>>,
): void {
  bundle.clock?.stop()
  geometraDisposedWebGLRenderers.add(bundle.renderer)
  bundle.renderer.dispose()
}

/**
 * Resize renderer and camera from {@link createGeometraThreeWebGLWithSceneBasics} using the same CSS layout,
 * {@link resolveHostDevicePixelRatio} capping, and {@link resizeGeometraThreePerspectiveView} path as
 * {@link createThreeGeometraSplitHost} and {@link createThreeGeometraStackedHost}.
 *
 * Use in headless GL, offscreen canvas, or custom hosts when you already hold the bundle and a layout size
 * (e.g. from your own layout pass). Pass `rawDevicePixelRatio` from `window.devicePixelRatio` in the browser
 * or `1` when there is no window.
 *
 * Equivalent to calling {@link resizeGeometraThreePerspectiveView} on `bundle.renderer` and `bundle.camera` with
 * `resolveHostDevicePixelRatio(rawDevicePixelRatio, maxDevicePixelRatio)`.
 */
export function resizeGeometraThreeWebGLWithSceneBasicsView(
  bundle: Pick<GeometraThreeWebGLWithSceneBasics, 'renderer' | 'camera'>,
  cssWidth: number,
  cssHeight: number,
  rawDevicePixelRatio: number,
  maxDevicePixelRatio?: number,
): void {
  resizeGeometraThreePerspectiveView(
    bundle.renderer,
    bundle.camera,
    cssWidth,
    cssHeight,
    resolveHostDevicePixelRatio(rawDevicePixelRatio, maxDevicePixelRatio),
  )
}

/**
 * Same as {@link resizeGeometraThreeWebGLWithSceneBasicsView} with raw device pixel ratio fixed at **1** —
 * parity with {@link resolveHeadlessHostDevicePixelRatio} and {@link toPlainGeometraThreeHostSnapshotHeadless}
 * for headless GL, Node, tests, or agent loops without a browser `window`.
 */
export function resizeGeometraThreeWebGLWithSceneBasicsViewHeadless(
  bundle: Pick<GeometraThreeWebGLWithSceneBasics, 'renderer' | 'camera'>,
  cssWidth: number,
  cssHeight: number,
  maxDevicePixelRatio?: number,
): void {
  resizeGeometraThreeWebGLWithSceneBasicsView(
    bundle,
    cssWidth,
    cssHeight,
    GEOMETRA_HEADLESS_RAW_DEVICE_PIXEL_RATIO,
    maxDevicePixelRatio,
  )
}

/**
 * Resize from {@link PlainGeometraThreeViewSizingState} using `layoutWidth`, `layoutHeight`, and
 * `effectiveDevicePixelRatio` — equivalent to
 * {@link resizeGeometraThreeWebGLWithSceneBasicsView} with those dimensions and the same effective ratio
 * the plain helpers compute from raw DPR and optional cap.
 *
 * Accepts any object with those fields, including a full {@link PlainGeometraThreeHostSnapshot} or composite
 * split/stacked snapshot (extra keys ignored). Use when logs, tests, or agents already validated viewport JSON
 * via {@link isPlainGeometraThreeHostSnapshot} and should not re-derive {@link resolveHostDevicePixelRatio}
 * from partial inputs.
 */
export function resizeGeometraThreeWebGLWithSceneBasicsViewFromPlainViewSizing(
  bundle: Pick<GeometraThreeWebGLWithSceneBasics, 'renderer' | 'camera'>,
  sizing: PlainGeometraThreeViewSizingState,
): void {
  resizeGeometraThreePerspectiveView(
    bundle.renderer,
    bundle.camera,
    sizing.layoutWidth,
    sizing.layoutHeight,
    sizing.effectiveDevicePixelRatio,
  )
}

/**
 * One `renderer.render(scene, camera)` pass for a {@link GeometraThreeWebGLWithSceneBasics} bundle.
 *
 * Use in headless GL, tests, or agent-style loops after
 * {@link resizeGeometraThreeWebGLWithSceneBasicsView} (or your own sizing) so a single frame matches
 * the same scene/camera/renderer wiring as {@link createThreeGeometraSplitHost} /
 * {@link createThreeGeometraStackedHost} without duplicating the render call.
 *
 * No-ops when the same `renderer` was already passed to {@link disposeGeometraThreeWebGLWithSceneBasics}
 * — same skip-after-dispose registration as {@link tickGeometraThreeWebGLWithSceneBasicsFrame}.
 */
export function renderGeometraThreeWebGLWithSceneBasicsFrame(
  bundle: Pick<GeometraThreeWebGLWithSceneBasics, 'renderer' | 'scene' | 'camera'>,
): void {
  if (geometraDisposedWebGLRenderers.has(bundle.renderer)) {
    return
  }
  bundle.renderer.render(bundle.scene, bundle.camera)
}

/**
 * Context passed to `onFrame` in {@link tickGeometraThreeWebGLWithSceneBasicsFrame}: the bundle’s renderer,
 * scene, camera, and clock plus `delta` / `elapsed` from the same {@link THREE.Clock} read the hosts use
 * before `onThreeFrame`.
 */
export interface GeometraThreeWebGLWithSceneBasicsTickContext {
  renderer: THREE.WebGLRenderer
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  clock: THREE.Clock
  delta: number
  elapsed: number
}

/**
 * Same per-frame ordering as {@link createThreeGeometraSplitHost} and {@link createThreeGeometraStackedHost}:
 * `clock.getDelta()` / `elapsedTime`, optional callback, then `renderer.render`.
 *
 * If `onFrame` returns **`false`**, `renderer.render` is skipped and this function returns **`false`** —
 * parity with {@link ThreeGeometraSplitHostOptions.onThreeFrame} / stacked host `onThreeFrame` returning `false`.
 * If `onFrame` calls {@link disposeGeometraThreeWebGLWithSceneBasics} on the same bundle (same idea as
 * {@link ThreeRuntimeContext.destroy} in browser hosts), `render` is skipped and this returns **`false`** even when
 * the callback does not return `false`. `undefined` and other return values still render when the renderer was not
 * disposed through that helper, and the function returns **`true`** when `render` runs.
 *
 * If `onFrame` **throws**, the error propagates and `renderer.render` is not called — same ordering as browser
 * hosts, which run the frame callback before `render`.
 *
 * Use in headless GL, tests, or agent loops when you want {@link THREE.Clock} timing parity with those hosts
 * without duplicating the loop body. Omit the callback to match a tick that only advances the clock and renders.
 *
 * @returns `true` if `renderer.render` ran, `false` if `onFrame` returned `false` (draw skipped).
 */
export function tickGeometraThreeWebGLWithSceneBasicsFrame(
  bundle: GeometraThreeWebGLWithSceneBasics,
  onFrame?: (ctx: GeometraThreeWebGLWithSceneBasicsTickContext) => void | boolean,
): boolean {
  const { renderer, scene, camera, clock } = bundle
  const delta = clock.getDelta()
  const elapsed = clock.elapsedTime
  if (onFrame?.({ renderer, scene, camera, clock, delta, elapsed }) === false) {
    return false
  }
  if (geometraDisposedWebGLRenderers.has(renderer)) {
    return false
  }
  renderer.render(scene, camera)
  return true
}

/**
 * One-step frame: {@link resizeGeometraThreeWebGLWithSceneBasicsView}, then
 * {@link tickGeometraThreeWebGLWithSceneBasicsFrame} — same as calling those two in sequence (resize
 * before `clock.getDelta()` / `onFrame` / `render`).
 *
 * Use when you have an explicit raw device pixel ratio (for example `window.devicePixelRatio || 1` from a
 * provided `window`, or a simulated value in tests and agent loops) and want the same resize + frame
 * ordering as {@link createThreeGeometraSplitHost} / {@link createThreeGeometraStackedHost} without inlining
 * both calls.
 *
 * For raw DPR **1** without repeating that literal, prefer {@link resizeTickGeometraThreeWebGLWithSceneBasicsHeadless}.
 *
 * @returns Same boolean as {@link tickGeometraThreeWebGLWithSceneBasicsFrame}.
 */
export function resizeTickGeometraThreeWebGLWithSceneBasics(
  bundle: GeometraThreeWebGLWithSceneBasics,
  cssWidth: number,
  cssHeight: number,
  rawDevicePixelRatio: number,
  maxDevicePixelRatio?: number,
  onFrame?: (ctx: GeometraThreeWebGLWithSceneBasicsTickContext) => void | boolean,
): boolean {
  resizeGeometraThreeWebGLWithSceneBasicsView(
    bundle,
    cssWidth,
    cssHeight,
    rawDevicePixelRatio,
    maxDevicePixelRatio,
  )
  return tickGeometraThreeWebGLWithSceneBasicsFrame(bundle, onFrame)
}

/**
 * Headless one-step frame: {@link resizeGeometraThreeWebGLWithSceneBasicsViewHeadless}, then
 * {@link tickGeometraThreeWebGLWithSceneBasicsFrame} — same as calling those two in sequence (resize
 * before `clock.getDelta()` / `onFrame` / `render`).
 *
 * Equivalent to {@link resizeTickGeometraThreeWebGLWithSceneBasics} with `rawDevicePixelRatio` **1** and
 * the same optional `maxDevicePixelRatio` / `onFrame` arguments.
 *
 * For Node, headless WebGL, tests, or agent loops that need buffer + camera sync on every tick with raw
 * DPR **1** and the same optional cap as the browser hosts, without repeating the pair at every call site.
 *
 * @returns Same boolean as {@link tickGeometraThreeWebGLWithSceneBasicsFrame}.
 */
export function resizeTickGeometraThreeWebGLWithSceneBasicsHeadless(
  bundle: GeometraThreeWebGLWithSceneBasics,
  cssWidth: number,
  cssHeight: number,
  maxDevicePixelRatio?: number,
  onFrame?: (ctx: GeometraThreeWebGLWithSceneBasicsTickContext) => void | boolean,
): boolean {
  return resizeTickGeometraThreeWebGLWithSceneBasics(
    bundle,
    cssWidth,
    cssHeight,
    GEOMETRA_HEADLESS_RAW_DEVICE_PIXEL_RATIO,
    maxDevicePixelRatio,
    onFrame,
  )
}

/**
 * Resize from {@link PlainGeometraThreeViewSizingState}, then {@link tickGeometraThreeWebGLWithSceneBasicsFrame} —
 * same as calling those two in sequence (resize before `clock.getDelta()` / `onFrame` / `render`).
 *
 * Use in headless GL, tests, or agent loops when viewport JSON is already validated (for example with
 * {@link isPlainGeometraThreeHostSnapshot}) and you want the same one-step flow as
 * {@link resizeTickGeometraThreeWebGLWithSceneBasics} without re-supplying raw DPR and `maxDevicePixelRatio` on
 * every tick.
 *
 * @returns Same boolean as {@link tickGeometraThreeWebGLWithSceneBasicsFrame}.
 */
export function resizeTickGeometraThreeWebGLWithSceneBasicsFromPlainViewSizing(
  bundle: GeometraThreeWebGLWithSceneBasics,
  sizing: PlainGeometraThreeViewSizingState,
  onFrame?: (ctx: GeometraThreeWebGLWithSceneBasicsTickContext) => void | boolean,
): boolean {
  resizeGeometraThreeWebGLWithSceneBasicsViewFromPlainViewSizing(bundle, sizing)
  return tickGeometraThreeWebGLWithSceneBasicsFrame(bundle, onFrame)
}

/**
 * Same as {@link resizeTickGeometraThreeWebGLWithSceneBasicsFromPlainViewSizing} but takes a full
 * {@link PlainGeometraThreeHostSnapshot} (viewport + scene plain fields) — for example from
 * {@link toPlainGeometraThreeHostSnapshot}, {@link toPlainGeometraThreeHostSnapshotHeadless},
 * {@link toPlainGeometraThreeHostSnapshotFromViewSizing}, or composite split/stacked snapshots that
 * include those keys. Only the {@link PlainGeometraThreeViewSizingState} slice is read for resize;
 * extra fields (scene/camera hex, hybrid layout) are ignored here but often live on the same object
 * you already validated with {@link isPlainGeometraThreeHostSnapshot}.
 *
 * @returns Same boolean as {@link tickGeometraThreeWebGLWithSceneBasicsFrame}.
 */
export function resizeTickGeometraThreeWebGLWithSceneBasicsFromPlainHostSnapshot(
  bundle: GeometraThreeWebGLWithSceneBasics,
  snapshot: PlainGeometraThreeHostSnapshot,
  onFrame?: (ctx: GeometraThreeWebGLWithSceneBasicsTickContext) => void | boolean,
): boolean {
  return resizeTickGeometraThreeWebGLWithSceneBasicsFromPlainViewSizing(bundle, snapshot, onFrame)
}
