// Runtime app config, injected by jira-intern/local-runner/sync-datajs.mjs as
// window.__JIRA_CONFIG__ (sourced from config/jira-board.config.json → "app" section).
// Everything here has a safe default so the app works with no config at all —
// changing config/jira-board.config.json + re-running any intern job re-themes the app without a rebuild.

export interface AppRuntimeConfig {
  servePort?: number
  requiredApprovals?: number
  timeZone?: string
  doneBoardDays?: number
  polling?: {
    /** Status poll while reports, runs or the AI intern have work in flight. */
    reportsBusyMs?: number
    /** Status poll while idle (Background auto-refresh on, or Settings open). */
    aiIdleMs?: number
    /** Status poll while a model downloads, for the progress bar. */
    aiBusyMs?: number
  }
  progress?: {
    prepPercent?: number
    buildMaxPercent?: number
  }
  settingsDefaults?: {
    themeMode?: 'auto' | 'fixed' | 'schedule'
    theme?: 'dark' | 'light'
    dayStart?: number
    dayEnd?: number
    toastSeconds?: number
    toastMax?: number
    features?: Record<string, boolean>
  }
  schedule?: {
    /** false = the server's scheduled jobs start switched off (Settings → Features). */
    enabled?: boolean
    activeRefresh?: 'off' | 'daily' | 'twice-daily'
    fullRefresh?: 'off' | 'daily' | 'weekly' | 'twice-weekly'
    reportRefresh?: 'off' | 'daily' | 'weekly' | 'twice-weekly'
  }
  refresh?: { onStart?: boolean; workers?: number }
  reports?: { defaultWindowDays?: number; presetWindowDays?: number[] }
  archive?: { defaultWindowDays?: number; presetWindowDays?: number[]; workers?: number }
  ai?: {
    parallel?: number
    /** false = AI starts switched off (Settings → Features). */
    enabled?: boolean
    /** 'none' is the pre-switch spelling of "AI off". */
    level?: 'none' | 'low' | 'moderate' | 'high' | 'full'
    backend?: 'local' | 'cloud'
    localModel?: string
    cloudProvider?: 'claude' | 'cursor' | 'gemini'
    cloudModel?: string
    useHostOllama?: boolean
    ollamaEnabled?: boolean
  }
  branding?: {
    tagline?: string
    badgeText?: string
    badgeUrl?: string
    badgeTitle?: string
  }
}

const injected: AppRuntimeConfig =
  (typeof window !== 'undefined' && (window as unknown as { __JIRA_CONFIG__?: AppRuntimeConfig }).__JIRA_CONFIG__) || {}

export const APP_CONFIG: Required<Pick<AppRuntimeConfig, 'requiredApprovals'>> & AppRuntimeConfig = {
  ...injected,
  requiredApprovals:
    typeof injected.requiredApprovals === 'number' && injected.requiredApprovals > 0 ? injected.requiredApprovals : 2,
}

/** Days a Done ticket stays on the board as a "recent win" before it retires to the archive. */
export const DONE_BOARD_DAYS = injected.doneBoardDays ?? 5

export const POLLING = {
  reportsBusyMs: injected.polling?.reportsBusyMs ?? 4_000,
  aiIdleMs: injected.polling?.aiIdleMs ?? 12_000,
  aiBusyMs: injected.polling?.aiBusyMs ?? 1_000,
}

// Fallbacks are deliberately generic: whoever clones this sees neutral branding until they
// set `app.branding` in their own config.json (which reaches the built app at runtime via
// window.__JIRA_CONFIG__ — no rebuild needed). Put YOUR name/portfolio there, not here.
export const BRANDING = {
  tagline: injected.branding?.tagline ?? 'Built to dodge JIRA · made with ☕ + a refresh button',
  badgeText: injected.branding?.badgeText ?? '',
  badgeUrl: injected.branding?.badgeUrl ?? '',
  badgeTitle: injected.branding?.badgeTitle ?? '',
}
