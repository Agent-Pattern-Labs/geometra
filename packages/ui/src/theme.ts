/**
 * Design token system for `@geometra/ui`.
 *
 * A module-level signal holds the active {@link Theme}. Every primitive reads
 * `theme()` during tree construction, so swapping themes via {@link setTheme}
 * automatically triggers re-render inside `createApp`'s reactive effect.
 */

import { signal } from '@geometra/core'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ThemeColors {
  /** App / panel background. */
  bg: string
  /** Deeper surface (accordion body, dropdown). */
  bgAlt: string
  /** Subtle surface (focused input, hover). */
  bgSubtle: string
  /** Default border. */
  border: string
  /** Muted border (disabled state). */
  borderMuted: string
  /** Primary body text. */
  text: string
  /** Heading text. */
  textHeading: string
  /** Secondary / label text. */
  textMuted: string
  /** Description text. */
  textSubtle: string
  /** Disabled / placeholder text. */
  textDisabled: string
  /** Primary action (button bg, progress fill). */
  accent: string
  /** Text on accent backgrounds. */
  accentText: string
  /** Soft accent background (active tab). */
  accentSoft: string
  /** Text on soft accent background. */
  accentSoftText: string
  /** Focus ring / caret colour. */
  focus: string
  /** Link text. */
  link: string
  /** Success colour. */
  success: string
  /** Success background. */
  successBg: string
  /** Success body text. */
  successText: string
  /** Lighter success text (checkmark). */
  successTextLight: string
  /** Selected row / item background. */
  selected: string
  /** Text selection highlight. */
  selectionBg: string
  /** Skeleton placeholder. */
  skeleton: string
  /** Destructive text. */
  danger: string
  /** Switch track background (on). */
  switchTrackOn: string
  /** Switch thumb (on). */
  switchThumbOn: string
  /** Switch thumb (off). */
  switchThumbOff: string
  /** Switch track background (disabled). */
  switchTrackDisabled: string
  /** Switch thumb (disabled). */
  switchThumbDisabled: string
  /** Toast / alert variant palettes. */
  variants: {
    info: { border: string; bg: string; text: string }
    success: { border: string; bg: string; text: string }
    warning: { border: string; bg: string; text: string }
    error: { border: string; bg: string; text: string }
  }
  /** Badge variant palettes. */
  badgeVariants: {
    default: { bg: string; text: string }
    success: { bg: string; text: string }
    warning: { bg: string; text: string }
    error: { bg: string; text: string }
    info: { bg: string; text: string }
  }
}

export interface ThemeTypography {
  fontFamily: string
  fontSizeBase: number
  fontSizeSmall: number
  fontSizeHeading: number
  lineHeightBase: number
  lineHeightSmall: number
  lineHeightHeading: number
}

export interface ThemeSpacing {
  xs: number
  sm: number
  md: number
  lg: number
  xl: number
}

export interface ThemeRadii {
  sm: number
  md: number
  lg: number
  full: number
}

export interface Theme {
  colors: ThemeColors
  typography: ThemeTypography
  spacing: ThemeSpacing
  radii: ThemeRadii
}

// ---------------------------------------------------------------------------
// Default dark theme (extracted from previous hardcoded values)
// ---------------------------------------------------------------------------

export const darkTheme: Theme = {
  colors: {
    bg: '#0f172a',
    bgAlt: '#020617',
    bgSubtle: '#111827',
    border: '#334155',
    borderMuted: '#475569',
    text: '#e2e8f0',
    textHeading: '#f8fafc',
    textMuted: '#94a3b8',
    textSubtle: '#cbd5e1',
    textDisabled: '#64748b',
    accent: '#2563eb',
    accentText: '#ffffff',
    accentSoft: '#082f49',
    accentSoftText: '#bae6fd',
    focus: '#38bdf8',
    link: '#38bdf8',
    success: '#22c55e',
    successBg: '#14532d',
    successText: '#bbf7d0',
    successTextLight: '#86efac',
    selected: '#1e3a5f',
    selectionBg: 'rgba(56, 189, 248, 0.3)',
    skeleton: '#1e293b',
    danger: '#fca5a5',
    switchTrackOn: '#166534',
    switchThumbOn: '#22c55e',
    switchThumbOff: '#94a3b8',
    switchTrackDisabled: '#1e293b',
    switchThumbDisabled: '#475569',
    variants: {
      info: { border: '#334155', bg: '#0f172a', text: '#e2e8f0' },
      success: { border: '#166534', bg: '#052e16', text: '#bbf7d0' },
      warning: { border: '#a16207', bg: '#422006', text: '#fef08a' },
      error: { border: '#991b1b', bg: '#450a0a', text: '#fecaca' },
    },
    badgeVariants: {
      default: { bg: '#334155', text: '#e2e8f0' },
      success: { bg: '#14532d', text: '#bbf7d0' },
      warning: { bg: '#422006', text: '#fef08a' },
      error: { bg: '#450a0a', text: '#fecaca' },
      info: { bg: '#082f49', text: '#bae6fd' },
    },
  },
  typography: {
    fontFamily: 'Inter',
    fontSizeBase: 13,
    fontSizeSmall: 12,
    fontSizeHeading: 16,
    lineHeightBase: 18,
    lineHeightSmall: 16,
    lineHeightHeading: 20,
  },
  spacing: {
    xs: 4,
    sm: 6,
    md: 10,
    lg: 14,
    xl: 16,
  },
  radii: {
    sm: 4,
    md: 8,
    lg: 10,
    full: 9999,
  },
}

// ---------------------------------------------------------------------------
// Signal
// ---------------------------------------------------------------------------

const themeSignal = signal<Theme>(darkTheme)

/** Read the active theme. Subscribes the calling effect / computed. */
export function theme(): Theme {
  return themeSignal.value
}

/** Replace the active theme. Triggers re-render of any view reading `theme()`. */
export function setTheme(t: Theme): void {
  themeSignal.set(t)
}

/** Read the active theme without subscribing. */
export function peekTheme(): Theme {
  return themeSignal.peek()
}

// ---------------------------------------------------------------------------
// Deep merge helper
// ---------------------------------------------------------------------------

/** Recursive partial — every nested key is optional. */
export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K]
}

function deepMerge<T extends object>(base: T, partial: DeepPartial<T>): T {
  const result = { ...base } as Record<string, unknown>
  const src = partial as Record<string, unknown>
  for (const key of Object.keys(src)) {
    const val = src[key]
    if (val !== undefined && typeof val === 'object' && val !== null && !Array.isArray(val)) {
      const existing = (result[key] ?? {}) as object
      result[key] = deepMerge(existing, val as DeepPartial<object>)
    } else if (val !== undefined) {
      result[key] = val
    }
  }
  return result as T
}

/** Deep-merge a partial override onto the current theme. Returns a new `Theme`. */
export function mergeTheme(partial: DeepPartial<Theme>): Theme {
  return deepMerge(peekTheme(), partial)
}

// ---------------------------------------------------------------------------
// Font helpers
// ---------------------------------------------------------------------------

/** Build a CSS font shorthand from the active theme typography tokens. */
export function font(weight: '' | 'bold', size: 'base' | 'small' | 'heading'): string {
  const t = themeSignal.value.typography
  const px =
    size === 'base' ? t.fontSizeBase : size === 'small' ? t.fontSizeSmall : t.fontSizeHeading
  return weight ? `bold ${px}px ${t.fontFamily}` : `${px}px ${t.fontFamily}`
}

/** Return the line-height for a typography size bucket. */
export function lineHeight(size: 'base' | 'small' | 'heading'): number {
  const t = themeSignal.value.typography
  return size === 'base' ? t.lineHeightBase : size === 'small' ? t.lineHeightSmall : t.lineHeightHeading
}
