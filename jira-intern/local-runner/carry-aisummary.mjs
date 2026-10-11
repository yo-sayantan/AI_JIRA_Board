// Deterministically carry `aiSummary` (+ its `aiSummaryAt` timestamp and `aiSummaryEvidence` fingerprint) forward across a
// data.json rewrite. Any script that re-fetches tickets (daily run, per-ticket refresh) can
// drop the AI summaries; this restores them by key from a pre-run snapshot, so summaries
// never vanish regardless of what the agent wrote. The timestamp MUST travel with the text —
// it's what tells the summary pass whether a deep brief is stale (aiSummaryAt < lastUpdate).
//
//   node carry-aisummary.mjs <prev-data.json> <new-data.json>
//
// Only ADDS aiSummary/aiSummaryAt onto tickets/sub-tasks in the NEW file that lack one but had
// one in the PREV file (matched by key). Touches nothing else. Best-effort: on any
// error it leaves the new file untouched and exits 0.
import { readFileSync, writeFileSync, existsSync, renameSync, rmSync } from 'fs'

const [prevPath, curPath] = process.argv.slice(2)
try {
  if (!prevPath || !curPath || !existsSync(prevPath) || !existsSync(curPath)) process.exit(0)
  const prev = JSON.parse(readFileSync(prevPath, 'utf8'))
  const cur = JSON.parse(readFileSync(curPath, 'utf8'))

  // aiSummary is an ACTIVE-ticket field only — the board renders it exclusively for column !== 'done'
  // (see jira-board TicketDetail), so carrying it onto completed[] rows is dead weight. Harvest from
  // and apply to tickets[] (+ their sub-tasks) only.
  const map = new Map()
  const harvest = (arr) => {
    for (const t of arr || []) {
      if (t && t.key && typeof t.aiSummary === 'string' && t.aiSummary.trim())
        map.set(t.key, { aiSummary: t.aiSummary, aiSummaryAt: t.aiSummaryAt ?? null, aiSummaryEvidence: t.aiSummaryEvidence ?? null })
      if (t) harvest(t.subtasks)
    }
  }
  harvest(prev.tickets)

  let applied = 0
  const apply = (arr) => {
    for (const t of arr || []) {
      if (t && t.key && !(typeof t.aiSummary === 'string' && t.aiSummary.trim()) && map.has(t.key)) {
        const prev = map.get(t.key)
        t.aiSummary = prev.aiSummary
        if (prev.aiSummaryAt && t.aiSummaryAt == null) t.aiSummaryAt = prev.aiSummaryAt
        if (prev.aiSummaryEvidence && t.aiSummaryEvidence == null) t.aiSummaryEvidence = prev.aiSummaryEvidence
        applied++
      }
      if (t) apply(t.subtasks)
    }
  }
  apply(cur.tickets)

  if (applied) {
    // Atomic: a crash mid-write must never leave data.json truncated (the board reads it live).
    const tmp = `${curPath}.${process.pid}.swap`
    try {
      writeFileSync(tmp, JSON.stringify(cur, null, 2) + '\n')
      renameSync(tmp, curPath)
    } catch (e) {
      try {
        rmSync(tmp, { force: true })
      } catch {}
      throw e
    }
  }
  process.stdout.write(String(applied))
} catch {
  process.exit(0)
}
