import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { ACTIVE_CADENCE, AI_LEVELS, BOARD_CADENCE, FEATURES, LIMITS, REPORT_STYLES, clampSetting, type AiCloudProvider, type FeatureKey, type Settings } from '../../lib/settings'
import { getAiModels, getCloudModels, pullAiModel, guideUrl, type AiCatalogModel, type AiInternStatus, type AiPullProgress, type CloudModelChoice, type CloudListInfo, type CloudPrice, type OllamaContainerInfo } from '../../lib/runner'
import { DEFAULT_COSTLY_USD, groupByProvider, isPricey, levelAllows, levelPriceText, usd } from '../../lib/cloudModels'
import fallbackCatalog from '../../../ai-intern/models.json'
import { hexToRgba } from '../../lib/format'
import { useDialogFocus } from '../../hooks/useDialogFocus'
import { SectionPicker, type PickerOption } from './SectionPicker'
import { CalendarIcon, CheckIcon, ColumnIcon, DocIcon, DownloadIcon, FlaskIcon, MegaphoneIcon, MoonIcon, MoveIcon, PauseIcon, QuestionIcon, RefreshIcon, SearchIcon, SparkleIcon, SunIcon, TrophyIcon } from '../common/Icons'

const AI = '#a855f7'

type AppearanceKey = 'auto' | 'light' | 'dark' | 'schedule'

const APPEARANCE: { key: AppearanceKey; label: string; hint: string }[] = [
  { key: 'auto', label: 'Auto', hint: 'Follow the system appearance' },
  { key: 'light', label: 'Light', hint: 'Stay light all the time' },
  { key: 'dark', label: 'Dark', hint: 'Stay dark all the time' },
  { key: 'schedule', label: 'Time based', hint: 'Light by day, dark at night' },
]

function appearanceKey(s: Settings): AppearanceKey {
  if (s.themeMode === 'auto') return 'auto'
  if (s.themeMode === 'schedule') return 'schedule'
  return s.theme
}

function withAppearance(s: Settings, key: AppearanceKey): Settings {
  if (key === 'auto') return { ...s, themeMode: 'auto' }
  if (key === 'schedule') return { ...s, themeMode: 'schedule' }
  return { ...s, themeMode: 'fixed', theme: key }
}

const HOURS = Array.from({ length: 24 }, (_, i) => i)
const hourLabel = (h: number) => `${String(h).padStart(2, '0')}:00`

/**
 * `off` turns the whole card light grey (background, border, body) and makes the body inert (no focus, no clicks, hidden from assistive tech's
 * "interactive" list) — the header stays live so the reason ("switched off under Features") is readable.
 */
function Section({
  title,
  aside,
  children,
  className = '',
  off = false,
}: {
  title: string
  aside?: React.ReactNode
  children: React.ReactNode
  className?: string
  off?: boolean
}) {
  return (
    <section
      className={`flex min-w-0 flex-col rounded-xl border p-3 transition-[background-color,filter] ${
        off ? 'border-dashed border-[var(--line-strong)] bg-[var(--surface-2)] grayscale' : 'border-[var(--line)] bg-[var(--surface-solid)]'
      } ${className}`}
    >
      <div className="mb-2 flex h-4 items-center gap-3">
        <h3 className="shrink-0 text-[10.5px] font-bold uppercase tracking-wider text-[var(--muted)]">{title}</h3>
        {aside && <div className="ml-auto flex min-w-0 items-center text-[10.5px]">{aside}</div>}
      </div>
      <div
        className={`flex min-w-0 flex-1 flex-col transition-[opacity,filter] ${off ? 'pointer-events-none select-none opacity-40' : ''}`}
        inert={off}
        aria-disabled={off || undefined}
      >
        {children}
      </div>
    </section>
  )
}

/** Header note of a section its Features switch has turned off. */
function OffNote({ what }: { what: string }) {
  return (
    <span className="truncate font-semibold text-[var(--muted)]" title={`${what} is switched off — turn it back on under Features.`}>
      Off — turn on under Features
    </span>
  )
}

/** A tiny preview of each PDF look: Google's four colours, or the original multi-hue gradient. */
function ReportSwatch({ style }: { style: 'light' | 'colorful' }) {
  return (
    <span
      aria-hidden
      className="h-2 w-5 shrink-0 rounded-full"
      style={{
        background:
          style === 'light'
            ? 'linear-gradient(90deg,#4285f4 0 25%,#ea4335 25% 50%,#fbbc04 50% 75%,#34a853 75%)'
            : 'linear-gradient(90deg,#4f46e5,#0d9488,#ea580c,#7c3aed)',
      }}
    />
  )
}

function segmentStyle(active: boolean): React.CSSProperties {
  return active
    ? { background: hexToRgba(AI, 0.14), color: AI, boxShadow: `inset 0 0 0 1px ${hexToRgba(AI, 0.45)}` }
    : { color: 'var(--ink-soft)' }
}

const SEGMENT_BUTTON =
  'inline-flex h-full w-full min-w-0 items-center justify-center gap-1 rounded-md px-1.5 text-[11.5px] font-semibold transition-colors hover:text-[var(--ink)]'

/** Arrow / Home / End move the choice inside a radiogroup, as keyboard users expect. */
function onRadioKeys<T extends string>(e: React.KeyboardEvent<HTMLElement>, keys: readonly T[], value: T, onChange: (v: T) => void) {
  const i = Math.max(0, keys.indexOf(value))
  const next =
    e.key === 'ArrowRight' || e.key === 'ArrowDown'
      ? (i + 1) % keys.length
      : e.key === 'ArrowLeft' || e.key === 'ArrowUp'
        ? (i - 1 + keys.length) % keys.length
        : e.key === 'Home'
          ? 0
          : e.key === 'End'
            ? keys.length - 1
            : -1
  if (next < 0) return
  e.preventDefault()
  onChange(keys[next])
  const group = e.currentTarget
  requestAnimationFrame(() => group.querySelectorAll<HTMLElement>('[role="radio"]')[next]?.focus())
}

/** Only the chosen option is a tab stop; arrows move between the rest. */
const radioTabIndex = <T extends string>(keys: readonly T[], value: T, key: T) =>
  key === value || (!keys.includes(value) && key === keys[0]) ? 0 : -1

/** Equal-width single-choice control; it never changes size when the choice changes. */
function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string
  options: { key: T; label: string; hint?: string; icon?: React.ReactNode }[]
  value: T
  onChange: (v: T) => void
}) {
  const keys = options.map((o) => o.key)
  return (
    <div
      role="radiogroup"
      aria-label={label}
      onKeyDown={(e) => onRadioKeys(e, keys, value, onChange)}
      className="grid h-8 min-w-0 gap-0.5 rounded-lg border border-[var(--line)] bg-[var(--surface-2)] p-0.5"
      style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
    >
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          role="radio"
          aria-checked={o.key === value}
          tabIndex={radioTabIndex(keys, value, o.key)}
          title={o.hint}
          onClick={() => onChange(o.key)}
          className={SEGMENT_BUTTON}
          style={segmentStyle(o.key === value)}
        >
          {o.icon}
          <span className="truncate">{o.label}</span>
        </button>
      ))}
    </div>
  )
}

const LEVEL_KEYS = AI_LEVELS.map((l) => l.key)

/** AI usage as a segmented control; hovering a level shows its pros and cons. */
function AiLevelPicker({ value, onChange }: { value: Settings['aiLevel']; onChange: (v: Settings['aiLevel']) => void }) {
  const [tip, setTip] = useState<string | null>(null)
  return (
    <div
      role="radiogroup"
      aria-label="AI usage"
      onKeyDown={(e) => onRadioKeys(e, LEVEL_KEYS, value, onChange)}
      className="grid h-8 grid-cols-4 gap-0.5 rounded-lg border border-[var(--line)] bg-[var(--surface-2)] p-0.5"
    >
      {AI_LEVELS.map((level, i) => {
        const active = value === level.key
        return (
          // `flex`, not a plain block: an inline-flex button in a block wrapper is placed by its baseline.
          <div key={level.key} className="relative flex min-w-0" onMouseEnter={() => setTip(level.key)} onMouseLeave={() => setTip(null)}>
            <button
              type="button"
              role="radio"
              aria-checked={active}
              tabIndex={radioTabIndex(LEVEL_KEYS, value, level.key)}
              aria-describedby={tip === level.key ? `ai-level-${level.key}-tip` : undefined}
              onClick={() => onChange(level.key)}
              onFocus={() => setTip(level.key)}
              onBlur={() => setTip(null)}
              className={SEGMENT_BUTTON}
              style={segmentStyle(active)}
            >
              <SparkleIcon size={11} color={active ? AI : 'currentColor'} />
              <span className="truncate">{level.label}</span>
            </button>
            <AnimatePresence>
              {tip === level.key && (
                <motion.div
                  id={`ai-level-${level.key}-tip`}
                  role="tooltip"
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 4 }}
                  transition={{ duration: 0.14 }}
                  className={`pointer-events-none absolute top-[calc(100%+8px)] z-30 w-[220px] rounded-lg border px-2.5 py-2 text-[11px] leading-snug shadow-xl ${i >= 2 ? 'right-0' : 'left-0'}`}
                  style={{ borderColor: hexToRgba(AI, 0.4), background: 'var(--surface-solid)', color: 'var(--ink-soft)' }}
                >
                  <p className="mb-1.5 text-[11px] font-bold" style={{ color: AI }}>
                    {level.label} · {level.hint}
                  </p>
                  <p className="mb-0.5 text-[10px] font-bold uppercase tracking-wider text-[#16a34a]">Pros</p>
                  <ul className="mb-1.5 list-disc pl-3.5">
                    {level.plus.map((p) => (
                      <li key={p}>{p}</li>
                    ))}
                  </ul>
                  <p className="mb-0.5 text-[10px] font-bold uppercase tracking-wider text-[#dc2626]">Cons</p>
                  <ul className="list-disc pl-3.5">
                    {level.cons.map((c) => (
                      <li key={c}>{c}</li>
                    ))}
                  </ul>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        )
      })}
    </div>
  )
}

function internTone(ai: AiInternStatus | null | undefined): string {
  if (!ai || ai.down) return '#dc2626'
  if (ai.lastError) return '#f59e0b'
  if (ai.state === 'working' || ai.state === 'pulling') return AI
  return '#16a34a'
}

/**
 * The optional parts of the board you can show or hide. They live in ONE multi-select (SectionPicker)
 * rather than a switch card each; adding a section is one more key here and one in FEATURES.
 */
const SECTION_KEYS: FeatureKey[] = ['blocked', 'onHold', 'qaInProgress', 'nextSprint', 'completedArchive', 'raisedTickets']
/** Everything else is behaviour — a real on/off switch, in this order. */
const FEATURE_ORDER: FeatureKey[] = ['dragMove', 'moveReadiness', 'demoMode', 'prReports', 'aiBriefs', 'shortcuts', 'reloadActive', 'autoRefresh', 'animations']
/**
 * The AI-Ollama container is a Feature like the others, but it is a SERVER setting
 * (`ollamaEnabled`) rather than a `features` flag, because the server starts and stops the
 * container. Rendered in the Features grid; the AI section only shows its status.
 */
const OLLAMA_FEATURE = {
  key: 'ollamaContainer',
  label: 'AI-Ollama container',
  hint: 'Local models in Docker — needs a model in jira-intern/models/',
  detail:
    'Runs the AI-Ollama Docker container for Local AI. It only starts when this is on AND jira-intern/models/ contains a model — one pulled from the AI section, or a .gguf file you place there yourself. Off stops the container at once and keeps it off across restarts and deploys. Cloud AI never needs it.',
} as const
const OLLAMA_STYLE = { color: '#0ea5e9', icon: (c: string) => <SparkleIcon size={13} color={c} /> }

/**
 * The two master switches. Like the Ollama container they are SERVER settings (`aiEnabled`, `jobsEnabled`), not
 * `features` flags: the worker, the scheduler and the shell runners have to honour them. Turning one off greys its
 * section out; turning it back on restores everything as it was (no other setting is touched).
 */
const AI_FEATURE = {
  key: 'aiEnabled',
  label: 'AI',
  hint: 'Briefs, report write-ups, models — the whole AI section',
  detail:
    'Master switch for every AI feature. Off greys out the AI section and nothing AI runs: no ticket briefs, no AI write-up on PR reports (the deterministic report and its verdict are unchanged), no model downloads, and the AI-Ollama container is stopped. Your AI choices are kept — turn it back on and everything works as before.',
} as const
const AI_STYLE = { color: AI, icon: (c: string) => <SparkleIcon size={13} color={c} /> }
const JOBS_FEATURE = {
  key: 'jobsEnabled',
  label: 'Background jobs',
  hint: 'Scheduled refreshes and report runs on the server',
  detail:
    'Master switch for the jobs the server starts on its own: the active-ticket refresh, the whole-board rebuild, scheduled PR report runs, and the report pass that follows a fetch. Off greys out the Background jobs section. A refresh or report you start yourself still runs. Turning it back on restarts every schedule from that moment, so overdue jobs do not all fire at once.',
} as const
const JOBS_STYLE = { color: '#06b6d4', icon: (c: string) => <RefreshIcon size={13} color={c} /> }

const ORDERED_FEATURES = FEATURES.filter((f) => !SECTION_KEYS.includes(f.key)).sort((a, b) => {
  const rank = (k: FeatureKey) => (FEATURE_ORDER.includes(k) ? FEATURE_ORDER.indexOf(k) : FEATURE_ORDER.length)
  return rank(a.key) - rank(b.key)
})

/** Status strips in the AI card: one fixed height, so Local and Cloud rows line up exactly. */
const STRIP = 'flex h-8 min-w-0 items-center gap-2 rounded-lg border border-[var(--line)] bg-[var(--surface-2)] px-2.5 text-[11px] text-[var(--muted)]'

/**
 * AI-section row for the Ollama container: live status (the switch itself is a Feature — see
 * OLLAMA_FEATURE) plus a checkbox that only shows or hides the local-model list below.
 */
function OllamaStatusRow({
  enabled,
  info,
  showList,
  onShowList,
}: {
  enabled: boolean
  info: OllamaContainerInfo | null
  showList: boolean
  onShowList: (v: boolean) => void
}) {
  const dir = info?.modelsDir ?? 'jira-intern/models/'
  const models = info?.models ?? []
  const state = !info
    ? { text: 'needs the local server', color: '#94a3b8' }
    : !info.available
      ? { text: 'Docker socket not mounted — container follows compose', color: '#94a3b8' }
      : info.running
        ? { text: 'AI-Ollama running', color: '#22c55e' }
        : !enabled
          ? { text: 'AI-Ollama off — turn it on under Features', color: '#94a3b8' }
          : models.length === 0
            ? { text: `AI-Ollama waiting — no model in ${dir}`, color: '#f59e0b' }
            : { text: 'AI-Ollama starting…', color: '#3b82f6' }
  const title = [
    `${state.text}.`,
    `The container runs only while Features → AI-Ollama container is on AND ${dir} contains a model (pulled from the list below, or a .gguf placed there by hand).`,
    models.length ? `Found: ${models.join(', ')}` : `Nothing found in ${dir} yet.`,
  ].join('\n')
  return (
    <div className={STRIP} title={title}>
      <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: state.color }} />
      <span className="min-w-0 truncate font-medium">
        {state.text}
        {models.length > 0 && ` · ${models.length} model${models.length === 1 ? '' : 's'} in ${dir}`}
      </span>
      <label className="ml-auto flex shrink-0 cursor-pointer items-center gap-1.5 font-semibold text-[var(--ink-soft)]" title="Show or hide the local model list below. Display only — it does not start or stop the container.">
        <input type="checkbox" checked={showList} onChange={(e) => onShowList(e.target.checked)} />
        Model list
      </label>
    </div>
  )
}

export function SettingsPanel({
  open,
  settings: saved,
  onChange: commit,
  onClose,
  aiLevelSynced,
  aiStatus,
}: {
  open: boolean
  settings: Settings
  onChange: (next: Settings) => void
  onClose: () => void
  /** false when the AI level is local-only because there is no server to tell. */
  aiLevelSynced: boolean
  aiStatus?: AiInternStatus | null
}) {
  const [draft, setDraft] = useState(saved)
  const wasOpen = useRef(false)
  const panelRef = useRef<HTMLElement>(null)
  useDialogFocus(open, panelRef)
  useEffect(() => {
    if (open && !wasOpen.current) setDraft(saved)
    wasOpen.current = open
  }, [open, saved])

  const settings = draft
  const onChange = setDraft

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopImmediatePropagation()
      e.preventDefault()
      onClose()
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [open, onClose])

  const set = <K extends keyof Settings>(key: K, value: Settings[K]) => onChange({ ...settings, [key]: value })
  const setFeature = (key: keyof Settings['features'], value: boolean) =>
    onChange({ ...settings, features: { ...settings.features, [key]: value } })
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved)
  const save = () => {
    if (!dirty) return
    commit(draft)
    onClose()
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-[90] flex items-center justify-center overflow-hidden bg-black/60 p-3 backdrop-blur-sm"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
          role="dialog"
          aria-modal
          aria-label="Board settings"
        >
          <motion.section
            ref={panelRef}
            tabIndex={-1}
            className="jb-dialog-panel flex max-h-[calc(100dvh-24px)] w-[min(960px,calc(100vw-24px))] flex-col overflow-visible rounded-2xl border border-[var(--line)] bg-[var(--bg)] shadow-2xl"
            initial={{ y: 20, scale: 0.98 }}
            animate={{ y: 0, scale: 1 }}
            exit={{ y: 12, scale: 0.98 }}
            transition={{ type: 'spring', stiffness: 320, damping: 32 }}
            onClick={(e) => e.stopPropagation()}
          >
            <header className="flex shrink-0 items-center gap-2 border-b border-[var(--line)] px-4 py-2.5">
              <h2 className="text-[15px] font-extrabold text-[var(--ink)]">Settings</h2>
              <span className={`ml-auto text-[11px] font-medium text-[var(--muted)] ${dirty ? '' : 'invisible'}`} aria-live="polite">
                Unsaved changes
              </span>
              <button
                type="button"
                onClick={save}
                disabled={!dirty}
                className="h-8 rounded-lg px-3.5 text-[12px] font-bold text-white transition-opacity disabled:cursor-default disabled:opacity-40"
                style={{ background: AI }}
                title={dirty ? 'Save and close' : 'Nothing changed yet'}
              >
                Save
              </button>
              <button
                type="button"
                onClick={onClose}
                className="grid h-8 w-8 place-items-center rounded-lg border border-[var(--line)] text-[var(--muted)] hover:border-[var(--muted)] hover:text-[var(--ink)]"
                aria-label="Close settings without saving"
                title="Close without saving (Esc)"
              >
                ✕
              </button>
            </header>

            <div className="grid min-h-0 grid-cols-[minmax(0,1fr)] gap-3 px-4 pb-4 pt-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
              <div className="flex min-w-0 flex-col gap-3">
                <Section title="Appearance">
                  <Segmented
                    label="Appearance"
                    options={APPEARANCE.map((m) => ({
                      key: m.key,
                      label: m.label,
                      hint: m.hint,
                      icon: m.key === 'light' ? <SunIcon size={12} /> : m.key === 'dark' ? <MoonIcon size={12} /> : undefined,
                    }))}
                    value={appearanceKey(settings)}
                    onChange={(k) => onChange(withAppearance(settings, k))}
                  />
                  {/* One fixed slot: the hint, or the hour pickers for Time based. */}
                  <div className="relative mt-1.5 h-8">
                    <div
                      className={`absolute inset-0 flex items-center gap-2 text-[12px] text-[var(--ink-soft)] ${settings.themeMode === 'schedule' ? '' : 'invisible'}`}
                      aria-hidden={settings.themeMode !== 'schedule'}
                    >
                      <span>Light from</span>
                      <HourSelect value={settings.dayStart} onChange={(v) => set('dayStart', v)} disabled={settings.themeMode !== 'schedule'} />
                      <span>to</span>
                      <HourSelect value={settings.dayEnd} onChange={(v) => set('dayEnd', v)} disabled={settings.themeMode !== 'schedule'} />
                      <span className="truncate text-[var(--muted)]">· dark otherwise</span>
                    </div>
                    <p className={`absolute inset-0 flex items-center truncate text-[11.5px] text-[var(--muted)] ${settings.themeMode === 'schedule' ? 'invisible' : ''}`}>
                      {APPEARANCE.find((m) => m.key === appearanceKey(settings))?.hint}
                    </p>
                  </div>
                </Section>

                <Section title="PDF report">
                  <Segmented
                    label="PDF report style"
                    options={REPORT_STYLES.map((r) => ({
                      key: r.key,
                      label: r.label,
                      icon: <ReportSwatch style={r.key} />,
                    }))}
                    value={settings.reportStyle}
                    onChange={(k) => set('reportStyle', k)}
                  />
                </Section>

                <Section title="Notifications">
                  <div className="grid grid-cols-2 gap-x-3">
                    <label className="flex h-8 min-w-0 items-center gap-2 text-[11.5px] font-semibold text-[var(--ink-soft)]">
                      <span className="shrink-0">Close after</span>
                      <NumberBox label="Seconds a notification stays" hint="Seconds a notification stays before it closes itself" limit="toastSeconds" value={settings.toastSeconds} onChange={(v) => set('toastSeconds', v)} className="w-[4.75rem]" />
                      <span className="shrink-0 font-normal text-[var(--muted)]">sec</span>
                    </label>
                    <label className="flex h-8 min-w-0 items-center gap-2 text-[11.5px] font-semibold text-[var(--ink-soft)]">
                      <span className="shrink-0">Show at most</span>
                      <NumberBox label="Notifications on screen" hint="More than this wait their turn and appear as earlier ones close" limit="toastMax" value={settings.toastMax} onChange={(v) => set('toastMax', v)} className="w-[4.75rem]" />
                    </label>
                  </div>
                </Section>

                <Section
                  title="Background jobs"
                  off={!settings.jobsEnabled}
                  aside={
                    !settings.jobsEnabled ? (
                      <OffNote what="Background jobs" />
                    ) : (
                      !aiLevelSynced && (
                        <span className="truncate font-semibold text-[#d97706]" title="Schedules and parallel limits apply only while the local server is running.">
                          Server offline — not applied
                        </span>
                      )
                    )
                  }
                >
                  <div className="grid grid-cols-[3.5rem_repeat(3,minmax(0,1fr))] items-center gap-x-2 gap-y-1.5">
                    <span aria-hidden />
                    <JobHead label="Active tickets" hint="Tickets still in flight" />
                    <JobHead label="Whole board" hint="Active tickets, then the Completed archive" />
                    <JobHead label="PR reports" hint="Reports that are stale, missing or under 100" />

                    <RowHead label="Runs" hint="How often the server starts this job on its own" />
                    <CadenceSelect label="Active tickets schedule" value={settings.activeRefresh} options={ACTIVE_CADENCE} onChange={(v) => set('activeRefresh', v)} />
                    <CadenceSelect label="Whole board schedule" value={settings.fullRefresh} options={BOARD_CADENCE} onChange={(v) => set('fullRefresh', v)} />
                    <CadenceSelect label="PR reports schedule" value={settings.reportRefresh} options={BOARD_CADENCE} onChange={(v) => set('reportRefresh', v)} />

                    <RowHead label="At once" hint="How many tickets each job works on in parallel" />
                    <NumberBox label="Active tickets fetched at once" hint="Tickets fetched at once when refreshing the dashboard" limit="refreshParallel" value={settings.refreshParallel} onChange={(v) => set('refreshParallel', v)} />
                    <NumberBox label="Archive tickets fetched at once" hint="Tickets fetched at once when rebuilding the Completed archive" limit="archiveParallel" value={settings.archiveParallel} onChange={(v) => set('archiveParallel', v)} />
                    <NumberBox label="PR reports built at once" hint="AI reports built at once when regenerating" limit="reportParallel" value={settings.reportParallel} onChange={(v) => set('reportParallel', v)} />
                  </div>
                </Section>
              </div>

              <div className="flex min-w-0 flex-col">
                <Section
                  title="AI"
                  off={!settings.aiEnabled}
                  aside={
                    !settings.aiEnabled ? (
                      <OffNote what="AI" />
                    ) : aiLevelSynced ? (
                      <span className="flex min-w-0 items-center gap-1.5 text-[var(--ink-soft)]" title={internLine(aiStatus)}>
                        <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: internTone(aiStatus) }} />
                        <span className="truncate">{internLine(aiStatus)}</span>
                      </span>
                    ) : (
                      <span className="truncate text-[var(--muted)]">Saved on this device only</span>
                    )
                  }
                >
                  <div className="flex h-full flex-col gap-3">
                    <div>
                      <AiLevelPicker value={settings.aiLevel} onChange={(v) => set('aiLevel', v)} />
                      <p className="mt-1.5 h-4 truncate text-[11px] leading-4 text-[var(--muted)]">
                        {AI_LEVELS.find((l) => l.key === settings.aiLevel)?.hint} · applies from the next report
                      </p>
                    </div>
                    <div className="flex min-h-0 flex-1 flex-col">
                      {aiLevelSynced ? (
                        <AiInternControls settings={settings} onChange={onChange} aiStatus={aiStatus} />
                      ) : (
                        <p className="grid flex-1 place-items-center rounded-lg border border-dashed border-[var(--line)] px-3 text-center text-[11.5px] text-[var(--muted)]">
                          Local or Cloud AI and the model picker need AI-Intern running.
                        </p>
                      )}
                    </div>
                  </div>
                </Section>

              </div>

              <Section
                title="Board sections"
                className="md:col-span-2"
                aside={
                  <span className="text-[var(--muted)]">
                    {SECTION_KEYS.filter((k) => settings.features[k]).length} of {SECTION_KEYS.length} shown
                  </span>
                }
              >
                <SectionPicker
                  label="Board sections"
                  options={SECTION_OPTIONS}
                  selected={new Set(SECTION_KEYS.filter((k) => settings.features[k]))}
                  onToggle={(key, on) => setFeature(key as FeatureKey, on)}
                  onSetAll={(on) => onChange({ ...settings, features: { ...settings.features, ...Object.fromEntries(SECTION_KEYS.map((k) => [k, on])) } })}
                  emptyText="No optional sections — the board shows only the active columns."
                />
              </Section>

              <Section
                title="Features"
                className="md:col-span-2"
                aside={
                  <span className="text-[var(--muted)]">
                    {ORDERED_FEATURES.filter((f) => settings.features[f.key]).length + [settings.aiEnabled, settings.jobsEnabled, settings.ollamaEnabled].filter(Boolean).length} of {ORDERED_FEATURES.length + 3} on
                  </span>
                }
              >
                <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-3">
                  <FeatureCard feature={AI_FEATURE} style={AI_STYLE} on={settings.aiEnabled} onToggle={(v) => set('aiEnabled', v)} />
                  <FeatureCard feature={JOBS_FEATURE} style={JOBS_STYLE} on={settings.jobsEnabled} onToggle={(v) => set('jobsEnabled', v)} />
                  {ORDERED_FEATURES.map((f) => (
                    <FeatureCard
                      key={f.key}
                      feature={f}
                      style={FEATURE_STYLE[f.key]}
                      on={settings.features[f.key]}
                      onToggle={(v) => setFeature(f.key, v)}
                      disabled={f.key === 'aiBriefs' && !settings.aiEnabled}
                      disabledHint="Turn on AI first"
                    />
                  ))}
                  <FeatureCard
                    feature={OLLAMA_FEATURE}
                    style={OLLAMA_STYLE}
                    on={settings.ollamaEnabled}
                    onToggle={(v) => onChange({ ...settings, ollamaEnabled: v })}
                    disabled={!aiLevelSynced || !settings.aiEnabled}
                    disabledHint={settings.aiEnabled ? 'Needs the local server (the container is started and stopped by it)' : 'Turn on AI first'}
                  />
                </div>
              </Section>
            </div>
          </motion.section>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

/** Each feature carries its own accent so an enabled board reads as a set of live controls
 *  rather than six identical purple boxes. Off = no accent at all, deliberately inert. */
const FEATURE_STYLE: Record<FeatureKey, { color: string; icon: (c: string) => React.ReactNode }> = {
  prReports: { color: '#a855f7', icon: (c) => <DocIcon size={13} color={c} /> },
  nextSprint: { color: '#2684ff', icon: (c) => <CalendarIcon size={13} color={c} /> },
  completedArchive: { color: '#b45309', icon: () => <TrophyIcon size={13} /> },
  raisedTickets: { color: '#6366f1', icon: (c) => <MegaphoneIcon size={13} color={c} /> },
  animations: { color: '#ec4899', icon: (c) => <SparkleIcon size={13} color={c} /> },
  shortcuts: { color: '#14b8a6', icon: (c) => <SearchIcon size={13} color={c} /> },
  autoRefresh: { color: '#10b981', icon: (c) => <RefreshIcon size={13} color={c} /> },
  aiBriefs: { color: '#a855f7', icon: (c) => <SparkleIcon size={13} color={c} /> },
  onHold: { color: '#ff8a1f', icon: (c) => <PauseIcon size={13} color={c} /> },
  blocked: { color: '#fb3f5f', icon: (c) => <ColumnIcon col="blocked" color={c} size={13} /> },
  qaInProgress: { color: '#5f9a93', icon: (c) => <ColumnIcon col="qa" color={c} size={13} /> },
  dragMove: { color: '#8b5cf6', icon: (c) => <MoveIcon size={13} color={c} /> },
  moveReadiness: { color: '#17c47a', icon: (c) => <CheckIcon size={13} color={c} /> },
  demoMode: { color: '#f59e0b', icon: (c) => <FlaskIcon size={13} color={c} /> },
  reloadActive: { color: '#0ea5e9', icon: (c) => <DownloadIcon size={13} color={c} /> },
}

/** The picker's rows, built from the registry so the label/hint/detail never drift from FEATURES. */
const SECTION_OPTIONS: PickerOption[] = SECTION_KEYS.map((key) => {
  const f = FEATURES.find((x) => x.key === key)!
  return { key, label: f.label, chipLabel: f.label.replace(/ section$/i, ''), hint: f.hint, detail: f.detail, color: FEATURE_STYLE[key].color, icon: FEATURE_STYLE[key].icon }
})

function FeatureCard({
  feature,
  style,
  on,
  onToggle,
  disabled = false,
  disabledHint,
}: {
  feature: { label: string; hint: string; detail: string }
  style: { color: string; icon: (c: string) => ReactNode }
  on: boolean
  onToggle: (v: boolean) => void
  disabled?: boolean
  disabledHint?: string
}) {
  const { color, icon } = style

  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-disabled={disabled || undefined}
      aria-label={`${feature.label}, ${on ? 'on' : 'off'}. ${feature.hint}`}
      title={disabled && disabledHint ? `${disabledHint}\n\n${feature.detail}` : feature.detail}
      onClick={() => !disabled && onToggle(!on)}
      className={`glass-interactive flex h-11 w-full min-w-0 items-center gap-2 rounded-lg border px-2.5 text-left transition-colors ${disabled ? 'cursor-not-allowed opacity-50' : ''}`}
      style={{
        borderColor: on ? hexToRgba(color, 0.45) : 'var(--line)',
        background: on ? hexToRgba(color, 0.08) : 'var(--surface-2)',
      }}
    >
      <span
        className="grid h-6 w-6 shrink-0 place-items-center rounded-md"
        style={{ background: hexToRgba(on ? color : '#94a3b8', 0.16), filter: on ? undefined : 'grayscale(1)', opacity: on ? 1 : 0.7 }}
      >
        {icon(on ? color : 'var(--muted)')}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[11.5px] font-bold leading-tight" style={{ color: on ? 'var(--ink)' : 'var(--muted)' }}>
          {feature.label}
        </span>
        <span className="mt-0.5 block truncate text-[10.5px] leading-tight text-[var(--muted)]">{feature.hint}</span>
      </span>
      <span
        aria-hidden
        className="relative h-4 w-7 shrink-0 rounded-full transition-colors"
        style={{ background: on ? color : 'var(--line-strong)' }}
      >
        <span
          className="absolute top-0.5 h-3 w-3 rounded-full bg-white shadow transition-[left]"
          style={{ left: on ? 'calc(100% - 14px)' : '2px' }}
        />
      </span>
    </button>
  )
}

const CADENCE_LABEL: Record<string, string> = {
  off: 'Off',
  daily: 'Daily',
  'twice-daily': 'Twice a day',
  weekly: 'Weekly',
  'twice-weekly': 'Twice a week',
}

function JobHead({ label, hint }: { label: string; hint: string }) {
  return (
    <span className="truncate text-[11px] font-semibold text-[var(--ink-soft)]" title={hint}>
      {label}
    </span>
  )
}

function RowHead({ label, hint }: { label: string; hint: string }) {
  return (
    <span className="truncate text-[11px] font-medium text-[var(--muted)]" title={hint}>
      {label}
    </span>
  )
}

function CadenceSelect<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: T
  options: readonly T[]
  onChange: (v: T) => void
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as T)}
      className="jb-field h-8 w-full min-w-0 rounded-lg border border-[var(--line)] bg-[var(--bg)] px-1.5 text-[11.5px] text-[var(--ink)]"
      aria-label={label}
    >
      {options.map((option) => (
        <option key={option} value={option}>
          {CADENCE_LABEL[option] ?? option}
        </option>
      ))}
    </select>
  )
}

/** Number input with its allowed range shown inside the box, so no extra line is needed. */
function NumberBox({
  label,
  hint,
  limit,
  value,
  onChange,
  className = 'w-full',
}: {
  label: string
  hint: string
  limit: keyof typeof LIMITS
  value: number
  onChange: (v: number) => void
  className?: string
}) {
  const { min, max } = LIMITS[limit]
  const [text, setText] = useState(String(value))
  useEffect(() => setText(String(value)), [value])
  const commit = (raw: string) => {
    const v = clampSetting(limit, raw, value)
    setText(String(v))
    if (v !== value) onChange(v)
  }
  return (
    <span className={`relative flex min-w-0 ${className}`} title={`${hint} (${min}–${max})`}>
      <input
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        step={1}
        value={text}
        onChange={(e) => {
          setText(e.target.value)
          const n = Number(e.target.value)
          if (e.target.value !== '' && Number.isInteger(n) && n >= min && n <= max) onChange(n)
        }}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit((e.target as HTMLInputElement).value)
        }}
        className="jb-field h-8 w-full min-w-0 rounded-lg border border-[var(--line)] bg-[var(--bg)] pl-2 pr-9 text-[12px] font-semibold tabular-nums text-[var(--ink)] [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
        aria-label={`${label}, ${min} to ${max}`}
      />
      <span className="pointer-events-none absolute inset-y-0 right-2 flex items-center text-[10px] tabular-nums text-[var(--muted)]">
        {min}–{max}
      </span>
    </span>
  )
}

function HourSelect({ value, onChange, disabled }: { value: number; onChange: (v: number) => void; disabled?: boolean }) {
  return (
    <select
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(Number(e.target.value))}
      className="jb-field h-8 rounded-lg border border-[var(--line)] bg-[var(--bg)] px-1.5 text-[12px] text-[var(--ink)] disabled:opacity-60"
    >
      {HOURS.map((h) => (
        <option key={h} value={h}>
          {hourLabel(h)}
        </option>
      ))}
    </select>
  )
}

function internLine(ai: AiInternStatus | null | undefined): string {
  if (!ai || ai.down) return 'AI intern is down — reports stay deterministic until AI-Intern is running'
  if (ai.state === 'pulling') {
    const name = ai.pulling || ai.current?.model || 'model'
    const pct = ai.pullProgress?.percent
    return typeof pct === 'number' && pct > 0
      ? `Downloading ${name} · ${pct}%`
      : `Downloading ${name}…`
  }
  if (ai.state === 'working' && ai.current?.type === 'enrich-report') return `Enriching ${ai.current.key}`
  if (ai.state === 'working' && ai.current?.type === 'summarize-active') return 'Writing ticket briefs…'
  if (ai.state === 'working') return `Working · ${ai.current?.type || 'job'}`
  if (ai.lastError) return `Last error: ${ai.lastError}`
  const installed = ai.installedModels || []
  if ((ai.backend || 'local') === 'local' && installed.length === 0) return 'No model downloaded — choose one and download it'
  return `Idle · ${ai.backend || 'local'} · ${ai.model || '—'}`
}

function modelInstalled(installed: string[], id: string): boolean {
  return installed.some((n) => n === id || n.startsWith(`${id}`))
}

function AiInternControls({
  settings,
  onChange,
  aiStatus,
}: {
  settings: Settings
  onChange: (next: Settings) => void
  aiStatus?: AiInternStatus | null
}) {
  const fallback = (fallbackCatalog.models ?? []) as AiCatalogModel[]
  const [catalog, setCatalog] = useState<AiCatalogModel[]>(aiStatus?.catalog?.models?.length ? aiStatus.catalog.models : fallback)
  const [installed, setInstalled] = useState<string[]>(aiStatus?.installedModels ?? [])
  const [pulling, setPulling] = useState<string | null>(aiStatus?.pulling ?? null)
  const [pullFailed, setPullFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    void getAiModels().then((m) => {
      if (cancelled || !m) return
      if (m.catalog?.models?.length) setCatalog(m.catalog.models)
      else setCatalog(fallback)
      if (m.installed) setInstalled(m.installed)
    })
    return () => {
      cancelled = true
    }
  }, [aiStatus?.state, aiStatus?.installedModels?.length])

  useEffect(() => {
    if (aiStatus?.installedModels) setInstalled(aiStatus.installedModels)
    if (aiStatus?.catalog?.models?.length) setCatalog(aiStatus.catalog.models)
    setPulling(aiStatus?.pulling ?? (aiStatus?.state === 'pulling' ? aiStatus.current?.model ?? null : null))
  }, [aiStatus])

  useEffect(() => {
    if (aiStatus?.lastError) console.error('[jira-ai]', aiStatus.lastError)
  }, [aiStatus?.lastError])

  const set = <K extends keyof Settings>(key: K, value: Settings[K]) => onChange({ ...settings, [key]: value })

  const isCloud = settings.aiBackend === 'cloud'
  const provider = cloudProviderOf(settings)
  const cloud = useCloudModels(isCloud ? provider : null)
  // Same pick as LocalModelPicker: the saved tag, or the catalog's first entry when none is saved.
  const localModel = catalog.find((m) => m.id === settings.aiLocalModel) ?? (settings.aiLocalModel ? null : (catalog[0] ?? null))

  return (
    // Fixed rows, identical for Local and Cloud, so switching never moves anything:
    // backend · status strip · model picker + note · facts (fills whatever height the card has).
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="grid grid-cols-2 gap-1.5">
        <Segmented
          label="AI backend"
          options={[
            { key: 'local', label: 'Local AI', hint: 'Ollama in Docker (CPU) or on this Mac (Metal). Slow, no tokens. Needs the AI-Ollama container (toggle below) or Host Ollama.' },
            { key: 'cloud', label: 'Cloud AI', hint: 'Claude, Cursor, or Gemini. Add the key with the key button in the header.' },
          ]}
          value={settings.aiBackend}
          onChange={(v) => set('aiBackend', v)}
        />
        {settings.aiBackend === 'cloud' ? (
          <Segmented
            label="Cloud provider"
            options={[
              { key: 'cursor', label: 'Cursor', hint: 'Cursor Cloud Agents API' },
              { key: 'gemini', label: 'Gemini', hint: 'Google Gemini API' },
              { key: 'claude', label: 'Claude', hint: 'Anthropic Messages API' },
            ]}
            value={cloudProviderOf(settings)}
            onChange={(p) => onChange({ ...settings, aiCloudProvider: p, aiCloudModel: '' })}
          />
        ) : (
          <label
            className="flex h-8 min-w-0 cursor-pointer items-center gap-2 rounded-lg border border-[var(--line)] bg-[var(--surface-2)] px-2.5 text-[11.5px] font-semibold text-[var(--ink-soft)]"
            title="Talk to Ollama.app on this Mac (Metal) instead of the Linux Docker VM"
          >
            <input type="checkbox" checked={settings.aiUseHostOllama} onChange={(e) => set('aiUseHostOllama', e.target.checked)} />
            <span className="truncate">Host Ollama · Metal</span>
          </label>
        )}
      </div>

      {isCloud ? (
        <CloudKeyRow provider={provider} cloud={cloud} />
      ) : (
        <OllamaStatusRow enabled={settings.ollamaEnabled} info={aiStatus?.container ?? null} showList={settings.showLocalModels} onShowList={(v) => set('showLocalModels', v)} />
      )}

      {/* Picker row + its two-line note: 76px in every state (loading, downloading, hidden list). */}
      <div className="flex h-[4.75rem] min-w-0 flex-col gap-1.5">
        {isCloud ? (
          <CloudModelPicker settings={settings} onChange={onChange} cloud={cloud} />
        ) : settings.showLocalModels ? (
          <LocalModelPicker
            catalog={catalog}
            installed={installed}
            pulling={pulling}
            pullProgress={aiStatus?.state === 'pulling' ? aiStatus.pullProgress ?? null : null}
            failed={pullFailed}
            settings={settings}
            onSelect={(id) => set('aiLocalModel', id)}
            onDownload={async (m) => {
              setPulling(m.id)
              setPullFailed(false)
              const ok = await pullAiModel(m.pull, settings.aiUseHostOllama || m.fits === 'host')
              if (!ok) {
                console.error('[jira-ai] pull enqueue failed', m.pull)
                setPulling(null)
                setPullFailed(true)
              }
            }}
          />
        ) : (
          <>
            <div className="flex h-8 min-w-0 items-center rounded-lg border border-dashed border-[var(--line)] px-2.5 text-[11.5px] text-[var(--muted)]">
              <span className="min-w-0 truncate">
                Using <code className="font-mono text-[11px] text-[var(--ink-soft)]">{localModel?.label ?? (settings.aiLocalModel || 'the default model')}</code>
              </span>
            </div>
            <p className="h-8 line-clamp-2 text-[10.5px] leading-4 text-[var(--muted)]">Model list hidden — tick Model list above to change or download a model.</p>
          </>
        )}
      </div>

      <AiFacts settings={settings} aiStatus={aiStatus ?? null} cloudModel={cloud?.models.find((m) => m.id === settings.aiCloudModel) ?? null} localModel={localModel} installed={installed} pulling={pulling} />
    </div>
  )
}

function cloudProviderOf(s: Settings): 'claude' | 'cursor' | 'gemini' {
  return s.aiCloudProvider === 'claude' || s.aiCloudProvider === 'gemini' ? s.aiCloudProvider : 'cursor'
}

/** The models themselves come from ai-intern/cloud-models.json; these are per-provider texts. */
const CLOUD_PROVIDER_INFO: Record<
  AiCloudProvider,
  { label: string; missingKey: string; about: string; prefer: (models: CloudModelChoice[]) => CloudModelChoice }
> = {
  cursor: {
    label: 'Cursor',
    missingKey: 'Add CURSOR_API_KEY with the key button in the header (Cursor Dashboard → API Keys).',
    about: 'The Cursor models listed in cloud-models.json. ⚠ marks the costly ones (Max only).',
    // GPT-5.6 Luna: cheapest of the capable models, and what most installs already use.
    prefer: (models) => models.find((m) => /luna/i.test(m.id)) || models[0],
  },
  claude: {
    label: 'Claude',
    missingKey: 'Add ANTHROPIC_API_KEY with the key button in the header (console.anthropic.com → API keys).',
    about: 'The Claude models listed in cloud-models.json. ⚠ marks the costly ones (Max only).',
    prefer: (models) => models.find((m) => /haiku/i.test(m.id)) || models[0],
  },
  gemini: {
    label: 'Gemini',
    missingKey: 'Add GEMINI_API_KEY with the key button in the header (aistudio.google.com → API keys).',
    about: 'The Gemini models listed in cloud-models.json. ⚠ marks the costly ones (Max only).',
    prefer: (models) => models[0],
  },
}

interface CloudModels {
  provider: AiCloudProvider
  models: CloudModelChoice[]
  error: string | null
  hasKey: boolean
  /** What the worker made of cloud-models.json for this provider. */
  info?: CloudListInfo
}

/** The provider's model list and key status, loaded once per provider switch (null while loading). */
function useCloudModels(provider: AiCloudProvider | null): CloudModels | null {
  const [loaded, setLoaded] = useState<CloudModels | null>(null)
  useEffect(() => {
    if (!provider) return
    let cancelled = false
    setLoaded(null)
    void getCloudModels().then((res) => {
      if (cancelled || !res) return
      const entry = res[provider]
      setLoaded({ provider, models: entry?.models ?? [], error: entry?.error ?? res.error ?? null, hasKey: !!entry?.configured, info: entry?.info })
    })
    return () => {
      cancelled = true
    }
  }, [provider])
  return loaded && loaded.provider === provider ? loaded : null
}

/** Which key the intern reads for each provider, and who bills for it. */
const CLOUD_KEYS: Record<AiCloudProvider, { env: string; biller: string }> = {
  cursor: { env: 'CURSOR_API_KEY', biller: 'Cursor' },
  claude: { env: 'ANTHROPIC_API_KEY', biller: 'Anthropic' },
  gemini: { env: 'GEMINI_API_KEY', biller: 'Google' },
}

/** Cloud counterpart of the Ollama strip: is the key there, and how many models cloud-models.json offers. */
function CloudKeyRow({ provider, cloud }: { provider: AiCloudProvider; cloud: CloudModels | null }) {
  const k = CLOUD_KEYS[provider]
  const n = cloud?.models.length ?? 0
  const info = cloud?.info
  // The list is cloud-models.json: say how long it is and how many are costly, so a short list is explained.
  const detail = `${n} model${n === 1 ? '' : 's'}${info?.costly ? ` · ${info.costly} costly (≥ $${info.costlyUsd})` : ''}`
  const state = !cloud
    ? { text: `Checking ${k.env}…`, color: '#94a3b8' }
    : !cloud.hasKey
      ? { text: `${k.env} missing — add it with the key button in the header`, color: '#f59e0b' }
      : cloud.error
        ? { text: cloud.error, color: '#f59e0b' }
        : { text: `${k.env} found · ${detail}`, color: '#22c55e' }
  const problems = info?.problems?.length ? `\nIn cloud-models.json: ${info.problems.join('; ')}.` : ''
  return (
    <div
      className={STRIP}
      title={`${state.text}.\nThe list — which models, their efforts, what counts as costly — is ai-intern/cloud-models.json: add or delete a model there and it appears here within a minute.${problems}\nThe key is read from setup/.env (saved with the key button in the header); usage is billed by ${k.biller} to that key's account.`}
    >
      <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: state.color }} />
      <span className="min-w-0 truncate font-medium">{state.text}</span>
      <span className="ml-auto shrink-0 font-semibold text-[var(--ink-soft)]">Billed by {k.biller}</span>
    </div>
  )
}

function CloudModelPicker({
  settings,
  onChange,
  cloud,
}: {
  settings: Settings
  onChange: (s: Settings) => void
  cloud: CloudModels | null
}) {
  const provider = cloudProviderOf(settings)
  const info = CLOUD_PROVIDER_INFO[provider]
  const ready = cloud !== null
  const models = useMemo(() => cloud?.models ?? [], [cloud])
  const hasKey = !!cloud?.hasKey
  const selected = models.find((m) => m.id === settings.aiCloudModel) ?? null
  // The level decides which models are selectable (cloudModels.ts::levelAllows: Low ≤ $1 · Medium ≤ $5 · High < $10 · Max all);
  // the rest stay in the list, greyed out. Effort has no control of its own any more: the level sets it
  // (lib/settings.ts::effortForLevel), and a costly model always runs at Medium.
  const level = settings.aiLevel
  const fits = (m: CloudModelChoice) => levelAllows(level, m)
  const selectable = models.filter(fits)

  // Only pre-fill an EMPTY draft (nothing ever saved, or the provider was just switched — both
  // cases where the user is already choosing). Overwriting a saved model that merely isn't in this
  // provider's list made the panel show "Unsaved changes" the moment it opened.
  useEffect(() => {
    if (!models.length || settings.aiCloudModel !== '') return
    onChange({ ...settings, aiCloudModel: info.prefer(selectable.length ? selectable : models).id })
  }, [models, selectable, info, settings, onChange])

  // Changing the level can leave the selected model outside it — a choice the worker would refuse to run: move to the
  // provider's preferred model among those the new level covers. Only a change of level triggers it — a saved model
  // is left alone when the panel merely opens (that would show "Unsaved changes" with nothing touched).
  const lastLevel = useRef(settings.aiLevel)
  useEffect(() => {
    const was = lastLevel.current
    lastLevel.current = settings.aiLevel
    if (was === settings.aiLevel || !selected || levelAllows(settings.aiLevel, selected)) return
    const allowed = models.filter((m) => levelAllows(settings.aiLevel, m))
    if (allowed.length) onChange({ ...settings, aiCloudModel: info.prefer(allowed).id })
  }, [settings, selected, models, info, onChange])

  // Costly (cloud-models.json: output at or above its costlyOutputUsd): the red ⚠ at the right of the row, and this line, say so where it is chosen.
  const pricey = isPricey(selected)
  const costlyLine = cloud?.info?.costlyUsd ?? DEFAULT_COSTLY_USD
  const levelLabel = AI_LEVELS.find((l) => l.key === level)?.label ?? level
  const selectedFits = !selected || fits(selected)
  const hint = !ready
    ? 'Loading the model list…'
    : !hasKey
      ? info.missingKey
      : !selectedFits
        ? `${selected.label} is outside ${levelLabel} (${levelPriceText(level)}) — it will not run. Pick a listed model or raise the level.`
        : pricey
          ? `Costly model (at or above $${costlyLine} per 1M output tokens). It runs at Medium effort.`
          : (cloud.error ??
            (!models.length || selectable.length === models.length
              ? info.about
              : selectable.length
                ? `${levelLabel} covers models ${levelPriceText(level)} — the greyed ones need a higher level.`
                : `No ${info.label} model fits ${levelLabel} (${levelPriceText(level)}) — raise the level.`))

  return (
    <>
      <div className="relative flex h-8 items-center gap-1.5">
        <select
          value={selected?.id ?? ''}
          onChange={(e) => onChange({ ...settings, aiCloudModel: e.target.value })}
          aria-label={`${info.label} model`}
          disabled={!models.length}
          className="jb-field h-8 min-w-0 flex-1 rounded-lg border border-[var(--line)] bg-[var(--bg)] px-2 text-[12px] text-[var(--ink)] disabled:opacity-60"
        >
          {!models.length && <option value="">{!ready ? 'Loading models…' : hasKey ? 'No models in cloud-models.json' : 'No key yet'}</option>}
          {groupByProvider(models).map(([group, rows]) => {
            const options = rows.map((m) => (
              <option key={m.id} value={m.id} title={fits(m) ? m.id : `Outside ${levelLabel} (${levelPriceText(level)}) — needs a higher level`} disabled={!fits(m)}>
                {m.price?.output != null ? `${m.label} · ${usd(m.price.output)}/M out${isPricey(m) ? '  ⚠' : ''}` : m.label === m.id ? m.label : `${m.label} · ${m.id}`}
              </option>
            ))
            return group ? (
              <optgroup key={group} label={group}>
                {options}
              </optgroup>
            ) : (
              options
            )
          })}
        </select>
        <a
          href={guideUrl('cloudPrices')}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Cloud model prices and notes — opens the guide"
          title="Cloud model prices and notes — opens the guide"
          className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-[var(--line)] text-[12px] font-bold italic text-[var(--ink-soft)] hover:border-[var(--muted)] hover:text-[var(--ink)]"
        >
          i
        </a>
        {/* Reserved even when empty, so choosing a model never resizes the dropdown. */}
        <span className="grid h-8 w-5 shrink-0 place-items-center">
          {pricey && (
            <span
              role="img"
              aria-label={`Costly model: at or above $${costlyLine} per 1M output tokens`}
              title={`Costly model: at or above $${costlyLine} per 1M output tokens`}
              className="text-[16px] leading-none text-[#dc2626]"
            >
              ⚠
            </span>
          )}
        </span>
      </div>
      <p className={`h-8 line-clamp-2 text-[10.5px] leading-4 ${pricey ? 'text-[#dc2626]' : 'text-[var(--muted)]'}`} title={hint}>
        {hint}
      </p>
    </>
  )
}

function FactTile({ label, value, hint, warn = false }: { label: string; value: ReactNode; hint?: string; warn?: boolean }) {
  return (
    <div
      className="flex h-12 min-w-0 flex-col justify-center rounded-lg border bg-[var(--surface-2)] px-2.5"
      style={{ borderColor: warn ? 'rgba(220,38,38,0.5)' : 'var(--line)', background: warn ? 'rgba(220,38,38,0.06)' : undefined }}
      title={hint}
    >
      <span className="truncate text-[9.5px] font-bold uppercase tracking-wider text-[var(--muted)]">{label}</span>
      <span className="flex items-center justify-between gap-1">
        <span className="truncate text-[12.5px] font-semibold tabular-nums text-[var(--ink)]">{value}</span>
        {warn && (
          <span role="img" aria-label="Above $10" className="shrink-0 text-[13px] leading-none text-[#dc2626]">
            ⚠
          </span>
        )}
      </span>
    </div>
  )
}

/**
 * The rest of the AI card: facts about the model the next job will use, and the intern's queue.
 * Compact fixed-height tiles — they take only the room they need, never the card's leftover height.
 */
function AiFacts({
  settings,
  aiStatus,
  cloudModel,
  localModel,
  installed,
  pulling,
}: {
  settings: Settings
  aiStatus: AiInternStatus | null
  /** The selected cloud model as the worker published it — its price comes with it. */
  cloudModel: CloudModelChoice | null
  localModel: AiCatalogModel | null
  installed: string[]
  pulling: string | null
}) {
  let tiles: ReactNode
  if (settings.aiBackend === 'cloud') {
    const rate: CloudPrice | undefined = cloudModel?.price ?? undefined
    const biller = CLOUD_KEYS[cloudProviderOf(settings)].biller
    tiles = rate ? (
      <>
        <FactTile label="Input / 1M" value={usd(rate.input)} hint={`USD per million input tokens, standard speed${cloudModel?.note ? ` · ${cloudModel.note}` : ''}`} />
        <FactTile
          label="Output / 1M"
          value={usd(rate.output)}
          warn={isPricey(cloudModel)}
          hint={`USD per million output tokens — a lower effort spends fewer${isPricey(cloudModel) ? ' · costly: at or above the cost line in cloud-models.json' : ''}`}
        />
        <FactTile
          label="Cache read / 1M"
          value={usd(rate.cacheRead)}
          hint={`USD per million cached input tokens${rate.cacheWrite != null ? ` · writing to the cache costs ${usd(rate.cacheWrite)} / 1M` : ''}`}
        />
      </>
    ) : (
      <div className="col-span-3 flex h-12 min-w-0 items-center rounded-lg border border-[var(--line)] bg-[var(--surface-2)] px-2.5 text-[11px] text-[var(--muted)]">
        <span className="min-w-0 truncate">{settings.aiCloudModel ? `${biller} sets this model's prices — see ${biller}'s pricing page.` : 'Pick a model to see its prices.'}</span>
      </div>
    )
  } else {
    const id = localModel?.id ?? settings.aiLocalModel
    const ready = !!id && modelInstalled(installed, id)
    const downloading = !!(pulling && localModel && (pulling === localModel.id || pulling === localModel.pull))
    const vm = aiStatus?.memGb
    tiles = (
      <>
        <FactTile label="Size" value={localModel?.params || '—'} hint="Parameters — bigger reasons better and runs slower" />
        <FactTile
          label="Memory"
          value={localModel?.ramGb ? `~${localModel.ramGb} GB` : '—'}
          hint={vm ? `Needs about this much RAM; the AI-Intern VM reports ${vm} GB` : 'Needs about this much RAM'}
        />
        <FactTile
          label="On disk"
          value={downloading ? 'Downloading…' : ready ? 'Ready' : 'Not yet'}
          hint={ready ? 'Downloaded — jobs can use it now' : 'Not downloaded yet — use the download button beside the list'}
        />
      </>
    )
  }

  const running = aiStatus?.active?.length ?? (aiStatus?.current ? 1 : 0)
  const queued = aiStatus?.queued ?? 0
  const down = !aiStatus || aiStatus.down
  const activity = down
    ? 'offline — reports stay deterministic until AI-Intern runs'
    : `${queued} waiting · ${running} running${aiStatus?.parallel ? ` · up to ${aiStatus.parallel} at once` : ''}`

  return (
    <div className="flex flex-col gap-1.5">
      <div className="grid grid-cols-3 gap-1.5">{tiles}</div>
      <div className={STRIP} title={`AI-Intern: ${activity}`}>
        <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: down ? '#dc2626' : running ? AI : '#16a34a' }} />
        <span className="shrink-0 font-semibold text-[var(--ink-soft)]">Intern</span>
        <span className="min-w-0 truncate">{activity}</span>
      </div>
    </div>
  )
}

function LocalModelPicker({
  catalog,
  installed,
  pulling,
  pullProgress,
  failed = false,
  settings,
  onSelect,
  onDownload,
}: {
  catalog: AiCatalogModel[]
  installed: string[]
  pulling: string | null
  pullProgress: AiPullProgress | null
  /** The last download request was refused — shown in the note slot. */
  failed?: boolean
  settings: Settings
  onSelect: (id: string) => void
  onDownload: (m: AiCatalogModel) => void
}) {
  const options =
    catalog.some((m) => m.id === settings.aiLocalModel) || !settings.aiLocalModel
      ? catalog
      : [{ id: settings.aiLocalModel, label: settings.aiLocalModel, pull: settings.aiLocalModel, params: '', ramGb: 0, level: '', fits: 'container', why: '' }, ...catalog]
  const selected = options.find((m) => m.id === settings.aiLocalModel) ?? options[0]
  const have = selected ? modelInstalled(installed, selected.id) : false
  const downloading = !!(pulling && selected && (pulling === selected.id || pulling === selected.pull))
  const pct = Math.max(0, Math.min(100, Math.round(pullProgress?.percent ?? 0)))
  const known = !!(pullProgress?.total && pullProgress.total > 0)
  const barLabel = downloading
    ? known
      ? `${pct}% · ${pullProgress?.label || ''}`
      : pullProgress?.status || pullProgress?.label || 'Starting download…'
    : null

  return (
    <>
      <div className="flex h-8 items-center gap-1.5">
        <select
          value={selected?.id ?? ''}
          onChange={(e) => onSelect(e.target.value)}
          aria-label="Local AI model"
          className="jb-field h-8 min-w-0 flex-1 rounded-lg border border-[var(--line)] bg-[var(--bg)] px-2 text-[12px] text-[var(--ink)]"
        >
          {options.map((m) => {
            const ready = modelInstalled(installed, m.id)
            const host = m.fits === 'host' ? ' · host Metal' : ''
            const size = m.params ? ` · ${m.params} · ~${m.ramGb} GB` : ''
            return (
              <option key={m.id} value={m.id}>
                {m.label}
                {size}
                {host}
                {ready ? ' · ready' : ''}
              </option>
            )
          })}
        </select>
        {!have && selected && (
          <button
            type="button"
            disabled={downloading}
            onClick={() => onDownload(selected)}
            title={downloading ? `Downloading ${selected.label}…` : `Download ${selected.label}`}
            aria-label={downloading ? `Downloading ${selected.label}` : `Download ${selected.label}`}
            className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-[var(--line)] text-[var(--ink-soft)] hover:border-[var(--muted)] hover:text-[var(--ink)] disabled:opacity-60"
          >
            {downloading ? (
              <RefreshIcon size={13} color="currentColor" />
            ) : (
              <DownloadIcon size={13} />
            )}
          </button>
        )}
        <a
          href={guideUrl('modelFiles')}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="GGUF models — download a model file, place it and register it (opens the guide)"
          title="GGUF models — download a model file, place it and register it (opens the guide)"
          className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-[var(--line)] text-[var(--ink-soft)] hover:border-[var(--muted)] hover:text-[var(--ink)]"
        >
          <QuestionIcon size={14} />
        </a>
      </div>
      {/* One slot: download progress while pulling, otherwise what the model is good for. */}
      <div className="relative h-8">
        <div
          className={`absolute inset-0 flex flex-col justify-center gap-0.5 ${downloading ? '' : 'invisible'}`}
          aria-hidden={!downloading}
        >
          <div
            className="h-1.5 w-full overflow-hidden rounded-full"
            style={{ background: hexToRgba(AI, 0.18) }}
            role={downloading ? 'progressbar' : undefined}
            aria-valuemin={downloading ? 0 : undefined}
            aria-valuemax={downloading ? 100 : undefined}
            aria-valuenow={downloading && known ? pct : undefined}
            aria-busy={downloading || undefined}
            aria-label={downloading ? barLabel || 'Downloading model' : undefined}
          >
            {downloading && known && (
              <div
                className="h-full rounded-full transition-[width] duration-300 ease-out"
                style={{ width: `${Math.max(4, pct)}%`, background: AI }}
              />
            )}
            {downloading && !known && (
              <div className="relative h-full w-full overflow-hidden">
                <div className="ai-pull-indet absolute inset-y-0 w-1/3 rounded-full" style={{ background: AI }} />
              </div>
            )}
          </div>
          <p className="truncate text-[10.5px] leading-snug text-[var(--muted)]" title={barLabel || undefined}>
            {barLabel || 'Starting download…'}
          </p>
        </div>
        <p
          className={`absolute inset-0 line-clamp-2 overflow-hidden text-[10.5px] leading-4 ${failed ? 'font-semibold text-red-500' : 'text-[var(--muted)]'} ${downloading ? 'invisible' : ''}`}
          title={failed ? undefined : selected?.why || undefined}
          role={failed && !downloading ? 'alert' : undefined}
        >
          {failed ? 'Download failed — see the AI-Intern logs (docker logs AI-Intern).' : selected?.why || '\u00a0'}
        </p>
      </div>
    </>
  )
}
