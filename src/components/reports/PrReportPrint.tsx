import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import type {
  PrReport,
  ReportBlock,
  ReportCard,
  ReportCardsBlock,
  ReportKvBlock,
  ReportLink,
  ReportListBlock,
  ReportStat,
  ReportTab,
  ReportTableBlock,
  ReportTableRow,
  ReportTimelineBlock,
  ReportTone,
} from '../../lib/reportTypes'
import { toneColor } from '../../lib/reportTypes'
import { fmtDate, fmtDateTime, fmtReportMetadata } from '../../lib/format'
import { APP_CONFIG } from '../../lib/appConfig'
import { hrefForKey, shareableLinks } from '../../lib/reportLinks'
import { ReportHtml } from './ReportHtml'
import { safeHref } from '../common/ui'
import { columnWidths, paginate, type MeasuredBlock, type MeasuredSection, type Page } from './printPlan'
import { fitToHeight } from './printFit'

/**
 * The report as a widescreen slide deck — a separate render from the on-screen overlay.
 *
 * Each page is one 16:9 slide (13.33 × 7.5 in), so the exported PDF can be cast or dropped into a
 * presentation. Slides are ordered for the audience: the first two answer "is it done, and what
 * happens next"; the middle carries the evidence; the appendix keeps sources. Every block in the
 * report lands on some slide — anything not placed on purpose goes to "Additional detail".
 *
 * Layout happens in three passes, all before the print dialog can open:
 *   1. MEASURE — every block is rendered once, offscreen, at true slide width; the height of each
 *      block, its repeating head and each of its rows / card rows / list entries is read.
 *   2. PAGINATE — printPlan.paginate turns those heights into slides (split between rows only,
 *      heads repeated, nearly empty tail slides rebalanced, short sections merged).
 *   3. FIT — printFit scales each slide's content to fill its slide without overflowing.
 * No running footer: the key, title and date are on the cover, and page numbers add nothing to a
 * deck that is cast or skimmed.
 */

type Audience = 'Leadership' | 'PM / Scrum Master' | 'Architect / Tech lead' | 'Everyone'

const RAG: Record<ReportTone, string> = {
  success: 'Green',
  warning: 'Amber',
  danger: 'Red',
  info: 'Blue',
  violet: 'Blue',
  neutral: 'Grey',
}

/** Each section owns a hue, carried by its slide band, eyebrow, rule and table header. */
const SECTION_COLOR: Record<string, string> = {
  'Executive summary': '#4f46e5',
  'Delivery gates': '#0d9488',
  'Open items': '#ea580c',
  'Code review': '#7c3aed',
  Evidence: '#2563eb',
  'Quality and security': '#16a34a',
  'Technical assessment': '#0891b2',
  Risk: '#dc2626',
  'Additional detail': '#64748b',
  Appendix: '#475569',
}
const sectionColor = (s: string) => SECTION_COLOR[s] ?? '#475569'

/** One block of a section. Items are table rows, rows of cards, or list entries; atoms never split. */
interface BlockDef {
  id: string
  atom: boolean
  /** Number of items (rows). 0 for an atom. */
  count: number
  /** Cards per grid row: the DOM has one element per card, pagination works in rows. */
  perRow?: number
  /** Items [from, to); an atom ignores both. */
  render: (from: number, to: number) => ReactNode
  /** A composite laid out as these blocks when it is taller than a slide. */
  fallback?: BlockDef[]
}

interface SectionDef {
  id: string
  section: string
  title: string
  contTitle: string
  audience: Audience[]
  blocks: BlockDef[]
  mergeable: boolean
}

interface Deck {
  summary: { decision: ReportBlock | null; facts: Fact[]; gateTally: GateTally | null; riskCount: number | null; fileCount: number | null }
  sections: SectionDef[]
}

export function PrReportPrintDoc({ report, tabs }: { report: PrReport; tabs: ReportTab[] }) {
  const deck = useMemo(() => planDeck(report, tabs), [report, tabs])
  const rootRef = useRef<HTMLDivElement>(null)
  const [generation, setGeneration] = useState(0)
  // The pages belong to the deck (and font generation) they were measured for; anything else means
  // "measure again", so a new report can never be drawn with the previous report's pagination.
  const [layout, setLayout] = useState<{ deck: Deck; generation: number; pages: Page[] } | null>(null)
  const pages = layout && layout.deck === deck && layout.generation === generation ? layout.pages : null

  // Pass 1 + 2: measure the offscreen render, paginate. A layout effect, so it completes before
  // paint — the deck is ready long before anyone reaches the print button.
  useLayoutEffect(() => {
    if (pages || !rootRef.current) return
    setLayout({ deck, generation, pages: measureAndPaginate(rootRef.current, deck.sections) })
  }, [pages, deck, generation])

  // Pass 3: fit every slide; again right before printing (fonts or the window may have changed).
  useLayoutEffect(() => {
    if (pages && rootRef.current) fitAll(rootRef.current)
  }, [pages])
  useEffect(() => {
    const before = () => rootRef.current && fitAll(rootRef.current)
    window.addEventListener('beforeprint', before)
    // Web fonts arriving late change every text height: measure again once they are in.
    let live = true
    document.fonts?.ready.then(() => live && setGeneration((g) => g + 1)).catch(() => {})
    return () => {
      live = false
      window.removeEventListener('beforeprint', before)
    }
  }, [])

  const byId = useMemo(() => new Map(deck.sections.map((s) => [s.id, s])), [deck])

  return (
    <div className="jb-pdf" ref={rootRef} aria-hidden>
      {!pages ? (
        <MeasureLayer sections={deck.sections} />
      ) : (
        <>
          <section className="jb-slide jb-slide-cover" style={secVars('Executive summary')}>
            <CoverSlide report={report} sections={deck.sections} />
          </section>
          <Slide section="Executive summary" title="Where this ticket stands" audience={['Leadership', 'PM / Scrum Master']}>
            <SummarySlide report={report} {...deck.summary} />
          </Slide>
          {pages.map((page, i) => {
            const first = byId.get(page.sections[0].sectionId)!
            const sectionNames = [...new Set(page.sections.map((ps) => byId.get(ps.sectionId)!.section))]
            const audience = [...new Set(page.sections.flatMap((ps) => byId.get(ps.sectionId)!.audience))]
            return (
              <Slide
                key={i}
                section={first.section}
                eyebrow={sectionNames.join(' · ')}
                title={page.sections[0].continued ? first.contTitle : first.title}
                audience={audience}
              >
                <div className="jb-flow">
                  {page.sections.map((ps, k) => {
                    const sec = byId.get(ps.sectionId)!
                    const blocks = flatBlocks(sec.blocks)
                    return (
                      <Fragment key={ps.sectionId}>
                        {k > 0 && (
                          <div className="jb-subhead" style={secVars(sec.section)}>
                            <span>{sec.section}</span>
                            {sec.title}
                          </div>
                        )}
                        {ps.pieces.map((p) => {
                          const b = blocks.get(p.blockId)
                          return b ? <Fragment key={`${p.blockId}:${p.from}`}>{b.render(p.from, p.to)}</Fragment> : null
                        })}
                      </Fragment>
                    )
                  })}
                </div>
              </Slide>
            )
          })}
        </>
      )}
    </div>
  )
}

function Slide({ section, eyebrow, title, audience, children }: { section: string; eyebrow?: string; title: string; audience: Audience[]; children: ReactNode }) {
  return (
    <section className="jb-slide" style={secVars(section)}>
      <span className="jb-slide-band" />
      <header className="jb-slide-head">
        <div className="jb-slide-head-text">
          <div className="jb-slide-eyebrow">{eyebrow ?? section}</div>
          <h2 className="jb-slide-title">{title}</h2>
        </div>
        <div className="jb-slide-aud">
          {audience.map((a) => (
            <span key={a} className="jb-chip jb-chip-quiet">
              {a}
            </span>
          ))}
        </div>
      </header>
      <div className="jb-slide-body">
        <div className="jb-slide-content">{children}</div>
      </div>
    </section>
  )
}

const secVars = (section: string) => ({ '--sec': sectionColor(section) }) as CSSProperties

// ── Pass 1: measure ─────────────────────────────────────────────────────────

/** Every block (and every fallback part) rendered whole inside a slide-sized probe. */
function MeasureLayer({ sections }: { sections: SectionDef[] }) {
  const all = sections.flatMap((s) => [...flatBlocks(s.blocks).values()])
  return (
    <section className="jb-slide" data-probe>
      <span className="jb-slide-band" />
      <header className="jb-slide-head">
        <div className="jb-slide-head-text">
          <div className="jb-slide-eyebrow">Probe</div>
          <h2 className="jb-slide-title">Probe</h2>
        </div>
      </header>
      <div className="jb-slide-body" data-probe-body>
        <div className="jb-flow" data-probe-flow>
          <div className="jb-subhead" data-probe-subhead>
            <span>Probe</span>
            Probe
          </div>
          {all.map((b) => (
            <div key={b.id} data-mblock={b.id}>
              {b.render(0, b.count)}
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

function measureAndPaginate(root: HTMLElement, sections: SectionDef[]): Page[] {
  const body = root.querySelector<HTMLElement>('[data-probe-body]')
  const flow = root.querySelector<HTMLElement>('[data-probe-flow]')
  const sub = root.querySelector<HTMLElement>('[data-probe-subhead]')
  const budget = body?.clientHeight ?? 0
  // No layout (a test DOM, or the deck mounted under a hidden ancestor): every height is zero.
  // One slide per section is the honest fallback — the fit pass still shrinks each to fit.
  if (!budget) {
    return sections.map((s) => ({
      height: 0,
      sections: [{ sectionId: s.id, continued: false, height: 0, pieces: s.blocks.map((b) => ({ blockId: b.id, from: 0, to: b.count, continued: false })) }],
    }))
  }
  const gap = flow ? parseFloat(getComputedStyle(flow).rowGap) || 0 : 0
  const subhead = sub?.getBoundingClientRect().height ?? 0

  const measureBlock = (b: BlockDef): MeasuredBlock => {
    const el = root.querySelector<HTMLElement>(`[data-mblock="${b.id}"]`)
    const box = el?.getBoundingClientRect()
    const whole = box?.height ?? 0
    const fallback = b.fallback?.map(measureBlock)
    if (!el || !box || b.atom || !b.count) return { id: b.id, head: 0, items: [], whole, atom: true, fallback }
    const nodes = [...el.querySelectorAll<HTMLElement>('[data-item]')]
    const per = b.perRow ?? 1
    const tops: number[] = []
    for (let r = 0; r * per < nodes.length; r++) {
      tops.push(Math.min(...nodes.slice(r * per, r * per + per).map((n) => n.getBoundingClientRect().top)))
    }
    if (!tops.length) return { id: b.id, head: 0, items: [], whole, atom: true, fallback }
    const items = tops.map((t, r) => (r + 1 < tops.length ? tops[r + 1] : box.bottom) - t)
    return { id: b.id, head: Math.max(0, tops[0] - box.top), items, whole, atom: false, fallback }
  }

  const measured: MeasuredSection[] = sections.map((s) => ({ id: s.id, mergeable: s.mergeable, blocks: s.blocks.map(measureBlock) }))
  return paginate(measured, { budget, gap, subhead })
}

// ── Pass 3: fit ─────────────────────────────────────────────────────────────

function fitAll(root: HTMLElement) {
  for (const slide of root.querySelectorAll<HTMLElement>('.jb-slide')) {
    const body = slide.querySelector<HTMLElement>('.jb-slide-body')
    const content = slide.querySelector<HTMLElement>('.jb-slide-content')
    if (body && content) fitToHeight(content, body.clientHeight)
    const cover = slide.querySelector<HTMLElement>('.jb-cover-left')
    const coverMain = slide.querySelector<HTMLElement>('.jb-cover-main')
    // A long title or lead must not push the cover's agenda off the slide; never enlarged.
    if (cover && coverMain) fitToHeight(cover, coverMain.clientHeight, { grow: false })
  }
}

// ── Planning: what goes in which section ───────────────────────────────────

function planDeck(report: PrReport, tabs: ReportTab[]): Deck {
  const used = new Set<ReportBlock>()
  const take = <T extends ReportBlock>(match: (b: ReportBlock, tab: ReportTab) => boolean): T | null => {
    for (const tab of tabs) {
      for (const b of tab.blocks ?? []) {
        if (!used.has(b) && match(b, tab)) {
          used.add(b)
          return b as T
        }
      }
    }
    return null
  }
  const titled = (re: RegExp, kind?: ReportBlock['kind']) => (b: ReportBlock) => (!kind || b.kind === kind) && re.test(b.title ?? '')

  const decision = take(titled(/^decision$/i, 'callout'))
  const issueInsight = take(titled(/^issue insight$/i, 'callout'))
  take((b) => b.kind === 'stats' && sameStats(b.items, report.stats))
  const gates = take<ReportTableBlock>(titled(/gate checklist/i, 'table'))
  const releaseGate = take(titled(/^release gate$/i, 'callout'))
  const evidence = take<ReportTableBlock>(titled(/evidence/i, 'table'))
  const prCards = take<ReportCardsBlock>(titled(/pull request/i, 'cards'))
  const timeline = take<ReportTimelineBlock>((b) => b.kind === 'timeline')
  const proofs: ReportTableBlock[] = []
  for (let p = take<ReportTableBlock>(titled(/^proof/i, 'table')); p; p = take<ReportTableBlock>(titled(/^proof/i, 'table'))) proofs.push(p)
  const blocking = take<ReportTableBlock>(titled(/still blocks|blocks closure|open scope/i, 'table'))
  const nextActions = take<ReportListBlock>(titled(/next action/i, 'list'))
  const consistency = take(titled(/consistency/i, 'callout'))
  const changeShape = take(titled(/change shape/i, 'stats'))
  const perFile = take<ReportCardsBlock>(titled(/per-file|files?/i, 'cards'))
  const reviewFocus = take<ReportListBlock>(titled(/review focus/i, 'list'))
  const prodProof = take(titled(/production proof/i, 'callout'))
  const deployment = take<ReportKvBlock>(titled(/deploy/i, 'kv'))
  const risks = take<ReportTableBlock>(titled(/risk/i, 'table'))
  const links = take((b) => b.kind === 'links')
  const runMeta = take<ReportKvBlock>(titled(/run metadata|metadata/i, 'kv'))

  const gateTally = tallyGates(gates)
  const riskCount = risks?.rows.filter((r) => !/none inferred/i.test(plain(r.cells[0] ?? ''))).length ?? 0
  const r = report
  const sections: SectionDef[] = []
  const section = (s: Omit<SectionDef, 'mergeable' | 'contTitle'> & { contTitle?: string; mergeable?: boolean }) => {
    const blocks = s.blocks.filter(Boolean)
    if (blocks.length) sections.push({ mergeable: true, contTitle: `${s.title} (continued)`, ...s, blocks })
  }

  // Delivery gates
  section({
    id: 'gates',
    section: 'Delivery gates',
    title: gates ? 'Is it ready to close?' : 'Release gate',
    contTitle: 'Delivery gates (continued)',
    audience: ['PM / Scrum Master', 'Leadership'],
    blocks: [
      // What the issue was, in plain words — for the reader who will not open Dynatrace, Checkmarx or Jenkins.
      issueInsight?.kind === 'callout' ? atom('gates-insight', <Callout title="Issue insight" tone={issueInsight.tone} html={issueInsight.body} report={r} />) : null,
      gateTally ? atom('gates-bar', <GateBar tally={gateTally} />) : null,
      gates ? tableDef('gates-table', gates, r, { status: true }) : null,
      releaseGate?.kind === 'callout' ? atom('gates-release', <Callout title="Release gate" tone={releaseGate.tone} html={releaseGate.body} report={r} />) : null,
    ].filter(isDef),
  })

  // Open items
  if (blocking || nextActions || consistency) {
    const side = [
      nextActions ? listDef('open-actions', nextActions, r) : null,
      consistency?.kind === 'callout'
        ? atom('open-consistency', <Callout title={consistency.title ?? 'Status consistency'} tone={consistency.tone} html={consistency.body} report={r} />)
        : null,
    ].filter(isDef)
    section({
      id: 'open',
      section: 'Open items',
      title: blocking && blocking.rows.length ? 'What still needs to happen' : 'Nothing is blocking closure',
      audience: ['PM / Scrum Master', 'Leadership'],
      blocks: [
        blocking && blocking.rows.length
          ? tableDef('open-blocking', blocking, r, { status: true })
          : atom('open-none', <Callout title="Open scope" tone="success" html="<p>No open item blocks closure.</p>" report={r} />),
        side.length === 2 ? splitDef('open-side', [side[0]], [side[1]]) : side[0] ?? null,
      ].filter(isDef),
    })
  }

  // Code review
  if (prCards || timeline) {
    const cards = prCards?.items.length ? cardsDef('review-prs', prCards.items, r, { perRow: 2, title: 'Pull requests' }) : null
    const tl = timeline ? timelineDef('review-timeline', timeline, r) : null
    section({
      id: 'review',
      section: 'Code review',
      title: cards && tl ? 'Pull requests and delivery timeline' : cards ? 'Pull requests' : 'Delivery timeline',
      contTitle: 'Code review (continued)',
      audience: ['Architect / Tech lead', 'PM / Scrum Master'],
      blocks: [cards && tl ? splitDef('review-split', [cards], [tl], '1.35fr 1fr') : cards ?? tl].filter(isDef),
    })
  }

  // Evidence
  if (evidence) {
    section({
      id: 'evidence',
      section: 'Evidence',
      title: 'What the systems show',
      contTitle: 'Evidence (continued)',
      audience: ['Architect / Tech lead', 'PM / Scrum Master'],
      blocks: [tableDef('evidence-table', evidence, r, { status: false })],
    })
  }

  // Quality and security
  if (proofs.length) {
    section({
      id: 'proof',
      section: 'Quality and security',
      title: 'Build, scan and runtime proof',
      audience: ['Architect / Tech lead'],
      blocks: proofs.map((p, i) => tableDef(`proof-${i}`, p, r, { status: true, title: p.title?.replace(/^proof\s*·?\s*/i, '') || 'Proof' })),
    })
  }

  // Technical assessment — change overview
  if (changeShape || reviewFocus || deployment || prodProof) {
    const right = [
      deployment ? atom('tech-deploy', <KvCard block={deployment} report={r} />) : null,
      prodProof?.kind === 'callout' ? atom('tech-prod', <Callout title="Production proof" tone={prodProof.tone} html={prodProof.body} report={r} />) : null,
    ].filter(isDef)
    const left = reviewFocus ? [listDef('tech-focus', reviewFocus, r, 'Review focus')] : []
    section({
      id: 'tech',
      section: 'Technical assessment',
      title: 'Change overview and release readiness',
      audience: ['Architect / Tech lead'],
      blocks: [
        changeShape?.kind === 'stats' ? atom('tech-shape', <Kpis stats={changeShape.items} />) : null,
        left.length && right.length ? splitDef('tech-split', left, right) : null,
        ...(left.length && right.length ? [] : [...left, ...right]),
      ].filter(isDef),
    })
  }

  // Risk
  if (risks) {
    section({
      id: 'risk',
      section: 'Risk',
      title: riskCount ? `${riskCount} risk${riskCount === 1 ? '' : 's'} and how to handle ${riskCount === 1 ? 'it' : 'them'}` : 'No risks found',
      contTitle: 'Risks (continued)',
      audience: ['Architect / Tech lead', 'Leadership'],
      blocks: [tableDef('risk-table', risks, r, { status: false })],
    })
  }

  // Technical assessment — file by file
  if (perFile && perFile.items.length) {
    section({
      id: 'files',
      section: 'Technical assessment',
      title: `What changed, file by file (${perFile.items.length})`,
      contTitle: 'What changed (continued)',
      audience: ['Architect / Tech lead'],
      blocks: [cardsDef('files-cards', perFile.items, r, { perRow: 3, compact: true })],
    })
  }

  // Additional detail — everything the plan above did not place on purpose.
  const leftovers = tabs.flatMap((t) => (t.blocks ?? []).filter((b) => !used.has(b)).map((b) => ({ tab: t, block: b })))
  if (leftovers.length) {
    section({
      id: 'extra',
      section: 'Additional detail',
      title: leftovers.length === 1 ? leftovers[0].block.title || leftovers[0].tab.title : 'Additional detail',
      contTitle: 'Additional detail (continued)',
      audience: ['Everyone'],
      blocks: leftovers.map((l, i) => genericDef(`extra-${i}`, l.block, r, l.block.title || l.tab.title)),
    })
  }

  // Appendix
  const allLinks = [...(links && links.kind === 'links' ? links.items : []), ...shareableLinks(report)]
  const seen = new Set<string>()
  const uniqLinks = allLinks.filter((l) => safeHref(l.href) && (seen.has(l.href) ? false : (seen.add(l.href), true)))
  const linkList = uniqLinks.length ? linksDef('appendix-links', uniqLinks) : null
  const made = atom('appendix-made', <MadeWith report={r} runMeta={runMeta} />)
  section({
    id: 'appendix',
    section: 'Appendix',
    title: 'Sources and how this report was made',
    audience: ['Everyone'],
    blocks: [linkList ? splitDef('appendix-split', [linkList], [made], '1.35fr 1fr') : made],
  })

  return {
    summary: { decision, facts: deliveryFacts(report, evidence, prCards), gateTally, riskCount: risks ? riskCount : null, fileCount: perFile?.items.length ?? null },
    sections,
  }
}

const isDef = (b: BlockDef | null | undefined): b is BlockDef => !!b

/** Every block of a section, composites' fallback parts included, by id. */
function flatBlocks(blocks: BlockDef[]): Map<string, BlockDef> {
  const out = new Map<string, BlockDef>()
  const walk = (bs: BlockDef[]) =>
    bs.forEach((b) => {
      out.set(b.id, b)
      if (b.fallback) walk(b.fallback)
    })
  walk(blocks)
  return out
}

// ── Block definitions ───────────────────────────────────────────────────────

function atom(id: string, node: ReactNode): BlockDef {
  return { id, atom: true, count: 0, render: () => node }
}

/** Two columns side by side; taller than a slide, it becomes its parts one after another. */
function splitDef(id: string, left: BlockDef[], right: BlockDef[], cols = '1fr 1fr'): BlockDef {
  return {
    id,
    atom: true,
    count: 0,
    render: () => (
      <div className="jb-split" style={{ gridTemplateColumns: cols }}>
        <div className="jb-col">{left.map((b) => <Fragment key={b.id}>{b.render(0, b.count)}</Fragment>)}</div>
        <div className="jb-col">{right.map((b) => <Fragment key={b.id}>{b.render(0, b.count)}</Fragment>)}</div>
      </div>
    ),
    fallback: [...left, ...right],
  }
}

function tableDef(id: string, block: ReportTableBlock, report: PrReport, opts: { status: boolean; title?: string }): BlockDef {
  const widths = columnWidths(
    block.headers,
    block.rows.map((row) => row.cells.map(plain)),
  )
  return {
    id,
    atom: false,
    count: block.rows.length,
    render: (from, to) => <TableBlock block={block} report={report} status={opts.status} title={opts.title} widths={widths} from={from} to={to} />,
  }
}

function cardsDef(id: string, items: ReportCard[], report: PrReport, opts: { perRow: number; title?: string; compact?: boolean }): BlockDef {
  return {
    id,
    atom: false,
    count: Math.ceil(items.length / opts.perRow),
    perRow: opts.perRow,
    render: (from, to) => (
      <section>
        {opts.title && <h3 className="jb-h3">{opts.title}</h3>}
        <div className="jb-cards" style={{ gridTemplateColumns: `repeat(${opts.perRow}, minmax(0, 1fr))` }}>
          {items.slice(from * opts.perRow, to * opts.perRow).map((c, j) => (
            <Card key={j} card={c} report={report} compact={opts.compact} />
          ))}
        </div>
      </section>
    ),
  }
}

function listDef(id: string, block: ReportListBlock, report: PrReport, title?: string): BlockDef {
  return {
    id,
    atom: false,
    count: block.items.length,
    render: (from, to) => (
      <section>
        <h3 className="jb-h3">{title ?? block.title ?? 'Next actions'}</h3>
        <ol className="jb-actions">
          {block.items.slice(from, to).map((it, i) => (
            <li key={i} data-item>
              <span className="jb-action-n" style={{ background: toneColor(it.tone) }}>
                {from + i + 1}
              </span>
              <span>
                <ReportHtml html={it.text} report={report} inline />
              </span>
            </li>
          ))}
        </ol>
      </section>
    ),
  }
}

/** Long histories keep the newest entries; the rest stay in the app. */
const TIMELINE_MAX = 16

function timelineDef(id: string, block: ReportTimelineBlock, report: PrReport): BlockDef {
  const zone = report.timeZone ?? APP_CONFIG.timeZone
  const items = block.items.slice(0, TIMELINE_MAX)
  const more = block.items.length - items.length
  return {
    id,
    atom: false,
    count: items.length,
    render: (from, to) => (
      <section>
        <h3 className="jb-h3">{block.title ?? 'Timeline'}</h3>
        <ol className="jb-timeline">
          {items.slice(from, to).map((e, i) => (
            <li key={i} data-item>
              <span className="jb-tl-dot" style={{ background: toneColor(e.tone) }} />
              <span className="jb-tl-when">{fmtWhen(e.when, zone)}</span>
              <span className="jb-tl-what">
                <b>
                  <ReportHtml html={e.label} report={report} inline />
                </b>
                {e.detail ? (
                  <>
                    {' '}
                    — <ReportHtml html={e.detail} report={report} inline />
                  </>
                ) : null}
              </span>
            </li>
          ))}
        </ol>
        {more > 0 && to === items.length && <p className="jb-muted jb-small">+{more} earlier events in the app</p>}
      </section>
    ),
  }
}

function linksDef(id: string, links: ReportLink[]): BlockDef {
  return {
    id,
    atom: false,
    count: links.length,
    render: (from, to) => (
      <section>
        <h3 className="jb-h3">Links</h3>
        <ul className="jb-links">
          {links.slice(from, to).map((l) => (
            <li key={l.href} data-item>
              <a href={l.href}>
                <b>{l.label}</b>
                <span>{l.href}</span>
              </a>
            </li>
          ))}
        </ul>
      </section>
    ),
  }
}

function genericDef(id: string, block: ReportBlock, report: PrReport, heading: string): BlockDef {
  switch (block.kind) {
    case 'table':
      return tableDef(id, block, report, { status: true, title: heading })
    case 'cards':
      return cardsDef(id, block.items, report, { perRow: 3, title: heading, compact: true })
    case 'list':
      return listDef(id, block, report, heading)
    case 'timeline':
      return timelineDef(id, block, report)
    case 'links':
      return linksDef(id, block.items.filter((l) => safeHref(l.href)))
    case 'callout':
      return atom(id, <Callout title={block.title ?? heading} tone={block.tone} html={block.body} report={report} />)
    case 'stats':
      return atom(
        id,
        <section>
          <h3 className="jb-h3">{heading}</h3>
          <Kpis stats={block.items} />
        </section>,
      )
    case 'kv':
      return atom(id, <KvCard block={block} report={report} />)
    default:
      return atom(id, null)
  }
}

// ── Fixed slides ────────────────────────────────────────────────────────────

function CoverSlide({ report, sections }: { report: PrReport; sections: SectionDef[] }) {
  const v = report.verdict
  const tone = v?.tone ?? 'neutral'
  const c = toneColor(tone)
  const zone = report.timeZone ?? APP_CONFIG.timeZone
  const ticketHref = safeHref(hrefForKey(report, report.key))
  const agenda = ['Executive summary', ...new Set(sections.map((s) => s.section))]
  const long = (report.title ?? '').length > 90
  return (
    <div className="jb-cover" style={{ '--tone': c } as CSSProperties}>
      <div className="jb-cover-band" />
      <div className="jb-cover-glow" />
      <div className="jb-cover-top">
        <span>PR readiness report</span>
        <span>{fmtDate(report.generatedAt, zone)}</span>
      </div>
      <div className="jb-cover-main">
        <div className="jb-cover-left">
          {ticketHref ? (
            <a href={ticketHref} className="jb-cover-key">
              {report.key}
            </a>
          ) : (
            <div className="jb-cover-key">{report.key}</div>
          )}
          <h1 className={`jb-cover-title${long ? ' jb-cover-title-long' : ''}`}>{report.title}</h1>
          <div className="jb-cover-verdict">
            <span className="jb-rag" style={{ background: c }}>
              {RAG[tone]}
            </span>
            <span className="jb-cover-label">{v?.label ?? 'No verdict'}</span>
          </div>
          {(v?.summary || v?.reason) && (
            <p className="jb-cover-lead">
              <ReportHtml html={v?.summary || v?.reason || ''} report={report} inline />
            </p>
          )}
        </div>
        {typeof v?.score === 'number' && (
          <div className="jb-cover-score">
            <ScoreRing score={v.score} color={c} size={170} dark />
            <span>Readiness score</span>
          </div>
        )}
      </div>
      <div className="jb-cover-foot">
        <div>
          <div className="jb-cover-foot-label">In this deck</div>
          <ol className="jb-cover-agenda">
            {agenda.map((s, i) => (
              <li key={s}>
                <span className="jb-cover-agenda-n" style={{ background: sectionColor(s) }}>
                  {i + 1}
                </span>
                {s}
              </li>
            ))}
          </ol>
        </div>
        <div className="jb-cover-meta">
          <div className="jb-cover-foot-label">Prepared</div>
          <div>{fmtDateTime(report.enrichedAt || report.generatedAt, zone)}</div>
          <div>{report.enriched ? 'Measured from Jira and Bitbucket, reviewed by AI' : 'Measured from Jira and Bitbucket'}</div>
        </div>
      </div>
    </div>
  )
}

type Fact = { label: string; value: string; href?: string | null }

function SummarySlide({
  report,
  decision,
  facts,
  gateTally,
  riskCount,
  fileCount,
}: {
  report: PrReport
  decision: ReportBlock | null
  facts: Fact[]
  gateTally: GateTally | null
  riskCount: number | null
  fileCount: number | null
}) {
  const v = report.verdict
  const tone = v?.tone ?? 'neutral'
  const c = toneColor(tone)
  const next = v?.next
  const impact = decision && decision.kind === 'callout' ? italicLine(decision.body) : null
  const kpis: ReportStat[] = [
    ...(typeof v?.score === 'number' ? [{ label: 'Readiness', value: `${v.score} / 100`, tone }] : []),
    ...(gateTally ? [{ label: 'Gates passed', value: `${gateTally.pass} of ${gateTally.total}`, tone: gateTally.fail ? 'danger' : gateTally.warn ? 'warning' : 'success' } as ReportStat] : []),
    ...report.stats.filter((s) => !/^last pr activity$/i.test(s.label)),
    ...(riskCount != null ? [{ label: 'Risks', value: String(riskCount), tone: riskCount ? 'warning' : 'success' } as ReportStat] : []),
    ...(fileCount != null ? [{ label: 'Files reviewed', value: String(fileCount), tone: 'neutral' } as ReportStat] : []),
  ].slice(0, 8)

  return (
    <div className="jb-summary">
      <div className="jb-summary-status" style={{ borderColor: c, background: `${c}0d` }}>
        <div className="jb-summary-row">
          <span className="jb-rag" style={{ background: c }}>
            {RAG[tone]}
          </span>
          <span className="jb-summary-label" style={{ color: c }}>
            {v?.label ?? 'No verdict'}
          </span>
        </div>
        {v?.summary && (
          <p className="jb-summary-lead">
            <ReportHtml html={v.summary} report={report} inline />
          </p>
        )}
        {v?.reason && (
          <p className="jb-summary-why">
            <span className="jb-tag">Why</span>
            <ReportHtml html={v.reason} report={report} inline />
          </p>
        )}
        {impact && (
          <p className="jb-summary-why">
            <span className="jb-tag">Business impact</span>
            <ReportHtml html={impact} report={report} inline />
          </p>
        )}
      </div>

      <div className="jb-summary-side">
        <div className="jb-next" style={{ borderColor: next ? c : toneColor('success'), background: `${next ? c : toneColor('success')}0f` }}>
          <div className="jb-next-label">Next step</div>
          {next?.action ? (
            <>
              <div className="jb-next-action">
                <ReportHtml html={sentenceCase(next.action)} report={report} inline />
              </div>
              <div className="jb-next-meta">
                {next.owner && (
                  <span>
                    <b>Owner</b> {next.owner}
                  </span>
                )}
                {next.due && (
                  <span>
                    <b>Due</b> {next.due}
                  </span>
                )}
              </div>
            </>
          ) : (
            <div className="jb-next-action">Nothing outstanding. No action needed.</div>
          )}
        </div>
        {facts.length > 0 && (
          <dl className="jb-facts">
            {facts.map((f) => (
              <div key={f.label}>
                <dt>{f.label}</dt>
                <dd>{safeHref(f.href) ? <a href={safeHref(f.href)}>{f.value}</a> : <ReportHtml html={f.value} report={report} inline />}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>

      <div className="jb-summary-kpis">
        <Kpis stats={kpis} />
      </div>
    </div>
  )
}

function MadeWith({ report, runMeta }: { report: PrReport; runMeta: ReportKvBlock | null }) {
  const zone = report.timeZone ?? APP_CONFIG.timeZone
  return (
    <div className="jb-col">
      <div>
        <h3 className="jb-h3">How this report was made</h3>
        <p className="jb-prose">
          {report.enriched
            ? 'Status, reviews and gates are measured directly from Jira and Bitbucket. An AI pass then read the ticket, the pull requests and linked specs to add business impact, per-file notes and risks. AI findings are marked as such in the app.'
            : 'Status, reviews and gates are measured directly from Jira and Bitbucket. No AI interpretation was applied.'}
        </p>
        {report.sources && <p className="jb-prose jb-muted">Sources: {report.sources}</p>}
      </div>
      {report.warnings && report.warnings.length > 0 && (
        <Callout title="Not covered" tone="warning" html={`<p>${report.warnings.map(esc).join(' · ')}</p>`} report={report} />
      )}
      <dl className="jb-facts">
        <div>
          <dt>Generated</dt>
          <dd>{fmtDateTime(report.generatedAt, zone)}</dd>
        </div>
        {report.enriched && report.enrichedAt && (
          <div>
            <dt>AI reviewed</dt>
            <dd>{fmtDateTime(report.enrichedAt, zone)}</dd>
          </div>
        )}
        {report.generator && (
          <div>
            <dt>Generator</dt>
            <dd>{report.generator}</dd>
          </div>
        )}
        {runMeta?.items
          .filter((kv) => !/^generated$/i.test(kv.label))
          .map((kv) => (
            <div key={kv.label}>
              <dt>{kv.label}</dt>
              <dd>
                <ReportHtml html={fmtReportMetadata(kv.label, kv.value, zone)} report={report} inline />
              </dd>
            </div>
          ))}
      </dl>
    </div>
  )
}

// ── Pieces ──────────────────────────────────────────────────────────────────

/** Tiles per row: never more than four (a cast slide needs big numbers), rows as even as possible. */
export function kpiColumns(n: number): number {
  if (n <= 4) return Math.max(1, n)
  return Math.ceil(n / Math.ceil(n / 4))
}

function Kpis({ stats }: { stats: ReportStat[] }) {
  return (
    <div className="jb-kpis" style={{ gridTemplateColumns: `repeat(${kpiColumns(stats.length)}, minmax(0, 1fr))` }}>
      {stats.map((s, i) => {
        const toned = s.tone && s.tone !== 'neutral'
        const c = toneColor(s.tone)
        return (
          <div key={i} className="jb-kpi" style={{ borderTopColor: toned ? c : '#cbd2de', background: toned ? `${c}10` : undefined }}>
            <div className="jb-kpi-label">{s.label}</div>
            <div className={`jb-kpi-value${String(s.value ?? '').length <= 14 ? ' jb-nowrap' : ''}`} style={toned ? { color: c } : undefined}>
              <Segments text={sentenceCase(String(s.value ?? ''))} />
            </div>
            {s.hint && <div className="jb-kpi-hint">{s.hint}</div>}
          </div>
        )
      })}
    </div>
  )
}

interface GateTally {
  pass: number
  fail: number
  warn: number
  total: number
}

function GateBar({ tally }: { tally: GateTally }) {
  const pct = (n: number) => `${tally.total ? (100 * n) / tally.total : 0}%`
  return (
    <div className="jb-gatebar">
      <div className="jb-gatebar-track">
        <span style={{ width: pct(tally.pass), background: toneColor('success') }} />
        <span style={{ width: pct(tally.warn), background: toneColor('warning') }} />
        <span style={{ width: pct(tally.fail), background: toneColor('danger') }} />
      </div>
      <div className="jb-gatebar-legend">
        <span>
          <i style={{ background: toneColor('success') }} /> {tally.pass} passed
        </span>
        <span>
          <i style={{ background: toneColor('warning') }} /> {tally.warn} not verified
        </span>
        <span>
          <i style={{ background: toneColor('danger') }} /> {tally.fail} failing
        </span>
      </div>
    </div>
  )
}

/**
 * Rows [from, to) of a table, with its heading and header on every slide it spans. Fixed column
 * widths keep a split table's columns aligned slide to slide. With `status`, the state-like column
 * is a coloured chip, so pass/fail reads from across a room.
 */
function TableBlock({
  block,
  report,
  status,
  title,
  widths,
  from,
  to,
}: {
  block: ReportTableBlock
  report: PrReport
  status: boolean
  title?: string
  widths: number[]
  from: number
  to: number
}) {
  const stateCol = status ? block.headers.findIndex((h) => /^(state|status|result)$/i.test(h.trim())) : -1
  const blockCol = status ? block.headers.findIndex((h) => /blocks closure/i.test(h)) : -1
  return (
    <section>
      {title && <h3 className="jb-h3">{title}</h3>}
      <table className="jb-table">
        <colgroup>
          {widths.map((w, i) => (
            <col key={i} style={{ width: `${w}%` }} />
          ))}
        </colgroup>
        <thead>
          <tr>
            {block.headers.map((h, i) => (
              <th key={i}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {block.rows.slice(from, to).map((row, i) => {
            const t = status ? rowTone(row, stateCol) : row.tone && row.tone !== 'neutral' ? row.tone : null
            return (
              <tr key={i} data-item style={t ? { boxShadow: `inset 4px 0 0 ${toneColor(t)}` } : undefined}>
                {row.cells.map((cell, j) => (
                  <td key={j} className={j === 0 ? 'jb-td-lead' : undefined}>
                    {j === stateCol && t ? (
                      <span className="jb-chip" style={{ color: toneColor(t), borderColor: toneColor(t), background: `${toneColor(t)}14` }}>
                        {plain(cell)}
                      </span>
                    ) : j === blockCol ? (
                      <span className={/^yes/i.test(plain(cell)) ? 'jb-strong' : 'jb-muted'}>{plain(cell)}</span>
                    ) : (
                      <ReportHtml html={cell} report={report} inline />
                    )}
                  </td>
                ))}
              </tr>
            )
          })}
        </tbody>
      </table>
    </section>
  )
}

function Callout({ title, tone, html, report }: { title: string; tone?: ReportTone; html: string; report: PrReport }) {
  const c = toneColor(tone)
  return (
    <section className="jb-callout" style={{ borderLeftColor: c, background: `${c}10` }}>
      <div className="jb-callout-title" style={{ color: c }}>
        {title}
      </div>
      <ReportHtml html={html} report={report} className="jb-prose" />
    </section>
  )
}

function KvCard({ block, report }: { block: ReportKvBlock; report: PrReport }) {
  const zone = report.timeZone ?? APP_CONFIG.timeZone
  return (
    <section>
      <h3 className="jb-h3">{block.title ?? 'Details'}</h3>
      <dl className="jb-facts">
        {block.items.map((kv, i) => (
          <div key={i}>
            <dt>{kv.label}</dt>
            <dd style={kv.tone && kv.tone !== 'neutral' ? { color: toneColor(kv.tone) } : undefined}>
              {safeHref(kv.href) ? <a href={safeHref(kv.href)}>{kv.value}</a> : <ReportHtml html={fmtReportMetadata(kv.label, kv.value, zone)} report={report} inline />}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  )
}

function Card({ card, report, compact }: { card: ReportCard; report: PrReport; compact?: boolean }) {
  const c = toneColor(card.badgeTone)
  const inner = (
    <>
      <div className="jb-card-head">
        <span className="jb-card-title">
          <ReportHtml html={card.title} report={report} inline />
        </span>
        {card.badge && (
          <span className="jb-chip" style={{ color: c, borderColor: c, background: `${c}14` }}>
            {card.badge}
          </span>
        )}
      </div>
      <ReportHtml html={card.body} report={report} className={`jb-prose${compact ? ' jb-prose-sm' : ''}`} />
      {card.detail && (
        <p className="jb-card-detail">
          <ReportHtml html={card.detail} report={report} inline />
        </p>
      )}
    </>
  )
  const cardHref = safeHref(card.href)
  const style = { borderTopColor: c, background: `linear-gradient(180deg, ${c}0d, #fff 46px)` }
  return cardHref ? (
    <a href={cardHref} className="jb-card" style={style} data-item>
      {inner}
    </a>
  ) : (
    <div className="jb-card" style={style} data-item>
      {inner}
    </div>
  )
}

function ScoreRing({ score, color, size, dark }: { score: number; color: string; size: number; dark?: boolean }) {
  const pct = Math.max(0, Math.min(100, score))
  const stroke = size * 0.09
  const r = (size - stroke) / 2
  const circ = 2 * Math.PI * r
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="jb-ring">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={dark ? 'rgba(255,255,255,0.14)' : '#e6e9ef'} strokeWidth={stroke} />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={color}
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={`${(pct / 100) * circ} ${circ}`}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
      <text x="50%" y="50%" textAnchor="middle" dominantBaseline="central" fontSize={size * 0.3} fontWeight={800} fill={dark ? '#fff' : '#10151f'}>
        {pct}
      </text>
    </svg>
  )
}

/** Keep each fact of "1 merged · 0 open · 1 declined" whole so a wrap only lands between facts. */
function Segments({ text }: { text: string }) {
  const parts = text.split(' · ')
  if (parts.length < 2) return <>{text}</>
  return (
    <>
      {parts.map((p, i) => (
        <span key={i}>
          <span className="jb-nowrap">{i < parts.length - 1 ? `${p} ·` : p}</span>
          {i < parts.length - 1 ? ' ' : ''}
        </span>
      ))}
    </>
  )
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function deliveryFacts(report: PrReport, evidence: ReportTableBlock | null, prCards: ReportCardsBlock | null): Fact[] {
  const facts: Fact[] = []
  const epic = report.links?.find((l) => /^epic\b/i.test(l.label))
  if (epic) facts.push({ label: 'Epic', value: epic.label.replace(/^epic\s*/i, ''), href: epic.href })
  const fix = evidence?.rows.find((r) => /fixversion/i.test(plain(r.cells[0] ?? '')))
  if (fix) facts.push({ label: 'Fix version', value: plain(fix.cells[1] ?? '') })
  if (report.verdict?.next?.due) facts.push({ label: 'Sprint', value: report.verdict.next.due })
  const repos = [...new Set((prCards?.items ?? []).map((c) => plain(c.title).split(' · ')[1]).filter(Boolean))]
  if (repos.length) facts.push({ label: repos.length === 1 ? 'Repository' : 'Repositories', value: repos.join(', ') })
  const prs = prCards?.items.length
  if (prs) facts.push({ label: 'Pull requests', value: `${prs} (${prCards!.items.map((c) => c.badge).filter(Boolean).join(', ')})` })
  const subs = report.links?.filter((l) => /^sub-?task\b/i.test(l.label)).length
  if (subs) facts.push({ label: 'Sub-tasks', value: String(subs) })
  return facts
}

function tallyGates(gates: ReportTableBlock | null): GateTally | null {
  if (!gates || !gates.rows.length) return null
  const col = gates.headers.findIndex((h) => /^(state|status|result)$/i.test(h.trim()))
  const tally = { pass: 0, fail: 0, warn: 0, total: gates.rows.length }
  for (const r of gates.rows) {
    const t = rowTone(r, col)
    if (t === 'success') tally.pass++
    else if (t === 'danger') tally.fail++
    else tally.warn++
  }
  return tally
}

function rowTone(r: ReportTableRow, stateCol: number): ReportTone {
  const s = stateCol >= 0 ? plain(r.cells[stateCol] ?? '').toLowerCase() : ''
  if (s) {
    if (/^(pass|passed|done|merged|approved|ok|green|scan read|success)/.test(s)) return 'success'
    if (/(not verified|unknown|pending|n\/a|skipped|not run)/.test(s)) return 'warning'
    if (/(fail|block|still open|declined|changes|missing|open)/.test(s)) return 'danger'
  }
  return r.tone && r.tone !== 'neutral' ? r.tone : 'neutral'
}

function sameStats(a: ReportStat[], b: ReportStat[]) {
  const d = (x: ReportStat[]) => x.map((s) => `${s.label}=${s.value}`).join('|')
  return !!d(b) && d(a) === d(b)
}

/** The AI business-impact line is appended to the Decision callout as a trailing italic paragraph. */
function italicLine(html: string): string | null {
  const m = html.match(/<p><i>([\s\S]*?)<\/i><\/p>\s*$/)
  if (!m) return null
  const text = m[1].trim()
  return /^(task|bug|story|sub-task|epic|dev task|security)\s·/i.test(plain(text)) ? null : text
}

/** Only a real ISO timestamp is reformatted — "Oct 7" would parse as a date in 2001. */
function fmtWhen(when: string | null | undefined, zone: string | null | undefined): string {
  if (!when) return '—'
  return /^\d{4}-\d{2}-\d{2}T/.test(when) ? fmtDateTime(when, zone) : when
}

function plain(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .trim()
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function sentenceCase(s: string): string {
  return /^[a-z]/.test(s) ? s[0].toUpperCase() + s.slice(1) : s
}
