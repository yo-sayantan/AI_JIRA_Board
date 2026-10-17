import type { Transition } from 'motion/react'

/**
 * The board's motion tokens — every interaction curve, duration and spring lives here, so the
 * board moves as one thing instead of forty hand-tuned springs. Values come from the design
 * skills in `.claude/skills/` (`animate`, `emil-design-eng`, `apple-design`); docs/AGENTS.md →
 * "UI style guardrails" says when to use which.
 *
 * Rules the values encode (and `motion.test.ts` pins):
 * - Never ease-in on UI. Entering / exiting / responding = strong ease-out.
 * - Feedback the user sees tens of times a day (hover, press) is fast and NEVER bouncy.
 * - Press scales 0.95–0.98; nothing enters from scale(0).
 * - Exits are faster than entrances: the user has already decided.
 * - Modals scale from their centre; popovers from their trigger (`origin-*` on the element).
 *
 * This is the Apple flavour (branch ui/motion-apple, from the apple-design skill): critically damped
 * springs everywhere (no fixed curves), so any motion can be grabbed and reversed from where it is
 * with its velocity; bounce only after a gesture that carried momentum (a flick, a drag release).
 *
 * The "Motion & animations" switch and the OS reduce-motion setting need no wiring here:
 * `MotionGlobalConfig.skipAnimations` (lib/motionPolicy.ts) and `<MotionConfig reducedMotion="user">`
 * (main.tsx) cover every framer-motion animation these tokens drive.
 */

/** Strong ease-out — anything entering, exiting or answering the user. CSS twin: `--ease-out`. */
export const EASE_OUT = [0.23, 1, 0.32, 1] as const
/** Strong ease-in-out — something already on screen moving from A to B. CSS twin: `--ease-in-out`. */
export const EASE_IN_OUT = [0.77, 0, 0.175, 1] as const
/** iOS-like sheet curve. CSS twin: `--ease-drawer`. */
export const EASE_DRAWER = [0.32, 0.72, 0, 1] as const

/** Press / hover feedback on buttons and chips — a critically damped spring, so a hover that ends
 *  mid-grow reverses from where it is, with its velocity, instead of restarting a curve. */
export const PRESS: Transition = { type: 'spring', duration: 0.15, bounce: 0 }
export const PRESS_SCALE = 0.96
/** Icon buttons grow this much under the pointer — near-imperceptible, because it happens all day. */
export const HOVER_SCALE = 1.04

/** Spread onto a `motion.button`: subtle hover, firm press, no bounce. */
export const PRESSABLE = {
  whileHover: { scale: HOVER_SCALE },
  whileTap: { scale: PRESS_SCALE },
  transition: PRESS,
} as const

/** Something on screen moving to a new place (layout shifts, cards re-flowing) — critically damped. */
export const LAYOUT: Transition = { type: 'spring', bounce: 0, duration: 0.4 }

/** The ticket drawer sliding in from the right and back out the same way. */
export const DRAWER: Transition = { type: 'spring', bounce: 0, duration: 0.42 }
/**
 * Dragging the drawer: past its open position it rubber-bands; let go short of dismissing and it
 * springs home slightly under-damped (damping ratio 0.8 — Apple's sheet value: the gesture carried
 * momentum, so a little overshoot reads as physical). framer's dragTransition takes the physics form.
 */
export const DRAWER_RETURN = { bounceStiffness: 400, bounceDamping: 32 } as const

/**
 * Where a flick is GOING, not where it was let go (Apple's projection, Designing Fluid Interfaces):
 * the distance a scroll-like deceleration would still travel from `velocity` px/s.
 */
export function project(velocity: number, decelerationRate = 0.998): number {
  return ((velocity / 1000) * decelerationRate) / (1 - decelerationRate)
}

/** Should a horizontal drag-to-dismiss commit? Judged on the projected resting point, so a quick flick is enough. */
export function flickDismisses(offset: number, velocity: number, width: number, fraction = 0.5): boolean {
  if (offset <= 0 && velocity <= 0) return false
  return offset + project(velocity) > width * fraction
}

/** Dimming scrim behind a modal or the drawer stack. */
export const SCRIM = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: { duration: 0.2, ease: EASE_OUT } },
  exit: { opacity: 0, transition: { duration: 0.16, ease: EASE_OUT } },
} as const

/**
 * A centred modal panel (Settings, API keys, Completed, Raised, a PR report). It MATERIALIZES — the
 * glass arrives out of a soft blur while it grows — rather than just fading (apple-design §12).
 */
export const DIALOG = {
  initial: { opacity: 0, scale: 0.96, filter: 'blur(6px)' },
  animate: { opacity: 1, scale: 1, filter: 'blur(0px)', transition: { type: 'spring', duration: 0.3, bounce: 0 } },
  exit: { opacity: 0, scale: 0.98, filter: 'blur(4px)', transition: { type: 'spring', duration: 0.2, bounce: 0 } },
} as const

/** The board behind a modal recedes a little — dim to focus, push back (apple-design §12). */
export const RECEDE = { scale: 0.985, transition: { type: 'spring', duration: 0.4, bounce: 0 } } as const

/** A menu / popover. Give the element an `origin-*` class at its trigger. */
export const POPOVER = {
  initial: { opacity: 0, scale: 0.97 },
  animate: { opacity: 1, scale: 1, transition: { type: 'spring', duration: 0.16, bounce: 0 } },
  exit: { opacity: 0, scale: 0.98, transition: { type: 'spring', duration: 0.1, bounce: 0 } },
} as const

/** A notification arriving from below and leaving the way it came. */
export const TOAST = {
  initial: { opacity: 0, y: 16, scale: 0.97 },
  animate: { opacity: 1, y: 0, scale: 1, transition: { type: 'spring', duration: 0.28, bounce: 0 } },
  exit: { opacity: 0, y: 8, scale: 0.97, transition: { type: 'spring', duration: 0.16, bounce: 0 } },
} as const

/** Rows expanding / collapsing (accordion). `height` is tolerated only here. */
export const COLLAPSE: Transition = { duration: 0.22, ease: EASE_OUT }
