import { useSyncExternalStore } from 'react'
import type { JiraData } from '../types'
import { fixture } from '../fixtures'
import { emptyDump, hugeDump, oneDump, worstCaseDump } from '../fixtures.worstCase'

/**
 * `npm run dev` with demo mode on: swap the demo board for a fixture, chosen with `?data=` so a reload keeps it.
 * Unset = demo mode's own sample board; with demo mode off the selection is ignored (useBoardData). Production builds
 * never read the URL (import.meta.env.DEV is false there, and the fixtures are dropped with it).
 */
export const DEV_DATASETS = [
  { id: 'demo', label: 'Dev sample' },
  { id: 'worst', label: 'Worst case' },
  { id: 'empty', label: 'Empty' },
  { id: 'one', label: 'One' },
  { id: 'huge', label: '400 cards' },
] as const
export type DevDataset = (typeof DEV_DATASETS)[number]['id']

const CHANGE = 'jb-dev-data'

function read(): DevDataset | null {
  if (!import.meta.env.DEV) return null
  const v = new URLSearchParams(location.search).get('data')
  return DEV_DATASETS.find((d) => d.id === v)?.id ?? null
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener(CHANGE, onChange)
  window.addEventListener('popstate', onChange)
  return () => {
    window.removeEventListener(CHANGE, onChange)
    window.removeEventListener('popstate', onChange)
  }
}

export function useDevDataset(): DevDataset | null {
  return useSyncExternalStore(subscribe, read, () => null)
}

export function setDevDataset(id: DevDataset | null): void {
  const url = new URL(location.href)
  if (id) url.searchParams.set('data', id)
  else url.searchParams.delete('data')
  history.replaceState(history.state, '', url)
  window.dispatchEvent(new Event(CHANGE))
}

export function devDump(id: DevDataset, now: number): JiraData | null {
  // Constant-false in a production build, so the fixtures below are dropped from the bundle.
  if (!import.meta.env.DEV) return null
  switch (id) {
    case 'demo':
      return fixture
    case 'worst':
      return worstCaseDump(now)
    case 'empty':
      return emptyDump(now)
    case 'one':
      return oneDump(now)
    case 'huge':
      return hugeDump(now)
  }
}
