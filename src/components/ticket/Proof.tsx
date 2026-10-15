import type { ReactNode } from 'react'
import type { Ticket } from '../../types'
import { buildsOf, dynatraceOf, dynatraceSummary, vulnFixesOf, vulnScanLine, vulnSummary } from '../../lib/format'
import { BuildRow } from '../common/Builds'
import { DynatraceRow } from '../common/Dynatrace'
import { ProofNoteLine, VulnRow } from '../common/VulnFixes'
import { proofNoteOf, vulnReadLine } from '../../lib/proofStatus'
import { lift, tint } from '../../lib/tone'

/**
 * The drawer's "Proof" section: evidence measured in systems outside Jira, one group per source.
 * Today: Builds (Jenkins, `Ticket.builds`), Vulnerabilities (Checkmarx, `Ticket.vulnFixes`) and Linked traces & problems
 * (Dynatrace, `Ticket.dynatrace`). A new source joins by adding its count to
 * `proofCount` and one <ProofGroup> below — the section itself, its place in the drawer and its
 * hide-when-empty rule stay as they are.
 */
export function proofCount(ticket: Ticket): number {
  // A vulnerability-fix ticket Checkmarx could not answer (not configured, unreachable …) still shows its group — with the reason.
  const vf = vulnFixesOf(ticket)
  // Likewise a ticket whose Dynatrace links could not be answered keeps its group, with the reason.
  const dt = dynatraceOf(ticket)
  return buildsOf(ticket).length + (vf ? vf.items.length : proofNoteOf(ticket, 'checkmarx') ? 1 : 0) + (dt ? dt.items.length : proofNoteOf(ticket, 'dynatrace') ? 1 : 0)
}

/** The Dynatrace group's colour — the service's own calm violet (setup/api-keys.json), so the drawer and the keys window agree. */
const DYNATRACE_COLOR = '#8f7ae5'

export function ProofPanel({ ticket, now, timeZone }: { ticket: Ticket; now: number; timeZone?: string | null }) {
  const builds = buildsOf(ticket)
  const vf = vulnFixesOf(ticket)
  const vulnNote = proofNoteOf(ticket, 'checkmarx')
  const dt = dynatraceOf(ticket)
  const dtNote = proofNoteOf(ticket, 'dynatrace')
  return (
    <div className="flex flex-col gap-3">
      {(vf || vulnNote) && (
        <ProofGroup
          title="Vulnerabilities"
          source="Checkmarx"
          color="#65a30d"
          count={vf?.items.length}
          note={vf ? `${vulnSummary(vf).label} · only what this ticket names` : undefined}
        >
          {vulnNote && <ProofNoteLine note={vulnNote} carriedFrom={vf?.scannedAt} />}
          {vf && (
            <>
              <div className="text-[10.5px] text-[var(--muted)]" title={`Project ${vf.project} · asked ${vf.scannedAt}`}>
                Compared <span className="font-mono text-[var(--ink-soft)]">{vulnScanLine(vf)}</span>
                {vf.note ? ` — ${vf.note}` : ''}
                {vulnReadLine(vf) && <div className="mt-0.5">{vulnReadLine(vf)}</div>}
              </div>
              {vf.items.map((i) => (
                <VulnRow key={`${i.kind}|${i.target}`} item={i} />
              ))}
            </>
          )}
        </ProofGroup>
      )}
      {builds.length > 0 && (
        <ProofGroup title="Builds" source="Jenkins" color="#2f86ff" count={builds.length} note="Latest build of each branch, per environment and pipeline">
          {builds.map((b) => (
            <BuildRow key={`${b.repo}|${b.env}|${b.pipeline ?? ''}|${b.branch}`} build={b} now={now} timeZone={timeZone} />
          ))}
        </ProofGroup>
      )}
      {(dt || dtNote) && (
        <ProofGroup
          title="Linked traces & problems"
          source="Dynatrace"
          color={DYNATRACE_COLOR}
          count={dt?.items.length}
          note={dt ? dynatraceSummary(dt) : undefined}
        >
          {dtNote && <ProofNoteLine note={dtNote} />}
          {dt?.items.map((i, n) => (
            <DynatraceRow key={`${n}|${i.url}`} item={i} now={now} timeZone={timeZone} />
          ))}
          {dt && typeof dt.moreLinks === 'number' && dt.moreLinks > 0 && (
            <div className="text-[10.5px] text-[var(--muted)]">
              +{dt.moreLinks} more Dynatrace {dt.moreLinks === 1 ? 'link' : 'links'} in the ticket {dt.moreLinks === 1 ? 'was' : 'were'} not read — open the ticket in Jira.
            </div>
          )}
        </ProofGroup>
      )}
    </div>
  )
}

export function ProofGroup({
  title,
  source,
  color,
  count,
  note,
  children,
}: {
  title: string
  source: string
  color: string
  count?: number
  note?: string
  children: ReactNode
}) {
  return (
    <section aria-label={`${title} · ${source}`} className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className="text-[12px] font-bold text-[var(--ink)]">{title}</span>
        <span
          className="rounded-md border px-1.5 text-[10px] font-bold leading-[16px]"
          style={{ color: `color-mix(in srgb, ${lift(color)} 80%, var(--ink))`, borderColor: tint(color, 0.45), background: tint(color, 0.07) }}
        >
          {source}
        </span>
        {typeof count === 'number' && <span className="text-[10.5px] text-[var(--muted)]">{count}</span>}
        {note && <span className="ml-auto truncate text-[10.5px] text-[var(--muted)]">{note}</span>}
      </div>
      <div className="flex flex-col gap-2">{children}</div>
    </section>
  )
}
