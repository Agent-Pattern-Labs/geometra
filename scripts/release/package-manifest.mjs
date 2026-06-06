export const publishablePackages = [
  { name: 'textura', path: 'packages/textura' },
  { name: '@geometra/core', path: 'packages/core' },
  { name: '@geometra/renderer-canvas', path: 'packages/renderer-canvas' },
  { name: '@geometra/renderer-terminal', path: 'packages/renderer-terminal' },
  { name: '@geometra/renderer-webgpu', path: 'packages/renderer-webgpu' },
  { name: '@geometra/renderer-pdf', path: 'packages/renderer-pdf' },
  { name: '@geometra/renderer-three', path: 'packages/renderer-three' },
  { name: '@geometra/server', path: 'packages/server' },
  { name: '@geometra/client', path: 'packages/client' },
  { name: '@geometra/ui', path: 'packages/ui' },
  { name: '@geometra/router', path: 'packages/router' },
  { name: '@geometra/tw', path: 'packages/tw' },
  { name: '@geometra/agent', path: 'packages/agent' },
  { name: '@geometra/gateway', path: 'packages/gateway' },
  { name: '@geometra/evidence', path: 'packages/evidence' },
  { name: '@geometra/cli', path: 'packages/cli' },
  { name: '@geometra/proxy', path: 'packages/proxy' },
  { name: '@geometra/mcp', path: 'mcp' },
]

export const packageJsonPath = (pkg) => `${pkg.path}/package.json`

export function publishablePackageJsons() {
  return publishablePackages.map(pkg => [pkg.name, packageJsonPath(pkg)])
}

export function publishablePackageNames() {
  return publishablePackages.map(pkg => pkg.name)
}

export function publishTimeDependencyUpdates(version) {
  const updatesByName = new Map(publishablePackages.map(pkg => [pkg.name, { name: pkg.name, path: pkg.path, dependencies: {} }]))
  const addDependency = (packageName, dependencyName, spec) => {
    const update = updatesByName.get(packageName)
    if (!update) throw new Error(`Unknown publishable package in dependency manifest: ${packageName}`)
    update.dependencies[dependencyName] = spec
  }

  addDependency('@geometra/core', 'textura', `^${version}`)

  for (const packageName of [
    '@geometra/renderer-canvas',
    '@geometra/renderer-terminal',
    '@geometra/renderer-webgpu',
    '@geometra/renderer-pdf',
    '@geometra/renderer-three',
    '@geometra/server',
    '@geometra/client',
    '@geometra/ui',
    '@geometra/router',
    '@geometra/tw',
    '@geometra/agent',
    '@geometra/gateway',
    '@geometra/evidence',
    '@geometra/cli',
  ]) {
    addDependency(packageName, '@geometra/core', `^${version}`)
  }

  addDependency('@geometra/renderer-three', '@geometra/client', `^${version}`)
  addDependency('@geometra/renderer-three', '@geometra/renderer-canvas', `^${version}`)
  addDependency('@geometra/tw', 'textura', `^${version}`)
  addDependency('@geometra/agent', '@geometra/server', `^${version}`)
  addDependency('@geometra/agent', '@geometra/ui', `^${version}`)
  addDependency('@geometra/cli', '@geometra/renderer-terminal', `^${version}`)
  addDependency('@geometra/cli', 'textura', `^${version}`)
  addDependency('@geometra/mcp', '@geometra/proxy', `^${version}`)

  return [...updatesByName.values()]
}
