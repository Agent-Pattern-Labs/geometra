# Release notes — 1.62.3 (MCP block handling and browser-mode controls)

1.62.3 tightens the MCP/proxy browser control surface without changing the default headless workflow:

- **`@geometra/mcp`** adds `browserMode: "stock" | "cloakbrowser"` on proxy-backed entry points. `stock` forces Playwright Chromium and `cloakbrowser` explicitly opts into CloakBrowser for authorized testing. Contradictory `browserMode` / `stealth` combinations now fail fast with a clear error.
- **`@geometra/mcp`** adds blocked-page handling controls: `blockDetection` (default true), `blockedSitePolicy: "continue" | "manual-handoff" | "error"`, and `manualHandoff`. `geometra_connect` and `geometra_page_model` now surface structured `blockedSite` metadata for CAPTCHA, Cloudflare-style challenge, access-denied, unsupported-browser, automation-block, and rate-limit pages.
- **`@geometra/proxy`** keeps headless stock Chromium as the default and removes nonessential default launch flags that changed automation/web-security behavior in stock mode.
- Docs now describe headless defaults, explicit authorized browser modes, and manual-handoff handling for blocked/challenge pages.

## Migration notes

- Existing `stealth: true` and `stealth: false` callers continue to work.
- Prefer `browserMode: "stock"` when you need to force stock Chromium regardless of environment defaults.
- Prefer `blockedSitePolicy: "manual-handoff"` when an agent should pause with visible-browser retry guidance instead of continuing through a detected challenge page.

## Verification

- [x] `npx vitest run mcp/src/__tests__/session-model.test.ts mcp/src/__tests__/server-batch-results.test.ts mcp/src/__tests__/connect-utils.test.ts mcp/src/__tests__/proxy-session-recovery.test.ts --config vitest.fast.config.ts`
- [x] `cd mcp && npm run check`
- [x] `npm run check -w @geometra/proxy`
- [x] `npm run build -w @geometra/proxy`
- [x] `cd mcp && npm run build`
- [x] `npm run release:gate`
- [x] `git diff --check`
