import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { A11yNode } from '../session.js'

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

const mockState = vi.hoisted(() => ({
  currentA11yRoot: node('group', undefined, {
    meta: { pageUrl: 'https://jobs.example.com/application', scrollX: 0, scrollY: 0 },
  }) as A11yNode | null,
  nodeContexts: new Map<string, Record<string, unknown>>(),
  nodeContextReadHook: undefined as undefined | ((node: { path?: number[] }) => void),
  session: {
    tree: { kind: 'box' },
    layout: { x: 0, y: 0, width: 1280, height: 800, children: [] },
    url: 'ws://127.0.0.1:3200',
    updateRevision: 1,
    cachedA11y: undefined as unknown,
    cachedA11yRevision: undefined as unknown,
    cachedFormSchemas: undefined as unknown,
  },
  formSchemas: [] as Array<Record<string, unknown>>,
  connect: vi.fn(),
  connectThroughProxy: vi.fn(),
  prewarmProxy: vi.fn(),
  sendClick: vi.fn(async () => ({
    status: 'updated' as 'updated' | 'acknowledged' | 'timed_out',
    timeoutMs: 2000,
  })),
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
  expandPageSection: vi.fn((_root: unknown, _id: string, _opts?: Record<string, unknown>) => null as unknown),
}))

function resetMockSessionCaches() {
  mockState.session.updateRevision = 1
  mockState.session.cachedA11y = undefined
  mockState.session.cachedA11yRevision = undefined
  mockState.session.cachedFormSchemas = undefined
  mockState.nodeContexts.clear()
  mockState.nodeContextReadHook = undefined
}

function bumpMockUiRevision() {
  mockState.session.updateRevision += 1
  mockState.session.cachedA11y = undefined
  mockState.session.cachedA11yRevision = undefined
  mockState.session.cachedFormSchemas = undefined
}

function resetMockActionBehaviors() {
  mockState.sendClick.mockReset().mockResolvedValue({ status: 'updated', timeoutMs: 2000 })
  mockState.sendType.mockReset().mockResolvedValue({ status: 'updated', timeoutMs: 2000 })
  mockState.sendKey.mockReset().mockResolvedValue({ status: 'updated', timeoutMs: 2000 })
  mockState.sendFileUpload.mockReset().mockResolvedValue({ status: 'updated', timeoutMs: 8000 })
  mockState.sendFieldText.mockReset().mockResolvedValue({ status: 'updated', timeoutMs: 2000 })
  mockState.sendFieldChoice.mockReset().mockResolvedValue({ status: 'updated', timeoutMs: 2000 })
  mockState.sendFillFields.mockReset().mockResolvedValue({ status: 'updated', timeoutMs: 6000, result: undefined })
  mockState.sendListboxPick.mockReset().mockResolvedValue({ status: 'updated', timeoutMs: 4500 })
  mockState.sendSelectOption.mockReset().mockResolvedValue({ status: 'updated', timeoutMs: 2000 })
  mockState.sendSetChecked.mockReset().mockResolvedValue({ status: 'updated', timeoutMs: 2000 })
  mockState.sendWheel.mockReset().mockResolvedValue({ status: 'updated', timeoutMs: 2000 })
  mockState.waitForUiCondition.mockReset().mockImplementation(async (_session, check) => check())
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
    summary: { landmarkCount: 0, formCount: 1, dialogCount: 0, listCount: 0, focusableCount: 2 },
    primaryActions: [],
    landmarks: [],
    forms: [],
    dialogs: [],
    lists: [],
  })),
  buildFormSchemas: vi.fn(() => mockState.formSchemas),
  formSchemaToFormGraph: vi.fn((schema: Record<string, unknown>, pageUrl?: string) => ({
    formgraph: '0.1',
    id: `geometra:${String(schema.formId)}`,
    title: String(schema.name ?? schema.formId),
    sources: [{ id: 'geometra-page', kind: 'html', ...(pageUrl ? { url: pageUrl } : {}) }],
    fields: (schema.fields as Array<Record<string, unknown>> ?? []).map(field => ({
      id: String(field.id),
      path: `web.forms.application.${String(field.label).toLowerCase().replace(/[^a-z0-9]+/g, '.')}`,
      label: String(field.label),
      kind: field.kind === 'toggle' || field.booleanChoice ? 'boolean' : field.kind === 'choice' ? 'enum' : 'text',
      ...(field.required ? { required: true } : {}),
      sourceAnchors: [{ sourceId: 'geometra-page', kind: 'html', fieldName: String(field.id) }],
    })),
    evidence: [],
    dependencies: [],
    review: { autoSubmitAllowed: false, requiredBeforeSubmit: true },
    metadata: { producer: 'geometra', geometra: { formId: schema.formId } },
  })),
  buildFormRequiredSnapshot: vi.fn(() => []),
  expandPageSection: mockState.expandPageSection,
  buildUiDelta: vi.fn(() => ({})),
  hasUiDelta: vi.fn(() => false),
  nodeIdForPath: vi.fn((path: number[]) => `n:${path.length > 0 ? path.join('.') : 'root'}`),
  summarizeCompactIndex: vi.fn(() => ''),
  summarizePageModel: vi.fn(() => ''),
  summarizeUiDelta: vi.fn(() => ''),
  nodeContextForNode: vi.fn((_: unknown, node: { path?: number[] }) => {
    mockState.nodeContextReadHook?.(node)
    return mockState.nodeContexts.get((node.path ?? []).join('.'))
  }),
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
    _registeredTools: Record<string, { handler: (input: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }> }>
  }
  return server._registeredTools[name]!.handler
}

function getToolInputSchema(name: string) {
  const server = createServer() as unknown as {
    _registeredTools: Record<string, {
      inputSchema: {
        safeParse: (input: unknown) => { success: boolean; data?: Record<string, unknown> }
      }
    }>
  }
  return server._registeredTools[name]!.inputSchema
}

describe('batch MCP result shaping', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetMockActionBehaviors()
    resetMockSessionCaches()
    mockState.connect.mockResolvedValue(mockState.session)
    mockState.connectThroughProxy.mockResolvedValue(mockState.session)
    mockState.prewarmProxy.mockResolvedValue({
      prepared: true,
      reused: false,
      transport: 'embedded',
      pageUrl: 'https://jobs.example.com/application',
      wsUrl: 'ws://127.0.0.1:3200',
      headless: true,
      width: 1280,
      height: 720,
    })
    mockState.formSchemas = []
    mockState.currentA11yRoot = node('group', undefined, {
      meta: { pageUrl: 'https://jobs.example.com/application', scrollX: 0, scrollY: 420 },
      children: [
        node('textbox', 'Mission', {
          value: 'Ship calm developer tools across browsers and platforms.',
          path: [0],
        }),
        node('textbox', 'Email', {
          value: 'taylor@example.com',
          path: [1],
        }),
      ],
    })
  })

  it('rejects malformed batch actions instead of stripping misspelled behavior fields', () => {
    const schema = getToolInputSchema('geometra_run_actions')

    expect(schema.safeParse({
      actions: [{ type: 'set_checked', checked: false }],
    }).success).toBe(false)
    expect(schema.safeParse({
      actions: [{ type: 'set_checked', label: '   ', checked: false }],
    }).success).toBe(false)
    expect(schema.safeParse({
      actions: [{ type: 'set_checked', label: 'Consent', checkd: false }],
    }).success).toBe(false)
    expect(schema.safeParse({
      actions: [{
        type: 'fill_fields',
        fields: [{ kind: 'toggle', fieldId: 'ff:0.3', checkd: false }],
      }],
    }).success).toBe(false)

    const valid = schema.safeParse({
      actions: [{ type: 'set_checked', label: '  Consent  ', checked: false }],
    })
    expect(valid.success).toBe(true)
    const actions = valid.data?.actions as Array<Record<string, unknown>>
    expect(actions[0]).toMatchObject({ label: 'Consent', checked: false })
  })

  it('keeps the standalone set_checked contract strict and forwards disambiguation context', async () => {
    const schema = getToolInputSchema('geometra_set_checked')
    expect(schema.safeParse({ label: 'Consent', checkd: false }).success).toBe(false)
    expect(schema.safeParse({ label: '   ', checked: false }).success).toBe(false)

    const parsed = schema.safeParse({
      label: '  Yes  ',
      checked: false,
      fieldKey: '  id:sponsorship-no  ',
      contextText: '  Sponsorship  ',
      sectionText: '  Application  ',
    })
    expect(parsed.success).toBe(true)
    expect(parsed.data).toMatchObject({
      label: 'Yes',
      checked: false,
      fieldKey: 'id:sponsorship-no',
      contextText: 'Sponsorship',
      sectionText: 'Application',
    })

    const handler = getToolHandler('geometra_set_checked')
    await handler(parsed.data!)
    expect(mockState.sendSetChecked).toHaveBeenCalledWith(
      mockState.session,
      'Yes',
      {
        checked: false,
        exact: undefined,
        controlType: undefined,
        fieldKey: 'id:sponsorship-no',
        contextText: 'Sponsorship',
        sectionText: 'Application',
      },
      undefined,
    )
  })

  it('fails closed on unsafe upload targets and forwards semantic upload constraints', async () => {
    const standaloneSchema = getToolInputSchema('geometra_upload_files')
    const batchSchema = getToolInputSchema('geometra_run_actions')

    for (const input of [
      { paths: ['/tmp/resume.pdf'] },
      { paths: ['/tmp/resume.pdf'], x: 20 },
      { paths: ['/tmp/resume.pdf'], y: 30 },
      { paths: ['/tmp/resume.pdf'], strategy: 'chooser' },
      { paths: ['/tmp/resume.pdf'], strategy: 'drop', dropX: 20 },
      { paths: ['/tmp/resume.pdf'], strategy: 'hidden' },
      { paths: ['/tmp/resume.pdf'], contextText: 'Resume prompt' },
    ]) {
      expect(standaloneSchema.safeParse(input).success).toBe(false)
      expect(batchSchema.safeParse({
        actions: [{ type: 'upload_files', ...input }],
      }).success).toBe(false)
    }

    expect(standaloneSchema.safeParse({
      paths: ['/tmp/resume.pdf'],
      x: 20,
      y: 30,
      strategy: 'chooser',
    }).success).toBe(true)
    expect(standaloneSchema.safeParse({
      paths: ['/tmp/resume.pdf'],
      dropX: 20,
      dropY: 30,
      strategy: 'drop',
    }).success).toBe(true)

    const parsed = standaloneSchema.safeParse({
      paths: ['  /tmp/resume.pdf  '],
      fieldLabel: '  Resume  ',
      exact: true,
      strategy: 'hidden',
      contextText: '  Upload your resume  ',
      sectionText: '  Application documents  ',
    })
    expect(parsed.success).toBe(true)
    expect(parsed.data).toMatchObject({
      paths: ['/tmp/resume.pdf'],
      fieldLabel: 'Resume',
      contextText: 'Upload your resume',
      sectionText: 'Application documents',
    })

    await getToolHandler('geometra_upload_files')(parsed.data!)
    expect(mockState.sendFileUpload).toHaveBeenLastCalledWith(
      mockState.session,
      ['/tmp/resume.pdf'],
      {
        click: undefined,
        fieldLabel: 'Resume',
        exact: true,
        strategy: 'hidden',
        drop: undefined,
        contextText: 'Upload your resume',
        sectionText: 'Application documents',
      },
      8000,
    )

    const parsedBatch = batchSchema.safeParse({
      actions: [{
        type: 'upload_files',
        paths: ['/tmp/cover-letter.pdf'],
        fieldLabel: 'Cover letter',
        contextText: 'Optional supporting document',
        sectionText: 'Application documents',
      }],
    })
    expect(parsedBatch.success).toBe(true)
    await getToolHandler('geometra_run_actions')(parsedBatch.data!)
    expect(mockState.sendFileUpload).toHaveBeenLastCalledWith(
      mockState.session,
      ['/tmp/cover-letter.pdf'],
      {
        click: undefined,
        fieldLabel: 'Cover letter',
        exact: undefined,
        strategy: undefined,
        drop: undefined,
        contextText: 'Optional supporting document',
        sectionText: 'Application documents',
      },
      8000,
    )
  })

  it('requires confirmable listbox identity and never accepts coordinate-only targeting', async () => {
    const standaloneSchema = getToolInputSchema('geometra_pick_listbox_option')
    const batchSchema = getToolInputSchema('geometra_run_actions')

    for (const input of [
      { label: 'New York' },
      { label: 'New York', fieldId: 'ff:0.2' },
      { label: 'New York', fieldKey: 'id:office' },
      { label: 'New York', fieldLabel: 'Office', openX: 20, openY: 30 },
      { label: 'New York', fieldLabel: 'Office', contextText: 'Work location' },
      { label: 'New York', fieldLabel: 'Office', sectionText: 'Application' },
    ]) {
      expect(standaloneSchema.safeParse(input).success).toBe(false)
      expect(batchSchema.safeParse({
        actions: [{ type: 'pick_listbox_option', ...input }],
      }).success).toBe(false)
    }

    const parsed = standaloneSchema.safeParse({
      label: '  New York  ',
      exact: true,
      fieldId: '  ff:0.2  ',
      fieldKey: '  id:office  ',
      fieldLabel: '  Office  ',
      query: 'New',
    })
    expect(parsed.success).toBe(true)
    await getToolHandler('geometra_pick_listbox_option')(parsed.data!)
    expect(mockState.sendListboxPick).toHaveBeenCalledWith(
      mockState.session,
      'New York',
      {
        exact: true,
        fieldId: 'ff:0.2',
        fieldKey: 'id:office',
        fieldLabel: 'Office',
        query: 'New',
      },
      undefined,
    )
  })

  it('requires a native-select selector, rejects discarded context, and preserves conjunctive identity', async () => {
    const standaloneSchema = getToolInputSchema('geometra_select_option')
    const batchSchema = getToolInputSchema('geometra_run_actions')

    expect(standaloneSchema.safeParse({ x: 20, y: 30 }).success).toBe(false)
    expect(standaloneSchema.safeParse({ x: 20, value: 'nyc' }).success).toBe(false)
    expect(standaloneSchema.safeParse({ x: 20, y: 30, value: 'nyc', contextText: 'Office' }).success).toBe(false)
    expect(standaloneSchema.safeParse({ x: 20, y: 30, value: 'nyc', sectionText: 'Application' }).success).toBe(false)
    expect(batchSchema.safeParse({
      actions: [{ type: 'select_option', x: 20, y: 30 }],
    }).success).toBe(false)
    expect(batchSchema.safeParse({
      actions: [{ type: 'select_option', x: 20, y: 30, value: 'nyc', contextText: 'Office' }],
    }).success).toBe(false)

    const parsed = standaloneSchema.safeParse({
      x: 20,
      y: 30,
      value: 'nyc',
      label: '  New York  ',
      index: 2,
    })
    expect(parsed.success).toBe(true)
    await getToolHandler('geometra_select_option')(parsed.data!)
    expect(mockState.sendSelectOption).toHaveBeenCalledWith(
      mockState.session,
      20,
      30,
      { value: 'nyc', label: 'New York', index: 2 },
      undefined,
    )

    expect(batchSchema.safeParse({
      actions: [{ type: 'select_option', x: 20, y: 30, value: 'nyc', label: 'New York', index: 2 }],
    }).success).toBe(true)
  })

  it('forwards exact field identity through run_actions recovery primitives', async () => {
    const schema = getToolInputSchema('geometra_run_actions')
    const parsed = schema.safeParse({
      actions: [
        {
          type: 'pick_listbox_option',
          label: 'New York',
          fieldId: 'id:office',
          fieldKey: 'id:office',
          fieldLabel: 'Office',
        },
        {
          type: 'set_checked',
          label: 'No',
          checked: true,
          fieldKey: 'id:sponsorship-no',
        },
      ],
    })
    expect(parsed.success).toBe(true)

    const handler = getToolHandler('geometra_run_actions')
    await handler(parsed.data!)

    expect(mockState.sendListboxPick).toHaveBeenCalledWith(
      mockState.session,
      'New York',
      {
        exact: undefined,
        fieldId: 'id:office',
        fieldKey: 'id:office',
        fieldLabel: 'Office',
        query: undefined,
      },
      4500,
    )
    expect(mockState.sendSetChecked).toHaveBeenCalledWith(
      mockState.session,
      'No',
      {
        checked: true,
        exact: undefined,
        controlType: undefined,
        fieldKey: 'id:sponsorship-no',
        contextText: undefined,
        sectionText: undefined,
      },
      5000,
    )
  })

  it('treats a timed-out batched action as a failed step', async () => {
    const handler = getToolHandler('geometra_run_actions')
    mockState.sendClick.mockResolvedValueOnce({ status: 'timed_out', timeoutMs: 250 })

    const result = await handler({
      actions: [{ type: 'click', x: 20, y: 30 }],
      stopOnError: true,
      includeSteps: true,
      detail: 'terse',
    })

    const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>
    const steps = payload.steps as Array<Record<string, unknown>>
    expect(payload).toMatchObject({
      completed: false,
      stepCount: 1,
      successCount: 0,
      errorCount: 1,
      stoppedAt: 0,
    })
    expect(steps[0]).toMatchObject({
      index: 0,
      type: 'click',
      ok: false,
      error: expect.stringMatching(/timed out.*unconfirmed/i),
    })
  })

  it('keeps fill_fields minimal output structured and does not echo long essay text', async () => {
    const longAnswer = 'A'.repeat(180)
    const handler = getToolHandler('geometra_fill_fields')

    mockState.currentA11yRoot = node('group', undefined, {
      meta: { pageUrl: 'https://jobs.example.com/application', scrollX: 0, scrollY: 420 },
      children: [
        node('textbox', 'Mission', { value: longAnswer, path: [0] }),
        node('textbox', 'Email', { value: 'taylor@example.com', path: [1] }),
      ],
    })

    const result = await handler({
      fields: [
        { kind: 'text', fieldLabel: 'Mission', value: longAnswer },
        { kind: 'text', fieldLabel: 'Email', value: 'taylor@example.com' },
      ],
      stopOnError: true,
      failOnInvalid: false,
      includeSteps: true,
      detail: 'minimal',
    })

    const text = result.content[0]!.text
    const payload = JSON.parse(text) as Record<string, unknown>
    const steps = payload.steps as Array<Record<string, unknown>>

    expect(text).not.toContain(longAnswer)
    expect(payload).toMatchObject({
      completed: true,
      fieldCount: 2,
      successCount: 2,
      errorCount: 0,
    })
    expect(steps[0]).toMatchObject({
      index: 0,
      kind: 'text',
      ok: true,
      fieldLabel: 'Mission',
      valueLength: 180,
      wait: 'updated',
      readback: { role: 'textbox', valueLength: 180 },
    })
    expect(steps[1]).toMatchObject({
      index: 1,
      kind: 'text',
      ok: true,
      fieldLabel: 'Email',
      value: 'taylor@example.com',
      wait: 'updated',
      readback: { role: 'textbox', value: 'taylor@example.com' },
    })
  })

  it('resolves fieldId-only fill_fields entries from the current form schema', async () => {
    const handler = getToolHandler('geometra_fill_fields')
    mockState.formSchemas = [{
      formId: 'fm:0',
      name: 'Application',
      fieldCount: 3,
      requiredCount: 0,
      invalidCount: 0,
      fields: [
        { id: 'ff:0.0', kind: 'text', label: 'Full name' },
        { id: 'ff:0.1', kind: 'choice', label: 'Preferred location', choiceType: 'select' },
        { id: 'ff:0.2', kind: 'toggle', label: 'Share my profile for future roles', controlType: 'checkbox' },
      ],
    }]

    const result = await handler({
      fields: [
        { kind: 'text', fieldId: 'ff:0.0', value: 'Taylor Applicant' },
        { kind: 'choice', fieldId: 'ff:0.1', value: 'Berlin, Germany' },
        { kind: 'toggle', fieldId: 'ff:0.2', checked: true },
      ],
      stopOnError: true,
      failOnInvalid: false,
      includeSteps: true,
      detail: 'minimal',
    })

    const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>
    expect(mockState.sendFieldText).toHaveBeenCalledWith(
      mockState.session,
      'Full name',
      'Taylor Applicant',
      { exact: undefined, fieldId: 'ff:0.0' },
      undefined,
    )
    expect(mockState.sendFieldChoice).toHaveBeenCalledWith(
      mockState.session,
      'Preferred location',
      'Berlin, Germany',
      { exact: undefined, query: undefined, choiceType: 'select', fieldId: 'ff:0.1' },
      undefined,
    )
    expect(mockState.sendSetChecked).toHaveBeenCalledWith(
      mockState.session,
      'Share my profile for future roles',
      { checked: true, exact: undefined, controlType: 'checkbox' },
      undefined,
    )
    expect(payload).toMatchObject({
      completed: true,
      fieldCount: 3,
      successCount: 3,
      errorCount: 0,
    })
  })

  it('lets run_actions omit step listings while keeping capped final validation state', async () => {
    const handler = getToolHandler('geometra_run_actions')

    mockState.currentA11yRoot = node('group', undefined, {
      meta: { pageUrl: 'https://jobs.example.com/application', scrollX: 0, scrollY: 2400 },
      children: [
        node('textbox', 'Full name', {
          value: '',
          path: [0],
          state: { invalid: true, required: true },
          validation: { error: 'Enter your full name.' },
        }),
        node('textbox', 'Email', {
          value: '',
          path: [1],
          state: { invalid: true, required: true },
          validation: { error: 'Enter your email.' },
        }),
        node('textbox', 'Phone', {
          value: '',
          path: [2],
          state: { invalid: true, required: true },
          validation: { error: 'Enter your phone number.' },
        }),
        node('textbox', 'Location', {
          value: '',
          path: [3],
          state: { invalid: true, required: true },
          validation: { error: 'Choose a location.' },
        }),
        node('textbox', 'LinkedIn', {
          value: '',
          path: [4],
          state: { invalid: true },
          validation: { error: 'Enter a valid URL.' },
        }),
        node('alert', 'Your form needs corrections', { path: [5] }),
      ],
    })

    const result = await handler({
      actions: [{ type: 'click', x: 320, y: 540 }],
      stopOnError: true,
      includeSteps: false,
      detail: 'minimal',
    })

    const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>
    const final = payload.final as Record<string, unknown>

    expect(payload).toMatchObject({
      completed: true,
      stepCount: 1,
      successCount: 1,
      errorCount: 0,
    })
    expect(payload).not.toHaveProperty('steps')
    expect(final).toMatchObject({
      pageUrl: 'https://jobs.example.com/application',
      alertCount: 1,
      invalidCount: 5,
    })
    expect((final.invalidFields as unknown[]).length).toBe(5)
    expect((final.alerts as unknown[]).length).toBe(1)
  })

  it('caps run_actions step timeouts under the soft deadline and resumes from an action index', async () => {
    const handler = getToolHandler('geometra_run_actions')

    const result = await handler({
      actions: [
        { type: 'click', x: 10, y: 20, timeoutMs: 60_000 },
        { type: 'click', x: 30, y: 40, timeoutMs: 60_000 },
      ],
      resumeFromIndex: 1,
      softTimeoutMs: 1_000,
      includeSteps: true,
      detail: 'terse',
    })

    expect(mockState.sendClick).toHaveBeenCalledTimes(1)
    const call = mockState.sendClick.mock.calls[0]!
    expect(call[1]).toBe(30)
    expect(call[2]).toBe(40)
    expect(call[3]).toBeGreaterThanOrEqual(50)
    expect(call[3]).toBeLessThanOrEqual(300)

    const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>
    const steps = payload.steps as Array<Record<string, unknown>>
    expect(payload).toMatchObject({
      completed: true,
      resumedFromIndex: 1,
      stepCount: 2,
      successCount: 1,
      errorCount: 0,
    })
    expect(steps[0]).toMatchObject({ index: 1, type: 'click', ok: true })
  })

  it('uses the proxy batch path for fill_fields when step output is omitted', async () => {
    const handler = getToolHandler('geometra_fill_fields')

    mockState.currentA11yRoot = node('group', undefined, {
      meta: { pageUrl: 'https://jobs.example.com/application', scrollX: 0, scrollY: 420 },
      children: [
        node('textbox', 'Full name', { value: 'Taylor Applicant', path: [0] }),
        node('textbox', 'Email', { value: 'taylor@example.com', path: [1] }),
      ],
    })

    const result = await handler({
      fields: [
        { kind: 'text', fieldLabel: 'Full name', value: 'Taylor Applicant' },
        { kind: 'text', fieldLabel: 'Email', value: 'taylor@example.com' },
      ],
      stopOnError: true,
      failOnInvalid: false,
      includeSteps: false,
      detail: 'terse',
    })

    const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>
    expect(mockState.sendFillFields).toHaveBeenCalledWith(
      mockState.session,
      [
        { kind: 'text', fieldLabel: 'Full name', value: 'Taylor Applicant' },
        { kind: 'text', fieldLabel: 'Email', value: 'taylor@example.com' },
      ],
    )
    expect(mockState.sendFieldText).not.toHaveBeenCalled()
    expect(payload).toMatchObject({
      completed: true,
      execution: 'batched',
      finalSource: 'session',
      fieldCount: 2,
      successCount: 2,
      errorCount: 0,
      final: { invalidCount: 0 },
    })
  })

  it('auto-connects run_actions and supports final-only output', async () => {
    const handler = getToolHandler('geometra_run_actions')

    mockState.currentA11yRoot = node('group', undefined, {
      meta: { pageUrl: 'https://shop.example.com/login', scrollX: 0, scrollY: 0 },
      children: [
        node('textbox', 'Username', { value: 'standard_user', path: [0] }),
        node('textbox', 'Password', { value: 'secret_sauce', path: [1] }),
      ],
    })

    const result = await handler({
      pageUrl: 'https://shop.example.com/login',
      headless: true,
      actions: [
        {
          type: 'fill_fields',
          fields: [
            { kind: 'text', fieldLabel: 'Username', value: 'standard_user' },
            { kind: 'text', fieldLabel: 'Password', value: 'secret_sauce' },
          ],
        },
      ],
      stopOnError: true,
      includeSteps: false,
      output: 'final',
      detail: 'terse',
    })

    const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>
    expect(mockState.connectThroughProxy).toHaveBeenCalledWith(expect.objectContaining({
      pageUrl: 'https://shop.example.com/login',
      headless: true,
      awaitInitialFrame: false,
    }))
    expect(payload).toMatchObject({
      autoConnected: true,
      transport: 'proxy',
      pageUrl: 'https://shop.example.com/login',
      completed: true,
      final: { invalidCount: 0 },
    })
    expect(payload).not.toHaveProperty('steps')
    expect(payload).not.toHaveProperty('stepCount')
    expect(payload).toMatchObject({ successCount: 1, errorCount: 0 })
  })

  it('keeps final-only run_actions failures visible and incomplete', async () => {
    const handler = getToolHandler('geometra_run_actions')
    mockState.sendClick.mockResolvedValueOnce({ status: 'timed_out', timeoutMs: 250 })

    const result = await handler({
      actions: [{ type: 'click', x: 20, y: 30 }],
      stopOnError: false,
      includeSteps: false,
      output: 'final',
      detail: 'terse',
    })
    const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>

    expect(payload).toMatchObject({ completed: false, successCount: 0, errorCount: 1 })
    expect(payload).not.toHaveProperty('steps')
  })

  it('caps submit_form submit clicks under the soft deadline', async () => {
    const handler = getToolHandler('geometra_submit_form')

    mockState.currentA11yRoot = node('group', undefined, {
      bounds: { x: 0, y: 0, width: 1280, height: 720 },
      meta: { pageUrl: 'https://jobs.example.com/application', scrollX: 0, scrollY: 0 },
      children: [
        node('button', 'Submit', { path: [0], bounds: { x: 100, y: 180, width: 120, height: 40 } }),
      ],
    })

    const result = await handler({
      skipFill: true,
      submitTimeoutMs: 60_000,
      softTimeoutMs: 1_000,
      detail: 'terse',
    })

    expect(mockState.sendClick).toHaveBeenCalledTimes(1)
    const call = mockState.sendClick.mock.calls[0]!
    expect(call[1]).toBe(160)
    expect(call[2]).toBe(200)
    expect(call[3]).toBeGreaterThanOrEqual(50)
    expect(call[3]).toBeLessThanOrEqual(300)

    const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>
    expect(payload).toMatchObject({
      completed: false,
      execution: 'completed',
      outcome: 'unconfirmed',
      submit: { wait: 'updated' },
    })
  })

  it('attaches verifyFills readback results to run_actions fill_fields step', async () => {
    const handler = getToolHandler('geometra_run_actions')

    mockState.currentA11yRoot = node('group', undefined, {
      meta: { pageUrl: 'https://jobs.example.com/application', scrollX: 0, scrollY: 0 },
      children: [
        node('textbox', 'Full name', { value: 'Taylor Applicant', path: [0] }),
        node('textbox', 'Phone', { value: '(929) 608-1737', path: [1] }),
      ],
    })

    const result = await handler({
      pageUrl: 'https://jobs.example.com/application',
      headless: true,
      actions: [
        {
          type: 'fill_fields',
          verifyFills: true,
          fields: [
            { kind: 'text', fieldLabel: 'Full name', value: 'Taylor Applicant' },
            { kind: 'text', fieldLabel: 'Phone', value: '+1-929-608-1737' },
          ],
        },
      ],
      stopOnError: true,
      includeSteps: true,
      detail: 'terse',
    })

    const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>
    const steps = payload.steps as Array<Record<string, unknown>>
    expect(steps).toHaveLength(1)
    expect(steps[0]).toMatchObject({
      type: 'fill_fields',
      ok: true,
      fieldCount: 2,
      verification: { verified: 2, mismatches: [] },
    })
  })

  it('runs expand_section inside run_actions and returns the section detail inline', async () => {
    const handler = getToolHandler('geometra_run_actions')

    const fakeDetail = {
      id: 'fm:1.0',
      kind: 'form',
      name: 'Application',
      fieldCount: 3,
      fields: [{ id: 'f1', label: 'Full name', required: true }],
    }
    mockState.expandPageSection.mockReturnValueOnce(fakeDetail)

    const result = await handler({
      pageUrl: 'https://jobs.example.com/application',
      headless: true,
      actions: [
        {
          type: 'expand_section',
          id: 'fm:1.0',
          maxFields: 10,
          onlyRequiredFields: true,
        },
      ],
      includeSteps: true,
      detail: 'terse',
    })

    expect(mockState.expandPageSection).toHaveBeenCalledWith(
      mockState.currentA11yRoot,
      'fm:1.0',
      expect.objectContaining({ maxFields: 10, onlyRequiredFields: true }),
    )

    const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>
    const steps = payload.steps as Array<Record<string, unknown>>
    expect(steps).toHaveLength(1)
    expect(steps[0]).toMatchObject({
      type: 'expand_section',
      ok: true,
      id: 'fm:1.0',
      detail: fakeDetail,
    })
  })

  it('surfaces an error when expand_section id does not match a section', async () => {
    const handler = getToolHandler('geometra_run_actions')

    mockState.expandPageSection.mockReturnValueOnce(null)

    const result = await handler({
      pageUrl: 'https://jobs.example.com/application',
      headless: true,
      actions: [{ type: 'expand_section', id: 'fm:9.9' }],
      includeSteps: true,
      stopOnError: false,
      detail: 'terse',
    })

    const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>
    const steps = payload.steps as Array<Record<string, unknown>>
    expect(steps[0]).toMatchObject({
      type: 'expand_section',
      ok: false,
      error: expect.stringContaining('fm:9.9'),
    })
  })

  it('flags mismatched fields in run_actions verifyFills output', async () => {
    const handler = getToolHandler('geometra_run_actions')

    mockState.currentA11yRoot = node('group', undefined, {
      meta: { pageUrl: 'https://jobs.example.com/application', scrollX: 0, scrollY: 0 },
      children: [
        node('textbox', 'Full name', { value: 'Unexpected Name', path: [0] }),
      ],
    })

    const result = await handler({
      pageUrl: 'https://jobs.example.com/application',
      headless: true,
      actions: [
        {
          type: 'fill_fields',
          verifyFills: true,
          fields: [
            { kind: 'text', fieldLabel: 'Full name', value: 'Taylor Applicant' },
          ],
        },
      ],
      includeSteps: true,
      detail: 'terse',
    })

    const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>
    const steps = payload.steps as Array<Record<string, unknown>>
    const verification = steps[0]!.verification as {
      verified: number
      mismatches: Array<{ fieldLabel: string; expected: string; actual?: string }>
    }
    expect(verification.verified).toBe(0)
    expect(verification.mismatches).toHaveLength(1)
    expect(verification.mismatches[0]).toMatchObject({
      fieldLabel: 'Full name',
      expected: 'Taylor Applicant',
      actual: 'Unexpected Name',
    })
  })

  it('finds repeated actions by itemText in terse mode', async () => {
    const handler = getToolHandler('geometra_find_action')

    mockState.currentA11yRoot = node('group', undefined, {
      bounds: { x: 0, y: 0, width: 1280, height: 720 },
      meta: { pageUrl: 'https://shop.example.com/inventory', scrollX: 0, scrollY: 0 },
      children: [
        node('button', 'Add to cart', { path: [0], bounds: { x: 40, y: 160, width: 120, height: 36 } }),
        node('button', 'Add to cart', { path: [1], bounds: { x: 40, y: 260, width: 120, height: 36 } }),
      ],
    })
    mockState.nodeContexts.set('0', { item: 'Sauce Labs Backpack', section: 'Inventory' })
    mockState.nodeContexts.set('1', { item: 'Sauce Labs Bike Light', section: 'Inventory' })

    const result = await handler({
      name: 'Add to cart',
      itemText: 'Backpack',
      detail: 'terse',
      maxResults: 4,
    })

    const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>
    const matches = payload.matches as Array<Record<string, unknown>>
    expect(payload.matchCount).toBe(1)
    expect(matches[0]).toMatchObject({
      id: 'n:0',
      role: 'button',
      name: 'Add to cart',
      context: { item: 'Sauce Labs Backpack', section: 'Inventory' },
      center: { x: 100, y: 178 },
    })
  })

  it('returns a compact structured connect payload by default', async () => {
    const handler = getToolHandler('geometra_connect')

    const result = await handler({
      pageUrl: 'https://jobs.example.com/application',
      headless: true,
    })

    const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>
    expect(payload).toMatchObject({
      connected: true,
      transport: 'proxy',
      wsUrl: 'ws://127.0.0.1:3200',
      pageUrl: 'https://jobs.example.com/application',
    })
    expect(payload).not.toHaveProperty('currentUi')
  })

  it('prepares a warm browser without creating an active session', async () => {
    const handler = getToolHandler('geometra_prepare_browser')

    const result = await handler({
      pageUrl: 'https://jobs.example.com/application',
      headless: true,
      width: 1280,
      height: 720,
    })

    const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>
    expect(mockState.prewarmProxy).toHaveBeenCalledWith({
      pageUrl: 'https://jobs.example.com/application',
      port: undefined,
      headless: true,
      width: 1280,
      height: 720,
      slowMo: undefined,
    })
    expect(payload).toMatchObject({
      prepared: true,
      reused: false,
      transport: 'embedded',
      pageUrl: 'https://jobs.example.com/application',
      headless: true,
      width: 1280,
      height: 720,
    })
    expect(mockState.connectThroughProxy).not.toHaveBeenCalled()
  })

  it('passes stealth browser mode through proxy-backed connect and prewarm', async () => {
    const connectHandler = getToolHandler('geometra_connect')

    await connectHandler({
      pageUrl: 'https://jobs.example.com/application',
      headless: true,
      stealth: true,
    })

    expect(mockState.connectThroughProxy).toHaveBeenCalledWith(expect.objectContaining({
      pageUrl: 'https://jobs.example.com/application',
      headless: true,
      stealth: true,
    }))

    vi.clearAllMocks()
    mockState.prewarmProxy.mockResolvedValue({
      prepared: true,
      reused: false,
      transport: 'embedded',
      pageUrl: 'https://jobs.example.com/application',
      wsUrl: 'ws://127.0.0.1:3200',
      headless: true,
      stealth: true,
      width: 1280,
      height: 720,
    })
    const prepareHandler = getToolHandler('geometra_prepare_browser')

    await prepareHandler({
      pageUrl: 'https://jobs.example.com/application',
      headless: true,
      stealth: true,
    })

    expect(mockState.prewarmProxy).toHaveBeenCalledWith(expect.objectContaining({
      pageUrl: 'https://jobs.example.com/application',
      headless: true,
      stealth: true,
    }))
  })

  it('maps browserMode onto explicit proxy browser settings', async () => {
    const connectHandler = getToolHandler('geometra_connect')

    await connectHandler({
      pageUrl: 'https://jobs.example.com/application',
      browserMode: 'stock',
    })

    expect(mockState.connectThroughProxy).toHaveBeenCalledWith(expect.objectContaining({
      pageUrl: 'https://jobs.example.com/application',
      stealth: false,
    }))

    vi.clearAllMocks()
    const prepareHandler = getToolHandler('geometra_prepare_browser')

    await prepareHandler({
      pageUrl: 'https://jobs.example.com/application',
      browserMode: 'cloakbrowser',
    })

    expect(mockState.prewarmProxy).toHaveBeenCalledWith(expect.objectContaining({
      pageUrl: 'https://jobs.example.com/application',
      stealth: true,
    }))
  })

  it('rejects contradictory browserMode and stealth settings', async () => {
    const handler = getToolHandler('geometra_connect')

    const result = await handler({
      pageUrl: 'https://jobs.example.com/application',
      browserMode: 'stock',
      stealth: true,
    })

    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toContain('Conflicting browser settings')
    expect(mockState.connectThroughProxy).not.toHaveBeenCalled()
  })

  it('surfaces blocked-site manual handoff metadata on connect', async () => {
    const { buildPageModel } = await import('../session.js')
    const mockBuildPageModel = buildPageModel as ReturnType<typeof vi.fn>
    mockBuildPageModel.mockReturnValueOnce({
      viewport: { width: 1280, height: 800 },
      archetypes: ['content'],
      summary: { landmarkCount: 0, formCount: 0, dialogCount: 0, listCount: 0, focusableCount: 0 },
      blockedSite: {
        detected: true,
        type: 'automation-detected',
        hint: 'Automation block detected',
        recommendedAction: 'manual-handoff',
      },
      primaryActions: [],
      landmarks: [],
      forms: [],
      dialogs: [],
      lists: [],
    })
    const handler = getToolHandler('geometra_connect')

    const result = await handler({
      pageUrl: 'https://jobs.example.com/application',
      returnForms: false,
      blockedSitePolicy: 'manual-handoff',
    })

    const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>
    expect(payload).toMatchObject({
      connected: true,
      blockedSitePolicy: 'manual-handoff',
      blockedSite: {
        detected: true,
        type: 'automation-detected',
      },
      manualHandoff: {
        required: true,
        retry: {
          pageUrl: 'https://jobs.example.com/application',
          headless: false,
        },
      },
    })
  })

  it('returns an MCP error when blockedSitePolicy is error', async () => {
    const { buildPageModel } = await import('../session.js')
    const mockBuildPageModel = buildPageModel as ReturnType<typeof vi.fn>
    mockBuildPageModel.mockReturnValueOnce({
      viewport: { width: 1280, height: 800 },
      archetypes: ['content'],
      summary: { landmarkCount: 0, formCount: 0, dialogCount: 0, listCount: 0, focusableCount: 0 },
      blockedSite: {
        detected: true,
        type: 'access-denied',
        hint: 'Access denied or request blocked page detected',
        recommendedAction: 'review-site-rules',
      },
      primaryActions: [],
      landmarks: [],
      forms: [],
      dialogs: [],
      lists: [],
    })
    const handler = getToolHandler('geometra_connect')

    const result = await handler({
      pageUrl: 'https://jobs.example.com/application',
      returnForms: false,
      blockedSitePolicy: 'error',
    })

    expect(result.isError).toBe(true)
    const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>
    expect(payload).toMatchObject({
      blocked: true,
      blockedSitePolicy: 'error',
      blockedSite: {
        detected: true,
        type: 'access-denied',
      },
    })
  })

  it('can inline a packed form schema into connect for the low-turn form path', async () => {
    const handler = getToolHandler('geometra_connect')
    mockState.formSchemas = [
      {
        formId: 'fm:0',
        name: 'Application',
        fieldCount: 2,
        requiredCount: 1,
        invalidCount: 0,
        fields: [
          { id: 'ff:0.0', fieldKey: 'id:full-name', kind: 'text', label: 'Full name', required: true },
          {
            id: 'ff:0.1',
            fieldKey: 'id:work-authorization',
            kind: 'choice',
            label: 'Work authorization',
            choiceType: 'select',
            optionCount: 2,
            options: ['Yes', 'No'],
            optionDetails: [
              { id: 'id:work-authorization:option:0', value: 'yes', label: 'Yes', index: 0 },
              { id: 'id:work-authorization:option:1', value: 'no', label: 'No', index: 1 },
            ],
          },
        ],
      },
    ]

    const result = await handler({
      pageUrl: 'https://jobs.example.com/application',
      headless: true,
      returnForms: true,
      includeOptions: true,
      includeContext: 'none',
      schemaFormat: 'packed',
    })

    const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>
    expect(payload).toMatchObject({
      connected: true,
      transport: 'proxy',
      pageUrl: 'https://jobs.example.com/application',
      formSchema: {
        changed: true,
        formCount: 1,
        format: 'packed',
        schemaId: expect.any(String),
        forms: [
          {
            i: 'fm:0',
            fc: 2,
            rc: 1,
            ic: 0,
            f: [
              { i: 'ff:0.0', fk: 'id:full-name', k: 'text', l: 'Full name', r: 1 },
              {
                i: 'ff:0.1',
                fk: 'id:work-authorization',
                k: 'choice',
                l: 'Work authorization',
                ch: 'select',
                oc: 2,
                o: ['Yes', 'No'],
                od: [
                  { id: 'id:work-authorization:option:0', value: 'yes', label: 'Yes', index: 0 },
                  { id: 'id:work-authorization:option:1', value: 'no', label: 'No', index: 1 },
                ],
              },
            ],
          },
        ],
      },
    })
  })

  it('can inline the page model into connect for the low-turn exploration path', async () => {
    const handler = getToolHandler('geometra_connect')

    const result = await handler({
      pageUrl: 'https://jobs.example.com/application',
      headless: true,
      returnPageModel: true,
      maxPrimaryActions: 4,
      maxSectionsPerKind: 3,
    })

    const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>
    expect(payload).toMatchObject({
      connected: true,
      transport: 'proxy',
      pageUrl: 'https://jobs.example.com/application',
      pageModel: {
        viewport: { width: 1280, height: 800 },
        archetypes: ['form'],
        summary: { formCount: 1 },
      },
    })
    expect(payload).not.toHaveProperty('formSchema')
  })

  it('can defer the page model so connect returns before the first frame', async () => {
    const handler = getToolHandler('geometra_connect')
    mockState.session.tree = null as unknown as typeof mockState.session.tree
    mockState.session.layout = null as unknown as typeof mockState.session.layout

    const result = await handler({
      pageUrl: 'https://jobs.example.com/application',
      headless: true,
      returnPageModel: true,
      pageModelMode: 'deferred',
      maxPrimaryActions: 4,
      maxSectionsPerKind: 3,
    })

    const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>
    expect(mockState.connectThroughProxy).toHaveBeenCalledWith({
      pageUrl: 'https://jobs.example.com/application',
      port: undefined,
      headless: true,
      width: undefined,
      height: undefined,
      slowMo: undefined,
      awaitInitialFrame: false,
      eagerInitialExtract: true,
    })
    expect(payload).toMatchObject({
      connected: true,
      transport: 'proxy',
      pageUrl: 'https://jobs.example.com/application',
      pageModel: {
        deferred: true,
        ready: false,
        tool: 'geometra_page_model',
        options: {
          maxPrimaryActions: 4,
          maxSectionsPerKind: 3,
        },
      },
    })
  })

  it('waits for the initial tree when page_model is requested after a deferred connect', async () => {
    const handler = getToolHandler('geometra_page_model')
    mockState.session.tree = null as unknown as typeof mockState.session.tree
    mockState.session.layout = null as unknown as typeof mockState.session.layout
    mockState.waitForUiCondition.mockImplementationOnce(async (_session, check) => {
      mockState.session.tree = { kind: 'box' } as unknown as typeof mockState.session.tree
      mockState.session.layout = {
        x: 0,
        y: 0,
        width: 1280,
        height: 800,
        children: [],
      } as unknown as typeof mockState.session.layout
      bumpMockUiRevision()
      return check()
    })

    const result = await handler({
      maxPrimaryActions: 4,
      maxSectionsPerKind: 3,
    })

    const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>
    expect(mockState.waitForUiCondition).toHaveBeenCalledWith(mockState.session, expect.any(Function), 4000)
    expect(payload).toMatchObject({
      viewport: { width: 1280, height: 800 },
      archetypes: ['form'],
      summary: { formCount: 1 },
    })
  })

  it('returns compact form schemas without requiring section expansion', async () => {
    const handler = getToolHandler('geometra_form_schema')
    mockState.formSchemas = [
      {
        formId: 'fm:0',
        name: 'Application',
        fieldCount: 4,
        requiredCount: 3,
        invalidCount: 0,
        fields: [
          { id: 'ff:0.0', kind: 'text', label: 'Full name', required: true },
          { id: 'ff:0.1', kind: 'choice', label: 'Preferred location', required: true, choiceType: 'select' },
          { id: 'ff:0.2', kind: 'choice', label: 'Are you legally authorized to work in Germany?', choiceType: 'group', booleanChoice: true, optionCount: 2 },
          { id: 'ff:0.3', kind: 'toggle', label: 'Share my profile for future roles', controlType: 'checkbox' },
        ],
      },
    ]

    const result = await handler({ maxFields: 20 })
    const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>

    expect(payload).toMatchObject({
      changed: true,
      formCount: 1,
      format: 'compact',
      schemaId: expect.any(String),
      forms: [
        expect.objectContaining({
          formId: 'fm:0',
          fieldCount: 4,
          requiredCount: 3,
          invalidCount: 0,
        }),
      ],
    })
    const forms = payload.forms as Array<Record<string, unknown>>
    const fields = forms[0]?.fields as Array<Record<string, unknown>>
    expect(fields[2]).toMatchObject({
      id: 'ff:0.2',
      kind: 'choice',
      label: 'Are you legally authorized to work in Germany?',
      choiceType: 'group',
      booleanChoice: true,
      optionCount: 2,
    })
    expect(fields[2]).not.toHaveProperty('options')
  })

  it('can include FormGraph-compatible form projections in form_schema output', async () => {
    const handler = getToolHandler('geometra_form_schema')
    mockState.formSchemas = [
      {
        formId: 'fm:0',
        name: 'Application',
        fieldCount: 2,
        requiredCount: 1,
        invalidCount: 0,
        fields: [
          { id: 'ff:0.0', kind: 'text', label: 'Full name', required: true },
          { id: 'ff:0.1', kind: 'choice', label: 'Work authorization', choiceType: 'group', booleanChoice: true, optionCount: 2 },
        ],
      },
    ]

    const result = await handler({ maxFields: 20, includeFormGraph: true })
    const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>

    expect(payload).toMatchObject({
      formCount: 1,
      formGraphs: [
        {
          formgraph: '0.1',
          id: 'geometra:fm:0',
          title: 'Application',
          review: { autoSubmitAllowed: false, requiredBeforeSubmit: true },
          fields: [
            { id: 'ff:0.0', path: 'web.forms.application.full.name', required: true },
            { id: 'ff:0.1', kind: 'boolean' },
          ],
        },
      ],
    })
  })

  it('can auto-connect inside form_schema when given a pageUrl', async () => {
    const handler = getToolHandler('geometra_form_schema')
    mockState.formSchemas = [
      {
        formId: 'fm:0',
        name: 'Application',
        fieldCount: 1,
        requiredCount: 1,
        invalidCount: 0,
        fields: [{ id: 'ff:0.0', kind: 'text', label: 'Full name', required: true }],
      },
    ]

    const result = await handler({
      pageUrl: 'https://jobs.example.com/application',
      headless: true,
    })

    const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>
    expect(mockState.connectThroughProxy).toHaveBeenCalledWith({
      pageUrl: 'https://jobs.example.com/application',
      port: undefined,
      headless: true,
      width: undefined,
      height: undefined,
      slowMo: undefined,
      awaitInitialFrame: undefined,
    })
    expect(payload).toMatchObject({
      autoConnected: true,
      transport: 'proxy',
      pageUrl: 'https://jobs.example.com/application',
      changed: true,
      formCount: 1,
    })
  })

  it('fills a form from ids and labels without echoing long essay content', async () => {
    const longAnswer = 'B'.repeat(220)
    const handler = getToolHandler('geometra_fill_form')
    mockState.formSchemas = [
      {
        formId: 'fm:0',
        name: 'Application',
        fieldCount: 4,
        requiredCount: 3,
        invalidCount: 0,
        fields: [
          { id: 'ff:0.0', kind: 'text', label: 'Full name', required: true },
          { id: 'ff:0.1', kind: 'choice', label: 'Are you legally authorized to work in Germany?', choiceType: 'group', booleanChoice: true, optionCount: 2 },
          { id: 'ff:0.2', kind: 'toggle', label: 'Share my profile for future roles', controlType: 'checkbox' },
          { id: 'ff:0.3', kind: 'text', label: 'Why Geometra?' },
        ],
      },
    ]
    mockState.currentA11yRoot = node('group', undefined, {
      meta: { pageUrl: 'https://jobs.example.com/application', scrollX: 0, scrollY: 640 },
      children: [
        node('textbox', 'Full name', { value: 'Taylor Applicant', path: [0] }),
        node('textbox', 'Why Geometra?', { value: longAnswer, path: [1] }),
        node('checkbox', 'Share my profile for future roles', {
          path: [2],
          state: { checked: true },
        }),
      ],
    })

    const result = await handler({
      valuesById: {
        'ff:0.0': 'Taylor Applicant',
      },
      valuesByLabel: {
        'Are you legally authorized to work in Germany?': true,
        'Share my profile for future roles': true,
        'Why Geometra?': longAnswer,
      },
      includeSteps: true,
      detail: 'minimal',
    })

    const text = result.content[0]!.text
    const payload = JSON.parse(text) as Record<string, unknown>
    const steps = payload.steps as Array<Record<string, unknown>>

    expect(text).not.toContain(longAnswer)
    expect(mockState.sendFieldChoice).toHaveBeenCalledWith(
      mockState.session,
      'Are you legally authorized to work in Germany?',
      'Yes',
      { exact: undefined, query: undefined, choiceType: 'group', fieldId: 'ff:0.1' },
      undefined,
    )
    expect(payload).toMatchObject({
      completed: true,
      formId: 'fm:0',
      requestedValueCount: 4,
      fieldCount: 4,
      successCount: 4,
      errorCount: 0,
    })
    expect(steps[3]).toMatchObject({
      kind: 'text',
      fieldLabel: 'Why Geometra?',
      valueLength: 220,
      readback: { role: 'textbox', valueLength: 220 },
    })
  })

  it('uses batched proxy fill for compact fill_form responses', async () => {
    const handler = getToolHandler('geometra_fill_form')
    mockState.sendFillFields.mockResolvedValueOnce({
      status: 'acknowledged',
      timeoutMs: 6000,
      result: {
        pageUrl: 'https://jobs.example.com/application',
        invalidCount: 0,
        alertCount: 0,
        dialogCount: 0,
        busyCount: 0,
      },
    })
    mockState.formSchemas = [
      {
        formId: 'fm:0',
        name: 'Application',
        fieldCount: 3,
        requiredCount: 2,
        invalidCount: 0,
        fields: [
          { id: 'ff:0.0', kind: 'text', label: 'Full name', required: true },
          { id: 'ff:0.1', kind: 'choice', label: 'Preferred location', required: true, choiceType: 'select' },
          { id: 'ff:0.2', kind: 'toggle', label: 'Share my profile for future roles', controlType: 'checkbox' },
        ],
      },
    ]
    mockState.currentA11yRoot = node('group', undefined, {
      meta: { pageUrl: 'https://jobs.example.com/application', scrollX: 0, scrollY: 640 },
      children: [
        node('textbox', 'Full name', { value: 'Taylor Applicant', path: [0] }),
        node('combobox', 'Preferred location', { value: 'Berlin, Germany', path: [1] }),
        node('checkbox', 'Share my profile for future roles', {
          path: [2],
          state: { checked: true },
        }),
      ],
    })

    const result = await handler({
      valuesById: {
        'ff:0.0': 'Taylor Applicant',
        'ff:0.1': 'Berlin, Germany',
        'ff:0.2': true,
      },
      includeSteps: false,
      detail: 'minimal',
    })

    const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>

    expect(mockState.sendFillFields).toHaveBeenCalledWith(
      mockState.session,
      [
        { kind: 'text', fieldId: 'ff:0.0', fieldLabel: 'Full name', value: 'Taylor Applicant' },
        { kind: 'choice', fieldId: 'ff:0.1', fieldLabel: 'Preferred location', value: 'Berlin, Germany', choiceType: 'select' },
        {
          kind: 'toggle',
          fieldId: 'ff:0.2',
          label: 'Share my profile for future roles',
          checked: true,
          controlType: 'checkbox',
        },
      ],
    )
    expect(mockState.sendFieldText).not.toHaveBeenCalled()
    expect(mockState.sendFieldChoice).not.toHaveBeenCalled()
    expect(mockState.sendSetChecked).not.toHaveBeenCalled()
    expect(payload).toMatchObject({
      completed: true,
      execution: 'batched',
      finalSource: 'proxy',
      formId: 'fm:0',
      fieldCount: 3,
      successCount: 3,
      errorCount: 0,
      final: {
        invalidCount: 0,
        alertCount: 0,
      },
    })
    expect(payload).not.toHaveProperty('steps')
  })

  it('forwards authored field identity and resolves native options by submitted value', async () => {
    const handler = getToolHandler('geometra_fill_form')
    mockState.sendFillFields.mockResolvedValueOnce({
      status: 'acknowledged',
      timeoutMs: 6000,
      result: {
        pageUrl: 'https://jobs.example.com/application',
        invalidCount: 0,
        alertCount: 0,
        dialogCount: 0,
        busyCount: 0,
      },
    })
    mockState.formSchemas = [{
      formId: 'fm:0',
      name: 'Application',
      fieldCount: 1,
      requiredCount: 1,
      invalidCount: 0,
      fields: [{
        id: 'ff:0.0',
        fieldKey: 'id:office-select',
        kind: 'choice',
        label: 'Office',
        required: true,
        choiceType: 'select',
        optionCount: 4,
        options: ['New York'],
        optionDetails: [
          { id: 'id:office-select:option:0', value: '', label: 'Choose an office', index: 0, disabled: true },
          { id: 'id:office-select:option:1', value: 'nyc', label: 'New York', index: 1 },
          { id: 'id:office-select:option:2', value: 'nyc-alt', label: 'New York', index: 2 },
          { id: 'id:office-select:option:3', value: 'legacy', label: 'Legacy', index: 3, disabled: true },
        ],
      }],
    }]
    mockState.currentA11yRoot = node('group', undefined, {
      meta: { pageUrl: 'https://jobs.example.com/application', scrollX: 0, scrollY: 0 },
      children: [
        node('combobox', 'Office', {
          value: 'Los Angeles',
          path: [0],
          state: { invalid: true },
          meta: {
            controlKey: 'id:other-office',
            options: [{ value: 'la', label: 'Los Angeles', index: 0, selected: true }],
          },
        }),
        node('combobox', 'Selected office', {
          value: 'New York',
          path: [1],
          meta: {
            controlKey: 'id:office-select',
            options: [
              { value: 'nyc', label: 'New York', index: 1, selected: false },
              { value: 'nyc-alt', label: 'New York', index: 2, selected: true },
            ],
          },
        }),
      ],
    })

    const result = await handler({
      valuesById: { 'ff:0.0': 'nyc-alt' },
      verifyFills: true,
      includeSteps: false,
      detail: 'minimal',
    })

    expect(result.isError).toBeUndefined()
    expect(mockState.sendFillFields).toHaveBeenCalledWith(mockState.session, [{
      kind: 'choice',
      fieldId: 'ff:0.0',
      fieldKey: 'id:office-select',
      fieldLabel: 'Office',
      value: 'nyc-alt',
      optionIndex: 2,
      exact: true,
      choiceType: 'select',
    }])
    const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>
    expect(payload.verification).toEqual({ verified: 1, mismatches: [] })
  })

  it('rejects ambiguous or disabled native options before sending browser actions', async () => {
    const handler = getToolHandler('geometra_fill_form')
    mockState.formSchemas = [{
      formId: 'fm:0',
      name: 'Application',
      fieldCount: 1,
      requiredCount: 1,
      invalidCount: 0,
      fields: [{
        id: 'ff:0.0',
        fieldKey: 'id:office-select',
        kind: 'choice',
        label: 'Office',
        choiceType: 'select',
        optionDetails: [
          { id: 'id:office-select:option:0', value: 'nyc', label: 'New York', index: 0 },
          { id: 'id:office-select:option:1', value: 'nyc-alt', label: 'New York', index: 1 },
          { id: 'id:office-select:option:2', value: 'legacy', label: 'Legacy', index: 2, disabled: true },
        ],
      }],
    }]

    const ambiguous = await handler({ valuesById: { 'ff:0.0': 'New York' }, includeSteps: false })
    expect(ambiguous.isError).toBe(true)
    expect(ambiguous.content[0]!.text).toContain('maps to multiple submitted values')

    const disabled = await handler({ valuesById: { 'ff:0.0': 'legacy' }, includeSteps: false })
    expect(disabled.isError).toBe(true)
    expect(disabled.content[0]!.text).toContain('is disabled')
    expect(mockState.sendFillFields).not.toHaveBeenCalled()
  })

  it('rejects duplicate unkeyed labels instead of treating fieldId as a browser locator', async () => {
    mockState.formSchemas = [{
      formId: 'fm:0',
      name: 'Application',
      fieldCount: 2,
      requiredCount: 0,
      invalidCount: 0,
      fields: [
        { id: 'ff:0.0', kind: 'text', label: 'Email' },
        { id: 'ff:0.1', kind: 'text', label: 'Email' },
      ],
    }]

    const fillForm = getToolHandler('geometra_fill_form')
    const formResult = await fillForm({ valuesById: { 'ff:0.1': 'backup@example.com' } })
    expect(formResult.isError).toBe(true)
    expect(formResult.content[0]!.text).toContain('refused to guess')

    const fillFields = getToolHandler('geometra_fill_fields')
    const fieldsResult = await fillFields({
      fields: [{ kind: 'text', fieldId: 'ff:0.1', value: 'backup@example.com' }],
    })
    expect(fieldsResult.isError).toBe(true)
    expect(fieldsResult.content[0]!.text).toContain('refused to guess')
    expect(mockState.sendFillFields).not.toHaveBeenCalled()
    expect(mockState.sendFieldText).not.toHaveBeenCalled()
  })

  it('can auto-connect inside fill_form for known-label one-turn flows', async () => {
    const handler = getToolHandler('geometra_fill_form')
    mockState.sendFillFields.mockResolvedValueOnce({
      status: 'acknowledged',
      timeoutMs: 6000,
      result: {
        pageUrl: 'https://jobs.example.com/application',
        invalidCount: 0,
        alertCount: 0,
        dialogCount: 0,
        busyCount: 0,
      },
    })
    mockState.formSchemas = [
      {
        formId: 'fm:0',
        name: 'Application',
        fieldCount: 2,
        requiredCount: 2,
        invalidCount: 0,
        fields: [
          { id: 'ff:0.0', kind: 'text', label: 'Full name', required: true },
          { id: 'ff:0.1', kind: 'choice', label: 'Are you legally authorized to work in Germany?', choiceType: 'group', booleanChoice: true, optionCount: 2 },
        ],
      },
    ]

    const result = await handler({
      pageUrl: 'https://jobs.example.com/application',
      headless: true,
      valuesByLabel: {
        'Full name': 'Taylor Applicant',
        'Are you legally authorized to work in Germany?': true,
      },
      includeSteps: false,
      detail: 'minimal',
    })

    const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>
    expect(mockState.connectThroughProxy).toHaveBeenCalledWith({
      pageUrl: 'https://jobs.example.com/application',
      port: undefined,
      headless: true,
      width: undefined,
      height: undefined,
      slowMo: undefined,
      awaitInitialFrame: undefined,
    })
    expect(mockState.sendFillFields).toHaveBeenCalledWith(
      mockState.session,
      [
        { kind: 'text', fieldId: 'ff:0.0', fieldLabel: 'Full name', value: 'Taylor Applicant' },
        {
          kind: 'choice',
          fieldId: 'ff:0.1',
          fieldLabel: 'Are you legally authorized to work in Germany?',
          value: 'Yes',
          choiceType: 'group',
        },
      ],
    )
    expect(payload).toMatchObject({
      autoConnected: true,
      transport: 'proxy',
      pageUrl: 'https://jobs.example.com/application',
      completed: true,
      execution: 'batched',
      finalSource: 'proxy',
      formId: 'fm:0',
      fieldCount: 2,
      successCount: 2,
      errorCount: 0,
      final: {
        invalidCount: 0,
        alertCount: 0,
      },
    })
  })
})

describe('submit_form tool', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetMockActionBehaviors()
    resetMockSessionCaches()
    mockState.formSchemas = []
  })

  it('combines fill + submit-click + post-submit wait in one call', async () => {
    const handler = getToolHandler('geometra_submit_form')

    mockState.currentA11yRoot = node('group', undefined, {
      bounds: { x: 0, y: 0, width: 1280, height: 800 },
      meta: { pageUrl: 'https://jobs.example.com/application', scrollX: 0, scrollY: 0 },
      children: [
        node('form', 'Application', {
          path: [0],
          children: [
            node('textbox', 'Full name', { value: '', path: [0, 0] }),
            node('textbox', 'Email', { value: '', path: [0, 1] }),
            node('button', 'Submit application', {
              bounds: { x: 60, y: 480, width: 180, height: 40 },
              path: [0, 2],
            }),
          ],
        }),
      ],
    })
    mockState.formSchemas = [{
      formId: 'fm:0',
      name: 'Application',
      fieldCount: 2,
      requiredCount: 2,
      invalidCount: 2,
      fields: [
        { id: 'ff:0.0', kind: 'text', label: 'Full name' },
        { id: 'ff:0.1', kind: 'text', label: 'Email' },
      ],
    }]
    mockState.sendFillFields.mockImplementationOnce(async () => ({
      status: 'acknowledged',
      timeoutMs: 6000,
      result: { invalidCount: 0, alertCount: 0, dialogCount: 0, busyCount: 0, pageUrl: 'https://jobs.example.com/application' },
    }))
    mockState.sendClick.mockImplementationOnce(async () => {
      mockState.currentA11yRoot = node('group', undefined, {
        bounds: { x: 0, y: 0, width: 1280, height: 800 },
        meta: { pageUrl: 'https://jobs.example.com/confirm', scrollX: 0, scrollY: 0 },
        children: [
          node('dialog', 'Application submitted', {
            bounds: { x: 240, y: 140, width: 420, height: 260 },
            path: [0],
          }),
        ],
      })
      bumpMockUiRevision()
      return { status: 'updated' as const, timeoutMs: 2000 }
    })

    const result = await handler({
      valuesByLabel: { 'Full name': 'Taylor Applicant', Email: 'taylor@example.com' },
      submit: { role: 'button', name: 'Submit application' },
      waitFor: { role: 'dialog', name: 'Application submitted', timeoutMs: 5000 },
      detail: 'minimal',
    })

    const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>
    expect(payload).toMatchObject({
      completed: true,
      execution: 'completed',
      outcome: 'submitted',
      fill: { fieldCount: 2, formId: 'fm:0' },
      submit: { target: { role: 'button', name: 'Submit application' } },
      waitFor: { present: true, matchCount: 1, fresh: true },
      navigated: true,
      afterUrl: 'https://jobs.example.com/confirm',
    })
    expect(mockState.sendFillFields).toHaveBeenCalledTimes(1)
    expect(mockState.sendClick).toHaveBeenCalledTimes(1)
  })

  it('preserves the resolved form scope in a soft-timeout resume hint after fill', async () => {
    const handler = getToolHandler('geometra_submit_form')
    mockState.currentA11yRoot = node('group', undefined, {
      bounds: { x: 0, y: 0, width: 1280, height: 800 },
      meta: { pageUrl: 'https://jobs.example.com/application', scrollX: 0, scrollY: 0 },
      children: [
        node('form', 'Application', {
          path: [0],
          children: [
            node('textbox', 'Full name', { path: [0, 0] }),
            node('button', 'Submit', {
              bounds: { x: 60, y: 480, width: 100, height: 40 },
              path: [0, 1],
            }),
          ],
        }),
      ],
    })
    mockState.formSchemas = [{
      formId: 'fm:0',
      name: 'Application',
      fieldCount: 1,
      requiredCount: 0,
      invalidCount: 0,
      fields: [{ id: 'ff:0.0', fieldKey: 'id:full-name', kind: 'text', label: 'Full name' }],
    }]
    mockState.sendFillFields.mockImplementationOnce(async () => {
      await new Promise(resolve => setTimeout(resolve, 300))
      return {
        status: 'acknowledged' as const,
        timeoutMs: 250,
        result: { invalidCount: 0, alertCount: 0, dialogCount: 0, busyCount: 0 },
      }
    })

    const result = await handler({
      valuesByLabel: { 'Full name': 'Taylor Applicant' },
      submit: { role: 'button', name: 'Submit' },
      softTimeoutMs: 1_000,
      detail: 'terse',
    })

    const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>
    expect(result.isError).toBeUndefined()
    expect(payload).toMatchObject({
      paused: true,
      phase: 'submit',
      fill: { formId: 'fm:0', fieldCount: 1 },
      resumeHint: {
        tool: 'geometra_submit_form',
        skipFill: true,
        formId: 'fm:0',
      },
    })
    expect(mockState.sendClick).not.toHaveBeenCalled()
  })

  it('does not leak formId into a strict geometra_wait_for resume hint', async () => {
    const handler = getToolHandler('geometra_submit_form')
    mockState.currentA11yRoot = node('group', undefined, {
      bounds: { x: 0, y: 0, width: 1280, height: 800 },
      meta: { pageUrl: 'https://jobs.example.com/application', scrollX: 0, scrollY: 0 },
      children: [
        node('form', 'Application', {
          path: [0],
          children: [
            node('button', 'Submit', {
              bounds: { x: 60, y: 480, width: 100, height: 40 },
              path: [0, 0],
            }),
          ],
        }),
      ],
    })
    mockState.formSchemas = [{
      formId: 'fm:0',
      name: 'Application',
      fieldCount: 0,
      requiredCount: 0,
      invalidCount: 0,
      fields: [],
    }]
    mockState.sendClick.mockImplementationOnce(async () => {
      await new Promise(resolve => setTimeout(resolve, 300))
      return { status: 'acknowledged' as const, timeoutMs: 250 }
    })

    const result = await handler({
      skipFill: true,
      formId: 'fm:0',
      submit: { role: 'button', name: 'Submit' },
      waitFor: { role: 'dialog', name: 'Application submitted' },
      softTimeoutMs: 1_000,
      detail: 'terse',
    })

    const payload = JSON.parse(result.content[0]!.text) as {
      paused?: boolean
      phase?: string
      resumeHint?: Record<string, unknown>
    }
    expect(payload).toMatchObject({
      paused: true,
      phase: 'wait_for',
      resumeHint: {
        tool: 'geometra_wait_for',
        role: 'dialog',
        name: 'Application submitted',
        present: true,
      },
    })
    expect(payload.resumeHint).not.toHaveProperty('formId')
    const { tool, ...hintArgs } = payload.resumeHint ?? {}
    expect(tool).toBe('geometra_wait_for')
    expect(getToolInputSchema('geometra_wait_for').safeParse(hintArgs).success).toBe(true)
  })

  it('fails closed when fill replaces the selected form at the same path', async () => {
    const handler = getToolHandler('geometra_submit_form')
    mockState.currentA11yRoot = node('group', undefined, {
      bounds: { x: 0, y: 0, width: 1280, height: 800 },
      meta: { pageUrl: 'https://jobs.example.com/application', scrollX: 0, scrollY: 0 },
      children: [
        node('form', 'Application', {
          path: [0],
          children: [
            node('textbox', 'Full name', { path: [0, 0] }),
            node('button', 'Submit', {
              bounds: { x: 60, y: 480, width: 100, height: 40 },
              path: [0, 1],
            }),
          ],
        }),
      ],
    })
    mockState.formSchemas = [{
      formId: 'fm:0',
      name: 'Application',
      fieldCount: 1,
      requiredCount: 0,
      invalidCount: 0,
      fields: [{ id: 'ff:0.0', fieldKey: 'id:full-name', kind: 'text', label: 'Full name' }],
    }]
    mockState.sendFillFields.mockImplementationOnce(async () => {
      mockState.currentA11yRoot = node('group', undefined, {
        bounds: { x: 0, y: 0, width: 1280, height: 800 },
        meta: { pageUrl: 'https://jobs.example.com/application', scrollX: 0, scrollY: 0 },
        children: [
          node('form', 'Newsletter', {
            path: [0],
            children: [
              node('textbox', 'Email', { path: [0, 0] }),
              node('button', 'Submit', {
                bounds: { x: 60, y: 480, width: 100, height: 40 },
                path: [0, 1],
              }),
            ],
          }),
        ],
      })
      mockState.formSchemas = [{
        formId: 'fm:0',
        name: 'Newsletter',
        fieldCount: 1,
        requiredCount: 0,
        invalidCount: 0,
        fields: [{ id: 'ff:0.0', fieldKey: 'id:email', kind: 'text', label: 'Email' }],
      }]
      bumpMockUiRevision()
      return {
        status: 'acknowledged' as const,
        timeoutMs: 2_000,
        result: { invalidCount: 0, alertCount: 0, dialogCount: 0, busyCount: 0 },
      }
    })

    const result = await handler({
      valuesByLabel: { 'Full name': 'Taylor Applicant' },
      submit: { role: 'button', name: 'Submit' },
      detail: 'terse',
    })

    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toContain('replaced at the same path')
    expect(mockState.sendClick).not.toHaveBeenCalled()
  })

  it('revalidates moved submit bounds and clicks the current visible center', async () => {
    const handler = getToolHandler('geometra_submit_form')
    mockState.currentA11yRoot = node('group', undefined, {
      bounds: { x: 0, y: 0, width: 1280, height: 800 },
      meta: { pageUrl: 'https://jobs.example.com/application', scrollX: 0, scrollY: 0 },
      children: [
        node('form', 'Application', {
          path: [0],
          children: [
            node('textbox', 'Full name', { path: [0, 0] }),
            node('button', 'Submit', {
              bounds: { x: 60, y: 480, width: 100, height: 40 },
              path: [0, 1],
            }),
          ],
        }),
      ],
    })
    mockState.formSchemas = [{
      formId: 'fm:0',
      name: 'Application',
      fieldCount: 1,
      requiredCount: 0,
      invalidCount: 0,
      fields: [{ id: 'ff:0.0', fieldKey: 'id:full-name', kind: 'text', label: 'Full name' }],
    }]
    mockState.nodeContexts.set('0.1', { section: 'Application actions' })
    mockState.nodeContextReadHook = candidate => {
      if ((candidate.path ?? []).join('.') !== '0.1') return
      mockState.nodeContextReadHook = undefined
      mockState.currentA11yRoot = node('group', undefined, {
        bounds: { x: 0, y: 0, width: 1280, height: 800 },
        meta: { pageUrl: 'https://jobs.example.com/application', scrollX: 0, scrollY: 0 },
        children: [
          node('form', 'Application', {
            path: [0],
            children: [
              node('textbox', 'Full name', { path: [0, 0] }),
              node('button', 'Submit', {
                bounds: { x: 500, y: 300, width: 100, height: 40 },
                path: [0, 1],
              }),
            ],
          }),
        ],
      })
      bumpMockUiRevision()
    }

    await handler({
      skipFill: true,
      formId: 'fm:0',
      submit: { role: 'button', name: 'Submit', contextText: 'Application actions' },
      detail: 'terse',
    })

    expect(mockState.sendClick).toHaveBeenCalledWith(
      mockState.session,
      550,
      320,
      expect.any(Number),
    )
  })

  it('fails closed if the scoped UI tree disappears before submit click', async () => {
    const handler = getToolHandler('geometra_submit_form')
    mockState.currentA11yRoot = node('group', undefined, {
      bounds: { x: 0, y: 0, width: 1280, height: 800 },
      meta: { pageUrl: 'https://jobs.example.com/application', scrollX: 0, scrollY: 0 },
      children: [
        node('form', 'Application', {
          path: [0],
          children: [
            node('textbox', 'Full name', { path: [0, 0] }),
            node('button', 'Submit', {
              bounds: { x: 60, y: 480, width: 100, height: 40 },
              path: [0, 1],
            }),
          ],
        }),
      ],
    })
    mockState.formSchemas = [{
      formId: 'fm:0',
      name: 'Application',
      fieldCount: 1,
      requiredCount: 0,
      invalidCount: 0,
      fields: [{ id: 'ff:0.0', fieldKey: 'id:full-name', kind: 'text', label: 'Full name' }],
    }]
    mockState.nodeContexts.set('0.1', { section: 'Application actions' })
    mockState.nodeContextReadHook = candidate => {
      if ((candidate.path ?? []).join('.') !== '0.1') return
      mockState.nodeContextReadHook = undefined
      mockState.currentA11yRoot = null
      bumpMockUiRevision()
    }

    const result = await handler({
      skipFill: true,
      formId: 'fm:0',
      submit: { role: 'button', name: 'Submit', contextText: 'Application actions' },
      detail: 'terse',
    })

    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toContain('current UI tree is unavailable')
    expect(mockState.sendClick).not.toHaveBeenCalled()
  })

  it('resolves submitIndex only among matching controls inside the selected form', async () => {
    const handler = getToolHandler('geometra_submit_form')
    mockState.currentA11yRoot = node('group', undefined, {
      bounds: { x: 0, y: 0, width: 1280, height: 800 },
      meta: { pageUrl: 'https://jobs.example.com/application', scrollX: 0, scrollY: 0 },
      children: [
        node('form', 'Newsletter', {
          path: [0],
          children: [
            node('button', 'Submit', {
              bounds: { x: 40, y: 100, width: 100, height: 40 },
              path: [0, 0],
            }),
          ],
        }),
        node('region', 'Application', {
          path: [1],
          children: [
            node('textbox', 'Full name', { path: [1, 0] }),
            node('textbox', 'Email', { path: [1, 1] }),
            node('button', 'Submit', {
              bounds: { x: 400, y: 300, width: 100, height: 40 },
              path: [1, 2],
            }),
            node('button', 'Submit', {
              bounds: { x: 400, y: 400, width: 100, height: 40 },
              path: [1, 3],
            }),
          ],
        }),
      ],
    })
    mockState.formSchemas = [
      { formId: 'fm:0', name: 'Newsletter', fieldCount: 0, requiredCount: 0, invalidCount: 0, fields: [] },
      { formId: 'fm:1', name: 'Application', fieldCount: 2, requiredCount: 0, invalidCount: 0, fields: [] },
    ]
    mockState.nodeContexts.set('0.0', { section: 'Shared submit context' })
    mockState.nodeContexts.set('1.2', { section: 'Shared submit context' })
    mockState.nodeContexts.set('1.3', { section: 'Shared submit context' })

    const result = await handler({
      skipFill: true,
      formId: 'fm:1',
      submit: { role: 'button', name: 'Submit', contextText: 'Shared submit context' },
      submitIndex: 1,
      detail: 'terse',
    })

    expect(result.isError).toBeUndefined()
    expect(mockState.sendClick).toHaveBeenCalledTimes(1)
    expect(mockState.sendClick).toHaveBeenCalledWith(
      mockState.session,
      450,
      420,
      expect.any(Number),
    )
  })

  it('fails closed without clicking when the filled form path is stale before submit', async () => {
    const handler = getToolHandler('geometra_submit_form')
    mockState.currentA11yRoot = node('group', undefined, {
      bounds: { x: 0, y: 0, width: 1280, height: 800 },
      meta: { pageUrl: 'https://jobs.example.com/application', scrollX: 0, scrollY: 0 },
      children: [
        node('form', 'Application', {
          path: [0],
          children: [
            node('textbox', 'Full name', { path: [0, 0] }),
            node('button', 'Submit', {
              bounds: { x: 60, y: 480, width: 100, height: 40 },
              path: [0, 1],
            }),
          ],
        }),
      ],
    })
    mockState.formSchemas = [{
      formId: 'fm:0',
      name: 'Application',
      fieldCount: 1,
      requiredCount: 0,
      invalidCount: 0,
      fields: [{ id: 'ff:0.0', kind: 'text', label: 'Full name' }],
    }]
    mockState.sendFillFields.mockImplementationOnce(async () => {
      mockState.currentA11yRoot = node('group', undefined, {
        bounds: { x: 0, y: 0, width: 1280, height: 800 },
        meta: { pageUrl: 'https://jobs.example.com/application', scrollX: 0, scrollY: 0 },
        children: [
          node('button', 'Submit', {
            bounds: { x: 40, y: 100, width: 100, height: 40 },
            path: [0],
          }),
        ],
      })
      mockState.formSchemas = []
      bumpMockUiRevision()
      return {
        status: 'acknowledged' as const,
        timeoutMs: 2000,
        result: { invalidCount: 0, alertCount: 0, dialogCount: 0, busyCount: 0 },
      }
    })

    const result = await handler({
      valuesByLabel: { 'Full name': 'Taylor Applicant' },
      submit: { role: 'button', name: 'Submit' },
      detail: 'terse',
    })

    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toContain('stale')
    expect(mockState.sendClick).not.toHaveBeenCalled()
  })

  it('rejects missing values when skipFill is false', async () => {
    const handler = getToolHandler('geometra_submit_form')
    mockState.currentA11yRoot = node('group', undefined, {
      bounds: { x: 0, y: 0, width: 1280, height: 800 },
      meta: { pageUrl: 'https://jobs.example.com/application', scrollX: 0, scrollY: 0 },
      children: [
        node('button', 'Submit', { bounds: { x: 60, y: 480, width: 100, height: 40 }, path: [0] }),
      ],
    })
    const result = await handler({ detail: 'minimal' })
    expect(result.content[0]!.text).toContain('Provide at least one value')
  })

  it('keeps nested submit and wait contracts strict', () => {
    const schema = getToolInputSchema('geometra_submit_form')
    expect(schema.safeParse({ skipFill: true, submit: { role: 'button', nmae: 'Submit' } }).success).toBe(false)
    expect(schema.safeParse({ skipFill: true, waitFor: { role: 'dialog', presnt: true } }).success).toBe(false)
  })

  it('does not click submit when retained invalid controls are already known', async () => {
    const handler = getToolHandler('geometra_submit_form')
    mockState.currentA11yRoot = node('group', undefined, {
      bounds: { x: 0, y: 0, width: 1280, height: 800 },
      meta: { pageUrl: 'https://jobs.example.com/application', scrollX: 0, scrollY: 0 },
      children: [
        node('listbox', 'Office', {
          path: [0],
          state: { invalid: true, required: true },
          validation: { error: 'Select an office.' },
        }),
        node('button', 'Submit', { bounds: { x: 60, y: 480, width: 100, height: 40 }, path: [1] }),
      ],
    })

    const result = await handler({ skipFill: true, detail: 'terse' })
    const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>

    expect(payload).toMatchObject({
      completed: false,
      outcome: 'validation_failed',
      submit: { attempted: false },
      final: { invalidCount: 1 },
    })
    expect(mockState.sendClick).not.toHaveBeenCalled()
  })

  it('does not let an unrelated invalid form block the target form submission', async () => {
    const handler = getToolHandler('geometra_submit_form')
    mockState.currentA11yRoot = node('group', undefined, {
      bounds: { x: 0, y: 0, width: 1280, height: 800 },
      meta: { pageUrl: 'https://jobs.example.com/application', scrollX: 0, scrollY: 0 },
      children: [
        node('form', 'Newsletter', {
          path: [0],
          children: [
            node('textbox', 'Newsletter email', {
              path: [0, 0],
              state: { invalid: true, required: true },
              validation: { error: 'Enter an email address.' },
            }),
          ],
        }),
        node('form', 'Application', {
          path: [1],
          children: [
            node('button', 'Submit', {
              bounds: { x: 60, y: 480, width: 100, height: 40 },
              path: [1, 0],
            }),
          ],
        }),
      ],
    })
    mockState.sendClick.mockResolvedValueOnce({
      status: 'acknowledged',
      timeoutMs: 2000,
      result: {
        navigated: true,
        pageUrl: 'https://jobs.example.com/confirm',
        urlBefore: 'https://jobs.example.com/application',
      },
    })

    const result = await handler({ skipFill: true, detail: 'terse' })
    const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>

    expect(payload).toMatchObject({
      completed: true,
      outcome: 'submitted',
      navigated: true,
      final: { invalidCount: 0 },
    })
    expect(mockState.sendClick).toHaveBeenCalledTimes(1)
  })

  it('reports skipFill submit without postcondition evidence as unconfirmed', async () => {
    const handler = getToolHandler('geometra_submit_form')
    mockState.currentA11yRoot = node('group', undefined, {
      bounds: { x: 0, y: 0, width: 1280, height: 800 },
      meta: { pageUrl: 'https://jobs.example.com/application', scrollX: 0, scrollY: 0 },
      children: [
        node('button', 'Submit', { bounds: { x: 60, y: 480, width: 100, height: 40 }, path: [0] }),
      ],
    })
    mockState.sendClick.mockImplementationOnce(async () => {
      bumpMockUiRevision()
      return { status: 'updated' as const, timeoutMs: 2000 }
    })
    const result = await handler({
      skipFill: true,
      submit: { role: 'button', name: 'Submit' },
      detail: 'minimal',
    })
    const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>
    expect(payload).toMatchObject({
      completed: false,
      execution: 'completed',
      outcome: 'unconfirmed',
    })
    expect(payload).not.toHaveProperty('fill')
    expect(mockState.sendFillFields).not.toHaveBeenCalled()
    expect(mockState.sendClick).toHaveBeenCalledTimes(1)
  })

  it.each([false, true])(
    'reports retained invalid fields as validation_failed when failOnInvalid=%s',
    async (failOnInvalid) => {
      const handler = getToolHandler('geometra_submit_form')
      mockState.currentA11yRoot = node('group', undefined, {
        bounds: { x: 0, y: 0, width: 1280, height: 800 },
        meta: { pageUrl: 'https://jobs.example.com/application', scrollX: 0, scrollY: 0 },
        children: [
          node('button', 'Submit', { bounds: { x: 60, y: 480, width: 100, height: 40 }, path: [0] }),
        ],
      })
      mockState.sendClick.mockImplementationOnce(async () => {
        mockState.currentA11yRoot = node('group', undefined, {
          bounds: { x: 0, y: 0, width: 1280, height: 800 },
          meta: { pageUrl: 'https://jobs.example.com/application', scrollX: 0, scrollY: 0 },
          children: [
            node('textbox', 'Email', {
              path: [0],
              state: { invalid: true, required: true },
              validation: { error: 'Enter a valid email address.' },
            }),
            node('button', 'Submit', { bounds: { x: 60, y: 480, width: 100, height: 40 }, path: [1] }),
          ],
        })
        bumpMockUiRevision()
        return { status: 'updated' as const, timeoutMs: 2000 }
      })

      const result = await handler({
        skipFill: true,
        failOnInvalid,
        detail: 'terse',
      })
      const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>

      expect(payload).toMatchObject({
        completed: false,
        execution: 'completed',
        outcome: 'validation_failed',
        final: { invalidCount: 1 },
      })
      expect(result.isError).toBe(failOnInvalid ? true : undefined)
    },
  )

  it('reports a timed-out submit click as unconfirmed', async () => {
    const handler = getToolHandler('geometra_submit_form')
    mockState.currentA11yRoot = node('group', undefined, {
      bounds: { x: 0, y: 0, width: 1280, height: 800 },
      meta: { pageUrl: 'https://jobs.example.com/application', scrollX: 0, scrollY: 0 },
      children: [
        node('button', 'Submit', { bounds: { x: 60, y: 480, width: 100, height: 40 }, path: [0] }),
      ],
    })
    mockState.sendClick.mockResolvedValueOnce({ status: 'timed_out', timeoutMs: 500 })

    const result = await handler({ skipFill: true, detail: 'terse' })
    const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>

    expect(result.isError).toBeUndefined()
    expect(payload).toMatchObject({
      completed: false,
      execution: 'unconfirmed',
      outcome: 'unconfirmed',
      submit: { wait: 'timed_out' },
    })
  })

  it('does not accept a stale preexisting waitFor match as submit confirmation', async () => {
    const handler = getToolHandler('geometra_submit_form')
    mockState.currentA11yRoot = node('group', undefined, {
      bounds: { x: 0, y: 0, width: 1280, height: 800 },
      meta: { pageUrl: 'https://jobs.example.com/application', scrollX: 0, scrollY: 0 },
      children: [
        node('button', 'Submit', { bounds: { x: 60, y: 480, width: 100, height: 40 }, path: [0] }),
        node('dialog', 'Application submitted', { path: [1] }),
      ],
    })
    mockState.sendClick.mockImplementationOnce(async () => {
      bumpMockUiRevision()
      return { status: 'updated' as const, timeoutMs: 2000 }
    })

    const result = await handler({
      skipFill: true,
      waitFor: { role: 'dialog', name: 'Application submitted', timeoutMs: 5000 },
      detail: 'terse',
    })
    const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>

    expect(payload).toMatchObject({
      completed: false,
      execution: 'completed',
      outcome: 'unconfirmed',
      waitFor: { present: true, matchCount: 1, fresh: false },
    })
  })

  it('does not treat focus or path churn on stale wait evidence as fresh', async () => {
    const handler = getToolHandler('geometra_submit_form')
    mockState.currentA11yRoot = node('group', undefined, {
      bounds: { x: 0, y: 0, width: 1280, height: 800 },
      meta: { pageUrl: 'https://jobs.example.com/application', scrollX: 0, scrollY: 0 },
      children: [
        node('button', 'Submit', { bounds: { x: 60, y: 480, width: 100, height: 40 }, path: [0] }),
        node('dialog', 'Application submitted', { path: [1], state: { focused: false } }),
      ],
    })
    mockState.sendClick.mockImplementationOnce(async () => {
      mockState.currentA11yRoot = node('group', undefined, {
        bounds: { x: 0, y: 0, width: 1280, height: 800 },
        meta: { pageUrl: 'https://jobs.example.com/application', scrollX: 0, scrollY: 0 },
        children: [
          node('dialog', 'Application submitted', { path: [0], state: { focused: true } }),
          node('button', 'Submit', { bounds: { x: 60, y: 480, width: 100, height: 40 }, path: [1] }),
        ],
      })
      bumpMockUiRevision()
      return { status: 'updated' as const, timeoutMs: 2000 }
    })

    const result = await handler({
      skipFill: true,
      waitFor: { role: 'dialog', name: 'Application submitted', timeoutMs: 500 },
      detail: 'terse',
    })
    const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>
    expect(payload).toMatchObject({ completed: false, outcome: 'unconfirmed', waitFor: { fresh: false } })
  })

  it('compares navigation with the URL immediately before the submit click', async () => {
    const handler = getToolHandler('geometra_submit_form')
    mockState.currentA11yRoot = node('group', undefined, {
      bounds: { x: 0, y: 0, width: 1280, height: 800 },
      meta: { pageUrl: 'https://jobs.example.com/application', scrollX: 0, scrollY: 0 },
      children: [
        node('form', 'Application', {
          path: [0],
          children: [
            node('textbox', 'Full name', { path: [0, 0] }),
            node('button', 'Submit', {
              bounds: { x: 60, y: 480, width: 100, height: 40 },
              path: [0, 1],
            }),
          ],
        }),
      ],
    })
    mockState.formSchemas = [{
      formId: 'fm:0', name: 'Application', fieldCount: 1, requiredCount: 0, invalidCount: 0,
      fields: [{ id: 'ff:0', kind: 'text', label: 'Full name' }],
    }]
    mockState.sendFillFields.mockImplementationOnce(async () => {
      mockState.currentA11yRoot = node('group', undefined, {
        bounds: { x: 0, y: 0, width: 1280, height: 800 },
        meta: { pageUrl: 'https://jobs.example.com/review', scrollX: 0, scrollY: 0 },
        children: [
          node('form', 'Application', {
            path: [0],
            children: [
              node('button', 'Submit', {
                bounds: { x: 60, y: 480, width: 100, height: 40 },
                path: [0, 0],
              }),
            ],
          }),
        ],
      })
      bumpMockUiRevision()
      return { status: 'acknowledged' as const, timeoutMs: 2000, result: { invalidCount: 0, alertCount: 0, dialogCount: 0, busyCount: 0 } }
    })
    mockState.sendClick.mockResolvedValueOnce({ status: 'acknowledged', timeoutMs: 2000 })

    const result = await handler({ valuesByLabel: { 'Full name': 'Taylor' }, detail: 'terse' })
    const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>
    expect(payload).toMatchObject({ completed: false, outcome: 'unconfirmed' })
    expect(payload).not.toHaveProperty('navigated')
  })

  it('does not treat a disappeared page as navigation evidence', async () => {
    const handler = getToolHandler('geometra_submit_form')
    mockState.currentA11yRoot = node('group', undefined, {
      bounds: { x: 0, y: 0, width: 1280, height: 800 },
      meta: { pageUrl: 'https://jobs.example.com/application', scrollX: 0, scrollY: 0 },
      children: [node('button', 'Submit', { bounds: { x: 60, y: 480, width: 100, height: 40 }, path: [0] })],
    })
    mockState.sendClick.mockResolvedValueOnce({
      status: 'acknowledged', timeoutMs: 2000,
      result: { pageUnavailable: true, urlBefore: 'https://jobs.example.com/application' },
    })

    const result = await handler({ skipFill: true, detail: 'terse' })
    const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>
    expect(payload).toMatchObject({ completed: false, outcome: 'unconfirmed' })
    expect(payload).not.toHaveProperty('navigated')
  })

  it('does not report submitted when explicit post-submit evidence times out after navigation', async () => {
    const handler = getToolHandler('geometra_submit_form')
    mockState.currentA11yRoot = node('group', undefined, {
      bounds: { x: 0, y: 0, width: 1280, height: 800 },
      meta: { pageUrl: 'https://jobs.example.com/application', scrollX: 0, scrollY: 0 },
      children: [node('button', 'Submit', { bounds: { x: 60, y: 480, width: 100, height: 40 }, path: [0] })],
    })
    mockState.sendClick.mockResolvedValueOnce({
      status: 'acknowledged', timeoutMs: 2000,
      result: { navigated: true, pageUrl: 'https://jobs.example.com/confirm', urlBefore: 'https://jobs.example.com/application' },
    })
    mockState.waitForUiCondition.mockResolvedValueOnce(false)

    const result = await handler({
      skipFill: true,
      waitFor: { role: 'dialog', name: 'Application submitted', timeoutMs: 50 },
      detail: 'terse',
    })
    const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>
    expect(result.isError).toBe(true)
    expect(payload).toMatchObject({ completed: false, outcome: 'unconfirmed', navigated: true, waitFor: { ok: false } })
  })

  it('accepts proxy navigation evidence as submit confirmation', async () => {
    const handler = getToolHandler('geometra_submit_form')
    mockState.currentA11yRoot = node('group', undefined, {
      bounds: { x: 0, y: 0, width: 1280, height: 800 },
      meta: { pageUrl: 'https://jobs.example.com/application', scrollX: 0, scrollY: 0 },
      children: [
        node('button', 'Submit', { bounds: { x: 60, y: 480, width: 100, height: 40 }, path: [0] }),
      ],
    })
    mockState.sendClick.mockResolvedValueOnce({
      status: 'acknowledged',
      timeoutMs: 2000,
      result: {
        navigated: true,
        pageUrl: 'https://jobs.example.com/confirm',
        urlBefore: 'https://jobs.example.com/application',
      },
    })

    const result = await handler({ skipFill: true, detail: 'terse' })
    const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>

    expect(payload).toMatchObject({
      completed: true,
      execution: 'completed',
      outcome: 'submitted',
      navigated: true,
      afterUrl: 'https://jobs.example.com/confirm',
    })
  })

  it('aggregates fill + submit fallback into a top-level fallbacks[] on the submit_form result', async () => {
    const handler = getToolHandler('geometra_submit_form')
    mockState.currentA11yRoot = node('group', undefined, {
      bounds: { x: 0, y: 0, width: 1280, height: 800 },
      meta: { pageUrl: 'https://jobs.example.com/application', scrollX: 0, scrollY: 0 },
      children: [
        node('form', 'Application', {
          path: [0],
          children: [
            node('textbox', 'Full name', { value: '', path: [0, 0] }),
            node('button', 'Submit', {
              // Fully offscreen so the fullyVisible resolve misses and the
              // relaxed-visibility fallback picks it up — mirrors the click test above.
              bounds: { x: 60, y: 780, width: 180, height: 60 },
              path: [0, 1],
            }),
          ],
        }),
      ],
    })
    mockState.formSchemas = [{
      formId: 'fm:0',
      name: 'Application',
      fieldCount: 1,
      requiredCount: 1,
      invalidCount: 1,
      fields: [{ id: 'ff:0.0', kind: 'text', label: 'Full name' }],
    }]
    // Force the fill batched path to throw a recoverable error so submit_form
    // falls through to the sequential fill loop and tags fill fallback.
    mockState.sendFillFields.mockRejectedValue(new Error('Unsupported client message type "fillFields"'))
    mockState.sendClick.mockResolvedValueOnce({ status: 'updated', timeoutMs: 2000 })

    const result = await handler({
      valuesByLabel: { 'Full name': 'Taylor Applicant' },
      submit: { role: 'button', name: 'Submit' },
      submitTimeoutMs: 1000,
      detail: 'minimal',
    })
    const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>
    const fallbacks = payload.fallbacks as Array<Record<string, unknown>>
    expect(Array.isArray(fallbacks)).toBe(true)
    const phases = fallbacks.map(f => f.phase)
    expect(phases).toContain('fill')
    expect(phases).toContain('submit')
    expect(fallbacks.find(f => f.phase === 'fill')).toMatchObject({
      attempted: true, used: true, reason: 'batched-threw',
    })
    expect(fallbacks.find(f => f.phase === 'submit')).toMatchObject({
      attempted: true, used: true, reason: 'relaxed-visibility',
    })
    expect(payload.fill).toMatchObject({ execution: 'sequential' })
  })
})

describe('fill transparent fallback', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetMockActionBehaviors()
    resetMockSessionCaches()
  })

  it('geometra_run_actions aggregates step-level fill fallback metadata into top-level fallbacks', async () => {
    const handler = getToolHandler('geometra_run_actions')
    mockState.currentA11yRoot = node('group', undefined, {
      meta: { pageUrl: 'https://jobs.example.com/application', scrollX: 0, scrollY: 0 },
      children: [
        node('textbox', 'Full name', { value: '', path: [0] }),
      ],
    })
    // Force the batched path to reject with a recoverable error so the
    // fill_fields step falls through to the sequential loop and tags the step.
    mockState.sendFillFields.mockRejectedValue(new Error('Unsupported client message type "fillFields"'))

    // includeSteps:false makes the fill_fields step handler prefer the batched
    // fast-path. When that path is unavailable, the step flips to sequential
    // and emits fallback metadata that run_actions lifts into the top-level
    // `fallbacks` array.
    const result = await handler({
      actions: [
        {
          type: 'fill_fields',
          fields: [{ kind: 'text', fieldLabel: 'Full name', value: 'Taylor Applicant' }],
        },
      ],
      stopOnError: true,
      includeSteps: false,
      detail: 'minimal',
    })
    const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>
    expect(payload).toMatchObject({
      completed: true,
      stepCount: 1,
      successCount: 1,
      fallbacks: [
        { stepIndex: 0, type: 'fill_fields', attempted: true, used: true, reason: 'batched-unavailable', attempts: 2 },
      ],
    })
  })

  it('geometra_fill_fields surfaces fallback metadata when the batched path is unavailable', async () => {
    const handler = getToolHandler('geometra_fill_fields')
    mockState.currentA11yRoot = node('group', undefined, {
      meta: { pageUrl: 'https://jobs.example.com/application', scrollX: 0, scrollY: 0 },
      children: [
        node('textbox', 'Full name', { value: '', path: [0] }),
      ],
    })
    // Force the batched path to throw a recoverable error so the handler
    // falls through to the sequential loop and tags the fallback.
    mockState.sendFillFields.mockRejectedValueOnce(new Error('Unsupported client message type "fillFields"'))

    const result = await handler({
      fields: [{ kind: 'text', fieldLabel: 'Full name', value: 'Taylor Applicant' }],
      stopOnError: true,
      failOnInvalid: false,
      includeSteps: false,
      detail: 'minimal',
    })

    const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>
    expect(payload).toMatchObject({
      completed: true,
      fieldCount: 1,
      successCount: 1,
      errorCount: 0,
      fallback: { attempted: true, used: true, reason: 'batched-unavailable', attempts: 2 },
    })
  })

  it('geometra_fill_form surfaces fallback metadata when batched throws recoverable error', async () => {
    const handler = getToolHandler('geometra_fill_form')
    mockState.currentA11yRoot = node('group', undefined, {
      meta: { pageUrl: 'https://jobs.example.com/application', scrollX: 0, scrollY: 0 },
      children: [
        node('textbox', 'Full name', { value: '', path: [0] }),
      ],
    })
    mockState.formSchemas = [{
      formId: 'fm:0',
      name: 'Application',
      fieldCount: 1,
      requiredCount: 1,
      invalidCount: 1,
      fields: [
        { id: 'ff:0.0', kind: 'text', label: 'Full name' },
      ],
    }]
    // Reject the schema-backed batch so the handler lands in the sequential loop.
    mockState.sendFillFields.mockRejectedValue(new Error('Unsupported client message type "fillFields"'))

    const result = await handler({
      valuesByLabel: { 'Full name': 'Taylor Applicant' },
      includeSteps: false,
      detail: 'minimal',
    })

    const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>
    expect(payload).toMatchObject({
      execution: 'sequential',
      fallback: { attempted: true, used: true, reason: 'batched-threw', attempts: 2 },
    })
  })
})

describe('click transparent fallback', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetMockActionBehaviors()
    resetMockSessionCaches()
  })

  it('surfaces fallback.attempted:false when click fallback attempted and failed', async () => {
    const handler = getToolHandler('geometra_click')
    mockState.currentA11yRoot = node('group', undefined, {
      bounds: { x: 0, y: 0, width: 1280, height: 800 },
      meta: { pageUrl: 'https://jobs.example.com/application', scrollX: 0, scrollY: 0 },
      children: [],
    })

    const result = await handler({
      role: 'button',
      name: 'Does not exist',
      fullyVisible: true,
      maxRevealSteps: 1,
      revealTimeoutMs: 50,
      detail: 'terse',
    })

    // Fallback was attempted (both revision-retry — if mockWaitForUiCondition
    // returns true — and relaxed-visibility) but neither phase recovered the
    // missing target, so the handler returns a structured error carrying the
    // attempted-but-failed telemetry.
    const errorText = result.content[0]!.text
    expect(errorText).toContain('"fallback"')
    const parsed = JSON.parse(errorText) as { error: string; fallback: Record<string, unknown> }
    expect(parsed.fallback).toMatchObject({ attempted: true, used: false })
    expect((parsed.fallback.reasonsTried as string[]).length).toBeGreaterThan(0)
  })

  it('surfaces fallback.used when relaxed-visibility lets an offscreen submit resolve', async () => {
    const handler = getToolHandler('geometra_click')

    // First tree: target exists but is offscreen below the viewport, so a
    // fullyVisible requirement cannot be satisfied before the reveal budget runs out.
    // The relaxed-visibility fallback drops the fullyVisible requirement and tries
    // once more with a larger reveal budget.
    const offscreenTree = node('group', undefined, {
      bounds: { x: 0, y: 0, width: 1280, height: 800 },
      meta: { pageUrl: 'https://jobs.example.com/application', scrollX: 0, scrollY: 0 },
      children: [
        node('button', 'Submit', {
          // Starts fully offscreen-below and wheel stubs don't move it in tests,
          // so the fullyVisible attempt will fail. Relaxed-visibility sees it
          // intersect enough to count as revealed.
          bounds: { x: 60, y: 780, width: 180, height: 60 },
          path: [0],
        }),
      ],
    })
    mockState.currentA11yRoot = offscreenTree
    mockState.sendClick.mockResolvedValueOnce({ status: 'updated', timeoutMs: 2000 })

    const result = await handler({
      role: 'button',
      name: 'Submit',
      fullyVisible: true,
      maxRevealSteps: 1,
      revealTimeoutMs: 100,
      detail: 'terse',
    })

    const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>
    expect(payload).toMatchObject({
      target: { role: 'button', name: 'Submit' },
      fallback: { attempted: true, used: true, reason: 'relaxed-visibility' },
    })
  })
})

describe('query and reveal tools', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetMockActionBehaviors()
    resetMockSessionCaches()
  })

  it('lets query disambiguate repeated controls by context text', async () => {
    const handler = getToolHandler('geometra_query')

    mockState.currentA11yRoot = node('group', undefined, {
      meta: { pageUrl: 'https://jobs.example.com/application', scrollX: 0, scrollY: 900 },
      children: [
        node('form', 'Application', {
          path: [0],
          children: [
            node('group', undefined, {
              path: [0, 0],
              children: [
                node('text', 'Are you legally authorized to work here?', { path: [0, 0, 0] }),
                node('button', 'Yes', { path: [0, 0, 1] }),
                node('button', 'No', { path: [0, 0, 2] }),
              ],
            }),
            node('group', undefined, {
              path: [0, 1],
              children: [
                node('text', 'Will you require sponsorship?', { path: [0, 1, 0] }),
                node('button', 'Yes', { path: [0, 1, 1] }),
                node('button', 'No', { path: [0, 1, 2] }),
              ],
            }),
          ],
        }),
      ],
    })
    mockState.nodeContexts.set('0.0.1', {
      prompt: 'Are you legally authorized to work here?',
      section: 'Application',
    })
    mockState.nodeContexts.set('0.1.1', {
      prompt: 'Will you require sponsorship?',
      section: 'Application',
    })

    const result = await handler({
      role: 'button',
      name: 'Yes',
      contextText: 'sponsorship',
    })

    const payload = JSON.parse(result.content[0]!.text) as Array<Record<string, unknown>>
    expect(payload).toHaveLength(1)
    expect(payload[0]).toMatchObject({
      role: 'button',
      name: 'Yes',
      context: {
        prompt: 'Will you require sponsorship?',
        section: 'Application',
      },
    })
  })

  it('falls back to sequential fill when a batched fill ends without a clean ack and invalid fields remain', async () => {
    const handler = getToolHandler('geometra_fill_form')
    mockState.sendFillFields.mockResolvedValueOnce({
      status: 'updated',
      timeoutMs: 6000,
      result: undefined,
    })
    mockState.formSchemas = [
      {
        formId: 'fm:0',
        name: 'Application',
        fieldCount: 2,
        requiredCount: 2,
        invalidCount: 2,
        fields: [
          { id: 'ff:0.0', kind: 'text', label: 'Full name', required: true, invalid: true },
          { id: 'ff:0.1', kind: 'choice', label: 'Preferred location', required: true, invalid: true, choiceType: 'select' },
        ],
      },
    ]
    mockState.currentA11yRoot = node('group', undefined, {
      meta: { pageUrl: 'https://jobs.example.com/application', scrollX: 0, scrollY: 640 },
      children: [
        node('form', 'Application', {
          path: [0],
          children: [
            node('textbox', 'Full name', {
              path: [0, 0],
              state: { required: true, invalid: true },
            }),
            node('combobox', 'Preferred location', {
              path: [0, 1],
              value: 'Select',
              state: { required: true, invalid: true },
            }),
          ],
        }),
      ],
    })

    const result = await handler({
      valuesById: {
        'ff:0.0': 'Taylor Applicant',
        'ff:0.1': 'Berlin, Germany',
      },
      includeSteps: false,
      detail: 'minimal',
      failOnInvalid: false,
    })

    const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>

    expect(mockState.sendFillFields).toHaveBeenCalledTimes(1)
    expect(mockState.sendFieldText).toHaveBeenCalledWith(
      mockState.session,
      'Full name',
      'Taylor Applicant',
      { exact: undefined, fieldId: 'ff:0.0' },
      undefined,
    )
    expect(mockState.sendFieldChoice).toHaveBeenCalledWith(
      mockState.session,
      'Preferred location',
      'Berlin, Germany',
      { exact: undefined, query: undefined, choiceType: 'select', fieldId: 'ff:0.1' },
      undefined,
    )
    expect(payload).toMatchObject({
      completed: true,
      execution: 'sequential',
      formId: 'fm:0',
      requestedValueCount: 2,
      fieldCount: 2,
      successCount: 2,
      errorCount: 0,
    })
  })

  it('reveals an offscreen target with semantic scrolling instead of requiring manual wheels', async () => {
    const handler = getToolHandler('geometra_scroll_to')

    mockState.currentA11yRoot = node('group', undefined, {
      bounds: { x: 0, y: 0, width: 1280, height: 800 },
      meta: { pageUrl: 'https://jobs.example.com/application', scrollX: 0, scrollY: 0 },
      children: [
        node('form', 'Application', {
          bounds: { x: 20, y: -200, width: 760, height: 1900 },
          path: [0],
          children: [
            node('button', 'Submit application', {
              bounds: { x: 60, y: 1540, width: 180, height: 40 },
              path: [0, 0],
            }),
          ],
        }),
      ],
    })

    mockState.sendWheel.mockImplementationOnce(async () => {
      mockState.currentA11yRoot = node('group', undefined, {
        bounds: { x: 0, y: 0, width: 1280, height: 800 },
        meta: { pageUrl: 'https://jobs.example.com/application', scrollX: 0, scrollY: 1220 },
        children: [
          node('form', 'Application', {
            bounds: { x: 20, y: -1420, width: 760, height: 1900 },
            path: [0],
            children: [
              node('button', 'Submit application', {
                bounds: { x: 60, y: 320, width: 180, height: 40 },
                path: [0, 0],
              }),
            ],
          }),
        ],
      })
      bumpMockUiRevision()
      return { status: 'updated' as const, timeoutMs: 2500 }
    })

    const result = await handler({
      role: 'button',
      name: 'Submit application',
      maxSteps: 3,
      fullyVisible: true,
      timeoutMs: 2500,
    })

    const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>
    expect(mockState.sendWheel).toHaveBeenCalledWith(
      mockState.session,
      expect.any(Number),
      expect.objectContaining({ x: expect.any(Number), y: expect.any(Number) }),
      2500,
    )
    expect(payload).toMatchObject({
      revealed: true,
      attempts: 1,
      target: {
        role: 'button',
        name: 'Submit application',
        visibility: { fullyVisible: true },
      },
    })
  })

  it('auto-scales reveal steps for tall forms when maxSteps is omitted', async () => {
    const handler = getToolHandler('geometra_scroll_to')
    let scrollY = 0

    const setTree = () => {
      mockState.currentA11yRoot = node('group', undefined, {
        bounds: { x: 0, y: 0, width: 1280, height: 800 },
        meta: { pageUrl: 'https://jobs.example.com/application', scrollX: 0, scrollY },
        children: [
          node('form', 'Application', {
            bounds: { x: 20, y: -200 - scrollY, width: 760, height: 6200 },
            path: [0],
            children: [
              node('button', 'Submit application', {
                bounds: { x: 60, y: 5200 - scrollY, width: 180, height: 40 },
                path: [0, 0],
              }),
            ],
          }),
        ],
      })
    }

    setTree()
    mockState.sendWheel.mockImplementation(async () => {
      scrollY += 650
      setTree()
      bumpMockUiRevision()
      return { status: 'updated' as const, timeoutMs: 2500 }
    })

    const result = await handler({
      role: 'button',
      name: 'Submit application',
      fullyVisible: true,
      timeoutMs: 2500,
    })

    const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>
    expect(mockState.sendWheel).toHaveBeenCalledTimes(7)
    expect(payload).toMatchObject({
      revealed: true,
      attempts: 7,
      target: {
        role: 'button',
        name: 'Submit application',
        visibility: { fullyVisible: true },
      },
    })
  })

  it('clicks an offscreen semantic target by revealing it first', async () => {
    const handler = getToolHandler('geometra_click')

    mockState.currentA11yRoot = node('group', undefined, {
      bounds: { x: 0, y: 0, width: 1280, height: 800 },
      meta: { pageUrl: 'https://jobs.example.com/application', scrollX: 0, scrollY: 0 },
      children: [
        node('form', 'Application', {
          bounds: { x: 20, y: -200, width: 760, height: 1900 },
          path: [0],
          children: [
            node('button', 'Submit application', {
              bounds: { x: 60, y: 1540, width: 180, height: 40 },
              path: [0, 0],
            }),
          ],
        }),
      ],
    })

    mockState.sendWheel.mockImplementationOnce(async () => {
      mockState.currentA11yRoot = node('group', undefined, {
        bounds: { x: 0, y: 0, width: 1280, height: 800 },
        meta: { pageUrl: 'https://jobs.example.com/application', scrollX: 0, scrollY: 1220 },
        children: [
          node('form', 'Application', {
            bounds: { x: 20, y: -1420, width: 760, height: 1900 },
            path: [0],
            children: [
              node('button', 'Submit application', {
                bounds: { x: 60, y: 320, width: 180, height: 40 },
                path: [0, 0],
              }),
            ],
          }),
        ],
      })
      bumpMockUiRevision()
      return { status: 'updated' as const, timeoutMs: 2500 }
    })

    const result = await handler({
      id: 'n:0.0',
      maxRevealSteps: 3,
      revealTimeoutMs: 2500,
      detail: 'minimal',
    })

    expect(mockState.sendWheel).toHaveBeenCalledTimes(1)
    expect(mockState.sendClick).toHaveBeenCalledWith(mockState.session, 150, 340, undefined)
    expect(result.content[0]!.text).toContain('Clicked button "Submit application" (n:0.0) at (150, 340) after 1 reveal step.')
  })

  it('can wait for a semantic post-click condition in the same click call', async () => {
    const handler = getToolHandler('geometra_click')

    mockState.currentA11yRoot = node('group', undefined, {
      bounds: { x: 0, y: 0, width: 1280, height: 800 },
      meta: { pageUrl: 'https://jobs.example.com/application', scrollX: 0, scrollY: 0 },
      children: [
        node('button', 'Submit application', {
          bounds: { x: 60, y: 320, width: 180, height: 40 },
          path: [0],
        }),
      ],
    })

    mockState.sendClick.mockImplementationOnce(async () => {
      mockState.currentA11yRoot = node('group', undefined, {
        bounds: { x: 0, y: 0, width: 1280, height: 800 },
        meta: { pageUrl: 'https://jobs.example.com/application', scrollX: 0, scrollY: 0 },
        children: [
          node('button', 'Submit application', {
            bounds: { x: 60, y: 320, width: 180, height: 40 },
            path: [0],
          }),
          node('dialog', 'Application submitted', {
            bounds: { x: 240, y: 140, width: 420, height: 260 },
            path: [1],
          }),
        ],
      })
      bumpMockUiRevision()
      return { status: 'updated' as const, timeoutMs: 2000 }
    })

    const result = await handler({
      role: 'button',
      name: 'Submit application',
      waitFor: {
        role: 'dialog',
        name: 'Application submitted',
        timeoutMs: 5000,
      },
      detail: 'minimal',
    })

    expect(mockState.waitForUiCondition).toHaveBeenCalledWith(mockState.session, expect.any(Function), 5000)
    expect(result.content[0]!.text).toContain('Post-click condition satisfied after')
    expect(result.content[0]!.text).toContain('1 matching node(s).')
  })

  it('waits for the initial tree before a semantic click after deferred connect', async () => {
    const handler = getToolHandler('geometra_click')
    mockState.session.tree = null as unknown as typeof mockState.session.tree
    mockState.session.layout = null as unknown as typeof mockState.session.layout
    mockState.currentA11yRoot = node('group', undefined, {
      bounds: { x: 0, y: 0, width: 1280, height: 800 },
      meta: { pageUrl: 'https://jobs.example.com/application', scrollX: 0, scrollY: 0 },
      children: [
        node('button', 'Open incident', {
          bounds: { x: 40, y: 120, width: 140, height: 40 },
          path: [0],
        }),
      ],
    })
    mockState.waitForUiCondition.mockImplementationOnce(async (_session, check) => {
      mockState.session.tree = { kind: 'box' } as unknown as typeof mockState.session.tree
      mockState.session.layout = {
        x: 0,
        y: 0,
        width: 1280,
        height: 800,
        children: [],
      } as unknown as typeof mockState.session.layout
      bumpMockUiRevision()
      return check()
    })

    const result = await handler({
      role: 'button',
      name: 'Open incident',
      detail: 'minimal',
    })

    expect(mockState.waitForUiCondition).toHaveBeenCalledWith(mockState.session, expect.any(Function), 4000)
    expect(mockState.sendClick).toHaveBeenCalledWith(mockState.session, 110, 140, undefined)
    expect(result.content[0]!.text).toContain('Clicked button "Open incident" (n:0) at (110, 140).')
  })

  it('lets run_actions click a semantic target without manual coordinates', async () => {
    const handler = getToolHandler('geometra_run_actions')

    mockState.currentA11yRoot = node('group', undefined, {
      bounds: { x: 0, y: 0, width: 1280, height: 800 },
      meta: { pageUrl: 'https://jobs.example.com/application', scrollX: 0, scrollY: 0 },
      children: [
        node('form', 'Application', {
          bounds: { x: 20, y: -200, width: 760, height: 1900 },
          path: [0],
          children: [
            node('button', 'Submit application', {
              bounds: { x: 60, y: 1540, width: 180, height: 40 },
              path: [0, 0],
            }),
          ],
        }),
      ],
    })

    mockState.sendWheel.mockImplementationOnce(async () => {
      mockState.currentA11yRoot = node('group', undefined, {
        bounds: { x: 0, y: 0, width: 1280, height: 800 },
        meta: { pageUrl: 'https://jobs.example.com/application', scrollX: 0, scrollY: 1220 },
        children: [
          node('form', 'Application', {
            bounds: { x: 20, y: -1420, width: 760, height: 1900 },
            path: [0],
            children: [
              node('button', 'Submit application', {
                bounds: { x: 60, y: 320, width: 180, height: 40 },
                path: [0, 0],
              }),
            ],
          }),
        ],
      })
      bumpMockUiRevision()
      return { status: 'updated' as const, timeoutMs: 2500 }
    })

    const result = await handler({
      actions: [
        {
          type: 'click',
          role: 'button',
          name: 'Submit application',
          maxRevealSteps: 3,
          revealTimeoutMs: 2500,
        },
      ],
      stopOnError: true,
      includeSteps: true,
      detail: 'minimal',
    })

    const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>
    const steps = payload.steps as Array<Record<string, unknown>>

    expect(mockState.sendWheel).toHaveBeenCalledTimes(1)
    expect(mockState.sendClick).toHaveBeenCalledWith(mockState.session, 150, 340, expect.any(Number))
    expect(steps[0]).toMatchObject({
      index: 0,
      type: 'click',
      ok: true,
      elapsedMs: expect.any(Number),
      at: { x: 150, y: 340 },
      revealSteps: 1,
      target: { id: 'n:0.0', role: 'button', name: 'Submit application' },
      wait: 'updated',
    })
  })

  it('lets run_actions click and wait for a semantic post-condition in one step', async () => {
    const handler = getToolHandler('geometra_run_actions')

    mockState.currentA11yRoot = node('group', undefined, {
      bounds: { x: 0, y: 0, width: 1280, height: 800 },
      meta: { pageUrl: 'https://jobs.example.com/application', scrollX: 0, scrollY: 0 },
      children: [
        node('button', 'Submit application', {
          bounds: { x: 60, y: 320, width: 180, height: 40 },
          path: [0],
        }),
      ],
    })

    mockState.sendClick.mockImplementationOnce(async () => {
      mockState.currentA11yRoot = node('group', undefined, {
        bounds: { x: 0, y: 0, width: 1280, height: 800 },
        meta: { pageUrl: 'https://jobs.example.com/application', scrollX: 0, scrollY: 0 },
        children: [
          node('button', 'Submit application', {
            bounds: { x: 60, y: 320, width: 180, height: 40 },
            path: [0],
          }),
          node('dialog', 'Application submitted', {
            bounds: { x: 240, y: 140, width: 420, height: 260 },
            path: [1],
          }),
        ],
      })
      bumpMockUiRevision()
      return { status: 'updated' as const, timeoutMs: 2000 }
    })

    const result = await handler({
      actions: [
        {
          type: 'click',
          role: 'button',
          name: 'Submit application',
          waitFor: {
            role: 'dialog',
            name: 'Application submitted',
            timeoutMs: 5000,
          },
        },
      ],
      stopOnError: true,
      includeSteps: true,
      detail: 'minimal',
    })

    const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>
    const steps = payload.steps as Array<Record<string, unknown>>

    expect(steps[0]).toMatchObject({
      index: 0,
      type: 'click',
      ok: true,
      elapsedMs: expect.any(Number),
      postWait: {
        present: true,
        matchCount: 1,
        fresh: true,
        filter: { role: 'dialog', name: 'Application submitted' },
      },
    })
  })

  it('does not let run_actions confirm a click from pre-existing wait evidence', async () => {
    const handler = getToolHandler('geometra_run_actions')

    mockState.currentA11yRoot = node('group', undefined, {
      bounds: { x: 0, y: 0, width: 1280, height: 800 },
      meta: { pageUrl: 'https://jobs.example.com/application', scrollX: 0, scrollY: 0 },
      children: [
        node('button', 'Submit application', {
          bounds: { x: 60, y: 320, width: 180, height: 40 },
          path: [0],
        }),
        node('dialog', 'Application submitted', {
          bounds: { x: 240, y: 140, width: 420, height: 260 },
          path: [1],
        }),
      ],
    })

    const result = await handler({
      actions: [{
        type: 'click',
        role: 'button',
        name: 'Submit application',
        waitFor: { role: 'dialog', name: 'Application submitted', timeoutMs: 5000 },
      }],
      stopOnError: true,
      includeSteps: true,
      detail: 'minimal',
    })

    const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>
    const steps = payload.steps as Array<Record<string, unknown>>
    expect(payload).toMatchObject({
      completed: false,
      successCount: 0,
      errorCount: 1,
      stoppedAt: 0,
    })
    expect(steps[0]).toMatchObject({ index: 0, type: 'click', ok: false })
    expect(String(steps[0]?.error)).toContain('matched only pre-existing evidence')
  })
})
