import { spawn, type ChildProcess } from 'node:child_process'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { attachRuntimeDrains, waitForSpawnedProxyReady } from '../proxy-spawn.js'

const originalProxyDebug = process.env.GEOMETRA_PROXY_DEBUG

afterEach(() => {
  if (originalProxyDebug === undefined) delete process.env.GEOMETRA_PROXY_DEBUG
  else process.env.GEOMETRA_PROXY_DEBUG = originalProxyDebug
})

function drainFixture() {
  const stdout = new PassThrough({ highWaterMark: 32 })
  const stderr = new PassThrough({ highWaterMark: 32 })
  const child = { stdout, stderr } as Pick<ChildProcess, 'stdout' | 'stderr'>
  return { child, stdout, stderr }
}

async function finishWriting(stream: PassThrough, content: Buffer | string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    stream.once('error', reject)
    stream.end(content, () => resolve())
  })
  await new Promise<void>(resolve => setImmediate(resolve))
}

async function waitForCleanExit(child: ChildProcess, timeoutMs = 5_000): Promise<void> {
  if (child.exitCode !== null) {
    expect(child.exitCode).toBe(0)
    return
  }

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error('timed out waiting for fixture child to exit'))
    }, timeoutMs)
    const onError = (error: Error) => {
      cleanup()
      reject(error)
    }
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup()
      if (code === 0 && signal === null) resolve()
      else reject(new Error(`fixture child exited with code=${code} signal=${signal}`))
    }
    const cleanup = () => {
      clearTimeout(timeout)
      child.off('error', onError)
      child.off('exit', onExit)
    }
    child.on('error', onError)
    child.on('exit', onExit)
  })
}

describe('spawned proxy runtime drains', () => {
  it('continuously consumes post-ready stdout and stderr without forwarding by default', async () => {
    process.env.GEOMETRA_PROXY_DEBUG = '0'
    const { child, stdout, stderr } = drainFixture()
    const forwardStderr = vi.fn()

    attachRuntimeDrains(child, { forwardStderr })
    await Promise.all([
      finishWriting(stdout, Buffer.alloc(256 * 1024, 'o')),
      finishWriting(stderr, Buffer.alloc(256 * 1024, 'e')),
    ])

    expect(stdout.readableFlowing).toBe(true)
    expect(stderr.readableFlowing).toBe(true)
    expect(stdout.readableLength).toBe(0)
    expect(stderr.readableLength).toBe(0)
    expect(forwardStderr).not.toHaveBeenCalled()
  })

  it('forwards debug stderr with exactly one production prefix', async () => {
    process.env.GEOMETRA_PROXY_DEBUG = '1'
    const { child, stdout, stderr } = drainFixture()
    const forwardStderr = vi.fn()

    attachRuntimeDrains(child, { forwardStderr })
    stderr.write('untagged stderr after ready\n')
    await Promise.all([
      finishWriting(stdout, 'stdout after ready\n'),
      finishWriting(stderr, '[geometra-proxy] tagged stderr after ready\n'),
    ])

    expect(forwardStderr.mock.calls).toEqual([
      ['[geometra-proxy] untagged stderr after ready\n'],
      ['[geometra-proxy] tagged stderr after ready\n'],
    ])
    expect(forwardStderr.mock.calls.flat().join('')).not.toContain('stdout after ready')
    expect(forwardStderr.mock.calls.flat().join('')).not.toContain('[geometra-proxy] [geometra-proxy]')
    expect(stdout.readableLength).toBe(0)
    expect(stderr.readableLength).toBe(0)
  })

  it('hands real child pipes from ready parsing to runtime drains before returning', async () => {
    const fixtureSource = String.raw`
      const ready = JSON.stringify({
        type: 'geometra-proxy-ready',
        wsUrl: 'ws://127.0.0.1:43123',
      }) + '\n'
      process.stdout.write(ready, () => {
        setTimeout(() => {
          const stdoutPayload = Buffer.alloc(512 * 1024, 'o')
          const stderrPayload = Buffer.concat([
            Buffer.from('[geometra-proxy] runtime after ready\n'),
            Buffer.alloc(512 * 1024, 'e'),
          ])
          let pending = 2
          const complete = () => {
            pending -= 1
            if (pending === 0) process.exit(0)
          }
          process.stdout.write(stdoutPayload, complete)
          process.stderr.write(stderrPayload, complete)
        }, 50)
      })
    `
    const child = spawn(process.execPath, ['--input-type=commonjs', '--eval', fixtureSource], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let forwardedStderr = ''
    let forwardedBytes = 0

    try {
      const ready = await waitForSpawnedProxyReady(
        child,
        { pageUrl: 'https://example.com', port: 0 },
        'fixture-auth-token-000000000000000000000000',
        {
          readyTimeoutMs: 2_000,
          runtimeDrains: {
            debug: true,
            forwardStderr(text) {
              forwardedBytes += Buffer.byteLength(text)
              if (forwardedStderr.length < 1_024) forwardedStderr += text.slice(0, 1_024)
            },
          },
        },
      )

      expect(ready).toMatchObject({
        child,
        wsUrl: 'ws://127.0.0.1:43123',
        authToken: 'fixture-auth-token-000000000000000000000000',
      })
      await waitForCleanExit(child)

      expect(forwardedBytes).toBeGreaterThanOrEqual(512 * 1024)
      expect(forwardedStderr).toContain('[geometra-proxy] runtime after ready')
      expect(forwardedStderr).not.toContain('[geometra-proxy] [geometra-proxy]')
      expect(child.stdout?.readableLength).toBe(0)
      expect(child.stderr?.readableLength).toBe(0)
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }
  })
})
