# @geometra/proxy

Chromium proxy ( **headless by default** ) that extracts **live DOM layout** (`getBoundingClientRect`) plus a **synthetic Geometra UI tree** and streams **GEOM v1** `frame` / `patch` messages over WebSocket (JSON text). Use it with [`@geometra/mcp`](../../mcp/README.md) to drive arbitrary web apps without screenshots.

## Install

```bash
npm install @geometra/proxy playwright
npx playwright install chromium
# Optional: prefetch CloakBrowser's Chromium for authorized --stealth testing
npx cloakbrowser install
```

## CLI

```bash
export GEOMETRA_PROXY_AUTH_TOKEN="replace-with-a-random-32-character-or-longer-token"
# Optional: approve upload directories (use your platform's path delimiter for multiple roots)
export GEOMETRA_PROXY_FILE_ROOTS="/absolute/path/to/approved-files"
npx geometra-proxy https://example.com --port 3200
npx geometra-proxy http://localhost:8080 --width 1440 --height 900
npx geometra-proxy https://example.com --port 3200 --headed
npx geometra-proxy https://example.com --port 3200 --slow-mo 50
npx geometra-proxy https://example.com --port 3200 --stealth
```

The controller socket binds to `127.0.0.1`, requires the bearer capability,
rejects browser-origin upgrades, and permits one live controller. Keep the
token out of URLs and pass it as `authToken` to `geometra_connect`. Uploads are
disabled unless `GEOMETRA_PROXY_FILE_ROOTS` approves one or more directories;
canonical-path checks reject symlink and sibling-prefix escapes.

**Default is headless** so MCP-driven browsing does not open windows. Use **`--headed`** when you need to watch clicks and typing. **`--slow-mo <ms>`** (or **`GEOMETRA_SLOW_MO`**) adds Playwright `slowMo` to make actions easier to follow.

Use **`--stealth`** (or env **`GEOMETRA_STEALTH=1`** / **`GEOMETRA_BROWSER=stealth`**) to launch CloakBrowser's Chromium through the same Geometra proxy protocol for authorized testing. Stock Playwright Chromium remains the default; pass **`--no-stealth`** to override a stealth env default for one run. CloakBrowser downloads its browser binary on first launch and caches it under `~/.cloakbrowser/`.

The proxy only opens **`http://`** or **`https://`** pages. For debugging you can still choose a fixed `--port`, but `--port 0` asks the OS for an ephemeral free port (useful for tools that auto-spawn the proxy).

Headed vs headless usually does **not** materially change token usage, because token usage comes from MCP response payloads rather than whether Chromium is visible.

## Protocol

Matches `packages/server` GEOM v1 for geometry and advertises proxy-action v2 separately through the initial frame capability handshake.

Proxy-specific client messages (native Textura servers respond with `error`):

- **`file`** — `paths`, optional `x`/`y`, `strategy` (`auto`|`chooser`|`hidden`|`drop`), optional `dropX`/`dropY` for drop targets.
- **`selectOption`** — `{ type: 'selectOption', x, y, value? | label? | index? }` — native `<select>` only.
- **`listboxPick`** — `{ type: 'listboxPick', label, exact?, openX?, openY? }` — ARIA `role=option` (custom dropdowns).
- **`wheel`** — `{ type: 'wheel', deltaY?, deltaX?, x?, y? }` — scroll / wheel at optional coordinates.

Extraction merges **all nested iframes** (including cross-origin) into root viewport coordinates, walks **open shadow roots**, and best-effort **enriches names** from Chrome’s accessibility tree (CDP) for closed shadow / opaque widgets.

Binary framing is not used (always JSON text), which is what the MCP server expects.

## Limitations

- No shadow-DOM piercing; iframes are not flattened.
- Large DOMs produce large frames; patch coalescing follows the same rules as `@geometra/server`.
