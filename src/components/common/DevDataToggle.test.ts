// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { DevDataToggle } from './DevDataToggle'

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
  act(() => root!.render(createElement(DevDataToggle)))
  return host
}

describe('DevDataToggle', () => {
  it('uses one native radio group and keeps the selected fixture in the URL', () => {
    const view = mount()
    const radios = [...view.querySelectorAll<HTMLInputElement>('input[type="radio"][name="demo-data-set"]')]
    expect(radios).toHaveLength(6)
    expect(radios[0].checked).toBe(true)

    act(() => radios[2].click())

    expect(new URLSearchParams(location.search).get('data')).toBe('worst')
    expect(radios[2].checked).toBe(true)
  })
})
