#!/usr/bin/env node
/**
 * Atomic version bump for every publishable package in the monorepo.
 *
 * Usage: node scripts/release/bump-version.mjs <oldVersion> <newVersion>
 *
 * Why this exists: every release in this repo touches every publishable package.json
 * in lockstep. Doing that by hand is the kind of mechanical work that quietly
 * goes wrong (typo, missed file, off-by-one). The release workflow's
 * `check-source.mjs` then fails the publish, but only after CI has burned
 * through several minutes — and historically two of the publishable packages
 * (`@geometra/agent`, `@geometra/cli`) weren't even in `check-source.mjs`,
 * so they could drift forever without detection.
 *
 * This script:
 *   - Verifies every package currently sits at <oldVersion> (refuses to
 *     proceed if any drift exists — explicit "first fix the drift" signal).
 *   - Rewrites each package.json's version and internal dependency ranges to <newVersion>.
 *   - Updates the npm and Bun workspace lock metadata in the same operation.
 *   - Prints what it touched.
 *
 * It also updates internal dependency ranges. Keeping the committed source
 * graph aligned with the release prevents clone installs from falling back to
 * an older registry package after an incompatible version bump.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { publishablePackageJsons, publishTimeDependencyUpdates } from './package-manifest.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')

const packages = publishablePackageJsons()

const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[\w.+-]+)?$/

export function rewritePackageManifest(raw, expectedName, oldVersion, newVersion, dependencyUpdates = {}) {
  const pkg = JSON.parse(raw)
  if (pkg.name !== expectedName) {
    throw new Error(`expected name ${expectedName}, found ${pkg.name ?? 'unknown'}`)
  }
  if (pkg.version !== oldVersion) {
    throw new Error(`${pkg.name}: ${pkg.version ?? 'unknown'} (expected ${oldVersion})`)
  }

  pkg.version = newVersion
  for (const [name, spec] of Object.entries(dependencyUpdates)) {
    if (typeof pkg.dependencies?.[name] !== 'string') {
      throw new Error(`${pkg.name}: missing dependencies["${name}"]`)
    }
    pkg.dependencies[name] = spec
  }

  return `${JSON.stringify(pkg, null, 2)}\n`
}

function changedRuntimeDependencies(previousPackage, nextPackage) {
  return Object.entries(nextPackage.dependencies ?? {})
    .filter(([name, spec]) => previousPackage.dependencies?.[name] !== spec)
    .map(([name, spec]) => ({ name, previous: previousPackage.dependencies?.[name], next: spec }))
}

export function rewriteNpmWorkspaceLock(raw, packageUpdates) {
  const lock = JSON.parse(raw)
  for (const { path: workspacePath, previousPackage, nextPackage } of packageUpdates) {
    const workspace = lock.packages?.[workspacePath]
    if (!workspace) throw new Error(`package-lock.json: missing workspace ${workspacePath}`)
    if (workspace.name && workspace.name !== nextPackage.name) {
      throw new Error(`package-lock.json: ${workspacePath} is ${workspace.name}, expected ${nextPackage.name}`)
    }
    if (workspace.version !== previousPackage.version) {
      throw new Error(
        `package-lock.json: ${nextPackage.name} is ${workspace.version ?? 'missing'}, expected ${previousPackage.version}`,
      )
    }
    workspace.version = nextPackage.version

    for (const dependency of changedRuntimeDependencies(previousPackage, nextPackage)) {
      if (workspace.dependencies?.[dependency.name] !== dependency.previous) {
        throw new Error(
          `package-lock.json: ${nextPackage.name} dependency ${dependency.name} is ${workspace.dependencies?.[dependency.name] ?? 'missing'}, expected ${dependency.previous}`,
        )
      }
      workspace.dependencies[dependency.name] = dependency.next
    }
  }
  return `${JSON.stringify(lock, null, 2)}\n`
}

function findMatchingBrace(source, openBraceIndex) {
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = openBraceIndex; index < source.length; index += 1) {
    const character = source[index]
    if (inString) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') inString = false
      continue
    }
    if (character === '"') inString = true
    else if (character === '{') depth += 1
    else if (character === '}') {
      depth -= 1
      if (depth === 0) return index
    }
  }
  throw new Error('bun.lock: unterminated workspace entry')
}

function replaceExactlyOnce(source, previous, next, context) {
  const first = source.indexOf(previous)
  if (first === -1) throw new Error(`${context}: expected ${previous}`)
  if (source.indexOf(previous, first + previous.length) !== -1) {
    throw new Error(`${context}: found ${previous} more than once`)
  }
  return `${source.slice(0, first)}${next}${source.slice(first + previous.length)}`
}

export function rewriteBunWorkspaceLock(raw, packageUpdates) {
  let lock = raw
  for (const { path: workspacePath, previousPackage, nextPackage } of packageUpdates) {
    const marker = `    ${JSON.stringify(workspacePath)}: {`
    const start = lock.indexOf(marker)
    if (start === -1) throw new Error(`bun.lock: missing workspace ${workspacePath}`)
    if (lock.indexOf(marker, start + marker.length) !== -1) {
      throw new Error(`bun.lock: workspace ${workspacePath} appears more than once`)
    }
    const openBrace = start + marker.lastIndexOf('{')
    const end = findMatchingBrace(lock, openBrace) + 1
    let workspace = lock.slice(start, end)
    if (!workspace.includes(`"name": ${JSON.stringify(nextPackage.name)}`)) {
      throw new Error(`bun.lock: ${workspacePath} must be named ${nextPackage.name}`)
    }
    workspace = replaceExactlyOnce(
      workspace,
      `"version": ${JSON.stringify(previousPackage.version)}`,
      `"version": ${JSON.stringify(nextPackage.version)}`,
      `bun.lock: ${nextPackage.name}`,
    )
    for (const dependency of changedRuntimeDependencies(previousPackage, nextPackage)) {
      workspace = replaceExactlyOnce(
        workspace,
        `${JSON.stringify(dependency.name)}: ${JSON.stringify(dependency.previous)}`,
        `${JSON.stringify(dependency.name)}: ${JSON.stringify(dependency.next)}`,
        `bun.lock: ${nextPackage.name}`,
      )
    }
    lock = `${lock.slice(0, start)}${workspace}${lock.slice(end)}`
  }
  return lock
}

function usage() {
  console.error('Usage: node scripts/release/bump-version.mjs <oldVersion> <newVersion>')
  console.error('Example: node scripts/release/bump-version.mjs 1.34.0 1.35.0')
}

export async function run(oldVersion, newVersion) {
  if (!oldVersion || !newVersion) {
    usage()
    process.exit(1)
  }
  if (!SEMVER_RE.test(oldVersion) || !SEMVER_RE.test(newVersion)) {
    console.error(`Both versions must look like x.y.z (got "${oldVersion}" → "${newVersion}")`)
    process.exit(1)
  }
  if (oldVersion === newVersion) {
    console.error(`Old and new versions are identical (${oldVersion}). Nothing to do.`)
    process.exit(1)
  }

  // First pass: verify every package is at oldVersion. Fail fast on drift
  // before mutating anything, so we never leave the tree half-bumped.
  const drift = []
  const sources = new Map()
  for (const [expectedName, relPath] of packages) {
    const abs = join(root, relPath)
    const raw = await readFile(abs, 'utf8')
    sources.set(expectedName, { abs, raw, relPath })
    const pkg = JSON.parse(raw)
    if (pkg.name !== expectedName) {
      console.error(`${relPath}: expected name ${expectedName}, found ${pkg.name ?? 'unknown'}`)
      process.exit(1)
    }
    if (pkg.version !== oldVersion) {
      drift.push(`  ${pkg.name}: ${pkg.version} (expected ${oldVersion})`)
    }
  }
  if (drift.length > 0) {
    console.error(`Refusing to bump — some packages are not at ${oldVersion}:`)
    console.error(drift.join('\n'))
    console.error('Fix the drift first, then re-run.')
    process.exit(1)
  }

  // Second pass: update package versions and the internal source dependency graph.
  const updatesByName = new Map(publishTimeDependencyUpdates(newVersion).map((update) => [update.name, update]))
  const writes = []
  const packageUpdates = []
  for (const [expectedName, relPath] of packages) {
    const { abs, raw } = sources.get(expectedName)
    const dependencyUpdates = updatesByName.get(expectedName)?.dependencies ?? {}
    const next = rewritePackageManifest(raw, expectedName, oldVersion, newVersion, dependencyUpdates)
    writes.push({ abs, next, relPath })
    packageUpdates.push({
      path: dirname(relPath),
      previousPackage: JSON.parse(raw),
      nextPackage: JSON.parse(next),
    })
  }

  const npmLockPath = join(root, 'package-lock.json')
  const bunLockPath = join(root, 'bun.lock')
  const [npmLockRaw, bunLockRaw] = await Promise.all([readFile(npmLockPath, 'utf8'), readFile(bunLockPath, 'utf8')])
  writes.push({
    abs: npmLockPath,
    next: rewriteNpmWorkspaceLock(npmLockRaw, packageUpdates),
    relPath: 'package-lock.json',
  })
  writes.push({
    abs: bunLockPath,
    next: rewriteBunWorkspaceLock(bunLockRaw, packageUpdates),
    relPath: 'bun.lock',
  })

  for (const { abs, next, relPath } of writes) {
    await writeFile(abs, next)
    console.log(`  ${relPath}: ${oldVersion} → ${newVersion}`)
  }

  console.log(`\nBumped ${packages.length} package.json files and 2 lockfiles: ${oldVersion} → ${newVersion}`)
  console.log('Next: commit as `chore(release): vX.Y.Z — <summary>`, push, then `gh release create vX.Y.Z`.')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [oldVersion, newVersion] = process.argv.slice(2)
  run(oldVersion, newVersion).catch((err) => {
    console.error(String(err?.message ?? err))
    process.exit(1)
  })
}
