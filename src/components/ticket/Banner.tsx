import type { CSSProperties, ReactNode } from 'react'
import { lift, tint } from '../../lib/tone'

/**
 * The drawer's banners (PR readiness, AI brief, "taken from you"…) share ONE anatomy and ONE colour code, so they read
 * as a family and each is recognised by its colour before it is read:
 *
 *   report  the verdict's own tone (green ships · amber open scope · red blocked)   — "can this ship?"
 *   ai      violet                                                                    — written by the AI intern
 *   taken   orange                                                                    — a ticket taken from you
 *
 * Anatomy: a neutral glass surface (the glass is never tinted), a 3px rail on the left in the banner's colour, an icon
 * tile, a small-caps label that says WHAT the banner is, then its title and chips; a right-hand meta line.
 */
export const BANNER_HUE = { ai: '#a855f7', taken: '#f97316' } as const

/** The frame's style: neutral glass, the colour on the rail and the hairline only (plus a very light wash under the sheen). */
export function bannerStyle(hue: string, o: { dashed?: boolean } = {}): CSSProperties {
  return {
    borderColor: tint(hue, o.dashed ? 0.5 : 0.35),
    borderLeftWidth: 3,
    borderLeftColor: hue,
    borderStyle: o.dashed ? 'dashed' : 'solid',
    backgroundImage: `var(--glass-sheen), linear-gradient(100deg, ${tint(hue, 0.08)}, ${tint(hue, 0.015)} 70%)`,
  }
}

export const BANNER_FRAME = 'mb-4 rounded-xl border bg-[var(--surface-solid)] card-shadow'

/** The icon tile at the banner's left: the colour as a soft square with a hairline, the glyph lifted for dark mode. */
export function BannerIcon({ hue, children }: { hue: string; children: ReactNode }) {
  return (
    <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg" style={{ background: tint(hue, 0.16), boxShadow: `inset 0 0 0 1px ${tint(hue, 0.28)}` }} aria-hidden>
      {children}
    </span>
  )
}

/** The small-caps label that says what the banner is — the same size and tone on every banner. */
export function BannerLabel({ children }: { children: ReactNode }) {
  return <span className="text-[9.5px] font-bold uppercase tracking-[0.09em] text-[var(--muted)]">{children}</span>
}

/** Label over title, with chips after — the banner's main line. */
export function BannerHead({ hue, label, title, chips }: { hue: string; label: string; title: ReactNode; chips?: ReactNode }) {
  return (
    <span className="flex min-w-0 flex-col gap-0.5">
      <BannerLabel>{label}</BannerLabel>
      <span className="flex flex-wrap items-center gap-2">
        <span className="text-[13px] font-extrabold leading-tight" style={{ color: lift(hue) }}>
          {title}
        </span>
        {chips}
      </span>
    </span>
  )
}

/** A right-hand meta line (when, by whom) — muted, small caps, never competing with the title. */
export function BannerMeta({ children }: { children: ReactNode }) {
  return <span className="ml-auto shrink-0 text-[10px] font-medium uppercase tracking-wide text-[var(--muted)]">{children}</span>
}
