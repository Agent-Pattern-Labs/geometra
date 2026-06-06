import type { ComputedLayout } from 'textura'
import { describe, expect, it } from 'vitest'
import { agentAction, box, createAgentGateway, text } from '@geometra/core'
import {
  createEvidencePacket,
  exportEvidenceToIsoReceipt,
  exportEvidenceToOtelSpans,
  signEvidencePacket,
  validateEvidencePacket,
  verifyEvidencePacket,
} from '../index.js'
import { sha256Hex } from '../hash.js'

const times = [
  '2026-05-01T12:00:00.000Z',
  '2026-05-01T12:00:01.000Z',
  '2026-05-01T12:00:02.000Z',
  '2026-05-01T12:00:03.000Z',
  '2026-05-01T12:00:04.000Z',
  '2026-05-01T12:00:05.000Z',
  '2026-05-01T12:00:06.000Z',
]

function clock(): () => string {
  let index = 0
  return () => times[Math.min(index++, times.length - 1)]!
}

function layout(): ComputedLayout {
  return {
    x: 0,
    y: 0,
    width: 300,
    height: 160,
    children: [
      { x: 16, y: 16, width: 150, height: 36, children: [] },
      { x: 16, y: 72, width: 180, height: 24, children: [] },
    ],
  }
}

function tree() {
  return box({}, [
    box({
      onClick: () => undefined,
      semantic: agentAction(
        {
          id: 'approve-payout',
          kind: 'approve',
          title: 'Approve payout',
          risk: 'write',
          requiresConfirmation: true,
          postconditions: ['claim status is approved'],
        },
        { role: 'button', ariaLabel: 'Approve payout' },
      ),
    }),
    text({
      text: 'Claim ready',
      font: '14px Inter',
      lineHeight: 20,
      semantic: { id: 'claim-ready', role: 'status' },
    }),
  ])
}

async function replayFixture() {
  const gateway = createAgentGateway({
    sessionId: 'claims-evidence',
    now: clock(),
    execute: ({ request }) => ({ ok: true, reference: 'claim-123', token: request.input }),
    redact: (value, context) => (context.field === 'output' ? { ok: true, reference: 'claim-123' } : value),
  })
  const frame = gateway.setFrame(tree(), layout(), { id: 'frame-before', route: '/claims' })
  const pending = await gateway.requestAction({
    actionId: 'approve-payout',
    frameId: frame.id,
    input: { token: 'secret-token' },
  })
  await gateway.approveAction({ approvalId: pending.approvalId!, actor: 'manager' })
  gateway.setFrame(tree(), layout(), { id: 'frame-after', route: '/claims' })
  return gateway.getReplay()
}

describe('@geometra/evidence', () => {
  it('creates and validates a semantic UI evidence packet from gateway replay', async () => {
    const packet = await createEvidencePacket(await replayFixture(), {
      packetId: 'packet-1',
      createdAt: '2026-05-01T12:01:00.000Z',
      metadata: { environment: 'test' },
    })

    expect(packet.summary).toMatchObject({
      frameCount: 2,
      actionCount: 1,
      traceEventCount: 3,
      completedActionCount: 1,
      routes: ['/claims'],
      actionIds: ['approve-payout'],
    })
    expect(packet.replay.actions[0]?.frameBefore?.geometry.nodes.some(node => node.id === 'approve-payout')).toBe(true)
    await expect(validateEvidencePacket(packet)).resolves.toMatchObject({ ok: true, errors: 0 })
  })

  it('detects evidence replay tampering', async () => {
    const packet = await createEvidencePacket(await replayFixture(), {
      packetId: 'packet-1',
      createdAt: '2026-05-01T12:01:00.000Z',
    })
    packet.replay.actions[0]!.status = 'failed'

    await expect(validateEvidencePacket(packet)).resolves.toMatchObject({
      ok: false,
      issues: expect.arrayContaining([expect.objectContaining({ code: 'hash-mismatch' })]),
    })
  })

  it('redacts configured sensitive keys before hashing', async () => {
    const packet = await createEvidencePacket(await replayFixture(), {
      packetId: 'packet-redacted',
      createdAt: '2026-05-01T12:01:00.000Z',
      redact: { keys: ['token'] },
    })

    expect(packet.replay.actions[0]?.request.input).toEqual({ token: '[redacted]' })
    await expect(validateEvidencePacket(packet)).resolves.toMatchObject({ ok: true })
  })

  it('signs and verifies packets with a pluggable signer', async () => {
    const packet = await createEvidencePacket(await replayFixture(), {
      packetId: 'packet-signed',
      createdAt: '2026-05-01T12:01:00.000Z',
    })
    const signed = await signEvidencePacket(packet, {
      alg: 'TEST-SHA256',
      kid: 'test-key',
      async sign(payload) {
        return new TextEncoder().encode(await sha256Hex(payload))
      },
    }, { signedAt: '2026-05-01T12:02:00.000Z' })

    await expect(
      verifyEvidencePacket(signed, {
        verifier: {
          alg: 'TEST-SHA256',
          kid: 'test-key',
          async verify(payload, signature) {
            return new TextDecoder().decode(signature) === (await sha256Hex(payload))
          },
        },
      }),
    ).resolves.toMatchObject({ ok: true, signatureOk: true, integrityOk: true })
  })

  it('exports OTLP-style spans and ISO receipt input', async () => {
    const packet = await createEvidencePacket(await replayFixture(), {
      packetId: 'packet-export',
      createdAt: '2026-05-01T12:01:00.000Z',
    })
    const spans = await exportEvidenceToOtelSpans(packet)
    const receipt = await exportEvidenceToIsoReceipt(packet)

    expect(spans).toHaveLength(2)
    expect(spans[1]).toMatchObject({
      name: 'geometra.action approve-payout',
      attributes: {
        'geometra.action.status': 'completed',
        'geometra.action.risk': 'write',
      },
    })
    expect(receipt).toMatchObject({
      subject: 'geometra:evidence',
      runId: 'claims-evidence',
      geometraReplay: [{ path: 'geometra/packet-export.evidence.json' }],
      proof: { packetId: 'packet-export' },
      verdict: { ok: true, actionCount: 1 },
    })
  })
})
