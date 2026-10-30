// @ts-expect-error Vitest runs in Node; the browser app intentionally omits Node type declarations.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const indexCss = readFileSync(new URL('./index.css', import.meta.url), 'utf8')
const glassCss = readFileSync(new URL('./glass.css', import.meta.url), 'utf8')

describe('board shell background', () => {
  it('keeps the page neutral after the glass stylesheet loads', () => {
    expect(indexCss).toMatch(/body\s*\{[^}]*background:\s*var\(--bg\)/s)
    expect(glassCss).not.toMatch(/(?:^|\})\s*(?:\.dark\s+)?body\s*\{[^}]*radial-gradient/s)
  })
})
