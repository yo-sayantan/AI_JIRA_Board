import { hexToRgba } from './format'

/**
 * Brand colours that read on white go dim on a near-black board (a deep indigo, a blue, a green). `lift` and `tint` give a
 * colour the right weight for the CURRENT theme with no re-render and no per-component theme check:
 *
 *   --tone-lift: 0   (light, and every print slide)  → the colour exactly as written
 *   --tone-lift: 1   (dark)                          → the colour mixed toward white, by the least amount that makes it
 *                                                      readable on the dark surface
 *
 * The CSS variable (styles/dark.css) is read inside `color-mix()`, so inline styles and SVG attributes follow the theme
 * the moment `html.dark` flips. The mix amount is worked out here, per colour: a colour that is already bright gets no
 * lift at all, a deep one gets enough to reach `TARGET_CONTRAST`, capped at `MAX_LIFT` so it never turns into a pastel
 * of another hue.
 */

/** The lightest surface text sits on in dark mode (a hovered card with its column tint, a chip's own wash). */
const DARK_SURFACE = '#23262d'
/** WCAG AA is 4.5:1 for small text; 7:1 is the "enhanced" level — 10–12px badge labels deserve the stronger one. */
const TARGET_CONTRAST = 6.5
/** More white than this and the hue is lost. */
const MAX_LIFT = 0.72

type Rgb = [number, number, number]

function parseHex(hex: string): Rgb | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return null
  const h = m[1].length === 3 ? m[1].split('').map((c) => c + c).join('') : m[1]
  const n = parseInt(h, 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/** WCAG relative luminance of an sRGB colour. */
function luminance([r, g, b]: Rgb): number {
  const lin = (v: number) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

/** WCAG contrast ratio of two hex colours (1–21). Not a hex → 1. */
export function contrastRatio(a: string, b: string): number {
  const ca = parseHex(a)
  const cb = parseHex(b)
  if (!ca || !cb) return 1
  const [hi, lo] = [luminance(ca), luminance(cb)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

/** `rgb` mixed toward white by `t` — the same maths `color-mix(in srgb, rgb, white t%)` does. */
function towardWhite([r, g, b]: Rgb, t: number): Rgb {
  const mix = (v: number) => v + (255 - v) * t
  return [mix(r), mix(g), mix(b)]
}

const cache = new Map<string, number>()

/**
 * How far toward white (0–1, in whole percents) a hex colour must go to be readable on the dark surface; 0 when it
 * already is. Not a hex colour (`var(--x)`, `rgba(…)`, a keyword) → 0: it is left to whoever owns that value.
 */
export function liftAmount(hex: string): number {
  const hit = cache.get(hex)
  if (hit !== undefined) return hit
  const rgb = parseHex(hex)
  const bg = parseHex(DARK_SURFACE)
  let out = 0
  if (rgb && bg) {
    const need = (TARGET_CONTRAST * (luminance(bg) + 0.05)) - 0.05
    if (luminance(rgb) < need) {
      // Binary search over whole percents: the smallest mix whose luminance clears `need`.
      let lo = 0
      let hi = 100
      while (lo < hi) {
        const mid = (lo + hi) >> 1
        if (luminance(towardWhite(rgb, mid / 100)) >= need) hi = mid
        else lo = mid + 1
      }
      out = Math.min(lo / 100, MAX_LIFT)
    }
  }
  cache.set(hex, out)
  return out
}

/**
 * A colour to paint TEXT, an icon or a line with. Light theme: unchanged. Dark theme: lifted until it reads on the
 * dark surface. Anything that is not a plain hex (a `var()`, an rgba, a gradient) is returned untouched.
 */
export function lift(color: string): string {
  const t = liftAmount(color)
  if (t <= 0) return color
  return `color-mix(in srgb, ${color}, white calc(var(--tone-lift, 0) * ${Math.round(t * 100)}%))`
}

/** In dark mode a see-through wash needs a little more body than on white, or a selected chip is barely there. */
const DARK_WASH_BOOST = 0.4
/** Past this alpha the colour is already a strong edge / fill; boosting it would only clip. */
const BOOST_UP_TO = 0.5

/**
 * `hexToRgba` for the board's own chrome: a see-through wash or border of `color`. In dark mode the colour underneath is
 * the lifted one, and a faint wash (alpha up to 0.5) gets `DARK_WASH_BOOST` more body, so a tinted chip, a selected row
 * and a glow keep their identity instead of sinking into the black. Light theme: exactly `hexToRgba`'s colour.
 * Not a plain hex colour → falls back to `hexToRgba` (which is what every caller used before).
 */
export function tint(color: string, alpha: number): string {
  if (!parseHex(color)) return hexToRgba(color, alpha)
  const pct = Math.round(alpha * 1000) / 10
  const amount = alpha <= BOOST_UP_TO ? `calc(${pct}% * (1 + ${DARK_WASH_BOOST} * var(--tone-lift, 0)))` : `${pct}%`
  return `color-mix(in srgb, ${lift(color)} ${amount}, transparent)`
}

/** White text on a solid fill needs this much contrast against the fill's base colour, or dark mode switches to dark ink. */
const FILL_WHITE_MIN = 3.5
/** The ink for a light fill on a dark board: the board's own near-black, so it reads as part of the theme. */
const DARK_INK = '#0b0c0f'

/**
 * The text (and glyph) colour for a SOLID, saturated fill of `color` — a filled pill, a primary button. White, as always,
 * wherever white has enough contrast with the fill. A pale fill (the quiet grey of To Do, a green, an orange) cannot carry
 * white text: on the light board that is a long-standing look, but on the dark board the fill is the brightest thing
 * around and white on it vanishes, so there — and only there, through `--tone-lift` — the text turns near-black.
 */
export function onFill(color: string): string {
  if (!parseHex(color) || contrastRatio('#ffffff', color) >= FILL_WHITE_MIN) return '#fff'
  return `color-mix(in srgb, #ffffff, ${DARK_INK} calc(var(--tone-lift, 0) * 100%))`
}

