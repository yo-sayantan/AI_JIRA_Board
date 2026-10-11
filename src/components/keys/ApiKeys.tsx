import { useEffect, useRef, useState, type MouseEvent } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import {
  HEALTH_COLOR,
  TEST_TONE_COLOR,
  canSave,
  healthTone,
  healthView,
  keyCounts,
  kindOf,
  groupedServices,
  latestHealth,
  recordFromTest,
  servicePlanned,
  serviceReady,
  testBlocker,
  testResultView,
  type ApiKeyField,
  type ApiService,
  type HealthMap,
  type HealthRecord,
  type KeyStatus,
  type KeyTestResult,
} from '../../lib/apiKeys'
import { hexToRgba } from '../../lib/format'
import type { ApiKeySave } from '../../lib/runner'
import { useDialogFocus } from '../../hooks/useDialogFocus'
import { CheckIcon, EyeIcon, EyeOffIcon, KeyIcon } from '../common/Icons'

type SaveFn = (name: string, value: string) => Promise<ApiKeySave>
type TestFn = (service: string) => Promise<KeyTestResult>
/** One service's Test state: running, and the last answer (cleared when one of its keys is saved). */
type TestState = { busy: boolean; result?: KeyTestResult; at?: number }
const UNSET = { set: false, masked: '' }
// The registry is static: group and order it once.
const GROUPS = groupedServices()
const ORDERED = GROUPS.flatMap((g) => g.services)
const QUIET = '#8b94a8'

/**
 * The API keys dialog (header key button), laid out like Settings: a sidebar of groups
 * (setup/api-keys.json `groups`, services alphabetical inside each) — every service lit in its
 * colour when its keys are set, greyed when not — and the selected service in a panel: why it is
 * needed, what depends on it, a Test button, and one field per key.
 *
 * Every service carries a PERMANENT dot from its latest real outcome (jira-intern/.health, whoever
 * made the call): green working · red key rejected / access denied · orange needs attention (URL,
 * network, server) · no dot (space reserved) never called. A Test run here only refines it.
 */
export function ApiKeysDialog({
  open,
  status,
  health,
  failed,
  onClose,
  onRefresh,
  onSave,
  onTest,
}: {
  open: boolean
  status: KeyStatus | null
  /** The last read of setup/.env failed (server down, unreadable file). */
  failed: boolean
  /** The latest real outcome per service (any call, anywhere), already limited to services with saved keys. */
  health: HealthMap
  onClose: () => void
  onRefresh: () => void
  onSave: SaveFn
  /** Check a service's SAVED key against its host (POST /api/keys/test). */
  onTest: TestFn
}) {
  const panelRef = useRef<HTMLElement>(null)
  const groups = GROUPS
  const ordered = ORDERED
  const [selected, setSelected] = useState<string>(ordered[0]?.id ?? '')
  const [tests, setTests] = useState<Record<string, TestState>>({})
  useDialogFocus(open, panelRef)

  const runTest = async (id: string) => {
    setTests((t) => ({ ...t, [id]: { busy: true, result: t[id]?.result, at: t[id]?.at } }))
    const result = await onTest(id)
    setTests((t) => ({ ...t, [id]: { busy: false, result, at: Date.now() } }))
  }
  // A saved key makes the last test stale: drop its answer (a running test keeps going).
  const saveFor = (id: string): SaveFn => async (name, value) => {
    const r = await onSave(name, value)
    if (r.ok) setTests((t) => (t[id]?.result ? { ...t, [id]: { busy: t[id].busy } } : t))
    return r
  }

  // Fresh status on every open; start on the first required service that still needs a key.
  const wasOpen = useRef(false)
  useEffect(() => {
    if (open && !wasOpen.current) {
      onRefresh()
      setTests({})
      setSelected((ordered.find((s) => s.required && !serviceReady(s, status)) ?? ordered[0])?.id ?? '')
    }
    wasOpen.current = open
  }, [open, status, onRefresh])

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

  // The newer of the server's record and this session's Test, per service.
  const healthOf = (id: string): HealthRecord | undefined => {
    const t = tests[id]
    return latestHealth(health[id], t?.result ? recordFromTest(t.result, t.at) : null)
  }
  const counts = keyCounts(status)
  const current = ordered.find((s) => s.id === selected) ?? ordered[0]
  // Close on a click that started AND ended on the backdrop: a drag that begins in a key field and
  // is released outside must not throw the dialog (and the half-typed key) away.
  const downOnBackdrop = useRef(false)
  const onBackdropDown = (e: MouseEvent) => (downOnBackdrop.current = e.target === e.currentTarget)
  const onBackdropClick = (e: MouseEvent) => {
    if (downOnBackdrop.current && e.target === e.currentTarget) onClose()
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-[90] flex items-center justify-center overflow-hidden bg-black/60 p-3 backdrop-blur-sm"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onMouseDown={onBackdropDown}
          onClick={onBackdropClick}
          role="dialog"
          aria-modal
          aria-label="API keys"
        >
          <motion.section
            ref={panelRef}
            tabIndex={-1}
            className="jb-dialog-panel flex h-[min(800px,calc(100dvh-32px))] w-[min(1200px,calc(100vw-32px))] flex-col overflow-hidden rounded-2xl border border-[var(--line)] bg-[var(--bg)] shadow-2xl"
            initial={{ y: 20, scale: 0.98 }}
            animate={{ y: 0, scale: 1 }}
            exit={{ y: 12, scale: 0.98 }}
            transition={{ type: 'spring', stiffness: 320, damping: 32 }}
          >
            <header className="flex shrink-0 items-center gap-2.5 border-b border-[var(--line)] px-5 py-3">
              <KeyIcon size={15} color="#f59e0b" />
              <h2 className="text-[15px] font-extrabold text-[var(--ink)]">API keys</h2>
              <span className="text-[12px] font-semibold tabular-nums text-[var(--muted)]">
                {status ? `${counts.ready} of ${counts.total} set` : failed ? '' : 'loading…'}
              </span>
              <button
                type="button"
                onClick={onClose}
                aria-label="Close API keys"
                className="ml-auto grid h-9 w-9 place-items-center rounded-lg text-[18px] leading-none text-[var(--muted)] hover:bg-[var(--surface-solid)] hover:text-[var(--ink)]"
              >
                ×
              </button>
            </header>

            {failed && (
              <p className="flex shrink-0 items-center gap-2 border-b border-[var(--line)] px-5 py-2 text-[12px] text-[#e11d48]" role="alert">
                Could not read the saved keys{status ? ' — showing the last known state' : ''}.
                <button type="button" onClick={onRefresh} className="font-bold underline">
                  Retry
                </button>
              </p>
            )}

            <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[300px_minmax(0,1fr)]">
              <nav aria-label="Services" className="min-h-0 overflow-y-auto border-b border-[var(--line)] p-4 [scrollbar-gutter:stable] md:border-b-0 md:border-r">
                {groups.map(({ group, services }) => {
                  const ready = services.filter((s) => serviceReady(s, status)).length
                  const tones = services.map((s) => healthTone(healthOf(s.id)))
                  const bad = tones.filter((t) => t === 'key' || t === 'attention').length
                  const badTone = tones.includes('key') ? 'key' : 'attention'
                  const badColor = HEALTH_COLOR[badTone]
                  return (
                    <div key={group.id} className="mb-4 last:mb-0">
                      <div className="mb-1.5 flex items-center px-2">
                        <h3 className="text-[10.5px] font-bold uppercase tracking-[0.08em] text-[var(--muted)]">{group.name}</h3>
                        {bad > 0 && (
                          <span
                            className="ml-auto rounded-full px-1.5 text-[10px] font-bold tabular-nums"
                            style={{ color: badColor, background: hexToRgba(badColor, 0.12) }}
                            title={`${bad} in this group ${bad === 1 ? 'needs' : 'need'} attention`}
                          >
                            {bad} ⚠
                          </span>
                        )}
                        <span className={`${bad > 0 ? 'ml-2' : 'ml-auto'} text-[10.5px] font-semibold tabular-nums text-[var(--muted)]`}>
                          {ready}/{services.length}
                        </span>
                      </div>
                      <ul className="space-y-1">
                        {services.map((s) => (
                          <ServiceNavItem
                            key={s.id}
                            service={s}
                            status={status}
                            active={current?.id === s.id}
                            record={healthOf(s.id)}
                            onSelect={() => setSelected(s.id)}
                          />
                        ))}
                      </ul>
                    </div>
                  )
                })}
              </nav>

              <div className="min-h-0 overflow-y-auto bg-[var(--bg)] p-5 [scrollbar-gutter:stable] md:px-8 md:py-6">
                {current && (
                  <ServicePanel
                    key={current.id}
                    service={current}
                    status={status}
                    onSave={saveFor(current.id)}
                    test={tests[current.id]}
                    record={healthOf(current.id)}
                    onTest={() => void runTest(current.id)}
                  />
                )}
              </div>
            </div>

            <footer className="shrink-0 border-t border-[var(--line)] px-5 py-2.5 text-[11.5px] leading-snug text-[var(--muted)]">
              Saved to <code>setup/.env</code> on this machine — git-ignored, never baked into an image. The board only ever
              gets the masked value back.
            </footer>
          </motion.section>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

function statusPill(service: ApiService, status: KeyStatus | null) {
  if (serviceReady(service, status)) return { text: 'Set', color: service.color }
  if (service.required) return { text: 'Required', color: '#f59e0b' }
  return { text: servicePlanned(service) ? 'Not used yet' : 'Not set', color: QUIET }
}

function ServiceIcon({ service, ready, size = 32 }: { service: ApiService; ready: boolean; size?: number }) {
  return (
    <span
      className="grid shrink-0 place-items-center rounded-[10px]"
      style={{
        width: size,
        height: size,
        background: ready ? `linear-gradient(135deg, ${service.color}, ${hexToRgba(service.color, 0.65)})` : hexToRgba(QUIET, 0.16),
      }}
    >
      {ready ? <CheckIcon size={size > 32 ? 14 : 11} color="#fff" /> : <KeyIcon size={size > 32 ? 14 : 11} color={QUIET} />}
    </span>
  )
}

/** One service in the sidebar: icon (lit when set), name, its one-line summary, the last test's dot. */
function ServiceNavItem({
  service,
  status,
  active,
  record,
  onSelect,
}: {
  service: ApiService
  status: KeyStatus | null
  active: boolean
  record: HealthRecord | undefined
  onSelect: () => void
}) {
  const ready = serviceReady(service, status)
  const pill = statusPill(service, status)
  const health = healthView(record)
  const dot = health.color
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        aria-current={active ? 'true' : undefined}
        title={service.details}
        className="flex w-full items-center gap-2.5 rounded-xl border px-2 py-2 text-left transition-[background-color,border-color] duration-150"
        style={{
          borderColor: active ? hexToRgba(service.color, 0.45) : 'transparent',
          background: active ? hexToRgba(service.color, 0.09) : undefined,
        }}
      >
        <ServiceIcon service={service} ready={ready} size={30} />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="text-[13px] font-bold" style={{ color: ready || active ? service.color : 'var(--ink-soft)' }}>
              {service.name}
            </span>
            {service.required && !ready && (
              <span className="text-[10px] font-bold" style={{ color: '#f59e0b' }}>
                required
              </span>
            )}
          </span>
          <span className="block text-[11px] leading-snug text-[var(--muted)] [text-wrap:pretty]">{service.why}</span>
        </span>
        {/* A fixed slot: the dot comes and goes, the row never shifts. No dot = never called. */}
        <span className="grid h-4 w-4 shrink-0 place-items-center" title={health.detail}>
          {dot ? (
            <span
              role="img"
              aria-label={health.detail}
              className="h-2 w-2 rounded-full"
              style={{ background: dot, boxShadow: `0 0 0 3px ${hexToRgba(dot, 0.18)}` }}
            />
          ) : (
            <span className="sr-only">{`${pill.text}. ${health.detail}`}</span>
          )}
        </span>
      </button>
    </li>
  )
}

/** The selected service, as a Settings-style section card: summary, test, usage, then its keys. */
function ServicePanel({
  service,
  status,
  onSave,
  test,
  record,
  onTest,
}: {
  service: ApiService
  status: KeyStatus | null
  onSave: SaveFn
  test: TestState | undefined
  record: HealthRecord | undefined
  onTest: () => void
}) {
  const health = healthView(record)
  const ready = serviceReady(service, status)
  const pill = statusPill(service, status)
  const blocker = testBlocker(service, status)
  const busy = !!test?.busy
  const view = test?.result ? testResultView(test.result) : null
  const viewColor = view ? TEST_TONE_COLOR[view.tone] : QUIET
  const testColor = blocker ? QUIET : service.color

  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.16, ease: 'easeOut' }}
      className="space-y-5"
    >
      <section
        className="rounded-2xl border p-5"
        style={{ borderColor: hexToRgba(ready ? service.color : QUIET, 0.35), background: hexToRgba(ready ? service.color : QUIET, 0.05) }}
      >
        <div className="flex flex-wrap items-start gap-3">
          <ServiceIcon service={service} ready={ready} size={40} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-[17px] font-extrabold [text-wrap:balance]" style={{ color: ready ? service.color : 'var(--ink)' }}>
                {service.name}
              </h3>
              <span
                className="rounded-full px-2.5 py-0.5 text-[11px] font-bold"
                style={{ color: pill.color, background: hexToRgba(pill.color, 0.12), border: `1px solid ${hexToRgba(pill.color, 0.4)}` }}
              >
                {pill.text}
              </span>
            </div>
            <p className="mt-1 text-[13px] leading-relaxed text-[var(--ink-soft)] [text-wrap:pretty]">{service.details}</p>
          </div>
          <motion.button
            type="button"
            onClick={onTest}
            disabled={busy || !!blocker}
            whileTap={busy || blocker ? undefined : { scale: 0.96 }}
            transition={{ type: 'spring', stiffness: 400, damping: 22 }}
            aria-label={`Test ${service.name} connection`}
            aria-busy={busy || undefined}
            title={blocker ?? `Check the saved ${service.name} key against its host`}
            className="h-9 shrink-0 rounded-lg border px-4 text-[12.5px] font-bold transition-[background-color] duration-150 disabled:cursor-default disabled:opacity-45"
            style={{ color: testColor, borderColor: hexToRgba(testColor, 0.45), background: hexToRgba(testColor, 0.08) }}
          >
            {busy ? 'Testing…' : 'Test connection'}
          </motion.button>
        </div>
        {/* Always-mounted live region (announces results), plus the visible line when there is one. */}
        <span className="sr-only" aria-live="polite">
          {view?.text ?? ''}
        </span>
        {/* A fixed one-line slot for the result, so a test never changes the card's height. */}
        <p
          aria-hidden="true"
          className="mt-4 flex h-9 items-center gap-2 rounded-lg px-3 text-[12px] font-semibold"
          title={view?.title ?? (blocker || undefined)}
          style={
            view
              ? { color: viewColor, background: hexToRgba(viewColor, 0.08), border: `1px solid ${hexToRgba(viewColor, 0.3)}` }
              : { color: 'var(--muted)', background: hexToRgba(QUIET, 0.06), border: `1px dashed ${hexToRgba(QUIET, 0.35)}` }
          }
        >
          <span className="min-w-0 truncate">{busy ? 'Testing…' : view ? view.text : blocker ? `Can't test yet — ${blocker}` : 'Not tested yet'}</span>
        </p>
        {/* The latest real call by anything (fetch, AI worker, Test) — a fixed one-line row, so it never resizes the card. */}
        <p className="mt-2 flex h-7 items-center gap-2 px-1 text-[11.5px] font-semibold" title={health.detail} style={{ color: health.color ?? 'var(--muted)' }}>
          <span className="grid h-3 w-3 shrink-0 place-items-center" aria-hidden="true">
            {health.color && <span className="h-2 w-2 rounded-full" style={{ background: health.color, boxShadow: `0 0 0 3px ${hexToRgba(health.color, 0.18)}` }} />}
          </span>
          <span className="shrink-0 text-[10px] font-bold uppercase tracking-[0.08em] text-[var(--muted)]">Live status</span>
          <span className="min-w-0 truncate">{health.tone === 'none' ? 'Not called yet' : health.detail}</span>
        </p>
      </section>

      <section className="rounded-2xl border border-[var(--line)] bg-[var(--surface-solid)] p-5">
        <dl className="grid grid-cols-1 gap-x-4 gap-y-3 text-[12px] sm:grid-cols-[6.5rem_minmax(0,1fr)]">
          <dt className="pt-0.5 text-[10.5px] font-bold uppercase tracking-[0.08em] text-[var(--muted)]">Used by</dt>
          <dd className="flex flex-wrap gap-1.5">
            {service.usedBy.map((u) => (
              <span
                key={u}
                className="rounded-md px-2 py-0.5 text-[11.5px] font-medium"
                style={{ color: service.color, background: hexToRgba(service.color, 0.08), border: `1px solid ${hexToRgba(service.color, 0.3)}` }}
              >
                {u}
              </span>
            ))}
          </dd>
          <dt className="pt-0.5 text-[10.5px] font-bold uppercase tracking-[0.08em] text-[var(--muted)]">Get it</dt>
          <dd className="leading-relaxed text-[var(--ink-soft)] [text-wrap:pretty]">{service.getIt}</dd>
        </dl>
      </section>

      <section className="rounded-2xl border border-[var(--line)] bg-[var(--surface-solid)] p-5">
        <h4 className="mb-3 text-[10.5px] font-bold uppercase tracking-[0.08em] text-[var(--muted)]">
          {service.keys.length === 1 ? 'Key' : 'Keys'}
        </h4>
        <div className="space-y-5">
          {service.keys.map((k) => (
            <KeyField key={k.env} field={k} saved={status?.[k.env] ?? UNSET} color={service.color} onSave={onSave} />
          ))}
        </div>
      </section>
    </motion.div>
  )
}

/** Small quiet tag beside a field label (optional · not used yet). */
function Tag({ text }: { text: string }) {
  return (
    <span className="rounded-full border px-2 py-px text-[10.5px] font-medium" style={{ color: QUIET, borderColor: hexToRgba(QUIET, 0.4), background: hexToRgba(QUIET, 0.08) }}>
      {text}
    </span>
  )
}

const PLACEHOLDER: Record<string, string> = { secret: 'Paste the key', url: 'https://…', email: 'you@example.com', text: 'user name' }

function KeyField({
  field,
  saved,
  color,
  onSave,
}: {
  field: ApiKeyField
  saved: { set: boolean; masked: string }
  color: string
  onSave: SaveFn
}) {
  const secret = kindOf(field) === 'secret'
  // A secret's box starts empty with its mask as the placeholder — the mask is a picture of the
  // key, not something to edit. URLs, emails and names are shown in full, so the box holds them.
  const fromServer = secret ? '' : saved.masked
  const [draft, setDraft] = useState(fromServer)
  const [shown, setShown] = useState(fromServer)
  const [reveal, setReveal] = useState(false)
  const [busy, setBusy] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [note, setNote] = useState<{ text: string; error: boolean } | null>(null)
  const inputId = `api-key-input-${field.env}`
  const hintId = `${inputId}-hint`

  // Follow the server (another save, a refresh) only while the box is untouched — never over an edit.
  if (shown !== fromServer) {
    setShown(fromServer)
    if (draft === shown) setDraft(fromServer)
  }

  const enabled = !busy && canSave(draft, saved, secret)

  const submit = async (value: string) => {
    setBusy(true)
    setNote(null)
    const r = await onSave(field.env, value)
    setBusy(false)
    setConfirmRemove(false)
    if (!r.ok) return setNote({ text: r.error, error: true })
    const next = secret ? '' : (r.keys[field.env]?.masked ?? '')
    setDraft(next)
    setShown(next)
    setReveal(false)
    setNote({ text: value ? 'Saved' : 'Removed', error: false })
  }

  const hint = field.hint ?? ''

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <label htmlFor={inputId} className="text-[12.5px] font-semibold text-[var(--ink-soft)]">
          {field.label}
        </label>
        {field.optional && <Tag text="optional" />}
        {field.planned && <Tag text="not used yet" />}
        {/* The save note sits on the label line, so saving never changes the field's height. */}
        <span
          aria-hidden="true"
          className="ml-auto max-w-[50%] truncate text-[11.5px] font-semibold"
          title={note?.text}
          style={{ color: note?.error ? '#e11d48' : color }}
        >
          {note?.text ?? ''}
        </span>
        <code className="font-mono text-[10.5px] text-[var(--muted)]">{field.env}</code>
      </div>
      <div className="flex items-center gap-2">
      <div className="relative min-w-0 flex-1">
        <input
          id={inputId}
          type={secret && !reveal ? 'password' : field.kind === 'email' ? 'email' : 'text'}
          value={draft}
          placeholder={saved.set && secret ? saved.masked : PLACEHOLDER[kindOf(field)]}
          aria-describedby={hint ? hintId : undefined}
          // An API key is not a login: keep password managers from offering to save or fill it.
          autoComplete="new-password"
          data-1p-ignore
          data-lpignore="true"
          spellCheck={false}
          onChange={(e) => {
            setDraft(e.target.value)
            setNote(null)
          }}
          onKeyDown={(e) => e.key === 'Enter' && enabled && void submit(draft.trim())}
          // A saved secret's mask sits in the placeholder; drawn in ink, it reads as the value.
          className={`jb-key-input h-9 w-full rounded-lg border border-[var(--line)] bg-[var(--surface-solid)] px-3 font-mono text-[12.5px] transition-[border-color,box-shadow] duration-150 focus:shadow-[0_0_0_3px_rgba(127,127,127,0.12)] text-[var(--ink)] outline-none focus:border-[var(--muted)] ${
            secret ? 'pr-10' : ''
          } ${saved.set && secret ? 'placeholder:text-[var(--ink-soft)]' : 'placeholder:text-[var(--muted)]'}`}
        />
        {secret && draft && (
          <button
            type="button"
            onClick={() => setReveal((r) => !r)}
            aria-label={reveal ? 'Hide key' : 'Show key'}
            aria-pressed={reveal}
            className="absolute right-1 top-1/2 grid h-8 w-8 -translate-y-1/2 place-items-center rounded-md text-[var(--muted)] hover:text-[var(--ink)]"
          >
            {reveal ? <EyeOffIcon size={12} /> : <EyeIcon size={12} />}
          </button>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <motion.button
          type="button"
          whileHover={enabled ? { scale: 1.04 } : undefined}
          whileTap={enabled ? { scale: 0.95 } : undefined}
          disabled={!enabled}
          onClick={() => void submit(draft.trim())}
          aria-label={`Save ${field.label}`}
          aria-busy={busy || undefined}
          className="h-9 rounded-lg px-4 text-[12.5px] font-bold text-white transition-opacity disabled:cursor-default disabled:opacity-35"
          style={{ background: enabled ? `linear-gradient(135deg, ${color}, ${hexToRgba(color, 0.75)})` : QUIET }}
          title={enabled ? `Save ${field.env}` : saved.set ? 'Type a new value to replace the saved one' : 'Paste a value first'}
        >
          {busy ? 'Saving…' : 'Save'}
        </motion.button>
        {saved.set && (
          <button
            type="button"
            disabled={busy}
            onClick={() => (confirmRemove ? void submit('') : setConfirmRemove(true))}
            onBlur={() => setConfirmRemove(false)}
            className="h-9 rounded-lg border px-3 text-[12px] font-semibold"
            style={{ color: '#e11d48', borderColor: hexToRgba('#e11d48', confirmRemove ? 0.6 : 0.3), background: hexToRgba('#e11d48', confirmRemove ? 0.1 : 0.03) }}
            aria-label={confirmRemove ? `Confirm removing ${field.env}` : `Remove ${field.env}`}
          >
            {confirmRemove ? 'Confirm' : 'Remove'}
          </button>
        )}
      </div>
      </div>
      {hint && (
        <p id={hintId} className="text-[11.5px] leading-snug text-[var(--muted)] [text-wrap:pretty]">
          {hint}
        </p>
      )}
      {/* Same pattern: an always-mounted sr-only live region (no grid track, so no gap when empty) and a
          visible, aria-hidden note only while there is one. display:none on the live region would drop
          the announcement in some screen readers. */}
      <span className="sr-only" aria-live="polite">
        {note?.text ?? ''}
      </span>
    </div>
  )
}
