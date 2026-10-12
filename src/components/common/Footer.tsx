import { BRANDING } from '../../lib/appConfig'

/** Very thin, fixed footer — credits + a pastel "made by" badge (text/link from config.json). */
export function Footer() {
  return (
    <footer className="fixed inset-x-3 bottom-2 z-30 flex h-9 items-center gap-3 rounded-xl border border-[var(--line)] bg-[var(--bg)]/85 px-4 text-[11px] text-[var(--muted)] backdrop-blur-xl md:inset-x-5 lg:inset-x-6">
      <span className="min-w-0 flex-1 truncate">{BRANDING.tagline}</span>

      <span className="hidden shrink-0 items-center gap-2 sm:flex">
        <span>
          <kbd className="rounded border border-[var(--line)] px-1">/</kbd> search
        </span>
        <span>
          <kbd className="rounded border border-[var(--line)] px-1">r</kbd> refresh
        </span>
      </span>

      {/* Only when the config names someone — an unset badge would otherwise render as an
          empty pill linking nowhere for anyone who cloned this without setting branding. */}
      {BRANDING.badgeText && (
        <a
          href={BRANDING.badgeUrl || undefined}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex shrink-0 items-center gap-1 rounded-full px-2.5 py-[3px] text-[11px] font-extrabold tracking-tight ring-1 ring-white/25 transition-[transform,filter] hover:scale-[1.07] hover:brightness-110"
          style={{
            color: '#ffffff',
            background: 'linear-gradient(135deg, #6366f1 0%, #7c3aed 55%, #a855f7 100%)',
            boxShadow: '0 2px 12px -2px rgba(124,58,237,0.6)',
          }}
          title={BRANDING.badgeTitle}
        >
          <span aria-hidden style={{ color: 'rgba(255,255,255,0.9)' }}>✦</span> {BRANDING.badgeText}
        </a>
      )}
    </footer>
  )
}
