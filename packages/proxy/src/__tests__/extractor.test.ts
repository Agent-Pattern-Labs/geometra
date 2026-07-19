import { performance as nodePerformance } from 'node:perf_hooks'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { chromium, type Browser } from 'playwright'
import { createCdpAxSessionManager, type CdpAxSessionManager } from '../a11y-enrich.ts'
import {
  extractFrameGeometry,
  extractGeometry,
  mergeAllIframes,
  type ExtractGeometryTrace,
} from '../extractor.ts'
import type { LayoutSnapshot, TreeSnapshot } from '../types.js'

interface SnapshotNode {
  tree: TreeSnapshot
  layout: LayoutSnapshot
}

function flattenSnapshot(tree: TreeSnapshot, layout: LayoutSnapshot): SnapshotNode[] {
  const out: SnapshotNode[] = [{ tree, layout }]
  const treeChildren = tree.children ?? []
  for (let i = 0; i < treeChildren.length; i++) {
    out.push(...flattenSnapshot(treeChildren[i]!, layout.children[i]!))
  }
  return out
}

function findTreePath(
  tree: TreeSnapshot,
  predicate: (node: TreeSnapshot) => boolean,
  path: TreeSnapshot[] = [],
): TreeSnapshot[] | undefined {
  const nextPath = [...path, tree]
  if (predicate(tree)) return nextPath
  for (const child of tree.children ?? []) {
    const found = findTreePath(child, predicate, nextPath)
    if (found) return found
  }
  return undefined
}

describe('extractGeometry', () => {
  let browser: Browser

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true })
  })

  afterAll(async () => {
    await browser.close()
  })

  it('keeps opacity-zero checkbox inputs when they are still interactive', async () => {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } })
    await page.setContent(`
      <style>
        body { margin: 0; font-family: sans-serif; }
        .option { display: flex; align-items: center; gap: 8px; margin: 24px; }
        .ghost-checkbox { width: 24px; height: 24px; opacity: 0; margin: 0; }
      </style>
      <fieldset>
        <div class="option">
          <input id="office-ny" class="ghost-checkbox" type="checkbox" checked />
          <label for="office-ny">New York, NY</label>
        </div>
      </fieldset>
    `)

    const snapshot = await extractGeometry(page)
    const nodes = flattenSnapshot(snapshot.tree, snapshot.layout)
    const checkbox = nodes.find(node =>
      node.tree.semantic?.role === 'checkbox' &&
      node.tree.semantic?.ariaLabel === 'New York, NY',
    )

    expect(checkbox).toBeDefined()
    expect(checkbox?.tree.semantic?.ariaChecked).toBe(true)
    expect(checkbox?.layout.width).toBeGreaterThan(0)
    expect(checkbox?.layout.height).toBeGreaterThan(0)

    await page.close()
  })

  it('preserves semantics for text-only buttons instead of downgrading them to plain text', async () => {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } })
    await page.setContent(`
      <style>
        body { margin: 24px; font-family: sans-serif; }
        .chips { display: flex; gap: 12px; }
      </style>
      <div class="chips">
        <button>Yes</button>
        <button>No</button>
      </div>
    `)

    const snapshot = await extractGeometry(page)
    const nodes = flattenSnapshot(snapshot.tree, snapshot.layout)
    const yesButton = nodes.find(node =>
      node.tree.kind === 'text' &&
      node.tree.semantic?.role === 'button' &&
      node.tree.props.text === 'Yes',
    )
    const noButton = nodes.find(node =>
      node.tree.kind === 'text' &&
      node.tree.semantic?.role === 'button' &&
      node.tree.props.text === 'No',
    )

    expect(yesButton).toBeDefined()
    expect(yesButton?.tree.handlers?.onClick).toBe(true)
    expect(noButton).toBeDefined()
    expect(noButton?.tree.handlers?.onClick).toBe(true)

    await page.close()
  })

  it('prefers explicit field labels over placeholder text for form controls', async () => {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } })
    await page.setContent(`
      <label for="location-input">Location</label>
      <input id="location-input" placeholder="Start typing..." />
    `)

    const snapshot = await extractGeometry(page)
    const nodes = flattenSnapshot(snapshot.tree, snapshot.layout)
    const input = nodes.find(node =>
      node.tree.semantic?.role === 'textbox' &&
      node.tree.semantic?.ariaLabel === 'Location',
    )

    expect(input).toBeDefined()
    expect(input?.tree.semantic?.ariaLabel).toBe('Location')

    await page.close()
  })

  it('reports native invalid state without dispatching invalid events', async () => {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } })
    await page.setContent(`
      <form>
        <label for="email-input">Email</label>
        <input
          id="email-input"
          type="email"
          required
          value="not-an-email"
          aria-describedby="email-error"
        />
        <p id="email-error">Enter a valid email address.</p>
      </form>
      <script>
        window.invalidEventCount = 0
        document.getElementById('email-input').addEventListener('invalid', () => {
          window.invalidEventCount += 1
        })
      </script>
    `)

    const snapshot = await extractGeometry(page)
    const nodes = flattenSnapshot(snapshot.tree, snapshot.layout)
    const input = nodes.find(node =>
      node.tree.semantic?.role === 'textbox' &&
      node.tree.semantic?.ariaLabel === 'Email',
    )

    expect(input).toBeDefined()
    expect(input?.tree.semantic?.ariaInvalid).toBe(true)
    expect(input?.tree.semantic?.validationError).toBe('Enter a valid email address.')
    expect(await page.evaluate(() => (window as unknown as { invalidEventCount: number }).invalidEventCount)).toBe(0)

    await page.close()
  })

  it('uses button-like input values as accessible button labels', async () => {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } })
    await page.setContent(`
      <form>
        <input type="submit" value="Login" />
      </form>
    `)

    const snapshot = await extractGeometry(page)
    const nodes = flattenSnapshot(snapshot.tree, snapshot.layout)
    const button = nodes.find(node =>
      node.tree.semantic?.role === 'button' &&
      node.tree.semantic?.ariaLabel === 'Login',
    )

    expect(button).toBeDefined()
    expect(button?.tree.handlers?.onClick).toBe(true)

    await page.close()
  })

  it('uses descendant image alt text for image-only links', async () => {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } })
    await page.setContent(`
      <a href="#item">
        <img
          alt="Sauce Labs Backpack"
          width="120"
          height="120"
          src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=="
        />
      </a>
    `)

    const snapshot = await extractGeometry(page)
    const nodes = flattenSnapshot(snapshot.tree, snapshot.layout)
    const link = nodes.find(node =>
      node.tree.semantic?.role === 'link' &&
      node.tree.semantic?.ariaLabel === 'Sauce Labs Backpack',
    )

    expect(link).toBeDefined()

    await page.close()
  })

  it('reads picked value from a sibling for react-select-style custom comboboxes', async () => {
    // Reproduces the exact DOM react-select v5 emits for a single-select
    // with a committed value: an <input role="combobox"> trigger whose own
    // .value is empty (no search query), with the picked option living in
    // a *sibling* <div class="select__single-value">. Without the
    // findCustomComboboxValueText fallback, geometra_query returns this
    // node with no value field — which is exactly the gap the
    // benchmark-mcp-greenhouse run surfaced. This test locks the fallback
    // in so it can't silently regress.
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } })
    await page.setContent(`
      <style>
        .select__control { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border: 1px solid #ccc; min-width: 280px; }
        .select__value-container { display: flex; flex: 1; align-items: center; gap: 4px; }
        .select__single-value { color: #1a1f2e; font-size: 14px; }
        .select__input-container { display: flex; flex: 1; }
        .select__input-container input { border: 0; outline: 0; flex: 1; min-width: 60px; font-size: 14px; }
        .select__indicators { display: flex; }
      </style>
      <label for="work-auth">Are you legally authorized to work here?</label>
      <div class="select__control">
        <div class="select__value-container">
          <div class="select__single-value">Yes</div>
          <div class="select__input-container">
            <input
              id="work-auth"
              role="combobox"
              aria-haspopup="listbox"
              aria-expanded="false"
              aria-autocomplete="list"
              aria-controls="work-auth-listbox"
              value=""
            />
          </div>
        </div>
        <div class="select__indicators" aria-hidden="true">
          <span>▾</span>
        </div>
      </div>
    `)

    const snapshot = await extractGeometry(page)
    const nodes = flattenSnapshot(snapshot.tree, snapshot.layout)
    const combobox = nodes.find(node => node.tree.semantic?.role === 'combobox')

    expect(combobox).toBeDefined()
    expect(combobox?.tree.semantic?.valueText).toBe('Yes')

    await page.close()
  })

  it('strips aria-hidden indicator glyphs from Radix-style button-trigger combobox values', async () => {
    // Regression: real @radix-ui/react-select renders the trigger as
    //   <button role="combobox">
    //     <span style="pointer-events:none">Yes</span>      ← picked value
    //     <span aria-hidden="true">▾</span>                  ← decorative
    //   </button>
    // The value-bearing span has NO data-radix-select-value attribute and
    // NO class containing "SelectValue", so findCustomComboboxValueText
    // never matches it. Before the visibleTextSkippingAriaHidden fallback,
    // controlValueText fell through to the trigger's innerText and
    // returned "Yes ▾", which fails any post-fill ground-truth check.
    // benchmark-mcp-radix:assert surfaced this against real Radix DOM —
    // this test pins the fix against the same DOM shape so a future regression
    // is caught by the fast suite without needing the benchmark.
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } })
    await page.setContent(`
      <label for="work-auth">Work auth</label>
      <button id="work-auth" role="combobox" aria-expanded="false">
        <span style="pointer-events:none">Yes</span>
        <span aria-hidden="true">▾</span>
      </button>
    `)

    const snapshot = await extractGeometry(page)
    const nodes = flattenSnapshot(snapshot.tree, snapshot.layout)
    const combobox = nodes.find(node => node.tree.semantic?.role === 'combobox')

    expect(combobox).toBeDefined()
    expect(combobox?.tree.semantic?.valueText).toBe('Yes')

    await page.close()
  })

  it('falls back to a Radix-style SelectValue sibling for picked combobox values', async () => {
    // Same gap, different combobox library. Radix Select renders
    // <SelectValue> as a span with a class containing "SelectValue".
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } })
    await page.setContent(`
      <label for="country">Country</label>
      <button id="country" role="combobox" aria-expanded="false" aria-haspopup="listbox">
        <span class="SelectValue">Germany</span>
        <span aria-hidden="true">▾</span>
      </button>
    `)

    const snapshot = await extractGeometry(page)
    const nodes = flattenSnapshot(snapshot.tree, snapshot.layout)
    const combobox = nodes.find(node => node.tree.semantic?.role === 'combobox')

    expect(combobox).toBeDefined()
    expect(combobox?.tree.semantic?.valueText).toBe('Germany')

    await page.close()
  })

  it('does not surface placeholder text as a combobox value', async () => {
    // The fallback must not return text from a placeholder element — that
    // would be silently misleading. This locks in the className filter.
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } })
    await page.setContent(`
      <label for="empty">Country</label>
      <div class="select__control">
        <div class="select__value-container">
          <div class="select__placeholder">Select...</div>
          <div class="select__input-container">
            <input id="empty" role="combobox" aria-expanded="false" value="" />
          </div>
        </div>
      </div>
    `)

    const snapshot = await extractGeometry(page)
    const nodes = flattenSnapshot(snapshot.tree, snapshot.layout)
    const combobox = nodes.find(node => node.tree.semantic?.role === 'combobox')

    expect(combobox).toBeDefined()
    expect(combobox?.tree.semantic?.valueText).toBeUndefined()

    await page.close()
  })

  it('strips nested option text from wrapped select labels', async () => {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } })
    await page.setContent(`
      <label>
        Preferred location
        <select>
          <option>Choose a location</option>
          <option>Berlin, Germany</option>
          <option>Austin, Texas</option>
        </select>
      </label>
    `)

    const snapshot = await extractGeometry(page)
    const nodes = flattenSnapshot(snapshot.tree, snapshot.layout)
    const select = nodes.find(node =>
      node.tree.semantic?.role === 'combobox' &&
      node.tree.semantic?.ariaLabel === 'Preferred location',
    )

    expect(select).toBeDefined()
    expect(select?.tree.semantic?.ariaLabel).toBe('Preferred location')

    await page.close()
  })

  it('preserves authored control identity and every native option without deduplicating labels or values', async () => {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } })
    await page.setContent(`
      <form>
        <label for="primary-country">Country</label>
        <select id="primary-country" name="applicant[country]">
          <option value="">Choose a country</option>
          <option value="de" selected>Germany</option>
          <option value="de">Germany</option>
          <option value="de-alt">Germany</option>
          <option value="eng" disabled>Engineering</option>
          <optgroup label="Unavailable" disabled>
            <option value="legacy">Legacy region</option>
          </optgroup>
        </select>

        <label>
          Country
          <select name="secondary_country">
            <option value="us" selected>United States</option>
          </select>
        </label>

        <label>
          Contact email
          <input name="contact_email" type="EMAIL" />
        </label>
      </form>
    `)

    const snapshot = await extractGeometry(page)
    const nodes = flattenSnapshot(snapshot.tree, snapshot.layout)
    const countries = nodes.filter(
      node => node.tree.semantic?.role === 'combobox' && node.tree.semantic?.ariaLabel === 'Country',
    )

    expect(countries).toHaveLength(2)

    const primary = countries.find(node => node.tree.semantic?.controlId === 'primary-country')
    expect(primary?.tree.semantic).toMatchObject({
      tag: 'select',
      controlId: 'primary-country',
      controlName: 'applicant[country]',
      controlKey: 'id:primary-country',
    })
    expect(primary?.tree.semantic?.options).toEqual([
      { value: '', label: 'Choose a country', disabled: false, selected: false, index: 0 },
      { value: 'de', label: 'Germany', disabled: false, selected: true, index: 1 },
      { value: 'de', label: 'Germany', disabled: false, selected: false, index: 2 },
      { value: 'de-alt', label: 'Germany', disabled: false, selected: false, index: 3 },
      { value: 'eng', label: 'Engineering', disabled: true, selected: false, index: 4 },
      { value: 'legacy', label: 'Legacy region', disabled: true, selected: false, index: 5 },
    ])

    const secondary = countries.find(node => node.tree.semantic?.controlName === 'secondary_country')
    expect(secondary?.tree.semantic).toMatchObject({
      tag: 'select',
      controlName: 'secondary_country',
      controlKey: 'name:select:default:secondary_country',
    })
    expect(secondary?.tree.semantic?.controlId).toBeUndefined()

    const email = nodes.find(
      node => node.tree.semantic?.role === 'textbox' && node.tree.semantic?.controlName === 'contact_email',
    )
    expect(email?.tree.semantic?.controlKey).toBe('name:input:email:contact_email')

    await page.close()
  })

  it('expands tiny text-control bounds to the visible control wrapper', async () => {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
    await page.setContent(`
      <style>
        body { margin: 24px; font-family: sans-serif; }
        label { display: block; margin-bottom: 8px; }
        .combo-shell {
          width: 320px;
          min-height: 44px;
          padding: 10px 12px;
          border: 1px solid #ccc;
          border-radius: 8px;
          display: flex;
          align-items: center;
        }
        .combo-shell input {
          width: 6px;
          height: 6px;
          border: 0;
          padding: 0;
          margin: 0;
          outline: none;
        }
      </style>
      <label for="country-input">Country</label>
      <div class="combo-shell">
        <input id="country-input" placeholder="Start typing..." />
      </div>
    `)

    const snapshot = await extractGeometry(page)
    const nodes = flattenSnapshot(snapshot.tree, snapshot.layout)
    const input = nodes.find(node =>
      node.tree.semantic?.role === 'textbox' &&
      node.tree.semantic?.ariaLabel === 'Country',
    )

    expect(input).toBeDefined()
    expect(input?.layout.width).toBeGreaterThan(280)
    expect(input?.layout.height).toBeGreaterThan(30)

    await page.close()
  })

  // Visibility-vector contract — see shouldSkip / shouldKeepDespiteOpacity
  // in extractor.ts. The opacity:0 + zero-rect exemptions for form-control
  // inputs were added because react-select v5 silently dropped its trigger
  // from the snapshot. Other libraries hide their trigger inputs the same
  // way using vectors that shouldSkip currently has NO gate for at all
  // (clip-path:inset(100%), transform:scale(0), aria-hidden ancestor).
  // Today they survive by accident — they survive because shouldSkip
  // never inspects them. The point of these tests is to lock that in:
  // any future commit that adds a new shouldSkip gate must also add the
  // role-and-form-control exemption, otherwise these tests fail and the
  // engineer is forced to make the same exemption decision the
  // opacity/zero-rect paths already made. Without these tests a new gate
  // would silently regress combobox readback in any library that hides
  // its trigger this way.
  const HIDE_VECTORS: Array<{ name: string; trigger: string }> = [
    {
      name: 'clip-path: inset(100%)',
      // NOTE: deliberately NO position:absolute. The wrapping
      // .select__input-container is a plain div with no role and no
      // form-control element type, so the zero-rect gate has no exemption
      // for it. position:absolute would remove this input from flex layout
      // and collapse the wrapper to 0x0, which would skip both the wrapper
      // AND the input as a side effect — that's a separate "wrapping div
      // collapse" issue, not the contract this test is supposed to pin.
      // Real react-select / Radix never use position:absolute on the
      // trigger input either; they rely on opacity / aria-hidden.
      trigger: 'clip-path: inset(100%);',
    },
    {
      name: 'transform: scale(0)',
      trigger: 'transform: scale(0);',
    },
    {
      name: 'aria-hidden ancestor wrapper',
      trigger: '', // aria-hidden is set on a wrapper below, not via style
    },
  ]

  for (const vector of HIDE_VECTORS) {
    it(`keeps form-control combobox triggers under hide vector: ${vector.name}`, async () => {
      const page = await browser.newPage({ viewport: { width: 800, height: 600 } })
      const wrapperOpenTag = vector.name.startsWith('aria-hidden')
        ? '<div aria-hidden="true">'
        : '<div>'
      await page.setContent(`
        <style>
          .select__control { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border: 1px solid #ccc; min-width: 280px; }
          .select__value-container { display: flex; flex: 1; align-items: center; gap: 4px; }
          .select__single-value { color: #1a1f2e; font-size: 14px; }
          .select__input-container { display: flex; flex: 1; }
          .select__input-container input { border: 0; outline: 0; flex: 1; min-width: 60px; ${vector.trigger} }
        </style>
        <label for="hidden-trigger">Country</label>
        ${wrapperOpenTag}
          <div class="select__control">
            <div class="select__value-container">
              <div class="select__single-value">Germany</div>
              <div class="select__input-container">
                <input
                  id="hidden-trigger"
                  role="combobox"
                  aria-haspopup="listbox"
                  aria-expanded="false"
                  aria-autocomplete="list"
                  value=""
                />
              </div>
            </div>
          </div>
        </div>
      `)

      const snapshot = await extractGeometry(page)
      const nodes = flattenSnapshot(snapshot.tree, snapshot.layout)
      const combobox = nodes.find(node => node.tree.semantic?.role === 'combobox')

      // Contract: the combobox trigger MUST survive into the snapshot, and
      // its sibling-readback value MUST be available. If a future commit
      // adds a hide gate without exempting form-controls, this assertion
      // fails before the regression ever reaches a real ATS site.
      expect(combobox, `combobox dropped under hide vector: ${vector.name}`).toBeDefined()
      expect(combobox?.tree.semantic?.valueText).toBe('Germany')

      await page.close()
    })
  }

  it('falls back to accessibility-tree nodes when DOM extraction is effectively empty', async () => {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
    const axSessionManager = createCdpAxSessionManager()
    const cdpSession = await axSessionManager.get(page)
    const sendSpy = vi.spyOn(cdpSession, 'send')
    const fullAxRequestCount = () => sendSpy.mock.calls
      .filter(([method]) => method === 'Accessibility.getFullAXTree').length
    await page.setContent(`
      <style>
        #host { position: relative; width: 0; height: 0; }
      </style>
      <div id="host"></div>
      <script>
        const host = document.getElementById('host')
        const root = host.attachShadow({ mode: 'closed' })
        root.innerHTML = '<style>button { position: absolute; left: 48px; top: 40px; width: 160px; height: 44px; }</style><button aria-label="Apply now">Apply now</button>'
      </script>
    `)

    const firstTrace: ExtractGeometryTrace = {}
    const onAxReady = vi.fn()
    const firstStartedAt = Date.now()
    const snapshot = await extractGeometry(page, { axSessionManager, trace: firstTrace, onAxReady })
    expect(Date.now() - firstStartedAt).toBeLessThan(1_000)
    const nodes = flattenSnapshot(snapshot.tree, snapshot.layout)
    const button = nodes.find(node =>
      node.tree.semantic?.role === 'button' &&
      node.tree.semantic?.ariaLabel === 'Apply now',
    )

    expect(firstTrace).toMatchObject({
      axRan: false,
      axBackgroundStarted: true,
      axFirstDocumentProbe: true,
    })
    expect(snapshot.tree.semantic?.a11yFallbackUsed).toBeUndefined()
    expect(button).toBeUndefined()
    await vi.waitFor(() => expect(onAxReady).toHaveBeenCalledTimes(1), { timeout: 5_000 })
    expect(fullAxRequestCount()).toBe(1)

    const repeatedTrace: ExtractGeometryTrace = {}
    const repeated = await extractGeometry(page, { axSessionManager, trace: repeatedTrace })
    const repeatedButton = flattenSnapshot(repeated.tree, repeated.layout).find(node =>
      node.tree.semantic?.role === 'button' && node.tree.semantic?.ariaLabel === 'Apply now',
    )
    expect(repeatedTrace).toMatchObject({ axRan: false, axCacheReplayedCount: 1 })
    expect(repeated.tree.semantic?.a11yFallbackUsed).toBe(true)
    expect(repeatedButton?.tree.handlers?.onClick).toBe(true)
    expect(repeatedButton?.tree.semantic).toMatchObject({
      a11yFallback: true,
      a11yReplayed: true,
      coordinateOnly: true,
    })
    expect(fullAxRequestCount()).toBe(1)

    await axSessionManager.close()
    await page.close()
  })

  it('replays background AX semantic patches for an existing unnamed control', async () => {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
    const axSessionManager = createCdpAxSessionManager()
    await page.setContent(`
      <style>
        #generated-name::before { content: 'Save draft'; }
        #generated-name { width: 140px; height: 42px; }
      </style>
      <button>Healthy A</button>
      <button>Healthy B</button>
      <button id="generated-name"></button>
    `)

    const firstTrace: ExtractGeometryTrace = {}
    const onAxReady = vi.fn()
    const first = await extractGeometry(page, {
      axSessionManager,
      trace: firstTrace,
      onAxReady,
    })
    const firstControl = flattenSnapshot(first.tree, first.layout)
      .find(node => node.tree.semantic?.controlId === 'generated-name')
    expect(firstTrace).toMatchObject({ axRan: false, axBackgroundStarted: true })
    expect(firstControl?.tree.semantic?.ariaLabel).toBeUndefined()
    await vi.waitFor(() => expect(onAxReady).toHaveBeenCalledTimes(1), { timeout: 5_000 })

    const replayTrace: ExtractGeometryTrace = {}
    const replay = await extractGeometry(page, { axSessionManager, trace: replayTrace })
    const replayedControl = flattenSnapshot(replay.tree, replay.layout)
      .find(node => node.tree.semantic?.controlId === 'generated-name')
    expect(replayTrace.axRan).toBe(false)
    expect(replayTrace.axCacheReplayedCount).toBeGreaterThan(0)
    expect(replayedControl?.tree.semantic).toMatchObject({
      ariaLabel: 'Save draft',
      a11yEnriched: true,
      a11yReplayed: true,
    })
    expect(replay.tree.semantic).toMatchObject({
      a11yPatchReplayed: true,
    })
    expect(Number(replay.tree.semantic?.a11yPatchedCount)).toBeGreaterThan(0)

    await axSessionManager.close()
    await page.close()
  })

  it('does not borrow a containing region label for an unnamed button or append a duplicate', async () => {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
    const axSessionManager = createCdpAxSessionManager()
    await page.setContent(`
      <button>Healthy action</button>
      <section role="region" aria-label="Danger zone" style="width:320px;height:180px;padding:20px">
        <button id="empty-action" style="width:120px;height:40px"></button>
      </section>
      <div id="menu-action" role="menuitem" tabindex="0" aria-label="Authored menu action"
        style="width:150px;height:38px"></div>
    `)

    const firstTrace: ExtractGeometryTrace = {}
    const onAxReady = vi.fn()
    await extractGeometry(page, { axSessionManager, trace: firstTrace, onAxReady })
    await vi.waitFor(() => expect(firstTrace.axProbeSucceeded).toBe(true), { timeout: 5_000 })
    expect(onAxReady).not.toHaveBeenCalled()

    const replay = await extractGeometry(page, { axSessionManager })
    const nodes = flattenSnapshot(replay.tree, replay.layout)
    const emptyButton = nodes.find(node => node.tree.semantic?.controlId === 'empty-action')
    expect(emptyButton?.tree.semantic?.ariaLabel).toBeUndefined()
    expect(emptyButton?.tree.semantic?.a11yRoleHint).toBeUndefined()
    const coincidentButtons = nodes.filter(node =>
      node.tree.semantic?.role === 'button' &&
      node.layout.x === emptyButton?.layout.x &&
      node.layout.y === emptyButton?.layout.y &&
      node.layout.width === emptyButton?.layout.width &&
      node.layout.height === emptyButton?.layout.height,
    )
    expect(coincidentButtons).toHaveLength(1)
    const menuAction = nodes.find(node =>
      node.tree.semantic?.role === 'menuitem' &&
      node.tree.semantic?.ariaLabel === 'Authored menu action',
    )
    expect(menuAction?.tree.semantic).toMatchObject({
      role: 'menuitem',
      ariaLabel: 'Authored menu action',
    })
    expect(nodes.some(node =>
      node !== menuAction &&
      node.tree.semantic?.coordinateOnly === true &&
      node.layout.x === menuAction?.layout.x &&
      node.layout.y === menuAction?.layout.y &&
      node.layout.width === menuAction?.layout.width &&
      node.layout.height === menuAction?.layout.height,
    )).toBe(false)

    await axSessionManager.close()
    await page.close()
  })

  it('retries a failed first-document AX probe only after the bounded cadence', async () => {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
    await page.setContent('<button>Healthy A</button><button>Healthy B</button>')
    const baseManager = createCdpAxSessionManager()
    let failProbe = true
    const flakyManager: CdpAxSessionManager = {
      get: async targetPage => {
        if (failProbe) throw new Error('transient AX setup failure')
        return await baseManager.get(targetPage)
      },
      revisionToken: () => baseManager.revisionToken(),
      reset: async () => await baseManager.reset(),
      close: async () => await baseManager.close(),
    }
    let fakeNow = 20_000
    const nowSpy = vi.spyOn(nodePerformance, 'now').mockImplementation(() => fakeNow)
    const onAxRetryDue = vi.fn()

    const failedTrace: ExtractGeometryTrace = {}
    await extractGeometry(page, {
      axSessionManager: flakyManager,
      trace: failedTrace,
      onAxRetryDue,
    })
    expect(failedTrace).toMatchObject({
      axRan: false,
      axBackgroundStarted: true,
      axFirstDocumentProbe: true,
    })
    await vi.waitFor(() => expect(failedTrace.axProbeSucceeded).toBe(false))
    expect(onAxRetryDue).toHaveBeenCalledWith(10_000)

    const throttledTrace: ExtractGeometryTrace = {}
    await extractGeometry(page, {
      axSessionManager: flakyManager,
      trace: throttledTrace,
      onAxRetryDue,
    })
    expect(throttledTrace).toMatchObject({
      axRan: false,
      axBackgroundStarted: false,
      axFirstDocumentProbe: false,
    })
    expect(onAxRetryDue).toHaveBeenCalledTimes(1)

    failProbe = false
    fakeNow += 10_000
    const retryTrace: ExtractGeometryTrace = {}
    await extractGeometry(page, { axSessionManager: flakyManager, trace: retryTrace })
    expect(retryTrace).toMatchObject({
      axRan: false,
      axBackgroundStarted: true,
      axFirstDocumentProbe: false,
    })
    await vi.waitFor(() => expect(retryTrace.axProbeSucceeded).toBe(true))

    // A successful probe that found no append/patch results is still a cache
    // revision. It must refresh at the same bounded cadence so a later
    // accessibility-only control cannot remain undiscovered indefinitely.
    fakeNow += 10_000
    const emptyCacheRefreshTrace: ExtractGeometryTrace = {}
    await extractGeometry(page, { axSessionManager: flakyManager, trace: emptyCacheRefreshTrace })
    expect(emptyCacheRefreshTrace).toMatchObject({
      axRan: false,
      axBackgroundStarted: true,
    })
    expect(emptyCacheRefreshTrace.axCacheReplaySuppressed).toBeUndefined()
    await vi.waitFor(() => expect(emptyCacheRefreshTrace.axProbeSucceeded).toBe(true))

    nowSpy.mockRestore()
    await flakyManager.close()
    await page.close()
  })

  it('appends missing closed-root AX controls to a healthy DOM snapshot without duplicating or advertising form fields', async () => {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
    const axSessionManager = createCdpAxSessionManager()
    const cdpSession = await axSessionManager.get(page)
    const sendSpy = vi.spyOn(cdpSession, 'send')
    let fakeNow = 1_000
    const nowSpy = vi.spyOn(nodePerformance, 'now').mockImplementation(() => fakeNow)
    const fullAxRequestCount = () => sendSpy.mock.calls
      .filter(([method]) => method === 'Accessibility.getFullAXTree').length
    await page.setContent(`
      <button aria-label="Light action">Light action</button>
      <a href="#next" aria-label="Light link">Light link</a>
      <div id="preexisting-closed-host" style="position:relative;width:1px;height:1px"></div>
    `)
    await page.evaluate(() => {
      const host = document.getElementById('preexisting-closed-host')!
      const root = host.attachShadow({ mode: 'closed' })
      root.innerHTML = `
        <style>
          button { position:absolute;left:300px;top:80px;width:150px;height:40px }
          input { position:absolute;left:300px;top:140px;width:180px;height:32px }
        </style>
        <button aria-label="Preexisting closed action">Apply</button>
        <input aria-label="Preexisting closed field" />
      `
    })

    const firstTrace: ExtractGeometryTrace = {}
    const onFirstAxReady = vi.fn()
    const firstStartedAt = Date.now()
    const snapshot = await extractGeometry(page, {
      axSessionManager,
      trace: firstTrace,
      onAxReady: onFirstAxReady,
    })
    const firstElapsedMs = Date.now() - firstStartedAt
    const firstNodes = flattenSnapshot(snapshot.tree, snapshot.layout)

    expect(firstNodes.filter(node => node.tree.semantic?.ariaLabel === 'Light action')).toHaveLength(1)
    expect(firstNodes.some(node => node.tree.semantic?.ariaLabel === 'Preexisting closed action')).toBe(false)
    expect(firstElapsedMs).toBeLessThan(1_000)
    expect(firstTrace).toMatchObject({
      axRan: false,
      axBackgroundStarted: true,
      axFirstDocumentProbe: true,
    })
    await vi.waitFor(() => expect(onFirstAxReady).toHaveBeenCalledTimes(1), { timeout: 5_000 })
    expect(fullAxRequestCount()).toBe(1)

    const repeatedTrace: ExtractGeometryTrace = {}
    const repeated = await extractGeometry(page, { axSessionManager, trace: repeatedTrace })
    expect(repeatedTrace).toMatchObject({
      axRan: false,
      axBackgroundStarted: false,
      axFirstDocumentProbe: false,
      axCacheReplayedCount: 2,
    })
    expect(repeated.tree.semantic).toMatchObject({
      a11yAppendUsed: true,
      a11yAppendReplayed: true,
    })
    const repeatedNodes = flattenSnapshot(repeated.tree, repeated.layout)
    const closedAction = repeatedNodes.find(node => node.tree.semantic?.ariaLabel === 'Preexisting closed action')
    const closedField = repeatedNodes.find(node => node.tree.semantic?.ariaLabel === 'Preexisting closed field')
    expect(closedAction?.tree.semantic).toMatchObject({
      role: 'button',
      a11yAppended: true,
      a11yReplayed: true,
      coordinateOnly: true,
    })
    expect(closedField?.tree.semantic).toMatchObject({
      a11yRoleHint: 'textbox',
      a11yAppended: true,
      a11yReplayed: true,
      coordinateOnly: true,
    })
    expect(closedField?.tree.semantic?.role).toBeUndefined()
    expect(closedField?.tree.semantic?.controlKey).toBeUndefined()
    expect(repeatedNodes.filter(node => node.tree.semantic?.ariaLabel === 'Preexisting closed action')).toHaveLength(1)
    expect(repeatedNodes.filter(node => node.tree.semantic?.ariaLabel === 'Preexisting closed field')).toHaveLength(1)
    expect(fullAxRequestCount()).toBe(1)

    fakeNow += 10_000
    const ageRefreshTrace: ExtractGeometryTrace = {}
    const ageRefresh = await extractGeometry(page, { axSessionManager, trace: ageRefreshTrace })
    expect(ageRefreshTrace).toMatchObject({
      axRan: false,
      axBackgroundStarted: true,
      axCacheReplayedCount: 2,
    })
    expect(ageRefreshTrace.axCacheReplaySuppressed).toBeUndefined()
    expect(flattenSnapshot(ageRefresh.tree, ageRefresh.layout)
      .some(node => node.tree.semantic?.ariaLabel === 'Preexisting closed action')).toBe(true)
    await vi.waitFor(() => expect(ageRefreshTrace.axProbeSucceeded).toBe(true), { timeout: 5_000 })
    expect(fullAxRequestCount()).toBe(2)

    await page.evaluate(() => {
      document.getElementById('preexisting-closed-host')!.style.marginLeft = '80px'
    })
    fakeNow += 100
    const changedLayoutTrace: ExtractGeometryTrace = {}
    const changedLayout = await extractGeometry(page, { axSessionManager, trace: changedLayoutTrace })
    expect(changedLayoutTrace).toMatchObject({
      axRan: false,
      axFirstDocumentProbe: false,
      axCacheReplaySuppressed: true,
    })
    expect(flattenSnapshot(changedLayout.tree, changedLayout.layout)
      .some(node => node.tree.semantic?.ariaLabel === 'Preexisting closed action')).toBe(false)
    expect(fullAxRequestCount()).toBe(2)

    fakeNow += 10_000
    const refreshedLayoutTrace: ExtractGeometryTrace = {}
    const onRefreshedAxReady = vi.fn()
    const refreshedLayout = await extractGeometry(page, {
      axSessionManager,
      trace: refreshedLayoutTrace,
      onAxReady: onRefreshedAxReady,
    })
    expect(refreshedLayoutTrace).toMatchObject({
      axRan: false,
      axBackgroundStarted: true,
      axFirstDocumentProbe: false,
    })
    expect(flattenSnapshot(refreshedLayout.tree, refreshedLayout.layout)
      .some(node => node.tree.semantic?.ariaLabel === 'Preexisting closed action')).toBe(false)
    await vi.waitFor(() => expect(onRefreshedAxReady).toHaveBeenCalledTimes(1), { timeout: 5_000 })
    expect(fullAxRequestCount()).toBe(3)
    const refreshedReplay = await extractGeometry(page, { axSessionManager })
    const refreshedClosedAction = flattenSnapshot(refreshedReplay.tree, refreshedReplay.layout)
      .find(node => node.tree.semantic?.ariaLabel === 'Preexisting closed action')
    expect(refreshedClosedAction?.layout.x).toBeGreaterThan(closedAction?.layout.x ?? 0)

    await page.goto(`data:text/html,${encodeURIComponent('<button>New document A</button><button>New document B</button>')}`)
    const navigatedTrace: ExtractGeometryTrace = {}
    await extractGeometry(page, { axSessionManager, trace: navigatedTrace })
    expect(navigatedTrace).toMatchObject({
      axRan: false,
      axBackgroundStarted: true,
      axFirstDocumentProbe: true,
    })
    await vi.waitFor(() => expect(navigatedTrace.axProbeSucceeded).toBe(true), { timeout: 5_000 })
    expect(fullAxRequestCount()).toBe(4)

    nowSpy.mockRestore()
    await axSessionManager.close()
    await page.close()
  })

  it('does not replay a stale AX action after a same-bounds semantic replacement', async () => {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
    const axSessionManager = createCdpAxSessionManager()
    let fakeNow = 30_000
    const nowSpy = vi.spyOn(nodePerformance, 'now').mockImplementation(() => fakeNow)
    await page.setContent(`
      <button>Healthy A</button>
      <button>Healthy B</button>
      <div id="closed-host" aria-label="Delete account" style="position:relative;width:1px;height:1px"></div>
    `)
    await page.evaluate(() => {
      const host = document.getElementById('closed-host')!
      const root = host.attachShadow({ mode: 'closed' })
      root.innerHTML = `
        <style>button { position:absolute;left:280px;top:120px;width:160px;height:40px }</style>
        <button aria-label="Delete account">Delete account</button>
      `
      ;(globalThis as unknown as { __geometraClosedAction: HTMLButtonElement })
        .__geometraClosedAction = root.querySelector('button')!
    })

    const onAxReady = vi.fn()
    await extractGeometry(page, { axSessionManager, onAxReady })
    await vi.waitFor(() => expect(onAxReady).toHaveBeenCalledTimes(1), { timeout: 5_000 })

    const cached = await extractGeometry(page, { axSessionManager })
    expect(flattenSnapshot(cached.tree, cached.layout).some(node =>
      node.tree.semantic?.ariaLabel === 'Delete account' &&
      node.tree.semantic?.a11yReplayed === true,
    )).toBe(true)

    const revisionBeforeReplacement = axSessionManager.revisionToken()
    await page.evaluate(() => {
      const action = (globalThis as unknown as { __geometraClosedAction: HTMLButtonElement })
        .__geometraClosedAction
      action.setAttribute('aria-label', 'Submit')
      action.textContent = 'Submit'
    })
    await vi.waitFor(() => {
      expect(axSessionManager.revisionToken()).not.toBe(revisionBeforeReplacement)
    }, { timeout: 5_000 })
    const replacementTrace: ExtractGeometryTrace = {}
    const onAxRetryDue = vi.fn()
    const suppressed = await extractGeometry(page, {
      axSessionManager,
      trace: replacementTrace,
      onAxRetryDue,
    })
    expect(replacementTrace).toMatchObject({
      axRan: false,
      axBackgroundStarted: false,
      axCacheReplaySuppressed: true,
    })
    expect(onAxRetryDue).toHaveBeenCalledWith(10_000)
    expect(flattenSnapshot(suppressed.tree, suppressed.layout).some(node =>
      node.tree.semantic?.ariaLabel === 'Delete account' &&
      node.tree.semantic?.a11yReplayed === true,
    )).toBe(false)

    fakeNow += 10_000
    const refreshTrace: ExtractGeometryTrace = {}
    const onFreshAxReady = vi.fn()
    const replacement = await extractGeometry(page, {
      axSessionManager,
      trace: refreshTrace,
      onAxReady: onFreshAxReady,
    })
    const replacementNodes = flattenSnapshot(replacement.tree, replacement.layout)

    expect(refreshTrace).toMatchObject({
      axRan: false,
      axBackgroundStarted: true,
      axCacheReplaySuppressed: true,
    })
    expect(replacementNodes.some(node =>
      node.tree.semantic?.ariaLabel === 'Delete account' &&
      node.tree.semantic?.a11yReplayed === true,
    )).toBe(false)
    await vi.waitFor(() => expect(onFreshAxReady).toHaveBeenCalledTimes(1), { timeout: 5_000 })
    const refreshed = await extractGeometry(page, { axSessionManager })
    const refreshedNodes = flattenSnapshot(refreshed.tree, refreshed.layout)
    expect(refreshedNodes.some(node =>
      node.tree.semantic?.ariaLabel === 'Submit' &&
      node.tree.semantic?.a11yReplayed === true,
    )).toBe(true)
    expect(refreshedNodes.some(node =>
      node.tree.semantic?.ariaLabel === 'Delete account' &&
      node.tree.semantic?.a11yReplayed === true,
    )).toBe(false)

    nowSpy.mockRestore()
    await axSessionManager.close()
    await page.close()
  })

  it('discards an AX tree captured before a closed-root label mutates during bounds collection', async () => {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
    await page.setContent(`
      <button>Healthy A</button><button>Healthy B</button>
      <div id="race-host" aria-label="Delete account" style="position:relative;width:1px;height:1px"></div>
    `)
    await page.evaluate(() => {
      const root = document.getElementById('race-host')!.attachShadow({ mode: 'closed' })
      root.innerHTML = `
        <style>button { position:absolute;left:260px;top:100px;width:170px;height:42px }</style>
        <button aria-label="Delete account">Delete account</button>
      `
      ;(globalThis as unknown as { __geometraRaceAction: HTMLButtonElement })
        .__geometraRaceAction = root.querySelector('button')!
    })

    const baseManager = createCdpAxSessionManager()
    const session = await baseManager.get(page)
    const rawSend = session.send.bind(session) as (
      method: string,
      params?: Record<string, unknown>,
    ) => Promise<unknown>
    let mutatedDuringProbe = false
    const interceptedSession = new Proxy(session, {
      get(target, property, receiver) {
        if (property !== 'send') return Reflect.get(target, property, receiver)
        return async (method: string, params?: Record<string, unknown>) => {
          const result = await rawSend(method, params)
          if (method === 'Accessibility.getFullAXTree' && !mutatedDuringProbe) {
            mutatedDuringProbe = true
            const revisionBefore = baseManager.revisionToken()
            await page.evaluate(() => {
              const action = (globalThis as unknown as { __geometraRaceAction: HTMLButtonElement })
                .__geometraRaceAction
              action.setAttribute('aria-label', 'Submit')
              action.textContent = 'Submit'
            })
            await vi.waitFor(() => {
              expect(baseManager.revisionToken()).not.toBe(revisionBefore)
            }, { timeout: 5_000 })
          }
          return result
        }
      },
    })
    const interceptManager: CdpAxSessionManager = {
      get: async () => interceptedSession,
      revisionToken: () => baseManager.revisionToken(),
      reset: async () => await baseManager.reset(),
      close: async () => await baseManager.close(),
    }

    const trace: ExtractGeometryTrace = {}
    const onAxReady = vi.fn()
    const onAxRetryDue = vi.fn()
    await extractGeometry(page, {
      axSessionManager: interceptManager,
      trace,
      onAxReady,
      onAxRetryDue,
    })
    await vi.waitFor(() => expect(trace.axProbeSucceeded).toBe(true), { timeout: 5_000 })
    expect(mutatedDuringProbe).toBe(true)
    expect(onAxReady).not.toHaveBeenCalled()
    expect(Number(onAxRetryDue.mock.calls[0]?.[0])).toBeGreaterThan(9_000)

    const afterRace = await extractGeometry(page, { axSessionManager: interceptManager })
    expect(flattenSnapshot(afterRace.tree, afterRace.layout).some(node =>
      node.tree.semantic?.ariaLabel === 'Delete account' &&
      node.tree.semantic?.a11yReplayed === true,
    )).toBe(false)

    await interceptManager.close()
    await page.close()
  })

  it('signals a refresh when an age probe safely removes the prior AX cache payload', async () => {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
    await page.setContent(`
      <button>Healthy A</button><button>Healthy B</button>
      <div id="ghost-host" style="position:relative;width:1px;height:1px"></div>
    `)
    await page.evaluate(() => {
      const root = document.getElementById('ghost-host')!.attachShadow({ mode: 'closed' })
      root.innerHTML = `
        <style>button { position:absolute;left:250px;top:100px;width:170px;height:42px }</style>
        <button aria-label="Transient AX action">Transient AX action</button>
      `
    })

    const baseManager = createCdpAxSessionManager()
    const session = await baseManager.get(page)
    const rawSend = session.send.bind(session) as (
      method: string,
      params?: Record<string, unknown>,
    ) => Promise<unknown>
    let returnEmptyAxTree = false
    const interceptedSession = new Proxy(session, {
      get(target, property, receiver) {
        if (property !== 'send') return Reflect.get(target, property, receiver)
        return async (method: string, params?: Record<string, unknown>) => {
          if (method === 'Accessibility.getFullAXTree' && returnEmptyAxTree) return { nodes: [] }
          return await rawSend(method, params)
        }
      },
    })
    const manager: CdpAxSessionManager = {
      get: async () => interceptedSession,
      revisionToken: () => baseManager.revisionToken(),
      reset: async () => await baseManager.reset(),
      close: async () => await baseManager.close(),
    }
    let fakeNow = 40_000
    const nowSpy = vi.spyOn(nodePerformance, 'now').mockImplementation(() => fakeNow)

    const initialReady = vi.fn()
    await extractGeometry(page, { axSessionManager: manager, onAxReady: initialReady })
    await vi.waitFor(() => expect(initialReady).toHaveBeenCalledTimes(1), { timeout: 5_000 })
    const cached = await extractGeometry(page, { axSessionManager: manager })
    expect(flattenSnapshot(cached.tree, cached.layout).some(node =>
      node.tree.semantic?.ariaLabel === 'Transient AX action' &&
      node.tree.semantic?.a11yReplayed === true,
    )).toBe(true)

    returnEmptyAxTree = true
    fakeNow += 10_000
    const removalReady = vi.fn()
    const ageRefresh = await extractGeometry(page, {
      axSessionManager: manager,
      onAxReady: removalReady,
    })
    // The old cache is safe for this returned frame while the refresh runs.
    expect(flattenSnapshot(ageRefresh.tree, ageRefresh.layout).some(node =>
      node.tree.semantic?.ariaLabel === 'Transient AX action' &&
      node.tree.semantic?.a11yReplayed === true,
    )).toBe(true)
    await vi.waitFor(() => expect(removalReady).toHaveBeenCalledTimes(1), { timeout: 5_000 })

    const afterRemoval = await extractGeometry(page, { axSessionManager: manager })
    expect(flattenSnapshot(afterRemoval.tree, afterRemoval.layout).some(node =>
      node.tree.semantic?.ariaLabel === 'Transient AX action' &&
      node.tree.semantic?.a11yReplayed === true,
    )).toBe(false)

    nowSpy.mockRestore()
    await manager.close()
    await page.close()
  })

  it('uses host document identity even when every document forges the old public symbol', async () => {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
    const axSessionManager = createCdpAxSessionManager()
    const forgedDocument = (label: string) => `<!doctype html><html><body>
      <script>
        Object.defineProperty(document, Symbol.for('geometra.documentIdentity'), {
          value: 'forged-shared-identity',
          configurable: false,
        })
      </script>
      <button>${label} A</button><button>${label} B</button>
    </body></html>`

    await page.goto(`data:text/html,${encodeURIComponent(forgedDocument('first'))}`)
    const firstTrace: ExtractGeometryTrace = {}
    await extractGeometry(page, { axSessionManager, trace: firstTrace })
    expect(firstTrace).toMatchObject({ axFirstDocumentProbe: true, axBackgroundStarted: true })
    await vi.waitFor(() => expect(firstTrace.axProbeSucceeded).toBe(true), { timeout: 5_000 })

    await page.goto(`data:text/html,${encodeURIComponent(forgedDocument('second'))}`)
    const secondTrace: ExtractGeometryTrace = {}
    await extractGeometry(page, { axSessionManager, trace: secondTrace })
    expect(secondTrace).toMatchObject({ axFirstDocumentProbe: true, axBackgroundStarted: true })
    await vi.waitFor(() => expect(secondTrace.axProbeSucceeded).toBe(true), { timeout: 5_000 })

    await axSessionManager.close()
    await page.close()
  })

  it('re-pierces CDP DOM tracking after navigation for later closed-root mutations', async () => {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
    const axSessionManager = createCdpAxSessionManager()
    await axSessionManager.get(page)
    const html = `<!doctype html><html><body><div id="host"></div><script>
      const root = document.getElementById('host').attachShadow({ mode: 'closed' });
      root.innerHTML = '<button aria-label="Before">Before</button>';
      globalThis.closedButton = root.querySelector('button');
    </script></body></html>`
    await page.goto(`data:text/html,${encodeURIComponent(html)}`, { waitUntil: 'domcontentloaded' })
    await new Promise(resolve => setTimeout(resolve, 100))

    const revisionBefore = axSessionManager.revisionToken()
    await page.evaluate(() => {
      const button = (globalThis as unknown as { closedButton: HTMLButtonElement }).closedButton
      button.setAttribute('aria-label', 'After')
      button.textContent = 'After'
    })
    await vi.waitFor(() => {
      expect(axSessionManager.revisionToken()).not.toBe(revisionBefore)
    }, { timeout: 5_000 })

    await axSessionManager.close()
    await page.close()
  })

  it('pairs visible iframe placeholders with their exact frame when a hidden sibling comes first', async () => {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
    const hiddenUrl = `data:text/html,${encodeURIComponent('<p>HIDDEN FRAME CONTENT</p>')}`
    const visibleUrl = `data:text/html,${encodeURIComponent('<p>VISIBLE FRAME CONTENT</p>')}`
    await page.setContent(`
      <iframe title="Hidden owner" style="display:none" src="${hiddenUrl}"></iframe>
      <iframe title="Visible owner" style="width:420px;height:180px" src="${visibleUrl}"></iframe>
    `)

    const snapshot = await extractGeometry(page)
    const nodes = flattenSnapshot(snapshot.tree, snapshot.layout)
    const iframeNodes = nodes.filter(node => node.tree.semantic?.tag === 'iframe')
    const text = nodes.map(node => node.tree.props.text).filter(Boolean)

    expect(iframeNodes).toHaveLength(1)
    expect(iframeNodes[0]?.tree.semantic?.ariaLabel).toBe('Visible owner')
    expect(text).toContain('VISIBLE FRAME CONTENT')
    expect(text).not.toContain('HIDDEN FRAME CONTENT')

    await page.close()
  })

  it('preserves exact iframe ownership through nested frames', async () => {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
    const nestedUrl = `data:text/html,${encodeURIComponent('<button>NESTED EXACT OWNER</button>')}`
    const outerHtml = `<p>OUTER OWNER</p><iframe title="Nested owner" style="width:300px;height:100px" src="${nestedUrl}"></iframe>`
    const outerUrl = `data:text/html,${encodeURIComponent(outerHtml)}`
    await page.setContent(`<iframe title="Outer owner" style="width:500px;height:260px" src="${outerUrl}"></iframe>`)

    const snapshot = await extractGeometry(page)
    const nodes = flattenSnapshot(snapshot.tree, snapshot.layout)
    const nested = nodes.find(node => node.tree.props.text === 'NESTED EXACT OWNER')
    const outer = nodes.find(node => node.tree.semantic?.ariaLabel === 'Outer owner')

    expect(nested?.tree.semantic?.role).toBe('button')
    expect(outer).toBeDefined()
    expect(nested?.layout.x).toBeGreaterThanOrEqual(outer?.layout.x ?? 0)
    expect(nested?.layout.y).toBeGreaterThanOrEqual(outer?.layout.y ?? 0)

    await page.close()
  })

  it('leaves a detached iframe placeholder empty instead of borrowing another child frame', async () => {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
    const goneUrl = `data:text/html,${encodeURIComponent('<p>DETACHED CONTENT</p>')}`
    const keepUrl = `data:text/html,${encodeURIComponent('<p>STILL ATTACHED CONTENT</p>')}`
    await page.setContent(`
      <iframe id="gone" title="Gone owner" style="width:400px;height:120px" src="${goneUrl}"></iframe>
      <iframe id="keep" title="Keep owner" style="width:400px;height:120px" src="${keepUrl}"></iframe>
    `)
    const snapshot = await extractFrameGeometry(page.mainFrame())
    await page.locator('#gone').evaluate(element => element.remove())

    await mergeAllIframes(snapshot.tree, snapshot.layout, page.mainFrame())
    const nodes = flattenSnapshot(snapshot.tree, snapshot.layout)
    const gone = nodes.find(node => node.tree.semantic?.ariaLabel === 'Gone owner')
    const keep = nodes.find(node => node.tree.semantic?.ariaLabel === 'Keep owner')

    expect(gone?.tree.children ?? []).toHaveLength(0)
    expect(keep?.tree.children?.some(child => child.props.text === 'STILL ATTACHED CONTENT')).toBe(true)
    expect(gone?.tree.children?.some(child => child.props.text === 'STILL ATTACHED CONTENT')).not.toBe(true)

    await page.close()
  })

  it('resolves IDREF names and descriptions inside the owner shadow root before light DOM', async () => {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } })
    await page.setContent(`
      <span id="choice-label">Wrong light-DOM label</span>
      <p id="choice-help">Wrong light-DOM help</p>
      <span id="missing-shadow-label">Leaked light-DOM label</span>
      <p id="missing-shadow-help">Leaked light-DOM help</p>
      <div id="shadow-host"></div>
    `)
    await page.evaluate(() => {
      const host = document.getElementById('shadow-host')!
      const root = host.attachShadow({ mode: 'open' })
      root.innerHTML = `
        <style>input { width: 24px; height: 24px; }</style>
        <span id="choice-label">Shadow radio label</span>
        <p id="choice-help">Shadow-local help</p>
        <input type="radio" aria-labelledby="choice-label" aria-describedby="choice-help" />
        <input id="missing-radio" type="radio" aria-labelledby="missing-shadow-label" aria-describedby="missing-shadow-help" />
      `
    })

    const snapshot = await extractGeometry(page)
    const radio = flattenSnapshot(snapshot.tree, snapshot.layout)
      .find(node => node.tree.semantic?.role === 'radio')

    expect(radio?.tree.semantic?.ariaLabel).toBe('Shadow radio label')
    expect(radio?.tree.semantic?.validationDescription).toBe('Shadow-local help')
    const missing = flattenSnapshot(snapshot.tree, snapshot.layout)
      .find(node => node.tree.semantic?.controlId === 'missing-radio')
    expect(missing?.tree.semantic?.ariaLabel).toBeUndefined()
    expect(missing?.tree.semantic?.validationDescription).toBeUndefined()

    await page.close()
  })

  it('consumes the instrumented closed-shadow registry but suppresses unreachable form fields', async () => {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
    await page.setContent('<button>Light control</button><div id="closed-host" style="position:relative;width:0;height:0"></div>')
    await page.evaluate(() => {
      const host = document.getElementById('closed-host')!
      const root = host.attachShadow({ mode: 'closed' })
      const registry = new WeakMap<Element, ShadowRoot>()
      registry.set(host, root)
      Object.defineProperty(globalThis, Symbol.for('geometra.closedShadowRoots'), {
        configurable: true,
        value: registry,
      })
      root.innerHTML = `
        <style>
          button { position:absolute;left:48px;top:40px;width:160px;height:44px }
          input { position:absolute;left:48px;top:100px;width:200px;height:30px }
        </style>
        <button aria-label="Closed action">Closed action</button>
        <input required aria-label="Unreachable closed field" />
      `
    })

    const onAxReady = vi.fn()
    const initial = await extractGeometry(page, { onAxReady })
    expect(flattenSnapshot(initial.tree, initial.layout)
      .some(node => node.tree.semantic?.ariaLabel === 'Unreachable closed field')).toBe(false)
    await vi.waitFor(() => expect(onAxReady).toHaveBeenCalledTimes(1), { timeout: 5_000 })

    const snapshot = await extractGeometry(page)
    const nodes = flattenSnapshot(snapshot.tree, snapshot.layout)
    const button = nodes.find(node => node.tree.semantic?.ariaLabel === 'Closed action')
    const field = nodes.find(node => node.tree.semantic?.ariaLabel === 'Unreachable closed field')

    expect(button?.tree.semantic?.role).toBe('button')
    expect(button?.tree.semantic?.shadowMode).toBe('closed')
    expect(button?.tree.semantic?.coordinateOnly).toBe(true)
    expect(button?.layout.width).toBeGreaterThan(0)
    expect(field?.tree.semantic).toMatchObject({
      a11yRoleHint: 'textbox',
      coordinateOnly: true,
    })
    expect(field?.tree.semantic?.role).toBeUndefined()
    expect(field?.tree.semantic?.controlKey).toBeUndefined()

    await page.close()
  })

  it('preserves file-input schema metadata for visible and hidden choosers', async () => {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } })
    await page.setContent(`
      <label for="resume">Resume</label>
      <input id="resume" name="resume" type="file" accept=".pdf, application/pdf" multiple required />
      <label for="portfolio">Portfolio</label>
      <input id="portfolio" name="portfolio" type="file" accept="image/*" style="display:none" />
      <form id="supplement-form">
        <div style="display:none">
          <p>Unrelated hidden prose must stay pruned</p>
          <label for="supplement">Supplement</label>
          <input id="supplement" name="supplement" type="file" accept="text/plain" required />
        </div>
      </form>
      <form id="unlabeled-file-form">
        <div style="display:none">
          <input id="required-attachment" name="required_attachment" type="file" required />
        </div>
      </form>
    `)

    const snapshot = await extractGeometry(page)
    const files = flattenSnapshot(snapshot.tree, snapshot.layout)
      .filter(node => node.tree.semantic?.fileInput === true)
    const resume = files.find(node => node.tree.semantic?.controlId === 'resume')
    const portfolio = files.find(node => node.tree.semantic?.controlId === 'portfolio')
    const supplement = files.find(node => node.tree.semantic?.controlId === 'supplement')
    const requiredAttachment = files.find(node => node.tree.semantic?.controlId === 'required-attachment')

    expect(resume?.tree.semantic).toMatchObject({
      inputType: 'file',
      accept: '.pdf, application/pdf',
      multiple: true,
      ariaRequired: true,
    })
    expect(portfolio?.tree.semantic).toMatchObject({
      inputType: 'file',
      accept: 'image/*',
      multiple: false,
    })
    expect(supplement?.tree.semantic).toMatchObject({
      inputType: 'file',
      accept: 'text/plain',
      ariaRequired: true,
    })
    const supplementPath = findTreePath(
      snapshot.tree,
      node => node.semantic?.controlId === 'supplement',
    )
    expect(supplementPath?.some(node => node.semantic?.tag === 'form')).toBe(true)
    expect(requiredAttachment?.tree.semantic).toMatchObject({
      ariaLabel: 'required_attachment',
      inputType: 'file',
      ariaRequired: true,
    })
    const requiredAttachmentPath = findTreePath(
      snapshot.tree,
      node => node.semantic?.controlId === 'required-attachment',
    )
    expect(requiredAttachmentPath?.some(node => node.semantic?.tag === 'form')).toBe(true)
    expect(flattenSnapshot(snapshot.tree, snapshot.layout)
      .some(node => node.tree.props.text === 'Unrelated hidden prose must stay pruned')).toBe(false)

    await page.close()
  })

  it('preserves long textarea values past 240 chars (cover letters, "why X?" essays)', async () => {
    // Regression for JobForge 2026-04-11: Anthropic Greenhouse SA fill
    // silently truncated at ~240 chars. Cause was extractor.normalizedControlValue
    // capping ALL control values at 240. Textareas and contenteditable need
    // a much larger budget because they legitimately hold essays.
    const longEssay =
      "I've spent the past years building production AI systems — at Razroo I architected a multi-modal platform that uses Claude alongside OpenAI and Vertex AI with Pinecone-backed RAG, deployed into an Enterprise GenAI ticketing system that generates SAFe Agile tickets from a single prompt. " +
      "The Beneficial Deployments framing is what closes the loop for me. The partners you list — education, healthcare, scientific research, civil society — are exactly the organizations that need technical translation, not more dashboards. " +
      "I also want to build at Anthropic specifically because it's the lab whose output I already ship on. Being closer to the model — catching product gaps, surfacing edge cases from real deployments, and shaping cohort programs that scale the expertise — is where I can contribute the most from day one."
    expect(longEssay.length).toBeGreaterThan(600)

    const page = await browser.newPage({ viewport: { width: 800, height: 600 } })
    await page.setContent(`
      <form>
        <label for="why">Why Anthropic?</label>
        <textarea id="why" name="why" rows="10" cols="60"></textarea>
        <label for="short">First name</label>
        <input id="short" name="short" type="text" />
      </form>
    `)
    await page.evaluate((value) => {
      const textarea = document.getElementById('why') as HTMLTextAreaElement
      textarea.value = value
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
      textarea.dispatchEvent(new Event('change', { bubbles: true }))
      const input = document.getElementById('short') as HTMLInputElement
      input.value = 'Charlie'
      input.dispatchEvent(new Event('input', { bubbles: true }))
    }, longEssay)

    const snapshot = await extractGeometry(page)
    const nodes = flattenSnapshot(snapshot.tree, snapshot.layout)
    const textarea = nodes.find(node =>
      node.tree.semantic?.tag === 'textarea' || node.tree.semantic?.role === 'textbox',
    )
    const input = nodes.find(node =>
      node.tree.semantic?.tag === 'input' && node.tree.semantic?.role === 'textbox',
    )

    expect(textarea).toBeDefined()
    expect(input).toBeDefined()
    // Full essay must be preserved — no silent truncation at 240 chars.
    expect(textarea?.tree.semantic?.valueText).toBe(longEssay.replace(/\s+/g, ' ').trim())
    // Short inputs keep the existing 240-cap behavior.
    expect(input?.tree.semantic?.valueText).toBe('Charlie')

    await page.close()
  })

  it('caps extremely long textarea values at 16384 chars to keep snapshots bounded', async () => {
    // The textarea cap is a budget, not a license for unbounded payloads.
    // A 50KB rich-editor default should still be capped so the snapshot
    // stays a reasonable size. We pick 16384 as the long-form cap.
    const huge = 'a'.repeat(20_000)
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } })
    await page.setContent(`
      <form>
        <label for="huge">Huge</label>
        <textarea id="huge" name="huge" rows="10"></textarea>
      </form>
    `)
    await page.evaluate((value) => {
      const textarea = document.getElementById('huge') as HTMLTextAreaElement
      textarea.value = value
    }, huge)

    const snapshot = await extractGeometry(page)
    const nodes = flattenSnapshot(snapshot.tree, snapshot.layout)
    const textarea = nodes.find(node => node.tree.semantic?.tag === 'textarea')

    expect(textarea).toBeDefined()
    const valueText = textarea?.tree.semantic?.valueText as string | undefined
    expect(valueText).toBeDefined()
    expect(valueText!.length).toBe(16_384)

    await page.close()
  })
})
