import { mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser } from 'playwright'
import { attachFiles, createFillLookupCache, fillFields, fillOtp, pickListboxOption, selectNativeOption, setCheckedControl, setFieldChoice, setFieldText, wheelAt } from '../dom-actions.ts'

describe('pickListboxOption', () => {
  let browser: Browser

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true })
  })

  afterAll(async () => {
    await browser.close()
  })

  it('does not open disabled listbox triggers through label or coordinate entry points', async () => {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
    await page.setContent(`
      <label id="office-label">Office</label>
      <button id="office" role="combobox" aria-labelledby="office-label" aria-haspopup="listbox" aria-disabled="true">Choose</button>
      <div id="options" role="listbox" hidden><button role="option">Berlin</button></div>
      <script>
        window.openCount = 0
        office.addEventListener('click', () => {
          window.openCount++
          options.hidden = false
        })
      </script>
    `)

    await expect(pickListboxOption(page, 'Berlin', { fieldLabel: 'Office', exact: true })).rejects.toThrow()
    const box = await page.locator('#office').boundingBox()
    if (!box) throw new Error('expected listbox trigger bounds')
    await expect(pickListboxOption(page, 'Berlin', {
      openX: box.x + box.width / 2,
      openY: box.y + box.height / 2,
      exact: true,
    })).rejects.toThrow('not mutable')
    expect(await page.evaluate(() => (window as unknown as { openCount: number }).openCount)).toBe(0)
    expect(await page.locator('#options').isHidden()).toBe(true)
    await page.close()
  })

  it('uses authored listbox identity without a label and rejects ignored or unconfirmable hints', async () => {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
    await page.setContent(`
      <button id="office" role="combobox" aria-label="Office" aria-haspopup="listbox">Choose office</button>
      <div id="menu" role="listbox" hidden><button id="berlin" role="option">Berlin</button></div>
      <button id="orphan" role="option">Orphan option</button>
      <script>
        window.orphanClicks = 0
        const trigger = document.getElementById('office')
        const menu = document.getElementById('menu')
        trigger.addEventListener('click', () => { menu.hidden = false })
        document.getElementById('berlin').addEventListener('click', () => {
          trigger.textContent = 'Berlin'
          menu.hidden = true
        })
        document.getElementById('orphan').addEventListener('click', () => { window.orphanClicks++ })
      </script>
    `)

    await expect(pickListboxOption(page, 'Orphan option', { fieldId: 'schema-office' })).rejects.toThrow('fieldId requires')
    expect(await page.evaluate(() => (window as unknown as { orphanClicks: number }).orphanClicks)).toBe(0)

    await expect(pickListboxOption(page, 'Berlin', {
      fieldKey: 'id:office',
      fieldLabel: 'Department',
      exact: true,
    })).rejects.toThrow()
    expect(await page.locator('#office').textContent()).toBe('Choose office')

    const cache = createFillLookupCache()
    await pickListboxOption(page, 'Berlin', { fieldKey: 'id:office', exact: true, cache })
    expect(await page.locator('#office').textContent()).toBe('Berlin')

    await expect(pickListboxOption(page, 'Berlin', {
      fieldKey: 'id:office',
      fieldLabel: 'Department',
      exact: true,
      cache,
    })).rejects.toThrow()
    expect(await page.locator('#office').textContent()).toBe('Berlin')

    await expect(pickListboxOption(page, 'Orphan option', { exact: true })).rejects.toThrow()
    expect(await page.evaluate(() => (window as unknown as { orphanClicks: number }).orphanClicks)).toBe(0)
    await page.close()
  })

  it('rejects listbox calls that combine semantic identity with ignored open coordinates', async () => {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
    await page.setContent('<button id="office" role="combobox" aria-label="Office">Choose</button>')
    const box = await page.locator('#office').boundingBox()
    if (!box) throw new Error('expected trigger bounds')
    await expect(pickListboxOption(page, 'Berlin', {
      fieldLabel: 'Office',
      openX: box.x + box.width / 2,
      openY: box.y + box.height / 2,
    })).rejects.toThrow('cannot be combined')
    await expect(pickListboxOption(page, 'Berlin', {
      openX: box.x + box.width / 2,
      openY: box.y + box.height / 2,
      query: 'Ber',
    })).rejects.toThrow('query cannot be combined')
    await page.close()
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

  it('keeps post-commit invalid checks inside the selected field wrapper', async () => {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
    await page.setContent(`
      <form>
        <div id="location-field">
          <div id="location-label">Location</div>
          <button id="location" type="button" role="combobox" aria-labelledby="location-label" aria-haspopup="listbox">
            <span class="select__placeholder">Choose...</span>
          </button>
          <div id="location-menu" role="listbox" hidden>
            <button type="button" role="option">New York, NY</button>
          </div>
        </div>
        <div id="unrelated-field">
          <label for="unrelated-value">Unrelated required field</label>
          <input id="unrelated-value" type="hidden" required value="" />
          <div role="alert">Unrelated required value is missing</div>
        </div>
      </form>
      <script>
        const trigger = document.getElementById('location')
        const menu = document.getElementById('location-menu')
        trigger.addEventListener('click', () => { menu.hidden = false })
        menu.querySelector('[role="option"]').addEventListener('click', event => {
          event.stopPropagation()
          trigger.innerHTML = '<span class="select__single-value">New York, NY</span>'
          menu.hidden = true
        })
      </script>
    `)

    await pickListboxOption(page, 'New York, NY', {
      fieldKey: 'id:location',
      fieldLabel: 'Location',
      exact: true,
    })

    expect(await page.locator('#location').textContent()).toContain('New York, NY')
    expect(await page.locator('#unrelated-value').inputValue()).toBe('')
    await page.close()
  })

  it('still rejects an empty required backing input inside the selected field wrapper', async () => {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
    await page.setContent(`
      <form>
        <div id="location-field">
          <div id="location-label">Location</div>
          <button id="location" type="button" role="combobox" aria-labelledby="location-label" aria-haspopup="listbox">
            <span class="select__placeholder">Choose...</span>
          </button>
          <input id="location-backing" type="hidden" required value="" />
          <div id="location-menu" role="listbox" hidden>
            <button type="button" role="option">New York, NY</button>
          </div>
        </div>
      </form>
      <script>
        const trigger = document.getElementById('location')
        const menu = document.getElementById('location-menu')
        trigger.addEventListener('click', () => { menu.hidden = false })
        menu.querySelector('[role="option"]').addEventListener('click', event => {
          event.stopPropagation()
          trigger.innerHTML = '<span class="select__single-value">New York, NY</span>'
          menu.hidden = true
        })
      </script>
    `)

    await expect(pickListboxOption(page, 'New York, NY', {
      fieldKey: 'id:location',
      fieldLabel: 'Location',
      exact: true,
    })).rejects.toThrow('selection_not_confirmed')

    expect(await page.locator('#location-backing').inputValue()).toBe('')
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

  it('does not press Enter after selecting from a non-editable Radix-style combobox trigger', async () => {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
    await page.setContent(`
      <label for="prior-employment">Have you previously worked for this company?</label>
      <button
        id="prior-employment"
        type="button"
        role="combobox"
        aria-expanded="false"
        aria-controls="prior-options"
        aria-label="Have you previously worked for this company?"
      >
        <span id="prior-value">Select...</span><span aria-hidden="true">▾</span>
      </button>
      <div id="prior-options" role="listbox" hidden>
        <div role="option" data-value="Yes">Yes</div>
        <div role="option" data-value="No">No</div>
      </div>
      <script>
        const trigger = document.getElementById('prior-employment')
        const value = document.getElementById('prior-value')
        const popup = document.getElementById('prior-options')
        window.radixEnterCount = 0
        trigger.addEventListener('click', () => {
          popup.hidden = false
          trigger.setAttribute('aria-expanded', 'true')
        })
        trigger.addEventListener('keydown', event => {
          if (event.key !== 'Enter') return
          window.radixEnterCount += 1
          // Models the damaging path: Enter on a closed non-editable trigger
          // reopens it and commits the first highlighted item.
          if (popup.hidden) value.textContent = 'Yes'
        })
        for (const option of popup.querySelectorAll('[role="option"]')) {
          option.addEventListener('click', () => {
            value.textContent = option.dataset.value
            popup.hidden = true
            trigger.setAttribute('aria-expanded', 'false')
            trigger.focus()
          })
        }
      </script>
    `)

    await pickListboxOption(page, 'No', {
      fieldKey: 'id:prior-employment',
      fieldLabel: 'Have you previously worked for this company?',
      exact: false,
    })

    expect(await page.locator('#prior-value').textContent()).toBe('No')
    expect(await page.evaluate(() => (window as unknown as { radixEnterCount: number }).radixEnterCount)).toBe(0)
    await page.close()
  })

  it('falls back to keyboard Enter when a React-Select-style option click does not commit', async () => {
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

        // Keyboard commit path — real commit. The fallback must reopen this
        // exact field and route through here after rejecting the click-only
        // visual update.
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

  it('prefers an authored fieldKey over duplicate file labels', async () => {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
    const tempFile = join(tmpdir(), `geometra-upload-key-${Date.now()}.txt`)
    await writeFile(tempFile, 'cover letter')
    await page.setContent(`
      <label for="first-upload">Application document</label><input id="first-upload" type="file" />
      <label for="cover:upload">Application document</label><input id="cover:upload" type="file" />
    `)

    try {
      await attachFiles(page, [tempFile], {
        fieldLabel: 'Application document',
        fieldKey: `id:${encodeURIComponent('cover:upload')}`,
      })
      expect(await page.locator('#first-upload').evaluate((el: HTMLInputElement) => el.files?.length ?? 0)).toBe(0)
      expect(await page.locator('[id="cover:upload"]').evaluate((el: HTMLInputElement) => el.files?.length ?? 0)).toBe(1)
    } finally {
      await rm(tempFile, { force: true })
      await page.close()
    }
  })

  it('uses authored name/id as the stable label for an otherwise unlabeled keyed file input', async () => {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
    const tempFile = join(tmpdir(), `geometra-upload-unlabeled-${Date.now()}.txt`)
    await writeFile(tempFile, 'resume')
    await page.setContent(`
      <form>
        <div style="display:none">
          <input id="resume-upload" name="resume_attachment" type="file" required />
        </div>
      </form>
    `)

    try {
      await attachFiles(page, [tempFile], {
        fieldKey: 'id:resume-upload',
        fieldLabel: 'resume_attachment',
        exact: true,
      })
      expect(await page.locator('#resume-upload').evaluate((el: HTMLInputElement) => el.files?.length ?? 0)).toBe(1)
    } finally {
      await rm(tempFile, { force: true })
      await page.close()
    }
  })

  it('jointly validates keyed file labels and never falls back globally when a key is stale', async () => {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
    const tempFile = join(tmpdir(), `geometra-upload-key-truth-${Date.now()}.txt`)
    await writeFile(tempFile, 'resume')
    await page.setContent(`
      <label for="resume-input">Resume</label><input id="resume-input" type="file" />
      <label for="cover-input">Cover Letter</label><input id="cover-input" type="file" />
    `)

    try {
      const cache = createFillLookupCache()
      await attachFiles(page, [tempFile], {
        fieldLabel: 'Cover Letter',
        fieldKey: 'id:cover-input',
        cache,
      })
      expect(await page.locator('#cover-input').evaluate((el: HTMLInputElement) => el.files?.length ?? 0)).toBe(1)
      await page.locator('#cover-input').evaluate((el: HTMLInputElement) => { el.value = '' })
      await expect(attachFiles(page, [tempFile], {
        fieldLabel: 'Resume',
        fieldKey: 'id:cover-input',
        cache,
      })).rejects.toThrow('did not match field label')
      await expect(attachFiles(page, [tempFile], {
        fieldKey: 'id:missing-upload',
      })).rejects.toThrow('did not resolve')
      expect(await page.locator('#resume-input').evaluate((el: HTMLInputElement) => el.files?.length ?? 0)).toBe(0)
      expect(await page.locator('#cover-input').evaluate((el: HTMLInputElement) => el.files?.length ?? 0)).toBe(0)

      await page.setContent(`
        <label>Resume <input id="resume-a" type="file" /></label>
        <label>Resume <input id="resume-b" type="file" /></label>
      `)
      await expect(attachFiles(page, [tempFile], { fieldLabel: 'Resume' })).rejects.toThrow('ambiguous label')
      expect(await page.locator('#resume-a').evaluate((el: HTMLInputElement) => el.files?.length ?? 0)).toBe(0)
      expect(await page.locator('#resume-b').evaluate((el: HTMLInputElement) => el.files?.length ?? 0)).toBe(0)
    } finally {
      await rm(tempFile, { force: true })
      await page.close()
    }
  })

  it('enforces case-insensitive and compound extension accept contracts before labeled input mutation', async () => {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`
    const pdfFile = join(tmpdir(), `geometra-accept-${stamp}.PDF`)
    const textFile = join(tmpdir(), `geometra-accept-${stamp}.txt`)
    const compoundFile = join(tmpdir(), `geometra-accept-${stamp}.TAR.GZ`)
    await Promise.all([
      writeFile(pdfFile, 'pdf'),
      writeFile(textFile, 'text'),
      writeFile(compoundFile, 'archive'),
    ])
    await page.setContent(`
      <label for="resume-accept">Resume</label>
      <input id="resume-accept" type="file"
        accept=".pdf, .tar.gz, definitely-not-valid, text/plain; charset=utf-8" />
    `)

    try {
      await attachFiles(page, [pdfFile], { fieldLabel: 'Resume', strategy: 'hidden' })
      expect(await page.locator('#resume-accept').evaluate((el: HTMLInputElement) => el.files?.[0]?.name)).toBe(
        pdfFile.split('/').pop(),
      )

      await expect(attachFiles(page, [pdfFile, textFile], {
        fieldLabel: 'Resume',
        strategy: 'hidden',
      })).rejects.toThrow('did not match input accept=')
      // Rejection is a preflight decision: the previously selected file is
      // not cleared or replaced by the mismatching path.
      expect(await page.locator('#resume-accept').evaluate((el: HTMLInputElement) =>
        Array.from(el.files ?? []).map(file => file.name),
      )).toEqual([pdfFile.split('/').pop()])

      await attachFiles(page, [compoundFile], { fieldLabel: 'Resume', strategy: 'hidden' })
      expect(await page.locator('#resume-accept').evaluate((el: HTMLInputElement) => el.files?.[0]?.name)).toBe(
        compoundFile.split('/').pop(),
      )
    } finally {
      await Promise.all([pdfFile, textFile, compoundFile].map(path => rm(path, { force: true })))
      await page.close()
    }
  })

  it('ignores invalid-only accept tokens instead of inventing a restriction', async () => {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
    const textFile = join(tmpdir(), `geometra-invalid-accept-${Date.now()}.txt`)
    await writeFile(textFile, 'text')
    await page.setContent(`
      <label for="invalid-accept">Attachment</label>
      <input id="invalid-accept" type="file"
        accept="not-a-specifier, text/plain; charset=utf-8, image/**, . bad" />
    `)

    try {
      await attachFiles(page, [textFile], { fieldLabel: 'Attachment', strategy: 'hidden' })
      expect(await page.locator('#invalid-accept').evaluate((el: HTMLInputElement) => el.files?.length ?? 0)).toBe(1)
    } finally {
      await rm(textFile, { force: true })
      await page.close()
    }
  })

  it('enforces exact MIME accept contracts on file chooser handles', async () => {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`
    const pdfFile = join(tmpdir(), `geometra-chooser-accept-${stamp}.pdf`)
    const textFile = join(tmpdir(), `geometra-chooser-accept-${stamp}.txt`)
    const unknownFile = join(tmpdir(), `geometra-chooser-accept-${stamp}.unknown-file-type`)
    await Promise.all([
      writeFile(pdfFile, 'pdf'),
      writeFile(textFile, 'text'),
      writeFile(unknownFile, 'unknown'),
    ])
    await page.setContent(`
      <button id="choose-file" type="button">Choose file</button>
      <input id="chooser-accept" type="file" accept="application/pdf" hidden />
      <script>
        document.getElementById('choose-file').addEventListener('click', () => {
          document.getElementById('chooser-accept').click()
        })
      </script>
    `)

    // Accept/preflight semantics do not depend on Chromium's native chooser
    // scheduling, which has separate real-chooser coverage below. A fresh real
    // input handle per call also proves every chooser handle is released.
    let disposedChooserHandles = 0
    Object.defineProperty(page.mouse, 'click', {
      configurable: true,
      value: async () => {},
    })
    Object.defineProperty(page, 'waitForEvent', {
      configurable: true,
      value: async (eventName: string) => {
        if (eventName !== 'filechooser') throw new Error(`unexpected event ${eventName}`)
        const handle = await page.locator('#chooser-accept').elementHandle()
        if (!handle) throw new Error('expected chooser input handle')
        const trackedHandle = new Proxy(handle, {
          get(target, property) {
            if (property === 'dispose') {
              return async () => {
                disposedChooserHandles++
                await target.dispose()
              }
            }
            const value = Reflect.get(target, property, target)
            return typeof value === 'function' ? value.bind(target) : value
          },
        })
        return {
          element: () => trackedHandle,
          setFiles: (files: string[]) => handle.setInputFiles(files),
        }
      },
    })

    try {
      const box = await page.locator('#choose-file').boundingBox()
      if (!box) throw new Error('expected chooser bounds')
      const chooserTarget = {
        strategy: 'chooser' as const,
        clickX: box.x + box.width / 2,
        clickY: box.y + box.height / 2,
      }
      await attachFiles(page, [pdfFile], chooserTarget)
      await expect(attachFiles(page, [textFile], chooserTarget)).rejects.toThrow('did not match input accept=')
      await expect(attachFiles(page, [unknownFile], chooserTarget)).rejects.toThrow('cannot safely infer MIME type')
      await attachFiles(page, [pdfFile], chooserTarget)
      expect(await page.locator('#chooser-accept').evaluate((el: HTMLInputElement) =>
        Array.from(el.files ?? []).map(file => file.name),
      )).toEqual([pdfFile.split('/').pop()])
      expect(disposedChooserHandles).toBe(4)
    } finally {
      await Promise.all([pdfFile, textFile, unknownFile].map(path => rm(path, { force: true })))
      await page.close()
    }
  })

  it('enforces wildcard MIME accept contracts before synthetic drop events', async () => {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`
    const imageFile = join(tmpdir(), `geometra-drop-accept-${stamp}.png`)
    const textFile = join(tmpdir(), `geometra-drop-accept-${stamp}.txt`)
    await Promise.all([writeFile(imageFile, 'png'), writeFile(textFile, 'text')])
    await page.setContent(`
      <div id="accept-drop" data-dropzone style="width:320px;height:100px;border:1px solid #aaa;">
        <span id="accept-drop-status">Drop image here</span>
        <input id="accept-drop-input" type="file" accept="image/*" hidden />
      </div>
      <script>
        globalThis.__geometraDropEvents = { drag: 0, change: 0 }
        const zone = document.getElementById('accept-drop')
        const status = document.getElementById('accept-drop-status')
        const input = document.getElementById('accept-drop-input')
        zone.addEventListener('dragover', event => {
          globalThis.__geometraDropEvents.drag++
          event.preventDefault()
        })
        zone.addEventListener('drop', event => {
          globalThis.__geometraDropEvents.drag++
          event.preventDefault()
          status.textContent = Array.from(event.dataTransfer.files).map(file => file.name).join(', ')
        })
        input.addEventListener('change', () => { globalThis.__geometraDropEvents.change++ })
      </script>
    `)

    try {
      const box = await page.locator('#accept-drop').boundingBox()
      if (!box) throw new Error('expected drop bounds')
      const dropTarget = {
        strategy: 'drop' as const,
        dropX: box.x + box.width / 2,
        dropY: box.y + box.height / 2,
      }
      await attachFiles(page, [imageFile], dropTarget)
      const beforeRejectedDrop = await page.evaluate(() => ({
        events: { ...(globalThis as unknown as { __geometraDropEvents: { drag: number; change: number } }).__geometraDropEvents },
        files: Array.from((document.getElementById('accept-drop-input') as HTMLInputElement).files ?? [])
          .map(file => file.name),
      }))

      await expect(attachFiles(page, [textFile], dropTarget)).rejects.toThrow('did not match input accept=')
      const afterRejectedDrop = await page.evaluate(() => ({
        events: { ...(globalThis as unknown as { __geometraDropEvents: { drag: number; change: number } }).__geometraDropEvents },
        files: Array.from((document.getElementById('accept-drop-input') as HTMLInputElement).files ?? [])
          .map(file => file.name),
      }))
      expect(beforeRejectedDrop.files).toEqual([imageFile.split('/').pop()])
      expect(afterRejectedDrop).toEqual(beforeRejectedDrop)
    } finally {
      await Promise.all([imageFile, textFile].map(path => rm(path, { force: true })))
      await page.close()
    }
  })

  it('finds a sibling file input on the nearest outer dropzone before trusting rendered acceptance', async () => {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`
    const pdfFile = join(tmpdir(), `geometra-nested-drop-${stamp}.pdf`)
    const jsonFile = join(tmpdir(), `geometra-nested-drop-${stamp}.json`)
    await Promise.all([writeFile(pdfFile, 'pdf'), writeFile(jsonFile, '{"invalid":true}')])
    await page.setContent(`
      <div id="outer-drop" data-dropzone style="width:360px;height:120px;border:1px solid #aaa;">
        <div id="inner-drop" style="width:100%;height:100%;display:grid;place-items:center;">
          <span id="nested-drop-target">Drop application document</span>
        </div>
        <input id="nested-drop-input" type="file" accept=".pdf" hidden />
      </div>
      <div id="nested-drop-status">Nothing uploaded</div>
      <script>
        globalThis.__geometraNestedDropEvents = 0
        const outer = document.getElementById('outer-drop')
        const status = document.getElementById('nested-drop-status')
        outer.addEventListener('dragover', event => {
          globalThis.__geometraNestedDropEvents++
          event.preventDefault()
        })
        outer.addEventListener('drop', event => {
          globalThis.__geometraNestedDropEvents++
          event.preventDefault()
          const name = event.dataTransfer.files[0]?.name ?? ''
          status.textContent = JSON.stringify({ uploaded: name })
        })
      </script>
    `)

    try {
      const target = await page.locator('#nested-drop-target').boundingBox()
      if (!target) throw new Error('expected nested drop target bounds')
      const dropTarget = {
        strategy: 'drop' as const,
        dropX: target.x + target.width / 2,
        dropY: target.y + target.height / 2,
      }

      await expect(attachFiles(page, [jsonFile], dropTarget)).rejects.toThrow('did not match input accept=')
      expect(await page.evaluate(() => (globalThis as unknown as { __geometraNestedDropEvents: number }).__geometraNestedDropEvents)).toBe(0)
      expect(await page.locator('#nested-drop-status').textContent()).toBe('Nothing uploaded')
      expect(await page.locator('#nested-drop-input').evaluate((el: HTMLInputElement) => el.files?.length ?? 0)).toBe(0)

      await attachFiles(page, [pdfFile], dropTarget)
      expect(await page.locator('#nested-drop-input').evaluate((el: HTMLInputElement) => el.files?.[0]?.name)).toBe(
        pdfFile.split('/').pop(),
      )
    } finally {
      await Promise.all([pdfFile, jsonFile].map(path => rm(path, { force: true })))
      await page.close()
    }
  })

  it('rejects a non-mutable associated drop input before firing any application events', async () => {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
    const uploadFile = join(tmpdir(), `geometra-disabled-drop-${Date.now()}.pdf`)
    await writeFile(uploadFile, 'document')
    await page.setContent(`
      <div id="disabled-drop" data-dropzone style="width:360px;height:120px;border:1px solid #aaa;">
        <span id="disabled-drop-target">Drop disabled attachment</span>
        <input id="disabled-drop-input" type="file" accept=".pdf" disabled hidden />
      </div>
      <div id="disabled-drop-status">Nothing uploaded</div>
      <script>
        globalThis.__geometraDisabledDropEvents = { drag: 0, input: 0, change: 0 }
        const zone = document.getElementById('disabled-drop')
        const input = document.getElementById('disabled-drop-input')
        const status = document.getElementById('disabled-drop-status')
        for (const type of ['dragenter', 'dragover', 'drop']) {
          zone.addEventListener(type, event => {
            globalThis.__geometraDisabledDropEvents.drag++
            event.preventDefault()
            status.textContent = 'handler fired'
          })
        }
        input.addEventListener('input', () => { globalThis.__geometraDisabledDropEvents.input++ })
        input.addEventListener('change', () => { globalThis.__geometraDisabledDropEvents.change++ })
      </script>
    `)

    try {
      const target = await page.locator('#disabled-drop-target').boundingBox()
      if (!target) throw new Error('expected disabled drop target bounds')
      await expect(attachFiles(page, [uploadFile], {
        strategy: 'drop',
        dropX: target.x + target.width / 2,
        dropY: target.y + target.height / 2,
      })).rejects.toThrow('associated drop input is not mutable (disabled)')

      expect(await page.evaluate(() =>
        (globalThis as unknown as {
          __geometraDisabledDropEvents: { drag: number; input: number; change: number }
        }).__geometraDisabledDropEvents,
      )).toEqual({ drag: 0, input: 0, change: 0 })
      expect(await page.locator('#disabled-drop-status').textContent()).toBe('Nothing uploaded')
      expect(await page.locator('#disabled-drop-input').evaluate((el: HTMLInputElement) => el.files?.length ?? 0)).toBe(0)
    } finally {
      await rm(uploadFile, { force: true })
      await page.close()
    }
  })

  it('refuses a coordinate-only drop when the nearest candidate container has multiple file inputs', async () => {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
    const coverFile = join(tmpdir(), `geometra-ambiguous-drop-${Date.now()}.pdf`)
    await writeFile(coverFile, 'cover')
    await page.setContent(`
      <form id="application-form">
        <input id="resume-upload" type="file" hidden />
        <div id="cover-drop" data-dropzone style="width:360px;height:120px;border:1px solid #aaa;">
          <span id="cover-drop-target">Drop cover letter</span>
        </div>
        <input id="cover-upload" type="file" hidden />
      </form>
      <div id="ambiguous-drop-status">Nothing uploaded</div>
      <script>
        globalThis.__geometraAmbiguousDropEvents = 0
        const zone = document.getElementById('cover-drop')
        const status = document.getElementById('ambiguous-drop-status')
        zone.addEventListener('dragover', event => {
          globalThis.__geometraAmbiguousDropEvents++
          event.preventDefault()
        })
        zone.addEventListener('drop', event => {
          globalThis.__geometraAmbiguousDropEvents++
          event.preventDefault()
          status.textContent = JSON.stringify({ uploaded: event.dataTransfer.files[0]?.name ?? '' })
        })
      </script>
    `)

    try {
      const target = await page.locator('#cover-drop-target').boundingBox()
      if (!target) throw new Error('expected ambiguous drop target bounds')
      await expect(attachFiles(page, [coverFile], {
        strategy: 'drop',
        dropX: target.x + target.width / 2,
        dropY: target.y + target.height / 2,
      })).rejects.toThrow(/ambiguous.*2 file inputs/)

      expect(await page.evaluate(() =>
        (globalThis as unknown as { __geometraAmbiguousDropEvents: number }).__geometraAmbiguousDropEvents,
      )).toBe(0)
      expect(await page.locator('#ambiguous-drop-status').textContent()).toBe('Nothing uploaded')
      expect(await page.locator('#resume-upload').evaluate((el: HTMLInputElement) => el.files?.length ?? 0)).toBe(0)
      expect(await page.locator('#cover-upload').evaluate((el: HTMLInputElement) => el.files?.length ?? 0)).toBe(0)
    } finally {
      await rm(coverFile, { force: true })
      await page.close()
    }
  })

  it('does not treat a lone form-level sibling input as proof that a plain div accepts drops', async () => {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
    const uploadFile = join(tmpdir(), `geometra-plain-drop-${Date.now()}.pdf`)
    await writeFile(uploadFile, 'document')
    await page.setContent(`
      <form>
        <div id="plain-drop" style="width:360px;height:120px;border:1px solid #aaa;">
          Plain div, no handlers
        </div>
        <input id="only-upload" type="file" hidden />
      </form>
    `)

    try {
      const target = await page.locator('#plain-drop').boundingBox()
      if (!target) throw new Error('expected plain div bounds')
      await expect(attachFiles(page, [uploadFile], {
        strategy: 'drop',
        dropX: target.x + target.width / 2,
        dropY: target.y + target.height / 2,
      })).rejects.toThrow('drop target did not accept')

      expect(await page.locator('#plain-drop').textContent()).toContain('Plain div, no handlers')
      expect(await page.locator('#only-upload').evaluate((el: HTMLInputElement) => el.files?.length ?? 0)).toBe(0)
    } finally {
      await rm(uploadFile, { force: true })
      await page.close()
    }
  })

  it('does not infer drop association from a generic wrapper containing a sibling file input', async () => {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
    const uploadFile = join(tmpdir(), `geometra-generic-drop-${Date.now()}.pdf`)
    await writeFile(uploadFile, 'document')
    await page.setContent(`
      <div id="generic-wrapper">
        <div id="generic-plain" style="width:360px;height:120px;border:1px solid #aaa;">
          Plain div inside generic wrapper
        </div>
        <input id="generic-upload" type="file" hidden />
      </div>
    `)

    try {
      const target = await page.locator('#generic-plain').boundingBox()
      if (!target) throw new Error('expected generic plain div bounds')
      await expect(attachFiles(page, [uploadFile], {
        strategy: 'drop',
        dropX: target.x + target.width / 2,
        dropY: target.y + target.height / 2,
      })).rejects.toThrow('drop target did not accept')

      expect(await page.locator('#generic-plain').textContent()).toContain('Plain div inside generic wrapper')
      expect(await page.locator('#generic-upload').evaluate((el: HTMLInputElement) => el.files?.length ?? 0)).toBe(0)
    } finally {
      await rm(uploadFile, { force: true })
      await page.close()
    }
  })

  it('refuses disabled file inputs and requires synthetic drops to show acceptance', async () => {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
    const tempFile = join(tmpdir(), `geometra-upload-truth-${Date.now()}.txt`)
    await writeFile(tempFile, 'resume')
    await page.setContent(`
      <style>
        .drop { width: 260px; height: 80px; margin: 16px; border: 1px solid #aaa; }
      </style>
      <label for="disabled-upload">Resume</label>
      <input id="disabled-upload" type="file" disabled />
      <div id="plain-drop" class="drop">Plain drop target</div>
      <div id="blocked-drop" class="drop" data-dropzone aria-disabled="true">Blocked drop target</div>
      <div id="cleared-drop" class="drop" data-dropzone>Cleared drop target<input id="cleared-drop-input" type="file" hidden /></div>
      <div id="accepted-drop" class="drop" data-dropzone>Accepted drop target</div>
      <script>
        const blocked = document.getElementById('blocked-drop')
        blocked.addEventListener('dragover', event => event.preventDefault())
        blocked.addEventListener('drop', event => {
          event.preventDefault()
          blocked.textContent = 'should not run'
        })
        const cleared = document.getElementById('cleared-drop')
        const clearedInput = document.getElementById('cleared-drop-input')
        cleared.addEventListener('dragover', event => event.preventDefault())
        cleared.addEventListener('drop', event => event.preventDefault())
        clearedInput.addEventListener('change', () => setTimeout(() => {
          Object.defineProperty(clearedInput, 'files', { value: new DataTransfer().files, configurable: true })
        }, 0))
        const accepted = document.getElementById('accepted-drop')
        accepted.addEventListener('dragover', event => event.preventDefault())
        accepted.addEventListener('drop', event => {
          event.preventDefault()
          accepted.textContent = Array.from(event.dataTransfer.files).map(file => file.name).join(', ')
        })
      </script>
    `)

    try {
      await expect(attachFiles(page, [tempFile], {
        fieldLabel: 'Resume',
        strategy: 'hidden',
      })).rejects.toThrow('file:')
      expect(await page.locator('#disabled-upload').evaluate((el: HTMLInputElement) => el.files?.length ?? 0)).toBe(0)

      const plain = await page.locator('#plain-drop').boundingBox()
      if (!plain) throw new Error('expected plain drop bounds')
      await expect(attachFiles(page, [tempFile], {
        strategy: 'drop',
        dropX: plain.x + plain.width / 2,
        dropY: plain.y + plain.height / 2,
      })).rejects.toThrow('did not accept')

      const blocked = await page.locator('#blocked-drop').boundingBox()
      if (!blocked) throw new Error('expected blocked drop bounds')
      await expect(attachFiles(page, [tempFile], {
        strategy: 'drop',
        dropX: blocked.x + blocked.width / 2,
        dropY: blocked.y + blocked.height / 2,
      })).rejects.toThrow('not mutable')
      expect(await page.locator('#blocked-drop').textContent()).toBe('Blocked drop target')

      const cleared = await page.locator('#cleared-drop').boundingBox()
      if (!cleared) throw new Error('expected cleared drop bounds')
      await expect(attachFiles(page, [tempFile], {
        strategy: 'drop',
        dropX: cleared.x + cleared.width / 2,
        dropY: cleared.y + cleared.height / 2,
      })).rejects.toThrow('did not accept')

      const accepted = await page.locator('#accepted-drop').boundingBox()
      if (!accepted) throw new Error('expected accepted drop bounds')
      await attachFiles(page, [tempFile], {
        strategy: 'drop',
        dropX: accepted.x + accepted.width / 2,
        dropY: accepted.y + accepted.height / 2,
      })
      expect(await page.locator('#accepted-drop').textContent()).toContain(tempFile.split('/').pop())
    } finally {
      await rm(tempFile, { force: true })
      await page.close()
    }
  })

  it('verifies hidden and chooser uploads survive application handlers', async () => {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
    const tempFile = join(tmpdir(), `geometra-upload-retain-${Date.now()}.txt`)
    await writeFile(tempFile, 'resume')
    try {
      await page.setContent(`
        <label for="resume">Resume</label><input id="resume" type="file" />
        <script>
          resume.addEventListener('change', () => setTimeout(() => { resume.value = '' }, 0))
        </script>
      `)
      await expect(attachFiles(page, [tempFile], {
        fieldLabel: 'Resume',
        strategy: 'hidden',
      })).rejects.toThrow('upload outcome is ambiguous')
      expect(await page.locator('#resume').evaluate((el: HTMLInputElement) => el.files?.length ?? 0)).toBe(0)

      await page.setContent(`
        <button id="upload" type="button">Upload resume</button>
        <input id="chooser-input" type="file" hidden />
        <script>
          const uploadButton = document.getElementById('upload')
          const chooserInput = document.getElementById('chooser-input')
          globalThis.__geometraChooserEvents = { input: 0, change: 0 }
          uploadButton.addEventListener('click', () => chooserInput.click())
          chooserInput.addEventListener('input', () => { globalThis.__geometraChooserEvents.input++ })
          chooserInput.addEventListener('change', () => {
            globalThis.__geometraChooserEvents.change++
            setTimeout(() => { chooserInput.value = '' }, 0)
          })
        </script>
      `)
      const box = await page.locator('#upload').boundingBox()
      if (!box) throw new Error('expected chooser button bounds')
      await expect(attachFiles(page, [tempFile], {
        strategy: 'chooser',
        clickX: box.x + box.width / 2,
        clickY: box.y + box.height / 2,
      })).rejects.toThrow('upload outcome is ambiguous')
      expect(await page.locator('#chooser-input').evaluate((el: HTMLInputElement) => el.files?.length ?? 0)).toBe(0)
      expect(await page.evaluate(() => (globalThis as unknown as {
        __geometraChooserEvents: { input: number; change: number }
      }).__geometraChooserEvents)).toEqual({ input: 1, change: 1 })

      await page.setContent(`
        <button id="blocked-upload" type="button">Upload blocked resume</button>
        <input id="blocked-chooser-input" type="file" aria-disabled="true" hidden />
        <script>
          const blockedButton = document.getElementById('blocked-upload')
          const blockedInput = document.getElementById('blocked-chooser-input')
          blockedButton.addEventListener('click', () => blockedInput.click())
        </script>
      `)
      const blockedBox = await page.locator('#blocked-upload').boundingBox()
      if (!blockedBox) throw new Error('expected blocked chooser button bounds')
      await expect(attachFiles(page, [tempFile], {
        strategy: 'chooser',
        clickX: blockedBox.x + blockedBox.width / 2,
        clickY: blockedBox.y + blockedBox.height / 2,
      })).rejects.toThrow('chooser input is not mutable')
      expect(await page.locator('#blocked-chooser-input').evaluate((el: HTMLInputElement) => el.files?.length ?? 0)).toBe(0)
    } finally {
      await rm(tempFile, { force: true })
      await page.close()
    }
  })

  it('confirms a reactively replaced exact upload only through a stable same-key successor', async () => {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
    const tempFile = join(tmpdir(), `geometra-upload-successor-${Date.now()}.txt`)
    await writeFile(tempFile, 'resume')
    await page.setContent(`
      <input id="resume" type="file" accept=".txt" />
      <script>
        const original = document.getElementById('resume')
        original.addEventListener('change', () => {
          const successor = original.cloneNode()
          successor.setAttribute('accept', 'text/plain')
          successor.files = original.files
          original.replaceWith(successor)
        })
      </script>
    `)

    try {
      await attachFiles(page, [tempFile], {
        fieldKey: 'id:resume',
        strategy: 'hidden',
      })
      expect(await page.locator('#resume').evaluate((input: HTMLInputElement) => ({
        accept: input.getAttribute('accept'),
        names: Array.from(input.files ?? []).map(file => file.name),
      }))).toEqual({
        accept: 'text/plain',
        names: [tempFile.split('/').pop()],
      })
    } finally {
      await rm(tempFile, { force: true })
      await page.close()
    }
  })

  it('confirms a reactive upload through a stable field-scoped filename receipt', async () => {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
    const tempFile = join(tmpdir(), `geometra-upload-receipt-${Date.now()}.txt`)
    const fileName = tempFile.split('/').pop()!
    await writeFile(tempFile, 'resume')
    await page.setContent(`
      <div id="resume-field" role="group" aria-labelledby="resume-label">
        <div id="resume-label">Resume</div>
        <div id="resume-wrapper">
          <label for="resume">Attach</label>
          <input id="resume" type="file" accept=".txt" />
        </div>
      </div>
      <script>
        const input = document.getElementById('resume')
        const wrapper = document.getElementById('resume-wrapper')
        input.addEventListener('change', () => {
          const name = input.files[0].name
          wrapper.innerHTML = '<div role="progressbar" aria-valuenow="20">Uploading</div>'
          setTimeout(() => {
            wrapper.innerHTML = '<p class="file-name">' + name + '</p>' +
              '<button type="button" aria-label="Remove file">Remove</button>'
          }, 80)
        })
      </script>
    `)

    try {
      await attachFiles(page, [tempFile], {
        fieldKey: 'id:resume',
        strategy: 'hidden',
      })
      expect(await page.locator('#resume-wrapper').textContent()).toContain(fileName)
      expect(await page.locator('#resume-wrapper [aria-label="Remove file"]').count()).toBe(1)
    } finally {
      await rm(tempFile, { force: true })
      await page.close()
    }
  })

  it('does not mistake a reactive upload error containing the filename for a receipt', async () => {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
    const tempFile = join(tmpdir(), `geometra-upload-receipt-error-${Date.now()}.txt`)
    await writeFile(tempFile, 'resume')
    await page.setContent(`
      <div id="resume-field" role="group" aria-labelledby="resume-label">
        <div id="resume-label">Resume</div>
        <div id="resume-wrapper">
          <input id="resume" type="file" accept=".txt" />
        </div>
      </div>
      <script>
        const input = document.getElementById('resume')
        const wrapper = document.getElementById('resume-wrapper')
        input.addEventListener('change', () => {
          const name = input.files[0].name
          wrapper.innerHTML = '<div role="alert">Could not upload ' + name + '</div>' +
            '<button type="button">Try again</button>'
        })
      </script>
    `)

    try {
      await expect(attachFiles(page, [tempFile], {
        fieldKey: 'id:resume',
        strategy: 'hidden',
      })).rejects.toThrow(/upload outcome is ambiguous.*Do not retry/i)
    } finally {
      await rm(tempFile, { force: true })
      await page.close()
    }
  })

  it('does not widen receipt proof to document-level unrelated filename and control evidence', async () => {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
    const tempFile = join(tmpdir(), `geometra-upload-unrelated-receipt-${Date.now()}.txt`)
    await writeFile(tempFile, 'resume')
    await page.setContent(`
      <input id="resume" type="file" accept=".txt" />
      <section><p id="unrelated-filename"></p></section>
      <aside><button type="button" aria-label="Remove file">Remove</button></aside>
      <script>
        const input = document.getElementById('resume')
        input.addEventListener('change', () => {
          const name = input.files[0].name
          input.remove()
          document.getElementById('unrelated-filename').textContent = name
        })
      </script>
    `)

    try {
      await expect(attachFiles(page, [tempFile], {
        fieldKey: 'id:resume',
        strategy: 'hidden',
      })).rejects.toThrow(/upload outcome is ambiguous.*Do not retry/i)
    } finally {
      await rm(tempFile, { force: true })
      await page.close()
    }
  })

  it('does not treat a broad associated app container as a field-local receipt scope', async () => {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
    const tempFile = join(tmpdir(), `geometra-upload-broad-container-${Date.now()}.txt`)
    await writeFile(tempFile, 'resume')
    await page.setContent(`
      <div id="application-shell">
        <label for="resume">Resume</label>
        <input id="resume" type="file" accept=".txt" />
        <section><p id="unrelated-filename"></p></section>
        <aside><button type="button">Change preferences</button></aside>
      </div>
      <script>
        const input = document.getElementById('resume')
        input.addEventListener('change', () => {
          const name = input.files[0].name
          input.remove()
          document.getElementById('unrelated-filename').textContent = name
        })
      </script>
    `)

    try {
      await expect(attachFiles(page, [tempFile], {
        fieldKey: 'id:resume',
        strategy: 'hidden',
      })).rejects.toThrow(/upload outcome is ambiguous.*Do not retry/i)
    } finally {
      await rm(tempFile, { force: true })
      await page.close()
    }
  })

  it('treats an upload-error receipt with an exact filename and Remove control as failed', async () => {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
    const tempFile = join(tmpdir(), `geometra-upload-class-error-${Date.now()}.txt`)
    await writeFile(tempFile, 'resume')
    await page.setContent(`
      <div id="resume-wrapper">
        <label for="resume">Attach</label>
        <input id="resume" type="file" accept=".txt" />
      </div>
      <script>
        const input = document.getElementById('resume')
        const wrapper = document.getElementById('resume-wrapper')
        input.addEventListener('change', () => {
          const name = input.files[0].name
          wrapper.innerHTML = '<p class="upload-error">' + name + '</p>' +
            '<button type="button" aria-label="Remove file">Remove</button>'
        })
      </script>
    `)

    try {
      await expect(attachFiles(page, [tempFile], {
        fieldKey: 'id:resume',
        strategy: 'hidden',
      })).rejects.toThrow(/upload outcome is ambiguous.*Do not retry/i)
    } finally {
      await rm(tempFile, { force: true })
      await page.close()
    }
  })

  it('requires reactive receipts to prove duplicate basename multiplicity', async () => {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
    const tempRoot = join(tmpdir(), `geometra-upload-duplicate-receipt-${Date.now()}`)
    const firstDir = join(tempRoot, 'first')
    const secondDir = join(tempRoot, 'second')
    const basename = 'resume.txt'
    const firstFile = join(firstDir, basename)
    const secondFile = join(secondDir, basename)
    await mkdir(firstDir, { recursive: true })
    await mkdir(secondDir, { recursive: true })
    await writeFile(firstFile, 'first resume')
    await writeFile(secondFile, 'second resume')
    await page.setContent(`
      <div id="resume-wrapper">
        <label for="resume">Attach</label>
        <input id="resume" type="file" accept=".txt" multiple />
      </div>
      <script>
        const input = document.getElementById('resume')
        const wrapper = document.getElementById('resume-wrapper')
        input.addEventListener('change', () => {
          const name = input.files[0].name
          wrapper.innerHTML = '<p class="file-name">' + name + '</p>' +
            '<button type="button" aria-label="Remove file">Remove</button>'
        })
      </script>
    `)

    try {
      await expect(attachFiles(page, [firstFile, secondFile], {
        fieldKey: 'id:resume',
        strategy: 'hidden',
      })).rejects.toThrow(/upload outcome is ambiguous.*Do not retry/i)
    } finally {
      await rm(tempRoot, { recursive: true, force: true })
      await page.close()
    }
  })

  it('fails closed for duplicate, incompatible, mismatched, or unstable upload successors', async () => {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
    const tempFile = join(tmpdir(), `geometra-upload-successor-guard-${Date.now()}.txt`)
    await writeFile(tempFile, 'resume')

    try {
      for (const mode of ['duplicate', 'contract', 'filename', 'cleared'] as const) {
        await page.setContent(`
          <input id="resume" type="file" accept=".txt" />
          <input id="alternate" type="file" />
          <script>
            (() => {
            globalThis.__alternateUploadEvents = 0
            document.getElementById('alternate').addEventListener('input', () => {
              globalThis.__alternateUploadEvents++
            })
            const original = document.getElementById('resume')
            original.addEventListener('change', () => {
              const successor = original.cloneNode()
              if ('${mode}' === 'contract') successor.setAttribute('accept', '.pdf')
              if ('${mode}' === 'filename') {
                const transfer = new DataTransfer()
                transfer.items.add(new File(['wrong'], 'wrong.txt', { type: 'text/plain' }))
                successor.files = transfer.files
              } else {
                successor.files = original.files
              }
              if ('${mode}' === 'duplicate') {
                const duplicate = successor.cloneNode()
                duplicate.files = original.files
                original.replaceWith(successor, duplicate)
              } else {
                original.replaceWith(successor)
              }
              if ('${mode}' === 'cleared') {
                setTimeout(() => { successor.value = '' }, 70)
              }
            })
            })()
          </script>
        `)

        let thrown: Error | null = null
        try {
          await attachFiles(page, [tempFile], {
            fieldKey: 'id:resume',
            strategy: 'hidden',
          })
        } catch (error) {
          thrown = error as Error
        }
        const successorState = await page.locator('#resume').evaluateAll((inputs: HTMLInputElement[]) => inputs.map(input => ({
          accept: input.getAttribute('accept'),
          names: Array.from(input.files ?? []).map(file => file.name),
        })))
        expect(thrown, `${mode}: ${JSON.stringify(successorState)}`).not.toBeNull()
        expect(thrown?.message, mode).toMatch(/upload outcome is ambiguous.*Do not retry/i)
        expect(await page.evaluate(() => (globalThis as unknown as {
          __alternateUploadEvents: number
        }).__alternateUploadEvents), mode).toBe(0)
      }
    } finally {
      await rm(tempFile, { force: true })
      await page.close()
    }
  })

  it('rejects a statically disabled exact hidden target without events or chooser fallback', async () => {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
    const tempFile = join(tmpdir(), `geometra-upload-static-disabled-${Date.now()}.txt`)
    await writeFile(tempFile, 'resume')
    await page.setContent(`
      <div>
        <label for="disabled-exact-upload">Resume</label>
        <input id="disabled-exact-upload" type="file" accept=".txt" disabled />
        <button id="disabled-upload-fallback" type="button">Attach Resume</button>
        <input id="disabled-fallback-input" type="file" hidden />
      </div>
      <script>
        globalThis.__geometraStaticUploadEvents = {
          targetInput: 0,
          targetChange: 0,
          fallbackClicks: 0,
          fallbackInput: 0,
          fallbackChange: 0,
        }
        const target = document.getElementById('disabled-exact-upload')
        const button = document.getElementById('disabled-upload-fallback')
        const fallback = document.getElementById('disabled-fallback-input')
        target.addEventListener('input', () => { globalThis.__geometraStaticUploadEvents.targetInput++ })
        target.addEventListener('change', () => { globalThis.__geometraStaticUploadEvents.targetChange++ })
        button.addEventListener('click', () => {
          globalThis.__geometraStaticUploadEvents.fallbackClicks++
          fallback.click()
        })
        fallback.addEventListener('input', () => { globalThis.__geometraStaticUploadEvents.fallbackInput++ })
        fallback.addEventListener('change', () => { globalThis.__geometraStaticUploadEvents.fallbackChange++ })
      </script>
    `)

    try {
      await expect(attachFiles(page, [tempFile], {
        fieldLabel: 'Resume',
        strategy: 'auto',
      })).rejects.toThrow('matched input is not mutable (disabled)')

      expect(await page.evaluate(() => ({
        events: (globalThis as unknown as {
          __geometraStaticUploadEvents: Record<string, number>
        }).__geometraStaticUploadEvents,
        targetFiles: Array.from((document.getElementById('disabled-exact-upload') as HTMLInputElement).files ?? [])
          .map(file => file.name),
        fallbackFiles: Array.from((document.getElementById('disabled-fallback-input') as HTMLInputElement).files ?? [])
          .map(file => file.name),
      }))).toEqual({
        events: {
          targetInput: 0,
          targetChange: 0,
          fallbackClicks: 0,
          fallbackInput: 0,
          fallbackChange: 0,
        },
        targetFiles: [],
        fallbackFiles: [],
      })
    } finally {
      await rm(tempFile, { force: true })
      await page.close()
    }
  })

  it('marks a hidden microtask-disable race ambiguous, clears it, and never tries a second uploader', async () => {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
    const tempFile = join(tmpdir(), `geometra-upload-hidden-race-${Date.now()}.txt`)
    await writeFile(tempFile, 'resume')
    await page.setContent(`
      <div>
        <label for="racing-hidden-upload">Resume</label>
        <input id="racing-hidden-upload" type="file" accept=".txt" />
        <button id="racing-upload-fallback" type="button">Attach Resume</button>
        <input id="racing-fallback-input" type="file" hidden />
      </div>
      <script>
        globalThis.__geometraHiddenRaceEvents = {
          targetInput: 0,
          targetChange: 0,
          fallbackClicks: 0,
          fallbackInput: 0,
          fallbackChange: 0,
        }
        const target = document.getElementById('racing-hidden-upload')
        const button = document.getElementById('racing-upload-fallback')
        const fallback = document.getElementById('racing-fallback-input')
        target.addEventListener('input', () => { globalThis.__geometraHiddenRaceEvents.targetInput++ })
        target.addEventListener('change', () => { globalThis.__geometraHiddenRaceEvents.targetChange++ })
        button.addEventListener('click', () => {
          globalThis.__geometraHiddenRaceEvents.fallbackClicks++
          fallback.click()
        })
        fallback.addEventListener('input', () => { globalThis.__geometraHiddenRaceEvents.fallbackInput++ })
        fallback.addEventListener('change', () => { globalThis.__geometraHiddenRaceEvents.fallbackChange++ })

        const NativeMutationObserver = globalThis.MutationObserver
        let raceArmed = true
        globalThis.MutationObserver = class extends NativeMutationObserver {
          observe(observedTarget, options) {
            super.observe(observedTarget, options)
            const filter = Array.from(options?.attributeFilter ?? [])
            const isUploadCommitGuard = options?.attributeOldValue === true &&
              options?.childList === true &&
              options?.subtree === true &&
              ['accept', 'type', 'disabled', 'readonly', 'inert', 'aria-disabled', 'aria-readonly']
                .every(attribute => filter.includes(attribute))
            if (raceArmed && isUploadCommitGuard) {
              raceArmed = false
              queueMicrotask(() => { target.disabled = true })
            }
          }
        }
      </script>
    `)

    try {
      await expect(attachFiles(page, [tempFile], {
        fieldLabel: 'Resume',
        strategy: 'auto',
      })).rejects.toThrow(/upload outcome is ambiguous.*Do not retry/i)

      const result = await page.evaluate(() => ({
        events: (globalThis as unknown as {
          __geometraHiddenRaceEvents: Record<string, number>
        }).__geometraHiddenRaceEvents,
        targetDisabled: (document.getElementById('racing-hidden-upload') as HTMLInputElement).disabled,
        targetFiles: Array.from((document.getElementById('racing-hidden-upload') as HTMLInputElement).files ?? [])
          .map(file => file.name),
        fallbackFiles: Array.from((document.getElementById('racing-fallback-input') as HTMLInputElement).files ?? [])
          .map(file => file.name),
      }))
      expect(result.targetDisabled).toBe(true)
      expect(result.targetFiles).toEqual([])
      expect(result.fallbackFiles).toEqual([])
      expect(result.events.targetInput).toBeGreaterThan(0)
      expect(result.events.targetChange).toBeGreaterThan(0)
      expect(result.events).toMatchObject({ fallbackClicks: 0, fallbackInput: 0, fallbackChange: 0 })
    } finally {
      await rm(tempFile, { force: true })
      await page.close()
    }
  })

  it('marks a chooser microtask-disable race ambiguous and leaves alternate inputs untouched', async () => {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
    const tempFile = join(tmpdir(), `geometra-upload-chooser-race-${Date.now()}.txt`)
    await writeFile(tempFile, 'resume')
    await page.setContent(`
      <button id="racing-chooser-button" type="button">Choose resume</button>
      <input id="racing-chooser-input" type="file" accept=".txt" hidden />
      <input id="alternate-chooser-input" type="file" hidden />
      <script>
        globalThis.__geometraChooserRaceEvents = {
          targetInput: 0,
          targetChange: 0,
          alternateInput: 0,
          alternateChange: 0,
        }
        const button = document.getElementById('racing-chooser-button')
        const target = document.getElementById('racing-chooser-input')
        const alternate = document.getElementById('alternate-chooser-input')
        button.addEventListener('click', () => target.click())
        target.addEventListener('input', () => { globalThis.__geometraChooserRaceEvents.targetInput++ })
        target.addEventListener('change', () => { globalThis.__geometraChooserRaceEvents.targetChange++ })
        alternate.addEventListener('input', () => { globalThis.__geometraChooserRaceEvents.alternateInput++ })
        alternate.addEventListener('change', () => { globalThis.__geometraChooserRaceEvents.alternateChange++ })

      </script>
    `)

    try {
      // Force the state transition at the exact Playwright protocol boundary:
      // after Geometra has installed its commit guard, immediately before the
      // underlying FileChooser.setFiles call. Native chooser scheduling has
      // separate integration coverage and must not race this guard contract.
      const input = await page.locator('#racing-chooser-input').elementHandle()
      if (!input) throw new Error('expected racing chooser input handle')
      Object.defineProperty(page.mouse, 'click', {
        configurable: true,
        value: async () => {},
      })
      Object.defineProperty(page, 'waitForEvent', {
        configurable: true,
        value: async (eventName: string) => {
          if (eventName !== 'filechooser') throw new Error(`unexpected event ${eventName}`)
          return {
            element: () => input,
            setFiles: async (paths: string[]) => {
              await input.evaluate((el: Element) => {
                if (el instanceof HTMLInputElement) el.disabled = true
              })
              await input.setInputFiles(paths)
            },
          }
        },
      })
      const box = await page.locator('#racing-chooser-button').boundingBox()
      if (!box) throw new Error('expected racing chooser button bounds')
      await expect(attachFiles(page, [tempFile], {
        strategy: 'chooser',
        clickX: box.x + box.width / 2,
        clickY: box.y + box.height / 2,
      })).rejects.toThrow(/upload outcome is ambiguous.*Do not retry/i)

      const result = await page.evaluate(() => ({
        events: (globalThis as unknown as {
          __geometraChooserRaceEvents: Record<string, number>
        }).__geometraChooserRaceEvents,
        targetDisabled: (document.getElementById('racing-chooser-input') as HTMLInputElement).disabled,
        targetFiles: Array.from((document.getElementById('racing-chooser-input') as HTMLInputElement).files ?? [])
          .map(file => file.name),
        alternateFiles: Array.from((document.getElementById('alternate-chooser-input') as HTMLInputElement).files ?? [])
          .map(file => file.name),
      }))
      expect(result.targetDisabled).toBe(true)
      expect(result.targetFiles).toEqual([])
      expect(result.alternateFiles).toEqual([])
      expect(result.events.targetInput).toBeGreaterThan(0)
      expect(result.events.targetChange).toBeGreaterThan(0)
      expect(result.events).toMatchObject({ alternateInput: 0, alternateChange: 0 })
    } finally {
      await rm(tempFile, { force: true })
      await page.close()
    }
  })

  it('preserves a preexisting same-named selection when an ambiguous upload cannot prove replacement', async () => {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
    const tempFile = join(tmpdir(), `geometra-upload-same-name-${Date.now()}.txt`)
    await writeFile(tempFile, 'resume')
    await page.setContent(`
      <label for="same-name-upload">Resume</label>
      <input id="same-name-upload" type="file" accept=".txt" />
      <script>
        globalThis.__geometraSameNameEvents = { input: 0, change: 0 }
        const sameNameTarget = document.getElementById('same-name-upload')
        sameNameTarget.addEventListener('input', () => { globalThis.__geometraSameNameEvents.input++ })
        sameNameTarget.addEventListener('change', () => { globalThis.__geometraSameNameEvents.change++ })
        globalThis.__armGeometraSameNameRace = () => {
          const NativeMutationObserver = globalThis.MutationObserver
          let raceArmed = true
          globalThis.MutationObserver = class extends NativeMutationObserver {
            observe(observedTarget, options) {
              super.observe(observedTarget, options)
              const filter = Array.from(options?.attributeFilter ?? [])
              const isUploadCommitGuard = options?.attributeOldValue === true &&
                options?.childList === true &&
                options?.subtree === true &&
                ['accept', 'type', 'disabled', 'readonly', 'inert', 'aria-disabled', 'aria-readonly']
                  .every(attribute => filter.includes(attribute))
              if (raceArmed && isUploadCommitGuard) {
                raceArmed = false
                queueMicrotask(() => { sameNameTarget.disabled = true })
              }
            }
          }
        }
      </script>
    `)

    try {
      await attachFiles(page, [tempFile], { fieldLabel: 'Resume', strategy: 'hidden' })
      const before = await page.evaluate(() => ({
        events: { ...(globalThis as unknown as {
          __geometraSameNameEvents: { input: number; change: number }
        }).__geometraSameNameEvents },
        names: Array.from((document.getElementById('same-name-upload') as HTMLInputElement).files ?? [])
          .map(file => file.name),
      }))
      await page.evaluate(() => {
        (globalThis as unknown as { __armGeometraSameNameRace: () => void }).__armGeometraSameNameRace()
      })

      await expect(attachFiles(page, [tempFile], {
        fieldLabel: 'Resume',
        strategy: 'hidden',
      })).rejects.toThrow(/preexisting selection was preserved.*Do not retry/i)

      const after = await page.evaluate(() => ({
        events: (globalThis as unknown as {
          __geometraSameNameEvents: { input: number; change: number }
        }).__geometraSameNameEvents,
        disabled: (document.getElementById('same-name-upload') as HTMLInputElement).disabled,
        names: Array.from((document.getElementById('same-name-upload') as HTMLInputElement).files ?? [])
          .map(file => file.name),
      }))
      expect(before.names).toEqual([tempFile.split('/').pop()])
      expect(after.names).toEqual(before.names)
      expect(after.disabled).toBe(true)
      // Playwright suppresses change/input for a same-path reselection. The
      // guard must still report ambiguity without erasing the indistinguishable
      // preexisting value or manufacturing cleanup events.
      expect(after.events).toEqual(before.events)
    } finally {
      await rm(tempFile, { force: true })
      await page.close()
    }
  })

  it('enforces file context and section constraints for standalone and batch fills', async () => {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
    const tempFile = join(tmpdir(), `geometra-upload-scope-${Date.now()}.txt`)
    await writeFile(tempFile, 'document')
    await page.setContent(`
      <section aria-label="Application materials">
        <div id="resume-card"><h3>Candidate resume</h3><label>Document <input id="resume-doc" type="file" /></label></div>
        <div id="cover-card"><h3>Cover letter</h3><label>Document <input id="cover-doc" type="file" /></label></div>
      </section>
    `)

    try {
      await attachFiles(page, [tempFile], {
        fieldLabel: 'Document',
        contextText: 'Candidate resume',
        sectionText: 'Application materials',
      })
      expect(await page.locator('#resume-doc').evaluate((el: HTMLInputElement) => el.files?.length ?? 0)).toBe(1)
      expect(await page.locator('#cover-doc').evaluate((el: HTMLInputElement) => el.files?.length ?? 0)).toBe(0)

      await fillFields(page, [{
        kind: 'file',
        fieldLabel: 'Document',
        paths: [tempFile],
        contextText: 'Cover letter',
        sectionText: 'Application materials',
      }])
      expect(await page.locator('#cover-doc').evaluate((el: HTMLInputElement) => el.files?.length ?? 0)).toBe(1)

      await page.locator('#resume-card').evaluate(card => {
        card.insertAdjacentHTML('beforeend', '<label>Document <input id="resume-duplicate" type="file" /></label>')
      })
      await expect(attachFiles(page, [tempFile], {
        fieldLabel: 'Document',
        contextText: 'Candidate resume',
        sectionText: 'Application materials',
      })).rejects.toThrow('ambiguous scoped match')
      expect(await page.locator('#resume-duplicate').evaluate((el: HTMLInputElement) => el.files?.length ?? 0)).toBe(0)
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

  it('prefers an authored name fieldKey over duplicate labels', async () => {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
    await page.setContent(`
      <label>Full name <input id="first-name" name="first" /></label>
      <label>Full name <input id="target-name" name="applicant:target" /></label>
    `)

    await setFieldText(page, 'Full name', 'Taylor Applicant', {
      fieldKey: `name:input:default:${encodeURIComponent('applicant:target')}`,
    })

    expect(await page.locator('#first-name').inputValue()).toBe('')
    expect(await page.locator('#target-name').inputValue()).toBe('Taylor Applicant')
    await page.close()
  })

  it('does not retain a negative field lookup across a reactive render', async () => {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
    const cache = createFillLookupCache()
    await page.setContent('<main id="root"></main>')

    await expect(setFieldText(page, 'Email', 'first@example.com', { cache })).rejects.toThrow('no visible editable field')
    await page.locator('#root').evaluate(root => {
      root.innerHTML = '<label for="email">Email</label><input id="email" />'
    })
    await setFieldText(page, 'Email', 'second@example.com', { cache })

    expect(await page.locator('#email').inputValue()).toBe('second@example.com')
    await page.close()
  })

  it('refuses native and effective read-only text controls without mutating them', async () => {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
    await page.setContent(`
      <label>Disabled name <input id="disabled-name" disabled /></label>
      <label>Read only name <input id="readonly-name" readonly /></label>
      <div aria-disabled="true">
        <div id="aria-name" role="textbox" contenteditable="true" aria-label="ARIA name">original</div>
      </div>
      <div id="aria-readonly-name" role="textbox" contenteditable="true" aria-label="ARIA readonly name" aria-readonly="true">original</div>
      <div inert><label>Inert name <input id="inert-name" /></label></div>
      <fieldset disabled><label>Fieldset name <input id="fieldset-name" /></label></fieldset>
      <fieldset disabled><legend><label>Legend name <input id="legend-name" /></label></legend></fieldset>
    `)

    for (const label of ['Disabled name', 'Read only name', 'ARIA name', 'ARIA readonly name', 'Inert name', 'Fieldset name']) {
      await expect(setFieldText(page, label, 'Alice', { exact: true })).rejects.toThrow('not mutable')
    }
    await setFieldText(page, 'Legend name', 'Allowed', { exact: true })

    expect(await page.locator('#disabled-name').inputValue()).toBe('')
    expect(await page.locator('#readonly-name').inputValue()).toBe('')
    expect(await page.locator('#aria-name').textContent()).toBe('original')
    expect(await page.locator('#aria-readonly-name').textContent()).toBe('original')
    expect(await page.locator('#inert-name').inputValue()).toBe('')
    expect(await page.locator('#fieldset-name').inputValue()).toBe('')
    expect(await page.locator('#legend-name').inputValue()).toBe('Allowed')
    await page.close()
  })

  it('rechecks text mutability in the same page task as the commit', async () => {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
    await page.setContent(`
      <label>Reactive name <input id="reactive-name" /></label>
      <script>
        const input = document.getElementById('reactive-name')
        const nativeMatches = Element.prototype.matches
        let disabledChecks = 0
        window.textMutationEvents = []
        input.matches = function(selector) {
          const result = nativeMatches.call(this, selector)
          if (selector === ':disabled' && ++disabledChecks === 2) {
            queueMicrotask(() => { input.disabled = true })
          }
          return result
        }
        input.addEventListener('input', () => window.textMutationEvents.push('input'))
        input.addEventListener('change', () => window.textMutationEvents.push('change'))
      </script>
    `)

    await expect(setFieldText(page, 'Reactive name', 'Alice', { exact: true })).rejects.toThrow('not mutable')
    expect(await page.locator('#reactive-name').inputValue()).toBe('')
    expect(await page.evaluate(() => (window as unknown as { textMutationEvents: string[] }).textMutationEvents)).toEqual([])
    await page.close()
  })

  it('does not accept substring-only text readback as success', async () => {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
    await page.setContent(`
      <label for="name">Name</label><input id="name" />
      <script>
        const input = document.getElementById('name')
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
        input.addEventListener('input', () => setter.call(input, 'WRONG:' + input.value), { once: true })
      </script>
    `)

    await expect(setFieldText(page, 'Name', 'Alice', { exact: true })).rejects.toThrow('could not confirm value')
    expect(await page.locator('#name').inputValue()).toBe('WRONG:Alice')
    await page.close()
  })

  it('accepts formatting-only telephone readback without relaxing ordinary text matching', async () => {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
    await page.setContent(`
      <label>Phone <input id="phone" type="tel" /></label>
      <label>Reference <input id="reference" type="text" /></label>
      <script>
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
        for (const id of ['phone', 'reference']) {
          const input = document.getElementById(id)
          input.addEventListener('input', () => setter.call(input, '+1 929-608-1737'), { once: true })
        }
      </script>
    `)

    await expect(setFieldText(page, 'Phone', '+19296081737', { exact: true })).resolves.toBeUndefined()
    expect(await page.locator('#phone').inputValue()).toBe('+1 929-608-1737')

    await expect(setFieldText(page, 'Reference', '+19296081737', { exact: true })).rejects.toThrow('could not confirm value')
    expect(await page.locator('#reference').inputValue()).toBe('+1 929-608-1737')
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

  it('accepts an extractor fieldKey and exact label for a wrapped native select', async () => {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
    await page.setContent(`
      <label>
        Preferred location
        <select id="location">
          <option value="">Choose one</option>
          <option>Berlin, Germany</option>
        </select>
      </label>
    `)

    await setFieldChoice(page, 'Preferred location', 'Berlin, Germany', {
      fieldKey: 'id:location',
      choiceType: 'select',
      exact: true,
    })

    expect(await page.locator('#location').inputValue()).toBe('Berlin, Germany')
    await page.close()
  })

  it('does not let an authored key target a differently labeled native select', async () => {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
    await page.setContent(`
      <label>
        Billing location
        <select id="location">
          <option value="">Choose one</option>
          <option>Berlin, Germany</option>
        </select>
      </label>
      <label>
        Preferred location
        <select id="preferred-location">
          <option value="">Choose one</option>
          <option>Berlin, Germany</option>
        </select>
      </label>
    `)

    await expect(setFieldChoice(page, 'Preferred location', 'Berlin, Germany', {
      fieldKey: 'id:location',
      choiceType: 'select',
      exact: true,
    })).rejects.toThrow('fieldKey "id:location" did not match field label "Preferred location"')

    expect(await page.locator('#location').inputValue()).toBe('')
    expect(await page.locator('#preferred-location').inputValue()).toBe('')
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

  it('prefers an authored fieldKey over duplicate select labels', async () => {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
    await page.setContent(`
      <label>Country <select id="billing-country" name="billing"><option>Canada</option><option>Germany</option></select></label>
      <label>Country <select id="work-country" name="work:country"><option>Canada</option><option>Germany</option></select></label>
    `)

    await setFieldChoice(page, 'Country', 'Germany', {
      fieldKey: `name:select:default:${encodeURIComponent('work:country')}`,
      choiceType: 'select',
    })

    expect(await page.locator('#billing-country').inputValue()).toBe('Canada')
    expect(await page.locator('#work-country').inputValue()).toBe('Germany')
    await page.close()
  })

  it('selects the exact native option index when labels and values collide or repeat', async () => {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
    await page.setContent(`
      <label for="office">Office</label>
      <select id="office">
        <option value="wrong-value">nyc-alt</option>
        <option value="nyc-alt">New York primary</option>
        <option value="nyc-alt">New York alternate</option>
      </select>
    `)

    await setFieldChoice(page, 'Office', 'nyc-alt', {
      fieldKey: 'id:office',
      choiceType: 'select',
      exact: true,
      optionIndex: 2,
    })

    expect(await page.locator('#office').evaluate(el => (el as HTMLSelectElement).selectedIndex)).toBe(2)
    expect(await page.locator('#office option').nth(2).evaluate(el => (el as HTMLOptionElement).selected)).toBe(true)
    await page.close()
  })

  it('rejects an option index that no longer has the resolved submitted value', async () => {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
    await page.setContent(`
      <label for="office">Office</label>
      <select id="office">
        <option value="">Choose an office</option>
        <option value="la">Los Angeles</option>
        <option value="nyc-alt">New York alternate</option>
      </select>
    `)

    await expect(setFieldChoice(page, 'Office', 'nyc-alt', {
      fieldKey: 'id:office',
      choiceType: 'select',
      exact: true,
      optionIndex: 1,
    })).rejects.toThrow('no enabled <option> matching "nyc-alt"')

    expect(await page.locator('#office').evaluate(el => (el as HTMLSelectElement).selectedIndex)).toBe(0)
    await page.close()
  })

  it('cross-checks coordinate option indices and rejects disabled optgroups', async () => {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
    await page.setContent(`
      <label for="office">Office</label>
      <select id="office" style="margin:24px;width:240px;height:40px">
        <option value="">Choose an office</option>
        <optgroup label="Closed" disabled>
          <option value="legacy">Legacy office</option>
        </optgroup>
        <option value="nyc">New York</option>
      </select>
      <script>
        window.selectClickCount = 0
        office.addEventListener('click', () => { window.selectClickCount += 1 })
      </script>
    `)
    const box = await page.locator('#office').boundingBox()
    if (!box) throw new Error('expected select bounds')
    const x = box.x + box.width / 2
    const y = box.y + box.height / 2

    await expect(selectNativeOption(page, x, y, { index: 1, value: 'legacy' })).rejects.toThrow('selectOption:')
    expect(await page.locator('#office').evaluate(el => (el as HTMLSelectElement).selectedIndex)).toBe(0)

    await expect(selectNativeOption(page, x, y, { index: 2, value: 'legacy' })).rejects.toThrow('selectOption:')
    expect(await page.locator('#office').evaluate(el => (el as HTMLSelectElement).selectedIndex)).toBe(0)
    expect(await page.evaluate(() => (window as unknown as { selectClickCount: number }).selectClickCount)).toBe(0)
    await page.close()
  })

  it('rejects non-select coordinates without clicking a submit control', async () => {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
    await page.setContent(`
      <form id="application">
        <button id="submit" type="submit" style="margin:24px;width:240px;height:40px">Submit application</button>
      </form>
      <script>
        window.submitClickCount = 0
        window.submitEventCount = 0
        submit.addEventListener('click', () => { window.submitClickCount += 1 })
        application.addEventListener('submit', event => {
          event.preventDefault()
          window.submitEventCount += 1
        })
      </script>
    `)
    const box = await page.locator('#submit').boundingBox()
    if (!box) throw new Error('expected submit bounds')

    await expect(selectNativeOption(page, box.x + box.width / 2, box.y + box.height / 2, {
      label: 'United States',
    })).rejects.toThrow('do not target a native <select>')
    expect(await page.evaluate(() => ({
      clicks: (window as unknown as { submitClickCount: number }).submitClickCount,
      submits: (window as unknown as { submitEventCount: number }).submitEventCount,
    }))).toEqual({ clicks: 0, submits: 0 })
    await page.close()
  })

  it('jointly enforces native option identity and detects handler reverts', async () => {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
    await page.setContent(`
      <select id="country" style="margin:24px;width:240px;height:40px">
        <option value="ca">Canada</option>
        <option value="de">Germany</option>
        <option value="us">United States</option>
      </select>
    `)
    const box = await page.locator('#country').boundingBox()
    if (!box) throw new Error('expected select bounds')
    const x = box.x + box.width / 2
    const y = box.y + box.height / 2

    await expect(selectNativeOption(page, x, y, {
      index: 1,
      value: 'de',
      label: 'United States',
    })).rejects.toThrow('selectOption:')
    expect(await page.locator('#country').inputValue()).toBe('ca')

    await selectNativeOption(page, x, y, { index: 1, value: 'de', label: 'Germany' })
    expect(await page.locator('#country').inputValue()).toBe('de')
    await page.locator('#country').selectOption('ca')
    await page.locator('#country').evaluate(select => {
      select.addEventListener('change', () => setTimeout(() => { (select as HTMLSelectElement).selectedIndex = 0 }, 0), { once: true })
    })
    await expect(selectNativeOption(page, x, y, { index: 1, value: 'de', label: 'Germany' })).rejects.toThrow('selectOption:')
    expect(await page.locator('#country').inputValue()).toBe('ca')
    await page.close()
  })

  it('does not reuse a keyed cache entry after DOM reorder or fall back when the key is stale', async () => {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
    const cache = createFillLookupCache()
    await page.setContent(`
      <main id="root">
        <label>Country <select id="work-country"><option>Canada</option><option>Germany</option></select></label>
      </main>
    `)

    await setFieldChoice(page, 'Country', 'Germany', {
      fieldKey: 'id:work-country',
      choiceType: 'select',
      cache,
    })
    await page.locator('#root').evaluate(root => {
      root.insertAdjacentHTML('afterbegin', '<label>Country <select id="other-country"><option>Canada</option><option>Germany</option></select></label>')
    })
    await setFieldChoice(page, 'Country', 'Canada', {
      fieldKey: 'id:work-country',
      choiceType: 'select',
      cache,
    })

    expect(await page.locator('#work-country').inputValue()).toBe('Canada')
    expect(await page.locator('#other-country').inputValue()).toBe('Canada')

    await page.locator('#work-country').evaluate(el => el.remove())
    await expect(setFieldChoice(page, 'Country', 'Germany', {
      fieldKey: 'id:work-country',
      choiceType: 'select',
      cache,
    })).rejects.toThrow('fieldKey "id:work-country" did not resolve')
    expect(await page.locator('#other-country').inputValue()).toBe('Canada')
    await page.close()
  })

  it('refuses options disabled through their parent optgroup', async () => {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
    await page.setContent(`
      <label for="region">Region</label>
      <select id="region">
        <option value="open">Open region</option>
        <optgroup label="Unavailable" disabled>
          <option value="closed">Closed region</option>
        </optgroup>
      </select>
    `)

    await expect(setFieldChoice(page, 'Region', 'closed', {
      fieldKey: 'id:region',
      choiceType: 'select',
      exact: true,
    })).rejects.toThrow('no enabled <option>')
    expect(await page.locator('#region').inputValue()).toBe('open')
    await page.close()
  })

  it('refuses disabled native and ARIA-disabled custom choice controls', async () => {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
    await page.setContent(`
      <label for="country">Country</label>
      <select id="country" disabled><option>Canada</option><option>Germany</option></select>
      <label id="office-label">Office</label>
      <button id="office" role="combobox" aria-labelledby="office-label" aria-haspopup="listbox" aria-disabled="true">Choose</button>
      <div id="office-options" role="listbox" hidden><button role="option">Berlin</button></div>
      <script>
        office.addEventListener('click', () => { officeOptions.hidden = false })
      </script>
    `)

    await expect(setFieldChoice(page, 'Country', 'Germany', { exact: true })).rejects.toThrow('not mutable')
    expect(await page.locator('#country').inputValue()).toBe('Canada')
    const countryBox = await page.locator('#country').boundingBox()
    if (!countryBox) throw new Error('expected disabled select bounds')
    await expect(selectNativeOption(page, countryBox.x + countryBox.width / 2, countryBox.y + countryBox.height / 2, {
      label: 'Germany',
    })).rejects.toThrow('not mutable')
    expect(await page.locator('#country').inputValue()).toBe('Canada')
    await expect(setFieldChoice(page, 'Office', 'Berlin', { exact: true })).rejects.toThrow('not mutable')
    expect(await page.locator('#office-options').isHidden()).toBe(true)
    await page.close()
  })

  it('rechecks native-select mutability in the same page task as the commit', async () => {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
    await page.setContent(`
      <label for="reactive-country">Reactive country</label>
      <select id="reactive-country">
        <option value="ca">Canada</option>
        <option value="de">Germany</option>
      </select>
      <script>
        const select = document.getElementById('reactive-country')
        const nativeMatches = Element.prototype.matches
        let disabledChecks = 0
        window.selectMutationEvents = []
        select.matches = function(selector) {
          const result = nativeMatches.call(this, selector)
          if (selector === ':disabled' && ++disabledChecks === 2) {
            queueMicrotask(() => { select.disabled = true })
          }
          return result
        }
        select.addEventListener('input', () => window.selectMutationEvents.push('input'))
        select.addEventListener('change', () => window.selectMutationEvents.push('change'))
      </script>
    `)

    await expect(setFieldChoice(page, 'Reactive country', 'de', { exact: true })).rejects.toThrow()
    expect(await page.locator('#reactive-country').inputValue()).toBe('ca')
    expect(await page.evaluate(() => (window as unknown as { selectMutationEvents: string[] }).selectMutationEvents)).toEqual([])
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

  it('does not let the native batch path bypass disabled or readonly states', async () => {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
    await page.setContent(`
      <label>Full name <input id="full-name" disabled /></label>
      <label>Email <input id="email" readonly /></label>
      <label>Country <select id="country" disabled><option>Canada</option><option>Germany</option></select></label>
      <label>Consent <input id="consent" type="checkbox" disabled /></label>
    `)

    await expect(fillFields(page, [
      { kind: 'auto', fieldLabel: 'Full name', value: 'Alice' },
      { kind: 'auto', fieldLabel: 'Email', value: 'alice@example.com' },
      { kind: 'auto', fieldLabel: 'Country', value: 'Germany' },
      { kind: 'auto', fieldLabel: 'Consent', value: true },
    ])).rejects.toThrow('partial batch failure')

    expect(await page.locator('#full-name').inputValue()).toBe('')
    expect(await page.locator('#email').inputValue()).toBe('')
    expect(await page.locator('#country').inputValue()).toBe('Canada')
    expect(await page.locator('#consent').isChecked()).toBe(false)
    await page.close()
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

  it('fills a wrapped native select through the extractor fieldKey and exact label pair', async () => {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
    await page.setContent(`
      <label>
        Preferred location
        <select id="location">
          <option value="">Choose one</option>
          <option>Berlin, Germany</option>
        </select>
      </label>
    `)

    await fillFields(page, [{
      kind: 'choice',
      fieldKey: 'id:location',
      fieldLabel: 'Preferred location',
      value: 'Berlin, Germany',
      choiceType: 'select',
      exact: true,
    }])

    expect(await page.locator('#location').inputValue()).toBe('Berlin, Germany')
    await page.close()
  })

  it('preserves an exact option index through batched choice filling', async () => {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
    await page.setContent(`
      <label for="office">Office</label>
      <select id="office">
        <option value="wrong-value">nyc-alt</option>
        <option value="nyc-alt">New York primary</option>
        <option value="nyc-alt">New York alternate</option>
      </select>
    `)

    await fillFields(page, [{
      kind: 'choice',
      fieldLabel: 'Office',
      value: 'nyc-alt',
      optionIndex: 2,
      choiceType: 'select',
      exact: true,
    }])

    expect(await page.locator('#office').evaluate(el => (el as HTMLSelectElement).selectedIndex)).toBe(2)
    await page.close()
  })

  it('does not let a keyed auto fill fall back to a duplicate label', async () => {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
    await page.setContent(`
      <label><input id="first-consent" type="checkbox" /> Consent</label>
      <label><input id="second-consent" type="checkbox" /> Consent</label>
    `)

    await expect(fillFields(page, [{
      kind: 'auto',
      fieldKey: 'id:missing-consent',
      fieldLabel: 'Consent',
      value: true,
    }])).rejects.toThrow('fieldKey "id:missing-consent" did not resolve')

    expect(await page.locator('#first-consent').isChecked()).toBe(false)
    expect(await page.locator('#second-consent').isChecked()).toBe(false)
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

  it('matches and verifies an open-shadow radio using shadow-local IDREFs', async () => {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
    await page.setContent(`
      <span id="toggle-label">Wrong light-DOM label</span>
      <span id="missing-toggle-label">Leaked light-DOM option</span>
      <div id="toggle-host"></div>
    `)
    await page.evaluate(() => {
      const root = document.getElementById('toggle-host')!.attachShadow({ mode: 'open' })
      root.innerHTML = `
        <style>input { width:24px;height:24px }</style>
        <span id="toggle-label">Shadow-local option</span>
        <input type="radio" name="shadow-choice" aria-labelledby="toggle-label" />
        <input type="radio" name="missing-choice" aria-labelledby="missing-toggle-label" />
      `
    })

    await expect(setCheckedControl(page, 'Wrong light-DOM label', {
      checked: true,
      exact: true,
      controlType: 'radio',
    })).rejects.toThrow('no visible radio')

    await expect(setCheckedControl(page, 'Leaked light-DOM option', {
      checked: true,
      exact: true,
      controlType: 'radio',
    })).rejects.toThrow('no visible radio')

    await setCheckedControl(page, 'Shadow-local option', {
      checked: true,
      exact: true,
      controlType: 'radio',
    })

    expect(await page.locator('#toggle-host').locator('input[name="shadow-choice"]').isChecked()).toBe(true)
    await page.close()
  })

  it('refuses disabled and effectively disabled toggles without firing handlers', async () => {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
    await page.setContent(`
      <label><input id="native-disabled" type="checkbox" disabled /> Native disabled</label>
      <div aria-disabled="true">
        <div id="aria-disabled" role="checkbox" aria-checked="false" aria-label="ARIA disabled" tabindex="0" style="width:24px;height:24px"></div>
      </div>
      <script>
        window.toggleClicks = 0
        const custom = document.getElementById('aria-disabled')
        custom.addEventListener('click', () => {
          window.toggleClicks++
          custom.setAttribute('aria-checked', 'true')
        })
      </script>
    `)

    await expect(setCheckedControl(page, 'Native disabled', { exact: true })).rejects.toThrow('not mutable')
    await expect(setCheckedControl(page, 'ARIA disabled', { exact: true })).rejects.toThrow('not mutable')
    expect(await page.locator('#native-disabled').isChecked()).toBe(false)
    expect(await page.locator('#aria-disabled').getAttribute('aria-checked')).toBe('false')
    expect(await page.evaluate(() => (window as unknown as { toggleClicks: number }).toggleClicks)).toBe(0)
    await page.close()
  })

  it('rejects blank labels without mutating a control', async () => {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
    await page.setContent('<label><input id="consent" type="checkbox" /> Consent</label>')

    await expect(setCheckedControl(page, '   ')).rejects.toThrow('label must be a trimmed, non-empty string')
    expect(await page.locator('#consent').isChecked()).toBe(false)
    await page.close()
  })

  it('prefers an exact toggle label and rejects unresolved ambiguity', async () => {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
    await page.setContent(`
      <label><input id="consent-details" type="checkbox" /> Consent details</label>
      <label><input id="consent" type="checkbox" /> Consent</label>
      <fieldset id="authorization"><legend>Work authorization</legend><label><input id="auth-yes" type="radio" name="auth" /> Yes</label></fieldset>
      <fieldset id="sponsorship"><legend>Sponsorship</legend><label><input id="sponsor-yes" type="radio" name="sponsor" /> Yes</label></fieldset>
    `)

    await setCheckedControl(page, 'Consent')
    expect(await page.locator('#consent').isChecked()).toBe(true)
    expect(await page.locator('#consent-details').isChecked()).toBe(false)

    await expect(setCheckedControl(page, 'Yes')).rejects.toThrow('ambiguous label "Yes" matched 2 controls')
    expect(await page.locator('#auth-yes').isChecked()).toBe(false)
    expect(await page.locator('#sponsor-yes').isChecked()).toBe(false)

    await setCheckedControl(page, 'Yes', { contextText: 'Sponsorship' })
    expect(await page.locator('#auth-yes').isChecked()).toBe(false)
    expect(await page.locator('#sponsor-yes').isChecked()).toBe(true)
    await page.close()
  })

  it('prefers an authored toggle fieldKey across duplicate labels', async () => {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
    await page.setContent(`
      <label><input id="first-consent" type="checkbox" /> Consent</label>
      <label><input id="target:consent" type="checkbox" /> Consent</label>
    `)

    await setCheckedControl(page, 'Consent', {
      fieldKey: `id:${encodeURIComponent('target:consent')}`,
    })

    expect(await page.locator('#first-consent').isChecked()).toBe(false)
    expect(await page.locator('[id="target:consent"]').isChecked()).toBe(true)
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

  it('guards every OTP cell before the setFieldText fast path clears or types', async () => {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
    await page.setContent(`
      <style>.otp { display:flex; gap:8px }.otp input { width:40px; height:48px }</style>
      <label for="guard-cell-0">Security code</label>
      <div class="otp" data-otp>
        <input id="guard-cell-0" maxlength="1" value="A" />
        <input id="guard-cell-1" maxlength="1" value="B" readonly />
        <input id="guard-cell-2" maxlength="1" value="C" />
        <input id="guard-cell-3" maxlength="1" value="D" />
      </div>
    `)

    await expect(setFieldText(page, 'Security code', '1234')).rejects.toThrow('OTP cell 2: matched control is not mutable')
    expect(await page.locator('.otp input').evaluateAll(inputs => inputs.map(input => (input as HTMLInputElement).value))).toEqual(['A', 'B', 'C', 'D'])
    await page.close()
  })

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
