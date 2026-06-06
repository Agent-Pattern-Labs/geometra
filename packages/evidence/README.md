# @geometra/evidence

Portable evidence packets for Geometra agent-native UI replay.

`@geometra/evidence` turns `AgentGatewayReplay` records from `@geometra/core`
into verifiable packets that answer what an agent saw, which semantic actions
were available, what policy/approval path ran, and what changed afterward.

```ts
import { createEvidencePacket, signEvidencePacket, verifyEvidencePacket } from '@geometra/evidence'

const replay = gateway.getReplay()
const packet = await createEvidencePacket(replay, {
  packetId: 'claims-run-1',
  redact: { keys: ['token', 'authorization'] },
})

const signed = await signEvidencePacket(packet, signer)
const verified = await verifyEvidencePacket(signed, { verifier })
```

## What A Packet Contains

- Semantic geometry frames from the same tree rendered to humans.
- Stable action ids, risk, titles, bounds, and action contracts.
- Requested, approved, denied, completed, and failed trace events.
- Before/after frame snapshots for replayable review.
- Integrity hashes over replay, trace, frames, and actions.
- Optional detached signature metadata using a pluggable signer.

## Exports

- `exportEvidenceToOtelSpans(packet)` creates lightweight OpenTelemetry-style
  spans for observability backends.
- `exportEvidenceToIsoReceipt(packet)` creates a receipt-input object compatible
  with Agent Pattern Labs ISO receipt conventions.

## Signing

The core signing API is deliberately pluggable:

```ts
const signed = await signEvidencePacket(packet, {
  alg: 'Ed25519',
  kid: 'key-1',
  sign: payload => mySigner(payload),
})
```

For environments with Web Crypto Ed25519 support, the package also exports
`createSubtleEd25519Signer`, `createSubtleEd25519Verifier`, and
`generateSubtleEd25519KeyPair`.
