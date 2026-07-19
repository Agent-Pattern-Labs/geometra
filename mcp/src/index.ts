#!/usr/bin/env node

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createServer } from './server.js'
import { shutdownAllSessionsAndProxies } from './session.js'
import { shutdownSessionLifecycleRegistry } from './session-state.js'

let cleanedUp = false

function cleanupActiveSession() {
  if (cleanedUp) return
  cleanedUp = true
  try {
    shutdownAllSessionsAndProxies()
  } catch {
    /* ignore */
  }
  try {
    shutdownSessionLifecycleRegistry()
  } catch {
    /* ignore */
  }
}

async function main() {
  const server = createServer()
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

process.on('SIGINT', () => {
  cleanupActiveSession()
  process.exit(0)
})

process.on('SIGTERM', () => {
  cleanupActiveSession()
  process.exit(0)
})

process.on('SIGHUP', () => {
  cleanupActiveSession()
  process.exit(0)
})

process.on('exit', cleanupActiveSession)

main().catch((err) => {
  cleanupActiveSession()
  console.error('geometra-mcp: failed to start', err)
  process.exit(1)
})
