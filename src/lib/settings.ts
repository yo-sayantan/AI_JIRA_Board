/**
 * Board settings — theme policy, per-feature switches, and how much AI the pipeline may use.
 *
 * Everything lives in localStorage so the board keeps working from `file://`, where there is no
 * server to ask. The AI level is the one setting that also has to reach the shell runners (they
 * decide whether to invoke the agent at all), so served mode mirrors it to the server, which
 * writes jira-intern/.settings.json for `config.mjs shellenv` to pick up.
 */
import modelCatalog from '../../ai-intern/models.json'
import { APP_CONFIG } from './appConfig'
import { setMotionEnabled } from './motionPolicy'

export type ThemeMode = 'auto' | 'fixed' | 'schedule'
/** Stored values; the labels are Low · Medium · High · Max (`moderate` = Medium, `full` = Max — see AI_LEVELS). */
export type AiLevel = 'low' | 'moderate' | 'high' | 'full'
/** How the PDF report deck looks: Google-style white pages (`light`) or the original section-coloured deck (`colorful`). */
export type ReportStyle = 'light' | 'colorful'
export type AiBackend = 'local' | 'cloud'
export type AiCloudProvider = 'claude' | 'cursor' | 'gemini'

export interface Settings {
  /** auto = follow the OS · fixed = always `theme` · schedule = light between the day hours. */
  themeMode: ThemeMode
  theme: 'dark' | 'light'
  /** Local hours [start, end) during which the LIGHT theme applies in `schedule` mode. */
  dayStart: number
  dayEnd: number
  /** Master switch for everything AI. Off greys out the AI section and the server skips every AI job. */
  aiEnabled: boolean
  /** The look of the PR report PDF deck — used the next time a report is printed / saved as PDF. */
  reportStyle: ReportStyle
  /** Master switch for the server's scheduled jobs. Off greys out the Background jobs section. */
  jobsEnabled: boolean
  aiLevel: AiLevel
  /** Local Ollama (in-container or host Metal) vs a cloud chat API. */
  aiBackend: AiBackend
  /** Ollama tag to pull/run when aiBackend is local. */
  aiLocalModel: string
  /** Claude, Cursor, or Gemini. Keys live in setup/.env (the header's API keys dialog). */
  aiCloudProvider: AiCloudProvider
  /** Model id returned by that provider's list-models API. */
  aiCloudModel: string
  /** Talk to Ollama.app on the Mac (Metal) instead of the Linux Docker VM (CPU). */
  aiUseHostOllama: boolean
  /** PR readiness reports the AI intern builds at once. */
  reportParallel: number
  /**
   * Settings toggle for the AI-Ollama Docker container. Even when on, the container only runs
   * while jira-intern/models/ holds a model (the server enforces that).
   */
  ollamaEnabled: boolean
  /** Show the local-model list in the AI section (display only; the container is a Feature). */
  showLocalModels: boolean
  /** Tickets the Completed-archive rebuild fetches at once. */
  archiveParallel: number
  /** Tickets the dashboard refresh builds at once. */
  refreshParallel: number
  /** Seconds a notification stays on screen before it dismisses itself. */
  toastSeconds: number
  /** Most notifications on screen at once; the oldest go first. */
  toastMax: number
  /** Server schedule for the active-ticket fetch. */
  activeRefresh: ActiveCadence
  /** Server schedule for active tickets plus the Completed archive. */
  fullRefresh: BoardCadence
  /** Server schedule for PR reports that are stale or below 100. */
  reportRefresh: BoardCadence
  features: Record<FeatureKey, boolean>
}

/** Inclusive bounds for the number boxes. The server clamps to the same ranges. */
export const LIMITS = {
  reportParallel: { min: 1, max: 10 },
  archiveParallel: { min: 1, max: 16 },
  refreshParallel: { min: 1, max: 16 },
  toastSeconds: { min: 2, max: 10 },
  toastMax: { min: 1, max: 10 },
} as const

export function clampSetting(key: keyof typeof LIMITS, v: unknown, fallback: number): number {
  const n = Math.round(Number(v))
  if (!Number.isFinite(n)) return fallback
  return Math.min(LIMITS[key].max, Math.max(LIMITS[key].min, n))
}

/**
 * The feature registry is the single source of truth: the FeatureKey union, the defaults and the
 * settings cards are all derived from it, so adding a switch means adding ONE entry here (plus its
 * colour/icon in Settings.tsx, which TypeScript will demand because that map is keyed exhaustively).
 */
export const FEATURES = [
  {
    key: 'prReports',
    default: true,
    label: 'PR Readiness Reports',
    hint: 'Ship/no-ship verdict per ticket',
    detail:
      'Adds the report button to any ticket with a pull request, plus the header control that generates reports in bulk. Each report grades approvals, open comments, merge state and release gates into a single verdict. Turn off to hide the whole feature.',
  },
  {
    key: 'nextSprint',
    default: true,
    label: 'Next Sprint section',
    hint: 'The sprint that has not started, at the end of To Do',
    detail:
      'Gives the To Do column a second space at its end — a separate header and box, like QA In Progress under QA — holding the tickets in a dated future sprint or the READY / REFINEMENT bucket, so upcoming work stays visible without mixing into this sprint\'s To Do. Drop To Do, Blocked, QA or On Hold cards on it to queue them (Jira: nearest future sprint); from it they can only go back to To Do. Off hides those tickets entirely.',
  },
  {
    key: 'completedArchive',
    default: true,
    label: 'Completed archive',
    hint: 'The Completed chip and its drawer',
    detail:
      'Keeps the gold Completed counter and the full archive of closed tickets. Turn off for a board that only ever shows work in flight.',
  },
  {
    key: 'raisedTickets',
    default: true,
    label: 'Raised by me',
    hint: 'Tickets you reported, and who holds them',
    detail:
      'Adds the indigo Raised button beside Completed, listing every ticket you reported (sub-tickets you cut under your own work are excluded): its current status, who it is assigned to now, every hand-off since you raised it, and its AI brief.',
  },
  {
    key: 'animations',
    default: true,
    label: 'Motion & animations',
    hint: 'Glass, gradients, transitions and hover effects',
    detail:
      'Every decorative effect: the Liquid Glass finish (blur, sheen, matte grain, reflections), the ambient background gradient, card entrances, drawer slides, the light / dark reveal, spinners, the pointer light and hover lifts. Turning this off gives a calm, flat, still board at once — plain opaque surfaces with the same colours for columns, badges and states, CSS and JavaScript animations alike, regardless of the system reduce-motion setting — which also helps on a slow or remote display.',
  },
  {
    key: 'shortcuts',
    default: true,
    label: 'Keyboard shortcuts',
    hint: '/ search · r refresh',
    detail:
      'Turns on / to focus search and r to refresh, and shows those keys on the search box and refresh button. They stay off while you are typing or a ticket is open. Escape still closes a ticket.',
  },
  {
    key: 'autoRefresh',
    default: true,
    label: 'Background auto-refresh',
    hint: 'Live progress while the board is open',
    detail:
      'Polls for report progress and intern status while the board is open. Off stops those polls. A refresh or report you start yourself still updates until it finishes.',
  },
  {
    key: 'aiBriefs',
    default: true,
    label: 'AI briefs',
    hint: 'The summary at the top of a ticket',
    detail: 'Shows the generated brief on the ticket page. Off hides it. Reports and the intern keep running.',
  },
  {
    key: 'dragMove',
    default: true,
    label: 'Drag to change status',
    hint: 'Drop a card in another column to move it in Jira',
    detail:
      'Drag a card to another column and the ticket is transitioned in Jira in the background. QA and QA In Progress take only QA tickets, and a QA ticket moves only among QA, QA In Progress, Blocked, On Hold and Done. In Review needs a pull request (a sub-ticket may use its parent\'s open one); Done needs every PR merged or declined and a QA ticket raised. A refused zone says why while you drag; hold ⌥ while dropping to move anyway, past a PR / QA rule. Every move can be undone from its notification for a few seconds. Needs the local server.',
  },
  {
    key: 'moveReadiness',
    default: true,
    label: 'Move readiness on cards',
    hint: 'Rev / Done dots: green = the move would go through',
    detail:
      'Two small dots on every card that is not Done: Rev — could it move to In Review (it has a pull request, or its parent has an open one)? Done — could it close (no PR still open, a QA ticket raised)? Green is ready, amber means something is missing; hover a dot for what. Judged from the board\'s data, so it can be a refresh behind Jira. Shown only while Drag to change status is on.',
  },
  {
    key: 'demoMode',
    default: false,
    label: 'Demo mode',
    hint: 'A sample board for testing — nothing reaches Jira',
    detail:
      'Replaces the board with ~20 invented tickets covering every column (including Blocked and the QA In Progress shelf), On Hold, Next Sprint, sub-tasks, pull requests in every state, the Completed archive, Raised by me and two sample PR Readiness Reports. Drag-and-drop runs the same PR and QA gates in the browser, so a refused Done still slides back — but no refresh, transition, report or AI job is ever sent. Your real board is untouched and returns the moment you turn this off.',
  },
  {
    key: 'blocked',
    default: true,
    label: 'Blocked section',
    hint: 'The column for stuck work',
    detail:
      'Shows the Blocked column between To Do and In Progress. Off hides the column and every Blocked ticket with it — they are not on the board, and not in the Blocked count, until you switch it back on.',
  },
  {
    key: 'qaInProgress',
    default: true,
    label: 'QA In Progress section',
    hint: 'Its own space under QA',
    detail:
      'Shows tickets the QA team has picked up in their own space under QA. Off hides that space and its tickets — QA then lists only what is waiting for QA.',
  },
  {
    key: 'onHold',
    default: true,
    label: 'On Hold section',
    hint: 'Its own space under Blocked to park tickets',
    detail: 'On Hold gets its own small space in the Blocked column, under Blocked: it shows paused and waiting tickets, and a card dropped on it is put On Hold in Jira (with a notice if its pull request is still open). It stays slim when empty. Off hides the space and every held ticket, and removes the drop target.',
  },
  {
    key: 'reloadActive',
    default: true,
    label: 'Refresh on open',
    hint: 'Fetch active tickets on every reload',
    detail: 'Each time you open or reload the board, fetch your active tickets. Scheduled jobs are separate and keep running when this is off.',
  },
] as const

/** How often the server refreshes active tickets. */
export const ACTIVE_CADENCE = ['off', 'daily', 'twice-daily'] as const
/** How often the server rebuilds the whole board, or refreshes unfinished PR reports. */
export const BOARD_CADENCE = ['off', 'daily', 'weekly', 'twice-weekly'] as const
export type ActiveCadence = (typeof ACTIVE_CADENCE)[number]
export type BoardCadence = (typeof BOARD_CADENCE)[number]

export function pickCadence<T extends string>(allowed: readonly T[], value: unknown, fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback
}

type Parse<T> = (value: unknown, fallback: T) => T
const oneOf =
  <T extends string>(allowed: readonly T[]): Parse<T> =>
  (v, f) =>
    pickCadence(allowed, v, f)
const bool: Parse<boolean> = (v, f) => (typeof v === 'boolean' ? v : f)
const bounded =
  (key: keyof typeof LIMITS): Parse<number> =>
  (v, f) =>
    clampSetting(key, v, f)
/** Hour of day for the schedule window: an integer 0–23, else the fallback. */
const hour: Parse<number> = (v, f) => {
  const n = Math.round(Number(v))
  return Number.isFinite(n) && n >= 0 && n <= 23 ? n : f
}

/**
 * Model ids reach shell runners and CLIs, so they are limited to tag characters — the SAME regex and
 * lengths server/settings.mjs enforces. Anything else would make the server reject the whole patch
 * with a 400, and every other setting in it would silently never reach the server.
 */
export const MODEL_ID_RE = /^[\w.:/-]*$/
export const MODEL_ID_MAX = { aiLocalModel: 80, aiCloudModel: 128 } as const
export function isModelId(v: unknown, max: number): v is string {
  return typeof v === 'string' && v.length <= max && MODEL_ID_RE.test(v)
}
const modelId =
  (max: number): Parse<string> =>
  (v, f) =>
    isModelId(v, max) ? v : f

/** Settings the server-side jobs honour, mirrored to jira-intern/.settings.json in served mode. */
const SERVER_FIELDS = {
  aiEnabled: bool,
  jobsEnabled: bool,
  aiLevel: oneOf<AiLevel>(['low', 'moderate', 'high', 'full']),
  aiBackend: oneOf<AiBackend>(['local', 'cloud']),
  aiLocalModel: modelId(MODEL_ID_MAX.aiLocalModel),
  aiCloudModel: modelId(MODEL_ID_MAX.aiCloudModel),
  aiCloudProvider: oneOf<AiCloudProvider>(['claude', 'cursor', 'gemini']),
  aiUseHostOllama: bool,
  ollamaEnabled: bool,
  reportParallel: bounded('reportParallel'),
  archiveParallel: bounded('archiveParallel'),
  refreshParallel: bounded('refreshParallel'),
  activeRefresh: oneOf(ACTIVE_CADENCE),
  fullRefresh: oneOf(BOARD_CADENCE),
  reportRefresh: oneOf(BOARD_CADENCE),
} satisfies { [K in keyof Settings]?: Parse<Settings[K]> }

type ServerKey = keyof typeof SERVER_FIELDS
export type ServerSettings = Pick<Settings, ServerKey>
const SERVER_KEYS = Object.keys(SERVER_FIELDS) as ServerKey[]

export function serverSettingsOf(s: Settings): ServerSettings {
  return Object.fromEntries(SERVER_KEYS.map((k) => [k, s[k]])) as ServerSettings
}

/** Overlay the server's saved values, keeping the current value for anything missing or invalid. */
export function mergeServerSettings(current: Settings, saved: Record<string, unknown>): Settings {
  const next = { ...current }
  for (const k of SERVER_KEYS) {
    const parse = SERVER_FIELDS[k] as Parse<Settings[typeof k]>
    ;(next as Record<ServerKey, unknown>)[k] = parse(saved[k], current[k])
  }
  return next
}

export type FeatureKey = (typeof FEATURES)[number]['key']

/** Everything that lives only in localStorage. Together with SERVER_FIELDS this covers every key of Settings. */
const LOCAL_FIELDS = {
  themeMode: oneOf<ThemeMode>(['auto', 'fixed', 'schedule']),
  theme: oneOf<Settings['theme']>(['dark', 'light']),
  dayStart: hour,
  dayEnd: hour,
  toastSeconds: bounded('toastSeconds'),
  toastMax: bounded('toastMax'),
  showLocalModels: bool,
  reportStyle: oneOf<ReportStyle>(['light', 'colorful']),
} satisfies { [K in Exclude<keyof Settings, ServerKey | 'features'>]: Parse<Settings[K]> }

/**
 * The one AI dial. It sets how long a pass may think (the worker's timeout) AND how hard a cloud model works
 * (`effortForLevel`) — there is no separate effort control. "None" is gone: the AI switch under Features is "off".
 */
/** The two looks of the PDF deck (Settings → PDF report). The deck is generated in whichever is chosen when you print. */
export const REPORT_STYLES: { key: ReportStyle; label: string }[] = [
  { key: 'light', label: 'Light' },
  { key: 'colorful', label: 'Colourful' },
]

export const AI_LEVELS: {
  key: AiLevel
  label: string
  hint: string
  plus: string[]
  cons: string[]
}[] = [
  {
    key: 'low',
    label: 'Low',
    hint: 'Short timeout, low effort · cloud models up to $1/M out',
    plus: ['Quick on nano / mini models', 'Cheapest cloud option (models up to $1 per 1M output)', 'Unblocks the queue sooner'],
    cons: ['Shallow file notes', 'May skip longer diffs'],
  },
  {
    key: 'moderate',
    label: 'Medium',
    hint: 'Balanced depth and effort (default) · models up to $5/M out',
    plus: ['Solid JSON follow-through', 'Fits 7B local models', 'Cloud models up to $5 per 1M output'],
    cons: ['Slower than Low', 'Still skips live CI / scan proof'],
  },
  {
    key: 'high',
    label: 'High',
    hint: 'Longer timeout, high effort · models under $10/M out',
    plus: ['Noticeably better notes than Medium', 'Room for 14B local models', 'Cloud models under $10 per 1M output'],
    cons: ['Slower than Medium', 'More cloud tokens per report'],
  },
  {
    key: 'full',
    label: 'Max',
    hint: 'Longest timeout · every model, costly ones too',
    plus: ['Best local / cloud quality', 'The only level that can use a costly model (≥ $10 per 1M output)', 'Richer file and risk notes'],
    cons: ['Slowest, especially on CPU', 'Burns the most cloud tokens'],
  },
]

/** The cloud effort each level runs at. Max stays at High: its extra is the timeout and the costly models. */
export function effortForLevel(level: AiLevel): 'low' | 'medium' | 'high' {
  return level === 'low' ? 'low' : level === 'moderate' ? 'medium' : 'high'
}

const DEFAULT_FEATURES = {
  ...(Object.fromEntries(FEATURES.map((f) => [f.key, f.default])) as Record<FeatureKey, boolean>),
  ...(APP_CONFIG.settingsDefaults?.features as Partial<Record<FeatureKey, boolean>> | undefined),
}

export const DEFAULT_SETTINGS: Settings = {
  themeMode: APP_CONFIG.settingsDefaults?.themeMode ?? 'auto',
  theme: APP_CONFIG.settingsDefaults?.theme ?? 'dark',
  dayStart: APP_CONFIG.settingsDefaults?.dayStart ?? 7,
  dayEnd: APP_CONFIG.settingsDefaults?.dayEnd ?? 19,
  reportStyle: APP_CONFIG.settingsDefaults?.reportStyle ?? 'light',
  aiEnabled: APP_CONFIG.ai?.enabled !== false && APP_CONFIG.ai?.level !== 'none',
  jobsEnabled: APP_CONFIG.schedule?.enabled !== false,
  aiLevel: APP_CONFIG.ai?.level && APP_CONFIG.ai.level !== 'none' ? APP_CONFIG.ai.level : 'moderate',
  aiBackend: APP_CONFIG.ai?.backend ?? 'local',
  aiLocalModel: APP_CONFIG.ai?.localModel || modelCatalog.defaultLocal,
  aiCloudProvider: APP_CONFIG.ai?.cloudProvider ?? 'cursor',
  aiCloudModel: APP_CONFIG.ai?.cloudModel ?? '',
  aiUseHostOllama: APP_CONFIG.ai?.useHostOllama ?? false,
  ollamaEnabled: APP_CONFIG.ai?.ollamaEnabled ?? false,
  showLocalModels: true,
  reportParallel: clampSetting('reportParallel', APP_CONFIG.ai?.parallel, 4),
  archiveParallel: clampSetting('archiveParallel', APP_CONFIG.archive?.workers, 8),
  refreshParallel: clampSetting('refreshParallel', APP_CONFIG.refresh?.workers, 8),
  toastSeconds: clampSetting('toastSeconds', APP_CONFIG.settingsDefaults?.toastSeconds, 10),
  toastMax: clampSetting('toastMax', APP_CONFIG.settingsDefaults?.toastMax, 4),
  activeRefresh: pickCadence(ACTIVE_CADENCE, APP_CONFIG.schedule?.activeRefresh, 'twice-daily'),
  fullRefresh: pickCadence(BOARD_CADENCE, APP_CONFIG.schedule?.fullRefresh, 'twice-weekly'),
  reportRefresh: pickCadence(BOARD_CADENCE, APP_CONFIG.schedule?.reportRefresh, 'twice-weekly'),
  features: DEFAULT_FEATURES,
}

const KEY = 'jb-settings'

/**
 * Validate a saved settings object field by field; anything missing, of the wrong type, out of
 * range or no longer a valid choice (a model tag with a space; the old "none" level becomes aiEnabled: false) takes the
 * default instead of being passed through. Never throws — a non-object yields the defaults.
 */
export function parseSettings(raw: unknown, defaults: Settings = DEFAULT_SETTINGS): Settings {
  let saved = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  // The old "None" level is now the AI switch being off (the level itself falls back to the default).
  if (saved.aiLevel === 'none') saved = { ...saved, aiLevel: defaults.aiLevel, aiEnabled: false }
  const next: Record<string, unknown> = { ...defaults }
  for (const k of SERVER_KEYS) {
    const parse = SERVER_FIELDS[k] as Parse<Settings[typeof k]>
    next[k] = parse(saved[k], defaults[k])
  }
  for (const k of Object.keys(LOCAL_FIELDS) as (keyof typeof LOCAL_FIELDS)[]) {
    const parse = LOCAL_FIELDS[k] as Parse<Settings[typeof k]>
    next[k] = parse(saved[k], defaults[k])
  }
  const rawFeatures = (typeof saved.features === 'object' && saved.features !== null ? saved.features : {}) as Record<string, unknown>
  const features = { ...defaults.features }
  for (const key of Object.keys(features) as FeatureKey[]) features[key] = bool(rawFeatures[key], defaults.features[key])
  next.features = features
  return next as unknown as Settings
}

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return migrateLegacyTheme(DEFAULT_SETTINGS)
    return parseSettings(JSON.parse(raw))
  } catch {
    return DEFAULT_SETTINGS
  }
}

/** The pre-settings build stored only `jb-theme`; honour it so an existing choice isn't lost. */
function migrateLegacyTheme(base: Settings): Settings {
  try {
    const saved = localStorage.getItem('jb-theme')
    if (saved === 'dark' || saved === 'light') return { ...base, themeMode: 'fixed', theme: saved }
  } catch {
    /* file:// localStorage may be blocked */
  }
  return base
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s))
  } catch {
    /* file:// localStorage may be blocked */
  }
}

/** Should the board be dark right now, given the policy? */
export function resolveDark(s: Settings, at: Date = new Date()): boolean {
  if (s.themeMode === 'fixed') return s.theme === 'dark'
  if (s.themeMode === 'schedule') {
    const h = at.getHours()
    // A window that wraps midnight (e.g. 19→7) is still a single "day" span.
    const isDay = s.dayStart <= s.dayEnd ? h >= s.dayStart && h < s.dayEnd : h >= s.dayStart || h < s.dayEnd
    return !isDay
  }
  try {
    return !(typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: light)').matches)
  } catch {
    return true
  }
}

/** Apply the resolved theme (and the animation switch) to <html>. */
export function applySettings(s: Settings, at: Date = new Date()): void {
  const el = document.documentElement
  el.classList.toggle('dark', resolveDark(s, at))
  el.classList.toggle('jb-no-anim', !s.features.animations)
  setMotionEnabled(s.features.animations)
}
