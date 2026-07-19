import { realpathSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createWorkspaceSourceResolver } from '../../../../vitest.config.ts'
import { SOURCE_PRECEDENCE } from './fixtures/source-precedence.js'

const repoRoot = fileURLToPath(new URL('../../../..', import.meta.url))
const resolveId = createWorkspaceSourceResolver().resolveId

describe('workspace source resolver', () => {
  it('loads TypeScript when a stale JavaScript sibling exists', () => {
    expect(SOURCE_PRECEDENCE).toBe('typescript-source')
  })

  it('prefers the TypeScript sibling for NodeNext imports and preserves Vite query data', () => {
    const importer = path.join(repoRoot, 'packages/proxy/src/index.ts?import')
    const expected = `${realpathSync(path.join(repoRoot, 'packages/proxy/src/extractor.ts'))}?worker#fragment`

    expect(resolveId('./extractor.js?worker#fragment', importer)).toBe(expected)
  })

  it('covers MCP source imports as part of the root Vitest workspace', () => {
    const importer = path.join(repoRoot, 'mcp/src/server.ts')
    const expected = `${realpathSync(path.join(repoRoot, 'mcp/src/session.ts'))}#session`

    expect(resolveId('./session.js#session', importer)).toBe(expected)
  })

  it('does not resolve missing, non-relative, non-JavaScript, or out-of-scope targets', () => {
    const importer = path.join(repoRoot, 'packages/proxy/src/index.ts')

    expect(resolveId('./does-not-exist.js', importer)).toBeUndefined()
    expect(resolveId('@geometra/core', importer)).toBeUndefined()
    expect(resolveId('./extractor.ts', importer)).toBeUndefined()
    expect(resolveId('../../../vitest.config.js', importer)).toBeUndefined()
    expect(resolveId('./extractor.js', path.join(repoRoot, 'vitest.config.ts'))).toBeUndefined()
  })
})
