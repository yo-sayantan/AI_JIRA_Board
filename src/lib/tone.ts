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
/**
 * WCAG AA is 4.5:1 for small text and 7:1 "enhanced". Coloured text on the dark board goes well past both: a deep blue or
 * violet that merely passes still looks dim next to white body text, so it is lifted to a light, clearly-tinted tone
 * (9:1) — readable at 10–12px and still unmistakably its colour.
 */
const TARGET_CONTRAST = 9
/** More white than this and the hue is lost. */
const MAX_LIFT = 0.82

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

/** The palest surface a coloured label sits on in the light theme: a faint wash of its own colour over the page. */
const LIGHT_WASH = '#eceef3'
/** Light-theme text target: AA (4.5) with room for a wash under it (a tinted pill on a tinted row is darker than the page). */
const LIGHT_TARGET = 5.3
/** The light theme's ink (`--ink`), the colour a too-pale label is mixed toward. */
const LIGHT_INK = '#131722'
const darkCache = new Map<string, number>()

/** `rgb` mixed toward `to` by `t` — the maths `color-mix(in srgb, rgb, to t%)` does. */
function toward([r, g, b]: Rgb, [tr, tg, tb]: Rgb, t: number): Rgb {
  return [r + (tr - r) * t, g + (tg - g) * t, b + (tb - b) * t]
}

/**
 * How far toward the ink (0–1, in whole percents) a hex colour must go to read as TEXT on the light board; 0 when it
 * already does. Not a hex colour → 0.
 */
export function darkenAmount(hex: string): number {
  const hit = darkCache.get(hex)
  if (hit !== undefined) return hit
  const rgb = parseHex(hex)
  const bg = parseHex(LIGHT_WASH)
  const ink = parseHex(LIGHT_INK)
  let out = 0
  if (rgb && bg && ink) {
    const ratio = (c: Rgb) => {
      const [hi, lo] = [luminance(c), luminance(bg)].sort((x, y) => y - x)
      return (hi + 0.05) / (lo + 0.05)
    }
    if (ratio(rgb) < LIGHT_TARGET) {
      let lo = 0
      let hi = 100
      while (lo < hi) {
        const mid = (lo + hi) >> 1
        if (ratio(toward(rgb, ink, mid / 100)) >= LIGHT_TARGET) hi = mid
        else lo = mid + 1
      }
      out = lo / 100
    }
  }
  darkCache.set(hex, out)
  return out
}

/**
 * A colour for a coloured LABEL on the page or on a faint wash of itself (a status word, a banner title). Light theme: the
 * colour mixed toward the ink just enough to clear AA, so amber and green labels stay their hue but stop vanishing on
 * white. Dark theme: exactly `lift()`. Not a plain hex → `lift()` (which leaves it alone).
 */
export function readable(color: string): string {
  const t = darkenAmount(color)
  if (t <= 0) return lift(color)
  return `color-mix(in srgb, ${lift(color)}, var(--ink) calc((1 - var(--tone-lift, 0)) * ${Math.round(t * 100)}%))`
}

/** The text on a filled badge or button: white, or the board's near-black on a fill too bright for white. */
const FILL_INK = '#0b0c0f'
/** White on the deep end of a fill's gradient, and on its light end (both clear AA, 4.5, with room). */
const FILL_DEEP = 5.2
const FILL_LIGHT = 4.6
/** The most a fill may deepen toward black to carry white text; past this its colour would turn muddy (green → forest). */
const FILL_MAX_DEEPEN = 0.25
const fillCache = new Map<string, { from: string; to: string; text: string }>()

const toHex = (c: Rgb) => `#${c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`

/**
 * A SOLID fill for `color` and the text on it, readable in both themes (a filled pill, a count badge, a primary button).
 * A strong colour (blue, rose, violet, red) deepens a little so white text clears AA, as a two-stop gradient; a bright one
 * (green, orange, amber, teal, grey) keeps its bright fill — from the colour to a lighter tone — and takes near-black text.
 * Not a plain hex → the colour flat, white text.
 */
export function fillFor(color: string): { from: string; to: string; text: string } {
  const hit = fillCache.get(color)
  if (hit) return hit
  const rgb = parseHex(color)
  const white: Rgb = [255, 255, 255]
  const black = parseHex(FILL_INK)!
  let out = { from: color, to: color, text: '#fff' }
  if (rgb) {
    const onWhite = (c: Rgb) => (luminance(white) + 0.05) / (luminance(c) + 0.05)
    const need = (target: number) => {
      let lo = 0
      let hi = 100
      while (lo < hi) {
        const mid = (lo + hi) >> 1
        if (onWhite(toward(rgb, black, mid / 100)) >= target) hi = mid
        else lo = mid + 1
      }
      return lo / 100
    }
    const light = need(FILL_LIGHT)
    if (light <= FILL_MAX_DEEPEN) out = { from: toHex(toward(rgb, black, need(FILL_DEEP))), to: toHex(toward(rgb, black, light)), text: '#fff' }
    else out = { from: color, to: toHex(towardWhite(rgb, 0.28)), text: FILL_INK }
  }
  fillCache.set(color, out)
  return out
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

/** How far toward white the label of a SELECTED control goes in dark mode: near-white, with only a hint of its colour. */
const SELECTED_TEXT_LIFT = 0.86

/**
 * The look of a selected / pressed option (a segment of a segmented control, an active filter chip, the chosen row of a
 * list) in `color`. Light theme: exactly as before — coloured text on a faint wash, a coloured hairline. Dark theme: the
 * colour moves OFF the text and ONTO the edge — a near-white label, a clear coloured ring and a slightly stronger wash —
 * because coloured text on a coloured wash on black is the least readable thing on the board.
 * Not a plain hex → just its text colour (the caller's own value), nothing else.
 */
export function selectedStyle(color: string, o: { fill?: number; edge?: number } = {}): { color: string; background?: string; boxShadow?: string } {
  if (!parseHex(color)) return { color }
  const fill = o.fill ?? 0.14
  const edge = o.edge ?? 0.45
  const edgePct = Math.round(edge * 100)
  // Dark: the ring is the lifted colour, nearly opaque (edge + up to 45 points, never past 100%).
  const ringBoost = Math.min(45, 100 - edgePct)
  return {
    color: selectedText(color),
    background: tint(color, fill),
    boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${lift(color)} calc(${edgePct}% + ${ringBoost}% * var(--tone-lift, 0)), transparent)`,
  }
}

/** The label colour of a selected option: the colour itself in light mode, near-white tinted with it in dark mode. */
export function selectedText(color: string): string {
  if (!parseHex(color)) return color
  // Light theme: the colour mixed toward the ink as far as `readable` would (a bright one on its own wash is under AA).
  const t = darkenAmount(color)
  const base = t > 0 ? `color-mix(in srgb, ${color}, var(--ink) calc((1 - var(--tone-lift, 0)) * ${Math.round(t * 100)}%))` : color
  return `color-mix(in srgb, ${base}, white calc(var(--tone-lift, 0) * ${Math.round(SELECTED_TEXT_LIFT * 100)}%))`
}

