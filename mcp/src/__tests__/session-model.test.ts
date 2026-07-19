import { describe, expect, it } from 'vitest'
import {
  buildA11yTree,
  buildCompactUiIndex,
  buildFormGraphs,
  buildFormRequiredSnapshot,
  buildFormSchemas,
  buildPageModel,
  expandPageSection,
  buildUiDelta,
  hasUiDelta,
  summarizeUiDelta,
} from '../session.js'
import type { A11yNode } from '../session.js'

function node(
  role: string,
  name: string | undefined,
  bounds: { x: number; y: number; width: number; height: number },
  options?: {
    path?: number[]
    focusable?: boolean
    value?: string
    state?: A11yNode['state']
    validation?: A11yNode['validation']
    meta?: A11yNode['meta']
    children?: A11yNode[]
  },
): A11yNode {
  return {
    role,
    ...(name ? { name } : {}),
    ...(options?.value ? { value: options.value } : {}),
    ...(options?.state ? { state: options.state } : {}),
    ...(options?.validation ? { validation: options.validation } : {}),
    ...(options?.meta ? { meta: options.meta } : {}),
    bounds,
    path: options?.path ?? [],
    children: options?.children ?? [],
    focusable: options?.focusable ?? false,
  }
}

describe('buildPageModel', () => {
  it('builds a summary-first page model with stable section ids', () => {
    const tree = node('group', undefined, { x: 0, y: 0, width: 1024, height: 768 }, {
      children: [
        node('navigation', 'Primary nav', { x: 0, y: 0, width: 220, height: 80 }, { path: [0] }),
        node('main', undefined, { x: 0, y: 80, width: 1024, height: 688 }, {
          path: [1],
          children: [
            node('form', 'Job application', { x: 40, y: 120, width: 520, height: 280 }, {
              path: [1, 0],
              children: [
                node('textbox', 'Full name', { x: 60, y: 160, width: 300, height: 36 }, { path: [1, 0, 0] }),
                node('textbox', 'Email', { x: 60, y: 208, width: 300, height: 36 }, { path: [1, 0, 1] }),
                node('button', 'Submit application', { x: 60, y: 264, width: 180, height: 40 }, {
                  path: [1, 0, 2],
                  focusable: true,
                }),
              ],
            }),
            node('list', 'Open roles', { x: 600, y: 120, width: 360, height: 280 }, {
              path: [1, 1],
              children: [
                node('listitem', 'Designer', { x: 620, y: 148, width: 320, height: 32 }, { path: [1, 1, 0] }),
                node('listitem', 'Engineer', { x: 620, y: 188, width: 320, height: 32 }, { path: [1, 1, 1] }),
              ],
            }),
          ],
        }),
      ],
    })

    const model = buildPageModel(tree)

    expect(model.viewport).toEqual({ width: 1024, height: 768 })
    expect(model.archetypes).toEqual(expect.arrayContaining(['shell', 'form', 'results']))
    expect(model.summary).toEqual({
      landmarkCount: 3,
      formCount: 1,
      dialogCount: 0,
      listCount: 1,
      focusableCount: 1,
    })
    expect(model.landmarks.map(item => item.id)).toEqual(['lm:0', 'lm:1', 'lm:1.0'])
    expect(model.forms).toHaveLength(1)
    expect(model.forms[0]).toMatchObject({
      id: 'fm:1.0',
      name: 'Job application',
      fieldCount: 2,
      actionCount: 1,
    })
    expect(model.lists[0]).toMatchObject({
      id: 'ls:1.1',
      name: 'Open roles',
      itemCount: 2,
    })
    expect(model.primaryActions).toEqual([
      expect.objectContaining({
        id: 'n:1.0.2',
        role: 'button',
        name: 'Submit application',
      }),
    ])
  })

  it('surfaces blocked-site detection from challenge copy', () => {
    const tree = node('group', undefined, { x: 0, y: 0, width: 1024, height: 768 }, {
      meta: { pageUrl: 'https://jobs.example.com/apply' },
      children: [
        node('main', 'Checking your browser before accessing this page', { x: 0, y: 0, width: 1024, height: 768 }, {
          path: [0],
          children: [
            node('group', 'Please verify you are human', { x: 320, y: 240, width: 400, height: 120 }, {
              path: [0, 0],
            }),
          ],
        }),
      ],
    })

    const model = buildPageModel(tree)

    expect(model.blockedSite).toMatchObject({
      detected: true,
      type: 'cloudflare-challenge',
      recommendedAction: 'manual-handoff',
    })
  })

  it('can disable blocked-site detection while keeping the rest of the page model', () => {
    const tree = node('group', undefined, { x: 0, y: 0, width: 1024, height: 768 }, {
      children: [
        node('main', 'Access denied', { x: 0, y: 0, width: 1024, height: 768 }, { path: [0] }),
      ],
    })

    const model = buildPageModel(tree, { blockDetection: false })

    expect(model.blockedSite).toBeUndefined()
    expect(model.summary.landmarkCount).toBe(1)
  })

  it('adds nearby item context to repeated primary actions', () => {
    const tree = node('group', undefined, { x: 0, y: 0, width: 1024, height: 768 }, {
      children: [
        node('main', undefined, { x: 0, y: 0, width: 1024, height: 768 }, {
          path: [0],
          children: [
            node('group', undefined, { x: 40, y: 80, width: 320, height: 140 }, {
              path: [0, 0],
              children: [
                node('link', 'Sauce Labs Backpack', { x: 56, y: 96, width: 180, height: 24 }, {
                  path: [0, 0, 0],
                  focusable: true,
                }),
                node('button', 'Add to cart', { x: 56, y: 156, width: 120, height: 36 }, {
                  path: [0, 0, 1],
                  focusable: true,
                }),
              ],
            }),
            node('group', undefined, { x: 40, y: 252, width: 320, height: 140 }, {
              path: [0, 1],
              children: [
                node('link', 'Sauce Labs Bike Light', { x: 56, y: 268, width: 180, height: 24 }, {
                  path: [0, 1, 0],
                  focusable: true,
                }),
                node('button', 'Add to cart', { x: 56, y: 328, width: 120, height: 36 }, {
                  path: [0, 1, 1],
                  focusable: true,
                }),
              ],
            }),
          ],
        }),
      ],
    })

    const model = buildPageModel(tree, { maxPrimaryActions: 4 })
    const addToCartActions = model.primaryActions.filter(action => action.name === 'Add to cart')

    expect(addToCartActions).toHaveLength(2)
    expect(addToCartActions[0]).toMatchObject({
      id: 'n:0.0.1',
      context: { item: 'Sauce Labs Backpack' },
    })
    expect(addToCartActions[1]).toMatchObject({
      id: 'n:0.1.1',
      context: { item: 'Sauce Labs Bike Light' },
    })
  })

  it('expands a section by id on demand', () => {
    const tree = node('group', undefined, { x: 0, y: 0, width: 1024, height: 768 }, {
      children: [
        node('main', undefined, { x: 0, y: 0, width: 1024, height: 768 }, {
          path: [0],
          children: [
            node('form', 'Job application', { x: 40, y: 120, width: 520, height: 280 }, {
              path: [0, 0],
              children: [
                node('heading', 'Application', { x: 60, y: 132, width: 200, height: 24 }, { path: [0, 0, 0] }),
                node('textbox', 'Full name*', { x: 60, y: 160, width: 300, height: 36 }, {
                  path: [0, 0, 1],
                  value: 'Taylor Applicant',
                  state: { required: true },
                }),
                node('textbox', 'Email:', { x: 60, y: 208, width: 300, height: 36 }, {
                  path: [0, 0, 2],
                  value: 'taylor@example.com',
                  state: { invalid: true, required: true },
                  validation: { error: 'Please enter a valid email address.' },
                }),
                node('button', 'Submit application', { x: 60, y: 264, width: 180, height: 40 }, {
                  path: [0, 0, 3],
                  focusable: true,
                }),
              ],
            }),
          ],
        }),
      ],
    })

    const detail = expandPageSection(tree, 'fm:0.0')

    expect(detail).toMatchObject({
      id: 'fm:0.0',
      kind: 'form',
      role: 'form',
      name: 'Application',
      summary: {
        headingCount: 1,
        fieldCount: 2,
        requiredFieldCount: 2,
        invalidFieldCount: 1,
        actionCount: 1,
      },
      page: {
        fields: { offset: 0, returned: 2, total: 2, hasMore: false },
        actions: { offset: 0, returned: 1, total: 1, hasMore: false },
      },
    })
    expect(detail?.fields.map(field => field.name)).toEqual(['Full name', 'Email'])
    expect(detail?.fields.map(field => field.value)).toEqual(['Taylor Applicant', 'taylor@example.com'])
    expect(detail?.fields[0]?.state).toEqual({ required: true })
    expect(detail?.fields[1]?.state).toEqual({ invalid: true, required: true })
    expect(detail?.fields[1]?.validation).toEqual({ error: 'Please enter a valid email address.' })
    expect(detail?.fields[1]?.visibility).toMatchObject({ intersectsViewport: true, fullyVisible: true })
    expect(detail?.actions[0]?.scrollHint).toMatchObject({ status: 'visible' })
    expect(detail?.actions.map(action => action.id)).toEqual(['n:0.0.3'])
    expect(detail?.fields[0]).not.toHaveProperty('bounds')
  })

  it('paginates long sections and carries context on repeated answers', () => {
    const tree = node('group', undefined, { x: 0, y: 0, width: 900, height: 700 }, {
      children: [
        node('form', 'Application', { x: 20, y: -120, width: 760, height: 1800 }, {
          path: [0],
          children: [
            node('heading', 'Application', { x: 40, y: 40, width: 240, height: 28 }, { path: [0, 0] }),
            node('textbox', 'Full name', { x: 48, y: 120, width: 320, height: 36 }, {
              path: [0, 1],
              state: { required: true },
            }),
            node('textbox', 'Email', { x: 48, y: 176, width: 320, height: 36 }, {
              path: [0, 2],
              state: { required: true, invalid: true },
              validation: { error: 'Enter a valid email.' },
            }),
            node('textbox', 'Phone', { x: 48, y: 232, width: 320, height: 36 }, {
              path: [0, 3],
              state: { required: true },
            }),
            node('group', undefined, { x: 40, y: 980, width: 520, height: 96 }, {
              path: [0, 4],
              children: [
                node('text', 'Are you legally authorized to work here?', { x: 48, y: 980, width: 340, height: 24 }, {
                  path: [0, 4, 0],
                }),
                node('button', 'Yes', { x: 48, y: 1020, width: 88, height: 40 }, {
                  path: [0, 4, 1],
                  focusable: true,
                }),
                node('button', 'No', { x: 148, y: 1020, width: 88, height: 40 }, {
                  path: [0, 4, 2],
                  focusable: true,
                }),
              ],
            }),
            node('group', undefined, { x: 40, y: 1120, width: 520, height: 96 }, {
              path: [0, 5],
              children: [
                node('text', 'Will you require sponsorship?', { x: 48, y: 1120, width: 260, height: 24 }, {
                  path: [0, 5, 0],
                }),
                node('button', 'Yes', { x: 48, y: 1160, width: 88, height: 40 }, {
                  path: [0, 5, 1],
                  focusable: true,
                }),
                node('button', 'No', { x: 148, y: 1160, width: 88, height: 40 }, {
                  path: [0, 5, 2],
                  focusable: true,
                }),
              ],
            }),
            node('button', 'Submit application', { x: 48, y: 1540, width: 180, height: 40 }, {
              path: [0, 6],
              focusable: true,
            }),
          ],
        }),
      ],
    })

    const detail = expandPageSection(tree, 'fm:0', {
      maxFields: 2,
      fieldOffset: 1,
      onlyRequiredFields: true,
    })

    expect(detail).toMatchObject({
      summary: {
        fieldCount: 3,
        requiredFieldCount: 3,
        invalidFieldCount: 1,
        actionCount: 5,
      },
      page: {
        fields: { offset: 1, returned: 2, total: 3, hasMore: false },
        actions: { offset: 0, returned: 5, total: 5, hasMore: false },
      },
    })
    expect(detail?.fields.map(field => field.name)).toEqual(['Email', 'Phone'])
    expect(detail?.fields[0]?.scrollHint).toMatchObject({ status: 'visible' })
    const authorizedYes = detail?.actions.find(action =>
      action.name === 'Yes' && action.context?.prompt === 'Are you legally authorized to work here?',
    )
    const sponsorshipYes = detail?.actions.find(action =>
      action.name === 'Yes' && action.context?.prompt === 'Will you require sponsorship?',
    )
    expect(authorizedYes).toMatchObject({
      name: 'Yes',
      context: { prompt: 'Are you legally authorized to work here?', section: 'Application' },
      visibility: { fullyVisible: false, offscreenBelow: true },
    })
    expect(sponsorshipYes).toMatchObject({
      name: 'Yes',
      context: { prompt: 'Will you require sponsorship?', section: 'Application' },
      visibility: { fullyVisible: false, offscreenBelow: true },
    })
  })

  it('drops noisy container names and falls back to unnamed summaries', () => {
    const tree = node('group', undefined, { x: 0, y: 0, width: 800, height: 600 }, {
      children: [
        node(
          'form',
          'First Name* Last Name* Email* Phone* Country* Location* Resume* LinkedIn*',
          { x: 20, y: 20, width: 500, height: 400 },
          { path: [0] },
        ),
      ],
    })

    const model = buildPageModel(tree)

    expect(model.forms[0]?.id).toBe('fm:0')
    expect(model.forms[0]?.name).toBeUndefined()
  })
})

describe('buildFormSchemas', () => {
  it('projects discovered schemas into FormGraph-compatible graphs', () => {
    const tree = node('group', undefined, { x: 0, y: 0, width: 900, height: 700 }, {
      meta: { pageUrl: 'https://jobs.example.com/apply' },
      children: [
        node('form', 'Application', { x: 20, y: 20, width: 760, height: 480 }, {
          path: [0],
          children: [
            node('textbox', 'Full name', { x: 40, y: 60, width: 320, height: 36 }, {
              path: [0, 0],
              state: { required: true },
              meta: { placeholder: 'Legal name', inputType: 'text' },
            }),
            node('group', undefined, { x: 40, y: 120, width: 520, height: 96 }, {
              path: [0, 1],
              children: [
                node('text', 'Are you authorized to work in the United States?', { x: 48, y: 120, width: 420, height: 24 }, {
                  path: [0, 1, 0],
                }),
                node('button', 'Yes', { x: 48, y: 160, width: 88, height: 40 }, {
                  path: [0, 1, 1],
                  focusable: true,
                  state: { required: true },
                }),
                node('button', 'No', { x: 148, y: 160, width: 88, height: 40 }, {
                  path: [0, 1, 2],
                  focusable: true,
                }),
              ],
            }),
          ],
        }),
      ],
    })

    const graphs = buildFormGraphs(tree)

    expect(graphs).toHaveLength(1)
    expect(graphs[0]).toMatchObject({
      formgraph: '0.1',
      id: 'geometra:fm:0',
      title: 'Application',
      sources: [{ id: 'geometra-page', kind: 'html', url: 'https://jobs.example.com/apply' }],
      review: { autoSubmitAllowed: false, requiredBeforeSubmit: true },
      fields: [
        {
          id: 'ff:0.0',
          path: 'web.forms.application.full.name',
          label: 'Full name',
          kind: 'text',
          required: true,
          aliases: ['Legal name'],
          sourceAnchors: [{ sourceId: 'geometra-page', kind: 'html', fieldName: 'ff:0.0' }],
        },
        {
          id: 'ff:0.1',
          path: 'web.forms.application.are.you.authorized.to.work.in.the.united.states',
          label: 'Are you authorized to work in the United States?',
          kind: 'boolean',
          required: true,
          options: [
            { value: 'Yes', label: 'Yes' },
            { value: 'No', label: 'No' },
          ],
        },
      ],
    })
  })

  it('builds a compact fill-oriented schema and collapses repeated answer groups', () => {
    const longEssay = 'Semantic browser automation should be reliable, compact, and predictable across large forms.'
    const tree = node('group', undefined, { x: 0, y: 0, width: 1024, height: 768 }, {
      children: [
        node('form', 'Application', { x: 32, y: 32, width: 760, height: 1500 }, {
          path: [0],
          children: [
            node('textbox', 'Full name', { x: 48, y: 120, width: 320, height: 36 }, {
              path: [0, 0],
              state: { required: true },
            }),
            node('combobox', 'Preferred location', { x: 48, y: 180, width: 320, height: 36 }, {
              path: [0, 1],
              state: { required: true },
              value: 'Berlin, Germany',
              meta: { controlTag: 'select' },
            }),
            node('group', undefined, { x: 40, y: 260, width: 520, height: 96 }, {
              path: [0, 2],
              children: [
                node('text', 'Are you legally authorized to work in Germany?', { x: 48, y: 260, width: 360, height: 24 }, {
                  path: [0, 2, 0],
                }),
                node('button', 'Yes', { x: 48, y: 300, width: 88, height: 40 }, {
                  path: [0, 2, 1],
                  focusable: true,
                  state: { required: true },
                }),
                node('button', 'No', { x: 148, y: 300, width: 88, height: 40 }, {
                  path: [0, 2, 2],
                  focusable: true,
                }),
              ],
            }),
            node('checkbox', 'Share my profile for future roles', { x: 48, y: 400, width: 24, height: 24 }, {
              path: [0, 3],
              focusable: true,
              state: { checked: true },
            }),
            node('textbox', 'Why Geometra?', { x: 48, y: 480, width: 520, height: 180 }, {
              path: [0, 4],
              state: { required: true, invalid: true },
              validation: { error: 'Please enter at least 40 characters.' },
              value: longEssay,
            }),
          ],
        }),
      ],
    })

    const schemas = buildFormSchemas(tree)

    expect(schemas).toHaveLength(1)
    expect(schemas[0]).toMatchObject({
      formId: 'fm:0',
      name: 'Application',
      fieldCount: 5,
      requiredCount: 4,
      invalidCount: 1,
    })
    expect(schemas[0]?.fields).toEqual([
      expect.objectContaining({
        kind: 'text',
        label: 'Full name',
        required: true,
      }),
      expect.objectContaining({
        kind: 'choice',
        label: 'Preferred location',
        choiceType: 'select',
        required: true,
        value: 'Berlin, Germany',
      }),
      expect.objectContaining({
        kind: 'choice',
        label: 'Are you legally authorized to work in Germany?',
        choiceType: 'group',
        required: true,
        optionCount: 2,
        booleanChoice: true,
      }),
      expect.objectContaining({
        kind: 'toggle',
        label: 'Share my profile for future roles',
        checked: true,
        controlType: 'checkbox',
      }),
      expect.objectContaining({
        kind: 'text',
        label: 'Why Geometra?',
        required: true,
        invalid: true,
        valueLength: longEssay.length,
      }),
    ])
    expect(schemas[0]?.fields[2]).not.toHaveProperty('options')
  })

  it('includes explicit options when requested and prefers question prompts over nearby explanatory copy', () => {
    const tree = node('group', undefined, { x: 0, y: 0, width: 900, height: 700 }, {
      children: [
        node('form', 'Application', { x: 20, y: 20, width: 760, height: 480 }, {
          path: [0],
          children: [
            node('group', undefined, { x: 32, y: 80, width: 520, height: 120 }, {
              path: [0, 0],
              children: [
                node('text', 'Will you now or in the future require sponsorship?', { x: 40, y: 80, width: 420, height: 24 }, {
                  path: [0, 0, 0],
                }),
                node('text', 'This intentionally repeats Yes / No labels to test contextual disambiguation.', { x: 40, y: 112, width: 520, height: 24 }, {
                  path: [0, 0, 1],
                }),
                node('button', 'Yes', { x: 40, y: 152, width: 88, height: 40 }, {
                  path: [0, 0, 2],
                  focusable: true,
                }),
                node('button', 'No', { x: 140, y: 152, width: 88, height: 40 }, {
                  path: [0, 0, 3],
                  focusable: true,
                }),
              ],
            }),
          ],
        }),
      ],
    })

    const schema = buildFormSchemas(tree, { includeOptions: true, includeContext: 'always' })[0]
    expect(schema?.fields[0]).toMatchObject({
      kind: 'choice',
      choiceType: 'group',
      label: 'Will you now or in the future require sponsorship?',
      options: ['Yes', 'No'],
      booleanChoice: true,
      context: {
        section: 'Application',
      },
    })
  })

  it('surfaces exact native option values and authored field identity without treating disabled choices as selectable', () => {
    const tree = node('group', undefined, { x: 0, y: 0, width: 900, height: 700 }, {
      children: [
        node('form', 'Application', { x: 20, y: 20, width: 760, height: 480 }, {
          path: [0],
          children: [
            node('combobox', 'Office', { x: 40, y: 80, width: 320, height: 36 }, {
              path: [0, 0],
              meta: {
                controlTag: 'select',
                controlKey: 'id:office-select',
                controlId: 'office-select',
                options: [
                  { value: '', label: 'Choose an office', disabled: true, selected: true, index: 0 },
                  { value: 'nyc', label: 'New York', disabled: false, selected: false, index: 1 },
                  { value: 'nyc-alt', label: 'New York', disabled: false, selected: false, index: 2 },
                  { value: 'nyc', label: 'New York', disabled: false, selected: false, index: 3 },
                ],
              },
            }),
          ],
        }),
      ],
    })

    const compact = buildFormSchemas(tree)[0]?.fields[0]
    expect(compact).toMatchObject({
      id: 'id:office-select',
      fieldKey: 'id:office-select',
      kind: 'choice',
      choiceType: 'select',
      optionCount: 4,
    })
    expect(compact).not.toHaveProperty('options')
    expect(compact).not.toHaveProperty('optionDetails')

    const detailed = buildFormSchemas(tree, { includeOptions: true })[0]?.fields[0]
    expect(detailed?.options).toEqual(['New York'])
    expect(detailed?.optionDetails).toEqual([
      {
        id: 'id:office-select:option:0',
        value: '',
        label: 'Choose an office',
        index: 0,
        disabled: true,
        selected: true,
      },
      { id: 'id:office-select:option:1', value: 'nyc', label: 'New York', index: 1 },
      { id: 'id:office-select:option:2', value: 'nyc-alt', label: 'New York', index: 2 },
      { id: 'id:office-select:option:3', value: 'nyc', label: 'New York', index: 3 },
    ])

    const graphField = buildFormGraphs(tree)[0]?.fields[0]
    expect(graphField).toMatchObject({
      id: 'id:office-select',
      sourceAnchors: [{
        fieldName: 'id:office-select',
        pointer: 'geometra:id:office-select',
      }],
      options: [
        { value: 'nyc', label: 'New York' },
        { value: 'nyc-alt', label: 'New York' },
        { value: 'nyc', label: 'New York' },
      ],
      metadata: {
        geometra: {
          fieldId: 'id:office-select',
          fieldKey: 'id:office-select',
          optionDetails: expect.arrayContaining([
            expect.objectContaining({ id: 'id:office-select:option:0', disabled: true }),
          ]),
        },
      },
    })
  })

  it('preserves required file inputs and their upload constraints in form schemas', () => {
    const tree = node('group', undefined, { x: 0, y: 0, width: 900, height: 700 }, {
      children: [
        node('form', 'Application', { x: 20, y: 20, width: 760, height: 480 }, {
          path: [0],
          children: [
            node('button', 'Resume', { x: 40, y: 80, width: 320, height: 36 }, {
              path: [0, 0],
              focusable: true,
              state: { required: true },
              meta: {
                controlTag: 'input',
                controlKey: 'id:resume-upload',
                controlId: 'resume-upload',
                fileInput: true,
                inputType: 'file',
                accept: '.pdf,.doc,.docx',
                multiple: true,
              },
            }),
          ],
        }),
      ],
    })

    const schema = buildFormSchemas(tree)[0]
    expect(schema).toMatchObject({
      fieldCount: 1,
      requiredCount: 1,
      fields: [{
        id: 'id:resume-upload',
        fieldKey: 'id:resume-upload',
        kind: 'file',
        label: 'Resume',
        required: true,
        format: {
          inputType: 'file',
          accept: '.pdf,.doc,.docx',
          multiple: true,
        },
      }],
    })

    expect(buildFormGraphs(tree)[0]?.fields[0]).toMatchObject({
      id: 'id:resume-upload',
      kind: 'text',
      metadata: {
        inputType: 'file',
        geometra: {
          kind: 'file',
          format: {
            inputType: 'file',
            accept: '.pdf,.doc,.docx',
            multiple: true,
          },
        },
      },
    })
    expect(buildPageModel(tree).forms[0]).toMatchObject({
      fieldCount: 1,
    })
  })

  it('counts file inputs when inferring forms without a native form landmark', () => {
    const tree = node('group', undefined, { x: 0, y: 0, width: 900, height: 700 }, {
      children: [
        node('region', 'Application', { x: 20, y: 20, width: 760, height: 480 }, {
          path: [0],
          children: [
            node('textbox', 'Full name', { x: 40, y: 80, width: 320, height: 36 }, {
              path: [0, 0],
            }),
            node('button', undefined, { x: 40, y: 140, width: 320, height: 36 }, {
              path: [0, 1],
              state: { required: true },
              meta: {
                fileInput: true,
                inputType: 'file',
                controlKey: 'name:input:file:resume',
                controlName: 'resume',
              },
            }),
          ],
        }),
      ],
    })

    expect(buildFormSchemas(tree)[0]).toMatchObject({
      name: 'Application',
      fieldCount: 2,
      requiredCount: 1,
      fields: [
        { kind: 'text', label: 'Full name' },
        {
          id: 'name:input:file:resume',
          fieldKey: 'name:input:file:resume',
          kind: 'file',
          label: 'resume',
          required: true,
        },
      ],
    })
  })

  it('infers a standalone required upload surface without a native form landmark', () => {
    const tree = node('group', undefined, { x: 0, y: 0, width: 900, height: 700 }, {
      children: [
        node('region', 'Documents', { x: 20, y: 20, width: 760, height: 240 }, {
          path: [0],
          children: [
            node('button', 'Resume', { x: 40, y: 80, width: 320, height: 36 }, {
              path: [0, 0],
              state: { required: true },
              meta: {
                fileInput: true,
                inputType: 'file',
                accept: '.pdf',
                controlKey: 'id:resume-upload',
              },
            }),
          ],
        }),
      ],
    })

    expect(buildFormSchemas(tree)).toEqual([
      expect.objectContaining({
        name: 'Documents',
        fieldCount: 1,
        requiredCount: 1,
        fields: [expect.objectContaining({
          id: 'id:resume-upload',
          kind: 'file',
          label: 'Resume',
          required: true,
          format: expect.objectContaining({ accept: '.pdf' }),
        })],
      }),
    ])
  })

  it('deduplicates nested inferred containers that expose the same standalone upload', () => {
    const tree = node('group', undefined, { x: 0, y: 0, width: 900, height: 700 }, {
      children: [
        node('region', 'Documents', { x: 20, y: 20, width: 760, height: 240 }, {
          path: [0],
          children: [
            node('group', undefined, { x: 32, y: 48, width: 700, height: 160 }, {
              path: [0, 0],
              children: [
                node('button', 'Resume', { x: 40, y: 80, width: 320, height: 36 }, {
                  path: [0, 0, 0],
                  state: { required: true },
                  meta: {
                    fileInput: true,
                    inputType: 'file',
                    controlKey: 'id:resume-upload',
                  },
                }),
              ],
            }),
          ],
        }),
      ],
    })

    const schemas = buildFormSchemas(tree)
    expect(schemas).toHaveLength(1)
    expect(schemas[0]).toMatchObject({
      formId: 'fm:0',
      name: 'Documents',
      fieldCount: 1,
      fields: [{ id: 'id:resume-upload', kind: 'file', label: 'Resume' }],
    })
  })

  it('uses authored identities only when unique and keeps keyed fields in form sections', () => {
    const uniqueTree = node('group', undefined, { x: 0, y: 0, width: 900, height: 700 }, {
      children: [
        node('form', 'Application', { x: 20, y: 20, width: 760, height: 480 }, {
          path: [0],
          children: [
            node('group', 'Personal details', { x: 30, y: 40, width: 700, height: 180 }, {
              path: [0, 0],
              children: [
                node('textbox', 'Email', { x: 40, y: 80, width: 320, height: 36 }, {
                  path: [0, 0, 0],
                  meta: { controlKey: 'id:application-email' },
                }),
              ],
            }),
          ],
        }),
      ],
    })

    expect(buildFormSchemas(uniqueTree)[0]).toMatchObject({
      fields: [{ id: 'id:application-email', fieldKey: 'id:application-email' }],
      sections: [{ name: 'Personal details', fieldIds: ['id:application-email'] }],
    })

    const duplicateTree = node('group', undefined, { x: 0, y: 0, width: 900, height: 700 }, {
      children: [
        node('form', 'Application', { x: 20, y: 20, width: 760, height: 480 }, {
          path: [0],
          children: [
            node('textbox', 'Primary email', { x: 40, y: 80, width: 320, height: 36 }, {
              path: [0, 0],
              meta: { controlKey: 'name:input:email:contact' },
            }),
            node('textbox', 'Backup email', { x: 40, y: 140, width: 320, height: 36 }, {
              path: [0, 1],
              meta: { controlKey: 'name:input:email:contact' },
            }),
          ],
        }),
      ],
    })

    const duplicateFields = buildFormSchemas(duplicateTree)[0]?.fields ?? []
    expect(duplicateFields.map(field => field.id)).toEqual(['ff:0.0', 'ff:0.1'])
    expect(duplicateFields.every(field => field.fieldKey === undefined)).toBe(true)
  })

  // Bug #3 regression (v1.43): a React Select / Headless UI / Radix
  // autocomplete combobox renders as a plain <input role="textbox"> in the
  // accessibility tree. The extractor tags it with meta.isAutocompleteCombobox
  // when its ancestry matches the autocomplete-wrapper fingerprint
  // (see isAutocompleteComboboxAncestry in packages/proxy/src/extractor.ts,
  // which mirrors isAutocompleteCombobox in packages/proxy/src/dom-actions.ts).
  // The form-schema classifier MUST re-tag that field as choice/listbox so
  // fill_form routes it through pick_listbox_option — otherwise Greenhouse
  // Remix Country pickers (and every other React Select) get fed through
  // the plain text-fill path, the controlled form state never commits, and
  // Submit fails with "This field is required" while the field looks filled.
  it('re-classifies autocomplete-combobox-wrapped textboxes as choice/listbox', () => {
    const tree = node('group', undefined, { x: 0, y: 0, width: 900, height: 700 }, {
      children: [
        node('form', 'Address', { x: 20, y: 20, width: 760, height: 480 }, {
          path: [0],
          children: [
            // A plain text field — should stay classified as `text`.
            node('textbox', 'Postal code', { x: 40, y: 60, width: 200, height: 36 }, {
              path: [0, 0],
              state: { required: true },
              meta: { controlTag: 'input', inputType: 'text' },
            }),
            // The React Select Country picker: role=textbox but the
            // extractor flagged its ancestry as autocomplete-combobox. The
            // classifier must re-tag this as choice/listbox.
            node('textbox', 'Country', { x: 40, y: 120, width: 320, height: 36 }, {
              path: [0, 1],
              state: { required: true, invalid: true },
              meta: {
                controlTag: 'input',
                isAutocompleteCombobox: true,
              },
            }),
            // A real native <combobox> wrapping a <select> — should stay
            // classified as choice/select (NOT listbox) because the
            // controlTag is 'select' and no autocomplete flag is set.
            node('combobox', 'State / Region', { x: 40, y: 180, width: 320, height: 36 }, {
              path: [0, 2],
              state: { required: true },
              value: 'California',
              meta: { controlTag: 'select' },
            }),
          ],
        }),
      ],
    })

    const schemas = buildFormSchemas(tree)
    expect(schemas).toHaveLength(1)
    const fields = schemas[0]?.fields ?? []
    expect(fields).toHaveLength(3)
    expect(fields[0]).toMatchObject({
      kind: 'text',
      label: 'Postal code',
      required: true,
    })
    // Critical assertion: the Country textbox comes out as a listbox
    // choice so fill_form will use pick_listbox_option.
    expect(fields[1]).toMatchObject({
      kind: 'choice',
      choiceType: 'listbox',
      label: 'Country',
      required: true,
      invalid: true,
    })
    // Back-compat: native <select> still classified as choice/select.
    expect(fields[2]).toMatchObject({
      kind: 'choice',
      choiceType: 'select',
      label: 'State / Region',
      required: true,
      value: 'California',
    })
  })
})

describe('buildFormRequiredSnapshot', () => {
  it('keeps offscreen required fields with bounds, visibility, and scroll hints', () => {
    const tree = node('group', undefined, { x: 0, y: 0, width: 900, height: 700 }, {
      children: [
        node('form', 'Application', { x: 20, y: -160, width: 760, height: 2200 }, {
          path: [0],
          children: [
            node('textbox', 'Full name', { x: 48, y: 120, width: 320, height: 36 }, {
              path: [0, 0],
              state: { required: true },
              meta: { controlKey: 'id:full-name' },
            }),
            node('combobox', 'Preferred location', { x: 48, y: 940, width: 320, height: 36 }, {
              path: [0, 1],
              state: { required: true },
              meta: { controlTag: 'select' },
            }),
            node('group', undefined, { x: 40, y: 1260, width: 520, height: 96 }, {
              path: [0, 2],
              children: [
                node('text', 'Will you require sponsorship?', { x: 48, y: 1260, width: 320, height: 24 }, {
                  path: [0, 2, 0],
                }),
                node('button', 'Yes', { x: 48, y: 1300, width: 88, height: 40 }, {
                  path: [0, 2, 1],
                  focusable: true,
                  state: { required: true },
                }),
                node('button', 'No', { x: 148, y: 1300, width: 88, height: 40 }, {
                  path: [0, 2, 2],
                  focusable: true,
                }),
              ],
            }),
          ],
        }),
      ],
    })

    const snapshot = buildFormRequiredSnapshot(tree, { includeOptions: true })

    expect(snapshot).toHaveLength(1)
    expect(snapshot[0]).toMatchObject({
      formId: 'fm:0',
      name: 'Application',
      requiredCount: 3,
      fields: [
        {
          id: 'id:full-name',
          fieldKey: 'id:full-name',
          label: 'Full name',
          visibility: { intersectsViewport: true, fullyVisible: true },
          scrollHint: { status: 'visible' },
          bounds: { x: 48, y: 120, width: 320, height: 36 },
        },
        {
          id: 'ff:0.1',
          label: 'Preferred location',
          choiceType: 'select',
          visibility: { intersectsViewport: false, offscreenBelow: true },
          scrollHint: { status: 'offscreen' },
          bounds: { x: 48, y: 940, width: 320, height: 36 },
        },
        {
          id: 'ff:0.2',
          label: 'Will you require sponsorship?',
          choiceType: 'group',
          visibility: { intersectsViewport: false, offscreenBelow: true },
          scrollHint: { status: 'offscreen' },
          bounds: { x: 40, y: 1260, width: 520, height: 96 },
          options: ['Yes', 'No'],
        },
      ],
    })
  })
})

describe('buildUiDelta', () => {
  it('captures opened dialogs, state changes, and list count changes', () => {
    const before = node('group', undefined, { x: 0, y: 0, width: 1024, height: 768 }, {
      children: [
        node('main', undefined, { x: 0, y: 0, width: 1024, height: 768 }, {
          path: [0],
          children: [
            node('button', 'Save', { x: 40, y: 40, width: 120, height: 40 }, {
              path: [0, 0],
              focusable: true,
            }),
            node('list', 'Results', { x: 40, y: 120, width: 400, height: 240 }, {
              path: [0, 1],
              children: [
                node('listitem', 'Row 1', { x: 60, y: 144, width: 360, height: 32 }, { path: [0, 1, 0] }),
                node('listitem', 'Row 2', { x: 60, y: 184, width: 360, height: 32 }, { path: [0, 1, 1] }),
              ],
            }),
          ],
        }),
      ],
    })

    const after = node('group', undefined, { x: 0, y: 0, width: 1024, height: 768 }, {
      children: [
        node('main', undefined, { x: 0, y: 0, width: 1024, height: 768 }, {
          path: [0],
          children: [
            node('button', 'Save', { x: 40, y: 40, width: 120, height: 40 }, {
              path: [0, 0],
              focusable: true,
              state: { disabled: true },
            }),
            node('list', 'Results', { x: 40, y: 120, width: 400, height: 280 }, {
              path: [0, 1],
              children: [
                node('listitem', 'Row 1', { x: 60, y: 144, width: 360, height: 32 }, { path: [0, 1, 0] }),
                node('listitem', 'Row 2', { x: 60, y: 184, width: 360, height: 32 }, { path: [0, 1, 1] }),
                node('listitem', 'Row 3', { x: 60, y: 224, width: 360, height: 32 }, { path: [0, 1, 2] }),
              ],
            }),
            node('dialog', 'Save complete', { x: 520, y: 80, width: 280, height: 180 }, {
              path: [0, 2],
              children: [
                node('button', 'Close', { x: 620, y: 200, width: 100, height: 36 }, {
                  path: [0, 2, 0],
                  focusable: true,
                }),
              ],
            }),
          ],
        }),
      ],
    })

    const delta = buildUiDelta(before, after)

    expect(hasUiDelta(delta)).toBe(true)
    expect(delta.dialogsOpened).toHaveLength(1)
    expect(delta.dialogsOpened[0]?.id).toBe('dg:0.2')
    expect(delta.dialogsOpened[0]?.name).toBe('Save complete')
    expect(delta.listCountsChanged).toEqual([
      { id: 'ls:0.1', name: 'Results', beforeCount: 2, afterCount: 3 },
    ])
    expect(delta.updated.some(update =>
      update.after.name === 'Save' && update.changes.some(change => change.includes('disabled')),
    )).toBe(true)

    const summary = summarizeUiDelta(delta)
    expect(summary).toContain('+ dg:0.2 dialog "Save complete" opened')
    expect(summary).toContain('~ ls:0.1 list "Results" items 2 -> 3')
    expect(summary).toContain('~ n:0.0 button "Save": disabled unset -> true')
  })

  it('surfaces checkbox checked-state changes in semantic deltas', () => {
    const before = node('group', undefined, { x: 0, y: 0, width: 640, height: 480 }, {
      children: [
        node('form', 'Application', { x: 20, y: 20, width: 600, height: 220 }, {
          path: [0],
          children: [
            node('checkbox', 'New York, NY', { x: 40, y: 80, width: 24, height: 24 }, {
              path: [0, 0],
              focusable: true,
              state: { checked: false },
            }),
          ],
        }),
      ],
    })

    const after = node('group', undefined, { x: 0, y: 0, width: 640, height: 480 }, {
      children: [
        node('form', 'Application', { x: 20, y: 20, width: 600, height: 220 }, {
          path: [0],
          children: [
            node('checkbox', 'New York, NY', { x: 40, y: 80, width: 24, height: 24 }, {
              path: [0, 0],
              focusable: true,
              state: { checked: true },
            }),
          ],
        }),
      ],
    })

    const delta = buildUiDelta(before, after)
    const summary = summarizeUiDelta(delta)

    expect(delta.updated.some(update =>
      update.after.role === 'checkbox' && update.changes.includes('checked false -> true'),
    )).toBe(true)
    expect(summary).toContain('~ n:0.0 checkbox "New York, NY": checked false -> true')
  })

  it('keeps pinned context nodes and reports viewport/focus/navigation drift', () => {
    const before = node('group', undefined, { x: 0, y: 0, width: 900, height: 700 }, {
      meta: { pageUrl: 'https://jobs.example.com/apply', scrollX: 0, scrollY: 120 },
      children: [
        node('tablist', 'Application tabs', { x: 16, y: -64, width: 420, height: 40 }, { path: [0] }),
        node('form', 'Application', { x: 24, y: -20, width: 760, height: 1400 }, {
          path: [1],
          children: [
            node('textbox', 'Full name', { x: 48, y: 140, width: 320, height: 36 }, {
              path: [1, 0],
              focusable: true,
              state: { focused: true },
            }),
          ],
        }),
      ],
    })

    const after = node('group', undefined, { x: 0, y: 0, width: 900, height: 700 }, {
      meta: { pageUrl: 'https://jobs.example.com/apply?step=details', scrollX: 0, scrollY: 420 },
      children: [
        node('tablist', 'Application tabs', { x: 16, y: -96, width: 420, height: 40 }, { path: [0] }),
        node('form', 'Application', { x: 24, y: -320, width: 760, height: 1400 }, {
          path: [1],
          children: [
            node('textbox', 'Country', { x: 48, y: 182, width: 320, height: 36 }, {
              path: [1, 1],
              focusable: true,
              state: { focused: true },
            }),
          ],
        }),
      ],
    })

    const compact = buildCompactUiIndex(before, { maxNodes: 20 })
    expect(compact.context.pageUrl).toBe('https://jobs.example.com/apply')
    expect(compact.context.scrollY).toBe(120)
    expect(compact.context.focusedNode?.name).toBe('Full name')
    expect(compact.nodes.some(item => item.role === 'tablist' && item.pinned)).toBe(true)
    expect(compact.nodes.some(item => item.role === 'form' && item.pinned)).toBe(true)

    const delta = buildUiDelta(before, after)
    const summary = summarizeUiDelta(delta)

    expect(delta.navigation).toEqual({
      beforeUrl: 'https://jobs.example.com/apply',
      afterUrl: 'https://jobs.example.com/apply?step=details',
    })
    expect(delta.viewport).toEqual({
      beforeScrollX: 0,
      beforeScrollY: 120,
      afterScrollX: 0,
      afterScrollY: 420,
    })
    expect(delta.focus?.before?.name).toBe('Full name')
    expect(delta.focus?.after?.name).toBe('Country')
    expect(summary).toContain('~ viewport scroll (0,120) -> (0,420)')
    expect(summary).toContain('~ focus n:1.0 textbox "Full name" -> n:1.1 textbox "Country"')
    expect(summary).toContain('~ navigation "https://jobs.example.com/apply" -> "https://jobs.example.com/apply?step=details"')
  })

  it('includes control values in compact indexes and semantic deltas', () => {
    const before = node('group', undefined, { x: 0, y: 0, width: 640, height: 480 }, {
      children: [
        node('textbox', 'Location', { x: 20, y: 40, width: 280, height: 36 }, {
          path: [0],
          focusable: true,
          value: 'Austin',
        }),
      ],
    })

    const after = node('group', undefined, { x: 0, y: 0, width: 640, height: 480 }, {
      children: [
        node('textbox', 'Location', { x: 20, y: 40, width: 280, height: 36 }, {
          path: [0],
          focusable: true,
          value: 'Austin, Texas, United States',
        }),
      ],
    })

    const compact = buildCompactUiIndex(after, { maxNodes: 10 })
    expect(compact.nodes[0]).toMatchObject({
      role: 'textbox',
      name: 'Location',
      value: 'Austin, Texas, United States',
    })

    const delta = buildUiDelta(before, after)
    expect(delta.updated).toEqual([
      expect.objectContaining({
        changes: [
          'value "Austin" -> "Austin, Texas, United States"',
        ],
      }),
    ])
    expect(summarizeUiDelta(delta)).toContain('value "Austin" -> "Austin, Texas, United States"')
  })
})

describe('buildA11yTree', () => {
  it('maps required, invalid, busy, and validation text from raw semantic nodes', () => {
    const tree = {
      kind: 'box',
      props: {},
      semantic: {},
      children: [
        {
          kind: 'box',
          props: { value: '' },
          semantic: {
            role: 'textbox',
            ariaLabel: 'Email',
            ariaRequired: true,
            ariaInvalid: true,
            ariaBusy: true,
            validationDescription: 'We will contact you about this role.',
            validationError: 'Please enter a valid email address.',
          },
          handlers: { onClick: true, onKeyDown: true },
        },
      ],
    } as Record<string, unknown>

    const layout = {
      x: 0,
      y: 0,
      width: 800,
      height: 600,
      children: [
        {
          x: 24,
          y: 40,
          width: 320,
          height: 36,
          children: [],
        },
      ],
    } as Record<string, unknown>

    const a11y = buildA11yTree(tree, layout)
    expect(a11y.children[0]).toMatchObject({
      role: 'textbox',
      name: 'Email',
      state: { required: true, invalid: true, busy: true },
      validation: {
        description: 'We will contact you about this role.',
        error: 'Please enter a valid email address.',
      },
    })
  })

  it('keeps coordinate-only closed-root controls visible without advertising them as fillable fields', () => {
    const tree = {
      kind: 'box',
      props: {},
      semantic: { tag: 'form', role: 'form', ariaLabel: 'Application' },
      children: [
        {
          kind: 'box',
          props: {},
          semantic: {
            tag: 'input',
            a11yRoleHint: 'textbox',
            ariaLabel: 'Secret field',
            coordinateOnly: true,
            shadowMode: 'closed',
          },
          handlers: { onClick: true, onKeyDown: true },
        },
        {
          kind: 'box',
          props: {},
          semantic: { tag: 'div', role: 'group' },
          children: [
            {
              kind: 'box',
              props: {},
              semantic: { a11yRoleHint: 'radio', ariaLabel: 'Yes', coordinateOnly: true },
              handlers: { onClick: true },
            },
            {
              kind: 'box',
              props: {},
              semantic: { a11yRoleHint: 'radio', ariaLabel: 'No', coordinateOnly: true },
              handlers: { onClick: true },
            },
          ],
        },
        {
          kind: 'box',
          props: {},
          semantic: { tag: 'input', role: 'textbox', ariaLabel: 'Email' },
          handlers: { onClick: true, onKeyDown: true },
        },
      ],
    } as Record<string, unknown>
    const layout = {
      x: 0,
      y: 0,
      width: 800,
      height: 600,
      children: [
        { x: 24, y: 40, width: 320, height: 36, children: [] },
        {
          x: 24,
          y: 96,
          width: 320,
          height: 48,
          children: [
            { x: 24, y: 96, width: 80, height: 36, children: [] },
            { x: 120, y: 96, width: 80, height: 36, children: [] },
          ],
        },
        { x: 24, y: 160, width: 320, height: 36, children: [] },
      ],
    } as Record<string, unknown>

    const a11y = buildA11yTree(tree, layout)
    expect(a11y.children[0]).toMatchObject({
      role: 'textbox',
      name: 'Secret field',
      meta: { coordinateOnly: true },
    })
    expect(a11y.children[1]?.children).toEqual([
      expect.objectContaining({ role: 'radio', name: 'Yes', meta: { coordinateOnly: true } }),
      expect.objectContaining({ role: 'radio', name: 'No', meta: { coordinateOnly: true } }),
    ])
    expect(buildFormSchemas(a11y)[0]).toMatchObject({
      fieldCount: 1,
      fields: [{ kind: 'text', label: 'Email' }],
    })
  })

  it('preserves authored field identity and structured native option metadata', () => {
    const tree = {
      kind: 'box',
      props: {},
      semantic: {},
      children: [
        {
          kind: 'box',
          props: {},
          semantic: {
            tag: 'select',
            role: 'combobox',
            ariaLabel: 'Office',
            controlKey: 'name:select:default:office',
            controlName: 'office',
            options: [
              { value: '', label: 'Choose an office', disabled: true, selected: true, index: 0 },
              { value: 'nyc', label: 'New York', disabled: false, selected: false, index: 1 },
              { value: 'nyc-alt', label: 'New York', disabled: false, selected: false, index: 2 },
            ],
          },
          handlers: { onClick: true, onKeyDown: true },
        },
      ],
    } as Record<string, unknown>
    const layout = {
      x: 0,
      y: 0,
      width: 800,
      height: 600,
      children: [{ x: 24, y: 40, width: 320, height: 36, children: [] }],
    } as Record<string, unknown>

    const a11y = buildA11yTree(tree, layout)

    expect(a11y.children[0]?.meta).toMatchObject({
      controlTag: 'select',
      controlKey: 'name:select:default:office',
      controlName: 'office',
      options: [
        { value: '', label: 'Choose an office', disabled: true, selected: true, index: 0 },
        { value: 'nyc', label: 'New York', disabled: false, selected: false, index: 1 },
        { value: 'nyc-alt', label: 'New York', disabled: false, selected: false, index: 2 },
      ],
    })
  })

  it('maps file input identity and constraints from raw semantic nodes', () => {
    const tree = {
      kind: 'box',
      props: {},
      semantic: {},
      children: [{
        kind: 'box',
        props: {},
        semantic: {
          tag: 'input',
          role: 'button',
          ariaLabel: 'Resume',
          ariaRequired: true,
          controlKey: 'id:resume-upload',
          fileInput: true,
          inputType: 'file',
          accept: '.pdf',
          multiple: true,
        },
        handlers: { onClick: true },
      }],
    } as Record<string, unknown>
    const layout = {
      x: 0,
      y: 0,
      width: 800,
      height: 600,
      children: [{ x: 24, y: 40, width: 320, height: 36, children: [] }],
    } as Record<string, unknown>

    const file = buildA11yTree(tree, layout).children[0]
    expect(file).toMatchObject({
      role: 'button',
      name: 'Resume',
      state: { required: true },
      meta: {
        controlTag: 'input',
        controlKey: 'id:resume-upload',
        fileInput: true,
        inputType: 'file',
        accept: '.pdf',
        multiple: true,
      },
    })
  })
})
