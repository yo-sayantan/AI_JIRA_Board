import type { VulnFixes, VulnFixItem } from '../../types'
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
    </div>
  )
}
