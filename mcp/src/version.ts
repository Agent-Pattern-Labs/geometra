import { readFileSync } from 'node:fs'

const MCP_PACKAGE_NAME = '@geometra/mcp'
const SERVER_NAME = 'geometra'
const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

function readPackageVersion(): string {
  const packageUrl = new URL('../package.json', import.meta.url)
  let manifest: unknown
  try {
    manifest = JSON.parse(readFileSync(packageUrl, 'utf8'))
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`Unable to read ${MCP_PACKAGE_NAME} implementation metadata: ${reason}`, { cause: error })
  }

  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error(`${MCP_PACKAGE_NAME} package.json must contain a JSON object`)
  }
  const record = manifest as Record<string, unknown>
  if (record.name !== MCP_PACKAGE_NAME) {
    throw new Error(`${MCP_PACKAGE_NAME} package.json has an unexpected package name`)
  }
  if (typeof record.version !== 'string' || !SEMVER_PATTERN.test(record.version)) {
    throw new Error(`${MCP_PACKAGE_NAME} package.json must contain a valid semantic version`)
  }
  return record.version
}

export const GEOMETRA_MCP_VERSION = readPackageVersion()

/** MCP SDK implementation identity advertised during server initialization. */
export const SERVER_IMPLEMENTATION = Object.freeze({
  name: SERVER_NAME,
  version: GEOMETRA_MCP_VERSION,
})
