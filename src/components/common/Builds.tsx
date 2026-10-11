import { motion } from 'motion/react'
import type { JenkinsBuild } from '../../types'
import { buildMeta, buildTestsText, buildTooltip, envLabel, fmtDateTime, fmtDuration, hexToRgba, relTime } from '../../lib/format'
import { Pill, safeHref } from './ui'

/** The result mark: ✓ ✗ ! ⦸ ○, and a turning ring while the build is still running. */
export function BuildGlyph({ result, color, size = 10 }: { result: JenkinsBuild['result']; color: string; size?: number }) {
  if (result === 'BUILDING') {
    return (
      <motion.span
        aria-hidden
        className="inline-block shrink-0 rounded-full"
        style={{ width: size, height: size, border: `1.5px solid ${hexToRgba(color, 0.3)}`, borderTopColor: color }}
        animate={{ rotate: 360 }}
        transition={{ repeat: Infinity, duration: 0.9, ease: 'linear' }}
      />
    )
  }
  return (
    <span aria-hidden className="leading-none" style={{ fontSize: size + 1 }}>
      {buildMeta(result).glyph}
    </span>
  )
}

/**
 * Card chip: one per environment — "QA ✓ #412". A flat chip (thin outline, faint tint, coloured
 * text) like the rest of the board's controls; the tooltip carries branch, time, tests and failure.
 */
export function BuildChip({ build, now }: { build: JenkinsBuild; now: number }) {
  const m = buildMeta(build.result)
  const tip = buildTooltip(build, now)
  return (
    <span
      className="inline-flex shrink-0 items-center gap-[3px] whitespace-nowrap rounded-md border px-1.5 text-[10px] font-bold leading-[16px]"
      style={{
        color: m.color === '#94a3b8' ? 'var(--muted)' : `color-mix(in srgb, ${m.color} 82%, var(--ink))`,
        borderColor: hexToRgba(m.color, 0.45),
        background: hexToRgba(m.color, 0.07),
      }}
      title={tip}
    >
      {envLabel(build.env)}
      <BuildGlyph result={build.result} color={m.color} />
      <span className="sr-only">{m.label}</span>
      <span className="font-mono font-semibold opacity-80">#{build.number}</span>
    </span>
  )
}

/** Drawer row: everything known about one build — result, link, branch, when, tests, failure. */
export function BuildRow({ build, now, timeZone }: { build: JenkinsBuild; now: number; timeZone?: string | null }) {
  const m = buildMeta(build.result)
  const href = safeHref(build.url)
  const tests = buildTestsText(build.tests)
  const duration = fmtDuration(build.durationMs)
  const failing = build.tests?.failing ?? []
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-[var(--line)] bg-[var(--surface-2)] px-3 py-2">
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 text-[11px]">
        <Pill color={m.color} filled title={`Latest ${envLabel(build.env)} build: ${m.label}`}>
          <BuildGlyph result={build.result} color="#fff" />
          {m.label}
        </Pill>
        <span
          className="rounded-md border px-1.5 py-0.5 text-[10.5px] font-bold"
          style={{ color: `color-mix(in srgb, ${m.color} 80%, var(--ink))`, borderColor: hexToRgba(m.color, 0.45), background: hexToRgba(m.color, 0.07) }}
          title="Environment (config → jenkins.jobs)"
        >
          {envLabel(build.env)}
        </span>
        {href ? (
          <a href={href} target="_blank" rel="noopener noreferrer" className="font-mono font-bold hover:underline" style={{ color: 'var(--pr-link)' }} title="Open the build in Jenkins">
            #{build.number} ↗
          </a>
        ) : (
          <span className="font-mono font-bold" style={{ color: 'var(--pr-link)' }}>
            #{build.number}
          </span>
        )}
        <span className="rounded-md bg-[var(--surface-solid)] px-1.5 py-0.5 font-mono text-[10.5px] text-[var(--ink-soft)]" title="Repository">
          {build.repo}
        </span>
        {build.at && (
          <span className="text-[var(--muted)]" title={fmtDateTime(build.at, timeZone)}>
            {relTime(build.at, now)}
            {duration ? ` · took ${duration}` : build.result === 'BUILDING' ? ' · running' : ''}
          </span>
        )}
        {build.deployTarget && (
          <span className="text-[var(--muted)]" title="Deploy target">
            → <b className="text-[var(--ink-soft)]">{build.deployTarget}</b>
          </span>
        )}
      </div>
      <div className="break-all rounded-md bg-[var(--surface-solid)] px-2 py-1 font-mono text-[10.5px] text-[var(--ink-soft)]">{build.branch}</div>
      {(tests || build.failedStage) && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
          {tests && <span className="text-[var(--muted)]">Tests: <b className="text-[var(--ink-soft)]">{tests}</b></span>}
          {build.failedStage && (
            <span className="font-semibold" style={{ color: m.color }}>
              Failed at stage “{build.failedStage}”
            </span>
          )}
        </div>
      )}
      {failing.length > 0 && (
        <ul className="ml-4 list-disc text-[10.5px] text-[var(--ink-soft)]">
          {failing.map((name) => (
            <li key={name} className="break-all font-mono">
              {name}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
