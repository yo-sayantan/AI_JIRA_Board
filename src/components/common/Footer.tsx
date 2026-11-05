import { BRANDING } from '../../lib/appConfig'

/** Very thin, fixed footer — credits + the "made by" link (text/link from config.json). */
export function Footer() {
  return (
    <footer className="wf-foot fixed inset-x-0 bottom-0 z-30 flex h-9 items-center gap-4 px-4 text-[11px]">
      <span className="min-w-0 flex-1 truncate">{BRANDING.tagline}</span>

      <span className="hidden shrink-0 items-center gap-3 sm:flex">
        <span>
          <kbd className="wf-key">/</kbd> search
        </span>
        <span>
          <kbd className="wf-key">r</kbd> refresh
        </span>
      </span>

      {/* Only when the config names someone — an unset badge would otherwise render as an
          empty pill linking nowhere for anyone who cloned this without setting branding. */}
      {BRANDING.badgeText && (
        <a
          href={BRANDING.badgeUrl || undefined}
          target="_blank"
          rel="noopener noreferrer"
          className="shrink-0 text-[11px]"
          title={BRANDING.badgeTitle}
        >
          {BRANDING.badgeText}
        </a>
      )}
    </footer>
  )
}
