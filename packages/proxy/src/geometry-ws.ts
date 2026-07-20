import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
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
  isTypeTextMessage,
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
const DEFAULT_ACTION_REQUEST_LEDGER_ENTRIES = 65_536
/** A completed action must not be starved by a page that mutates forever. */
const MAX_INPUT_ACK_LATENCY_MS = 250
// The page-side bridge lives in the untrusted main world. Even if application
// code calls the exposed "settled" hook directly, it must not be able to turn
// that hint into an unbounded extraction loop on the proxy host.
const MIN_IMMEDIATE_EXTRACT_INTERVAL_MS = 250
const PROXY_PROTOCOL_CAPABILITIES = {
  transport: 'proxy',
  authenticatedController: true,
  requestScopedAcks: true,
  actionDeadlines: true,
  idempotentRequestIds: true,
  atomicTypeText: true,
  proxyActions: true,
  exactFieldIdentity: true,
  verifiedFileUploads: true,
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

/**
 * Runs in every page/frame realm before application code.
 *
 * Keep this function closure-free: Playwright serializes it for addInitScript.
 * Closed shadow roots are deliberately held in a WeakMap rather than exposed
 * through DOM attributes. The extractor consumes the same Symbol.for key in
 * its in-page evaluation.
 */
function installPageFreshnessInstrumentation(config: {
  installToken: string
  notifyBindingName: string
}): void {
  const { installToken, notifyBindingName } = config
  const CLOSED_ROOTS_KEY = Symbol.for('geometra.closedShadowRoots')
  // This key is minted in the trusted host process and injected immediately
  // before installation. A page can preseed a public Symbol.for name, but it
  // cannot predict this per-binding capability before an init script runs.
  const INSTALL_STATE_KEY = `__geometraProxyFreshnessInstalled_${installToken}`
  const global = globalThis as typeof globalThis & {
    [CLOSED_ROOTS_KEY]?: WeakMap<Element, ShadowRoot>
  }
  const globalRecord = global as unknown as Record<PropertyKey, unknown>
  if (globalRecord[INSTALL_STATE_KEY] === installToken) return

  let existingRegistry: unknown
  try {
    existingRegistry = global[CLOSED_ROOTS_KEY]
  } catch {
    // A hostile getter must not disable the independent freshness signals.
  }
  let closedRoots = existingRegistry instanceof WeakMap
    ? existingRegistry
    : undefined
  if (!closedRoots) {
    const candidate = new WeakMap<Element, ShadowRoot>()
    try {
      const existingDescriptor = Object.getOwnPropertyDescriptor(global, CLOSED_ROOTS_KEY)
      if (existingDescriptor) {
        // Supplying only value preserves the flags of a non-configurable but
        // writable data property. Configurable collisions are replaced too.
        Object.defineProperty(global, CLOSED_ROOTS_KEY, { value: candidate })
      } else {
        Object.defineProperty(global, CLOSED_ROOTS_KEY, {
          value: candidate,
          configurable: false,
          enumerable: false,
          writable: false,
        })
      }
      if (global[CLOSED_ROOTS_KEY] === candidate) closedRoots = candidate
    } catch {
      // Fail closed for semantic access to closed roots. attachShadow remains
      // usable and the mutation/resize/CSS freshness machinery still boots.
    }
  }

  // Capture the Playwright bridge before application code can replace or
  // delete its writable main-world property. All instrumentation signals use
  // this private closure reference from here onward.
  const bindingCandidate = globalRecord[notifyBindingName]
  const notifyBridge = typeof bindingCandidate === 'function'
    ? (bindingCandidate as (urgency?: 'settled') => Promise<void>).bind(global)
    : undefined
  const NOTIFY_MIN_INTERVAL_MS = 25
  let notifyInFlight = false
  let notifyPending = false
  let settledNotifyPending = false
  let notifyTimer: ReturnType<typeof setTimeout> | undefined
  let lastNotifyStartedAt = Number.NEGATIVE_INFINITY

  const drainNotify = () => {
    if (!notifyBridge || notifyInFlight || notifyTimer !== undefined || !notifyPending) return
    const elapsed = global.performance.now() - lastNotifyStartedAt
    const remaining = Math.max(0, NOTIFY_MIN_INTERVAL_MS - elapsed)
    if (remaining > 0) {
      // Anchor the cadence to the prior dispatch instead of resetting this
      // timer for every mutation. A page that changes forever therefore keeps
      // making bounded progress and still emits its final trailing signal.
      notifyTimer = global.setTimeout(() => {
        notifyTimer = undefined
        drainNotify()
      }, Math.ceil(remaining))
      return
    }

    const urgency = settledNotifyPending ? 'settled' as const : undefined
    notifyPending = false
    settledNotifyPending = false
    notifyInFlight = true
    lastNotifyStartedAt = global.performance.now()
    let bridgeCall: Promise<void>
    try {
      bridgeCall = Promise.resolve(notifyBridge(urgency))
    } catch {
      notifyInFlight = false
      drainNotify()
      return
    }
    void bridgeCall.catch(() => {}).finally(() => {
      notifyInFlight = false
      drainNotify()
    })
  }
  const notify = (urgency?: 'settled') => {
    if (!notifyBridge) return
    notifyPending = true
    // A final settle hint must survive coalescing with any number of ordinary
    // mutation signals so the host can bypass its trailing debounce once.
    if (urgency === 'settled') settledNotifyPending = true
    drainNotify()
  }

  // A sampler is started only by a signal that can imply layout is actively
  // changing. It has a hard per-signal horizon and never polls an idle page.
  const MAX_SETTLE_MS = 500
  let settleUntil = 0
  let settleAnimationFrame: number | undefined
  const sampleUntilSettled = () => {
    if (global.performance.now() < settleUntil) {
      notify()
      settleAnimationFrame = global.requestAnimationFrame(sampleUntilSettled)
    } else {
      settleAnimationFrame = undefined
      // Bypass the trailing debounce for the final sample. This makes 500ms
      // a hard scheduling bound for a finite layout activity window instead
      // of silently turning it into 500ms + debounceMs.
      notify('settled')
    }
  }
  const markLayoutActivity = () => {
    settleUntil = Math.max(settleUntil, global.performance.now() + MAX_SETTLE_MS)
    notify()
    if (settleAnimationFrame === undefined) {
      settleAnimationFrame = global.requestAnimationFrame(sampleUntilSettled)
    }
  }

  let resizeObserver: ResizeObserver | undefined
  const resizeTargets = new WeakSet<Element>()
  // Bounding the target count avoids turning observation into an unbounded
  // mirror of very large application DOMs. CSSOM/event sampling remains the
  // fallback for nodes beyond this cap.
  const MAX_RESIZE_TARGETS = 4_096
  let resizeTargetCount = 0
  const observeResizeTarget = (element: Element) => {
    if (!resizeObserver || resizeTargets.has(element) || resizeTargetCount >= MAX_RESIZE_TARGETS) return
    resizeTargets.add(element)
    resizeTargetCount += 1
    resizeObserver.observe(element)
  }
  const observeResizeCandidates = (root: ParentNode) => {
    if (root instanceof Element) observeResizeTarget(root)
    for (const element of root.querySelectorAll(
      'a,button,input,select,textarea,iframe,img,canvas,svg,video,[role],[contenteditable],[tabindex]',
    )) {
      observeResizeTarget(element)
      if (resizeTargetCount >= MAX_RESIZE_TARGETS) break
    }
  }

  if (typeof ResizeObserver === 'function') {
    resizeObserver = new ResizeObserver(() => notify())
  }

  const mutationObserver = new MutationObserver(records => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node instanceof Element || node instanceof ShadowRoot) {
          observeResizeCandidates(node)
        }
      }
    }
    notify()
  })
  const observeRoot = (root: Document | ShadowRoot) => {
    mutationObserver.observe(root, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    })
    observeResizeCandidates(root)
  }

  const attachShadowDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'attachShadow')
  const nativeAttachShadow = attachShadowDescriptor?.value as typeof Element.prototype.attachShadow | undefined
  if (nativeAttachShadow) {
    const instrumentedAttachShadow = function attachShadow(
      this: Element,
      init: ShadowRootInit,
    ): ShadowRoot {
      const root = Reflect.apply(nativeAttachShadow, this, [init]) as ShadowRoot
      if (init?.mode === 'closed') closedRoots?.set(this, root)
      observeRoot(root)
      markLayoutActivity()
      return root
    }
    // Preserve the original method's own surface where the platform permits
    // it. The wrapper already has the native one-argument call signature.
    try {
      Object.defineProperty(instrumentedAttachShadow, 'name', {
        value: nativeAttachShadow.name,
        configurable: true,
      })
      Object.defineProperty(instrumentedAttachShadow, 'toString', {
        value: nativeAttachShadow.toString.bind(nativeAttachShadow),
        configurable: true,
      })
    } catch {
      // Function metadata is cosmetic; never make attachShadow unavailable.
    }
    try {
      Object.defineProperty(Element.prototype, 'attachShadow', {
        ...attachShadowDescriptor,
        value: instrumentedAttachShadow,
      })
    } catch {
      // Hardened realms may lock platform prototypes. Keep the rest of the
      // freshness instrumentation available even when closed-root capture is
      // impossible in that realm.
    }
  }

  type AnyMethod = (this: unknown, ...args: unknown[]) => unknown
  type AnyGetter = (this: unknown) => unknown
  type AnySetter = (this: unknown, value: unknown) => void
  const wrapLayoutMutator = (prototype: object, property: string) => {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, property)
    const native = descriptor?.value as AnyMethod | undefined
    if (!descriptor || typeof native !== 'function') return
    const wrapped = function (this: unknown, ...args: unknown[]) {
      const result = Reflect.apply(native, this, args)
      markLayoutActivity()
      if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
        void Promise.resolve(result).then(markLayoutActivity, markLayoutActivity)
      }
      return result
    }
    try {
      Object.defineProperty(wrapped, 'name', { value: native.name, configurable: true })
      Object.defineProperty(wrapped, 'length', { value: native.length, configurable: true })
    } catch {
      // Function metadata is best-effort only.
    }
    try {
      Object.defineProperty(prototype, property, { ...descriptor, value: wrapped })
    } catch {
      // A locked CSSOM prototype still has ResizeObserver/event fallbacks.
    }
  }

  const wrapLayoutSetter = (prototype: object, property: string) => {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, property)
    const nativeSet = descriptor?.set as AnySetter | undefined
    if (!descriptor || !nativeSet) return
    const wrappedSet = function (this: unknown, value: unknown) {
      Reflect.apply(nativeSet, this, [value])
      markLayoutActivity()
    }
    try {
      Object.defineProperty(prototype, property, { ...descriptor, set: wrappedSet })
    } catch {
      // A locked CSSOM prototype still has ResizeObserver/event fallbacks.
    }
  }

  const instrumentedDeclarations = new WeakSet<CSSStyleDeclaration>()
  const nativeGetPropertyValue = CSSStyleDeclaration.prototype.getPropertyValue
  const nativeSetProperty = CSSStyleDeclaration.prototype.setProperty
  // CSSStyleDeclaration exposes CSS properties as own WebIDL named
  // properties. Assignments such as rule.style.transform = 'translateX(...)'
  // do not call the JavaScript-visible setProperty method and do not produce a
  // DOM mutation. Instrument geometry-bearing declarations when a CSS rule's
  // style getter first exposes them so cached declarations remain observable.
  const GEOMETRY_DECLARATION_PROPERTIES = [
    'alignContent', 'alignItems', 'alignSelf', 'alignmentBaseline',
    'animation', 'animationDelay', 'animationDuration', 'animationName', 'animationPlayState',
    'aspectRatio',
    'blockSize', 'inlineSize', 'minBlockSize', 'maxBlockSize', 'minInlineSize', 'maxInlineSize',
    'border', 'borderBlock', 'borderInline', 'borderWidth', 'borderTopWidth', 'borderRightWidth',
    'borderBottomWidth', 'borderLeftWidth', 'boxSizing',
    'clear', 'clip', 'clipPath', 'columnCount', 'columnGap', 'columnWidth', 'columns',
    'contain', 'content', 'contentVisibility',
    'direction', 'display',
    'flex', 'flexBasis', 'flexDirection', 'flexFlow', 'flexGrow', 'flexShrink', 'flexWrap',
    'float', 'cssFloat',
    'font', 'fontFamily', 'fontSize', 'fontStretch', 'fontStyle', 'fontWeight',
    'gap', 'grid', 'gridArea', 'gridAutoColumns', 'gridAutoFlow', 'gridAutoRows',
    'gridColumn', 'gridColumnEnd', 'gridColumnStart', 'gridRow', 'gridRowEnd', 'gridRowStart',
    'gridTemplate', 'gridTemplateAreas', 'gridTemplateColumns', 'gridTemplateRows',
    'height', 'minHeight', 'maxHeight',
    'inset', 'insetBlock', 'insetBlockEnd', 'insetBlockStart', 'insetInline', 'insetInlineEnd',
    'insetInlineStart', 'top', 'right', 'bottom', 'left',
    'justifyContent', 'justifyItems', 'justifySelf',
    'letterSpacing', 'lineHeight',
    'margin', 'marginBlock', 'marginBlockEnd', 'marginBlockStart', 'marginInline', 'marginInlineEnd',
    'marginInlineStart', 'marginTop', 'marginRight', 'marginBottom', 'marginLeft',
    'objectFit', 'objectPosition', 'opacity', 'order', 'overflow', 'overflowX', 'overflowY',
    'padding', 'paddingBlock', 'paddingBlockEnd', 'paddingBlockStart', 'paddingInline',
    'paddingInlineEnd', 'paddingInlineStart', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
    'perspective', 'perspectiveOrigin', 'position',
    'rotate', 'rowGap', 'scale',
    'textIndent', 'transform', 'transformBox', 'transformOrigin', 'transition', 'translate',
    'verticalAlign', 'visibility', 'whiteSpace',
    'width', 'minWidth', 'maxWidth', 'wordSpacing', 'writingMode', 'zoom',
  ] as const
  const cssPropertyName = (property: string): string => {
    if (property === 'cssFloat') return 'float'
    const dashed = property.replace(/[A-Z]/g, character => `-${character.toLowerCase()}`)
    return /^(webkit|moz|ms|o)-/.test(dashed) ? `-${dashed}` : dashed
  }
  const instrumentDeclaration = (declaration: CSSStyleDeclaration) => {
    if (instrumentedDeclarations.has(declaration)) return
    instrumentedDeclarations.add(declaration)
    for (const property of GEOMETRY_DECLARATION_PROPERTIES) {
      const descriptor = Object.getOwnPropertyDescriptor(declaration, property)
      if (!descriptor?.configurable) continue
      const cssName = cssPropertyName(property)
      try {
        Object.defineProperty(declaration, property, {
          configurable: true,
          enumerable: descriptor.enumerable,
          get() {
            return Reflect.apply(nativeGetPropertyValue, declaration, [cssName]) as string
          },
          set(value: unknown) {
            Reflect.apply(nativeSetProperty, declaration, [cssName, value == null ? '' : String(value), ''])
            markLayoutActivity()
          },
        })
      } catch {
        // The rule-style getter sampler below remains a bounded fallback.
      }
    }
  }
  const wrapRuleStyleGetter = (prototype: object) => {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'style')
    const nativeGet = descriptor?.get as AnyGetter | undefined
    if (!descriptor || !nativeGet) return
    const wrappedGet = function (this: unknown) {
      const declaration = Reflect.apply(nativeGet, this, []) as CSSStyleDeclaration
      instrumentDeclaration(declaration)
      // Also cover newly introduced CSS properties that are not yet in the
      // explicit geometry list. Access starts one bounded settle window; it
      // never creates persistent polling.
      markLayoutActivity()
      return declaration
    }
    try {
      Object.defineProperty(prototype, 'style', { ...descriptor, get: wrappedGet })
    } catch {
      // Locked rule prototypes retain ResizeObserver/event fallbacks.
    }
  }

  if (typeof CSSStyleSheet !== 'undefined') {
    for (const method of ['insertRule', 'deleteRule', 'replace', 'replaceSync']) {
      wrapLayoutMutator(CSSStyleSheet.prototype, method)
    }
  }
  if (typeof CSSStyleDeclaration !== 'undefined') {
    for (const method of ['setProperty', 'removeProperty']) {
      wrapLayoutMutator(CSSStyleDeclaration.prototype, method)
    }
    wrapLayoutSetter(CSSStyleDeclaration.prototype, 'cssText')
  }
  for (const constructorName of ['CSSStyleRule', 'CSSKeyframeRule', 'CSSFontFaceRule', 'CSSPageRule']) {
    const constructor = (global as unknown as Record<string, unknown>)[constructorName] as
      | { prototype?: object }
      | undefined
    if (constructor?.prototype) wrapRuleStyleGetter(constructor.prototype)
  }

  const notifyEvent = () => notify()
  const activityEvent = () => markLayoutActivity()
  global.addEventListener('scroll', notifyEvent, { capture: true, passive: true })
  global.addEventListener('resize', notifyEvent, { passive: true })
  document.addEventListener('transitionrun', activityEvent, true)
  document.addEventListener('transitionstart', activityEvent, true)
  document.addEventListener('transitionend', activityEvent, true)
  document.addEventListener('transitioncancel', activityEvent, true)
  document.addEventListener('animationstart', activityEvent, true)
  document.addEventListener('animationiteration', activityEvent, true)
  document.addEventListener('animationend', activityEvent, true)
  document.addEventListener('animationcancel', activityEvent, true)
  document.addEventListener('load', event => {
    const target = event.target
    if (target instanceof HTMLLinkElement && target.relList.contains('stylesheet')) {
      markLayoutActivity()
    }
  }, true)

  const fonts = document.fonts
  if (fonts) {
    fonts.addEventListener('loading', activityEvent)
    fonts.addEventListener('loadingdone', activityEvent)
    fonts.addEventListener('loadingerror', activityEvent)
    void fonts.ready.then(markLayoutActivity, notify)
  }

  // A Document can be observed before the parser creates documentElement, so
  // install the mutation signal immediately and add resize targets once they
  // exist.
  observeRoot(document)
  const installDocumentResizeTargets = () => {
    if (document.documentElement) observeResizeTarget(document.documentElement)
    if (document.body) observeResizeTarget(document.body)
  }
  if (document.documentElement) {
    installDocumentResizeTargets()
  } else {
    document.addEventListener('DOMContentLoaded', installDocumentResizeTargets, { once: true })
  }

  Object.defineProperty(global, INSTALL_STATE_KEY, {
    value: installToken,
    configurable: false,
    enumerable: false,
    writable: false,
  })
}

async function bindDomObserverBridge(page: Page, scheduleExtract: (immediate?: boolean) => void): Promise<void> {
  if (DOM_OBSERVER_BINDINGS.has(page)) return
  const installToken = randomBytes(32).toString('base64url')
  const notifyBindingName = `__geometraProxyNotify_${installToken}`
  const installConfig = { installToken, notifyBindingName }
  await page.exposeFunction(notifyBindingName, (urgency?: 'settled') => {
    scheduleExtract(urgency === 'settled')
  })
  // addInitScript is the critical path: it runs before application scripts in
  // every subsequent main-frame and child-frame document.
  await page.addInitScript(installPageFreshnessInstrumentation, installConfig)
  // Also instrument a document that was already loaded before the bridge was
  // bound. Closed roots created before this point cannot be recovered, which
  // is why the runtime primes the bridge before its first navigation.
  await Promise.all(page.frames().map(async frame => {
    await frame.evaluate(installPageFreshnessInstrumentation, installConfig).catch(() => {})
  }))
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

type ActionRequestReservation = 'accepted' | 'duplicate' | 'conflict' | 'capacity'

/**
 * Hub-scoped, bounded request-id memory. The ledger retains only fixed-size
 * SHA-256 digests, never action payloads or field values.
 */
export interface ActionRequestLedger {
  remember: (requestId: string, payload: ParsedClientMessage) => ActionRequestReservation
  complete: (requestId: string) => void
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
      .sort()
      .map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

const ACTION_FINGERPRINT_TRANSPORT_KEYS = new Set([
  'requestId',
  'actionTimeoutMs',
  'protocolVersion',
  'geometryProtocolVersion',
  'proxyActionProtocolVersion',
])

function actionPayloadFingerprint(payload: ParsedClientMessage): string {
  const semanticPayload = Object.fromEntries(
    Object.entries(payload).filter(([key]) => !ACTION_FINGERPRINT_TRANSPORT_KEYS.has(key)),
  )
  return sha256(canonicalJson(semanticPayload))
}

export function createActionRequestLedger(
  maxEntries = DEFAULT_ACTION_REQUEST_LEDGER_ENTRIES,
): ActionRequestLedger {
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
    throw new Error('Action request ledger size must be a positive safe integer')
  }
  const entries = new Map<string, { fingerprint: string; state: 'live' | 'terminal' }>()
  return {
    remember(requestId, payload) {
      // Hash request IDs as well as payloads so every retained entry has a
      // fixed upper memory bound even when a peer sends an unusually long ID.
      const requestKey = sha256(requestId)
      const payloadFingerprint = actionPayloadFingerprint(payload)
      const remembered = entries.get(requestKey)
      if (remembered !== undefined) {
        return remembered.fingerprint === payloadFingerprint ? 'duplicate' : 'conflict'
      }
      if (entries.size >= maxEntries) {
        // Terminal means only that the handler returned; it does not prove
        // the controller received the correlated ACK. Never evict a request
        // ID within a runtime, or an ambiguous retry could mutate twice.
        return 'capacity'
      }
      entries.set(requestKey, { fingerprint: payloadFingerprint, state: 'live' })
      return 'accepted'
    },
    complete(requestId) {
      const requestKey = sha256(requestId)
      const remembered = entries.get(requestKey)
      if (!remembered || remembered.state === 'terminal') return
      entries.delete(requestKey)
      entries.set(requestKey, { ...remembered, state: 'terminal' })
    },
  }
}

const MUTATING_CLIENT_MESSAGE_TYPES = new Set([
  'event',
  'key',
  'typeText',
  'resize',
  'navigate',
  'composition',
  'file',
  'setFieldText',
  'setFieldChoice',
  'fillFields',
  'fillOtp',
  'listboxPick',
  'selectOption',
  'setChecked',
  'wheel',
  'pdfGenerate',
])

function isMutatingClientMessage(msg: ParsedClientMessage): boolean {
  return MUTATING_CLIENT_MESSAGE_TYPES.has(msg.type)
}

class ActionDeadlineExpiredError extends Error {}

function assertActionDeadline(msg: ParsedClientMessage, receivedAt: number): void {
  if (!isMutatingClientMessage(msg)) return
  const actionTimeoutMs = (msg as { actionTimeoutMs?: number }).actionTimeoutMs
  if (actionTimeoutMs !== undefined && performance.now() - receivedAt >= actionTimeoutMs) {
    throw new ActionDeadlineExpiredError('Action deadline expired; request was not executed')
  }
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
  security?: { allowedFileRoots?: string[]; actionRequestLedger?: ActionRequestLedger; receivedAt?: number },
): Promise<void> {
  const receivedAt = security?.receivedAt ?? performance.now()
  const sendWireError = (
    message: string,
    requestId?: string,
    code?: 'DUPLICATE_REQUEST' | 'REQUEST_ID_CONFLICT' | 'REQUEST_LEDGER_CAPACITY' | 'ACTION_EXPIRED' | 'ACTION_OUTCOME_AMBIGUOUS',
  ) => {
    ws.send(JSON.stringify({
      type: 'error',
      message,
      ...(code ? { code } : {}),
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

  // Reserve the request ID before consulting its deadline. An expired replay
  // must be reported as a duplicate/conflict and must never become eligible
  // to mutate merely because the original deadline elapsed.
  let acceptedRequestId: string | undefined
  if (requestId && isMutatingClientMessage(msg) && security?.actionRequestLedger) {
    const reservation = security.actionRequestLedger.remember(requestId, msg)
    if (reservation === 'duplicate') {
      sendWireError('Duplicate requestId; action was not repeated', requestId, 'DUPLICATE_REQUEST')
      return
    }
    if (reservation === 'conflict') {
      sendWireError(
        'requestId was already used with a different payload; action was not executed',
        requestId,
        'REQUEST_ID_CONFLICT',
      )
      return
    }
    if (reservation === 'capacity') {
      sendWireError(
        'Action request ledger is at capacity; action was not executed. Close and reconnect the proxy runtime before sending more actions.',
        requestId,
        'REQUEST_LEDGER_CAPACITY',
      )
      return
    }
    acceptedRequestId = requestId
  }

  try {
    // These guards do not cancel an action that already started. They prevent
    // queued work from beginning after the receipt-relative timeout.
    assertActionDeadline(msg, receivedAt)
    const page = await waitForPage()
    assertActionDeadline(msg, receivedAt)
    if (isResizeMessage(msg)) {
      const w = Math.max(1, Math.floor(msg.width))
      const h = Math.max(1, Math.floor(msg.height))
      assertActionDeadline(msg, receivedAt)
      await page.setViewportSize({ width: w, height: h })
      onViewportOrInput('resize', requestId)
      return
    }

    assertActionDeadline(msg, receivedAt)
    await waitForBeforeInput()
    assertActionDeadline(msg, receivedAt)

    if (isNavigateMessage(msg)) {
      clearFillLookupCache(fieldLookupCache)
      assertActionDeadline(msg, receivedAt)
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
        assertActionDeadline(msg, receivedAt)
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
      assertActionDeadline(msg, receivedAt)
      await applyKeyPhase(page, msg)
      onViewportOrInput('input', requestId)
      return
    }

    if (isTypeTextMessage(msg)) {
      assertActionDeadline(msg, receivedAt)
      await page.keyboard.type(msg.text)
      onViewportOrInput('input', requestId)
      return
    }

    if (isCompositionMessage(msg)) {
      const data = typeof msg.data === 'string' ? msg.data : ''
      if (msg.eventType === 'onCompositionUpdate' || msg.eventType === 'onCompositionEnd') {
        assertActionDeadline(msg, receivedAt)
        await page.keyboard.insertText(data)
        onViewportOrInput('input', requestId)
      }
      return
    }

    if (isFileMessage(msg)) {
      const paths = resolveExistingFiles(msg.paths, security?.allowedFileRoots)
      assertActionDeadline(msg, receivedAt)
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
      assertActionDeadline(msg, receivedAt)
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
      assertActionDeadline(msg, receivedAt)
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
      assertActionDeadline(msg, receivedAt)
      await fillFields(page, authorizedFields, fieldLookupCache)
      const result = await fillFieldsAckResult(page)
      onViewportOrInput('input', requestId, result)
      return
    }

    if (isFillOtpMessage(msg)) {
      assertActionDeadline(msg, receivedAt)
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
      assertActionDeadline(msg, receivedAt)
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
      assertActionDeadline(msg, receivedAt)
      await selectNativeOption(page, msg.x, msg.y, {
        value: msg.value,
        label: msg.label,
        index: msg.index,
      })
      onViewportOrInput('input', requestId)
      return
    }

    if (isSetCheckedMessage(msg)) {
      assertActionDeadline(msg, receivedAt)
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
      assertActionDeadline(msg, receivedAt)
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
        assertActionDeadline(msg, receivedAt)
        await page.setContent(msg.html, { waitUntil: 'networkidle', timeout: 30_000 })
      }

      assertActionDeadline(msg, receivedAt)
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
    if (!(err instanceof ActionDeadlineExpiredError)) onHandlerError(err)
    sendWireError(
      err instanceof Error ? err.message : String(err),
      requestId,
      err instanceof ActionDeadlineExpiredError
        ? 'ACTION_EXPIRED'
        : acceptedRequestId
          ? 'ACTION_OUTCOME_AMBIGUOUS'
          : undefined,
    )
  } finally {
    if (acceptedRequestId) security?.actionRequestLedger?.complete(acceptedRequestId)
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
  // dom-actions.ts). Restrict native validity to actual controls because
  // `:invalid` also matches ancestor <form> and <fieldset> elements whenever
  // one descendant is invalid. The outer `:is()` de-duplicates controls that
  // also advertise aria-invalid.
  const invalidSelector = ':is(:is(input, textarea, select):invalid, [aria-invalid="true"]:is(input, textarea, select, [role="combobox"], [role="listbox"], [role="spinbutton"], [role="searchbox"], [role="textbox"]))'
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
  scheduleExtract: (immediate?: boolean) => void
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
  let closing = false
  const axSessionManager = createCdpAxSessionManager(() => {
    if (!closing) scheduleExtract(true)
  })

  let prevLayout: LayoutSnapshot | null = null
  let prevTreeJson: string | null = null

  let debounceTimer: ReturnType<typeof setTimeout> | null = null
  let inputAckFlushTimer: ReturnType<typeof setTimeout> | null = null
  let immediateExtractTimer: ReturnType<typeof setTimeout> | null = null
  let axRetryTimer: ReturnType<typeof setTimeout> | null = null
  let axRetryDueAtMs = Number.POSITIVE_INFINITY
  let immediateExtractRequestedAfterActive = false
  let lastExtractCompletedAtMs = Number.NEGATIVE_INFINITY
  let extracting = false
  let pendingExtract = false
  let extractSequence = 0
  let completedExtractSequence = 0
  let actionQueue: Promise<void> = Promise.resolve()
  let pendingInputAcks: PendingInputAck[] = []
  const fieldLookupCache = createFillLookupCache()
  const actionRequestLedger = createActionRequestLedger()
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
    if (pendingInputAcks.length === 0) {
      clearInputAckFlushTimer()
    } else {
      armInputAckFlushTimer()
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
    clearInputAckFlushTimer()
    for (const { ws, requestId } of pending) {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({
          type: 'error',
          message,
          code: 'ACTION_OUTCOME_AMBIGUOUS',
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
      const snap = await extractGeometryWithRecovery(
        page,
        axSessionManager,
        extractorTrace,
        recoveryTrace,
        () => scheduleExtract(true),
        delayMs => scheduleAxRetry(delayMs),
      )
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
      lastExtractCompletedAtMs = performance.now()
      if (immediateExtractRequestedAfterActive) {
        immediateExtractRequestedAfterActive = false
        armImmediateExtract()
      }
    }
    return changed
  }

  function clearDebounceTimer() {
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer)
      debounceTimer = null
    }
  }

  function clearInputAckFlushTimer() {
    if (inputAckFlushTimer !== null) {
      clearTimeout(inputAckFlushTimer)
      inputAckFlushTimer = null
    }
  }

  function clearImmediateExtractTimer() {
    if (immediateExtractTimer !== null) {
      clearTimeout(immediateExtractTimer)
      immediateExtractTimer = null
    }
    immediateExtractRequestedAfterActive = false
  }

  function clearAxRetryTimer() {
    if (axRetryTimer !== null) {
      clearTimeout(axRetryTimer)
      axRetryTimer = null
    }
    axRetryDueAtMs = Number.POSITIVE_INFINITY
  }

  function scheduleAxRetry(delayMs: number) {
    const boundedDelayMs = Math.max(1, Math.ceil(delayMs))
    const dueAtMs = performance.now() + boundedDelayMs
    if (axRetryTimer !== null && dueAtMs >= axRetryDueAtMs) return
    clearAxRetryTimer()
    axRetryDueAtMs = dueAtMs
    axRetryTimer = setTimeout(() => {
      axRetryTimer = null
      axRetryDueAtMs = Number.POSITIVE_INFINITY
      scheduleExtract(true)
    }, boundedDelayMs)
  }

  function runScheduledExtract() {
    void runExtractQueued()
      .then(() => {
        sendPendingInputAcks()
      })
      .catch(err => options.onError?.(err))
  }

  function flushDebouncedExtract() {
    clearDebounceTimer()
    runScheduledExtract()
  }

  function armInputAckFlushTimer() {
    if (pendingInputAcks.length === 0 || inputAckFlushTimer !== null) return
    // This timer is anchored to the first pending action ack and is never
    // reset by page mutations. Mutation-only traffic does not arm it, so an
    // animated page retains the normal trailing-edge debounce behavior.
    inputAckFlushTimer = setTimeout(() => {
      inputAckFlushTimer = null
      if (pendingInputAcks.length === 0) return
      clearDebounceTimer()
      runScheduledExtract()
    }, MAX_INPUT_ACK_LATENCY_MS)
  }

  function armImmediateExtract() {
    if (extracting) {
      // Do not turn a page hint into runExtractQueued's pending loop. One
      // coalesced refresh becomes eligible only after the active extraction
      // completes and the host has had a cooldown window.
      immediateExtractRequestedAfterActive = true
      return
    }
    if (immediateExtractTimer !== null) return
    const elapsed = performance.now() - lastExtractCompletedAtMs
    const remaining = Math.max(0, MIN_IMMEDIATE_EXTRACT_INTERVAL_MS - elapsed)
    if (remaining === 0) {
      runScheduledExtract()
      return
    }
    immediateExtractTimer = setTimeout(() => {
      immediateExtractTimer = null
      if (extracting) {
        immediateExtractRequestedAfterActive = true
      } else {
        runScheduledExtract()
      }
    }, remaining)
  }

  function scheduleExtract(immediate = false) {
    if (immediate) {
      clearDebounceTimer()
      armImmediateExtract()
      return
    }
    if (debounceTimer !== null) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(flushDebouncedExtract, debounceMs)
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
      // Capture receipt before queueing so actionTimeoutMs includes time spent
      // waiting behind earlier Playwright work and uses this host's monotonic
      // clock rather than trusting the controller's wall clock.
      const receivedAt = performance.now()
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
                if (requestId) {
                  pendingInputAcks.push({
                    ws,
                    requestId,
                    afterExtractSequence: extractSequence,
                  })
                }
                void runExtractQueued()
                  .then(() => sendPendingInputAcks())
                  .catch(err => options.onError?.(err))
              } else {
                pendingInputAcks.push({
                  ws,
                  afterExtractSequence: extractSequence,
                  ...(requestId ? { requestId } : {}),
                  ...(result !== undefined ? { result } : {}),
                })
                scheduleExtract()
                armInputAckFlushTimer()
              }
            },
            err => options.onError?.(err),
            { allowedFileRoots: options.allowedFileRoots, actionRequestLedger, receivedAt },
          ),
        )
        .catch(err => options.onError?.(err))
    })
    ws.on('close', () => {
      clients.delete(ws)
      controllerClaimed = clients.size > 0
      pendingInputAcks = pendingInputAcks.filter(entry => entry.ws !== ws)
      if (pendingInputAcks.length === 0) clearInputAckFlushTimer()
    })
  })

  return {
    authToken,
    host,
    scheduleExtract,
    flushExtract: async () => {
      await actionQueue.catch(() => {})
      clearDebounceTimer()
      clearInputAckFlushTimer()
      clearImmediateExtractTimer()
      await runExtractQueued()
      sendPendingInputAcks()
    },
    getTrace: () => structuredClone(trace),
    close: () => {
      closing = true
      return new Promise((resolve, reject) => {
        void axSessionManager.close().finally(() => {
          clearDebounceTimer()
          clearInputAckFlushTimer()
          clearImmediateExtractTimer()
          clearAxRetryTimer()
          for (const ws of clients) {
            ws.close()
          }
          clients.clear()
          wss.close(err => (err ? reject(err) : resolve()))
        })
      })
    },
  }
}

export async function primeDomObserver(page: Page, scheduleExtract: (immediate?: boolean) => void): Promise<void> {
  await bindDomObserverBridge(page, scheduleExtract)
}

export async function installDomObserver(page: Page, scheduleExtract: (immediate?: boolean) => void): Promise<void> {
  await bindDomObserverBridge(page, scheduleExtract)
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
  onAxReady?: () => void,
  onAxRetryDue?: (delayMs: number) => void,
): Promise<GeometrySnapshot> {
  let lastNavigationError: Error | null = null
  let domContentLoadedWaitMs = 0
  let loadWaitMs = 0

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      if (recoveryTrace) {
        recoveryTrace.attemptCount = attempt + 1
      }
      return await extractGeometry(page, {
        axSessionManager,
        trace: extractTrace,
        onAxReady,
        onAxRetryDue,
      })
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
