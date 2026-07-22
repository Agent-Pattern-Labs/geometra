/**
 * Custom listbox actions can legitimately spend several seconds opening,
 * filtering, selecting, and verifying a reactive control. Keep the MCP
 * listener alive after the proxy's start deadline so extraction and the
 * correlated terminal acknowledgement cannot lose a race at the boundary.
 */
export const LISTBOX_CORRELATED_RESPONSE_TIMEOUT_MS = 15_000
export const LISTBOX_ACK_GRACE_MS = 3_000

/**
 * Semantic text fills can cross several Playwright operations before the
 * proxy can acknowledge them, especially when a caller enables slowMo for a
 * live form. Keep the correlated listener alive without extending the
 * browser-side start deadline to the same boundary.
 */
export const TEXT_FIELD_CORRELATED_RESPONSE_TIMEOUT_MS = 15_000
export const TEXT_FIELD_ACK_GRACE_MS = 3_000
