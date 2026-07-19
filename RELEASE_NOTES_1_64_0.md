# Release notes — 1.64.0 (reliable form automation)

Geometra 1.64.0 hardens field resolution, action contracts, and submission confirmation for ATS and other browser forms. It also adds an optional FormGraph 0.1-compatible projection for discovered form schemas.

## Summary

- Form fields now expose stable authored identities when available, and native select options retain their submitted value, label, disabled state, selected state, and index. Exact values and indexes are honored; ambiguous, stale, duplicate, or disabled choices are rejected instead of guessed.
- MCP action schemas and proxy wire messages are validated strictly. Malformed actions such as `set_checked` without a non-empty `label` fail before browser interaction.
- Submission results now distinguish `submitted`, `validation_failed`, and `unconfirmed`. Geometra scopes validation to the target form and requires fresh semantic or navigation evidence before reporting success.
- React Select and Radix Select interactions use field-scoped verification and recovery, preventing a successful pointer selection from being reopened or overwritten by an unconditional keyboard action.
- `geometra_form_schema` can return FormGraph 0.1-compatible graphs with field paths, source anchors, options, constraints, and review metadata via `includeFormGraph: true`.

## Migration notes

- The MCP/proxy action protocol is now version 2. Upgrade `@geometra/mcp` and `@geometra/proxy` together and reconnect existing proxy sessions. Legacy actions remain accepted, but exact field-identity actions require a version 2 acknowledgement and fail safely against an older proxy.
- `set_checked.label` must be a trimmed, non-empty string. Unknown action keys are rejected rather than ignored.
- Consumers of submit results should handle all three `outcome` values. `completed` is only true when the submission is confirmed.
- FormGraph output is opt-in and does not change the default form-schema response.

## Performance notes

- The changes are confined to form extraction and browser-action paths; layout, rendering, and geometry-diff hot paths are unchanged.
- Existing performance thresholds remain unchanged.

## Verification

- [x] Full fast suite: 98 files, 2,571 tests
- [x] MCP and proxy TypeScript checks
- [x] Radix Select benchmark: 4/4 exact choices
- [x] Greenhouse/react-select benchmark: 13/13 fields filled and verified
- [x] Repository release gate
- [x] `git diff --check`
