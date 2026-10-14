import { describe, expect, it } from 'vitest'
import { BOARD_COLUMNS, MOVE_TARGETS, PIPELINE_COLUMNS, columnMode, isQaInProgress, mapStatusToColumn, qaStage } from './columns'
import sharedTargets from '../../jira-intern/move_targets.json'

describe('board columns', () => {
  it('runs To Do · Blocked · In Progress · In Review · QA · Done', () => {
    expect(BOARD_COLUMNS.map((c) => c.key)).toEqual(['todo', 'blocked', 'prog', 'rev', 'qa', 'done'])
  })
  it('keeps Blocked out of the lifecycle pipeline', () => {
    expect(PIPELINE_COLUMNS.map((c) => c.key)).toEqual(['todo', 'prog', 'rev', 'qa', 'done'])
  })
})

describe('mapStatusToColumn', () => {
  it('files Blocked and Impeded in the Blocked column, not On Hold', () => {
    expect(mapStatusToColumn('Blocked')).toBe('blocked')
    expect(mapStatusToColumn('Impeded')).toBe('blocked')
    expect(mapStatusToColumn('Blocked by vendor')).toBe('blocked')
  })
  it('still parks paused work on hold', () => {
    expect(mapStatusToColumn('On Hold')).toBe('hold')
    expect(mapStatusToColumn('Waiting')).toBe('hold')
  })
  it('does not mistake Awaiting Deployment for waiting', () => {
    expect(mapStatusToColumn('Awaiting Deployment')).not.toBe('hold')
  })
})

describe('QA team statuses', () => {
  it('files In validation with QA, on the working shelf (mirror of _jira.py::status_column)', () => {
    expect(mapStatusToColumn('In validation')).toBe('qa')
    expect(mapStatusToColumn('Validation')).toBe('qa')
    expect(mapStatusToColumn('Pending validation')).toBe('qa')
    expect(mapStatusToColumn('In Progress')).toBe('prog')
    expect(isQaInProgress('In validation')).toBe(true)
    expect(isQaInProgress('Pending validation')).toBe(false)
  })
})

describe('QA shelves', () => {
  it('ready-for-QA statuses sit on the top shelf', () => {
    for (const s of ['QA', 'Ready for QA', 'Ready4QA', 'Awaiting QA', 'Ready for Testing']) expect(isQaInProgress(s)).toBe(false)
  })
  it('statuses the QA team sets sit on QA In Progress', () => {
    for (const s of ['In QA', 'Under QA', 'QA In Progress', 'In Testing', 'Testing', 'Verification']) expect(isQaInProgress(s)).toBe(true)
  })
  it('qaStage is null outside the QA column', () => {
    expect(qaStage({ column: 'prog', status: 'In Testing' })).toBeNull()
    expect(qaStage({ column: 'qa', status: 'In Testing' })).toBe('inprogress')
    expect(qaStage({ column: 'qa', status: 'QA' })).toBe('ready')
  })
})

describe('column width modes', () => {
  it('folds an empty column to a rail and opens it only to a drop zone while dragging', () => {
    expect(columnMode({ count: 0 })).toBe('rail')
    expect(columnMode({ count: 0, dragging: true })).toBe('drop')
  })
  it('keeps a column with cards full, dragging or not', () => {
    expect(columnMode({ count: 3 })).toBe('full')
    expect(columnMode({ count: 1, dragging: true })).toBe('full')
  })
  it('never folds the one column a stat chip focused', () => {
    expect(columnMode({ count: 0, focused: true })).toBe('full')
  })
  it("counts Blocked's On Hold space as content", () => {
    expect(columnMode({ count: 0, held: 2 })).toBe('full')
    expect(columnMode({ count: 0, held: 0 })).toBe('rail')
    expect(columnMode({ count: 0, held: 0, dragging: true })).toBe('drop')
  })
})

describe('move targets', () => {
  it('are the shared list the server and transition.py read, On Hold included', () => {
    expect([...MOVE_TARGETS]).toEqual(sharedTargets)
    expect(MOVE_TARGETS.has('hold')).toBe(true)
  })
  it('cover every board column, On Hold, QA In Progress and Next Sprint, nothing else', () => {
    expect(new Set(MOVE_TARGETS)).toEqual(new Set([...BOARD_COLUMNS.map((c) => c.key), 'hold', 'qaip', 'next']))
  })
})

describe('column weights', () => {
  it('draws To Do, QA and Done thin; Blocked, In Progress and In Review take the spare width', () => {
    expect(BOARD_COLUMNS.filter((c) => c.slim).map((c) => c.key)).toEqual(['todo', 'qa', 'done'])
    expect(BOARD_COLUMNS.filter((c) => !c.slim).map((c) => c.key)).toEqual(['blocked', 'prog', 'rev'])
  })
})

describe('quiet columns', () => {
  it('To Do and QA recede (grey tones, whisper-light card tint); the working columns do not', () => {
    expect(BOARD_COLUMNS.filter((c) => c.quiet).map((c) => c.key)).toEqual(['todo', 'qa'])
  })
  it('To Do is a genuine grey: its channels are within a few points of each other', () => {
    const hex = BOARD_COLUMNS.find((c) => c.key === 'todo')!.accent
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
    expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeLessThanOrEqual(30)
  })
})
