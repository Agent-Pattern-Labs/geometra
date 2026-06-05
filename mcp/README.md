# @geometra/mcp

MCP server for [Geometra](https://github.com/razroo/geometra) — interact with running Geometra apps via the geometry protocol over WebSocket. For **native** Geometra apps there is no browser in the loop. For **any existing website**, use **`geometra_connect` with `pageUrl`** — the MCP server starts [`@geometra/proxy`](../packages/proxy/README.md) for you (bundled dependency) so you do not need a separate terminal or a `ws://` URL. You can still pass `url: "ws://…"` if a proxy is already running, and if you accidentally pass `https://…` in `url`, MCP will treat it as `pageUrl` and auto-start the proxy.

See [`AGENT_MODEL.md`](./AGENT_MODEL.md) for the MCP mental model, why token usage can be lower than large browser snapshots, and how headed vs headless proxy mode works.

## What this does

Connects Claude Code, Codex, or any MCP-compatible AI agent to a WebSocket endpoint that streams `frame` / `patch` messages. The agent gets structured `{ x, y, width, height }` geometry and semantic metadata for every UI node — not screenshots, not a vision model.

```
Playwright + vision:  screenshot → model → guess coordinates → click → repeat
Native Geometra:      WebSocket → JSON geometry (no browser on the agent path)
Geometra proxy:       Chromium → DOM geometry → same WebSocket as native → MCP tools unchanged (often started via `pageUrl`, no manual CLI)
```

## When to choose this

Use Geometra MCP when an LLM needs to explore, interpret, and operate a real UI with compact semantic state instead of repeatedly consuming large browser snapshots. Keep Playwright-style tooling for deterministic scripts, DOM-oriented test automation, and compatibility fallback paths while Geometra closes remaining live-site gaps.

Proxy-backed sessions stay warm by default on disconnect, and MCP now keeps a small warm pool so compatible headed, headless, and stealth workflows do not immediately evict each other.

## Tools

| Tool | Description |
|---|---|
| `geometra_connect` | Connect with `url` (ws://…) **or** `pageUrl` (https://…) to auto-start geometra-proxy; pass `browserMode: "stock" | "cloakbrowser"` for explicit authorized testing modes; can inline `formSchema` and/or `pageModel`, or defer the page model for a faster first connect response |
| `geometra_prepare_browser` | Pre-launch and pre-navigate a reusable proxy/browser for `pageUrl` without creating an active session; supports the same headed/headless/stealth browser settings as `geometra_connect` |
| `geometra_query` | Find elements by stable id, role, name, text content, prompt/section/item context, current value, or semantic state such as `invalid`, `required`, or `busy` |
| `geometra_wait_for` | Wait for a semantic condition instead of guessing sleeps (`busy`, `disabled`, alerts, values, etc.). **Strict parameters** — use `text` plus `present: false` to wait until a substring disappears (e.g. “Parsing your resume”); there is no `textGone` field |
| `geometra_wait_for_resume_parse` | Convenience wait until a parsing banner is gone (defaults: `text`: `"Parsing"`, `present` implied false). Same engine as `geometra_wait_for` |
| `geometra_form_schema` | Compact, fill-oriented form schema with stable field ids and collapsed radio/button groups; can auto-connect from `pageUrl` / `url` |
| `geometra_fill_form` | Fill a form from `valuesById` / `valuesByLabel` in one MCP call; can auto-connect from `pageUrl` / `url` for the lowest-token known-form path |
| `geometra_fill_fields` | Fill text/choice/toggle/file fields in one MCP call; text-only batches now use the proxy fast path when step output is omitted, and text/choice/toggle entries can use `fieldId` from `geometra_form_schema` without repeating the label |
| `geometra_run_actions` | Execute a batch of high-level actions in one MCP round trip; can auto-connect from `pageUrl` / `url` and return a final-only payload for the smallest multi-step responses |
| `geometra_page_model` | Summary-first webpage model: archetypes, stable section ids, counts, top-level sections, primary actions, and `blockedSite` metadata for CAPTCHA/challenge/access-denied states |
| `geometra_find_action` | Resolve a repeated button/link by action label plus optional `sectionText`, `promptText`, or `itemText` before clicking |
| `geometra_expand_section` | Expand one form/dialog/list/landmark from `geometra_page_model` on demand, with paging/filtering for long sections |
| `geometra_reveal` | Scroll until a matching node is visible instead of guessing wheel deltas; auto-scales reveal steps for tall forms when omitted |
| `geometra_click` | Click by coordinates or semantic target, including repeated-action disambiguation with `promptText`, `sectionText`, or `itemText`, optionally waiting for a post-click semantic condition |
| `geometra_type` | Type text into the focused element |
| `geometra_key` | Send special keys (Enter, Tab, Escape, arrows) |
| `geometra_upload_files` | Attach files: labeled field / auto / hidden input / native chooser / synthetic drop (`@geometra/proxy` only) |
| `geometra_pick_listbox_option` | Pick an option from a custom dropdown/searchable combobox; can open by field label, falls back to keyboard selection, and returns visible option hints on failure (`@geometra/proxy` only) |
| `geometra_select_option` | Choose an option on a native `<select>` only; use `geometra_pick_listbox_option` for custom dropdowns (`@geometra/proxy` only) |
| `geometra_set_checked` | Set a checkbox or radio by label instead of coordinate clicks (`@geometra/proxy` only) |
| `geometra_wheel` | Mouse wheel / scroll (`@geometra/proxy` only) |
| `geometra_snapshot` | Default **compact**: flat viewport-visible actionable nodes (minified JSON). `view=full` for nested tree, `view=form-required` for required fields including offscreen ones |
| `geometra_layout` | Raw computed geometry for every node |
| `geometra_disconnect` | Close the connection |

### `geometra_wait_for` and loading banners

The tool input is **strict**: unknown keys are rejected (so mistaken names like `textGone` fail fast instead of being ignored). To wait until copy such as “Parsing…” or “Parsing your resume” is **gone**, pass a substring that matches the banner in **`text`** and set **`present`** to **`false`**. Example: `{ "text": "Parsing", "present": false }` (adjust the substring per site).

For the common resume-upload case, prefer **`geometra_wait_for_resume_parse`** (optional `text`, default `"Parsing"`; optional `timeoutMs`, default `60000`) so agents do not have to remember `present: false`.

### Custom dropdowns and searchable comboboxes

Use **`geometra_pick_listbox_option`** for React Select / Radix / Headless UI / custom ATS dropdowns. Prefer **`fieldLabel`** so MCP opens the right combobox semantically, and pass **`query`** when the dropdown is searchable. If click-selection cannot be confirmed, the proxy now falls back to keyboard navigation for editable comboboxes.

When selection fails, the error payload includes a capped **`visibleOptions`** list so an agent can retry with a real label instead of blindly guessing. Use **`geometra_select_option`** only for native HTML `<select>` controls.

### Long forms and offscreen required fields

For tall application forms, **`geometra_snapshot({ view: "form-required" })`** returns required fields even when they are offscreen, with **bounds**, **visibility**, and **scrollHint** data. This is useful for “what required fields are left?” without paging through a full tree.

When a target is below the fold, **`geometra_reveal`** and semantic click actions auto-scale reveal steps when `maxSteps` / `maxRevealSteps` are omitted, so long forms do not fail after a hard-coded short scroll budget. If you already have schema ids, **`geometra_fill_fields`** can now use `fieldId` directly for text / choice / toggle entries without repeating `fieldLabel` / `label`.

## Setup

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

### From source (this repo)

```bash
cd mcp
npm install
npm run build
claude mcp add geometra -- node ./dist/index.js
```

## Usage

### Native Geometra server

```bash
cd demos/server-client
npm run server  # starts on ws://localhost:3100
```

### Any web app (Geometra proxy)

**Preferred path for agents:** call `geometra_connect({ pageUrl: "https://…" })` and let MCP spawn the proxy for you on an ephemeral local port. The manual CLI below is still useful for debugging or when you want to inspect the proxy directly.

In one terminal, serve or open a page (example uses the repo sample):

```bash
cd demos/proxy-mcp-sample
python3 -m http.server 8080
```

In another terminal (from repo root after `npm install` / `bun install` and `bun run build`):

```bash
npx geometra-proxy http://localhost:8080 --port 3200
# Requires Chromium: npx playwright install chromium
# Optional authorized stealth-testing prefetch: npx cloakbrowser install
```

`geometra-proxy` runs **headless by default**. Pass **`--headed`** or **`headless: false`** on MCP tools when you need a visible Chromium window. Pass **`--stealth`**, **`stealth: true`** on MCP tools, or **`GEOMETRA_STEALTH=1`** to use CloakBrowser's Chromium through the same proxy protocol for authorized testing. Optional **`--slow-mo <ms>`** slows Playwright actions so they are easier to watch. Headed vs headless usually does **not** materially change token usage, since token usage is driven by MCP tool output rather than whether Chromium is visible.

For blocked/challenge pages, keep `blockDetection: true` (default). Set `blockedSitePolicy` to `"continue"` (default), `"manual-handoff"` to return retry guidance for a visible user handoff, or `"error"` to stop immediately with structured `blockedSite` details.

Point MCP at `ws://127.0.0.1:3200` instead of a native Geometra server. The proxy translates clicks and keyboard messages into Playwright actions and streams updated geometry.

Then in Claude Code (either backend):

```
> Connect to my Geometra app at ws://localhost:3100 and tell me what's on screen

> Give me the page model first, then expand the main form

> Click the "Submit" button

> Type "hello@example.com" into the email input

> Take a snapshot and check if the dialog is visible
```

## Example: agent testing a signup form (native server)

```
Agent:  geometra_connect({ url: "ws://localhost:3100" })
        → Connected. UI: button "Sign Up", textbox "Email", textbox "Password"

Agent:  geometra_click({ role: "textbox", name: "Email" })
        → Clicked textbox "Email" (n:0) at (250, 220). Email input focused.

Agent:  geometra_type({ text: "test@example.com" })
        → Typed. Email field updated.

Agent:  geometra_click({
          role: "button",
          name: "Sign Up",
          waitFor: { role: "dialog", name: "Success" }
        })
        → Clicked. Success message visible.
```

No screenshots and no vision model in the loop. JSON in, JSON out.

## Example: static HTML via `@geometra/proxy`

With `python3 -m http.server 8080` in `demos/proxy-mcp-sample` and `npx geometra-proxy http://localhost:8080 --port 3200` running:

```
Agent:  geometra_connect({ url: "ws://127.0.0.1:3200" })
        → Connected. UI includes textbox "Email", button "Save", …

Agent:  geometra_form_schema({})
        → {"forms":[{"formId":"fm:1.0","fields":[{"id":"ff:1.0.0","label":"Email"}, ...]}]}

Agent:  geometra_fill_form({
          formId: "fm:1.0",
          valuesByLabel: { "Email": "hello@example.com" },
          failOnInvalid: true
        })
        → {"completed":true,"successCount":1,"errorCount":0,"final":{"invalidCount":0,...}}

Agent:  geometra_query({ role: "button", name: "Save" })
        → Click center to submit the sample form; status text updates in the DOM
```

## How it works

1. The MCP server connects to a WebSocket peer that speaks GEOM v1 (`frame` with `layout` + `tree`, optional `patch` updates).
2. It receives the computed layout (`{ x, y, width, height }` for every node) and the UI tree (`kind`, `semantic`, `props`, `handlers`, `children`).
3. It builds an accessibility tree from that data — roles, names, focusable state, bounds.
4. **`geometra_snapshot`** defaults to a **compact** flat list of viewport-visible actionable nodes (minified JSON) to reduce LLM tokens; use `view: "full"` for the complete nested tree or `view: "form-required"` for offscreen required fields plus scroll hints.
5. **`geometra_form_schema`** is the compact form-specific path: stable field ids, required/invalid state, current values, and collapsed choice groups without layout-heavy section detail. It can auto-connect when you pass `pageUrl` / `url`.
6. **`geometra_fill_form`** turns a compact values object into semantic field operations server-side, so the model does not need to emit one tool call per field. It can also auto-connect, which collapses “open page + fill known values” into a single tool call.
7. **`geometra_fill_fields`** is the lower-level field-intent path when you need direct control; text / choice / toggle entries can now resolve `fieldId` from `geometra_form_schema` without repeating labels.
8. **`geometra_page_model`** is still the right summary-first path for non-form exploration: page archetypes, stable section ids, counts, top-level landmarks/forms/dialogs/lists, and a few primary actions with nearby context.
9. **`geometra_find_action`** is the narrow repeated-action resolver when the page has many identical buttons/links and you want one exact target by `itemText`, `sectionText`, or `promptText`.
10. **`geometra_expand_section`** fetches richer details only for the section you care about (fields, actions, headings, nested lists, list items, text preview).
11. After interactions, action tools return a **semantic delta** when possible (dialogs opened/closed, forms appeared/removed, list counts changed, named/focusable nodes added/removed/updated). If nothing meaningful changed, they fall back to a short current-UI overview.
12. After each interaction, the peer sends updated geometry (full `frame` or `patch`) — the MCP tools interpret that into compact summaries.

## Long Forms

For long application flows, prefer one of these patterns:

1. `geometra_fill_form({ pageUrl, valuesByLabel })` when you already know the fields you want to set
2. otherwise `geometra_form_schema`
3. then `geometra_fill_form`
4. `geometra_snapshot({ view: "form-required" })` when you need the remaining required fields including offscreen ones
5. `geometra_reveal` for far-below-fold targets such as submit buttons (auto-scales reveal steps when you omit `maxSteps`)
6. `geometra_click({ ..., waitFor: ... })` when one action should also wait for the next semantic state
7. `geometra_prepare_browser({ pageUrl, headless, stealth, width, height })` when you can hide browser startup before the real task and want the next proxy-backed flow to attach warm
8. `geometra_run_actions` when you need mixed navigation + waits + field entry, especially with `pageUrl` / `url` for a one-call flow
9. `geometra_connect({ pageUrl, returnPageModel: true })` when you want connect + summary-first exploration in one turn
10. `geometra_connect({ pageUrl, returnPageModel: true, pageModelMode: "deferred" })` when first-response latency matters more than inlining the page model; follow with `geometra_page_model`
11. `geometra_find_action` or `geometra_click({ name, itemText / sectionText / promptText, ... })` when the target action repeats across cards/rows
12. `geometra_page_model` + `geometra_expand_section` when you are still exploring the page rather than filling it

Typical batch:

```json
{
  "actions": [
    { "type": "click", "role": "textbox", "name": "Full name" },
    { "type": "type", "text": "Taylor Applicant" },
    { "type": "upload_files", "paths": ["/Users/you/resume.pdf"], "fieldLabel": "Resume" },
    { "type": "click", "role": "button", "name": "Submit", "waitFor": { "text": "Application submitted", "timeoutMs": 10000 } }
  ]
}
```

Single action tools default to short human-readable summaries (`detail: "minimal"`). Use `detail: "terse"` for the smallest machine-friendly JSON responses, or `detail: "verbose"` when you need a fuller current-UI fallback for debugging.

For the smallest long-form responses, prefer:

1. `detail: "terse"` for compact machine-friendly action responses
2. `includeSteps: false` when you only need aggregate success/error counts plus the final validation/state payload
3. `output: "final"` on `geometra_run_actions` when you only need completion state plus the final semantic signals
4. `geometra_prepare_browser` before the flow when you can shift browser launch out of the user-visible task window

Typical low-token form fill:

```json
{
  "formId": "fm:1.0",
  "valuesById": {
    "ff:1.0.0": "Taylor Applicant",
    "ff:1.0.1": "taylor@example.com",
    "ff:1.0.2": "Germany",
    "ff:1.0.3": "No"
  },
  "failOnInvalid": true,
  "includeSteps": false,
  "detail": "minimal"
}
```

For long single-page forms:

1. Use `geometra_expand_section` with `fieldOffset` / `actionOffset` to page through large forms instead of taking a full snapshot.
2. Add `onlyRequiredFields: true` or `onlyInvalidFields: true` when you want the actionable subset.
3. Use `contextText` in `geometra_query` / `geometra_wait_for` to disambiguate repeated `Yes` / `No` controls by question text.
4. Use `geometra_reveal` instead of manual wheel loops when the next target is offscreen.

Typical field fill:

```json
{
  "fields": [
    { "kind": "text", "fieldLabel": "Full name", "value": "Taylor Applicant" },
    { "kind": "text", "fieldLabel": "Email", "value": "taylor@example.com" },
    { "kind": "choice", "fieldLabel": "Country", "value": "Germany" },
    { "kind": "choice", "fieldLabel": "Will you require sponsorship?", "value": "No" },
    { "kind": "file", "fieldLabel": "Resume", "paths": ["/Users/you/resume.pdf"] }
  ],
  "failOnInvalid": true,
  "detail": "minimal",
  "includeSteps": false
}
```

With a **native** Geometra server, layout comes from Textura/Yoga. With **`@geometra/proxy`**, layout comes from the browser’s computed DOM geometry; the MCP layer is the same.
