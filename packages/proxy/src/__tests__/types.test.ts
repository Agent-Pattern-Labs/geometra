import { describe, expect, it } from 'vitest'
import { clientMessageValidationError, type ParsedClientMessage } from '../types.ts'

function validationError(payload: unknown): string | null {
  return clientMessageValidationError(payload as ParsedClientMessage)
}

describe('proxy client action validation', () => {
  it('accepts a fully disambiguated setChecked action', () => {
    expect(validationError({
      type: 'setChecked',
      requestId: 'request-1',
      label: 'Yes',
      fieldKey: `id:${encodeURIComponent('question:consent')}`,
      checked: false,
      contextText: 'Marketing consent',
      sectionText: 'Preferences',
    })).toBeNull()
  })

  it.each([
    { type: 'setChecked' },
    { type: 'setChecked', label: '' },
    { type: 'setChecked', label: ' Consent ' },
    { type: 'setChecked', label: 'Consent', checkd: false },
  ])('rejects malformed setChecked payload %#', payload => {
    expect(validationError(payload)).toMatch(/^Invalid setChecked message:/)
  })

  it('rejects unknown fields inside fillFields entries instead of applying defaults', () => {
    expect(validationError({
      type: 'fillFields',
      requestId: 'request-2',
      fields: [{ kind: 'toggle', label: 'Consent', checkd: false }],
    })).toBe('Invalid fillFields message: fields[0] has unknown field(s): checkd')
  })

  it('rejects unknown top-level fillFields fields', () => {
    expect(validationError({
      type: 'fillFields',
      fields: [{ kind: 'text', fieldLabel: 'Name', value: 'Ada' }],
      stopOnError: false,
    })).toBe('Invalid fillFields message: unknown field(s): stopOnError')
  })

  it('validates exact native option indices on single and batched choice actions', () => {
    expect(validationError({
      type: 'setFieldChoice',
      fieldLabel: 'Office',
      value: 'nyc-alt',
      optionIndex: 2,
    })).toBeNull()
    expect(validationError({
      type: 'fillFields',
      fields: [{ kind: 'choice', fieldLabel: 'Office', value: 'nyc-alt', optionIndex: 2 }],
    })).toBeNull()
    expect(validationError({
      type: 'setFieldChoice',
      fieldLabel: 'Office',
      value: 'nyc-alt',
      optionIndex: -1,
    })).toBe('Invalid client message "setFieldChoice": payload does not match the proxy protocol')
  })

  it('preserves scoped file targeting on standalone and batched actions', () => {
    expect(validationError({
      type: 'file',
      paths: ['/tmp/resume.pdf'],
      fieldLabel: 'Document',
      contextText: 'Candidate resume',
      sectionText: 'Application materials',
    })).toBeNull()
    expect(validationError({
      type: 'fillFields',
      fields: [{
        kind: 'file',
        fieldLabel: 'Document',
        paths: ['/tmp/cover.pdf'],
        contextText: 'Cover letter',
        sectionText: 'Application materials',
      }],
    })).toBeNull()

    expect(validationError({
      type: 'file',
      paths: ['/tmp/resume.pdf'],
      contextText: '   ',
    })).toMatch(/^Invalid client message "file":/)
    expect(validationError({
      type: 'fillFields',
      fields: [{ kind: 'file', fieldLabel: 'Document', paths: ['/tmp/resume.pdf'], sectionText: '' }],
    })).toMatch(/^Invalid client message "fillFields":/)
  })

  it('requires an explicit, non-conflicting file target', () => {
    expect(validationError({ type: 'file', paths: ['/tmp/resume.pdf'] })).toMatch(/^Invalid client message "file":/)
    expect(validationError({
      type: 'file',
      paths: ['/tmp/resume.pdf'],
      contextText: 'Candidate resume',
    })).toMatch(/^Invalid client message "file":/)
    expect(validationError({
      type: 'file',
      paths: ['/tmp/resume.pdf'],
      strategy: 'chooser',
      x: 10,
      y: 20,
      fieldLabel: 'Resume',
    })).toMatch(/^Invalid client message "file":/)
    expect(validationError({
      type: 'file',
      paths: ['/tmp/resume.pdf'],
      strategy: 'hidden',
      fieldKey: 'id:resume-input',
    })).toBeNull()
  })

  it('requires one explicit listbox target and rejects ignored coordinates', () => {
    expect(validationError({ type: 'listboxPick', label: 'Berlin' })).toMatch(/^Invalid client message "listboxPick":/)
    expect(validationError({ type: 'listboxPick', label: 'Berlin', fieldId: 'office' })).toMatch(/^Invalid client message "listboxPick":/)
    expect(validationError({
      type: 'listboxPick',
      label: 'Berlin',
      fieldLabel: 'Office',
      openX: 10,
      openY: 20,
    })).toMatch(/^Invalid client message "listboxPick":/)
    expect(validationError({ type: 'listboxPick', label: 'Berlin', fieldKey: 'id:office' })).toBeNull()
    expect(validationError({ type: 'listboxPick', label: 'Berlin', openX: 10, openY: 20 })).toBeNull()
    expect(validationError({ type: 'listboxPick', label: 'Berlin', openX: 10, openY: 20, query: 'Ber' })).toMatch(/^Invalid client message "listboxPick":/)
  })
})
