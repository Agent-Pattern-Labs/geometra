# Release notes — 1.63.0 (semantic UI evidence packets)

1.63.0 adds `@geometra/evidence`, a new package for turning Geometra agent-native gateway replays into portable, tamper-evident UI evidence packets.

- **`@geometra/evidence`** creates canonical evidence packets from `AgentGatewayReplay` records, including replay summaries, frame/action/trace hashes, source metadata, and deterministic packet ids.
- Evidence packets can be validated after storage or transport to detect replay tampering across full replay, trace, frame, and action payloads.
- The package includes configurable JSON redaction for secrets, tokens, keys, explicit JSON Pointer paths, and long strings before hashing.
- Packets support pluggable signing and verification, plus WebCrypto Ed25519 helpers for native signing workflows.
- Evidence can be exported as lightweight OpenTelemetry-style spans or as an ISO-style receipt input object for compliance and audit pipelines.
- The root build, release gate, publish manifest, package lock, Vitest aliases, and README package index now include `@geometra/evidence`.

## Migration notes

- No breaking changes for existing packages.
- `@geometra/evidence` depends on `@geometra/core` gateway replay types and is published as a separate opt-in package.

## Verification

- [x] `npm run check -w @geometra/evidence`
- [x] `npm run build -w @geometra/evidence`
- [x] `npx vitest run packages/evidence/src/__tests__/evidence.test.ts --config vitest.fast.config.ts`
- [x] `node scripts/release/verify-release-gate.mjs`
- [x] `npm pack --dry-run --json --ignore-scripts` from `packages/evidence`
- [x] `npm run build`
- [x] `npm run release:gate`
- [x] `git diff --check`
