# Geometra

**The geometry protocol for UI.** Server-computed `{ x, y, w, h }` — not component descriptions — streamed to humans and AI agents over the same socket.

> **AI Agents:** See [`llms.txt`](llms.txt) for a structured overview of the entire framework — architecture, props, components, protocols, and APIs.
> **Agent-native apps:** See [`AGENT_NATIVE_UI.md`](AGENT_NATIVE_UI.md) for exact semantic geometry, stable UI ids, runtime commands, gateway inspect/actions, trace, and replay.

**[Live Demo](https://geometra.razroo.com)** | **[npm](https://www.npmjs.com/org/geometra)** | **[GitHub](https://github.com/razroo/geometra)** | **[Auth](https://github.com/razroo/geometra-auth)** | **[Token Registry](https://github.com/razroo/geometra-token-registry)**

https://github.com/user-attachments/assets/1610d856-3c7d-4fce-be42-1c43306e6520

## MCP Server — AI UI Automation

Geometra ships with [`@geometra/mcp`](mcp/README.md), an MCP server for AI agents that can:

- connect directly to native Geometra apps over the geometry protocol
- open and drive normal websites through `@geometra/proxy`
- fill long forms semantically with `geometra_fill_fields`
- query, wait on, and verify UI state without screenshots or vision models
- start lower-turn flows by inlining `pageModel` or `formSchema` directly in `geometra_connect`

Use Geometra MCP as the default interface when an LLM needs to explore, read, and act on a UI with lower token pressure than snapshot-heavy browser tooling. Keep Playwright-style tooling for deterministic scripted tests, exact low-level control, and site-specific fallback cases.

### Geometra MCP vs Playwright MCP

Playwright MCP gives an agent raw browser automation primitives — click coordinates, fill selectors, evaluate JavaScript. The agent must orchestrate every low-level step. Geometra MCP wraps the same Chromium engine (via `@geometra/proxy`) but adds a **semantic layer purpose-built for LLM agents**, making it faster, cheaper, and more resilient for real-world workflows like filling job applications.

| Concern | Playwright MCP | Geometra MCP |
|---|---|---|
| **Form discovery** | Agent must query DOM or a11y tree, then map fields manually | `geometra_form_schema` returns all fields with stable IDs and labels in one call |
| **Form filling** | One click + type per field — 20 fields = 20+ tool calls | `geometra_fill_form` fills an entire form by label or ID in a single call |
| **Custom dropdowns** | Agent writes bespoke click sequences per site (Workday, Greenhouse, Lever all differ) | `geometra_pick_listbox_option` handles custom comboboxes with keyboard fallback |
| **File uploads** | Agent must locate the input, trigger the chooser, handle dialogs | `geometra_upload_files` auto-detects strategy: label match, hidden input, native chooser, or synthetic drop |
| **Page understanding** | Agent receives raw DOM or screenshots — expensive to parse | `geometra_page_model` returns a structured summary (forms, landmarks, dialogs, actions) |
| **Token cost** | Full DOM snapshots or base64 screenshots burn thousands of tokens | Compact geometry JSON — viewport-visible nodes only, minified by default |
| **Waiting** | `page.waitForSelector` with CSS selectors the agent must guess | `geometra_wait_for` uses semantic conditions (role, state, text content) |
| **Batch actions** | Each action is a separate tool roundtrip | `geometra_run_actions` executes multi-step workflows in one call |
| **Value aliasing** | Exact string match only — "US" won't match "United States" | Built-in aliases: "US" ↔ "USA", "Yes" ↔ "Agree" ↔ "Accept", city abbreviations (NYC → New York) |
| **Resume parsing** | Agent must poll or guess when parsing completes | `geometra_wait_for_resume_parse` handles the "Parsing..." spinner pattern directly |

**When to use Geometra MCP:** Any time an LLM agent needs to interact with a UI — filling forms, navigating workflows, reading page state. The semantic tools reduce round-trips, cut token costs, and handle the messy inconsistencies of real-world sites.

**When to stick with Playwright MCP:** Deterministic scripted test suites, pixel-level assertions, or cases requiring direct JavaScript evaluation in the page context.

### Install

<details>
<summary>Claude Code</summary>

**One-line install:**
```bash
claude mcp add geometra -- npx -y @geometra/mcp
```

**Uninstall:**
```bash
claude mcp remove geometra
```

Or manually add to `.mcp.json` (project-level) or `~/.claude/settings.json` (global):
```json
{
  "mcpServers": {
    "geometra": {
      "command": "npx",
      "args": ["-y", "@geometra/mcp"]
    }
  }
}
```

To uninstall manually, remove the `geometra` entry from the config file.

</details>

<details>
<summary>Claude Desktop</summary>

Add to your Claude Desktop MCP config:

```json
{
  "mcpServers": {
    "geometra": {
      "command": "npx",
      "args": ["-y", "@geometra/mcp"]
    }
  }
}
```

To uninstall, remove the `geometra` entry from the config file.

</details>

<details>
<summary>OpenAI Codex</summary>

Add to your Codex MCP configuration:

```json
{
  "mcpServers": {
    "geometra": {
      "command": "npx",
      "args": ["-y", "@geometra/mcp"]
    }
  }
}
```

To uninstall, remove the `geometra` entry from the config file.

</details>

<details>
<summary>Cursor</summary>

Open Settings → MCP → Add new MCP server, or add to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "geometra": {
      "command": "npx",
      "args": ["-y", "@geometra/mcp"]
    }
  }
}
```

To uninstall, remove the entry from MCP settings.

</details>

<details>
<summary>Windsurf</summary>

Add to `~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "geometra": {
      "command": "npx",
      "args": ["-y", "@geometra/mcp"]
    }
  }
}
```

To uninstall, remove the entry from the config file.

</details>

<details>
<summary>VS Code / Copilot</summary>

**One-line install:**
```bash
code --add-mcp '{"name":"geometra","command":"npx","args":["-y","@geometra/mcp"]}'
```

Or add to `.vscode/mcp.json`:
```json
{
  "servers": {
    "geometra": {
      "command": "npx",
      "args": ["-y", "@geometra/mcp"]
    }
  }
}
```

To uninstall, remove the entry from MCP settings or delete the server from the MCP panel.

</details>

<details>
<summary>Other MCP clients</summary>

Any MCP client that supports stdio transport can use Geometra. The server config is:

```json
{
  "command": "npx",
  "args": ["-y", "@geometra/mcp"]
}
```

To uninstall, remove the server entry from your client's MCP configuration.

</details>

See [mcp/README.md](mcp/README.md) for tool details, examples, and source installs from this repo.

## Agent-Native UI Protocol

Geometra can make the UI itself the agent contract: exact semantic geometry, stable UI ids, action policy, before/after replay, and postcondition checks from the same tree that renders to humans.

| Browser automation | Geometra-native UI |
|---|---|
| Infer state from DOM, screenshots, selectors, or OCR | Inspect `semantic.id`, role/name/state, exact bounds, and action contracts directly |
| Click guessed selectors or coordinates | Click/focus/type by stable UI id |
| Audit backend calls separately from what was visible | Replay frame-before/frame-after geometry plus action trace |
| Add policy and approval as extra app logic | Carry risk, confirmation, input/output schemas, and postconditions with the UI action |

Run the end-to-end external-agent flow:

```bash
bun run demo:agent-native:http
```

It starts a local gateway, calls `/inspect`, requests and approves `approve-payout`, reads `/replay`, and writes `examples/replays/claims-review.json`.

The hosted demo build includes the agent-native claims page at `/agent-native-ops/` and a visual audit packet viewer at `/replay-viewer/`.

For the vertical wedge, see [`CLAIMS_COMPLIANCE_WORKSTATIONS.md`](CLAIMS_COMPLIANCE_WORKSTATIONS.md). To scaffold the same pattern, run:

```bash
bun run create:app -- ./claims-workstation --template agent-workstation
```

## Agent-native roadmap

The next layer is explicit agent contracts on top of geometry: stable action ids, risk classes, policy gates, traces, and replay. Start with:

- [Agent-native protocol](AGENT_NATIVE_PROTOCOL.md)
- [Agent contracts](AGENT_CONTRACTS.md)
- [Agent benchmark suite](AGENT_BENCHMARK_SUITE.md)
- [Agent gateway](AGENT_GATEWAY.md)
- [Security model](AGENT_SECURITY_MODEL.md)
- [Devtools and replay](AGENT_DEVTOOLS_REPLAY.md)
- [Business value](BUSINESS_VALUE.md)

Try the enterprise workflow demo with `bun run --filter @geometra/demo-agent-native-ops dev`, or run the deterministic value harness with `bun run benchmark:agent-native:assert`.

The first runtime slice is available through `createAgentGateway()` in `@geometra/core` and the HTTP/tool transport in `@geometra/gateway`: frame-bound action catalogs, tenant-scoped API keys, approvals, redaction, replay persistence, and MCP-style gateway tools.

## Why geometry, not components?

Other agent-to-UI systems (json-render, A2UI, computer-use agents) send **component descriptions** or scrape rendered output. The agent still has to interpret what it sees. Geometra sends **pixel-exact geometry** — every element's position and size, computed on the server, streamed as flat JSON. Nothing to interpret. Nothing to scrape.

This matters for three audiences:

### AI agents
Agents connect to the same WebSocket as human clients. They get `{ x, y, w, h }` geometry + semantic metadata — no browser, no headless Chrome, no vision model. Interaction uses the same `event`/`key` messages the renderer sends. JSON speed, not browser speed.

### Ultra-constrained clients
A Raspberry Pi, kiosk, or ESP32 with a display can be a Geometra client. The thin client (~2KB) receives pre-computed coordinates and paints them. Zero layout work on the client.

### Deterministic testing
Layout output is JSON. Assert on `{ x, y, w, h }` directly — no screenshot diffs, no Playwright, no headless browser in CI. Milliseconds, not seconds.

### Architecture at a glance

- **Server-computed** — clients never pay layout cost, just paint pre-computed coordinates
- **WASM layout** — Yoga flexbox runs at near-native speed
- **Geometry diffs** — updates send only changed `{ x, y, w, h }`, not full re-renders
- **No DOM** — zero style recalculation, zero reflow, zero composite
- **No framework runtime on client** — the thin client is a paint loop, not a reconciler
- **Multi-instance** — run multiple server/client pairs in a single process for parallel AI workloads

### "Server is client" — what does that actually mean?

If you come from a backend/API background, this phrasing can be confusing. **Geometra does not replace your REST or GraphQL API.** Your business logic, data layer, and API endpoints stay exactly where they are.

Here, "server" and "client" refer to the **rendering pipeline**, not the API layer:

```
Traditional web app:
  API Server (business logic) → Browser (layout + paint)

Geometra:
  API Server (business logic) → Geometra Server (layout computation) → Thin Client (paint only)
                                       ↑
                               AI agents connect here too
```

The **Geometra server** is a layout computation process. It takes your UI tree, runs Yoga WASM flexbox, and outputs pure geometry (`{ x, y, width, height }`). The **thin client** receives that geometry over WebSocket and paints it — no layout engine, no DOM, just pixels.

The key insight: because layout output is just JSON coordinates, an AI agent can consume it directly — same protocol, no browser needed. And because either side can run the layout engine, you can compute layout on the client (local mode) or server (streamed mode) using the same code.

Your app still calls your API for data. Geometra handles what happens *after* you have the data: turning it into pixels.

### Agents and renderers are the same class of client

In a traditional web stack, an AI agent and a human user interact with fundamentally different interfaces. The human gets pixels; the agent scrapes DOM, parses accessibility trees, or interprets screenshots. They are different classes of client.

In Geometra, both consume the same WebSocket stream of `{ x, y, width, height }` geometry plus semantic metadata. The `@geometra/client` (~2KB paint loop) is just one consumer of that stream. An AI agent is another — same protocol, same data, no translation layer. This isn't a bolted-on "AI mode"; it's a consequence of the architecture. When layout output is structured data over a socket, every consumer is a thin client.

```
Traditional:
  Server → HTML/CSS/JS → Browser renders pixels → Human sees UI
  Server → HTML/CSS/JS → Headless browser → Scraper → Agent sees DOM

Geometra:
  Server → JSON geometry stream → Canvas renderer → Human sees UI
  Server → JSON geometry stream → Agent reads JSON directly
                                  ↑ same socket, same data
```

This means agents can observe UI state, interact with elements (via the same `event`/`key`/`composition` messages the client sends), and verify outcomes — all at JSON speed, not browser speed.

### Why this replaces browser automation (Playwright, Puppeteer, etc.)

Browser automation tools solve a specific problem: programmatically controlling a system (the browser) that was designed for humans. They launch a real browser, wait for layout/paint, query the DOM, simulate clicks, and assert on rendered state. This is expensive, flaky, and slow — because the browser was never designed to be an API.

Geometra eliminates the need for this entire category of tooling:

| Concern | Playwright approach | Geometra approach |
|---|---|---|
| **Observe UI state** | Query DOM or accessibility tree from headless browser | Read geometry JSON directly from WebSocket |
| **Interact with elements** | Simulate mouse/keyboard events through browser APIs | Send `event`/`key` messages on the same WebSocket |
| **Assert on layout** | Screenshot comparison or DOM assertions | JSON snapshot: `expect(layout).toMatchSnapshot()` |
| **Test in CI** | Headless Chromium (~200MB) + browser launch overhead | Yoga WASM (~200KB) + geometry assertions in-process |
| **Speed** | Seconds per test (browser startup + rendering + waiting) | Milliseconds (JSON in, JSON out, no browser) |

This doesn't mean Playwright is useless in general — it's still the right tool for testing DOM-based apps. But for Geometra apps, the entire concept of "browser automation" is a solved problem at the protocol level. The geometry stream *is* the test interface.

See `GEOMETRY_SNAPSHOT_TESTING.md` for CI patterns using layout JSON assertions.

### How this compares to agent-to-UI approaches

Most agent-to-UI systems — json-render (Vercel), A2UI (Google), computer-use agents, accessibility-tree scrapers — share the same fundamental constraint: they send **component descriptions** or scrape rendered output, so the agent still needs a translation layer. Geometra sends **pixel-exact geometry**. The distinction matters:

These approaches typically:
1. **Scrape** — parse DOM, accessibility trees, or screenshots after the browser renders
2. **Interpret** — use vision models or heuristics to map pixels/DOM to semantic meaning
3. **Act** — inject synthetic events through browser automation APIs
4. **Verify** — re-scrape to confirm the action worked

Each step is lossy, slow, and fragile. The agent is reverse-engineering a human interface.

Geometra inverts this. The server already produces structured, semantic data as its *primary output* — not as a retrofit. An agent connecting to a Geometra server gets:

- **Exact geometry** — every element's position and size, no OCR or bounding-box estimation
- **Semantic metadata** — roles, labels, focusable state, from `toAccessibilityTree()` built into the pipeline
- **Interaction parity** — the same `event`/`key`/`resize` messages the human client sends
- **Real-time updates** — geometry diffs stream over WebSocket, no polling or re-scraping

The agent doesn't need to scrape, interpret, or guess. It reads the same structured protocol the renderer reads. This is not "AI-accessible UI" — it's UI that was never inaccessible to machines in the first place.

### Edge and resource-constrained hardware

The traditional web stack assumes a full browser engine on the client: HTML parser, CSS engine, JavaScript runtime, layout engine, compositor. That's hundreds of megabytes before your app loads. This makes serving real web UI on embedded devices, kiosks, IoT dashboards, or edge nodes impractical.

Geometra's pipeline breaks this assumption:

| Component | Size | Runs where |
|---|---|---|
| Yoga WASM (layout engine) | ~200KB | Server or client |
| Thin client (paint loop) | ~2KB | Client |
| Canvas/Terminal renderer | Small, pluggable | Client |
| Layout computation | Zero on client in server-computed mode | Server |

In server-computed mode, the client does *zero layout work*. It receives pre-computed coordinates and paints them. A Raspberry Pi, an ESP32 with a display, or a terminal on a remote server can be a Geometra client.

The JSON-native protocol also opens an interesting door for fine-tuned models. The entire UI lifecycle is JSON manipulation:

- **Tree construction**: generate `box()`/`text()` trees (structured JSON)
- **Layout output**: `{ x, y, width, height }` (flat JSON)
- **Updates**: geometry diffs (JSON patches)
- **Interaction**: `event`/`key` messages (JSON)

A small model fine-tuned on JSON manipulation could drive the entire UI pipeline — generating views, processing updates, handling interaction — without ever touching HTML, CSS, or a browser API. On edge hardware where you can't run a browser but *can* run a quantized model + Yoga WASM, this becomes a viable path to serving real interactive UI.

```
Edge deployment:
  Fine-tuned model (JSON generation) → Geometra server (Yoga WASM layout)
       ↓
  WebSocket geometry stream → Thin client on display hardware
```

This is particularly relevant for:
- **Industrial dashboards** on ARM/RISC-V devices with limited memory
- **Kiosk/signage** where a browser engine is overkill for the interaction model
- **Multi-instance AI workloads** where many UI sessions run server-side and stream to lightweight displays
- **Offline-capable edge nodes** where the model + Yoga WASM run locally without internet

### Benchmark Comparison

| Metric | Geometra | React (DOM) | SSR (Next.js etc.) |
|---|---|---|---|
| Layout engine | Yoga WASM (near-native) | Browser layout (style recalc + reflow) | Server HTML → browser reparse + layout |
| Client runtime | ~2KB paint loop | ~40-100KB+ framework runtime | ~40-100KB+ hydration runtime |
| AI agent access | Direct JSON protocol, no browser | Requires headless browser or scraping | Requires headless browser or scraping |
| Update payload | Geometry diff: `{ x, y, w, h }` | Virtual DOM diff → DOM mutations | Full page or partial HTML |
| Layout computation | Server or client (same code) | Client only | Server (HTML) → client (re-layout) |
| DOM dependency | None | Full DOM API | Full DOM API (hydration) |
| Multi-instance | Multiple server/client pairs in one process | One app per page | One app per request |
| Time to interactive | Instant (geometry is pre-computed) | After hydration + layout | After HTML parse + hydration + layout |

- Dashboard: https://geometra.razroo.com/
- Agent-native claims demo: https://geometra.razroo.com/agent-native-ops/

## How It Works

```
Traditional:  HTML → CSS Parser → DOM → Layout → Paint → Composite
Geometra:     Declarative Tree → Yoga WASM → Computed Geometry → Render Target
```

The framework replaces the entire browser rendering pipeline. Layout is computed via Yoga (Facebook's flexbox engine compiled to WASM). Text is measured via Pretext. The output is pure geometry — `{ x, y, width, height }` — rendered by pluggable backends: Canvas2D, Terminal, or raw geometry for AI agents.

## Packages

| Package | Description |
|---|---|
| `@geometra/core` | Component model, signals, hit-testing, semantic/a11y tree generation, text-input primitives |
| `@geometra/renderer-canvas` | Canvas2D paint backend + selection + optional accessibility mirror |
| `@geometra/renderer-terminal` | ANSI terminal/TUI paint backend |
| `@geometra/renderer-webgpu` | WebGPU renderer scaffold (capability detection + initialization surface) |
| `@geometra/server` | Server-side layout engine with WebSocket geometry streaming (versioned protocol) |
| `@geometra/client` | Thin client that receives pre-computed geometry and paints it (versioned protocol checks) |
| `@geometra/ui` | 31-component UI library: button, input, textarea, checkbox, radio, switch, slider, select, combobox, dialog, sheet, accordion, tabs, card, badge, alert, toast, progress, skeleton, avatar, separator, breadcrumb, pagination, menu, command palette, data table, tree view, list |
| `@geometra/router` | Renderer-agnostic data router: nested routes, loaders/actions, redirects, blockers, lazy/prefetch, protocol-aware navigation |
| `@geometra/tw` | Tailwind-style utility classes — converts class strings like `"flex-row p-4 bg-blue-500"` into Geometra props |
| `@geometra/evidence` | Tamper-evident UI evidence packets for agent replays: redaction, hashes, signatures, OTLP spans, and ISO-style receipts |

Package docs:

- `textura`: `packages/textura` — DOM-free Yoga WASM layout engine
- `@geometra/core`: `packages/core/README.md`
- `@geometra/renderer-canvas`: `packages/renderer-canvas/README.md`
- `@geometra/renderer-terminal`: `packages/renderer-terminal/README.md`
- `@geometra/renderer-webgpu`: `packages/renderer-webgpu/README.md`
- `@geometra/renderer-three`: `packages/renderer-three` — Three.js hosts + scene3d
- `@geometra/server`: `packages/server/README.md`
- `@geometra/client`: `packages/client/README.md`
- `@geometra/ui`: `packages/ui/README.md`
- `@geometra/router`: `packages/router/README.md`
- `@geometra/tw`: `packages/tw` — Tailwind-style utility classes
- `@geometra/evidence`: `packages/evidence/README.md`

## Start Here

If you want a real Geometra app instead of isolated package snippets, start with the official full-stack scaffold. It matches the recommended architecture from the live demo: `@geometra/ui + @geometra/router + @geometra/server/@geometra/client`.

```bash
git clone https://github.com/razroo/geometra.git
cd geometra
npm install
npm run create:app -- ./my-geometra-app
cd my-geometra-app
npm install
npm run server
npm run client
```

Use `npm run create:app -- --list` to see the other templates (`canvas-local`, `server-client`, and `terminal`). The matching reference implementation lives in `demos/full-stack-dashboard`.

## Quick Start

### Phase 1: Local Canvas Rendering

```ts
import { signal, box, text, createApp } from '@geometra/core'
import { CanvasRenderer } from '@geometra/renderer-canvas'

const count = signal(0)

const renderer = new CanvasRenderer({
  canvas: document.getElementById('app') as HTMLCanvasElement,
  background: '#1a1a2e',
})

function view() {
  return box({ flexDirection: 'column', padding: 24, gap: 16 }, [
    text({
      text: `Count: ${count.value}`,
      font: 'bold 24px Inter',
      lineHeight: 32,
      color: '#ffffff',
    }),
    box({
      backgroundColor: '#e94560',
      padding: 12,
      borderRadius: 8,
      onClick: () => count.set(count.peek() + 1),
    }, [
      text({
        text: 'Increment',
        font: '16px Inter',
        lineHeight: 22,
        color: '#ffffff',
      }),
    ]),
  ])
}

await createApp(view, renderer, { width: 400, height: 300 })
```

#### With `@geometra/tw` (Tailwind-style shorthand)

```ts
import { tw } from '@geometra/tw'

// Before:
box({ flexDirection: 'column', padding: 24, gap: 16, backgroundColor: '#1e293b', borderRadius: 8 }, children)

// After:
box(tw("flex-col p-6 gap-4 bg-slate-800 rounded-lg"), children)
```

### Phase 2: Server-Computed Layout

**Server** (Node.js/Bun — no browser needed):

```ts
import { signal, box, text } from '@geometra/core/node'
import { createServer } from '@geometra/server'

const data = signal(['Hello', 'from the server'])

function view() {
  return box({ flexDirection: 'column', padding: 20, gap: 8 },
    data.value.map(msg =>
      box({ backgroundColor: '#16213e', padding: 12, borderRadius: 8 }, [
        text({ text: msg, font: '14px Inter', lineHeight: 20, color: '#fff' }),
      ])
    )
  )
}

const server = await createServer(view, { port: 3100, width: 600, height: 400 })
```

**Client** (thin — just a paint loop):

```ts
import { CanvasRenderer } from '@geometra/renderer-canvas'
import { createClient } from '@geometra/client'

const canvas = document.getElementById('app') as HTMLCanvasElement

createClient({
  url: 'ws://localhost:3100',
  renderer: new CanvasRenderer({ canvas }),
  canvas,
})
```

The client never runs a layout engine. It receives pre-computed `{ x, y, width, height }` geometry over WebSocket and paints it.

### Phase 3: Terminal Rendering

```ts
import { signal, box, text, createApp } from '@geometra/core/node'
import { TerminalRenderer } from '@geometra/renderer-terminal'

const renderer = new TerminalRenderer()

function view() {
  return box({ flexDirection: 'column', padding: 16, gap: 8 }, [
    box({ backgroundColor: '#0a0a2e', padding: 12 }, [
      text({ text: 'GEOMETRA TUI', font: 'bold 20px monospace', lineHeight: 26, color: '#e94560' }),
    ]),
    text({ text: 'Flexbox layout in your terminal.', font: '14px monospace', lineHeight: 18, color: '#aaa' }),
  ])
}

await createApp(view, renderer, { width: 533, height: 320 })
```

## Reactivity

Geometra uses a minimal signals system. When a signal changes, only the affected parts of the tree re-layout and re-render.

```ts
import { signal, computed, effect, batch } from '@geometra/core'

const name = signal('world')
const greeting = computed(() => `Hello, ${name.value}!`)

effect(() => console.log(greeting.value))  // "Hello, world!"

name.set('Geometra')                        // "Hello, Geometra!"

// Batch multiple updates into one flush
batch(() => {
  a.set(1)
  b.set(2)
})
```

## Event Handling

Events are resolved via hit-testing against the computed geometry tree — no DOM event system involved.

```ts
box({
  backgroundColor: '#e94560',
  padding: 16,
  onClick: (e) => console.log(`Clicked at ${e.x}, ${e.y}`),
  onPointerDown: (e) => { /* ... */ },
  onPointerUp: (e) => { /* ... */ },
  onPointerMove: (e) => { /* ... */ },
}, [
  text({ text: 'Click me', font: '16px Inter', lineHeight: 22, color: '#fff' }),
])
```

## Routing Quick Start

Geometra routing is available in `@geometra/router` and is renderer-agnostic.

```ts
import { createRouter, createMemoryHistory, link, matchRouteTree } from '@geometra/router'

const router = createRouter({
  history: createMemoryHistory({ initialEntries: ['/'] }),
  routes: [
    { id: 'home', path: '/' },
    { id: 'users', path: '/users/:id' },
    { id: 'not-found', path: '/*' },
  ],
})

router.start()
await router.navigate('/users/42')
```

For full routing details, see `packages/router/README.md` and `ROUTER_DELIVERY_REPORT.md`.

## Accessibility and Text Input Foundations

Geometra now exposes runtime primitives so non-DOM renderers can still provide accessibility and editing behavior:

- `toAccessibilityTree(tree, layout)` in `@geometra/core` maps UI + geometry to role/name/bounds/focusable nodes.
- `createBrowserCanvasClient(...)` in `@geometra/renderer-canvas` is the official browser host bootstrap for thin-client canvas apps.
- `enableAccessibilityMirror(host, renderer)` in `@geometra/renderer-canvas` syncs a hidden DOM mirror for assistive tech.
- `insertInputText`, `replaceInputSelection`, `backspaceInput`, `deleteInput`, `moveInputCaret` in `@geometra/core` provide selection-aware text editing logic you can wire to keyboard handlers.

### Text-input semantics

- Input state uses `{ nodes, selection }`, where `selection` is `anchor*`/`focus*` node-local offsets.
- Editing helpers normalize reversed selections, replace selected ranges first, then collapse caret at insertion/deletion end.
- `moveInputCaret(state, dir, true)` extends selection from the anchor; without extend it collapses to directional edge first, then moves.
- `Backspace` at node start merges with previous node; `Delete` at node end merges with next node.
- Composition flow should snapshot selection on `onCompositionStart`, update transient draft on `onCompositionUpdate`, and commit text on `onCompositionEnd`.
- `getInputCaretGeometry` only returns non-null for collapsed selections and clamps offsets to measured text bounds.

### Accessibility guarantees and current limitations

Guarantees:

- `toAccessibilityTree(tree, layout)` provides deterministic role/name/bounds/focusable output from the rendered geometry tree.
- Semantic hints (`tag`, `role`, `ariaLabel`, `alt`) are preserved in a11y/SEO projections.
- Common container patterns (main/nav/article/list/form/button/input-like) map to stable roles.

Current limitations:

- Accessibility output is structural and does not implement full platform accessibility APIs by itself.
- Full platform accessibility API parity is not implemented by core alone; canvas apps should integrate `enableAccessibilityMirror` and validate host/browser assistive-tech behavior.
- Text measurement parity across environments still depends on available canvas measurement backends and font availability.
- Terminal keyboard escape-sequence normalization can vary by emulator; keep terminal integration tests in CI for your target environments.

Form semantics examples are available in `FORM_SEMANTICS_EXAMPLES.md`.

## Architecture

```
┌──────────────────────────────────────────────────┐
│                  Application                      │
│  Components → Signals → Layout Trees              │
├──────────────────────────────────────────────────┤
│              @geometra/core                        │
│  box() / text() → toLayoutTree() → computeLayout()│
├──────────────────────────────────────────────────┤
│              textura (layout engine)               │
│  Yoga WASM + Pretext → { x, y, width, height }   │
├───────────┬───────────┬───────────┬──────────────┤
│ Canvas2D  │  Terminal  │  Server   │ Raw Geometry  │
│ Renderer  │  Renderer  │ → Client  │ (AI Agents)   │
└───────────┴───────────┴───────────┴──────────────┘
```

## Protocol (v1)

Client and server exchange JSON messages over WebSocket with optional `protocolVersion`.

- **Server -> Client**
  - `frame`: `{ type: 'frame', layout, tree, protocolVersion?: 1 }`
  - `patch`: `{ type: 'patch', patches, protocolVersion?: 1 }`
  - `error`: `{ type: 'error', message, protocolVersion?: 1 }`
- **Client -> Server**
  - `event`: pointer/click hit-test events (`onClick`, `onPointerDown`, `onPointerUp`, `onPointerMove`)
  - `key`: keyboard events (`onKeyDown`, `onKeyUp`)
  - `composition`: IME events (`onCompositionStart`, `onCompositionUpdate`, `onCompositionEnd`)
  - `resize`: viewport updates (`width`, `height`)

Compatibility notes:

- Unversioned messages are treated as protocol v1.
- If one side receives a **newer** protocol version than it supports, it returns/raises an error instead of silently misbehaving.
- Server layout dimensions can be updated live via `resize`, allowing true server-computed responsive layouts.

See `PROTOCOL_COMPATIBILITY.md` for the explicit compatibility policy and change process.

## Running the Demos

```bash
npm install

# Phase 1: Local canvas rendering
cd demos/local-canvas && npm run dev

# Phase 2: Server-client (run in two terminals)
cd demos/server-client && npm run server   # terminal 1
cd demos/server-client && npm run client   # terminal 2

# Phase 3: Terminal UI
cd demos/terminal && npm run dev

# Text input playground (canvas)
cd demos/text-input-canvas && npm run dev

# Auth + @geometra/token-registry + remoteVerifier (registry + Geometra + Vite in one shell)
npm run demo:auth-registry
```

See `demos/auth-registry-server-client/README.md` for details. Terminal input/focus wiring snippets are in `TERMINAL_INPUT_EXAMPLES.md`.

## Known caveats

- Server-side text measurement in pure Node environments requires an available canvas measurement backend (for example OffscreenCanvas/polyfill paths).
- Terminal key escape sequences can vary by terminal emulator; integration tests include normalized paths for Tab/Shift+Tab/arrows.
- Canvas accessibility parity depends on host/browser support for hidden accessibility mirror strategies.
- Protocol mismatches are rejected explicitly when peer version is newer; keep release notes and protocol docs in sync when changing wire shapes.

Bun equivalents (faster install/startup in many environments):

```bash
bun install
bun run demo:build
bun run test      # default fast suite
bun run test:all  # full suite including slow exhaustive cases
```

## License

MIT
