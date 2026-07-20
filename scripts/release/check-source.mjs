import { execFile } from 'node:child_process'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { publishablePackageJsons, publishablePackageNames, publishablePackages } from './package-manifest.mjs'

const execFileAsync = promisify(execFile)
const repoRoot = fileURLToPath(new URL('../../', import.meta.url))

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function readJson(relativePath) {
  return JSON.parse(await readFile(path.join(repoRoot, relativePath), 'utf8'))
}

function withoutTrailingJsonCommas(source) {
  let output = ''
  let inString = false
  let escaped = false

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]
    if (inString) {
      output += character
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') inString = false
      continue
    }

    if (character === '"') {
      inString = true
      output += character
      continue
    }

    if (character === ',') {
      let nextIndex = index + 1
      while (/\s/.test(source[nextIndex] ?? '')) nextIndex += 1
      if (source[nextIndex] === '}' || source[nextIndex] === ']') continue
    }

    output += character
  }

  return output
}

export function parseBunLock(source) {
  return JSON.parse(withoutTrailingJsonCommas(source))
}

function hasWorkspace(workspaces, workspace) {
  if (Array.isArray(workspaces)) return workspaces.includes(workspace)
  return Boolean(workspaces && typeof workspaces === 'object' && Object.hasOwn(workspaces, workspace))
}

function assertLink(lockPackages, packageName, workspacePath, lockName) {
  const entry = lockPackages?.[`node_modules/${packageName}`]
  assert(entry?.link === true, `${lockName}: ${packageName} must be recorded as a workspace link`)
  assert(
    entry?.resolved === workspacePath,
    `${lockName}: ${packageName} must resolve to ${workspacePath}, found ${entry?.resolved ?? 'missing'}`,
  )
}

export function assertWorkspaceLockGraph({ rootPackage, npmLock, bunLock, version }) {
  const proxyRange = `^${version}`
  assert(hasWorkspace(rootPackage.workspaces, 'mcp'), 'package.json: workspaces must include mcp')

  const npmPackages = npmLock?.packages
  assert(npmPackages && typeof npmPackages === 'object', 'package-lock.json: missing packages map')
  assert(hasWorkspace(npmPackages['']?.workspaces, 'mcp'), 'package-lock.json: root workspaces must include mcp')
  assert(npmPackages.mcp?.name === '@geometra/mcp', 'package-lock.json: missing mcp workspace package')
  assert(
    npmPackages.mcp?.version === version,
    `package-lock.json: mcp workspace version must be ${version}, found ${npmPackages.mcp?.version ?? 'missing'}`,
  )
  assert(
    npmPackages['packages/proxy']?.name === '@geometra/proxy',
    'package-lock.json: missing proxy workspace package',
  )
  assert(
    npmPackages['packages/proxy']?.version === version,
    `package-lock.json: proxy workspace version must be ${version}, found ${npmPackages['packages/proxy']?.version ?? 'missing'}`,
  )
  assert(
    npmPackages.mcp?.dependencies?.['@geometra/proxy'] === proxyRange,
    `package-lock.json: mcp workspace must depend on @geometra/proxy ${proxyRange}`,
  )
  assertLink(npmPackages, '@geometra/mcp', 'mcp', 'package-lock.json')
  assertLink(npmPackages, '@geometra/proxy', 'packages/proxy', 'package-lock.json')
  assert(
    !npmPackages['mcp/node_modules/@geometra/proxy'],
    'package-lock.json: mcp must not retain a nested registry copy of @geometra/proxy',
  )
  assert(
    !npmPackages['mcp/node_modules/zod'],
    'package-lock.json: mcp and the hoisted MCP SDK must share one Zod type identity',
  )

  const bunWorkspaces = bunLock?.workspaces
  assert(bunWorkspaces?.mcp?.name === '@geometra/mcp', 'bun.lock: missing mcp workspace package')
  assert(
    bunWorkspaces.mcp?.version === version,
    `bun.lock: mcp workspace version must be ${version}, found ${bunWorkspaces.mcp?.version ?? 'missing'}`,
  )
  assert(bunWorkspaces['packages/proxy']?.name === '@geometra/proxy', 'bun.lock: missing proxy workspace package')
  assert(
    bunWorkspaces['packages/proxy']?.version === version,
    `bun.lock: proxy workspace version must be ${version}, found ${bunWorkspaces['packages/proxy']?.version ?? 'missing'}`,
  )
  assert(
    bunWorkspaces.mcp?.dependencies?.['@geometra/proxy'] === proxyRange,
    `bun.lock: mcp workspace must depend on @geometra/proxy ${proxyRange}`,
  )
  assert(
    bunLock?.packages?.['@geometra/mcp']?.[0] === '@geometra/mcp@workspace:mcp',
    'bun.lock: @geometra/mcp must resolve to workspace:mcp',
  )
  assert(
    bunLock?.packages?.['@geometra/proxy']?.[0] === '@geometra/proxy@workspace:packages/proxy',
    'bun.lock: @geometra/proxy must resolve to workspace:packages/proxy',
  )
  assert(
    !Object.keys(bunLock?.packages ?? {}).some((key) => key !== '@geometra/proxy' && key.endsWith('/@geometra/proxy')),
    'bun.lock: mcp must not retain a nested registry copy of @geometra/proxy',
  )
  assert(!bunLock?.packages?.['@geometra/mcp/zod'], 'bun.lock: mcp and the MCP SDK must share one Zod type identity')
}

export function assertMcpProxyDependency(pkg, version) {
  const expected = `^${version}`
  assert(
    pkg?.dependencies?.['@geometra/proxy'] === expected,
    `mcp/package.json: @geometra/proxy must be ${expected}, found ${pkg?.dependencies?.['@geometra/proxy'] ?? 'missing'}`,
  )
}

export function assertInternalRuntimeDependencies(pkg, version, packageNames = publishablePackageNames()) {
  const expected = `^${version}`
  const internalNames = packageNames instanceof Set ? packageNames : new Set(packageNames)
  for (const [name, spec] of Object.entries(pkg?.dependencies ?? {})) {
    if (!internalNames.has(name)) continue
    assert(
      spec === expected,
      `${pkg?.name ?? 'unknown package'}: dependencies["${name}"] must be ${expected}, found ${spec}`,
    )
  }
}

export function assertPublishablePackageCoverage(discoveredPackages, listedPackages = publishablePackages) {
  const listedNames = new Set()
  const listedPaths = new Set()
  for (const pkg of listedPackages) {
    assert(!listedNames.has(pkg.name), `release manifest lists ${pkg.name} more than once`)
    assert(!listedPaths.has(pkg.path), `release manifest lists ${pkg.path} more than once`)
    listedNames.add(pkg.name)
    listedPaths.add(pkg.path)

    const discovered = discoveredPackages.find((candidate) => candidate.path === pkg.path)
    assert(discovered, `release manifest lists missing workspace ${pkg.path}`)
    assert(discovered.name === pkg.name, `${pkg.path}: release manifest name must be ${discovered.name}`)
    assert(discovered.private !== true, `${pkg.name}: private workspaces must not be published`)
  }

  for (const pkg of discoveredPackages) {
    if (pkg.private === true) continue
    assert(
      listedNames.has(pkg.name) && listedPaths.has(pkg.path),
      `${pkg.path}: non-private workspace ${pkg.name ?? 'unknown'} is missing from the release manifest`,
    )
  }
}

export function assertWorkspaceManifestLocks({ pkg, workspacePath, npmLock, bunLock }) {
  const npmWorkspace = npmLock?.packages?.[workspacePath]
  const bunWorkspace = bunLock?.workspaces?.[workspacePath]
  for (const [lockName, workspace] of [
    ['package-lock.json', npmWorkspace],
    ['bun.lock', bunWorkspace],
  ]) {
    assert(workspace, `${lockName}: missing workspace ${workspacePath}`)
    assert(!workspace.name || workspace.name === pkg.name, `${lockName}: ${workspacePath} must be named ${pkg.name}`)
    assert(
      workspace.version === pkg.version,
      `${lockName}: ${pkg.name} workspace version must be ${pkg.version}, found ${workspace.version ?? 'missing'}`,
    )
    for (const [name, spec] of Object.entries(pkg.dependencies ?? {})) {
      assert(
        workspace.dependencies?.[name] === spec,
        `${lockName}: ${pkg.name} dependency ${name} must be ${spec}, found ${workspace.dependencies?.[name] ?? 'missing'}`,
      )
    }
  }
}

async function discoverPackageWorkspaces() {
  const packageEntries = await readdir(path.join(repoRoot, 'packages'), { withFileTypes: true })
  const manifestPaths = packageEntries
    .filter((entry) => entry.isDirectory())
    .map((entry) => `packages/${entry.name}/package.json`)
  manifestPaths.push('mcp/package.json')

  return Promise.all(
    manifestPaths.map(async (manifestPath) => {
      const pkg = await readJson(manifestPath)
      return { name: pkg.name, path: path.dirname(manifestPath), private: pkg.private }
    }),
  )
}

export async function assertNoTrackedMcpPackageLock() {
  const { stdout } = await execFileAsync('git', ['ls-files', '--cached', '--', 'mcp/package-lock.json'], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
  assert(
    stdout.trim() === '',
    'mcp/package-lock.json must not be tracked; the root lockfiles own the MCP workspace dependency graph',
  )
}

function assertNoFileProtocolDeps(pkg, relPath, releaseVersion) {
  for (const section of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const deps = pkg[section]
    if (!deps || typeof deps !== 'object') continue
    for (const [name, spec] of Object.entries(deps)) {
      if (typeof spec === 'string' && spec.startsWith('file:')) {
        throw new Error(
          `${relPath}: ${section}["${name}"] is "${spec}" — file: deps are published verbatim to npm and break consumers; use semver (e.g. ^${releaseVersion})`,
        )
      }
    }
  }
}

export async function run(version) {
  const [rootPackage, mcpPackage, npmLock, bunLockSource] = await Promise.all([
    readJson('package.json'),
    readJson('mcp/package.json'),
    readJson('package-lock.json'),
    readFile(path.join(repoRoot, 'bun.lock'), 'utf8'),
  ])
  const bunLock = parseBunLock(bunLockSource)
  assertWorkspaceLockGraph({
    rootPackage,
    npmLock,
    bunLock,
    version,
  })
  assertMcpProxyDependency(mcpPackage, version)
  await assertNoTrackedMcpPackageLock()
  assertPublishablePackageCoverage(await discoverPackageWorkspaces())

  const publishableNames = new Set(publishablePackageNames())
  for (const [expectedName, manifestPath] of publishablePackageJsons()) {
    const raw = await readFile(path.join(repoRoot, manifestPath), 'utf8')
    const pkg = JSON.parse(raw)
    if (pkg.name !== expectedName) {
      throw new Error(`${manifestPath}: expected name ${expectedName}, found ${pkg.name ?? 'unknown'}`)
    }
    if (pkg.version !== version) {
      throw new Error(`${pkg.name}: package.json version ${pkg.version ?? 'unknown'} expected ${version}`)
    }
    assertWorkspaceManifestLocks({ pkg, workspacePath: path.dirname(manifestPath), npmLock, bunLock })
    assertInternalRuntimeDependencies(pkg, version, publishableNames)
    assertNoFileProtocolDeps(pkg, manifestPath, version)
    console.log(`${pkg.name}: ${pkg.version}`)
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const version = process.argv[2]
  if (!version) {
    console.error('Usage: node scripts/release/check-source.mjs <version>')
    process.exit(1)
  }

  run(version).catch((err) => {
    console.error(String(err))
    process.exit(1)
  })
}
