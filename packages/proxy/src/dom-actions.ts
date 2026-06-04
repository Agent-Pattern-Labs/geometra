import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import type { ElementHandle, Frame, Locator, Page } from 'playwright'
import { canonicalizeHtmlInputValue } from './input-canonical.js'
import type { ClientChoiceType, ClientFillField } from './types.js'

export function delay(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

export type FileAttachStrategy = 'auto' | 'chooser' | 'hidden' | 'drop'

const LABELED_CONTROL_SELECTOR =
  'input, select, textarea, button, [role="combobox"], [role="textbox"], [aria-haspopup="listbox"], [aria-haspopup="menu"], [aria-haspopup="true"], [contenteditable="true"]'

const MENU_TRIGGER_SELECTOR =
  'button[aria-haspopup="menu"], button[aria-haspopup="true"], [role="button"][aria-haspopup="menu"], [role="button"][aria-haspopup="true"]'

const POPUP_CONTAINER_SELECTOR =
  '[role="listbox"], [role="menu"], [role="dialog"], [aria-modal="true"], [data-radix-popper-content-wrapper], [class*="menu"], [class*="option"], [class*="select"], [class*="dropdown"]'

const POPUP_ROOT_SELECTOR =
  '[role="listbox"], [role="menu"], [role="dialog"], [aria-modal="true"], [data-radix-popper-content-wrapper], [class*="menu"], [class*="dropdown"], [class*="popover"], [class*="listbox"], [class*="options"]'

const OPTION_PICKER_SELECTOR =
  [
    '[role="option"]',
    '[role="menuitem"]',
    '[role="menuitemradio"]',
    '[role="menuitemcheckbox"]',
    '[role="treeitem"]',
    'button',
    'li',
    '[data-value]',
    '[aria-selected]',
    '[aria-checked]',
    '[role="listbox"] > *',
    '[role="menu"] > *',
    '[class*="option"]',
    '[class*="menu-item"]',
    '[class*="dropdown-item"]',
    '[class*="listbox-option"]',
  ].join(', ')

const MAX_VISIBLE_OPTION_HINTS = 12
const LISTBOX_KEYBOARD_FALLBACK_STEPS = 40

interface AnchorPoint {
  x?: number
  y?: number
}

export interface FillLookupCache {
  control: Map<string, Locator | null>
  editable: Map<string, Locator | null>
  fileInput: Map<string, Locator | null>
}

export function createFillLookupCache(): FillLookupCache {
  return {
    control: new Map(),
    editable: new Map(),
    fileInput: new Map(),
  }
}

export function clearFillLookupCache(cache: FillLookupCache): void {
  cache.control.clear()
  cache.editable.clear()
  cache.fileInput.clear()
}

function lookupCacheKey(kind: 'control' | 'editable' | 'file', label: string, exact: boolean): string {
  return `${kind}:${exact ? 'exact' : 'fuzzy'}:${normalizedOptionLabel(label)}`
}

function lookupCacheKeys(kind: 'control' | 'editable' | 'file', label: string, exact: boolean, fieldId?: string): string[] {
  const keys = [lookupCacheKey(kind, label, exact)]
  if (fieldId) keys.unshift(`${kind}:id:${fieldId}`)
  return keys
}

function cacheMapForKind(cache: FillLookupCache, kind: 'control' | 'editable' | 'file'): Map<string, Locator | null> {
  if (kind === 'control') return cache.control
  if (kind === 'editable') return cache.editable
  return cache.fileInput
}

function readCachedLocator(
  cache: FillLookupCache | undefined,
  kind: 'control' | 'editable' | 'file',
  label: string,
  exact: boolean,
  fieldId?: string,
): Locator | null | undefined {
  if (!cache) return undefined
  const map = cacheMapForKind(cache, kind)
  for (const key of lookupCacheKeys(kind, label, exact, fieldId)) {
    if (map.has(key)) return map.get(key) ?? null
  }
  return undefined
}

function writeCachedLocator(
  cache: FillLookupCache | undefined,
  kind: 'control' | 'editable' | 'file',
  label: string,
  exact: boolean,
  fieldId: string | undefined,
  locator: Locator | null,
): void {
  if (!cache) return
  const map = cacheMapForKind(cache, kind)
  for (const key of lookupCacheKeys(kind, label, exact, fieldId)) {
    map.set(key, locator)
  }
}

function normalizedOptionLabel(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[＋﹢∔]/g, '+')
    .replace(/[‐‑‒–—―]/g, '-')
    .replace(/&/g, ' and ')
    .replace(/\bplus\b/g, '+')
    .replace(/[,/()]+/g, ' ')
    .replace(/\s*\+\s*/g, '+')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

function prefersGroupedChoiceValue(value: string): boolean {
  const normalized = normalizedOptionLabel(value)
  return normalized === 'yes' ||
    normalized === 'no' ||
    normalized === 'true' ||
    normalized === 'false' ||
    normalized === 'decline' ||
    normalized === 'prefer not' ||
    normalized === 'opt out'
}

function semanticSelectionAliases(value: string): string[] {
  const normalized = normalizedOptionLabel(value)
  const aliases = new Set<string>([normalized])
  if (normalized === 'yes' || normalized === 'true') {
    for (const alias of ['agree', 'agreed', 'accept', 'accepted', 'consent', 'acknowledge', 'read', 'opt in']) {
      aliases.add(alias)
    }
  }
  if (normalized === 'no' || normalized === 'false') {
    for (const alias of ['decline', 'declined', 'disagree', 'deny', 'opt out', 'prefer not']) {
      aliases.add(alias)
    }
  }
  if (normalized === 'decline') {
    for (const alias of ['prefer not', 'opt out', 'do not']) {
      aliases.add(alias)
    }
  }
  if (normalized === 'atx' || normalized.includes('austin')) {
    for (const alias of ['atx', 'austin', 'austin tx', 'austin texas']) aliases.add(alias)
  }
  if (normalized === 'nyc' || normalized.includes('new york')) {
    for (const alias of ['nyc', 'new york', 'new york ny']) aliases.add(alias)
  }
  if (normalized === 'sf' || normalized.includes('san francisco')) {
    for (const alias of ['sf', 'san francisco', 'san francisco ca']) aliases.add(alias)
  }
  if (normalized === 'la' || normalized.includes('los angeles')) {
    for (const alias of ['la', 'los angeles', 'los angeles ca']) aliases.add(alias)
  }
  if (normalized === 'dc' || normalized.includes('washington dc')) {
    for (const alias of ['dc', 'washington dc', 'washington d c']) aliases.add(alias)
  }
  if (normalized === 'us' || normalized === 'usa' || normalized.includes('united states')) {
    for (const alias of ['us', 'usa', 'united states']) aliases.add(alias)
  }
  return [...aliases]
}

function hasNegativeSelectionCue(value: string): boolean {
  return /\b(no|not|do not|don't|decline|disagree|deny|opt out|prefer not)\b/.test(value)
}

function hasPositiveSelectionCue(value: string): boolean {
  return /\b(yes|agree|accept|consent|acknowledge|opt in|allow|read)\b/.test(value)
}

function selectionMatchScore(candidate: string | undefined, expected: string, exact: boolean): number | null {
  if (!candidate) return null
  const normalizedCandidate = normalizedOptionLabel(candidate)
  const normalizedExpected = normalizedOptionLabel(expected)
  if (!normalizedCandidate || !normalizedExpected) return null
  const expectsPositive = normalizedExpected === 'yes' || normalizedExpected === 'true'
  const expectsNegative = normalizedExpected === 'no' || normalizedExpected === 'false' || normalizedExpected === 'decline'
  if (exact) return normalizedCandidate === normalizedExpected ? 0 : null
  if (normalizedCandidate === normalizedExpected) return 0
  if (normalizedCandidate.includes(normalizedExpected)) return normalizedCandidate.length - normalizedExpected.length
  if (expectsPositive && hasNegativeSelectionCue(normalizedCandidate)) return null
  if (expectsNegative && hasPositiveSelectionCue(normalizedCandidate)) return null

  const aliases = semanticSelectionAliases(normalizedExpected)
  for (const alias of aliases) {
    if (alias !== normalizedExpected && normalizedCandidate.includes(alias)) {
      return 40 + normalizedCandidate.length - alias.length
    }
  }

  const tokens = normalizedExpected.split(' ').filter(token => token.length >= 3)
  if (tokens.length >= 2) {
    const matchedTokens = tokens.filter(token => normalizedCandidate.includes(token))
    if (matchedTokens.length >= Math.min(2, tokens.length)) {
      return 80 + (tokens.length - matchedTokens.length) * 10
    }
  }

  return null
}

function distanceFromPreferredAnchor(
  box: { x: number; y: number; width: number; height: number },
  anchor?: AnchorPoint,
): number {
  if (anchor?.x === undefined && anchor?.y === undefined) return 0
  const centerX = box.x + box.width / 2
  const centerY = box.y + box.height / 2
  return Math.abs(centerX - (anchor?.x ?? centerX)) + Math.abs(centerY - (anchor?.y ?? centerY))
}

function browserDisplayedValues(el: Element): string[] {
  const values = new Set<string>()
  const push = (value: string | undefined) => {
    const trimmed = value?.trim()
    if (trimmed && trimmed.length <= 240) values.add(trimmed)
  }
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    push(el.value)
    push(el.getAttribute('aria-valuetext') ?? undefined)
    push(el.getAttribute('aria-label') ?? undefined)
  }
  if (el instanceof HTMLSelectElement) {
    push(el.selectedOptions[0]?.textContent ?? undefined)
    push(el.value)
  }
  push(el.getAttribute('aria-valuetext') ?? undefined)
  push(el.getAttribute('aria-label') ?? undefined)
  push(el.textContent ?? undefined)

  // If the element itself is combobox-like, broaden the search: any custom dropdown that
  // displays its committed value in a *sibling* element (very common in React-Select,
  // Headless UI, Radix, Greenhouse, etc.) needs us to read text from the surrounding
  // wrapper. We can't assume the wrapper has a recognizable class, so we trust the
  // ARIA role/attributes on the trigger itself as the signal.
  const elIsComboboxLike =
    el.getAttribute('role') === 'combobox' ||
    el.getAttribute('aria-haspopup') === 'listbox' ||
    el.getAttribute('aria-haspopup') === 'menu' ||
    el.hasAttribute('aria-controls') ||
    el.hasAttribute('aria-owns') ||
    el.hasAttribute('aria-expanded')

  let current = el.parentElement
  for (let depth = 0; current && depth < 4; depth++) {
    const role = current.getAttribute('role')
    if (role === 'listbox' || role === 'menu') {
      current = current.parentElement
      continue
    }
    const className = typeof current.className === 'string' ? current.className.toLowerCase() : ''
    const looksLikeFieldContainer =
      role === 'combobox' ||
      current.getAttribute('aria-haspopup') === 'listbox' ||
      current.tagName.toLowerCase() === 'button' ||
      className.includes('select') ||
      className.includes('combo') ||
      className.includes('chip')
    if (looksLikeFieldContainer || elIsComboboxLike) push(current.textContent ?? undefined)
    current = current.parentElement
  }

  // Even when the parent walk doesn't find a recognizable container, look for an immediate
  // sibling with displayed text. Custom selects routinely render
  // `<input role="combobox" /><span class="single-value">Selected</span>` inside a wrapper
  // that has no helpful class or role.
  if (elIsComboboxLike && el.parentElement) {
    for (const sibling of Array.from(el.parentElement.children)) {
      if (sibling === el) continue
      if (sibling instanceof HTMLElement) {
        const role = sibling.getAttribute('role')
        if (role === 'listbox' || role === 'menu' || role === 'dialog') continue
        push(sibling.textContent ?? undefined)
      }
    }
  }

  return [...values]
}

async function firstVisible(
  locator: Locator,
  opts?: {
    minWidth?: number
    minHeight?: number
    maxCandidates?: number
    fallbackToAnyVisible?: boolean
    preferredAnchor?: AnchorPoint
  },
): Promise<Locator | null> {
  try {
    const count = Math.min(await locator.count(), opts?.maxCandidates ?? 8)
    let bestVisible: { locator: Locator; score: number } | null = null
    let bestQualified: { locator: Locator; score: number } | null = null
    for (let i = 0; i < count; i++) {
      const candidate = locator.nth(i)
      if (!(await candidate.isVisible())) continue
      const box = await candidate.boundingBox()
      if (!box) continue
      const score = distanceFromPreferredAnchor(box, opts?.preferredAnchor)
      if (!bestVisible || score < bestVisible.score) {
        bestVisible = { locator: candidate, score }
      }
      if ((opts?.minWidth ?? 0) <= box.width && (opts?.minHeight ?? 0) <= box.height) {
        if (!bestQualified || score < bestQualified.score) {
          bestQualified = { locator: candidate, score }
        }
      }
    }
    if (bestQualified) return bestQualified.locator
    return opts?.fallbackToAnyVisible === false ? null : bestVisible?.locator ?? null
  } catch {
    /* ignore */
  }
  return null
}

async function locatorIsEditable(locator: Locator): Promise<boolean> {
  try {
    return await locator.evaluate((el) => {
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return true
      return el instanceof HTMLElement && el.isContentEditable
    })
  } catch {
    return false
  }
}

async function locatorAnchorY(locator: Locator): Promise<number | undefined> {
  const bounds = await locator.boundingBox()
  return bounds ? bounds.y + bounds.height / 2 : undefined
}

async function resolveMeaningfulClickTarget(
  locator: Locator,
): Promise<{ handle: ElementHandle<Element> | null; anchorX?: number; anchorY?: number }> {
  const baseHandle = await locator.elementHandle()
  if (!baseHandle) return { handle: null }

  const targetHandle = (await baseHandle.evaluateHandle((el) => {
    function isTextLikeControl(node: Element): boolean {
      if (node instanceof HTMLTextAreaElement || node instanceof HTMLSelectElement) return true
      if (node instanceof HTMLInputElement) {
        return !['checkbox', 'radio', 'file', 'button', 'submit', 'reset', 'hidden', 'range', 'color'].includes(node.type)
      }
      const role = node.getAttribute('role')
      return role === 'textbox' || role === 'combobox'
    }

    function visible(node: Element): node is HTMLElement {
      if (!(node instanceof HTMLElement)) return false
      const rect = node.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) return false
      const style = getComputedStyle(node)
      return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0'
    }

    if (!(el instanceof HTMLElement)) return el
    const rect = el.getBoundingClientRect()
    if (!isTextLikeControl(el) || (rect.width >= 48 && rect.height >= 18)) return el

    let best: HTMLElement = el
    let bestScore = Number.POSITIVE_INFINITY
    let current = el.parentElement
    let depth = 0

    while (current && depth < 6) {
      if (visible(current)) {
        const candidate = current.getBoundingClientRect()
        const className = typeof current.className === 'string' ? current.className.toLowerCase() : ''
        const role = current.getAttribute('role')
        const looksLikeControl =
          role === 'combobox' ||
          role === 'button' ||
          current.getAttribute('aria-haspopup') === 'listbox' ||
          className.includes('control') ||
          className.includes('select') ||
          className.includes('combo') ||
          className.includes('input')

        if (
          candidate.width >= rect.width &&
          candidate.height >= rect.height &&
          candidate.width > 0 &&
          candidate.height > 0 &&
          candidate.width <= window.innerWidth * 0.98 &&
          candidate.height <= Math.max(window.innerHeight * 0.9, 320) &&
          (candidate.width >= 48 || candidate.height >= 18)
        ) {
          const score = candidate.width * candidate.height + depth * 1000 - (looksLikeControl ? 20000 : 0)
          if (score < bestScore) {
            best = current
            bestScore = score
          }
        }
      }
      current = current.parentElement
      depth++
    }

    return best
  })) as ElementHandle<Element>

  const bounds = await targetHandle.boundingBox()
  return {
    handle: targetHandle,
    anchorX: bounds ? bounds.x + bounds.width / 2 : undefined,
    anchorY: bounds ? bounds.y + bounds.height / 2 : undefined,
  }
}

async function findLabeledControl(
  frame: Frame,
  fieldLabel: string,
  exact: boolean,
  opts?: { preferredAnchor?: AnchorPoint },
): Promise<Locator | null> {
  // Always try exact-match candidates first, even when the caller passed
  // exact=false. A common Greenhouse-style failure: filling a "Country"
  // field with exact=false matches an unrelated combobox whose label
  // happens to contain the word "country" (e.g.
  // "Are you legally authorized to work in the country in which you are
  // applying?"). The exact-match pass only succeeds when a label equals
  // the search term, so it never picks the wrong control. We only fall
  // through to substring matching when no exact match exists.
  const exactCandidates = [
    frame.getByLabel(fieldLabel, { exact: true }),
    frame.getByPlaceholder(fieldLabel, { exact: true }),
    frame.getByRole('combobox', { name: fieldLabel, exact: true }),
    frame.getByRole('textbox', { name: fieldLabel, exact: true }),
    frame.getByRole('button', { name: fieldLabel, exact: true }),
  ]

  for (const candidate of exactCandidates) {
    const visible = await firstVisible(candidate, { preferredAnchor: opts?.preferredAnchor })
    if (visible) return visible
  }

  // For exact=false callers, also try the substring matching that Playwright
  // exposes via `getByLabel({ exact: false })`. We do this after the exact
  // pass so an unrelated label that contains the search string doesn't win
  // over the actual target. exact=true callers skip this entirely; their
  // fallback is the manual scoring loop below (which honors payload.exact).
  if (!exact) {
    const directCandidates = [
      frame.getByLabel(fieldLabel, { exact: false }),
      frame.getByPlaceholder(fieldLabel, { exact: false }),
      frame.getByRole('combobox', { name: fieldLabel, exact: false }),
      frame.getByRole('textbox', { name: fieldLabel, exact: false }),
      frame.getByRole('button', { name: fieldLabel, exact: false }),
    ]
    for (const candidate of directCandidates) {
      const visible = await firstVisible(candidate, { preferredAnchor: opts?.preferredAnchor })
      if (visible) return visible
    }
  }

  const fallbackCandidates = frame.locator(LABELED_CONTROL_SELECTOR)
  const count = await fallbackCandidates.count()
  if (count === 0) return null

  const bestIndex = await fallbackCandidates.evaluateAll((elements, payload) => {
    function normalize(value: string): string {
      return value.replace(/\s+/g, ' ').trim().toLowerCase()
    }

    function matches(candidate: string | undefined): boolean {
      if (!candidate) return false
      const normalizedCandidate = normalize(candidate)
      const normalizedExpected = normalize(payload.fieldLabel)
      if (!normalizedCandidate || !normalizedExpected) return false
      return payload.exact ? normalizedCandidate === normalizedExpected : normalizedCandidate.includes(normalizedExpected)
    }

    function visible(el: Element): el is HTMLElement {
      if (!(el instanceof HTMLElement)) return false
      const rect = el.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) return false
      const style = getComputedStyle(el)
      return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0'
    }

    function referencedText(ids: string | null, visited?: Set<string>): string | undefined {
      if (!ids) return undefined
      const seen = visited ?? new Set<string>()
      const text = ids
        .split(/\s+/)
        .map(id => {
          if (seen.has(id)) return ''
          seen.add(id)
          const target = document.getElementById(id)
          if (!target) return ''
          const chained = target.getAttribute('aria-labelledby')
          if (chained) return referencedText(chained, seen) ?? ''
          return target.textContent?.trim() ?? ''
        })
        .filter(Boolean)
        .join(' ')
        .trim()
      return text || undefined
    }

    function explicitLabelText(el: Element): string | undefined {
      const aria = el.getAttribute('aria-label')?.trim()
      if (aria) return aria
      const labelledBy = referencedText(el.getAttribute('aria-labelledby'))
      if (labelledBy) return labelledBy
      if (
        (el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) &&
        el.labels &&
        el.labels.length > 0
      ) {
        return el.labels[0]?.textContent?.trim() || undefined
      }
      if (el instanceof HTMLElement && el.id) {
        const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`)
        const text = label?.textContent?.trim()
        if (text) return text
      }
      if (el.parentElement?.tagName.toLowerCase() === 'label') {
        const text = el.parentElement.textContent?.trim()
        if (text) return text
      }
      if (
        (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) &&
        !['checkbox', 'radio', 'file', 'button', 'submit', 'reset', 'hidden'].includes(el instanceof HTMLInputElement ? el.type : '')
      ) {
        const placeholder = el.getAttribute('aria-placeholder')?.trim() || el.getAttribute('placeholder')?.trim()
        if (placeholder) return placeholder
      }
      if (el instanceof HTMLInputElement && ['button', 'submit', 'reset'].includes(el.type)) {
        const value = el.value?.trim()
        if (value) return value
      }
      const title = el.getAttribute('title')?.trim()
      if (title) return title
      return undefined
    }

    function controlPriority(el: Element): number {
      const rect = el.getBoundingClientRect()
      const sizePenalty = rect.width < 48 || rect.height < 18 ? 180 : 0
      if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) {
        return sizePenalty
      }
      const role = el.getAttribute('role')
      if (role === 'combobox' || role === 'textbox') return 4 + sizePenalty
      if (el.getAttribute('aria-haspopup') === 'listbox') return 8 + sizePenalty
      if (el.tagName.toLowerCase() === 'button') return 12 + sizePenalty
      return 24 + sizePenalty
    }

    const labelNodes = Array.from(document.querySelectorAll('label, legend')).filter((el): el is HTMLElement => visible(el))

    let best: { index: number; score: number } | null = null
    for (let i = 0; i < elements.length; i++) {
      const el = elements[i]
      if (!(el instanceof Element)) continue
      if (!visible(el)) continue
      const rect = el.getBoundingClientRect()

      const explicit = explicitLabelText(el)
      if (matches(explicit)) {
        const centerX = rect.left + rect.width / 2
        const centerY = rect.top + rect.height / 2
        const anchorDistance =
          payload.anchorX === null && payload.anchorY === null
            ? 0
            : Math.abs(centerX - (payload.anchorX ?? centerX)) + Math.abs(centerY - (payload.anchorY ?? centerY))
        const score = controlPriority(el) + anchorDistance / 8
        if (!best || score < best.score) best = { index: i, score }
        continue
      }

      for (const labelNode of labelNodes) {
        const labelText = labelNode.textContent?.trim()
        if (!matches(labelText)) continue

        const labelRect = labelNode.getBoundingClientRect()
        const horizontalOverlap = Math.min(rect.right, labelRect.right) - Math.max(rect.left, labelRect.left)
        const horizontalDistance =
          horizontalOverlap >= 0
            ? 0
            : Math.min(Math.abs(rect.left - labelRect.right), Math.abs(labelRect.left - rect.right))
        const verticalDistance =
          rect.top >= labelRect.bottom - 12
            ? rect.top - labelRect.bottom
            : 200 + Math.abs(rect.top - labelRect.top)
        const centerX = rect.left + rect.width / 2
        const centerY = rect.top + rect.height / 2
        const anchorDistance =
          payload.anchorX === null && payload.anchorY === null
            ? 0
            : Math.abs(centerX - (payload.anchorX ?? centerX)) + Math.abs(centerY - (payload.anchorY ?? centerY))
        const score = 100 + verticalDistance * 3 + horizontalDistance + anchorDistance / 8 + controlPriority(el)
        if (!best || score < best.score) best = { index: i, score }
      }
    }

    return best?.index ?? -1
  }, {
    fieldLabel,
    exact,
    anchorX: opts?.preferredAnchor?.x ?? null,
    anchorY: opts?.preferredAnchor?.y ?? null,
  })

  return bestIndex >= 0 ? fallbackCandidates.nth(bestIndex) : null
}

/**
 * Strip a trailing ellipsis (Unicode U+2026 or "...") plus any whitespace
 * before it. Geometra's form schemas truncate long labels to ~80 chars and
 * mark the truncation with an ellipsis — but the actual DOM label has the
 * full text. Substring-matching the truncated version against the full DOM
 * text would fail unless we strip the ellipsis first, leaving the prefix
 * which IS a real substring of the DOM label.
 *
 * Returns the original label unchanged when no ellipsis is present.
 */
function stripTruncationEllipsis(label: string): string {
  // Match either Unicode horizontal ellipsis (U+2026) or three ASCII dots,
  // optionally preceded by whitespace, anchored at the end.
  return label.replace(/\s*(?:\u2026|\.\.\.)\s*$/u, '').trimEnd()
}

/**
 * Locate a menu-trigger button whose container-level label matches `fieldLabel`.
 *
 * Motivating case: GitHub Primer (and similar design systems) renders a
 * dropdown as `<label>Ref type</label><button aria-haspopup="menu">Branch</button>`
 * where the button's accessible name is the *current value* ("Branch"), not
 * the field name. Playwright's `getByRole('button', { name: 'Ref type' })`
 * therefore misses the trigger, and the existing `<label>/<legend>` proximity
 * scan doesn't match either because the visible label is a plain `<span>` /
 * `<div>` rather than a `<label>` element.
 *
 * This helper broadens the label search to any visible element whose text
 * (minus the button's own text) matches the field name, then returns the
 * menu-trigger button inside that container. It complements `findLabeledControl`
 * rather than replacing it — the scan is restricted to menu-trigger buttons
 * so it can't shadow existing combobox / textbox / native-select matches.
 */
async function findMenuTriggerByContainerLabel(
  frame: Frame,
  fieldLabel: string,
  exact: boolean,
): Promise<Locator | null> {
  const triggers = frame.locator(MENU_TRIGGER_SELECTOR)
  const count = await triggers.count()
  if (count === 0) return null

  const bestIndex = await triggers.evaluateAll((elements, payload) => {
    function normalize(value: string): string {
      return value.replace(/\s+/g, ' ').trim().toLowerCase()
    }

    function stripTrailingColon(value: string): string {
      return value.replace(/\s*:\s*$/u, '').trim()
    }

    function matches(candidate: string | undefined): boolean {
      if (!candidate) return false
      const normalizedCandidate = normalize(stripTrailingColon(candidate))
      const normalizedExpected = normalize(payload.fieldLabel)
      if (!normalizedCandidate || !normalizedExpected) return false
      return payload.exact
        ? normalizedCandidate === normalizedExpected
        : normalizedCandidate.includes(normalizedExpected)
    }

    function visible(el: Element): boolean {
      if (!(el instanceof HTMLElement)) return false
      const rect = el.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) return false
      const style = getComputedStyle(el)
      return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0'
    }

    function containerLabelText(el: Element): string | undefined {
      // Walk up a few parent levels looking for a container that holds BOTH
      // the trigger and some sibling label text. The label text is the
      // container's visible text minus the trigger's own text.
      let container: Element | null = el.parentElement
      let depth = 0
      const triggerText = el.textContent?.trim() ?? ''
      while (container && depth < 4) {
        const containerText = container.textContent?.trim() ?? ''
        if (containerText && containerText.length < 240) {
          const residual = triggerText && containerText.endsWith(triggerText)
            ? containerText.slice(0, containerText.length - triggerText.length).trim()
            : triggerText && containerText.includes(triggerText)
              ? containerText.split(triggerText)[0]?.trim() ?? ''
              : containerText
          if (residual && residual.length > 0 && residual.length < 120) {
            return residual
          }
        }
        container = container.parentElement
        depth++
      }
      return undefined
    }

    let best: { index: number; score: number } | null = null
    for (let i = 0; i < elements.length; i++) {
      const el = elements[i]
      if (!(el instanceof HTMLElement)) continue
      if (!visible(el)) continue

      const aria = el.getAttribute('aria-label')?.trim()
      if (matches(aria)) {
        const score = 0
        if (!best || score < best.score) best = { index: i, score }
        continue
      }

      const labelledBy = el.getAttribute('aria-labelledby')
      if (labelledBy) {
        const text = labelledBy
          .split(/\s+/)
          .map(id => document.getElementById(id)?.textContent?.trim() ?? '')
          .filter(Boolean)
          .join(' ')
          .trim()
        if (matches(text)) {
          const score = 10
          if (!best || score < best.score) best = { index: i, score }
          continue
        }
      }

      const container = containerLabelText(el)
      if (matches(container)) {
        const rect = el.getBoundingClientRect()
        const sizePenalty = rect.width < 48 || rect.height < 18 ? 120 : 0
        const score = 100 + sizePenalty
        if (!best || score < best.score) best = { index: i, score }
      }
    }

    return best?.index ?? -1
  }, { fieldLabel, exact })

  return bestIndex >= 0 ? triggers.nth(bestIndex) : null
}

async function findLabeledControlInPage(
  page: Page,
  fieldLabel: string,
  exact: boolean,
  opts?: { preferredAnchor?: AnchorPoint; cache?: FillLookupCache; fieldId?: string },
): Promise<Locator | null> {
  const cacheable = !opts?.preferredAnchor
  const cached = cacheable ? readCachedLocator(opts?.cache, 'control', fieldLabel, exact, opts?.fieldId) : undefined
  if (cached !== undefined) {
    return cached
  }

  // Try the label as-is first. If the caller passed a fully-qualified DOM
  // label, that's the most accurate match.
  for (const frame of page.frames()) {
    const locator = await findLabeledControl(frame, fieldLabel, exact, { preferredAnchor: opts?.preferredAnchor })
    if (!locator) continue
    if (cacheable) writeCachedLocator(opts?.cache, 'control', fieldLabel, exact, opts?.fieldId, locator)
    return locator
  }

  // Fallback: if the label looks truncated (ends in U+2026 or "..."), strip
  // the truncation marker and retry. This is the recovery path for callers
  // that pass schema-truncated labels — geometra_form_schema returns labels
  // truncated to ~80 chars with U+2026, and substring-matching against full
  // DOM text only works after the ellipsis is removed. Exact matches are
  // skipped because exact=true callers presumably have the full label.
  const stripped = stripTruncationEllipsis(fieldLabel)
  if (!exact && stripped !== fieldLabel && stripped.length > 0) {
    for (const frame of page.frames()) {
      const locator = await findLabeledControl(frame, stripped, exact, { preferredAnchor: opts?.preferredAnchor })
      if (!locator) continue
      if (cacheable) writeCachedLocator(opts?.cache, 'control', fieldLabel, exact, opts?.fieldId, locator)
      return locator
    }
  }

  // Fallback: menu-trigger buttons whose accessible name is the CURRENT VALUE
  // (e.g. "Branch" for a "Ref type: Branch" GitHub Primer dropdown) rather
  // than the field name. Restricted to aria-haspopup="menu"/"true" triggers
  // so it cannot shadow existing combobox/textbox/native-select matches.
  const candidateLabels = [fieldLabel, stripped].filter((label, index, array) =>
    label && label.length > 0 && array.indexOf(label) === index,
  )
  for (const candidate of candidateLabels) {
    for (const frame of page.frames()) {
      const locator = await findMenuTriggerByContainerLabel(frame, candidate, exact)
      if (!locator) continue
      if (cacheable) writeCachedLocator(opts?.cache, 'control', fieldLabel, exact, opts?.fieldId, locator)
      return locator
    }
  }

  if (cacheable) writeCachedLocator(opts?.cache, 'control', fieldLabel, exact, opts?.fieldId, null)
  return null
}

function textMatches(candidate: string | undefined, expected: string, exact: boolean): boolean {
  return selectionMatchScore(candidate, expected, exact) !== null
}

function displayedValueMatchesSelection(
  candidate: string | undefined,
  expected: string,
  exact: boolean,
  selectedOptionText?: string,
): boolean {
  if (textMatches(candidate, expected, exact)) return true
  if (!candidate || !selectedOptionText || exact) return false

  const normalizedCandidate = normalizedOptionLabel(candidate)
  const normalizedSelectedOption = normalizedOptionLabel(selectedOptionText)
  if (!normalizedCandidate || normalizedCandidate.length < 2 || !normalizedSelectedOption) return false

  return (
    normalizedSelectedOption.includes(normalizedCandidate) || normalizedCandidate.includes(normalizedSelectedOption)
  )
}

async function openDropdownControl(
  page: Page,
  fieldLabel: string,
  exact: boolean,
  cache?: FillLookupCache,
  fieldId?: string,
): Promise<{ locator: Locator; handle: ElementHandle<Element> | null; editable: boolean; anchorX?: number; anchorY?: number }> {
  const locator = await findLabeledControlInPage(page, fieldLabel, exact, { cache, fieldId })
  if (locator) {
    await locator.scrollIntoViewIfNeeded()
    const handle = await locator.elementHandle()
    const clickTarget = await resolveMeaningfulClickTarget(locator)
    const editable = await locatorIsEditable(locator)
    if (clickTarget.handle) {
      await clickTarget.handle.scrollIntoViewIfNeeded()
      await clickTarget.handle.click()
    } else {
      await locator.click()
    }

    // Wait for options to render (React comboboxes may load async).
    // Only poll if no popup content is visible yet — avoids adding latency when
    // the dropdown already expanded synchronously.
    const initialOptionCount = await page.locator('[role="option"]').count()
    if (initialOptionCount === 0) {
      const optionDeadline = Date.now() + 1000
      while (Date.now() < optionDeadline) {
        const count = await page.locator('[role="option"]').count()
        if (count > 0) break
        const listboxCount = await page.locator('[role="listbox"] > *').count()
        if (listboxCount > 0) break
        await delay(50)
      }
    }

    return {
      locator,
      handle,
      editable,
      anchorX: clickTarget.anchorX,
      anchorY: clickTarget.anchorY ?? await locatorAnchorY(locator),
    }
  }

  throw new Error(`listboxPick: no visible combobox/dropdown matching field "${fieldLabel}"`)
}

/**
 * Given a freshly-opened dropdown trigger, find the popup container that *belongs* to it.
 *
 * Resolution strategy (in order):
 *   1. Walk `aria-controls`, `aria-owns`, `aria-activedescendant`, and parent versions of those
 *      attributes to a real element id. The element (or its closest popup ancestor) is the answer.
 *   2. Look for a sibling/descendant popup inside the trigger's nearest field container.
 *   3. Fall back to the visible popup that is closest to (and below) the trigger.
 *
 * Returning a scoped popup handle lets the rest of the option-search pipeline restrict its
 * lookups to descendants of one popup, instead of scanning every popup on the page. That is the
 * single most important fix for forms with multiple comboboxes that share option labels (Yes/No,
 * country lists, etc.) — common in Greenhouse / Workday / Ashby application flows.
 */
async function resolveOwnedPopupHandle(
  triggerHandle: ElementHandle<Element> | null | undefined,
): Promise<ElementHandle<Element> | null> {
  if (!triggerHandle) return null
  try {
    const popup = await triggerHandle.evaluateHandle((el, payload) => {
      function visible(node: Element | null): node is HTMLElement {
        if (!(node instanceof HTMLElement)) return false
        const rect = node.getBoundingClientRect()
        if (rect.width <= 0 || rect.height <= 0) return false
        const style = getComputedStyle(node)
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false
        return true
      }

      function asPopupRoot(node: Element | null): HTMLElement | null {
        if (!node) return null
        if (!(node instanceof HTMLElement)) return null
        if (node.matches(payload.popupRootSelector) && visible(node)) return node
        const ancestor = node.closest(payload.popupRootSelector)
        if (ancestor instanceof HTMLElement && visible(ancestor)) return ancestor
        // Sometimes aria-activedescendant points at an option inside the popup —
        // in which case we want the popup container itself.
        const optionParent = node.closest('[role="listbox"], [role="menu"], [role="dialog"]')
        if (optionParent instanceof HTMLElement && visible(optionParent)) return optionParent
        return null
      }

      function readIdRefs(start: Element | null, attribute: string): string[] {
        const ids: string[] = []
        let cursor: Element | null = start
        let depth = 0
        while (cursor && depth < 4) {
          const value = cursor.getAttribute(attribute)
          if (value) {
            for (const id of value.split(/\s+/)) if (id) ids.push(id)
          }
          cursor = cursor.parentElement
          depth++
        }
        return ids
      }

      function lookupReferenced(): HTMLElement | null {
        const attributes = ['aria-controls', 'aria-owns', 'aria-activedescendant']
        for (const attribute of attributes) {
          for (const id of readIdRefs(el, attribute)) {
            const referenced = document.getElementById(id)
            const popup = asPopupRoot(referenced)
            if (popup) return popup
          }
        }
        return null
      }

      function lookupSibling(): HTMLElement | null {
        // React-Select / Headless UI often render the popup as a sibling of the trigger inside
        // a small wrapper. Walk up a few levels and inspect each container's descendants.
        let container: Element | null = el
        let depth = 0
        while (container && depth < 6) {
          const candidates = container.querySelectorAll(payload.popupRootSelector)
          for (const candidate of candidates) {
            if (candidate === el) continue
            if (el.contains(candidate)) {
              // Popups nested inside the trigger itself are usually decorative
              continue
            }
            if (candidate instanceof HTMLElement && visible(candidate)) {
              return candidate
            }
          }
          container = container.parentElement
          depth++
        }
        return null
      }

      function lookupNearestBelow(): HTMLElement | null {
        const triggerRect = el instanceof HTMLElement ? el.getBoundingClientRect() : null
        if (!triggerRect) return null
        const triggerCenterX = triggerRect.left + triggerRect.width / 2
        const triggerBottom = triggerRect.bottom
        let best: { popup: HTMLElement; score: number } | null = null
        for (const node of Array.from(document.querySelectorAll(payload.popupRootSelector))) {
          if (!(node instanceof HTMLElement)) continue
          if (!visible(node)) continue
          if (node === el || el.contains(node)) continue
          // Skip the page-wide nav/footer that may match popup-ish class names
          const rect = node.getBoundingClientRect()
          if (rect.width <= 0 || rect.height <= 0) continue
          if (rect.width >= window.innerWidth * 0.95 && rect.height >= window.innerHeight * 0.6) continue
          const popupCenterX = rect.left + rect.width / 2
          // Bias for popups directly under the trigger and within the trigger's vertical neighborhood.
          const horizontalDistance = Math.abs(popupCenterX - triggerCenterX)
          const verticalDistance = rect.top >= triggerBottom - 8
            ? rect.top - triggerBottom
            : rect.top < triggerRect.top
              ? (triggerRect.top - rect.top) + 200 // popups above the trigger are unusual; penalize
              : 50
          const offscreenPenalty = rect.bottom < 0 || rect.top > window.innerHeight ? 600 : 0
          const score = horizontalDistance + verticalDistance + offscreenPenalty
          if (!best || score < best.score) best = { popup: node, score }
        }
        if (!best) return null
        // Hard cap: if the closest popup is far away horizontally, it likely belongs to a
        // different control. Don't claim ownership.
        if (best.score > 1200) return null
        return best.popup
      }

      const referenced = lookupReferenced()
      if (referenced) return referenced
      const sibling = lookupSibling()
      if (sibling) return sibling
      return lookupNearestBelow()
    }, { popupRootSelector: '[role="listbox"], [role="menu"], [role="dialog"], [aria-modal="true"], [data-radix-popper-content-wrapper], [class*="menu"], [class*="dropdown"], [class*="popover"], [class*="listbox"], [class*="options"]' })

    const asElement = popup.asElement()
    if (!asElement) {
      await popup.dispose()
      return null
    }
    return asElement as ElementHandle<Element>
  } catch {
    return null
  }
}

async function typeIntoEditableLocator(
  page: Page,
  locator: Locator,
  text: string,
  opts?: { delayMs?: number },
): Promise<void> {
  try {
    await locator.fill(text)
    return
  } catch {
    /* fall through */
  }

  await locator.click()
  const delay = opts?.delayMs
  if (delay !== undefined && delay > 0) {
    await page.keyboard.type(text, { delay })
  } else {
    await page.keyboard.type(text)
  }
}

async function typeIntoActiveEditableElement(page: Page, text: string): Promise<boolean> {
  for (const frame of page.frames()) {
    const editableFocused = await frame.evaluate(() => {
      const active = document.activeElement
      if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
        active.value = ''
        active.dispatchEvent(new Event('input', { bubbles: true }))
        return true
      }
      if (active instanceof HTMLElement && active.isContentEditable) {
        active.textContent = ''
        return true
      }
      return false
    })

    if (editableFocused) {
      await page.keyboard.type(text)
      return true
    }
  }

  return false
}

async function clearEditableLocator(locator: Locator): Promise<boolean> {
  try {
    await locator.fill('')
    return true
  } catch {
    /* fall through */
  }

  try {
    await locator.click()
    await locator.press('ControlOrMeta+A')
    await locator.press('Backspace')
    return true
  } catch {
    return false
  }
}

async function clearActiveEditableElement(page: Page): Promise<boolean> {
  for (const frame of page.frames()) {
    const cleared = await frame.evaluate(() => {
      const active = document.activeElement
      if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
        active.value = ''
        active.dispatchEvent(new Event('input', { bubbles: true }))
        return true
      }
      if (active instanceof HTMLElement && active.isContentEditable) {
        active.textContent = ''
        active.dispatchEvent(new Event('input', { bubbles: true }))
        return true
      }
      return false
    })
    if (cleared) return true
  }
  return false
}

async function resetTypedListboxQuery(page: Page, locator?: Locator): Promise<boolean> {
  if (locator && await clearEditableLocator(locator)) return true
  return clearActiveEditableElement(page)
}

async function resolveMeaningfulOptionClickTarget(locator: Locator): Promise<ElementHandle<Element> | null> {
  const baseHandle = await locator.elementHandle()
  if (!baseHandle) return null

  const targetHandle = (await baseHandle.evaluateHandle((el, payload) => {
    function visible(node: Element): node is HTMLElement {
      if (!(node instanceof HTMLElement)) return false
      const rect = node.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) return false
      const style = getComputedStyle(node)
      return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0'
    }

    function textFor(node: Element): string {
      return node.getAttribute('aria-label')?.trim() || node.textContent?.trim() || ''
    }

    if (!(el instanceof HTMLElement)) return el
    const baseText = textFor(el)
    const popup = el.closest(payload.popupSelector)

    let best: HTMLElement = el
    let bestScore = Number.POSITIVE_INFINITY
    let current: HTMLElement | null = el
    let depth = 0

    while (current && depth < 6) {
      if (visible(current)) {
        const rect = current.getBoundingClientRect()
        const className = typeof current.className === 'string' ? current.className.toLowerCase() : ''
        const role = current.getAttribute('role')
        const tag = current.tagName.toLowerCase()
        const currentText = textFor(current)
        const rowLike =
          role === 'option' ||
          role === 'menuitem' ||
          role === 'treeitem' ||
          tag === 'button' ||
          tag === 'li' ||
          tag === 'label' ||
          current.hasAttribute('data-value') ||
          current.hasAttribute('aria-selected') ||
          current.hasAttribute('aria-checked') ||
          className.includes('option') ||
          className.includes('item') ||
          className.includes('row') ||
          className.includes('menu')
        const textAligned = !!baseText && !!currentText && (currentText === baseText || currentText.includes(baseText))
        const insidePopup = popup ? popup.contains(current) : !!current.closest(payload.popupSelector)
        if ((rowLike || textAligned) && insidePopup) {
          const score =
            rect.width * rect.height +
            depth * 600 -
            (rowLike ? 20_000 : 0) -
            (textAligned ? 8_000 : 0)
          if (score < bestScore) {
            best = current
            bestScore = score
          }
        }
      }
      current = current.parentElement
      depth++
    }

    return best
  }, { popupSelector: POPUP_CONTAINER_SELECTOR })) as ElementHandle<Element>

  return targetHandle
}

async function collectVisibleOptionHints(
  page: Page,
  anchor?: AnchorPoint,
): Promise<{ hasPopup: boolean; options: Array<{ label: string; selected: boolean; highlighted: boolean }> }> {
  const merged = new Map<string, { label: string; selected: boolean; highlighted: boolean; rank: number }>()
  let hasPopup = false

  for (const frame of page.frames()) {
    const snapshot = await frame.evaluate((payload) => {
      function normalize(value: string): string {
        return value
          .normalize('NFKD')
          .replace(/[\u0300-\u036f]/g, '')
          .replace(/[＋﹢∔]/g, '+')
          .replace(/[‐‑‒–—―]/g, '-')
          .replace(/&/g, ' and ')
          .replace(/\bplus\b/g, '+')
          .replace(/[,/()]+/g, ' ')
          .replace(/\s*\+\s*/g, '+')
          .replace(/\s+/g, ' ')
          .trim()
          .toLowerCase()
      }

      function visible(el: Element): el is HTMLElement {
        if (!(el instanceof HTMLElement)) return false
        const rect = el.getBoundingClientRect()
        if (rect.width <= 0 || rect.height <= 0) return false
        const style = getComputedStyle(el)
        return style.display !== 'none' && style.visibility !== 'hidden'
      }

      function labelFor(el: Element): string {
        return el.getAttribute('aria-label')?.trim() || el.textContent?.trim() || ''
      }

      function selected(el: Element): boolean {
        return (
          el.getAttribute('aria-selected') === 'true' ||
          el.getAttribute('aria-checked') === 'true' ||
          el.getAttribute('data-selected') === 'true' ||
          el.getAttribute('data-state') === 'checked' ||
          el.getAttribute('data-state') === 'on'
        )
      }

      function highlighted(el: Element): boolean {
        return (
          el === document.activeElement ||
          el.getAttribute('data-highlighted') === 'true' ||
          el.getAttribute('data-focus') === 'true' ||
          el.getAttribute('data-focused') === 'true' ||
          el.getAttribute('data-hovered') === 'true' ||
          el.getAttribute('data-state') === 'active' ||
          el.getAttribute('aria-current') === 'true'
        )
      }

      const popupRoots = Array.from(document.querySelectorAll(payload.popupSelector)).filter((el): el is HTMLElement => visible(el))
      const rows: Array<{ label: string; selected: boolean; highlighted: boolean; rank: number }> = []
      const seen = new Set<string>()

      for (const popup of popupRoots) {
        const candidates = [popup, ...Array.from(popup.querySelectorAll(payload.optionSelector))]
        for (const el of candidates) {
          if (!(el instanceof Element) || !visible(el)) continue
          const className = typeof (el as HTMLElement).className === 'string' ? (el as HTMLElement).className.toLowerCase() : ''
          const role = el.getAttribute('role')
          const tag = el.tagName.toLowerCase()
          const optionLike =
            role === 'option' ||
            role === 'menuitem' ||
            role === 'treeitem' ||
            tag === 'button' ||
            tag === 'li' ||
            tag === 'label' ||
            el.hasAttribute('data-value') ||
            el.hasAttribute('aria-selected') ||
            el.hasAttribute('aria-checked') ||
            className.includes('option') ||
            className.includes('item') ||
            className.includes('row') ||
            className.includes('menu')
          const label = labelFor(el)
          if (!label || label.length > 180) continue
          if (!optionLike && !popup.contains(el.parentElement)) continue
          const key = normalize(label)
          if (!key || seen.has(key)) continue
          const rect = (el as HTMLElement).getBoundingClientRect()
          const centerX = rect.left + rect.width / 2
          const centerY = rect.top + rect.height / 2
          const distance =
            payload.anchorX === null && payload.anchorY === null
              ? rect.top
              : Math.abs(centerX - (payload.anchorX ?? centerX)) + Math.abs(centerY - (payload.anchorY ?? centerY))
          rows.push({
            label,
            selected: selected(el),
            highlighted: highlighted(el),
            rank: (selected(el) ? -4_000 : 0) + (highlighted(el) ? -2_000 : 0) + distance,
          })
          seen.add(key)
          if (rows.length >= payload.maxOptions * 3) break
        }
      }

      rows.sort((a, b) => a.rank - b.rank || a.label.localeCompare(b.label))
      return {
        hasPopup: popupRoots.length > 0,
        options: rows.slice(0, payload.maxOptions),
      }
    }, {
      popupSelector: POPUP_ROOT_SELECTOR,
      optionSelector: OPTION_PICKER_SELECTOR,
      anchorX: anchor?.x ?? null,
      anchorY: anchor?.y ?? null,
      maxOptions: MAX_VISIBLE_OPTION_HINTS,
    })

    hasPopup ||= snapshot.hasPopup
    for (const option of snapshot.options) {
      const key = normalizedOptionLabel(option.label)
      const existing = merged.get(key)
      const rank = (option.selected ? 0 : 10) + (option.highlighted ? 0 : 5) + merged.size
      if (!existing || rank < existing.rank) {
        merged.set(key, { ...option, rank })
      }
    }
  }

  const options = [...merged.values()]
    .sort((a, b) => a.rank - b.rank || a.label.localeCompare(b.label))
    .slice(0, MAX_VISIBLE_OPTION_HINTS)
    .map(({ label, selected, highlighted }) => ({ label, selected, highlighted }))
  return { hasPopup, options }
}

async function activeListboxOptionLabel(page: Page, anchor?: AnchorPoint): Promise<string | null> {
  for (const frame of page.frames()) {
    const label = await frame.evaluate((payload) => {
      function visible(el: Element): el is HTMLElement {
        if (!(el instanceof HTMLElement)) return false
        const rect = el.getBoundingClientRect()
        if (rect.width <= 0 || rect.height <= 0) return false
        const style = getComputedStyle(el)
        return style.display !== 'none' && style.visibility !== 'hidden'
      }

      function labelFor(el: Element | null): string | null {
        const text = el?.getAttribute('aria-label')?.trim() || el?.textContent?.trim() || ''
        return text || null
      }

      function highlighted(el: Element): boolean {
        return (
          el === document.activeElement ||
          el.getAttribute('data-highlighted') === 'true' ||
          el.getAttribute('data-focus') === 'true' ||
          el.getAttribute('data-focused') === 'true' ||
          el.getAttribute('data-hovered') === 'true' ||
          el.getAttribute('data-state') === 'active' ||
          el.getAttribute('aria-current') === 'true' ||
          el.getAttribute('aria-selected') === 'true'
        )
      }

      const active = document.activeElement
      const activeDescendantId = active?.getAttribute('aria-activedescendant')
      const referenced = activeDescendantId ? document.getElementById(activeDescendantId) : null
      if (referenced && visible(referenced)) return labelFor(referenced)

      const candidates = Array.from(document.querySelectorAll(payload.optionSelector)).filter(el =>
        visible(el) && highlighted(el),
      )
      let best: { label: string; score: number } | null = null
      for (const el of candidates) {
        const label = labelFor(el)
        if (!label) continue
        const rect = (el as HTMLElement).getBoundingClientRect()
        const centerX = rect.left + rect.width / 2
        const centerY = rect.top + rect.height / 2
        const distance =
          payload.anchorX === null && payload.anchorY === null
            ? rect.top
            : Math.abs(centerX - (payload.anchorX ?? centerX)) + Math.abs(centerY - (payload.anchorY ?? centerY))
        if (!best || distance < best.score) best = { label, score: distance }
      }
      return best?.label ?? null
    }, {
      optionSelector: OPTION_PICKER_SELECTOR,
      anchorX: anchor?.x ?? null,
      anchorY: anchor?.y ?? null,
    })

    if (label) return label
  }
  return null
}

async function tryKeyboardSelectVisibleOption(
  page: Page,
  label: string,
  exact: boolean,
  anchor?: AnchorPoint,
  focusLocator?: Locator,
): Promise<string | null> {
  if (focusLocator) {
    try {
      await focusLocator.click()
    } catch {
      /* ignore */
    }
    try {
      await focusLocator.focus()
    } catch {
      /* ignore */
    }
    await delay(40)
  }

  const visible = await collectVisibleOptionHints(page, anchor)
  if (!visible.options.some(option => selectionMatchScore(option.label, label, exact) !== null)) {
    return null
  }

  // Check if the currently active option already matches (e.g. pre-selected country code)
  const alreadyActive = await activeListboxOptionLabel(page, anchor)
  if (alreadyActive && selectionMatchScore(alreadyActive, label, exact) !== null) {
    await page.keyboard.press('Enter')
    return alreadyActive
  }

  // Try the direction most likely to reach the target first.
  // Compare list position: if the target appears after the highlighted option, go down first.
  const highlightedIdx = visible.options.findIndex(o => o.highlighted)
  const targetIdx = visible.options.findIndex(o => selectionMatchScore(o.label, label, exact) !== null)
  const targetBelow = highlightedIdx < 0 || targetIdx < 0 || targetIdx >= highlightedIdx
  const directions: Array<'ArrowDown' | 'ArrowUp'> = targetBelow
    ? ['ArrowDown', 'ArrowUp']
    : ['ArrowUp', 'ArrowDown']

  for (const key of directions) {
    const seen = new Set<string>()
    for (let step = 0; step < LISTBOX_KEYBOARD_FALLBACK_STEPS; step++) {
      await page.keyboard.press(key)
      await delay(50)
      const active = await activeListboxOptionLabel(page, anchor)
      if (!active) continue
      if (selectionMatchScore(active, label, exact) !== null) {
        await page.keyboard.press('Enter')
        return active
      }
      const normalized = normalizedOptionLabel(active)
      if (seen.has(normalized)) break
      seen.add(normalized)
    }
  }

  return null
}

function listboxErrorMessage(opts: {
  reason: 'field_not_found' | 'no_visible_option_match' | 'selection_not_confirmed'
  requestedLabel: string
  fieldLabel?: string
  query?: string
  exact: boolean
  visibleOptions?: Array<{ label: string; selected: boolean; highlighted: boolean }>
  listEmpty?: boolean
  queryReset?: boolean
}): string {
  const visibleOptions = (opts.visibleOptions ?? []).map(option => option.label).slice(0, MAX_VISIBLE_OPTION_HINTS)
  const payload = {
    error: 'listboxPick',
    reason: opts.reason,
    message:
      opts.reason === 'field_not_found'
        ? `listboxPick: no visible combobox/dropdown matching field "${opts.fieldLabel ?? 'unknown'}"`
        : opts.reason === 'selection_not_confirmed'
          ? `listboxPick: selected "${opts.requestedLabel}" but could not confirm it on field "${opts.fieldLabel ?? 'unknown'}"`
          : `listboxPick: no visible option matching "${opts.requestedLabel}"`,
    requestedLabel: opts.requestedLabel,
    ...(opts.fieldLabel ? { fieldLabel: opts.fieldLabel } : {}),
    ...(opts.query ? { query: opts.query } : {}),
    exact: opts.exact,
    ...(opts.listEmpty !== undefined ? { listEmpty: opts.listEmpty } : {}),
    ...(opts.queryReset ? { queryReset: true } : {}),
    visibleOptionCount: visibleOptions.length,
    visibleOptions,
    suggestedAction:
      visibleOptions.length > 0
        ? 'Retry with one of visibleOptions, or pass a shorter query/alias for searchable comboboxes.'
        : opts.listEmpty
          ? 'The list appears empty. Retry after clearing the search query or reopening the dropdown.'
          : 'Open the dropdown first, or retry with fieldLabel so Geometra can anchor to the correct combobox.',
  }
  return JSON.stringify(payload, null, 2)
}

/**
 * Search for an option matching `label` within a single popup container handle and click it.
 * Returns the clicked option's visible text, or null if no candidate matched.
 *
 * This is the popup-scoped variant used by `clickVisibleOptionCandidate` when the caller
 * knows which popup belongs to the trigger. It eliminates cross-combobox confusion that
 * makes generic application forms fail when multiple selects share option labels.
 */
async function clickScopedOptionCandidate(
  popupScope: ElementHandle<Element>,
  label: string,
  exact: boolean,
): Promise<string | null> {
  type ScopedHit = { selector: string; text: string }
  // Initialized to null so the catch path below can fall through into the
  // shared `if (!hit) return null` guard without an extra early return.
  let hit: ScopedHit | null = null
  try {
    hit = await popupScope.evaluate((root, payload): ScopedHit | null => {
      function normalize(value: string): string {
        return value
          .normalize('NFKD')
          .replace(/[\u0300-\u036f]/g, '')
          .replace(/[＋﹢∔]/g, '+')
          .replace(/[‐‑‒–—―]/g, '-')
          .replace(/&/g, ' and ')
          .replace(/\bplus\b/g, '+')
          .replace(/[,/()]+/g, ' ')
          .replace(/\s*\+\s*/g, '+')
          .replace(/\s+/g, ' ')
          .trim()
          .toLowerCase()
      }

      function aliases(value: string): string[] {
        const out = new Set<string>([value])
        if (value === 'yes' || value === 'true') {
          for (const alias of ['agree', 'agreed', 'accept', 'accepted', 'consent', 'acknowledge', 'read', 'opt in']) {
            out.add(alias)
          }
        }
        if (value === 'no' || value === 'false') {
          for (const alias of ['decline', 'declined', 'disagree', 'deny', 'opt out', 'prefer not']) {
            out.add(alias)
          }
        }
        return [...out]
      }

      function hasNegativeCue(value: string): boolean {
        return /\b(no|not|do not|don't|decline|disagree|deny|opt out|prefer not)\b/.test(value)
      }

      function hasPositiveCue(value: string): boolean {
        return /\b(yes|agree|accept|consent|acknowledge|opt in|allow|read)\b/.test(value)
      }

      function matchScore(candidate: string | undefined, expected: string): number | null {
        if (!candidate) return null
        const normalizedCandidate = normalize(candidate)
        const normalizedExpected = normalize(expected)
        if (!normalizedCandidate || !normalizedExpected) return null
        const expectsPositive = normalizedExpected === 'yes' || normalizedExpected === 'true'
        const expectsNegative =
          normalizedExpected === 'no' || normalizedExpected === 'false' || normalizedExpected === 'decline'
        if (payload.exact) return normalizedCandidate === normalizedExpected ? 0 : null
        if (normalizedCandidate === normalizedExpected) return 0
        if (normalizedCandidate.includes(normalizedExpected)) return normalizedCandidate.length - normalizedExpected.length
        if (expectsPositive && hasNegativeCue(normalizedCandidate)) return null
        if (expectsNegative && hasPositiveCue(normalizedCandidate)) return null
        for (const alias of aliases(normalizedExpected)) {
          if (alias !== normalizedExpected && normalizedCandidate.includes(alias)) {
            return 40 + normalizedCandidate.length - alias.length
          }
        }
        return null
      }

      function visible(el: Element | null): el is HTMLElement {
        if (!(el instanceof HTMLElement)) return false
        const rect = el.getBoundingClientRect()
        if (rect.width <= 0 || rect.height <= 0) return false
        const style = getComputedStyle(el)
        return style.display !== 'none' && style.visibility !== 'hidden'
      }

      // Stamp a unique data attribute on the target so we can re-find it from the outer Locator API.
      // This avoids re-running expensive matching logic when we're ready to click.
      function stampAndDescribe(target: HTMLElement): ScopedHit | null {
        const text = target.getAttribute('aria-label')?.trim() || target.textContent?.trim() || ''
        const stamp = `geometra-scoped-${Math.random().toString(36).slice(2, 10)}`
        target.setAttribute('data-geometra-scoped-pick', stamp)
        return { selector: `[data-geometra-scoped-pick="${stamp}"]`, text }
      }

      const optionSelector = [
        '[role="option"]',
        '[role="menuitem"]',
        '[role="treeitem"]',
        'button',
        'li',
        '[data-value]',
        '[aria-selected]',
        '[aria-checked]',
        '[class*="option"]',
        '[class*="menu-item"]',
        '[class*="dropdown-item"]',
        '[class*="listbox-option"]',
      ].join(', ')

      // Make sure the popup itself is visible. If it's been collapsed since open, bail.
      if (!visible(root)) return null

      const candidates = Array.from(root.querySelectorAll(optionSelector)).filter(visible)
      let best: { el: HTMLElement; score: number } | null = null
      for (const candidate of candidates) {
        const text = candidate.getAttribute('aria-label')?.trim() || candidate.textContent?.trim() || ''
        const score = matchScore(text, payload.label)
        if (score === null) continue
        if (!best || score < best.score) best = { el: candidate, score }
      }
      if (!best) return null
      return stampAndDescribe(best.el)
    }, { label, exact })
  } catch {
    // Leave hit as null and let the shared guard below handle the bail.
  }
  if (!hit) return null

  // Re-find the stamped element via the popup handle and click it.
  try {
    const target = (await popupScope.evaluateHandle((root, selector) => {
      const found = (root as Element).querySelector(selector)
      return found ?? null
    }, hit.selector)).asElement() as ElementHandle<Element> | null
    if (!target) return null
    try {
      await target.scrollIntoViewIfNeeded({ timeout: 500 })
    } catch {
      /* popups inside their own scroll container handle this internally */
    }
    try {
      await target.click()
    } catch {
      return null
    }
    // Clean up the marker so we don't pollute the page state for inspectors.
    try {
      await target.evaluate(el => el.removeAttribute('data-geometra-scoped-pick'))
    } catch { /* element may have been removed by the click handler */ }
    return hit.text || null
  } catch {
    return null
  }
}

async function clickVisibleOptionCandidate(
  page: Page,
  label: string,
  exact: boolean,
  anchor?: AnchorPoint,
  popupScope?: ElementHandle<Element> | null,
): Promise<string | null> {
  // When we know which popup the trigger owns, restrict the search to that popup's
  // descendants. This prevents an option from a sibling combobox's stale popup from
  // being clicked when multiple comboboxes share option labels (Yes/No, country lists, etc.).
  if (popupScope) {
    const scoped = await clickScopedOptionCandidate(popupScope, label, exact)
    if (scoped !== null) return scoped
    // Fall through to the global search only if the scoped popup didn't contain a match.
    // This is a defensive fallback for forms where the popup root resolution missed the
    // real listbox (rare in practice).
  }

  for (const frame of page.frames()) {
    const candidates = frame.locator(OPTION_PICKER_SELECTOR)
    const count = await candidates.count()
    if (count === 0) continue

    const bestIndex = await candidates.evaluateAll((elements, payload) => {
      function normalize(value: string): string {
        return value
          .normalize('NFKD')
          .replace(/[\u0300-\u036f]/g, '')
          .replace(/[＋﹢∔]/g, '+')
          .replace(/[‐‑‒–—―]/g, '-')
          .replace(/&/g, ' and ')
          .replace(/\bplus\b/g, '+')
          .replace(/[,/()]+/g, ' ')
          .replace(/\s*\+\s*/g, '+')
          .replace(/\s+/g, ' ')
          .trim()
          .toLowerCase()
      }

      function aliases(value: string): string[] {
        const out = new Set<string>([value])
        if (value === 'yes' || value === 'true') {
          for (const alias of ['agree', 'agreed', 'accept', 'accepted', 'consent', 'acknowledge', 'read', 'opt in']) {
            out.add(alias)
          }
        }
        if (value === 'no' || value === 'false') {
          for (const alias of ['decline', 'declined', 'disagree', 'deny', 'opt out', 'prefer not']) {
            out.add(alias)
          }
        }
        if (value === 'decline') {
          for (const alias of ['prefer not', 'opt out', 'do not']) {
            out.add(alias)
          }
        }
        if (value === 'atx' || value.includes('austin')) {
          for (const alias of ['atx', 'austin', 'austin tx', 'austin texas']) out.add(alias)
        }
        if (value === 'nyc' || value.includes('new york')) {
          for (const alias of ['nyc', 'new york', 'new york ny']) out.add(alias)
        }
        if (value === 'sf' || value.includes('san francisco')) {
          for (const alias of ['sf', 'san francisco', 'san francisco ca']) out.add(alias)
        }
        if (value === 'la' || value.includes('los angeles')) {
          for (const alias of ['la', 'los angeles', 'los angeles ca']) out.add(alias)
        }
        if (value === 'dc' || value.includes('washington dc')) {
          for (const alias of ['dc', 'washington dc', 'washington d c']) out.add(alias)
        }
        if (value === 'us' || value === 'usa' || value.includes('united states')) {
          for (const alias of ['us', 'usa', 'united states']) out.add(alias)
        }
        return [...out]
      }

      function hasNegativeCue(value: string): boolean {
        return /\b(no|not|do not|don't|decline|disagree|deny|opt out|prefer not)\b/.test(value)
      }

      function hasPositiveCue(value: string): boolean {
        return /\b(yes|agree|accept|consent|acknowledge|opt in|allow|read)\b/.test(value)
      }

      function matchScore(candidate: string | undefined): number | null {
        if (!candidate) return null
        const normalizedCandidate = normalize(candidate)
        const normalizedExpected = normalize(payload.label)
        if (!normalizedCandidate || !normalizedExpected) return null
        const expectsPositive = normalizedExpected === 'yes' || normalizedExpected === 'true'
        const expectsNegative =
          normalizedExpected === 'no' || normalizedExpected === 'false' || normalizedExpected === 'decline'
        if (payload.exact) return normalizedCandidate === normalizedExpected ? 0 : null
        if (normalizedCandidate === normalizedExpected) return 0
        if (normalizedCandidate.includes(normalizedExpected)) return normalizedCandidate.length - normalizedExpected.length
        if (expectsPositive && hasNegativeCue(normalizedCandidate)) return null
        if (expectsNegative && hasPositiveCue(normalizedCandidate)) return null

        for (const alias of aliases(normalizedExpected)) {
          if (alias !== normalizedExpected && normalizedCandidate.includes(alias)) {
            return 40 + normalizedCandidate.length - alias.length
          }
        }

        const tokens = normalizedExpected.split(' ').filter(token => token.length >= 3)
        if (tokens.length >= 2) {
          const matches = tokens.filter(token => normalizedCandidate.includes(token))
          if (matches.length >= Math.min(2, tokens.length)) {
            return 80 + (tokens.length - matches.length) * 10
          }
        }

        return null
      }

      function visible(el: Element): el is HTMLElement {
        if (!(el instanceof HTMLElement)) return false
        const rect = el.getBoundingClientRect()
        if (rect.width <= 0 || rect.height <= 0) return false
        const style = getComputedStyle(el)
        return style.display !== 'none' && style.visibility !== 'hidden'
      }

      function popupWeight(el: HTMLElement): number {
        return el.closest(payload.popupSelector)
          ? 0
          : 220
      }

      let best: { index: number; score: number } | null = null
      for (let i = 0; i < elements.length; i++) {
        const el = elements[i]
        if (!(el instanceof Element)) continue
        if (!visible(el)) continue

        const candidateText = el.getAttribute('aria-label')?.trim() || el.textContent?.trim() || ''
        const match = matchScore(candidateText)
        if (match === null) continue

        const rect = el.getBoundingClientRect()
        const centerX = rect.left + rect.width / 2
        const centerY = rect.top + rect.height / 2
        const upwardPenalty =
          payload.anchorY === null || centerY >= payload.anchorY - 16
            ? 0
            : 140
        const verticalProximity = payload.anchorY === null ? rect.top : Math.abs(centerY - payload.anchorY)
        const horizontalProximity = payload.anchorX === null ? 0 : Math.abs(centerX - payload.anchorX)
        const score = popupWeight(el) + upwardPenalty + verticalProximity + horizontalProximity / 2 + match * 2
        if (!best || score < best.score) best = { index: i, score }
      }

      return best?.index ?? -1
    }, {
      label,
      exact,
      anchorX: anchor?.x ?? null,
      anchorY: anchor?.y ?? null,
      popupSelector: POPUP_CONTAINER_SELECTOR,
    })

    if (bestIndex >= 0) {
      const candidate = candidates.nth(bestIndex)
      const selectedText =
        (await candidate.evaluate(el => el.getAttribute('aria-label')?.trim() || el.textContent?.trim() || '').catch(() => '')) || null
      const clickTarget = await resolveMeaningfulOptionClickTarget(candidate)
      // Only scrollIntoView if the option is NOT inside a popup/dropdown container.
      // scrollIntoViewIfNeeded on popup options can scroll the entire page instead
      // of scrolling within the dropdown's own scroll container.
      const isInPopup = await candidate.evaluate(
        (el, selector) => !!el.closest(selector),
        POPUP_CONTAINER_SELECTOR,
      ).catch(() => false)
      if (clickTarget) {
        if (!isInPopup) await clickTarget.scrollIntoViewIfNeeded()
        await clickTarget.click()
      } else {
        if (!isInPopup) await candidate.scrollIntoViewIfNeeded()
        await candidate.click()
      }
      return selectedText
    }
  }

  return null
}

async function locatorDisplayedValues(locator: Locator): Promise<string[]> {
  try {
    return await locator.evaluate(browserDisplayedValues)
  } catch {
    return []
  }
}

async function elementHandleDisplayedValues(handle: ElementHandle<Element>): Promise<string[]> {
  try {
    return await handle.evaluate(browserDisplayedValues)
  } catch {
    return []
  }
}

/**
 * Read the authoritative `aria-invalid` state of a combobox trigger (or its
 * nearest owning combobox ancestor).
 *
 * This is the ONLY reliable signal for whether a custom listbox library
 * (react-select, Radix, Headless UI, Downshift, Workday PTX, Ashby, Lever
 * forms, etc.) considers a required field committed. Displayed-value reads
 * can return stale placeholder text or empty strings during closing
 * animations, and the library's internal React state may revert a silent
 * commit a few frames after an option click — but whenever that happens,
 * the library sets `aria-invalid="true"` back on the trigger element.
 *
 * Returns:
 *   - `true` if the trigger (or an owning combobox ancestor) is explicitly
 *     marked `aria-invalid="true"`.
 *   - `false` if it is explicitly `"false"` or unset. Callers should treat
 *     `false` as "no veto" — not as "definitely committed" — because some
 *     libraries simply omit the attribute when valid.
 *   - `false` on read errors (detached handles, cross-origin frames, etc.)
 *     so verification proceeds on the other positive signals.
 */
async function readAriaInvalid(handle: ElementHandle<Element> | null | undefined): Promise<boolean> {
  if (!handle) return false
  try {
    return await handle.evaluate((el) => {
      if (!(el instanceof Element)) return false
      // Walk the element itself plus a few ancestors. react-select exposes the
      // hidden input as the focusable trigger; its aria-invalid is mirrored on
      // the combobox wrapper. Radix Select puts aria-invalid on the trigger
      // button. Covering both patterns with a short climb keeps this generic.
      let cursor: Element | null = el
      let depth = 0
      while (cursor && depth < 4) {
        const attr = cursor.getAttribute('aria-invalid')
        if (attr !== null) {
          return attr === 'true' || attr === ''
        }
        cursor = cursor.parentElement
        depth++
      }
      return false
    })
  } catch {
    return false
  }
}

/**
 * Read whether a combobox trigger is currently displaying a *placeholder*
 * (uncommitted) instead of a committed value.
 *
 * The aria-invalid veto in `confirmListboxSelection` /
 * `dismissAndReVerifySelection` / `pickListboxOption.postCommitVerify`
 * catches libraries that flip aria-invalid back to "true" after a failed
 * commit (Workday PTX, some Ashby flows, certain react-select forks). It does
 * NOT catch the more common Greenhouse / Lever pattern where the library
 * leaves the field at the "Select..." placeholder with aria-invalid simply
 * absent — that field is empty and required, but no library-side validation
 * has fired yet, so aria-invalid won't be set until Submit. The verification
 * pipeline still has to know the field is empty so it can refuse to claim a
 * silent success.
 *
 * The authoritative signal for this case is the trigger's *visible text*.
 * react-select renders `.select__placeholder` when empty and
 * `.select__single-value` when committed; Radix Select renders the
 * `<SelectValue placeholder="...">` text when empty and the option text when
 * committed; Lever / generic ARIA listboxes leave the trigger's textContent
 * matching the original "Select..." prompt until something is chosen. Looking
 * at the trigger's visible text and matching it against
 * PLACEHOLDER_PATTERN tells us reliably whether anything was actually
 * selected, regardless of which library is in play.
 *
 * Returns:
 *   - `true` only if the trigger has visible text AND that text matches the
 *     placeholder pattern. This is "definitely empty".
 *   - `false` if the trigger shows text that does NOT match a placeholder, or
 *     if no visible text could be read at all (read errors, empty trigger,
 *     handle detached). Treat `false` as "no veto" — same convention as
 *     readAriaInvalid — so verification keeps running on positive signals.
 */
async function readTriggerShowsPlaceholder(
  handle: ElementHandle<Element> | null | undefined,
): Promise<boolean> {
  if (!handle) return false
  try {
    const visibleText = await handle.evaluate((el) => {
      if (!(el instanceof HTMLElement)) return null

      function visible(node: Element | null): node is HTMLElement {
        if (!(node instanceof HTMLElement)) return false
        const rect = node.getBoundingClientRect()
        if (rect.width <= 0 || rect.height <= 0) return false
        const style = getComputedStyle(node)
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false
        return true
      }

      function readPresentational(root: Element): string | null {
        // react-select / Radix / Headless UI all render the "currently
        // displayed value" inside a leaf-ish presentational element near the
        // trigger. Walk a few ancestors looking for either the placeholder
        // class or the single-value class. The first match wins because the
        // library renders one or the other, never both.
        let cur: Element | null = root
        let depth = 0
        while (cur && depth < 4) {
          const candidates = cur.querySelectorAll<HTMLElement>(
            '[class*="placeholder"], [class*="Placeholder"], [class*="single-value"], [class*="singleValue"], [class*="SelectValue"], [data-radix-select-value]',
          )
          for (const candidate of candidates) {
            if (!visible(candidate)) continue
            if (candidate.getAttribute('aria-hidden') === 'true') continue
            if (candidate.querySelector('input, select, textarea, button')) continue
            const text = candidate.textContent?.trim()
            if (!text) continue
            return text
          }
          cur = cur.parentElement
          depth++
        }
        return null
      }

      // Try the presentational read first — most accurate for react-select /
      // Radix style libraries.
      const presentational = readPresentational(el)
      if (presentational) return presentational

      // Fall back to the trigger's own textContent. For libraries that don't
      // use a sibling presentational element (Lever, plain ARIA listboxes,
      // some Ashby forms), the trigger itself shows the current selection or
      // the placeholder text directly.
      const direct = el.textContent?.trim()
      return direct || null
    })

    if (!visibleText) return false
    // PLACEHOLDER_PATTERN already exists in this module — reuse it so the
    // detection rules stay in one place.
    return PLACEHOLDER_PATTERN.test(visibleText)
  } catch {
    return false
  }
}

/**
 * Detect whether a combobox trigger is a "searchable/autocomplete style"
 * combobox (React Select, Headless UI, Radix, Ant Design Select, etc.).
 *
 * These libraries commit their controlled `onChange` state on **keyboard
 * Enter**, not on a synthetic mouse click dispatched via Playwright's
 * `.click()`. For regular mouse interactions they use a bubbling
 * `mousedown`/`pointerdown` path that does not round-trip through React
 * Select's internal `selectOption` handler in some Remix-wrapped builds
 * (notably Greenhouse's ATS embed), so the option click fires visually but
 * the form state stays empty. Pressing Enter on the focused combobox input
 * after the click puts the selection through the keyboard code path which
 * ALWAYS commits.
 *
 * Detection is fully generic — no hostname or site-specific branching.
 * The signals we look for are:
 *
 *   1. `aria-autocomplete` on the element or its nearest ancestor input is
 *      `"list"` or `"both"`. This is the standards-aligned signal for any
 *      combobox that filters options as the user types.
 *   2. A class pattern indicative of React Select (`select__control`,
 *      `select__`), React Suite picker (`rs-picker`), or Ant Design Select
 *      (`ant-select`) on the element or any ancestor up to 5 levels.
 *   3. `role="combobox"` present together with `aria-expanded` on the
 *      element or an ancestor — the ARIA 1.2 combobox pattern.
 *
 * Native `<select>` elements do NOT match any of these signals, so the
 * caller can safely gate its `Enter` dispatch on this check without
 * breaking non-searchable listboxes.
 */
async function isAutocompleteCombobox(
  handle: ElementHandle<Element> | null | undefined,
): Promise<boolean> {
  if (!handle) return false
  try {
    return await handle.evaluate((el) => {
      if (!(el instanceof Element)) return false
      let cur: Element | null = el
      let depth = 0
      while (cur && depth < 5) {
        // aria-autocomplete on the element or an ancestor input/combobox.
        const ac = cur.getAttribute('aria-autocomplete')
        if (ac === 'list' || ac === 'both') return true

        // Class-based fingerprint for known autocomplete libraries.
        const className = (cur.getAttribute('class') ?? '').toLowerCase()
        if (className) {
          if (
            className.includes('select__control') ||
            className.includes('select__') ||
            className.includes('rs-picker') ||
            className.includes('ant-select') ||
            className.includes('headlessui-combobox') ||
            className.includes('cmdk-')
          ) {
            return true
          }
        }

        // ARIA 1.2 combobox pattern: role="combobox" + aria-expanded is a
        // strong signal that the control commits via keyboard semantics.
        if (cur.getAttribute('role') === 'combobox' && cur.hasAttribute('aria-expanded')) {
          return true
        }
        cur = cur.parentElement
        depth++
      }

      // Also look downward for a descendant input that declares
      // aria-autocomplete — some Headless UI wrappers expose the control via
      // a sibling input inside the trigger container.
      const descendant = (el as Element).querySelector?.(
        '[aria-autocomplete="list"], [aria-autocomplete="both"]',
      )
      return !!descendant
    })
  } catch {
    return false
  }
}

/**
 * Dispatch a keyboard `Enter` to commit an autocomplete-style combobox's
 * selection after the option has been clicked. Only fires if the trigger
 * looks like a searchable combobox per {@link isAutocompleteCombobox}.
 *
 * Why this exists: Playwright's `.click()` on a React Select option DOM
 * element dispatches a synthetic `pointerdown`/`mouseup`/`click` sequence
 * that a subset of React Select forks (and every Remix-wrapped Greenhouse
 * ATS build we've seen) will NOT commit through `selectOption`. The
 * library's `keydown Enter` handler, however, unconditionally commits via
 * the same internal `setValue` the visual selection uses. Pressing Enter
 * after the click is therefore a universal "force commit" primitive for
 * searchable comboboxes that benefit every library without touching the
 * native-<select> happy path.
 *
 * Intentionally swallows errors — this is a best-effort commit helper and
 * a missing page/focus should not break the surrounding selection flow.
 */
async function pressEnterToCommitListbox(
  page: Page,
  handle: ElementHandle<Element> | null | undefined,
): Promise<boolean> {
  if (!handle) return false
  if (!(await isAutocompleteCombobox(handle))) return false
  try {
    await page.keyboard.press('Enter')
    // Short settle window for the library to run its onChange -> form
    // state update. 80ms is the same budget used elsewhere in this file
    // for React Select commit propagation.
    await delay(80)
    return true
  } catch {
    return false
  }
}

/**
 * After a custom listbox option click, make the committed value visible to
 * framework state managers that listen on the backing input/select instead of
 * the popup option. This covers React controlled inputs, react-hook-form
 * hidden inputs, and intl-tel-input country pickers without site branching.
 */
async function dispatchListboxCommitEvents(
  handle: ElementHandle<Element> | null | undefined,
): Promise<boolean> {
  if (!handle) return false
  try {
    return await handle.evaluate((el) => {
      if (!(el instanceof Element)) return false

      function clearReactTracker(target: HTMLElement): void {
        const tracker = (target as unknown as { _valueTracker?: { setValue: (value: string) => void } })._valueTracker
        if (!tracker || typeof tracker.setValue !== 'function') return
        try {
          if (target instanceof HTMLInputElement && (target.type === 'checkbox' || target.type === 'radio')) {
            tracker.setValue(String(!target.checked))
            return
          }
          const current = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement
            ? target.value
            : target instanceof HTMLSelectElement
              ? target.value
              : target.textContent ?? ''
          tracker.setValue(current === '' ? '__geometra_empty__' : '')
        } catch { /* ignore */ }
      }

      function dispatchCommit(target: HTMLElement): void {
        clearReactTracker(target)
        const inputType = target instanceof HTMLInputElement ? target.type.toLowerCase() : ''
        const isSearchQueryInput =
          target instanceof HTMLInputElement &&
          !['hidden', 'checkbox', 'radio', 'tel'].includes(inputType) &&
          (
            target.getAttribute('role') === 'combobox' ||
            target.hasAttribute('aria-autocomplete') ||
            target.hasAttribute('aria-activedescendant')
          )
        if (!isSearchQueryInput) {
          target.dispatchEvent(new Event('input', { bubbles: true }))
        }
        target.dispatchEvent(new Event('change', { bubbles: true }))
        if (
          target instanceof HTMLInputElement &&
          (
            target.type === 'tel' ||
            target.closest('.iti, .intl-tel-input, [data-intl-tel-input-id], [class*="phone"], [class*="Phone"]')
          )
        ) {
          target.dispatchEvent(new Event('countrychange', { bubbles: true }))
        }
      }

      function commitRoot(start: Element): Element {
        let best: Element = start.parentElement ?? start
        let current: Element | null = start.parentElement
        let depth = 0
        while (current && depth < 6) {
          if (current.tagName.toLowerCase() === 'form') break
          const className = (current.getAttribute('class') ?? '').toLowerCase()
          const controlCount = current.querySelectorAll('input, textarea, select, [role="combobox"], [aria-haspopup="listbox"]').length
          const looksLikeField =
            current.querySelector('label, legend') !== null ||
            className.includes('field') ||
            className.includes('form-group') ||
            className.includes('form-control') ||
            className.includes('select') ||
            className.includes('combo') ||
            className.includes('phone') ||
            className.includes('iti') ||
            className.includes('input')
          if (looksLikeField && controlCount > 0 && controlCount <= 10) best = current
          current = current.parentElement
          depth++
        }
        return best
      }

      const targets: HTMLElement[] = []
      const seen = new Set<HTMLElement>()
      const add = (candidate: Element | null | undefined): void => {
        if (!(candidate instanceof HTMLElement)) return
        if (seen.has(candidate)) return
        seen.add(candidate)
        targets.push(candidate)
      }

      add(el)
      const root = commitRoot(el)
      for (const candidate of Array.from(root.querySelectorAll<HTMLElement>(
        'input, textarea, select, [role="combobox"], [aria-haspopup="listbox"]',
      ))) {
        if (
          candidate.closest('[role="listbox"], [role="menu"]') &&
          !candidate.matches('[role="combobox"], input, select, textarea')
        ) {
          continue
        }
        add(candidate)
      }

      for (const target of targets) dispatchCommit(target)
      return targets.length > 0
    })
  } catch {
    return false
  }
}

/**
 * Read form-level invalid state for a combobox trigger.
 *
 * `readAriaInvalid` / `readTriggerShowsPlaceholder` only consult attributes
 * on the trigger element and its direct ancestors. That catches react-select's
 * revert pattern and the Greenhouse "stay at placeholder" pattern, but it
 * misses the case where the combobox's visible chrome says "committed"
 * while the surrounding *form's* controlled state still reports the field
 * as invalid. The form-level source of truth lives in sibling hidden
 * inputs and in react-hook-form / Formik style `role="alert"` /
 * `.error` / `[data-invalid]` elements inside the field wrapper.
 *
 * This function walks up to the closest `<form>` ancestor of the trigger
 * and, within the trigger's nearest field wrapper (the closest ancestor
 * with a `<label>`-like role, bounded by the form), checks for any of:
 *
 *   - `<input>` hidden siblings with `aria-invalid="true"` or `[data-invalid]`
 *   - `[role="alert"]` or `.error` / `[data-error]` siblings (rendered by
 *     react-hook-form's `<ErrorMessage>`, Formik, Ashby's form lib, etc.)
 *   - A sibling with the `invalid:required` / `required` error text class
 *
 * Returns `true` if the form reports the field as invalid — callers should
 * treat this as a definitive "commit failed" signal and retry. Returns
 * `false` if everything looks clean OR if the walk fails (handle detached,
 * no form ancestor, etc.) — "unknown" is NOT a veto, same convention as
 * `readAriaInvalid`.
 */
async function readFormLevelInvalidState(
  handle: ElementHandle<Element> | null | undefined,
  opts?: { requireWrapperFlag?: boolean },
): Promise<boolean> {
  if (!handle) return false
  // Default behavior preserves the existing veto logic: a blank required
  // hidden input only counts as invalid when SOMETHING else in the wrapper
  // also flags an error (role=alert / data-invalid / data-error). That's
  // safe for read-only checks where we don't know whether a commit was
  // recently attempted. When `requireWrapperFlag: false`, the function
  // becomes stricter and treats a blank required hidden input as
  // definitively-not-committed even without a visible error flag — the
  // caller (postCommitVerify) is asserting that a commit was just attempted,
  // so the hidden input's emptiness IS authoritative. Bug surfaced by
  // JobForge round-2 marathon — Airtable PM AI #94 phone-country combobox.
  const requireWrapperFlag = opts?.requireWrapperFlag ?? true
  try {
    return await handle.evaluate((el, requireWrapperFlagFn) => {
      if (!(el instanceof Element)) return false

      // Find the closest <form>. No form = can't verify, not a veto.
      const form = el.closest('form')
      if (!form) return false

      // Find the field wrapper — the closest ancestor that "contains a label"
      // and is still inside the form. This is the react-hook-form convention:
      // every field lives under a wrapper that renders both the control and
      // the error message as siblings. If we can't find one, use a bounded
      // walk up to ~6 ancestors and look at each one's siblings.
      let wrapper: Element | null = el
      let depth = 0
      while (wrapper && wrapper !== form && depth < 6) {
        // A "field wrapper" is anything that contains a <label>, a legend,
        // or a [class*="field"] class up to 6 ancestors deep.
        const hasLabel =
          wrapper.querySelector && (wrapper.querySelector('label') || wrapper.querySelector('legend'))
        const className = (wrapper.getAttribute('class') ?? '').toLowerCase()
        const looksLikeField =
          className.includes('field') ||
          className.includes('form-group') ||
          className.includes('form-control') ||
          className.includes('input-wrapper')
        if (hasLabel || looksLikeField) break
        wrapper = wrapper.parentElement
        depth++
      }
      if (!wrapper || wrapper === form) wrapper = el.parentElement ?? el

      // 1. Hidden sibling <input> with aria-invalid / data-invalid. This is
      //    the react-hook-form + react-select pattern: the Controller writes
      //    the value into a hidden input, and form validation marks that
      //    hidden input invalid.
      const hiddenInputs = wrapper.querySelectorAll<HTMLInputElement>(
        'input[type="hidden"], input[aria-hidden="true"]',
      )
      for (const input of hiddenInputs) {
        const ariaInvalid = input.getAttribute('aria-invalid')
        if (ariaInvalid === 'true' || ariaInvalid === '') return true
        if (input.hasAttribute('data-invalid')) return true
        // Required + empty value is a definitive "not committed" signal,
        // but only when the element is actually marked required AND the
        // hidden input is blank. react-select writes an empty string to
        // its hidden input when uncommitted.
        if (input.required && (input.value === '' || input.value == null)) {
          if (!requireWrapperFlagFn) {
            // Caller (postCommitVerify) just attempted a commit; a blank
            // required hidden input is authoritative even without a
            // visible error flag.
            return true
          }
          // Read-only mode: only veto if SOMETHING in the wrapper also
          // flags the field as in-error. A blank hidden input on a page
          // that hasn't attempted submit yet is common and non-authoritative.
          const flaggedInWrapper =
            wrapper.querySelector('[role="alert"]') ||
            wrapper.querySelector('[data-invalid]') ||
            wrapper.querySelector('[data-error]')
          if (flaggedInWrapper) return true
        }
      }

      // 2. role="alert" or [data-invalid] / [data-error] / .error inside the
      //    wrapper. react-hook-form's ErrorMessage renders role=alert when a
      //    validator fires; Formik renders a div.error; Ashby uses
      //    data-invalid.
      const alerts = wrapper.querySelectorAll(
        '[role="alert"], [data-invalid], [data-error], [class*="error-message"], [class*="errorMessage"]',
      )
      for (const alert of alerts) {
        if (!(alert instanceof HTMLElement)) continue
        // Must be visible — hidden slots don't count as a veto.
        const rect = alert.getBoundingClientRect()
        if (rect.width <= 0 || rect.height <= 0) continue
        const style = getComputedStyle(alert)
        if (style.display === 'none' || style.visibility === 'hidden') continue
        const text = alert.textContent?.trim() ?? ''
        // Empty alerts are placeholders rendered for layout; skip them.
        if (!text) continue
        return true
      }

      return false
    }, requireWrapperFlag)
  } catch {
    return false
  }
}

/**
 * Read the picked option from a custom combobox's sibling presentational
 * element ONLY. Skips the input's own .value (which is the typed search
 * query for editable comboboxes), aria attributes, and the trigger's own
 * textContent. Returns text only when it lives in something that looks like
 * react-select's `.select__single-value`, Radix's `<SelectValue>`, or a
 * similar library-rendered "currently picked" presentational element.
 *
 * Why this is its own function instead of just using browserDisplayedValues:
 * confirmListboxSelection has a strict gate (`canTrustEditableDisplayMatch`)
 * for editable triggers that requires the popup to close before any value
 * read can be trusted — otherwise a typed search query like "Yes" could be
 * mistaken for a committed selection. That gate is correct for the input's
 * own .value, but it's overly strict for sibling-rendered values: a value
 * appearing in `.select__single-value` only happens *after* the library has
 * committed the choice, regardless of popup state. By splitting the
 * sibling-only read into its own check, we can trust the sibling
 * unconditionally and still distrust the input's own value when the trigger
 * is editable. This avoids the silent-fill bug where react-select v5
 * comboboxes get filled but `confirmListboxSelection` returns false because
 * the popup is still in its closing animation, causing pickListboxOption to
 * fall through to the keyboard fallback which re-clicks the input and
 * re-opens the menu.
 */
async function trustedSiblingComboboxValue(handle: ElementHandle<Element>): Promise<string | undefined> {
  try {
    return await handle.evaluate((el) => {
      if (!(el instanceof HTMLElement)) return undefined
      let cur: Element | null = el.parentElement
      let depth = 0
      while (cur && depth < 4) {
        const candidates = cur.querySelectorAll<HTMLElement>(
          '[class*="single-value"], [class*="singleValue"], [class*="SelectValue"], [data-radix-select-value]',
        )
        for (const candidate of candidates) {
          if (candidate === el) continue
          if (candidate.contains(el)) continue
          if (candidate.getAttribute('aria-hidden') === 'true') continue
          const className = (candidate.getAttribute('class') ?? '').toLowerCase()
          if (className.includes('placeholder')) continue
          if (className.includes('indicator')) continue
          // Skip wrappers that contain other form controls — we want a leaf-ish
          // presentational text node, not a container.
          if (candidate.querySelector('input, select, textarea, button')) continue
          const text = candidate.textContent?.trim()
          if (text) return text
        }
        cur = cur.parentElement
        depth++
      }
      return undefined
    })
  } catch {
    return undefined
  }
}

async function visibleOptionIsSelected(
  page: Page,
  label: string,
  exact: boolean,
  anchor?: AnchorPoint,
): Promise<boolean> {
  for (const frame of page.frames()) {
    const candidates = frame.locator(OPTION_PICKER_SELECTOR)
    const count = await candidates.count()
    if (count === 0) continue

    const selected = await candidates.evaluateAll((elements, payload) => {
      function normalize(value: string): string {
        return value
          .normalize('NFKD')
          .replace(/[\u0300-\u036f]/g, '')
          .replace(/[＋﹢∔]/g, '+')
          .replace(/[‐‑‒–—―]/g, '-')
          .replace(/&/g, ' and ')
          .replace(/\bplus\b/g, '+')
          .replace(/[,/()]+/g, ' ')
          .replace(/\s*\+\s*/g, '+')
          .replace(/\s+/g, ' ')
          .trim()
          .toLowerCase()
      }

      function aliases(value: string): string[] {
        const out = new Set<string>([value])
        if (value === 'yes' || value === 'true') {
          for (const alias of ['agree', 'agreed', 'accept', 'accepted', 'consent', 'acknowledge', 'read', 'opt in']) {
            out.add(alias)
          }
        }
        if (value === 'no' || value === 'false') {
          for (const alias of ['decline', 'declined', 'disagree', 'deny', 'opt out', 'prefer not']) {
            out.add(alias)
          }
        }
        if (value === 'decline') {
          for (const alias of ['prefer not', 'opt out', 'do not']) {
            out.add(alias)
          }
        }
        if (value === 'atx' || value.includes('austin')) {
          for (const alias of ['atx', 'austin', 'austin tx', 'austin texas']) out.add(alias)
        }
        if (value === 'nyc' || value.includes('new york')) {
          for (const alias of ['nyc', 'new york', 'new york ny']) out.add(alias)
        }
        if (value === 'sf' || value.includes('san francisco')) {
          for (const alias of ['sf', 'san francisco', 'san francisco ca']) out.add(alias)
        }
        if (value === 'la' || value.includes('los angeles')) {
          for (const alias of ['la', 'los angeles', 'los angeles ca']) out.add(alias)
        }
        if (value === 'dc' || value.includes('washington dc')) {
          for (const alias of ['dc', 'washington dc', 'washington d c']) out.add(alias)
        }
        if (value === 'us' || value === 'usa' || value.includes('united states')) {
          for (const alias of ['us', 'usa', 'united states']) out.add(alias)
        }
        return [...out]
      }

      function hasNegativeCue(value: string): boolean {
        return /\b(no|not|do not|don't|decline|disagree|deny|opt out|prefer not)\b/.test(value)
      }

      function hasPositiveCue(value: string): boolean {
        return /\b(yes|agree|accept|consent|acknowledge|opt in|allow|read)\b/.test(value)
      }

      function matchScore(candidate: string | undefined): number | null {
        if (!candidate) return null
        const normalizedCandidate = normalize(candidate)
        const normalizedExpected = normalize(payload.label)
        if (!normalizedCandidate || !normalizedExpected) return null
        const expectsPositive = normalizedExpected === 'yes' || normalizedExpected === 'true'
        const expectsNegative =
          normalizedExpected === 'no' || normalizedExpected === 'false' || normalizedExpected === 'decline'
        if (payload.exact) return normalizedCandidate === normalizedExpected ? 0 : null
        if (normalizedCandidate === normalizedExpected) return 0
        if (normalizedCandidate.includes(normalizedExpected)) return normalizedCandidate.length - normalizedExpected.length
        if (expectsPositive && hasNegativeCue(normalizedCandidate)) return null
        if (expectsNegative && hasPositiveCue(normalizedCandidate)) return null
        for (const alias of aliases(normalizedExpected)) {
          if (alias !== normalizedExpected && normalizedCandidate.includes(alias)) {
            return 40 + normalizedCandidate.length - alias.length
          }
        }
        return null
      }

      function visible(el: Element): el is HTMLElement {
        if (!(el instanceof HTMLElement)) return false
        const rect = el.getBoundingClientRect()
        if (rect.width <= 0 || rect.height <= 0) return false
        const style = getComputedStyle(el)
        return style.display !== 'none' && style.visibility !== 'hidden'
      }

      function isSelected(el: Element): boolean {
        return (
          el.getAttribute('aria-selected') === 'true' ||
          el.getAttribute('aria-checked') === 'true' ||
          el.getAttribute('data-selected') === 'true' ||
          el.getAttribute('data-state') === 'checked' ||
          el.getAttribute('data-state') === 'on'
        )
      }

      let bestScore = Number.POSITIVE_INFINITY
      for (const el of elements) {
        if (!(el instanceof Element)) continue
        if (!visible(el)) continue
        if (!isSelected(el)) continue
        const text = el.getAttribute('aria-label')?.trim() || el.textContent?.trim() || ''
        const match = matchScore(text)
        if (match === null) continue
        const rect = el.getBoundingClientRect()
        const centerX = rect.left + rect.width / 2
        const centerY = rect.top + rect.height / 2
        const distance =
          payload.anchorX === null && payload.anchorY === null
            ? 0
            : Math.abs(centerX - (payload.anchorX ?? centerX)) + Math.abs(centerY - (payload.anchorY ?? centerY))
        bestScore = Math.min(bestScore, match * 2 + distance / 2)
      }

      return Number.isFinite(bestScore)
    }, { label, exact, anchorX: anchor?.x ?? null, anchorY: anchor?.y ?? null })

    if (selected) return true
  }

  return false
}

async function confirmListboxSelection(
  page: Page,
  fieldLabel: string,
  label: string,
  exact: boolean,
  anchor?: AnchorPoint,
  currentHandle?: ElementHandle<Element> | null,
  selectedOptionText?: string,
  opts?: { editable?: boolean },
): Promise<boolean> {
  const canTrustEditableDisplayMatch = async (): Promise<boolean> => {
    if (!opts?.editable) return true
    if (await visibleOptionIsSelected(page, label, exact, anchor)) return true
    const popupState = await collectVisibleOptionHints(page, anchor)
    return !popupState.hasPopup
  }

  // ARIA veto: if the combobox still advertises aria-invalid="true" after the
  // option click, the library itself is telling us the commit did not land.
  // Displayed-value reads can still return stale placeholder text or an in-
  // flight sibling value during react-select's closing animation, so trusting
  // them without consulting aria-invalid produces the silent-success bug this
  // whole function exists to prevent. See readAriaInvalid() for why this is
  // the right generic signal.
  const ariaVeto = async (): Promise<boolean> => currentHandle ? readAriaInvalid(currentHandle) : false

  if (currentHandle) {
    // Sibling-only check first: react-select / Radix / similar libraries
    // only populate `.select__single-value` (and friends) AFTER they commit
    // a choice, so a match here is trustworthy regardless of editable state
    // or whether the popup is still in its closing animation. This is the
    // fast-path for the v1.34.0 silent-fill bug.
    const trustedSibling = await trustedSiblingComboboxValue(currentHandle)
    if (trustedSibling && displayedValueMatchesSelection(trustedSibling, label, exact, selectedOptionText)) {
      if (!(await ariaVeto())) return true
    }

    const immediateValues = await elementHandleDisplayedValues(currentHandle)
    if (
      immediateValues.some(value => displayedValueMatchesSelection(value, label, exact, selectedOptionText)) &&
      await canTrustEditableDisplayMatch() &&
      !(await ariaVeto())
    ) {
      return true
    }
  }

  const deadline = Date.now() + 1500
  while (Date.now() < deadline) {
    if (currentHandle) {
      // Re-check the sibling on every poll iteration — the commit may land
      // a few ms after the option click, especially for libraries that
      // schedule state updates via React transitions.
      const trustedSibling = await trustedSiblingComboboxValue(currentHandle)
      if (trustedSibling && displayedValueMatchesSelection(trustedSibling, label, exact, selectedOptionText)) {
        if (!(await ariaVeto())) return true
      }
    }
    for (const frame of page.frames()) {
      const locator = await findLabeledControl(frame, fieldLabel, exact, { preferredAnchor: anchor })
      if (!locator) continue
      const values = await locatorDisplayedValues(locator)
      if (
        values.some(value => displayedValueMatchesSelection(value, label, exact, selectedOptionText)) &&
        await canTrustEditableDisplayMatch() &&
        !(await ariaVeto())
      ) {
        return true
      }
    }
    if (await visibleOptionIsSelected(page, label, exact, anchor) && !(await ariaVeto())) return true
    // Check for multi-select chips/tags (Greenhouse-style React-Select multi)
    if (currentHandle) {
      try {
        const hasChip = await currentHandle.evaluate((el, selectedLabel) => {
          let container: Element | null = el
          for (let d = 0; d < 5 && container; d++) {
            const chips = container.querySelectorAll(
              '[class*="chip"], [class*="tag"], [class*="multi-value"], [class*="multiValue"], [aria-selected="true"]',
            )
            for (const chip of chips) {
              const text = chip.textContent?.trim().toLowerCase() ?? ''
              if (text.includes(selectedLabel.toLowerCase())) return true
            }
            container = container.parentElement
          }
          return false
        }, label)
        if (hasChip && !(await ariaVeto())) return true
      } catch { /* handle detached */ }
    }
    await delay(100)
  }
  return false
}

const PLACEHOLDER_PATTERN = /^(select|choose|pick|--|—\s)/i

/**
 * Dismiss the dropdown (Tab) and re-verify the field value didn't revert to a placeholder.
 * Catches silent selection failures in React comboboxes where the value appears briefly
 * but isn't committed to form state.
 */
async function dismissAndReVerifySelection(
  page: Page,
  label: string,
  exact: boolean,
  currentHandle?: ElementHandle<Element> | null,
  selectedOptionText?: string,
): Promise<boolean> {
  // Blur the active element instead of pressing Tab. Pressing Tab moves focus to the next
  // focusable element on the page; in forms with several adjacent custom selects (Greenhouse,
  // Workday, Ashby), the next field's focus handler will immediately reopen *its* popup,
  // breaking subsequent selections in surprising ways. Blurring the active element fires the
  // same `blur` / `change` events most React-Select-style controls use to commit, without
  // dragging focus into the next field.
  try {
    await page.evaluate(() => {
      const active = document.activeElement
      if (active && active instanceof HTMLElement && typeof active.blur === 'function') {
        active.blur()
      }
    })
  } catch {
    // Page may be navigating; fall back to Tab as the legacy behavior.
    try { await page.keyboard.press('Tab') } catch { /* ignore */ }
  }
  await delay(50)

  if (!currentHandle) return true

  // Re-verify using the original element handle (immune to DOM reordering)
  const deadline = Date.now() + 800
  let sawAnyValue = false
  while (Date.now() < deadline) {
    try {
      const values = await elementHandleDisplayedValues(currentHandle)
      if (values.length > 0) sawAnyValue = true
      if (values.some(value => displayedValueMatchesSelection(value, label, exact, selectedOptionText))) {
        return true
      }
      // Check for multi-select chips/tags containing the selected value
      const hasChip = await currentHandle.evaluate((el, selectedLabel) => {
        // Walk up to find the field container
        let container: Element | null = el
        for (let d = 0; d < 5 && container; d++) {
          // Look for chip/tag elements inside the container
          const chips = container.querySelectorAll(
            '[class*="chip"], [class*="tag"], [class*="multi-value"], [class*="multiValue"], [aria-selected="true"]',
          )
          for (const chip of chips) {
            const text = chip.textContent?.trim().toLowerCase() ?? ''
            if (text.includes(selectedLabel.toLowerCase())) return true
          }
          container = container.parentElement
        }
        return false
      }, label)
      if (hasChip) return true

      if (values.length > 0 && values.every(v => PLACEHOLDER_PATTERN.test(v.trim()))) {
        return false
      }
    } catch {
      // Handle detached — trust the earlier confirmation
      return true
    }
    await delay(100)
  }
  // Deadline elapsed without a positive signal. Two scenarios:
  //
  //   (a) sawAnyValue === true:
  //       The field did report *some* displayed value, but none of them
  //       matched the target label. That's a silent revert — React Select
  //       restored the placeholder after the blur event. Return false so the
  //       caller retries via keyboard or surfaces the failure.
  //
  //   (b) sawAnyValue === false:
  //       The field never reported a displayed value during the poll. Used
  //       to return true here (legacy "optimistic success so well-formed
  //       selects don't suddenly fail"), but that's exactly how the silent
  //       commit bug reached production: an unfilled required combobox with
  //       only a sr-only placeholder would pass through this branch despite
  //       still being empty. The authoritative checks are aria-invalid AND
  //       the trigger's visible text — if the library still marks the trigger
  //       invalid, OR the trigger still shows a "Select..." placeholder, it
  //       is NOT committed, full stop. Only if BOTH signals are clear do we
  //       keep the legacy optimism so well-formed controls that never expose
  //       a displayed value (pure ARIA patterns like Radix with SelectValue
  //       empty text) still pass.
  if (sawAnyValue) return false
  if (await readAriaInvalid(currentHandle)) return false
  if (await readTriggerShowsPlaceholder(currentHandle)) return false
  return true
}

/**
 * Resolve and validate paths on the machine running the proxy (not the agent host).
 */
export function resolveExistingFiles(rawPaths: unknown[]): string[] {
  if (!Array.isArray(rawPaths) || rawPaths.length === 0) {
    throw new Error('file: paths must be a non-empty array of strings')
  }
  const paths: string[] = []
  for (const p of rawPaths) {
    if (typeof p !== 'string' || p.trim() === '') continue
    paths.push(resolve(p))
  }
  if (paths.length === 0) throw new Error('file: paths must contain at least one non-empty string')
  for (const p of paths) {
    if (!existsSync(p)) throw new Error(`file: path does not exist: ${p}`)
  }
  return paths
}

async function findLabeledFileInput(frame: Frame, fieldLabel: string, exact: boolean): Promise<Locator | null> {
  // Try exact-match candidates first, even when the caller passed
  // exact=false. Same Greenhouse-style failure mode as findLabeledControl:
  // a substring match (e.g. file labeled "Resume" hijacked by another
  // "Please attach your resume below" field) silently picks the wrong
  // input. Trying exact first guarantees the literal label wins when
  // present, and only falls through to substring matching otherwise.
  const exactDirect = frame.getByLabel(fieldLabel, { exact: true })
  const exactDirectCount = await exactDirect.count()
  for (let i = 0; i < exactDirectCount; i++) {
    const candidate = exactDirect.nth(i)
    const isFileInput = await candidate.evaluate(el => el instanceof HTMLInputElement && el.type === 'file').catch(() => false)
    if (isFileInput) return candidate
  }

  if (!exact) {
    const direct = frame.getByLabel(fieldLabel, { exact: false })
    const directCount = await direct.count()
    for (let i = 0; i < directCount; i++) {
      const candidate = direct.nth(i)
      const isFileInput = await candidate.evaluate(el => el instanceof HTMLInputElement && el.type === 'file').catch(() => false)
      if (isFileInput) return candidate
    }
  }

  const loc = frame.locator('input[type="file"]')
  const count = await loc.count()
  if (count === 0) return null

  const bestIndex = await loc.evaluateAll((elements, payload) => {
    function normalize(value: string): string {
      return value.replace(/\s+/g, ' ').trim().toLowerCase()
    }

    function matches(candidate: string | undefined): boolean {
      if (!candidate) return false
      const normalizedCandidate = normalize(candidate)
      const normalizedExpected = normalize(payload.fieldLabel)
      if (!normalizedCandidate || !normalizedExpected) return false
      return payload.exact ? normalizedCandidate === normalizedExpected : normalizedCandidate.includes(normalizedExpected)
    }

    function referencedText(ids: string | null, visited?: Set<string>): string | undefined {
      if (!ids) return undefined
      const seen = visited ?? new Set<string>()
      const text = ids
        .split(/\s+/)
        .map(id => {
          if (seen.has(id)) return ''
          seen.add(id)
          const target = document.getElementById(id)
          if (!target) return ''
          const chained = target.getAttribute('aria-labelledby')
          if (chained) return referencedText(chained, seen) ?? ''
          return target.textContent?.trim() ?? ''
        })
        .filter(Boolean)
        .join(' ')
        .trim()
      return text || undefined
    }

    function explicitLabelText(el: Element): string | undefined {
      const aria = el.getAttribute('aria-label')?.trim()
      if (aria) return aria
      const labelledBy = referencedText(el.getAttribute('aria-labelledby'))
      if (labelledBy) return labelledBy
      if (el instanceof HTMLInputElement && el.labels && el.labels.length > 0) {
        return el.labels[0]?.textContent?.trim() || undefined
      }
      if (el instanceof HTMLElement && el.id) {
        const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`)
        const text = label?.textContent?.trim()
        if (text) return text
      }
      if (el.parentElement?.tagName.toLowerCase() === 'label') {
        const text = el.parentElement.textContent?.trim()
        if (text) return text
      }
      const title = el.getAttribute('title')?.trim()
      if (title) return title
      return undefined
    }

    for (let i = 0; i < elements.length; i++) {
      const el = elements[i]
      if (!(el instanceof HTMLInputElement) || el.type !== 'file') continue
      if (matches(explicitLabelText(el))) return i
    }
    return -1
  }, { fieldLabel, exact })

  return bestIndex >= 0 ? loc.nth(bestIndex) : null
}

async function findLabeledFileInputInPage(
  page: Page,
  fieldLabel: string,
  exact: boolean,
  cache?: FillLookupCache,
  fieldId?: string,
): Promise<Locator | null> {
  const cached = readCachedLocator(cache, 'file', fieldLabel, exact, fieldId)
  if (cached !== undefined) return cached

  for (const frame of page.frames()) {
    const locator = await findLabeledFileInput(frame, fieldLabel, exact)
    if (!locator) continue
    writeCachedLocator(cache, 'file', fieldLabel, exact, fieldId, locator)
    return locator
  }

  writeCachedLocator(cache, 'file', fieldLabel, exact, fieldId, null)
  return null
}

async function attachHiddenInAllFrames(
  page: Page,
  paths: string[],
  opts?: { fieldLabel?: string; exact?: boolean; cache?: FillLookupCache; fieldId?: string },
): Promise<boolean> {
  if (opts?.fieldLabel) {
    const labeled = await findLabeledFileInputInPage(page, opts.fieldLabel, opts.exact ?? false, opts.cache, opts.fieldId)
    if (labeled) {
      try {
        await labeled.setInputFiles(paths)
        return true
      } catch {
        /* fall through to uncached scan */
      }
    }
  }

  for (const frame of page.frames()) {
    if (opts?.fieldLabel) {
      const labeled = await findLabeledFileInput(frame, opts.fieldLabel, opts.exact ?? false)
      if (!labeled) continue
      try {
        await labeled.setInputFiles(paths)
        return true
      } catch {
        /* try next frame */
      }
      continue
    }
    const loc = frame.locator('input[type="file"]')
    const n = await loc.count()
    for (let i = 0; i < n; i++) {
      try {
        await loc.nth(i).setInputFiles(paths)
        return true
      } catch {
        /* try next */
      }
    }
  }
  return false
}

async function attachViaChooser(page: Page, paths: string[], clickX: number, clickY: number): Promise<void> {
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser', { timeout: 12_000 }),
    page.mouse.click(clickX, clickY),
  ])
  await chooser.setFiles(paths)
}

/**
 * Map common file extensions to MIME types so react-dropzone's `accept` filter
 * does not silently drop our synthetic files. Defaults to application/octet-stream
 * for unknowns, which is rejected by most dropzones configured with accept.
 */
function mimeTypeForPath(path: string): string {
  const ext = path.toLowerCase().split('.').pop() ?? ''
  switch (ext) {
    case 'pdf': return 'application/pdf'
    case 'doc': return 'application/msword'
    case 'docx': return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    case 'txt': return 'text/plain'
    case 'rtf': return 'application/rtf'
    case 'png': return 'image/png'
    case 'jpg':
    case 'jpeg': return 'image/jpeg'
    case 'gif': return 'image/gif'
    case 'webp': return 'image/webp'
    case 'svg': return 'image/svg+xml'
    default: return 'application/octet-stream'
  }
}

/**
 * Synthetic drop at (x,y) using file bytes from the proxy host.
 *
 * react-dropzone (widely used by Greenhouse, Ashby, and others) does NOT listen
 * for a bare `drop` event — its `getRootProps` wires up a full
 * `dragenter` → `dragover` → `drop` sequence, and react-dropzone's internal
 * state machine silently ignores a `drop` that never saw `dragenter`/`dragover`.
 * It also requires a proper `dataTransfer.types` containing "Files" AND correct
 * MIME types for any configured `accept` filter, otherwise the file is
 * rejected.
 *
 * We dispatch the full sequence on the deepest visible element at (x,y) and
 * bubble up — plus a fallback walk-up that targets any ancestor whose class
 * names, data-attributes, or role look dropzone-ish, so we hit both the inner
 * button layer and the wrapper that actually has the listeners.
 */
async function attachViaDropPlaywright(page: Page, paths: string[], dropX: number, dropY: number): Promise<void> {
  const fs = await import('node:fs/promises')
  const buffers = await Promise.all(paths.map(p => fs.readFile(p)))
  const names = paths.map(p => p.split(/[/\\\\]/).pop() ?? 'file')
  const mimes = paths.map(mimeTypeForPath)
  await page.mouse.move(dropX, dropY)
  await page.mainFrame().evaluate(
    ({ bufs, ns, ms, x, y }: { bufs: number[][]; ns: string[]; ms: string[]; x: number; y: number }) => {
      const makeDataTransfer = (): DataTransfer => {
        const dt = new DataTransfer()
        for (let i = 0; i < bufs.length; i++) {
          const u8 = new Uint8Array(bufs[i]!)
          const blob = new Blob([u8], { type: ms[i]! })
          dt.items.add(new File([blob], ns[i]!, { type: ms[i]! }))
        }
        return dt
      }
      const dispatchSequence = (target: Element): void => {
        // Each event needs its own DataTransfer because some frameworks
        // consume the items list during dragenter/dragover inspection.
        for (const type of ['dragenter', 'dragover', 'drop'] as const) {
          const dt = makeDataTransfer()
          const ev = new DragEvent(type, {
            bubbles: true,
            cancelable: true,
            composed: true,
            clientX: x,
            clientY: y,
            dataTransfer: dt,
          })
          // Some browsers/frameworks freeze the dataTransfer getter; re-define
          // it defensively so listeners read the files.
          try {
            Object.defineProperty(ev, 'dataTransfer', { value: dt, configurable: true })
          } catch { /* ignore */ }
          target.dispatchEvent(ev)
        }
      }
      const deepest = document.elementFromPoint(x, y)
      const targets: Element[] = []
      if (deepest) targets.push(deepest)
      // Walk up a few ancestors looking for anything that looks like a dropzone
      // root (react-dropzone emits `data-rfd-*`; Greenhouse uses div.drop-zone;
      // Ashby uses role="button" wrappers). We dispatch on the first dropzone-ish
      // ancestor AND the deepest element, because we cannot tell statically
      // which one has the real listener.
      let p: Element | null = deepest?.parentElement ?? null
      for (let depth = 0; depth < 12 && p; depth++) {
        const tag = p.tagName.toLowerCase()
        const attrs = p.getAttributeNames()
        const looksLikeDropzone =
          attrs.some(a => a.startsWith('data-rfd') || a === 'data-dropzone' || a === 'data-testid') ||
          (p.className && typeof p.className === 'string' && /drop[-_]?zone|file[-_]?upload|attach|upload/i.test(p.className)) ||
          tag === 'label' ||
          p.getAttribute('role') === 'button'
        if (looksLikeDropzone && !targets.includes(p)) targets.push(p)
        p = p.parentElement
      }
      if (targets.length === 0) targets.push(document.body)
      for (const t of targets) dispatchSequence(t)
      // As a final fallback, if there is a hidden input[type=file] scoped to
      // the nearest form/section, set its `files` via DataTransfer and dispatch
      // the React-friendly native input value setter so react-hook-form notices.
      const host = deepest?.closest('form, [role="form"], fieldset, section, div') ?? document.body
      const fileInput = host.querySelector('input[type="file"]') as HTMLInputElement | null
      if (fileInput) {
        const dt = makeDataTransfer()
        try {
          Object.defineProperty(fileInput, 'files', { value: dt.files, configurable: true })
        } catch { /* ignore */ }
        try {
          // React overrides the input value setter; we need the native prototype
          // setter so React sees the change.
          const proto = Object.getPrototypeOf(fileInput)
          const descriptor = Object.getOwnPropertyDescriptor(proto, 'value')
          descriptor?.set?.call(fileInput, '')
        } catch { /* ignore */ }
        fileInput.dispatchEvent(new Event('input', { bubbles: true }))
        fileInput.dispatchEvent(new Event('change', { bubbles: true }))
      }
    },
    { bufs: buffers.map(b => Array.from(b)), ns: names, ms: mimes, x: dropX, y: dropY },
  )
}

/**
 * `strategy`:
 * - `chooser` — requires x,y; opens native file chooser.
 * - `hidden` — `setInputFiles({ force: true })` on every `input[type=file]` until one succeeds.
 * - `drop` — requires dropX, dropY; synthetic drop with file payloads at coordinates.
 * - `auto` — chooser if x,y; else hidden; if hidden fails, first visible file input without force.
 */
const ATTACH_BUTTON_PATTERN = /attach|upload|add.file|choose.file|browse/i

/**
 * Find an Attach/Upload button near a field label (e.g. Greenhouse's "Attach" button
 * inside a "Resume/CV" section). Returns the button Locator or null.
 */
async function findAttachButtonNearLabel(page: Page, fieldLabel: string): Promise<Locator | null> {
  for (const frame of page.frames()) {
    // Find all buttons/links whose text matches attach-like patterns
    const buttons = frame.locator('button, a, [role="button"]')
    const count = await buttons.count()
    for (let i = 0; i < count; i++) {
      const btn = buttons.nth(i)
      try {
        const text = await btn.textContent({ timeout: 200 })
        if (!text || !ATTACH_BUTTON_PATTERN.test(text)) continue
        // Check if this button is near the field label by looking for the label text in a parent section
        const nearLabel = await btn.evaluate(
          (el, label) => {
            let parent: HTMLElement | null = el as HTMLElement
            for (let depth = 0; depth < 8 && parent; depth++) {
              parent = parent.parentElement
              if (!parent) break
              const textContent = parent.textContent ?? ''
              if (textContent.includes(label)) return true
            }
            return false
          },
          fieldLabel,
        )
        if (nearLabel) return btn
      } catch { continue }
    }
  }
  return null
}

export async function attachFiles(
  page: Page,
  paths: string[],
  opts?: {
    fieldId?: string
    clickX?: number
    clickY?: number
    fieldLabel?: string
    exact?: boolean
    strategy?: FileAttachStrategy
    dropX?: number
    dropY?: number
    cache?: FillLookupCache
  },
): Promise<void> {
  const strategy = opts?.strategy ?? 'auto'
  const clickX = opts?.clickX
  const clickY = opts?.clickY
  const fieldLabel = opts?.fieldLabel
  const exact = opts?.exact ?? false
  const dropX = opts?.dropX
  const dropY = opts?.dropY

  if (strategy === 'chooser' || (strategy === 'auto' && clickX !== undefined && clickY !== undefined)) {
    if (clickX === undefined || clickY === undefined) {
      throw new Error('file: chooser strategy requires x,y click coordinates')
    }
    await attachViaChooser(page, paths, clickX, clickY)
    return
  }

  if (strategy === 'hidden' || strategy === 'auto') {
    if (await attachHiddenInAllFrames(page, paths, { fieldId: opts?.fieldId, fieldLabel, exact, cache: opts?.cache })) return
    if (strategy === 'hidden') {
      if (fieldLabel) {
        throw new Error(`file: hidden strategy could not find input[type=file] for field "${fieldLabel}"`)
      }
      throw new Error('file: hidden strategy could not set any input[type=file]')
    }
    // Fallback: look for an Attach/Upload button near the field label and use the file chooser
    if (fieldLabel && strategy === 'auto') {
      const attachBtn = await findAttachButtonNearLabel(page, fieldLabel)
      if (attachBtn) {
        try {
          await attachBtn.scrollIntoViewIfNeeded()
          const box = await attachBtn.boundingBox()
          if (box) {
            await attachViaChooser(page, paths, box.x + box.width / 2, box.y + box.height / 2)
            return
          }
        } catch { /* fall through */ }
      }
    }
    if (fieldLabel) {
      throw new Error(`file: no input[type=file] matching field "${fieldLabel}"`)
    }
  }

  if (strategy === 'drop' || (strategy === 'auto' && dropX !== undefined && dropY !== undefined)) {
    if (dropX === undefined || dropY === undefined) {
      throw new Error('file: drop strategy requires dropX, dropY')
    }
    await attachViaDropPlaywright(page, paths, dropX, dropY)
    return
  }

  for (const frame of page.frames()) {
    const loc = frame.locator('input[type="file"]')
    const n = await loc.count()
    if (n > 0) {
      await loc.first().setInputFiles(paths)
      return
    }
  }
  throw new Error(
    'file: no input[type=file] in any frame; pass x,y (chooser), dropX/dropY (drop), or strategy hidden',
  )
}

async function findLabeledEditableField(
  page: Page,
  fieldLabel: string,
  exact: boolean,
  cache?: FillLookupCache,
  fieldId?: string,
): Promise<Locator | null> {
  const cached = readCachedLocator(cache, 'editable', fieldLabel, exact, fieldId)
  if (cached !== undefined) return cached

  for (const frame of page.frames()) {
    // Always try exact-match candidates first, even when the caller passed
    // exact=false. Same Greenhouse-style failure as findLabeledControl: a
    // text field labeled "Authorization code" gets silently hijacked by
    // a sibling react-select labeled "Are you legally authorized to work
    // in the country in which you are applying?" because the substring
    // pass matches "auth" in both. Trying exact first guarantees the
    // literal label wins when present.
    const exactCandidates = [
      frame.getByLabel(fieldLabel, { exact: true }),
      frame.getByPlaceholder(fieldLabel, { exact: true }),
      frame.getByRole('textbox', { name: fieldLabel, exact: true }),
      frame.getByRole('combobox', { name: fieldLabel, exact: true }),
    ]
    for (const candidate of exactCandidates) {
      const visible = await firstVisible(candidate, { minWidth: 1, minHeight: 1 })
      if (!visible) continue
      if (await locatorIsEditable(visible)) {
        writeCachedLocator(cache, 'editable', fieldLabel, exact, fieldId, visible)
        return visible
      }
    }

    if (!exact) {
      const candidates = [
        frame.getByLabel(fieldLabel, { exact: false }),
        frame.getByPlaceholder(fieldLabel, { exact: false }),
        frame.getByRole('textbox', { name: fieldLabel, exact: false }),
        frame.getByRole('combobox', { name: fieldLabel, exact: false }),
      ]
      for (const candidate of candidates) {
        const visible = await firstVisible(candidate, { minWidth: 1, minHeight: 1 })
        if (!visible) continue
        if (await locatorIsEditable(visible)) {
          writeCachedLocator(cache, 'editable', fieldLabel, exact, fieldId, visible)
          return visible
        }
      }
    }

    const fallback = await findLabeledControl(frame, fieldLabel, exact)
    if (fallback && await locatorIsEditable(fallback)) {
      writeCachedLocator(cache, 'editable', fieldLabel, exact, fieldId, fallback)
      return fallback
    }
  }

  // Truncated-label recovery: if the caller passed a label ending in U+2026
  // (or "..."), strip the truncation marker and retry. Geometra schemas
  // truncate long labels for the agent's benefit, but the actual DOM has the
  // full text — substring matching only works after the ellipsis is stripped.
  // See findLabeledControlInPage for the parallel fix on the choice path.
  const stripped = stripTruncationEllipsis(fieldLabel)
  if (!exact && stripped !== fieldLabel && stripped.length > 0) {
    for (const frame of page.frames()) {
      const candidates = [
        frame.getByLabel(stripped, { exact: false }),
        frame.getByPlaceholder(stripped, { exact: false }),
        frame.getByRole('textbox', { name: stripped, exact: false }),
        frame.getByRole('combobox', { name: stripped, exact: false }),
      ]
      for (const candidate of candidates) {
        const visible = await firstVisible(candidate, { minWidth: 1, minHeight: 1 })
        if (!visible) continue
        if (await locatorIsEditable(visible)) {
          writeCachedLocator(cache, 'editable', fieldLabel, exact, fieldId, visible)
          return visible
        }
      }
      const fallback = await findLabeledControl(frame, stripped, exact)
      if (fallback && await locatorIsEditable(fallback)) {
        writeCachedLocator(cache, 'editable', fieldLabel, exact, fieldId, fallback)
        return fallback
      }
    }
  }

  writeCachedLocator(cache, 'editable', fieldLabel, exact, fieldId, null)
  return null
}

async function locatorCurrentValue(locator: Locator): Promise<string | null> {
  try {
    return await locator.evaluate((el) => {
      function normalized(value: string | null | undefined): string | null {
        const trimmed = value?.replace(/\s+/g, ' ').trim()
        return trimmed ? trimmed : null
      }

      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        return normalized(el.value || el.getAttribute('aria-valuetext') || el.getAttribute('aria-label'))
      }
      if (el instanceof HTMLSelectElement) {
        return normalized(el.selectedOptions[0]?.textContent || el.value || el.getAttribute('aria-valuetext'))
      }
      if (el instanceof HTMLElement && el.isContentEditable) {
        return normalized(el.innerText || el.textContent || el.getAttribute('aria-valuetext'))
      }
      if (el instanceof HTMLElement) {
        return normalized(el.getAttribute('aria-valuetext') || el.innerText || el.textContent || el.getAttribute('aria-label'))
      }
      return null
    })
  } catch {
    return null
  }
}

function normalizedFieldValue(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase()
}

function fieldValueMatches(actual: string | null | undefined, expected: string): boolean {
  if (!actual) return false
  const normalizedActual = normalizedFieldValue(actual)
  const normalizedExpected = normalizedFieldValue(expected)
  if (!normalizedActual || !normalizedExpected) return false
  return normalizedActual === normalizedExpected || normalizedActual.includes(normalizedExpected)
}

async function setLocatorTextValue(
  locator: Locator,
  value: string,
  opts?: { imeFriendly?: boolean },
): Promise<boolean> {
  try {
    return await locator.evaluate((el, payload: { value: string; imeFriendly: boolean }) => {
      const nextValue = payload.value
      const imeFriendly = payload.imeFriendly
      // React Greenhouse/Workday/Lever fix: React stores the previous value on
      // a hidden `_valueTracker` property that React uses to short-circuit
      // onChange when the value "hasn't changed". If we set el.value through
      // the prototype setter directly, the tracker still holds the old value,
      // React's `onChange` (synthetic event) never fires, and the controlled
      // form state stays empty even though the DOM input visibly displays
      // the new text. The verification step then reads the DOM value back,
      // sees the right characters, and reports success — but the form
      // submission fails with "this field is required" because React state
      // is the source of truth, not the DOM.
      //
      // The canonical fix (used by react-testing-library, enzyme, and the
      // React docs themselves): clear the tracker BEFORE setting the new
      // value. React then sees a transition from "" → newValue and runs
      // its onChange handler, which updates the controlled state.
      //
      // This is what was breaking Fivetran #309's "Country" and "Preferred
      // First Name" fields and any other Greenhouse/Workday/Lever input
      // backed by react-hook-form, formik, or react-final-form.
      function clearReactTracker(target: HTMLInputElement | HTMLTextAreaElement | HTMLElement): void {
        const tracker = (target as unknown as { _valueTracker?: { setValue: (value: string) => void } })._valueTracker
        if (tracker && typeof tracker.setValue === 'function') {
          try { tracker.setValue('') } catch { /* ignore */ }
        }
      }

      function dispatch(target: HTMLElement): void {
        // input bubbles → drives React's onChange via the synthetic event system
        // change bubbles → drives blur-style validators (Yup, Joi, native forms)
        target.dispatchEvent(new Event('input', { bubbles: true }))
        target.dispatchEvent(new Event('change', { bubbles: true }))
        // beforeinput (some controlled inputs use it for IME-safe handlers)
        try {
          target.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText' }))
        } catch { /* ignore in non-supporting browsers */ }
      }

      function setInputLikeValue(target: HTMLInputElement | HTMLTextAreaElement, next: string): void {
        // Clear the React value tracker BEFORE setting the new value so React
        // sees a transition and runs the controlled-input onChange handler.
        clearReactTracker(target)
        const proto = target instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype
        const descriptor = Object.getOwnPropertyDescriptor(proto, 'value')
        if (descriptor?.set) {
          descriptor.set.call(target, next)
        } else {
          target.value = next
        }
      }

      function dispatchImeHints(target: HTMLElement): void {
        if (!imeFriendly) return
        try {
          target.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }))
          target.dispatchEvent(new CompositionEvent('compositionupdate', { bubbles: true, data: nextValue }))
          target.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: nextValue }))
        } catch { /* ignore */ }
      }

      /** Bulk `textContent` is unsafe for rich editors (paragraphs, mentions). */
      function isPlainContentEditable(host: HTMLElement): boolean {
        if (!host.isContentEditable) return true
        for (const node of host.childNodes) {
          if (node.nodeType === Node.TEXT_NODE) continue
          if (node.nodeType === Node.ELEMENT_NODE) {
            const tag = (node as Element).tagName.toLowerCase()
            if (tag === 'br' && host.childNodes.length === 1) continue
            return false
          }
        }
        return true
      }

      if (el instanceof HTMLInputElement) {
        if (['checkbox', 'radio', 'file', 'button', 'submit', 'reset', 'hidden'].includes(el.type)) return false
        el.focus()
        dispatchImeHints(el)
        setInputLikeValue(el, nextValue)
        dispatch(el)
        return true
      }

      if (el instanceof HTMLTextAreaElement) {
        el.focus()
        dispatchImeHints(el)
        setInputLikeValue(el, nextValue)
        dispatch(el)
        return true
      }

      if (el instanceof HTMLElement && (el.isContentEditable || el.getAttribute('role') === 'textbox' || el.getAttribute('role') === 'combobox')) {
        if (el.isContentEditable && !isPlainContentEditable(el)) return false
        el.focus()
        clearReactTracker(el)
        dispatchImeHints(el)
        el.textContent = nextValue
        dispatch(el)
        return true
      }

      return false
    }, { value, imeFriendly: opts?.imeFriendly ?? false })
  } catch {
    return false
  }
}

async function attemptNativeBatchFill(page: Page, fields: FormFieldFill[]): Promise<boolean[]> {
  type NativeBatchPendingField =
    | { index: number; kind: 'auto'; fieldLabel: string; value: string | boolean; exact: boolean }
    | { index: number; kind: 'text'; fieldLabel: string; value: string; exact: boolean }
    | { index: number; kind: 'choice'; fieldLabel: string; value: string; exact: boolean; choiceType: ClientChoiceType | null }
    | { index: number; kind: 'toggle'; label: string; checked: boolean; exact: boolean; controlType: 'checkbox' | 'radio' | null }

  const results = fields.map(() => false)

  for (const frame of page.frames()) {
    const pending: NativeBatchPendingField[] = []
    for (let index = 0; index < fields.length; index++) {
      if (results[index]) continue
      const field = fields[index]!
      if (field.kind === 'file') continue
      if (field.kind === 'auto') {
        pending.push({
          index,
          kind: 'auto',
          fieldLabel: field.fieldLabel,
          value: field.value,
          exact: field.exact ?? false,
        })
        continue
      }
      if (field.kind === 'text') {
        // Bug #2 (v1.43): if this text field's label looks like a
        // verification-code / OTP prompt AND its value is a plausible code
        // (4+ chars, no whitespace), skip the in-page native batch fill.
        // The native path writes `el.value = value` on the first matching
        // textbox, which for an OTP widget is cell 0 (maxlength=1) — the
        // assignment silently truncates to the first char, the readback
        // then reports "mismatch", and the fallback path tries again with
        // the same broken strategy. Leaving this field out of the native
        // batch means it falls through to `setFieldText`, which auto-
        // routes to the `fillOtp` primitive.
        if (labelLooksLikeOtp(field.fieldLabel) && /^\S{4,}$/.test(field.value)) {
          continue
        }
        // Keyboard timing / IME hints need the full `setFieldText` path.
        if (field.typingDelayMs !== undefined || field.imeFriendly) {
          continue
        }
        pending.push({
          index,
          kind: 'text',
          fieldLabel: field.fieldLabel,
          value: field.value,
          exact: field.exact ?? false,
        })
        continue
      }
      if (field.kind === 'choice') {
        pending.push({
          index,
          kind: 'choice',
          fieldLabel: field.fieldLabel,
          value: field.value,
          exact: field.exact ?? false,
          choiceType: field.choiceType ?? null,
        })
        continue
      }
      pending.push({
        index,
        kind: 'toggle',
        label: field.label,
        checked: field.checked ?? true,
        exact: field.exact ?? false,
        controlType: field.controlType ?? null,
      })
    }

    if (pending.length === 0) break

    const frameResults = await frame.evaluate((items) => {
      type ChoiceType = 'select' | 'group' | 'listbox' | null
      type NativeBatchField =
        | { index: number; kind: 'auto'; fieldLabel: string; value: string | boolean; exact: boolean }
        | { index: number; kind: 'text'; fieldLabel: string; value: string; exact: boolean }
        | { index: number; kind: 'choice'; fieldLabel: string; value: string; exact: boolean; choiceType: ChoiceType }
        | { index: number; kind: 'toggle'; label: string; checked: boolean; exact: boolean; controlType: 'checkbox' | 'radio' | null }

      function normalize(value: string | null | undefined): string {
        return (value ?? '').replace(/\s+/g, ' ').trim().toLowerCase()
      }

      function matches(candidate: string | null | undefined, expected: string, exact: boolean): boolean {
        const normalizedCandidate = normalize(candidate)
        const normalizedExpected = normalize(expected)
        if (!normalizedCandidate || !normalizedExpected) return false
        return exact ? normalizedCandidate === normalizedExpected : normalizedCandidate.includes(normalizedExpected)
      }

      function visible(el: Element): el is HTMLElement {
        if (!(el instanceof HTMLElement)) return false
        const rect = el.getBoundingClientRect()
        if (rect.width <= 0 || rect.height <= 0) return false
        const style = getComputedStyle(el)
        return style.display !== 'none' && style.visibility !== 'hidden'
      }

      function referencedText(ids: string | null, visited?: Set<string>): string | undefined {
        if (!ids) return undefined
        const seen = visited ?? new Set<string>()
        const text = ids
          .split(/\s+/)
          .map(id => {
            if (seen.has(id)) return ''
            seen.add(id)
            const target = document.getElementById(id)
            if (!target) return ''
            const chained = target.getAttribute('aria-labelledby')
            if (chained) return referencedText(chained, seen) ?? ''
            return target.textContent?.trim() ?? ''
          })
          .filter(Boolean)
          .join(' ')
          .trim()
        return text || undefined
      }

      function explicitLabelText(el: Element): string | undefined {
        const aria = el.getAttribute('aria-label')?.trim()
        if (aria) return aria
        const labelledBy = referencedText(el.getAttribute('aria-labelledby'))
        if (labelledBy) return labelledBy
        if (
          (el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) &&
          el.labels &&
          el.labels.length > 0
        ) {
          return el.labels[0]?.textContent?.trim() || undefined
        }
        if (el instanceof HTMLElement && el.id) {
          const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`)
          const text = label?.textContent?.trim()
          if (text) return text
        }
        if (el.parentElement?.tagName.toLowerCase() === 'label') {
          return el.parentElement.textContent?.trim() || undefined
        }
        if (
          (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) &&
          !['checkbox', 'radio', 'file', 'button', 'submit', 'reset', 'hidden'].includes(el instanceof HTMLInputElement ? el.type : '')
        ) {
          const placeholder = el.getAttribute('aria-placeholder')?.trim() || el.getAttribute('placeholder')?.trim()
          if (placeholder) return placeholder
        }
        if (el instanceof HTMLInputElement && ['button', 'submit', 'reset'].includes(el.type)) {
          const value = el.value?.trim()
          if (value) return value
        }
        const title = el.getAttribute('title')?.trim()
        if (title) return title
        return undefined
      }

      function dispatch(target: HTMLElement): void {
        target.dispatchEvent(new Event('input', { bubbles: true }))
        target.dispatchEvent(new Event('change', { bubbles: true }))
      }

      function clearReactTracker(target: HTMLInputElement | HTMLTextAreaElement | HTMLElement, nextChecked?: boolean): boolean {
        const tracker = (target as unknown as { _valueTracker?: { setValue: (value: string) => void } })._valueTracker
        if (!tracker || typeof tracker.setValue !== 'function') return false
        try {
          if (target instanceof HTMLInputElement && (target.type === 'checkbox' || target.type === 'radio')) {
            tracker.setValue(String(!(nextChecked ?? target.checked)))
          } else {
            tracker.setValue('')
          }
          return true
        } catch { /* ignore */ }
        return false
      }

      function setInputLikeValue(target: HTMLInputElement | HTMLTextAreaElement, next: string): void {
        const proto = target instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype
        const descriptor = Object.getOwnPropertyDescriptor(proto, 'value')
        if (descriptor?.set) descriptor.set.call(target, next)
        else target.value = next
      }

      function setInputCheckedReactAware(target: HTMLInputElement, next: boolean): boolean {
        const hadReactTracker = clearReactTracker(target, next)
        if (!hadReactTracker && target.checked === next) return true
        const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked')
        if (descriptor?.set) descriptor.set.call(target, next)
        else target.checked = next
        dispatch(target)
        return target.checked === next
      }

      function currentValue(el: Element): string {
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return el.value
        if (el instanceof HTMLSelectElement) return el.selectedOptions[0]?.textContent?.trim() || el.value
        if (el instanceof HTMLElement && el.isContentEditable) return el.innerText || el.textContent || ''
        return ''
      }

      function prefersGroupedChoice(input: string): boolean {
        const normalized = normalize(input)
        return normalized === 'yes' ||
          normalized === 'no' ||
          normalized === 'true' ||
          normalized === 'false' ||
          normalized === 'decline' ||
          normalized === 'prefer not' ||
          normalized === 'opt out'
      }

      /** Keep in sync with `packages/proxy/src/input-canonical.ts` `canonicalizeHtmlInputValue`. */
      function canonicalizeHtmlInputValueInPage(inputType: string, raw: string): string {
        const t = (inputType || 'text').toLowerCase()
        if (
          t === ''
          || t === 'text'
          || t === 'search'
          || t === 'url'
          || t === 'tel'
          || t === 'email'
          || t === 'password'
          || t === 'textarea'
          || t === 'hidden'
        ) {
          return raw
        }
        const s = raw.trim()
        if (!s) return raw
        if (t === 'number' || t === 'range') {
          const cleaned = s.replace(/,/g, '').replace(/\s/g, '')
          const n = parseFloat(cleaned)
          if (Number.isFinite(n)) return String(n)
          return raw
        }
        if (t === 'date') {
          if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s
          const d = new Date(s)
          if (!Number.isNaN(d.getTime())) {
            const y = d.getFullYear()
            const m = String(d.getMonth() + 1).padStart(2, '0')
            const day = String(d.getDate()).padStart(2, '0')
            return `${y}-${m}-${day}`
          }
          return raw
        }
        if (t === 'datetime-local') {
          if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) return s.slice(0, 16)
          const d = new Date(s)
          if (!Number.isNaN(d.getTime())) {
            const y = d.getFullYear()
            const mo = String(d.getMonth() + 1).padStart(2, '0')
            const day = String(d.getDate()).padStart(2, '0')
            const h = String(d.getHours()).padStart(2, '0')
            const min = String(d.getMinutes()).padStart(2, '0')
            return `${y}-${mo}-${day}T${h}:${min}`
          }
          return raw
        }
        if (t === 'time') {
          const tm = /^(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(s)
          if (tm) {
            const hh = Math.min(23, Math.max(0, parseInt(tm[1]!, 10)))
            const mm = tm[2]!
            const ss = tm[3]
            const h = String(hh).padStart(2, '0')
            return ss ? `${h}:${mm}:${ss}` : `${h}:${mm}`
          }
          return s
        }
        if (t === 'month') {
          if (/^\d{4}-\d{2}$/.test(s)) return s
          const d = new Date(s)
          if (!Number.isNaN(d.getTime())) {
            const y = d.getFullYear()
            const mo = String(d.getMonth() + 1).padStart(2, '0')
            return `${y}-${mo}`
          }
          return raw
        }
        if (t === 'week') {
          const wm = /^(\d{4})-w(\d{2})$/i.exec(s)
          if (wm) return `${wm[1]}-W${wm[2]}`
          return raw
        }
        return raw
      }

      function collectTextControlsDeep(): Element[] {
        const parts = ['input', 'textarea', '[contenteditable="true"]']
        const seen = new Set<Element>()
        const out: Element[] = []
        function visit(root: Document | ShadowRoot) {
          for (const part of parts) {
            try {
              root.querySelectorAll(part).forEach((el) => {
                if (!seen.has(el)) {
                  seen.add(el)
                  out.push(el)
                }
              })
            } catch { /* ignore */ }
          }
          root.querySelectorAll('*').forEach((host) => {
            if (host.shadowRoot) visit(host.shadowRoot)
          })
        }
        visit(document)
        return out
      }

      function isPlainContentEditableBatch(host: HTMLElement): boolean {
        if (!host.isContentEditable) return true
        for (const node of host.childNodes) {
          if (node.nodeType === Node.TEXT_NODE) continue
          if (node.nodeType === Node.ELEMENT_NODE) {
            const tag = (node as Element).tagName.toLowerCase()
            if (tag === 'br' && host.childNodes.length === 1) continue
            return false
          }
        }
        return true
      }

      function setTextField(fieldLabel: string, value: string, exact: boolean): boolean {
        const controls = collectTextControlsDeep()
        for (const control of controls) {
          if (!(control instanceof Element) || !visible(control)) continue
          if (control instanceof HTMLInputElement && ['checkbox', 'radio', 'file', 'button', 'submit', 'reset', 'hidden'].includes(control.type)) {
            continue
          }
          if (!matches(explicitLabelText(control), fieldLabel, exact)) continue
          if (control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement) {
            const inputType = control instanceof HTMLInputElement ? control.type : 'textarea'
            const v = canonicalizeHtmlInputValueInPage(inputType, value)
            control.focus()
            clearReactTracker(control)
            setInputLikeValue(control, v)
            dispatch(control)
            return matches(currentValue(control), v, false)
          }
          if (control instanceof HTMLElement && control.isContentEditable) {
            if (!isPlainContentEditableBatch(control)) return false
            control.focus()
            clearReactTracker(control)
            control.textContent = value
            dispatch(control)
            return matches(currentValue(control), value, false)
          }
        }
        return false
      }

      function setSelectField(fieldLabel: string, value: string, exact: boolean): boolean {
        const controls = Array.from(document.querySelectorAll('select'))
        for (const control of controls) {
          if (!(control instanceof HTMLSelectElement) || !visible(control)) continue
          if (!matches(explicitLabelText(control), fieldLabel, exact)) continue
          const expected = normalize(value)
          const option = Array.from(control.options).find((candidate) => {
            const label = normalize(candidate.textContent)
            const rawValue = normalize(candidate.value)
            return exact ? label === expected || rawValue === expected : label.includes(expected) || rawValue.includes(expected)
          })
          if (!option) return false
          control.value = option.value
          dispatch(control)
          return matches(currentValue(control), value, false) || normalize(control.value) === expected
        }
        return false
      }

      function groupPrompt(container: Element): string | undefined {
        const legend = container.querySelector('legend')?.textContent?.trim()
        if (legend) return legend
        const explicit = explicitLabelText(container)
        if (explicit) return explicit
        const textLike = container.querySelector('h1, h2, h3, h4, h5, h6, p, span, div')
        const text = textLike?.textContent?.trim()
        return text || undefined
      }

      function choiceLabel(el: Element): string | undefined {
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
          return explicitLabelText(el)
        }
        if (el instanceof HTMLLabelElement) return el.textContent?.trim() || undefined
        const explicit = explicitLabelText(el)
        if (explicit) return explicit
        return el.textContent?.trim() || undefined
      }

      // Snapshot every state attribute that React-style stateful buttons
      // typically toggle on selection. Used to verify that a click on a
      // button-shaped group radio actually committed (not a structural
      // no-op). Mirrors `selectionSignature` in `chooseValueFromLabeledGroup`
      // — kept in sync because they live in different page.evaluate scopes.
      function selectionSignature(opts: Element[]): string {
        return opts.map(el => {
          const ariaPressed = el.getAttribute('aria-pressed') ?? ''
          const ariaChecked = el.getAttribute('aria-checked') ?? ''
          const ariaSelected = el.getAttribute('aria-selected') ?? ''
          const dataState = el.getAttribute('data-state') ?? ''
          const dataSelected = el.getAttribute('data-selected') ?? ''
          const className = (el instanceof HTMLElement ? el.className : '') ?? ''
          const checked = el instanceof HTMLInputElement ? String(el.checked) : ''
          return `${ariaPressed}|${ariaChecked}|${ariaSelected}|${dataState}|${dataSelected}|${className}|${checked}`
        }).join('||')
      }

      function setGroupedChoice(fieldLabel: string, value: string, exact: boolean): boolean {
        const groups = Array.from(document.querySelectorAll('fieldset, [role="radiogroup"], [role="group"]'))
          .filter((el): el is HTMLElement => visible(el) && matches(groupPrompt(el), fieldLabel, exact))
        for (const group of groups) {
          const options = Array.from(
            group.querySelectorAll('input[type="radio"], input[type="checkbox"], [role="radio"], [role="checkbox"], label, button'),
          )
          for (const option of options) {
            if (!(option instanceof Element) || !visible(option)) continue
            if (!matches(choiceLabel(option), value, exact)) continue

            if (option instanceof HTMLInputElement) {
              return setInputCheckedReactAware(option, true)
            }
            if (option instanceof HTMLLabelElement) {
              const control = option.control
              if (control instanceof HTMLInputElement) return setInputCheckedReactAware(control, true)
              option.click()
              return true
            }
            // role=radio / role=checkbox: click and verify aria-checked
            // / aria-selected. The native batch fill used to silently return
            // true here, which masked Pinecone's commit-on-rerender bug.
            if (option.getAttribute('role') === 'radio' || option.getAttribute('role') === 'checkbox') {
              option.click()
              return (
                option.getAttribute('aria-checked') === 'true' ||
                option.getAttribute('aria-selected') === 'true'
              )
            }
            // Plain <button> path. This is where Pinecone / LangChain Ashby
            // Yes/No groups land. The native batch fill previously returned
            // true unconditionally, masking the silent-fail mode where the
            // form re-renders mid-flow with a shifted field-id prefix that
            // wipes the radio's commit state. Snapshot the group's selection
            // signature, click, then re-snapshot — if nothing changed, the
            // click was a structural no-op and we return false so the higher-
            // level setFieldChoice fallback (chooseValueFromLabeledGroup,
            // which has its own retry logic) can take over. Bug surfaced by
            // JobForge round-2 marathon — Pinecone Sr SWE Database Team
            // #320 and LangChain SE Manager #325.
            const beforeSig = selectionSignature(options)
            option.click()
            const afterSig = selectionSignature(options)
            if (beforeSig === afterSig) return false
            return true
          }
        }
        return false
      }

      function setToggle(label: string, checked: boolean, exact: boolean, controlType: 'checkbox' | 'radio' | null): boolean {
        const inputs = Array.from(document.querySelectorAll('input[type="checkbox"], input[type="radio"]'))
        for (const input of inputs) {
          if (!(input instanceof HTMLInputElement) || !visible(input)) continue
          if (controlType && input.type !== controlType) continue
          if (!matches(explicitLabelText(input), label, exact)) continue
          if (!setInputCheckedReactAware(input, checked)) return false
          return input.checked === checked
        }

        const labels = Array.from(document.querySelectorAll('label'))
        for (const labelEl of labels) {
          if (!(labelEl instanceof HTMLLabelElement) || !visible(labelEl)) continue
          if (!matches(labelEl.textContent, label, exact)) continue
          const control = labelEl.control
          if (!(control instanceof HTMLInputElement)) continue
          if (controlType && control.type !== controlType) continue
          if (!setInputCheckedReactAware(control, checked)) return false
          return control.checked === checked
        }

        return false
      }

      function setAutoField(fieldLabel: string, value: string | boolean, exact: boolean): boolean {
        if (typeof value === 'boolean') {
          if (setGroupedChoice(fieldLabel, value ? 'Yes' : 'No', exact)) return true
          if (setToggle(fieldLabel, value, exact, null)) return true
          return setSelectField(fieldLabel, value ? 'Yes' : 'No', exact)
        }

        if (prefersGroupedChoice(value) && setGroupedChoice(fieldLabel, value, exact)) return true
        if (setSelectField(fieldLabel, value, exact)) return true
        if (setTextField(fieldLabel, value, exact)) return true
        return setGroupedChoice(fieldLabel, value, exact)
      }

      return items.map((field: NativeBatchField) => {
        if (field.kind === 'auto') {
          return { index: field.index, ok: setAutoField(field.fieldLabel, field.value, field.exact) }
        }
        if (field.kind === 'text') return { index: field.index, ok: setTextField(field.fieldLabel, field.value, field.exact) }
        if (field.kind === 'choice') {
          if (field.choiceType === 'group') {
            return { index: field.index, ok: setGroupedChoice(field.fieldLabel, field.value, field.exact) }
          }
          if (field.choiceType === 'listbox') {
            return { index: field.index, ok: false }
          }
          const selected = setSelectField(field.fieldLabel, field.value, field.exact)
          if (selected) return { index: field.index, ok: true }
          return { index: field.index, ok: setGroupedChoice(field.fieldLabel, field.value, field.exact) }
        }
        return { index: field.index, ok: setToggle(field.label, field.checked, field.exact, field.controlType) }
      })
    }, pending).catch(() => [] as Array<{ index: number; ok: boolean }>)

    for (const entry of frameResults) {
      if (entry?.ok === true) results[entry.index] = true
    }
  }

  return results
}

/**
 * Regex covering every field label the Greenhouse / Ashby / Lever / Workday
 * verification-code / security-code / 2FA UIs use. Matching this on a fill
 * target triggers the OTP-box detection path before falling back to the
 * plain text-fill pipeline. Shared between setFieldText, fillFields, and
 * the explicit geometra_fill_otp tool so any entry point auto-handles the
 * 8-cell input pattern. See Bug #2 in the v1.43 release notes for the
 * Greenhouse 8-box security-code flow that broke without this.
 */
const OTP_LABEL_HINT_PATTERN =
  /(security|verification|one[- ]?time|authentication|access)\s*code|\botp\b|\bpasscode\b|\b2fa\b|\bmfa\b/i

function labelLooksLikeOtp(label: string | undefined): boolean {
  if (!label) return false
  return OTP_LABEL_HINT_PATTERN.test(label)
}

interface OtpBoxGroup {
  /** Playwright locator resolving to the full list of OTP cells in visual order. */
  boxes: Locator
  /** Count of cells — same as the value length we expect to type. */
  cellCount: number
}

/**
 * Find an OTP / verification-code input group on the page.
 *
 * An OTP group is detected when a frame contains ≥2 sibling `<input>`
 * elements where each:
 *   - has `maxlength="1"` (or `maxLength: 1` via the DOM property)
 *   - has `type="text"`, `type="tel"`, `type="number"`, `inputmode="numeric"`,
 *     or an empty type (defaults to text)
 *   - shares a common parent with the others
 *   - has a roughly comparable y-coordinate (same row) and strictly
 *     increasing x-coordinates (left-to-right visual order)
 *
 * When `fieldLabel` is passed, the search is scoped to the nearest
 * labelled form section containing that label (so the generic detector
 * cannot be hijacked by an unrelated per-character autosave field
 * elsewhere on the page).
 *
 * Returns the group as a Playwright `Locator` referring to ALL boxes in
 * DOM order, plus the cell count. The caller clicks box 0 via the
 * center-of-bounds coordinate path (semantic click resolves to whichever
 * box paints topmost, which in Greenhouse's layout is always box 7) and
 * uses `page.keyboard.type(value, { delay })` to feed characters one by
 * one, letting React's onKeyDown focus-advance handler commit each cell.
 */
async function findOtpBoxGroup(
  page: Page,
  fieldLabel: string | undefined,
  expectedLength: number | undefined,
): Promise<OtpBoxGroup | null> {
  for (const frame of page.frames()) {
    // If a label is provided, scope the search to that label's nearest
    // ancestor form section. Without this, the generic detector could
    // hijack an unrelated row of per-character inputs elsewhere on the
    // page (e.g. a zip-code splitter elsewhere in the form).
    let scope: ElementHandle<Element> | null = null
    if (fieldLabel) {
      try {
        const labeledInput = await frame
          .getByLabel(fieldLabel, { exact: false })
          .first()
          .elementHandle({ timeout: 500 })
        if (labeledInput) {
          // Walk up to the nearest form/fieldset/group wrapper so the
          // sibling scan has a stable root even when the label is not a
          // direct parent.
          scope = await labeledInput.evaluateHandle((el) => {
            let cur: Element | null = el
            for (let depth = 0; depth < 6 && cur; depth++) {
              if (
                cur.tagName === 'FORM' ||
                cur.tagName === 'FIELDSET' ||
                cur.getAttribute('role') === 'group' ||
                cur.getAttribute('role') === 'form' ||
                (cur.getAttribute('class') ?? '').toLowerCase().includes('otp') ||
                (cur.getAttribute('data-otp') !== null)
              ) {
                return cur
              }
              cur = cur.parentElement
            }
            return el.parentElement ?? el
          }) as ElementHandle<Element> | null
        }
      } catch {
        scope = null
      }
    }

    type OtpCandidate = { cssSelector: string; count: number }
    const candidate: OtpCandidate | null = await frame.evaluate(
      ({ scopeHint, wantLength }) => {
        const scopeRoot: Element = scopeHint ?? document.body
        if (!scopeRoot) return null

        // Gather every <input> in the scope whose maxlength is 1.
        const all = Array.from(scopeRoot.querySelectorAll('input')) as HTMLInputElement[]
        const singles = all.filter((input) => {
          if (!input.isConnected) return false
          const style = getComputedStyle(input)
          if (style.display === 'none' || style.visibility === 'hidden') return false
          const rect = input.getBoundingClientRect()
          if (rect.width <= 0 || rect.height <= 0) return false
          const maxAttr = input.getAttribute('maxlength')
          const max = maxAttr !== null ? Number(maxAttr) : input.maxLength
          if (!Number.isFinite(max) || max !== 1) return false
          const type = (input.type ?? 'text').toLowerCase()
          if (type && !['text', 'tel', 'number', 'password', ''].includes(type)) return false
          return true
        })

        if (singles.length < 2) return null

        // Group by direct parent — all cells of an OTP widget are siblings
        // inside a single wrapper (the `<input>`s might be wrapped in a
        // span each, but the wrappers share the same grandparent row).
        const byParent = new Map<Element, HTMLInputElement[]>()
        for (const input of singles) {
          // Climb up to the nearest wrapper that contains ALL siblings
          // on the same row.
          let wrapper: Element | null = input.parentElement
          for (let depth = 0; depth < 3 && wrapper; depth++) {
            const group = byParent.get(wrapper) ?? []
            group.push(input)
            byParent.set(wrapper, group)
            wrapper = wrapper.parentElement
          }
        }

        // Score candidate groups: a group qualifies if all its inputs are
        // on the same row (y-delta < 8px) and their x-coordinates are
        // strictly increasing (left-to-right). Accept the largest
        // qualifying group.
        let best: { inputs: HTMLInputElement[]; root: Element } | null = null
        for (const [root, inputs] of byParent.entries()) {
          if (inputs.length < 2) continue
          // De-dup since a given input will be counted under multiple
          // wrapper ancestors during the climb above.
          const unique = Array.from(new Set(inputs))
          if (unique.length < 2) continue
          const sorted = unique
            .map((input) => ({ input, rect: input.getBoundingClientRect() }))
            .sort((a, b) => a.rect.left - b.rect.left)
          const rows = sorted.map((entry) => entry.rect.top)
          const yMin = Math.min(...rows)
          const yMax = Math.max(...rows)
          if (yMax - yMin > 8) continue
          let increasing = true
          for (let i = 1; i < sorted.length; i++) {
            if (sorted[i]!.rect.left <= sorted[i - 1]!.rect.left) {
              increasing = false
              break
            }
          }
          if (!increasing) continue
          if (!best || sorted.length > best.inputs.length) {
            best = { inputs: sorted.map((entry) => entry.input), root }
          }
        }

        if (!best) return null
        if (wantLength !== undefined && best.inputs.length !== wantLength) {
          // Only accept the group if its cell count is compatible with
          // the typed value. Compatibility: either exact match, or the
          // group is ≥ the value length (allow typing a 6-char code into
          // an 8-box group with 2 empty trailing boxes).
          if (best.inputs.length < wantLength) return null
        }

        // Stamp a unique data attribute on each cell so the caller can
        // address them unambiguously via a single selector. Using a
        // content-hash-ish random id avoids collisions with existing
        // data attributes and re-renders across re-entry.
        //
        // Before stamping the new marker, strip any STALE markers from
        // ALL prior calls anywhere in the document. Without this, a re-rendered
        // OTP form (e.g. after a stale-OTP submit failure) can leave detached
        // nodes carrying old data-geometra-otp-* attributes that selectors
        // could otherwise hit before resolving the live cells. (Bug surfaced
        // by JobForge round-2 marathon — Glean ML Engineer #174.)
        const stale = document.querySelectorAll('[data-geometra-otp-stamp]')
        for (const node of Array.from(stale)) {
          for (const attr of Array.from(node.attributes)) {
            if (attr.name.startsWith('data-geometra-otp-')) {
              node.removeAttribute(attr.name)
            }
          }
        }
        const marker = `data-geometra-otp-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
        best.inputs.forEach((input, index) => {
          input.setAttribute(marker, String(index))
          input.setAttribute('data-geometra-otp-stamp', '1')
        })
        return { cssSelector: `[${marker}]`, count: best.inputs.length }
      },
      { scopeHint: scope, wantLength: expectedLength },
    )

    if (candidate) {
      return {
        boxes: frame.locator(candidate.cssSelector),
        cellCount: candidate.count,
      }
    }
  }
  return null
}

/**
 * Fill an OTP / verification-code input group with a value, char by char.
 *
 * Detection is generic — see `findOtpBoxGroup`. The actual typing strategy
 * uses `page.keyboard.type()` (not a low-level `keyboard.insertText()`
 * batch) so that every char dispatches a real keydown/keypress/keyup event
 * cycle, which is what React's per-cell onKeyDown handler listens for to
 * auto-advance focus to the next box.
 *
 * Why not `fill_form` or `fill_fields` for this? The 8 boxes share
 * accessible bounds because they're visually adjacent and a11y collapses
 * them into one logical textbox node. Any semantic "find the textbox and
 * write 8 chars" path writes the entire string to box 0, which has
 * maxlength=1 and silently truncates to one char. The pattern can only be
 * driven through physical key events.
 *
 * Verification: after typing, read the `.value` of every box and confirm
 * it matches the expected per-cell char. Throws a descriptive error if
 * verification fails so callers get an honest failure instead of a silent
 * "success" that leaves the form in a bad state.
 */
export async function fillOtp(
  page: Page,
  value: string,
  opts?: { fieldLabel?: string; perCharDelayMs?: number },
): Promise<{ cellCount: number; filledCount: number }> {
  if (!value) {
    throw new Error('fillOtp: value is empty — nothing to type')
  }
  const group = await findOtpBoxGroup(page, opts?.fieldLabel, value.length)
  if (!group) {
    throw new Error(
      `fillOtp: no OTP box group found${opts?.fieldLabel ? ` near label "${opts.fieldLabel}"` : ''}. Expected ≥2 sibling <input maxlength="1"> elements on the same row.`,
    )
  }

  // Sanity check: the locator we just stamped must resolve to exactly the
  // expected number of cells, all connected to the live document. If the
  // form re-rendered between findOtpBoxGroup's marker stamp and now, the
  // marker may have been wiped from the DOM and the count drops to 0.
  // Throw a clear stale-cell error rather than proceeding to type into
  // nothing. (Bug surfaced by JobForge round-2 marathon — Glean ML
  // Engineer #174 second-attempt failure.)
  const liveCount = await group.boxes.count()
  if (liveCount !== group.cellCount) {
    throw new Error(
      `fillOtp: OTP cell group went stale before fill (expected ${group.cellCount} cells, found ${liveCount}). The form likely re-rendered between detection and fill — retry the call.`,
    )
  }

  // Click the leftmost box via its center point. We use a low-level
  // bounding-box click because a semantic "click the first input" path
  // resolves to whichever input paints topmost in the stacking order,
  // which in Greenhouse's CSS grid layout is always box N-1 (the last
  // cell). The bounding-box center click is unambiguous and puts focus on
  // cell 0 every time.
  const firstBox = group.boxes.nth(0)
  await firstBox.scrollIntoViewIfNeeded()
  const box = await firstBox.boundingBox()
  if (!box) {
    throw new Error('fillOtp: first OTP cell has no bounding box (detached or invisible?)')
  }
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)

  // Verify focus actually landed on a cell of THIS group (not a stacked
  // overlay or a sibling element that happened to share the click point).
  // If the click missed, typing would feed characters to whatever element
  // happens to hold focus — usually nothing useful — and the readback
  // would mysteriously show all-empty cells.
  const focusedOnGroup = await firstBox.evaluate((el) => {
    const active = document.activeElement
    if (!active) return false
    // Either the click landed on cell 0 itself, or focus auto-advanced to
    // a sibling cell with the same data-geometra-otp-stamp.
    return active === el || (active instanceof HTMLElement && active.hasAttribute('data-geometra-otp-stamp'))
  })
  if (!focusedOnGroup) {
    throw new Error(
      'fillOtp: bounding-box click on cell 0 did not land focus inside the OTP group. The cell may be covered by an overlay or the group is stale — retry after re-detecting.',
    )
  }

  // Clear any pre-existing values in all cells so we write a clean slate.
  // Some widgets pre-populate cells with zero-width spaces or previous
  // values after a re-render; typing over them would offset the
  // auto-advance count by one.
  const perCellCount = group.cellCount
  for (let i = 0; i < perCellCount; i++) {
    try {
      await group.boxes.nth(i).evaluate((el) => {
        if (el instanceof HTMLInputElement) {
          el.value = ''
          el.dispatchEvent(new Event('input', { bubbles: true }))
          el.dispatchEvent(new Event('change', { bubbles: true }))
        }
      })
    } catch {
      /* individual cell may have been removed/re-rendered; tolerate */
    }
  }
  // Re-focus cell 0 after clearing — dispatching input events may have
  // blurred the active element on some React builds.
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)

  // Type the value char by char. `page.keyboard.type` already dispatches
  // keydown+keypress+input+keyup for each character and honors the delay.
  // 30ms is enough for React's onKeyDown handler to run and move focus
  // to the next cell before the next char arrives.
  const perCharDelay = opts?.perCharDelayMs ?? 30
  await page.keyboard.type(value, { delay: perCharDelay })

  // Small settle window for the last cell's onChange propagation.
  await delay(80)

  const expected = Array.from(value)
  const liveGroup = group

  // Readback helper — reads every cell's current value / text content so
  // we can compare against the expected char at the same index.
  async function readCurrentCells(): Promise<string[]> {
    const out: string[] = []
    for (let i = 0; i < perCellCount; i++) {
      const cellValue = await liveGroup.boxes.nth(i).evaluate((el) => {
        if (el instanceof HTMLInputElement) return el.value
        if (el instanceof HTMLElement) return el.textContent ?? ''
        return ''
      })
      out.push(cellValue ?? '')
    }
    return out
  }

  let readback = await readCurrentCells()
  let mismatches = computeOtpMismatches(readback, expected)

  // Recovery path: some Greenhouse / React builds let cell 0 accept the
  // entire string because the onKeyDown auto-advance handler fires after
  // the input event, so the first char lands in cell 0 but the second
  // char also lands there (no maxlength enforcement on a controlled input)
  // — cells 1..N-1 end up empty and cell 0 holds the full value. Also
  // observed: partial fills where cells 0..K hold multiple chars and
  // cells K+1.. hold the rest. Rather than throwing and asking the caller
  // to retry fresh (which often hits the same race), we do a deterministic
  // per-cell recovery: clear every cell again, then for EACH cell
  // individually click its center and type exactly one char. This is
  // slower (~N clicks) but guarantees a 1:1 mapping regardless of whether
  // the widget's focus-advance handler is working. Surfaced by the
  // JobForge Hex AI Engineering Lead #310 apply flow on 2026-04-11, where
  // the initial `page.keyboard.type` dumped "ctUwV3" into cell 0 and
  // "c"/"t"/"U" into cells 5/6/7 (focus advanced erratically late in the
  // typing sequence), and the post-verify readback momentarily showed a
  // stale-but-matching state so the tool returned success.
  if (mismatches.length > 0) {
    // Capture per-cell bounding boxes BEFORE any clearing / re-typing so
    // we have stable screen coordinates to click even if the widget
    // re-renders mid-recovery.
    const cellBoxes: Array<{ x: number; y: number; width: number; height: number } | null> = []
    for (let i = 0; i < perCellCount; i++) {
      try {
        cellBoxes.push(await group.boxes.nth(i).boundingBox())
      } catch {
        cellBoxes.push(null)
      }
    }

    // Clear every cell again. React-controlled cells sometimes reject a
    // direct `.value = ''` the first time; pairing the DOM reset with a
    // keyboard Select-All + Delete cycle per cell during the type loop
    // below is more reliable.
    for (let i = 0; i < perCellCount; i++) {
      try {
        await group.boxes.nth(i).evaluate((el) => {
          if (el instanceof HTMLInputElement) {
            el.value = ''
            el.dispatchEvent(new Event('input', { bubbles: true }))
            el.dispatchEvent(new Event('change', { bubbles: true }))
          }
        })
      } catch {
        /* tolerate */
      }
    }

    // Per-cell typing: click each cell at its center, then type the single
    // expected char. We do NOT rely on the widget's auto-advance — we
    // always explicitly click the next cell for the next char. Before
    // typing, reset the target cell's value directly in the DOM so the
    // new char overwrites instead of appending. This is faster and more
    // deterministic than going through the keyboard Select-All + Delete
    // path on every cell.
    for (let i = 0; i < expected.length; i++) {
      const cellBox = cellBoxes[i]
      if (!cellBox) continue
      try {
        await liveGroup.boxes.nth(i).evaluate((el) => {
          if (el instanceof HTMLInputElement) {
            el.value = ''
            el.dispatchEvent(new Event('input', { bubbles: true }))
            el.dispatchEvent(new Event('change', { bubbles: true }))
          }
        })
      } catch {
        /* tolerate */
      }
      const cx = cellBox.x + cellBox.width / 2
      const cy = cellBox.y + cellBox.height / 2
      await page.mouse.click(cx, cy)
      await page.keyboard.type(expected[i]!, { delay: perCharDelay })
    }

    // Settle, re-read, re-compare.
    await delay(60)
    readback = await readCurrentCells()
    mismatches = computeOtpMismatches(readback, expected)
  }

  // Final verification. If recovery did not resolve the mismatch, throw
  // with the full diagnostic so callers get an honest failure instead of
  // a silent "success" that leaves cells holding the wrong chars.
  if (mismatches.length > 0) {
    const allEmpty = readback.slice(0, expected.length).every((v) => v === '')
    if (allEmpty) {
      throw new Error(
        `fillOtp: typed ${expected.length} chars but ALL ${expected.length} target cells are still empty after per-cell recovery. Focus was lost mid-flow or the cell group was re-rendered after detection. Retry the call to re-detect the live cells.`,
      )
    }
    const summary = mismatches
      .map((m) => `cell ${m.index}: expected "${m.expected}", got "${m.got}"`)
      .join('; ')
    throw new Error(
      `fillOtp: typed ${expected.length} chars into ${perCellCount}-cell group but readback mismatch even after per-cell recovery — ${summary}. Readback: [${readback.map((v) => JSON.stringify(v)).join(', ')}]`,
    )
  }

  return { cellCount: perCellCount, filledCount: expected.length }
}

function computeOtpMismatches(
  readback: string[],
  expected: string[],
): Array<{ index: number; expected: string; got: string }> {
  const mismatches: Array<{ index: number; expected: string; got: string }> = []
  for (let i = 0; i < expected.length; i++) {
    if (readback[i] !== expected[i]) {
      mismatches.push({ index: i, expected: expected[i]!, got: readback[i] ?? '' })
    }
  }
  return mismatches
}

export async function setFieldText(
  page: Page,
  fieldLabel: string,
  value: string,
  opts?: {
    exact?: boolean
    cache?: FillLookupCache
    fieldId?: string
    /** Delay between keystrokes when using keyboard typing fallback (masked inputs). */
    typingDelayMs?: number
    /** Composition events before assignment; small default key delay when typing. */
    imeFriendly?: boolean
  },
): Promise<void> {
  // Bug #2 (v1.43) auto-routing: if the caller's label looks like a
  // verification-code / security-code / OTP prompt, try the dedicated OTP
  // path first. If no OTP group is detected, fall through to the normal
  // text-fill path — the label match alone is not enough to guarantee the
  // field is split into cells. If the group IS detected, any thrown error
  // from fillOtp propagates out of setFieldText unchanged: silent fallback
  // to the plain text-fill path would write the whole string into box 0
  // and pretend success, which is the bug we're fixing.
  if (labelLooksLikeOtp(fieldLabel) && /^\S{4,}$/.test(value)) {
    const group = await findOtpBoxGroup(page, fieldLabel, value.length)
    if (group) {
      await fillOtp(page, value, { fieldLabel })
      return
    }
  }

  const exact = opts?.exact ?? false
  const locator = await findLabeledEditableField(page, fieldLabel, exact, opts?.cache, opts?.fieldId)
  if (!locator) {
    throw new Error(`setFieldText: no visible editable field matching "${fieldLabel}"`)
  }

  await locator.scrollIntoViewIfNeeded()
  const inputType = await locator.evaluate(el => {
    if (el instanceof HTMLInputElement) return el.type
    if (el instanceof HTMLTextAreaElement) return 'textarea'
    return 'text'
  })
  const normalized = canonicalizeHtmlInputValue(inputType, value)
  const applied = await setLocatorTextValue(locator, normalized, { imeFriendly: opts?.imeFriendly })
  if (!applied) {
    try {
      await locator.fill(normalized)
    } catch {
      await locator.click()
      await typeIntoEditableLocator(page, locator, normalized, {
        delayMs: opts?.typingDelayMs ?? (opts?.imeFriendly ? 5 : undefined),
      })
    }
  }

  const current = await locatorCurrentValue(locator)
  if (fieldValueMatches(current, normalized)) return

  const displayed = await locatorDisplayedValues(locator)
  if (displayed.some(candidate => fieldValueMatches(candidate, normalized))) return

  throw new Error(`setFieldText: set "${fieldLabel}" but could not confirm value ${JSON.stringify(value)}`)
}

async function setNativeSelectByLabel(locator: Locator, value: string, exact: boolean): Promise<boolean> {
  try {
    return await locator.evaluate((el, payload) => {
      if (!(el instanceof HTMLSelectElement)) return false
      const normalize = (input: string | undefined | null) => input?.replace(/\s+/g, ' ').trim().toLowerCase() ?? ''
      const expected = normalize(payload.value)
      if (!expected) return false

      const option = Array.from(el.options).find((candidate) => {
        if (candidate.disabled) return false
        const label = normalize(candidate.textContent)
        const rawValue = normalize(candidate.value)
        if (payload.exact) return label === expected || rawValue === expected
        return label.includes(expected) || rawValue.includes(expected)
      })

      if (!option) return false
      el.value = option.value
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
      return true
    }, { value, exact })
  } catch {
    return false
  }
}

async function chooseValueFromLabeledGroup(
  page: Page,
  fieldLabel: string,
  value: string,
  exact: boolean,
): Promise<boolean> {
  for (const frame of page.frames()) {
    const matched = await frame.evaluate((payload) => {
      function normalize(input: string | undefined | null): string {
        return (input ?? '').replace(/\s+/g, ' ').trim().toLowerCase()
      }

      function visible(el: Element): el is HTMLElement {
        if (!(el instanceof HTMLElement)) return false
        const rect = el.getBoundingClientRect()
        if (rect.width <= 0 || rect.height <= 0) return false
        const style = getComputedStyle(el)
        return style.display !== 'none' && style.visibility !== 'hidden'
      }

      function matches(candidate: string | undefined | null): boolean {
        const normalizedCandidate = normalize(candidate)
        const normalizedExpected = normalize(payload.fieldLabel)
        if (!normalizedCandidate || !normalizedExpected) return false
        return payload.exact ? normalizedCandidate === normalizedExpected : normalizedCandidate.includes(normalizedExpected)
      }

      function matchesChoice(candidate: string | undefined | null): boolean {
        const normalizedCandidate = normalize(candidate)
        const normalizedExpected = normalize(payload.value)
        if (!normalizedCandidate || !normalizedExpected) return false
        return payload.exact ? normalizedCandidate === normalizedExpected : normalizedCandidate.includes(normalizedExpected)
      }

      function referencedText(ids: string | null, visited?: Set<string>): string | undefined {
        if (!ids) return undefined
        const seen = visited ?? new Set<string>()
        const text = ids
          .split(/\s+/)
          .map(id => {
            if (seen.has(id)) return ''
            seen.add(id)
            const target = document.getElementById(id)
            if (!target) return ''
            const chained = target.getAttribute('aria-labelledby')
            if (chained) return referencedText(chained, seen) ?? ''
            return target.textContent?.trim() ?? ''
          })
          .filter(Boolean)
          .join(' ')
          .trim()
        return text || undefined
      }

      function explicitLabelText(el: Element): string | undefined {
        const aria = el.getAttribute('aria-label')?.trim()
        if (aria) return aria
        const labelledBy = referencedText(el.getAttribute('aria-labelledby'))
        if (labelledBy) return labelledBy
        if (el instanceof HTMLInputElement && el.labels && el.labels.length > 0) {
          return el.labels[0]?.textContent?.trim() || undefined
        }
        if (el.parentElement?.tagName.toLowerCase() === 'label') {
          return el.parentElement.textContent?.trim() || undefined
        }
        if (
          (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) &&
          !['checkbox', 'radio', 'file', 'button', 'submit', 'reset', 'hidden'].includes(el instanceof HTMLInputElement ? el.type : '')
        ) {
          const placeholder = el.getAttribute('aria-placeholder')?.trim() || el.getAttribute('placeholder')?.trim()
          if (placeholder) return placeholder
        }
        if (el instanceof HTMLInputElement && ['button', 'submit', 'reset'].includes(el.type)) {
          const value = el.value?.trim()
          if (value) return value
        }
        const title = el.getAttribute('title')?.trim()
        if (title) return title
        return undefined
      }

      function choiceLabel(el: Element): string | undefined {
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
          return explicitLabelText(el)
        }
        if (el instanceof HTMLLabelElement) return el.textContent?.trim() || undefined
        const aria = el.getAttribute('aria-label')?.trim()
        if (aria) return aria
        const labelledBy = referencedText(el.getAttribute('aria-labelledby'))
        if (labelledBy) return labelledBy
        return el.textContent?.trim() || undefined
      }

      function hasGroupedChoices(container: Element): boolean {
        const count = container.querySelectorAll('input[type="radio"], input[type="checkbox"], [role="radio"], [role="checkbox"], button').length
        return count >= 2
      }

      const candidates: Array<{ root: HTMLElement; score: number }> = []
      const explicitGroups = Array.from(document.querySelectorAll('fieldset, [role="radiogroup"], [role="group"]'))
        .filter((el): el is HTMLElement => visible(el) && hasGroupedChoices(el))
      for (const group of explicitGroups) {
        const legend = group.querySelector('legend')?.textContent?.trim()
        const groupName = explicitLabelText(group) || legend || group.textContent?.trim()
        if (matches(groupName)) {
          const rect = group.getBoundingClientRect()
          candidates.push({ root: group, score: rect.width * rect.height })
        }
      }

      const labelNodes = Array.from(document.querySelectorAll('label, legend, h1, h2, h3, h4, h5, h6, p, span, div'))
        .filter((el): el is HTMLElement => visible(el) && matches(el.textContent))
      for (const labelNode of labelNodes) {
        let current: HTMLElement | null = labelNode.parentElement
        for (let depth = 0; current && depth < 5; depth++) {
          if (visible(current) && hasGroupedChoices(current)) {
            const rect = current.getBoundingClientRect()
            candidates.push({ root: current, score: rect.width * rect.height + depth * 1000 })
            break
          }
          current = current.parentElement
        }
      }

      candidates.sort((a, b) => a.score - b.score)

      // Snapshot a stable "selection signature" for an option group so we can
      // verify that a click actually committed the choice. This is what
      // separates a real selection from a no-op click on a button whose
      // aria-label is unrelated to the visible text (Modal/Ashby pattern: Yes/No
      // buttons whose accessible name is the form name like "Application"
      // because the rendering library passed the wrong label down). The click
      // event fires, the DOM mutates a focus ring, and the legacy code returned
      // true unconditionally — but the controlled-component state never moved,
      // so the form failed validation on submit.
      //
      // The signature captures every state attribute and class list mutation
      // that React-style stateful buttons typically toggle on selection:
      // aria-pressed, aria-checked, aria-selected, data-state, class names,
      // disabled, and the input element's `checked` if present. If NONE of
      // these change after the click, the click was a no-op and we return false
      // so the caller falls through to the next strategy.
      function selectionSignature(opts: Element[]): string {
        return opts.map(el => {
          const ariaPressed = el.getAttribute('aria-pressed') ?? ''
          const ariaChecked = el.getAttribute('aria-checked') ?? ''
          const ariaSelected = el.getAttribute('aria-selected') ?? ''
          const dataState = el.getAttribute('data-state') ?? ''
          const dataSelected = el.getAttribute('data-selected') ?? ''
          const className = (el instanceof HTMLElement ? el.className : '') ?? ''
          const checked = el instanceof HTMLInputElement ? String(el.checked) : ''
          return `${ariaPressed}|${ariaChecked}|${ariaSelected}|${dataState}|${dataSelected}|${className}|${checked}`
        }).join('||')
      }

      function dispatch(target: HTMLElement): void {
        target.dispatchEvent(new Event('input', { bubbles: true }))
        target.dispatchEvent(new Event('change', { bubbles: true }))
      }

      function clearReactTracker(target: HTMLInputElement, next: boolean): boolean {
        const tracker = (target as unknown as { _valueTracker?: { setValue: (value: string) => void } })._valueTracker
        if (tracker && typeof tracker.setValue === 'function') {
          try {
            tracker.setValue(String(!next))
            return true
          } catch { /* ignore */ }
        }
        return false
      }

      function setInputCheckedReactAware(target: HTMLInputElement, next: boolean): boolean {
        const hadReactTracker = clearReactTracker(target, next)
        if (!hadReactTracker && target.checked === next) return true
        const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked')
        if (descriptor?.set) descriptor.set.call(target, next)
        else target.checked = next
        dispatch(target)
        return target.checked === next
      }

      for (const candidate of candidates) {
        const options = Array.from(
          candidate.root.querySelectorAll('input[type="radio"], input[type="checkbox"], [role="radio"], [role="checkbox"], label, button'),
        )

        for (const option of options) {
          if (!visible(option)) continue
          if (!matchesChoice(choiceLabel(option))) continue

          if (option instanceof HTMLInputElement) {
            return setInputCheckedReactAware(option, true)
          }
          if (option instanceof HTMLLabelElement) {
            const labelBeforeSig = selectionSignature(options)
            const control = option.control
            if (control instanceof HTMLInputElement) return setInputCheckedReactAware(control, true)
            option.click()
            // No backing input — verify via group signature change so we don't
            // silently no-op on label wrappers whose target is unparented.
            const labelAfterSig = selectionSignature(options)
            return labelBeforeSig !== labelAfterSig
          }
          if (option.getAttribute('role') === 'radio' || option.getAttribute('role') === 'checkbox') {
            option.click()
            return option.getAttribute('aria-checked') === 'true' || option.getAttribute('aria-selected') === 'true'
          }

          // Plain <button> path. This is where Modal/Ashby Yes/No buttons land
          // when their aria-label is broken. Snapshot the group's selection
          // signature, click, then re-snapshot. If nothing changed, the click
          // was a no-op — return false so the caller can try the next strategy
          // (pickListboxOption fallback, etc) instead of silently succeeding.
          const beforeSig = selectionSignature(options)
          option.click()
          const afterSig = selectionSignature(options)
          if (beforeSig === afterSig) {
            // Click was a structural no-op. Don't silently succeed.
            return false
          }
          return true
        }
      }

      return false
    }, { fieldLabel, value, exact })

    if (matched) return true
  }

  return false
}

async function autoFieldLocatorKind(locator: Locator): Promise<'select' | 'text' | 'choice' | 'unknown'> {
  try {
    return await locator.evaluate((el) => {
      if (el instanceof HTMLSelectElement) return 'select'
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return 'text'
      if (el instanceof HTMLElement && el.isContentEditable) return 'text'
      const role = el.getAttribute('role')
      if (role === 'combobox' || role === 'listbox') return 'choice'
      if (el instanceof HTMLButtonElement) return 'choice'
      if (el.getAttribute('aria-haspopup') === 'listbox') return 'choice'
      return 'unknown'
    })
  } catch {
    return 'unknown'
  }
}

export async function setAutoFieldValue(
  page: Page,
  fieldLabel: string,
  value: string | boolean,
  opts?: { exact?: boolean; cache?: FillLookupCache; fieldId?: string },
): Promise<void> {
  const exact = opts?.exact ?? false

  if (typeof value === 'boolean') {
    if (await chooseValueFromLabeledGroup(page, fieldLabel, value ? 'Yes' : 'No', exact)) return
    await setCheckedControl(page, fieldLabel, { checked: value, exact })
    return
  }

  if (prefersGroupedChoiceValue(value) && await chooseValueFromLabeledGroup(page, fieldLabel, value, exact)) {
    return
  }

  const locator = await findLabeledControlInPage(page, fieldLabel, exact, { cache: opts?.cache, fieldId: opts?.fieldId })
  if (locator) {
    const kind = await autoFieldLocatorKind(locator)
    if (kind === 'select') {
      await setFieldChoice(page, fieldLabel, value, {
        fieldId: opts?.fieldId,
        exact,
        choiceType: 'select',
        cache: opts?.cache,
      })
      return
    }
    if (kind === 'text') {
      await setFieldText(page, fieldLabel, value, {
        fieldId: opts?.fieldId,
        exact,
        cache: opts?.cache,
      })
      return
    }
    if (kind === 'choice') {
      await setFieldChoice(page, fieldLabel, value, {
        fieldId: opts?.fieldId,
        exact,
        cache: opts?.cache,
      })
      return
    }
  }

  if (await chooseValueFromLabeledGroup(page, fieldLabel, value, exact)) return

  try {
    await setFieldText(page, fieldLabel, value, {
      fieldId: opts?.fieldId,
      exact,
      cache: opts?.cache,
    })
    return
  } catch {
    await setFieldChoice(page, fieldLabel, value, {
      fieldId: opts?.fieldId,
      exact,
      cache: opts?.cache,
    })
  }
}

export async function setFieldChoice(
  page: Page,
  fieldLabel: string,
  value: string,
  opts?: { exact?: boolean; query?: string; choiceType?: ClientChoiceType; cache?: FillLookupCache; fieldId?: string },
): Promise<void> {
  const exact = opts?.exact ?? false

  const locator = await findLabeledControlInPage(page, fieldLabel, exact, { cache: opts?.cache, fieldId: opts?.fieldId })
  if (locator) {
    await locator.scrollIntoViewIfNeeded()
    const isNativeSelect = await locator.evaluate(el => el instanceof HTMLSelectElement)
    if (await setNativeSelectByLabel(locator, value, exact)) {
      const displayed = await locatorDisplayedValues(locator)
      if (displayed.some(candidate => displayedValueMatchesSelection(candidate, value, exact))) return
      throw new Error(`setFieldChoice: selected "${value}" for field "${fieldLabel}" but could not confirm it`)
    }
    // Avoid pickListboxOption on a real <select> — option text/value did not match.
    if (isNativeSelect) {
      throw new Error(
        `setFieldChoice: no enabled <option> matching "${value}" for native <select> "${fieldLabel}"`,
      )
    }
  }

  if (opts?.choiceType === 'group') {
    if (await chooseValueFromLabeledGroup(page, fieldLabel, value, exact)) return
    throw new Error(`setFieldChoice: no grouped choice matching "${value}" for field "${fieldLabel}"`)
  }

  try {
    await pickListboxOption(page, value, {
      fieldId: opts?.fieldId,
      fieldLabel,
      exact,
      query: opts?.query,
      cache: opts?.cache,
    })
    return
  } catch (listboxError) {
    if (await chooseValueFromLabeledGroup(page, fieldLabel, value, exact)) return
    throw listboxError
  }
}

export type FormFieldFill = ClientFillField

export async function fillFields(page: Page, fields: FormFieldFill[], cache = createFillLookupCache()): Promise<void> {
  const nativeResults = await attemptNativeBatchFill(page, fields)

  // Separate text fields (parallelizable) from interactive fields (sequential)
  const textFills: Array<{ field: FormFieldFill & { kind: 'text' } }> = []
  const otherFills: Array<{ index: number; field: FormFieldFill }> = []

  for (let index = 0; index < fields.length; index++) {
    if (nativeResults[index]) continue
    const field = fields[index]!
    if (field.kind === 'text') {
      textFills.push({ field: field as FormFieldFill & { kind: 'text' } })
    } else {
      otherFills.push({ index, field })
    }
  }

  // Fill text fields concurrently using allSettled, NOT all. Previously this
  // used Promise.all, which fails-fast on the first rejection — and the
  // remaining fills (including ALL choice/toggle/file fills below) never run.
  // This is exactly the partial-failure cascade that produced the Greenhouse
  // silent-fill bug: a text field with a truncated label (e.g. ellipsis from
  // a schema) couldn't be matched, threw, and left every required combobox
  // empty even though they would have committed cleanly on their own.
  //
  // Switching to allSettled means each text fill is honestly attempted, and
  // a partial failure surfaces as a single thrown error AT THE END (containing
  // all failed labels) instead of cascading through the rest of the batch.
  // The choice/toggle/file loop below always runs regardless.
  const textFillFailures: Array<{ label: string; error: string }> = []
  if (textFills.length > 0) {
    const results = await Promise.allSettled(textFills.map(({ field }) =>
      setFieldText(page, field.fieldLabel, field.value, {
        fieldId: field.fieldId,
        exact: field.exact,
        cache,
        typingDelayMs: field.typingDelayMs,
        imeFriendly: field.imeFriendly,
      }),
    ))
    for (let i = 0; i < results.length; i++) {
      const result = results[i]!
      if (result.status === 'rejected') {
        const field = textFills[i]!.field
        textFillFailures.push({
          label: field.fieldLabel,
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        })
      }
    }
  }

  // Track choice/toggle/file failures the same way so the entire batch can
  // surface a complete picture instead of bailing on the first one. The
  // proxy used to use stopOnError default behavior implicitly via the
  // sequential loop below, but partial-batch failures should be opaque to
  // the agent only at the end — not mid-batch — so subsequent fills can
  // still land.
  const otherFillFailures: Array<{ label: string; error: string }> = []

  // Fill interactive fields sequentially (choice/toggle/file/auto may trigger DOM changes)
  for (const { field } of otherFills) {
    const labelForReport = field.kind === 'toggle' ? field.label : field.fieldLabel
    try {
      if (field.kind === 'auto') {
        await setAutoFieldValue(page, field.fieldLabel, field.value, {
          fieldId: field.fieldId,
          exact: field.exact,
          cache,
        })
        continue
      }
      if (field.kind === 'choice') {
        await setFieldChoice(page, field.fieldLabel, field.value, {
          fieldId: field.fieldId,
          exact: field.exact,
          query: field.query,
          choiceType: field.choiceType,
          cache,
        })
        continue
      }
      if (field.kind === 'toggle') {
        await setCheckedControl(page, field.label, {
          checked: field.checked,
          exact: field.exact,
          controlType: field.controlType,
        })
        continue
      }
      if (field.kind === 'file') {
        await attachFiles(page, field.paths, { fieldId: field.fieldId, fieldLabel: field.fieldLabel, exact: field.exact, cache })
      }
    } catch (e) {
      otherFillFailures.push({
        label: labelForReport,
        error: e instanceof Error ? e.message : String(e),
      })
    }
  }

  // Surface aggregate failures at the end. If both text and choice fills had
  // failures, the error message includes everything so the agent can see the
  // full picture of which fields didn't land. The thrown error preserves the
  // legacy behavior of fillFields rejecting on partial failure (so callers
  // that wrap it in try/catch still see an error), but it no longer cascades
  // mid-batch to skip subsequent fills.
  if (textFillFailures.length > 0 || otherFillFailures.length > 0) {
    const lines: string[] = []
    if (textFillFailures.length > 0) {
      lines.push(`text fill failures (${textFillFailures.length}):`)
      for (const f of textFillFailures) lines.push(`  - "${f.label}": ${f.error}`)
    }
    if (otherFillFailures.length > 0) {
      lines.push(`choice/toggle/file fill failures (${otherFillFailures.length}):`)
      for (const f of otherFillFailures) lines.push(`  - "${f.label}": ${f.error}`)
    }
    throw new Error(`fillFields: partial batch failure\n${lines.join('\n')}`)
  }
}

export interface SelectOptionPayload {
  value?: string
  label?: string
  index?: number
}

export async function selectNativeOption(page: Page, x: number, y: number, opt: SelectOptionPayload): Promise<void> {
  if (opt.value === undefined && opt.label === undefined && opt.index === undefined) {
    throw new Error('selectOption: provide at least one of value, label, or index')
  }
  await page.mouse.click(x, y)
  await delay(40)
  for (const frame of page.frames()) {
    const applied = await frame.evaluate(
      (payload: { value: string | null; label: string | null; index: number | undefined }) => {
        const normalize = (input: string | undefined | null) => input?.replace(/\s+/g, ' ').trim().toLowerCase() ?? ''
        const optionMatchesExpected = (
          o: HTMLOptionElement,
          expected: string,
        ): boolean => {
          if (o.disabled) return false
          const label = normalize(o.textContent)
          const rawValue = normalize(o.value)
          return label === expected || rawValue === expected || label.includes(expected) || rawValue.includes(expected)
        }

        const a = document.activeElement
        if (!a || a.tagName !== 'SELECT') return false
        const sel = a as HTMLSelectElement
        if (typeof payload.index === 'number' && Number.isFinite(payload.index)) {
          const i = Math.trunc(payload.index)
          if (i < 0 || i >= sel.options.length) return false
          if (sel.options[i]!.disabled) return false
          sel.selectedIndex = i
        } else if (payload.value !== null && payload.value !== undefined) {
          const raw = String(payload.value)
          sel.value = raw
          const expected = normalize(raw)
          if (!expected) return false
          const selected = sel.selectedOptions[0]
          const ok =
            selected &&
            !selected.disabled &&
            (normalize(selected.value) === expected ||
              normalize(selected.textContent) === expected ||
              normalize(selected.value).includes(expected) ||
              normalize(selected.textContent).includes(expected))
          if (!ok) {
            const found = Array.from(sel.options).find(o => optionMatchesExpected(o, expected))
            if (!found) return false
            sel.value = found.value
          }
        } else if (payload.label !== null && payload.label !== undefined) {
          const expected = normalize(payload.label)
          if (!expected) return false
          const optEl = Array.from(sel.options).find(o => optionMatchesExpected(o, expected))
          if (!optEl) return false
          sel.value = optEl.value
        } else {
          return false
        }
        sel.dispatchEvent(new Event('input', { bubbles: true }))
        sel.dispatchEvent(new Event('change', { bubbles: true }))
        return true
      },
      {
        value: opt.value ?? null,
        label: opt.label ?? null,
        index: typeof opt.index === 'number' && Number.isFinite(opt.index) ? opt.index : undefined,
      },
    )
    if (applied) return
  }
  throw new Error(
    'selectOption: no focused <select> after click — use geometra_pick_listbox_option for custom dropdowns',
  )
}

/**
 * Custom listbox / combobox (ARIA): optional click to open, then `getByRole('option')`.
 */
export async function pickListboxOption(
  page: Page,
  label: string,
  opts?: { exact?: boolean; openX?: number; openY?: number; fieldId?: string; fieldLabel?: string; query?: string; cache?: FillLookupCache },
): Promise<void> {
  let anchor: AnchorPoint | undefined
  const exact = opts?.exact ?? false
  let attemptedSelection = false
  let selectedOptionText: string | undefined
  let openedHandle: ElementHandle<Element> | null | undefined
  let openedLocator: Locator | undefined
  let openedEditable = false
  let queryUsed: string | undefined
  let queryReset = false
  // Popup scope: handle for the popup container that the trigger actually owns. We resolve it
  // immediately after opening so all subsequent option searches restrict themselves to that
  // popup, instead of scanning every popup-shaped element on the page. This is what makes the
  // picker reliable on forms with multiple comboboxes that share option text (Yes/No, etc.).
  let popupScope: ElementHandle<Element> | null = null
  const releasePopupScope = async (): Promise<void> => {
    if (popupScope) {
      try { await popupScope.dispose() } catch { /* ignore */ }
      popupScope = null
    }
  }
  const refreshPopupScope = async (): Promise<void> => {
    await releasePopupScope()
    popupScope = await resolveOwnedPopupHandle(openedHandle)
  }

  if (opts?.fieldLabel) {
    let opened
    try {
      opened = await openDropdownControl(page, opts.fieldLabel, exact, opts.cache, opts.fieldId)
    } catch {
      throw new Error(listboxErrorMessage({
        reason: 'field_not_found',
        requestedLabel: label,
        fieldLabel: opts.fieldLabel,
        query: opts?.query,
        exact,
      }))
    }
    anchor = { x: opened.anchorX, y: opened.anchorY }
    openedHandle = opened.handle
    openedLocator = opened.locator
    openedEditable = opened.editable
    queryUsed = opts.query ?? label
    if (queryUsed && opened.editable) {
      await typeIntoEditableLocator(page, opened.locator, queryUsed)
      await delay(80)
    } else if (queryUsed && await typeIntoActiveEditableElement(page, queryUsed)) {
      await delay(80)
    }
    await refreshPopupScope()
  } else if (opts?.openX !== undefined && opts?.openY !== undefined) {
    await page.mouse.click(opts.openX, opts.openY)
    anchor = { x: opts.openX, y: opts.openY }
    await delay(120)
  }

  const attemptClickSelection = async (): Promise<boolean> => {
    selectedOptionText = (await clickVisibleOptionCandidate(page, label, exact, anchor, popupScope)) ?? undefined
    if (!selectedOptionText) return false
    attemptedSelection = true
    // Force-commit for searchable/autocomplete comboboxes (React Select,
    // Headless UI, Radix, Ant Design, etc.). Some library versions — most
    // notably Greenhouse's Remix-wrapped react-select — visually select the
    // option on synthetic mouse click but never invoke `onChange`, leaving
    // the controlled form state empty. Dispatching a keyboard `Enter` on
    // the focused combobox input puts the selection through the keyboard
    // commit path, which ALL tested libraries honor. No-op for native
    // <select> / plain ARIA listboxes — see isAutocompleteCombobox.
    await pressEnterToCommitListbox(page, openedHandle)
    await dispatchListboxCommitEvents(openedHandle)
    if (
      !opts?.fieldLabel ||
      await confirmListboxSelection(page, opts.fieldLabel, label, exact, anchor, openedHandle, selectedOptionText, {
        editable: openedEditable,
      })
    ) {
      return true
    }
    return false
  }

  const dismissAfterSelection = async (): Promise<boolean> => {
    if (!opts?.fieldLabel) {
      await page.keyboard.press('Tab')
      await delay(50)
      return true
    }
    if (await dismissAndReVerifySelection(page, label, exact, openedHandle, selectedOptionText)) {
      return true
    }
    // Value reverted — retry with Enter then re-verify
    await page.keyboard.press('Enter')
    await delay(50)
    if (await dismissAndReVerifySelection(page, label, exact, openedHandle, selectedOptionText)) {
      return true
    }
    return false
  }

  /**
   * Final post-commit sanity check. Even after `confirmListboxSelection` and
   * `dismissAndReVerifySelection` say the option was committed, two distinct
   * silent-failure modes can leave the field empty:
   *
   *   1. The library reverts the selection a few frames later by flipping
   *      `aria-invalid` back to "true" (Workday PTX, certain react-select
   *      forks, some Ashby flows). The aria-invalid attribute is the
   *      authoritative signal here.
   *
   *   2. The library never commits the selection but ALSO never sets
   *      aria-invalid (Greenhouse, Lever, plain ARIA listboxes). The trigger
   *      stays at the "Select..." placeholder until the user submits the
   *      form, at which point validation finally fires. There is no aria
   *      flag during the silent window, so the only reliable signal is the
   *      trigger's visible text — if it still matches the placeholder
   *      pattern, the field is empty regardless of what the verification
   *      heuristics said.
   *
   * Both checks run together because they cover disjoint library patterns
   * and a failed commit on either signal is a failed commit. Returns true
   * only when BOTH signals say the field looks committed.
   *
   * This is defense-in-depth: confirmListboxSelection already vetos on
   * aria-invalid, but that check runs while the popup is still closing.
   * This check runs after the popup is fully gone, giving the library a
   * chance to expose its final committed state.
   */
  const postCommitVerify = async (): Promise<boolean> => {
    if (!openedHandle) return true
    // Give React Select a couple of animation frames to settle its final
    // aria-invalid state after the blur/commit. The cost is a few ms on the
    // happy path and a correct failure signal on the unhappy one.
    await delay(40)
    if (await readAriaInvalid(openedHandle)) return false
    if (await readTriggerShowsPlaceholder(openedHandle)) return false
    // Form-level validation: even if the trigger chrome says "committed",
    // the surrounding <form> may still report the field as invalid via a
    // hidden input's aria-invalid, a role=alert error message, or a
    // [data-invalid] flag inside the field wrapper (react-hook-form,
    // Formik, Ashby forms, etc.). If the form disagrees with the trigger,
    // the commit did not land and the caller should retry.
    //
    // We use the STRICT variant here (`requireWrapperFlag: false`) because
    // we just attempted a commit — a required hidden input that is still
    // empty IS authoritative even before the user submits the form. Without
    // this, Greenhouse's phone-country-code combobox (Airtable PM AI #94)
    // false-passes verification: the trigger shows "+1" but the hidden
    // input stays blank because react-select's keyboard-Enter commit
    // didn't bind to the country sub-control. Bug surfaced by JobForge
    // round-2 marathon.
    if (await readFormLevelInvalidState(openedHandle, { requireWrapperFlag: false })) return false
    return true
  }

  try {
    if (await attemptClickSelection()) {
      if (await dismissAfterSelection() && await postCommitVerify()) return
    }

    let visibleHints = await collectVisibleOptionHints(page, anchor)
    const visibleMatchExists = visibleHints.options.some(option => selectionMatchScore(option.label, label, exact) !== null)
    if (queryUsed && !visibleMatchExists) {
      queryReset = await resetTypedListboxQuery(page, openedLocator)
      if (queryReset) {
        await delay(80)
        // Popup may have been re-rendered after the query reset; refresh the scope so the
        // next attempt still searches inside the right container.
        await refreshPopupScope()
        if (await attemptClickSelection()) {
          if (await dismissAfterSelection() && await postCommitVerify()) return
        }
        visibleHints = await collectVisibleOptionHints(page, anchor)
      }
    }

    const keyboardSelection = await tryKeyboardSelectVisibleOption(page, label, exact, anchor, openedLocator)
    if (keyboardSelection) {
      selectedOptionText = keyboardSelection
      attemptedSelection = true
      await dispatchListboxCommitEvents(openedHandle)
      if (
        !opts?.fieldLabel ||
        await confirmListboxSelection(page, opts.fieldLabel, label, exact, anchor, openedHandle, selectedOptionText, {
          editable: openedEditable,
        })
      ) {
        if (await dismissAfterSelection() && await postCommitVerify()) return
      }
    }

    visibleHints = await collectVisibleOptionHints(page, anchor)
    if (opts?.fieldLabel && attemptedSelection) {
      throw new Error(listboxErrorMessage({
        reason: 'selection_not_confirmed',
        requestedLabel: label,
        fieldLabel: opts.fieldLabel,
        query: queryUsed,
        exact,
        visibleOptions: visibleHints.options,
        listEmpty: visibleHints.hasPopup && visibleHints.options.length === 0,
        queryReset,
      }))
    }
    throw new Error(listboxErrorMessage({
      reason: 'no_visible_option_match',
      requestedLabel: label,
      fieldLabel: opts?.fieldLabel,
      query: queryUsed,
      exact,
      visibleOptions: visibleHints.options,
      listEmpty: visibleHints.hasPopup && visibleHints.options.length === 0,
      queryReset,
    }))
  } finally {
    await releasePopupScope()
  }
}

export interface SetCheckedPayload {
  checked?: boolean
  exact?: boolean
  controlType?: 'checkbox' | 'radio'
}

/**
 * Set a checkbox/radio by accessible label instead of brittle coordinate clicks.
 * Helps custom form UIs that keep the real control opacity-hidden but still interactive.
 */
export async function setCheckedControl(page: Page, label: string, opts?: SetCheckedPayload): Promise<void> {
  const exact = opts?.exact ?? false
  const desiredChecked = opts?.checked ?? true
  const controlType = opts?.controlType

  for (const frame of page.frames()) {
    const result = await frame.evaluate(
      (payload: { label: string; exact: boolean; checked: boolean; controlType: 'checkbox' | 'radio' | null }) => {
        function normalize(value: string): string {
          return value.replace(/\s+/g, ' ').trim().toLowerCase()
        }

        function matchesLabel(candidate: string | undefined): boolean {
          if (!candidate) return false
          const normalizedCandidate = normalize(candidate)
          const normalizedNeedle = normalize(payload.label)
          return payload.exact ? normalizedCandidate === normalizedNeedle : normalizedCandidate.includes(normalizedNeedle)
        }

        function visible(el: HTMLElement): boolean {
          const rect = el.getBoundingClientRect()
          if (rect.width <= 0 || rect.height <= 0) return false
          const style = getComputedStyle(el)
          return style.display !== 'none' && style.visibility !== 'hidden'
        }

        function referencedText(ids: string | null, visited?: Set<string>): string | undefined {
          if (!ids) return undefined
          const seen = visited ?? new Set<string>()
          const text = ids
            .split(/\s+/)
            .map(id => {
              if (seen.has(id)) return ''
              seen.add(id)
              const target = document.getElementById(id)
              if (!target) return ''
              const chained = target.getAttribute('aria-labelledby')
              if (chained) return referencedText(chained, seen) ?? ''
              return target.textContent?.trim() ?? ''
            })
            .filter(Boolean)
            .join(' ')
            .trim()
          return text || undefined
        }

        function controlKind(el: Element): 'checkbox' | 'radio' | undefined {
          if (el instanceof HTMLInputElement) {
            if (el.type === 'checkbox') return 'checkbox'
            if (el.type === 'radio') return 'radio'
            return undefined
          }
          const role = el.getAttribute('role')
          if (role === 'switch' || role === 'checkbox') return 'checkbox'
          if (role === 'radio') return 'radio'
          return undefined
        }

        function controlName(el: Element): string | undefined {
          const aria = el.getAttribute('aria-label')?.trim()
          if (aria) return aria
          const labelledBy = referencedText(el.getAttribute('aria-labelledby'))
          if (labelledBy) return labelledBy
          if (el instanceof HTMLInputElement) {
            const labels = el.labels ? Array.from(el.labels) : []
            for (const labelEl of labels) {
              const text = labelEl.textContent?.trim()
              if (text) return text
            }
            const nameAttr = el.getAttribute('name')?.trim()
            if (nameAttr && /[A-Za-z]/.test(nameAttr) && /[\s,./()_-]/.test(nameAttr)) return nameAttr
          }
          const text = el.textContent?.trim()
          return text || undefined
        }

        function readChecked(el: Element): boolean {
          if (el instanceof HTMLInputElement) return !!el.checked
          return el.getAttribute('aria-checked') === 'true'
        }

        function clickTarget(el: Element): HTMLElement | null {
          if (el instanceof HTMLInputElement) {
            const labelEl = el.labels?.[0]
            if (labelEl instanceof HTMLElement) return labelEl
          }
          return el instanceof HTMLElement ? el : null
        }

        function dispatch(target: HTMLElement): void {
          target.dispatchEvent(new Event('input', { bubbles: true }))
          target.dispatchEvent(new Event('change', { bubbles: true }))
        }

        function clearReactTracker(target: HTMLInputElement, next: boolean): boolean {
          const tracker = (target as unknown as { _valueTracker?: { setValue: (value: string) => void } })._valueTracker
          if (tracker && typeof tracker.setValue === 'function') {
            try {
              tracker.setValue(String(!next))
              return true
            } catch { /* ignore */ }
          }
          return false
        }

        function setInputCheckedReactAware(target: HTMLInputElement, next: boolean): boolean {
          const hadReactTracker = clearReactTracker(target, next)
          if (!hadReactTracker && target.checked === next) return true
          const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked')
          if (descriptor?.set) descriptor.set.call(target, next)
          else target.checked = next
          dispatch(target)
          return target.checked === next
        }

        const selector = 'input[type="checkbox"], input[type="radio"], [role="checkbox"], [role="radio"], [role="switch"]'
        const candidates = Array.from(document.querySelectorAll(selector)).filter(
          (el): el is HTMLElement => el instanceof HTMLElement && visible(el),
        )
        const target = candidates.find((el) => {
          const kind = controlKind(el)
          if (!kind) return false
          if (payload.controlType && kind !== payload.controlType) return false
          return matchesLabel(controlName(el))
        })

        if (!target) {
          return { matched: false as const }
        }

        const kind = controlKind(target)!
        const name = controlName(target) ?? payload.label
        const before = readChecked(target)
        if (kind === 'radio' && payload.checked === false) {
          return { matched: true as const, success: before === false, reason: 'radio-uncheck' as const, kind, name }
        }

        if (before !== payload.checked && !(target instanceof HTMLInputElement)) {
          clickTarget(target)?.click()
        }

        let after = readChecked(target)
        if (target instanceof HTMLInputElement) {
          setInputCheckedReactAware(target, payload.checked)
          after = target.checked
        }

        return {
          matched: true as const,
          success: after === payload.checked,
          kind,
          name,
          before,
          after,
        }
      },
      { label, exact, checked: desiredChecked, controlType: controlType ?? null },
    )

    if (!result.matched) continue
    if (result.success) return
    if (result.reason === 'radio-uncheck') {
      throw new Error(`setChecked: radio "${result.name}" cannot be unchecked directly; choose a different option instead`)
    }
    throw new Error(`setChecked: matched ${result.kind} "${result.name}" but could not set it to ${String(desiredChecked)}`)
  }

  const kindLabel = controlType ?? 'checkbox/radio'
  throw new Error(`setChecked: no visible ${kindLabel} matching "${label}"`)
}

export async function wheelAt(page: Page, deltaX: number, deltaY: number, x?: number, y?: number): Promise<void> {
  if (x !== undefined && y !== undefined && Number.isFinite(x) && Number.isFinite(y)) {
    const scrolled = await page.evaluate(({ deltaX, deltaY, x, y }) => {
      function overflowAllows(styleValue: string): boolean {
        return styleValue === 'auto' || styleValue === 'scroll' || styleValue === 'overlay'
      }

      function nearestScrollable(start: Element | null): HTMLElement | null {
        let current = start instanceof HTMLElement ? start : null
        while (current) {
          const style = getComputedStyle(current)
          const allowsY = overflowAllows(style.overflowY) && current.scrollHeight > current.clientHeight + 1
          const allowsX = overflowAllows(style.overflowX) && current.scrollWidth > current.clientWidth + 1
          if (allowsY || allowsX) return current
          current = current.parentElement
        }
        return null
      }

      const target = document.elementFromPoint(x, y)
      const container = nearestScrollable(target)
      if (container) {
        const beforeTop = container.scrollTop
        const beforeLeft = container.scrollLeft
        container.scrollBy(deltaX, deltaY)
        return container.scrollTop !== beforeTop || container.scrollLeft !== beforeLeft
      }

      const beforeX = window.scrollX
      const beforeY = window.scrollY
      window.scrollBy(deltaX, deltaY)
      return window.scrollX !== beforeX || window.scrollY !== beforeY
    }, { deltaX, deltaY, x, y })

    if (scrolled) return

    await page.mouse.move(x, y)
    await page.mouse.wheel(deltaX, deltaY)
    return
  }

  await page.evaluate(({ deltaX, deltaY }) => {
    window.scrollBy(deltaX, deltaY)
  }, { deltaX, deltaY })
}
