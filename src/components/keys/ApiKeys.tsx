import { useEffect, useRef, useState, type MouseEvent } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { API_SERVICES, canSave, keyCounts, kindOf, servicePlanned, serviceReady, type ApiKeyField, type ApiService, type KeyStatus } from '../../lib/apiKeys'
import { hexToRgba } from '../../lib/format'
import type { ApiKeySave } from '../../lib/runner'
import { useDialogFocus } from '../../hooks/useDialogFocus'
import { CheckIcon, ChevronIcon, EyeIcon, EyeOffIcon, KeyIcon } from '../common/Icons'

type SaveFn = (name: string, value: string) => Promise<ApiKeySave>
const UNSET = { set: false, masked: '' }
const QUIET = '#8b94a8'

/**
 * The API keys dialog (header key button). One list, one row per service from
 * setup/api-keys.json: lit in the service's colour when its keys are set, greyed when not.
 * A row opens in place to show why the key is needed, what depends on it, and one field per key.
 */
export function ApiKeysDialog({
  open,
  status,
  failed,
  onClose,
  onRefresh,
  onSave,
}: {
  open: boolean
  status: KeyStatus | null
  /** The last read of setup/.env failed (server down, unreadable file). */
  failed: boolean
  onClose: () => void
  onRefresh: () => void
  onSave: SaveFn
}) {
  const panelRef = useRef<HTMLElement>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  useDialogFocus(open, panelRef)

  // Fresh status on every open; start on the first required service that still needs a key.
  const wasOpen = useRef(false)
  useEffect(() => {
    if (open && !wasOpen.current) {
      onRefresh()
      setExpanded(API_SERVICES.find((s) => s.required && !serviceReady(s, status))?.id ?? null)
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

  const counts = keyCounts(status)
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
            className="jb-dialog-panel flex max-h-[calc(100dvh-24px)] w-[min(600px,calc(100vw-24px))] flex-col rounded-2xl border border-[var(--line)] bg-[var(--bg)] shadow-2xl"
            initial={{ y: 20, scale: 0.98 }}
            animate={{ y: 0, scale: 1 }}
            exit={{ y: 12, scale: 0.98 }}
            transition={{ type: 'spring', stiffness: 320, damping: 32 }}
          >
            <header className="flex shrink-0 items-center gap-2 border-b border-[var(--line)] px-4 py-2.5">
              <KeyIcon size={14} color="#f59e0b" />
              <h2 className="text-[15px] font-extrabold text-[var(--ink)]">API keys</h2>
              <span className="text-[11.5px] font-semibold text-[var(--muted)]">
                {status ? `${counts.ready} of ${counts.total} set` : failed ? '' : 'loading…'}
              </span>
              <button
                type="button"
                onClick={onClose}
                aria-label="Close API keys"
                className="ml-auto grid h-8 w-8 place-items-center rounded-lg text-[18px] leading-none text-[var(--muted)] hover:bg-[var(--surface-solid)] hover:text-[var(--ink)]"
              >
                ×
              </button>
            </header>

            {failed && (
              <p className="flex shrink-0 items-center gap-2 border-b border-[var(--line)] px-4 py-2 text-[11.5px] text-[#e11d48]" role="alert">
                Could not read the saved keys{status ? ' — showing the last known state' : ''}.
                <button type="button" onClick={onRefresh} className="font-bold underline">
                  Retry
                </button>
              </p>
            )}

            <ul className="min-h-0 flex-1 space-y-1 overflow-y-auto px-2.5 py-2.5">
              {API_SERVICES.map((s) => (
                <ServiceRow
                  key={s.id}
                  service={s}
                  status={status}
                  open={expanded === s.id}
                  onToggle={() => setExpanded((cur) => (cur === s.id ? null : s.id))}
                  onSave={onSave}
                />
              ))}
            </ul>

            <footer className="shrink-0 border-t border-[var(--line)] px-4 py-2 text-[11px] leading-snug text-[var(--muted)]">
              Saved to <code>setup/.env</code> on this machine — git-ignored, never baked into an image. The board only ever
              gets the masked value back.
            </footer>
          </motion.section>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

function ServiceRow({
  service,
  status,
  open,
  onToggle,
  onSave,
}: {
  service: ApiService
  status: KeyStatus | null
  open: boolean
  onToggle: () => void
  onSave: SaveFn
}) {
  const ready = serviceReady(service, status)
  const planned = servicePlanned(service)
  const color = ready ? service.color : QUIET
  const bodyId = `api-key-${service.id}`
  const pill = ready
    ? { text: 'Set', color: service.color }
    : service.required
      ? { text: 'Required', color: '#f59e0b' }
      : { text: planned ? 'Not used yet' : 'Not set', color: QUIET }

  return (
    <li
      className="overflow-hidden rounded-xl border transition-colors"
      style={{ borderColor: hexToRgba(color, ready ? 0.45 : 0.3), background: hexToRgba(color, ready ? 0.07 : 0.03) }}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={open ? bodyId : undefined}
        className="flex w-full items-center gap-2.5 px-2.5 py-1.5 text-left"
      >
        <span
          className="grid h-6 w-6 shrink-0 place-items-center rounded-lg"
          style={{ background: ready ? `linear-gradient(135deg, ${service.color}, ${hexToRgba(service.color, 0.65)})` : hexToRgba(QUIET, 0.18) }}
        >
          {ready ? <CheckIcon size={10} color="#fff" /> : <KeyIcon size={10} color={QUIET} />}
        </span>
        <span className="flex min-w-0 flex-1 items-baseline gap-2">
          <span className="shrink-0 text-[13px] font-bold" style={{ color: ready ? service.color : 'var(--ink-soft)' }}>
            {service.name}
          </span>
          <span className="min-w-0 truncate text-[11px] text-[var(--muted)]" title={service.why}>
            {service.why}
          </span>
        </span>
        <span
          className="shrink-0 rounded-full px-2 py-0.5 text-[10.5px] font-bold"
          style={{ color: pill.color, background: hexToRgba(pill.color, 0.12), border: `1px solid ${hexToRgba(pill.color, 0.4)}` }}
        >
          {pill.text}
        </span>
        <ChevronIcon size={10} className={`shrink-0 text-[var(--muted)] transition-transform ${open ? 'rotate-90' : ''}`} />
      </button>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            id={bodyId}
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18 }}
          >
            <div className="space-y-1.5 border-t px-2.5 pb-2 pt-1.5" style={{ borderColor: hexToRgba(color, 0.2) }}>
              <p className="flex flex-wrap items-center gap-1 text-[10.5px] leading-snug text-[var(--muted)]">
                <span className="font-semibold">Used by</span>
                {service.usedBy.map((u) => (
                  <span
                    key={u}
                    className="rounded px-1.5 py-px font-medium"
                    style={{ color: service.color, background: hexToRgba(service.color, 0.08), border: `1px solid ${hexToRgba(service.color, 0.3)}` }}
                  >
                    {u}
                  </span>
                ))}
                <span className="basis-full">
                  <span className="font-semibold">Get it:</span> {service.getIt}
                </span>
              </p>
              {service.keys.map((k) => (
                <KeyField key={k.env} field={k} saved={status?.[k.env] ?? UNSET} color={service.color} onSave={onSave} />
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </li>
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
    const cleared = r.cleared.length ? ` — re-enter ${r.cleared.join(', ')} for the new URL` : ''
    setNote({ text: (value ? 'Saved' : 'Removed') + cleared, error: false })
  }

  const hint = field.hint ?? (secret && saved.set ? 'Saved. Paste a new key to replace it.' : '')

  return (
    <div className="grid grid-cols-[minmax(0,9.5rem)_minmax(0,1fr)_auto] items-center gap-x-2 gap-y-0.5">
      <label htmlFor={inputId} className="min-w-0 leading-tight" title={field.env}>
        <span className="block truncate text-[11.5px] font-semibold text-[var(--ink-soft)]">{field.label}</span>
        <span className="block truncate font-mono text-[9.5px] text-[var(--muted)]">
          {field.env}
          {field.optional ? ' · optional' : ''}
          {field.planned ? ' · not used yet' : ''}
        </span>
      </label>
      <div className="relative min-w-0">
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
          className={`jb-key-input h-7 w-full rounded-lg border border-[var(--line)] bg-[var(--surface-solid)] px-2 font-mono text-[11.5px] text-[var(--ink)] outline-none focus:border-[var(--muted)] ${
            secret ? 'pr-7' : ''
          } ${saved.set && secret ? 'placeholder:text-[var(--ink-soft)]' : 'placeholder:text-[var(--muted)]'}`}
        />
        {secret && draft && (
          <button
            type="button"
            onClick={() => setReveal((r) => !r)}
            aria-label={reveal ? 'Hide key' : 'Show key'}
            aria-pressed={reveal}
            className="absolute right-1 top-1/2 grid h-5 w-5 -translate-y-1/2 place-items-center rounded text-[var(--muted)] hover:text-[var(--ink)]"
          >
            {reveal ? <EyeOffIcon size={10} /> : <EyeIcon size={10} />}
          </button>
        )}
      </div>
      <div className="flex items-center gap-1">
        <motion.button
          type="button"
          whileHover={enabled ? { scale: 1.04 } : undefined}
          whileTap={enabled ? { scale: 0.95 } : undefined}
          disabled={!enabled}
          onClick={() => void submit(draft.trim())}
          aria-label={`Save ${field.label}`}
          aria-busy={busy || undefined}
          className="h-7 rounded-lg px-2.5 text-[11.5px] font-bold text-white transition-opacity disabled:cursor-default disabled:opacity-35"
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
            className="h-7 rounded-lg border px-1.5 text-[11px] font-semibold"
            style={{ color: '#e11d48', borderColor: hexToRgba('#e11d48', confirmRemove ? 0.6 : 0.3), background: hexToRgba('#e11d48', confirmRemove ? 0.1 : 0.03) }}
            aria-label={confirmRemove ? `Confirm removing ${field.env}` : `Remove ${field.env}`}
          >
            {confirmRemove ? 'Confirm' : 'Remove'}
          </button>
        )}
      </div>
      {hint && !note && (
        <p id={hintId} className="col-start-2 col-end-4 text-[10.5px] leading-snug text-[var(--muted)]">
          {hint}
        </p>
      )}
      <p className="col-start-2 col-end-4 text-[10.5px] font-semibold leading-snug empty:hidden" aria-live="polite" style={{ color: note?.error ? '#e11d48' : color }}>
        {note?.text ?? ''}
      </p>
    </div>
  )
}
