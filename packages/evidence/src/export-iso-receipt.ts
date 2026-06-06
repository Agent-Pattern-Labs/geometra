import { canonicalJson, jsonObject } from './json.js'
import { hashEvidencePacket } from './packet.js'
import type { EvidencePacket, GeometraEvidenceReceiptInput, JsonObject } from './schema.js'

export async function exportEvidenceToIsoReceipt(packet: EvidencePacket): Promise<GeometraEvidenceReceiptInput> {
  const packetSha256 = await hashEvidencePacket(packet)
  return {
    subject: 'geometra:evidence',
    runId: packet.sessionId,
    events: packet.replay.trace.events.map(event => ({
      id: event.id,
      type: `geometra.action.${event.status}`,
      at: event.timestamp,
      data: jsonObject(
        {
          actionId: event.actionId,
          status: event.status,
          actor: event.actor,
          message: event.message,
          error: event.error,
        },
        'event.data',
      ),
    })),
    geometraReplay: [
      {
        path: `geometra/${safePath(packet.packetId)}.evidence.json`,
        content: `${canonicalJson(packet)}\n`,
        kind: 'geometra-replay',
        contentType: 'application/json',
      },
    ],
    proof: jsonObject(
      {
        packetId: packet.packetId,
        sessionId: packet.sessionId,
        packetSha256,
        integrity: packet.integrity,
        signature: packet.signature,
      },
      'proof',
    ),
    verdict: jsonObject(
      {
        ok: true,
        frameCount: packet.summary.frameCount,
        actionCount: packet.summary.actionCount,
        completedActionCount: packet.summary.completedActionCount,
        failedActionCount: packet.summary.failedActionCount,
        deniedActionCount: packet.summary.deniedActionCount,
      },
      'verdict',
    ),
    extensions: {
      geometraEvidence: jsonObject(
        {
          schema: packet.schema,
          version: packet.version,
          packetId: packet.packetId,
          packetSha256,
          source: packet.source,
          summary: packet.summary as unknown as JsonObject,
        },
        'extensions.geometraEvidence',
      ),
    },
  }
}

function safePath(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.:-]+/g, '_')
}
