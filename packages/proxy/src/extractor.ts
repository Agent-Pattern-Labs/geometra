import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import type { Frame, JSHandle, Page } from 'playwright'
import {
  createCdpAxSessionManager,
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
  const CLOSED_SHADOW_ROOTS_SYMBOL = Symbol.for('geometra.closedShadowRoots')
  const IFRAME_IDENTITIES_SYMBOL = Symbol.for('geometra.iframeIdentities')
  const fileDescendantCache = new WeakMap<Element, boolean>()
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

  function registeredShadowRootForHost(host: Element): ShadowRoot | null {
    const openRoot = (host as HTMLElement).shadowRoot
    if (openRoot) return openRoot
    try {
      const registry = (globalThis as unknown as Record<symbol, unknown>)[CLOSED_SHADOW_ROOTS_SYMBOL]
      if (!(registry instanceof WeakMap)) return null
      const root = registry.get(host)
      return root instanceof ShadowRoot ? root : null
    } catch {
      return null
    }
  }

  function rootScopedElementById(owner: Element, id: string): Element | null {
    const root = owner.getRootNode()
    if (root instanceof ShadowRoot) return root.getElementById(id)
    if (root instanceof Document) return root.getElementById(id)
    return null
  }

  function closedShadowRootForElement(el: Element): ShadowRoot | null {
    const root = el.getRootNode()
    return root instanceof ShadowRoot && root.mode === 'closed' ? root : null
  }

  function iframeIdentityForElement(el: HTMLIFrameElement): string | undefined {
    try {
      const registry = (globalThis as unknown as Record<symbol, unknown>)[IFRAME_IDENTITIES_SYMBOL]
      if (!(registry instanceof WeakMap)) return undefined
      const identity = registry.get(el)
      return typeof identity === 'string' && identity ? identity : undefined
    } catch {
      return undefined
    }
  }

  function isClosedShadowFormControl(el: Element): boolean {
    if (!closedShadowRootForElement(el)) return false
    if (
      el instanceof HTMLInputElement ||
      el instanceof HTMLTextAreaElement ||
      el instanceof HTMLSelectElement
    ) return true
    if (el instanceof HTMLElement && el.isContentEditable) return true
    const role = el.getAttribute('role')?.trim().toLowerCase()
    return !!role && role !== 'button' && FORM_CONTROL_ROLES.has(role)
  }

  function subtreeContainsExtractableFileInput(container: Element): boolean {
    const cached = fileDescendantCache.get(container)
    if (cached !== undefined) return cached
    if (container instanceof HTMLInputElement && container.type === 'file') {
      fileDescendantCache.set(container, true)
      return true
    }
    if (container.querySelector('input[type="file"]')) {
      fileDescendantCache.set(container, true)
      return true
    }
    for (const host of [container, ...container.querySelectorAll('*')]) {
      const root = registeredShadowRootForHost(host)
      if (root?.mode !== 'open') continue
      if (root.querySelector('input[type="file"]')) {
        fileDescendantCache.set(container, true)
        return true
      }
      for (const shadowChild of root.children) {
        if (subtreeContainsExtractableFileInput(shadowChild)) {
          fileDescendantCache.set(container, true)
          return true
        }
      }
    }
    fileDescendantCache.set(container, false)
    return false
  }

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
      const resolveChainFrom = (owner: Element, ids: string, visited: Set<string>): string =>
        ids
          .split(/\s+/)
          .map(id => {
            if (visited.has(id)) return ''
            visited.add(id)
            const target = rootScopedElementById(owner, id)
            if (!target) return ''
            const chained = target.getAttribute('aria-labelledby')
            if (chained) {
              const chainedText = resolveChainFrom(target, chained, visited)
              if (chainedText) return chainedText
            }
            return textWithoutNestedControls(target).replace(/\s+/g, ' ').trim()
          })
          .filter(Boolean)
          .join(' ')
          .trim()
      const text = resolveChainFrom(el, labelledBy, new Set<string>())
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
      const root = el.getRootNode()
      const label = (root instanceof Document || root instanceof ShadowRoot)
        ? root.querySelector(`label[for="${CSS.escape(el.id)}"]`)
        : document.querySelector(`label[for="${CSS.escape(el.id)}"]`)
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

  function referencedText(owner: Element, ids: string | null, visited?: Set<string>): string | undefined {
    if (!ids) return undefined
    const seen = visited ?? new Set<string>()
    const text = ids
      .split(/\s+/)
      .map(id => {
        if (seen.has(id)) return ''
        seen.add(id)
        const target = rootScopedElementById(owner, id)
        if (!target) return ''
        const chained = target.getAttribute('aria-labelledby')
        if (chained) return referencedText(target, chained, seen) ?? ''
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
        if (el.willValidate) return !el.validity.valid
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
    const err = referencedText(el, el.getAttribute('aria-errormessage'))
    if (err) return err
    if (!controlInvalid(el)) return undefined
    const described = referencedText(el, el.getAttribute('aria-describedby'))
    if (described && looksLikeValidationText(described)) return described
    return undefined
  }

  function controlDescriptionText(el: Element): string | undefined {
    const described = referencedText(el, el.getAttribute('aria-describedby'))
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
    const isFileInput = el instanceof HTMLInputElement && el.type === 'file'
    const preservesFileAncestry = isFileInput || subtreeContainsExtractableFileInput(el)
    // Hidden chooser inputs still define required/accept/multiple schema and
    // are commonly activated by a visible dropzone or button. Preserve their
    // semantics even though they have no coordinate target.
    if (!preservesFileAncestry && (style.display === 'none' || style.visibility === 'hidden')) return true
    if (tag === 'input' && (el as HTMLInputElement).type === 'hidden') return true
    const rect = h.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) {
      if (preservesFileAncestry) return false
      // A zero-sized shadow host can still contain positioned, visible
      // controls. The early page instrumentation keeps a weak reference to
      // closed roots so read-only extraction can traverse them without
      // adding observable attributes to the application DOM.
      if (registeredShadowRootForHost(el)) return false
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
    const sr = registeredShadowRootForHost(container)
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
    const closedShadowRoot = closedShadowRootForElement(el)
    if (closedShadowRoot) {
      // Closed-root descendants cannot be resolved by Playwright locators.
      // Keep non-form interactive geometry available for coordinate actions,
      // but never advertise an authored semantic target that actions cannot
      // subsequently pierce.
      semantic.shadowMode = 'closed'
      semantic.coordinateOnly = true
    } else {
      addAuthoredControlIdentity(semantic, el, tag, role)
    }
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
    const authoredDisabled = el.getAttribute('aria-disabled')
    if (authoredDisabled !== null) semantic.ariaDisabled = authoredDisabled === 'true'
    if (
      (h instanceof HTMLInputElement || h instanceof HTMLTextAreaElement) &&
      h.readOnly
    ) semantic.ariaReadonly = true
    const authoredReadonly = el.getAttribute('aria-readonly')
    if (authoredReadonly !== null) semantic.ariaReadonly = authoredReadonly === 'true'
    if (h.inert || el.hasAttribute('inert')) semantic.inert = true
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
      sem.inputType = 'file'
      const accept = h.accept.trim()
      if (accept) sem.accept = accept
      sem.multiple = h.multiple
      if (!name) {
        const authoredFallback = h.getAttribute('name')?.trim() || h.getAttribute('id')?.trim()
        if (authoredFallback) sem.ariaLabel = authoredFallback
      }
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
    // Actions cannot pierce a closed shadow root. Omitting its form controls
    // keeps form schemas truthful; ordinary interactive content (for example,
    // a button) remains available as explicitly coordinate-only geometry.
    if (isClosedShadowFormControl(el)) return null
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
      const name = getAccessibleName(iframe)
      if (name && !sem.ariaLabel) sem.ariaLabel = name
      sem.iframe = true
      sem.iframePlaceholder = true
      const iframeIdentity = iframeIdentityForElement(iframe)
      if (iframeIdentity) sem.iframeIdentity = iframeIdentity
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
    const emptyTree: TreeSnapshot = {
      kind: 'box',
      props: {},
      semantic: { tag: 'body' },
      children: [],
    }
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

interface CachedAxAppendNode {
  tree: TreeSnapshot
  layout: LayoutSnapshot
}

interface CachedAxSemanticPatch {
  path: number[]
  semantic: Record<string, unknown>
}

interface AxDocumentState {
  documentIdentity: string
  probeStatus: 'pending' | 'succeeded' | 'failed'
  lastHeuristicFingerprint?: string
  lastAxProbeAtMs: number
  currentGeometryFingerprint: string
  currentSemanticFingerprint: string
  cachedGeometryFingerprint?: string
  cachedSemanticFingerprint?: string
  cachedAxRevision?: string
  cachedAppendNodes: CachedAxAppendNode[]
  cachedSemanticPatches: CachedAxSemanticPatch[]
  cacheInvalidated: boolean
  refreshingWithSafeCache: boolean
  automaticRetryUsed: boolean
}

const axDocumentStateByPage = new WeakMap<Page, AxDocumentState>()
const defaultAxSessionManagerByPage = new WeakMap<Page, CdpAxSessionManager>()
const AX_HEURISTIC_MIN_INTERVAL_MS = 10_000

function axSessionManagerForPage(
  page: Page,
  explicit: CdpAxSessionManager | undefined,
): CdpAxSessionManager {
  if (explicit) return explicit
  const existing = defaultAxSessionManagerByPage.get(page)
  if (existing) return existing
  const manager = createCdpAxSessionManager()
  defaultAxSessionManagerByPage.set(page, manager)
  page.once('close', () => {
    if (defaultAxSessionManagerByPage.get(page) === manager) {
      defaultAxSessionManagerByPage.delete(page)
    }
    void manager.close()
  })
  return manager
}

function snapshotGeometryFingerprint(snapshot: GeometrySnapshot): string {
  const parts: string[] = []
  const rootSemantic = snapshot.tree.semantic ?? {}
  parts.push(`scroll:${String(rootSemantic.scrollX ?? '')},${String(rootSemantic.scrollY ?? '')}`)

  function visit(tree: TreeSnapshot, layout: LayoutSnapshot): void {
    const semantic = tree.semantic ?? {}
    parts.push([
      typeof semantic.tag === 'string' ? semantic.tag : '',
      typeof semantic.role === 'string' ? semantic.role : '',
      layout.x,
      layout.y,
      layout.width,
      layout.height,
      tree.children?.length ?? 0,
    ].join(':'))
    const children = tree.children ?? []
    for (let index = 0; index < children.length; index++) {
      const childLayout = layout.children[index]
      if (childLayout) visit(children[index]!, childLayout)
    }
  }

  visit(snapshot.tree, snapshot.layout)
  return parts.join('|')
}

function snapshotSemanticFingerprint(snapshot: GeometrySnapshot): string {
  // The un-enriched DOM tree is already deterministic and contains the
  // action-relevant text, accessible labels, values, checked/selected state,
  // disabled/readonly state, options, handlers, and authored identities. Keep
  // the exact serialization instead of a lossy hash: a cache miss is cheap,
  // while a collision could resurrect a stale destructive action label.
  return JSON.stringify(snapshot.tree)
}

function axHeuristicFingerprint(snapshot: GeometrySnapshot): string {
  // This is only computed when the cheap DOM heuristic already says AX is
  // needed. Remembering the last unhealthy shape prevents a permanently
  // unnamed control from launching getFullAXTree on every RAF extraction.
  const parts: string[] = []
  let meaningfulCount = 0

  function visit(tree: TreeSnapshot, layout: LayoutSnapshot, path: string): void {
    const semantic = tree.semantic ?? {}
    const role = typeof semantic.role === 'string' ? semantic.role : ''
    const label = axNodeLabel(tree)
    const interactive = !!tree.handlers?.onClick || !!tree.handlers?.onKeyDown || !!tree.handlers?.onKeyUp ||
      ['button', 'link', 'textbox', 'combobox', 'checkbox', 'radio', 'tab'].includes(role)
    if (tree.handlers || tree.props.text || (role && role !== 'group')) meaningfulCount += 1
    if (interactive && !label) {
      parts.push(`${path}:${role}:${layout.x},${layout.y},${layout.width},${layout.height}`)
    }
    const children = tree.children ?? []
    for (let index = 0; index < children.length; index++) {
      const childLayout = layout.children[index]
      if (childLayout) visit(children[index]!, childLayout, `${path}.${index}`)
    }
  }

  visit(snapshot.tree, snapshot.layout, '0')
  return `${Math.min(meaningfulCount, 2)}|${parts.join('|')}`
}

function axCacheHasPayload(state: AxDocumentState): boolean {
  return state.cachedAppendNodes.length > 0 || state.cachedSemanticPatches.length > 0
}

function clearAxCache(state: AxDocumentState): void {
  state.cachedAppendNodes = []
  state.cachedSemanticPatches = []
  state.cachedGeometryFingerprint = undefined
  state.cachedSemanticFingerprint = undefined
  state.cachedAxRevision = undefined
}

function planAxProbe(
  page: Page,
  documentIdentity: string | undefined,
  snapshot: GeometrySnapshot,
  axRevision: string | undefined,
): {
  firstDocumentProbe: boolean
  shouldRun: boolean
  mayReplayCache: boolean
  geometryFingerprint: string
  semanticFingerprint: string
  cacheReplaySuppressed?: boolean
  retryAfterMs?: number
  state?: AxDocumentState
} {
  const heuristicRequestsAx = shouldEnrichSnapshotWithCdpAx(snapshot)
  const geometryFingerprint = snapshotGeometryFingerprint(snapshot)
  const semanticFingerprint = snapshotSemanticFingerprint(snapshot)
  if (!documentIdentity) {
    return {
      firstDocumentProbe: false,
      shouldRun: heuristicRequestsAx,
      mayReplayCache: false,
      geometryFingerprint,
      semanticFingerprint,
    }
  }

  const heuristicFingerprint = heuristicRequestsAx ? axHeuristicFingerprint(snapshot) : undefined
  const now = performance.now()
  let state = axDocumentStateByPage.get(page)
  if (!state || state.documentIdentity !== documentIdentity) {
    state = {
      documentIdentity,
      probeStatus: 'pending',
      lastHeuristicFingerprint: heuristicFingerprint,
      lastAxProbeAtMs: now,
      currentGeometryFingerprint: geometryFingerprint,
      currentSemanticFingerprint: semanticFingerprint,
      cachedAppendNodes: [],
      cachedSemanticPatches: [],
      cacheInvalidated: false,
      refreshingWithSafeCache: false,
      automaticRetryUsed: false,
    }
    // Claim synchronously before any CDP await so concurrent RAF extracts
    // cannot launch duplicate full-tree traversals for this document.
    axDocumentStateByPage.set(page, state)
    return {
      firstDocumentProbe: true,
      shouldRun: true,
      mayReplayCache: false,
      geometryFingerprint,
      semanticFingerprint,
      state,
    }
  }

  // Record the newest DOM snapshot synchronously. A background probe may
  // finish after a newer extraction; it is allowed to populate cache only if
  // both the semantic and geometry revisions still match its starting point.
  state.currentGeometryFingerprint = geometryFingerprint
  state.currentSemanticFingerprint = semanticFingerprint
  const elapsedSinceProbe = Math.max(0, now - state.lastAxProbeAtMs)
  const retryAfterMs = Math.max(0, AX_HEURISTIC_MIN_INTERVAL_MS - elapsedSinceProbe)
  const unclaimedRetryAfterMs = state.automaticRetryUsed ? undefined : retryAfterMs

  if (state.probeStatus === 'pending') {
    const wasRefreshingWithSafeCache = state.refreshingWithSafeCache
    const refreshingCacheStillSafe =
      wasRefreshingWithSafeCache &&
      state.cachedGeometryFingerprint === geometryFingerprint &&
      state.cachedSemanticFingerprint === semanticFingerprint &&
      !!axRevision &&
      state.cachedAxRevision === axRevision
    if (state.refreshingWithSafeCache && !refreshingCacheStillSafe) {
      clearAxCache(state)
      state.cacheInvalidated = true
      state.refreshingWithSafeCache = false
    }
    return {
      firstDocumentProbe: false,
      shouldRun: false,
      mayReplayCache: refreshingCacheStillSafe && axCacheHasPayload(state),
      geometryFingerprint,
      semanticFingerprint,
      ...(wasRefreshingWithSafeCache && !refreshingCacheStillSafe
        ? { cacheReplaySuppressed: true }
        : {}),
      state,
    }
  }
  if (state.probeStatus === 'failed') {
    if (elapsedSinceProbe < AX_HEURISTIC_MIN_INTERVAL_MS) {
      return {
        firstDocumentProbe: false,
        shouldRun: false,
        mayReplayCache: false,
        geometryFingerprint,
        semanticFingerprint,
        retryAfterMs: unclaimedRetryAfterMs,
        state,
      }
    }
    state.probeStatus = 'pending'
    state.lastAxProbeAtMs = now
    state.refreshingWithSafeCache = false
    return {
      firstDocumentProbe: false,
      shouldRun: true,
      mayReplayCache: false,
      geometryFingerprint,
      semanticFingerprint,
      state,
    }
  }

  const cachedSnapshotInvalid =
    state.cacheInvalidated ||
    state.cachedGeometryFingerprint !== geometryFingerprint ||
    state.cachedSemanticFingerprint !== semanticFingerprint ||
    !axRevision ||
    state.cachedAxRevision !== axRevision
  if (cachedSnapshotInvalid) {
    // Drop the stale payload immediately. Retaining it until the cadence opens
    // risks replay if a same-bounds SPA replacement later happens to restore a
    // previous geometry shape.
    clearAxCache(state)
    state.cacheInvalidated = true
    state.refreshingWithSafeCache = false
    if (elapsedSinceProbe >= AX_HEURISTIC_MIN_INTERVAL_MS) {
      state.probeStatus = 'pending'
      state.lastAxProbeAtMs = now
      state.lastHeuristicFingerprint = heuristicFingerprint
      return {
        firstDocumentProbe: false,
        shouldRun: true,
        mayReplayCache: false,
        geometryFingerprint,
        semanticFingerprint,
        cacheReplaySuppressed: true,
        state,
      }
    }
    return {
      firstDocumentProbe: false,
      shouldRun: false,
      mayReplayCache: false,
      geometryFingerprint,
      semanticFingerprint,
      cacheReplaySuppressed: true,
      retryAfterMs: unclaimedRetryAfterMs,
      state,
    }
  }

  if (elapsedSinceProbe >= AX_HEURISTIC_MIN_INTERVAL_MS) {
    const mayReplayCache = axCacheHasPayload(state)
    state.probeStatus = 'pending'
    state.lastAxProbeAtMs = now
    state.lastHeuristicFingerprint = heuristicFingerprint
    state.refreshingWithSafeCache = mayReplayCache
    return {
      firstDocumentProbe: false,
      shouldRun: true,
      mayReplayCache,
      geometryFingerprint,
      semanticFingerprint,
      state,
    }
  }

  if (!heuristicRequestsAx) {
    state.lastHeuristicFingerprint = undefined
    return {
      firstDocumentProbe: false,
      shouldRun: false,
      mayReplayCache: true,
      geometryFingerprint,
      semanticFingerprint,
      state,
    }
  }
  if (state.lastHeuristicFingerprint === heuristicFingerprint) {
    return {
      firstDocumentProbe: false,
      shouldRun: false,
      mayReplayCache: true,
      geometryFingerprint,
      semanticFingerprint,
      state,
    }
  }
  if (elapsedSinceProbe < AX_HEURISTIC_MIN_INTERVAL_MS) {
    // Keep the prior fingerprint so the changed unhealthy shape remains
    // pending and is probed once the bounded cadence opens.
    return {
      firstDocumentProbe: false,
      shouldRun: false,
      mayReplayCache: true,
      geometryFingerprint,
      semanticFingerprint,
      retryAfterMs: unclaimedRetryAfterMs,
      state,
    }
  }
  state.lastHeuristicFingerprint = heuristicFingerprint
  state.probeStatus = 'pending'
  state.lastAxProbeAtMs = now
  state.refreshingWithSafeCache = axCacheHasPayload(state)
  return {
    firstDocumentProbe: false,
    shouldRun: true,
    mayReplayCache: state.refreshingWithSafeCache,
    geometryFingerprint,
    semanticFingerprint,
    state,
  }
}

function axNodeLabel(tree: TreeSnapshot): string {
  const semantic = tree.semantic ?? {}
  const label = typeof semantic.ariaLabel === 'string' ? semantic.ariaLabel : tree.props.text
  return typeof label === 'string' ? label.replace(/\s+/g, ' ').trim().toLowerCase() : ''
}

function axNodeRole(tree: TreeSnapshot): string {
  const semantic = tree.semantic ?? {}
  if (typeof semantic.role === 'string') return semantic.role
  return typeof semantic.a11yRoleHint === 'string' ? semantic.a11yRoleHint : ''
}

function layoutsRepresentSameAxNode(a: LayoutSnapshot, b: LayoutSnapshot): boolean {
  return Math.max(
    Math.abs(a.x - b.x),
    Math.abs(a.y - b.y),
    Math.abs(a.width - b.width),
    Math.abs(a.height - b.height),
  ) <= 3
}

function snapshotContainsCachedAxNode(
  tree: TreeSnapshot,
  layout: LayoutSnapshot,
  cached: CachedAxAppendNode,
): boolean {
  if (
    axNodeRole(tree) === axNodeRole(cached.tree) &&
    axNodeLabel(tree) === axNodeLabel(cached.tree) &&
    layoutsRepresentSameAxNode(layout, cached.layout)
  ) return true
  const children = tree.children ?? []
  for (let index = 0; index < children.length; index++) {
    const childLayout = layout.children[index]
    if (childLayout && snapshotContainsCachedAxNode(children[index]!, childLayout, cached)) return true
  }
  return false
}

function cacheAxAppendNodes(
  snapshot: GeometrySnapshot,
  baselineTree: TreeSnapshot,
  state: AxDocumentState,
  geometryFingerprint: string,
  semanticFingerprint: string,
  axRevision: string | undefined,
): void {
  const cached: CachedAxAppendNode[] = []
  const children = snapshot.tree.children ?? []
  for (let index = 0; index < children.length; index++) {
    const tree = children[index]!
    const layout = snapshot.layout.children[index]
    const cacheableAxFallback =
      tree.semantic?.coordinateOnly === true &&
      (tree.semantic?.a11yAppended === true || tree.semantic?.a11yFallback === true)
    if (!layout || !cacheableAxFallback) continue
    cached.push({ tree: cloneTree(tree), layout: cloneLayout(layout) })
  }
  const semanticPatches: CachedAxSemanticPatch[] = []
  const patchKeys = ['ariaLabel', 'a11yRoleHint', 'a11yEnriched'] as const
  const collectSemanticPatches = (
    before: TreeSnapshot,
    after: TreeSnapshot,
    path: number[],
  ): void => {
    const beforeSemantic = before.semantic ?? {}
    const afterSemantic = after.semantic ?? {}
    const semantic: Record<string, unknown> = {}
    for (const key of patchKeys) {
      if (afterSemantic[key] !== beforeSemantic[key] && afterSemantic[key] !== undefined) {
        semantic[key] = structuredClone(afterSemantic[key])
      }
    }
    if (Object.keys(semantic).length > 0) semanticPatches.push({ path: [...path], semantic })

    const beforeChildren = before.children ?? []
    const afterChildren = after.children ?? []
    for (let index = 0; index < beforeChildren.length; index++) {
      const afterChild = afterChildren[index]
      if (afterChild) collectSemanticPatches(beforeChildren[index]!, afterChild, [...path, index])
    }
  }
  collectSemanticPatches(baselineTree, snapshot.tree, [])

  state.cachedAppendNodes = cached
  state.cachedSemanticPatches = semanticPatches
  state.cachedGeometryFingerprint = geometryFingerprint
  state.cachedSemanticFingerprint = semanticFingerprint
  state.cachedAxRevision = axRevision
  state.cacheInvalidated = false
}

function replayCachedAxSemanticPatches(snapshot: GeometrySnapshot, state: AxDocumentState): number {
  let replayed = 0
  for (const patch of state.cachedSemanticPatches) {
    let target: TreeSnapshot | undefined = snapshot.tree
    for (const index of patch.path) {
      target = target.children?.[index]
      if (!target) break
    }
    if (!target) continue
    target.semantic = {
      ...(target.semantic ?? {}),
      ...structuredClone(patch.semantic),
      a11yReplayed: true,
    }
    replayed += 1
  }
  if (replayed > 0) {
    snapshot.tree.semantic = {
      ...(snapshot.tree.semantic ?? {}),
      a11yPatchReplayed: true,
      a11yPatchedCount: replayed,
    }
  }
  return replayed
}

function replayCachedAxAppendNodes(snapshot: GeometrySnapshot, state: AxDocumentState): number {
  let replayed = 0
  let replayedFallback = false
  if (!snapshot.tree.children) snapshot.tree.children = []
  for (const cached of state.cachedAppendNodes) {
    if (snapshotContainsCachedAxNode(snapshot.tree, snapshot.layout, cached)) continue
    const tree = cloneTree(cached.tree)
    tree.semantic = { ...(tree.semantic ?? {}), a11yReplayed: true }
    if (tree.semantic.a11yFallback === true) replayedFallback = true
    snapshot.tree.children.push(tree)
    snapshot.layout.children.push(cloneLayout(cached.layout))
    replayed += 1
  }
  if (replayed > 0) {
    snapshot.tree.semantic = {
      ...(snapshot.tree.semantic ?? {}),
      a11yAppendUsed: true,
      a11yAppendReplayed: true,
      a11yAppendedCount: replayed,
      ...(replayedFallback ? { a11yFallbackUsed: true } : {}),
    }
  }
  return replayed
}

function axCachePayloadSignature(state: AxDocumentState): string {
  return JSON.stringify({
    appendNodes: state.cachedAppendNodes,
    semanticPatches: state.cachedSemanticPatches,
  })
}

async function runAxProbeAndUpdateState(
  page: Page,
  snapshot: GeometrySnapshot,
  state: AxDocumentState | undefined,
  geometryFingerprint: string,
  semanticFingerprint: string,
  axSessionManager: CdpAxSessionManager | undefined,
): Promise<{ succeeded: boolean; cacheReady: boolean; retryAfterMs?: number }> {
  const baselineTree = cloneTree(snapshot.tree)
  const priorCacheSignature = state ? axCachePayloadSignature(state) : undefined
  let axRevisionAtStart: string | undefined
  try {
    await axSessionManager?.get(page)
    axRevisionAtStart = axSessionManager?.revisionToken()
  } catch {
    // The fail-soft enrichment call below owns reset/retry behavior. An
    // unclaimed starting revision can never produce a replayable cache.
  }
  const succeeded = await enrichSnapshotWithCdpAx(page, snapshot, axSessionManager)
  if (!state || axDocumentStateByPage.get(page) !== state) {
    return { succeeded, cacheReady: false }
  }
  state.lastAxProbeAtMs = performance.now()
  state.refreshingWithSafeCache = false
  const axRevisionAtEnd = axSessionManager?.revisionToken()
  const unclaimedRetryAfterMs = state.automaticRetryUsed
    ? undefined
    : AX_HEURISTIC_MIN_INTERVAL_MS
  if (!succeeded) {
    state.probeStatus = 'failed'
    state.cacheInvalidated = true
    clearAxCache(state)
    return {
      succeeded: false,
      cacheReady: false,
      retryAfterMs: unclaimedRetryAfterMs,
    }
  }
  if (
    state.currentGeometryFingerprint !== geometryFingerprint ||
    state.currentSemanticFingerprint !== semanticFingerprint ||
    !axRevisionAtStart ||
    axRevisionAtStart !== axRevisionAtEnd
  ) {
    // A newer extraction observed a different DOM while this CDP request was
    // in flight. The AX response is valid for its source snapshot but unsafe
    // to replay into the current document. Retry only after the normal bound.
    state.probeStatus = 'failed'
    state.cacheInvalidated = true
    clearAxCache(state)
    return {
      succeeded: true,
      cacheReady: false,
      retryAfterMs: unclaimedRetryAfterMs,
    }
  }
  state.probeStatus = 'succeeded'
  state.automaticRetryUsed = false
  cacheAxAppendNodes(
    snapshot,
    baselineTree,
    state,
    geometryFingerprint,
    semanticFingerprint,
    axRevisionAtEnd,
  )
  const nextCacheSignature = axCachePayloadSignature(state)
  return {
    succeeded: true,
    cacheReady: priorCacheSignature !== nextCacheSignature,
  }
}

export interface ExtractGeometryTrace {
  mainFrameMs?: number
  iframeCount?: number
  iframeMergeMs?: number
  axDecisionMs?: number
  axEnrichMs?: number
  axRan?: boolean
  axBackgroundStarted?: boolean
  axFirstDocumentProbe?: boolean
  axCacheReplayedCount?: number
  axCacheReplaySuppressed?: boolean
  axProbeSucceeded?: boolean
  treeJsonMs?: number
  totalMs?: number
}

interface CapturedFrameGeometry {
  layout: LayoutSnapshot
  tree: TreeSnapshot
  childFramesByIdentity: Map<string, Frame>
  documentIdentity?: string
}

interface HostDocumentIdentityState {
  handle: JSHandle<Document>
  identity: string
}

const hostDocumentIdentityByFrame = new WeakMap<Frame, HostDocumentIdentityState>()

/**
 * Track the actual remote Document object in Playwright's host process.
 *
 * A token stored on `document` is not an identity boundary: application code
 * can preseed or copy any page-readable property across navigations. Remote
 * object equality is instead checked with a host-held handle whose opaque
 * identity never enters the page snapshot.
 */
async function currentHostDocumentIdentity(frame: Frame): Promise<string> {
  const candidate = await frame.evaluateHandle(() => document) as JSHandle<Document>
  const previous = hostDocumentIdentityByFrame.get(frame)
  if (previous) {
    try {
      const unchanged = await candidate.evaluate(
        (current, prior) => current === prior,
        previous.handle,
      )
      if (unchanged) {
        await candidate.dispose()
        return previous.identity
      }
    } catch {
      // Handles from a destroyed execution context cannot be compared with
      // the replacement document. That is a document transition, not a reason
      // to reuse the prior cache identity.
    }
    await previous.handle.dispose().catch(() => {})
  }

  const next = { handle: candidate, identity: randomUUID() }
  hostDocumentIdentityByFrame.set(frame, next)
  return next.identity
}

/**
 * Associate each Playwright child frame with its exact owner element without
 * mutating authored DOM attributes. The WeakMap identity lives in the page's
 * main world so the browser-side snapshot can put the same opaque identity on
 * the matching iframe placeholder. Entries disappear with their elements.
 */
async function identifyChildFrames(ownerFrame: Frame): Promise<Map<string, Frame>> {
  const framesByIdentity = new Map<string, Frame>()
  const ambiguousIdentities = new Set<string>()
  for (const childFrame of ownerFrame.childFrames()) {
    if (childFrame.isDetached()) continue
    let handle: Awaited<ReturnType<Frame['frameElement']>> | undefined
    try {
      handle = await childFrame.frameElement()
      const identity = await handle.evaluate((iframe, candidate) => {
        if (!(iframe instanceof HTMLIFrameElement) || !iframe.isConnected) return null
        const key = Symbol.for('geometra.iframeIdentities')
        const globals = globalThis as unknown as Record<symbol, unknown>
        let registry = globals[key]
        if (!(registry instanceof WeakMap)) {
          registry = new WeakMap<Element, string>()
          try {
            Object.defineProperty(globalThis, key, {
              configurable: true,
              value: registry,
            })
          } catch {
            return null
          }
        }
        const identities = registry as WeakMap<Element, unknown>
        const existing = identities.get(iframe)
        if (typeof existing === 'string' && existing) return existing
        identities.set(iframe, candidate)
        return candidate
      }, `iframe-${crypto.randomUUID()}`)
      if (
        identity &&
        !childFrame.isDetached() &&
        childFrame.parentFrame() === ownerFrame
      ) {
        if (framesByIdentity.has(identity)) {
          // A corrupted/page-supplied registry must not be able to alias two
          // owners. Remove both candidates and leave their placeholders empty.
          framesByIdentity.delete(identity)
          ambiguousIdentities.add(identity)
        } else if (!ambiguousIdentities.has(identity)) {
          framesByIdentity.set(identity, childFrame)
        }
      }
    } catch {
      // Detached or cross-navigation frame owners fail closed. In particular,
      // never shift the next child frame into this placeholder's slot.
    } finally {
      await handle?.dispose().catch(() => {})
    }
  }
  return framesByIdentity
}

async function captureFrameGeometry(
  frame: Frame,
  trackDocumentIdentity = false,
): Promise<CapturedFrameGeometry> {
  const documentIdentityBefore = trackDocumentIdentity
    ? await currentHostDocumentIdentity(frame)
    : undefined
  const childFramesByIdentity = await identifyChildFrames(frame)
  const raw = await frame.evaluate(browserExtractGeometry)
  const tree = raw.tree as TreeSnapshot
  const documentIdentityAfter = trackDocumentIdentity
    ? await currentHostDocumentIdentity(frame)
    : undefined
  if (documentIdentityBefore !== documentIdentityAfter) {
    throw new Error('Document changed during navigation geometry extraction')
  }
  return {
    layout: raw.layout as LayoutSnapshot,
    tree,
    childFramesByIdentity,
    documentIdentity: documentIdentityAfter,
  }
}

async function mergeIframesForOwner(
  tree: TreeSnapshot,
  layout: LayoutSnapshot,
  ownerFrame: Frame,
  framesByIdentity: Map<string, Frame>,
): Promise<void> {
  const ownerOrigin = await frameOriginInRootPage(ownerFrame)

  async function visit(t: TreeSnapshot, l: LayoutSnapshot): Promise<void> {
    if (t.semantic?.tag === 'iframe') {
      const identity = typeof t.semantic.iframeIdentity === 'string'
        ? t.semantic.iframeIdentity
        : undefined
      // Internal correlation tokens must never leak into the public snapshot,
      // including for detached or otherwise unmatched owners.
      if ('iframeIdentity' in t.semantic) delete t.semantic.iframeIdentity
      t.children = []
      l.children = []
      if (!identity) return

      const childFrame = framesByIdentity.get(identity)
      if (!childFrame || childFrame.isDetached()) return
      try {
        const child = await captureFrameGeometry(childFrame)
        await mergeIframesForOwner(
          child.tree,
          child.layout,
          childFrame,
          child.childFramesByIdentity,
        )
        const childOrigin = await frameOriginInRootPage(childFrame)
        const deltaX = childOrigin.x - ownerOrigin.x
        const deltaY = childOrigin.y - ownerOrigin.y
        l.children = child.layout.children.map(childLayout => {
          const copy = cloneLayout(childLayout)
          offsetLayoutSubtree(copy, deltaX, deltaY)
          return copy
        })
        t.children = (child.tree.children ?? []).map(cloneTree)
        t.semantic = { ...t.semantic, frameUrl: childFrame.url() }
      } catch {
        // A navigation/detach between identity capture and frame extraction is
        // an unmatched placeholder, not permission to borrow another frame.
      }
      return
    }

    const children = t.children ?? []
    for (let index = 0; index < children.length; index++) {
      const childLayout = l.children[index]
      if (childLayout) await visit(children[index]!, childLayout)
    }
  }

  await visit(tree, layout)
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
  await mergeIframesForOwner(tree, layout, ownerFrame, await identifyChildFrames(ownerFrame))
}

export interface ExtractGeometryOptions {
  axSessionManager?: CdpAxSessionManager
  trace?: ExtractGeometryTrace
  /** Called once when a background AX probe materially added, changed, or removed cached AX data. */
  onAxReady?: () => void
  /** Requests one bounded host refresh after a failed, invalidated, or expiring AX probe. */
  onAxRetryDue?: (delayMs: number) => void
}

/**
 * Full page: main frame + every nested iframe (any origin) + optional CDP AX name enrichment.
 */
export async function extractGeometry(page: Page, options?: ExtractGeometryOptions): Promise<GeometrySnapshot> {
  const trace = options?.trace
  const totalStartedAt = performance.now()

  const mainFrameStartedAt = performance.now()
  const mainFrame = await captureFrameGeometry(page.mainFrame(), true)
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
  await mergeIframesForOwner(
    main.tree,
    main.layout,
    page.mainFrame(),
    mainFrame.childFramesByIdentity,
  )
  if (trace) {
    trace.iframeMergeMs = performance.now() - iframeMergeStartedAt
  }

  const axDecisionStartedAt = performance.now()
  const axSessionManager = axSessionManagerForPage(page, options?.axSessionManager)
  const axPlan = planAxProbe(
    page,
    mainFrame.documentIdentity,
    main,
    axSessionManager.revisionToken(),
  )
  const shouldRunAxEnrichment = axPlan.shouldRun
  const runAxInBackground = shouldRunAxEnrichment
  const requestAxRetry = (delayMs: number | undefined): boolean => {
    if (!delayMs || !Number.isFinite(delayMs) || delayMs <= 0 || !options?.onAxRetryDue) {
      return false
    }
    try {
      options.onAxRetryDue(delayMs)
      return true
    } catch {
      // Retry scheduling is advisory and must never poison extraction.
      return false
    }
  }
  if (trace) {
    trace.axDecisionMs = performance.now() - axDecisionStartedAt
    trace.axRan = shouldRunAxEnrichment && !runAxInBackground
    trace.axBackgroundStarted = runAxInBackground
    trace.axFirstDocumentProbe = axPlan.firstDocumentProbe
    if (axPlan.cacheReplaySuppressed) trace.axCacheReplaySuppressed = true
  }
  if (requestAxRetry(axPlan.retryAfterMs) && axPlan.state) {
    axPlan.state.automaticRetryUsed = true
  }

  if (runAxInBackground) {
    const backgroundSnapshot: GeometrySnapshot = {
      tree: cloneTree(main.tree),
      layout: cloneLayout(main.layout),
      treeJson: '',
    }
    const axEnrichStartedAt = performance.now()
    void runAxProbeAndUpdateState(
      page,
      backgroundSnapshot,
      axPlan.state,
      axPlan.geometryFingerprint,
      axPlan.semanticFingerprint,
      axSessionManager,
    ).then(result => {
      if (trace) {
        trace.axProbeSucceeded = result.succeeded
        trace.axEnrichMs = performance.now() - axEnrichStartedAt
      }
      if (result.cacheReady) {
        try {
          options?.onAxReady?.()
        } catch {
          // Readiness is advisory; scheduler errors must not poison AX state.
        }
      }
      if (
        requestAxRetry(result.retryAfterMs) &&
        axPlan.state &&
        axDocumentStateByPage.get(page) === axPlan.state
      ) {
        axPlan.state.automaticRetryUsed = true
      }
    }).catch(() => {
      // enrichSnapshotWithCdpAx is fail-soft, but keep the detached background
      // task from ever becoming an unhandled rejection if that contract changes.
      if (axPlan.state && axDocumentStateByPage.get(page) === axPlan.state) {
        axPlan.state.probeStatus = 'failed'
        axPlan.state.lastAxProbeAtMs = performance.now()
        axPlan.state.refreshingWithSafeCache = false
        axPlan.state.cacheInvalidated = true
        clearAxCache(axPlan.state)
      }
      if (trace) trace.axProbeSucceeded = false
      if (requestAxRetry(AX_HEURISTIC_MIN_INTERVAL_MS) && axPlan.state) {
        axPlan.state.automaticRetryUsed = true
      }
    })
  }

  if (axPlan.state && axPlan.mayReplayCache) {
    const replayed =
      replayCachedAxSemanticPatches(main, axPlan.state) +
      replayCachedAxAppendNodes(main, axPlan.state)
    if (trace) trace.axCacheReplayedCount = replayed
  } else if (trace && (
    axPlan.cacheReplaySuppressed ||
    axPlan.state?.cachedAppendNodes.length ||
    axPlan.state?.cachedSemanticPatches.length
  )) {
    trace.axCacheReplaySuppressed = true
  }

  const treeJsonStartedAt = performance.now()
  main.treeJson = JSON.stringify(main.tree)
  if (trace) {
    trace.treeJsonMs = performance.now() - treeJsonStartedAt
    trace.totalMs = performance.now() - totalStartedAt
  }
  return main
}
