import { existsSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const repoRoot = fileURLToPath(new URL('.', import.meta.url))

function fromRoot(...segments: string[]) {
  return path.resolve(repoRoot, ...segments)
}

function splitViteId(id: string) {
  const queryIndex = id.indexOf('?')
  const hashIndex = id.indexOf('#')
  const suffixIndex = [queryIndex, hashIndex]
    .filter((index) => index >= 0)
    .reduce((first, index) => Math.min(first, index), id.length)

  return {
    pathname: id.slice(0, suffixIndex),
    suffix: id.slice(suffixIndex),
  }
}

function isWorkspaceSourcePath(candidate: string) {
  const relative = path.relative(repoRoot, candidate)
  if (relative === '' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return false

  const segments = relative.split(path.sep)
  return (
    (segments[0] === 'mcp' && segments[1] === 'src' && segments.length > 2) ||
    (segments[0] === 'packages' && Boolean(segments[1]) && segments[2] === 'src' && segments.length > 3)
  )
}

/**
 * TypeScript's NodeNext convention keeps `.js` in source import specifiers. Vite normally
 * falls back to the sibling `.ts`, but an ignored compiler artifact can win resolution.
 * Resolve that one source-only case before Vite checks the filesystem.
 */
export function createWorkspaceSourceResolver() {
  return {
    name: 'geometra-workspace-source-js-to-ts',
    enforce: 'pre' as const,
    resolveId(id: string, importer?: string) {
      if (!importer || !/^\.\.?\//.test(id)) return undefined

      const source = splitViteId(id)
      if (!source.pathname.endsWith('.js')) return undefined

      const importerPath = splitViteId(importer).pathname
      if (!isWorkspaceSourcePath(importerPath)) return undefined

      const typescriptPath = path.resolve(path.dirname(importerPath), `${source.pathname.slice(0, -3)}.ts`)
      if (!isWorkspaceSourcePath(typescriptPath) || !existsSync(typescriptPath)) return undefined

      // Do not let an in-tree symlink turn this narrowly scoped resolver into an escape hatch.
      const realTypescriptPath = realpathSync(typescriptPath)
      if (!isWorkspaceSourcePath(realTypescriptPath)) return undefined

      return `${realTypescriptPath}${source.suffix}`
    },
  }
}

// Exact-match aliases keep workspace package imports on source files without requiring dist builds.
const workspaceAliases = [
  { find: /^textura$/, replacement: fromRoot('packages/textura/src/index.ts') },
  { find: /^@geometra\/core$/, replacement: fromRoot('packages/core/src/index.ts') },
  { find: /^@geometra\/core\/node$/, replacement: fromRoot('packages/core/src/node.ts') },
  { find: /^@geometra\/renderer-canvas$/, replacement: fromRoot('packages/renderer-canvas/src/index.ts') },
  { find: /^@geometra\/renderer-terminal$/, replacement: fromRoot('packages/renderer-terminal/src/index.ts') },
  { find: /^@geometra\/renderer-webgpu$/, replacement: fromRoot('packages/renderer-webgpu/src/index.ts') },
  { find: /^@geometra\/server$/, replacement: fromRoot('packages/server/src/index.ts') },
  { find: /^@geometra\/client$/, replacement: fromRoot('packages/client/src/index.ts') },
  { find: /^@geometra\/router$/, replacement: fromRoot('packages/router/src/index.ts') },
  { find: /^@geometra\/ui$/, replacement: fromRoot('packages/ui/src/index.ts') },
  { find: /^@geometra\/gateway$/, replacement: fromRoot('packages/gateway/src/index.ts') },
  { find: /^@geometra\/evidence$/, replacement: fromRoot('packages/evidence/src/index.ts') },
]

export default defineConfig({
  plugins: [createWorkspaceSourceResolver()],
  resolve: {
    alias: workspaceAliases,
  },
  test: {
    pool: 'threads',
    // Cap parallel workers so large `vitest run` batches (e.g. `npm run release:gate`) do not exhaust
    // thread pool / memory on laptops and shared CI runners — avoids spurious per-test timeouts when
    // workers fail to start ("Timeout waiting for worker to respond").
    maxWorkers: 8,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    setupFiles: [fromRoot('vitest.setup.ts')],
    exclude: [
      // Vitest's default exclude list (kept explicit so it composes with our additions).
      '**/node_modules/**',
      '**/dist/**',
      '**/cypress/**',
      '**/.{idea,git,cache,output,temp}/**',
      '**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build,eslint,prettier}.config.*',
      // Playwright specs under tests/e2e live in their own runner — vitest's
      // default glob (**/*.spec.ts) otherwise picks them up and throws on the
      // @playwright/test import, which has bitten every fresh-checkout `vitest run`.
      'tests/e2e/**',
    ],
  },
})
