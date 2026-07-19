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
})
