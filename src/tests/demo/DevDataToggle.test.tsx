// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { DevDataToggle } from '../../components/common/DevDataToggle'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement | null = null
let root: ReturnType<typeof createRoot> | null = null

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  host = root = null
  history.replaceState(null, '', '/')
})

function mount() {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root!.render(<DevDataToggle />))
  return host
}

function radios(view: HTMLElement): HTMLInputElement[] {
  return [...view.querySelectorAll<HTMLInputElement>('input[type="radio"][name="demo-data-set"]')]
}

describe('demo dataset pill', () => {
  it('is one labelled native radio group with every permanent fixture option', () => {
    const view = mount()
    const group = view.querySelector('[role="radiogroup"]')
    const inputs = radios(view)

    expect(group?.getAttribute('aria-label')).toBe('Demo data set')
    expect(inputs).toHaveLength(6)
    expect(inputs.map((input) => input.labels?.[0]?.textContent?.trim())).toEqual([
      'Demo board',
      'Dev sample',
      'Worst case',
      'Empty',
      'One',
      '400 cards',
    ])
    expect(inputs[0].checked).toBe(true)
  })

  it('restores the selected fixture from the URL on first render', () => {
    history.replaceState(null, '', '/?data=huge')
    const inputs = radios(mount())

    expect(inputs[5].checked).toBe(true)
    expect(inputs.filter((input) => input.checked)).toHaveLength(1)
  })

  it('selects a fixture without dropping unrelated query parameters', () => {
    history.replaceState(null, '', '/?view=board')
    const inputs = radios(mount())

    act(() => inputs[2].click())

    const query = new URLSearchParams(location.search)
    expect(query.get('view')).toBe('board')
    expect(query.get('data')).toBe('worst')
    expect(inputs[2].checked).toBe(true)
  })

  it('returns to the demo board by removing only the data parameter', () => {
    history.replaceState(null, '', '/?view=board&data=empty')
    const inputs = radios(mount())

    act(() => inputs[0].click())

    const query = new URLSearchParams(location.search)
    expect(query.get('view')).toBe('board')
    expect(query.has('data')).toBe(false)
    expect(inputs[0].checked).toBe(true)
  })

  it('falls back to Demo board for an unknown fixture id', () => {
    history.replaceState(null, '', '/?data=not-a-fixture')
    const inputs = radios(mount())

    expect(inputs[0].checked).toBe(true)
    expect(inputs.filter((input) => input.checked)).toHaveLength(1)
  })
})
