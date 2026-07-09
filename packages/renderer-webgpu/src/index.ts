import type { ComputedLayout } from 'textura'
import {
  collectTextNodes,
  finiteNumberOrZero,
  focusedElement,
  layoutBoundsAreFinite,
  normalizeBorderRadius,
  parseColorRGBA as parseColor,
  type Renderer,
  type SelectionRange,
  type TextNodeInfo,
  type UIElement,
  type BoxElement,
} from '@geometra/core'

export interface WebGPURendererOptions {
  canvas: HTMLCanvasElement
  background?: string
  powerPreference?: GPUPowerPreference
  /** Optional callback to surface unsupported nodes that need fallback rendering. */
  onFallbackNeeded?: (count: number) => void
  /** Stroke every layout rect (flex debugging). Default: false. */
  debugLayoutBounds?: boolean
  /** Draw a ring around the keyboard-focused box. Default: true. */
  showFocusRing?: boolean
  /** Focus ring stroke color. Default: rgba(59, 130, 246, 0.95). */
  focusRingColor?: string
  /** Outset from the focused box in pixels. Default: 2. */
  focusRingPadding?: number
  /** Color for layout debug overlay strokes. Default: rgba(34, 197, 94, 0.45). */
  debugStrokeColor?: string
  /** Highlight color for text selection. Default: rgba(59, 130, 246, 0.4). */
  selectionColor?: string
}

/**
 * WebGPU renderer for Geometra.
 *
 * Pipelines:
 * - color: vertex-colored triangles for flat boxes
 * - shape: unified SDF pipeline for rounded boxes, per-corner radius, linear gradients
 *   (2-stop via vertex colors or N-stop via gradient atlas), and box shadow pre-pass
 * - texture: offscreen-canvas atlas sampled as GPU texture (text + images)
 */

function safeCanvasExtent(layout: ComputedLayout): { w: number; h: number } {
  if (!layoutBoundsAreFinite(layout)) {
    return { w: 1, h: 1 }
  }
  return {
    w: Math.max(1, Math.round(layout.width)),
    h: Math.max(1, Math.round(layout.height)),
  }
}

// --- Text atlas ---

interface TextEntry {
  ax: number
  ay: number
  aw: number
  ah: number
  dx: number
  dy: number
  dw: number
  dh: number
}

class TextAtlas {
  private canvas: OffscreenCanvas
  private ctx: OffscreenCanvasRenderingContext2D
  private entries: TextEntry[] = []
  private cursorX = 0
  private cursorY = 0
  private rowHeight = 0
  readonly width: number
  readonly height: number

  constructor(width: number, height: number) {
    this.width = width
    this.height = height
    this.canvas = new OffscreenCanvas(width, height)
    const ctx = this.canvas.getContext('2d', { willReadFrequently: false })
    if (!ctx) throw new Error('Could not create offscreen 2d context for text atlas')
    this.ctx = ctx
  }

  clear(): void {
    this.entries = []
    this.cursorX = 0
    this.cursorY = 0
    this.rowHeight = 0
    this.ctx.clearRect(0, 0, this.width, this.height)
  }

  addText(
    text: string,
    font: string,
    color: string,
    lineHeight: number,
    dx: number,
    dy: number,
    maxWidth: number,
    _maxHeight: number,
    whiteSpace?: string,
  ): void {
    const { ctx } = this
    ctx.font = font
    ctx.textBaseline = 'top'

    const shouldWrap = whiteSpace === 'normal' || whiteSpace === 'pre-wrap'
    const lines = shouldWrap ? wrapText(ctx, text, maxWidth) : [text]

    for (let i = 0; i < lines.length; i++) {
      const lineText = lines[i]!
      if (!lineText) continue
      const metrics = ctx.measureText(lineText)
      const lw = Math.ceil(metrics.width) + 2
      const lh = Math.ceil(lineHeight) + 2

      if (lw <= 0 || lh <= 0) continue

      if (this.cursorX + lw > this.width) {
        this.cursorX = 0
        this.cursorY += this.rowHeight
        this.rowHeight = 0
      }
      if (this.cursorY + lh > this.height) continue

      const ax = this.cursorX
      const ay = this.cursorY

      ctx.fillStyle = color
      ctx.fillText(lineText, ax, ay)

      this.entries.push({
        ax,
        ay,
        aw: lw,
        ah: lh,
        dx,
        dy: dy + i * lineHeight,
        dw: lw,
        dh: lh,
      })

      this.cursorX += lw
      if (lh > this.rowHeight) this.rowHeight = lh
    }
  }

  getEntries(): TextEntry[] {
    return this.entries
  }

  getCanvas(): OffscreenCanvas {
    return this.canvas
  }
}

function wrapTextForNode(ctx: OffscreenCanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  if (maxWidth <= 0) return [text]
  const words = text.split(' ')
  const lines: string[] = []
  let current = ''
  for (const word of words) {
    const testLine = current ? current + ' ' + word : word
    if (ctx.measureText(testLine).width > maxWidth && current) {
      lines.push(current)
      current = word
    } else {
      current = testLine
    }
  }
  if (current) lines.push(current)
  return lines.length ? lines : ['']
}

function wrapText(ctx: OffscreenCanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  if (maxWidth <= 0) return [text]
  const words = text.split(' ')
  const lines: string[] = []
  let current = ''
  for (const word of words) {
    const testLine = current ? current + ' ' + word : word
    if (ctx.measureText(testLine).width > maxWidth && current) {
      lines.push(current)
      current = word
    } else {
      current = testLine
    }
  }
  if (current) lines.push(current)
  return lines.length ? lines : ['']
}

// --- Gradient atlas: each row holds one N-stop linear gradient sampled along its main axis ---

const GRADIENT_ATLAS_WIDTH = 256
const GRADIENT_ATLAS_HEIGHT = 64

class GradientAtlas {
  private canvas: OffscreenCanvas
  private ctx: OffscreenCanvasRenderingContext2D
  private nextRow = 0
  readonly width: number
  readonly height: number

  constructor() {
    this.width = GRADIENT_ATLAS_WIDTH
    this.height = GRADIENT_ATLAS_HEIGHT
    this.canvas = new OffscreenCanvas(this.width, this.height)
    const ctx = this.canvas.getContext('2d', { willReadFrequently: false })
    if (!ctx) throw new Error('Could not create offscreen 2d context for gradient atlas')
    this.ctx = ctx
  }

  clear(): void {
    this.nextRow = 0
    this.ctx.clearRect(0, 0, this.width, this.height)
  }

  /** Bake a gradient into a row. Returns the row index, or -1 if the atlas is full. */
  addGradient(stops: Array<{ offset: number; color: string }>): number {
    if (this.nextRow >= this.height) return -1
    const row = this.nextRow++
    const { ctx } = this
    const grad = ctx.createLinearGradient(0, 0, this.width, 0)
    for (const stop of stops) {
      const clampedOffset = Math.max(0, Math.min(1, stop.offset))
      grad.addColorStop(clampedOffset, stop.color)
    }
    ctx.fillStyle = grad
    ctx.fillRect(0, row, this.width, 1)
    return row
  }

  /** Returns the v-coordinate of a given row in [0, 1] for texture sampling. */
  rowToV(row: number): number {
    return (row + 0.5) / this.height
  }

  getCanvas(): OffscreenCanvas {
    return this.canvas
  }
}

// --- Image cache ---

interface ImageTextureEntry {
  texture: GPUTexture
  width: number
  height: number
  loaded: boolean
}

class ImageCache {
  private cache = new Map<string, ImageTextureEntry>()
  private loading = new Map<string, Promise<void>>()

  constructor(private device: GPUDevice, private onReady: () => void) {}

  get(src: string): ImageTextureEntry | null {
    const entry = this.cache.get(src)
    if (entry) return entry
    if (!this.loading.has(src)) {
      this.loading.set(src, this.load(src))
    }
    return null
  }

  private async load(src: string): Promise<void> {
    try {
      const img = new Image()
      img.crossOrigin = 'anonymous'
      img.src = src
      await img.decode()
      const bitmap = await createImageBitmap(img)
      const texture = this.device.createTexture({
        size: [bitmap.width, bitmap.height],
        format: 'rgba8unorm',
        usage: 0x04 | 0x10,
      })
      this.device.queue.copyExternalImageToTexture(
        { source: bitmap },
        { texture },
        [bitmap.width, bitmap.height],
      )
      this.cache.set(src, {
        texture,
        width: bitmap.width,
        height: bitmap.height,
        loaded: true,
      })
      this.onReady()
    } catch {
      this.cache.set(src, { texture: null as unknown as GPUTexture, width: 0, height: 0, loaded: false })
    } finally {
      this.loading.delete(src)
    }
  }

  destroy(): void {
    for (const entry of this.cache.values()) {
      if (entry.loaded && entry.texture) entry.texture.destroy()
    }
    this.cache.clear()
    this.loading.clear()
  }
}

// --- Collected renderables ---

interface TextItem {
  text: string
  font: string
  color: string
  lineHeight: number
  x: number
  y: number
  w: number
  h: number
  whiteSpace?: string
}

interface ImageItem {
  src: string
  x: number
  y: number
  w: number
  h: number
  opacity: number
}

interface ShapeItem {
  x: number
  y: number
  w: number
  h: number
  /** Per-corner radii: [topLeft, topRight, bottomRight, bottomLeft] */
  radius: [number, number, number, number]
  color1: [number, number, number, number]
  color2: [number, number, number, number]
  /** Gradient direction unit vector ((0,0) for solid or texture-sampled gradient) */
  gradientDir: [number, number]
  /** Blur radius in pixels for shadow pass; 0 means normal fill */
  shadowBlur: number
  /** -1 for no gradient texture; otherwise v-coordinate in [0, 1] into gradient atlas */
  gradientV: number
  /** Stroke width in pixels (0 = filled shape; > 0 = outline ring) */
  strokeWidth: number
  /** Radial gradient center in normalized [0,1] box coords; (0,0) unused when radialR <= 0 */
  radialCenter: [number, number]
  /** Radial gradient radius (normalized to box half-diagonal). 0 = not a radial gradient */
  radialR: number
  /** Quad draw rect is expanded/offset for shadow; kept separate from shape origin */
  drawX: number
  drawY: number
  drawW: number
  drawH: number
  /** Local origin of the SHAPE center within the draw quad (localPx offsets) */
  shapeCenterLocalX: number
  shapeCenterLocalY: number
}

export class WebGPURenderer implements Renderer {
  private canvas: HTMLCanvasElement
  private background: string
  private powerPreference: GPUPowerPreference
  private onFallbackNeeded?: (count: number) => void
  private debugLayoutBoundsEnabled: boolean
  private showFocusRing: boolean
  private focusRingColor: string
  private focusRingPadding: number
  private debugStrokeColor: string
  private selectionColor: string
  private _initialized = false

  /**
   * Current text selection range. When set, selected character ranges are highlighted behind text
   * each frame via the color pipeline. Mirrors {@link import('@geometra/renderer-canvas').CanvasRenderer.selection}.
   */
  selection: SelectionRange | null = null

  private textNodes: TextNodeInfo[] = []
  private textLineCache = new Map<string, Array<{ text: string; charOffsets: number[]; charWidths: number[] }>>()
  private adapter: GPUAdapter | null = null
  private device: GPUDevice | null = null
  private context: GPUCanvasContext | null = null
  private format: GPUTextureFormat | null = null

  // Pipelines
  private colorPipeline: GPURenderPipeline | null = null
  private shapePipeline: GPURenderPipeline | null = null
  private shapeBindGroupLayout: GPUBindGroupLayout | null = null
  private texturePipeline: GPURenderPipeline | null = null
  private textureBindGroupLayout: GPUBindGroupLayout | null = null
  private sampler: GPUSampler | null = null

  // Buffers
  private colorVB: GPUBuffer | null = null
  private colorVBCapacity = 0
  private shapeVB: GPUBuffer | null = null
  private shapeVBCapacity = 0
  private textVB: GPUBuffer | null = null
  private textVBCapacity = 0
  private imageVB: GPUBuffer | null = null
  private imageVBCapacity = 0

  private textAtlas: TextAtlas | null = null
  private gradientAtlas: GradientAtlas | null = null
  private imageCache: ImageCache | null = null

  constructor(options: WebGPURendererOptions) {
    this.canvas = options.canvas
    this.background = options.background ?? '#000000'
    this.powerPreference = options.powerPreference ?? 'high-performance'
    this.onFallbackNeeded = options.onFallbackNeeded
    this.debugLayoutBoundsEnabled = options.debugLayoutBounds ?? false
    this.showFocusRing = options.showFocusRing ?? true
    this.focusRingColor = options.focusRingColor ?? 'rgba(59, 130, 246, 0.95)'
    this.focusRingPadding = options.focusRingPadding ?? 2
    this.debugStrokeColor = options.debugStrokeColor ?? 'rgba(34, 197, 94, 0.45)'
    this.selectionColor = options.selectionColor ?? 'rgba(59, 130, 246, 0.4)'
  }

  static isSupported(): boolean {
    return typeof navigator !== 'undefined' && !!navigator.gpu
  }

  async init(): Promise<void> {
    if (!WebGPURenderer.isSupported()) {
      throw new Error('WebGPU is not supported in this environment')
    }
    this.adapter = await navigator.gpu.requestAdapter({ powerPreference: this.powerPreference })
    if (!this.adapter) throw new Error('Could not acquire WebGPU adapter')
    this.device = await this.adapter.requestDevice()
    const context = this.canvas.getContext('webgpu') as GPUCanvasContext | null
    if (!context) throw new Error('Could not get WebGPU canvas context')
    this.context = context
    this.format = navigator.gpu.getPreferredCanvasFormat()
    context.configure({
      device: this.device,
      format: this.format,
      alphaMode: 'premultiplied',
    })
    this.colorPipeline = this.createColorPipeline(this.device, this.format)
    this.shapePipeline = this.createShapePipeline(this.device, this.format)
    this.texturePipeline = this.createTexturePipeline(this.device, this.format)
    this.sampler = this.device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
    })
    this.textAtlas = new TextAtlas(2048, 2048)
    this.gradientAtlas = new GradientAtlas()
    this.imageCache = new ImageCache(this.device, () => {})
    this._initialized = true
  }

  render(layout: ComputedLayout, tree: UIElement): void {
    if (!this._initialized) {
      const ctx = this.canvas.getContext('2d')
      if (!ctx) {
        throw new Error('WebGPURenderer is not initialized. Call init() first.')
      }
      ctx.fillStyle = this.background
      const { w, h } = safeCanvasExtent(layout)
      ctx.fillRect(0, 0, w, h)
      return
    }
    const device = this.device!
    const context = this.context!
    const { w: canvasW, h: canvasH } = safeCanvasExtent(layout)
    this.canvas.width = canvasW
    this.canvas.height = canvasH

    const colorRects: number[] = []
    const shapes: ShapeItem[] = []
    const textItems: TextItem[] = []
    const imageItems: ImageItem[] = []
    const unsupported = { count: 0 }

    // Reset per-frame atlases
    this.textAtlas!.clear()
    this.gradientAtlas!.clear()

    this.collect(tree, layout, 0, 0, colorRects, shapes, textItems, imageItems, unsupported)
    if (unsupported.count > 0) this.onFallbackNeeded?.(unsupported.count)

    // Debug bounds overlay: emit stroke shapes for every layout rect
    if (this.debugLayoutBoundsEnabled) {
      const color = parseColor(this.debugStrokeColor)
      this.collectDebugBounds(tree, layout, 0, 0, shapes, color)
    }

    // Focus ring overlay: emit stroke shape around the focused element (if any)
    if (this.showFocusRing) {
      const focus = focusedElement.peek()
      if (focus && focus.element) {
        const color = parseColor(this.focusRingColor)
        this.collectFocusRing(tree, layout, 0, 0, focus.element, shapes, color)
      }
    }

    // Selection highlight: collect text nodes, compute line metrics, emit selection rects.
    // This must run before atlas population so the atlas ctx font state isn't disturbed.
    this.textNodes = []
    if (this.selection) {
      collectTextNodes(tree, layout, 0, 0, this.textNodes)
      for (const node of this.textNodes) {
        this.computeTextNodeLines(node)
      }
      this.collectSelectionRects(colorRects, canvasW, canvasH)
    }

    const atlas = this.textAtlas!
    for (const item of textItems) {
      atlas.addText(item.text, item.font, item.color, item.lineHeight, item.x, item.y, item.w, item.h, item.whiteSpace)
    }

    const bgColor = parseColor(this.background)
    const encoder = device.createCommandEncoder()
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: context.getCurrentTexture().createView(),
          clearValue: { r: bgColor[0], g: bgColor[1], b: bgColor[2], a: bgColor[3] },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    })

    // 1) Flat solid boxes
    if (colorRects.length > 0) {
      const vb = this.ensureBuffer('color', colorRects.length * 4)
      device.queue.writeBuffer(vb, 0, new Float32Array(colorRects))
      pass.setPipeline(this.colorPipeline!)
      pass.setVertexBuffer(0, vb)
      pass.draw(colorRects.length / 6)
    }

    // 2) Shape pipeline (rounded boxes, gradients, shadows)
    let gradientTexture: GPUTexture | null = null
    if (shapes.length > 0) {
      // Always create a gradient texture (even if empty) so the shape bind group has something to bind
      const gradientAtlas = this.gradientAtlas!
      gradientTexture = device.createTexture({
        size: [gradientAtlas.width, gradientAtlas.height],
        format: 'rgba8unorm',
        usage: 0x04 | 0x10,
      })
      device.queue.copyExternalImageToTexture(
        { source: gradientAtlas.getCanvas() },
        { texture: gradientTexture },
        [gradientAtlas.width, gradientAtlas.height],
      )

      const bindGroup = device.createBindGroup({
        layout: this.shapeBindGroupLayout!,
        entries: [
          { binding: 0, resource: this.sampler! },
          { binding: 1, resource: gradientTexture.createView() },
        ],
      })

      const shapeVerts = this.buildShapeVertices(shapes, canvasW, canvasH)
      const vb = this.ensureBuffer('shape', shapeVerts.length * 4)
      device.queue.writeBuffer(vb, 0, new Float32Array(shapeVerts))
      pass.setPipeline(this.shapePipeline!)
      pass.setVertexBuffer(0, vb)
      pass.setBindGroup(0, bindGroup)
      pass.draw(shapeVerts.length / SHAPE_VERTEX_STRIDE)
    }

    // 3) Text atlas draw
    const atlasEntries = atlas.getEntries()
    let textAtlasTexture: GPUTexture | null = null
    if (atlasEntries.length > 0) {
      const textVerts = this.buildTextureVertices(
        atlasEntries.map((e) => ({
          dx: e.dx,
          dy: e.dy,
          dw: e.dw,
          dh: e.dh,
          ax: e.ax,
          ay: e.ay,
          aw: e.aw,
          ah: e.ah,
          atlasW: atlas.width,
          atlasH: atlas.height,
          alpha: 1,
        })),
        canvasW,
        canvasH,
      )
      if (textVerts.length > 0) {
        const vb = this.ensureBuffer('text', textVerts.length * 4)
        device.queue.writeBuffer(vb, 0, new Float32Array(textVerts))

        textAtlasTexture = device.createTexture({
          size: [atlas.width, atlas.height],
          format: 'rgba8unorm',
          usage: 0x04 | 0x10,
        })
        device.queue.copyExternalImageToTexture(
          { source: atlas.getCanvas() },
          { texture: textAtlasTexture },
          [atlas.width, atlas.height],
        )

        const bindGroup = device.createBindGroup({
          layout: this.textureBindGroupLayout!,
          entries: [
            { binding: 0, resource: this.sampler! },
            { binding: 1, resource: textAtlasTexture.createView() },
          ],
        })

        pass.setPipeline(this.texturePipeline!)
        pass.setVertexBuffer(0, vb)
        pass.setBindGroup(0, bindGroup)
        pass.draw(textVerts.length / TEXTURE_VERTEX_STRIDE)
      }
    }

    // 4) Images — each image has its own texture
    for (const img of imageItems) {
      const entry = this.imageCache!.get(img.src)
      if (!entry || !entry.loaded) continue
      const verts = this.buildTextureVertices(
        [
          {
            dx: img.x,
            dy: img.y,
            dw: img.w,
            dh: img.h,
            ax: 0,
            ay: 0,
            aw: entry.width,
            ah: entry.height,
            atlasW: entry.width,
            atlasH: entry.height,
            alpha: img.opacity,
          },
        ],
        canvasW,
        canvasH,
      )
      const vb = this.ensureBuffer('image', verts.length * 4)
      device.queue.writeBuffer(vb, 0, new Float32Array(verts))

      const bindGroup = device.createBindGroup({
        layout: this.textureBindGroupLayout!,
        entries: [
          { binding: 0, resource: this.sampler! },
          { binding: 1, resource: entry.texture.createView() },
        ],
      })

      pass.setPipeline(this.texturePipeline!)
      pass.setVertexBuffer(0, vb)
      pass.setBindGroup(0, bindGroup)
      pass.draw(verts.length / TEXTURE_VERTEX_STRIDE)
    }

    pass.end()
    device.queue.submit([encoder.finish()])

    // Transient per-frame textures
    if (gradientTexture) gradientTexture.destroy()
    if (textAtlasTexture) textAtlasTexture.destroy()
  }

  destroy(): void {
    for (const buf of [this.colorVB, this.shapeVB, this.textVB, this.imageVB]) {
      if (buf) buf.destroy()
    }
    this.colorVB = this.shapeVB = this.textVB = this.imageVB = null
    if (this.imageCache) {
      this.imageCache.destroy()
      this.imageCache = null
    }
    this.colorPipeline = null
    this.shapePipeline = null
    this.shapeBindGroupLayout = null
    this.texturePipeline = null
    this.textureBindGroupLayout = null
    this.sampler = null
    this.textAtlas = null
    this.gradientAtlas = null
    this.context = null
    this.device = null
    this.adapter = null
    this.format = null
    this._initialized = false
  }

  // --- Pipelines ---

  private createColorPipeline(device: GPUDevice, format: GPUTextureFormat): GPURenderPipeline {
    const shader = device.createShaderModule({
      code: `
struct VSOut { @builtin(position) position: vec4f, @location(0) color: vec4f, }

@vertex fn vs_main(@location(0) pos: vec2f, @location(1) color: vec4f) -> VSOut {
  var out: VSOut;
  out.position = vec4f(pos.x, pos.y, 0.0, 1.0);
  out.color = color;
  return out;
}

@fragment fn fs_main(@location(0) color: vec4f) -> @location(0) vec4f { return color; }
`,
    })
    return device.createRenderPipeline({
      layout: 'auto',
      vertex: {
        module: shader,
        entryPoint: 'vs_main',
        buffers: [
          {
            arrayStride: 6 * 4,
            attributes: [
              { shaderLocation: 0, offset: 0, format: 'float32x2' },
              { shaderLocation: 1, offset: 2 * 4, format: 'float32x4' },
            ],
          },
        ],
      },
      fragment: {
        module: shader,
        entryPoint: 'fs_main',
        targets: [
          {
            format,
            blend: {
              color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' },
              alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
            },
          },
        ],
      },
      primitive: { topology: 'triangle-list' },
    })
  }

  /**
   * Shape pipeline: unified SDF path supporting rounded rects (per-corner), linear gradients
   * (2-stop vertex-colored or N-stop atlas-sampled), and box shadow pre-pass.
   */
  private createShapePipeline(device: GPUDevice, format: GPUTextureFormat): GPURenderPipeline {
    const shader = device.createShaderModule({
      code: `
struct VSOut {
  @builtin(position) position: vec4f,
  @location(0) localPx: vec2f,
  @location(1) halfSize: vec2f,
  @location(2) radius: vec4f,
  @location(3) color1: vec4f,
  @location(4) color2: vec4f,
  @location(5) gradDir: vec2f,
  @location(6) shadowBlur: f32,
  @location(7) gradientV: f32,
  @location(8) strokeWidth: f32,
  @location(9) radialCenter: vec2f,
  @location(10) radialR: f32,
}

@group(0) @binding(0) var gradSampler: sampler;
@group(0) @binding(1) var gradTexture: texture_2d<f32>;

@vertex fn vs_main(
  @location(0) pos: vec2f,
  @location(1) localPx: vec2f,
  @location(2) halfSize: vec2f,
  @location(3) radius: vec4f,
  @location(4) color1: vec4f,
  @location(5) color2: vec4f,
  @location(6) gradDir: vec2f,
  @location(7) shadowBlur: f32,
  @location(8) gradientV: f32,
  @location(9) strokeWidth: f32,
  @location(10) radialCenter: vec2f,
  @location(11) radialR: f32,
) -> VSOut {
  var out: VSOut;
  out.position = vec4f(pos.x, pos.y, 0.0, 1.0);
  out.localPx = localPx;
  out.halfSize = halfSize;
  out.radius = radius;
  out.color1 = color1;
  out.color2 = color2;
  out.gradDir = gradDir;
  out.shadowBlur = shadowBlur;
  out.gradientV = gradientV;
  out.strokeWidth = strokeWidth;
  out.radialCenter = radialCenter;
  out.radialR = radialR;
  return out;
}

// Per-corner rounded-rect SDF. radius = (topLeft, topRight, bottomRight, bottomLeft)
fn sdRoundRect(p: vec2f, b: vec2f, r: vec4f) -> f32 {
  var cornerR: f32;
  if (p.x >= 0.0 && p.y < 0.0) { cornerR = r.y; }       // top-right
  else if (p.x < 0.0 && p.y < 0.0) { cornerR = r.x; }   // top-left
  else if (p.x >= 0.0 && p.y >= 0.0) { cornerR = r.z; } // bottom-right
  else { cornerR = r.w; }                                // bottom-left

  let q = abs(p) - b + vec2f(cornerR, cornerR);
  return min(max(q.x, q.y), 0.0) + length(max(q, vec2f(0.0, 0.0))) - cornerR;
}

@fragment fn fs_main(in: VSOut) -> @location(0) vec4f {
  let d = sdRoundRect(in.localPx, in.halfSize, in.radius);

  // Shadow path: alpha fades from color.a at edge to 0 at shadowBlur distance outside
  if (in.shadowBlur > 0.0) {
    let outside = max(d, 0.0);
    let alpha = 1.0 - smoothstep(0.0, in.shadowBlur, outside);
    return vec4f(in.color1.rgb, in.color1.a * alpha);
  }

  // Stroke path: ring at shape edge of width strokeWidth
  if (in.strokeWidth > 0.0) {
    let edgeDist = abs(d);
    let halfW = in.strokeWidth * 0.5;
    let alpha = 1.0 - smoothstep(halfW - 0.5, halfW + 0.5, edgeDist);
    return vec4f(in.color1.rgb, in.color1.a * alpha);
  }

  // Fill path: antialiased edge
  let edgeAlpha = 1.0 - smoothstep(-0.5, 0.5, d);

  // Compute gradient t parameter (linear by projection, radial by distance)
  var t: f32 = 0.0;
  var hasGradient = false;
  if (in.radialR > 0.0) {
    hasGradient = true;
    // Normalize localPx to [0, 1] box coordinates
    let localNorm = (in.localPx / max(in.halfSize, vec2f(0.001, 0.001))) * 0.5 + vec2f(0.5, 0.5);
    let delta = localNorm - in.radialCenter;
    t = clamp(length(delta) / in.radialR, 0.0, 1.0);
  } else if (length(in.gradDir) > 0.001) {
    hasGradient = true;
    let dir = normalize(in.gradDir);
    let norm = in.localPx / max(in.halfSize, vec2f(0.001, 0.001));
    t = clamp(dot(norm, dir) * 0.5 + 0.5, 0.0, 1.0);
  }

  var col = in.color1;
  if (hasGradient) {
    if (in.gradientV >= 0.0) {
      col = textureSampleLevel(gradTexture, gradSampler, vec2f(t, in.gradientV), 0.0);
      col = vec4f(col.rgb, col.a * in.color1.a);
    } else {
      col = mix(in.color1, in.color2, t);
    }
  }

  return vec4f(col.rgb, col.a * edgeAlpha);
}
`,
    })

    const bindGroupLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: 0x2, sampler: {} },
        { binding: 1, visibility: 0x2, texture: {} },
      ],
    })
    this.shapeBindGroupLayout = bindGroupLayout

    return device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }),
      vertex: {
        module: shader,
        entryPoint: 'vs_main',
        buffers: [
          {
            arrayStride: SHAPE_VERTEX_STRIDE * 4,
            attributes: [
              { shaderLocation: 0, offset: 0, format: 'float32x2' },        // pos
              { shaderLocation: 1, offset: 2 * 4, format: 'float32x2' },    // localPx
              { shaderLocation: 2, offset: 4 * 4, format: 'float32x2' },    // halfSize
              { shaderLocation: 3, offset: 6 * 4, format: 'float32x4' },    // radius vec4
              { shaderLocation: 4, offset: 10 * 4, format: 'float32x4' },   // color1
              { shaderLocation: 5, offset: 14 * 4, format: 'float32x4' },   // color2
              { shaderLocation: 6, offset: 18 * 4, format: 'float32x2' },   // gradDir
              { shaderLocation: 7, offset: 20 * 4, format: 'float32' },     // shadowBlur
              { shaderLocation: 8, offset: 21 * 4, format: 'float32' },     // gradientV
              { shaderLocation: 9, offset: 22 * 4, format: 'float32' },     // strokeWidth
              { shaderLocation: 10, offset: 23 * 4, format: 'float32x2' },  // radialCenter
              { shaderLocation: 11, offset: 25 * 4, format: 'float32' },    // radialR
            ],
          },
        ],
      },
      fragment: {
        module: shader,
        entryPoint: 'fs_main',
        targets: [
          {
            format,
            blend: {
              color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' },
              alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
            },
          },
        ],
      },
      primitive: { topology: 'triangle-list' },
    })
  }

  private createTexturePipeline(device: GPUDevice, format: GPUTextureFormat): GPURenderPipeline {
    const shader = device.createShaderModule({
      code: `
struct VSOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
  @location(1) alpha: f32,
}

@group(0) @binding(0) var atlasSampler: sampler;
@group(0) @binding(1) var atlasTexture: texture_2d<f32>;

@vertex fn vs_main(@location(0) pos: vec2f, @location(1) uv: vec2f, @location(2) alpha: f32) -> VSOut {
  var out: VSOut;
  out.position = vec4f(pos.x, pos.y, 0.0, 1.0);
  out.uv = uv;
  out.alpha = alpha;
  return out;
}

@fragment fn fs_main(in: VSOut) -> @location(0) vec4f {
  let c = textureSample(atlasTexture, atlasSampler, in.uv);
  return vec4f(c.rgb, c.a * in.alpha);
}
`,
    })

    const bindGroupLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: 0x2, sampler: {} },
        { binding: 1, visibility: 0x2, texture: {} },
      ],
    })
    this.textureBindGroupLayout = bindGroupLayout

    return device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }),
      vertex: {
        module: shader,
        entryPoint: 'vs_main',
        buffers: [
          {
            arrayStride: TEXTURE_VERTEX_STRIDE * 4,
            attributes: [
              { shaderLocation: 0, offset: 0, format: 'float32x2' },
              { shaderLocation: 1, offset: 2 * 4, format: 'float32x2' },
              { shaderLocation: 2, offset: 4 * 4, format: 'float32' },
            ],
          },
        ],
      },
      fragment: {
        module: shader,
        entryPoint: 'fs_main',
        targets: [
          {
            format,
            blend: {
              color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' },
              alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
            },
          },
        ],
      },
      primitive: { topology: 'triangle-list' },
    })
  }

  // --- Vertex builders ---

  private buildShapeVertices(shapes: ShapeItem[], canvasW: number, canvasH: number): number[] {
    const verts: number[] = []
    for (const s of shapes) {
      const x0 = (s.drawX / canvasW) * 2 - 1
      const y0 = 1 - (s.drawY / canvasH) * 2
      const x1 = ((s.drawX + s.drawW) / canvasW) * 2 - 1
      const y1 = 1 - ((s.drawY + s.drawH) / canvasH) * 2

      const lx0 = -s.shapeCenterLocalX
      const ly0 = -s.shapeCenterLocalY
      const lx1 = s.drawW - s.shapeCenterLocalX
      const ly1 = s.drawH - s.shapeCenterLocalY

      const hw = s.w / 2
      const hh = s.h / 2
      const [rTL, rTR, rBR, rBL] = s.radius
      const [c1r, c1g, c1b, c1a] = s.color1
      const [c2r, c2g, c2b, c2a] = s.color2
      const [gx, gy] = s.gradientDir
      const [rcx, rcy] = s.radialCenter

      const push = (px: number, py: number, lx: number, ly: number) => {
        pushShapeVert(
          verts, px, py, lx, ly, hw, hh,
          rTL, rTR, rBR, rBL,
          c1r, c1g, c1b, c1a,
          c2r, c2g, c2b, c2a,
          gx, gy,
          s.shadowBlur, s.gradientV,
          s.strokeWidth,
          rcx, rcy, s.radialR,
        )
      }

      push(x0, y0, lx0, ly0)
      push(x1, y0, lx1, ly0)
      push(x0, y1, lx0, ly1)
      push(x1, y0, lx1, ly0)
      push(x1, y1, lx1, ly1)
      push(x0, y1, lx0, ly1)
    }
    return verts
  }

  private buildTextureVertices(
    entries: Array<{
      dx: number
      dy: number
      dw: number
      dh: number
      ax: number
      ay: number
      aw: number
      ah: number
      atlasW: number
      atlasH: number
      alpha: number
    }>,
    canvasW: number,
    canvasH: number,
  ): number[] {
    const verts: number[] = []
    for (const e of entries) {
      const x0 = (e.dx / canvasW) * 2 - 1
      const y0 = 1 - (e.dy / canvasH) * 2
      const x1 = ((e.dx + e.dw) / canvasW) * 2 - 1
      const y1 = 1 - ((e.dy + e.dh) / canvasH) * 2

      const u0 = e.ax / e.atlasW
      const v0 = e.ay / e.atlasH
      const u1 = (e.ax + e.aw) / e.atlasW
      const v1 = (e.ay + e.ah) / e.atlasH

      verts.push(x0, y0, u0, v0, e.alpha)
      verts.push(x1, y0, u1, v0, e.alpha)
      verts.push(x0, y1, u0, v1, e.alpha)
      verts.push(x1, y0, u1, v0, e.alpha)
      verts.push(x1, y1, u1, v1, e.alpha)
      verts.push(x0, y1, u0, v1, e.alpha)
    }
    return verts
  }

  private ensureBuffer(kind: 'color' | 'shape' | 'text' | 'image', requiredBytes: number): GPUBuffer {
    const device = this.device!
    const minSize = 1024 * 16
    const field = kind === 'color' ? 'colorVB' : kind === 'shape' ? 'shapeVB' : kind === 'text' ? 'textVB' : 'imageVB'
    const capField = kind === 'color'
      ? 'colorVBCapacity'
      : kind === 'shape'
      ? 'shapeVBCapacity'
      : kind === 'text'
      ? 'textVBCapacity'
      : 'imageVBCapacity'
    const current = this[field] as GPUBuffer | null
    const capacity = this[capField] as number
    if (current && capacity >= requiredBytes) return current
    if (current) current.destroy()
    const newCap = Math.max(requiredBytes, minSize)
    const buf = device.createBuffer({ size: newCap, usage: 0x0020 | 0x0008 })
    ;(this[field] as GPUBuffer | null) = buf
    ;(this[capField] as number) = newCap
    return buf
  }

  // --- Tree walk & categorization ---

  private collect(
    element: UIElement,
    layout: ComputedLayout,
    offsetX: number,
    offsetY: number,
    colorRects: number[],
    shapes: ShapeItem[],
    textItems: TextItem[],
    imageItems: ImageItem[],
    unsupported: { count: number },
  ): void {
    if (!layoutBoundsAreFinite(layout)) {
      unsupported.count++
      return
    }
    const x = offsetX + layout.x
    const y = offsetY + layout.y
    const w = layout.width
    const h = layout.height

    if (element.kind === 'text') {
      const { text, font, color, lineHeight, whiteSpace } = element.props
      if (text) {
        textItems.push({
          text,
          font: font ?? '16px sans-serif',
          color: color ?? '#ffffff',
          lineHeight: lineHeight ?? 20,
          x,
          y,
          w,
          h,
          whiteSpace,
        })
      }
      return
    }

    if (element.kind === 'image') {
      const { src, opacity } = element.props
      if (src) {
        imageItems.push({ src, x, y, w, h, opacity: opacity ?? 1 })
      }
      return
    }

    if (element.kind === 'box') {
      this.categorizeBox(element, x, y, w, h, colorRects, shapes)

      const childOffsetX = x - finiteNumberOrZero(element.props.scrollX)
      const childOffsetY = y - finiteNumberOrZero(element.props.scrollY)
      for (let i = 0; i < element.children.length; i++) {
        const childLayout = layout.children[i]
        if (childLayout) {
          this.collect(
            element.children[i]!,
            childLayout,
            childOffsetX,
            childOffsetY,
            colorRects,
            shapes,
            textItems,
            imageItems,
            unsupported,
          )
        }
      }
      return
    }
    unsupported.count++
  }

  private categorizeBox(
    element: BoxElement,
    x: number,
    y: number,
    w: number,
    h: number,
    colorRects: number[],
    shapes: ShapeItem[],
  ): void {
    const { backgroundColor, borderRadius, gradient, boxShadow, opacity } = element.props

    const corners = normalizeBorderRadius(borderRadius, w, h)
    const hasRadius = corners[0] > 0 || corners[1] > 0 || corners[2] > 0 || corners[3] > 0
    const gradientKind: 'linear' | 'radial' | null =
      gradient && gradient.stops.length >= 2
        ? gradient.type === 'linear'
          ? 'linear'
          : gradient.type === 'radial'
          ? 'radial'
          : null
        : null
    const hasGradient = gradientKind !== null

    // Box shadow pre-pass (drawn first, behind the fill)
    if (boxShadow && (backgroundColor || hasGradient || hasRadius)) {
      const shadowColor = parseColor(boxShadow.color)
      const shadowAlpha = opacity === undefined ? shadowColor[3] : shadowColor[3] * opacity
      const blur = Math.max(0, boxShadow.blur)
      const ox = boxShadow.offsetX
      const oy = boxShadow.offsetY

      const drawX = x + ox - blur
      const drawY = y + oy - blur
      const drawW = w + 2 * blur
      const drawH = h + 2 * blur
      const shapeCenterLocalX = w / 2 + blur
      const shapeCenterLocalY = h / 2 + blur

      shapes.push({
        x, y, w, h,
        radius: corners,
        color1: [shadowColor[0], shadowColor[1], shadowColor[2], shadowAlpha],
        color2: [shadowColor[0], shadowColor[1], shadowColor[2], shadowAlpha],
        gradientDir: [0, 0],
        shadowBlur: Math.max(blur, 0.001),
        gradientV: -1,
        strokeWidth: 0,
        radialCenter: [0.5, 0.5],
        radialR: 0,
        drawX, drawY, drawW, drawH,
        shapeCenterLocalX, shapeCenterLocalY,
      })
    }

    if (!hasRadius && !hasGradient && !backgroundColor) return

    // Flat path (no radius, no gradient, solid color)
    if (!hasRadius && !hasGradient && backgroundColor) {
      const [r, g, b, a] = parseColor(backgroundColor)
      const alpha = opacity === undefined ? a : a * opacity
      pushRectVertices(colorRects, x, y, w, h, this.canvas.width, this.canvas.height, r, g, b, alpha)
      return
    }

    // Shape path
    let color1: [number, number, number, number]
    let color2: [number, number, number, number]
    let gradDir: [number, number] = [0, 0]
    let gradientV = -1
    let radialCenter: [number, number] = [0.5, 0.5]
    let radialR = 0

    if (gradient && gradientKind === 'linear' && gradient.type === 'linear') {
      const stops = gradient.stops
      const angleRad = ((gradient.angle ?? 180) * Math.PI) / 180
      gradDir = [Math.sin(angleRad), -Math.cos(angleRad)]

      if (stops.length > 2) {
        const row = this.gradientAtlas!.addGradient(stops)
        if (row >= 0) {
          gradientV = this.gradientAtlas!.rowToV(row)
          color1 = [1, 1, 1, 1]
          color2 = [1, 1, 1, 1]
        } else {
          color1 = parseColor(stops[0]!.color)
          color2 = parseColor(stops[stops.length - 1]!.color)
        }
      } else {
        color1 = parseColor(stops[0]!.color)
        color2 = parseColor(stops[1]!.color)
      }
    } else if (gradient && gradientKind === 'radial' && gradient.type === 'radial') {
      const stops = gradient.stops
      radialCenter = [gradient.center?.x ?? 0.5, gradient.center?.y ?? 0.5]
      // Normalize radius so t=1 reaches the farthest corner when radius=1. In normalized 0..1 box
      // coords the max corner distance from any interior center is up to √2; pass that through so
      // the fragment shader's normalized-distance `t` matches CSS radial-gradient semantics.
      radialR = Math.max(0.001, gradient.radius ?? 1) * Math.SQRT2

      if (stops.length > 2) {
        const row = this.gradientAtlas!.addGradient(stops)
        if (row >= 0) {
          gradientV = this.gradientAtlas!.rowToV(row)
          color1 = [1, 1, 1, 1]
          color2 = [1, 1, 1, 1]
        } else {
          color1 = parseColor(stops[0]!.color)
          color2 = parseColor(stops[stops.length - 1]!.color)
        }
      } else {
        color1 = parseColor(stops[0]!.color)
        color2 = parseColor(stops[1]!.color)
      }
    } else {
      const base = backgroundColor ? parseColor(backgroundColor) : ([0, 0, 0, 1] as [number, number, number, number])
      color1 = base
      color2 = base
    }

    if (opacity !== undefined) {
      color1 = [color1[0], color1[1], color1[2], color1[3] * opacity]
      color2 = [color2[0], color2[1], color2[2], color2[3] * opacity]
    }

    shapes.push({
      x, y, w, h,
      radius: corners,
      color1, color2,
      gradientDir: gradDir,
      shadowBlur: 0,
      gradientV,
      strokeWidth: 0,
      radialCenter,
      radialR,
      drawX: x, drawY: y, drawW: w, drawH: h,
      shapeCenterLocalX: w / 2,
      shapeCenterLocalY: h / 2,
    })
  }

  /**
   * Populate per-line character offset/width metrics on each text node using the text atlas's
   * OffscreenCanvas measurement context. Mirrors `renderer-canvas`'s `computeTextNodeLines` so
   * the selection highlight code path computes identical highlight rects.
   */
  private computeTextNodeLines(node: TextNodeInfo): void {
    const atlas = this.textAtlas
    if (!atlas) return
    // Access the atlas's 2d ctx for measurement. We reuse the existing context but save/restore
    // `font` so atlas rasterization is unaffected.
    const atlasCanvas = atlas.getCanvas()
    const ctx = atlasCanvas.getContext('2d') as OffscreenCanvasRenderingContext2D | null
    if (!ctx) return

    const { lineHeight, font, text, whiteSpace } = node.element.props
    const shouldWrap = whiteSpace === 'normal' || whiteSpace === 'pre-wrap'
    const width = Math.max(1, Math.round(node.width * 1000) / 1000)
    const wrapKey = shouldWrap ? 'w' : 'n'
    const cacheKey = `${wrapKey}|${font}|${lineHeight}|${width}|${text}`
    let cached = this.textLineCache.get(cacheKey)

    if (!cached) {
      const prevFont = ctx.font
      ctx.font = font
      const wrappedLines = shouldWrap ? wrapTextForNode(ctx, text, width) : [text]
      cached = wrappedLines.map((lineText) => {
        const charOffsets: number[] = []
        const charWidths: number[] = []
        let xOffset = 0
        for (let c = 0; c < lineText.length; c++) {
          charOffsets.push(xOffset)
          const cw = ctx.measureText(lineText[c]!).width
          charWidths.push(cw)
          xOffset += cw
        }
        return { text: lineText, charOffsets, charWidths }
      })
      ctx.font = prevFont
      this.textLineCache.set(cacheKey, cached)
      if (this.textLineCache.size > 500) this.textLineCache.clear()
    }

    node.lines = cached.map((line, i) => ({
      text: line.text,
      x: node.direction === 'rtl'
        ? node.x + Math.max(
            0,
            node.width -
              (line.charOffsets.length > 0
                ? (line.charOffsets[line.charOffsets.length - 1] ?? 0) +
                  (line.charWidths[line.charWidths.length - 1] ?? 0)
                : 0),
          )
        : node.x,
      y: node.y + i * lineHeight,
      charOffsets: line.charOffsets,
      charWidths: line.charWidths,
    }))
  }

  /**
   * Emit selection background rects into the `colorRects` stream. Selected per-line character
   * ranges become solid color quads drawn between shapes and text.
   */
  private collectSelectionRects(colorRects: number[], canvasW: number, canvasH: number): void {
    const sel = this.selection
    if (!sel || this.textNodes.length === 0) return
    let startNode = sel.anchorNode, startOffset = sel.anchorOffset
    let endNode = sel.focusNode, endOffset = sel.focusOffset
    if (startNode > endNode || (startNode === endNode && startOffset > endOffset)) {
      ;[startNode, endNode] = [endNode, startNode]
      ;[startOffset, endOffset] = [endOffset, startOffset]
    }
    const [r, g, b, a] = parseColor(this.selectionColor)

    for (const node of this.textNodes) {
      if (node.index < startNode || node.index > endNode) continue
      const lineHeight = node.element.props.lineHeight
      let globalCharOffset = 0
      for (const line of node.lines) {
        const lineStart = globalCharOffset
        const lineEnd = globalCharOffset + line.text.length
        let selStart: number, selEnd: number
        if (node.index === startNode && node.index === endNode) {
          selStart = Math.max(startOffset, lineStart) - lineStart
          selEnd = Math.min(endOffset, lineEnd) - lineStart
        } else if (node.index === startNode) {
          selStart = Math.max(startOffset, lineStart) - lineStart
          selEnd = line.text.length
        } else if (node.index === endNode) {
          selStart = 0
          selEnd = Math.min(endOffset, lineEnd) - lineStart
        } else {
          selStart = 0
          selEnd = line.text.length
        }
        if (selStart < selEnd && selStart < line.charOffsets.length) {
          const rectX = line.x + (line.charOffsets[selStart] ?? 0)
          const endCharOffset =
            selEnd < line.charOffsets.length
              ? line.charOffsets[selEnd]!
              : (line.charOffsets[line.charOffsets.length - 1] ?? 0) +
                (line.charWidths[line.charWidths.length - 1] ?? 0)
          const rectW = endCharOffset - (line.charOffsets[selStart] ?? 0)
          if (rectW > 0) {
            pushRectVertices(colorRects, rectX, line.y, rectW, lineHeight, canvasW, canvasH, r, g, b, a)
          }
        }
        globalCharOffset = lineEnd
      }
    }
  }

  /**
   * Push a stroke shape (focus ring, debug bounds). Width is in pixels; the outline is centered on
   * the shape edge so total visual stroke spans `strokeWidth`.
   */
  private pushStrokeShape(
    shapes: ShapeItem[],
    x: number,
    y: number,
    w: number,
    h: number,
    radius: [number, number, number, number],
    strokeWidth: number,
    color: [number, number, number, number],
  ): void {
    // Expand draw quad outward by strokeWidth/2 so the entire ring fits inside the antialiased region
    const pad = strokeWidth * 0.5 + 1
    shapes.push({
      x, y, w, h,
      radius,
      color1: color,
      color2: color,
      gradientDir: [0, 0],
      shadowBlur: 0,
      gradientV: -1,
      strokeWidth,
      radialCenter: [0.5, 0.5],
      radialR: 0,
      drawX: x - pad,
      drawY: y - pad,
      drawW: w + 2 * pad,
      drawH: h + 2 * pad,
      shapeCenterLocalX: w / 2 + pad,
      shapeCenterLocalY: h / 2 + pad,
    })
  }

  /** Walk the tree and emit stroked debug bounds for every layout rect. */
  private collectDebugBounds(
    element: UIElement,
    layout: ComputedLayout,
    offsetX: number,
    offsetY: number,
    shapes: ShapeItem[],
    color: [number, number, number, number],
  ): void {
    if (!layoutBoundsAreFinite(layout)) return
    const x = offsetX + layout.x
    const y = offsetY + layout.y
    this.pushStrokeShape(shapes, x, y, layout.width, layout.height, [0, 0, 0, 0], 1, color)

    if (element.kind !== 'box') return
    const childOffsetX = x - finiteNumberOrZero(element.props.scrollX)
    const childOffsetY = y - finiteNumberOrZero(element.props.scrollY)
    for (let i = 0; i < element.children.length; i++) {
      const childLayout = layout.children[i]
      if (childLayout) {
        this.collectDebugBounds(element.children[i]!, childLayout, childOffsetX, childOffsetY, shapes, color)
      }
    }
  }

  /**
   * Walk the tree to find the focused element and emit a stroke shape around it.
   * Returns true when the focused element is located and its ring has been emitted.
   */
  private collectFocusRing(
    element: UIElement,
    layout: ComputedLayout,
    offsetX: number,
    offsetY: number,
    target: UIElement,
    shapes: ShapeItem[],
    color: [number, number, number, number],
  ): boolean {
    if (!layoutBoundsAreFinite(layout)) return false
    const x = offsetX + layout.x
    const y = offsetY + layout.y

    if (element === target) {
      const pad = this.focusRingPadding
      const ringRadius = normalizeBorderRadius(
        element.kind === 'box' ? (element as BoxElement).props.borderRadius : undefined,
        layout.width + pad * 2,
        layout.height + pad * 2,
      )
      this.pushStrokeShape(
        shapes,
        x - pad,
        y - pad,
        layout.width + pad * 2,
        layout.height + pad * 2,
        ringRadius,
        2,
        color,
      )
      return true
    }

    if (element.kind !== 'box') return false
    const childOffsetX = x - finiteNumberOrZero(element.props.scrollX)
    const childOffsetY = y - finiteNumberOrZero(element.props.scrollY)
    for (let i = 0; i < element.children.length; i++) {
      const childLayout = layout.children[i]
      if (childLayout) {
        if (this.collectFocusRing(element.children[i]!, childLayout, childOffsetX, childOffsetY, target, shapes, color)) {
          return true
        }
      }
    }
    return false
  }
}

// --- Constants ---

const SHAPE_VERTEX_STRIDE = 26 // pos(2) localPx(2) halfSize(2) radius(4) color1(4) color2(4) gradDir(2) shadowBlur(1) gradientV(1) strokeWidth(1) radialCenter(2) radialR(1)
const TEXTURE_VERTEX_STRIDE = 5 // pos(2) uv(2) alpha(1)

function pushShapeVert(
  out: number[],
  px: number, py: number,
  lx: number, ly: number,
  hw: number, hh: number,
  rTL: number, rTR: number, rBR: number, rBL: number,
  c1r: number, c1g: number, c1b: number, c1a: number,
  c2r: number, c2g: number, c2b: number, c2a: number,
  gx: number, gy: number,
  shadowBlur: number, gradientV: number,
  strokeWidth: number,
  radialCx: number, radialCy: number, radialR: number,
): void {
  out.push(
    px, py, lx, ly, hw, hh,
    rTL, rTR, rBR, rBL,
    c1r, c1g, c1b, c1a,
    c2r, c2g, c2b, c2a,
    gx, gy,
    shadowBlur, gradientV,
    strokeWidth,
    radialCx, radialCy, radialR,
  )
}

function pushRectVertices(
  out: number[],
  x: number,
  y: number,
  w: number,
  h: number,
  canvasW: number,
  canvasH: number,
  r: number,
  g: number,
  b: number,
  a: number,
): void {
  const x0 = (x / canvasW) * 2 - 1
  const y0 = 1 - (y / canvasH) * 2
  const x1 = ((x + w) / canvasW) * 2 - 1
  const y1 = 1 - ((y + h) / canvasH) * 2
  out.push(x0, y0, r, g, b, a)
  out.push(x1, y0, r, g, b, a)
  out.push(x0, y1, r, g, b, a)
  out.push(x1, y0, r, g, b, a)
  out.push(x1, y1, r, g, b, a)
  out.push(x0, y1, r, g, b, a)
}
