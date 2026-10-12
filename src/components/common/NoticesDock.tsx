import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { WarningIcon } from './Icons'

const AMBER = '#f59e0b'

/** Small, unobtrusive corner card for run notices (e.g. "Jira MCP unavailable").
 *  Collapsed to a pill by default; click to expand; × to dismiss for the session. */
export function NoticesDock({ notes, seconds = 10 }: { notes: string[]; seconds?: number }) {
  const [open, setOpen] = useState(false)
  const [hidden, setHidden] = useState(false)

  // Auto-dismiss after the Settings notification time, whether or not the card is open.
  const signature = notes.join('\n')
  useEffect(() => {
    if (!signature) return
    const t = setTimeout(() => setHidden(true), seconds * 1000)
    return () => clearTimeout(t)
  }, [signature, seconds])

  if (!notes || notes.length === 0 || hidden) return null

  return (
    <div className="fixed bottom-11 left-4 z-40 w-[min(90vw,360px)]">
      <AnimatePresence initial={false} mode="popLayout">
        {open ? (
          <motion.div
            key="card"
            layout
            initial={{ opacity: 0, y: 14, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 14, scale: 0.96 }}
            transition={{ type: 'spring', stiffness: 380, damping: 30 }}
            className="jb-float overflow-hidden rounded-xl border bg-[var(--surface-solid)] card-shadow"
            style={{ borderColor: 'rgba(245,158,11,0.4)' }}
          >
            <div className="flex items-center gap-2 px-3 py-2" style={{ background: 'rgba(245,158,11,0.1)' }}>
              <WarningIcon size={14} color={AMBER} />
              <span className="text-[12px] font-bold" style={{ color: AMBER }}>
                {notes.length === 1 ? 'Run notice' : `Run notices (${notes.length})`}
              </span>
              <div className="ml-auto flex items-center gap-1">
                <button onClick={() => setOpen(false)} className="rounded px-1.5 py-0.5 text-[11px] text-[var(--muted)] hover:bg-[var(--surface-2)] hover:text-[var(--ink)]" title="Collapse">
                  ▾
                </button>
                <button onClick={() => setHidden(true)} className="rounded px-1.5 py-0.5 text-[11px] text-[var(--muted)] hover:bg-[var(--surface-2)] hover:text-[var(--ink)]" title="Dismiss">
                  ✕
                </button>
              </div>
            </div>
            <ul className="flex max-h-[40vh] flex-col gap-1.5 overflow-y-auto px-3 py-2.5">
              {notes.map((n, i) => (
                <li key={i} className="flex gap-1.5 text-[12px] leading-relaxed text-[var(--ink-soft)]">
                  <span className="shrink-0" style={{ color: AMBER }}>
                    •
                  </span>
                  {n}
                </li>
              ))}
            </ul>
          </motion.div>
        ) : (
          <motion.div
            key="pill"
            layout
            initial={{ opacity: 0, y: 14, scale: 0.9 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, scale: 0.9 }}
            className="flex items-center gap-1.5"
          >
            <motion.button
              whileHover={{ y: -2 }}
              whileTap={{ scale: 0.96 }}
              onClick={() => setOpen(true)}
              className="jb-float flex items-center gap-2 rounded-full border bg-[var(--surface-solid)] px-3 py-1.5 text-[12px] font-semibold card-shadow"
              style={{ borderColor: 'rgba(245,158,11,0.5)', color: AMBER }}
            >
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-60" style={{ background: AMBER }} />
                <span className="relative inline-flex h-2 w-2 rounded-full" style={{ background: AMBER }} />
              </span>
              <WarningIcon size={13} color={AMBER} /> {notes.length} {notes.length === 1 ? 'notice' : 'notices'}
              <span className="opacity-70">▴</span>
            </motion.button>
            <button
              type="button"
              onClick={() => setHidden(true)}
              className="jb-float grid h-6 w-6 place-items-center rounded-full border bg-[var(--surface-solid)] text-[14px] leading-none text-[var(--muted)] card-shadow hover:text-[var(--ink)]"
              style={{ borderColor: 'rgba(245,158,11,0.5)' }}
              aria-label="Dismiss notices"
              title="Dismiss"
            >
              ×
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
