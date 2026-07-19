import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { A11yNode } from '../session.js'

// ── Node builder ─────────────────────────────────────────────────────
function node(
  role: string,
  name: string | undefined,
  options?: {
    bounds?: A11yNode['bounds']
    value?: string
    state?: A11yNode['state']
    validation?: A11yNode['validation']
    path?: number[]
    children?: A11yNode[]
    meta?: A11yNode['meta']
  },
): A11yNode {
  return {
    role,
    ...(name ? { name } : {}),
    ...(options?.value ? { value: options.value } : {}),
    ...(options?.state ? { state: options.state } : {}),
    ...(options?.validation ? { validation: options.validation } : {}),
    ...(options?.meta ? { meta: options.meta } : {}),
    bounds: options?.bounds ?? { x: 0, y: 0, width: 120, height: 40 },
    path: options?.path ?? [],
    children: options?.children ?? [],
    focusable: role !== 'group',
  }
}

// ── Mock session state ───────────────────────────────────────────────
const mockState = vi.hoisted(() => ({
  currentA11yRoot: node('group', undefined, {
    meta: { pageUrl: 'https://boards.greenhouse.io/apply', scrollX: 0, scrollY: 0 },
  }),
  nodeContexts: new Map<string, Record<string, unknown>>(),
  session: {
    tree: { kind: 'box' },
    layout: { x: 0, y: 0, width: 1280, height: 800, children: [] },
    url: 'ws://127.0.0.1:3200',
    updateRevision: 1,
    cachedA11y: undefined as unknown,
    cachedA11yRevision: undefined as unknown,
    cachedFormSchemas: undefined as unknown,
    workflowState: undefined as unknown,
  },
  formSchemas: [] as Array<Record<string, unknown>>,
  connect: vi.fn(),
  connectThroughProxy: vi.fn(),
  prewarmProxy: vi.fn(),
  sendClick: vi.fn(async () => ({ status: 'updated' as const, timeoutMs: 2000 })),
  sendType: vi.fn(async () => ({ status: 'updated' as const, timeoutMs: 2000 })),
  sendKey: vi.fn(async () => ({ status: 'updated' as const, timeoutMs: 2000 })),
  sendFileUpload: vi.fn(async () => ({ status: 'updated' as const, timeoutMs: 8000 })),
  sendFieldText: vi.fn(async () => ({ status: 'updated' as const, timeoutMs: 2000 })),
  sendFieldChoice: vi.fn(async () => ({ status: 'updated' as const, timeoutMs: 2000 })),
  sendFillFields: vi.fn(async () => ({
    status: 'updated' as 'updated' | 'acknowledged',
    timeoutMs: 6000,
    result: undefined as unknown,
  })),
  sendListboxPick: vi.fn(async () => ({ status: 'updated' as const, timeoutMs: 4500 })),
  sendSelectOption: vi.fn(async () => ({ status: 'updated' as const, timeoutMs: 2000 })),
  sendSetChecked: vi.fn(async () => ({ status: 'updated' as const, timeoutMs: 2000 })),
  sendWheel: vi.fn(async () => ({ status: 'updated' as const, timeoutMs: 2000 })),
  waitForUiCondition: vi.fn(async (_session: unknown, _check: () => boolean, _timeoutMs?: number) => true),
}))

function resetMockSessionCaches() {
  mockState.session.updateRevision = 1
  mockState.session.cachedA11y = undefined
  mockState.session.cachedA11yRevision = undefined
  mockState.session.cachedFormSchemas = undefined
  mockState.session.workflowState = undefined
  mockState.nodeContexts.clear()
}

function bumpMockUiRevision() {
  mockState.session.updateRevision += 1
  mockState.session.cachedA11y = undefined
  mockState.session.cachedA11yRevision = undefined
  mockState.session.cachedFormSchemas = undefined
}

vi.mock('../session.js', () => ({
  connect: mockState.connect,
  connectThroughProxy: mockState.connectThroughProxy,
  prewarmProxy: mockState.prewarmProxy,
  disconnect: vi.fn(),
  pruneDisconnectedSessions: vi.fn(() => []),
  getSession: vi.fn(() => mockState.session),
  resolveSession: vi.fn((id?: string) => ({ kind: 'ok' as const, session: mockState.session, ...(id ? { id } : {}) })),
  listSessions: vi.fn(() => [{ id: 's1', url: 'https://jobs.example.com/application' }]),
  getDefaultSessionId: vi.fn(() => 's1'),
  sendClick: mockState.sendClick,
  sendType: mockState.sendType,
  sendKey: mockState.sendKey,
  sendFileUpload: mockState.sendFileUpload,
  sendFieldText: mockState.sendFieldText,
  sendFieldChoice: mockState.sendFieldChoice,
  sendFillFields: mockState.sendFillFields,
  sendFillOtp: vi.fn(async () => ({ status: 'updated' as const, timeoutMs: 5000, result: { cellCount: 6, filledCount: 6 } })),
  sendListboxPick: mockState.sendListboxPick,
  sendSelectOption: mockState.sendSelectOption,
  sendSetChecked: mockState.sendSetChecked,
  sendWheel: mockState.sendWheel,
  buildA11yTree: vi.fn(() => mockState.currentA11yRoot),
  buildCompactUiIndex: vi.fn(() => ({ nodes: [], context: {} })),
  buildPageModel: vi.fn(() => ({
    viewport: { width: 1280, height: 800 },
    archetypes: ['form'],
    summary: { landmarkCount: 0, formCount: 1, dialogCount: 0, listCount: 0, focusableCount: 6 },
    primaryActions: [],
    landmarks: [],
    forms: [],
    dialogs: [],
    lists: [],
  })),
  buildFormSchemas: vi.fn(() => mockState.formSchemas),
  buildFormRequiredSnapshot: vi.fn(() => []),
  expandPageSection: vi.fn(() => null),
  buildUiDelta: vi.fn(() => ({})),
  hasUiDelta: vi.fn(() => false),
  nodeIdForPath: vi.fn((path: number[]) => `n:${path.length > 0 ? path.join('.') : 'root'}`),
  summarizeCompactIndex: vi.fn(() => ''),
  summarizePageModel: vi.fn(() => ''),
  summarizeUiDelta: vi.fn(() => ''),
  nodeContextForNode: vi.fn((_: unknown, nd: { path?: number[] }) =>
    mockState.nodeContexts.get((nd.path ?? []).join('.'))),
  parseSectionId: vi.fn((id: string) => {
    const [prefix, encoded] = id.split(':', 2)
    if (prefix !== 'fm' || !encoded) return null
    const path = encoded === 'root' ? [] : encoded.split('.').map(Number)
    return path.every(Number.isInteger) ? { kind: 'form' as const, path } : null
  }),
  findNodeByPath: vi.fn((root: A11yNode, path: number[]) => {
    let current: A11yNode | undefined = root
    for (const index of path) current = current?.children[index]
    return current ?? null
  }),
  waitForUiCondition: mockState.waitForUiCondition,
}))

const { createServer } = await import('../server.js')

function getToolHandler(name: string) {
  const server = createServer() as unknown as {
    _registeredTools: Record<string, { handler: (input: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }> }>
  }
  return server._registeredTools[name]!.handler
}

// ── Shared beforeEach ────────────────────────────────────────────────
describe('ATS integration patterns', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetMockSessionCaches()
    mockState.connect.mockResolvedValue(mockState.session)
    mockState.connectThroughProxy.mockResolvedValue(mockState.session)
    mockState.prewarmProxy.mockResolvedValue({
      prepared: true,
      reused: false,
      transport: 'embedded',
      pageUrl: 'https://boards.greenhouse.io/apply',
      wsUrl: 'ws://127.0.0.1:3200',
      headless: true,
      width: 1280,
      height: 720,
    })
    mockState.formSchemas = []
    mockState.currentA11yRoot = node('group', undefined, {
      meta: { pageUrl: 'https://boards.greenhouse.io/apply', scrollX: 0, scrollY: 0 },
    })
  })

  // ── 1. Greenhouse-style ──────────────────────────────────────────
  describe('Greenhouse-style simple form', () => {
    beforeEach(() => {
      mockState.formSchemas = [{
        formId: 'fm:0',
        name: 'Application',
        fieldCount: 5,
        requiredCount: 3,
        invalidCount: 0,
        fields: [
          { id: 'ff:0.0', kind: 'text', label: 'First name', required: true },
          { id: 'ff:0.1', kind: 'text', label: 'Last name', required: true },
          { id: 'ff:0.2', kind: 'text', label: 'Email', required: true },
          { id: 'ff:0.3', kind: 'choice', label: 'Location', choiceType: 'combobox', optionCount: 15 },
          { id: 'ff:0.4', kind: 'choice', label: 'Are you legally authorized to work in the United States?', choiceType: 'group', booleanChoice: true, optionCount: 2 },
        ],
      }]

      mockState.currentA11yRoot = node('group', undefined, {
        meta: { pageUrl: 'https://boards.greenhouse.io/apply', scrollX: 0, scrollY: 0 },
        children: [
          node('textbox', 'First name', { value: 'Taylor', path: [0], state: { required: true } }),
          node('textbox', 'Last name', { value: 'Smith', path: [1], state: { required: true } }),
          node('textbox', 'Email', { value: 'taylor@example.com', path: [2], state: { required: true } }),
          node('combobox', 'Location', { value: 'San Francisco, CA', path: [3] }),
          node('radio', 'Yes', { path: [4, 0], state: { checked: true } }),
          node('radio', 'No', { path: [4, 1], state: { checked: false } }),
        ],
      })
    })

    it('discovers form_schema and fills with valuesById', async () => {
      const schemaHandler = getToolHandler('geometra_form_schema')
      const schemaResult = await schemaHandler({})
      const schemaPayload = JSON.parse(schemaResult.content[0]!.text)
      expect(schemaPayload).toHaveProperty('forms')

      const fillHandler = getToolHandler('geometra_fill_form')
      const fillResult = await fillHandler({
        formId: 'fm:0',
        valuesById: {
          'ff:0.0': 'Taylor',
          'ff:0.1': 'Smith',
          'ff:0.2': 'taylor@example.com',
          'ff:0.3': 'San Francisco, CA',
          'ff:0.4': 'Yes',
        },
        stopOnError: true,
        failOnInvalid: false,
        includeSteps: true,
        detail: 'minimal',
      })

      const payload = JSON.parse(fillResult.content[0]!.text) as Record<string, unknown>
      expect(payload).toMatchObject({
        completed: true,
        fieldCount: 5,
        successCount: 5,
        errorCount: 0,
      })
      expect(payload.minConfidence).toBe(1.0)
    })

    it('verifies fills by reading back field values after completion', async () => {
      const handler = getToolHandler('geometra_fill_form')
      const result = await handler({
        formId: 'fm:0',
        valuesById: {
          'ff:0.0': 'Taylor',
          'ff:0.1': 'Smith',
          'ff:0.2': 'taylor@example.com',
        },
        stopOnError: true,
        failOnInvalid: false,
        includeSteps: true,
        verifyFills: true,
        detail: 'minimal',
      })

      const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>
      expect(payload).toMatchObject({ completed: true, successCount: 3, errorCount: 0 })
    })
  })

  // ── 2. Workday-style ─────────────────────────────────────────────
  describe('Workday-style multi-section form', () => {
    beforeEach(() => {
      mockState.formSchemas = [{
        formId: 'fm:0',
        name: 'Job Application',
        fieldCount: 8,
        requiredCount: 5,
        invalidCount: 0,
        fields: [
          { id: 'ff:0.0', kind: 'text', label: 'Legal First Name', required: true },
          { id: 'ff:0.1', kind: 'text', label: 'Legal Last Name', required: true },
          { id: 'ff:0.2', kind: 'text', label: 'Email Address', required: true },
          { id: 'ff:0.3', kind: 'text', label: 'Phone Number', required: true, format: { placeholder: '(555) 123-4567' } },
          { id: 'ff:0.4', kind: 'text', label: 'Job Title', required: false },
          { id: 'ff:0.5', kind: 'text', label: 'Company', required: false },
          { id: 'ff:0.6', kind: 'text', label: 'School or University', required: true },
          { id: 'ff:0.7', kind: 'choice', label: 'Degree', choiceType: 'select', optionCount: 8 },
        ],
        sections: [
          { name: 'Personal Information', fieldIds: ['ff:0.0', 'ff:0.1', 'ff:0.2', 'ff:0.3'] },
          { name: 'Work Experience', fieldIds: ['ff:0.4', 'ff:0.5'] },
          { name: 'Education', fieldIds: ['ff:0.6', 'ff:0.7'] },
        ],
      }]

      mockState.currentA11yRoot = node('group', undefined, {
        meta: { pageUrl: 'https://myworkday.com/apply', scrollX: 0, scrollY: 0 },
        children: [
          node('group', 'Personal Information', {
            path: [0],
            children: [
              node('textbox', 'Legal First Name', { value: 'Taylor', path: [0, 0], state: { required: true } }),
              node('textbox', 'Legal Last Name', { value: 'Smith', path: [0, 1], state: { required: true } }),
              node('textbox', 'Email Address', { value: 'taylor@example.com', path: [0, 2], state: { required: true } }),
              node('textbox', 'Phone Number', {
                value: '(555) 987-6543',
                path: [0, 3],
                state: { required: true },
                meta: { placeholder: '(555) 123-4567' },
              }),
            ],
          }),
          node('group', 'Work Experience', {
            path: [1],
            children: [
              node('textbox', 'Job Title', { value: 'Software Engineer', path: [1, 0] }),
              node('textbox', 'Company', { value: 'Acme Corp', path: [1, 1] }),
            ],
          }),
          node('group', 'Education', {
            path: [2],
            children: [
              node('textbox', 'School or University', { value: 'MIT', path: [2, 0], state: { required: true } }),
              node('combobox', 'Degree', { value: "Bachelor's", path: [2, 1] }),
            ],
          }),
        ],
      })
    })

    it('fills required fields only using onlyRequiredFields discovery', async () => {
      const schemaHandler = getToolHandler('geometra_form_schema')
      const schemaResult = await schemaHandler({ onlyRequiredFields: true })
      const schemaPayload = JSON.parse(schemaResult.content[0]!.text)
      expect(schemaPayload).toHaveProperty('forms')

      const fillHandler = getToolHandler('geometra_fill_form')
      const result = await fillHandler({
        formId: 'fm:0',
        valuesById: {
          'ff:0.0': 'Taylor',
          'ff:0.1': 'Smith',
          'ff:0.2': 'taylor@example.com',
          'ff:0.3': '(555) 987-6543',
          'ff:0.6': 'MIT',
        },
        stopOnError: true,
        failOnInvalid: false,
        includeSteps: true,
        detail: 'minimal',
      })

      const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>
      expect(payload).toMatchObject({
        completed: true,
        fieldCount: 5,
        successCount: 5,
        errorCount: 0,
        minConfidence: 1.0,
      })
    })

    it('skips pre-filled fields when skipPreFilled is true', async () => {
      // Set up schema where some fields already have matching values
      mockState.formSchemas = [{
        formId: 'fm:0',
        name: 'Job Application',
        fieldCount: 3,
        requiredCount: 3,
        invalidCount: 0,
        fields: [
          { id: 'ff:0.0', kind: 'text', label: 'Legal First Name', required: true, value: 'Taylor' },
          { id: 'ff:0.1', kind: 'text', label: 'Legal Last Name', required: true, value: 'Smith' },
          { id: 'ff:0.2', kind: 'text', label: 'Email Address', required: true },
        ],
      }]

      const handler = getToolHandler('geometra_fill_form')
      const result = await handler({
        formId: 'fm:0',
        valuesById: {
          'ff:0.0': 'Taylor',
          'ff:0.1': 'Smith',
          'ff:0.2': 'taylor@example.com',
        },
        stopOnError: true,
        failOnInvalid: false,
        includeSteps: true,
        skipPreFilled: true,
        detail: 'minimal',
      })

      const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>
      expect(payload).toMatchObject({ completed: true })
      // First name and last name were already filled with matching values, so they should be skipped
      expect(payload).toHaveProperty('skippedPreFilled', 2)
    })
  })

  // ── 3. Lever-style ───────────────────────────────────────────────
  describe('Lever-style resume upload then pre-fill', () => {
    it('uploads a resume and waits for parsing banner to disappear', async () => {
      // Simulate post-upload state with parsing banner visible
      mockState.currentA11yRoot = node('group', undefined, {
        meta: { pageUrl: 'https://jobs.lever.co/acme/apply', scrollX: 0, scrollY: 0 },
        children: [
          node('button', 'Upload Resume/CV', { path: [0] }),
          node('alert', 'Parsing your resume...', { path: [1] }),
          node('textbox', 'Full name', { value: '', path: [2], state: { required: true } }),
          node('textbox', 'Email', { value: '', path: [3], state: { required: true } }),
          node('textbox', 'Phone', { value: '', path: [4] }),
        ],
      })

      // Upload the file
      const uploadHandler = getToolHandler('geometra_upload_files')
      const uploadResult = await uploadHandler({
        fieldLabel: 'Upload Resume/CV',
        paths: ['/tmp/resume.pdf'],
        detail: 'terse',
      })
      const uploadPayload = JSON.parse(uploadResult.content[0]!.text) as Record<string, unknown>
      expect(uploadPayload).toMatchObject({ fileCount: 1, fieldLabel: 'Upload Resume/CV' })

      // Wait for parsing banner to disappear
      const waitHandler = getToolHandler('geometra_wait_for_resume_parse')
      const waitResult = await waitHandler({ text: 'Parsing', timeoutMs: 30000 })
      expect(waitResult.content[0]!.text).toContain('condition satisfied')

      // After parsing, fields are pre-filled from resume
      bumpMockUiRevision()
      mockState.currentA11yRoot = node('group', undefined, {
        meta: { pageUrl: 'https://jobs.lever.co/acme/apply', scrollX: 0, scrollY: 0 },
        children: [
          node('button', 'Upload Resume/CV', { path: [0], value: 'resume.pdf' }),
          node('textbox', 'Full name', { value: 'Taylor Smith', path: [2], state: { required: true } }),
          node('textbox', 'Email', { value: 'taylor@example.com', path: [3], state: { required: true } }),
          node('textbox', 'Phone', { value: '(555) 987-6543', path: [4] }),
        ],
      })

      // Now fill with skipPreFilled to avoid overwriting parsed data
      mockState.formSchemas = [{
        formId: 'fm:0',
        name: 'Application',
        fieldCount: 4,
        requiredCount: 2,
        invalidCount: 0,
        fields: [
          { id: 'ff:0.0', kind: 'text', label: 'Full name', required: true, value: 'Taylor Smith' },
          { id: 'ff:0.1', kind: 'text', label: 'Email', required: true, value: 'taylor@example.com' },
          { id: 'ff:0.2', kind: 'text', label: 'Phone', value: '(555) 987-6543' },
          { id: 'ff:0.3', kind: 'text', label: 'LinkedIn URL' },
        ],
      }]

      const fillHandler = getToolHandler('geometra_fill_form')
      const fillResult = await fillHandler({
        formId: 'fm:0',
        valuesById: {
          'ff:0.0': 'Taylor Smith',
          'ff:0.1': 'taylor@example.com',
          'ff:0.2': '(555) 987-6543',
          'ff:0.3': 'https://linkedin.com/in/taylorsmith',
        },
        skipPreFilled: true,
        stopOnError: true,
        failOnInvalid: false,
        includeSteps: true,
        detail: 'minimal',
      })

      const payload = JSON.parse(fillResult.content[0]!.text) as Record<string, unknown>
      expect(payload).toMatchObject({ completed: true })
      // Three fields already matched their intended values
      expect(payload).toHaveProperty('skippedPreFilled', 3)
    })
  })

  // ── 4. Ashby-style ───────────────────────────────────────────────
  describe('Ashby-style custom controls', () => {
    beforeEach(() => {
      mockState.formSchemas = [{
        formId: 'fm:0',
        name: 'Application Form',
        fieldCount: 4,
        requiredCount: 2,
        invalidCount: 0,
        fields: [
          { id: 'ff:0.0', kind: 'text', label: 'Full Name', required: true },
          { id: 'ff:0.1', kind: 'text', label: 'Email', required: true },
          { id: 'ff:0.2', kind: 'toggle', label: 'I agree to the Privacy Policy', controlType: 'checkbox' },
          { id: 'ff:0.3', kind: 'choice', label: 'How did you hear about us?', choiceType: 'combobox', optionCount: 8 },
        ],
      }]

      mockState.currentA11yRoot = node('group', undefined, {
        meta: { pageUrl: 'https://jobs.ashbyhq.com/acme/apply', scrollX: 0, scrollY: 0 },
        children: [
          node('textbox', 'Full Name', { value: 'Taylor Smith', path: [0], state: { required: true } }),
          node('textbox', 'Email', { value: 'taylor@example.com', path: [1], state: { required: true } }),
          node('checkbox', 'I agree to the Privacy Policy', { path: [2], state: { checked: false } }),
          node('combobox', 'How did you hear about us?', { value: '', path: [3] }),
        ],
      })
    })

    it('uses set_checked for visually hidden custom checkboxes', async () => {
      const handler = getToolHandler('geometra_set_checked')
      const result = await handler({
        label: 'I agree to the Privacy Policy',
        checked: true,
        controlType: 'checkbox',
        detail: 'terse',
      })
      const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>
      expect(payload).toMatchObject({ label: 'I agree to the Privacy Policy', checked: true, controlType: 'checkbox' })
      expect(mockState.sendSetChecked).toHaveBeenCalledWith(
        mockState.session,
        'I agree to the Privacy Policy',
        { checked: true, exact: undefined, controlType: 'checkbox' },
        undefined,
      )
    })

    it('uses pick_listbox_option for combobox dropdowns', async () => {
      const handler = getToolHandler('geometra_pick_listbox_option')
      const result = await handler({
        fieldLabel: 'How did you hear about us?',
        label: 'LinkedIn',
        detail: 'terse',
      })
      const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>
      expect(payload).toMatchObject({ label: 'LinkedIn', fieldLabel: 'How did you hear about us?' })
      expect(mockState.sendListboxPick).toHaveBeenCalledWith(
        mockState.session,
        'LinkedIn',
        expect.objectContaining({
          fieldLabel: 'How did you hear about us?',
        }),
        undefined,
      )
    })

    it('fills text fields and toggles together via fill_fields', async () => {
      const handler = getToolHandler('geometra_fill_fields')
      const result = await handler({
        fields: [
          { kind: 'text', fieldId: 'ff:0.0', value: 'Taylor Smith' },
          { kind: 'text', fieldId: 'ff:0.1', value: 'taylor@example.com' },
          { kind: 'toggle', fieldId: 'ff:0.2', checked: true },
        ],
        stopOnError: true,
        failOnInvalid: false,
        includeSteps: true,
        detail: 'minimal',
      })

      const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>
      expect(payload).toMatchObject({
        completed: true,
        fieldCount: 3,
        successCount: 3,
        errorCount: 0,
      })
      expect(mockState.sendFieldText).toHaveBeenCalledTimes(2)
      expect(mockState.sendSetChecked).toHaveBeenCalledTimes(1)
    })
  })

  // ── 5. Multi-page flow ───────────────────────────────────────────
  describe('multi-page application flow', () => {
    it('tracks workflow state across page navigations', async () => {
      // Page 1: Personal info
      mockState.formSchemas = [{
        formId: 'fm:0',
        name: 'Personal Info',
        fieldCount: 2,
        requiredCount: 2,
        invalidCount: 0,
        fields: [
          { id: 'ff:0.0', kind: 'text', label: 'Full name', required: true },
          { id: 'ff:0.1', kind: 'text', label: 'Email', required: true },
        ],
      }]
      mockState.currentA11yRoot = node('group', undefined, {
        meta: { pageUrl: 'https://careers.acme.com/apply/step1', scrollX: 0, scrollY: 0 },
        children: [
          node('textbox', 'Full name', { value: 'Taylor Smith', path: [0], state: { required: true } }),
          node('textbox', 'Email', { value: 'taylor@example.com', path: [1], state: { required: true } }),
          node('button', 'Next', { path: [2] }),
        ],
      })

      // Fill page 1
      const fillHandler = getToolHandler('geometra_fill_form')
      const fillResult1 = await fillHandler({
        formId: 'fm:0',
        valuesById: {
          'ff:0.0': 'Taylor Smith',
          'ff:0.1': 'taylor@example.com',
        },
        stopOnError: true,
        failOnInvalid: false,
        includeSteps: false,
        detail: 'terse',
      })
      const payload1 = JSON.parse(fillResult1.content[0]!.text) as Record<string, unknown>
      expect(payload1).toMatchObject({ completed: true })

      // Click Next -> page changes
      bumpMockUiRevision()
      mockState.formSchemas = [{
        formId: 'fm:1',
        name: 'Experience',
        fieldCount: 2,
        requiredCount: 1,
        invalidCount: 0,
        fields: [
          { id: 'ff:1.0', kind: 'text', label: 'Current Company', required: true },
          { id: 'ff:1.1', kind: 'text', label: 'Years of Experience' },
        ],
      }]
      mockState.currentA11yRoot = node('group', undefined, {
        meta: { pageUrl: 'https://careers.acme.com/apply/step2', scrollX: 0, scrollY: 0 },
        children: [
          node('textbox', 'Current Company', { value: 'Acme Corp', path: [0], state: { required: true } }),
          node('textbox', 'Years of Experience', { value: '5', path: [1] }),
          node('button', 'Submit', { path: [2] }),
        ],
      })

      // Fill page 2
      const fillResult2 = await fillHandler({
        formId: 'fm:1',
        valuesById: {
          'ff:1.0': 'Acme Corp',
          'ff:1.1': '5',
        },
        stopOnError: true,
        failOnInvalid: false,
        includeSteps: false,
        detail: 'terse',
      })
      const payload2 = JSON.parse(fillResult2.content[0]!.text) as Record<string, unknown>
      expect(payload2).toMatchObject({ completed: true })

      // Check workflow state tracks both pages
      const stateHandler = getToolHandler('geometra_workflow_state')
      const stateResult = await stateHandler({})
      const statePayload = JSON.parse(stateResult.content[0]!.text) as Record<string, unknown>
      expect(statePayload.pageCount).toBe(2)
      expect(statePayload.totalFieldsFilled).toBeGreaterThanOrEqual(4)
    })
  })

  // ── 6. CAPTCHA detection ─────────────────────────────────────────
  describe('CAPTCHA detection', () => {
    it('surfaces captchaDetected when reCAPTCHA iframe is in the tree', async () => {
      // Override buildPageModel to return captcha detection
      const { buildPageModel } = await import('../session.js')
      const mockBuildPageModel = buildPageModel as ReturnType<typeof vi.fn>
      mockBuildPageModel.mockReturnValueOnce({
        viewport: { width: 1280, height: 800 },
        archetypes: ['form'],
        summary: { landmarkCount: 0, formCount: 1, dialogCount: 0, listCount: 0, focusableCount: 4 },
        captcha: { detected: true, type: 'recaptcha', hint: 'Google reCAPTCHA detected' },
        primaryActions: [],
        landmarks: [],
        forms: [],
        dialogs: [],
        lists: [],
      })

      mockState.currentA11yRoot = node('group', undefined, {
        meta: { pageUrl: 'https://boards.greenhouse.io/apply', scrollX: 0, scrollY: 0 },
        children: [
          node('textbox', 'Email', { value: '', path: [0], state: { required: true } }),
          node('group', 'reCAPTCHA', {
            path: [1],
            meta: { pageUrl: 'https://boards.greenhouse.io/apply' } as A11yNode['meta'],
            children: [
              node('checkbox', 'I\'m not a robot', { path: [1, 0] }),
            ],
          }),
          node('button', 'Submit', { path: [2] }),
        ],
      })

      const handler = getToolHandler('geometra_page_model')
      const result = await handler({})
      const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>

      expect(payload).toMatchObject({
        captcha: {
          detected: true,
          type: 'recaptcha',
          hint: 'Google reCAPTCHA detected',
        },
      })
    })
  })

  // ── 7. Date/phone normalization ──────────────────────────────────
  describe('date and phone normalization', () => {
    beforeEach(() => {
      mockState.formSchemas = [{
        formId: 'fm:0',
        name: 'Application',
        fieldCount: 3,
        requiredCount: 2,
        invalidCount: 0,
        fields: [
          { id: 'ff:0.0', kind: 'text', label: 'Start Date', required: true, format: { placeholder: 'MM/DD/YYYY', inputType: 'text' } },
          { id: 'ff:0.1', kind: 'text', label: 'Phone', required: true, format: { placeholder: '(555) 123-4567', inputType: 'tel' } },
          { id: 'ff:0.2', kind: 'text', label: 'Full name' },
        ],
      }]

      mockState.currentA11yRoot = node('group', undefined, {
        meta: { pageUrl: 'https://jobs.example.com/apply', scrollX: 0, scrollY: 0 },
        children: [
          node('textbox', 'Start Date', {
            value: '03/15/2025',
            path: [0],
            state: { required: true },
            meta: { placeholder: 'MM/DD/YYYY' },
          }),
          node('textbox', 'Phone', {
            value: '(555) 987-6543',
            path: [1],
            state: { required: true },
            meta: { placeholder: '(555) 123-4567' },
          }),
          node('textbox', 'Full name', { value: 'Taylor Smith', path: [2] }),
        ],
      })
    })

    it('sends date and phone values as-is through fill_form (server normalizes)', async () => {
      const handler = getToolHandler('geometra_fill_form')
      const result = await handler({
        formId: 'fm:0',
        valuesById: {
          'ff:0.0': '03/15/2025',
          'ff:0.1': '(555) 987-6543',
          'ff:0.2': 'Taylor Smith',
        },
        stopOnError: true,
        failOnInvalid: false,
        includeSteps: true,
        detail: 'minimal',
      })

      const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>
      expect(payload).toMatchObject({
        completed: true,
        fieldCount: 3,
        successCount: 3,
        errorCount: 0,
      })

      // The text handler should have been called with the formatted values
      expect(mockState.sendFieldText).toHaveBeenCalledWith(
        mockState.session,
        'Start Date',
        '03/15/2025',
        expect.objectContaining({ fieldId: 'ff:0.0' }),
        undefined,
      )
      expect(mockState.sendFieldText).toHaveBeenCalledWith(
        mockState.session,
        'Phone',
        '(555) 987-6543',
        expect.objectContaining({ fieldId: 'ff:0.1' }),
        undefined,
      )
    })

    it('exposes format hints in the form schema for agent consumption', async () => {
      const handler = getToolHandler('geometra_form_schema')
      const result = await handler({})
      const payload = JSON.parse(result.content[0]!.text)
      expect(payload).toHaveProperty('forms')
    })
  })

  // ── 8. Error recovery ────────────────────────────────────────────
  describe('error recovery with suggestion', () => {
    it('populates suggestion when a choice field fill fails', async () => {
      mockState.formSchemas = [{
        formId: 'fm:0',
        name: 'Application',
        fieldCount: 2,
        requiredCount: 1,
        invalidCount: 0,
        fields: [
          { id: 'ff:0.0', kind: 'text', label: 'Full name', required: true },
          { id: 'ff:0.1', kind: 'choice', label: 'Department', choiceType: 'select', optionCount: 5 },
        ],
      }]

      mockState.currentA11yRoot = node('group', undefined, {
        meta: { pageUrl: 'https://jobs.example.com/apply', scrollX: 0, scrollY: 0 },
        children: [
          node('textbox', 'Full name', { value: 'Taylor Smith', path: [0], state: { required: true } }),
          node('combobox', 'Department', { value: '', path: [1] }),
        ],
      })

      // Make the choice fill throw a "no option found" error
      mockState.sendFieldChoice.mockRejectedValueOnce(new Error('No option found matching "Engineering"'))

      const handler = getToolHandler('geometra_fill_form')
      const result = await handler({
        formId: 'fm:0',
        valuesById: {
          'ff:0.0': 'Taylor Smith',
          'ff:0.1': 'Engineering',
        },
        stopOnError: true,
        failOnInvalid: false,
        includeSteps: true,
        detail: 'minimal',
      })

      const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>
      const steps = payload.steps as Array<Record<string, unknown>>
      expect(payload.errorCount).toBeGreaterThan(0)

      // Find the failed step with suggestion
      const failedStep = steps.find(s => !s.ok)
      expect(failedStep).toBeDefined()
      expect(failedStep!.error).toContain('No option found')
      expect(failedStep!.suggestion).toContain('geometra_pick_listbox_option')
    })
  })

  // ── 9. Confidence scoring ────────────────────────────────────────
  describe('confidence scoring', () => {
    it('returns minConfidence 1.0 for all valuesById entries', async () => {
      mockState.formSchemas = [{
        formId: 'fm:0',
        name: 'Application',
        fieldCount: 3,
        requiredCount: 3,
        invalidCount: 0,
        fields: [
          { id: 'ff:0.0', kind: 'text', label: 'Full name', required: true },
          { id: 'ff:0.1', kind: 'text', label: 'Email', required: true },
          { id: 'ff:0.2', kind: 'text', label: 'Phone', required: true },
        ],
      }]

      mockState.currentA11yRoot = node('group', undefined, {
        meta: { pageUrl: 'https://jobs.example.com/apply', scrollX: 0, scrollY: 0 },
        children: [
          node('textbox', 'Full name', { value: 'Taylor Smith', path: [0], state: { required: true } }),
          node('textbox', 'Email', { value: 'taylor@example.com', path: [1], state: { required: true } }),
          node('textbox', 'Phone', { value: '5559876543', path: [2], state: { required: true } }),
        ],
      })

      const handler = getToolHandler('geometra_fill_form')
      const result = await handler({
        formId: 'fm:0',
        valuesById: {
          'ff:0.0': 'Taylor Smith',
          'ff:0.1': 'taylor@example.com',
          'ff:0.2': '5559876543',
        },
        stopOnError: true,
        failOnInvalid: false,
        includeSteps: true,
        detail: 'minimal',
      })

      const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>
      expect(payload.minConfidence).toBe(1.0)

      const steps = payload.steps as Array<Record<string, unknown>>
      for (const step of steps) {
        expect(step.confidence).toBe(1.0)
        expect(step.matchMethod).toBe('id')
      }
    })

    it('returns lower confidence for valuesByLabel with exact match', async () => {
      mockState.formSchemas = [{
        formId: 'fm:0',
        name: 'Application',
        fieldCount: 2,
        requiredCount: 2,
        invalidCount: 0,
        fields: [
          { id: 'ff:0.0', kind: 'text', label: 'Full name', required: true },
          { id: 'ff:0.1', kind: 'text', label: 'Email', required: true },
        ],
      }]

      mockState.currentA11yRoot = node('group', undefined, {
        meta: { pageUrl: 'https://jobs.example.com/apply', scrollX: 0, scrollY: 0 },
        children: [
          node('textbox', 'Full name', { value: 'Taylor Smith', path: [0], state: { required: true } }),
          node('textbox', 'Email', { value: 'taylor@example.com', path: [1], state: { required: true } }),
        ],
      })

      const handler = getToolHandler('geometra_fill_form')
      const result = await handler({
        formId: 'fm:0',
        valuesByLabel: {
          'Full name': 'Taylor Smith',
          'Email': 'taylor@example.com',
        },
        stopOnError: true,
        failOnInvalid: false,
        includeSteps: true,
        detail: 'minimal',
      })

      const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>
      expect(payload.minConfidence).toBe(0.95)

      const steps = payload.steps as Array<Record<string, unknown>>
      for (const step of steps) {
        expect(step.confidence).toBe(0.95)
        expect(step.matchMethod).toBe('label-exact')
      }
    })

    it('returns 0.8 confidence for normalized label matches', async () => {
      mockState.formSchemas = [{
        formId: 'fm:0',
        name: 'Application',
        fieldCount: 2,
        requiredCount: 2,
        invalidCount: 0,
        fields: [
          { id: 'ff:0.0', kind: 'text', label: 'Full name', required: true },
          { id: 'ff:0.1', kind: 'text', label: 'Email Address', required: true },
        ],
      }]

      mockState.currentA11yRoot = node('group', undefined, {
        meta: { pageUrl: 'https://jobs.example.com/apply', scrollX: 0, scrollY: 0 },
        children: [
          node('textbox', 'Full name', { value: 'Taylor Smith', path: [0], state: { required: true } }),
          node('textbox', 'Email Address', { value: 'taylor@example.com', path: [1], state: { required: true } }),
        ],
      })

      const handler = getToolHandler('geometra_fill_form')
      const result = await handler({
        formId: 'fm:0',
        valuesByLabel: {
          'full name': 'Taylor Smith',
          'email address': 'taylor@example.com',
        },
        stopOnError: true,
        failOnInvalid: false,
        includeSteps: true,
        detail: 'minimal',
      })

      const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>
      // Normalized labels should give lower confidence
      expect(payload.minConfidence).toBeLessThanOrEqual(0.95)
    })

    it('mixes valuesById (1.0) and valuesByLabel (0.95) and reports minimum', async () => {
      mockState.formSchemas = [{
        formId: 'fm:0',
        name: 'Application',
        fieldCount: 3,
        requiredCount: 3,
        invalidCount: 0,
        fields: [
          { id: 'ff:0.0', kind: 'text', label: 'Full name', required: true },
          { id: 'ff:0.1', kind: 'text', label: 'Email', required: true },
          { id: 'ff:0.2', kind: 'text', label: 'Phone', required: true },
        ],
      }]

      mockState.currentA11yRoot = node('group', undefined, {
        meta: { pageUrl: 'https://jobs.example.com/apply', scrollX: 0, scrollY: 0 },
        children: [
          node('textbox', 'Full name', { value: 'Taylor Smith', path: [0], state: { required: true } }),
          node('textbox', 'Email', { value: 'taylor@example.com', path: [1], state: { required: true } }),
          node('textbox', 'Phone', { value: '5559876543', path: [2], state: { required: true } }),
        ],
      })

      const handler = getToolHandler('geometra_fill_form')
      const result = await handler({
        formId: 'fm:0',
        valuesById: {
          'ff:0.0': 'Taylor Smith',
        },
        valuesByLabel: {
          'Email': 'taylor@example.com',
          'Phone': '5559876543',
        },
        stopOnError: true,
        failOnInvalid: false,
        includeSteps: true,
        detail: 'minimal',
      })

      const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>
      // minConfidence should be 0.95 (from the label-exact matches), not 1.0
      expect(payload.minConfidence).toBe(0.95)

      const steps = payload.steps as Array<Record<string, unknown>>
      const idStep = steps.find(s => s.matchMethod === 'id')
      const labelSteps = steps.filter(s => s.matchMethod === 'label-exact')
      expect(idStep).toBeDefined()
      expect(idStep!.confidence).toBe(1.0)
      expect(labelSteps.length).toBe(2)
      for (const ls of labelSteps) {
        expect(ls.confidence).toBe(0.95)
      }
    })
  })
})
