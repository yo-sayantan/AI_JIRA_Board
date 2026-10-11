// @vitest-environment jsdom
import { act, createElement, type ReactElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import type { JenkinsBuild } from '../../types'
import { BuildRow, ConsoleTail } from './Builds'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement | null = null
let root: ReturnType<typeof createRoot> | null = null
afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  host = root = null
})

const TAIL = [
  '> Task :reports:test',
  'SavedReportPagingTest > lastPageIsPartial() FAILED',
  '    java.lang.AssertionError: expected:<20> but was:<0>',
  'curl: (22) The requested URL returned error: 401 -H "Authorization: •••"',
  'BUILD FAILED in 4m 12s',
].join('\n')

const failed: JenkinsBuild = {
  env: 'qa',
  repo: 'demo-service',
  branch: 'feature/DEMO-231_paginate_saved_reports',
  number: 88,
  result: 'FAILURE',
  url: 'https://jenkins.example.com/job/demo/job/demo-service-qa/88/',
  at: '2026-10-08T07:00:00Z',
  durationMs: 252000,
  failedStage: 'Integration tests',
  consoleTail: TAIL,
}

const render = (node: ReactElement) => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root!.render(node))
  return host
}
const row = (build: JenkinsBuild, now = 0) => render(createElement(BuildRow, { build, now }))

describe('BuildRow · console tail of a failed build', () => {
  it('is a collapsed "Console (last lines)" box that says it was scrubbed of secrets', () => {
    const el = row(failed, Date.parse('2026-10-08T09:00:00Z'))
    const box = el.querySelector<HTMLDetailsElement>('details[data-console-tail]')!
    expect(box).not.toBeNull()
    expect(box.open).toBe(false)
    expect(box.querySelector('summary')!.textContent).toContain('Console (last lines)')
    expect(box.querySelector('summary')!.textContent).toContain('5 lines')
    expect(box.querySelector('summary')!.textContent).toContain('scrubbed of secrets')
  })

  it('shows the lines in a scrollable, keyboard-reachable, labelled monospace region with a capped height', () => {
    const pre = row(failed).querySelector('details pre')!
    expect(pre.textContent).toBe(TAIL)
    expect(pre.getAttribute('role')).toBe('region')
    expect(pre.getAttribute('tabindex')).toBe('0')
    expect(pre.getAttribute('aria-label')).toContain('build #88')
    expect(pre.getAttribute('aria-label')).toContain('scrubbed')
    expect(pre.className).toContain('font-mono')
    expect(pre.className).toContain('max-h-52')
    expect(pre.className).toContain('overflow-auto')
    // the scrubbed marker survives as text, never interpreted as markup
    expect(pre.textContent).toContain('Authorization: •••')
  })

  it('renders log text as text, not as HTML', () => {
    const el = row({ ...failed, consoleTail: '<img src=x onerror=alert(1)>\n<b>bold</b>' })
    expect(el.querySelector('details pre img')).toBeNull()
    expect(el.querySelector('details pre b')).toBeNull()
    expect(el.querySelector('details pre')!.textContent).toBe('<img src=x onerror=alert(1)>\n<b>bold</b>')
  })

  it('draws nothing for a build without one (green, running, or an older dump)', () => {
    for (const consoleTail of [undefined, null, '', '  \n ']) {
      const el = row({ ...failed, result: 'SUCCESS', consoleTail })
      expect(el.querySelector('details')).toBeNull()
      act(() => root?.unmount())
      host?.remove()
    }
  })

  it('ConsoleTail on its own is empty without lines', () => {
    expect(render(createElement(ConsoleTail, { build: { ...failed, consoleTail: undefined } })).innerHTML).toBe('')
  })
})
