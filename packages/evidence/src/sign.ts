import { canonicalJson } from './json.js'
import { base64UrlToBytes, bytesToBase64Url, sha256Hex, utf8, webCryptoBytes } from './hash.js'
import { signingPayload, validateEvidencePacket } from './packet.js'
import {
  GEOMETRA_EVIDENCE_CANONICALIZATION,
  type EvidenceSignature,
  type EvidencePacket,
  type EvidenceSigner,
  type EvidenceVerifier,
  type EvidenceVerificationResult,
  type SignEvidencePacketOptions,
  type VerifyEvidencePacketOptions,
} from './schema.js'

export async function signEvidencePacket(
  packet: EvidencePacket,
  signer: EvidenceSigner,
  options: SignEvidencePacketOptions = {},
): Promise<EvidencePacket> {
  const signedAt = options.signedAt ?? new Date().toISOString()
  const signatureMetadata: EvidenceSignature = {
    alg: signer.alg,
    kid: signer.kid,
    canonicalization: GEOMETRA_EVIDENCE_CANONICALIZATION,
    signedAt,
    sig: '',
  }
  const packetWithSignatureMetadata: EvidencePacket = {
    ...packet,
    signature: signatureMetadata,
  }
  const payload = evidenceSigningBytes(packetWithSignatureMetadata)
  const signature = await signer.sign(payload)
  return {
    ...packetWithSignatureMetadata,
    signature: {
      ...signatureMetadata,
      sig: typeof signature === 'string' ? signature : bytesToBase64Url(signature),
    },
  }
}

export async function verifyEvidencePacket(
  packet: EvidencePacket,
  options: VerifyEvidencePacketOptions = {},
): Promise<EvidenceVerificationResult> {
  const validation = await validateEvidencePacket(packet)
  const packetSha256 = await hashEvidenceSigningPayload(packet)
  const signature = packet.signature
  if (!signature) {
    return {
      ...validation,
      integrityOk: validation.ok,
      signatureOk: null,
      packetSha256,
    }
  }

  if (!options.verifier) {
    return {
      ...validation,
      ok: false,
      errors: validation.errors + 1,
      issues: validation.issues.concat({
        severity: 'error',
        code: 'missing-verifier',
        message: 'a verifier is required for signed evidence packets',
        path: '/signature',
      }),
      integrityOk: validation.ok,
      signatureOk: false,
      packetSha256,
    }
  }

  const verifier = options.verifier
  if (verifier.alg && verifier.alg !== signature.alg) {
    return signatureFailure(validation, packetSha256, `signature algorithm ${signature.alg} does not match verifier ${verifier.alg}`)
  }
  if (verifier.kid && verifier.kid !== signature.kid) {
    return signatureFailure(validation, packetSha256, `signature key ${signature.kid} does not match verifier ${verifier.kid}`)
  }
  if (signature.canonicalization !== GEOMETRA_EVIDENCE_CANONICALIZATION) {
    return signatureFailure(validation, packetSha256, `signature canonicalization must be ${GEOMETRA_EVIDENCE_CANONICALIZATION}`)
  }

  const signatureOk = await verifier.verify(evidenceSigningBytes(packet), base64UrlToBytes(signature.sig), packet)
  return {
    ...validation,
    ok: validation.ok && signatureOk,
    errors: validation.errors + (signatureOk ? 0 : 1),
    issues: signatureOk
      ? validation.issues
      : validation.issues.concat({
          severity: 'error',
          code: 'invalid-signature',
          message: 'signature verification failed',
          path: '/signature/sig',
        }),
    integrityOk: validation.ok,
    signatureOk,
    packetSha256,
  }
}

export function evidenceSigningBytes(packet: EvidencePacket): Uint8Array {
  return utf8(canonicalJson(signingPayload(packet)))
}

export async function hashEvidenceSigningPayload(packet: EvidencePacket): Promise<string> {
  return sha256Hex(evidenceSigningBytes(packet))
}

export function createSubtleEd25519Signer(key: CryptoKey, options: { kid: string }): EvidenceSigner {
  return {
    alg: 'Ed25519',
    kid: options.kid,
    async sign(payload) {
      return new Uint8Array(await globalSubtle().sign({ name: 'Ed25519' }, key, webCryptoBytes(payload)))
    },
  }
}

export function createSubtleEd25519Verifier(key: CryptoKey, options: { kid?: string } = {}): EvidenceVerifier {
  return {
    alg: 'Ed25519',
    ...(options.kid !== undefined ? { kid: options.kid } : {}),
    async verify(payload, signature) {
      return globalSubtle().verify({ name: 'Ed25519' }, key, webCryptoBytes(signature), webCryptoBytes(payload))
    },
  }
}

export async function generateSubtleEd25519KeyPair(extractable = false): Promise<CryptoKeyPair> {
  return (await globalSubtle().generateKey({ name: 'Ed25519' }, extractable, ['sign', 'verify'])) as CryptoKeyPair
}

function globalSubtle(): SubtleCrypto {
  const crypto = globalThis.crypto
  if (!crypto?.subtle) {
    throw new Error('Web Crypto subtle API is required for Ed25519 evidence signing')
  }
  return crypto.subtle
}

function signatureFailure(
  validation: Awaited<ReturnType<typeof validateEvidencePacket>>,
  packetSha256: string,
  message: string,
): EvidenceVerificationResult {
  return {
    ...validation,
    ok: false,
    errors: validation.errors + 1,
    issues: validation.issues.concat({
      severity: 'error',
      code: 'invalid-signature-metadata',
      message,
      path: '/signature',
    }),
    integrityOk: validation.ok,
    signatureOk: false,
    packetSha256,
  }
}
