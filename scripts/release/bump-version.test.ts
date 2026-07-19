import { describe, expect, it } from 'vitest'
import { rewritePackageManifest } from './bump-version.mjs'

describe('release version bump', () => {
  it('updates the package version and committed internal dependency ranges together', () => {
    const source = `${JSON.stringify(
      {
        name: '@geometra/mcp',
        version: '1.64.0',
        dependencies: { '@geometra/proxy': '^1.64.0', zod: '^3.23.0' },
      },
      null,
      2,
    )}\n`

    const next = rewritePackageManifest(source, '@geometra/mcp', '1.64.0', '2.0.0', {
      '@geometra/proxy': '^2.0.0',
    })

    expect(JSON.parse(next)).toEqual({
      name: '@geometra/mcp',
      version: '2.0.0',
      dependencies: { '@geometra/proxy': '^2.0.0', zod: '^3.23.0' },
    })
  })

  it('fails closed when the expected internal dependency is missing', () => {
    const source = '{"name":"@geometra/mcp","version":"1.64.0","dependencies":{}}'

    expect(() =>
      rewritePackageManifest(source, '@geometra/mcp', '1.64.0', '2.0.0', {
        '@geometra/proxy': '^2.0.0',
      }),
    ).toThrow(/missing dependencies/)
  })
})
