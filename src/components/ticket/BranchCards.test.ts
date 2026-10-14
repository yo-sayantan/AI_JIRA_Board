// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PrState } from '../../types'
import { BranchCards, branchCardMeta } from './BranchCards'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement | null = null
let root: ReturnType<typeof createRoot> | null = null
afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  host = root = null
  vi.unstubAllGlobals()
})

function render(branches: string[], states: Record<string, PrState> = {}) {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root!.render(createElement(BranchCards, { branches, stateOf: (b: string) => states[b] })))
  return host
}

describe('branch cards', () => {
  it('draws one copy button per branch, named for screen readers', () => {
    const el = render(['feature/ABC-1', 'feature/ABC-1_retry'])
    const buttons = [...el.querySelectorAll('button')]
    expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual(['Copy branch name feature/ABC-1', 'Copy branch name feature/ABC-1_retry'])
    expect(buttons[0].textContent).toContain('feature/ABC-1')
  })

  it('copies the branch name when the card is clicked, and says so', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    const el = render(['feature/ABC-1'])
    await act(async () => {
      el.querySelector('button')!.click()
    })
    expect(writeText).toHaveBeenCalledWith('feature/ABC-1')
    expect(el.querySelector('button')!.textContent).toContain('Copied')
  })

  it('takes the PR state colours, and a colour of its own for a branch with no PR', () => {
    expect(branchCardMeta('comments')).toEqual({ label: 'open PR', color: '#f59e0b' })
    expect(branchCardMeta('merged').label).toBe('merged')
    expect(branchCardMeta('none')).toEqual({ label: 'branch', color: '#6d7cff' })
    expect(branchCardMeta(undefined).label).toBe('branch')
    const el = render(['feature/ABC-1', 'feature/ABC-1_old'], { 'feature/ABC-1': 'comments' })
    expect(el.textContent).toContain('open PR')
    expect(el.textContent).toContain('branch')
  })
})
