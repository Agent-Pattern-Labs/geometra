import type {
  AgentGatewayPolicyDecision,
  AgentGatewayReplay,
  AgentGatewayReplayAction,
} from '@geometra/core'
import { cloneJsonObject, jsonObject, toJsonValue } from './json.js'
import { hashJson } from './hash.js'
import { redactJson } from './redact.js'
import {
  GEOMETRA_EVIDENCE_CANONICALIZATION,
  GEOMETRA_EVIDENCE_SCHEMA,
  GEOMETRA_EVIDENCE_VERSION,
  type CreateEvidencePacketOptions,
  type EvidenceActionSummary,
  type EvidenceIntegrity,
  type EvidenceIssue,
  type EvidencePacket,
  type EvidencePacketSummary,
  type EvidenceValidationResult,
  type JsonObject,
} from './schema.js'

export async function createEvidencePacket(
  replay: AgentGatewayReplay,
  options: CreateEvidencePacketOptions = {},
): Promise<EvidencePacket> {
  const createdAt = options.createdAt ?? new Date().toISOString()
  const sourceReplay = options.redact ? redactJson(replay, options.redact) : toJsonValue(replay)
  const replayJson = sourceReplay as unknown as AgentGatewayReplay
  const firstRoute = replayJson.frames.find(frame => frame.route)?.route
  const integrity = await createEvidenceIntegrity(replayJson)

  return {
    schema: GEOMETRA_EVIDENCE_SCHEMA,
    version: GEOMETRA_EVIDENCE_VERSION,
    packetId: options.packetId ?? defaultPacketId(replayJson.sessionId, createdAt),
    sessionId: replayJson.sessionId,
    createdAt,
    source: {
      type: 'geometra.gateway.replay',
      producer: options.producer ?? '@geometra/evidence',
      replaySessionId: replayJson.sessionId,
      ...(options.geometraVersion !== undefined ? { geometraVersion: options.geometraVersion } : {}),
      ...(firstRoute !== undefined ? { route: firstRoute } : {}),
    },
    summary: summarizeReplay(replayJson),
    replay: replayJson,
    integrity,
    ...(options.metadata !== undefined ? { metadata: cloneJsonObject(options.metadata) } : {}),
  }
}

export async function createEvidenceIntegrity(replay: AgentGatewayReplay): Promise<EvidenceIntegrity> {
  return {
    canonicalization: GEOMETRA_EVIDENCE_CANONICALIZATION,
    replaySha256: await hashJson(replay),
    traceSha256: await hashJson(replay.trace),
    framesSha256: await hashJson(replay.frames),
    actionsSha256: await hashJson(replay.actions),
  }
}

export function summarizeReplay(replay: AgentGatewayReplay): EvidencePacketSummary {
  const actionStatuses: Record<string, number> = {}
  for (const action of replay.actions) {
    actionStatuses[action.status] = (actionStatuses[action.status] ?? 0) + 1
  }
  const routes = unique(replay.frames.map(frame => frame.route).filter((route): route is string => route !== undefined))
  const actionIds = unique(replay.actions.map(action => action.actionId))
  return {
    frameCount: replay.frames.length,
    actionCount: replay.actions.length,
    traceEventCount: replay.trace.events.length,
    completedActionCount: replay.actions.filter(action => action.status === 'completed').length,
    failedActionCount: replay.actions.filter(action => action.status === 'failed').length,
    deniedActionCount: replay.actions.filter(action => action.status === 'denied').length,
    pendingApprovalCount: replay.actions.filter(action => action.status === 'awaiting_approval').length,
    routes,
    actionIds,
    actionStatuses,
    actions: replay.actions.map(summarizeAction),
  }
}

export async function validateEvidencePacket(packet: EvidencePacket): Promise<EvidenceValidationResult> {
  const issues: EvidenceIssue[] = []
  if (!packet || typeof packet !== 'object') {
    return resultFromIssues(undefined, issues.concat(error('invalid-packet', 'evidence packet must be an object')))
  }
  if (packet.schema !== GEOMETRA_EVIDENCE_SCHEMA) {
    issues.push(error('invalid-schema', `schema must be ${GEOMETRA_EVIDENCE_SCHEMA}`, '/schema'))
  }
  if (packet.version !== GEOMETRA_EVIDENCE_VERSION) {
    issues.push(error('invalid-version', `version must be ${GEOMETRA_EVIDENCE_VERSION}`, '/version'))
  }
  if (!packet.packetId) issues.push(error('missing-packet-id', 'packetId is required', '/packetId'))
  if (!packet.sessionId) issues.push(error('missing-session-id', 'sessionId is required', '/sessionId'))
  if (packet.replay?.sessionId !== packet.sessionId) {
    issues.push(error('session-mismatch', 'packet sessionId must match replay sessionId', '/replay/sessionId'))
  }
  if (packet.source?.type !== 'geometra.gateway.replay') {
    issues.push(error('invalid-source', 'source type must be geometra.gateway.replay', '/source/type'))
  }
  if (packet.integrity?.canonicalization !== GEOMETRA_EVIDENCE_CANONICALIZATION) {
    issues.push(error('invalid-canonicalization', `canonicalization must be ${GEOMETRA_EVIDENCE_CANONICALIZATION}`, '/integrity/canonicalization'))
  }

  let hashes: EvidenceIntegrity | undefined
  try {
    hashes = await createEvidenceIntegrity(packet.replay)
    compareHash(issues, 'replaySha256', packet.integrity.replaySha256, hashes.replaySha256)
    compareHash(issues, 'traceSha256', packet.integrity.traceSha256, hashes.traceSha256)
    compareHash(issues, 'framesSha256', packet.integrity.framesSha256, hashes.framesSha256)
    compareHash(issues, 'actionsSha256', packet.integrity.actionsSha256, hashes.actionsSha256)
  } catch (hashError) {
    issues.push(error('hash-failed', hashError instanceof Error ? hashError.message : String(hashError), '/integrity'))
  }

  return {
    ...resultFromIssues(packet.packetId, issues),
    ...(hashes !== undefined ? { hashes } : {}),
  }
}

export async function hashEvidencePacket(packet: EvidencePacket): Promise<string> {
  return hashJson(signingPayload(packet))
}

export function signingPayload(packet: EvidencePacket): JsonObject {
  const value = jsonObject(packet, 'packet')
  const signature = value.signature
  if (signature === undefined) return value
  const signatureObject = jsonObject(signature, 'packet.signature')
  if (!Object.hasOwn(signatureObject, 'sig')) return value
  const nextSignature: JsonObject = {}
  for (const [key, child] of Object.entries(signatureObject)) {
    if (key !== 'sig') nextSignature[key] = child
  }
  return { ...value, signature: nextSignature }
}

function summarizeAction(action: AgentGatewayReplayAction): EvidenceActionSummary {
  return {
    id: action.id,
    actionId: action.actionId,
    status: action.status,
    requestedAt: action.requestedAt,
    ...(action.completedAt !== undefined ? { completedAt: action.completedAt } : {}),
    ...(action.frameBefore?.id !== undefined ? { frameBeforeId: action.frameBefore.id } : {}),
    ...(action.frameAfter?.id !== undefined ? { frameAfterId: action.frameAfter.id } : {}),
    ...(action.policy !== undefined ? { policy: summarizePolicy(action.policy) } : {}),
    ...(action.approval !== undefined ? { approval: action.approval } : {}),
  }
}

function summarizePolicy(policy: AgentGatewayPolicyDecision): EvidenceActionSummary['policy'] {
  return {
    allow: policy.allow,
    ...(policy.allow && policy.requiresApproval !== undefined ? { requiresApproval: policy.requiresApproval } : {}),
    ...(policy.reason !== undefined ? { reason: policy.reason } : {}),
  }
}

function compareHash(issues: EvidenceIssue[], field: keyof EvidenceIntegrity, expected: string, actual: string): void {
  if (expected !== actual) {
    issues.push(error('hash-mismatch', `${field} does not match packet content`, `/integrity/${field}`))
  }
}

function resultFromIssues(packetId: string | undefined, issues: EvidenceIssue[]): EvidenceValidationResult {
  const errors = issues.filter(issue => issue.severity === 'error').length
  const warnings = issues.filter(issue => issue.severity === 'warn').length
  return {
    ok: errors === 0,
    ...(packetId !== undefined ? { packetId } : {}),
    errors,
    warnings,
    issues,
  }
}

function error(code: string, message: string, path?: string): EvidenceIssue {
  return { severity: 'error', code, message, ...(path !== undefined ? { path } : {}) }
}

function unique(values: string[]): string[] {
  return [...new Set(values)].sort()
}

function defaultPacketId(sessionId: string, createdAt: string): string {
  const normalizedSession = sessionId.replace(/[^a-zA-Z0-9_.:-]+/g, '_')
  const normalizedCreatedAt = createdAt.replace(/[^0-9TZ.:-]+/g, '')
  return `geopkt:${normalizedSession}:${normalizedCreatedAt}`
}
