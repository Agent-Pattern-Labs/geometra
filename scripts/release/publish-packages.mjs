#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { publishablePackages } from './package-manifest.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
const sleepBuffer = new Int32Array(new SharedArrayBuffer(4))
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

function sleep(ms) {
  Atomics.wait(sleepBuffer, 0, 0, ms)
}

function registryKey(name, version) {
  return `${name}@${version}`
}

function parseSemver(version) {
  const match = SEMVER_RE.exec(version)
  if (!match) throw new Error(`Invalid release version: ${version}`)
  return {
    numbers: match.slice(1, 4).map(Number),
    prerelease: match[4]?.split('.') ?? [],
  }
}

export function compareSemver(left, right) {
  const a = parseSemver(left)
  const b = parseSemver(right)
  for (let index = 0; index < 3; index += 1) {
    if (a.numbers[index] !== b.numbers[index]) return a.numbers[index] < b.numbers[index] ? -1 : 1
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    return a.prerelease.length === b.prerelease.length ? 0 : a.prerelease.length === 0 ? 1 : -1
  }
  const length = Math.max(a.prerelease.length, b.prerelease.length)
  for (let index = 0; index < length; index += 1) {
    const leftPart = a.prerelease[index]
    const rightPart = b.prerelease[index]
    if (leftPart === undefined || rightPart === undefined) return leftPart === undefined ? -1 : 1
    if (leftPart === rightPart) continue
    const leftNumeric = /^\d+$/.test(leftPart)
    const rightNumeric = /^\d+$/.test(rightPart)
    if (leftNumeric && rightNumeric) return Number(leftPart) < Number(rightPart) ? -1 : 1
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1
    return leftPart < rightPart ? -1 : 1
  }
  return 0
}

export function stagingTagFor(version) {
  parseSemver(version)
  return `geometra-staging-${version.replace(/[^a-zA-Z0-9._-]/g, '-')}`
}

export function resolveReleaseVersion(packages, expectedVersion) {
  if (!expectedVersion) throw new Error('VERSION (or an explicit version argument) is required for npm publication')
  parseSemver(expectedVersion)
  if (packages.length === 0) throw new Error('No publishable packages were configured')
  const names = new Set()
  const versions = new Set()
  for (const pkg of packages) {
    if (!pkg.name || !pkg.path || !pkg.version || !pkg.integrity) {
      throw new Error('Every publishable package requires name, path, version, and local pack integrity')
    }
    if (pkg.private === true) throw new Error(`${pkg.name}: private packages must not be published`)
    if (names.has(pkg.name)) throw new Error(`${pkg.name}: package is listed more than once`)
    names.add(pkg.name)
    versions.add(pkg.version)
  }
  if (versions.size !== 1) {
    throw new Error(`Publishable package versions must match, found: ${[...versions].join(', ')}`)
  }
  const [version] = versions
  parseSemver(version)
  if (version !== expectedVersion) {
    throw new Error(`Release version ${version} does not match workflow VERSION ${expectedVersion}`)
  }
  return version
}

function isNotFound(result) {
  return /\bE404\b|404 Not Found/i.test(`${result.stdout ?? ''}\n${result.stderr ?? ''}`)
}

function commandFailure(args, result) {
  const details = [result.stdout, result.stderr]
    .filter((value) => typeof value === 'string' && value.trim().length > 0)
    .map((value) => value.trim())
    .join('\n')
  return new Error(
    `npm ${args.join(' ')} failed with status ${result.status ?? 'unknown'}${details ? `\n${details}` : ''}`,
  )
}

function parseJsonOutput(args, result) {
  try {
    const value = JSON.parse(result.stdout || 'null')
    return Array.isArray(value) && value.length === 1 ? value[0] : value
  } catch {
    throw new Error(`npm ${args.join(' ')} returned invalid JSON: ${result.stdout || '<empty>'}`)
  }
}

export class NpmRegistry {
  constructor(rootDir = root, execute = spawnSync) {
    this.rootDir = rootDir
    this.execute = execute
  }

  run(args, { cwd = this.rootDir, capture = false } = {}) {
    const result = this.execute('npm', args, {
      cwd,
      env: process.env,
      encoding: capture ? 'utf8' : undefined,
      stdio: capture ? 'pipe' : 'inherit',
    })
    if (result.error) throw result.error
    return result
  }

  artifact(name, version) {
    const args = ['view', registryKey(name, version), 'version', 'dist.integrity', '--json', '--prefer-online']
    const result = this.run(args, { capture: true })
    if (result.status !== 0) {
      if (isNotFound(result)) return null
      throw commandFailure(args, result)
    }
    const metadata = parseJsonOutput(args, result)
    return {
      version: metadata?.version,
      integrity: metadata?.['dist.integrity'],
    }
  }

  tags(name) {
    const args = ['view', name, 'dist-tags', '--json', '--prefer-online']
    const result = this.run(args, { capture: true })
    if (result.status !== 0) {
      if (isNotFound(result)) return {}
      throw commandFailure(args, result)
    }
    return parseJsonOutput(args, result) ?? {}
  }

  packIntegrity(pkg) {
    const args = ['pack', '--dry-run', '--json', '--ignore-scripts']
    const result = this.run(args, { cwd: join(this.rootDir, pkg.path), capture: true })
    if (result.status !== 0) throw commandFailure(args, result)
    const payload = JSON.parse(result.stdout || 'null')
    const integrity = payload?.[0]?.integrity
    if (typeof integrity !== 'string') throw new Error(`${pkg.name}: npm pack did not return an integrity hash`)
    return integrity
  }

  publish(pkg, tag) {
    const args = ['publish', '--provenance', '--access', 'public', '--tag', tag]
    const result = this.run(args, { cwd: join(this.rootDir, pkg.path) })
    if (result.status !== 0) throw commandFailure(args, result)
  }

  addTag(name, version, tag) {
    const args = ['dist-tag', 'add', registryKey(name, version), tag]
    const result = this.run(args)
    if (result.status !== 0) throw commandFailure(args, result)
  }

  removeTag(name, tag) {
    const args = ['dist-tag', 'rm', name, tag]
    const result = this.run(args)
    if (result.status !== 0) throw commandFailure(args, result)
  }
}

function assertArtifactIntegrity(pkg, version, artifact) {
  if (!artifact) return false
  if (artifact.version !== version || artifact.integrity !== pkg.integrity) {
    throw new Error(
      `${registryKey(pkg.name, version)} integrity conflict: expected ${pkg.integrity}, found ${artifact.integrity ?? 'missing'}`,
    )
  }
  return true
}

function assertNoLatestDowngrade(pkg, version, tags) {
  if (!tags.latest || tags.latest === version) return
  if (compareSemver(tags.latest, version) > 0) {
    throw new Error(`${pkg.name}: refusing to move latest backward from ${tags.latest} to ${version}`)
  }
}

function inspectPublishedState(pkg, version, stagingTag, registry, requiredTag) {
  const artifact = registry.artifact(pkg.name, version)
  if (!assertArtifactIntegrity(pkg, version, artifact)) return { ready: false, reason: 'artifact is not visible' }
  const tags = registry.tags(pkg.name)
  const ready =
    requiredTag === 'latest'
      ? tags.latest === version
      : requiredTag === 'staging'
        ? tags[stagingTag] === version
        : tags[stagingTag] === version || tags.latest === version
  return { ready, reason: `${requiredTag} tag is not visible`, tags }
}

function waitForState(pkg, version, stagingTag, registry, requiredTag, wait, attempts) {
  let reason = 'state is not visible'
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const state = inspectPublishedState(pkg, version, stagingTag, registry, requiredTag)
    if (state.ready) return state
    reason = state.reason
    if (attempt < attempts) wait(2_000)
  }
  throw new Error(`${registryKey(pkg.name, version)} was not confirmed: ${reason}`)
}

function mutateWithConfirmation({ mutate, confirm, label, log }) {
  let mutationError
  try {
    mutate()
  } catch (error) {
    mutationError = error
  }
  try {
    confirm()
  } catch (confirmationError) {
    if (mutationError) {
      throw new Error(
        `${label} failed and registry confirmation did not recover it: ${mutationError.message}; ${confirmationError.message}`,
        { cause: confirmationError },
      )
    }
    throw confirmationError
  }
  if (mutationError) log(`${label} was accepted by npm despite a lost acknowledgement; continuing`)
}

export function publishRelease({
  packages,
  registry,
  expectedVersion,
  log = console.log,
  warn = console.warn,
  wait = sleep,
  visibilityAttempts = 6,
}) {
  const version = resolveReleaseVersion(packages, expectedVersion)
  const stagingTag = stagingTagFor(version)
  const missing = []

  // Complete read-only preflight before the first registry mutation.
  for (const pkg of packages) {
    const tags = registry.tags(pkg.name)
    assertNoLatestDowngrade(pkg, version, tags)
    const artifact = registry.artifact(pkg.name, version)
    if (!artifact) {
      missing.push(pkg)
      continue
    }
    assertArtifactIntegrity(pkg, version, artifact)
    if (tags[stagingTag] !== version && tags.latest !== version) {
      throw new Error(
        `${registryKey(pkg.name, version)} already exists without ${stagingTag} or latest ownership; refusing to overwrite`,
      )
    }
    log(`Resuming ${registryKey(pkg.name, version)} (already published)`)
  }

  // Publish immutable artifacts under a release-specific staging tag. A lost
  // CLI acknowledgement is accepted only when bytes and ownership both match.
  for (const pkg of missing) {
    log(`Staging ${registryKey(pkg.name, version)} from ${pkg.path}`)
    mutateWithConfirmation({
      mutate: () => registry.publish(pkg, stagingTag),
      confirm: () => waitForState(pkg, version, stagingTag, registry, 'staging', wait, visibilityAttempts),
      label: `Publishing ${registryKey(pkg.name, version)}`,
      log,
    })
  }

  // All-package barrier: no latest tag moves until every exact artifact is
  // visible, byte-identical to its local pack, and owned by this release.
  for (const pkg of packages) {
    waitForState(pkg, version, stagingTag, registry, 'owned', wait, visibilityAttempts)
  }

  for (const pkg of packages) {
    const tags = registry.tags(pkg.name)
    assertNoLatestDowngrade(pkg, version, tags)
    if (tags.latest === version) continue
    log(`Promoting ${registryKey(pkg.name, version)} to latest`)
    mutateWithConfirmation({
      mutate: () => registry.addTag(pkg.name, version, 'latest'),
      confirm: () => waitForState(pkg, version, stagingTag, registry, 'latest', wait, visibilityAttempts),
      label: `Promoting ${registryKey(pkg.name, version)}`,
      log,
    })
  }

  // Final all-package barrier. Staging tags remain intact if any latest update
  // is unconfirmed, leaving a safe and resumable release state.
  for (const pkg of packages) {
    waitForState(pkg, version, stagingTag, registry, 'latest', wait, visibilityAttempts)
  }

  for (const pkg of packages) {
    if (registry.tags(pkg.name)[stagingTag] !== version) continue
    try {
      registry.removeTag(pkg.name, stagingTag)
      if (registry.tags(pkg.name)[stagingTag] === version) {
        warn(`${pkg.name}: ${stagingTag} removal was not confirmed; leaving the harmless staging tag in place`)
      }
    } catch (error) {
      warn(`${pkg.name}: could not remove ${stagingTag}: ${error.message}`)
    }
  }
}

function readReleasePackages(registry) {
  return publishablePackages.map((expected) => {
    const manifest = JSON.parse(readFileSync(join(root, expected.path, 'package.json'), 'utf8'))
    if (manifest.name !== expected.name) {
      throw new Error(`${expected.path}: expected ${expected.name}, found ${manifest.name ?? 'missing'}`)
    }
    const pkg = { ...expected, version: manifest.version, private: manifest.private }
    return { ...pkg, integrity: registry.packIntegrity(pkg) }
  })
}

export function main() {
  const expectedVersion = process.env.VERSION ?? process.argv[2]
  const registry = new NpmRegistry()
  publishRelease({
    packages: readReleasePackages(registry),
    registry,
    expectedVersion,
  })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (error) {
    console.error(String(error?.message ?? error))
    process.exit(1)
  }
}
