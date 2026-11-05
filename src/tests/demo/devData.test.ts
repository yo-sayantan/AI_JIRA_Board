// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { DEV_DATASETS, devDump, setDevDataset } from '../../lib/devData'

afterEach(() => history.replaceState(null, '', '/'))

describe('permanent demo fixture catalogue', () => {
  it('keeps every pill option backed by a fixture', () => {
    const now = Date.parse('2026-11-05T12:00:00Z')

    for (const { id } of DEV_DATASETS) {
      expect(devDump(id, now), id).not.toBeNull()
    }
  })

  it('pins the fixture sizes used for empty, single-card and load testing', () => {
    const now = Date.parse('2026-11-05T12:00:00Z')

    expect(devDump('empty', now)?.tickets).toHaveLength(0)
    expect(devDump('one', now)?.tickets).toHaveLength(1)
    expect(devDump('huge', now)?.tickets).toHaveLength(400)
  })

  it('preserves the URL path, hash and unrelated parameters while selecting data', () => {
    history.replaceState(null, '', '/board?theme=dark#cards')

    setDevDataset('worst')

    expect(location.pathname).toBe('/board')
    expect(location.hash).toBe('#cards')
    expect(new URLSearchParams(location.search).get('theme')).toBe('dark')
    expect(new URLSearchParams(location.search).get('data')).toBe('worst')
  })
})
