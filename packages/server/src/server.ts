import { WebSocketServer } from 'ws'
import type { WebSocket } from 'ws'
import type { IncomingMessage, Server as HttpServer } from 'node:http'
import type { Duplex } from 'node:stream'
import { init, computeLayout } from 'textura'
import type { ComputedLayout } from 'textura'
import {
  toLayoutTree,
  resolveComputeLayoutDirection,
  dispatchHit,
  dispatchKeyboardEvent,
  dispatchCompositionEvent,
} from '@geometra/core'
import type { UIElement, EventHandlers } from '@geometra/core'
import { diffLayout, coalescePatches, PROTOCOL_VERSION, isProtocolCompatible, CLOSE_AUTH_FAILED, CLOSE_FORBIDDEN } from './protocol.js'

const NATIVE_PROTOCOL_METADATA = {
  protocolVersion: PROTOCOL_VERSION,
  geometryProtocolVersion: PROTOCOL_VERSION,
  protocolCapabilities: {
    transport: 'native',
    requestScopedAcks: true,
    proxyActions: false,
    exactFieldIdentity: false,
    binaryFraming: true,
  },
} as const
import type { ServerMessage, ClientMessage, ServerDataMessage } from './protocol.js'
import { encodeBinaryFrameJson } from './binary-frame.js'

/** Default WebSocket pathname when attaching to an existing HTTP server. */
export const DEFAULT_GEOMETRA_WS_PATH = '/geometra-ws'

export interface TexturaServerOptions {
  /**
   * Existing Node HTTP server to attach the Geometra WebSocket to (via `upgrade`).
   * When set, do not pass `port` — the WS endpoint listens on `wsPath` only.
   * Use this to serve static files, REST APIs, and Geometra on one TCP port.
   */
  httpServer?: HttpServer
  /**
   * URL pathname for WebSocket upgrades when `httpServer` is set.
   * Default {@link DEFAULT_GEOMETRA_WS_PATH}.
   */
  wsPath?: string
  /** Port to listen on when `httpServer` is omitted. Default: 3100. */
  port?: number
  /** Root width. Default: 800. */
  width?: number
  /**
   * Root height. Default: 600.
   * Set to `'auto'` to let Yoga compute intrinsic height from content.
   * When auto, the root layout height reflects content size and clients
   * can read it from the frame's `layout.height`.
   */
  height?: number | 'auto'
  /** Called on errors during layout computation or broadcasting. */
  onError?: (error: unknown) => void
  /**
   * Called when a new WebSocket client connects. Receives the HTTP upgrade
   * request (headers, URL, etc.). Return any truthy value to accept the
   * connection — that value becomes the connection context passed to
   * `onMessage` and `onDisconnect`. Return `null` to reject (closes with
   * 4001). Throwing also rejects. Async handlers are supported.
   */
  onConnection?: (request: IncomingMessage) => unknown | Promise<unknown>
  /** Called when an accepted client disconnects. Receives the connection context. */
  onDisconnect?: (context: unknown) => void
  /**
   * Called before processing each client message. Return `false` to reject
   * the message (sends a 4003 error to the client, event is not dispatched).
   */
  onMessage?: (message: ClientMessage, context: unknown) => boolean
  /** Backpressure threshold; clients above this buffered amount are deferred. */
  backpressureBytes?: number
  /** Per-broadcast transport telemetry (backpressure, coalescing, binary outbound). */
  onTransportMetrics?: (metrics: ServerTransportMetrics) => void
  /**
   * Yoga / Textura root layout direction. When omitted, derived from the view root’s resolved `dir`
   * (parent context defaults to `ltr`).
   *
   * Values other than the strings `ltr` and `rtl` are ignored at runtime (e.g. malformed config) so
   * `computeLayout` still receives a direction consistent with the root element, matching
   * `createApp`'s `layoutDirection` option in `@geometra/core`.
   *
   * Forwards to the Textura owner-direction field (`ComputeOptions.direction` on each {@link computeLayout} call;
   * owner context for `dir: 'auto'` nodes).
   */
  layoutDirection?: 'ltr' | 'rtl'
}

/** Emitted after each successful broadcast (not on early no-op returns). */
export interface ServerTransportMetrics {
  deferredSends: number
  /** How many raw patches were merged by coalescing (0 when no previous layout). */
  coalescedPatchDelta: number
  /** Count of clients that received a binary WebSocket frame this round. */
  binaryOutboundFrames: number
}

export interface TexturaServer {
  /** Trigger a re-render for all connected clients. */
  update(): void
  /**
   * Push a JSON `data` frame on the same WebSocket as layout updates (see {@link ServerDataMessage}).
   * Safe for headless agents and hybrid renderers; does not trigger layout.
   */
  broadcastData(channel: string, payload: unknown): void
  /** Shut down the server. */
  close(): void
}

/**
 * Whether outbound sends to a client should be deferred because `WebSocket.bufferedAmount`
 * already exceeds the configured backpressure ceiling. Uses strict `>` so equality does not defer.
 *
 * @param bufferedAmount — Bytes queued for the socket (from the runtime).
 * @param backpressureBytes — Defer when `bufferedAmount` is greater than this value.
 */
export function shouldDeferClientSend(
  bufferedAmount: number,
  backpressureBytes: number,
): boolean {
  return bufferedAmount > backpressureBytes
}

function normalizeWsPath(pathname: string): string {
  let p = pathname.trim()
  if (!p.startsWith('/')) {
    p = `/${p}`
  }
  if (p.length > 1 && p.endsWith('/')) {
    p = p.slice(0, -1)
  }
  return p
}

function upgradePathMatches(request: IncomingMessage, wsPath: string): boolean {
  const host = request.headers.host ?? 'localhost'
  try {
    const pathname = new URL(request.url ?? '/', `http://${host}`).pathname
    const norm = normalizeWsPath(wsPath)
    const reqPath = normalizeWsPath(pathname)
    return reqPath === norm
  } catch {
    return false
  }
}

/** Reject corrupt wire values (null from JSON, strings, NaN) before pointer dispatch + layout churn. */
function clientPointerXYAreFinite(x: unknown, y: unknown): boolean {
  return typeof x === 'number' && Number.isFinite(x) && typeof y === 'number' && Number.isFinite(y)
}

function messageRequestId(message: ClientMessage): string | undefined {
  return typeof (message as { requestId?: unknown }).requestId === 'string'
    ? (message as { requestId: string }).requestId
    : undefined
}

/**
 * Create a Textura server that computes layout and streams geometry to clients.
 *
 * The `view` function produces the UI tree. Call `server.update()` after
 * signal changes to push new frames to all connected clients.
 */
export async function createServer(
  view: () => UIElement,
  options: TexturaServerOptions = {},
): Promise<TexturaServer> {
  await init()

  if (options.httpServer != null && options.port !== undefined) {
    throw new Error('createServer: pass either httpServer (attach mode) or port (standalone), not both')
  }

  const port = options.port ?? 3100
  const wsPathNormalized = normalizeWsPath(options.wsPath ?? DEFAULT_GEOMETRA_WS_PATH)
  let width = options.width ?? 800
  const autoHeight = options.height === 'auto'
  let height: number | undefined = autoHeight ? undefined : (typeof options.height === 'number' ? options.height : 600)

  const clients = new Set<WebSocket>()
  const needsResync = new Set<WebSocket>()
  /** Clients that negotiated optional binary JSON envelopes for server→client frames. */
  const clientBinaryFraming = new Map<WebSocket, boolean>()
  const contexts = new Map<WebSocket, unknown>()
  let prevLayout: ComputedLayout | null = null
  let currentTree: UIElement | null = null
  let prevSerializedTree: string | null = null
  const backpressureBytes = Math.max(1024, options.backpressureBytes ?? 512 * 1024)
  const layoutDirectionOption = options.layoutDirection

  function computeAndBroadcast(): boolean {
    try {
      currentTree = view()
      const serializedTree = JSON.stringify(currentTree)
      const layoutTree = toLayoutTree(currentTree)
      const direction = resolveComputeLayoutDirection(layoutDirectionOption, currentTree)
      const layout = computeLayout(layoutTree, { width, height, direction })

      let msg: ServerMessage
      let coalescedPatchDelta = 0
      const treeChanged = prevSerializedTree !== serializedTree
      if (prevLayout && !treeChanged) {
        const rawPatches = diffLayout(prevLayout, layout)
        const patches = coalescePatches(rawPatches)
        coalescedPatchDelta = Math.max(0, rawPatches.length - patches.length)
        if (patches.length === 0) return true
        // Patch streams are only safe when the render tree is byte-for-byte stable.
        if (patches.length > 20) {
          msg = { type: 'frame', layout, tree: currentTree, ...NATIVE_PROTOCOL_METADATA }
        } else {
          msg = { type: 'patch', patches, ...NATIVE_PROTOCOL_METADATA }
        }
      } else {
        msg = { type: 'frame', layout, tree: currentTree, ...NATIVE_PROTOCOL_METADATA }
      }

      prevLayout = layout
      prevSerializedTree = serializedTree
      let deferredSends = 0
      let binaryOutboundFrames = 0
      for (const client of clients) {
        if (client.readyState === client.OPEN) {
          if (shouldDeferClientSend(client.bufferedAmount, backpressureBytes)) {
            deferredSends++
            needsResync.add(client)
            continue
          }
          const clientMsg: ServerMessage =
            needsResync.has(client)
              ? { type: 'frame', layout, tree: currentTree, ...NATIVE_PROTOCOL_METADATA }
              : msg
          if (needsResync.has(client)) needsResync.delete(client)
          const json = JSON.stringify(clientMsg)
          if (clientBinaryFraming.get(client)) {
            binaryOutboundFrames++
            client.send(encodeBinaryFrameJson(json), { binary: true })
          } else {
            client.send(json)
          }
        }
      }
      options.onTransportMetrics?.({
        deferredSends,
        coalescedPatchDelta,
        binaryOutboundFrames,
      })
      return true
    } catch (err) {
      if (options.onError) {
        options.onError(err)
      } else {
        console.error('Geometra server error:', err)
      }
      // Send error to clients
      const errorMsg: ServerMessage = { type: 'error', message: String(err), ...NATIVE_PROTOCOL_METADATA }
      const data = JSON.stringify(errorMsg)
      for (const client of clients) {
        if (client.readyState === client.OPEN) {
          client.send(data)
        }
      }
      return false
    }
  }

  const wss =
    options.httpServer != null
      ? new WebSocketServer({ noServer: true })
      : new WebSocketServer({ port })

  let upgradeHandler:
    | ((request: IncomingMessage, socket: Duplex, head: Buffer) => void)
    | null = null

  if (options.httpServer != null) {
    upgradeHandler = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
      if (!upgradePathMatches(request, wsPathNormalized)) {
        return
      }
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request)
      })
    }
    options.httpServer.on('upgrade', upgradeHandler)
  }

  function acceptConnection(ws: WebSocket): void {
    clients.add(ws)
    needsResync.delete(ws)
    clientBinaryFraming.delete(ws)

    if (prevLayout && currentTree) {
      const msg: ServerMessage = {
        type: 'frame',
        layout: prevLayout,
        tree: currentTree,
        ...NATIVE_PROTOCOL_METADATA,
      }
      const json = JSON.stringify(msg)
      if (clientBinaryFraming.get(ws)) {
        ws.send(encodeBinaryFrameJson(json), { binary: true })
      } else {
        ws.send(json)
      }
    } else {
      computeAndBroadcast()
    }

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(String(raw)) as ClientMessage
        const requestId = messageRequestId(msg)
        const sendAck = () => {
          if (!requestId) return
          const ack: ServerMessage = {
            type: 'ack',
            requestId,
            ...NATIVE_PROTOCOL_METADATA,
          }
          ws.send(JSON.stringify(ack))
        }
        const sendError = (message: string, code?: number) => {
          const errorMsg: ServerMessage = {
            type: 'error',
            message,
            ...(code !== undefined ? { code } : {}),
            ...(requestId ? { requestId } : {}),
            ...NATIVE_PROTOCOL_METADATA,
          }
          ws.send(JSON.stringify(errorMsg))
        }
        const nativeInputMessage = msg.type === 'event' || msg.type === 'key' ||
          msg.type === 'composition' || msg.type === 'resize'
        // @geometra/mcp@1.64.0 accidentally put proxy-action v2 in the legacy
        // geometry field. Accept that one known envelope for native inputs so
        // upgrading either side repairs the released incompatibility.
        const legacyConflatedProxyVersion = msg.geometryProtocolVersion === undefined &&
          msg.proxyActionProtocolVersion === undefined &&
          msg.protocolVersion === 2 &&
          nativeInputMessage
        const clientGeometryProtocolVersion = legacyConflatedProxyVersion
          ? PROTOCOL_VERSION
          : msg.geometryProtocolVersion ?? msg.protocolVersion
        if (!isProtocolCompatible(clientGeometryProtocolVersion, PROTOCOL_VERSION)) {
          sendError(`Client geometry protocol ${clientGeometryProtocolVersion} is newer than server geometry protocol ${PROTOCOL_VERSION}`)
          return
        }
        if (options.onMessage) {
          const ctx = contexts.get(ws)
          if (!options.onMessage(msg, ctx)) {
            sendError('Forbidden', CLOSE_FORBIDDEN)
            return
          }
        }
        if (msg.type === 'event') {
          if (!currentTree || !prevLayout) {
            sendError('Cannot dispatch pointer events before the initial layout is ready')
            return
          }
          if (!clientPointerXYAreFinite(msg.x, msg.y)) {
            sendError('Pointer event coordinates must be finite numbers')
            return
          }
          dispatchHit(
            currentTree,
            prevLayout,
            msg.eventType as keyof EventHandlers,
            msg.x,
            msg.y,
          )
          if (computeAndBroadcast()) sendAck()
        } else if (msg.type === 'key') {
          if (!currentTree || !prevLayout) {
            sendError('Cannot dispatch keyboard events before the initial layout is ready')
            return
          }
          dispatchKeyboardEvent(currentTree, prevLayout, msg.eventType, {
            key: msg.key,
            code: msg.code,
            shiftKey: msg.shiftKey,
            ctrlKey: msg.ctrlKey,
            metaKey: msg.metaKey,
            altKey: msg.altKey,
          })
          if (computeAndBroadcast()) sendAck()
        } else if (msg.type === 'composition') {
          if (!currentTree || !prevLayout) {
            sendError('Cannot dispatch composition events before the initial layout is ready')
            return
          }
          dispatchCompositionEvent(currentTree, prevLayout, msg.eventType, {
            data: msg.data,
          })
          if (computeAndBroadcast()) sendAck()
        } else if (msg.type === 'resize') {
          if (msg.capabilities?.binaryFraming) {
            clientBinaryFraming.set(ws, true)
          }
          width = Math.max(1, msg.width)
          if (!autoHeight) {
            height = Math.max(1, msg.height)
          }
          prevLayout = null
          if (computeAndBroadcast()) sendAck()
        } else if (
          msg.type === 'file' ||
          msg.type === 'setFieldText' ||
          msg.type === 'setFieldChoice' ||
          msg.type === 'fillFields' ||
          msg.type === 'selectOption' ||
          msg.type === 'setChecked' ||
          msg.type === 'listboxPick' ||
          msg.type === 'wheel'
        ) {
          sendError(
            `Client message type "${msg.type}" is not supported on the native Textura server (DOM-free layout). Use @geometra/proxy for DOM automation (files, labeled form fills, listbox, select, checkbox/radio controls, wheel).`,
          )
        } else {
          sendError(`Unsupported client message type "${String((msg as { type?: unknown }).type ?? 'unknown')}"`)
        }
      } catch {
        // Ignore malformed messages
      }
    })

    ws.on('close', () => {
      const ctx = contexts.get(ws)
      clients.delete(ws)
      needsResync.delete(ws)
      clientBinaryFraming.delete(ws)
      contexts.delete(ws)
      if (options.onDisconnect && ctx !== undefined) {
        options.onDisconnect(ctx)
      }
    })
  }

  wss.on('connection', (ws, request) => {
    if (options.onConnection) {
      Promise.resolve()
        .then(() => options.onConnection!(request))
        .then((ctx) => {
          if (ctx == null) {
            ws.close(CLOSE_AUTH_FAILED, 'Authentication failed')
            return
          }
          contexts.set(ws, ctx)
          acceptConnection(ws)
        })
        .catch(() => {
          ws.close(CLOSE_AUTH_FAILED, 'Authentication failed')
        })
    } else {
      acceptConnection(ws)
    }
  })

  function broadcastData(channel: string, payload: unknown): void {
    if (typeof channel !== 'string' || channel.trim() === '') {
      options.onError?.(new Error('broadcastData: channel must be a non-empty string'))
      return
    }
    try {
      JSON.stringify(payload)
    } catch (err) {
      options.onError?.(err)
      return
    }
    const dataMsg: ServerDataMessage = {
      type: 'data',
      channel,
      payload,
      ...NATIVE_PROTOCOL_METADATA,
    }
    const json = JSON.stringify(dataMsg)
    for (const client of clients) {
      if (client.readyState === client.OPEN) {
        if (shouldDeferClientSend(client.bufferedAmount, backpressureBytes)) {
          continue
        }
        if (clientBinaryFraming.get(client)) {
          client.send(encodeBinaryFrameJson(json), { binary: true })
        } else {
          client.send(json)
        }
      }
    }
  }

  // Initial render
  computeAndBroadcast()

  return {
    update() {
      computeAndBroadcast()
    },
    broadcastData,
    close() {
      if (options.httpServer != null && upgradeHandler != null) {
        options.httpServer.off('upgrade', upgradeHandler)
        upgradeHandler = null
      }
      wss.close()
      clients.clear()
      needsResync.clear()
      clientBinaryFraming.clear()
      contexts.clear()
    },
  }
}
