import { describe, expect, it } from 'vitest'
import {
  assertInternalRuntimeDependencies,
  assertMcpProxyDependency,
  assertPublishablePackageCoverage,
  assertWorkspaceManifestLocks,
  assertWorkspaceLockGraph,
  parseBunLock,
} from './check-source.mjs'

const VERSION = '1.64.0'

function validGraph() {
  return {
    rootPackage: { workspaces: ['packages/*', 'mcp'] },
    npmLock: {
      packages: {
        '': { workspaces: ['packages/*', 'mcp'] },
        mcp: {
          name: '@geometra/mcp',
          version: VERSION,
          dependencies: { '@geometra/proxy': `^${VERSION}` },
        },
        'packages/proxy': { name: '@geometra/proxy', version: VERSION },
        'node_modules/@geometra/mcp': { link: true, resolved: 'mcp' },
        'node_modules/@geometra/proxy': { link: true, resolved: 'packages/proxy' },
      },
    },
    bunLock: {
      workspaces: {
        mcp: {
          name: '@geometra/mcp',
          version: VERSION,
          dependencies: { '@geometra/proxy': `^${VERSION}` },
        },
        'packages/proxy': { name: '@geometra/proxy', version: VERSION },
      },
      packages: {
        '@geometra/mcp': ['@geometra/mcp@workspace:mcp'],
        '@geometra/proxy': ['@geometra/proxy@workspace:packages/proxy'],
      },
    },
  }
}

describe('release source workspace guards', () => {
  it('parses Bun JSONC trailing commas without altering string contents', () => {
    expect(parseBunLock('{"value":"literal,}","items":["one",],}')).toEqual({
      value: 'literal,}',
      items: ['one'],
    })
  })

  it('accepts root lockfiles that resolve MCP and proxy to their workspaces', () => {
    expect(() => assertWorkspaceLockGraph({ ...validGraph(), version: VERSION })).not.toThrow()
  })

  it('rejects a nested registry proxy that can shadow the current workspace', () => {
    const graph = validGraph()
    Object.assign(graph.npmLock.packages, {
      'mcp/node_modules/@geometra/proxy': {
        resolved: 'https://registry.npmjs.org/@geometra/proxy/-/proxy-1.57.0.tgz',
      },
    })

    expect(() => assertWorkspaceLockGraph({ ...graph, version: VERSION })).toThrow(/nested registry copy/)
  })

  it('rejects stale workspace versions and proxy ranges', () => {
    const graph = validGraph()
    graph.npmLock.packages.mcp.dependencies['@geometra/proxy'] = '^1.63.0'

    expect(() => assertWorkspaceLockGraph({ ...graph, version: VERSION })).toThrow(/must depend/)
  })

  it('rejects a nested Bun proxy resolution', () => {
    const graph = validGraph()
    graph.bunLock.packages['@geometra/mcp/@geometra/proxy'] = ['@geometra/proxy@1.57.0', '', {}, '']

    expect(() => assertWorkspaceLockGraph({ ...graph, version: VERSION })).toThrow(/nested registry copy/)
  })

  it('rejects a nested MCP Zod identity that makes SDK type checking explode', () => {
    const graph = validGraph()
    graph.npmLock.packages['mcp/node_modules/zod'] = { version: '3.25.76' }

    expect(() => assertWorkspaceLockGraph({ ...graph, version: VERSION })).toThrow(/one Zod type identity/)
  })

  it('requires the source MCP manifest to target this release of proxy', () => {
    expect(() =>
      assertMcpProxyDependency({ dependencies: { '@geometra/proxy': `^${VERSION}` } }, VERSION),
    ).not.toThrow()
    expect(() => assertMcpProxyDependency({ dependencies: { '@geometra/proxy': '^1.63.0' } }, VERSION)).toThrow(
      /must be/,
    )
  })

  it('requires every internal runtime dependency to target the current release', () => {
    const packageNames = new Set(['@geometra/client', '@geometra/core', '@geometra/renderer-canvas'])
    const current = {
      name: '@geometra/renderer-canvas',
      dependencies: { '@geometra/client': `^${VERSION}`, '@geometra/core': `^${VERSION}` },
    }

    expect(() => assertInternalRuntimeDependencies(current, VERSION, packageNames)).not.toThrow()
    expect(() =>
      assertInternalRuntimeDependencies(
        { ...current, dependencies: { ...current.dependencies, '@geometra/client': '^1.6.0' } },
        VERSION,
        packageNames,
      ),
    ).toThrow(/@geometra\/client.*must be/)
  })

  it('requires every non-private package workspace to appear in the release manifest exactly once', () => {
    const discovered = [
      { name: '@geometra/core', path: 'packages/core' },
      { name: '@geometra/demo', path: 'packages/demo', private: true },
    ]
    const listed = [{ name: '@geometra/core', path: 'packages/core' }]

    expect(() => assertPublishablePackageCoverage(discovered, listed)).not.toThrow()
    expect(() =>
      assertPublishablePackageCoverage([...discovered, { name: '@geometra/new', path: 'packages/new' }], listed),
    ).toThrow(/missing from the release manifest/)
    expect(() => assertPublishablePackageCoverage(discovered, [...listed, ...listed])).toThrow(/more than once/)
  })

  it('requires both lockfiles to mirror every published runtime dependency', () => {
    const pkg = {
      name: '@geometra/renderer-canvas',
      version: VERSION,
      dependencies: { '@geometra/client': `^${VERSION}` },
    }
    const locks = {
      pkg,
      workspacePath: 'packages/renderer-canvas',
      npmLock: { packages: { 'packages/renderer-canvas': { ...pkg } } },
      bunLock: { workspaces: { 'packages/renderer-canvas': { ...pkg } } },
    }

    expect(() => assertWorkspaceManifestLocks(locks)).not.toThrow()
    expect(() =>
      assertWorkspaceManifestLocks({
        ...locks,
        bunLock: {
          workspaces: {
            'packages/renderer-canvas': { ...pkg, dependencies: { '@geometra/client': '^1.6.0' } },
          },
        },
      }),
    ).toThrow(/bun\.lock.*@geometra\/client must be/)
  })
})
