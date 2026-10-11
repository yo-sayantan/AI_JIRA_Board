import { motion } from 'motion/react'
import type { JenkinsBuild } from '../../types'
import { buildMeta, buildTestsText, buildTooltip, consoleTailLines, envLabel, fmtDateTime, fmtDuration, hexToRgba, pipelineKindMeta, relTime } from '../../lib/format'
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
export function BuildChip({ build, now, total = 1 }: { build: JenkinsBuild; now: number; total?: number }) {
  const m = buildMeta(build.result)
  // `total` = every build of this environment on the ticket; the chip stands for the worst or the deploy one.
  const tip = buildTooltip(build, now) + (total > 1 ? `\n+${total - 1} more in ${envLabel(build.env)} — see the Proof section` : '')
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

/**
 * A failed build's console tail, collapsed: "Console (last lines)". The fetch scrubbed it of tokens, passwords,
 * credentials in URLs, e-mail addresses and IPs; the box is a capped, scrollable, keyboard-reachable monospace region.
 * Nothing is drawn for a build without one.
 */
export function ConsoleTail({ build }: { build: JenkinsBuild }) {
  const lines = consoleTailLines(build.consoleTail)
  if (!lines.length) return null
  return (
    <details data-console-tail className="rounded-md border border-[var(--line)] bg-[var(--surface-solid)]">
      <summary className="flex cursor-pointer select-none flex-wrap items-baseline gap-x-2 px-2 py-1 text-[10.5px] font-semibold text-[var(--ink-soft)]">
        Console (last lines)
        <span className="font-normal text-[var(--muted)]">
          {lines.length} {lines.length === 1 ? 'line' : 'lines'} · scrubbed of secrets
        </span>
      </summary>
      <pre
        role="region"
        tabIndex={0}
        aria-label={`Console output of build #${build.number}, last ${lines.length} ${lines.length === 1 ? 'line' : 'lines'}, scrubbed of secrets`}
        className="m-0 max-h-52 overflow-auto whitespace-pre border-t border-[var(--line)] px-2 py-1.5 font-mono text-[10.5px] leading-[1.45] text-[var(--ink-soft)]"
      >
        {lines.join('\n')}
      </pre>
    </details>
  )
}

/** Drawer row: everything known about one build — result, link, branch, when, tests, failure, console tail of a failed one. */
export function BuildRow({ build, now, timeZone }: { build: JenkinsBuild; now: number; timeZone?: string | null }) {
  const m = buildMeta(build.result)
  const href = safeHref(build.url)
  const tests = buildTestsText(build.tests)
  const duration = fmtDuration(build.durationMs)
  const failing = build.tests?.failing ?? []
  const kind = pipelineKindMeta(build.kind)
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
          title="Environment (jenkins.jobs, or labelled from the pipeline's names)"
        >
          {envLabel(build.env)}
        </span>
        {build.pipeline && (
          <span className="max-w-[16rem] truncate font-semibold text-[var(--ink-soft)]" title={`Pipeline${build.via === 'parameter' ? ' (the branch is a build parameter)' : ''}`}>
            {build.pipeline}
          </span>
        )}
        {kind && (
          <span
            className="rounded-md border px-1.5 py-0.5 text-[10px] font-bold"
            style={{ color: `color-mix(in srgb, ${kind.color} 80%, var(--ink))`, borderColor: hexToRgba(kind.color, 0.45), background: hexToRgba(kind.color, 0.07) }}
            title="What this pipeline does"
          >
            {kind.label}
          </span>
        )}
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
      <ConsoleTail build={build} />
    </div>
  )
}
