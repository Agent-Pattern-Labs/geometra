/** Layout snapshot aligned with Textura {@link ComputedLayout} / GEOM v1 `frame.layout`. */
export interface LayoutSnapshot {
  x: number
  y: number
  width: number
  height: number
  children: LayoutSnapshot[]
}

/** Synthetic UI tree shape consumed by `@geometra/mcp` `buildA11yTree` (JSON-serializable). */
export interface TreeSnapshot {
  kind: 'box' | 'text' | 'image'
  props: Record<string, unknown>
  semantic?: Record<string, unknown>
  /** Truthy flags only — matches JSON round-trips from native Geometra servers. */
  handlers?: { onClick?: boolean; onKeyDown?: boolean; onKeyUp?: boolean }
  children?: TreeSnapshot[]
}

export interface GeometrySnapshot {
  layout: LayoutSnapshot
  tree: TreeSnapshot
  /** `JSON.stringify(tree)` for deciding frame vs patch. */
  treeJson: string
}

/** Shared geometry frame/event wire version. */
export const GEOMETRY_PROTOCOL_VERSION = 1 as const
/** Browser-only semantic action wire version. */
export const PROXY_ACTION_PROTOCOL_VERSION = 2 as const
/** Legacy name retained for older MCP clients. */
export const PROXY_PROTOCOL_VERSION = PROXY_ACTION_PROTOCOL_VERSION

export interface ProxyProtocolCapabilities {
  transport: 'proxy'
  requestScopedAcks: true
  proxyActions: true
  exactFieldIdentity: true
}
export type ClientChoiceType = 'select' | 'group' | 'listbox'

/**
 * Stable authored DOM key emitted by the proxy extractor.
 *
 * - `id:<id>` identifies an element by its authored `id`.
 * - `name:<tag>:<type-or-default>:<name>` identifies an element by its
 *   authored tag / type / name tuple.
 *
 * `fieldId` remains Geometra's schema/cache identity. `fieldKey` is the
 * browser-side exact locator that should be tried before label heuristics.
 */
export type ClientFieldKey = string

export type ClientEventMessage = {
  type: 'event'
  eventType: string
  x: number
  y: number
  requestId?: string
  protocolVersion?: number
}

export type ClientKeyMessage = {
  type: 'key'
  eventType: 'onKeyDown' | 'onKeyUp'
  key: string
  code: string
  shiftKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  requestId?: string
  protocolVersion?: number
}

export type ClientResizeMessage = {
  type: 'resize'
  width: number
  height: number
  capabilities?: { binaryFraming?: boolean }
  requestId?: string
  protocolVersion?: number
}

export type ClientNavigateMessage = {
  type: 'navigate'
  url: string
  requestId?: string
  protocolVersion?: number
}

export type ClientCompositionMessage = {
  type: 'composition'
  eventType: 'onCompositionStart' | 'onCompositionUpdate' | 'onCompositionEnd'
  data: string
  requestId?: string
  protocolVersion?: number
}

export type ClientFileMessage = {
  type: 'file'
  paths: string[]
  fieldId?: string
  fieldKey?: ClientFieldKey
  x?: number
  y?: number
  fieldLabel?: string
  exact?: boolean
  strategy?: 'auto' | 'chooser' | 'hidden' | 'drop'
  dropX?: number
  dropY?: number
  requestId?: string
  protocolVersion?: number
}

export type ClientSetFieldTextMessage = {
  type: 'setFieldText'
  fieldId?: string
  fieldKey?: ClientFieldKey
  fieldLabel: string
  value: string
  exact?: boolean
  /** Optional delay between keystrokes when falling back to keyboard typing (masked fields, rich editors). */
  typingDelayMs?: number
  /** Dispatch composition + input events before assignment (some IME-heavy controlled inputs). */
  imeFriendly?: boolean
  requestId?: string
  protocolVersion?: number
}

export type ClientSetFieldChoiceMessage = {
  type: 'setFieldChoice'
  fieldId?: string
  fieldKey?: ClientFieldKey
  fieldLabel: string
  value: string
  optionIndex?: number
  query?: string
  choiceType?: ClientChoiceType
  exact?: boolean
  requestId?: string
  protocolVersion?: number
}

export type ClientFillField =
  | { kind: 'auto'; fieldId?: string; fieldKey?: ClientFieldKey; fieldLabel: string; value: string | boolean; exact?: boolean }
  | {
      kind: 'text'
      fieldId?: string
      fieldKey?: ClientFieldKey
      fieldLabel: string
      value: string
      exact?: boolean
      typingDelayMs?: number
      imeFriendly?: boolean
    }
  | { kind: 'choice'; fieldId?: string; fieldKey?: ClientFieldKey; fieldLabel: string; value: string; optionIndex?: number; query?: string; exact?: boolean; choiceType?: ClientChoiceType }
  | { kind: 'toggle'; fieldId?: string; fieldKey?: ClientFieldKey; label: string; checked?: boolean; exact?: boolean; controlType?: 'checkbox' | 'radio'; contextText?: string; sectionText?: string }
  | { kind: 'file'; fieldId?: string; fieldKey?: ClientFieldKey; fieldLabel: string; paths: string[]; exact?: boolean }

export type ClientFillFieldsMessage = {
  type: 'fillFields'
  fields: ClientFillField[]
  requestId?: string
  protocolVersion?: number
}

export type ClientListboxPickMessage = {
  type: 'listboxPick'
  label: string
  exact?: boolean
  openX?: number
  openY?: number
  fieldId?: string
  fieldKey?: ClientFieldKey
  fieldLabel?: string
  query?: string
  requestId?: string
  protocolVersion?: number
}

export type ClientSelectOptionMessage = {
  type: 'selectOption'
  x: number
  y: number
  value?: string
  label?: string
  index?: number
  requestId?: string
  protocolVersion?: number
}

export type ClientSetCheckedMessage = {
  type: 'setChecked'
  label: string
  fieldKey?: ClientFieldKey
  checked?: boolean
  exact?: boolean
  controlType?: 'checkbox' | 'radio'
  contextText?: string
  sectionText?: string
  requestId?: string
  protocolVersion?: number
}

export type ClientWheelMessage = {
  type: 'wheel'
  deltaX?: number
  deltaY?: number
  x?: number
  y?: number
  requestId?: string
  protocolVersion?: number
}

export type ClientScreenshotMessage = {
  type: 'screenshot'
  requestId?: string
  protocolVersion?: number
}

export type ClientFillOtpMessage = {
  type: 'fillOtp'
  value: string
  fieldLabel?: string
  perCharDelayMs?: number
  requestId?: string
  protocolVersion?: number
}

export type ClientPdfGenerateMessage = {
  type: 'pdfGenerate'
  /** Optional HTML string to render instead of the current page. */
  html?: string
  /** Paper format: 'A4' or 'Letter'. Defaults to 'A4'. */
  format?: 'A4' | 'Letter'
  /** Print in landscape orientation. */
  landscape?: boolean
  /** CSS margin (e.g. '1cm', '0.5in'). Applied to all sides if individual sides are not set. */
  margin?: string
  /** Print background graphics. Defaults to true. */
  printBackground?: boolean
  requestId?: string
  protocolVersion?: number
}

export type ParsedClientMessage =
  | ClientEventMessage
  | ClientKeyMessage
  | ClientResizeMessage
  | ClientNavigateMessage
  | ClientCompositionMessage
  | ClientFileMessage
  | ClientSetFieldTextMessage
  | ClientSetFieldChoiceMessage
  | ClientFillFieldsMessage
  | ClientFillOtpMessage
  | ClientListboxPickMessage
  | ClientSelectOptionMessage
  | ClientSetCheckedMessage
  | ClientWheelMessage
  | ClientScreenshotMessage
  | ClientPdfGenerateMessage
  | {
      type: string
      protocolVersion?: number
      geometryProtocolVersion?: number
      proxyActionProtocolVersion?: number
    }

type UnknownRecord = Record<string, unknown>

const COMMON_MESSAGE_KEYS = new Set([
  'type',
  'requestId',
  'protocolVersion',
  'geometryProtocolVersion',
  'proxyActionProtocolVersion',
])
const SET_CHECKED_MESSAGE_KEYS = new Set([
  ...COMMON_MESSAGE_KEYS,
  'label',
  'fieldKey',
  'checked',
  'exact',
  'controlType',
  'contextText',
  'sectionText',
])
const FILL_FIELDS_MESSAGE_KEYS = new Set([...COMMON_MESSAGE_KEYS, 'fields'])
const MESSAGE_KEYS = {
  event: new Set([...COMMON_MESSAGE_KEYS, 'eventType', 'x', 'y']),
  key: new Set([...COMMON_MESSAGE_KEYS, 'eventType', 'key', 'code', 'shiftKey', 'ctrlKey', 'metaKey', 'altKey']),
  resize: new Set([...COMMON_MESSAGE_KEYS, 'width', 'height', 'capabilities']),
  navigate: new Set([...COMMON_MESSAGE_KEYS, 'url']),
  composition: new Set([...COMMON_MESSAGE_KEYS, 'eventType', 'data']),
  file: new Set([...COMMON_MESSAGE_KEYS, 'paths', 'fieldId', 'fieldKey', 'x', 'y', 'fieldLabel', 'exact', 'strategy', 'dropX', 'dropY']),
  setFieldText: new Set([...COMMON_MESSAGE_KEYS, 'fieldId', 'fieldKey', 'fieldLabel', 'value', 'exact', 'typingDelayMs', 'imeFriendly']),
  setFieldChoice: new Set([...COMMON_MESSAGE_KEYS, 'fieldId', 'fieldKey', 'fieldLabel', 'value', 'optionIndex', 'query', 'choiceType', 'exact']),
  fillOtp: new Set([...COMMON_MESSAGE_KEYS, 'value', 'fieldLabel', 'perCharDelayMs']),
  listboxPick: new Set([...COMMON_MESSAGE_KEYS, 'label', 'exact', 'openX', 'openY', 'fieldId', 'fieldKey', 'fieldLabel', 'query']),
  selectOption: new Set([...COMMON_MESSAGE_KEYS, 'x', 'y', 'value', 'label', 'index']),
  wheel: new Set([...COMMON_MESSAGE_KEYS, 'deltaX', 'deltaY', 'x', 'y']),
  screenshot: new Set(COMMON_MESSAGE_KEYS),
  pdfGenerate: new Set([...COMMON_MESSAGE_KEYS, 'html', 'format', 'landscape', 'margin', 'printBackground']),
}
const FILL_FIELD_KEYS = {
  auto: new Set(['kind', 'fieldId', 'fieldKey', 'fieldLabel', 'value', 'exact']),
  text: new Set(['kind', 'fieldId', 'fieldKey', 'fieldLabel', 'value', 'exact', 'typingDelayMs', 'imeFriendly']),
  choice: new Set(['kind', 'fieldId', 'fieldKey', 'fieldLabel', 'value', 'optionIndex', 'query', 'exact', 'choiceType']),
  toggle: new Set([
    'kind',
    'fieldId',
    'fieldKey',
    'label',
    'checked',
    'exact',
    'controlType',
    'contextText',
    'sectionText',
  ]),
  file: new Set(['kind', 'fieldId', 'fieldKey', 'fieldLabel', 'paths', 'exact']),
} satisfies Record<ClientFillField['kind'], ReadonlySet<string>>

function asRecord(value: unknown): UnknownRecord | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as UnknownRecord
    : null
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isOptionalBoolean(value: unknown): value is boolean | undefined {
  return value === undefined || typeof value === 'boolean'
}

function isOptionalFiniteNumber(value: unknown): value is number | undefined {
  return value === undefined || isFiniteNumber(value)
}

function isOptionalTrimmedString(value: unknown): value is string | undefined {
  return value === undefined || (typeof value === 'string' && value.length > 0 && value === value.trim())
}

function isTrimmedNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value === value.trim()
}

export function isClientFieldKey(value: unknown): value is ClientFieldKey {
  if (!isTrimmedNonEmptyString(value)) return false
  if (value.startsWith('id:')) {
    try {
      return decodeURIComponent(value.slice(3)).trim().length > 0
    } catch {
      return false
    }
  }
  if (!value.startsWith('name:')) return false
  const parts = value.split(':')
  if (parts.length < 4 || !parts[1] || !parts[2]) return false
  try {
    return decodeURIComponent(parts.slice(3).join(':')).trim().length > 0
  } catch {
    return false
  }
}

function hasOnlyKeys(record: UnknownRecord, allowed: ReadonlySet<string>): boolean {
  return Object.keys(record).every(key => allowed.has(key))
}

function hasValidCommonFields(record: UnknownRecord): boolean {
  return isOptionalTrimmedString(record.requestId) &&
    isOptionalFiniteNumber(record.protocolVersion) &&
    isOptionalFiniteNumber(record.geometryProtocolVersion) &&
    isOptionalFiniteNumber(record.proxyActionProtocolVersion)
}

function isClientFillField(value: unknown): value is ClientFillField {
  const field = asRecord(value)
  if (!field || !isTrimmedNonEmptyString(field.kind)) return false
  if (field.fieldId !== undefined && !isTrimmedNonEmptyString(field.fieldId)) return false
  if (field.fieldKey !== undefined && !isClientFieldKey(field.fieldKey)) return false
  if (!isOptionalBoolean(field.exact)) return false

  if (field.kind === 'auto') {
    return hasOnlyKeys(field, FILL_FIELD_KEYS.auto) && isTrimmedNonEmptyString(field.fieldLabel) &&
      (typeof field.value === 'string' || typeof field.value === 'boolean')
  }
  if (field.kind === 'text') {
    return hasOnlyKeys(field, FILL_FIELD_KEYS.text) && isTrimmedNonEmptyString(field.fieldLabel) && typeof field.value === 'string' &&
      isOptionalFiniteNumber(field.typingDelayMs) && isOptionalBoolean(field.imeFriendly)
  }
  if (field.kind === 'choice') {
    return hasOnlyKeys(field, FILL_FIELD_KEYS.choice) && isTrimmedNonEmptyString(field.fieldLabel) && typeof field.value === 'string' &&
      (field.optionIndex === undefined || (isFiniteNumber(field.optionIndex) && Number.isInteger(field.optionIndex) && field.optionIndex >= 0)) &&
      isOptionalTrimmedString(field.query) &&
      (field.choiceType === undefined || field.choiceType === 'select' || field.choiceType === 'group' || field.choiceType === 'listbox')
  }
  if (field.kind === 'toggle') {
    return hasOnlyKeys(field, FILL_FIELD_KEYS.toggle) && isTrimmedNonEmptyString(field.label) && isOptionalBoolean(field.checked) &&
      (field.controlType === undefined || field.controlType === 'checkbox' || field.controlType === 'radio') &&
      isOptionalTrimmedString(field.contextText) && isOptionalTrimmedString(field.sectionText)
  }
  if (field.kind === 'file') {
    return hasOnlyKeys(field, FILL_FIELD_KEYS.file) && isTrimmedNonEmptyString(field.fieldLabel) && Array.isArray(field.paths) && field.paths.length > 0 &&
      field.paths.every(isTrimmedNonEmptyString)
  }
  return false
}

export function isKeyMessage(msg: ParsedClientMessage): msg is ClientKeyMessage {
  const record = asRecord(msg)
  return !!record && record.type === 'key' &&
    hasOnlyKeys(record, MESSAGE_KEYS.key) &&
    (record.eventType === 'onKeyDown' || record.eventType === 'onKeyUp') &&
    typeof record.key === 'string' && typeof record.code === 'string' &&
    typeof record.shiftKey === 'boolean' && typeof record.ctrlKey === 'boolean' &&
    typeof record.metaKey === 'boolean' && typeof record.altKey === 'boolean' &&
    hasValidCommonFields(record)
}

export function isResizeMessage(msg: ParsedClientMessage): msg is ClientResizeMessage {
  const record = asRecord(msg)
  return !!record && record.type === 'resize' && hasOnlyKeys(record, MESSAGE_KEYS.resize) &&
    isFiniteNumber(record.width) && isFiniteNumber(record.height) &&
    (record.capabilities === undefined || (
      !!asRecord(record.capabilities) && hasOnlyKeys(record.capabilities as UnknownRecord, new Set(['binaryFraming'])) &&
      isOptionalBoolean((record.capabilities as UnknownRecord).binaryFraming)
    )) && hasValidCommonFields(record)
}

export function isNavigateMessage(msg: ParsedClientMessage): msg is ClientNavigateMessage {
  const record = asRecord(msg)
  return !!record && record.type === 'navigate' && hasOnlyKeys(record, MESSAGE_KEYS.navigate) &&
    isTrimmedNonEmptyString(record.url) && hasValidCommonFields(record)
}

export function isClickEventMessage(msg: ParsedClientMessage): msg is ClientEventMessage {
  const record = asRecord(msg)
  return !!record && record.type === 'event' && hasOnlyKeys(record, MESSAGE_KEYS.event) && record.eventType === 'onClick' &&
    isFiniteNumber(record.x) && isFiniteNumber(record.y) && hasValidCommonFields(record)
}

export function isCompositionMessage(msg: ParsedClientMessage): msg is ClientCompositionMessage {
  const record = asRecord(msg)
  return !!record && record.type === 'composition' && hasOnlyKeys(record, MESSAGE_KEYS.composition) &&
    (record.eventType === 'onCompositionStart' || record.eventType === 'onCompositionUpdate' || record.eventType === 'onCompositionEnd') &&
    typeof record.data === 'string' && hasValidCommonFields(record)
}

export function isFileMessage(msg: ParsedClientMessage): msg is ClientFileMessage {
  const record = asRecord(msg)
  return !!record && record.type === 'file' && hasOnlyKeys(record, MESSAGE_KEYS.file) &&
    Array.isArray(record.paths) && record.paths.length > 0 &&
    record.paths.every(isTrimmedNonEmptyString) &&
    (record.fieldId === undefined || isTrimmedNonEmptyString(record.fieldId)) &&
    (record.fieldKey === undefined || isClientFieldKey(record.fieldKey)) &&
    isOptionalFiniteNumber(record.x) && isOptionalFiniteNumber(record.y) &&
    isOptionalTrimmedString(record.fieldLabel) && isOptionalBoolean(record.exact) &&
    (record.strategy === undefined || record.strategy === 'auto' || record.strategy === 'chooser' || record.strategy === 'hidden' || record.strategy === 'drop') &&
    isOptionalFiniteNumber(record.dropX) && isOptionalFiniteNumber(record.dropY) && hasValidCommonFields(record)
}

export function isSetFieldTextMessage(msg: ParsedClientMessage): msg is ClientSetFieldTextMessage {
  const record = asRecord(msg)
  return !!record && record.type === 'setFieldText' && hasOnlyKeys(record, MESSAGE_KEYS.setFieldText) &&
    isTrimmedNonEmptyString(record.fieldLabel) &&
    typeof record.value === 'string' &&
    (record.fieldId === undefined || isTrimmedNonEmptyString(record.fieldId)) &&
    (record.fieldKey === undefined || isClientFieldKey(record.fieldKey)) &&
    isOptionalBoolean(record.exact) && isOptionalFiniteNumber(record.typingDelayMs) &&
    isOptionalBoolean(record.imeFriendly) && hasValidCommonFields(record)
}

export function isSetFieldChoiceMessage(msg: ParsedClientMessage): msg is ClientSetFieldChoiceMessage {
  const record = asRecord(msg)
  return !!record && record.type === 'setFieldChoice' && hasOnlyKeys(record, MESSAGE_KEYS.setFieldChoice) &&
    isTrimmedNonEmptyString(record.fieldLabel) &&
    typeof record.value === 'string' &&
    (record.fieldId === undefined || isTrimmedNonEmptyString(record.fieldId)) &&
    (record.fieldKey === undefined || isClientFieldKey(record.fieldKey)) &&
    (record.optionIndex === undefined || (isFiniteNumber(record.optionIndex) && Number.isInteger(record.optionIndex) && record.optionIndex >= 0)) &&
    isOptionalTrimmedString(record.query) && isOptionalBoolean(record.exact) &&
    (record.choiceType === undefined || record.choiceType === 'select' || record.choiceType === 'group' || record.choiceType === 'listbox') &&
    hasValidCommonFields(record)
}

export function isFillFieldsMessage(msg: ParsedClientMessage): msg is ClientFillFieldsMessage {
  const record = asRecord(msg)
  return !!record && record.type === 'fillFields' && hasOnlyKeys(record, FILL_FIELDS_MESSAGE_KEYS) &&
    Array.isArray(record.fields) && record.fields.length > 0 &&
    record.fields.every(isClientFillField) && hasValidCommonFields(record)
}

export function isFillOtpMessage(msg: ParsedClientMessage): msg is ClientFillOtpMessage {
  const record = asRecord(msg)
  return !!record && record.type === 'fillOtp' && hasOnlyKeys(record, MESSAGE_KEYS.fillOtp) &&
    isTrimmedNonEmptyString(record.value) &&
    isOptionalTrimmedString(record.fieldLabel) && isOptionalFiniteNumber(record.perCharDelayMs) &&
    hasValidCommonFields(record)
}

export function isSelectOptionMessage(msg: ParsedClientMessage): msg is ClientSelectOptionMessage {
  const record = asRecord(msg)
  return !!record && record.type === 'selectOption' && hasOnlyKeys(record, MESSAGE_KEYS.selectOption) &&
    isFiniteNumber(record.x) && isFiniteNumber(record.y) &&
    (record.value === undefined || typeof record.value === 'string') &&
    (record.label === undefined || typeof record.label === 'string') &&
    (record.index === undefined || (isFiniteNumber(record.index) && Number.isInteger(record.index) && record.index >= 0)) &&
    (record.value !== undefined || record.label !== undefined || record.index !== undefined) && hasValidCommonFields(record)
}

export function isWheelMessage(msg: ParsedClientMessage): msg is ClientWheelMessage {
  const record = asRecord(msg)
  return !!record && record.type === 'wheel' && hasOnlyKeys(record, MESSAGE_KEYS.wheel) && isOptionalFiniteNumber(record.deltaX) &&
    isOptionalFiniteNumber(record.deltaY) && isOptionalFiniteNumber(record.x) && isOptionalFiniteNumber(record.y) &&
    (record.deltaX !== undefined || record.deltaY !== undefined) && hasValidCommonFields(record)
}

export function isListboxPickMessage(msg: ParsedClientMessage): msg is ClientListboxPickMessage {
  const record = asRecord(msg)
  return !!record && record.type === 'listboxPick' && hasOnlyKeys(record, MESSAGE_KEYS.listboxPick) &&
    isTrimmedNonEmptyString(record.label) &&
    isOptionalBoolean(record.exact) && isOptionalFiniteNumber(record.openX) && isOptionalFiniteNumber(record.openY) &&
    (record.fieldId === undefined || isTrimmedNonEmptyString(record.fieldId)) &&
    (record.fieldKey === undefined || isClientFieldKey(record.fieldKey)) &&
    isOptionalTrimmedString(record.fieldLabel) && isOptionalTrimmedString(record.query) && hasValidCommonFields(record)
}

export function isSetCheckedMessage(msg: ParsedClientMessage): msg is ClientSetCheckedMessage {
  const record = asRecord(msg)
  return !!record && record.type === 'setChecked' && hasOnlyKeys(record, SET_CHECKED_MESSAGE_KEYS) &&
    isTrimmedNonEmptyString(record.label) &&
    (record.fieldKey === undefined || isClientFieldKey(record.fieldKey)) &&
    isOptionalBoolean(record.checked) && isOptionalBoolean(record.exact) &&
    (record.controlType === undefined || record.controlType === 'checkbox' || record.controlType === 'radio') &&
    isOptionalTrimmedString(record.contextText) && isOptionalTrimmedString(record.sectionText) &&
    hasValidCommonFields(record)
}

export function isScreenshotMessage(msg: ParsedClientMessage): msg is ClientScreenshotMessage {
  const record = asRecord(msg)
  return !!record && record.type === 'screenshot' && hasOnlyKeys(record, MESSAGE_KEYS.screenshot) && hasValidCommonFields(record)
}

export function isPdfGenerateMessage(msg: ParsedClientMessage): msg is ClientPdfGenerateMessage {
  const record = asRecord(msg)
  return !!record && record.type === 'pdfGenerate' && hasOnlyKeys(record, MESSAGE_KEYS.pdfGenerate) &&
    (record.html === undefined || typeof record.html === 'string') &&
    (record.format === undefined || record.format === 'A4' || record.format === 'Letter') &&
    isOptionalBoolean(record.landscape) && isOptionalTrimmedString(record.margin) &&
    isOptionalBoolean(record.printBackground) && hasValidCommonFields(record)
}

const KNOWN_CLIENT_MESSAGE_TYPES = new Set([
  'event',
  'key',
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
  'screenshot',
  'pdfGenerate',
])

/** Return an actionable wire-level error before a malformed message reaches Playwright. */
export function clientMessageValidationError(msg: ParsedClientMessage): string | null {
  const record = asRecord(msg)
  if (!record || typeof record.type !== 'string') return 'Invalid client message: expected an object with a string type'

  const valid = isClickEventMessage(msg) || isKeyMessage(msg) || isResizeMessage(msg) ||
    isNavigateMessage(msg) || isCompositionMessage(msg) || isFileMessage(msg) ||
    isSetFieldTextMessage(msg) || isSetFieldChoiceMessage(msg) || isFillFieldsMessage(msg) ||
    isFillOtpMessage(msg) || isListboxPickMessage(msg) || isSelectOptionMessage(msg) ||
    isSetCheckedMessage(msg) || isWheelMessage(msg) || isScreenshotMessage(msg) || isPdfGenerateMessage(msg)
  if (valid) return null

  if (!KNOWN_CLIENT_MESSAGE_TYPES.has(record.type)) {
    return `Unsupported client message type "${record.type}"`
  }
  if (record.type === 'setChecked') {
    if (!isTrimmedNonEmptyString(record.label)) {
      return 'Invalid setChecked message: label must be a trimmed, non-empty string'
    }
    const unknownKeys = Object.keys(record).filter(key => !SET_CHECKED_MESSAGE_KEYS.has(key))
    if (unknownKeys.length > 0) {
      return `Invalid setChecked message: unknown field(s): ${unknownKeys.join(', ')}`
    }
    if (record.fieldKey !== undefined && !isClientFieldKey(record.fieldKey)) {
      return 'Invalid setChecked message: fieldKey must be id:<id> or name:<tag>:<type-or-default>:<name>'
    }
  }
  if (record.type === 'fillFields') {
    const unknownTopLevelKeys = Object.keys(record).filter(key => !FILL_FIELDS_MESSAGE_KEYS.has(key))
    if (unknownTopLevelKeys.length > 0) {
      return `Invalid fillFields message: unknown field(s): ${unknownTopLevelKeys.join(', ')}`
    }
    if (Array.isArray(record.fields)) {
      for (let index = 0; index < record.fields.length; index++) {
        const field = asRecord(record.fields[index])
        if (!field || typeof field.kind !== 'string' || !(field.kind in FILL_FIELD_KEYS)) continue
        const allowed = FILL_FIELD_KEYS[field.kind as ClientFillField['kind']]
        const unknownKeys = Object.keys(field).filter(key => !allowed.has(key))
        if (unknownKeys.length > 0) {
          return `Invalid fillFields message: fields[${index}] has unknown field(s): ${unknownKeys.join(', ')}`
        }
      }
    }
  }
  return `Invalid client message "${record.type}": payload does not match the proxy protocol`
}
