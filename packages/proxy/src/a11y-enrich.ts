import { randomUUID } from 'node:crypto'
import type { CDPSession, Page } from 'playwright'
import type { GeometrySnapshot, LayoutSnapshot, TreeSnapshot } from './types.js'

interface AxBounds {
  left: number
  top: number
  width: number
  height: number
}

interface AxSnapshotCandidate {
  name?: string
  role: string
  bounds: AxBounds
  selected?: boolean
  expanded?: boolean
  checked?: boolean | 'mixed'
  disabled?: boolean
  focused?: boolean
}

export interface CdpAxSessionManager {
  get(page: Page): Promise<CDPSession>
  /** Opaque host-side Accessibility-domain revision for cache invalidation. */
  revisionToken(): string | undefined
  reset(): Promise<void>
  close(): Promise<void>
}

const INTERACTIVE_AX_ROLES = new Set([
  'button',
  'link',
  'textbox',
  'combobox',
  'checkbox',
  'radio',
  'tab',
])

const FORM_LIKE_AX_ROLES = new Set([
  'textbox',
  'combobox',
  'checkbox',
  'radio',
])

const INTERESTING_AX_ROLES = new Set([
  ...INTERACTIVE_AX_ROLES,
  'heading',
  'text',
  'img',
  'navigation',
  'main',
  'form',
  'article',
  'dialog',
  'alertdialog',
  'region',
  'list',
  'listitem',
  'tablist',
  'tabpanel',
])

function parseAxBounds(props: unknown[] | undefined): AxBounds | null {
  if (!Array.isArray(props)) return null
  for (const p of props) {
    if (p && typeof p === 'object' && 'name' in p && 'value' in p) {
      const name = (p as { name: unknown }).name
      const value = (p as { value: unknown }).value
      if (name === 'bounds' && value && typeof value === 'object' && value !== null) {
        const v = value as Record<string, unknown>
        const left = Number(v.left)
        const top = Number(v.top)
        const width = Number(v.width)
        const height = Number(v.height)
        if ([left, top, width, height].every(Number.isFinite)) {
          return { left, top, width, height }
        }
      }
    }
  }
  return null
}

function quadToBounds(quad: number[] | undefined): AxBounds | null {
  if (!Array.isArray(quad) || quad.length < 8) return null
  const xs = [quad[0], quad[2], quad[4], quad[6]].map(Number)
  const ys = [quad[1], quad[3], quad[5], quad[7]].map(Number)
  if (![...xs, ...ys].every(Number.isFinite)) return null
  const left = Math.min(...xs)
  const top = Math.min(...ys)
  const right = Math.max(...xs)
  const bottom = Math.max(...ys)
  return {
    left,
    top,
    width: right - left,
    height: bottom - top,
  }
}

function boundsIntersectsViewport(b: AxBounds, root: LayoutSnapshot): boolean {
  return (
    b.left + b.width >= root.x &&
    b.left <= root.x + root.width &&
    b.top + b.height >= root.y &&
    b.top <= root.y + root.height
  )
}

function parseAxPropertyValue(props: unknown[] | undefined, expectedName: string): unknown {
  if (!Array.isArray(props)) return undefined
  for (const p of props) {
    if (p && typeof p === 'object' && 'name' in p && 'value' in p) {
      const name = (p as { name: unknown }).name
      if (name === expectedName) return (p as { value: unknown }).value
    }
  }
  return undefined
}

function parseAxBooleanProperty(props: unknown[] | undefined, expectedName: string): boolean | undefined {
  const value = parseAxPropertyValue(props, expectedName)
  if (value === true || value === false) return value
  if (typeof value === 'string') {
    if (value === 'true') return true
    if (value === 'false') return false
  }
  if (value && typeof value === 'object' && 'value' in value) {
    const nested = (value as { value: unknown }).value
    if (nested === true || nested === false) return nested
    if (nested === 'true') return true
    if (nested === 'false') return false
  }
  return undefined
}

function parseAxCheckedProperty(props: unknown[] | undefined): boolean | 'mixed' | undefined {
  const value = parseAxPropertyValue(props, 'checked')
  if (value === 'mixed') return 'mixed'
  if (value === true || value === false) return value
  if (value === 'true') return true
  if (value === 'false') return false
  if (value && typeof value === 'object' && 'value' in value) {
    const nested = (value as { value: unknown }).value
    if (nested === 'mixed') return 'mixed'
    if (nested === true || nested === false) return nested
    if (nested === 'true') return true
    if (nested === 'false') return false
  }
  return undefined
}

function normalizeAxRole(rawRole: string | undefined): string | undefined {
  if (!rawRole) return undefined
  const normalized = rawRole.trim().toLowerCase().replace(/[\s_-]+/g, '')
  if (!normalized) return undefined
  if (normalized === 'rootwebarea' || normalized === 'webarea' || normalized === 'inlinetextbox') return undefined
  if (normalized === 'statictext' || normalized === 'labeltext' || normalized === 'text') return 'text'
  if (normalized === 'image') return 'img'
  if (normalized === 'searchbox' || normalized === 'textarea' || normalized === 'textinput') return 'textbox'
  if (normalized === 'editablecombobox') return 'combobox'
  if (normalized === 'radiobutton') return 'radio'
  if (normalized === 'listboxoption' || normalized === 'option') return 'listitem'
  if (normalized === 'menubutton' || normalized === 'menuitem') return 'button'
  if (normalized === 'contentinfo') return 'contentinfo'
  return normalized
}

function countMeaningfulSnapshotNodes(node: TreeSnapshot, isRoot = true): number {
  const semantic = node.semantic ?? {}
  const role = typeof semantic.role === 'string' ? semantic.role : undefined
  const text = typeof node.props.text === 'string' ? node.props.text.trim() : ''
  let count = 0
  if (!isRoot) {
    if (node.handlers || text || (role && role !== 'group')) count++
  }
  for (const child of node.children ?? []) {
    count += countMeaningfulSnapshotNodes(child, false)
  }
  return count
}

function snapshotNodeLabel(node: TreeSnapshot): string | undefined {
  const semantic = node.semantic ?? {}
  const ariaLabel = typeof semantic.ariaLabel === 'string' ? semantic.ariaLabel.trim() : ''
  if (ariaLabel) return ariaLabel
  const text = typeof node.props.text === 'string' ? node.props.text.trim() : ''
  if (text) return text
  const valueText = typeof semantic.valueText === 'string' ? semantic.valueText.trim() : ''
  return valueText || undefined
}

interface UnnamedInteractiveSnapshotSummary {
  criticalCount: number
  ignoredTinyLinkCount: number
}

function summarizeUnnamedInteractiveSnapshotNodes(
  tree: TreeSnapshot,
  layout: LayoutSnapshot,
  isRoot = true,
): UnnamedInteractiveSnapshotSummary {
  const summary: UnnamedInteractiveSnapshotSummary = {
    criticalCount: 0,
    ignoredTinyLinkCount: 0,
  }

  if (!isRoot) {
    const semantic = tree.semantic ?? {}
    const role = typeof semantic.role === 'string' ? semantic.role : undefined
    const interactive =
      (role !== undefined && INTERACTIVE_AX_ROLES.has(role)) ||
      !!tree.handlers?.onClick ||
      !!tree.handlers?.onKeyDown ||
      !!tree.handlers?.onKeyUp
    if (interactive && !snapshotNodeLabel(tree)) {
      const isTinyLink =
        role === 'link' &&
        layout.width > 0 &&
        layout.height > 0 &&
        layout.width <= 56 &&
        layout.height <= 56 &&
        layout.width * layout.height <= 2_500
      if (isTinyLink) summary.ignoredTinyLinkCount += 1
      else summary.criticalCount += 1
    }
  }

  const children = tree.children ?? []
  for (let index = 0; index < children.length; index++) {
    const childLayout = layout.children[index]
    if (!childLayout) continue
    const childSummary = summarizeUnnamedInteractiveSnapshotNodes(children[index]!, childLayout, false)
    summary.criticalCount += childSummary.criticalCount
    summary.ignoredTinyLinkCount += childSummary.ignoredTinyLinkCount
  }
  return summary
}

export function shouldEnrichSnapshotWithCdpAx(snap: GeometrySnapshot): boolean {
  if (countMeaningfulSnapshotNodes(snap.tree) <= 1) return true
  const unnamed = summarizeUnnamedInteractiveSnapshotNodes(snap.tree, snap.layout)
  return unnamed.criticalCount > 0 || unnamed.ignoredTinyLinkCount > 1
}

async function detachCdpSession(session: CDPSession | undefined): Promise<void> {
  try {
    await session?.detach()
  } catch {
    /* ignore */
  }
}

async function createEnabledCdpSession(
  page: Page,
  onAccessibilityOrDomMutation?: () => void,
  onTrackingReliability?: (reliable: boolean) => void,
): Promise<CDPSession> {
  const session = await page.context().newCDPSession(page)
  try {
    if (onAccessibilityOrDomMutation) {
      const eventSession = session as CDPSession & {
        on?: (event: string, listener: () => void) => unknown
      }
      for (const event of [
        'Accessibility.nodesUpdated',
        'Accessibility.loadComplete',
        'DOM.attributeModified',
        'DOM.attributeRemoved',
        'DOM.characterDataModified',
        'DOM.childNodeCountUpdated',
        'DOM.childNodeInserted',
        'DOM.childNodeRemoved',
        'DOM.shadowRootPopped',
        'DOM.shadowRootPushed',
      ]) {
        eventSession.on?.(event, onAccessibilityOrDomMutation)
      }
    }
    await session.send('Accessibility.enable')
    try {
      await session.send('DOM.enable')
      if (onAccessibilityOrDomMutation) {
        // Materialize the complete pierced tree once so Chrome emits trusted
        // host-side DOM events for preexisting open and closed shadow roots.
        // This runs only in the background AX session, never on the DOM/ACK
        // extraction critical path.
        await session.send('DOM.getDocument', { depth: -1, pierce: true })
        onTrackingReliability?.(true)
        const eventSession = session as CDPSession & {
          on?: (event: string, listener: () => void) => unknown
        }
        let rematerializePromise: Promise<unknown> | undefined
        eventSession.on?.('DOM.documentUpdated', () => {
          onTrackingReliability?.(false)
          onAccessibilityOrDomMutation()
          if (rematerializePromise) return
          rematerializePromise = session.send('DOM.getDocument', { depth: -1, pierce: true })
            .then(
              value => {
                onTrackingReliability?.(true)
                onAccessibilityOrDomMutation()
                return value
              },
              () => {
                onTrackingReliability?.(false)
                onAccessibilityOrDomMutation()
              },
            )
            .finally(() => {
              rematerializePromise = undefined
            })
        })
      }
    } catch (err) {
      // DOM tracking is optional only for one-shot temporary enrichment. A
      // persistent cache manager must prove it can observe the fully pierced
      // tree; otherwise it cannot issue a trustworthy revision token.
      if (onAccessibilityOrDomMutation) throw err
    }
    return session
  } catch (err) {
    await detachCdpSession(session)
    throw err
  }
}

function isRecoverableCdpSessionError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return /Session closed|Target closed|Browser has been closed|page has been closed|Protocol error/i.test(message)
}

export function createCdpAxSessionManager(onRevision?: () => void): CdpAxSessionManager {
  const managerIdentity = randomUUID()
  let activeSession: CDPSession | undefined
  let sessionPromise: Promise<CDPSession> | undefined
  let sessionGeneration = 0
  let accessibilityRevision = 0
  let revisionReliable = false

  const clear = async (): Promise<void> => {
    const pending = sessionPromise
    sessionPromise = undefined
    const session = activeSession ?? await pending?.catch(() => undefined)
    activeSession = undefined
    revisionReliable = false
    await detachCdpSession(session)
  }

  return {
    async get(page: Page): Promise<CDPSession> {
      if (activeSession) return activeSession
      if (!sessionPromise) {
        const markAccessibilityChanged = () => {
          accessibilityRevision += 1
          if (activeSession) {
            try {
              onRevision?.()
            } catch {
              // Freshness notification is advisory; the revision token still
              // invalidates cache on the next extraction.
            }
          }
        }
        revisionReliable = false
        sessionPromise = createEnabledCdpSession(
          page,
          markAccessibilityChanged,
          reliable => {
            revisionReliable = reliable
          },
        )
          .then(session => {
            sessionGeneration += 1
            activeSession = session
            return session
          })
          .catch(err => {
            activeSession = undefined
            sessionPromise = undefined
            throw err
          })
      }
      return sessionPromise
    },
    revisionToken(): string | undefined {
      return activeSession && revisionReliable
        ? `${managerIdentity}:${sessionGeneration}:${accessibilityRevision}`
        : undefined
    },
    reset: clear,
    close: clear,
  }
}

function buildAxFallbackChildren(candidates: AxSnapshotCandidate[]): {
  layoutChildren: LayoutSnapshot[]
  treeChildren: TreeSnapshot[]
} {
  const layoutChildren: LayoutSnapshot[] = []
  const treeChildren: TreeSnapshot[] = []
  const seen = new Set<string>()

  const sorted = [...candidates].sort((a, b) => {
    if (a.bounds.top !== b.bounds.top) return a.bounds.top - b.bounds.top
    return a.bounds.left - b.bounds.left
  })

  for (const candidate of sorted) {
    const rounded = {
      left: Math.round(candidate.bounds.left),
      top: Math.round(candidate.bounds.top),
      width: Math.round(candidate.bounds.width),
      height: Math.round(candidate.bounds.height),
    }
    const key = `${candidate.role}|${candidate.name ?? ''}|${rounded.left}|${rounded.top}|${rounded.width}|${rounded.height}`
    if (seen.has(key)) continue
    seen.add(key)

    const layout: LayoutSnapshot = {
      x: rounded.left,
      y: rounded.top,
      width: rounded.width,
      height: rounded.height,
      children: [],
    }

    const interactive = INTERACTIVE_AX_ROLES.has(candidate.role)
    const coordinateOnly = interactive
    const semantic: Record<string, unknown> = {
      tag: 'ax-fallback',
      a11yEnriched: true,
      a11yFallback: true,
    }
    if (!FORM_LIKE_AX_ROLES.has(candidate.role)) semantic.role = candidate.role
    if (coordinateOnly) {
      semantic.a11yRoleHint = candidate.role
      semantic.coordinateOnly = true
    }
    if (candidate.name) semantic.ariaLabel = candidate.name
    if (candidate.selected !== undefined) semantic.ariaSelected = candidate.selected
    if (candidate.expanded !== undefined) semantic.ariaExpanded = candidate.expanded
    if (candidate.checked !== undefined) semantic.ariaChecked = candidate.checked
    if (candidate.disabled) semantic.ariaDisabled = true
    if (candidate.focused) semantic.focused = true

    const tree: TreeSnapshot = {
      kind: candidate.role === 'text' || candidate.role === 'heading' ? 'text' : candidate.role === 'img' ? 'image' : 'box',
      props:
        candidate.role === 'text' || candidate.role === 'heading'
          ? { text: candidate.name ?? '', font: '16px system-ui', lineHeight: 1.2 }
          : candidate.role === 'img'
            ? { src: '', alt: candidate.name ?? '' }
            : {},
      semantic,
      ...(interactive
        ? { handlers: { onClick: true, onKeyDown: true, onKeyUp: true } }
        : {}),
    }

    layoutChildren.push(layout)
    treeChildren.push(tree)
  }

  return { layoutChildren, treeChildren }
}

function boundsRepresentSameNode(layout: LayoutSnapshot, bounds: AxBounds): boolean {
  const delta = Math.max(
    Math.abs(layout.x - bounds.left),
    Math.abs(layout.y - bounds.top),
    Math.abs(layout.width - bounds.width),
    Math.abs(layout.height - bounds.height),
  )
  if (delta <= 3) return true

  const left = Math.max(layout.x, bounds.left)
  const top = Math.max(layout.y, bounds.top)
  const right = Math.min(layout.x + layout.width, bounds.left + bounds.width)
  const bottom = Math.min(layout.y + layout.height, bounds.top + bounds.height)
  const intersection = Math.max(0, right - left) * Math.max(0, bottom - top)
  const layoutArea = Math.max(0, layout.width) * Math.max(0, layout.height)
  const candidateArea = Math.max(0, bounds.width) * Math.max(0, bounds.height)
  const smallerArea = Math.min(layoutArea, candidateArea)
  const largerArea = Math.max(layoutArea, candidateArea)
  return smallerArea > 0 && intersection / smallerArea >= 0.85 && largerArea / smallerArea <= 2
}

function snapshotRepresentsAxCandidate(
  tree: TreeSnapshot,
  layout: LayoutSnapshot,
  candidate: AxSnapshotCandidate,
): boolean {
  const semantic = tree.semantic ?? {}
  const role = typeof semantic.role === 'string'
    ? normalizeAxRole(semantic.role)
    : typeof semantic.a11yRoleHint === 'string'
      ? normalizeAxRole(semantic.a11yRoleHint)
      : undefined
  const sameRole = role === candidate.role
  // Authored DOM identity wins. AX engines can normalize or inherit a
  // different label, but a same-role node at the same bounds is represented
  // already and must never gain a duplicate coordinate fallback.
  if (sameRole && boundsRepresentSameNode(layout, candidate.bounds)) return true

  const children = tree.children ?? []
  for (let index = 0; index < children.length; index++) {
    const childLayout = layout.children[index]
    if (childLayout && snapshotRepresentsAxCandidate(children[index]!, childLayout, candidate)) return true
  }
  return false
}

function appendMissingInteractiveAxCandidates(
  snap: GeometrySnapshot,
  candidates: AxSnapshotCandidate[],
): number {
  const missing = candidates.filter(candidate =>
    INTERACTIVE_AX_ROLES.has(candidate.role) &&
    !snapshotRepresentsAxCandidate(snap.tree, snap.layout, candidate),
  )
  if (missing.length === 0) return 0

  const appended = buildAxFallbackChildren(missing)
  for (const tree of appended.treeChildren) {
    tree.semantic = {
      ...(tree.semantic ?? {}),
      a11yAppended: true,
    }
  }
  snap.layout.children.push(...appended.layoutChildren)
  if (!snap.tree.children) snap.tree.children = []
  snap.tree.children.push(...appended.treeChildren)
  return appended.treeChildren.length
}

async function boundsForBackendNode(session: CDPSession, backendDOMNodeId: number | undefined): Promise<AxBounds | null> {
  if (!backendDOMNodeId || !Number.isFinite(backendDOMNodeId)) return null
  try {
    const res = (await session.send('DOM.getBoxModel', { backendNodeId: backendDOMNodeId })) as {
      model?: { border?: number[]; content?: number[] }
    }
    return quadToBounds(res.model?.border ?? res.model?.content)
  } catch {
    return null
  }
}

async function collectAxSnapshotCandidates(
  session: CDPSession,
  root: LayoutSnapshot,
): Promise<AxSnapshotCandidate[]> {
  const res = (await session.send('Accessibility.getFullAXTree')) as {
    nodes?: Array<{
      ignored?: boolean
      role?: { value?: string }
      name?: { value?: string }
      properties?: unknown[]
      backendDOMNodeId?: number
    }>
  }
  const nodes = res.nodes ?? []
  const candidates: AxSnapshotCandidate[] = []
  for (const n of nodes) {
    if (n.ignored) continue
    const role = normalizeAxRole(n.role?.value)
    if (!role || !INTERESTING_AX_ROLES.has(role)) continue
    const name = n.name?.value?.trim() || undefined
    const b = parseAxBounds(n.properties as unknown[] | undefined) ??
      await boundsForBackendNode(session, n.backendDOMNodeId)
    if (!b || b.width <= 0 || b.height <= 0) continue
    if (!boundsIntersectsViewport(b, root)) continue
    if (!name && !INTERACTIVE_AX_ROLES.has(role) && role !== 'img') continue
    candidates.push({
      ...(name ? { name } : {}),
      role,
      bounds: b,
      selected: parseAxBooleanProperty(n.properties as unknown[] | undefined, 'selected'),
      expanded: parseAxBooleanProperty(n.properties as unknown[] | undefined, 'expanded'),
      checked: parseAxCheckedProperty(n.properties as unknown[] | undefined),
      disabled: parseAxBooleanProperty(n.properties as unknown[] | undefined, 'disabled'),
      focused: parseAxBooleanProperty(n.properties as unknown[] | undefined, 'focused'),
    })
  }
  return candidates
}

function applyAxSnapshotCandidates(snap: GeometrySnapshot, candidates: AxSnapshotCandidate[]): void {
  const meaningfulBeforeEnrichment = countMeaningfulSnapshotNodes(snap.tree)
  const visit = (tNode: TreeSnapshot, lNode: LayoutSnapshot): void => {
    const sem = tNode.semantic ?? {}
    const snapshotRole = typeof sem.role === 'string'
      ? normalizeAxRole(sem.role)
      : typeof sem.a11yRoleHint === 'string'
        ? normalizeAxRole(sem.a11yRoleHint)
        : undefined
    const snapshotInteractive =
      (snapshotRole !== undefined && INTERACTIVE_AX_ROLES.has(snapshotRole)) ||
      !!tNode.handlers?.onClick ||
      !!tNode.handlers?.onKeyDown ||
      !!tNode.handlers?.onKeyUp
    if (!sem.a11yEnriched && !snapshotNodeLabel(tNode) && snapshotInteractive) {
      const compatible = candidates
        .filter(candidate =>
          !!candidate.name &&
          INTERACTIVE_AX_ROLES.has(candidate.role) &&
          (!snapshotRole || snapshotRole === candidate.role) &&
          boundsRepresentSameNode(lNode, candidate.bounds),
        )
        .sort((a, b) => {
          const score = (candidate: AxSnapshotCandidate) =>
            Math.abs(lNode.x - candidate.bounds.left) +
            Math.abs(lNode.y - candidate.bounds.top) +
            Math.abs(lNode.width - candidate.bounds.width) +
            Math.abs(lNode.height - candidate.bounds.height)
          return score(a) - score(b)
        })
      const best = compatible[0]
      if (best) {
        tNode.semantic = {
          ...sem,
          ariaLabel: best.name,
          ...(!snapshotRole ? { a11yRoleHint: best.role } : {}),
          a11yEnriched: true,
        }
      }
    }
    const tch = tNode.children ?? []
    const lch = lNode.children
    for (let i = 0; i < tch.length; i++) {
      visit(tch[i]!, lch[i]!)
    }
  }

  visit(snap.tree, snap.layout)

  if (meaningfulBeforeEnrichment === 0) {
    const fallback = buildAxFallbackChildren(candidates)
    if (fallback.treeChildren.length > 0) {
      snap.layout.children = fallback.layoutChildren
      snap.tree.children = fallback.treeChildren
      snap.tree.semantic = {
        ...(snap.tree.semantic ?? {}),
        a11yFallbackUsed: true,
      }
    }
  } else {
    const appendedCount = appendMissingInteractiveAxCandidates(snap, candidates)
    if (appendedCount > 0) {
      snap.tree.semantic = {
        ...(snap.tree.semantic ?? {}),
        a11yAppendUsed: true,
        a11yAppendedCount: appendedCount,
      }
    }
  }
}

/**
 * Use Chrome DevTools `Accessibility.getFullAXTree` to back-fill `semantic.ariaLabel` on nodes
 * whose center falls inside an AX bounds box (helps closed shadow + custom controls).
 */
export async function enrichSnapshotWithCdpAx(
  page: Page,
  snap: GeometrySnapshot,
  sessionManager?: CdpAxSessionManager,
): Promise<boolean> {
  let temporarySession: CDPSession | undefined
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const session = sessionManager
        ? await sessionManager.get(page)
        : (temporarySession = await createEnabledCdpSession(page))
      const candidates = await collectAxSnapshotCandidates(session, snap.layout)
      applyAxSnapshotCandidates(snap, candidates)
      return true
    } catch (err) {
      if (sessionManager && attempt === 0 && !page.isClosed() && isRecoverableCdpSessionError(err)) {
        await sessionManager.reset()
        continue
      }
      return false
    } finally {
      if (!sessionManager && temporarySession) {
        await detachCdpSession(temporarySession)
      }
    }
  }
  return false
}
