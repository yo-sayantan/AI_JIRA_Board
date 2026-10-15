import type { DynatraceItem } from '../../types'
import { dynatraceKindLabel, dynatraceStaleLine, dynatraceStatusMeta, dynatraceWindowLabel, fmtDateTime, hexToRgba } from '../../lib/format'
import { Pill, safeHref } from './ui'

const STALE_COLOR = '#ff8a1f'

/**
 * Drawer row: one Dynatrace link of the ticket — what kind it is, which tenant, the time window that was read, how
 * reading it went, the plain-language findings, and the link itself (the ticket's own URL, opened in a new tab).
 *
 * A link whose tenant is not in DYNATRACE_TENANTS was never fetched: it is listed muted (grey pill, dashed border), with the reason. An item
 * carried forward from an earlier run (`stale`) says when it was last read and that Dynatrace could not be re-read.
 * Flat chips like BuildRow / VulnRow; everything but the link is optional so older dumps keep rendering.
 */
export function DynatraceRow({ item, now, timeZone }: { item: DynatraceItem; now: number; timeZone?: string | null }) {
  const m = dynatraceStatusMeta(item.status)
  const kind = dynatraceKindLabel(item.kind)
  const href = safeHref(item.url)
  const windowLabel = dynatraceWindowLabel(item.window, timeZone)
  const stale = dynatraceStaleLine(item, now)
  const findings = item.findings ?? []
  const quiet = item.status === 'unconfigured-tenant'
  return (
    <div
      data-dynatrace-item
      data-status={item.status}
      data-stale={item.stale ? '' : undefined}
      className={`flex flex-col gap-1.5 rounded-lg border bg-[var(--surface-2)] px-3 py-2 ${quiet ? 'border-dashed border-[var(--line-strong)]' : 'border-[var(--line)]'}`}
    >
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 text-[11px]">
        <Pill color={m.color} filled title={`Dynatrace: ${m.label}`}>
          <span aria-hidden>{m.glyph}</span>
          {m.label}
        </Pill>
        <span
          className="rounded-md border px-1.5 py-0.5 text-[10.5px] font-bold"
          style={{ color: `color-mix(in srgb, ${m.color} 80%, var(--ink))`, borderColor: hexToRgba(m.color, 0.45), background: hexToRgba(m.color, 0.07) }}
          title="What the link points at"
        >
          {kind}
        </span>
        {item.tenant && (
          <span className="rounded-md bg-[var(--surface-solid)] px-1.5 py-0.5 font-mono text-[10.5px] text-[var(--ink-soft)]" title="Environment (from DYNATRACE_TENANTS) or the tenant id in the link">
            {item.tenant}
          </span>
        )}
        {windowLabel && (
          <span className="font-mono text-[10.5px] text-[var(--muted)]" title={item.window ? `${item.window.from} → ${item.window.to} (UTC) — the time window that was read` : undefined}>
            {windowLabel}
          </span>
        )}
        {href ? (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="ml-auto font-bold hover:underline"
            style={{ color: 'var(--pr-link)' }}
            title={`Open the link from the ticket in Dynatrace — ${href}`}
            aria-label={`Open the linked ${kind.toLowerCase()} in Dynatrace (new tab)`}
          >
            Open in Dynatrace ↗
          </a>
        ) : (
          <span className="ml-auto text-[var(--muted)]" title="The link in the ticket is not a web address, so it is not opened from here">
            link unavailable
          </span>
        )}
      </div>
      {findings.length > 0 && (
        <ul className="ml-4 flex list-disc flex-col gap-0.5 text-[11px] text-[var(--ink-soft)]">
          {findings.map((f, i) => (
            <li key={`${i}|${f}`} className="[text-wrap:pretty]">
              {f}
            </li>
          ))}
        </ul>
      )}
      {item.note && <div className="text-[11px] text-[var(--muted)] [text-wrap:pretty]">{item.note}</div>}
      {stale && (
        <div
          role="status"
          data-dynatrace-stale
          className="flex items-start gap-1.5 rounded-md border px-2 py-1 text-[10.5px] font-semibold"
          style={{ color: `color-mix(in srgb, ${STALE_COLOR} 78%, var(--ink))`, borderColor: hexToRgba(STALE_COLOR, 0.4), background: hexToRgba(STALE_COLOR, 0.07) }}
          title={item.fetchedAt ? `Last read ${fmtDateTime(item.fetchedAt, timeZone)}` : undefined}
        >
          <span aria-hidden>⚠</span>
          <span>{stale}</span>
        </div>
      )}
    </div>
  )
}
