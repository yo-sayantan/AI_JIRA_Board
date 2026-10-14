/**
 * The light / dark switch, animated from the header's sun / moon button: going dark, the new theme spreads out of the
 * button; going light, the old one folds back into it — both through a soft radial gradient edge (styles/glass.css,
 * "Theme switch"). Uses the View Transitions API (the page is snapshotted, the theme applied, then the snapshots are
 * masked); a browser without it gets a short colour fade instead.
 *
 * Settings → "Motion & animations" off (`jb-no-anim` on <html>) or the OS reduce-motion preference: the theme simply
 * changes, nothing moves. A failure anywhere still applies the theme — the switch must always work.
 */

type ViewTransitionLike = { ready: Promise<void>; finished: Promise<void> }
type ViewTransitionDocument = Document & { startViewTransition?: (update: () => void) => ViewTransitionLike }

const DURATION_MS = 720
const EASING = 'cubic-bezier(0.22, 1, 0.36, 1)'
export const FADE_MS = 420
const CLASSES = ['jb-theme-vt', 'jb-theme-vt-in', 'jb-theme-vt-out']
const VARS = ['--jb-vt-x', '--jb-vt-y', '--jb-vt-feather', '--jb-vt-max']

/** May the switch move at all? Not with the board's motion switch off, nor with the OS asking for reduced motion. */
export function themeMotionAllowed(doc: Document = document): boolean {
  if (doc.documentElement.classList.contains('jb-no-anim')) return false
  try {
    return !(doc.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false)
  } catch {
    return true
  }
}

/** The geometry of the reveal: its centre (the button's), the radius that covers the far corner, and the soft edge's width. */
export function revealGeometry(origin: { left: number; top: number; width: number; height: number } | null, vw: number, vh: number) {
  const x = origin ? origin.left + origin.width / 2 : vw
  const y = origin ? origin.top + origin.height / 2 : 0
  const cover = Math.hypot(Math.max(x, vw - x), Math.max(y, vh - y))
  const feather = Math.round(Math.max(90, cover * 0.2))
  // The gradient edge is `feather` wide and ends at the radius, so the radius must pass the far corner by that much.
  return { x: Math.round(x), y: Math.round(y), feather, max: Math.ceil(cover + feather) }
}

/**
 * Switch the theme with the reveal. `apply` must change the theme SYNCHRONOUSLY (the snapshot of the new state is taken
 * when it returns) — the header passes a flushSync'd state update that also sets the `dark` class directly.
 */
export function switchTheme(origin: Element | null | undefined, toDark: boolean, apply: () => void, doc: Document = document): void {
  const root = doc.documentElement
  if (!themeMotionAllowed(doc)) {
    apply()
    return
  }
  const vtDoc = doc as ViewTransitionDocument
  if (typeof vtDoc.startViewTransition !== 'function') {
    fade(root, apply, doc)
    return
  }
  const view = doc.defaultView
  const g = revealGeometry(origin?.getBoundingClientRect() ?? null, view?.innerWidth ?? 0, view?.innerHeight ?? 0)
  root.style.setProperty('--jb-vt-x', `${g.x}px`)
  root.style.setProperty('--jb-vt-y', `${g.y}px`)
  root.style.setProperty('--jb-vt-feather', `${g.feather}px`)
  root.style.setProperty('--jb-vt-max', `${g.max}px`)
  root.classList.add('jb-theme-vt', toDark ? 'jb-theme-vt-in' : 'jb-theme-vt-out')
  const cleanup = () => {
    root.classList.remove(...CLASSES)
    for (const v of VARS) root.style.removeProperty(v)
  }
  let vt: ViewTransitionLike
  try {
    vt = vtDoc.startViewTransition.call(doc, apply)
  } catch {
    cleanup()
    apply()
    return
  }
  vt.ready
    .then(() => {
      const radius = toDark ? ['0px', `${g.max}px`] : [`${g.max}px`, '0px']
      root.animate(
        { '--jb-vt-r': radius },
        { duration: DURATION_MS, easing: EASING, fill: 'both', pseudoElement: toDark ? '::view-transition-new(root)' : '::view-transition-old(root)' },
      )
    })
    .catch(() => {
      /* the transition was skipped (e.g. the tab is hidden): the theme is applied all the same */
    })
  vt.finished.then(cleanup, cleanup)
}

/** No View Transitions: colours cross-fade for a moment (`.jb-theme-fade` in glass.css), then the class goes away. */
function fade(root: HTMLElement, apply: () => void, doc: Document): void {
  root.classList.add('jb-theme-fade')
  apply()
  doc.defaultView?.setTimeout(() => root.classList.remove('jb-theme-fade'), FADE_MS)
}
