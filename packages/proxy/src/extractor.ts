import { performance } from 'node:perf_hooks'
import type { Frame, Page } from 'playwright'
import {
  enrichSnapshotWithCdpAx,
  shouldEnrichSnapshotWithCdpAx,
  type CdpAxSessionManager,
} from './a11y-enrich.js'
import { frameOriginInRootPage } from './frame-offset.js'
import { offsetLayoutSubtree } from './layout-offset.js'
import type { GeometrySnapshot, LayoutSnapshot, TreeSnapshot } from './types.js'

/**
 * In-browser extraction (no closure over Node). Single-frame viewport coordinates.
 */
function browserExtractGeometry(): { layout: LayoutSnapshot; tree: TreeSnapshot } {
  const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'template'])
  const LEAF_FORM_TAGS = new Set(['input', 'textarea', 'select'])
  const FORM_CONTROL_ROLES = new Set([
    'button',
    'checkbox',
    'combobox',
    'listbox',
    'radio',
    'searchbox',
    'slider',
    'spinbutton',
    'switch',
    'textbox',
  ])

  function textWithoutNestedControls(node: Node): string {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? ''
    if (!(node instanceof Element)) return ''
    const tag = node.tagName.toLowerCase()
    if (LEAF_FORM_TAGS.has(tag) || tag === 'button') return ''
    let out = ''
    for (const child of node.childNodes) out += textWithoutNestedControls(child)
    return out
  }

  function getAccessibleName(el: Element): string | undefined {
    const role = el.getAttribute('role')
    const aria = el.getAttribute('aria-label')
    if (aria) return aria.trim() || undefined
    const labelledBy = el.getAttribute('aria-labelledby')
    if (labelledBy) {
      const resolveChain = (ids: string, visited: Set<string>): string =>
        ids
          .split(/\s+/)
          .map(id => {
            if (visited.has(id)) return ''
            visited.add(id)
            const target = document.getElementById(id)
            if (!target) return ''
            const chained = target.getAttribute('aria-labelledby')
            if (chained) return resolveChain(chained, visited)
            return textWithoutNestedControls(target).replace(/\s+/g, ' ').trim()
          })
          .filter(Boolean)
          .join(' ')
          .trim()
      const text = resolveChain(labelledBy, new Set<string>())
      if (text) return text.length > 100 ? text.slice(0, 100) : text
    }
    if (
      (el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) &&
      el.labels &&
      el.labels.length > 0
    ) {
      const t = textWithoutNestedControls(el.labels[0]!).replace(/\s+/g, ' ').trim()
      if (t) return t
    }
    if (el instanceof HTMLElement && el.id) {
      const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`)
      const t = label ? textWithoutNestedControls(label).replace(/\s+/g, ' ').trim() : ''
      if (t) return t
    }
    if (el.parentElement?.tagName.toLowerCase() === 'label') {
      const t = textWithoutNestedControls(el.parentElement).replace(/\s+/g, ' ').trim()
      if (t) return t
    }
    if (el instanceof HTMLInputElement && ['button', 'submit', 'reset'].includes(el.type)) {
      const value = el.value?.trim()
      if (value) return value.length > 100 ? value.slice(0, 100) : value
    }
    const alt = el.getAttribute('alt')
    if (alt) return alt.trim() || undefined
    if (el.tagName.toLowerCase() === 'a' || el.tagName.toLowerCase() === 'button' || role === 'link' || role === 'button') {
      const descendantAlt = Array.from(el.querySelectorAll('img[alt]'))
        .map(img => img.getAttribute('alt')?.trim() ?? '')
        .find(Boolean)
      if (descendantAlt) return descendantAlt.length > 100 ? descendantAlt.slice(0, 100) : descendantAlt
    }
    const title = el.getAttribute('title')
    if (title) return title.trim() || undefined
    const textLikeControl =
      el instanceof HTMLTextAreaElement ||
      el instanceof HTMLSelectElement ||
      (el instanceof HTMLInputElement && !['checkbox', 'radio', 'file', 'button', 'submit', 'reset', 'hidden', 'range', 'color'].includes(el.type)) ||
      role === 'textbox' ||
      role === 'combobox'
    const placeholder = el.getAttribute('aria-placeholder') || (textLikeControl ? el.getAttribute('placeholder') : null)
    if (placeholder) return placeholder.trim() || undefined
    const tc = textWithoutNestedControls(el).replace(/\s+/g, ' ').trim()
    if (tc && tc.length > 0) {
      return tc.length > 100 ? tc.slice(0, 100) : tc
    }
    return undefined
  }

  function isFocusable(el: Element): boolean {
    const h = el as HTMLElement
    if (h instanceof HTMLButtonElement && h.disabled) return false
    if (h instanceof HTMLInputElement && h.disabled) return false
    if (h instanceof HTMLSelectElement && h.disabled) return false
    if (h instanceof HTMLTextAreaElement && h.disabled) return false
    if (h.isContentEditable) return true
    const tab = h.tabIndex
    if (typeof tab === 'number' && tab >= 0) return true
    const tag = el.tagName.toLowerCase()
    return ['a', 'button', 'input', 'select', 'textarea'].includes(tag)
  }

  function shouldKeepDespiteOpacity(el: Element): boolean {
    const tag = el.tagName.toLowerCase()
    if (tag === 'input') {
      const type = (el as HTMLInputElement).type
      if (type === 'checkbox' || type === 'radio') return true
      // react-select v5 (and similar libraries) renders the search input
      // with `opacity: 0` until it's been focused at least once. Filtering
      // it kills the entire combobox node from the snapshot, which breaks
      // verifyFills, geometra_query, and any agent that wants to verify a
      // post-fill custom-combobox state.
      if (!['file', 'button', 'submit', 'reset', 'hidden', 'image', 'range', 'color'].includes(type)) return true
    }
    const role = el.getAttribute('role')
    return (
      role === 'checkbox' ||
      role === 'radio' ||
      role === 'switch' ||
      role === 'combobox' ||
      role === 'textbox' ||
      role === 'listbox' ||
      role === 'searchbox' ||
      role === 'spinbutton'
    )
  }

  function readCheckedState(el: Element): boolean | 'mixed' | undefined {
    const ariaChecked = el.getAttribute('aria-checked')
    if (ariaChecked === 'mixed') return 'mixed'
    if (ariaChecked === 'true') return true
    if (ariaChecked === 'false') return false
    if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) {
      if (el.indeterminate) return 'mixed'
      return el.checked
    }
    return undefined
  }

  function isTextLikeControl(el: Element): boolean {
    if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return true
    if (el instanceof HTMLInputElement) {
      return !['checkbox', 'radio', 'file', 'button', 'submit', 'reset', 'hidden', 'range', 'color'].includes(el.type)
    }
    const role = el.getAttribute('role')
    return role === 'textbox' || role === 'combobox'
  }

  // Short controls (inputs, selects, custom-combobox triggers) cap at 240 chars
  // — long values in those controls are almost always noise (autofill junk,
  // a whole page of option text for a broken readback, etc) and capping keeps
  // snapshots token-cheap. Textareas and contenteditable rich editors, on the
  // other hand, legitimately hold long-form content (cover letters, "why do
  // you want to work at X?" essays). Capping those at 240 silently truncates
  // the readback and makes verifyFills / geometra_query report bogus
  // mismatches on correctly-filled values, as seen on Anthropic Greenhouse
  // 2026-04-11. Callers that extract from long-form controls must pass a
  // larger cap.
  const SHORT_CONTROL_VALUE_CAP = 240
  const LONG_CONTROL_VALUE_CAP = 16_384

  function normalizedControlValue(
    value: string | undefined,
    maxLength: number = SHORT_CONTROL_VALUE_CAP,
  ): string | undefined {
    const trimmed = value?.replace(/\s+/g, ' ').trim()
    if (!trimmed) return undefined
    return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed
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
    return normalizedControlValue(text)
  }

  function controlRequired(el: Element): boolean {
    const ariaRequired = el.getAttribute('aria-required')
    if (ariaRequired === 'true') return true
    if (ariaRequired === 'false') return false
    return (
      (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) &&
      el.required
    )
  }

  function controlInvalid(el: Element): boolean {
    const ariaInvalid = el.getAttribute('aria-invalid')
    if (ariaInvalid && ariaInvalid !== 'false') return true
    if (ariaInvalid === 'false') return false
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
      try {
        if (el.willValidate) return !el.checkValidity()
      } catch {
        return false
      }
    }
    return false
  }

  function controlBusy(el: Element): boolean {
    return el.getAttribute('aria-busy') === 'true'
  }

  function looksLikeValidationText(value: string): boolean {
    return /\b(required|invalid|must|please|enter|select|choose|upload|missing|error)\b/i.test(value)
  }

  function controlErrorText(el: Element): string | undefined {
    const err = referencedText(el.getAttribute('aria-errormessage'))
    if (err) return err
    if (!controlInvalid(el)) return undefined
    const described = referencedText(el.getAttribute('aria-describedby'))
    if (described && looksLikeValidationText(described)) return described
    return undefined
  }

  function controlDescriptionText(el: Element): string | undefined {
    const described = referencedText(el.getAttribute('aria-describedby'))
    if (!described) return undefined
    const error = controlErrorText(el)
    return described === error ? undefined : described
  }

  /**
   * Custom-combobox value readback fallback.
   *
   * react-select, Radix Select, and similar custom-combobox patterns render
   * the trigger as a small `<input role="combobox">` whose `.value` is the
   * typed search query (empty when nothing's being searched). The displayed
   * picked option lives in a *sibling* presentational element — for
   * react-select that's `<div class="<prefix>__single-value">Yes</div>`,
   * for Radix it's `<span class="*SelectValue*">Yes</span>`. Without this
   * fallback, `geometra_query` returns these comboboxes with no value field
   * and agents have no way to verify what option was actually picked
   * (the v1.34.x benchmark surfaced this as a real gap).
   *
   * Heuristic: ascend up to 4 parent levels and look for a non-input
   * descendant whose class hints at "single-value", "singleValue",
   * "SelectValue", or `[data-state="checked"]`. Skip placeholders, indicator
   * icons, and elements that wrap other form controls.
   */
  function findCustomComboboxValueText(el: Element): string | undefined {
    let cur: Element | null = el.parentElement
    let depth = 0
    while (cur && depth < 4) {
      const candidates = cur.querySelectorAll<HTMLElement>(
        '[class*="single-value"], [class*="singleValue"], [class*="SelectValue"], [data-radix-select-value], [data-headlessui-state]',
      )
      for (const candidate of candidates) {
        if (candidate === el) continue
        if (candidate.contains(el)) continue
        // Note: descendants of the trigger ARE allowed — Radix renders the
        // <SelectValue> as a child of the <button role="combobox"> trigger.
        // For react-select v5 the single-value div is a sibling of the
        // input wrapper, not a descendant of the input, so allowing
        // descendants doesn't widen scope incorrectly there.
        if (candidate.getAttribute('aria-hidden') === 'true') continue
        const className = (candidate.getAttribute('class') ?? '').toLowerCase()
        if (className.includes('placeholder')) continue
        if (className.includes('indicator')) continue
        // Skip wrappers that contain other form controls — we want the
        // presentational text node, not a container.
        if (candidate.querySelector('input, select, textarea, button')) continue
        const text = candidate.textContent?.trim()
        if (text) return text
      }
      cur = cur.parentElement
      depth++
    }
    return undefined
  }

  /**
   * Compute an element's visible text but skip every aria-hidden subtree.
   *
   * Real Radix Select renders its trigger as:
   *   <button role="combobox">
   *     <span style="pointer-events:none">Yes</span>      ← the picked value
   *     <span aria-hidden="true">▾</span>                  ← decorative icon
   *   </button>
   *
   * Note that the value-bearing span has NO `data-radix-select-value`
   * attribute and NO class containing "SelectValue" — those were the
   * patterns the Radix sibling-readback was originally written against,
   * but real `<Select.Value>` doesn't emit them. So
   * findCustomComboboxValueText returns nothing for Radix and the trigger
   * fallback runs. Plain `el.innerText` then returns "Yes\n▾", which
   * fails any post-fill ground-truth check.
   *
   * The fix: when computing trigger text, walk children and skip every
   * subtree marked aria-hidden. This strips Radix's <SelectIcon> reliably
   * (it's always aria-hidden — that's how Radix marks it as decorative)
   * and leaves the actual value text intact. The same trick handles every
   * library that uses an aria-hidden glyph next to the picked value.
   */
  function visibleTextSkippingAriaHidden(el: Element): string | undefined {
    if (!(el instanceof HTMLElement)) return undefined
    function collect(node: Node, out: string[]): void {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent
        if (text) out.push(text)
        return
      }
      if (!(node instanceof Element)) return
      if (node.getAttribute('aria-hidden') === 'true') return
      const tag = node.tagName.toLowerCase()
      if (LEAF_FORM_TAGS.has(tag) || tag === 'button') return
      for (const child of node.childNodes) collect(child, out)
    }
    const parts: string[] = []
    for (const child of el.childNodes) collect(child, parts)
    const joined = parts.join(' ').replace(/\s+/g, ' ').trim()
    return joined || undefined
  }

  function controlValueText(el: Element): string | undefined {
    if (el instanceof HTMLInputElement) {
      if (el.type === 'password') return el.value ? '••••••••' : undefined
      if (el.type === 'file') {
        if (el.files && el.files.length > 0) {
          return normalizedControlValue(Array.from(el.files).map(file => file.name).join(', '))
        }
        return undefined
      }
      if (!isTextLikeControl(el)) return undefined
      const direct = normalizedControlValue(el.value || el.getAttribute('aria-valuetext') || undefined)
      if (direct) return direct
      // For custom-combobox triggers (react-select etc.) the picked value
      // lives in a sibling, not on the input itself.
      if (el.getAttribute('role') === 'combobox') {
        return normalizedControlValue(findCustomComboboxValueText(el))
      }
      return undefined
    }
    if (el instanceof HTMLTextAreaElement) {
      // Textareas legitimately hold long-form content (cover letters, "why X?"
      // essays). Capping at SHORT_CONTROL_VALUE_CAP would silently truncate
      // correct fills and make verifyFills report bogus mismatches.
      return normalizedControlValue(
        el.value || el.getAttribute('aria-valuetext') || undefined,
        LONG_CONTROL_VALUE_CAP,
      )
    }
    if (el instanceof HTMLSelectElement) {
      return normalizedControlValue(
        el.selectedOptions[0]?.textContent || el.value || el.getAttribute('aria-valuetext') || undefined,
      )
    }
    if (el instanceof HTMLElement && el.isContentEditable) {
      // Rich-text editors (contenteditable) are the other long-form control.
      return normalizedControlValue(
        el.innerText || el.textContent || el.getAttribute('aria-valuetext') || undefined,
        LONG_CONTROL_VALUE_CAP,
      )
    }

    const role = el.getAttribute('role')
    if (role === 'combobox' || role === 'textbox') {
      // role="textbox" can be a rich-text editor (Slate, Lexical, TipTap,
      // Draft.js). Use the long cap there too. role="combobox" triggers
      // stay on the short cap — combobox values are always short labels,
      // never essays.
      const valueCap = role === 'textbox' ? LONG_CONTROL_VALUE_CAP : SHORT_CONTROL_VALUE_CAP
      // Prefer aria-valuetext when set — that's the explicit author signal.
      const valueText = normalizedControlValue(el.getAttribute('aria-valuetext') ?? undefined, valueCap)
      if (valueText) return valueText
      // For div-/button-based combobox triggers (Radix etc.), the trigger's
      // own innerText typically includes both the picked option AND the
      // dropdown indicator glyph. Try the custom-combobox sibling fallback
      // first — it pulls the picked option out of a class-hinted sibling
      // and ignores the indicator. If no sibling is found (real Radix
      // emits a plain <span> with no class/data hint), strip aria-hidden
      // descendants from the trigger's text, which removes the decorative
      // glyph and leaves just the picked value. innerText is the last
      // resort, used only when there are no aria-hidden children to skip.
      if (role === 'combobox') {
        const sibling = normalizedControlValue(findCustomComboboxValueText(el))
        if (sibling) return sibling
        const filtered = normalizedControlValue(visibleTextSkippingAriaHidden(el))
        if (filtered) return filtered
      }
      return normalizedControlValue(
        (el as HTMLElement).innerText || el.textContent || undefined,
        valueCap,
      )
    }

    return undefined
  }

  function pickMeaningfulControlRect(el: Element): DOMRect {
    const h = el as HTMLElement
    const rect = h.getBoundingClientRect()
    if (!isTextLikeControl(el)) return rect
    if (rect.width >= 80 && rect.height >= 24) return rect

    let best = rect
    let bestScore = Number.POSITIVE_INFINITY
    let current = h.parentElement
    let depth = 0

    while (current && depth < 6) {
      const style = getComputedStyle(current)
      const candidate = current.getBoundingClientRect()
      if (
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        candidate.width > 0 &&
        candidate.height > 0 &&
        candidate.width >= rect.width &&
        candidate.height >= rect.height &&
        candidate.width <= window.innerWidth * 0.98 &&
        candidate.height <= Math.max(window.innerHeight * 0.9, 320)
      ) {
        const largeEnough = candidate.width >= 80 || candidate.height >= 24
        if (largeEnough) {
          const area = candidate.width * candidate.height
          const score = area + depth * 1000
          if (score < bestScore) {
            best = candidate
            bestScore = score
          }
        }
      }
      current = current.parentElement
      depth++
    }

    return best
  }

  function shouldSkip(el: Element): boolean {
    const tag = el.tagName.toLowerCase()
    if (SKIP_TAGS.has(tag)) return true
    const h = el as HTMLElement
    const style = getComputedStyle(h)
    if (style.display === 'none' || style.visibility === 'hidden') return true
    if (tag === 'input' && (el as HTMLInputElement).type === 'hidden') return true
    const rect = h.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) {
      // Don't skip elements that carry an explicit interactive role or are
      // form-control elements. react-select v5 (and similar custom-combobox
      // libraries) renders the trigger as an `<input role="combobox">` with
      // CSS grid layout that gives it 0 width until it's been focused at
      // least once. Filtering it out leaves the entire combobox missing
      // from the a11y tree, which breaks verifyFills, geometra_query, and
      // any agent that wants to verify a custom-combobox post-fill state.
      // pickMeaningfulControlRect will expand the rect to a visible wrapper
      // when the snapshot node is built, so the downstream layout is sound.
      const role = h.getAttribute('role')
      if (role === 'combobox' || role === 'textbox' || role === 'listbox' || role === 'searchbox' || role === 'spinbutton') {
        return false
      }
      if (
        el instanceof HTMLInputElement ||
        el instanceof HTMLSelectElement ||
        el instanceof HTMLTextAreaElement
      ) {
        return false
      }
      return true
    }
    const op = parseFloat(style.opacity)
    if (op === 0 && !shouldKeepDespiteOpacity(el)) return true
    return false
  }

  function displayedElementChildren(container: Element): Element[] {
    const out: Element[] = []
    for (const c of container.children) {
      if (!shouldSkip(c)) out.push(c)
    }
    const sr = (container as HTMLElement).shadowRoot
    if (sr) {
      for (const c of sr.children) {
        if (!shouldSkip(c)) out.push(c)
      }
    }
    return out
  }

  function defaultRoleForTag(el: Element, tag: string): string | undefined {
    const explicit = el.getAttribute('role')
    if (explicit) return explicit
    if (tag === 'nav') return 'navigation'
    if (tag === 'main') return 'main'
    if (tag === 'article') return 'article'
    if (tag === 'section') return 'region'
    if (tag === 'ul' || tag === 'ol') return 'list'
    if (tag === 'li') return 'listitem'
    if (tag === 'form') return 'form'
    if (tag === 'button') return 'button'
    if (tag === 'a') return 'link'
    if (tag === 'h1' || tag === 'h2' || tag === 'h3' || tag === 'h4' || tag === 'h5' || tag === 'h6') {
      return 'heading'
    }
    if (tag === 'img') return 'img'
    if (tag === 'input') {
      const t = (el as HTMLInputElement).type
      if (t === 'checkbox') return 'checkbox'
      if (t === 'radio') return 'radio'
      if (t === 'submit' || t === 'button' || t === 'reset') return 'button'
      return 'textbox'
    }
    if (tag === 'select') return 'combobox'
    if (tag === 'textarea') return 'textbox'
    return undefined
  }

  /**
   * Detect whether an `<input>` (or any element) lives inside an
   * autocomplete / searchable combobox wrapper. This mirrors
   * `isAutocompleteCombobox` in `dom-actions.ts` (the v1.42 pickListboxOption
   * commit-via-Enter helper) so that extractor classification stays in sync
   * with action-side commit semantics.
   *
   * Used by Bug #3 (v1.43): a React Select Country picker in Greenhouse's
   * Remix address block renders as a plain `<input>` with no `role="combobox"`
   * ancestor, so the form-schema classifier used to flag it as `text`. The
   * fill_form pipeline then routed through the text-fill path, which cannot
   * commit a React Select's controlled value. The fix is to surface the
   * autocomplete-wrapper signal into the semantic tree so the MCP's
   * `simpleSchemaField` classifier can re-tag it as `choice`/`listbox` and
   * route the fill through `pick_listbox_option` (which does the click +
   * Enter-commit dance).
   *
   * Detection signals (same as dom-actions.ts:isAutocompleteCombobox):
   *   1. `aria-autocomplete="list"` / `="both"` on the element or up to 5
   *      ancestor levels.
   *   2. Class pattern indicative of a known library: React Select
   *      (`select__control`, `select__`), React Suite picker (`rs-picker`),
   *      Ant Design (`ant-select`), Headless UI combobox (`headlessui-combobox`),
   *      cmdk command menu (`cmdk-`).
   *   3. `role="combobox"` + `aria-expanded` on the element or an ancestor
   *      (ARIA 1.2 combobox pattern).
   *
   * Native `<select>` / plain ARIA listboxes do NOT match any of these, so
   * classifying on this signal cannot break non-searchable listboxes.
   */
  function isAutocompleteComboboxAncestry(el: Element): boolean {
    let cur: Element | null = el
    let depth = 0
    while (cur && depth < 5) {
      const ac = cur.getAttribute('aria-autocomplete')
      if (ac === 'list' || ac === 'both') return true

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

      if (cur.getAttribute('role') === 'combobox' && cur.hasAttribute('aria-expanded')) {
        return true
      }
      cur = cur.parentElement
      depth++
    }
    // Look downward for a descendant input that declares aria-autocomplete —
    // some Headless UI / Downshift wrappers expose the control via a sibling
    // input inside the trigger container.
    try {
      const descendant = el.querySelector?.(
        '[aria-autocomplete="list"], [aria-autocomplete="both"]',
      )
      if (descendant) return true
    } catch {
      /* querySelector can throw on detached nodes — ignore */
    }
    return false
  }

  /**
   * Preserve an authored identity for form controls so downstream consumers do
   * not have to resolve a field by its (often duplicated) accessible label.
   *
   * `controlKey` is deliberately based only on authored attributes. We do not
   * fall back to a DOM index/path because those change whenever a reactive form
   * inserts, removes, or reorders conditional fields.
   */
  function addAuthoredControlIdentity(
    semantic: Record<string, unknown>,
    el: Element,
    tag: string,
    role: string | undefined,
  ): void {
    const isNativeControl =
      el instanceof HTMLInputElement ||
      el instanceof HTMLTextAreaElement ||
      el instanceof HTMLSelectElement ||
      el instanceof HTMLButtonElement
    const normalizedRole = role?.trim().toLowerCase()
    if (!isNativeControl && (!normalizedRole || !FORM_CONTROL_ROLES.has(normalizedRole))) return

    const controlId = el.getAttribute('id')
    const controlName = el.getAttribute('name')
    if (controlId?.trim()) semantic.controlId = controlId
    if (controlName?.trim()) semantic.controlName = controlName

    if (controlId?.trim()) {
      semantic.controlKey = `id:${encodeURIComponent(controlId)}`
      return
    }
    if (!controlName?.trim()) return

    // Use the authored attribute, not DOM defaults such as input.type="text",
    // button.type="submit", or select.type="select-one". This keeps the key
    // derivation identical in the extractor and action resolver.
    const controlType = el.getAttribute('type')?.trim().toLowerCase() || 'default'
    semantic.controlKey = `name:${tag}:${controlType}:${encodeURIComponent(controlName)}`
  }

  /** Native select options are otherwise lost because <select> is a leaf node. */
  function nativeSelectOptions(el: HTMLSelectElement): Array<{
    value: string
    label: string
    disabled: boolean
    selected: boolean
    index: number
  }> {
    return Array.from(el.options).map((option, index) => ({
      // Preserve the submitted value exactly. It can intentionally differ
      // from the visible label (and may even be duplicated).
      value: option.value,
      label: option.label.replace(/\s+/g, ' ').trim(),
      // HTMLOptionElement.disabled does not include a disabled <optgroup>.
      disabled:
        option.disabled || (option.parentElement instanceof HTMLOptGroupElement && option.parentElement.disabled),
      selected: option.selected,
      // Index is retained so two identical label/value pairs remain distinct.
      index,
    }))
  }

  function semanticFor(el: Element, tag: string): Record<string, unknown> {
    const semantic: Record<string, unknown> = { tag }
    const role = defaultRoleForTag(el, tag)
    if (role) semantic.role = role
    addAuthoredControlIdentity(semantic, el, tag, role)
    if (el instanceof HTMLSelectElement) semantic.options = nativeSelectOptions(el)
    const al = el.getAttribute('aria-label')
    if (al) semantic.ariaLabel = al
    const valueText = controlValueText(el)
    if (valueText) semantic.valueText = valueText
    if (controlRequired(el)) semantic.ariaRequired = true
    if (controlInvalid(el)) semantic.ariaInvalid = true
    if (controlBusy(el)) semantic.ariaBusy = true
    const validationDescription = controlDescriptionText(el)
    if (validationDescription) semantic.validationDescription = validationDescription
    const validationError = controlErrorText(el)
    if (validationError) semantic.validationError = validationError
    if (isTextLikeControl(el)) {
      const placeholder = el.getAttribute('placeholder')?.trim()
      if (placeholder) semantic.placeholder = placeholder
      const pattern = el.getAttribute('pattern')
      if (pattern) semantic.inputPattern = pattern
      const inputType = (el instanceof HTMLInputElement) ? el.type : undefined
      if (inputType && ['date', 'tel', 'email', 'url', 'number'].includes(inputType)) {
        semantic.inputType = inputType
      }
      const autocomplete = el.getAttribute('autocomplete')?.trim()
      if (autocomplete && autocomplete !== 'off' && autocomplete !== 'on') {
        semantic.autocomplete = autocomplete
      }
      // Bug #3 (v1.43): tag the element when its ancestry fingerprints a
      // searchable combobox wrapper. The MCP's form-schema classifier reads
      // this to re-tag the field as choice/listbox so fill_form routes
      // through pick_listbox_option instead of the plain text-fill path.
      if (isAutocompleteComboboxAncestry(el)) {
        semantic.isAutocompleteCombobox = true
      }
    }
    const h = el as HTMLElement
    if (h instanceof HTMLInputElement && h.disabled) semantic.ariaDisabled = true
    if (h instanceof HTMLButtonElement && h.disabled) semantic.ariaDisabled = true
    if (h instanceof HTMLSelectElement && h.disabled) semantic.ariaDisabled = true
    if (h instanceof HTMLTextAreaElement && h.disabled) semantic.ariaDisabled = true
    const exp = el.getAttribute('aria-expanded')
    if (exp !== null) semantic.ariaExpanded = exp === 'true'
    const sel = el.getAttribute('aria-selected')
    if (sel !== null) semantic.ariaSelected = sel === 'true'
    const checked = readCheckedState(el)
    if (checked !== undefined) semantic.ariaChecked = checked
    if (tag === 'img') {
      const alt = el.getAttribute('alt')
      if (alt) semantic.alt = alt
    }
    if (document.activeElement === el) semantic.focused = true
    if (h.isContentEditable) semantic.role = 'textbox'
    return semantic
  }

  function handlersFor(focusable: boolean): TreeSnapshot['handlers'] | undefined {
    if (!focusable) return undefined
    return { onClick: true, onKeyDown: true, onKeyUp: true }
  }

  function extractFormControl(el: Element, tag: string): { layout: LayoutSnapshot; tree: TreeSnapshot } {
    const h = el as HTMLElement
    const rect = pickMeaningfulControlRect(el)
    const layout: LayoutSnapshot = {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      children: [],
    }
    const name = getAccessibleName(el)
    const sem = semanticFor(el, tag)
    if (h instanceof HTMLInputElement && h.type === 'file') {
      sem.role = 'button'
      sem.fileInput = true
    }
    if (name && !sem.ariaLabel) sem.ariaLabel = name
    const focusable = isFocusable(el)
    const tree: TreeSnapshot = {
      kind: 'box',
      props: {},
      semantic: sem,
      handlers: handlersFor(focusable),
    }
    return { layout, tree }
  }

  function extractImage(el: HTMLImageElement): { layout: LayoutSnapshot; tree: TreeSnapshot } {
    const rect = el.getBoundingClientRect()
    const layout: LayoutSnapshot = {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      children: [],
    }
    const tree: TreeSnapshot = {
      kind: 'image',
      props: { src: el.currentSrc || el.src || '', alt: el.alt || '' },
      semantic: { tag: 'img', alt: el.alt || undefined, role: 'img' },
    }
    return { layout, tree }
  }

  function extractElement(el: Element): { layout: LayoutSnapshot; tree: TreeSnapshot } | null {
    if (shouldSkip(el)) return null
    const tag = el.tagName.toLowerCase()
    if (tag === 'img' && el instanceof HTMLImageElement) return extractImage(el)
    if (LEAF_FORM_TAGS.has(tag)) return extractFormControl(el, tag)

    if (tag === 'iframe' && el instanceof HTMLIFrameElement) {
      const iframe = el as HTMLIFrameElement
      const rect = iframe.getBoundingClientRect()
      const layout: LayoutSnapshot = {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        children: [],
      }
      const sem = semanticFor(iframe, 'iframe')
      sem.iframe = true
      sem.iframePlaceholder = true
      return {
        layout,
        tree: {
          kind: 'box',
          props: {},
          semantic: sem,
          handlers: handlersFor(isFocusable(iframe)),
          children: [],
        },
      }
    }

    const h = el as HTMLElement
    const rect = h.getBoundingClientRect()
    const layout: LayoutSnapshot = {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      children: [],
    }

    const elementChildren = displayedElementChildren(el)
    if (elementChildren.length === 0) {
      const text = (el.textContent || '').trim()
      if (text.length > 0) {
        const sem = semanticFor(el, tag)
        const name = getAccessibleName(el)
        if (name && !sem.ariaLabel) sem.ariaLabel = name
        const focusable = isFocusable(el)
        const tree: TreeSnapshot = {
          kind: 'text',
          props: { text, font: '16px system-ui', lineHeight: 1.2 },
          semantic: sem,
          handlers: handlersFor(focusable),
        }
        return { layout, tree }
      }
      const sem = semanticFor(el, tag)
      const name = getAccessibleName(el)
      if (name && !sem.ariaLabel) sem.ariaLabel = name
      const focusable = isFocusable(el)
      const tree: TreeSnapshot = {
        kind: 'box',
        props: {},
        semantic: sem,
        handlers: handlersFor(focusable),
      }
      return { layout, tree }
    }

    const treeChildren: TreeSnapshot[] = []
    for (const child of elementChildren) {
      const sub = extractElement(child)
      if (sub) {
        layout.children.push(sub.layout)
        treeChildren.push(sub.tree)
      }
    }
    const sem = semanticFor(el, tag)
    const name = getAccessibleName(el)
    if (name && !sem.ariaLabel) sem.ariaLabel = name
    const focusable = isFocusable(el)
    const tree: TreeSnapshot = {
      kind: 'box',
      props: {},
      semantic: sem,
      handlers: handlersFor(focusable),
      children: treeChildren,
    }
    return { layout, tree }
  }

  const body = document.body
  if (!body) {
    const emptyLayout: LayoutSnapshot = { x: 0, y: 0, width: 0, height: 0, children: [] }
    const emptyTree: TreeSnapshot = { kind: 'box', props: {}, semantic: { tag: 'body' }, children: [] }
    return { layout: emptyLayout, tree: emptyTree }
  }

  const elementChildren = displayedElementChildren(body)
  const layout: LayoutSnapshot = {
    x: 0,
    y: 0,
    width: Math.round(document.documentElement.clientWidth),
    height: Math.round(document.documentElement.clientHeight),
    children: [],
  }
  const treeChildren: TreeSnapshot[] = []
  for (const child of elementChildren) {
    const sub = extractElement(child)
    if (sub) {
      layout.children.push(sub.layout)
      treeChildren.push(sub.tree)
    }
  }
  const tree: TreeSnapshot = {
    kind: 'box',
    props: {},
    semantic: {
      tag: 'body',
      role: 'group',
      pageUrl: location.href,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
    },
    children: treeChildren,
  }
  return { layout, tree }
}

function cloneLayout(layout: LayoutSnapshot): LayoutSnapshot {
  return structuredClone(layout)
}

function cloneTree(tree: TreeSnapshot): TreeSnapshot {
  return structuredClone(tree)
}

export interface ExtractGeometryTrace {
  mainFrameMs?: number
  iframeCount?: number
  iframeMergeMs?: number
  axDecisionMs?: number
  axEnrichMs?: number
  axRan?: boolean
  treeJsonMs?: number
  totalMs?: number
}

async function captureFrameGeometry(frame: Frame): Promise<{ layout: LayoutSnapshot; tree: TreeSnapshot }> {
  const raw = await frame.evaluate(browserExtractGeometry)
  return {
    layout: raw.layout as LayoutSnapshot,
    tree: raw.tree as TreeSnapshot,
  }
}

export async function extractFrameGeometry(frame: Frame): Promise<GeometrySnapshot> {
  const { tree, layout } = await captureFrameGeometry(frame)
  return {
    layout,
    tree,
    treeJson: JSON.stringify(tree),
  }
}

export async function mergeAllIframes(
  tree: TreeSnapshot,
  layout: LayoutSnapshot,
  ownerFrame: Frame,
): Promise<void> {
  if (ownerFrame.childFrames().length === 0) return

  async function dfs(t: TreeSnapshot, l: LayoutSnapshot, f: Frame): Promise<void> {
    const subFrames = f.childFrames()
    if (subFrames.length === 0) return
    let slot = 0
    const tch = t.children ?? []
    const lch = l.children
    for (let i = 0; i < tch.length; i++) {
      const st = tch[i]!
      const sl = lch[i]!
      if (st.semantic?.tag === 'iframe') {
        const cf = subFrames[slot++]
        if (cf && !cf.isDetached()) {
          const snap = await captureFrameGeometry(cf)
          await mergeAllIframes(snap.tree, snap.layout, cf)
          const { x: ox, y: oy } = await frameOriginInRootPage(cf)
          sl.children = snap.layout.children.map(c => {
            const copy = cloneLayout(c)
            offsetLayoutSubtree(copy, ox, oy)
            return copy
          })
          st.children = (snap.tree.children ?? []).map(cloneTree)
          st.semantic = { ...st.semantic, frameUrl: cf.url() }
          await dfs(st, sl, cf)
        }
      } else {
        await dfs(st, sl, f)
      }
    }
  }
  await dfs(tree, layout, ownerFrame)
}

export interface ExtractGeometryOptions {
  axSessionManager?: CdpAxSessionManager
  trace?: ExtractGeometryTrace
}

/**
 * Full page: main frame + every nested iframe (any origin) + optional CDP AX name enrichment.
 */
export async function extractGeometry(page: Page, options?: ExtractGeometryOptions): Promise<GeometrySnapshot> {
  const trace = options?.trace
  const totalStartedAt = performance.now()

  const mainFrameStartedAt = performance.now()
  const mainFrame = await captureFrameGeometry(page.mainFrame())
  if (trace) {
    trace.mainFrameMs = performance.now() - mainFrameStartedAt
    trace.iframeCount = Math.max(0, page.frames().length - 1)
  }
  const main: GeometrySnapshot = {
    layout: mainFrame.layout,
    tree: mainFrame.tree,
    treeJson: '',
  }

  const iframeMergeStartedAt = performance.now()
  await mergeAllIframes(main.tree, main.layout, page.mainFrame())
  if (trace) {
    trace.iframeMergeMs = performance.now() - iframeMergeStartedAt
  }

  const axDecisionStartedAt = performance.now()
  const shouldRunAxEnrichment = shouldEnrichSnapshotWithCdpAx(main)
  if (trace) {
    trace.axDecisionMs = performance.now() - axDecisionStartedAt
    trace.axRan = shouldRunAxEnrichment
  }

  if (shouldRunAxEnrichment) {
    const axEnrichStartedAt = performance.now()
    await enrichSnapshotWithCdpAx(page, main, options?.axSessionManager)
    if (trace) {
      trace.axEnrichMs = performance.now() - axEnrichStartedAt
    }
  }

  const treeJsonStartedAt = performance.now()
  main.treeJson = JSON.stringify(main.tree)
  if (trace) {
    trace.treeJsonMs = performance.now() - treeJsonStartedAt
    trace.totalMs = performance.now() - totalStartedAt
  }
  return main
}
