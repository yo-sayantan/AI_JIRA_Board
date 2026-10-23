import type { TakenFromMe } from '../../types'
import { fmtDate } from '../../lib/format'
import { takenLine, takenMeta, whyLabel } from '../../lib/taken'
import { lift, tint } from '../../lib/tone'
import { CommentIcon, MoveIcon } from '../common/Icons'

/**
 * "Taken from you" on an archive row or a ticket drawer. Static on purpose — it is read, not watched: no entrance, no
 * hover motion. Neutral surface; the reason's colour is on the rail, the chip and the label only (the glass rule: colour
 * comes from the content). The comment is shown as what it is — the comment written when it moved — never as "the reason".
 */
export function TakenBanner({ taken, compact = false }: { taken: TakenFromMe; compact?: boolean }) {
  const meta = takenMeta(taken.reason)
  const c = meta.color
  const others = (taken.reasons ?? []).filter((r) => r !== taken.reason)
  const why = whyLabel(taken)

  if (compact) {
    return (
      <div
        className="flex min-w-0 items-center gap-2 border-t px-3 py-1.5 text-[11.5px]"
        style={{ borderColor: tint(c, 0.22), background: `linear-gradient(90deg, ${tint(c, 0.09)}, transparent 70%)` }}
        title={meta.hint}
      >
        <span className="inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-[1px] text-[10px] font-extrabold uppercase tracking-wide" style={{ color: lift(c), background: tint(c, 0.16) }}>
          <MoveIcon size={10} color={lift(c)} />
          {meta.short}
          {others.length > 0 && <span className="opacity-70">+{others.length}</span>}
        </span>
        <span className="shrink-0 font-semibold text-[var(--ink-soft)]">{takenLine(taken)}</span>
        {taken.why?.text && (
          <span className="min-w-0 flex-1 truncate italic text-[var(--muted)]" title={`${why}: ${taken.why.text}`}>
            “{taken.why.text}”
          </span>
        )}
      </div>
    )
  }

  return (
    <div className="overflow-hidden rounded-xl border" style={{ borderColor: tint(c, 0.35), borderLeftWidth: 3, borderLeftColor: c }}>
      <div className="flex flex-wrap items-center gap-2 px-3.5 py-2.5" style={{ background: `linear-gradient(100deg, ${tint(c, 0.12)}, ${tint(c, 0.03)} 65%)` }}>
        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg" style={{ background: tint(c, 0.18), boxShadow: `inset 0 0 0 1px ${tint(c, 0.3)}` }} aria-hidden>
          <MoveIcon size={14} color={lift(c)} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[10px] font-bold uppercase tracking-[0.08em] text-[var(--muted)]">Taken from you</span>
            <span className="text-[13px] font-extrabold" style={{ color: lift(c) }}>
              {meta.label}
            </span>
            {others.map((r) => {
              const m = takenMeta(r)
              return (
                <span key={r} className="rounded-full px-1.5 py-[1px] text-[10px] font-bold" style={{ color: lift(m.color), background: tint(m.color, 0.14) }} title={m.hint}>
                  {m.short}
                </span>
              )
            })}
          </div>
          <div className="mt-0.5 text-[12px] font-medium text-[var(--ink-soft)]">{takenLine(taken)}</div>
        </div>
      </div>
      <div className="flex flex-col gap-2 bg-[var(--surface-solid)] px-3.5 py-2.5">
        <p className="text-[11.5px] text-[var(--muted)]">{meta.hint}</p>
        {taken.why?.text && (
          <figure className="rounded-lg border border-[var(--line)] bg-[var(--surface-2)] px-3 py-2">
            <figcaption className="mb-1 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.07em] text-[var(--muted)]">
              <CommentIcon size={10} />
              {why}
              {taken.why.when && <span className="font-semibold normal-case tracking-normal">· {fmtDate(taken.why.when)}</span>}
            </figcaption>
            <blockquote className="text-[12.5px] leading-relaxed text-[var(--ink-soft)]">“{taken.why.text}”</blockquote>
          </figure>
        )}
        <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
          <span className="font-bold text-[var(--muted)]">{taken.worked ? 'You had worked on it:' : 'No work of yours recorded on it'}</span>
          {(taken.workedOn ?? []).map((w) => (
            <span key={w} className="rounded-md border border-[var(--line)] bg-[var(--surface-2)] px-1.5 py-[1px] font-medium text-[var(--ink-soft)]">
              {w}
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}
