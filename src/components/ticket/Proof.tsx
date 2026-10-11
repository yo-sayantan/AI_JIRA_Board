import type { ReactNode } from 'react'
import type { Ticket } from '../../types'
import { buildsOf, hexToRgba, vulnFixesOf, vulnScanLine, vulnSummary } from '../../lib/format'
import { BuildRow } from '../common/Builds'
import { VulnRow } from '../common/VulnFixes'

/**
 * The drawer's "Proof" section: evidence measured in systems outside Jira, one group per source.
 * Today: Builds (Jenkins, `Ticket.builds`) and Vulnerabilities (Checkmarx, `Ticket.vulnFixes`). A new source joins by adding its count to
 * `proofCount` and one <ProofGroup> below — the section itself, its place in the drawer and its
 * hide-when-empty rule stay as they are.
 */
export function proofCount(ticket: Ticket): number {
  return buildsOf(ticket).length + (vulnFixesOf(ticket)?.items.length ?? 0)
}

export function ProofPanel({ ticket, now, timeZone }: { ticket: Ticket; now: number; timeZone?: string | null }) {
  const builds = buildsOf(ticket)
  const vf = vulnFixesOf(ticket)
  return (
    <div className="flex flex-col gap-3">
      {vf && (
        <ProofGroup title="Vulnerabilities" source="Checkmarx" color="#65a30d" count={vf.items.length} note={`${vulnSummary(vf).label} · only what this ticket names`}>
          <div className="text-[10.5px] text-[var(--muted)]" title={`Project ${vf.project} · asked ${vf.scannedAt}`}>
            Compared <span className="font-mono text-[var(--ink-soft)]">{vulnScanLine(vf)}</span>
            {vf.note ? ` — ${vf.note}` : ''}
          </div>
          {vf.items.map((i) => (
            <VulnRow key={`${i.kind}|${i.target}`} item={i} />
          ))}
        </ProofGroup>
      )}
      {builds.length > 0 && (
        <ProofGroup title="Builds" source="Jenkins" color="#2f86ff" count={builds.length} note="Latest build of each branch, per environment">
          {builds.map((b) => (
            <BuildRow key={`${b.repo}|${b.env}|${b.branch}`} build={b} now={now} timeZone={timeZone} />
          ))}
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
          style={{ color: `color-mix(in srgb, ${color} 80%, var(--ink))`, borderColor: hexToRgba(color, 0.45), background: hexToRgba(color, 0.07) }}
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
