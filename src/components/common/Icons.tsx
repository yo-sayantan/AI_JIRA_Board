import { useId } from 'react'

// Self-contained inline SVG icon set (no CDN — works offline from file://).
// Modern "lineal" look; coloured via the `color` prop or inherited currentColor.

type IP = { size?: number; className?: string; color?: string }

// Global icon scale — every icon renders 40% larger than its requested `size`.
export const ICON_SCALE = 1.4
const px = (n: number) => Math.round(n * ICON_SCALE)

const svg = (size: number, className: string) => ({
  width: px(size),
  height: px(size),
  viewBox: '0 0 24 24',
  fill: 'none' as const,
  className,
  'aria-hidden': true as const,
})
const line = (color: string, w = 2) => ({ stroke: color, strokeWidth: w, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const })

export function ChevronIcon({ size = 12, className = '' }: IP) {
  return (
    <svg {...svg(size, className)}>
      <path d="M9 6l6 6-6 6" {...line('currentColor', 2.6)} />
    </svg>
  )
}

export function RefreshIcon({ size = 16, className = '', color }: IP) {
  const id = useId()
  const fill = color ?? `url(#${id})`
  return (
    <svg {...svg(size, className)}>
      {!color && (
        <defs>
          <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#7c5cff" />
            <stop offset="1" stopColor="#22b8ff" />
          </linearGradient>
        </defs>
      )}
      <path
        d="M17.65 6.35A7.95 7.95 0 0 0 12 4a8 8 0 1 0 7.73 10h-2.08A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"
        fill={fill}
      />
    </svg>
  )
}

/**
 * Priority: a rounded tile with one bold glyph per tier — a different SHAPE for each, so the tiers
 * read at 16px without a legend. Critical is the one solid tile (white "!"); every other tier is a
 * tinted tile with a bold chevron in the tier's colour.
 *   6 Critical  !  on a solid deep-red tile     3 Medium   —  amber
 *   5 Highest   double chevron up   red         2 Low      ⌄  green
 *   4 High      single chevron up   orange      1 Lowest   double chevron down  sky
 *   0 None      a quiet grey dot
 */
export function PriorityIcon({ rank, color, size = 15 }: { rank: number; color: string; size?: number }) {
  const c = (width: number) => ({ fill: 'none', stroke: color, strokeWidth: width, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const })
  return (
    <svg width={px(size)} height={px(size)} viewBox="0 0 24 24" aria-hidden>
      {rank >= 6 ? (
        <>
          <rect x="1" y="1" width="22" height="22" rx="7" fill={color} />
          <path d="M12 6.5v7" fill="none" stroke="#fff" strokeWidth="2.8" strokeLinecap="round" />
          <circle cx="12" cy="17.4" r="1.6" fill="#fff" />
        </>
      ) : (
        <>
          <rect x="1" y="1" width="22" height="22" rx="7" fill={color} fillOpacity={rank <= 0 ? 0.12 : 0.2} />
          {rank === 5 && <path d="M6.5 11.5l5.5-5 5.5 5M6.5 17.5l5.5-5 5.5 5" {...c(2.8)} />}
          {rank === 4 && <path d="M6.5 14.5l5.5-5.5 5.5 5.5" {...c(2.8)} />}
          {rank === 3 && <path d="M7 12h10" {...c(3)} />}
          {rank === 2 && <path d="M6.5 9.5l5.5 5.5 5.5-5.5" {...c(2.8)} />}
          {rank === 1 && <path d="M6.5 6.5l5.5 5 5.5-5M6.5 12.5l5.5 5 5.5-5" {...c(2.8)} />}
          {rank <= 0 && <circle cx="12" cy="12" r="2.6" fill={color} />}
        </>
      )}
    </svg>
  )
}

export function ExpandAllIcon({ collapsed, size = 13, className = '' }: { collapsed: boolean; size?: number; className?: string }) {
  return (
    <svg {...svg(size, className)}>
      {collapsed ? (
        <>
          <path d="M8 9l4 4 4-4" {...line('currentColor', 2.4)} />
          <path d="M8 4l4 3 4-3" {...line('currentColor', 2.4)} opacity="0.5" />
        </>
      ) : (
        <>
          <path d="M8 13l4-4 4 4" {...line('currentColor', 2.4)} />
          <path d="M8 20l4-3 4 3" {...line('currentColor', 2.4)} opacity="0.5" />
        </>
      )}
    </svg>
  )
}

// ── Issue type ───────────────────────────────────────────────────────────
export function TypeIcon({ type, color = 'currentColor', size = 14 }: { type?: string | null; color?: string; size?: number }) {
  const t = (type ?? '').toLowerCase()
  const s = line(color, 1.9)
  let body
  if (/bug|defect/.test(t)) {
    body = (
      <>
        <rect x="7.5" y="7.5" width="9" height="10" rx="4.5" stroke={color} strokeWidth="1.9" />
        <path d="M12 3v3M5 9l2.5 1M19 9l-2.5 1M4.5 13H7M17 13h2.5M5 18l2.6-1.6M19 18l-2.6-1.6" {...s} />
      </>
    )
  } else if (/security|vuln|cve/.test(t)) {
    body = <path d="M12 3l7 3v5c0 4.4-3 8-7 10-4-2-7-5.6-7-10V6l7-3z" stroke={color} strokeWidth="1.9" strokeLinejoin="round" />
  } else if (/story/.test(t)) {
    body = <path d="M6 4h9a3 3 0 0 1 3 3v13l-4-2.5L10 20V4" stroke={color} strokeWidth="1.9" strokeLinejoin="round" />
  } else if (/epic/.test(t)) {
    body = <path d="M12 3l8 4.5-8 4.5-8-4.5L12 3zM4 12l8 4.5L20 12M4 16.5L12 21l8-4.5" {...s} />
  } else if (/sub-?task/.test(t)) {
    body = (
      <>
        <path d="M6 5v7a3 3 0 0 0 3 3h7" {...s} />
        <path d="M14 12l4 3-4 3" {...s} />
      </>
    )
  } else if (/spike|research/.test(t)) {
    body = <path d="M10 3h4M9 3v5l-4 9a2 2 0 0 0 1.8 3h10.4A2 2 0 0 0 19 17l-4-9V3" {...s} />
  } else if (/improvement|enhance/.test(t)) {
    body = <path d="M12 3l1.8 4.4L18 9l-4.2 1.6L12 15l-1.8-4.4L6 9l4.2-1.6L12 3zM18 15l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8.8-2z" fill={color} />
  } else if (/support|service[\s-]?desk|incident|helpdesk/.test(t)) {
    body = (
      <>
        <path d="M4.5 13a7.5 7.5 0 0 1 15 0" {...s} />
        <rect x="3.5" y="12.5" width="4" height="6" rx="1.8" stroke={color} strokeWidth="1.9" />
        <rect x="16.5" y="12.5" width="4" height="6" rx="1.8" stroke={color} strokeWidth="1.9" />
        <path d="M18.5 18.5v.5a2.5 2.5 0 0 1-2.5 2.5h-3" {...s} />
      </>
    )
  } else if (/requirement/.test(t)) {
    body = (
      <>
        <rect x="5" y="4.5" width="14" height="16" rx="2.5" stroke={color} strokeWidth="1.9" />
        <path d="M9 3h6v3.5H9z" stroke={color} strokeWidth="1.9" strokeLinejoin="round" />
        <path d="M8.5 11.5h7M8.5 15h5" {...s} />
      </>
    )
  } else if (/tech[\s-]?debt|refactor/.test(t)) {
    body = <path d="M15 6.5a3.5 3.5 0 0 0-4.6 4.3l-6 6 2.8 2.8 6-6A3.5 3.5 0 0 0 17.5 9l-2 2-2-2 2-2z" stroke={color} strokeWidth="1.9" strokeLinejoin="round" />
  } else if (/release|deploy/.test(t)) {
    body = (
      <>
        <path d="M12 2.5c2.8 2 4.2 5.1 4.2 8.3 0 1.9-.4 3.6-1.1 5.2H8.9a13 13 0 0 1-1.1-5.2c0-3.2 1.4-6.3 4.2-8.3z" stroke={color} strokeWidth="1.9" strokeLinejoin="round" />
        <circle cx="12" cy="9.5" r="1.8" stroke={color} strokeWidth="1.6" />
        <path d="M8.9 13.5L6 16.5l3.4.7M15.1 13.5L18 16.5l-3.4.7M12 18.5v3" {...s} />
      </>
    )
  } else if (/onboard/.test(t)) {
    body = (
      <>
        <path d="M12 4L2.5 8.5 12 13l9.5-4.5L12 4z" stroke={color} strokeWidth="1.9" strokeLinejoin="round" />
        <path d="M6.5 11v4.3c0 1.5 2.5 2.9 5.5 2.9s5.5-1.4 5.5-2.9V11" {...s} />
        <path d="M21 9v4.5" {...s} />
      </>
    )
  } else if (/task/.test(t)) {
    body = (
      <>
        <rect x="4" y="4" width="16" height="16" rx="3.5" stroke={color} strokeWidth="1.9" />
        <path d="M8 12l2.5 2.5L16 9" {...s} />
      </>
    )
  } else {
    body = (
      <>
        <path d="M4 8a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2 2 2 0 0 0 0 4 2 2 0 0 1 0 4 2 2 0 0 1-2 2H6a2 2 0 0 1-2-2 2 2 0 0 0 0-4 2 2 0 0 1 0-4z" stroke={color} strokeWidth="1.9" />
        <path d="M12 8v8" stroke={color} strokeWidth="1.6" strokeDasharray="1.5 2.5" />
      </>
    )
  }
  return <svg {...svg(size, '')}>{body}</svg>
}

// ── PR state ───────────────────────────────────────────────────────────────
export function PrStateIcon({ state, color = 'currentColor', size = 13 }: { state?: string | null; color?: string; size?: number }) {
  const s = line(color, 1.9)
  if (state === 'merged') {
    return (
      <svg {...svg(size, '')}>
        <circle cx="6" cy="6" r="2.4" stroke={color} strokeWidth="1.9" />
        <circle cx="6" cy="18" r="2.4" stroke={color} strokeWidth="1.9" />
        <circle cx="18" cy="15" r="2.4" stroke={color} strokeWidth="1.9" />
        <path d="M6 8.4v7.2M6 11a6 6 0 0 0 6 6h3.6" {...s} />
      </svg>
    )
  }
  if (state === 'approved') {
    return (
      <svg {...svg(size, '')}>
        <circle cx="12" cy="12" r="9" stroke={color} strokeWidth="1.9" />
        <path d="M8 12l2.5 2.5L16 9" {...s} />
      </svg>
    )
  }
  if (state === 'changes' || state === 'declined') {
    return (
      <svg {...svg(size, '')}>
        <circle cx="12" cy="12" r="9" stroke={color} strokeWidth="1.9" />
        <path d="M9 9l6 6M15 9l-6 6" {...s} />
      </svg>
    )
  }
  // comments / generic PR
  return (
    <svg {...svg(size, '')}>
      <circle cx="6" cy="6" r="2.4" stroke={color} strokeWidth="1.9" />
      <circle cx="6" cy="18" r="2.4" stroke={color} strokeWidth="1.9" />
      <circle cx="18" cy="18" r="2.4" stroke={color} strokeWidth="1.9" />
      <path d="M6 8.4v7.2M18 15.6V12a4 4 0 0 0-4-4h-3" {...s} />
      <path d="M11 5L8.6 8M11 11L8.6 8" {...s} />
    </svg>
  )
}

// ── Column header ────────────────────────────────────────────────────────
export function ColumnIcon({ col, color = 'currentColor', size = 14 }: { col: string; color?: string; size?: number }) {
  const s = line(color, 1.9)
  if (col === 'todo')
    return (
      <svg {...svg(size, '')}>
        <path d="M9 6h11M9 12h11M9 18h11" {...s} />
        <circle cx="4.5" cy="6" r="1.4" fill={color} />
        <circle cx="4.5" cy="12" r="1.4" fill={color} />
        <circle cx="4.5" cy="18" r="1.4" fill={color} />
      </svg>
    )
  if (col === 'blocked')
    return (
      <svg {...svg(size, '')}>
        <circle cx="12" cy="12" r="9" stroke={color} strokeWidth="1.9" />
        <path d="M5.8 5.8l12.4 12.4" {...s} />
      </svg>
    )
  if (col === 'prog')
    return (
      <svg {...svg(size, '')}>
        <circle cx="12" cy="12" r="3" stroke={color} strokeWidth="1.9" />
        <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1" {...s} />
      </svg>
    )
  if (col === 'rev')
    return (
      <svg {...svg(size, '')}>
        <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" stroke={color} strokeWidth="1.9" strokeLinejoin="round" />
        <circle cx="12" cy="12" r="3" stroke={color} strokeWidth="1.9" />
      </svg>
    )
  if (col === 'qa')
    return (
      <svg {...svg(size, '')}>
        <path d="M9 3h6M10 3v5l-4.5 9A2 2 0 0 0 7.3 20h9.4a2 2 0 0 0 1.8-3L14 8V3" {...s} />
        <path d="M7.5 14h9" {...s} />
      </svg>
    )
  // done
  return (
    <svg {...svg(size, '')}>
      <circle cx="12" cy="12" r="9" stroke={color} strokeWidth="1.9" />
      <path d="M8 12l2.6 2.6L16 9" {...s} />
    </svg>
  )
}

// ── UI glyphs ──────────────────────────────────────────────────────────────
export function SearchIcon({ size = 14, className = '', color = 'currentColor' }: IP) {
  return (
    <svg {...svg(size, className)}>
      <circle cx="11" cy="11" r="7" stroke={color} strokeWidth="2" />
      <path d="M21 21l-4.3-4.3" {...line(color, 2)} />
    </svg>
  )
}

export function CommentIcon({ size = 13, className = '', color = 'currentColor' }: IP) {
  return (
    <svg {...svg(size, className)}>
      <path d="M21 11.5a7.5 7.5 0 0 1-10.9 6.7L4 20l1.8-4.2A7.5 7.5 0 1 1 21 11.5z" stroke={color} strokeWidth="1.8" strokeLinejoin="round" />
    </svg>
  )
}

export function SunIcon({ size = 16, className = '' }: IP) {
  return (
    <svg {...svg(size, className)}>
      <circle cx="12" cy="12" r="4" fill="#f59e0b" />
      <path d="M12 2.5v2.5M12 19v2.5M2.5 12H5M19 12h2.5M5.2 5.2l1.8 1.8M17 17l1.8 1.8M18.8 5.2L17 7M7 17l-1.8 1.8" {...line('#f59e0b', 2)} />
    </svg>
  )
}

export function MoonIcon({ size = 16, className = '' }: IP) {
  return (
    <svg {...svg(size, className)}>
      <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" fill="#c4b5fd" stroke="#a78bfa" strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
  )
}

export function WarningIcon({ size = 14, className = '', color = '#f59e0b' }: IP) {
  return (
    <svg {...svg(size, className)}>
      <path d="M12 3.5l9 15.5H3l9-15.5z" fill={color} opacity="0.18" stroke={color} strokeWidth="1.8" strokeLinejoin="round" />
      <path d="M12 9.5v4" {...line(color, 2)} />
      <circle cx="12" cy="16.6" r="1.1" fill={color} />
    </svg>
  )
}

export function TrophyIcon({ size = 16, className = '', glint = false }: IP & { glint?: boolean }) {
  return (
    <svg {...svg(size, className)}>
      <path d="M7 4h10v4a5 5 0 0 1-10 0V4z" fill="#fbbf24" stroke="#f59e0b" strokeWidth="1.3" strokeLinejoin="round" />
      <path d="M7 5H4v2a3 3 0 0 0 3 3M17 5h3v2a3 3 0 0 1-3 3" stroke="#f59e0b" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M10 13.5h4M9 20h6M12 13.5V17" stroke="#f59e0b" strokeWidth="1.8" strokeLinecap="round" />
      {glint && (
        <g className="trophy-glint">
          <path d="M11.5 5l0.5 1.3 1.3 0.5-1.3 0.5-0.5 1.3-0.5-1.3-1.3-0.5 1.3-0.5z" fill="#fffdf2" />
        </g>
      )}
    </svg>
  )
}

/** Raised-by-me: a megaphone — "I called this out". */
export function MegaphoneIcon({ size = 14, className = '', color = 'currentColor' }: IP) {
  return (
    <svg {...svg(size, className)}>
      <path d="M4 10v4a1.5 1.5 0 0 0 1.5 1.5H8L15 20V4L8 8.5H5.5A1.5 1.5 0 0 0 4 10z" stroke={color} strokeWidth="1.8" strokeLinejoin="round" />
      <path d="M18 9.5a3.4 3.4 0 0 1 0 5" stroke={color} strokeWidth="1.8" strokeLinecap="round" />
      <path d="M8.5 15.8l1 4.2" stroke={color} strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  )
}

export function PersonIcon({ size = 11, className = '', color = 'currentColor' }: IP) {
  return (
    <svg {...svg(size, className)}>
      <circle cx="12" cy="8" r="3.6" stroke={color} strokeWidth="1.9" />
      <path d="M5 20a7 7 0 0 1 14 0" stroke={color} strokeWidth="1.9" strokeLinecap="round" />
    </svg>
  )
}

export function PauseIcon({ size = 15, className = '', color = '#f97316' }: IP) {
  return (
    <svg {...svg(size, className)}>
      <rect x="6.5" y="5" width="3.5" height="14" rx="1.4" fill={color} />
      <rect x="14" y="5" width="3.5" height="14" rx="1.4" fill={color} />
    </svg>
  )
}

/** Four-way move arrows — drag-and-drop status changes. */
export function MoveIcon({ size = 15, className = '', color = '#8b5cf6' }: IP) {
  return (
    <svg {...svg(size, className)}>
      <path d="M12 3v18M3 12h18" {...line(color, 2)} />
      <path d="M9 6l3-3 3 3M9 18l3 3 3-3M6 9l-3 3 3 3M18 9l3 3-3 3" {...line(color, 2)} />
    </svg>
  )
}

/** Lab flask — sample data / testing. */
export function FlaskIcon({ size = 13, className = '', color = 'currentColor' }: IP) {
  return (
    <svg {...svg(size, className)}>
      <path d="M9 3h6M10 3v5l-4.5 9A2 2 0 0 0 7.3 20h9.4a2 2 0 0 0 1.8-3L14 8V3" {...line(color, 1.9)} />
      <path d="M7.5 14h9" {...line(color, 1.9)} />
    </svg>
  )
}

/** Shield with a tick — Checkmarx: which vulnerabilities a fix ticket fixed. */
export function ShieldIcon({ size = 12, className = '', color = 'currentColor' }: IP) {
  return (
    <svg {...svg(size, className)}>
      <path d="M12 3l7 3v5.5c0 4.3-2.9 8.1-7 9.5-4.1-1.4-7-5.2-7-9.5V6l7-3z" {...line(color, 1.9)} />
      <path d="M9 12l2.2 2.2L15.5 10" {...line(color, 1.9)} />
    </svg>
  )
}

/** Padlock — a shelf only another team moves cards onto. */
export function EyeOffIcon({ size = 13, className = '', color = 'currentColor' }: IP) {
  return (
    <svg {...svg(size, className)}>
      <path d="M3 3l18 18" {...line(color, 2)} />
      <path d="M10.6 6.2A9.8 9.8 0 0 1 12 6c6 0 9.5 6 9.5 6a14 14 0 0 1-3.2 3.7M6.2 7.5A14 14 0 0 0 2.5 12S6 18 12 18c1.3 0 2.5-.3 3.6-.7" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function EyeIcon({ size = 13, className = '', color = 'currentColor' }: IP) {
  return (
    <svg {...svg(size, className)}>
      <path d="M2.5 12S6 6 12 6s9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6z" {...line(color, 1.8)} />
      <circle cx="12" cy="12" r="2.6" stroke={color} strokeWidth="1.8" />
    </svg>
  )
}

export function KeyIcon({ size = 16, className = '', color = 'currentColor' }: IP) {
  return (
    <svg {...svg(size, className)}>
      <circle cx="8" cy="15" r="4.2" stroke={color} strokeWidth="1.9" />
      <path d="M11 12l8.5-8.5M16.5 6.5l2.5 2.5M14.3 8.7l2 2" {...line(color, 1.9)} />
    </svg>
  )
}

export function TicketGlyph({ size = 18, className = '' }: IP) {
  return (
    <svg width={px(size)} height={px(size)} viewBox="0 0 24 24" className={className} aria-hidden>
      <path d="M4 7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2 2 2 0 0 0 0 4 2 2 0 0 1 0 4 2 2 0 0 1-2 2H6a2 2 0 0 1-2-2 2 2 0 0 0 0-4 2 2 0 0 1 0-4z" fill="#fff" opacity="0.95" />
      <path d="M12 6v12" stroke="#6d5bd0" strokeWidth="1.6" strokeDasharray="1.6 2.4" />
    </svg>
  )
}

export function CopyIcon({ size = 12, className = '', color = 'currentColor' }: IP) {
  return (
    <svg {...svg(size, className)}>
      <rect x="8" y="8" width="12" height="12" rx="2.5" stroke={color} strokeWidth="1.9" />
      <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" stroke={color} strokeWidth="1.9" strokeLinecap="round" />
    </svg>
  )
}

export function CheckIcon({ size = 12, className = '', color = 'currentColor' }: IP) {
  return (
    <svg {...svg(size, className)}>
      <path d="M5 12.5l4.5 4.5L19 7" {...line(color, 2.4)} />
    </svg>
  )
}

export function BranchIcon({ size = 14, className = '', color = 'currentColor' }: IP) {
  return (
    <svg {...svg(size, className)}>
      <circle cx="6" cy="5" r="2.4" stroke={color} strokeWidth="1.9" />
      <circle cx="6" cy="19" r="2.4" stroke={color} strokeWidth="1.9" />
      <circle cx="18" cy="7" r="2.4" stroke={color} strokeWidth="1.9" />
      <path d="M6 7.4v9.2M18 9.4c0 4-4 3.6-6 5.6" {...line(color, 1.9)} />
    </svg>
  )
}

export function CalendarIcon({ size = 13, className = '', color = 'currentColor' }: IP) {
  return (
    <svg {...svg(size, className)}>
      <rect x="3.5" y="5" width="17" height="15.5" rx="3" stroke={color} strokeWidth="1.9" />
      <path d="M3.5 10h17M8 3v4M16 3v4" {...line(color, 1.9)} />
      <circle cx="8.2" cy="14.2" r="1.15" fill={color} />
      <circle cx="12" cy="14.2" r="1.15" fill={color} />
      <circle cx="15.8" cy="14.2" r="1.15" fill={color} />
    </svg>
  )
}

// Small generic section icons (detail drawer)
export function ClockIcon({ size = 14, color = 'currentColor' }: IP) {
  return (
    <svg {...svg(size, '')}>
      <circle cx="12" cy="12" r="9" stroke={color} strokeWidth="1.9" />
      <path d="M12 7.5V12l3 2" {...line(color, 1.9)} />
    </svg>
  )
}
export function DocIcon({ size = 14, color = 'currentColor' }: IP) {
  return (
    <svg {...svg(size, '')}>
      <path d="M6 3h7l5 5v13H6V3z" stroke={color} strokeWidth="1.9" strokeLinejoin="round" />
      <path d="M13 3v5h5M9 13h6M9 17h6" {...line(color, 1.7)} />
    </svg>
  )
}
/** Gear — opens the board settings. A plain ring with eight radial teeth: at 16px a cogged
 *  outline turns to mush, while a circle plus straight spokes stays legible. */
export function GearIcon({ size = 16, color = 'currentColor' }: IP) {
  return (
    <svg {...svg(size, '')}>
      <circle cx="12" cy="12" r="6.5" stroke={color} strokeWidth="1.8" fill="none" />
      <circle cx="12" cy="12" r="2.4" stroke={color} strokeWidth="1.8" fill="none" />
      <path
        d="M18.5 12h2.7M16.6 16.6l1.9 1.9M12 18.5v2.7M7.4 16.6l-1.9 1.9M5.5 12H2.8M7.4 7.4L5.5 5.5M12 5.5V2.8M16.6 7.4l1.9-1.9"
        {...line(color, 1.8)}
      />
    </svg>
  )
}
/** Printer — exports the readiness report to a paginated PDF via the browser's print dialog. */
export function PrinterIcon({ size = 14, color = 'currentColor' }: IP) {
  return (
    <svg {...svg(size, '')}>
      <path d="M7 9V3h10v6" stroke={color} strokeWidth="1.9" strokeLinejoin="round" />
      <path d="M5 9h14a2 2 0 0 1 2 2v5h-4v4H7v-4H3v-5a2 2 0 0 1 2-2z" stroke={color} strokeWidth="1.9" strokeLinejoin="round" />
      <path d="M7 16h10" {...line(color, 1.7)} />
    </svg>
  )
}
/** Sparkle — marks the AI-generated summary. */
export function SparkleIcon({ size = 14, color = 'currentColor' }: IP) {
  return (
    <svg {...svg(size, '')}>
      <path d="M12 3l1.9 4.9L19 9.8l-5.1 1.9L12 17l-1.9-5.3L5 9.8l5.1-1.9L12 3z" fill={color} stroke={color} strokeWidth="1.1" strokeLinejoin="round" />
      <path d="M19 3.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z" fill={color} />
    </svg>
  )
}
export function LinkIcon({ size = 14, color = 'currentColor' }: IP) {
  return (
    <svg {...svg(size, '')}>
      <path d="M9 15l6-6M10.5 6.5l1.8-1.8a4 4 0 0 1 5.6 5.6L16 12M13.5 17.5l-1.8 1.8a4 4 0 0 1-5.6-5.6L8 12" {...line(color, 1.9)} />
    </svg>
  )
}
export function BookIcon({ size = 14, color = 'currentColor' }: IP) {
  return (
    <svg {...svg(size, '')}>
      <path d="M5 4h9a2 2 0 0 1 2 2v14H7a2 2 0 0 1-2-2V4z" stroke={color} strokeWidth="1.9" strokeLinejoin="round" />
      <path d="M16 6h3v14H7" {...line(color, 1.6)} />
    </svg>
  )
}
export function GlobeIcon({ size = 14, color = 'currentColor' }: IP) {
  return (
    <svg {...svg(size, '')}>
      <circle cx="12" cy="12" r="9" stroke={color} strokeWidth="1.9" />
      <path d="M3 12h18M12 3c2.5 2.5 2.5 15 0 18M12 3c-2.5 2.5-2.5 15 0 18" {...line(color, 1.5)} />
    </svg>
  )
}
export function WrenchIcon({ size = 14, color = 'currentColor' }: IP) {
  return (
    <svg {...svg(size, '')}>
      <path d="M15 6.5a3.5 3.5 0 0 0-4.6 4.3l-6 6 2.8 2.8 6-6A3.5 3.5 0 0 0 17.5 9l-2 2-2-2 2-2z" stroke={color} strokeWidth="1.8" strokeLinejoin="round" />
    </svg>
  )
}
export function QuestionIcon({ size = 14, color = 'currentColor' }: IP) {
  return (
    <svg {...svg(size, '')}>
      <circle cx="12" cy="12" r="9" stroke={color} strokeWidth="1.9" />
      <path d="M9.5 9.2a2.6 2.6 0 0 1 5 .9c0 1.7-2.5 2.2-2.5 3.9" {...line(color, 1.8)} />
      <circle cx="12" cy="17" r="1.05" fill={color} />
    </svg>
  )
}

/** Tray + downward arrow — queue an Ollama pull for the selected local model. */
export function DownloadIcon({ size = 14, color = 'currentColor' }: IP) {
  return (
    <svg {...svg(size, '')}>
      <path d="M12 4v10" {...line(color, 1.9)} />
      <path d="M8 10.5L12 15l4-4.5" {...line(color, 1.9)} />
      <path d="M5 18h14" {...line(color, 1.9)} />
    </svg>
  )
}
export function PaperclipIcon({ size = 14, color = 'currentColor' }: IP) {
  return (
    <svg {...svg(size, '')}>
      <path d="M20 11l-8.5 8.5a5 5 0 0 1-7-7L13 4a3.5 3.5 0 0 1 5 5l-8.5 8.5a2 2 0 0 1-3-3L15 6" {...line(color, 1.8)} />
    </svg>
  )
}
