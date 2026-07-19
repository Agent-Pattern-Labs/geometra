import { randomBytes, timingSafeEqual } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import type { Page } from 'playwright'
import { WebSocketServer, type WebSocket } from 'ws'
import {
  attachFiles,
  clearFillLookupCache,
  createFillLookupCache,
  delay,
  fillFields,
  fillOtp,
  pickListboxOption,
  resolveExistingFiles,
  setFieldChoice,
  setFieldText,
  selectNativeOption,
  setCheckedControl,
  wheelAt,
} from './dom-actions.js'
import { createCdpAxSessionManager } from './a11y-enrich.js'
import { coalescePatches, diffLayout } from './diff-layout.js'
import { extractGeometry, type ExtractGeometryTrace } from './extractor.js'
import type { ClientKeyMessage, GeometrySnapshot, LayoutSnapshot, ParsedClientMessage } from './types.js'
import {
  clientMessageValidationError,
  isClickEventMessage,
  isCompositionMessage,
  isFillFieldsMessage,
  isFillOtpMessage,
  isFileMessage,
  isKeyMessage,
  isListboxPickMessage,
  isNavigateMessage,
  isResizeMessage,
  isPdfGenerateMessage,
  isScreenshotMessage,
  isSetFieldChoiceMessage,
  isSetFieldTextMessage,
  isSetCheckedMessage,
  isSelectOptionMessage,
  isWheelMessage,
  GEOMETRY_PROTOCOL_VERSION,
  PROXY_ACTION_PROTOCOL_VERSION,
  PROXY_PROTOCOL_VERSION,
} from './types.js'

const DOM_OBSERVER_BINDINGS = new WeakSet<Page>()
const DEFAULT_PROXY_HOST = '127.0.0.1'
const DEFAULT_MAX_PAYLOAD_BYTES = 4 * 1024 * 1024
const PROXY_PROTOCOL_CAPABILITIES = {
  transport: 'proxy',
  authenticatedController: true,
  requestScopedAcks: true,
  proxyActions: true,
  exactFieldIdentity: true,
} as const
const PROXY_GEOMETRY_METADATA = {
  protocolVersion: GEOMETRY_PROTOCOL_VERSION,
  geometryProtocolVersion: GEOMETRY_PROTOCOL_VERSION,
  proxyActionProtocolVersion: PROXY_ACTION_PROTOCOL_VERSION,
  protocolCapabilities: PROXY_PROTOCOL_CAPABILITIES,
} as const
const PROXY_ACTION_METADATA = {
  // Keep the legacy field at v2 so @geometra/mcp@1.64.x clients installed
  // through their caret proxy dependency continue to accept exact-field acks.
  protocolVersion: PROXY_PROTOCOL_VERSION,
  geometryProtocolVersion: GEOMETRY_PROTOCOL_VERSION,
  proxyActionProtocolVersion: PROXY_ACTION_PROTOCOL_VERSION,
  protocolCapabilities: PROXY_PROTOCOL_CAPABILITIES,
} as const

async function bindDomObserverBridge(page: Page, scheduleExtract: () => void): Promise<void> {
  if (DOM_OBSERVER_BINDINGS.has(page)) return
  await page.exposeFunction('__geometraProxyNotify', () => {
    scheduleExtract()
  })
  await page.addInitScript(() => {
    const w = window as unknown as {
      __geometraProxyNotify?: () => Promise<void>
      __geometraProxyObserverBootstrapped?: boolean
      __geometraProxyObserverInstalled?: boolean
    }
    if (w.__geometraProxyObserverBootstrapped) return

    const install = () => {
      if (w.__geometraProxyObserverInstalled) return
      const root = document.documentElement
      if (!root) return
      const observer = new MutationObserver(() => {
        void w.__geometraProxyNotify?.()
      })
      observer.observe(root, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true,
      })
      w.__geometraProxyObserverInstalled = true
    }

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', install, { once: true })
    } else {
      install()
    }

    w.__geometraProxyObserverBootstrapped = true
  })
  DOM_OBSERVER_BINDINGS.add(page)
}

interface PendingInputAck {
  ws: WebSocket
  requestId?: string
  result?: unknown
  /**
   * Extraction sequence that was already in flight (or most recently
   * completed) when the action finished. The ack must wait for a strictly
   * newer extraction so callers never treat a pre-action snapshot as fresh.
   */
  afterExtractSequence: number
}

function isProtocolCompatible(peerVersion: number | undefined): boolean {
  if (peerVersion === undefined) return true
  if (typeof peerVersion !== 'number' || !Number.isFinite(peerVersion)) return false
  return peerVersion <= PROXY_PROTOCOL_VERSION
}

function generatedAuthToken(): string {
  return randomBytes(32).toString('base64url')
}

function normalizedAuthToken(value: string | undefined): string {
  const token = value?.trim() || generatedAuthToken()
  if (token.length < 32) {
    throw new Error('geometra-proxy authToken must contain at least 32 characters')
  }
  return token
}

function bearerTokenMatches(header: string | undefined, expected: string): boolean {
  if (!header?.startsWith('Bearer ')) return false
  const received = header.slice('Bearer '.length)
  const receivedBytes = Buffer.from(received)
  const expectedBytes = Buffer.from(expected)
  return receivedBytes.length === expectedBytes.length && timingSafeEqual(receivedBytes, expectedBytes)
}

function protocolCompatibilityError(msg: ParsedClientMessage): string | null {
  const record = msg as {
    protocolVersion?: unknown
    geometryProtocolVersion?: unknown
    proxyActionProtocolVersion?: unknown
  }
  const geometryVersion = record.geometryProtocolVersion
  if (geometryVersion !== undefined && (
    typeof geometryVersion !== 'number' ||
    !Number.isFinite(geometryVersion) ||
    geometryVersion > GEOMETRY_PROTOCOL_VERSION
  )) {
    return `Client geometry protocol ${String(geometryVersion)} is newer than proxy geometry protocol ${GEOMETRY_PROTOCOL_VERSION}`
  }
  const actionVersion = record.proxyActionProtocolVersion ?? record.protocolVersion
  if (!isProtocolCompatible(actionVersion as number | undefined)) {
    return `Client proxy-action protocol ${String(actionVersion)} is newer than proxy action protocol ${PROXY_ACTION_PROTOCOL_VERSION}`
  }
  return null
}

function cloneLayout(layout: LayoutSnapshot): LayoutSnapshot {
  return structuredClone(layout)
}

function normalizePlaywrightKey(key: string): string {
  if (key === ' ') return 'Space'
  return key
}

async function applyKeyPhase(page: Page, msg: ClientKeyMessage): Promise<void> {
  if (msg.eventType !== 'onKeyDown' && msg.eventType !== 'onKeyUp') return
  const k = normalizePlaywrightKey(msg.key)
  /**
   * `geometra_key` sends a single `onKeyDown` with `code === key` (e.g. Enter).
   * `geometra_type` sends `onKeyDown` / `onKeyUp` pairs with `code` like `KeyA` and `key` like `a`.
   */
  const singleShotSpecial = msg.code === msg.key

  if (msg.eventType === 'onKeyDown') {
    if (msg.shiftKey) await page.keyboard.down('Shift')
    if (msg.ctrlKey) await page.keyboard.down('Control')
    if (msg.metaKey) await page.keyboard.down('Meta')
    if (msg.altKey) await page.keyboard.down('Alt')
    if (singleShotSpecial) {
      await page.keyboard.press(k)
      if (msg.altKey) await page.keyboard.up('Alt')
      if (msg.metaKey) await page.keyboard.up('Meta')
      if (msg.ctrlKey) await page.keyboard.up('Control')
      if (msg.shiftKey) await page.keyboard.up('Shift')
    } else {
      await page.keyboard.down(k)
    }
    return
  }

  if (singleShotSpecial) {
    return
  }
  await page.keyboard.up(k)
  if (msg.altKey) await page.keyboard.up('Alt')
  if (msg.metaKey) await page.keyboard.up('Meta')
  if (msg.ctrlKey) await page.keyboard.up('Control')
  if (msg.shiftKey) await page.keyboard.up('Shift')
}

export async function handleClientMessage(
  waitForPage: () => Promise<Page>,
  ws: WebSocket,
  raw: unknown,
  fieldLookupCache: ReturnType<typeof createFillLookupCache>,
  waitForBeforeInput: () => Promise<void>,
  onViewportOrInput: (kind: 'resize' | 'input', requestId?: string, result?: unknown) => void,
  onHandlerError: (err: unknown) => void,
  security?: { allowedFileRoots?: string[] },
): Promise<void> {
  const sendWireError = (message: string, requestId?: string) => {
    ws.send(JSON.stringify({
      type: 'error',
      message,
      ...(requestId ? { requestId } : {}),
      ...PROXY_ACTION_METADATA,
    }))
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(String(raw)) as unknown
  } catch {
    sendWireError('Invalid client message: expected valid JSON')
    return
  }
  const requestId = typeof parsed === 'object' && parsed !== null &&
    typeof (parsed as { requestId?: unknown }).requestId === 'string'
    ? (parsed as { requestId: string }).requestId
    : undefined
  if (typeof parsed !== 'object' || parsed === null || typeof (parsed as { type?: unknown }).type !== 'string') {
    sendWireError('Invalid client message: expected an object with a string type', requestId)
    return
  }
  const msg = parsed as ParsedClientMessage
  const compatibilityError = protocolCompatibilityError(msg)
  if (compatibilityError) {
    sendWireError(compatibilityError, requestId)
    return
  }

  const validationError = clientMessageValidationError(msg)
  if (validationError) {
    sendWireError(validationError, requestId)
    return
  }

  try {
    const page = await waitForPage()
    if (isResizeMessage(msg)) {
      const w = Math.max(1, Math.floor(msg.width))
      const h = Math.max(1, Math.floor(msg.height))
      await page.setViewportSize({ width: w, height: h })
      onViewportOrInput('resize', requestId)
      return
    }

    await waitForBeforeInput()

    if (isNavigateMessage(msg)) {
      clearFillLookupCache(fieldLookupCache)
      await page.goto(msg.url, { waitUntil: 'domcontentloaded', timeout: 60_000 })
      onViewportOrInput('input', requestId, { pageUrl: page.url() })
      return
    }

    if (isClickEventMessage(msg)) {
      const x = msg.x
      const y = msg.y
      if (typeof x === 'number' && typeof y === 'number' && Number.isFinite(x) && Number.isFinite(y)) {
        // Capture the URL before clicking so we can detect submit-triggered
        // navigation. When a click submits a form that POSTs to a thank-you
        // page, the proxy session would otherwise die without telling the
        // caller WHY — the next geometra_query would return session_not_found
        // and the caller couldn't distinguish "successful submit + nav" from
        // "session crashed for unknown reason". Bug surfaced by JobForge
        // round-2 marathon — Cloudflare FDE NYC #312 and Airtable PM AI #94.
        const urlBefore = page.url()
        await page.mouse.click(x, y)
        // Give the navigation a brief window to start. We don't await
        // waitForNavigation here because most clicks DON'T navigate, and
        // adding a 30s wait to every click would tank latency. A short
        // settle window is enough to let synchronous SPA route changes and
        // doc-loaded navigations register on page.url().
        await delay(120)
        let urlAfter = urlBefore
        try {
          urlAfter = page.url()
        } catch {
          // A disappeared page may have navigated, crashed, or been closed.
          // Do not promote that ambiguity to a successful submission.
          onViewportOrInput('input', requestId, { pageUnavailable: true, urlBefore })
          return
        }
        if (urlAfter !== urlBefore) {
          // Navigation happened. Report the new URL so callers (especially
          // form-submit flows) know the click was a successful submit even
          // if the proxy session goes down on the next request.
          onViewportOrInput('input', requestId, { navigated: true, pageUrl: urlAfter, urlBefore })
        } else {
          onViewportOrInput('input', requestId)
        }
      }
      return
    }

    if (isKeyMessage(msg)) {
      await applyKeyPhase(page, msg)
      onViewportOrInput('input', requestId)
      return
    }

    if (isCompositionMessage(msg)) {
      const data = typeof msg.data === 'string' ? msg.data : ''
      if (msg.eventType === 'onCompositionUpdate' || msg.eventType === 'onCompositionEnd') {
        await page.keyboard.insertText(data)
        onViewportOrInput('input', requestId)
      }
      return
    }

    if (isFileMessage(msg)) {
      const paths = resolveExistingFiles(msg.paths, security?.allowedFileRoots)
      await attachFiles(page, paths, {
        clickX: msg.x,
        clickY: msg.y,
        fieldId: msg.fieldId,
        fieldKey: msg.fieldKey,
        fieldLabel: msg.fieldLabel,
        contextText: msg.contextText,
        sectionText: msg.sectionText,
        exact: msg.exact,
        strategy: msg.strategy,
        dropX: msg.dropX,
        dropY: msg.dropY,
      })
      onViewportOrInput('input', requestId)
      return
    }

    if (isSetFieldTextMessage(msg)) {
      await setFieldText(page, msg.fieldLabel, msg.value, {
        fieldId: msg.fieldId,
        fieldKey: msg.fieldKey,
        exact: msg.exact,
        cache: fieldLookupCache,
        typingDelayMs: msg.typingDelayMs,
        imeFriendly: msg.imeFriendly,
      })
      onViewportOrInput('input', requestId)
      return
    }

    if (isSetFieldChoiceMessage(msg)) {
      await setFieldChoice(page, msg.fieldLabel, msg.value, {
        fieldId: msg.fieldId,
        fieldKey: msg.fieldKey,
        exact: msg.exact,
        optionIndex: msg.optionIndex,
        query: msg.query,
        choiceType: msg.choiceType,
        cache: fieldLookupCache,
      })
      onViewportOrInput('input', requestId)
      return
    }

    if (isFillFieldsMessage(msg)) {
      const authorizedFields = msg.fields.map(field => field.kind === 'file'
        ? { ...field, paths: resolveExistingFiles(field.paths, security?.allowedFileRoots) }
        : field)
      await fillFields(page, authorizedFields, fieldLookupCache)
      const result = await fillFieldsAckResult(page)
      onViewportOrInput('input', requestId, result)
      return
    }

    if (isFillOtpMessage(msg)) {
      const result = await fillOtp(page, msg.value, {
        fieldLabel: msg.fieldLabel,
        perCharDelayMs: msg.perCharDelayMs,
      })
      onViewportOrInput('input', requestId, {
        ok: true,
        cellCount: result.cellCount,
        filledCount: result.filledCount,
      })
      return
    }

    if (isListboxPickMessage(msg)) {
      await pickListboxOption(page, msg.label, {
        exact: msg.exact,
        openX: msg.openX,
        openY: msg.openY,
        fieldId: msg.fieldId,
        fieldKey: msg.fieldKey,
        fieldLabel: msg.fieldLabel,
        query: msg.query,
        cache: fieldLookupCache,
      })
      onViewportOrInput('input', requestId)
      return
    }

    if (isSelectOptionMessage(msg)) {
      await selectNativeOption(page, msg.x, msg.y, {
        value: msg.value,
        label: msg.label,
        index: msg.index,
      })
      onViewportOrInput('input', requestId)
      return
    }

    if (isSetCheckedMessage(msg)) {
      await setCheckedControl(page, msg.label, {
        fieldKey: msg.fieldKey,
        checked: msg.checked,
        exact: msg.exact,
        controlType: msg.controlType,
        contextText: msg.contextText,
        sectionText: msg.sectionText,
      })
      onViewportOrInput('input', requestId)
      return
    }

    if (isWheelMessage(msg)) {
      const dx = typeof msg.deltaX === 'number' && Number.isFinite(msg.deltaX) ? msg.deltaX : 0
      const dy = typeof msg.deltaY === 'number' && Number.isFinite(msg.deltaY) ? msg.deltaY : 0
      const x = typeof msg.x === 'number' && Number.isFinite(msg.x) ? msg.x : undefined
      const y = typeof msg.y === 'number' && Number.isFinite(msg.y) ? msg.y : undefined
      await wheelAt(page, dx, dy, x, y)
      onViewportOrInput('input', requestId)
      return
    }

    if (isScreenshotMessage(msg)) {
      const buffer = await page.screenshot({ type: 'png', fullPage: false })
      const base64 = buffer.toString('base64')
      onViewportOrInput('input', requestId, { screenshot: base64 })
      return
    }

    if (isPdfGenerateMessage(msg)) {
      const format = (msg.format ?? 'A4').toLowerCase() as 'a4' | 'letter'
      const landscape = msg.landscape ?? false
      const printBackground = msg.printBackground ?? true
      const marginValue = msg.margin ?? '1cm'
      const margin = { top: marginValue, right: marginValue, bottom: marginValue, left: marginValue }

      if (msg.html) {
        await page.setContent(msg.html, { waitUntil: 'networkidle', timeout: 30_000 })
      }

      const buffer = await page.pdf({
        format,
        landscape,
        printBackground,
        margin,
      })
      const base64 = buffer.toString('base64')
      onViewportOrInput('input', requestId, { pdf: base64, pageUrl: page.url() })
      return
    }

    sendWireError(`Unsupported client message type "${msg.type}"`, requestId)
  } catch (err) {
    onHandlerError(err)
    sendWireError(err instanceof Error ? err.message : String(err), requestId)
  }
}

async function fillFieldsAckResult(page: Page): Promise<Record<string, unknown>> {
  const frames = page.frames()
  // `:invalid` only matches native HTML5 validity errors. It misses custom
  // ARIA listboxes / comboboxes (react-select, Radix Select, Headless UI,
  // Downshift, Ashby/Lever/Greenhouse/Workday form libraries) that advertise
  // their invalid state via `aria-invalid="true"` on a <div role="combobox">
  // or similar. Counting both gives fill_form a reliable signal for whether
  // a custom dropdown commit actually landed, which is the authoritative
  // check used throughout the listbox pick pipeline (see readAriaInvalid in
  // dom-actions.ts). The `:is()` selector de-duplicates the two passes so
  // elements that match both just count once.
  const invalidSelector = ':is(:invalid, [aria-invalid="true"]:is(input, textarea, select, [role="combobox"], [role="listbox"], [role="spinbutton"], [role="searchbox"], [role="textbox"]))'
  const [invalidCount, alertCount, dialogCount, busyCount] = await Promise.all([
    countAcrossFrames(frames, invalidSelector),
    countAcrossFrames(frames, '[role="alert"], [role="alertdialog"]'),
    countAcrossFrames(frames, '[role="dialog"], [role="alertdialog"]'),
    countAcrossFrames(frames, '[aria-busy="true"]'),
  ])

  let invalidFields: Array<{ name?: string; error?: string }> | undefined
  if (invalidCount > 0) {
    invalidFields = await collectInvalidFieldErrors(frames)
  }

  return {
    pageUrl: page.url(),
    invalidCount,
    alertCount,
    dialogCount,
    busyCount,
    ...(invalidFields && invalidFields.length > 0 ? { invalidFields } : {}),
  }
}

async function collectInvalidFieldErrors(
  frames: ReturnType<Page['frames']>,
): Promise<Array<{ name?: string; error?: string }>> {
  const results = await Promise.all(
    frames.map(frame =>
      frame.evaluate(() => {
        const fields: Array<{ name?: string; error?: string }> = []
        const seen = new Set<Element>()

        const describeNative = (el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement): { name?: string; error?: string } => {
          const label =
            el.getAttribute('aria-label')?.trim() ||
            (el.labels && el.labels.length > 0 ? el.labels[0]?.textContent?.trim() : undefined) ||
            el.getAttribute('placeholder')?.trim() ||
            el.name ||
            undefined
          const errorId = el.getAttribute('aria-errormessage') || el.getAttribute('aria-describedby')
          const errorEl = errorId ? document.getElementById(errorId.split(/\s+/)[0]!) : null
          const error =
            errorEl?.textContent?.trim() ||
            el.validationMessage ||
            undefined
          return { ...(label ? { name: label } : {}), ...(error ? { error } : {}) }
        }

        const describeAria = (el: Element): { name?: string; error?: string } => {
          // Try ARIA name computation, then labelled-by, then nearest <label for>
          const ariaLabel = el.getAttribute('aria-label')?.trim()
          let name = ariaLabel || undefined
          if (!name) {
            const labelledBy = el.getAttribute('aria-labelledby')
            if (labelledBy) {
              const parts = labelledBy.split(/\s+/).map(id => document.getElementById(id)?.textContent?.trim() ?? '').filter(Boolean)
              if (parts.length > 0) name = parts.join(' ')
            }
          }
          if (!name && el.id) {
            const lbl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`)
            name = lbl?.textContent?.trim() || undefined
          }
          const errorId = el.getAttribute('aria-errormessage') || el.getAttribute('aria-describedby')
          const errorEl = errorId ? document.getElementById(errorId.split(/\s+/)[0]!) : null
          const error = errorEl?.textContent?.trim() || undefined
          return { ...(name ? { name } : {}), ...(error ? { error } : {}) }
        }

        // Native HTML5 validity
        const nativeInvalid = document.querySelectorAll(':invalid')
        for (const el of nativeInvalid) {
          if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement)) continue
          if (seen.has(el)) continue
          seen.add(el)
          const row = describeNative(el)
          if (row.name || row.error) fields.push(row)
          if (fields.length >= 10) return fields
        }

        // ARIA-declared invalid (react-select, Radix, Headless UI, Downshift,
        // etc.). Restrict to recognised form-control roles so ambient
        // aria-invalid on irrelevant elements doesn't pollute the list.
        const ariaInvalid = document.querySelectorAll(
          '[aria-invalid="true"]:is(input, textarea, select, [role="combobox"], [role="listbox"], [role="spinbutton"], [role="searchbox"], [role="textbox"])',
        )
        for (const el of ariaInvalid) {
          if (seen.has(el)) continue
          seen.add(el)
          const row =
            el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement
              ? describeNative(el)
              : describeAria(el)
          if (row.name || row.error) fields.push(row)
          if (fields.length >= 10) return fields
        }

        return fields
      }).catch(() => [] as Array<{ name?: string; error?: string }>),
    ),
  )
  return results.flat().slice(0, 10)
}

async function countAcrossFrames(frames: ReturnType<Page['frames']>, selector: string): Promise<number> {
  const counts = await Promise.all(
    frames.map(frame => frame.locator(selector).count().catch(() => 0)),
  )
  return counts.reduce((sum, count) => sum + count, 0)
}

export interface GeometryWsHub {
  /** Secret bearer capability required by every WebSocket controller. */
  authToken: string
  /** Actual bind host (loopback by default). */
  host: string
  /** Run extraction and broadcast (debounced observer calls this). */
  scheduleExtract: () => void
  /** Wait until any in-flight extract + broadcast finishes. */
  flushExtract: () => Promise<void>
  getTrace: () => GeometryWsTrace
  close: () => Promise<void>
}

export interface GeometryExtractRecoveryTrace {
  attemptCount: number
  domContentLoadedWaitMs: number
  loadWaitMs: number
}

export interface GeometryFirstExtractTrace {
  beforeInputMs: number
  extractMs: number
  broadcastMs: number
  totalMs: number
  changed: boolean
  extractor: ExtractGeometryTrace
  recovery: GeometryExtractRecoveryTrace
}

export interface GeometryWsTrace {
  extractCount: number
  firstExtract?: GeometryFirstExtractTrace
}

export function startGeometryWebSocket(options: {
  port: number
  /** Bind address. Defaults to IPv4 loopback; remote exposure must be explicit. */
  host?: string
  /** Bearer capability. A random 256-bit token is generated when omitted. */
  authToken?: string
  /** Browser Origin values allowed to initiate a controller connection. Default: none. */
  allowedOrigins?: string[]
  /** Canonical filesystem roots from which uploads may be read. Default: uploads disabled. */
  allowedFileRoots?: string[]
  /** Maximum inbound WebSocket message size. Default: 4 MiB. */
  maxPayloadBytes?: number
  page: Page | Promise<Page>
  /** DOM mutation debounce (ms). */
  debounceMs?: number
  /** Optional promise that must resolve before extracts or input actions run. */
  beforeInput?: Promise<unknown>
  onListening?: (port: number) => void
  onError?: (err: unknown) => void
}): GeometryWsHub {
  const debounceMs = options.debounceMs ?? 50
  const host = options.host?.trim() || DEFAULT_PROXY_HOST
  const authToken = normalizedAuthToken(options.authToken)
  const allowedOrigins = new Set(options.allowedOrigins ?? [])
  const clients = new Set<WebSocket>()
  let controllerClaimed = false
  const wss = new WebSocketServer({
    port: options.port,
    host,
    maxPayload: Math.max(1024, options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES),
    verifyClient(info, done) {
      const origin = typeof info.req.headers.origin === 'string' ? info.req.headers.origin : undefined
      if (origin !== undefined && !allowedOrigins.has(origin)) {
        done(false, 403, 'WebSocket Origin is not allowed')
        return
      }
      const authorization = typeof info.req.headers.authorization === 'string'
        ? info.req.headers.authorization
        : undefined
      if (!bearerTokenMatches(authorization, authToken)) {
        done(false, 401, 'Bearer capability required')
        return
      }
      const liveController = Array.from(clients).some(client =>
        client.readyState === client.OPEN || client.readyState === client.CONNECTING,
      )
      // Permit a clean handover while the prior controller is already
      // CLOSING; reject both a live controller and a concurrent handshake.
      if (controllerClaimed && (clients.size === 0 || liveController)) {
        done(false, 409, 'A Geometra controller is already connected')
        return
      }
      controllerClaimed = true
      done(true)
    },
  })
  const axSessionManager = createCdpAxSessionManager()

  let prevLayout: LayoutSnapshot | null = null
  let prevTreeJson: string | null = null

  let debounceTimer: ReturnType<typeof setTimeout> | null = null
  let extracting = false
  let pendingExtract = false
  let extractSequence = 0
  let completedExtractSequence = 0
  let actionQueue: Promise<void> = Promise.resolve()
  let pendingInputAcks: PendingInputAck[] = []
  const fieldLookupCache = createFillLookupCache()
  const beforeInput = options.beforeInput?.then(() => undefined)
  const trace: GeometryWsTrace = { extractCount: 0 }
  const pagePromise = Promise.resolve(options.page)

  async function waitForBeforeInput(): Promise<void> {
    if (!beforeInput) return
    await beforeInput
  }

  async function waitForPage(): Promise<Page> {
    return await pagePromise
  }

  void pagePromise.then(page => {
    page.on('framenavigated', frame => {
      if (frame === page.mainFrame()) {
        clearFillLookupCache(fieldLookupCache)
      }
    })
  }).catch(err => options.onError?.(err))

  function sendPendingInputAcks() {
    if (pendingInputAcks.length === 0) return
    const pending = pendingInputAcks.filter(entry => completedExtractSequence > entry.afterExtractSequence)
    if (pending.length === 0) return
    const ready = new Set(pending)
    pendingInputAcks = pendingInputAcks.filter(entry => !ready.has(entry))
    for (const { ws, requestId, result } of pending) {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({
          type: 'ack',
          ...(requestId ? { requestId } : {}),
          ...(result !== undefined ? { result } : {}),
          ...PROXY_ACTION_METADATA,
        }))
      }
    }
  }

  function sendPendingInputErrors(message: string) {
    if (pendingInputAcks.length === 0) {
      const errText = JSON.stringify({ type: 'error', message, ...PROXY_ACTION_METADATA })
      for (const ws of clients) {
        if (ws.readyState === ws.OPEN) ws.send(errText)
      }
      return
    }

    const pending = pendingInputAcks
    pendingInputAcks = []
    for (const { ws, requestId } of pending) {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({
          type: 'error',
          message,
          ...(requestId ? { requestId } : {}),
          ...PROXY_ACTION_METADATA,
        }))
      }
    }
  }

  function broadcastSnapshot(snap: GeometrySnapshot): boolean {
    const treeChanged = prevTreeJson !== snap.treeJson

    let outbound:
      | ({ type: 'frame'; layout: LayoutSnapshot; tree: GeometrySnapshot['tree'] } & typeof PROXY_GEOMETRY_METADATA)
      | ({ type: 'patch'; patches: ReturnType<typeof diffLayout> } & typeof PROXY_GEOMETRY_METADATA)

    if (!prevLayout || treeChanged) {
      outbound = {
        type: 'frame',
        layout: snap.layout,
        tree: snap.tree,
        ...PROXY_GEOMETRY_METADATA,
      }
      prevLayout = cloneLayout(snap.layout)
      prevTreeJson = snap.treeJson
    } else {
      const rawPatches = diffLayout(prevLayout, snap.layout)
      const patches = coalescePatches(rawPatches)
      if (patches.length === 0) {
        return false
      }
      if (patches.length > 20) {
        outbound = {
          type: 'frame',
          layout: snap.layout,
          tree: snap.tree,
          ...PROXY_GEOMETRY_METADATA,
        }
      } else {
        outbound = { type: 'patch', patches, ...PROXY_GEOMETRY_METADATA }
      }
      prevLayout = cloneLayout(snap.layout)
      prevTreeJson = snap.treeJson
    }

    const text = JSON.stringify(outbound)
    for (const ws of clients) {
      if (ws.readyState === ws.OPEN) {
        ws.send(text)
      }
    }
    return true
  }

  async function runExtract(): Promise<boolean> {
    const sequence = ++extractSequence
    const runStartedAt = performance.now()
    const beforeInputStartedAt = performance.now()
    try {
      await waitForBeforeInput()
      const beforeInputMs = performance.now() - beforeInputStartedAt
      const extractorTrace: ExtractGeometryTrace = {}
      const recoveryTrace: GeometryExtractRecoveryTrace = {
        attemptCount: 0,
        domContentLoadedWaitMs: 0,
        loadWaitMs: 0,
      }
      const page = await waitForPage()
      const extractStartedAt = performance.now()
      const snap = await extractGeometryWithRecovery(page, axSessionManager, extractorTrace, recoveryTrace)
      const extractMs = performance.now() - extractStartedAt
      const broadcastStartedAt = performance.now()
      const changed = broadcastSnapshot(snap)
      completedExtractSequence = sequence
      // An input ack only proves freshness after an extraction that started
      // after the action completed. Release eligible acks immediately after
      // that snapshot instead of waiting for the entire trailing-edge
      // mutation drain, which can be indefinitely extended by animated or
      // highly reactive controls such as react-select.
      sendPendingInputAcks()
      const broadcastMs = performance.now() - broadcastStartedAt
      trace.extractCount += 1
      if (!trace.firstExtract) {
        trace.firstExtract = {
          beforeInputMs,
          extractMs,
          broadcastMs,
          totalMs: performance.now() - runStartedAt,
          changed,
          extractor: { ...extractorTrace },
          recovery: { ...recoveryTrace },
        }
      }
      return changed
    } catch (err) {
      options.onError?.(err)
      sendPendingInputErrors(err instanceof Error ? err.message : String(err))
      return false
    }
  }

  async function runExtractQueued(): Promise<boolean> {
    if (extracting) {
      pendingExtract = true
      return false
    }
    extracting = true
    let changed = false
    try {
      changed = (await runExtract()) || changed
      while (pendingExtract) {
        pendingExtract = false
        changed = (await runExtract()) || changed
      }
    } finally {
      extracting = false
    }
    return changed
  }

  function scheduleExtract() {
    if (debounceTimer !== null) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      debounceTimer = null
      void runExtractQueued()
        .then(() => {
          sendPendingInputAcks()
        })
        .catch(err => options.onError?.(err))
    }, debounceMs)
  }

  wss.on('listening', () => {
    const addr = wss.address()
    const p = typeof addr === 'object' && addr ? addr.port : options.port
    options.onListening?.(p)
  })

  wss.on('error', err => {
    options.onError?.(err)
  })

  wss.on('connection', (ws) => {
    clients.add(ws)
    // Authentication happens during the HTTP upgrade, but MCP still needs a
    // protocol-level attestation before it can trust a spawned proxy. Send it
    // immediately so lazy extraction can remain lazy without weakening the
    // capability handshake.
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: 'hello', ...PROXY_GEOMETRY_METADATA }))
    }
    if (prevLayout && prevTreeJson !== null) {
      const snap: GeometrySnapshot = {
        layout: prevLayout,
        tree: JSON.parse(prevTreeJson) as GeometrySnapshot['tree'],
        treeJson: prevTreeJson,
      }
      const text = JSON.stringify({
        type: 'frame',
        layout: snap.layout,
        tree: snap.tree,
        ...PROXY_GEOMETRY_METADATA,
      })
      if (ws.readyState === ws.OPEN) ws.send(text)
    }
    ws.on('message', (raw) => {
      actionQueue = actionQueue
        .then(() =>
          handleClientMessage(
            waitForPage,
            ws,
            raw,
            fieldLookupCache,
            waitForBeforeInput,
            (kind, requestId, result) => {
              if (kind === 'resize') {
                void runExtractQueued()
              } else {
                pendingInputAcks.push({
                  ws,
                  afterExtractSequence: extractSequence,
                  ...(requestId ? { requestId } : {}),
                  ...(result !== undefined ? { result } : {}),
                })
                scheduleExtract()
              }
            },
            err => options.onError?.(err),
            { allowedFileRoots: options.allowedFileRoots },
          ),
        )
        .catch(err => options.onError?.(err))
    })
    ws.on('close', () => {
      clients.delete(ws)
      controllerClaimed = clients.size > 0
      pendingInputAcks = pendingInputAcks.filter(entry => entry.ws !== ws)
    })
  })

  return {
    authToken,
    host,
    scheduleExtract,
    flushExtract: async () => {
      await actionQueue.catch(() => {})
      if (debounceTimer !== null) {
        clearTimeout(debounceTimer)
        debounceTimer = null
      }
      await runExtractQueued()
      sendPendingInputAcks()
    },
    getTrace: () => structuredClone(trace),
    close: () =>
      new Promise((resolve, reject) => {
        void axSessionManager.close().finally(() => {
          for (const ws of clients) {
            ws.close()
          }
          clients.clear()
          wss.close(err => (err ? reject(err) : resolve()))
        })
      }),
  }
}

export async function primeDomObserver(page: Page, scheduleExtract: () => void): Promise<void> {
  await bindDomObserverBridge(page, scheduleExtract)
}

export async function installDomObserver(page: Page, scheduleExtract: () => void): Promise<void> {
  await bindDomObserverBridge(page, scheduleExtract)
  await page.evaluate(() => {
    const w = window as unknown as {
      __geometraProxyNotify?: () => Promise<void>
      __geometraProxyObserverInstalled?: boolean
    }
    if (w.__geometraProxyObserverInstalled) return
    const observer = new MutationObserver(() => {
      void w.__geometraProxyNotify?.()
    })
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    })
    w.__geometraProxyObserverInstalled = true
  })
}

function isNavigationTransitionError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return /Execution context was destroyed|Cannot find context with specified id|Frame was detached|navigation/i.test(message)
}

async function extractGeometryWithRecovery(
  page: Page,
  axSessionManager: ReturnType<typeof createCdpAxSessionManager>,
  extractTrace?: ExtractGeometryTrace,
  recoveryTrace?: GeometryExtractRecoveryTrace,
): Promise<GeometrySnapshot> {
  let lastNavigationError: Error | null = null
  let domContentLoadedWaitMs = 0
  let loadWaitMs = 0

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      if (recoveryTrace) {
        recoveryTrace.attemptCount = attempt + 1
      }
      return await extractGeometry(page, { axSessionManager, trace: extractTrace })
    } catch (err) {
      if (page.isClosed() || !isNavigationTransitionError(err)) throw err
      lastNavigationError = err instanceof Error ? err : new Error(String(err))
      const domContentLoadedStartedAt = performance.now()
      await page.waitForLoadState('domcontentloaded', { timeout: 2500 }).catch(() => {})
      domContentLoadedWaitMs += performance.now() - domContentLoadedStartedAt
      const loadStartedAt = performance.now()
      await page.waitForLoadState('load', { timeout: 1000 }).catch(() => {})
      loadWaitMs += performance.now() - loadStartedAt
      if (recoveryTrace) {
        recoveryTrace.domContentLoadedWaitMs = domContentLoadedWaitMs
        recoveryTrace.loadWaitMs = loadWaitMs
      }
    }
  }

  const detail = lastNavigationError?.message ?? 'Navigation interrupted extraction'
  throw new Error(`Page navigation interrupted extraction. Wait for the next frame or retry after the new route stabilizes. ${detail}`)
}
