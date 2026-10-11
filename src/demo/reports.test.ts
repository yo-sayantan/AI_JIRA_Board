import { describe, expect, it } from 'vitest'
import raw from '../../jira-intern/demo/data.json'
import { demoReports } from './reports'
import type { ReportCalloutBlock } from '../lib/reportTypes'
import type { JiraData } from '../types'

describe('demo reports · Issue insight', () => {
  const { reports } = demoReports()
  const verdictBlocks = (key: string) => reports[key].tabs.find((t) => t.id === 'verdict')!.blocks

  it('the report of the ticket with Dynatrace evidence carries an "Issue insight" callout right after the decision callout', () => {
    const blocks = verdictBlocks('DEMO-210')
    const at = blocks.findIndex((b) => b.kind === 'callout' && b.title === 'Issue insight')
    expect(at).toBe(1)
    expect(blocks[0].kind).toBe('callout')
    expect(blocks[0].title).not.toBe('Issue insight')
    const insight = blocks[at] as ReportCalloutBlock
    expect(insight.provenance).toBe('derived')
    expect(['info', 'warning']).toContain(insight.tone)
    expect(insight.body).toMatch(/^<p>[\s\S]*<\/p>$/)
  })

  it('says what the demo ticket’s own Dynatrace read says', () => {
    const ticket = (raw as unknown as JiraData).tickets.find((t) => t.key === 'DEMO-210')!
    const trace = ticket.dynatrace!.items.find((i) => i.kind === 'trace')!
    const problem = ticket.dynatrace!.items.find((i) => i.kind === 'problem')!
    const body = (verdictBlocks('DEMO-210').find((b) => b.kind === 'callout' && b.title === 'Issue insight') as ReportCalloutBlock).body
    expect(body).toContain(`${trace.summary!.failedSpans} failed spans out of ${trace.summary!.spans}`)
    expect(body).toContain(trace.summary!.firstFailure!.service!)
    expect(body).toContain(problem.summary!.problems![0].displayId!)
    expect(body).toContain('CLOSED')
  })

  it('leaves the report of a ticket without Dynatrace evidence as it was', () => {
    expect(verdictBlocks('DEMO-230').some((b) => b.title === 'Issue insight')).toBe(false)
  })

  it('points at no real host', () => {
    expect(JSON.stringify(reports)).not.toMatch(/https?:\/\/(?![\w.-]*example\.com)/)
  })
})
