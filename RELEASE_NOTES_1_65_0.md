# Release notes — 1.65.0 (secure and reliable browser automation)

Geometra 1.65.0 is a framework-wide reliability and security release for native Geometra and Geometra MCP browser workflows. It restores native MCP actions, closes the browser-control trust boundary, makes action results evidence-based, and hardens sessions, extraction, retained state, source installs, and release coverage.

## Summary

- Native Geometra and browser-proxy sessions now negotiate geometry and proxy-action protocols independently. An explicit capability handshake keeps native geometry protocol 1 compatible while proxy actions use protocol 2, so a healthy connection can no longer fail on its first action because two different protocols shared one version field.
- Browser control is loopback-only by default and requires a per-runtime capability token. Origin checks, a single authenticated controller, connection limits, upload-root restrictions, and `ws` 8.21.0 close the unauthenticated network-control and memory-exhaustion risks.
- Read-only extraction no longer calls mutating validity APIs. Disabled and readonly controls, unsupported upload targets, inexact text readbacks, unresolved choices, and forms that retain invalid fields now fail honestly instead of reporting success.
- Form submission and final validation stay scoped to the resolved form. Batched fills retain the exact semantic snapshot that proved completion, so a later disconnect or UI mutation cannot erase successful evidence or trigger an unsafe replay.
- Auto-connected browser work is isolated by default. Session routing, warm reuse, disconnect ownership, stale transports, action deadlines, idempotent retries, late acknowledgements, and continuously mutating pages now preserve exact action identity and avoid duplicate mutations.
- Extraction identity and freshness now cover iframe visibility, open shadow controls, CSS-only layout changes, and file-input schema metadata. Native select labels are resolved without nested option text polluting exact control identity.
- Durable MCP state is private, bounded, and redacted by default. State files no longer proliferate per PID, full URLs are not retained, and workflow responses do not return raw filled values.
- Clone-based installs now resolve MCP and proxy from the same workspace and lockfile graph. MCP advertises its package version in the initialization handshake, spawned proxy output is drained after readiness, and local release gates cover those contracts.
- Security dependency refreshes move the proxy to Playwright 1.61, Textura to the patched Pretext 0.0.8 line-breaking engine, and the browser-control server to patched transitive dependency versions. The release manifest now verifies every internal runtime edge and publishes dependencies before their consumers.
- npm publication now stages the complete package set under a release-specific tag before promoting `latest`. Interrupted publishes resume safely without republishing immutable versions or exposing a partially installable release.

## Migration notes

- Upgrade `@geometra/mcp` and `@geometra/proxy` together, then reconnect existing sessions so the split protocol capability handshake is negotiated.
- HTTP(S) auto-connects create isolated browser sessions unless `isolated: false` is passed explicitly. Use that opt-in only for intentional sequential warm reuse, and retain the returned `sessionId` for exact teardown.
- Remote browser-control exposure is no longer implicit. Keep the default loopback binding where possible; custom deployments must provide their authorization and file-root configuration explicitly.
- Action consumers should treat `outcome: "unconfirmed"` as non-retryable until the current UI is inspected. A timeout or lost readback after a mutation is not proof that the mutation did not occur.
- Source contributors should install from the repository root so the committed workspace lockfiles resolve `@geometra/mcp` and `@geometra/proxy` together.
- Playwright users should install the Chromium build bundled with Playwright 1.61 after upgrading (`bun run browsers:install` in a checkout, or `npx --no-install playwright install chromium` for package consumers). Pretext 0.0.8 includes corrected line-breaking behavior, so applications with geometry snapshots should review intentional text-wrap changes.

## Performance notes

- The live baseline and 34-field heavy form benchmarks both finish with `invalidCount: 0` and preserve Geometra's single-turn payload advantage over the Playwright-style comparison.
- Browser-proxy runtime logs are continuously drained after startup without being surfaced unless debug forwarding is enabled, preventing full child-process pipes from stalling automation.
- Layout and renderer performance thresholds remain unchanged.

## Verification

- [x] Full fast suite: 108 files, 2,760 tests
- [x] Release gate: 66 files, 2,405 tests, plus terminal-input integration
- [x] MCP and proxy TypeScript checks, lint, and full workspace build
- [x] Baseline and heavy MCP form-flow benchmarks with `invalidCount: 0`
- [x] Minimal demo HTML, example builds, demo-shell browser smoke, and full-stack browser E2E
- [x] Package tarball/source-install guards and `git diff --check`
- [x] npm and Bun dependency audits with zero known vulnerabilities
- [x] Exact-sha GitHub Quality checks
