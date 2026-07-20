import { describe, expect, it } from 'vitest'
import {
  compareSemver,
  NpmRegistry,
  publishRelease,
  resolveReleaseVersion,
  stagingTagFor,
} from './publish-packages.mjs'

type PackageRecord = { name: string; path: string; version: string; integrity: string }

class FakeRegistry {
  readonly events: string[] = []
  readonly artifacts = new Map<string, { version: string; integrity: string }>()
  readonly tagsByName = new Map<string, Record<string, string>>()
  readonly hiddenArtifactReads = new Map<string, number>()
  publishFailure: 'before' | 'after' | undefined
  promotionFailure: 'before' | 'after' | undefined
  visibilityDelayReads = 0

  artifact(name: string, version: string) {
    const key = `${name}@${version}`
    const hiddenReads = this.hiddenArtifactReads.get(key) ?? 0
    if (hiddenReads > 0) {
      this.hiddenArtifactReads.set(key, hiddenReads - 1)
      return null
    }
    return this.artifacts.get(key) ?? null
  }

  tags(name: string) {
    return { ...(this.tagsByName.get(name) ?? {}) }
  }

  publish(pkg: PackageRecord, tag: string) {
    this.events.push(`publish:${pkg.name}:${tag}`)
    if (this.publishFailure === 'before') throw new Error('publish rejected')
    const key = `${pkg.name}@${pkg.version}`
    this.artifacts.set(key, { version: pkg.version, integrity: pkg.integrity })
    this.hiddenArtifactReads.set(key, this.visibilityDelayReads)
    this.tagsByName.set(pkg.name, { ...this.tags(pkg.name), [tag]: pkg.version })
    if (this.publishFailure === 'after') throw new Error('publish acknowledgement lost')
  }

  addTag(name: string, version: string, tag: string) {
    this.events.push(`tag:${name}:${tag}`)
    if (this.promotionFailure === 'before') throw new Error('tag rejected')
    this.tagsByName.set(name, { ...this.tags(name), [tag]: version })
    if (this.promotionFailure === 'after') throw new Error('tag acknowledgement lost')
  }

  removeTag(name: string, tag: string) {
    this.events.push(`untag:${name}:${tag}`)
    const tags = this.tags(name)
    delete tags[tag]
    this.tagsByName.set(name, tags)
  }
}

const packages: PackageRecord[] = [
  { name: '@geometra/core', path: 'packages/core', version: '2.0.0', integrity: 'sha512-core' },
  { name: '@geometra/client', path: 'packages/client', version: '2.0.0', integrity: 'sha512-client' },
]

function stage(registry: FakeRegistry, pkg: PackageRecord, latest?: string) {
  const stagingTag = stagingTagFor(pkg.version)
  registry.artifacts.set(`${pkg.name}@${pkg.version}`, { version: pkg.version, integrity: pkg.integrity })
  registry.tagsByName.set(pkg.name, { ...(latest ? { latest } : {}), [stagingTag]: pkg.version })
}

describe('staged package publishing', () => {
  it('requires one exact release version and local integrity before registry mutation', () => {
    expect(resolveReleaseVersion(packages, '2.0.0')).toBe('2.0.0')
    expect(() => resolveReleaseVersion(packages, undefined)).toThrow(/VERSION/)
    expect(() => resolveReleaseVersion([{ ...packages[0], version: '1.0.0' }, packages[1]], '2.0.0')).toThrow(
      /must match/,
    )
    expect(() => resolveReleaseVersion(packages, '2.0.1')).toThrow(/workflow VERSION/)
  })

  it('compares stable and prerelease versions without allowing downgrades', () => {
    expect(compareSemver('2.0.0', '1.99.0')).toBe(1)
    expect(compareSemver('2.0.0', '2.0.0-rc.1')).toBe(1)
    expect(compareSemver('2.0.0-rc.2', '2.0.0-rc.10')).toBe(-1)
    expect(stagingTagFor('2.0.0-beta.1+build.7')).toMatch(/^geometra-staging-/)
  })

  it('publishes the complete byte-verified set under staging before promoting latest', () => {
    const registry = new FakeRegistry()
    publishRelease({ packages, registry, expectedVersion: '2.0.0', log: () => {}, wait: () => {} })

    const lastPublish = Math.max(...registry.events.map((event, index) => (event.startsWith('publish:') ? index : -1)))
    const firstPromotion = registry.events.findIndex((event) => event.endsWith(':latest'))
    expect(lastPublish).toBeLessThan(firstPromotion)
    expect(registry.events.filter((event) => event.startsWith('publish:'))).toHaveLength(2)
    expect(registry.tags('@geometra/core')).toEqual({ latest: '2.0.0' })
    expect(registry.tags('@geometra/client')).toEqual({ latest: '2.0.0' })
  })

  it('resumes staged versions without republishing immutable artifacts', () => {
    const registry = new FakeRegistry()
    stage(registry, packages[0])

    publishRelease({ packages, registry, expectedVersion: '2.0.0', log: () => {}, wait: () => {} })

    expect(registry.events.filter((event) => event.startsWith('publish:'))).toEqual([
      `publish:@geometra/client:${stagingTagFor('2.0.0')}`,
    ])
    expect(registry.tags('@geometra/core')).toEqual({ latest: '2.0.0' })
  })

  it('recovers lost publish and promotion acknowledgements from exact registry evidence', () => {
    const registry = new FakeRegistry()
    registry.publishFailure = 'after'
    registry.promotionFailure = 'after'

    expect(() =>
      publishRelease({ packages, registry, expectedVersion: '2.0.0', log: () => {}, wait: () => {} }),
    ).not.toThrow()
    expect(registry.tags('@geometra/core')).toEqual({ latest: '2.0.0' })
    expect(registry.tags('@geometra/client')).toEqual({ latest: '2.0.0' })
  })

  it('waits through delayed npm registry propagation before failing publication', () => {
    const registry = new FakeRegistry()
    registry.visibilityDelayReads = 10

    expect(() =>
      publishRelease({ packages, registry, expectedVersion: '2.0.0', log: () => {}, wait: () => {} }),
    ).not.toThrow()
    expect(registry.tags('@geometra/core')).toEqual({ latest: '2.0.0' })
    expect(registry.tags('@geometra/client')).toEqual({ latest: '2.0.0' })
  })

  it('never promotes when publication fails before the all-artifact barrier', () => {
    const registry = new FakeRegistry()
    registry.publishFailure = 'before'

    expect(() =>
      publishRelease({
        packages,
        registry,
        expectedVersion: '2.0.0',
        log: () => {},
        wait: () => {},
        visibilityAttempts: 1,
      }),
    ).toThrow(/confirmation did not recover/)
    expect(registry.events.some((event) => event.startsWith('tag:'))).toBe(false)
  })

  it('fails closed on integrity conflicts and versions not owned by this release', () => {
    const integrityConflict = new FakeRegistry()
    stage(integrityConflict, packages[0])
    integrityConflict.artifacts.get('@geometra/core@2.0.0')!.integrity = 'sha512-wrong'
    expect(() =>
      publishRelease({
        packages,
        registry: integrityConflict,
        expectedVersion: '2.0.0',
        log: () => {},
        wait: () => {},
      }),
    ).toThrow(/integrity conflict/)
    expect(integrityConflict.events).toEqual([])

    const ownershipConflict = new FakeRegistry()
    ownershipConflict.artifacts.set('@geometra/core@2.0.0', {
      version: '2.0.0',
      integrity: packages[0].integrity,
    })
    ownershipConflict.tagsByName.set('@geometra/core', { next: '2.0.0' })
    expect(() =>
      publishRelease({
        packages,
        registry: ownershipConflict,
        expectedVersion: '2.0.0',
        log: () => {},
        wait: () => {},
      }),
    ).toThrow(/refusing to overwrite/)
    expect(ownershipConflict.events).toEqual([])
  })

  it('refuses to move latest backward before publishing or promoting anything', () => {
    const registry = new FakeRegistry()
    registry.tagsByName.set('@geometra/core', { latest: '3.0.0' })

    expect(() =>
      publishRelease({ packages, registry, expectedVersion: '2.0.0', log: () => {}, wait: () => {} }),
    ).toThrow(/refusing to move latest backward/)
    expect(registry.events).toEqual([])
  })

  it('keeps staging tags when a latest promotion cannot be confirmed', () => {
    const registry = new FakeRegistry()
    packages.forEach((pkg) => stage(registry, pkg))
    registry.promotionFailure = 'before'

    expect(() =>
      publishRelease({
        packages,
        registry,
        expectedVersion: '2.0.0',
        log: () => {},
        wait: () => {},
        visibilityAttempts: 1,
      }),
    ).toThrow(/confirmation did not recover/)
    expect(registry.events.some((event) => event.startsWith('untag:'))).toBe(false)
    expect(registry.tags('@geometra/core')[stagingTagFor('2.0.0')]).toBe('2.0.0')
  })

  it('uses explicit staged npm arguments and normalizes singleton view output', () => {
    const calls: Array<{ command: string; args: string[]; cwd: string }> = []
    const execute = (command: string, args: string[], options: { cwd: string }) => {
      calls.push({ command, args, cwd: options.cwd })
      if (args[0] === 'pack') {
        return { status: 0, stdout: JSON.stringify([{ integrity: 'sha512-core' }]), stderr: '' }
      }
      if (args.includes('dist.integrity')) {
        return {
          status: 0,
          stdout: JSON.stringify([{ version: '2.0.0', 'dist.integrity': 'sha512-core' }]),
          stderr: '',
        }
      }
      if (args[0] === 'view') {
        return { status: 0, stdout: JSON.stringify([{ latest: '2.0.0' }]), stderr: '' }
      }
      return { status: 0, stdout: '', stderr: '' }
    }
    const registry = new NpmRegistry('/repo', execute)

    expect(registry.packIntegrity(packages[0])).toBe('sha512-core')
    expect(registry.artifact('@geometra/core', '2.0.0')).toEqual({
      version: '2.0.0',
      integrity: 'sha512-core',
    })
    expect(registry.tags('@geometra/core')).toEqual({ latest: '2.0.0' })
    registry.publish(packages[0], 'geometra-staging-2.0.0')

    expect(calls.at(-1)).toEqual({
      command: 'npm',
      args: ['publish', '--provenance', '--access', 'public', '--tag', 'geometra-staging-2.0.0'],
      cwd: '/repo/packages/core',
    })
  })
})
