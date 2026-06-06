import type { AgentGatewayReplayAction } from '@geometra/core'
import { hashEvidencePacket } from './packet.js'
import type { EvidenceOtelSpan, EvidencePacket, ExportEvidenceToOtelOptions } from './schema.js'
import { sha256Hex } from './hash.js'

export async function exportEvidenceToOtelSpans(
  packet: EvidencePacket,
  options: ExportEvidenceToOtelOptions = {},
): Promise<EvidenceOtelSpan[]> {
  const traceId = options.traceId ?? (await traceIdFor(packet.sessionId))
  const rootSpanId = (await sha256Hex(`geometra:evidence:${packet.packetId}`)).slice(0, 16)
  const packetSha256 = await hashEvidencePacket(packet)
  const root: EvidenceOtelSpan = {
    traceId,
    spanId: rootSpanId,
    name: `geometra.evidence ${packet.sessionId}`,
    kind: 'INTERNAL',
    startTimeUnixNano: isoToUnixNano(packet.replay.startedAt),
    endTimeUnixNano: isoToUnixNano(packet.createdAt),
    attributes: {
      'geometra.evidence.schema': packet.schema,
      'geometra.evidence.version': packet.version,
      'geometra.evidence.packet_id': packet.packetId,
      'geometra.evidence.packet_sha256': packetSha256,
      'geometra.replay.session_id': packet.sessionId,
      'geometra.replay.frame_count': packet.summary.frameCount,
      'geometra.replay.action_count': packet.summary.actionCount,
      'geometra.replay.trace_event_count': packet.summary.traceEventCount,
    },
  }

  const actionSpans = await Promise.all(
    packet.replay.actions.map(action => actionSpan(traceId, rootSpanId, action, packet)),
  )
  return [root, ...actionSpans]
}

async function actionSpan(
  traceId: string,
  rootSpanId: string,
  action: AgentGatewayReplayAction,
  packet: EvidencePacket,
): Promise<EvidenceOtelSpan> {
  const target = action.frameBefore?.actions.find(candidate => candidate.id === action.actionId)
  return {
    traceId,
    parentSpanId: rootSpanId,
    spanId: (await sha256Hex(`geometra:evidence:${packet.packetId}:action:${action.id}`)).slice(0, 16),
    name: `geometra.action ${action.actionId}`,
    kind: 'INTERNAL',
    startTimeUnixNano: isoToUnixNano(action.requestedAt),
    endTimeUnixNano: isoToUnixNano(action.completedAt ?? action.requestedAt),
    attributes: {
      'gen_ai.operation.name': 'execute_tool',
      'geometra.action.id': action.actionId,
      'geometra.action.replay_id': action.id,
      'geometra.action.status': action.status,
      'geometra.action.actor': action.request.actor,
      ...(target ? { 'geometra.action.title': target.title } : {}),
      ...(target ? { 'geometra.action.risk': target.risk } : {}),
      ...(target ? { 'geometra.action.kind': target.kind } : {}),
      ...(action.frameBefore ? { 'geometra.frame.before_id': action.frameBefore.id } : {}),
      ...(action.frameAfter ? { 'geometra.frame.after_id': action.frameAfter.id } : {}),
      ...(action.policy ? { 'geometra.policy.allow': action.policy.allow } : {}),
      ...(action.policy && action.policy.allow && action.policy.requiresApproval !== undefined
        ? { 'geometra.policy.requires_approval': action.policy.requiresApproval }
        : {}),
      ...(action.approval ? { 'geometra.approval.approved': action.approval.approved } : {}),
      ...(action.approval?.actor ? { 'geometra.approval.actor': action.approval.actor } : {}),
    },
  }
}

async function traceIdFor(seed: string): Promise<string> {
  return (await sha256Hex(`geometra:evidence:trace:${seed}`)).slice(0, 32)
}

function isoToUnixNano(value: string | undefined): string | undefined {
  if (!value) return undefined
  const ms = Date.parse(value)
  if (!Number.isFinite(ms)) return undefined
  return String(BigInt(ms) * 1_000_000n)
}
