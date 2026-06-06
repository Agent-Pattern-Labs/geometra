import type {
  AgentGatewayActionStatus,
  AgentGatewayReplay,
  AgentGatewayReplayAction,
  AgentTraceEvent,
} from '@geometra/core'

export const GEOMETRA_EVIDENCE_SCHEMA = 'https://geometra.dev/schemas/evidence-packet/v1'
export const GEOMETRA_EVIDENCE_VERSION = 1
export const GEOMETRA_EVIDENCE_CANONICALIZATION = 'GEOMETRA-CANONICAL-JSON-v1'

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonObject | JsonArray
export interface JsonObject {
  [key: string]: JsonValue
}
export type JsonArray = JsonValue[]

export interface EvidenceSource {
  type: 'geometra.gateway.replay'
  producer: string
  replaySessionId: string
  geometraVersion?: string
  route?: string
}

export interface EvidenceActionSummary {
  id: string
  actionId: string
  status: AgentGatewayActionStatus
  requestedAt: string
  completedAt?: string
  frameBeforeId?: string
  frameAfterId?: string
  policy?: {
    allow: boolean
    requiresApproval?: boolean
    reason?: string
  }
  approval?: {
    approved: boolean
    actor?: string
    timestamp: string
  }
}

export interface EvidencePacketSummary {
  frameCount: number
  actionCount: number
  traceEventCount: number
  completedActionCount: number
  failedActionCount: number
  deniedActionCount: number
  pendingApprovalCount: number
  routes: string[]
  actionIds: string[]
  actionStatuses: Record<string, number>
  actions: EvidenceActionSummary[]
}

export interface EvidenceIntegrity {
  canonicalization: typeof GEOMETRA_EVIDENCE_CANONICALIZATION
  replaySha256: string
  traceSha256: string
  framesSha256: string
  actionsSha256: string
}

export interface EvidenceSignature {
  alg: string
  kid: string
  canonicalization: typeof GEOMETRA_EVIDENCE_CANONICALIZATION
  signedAt: string
  sig: string
}

export interface EvidencePacket {
  schema: typeof GEOMETRA_EVIDENCE_SCHEMA
  version: typeof GEOMETRA_EVIDENCE_VERSION
  packetId: string
  sessionId: string
  createdAt: string
  source: EvidenceSource
  summary: EvidencePacketSummary
  replay: AgentGatewayReplay
  integrity: EvidenceIntegrity
  signature?: EvidenceSignature
  metadata?: JsonObject
}

export interface CreateEvidencePacketOptions {
  packetId?: string
  createdAt?: string
  producer?: string
  geometraVersion?: string
  metadata?: JsonObject
  redact?: EvidenceRedactionOptions
}

export interface EvidenceIssue {
  severity: 'error' | 'warn'
  code: string
  message: string
  path?: string
}

export interface EvidenceValidationResult {
  ok: boolean
  packetId?: string
  errors: number
  warnings: number
  issues: EvidenceIssue[]
  hashes?: EvidenceIntegrity
}

export interface EvidenceVerificationResult extends EvidenceValidationResult {
  integrityOk: boolean
  signatureOk: boolean | null
  packetSha256?: string
}

export interface EvidenceSigner {
  alg: string
  kid: string
  sign(payload: Uint8Array): Promise<Uint8Array | string> | Uint8Array | string
}

export interface EvidenceVerifier {
  alg?: string
  kid?: string
  verify(payload: Uint8Array, signature: Uint8Array, packet: EvidencePacket): Promise<boolean> | boolean
}

export interface SignEvidencePacketOptions {
  signedAt?: string
}

export interface VerifyEvidencePacketOptions {
  verifier?: EvidenceVerifier
}

export interface EvidenceRedactionContext {
  path: string
  key?: string
}

export interface EvidenceRedactionOptions {
  replacement?: JsonValue
  keyPattern?: RegExp
  keys?: string[]
  paths?: string[]
  maxStringLength?: number
  redactor?: (value: JsonValue, context: EvidenceRedactionContext) => JsonValue
}

export interface EvidenceOtelSpan {
  traceId: string
  spanId: string
  parentSpanId?: string
  name: string
  kind: 'INTERNAL'
  startTimeUnixNano?: string
  endTimeUnixNano?: string
  attributes: Record<string, string | number | boolean>
}

export interface ExportEvidenceToOtelOptions {
  traceId?: string
}

export interface GeometraEvidenceReceiptFile {
  path: string
  content: string
  kind: 'geometra-replay' | 'proof' | 'verdict'
  contentType: 'application/json'
}

export interface GeometraEvidenceReceiptInput {
  subject: 'geometra:evidence'
  runId: string
  events: Array<{
    id: string
    type: string
    at: string
    data: JsonObject
  }>
  geometraReplay: GeometraEvidenceReceiptFile[]
  proof: JsonObject
  verdict: JsonObject
  extensions: {
    geometraEvidence: JsonObject
  }
}

export type ReplayHashInput = Pick<AgentGatewayReplay, 'trace' | 'frames' | 'actions'>
export type ReplayActionLike = AgentGatewayReplayAction
export type TraceEventLike = AgentTraceEvent
