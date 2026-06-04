import { writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser } from 'playwright'
import { attachFiles, fillFields, fillOtp, pickListboxOption, setCheckedControl, setFieldChoice, setFieldText, wheelAt } from '../dom-actions.ts'

describe('pickListboxOption', () => {
  let browser: Browser

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true })
  })

  afterAll(async () => {
    await browser.close()
  })

  it('opens a labeled custom dropdown and clicks a visible button option fallback', async () => {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
    await page.setContent(`
      <style>
        body { margin: 24px; font-family: sans-serif; }
        .field { width: 360px; position: relative; }
        #trigger { width: 100%; min-height: 44px; text-align: left; }
        #menu[hidden] { display: none; }
        #menu { border: 1px solid #ccc; margin-top: 6px; padding: 8px; display: grid; gap: 6px; }
      </style>
      <div class="field">
        <label>Location</label>
        <button id="trigger" type="button" aria-haspopup="listbox">Start typing...</button>
        <div id="menu" hidden>
          <button type="button">Austin, TX</button>
          <button type="button">New York, NY</button>
        </div>
      </div>
      <script>
        const trigger = document.getElementById('trigger')
        const menu = document.getElementById('menu')
        trigger.addEventListener('click', () => {
          menu.hidden = false
        })
        for (const option of menu.querySelectorAll('button')) {
          option.addEventListener('click', () => {
            trigger.textContent = option.textContent
            menu.hidden = true
          })
        }
      </script>
    `)

    await pickListboxOption(page, 'New York, NY', {
      fieldLabel: 'Location',
      exact: true,
    })

    expect(await page.locator('#trigger').textContent()).toBe('New York, NY')
    await page.close()
  })

  it('prefers the visible dropdown trigger over a tiny labeled input', async () => {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
    await page.setContent(`
      <style>
        body { margin: 24px; font-family: sans-serif; }
        .field { width: 360px; position: relative; }
        #trigger { width: 100%; min-height: 44px; text-align: left; }
        #combo-input { width: 6px; height: 6px; border: 0; padding: 0; margin: 0; }
        #menu[hidden] { display: none; }
        #menu { border: 1px solid #ccc; margin-top: 6px; padding: 8px; display: grid; gap: 6px; }
      </style>
      <div class="field">
        <label for="combo-input">Country</label>
        <div>
          <input id="combo-input" placeholder="Start typing..." />
          <button id="trigger" type="button" aria-haspopup="listbox">Select country</button>
        </div>
        <div id="menu" hidden>
          <button type="button">Canada</button>
          <button type="button">United States</button>
        </div>
      </div>
      <script>
        const trigger = document.getElementById('trigger')
        const menu = document.getElementById('menu')
        trigger.addEventListener('click', () => {
          menu.hidden = false
        })
        for (const option of menu.querySelectorAll('button')) {
          option.addEventListener('click', () => {
            trigger.textContent = option.textContent
            menu.hidden = true
          })
        }
      </script>
    `)

    await pickListboxOption(page, 'United States', {
      fieldLabel: 'Country',
      exact: false,
    })

    expect(await page.locator('#trigger').textContent()).toBe('United States')
    await page.close()
  })

  it('keeps explicitly labeled tiny comboboxes anchored to their own wrapper instead of a nearby phone field', async () => {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
    await page.setContent(`
      <style>
        body { margin: 24px; font-family: sans-serif; }
        .stack { display: grid; gap: 12px; width: 420px; }
        .select__control { width: 160px; min-height: 34px; border: 1px solid #ccc; padding: 4px 12px; display: flex; align-items: center; }
        #country { width: 4px; border: 0; padding: 0; margin: 0; }
        #menu[hidden] { display: none; }
        #menu { border: 1px solid #ccc; margin-top: 6px; padding: 8px; display: grid; gap: 6px; width: 220px; }
        #phone { width: 320px; min-height: 34px; }
      </style>
      <div class="stack">
        <div class="field">
          <label for="country">Country</label>
          <div id="country-control" class="select__control">
            <input id="country" role="combobox" aria-labelledby="country-label" aria-expanded="false" />
            <span id="country-selected">Select country</span>
          </div>
          <div id="menu" hidden>
            <button type="button">Canada</button>
            <button type="button">United States +1</button>
          </div>
        </div>
        <div class="field">
          <label for="phone">Phone</label>
          <input id="phone" aria-label="Phone" />
        </div>
      </div>
      <script>
        const label = document.querySelector('label[for="country"]')
        label.id = 'country-label'
        const input = document.getElementById('country')
        const control = document.getElementById('country-control')
        const selected = document.getElementById('country-selected')
        const menu = document.getElementById('menu')
        const options = Array.from(menu.querySelectorAll('button'))
        control.addEventListener('click', () => {
          menu.hidden = false
          input.setAttribute('aria-expanded', 'true')
          input.focus()
        })
        input.addEventListener('input', () => {
          const query = input.value.toLowerCase()
          menu.hidden = false
          input.setAttribute('aria-expanded', 'true')
          for (const option of options) {
            option.hidden = !option.textContent.toLowerCase().includes(query)
          }
        })
        for (const option of options) {
          option.addEventListener('click', () => {
            selected.textContent = option.textContent.includes('+1') ? '+1' : option.textContent
            input.value = ''
            menu.hidden = true
            input.setAttribute('aria-expanded', 'false')
          })
        }
      </script>
    `)

    await pickListboxOption(page, 'United States', {
      fieldLabel: 'Country',
      exact: false,
    })

    expect(await page.locator('#country-selected').textContent()).toBe('+1')
    expect(await page.locator('#phone').inputValue()).toBe('')
    await page.close()
  })

  it('matches short affirmative labels to longer consent-style option copy', async () => {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
    await page.setContent(`
      <style>
        body { margin: 24px; font-family: sans-serif; }
        .field { width: 420px; position: relative; }
        #trigger { width: 100%; min-height: 44px; text-align: left; }
        #menu[hidden] { display: none; }
        #menu { border: 1px solid #ccc; margin-top: 6px; padding: 8px; display: grid; gap: 6px; }
      </style>
      <div class="field">
        <label>GDPR consent</label>
        <button id="trigger" type="button" aria-haspopup="listbox">Choose an answer</button>
        <div id="menu" hidden>
          <button type="button">I have read and acknowledge the privacy policy</button>
          <button type="button">I do not agree</button>
        </div>
      </div>
      <script>
        const trigger = document.getElementById('trigger')
        const menu = document.getElementById('menu')
        trigger.addEventListener('click', () => {
          menu.hidden = false
        })
        for (const option of menu.querySelectorAll('button')) {
          option.addEventListener('click', () => {
            trigger.textContent = option.textContent
            menu.hidden = true
          })
        }
      </script>
    `)

    await pickListboxOption(page, 'Yes', {
      fieldLabel: 'GDPR consent',
      exact: false,
    })

    expect(await page.locator('#trigger').textContent()).toBe('I have read and acknowledge the privacy policy')
    await page.close()
  })

  it('confirms against the anchored field when matching labels repeat after DOM reordering', async () => {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
    await page.setContent(`
      <style>
        body { margin: 24px; font-family: sans-serif; }
        #stack { display: grid; gap: 16px; width: 420px; }
        button.trigger { width: 100%; min-height: 44px; text-align: left; }
        .menu[hidden] { display: none; }
        .menu { border: 1px solid #ccc; padding: 8px; display: grid; gap: 6px; }
      </style>
      <div id="stack">
        <div class="field" id="field-a">
          <label>Country</label>
          <button class="trigger" id="trigger-a" type="button" aria-haspopup="listbox">Choose country</button>
          <div class="menu" id="menu-a" hidden>
            <button type="button">Canada</button>
            <button type="button">United States</button>
          </div>
        </div>
        <div class="field" id="field-b">
          <label>Country</label>
          <button class="trigger" id="trigger-b" type="button" aria-haspopup="listbox">Choose country</button>
          <div class="menu" id="menu-b" hidden>
            <button type="button">Mexico</button>
            <button type="button">Brazil</button>
          </div>
        </div>
      </div>
      <script>
        const stack = document.getElementById('stack')
        const fieldA = document.getElementById('field-a')
        const fieldB = document.getElementById('field-b')
        const triggerA = document.getElementById('trigger-a')
        const menuA = document.getElementById('menu-a')
        const triggerB = document.getElementById('trigger-b')
        const menuB = document.getElementById('menu-b')
        triggerA.addEventListener('click', () => {
          menuA.hidden = false
        })
        triggerB.addEventListener('click', () => {
          menuB.hidden = false
        })
        for (const option of menuA.querySelectorAll('button')) {
          option.addEventListener('click', () => {
            triggerA.textContent = option.textContent
            menuA.hidden = true
            stack.insertBefore(fieldB, fieldA)
          })
        }
      </script>
    `)

    await pickListboxOption(page, 'Canada', {
      fieldLabel: 'Country',
      exact: false,
    })

    expect(await page.locator('#trigger-a').textContent()).toBe('Canada')
    expect(await page.locator('#trigger-b').textContent()).toBe('Choose country')
    await page.close()
  })

  it('targets the right popup when multiple comboboxes share Yes/No options (Greenhouse-style)', async () => {
    // Regression for the failure mode that breaks Greenhouse application forms:
    // three distinct comboboxes (work auth, sponsorship, prior employment) all expose a
    // Yes/No popup. Without popup-scoped option resolution the picker would click the
    // first matching option in document order, leaving the requested field untouched and
    // letting the form's required-field validation fire on submit.
    const page = await browser.newPage({ viewport: { width: 900, height: 800 } })
    await page.setContent(`
      <style>
        body { margin: 24px; font-family: sans-serif; }
        .field { width: 480px; margin-bottom: 24px; position: relative; }
        .control { display: flex; align-items: center; gap: 8px; padding: 6px 12px; border: 1px solid #ccc; min-height: 36px; }
        .control[data-state="invalid"] { border-color: #c00; }
        .menu[hidden] { display: none; }
        .menu { border: 1px solid #ccc; margin-top: 6px; padding: 4px; display: grid; gap: 4px; background: #fff; }
        [role="option"][data-highlighted="true"] { background: #def; }
        [role="option"] { padding: 6px 8px; cursor: pointer; }
      </style>
      <form id="application">
        <div class="field" id="field-auth">
          <label id="auth-label">Are you legally authorized to work in the country in which you are applying?</label>
          <div class="control" id="auth-control" data-state="invalid">
            <input id="auth-input" role="combobox" aria-labelledby="auth-label" aria-controls="auth-menu" aria-expanded="false" aria-haspopup="listbox" />
            <span id="auth-display" data-placeholder="true">Select...</span>
          </div>
          <div class="menu" id="auth-menu" role="listbox" aria-labelledby="auth-label" hidden>
            <div role="option">Yes</div>
            <div role="option">No</div>
          </div>
        </div>
        <div class="field" id="field-sponsor">
          <label id="sponsor-label">Do you now or will you in the future need sponsorship for employment visa status?</label>
          <div class="control" id="sponsor-control" data-state="invalid">
            <input id="sponsor-input" role="combobox" aria-labelledby="sponsor-label" aria-controls="sponsor-menu" aria-expanded="false" aria-haspopup="listbox" />
            <span id="sponsor-display" data-placeholder="true">Select...</span>
          </div>
          <div class="menu" id="sponsor-menu" role="listbox" aria-labelledby="sponsor-label" hidden>
            <div role="option">Yes</div>
            <div role="option">No</div>
          </div>
        </div>
        <div class="field" id="field-prior">
          <label id="prior-label">Have you previously worked for the company?</label>
          <div class="control" id="prior-control" data-state="invalid">
            <input id="prior-input" role="combobox" aria-labelledby="prior-label" aria-controls="prior-menu" aria-expanded="false" aria-haspopup="listbox" />
            <span id="prior-display" data-placeholder="true">Select...</span>
          </div>
          <div class="menu" id="prior-menu" role="listbox" aria-labelledby="prior-label" hidden>
            <div role="option">Yes</div>
            <div role="option">No</div>
          </div>
        </div>
      </form>
      <script>
        function wireField(controlId, inputId, displayId, menuId) {
          const control = document.getElementById(controlId)
          const input = document.getElementById(inputId)
          const display = document.getElementById(displayId)
          const menu = document.getElementById(menuId)
          const options = Array.from(menu.querySelectorAll('[role="option"]'))

          function open() {
            menu.hidden = false
            input.setAttribute('aria-expanded', 'true')
          }
          function close() {
            menu.hidden = true
            input.setAttribute('aria-expanded', 'false')
          }
          function commit(value) {
            display.textContent = value
            display.removeAttribute('data-placeholder')
            control.removeAttribute('data-state')
            close()
          }

          control.addEventListener('click', open)
          input.addEventListener('focus', open)
          input.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') {
              const highlighted = options.find(o => o.getAttribute('data-highlighted') === 'true')
              if (highlighted) {
                event.preventDefault()
                commit(highlighted.textContent)
              }
            }
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault()
              const currentIndex = options.findIndex(o => o.getAttribute('data-highlighted') === 'true')
              const nextIndex =
                event.key === 'ArrowDown'
                  ? (currentIndex + 1 + options.length) % options.length
                  : (currentIndex - 1 + options.length) % options.length
              for (const o of options) o.removeAttribute('data-highlighted')
              options[nextIndex].setAttribute('data-highlighted', 'true')
            }
          })
          for (const option of options) {
            option.addEventListener('mousedown', (event) => {
              event.preventDefault()
              commit(option.textContent)
            })
          }
        }

        wireField('auth-control', 'auth-input', 'auth-display', 'auth-menu')
        wireField('sponsor-control', 'sponsor-input', 'sponsor-display', 'sponsor-menu')
        wireField('prior-control', 'prior-input', 'prior-display', 'prior-menu')
      </script>
    `)

    // Pick the middle field's "No" option. The first and third fields must remain untouched.
    await pickListboxOption(page, 'No', {
      fieldLabel: 'Do you now or will you in the future need sponsorship for employment visa status?',
      exact: false,
    })

    expect(await page.locator('#sponsor-display').textContent()).toBe('No')
    expect(await page.locator('#auth-display').textContent()).toBe('Select...')
    expect(await page.locator('#prior-display').textContent()).toBe('Select...')

    // And the first field still works after the second one closed.
    await pickListboxOption(page, 'Yes', {
      fieldLabel: 'Are you legally authorized to work in the country in which you are applying?',
      exact: false,
    })

    expect(await page.locator('#auth-display').textContent()).toBe('Yes')
    expect(await page.locator('#sponsor-display').textContent()).toBe('No')
    expect(await page.locator('#prior-display').textContent()).toBe('Select...')

    await page.close()
  })

  it('falls back to keyboard navigation for searchable comboboxes when click selection does not update the field', async () => {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
    await page.setContent(`
      <style>
        body { margin: 24px; font-family: sans-serif; }
        .field { width: 420px; position: relative; display: grid; gap: 8px; }
        #combo { width: 100%; min-height: 40px; }
        #menu[hidden] { display: none; }
        #menu { border: 1px solid #ccc; padding: 8px; display: grid; gap: 6px; }
        [role="option"][data-highlighted="true"] { background: #def; }
      </style>
      <div class="field">
        <label for="combo">Country</label>
        <input
          id="combo"
          role="combobox"
          aria-controls="menu"
          aria-expanded="false"
          aria-autocomplete="list"
        />
        <div id="selection">Choose country</div>
        <div id="menu" role="listbox" hidden>
          <div id="option-ca" role="option">Canada</div>
          <div id="option-us" role="option">United States</div>
        </div>
      </div>
      <script>
        const input = document.getElementById('combo')
        const menu = document.getElementById('menu')
        const selection = document.getElementById('selection')
        const options = Array.from(menu.querySelectorAll('[role="option"]'))
        let filtered = options
        let activeIndex = -1

        function refresh() {
          const query = input.value.toLowerCase()
          filtered = options.filter(option => option.textContent.toLowerCase().includes(query))
          menu.hidden = false
          input.setAttribute('aria-expanded', 'true')
          for (const option of options) {
            option.hidden = !filtered.includes(option)
            option.removeAttribute('data-highlighted')
          }
          if (filtered.length === 0) {
            activeIndex = -1
            input.removeAttribute('aria-activedescendant')
            return
          }
          if (activeIndex < 0 || activeIndex >= filtered.length) activeIndex = 0
          const active = filtered[activeIndex]
          active.setAttribute('data-highlighted', 'true')
          input.setAttribute('aria-activedescendant', active.id)
        }

        input.addEventListener('focus', refresh)
        input.addEventListener('click', refresh)
        input.addEventListener('input', () => {
          activeIndex = -1
          refresh()
        })
        input.addEventListener('keydown', (event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault()
            if (filtered.length > 0) {
              activeIndex = (activeIndex + 1) % filtered.length
              refresh()
            }
          }
          if (event.key === 'ArrowUp') {
            event.preventDefault()
            if (filtered.length > 0) {
              activeIndex = (activeIndex - 1 + filtered.length) % filtered.length
              refresh()
            }
          }
          if (event.key === 'Enter') {
            const active = filtered[activeIndex]
            if (active) {
              event.preventDefault()
              selection.textContent = active.textContent
              menu.hidden = true
              input.setAttribute('aria-expanded', 'false')
            }
          }
        })
        for (const option of options) {
          option.addEventListener('click', (event) => {
            event.preventDefault()
          })
        }
      </script>
    `)

    await pickListboxOption(page, 'United States', {
      fieldLabel: 'Country',
      exact: false,
    })

    expect(await page.locator('#selection').textContent()).toBe('United States')
    await page.close()
  })

  it('surfaces selection_not_confirmed when a react-select-style listbox keeps aria-invalid=true after click', async () => {
    // Regression: on some forms (Greenhouse's forked react-select instance on
    // Anthropic-style ATS pages, and various Workday PTX flows) the library
    // briefly renders the selected option in `.select__single-value` on click,
    // but its internal form state never commits, so the trigger keeps
    // advertising `aria-invalid="true"`. Before the aria-invalid veto,
    // confirmListboxSelection happily returned true on the brief
    // `.select__single-value` match and dismissAndReVerifySelection then
    // optimistically returned true because the sawAnyValue fallback treated
    // "no displayed values" as success. pickListboxOption would return
    // cleanly, and fill_form would report a 100% success that was a lie.
    //
    // The fix is to consult the trigger's aria-invalid attribute as the
    // authoritative commit signal and treat a still-invalid field as a
    // definitive failure, regardless of what other heuristics say.
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
    await page.setContent(`
      <style>
        body { margin: 24px; font-family: sans-serif; }
        .field { width: 360px; display: grid; gap: 8px; }
        .rs-control { border: 1px solid #ccc; min-height: 40px; display: flex; align-items: center; padding: 0 12px; cursor: pointer; }
        .rs-single-value { color: #111; }
        .rs-placeholder { color: #888; }
        .rs-menu[hidden] { display: none; }
        .rs-menu { border: 1px solid #ccc; margin-top: 4px; padding: 4px 0; }
        .rs-option { padding: 6px 12px; cursor: pointer; }
      </style>
      <div class="field">
        <label for="visa-control">Will you now or will you in the future require employment visa sponsorship?</label>
        <div
          id="visa-control"
          class="rs-control"
          role="combobox"
          aria-haspopup="listbox"
          aria-expanded="false"
          aria-invalid="true"
          aria-required="true"
          tabindex="0"
        >
          <span id="visa-value" class="rs-placeholder">Select...</span>
        </div>
        <div id="visa-menu" class="rs-menu" role="listbox" hidden>
          <div id="visa-option-yes" class="rs-option" role="option">Yes</div>
          <div id="visa-option-no" class="rs-option" role="option">No</div>
        </div>
      </div>
      <script>
        const control = document.getElementById('visa-control')
        const valueEl = document.getElementById('visa-value')
        const menu = document.getElementById('visa-menu')
        const options = Array.from(menu.querySelectorAll('.rs-option'))

        function open() {
          if (!menu.hidden) return
          menu.hidden = false
          control.setAttribute('aria-expanded', 'true')
        }
        function close() {
          if (menu.hidden) return
          menu.hidden = true
          control.setAttribute('aria-expanded', 'false')
        }

        control.addEventListener('click', (event) => {
          // Only the control itself opens the menu. Option clicks inside the
          // menu do not bubble up to this handler because the menu lives in a
          // sibling container, but we still early-return if the event came
          // from a selector path (defensive).
          if (event.target.closest('.rs-option')) return
          if (menu.hidden) open(); else close()
        })

        for (const option of options) {
          option.addEventListener('click', (event) => {
            event.stopPropagation()
            // Simulate the buggy library flow: flash the selection into
            // .select__single-value so displayed-value heuristics pick it up,
            // but NEVER clear aria-invalid. In production this is the state
            // after react-select commits its visual side but its internal
            // form state reverts (or never flips in the first place).
            valueEl.textContent = option.textContent
            valueEl.classList.remove('rs-placeholder')
            valueEl.classList.add('rs-single-value')
            close()
            // Explicitly re-assert invalid to defeat any library that reads
            // the attribute late.
            control.setAttribute('aria-invalid', 'true')
          })
        }
      </script>
    `)

    let thrown: Error | null = null
    try {
      await pickListboxOption(page, 'No', {
        fieldLabel: 'Will you now or will you in the future require employment visa sponsorship?',
        exact: false,
      })
    } catch (error) {
      thrown = error as Error
    }

    // The library never clears aria-invalid, so pickListboxOption MUST
    // surface the failure instead of silently reporting success.
    expect(thrown).not.toBeNull()
    expect(thrown?.message).toContain('selection_not_confirmed')
    await page.close()
  }, 60_000)

  it('surfaces selection_not_confirmed when a Greenhouse-style listbox stays at the placeholder without ever flipping aria-invalid', async () => {
    // Regression: Greenhouse / Lever / plain ARIA listboxes use a different
    // silent-fail pattern than the react-select aria-invalid revert covered
    // by the v1.38.0 test. They simply leave the trigger at the
    // ".select__placeholder" element ("Select...") and never set
    // aria-invalid on the combobox until the user clicks Submit, at which
    // point the form library finally runs validation and flips the flag.
    //
    // Before the placeholder-stays check landed, pickListboxOption couldn't
    // detect this case during the silent window — confirmListboxSelection
    // saw nothing matching in displayed values and fell through to the
    // sawAnyValue=false optimistic-success branch, which returned true
    // because aria-invalid was absent. The ack reported success, fill_form
    // claimed the field was filled, and Submit was the first thing to
    // notice the field was actually empty.
    //
    // The fix is generic: read the trigger's visible text and check it
    // against PLACEHOLDER_PATTERN. Works on Greenhouse / Lever / plain ARIA
    // — any library that renders a "Select..." prompt while the field is
    // uncommitted.
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
    await page.setContent(`
      <style>
        body { margin: 24px; font-family: sans-serif; }
        .field { width: 360px; display: grid; gap: 8px; }
        .gh-control { border: 1px solid #ccc; min-height: 40px; display: flex; align-items: center; padding: 0 12px; cursor: pointer; }
        .gh-single-value { color: #111; }
        .gh-placeholder { color: #888; }
        .gh-menu[hidden] { display: none; }
        .gh-menu { border: 1px solid #ccc; margin-top: 4px; padding: 4px 0; }
        .gh-option { padding: 6px 12px; cursor: pointer; }
      </style>
      <div class="field">
        <label for="prior-control">Have you previously worked at or consulted for GitLab?</label>
        <div
          id="prior-control"
          class="gh-control"
          role="combobox"
          aria-haspopup="listbox"
          aria-expanded="false"
          aria-required="true"
          tabindex="0"
        >
          <span id="prior-value" class="gh-placeholder">Select...</span>
        </div>
        <div id="prior-menu" class="gh-menu" role="listbox" hidden>
          <div id="prior-option-yes" class="gh-option" role="option">Yes</div>
          <div id="prior-option-no" class="gh-option" role="option">No</div>
        </div>
      </div>
      <script>
        const control = document.getElementById('prior-control')
        const menu = document.getElementById('prior-menu')
        const options = Array.from(menu.querySelectorAll('.gh-option'))

        function open() {
          if (!menu.hidden) return
          menu.hidden = false
          control.setAttribute('aria-expanded', 'true')
        }
        function close() {
          if (menu.hidden) return
          menu.hidden = true
          control.setAttribute('aria-expanded', 'false')
        }

        control.addEventListener('click', (event) => {
          if (event.target.closest('.gh-option')) return
          if (menu.hidden) open(); else close()
        })

        for (const option of options) {
          // Buggy library behavior: option click closes the menu but never
          // commits the selection to the trigger. The placeholder stays
          // exactly where it was. aria-invalid is NEVER set during the
          // silent window — only Submit would flip it. This is the
          // Greenhouse pattern.
          option.addEventListener('click', (event) => {
            event.stopPropagation()
            close()
            // Re-assert that the trigger remains at its placeholder text
            // (defensive — emulates a library that explicitly resets the
            // visual state on every option click failure).
            const valueEl = document.getElementById('prior-value')
            valueEl.textContent = 'Select...'
            valueEl.classList.add('gh-placeholder')
            valueEl.classList.remove('gh-single-value')
          })
        }
      </script>
    `)

    let thrown: Error | null = null
    try {
      await pickListboxOption(page, 'No', {
        fieldLabel: 'Have you previously worked at or consulted for GitLab?',
        exact: false,
      })
    } catch (error) {
      thrown = error as Error
    }

    expect(thrown).not.toBeNull()
    expect(thrown?.message).toContain('selection_not_confirmed')
    await page.close()
  }, 60_000)

  it('commits a React-Select/Greenhouse-Remix combobox that only honors keyboard Enter after the option click', async () => {
    // Regression: Greenhouse's Remix-wrapped react-select build (used by
    // Anthropic, Intercom, Glean, Databricks, GitLab, etc.) has a silent-
    // fill shape that none of the existing checks catch: the option click
    // visually updates the trigger AND sets .select__single-value AND
    // clears aria-invalid on the trigger, so every heuristic in
    // confirmListboxSelection reports success. But the library only commits
    // its controlled form state when the underlying combobox input receives
    // `keydown Enter` — Playwright's synthetic click doesn't route through
    // React Select's keydown handler in this build. The hidden <input>
    // backing the field therefore stays empty, and the next form submit
    // fails with `invalid:required`.
    //
    // The fix dispatches Enter on the combobox input after the option click
    // whenever the trigger looks like a searchable/autocomplete combobox.
    // No hostname branching — detection is via aria-autocomplete and React
    // Select's class pattern, so this same commit path benefits Greenhouse,
    // Lever, Ashby, Workday, Intercom, GitLab, etc. equally.
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
    await page.setContent(`
      <style>
        body { margin: 24px; font-family: sans-serif; }
        .field { width: 360px; display: grid; gap: 8px; }
        .select__control {
          border: 1px solid #ccc;
          min-height: 40px;
          display: flex;
          align-items: center;
          padding: 0 12px;
          cursor: text;
          position: relative;
        }
        .select__value-container { flex: 1; display: flex; align-items: center; gap: 4px; }
        .select__single-value { color: #111; }
        .select__placeholder { color: #888; }
        .select__input { border: 0; outline: 0; flex: 1; min-width: 2px; }
        .rs-menu[hidden] { display: none; }
        .rs-menu { border: 1px solid #ccc; margin-top: 4px; padding: 4px 0; }
        .rs-option { padding: 6px 12px; cursor: pointer; }
        .rs-option[data-highlighted="true"] { background: #eef; }
      </style>
      <form id="greenhouse-form">
        <div class="field">
          <label for="auth-input">Are you legally authorized to work in the United States?</label>
          <div
            id="auth-control"
            class="select__control"
            role="combobox"
            aria-haspopup="listbox"
            aria-expanded="false"
            aria-required="true"
            aria-owns="auth-menu"
            tabindex="-1"
          >
            <div class="select__value-container">
              <span id="auth-placeholder" class="select__placeholder">Select...</span>
              <input
                id="auth-input"
                class="select__input"
                role="combobox"
                aria-autocomplete="list"
                aria-expanded="false"
                aria-controls="auth-menu"
                autocomplete="off"
              />
            </div>
          </div>
          <input type="hidden" id="auth-hidden" name="authorized" required aria-invalid="true" value="" />
          <div id="auth-menu" class="rs-menu" role="listbox" hidden>
            <div id="auth-opt-yes" class="rs-option" role="option" data-value="yes">Yes</div>
            <div id="auth-opt-no" class="rs-option" role="option" data-value="no">No</div>
          </div>
        </div>
      </form>
      <script>
        const control = document.getElementById('auth-control')
        const input = document.getElementById('auth-input')
        const menu = document.getElementById('auth-menu')
        const placeholder = document.getElementById('auth-placeholder')
        const hidden = document.getElementById('auth-hidden')
        const valueContainer = control.querySelector('.select__value-container')
        const options = Array.from(menu.querySelectorAll('.rs-option'))
        let highlighted = null

        function highlight(opt) {
          for (const o of options) o.removeAttribute('data-highlighted')
          if (opt) {
            opt.setAttribute('data-highlighted', 'true')
            input.setAttribute('aria-activedescendant', opt.id)
          } else {
            input.removeAttribute('aria-activedescendant')
          }
          highlighted = opt
        }
        function open() {
          if (!menu.hidden) return
          menu.hidden = false
          control.setAttribute('aria-expanded', 'true')
          input.setAttribute('aria-expanded', 'true')
          if (!highlighted) highlight(options[0])
        }
        function close() {
          if (menu.hidden) return
          menu.hidden = true
          control.setAttribute('aria-expanded', 'false')
          input.setAttribute('aria-expanded', 'false')
          highlight(null)
        }
        // The "real" commit path — the ONLY path that updates the hidden
        // input. Production Greenhouse Remix only invokes this from a
        // keyboard Enter handler, which is what this test models.
        function commit(opt) {
          if (!opt) return
          // Render .select__single-value the way react-select does.
          let singleValue = valueContainer.querySelector('.select__single-value')
          if (!singleValue) {
            singleValue = document.createElement('div')
            singleValue.className = 'select__single-value'
            valueContainer.insertBefore(singleValue, placeholder)
          }
          singleValue.textContent = opt.textContent
          placeholder.style.display = 'none'
          hidden.value = opt.getAttribute('data-value')
          hidden.setAttribute('aria-invalid', 'false')
          control.setAttribute('aria-invalid', 'false')
          input.value = ''
          close()
        }

        control.addEventListener('click', (event) => {
          if (event.target.closest('.rs-option')) return
          input.focus()
          if (menu.hidden) open(); else close()
        })

        // Option click path — highlights the option, visually flashes
        // .select__single-value (so display-value heuristics pass), but
        // does NOT call commit(). Only keydown Enter does. This is the
        // exact silent-fail shape Greenhouse ships on the Remix build.
        for (const opt of options) {
          opt.addEventListener('mouseenter', () => highlight(opt))
          opt.addEventListener('click', (event) => {
            event.stopPropagation()
            highlight(opt)
            // Visually reflect selection on the trigger (so the existing
            // aria-invalid / placeholder checks pass) but do NOT touch
            // the hidden input. Form state stays empty.
            let singleValue = valueContainer.querySelector('.select__single-value')
            if (!singleValue) {
              singleValue = document.createElement('div')
              singleValue.className = 'select__single-value'
              valueContainer.insertBefore(singleValue, placeholder)
            }
            singleValue.textContent = opt.textContent
            placeholder.style.display = 'none'
            control.setAttribute('aria-invalid', 'false')
            // Intentionally leave hidden.value and hidden.aria-invalid
            // untouched — this is the broken library behavior the fix
            // has to survive.
            close()
          })
        }

        // Keyboard commit path — real commit. pressEnterToCommitListbox
        // must route through here for the fix to work.
        input.addEventListener('keydown', (event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            if (highlighted) commit(highlighted)
          }
        })
        input.addEventListener('focus', open)
      </script>
    `)

    await pickListboxOption(page, 'Yes', {
      fieldLabel: 'Are you legally authorized to work in the United States?',
      exact: false,
    })

    // The fix must have committed the controlled form state. The hidden
    // input is the source of truth — if it's empty, the form submit would
    // have failed with invalid:required regardless of what the trigger
    // visually shows.
    const hiddenValue = await page.locator('#auth-hidden').inputValue()
    expect(hiddenValue).toBe('yes')
    const ariaInvalid = await page.locator('#auth-hidden').getAttribute('aria-invalid')
    expect(ariaInvalid).toBe('false')
    await page.close()
  }, 60_000)

  it('surfaces selection_not_confirmed when a phone-country combobox visually picks but the required hidden input stays empty', async () => {
    // Regression: JobForge round-2 marathon Airtable PM AI #94. Greenhouse's
    // phone-country combobox (the "+1" picker that sits next to the tel
    // input) had a silent-fail shape that NONE of the existing checks
    // caught:
    //
    //   - aria-invalid is never set on the trigger (Greenhouse only
    //     flips it AFTER the user clicks Submit).
    //   - The trigger visibly shows "+1" so readTriggerShowsPlaceholder
    //     returns false.
    //   - There is NO role=alert / data-error / data-invalid in the field
    //     wrapper (the form hasn't been submitted yet).
    //   - The keyboard-Enter commit path runs but binds to the WRONG
    //     internal state because the country picker uses a different
    //     hidden-input shape than the regular listbox fields.
    //
    // The hidden <input required value=""> is the only authoritative signal
    // that the commit didn't actually land. The original
    // readFormLevelInvalidState gated this signal on `flaggedInWrapper`
    // also being true — which it never is pre-submit. The fix runs the
    // hidden-input check in STRICT mode from postCommitVerify, treating
    // a required+empty hidden input as definitively-not-committed.
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
    await page.setContent(`
      <style>
        body { margin: 24px; font-family: sans-serif; }
        .field { width: 360px; display: grid; gap: 8px; }
        .cc-control { border: 1px solid #ccc; min-height: 40px; display: flex; align-items: center; padding: 0 12px; cursor: pointer; }
        .cc-single-value { color: #111; }
        .cc-placeholder { color: #888; }
        .cc-menu[hidden] { display: none; }
        .cc-menu { border: 1px solid #ccc; margin-top: 4px; padding: 4px 0; }
        .cc-option { padding: 6px 12px; cursor: pointer; }
      </style>
      <form id="airtable-form">
        <div class="field">
          <label for="cc-control">Country</label>
          <div
            id="cc-control"
            class="cc-control"
            role="combobox"
            aria-haspopup="listbox"
            aria-expanded="false"
            aria-required="true"
            tabindex="0"
          >
            <span id="cc-value" class="cc-placeholder">Select...</span>
          </div>
          <!-- Required hidden input that backs the field. The library
               is supposed to write the picked country code here on commit
               but never does — this is the silent-fail shape. -->
          <input id="cc-hidden" type="hidden" name="country" required value="" />
          <div id="cc-menu" class="cc-menu" role="listbox" hidden>
            <div class="cc-option" role="option" data-value="us">United States (+1)</div>
            <div class="cc-option" role="option" data-value="ca">Canada (+1)</div>
            <div class="cc-option" role="option" data-value="gb">United Kingdom (+44)</div>
          </div>
        </div>
        <button type="submit">Submit</button>
      </form>
      <script>
        const control = document.getElementById('cc-control')
        const valueEl = document.getElementById('cc-value')
        const hidden = document.getElementById('cc-hidden')
        const menu = document.getElementById('cc-menu')
        const options = Array.from(menu.querySelectorAll('.cc-option'))

        function open() {
          if (!menu.hidden) return
          menu.hidden = false
          control.setAttribute('aria-expanded', 'true')
        }
        function close() {
          if (menu.hidden) return
          menu.hidden = true
          control.setAttribute('aria-expanded', 'false')
        }

        control.addEventListener('click', (event) => {
          if (event.target.closest('.cc-option')) return
          if (menu.hidden) open(); else close()
        })

        for (const option of options) {
          // Buggy commit path: the option click flashes the visual value
          // and clears the placeholder, but the hidden input is NEVER
          // updated — this is the production bug from Airtable's phone
          // country picker. aria-invalid stays false. No role=alert.
          // Keyboard Enter on the control ALSO doesn't update the hidden
          // input, so the existing pressEnterToCommitListbox path doesn't
          // rescue this case either.
          option.addEventListener('click', (event) => {
            event.stopPropagation()
            valueEl.textContent = option.textContent
            valueEl.classList.remove('cc-placeholder')
            valueEl.classList.add('cc-single-value')
            close()
            // Intentionally leave hidden.value as ''.
          })
        }
      </script>
    `)

    let thrown: Error | null = null
    try {
      await pickListboxOption(page, 'United States (+1)', {
        fieldLabel: 'Country',
        exact: false,
      })
    } catch (error) {
      thrown = error as Error
    }

    // postCommitVerify in strict mode must catch the empty required hidden
    // input even though every other heuristic reports the field looks
    // committed. Without the fix, the call returns silently and the form
    // submit blows up with "Country: Select a country" — exactly what
    // happened on Airtable PM AI #94.
    expect(thrown).not.toBeNull()
    expect(thrown?.message).toContain('selection_not_confirmed')

    // Sanity check: the hidden input is indeed still empty (the fixture is
    // exercising the right failure mode, not a different bug).
    const hiddenValue = await page.locator('#cc-hidden').inputValue()
    expect(hiddenValue).toBe('')
    await page.close()
  }, 60_000)

  it('dispatches framework-visible commit events after a listbox visually updates its hidden input', async () => {
    // Regression for Greenhouse/Twilio-style phone country widgets: the
    // option click updates visible chrome and writes the hidden input value,
    // but the app-level controlled state only updates from the hidden input's
    // change event. Without the generic post-click commit dispatch,
    // pickListboxOption reports success while Submit remains disabled.
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
    await page.setContent(`
      <style>
        body { margin: 24px; font-family: sans-serif; }
        .field { width: 360px; display: grid; gap: 8px; }
        .country-control { border: 1px solid #ccc; min-height: 40px; display: flex; align-items: center; padding: 0 12px; cursor: pointer; }
        .country-single-value { color: #111; }
        .country-placeholder { color: #777; }
        .country-menu[hidden], #country-message[hidden] { display: none; }
        .country-menu { border: 1px solid #ccc; margin-top: 4px; padding: 4px 0; }
        .country-option { padding: 6px 12px; cursor: pointer; }
      </style>
      <form>
        <div class="field">
          <label id="country-label">Country</label>
          <div
            id="country-control"
            class="country-control"
            role="combobox"
            aria-labelledby="country-label"
            aria-haspopup="listbox"
            aria-expanded="false"
            tabindex="0"
          >
            <span id="country-value" class="country-placeholder">Select...</span>
          </div>
          <input id="country-hidden" type="hidden" name="country" required value="" />
          <div id="country-message">Select a country</div>
          <div id="country-menu" class="country-menu" role="listbox" hidden>
            <div class="country-option" role="option" data-value="US">United States (+1)</div>
            <div class="country-option" role="option" data-value="CA">Canada (+1)</div>
          </div>
        </div>
        <button id="submit" type="submit" disabled>Submit</button>
      </form>
      <script>
        const control = document.getElementById('country-control')
        const valueEl = document.getElementById('country-value')
        const hidden = document.getElementById('country-hidden')
        const message = document.getElementById('country-message')
        const submit = document.getElementById('submit')
        const menu = document.getElementById('country-menu')
        const options = Array.from(menu.querySelectorAll('.country-option'))
        const nativeValueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
        let countryState = ''

        function render() {
          submit.disabled = countryState === ''
          message.hidden = countryState !== ''
        }
        function open() {
          menu.hidden = false
          control.setAttribute('aria-expanded', 'true')
        }
        function close() {
          menu.hidden = true
          control.setAttribute('aria-expanded', 'false')
        }

        control.addEventListener('click', open)
        hidden.addEventListener('change', () => {
          countryState = hidden.value
          render()
        })
        for (const option of options) {
          option.addEventListener('click', (event) => {
            event.stopPropagation()
            valueEl.textContent = option.textContent
            valueEl.classList.remove('country-placeholder')
            valueEl.classList.add('country-single-value')
            nativeValueSetter.call(hidden, option.getAttribute('data-value'))
            close()
          })
        }
        render()
      </script>
    `)

    await pickListboxOption(page, 'United States', {
      fieldLabel: 'Country',
      exact: false,
    })

    expect(await page.locator('#country-hidden').inputValue()).toBe('US')
    expect(await page.locator('#submit').isDisabled()).toBe(false)
    expect(await page.locator('#country-message').isHidden()).toBe(true)
    await page.close()
  }, 60_000)

  it('opens a GitHub-Primer-style menu trigger whose accessible name is the current value, not the field name', async () => {
    // Regression: GitHub's "Add deployment branch or tag rule" dialog (and
    // many Primer-based admin UIs) renders dropdowns as
    //   <label>Ref type</label>
    //   <button aria-haspopup="menu">Branch</button>
    //   <div role="menu">
    //     <div role="menuitemradio">Branch</div>
    //     <div role="menuitemradio">Tag</div>
    //   </div>
    // The button's accessible name is the current value ("Branch"), NOT
    // "Ref type", so Playwright's role+name lookup misses it. The container-
    // label fallback in findLabeledControlInPage walks the parent chain to
    // match on visible label text ("Ref type"), then returns the trigger.
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
    await page.setContent(`
      <style>
        body { margin: 24px; font-family: sans-serif; }
        .field { width: 360px; position: relative; display: grid; gap: 4px; }
        #trigger { width: 100%; min-height: 40px; text-align: left; }
        #menu[hidden] { display: none; }
        #menu { border: 1px solid #ccc; margin-top: 6px; padding: 8px; display: grid; gap: 6px; }
        [role="menuitemradio"] { padding: 6px; cursor: pointer; }
      </style>
      <div class="field">
        <span>Ref type</span>
        <button id="trigger" type="button" aria-haspopup="menu" aria-expanded="false">Branch</button>
        <div id="menu" role="menu" hidden>
          <div role="menuitemradio" aria-checked="true" data-value="branch">Branch</div>
          <div role="menuitemradio" aria-checked="false" data-value="tag">Tag</div>
        </div>
      </div>
      <script>
        const trigger = document.getElementById('trigger')
        const menu = document.getElementById('menu')
        trigger.addEventListener('click', () => {
          menu.hidden = false
          trigger.setAttribute('aria-expanded', 'true')
        })
        for (const option of menu.querySelectorAll('[role="menuitemradio"]')) {
          option.addEventListener('click', () => {
            trigger.textContent = option.textContent
            for (const sibling of menu.querySelectorAll('[role="menuitemradio"]')) {
              sibling.setAttribute('aria-checked', 'false')
            }
            option.setAttribute('aria-checked', 'true')
            menu.hidden = true
            trigger.setAttribute('aria-expanded', 'false')
          })
        }
      </script>
    `)

    await pickListboxOption(page, 'Tag', {
      fieldLabel: 'Ref type',
      exact: true,
    })

    expect(await page.locator('#trigger').textContent()).toBe('Tag')
    await page.close()
  })

  it('matches "Ref type:" container labels with a trailing colon', async () => {
    // GitHub's rendered text is often "Ref type:" (with a colon) rather than
    // "Ref type". The container-label normalizer strips a trailing colon so
    // the caller can pass either form.
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
    await page.setContent(`
      <style>
        body { margin: 24px; font-family: sans-serif; }
        #container { display: flex; gap: 8px; align-items: center; }
        #menu[hidden] { display: none; }
      </style>
      <div id="container">
        <span>Ref type:</span>
        <button id="trigger" type="button" aria-haspopup="menu" aria-expanded="false">Branch</button>
      </div>
      <div id="menu" role="menu" hidden>
        <div role="menuitemradio" data-value="tag">Tag</div>
      </div>
      <script>
        const trigger = document.getElementById('trigger')
        const menu = document.getElementById('menu')
        trigger.addEventListener('click', () => { menu.hidden = false })
        for (const option of menu.querySelectorAll('[role="menuitemradio"]')) {
          option.addEventListener('click', () => {
            trigger.textContent = option.textContent
            menu.hidden = true
          })
        }
      </script>
    `)

    await pickListboxOption(page, 'Tag', {
      fieldLabel: 'Ref type',
      exact: true,
    })

    expect(await page.locator('#trigger').textContent()).toBe('Tag')
    await page.close()
  })

  it('returns visible options in the failure payload when no custom dropdown option matches', async () => {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
    await page.setContent(`
      <style>
        body { margin: 24px; font-family: sans-serif; }
        .field { width: 360px; position: relative; }
        #trigger { width: 100%; min-height: 44px; text-align: left; }
        #menu[hidden] { display: none; }
        #menu { border: 1px solid #ccc; margin-top: 6px; padding: 8px; display: grid; gap: 6px; }
      </style>
      <div class="field">
        <label>Location</label>
        <button id="trigger" type="button" aria-haspopup="listbox">Select location</button>
        <div id="menu" role="listbox" hidden>
          <div role="option">Austin, TX</div>
          <div role="option">Boston, MA</div>
        </div>
      </div>
      <script>
        const trigger = document.getElementById('trigger')
        const menu = document.getElementById('menu')
        trigger.addEventListener('click', () => {
          menu.hidden = false
        })
      </script>
    `)

    let thrown: Error | null = null
    try {
      await pickListboxOption(page, 'Berlin, Germany', {
        fieldLabel: 'Location',
        exact: false,
      })
    } catch (error) {
      thrown = error as Error
    }

    expect(thrown).toBeTruthy()
    const payload = JSON.parse(thrown!.message) as Record<string, unknown>
    expect(payload).toMatchObject({
      error: 'listboxPick',
      reason: 'no_visible_option_match',
      fieldLabel: 'Location',
      requestedLabel: 'Berlin, Germany',
      visibleOptionCount: 2,
      visibleOptions: ['Austin, TX', 'Boston, MA'],
    })
    await page.close()
  })
})

describe('attachFiles', () => {
  let browser: Browser

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true })
  })

  afterAll(async () => {
    await browser.close()
  })

  it('targets a labeled file input instead of the first matching control', async () => {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
    const tempFile = join(tmpdir(), `geometra-upload-${Date.now()}.txt`)
    await writeFile(tempFile, 'resume')

    await page.setContent(`
      <div style="display:grid;gap:16px;width:420px;margin:24px;font-family:sans-serif;">
        <div>
          <label for="resume-input">Resume</label>
          <input id="resume-input" type="file" />
        </div>
        <div>
          <label for="cover-input">Cover Letter</label>
          <input id="cover-input" type="file" />
        </div>
      </div>
    `)

    try {
      await attachFiles(page, [tempFile], {
        fieldLabel: 'Resume',
      })

      const result = await page.evaluate(() => ({
        resume: (document.getElementById('resume-input') as HTMLInputElement).files?.length ?? 0,
        cover: (document.getElementById('cover-input') as HTMLInputElement).files?.length ?? 0,
      }))

      expect(result).toEqual({ resume: 1, cover: 0 })
    } finally {
      await rm(tempFile, { force: true })
      await page.close()
    }
  })

  it('prefers an exact label match over a substring collision when caller passed exact=false', async () => {
    // Regression: a file input labeled exactly "Resume" must not be hijacked
    // by another file input whose label *contains* the substring "resume"
    // (e.g. "Please attach your resume below as well"). The original
    // findLabeledControl bug had the same shape — getByLabel(..., {exact:false})
    // returned the wrong control. attachFiles' helper now tries exact first.
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
    const tempFile = join(tmpdir(), `geometra-upload-collision-${Date.now()}.txt`)
    await writeFile(tempFile, 'resume')

    await page.setContent(`
      <div style="display:grid;gap:16px;width:520px;margin:24px;font-family:sans-serif;">
        <div>
          <label for="extra-input">Please attach your resume below as well</label>
          <input id="extra-input" type="file" />
        </div>
        <div>
          <label for="resume-input">Resume</label>
          <input id="resume-input" type="file" />
        </div>
      </div>
    `)

    try {
      await attachFiles(page, [tempFile], { fieldLabel: 'Resume' })

      const result = await page.evaluate(() => ({
        resume: (document.getElementById('resume-input') as HTMLInputElement).files?.length ?? 0,
        extra: (document.getElementById('extra-input') as HTMLInputElement).files?.length ?? 0,
      }))

      expect(result).toEqual({ resume: 1, extra: 0 })
    } finally {
      await rm(tempFile, { force: true })
      await page.close()
    }
  })
})

describe('setFieldText', () => {
  let browser: Browser

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true })
  })

  afterAll(async () => {
    await browser.close()
  })

  it('fills a labeled text field semantically', async () => {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
    await page.setContent(`
      <div style="display:grid;gap:12px;width:320px;margin:24px;font-family:sans-serif;">
        <label for="full-name">Full name</label>
        <input id="full-name" />
      </div>
    `)

    await setFieldText(page, 'Full name', 'Taylor Applicant')

    expect(await page.locator('#full-name').inputValue()).toBe('Taylor Applicant')
    await page.close()
  })

  it('prefers an exact label match over a substring collision when caller passed exact=false', async () => {
    // Regression: a text input labeled exactly "Country" must not be
    // hijacked by another input whose label *contains* the substring
    // "country" (e.g. the original Greenhouse case where work-auth's
    // "Are you legally authorized to work in the country in which you
    // are applying?" stole fills targeted at the Country field).
    // findLabeledEditableField now tries exact-match candidates first
    // even when the caller passed exact=false.
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
    await page.setContent(`
      <div style="display:grid;gap:16px;width:520px;margin:24px;font-family:sans-serif;">
        <label>
          Are you legally authorized to work in the country in which you are applying?
          <input id="work-auth" />
        </label>
        <label>
          Country
          <input id="country" />
        </label>
      </div>
    `)

    await setFieldText(page, 'Country', 'United States')

    expect(await page.locator('#country').inputValue()).toBe('United States')
    expect(await page.locator('#work-auth').inputValue()).toBe('')
    await page.close()
  })

  it('fills a placeholder-only text field semantically', async () => {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
    await page.setContent(`
      <div style="display:grid;gap:12px;width:320px;margin:24px;font-family:sans-serif;">
        <input id="username" placeholder="Username" />
      </div>
    `)

    await setFieldText(page, 'Username', 'standard_user')

    expect(await page.locator('#username').inputValue()).toBe('standard_user')
    await page.close()
  })
})

describe('setFieldChoice', () => {
  let browser: Browser

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true })
  })

  afterAll(async () => {
    await browser.close()
  })

  it('selects a native select by field label', async () => {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
    await page.setContent(`
      <div style="display:grid;gap:12px;width:320px;margin:24px;font-family:sans-serif;">
        <label for="country">Country</label>
        <select id="country">
          <option value="">Choose</option>
          <option value="de">Germany</option>
          <option value="us">United States</option>
        </select>
      </div>
    `)

    await setFieldChoice(page, 'Country', 'Germany')

    expect(await page.locator('#country').inputValue()).toBe('de')
    await page.close()
  })

  it('chooses repeated yes/no answers by question label', async () => {
    const page = await browser.newPage({ viewport: { width: 900, height: 900 } })
    await page.setContent(`
      <style>
        body { margin: 24px; font-family: sans-serif; }
        fieldset { margin-bottom: 18px; }
      </style>
      <fieldset id="question-a">
        <legend>Are you legally authorized to work here?</legend>
        <label><input type="radio" name="auth" value="yes" /> Yes</label>
        <label><input type="radio" name="auth" value="no" /> No</label>
      </fieldset>
      <fieldset id="question-b">
        <legend>Will you require sponsorship?</legend>
        <label><input type="radio" name="sponsor" value="yes" /> Yes</label>
        <label><input type="radio" name="sponsor" value="no" /> No</label>
      </fieldset>
    `)

    await setFieldChoice(page, 'Will you require sponsorship?', 'No', { choiceType: 'group' })

    expect(await page.locator('#question-a input[value="yes"]').isChecked()).toBe(false)
    expect(await page.locator('#question-a input[value="no"]').isChecked()).toBe(false)
    expect(await page.locator('#question-b input[value="yes"]').isChecked()).toBe(false)
    expect(await page.locator('#question-b input[value="no"]').isChecked()).toBe(true)
    await page.close()
  })

  it('fails grouped choices without taking the listbox path when a group hint is provided', async () => {
    const page = await browser.newPage({ viewport: { width: 900, height: 900 } })
    await page.setContent(`
      <style>
        body { margin: 24px; font-family: sans-serif; }
      </style>
      <fieldset id="question-a">
        <legend>Will you require sponsorship?</legend>
        <label><input type="radio" name="sponsor" value="yes" /> Yes</label>
        <label><input type="radio" name="sponsor" value="no" /> No</label>
      </fieldset>
    `)

    await expect(
      setFieldChoice(page, 'Will you require sponsorship?', 'Maybe', { choiceType: 'group' }),
    ).rejects.toThrow('no grouped choice matching "Maybe"')

    await page.close()
  })
})

describe('wheelAt', () => {
  let browser: Browser

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true })
  })

  afterAll(async () => {
    await browser.close()
  })

  it('scrolls the page root when no target coordinates are provided', async () => {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
    await page.setContent(`
      <style>
        body { margin: 0; }
        #spacer { height: 2200px; background: linear-gradient(#fff, #ddd); }
        #inner { width: 260px; height: 120px; overflow: auto; margin: 24px; border: 1px solid #ccc; }
        #inner-content { height: 600px; }
      </style>
      <div id="inner"><div id="inner-content"></div></div>
      <div id="spacer"></div>
    `)

    await wheelAt(page, 0, 480)

    const result = await page.evaluate(() => ({
      pageY: window.scrollY,
      innerY: (document.getElementById('inner') as HTMLElement).scrollTop,
    }))

    expect(result.pageY).toBeGreaterThan(0)
    expect(result.innerY).toBe(0)
    await page.close()
  })

  it('targets the nearest scroll container when coordinates are provided', async () => {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
    await page.setContent(`
      <style>
        body { margin: 0; }
        #spacer { height: 1800px; background: linear-gradient(#fff, #ddd); }
        #inner { width: 320px; height: 140px; overflow: auto; margin: 24px; border: 1px solid #ccc; }
        #inner-content { height: 800px; }
      </style>
      <div id="inner"><div id="inner-content"></div></div>
      <div id="spacer"></div>
    `)

    const box = await page.locator('#inner').boundingBox()
    if (!box) throw new Error('expected #inner bounding box')

    await wheelAt(page, 0, 260, Math.round(box.x + box.width / 2), Math.round(box.y + box.height / 2))

    const result = await page.evaluate(() => ({
      pageY: window.scrollY,
      innerY: (document.getElementById('inner') as HTMLElement).scrollTop,
    }))

    expect(result.innerY).toBeGreaterThan(0)
    expect(result.pageY).toBe(0)
    await page.close()
  })
})

describe('fillFields auto', () => {
  let browser: Browser

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true })
  })

  afterAll(async () => {
    await browser.close()
  })

  it('fills native text, select, checkbox, and grouped radio fields from labels without prior schema hints', async () => {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
    await page.setContent(`
      <style>
        body { margin: 24px; font-family: sans-serif; display: grid; gap: 16px; width: 420px; }
        label, fieldset { display: grid; gap: 8px; }
      </style>
      <label>
        Full name
        <input id="full-name" />
      </label>
      <label>
        Preferred location
        <select id="location">
          <option value="">Choose one</option>
          <option>Berlin, Germany</option>
          <option>London, United Kingdom</option>
        </select>
      </label>
      <label>
        Share my profile for future roles
        <input id="share-profile" type="checkbox" />
      </label>
      <fieldset>
        <legend>Will you now or in the future require sponsorship?</legend>
        <label><input type="radio" name="sponsor" value="yes" /> Yes</label>
        <label><input type="radio" name="sponsor" value="no" /> No</label>
      </fieldset>
      <fieldset>
        <legend>Can you work a hybrid schedule in Berlin three days a week?</legend>
        <label><input type="radio" name="hybrid" value="yes" /> Yes</label>
        <label><input type="radio" name="hybrid" value="no" /> No</label>
      </fieldset>
    `)

    await fillFields(page, [
      { kind: 'auto', fieldLabel: 'Full name', value: 'Taylor Applicant' },
      { kind: 'auto', fieldLabel: 'Preferred location', value: 'Berlin, Germany' },
      { kind: 'auto', fieldLabel: 'Share my profile for future roles', value: true },
      { kind: 'auto', fieldLabel: 'Will you now or in the future require sponsorship?', value: false },
      { kind: 'auto', fieldLabel: 'Can you work a hybrid schedule in Berlin three days a week?', value: 'No' },
    ])

    const result = await page.evaluate(() => ({
      fullName: (document.getElementById('full-name') as HTMLInputElement).value,
      location: (document.getElementById('location') as HTMLSelectElement).value,
      shareProfile: (document.getElementById('share-profile') as HTMLInputElement).checked,
      sponsorshipNo: (document.querySelector('input[name="sponsor"][value="no"]') as HTMLInputElement).checked,
      hybridNo: (document.querySelector('input[name="hybrid"][value="no"]') as HTMLInputElement).checked,
    }))

    expect(result).toEqual({
      fullName: 'Taylor Applicant',
      location: 'Berlin, Germany',
      shareProfile: true,
      sponsorshipNo: true,
      hybridNo: true,
    })
    await page.close()
  })

  it('commits checkbox-backed grouped choices through framework-visible change events', async () => {
    // Regression for Greenhouse/Betterment-style checkbox pairs that model a
    // binary answer. A low-level click can move the DOM checked bit while the
    // app's controlled state remains unset. fillFields must not report success
    // until the underlying input receives the input/change events validators
    // listen for.
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
    await page.setContent(`
      <style>
        body { margin: 24px; font-family: sans-serif; }
        fieldset { display: grid; gap: 8px; width: 420px; }
        .choice { display: flex; gap: 8px; align-items: center; }
      </style>
      <form>
        <fieldset>
          <legend>Will you require sponsorship?</legend>
          <div class="choice"><input id="sponsor-yes" type="checkbox" aria-label="Yes" value="yes" /> <span>Yes</span></div>
          <div class="choice"><input id="sponsor-no" type="checkbox" aria-label="No" value="no" /> <span>No</span></div>
        </fieldset>
        <button id="submit" type="submit" disabled>Submit</button>
      </form>
      <script>
        const yes = document.getElementById('sponsor-yes')
        const no = document.getElementById('sponsor-no')
        const submit = document.getElementById('submit')
        const nativeCheckedSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked').set
        let answer = null

        function render() {
          yes.checked = answer === 'yes'
          no.checked = answer === 'no'
          submit.disabled = answer === null
        }
        for (const input of [yes, no]) {
          input._valueTracker = {
            value: 'false',
            setValue(value) { this.value = value }
          }
          input.addEventListener('change', (event) => {
            const next = String(event.target.checked)
            if (event.target._valueTracker.value === next) return
            event.target._valueTracker.setValue(next)
            answer = event.target.value
            render()
          })
        }
        no.click = function() {
          nativeCheckedSetter.call(no, true)
        }
        render()
      </script>
    `)

    await fillFields(page, [
      { kind: 'choice', fieldLabel: 'Will you require sponsorship?', value: 'No', choiceType: 'group' },
    ])

    const result = await page.evaluate(() => ({
      yes: (document.getElementById('sponsor-yes') as HTMLInputElement).checked,
      no: (document.getElementById('sponsor-no') as HTMLInputElement).checked,
      submitDisabled: (document.getElementById('submit') as HTMLButtonElement).disabled,
    }))
    expect(result).toEqual({ yes: false, no: true, submitDisabled: false })
    await page.close()
  })

  it('commits setCheckedControl through framework-visible change events', async () => {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
    await page.setContent(`
      <input id="share-profile" type="checkbox" aria-label="Share my profile" />
      <span>Share my profile</span>
      <div id="state">off</div>
      <script>
        const checkbox = document.getElementById('share-profile')
        const state = document.getElementById('state')
        const nativeCheckedSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked').set
        checkbox._valueTracker = {
          value: 'false',
          setValue(value) { this.value = value }
        }
        checkbox.addEventListener('change', () => {
          const next = String(checkbox.checked)
          if (checkbox._valueTracker.value === next) return
          checkbox._valueTracker.setValue(next)
          state.textContent = checkbox.checked ? 'on' : 'off'
        })
        checkbox.click = function() {
          nativeCheckedSetter.call(checkbox, true)
        }
      </script>
    `)

    await setCheckedControl(page, 'Share my profile', { checked: true, controlType: 'checkbox' })

    expect(await page.locator('#share-profile').isChecked()).toBe(true)
    expect(await page.locator('#state').textContent()).toBe('on')
    await page.close()
  })

  it('refuses to silently mark a button-shaped group radio as committed when the click is a structural no-op', async () => {
    // Regression: JobForge round-2 marathon Pinecone Sr SWE Database Team
    // #320 / LangChain SE Manager #325. Pinecone's Ashby form re-renders
    // with a shifted field-id prefix on submit-failure, wiping the
    // selected sponsorship/pronouns radio buttons. The buttons are
    // <button> elements (not <input type="radio">), so the native batch
    // fill's setGroupedChoice path was returning true unconditionally
    // after the click — masking the silent-fail mode.
    //
    // The fix snapshots a selection signature (aria-checked / aria-pressed
    // / data-state / className / etc.) before and after the click. If
    // nothing changes, the click was a structural no-op and the function
    // returns false so fillFields' higher-level fallback can take over.
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
    await page.setContent(`
      <style>
        body { margin: 24px; font-family: sans-serif; }
        [role="radiogroup"] { display: flex; gap: 8px; }
        [role="radio"] { padding: 8px 16px; border: 1px solid #ccc; cursor: pointer; }
      </style>
      <form>
        <div id="sponsorship-label">Will you require sponsorship?</div>
        <div role="radiogroup" aria-labelledby="sponsorship-label">
          <button type="button" role="radio" aria-checked="false" id="sponsor-yes">Yes</button>
          <button type="button" role="radio" aria-checked="false" id="sponsor-no">No</button>
        </div>
      </form>
      <script>
        // Simulate the Pinecone re-render bug: clicking a button briefly
        // sets aria-checked, but a synchronous form re-render in the same
        // tick wipes it back to false. The structural signature ends up
        // identical before and after the click. This is the silent-fail
        // mode the fix has to detect.
        const buttons = document.querySelectorAll('[role="radio"]')
        for (const btn of buttons) {
          btn.addEventListener('click', () => {
            // Simulate "set then immediately reset" by re-asserting
            // aria-checked=false synchronously after the React state
            // would have updated it.
            btn.setAttribute('aria-checked', 'false')
          })
        }
      </script>
    `)

    let thrown: Error | null = null
    try {
      await fillFields(page, [
        { kind: 'choice', fieldLabel: 'Will you require sponsorship?', value: 'No', choiceType: 'group' },
      ])
    } catch (error) {
      thrown = error as Error
    }

    // The fix must surface the failure — either by throwing from fillFields
    // or by leaving aria-checked at false (so the caller doesn't
    // optimistically advance to a submit that will fail).
    const ariaChecked = await page.locator('#sponsor-no').getAttribute('aria-checked')
    expect(ariaChecked).toBe('false')
    expect(thrown).not.toBeNull()
    await page.close()
  })

  it('commits a button-shaped group radio when the click DOES update the selection signature', async () => {
    // Sibling test to the regression above. When a button-shaped group
    // radio actually toggles its aria-checked attribute on click (the
    // happy path — most well-behaved Ashby forms), fillFields must
    // succeed without unnecessary fallbacks. This guards against the
    // verification check being too aggressive and rejecting legitimate
    // commits.
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
    await page.setContent(`
      <style>
        body { margin: 24px; font-family: sans-serif; }
        [role="radiogroup"] { display: flex; gap: 8px; }
        [role="radio"] { padding: 8px 16px; border: 1px solid #ccc; cursor: pointer; }
      </style>
      <form>
        <div id="hybrid-label">Are you available 5 days in office?</div>
        <div role="radiogroup" aria-labelledby="hybrid-label">
          <button type="button" role="radio" aria-checked="false" id="hybrid-yes">Yes</button>
          <button type="button" role="radio" aria-checked="false" id="hybrid-no">No</button>
        </div>
      </form>
      <script>
        const buttons = Array.from(document.querySelectorAll('[role="radio"]'))
        for (const btn of buttons) {
          btn.addEventListener('click', () => {
            for (const sib of buttons) sib.setAttribute('aria-checked', 'false')
            btn.setAttribute('aria-checked', 'true')
          })
        }
      </script>
    `)

    await fillFields(page, [
      { kind: 'choice', fieldLabel: 'Are you available 5 days in office?', value: 'Yes', choiceType: 'group' },
    ])

    const yesChecked = await page.locator('#hybrid-yes').getAttribute('aria-checked')
    const noChecked = await page.locator('#hybrid-no').getAttribute('aria-checked')
    expect(yesChecked).toBe('true')
    expect(noChecked).toBe('false')
    await page.close()
  })

  it('recovers from a truncated label (U+2026 ellipsis) by stripping and retrying', async () => {
    // Regression: geometra_form_schema truncates long labels to ~80 chars
    // and marks the truncation with a Unicode U+2026 ellipsis. When the MCP
    // fill_form path plans a fill using those schema labels, the proxy's
    // findLabeledControlInPage / findLabeledEditableField then has to match
    // a truncated label against the full DOM text — substring matching only
    // works if the ellipsis is stripped first. Before the v1.40.0 fix, this
    // failed silently for choice fields (listbox stayed at placeholder) and
    // threw for text fields ("no visible editable field matching ...").
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
    await page.setContent(`
      <style>
        body { margin: 24px; font-family: sans-serif; display: grid; gap: 16px; width: 600px; }
        label { display: grid; gap: 8px; }
      </style>
      <label>
        What is the address from which you plan on working? If you would need to relocate, please type "relocating" followed by your target city.
        <input id="work-address" />
      </label>
      <label>
        Will you now or will you in the future require employment visa sponsorship to work in the country in which you are applying?
        <input id="visa-sponsor" />
      </label>
    `)

    // The ellipsis labels here mimic exactly what Geometra's schema
    // truncation produces — the first ~80 chars followed by U+2026.
    await fillFields(page, [
      { kind: 'text', fieldLabel: 'What is the address from which you plan on working? If you would need to reloca\u2026', value: 'Austin, Texas' },
      { kind: 'text', fieldLabel: 'Will you now or will you in the future require employment visa sponsorship to w\u2026', value: 'yes' },
    ])

    const result = await page.evaluate(() => ({
      address: (document.getElementById('work-address') as HTMLInputElement).value,
      visa: (document.getElementById('visa-sponsor') as HTMLInputElement).value,
    }))

    expect(result).toEqual({
      address: 'Austin, Texas',
      visa: 'yes',
    })
    await page.close()
  })

  it('completes choice fills even when an earlier text fill rejects (no fail-fast cascade)', async () => {
    // Regression: fillFields used to run text fills in parallel via
    // Promise.all and the FIRST rejection aborted the whole batch — so any
    // subsequent choice fills never ran. On Greenhouse Anthropic forms this
    // manifested as the visa/AI Policy comboboxes staying at placeholder
    // even though they would have committed cleanly if the text fill order
    // had been different. v1.40.0 switches text fills to allSettled and
    // keeps the choice fill loop running regardless.
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
    await page.setContent(`
      <style>
        body { margin: 24px; font-family: sans-serif; display: grid; gap: 16px; width: 420px; }
        label, fieldset { display: grid; gap: 8px; }
      </style>
      <label>
        Legitimate field
        <input id="legit" />
      </label>
      <fieldset>
        <legend>Choice question</legend>
        <label><input type="radio" name="choice" value="yes" /> Yes</label>
        <label><input type="radio" name="choice" value="no" /> No</label>
      </fieldset>
    `)

    let thrown: Error | null = null
    try {
      await fillFields(page, [
        { kind: 'text', fieldLabel: 'Legitimate field', value: 'ok' },
        // This text field does not exist. Before v1.40.0, its rejection
        // inside Promise.all would abort the whole batch and the choice
        // below would never run.
        { kind: 'text', fieldLabel: 'Field that does not exist anywhere on the page', value: 'also ok' },
        { kind: 'choice', fieldLabel: 'Choice question', value: 'No' },
      ])
    } catch (e) {
      thrown = e as Error
    }

    // fillFields still throws at the end to surface the partial failure...
    expect(thrown).not.toBeNull()
    expect(thrown?.message).toContain('Field that does not exist')

    // ...but the legitimate text AND the choice both committed.
    const legitValue = await page.evaluate(() =>
      (document.getElementById('legit') as HTMLInputElement).value,
    )
    expect(legitValue).toBe('ok')

    const choiceCommitted = await page.evaluate(() =>
      (document.querySelector('input[name="choice"][value="no"]') as HTMLInputElement).checked,
    )
    expect(choiceCommitted).toBe(true)
    await page.close()
  })

  it('fills placeholder-labeled text inputs in one batch', async () => {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
    await page.setContent(`
      <style>
        body { margin: 24px; font-family: sans-serif; display: grid; gap: 16px; width: 320px; }
      </style>
      <input id="username" placeholder="Username" />
      <input id="password" placeholder="Password" type="password" />
      <input id="first-name" placeholder="First Name" />
      <input id="postal-code" placeholder="Zip/Postal Code" />
    `)

    await fillFields(page, [
      { kind: 'text', fieldLabel: 'Username', value: 'standard_user' },
      { kind: 'text', fieldLabel: 'Password', value: 'secret_sauce' },
      { kind: 'text', fieldLabel: 'First Name', value: 'Taylor' },
      { kind: 'text', fieldLabel: 'Zip/Postal Code', value: '10001' },
    ])

    const result = await page.evaluate(() => ({
      username: (document.getElementById('username') as HTMLInputElement).value,
      password: (document.getElementById('password') as HTMLInputElement).value,
      firstName: (document.getElementById('first-name') as HTMLInputElement).value,
      postalCode: (document.getElementById('postal-code') as HTMLInputElement).value,
    }))

    expect(result).toEqual({
      username: 'standard_user',
      password: 'secret_sauce',
      firstName: 'Taylor',
      postalCode: '10001',
    })
    await page.close()
  })
})

// ── Bug #2 (v1.43): fillOtp primitive for multi-cell OTP widgets ────────
describe('fillOtp', () => {
  let browser: Browser

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true })
  })

  afterAll(async () => {
    await browser.close()
  })

  const OTP_PAGE_HTML = `
    <style>
      body { margin: 24px; font-family: sans-serif; }
      form { display: grid; gap: 12px; max-width: 520px; }
      .otp { display: flex; gap: 8px; }
      .otp input {
        width: 40px;
        height: 48px;
        text-align: center;
        font-size: 20px;
        border: 1px solid #ccc;
      }
    </style>
    <form>
      <label for="cell-0">Security code</label>
      <div class="otp" data-otp>
        <input id="cell-0" maxlength="1" type="text" />
        <input id="cell-1" maxlength="1" type="text" />
        <input id="cell-2" maxlength="1" type="text" />
        <input id="cell-3" maxlength="1" type="text" />
        <input id="cell-4" maxlength="1" type="text" />
        <input id="cell-5" maxlength="1" type="text" />
        <input id="cell-6" maxlength="1" type="text" />
        <input id="cell-7" maxlength="1" type="text" />
      </div>
      <button type="submit">Verify</button>
    </form>
    <script>
      // Simulate the React-style per-cell onKeyDown auto-advance handler.
      // When a user types a char into cell N, focus moves to cell N+1.
      const cells = Array.from(document.querySelectorAll('.otp input'))
      cells.forEach((cell, index) => {
        cell.addEventListener('input', () => {
          if (cell.value.length > 0 && index < cells.length - 1) {
            cells[index + 1].focus()
          }
        })
      })
    </script>
  `

  it('auto-detects an 8-cell OTP group and types char-by-char with focus auto-advance', async () => {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
    await page.setContent(OTP_PAGE_HTML)

    const result = await fillOtp(page, '81234567', { fieldLabel: 'Security code' })
    expect(result.cellCount).toBe(8)
    expect(result.filledCount).toBe(8)

    const readback = await page.evaluate(() => {
      const cells = Array.from(document.querySelectorAll<HTMLInputElement>('.otp input'))
      return cells.map(cell => cell.value)
    })
    // Each cell must hold exactly one corresponding char.
    expect(readback).toEqual(['8', '1', '2', '3', '4', '5', '6', '7'])
    await page.close()
  })

  it('routes a setFieldText call labeled "Security code" through the OTP path automatically', async () => {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
    await page.setContent(OTP_PAGE_HTML)

    // The caller uses the plain setFieldText API — no mention of OTP.
    // The label hint `Security code` + 8-char no-whitespace value should
    // auto-route to fillOtp under the hood.
    await setFieldText(page, 'Security code', '12345678')

    const readback = await page.evaluate(() => {
      const cells = Array.from(document.querySelectorAll<HTMLInputElement>('.otp input'))
      return cells.map(cell => cell.value)
    })
    expect(readback).toEqual(['1', '2', '3', '4', '5', '6', '7', '8'])
    await page.close()
  })

  it('routes a fillFields text field labeled "Verification code" through the OTP path automatically', async () => {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
    await page.setContent(OTP_PAGE_HTML.replace('Security code', 'Verification code'))

    await fillFields(page, [
      { kind: 'text', fieldLabel: 'Verification code', value: '99887766' },
    ])

    const readback = await page.evaluate(() => {
      const cells = Array.from(document.querySelectorAll<HTMLInputElement>('.otp input'))
      return cells.map(cell => cell.value)
    })
    expect(readback).toEqual(['9', '9', '8', '8', '7', '7', '6', '6'])
    await page.close()
  })

  it('throws a per-cell readback-mismatch error when only some cells fail to commit', async () => {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
    // Build an OTP-like widget whose 2nd cell rewrites whatever is typed
    // to "X" — first cell takes the char, second cell is corrupted, third
    // takes the char. Produces a partial mismatch (not all empty), which
    // should hit the per-cell readback-mismatch error path rather than
    // the "all cells empty" diagnostic.
    await page.setContent(`
      <div class="otp" data-otp>
        <input id="c0" maxlength="1" type="text" />
        <input id="c1" maxlength="1" type="text" />
        <input id="c2" maxlength="1" type="text" />
      </div>
      <script>
        const cells = Array.from(document.querySelectorAll('.otp input'))
        cells.forEach((cell, idx) => {
          cell.addEventListener('input', () => {
            if (cell.value.length > 0 && idx < cells.length - 1) cells[idx + 1].focus()
          })
        })
        // Cell 1 corrupts its value to "X" after the input event runs.
        cells[1].addEventListener('input', () => {
          queueMicrotask(() => { cells[1].value = 'X' })
        })
      </script>
    `)

    await expect(fillOtp(page, '123')).rejects.toThrow(/readback mismatch/i)
    await page.close()
  })

  it('refuses to run when the cell group is smaller than the typed value length', async () => {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
    await page.setContent(`
      <div class="otp">
        <input id="c0" maxlength="1" type="text" />
        <input id="c1" maxlength="1" type="text" />
        <input id="c2" maxlength="1" type="text" />
      </div>
    `)

    await expect(fillOtp(page, '12345')).rejects.toThrow(/no OTP box group found/)
    await page.close()
  })

  // Regression: JobForge round-2 marathon Glean ML Engineer #174 — second
  // fill_otp call after a stale-OTP submit failure left the form re-rendered
  // with new cells, but the second call reported success while populating
  // zero cells. Ensure a re-render between calls is handled by re-detection.
  it('handles a full form re-render between fillOtp calls (re-detects fresh cells)', async () => {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
    await page.setContent(OTP_PAGE_HTML)

    // First call fills the original cells.
    const first = await fillOtp(page, '11111111', { fieldLabel: 'Security code' })
    expect(first.filledCount).toBe(8)

    // Simulate a Greenhouse-style re-render: blow away the form and put
    // a fresh one in its place. The new cells have NO geometra-otp marker
    // and a new auto-advance handler.
    await page.evaluate(() => {
      document.body.innerHTML = `
        <form>
          <label for="cell-0">Security code</label>
          <div class="otp" data-otp>
            <input id="cell-0" maxlength="1" type="text" />
            <input id="cell-1" maxlength="1" type="text" />
            <input id="cell-2" maxlength="1" type="text" />
            <input id="cell-3" maxlength="1" type="text" />
            <input id="cell-4" maxlength="1" type="text" />
            <input id="cell-5" maxlength="1" type="text" />
            <input id="cell-6" maxlength="1" type="text" />
            <input id="cell-7" maxlength="1" type="text" />
          </div>
        </form>`
      const cells = Array.from(document.querySelectorAll<HTMLInputElement>('.otp input'))
      cells.forEach((cell, idx) => {
        cell.addEventListener('input', () => {
          if (cell.value.length > 0 && idx < cells.length - 1) cells[idx + 1].focus()
        })
      })
    })

    // Second call must successfully populate the NEW cells, not silently
    // type into the stale ones. fillOtp should re-detect via findOtpBoxGroup.
    const second = await fillOtp(page, '22222222', { fieldLabel: 'Security code' })
    expect(second.filledCount).toBe(8)

    const readback = await page.evaluate(() => {
      const cells = Array.from(document.querySelectorAll<HTMLInputElement>('.otp input'))
      return cells.map((cell) => cell.value)
    })
    expect(readback).toEqual(['2', '2', '2', '2', '2', '2', '2', '2'])
    await page.close()
  })

  // Regression: when typing produces zero filled cells (focus lost or
  // post-detection re-render), fillOtp should throw the explicit "all empty"
  // diagnostic instead of a per-cell mismatch list, so callers can retry
  // with fresh detection.
  it('throws an "all cells empty" diagnostic when typing populates nothing', async () => {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
    // Build an OTP-like widget where every cell aggressively self-clears
    // on input, AND removes itself from the tab order so focus never lands
    // anywhere typing-relevant.
    await page.setContent(`
      <div class="otp" data-otp>
        <input id="c0" maxlength="1" type="text" />
        <input id="c1" maxlength="1" type="text" />
        <input id="c2" maxlength="1" type="text" />
      </div>
      <script>
        for (const cell of document.querySelectorAll('.otp input')) {
          cell.addEventListener('input', () => { cell.value = '' })
        }
      </script>
    `)

    await expect(fillOtp(page, '123')).rejects.toThrow(
      /ALL 3 target cells are still empty/i,
    )
    await page.close()
  })

  // Regression: JobForge Hex AI Engineering Lead #310 apply flow on
  // 2026-04-11. Greenhouse's 8-cell security-code widget does not attach
  // an auto-advance handler to cell 0 in some build configurations — only
  // cell 0 is maxlength=1 so typing "c" lands cleanly, but subsequent
  // chars ("t", "U", ...) are silently dropped because focus never moves
  // off cell 0 and maxlength=1 rejects additional chars. Cells 1..7 end
  // up empty. A naive readback-mismatch throw forces callers to retry and
  // hit the same race. The per-cell recovery path should detect the
  // partial fill and explicitly click + type each cell exactly once.
  it('recovers from partial fill (auto-advance failed) via per-cell recovery', async () => {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
    // 8 cells, all maxlength=1. Cells 1..7 have the normal auto-advance
    // handler. Cell 0 does NOT — typing "c" lands in cell 0 and stops.
    // Recovery should click each cell and type exactly one char.
    await page.setContent(`
      <div class="otp" data-otp style="display: flex; gap: 4px">
        <input id="c0" maxlength="1" type="text" />
        <input id="c1" maxlength="1" type="text" />
        <input id="c2" maxlength="1" type="text" />
        <input id="c3" maxlength="1" type="text" />
        <input id="c4" maxlength="1" type="text" />
        <input id="c5" maxlength="1" type="text" />
        <input id="c6" maxlength="1" type="text" />
        <input id="c7" maxlength="1" type="text" />
      </div>
      <style>
        .otp input { width: 32px; height: 32px; text-align: center; font-size: 16px }
      </style>
      <script>
        const cells = Array.from(document.querySelectorAll('.otp input'))
        // Cells 1..7 auto-advance, cell 0 does NOT — simulates a broken
        // first-cell handler. After typing "c" in cell 0 the initial
        // keyboard.type batch has no way to move forward.
        cells.forEach((cell, idx) => {
          if (idx === 0) return
          cell.addEventListener('input', () => {
            if (cell.value.length > 0 && idx < cells.length - 1) cells[idx + 1].focus()
          })
        })
      </script>
    `)

    const result = await fillOtp(page, 'ctUwV31q')
    expect(result.cellCount).toBe(8)
    expect(result.filledCount).toBe(8)

    const readback = await page.evaluate(() => {
      const cells = Array.from(document.querySelectorAll<HTMLInputElement>('.otp input'))
      return cells.map(cell => cell.value)
    })
    expect(readback).toEqual(['c', 't', 'U', 'w', 'V', '3', '1', 'q'])
    await page.close()
  })
})
