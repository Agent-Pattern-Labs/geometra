# Release notes — 1.62.1 (Playwright browser cache recovery)

## Summary

1.62.1 hardens the MCP browser proxy against Playwright browser-cache skew:

- **`@geometra/proxy`** now retries stock Chromium launch once after installing the browser revision required by the resolved local Playwright package. This covers shared-cache states where another Playwright version pruned the expected `chromium_headless_shell` revision.
- **`@geometra/mcp`** now treats managed child-process proxy startup as ready only after the structured ready signal, which is emitted after browser launch and initial page readiness.
- Added `npm run browsers:install` as a local-version-safe repair command for the Playwright Chromium cache.

## Migration notes

No API or protocol changes. GEOM v1 stays compatible.

Operators can disable automatic browser repair with:

```bash
GEOMETRA_PROXY_AUTO_INSTALL_BROWSERS=0
```

If browser downloads are disabled via `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`, Geometra will not auto-install Chromium and will surface the explicit local install command instead.

## Performance notes

- Normal proxy startup is unchanged when the expected browser revision already exists.
- The retry path only runs after Playwright reports a missing Chromium executable.
- No hit-test, text metrics, layout, or geometry-diff behavior changed.

## Verification

- [x] `npm run check -w @geometra/proxy`
- [x] `npm run mcp:check`
- [x] `npx vitest run mcp/src/__tests__/connect-utils.test.ts mcp/src/__tests__/proxy-session-recovery.test.ts`
- [x] `npm run build -w @geometra/proxy`
- [x] `npm run mcp:build`
- [x] Stock proxy smoke through `launchProxyRuntime({ stealth: false })`
