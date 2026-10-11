import type { ProofNote, VulnFixes, VulnFixItem } from '../../types'
import { hexToRgba, vulnKindLabel, vulnStatusMeta, vulnSummary, vulnTooltip } from '../../lib/format'
import { ShieldIcon } from './Icons'
import { Pill } from './ui'

/**
 * Card chip: "🛡 2/3 fixed" — how many of the vulnerabilities the ticket names Checkmarx shows as fixed on its
 * branch. A flat chip like the build chips: green when all are fixed, red when any is still open, amber when
 * something is not found or not known yet; the tooltip lists every target.
 */
export function VulnChip({ vf }: { vf: VulnFixes }) {
  const s = vulnSummary(vf)
  return (
    <span
      className="inline-flex shrink-0 items-center gap-[3px] whitespace-nowrap rounded-md border px-1.5 text-[10px] font-bold leading-[16px]"
      style={{ color: `color-mix(in srgb, ${s.color} 82%, var(--ink))`, borderColor: hexToRgba(s.color, 0.45), background: hexToRgba(s.color, 0.07) }}
      title={vulnTooltip(vf)}
      aria-label={`Checkmarx: ${s.fixed} of ${s.total} vulnerabilities fixed`}
    >
      <ShieldIcon size={8} color={s.color} />
      {s.label}
    </span>
  )
}

/** Drawer row: one target — status, kind, the target as the ticket names it, severity, where, and the evidence line. */
export function VulnRow({ item }: { item: VulnFixItem }) {
  const m = vulnStatusMeta(item.status)
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-[var(--line)] bg-[var(--surface-2)] px-3 py-2">
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 text-[11px]">
        <Pill color={m.color} filled title={`Checkmarx: ${m.label}`}>
          <span aria-hidden>{m.glyph}</span>
          {m.label}
        </Pill>
        <span
          className="rounded-md border px-1.5 py-0.5 text-[10.5px] font-bold"
          style={{ color: `color-mix(in srgb, ${m.color} 80%, var(--ink))`, borderColor: hexToRgba(m.color, 0.45), background: hexToRgba(m.color, 0.07) }}
          title="What the ticket names"
        >
          {vulnKindLabel(item.kind)}
        </span>
        <span className="break-all font-mono font-bold text-[var(--ink)]">{item.target}</span>
        {item.severity && (
          <span className="rounded-md bg-[var(--surface-solid)] px-1.5 py-0.5 text-[10.5px] font-semibold text-[var(--ink-soft)]" title="Severity in Checkmarx">
            {item.severity}
          </span>
        )}
      </div>
      {item.location && <div className="break-all rounded-md bg-[var(--surface-solid)] px-2 py-1 font-mono text-[10.5px] text-[var(--ink-soft)]">{item.location}</div>}
      {item.detail && <div className="text-[11px] text-[var(--muted)]">{item.detail}</div>}
      {(item.foundOnBase || item.foundOnBranch) && (
        <div className="font-mono text-[10.5px] text-[var(--muted)]" title="Versions of this package that carry a finding in each scan (a package with no finding does not appear in a scan's results)">
          Versions with findings on base: {item.foundOnBase?.join(', ') || 'none'} · branch: {item.foundOnBranch?.join(', ') || 'none'}
        </div>
      )}
    </div>
  )
}

/** Not configured is a fact, not a fault (grey); an unreachable host or a spent budget needs a look (orange); a rejected key is red. */
const NOTE_COLOR: Record<ProofNote['state'], string> = { 'not-configured': '#8b94a8', unreachable: '#ff8a1f', 'budget-exhausted': '#ff8a1f', 'auth-failed': '#e11d48' }

/**
 * Drawer line: why a ticket has no fresh answer from a proof source ("Checkmarx not configured — add the URL and key in
 * API keys", "… could not be reached"). Source-neutral — it prints the note's own sentence; Checkmarx and Dynatrace both use it.
 * With `carriedFrom`, the rows below are the last results (`carriedWhat` names them: "results" by default).
 */
export function ProofNoteLine({ note, carriedFrom, carriedWhat = 'results' }: { note: ProofNote; carriedFrom?: string | null; carriedWhat?: string }) {
  const color = NOTE_COLOR[note.state]
  return (
    <div
      role="status"
      data-proof-note
      data-state={note.state}
      className="flex items-start gap-2 rounded-lg border px-3 py-2 text-[11px] font-semibold"
      style={{ color: `color-mix(in srgb, ${color} 78%, var(--ink))`, borderColor: hexToRgba(color, 0.4), background: hexToRgba(color, 0.07) }}
    >
      <span aria-hidden className="shrink-0">
        {note.state === 'not-configured' ? 'ⓘ' : '⚠'}
      </span>
      <span className="min-w-0 [text-wrap:pretty]">
        {note.detail}
        {carriedFrom ? ` — showing the last ${carriedWhat} from ${carriedFrom.slice(0, 10)}` : ''}
      </span>
    </div>
  )
}

/** The Checkmarx name for the same line (kept so existing imports read as before). */
export const VulnNote = ProofNoteLine
