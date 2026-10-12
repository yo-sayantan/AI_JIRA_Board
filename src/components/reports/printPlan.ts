// Pagination for the PDF slide deck. Pure, so it is unit-tested; every height comes from the DOM
// (PrReportPrint measures the real blocks at slide width before it lays the deck out).
//
// The rules, in order:
//   1. A block is either an ATOM (a callout, a KPI strip, a two-column composite) that never splits,
//      or a run of ITEMS (table rows, card rows, list entries) that may split between items only.
//      A split block repeats its head (heading + table header) on every slide it spans.
//   2. A block's head is never left alone at the foot of a slide: it moves on with its first item.
//   3. A composite taller than one slide is replaced by its fallback blocks, which can split.
//   4. When a block spills onto a last slide that would be nearly empty, rows are moved back so the
//      two slides carry similar amounts — never one stray row on a slide of its own.
//   5. Sections that fit on one slide each and fit together are merged onto one slide, so a short
//      report is not a run of near-empty slides.
//   6. An atom taller than a slide still gets one slide; the fit pass shrinks it (see printFit).

export interface MeasuredBlock {
  id: string
  /** Height of what repeats on every slide the block spans: its heading and table header. */
  head: number
  /** Atomic item heights — table rows, rows of cards, list entries. Empty for an atom. */
  items: number[]
  /** Height of the whole block as one piece. */
  whole: number
  atom: boolean
  /** A composite (two columns) that does not fit one slide is laid out as these blocks instead. */
  fallback?: MeasuredBlock[]
}

export interface MeasuredSection {
  id: string
  blocks: MeasuredBlock[]
  /** May share a slide with a neighbouring short section. */
  mergeable: boolean
}

/** Items [from, to) of a block; for an atom both are 0. */
export interface Piece {
  blockId: string
  from: number
  to: number
  /** The block started on an earlier slide. */
  continued: boolean
}

export interface PageSection {
  sectionId: string
  pieces: Piece[]
  /** The section started on an earlier slide. */
  continued: boolean
  height: number
}

export interface Page {
  sections: PageSection[]
  height: number
}

export interface Geometry {
  /** Usable content height of one slide body. */
  budget: number
  /** Vertical gap between blocks. */
  gap: number
  /** Height of the sub-heading a merged section gets. */
  subhead: number
}

/** A slide may be filled to this share of its height when two sections are merged onto it. */
export const MERGE_FILL = 0.9
/** A last slide lighter than this share of the budget is rebalanced with the one before it. */
export const LIGHT_PAGE = 0.35

export function paginate(sections: MeasuredSection[], g: Geometry): Page[] {
  const pages: Page[] = []
  let mergeOpen = false // the last page holds only single-slide, mergeable sections
  for (const sec of sections) {
    const parts = paginateSection(sec, g)
    for (const part of parts) {
      const last = pages[pages.length - 1]
      const single = parts.length === 1 && sec.mergeable
      if (single && last && mergeOpen && last.height + g.gap + g.subhead + part.height <= g.budget * MERGE_FILL) {
        last.sections.push(part)
        last.height += g.gap + g.subhead + part.height
        continue
      }
      pages.push({ sections: [part], height: part.height })
      mergeOpen = single
    }
  }
  return pages
}

export function paginateSection(sec: MeasuredSection, g: Geometry): PageSection[] {
  const blocks = expand(sec.blocks, g.budget)
  const byId = new Map(blocks.map((b) => [b.id, b]))
  const pages: PageSection[] = []
  let cur: PageSection = { sectionId: sec.id, pieces: [], continued: false, height: 0 }
  const room = () => g.budget - cur.height - (cur.pieces.length ? g.gap : 0)
  const push = (piece: Piece, h: number) => {
    cur.height += (cur.pieces.length ? g.gap : 0) + h
    cur.pieces.push(piece)
  }
  const nextPage = () => {
    pages.push(cur)
    cur = { sectionId: sec.id, pieces: [], continued: true, height: 0 }
  }

  for (const b of blocks) {
    if (b.atom || b.items.length === 0) {
      if (cur.pieces.length && b.whole > room()) nextPage()
      push({ blockId: b.id, from: 0, to: 0, continued: false }, b.whole)
      continue
    }
    let i = 0
    while (i < b.items.length) {
      // Rule 2: the head travels with at least one item.
      if (cur.pieces.length && b.head + b.items[i] > room()) nextPage()
      const r = room()
      let h = b.head
      let j = i
      while (j < b.items.length && (j === i || h + b.items[j] <= r)) h += b.items[j++]
      push({ blockId: b.id, from: i, to: j, continued: i > 0 }, h)
      i = j
      if (i < b.items.length) nextPage()
    }
  }
  pages.push(cur)
  return rebalance(pages, byId, g)
}

/** Rule 3: composites that cannot fit one slide give way to their splittable parts. */
function expand(blocks: MeasuredBlock[], budget: number): MeasuredBlock[] {
  return blocks.flatMap((b) => (b.fallback && b.whole > budget ? expand(b.fallback, budget) : [b]))
}

/** Rule 4: move rows from the second-last slide onto a nearly empty last slide. */
function rebalance(pages: PageSection[], byId: Map<string, MeasuredBlock>, g: Geometry): PageSection[] {
  if (pages.length < 2) return pages
  const last = pages[pages.length - 1]
  const prev = pages[pages.length - 2]
  if (last.height >= g.budget * LIGHT_PAGE) return pages
  const head = last.pieces[0]
  const tail = prev.pieces[prev.pieces.length - 1]
  if (!head || !tail || head.blockId !== tail.blockId || !head.continued) return pages
  const b = byId.get(head.blockId)
  if (!b) return pages
  // Move one row at a time while that makes the two slides more even, and the previous slide keeps
  // at least one row of the block. ("More even", not "last stays lighter": a row of cards is big,
  // and one stray card on a slide is worse than a slight tilt the other way.)
  while (tail.to - tail.from > 1) {
    const h = b.items[tail.to - 1]
    if (Math.abs(prev.height - h - (last.height + h)) >= prev.height - last.height) break
    tail.to -= 1
    head.from -= 1
    prev.height -= h
    last.height += h
  }
  return pages
}

/**
 * Column widths (percent) for a table that may be split across slides: fixed widths keep every
 * slide's columns aligned and make row heights measurable one by one. Each column weighs its
 * typical (80th percentile) text length, bounded so a long column cannot starve the others.
 */
export function columnWidths(headers: string[], rows: string[][]): number[] {
  const weights = headers.map((h, j) => {
    const lens = rows.map((r) => (r[j] ?? '').length).sort((a, b) => a - b)
    const typical = lens.length ? lens[Math.floor((lens.length - 1) * 0.8)] : 0
    return Math.min(60, Math.max(11, h.length * 0.9, typical))
  })
  const total = weights.reduce((a, b) => a + b, 0) || 1
  return weights.map((w) => Math.round((1000 * w) / total) / 10)
}
