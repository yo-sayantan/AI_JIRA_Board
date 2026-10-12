import type { AiLevel } from './settings'
import type { CloudModelChoice } from './runner'

/**
 * Costly = the worker's verdict (output price at or above cloud-models.json's `costlyOutputUsd`, or the entry's own
 * `costly`). A payload without the flag falls back to the default $10 line.
 */
export const DEFAULT_COSTLY_USD = 10

export function isPricey(m: { costly?: boolean; price?: { output: number | null } | null } | null | undefined): boolean {
  if (typeof m?.costly === 'boolean') return m.costly
  const out = m?.price?.output
  return out != null && out >= DEFAULT_COSTLY_USD
}

/**
 * What each AI level may spend: the highest output price (USD per 1M tokens) of a cloud model it can use.
 * Low ≤ $1 · Medium ≤ $5 · High < $10 (and never a costly model) · Max — every model. Mirrored in the worker
 * (`ai-intern/worker.py::level_allows`), which refuses a model its level does not cover.
 */
export const LEVEL_PRICE_CAP: Record<AiLevel, { max: number; inclusive: boolean } | null> = {
  low: { max: 1, inclusive: true },
  moderate: { max: 5, inclusive: true },
  high: { max: 10, inclusive: false },
  full: null,
}

/** "up to $1" · "up to $5" · "under $10" · "every model" — the same rule in words, for hints. */
export function levelPriceText(level: AiLevel): string {
  const cap = LEVEL_PRICE_CAP[level]
  return !cap ? 'every model' : `${cap.inclusive ? 'up to' : 'under'} ${usd(cap.max)} per 1M output`
}

/** May this level use the model? A model with no listed price fits only Max — spend that is not known is not allowed. */
export function levelAllows(level: AiLevel, m: { costly?: boolean; price?: { output: number | null } | null } | null | undefined): boolean {
  const cap = LEVEL_PRICE_CAP[level]
  if (!cap) return true
  if (!m || isPricey(m)) return false
  const out = m.price?.output
  return out != null && (cap.inclusive ? out <= cap.max : out < cap.max)
}

export type EffortId = 'low' | 'medium' | 'high' | 'auto'
const ALL_EFFORTS: readonly EffortId[] = ['low', 'medium', 'high', 'auto']

/**
 * The efforts the Settings dropdown offers for a model: exactly the ones cloud-models.json lists for it (the worker
 * already empties the list for a costly model, unless the file says `costlyShowEffort`). None listed = no dropdown.
 */
export function effortChoicesFor(m: { efforts?: string[] } | null | undefined): EffortId[] {
  return ALL_EFFORTS.filter((e) => m?.efforts?.includes(e))
}

/** "$0.20", "$1.20", "$0.125", "$10": whole dollars bare, otherwise two decimals or three where needed. */
export function usd(n: number | null | undefined): string {
  if (n == null) return '—'
  if (Number.isInteger(n)) return `$${n}`
  return `$${n.toFixed(3).replace(/0$/, '')}`
}

/** Dropdown groups: one per provider, in the order the server sent them (it sorts by provider, then price). */
export function groupByProvider(models: CloudModelChoice[]): [string, CloudModelChoice[]][] {
  const groups = new Map<string, CloudModelChoice[]>()
  for (const m of models) {
    const g = m.provider ?? ''
    groups.set(g, [...(groups.get(g) ?? []), m])
  }
  return [...groups]
}
