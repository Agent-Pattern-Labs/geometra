import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser } from 'playwright'
import { extractGeometry } from '../extractor.ts'
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

    const snapshot = await extractGeometry(page)
    const nodes = flattenSnapshot(snapshot.tree, snapshot.layout)
    const button = nodes.find(node =>
      node.tree.semantic?.role === 'button' &&
      node.tree.semantic?.ariaLabel === 'Apply now',
    )

    expect(snapshot.tree.semantic?.a11yFallbackUsed).toBe(true)
    expect(button).toBeDefined()
    expect(button?.tree.semantic?.a11yFallback).toBe(true)
    expect(button?.tree.handlers?.onClick).toBe(true)

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
