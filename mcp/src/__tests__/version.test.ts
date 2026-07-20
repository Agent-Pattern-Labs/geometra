import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it } from 'vitest'
import { createServer } from '../server.ts'
import { GEOMETRA_MCP_VERSION, SERVER_IMPLEMENTATION } from '../version.ts'

describe('MCP server implementation metadata', () => {
  it('uses the package version and exposes immutable SDK metadata', async () => {
    const packageUrl = new URL('../../package.json', import.meta.url)
    const manifest = JSON.parse(await readFile(fileURLToPath(packageUrl), 'utf8')) as {
      name?: unknown
      version?: unknown
    }

    expect(manifest.name).toBe('@geometra/mcp')
    expect(GEOMETRA_MCP_VERSION).toBe(manifest.version)
    expect(SERVER_IMPLEMENTATION).toEqual({
      name: 'geometra',
      version: manifest.version,
    })
    expect(Object.isFrozen(SERVER_IMPLEMENTATION)).toBe(true)
  })

  it('advertises that package version in the MCP initialization handshake', async () => {
    const server = createServer()
    const client = new Client({ name: 'geometra-version-test', version: '0.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()

    try {
      await server.connect(serverTransport)
      await client.connect(clientTransport)

      expect(client.getServerVersion()).toEqual(SERVER_IMPLEMENTATION)
    } finally {
      await client.close()
      await server.close()
    }
  })
})
