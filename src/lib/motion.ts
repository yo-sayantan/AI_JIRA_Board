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
 * This is the Emil Kowalski flavour (branch ui/motion-emil): tuned curves and fixed durations,
 * no springs in UI chrome — crisp, fast, predictable; motion that never draws attention to itself.
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

/** Press / hover feedback on buttons and chips. */
export const PRESS: Transition = { duration: 0.16, ease: EASE_OUT }
export const PRESS_SCALE = 0.96
/** Icon buttons grow this much under the pointer — near-imperceptible, because it happens all day. */
export const HOVER_SCALE = 1.04

/** Spread onto a `motion.button`: subtle hover, firm press, no bounce. */
export const PRESSABLE = {
  whileHover: { scale: HOVER_SCALE },
  whileTap: { scale: PRESS_SCALE },
  transition: PRESS,
} as const

/** Something on screen moving to a new place (layout shifts, cards re-flowing): ease-in-out, A to B. */
export const LAYOUT: Transition = { duration: 0.3, ease: EASE_IN_OUT }

/** The ticket drawer sliding in from the right on the iOS sheet curve… */
export const DRAWER: Transition = { duration: 0.4, ease: EASE_DRAWER }
/** …and back out the same way, faster — the user has already decided. */
export const DRAWER_EXIT: Transition = { duration: 0.26, ease: EASE_DRAWER }

/** Dimming scrim behind a modal or the drawer stack. */
export const SCRIM = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: { duration: 0.2, ease: EASE_OUT } },
  exit: { opacity: 0, transition: { duration: 0.16, ease: EASE_OUT } },
} as const

/** A centred modal panel (Settings, API keys, Completed, Raised, a PR report). */
export const DIALOG = {
  initial: { opacity: 0, scale: 0.97 },
  animate: { opacity: 1, scale: 1, transition: { duration: 0.24, ease: EASE_OUT } },
  exit: { opacity: 0, scale: 0.98, transition: { duration: 0.16, ease: EASE_OUT } },
} as const

/** A menu / popover. Give the element an `origin-*` class at its trigger. */
export const POPOVER = {
  initial: { opacity: 0, scale: 0.97 },
  animate: { opacity: 1, scale: 1, transition: { duration: 0.16, ease: EASE_OUT } },
  exit: { opacity: 0, scale: 0.98, transition: { duration: 0.1, ease: EASE_OUT } },
} as const

/** A notification arriving from below and leaving the way it came. */
export const TOAST = {
  initial: { opacity: 0, y: 16, scale: 0.97 },
  animate: { opacity: 1, y: 0, scale: 1, transition: { duration: 0.28, ease: EASE_OUT } },
  exit: { opacity: 0, y: 8, scale: 0.97, transition: { duration: 0.16, ease: EASE_OUT } },
} as const

/** Rows expanding / collapsing (accordion). `height` is tolerated only here. */
export const COLLAPSE: Transition = { duration: 0.22, ease: EASE_OUT }
