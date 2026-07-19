import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { formatConnectFailureMessage, isHttpUrl, normalizeConnectTarget } from './connect-utils.js'
import {
  connect,
  connectThroughProxy,
  ensureSessionConnected,
  disconnect,
  pruneDisconnectedSessions,
  resolveSession,
  listSessions,
  getDefaultSessionId,
  prewarmProxy,
  sendClick,
  sendFillFields,
  sendFillOtp,
  sendType,
  sendKey,
  sendFileUpload,
  sendFieldText,
  sendFieldChoice,
  sendListboxPick,
  sendSelectOption,
  sendSetChecked,
  sendWheel,
  sendScreenshot,
  sendPdfGenerate,
  buildA11yTree,
  buildCompactUiIndex,
  buildFormRequiredSnapshot,
  buildPageModel,
  buildFormSchemas,
  formSchemaToFormGraph,
  expandPageSection,
  buildUiDelta,
  hasUiDelta,
  nodeIdForPath,
  nodeContextForNode,
  parseSectionId,
  findNodeByPath,
  summarizeCompactIndex,
  summarizePageModel,
  summarizeUiDelta,
  waitForUiCondition,
} from './session.js'
import type {
  A11yNode,
  BlockedSiteDetection,
  FormSchemaBuildOptions,
  FormSchemaField,
  FormSchemaModel,
  PageModel,
  ProxyFillField,
  Session,
  UpdateWaitResult,
} from './session.js'

type NodeStateFilterValue = boolean | 'mixed'
type ResponseDetail = 'terse' | 'minimal' | 'verbose'
type FormSchemaFormat = 'compact' | 'packed'
type FormSchemaResponseOptions = FormSchemaBuildOptions & {
  sinceSchemaId?: string
  format?: FormSchemaFormat
  includeFormGraph?: boolean
}
type BrowserMode = 'stock' | 'cloakbrowser'
type BlockedSitePolicy = 'continue' | 'manual-handoff' | 'error'

interface NodeFilter {
  id?: string
  role?: string
  name?: string
  text?: string
  contextText?: string
  promptText?: string
  sectionText?: string
  itemText?: string
  value?: string
  checked?: NodeStateFilterValue
  disabled?: boolean
  focused?: boolean
  selected?: boolean
  expanded?: boolean
  invalid?: boolean
  required?: boolean
  busy?: boolean
}

interface StepExecutionResult {
  summary: string
  compact: Record<string, unknown>
}

interface FieldStatePayload {
  role: string
  value?: string
  valueLength?: number
  state?: A11yNode['state']
  error?: string
}

interface ProxyFillAckResult {
  pageUrl?: string
  invalidCount: number
  alertCount: number
  dialogCount: number
  busyCount: number
  invalidFields?: Array<{ name?: string; error?: string }>
}

interface FormattedNodePayload extends Record<string, unknown> {
  id: string
  role: string
  name?: string
  value?: string
  center: { x: number; y: number }
  visibility: {
    intersectsViewport: boolean
    fullyVisible: boolean
    offscreenAbove: boolean
    offscreenBelow: boolean
    offscreenLeft: boolean
    offscreenRight: boolean
  }
  scrollHint: {
    status: 'visible' | 'partial' | 'offscreen'
    revealDeltaX: number
    revealDeltaY: number
  }
  path: number[]
}

interface RevealTargetResult {
  attempts: number
  target: FormattedNodePayload
}

interface ResolvedClickLocation {
  x: number
  y: number
  target?: FormattedNodePayload
  revealAttempts?: number
}

interface FormClickScope {
  formId: string
  path: number[]
  identity: FormScopeIdentity
}

interface FormScopeIdentity {
  role: string
  name: string
  fieldAnchors: string[]
}

interface WaitConditionResult {
  filter: NodeFilter
  present: boolean
  elapsedMs: number
  matchCount: number
  matches: FormattedNodePayload[]
}

function checkedStateInput() {
  return z
    .union([z.boolean(), z.literal('mixed')])
    .optional()
    .describe('Match checked state (`true`, `false`, or `mixed`)')
}

function detailInput() {
  return z
    .enum(['terse', 'minimal', 'verbose'])
    .optional()
    .default('minimal')
    .describe('`terse` returns compact machine-friendly JSON. `minimal` (default) returns short human-readable summaries. `verbose` adds fuller fallback context.')
}

function stealthInput() {
  return z
    .boolean()
    .optional()
    .describe('Launch CloakBrowser Chromium for authorized proxy-backed pageUrl testing. Default false unless GEOMETRA_STEALTH=1 or GEOMETRA_BROWSER=stealth is set.')
}

function browserModeInput() {
  return z
    .enum(['stock', 'cloakbrowser'])
    .optional()
    .describe('Explicit browser engine for proxy-backed sessions. `stock` forces Playwright Chromium; `cloakbrowser` opts into CloakBrowser for authorized testing. Conflicts with a contradictory stealth value.')
}

function blockDetectionInput() {
  return z
    .boolean()
    .optional()
    .default(true)
    .describe('Detect CAPTCHA/challenge/blocked/unsupported-browser pages and surface `blockedSite` metadata (default true).')
}

function blockedSitePolicyInput() {
  return z
    .enum(['continue', 'manual-handoff', 'error'])
    .optional()
    .default('continue')
    .describe('How to respond when blockDetection finds a blocked/challenge page: continue (default), manual-handoff (return handoff metadata), or error.')
}

function manualHandoffInput() {
  return z
    .boolean()
    .optional()
    .default(false)
    .describe('Shortcut for blockedSitePolicy="manual-handoff" when a blocked/challenge page is detected.')
}

function formSchemaFormatInput() {
  return z
    .enum(['compact', 'packed'])
    .optional()
    .default('compact')
    .describe('`compact` (default) returns readable JSON fields. Use `packed` for the smallest schema payload with short keys.')
}

function pageModelModeInput() {
  return z
    .enum(['inline', 'deferred'])
    .optional()
    .default('inline')
    .describe(
      'When returnPageModel=true, `inline` includes the full page model in the connect response. `deferred` returns connect as soon as the transport is ready and lets the caller fetch geometra_page_model separately.',
    )
}

function resolveBrowserStealth(input: {
  stealth?: boolean
  browserMode?: BrowserMode
}): { ok: true; stealth?: boolean } | { ok: false; error: string } {
  const modeStealth = input.browserMode === 'cloakbrowser'
    ? true
    : input.browserMode === 'stock'
      ? false
      : undefined

  if (modeStealth !== undefined && input.stealth !== undefined && input.stealth !== modeStealth) {
    return {
      ok: false,
      error: `Conflicting browser settings: browserMode="${input.browserMode}" implies stealth=${modeStealth}, but stealth=${input.stealth} was also provided.`,
    }
  }

  const stealth = input.stealth ?? modeStealth
  return stealth === undefined ? { ok: true } : { ok: true, stealth }
}

function effectiveBlockedSitePolicy(policy: BlockedSitePolicy, manualHandoff?: boolean): BlockedSitePolicy {
  return manualHandoff ? 'manual-handoff' : policy
}

function blockedSiteManualHandoffPayload(
  blockedSite: BlockedSiteDetection,
  options?: { pageUrl?: string; headless?: boolean },
): Record<string, unknown> {
  return {
    required: true,
    reason: blockedSite.hint ?? 'Blocked or challenge page detected',
    recommendedAction: blockedSite.recommendedAction ?? 'manual-handoff',
    message: 'Pause automation and let a user complete the challenge or review access in a normal visible browser session.',
    retry: {
      ...(options?.pageUrl ? { pageUrl: options.pageUrl } : {}),
      headless: false,
      blockDetection: true,
      blockedSitePolicy: 'continue',
    },
  }
}

function blockedSitePolicyErrorPayload(
  blockedSite: BlockedSiteDetection,
  policy: BlockedSitePolicy,
): Record<string, unknown> {
  return {
    blocked: true,
    blockedSite,
    blockedSitePolicy: policy,
    message: blockedSite.hint ?? 'Blocked or challenge page detected',
  }
}

function applyBlockedSitePolicyPayload(
  payload: Record<string, unknown>,
  blockedSite: BlockedSiteDetection | undefined,
  options: {
    policy: BlockedSitePolicy
    manualHandoff?: boolean
    pageUrl?: string
    headless?: boolean
  },
): Record<string, unknown> {
  if (!blockedSite?.detected) return payload

  const policy = effectiveBlockedSitePolicy(options.policy, options.manualHandoff)
  const next: Record<string, unknown> = {
    ...payload,
    blockedSite,
    blockedSitePolicy: policy,
  }
  if (policy === 'manual-handoff') {
    next.manualHandoff = blockedSiteManualHandoffPayload(blockedSite, options)
  }
  return next
}

function blockedSiteFromPayload(payload: Record<string, unknown>): BlockedSiteDetection | undefined {
  const value = payload.blockedSite
  if (!value || typeof value !== 'object') return undefined
  const candidate = value as BlockedSiteDetection
  return candidate.detected ? candidate : undefined
}

function blockedSiteErrorIfNeeded(
  payload: Record<string, unknown>,
  policy: BlockedSitePolicy,
  manualHandoff?: boolean,
): ReturnType<typeof err> | undefined {
  const effectivePolicy = effectiveBlockedSitePolicy(policy, manualHandoff)
  if (effectivePolicy !== 'error') return undefined
  const blockedSite = blockedSiteFromPayload(payload)
  if (!blockedSite) return undefined
  return err(JSON.stringify(blockedSitePolicyErrorPayload(blockedSite, effectivePolicy)))
}

function formSchemaContextInput() {
  return z
    .enum(['auto', 'always', 'none'])
    .optional()
    .default('auto')
    .describe('How much disambiguation context to include in form schema rows. `auto` keeps context only when it helps.')
}

function nodeFilterShape() {
  return {
    id: z.string().optional().describe('Stable node id from geometra_snapshot or geometra_expand_section'),
    role: z.string().optional().describe('ARIA role to match'),
    name: z.string().optional().describe('Accessible name to match (exact or substring)'),
    text: z.string().optional().describe('Text content to search for (substring match)'),
    contextText: z.string().optional().describe('Ancestor / prompt text to disambiguate repeated controls with the same visible name'),
    promptText: z.string().optional().describe('Nearby question/prompt text to disambiguate repeated controls or actions'),
    sectionText: z.string().optional().describe('Containing section/landmark/form/dialog text to disambiguate repeated controls or actions'),
    itemText: z.string().optional().describe('Nearby card/row/item label to disambiguate repeated actions like “Add to cart” or “Open incident”'),
    value: z.string().optional().describe('Displayed / current field value to match (substring match)'),
    checked: checkedStateInput(),
    disabled: z.boolean().optional().describe('Match disabled state'),
    focused: z.boolean().optional().describe('Match focused state'),
    selected: z.boolean().optional().describe('Match selected state'),
    expanded: z.boolean().optional().describe('Match expanded state'),
    invalid: z.boolean().optional().describe('Match invalid / failed-validation state'),
    required: z.boolean().optional().describe('Match required-field state'),
    busy: z.boolean().optional().describe('Match busy / in-progress state'),
  }
}

function waitConditionShape() {
  return {
    ...nodeFilterShape(),
    present: z
      .boolean()
      .optional()
      .default(true)
      .describe(
        'Wait until at least one node matches the filter (default true), or until no node matches (set false to wait out loading/parsing banners like “Parsing…” or “Parsing your resume”)',
      ),
    timeoutMs: z
      .number()
      .int()
      .min(50)
      .max(60_000)
      .optional()
      .default(10_000)
      .describe('Maximum time to wait before returning an error (default 10000ms)'),
  }
}

const GEOMETRA_QUERY_FILTER_REQUIRED_MESSAGE =
  'Provide at least one filter (id, role, name, text, contextText, promptText, sectionText, itemText, value, checked, disabled, focused, selected, expanded, invalid, required, or busy). ' +
  'This tool uses a strict schema: unknown keys are rejected. There is no textGone parameter — use text for substring matching. ' +
  'To wait until text disappears from the UI, use geometra_wait_for with text and present: false, or geometra_wait_for_resume_parse for typical resume “Parsing…” banners.'

const GEOMETRA_WAIT_FILTER_REQUIRED_MESSAGE =
  'Provide at least one semantic filter (id, role, name, text, contextText, promptText, sectionText, itemText, value, checked, disabled, focused, selected, expanded, invalid, required, or busy). ' +
  'This tool uses a strict schema: unknown keys are rejected. There is no textGone parameter — use text with a distinctive substring and present: false to wait until that text is gone ' +
  '(common for “Parsing…”, “Parsing your resume”, or similar). Passing only present/timeoutMs is not enough without a filter.'

/** Strict input so unknown keys (e.g. textGone) fail parse; empty-filter checks happen in handlers / waitForSemanticCondition. */
const sessionIdSchemaField = {
  sessionId: z.string().optional().describe('Session identifier returned by geometra_connect or an auto-connected tool. Omit only when exactly one non-isolated session is active.'),
}

const geometraQueryInputSchema = z.object({
  ...nodeFilterShape(),
  maxResults: z.number().int().min(1).max(50).optional().describe('Optional cap on returned matches; terse mode defaults to 8'),
  detail: detailInput(),
  ...sessionIdSchemaField,
}).strict()

const geometraWaitForInputSchema = z.object({
  ...waitConditionShape(),
  detail: detailInput(),
  ...sessionIdSchemaField,
}).strict()

/** Same upper bound as geometra_wait_for; resume uploads often need the full minute. */
const geometraWaitForResumeParseInputSchema = z
  .object({
    text: z
      .string()
      .min(1)
      .default('Parsing')
      .describe(
        'Substring that appears in the loading/parsing banner while work is in progress (default matches copy like “Parsing your resume”, “Parsing…”, “Parsing resume”, etc.)',
      ),
    timeoutMs: z
      .number()
      .int()
      .min(50)
      .max(60_000)
      .default(60_000)
      .describe('Maximum time to wait before returning an error (default 60000ms)'),
    ...sessionIdSchemaField,
  })
  .strict()

const timeoutMsInput = z.number().int().min(50).max(60_000).optional()
const HOST_SAFE_TOOL_TIMEOUT_MS = 20_000
const HOST_SAFE_TIMEOUT_RESERVE_MS = 750
const HOST_SAFE_REVEAL_TIMEOUT_MS = 8_000
const MIN_ACTION_TIMEOUT_MS = 50

function softTimeoutMsInput() {
  return z
    .number()
    .int()
    .min(1_000)
    .max(55_000)
    .optional()
    .default(HOST_SAFE_TOOL_TIMEOUT_MS)
    .describe(
      'Server-side soft deadline for this MCP call. When reached, the tool returns partial progress plus a resume hint before the MCP host request deadline can kill the call.',
    )
}

function remainingUntil(deadlineAt: number): number {
  return Math.max(0, Math.floor(deadlineAt - performance.now()))
}

function hasSoftBudget(deadlineAt: number, reserveMs = HOST_SAFE_TIMEOUT_RESERVE_MS): boolean {
  return remainingUntil(deadlineAt) > reserveMs
}

function timeoutCapFromDeadline(deadlineAt: number, reserveMs = HOST_SAFE_TIMEOUT_RESERVE_MS): number {
  return Math.max(MIN_ACTION_TIMEOUT_MS, remainingUntil(deadlineAt) - reserveMs)
}

function capTimeoutMs(timeoutMs: number | undefined, capMs: number, fallbackMs: number): number {
  return Math.max(MIN_ACTION_TIMEOUT_MS, Math.min(timeoutMs ?? fallbackMs, Math.max(MIN_ACTION_TIMEOUT_MS, Math.floor(capMs))))
}

function capFillFieldTimeout<T extends FillFieldInput | ResolvedFillFieldInput>(field: T, capMs: number, fallbackMs = 5_000): T {
  return {
    ...field,
    timeoutMs: capTimeoutMs(field.timeoutMs, capMs, fallbackMs),
  } as T
}

function capBatchActionTimeouts(action: BatchAction, capMs: number): BatchAction {
  switch (action.type) {
    case 'click':
      return {
        ...action,
        timeoutMs: capTimeoutMs(action.timeoutMs, capMs, 5_000),
        revealTimeoutMs: capTimeoutMs(action.revealTimeoutMs, capMs, 2_500),
        ...(action.waitFor ? { waitFor: { ...action.waitFor, timeoutMs: capTimeoutMs(action.waitFor.timeoutMs, capMs, 10_000) } } : {}),
      }
    case 'type':
    case 'key':
    case 'select_option':
    case 'set_checked':
    case 'wheel':
      return { ...action, timeoutMs: capTimeoutMs(action.timeoutMs, capMs, 5_000) }
    case 'upload_files':
      return { ...action, timeoutMs: capTimeoutMs(action.timeoutMs, capMs, 8_000) }
    case 'pick_listbox_option':
      return { ...action, timeoutMs: capTimeoutMs(action.timeoutMs, capMs, 4_500) }
    case 'wait_for':
      return { ...action, timeoutMs: capTimeoutMs(action.timeoutMs, capMs, 10_000) }
    case 'fill_fields':
      return {
        ...action,
        fields: action.fields.map(field => capFillFieldTimeout(field, capMs)),
      }
    case 'expand_section':
      return action
  }
}

const nonEmptyFieldIdSchema = z.string().trim().min(1, 'fieldId must not be empty')
const nonEmptyFieldLabelSchema = z.string().trim().min(1, 'fieldLabel must not be empty')
const nonEmptyToggleLabelSchema = z.string().trim().min(1, 'toggle label must not be empty')

type FileUploadStrategy = 'auto' | 'chooser' | 'hidden' | 'drop'

interface FileUploadContractInput {
  x?: number
  y?: number
  fieldLabel?: string
  exact?: boolean
  strategy?: FileUploadStrategy
  dropX?: number
  dropY?: number
  contextText?: string
  sectionText?: string
}

interface ListboxPickContractInput {
  fieldId?: string
  fieldKey?: string
  fieldLabel?: string
}

interface SelectOptionContractInput {
  x?: number
  y?: number
  value?: string
  label?: string
  index?: number
}

function incompleteCoordinatePairError(
  input: Record<string, unknown>,
  first: string,
  second: string,
): string | undefined {
  const hasFirst = input[first] !== undefined
  const hasSecond = input[second] !== undefined
  return hasFirst === hasSecond
    ? undefined
    : `${first} and ${second} must be provided together`
}

function fileUploadContractError(input: FileUploadContractInput): string | undefined {
  const clickPairError = incompleteCoordinatePairError(input as Record<string, unknown>, 'x', 'y')
  if (clickPairError) return clickPairError
  const dropPairError = incompleteCoordinatePairError(input as Record<string, unknown>, 'dropX', 'dropY')
  if (dropPairError) return dropPairError

  const hasClick = input.x !== undefined && input.y !== undefined
  const hasDrop = input.dropX !== undefined && input.dropY !== undefined
  const hasFieldLabel = typeof input.fieldLabel === 'string' && input.fieldLabel.trim().length > 0
  const hasSemanticConstraint = hasFieldLabel || input.contextText !== undefined || input.sectionText !== undefined || input.exact !== undefined
  const strategy = input.strategy ?? 'auto'

  if ((input.contextText !== undefined || input.sectionText !== undefined || input.exact !== undefined) && !hasFieldLabel) {
    return 'contextText, sectionText, and exact require fieldLabel'
  }

  if (strategy === 'chooser') {
    if (!hasClick) return 'chooser strategy requires x and y'
    if (hasDrop || hasSemanticConstraint) return 'chooser strategy accepts only an x,y target; semantic and drop targets cannot be combined'
    return undefined
  }

  if (strategy === 'drop') {
    if (!hasDrop) return 'drop strategy requires dropX and dropY'
    if (hasClick || hasSemanticConstraint) return 'drop strategy accepts only a dropX,dropY target; chooser and semantic targets cannot be combined'
    return undefined
  }

  if (strategy === 'hidden') {
    if (!hasFieldLabel) return 'hidden strategy requires fieldLabel to prevent a global first-input fallback'
    if (hasClick || hasDrop) return 'hidden strategy does not accept chooser or drop coordinates'
    return undefined
  }

  if (hasDrop) return 'dropX and dropY require strategy="drop"'
  if (hasClick && hasFieldLabel) return 'auto strategy requires exactly one target: either x,y or fieldLabel'
  if (!hasClick && !hasFieldLabel) return 'upload_files requires an explicit target: fieldLabel, x and y, or strategy="drop" with dropX and dropY'
  return undefined
}

function listboxPickContractError(input: ListboxPickContractInput): string | undefined {
  if (typeof input.fieldLabel !== 'string' || input.fieldLabel.trim().length === 0) {
    return 'pick_listbox_option requires fieldLabel so the committed field can be confirmed'
  }
  return undefined
}

function selectOptionContractError(input: SelectOptionContractInput): string | undefined {
  const coordinateError = incompleteCoordinatePairError(input as Record<string, unknown>, 'x', 'y')
  if (coordinateError) return coordinateError
  if (input.x === undefined || input.y === undefined) return 'select_option requires x and y'
  const selectorCount = Number(input.value !== undefined) + Number(input.label !== undefined) + Number(input.index !== undefined)
  if (selectorCount === 0) return 'select_option requires at least one of value, label, or index'
  return undefined
}

function addActionContractIssue(ctx: z.RefinementCtx, message: string | undefined): void {
  if (!message) return
  ctx.addIssue({ code: z.ZodIssueCode.custom, message })
}

const fillFieldSchema = z.union([
  z.object({
    kind: z.literal('text'),
    fieldId: nonEmptyFieldIdSchema.optional().describe('Optional stable field id from geometra_form_schema'),
    fieldLabel: nonEmptyFieldLabelSchema.describe('Visible field label / accessible name. Optional to duplicate when fieldId is present.'),
    value: z.string().describe('Text value to set'),
    exact: z.boolean().optional().describe('Exact label match'),
    typingDelayMs: z
      .number()
      .int()
      .min(0)
      .max(500)
      .optional()
      .describe('Milliseconds between keystrokes when the proxy falls back to keyboard typing (masked inputs).'),
    imeFriendly: z
      .boolean()
      .optional()
      .describe('Use composition-friendly events for IME-heavy controlled fields.'),
    timeoutMs: timeoutMsInput.describe('Optional action wait timeout'),
  }).strict(),
  z.object({
    kind: z.literal('text'),
    fieldId: nonEmptyFieldIdSchema.describe('Stable field id from geometra_form_schema'),
    fieldLabel: nonEmptyFieldLabelSchema.optional().describe('Optional when fieldId is present; MCP resolves the current label from geometra_form_schema'),
    value: z.string().describe('Text value to set'),
    exact: z.boolean().optional().describe('Exact label match'),
    typingDelayMs: z
      .number()
      .int()
      .min(0)
      .max(500)
      .optional()
      .describe('Milliseconds between keystrokes when the proxy falls back to keyboard typing (masked inputs).'),
    imeFriendly: z
      .boolean()
      .optional()
      .describe('Use composition-friendly events for IME-heavy controlled fields.'),
    timeoutMs: timeoutMsInput.describe('Optional action wait timeout'),
  }).strict(),
  z.object({
    kind: z.literal('choice'),
    fieldId: nonEmptyFieldIdSchema.optional().describe('Optional stable field id from geometra_form_schema'),
    fieldLabel: nonEmptyFieldLabelSchema.describe('Visible field label / accessible name. Optional to duplicate when fieldId is present.'),
    value: z.string().describe('Desired option value / answer label'),
    optionIndex: z.number().int().min(0).optional().describe('Exact native <select> option index from optionDetails'),
    query: z.string().optional().describe('Optional search text for searchable comboboxes'),
    choiceType: z
      .enum(['select', 'group', 'listbox'])
      .optional()
      .describe('Optional choice subtype hint. Use `group` for repeated radio/button answers, `select` for native selects, and `listbox` for searchable dropdowns.'),
    exact: z.boolean().optional().describe('Exact label match'),
    timeoutMs: timeoutMsInput.describe('Optional action wait timeout'),
  }).strict(),
  z.object({
    kind: z.literal('choice'),
    fieldId: nonEmptyFieldIdSchema.describe('Stable field id from geometra_form_schema'),
    fieldLabel: nonEmptyFieldLabelSchema.optional().describe('Optional when fieldId is present; MCP resolves the current label from geometra_form_schema'),
    value: z.string().describe('Desired option value / answer label'),
    optionIndex: z.number().int().min(0).optional().describe('Exact native <select> option index from optionDetails'),
    query: z.string().optional().describe('Optional search text for searchable comboboxes'),
    choiceType: z
      .enum(['select', 'group', 'listbox'])
      .optional()
      .describe('Optional choice subtype hint. Use `group` for repeated radio/button answers, `select` for native selects, and `listbox` for searchable dropdowns.'),
    exact: z.boolean().optional().describe('Exact label match'),
    timeoutMs: timeoutMsInput.describe('Optional action wait timeout'),
  }).strict(),
  z.object({
    kind: z.literal('toggle'),
    fieldId: nonEmptyFieldIdSchema.optional().describe('Optional stable field id from geometra_form_schema'),
    label: nonEmptyToggleLabelSchema.describe('Visible checkbox/radio label to set. Optional to duplicate when fieldId is present.'),
    checked: z.boolean().optional().default(true).describe('Desired checked state (default true)'),
    exact: z.boolean().optional().describe('Exact label match'),
    controlType: z.enum(['checkbox', 'radio']).optional().describe('Limit matching to checkbox or radio'),
    timeoutMs: timeoutMsInput.describe('Optional action wait timeout'),
  }).strict(),
  z.object({
    kind: z.literal('toggle'),
    fieldId: nonEmptyFieldIdSchema.describe('Stable field id from geometra_form_schema'),
    label: nonEmptyToggleLabelSchema.optional().describe('Optional when fieldId is present; MCP resolves the current label from geometra_form_schema'),
    checked: z.boolean().optional().default(true).describe('Desired checked state (default true)'),
    exact: z.boolean().optional().describe('Exact label match'),
    controlType: z.enum(['checkbox', 'radio']).optional().describe('Limit matching to checkbox or radio'),
    timeoutMs: timeoutMsInput.describe('Optional action wait timeout'),
  }).strict(),
  z.object({
    kind: z.literal('file'),
    fieldId: nonEmptyFieldIdSchema.optional().describe('Optional stable field id from geometra_form_schema'),
    fieldLabel: nonEmptyFieldLabelSchema.describe('Visible file-field label / accessible name'),
    paths: z.array(z.string()).min(1).describe('Absolute paths on the proxy machine'),
    exact: z.boolean().optional().describe('Exact label match'),
    timeoutMs: timeoutMsInput.describe('Optional action wait timeout'),
  }).strict(),
  z.object({
    kind: z.literal('file'),
    fieldId: nonEmptyFieldIdSchema.describe('Stable field id from geometra_form_schema'),
    fieldLabel: nonEmptyFieldLabelSchema.optional().describe('Optional when fieldId is present; MCP resolves the current label when file fields are exposed by geometra_form_schema'),
    paths: z.array(z.string()).min(1).describe('Absolute paths on the proxy machine'),
    exact: z.boolean().optional().describe('Exact label match'),
    timeoutMs: timeoutMsInput.describe('Optional action wait timeout'),
  }).strict(),
])

type FillFieldInput = z.infer<typeof fillFieldSchema>
type ResolvedFillFieldInput =
  | {
      kind: 'text'
      fieldId?: string
      fieldKey?: string
      fieldLabel: string
      value: string
      exact?: boolean
      timeoutMs?: number
      typingDelayMs?: number
      imeFriendly?: boolean
    }
  | {
      kind: 'choice'
      fieldId?: string
      fieldKey?: string
      fieldLabel: string
      value: string
      optionIndex?: number
      expectedReadback?: string
      query?: string
      choiceType?: 'select' | 'group' | 'listbox'
      exact?: boolean
      timeoutMs?: number
    }
  | {
      kind: 'toggle'
      fieldId?: string
      fieldKey?: string
      label: string
      checked: boolean
      controlType?: 'checkbox' | 'radio'
      exact?: boolean
      timeoutMs?: number
    }
  | { kind: 'file'; fieldId?: string; fieldKey?: string; fieldLabel: string; paths: string[]; exact?: boolean; timeoutMs?: number }

function toProxyFillFields(fields: ResolvedFillFieldInput[]): ProxyFillField[] {
  return fields.map(field => {
    const proxyField = { ...field }
    delete proxyField.timeoutMs
    if (proxyField.kind === 'choice') delete proxyField.expectedReadback
    return proxyField
  })
}

const formValueSchema = z.union([
  z.string(),
  z.boolean(),
  z.array(z.string()).min(1),
])

type FormValueInput = z.infer<typeof formValueSchema>
const formValuesRecordSchema = z.record(z.string(), formValueSchema)

const batchActionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('click'),
    x: z.number().optional().describe('X coordinate to click'),
    y: z.number().optional().describe('Y coordinate to click'),
    ...nodeFilterShape(),
    index: z.number().int().min(0).optional().describe('Which matching semantic target to click after sorting top-to-bottom'),
    fullyVisible: z.boolean().optional().describe('When clicking by semantic target, require full visibility before clicking (default true)'),
    maxRevealSteps: z.number().int().min(1).max(48).optional().describe('Maximum reveal attempts before clicking a semantic target. When omitted, Geometra auto-scales from scroll distance for tall forms.'),
    revealTimeoutMs: timeoutMsInput.describe('Per-scroll wait timeout while revealing a semantic target'),
    waitFor: z.object(waitConditionShape()).strict().optional().describe('Optional semantic condition to wait for after the click'),
    timeoutMs: timeoutMsInput,
  }).strict(),
  z.object({
    type: z.literal('type'),
    text: z.string().max(65_536),
    timeoutMs: timeoutMsInput,
  }).strict(),
  z.object({
    type: z.literal('key'),
    key: z.string(),
    shift: z.boolean().optional(),
    ctrl: z.boolean().optional(),
    meta: z.boolean().optional(),
    alt: z.boolean().optional(),
    timeoutMs: timeoutMsInput,
  }).strict(),
  z.object({
    type: z.literal('upload_files'),
    paths: z.array(z.string().trim().min(1)).min(1),
    x: z.number().optional(),
    y: z.number().optional(),
    fieldLabel: z.string().trim().min(1).optional(),
    exact: z.boolean().optional(),
    strategy: z.enum(['auto', 'chooser', 'hidden', 'drop']).optional(),
    dropX: z.number().optional(),
    dropY: z.number().optional(),
    contextText: z.string().trim().min(1).optional(),
    sectionText: z.string().trim().min(1).optional(),
    timeoutMs: timeoutMsInput,
  }).strict(),
  z.object({
    type: z.literal('pick_listbox_option'),
    label: z.string().trim().min(1),
    exact: z.boolean().optional(),
    fieldId: z.string().trim().min(1).optional(),
    fieldKey: z.string().trim().min(1).optional(),
    fieldLabel: z.string().trim().min(1),
    query: z.string().optional(),
    timeoutMs: timeoutMsInput,
  }).strict(),
  z.object({
    type: z.literal('select_option'),
    x: z.number(),
    y: z.number(),
    value: z.string().optional(),
    label: z.string().trim().min(1).optional(),
    index: z.number().int().min(0).optional(),
    timeoutMs: timeoutMsInput,
  }).strict(),
  z.object({
    type: z.literal('set_checked'),
    label: z.string().trim().min(1, 'set_checked label must not be empty'),
    checked: z.boolean().optional(),
    exact: z.boolean().optional(),
    controlType: z.enum(['checkbox', 'radio']).optional(),
    fieldKey: z.string().trim().min(1).optional(),
    contextText: z.string().trim().min(1).optional(),
    sectionText: z.string().trim().min(1).optional(),
    timeoutMs: timeoutMsInput,
  }).strict(),
  z.object({
    type: z.literal('wheel'),
    deltaY: z.number(),
    deltaX: z.number().optional(),
    x: z.number().optional(),
    y: z.number().optional(),
    timeoutMs: timeoutMsInput,
  }).strict(),
  z.object({
    type: z.literal('wait_for'),
    ...nodeFilterShape(),
    present: z.boolean().optional(),
    timeoutMs: timeoutMsInput,
  }).strict(),
  z.object({
    type: z.literal('fill_fields'),
    fields: z.array(fillFieldSchema).min(1).max(80),
    verifyFills: z
      .boolean()
      .optional()
      .describe('After filling, read each text/choice field back and flag mismatches (e.g. autocomplete rejected input, format transformed). Adds a `verification` entry to the step.'),
  }).strict(),
  z.object({
    type: z.literal('expand_section'),
    id: z.string().describe('Stable section id from geometra_page_model (e.g. fm:1.0, ls:2.1).'),
    maxHeadings: z.number().int().min(1).max(20).optional(),
    maxFields: z.number().int().min(1).max(40).optional(),
    fieldOffset: z.number().int().min(0).optional(),
    onlyRequiredFields: z.boolean().optional(),
    onlyInvalidFields: z.boolean().optional(),
    maxActions: z.number().int().min(1).max(30).optional(),
    actionOffset: z.number().int().min(0).optional(),
    maxLists: z.number().int().min(0).max(20).optional(),
    listOffset: z.number().int().min(0).optional(),
    maxItems: z.number().int().min(0).max(50).optional(),
    itemOffset: z.number().int().min(0).optional(),
    maxTextPreview: z.number().int().min(0).max(20).optional(),
    includeBounds: z.boolean().optional(),
  }).strict(),
]).superRefine((action, ctx) => {
  if (action.type === 'upload_files') {
    addActionContractIssue(ctx, fileUploadContractError(action))
  } else if (action.type === 'pick_listbox_option') {
    addActionContractIssue(ctx, listboxPickContractError(action))
  } else if (action.type === 'select_option') {
    addActionContractIssue(ctx, selectOptionContractError(action))
  }
})

type BatchAction = z.infer<typeof batchActionSchema>

export function createServer(): McpServer {
  const server = new McpServer(
    { name: 'geometra', version: '1.19.26' },
    { capabilities: { tools: {} } },
  )

  const sessionIdInput = z.string().optional().describe(
    'Session identifier returned by geometra_connect or an auto-connected tool. Omit only when exactly one non-isolated session is active.',
  )

  // ── connect ──────────────────────────────────────────────────
  server.tool(
    'geometra_connect',
    `Connect to a Geometra WebSocket peer, or start \`geometra-proxy\` automatically for a normal web page.

**Prefer \`pageUrl\` for job sites and SPAs:** pass \`https://…\` and this server spawns geometra-proxy on an ephemeral local port and connects — you do **not** need a separate terminal or a \`ws://\` URL (fewer IDE approval steps for the human).

Use \`url\` (ws://…) only when a Geometra/native server or an already-running proxy is listening. If you accidentally pass \`https://…\` in \`url\`, MCP treats it like \`pageUrl\` and starts the proxy for you.

Chromium runs **headless** by default unless \`headless: false\`. Pass \`stealth: true\` (or set \`GEOMETRA_STEALTH=1\`) to opt into CloakBrowser's Chromium for authorized testing instead of stock Playwright Chromium. File upload / wheel / native \`<select>\` need the proxy path (\`pageUrl\` or ws to proxy). Set \`returnForms: true\` and/or \`returnPageModel: true\` when you want a lower-turn startup response. When connect first-response latency matters more than inlining the page model, pair \`returnPageModel: true\` with \`pageModelMode: "deferred"\` and call \`geometra_page_model\` next.

**Session isolation:** browser sessions started from \`pageUrl\` (or an HTTP(S) \`url\`) are isolated by default: each gets a fresh Chromium that is destroyed on disconnect. Pass \`isolated: false\` explicitly only when you intentionally want sequential warm-browser reuse, including shared cookies, localStorage, and page state. Direct \`ws://\` connections attach to an externally managed endpoint and cannot create browser isolation.`,
    {
      url: z
        .string()
        .optional()
        .describe(
          'WebSocket URL when a server is already running (e.g. ws://127.0.0.1:3200 or ws://localhost:3100). If you pass http(s) here by mistake, MCP will treat it as a page URL and start geometra-proxy.',
        ),
      authToken: z
        .string()
        .min(32)
        .optional()
        .describe(
          'Bearer capability for an already-running authenticated geometra-proxy. Kept private and never returned in session metadata. Not needed when pageUrl starts the proxy automatically.',
        ),
      pageUrl: z
        .string()
        .url()
        .refine(isHttpUrl, 'pageUrl must use http:// or https://')
        .optional()
        .describe(
          'HTTP(S) page to open. MCP starts geometra-proxy and connects automatically. Use this instead of url for most web apply flows.',
        ),
      port: z
        .number()
        .int()
        .positive()
        .max(65535)
        .optional()
        .describe('Preferred local port for spawned proxy (default: ephemeral OS-assigned port).'),
      headless: z
        .boolean()
        .optional()
        .describe('Run Chromium headless (default true). Set false for a visible window.'),
      width: z.number().int().positive().optional().describe('Viewport width for spawned proxy.'),
      height: z.number().int().positive().optional().describe('Viewport height for spawned proxy.'),
      slowMo: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe('Playwright slowMo (ms) on spawned proxy for easier visual following.'),
      stealth: stealthInput(),
      browserMode: browserModeInput(),
      isolated: z
        .boolean()
        .optional()
        .describe('For pageUrl/HTTP(S) browser connects, omission uses a fresh Chromium that is destroyed on disconnect. Pass false explicitly to opt into sequential warm-browser reuse and shared browser state. Direct ws:// endpoints are externally managed.'),
      proxy: z
        .object({
          server: z
            .string()
            .describe('Proxy URL (http://host:port, https://host:port, or socks5://host:port).'),
          username: z.string().optional().describe('Proxy auth username.'),
          password: z.string().optional().describe('Proxy auth password.'),
          bypass: z
            .string()
            .optional()
            .describe('Comma-separated host patterns to bypass (e.g. "*.internal,localhost").'),
        })
        .optional()
        .describe(
          'BYO outbound proxy for the spawned Chromium. Routes browser traffic through the supplied HTTP/SOCKS proxy. Use only proxies you are authorized to use and in line with the target site rules. The reusable proxy pool is partitioned by proxy identity so callers with different proxy configs never share a Chromium instance.',
        ),
      returnForms: z
        .boolean()
        .optional()
        .default(true)
        .describe('Include compact form schema discovery in the connect response (default true). Set false to skip form discovery for non-form workflows.'),
      returnPageModel: z
        .boolean()
        .optional()
        .default(false)
        .describe('Include geometra_page_model output in the connect response so exploration can start in one turn.'),
      pageModelMode: pageModelModeInput(),
      blockDetection: blockDetectionInput(),
      blockedSitePolicy: blockedSitePolicyInput(),
      manualHandoff: manualHandoffInput(),
      formId: z.string().optional().describe('Optional form id filter when returnForms=true'),
      maxFields: z.number().int().min(1).max(120).optional().default(80).describe('Cap returned fields per form when returnForms=true'),
      onlyRequiredFields: z.boolean().optional().default(false).describe('Only include required fields when returnForms=true'),
      onlyInvalidFields: z.boolean().optional().default(false).describe('Only include invalid fields when returnForms=true'),
      includeOptions: z.boolean().optional().default(false).describe('Include explicit choice option labels in returned form schemas'),
      includeFormGraph: z.boolean().optional().default(false).describe('Also include FormGraph 0.1-compatible graphs in returned form schemas. Use for paperwork/application workflows that need field paths, review gates, and source anchors.'),
      includeContext: formSchemaContextInput(),
      sinceSchemaId: z.string().optional().describe('If the current schema matches this id, return changed=false without resending forms'),
      schemaFormat: formSchemaFormatInput(),
      maxPrimaryActions: z.number().int().min(1).max(12).optional().default(6).describe('Cap top-level primary actions when returnPageModel=true'),
      maxSectionsPerKind: z.number().int().min(1).max(16).optional().default(8).describe('Cap returned landmarks/forms/dialogs/lists per kind when returnPageModel=true'),
      detail: detailInput(),
    },
    async input => {
      const normalized = normalizeConnectTarget({ url: input.url, pageUrl: input.pageUrl })
      if (!normalized.ok) return err(normalized.error)
      const browser = resolveBrowserStealth({ stealth: input.stealth, browserMode: input.browserMode })
      if (!browser.ok) return err(browser.error)
      const target = normalized.value
      if (target.kind === 'ws' && input.isolated === true) {
        return err('isolated:true is unsupported for direct ws:// endpoints because MCP does not own that browser/runtime. Use pageUrl/HTTP(S) url for an isolated browser, or omit isolated for the externally managed endpoint.')
      }
      const formSchema = {
        formId: input.formId,
        maxFields: input.maxFields,
        onlyRequiredFields: input.onlyRequiredFields,
        onlyInvalidFields: input.onlyInvalidFields,
        includeOptions: input.includeOptions,
        includeFormGraph: input.includeFormGraph,
        includeContext: input.includeContext,
        sinceSchemaId: input.sinceSchemaId,
        format: input.schemaFormat,
      }
      const pageModelOptions = {
        maxPrimaryActions: input.maxPrimaryActions,
        maxSectionsPerKind: input.maxSectionsPerKind,
      }
      const deferInlinePageModel =
        input.returnPageModel
        && input.pageModelMode === 'deferred'
        && !input.returnForms
        && input.detail !== 'verbose'

      try {
        if (target.kind === 'proxy') {
          const session = await connectThroughProxy({
            pageUrl: target.pageUrl!,
            port: input.port,
            headless: input.headless,
            width: input.width,
            height: input.height,
            slowMo: input.slowMo,
            ...(browser.stealth !== undefined && { stealth: browser.stealth }),
            isolated: input.isolated !== false,
            proxy: input.proxy,
            awaitInitialFrame: deferInlinePageModel ? false : undefined,
            eagerInitialExtract: deferInlinePageModel ? true : undefined,
          })
          if (input.returnForms) {
            await stabilizeInlineFormSchemas(session, formSchema)
          }
          const payload = connectResponsePayload(session, {
            transport: 'proxy',
            requestedPageUrl: target.pageUrl,
            autoCoercedFromUrl: target.autoCoercedFromUrl,
            detail: input.detail,
            returnForms: input.returnForms,
            returnPageModel: input.returnPageModel,
            pageModelMode: input.pageModelMode,
            blockDetection: input.blockDetection,
            blockedSitePolicy: input.blockedSitePolicy,
            manualHandoff: input.manualHandoff,
            formSchema,
            pageModelOptions,
            headless: input.headless,
          })
          const blockedError = blockedSiteErrorIfNeeded(payload, input.blockedSitePolicy, input.manualHandoff)
          if (blockedError) return blockedError
          return ok(JSON.stringify(payload, null, input.detail === 'verbose' ? 2 : undefined))
        }
        const session = await connect(target.wsUrl!, {
          width: input.width,
          height: input.height,
          awaitInitialFrame: deferInlinePageModel ? false : undefined,
          authToken: input.authToken,
        })
        if (input.returnForms) {
          await stabilizeInlineFormSchemas(session, formSchema)
        }
        const payload = connectResponsePayload(session, {
          transport: 'ws',
          requestedWsUrl: target.wsUrl,
          autoCoercedFromUrl: false,
          detail: input.detail,
          returnForms: input.returnForms,
          returnPageModel: input.returnPageModel,
          pageModelMode: input.pageModelMode,
          blockDetection: input.blockDetection,
          blockedSitePolicy: input.blockedSitePolicy,
          manualHandoff: input.manualHandoff,
          formSchema,
          pageModelOptions,
          headless: input.headless,
        })
        const blockedError = blockedSiteErrorIfNeeded(payload, input.blockedSitePolicy, input.manualHandoff)
        if (blockedError) return blockedError
        return ok(JSON.stringify(payload, null, input.detail === 'verbose' ? 2 : undefined))
      } catch (e) {
        return err(`Failed to connect: ${formatConnectFailureMessage(e, target)}`)
      }
    }
  )

  // ── prepare browser ──────────────────────────────────────────
  server.tool(
    'geometra_prepare_browser',
    `Pre-launch and pre-navigate a reusable geometra-proxy browser for a normal web page without creating an active MCP session.

Use this when you can prepare ahead of the user-facing task so the next \`geometra_connect\` or one-call \`geometra_run_actions\` on the same \`pageUrl\` / viewport / headless settings skips the cold browser launch. The consuming call must pass \`isolated: false\` explicitly; isolated browser connects intentionally ignore the warm pool.`,
    {
      pageUrl: z
        .string()
        .url()
        .refine(isHttpUrl, 'pageUrl must use http:// or https://')
        .describe('HTTP(S) page to open and keep warm for the next proxy-backed task.'),
      port: z
        .number()
        .int()
        .positive()
        .max(65535)
        .optional()
        .describe('Preferred local port for spawned proxy (default: ephemeral OS-assigned port).'),
      headless: z
        .boolean()
        .optional()
        .describe('Run Chromium headless (default true). Set false for a visible window.'),
      width: z.number().int().positive().optional().describe('Viewport width for the warmed browser.'),
      height: z.number().int().positive().optional().describe('Viewport height for the warmed browser.'),
      slowMo: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe('Playwright slowMo (ms) for the warmed browser.'),
      stealth: stealthInput(),
      browserMode: browserModeInput(),
      proxy: z
        .object({
          server: z
            .string()
            .describe('Proxy URL (http://host:port, https://host:port, or socks5://host:port).'),
          username: z.string().optional().describe('Proxy auth username.'),
          password: z.string().optional().describe('Proxy auth password.'),
          bypass: z
            .string()
            .optional()
            .describe('Comma-separated host patterns to bypass.'),
        })
        .optional()
        .describe(
          'BYO outbound proxy for the warmed Chromium. The pool entry is partitioned by proxy identity, so a later geometra_connect with the same proxy config will reuse this warmed browser; a different proxy config (or no proxy) will not.',
        ),
    },
    async ({ pageUrl, port, headless, width, height, slowMo, stealth, browserMode, proxy }) => {
      try {
        const browser = resolveBrowserStealth({ stealth, browserMode })
        if (!browser.ok) return err(browser.error)
        const prepared = await prewarmProxy({
          pageUrl,
          port,
          headless,
          width,
          height,
          slowMo,
          ...(browser.stealth !== undefined && { stealth: browser.stealth }),
          proxy,
        })
        return ok(JSON.stringify(prepared))
      } catch (e) {
        return err(`Failed to prepare browser: ${e instanceof Error ? e.message : String(e)}`)
      }
    },
  )

  // ── query ────────────────────────────────────────────────────
  server.registerTool(
    'geometra_query',
    {
      description: `Find elements in the current Geometra UI by stable id, role, name, text content, current value, or semantic state. Returns matching elements with their exact pixel bounds {x, y, width, height}, visible in-viewport bounds, an on-screen center point, visibility / scroll-reveal hints, role, name, value, state, and tree path.

This is the Geometra equivalent of Playwright's locator — but instant, structured, and with no browser. Use the returned bounds to click elements or assert on layout.

Unknown parameter names are rejected (strict schema). To wait until visible text goes away (e.g. a parsing banner), use geometra_wait_for with that substring in text and present: false — there is no textGone field.`,
      inputSchema: geometraQueryInputSchema,
    },
    async ({ id, role, name, text, contextText, promptText, sectionText, itemText, value, checked, disabled, focused, selected, expanded, invalid, required, busy, maxResults, detail, sessionId }) => {
      const sessionResult = resolveToolSession(sessionId)
      if ('error' in sessionResult) return sessionResult.error
      const session = sessionResult.session

      const a11y = await sessionA11yWhenReady(session)
      if (!a11y) return err('No UI tree available')
      const filter: NodeFilter = {
        id,
        role,
        name,
        text,
        contextText,
        promptText,
        sectionText,
        itemText,
        value,
        checked,
        disabled,
        focused,
        selected,
        expanded,
        invalid,
        required,
        busy,
      }
      if (!hasNodeFilter(filter)) return err(GEOMETRA_QUERY_FILTER_REQUIRED_MESSAGE)
      const matches = findNodes(a11y, filter)

      if (matches.length === 0) {
        if (detail === 'terse') {
          return ok(JSON.stringify({ matchCount: 0, filter: compactFilterPayload(filter) }))
        }
        return ok(`No elements found matching ${JSON.stringify(filter)}`)
      }

      const formatted = sortA11yNodes(matches).map(node => formatNode(node, a11y, a11y.bounds))
      if (detail === 'terse') {
        const limited = formatted.slice(0, maxResults ?? 8)
        return ok(JSON.stringify({
          matchCount: formatted.length,
          matches: limited.map(compactFormattedNode),
        }))
      }
      const result = typeof maxResults === 'number' ? formatted.slice(0, maxResults) : formatted
      return ok(JSON.stringify(result, null, 2))
    }
  )

  server.tool(
    'geometra_find_action',
    `Resolve a clickable action by action label plus optional section, prompt, or item/card text. This is a narrower, lower-token path for repeated actions like "Open incident" in a queue row or "Add to cart" inside a product card.

Use this when geometra_page_model tells you the page shape, but you want one direct semantic action target instead of expanding a whole section.`,
    {
      name: z.string().describe('Action label / accessible name to match'),
      role: z.enum(['button', 'link']).optional().describe('Optional action role hint (button or link)'),
      sectionText: z.string().optional().describe('Containing section/landmark/form/dialog text to disambiguate repeated actions'),
      promptText: z.string().optional().describe('Nearby question/prompt text to disambiguate repeated actions'),
      itemText: z.string().optional().describe('Nearby card/row/item label to disambiguate repeated actions'),
      maxResults: z.number().int().min(1).max(12).optional().default(6).describe('Maximum number of matches to return'),
      detail: detailInput(),
      sessionId: sessionIdInput,
    },
    async ({ name, role, sectionText, promptText, itemText, maxResults, detail, sessionId }) => {
      const sessionResult = resolveToolSession(sessionId)
      if ('error' in sessionResult) return sessionResult.error
      const session = sessionResult.session

      const a11y = await sessionA11yWhenReady(session)
      if (!a11y) return err('No UI tree available')

      const filter: NodeFilter = {
        ...(role ? { role } : {}),
        name,
        ...(sectionText ? { sectionText } : {}),
        ...(promptText ? { promptText } : {}),
        ...(itemText ? { itemText } : {}),
      }
      const matches = sortA11yNodes(findNodes(a11y, filter).filter(node => node.focusable && (node.role === 'button' || node.role === 'link')))
      if (matches.length === 0) {
        if (detail === 'terse') {
          return ok(JSON.stringify({ matchCount: 0, filter: compactFilterPayload(filter) }))
        }
        return ok(`No actions found matching ${JSON.stringify(filter)}`)
      }

      const formatted = matches.slice(0, maxResults).map(node => formatNode(node, a11y, a11y.bounds))
      if (detail === 'terse') {
        return ok(JSON.stringify({
          matchCount: matches.length,
          matches: formatted.map(compactFormattedNode),
        }))
      }
      return ok(JSON.stringify(formatted))
    },
  )

  server.registerTool(
    'geometra_wait_for',
    {
      description: `Wait for a semantic UI condition without guessing sleep durations. Use this for slow SPA transitions, resume parsing, custom validation alerts, disabled submit buttons, and value/state confirmation before submit.

The filter matches the same fields as geometra_query (strict schema — unknown keys error). Set \`present: false\` to wait until **no** node matches — for example Ashby/Lever-style “Parsing your resume” or any “Parsing…” banner: \`{ "text": "Parsing", "present": false }\` (tune the substring to the site). Do not use a textGone parameter; use \`text\` + \`present: false\`, or \`geometra_wait_for_resume_parse\` for the usual post-upload parsing banner.`,
      inputSchema: geometraWaitForInputSchema,
    },
    async ({ id, role, name, text, contextText, promptText, sectionText, itemText, value, checked, disabled, focused, selected, expanded, invalid, required, busy, present, timeoutMs, detail, sessionId }) => {
      const sessionResult = resolveToolSession(sessionId)
      if ('error' in sessionResult) return sessionResult.error
      const session = sessionResult.session

      const filterProbe: NodeFilter = {
        id,
        role,
        name,
        text,
        contextText,
        promptText,
        sectionText,
        itemText,
        value,
        checked,
        disabled,
        focused,
        selected,
        expanded,
        invalid,
        required,
        busy,
      }
      if (!hasNodeFilter(filterProbe)) return err(GEOMETRA_WAIT_FILTER_REQUIRED_MESSAGE)

      const waited = await waitForSemanticCondition(session, {
        filter: filterProbe,
        present: present ?? true,
        timeoutMs: timeoutMs ?? 10_000,
      })
      if (!waited.ok) return err(waited.error)

      if (detail === 'terse') {
        const compact = waitConditionCompact(waited.value)
        const matches = waited.value.matches
          .slice(0, 3)
          .map(match => compactFormattedNode(match))
        return ok(JSON.stringify({
          ...compact,
          ...(matches.length > 0 ? { matches } : {}),
        }))
      }

      if (!waited.value.present) {
        return ok(waitConditionSuccessLine(waited.value))
      }

      return ok(JSON.stringify(waited.value.matches.slice(0, 8), null, 2))
    }
  )

  server.registerTool(
    'geometra_wait_for_resume_parse',
    {
      description: `Wait until **no** visible text contains the given substring — optimized for ATS “parsing your resume” / file-processing banners after upload.

Equivalent to \`geometra_wait_for\` with \`present: false\` and \`text\` set to a banner substring. Default \`text\` is \`Parsing\` (tune per site). Strict schema (unknown keys rejected).`,
      inputSchema: geometraWaitForResumeParseInputSchema,
    },
    async ({ text, timeoutMs, sessionId }) => {
      const sessionResult = resolveToolSession(sessionId)
      if ('error' in sessionResult) return sessionResult.error
      const session = sessionResult.session

      const filter: NodeFilter = { text }
      const waited = await waitForSemanticCondition(session, {
        filter,
        present: false,
        timeoutMs,
      })
      if (!waited.ok) return err(waited.error)
      return ok(waitConditionSuccessLine(waited.value))
    }
  )

  server.tool(
    'geometra_wait_for_navigation',
    `Wait until the page URL changes and the new page's DOM stabilizes. Use this after clicking "Next", "Submit", or "Continue" on multi-page forms.

Captures the current URL, then polls until the URL changes and a stable UI tree is available. Returns the new page URL and a page model summary.`,
    {
      timeoutMs: z
        .number()
        .int()
        .min(500)
        .max(60_000)
        .optional()
        .default(10_000)
        .describe('Max time to wait for navigation + DOM stabilization (default 10s)'),
      expectedUrl: z.string().optional().describe('Optional URL substring to match — keeps waiting if the URL changes to something else (e.g. intermediate redirects)'),
      sessionId: sessionIdInput,
    },
    async ({ timeoutMs, expectedUrl, sessionId }) => {
      const sessionResult = resolveToolSession(sessionId)
      if ('error' in sessionResult) return sessionResult.error
      const session = sessionResult.session

      const beforeA11y = sessionA11y(session)
      const beforeUrl = beforeA11y?.meta?.pageUrl ?? session.url

      const startedAt = performance.now()
      let navigated = false

      while (performance.now() - startedAt < timeoutMs) {
        await waitForUiCondition(session, () => {
          const a = sessionA11y(session)
          if (!a?.meta?.pageUrl) return false
          const currentUrl = a.meta.pageUrl
          if (currentUrl === beforeUrl) return false
          if (expectedUrl && !currentUrl.includes(expectedUrl)) return false
          return true
        }, Math.max(500, timeoutMs - (performance.now() - startedAt)))

        const afterA11y = sessionA11y(session)
        const afterUrl = afterA11y?.meta?.pageUrl
        if (afterUrl && afterUrl !== beforeUrl) {
          if (!expectedUrl || afterUrl.includes(expectedUrl)) {
            navigated = true
            break
          }
        }
      }

      const elapsedMs = Number((performance.now() - startedAt).toFixed(1))
      const afterA11y = await sessionA11yWhenReady(session)
      const afterUrl = afterA11y?.meta?.pageUrl

      if (!navigated) {
        return err(JSON.stringify({
          navigated: false,
          beforeUrl,
          currentUrl: afterUrl,
          elapsedMs,
          message: `URL did not change within ${timeoutMs}ms`,
        }))
      }

      const model = afterA11y ? buildPageModel(afterA11y) : undefined
      return ok(JSON.stringify({
        navigated: true,
        beforeUrl,
        afterUrl,
        elapsedMs,
        ...(model ? {
          summary: model.summary,
          archetypes: model.archetypes,
          formCount: model.forms.length,
          ...(model.captcha ? { captcha: model.captcha } : {}),
        } : {}),
      }))
    }
  )

  server.tool(
    'geometra_fill_fields',
    `Fill several labeled form fields in one MCP call. This is the preferred high-level primitive for long forms.

Use \`kind: "text"\` for textboxes / textareas, \`"choice"\` for selects / comboboxes / radio-style questions addressed by field label + answer, \`"toggle"\` for individually labeled checkboxes or radios, and \`"file"\` for labeled uploads. When \`fieldId\` from \`geometra_form_schema\` is present, MCP can resolve the current label server-side so you do not need to duplicate \`fieldLabel\` / \`label\` for text, choice, toggle, or file fields.`,
    {
      fields: z.array(fillFieldSchema).min(1).max(80).describe('Ordered field operations to apply. Use fieldId from geometra_form_schema to omit duplicate fieldLabel/label on schema-backed fields.'),
      stopOnError: z.boolean().optional().default(true).describe('Stop at the first failing field (default true)'),
      failOnInvalid: z
        .boolean()
        .optional()
        .default(false)
        .describe('Return an error if invalid fields remain after filling'),
      includeSteps: z
        .boolean()
        .optional()
        .default(true)
        .describe('Include per-field step results in the JSON payload (default true). Set false for the smallest batch response.'),
      detail: detailInput(),
      sessionId: sessionIdInput,
    },
    async ({ fields, stopOnError, failOnInvalid, includeSteps, detail, sessionId }) => {
      const sessionResult = resolveToolSession(sessionId)
      if ('error' in sessionResult) return sessionResult.error
      const session = sessionResult.session
      const resolvedFields = resolveFillFieldInputs(session, fields)
      if (!resolvedFields.ok) return err(resolvedFields.error)

      let fallbackFromBatch: { attempted: true; used: true; reason: 'batched-unavailable'; attempts: number } | undefined
      if (!includeSteps) {
        try {
          const batched = await tryBatchedResolvedFields(session, resolvedFields.fields, detail)
          if (batched.ok) {
            const payload = {
              completed: true,
              execution: 'batched',
              finalSource: batched.finalSource,
              fieldCount: resolvedFields.fields.length,
              successCount: resolvedFields.fields.length,
              errorCount: 0,
              final: batched.final,
            }
            if (failOnInvalid && batched.invalidRemaining > 0) {
              return err(JSON.stringify(payload, null, detail === 'verbose' ? 2 : undefined))
            }
            return ok(JSON.stringify(payload, null, detail === 'verbose' ? 2 : undefined))
          }
          // Batched path returned {ok: false} — this is the transparent fallback
          // case. Continue into the sequential loop and mark the result so
          // operators can aggregate how often it fires.
          fallbackFromBatch = { attempted: true, used: true, reason: 'batched-unavailable', attempts: 2 }
        } catch (e) {
          const ambiguity = ambiguousOutcomeDetails(e)
          if (ambiguity) {
            return err(JSON.stringify({
              completed: false,
              execution: 'batched',
              ...ambiguousOutcomePayload(ambiguity),
            }, null, detail === 'verbose' ? 2 : undefined))
          }
          const message = e instanceof Error ? e.message : String(e)
          return err(message)
        }
      }

      const steps: Array<Record<string, unknown>> = []
      let stoppedAt: number | undefined
      let ambiguousAt: number | undefined

      for (let index = 0; index < resolvedFields.fields.length; index++) {
        const field = resolvedFields.fields[index]!
        try {
          const result = await executeFillField(session, field, detail)
          // Post-fill validation: choice fields may report ok but leave the field invalid
          const readback = result.compact?.readback as Record<string, unknown> | undefined
          const stillInvalid = field.kind === 'choice' && readback?.state && (readback.state as Record<string, unknown>).invalid === true
          if (stillInvalid) {
            throw new Error(`Choice field "${field.fieldLabel}" still invalid after fill: ${readback?.error ?? 'selection did not commit'}`)
          }
          steps.push(detail === 'verbose'
            ? { index, kind: field.kind, ok: true, summary: result.summary }
            : { index, kind: field.kind, ok: true, ...result.compact })
        } catch (e) {
          let handledError = e
          let message = e instanceof Error ? e.message : String(e)
          // Retry once for transient selection failures
          if (!ambiguousOutcomeDetails(e) && (message.includes('selection_not_confirmed') || message.includes('still invalid after fill'))) {
            try {
              const retryResult = await executeFillField(session, field, detail)
              steps.push(detail === 'verbose'
                ? { index, kind: field.kind, ok: true, summary: retryResult.summary, retried: true }
                : { index, kind: field.kind, ok: true, ...retryResult.compact, retried: true })
              continue
            } catch (retryError) {
              handledError = retryError
              message = retryError instanceof Error ? retryError.message : String(retryError)
            }
          }
          const ambiguity = ambiguousOutcomeDetails(handledError)
          const suggestion = isResolvedFillFieldInput(field) ? suggestRecovery(field, message) : undefined
          steps.push({
            index,
            kind: field.kind,
            ok: false,
            error: message,
            ...(ambiguity ? ambiguousOutcomePayload(ambiguity) : {}),
            ...(suggestion ? { suggestion } : {}),
          })
          if (ambiguity || stopOnError) {
            stoppedAt = index
            if (ambiguity) ambiguousAt = index
            break
          }
        }
      }

      const after = sessionA11y(session)
      const signals = after ? collectSessionSignals(after) : undefined
      const invalidRemaining = signals?.invalidFields.length ?? 0
      const successCount = steps.filter(step => step.ok === true).length
      const errorCount = steps.length - successCount
      const payload = {
        completed: errorCount === 0 && stoppedAt === undefined && steps.length === resolvedFields.fields.length,
        fieldCount: resolvedFields.fields.length,
        successCount,
        errorCount,
        ...(includeSteps ? { steps } : {}),
        ...(stoppedAt !== undefined ? { stoppedAt } : {}),
        ...(ambiguousAt !== undefined ? {
          ambiguous: true,
          ambiguousAt,
          resumeBlocked: true,
          resumeFromIndex: ambiguousAt,
          resumeInstruction: 'Inspect the current UI before resuming; do not skip the ambiguous field.',
        } : {}),
        ...(fallbackFromBatch ? { fallback: fallbackFromBatch } : {}),
        ...(signals ? { final: sessionSignalsPayload(signals, detail) } : {}),
      }

      if (failOnInvalid && invalidRemaining > 0) {
        return err(JSON.stringify(payload, null, detail === 'verbose' ? 2 : undefined))
      }

      return ok(JSON.stringify(payload, null, detail === 'verbose' ? 2 : undefined))
    }
  )

  server.tool(
    'geometra_fill_form',
    `Fill a form from a compact values object instead of expanding sections first. This is the lowest-token happy path for standard application flows.

Pass \`valuesById\` with field ids from \`geometra_form_schema\` for the most stable matching, or \`valuesByLabel\` when labels are unique enough. MCP resolves the form schema, executes the semantic field operations server-side, and returns one consolidated result. If you pass \`pageUrl\` or \`url\`, MCP will connect first so known-form fills can run in a single tool call.`,
    {
      url: z.string().optional().describe('Optional target URL. Use a ws:// Geometra server URL or an http(s) page URL to auto-connect before filling.'),
      pageUrl: z.string().optional().describe('Optional http(s) page URL to auto-connect before filling. Prefer this over url for browser pages.'),
      port: z.number().int().min(0).max(65535).optional().describe('Preferred local port for an auto-spawned proxy (default: ephemeral OS-assigned port).'),
      headless: z.boolean().optional().describe('Run Chromium headless when auto-spawning a proxy (default true). Set false for a visible window.'),
      width: z.number().int().positive().optional().describe('Viewport width for auto-connected sessions.'),
      height: z.number().int().positive().optional().describe('Viewport height for auto-connected sessions.'),
      slowMo: z.number().int().nonnegative().optional().describe('Playwright slowMo (ms) when auto-spawning a proxy.'),
      stealth: stealthInput(),
      browserMode: browserModeInput(),
      formId: z.string().optional().describe('Optional form id from geometra_form_schema or geometra_page_model'),
      valuesById: formValuesRecordSchema.optional().describe('Form values keyed by stable field id from geometra_form_schema'),
      valuesByLabel: formValuesRecordSchema.optional().describe('Form values keyed by schema field label'),
      stopOnError: z.boolean().optional().default(true).describe('Stop at the first failing field (default true)'),
      failOnInvalid: z
        .boolean()
        .optional()
        .default(false)
        .describe('Return an error if invalid fields remain after filling'),
      includeSteps: z
        .boolean()
        .optional()
        .default(false)
        .describe('Include per-field step results in the JSON payload (default false for the smallest response)'),
      resumeFromIndex: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe('Resume a partial fill from this field index (from a previous stoppedAt + 1). Skips already-filled fields.'),
      verifyFills: z
        .boolean()
        .optional()
        .default(false)
        .describe('After filling, read back each field value and flag mismatches (e.g. autocomplete rejected input, format transformed). Adds a verification array to the response.'),
      skipPreFilled: z
        .boolean()
        .optional()
        .default(false)
        .describe('Skip fields that already contain a matching value. Avoids overwriting good data from resume parsing or previous fills.'),
      isolated: z
        .boolean()
        .optional()
        .describe('When auto-connecting via pageUrl/HTTP(S) url, use a fresh isolated Chromium by default. Pass false explicitly for sequential warm reuse. Ignored when using an existing sessionId.'),
      detail: detailInput(),
      sessionId: sessionIdInput,
    },
    async ({ url, pageUrl, port, headless, width, height, slowMo, stealth, browserMode, formId, valuesById, valuesByLabel, stopOnError, failOnInvalid, includeSteps, resumeFromIndex, verifyFills, skipPreFilled, isolated, detail, sessionId }) => {
      const browser = resolveBrowserStealth({ stealth, browserMode })
      if (!browser.ok) return err(browser.error)

      const resolved = await ensureToolSession(
        {
          sessionId,
          url,
          pageUrl,
          port,
          headless,
          width,
          height,
          slowMo,
          stealth: browser.stealth,
          isolated,
        },
        'Not connected. Call geometra_connect first, or pass pageUrl/url to geometra_fill_form.',
      )
      if (!resolved.ok) return err(resolved.error)
      const session = resolved.session
      const connection = autoConnectionPayload(resolved)

      const entryCount = Object.keys(valuesById ?? {}).length + Object.keys(valuesByLabel ?? {}).length
      if (entryCount === 0) {
        return err('Provide at least one value in valuesById or valuesByLabel')
      }

      if (!session.tree || !session.layout) {
        await waitForUiCondition(session, () => Boolean(session.tree && session.layout), 2_000)
      }
      const afterConnect = sessionA11y(session)
      if (!afterConnect) return err('No UI tree available for form filling')
      const schemas = getSessionFormSchemas(session, {
        includeOptions: true,
        includeContext: 'auto',
      })
      if (schemas.length === 0) return err('No forms found in the current UI')

      const entryUrl = afterConnect?.meta?.pageUrl

      const resolution = resolveTargetFormSchema(schemas, { formId, valuesById, valuesByLabel })
      if (!resolution.ok) return err(resolution.error)
      const schema = resolution.schema
      const targetFormPath = parseSectionId(schema.formId)?.path

      const planned = planFormFill(schema, { valuesById, valuesByLabel }, schemas)
      if (!planned.ok) return err(planned.error)

      let skippedCount = 0
      if (skipPreFilled) {
        const schemaFieldById = new Map(schema.fields.map(f => [f.id, f]))
        const indicesToRemove = new Set<number>()
        for (let i = 0; i < planned.planned.length; i++) {
          const p = planned.planned[i]!
          const fieldId = p.field.fieldId
          if (!fieldId) continue
          const schemaField = schemaFieldById.get(fieldId)
          if (!schemaField?.value) continue
          const currentVal = schemaField.value.toLowerCase().trim()
          let intendedVal: string | undefined
          if (p.field.kind === 'text') intendedVal = p.field.value
          else if (p.field.kind === 'choice') intendedVal = p.field.value
          if (intendedVal && currentVal === intendedVal.toLowerCase().trim()) {
            indicesToRemove.add(i)
          }
        }
        if (indicesToRemove.size > 0) {
          skippedCount = indicesToRemove.size
          planned.planned = planned.planned.filter((_, i) => !indicesToRemove.has(i))
          planned.fields = planned.planned.map(p => p.field)
        }
      }

      let fallbackFromBatch: { attempted: true; used: true; reason: 'batched-threw' | 'batched-invalid-readback'; attempts: number } | undefined
      if (!includeSteps) {
        let usedBatch = false
        try {
          const startRevision = session.updateRevision
          const wait = await sendFillFields(session, toProxyFillFields(planned.fields))
          assertActionWaitConfirmed('Batched form fill', wait)
          const ackResult = parseProxyFillAckResult(wait.result)
          const batchIncludesFile = planned.fields.some(field => field.kind === 'file')
          if (batchIncludesFile) {
            // Legacy proxies do not return a structured fillFields result.
            // Because a file chooser may already have mutated, replaying the
            // batch or falling back sequentially would be unsafe. Current
            // proxies only emit this result after attachFiles confirms the
            // exact input retained the requested files.
            if (!ackResult) {
              throw new AmbiguousActionOutcomeError(
                'Batched file fill',
                wait,
                'Batched file fill was acknowledged without structured proxy confirmation; the upload may already have happened. Do not retry blindly.',
              )
            }
            await waitForDeferredBatchUpdate(session, startRevision, wait)
            const verification = verifyFills ? verifyFormFills(session, planned.planned) : undefined
            const payload = {
              ...connection,
              completed: true,
              execution: 'batched',
              finalSource: 'proxy',
              formId: schema.formId,
              requestedValueCount: entryCount,
              fieldCount: planned.fields.length,
              successCount: planned.fields.length,
              errorCount: 0,
              ...(verification ? { verification } : {}),
              final: ackResult,
            }
            recordWorkflowFill(
              session,
              schema.formId,
              schema.name,
              valuesById,
              valuesByLabel,
              ackResult.invalidCount,
              planned.fields.length,
            )
            if (failOnInvalid && ackResult.invalidCount > 0) {
              return err(JSON.stringify(payload, null, detail === 'verbose' ? 2 : undefined))
            }
            return ok(JSON.stringify(payload, null, detail === 'verbose' ? 2 : undefined))
          }
          if (ackResult && ackResult.invalidCount === 0) {
            usedBatch = true
            if (!verifyFills) {
              const payload = {
                ...connection,
                completed: true,
                execution: 'batched',
                finalSource: 'proxy',
                formId: schema.formId,
                requestedValueCount: entryCount,
                fieldCount: planned.fields.length,
                successCount: planned.fields.length,
                errorCount: 0,
                final: ackResult,
              }
              return ok(JSON.stringify(payload, null, detail === 'verbose' ? 2 : undefined))
            }
          }
          await waitForDeferredBatchUpdate(session, startRevision, wait)
          await waitForBatchFieldReadback(session, planned.fields)
          usedBatch = true
        } catch (e) {
          const ambiguity = ambiguousOutcomeDetails(e)
          if (ambiguity) {
            return err(JSON.stringify({
              ...connection,
              completed: false,
              execution: 'batched',
              formId: schema.formId,
              ...ambiguousOutcomePayload(ambiguity),
            }, null, detail === 'verbose' ? 2 : undefined))
          }
          if (!canFallbackToSequentialFill(e)) {
            const message = e instanceof Error ? e.message : String(e)
            return err(message)
          }
          fallbackFromBatch = { attempted: true, used: true, reason: 'batched-threw', attempts: 2 }
        }

        if (usedBatch) {
          const after = sessionA11y(session)
          const signals = after
            ? scopeSessionSignalsToForm(
                after,
                targetFormPath ? formNodeAtPath(after, targetFormPath) : undefined,
                targetFormPath !== undefined,
              )
            : undefined
          const invalidRemaining = signals?.invalidFields.length ?? 0
          if (invalidRemaining > 0) {
            usedBatch = false
            fallbackFromBatch = { attempted: true, used: true, reason: 'batched-invalid-readback', attempts: 2 }
          }
        }

        if (usedBatch) {
          const after = sessionA11y(session)
          const signals = after
            ? scopeSessionSignalsToForm(
                after,
                targetFormPath ? formNodeAtPath(after, targetFormPath) : undefined,
                targetFormPath !== undefined,
              )
            : undefined
          const invalidRemaining = signals?.invalidFields.length ?? 0
          const verification = verifyFills ? verifyFormFills(session, planned.planned) : undefined
          const payload = {
            ...connection,
            completed: true,
            execution: 'batched',
            finalSource: 'session',
            formId: schema.formId,
            requestedValueCount: entryCount,
            fieldCount: planned.fields.length,
            successCount: planned.fields.length,
            errorCount: 0,
            minConfidence: planned.planned.length > 0
              ? Number(Math.min(...planned.planned.map(p => p.confidence)).toFixed(2))
              : undefined,
            ...(verification ? { verification } : {}),
            ...(signals ? { final: sessionSignalsPayload(signals, detail) } : {}),
          }

          recordWorkflowFill(session, schema.formId, schema.name, valuesById, valuesByLabel, invalidRemaining, planned.fields.length)

          if (failOnInvalid && invalidRemaining > 0) {
            return err(JSON.stringify(payload, null, detail === 'verbose' ? 2 : undefined))
          }

          return ok(JSON.stringify(payload, null, detail === 'verbose' ? 2 : undefined))
        }
      }

      const steps: Array<Record<string, unknown>> = []
      let stoppedAt: number | undefined
      let ambiguousAt: number | undefined
      const startIndex = resumeFromIndex ?? 0

      for (let index = startIndex; index < planned.fields.length; index++) {
        const field = planned.fields[index]!
        const plan = planned.planned[index]
        const confidence = plan?.confidence
        const matchMethod = plan?.matchMethod
        try {
          const result = await executeFillField(session, field, detail)
          steps.push(detail === 'verbose'
            ? { index, kind: field.kind, ok: true, ...(confidence !== undefined ? { confidence, matchMethod } : {}), summary: result.summary }
            : { index, kind: field.kind, ok: true, ...(confidence !== undefined ? { confidence, matchMethod } : {}), ...result.compact })
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e)
          const ambiguity = ambiguousOutcomeDetails(e)
          const suggestion = suggestRecovery(field, message)
          steps.push({
            index,
            kind: field.kind,
            ok: false,
            ...(confidence !== undefined ? { confidence, matchMethod } : {}),
            error: message,
            ...(ambiguity ? ambiguousOutcomePayload(ambiguity) : {}),
            ...(suggestion ? { suggestion } : {}),
          })
          if (ambiguity || stopOnError) {
            stoppedAt = index
            if (ambiguity) ambiguousAt = index
            break
          }
        }
      }

      const after = sessionA11y(session)
      const signals = after
        ? scopeSessionSignalsToForm(
            after,
            targetFormPath ? formNodeAtPath(after, targetFormPath) : undefined,
            targetFormPath !== undefined,
          )
        : undefined
      const invalidRemaining = signals?.invalidFields.length ?? 0
      const successCount = steps.filter(step => step.ok === true).length
      const errorCount = steps.length - successCount

      const verification = verifyFills ? verifyFormFills(session, planned.planned) : undefined

      const payload = {
        ...connection,
        completed: errorCount === 0 && stoppedAt === undefined && (startIndex + steps.length) === planned.fields.length,
        execution: 'sequential',
        formId: schema.formId,
        requestedValueCount: entryCount,
        fieldCount: planned.fields.length,
        successCount,
        errorCount,
        ...(skippedCount > 0 ? { skippedPreFilled: skippedCount } : {}),
        minConfidence: planned.planned.length > 0
          ? Number(Math.min(...planned.planned.map(p => p.confidence)).toFixed(2))
          : undefined,
        ...(startIndex > 0 ? { resumedFromIndex: startIndex } : {}),
        ...(includeSteps ? { steps } : {}),
        ...(stoppedAt !== undefined ? {
          stoppedAt,
          resumeFromIndex: ambiguousAt ?? (stoppedAt + 1),
        } : {}),
        ...(ambiguousAt !== undefined ? {
          ambiguous: true,
          ambiguousAt,
          resumeBlocked: true,
          resumeInstruction: 'Inspect the current UI before resuming; do not skip the ambiguous field.',
        } : {}),
        ...(fallbackFromBatch ? { fallback: fallbackFromBatch } : {}),
        ...(verification ? { verification } : {}),
        ...(signals ? { final: sessionSignalsPayload(signals, detail) } : {}),
      }

      // Detect page navigation after fill (e.g. multi-page form submission)
      const afterUrl = after?.meta?.pageUrl
      if (afterUrl && entryUrl && afterUrl !== entryUrl) {
        ;(payload as Record<string, unknown>).navigated = true
        ;(payload as Record<string, unknown>).afterUrl = afterUrl
        const model = after ? buildPageModel(after) : undefined
        if (model) {
          ;(payload as Record<string, unknown>).pageModel = summarizePageModel(model)
          if (model.captcha) (payload as Record<string, unknown>).captcha = model.captcha
          if (model.verification) (payload as Record<string, unknown>).verification = model.verification
        }
      }

      recordWorkflowFill(session, schema.formId, schema.name, valuesById, valuesByLabel, invalidRemaining, planned.fields.length)

      if (failOnInvalid && invalidRemaining > 0) {
        return err(JSON.stringify(payload, null, detail === 'verbose' ? 2 : undefined))
      }

      return ok(JSON.stringify(payload, null, detail === 'verbose' ? 2 : undefined))
    }
  )

  // ── fill + submit + wait ──────────────────────────────────────
  server.tool(
    'geometra_submit_form',
    `Fill a form, click its submit button, and optionally wait for the post-submit UI state — all in one MCP call. This is the preferred path for the canonical ATS / sign-in flow when the whole sequence should run server-side.

Pass \`valuesById\` or \`valuesByLabel\` to populate fields, \`submit\` to target the submit button (default: semantic \`{ role: 'button', name: 'Submit' }\`), and \`waitFor\` to block on the post-submit state (success banner, navigation, submit button gone, etc.). Navigation is detected automatically and surfaced as \`navigated: true\` with \`afterUrl\`.

Pass \`pageUrl\`/\`url\` to auto-connect in the same call. These browser connects are isolated by default; pass \`isolated: false\` only for intentional sequential warm reuse.`,
    {
      url: z.string().optional().describe('Optional target URL. Use a ws:// Geometra server URL or an http(s) page URL to auto-connect before submitting.'),
      pageUrl: z.string().optional().describe('Optional http(s) page URL to auto-connect before submitting. Prefer this over url for browser pages.'),
      port: z.number().int().min(0).max(65535).optional().describe('Preferred local port for an auto-spawned proxy (default: ephemeral OS-assigned port).'),
      headless: z.boolean().optional().describe('Run Chromium headless when auto-spawning a proxy (default true). Set false for a visible window.'),
      width: z.number().int().positive().optional().describe('Viewport width for auto-connected sessions.'),
      height: z.number().int().positive().optional().describe('Viewport height for auto-connected sessions.'),
      slowMo: z.number().int().nonnegative().optional().describe('Playwright slowMo (ms) when auto-spawning a proxy.'),
      stealth: stealthInput(),
      browserMode: browserModeInput(),
      isolated: z.boolean().optional().describe('When auto-connecting via pageUrl/HTTP(S) url, use a fresh isolated Chromium by default. Pass false explicitly for sequential warm reuse.'),
      formId: z.string().optional().describe('Optional form id from geometra_form_schema or geometra_page_model'),
      valuesById: formValuesRecordSchema.optional().describe('Form values keyed by stable field id from geometra_form_schema'),
      valuesByLabel: formValuesRecordSchema.optional().describe('Form values keyed by schema field label'),
      submit: z.object(nodeFilterShape()).strict().optional().describe('Semantic target for the submit button. Defaults to {role: "button", name: "Submit"}.'),
      submitIndex: z.number().int().min(0).optional().default(0).describe('Which matching submit target to click after sorting top-to-bottom (default 0)'),
      submitTimeoutMs: z.number().int().min(50).max(60_000).optional().default(15_000).describe('Action wait timeout for the submit click (default 15000ms). Increase for slow backends.'),
      waitFor: z.object(waitConditionShape()).strict().optional().describe('Optional semantic condition to wait for after the submit click (success banner, submit gone, etc.)'),
      skipFill: z.boolean().optional().default(false).describe('Skip the fill phase and go straight to submit+wait. Use when values have already been filled by a previous call.'),
      softTimeoutMs: softTimeoutMsInput(),
      failOnInvalid: z.boolean().optional().default(false).describe('Control whether a validation_failed outcome is returned as an MCP error. Outcome facts are always reported.'),
      detail: detailInput(),
      sessionId: sessionIdInput,
    },
    async ({ url, pageUrl, port, headless, width, height, slowMo, stealth, browserMode, isolated, formId, valuesById, valuesByLabel, submit, submitIndex, submitTimeoutMs, waitFor, skipFill, softTimeoutMs, failOnInvalid, detail, sessionId }) => {
      const browser = resolveBrowserStealth({ stealth, browserMode })
      if (!browser.ok) return err(browser.error)
      const toolStartedAt = performance.now()
      const effectiveSoftTimeoutMs = softTimeoutMs ?? HOST_SAFE_TOOL_TIMEOUT_MS
      const deadlineAt = toolStartedAt + effectiveSoftTimeoutMs
      const resolved = await ensureToolSession(
        { sessionId, url, pageUrl, port, headless, width, height, slowMo, stealth: browser.stealth, isolated },
        'Not connected. Call geometra_connect first, or pass pageUrl/url to geometra_submit_form.',
      )
      if (!resolved.ok) return err(resolved.error)
      const session = resolved.session
      const connection = autoConnectionPayload(resolved)
      let targetFormId = formId
      let targetFormIdentity: FormScopeIdentity | undefined
      let fillSummary: Record<string, unknown> | undefined
      let fillFallback: { attempted: true; used: true; reason: 'batched-threw'; attempts: number } | undefined
      const pausedPayload = (phase: string, resumeHint?: Record<string, unknown>, extra?: Record<string, unknown>): Record<string, unknown> => {
        const resumesSubmitForm = resumeHint?.tool === 'geometra_submit_form'
        const scopedResumeHint = {
          ...(resumeHint ?? {}),
          ...(resumesSubmitForm && targetFormId ? { formId: targetFormId } : {}),
        }
        return {
          ...connection,
          completed: false,
          outcome: 'unconfirmed',
          paused: true,
          phase,
          pauseReason: 'soft-timeout',
          softTimeoutMs: effectiveSoftTimeoutMs,
          elapsedMs: Number((performance.now() - toolStartedAt).toFixed(1)),
          ...(Object.keys(scopedResumeHint).length > 0 ? { resumeHint: scopedResumeHint } : {}),
          ...(fillSummary ? { fill: fillSummary } : {}),
          ...(fillFallback ? { fill_fallback: fillFallback } : {}),
          ...(extra ?? {}),
        }
      }

      if (!session.tree || !session.layout) {
        await waitForUiCondition(
          session,
          () => Boolean(session.tree && session.layout),
          capTimeoutMs(2_000, timeoutCapFromDeadline(deadlineAt), 2_000),
        )
      }
      const entryA11y = sessionA11y(session)
      if (!entryA11y) return err('No UI tree available for form submission')
      if (!hasSoftBudget(deadlineAt)) {
        return ok(JSON.stringify(pausedPayload('before-fill', { retrySameCall: true }), null, detail === 'verbose' ? 2 : undefined))
      }

      if (!skipFill) {
        const entryCount = Object.keys(valuesById ?? {}).length + Object.keys(valuesByLabel ?? {}).length
        if (entryCount === 0) {
          return err('Provide at least one value in valuesById or valuesByLabel, or set skipFill: true to submit already-filled values.')
        }

        const schemas = getSessionFormSchemas(session, { includeOptions: true, includeContext: 'auto' })
        if (schemas.length === 0) return err('No forms found in the current UI')

        const resolution = resolveTargetFormSchema(schemas, { formId, valuesById, valuesByLabel })
        if (!resolution.ok) return err(resolution.error)
        const schema = resolution.schema
        targetFormId = schema.formId
        const initialFormPath = parseSectionId(schema.formId)
        const initialFormNode = initialFormPath?.kind === 'form'
          ? formScopeNodeAtPath(entryA11y, initialFormPath.path)
          : undefined
        if (!initialFormNode) {
          return err(`Target form ${schema.formId} does not resolve to a maintainable form scope before fill`)
        }
        const capturedIdentity = captureFormScopeIdentity(initialFormNode, schema)
        if (!capturedIdentity.ok) return err(capturedIdentity.error)
        targetFormIdentity = capturedIdentity.identity

        const planned = planFormFill(schema, { valuesById, valuesByLabel }, schemas)
        if (!planned.ok) return err(planned.error)

        let usedBatch = true
        try {
          const startRevision = session.updateRevision
          const wait = await sendFillFields(
            session,
            toProxyFillFields(planned.fields),
            capTimeoutMs(undefined, timeoutCapFromDeadline(deadlineAt), HOST_SAFE_TOOL_TIMEOUT_MS),
          )
          if (wait.status === 'timed_out') {
            fillSummary = {
              formId: schema.formId,
              execution: 'batched',
              fieldCount: planned.fields.length,
              ...waitStatusPayload(wait),
              ...(entryCount !== planned.fields.length ? { requestedValueCount: entryCount } : {}),
            }
            const guidance = ambiguousActionGuidance(wait)
            return ok(JSON.stringify(pausedPayload('fill', {
              tool: 'geometra_submit_form',
              retrySameCall: false,
              inspectCurrentUiFirst: true,
              skipFill: false,
              actionId: wait.actionId,
              requestId: wait.requestId,
            }, {
              pauseReason: 'action-outcome-ambiguous',
              retrySafety: 'inspect-first',
              guidance,
            }), null, detail === 'verbose' ? 2 : undefined))
          }
          const ack = parseProxyFillAckResult(wait.result)
          await waitForDeferredBatchUpdate(session, startRevision, wait)
          fillSummary = {
            formId: schema.formId,
            execution: 'batched',
            fieldCount: planned.fields.length,
            ...waitStatusPayload(wait),
            ...(ack ? { invalidCount: ack.invalidCount, alertCount: ack.alertCount } : {}),
            ...(ack?.invalidFields ? { invalidFields: ack.invalidFields } : {}),
            ...(entryCount !== planned.fields.length ? { requestedValueCount: entryCount } : {}),
          }
        } catch (e) {
          const ambiguity = ambiguousOutcomeDetails(e)
          if (ambiguity) {
            return err(JSON.stringify({
              ...connection,
              completed: false,
              paused: true,
              phase: 'fill',
              pauseReason: 'action-outcome-ambiguous',
              ...ambiguousOutcomePayload(ambiguity),
              submit: { attempted: false, reason: 'Fill outcome must be inspected before submission.' },
            }, null, detail === 'verbose' ? 2 : undefined))
          }
          if (!canFallbackToSequentialFill(e)) {
            const message = e instanceof Error ? e.message : String(e)
            return err(`Failed to fill form before submit: ${message}`)
          }
          usedBatch = false
          fillFallback = { attempted: true, used: true, reason: 'batched-threw', attempts: 2 }
        }

        if (!usedBatch) {
          let successCount = 0
          let firstErr: string | undefined
          let firstAmbiguity: AmbiguousOutcomeDetails | undefined
          for (const field of planned.fields) {
            if (!hasSoftBudget(deadlineAt)) {
              fillSummary = {
                formId: schema.formId,
                execution: 'sequential',
                fieldCount: planned.fields.length,
                successCount,
                ...(entryCount !== planned.fields.length ? { requestedValueCount: entryCount } : {}),
              }
              return ok(JSON.stringify(pausedPayload('fill', {
                tool: 'geometra_submit_form',
                retrySameCall: true,
                skipFill: false,
              }), null, detail === 'verbose' ? 2 : undefined))
            }
            try {
              await executeFillField(session, capFillFieldTimeout(field, timeoutCapFromDeadline(deadlineAt)), detail)
              successCount += 1
            } catch (e) {
              firstErr = e instanceof Error ? e.message : String(e)
              firstAmbiguity = ambiguousOutcomeDetails(e)
              break
            }
          }
          fillSummary = {
            formId: schema.formId,
            execution: 'sequential',
            fieldCount: planned.fields.length,
            successCount,
            ...(firstErr !== undefined ? { error: firstErr } : {}),
            ...(entryCount !== planned.fields.length ? { requestedValueCount: entryCount } : {}),
          }
          if (firstErr !== undefined) {
            if (firstAmbiguity) {
              return err(JSON.stringify({
                ...connection,
                completed: false,
                paused: true,
                phase: 'fill',
                pauseReason: 'action-outcome-ambiguous',
                fill: fillSummary,
                ...ambiguousOutcomePayload(firstAmbiguity),
                submit: { attempted: false, reason: 'Fill outcome must be inspected before submission.' },
              }, null, detail === 'verbose' ? 2 : undefined))
            }
            return err(JSON.stringify({
              ...connection,
              completed: false,
              execution: 'unconfirmed',
              outcome: 'unconfirmed',
              phase: 'fill',
              fill: fillSummary,
              ...(fillFallback ? { fill_fallback: fillFallback } : {}),
              submit: { attempted: false, reason: 'Fill phase did not complete successfully.' },
            }, null, detail === 'verbose' ? 2 : undefined))
          }
        }
      }

      const submitResumeHint = {
        tool: 'geometra_submit_form',
        skipFill: true,
        submit: submit ?? { role: 'button', name: 'Submit' },
        submitIndex,
        ...(waitFor ? { waitFor } : {}),
      }
      if (!hasSoftBudget(deadlineAt)) {
        return ok(JSON.stringify(pausedPayload('submit', submitResumeHint), null, detail === 'verbose' ? 2 : undefined))
      }

      const submitFilter: NodeFilter = submit ?? { role: 'button', name: 'Submit' }
      const submitTargetFailurePayload = (
        error: string,
        fallback?: ResolveClickFallbackFailure,
      ): Record<string, unknown> => ({
        ...connection,
        completed: false,
        outcome: 'unconfirmed',
        ...(fillSummary ? { fill: fillSummary } : {}),
        ...(fillFallback ? { fill_fallback: fillFallback } : {}),
        submit: { ok: false, error: `Submit target not found: ${error}` },
        ...(fallback ? { submit_fallback: fallback } : {}),
      })

      let submitFormNode: A11yNode | undefined
      let submitFormPath: number[] | undefined
      let formScope: FormClickScope | undefined
      if (targetFormId) {
        const currentA11y = sessionA11y(session)
        const parsedForm = parseSectionId(targetFormId)
        const currentSchema = currentA11y
          ? getSessionFormSchemas(session, { includeOptions: false, includeContext: 'auto' })
            .find(schema => schema.formId === targetFormId)
          : undefined
        const currentForm = currentA11y && parsedForm?.kind === 'form'
          ? formScopeNodeAtPath(currentA11y, parsedForm.path)
          : undefined
        if (!currentA11y || parsedForm?.kind !== 'form' || !currentSchema || !currentForm) {
          return err(JSON.stringify(
            submitTargetFailurePayload(`Target form ${targetFormId} has an invalid or stale form path`),
            null,
            detail === 'verbose' ? 2 : undefined,
          ))
        }
        if (!targetFormIdentity) {
          const capturedIdentity = captureFormScopeIdentity(currentForm, currentSchema)
          if (!capturedIdentity.ok) {
            return err(JSON.stringify(
              submitTargetFailurePayload(capturedIdentity.error),
              null,
              detail === 'verbose' ? 2 : undefined,
            ))
          }
          targetFormIdentity = capturedIdentity.identity
        }
        submitFormPath = [...parsedForm.path]
        formScope = { formId: targetFormId, path: submitFormPath, identity: targetFormIdentity }
        const scoped = currentFormScope(session, currentA11y, formScope)
        if (!scoped.ok) {
          return err(JSON.stringify(
            submitTargetFailurePayload(scoped.error),
            null,
            detail === 'verbose' ? 2 : undefined,
          ))
        }
        submitFormNode = scoped.node
      }

      const resolvedClick = await resolveClickLocationWithFallback(session, {
        filter: submitFilter,
        index: submitIndex,
        fullyVisible: true,
        formScope,
        revealTimeoutMs: capTimeoutMs(2_500, timeoutCapFromDeadline(deadlineAt), 2_500),
      })
      if (!resolvedClick.ok) {
        const payload = submitTargetFailurePayload(resolvedClick.error, resolvedClick.fallback)
        return err(JSON.stringify(payload, null, detail === 'verbose' ? 2 : undefined))
      }

      const preSubmitA11y = sessionA11y(session)
      let submitPoint = { x: resolvedClick.value.x, y: resolvedClick.value.y }
      if (formScope) {
        if (!preSubmitA11y) {
          return err(JSON.stringify(
            submitTargetFailurePayload(`Target form ${formScope.formId} cannot be revalidated because the current UI tree is unavailable`),
            null,
            detail === 'verbose' ? 2 : undefined,
          ))
        }
        const scoped = currentFormScope(session, preSubmitA11y, formScope)
        const targetPath = resolvedClick.value.target?.path
        const currentTarget = targetPath ? findNodeByPath(preSubmitA11y, targetPath) : undefined
        const targetContext = currentTarget ? nodeContextForNode(preSubmitA11y, currentTarget) : undefined
        if (
          !scoped.ok ||
          !currentTarget ||
          !targetPath ||
          !pathIsStrictDescendant(targetPath, formScope.path) ||
          !nodeMatchesFilter(currentTarget, submitFilter, targetContext)
        ) {
          return err(JSON.stringify(
            submitTargetFailurePayload(
              `Target form ${formScope.formId} or its selected submit control became stale before click`,
            ),
            null,
            detail === 'verbose' ? 2 : undefined,
          ))
        }
        const currentCenter = currentVisibleClickCenter(preSubmitA11y, currentTarget)
        if (!currentCenter) {
          return err(JSON.stringify(
            submitTargetFailurePayload(
              `Target form ${formScope.formId} submit control is no longer visible at a usable click point`,
            ),
            null,
            detail === 'verbose' ? 2 : undefined,
          ))
        }
        submitPoint = currentCenter
        submitFormNode = scoped.node
      } else if (preSubmitA11y) {
        submitFormNode = resolveSubmitFormNode(preSubmitA11y, undefined, resolvedClick.value.target?.path)
        submitFormPath = submitFormNode?.path
      }
      const preSubmitSignals = preSubmitA11y
        ? scopeSessionSignalsToForm(preSubmitA11y, submitFormNode)
        : undefined
      if (preSubmitSignals && preSubmitSignals.invalidFields.length > 0) {
        const payload = {
          ...connection,
          completed: false,
          execution: 'not_started',
          outcome: 'validation_failed',
          ...(fillSummary ? { fill: fillSummary } : {}),
          ...(fillFallback ? { fill_fallback: fillFallback } : {}),
          submit: {
            attempted: false,
            reason: 'Invalid fields remain in the target form before submit; the submit control was not clicked.',
          },
          final: sessionSignalsPayload(preSubmitSignals, detail),
        }
        const serialized = JSON.stringify(payload, null, detail === 'verbose' ? 2 : undefined)
        return failOnInvalid ? err(serialized) : ok(serialized)
      }

      if (!hasSoftBudget(deadlineAt)) {
        return ok(JSON.stringify(pausedPayload('submit', submitResumeHint), null, detail === 'verbose' ? 2 : undefined))
      }
      const beforeSubmit = sessionA11y(session)
      const beforeClickUrl = beforeSubmit?.meta?.pageUrl
      const waitFilter: NodeFilter = {
        id: waitFor?.id,
        role: waitFor?.role,
        name: waitFor?.name,
        text: waitFor?.text,
        contextText: waitFor?.contextText,
        promptText: waitFor?.promptText,
        sectionText: waitFor?.sectionText,
        itemText: waitFor?.itemText,
        value: waitFor?.value,
        checked: waitFor?.checked,
        disabled: waitFor?.disabled,
        focused: waitFor?.focused,
        selected: waitFor?.selected,
        expanded: waitFor?.expanded,
        invalid: waitFor?.invalid,
        required: waitFor?.required,
        busy: waitFor?.busy,
      }
      const beforeWaitEvidence = waitFor && beforeSubmit
        ? captureWaitEvidence(beforeSubmit, waitFilter)
        : undefined
      const clickWait = await sendClick(
        session,
        submitPoint.x,
        submitPoint.y,
        capTimeoutMs(submitTimeoutMs, timeoutCapFromDeadline(deadlineAt), 15_000),
      )

      if (clickWait.status === 'timed_out') {
        const guidance = ambiguousActionGuidance(clickWait)
        return ok(JSON.stringify(pausedPayload('submit', {
          ...submitResumeHint,
          retrySameCall: false,
          inspectCurrentUiFirst: true,
          actionId: clickWait.actionId,
          requestId: clickWait.requestId,
        }, {
          pauseReason: 'action-outcome-ambiguous',
          retrySafety: 'inspect-first',
          guidance,
          submit: {
            at: submitPoint,
            ...(resolvedClick.value.target ? { target: compactNodeReference(resolvedClick.value.target) } : {}),
            ...waitStatusPayload(clickWait),
          },
        }), null, detail === 'verbose' ? 2 : undefined))
      }

      let waitResult: WaitConditionResult | undefined
      let waitError: string | undefined
      if (waitFor) {
        if (!hasSoftBudget(deadlineAt)) {
          return ok(JSON.stringify(pausedPayload('wait_for', {
            tool: 'geometra_wait_for',
            ...compactFilterPayload(waitFilter),
            present: waitFor.present ?? true,
            ...(waitFor.timeoutMs !== undefined ? { timeoutMs: waitFor.timeoutMs } : {}),
          }, {
            submit: {
              at: submitPoint,
              ...(resolvedClick.value.target ? { target: compactNodeReference(resolvedClick.value.target) } : {}),
              ...waitStatusPayload(clickWait),
            },
          }), null, detail === 'verbose' ? 2 : undefined))
        }
        const postWait = await waitForSemanticCondition(session, {
          filter: waitFilter,
          present: waitFor.present ?? true,
          timeoutMs: capTimeoutMs(waitFor.timeoutMs, timeoutCapFromDeadline(deadlineAt), 15_000),
        })
        if (!postWait.ok) {
          waitError = postWait.error
        } else {
          waitResult = postWait.value
        }
      }

      const after = sessionA11y(session)
      const signals = after
        ? scopeSessionSignalsToForm(
            after,
            submitFormPath ? formScopeNodeAtPath(after, submitFormPath) : undefined,
            submitFormPath !== undefined,
          )
        : undefined
      const clickResult = clickWait.result && typeof clickWait.result === 'object'
        ? clickWait.result as Record<string, unknown>
        : undefined
      const clickAfterUrl = typeof clickResult?.pageUrl === 'string' ? clickResult.pageUrl : undefined
      const clickBeforeUrl = typeof clickResult?.urlBefore === 'string' ? clickResult.urlBefore : beforeClickUrl
      const observedAfterUrl = after?.meta?.pageUrl
      const navigatedByClick = Boolean(
        clickResult?.navigated === true &&
        clickAfterUrl &&
        clickBeforeUrl &&
        clickAfterUrl !== clickBeforeUrl,
      )
      const navigatedByTree = Boolean(observedAfterUrl && beforeClickUrl && observedAfterUrl !== beforeClickUrl)
      const navigated = navigatedByClick || navigatedByTree
      const afterUrl = navigatedByClick && clickAfterUrl
        ? clickAfterUrl
        : observedAfterUrl ?? clickAfterUrl
      const waitEvidenceFresh = waitResult
        ? waitConditionHasFreshEvidence(beforeWaitEvidence, after, waitResult)
        : false
      const execution = 'completed'
      const invalidCount = signals?.invalidFields.length ?? 0
      const outcome: 'submitted' | 'validation_failed' | 'unconfirmed' = invalidCount > 0
        ? 'validation_failed'
        : waitError
          ? 'unconfirmed'
          : waitFor
            ? waitEvidenceFresh
              ? 'submitted'
              : 'unconfirmed'
            : navigated
            ? 'submitted'
            : 'unconfirmed'
      const completed = outcome === 'submitted'

      // Aggregate all fallback usage into a single top-level `fallbacks[]`
      // array so this tool matches the shape emitted by `geometra_run_actions`
      // and can be aggregated the same way by operators.
      const fallbackRecords: Array<Record<string, unknown>> = []
      if (fillFallback) {
        fallbackRecords.push({ phase: 'fill', ...fillFallback })
      }
      if (resolvedClick.fallback) {
        fallbackRecords.push({ phase: 'submit', ...resolvedClick.fallback })
      }

      const payload: Record<string, unknown> = {
        ...connection,
        completed,
        execution,
        outcome,
        ...(fillSummary ? { fill: fillSummary } : {}),
        submit: {
          at: submitPoint,
          ...(resolvedClick.value.target ? { target: compactNodeReference(resolvedClick.value.target), revealSteps: resolvedClick.value.revealAttempts ?? 0 } : {}),
          ...waitStatusPayload(clickWait),
        },
        ...(waitResult
          ? { waitFor: { ...waitConditionCompact(waitResult), fresh: waitEvidenceFresh } }
          : waitError
            ? { waitFor: { ok: false, error: waitError } }
            : {}),
        ...(fallbackRecords.length > 0 ? { fallbacks: fallbackRecords } : {}),
        ...(navigated ? { navigated: true, ...(afterUrl ? { afterUrl } : {}) } : {}),
        ...(signals ? { final: sessionSignalsPayload(signals, detail) } : {}),
      }

      // Pull in page model hints on navigation to mirror fill_form behavior.
      if (navigated && after) {
        const model = buildPageModel(after)
        if (model.captcha) payload.captcha = model.captcha
        if (model.verification) payload.verification = model.verification
      }

      const serialized = JSON.stringify(payload, null, detail === 'verbose' ? 2 : undefined)
      if (waitError) return err(serialized)
      if (failOnInvalid && outcome === 'validation_failed') return err(serialized)
      return ok(serialized)
    }
  )

  server.tool(
    'geometra_run_actions',
    `Execute several Geometra actions in one MCP round trip and return one consolidated result. This is the preferred path for long, multi-step form fills where one-tool-per-field would otherwise create too much chatter.

Supported step types: \`click\`, \`type\`, \`key\`, \`upload_files\`, \`pick_listbox_option\`, \`select_option\`, \`set_checked\`, \`wheel\`, \`wait_for\`, \`expand_section\`, and \`fill_fields\`. \`click\` steps can also carry a nested \`waitFor\` condition. \`fill_fields\` steps can carry \`verifyFills: true\` to batch fill + read-back verification in one step (same semantics as \`geometra_fill_form\`'s \`verifyFills\`). \`expand_section\` takes a stable section id from \`geometra_page_model\` and returns the same payload as \`geometra_expand_section\`, eliminating a round-trip when drilling into a form/dialog before acting on it. Pass \`pageUrl\` / \`url\` to auto-connect so an entire flow can run in one MCP call.`,
    {
      url: z.string().optional().describe('Optional target URL. Use a ws:// Geometra server URL or an http(s) page URL to auto-connect before running actions.'),
      pageUrl: z.string().optional().describe('Optional http(s) page URL to auto-connect before running actions. Prefer this over url for browser pages.'),
      port: z.number().int().min(0).max(65535).optional().describe('Preferred local port for an auto-spawned proxy (default: ephemeral OS-assigned port).'),
      headless: z.boolean().optional().describe('Run Chromium headless when auto-spawning a proxy (default true). Set false for a visible window.'),
      width: z.number().int().positive().optional().describe('Viewport width for auto-connected sessions.'),
      height: z.number().int().positive().optional().describe('Viewport height for auto-connected sessions.'),
      slowMo: z.number().int().nonnegative().optional().describe('Playwright slowMo (ms) when auto-spawning a proxy.'),
      stealth: stealthInput(),
      browserMode: browserModeInput(),
      isolated: z
        .boolean()
        .optional()
        .describe('When auto-connecting via pageUrl/HTTP(S) url, use a fresh isolated Chromium by default. Pass false explicitly for sequential warm reuse.'),
      actions: z.array(batchActionSchema).min(1).max(80).describe('Ordered high-level action steps to run sequentially'),
      resumeFromIndex: z
        .number()
        .int()
        .min(0)
        .optional()
        .default(0)
        .describe('Resume a previous partial geometra_run_actions result from this action index. Use the returned resumeFromIndex when a call pauses.'),
      softTimeoutMs: softTimeoutMsInput(),
      stopOnError: z.boolean().optional().default(true).describe('Stop at the first failing step (default true)'),
      includeSteps: z
        .boolean()
        .optional()
        .default(true)
        .describe('Include per-action step results in the JSON payload (default true). Set false for the smallest batch response.'),
      output: z.enum(['full', 'final']).optional().default('full').describe('`full` (default) returns counts and optional step listings. `final` keeps only completion state plus final semantic signals.'),
      detail: detailInput(),
      sessionId: sessionIdInput,
    },
    async ({ url, pageUrl, port, headless, width, height, slowMo, stealth, browserMode, isolated, actions, resumeFromIndex, softTimeoutMs, stopOnError, includeSteps, output, detail, sessionId }) => {
      const browser = resolveBrowserStealth({ stealth, browserMode })
      if (!browser.ok) return err(browser.error)
      const toolStartedAt = performance.now()
      const effectiveSoftTimeoutMs = softTimeoutMs ?? HOST_SAFE_TOOL_TIMEOUT_MS
      const deadlineAt = toolStartedAt + effectiveSoftTimeoutMs
      const resolved = await ensureToolSession(
        {
          sessionId,
          url,
          pageUrl,
          port,
          headless,
          width,
          height,
          slowMo,
          stealth: browser.stealth,
          isolated,
          awaitInitialFrame: canDeferInitialFrameForRunActions(actions) ? false : undefined,
        },
        'Not connected. Call geometra_connect first, or pass pageUrl/url to geometra_run_actions.',
      )
      if (!resolved.ok) return err(resolved.error)
      const session = resolved.session
      const connection = autoConnectionPayload(resolved)
      const startIndex = resumeFromIndex ?? 0
      if (startIndex > actions.length) {
        return err(`resumeFromIndex ${startIndex} exceeds actions length ${actions.length}`)
      }

      const steps: Array<Record<string, unknown>> = []
      let stoppedAt: number | undefined
      let pausedAt: number | undefined
      let ambiguousAt: number | undefined
      const batchStartedAt = performance.now()
      // Collect transparent-fallback signals from each step so run_actions
      // surfaces them at top level regardless of `includeSteps` — otherwise
      // the telemetry is dead code when callers opt out of the steps listing.
      const fallbackRecords: Array<{ stepIndex: number; type: string; attempted: true; used: true; reason: string; attempts: number }> = []

      for (let index = startIndex; index < actions.length; index++) {
        if (!hasSoftBudget(deadlineAt)) {
          pausedAt = index
          break
        }

        const action = capBatchActionTimeouts(actions[index]!, timeoutCapFromDeadline(deadlineAt))
        const startedAt = performance.now()
        let uiTreeWaitMs = 0
        try {
          if (actionNeedsUiTree(action) && (!session.tree || !session.layout)) {
            const uiTreeWaitStartedAt = performance.now()
            await waitForUiCondition(
              session,
              () => Boolean(session.tree && session.layout),
              capTimeoutMs(2_000, timeoutCapFromDeadline(deadlineAt), 2_000),
            )
            uiTreeWaitMs = performance.now() - uiTreeWaitStartedAt
          }
          if (!hasSoftBudget(deadlineAt)) {
            pausedAt = index
            break
          }
          const result = await executeBatchAction(session, action, detail, includeSteps)
          const stepFallback = (result.compact as { fallback?: { attempted: true; used: true; reason: string; attempts: number } }).fallback
          if (stepFallback?.used) {
            fallbackRecords.push({
              stepIndex: index,
              type: action.type,
              attempted: true,
              used: true,
              reason: stepFallback.reason,
              attempts: stepFallback.attempts,
            })
          }
          const elapsedMs = Number((performance.now() - startedAt).toFixed(1))
          const cumulativeMs = Number((performance.now() - batchStartedAt).toFixed(1))

          const stepSignals = includeSteps ? (() => {
            const a = sessionA11y(session)
            if (!a) return undefined
            const s = collectSessionSignals(a)
            return { invalidCount: s.invalidFields.length, alertCount: s.alerts.length, dialogCount: s.dialogCount, busyCount: s.busyCount }
          })() : undefined

          steps.push(detail === 'verbose'
            ? {
                index,
                type: action.type,
                ok: true,
                elapsedMs,
                cumulativeMs,
                ...(uiTreeWaitMs > 0 ? { uiTreeWaitMs: Number(uiTreeWaitMs.toFixed(1)) } : {}),
                summary: result.summary,
                ...(stepSignals ? { signals: stepSignals } : {}),
              }
            : {
                index,
                type: action.type,
                ok: true,
                elapsedMs,
                cumulativeMs,
                ...(uiTreeWaitMs > 0 ? { uiTreeWaitMs: Number(uiTreeWaitMs.toFixed(1)) } : {}),
                ...result.compact,
                ...(stepSignals ? { signals: stepSignals } : {}),
              })
          if (index + 1 < actions.length && !hasSoftBudget(deadlineAt)) {
            pausedAt = index + 1
            break
          }
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e)
          const ambiguity = ambiguousOutcomeDetails(e)
          const elapsedMs = Number((performance.now() - startedAt).toFixed(1))
          const cumulativeMs = Number((performance.now() - batchStartedAt).toFixed(1))
          steps.push({
            index,
            type: action.type,
            ok: false,
            elapsedMs,
            cumulativeMs,
            ...(uiTreeWaitMs > 0 ? { uiTreeWaitMs: Number(uiTreeWaitMs.toFixed(1)) } : {}),
            error: message,
            ...(ambiguity ? ambiguousOutcomePayload(ambiguity) : {}),
          })
          if (ambiguity) {
            // Continuing would silently skip a mutation that may still land.
            // Stop regardless of stopOnError and pin any resume to this step.
            ambiguousAt = index
            stoppedAt = index
            break
          }
          if (stopOnError) {
            stoppedAt = index
            break
          }
        }
      }

      const after = sessionA11y(session)
      const successCount = steps.filter(step => step.ok === true).length
      const errorCount = steps.length - successCount
      const elapsedMs = Number((performance.now() - toolStartedAt).toFixed(1))
      const completed = errorCount === 0 && stoppedAt === undefined && pausedAt === undefined && startIndex + steps.length >= actions.length
      const resumePayload = {
        ...(startIndex > 0 ? { resumedFromIndex: startIndex } : {}),
        ...(ambiguousAt !== undefined
          ? {
              ambiguous: true,
              ambiguousAt,
              resumeBlocked: true,
              resumeFromIndex: ambiguousAt,
              resumeInstruction: 'Do not skip this ambiguous step. Inspect the current UI; an identical retry will reuse its action identity when deduplication is supported.',
            }
          : {}),
        ...(pausedAt !== undefined
          ? {
              paused: true,
              pausedAt,
              resumeFromIndex: pausedAt,
              pauseReason: 'soft-timeout',
              softTimeoutMs: effectiveSoftTimeoutMs,
              elapsedMs,
            }
          : {}),
      }
      const payload = output === 'final'
        ? {
            ...connection,
            completed,
            successCount,
            errorCount,
            ...resumePayload,
            ...(stoppedAt !== undefined ? { stoppedAt } : {}),
            ...(fallbackRecords.length > 0 ? { fallbacks: fallbackRecords } : {}),
            ...(after ? { final: sessionSignalsPayload(collectSessionSignals(after), detail) } : {}),
          }
        : {
            ...connection,
            completed,
            stepCount: actions.length,
            successCount,
            errorCount,
            ...resumePayload,
            ...(includeSteps ? { steps } : {}),
            ...(stoppedAt !== undefined ? { stoppedAt } : {}),
            ...(fallbackRecords.length > 0 ? { fallbacks: fallbackRecords } : {}),
            ...(after ? { final: sessionSignalsPayload(collectSessionSignals(after), detail) } : {}),
          }
      return ok(JSON.stringify(payload, null, detail === 'verbose' ? 2 : undefined))
    }
  )

  // ── page model ────────────────────────────────────────────────
  server.tool(
    'geometra_page_model',
    `Get a higher-level webpage summary instead of a raw node dump. Returns stable section ids, page archetypes, summary counts, top-level landmarks/forms/dialogs/lists, and a few primary actions.

Use this first on normal HTML pages when you want to understand the page shape with fewer tokens than a full snapshot. Then call geometra_expand_section on a returned section id when you need details.`,
    {
      maxPrimaryActions: z
        .number()
        .int()
        .min(1)
        .max(12)
        .optional()
        .default(6)
        .describe('Cap top-level primary actions (default 6).'),
      maxSectionsPerKind: z
        .number()
        .int()
        .min(1)
        .max(16)
        .optional()
        .default(8)
        .describe('Cap returned landmarks/forms/dialogs/lists per kind (default 8).'),
      includeScreenshot: z
        .boolean()
        .optional()
        .default(false)
        .describe('Attach a base64 PNG viewport screenshot. Requires @geometra/proxy. Use when geometry alone is ambiguous (icon-only buttons, visual styling cues).'),
      blockDetection: blockDetectionInput(),
      blockedSitePolicy: blockedSitePolicyInput(),
      manualHandoff: manualHandoffInput(),
      sessionId: sessionIdInput,
    },
    async ({ maxPrimaryActions, maxSectionsPerKind, includeScreenshot, blockDetection, blockedSitePolicy, manualHandoff, sessionId }) => {
      const sessionResult = resolveToolSession(sessionId)
      if ('error' in sessionResult) return sessionResult.error
      const session = sessionResult.session

      const a11y = await sessionA11yWhenReady(session)
      if (!a11y) return err('No UI tree available')
      const model = buildPageModel(a11y, { maxPrimaryActions, maxSectionsPerKind, blockDetection })
      const policy = effectiveBlockedSitePolicy(blockedSitePolicy, manualHandoff)
      if (policy === 'error' && model.blockedSite?.detected) {
        return err(JSON.stringify(blockedSitePolicyErrorPayload(model.blockedSite, policy)))
      }
      const payload = applyBlockedSitePolicyPayload(
        model as unknown as Record<string, unknown>,
        model.blockedSite,
        { policy: blockedSitePolicy, manualHandoff, pageUrl: a11y.meta?.pageUrl },
      )
      const screenshot = includeScreenshot ? await captureScreenshotBase64(session) : undefined
      return ok(JSON.stringify(payload), screenshot)
    }
  )

  server.tool(
    'geometra_form_schema',
    `Get a compact, fill-oriented schema for forms on the page. This is the preferred discovery step before geometra_fill_form.

Unlike geometra_expand_section, this collapses repeated radio/button groups into single logical fields, keeps output compact, and omits layout-heavy detail by default. If you pass \`pageUrl\` or \`url\`, MCP will connect first so discovery can happen in one tool call.`,
    {
      url: z.string().optional().describe('Optional target URL. Use a ws:// Geometra server URL or an http(s) page URL to auto-connect before discovery.'),
      pageUrl: z.string().optional().describe('Optional http(s) page URL to auto-connect before discovery. Prefer this over url for browser pages.'),
      port: z.number().int().min(0).max(65535).optional().describe('Preferred local port for an auto-spawned proxy (default: ephemeral OS-assigned port).'),
      headless: z.boolean().optional().describe('Run Chromium headless when auto-spawning a proxy (default true). Set false for a visible window.'),
      width: z.number().int().positive().optional().describe('Viewport width for auto-connected sessions.'),
      height: z.number().int().positive().optional().describe('Viewport height for auto-connected sessions.'),
      slowMo: z.number().int().nonnegative().optional().describe('Playwright slowMo (ms) when auto-spawning a proxy.'),
      stealth: stealthInput(),
      browserMode: browserModeInput(),
      isolated: z
        .boolean()
        .optional()
        .describe('When auto-connecting via pageUrl/HTTP(S) url, use a fresh isolated Chromium by default. Pass false explicitly for sequential warm reuse.'),
      formId: z.string().optional().describe('Optional form id from geometra_page_model. If omitted, returns every form schema on the page.'),
      maxFields: z.number().int().min(1).max(120).optional().default(80).describe('Cap returned fields per form'),
      onlyRequiredFields: z.boolean().optional().default(false).describe('Only include required fields'),
      onlyInvalidFields: z.boolean().optional().default(false).describe('Only include invalid fields'),
      includeOptions: z.boolean().optional().default(false).describe('Include explicit choice option labels'),
      includeFormGraph: z.boolean().optional().default(false).describe('Also include FormGraph 0.1-compatible graphs for the returned forms'),
      includeContext: formSchemaContextInput(),
      sinceSchemaId: z.string().optional().describe('If the current schema matches this id, return changed=false without resending forms'),
      format: formSchemaFormatInput(),
      sessionId: sessionIdInput,
    },
    async ({ url, pageUrl, port, headless, width, height, slowMo, stealth, browserMode, isolated, formId, maxFields, onlyRequiredFields, onlyInvalidFields, includeOptions, includeFormGraph, includeContext, sinceSchemaId, format, sessionId }) => {
      const browser = resolveBrowserStealth({ stealth, browserMode })
      if (!browser.ok) return err(browser.error)
      const resolved = await ensureToolSession(
        { sessionId, url, pageUrl, port, headless, width, height, slowMo, stealth: browser.stealth, isolated },
        'Not connected. Call geometra_connect first, or pass pageUrl/url to geometra_form_schema.',
      )
      if (!resolved.ok) return err(resolved.error)
      const session = resolved.session
      if (!(await ensureSessionUiTree(session, 4_000))) {
        return err('Timed out waiting for the initial UI tree after connect.')
      }

      const payload = formSchemaResponsePayload(session, {
        formId,
        maxFields,
        onlyRequiredFields,
        onlyInvalidFields,
        includeOptions,
        includeFormGraph,
        includeContext,
        sinceSchemaId,
        format,
      })
      if (payload.formCount === 0) {
        return err(formId ? `No form schema found for id ${formId}` : 'No forms found in the current UI')
      }
      return ok(JSON.stringify({
        ...autoConnectionPayload(resolved),
        ...payload,
      }))
    }
  )

  server.tool(
    'geometra_expand_section',
    `Expand one section from geometra_page_model by stable id. Returns richer on-demand details such as headings, fields, actions, nested lists, list items, and text preview.

Use this after geometra_page_model when you know which form/dialog/list/landmark you want to inspect more closely. Per-item bounds are omitted by default to save tokens; set includeBounds=true if you need them immediately.`,
    {
      id: z.string().describe('Section id from geometra_page_model, e.g. fm:1.0 or ls:2.1'),
      maxHeadings: z.number().int().min(1).max(20).optional().default(6).describe('Cap heading rows'),
      maxFields: z.number().int().min(1).max(40).optional().default(18).describe('Cap field rows'),
      fieldOffset: z.number().int().min(0).optional().default(0).describe('Field row offset for long forms'),
      onlyRequiredFields: z.boolean().optional().default(false).describe('Only include required fields'),
      onlyInvalidFields: z.boolean().optional().default(false).describe('Only include invalid fields'),
      maxActions: z.number().int().min(1).max(30).optional().default(12).describe('Cap action rows'),
      actionOffset: z.number().int().min(0).optional().default(0).describe('Action row offset'),
      maxLists: z.number().int().min(0).max(20).optional().default(8).describe('Cap nested lists'),
      listOffset: z.number().int().min(0).optional().default(0).describe('Nested-list offset'),
      maxItems: z.number().int().min(0).max(50).optional().default(20).describe('Cap list items'),
      itemOffset: z.number().int().min(0).optional().default(0).describe('List-item offset'),
      maxTextPreview: z.number().int().min(0).max(20).optional().default(6).describe('Cap text preview lines'),
      includeBounds: z.boolean().optional().default(false).describe('Include bounds for fields/actions/headings/items'),
      sessionId: sessionIdInput,
    },
    async ({
      id,
      maxHeadings,
      maxFields,
      fieldOffset,
      onlyRequiredFields,
      onlyInvalidFields,
      maxActions,
      actionOffset,
      maxLists,
      listOffset,
      maxItems,
      itemOffset,
      maxTextPreview,
      includeBounds,
      sessionId,
    }) => {
      const sessionResult = resolveToolSession(sessionId)
      if ('error' in sessionResult) return sessionResult.error
      const session = sessionResult.session

      const a11y = await sessionA11yWhenReady(session)
      if (!a11y) return err('No UI tree available')
      const detail = expandPageSection(a11y, id, {
        maxHeadings,
        maxFields,
        fieldOffset,
        onlyRequiredFields,
        onlyInvalidFields,
        maxActions,
        actionOffset,
        maxLists,
        listOffset,
        maxItems,
        itemOffset,
        maxTextPreview,
        includeBounds,
      })
      if (!detail) return err(`No expandable section found for id ${id}`)
      return ok(JSON.stringify(detail))
    }
  )

  server.tool(
    'geometra_scroll_to',
    `Scroll the page until a matching element is visible. Use this to reach off-screen elements like Submit buttons at the bottom of long forms, or fields below the fold.

This is the preferred approach for scrolling — no need to guess pixel offsets or wheel deltas. Accepts the same filters as geometra_query, plus an optional match index when repeated controls share the same visible label. Auto-scales scroll steps based on distance.`,
    {
      ...nodeFilterShape(),
      index: z.number().int().min(0).optional().default(0).describe('Which matching node to reveal after sorting top-to-bottom'),
      fullyVisible: z.boolean().optional().default(true).describe('Require the target to become fully visible (default true)'),
      maxSteps: z.number().int().min(1).max(48).optional().describe('Maximum reveal attempts before returning an error. When omitted, Geometra auto-scales from scroll distance for tall forms.'),
      timeoutMs: z
        .number()
        .int()
        .min(50)
        .max(60_000)
        .optional()
        .default(2_500)
        .describe('Per-scroll wait timeout (default 2500ms)'),
      sessionId: sessionIdInput,
    },
    async ({ id, role, name, text, contextText, promptText, sectionText, itemText, value, checked, disabled, focused, selected, expanded, invalid, required, busy, index, fullyVisible, maxSteps, timeoutMs, sessionId }) => {
      const sessionResult = resolveToolSession(sessionId)
      if ('error' in sessionResult) return sessionResult.error
      const session = sessionResult.session

      const filter: NodeFilter = {
        id,
        role,
        name,
        text,
        contextText,
        promptText,
        sectionText,
        itemText,
        value,
        checked,
        disabled,
        focused,
        selected,
        expanded,
        invalid,
        required,
        busy,
      }
      if (!hasNodeFilter(filter)) return err('Provide at least one reveal filter (id, role, name, text, contextText, promptText, sectionText, itemText, value, or state)')

      const revealed = await revealSemanticTarget(session, {
        filter,
        index: index ?? 0,
        fullyVisible: fullyVisible ?? true,
        maxSteps,
        timeoutMs: timeoutMs ?? 2_500,
      })
      if (!revealed.ok) return err(revealed.error)

      return ok(JSON.stringify({
        revealed: true,
        attempts: revealed.value.attempts,
        target: revealed.value.target,
      }, null, 2))
    }
  )

  // ── click ────────────────────────────────────────────────────
  server.tool(
    'geometra_click',
    `Click an element in the Geometra UI. Provide either raw x,y coordinates or a semantic target (\`id\`, \`role\`, \`name\`, \`text\`, \`contextText\`, \`value\`, or state filters). You can also attach \`waitFor\` to block on the post-click semantic state in the same call. The click is dispatched server-side via the geometry protocol — no browser, no simulated DOM events.

After clicking, returns a compact semantic delta when possible (dialogs/forms/lists/nodes changed). If nothing meaningful changed, returns a short current-UI overview.`,
    {
      x: z.number().optional().describe('X coordinate to click (use center of element bounds from geometra_query)'),
      y: z.number().optional().describe('Y coordinate to click'),
      ...nodeFilterShape(),
      index: z.number().int().min(0).optional().default(0).describe('Which matching semantic target to click after sorting top-to-bottom'),
      fullyVisible: z.boolean().optional().default(true).describe('When clicking by semantic target, require full visibility before clicking (default true)'),
      maxRevealSteps: z.number().int().min(1).max(48).optional().describe('Maximum reveal attempts before clicking a semantic target. When omitted, Geometra auto-scales from scroll distance for tall forms.'),
      revealTimeoutMs: z
        .number()
        .int()
        .min(50)
        .max(60_000)
        .optional()
        .default(2_500)
        .describe('Per-scroll wait timeout while revealing a semantic target (default 2500ms)'),
      waitFor: z.object(waitConditionShape()).strict().optional().describe('Optional semantic condition to wait for after the click'),
      timeoutMs: z
        .number()
        .int()
        .min(50)
        .max(60_000)
        .optional()
        .describe('Optional action wait timeout (use a longer value for slow submits or route transitions)'),
      detail: detailInput(),
      sessionId: sessionIdInput,
    },
    async ({ x, y, id, role, name, text, contextText, promptText, sectionText, itemText, value, checked, disabled, focused, selected, expanded, invalid, required, busy, index, fullyVisible, maxRevealSteps, revealTimeoutMs, waitFor, timeoutMs, detail, sessionId }) => {
      const sessionResult = resolveToolSession(sessionId)
      if ('error' in sessionResult) return sessionResult.error
      const session = sessionResult.session
      const before = sessionA11y(session)
      const resolved = await resolveClickLocationWithFallback(session, {
        x,
        y,
        filter: {
          id,
          role,
          name,
          text,
          contextText,
          promptText,
          sectionText,
          itemText,
          value,
          checked,
          disabled,
          focused,
          selected,
          expanded,
          invalid,
          required,
          busy,
        },
        index,
        fullyVisible,
        maxRevealSteps,
        revealTimeoutMs,
      })
      if (!resolved.ok) return err(clickFallbackErrorMessage(resolved))

      const waitFilter: NodeFilter | undefined = waitFor ? {
        id: waitFor.id,
        role: waitFor.role,
        name: waitFor.name,
        text: waitFor.text,
        contextText: waitFor.contextText,
        promptText: waitFor.promptText,
        sectionText: waitFor.sectionText,
        itemText: waitFor.itemText,
        value: waitFor.value,
        checked: waitFor.checked,
        disabled: waitFor.disabled,
        focused: waitFor.focused,
        selected: waitFor.selected,
        expanded: waitFor.expanded,
        invalid: waitFor.invalid,
        required: waitFor.required,
        busy: waitFor.busy,
      } : undefined
      const waitEvidenceRoot = sessionA11y(session) ?? before
      const beforeWaitEvidence = waitFilter && waitEvidenceRoot
        ? captureWaitEvidence(waitEvidenceRoot, waitFilter)
        : undefined
      const wait = await sendClick(session, resolved.value.x, resolved.value.y, timeoutMs)

      const summary = postActionSummary(session, before, wait, detail)
      const clickLine = !resolved.value.target
        ? `Clicked at (${resolved.value.x}, ${resolved.value.y}).`
        : `Clicked ${describeFormattedNode(resolved.value.target)} at (${resolved.value.x}, ${resolved.value.y})${resolved.value.revealAttempts && resolved.value.revealAttempts > 0 ? ` after ${resolved.value.revealAttempts} reveal step${resolved.value.revealAttempts === 1 ? '' : 's'}` : ''}.`
      const lines = [clickLine, summary]
      if (waitFor) {
        const postWait = await waitForSemanticCondition(session, {
          filter: waitFilter!,
          present: waitFor.present ?? true,
          timeoutMs: waitFor.timeoutMs ?? 10_000,
        })
        if (!postWait.ok) return err([...lines, postWait.error].join('\n'))
        const fresh = waitConditionHasFreshEvidence(beforeWaitEvidence, sessionA11y(session), postWait.value)
        if (!fresh) {
          return err([...lines, 'Post-click condition matched only pre-existing evidence; the click outcome is unconfirmed.'].join('\n'))
        }
        lines.push(`Post-click ${waitConditionSuccessLine(postWait.value)}`)
        const compact = {
          at: { x: resolved.value.x, y: resolved.value.y },
          ...(resolved.value.target ? { target: compactNodeReference(resolved.value.target), revealSteps: resolved.value.revealAttempts ?? 0 } : {}),
          ...waitStatusPayload(wait),
          ...(resolved.fallback ? { fallback: resolved.fallback } : {}),
          postWait: { ...waitConditionCompact(postWait.value), fresh: true },
        }
        return ok(detailText(lines.filter(Boolean).join('\n'), compact, detail))
      }
      const compact = {
        at: { x: resolved.value.x, y: resolved.value.y },
        ...(resolved.value.target ? { target: compactNodeReference(resolved.value.target), revealSteps: resolved.value.revealAttempts ?? 0 } : {}),
        ...waitStatusPayload(wait),
        ...(resolved.fallback ? { fallback: resolved.fallback } : {}),
      }
      if (wait.status === 'timed_out') {
        const guidance = ambiguousActionGuidance(wait)
        return err(detailText([...lines.filter(Boolean), guidance].join('\n'), {
          completed: false,
          outcome: 'unconfirmed',
          retrySafety: 'inspect-first',
          guidance,
          ...compact,
        }, detail))
      }
      return ok(detailText(lines.filter(Boolean).join('\n'), compact, detail))
    }
  )

  // ── type ─────────────────────────────────────────────────────
  server.tool(
    'geometra_type',
    `Type text into the currently focused element. First click a textbox/input with geometra_click to focus it, then use this to type.

Each character is sent as a key event through the geometry protocol. Returns a compact semantic delta when possible, otherwise a short current-UI overview.`,
    {
      text: z.string().max(65_536).describe('Text to type into the focused element (maximum 65,536 characters)'),
      timeoutMs: z
        .number()
        .int()
        .min(50)
        .max(60_000)
        .optional()
        .describe('Optional action wait timeout'),
      detail: detailInput(),
      sessionId: sessionIdInput,
    },
    async ({ text, timeoutMs, detail, sessionId }) => {
      const sessionResult = resolveToolSession(sessionId)
      if ('error' in sessionResult) return sessionResult.error
      const session = sessionResult.session
      const before = sessionA11y(session)

      const wait = await sendType(session, text, timeoutMs)

      const summary = postActionSummary(session, before, wait, detail)
      return actionWaitResponse(wait, `Typed "${text}".\n${summary}`, {
        ...compactTextValue(text),
        ...waitStatusPayload(wait),
      }, detail)
    }
  )

  // ── key ──────────────────────────────────────────────────────
  server.tool(
    'geometra_key',
    `Send a special key press (Enter, Tab, Escape, ArrowDown, etc.) to the Geometra UI. Useful for form submission, focus navigation, and keyboard shortcuts.`,
    {
      key: z.string().describe('Key to press (e.g. "Enter", "Tab", "Escape", "ArrowDown", "Backspace")'),
      shift: z.boolean().optional().describe('Hold Shift'),
      ctrl: z.boolean().optional().describe('Hold Ctrl'),
      meta: z.boolean().optional().describe('Hold Meta/Cmd'),
      alt: z.boolean().optional().describe('Hold Alt'),
      timeoutMs: z
        .number()
        .int()
        .min(50)
        .max(60_000)
        .optional()
        .describe('Optional action wait timeout'),
      detail: detailInput(),
      sessionId: sessionIdInput,
    },
    async ({ key, shift, ctrl, meta, alt, timeoutMs, detail, sessionId }) => {
      const sessionResult = resolveToolSession(sessionId)
      if ('error' in sessionResult) return sessionResult.error
      const session = sessionResult.session
      const before = sessionA11y(session)

      const wait = await sendKey(session, key, { shift, ctrl, meta, alt }, timeoutMs)

      const summary = postActionSummary(session, before, wait, detail)
      return actionWaitResponse(wait, `Pressed ${formatKeyCombo(key, { shift, ctrl, meta, alt })}.\n${summary}`, {
        key: formatKeyCombo(key, { shift, ctrl, meta, alt }),
        ...waitStatusPayload(wait),
      }, detail)
    }
  )

  // ── fill OTP / verification-code box group ─────────────────────
  server.tool(
    'geometra_fill_otp',
    `Fill a multi-cell OTP / verification-code input group (e.g. Greenhouse's 8-box security code, generic 6-digit 2FA widgets, Auth0 / Clerk per-char inputs). Auto-detects a row of sibling <input maxlength="1"> elements at adjacent x-coordinates and types each character through a real keyboard event cycle so React's per-cell onKeyDown handler can auto-advance focus.

Use this when geometra_fill_fields / geometra_fill_form fail on a 6-digit code field because the cells share accessibility bounds and the whole string gets written into cell 0 (which has maxlength=1 and silently truncates). This primitive is also auto-invoked by geometra_fill_fields and geometra_fill_form when a labeled field matches a verification-code / security-code / OTP pattern AND the underlying DOM is a cell group — you should only need to call it directly when the label doesn't match the auto-detection heuristic.

Detection is fully generic (no site branding). It refuses to run if the detected group's cell count is smaller than the typed value length, and it post-verifies every cell's value so you get an honest error instead of a silent "success" that leaves boxes empty.`,
    {
      value: z.string().min(1).max(32).describe('The code to type (e.g. "12345678" for an 8-digit security code)'),
      fieldLabel: z.string().optional().describe('Optional label to scope the OTP search (e.g. "Security code", "Verification code"). When omitted, scans the whole document for any qualifying cell group.'),
      perCharDelayMs: z.number().int().min(0).max(500).optional().describe('Optional per-character typing delay in milliseconds (default 30). Raise this if the widget needs longer to run its onKeyDown auto-advance.'),
      timeoutMs: z
        .number()
        .int()
        .min(500)
        .max(60_000)
        .optional()
        .describe('Optional action wait timeout'),
      detail: detailInput(),
      sessionId: sessionIdInput,
    },
    async ({ value, fieldLabel, perCharDelayMs, timeoutMs, detail, sessionId }) => {
      const sessionResult = resolveToolSession(sessionId)
      if ('error' in sessionResult) return sessionResult.error
      const session = sessionResult.session
      const before = sessionA11y(session)

      try {
        const wait = await sendFillOtp(
          session,
          value,
          { fieldLabel, perCharDelayMs },
          timeoutMs,
        )
        const summary = postActionSummary(session, before, wait, detail)
        const result = wait.result as Record<string, unknown> | undefined
        return actionWaitResponse(
          wait,
          `Filled OTP code (${value.length} chars).\n${summary}`,
          {
            ...compactTextValue(value),
            ...(fieldLabel ? { fieldLabel } : {}),
            ...(result?.cellCount !== undefined ? { cellCount: result.cellCount } : {}),
            ...(result?.filledCount !== undefined ? { filledCount: result.filledCount } : {}),
            ...waitStatusPayload(wait),
          },
          detail,
        )
      } catch (e) {
        return err((e as Error).message)
      }
    }
  )

  // ── upload files (proxy) ───────────────────────────────────────
  server.registerTool(
    'geometra_upload_files',
    {
      description: `Attach local files to a file input. Requires \`@geometra/proxy\` (paths exist on the proxy host).

Every upload must name one explicit target. **auto** (default) accepts either a complete x,y chooser target or a labeled field. **hidden** requires fieldLabel. **chooser** requires x,y. **drop** requires dropX,dropY. Geometra rejects incomplete, conflicting, and global-first-input targets.`,
      inputSchema: z.object({
        paths: z.array(z.string().trim().min(1)).min(1).describe('Absolute paths on the proxy machine, e.g. /Users/you/resume.pdf'),
        x: z.number().optional().describe('Click X to trigger native file chooser; must be paired with y'),
        y: z.number().optional().describe('Click Y to trigger native file chooser; must be paired with x'),
        fieldLabel: z.string().trim().min(1).optional().describe('Specific labeled file field (for example "Resume" or "Cover letter")'),
        exact: z.boolean().optional().describe('Exact match when using fieldLabel'),
        strategy: z
          .enum(['auto', 'chooser', 'hidden', 'drop'])
          .optional()
          .describe('Upload strategy (default auto)'),
        dropX: z.number().optional().describe('Drop target X (viewport) for strategy drop; must be paired with dropY'),
        dropY: z.number().optional().describe('Drop target Y (viewport) for strategy drop; must be paired with dropX'),
        contextText: z.string().trim().min(1).optional().describe('Ancestor / prompt text to disambiguate repeated file inputs; requires fieldLabel'),
        sectionText: z.string().trim().min(1).optional().describe('Containing section text to disambiguate repeated file inputs; requires fieldLabel'),
        timeoutMs: z
          .number()
          .int()
          .min(50)
          .max(60_000)
          .optional()
          .describe('Optional action wait timeout (resume parsing / SPA upload flows often need longer than a normal click)'),
        detail: detailInput(),
        sessionId: sessionIdInput,
      }).strict().superRefine((input, ctx) => {
        addActionContractIssue(ctx, fileUploadContractError(input))
      }),
    },
    async ({ paths, x, y, fieldLabel, exact, strategy, dropX, dropY, contextText, sectionText, timeoutMs, detail, sessionId }) => {
      const contractError = fileUploadContractError({ x, y, fieldLabel, exact, strategy, dropX, dropY, contextText, sectionText })
      if (contractError) return err(contractError)
      const sessionResult = resolveToolSession(sessionId)
      if ('error' in sessionResult) return sessionResult.error
      const session = sessionResult.session
      const before = sessionA11y(session)
      try {
        const wait = await sendFileUpload(session, paths, {
          click: x !== undefined && y !== undefined ? { x, y } : undefined,
          fieldLabel,
          exact,
          strategy,
          drop: dropX !== undefined && dropY !== undefined ? { x: dropX, y: dropY } : undefined,
          contextText,
          sectionText,
        }, timeoutMs ?? 8_000)
        const summary = postActionSummary(session, before, wait, detail)
        return actionWaitResponse(wait, `Uploaded ${paths.length} file(s).\n${summary}`, {
          fileCount: paths.length,
          ...(fieldLabel ? { fieldLabel } : {}),
          ...(strategy ? { strategy } : {}),
          ...(contextText ? { contextText } : {}),
          ...(sectionText ? { sectionText } : {}),
          ...waitStatusPayload(wait),
          ...(fieldLabel ? { readback: fieldStatePayload(session, fieldLabel) } : {}),
        }, detail)
      } catch (e) {
        return err((e as Error).message)
      }
    }
  )

  server.registerTool(
    'geometra_pick_listbox_option',
    {
      description: `Pick an option from a custom dropdown / listbox / searchable combobox (Headless UI, React Select, Radix, Ashby-style custom selects, etc.). Requires \`@geometra/proxy\`.

fieldLabel is required so Geometra can confirm which control committed the selection. fieldId/fieldKey are supplemental exact identity and are only meaningful alongside fieldLabel. Coordinate-only opening is intentionally unsupported because it cannot provide field readback. If the opened control is editable, MCP types query (or the option label by default) before selecting.`,
      inputSchema: z.object({
        label: z.string().trim().min(1).describe('Accessible name of the option (visible text or aria-label)'),
        exact: z.boolean().optional().describe('Exact name match'),
        fieldId: z.string().trim().min(1).optional().describe('Stable field id from geometra_form_schema; used with fieldLabel'),
        fieldKey: z.string().trim().min(1).optional().describe('Authored field key from geometra_form_schema for exact resolution; used with fieldLabel'),
        fieldLabel: z.string().trim().min(1).describe('Field label of the dropdown/combobox to open and verify (e.g. "Location")'),
        query: z.string().optional().describe('Optional text to type into a searchable combobox before selecting'),
        timeoutMs: z
          .number()
          .int()
          .min(50)
          .max(60_000)
          .optional()
          .describe('Optional action wait timeout for slow dropdowns / remote search results'),
        detail: detailInput(),
        sessionId: sessionIdInput,
      }).strict().superRefine((input, ctx) => {
        addActionContractIssue(ctx, listboxPickContractError(input))
      }),
    },
    async ({ label, exact, fieldId, fieldKey, fieldLabel, query, timeoutMs, detail, sessionId }) => {
      const contractError = listboxPickContractError({ fieldId, fieldKey, fieldLabel })
      if (contractError) return err(contractError)
      const sessionResult = resolveToolSession(sessionId)
      if ('error' in sessionResult) return sessionResult.error
      const session = sessionResult.session
      const before = sessionA11y(session)
      try {
        const wait = await sendListboxPick(session, label, {
          exact,
          fieldId,
          fieldKey,
          fieldLabel,
          query,
        }, timeoutMs)
        const summary = postActionSummary(session, before, wait, detail)
        const fieldSummary = fieldLabel ? summarizeFieldLabelState(session, fieldLabel, fieldKey) : undefined
        const summaryText = [
          `Picked listbox option "${label}".`,
          fieldSummary,
          summary,
        ].filter(Boolean).join('\n')
        return actionWaitResponse(wait, summaryText, {
          label,
          ...(fieldId ? { fieldId } : {}),
          ...(fieldKey ? { fieldKey } : {}),
          ...(fieldLabel ? { fieldLabel } : {}),
          ...waitStatusPayload(wait),
          ...(fieldLabel ? { readback: fieldStatePayload(session, fieldLabel, fieldKey) } : {}),
        }, detail)
      } catch (e) {
        return err((e as Error).message)
      }
    }
  )

  // ── select option (proxy, native <select>) ─────────────────────
  server.registerTool(
    'geometra_select_option',
    {
      description: `Set a native HTML \`<select>\` after clicking its center (x,y from geometra_query). Requires \`@geometra/proxy\`.

Provide one or more of value, label, and index. Every supplied selector is conjunctive identity and must describe the same enabled option. Custom React/Vue dropdowns are not supported here — use \`geometra_pick_listbox_option\` for custom dropdowns / searchable comboboxes.`,
      inputSchema: z.object({
        x: z.number().describe('X coordinate (e.g. center of the select from geometra_query)'),
        y: z.number().describe('Y coordinate'),
        value: z.string().optional().describe('Exact option value= attribute'),
        label: z.string().trim().min(1).optional().describe('Exact normalized visible option label'),
        index: z.number().int().min(0).optional().describe('Zero-based option index'),
        timeoutMs: z
          .number()
          .int()
          .min(50)
          .max(60_000)
          .optional()
          .describe('Optional action wait timeout'),
        detail: detailInput(),
        sessionId: sessionIdInput,
      }).strict().superRefine((input, ctx) => {
        addActionContractIssue(ctx, selectOptionContractError(input))
      }),
    },
    async ({ x, y, value, label, index, timeoutMs, detail, sessionId }) => {
      const contractError = selectOptionContractError({ x, y, value, label, index })
      if (contractError) return err(contractError)
      const sessionResult = resolveToolSession(sessionId)
      if ('error' in sessionResult) return sessionResult.error
      const session = sessionResult.session
      const before = sessionA11y(session)
      try {
        const wait = await sendSelectOption(session, x, y, { value, label, index }, timeoutMs)
        const summary = postActionSummary(session, before, wait, detail)
        return actionWaitResponse(wait, `Selected option.\n${summary}`, {
          at: { x, y },
          ...(value !== undefined ? { value } : {}),
          ...(label !== undefined ? { label } : {}),
          ...(index !== undefined ? { index } : {}),
          ...waitStatusPayload(wait),
        }, detail)
      } catch (e) {
        return err((e as Error).message)
      }
    }
  )

  server.registerTool(
    'geometra_set_checked',
    {
      description: `Set a checkbox or radio by label. Requires \`@geometra/proxy\`.

Prefer this over raw coordinate clicks for custom forms that keep the real input visually hidden (common on Ashby, Greenhouse custom widgets, and design-system checkboxes/radios). Uses substring label matching unless exact=true. Unknown parameter names are rejected.`,
      inputSchema: z.object({
        label: z.string().trim().min(1, 'label must not be empty').describe('Accessible label or visible option text to match'),
        checked: z.boolean().optional().default(true).describe('Desired checked state (radios only support true)'),
        exact: z.boolean().optional().describe('Exact label match'),
        controlType: z.enum(['checkbox', 'radio']).optional().describe('Limit matching to checkbox or radio'),
        fieldKey: z.string().trim().min(1).optional().describe('Authored field key from geometra_form_schema for exact resolution'),
        contextText: z.string().trim().min(1).optional().describe('Ancestor / prompt text to disambiguate repeated checkboxes/radios'),
        sectionText: z.string().trim().min(1).optional().describe('Containing section text to disambiguate repeated checkboxes/radios'),
        timeoutMs: z
          .number()
          .int()
          .min(50)
          .max(60_000)
          .optional()
          .describe('Optional action wait timeout'),
        detail: detailInput(),
        sessionId: sessionIdInput,
      }).strict(),
    },
    async ({ label, checked, exact, controlType, fieldKey, contextText, sectionText, timeoutMs, detail, sessionId }) => {
      const sessionResult = resolveToolSession(sessionId)
      if ('error' in sessionResult) return sessionResult.error
      const session = sessionResult.session
      const before = sessionA11y(session)
      try {
        const wait = await sendSetChecked(session, label, {
          checked,
          exact,
          controlType,
          ...(fieldKey ? { fieldKey } : {}),
          contextText,
          sectionText,
        }, timeoutMs)
        const summary = postActionSummary(session, before, wait, detail)
        return actionWaitResponse(wait, `Set ${controlType ?? 'checkbox/radio'} "${label}" to ${String(checked ?? true)}.\n${summary}`, {
          label,
          checked: checked ?? true,
          ...(controlType ? { controlType } : {}),
          ...(fieldKey ? { fieldKey } : {}),
          ...(contextText ? { contextText } : {}),
          ...(sectionText ? { sectionText } : {}),
          ...waitStatusPayload(wait),
        }, detail)
      } catch (e) {
        return err((e as Error).message)
      }
    }
  )

  // ── wheel / scroll (proxy) ─────────────────────────────────────
  server.tool(
    'geometra_wheel',
    `Scroll the page or an element under the pointer using the mouse wheel. Requires \`@geometra/proxy\` (e.g. virtualized lists, long application forms).`,
    {
      deltaY: z.number().describe('Vertical scroll delta (positive scrolls down, typical step ~100)'),
      deltaX: z.number().optional().describe('Horizontal scroll delta'),
      x: z.number().optional().describe('Move pointer to X before scrolling'),
      y: z.number().optional().describe('Move pointer to Y before scrolling'),
      timeoutMs: z
        .number()
        .int()
        .min(50)
        .max(60_000)
        .optional()
        .describe('Optional action wait timeout'),
      detail: detailInput(),
      sessionId: sessionIdInput,
    },
    async ({ deltaY, deltaX, x, y, timeoutMs, detail, sessionId }) => {
      const sessionResult = resolveToolSession(sessionId)
      if ('error' in sessionResult) return sessionResult.error
      const session = sessionResult.session
      const before = sessionA11y(session)
      try {
        const wait = await sendWheel(session, deltaY, { deltaX, x, y }, timeoutMs)
        const summary = postActionSummary(session, before, wait, detail)
        return actionWaitResponse(wait, `Wheel delta (${deltaX ?? 0}, ${deltaY}).\n${summary}`, {
          deltaY,
          ...(deltaX !== undefined ? { deltaX } : {}),
          ...(x !== undefined && y !== undefined ? { at: { x, y } } : {}),
          ...waitStatusPayload(wait),
        }, detail)
      } catch (e) {
        return err((e as Error).message)
      }
    }
  )

  // ── list items (virtualized list pagination) ─────────────────
  server.tool(
    'geometra_list_items',
    `Auto-scroll a virtualized or long list and collect all visible items across scroll positions. Requires \`@geometra/proxy\`.

Use this for dropdowns, location pickers, or any scrollable list where items are rendered on demand. Scrolls down in steps, collecting new items each time, until no new items appear or the cap is reached.`,
    {
      listId: z.string().optional().describe('Stable section id from geometra_page_model (e.g. ls:2.1) to scope item collection'),
      role: z.string().optional().describe('Role filter for list items (default: listitem)'),
      scrollX: z.number().optional().describe('X coordinate to position mouse for scrolling (default: viewport center)'),
      scrollY: z.number().optional().describe('Y coordinate to position mouse for scrolling (default: viewport center)'),
      maxItems: z.number().int().min(1).max(500).optional().default(100).describe('Cap collected items (default 100)'),
      maxScrollSteps: z.number().int().min(1).max(50).optional().default(20).describe('Max scroll steps before stopping (default 20)'),
      scrollDelta: z.number().optional().default(300).describe('Vertical scroll delta per step (default 300)'),
      sessionId: sessionIdInput,
    },
    async ({ listId, role, scrollX, scrollY, maxItems, maxScrollSteps, scrollDelta, sessionId }) => {
      const sessionResult = resolveToolSession(sessionId)
      if ('error' in sessionResult) return sessionResult.error
      const session = sessionResult.session

      const itemRole = role ?? 'listitem'
      const collected = new Map<string, { name?: string; value?: string }>()
      const cx = scrollX ?? 400
      const cy = scrollY ?? 400

      for (let step = 0; step < maxScrollSteps; step++) {
        const a11y = await sessionA11yWhenReady(session)
        if (!a11y) break

        // Scope to subtree if listId is provided
        let searchRoot = a11y
        if (listId) {
          const parsed = parseSectionId(listId)
          if (parsed) {
            const node = findNodeByPath(a11y, parsed.path)
            if (node) searchRoot = node
          }
        }

        const items = findNodes(searchRoot, { role: itemRole })
        let newCount = 0
        for (const item of items) {
          const id = nodeIdForPath(item.path)
          if (!collected.has(id)) {
            collected.set(id, {
              ...(item.name ? { name: item.name } : {}),
              ...(item.value ? { value: item.value } : {}),
            })
            newCount++
          }
        }

        if (collected.size >= maxItems || newCount === 0) break

        try {
          await sendWheel(session, scrollDelta, { x: cx, y: cy }, 1_000)
        } catch {
          break
        }
      }

      const items = [...collected.entries()].slice(0, maxItems).map(([id, data]) => ({ id, ...data }))
      return ok(JSON.stringify({
        itemCount: items.length,
        items,
        truncated: collected.size > maxItems,
      }))
    }
  )

  // ── snapshot ─────────────────────────────────────────────────
  server.tool(
    'geometra_snapshot',
    `Get the current UI as JSON. Default **compact** view: flat list of viewport-visible actionable nodes plus a few pinned context anchors (for example tab strips / form roots) and root context like URL, scroll, and focus — far fewer tokens than a full nested tree. Use **full** for complete nested a11y + every wrapper when debugging layout. Use **form-required** to list required fields across forms, including offscreen ones, with bounds + visibility + scroll hints for long application flows.

JSON is minified in compact view to save tokens. For a summary-first overview, use geometra_page_model, then geometra_expand_section for just the part you want.`,
    {
      view: z
        .enum(['compact', 'full', 'form-required'])
        .optional()
        .default('compact')
        .describe('compact (default): token-efficient flat index. full: nested tree, every node. form-required: required fields across forms, including offscreen controls.'),
      maxNodes: z
        .number()
        .int()
        .min(20)
        .max(800)
        .optional()
        .default(400)
        .describe('Max rows in compact view (default 400).'),
      formId: z.string().optional().describe('Optional form id from geometra_form_schema / geometra_page_model when view=form-required'),
      maxFields: z.number().int().min(1).max(200).optional().default(80).describe('Per-form field cap when view=form-required'),
      includeOptions: z.boolean().optional().default(false).describe('Include explicit choice option labels when view=form-required'),
      includeScreenshot: z
        .boolean()
        .optional()
        .default(false)
        .describe('Attach a base64 PNG viewport screenshot. Requires @geometra/proxy.'),
      sessionId: sessionIdInput,
    },
    async ({ view, maxNodes, formId, maxFields, includeOptions, includeScreenshot, sessionId }) => {
      const sessionResult = resolveToolSession(sessionId)
      if ('error' in sessionResult) return sessionResult.error
      const session = sessionResult.session

      const a11y = await sessionA11yWhenReady(session)
      if (!a11y) return err('No UI tree available')
      const screenshot = includeScreenshot ? await captureScreenshotBase64(session) : undefined
      if (view === 'full') {
        return ok(JSON.stringify(a11y, null, 2), screenshot)
      }
      if (view === 'form-required') {
        const payload = {
          view: 'form-required' as const,
          viewport: { width: a11y.bounds.width, height: a11y.bounds.height },
          forms: buildFormRequiredSnapshot(a11y, {
            formId,
            maxFields,
            includeOptions,
            includeContext: 'auto',
          }),
        }
        return ok(JSON.stringify(payload), screenshot)
      }
      const { nodes, truncated, context } = buildCompactUiIndex(a11y, { maxNodes })
      const payload = {
        view: 'compact' as const,
        viewport: { width: a11y.bounds.width, height: a11y.bounds.height },
        context,
        nodes,
        truncated,
      }
      return ok(JSON.stringify(payload), screenshot)
    }
  )

  // ── layout ───────────────────────────────────────────────────
  server.tool(
    'geometra_layout',
    `Get the raw computed layout geometry — the exact {x, y, width, height} for every node in the UI tree. This is the lowest-level view, useful for pixel-precise assertions in tests.

For a token-efficient semantic view, use geometra_snapshot (default compact). For the complete nested tree, geometra_snapshot with view=full.`,
    {
      sessionId: sessionIdInput,
    },
    async ({ sessionId }) => {
      const sessionResult = resolveToolSession(sessionId)
      if ('error' in sessionResult) return sessionResult.error
      const session = sessionResult.session
      if (!session.layout) return err('No layout available yet. Wait for the next frame or call geometra_page_model.')

      return ok(JSON.stringify(session.layout, null, 2))
    }
  )

  // ── workflow state ───────────────────────────────────────────
  server.tool(
    'geometra_workflow_state',
    `Get the accumulated workflow state across page navigations. Shows which pages/forms have been filled, what values were submitted, and the fill status per page.

Use this after navigating to a new page in a multi-step flow (e.g. job applications) to understand what has been completed so far. Pass \`clear: true\` to reset the workflow state.`,
    {
      clear: z.boolean().optional().default(false).describe('Reset the workflow state'),
      sessionId: sessionIdInput,
    },
    async ({ clear, sessionId }) => {
      const sessionResult = resolveToolSession(sessionId)
      if ('error' in sessionResult) return sessionResult.error
      const session = sessionResult.session

      if (clear) {
        session.workflowState = undefined
        return ok(JSON.stringify({ cleared: true }))
      }

      if (!session.workflowState || session.workflowState.pages.length === 0) {
        return ok(JSON.stringify({
          pageCount: 0,
          message: 'No workflow state recorded yet. Fill a form with geometra_fill_form to start tracking.',
        }))
      }

      const state = session.workflowState
      const totalFields = state.pages.reduce((sum, p) => sum + p.fieldCount, 0)
      const totalInvalid = state.pages.reduce((sum, p) => sum + p.invalidCount, 0)
      return ok(JSON.stringify({
        pageCount: state.pages.length,
        totalFieldsFilled: totalFields,
        totalInvalidRemaining: totalInvalid,
        elapsedMs: Date.now() - state.startedAt,
        pages: state.pages.map(p => ({
          pageUrl: p.pageUrl,
          ...(p.formId ? { formId: p.formId } : {}),
          ...(p.formName ? { formName: p.formName } : {}),
          fieldCount: p.fieldCount,
          invalidCount: p.invalidCount,
          filledValues: p.filledValues,
        })),
      }))
    }
  )

  // ── disconnect ───────────────────────────────────────────────
  server.tool(
    'geometra_generate_pdf',
    `Generate a PDF from the current page or from provided HTML content. Returns the PDF as base64-encoded data.

**Two modes:**
- **Current page:** Omit \`html\` to PDF-print whatever the proxy browser is currently showing (useful after navigating to a page and filling forms).
- **HTML content:** Pass an \`html\` string to render and convert to PDF (useful for generating CVs, reports, or any custom document from a template).

Returns \`{ pdf, pageUrl }\` where \`pdf\` is the base64-encoded PDF bytes.`,
    {
      html: z
        .string()
        .optional()
        .describe('Full HTML string to render as PDF. If omitted, the current page is used.'),
      format: z
        .enum(['A4', 'Letter'])
        .optional()
        .default('A4')
        .describe('Paper format.'),
      landscape: z
        .boolean()
        .optional()
        .default(false)
        .describe('Print in landscape orientation.'),
      margin: z
        .string()
        .optional()
        .default('1cm')
        .describe('CSS margin applied to all sides (e.g. "1cm", "0.5in", "10mm").'),
      printBackground: z
        .boolean()
        .optional()
        .default(true)
        .describe('Include background graphics and colors.'),
      sessionId: sessionIdInput,
    },
    async ({ html, format, landscape, margin, printBackground, sessionId }) => {
      const sessionResult = resolveToolSession(sessionId)
      if ('error' in sessionResult) return sessionResult.error
      const session = sessionResult.session

      try {
        const wait = await sendPdfGenerate(session, {
          html: html ?? undefined,
          format,
          landscape,
          margin,
          printBackground,
        })
        const result = wait.result as Record<string, unknown> | undefined
        const pdfBase64 = typeof result?.pdf === 'string' ? result.pdf as string : undefined
        if (!pdfBase64) return err('PDF generation failed — no data returned from proxy.')

        const pageUrl = typeof result?.pageUrl === 'string' ? result.pageUrl : undefined
        const sizeKb = Math.round((pdfBase64.length * 3) / 4 / 1024)

        return ok(JSON.stringify({
          pdf: pdfBase64,
          pageUrl,
          format,
          landscape,
          sizeKb,
          ...(html ? { source: 'html' } : { source: 'current-page' }),
        }))
      } catch (e) {
        return err(`PDF generation failed: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
  )

  server.tool(
    'geometra_disconnect',
    'Disconnect one explicitly resolved Geometra session. Isolated browser sessions are always destroyed. A session created with isolated: false may return its browser to the warm pool; pass closeBrowser: true to destroy that session\'s browser only. This tool never closes another session\'s browser.',
    {
      closeBrowser: z.boolean().optional().default(false).describe("Destroy this session's spawned proxy/browser instead of returning an explicitly reusable browser to the warm pool"),
      sessionId: sessionIdInput,
    },
    async ({ closeBrowser, sessionId }) => {
      const resolved = resolveToolSession(sessionId)
      if ('error' in resolved) return resolved.error
      const target = resolved.session
      disconnect({ closeProxy: closeBrowser, sessionId: target.id })
      const browserClosed = closeBrowser || target.isolated === true
      return ok(browserClosed
        ? `Disconnected session ${target.id} and closed its browser.`
        : `Disconnected session ${target.id}; its explicitly reusable browser remains warm.`)
    }
  )

  server.tool(
    'geometra_list_sessions',
    'List all active Geometra sessions with their IDs and URLs. Use this to discover available sessions when operating on multiple pages in parallel.',
    {},
    async () => {
      const sessions = listSessions()
      return ok(JSON.stringify({
        defaultSessionId: getDefaultSessionId(),
        sessions,
      }))
    }
  )

  return server
}

// ── Helpers ──────────────────────────────────────────────────────

function compactSessionSummary(session: Session): string {
  const a11y = sessionA11y(session)
  if (!a11y) return 'No UI update received'
  return sessionOverviewFromA11y(a11y)
}

function connectPayload(
  session: Session,
  opts: {
    transport: 'proxy' | 'ws'
    requestedPageUrl?: string
    requestedWsUrl?: string
    autoCoercedFromUrl?: boolean
    detail?: ResponseDetail
  },
): Record<string, unknown> {
  const a11y = opts.detail === 'verbose' ? sessionA11y(session) : null
  return {
    connected: true,
    sessionId: session.id,
    transport: opts.transport,
    wsUrl: session.url,
    ...(a11y?.meta?.pageUrl || opts.requestedPageUrl ? { pageUrl: a11y?.meta?.pageUrl ?? opts.requestedPageUrl } : {}),
    ...(opts.requestedWsUrl ? { requestedWsUrl: opts.requestedWsUrl } : {}),
    ...(opts.autoCoercedFromUrl ? { autoCoercedFromUrl: true } : {}),
    ...(opts.detail === 'verbose' && a11y ? { currentUi: sessionOverviewFromA11y(a11y) } : {}),
  }
}

function sessionHasFreshUi(session: Session): boolean {
  // `ws` is required on real Sessions. The absence allowance keeps legacy
  // in-process test doubles compatible while production always verifies the
  // transport is OPEN, closing the CLOSING -> close-event stale-read window.
  const transportOpen = !session.ws || session.ws.readyState === session.ws.OPEN
  return transportOpen
    && session.hasFreshFrame !== false
    && Boolean(session.tree && session.layout)
}

function sessionA11y(session: Session): A11yNode | null {
  if (!sessionHasFreshUi(session)) return null
  if (session.cachedA11yRevision === session.updateRevision) {
    return session.cachedA11y ?? null
  }
  const a11y = buildA11yTree(session.tree!, session.layout!)
  session.cachedA11y = a11y
  session.cachedA11yRevision = session.updateRevision
  return a11y
}

async function ensureSessionUiTree(session: Session, timeoutMs = 4_000): Promise<boolean> {
  if (sessionHasFreshUi(session)) return true
  try {
    await ensureSessionConnected(session)
  } catch {
    return false
  }
  if (sessionHasFreshUi(session)) return true
  return await waitForUiCondition(
    session,
    () => sessionHasFreshUi(session),
    timeoutMs,
  )
}

async function sessionA11yWhenReady(session: Session, timeoutMs = 4_000): Promise<A11yNode | null> {
  const ready = await ensureSessionUiTree(session, timeoutMs)
  if (!ready) return null
  return sessionA11y(session)
}

function shortHash(value: string): string {
  return createHash('sha1').update(value).digest('hex').slice(0, 12)
}

function formSchemaCacheKey(options: FormSchemaBuildOptions): string {
  return JSON.stringify({
    formId: options.formId ?? null,
    maxFields: options.maxFields ?? null,
    onlyRequiredFields: options.onlyRequiredFields ?? false,
    onlyInvalidFields: options.onlyInvalidFields ?? false,
    includeOptions: options.includeOptions ?? false,
    includeContext: options.includeContext ?? 'auto',
  })
}

function getSessionFormSchemas(session: Session, options: FormSchemaBuildOptions): FormSchemaModel[] {
  const key = formSchemaCacheKey(options)
  const cached = session.cachedFormSchemas?.get(key)
  if (cached && cached.revision === session.updateRevision) return cached.forms

  const a11y = sessionA11y(session)
  if (!a11y) return []
  const forms = buildFormSchemas(a11y, options)
  if (!session.cachedFormSchemas) session.cachedFormSchemas = new Map()
  session.cachedFormSchemas.set(key, {
    revision: session.updateRevision,
    forms,
  })
  return forms
}

function packedFormSchemas(forms: FormSchemaModel[]): Array<Record<string, unknown>> {
  return forms.map(form => ({
    i: form.formId,
    ...(form.name ? { n: form.name } : {}),
    fc: form.fieldCount,
    rc: form.requiredCount,
    ic: form.invalidCount,
    f: form.fields.map(field => ({
      i: field.id,
      ...(field.fieldKey ? { fk: field.fieldKey } : {}),
      k: field.kind,
      l: field.label,
      ...(field.required ? { r: 1 } : {}),
      ...(field.invalid ? { iv: 1 } : {}),
      ...(field.choiceType ? { ch: field.choiceType } : {}),
      ...(field.booleanChoice ? { b: 1 } : {}),
      ...(field.controlType ? { t: field.controlType } : {}),
      ...(field.optionCount !== undefined ? { oc: field.optionCount } : {}),
      ...(field.options ? { o: field.options } : {}),
      ...(field.optionDetails ? { od: field.optionDetails } : {}),
      ...(field.value ? { v: field.value } : {}),
      ...(field.valueLength !== undefined ? { vl: field.valueLength } : {}),
      ...(field.checked !== undefined ? { c: field.checked ? 1 : 0 } : {}),
      ...(field.values && field.values.length > 0 ? { vs: field.values } : {}),
      ...(field.aliases ? { al: field.aliases } : {}),
      ...(field.format ? { fmt: field.format } : {}),
      ...(field.context ? { x: field.context } : {}),
    })),
    ...(form.sections ? { s: form.sections.map(s => ({ n: s.name, fi: s.fieldIds })) } : {}),
  }))
}

function formSchemaResponsePayload(
  session: Session,
  opts: FormSchemaResponseOptions,
): Record<string, unknown> {
  const forms = getSessionFormSchemas(session, opts)
  const graphForms = opts.includeFormGraph && !opts.includeOptions
    ? getSessionFormSchemas(session, { ...opts, includeOptions: true })
    : forms
  const schemaJson = JSON.stringify(forms) + (opts.includeFormGraph ? '|formgraph' : '')
  const schemaId = `fs:${shortHash(schemaJson)}`
  if (opts.sinceSchemaId && opts.sinceSchemaId === schemaId) {
    return {
      schemaId,
      changed: false,
      formCount: forms.length,
      format: opts.format ?? 'compact',
    }
  }

  const pageUrl = sessionA11y(session)?.meta?.pageUrl
  return {
    schemaId,
    changed: true,
    formCount: forms.length,
    format: opts.format ?? 'compact',
    forms: (opts.format ?? 'compact') === 'packed' ? packedFormSchemas(forms) : forms,
    ...(opts.includeFormGraph ? { formGraphs: graphForms.map(form => formSchemaToFormGraph(form, pageUrl)) } : {}),
  }
}

function totalReturnedSchemaFields(forms: FormSchemaModel[]): number {
  return forms.reduce((sum, form) => sum + form.fields.length, 0)
}

function expectedReturnedSchemaFields(forms: FormSchemaModel[], maxFields?: number): number {
  return forms.reduce((sum, form) => sum + Math.min(form.fieldCount, maxFields ?? form.fieldCount), 0)
}

function schemaShapeSignature(forms: FormSchemaModel[]): string {
  return JSON.stringify(forms.map(form => ({
    formId: form.formId,
    fieldCount: form.fieldCount,
    fields: form.fields.map(field => field.id),
  })))
}

async function stabilizeInlineFormSchemas(
  session: Session,
  options: FormSchemaBuildOptions,
  opts?: {
    timeoutMs?: number
    pollMs?: number
    stableMs?: number
  },
): Promise<void> {
  const timeoutMs = opts?.timeoutMs ?? 2_000
  const pollMs = opts?.pollMs ?? 60
  const stableMs = opts?.stableMs ?? 120
  const deadline = Date.now() + timeoutMs

  let forms = getSessionFormSchemas(session, options)
  let lastSignature = schemaShapeSignature(forms)
  let stableSince = Date.now()

  while (Date.now() < deadline) {
    const expectedFields = expectedReturnedSchemaFields(forms, options.maxFields)
    if (forms.length > 0 && totalReturnedSchemaFields(forms) >= expectedFields && Date.now() - stableSince >= stableMs) {
      return
    }

    await new Promise(resolve => setTimeout(resolve, pollMs))

    forms = getSessionFormSchemas(session, options)
    const signature = schemaShapeSignature(forms)
    if (signature !== lastSignature) {
      lastSignature = signature
      stableSince = Date.now()
    }
  }
}

function connectResponsePayload(
  session: Session,
  opts: {
    transport: 'proxy' | 'ws'
    requestedPageUrl?: string
    requestedWsUrl?: string
    autoCoercedFromUrl?: boolean
    detail?: ResponseDetail
    returnForms?: boolean
    returnPageModel?: boolean
    pageModelMode?: 'inline' | 'deferred'
    blockDetection?: boolean
    blockedSitePolicy?: BlockedSitePolicy
    manualHandoff?: boolean
    headless?: boolean
    formSchema?: FormSchemaResponseOptions
    pageModelOptions?: { maxPrimaryActions?: number; maxSectionsPerKind?: number; blockDetection?: boolean }
  },
): Record<string, unknown> {
  const payload = connectPayload(session, opts)
  const policy = opts.blockedSitePolicy ?? 'continue'
  const pageModelOptions = {
    ...opts.pageModelOptions,
    blockDetection: opts.blockDetection,
  }
  const model = opts.blockDetection === false ? undefined : pageModelFromSession(session, pageModelOptions)
  const nextPayload = applyBlockedSitePolicyPayload(
    { ...payload },
    model?.blockedSite,
    {
      policy,
      manualHandoff: opts.manualHandoff,
      pageUrl: opts.requestedPageUrl,
      headless: opts.headless,
    },
  )
  if (!opts.returnForms && !opts.returnPageModel) return nextPayload
  if (opts.returnForms) {
    nextPayload.formSchema = formSchemaResponsePayload(session, opts.formSchema ?? {})
  }
  if (opts.returnPageModel) {
    nextPayload.pageModel = opts.pageModelMode === 'deferred'
      ? deferredPageModelConnectPayload(session, pageModelOptions)
      : (model ?? pageModelResponsePayload(session, pageModelOptions))
  }
  return nextPayload
}

function deferredPageModelConnectPayload(
  session: Session,
  options?: { maxPrimaryActions?: number; maxSectionsPerKind?: number; blockDetection?: boolean },
): Record<string, unknown> {
  return {
    deferred: true,
    ready: sessionHasFreshUi(session),
    tool: 'geometra_page_model',
    options: {
      maxPrimaryActions: options?.maxPrimaryActions ?? 6,
      maxSectionsPerKind: options?.maxSectionsPerKind ?? 8,
      blockDetection: options?.blockDetection !== false,
    },
  }
}

function pageModelResponsePayload(
  session: Session,
  options?: { maxPrimaryActions?: number; maxSectionsPerKind?: number; blockDetection?: boolean },
): unknown {
  return pageModelFromSession(session, options) ?? { available: false }
}

function pageModelFromSession(
  session: Session,
  options?: { maxPrimaryActions?: number; maxSectionsPerKind?: number; blockDetection?: boolean },
): PageModel | undefined {
  const a11y = sessionA11y(session)
  if (!a11y) return undefined
  return buildPageModel(a11y, options)
}

async function ensureToolSession(
  target: {
    sessionId?: string
    url?: string
    pageUrl?: string
    port?: number
    headless?: boolean
    width?: number
    height?: number
    slowMo?: number
    stealth?: boolean
    awaitInitialFrame?: boolean
    /** Browser auto-connects isolate unless the caller explicitly passes false. */
    isolated?: boolean
  },
  missingConnectionMessage = 'Not connected. Call geometra_connect first.',
): Promise<
  | {
      ok: true
      session: Session
      autoConnected: boolean
      transport?: 'proxy' | 'ws'
      requestedPageUrl?: string
      requestedWsUrl?: string
      autoCoercedFromUrl?: boolean
    }
  | {
      ok: false
      error: string
    }
> {
  if (!target.url && !target.pageUrl) {
    const resolved = resolveSession(target.sessionId)
    if (resolved.kind === 'ok') {
      return { ok: true, session: resolved.session, autoConnected: false }
    }
    if (resolved.kind === 'not_found') {
      return {
        ok: false,
        error: `session_not_found: no active session with id "${resolved.id}". Active sessions: ${resolved.activeIds.join(', ') || '(none)'}.`,
      }
    }
    if (resolved.kind === 'ambiguous') {
      const isolatedSuffix = resolved.isolatedIds.length > 0 ? ` (isolated: ${resolved.isolatedIds.join(', ')})` : ''
      return {
        ok: false,
        error: `multiple_active_sessions_provide_id: ${resolved.activeIds.length} active sessions — ${resolved.activeIds.join(', ')}${isolatedSuffix}. Pass sessionId explicitly.`,
      }
    }
    return { ok: false, error: missingConnectionMessage }
  }

  const normalized = normalizeConnectTarget({ url: target.url, pageUrl: target.pageUrl })
  if (!normalized.ok) return { ok: false, error: normalized.error }
  const resolvedTarget = normalized.value
  if (resolvedTarget.kind === 'ws' && target.isolated === true) {
    return {
      ok: false,
      error: 'isolated:true is unsupported for direct ws:// endpoints because MCP does not own that browser/runtime. Use pageUrl/HTTP(S) url for an isolated browser, or omit isolated for the externally managed endpoint.',
    }
  }

  try {
    if (resolvedTarget.kind === 'proxy') {
      const session = await connectThroughProxy({
        pageUrl: resolvedTarget.pageUrl!,
        port: target.port,
        headless: target.headless,
        width: target.width,
        height: target.height,
        slowMo: target.slowMo,
        ...(target.stealth !== undefined && { stealth: target.stealth }),
        awaitInitialFrame: target.awaitInitialFrame,
        isolated: target.isolated !== false,
      })
      return {
        ok: true,
        session,
        autoConnected: true,
        transport: 'proxy',
        requestedPageUrl: resolvedTarget.pageUrl,
        autoCoercedFromUrl: resolvedTarget.autoCoercedFromUrl,
      }
    }

    const session = await connect(resolvedTarget.wsUrl!, {
      width: target.width,
      height: target.height,
      awaitInitialFrame: target.awaitInitialFrame,
    })
    return {
      ok: true,
      session,
      autoConnected: true,
      transport: 'ws',
      requestedWsUrl: resolvedTarget.wsUrl,
    }
  } catch (e) {
    return { ok: false, error: `Failed to connect: ${formatConnectFailureMessage(e, resolvedTarget)}` }
  }
}

function autoConnectionPayload(
  target:
    | {
        session: Session
        autoConnected: boolean
        transport?: 'proxy' | 'ws'
        requestedPageUrl?: string
        requestedWsUrl?: string
        autoCoercedFromUrl?: boolean
      }
    | undefined,
): Record<string, unknown> {
  if (!target?.autoConnected) return {}
  return {
    autoConnected: true,
    sessionId: target.session.id,
    ...(target.transport ? { transport: target.transport } : {}),
    ...(target.requestedPageUrl ? { pageUrl: target.requestedPageUrl } : {}),
    ...(target.requestedWsUrl ? { requestedWsUrl: target.requestedWsUrl } : {}),
    ...(target.autoCoercedFromUrl ? { autoCoercedFromUrl: true } : {}),
  }
}

function sessionOverviewFromA11y(a11y: A11yNode): string {
  const pageSummary = summarizePageModel(buildPageModel(a11y), 8)
  const { nodes, context } = buildCompactUiIndex(a11y, { maxNodes: 32 })
  const contextSummary = summarizeCompactContext(context)
  const keyNodes = nodes.length > 0 ? `Key nodes:\n${summarizeCompactIndex(nodes, 18)}` : ''
  return [pageSummary, contextSummary, keyNodes].filter(Boolean).join('\n')
}

function postActionSummary(
  session: Session,
  before: A11yNode | null,
  wait?: UpdateWaitResult,
  detail: ResponseDetail = 'minimal',
): string {
  const after = sessionA11y(session)
  const notes: string[] = []
  if (wait?.status === 'acknowledged') {
    notes.push(detail === 'verbose'
      ? 'The peer acknowledged the action quickly; waiting logic did not need to rely on a full frame/patch round-trip.'
      : 'Peer acknowledged the action quickly.')
  }
  if (wait?.status === 'timed_out') {
    notes.push(
      detail === 'verbose'
        ? `No correlated terminal response arrived within ${wait.timeoutMs}ms. The action may still be running or may already have succeeded. ${ambiguousActionGuidance(wait)}`
        : `No correlated response arrived within ${wait.timeoutMs}ms; the action may still have succeeded. Do not retry blindly.`,
    )
  }
  if (!after) return [...notes, 'No UI update received'].filter(Boolean).join('\n')
  const signals = collectSessionSignals(after)
  const validationSummary = summarizeValidationSignals(signals)
  if (before) {
    const delta = buildUiDelta(before, after)
    if (hasUiDelta(delta)) {
      return [
        ...notes,
        `Changes:\n${summarizeUiDelta(delta, detail === 'verbose' ? 14 : 8)}`,
        ...(detail === 'minimal' ? validationSummary : []),
      ].filter(Boolean).join('\n')
    }
  }
  if (detail === 'verbose') {
    return [...notes, `Current UI:\n${sessionOverviewFromA11y(after)}`].filter(Boolean).join('\n')
  }
  return [...notes, summarizeSessionSignals(signals), ...validationSummary].filter(Boolean).join('\n')
}

function summarizeCompactContext(context: ReturnType<typeof buildCompactUiIndex>['context']): string {
  const parts: string[] = []
  if (context.pageUrl) parts.push(`url=${context.pageUrl}`)
  if (typeof context.scrollX === 'number' || typeof context.scrollY === 'number') {
    parts.push(`scroll=(${context.scrollX ?? 0},${context.scrollY ?? 0})`)
  }
  if (context.focusedNode) {
    const focusName = context.focusedNode.name ? ` "${context.focusedNode.name}"` : ''
    parts.push(`focus=${context.focusedNode.role}${focusName}`)
  }
  return parts.length > 0 ? `Context: ${parts.join(' | ')}` : ''
}

interface SessionSignals {
  pageUrl?: string
  scrollX?: number
  scrollY?: number
  focus?: {
    id: string
    role: string
    name?: string
    value?: string
  }
  captchaDetected?: boolean
  captchaType?: string
  dialogCount: number
  busyCount: number
  alerts: string[]
  invalidFields: Array<{
    id: string
    role: string
    name?: string
    error?: string
  }>
}

function pathIsStrictDescendant(path: number[], ancestorPath: number[]): boolean {
  return path.length > ancestorPath.length && ancestorPath.every((segment, index) => path[index] === segment)
}

function formNodeAtPath(root: A11yNode, path: number[]): A11yNode | undefined {
  const node = findNodeByPath(root, path)
  return node?.role === 'form' ? node : undefined
}

function formScopeNodeAtPath(root: A11yNode, path: number[]): A11yNode | undefined {
  const node = findNodeByPath(root, path)
  return node && (node.role === 'form' || node.role === 'group' || node.role === 'region')
    ? node
    : undefined
}

function formScopeFieldAnchor(field: FormSchemaField): string {
  if (field.fieldKey) return `key:${field.fieldKey}`
  return [
    'field',
    field.kind,
    normalizeLookupKey(field.label),
    field.controlType ?? '',
    field.choiceType ?? '',
    field.booleanChoice ? 'boolean' : '',
  ].join(':')
}

function captureFormScopeIdentity(
  node: A11yNode,
  schema: FormSchemaModel,
): { ok: true; identity: FormScopeIdentity } | { ok: false; error: string } {
  const fieldAnchors = schema.fields.map(formScopeFieldAnchor).sort()
  const name = normalizeLookupKey(node.name || schema.name || '')
  if (fieldAnchors.length === 0 && !name) {
    return {
      ok: false,
      error: `Target form ${schema.formId} has no stable semantic or field identity; refusing to submit without a maintainable form scope`,
    }
  }
  return {
    ok: true,
    identity: {
      role: node.role,
      name,
      fieldAnchors,
    },
  }
}

function containsFormFieldAnchors(current: string[], expected: string[]): boolean {
  const counts = new Map<string, number>()
  for (const anchor of current) counts.set(anchor, (counts.get(anchor) ?? 0) + 1)
  for (const anchor of expected) {
    const count = counts.get(anchor) ?? 0
    if (count === 0) return false
    counts.set(anchor, count - 1)
  }
  return true
}

function currentFormScope(
  session: Session,
  root: A11yNode,
  scope: FormClickScope,
): { ok: true; node: A11yNode; schema: FormSchemaModel } | { ok: false; error: string } {
  const node = formScopeNodeAtPath(root, scope.path)
  const schema = getSessionFormSchemas(session, {
    includeOptions: false,
    includeContext: 'auto',
  }).find(candidate => candidate.formId === scope.formId)
  if (!node || !schema) {
    return { ok: false, error: `Target form ${scope.formId} is stale or no longer resolves to a form in the current UI` }
  }

  const currentName = normalizeLookupKey(node.name || schema.name || '')
  const currentAnchors = schema.fields.map(formScopeFieldAnchor).sort()
  if (
    node.role !== scope.identity.role ||
    currentName !== scope.identity.name ||
    !containsFormFieldAnchors(currentAnchors, scope.identity.fieldAnchors)
  ) {
    return {
      ok: false,
      error: `Target form ${scope.formId} was replaced at the same path; its semantic/schema identity no longer matches`,
    }
  }
  return { ok: true, node, schema }
}

function currentVisibleClickCenter(root: A11yNode, target: A11yNode): { x: number; y: number } | undefined {
  const { x, y, width, height } = target.bounds
  const viewport = root.bounds
  if (![x, y, width, height, viewport.x, viewport.y, viewport.width, viewport.height].every(Number.isFinite)) return undefined
  if (width <= 0 || height <= 0 || viewport.width <= 0 || viewport.height <= 0) return undefined

  const visibleLeft = Math.max(x, viewport.x)
  const visibleTop = Math.max(y, viewport.y)
  const visibleRight = Math.min(x + width, viewport.x + viewport.width)
  const visibleBottom = Math.min(y + height, viewport.y + viewport.height)
  if (visibleRight <= visibleLeft || visibleBottom <= visibleTop) return undefined
  return {
    x: visibleLeft + (visibleRight - visibleLeft) / 2,
    y: visibleTop + (visibleBottom - visibleTop) / 2,
  }
}

function resolveSubmitFormNode(
  root: A11yNode,
  formId: string | undefined,
  submitPath: number[] | undefined,
): A11yNode | undefined {
  const parsedForm = formId ? parseSectionId(formId) : null
  if (parsedForm?.kind === 'form') {
    const explicit = formNodeAtPath(root, parsedForm.path)
    if (explicit) return explicit
  }
  if (!submitPath) return undefined
  for (let length = submitPath.length; length >= 0; length--) {
    const candidate = formNodeAtPath(root, submitPath.slice(0, length))
    if (candidate) return candidate
  }
  return undefined
}

function scopeSessionSignalsToForm(
  pageRoot: A11yNode,
  formNode: A11yNode | undefined,
  targetFormWasKnown = false,
): SessionSignals {
  const pageSignals = collectSessionSignals(pageRoot)
  if (formNode) {
    return { ...pageSignals, invalidFields: collectSessionSignals(formNode).invalidFields }
  }
  return targetFormWasKnown ? { ...pageSignals, invalidFields: [] } : pageSignals
}

function collectSessionSignals(root: A11yNode): SessionSignals {
  const signals: SessionSignals = {
    ...(root.meta?.pageUrl ? { pageUrl: root.meta.pageUrl } : {}),
    ...(typeof root.meta?.scrollX === 'number' ? { scrollX: root.meta.scrollX } : {}),
    ...(typeof root.meta?.scrollY === 'number' ? { scrollY: root.meta.scrollY } : {}),
    dialogCount: 0,
    busyCount: 0,
    alerts: [],
    invalidFields: [],
  }

  const seenAlerts = new Set<string>()
  const seenInvalidIds = new Set<string>()
  const formControlRoles = new Set([
    'textbox',
    'combobox',
    'checkbox',
    'radio',
    'spinbutton',
    'listbox',
    'searchbox',
    'slider',
    'switch',
  ])

  const captchaPattern = /recaptcha|g-recaptcha|hcaptcha|h-captcha|turnstile|cf-turnstile|captcha/i
  const captchaTypes: Record<string, string> = {
    recaptcha: 'recaptcha', 'g-recaptcha': 'recaptcha',
    hcaptcha: 'hcaptcha', 'h-captcha': 'hcaptcha',
    turnstile: 'turnstile', 'cf-turnstile': 'turnstile',
  }

  function walk(node: A11yNode) {
    if (!signals.focus && node.state?.focused) {
      signals.focus = {
        id: nodeIdForPath(node.path),
        role: node.role,
        ...(node.name ? { name: node.name } : {}),
        ...(node.value ? { value: node.value } : {}),
      }
    }
    if (node.role === 'dialog' || node.role === 'alertdialog') signals.dialogCount++
    if (node.state?.busy) signals.busyCount++
    if (node.role === 'alert' || node.role === 'alertdialog') {
      const text = truncateInlineText(node.name ?? node.validation?.error, 120)
      if (text && !seenAlerts.has(text)) {
        seenAlerts.add(text)
        signals.alerts.push(text)
      }
    }
    const isFormControl = formControlRoles.has(node.role) ||
      node.meta?.controlTag === 'input' ||
      node.meta?.controlTag === 'textarea' ||
      node.meta?.controlTag === 'select'
    if (isFormControl && (node.state?.invalid === true || Boolean(node.validation?.error))) {
      const id = nodeIdForPath(node.path)
      if (!seenInvalidIds.has(id)) {
        seenInvalidIds.add(id)
        signals.invalidFields.push({
          id,
          role: node.role,
          ...(node.name ? { name: truncateInlineText(node.name, 80) } : {}),
          ...(node.validation?.error ? { error: truncateInlineText(node.validation.error, 120) } : {}),
        })
      }
    }
    if (!signals.captchaDetected) {
      const text = [node.name, node.value].filter(Boolean).join(' ')
      if (captchaPattern.test(text)) {
        signals.captchaDetected = true
        const match = text.toLowerCase().match(/recaptcha|g-recaptcha|hcaptcha|h-captcha|turnstile|cf-turnstile/)
        signals.captchaType = match ? (captchaTypes[match[0]] ?? 'unknown') : 'unknown'
      }
    }
    for (const child of node.children) walk(child)
  }

  walk(root)
  return signals
}

function summarizeSessionSignals(signals: SessionSignals): string {
  const contextParts: string[] = []
  if (signals.pageUrl) contextParts.push(`url=${signals.pageUrl}`)
  if (signals.scrollX !== undefined || signals.scrollY !== undefined) {
    contextParts.push(`scroll=(${signals.scrollX ?? 0},${signals.scrollY ?? 0})`)
  }
  if (signals.focus) {
    const focusName = signals.focus.name ? ` "${truncateInlineText(signals.focus.name, 48)}"` : ''
    const focusValue = signals.focus.value ? ` value=${JSON.stringify(truncateInlineText(signals.focus.value, 40))}` : ''
    contextParts.push(`focus=${signals.focus.role}${focusName}${focusValue}`)
  }

  const statusParts = [
    signals.dialogCount > 0 ? `dialogs=${signals.dialogCount}` : undefined,
    signals.alerts.length > 0 ? `alerts=${signals.alerts.length}` : undefined,
    signals.invalidFields.length > 0 ? `invalid=${signals.invalidFields.length}` : undefined,
    signals.busyCount > 0 ? `busy=${signals.busyCount}` : undefined,
  ].filter(Boolean)

  return [
    contextParts.length > 0 ? `Context: ${contextParts.join(' | ')}` : undefined,
    statusParts.length > 0 ? `Status: ${statusParts.join(' | ')}` : 'Status: no semantic changes detected.',
  ].filter(Boolean).join('\n')
}

function summarizeValidationSignals(signals: SessionSignals): string[] {
  const lines: string[] = []
  if (signals.alerts.length > 0) {
    lines.push(`Alerts: ${signals.alerts.slice(0, 2).map(text => JSON.stringify(text)).join(' | ')}`)
  }
  if (signals.invalidFields.length > 0) {
    const invalidSummary = signals.invalidFields
      .slice(0, 4)
      .map(field => {
        const label = field.name ? `"${field.name}"` : field.id
        return field.error ? `${label}: ${JSON.stringify(field.error)}` : label
      })
      .join(' | ')
    lines.push(`Validation: ${invalidSummary}`)
  }
  return lines
}

function truncateInlineText(text: string | undefined, max: number): string | undefined {
  if (!text) return undefined
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (!normalized) return undefined
  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized
}

function sessionSignalsPayload(signals: SessionSignals, detail: ResponseDetail = 'minimal'): Record<string, unknown> {
  return {
    ...(signals.pageUrl ? { pageUrl: signals.pageUrl } : {}),
    ...(signals.scrollX !== undefined || signals.scrollY !== undefined
      ? { scroll: { x: signals.scrollX ?? 0, y: signals.scrollY ?? 0 } }
      : {}),
    ...(signals.focus ? { focus: signals.focus } : {}),
    ...(signals.captchaDetected ? { captchaDetected: true, captchaType: signals.captchaType ?? 'unknown' } : {}),
    dialogCount: signals.dialogCount,
    busyCount: signals.busyCount,
    alertCount: signals.alerts.length,
    invalidCount: signals.invalidFields.length,
    ...(detail === 'verbose'
      ? {
          alerts: signals.alerts,
          invalidFields: signals.invalidFields,
        }
      : {
          alerts: signals.alerts.slice(0, 2),
          invalidFields: signals.invalidFields.slice(0, 6),
        }),
  }
}

function compactTextValue(value: string, inlineLimit = 48): { value?: string; valueLength?: number } {
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (!normalized) return { valueLength: value.length }
  return normalized.length <= inlineLimit
    ? { value: normalized }
    : { valueLength: value.length }
}

function fieldReadbackNodes(
  a11y: A11yNode,
  fieldLabel: string,
  roles: string[],
  fieldKey?: string,
): A11yNode[] {
  if (fieldKey) {
    const matches: A11yNode[] = []
    const allowedRoles = new Set(roles)
    const walk = (node: A11yNode) => {
      if (allowedRoles.has(node.role) && node.meta?.controlKey === fieldKey) matches.push(node)
      for (const child of node.children) walk(child)
    }
    walk(a11y)
    return matches
  }
  return roles.flatMap(role => findNodes(a11y, { name: fieldLabel, role }))
}

function fieldStatePayload(session: Session, fieldLabel: string, fieldKey?: string): FieldStatePayload | undefined {
  const a11y = sessionA11y(session)
  if (!a11y) return undefined
  const matches = fieldReadbackNodes(a11y, fieldLabel, ['combobox', 'textbox', 'button'], fieldKey)
  const match = matches[0]
  if (!match) return undefined

  const valuePayload = match.value ? compactTextValue(match.value, 64) : {}
  return {
    role: match.role,
    ...valuePayload,
    ...(match.state && Object.keys(match.state).length > 0 ? { state: match.state } : {}),
    ...(match.validation?.error ? { error: truncateInlineText(match.validation.error, 120) } : {}),
  }
}

function waitStatusPayload(wait: UpdateWaitResult | undefined): Record<string, unknown> {
  if (!wait) return {}
  const payload: Record<string, unknown> = {
    wait: wait.status,
    requestId: wait.requestId,
    actionId: wait.actionId,
  }
  // Surface navigation info from proxy click handlers so callers can tell
  // when a click triggered a full-page nav (form submit → thank-you page).
  // Without this, the proxy session may die on the next request and the
  // caller would see session_not_found with no clue WHY. Bug surfaced by
  // JobForge round-2 marathon — Cloudflare FDE NYC #312 and Airtable PM
  // AI #94 both had Submit-clicks that navigated and tore down the proxy.
  if (wait.result && typeof wait.result === 'object') {
    const result = wait.result as Record<string, unknown>
    if (result.navigated === true) {
      payload.navigated = true
      if (typeof result.pageUrl === 'string') payload.pageUrl = result.pageUrl
      if (typeof result.urlBefore === 'string') payload.urlBefore = result.urlBefore
    }
  }
  return payload
}

function compactFilterPayload(filter: NodeFilter): Record<string, unknown> {
  return Object.fromEntries(Object.entries(filter).filter(([, value]) => value !== undefined))
}

async function waitForSemanticCondition(
  session: Session,
  options: {
    filter: NodeFilter
    present: boolean
    timeoutMs: number
  },
): Promise<{ ok: true; value: WaitConditionResult } | { ok: false; error: string }> {
  if (!hasNodeFilter(options.filter)) {
    return { ok: false, error: GEOMETRA_WAIT_FILTER_REQUIRED_MESSAGE }
  }

  const startedAt = Date.now()
  const matched = await waitForUiCondition(session, () => {
    const a11y = sessionA11y(session)
    if (!a11y) return false
    const matches = findNodes(a11y, options.filter)
    return options.present ? matches.length > 0 : matches.length === 0
  }, options.timeoutMs)
  const elapsedMs = Date.now() - startedAt

  if (!matched) {
    return {
      ok: false,
      error: `Timed out after ${options.timeoutMs}ms waiting for ${options.present ? 'presence' : 'absence'} of ${JSON.stringify(options.filter)}.\nCurrent UI:\n${compactSessionSummary(session)}`,
    }
  }

  const after = sessionA11y(session)
  const matches = options.present && after
    ? sortA11yNodes(findNodes(after, options.filter)).slice(0, 8).map(node => formatNode(node, after, after.bounds))
    : []

  return {
    ok: true,
    value: {
      filter: options.filter,
      present: options.present,
      elapsedMs,
      matchCount: matches.length,
      matches,
    },
  }
}

function waitConditionSuccessLine(result: WaitConditionResult): string {
  if (!result.present) {
    return `condition satisfied after ${result.elapsedMs}ms: no nodes matched ${JSON.stringify(result.filter)}.`
  }
  return `condition satisfied after ${result.elapsedMs}ms with ${result.matchCount} matching node(s).`
}

function waitConditionCompact(result: WaitConditionResult): Record<string, unknown> {
  return {
    present: result.present,
    elapsedMs: result.elapsedMs,
    filter: compactFilterPayload(result.filter),
    ...(result.present ? { matchCount: result.matchCount } : {}),
  }
}

interface WaitEvidenceSnapshot {
  matchCount: number
  fingerprints: Set<string>
}

function waitEvidenceNodeSnapshot(node: A11yNode, filter: NodeFilter): Record<string, unknown> {
  const relevantState = {
    ...(filter.checked !== undefined ? { checked: node.state?.checked } : {}),
    ...(filter.disabled !== undefined ? { disabled: node.state?.disabled } : {}),
    ...(filter.focused !== undefined ? { focused: node.state?.focused } : {}),
    ...(filter.selected !== undefined ? { selected: node.state?.selected } : {}),
    ...(filter.expanded !== undefined ? { expanded: node.state?.expanded } : {}),
    ...(filter.invalid !== undefined ? { invalid: node.state?.invalid } : {}),
    ...(filter.required !== undefined ? { required: node.state?.required } : {}),
    ...(filter.busy !== undefined ? { busy: node.state?.busy } : {}),
  }
  return {
    role: node.role,
    name: node.name,
    value: node.value,
    validation: node.validation,
    ...(Object.keys(relevantState).length > 0 ? { state: relevantState } : {}),
  }
}

function captureWaitEvidence(root: A11yNode, filter: NodeFilter): WaitEvidenceSnapshot {
  const matches = findNodes(root, filter)
  return {
    matchCount: matches.length,
    fingerprints: new Set(matches.map(node => JSON.stringify(waitEvidenceNodeSnapshot(node, filter)))),
  }
}

function waitConditionHasFreshEvidence(
  before: WaitEvidenceSnapshot | undefined,
  after: A11yNode | null | undefined,
  result: WaitConditionResult,
): boolean {
  if (!before || !after) return false
  const current = captureWaitEvidence(after, result.filter)
  if (!result.present) {
    return before.matchCount > 0 && current.matchCount === 0
  }
  if (current.matchCount === 0) return false
  if (before.matchCount === 0) return true
  return [...current.fingerprints].some(fingerprint => !before.fingerprints.has(fingerprint))
}

function inferRevealStepBudget(
  target: FormattedNodePayload,
  viewport: { width: number; height: number },
): number {
  const verticalSteps = Math.ceil(Math.abs(target.scrollHint.revealDeltaY) / Math.max(1, viewport.height * 0.75))
  const horizontalSteps = Math.ceil(Math.abs(target.scrollHint.revealDeltaX) / Math.max(1, viewport.width * 0.7))
  return clamp(Math.max(6, Math.max(verticalSteps, horizontalSteps) + 1), 6, 48)
}

async function revealSemanticTarget(
  session: Session,
  options: {
    filter: NodeFilter
    index: number
    fullyVisible: boolean
    formScope?: FormClickScope
    maxSteps?: number
    timeoutMs: number
  },
): Promise<
  | { ok: true; value: RevealTargetResult }
  | { ok: false; error: string; staleFormScope?: true }
> {
  const revealStartedAt = performance.now()
  const revealDeadlineAt = revealStartedAt + HOST_SAFE_REVEAL_TIMEOUT_MS
  const initialTreeReady = await ensureSessionUiTree(
    session,
    capTimeoutMs(Math.max(4_000, options.timeoutMs), timeoutCapFromDeadline(revealDeadlineAt, 100), HOST_SAFE_REVEAL_TIMEOUT_MS),
  )
  if (!initialTreeReady) {
    return { ok: false, error: 'Timed out waiting for the initial UI tree after connect.' }
  }
  let attempts = 0
  let stepBudget = options.maxSteps
  while (attempts <= (stepBudget ?? 48)) {
    if (!hasSoftBudget(revealDeadlineAt, 100)) {
      return {
        ok: false,
        error: `Reveal exceeded the host-safe ${HOST_SAFE_REVEAL_TIMEOUT_MS}ms budget after ${attempts} step(s). Retry with a more specific filter/id or reveal the target in smaller geometra_scroll_to calls.`,
      }
    }

    const a11y = sessionA11y(session)
    if (!a11y) return { ok: false, error: 'No UI tree available to reveal from' }

    if (options.formScope) {
      const scoped = currentFormScope(session, a11y, options.formScope)
      if (!scoped.ok) {
        return { ok: false, error: scoped.error, staleFormScope: true }
      }
    }

    // Match against the page root first so prompt/section/item context from
    // ancestors outside the form remains available, then constrain the
    // actionable candidates to descendants of the selected current form.
    const matches = sortA11yNodes(
      findNodes(a11y, options.filter).filter(node =>
        !options.formScope || pathIsStrictDescendant(node.path, options.formScope.path),
      ),
    )
    if (matches.length === 0) {
      const scopeSuffix = options.formScope ? ` within form ${options.formScope.formId}` : ''
      return { ok: false, error: `No elements found matching ${JSON.stringify(options.filter)}${scopeSuffix}` }
    }
    if (options.index >= matches.length) {
      return {
        ok: false,
        error: `Requested reveal index ${options.index} but only ${matches.length} matching element(s) were found`,
      }
    }

    const formatted = formatNode(matches[options.index]!, a11y, a11y.bounds)
    stepBudget ??= inferRevealStepBudget(formatted, a11y.bounds)
    const visible = options.fullyVisible ? formatted.visibility.fullyVisible : formatted.visibility.intersectsViewport
    if (visible) {
      return {
        ok: true,
        value: {
          attempts,
          target: formatted,
        },
      }
    }

    if (attempts === stepBudget) {
      return {
        ok: false,
        error: JSON.stringify({
          revealed: false,
          attempts,
          maxSteps: stepBudget,
          target: formatted,
        }, null, 2),
      }
    }

    const deltaX = clamp(
      formatted.scrollHint.revealDeltaX,
      -Math.round(a11y.bounds.width * 0.75),
      Math.round(a11y.bounds.width * 0.75),
    )
    let deltaY = clamp(
      formatted.scrollHint.revealDeltaY,
      -Math.round(a11y.bounds.height * 0.85),
      Math.round(a11y.bounds.height * 0.85),
    )
    if (deltaY === 0 && !formatted.visibility.fullyVisible) {
      deltaY = formatted.visibility.offscreenAbove ? -Math.round(a11y.bounds.height * 0.4) : Math.round(a11y.bounds.height * 0.4)
    }

    await sendWheel(session, deltaY, {
      deltaX,
      x: formatted.center.x,
      y: formatted.center.y,
    }, capTimeoutMs(options.timeoutMs, timeoutCapFromDeadline(revealDeadlineAt, 100), 2_500))
    attempts++
  }

  return { ok: false, error: `Failed to reveal ${JSON.stringify(options.filter)}` }
}

async function resolveClickLocation(
  session: Session,
  options: {
    x?: number
    y?: number
    filter: NodeFilter
    index?: number
    fullyVisible?: boolean
    formScope?: FormClickScope
    maxRevealSteps?: number
    revealTimeoutMs?: number
  },
): Promise<
  | { ok: true; value: ResolvedClickLocation }
  | { ok: false; error: string; staleFormScope?: true }
> {
  const hasExplicitCoordinates = options.x !== undefined || options.y !== undefined
  if (hasExplicitCoordinates) {
    if (options.x === undefined || options.y === undefined) {
      return { ok: false, error: 'Provide both x and y when clicking by coordinates' }
    }
    return {
      ok: true,
      value: {
        x: options.x,
        y: options.y,
      },
    }
  }

  if (!hasNodeFilter(options.filter)) {
    return {
      ok: false,
      error: 'Provide x and y, or at least one semantic target filter (id, role, name, text, contextText, promptText, sectionText, itemText, value, or state)',
    }
  }

  const revealed = await revealSemanticTarget(session, {
    filter: options.filter,
    index: options.index ?? 0,
    fullyVisible: options.fullyVisible ?? true,
    formScope: options.formScope,
    maxSteps: options.maxRevealSteps,
    timeoutMs: options.revealTimeoutMs ?? 2_500,
  })
  if (!revealed.ok) return revealed

  return {
    ok: true,
    value: {
      x: revealed.value.target.center.x,
      y: revealed.value.target.center.y,
      target: revealed.value.target,
      revealAttempts: revealed.value.attempts,
    },
  }
}

/**
 * Transparent fallback for semantic click resolution. Extends
 * {@link resolveClickLocation} with two recovery phases when the initial attempt
 * fails to find a target:
 *
 * 1. **revision-retry** — wait briefly for the UI tree revision to tick (common
 *    when the agent clicks while a post-navigation re-render is still landing),
 *    then re-resolve with the original filter.
 * 2. **relaxed-visibility** — if the caller required full visibility, retry with
 *    intersection-only visibility and an expanded reveal budget. Handles sticky
 *    headers, overlays, and very tall inputs that never become fully visible.
 *
 * Returns the same ok/error shape as {@link resolveClickLocation}, with an
 * additional `fallback` field when a recovery phase succeeded. The fallback
 * metadata is surfaced in tool results so operators can prioritize native fixes
 * for the most common recovery patterns (Phase 4 of `MCP_PERFORMANCE_ROADMAP.md`).
 */
type ClickFallbackReason = 'revision-retry' | 'relaxed-visibility'

interface ResolveClickFallbackSuccess {
  attempted: true
  used: true
  reason: ClickFallbackReason
  attempts: number
}

interface ResolveClickFallbackFailure {
  attempted: true
  used: false
  reasonsTried: ClickFallbackReason[]
  attempts: number
}

async function resolveClickLocationWithFallback(
  session: Session,
  options: {
    x?: number
    y?: number
    filter: NodeFilter
    index?: number
    fullyVisible?: boolean
    formScope?: FormClickScope
    maxRevealSteps?: number
    revealTimeoutMs?: number
  },
): Promise<
  | { ok: true; value: ResolvedClickLocation; fallback?: ResolveClickFallbackSuccess }
  | { ok: false; error: string; fallback?: ResolveClickFallbackFailure; staleFormScope?: true }
> {
  const first = await resolveClickLocation(session, options)
  if (first.ok) return first
  if (first.staleFormScope) return first

  // Fallback only applies to semantic resolves. Explicit coordinates never enter
  // the reveal path, so there is nothing to retry.
  const hasExplicitCoordinates = options.x !== undefined || options.y !== undefined
  if (hasExplicitCoordinates) return first
  if (!hasNodeFilter(options.filter)) return first

  const reasonsTried: ClickFallbackReason[] = []
  let attempts = 1

  const startRevision = session.updateRevision
  const revisionAdvanced = await waitForUiCondition(
    session,
    () => session.updateRevision > startRevision,
    600,
  )
  if (revisionAdvanced) {
    attempts += 1
    reasonsTried.push('revision-retry')
    const retry = await resolveClickLocation(session, options)
    if (retry.ok) {
      return {
        ok: true,
        value: retry.value,
        fallback: { attempted: true, used: true, reason: 'revision-retry', attempts },
      }
    }
    if (retry.staleFormScope) return retry
  }

  if (options.fullyVisible !== false) {
    attempts += 1
    reasonsTried.push('relaxed-visibility')
    const relaxed = await resolveClickLocation(session, {
      ...options,
      fullyVisible: false,
      maxRevealSteps: Math.max(options.maxRevealSteps ?? 0, 24),
    })
    if (relaxed.ok) {
      return {
        ok: true,
        value: relaxed.value,
        fallback: { attempted: true, used: true, reason: 'relaxed-visibility', attempts },
      }
    }
    if (relaxed.staleFormScope) return relaxed
  }

  // All fallback phases tried and none recovered. Carry the trace of what we
  // tried so operators see the attempted-but-failed signal alongside the
  // successful-recovery signal.
  if (reasonsTried.length === 0) return first
  return {
    ok: false,
    error: first.error,
    fallback: { attempted: true, used: false, reasonsTried, attempts },
  }
}

/**
 * Expose the attempted-but-failed fallback telemetry on error responses. When
 * `resolved.fallback` is present on a failure, return a structured JSON error
 * so operators can aggregate recovery failures the same way they aggregate
 * successful recoveries. Plain-text errors are preserved for the no-fallback
 * case to avoid churning that error contract.
 */
function clickFallbackErrorMessage(resolved: { error: string; fallback?: ResolveClickFallbackFailure }): string {
  if (!resolved.fallback) return resolved.error
  return JSON.stringify({ error: resolved.error, fallback: resolved.fallback })
}

function describeFormattedNode(node: FormattedNodePayload): string {
  return `${node.role}${node.name ? ` ${JSON.stringify(node.name)}` : ''} (${node.id})`
}

function compactNodeReference(node: FormattedNodePayload): Record<string, unknown> {
  return {
    id: node.id,
    role: node.role,
    ...(node.name ? { name: node.name } : {}),
  }
}

function compactFormattedNode(node: FormattedNodePayload): Record<string, unknown> {
  return {
    ...compactNodeReference(node),
    ...(node.context ? { context: node.context } : {}),
    ...(node.value ? { value: node.value } : {}),
    center: node.center,
    bounds: node.bounds,
  }
}

function detailText(summary: string, compact: Record<string, unknown>, detail: ResponseDetail): string {
  return detail === 'terse' ? JSON.stringify(compact) : summary
}

function ambiguousActionGuidance(wait: UpdateWaitResult): string {
  return `Outcome is ambiguous for actionId ${wait.actionId} (requestId ${wait.requestId}). ` +
    'Do not retry blindly or skip this step; inspect the current UI first. ' +
    'An identical retry reuses the same action identity when the proxy supports deduplication.'
}

function actionWaitResponse(
  wait: UpdateWaitResult,
  summary: string,
  compact: Record<string, unknown>,
  detail: ResponseDetail,
) {
  if (wait.status === 'timed_out') {
    const guidance = ambiguousActionGuidance(wait)
    return err(detailText(`${summary}\n${guidance}`, {
      completed: false,
      outcome: 'unconfirmed',
      retrySafety: 'inspect-first',
      guidance,
      ...compact,
    }, detail))
  }
  return ok(detailText(summary, compact, detail))
}

function normalizeLookupKey(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase()
}

function resolveTargetFormSchema(
  schemas: FormSchemaModel[],
  opts: {
    formId?: string
    valuesById?: Record<string, FormValueInput>
    valuesByLabel?: Record<string, FormValueInput>
  },
): { ok: true; schema: FormSchemaModel } | { ok: false; error: string } {
  if (opts.formId) {
    const matched = schemas.find(schema => schema.formId === opts.formId)
    return matched
      ? { ok: true, schema: matched }
      : { ok: false, error: `No form schema found for id ${opts.formId}` }
  }

  if (schemas.length === 1) return { ok: true, schema: schemas[0]! }

  const idKeys = Object.keys(opts.valuesById ?? {})
  const labelKeys = Object.keys(opts.valuesByLabel ?? {}).map(normalizeLookupKey)
  const matches = schemas.filter(schema => {
    const ids = new Set(schema.fields.map(field => field.id))
    const labels = new Set(schema.fields.map(field => normalizeLookupKey(field.label)))
    return idKeys.every(id => ids.has(id)) && labelKeys.every(label => labels.has(label))
  })

  if (matches.length === 1) return { ok: true, schema: matches[0]! }
  if (matches.length === 0) {
    return {
      ok: false,
      error: 'Could not infer which form to fill from the provided field ids/labels. Pass formId from geometra_form_schema.',
    }
  }
  return {
    ok: false,
    error: 'Multiple forms match the provided field ids/labels. Pass formId from geometra_form_schema.',
  }
}

function coerceChoiceValue(field: FormSchemaField, value: FormValueInput): string | null {
  if (typeof value === 'string') return value
  if (typeof value !== 'boolean') return null
  if (field.booleanChoice) return value ? 'Yes' : 'No'
  const desired = value ? 'yes' : 'no'
  const option = field.options?.find(option => normalizeLookupKey(option) === desired)
  return option ?? (value ? 'Yes' : 'No')
}

function resolveNativeChoiceValue(
  field: FormSchemaField,
  value: string,
): { ok: true; value: string; optionIndex?: number; expectedReadback?: string } | { ok: false; error: string } {
  const options = field.optionDetails
  if (!options || options.length === 0) return { ok: true, value }
  const resolved = (option: NonNullable<FormSchemaField['optionDetails']>[number]) => ({
    ok: true as const,
    value: option.value,
    optionIndex: option.index,
    expectedReadback: option.label,
  })

  const enabled = options.filter(option => !option.disabled)
  const exactValue = enabled.filter(option => option.value === value)
  if (exactValue.length > 0) return resolved(exactValue[0]!)

  const lookup = normalizeLookupKey(value)
  const normalizedValues = enabled.filter(option => normalizeLookupKey(option.value) === lookup)
  if (normalizedValues.length === 1) return resolved(normalizedValues[0]!)
  if (normalizedValues.length > 1) {
    const distinct = new Set(normalizedValues.map(option => option.value))
    if (distinct.size === 1) return resolved(normalizedValues[0]!)
    return {
      ok: false,
      error: `Option value "${value}" is ambiguous for field "${field.label}". Use an exact option value from optionDetails.`,
    }
  }

  const labelMatches = enabled.filter(option => normalizeLookupKey(option.label) === lookup)
  if (labelMatches.length === 1) return resolved(labelMatches[0]!)
  if (labelMatches.length > 1) {
    const distinctValues = new Set(labelMatches.map(option => option.value))
    if (distinctValues.size === 1) return resolved(labelMatches[0]!)
    return {
      ok: false,
      error: `Option label "${value}" maps to multiple submitted values for field "${field.label}". Use an exact option value from optionDetails.`,
    }
  }

  const disabledMatch = options.some(option => option.disabled && (
    option.value === value ||
    normalizeLookupKey(option.value) === lookup ||
    normalizeLookupKey(option.label) === lookup
  ))
  if (disabledMatch) {
    return { ok: false, error: `Option "${value}" is disabled for field "${field.label}".` }
  }

  const available = enabled.slice(0, 12).map(option => `${option.label} (${option.value})`)
  return {
    ok: false,
    error: `Unknown option "${value}" for field "${field.label}".${available.length > 0 ? ` Available options: ${available.join(', ')}.` : ''}`,
  }
}

/**
 * Normalize a text value based on field format hints (placeholder, inputType, pattern).
 * Handles common date and phone format conversions.
 */
function normalizeFieldValue(value: string, format?: FormSchemaField['format']): string {
  if (!format) return value

  // Date normalization: detect ISO dates and convert to placeholder format
  if (format.inputType === 'date') return value // native date inputs handle ISO fine

  const isDateLike = /^\d{4}-\d{2}-\d{2}$/.test(value) || /^\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4}$/.test(value)
  if (isDateLike && format.placeholder) {
    const parsed = parseDateLoose(value)
    if (parsed) {
      const ph = format.placeholder.toLowerCase()
      if (ph.includes('mm/dd/yyyy') || ph.includes('mm/dd/yy')) {
        return `${pad2(parsed.month)}/${pad2(parsed.day)}/${parsed.year}`
      }
      if (ph.includes('dd/mm/yyyy') || ph.includes('dd/mm/yy')) {
        return `${pad2(parsed.day)}/${pad2(parsed.month)}/${parsed.year}`
      }
      if (ph.includes('yyyy-mm-dd')) {
        return `${parsed.year}-${pad2(parsed.month)}-${pad2(parsed.day)}`
      }
      if (ph.includes('mm-dd-yyyy')) {
        return `${pad2(parsed.month)}-${pad2(parsed.day)}-${parsed.year}`
      }
    }
  }

  // Phone normalization
  if (format.inputType === 'tel' || format.autocomplete?.includes('tel')) {
    const digits = value.replace(/\D/g, '')
    if (digits.length === 10 && format.placeholder) {
      const ph = format.placeholder
      if (ph.includes('(') && ph.includes(')')) {
        return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`
      }
      if (ph.includes('-') && !ph.includes('(')) {
        return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`
      }
      if (ph.includes('.')) {
        return `${digits.slice(0, 3)}.${digits.slice(3, 6)}.${digits.slice(6)}`
      }
    }
    if (digits.length === 11 && digits.startsWith('1') && format.placeholder) {
      const core = digits.slice(1)
      const ph = format.placeholder
      if (ph.startsWith('+1') || ph.startsWith('1')) {
        return `+1 (${core.slice(0, 3)}) ${core.slice(3, 6)}-${core.slice(6)}`
      }
    }
  }

  return value
}

function parseDateLoose(value: string): { year: number; month: number; day: number } | null {
  // YYYY-MM-DD
  const iso = value.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (iso) return { year: +iso[1]!, month: +iso[2]!, day: +iso[3]! }
  // MM/DD/YYYY or MM-DD-YYYY or MM.DD.YYYY
  const mdy = value.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})$/)
  if (mdy) return { year: +mdy[3]!, month: +mdy[1]!, day: +mdy[2]! }
  // MM/DD/YY
  const mdy2 = value.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2})$/)
  if (mdy2) {
    const yr = +mdy2[3]!
    return { year: yr < 50 ? 2000 + yr : 1900 + yr, month: +mdy2[1]!, day: +mdy2[2]! }
  }
  return null
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

function plannedFillInputsForField(field: FormSchemaField, value: FormValueInput): ResolvedFillFieldInput[] | { error: string } {
  if (field.kind === 'file') {
    if (!Array.isArray(value)) {
      return { error: `Field "${field.label}" expects a non-empty string array of proxy-host file paths` }
    }
    const paths = value.map(path => path.trim()).filter(Boolean)
    if (paths.length === 0 || paths.length !== value.length) {
      return { error: `Field "${field.label}" expects a non-empty string array of proxy-host file paths` }
    }
    if (field.format?.multiple !== true && paths.length > 1) {
      return { error: `Field "${field.label}" accepts only one file` }
    }
    return [{
      kind: 'file',
      fieldId: field.id,
      ...(field.fieldKey ? { fieldKey: field.fieldKey } : {}),
      fieldLabel: field.label,
      paths,
    }]
  }

  if (field.kind === 'text') {
    if (typeof value !== 'string') return { error: `Field "${field.label}" expects a string value` }
    const normalized = normalizeFieldValue(value, field.format)
    return [{
      kind: 'text',
      fieldId: field.id,
      ...(field.fieldKey ? { fieldKey: field.fieldKey } : {}),
      fieldLabel: field.label,
      value: normalized,
    }]
  }

  if (field.kind === 'choice') {
    const coerced = coerceChoiceValue(field, value)
    if (coerced === null) return { error: `Field "${field.label}" expects a string value` }
    const resolvedChoice = field.choiceType === 'select'
      ? resolveNativeChoiceValue(field, coerced)
      : { ok: true as const, value: coerced }
    if (!resolvedChoice.ok) return { error: resolvedChoice.error }
    return [{
      kind: 'choice',
      fieldId: field.id,
      ...(field.fieldKey ? { fieldKey: field.fieldKey } : {}),
      fieldLabel: field.label,
      value: resolvedChoice.value,
      ...(resolvedChoice.optionIndex !== undefined ? { optionIndex: resolvedChoice.optionIndex } : {}),
      ...(resolvedChoice.expectedReadback !== undefined ? { expectedReadback: resolvedChoice.expectedReadback } : {}),
      ...(field.choiceType === 'select' && field.optionDetails?.length ? { exact: true } : {}),
      ...(field.choiceType ? { choiceType: field.choiceType } : {}),
    }]
  }

  if (field.kind === 'toggle') {
    if (typeof value !== 'boolean') return { error: `Field "${field.label}" expects a boolean value` }
    return [{
      kind: 'toggle',
      fieldId: field.id,
      ...(field.fieldKey ? { fieldKey: field.fieldKey } : {}),
      label: field.label,
      checked: value,
      controlType: field.controlType,
    }]
  }

  const selected = Array.isArray(value) ? value : typeof value === 'string' ? [value] : null
  if (!selected || selected.length === 0) return { error: `Field "${field.label}" expects a string array value` }
  if (!field.options || field.options.length === 0) {
    return { error: `Field "${field.label}" does not expose checkbox options; use geometra_fill_fields for this field` }
  }
  const selectedKeys = new Set(selected.map(normalizeLookupKey))
  return field.options.map(option => ({
    kind: 'toggle',
    fieldId: field.id,
    ...(field.fieldKey ? { fieldKey: field.fieldKey } : {}),
    label: option,
    checked: selectedKeys.has(normalizeLookupKey(option)),
    controlType: 'checkbox',
  }))
}

interface PlannedFillField {
  field: ResolvedFillFieldInput
  confidence: number
  matchMethod: 'id' | 'label-exact' | 'label-normalized'
}

function unkeyedSchemaFieldIsAmbiguous(field: FormSchemaField, schemas: FormSchemaModel[]): boolean {
  if (field.fieldKey) return false
  const matchingIds = new Set<string>()
  const label = normalizeLookupKey(field.label)
  for (const schema of schemas) {
    for (const candidate of schema.fields) {
      if (normalizeLookupKey(candidate.label) === label) matchingIds.add(candidate.id)
    }
  }
  return matchingIds.size > 1
}

function ambiguousFieldIdentityError(field: FormSchemaField): string {
  return `Field "${field.label}" has no unique authored identity and shares its label with another control. Geometra refused to guess; refresh the schema or use a contextual recovery action.`
}

function planFormFill(
  schema: FormSchemaModel,
  opts: {
    valuesById?: Record<string, FormValueInput>
    valuesByLabel?: Record<string, FormValueInput>
  },
  pageSchemas: FormSchemaModel[] = [schema],
): { ok: true; fields: ResolvedFillFieldInput[]; planned: PlannedFillField[] } | { ok: false; error: string } {
  const fieldById = new Map(schema.fields.map(field => [field.id, field]))
  const fieldsByLabel = new Map<string, FormSchemaField[]>()
  for (const field of schema.fields) {
    const key = normalizeLookupKey(field.label)
    const existing = fieldsByLabel.get(key)
    if (existing) existing.push(field)
    else fieldsByLabel.set(key, [field])
  }

  const allPlanned: PlannedFillField[] = []
  const seenFieldIds = new Set<string>()

  for (const [fieldId, value] of Object.entries(opts.valuesById ?? {})) {
    const field = fieldById.get(fieldId)
    if (!field) return { ok: false, error: `Unknown form field id ${fieldId}. Refresh geometra_form_schema and try again.` }
    if (unkeyedSchemaFieldIsAmbiguous(field, pageSchemas)) {
      return { ok: false, error: ambiguousFieldIdentityError(field) }
    }
    const next = plannedFillInputsForField(field, value)
    if ('error' in next) return { ok: false, error: next.error }
    for (const n of next) allPlanned.push({ field: n, confidence: 1.0, matchMethod: 'id' })
    seenFieldIds.add(field.id)
  }

  for (const [label, value] of Object.entries(opts.valuesByLabel ?? {})) {
    const matches = fieldsByLabel.get(normalizeLookupKey(label)) ?? []
    if (matches.length === 0) return { ok: false, error: `Unknown form field label "${label}". Refresh geometra_form_schema and try again.` }
    if (matches.length > 1) {
      return { ok: false, error: `Label "${label}" is ambiguous in form ${schema.formId}. Use valuesById for this field.` }
    }
    const field = matches[0]!
    if (unkeyedSchemaFieldIsAmbiguous(field, pageSchemas)) {
      return { ok: false, error: ambiguousFieldIdentityError(field) }
    }
    if (seenFieldIds.has(field.id)) {
      return { ok: false, error: `Field "${label}" was provided in both valuesById and valuesByLabel` }
    }
    const next = plannedFillInputsForField(field, value)
    if ('error' in next) return { ok: false, error: next.error }
    const isExact = field.label === label
    const confidence = isExact ? 0.95 : 0.8
    const matchMethod = isExact ? 'label-exact' as const : 'label-normalized' as const
    for (const n of next) allPlanned.push({ field: n, confidence, matchMethod })
    seenFieldIds.add(field.id)
  }

  return { ok: true, fields: allPlanned.map(p => p.field), planned: allPlanned }
}

function isResolvedFillFieldInput(field: FillFieldInput): field is ResolvedFillFieldInput {
  if (field.kind === 'toggle') return typeof field.label === 'string' && field.label.length > 0
  return typeof field.fieldLabel === 'string' && field.fieldLabel.length > 0
}

function resolveFillFieldInputs(
  session: Session,
  fields: FillFieldInput[],
): { ok: true; fields: ResolvedFillFieldInput[] } | { ok: false; error: string } {
  const unresolved = fields.filter(field => !isResolvedFillFieldInput(field))
  const requiresSchemaLookup = fields.some(field => typeof field.fieldId === 'string')
  const a11y = sessionA11y(session)
  if (unresolved.length === 0 && !requiresSchemaLookup && !a11y) {
    return { ok: true, fields: fields as ResolvedFillFieldInput[] }
  }

  if (!a11y) {
    return { ok: false, error: 'No UI tree available to resolve fieldId entries from geometra_form_schema' }
  }

  const schemas = buildFormSchemas(a11y, { includeOptions: true, includeContext: 'always' })
  const fieldById = new Map<string, FormSchemaField>()
  for (const schema of schemas) {
    for (const field of schema.fields) fieldById.set(field.id, field)
  }

  const resolved: ResolvedFillFieldInput[] = []
  for (const field of fields) {
    if (isResolvedFillFieldInput(field)) {
      const schemaField = field.fieldId ? fieldById.get(field.fieldId) : undefined
      if (field.fieldId && !schemaField) {
        return { ok: false, error: `Unknown form field id ${field.fieldId}. Refresh geometra_form_schema and try again.` }
      }
      if (schemaField) {
        if (schemaField.kind !== field.kind) {
          return { ok: false, error: `Field id ${field.fieldId} resolves to kind "${schemaField.kind}", not ${field.kind}.` }
        }
        const suppliedLabel = field.kind === 'toggle' ? field.label : field.fieldLabel
        if (normalizeLookupKey(suppliedLabel) !== normalizeLookupKey(schemaField.label)) {
          return {
            ok: false,
            error: `Field id ${field.fieldId} now resolves to "${schemaField.label}", not "${suppliedLabel}". Refresh geometra_form_schema; Geometra refused to downgrade the stale id to a label-only mutation.`,
          }
        }
      }
      const suppliedLabel = field.kind === 'toggle' ? field.label : field.fieldLabel
      const distinctLabelMatches = new Map<string, FormSchemaField>()
      for (const candidate of fieldById.values()) {
        if (normalizeLookupKey(candidate.label) === normalizeLookupKey(suppliedLabel)) {
          distinctLabelMatches.set(candidate.id, candidate)
        }
      }
      const effectiveFieldKey = field.fieldKey ?? schemaField?.fieldKey
      if (!effectiveFieldKey && distinctLabelMatches.size > 1) {
        return {
          ok: false,
          error: schemaField
            ? ambiguousFieldIdentityError(schemaField)
            : `Field label "${suppliedLabel}" is ambiguous and no exact field identity was supplied. Geometra refused to guess.`,
        }
      }
      if (field.kind === 'choice' && schemaField?.kind === 'choice') {
        const resolvedChoice = schemaField.choiceType === 'select'
          ? resolveNativeChoiceValue(schemaField, field.value)
          : { ok: true as const, value: field.value }
        if (!resolvedChoice.ok) return { ok: false, error: resolvedChoice.error }
        resolved.push({
          ...field,
          value: resolvedChoice.value,
          ...(resolvedChoice.optionIndex !== undefined ? { optionIndex: resolvedChoice.optionIndex } : {}),
          ...(resolvedChoice.expectedReadback !== undefined ? { expectedReadback: resolvedChoice.expectedReadback } : {}),
          ...(schemaField.fieldKey ? { fieldKey: schemaField.fieldKey } : {}),
          ...(field.choiceType === undefined && schemaField.choiceType ? { choiceType: schemaField.choiceType } : {}),
          ...(schemaField.choiceType === 'select' && schemaField.optionDetails?.length ? { exact: true } : {}),
        })
      } else if (field.kind === 'toggle' && schemaField?.kind === 'toggle') {
        resolved.push({
          ...field,
          ...(schemaField.fieldKey ? { fieldKey: schemaField.fieldKey } : {}),
          ...(field.controlType === undefined && schemaField.controlType ? { controlType: schemaField.controlType } : {}),
        })
      } else {
        resolved.push({
          ...field,
          ...(schemaField?.fieldKey ? { fieldKey: schemaField.fieldKey } : {}),
        })
      }
      continue
    }

    if (!field.fieldId) {
      return {
        ok: false,
        error:
          field.kind === 'toggle'
            ? 'Toggle fields require label, or provide fieldId from geometra_form_schema so MCP can resolve the current label.'
            : `${field.kind} fields require fieldLabel, or provide fieldId from geometra_form_schema so MCP can resolve the current label.`,
      }
    }

    const schemaField = fieldById.get(field.fieldId)
    if (!schemaField) {
      return { ok: false, error: `Unknown form field id ${field.fieldId}. Refresh geometra_form_schema and try again.` }
    }
    if (unkeyedSchemaFieldIsAmbiguous(schemaField, schemas)) {
      return { ok: false, error: ambiguousFieldIdentityError(schemaField) }
    }

    if (field.kind === 'text') {
      if (schemaField.kind !== 'text') {
        return { ok: false, error: `Field id ${field.fieldId} resolves to kind "${schemaField.kind}", not text.` }
      }
      resolved.push({
        ...field,
        ...(schemaField.fieldKey ? { fieldKey: schemaField.fieldKey } : {}),
        fieldLabel: schemaField.label,
      })
      continue
    }

    if (field.kind === 'choice') {
      if (schemaField.kind !== 'choice') {
        return { ok: false, error: `Field id ${field.fieldId} resolves to kind "${schemaField.kind}", not choice.` }
      }
      const resolvedChoice = schemaField.choiceType === 'select'
        ? resolveNativeChoiceValue(schemaField, field.value)
        : { ok: true as const, value: field.value }
      if (!resolvedChoice.ok) return { ok: false, error: resolvedChoice.error }
      resolved.push({
        ...field,
        ...(schemaField.fieldKey ? { fieldKey: schemaField.fieldKey } : {}),
        fieldLabel: schemaField.label,
        value: resolvedChoice.value,
        ...(resolvedChoice.optionIndex !== undefined ? { optionIndex: resolvedChoice.optionIndex } : {}),
        ...(resolvedChoice.expectedReadback !== undefined ? { expectedReadback: resolvedChoice.expectedReadback } : {}),
        ...(field.choiceType === undefined && schemaField.choiceType ? { choiceType: schemaField.choiceType } : {}),
        ...(schemaField.choiceType === 'select' && schemaField.optionDetails?.length ? { exact: true } : {}),
      })
      continue
    }

    if (field.kind === 'toggle') {
      if (schemaField.kind !== 'toggle') {
        return { ok: false, error: `Field id ${field.fieldId} resolves to kind "${schemaField.kind}", not toggle.` }
      }
      resolved.push({
        ...field,
        ...(schemaField.fieldKey ? { fieldKey: schemaField.fieldKey } : {}),
        label: schemaField.label,
        ...(field.controlType === undefined && schemaField.controlType ? { controlType: schemaField.controlType } : {}),
      })
      continue
    }

    if (schemaField.kind !== 'file') {
      return { ok: false, error: `Field id ${field.fieldId} resolves to kind "${schemaField.kind}", not file.` }
    }
    resolved.push({
      ...field,
      ...(schemaField.fieldKey ? { fieldKey: schemaField.fieldKey } : {}),
      fieldLabel: schemaField.label,
    })
  }

  return { ok: true, fields: resolved }
}

function canFallbackToSequentialFill(error: unknown): boolean {
  if (ambiguousOutcomeDetails(error)) return false
  const message = error instanceof Error ? error.message : String(error)
  try {
    const parsed = JSON.parse(message) as Record<string, unknown>
    if (
      parsed?.error === 'listboxPick' ||
      parsed?.error === 'setFieldText' ||
      parsed?.error === 'setFieldChoice' ||
      parsed?.error === 'setChecked' ||
      parsed?.error === 'attachFiles'
    ) {
      return true
    }
  } catch {
    /* ignore non-JSON errors */
  }
  return (
    message.includes('Unsupported client message type "fillFields"') ||
    message.includes('Client message type "fillFields" is not supported') ||
    message.startsWith('setFieldText:') ||
    message.startsWith('setFieldChoice:') ||
    message.startsWith('setChecked:') ||
    message.startsWith('attachFiles:') ||
    message.startsWith('pickListboxOption:') ||
    message.startsWith('Could not find a') ||
    message.startsWith('No visible')
  )
}

function parseProxyFillAckResult(value: unknown): ProxyFillAckResult | undefined {
  if (!value || typeof value !== 'object') return undefined
  const candidate = value as Record<string, unknown>
  if (
    typeof candidate.invalidCount !== 'number' ||
    typeof candidate.alertCount !== 'number' ||
    typeof candidate.dialogCount !== 'number' ||
    typeof candidate.busyCount !== 'number'
  ) {
    return undefined
  }
  const invalidFields = Array.isArray(candidate.invalidFields) ? candidate.invalidFields as Array<{ name?: string; error?: string }> : undefined
  return {
    ...(typeof candidate.pageUrl === 'string' ? { pageUrl: candidate.pageUrl } : {}),
    invalidCount: candidate.invalidCount,
    alertCount: candidate.alertCount,
    dialogCount: candidate.dialogCount,
    busyCount: candidate.busyCount,
    ...(invalidFields && invalidFields.length > 0 ? { invalidFields } : {}),
  }
}

async function tryBatchedResolvedFields(
  session: Session,
  fields: ResolvedFillFieldInput[],
  detail: ResponseDetail,
): Promise<
  | { ok: true; finalSource: 'proxy' | 'session'; final: ProxyFillAckResult | Record<string, unknown>; invalidRemaining: number }
  | { ok: false }
> {
  let batchAckResult: ProxyFillAckResult | undefined
  try {
    const startRevision = session.updateRevision
    const wait = await sendFillFields(session, toProxyFillFields(fields))
    assertActionWaitConfirmed('Batched field fill', wait)
    const ackResult = parseProxyFillAckResult(wait.result)
    batchAckResult = ackResult
    if (fields.some(field => field.kind === 'file')) {
      if (!ackResult) {
        throw new AmbiguousActionOutcomeError(
          'Batched file fill',
          wait,
          'Batched file fill was acknowledged without structured proxy confirmation; the upload may already have happened. Do not retry blindly.',
        )
      }
      return {
        ok: true,
        finalSource: 'proxy',
        final: ackResult,
        invalidRemaining: ackResult.invalidCount,
      }
    }
    if (ackResult && ackResult.invalidCount === 0) {
      return {
        ok: true,
        finalSource: 'proxy',
        final: ackResult,
        invalidRemaining: 0,
      }
    }
    await waitForDeferredBatchUpdate(session, startRevision, wait)
    await waitForBatchFieldReadback(session, fields)
  } catch (e) {
    if (canFallbackToSequentialFill(e)) return { ok: false }
    throw e
  }

  const after = sessionA11y(session)
  if (!after) return { ok: false }
  const signals = collectSessionSignals(after)
  const invalidRemaining = signals.invalidFields.length
  if ((!batchAckResult || batchAckResult.invalidCount > 0) && invalidRemaining > 0) {
    return { ok: false }
  }

  return {
    ok: true,
    finalSource: 'session',
    final: sessionSignalsPayload(signals, detail),
    invalidRemaining,
  }
}

async function waitForDeferredBatchUpdate(
  session: Session,
  startRevision: number,
  wait: UpdateWaitResult,
): Promise<void> {
  if (wait.status !== 'acknowledged' || session.updateRevision > startRevision) return
  await waitForUiCondition(session, () => session.updateRevision > startRevision, 750)
}

async function waitForBatchFieldReadback(session: Session, fields: ResolvedFillFieldInput[]): Promise<void> {
  await waitForUiCondition(session, () => {
    const a11y = sessionA11y(session)
    if (!a11y) return false
    return fields.every(field => batchFieldReadbackMatches(a11y, field))
  }, 1500)
}

function batchFieldReadbackMatches(a11y: A11yNode, field: ResolvedFillFieldInput): boolean {
  switch (field.kind) {
    case 'text': {
      const matches = fieldReadbackNodes(a11y, field.fieldLabel, ['textbox'], field.fieldKey)
      return matches.some(match => normalizeLookupKey(match.value ?? '') === normalizeLookupKey(field.value))
    }
    case 'choice': {
      const directMatches = fieldReadbackNodes(
        a11y,
        field.fieldLabel,
        ['combobox', 'textbox', 'button'],
        field.fieldKey,
      )
      if (directMatches.length === 0) return field.fieldKey === undefined
      if (field.optionIndex !== undefined) {
        return directMatches.some(match => {
          const selected = match.meta?.options?.find(option => option.selected)
          return selected
            ? selected.index === field.optionIndex && selected.value === field.value
            : false
        })
      }
      const expected = [field.value, field.expectedReadback]
        .filter((value): value is string => value !== undefined)
        .map(normalizeLookupKey)
      return directMatches.some(match => expected.includes(normalizeLookupKey(match.value ?? '')))
    }
    case 'toggle':
      return true
    case 'file': {
      const matches = fieldReadbackNodes(a11y, field.fieldLabel, ['textbox', 'button'], field.fieldKey)
      return field.fieldKey
        ? matches.some(match => Boolean(match.value && match.value.trim()))
        : matches.length === 0 || matches.some(match => Boolean(match.value && match.value.trim()))
    }
  }
}

function actionNeedsUiTree(action: BatchAction): boolean {
  switch (action.type) {
    case 'wait_for':
    case 'expand_section':
      return true
    case 'click':
      return action.x === undefined || action.y === undefined || Boolean(action.waitFor)
    default:
      return false
  }
}

function canDeferInitialFrameForRunActions(actions: BatchAction[]): boolean {
  const first = actions[0]
  if (!first) return false
  return first.type === 'fill_fields'
}

function assertBatchActionConfirmed(actionType: BatchAction['type'], wait: UpdateWaitResult): void {
  assertActionWaitConfirmed(`${actionType} action`, wait)
}

class AmbiguousActionOutcomeError extends Error {
  readonly wait: UpdateWaitResult

  constructor(actionName: string, wait: UpdateWaitResult, message?: string) {
    super(message ?? `${actionName} timed out after ${wait.timeoutMs}ms; its outcome is unconfirmed. ${ambiguousActionGuidance(wait)}`)
    this.name = 'AmbiguousActionOutcomeError'
    this.wait = wait
  }
}

interface AmbiguousOutcomeDetails {
  wait?: UpdateWaitResult
  requestId?: string
  actionId?: string
  code?: string
}

function ambiguousOutcomeDetails(error: unknown): AmbiguousOutcomeDetails | undefined {
  if (error instanceof AmbiguousActionOutcomeError) {
    return {
      wait: error.wait,
      requestId: error.wait.requestId,
      actionId: error.wait.actionId,
    }
  }
  if (!error || typeof error !== 'object') return undefined
  const candidate = error as Record<string, unknown>
  const code = typeof candidate.code === 'string' ? candidate.code : undefined
  const requestId = typeof candidate.requestId === 'string' ? candidate.requestId : undefined
  const actionId = typeof candidate.actionId === 'string' ? candidate.actionId : undefined
  const message = typeof candidate.message === 'string' ? candidate.message : ''
  if (
    code !== 'ACTION_OUTCOME_AMBIGUOUS' &&
    !(requestId && actionId && message.includes('Outcome is ambiguous'))
  ) return undefined
  return { ...(requestId ? { requestId } : {}), ...(actionId ? { actionId } : {}), ...(code ? { code } : {}) }
}

function ambiguousOutcomePayload(details: AmbiguousOutcomeDetails): Record<string, unknown> {
  return {
    outcome: 'unconfirmed',
    retrySafety: 'inspect-first',
    ...(details.wait ? waitStatusPayload(details.wait) : {}),
    ...(!details.wait && details.requestId ? { requestId: details.requestId } : {}),
    ...(!details.wait && details.actionId ? { actionId: details.actionId } : {}),
    ...(details.code ? { code: details.code } : {}),
    guidance: details.actionId && details.requestId
      ? `Outcome is ambiguous for actionId ${details.actionId} (requestId ${details.requestId}). Do not retry blindly or skip this step; inspect the current UI first.`
      : 'The action outcome is ambiguous. Do not retry blindly or skip this step; inspect the current UI first.',
  }
}

function assertActionWaitConfirmed(actionName: string, wait: UpdateWaitResult): void {
  if (wait.status === 'timed_out') {
    throw new AmbiguousActionOutcomeError(actionName, wait)
  }
}

async function executeBatchAction(
  session: Session,
  action: BatchAction,
  detail: ResponseDetail,
  includeSteps: boolean,
): Promise<StepExecutionResult> {
  switch (action.type) {
    case 'click': {
      const before = sessionA11y(session)
      const resolved = await resolveClickLocationWithFallback(session, {
        x: action.x,
        y: action.y,
        filter: {
          id: action.id,
          role: action.role,
          name: action.name,
          text: action.text,
          contextText: action.contextText,
          promptText: action.promptText,
          sectionText: action.sectionText,
          itemText: action.itemText,
          value: action.value,
          checked: action.checked,
          disabled: action.disabled,
          focused: action.focused,
          selected: action.selected,
          expanded: action.expanded,
          invalid: action.invalid,
          required: action.required,
          busy: action.busy,
        },
        index: action.index,
        fullyVisible: action.fullyVisible,
        maxRevealSteps: action.maxRevealSteps,
        revealTimeoutMs: action.revealTimeoutMs,
      })
      if (!resolved.ok) throw new Error(clickFallbackErrorMessage(resolved))

      const waitFilter: NodeFilter | undefined = action.waitFor ? {
        id: action.waitFor.id,
        role: action.waitFor.role,
        name: action.waitFor.name,
        text: action.waitFor.text,
        contextText: action.waitFor.contextText,
        promptText: action.waitFor.promptText,
        sectionText: action.waitFor.sectionText,
        itemText: action.waitFor.itemText,
        value: action.waitFor.value,
        checked: action.waitFor.checked,
        disabled: action.waitFor.disabled,
        focused: action.waitFor.focused,
        selected: action.waitFor.selected,
        expanded: action.waitFor.expanded,
        invalid: action.waitFor.invalid,
        required: action.waitFor.required,
        busy: action.waitFor.busy,
      } : undefined
      const waitEvidenceRoot = sessionA11y(session) ?? before
      const beforeWaitEvidence = waitFilter && waitEvidenceRoot
        ? captureWaitEvidence(waitEvidenceRoot, waitFilter)
        : undefined

      const wait = await sendClick(session, resolved.value.x, resolved.value.y, action.timeoutMs)
      assertBatchActionConfirmed(action.type, wait)
      const targetSummary = resolved.value.target
        ? `Clicked ${describeFormattedNode(resolved.value.target)} at (${resolved.value.x}, ${resolved.value.y}).`
        : `Clicked at (${resolved.value.x}, ${resolved.value.y}).`
      let postWaitSummary: string | undefined
      let postWaitCompact: Record<string, unknown> | undefined
      if (action.waitFor) {
        const postWait = await waitForSemanticCondition(session, {
          filter: waitFilter!,
          present: action.waitFor.present ?? true,
          timeoutMs: action.waitFor.timeoutMs ?? 10_000,
        })
        if (!postWait.ok) {
          throw new Error(`Post-click wait failed after ${targetSummary.toLowerCase()}\n${postWait.error}`)
        }
        const fresh = waitConditionHasFreshEvidence(beforeWaitEvidence, sessionA11y(session), postWait.value)
        if (!fresh) {
          throw new Error(`Post-click wait matched only pre-existing evidence after ${targetSummary.toLowerCase()}; the click outcome is unconfirmed.`)
        }
        postWaitSummary = `Post-click ${waitConditionSuccessLine(postWait.value)}`
        postWaitCompact = { ...waitConditionCompact(postWait.value), fresh: true }
      }
      return {
        summary: [targetSummary, postActionSummary(session, before, wait, detail), postWaitSummary].filter(Boolean).join('\n'),
        compact: {
          at: { x: resolved.value.x, y: resolved.value.y },
          ...(resolved.value.target ? { target: compactNodeReference(resolved.value.target), revealSteps: resolved.value.revealAttempts ?? 0 } : {}),
          ...waitStatusPayload(wait),
          ...(resolved.fallback ? { fallback: resolved.fallback } : {}),
          ...(postWaitCompact ? { postWait: postWaitCompact } : {}),
        },
      }
    }
    case 'type': {
      const before = sessionA11y(session)
      const wait = await sendType(session, action.text, action.timeoutMs)
      assertBatchActionConfirmed(action.type, wait)
      return {
        summary: `Typed "${action.text}".\n${postActionSummary(session, before, wait, detail)}`,
        compact: {
          ...compactTextValue(action.text),
          ...waitStatusPayload(wait),
        },
      }
    }
    case 'key': {
      const before = sessionA11y(session)
      const wait = await sendKey(
        session,
        action.key,
        { shift: action.shift, ctrl: action.ctrl, meta: action.meta, alt: action.alt },
        action.timeoutMs,
      )
      assertBatchActionConfirmed(action.type, wait)
      return {
        summary: `Pressed ${formatKeyCombo(action.key, action)}.\n${postActionSummary(session, before, wait, detail)}`,
        compact: {
          key: formatKeyCombo(action.key, action),
          ...waitStatusPayload(wait),
        },
      }
    }
    case 'upload_files': {
      const contractError = fileUploadContractError(action)
      if (contractError) throw new Error(contractError)
      const before = sessionA11y(session)
      const wait = await sendFileUpload(session, action.paths, {
        click: action.x !== undefined && action.y !== undefined ? { x: action.x, y: action.y } : undefined,
        fieldLabel: action.fieldLabel,
        exact: action.exact,
        strategy: action.strategy,
        drop: action.dropX !== undefined && action.dropY !== undefined ? { x: action.dropX, y: action.dropY } : undefined,
        contextText: action.contextText,
        sectionText: action.sectionText,
      }, action.timeoutMs ?? 8_000)
      assertBatchActionConfirmed(action.type, wait)
      return {
        summary: `Uploaded ${action.paths.length} file(s).\n${postActionSummary(session, before, wait, detail)}`,
        compact: {
          fileCount: action.paths.length,
          ...(action.fieldLabel ? { fieldLabel: action.fieldLabel } : {}),
          ...(action.strategy ? { strategy: action.strategy } : {}),
          ...(action.contextText ? { contextText: action.contextText } : {}),
          ...(action.sectionText ? { sectionText: action.sectionText } : {}),
          ...waitStatusPayload(wait),
          ...(action.fieldLabel ? { readback: fieldStatePayload(session, action.fieldLabel) } : {}),
        },
      }
    }
    case 'pick_listbox_option': {
      const contractError = listboxPickContractError(action)
      if (contractError) throw new Error(contractError)
      const before = sessionA11y(session)
      const wait = await sendListboxPick(session, action.label, {
        exact: action.exact,
        fieldId: action.fieldId,
        fieldKey: action.fieldKey,
        fieldLabel: action.fieldLabel,
        query: action.query,
      }, action.timeoutMs)
      assertBatchActionConfirmed(action.type, wait)
      const summary = postActionSummary(session, before, wait, detail)
      const fieldSummary = action.fieldLabel
        ? summarizeFieldLabelState(session, action.fieldLabel, action.fieldKey)
        : undefined
      return {
        summary: [`Picked listbox option "${action.label}".`, fieldSummary, summary].filter(Boolean).join('\n'),
        compact: {
          label: action.label,
          ...(action.fieldId ? { fieldId: action.fieldId } : {}),
          ...(action.fieldKey ? { fieldKey: action.fieldKey } : {}),
          ...(action.fieldLabel ? { fieldLabel: action.fieldLabel } : {}),
          ...waitStatusPayload(wait),
          ...(action.fieldLabel ? { readback: fieldStatePayload(session, action.fieldLabel, action.fieldKey) } : {}),
        },
      }
    }
    case 'select_option': {
      const contractError = selectOptionContractError(action)
      if (contractError) throw new Error(contractError)
      const before = sessionA11y(session)
      const wait = await sendSelectOption(session, action.x, action.y, {
        value: action.value,
        label: action.label,
        index: action.index,
      }, action.timeoutMs)
      assertBatchActionConfirmed(action.type, wait)
      return {
        summary: `Selected option.\n${postActionSummary(session, before, wait, detail)}`,
        compact: {
          at: { x: action.x, y: action.y },
          ...(action.value !== undefined ? { value: action.value } : {}),
          ...(action.label !== undefined ? { label: action.label } : {}),
          ...(action.index !== undefined ? { index: action.index } : {}),
          ...waitStatusPayload(wait),
        },
      }
    }
    case 'set_checked': {
      const before = sessionA11y(session)
      const wait = await sendSetChecked(session, action.label, {
        checked: action.checked,
        exact: action.exact,
        controlType: action.controlType,
        ...(action.fieldKey ? { fieldKey: action.fieldKey } : {}),
        contextText: action.contextText,
        sectionText: action.sectionText,
      }, action.timeoutMs)
      assertBatchActionConfirmed(action.type, wait)
      return {
        summary: `Set ${action.controlType ?? 'checkbox/radio'} "${action.label}" to ${String(action.checked ?? true)}.\n${postActionSummary(session, before, wait, detail)}`,
        compact: {
          label: action.label,
          checked: action.checked ?? true,
          ...(action.controlType ? { controlType: action.controlType } : {}),
          ...(action.fieldKey ? { fieldKey: action.fieldKey } : {}),
          ...(action.contextText ? { contextText: action.contextText } : {}),
          ...(action.sectionText ? { sectionText: action.sectionText } : {}),
          ...waitStatusPayload(wait),
        },
      }
    }
    case 'wheel': {
      const before = sessionA11y(session)
      const wait = await sendWheel(session, action.deltaY, {
        deltaX: action.deltaX,
        x: action.x,
        y: action.y,
      }, action.timeoutMs)
      assertBatchActionConfirmed(action.type, wait)
      return {
        summary: `Wheel delta (${action.deltaX ?? 0}, ${action.deltaY}).\n${postActionSummary(session, before, wait, detail)}`,
        compact: {
          deltaY: action.deltaY,
          ...(action.deltaX !== undefined ? { deltaX: action.deltaX } : {}),
          ...(action.x !== undefined && action.y !== undefined ? { at: { x: action.x, y: action.y } } : {}),
          ...waitStatusPayload(wait),
        },
      }
    }
    case 'wait_for': {
      if (!session.tree || !session.layout) throw new Error('Not connected. Call geometra_connect first.')
      const waited = await waitForSemanticCondition(session, {
        filter: {
          id: action.id,
          role: action.role,
          name: action.name,
          text: action.text,
          contextText: action.contextText,
          promptText: action.promptText,
          sectionText: action.sectionText,
          itemText: action.itemText,
          value: action.value,
          checked: action.checked,
          disabled: action.disabled,
          focused: action.focused,
          selected: action.selected,
          expanded: action.expanded,
          invalid: action.invalid,
          required: action.required,
          busy: action.busy,
        },
        present: action.present ?? true,
        timeoutMs: action.timeoutMs ?? 10_000,
      })
      if (!waited.ok) {
        throw new Error(waited.error)
      }
      if (!waited.value.present) {
        return {
          summary: waitConditionSuccessLine(waited.value),
          compact: waitConditionCompact(waited.value),
        }
      }
      if (detail === 'verbose') {
        return {
          summary: JSON.stringify(waited.value.matches, null, 2),
          compact: waitConditionCompact(waited.value),
        }
      }
      return {
        summary: waitConditionSuccessLine(waited.value),
        compact: waitConditionCompact(waited.value),
      }
    }
    case 'expand_section': {
      const a11y = sessionA11y(session)
      if (!a11y) throw new Error('No UI tree available to expand section')
      const sectionDetail = expandPageSection(a11y, action.id, {
        maxHeadings: action.maxHeadings,
        maxFields: action.maxFields,
        fieldOffset: action.fieldOffset,
        onlyRequiredFields: action.onlyRequiredFields,
        onlyInvalidFields: action.onlyInvalidFields,
        maxActions: action.maxActions,
        actionOffset: action.actionOffset,
        maxLists: action.maxLists,
        listOffset: action.listOffset,
        maxItems: action.maxItems,
        itemOffset: action.itemOffset,
        maxTextPreview: action.maxTextPreview,
        includeBounds: action.includeBounds,
      })
      if (!sectionDetail) throw new Error(`No expandable section found for id ${action.id}`)
      return {
        summary: detail === 'verbose'
          ? JSON.stringify(sectionDetail, null, 2)
          : `Expanded section "${action.id}".`,
        compact: { id: action.id, detail: sectionDetail },
      }
    }
    case 'fill_fields': {
      const resolvedFields = resolveFillFieldInputs(session, action.fields)
      if (!resolvedFields.ok) throw new Error(resolvedFields.error)
      const verifyFillsFn = action.verifyFills
        ? () => verifyFormFills(
            session,
            resolvedFields.fields.map(field => ({ field, confidence: 1.0, matchMethod: 'label-exact' as const })),
          )
        : undefined
      let fallbackFromBatch: { attempted: true; used: true; reason: 'batched-unavailable'; attempts: number } | undefined
      if (!includeSteps) {
        const batched = await tryBatchedResolvedFields(session, resolvedFields.fields, detail)
        if (batched.ok) {
          const verification = verifyFillsFn?.()
          return {
            summary: `Filled ${resolvedFields.fields.length} field(s) in one proxy batch.`,
            compact: {
              fieldCount: resolvedFields.fields.length,
              execution: 'batched',
              finalSource: batched.finalSource,
              final: batched.final,
              ...(verification ? { verification } : {}),
            },
          }
        }
        // Batched path unavailable — fall through into sequential and tag the
        // step so `geometra_run_actions` result aggregation matches the shape
        // emitted by standalone `geometra_fill_fields` / `geometra_fill_form`.
        fallbackFromBatch = { attempted: true, used: true, reason: 'batched-unavailable', attempts: 2 }
      }
      const steps: Array<Record<string, unknown>> = []
      for (let index = 0; index < resolvedFields.fields.length; index++) {
        const field = resolvedFields.fields[index]!
        const result = await executeFillField(session, field, detail)
        // A step is only honestly "ok" when the proxy's underlying action
        // both (a) did not throw and (b) reported a tree-updating ack —
        // `wait: 'timed_out'` means the action was sent but the proxy never
        // confirmed a DOM change that matched the request, which is the
        // silent-failure mode that used to leak through as a false positive
        // (e.g. react-select listbox picks that revert on the next render).
        // Choice fields that land in this branch are almost always failed
        // commits, not slow commits, so we surface the failure to the caller
        // instead of pretending the field was set.
        const waitStatus = result.compact && typeof result.compact === 'object' && 'wait' in result.compact
          ? (result.compact as { wait?: unknown }).wait
          : undefined
        const ok = waitStatus !== 'timed_out'
        steps.push(detail === 'verbose'
          ? { index, kind: field.kind, ok, summary: result.summary }
          : { index, kind: field.kind, ok, ...result.compact })
      }
      const verification = verifyFillsFn?.()
      return {
        summary: steps.map(step => String(step.summary ?? '')).filter(Boolean).join('\n'),
        compact: {
          fieldCount: resolvedFields.fields.length,
          ...(includeSteps ? { steps } : {}),
          ...(fallbackFromBatch ? { fallback: fallbackFromBatch } : {}),
          ...(verification ? { verification } : {}),
        },
      }
    }
  }
}

function suggestRecovery(field: ResolvedFillFieldInput, error: string): string | undefined {
  const lowerError = error.toLowerCase()

  if (field.kind === 'choice') {
    if (lowerError.includes('no option') || lowerError.includes('not found') || lowerError.includes('visible')) {
      return `Try geometra_pick_listbox_option with fieldLabel="${field.fieldLabel}" and label="${field.value}" for custom dropdowns.`
    }
    if (lowerError.includes('timeout')) {
      return `Dropdown may load options asynchronously. Retry with a higher timeoutMs, or use geometra_pick_listbox_option with a query parameter.`
    }
  }

  if (field.kind === 'text') {
    if (lowerError.includes('format') || lowerError.includes('pattern') || lowerError.includes('invalid')) {
      return `Field may require a specific format (e.g. MM/DD/YYYY for dates, (555) 123-4567 for phone). Check the field's placeholder or aria-describedby for format hints.`
    }
    if (lowerError.includes('not found') || lowerError.includes('no match')) {
      return `Field label "${field.fieldLabel}" may have changed after page update. Refresh with geometra_form_schema and retry.`
    }
    if (lowerError.includes('timeout')) {
      return `Field may be disabled or obscured. Check geometra_snapshot for the field's current state.`
    }
  }

  if (field.kind === 'toggle') {
    if (lowerError.includes('not found') || lowerError.includes('no match')) {
      return `Checkbox/radio "${field.label}" not found. The label may be dynamic — try geometra_set_checked with exact=false.`
    }
  }

  if (field.kind === 'file') {
    if (lowerError.includes('no file') || lowerError.includes('not found')) {
      return `File input not found by label. Try geometra_upload_files with strategy="hidden" or provide click coordinates.`
    }
  }

  if (lowerError.includes('timeout')) {
    return 'Action timed out and may still complete. Do not retry blindly; inspect the current UI or wait for a loading indicator before repeating the identical action.'
  }

  return undefined
}

// Normalize a value for verifyFills comparison so caller-friendly inputs
// match site-formatted readbacks. The legacy comparison was strict lowercase
// only — which broke every form that auto-formats phone numbers, dates, or
// currency fields. Greenhouse turns "+1-929-608-1737" into "(929) 608-1737";
// Workday turns "$160000" into "$160,000.00"; Lever turns "2026-01-01" into
// "01/01/2026". The lowercase comparator flagged all of these as mismatches
// even though the field state was correct, forcing every caller to either
// disable verifyFills or wrap it in defensive try/catch.
//
// The fix: detect phone-like and number-like values and compare on the
// canonical digit sequence. Plain text and short strings still go through
// the strict lowercase comparator so unrelated content can't accidentally
// match (e.g. "1234 Main St" vs "12-34 Main").
function looksLikePhoneNumber(value: string): boolean {
  // Heuristic: at least 7 digits, and after stripping whitespace + the
  // common phone separator characters (+ - . ( ) space ext) only digits
  // and a single optional leading + remain. Catches international and
  // domestic formats without false-matching addresses or IDs.
  const stripped = value.replace(/[\s().\-+x]|ext\.?/gi, '')
  if (stripped.length < 7) return false
  if (!/^\d+$/.test(stripped)) return false
  return /\d.*[\s().\-+]|^\+\d/.test(value) || /^\d{7,}$/.test(value)
}

function looksLikeFormattedNumber(value: string): boolean {
  // Catches "$160,000.00" / "1,000,000" / "1.5e6" style readbacks where the
  // site adds thousands separators or currency prefixes. Requires at least
  // one comma OR currency prefix to avoid matching plain text.
  if (!/[$€£¥,]/.test(value)) return false
  return /\d/.test(value)
}

function digitSignature(value: string): string {
  return value.replace(/\D+/g, '')
}

export function valuesEquivalent(expected: string, actual: string): boolean {
  if (expected.toLowerCase() === actual.toLowerCase()) return true

  // Both look like phones → compare digit signatures, but allow one to be
  // a suffix of the other so that an explicit country code on the expected
  // side ("+1-929-608-1737" → digits "19296081737") still matches an ATS
  // readback that omits it ("(929) 608-1737" → digits "9296081737"). The
  // suffix check is direction-agnostic — either side may carry the country
  // code. Without this, Greenhouse/Workday/Lever auto-formatted phone
  // fields false-flag as mismatched even though the value is correct.
  // Bug surfaced by JobForge round-2 marathon — Cloudflare FDE NYC #312.
  if (looksLikePhoneNumber(expected) && looksLikePhoneNumber(actual)) {
    const eDigits = digitSignature(expected)
    const aDigits = digitSignature(actual)
    if (!eDigits || !aDigits) return false
    if (eDigits === aDigits) return true
    // Suffix tolerance for country-code drift — only accept if the longer
    // signature ends with the shorter, AND the shorter is at least 7 digits
    // (NANP local minimum) so we don't false-match on tiny extension ids.
    const longer = eDigits.length >= aDigits.length ? eDigits : aDigits
    const shorter = eDigits.length >= aDigits.length ? aDigits : eDigits
    if (shorter.length >= 7 && longer.endsWith(shorter)) return true
    return false
  }

  // Both look like formatted numbers → compare digit signatures only
  if (looksLikeFormattedNumber(expected) || looksLikeFormattedNumber(actual)) {
    const eDigits = digitSignature(expected)
    const aDigits = digitSignature(actual)
    if (eDigits && aDigits && eDigits === aDigits) return true
  }

  // Whitespace normalization for everything else (handles "Charlie  Greenman"
  // vs "Charlie Greenman" auto-collapsed by ATS forms)
  const eNorm = expected.replace(/\s+/g, ' ').trim().toLowerCase()
  const aNorm = actual.replace(/\s+/g, ' ').trim().toLowerCase()
  return eNorm === aNorm
}

function verifyFormFills(
  session: Session,
  planned: PlannedFillField[],
): { verified: number; mismatches: Array<{ fieldLabel: string; expected: string; actual?: string; fieldId?: string }> } {
  const a11y = sessionA11y(session)
  if (!a11y) return { verified: 0, mismatches: [] }

  const mismatches: Array<{ fieldLabel: string; expected: string; actual?: string; fieldId?: string }> = []
  let verified = 0

  for (const p of planned) {
    if (p.field.kind === 'toggle' || p.field.kind === 'file') continue
    const label = p.field.fieldLabel
    const expected = p.field.kind === 'choice'
      ? p.field.expectedReadback ?? p.field.value
      : p.field.value
    const matches = fieldReadbackNodes(
      a11y,
      label,
      ['textbox', 'combobox'],
      p.field.fieldKey,
    )
    const match = matches[0]
    const actual = match?.value?.trim()
    if (p.field.kind === 'choice' && p.field.optionIndex !== undefined && match?.meta?.options) {
      const selected = match.meta.options.find(option => option.selected)
      if (selected?.index === p.field.optionIndex && selected.value === p.field.value) {
        verified++
      } else {
        mismatches.push({
          fieldLabel: label,
          expected,
          actual: selected?.label ?? actual,
          ...(p.field.fieldId ? { fieldId: p.field.fieldId } : {}),
        })
      }
      continue
    }
    if (!actual || !expected) {
      mismatches.push({ fieldLabel: label, expected, actual, ...(p.field.fieldId ? { fieldId: p.field.fieldId } : {}) })
    } else if (!valuesEquivalent(expected, actual)) {
      mismatches.push({ fieldLabel: label, expected, actual, ...(p.field.fieldId ? { fieldId: p.field.fieldId } : {}) })
    } else {
      verified++
    }
  }

  return { verified, mismatches }
}

async function executeFillField(session: Session, field: ResolvedFillFieldInput, detail: ResponseDetail): Promise<StepExecutionResult> {
  switch (field.kind) {
    case 'text': {
      const before = sessionA11y(session)
      const wait = await sendFieldText(
        session,
        field.fieldLabel,
        field.value,
        {
          exact: field.exact,
          fieldId: field.fieldId,
          ...(field.fieldKey ? { fieldKey: field.fieldKey } : {}),
          typingDelayMs: field.typingDelayMs,
          imeFriendly: field.imeFriendly,
        },
        field.timeoutMs,
      )
      assertActionWaitConfirmed(`Text fill for "${field.fieldLabel}"`, wait)
      const fieldSummary = summarizeFieldLabelState(session, field.fieldLabel, field.fieldKey)
      return {
        summary: [
          `Filled text field "${field.fieldLabel}".`,
          fieldSummary,
          postActionSummary(session, before, wait, detail),
        ].filter(Boolean).join('\n'),
        compact: {
          ...(field.fieldId ? { fieldId: field.fieldId } : {}),
          ...(field.fieldKey ? { fieldKey: field.fieldKey } : {}),
          fieldLabel: field.fieldLabel,
          ...compactTextValue(field.value),
          ...waitStatusPayload(wait),
          readback: fieldStatePayload(session, field.fieldLabel, field.fieldKey),
        },
      }
    }
    case 'choice': {
      const before = sessionA11y(session)
      const wait = await sendFieldChoice(
        session,
        field.fieldLabel,
        field.value,
        {
          exact: field.exact,
          query: field.query,
          choiceType: field.choiceType,
          fieldId: field.fieldId,
          ...(field.fieldKey ? { fieldKey: field.fieldKey } : {}),
          ...(field.optionIndex !== undefined ? { optionIndex: field.optionIndex } : {}),
        },
        field.timeoutMs,
      )
      assertActionWaitConfirmed(`Choice fill for "${field.fieldLabel}"`, wait)
      const fieldSummary = summarizeFieldLabelState(session, field.fieldLabel, field.fieldKey)
      return {
        summary: [
          `Set choice field "${field.fieldLabel}" to "${field.value}".`,
          fieldSummary,
          postActionSummary(session, before, wait, detail),
        ].filter(Boolean).join('\n'),
        compact: {
          ...(field.fieldId ? { fieldId: field.fieldId } : {}),
          ...(field.fieldKey ? { fieldKey: field.fieldKey } : {}),
          fieldLabel: field.fieldLabel,
          value: field.value,
          ...(field.optionIndex !== undefined ? { optionIndex: field.optionIndex } : {}),
          ...(field.choiceType ? { choiceType: field.choiceType } : {}),
          ...waitStatusPayload(wait),
          readback: fieldStatePayload(session, field.fieldLabel, field.fieldKey),
        },
      }
    }
    case 'toggle': {
      const before = sessionA11y(session)
      const wait = await sendSetChecked(
        session,
        field.label,
        {
          checked: field.checked,
          exact: field.exact,
          controlType: field.controlType,
          ...(field.fieldKey ? { fieldKey: field.fieldKey } : {}),
        },
        field.timeoutMs,
      )
      assertActionWaitConfirmed(`Toggle fill for "${field.label}"`, wait)
      return {
        summary: `Set ${field.controlType ?? 'checkbox/radio'} "${field.label}" to ${String(field.checked ?? true)}.\n${postActionSummary(session, before, wait, detail)}`,
        compact: {
          label: field.label,
          ...(field.fieldId ? { fieldId: field.fieldId } : {}),
          ...(field.fieldKey ? { fieldKey: field.fieldKey } : {}),
          checked: field.checked ?? true,
          ...(field.controlType ? { controlType: field.controlType } : {}),
          ...waitStatusPayload(wait),
        },
      }
    }
    case 'file': {
      const before = sessionA11y(session)
      const wait = await sendFileUpload(
        session,
        field.paths,
        {
          ...(field.fieldId ? { fieldId: field.fieldId } : {}),
          ...(field.fieldKey ? { fieldKey: field.fieldKey } : {}),
          fieldLabel: field.fieldLabel,
          exact: field.exact,
        },
        field.timeoutMs ?? 8_000,
      )
      assertActionWaitConfirmed(`File fill for "${field.fieldLabel}"`, wait)
      const fieldSummary = summarizeFieldLabelState(session, field.fieldLabel, field.fieldKey)
      return {
        summary: [
          `Uploaded ${field.paths.length} file(s) to "${field.fieldLabel}".`,
          fieldSummary,
          postActionSummary(session, before, wait, detail),
        ].filter(Boolean).join('\n'),
        compact: {
          fieldLabel: field.fieldLabel,
          ...(field.fieldId ? { fieldId: field.fieldId } : {}),
          ...(field.fieldKey ? { fieldKey: field.fieldKey } : {}),
          fileCount: field.paths.length,
          ...waitStatusPayload(wait),
          readback: fieldStatePayload(session, field.fieldLabel, field.fieldKey),
        },
      }
    }
  }
}

function ok(text: string, screenshot?: string) {
  const content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = [
    { type: 'text' as const, text },
  ]
  if (screenshot) {
    content.push({ type: 'image' as const, data: screenshot, mimeType: 'image/png' })
  }
  return { content }
}

function recordWorkflowFill(
  session: Session,
  formId: string | undefined,
  formName: string | undefined,
  valuesById: Record<string, unknown> | undefined,
  valuesByLabel: Record<string, unknown> | undefined,
  invalidCount: number,
  fieldCount: number,
): void {
  if (!session.workflowState) {
    session.workflowState = { pages: [], startedAt: Date.now() }
  }
  const filledValues: Record<string, string | boolean> = {}
  for (const [k, v] of Object.entries(valuesById ?? {})) {
    if (typeof v === 'string' || typeof v === 'boolean') filledValues[k] = v
  }
  for (const [k, v] of Object.entries(valuesByLabel ?? {})) {
    if (typeof v === 'string' || typeof v === 'boolean') filledValues[k] = v
  }

  const a11y = sessionA11y(session)
  const pageUrl = (a11y?.meta?.pageUrl as string | undefined) ?? session.url

  session.workflowState.pages.push({
    pageUrl,
    formId,
    formName,
    filledValues,
    filledAt: Date.now(),
    fieldCount,
    invalidCount,
  })
}

async function captureScreenshotBase64(session: Session): Promise<string | undefined> {
  try {
    const wait = await sendScreenshot(session)
    const result = wait.result as Record<string, unknown> | undefined
    return typeof result?.screenshot === 'string' ? result.screenshot as string : undefined
  } catch {
    return undefined
  }
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true }
}

/**
 * Resolve a tool call's target session with strict routing. Returns either
 * a `Session` or a tool error response that the caller should propagate
 * verbatim. This is the server-side entry point for the Bug #1 fix — every
 * tool that used to do `const session = getSession(sessionId); if (!session)
 * return err('Not connected...')` should use this helper instead so that
 * ambiguous / not-found / none conditions get distinct, honest errors
 * instead of silently routing onto a stale default or a peer worker's
 * isolated session. The typical call site is:
 *
 *     const sessionResult = resolveToolSession(sessionId)
 *     if ('error' in sessionResult) return sessionResult.error
 *     const session = sessionResult.session
 */
function resolveToolSession(
  sessionId: string | undefined,
): { session: Session } | { error: ReturnType<typeof err> } {
  pruneDisconnectedSessions()
  const result = resolveSession(sessionId)
  switch (result.kind) {
    case 'ok':
      return { session: result.session }
    case 'none':
      return { error: err('Not connected. Call geometra_connect first.') }
    case 'not_found':
      return {
        error: err(
          `session_not_found: no active session with id "${result.id}". Active sessions: ${
            result.activeIds.length > 0 ? result.activeIds.join(', ') : '(none)'
          }. The requested session may have disconnected or expired; call geometra_connect again to start a new session — the MCP server never silently routes an explicit sessionId onto a different session.`,
        ),
      }
    case 'ambiguous': {
      const isolatedSuffix =
        result.isolatedIds.length > 0
          ? ` (isolated: ${result.isolatedIds.join(', ')})`
          : ''
      return {
        error: err(
          `multiple_active_sessions_provide_id: ${result.activeIds.length} active sessions — ${result.activeIds.join(', ')}${isolatedSuffix}. Pass sessionId explicitly; the implicit-default fallback is disabled while multiple sessions or any isolated session is active to prevent cross-contamination under parallel-worker load.`,
        ),
      }
    }
  }
}

function hasNodeFilter(filter: NodeFilter): boolean {
  return Object.values(filter).some(value => value !== undefined)
}

function textMatches(haystack: string | undefined, needle: string | undefined): boolean {
  if (!needle) return true
  if (!haystack) return false
  return haystack.toLowerCase().includes(needle.toLowerCase())
}

function sortA11yNodes(nodes: A11yNode[]): A11yNode[] {
  return [...nodes].sort((a, b) => {
    if (a.bounds.y !== b.bounds.y) return a.bounds.y - b.bounds.y
    if (a.bounds.x !== b.bounds.x) return a.bounds.x - b.bounds.x
    return a.path.length - b.path.length
  })
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function nodeContextText(context: { prompt?: string; section?: string; item?: string } | undefined): string | undefined {
  return [context?.prompt, context?.section, context?.item].filter(Boolean).join(' | ') || undefined
}

function nodeMatchesFilter(
  node: A11yNode,
  filter: NodeFilter,
  context?: { prompt?: string; section?: string; item?: string },
): boolean {
  if (filter.id && nodeIdForPath(node.path) !== filter.id) return false
  if (filter.role && node.role !== filter.role) return false
  if (!textMatches(node.name, filter.name)) return false
  if (!textMatches(node.value, filter.value)) return false
  if (
    filter.text &&
    !textMatches(
      `${node.name ?? ''} ${node.value ?? ''} ${node.validation?.error ?? ''} ${node.validation?.description ?? ''}`.trim(),
      filter.text,
    )
  ) return false
  if (!textMatches(nodeContextText(context), filter.contextText)) return false
  if (!textMatches(context?.prompt, filter.promptText)) return false
  if (!textMatches(context?.section, filter.sectionText)) return false
  if (!textMatches(context?.item, filter.itemText)) return false
  if (filter.checked !== undefined && node.state?.checked !== filter.checked) return false
  if (filter.disabled !== undefined && (node.state?.disabled ?? false) !== filter.disabled) return false
  if (filter.focused !== undefined && (node.state?.focused ?? false) !== filter.focused) return false
  if (filter.selected !== undefined && (node.state?.selected ?? false) !== filter.selected) return false
  if (filter.expanded !== undefined && (node.state?.expanded ?? false) !== filter.expanded) return false
  if (filter.invalid !== undefined && (node.state?.invalid ?? false) !== filter.invalid) return false
  if (filter.required !== undefined && (node.state?.required ?? false) !== filter.required) return false
  if (filter.busy !== undefined && (node.state?.busy ?? false) !== filter.busy) return false
  return true
}

export function findNodes(node: A11yNode, filter: NodeFilter): A11yNode[] {
  const matches: A11yNode[] = []

  function walk(n: A11yNode) {
    const context = filter.contextText || filter.promptText || filter.sectionText || filter.itemText
      ? nodeContextForNode(node, n)
      : undefined
    if (nodeMatchesFilter(n, filter, context) && hasNodeFilter(filter)) matches.push(n)
    for (const child of n.children) walk(child)
  }

  walk(node)
  return matches
}

function summarizeFieldLabelState(session: Session, fieldLabel: string, fieldKey?: string): string | undefined {
  const payload = fieldStatePayload(session, fieldLabel, fieldKey)
  if (!payload) return undefined
  const parts = [`Field "${fieldLabel}"`]
  if (payload.role) parts.push(`role=${String(payload.role)}`)
  if (payload.value) parts.push(`value=${JSON.stringify(payload.value)}`)
  if (payload.valueLength) parts.push(`valueLength=${String(payload.valueLength)}`)
  if (payload.state) parts.push(`state=${JSON.stringify(payload.state)}`)
  if (payload.error) parts.push(`error=${JSON.stringify(payload.error)}`)
  return parts.join(' ')
}

function formatNode(
  node: A11yNode,
  root: A11yNode,
  viewport: { width: number; height: number },
): FormattedNodePayload {
  const visibleLeft = Math.max(0, node.bounds.x)
  const visibleTop = Math.max(0, node.bounds.y)
  const visibleRight = Math.min(viewport.width, node.bounds.x + node.bounds.width)
  const visibleBottom = Math.min(viewport.height, node.bounds.y + node.bounds.height)
  const hasVisibleIntersection = visibleRight > visibleLeft && visibleBottom > visibleTop
  const fullyVisible =
    node.bounds.x >= 0 &&
    node.bounds.y >= 0 &&
    node.bounds.x + node.bounds.width <= viewport.width &&
    node.bounds.y + node.bounds.height <= viewport.height
  const centerX = hasVisibleIntersection
    ? Math.round((visibleLeft + visibleRight) / 2)
    : Math.round(Math.min(Math.max(node.bounds.x + node.bounds.width / 2, 0), viewport.width))
  const centerY = hasVisibleIntersection
    ? Math.round((visibleTop + visibleBottom) / 2)
    : Math.round(Math.min(Math.max(node.bounds.y + node.bounds.height / 2, 0), viewport.height))
  const revealDeltaX = Math.round(node.bounds.x + node.bounds.width / 2 - viewport.width / 2)
  const revealDeltaY = Math.round(node.bounds.y + node.bounds.height / 2 - viewport.height / 2)
  const context = nodeContextForNode(root, node)
  return {
    id: nodeIdForPath(node.path),
    role: node.role,
    name: node.name,
    ...(node.value ? { value: node.value } : {}),
    ...(context ? { context } : {}),
    bounds: node.bounds,
    visibleBounds: {
      x: visibleLeft,
      y: visibleTop,
      width: Math.max(0, visibleRight - visibleLeft),
      height: Math.max(0, visibleBottom - visibleTop),
    },
    center: {
      x: centerX,
      y: centerY,
    },
    visibility: {
      intersectsViewport: hasVisibleIntersection,
      fullyVisible,
      offscreenAbove: node.bounds.y + node.bounds.height <= 0,
      offscreenBelow: node.bounds.y >= viewport.height,
      offscreenLeft: node.bounds.x + node.bounds.width <= 0,
      offscreenRight: node.bounds.x >= viewport.width,
    },
    scrollHint: {
      status: fullyVisible ? 'visible' : hasVisibleIntersection ? 'partial' : 'offscreen',
      revealDeltaX,
      revealDeltaY,
    },
    focusable: node.focusable,
    ...(node.state && Object.keys(node.state).length > 0 ? { state: node.state } : {}),
    ...(node.validation && Object.keys(node.validation).length > 0 ? { validation: node.validation } : {}),
    path: node.path,
  }
}

function formatKeyCombo(key: string, mods?: { shift?: boolean; ctrl?: boolean; meta?: boolean; alt?: boolean }): string {
  const parts: string[] = []
  if (mods?.ctrl) parts.push('Ctrl')
  if (mods?.meta) parts.push('Cmd')
  if (mods?.alt) parts.push('Alt')
  if (mods?.shift) parts.push('Shift')
  parts.push(key)
  return parts.join('+')
}
