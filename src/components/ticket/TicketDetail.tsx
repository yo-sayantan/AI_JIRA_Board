import { useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { AnimatePresence, motion, useDragControls, type PanInfo } from 'motion/react'
import type { Ticket, LinkRef, Comment, PullRequest } from '../../types'
import { COLUMN_META } from '../../lib/columns'
import { fmtDate, fmtDateTime, relTime, prMeta, primaryPrOf, isMergedPr, isClosedPr, prListOf, prCommentStats, branchesOf, branchStatusOf, typeMeta, effectiveType, isAssignedToMe, cycleTime, fmtDays, unwrapBrief } from '../../lib/format'
import { Pill, StatusBadge, PrBadge, Approvals, PointsTag, CopyButton, SafeHtml, ExternalLink, safeHref } from '../common/ui'
import { BranchCards } from './BranchCards'
import { HeaderPills } from './HeaderPills'
import { Pipeline } from './Pipeline'
import { ProofPanel, proofCount } from './Proof'
import { useDialogFocus } from '../../hooks/useDialogFocus'
import { toneColor, type PrReportSummary } from '../../lib/reportTypes'
import { APP_CONFIG } from '../../lib/appConfig'
import {
  ChevronIcon,
  PrStateIcon,
  RefreshIcon,
  TypeIcon,
  ClockIcon,
  DocIcon,
  SparkleIcon,
  CheckIcon,
  CommentIcon,
  LinkIcon,
  BookIcon,
  GlobeIcon,
  WrenchIcon,
  QuestionIcon,
  PaperclipIcon,
  BranchIcon,
  PersonIcon,
  TrophyIcon,
  FlaskIcon,
} from '../common/Icons'
import { lift, onFill, tint } from '../../lib/tone'
import { COLLAPSE, DRAWER, DRAWER_EXIT, DRAWER_RETURN, flickDismisses } from '../../lib/motion'

/**
 * The one-click path from a ticket to its management-grade verdict. Three states: a report exists
 * (button coloured by verdict → opens the overlay), one is being generated (spinner — the app polls
 * and this flips to the button when it lands), none yet (offer to generate; on file:// show how).
 */
/**
 * A drawer action on glass: the neutral material (`bg-[var(--surface-solid)]` on the element) with only a faint wash of
 * its colour under the sheen, and a coloured rim — colour comes from the content, the glass itself stays clear.
 */
function glassChip(color: string): CSSProperties {
  return { borderColor: tint(color, 0.45), backgroundImage: `var(--glass-sheen), linear-gradient(${tint(color, 0.07)}, ${tint(color, 0.07)})` }
}

/**
 * Each drawer section's icon colour says what the section IS, not which column the ticket is in (that used to tint every
 * icon the same). Hues the board already uses for those things — sub-tickets sky, branches indigo (the branch cards), PRs
 * purple, acceptance green, Confluence Atlassian blue — and quieter greys for the reference sections lower down, so the
 * sections that decide the work read first.
 */
export const SECTION_HUE = {
  description: '#64748b',
  criteria: '#22c55e',
  subtasks: '#0ea5e9',
  prs: '#a855f7',
  branches: '#6d7cff',
  proof: '#14b8a6',
  comments: '#3b82f6',
  solution: '#f97316',
  effort: '#f59e0b',
  questions: '#f43f5e',
  related: '#06b6d4',
  docs: '#2684ff',
  external: '#10b981',
  log: '#8b94a8',
  sources: '#94a3b8',
} as const

function PrReportButton({
  ticketKey,
  report,
  generating,
  loading,
  served,
  onOpen,
  onGenerate,
}: {
  ticketKey: string
  report?: PrReportSummary | null
  generating?: boolean
  loading?: boolean
  served?: boolean
  onOpen?: (key: string) => void
  onGenerate?: (key: string) => void
}) {
  const ai = '#a855f7'
  if (generating) {
    return (
      <div
        className="mb-4 flex flex-wrap items-center gap-2 rounded-xl border px-3.5 py-2.5 text-[12.5px]"
        style={{ borderColor: tint(ai, 0.4), background: tint(ai, 0.08) }}
        role="status"
      >
        <motion.span className="inline-flex" animate={{ rotate: 360 }} transition={{ repeat: Infinity, duration: 0.9, ease: 'linear' }}>
          <RefreshIcon size={13} color={lift(ai)} />
        </motion.span>
        <span className="font-bold" style={{ color: lift(ai) }}>
          AI intern working…
        </span>
        <span className="text-[var(--muted)]"></span>
      </div>
    )
  }
  if (report) {
    const v = report.verdict
    const c = toneColor(v?.tone)
    const when = report.enrichedAt ?? report.generatedAt
    return (
      <div className="mb-4 flex items-stretch gap-1.5">
        <button
          type="button"
          onClick={() => onOpen?.(ticketKey)}
          disabled={loading}
          className="glass-interactive flex min-w-0 flex-1 flex-wrap items-center gap-2.5 rounded-xl border bg-[var(--surface-solid)] px-3.5 py-2.5 text-left card-shadow disabled:opacity-70"
          style={{ borderColor: tint(c, 0.45), backgroundImage: `var(--glass-sheen), linear-gradient(135deg, ${tint(c, 0.1)}, ${tint(c, 0.02)})` }}
          title={v?.headline ?? 'Open the PR readiness report'}
        >
          <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: c }} />
          <span className="text-[12.5px] font-extrabold" style={{ color: lift(c) }}>
            PR Readiness Report
          </span>
          {v && (
            <span className="rounded-full px-2 py-[2px] text-[10.5px] font-bold" style={{ color: lift(c), background: tint(c, 0.18) }}>
              {v.label}
            </span>
          )}
          {typeof v?.score === 'number' && <span className="text-[11px] font-bold tabular-nums text-[var(--ink-soft)]">{v.score}/100</span>}
          <span className="ml-auto text-[10px] font-medium uppercase tracking-wide text-[var(--muted)]">
            {report.enriched ? 'AI-enriched' : 'derived'}
            {when ? ` · ${fmtDate(when, report.timeZone ?? APP_CONFIG.timeZone)}` : ''}
          </span>
          <ChevronIcon size={11} className="text-[var(--muted)]" />
        </button>
        {served && onGenerate && (
          <button
            type="button"
            onClick={() => onGenerate(ticketKey)}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-xl border px-2.5 text-[11px] font-bold transition-colors hover:bg-[var(--surface-2)]"
            style={{ borderColor: tint(ai, 0.45), color: lift(ai) }}
            title="Rebuild this report from the latest Jira / Bitbucket state (runs in the background)"
          >
            <RefreshIcon size={12} color={lift(ai)} />
            Regenerate
          </button>
        )}
      </div>
    )
  }
  if (served && onGenerate) {
    return (
      <button
        type="button"
        onClick={() => onGenerate(ticketKey)}
        className="mb-4 flex w-full flex-wrap items-center gap-2 rounded-xl border border-dashed px-3.5 py-2.5 text-left text-[12.5px] transition-colors hover:bg-[var(--surface-2)]"
        style={{ borderColor: tint(ai, 0.5) }}
        title="Build the PR readiness report for this ticket in the background"
      >
        <SparkleIcon size={13} color={lift(ai)} />
        <span className="font-bold" style={{ color: lift(ai) }}>
          Generate PR readiness report
        </span>
        <span className="text-[var(--muted)]">verdict · evidence · change assessment · risks · open scope — runs in the background</span>
      </button>
    )
  }
  return (
    <div className="mb-4 rounded-xl border border-dashed border-[var(--line)] px-3.5 py-2 text-[11.5px] text-[var(--muted)]">
      No PR readiness report yet — it is generated automatically after the next fetch, or run{' '}
      <code className="rounded bg-[var(--surface-2)] px-1">bash jira-intern/local-runner/pr-report.sh {ticketKey}</code>
    </div>
  )
}

export function TicketDetail({
  ticket,
  now,
  onClose,
  onOpen,
  onJumpTo,
  depth = 0,
  topDepth = 0,
  onRefreshTicket,
  onArchive,
  refreshing,
  user,
  report,
  reportsEnabled,
  briefsEnabled,
  reportGenerating,
  reportLoading,
  onOpenReport,
  onGenerateReport,
  served,
}: {
  /** PR Readiness Report header for this ticket (null/undefined = none yet). */
  report?: PrReportSummary | null
  /** Turned off in Settings → the whole report section disappears from the drawer. */
  reportsEnabled?: boolean
  /** Turned off in Settings → the AI brief on the ticket disappears. */
  briefsEnabled?: boolean
  reportGenerating?: boolean
  reportLoading?: boolean
  onOpenReport?: (key: string) => void
  onGenerateReport?: (key: string) => void
  served?: boolean
  ticket: Ticket
  now: number
  onClose: () => void
  onOpen?: (key: string) => void
  /** Bring this (lower) drawer back to the front — closes everything stacked above it. */
  onJumpTo?: () => void
  /** Position of this drawer in the open stack (0 = first opened). */
  depth?: number
  /** Index of the top-most drawer in the stack. */
  topDepth?: number
  onRefreshTicket?: (key: string) => void
  /** Move this (Done) ticket to the Completed archive now — off the board immediately. */
  onArchive?: (key: string) => void
  refreshing?: boolean
  user?: { name?: string | null; accountId?: string | null } | null
}) {
  const meta = COLUMN_META[ticket.column]
  const accent = meta?.accent ?? '#64748b'
  const prs = prListOf(ticket)
  const branches = branchesOf(ticket)
  const fromTop = topDepth - depth // 0 = front-most drawer
  const isTop = depth >= topDepth
  const asideRef = useRef<HTMLElement>(null)
  const jiraHref = safeHref(ticket.url)

  // The drawer joins the shared dialog stack for its whole life (it unmounts when it closes), so
  // a sub-task drawer pushed on top — or a report, or the Completed archive underneath — never
  // fights it for Tab: only the newest entry traps. Focus is saved on mount and restored on
  // unmount, so closing a sub-task lands back in its parent and closing the last drawer lands on
  // the card (or archive row) that opened it.
  useDialogFocus(true, asideRef)

  // Drag the front drawer away (apple-design: direct manipulation, momentum, rubber-banding). It
  // tracks the pointer 1:1 from where it was grabbed; let go and the PROJECTED resting point decides
  // — a quick flick closes it from a short drag — and the exit spring carries the release velocity
  // on, so there is no seam between dragging and animating. Grabbed by the edge grabber or the
  // header (never by a button, link or field). Esc and the × still close it as before.
  const drag = useDragControls()
  const startDrag = (e: React.PointerEvent) => {
    if (!isTop || e.button !== 0) return
    if ((e.target as HTMLElement).closest('button, a, input, textarea, select, [role="button"], [data-no-drag]')) return
    drag.start(e)
  }
  const endDrag = (_: unknown, info: PanInfo) => {
    const width = asideRef.current?.offsetWidth ?? window.innerWidth
    if (flickDismisses(info.offset.x, info.velocity.x, width)) onClose()
  }

  return (
      <motion.aside
        ref={asideRef}
        tabIndex={-1}
        className="jb-sheet fixed right-0 top-0 flex h-full w-full max-w-5xl flex-col border-l border-[var(--line)] shadow-2xl outline-none"
        style={{ zIndex: 50 + depth }}
        initial={{ x: '100%' }}
        animate={{ x: -(Math.min(fromTop, 5) * 40) }}
        exit={{ x: '100%', transition: DRAWER_EXIT }}
        transition={DRAWER}
        drag={isTop ? 'x' : false}
        dragListener={false}
        dragControls={drag}
        dragConstraints={{ left: 0, right: 0 }}
        // Free to the right (toward closing), a stiff rubber band to the left (past open).
        dragElastic={{ left: 0.06, right: 1 }}
        dragMomentum={false}
        dragTransition={DRAWER_RETURN}
        onDragEnd={endDrag}
        role="dialog"
        aria-modal={isTop}
      >
        {/* Grabber: the drawer's left edge. Shows a pill on hover so the gesture is discoverable. */}
        {isTop && (
          <div
            aria-hidden
            onPointerDown={startDrag}
            className="group/grab absolute inset-y-0 -left-1 z-20 w-4 cursor-grab touch-none active:cursor-grabbing"
          >
            <span className="absolute left-1.5 top-1/2 h-10 w-1 -translate-y-1/2 rounded-full bg-[var(--muted)] opacity-0 transition-opacity duration-150 group-hover/grab:opacity-60" />
          </div>
        )}

        {/* accent top bar */}
        <div className="h-1 w-full shrink-0" style={{ background: `linear-gradient(90deg, ${accent}, transparent)` }} />

        {/* sticky header */}
        <div onPointerDown={startDrag} className="sticky top-0 z-10 border-b border-[var(--line)] bg-[var(--bg)]/90 px-5 py-3.5 backdrop-blur-xl">
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="font-mono text-[12px] font-bold" style={{ color: lift(accent) }}>
                  {ticket.key}
                </span>
                <PointsTag points={ticket.storyPoints} />
              </div>
              <h2 className="mt-0.5 text-[16px] font-extrabold leading-snug text-[var(--ink)]">{ticket.title}</h2>
            </div>
            <button
              onClick={onClose}
              className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-[var(--line)] text-[var(--muted)] hover:border-[var(--muted)] hover:text-[var(--ink)]"
              aria-label="Close"
            >
              ✕
            </button>
          </div>

          {/* One size for every pill, each a real link (Jira for its values, Bitbucket for the PR), with depth. */}
          <HeaderPills ticket={ticket} />
        </div>

        {/* scroll body */}
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <div className="mb-4 rounded-xl border border-[var(--line)] bg-[var(--surface-solid)] p-3.5 card-shadow">
            <Pipeline current={ticket.column} rawStatus={ticket.status} />
          </div>

          {/* quick actions */}
          <div className="mb-4 flex flex-wrap items-center gap-2">
            {onRefreshTicket && ticket.column !== 'done' && (
              <motion.button
                type="button"
                whileHover={refreshing ? undefined : { rotate: 30 }}
                whileTap={{ scale: 0.9 }}
                onClick={() => !refreshing && onRefreshTicket(ticket.key)}
                disabled={refreshing}
                aria-label={refreshing ? 'Refreshing this ticket' : 'Refresh this ticket'}
                aria-busy={refreshing}
                className="glass-interactive grid h-7 w-7 place-items-center rounded-full border bg-[var(--surface-solid)] disabled:cursor-progress"
                style={glassChip('#2684ff')}
                title={refreshing ? 'Refreshing…' : 'Fetch the latest status of just this ticket (background)'}
              >
                <motion.span className="inline-flex" animate={refreshing ? { rotate: 360 } : { rotate: 0 }} transition={refreshing ? { repeat: Infinity, duration: 0.8, ease: 'linear' } : { duration: 0.2 }}>
                  <RefreshIcon size={13} color={lift('#2684ff')} />
                </motion.span>
              </motion.button>
            )}
            {onArchive && ticket.column === 'done' && (
              <button
                onClick={() => onArchive(ticket.key)}
                className="glass-interactive inline-flex items-center gap-1.5 rounded-lg border bg-[var(--surface-solid)] px-2.5 py-1 text-[11px] font-bold"
                style={{ ...glassChip('#f59e0b'), color: lift('#b45309') }}
                title="Move this ticket to the Completed archive now (removes it from the board)"
              >
                <TrophyIcon size={12} /> Move to Completed
              </button>
            )}
            {/* The link, not the bare key: pasted into chat, mail or a PR it opens the ticket. No URL in the dump → the key. */}
            {jiraHref ? (
              <CopyButton text={jiraHref} label="Copy link" icon={<LinkIcon size={12} />} title={`Copy ${jiraHref}`} />
            ) : (
              <CopyButton text={ticket.key} label="Copy ID" />
            )}
            {jiraHref && (
              <a
                href={jiraHref}
                target="_blank"
                rel="noopener noreferrer"
                className="glass-interactive inline-flex items-center gap-1 rounded-lg border bg-[var(--surface-solid)] px-2.5 py-1 text-[11px] font-bold"
                style={{ ...glassChip('#2684ff'), color: 'var(--link)' }}
              >
                Open in Jira ↗
              </a>
            )}
            {prs
              .map((p) => ({ p, href: safeHref(p.url) }))
              .filter((x): x is { p: PullRequest; href: string } => !!x.href)
              .map(({ p, href }, i) => (
                <a
                  key={i}
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="glass-interactive inline-flex items-center gap-1 rounded-lg border bg-[var(--surface-solid)] px-2.5 py-1 text-[11px] font-bold"
                  style={{ ...glassChip('#a855f7'), color: 'var(--pr-link)' }}
                  title={prMeta(p.state).label}
                >
                  PR{p.id ? ` #${p.id}` : ''} ↗
                </a>
              ))}
          </div>

          {/* Section order = developer usability: understand → deliverables → work → code →
              discussion → analysis → references → metadata / history (least useful last). */}

          {/* 0. PR Readiness Report — above the brief on purpose: once code exists, "can this ship?"
              is the first question. Only for tickets that have a pull request. */}
          {prs.length > 0 && reportsEnabled !== false && (
            <PrReportButton
              ticketKey={ticket.key}
              report={report}
              generating={reportGenerating}
              loading={reportLoading}
              served={served}
              onOpen={onOpenReport}
              onGenerate={onGenerateReport}
            />
          )}

          {/* 1. AI Summary — fastest "what is this about". To Do / In-Progress tickets carry a
              DEEP brief (light HTML: linked docs, related tickets, PR/code state, attachments);
              others a short plain paragraph. SafeHtml renders both (and sanitizes). */}
          {briefsEnabled !== false && ticket.aiSummary && ticket.column !== 'done' && (
            <div
              className="mb-4 overflow-hidden rounded-xl border border-[#7c3aed]/30 bg-[var(--surface-solid)] card-shadow"
              style={{ backgroundImage: `var(--glass-sheen), linear-gradient(135deg, ${tint('#7c3aed', 0.07)}, ${tint('#6366f1', 0.025)})` }}
            >
              <div className="flex items-center gap-2 border-b border-[#7c3aed]/20 px-3.5 py-2">
                <SparkleIcon color={lift('#a855f7')} size={14} />
                <span className="text-[12px] font-bold text-[#a855f7] dark:text-[#c084fc]">
                  {ticket.column === 'todo' || ticket.column === 'prog' ? 'AI Brief' : 'AI Summary'}
                </span>
                <span className="ml-auto text-[10px] font-medium uppercase tracking-wide text-[var(--muted)]">
                  auto-generated{ticket.aiSummaryAt ? ` · ${fmtDate(ticket.aiSummaryAt)}` : ''}
                </span>
              </div>
              <SafeHtml html={unwrapBrief(ticket.aiSummary)} className="px-3.5 py-3 text-[13.5px] leading-relaxed text-[var(--ink-soft)]" />
            </div>
          )}

          {/* 2. Description — full detail */}
          {ticket.description && (
            <Section title="Description" icon={<DocIcon color={lift(SECTION_HUE.description)} size={14} />} accent={SECTION_HUE.description} defaultOpen={false}>
              <SafeHtml html={ticket.description} />
            </Section>
          )}

          {/* 3. Acceptance criteria — definition of done */}
          {ticket.acceptanceCriteria && ticket.acceptanceCriteria.length > 0 && (
            <Section title="Acceptance criteria" icon={<CheckIcon color={lift(SECTION_HUE.criteria)} size={14} />} accent={SECTION_HUE.criteria} count={ticket.acceptanceCriteria.length}>
              <AcceptanceChecklist storageKey={ticket.key} items={ticket.acceptanceCriteria} accent={SECTION_HUE.criteria} />
            </Section>
          )}

          {/* 4. Sub-tasks — work breakdown */}
          {ticket.subtasks && ticket.subtasks.length > 0 && (
            <Section title="Sub-tasks" icon={<TypeIcon type="sub-task" color={lift(SECTION_HUE.subtasks)} size={14} />} accent={SECTION_HUE.subtasks} count={ticket.subtasks.length}>
              <SubtaskTree root={ticket} onOpen={onOpen} user={user} />
            </Section>
          )}

          {/* 5. Pull requests — code / merge status */}
          {prs.length > 0 && (
            <Section
              title={prs.length > 1 ? 'Pull requests' : 'Pull request'}
              icon={<PrStateIcon state={primaryPrOf(ticket)?.state} color={lift(SECTION_HUE.prs)} size={14} />}
              accent={SECTION_HUE.prs}
              count={prs.length > 1 ? prs.length : undefined}
            >
              <div className="flex flex-col gap-2.5">
                {prs.map((p, i) => (
                  <PrRow key={i} pr={p} />
                ))}
              </div>
            </Section>
          )}

          {/* 6. Branches — checkout target */}
          {branches.length > 0 && (
            <Section
              title={branches.length > 1 ? 'Branches' : 'Branch'}
              icon={<BranchIcon color={lift(SECTION_HUE.branches)} size={14} />}
              accent={SECTION_HUE.branches}
              count={branches.length > 1 ? branches.length : undefined}
            >
              <BranchCards branches={branches} stateOf={(b) => branchStatusOf(b, ticket)} />
            </Section>
          )}

          {/* 6b. Proof — measured outside Jira: Checkmarx vulnerability fixes, latest Jenkins build per environment, what Dynatrace says about the ticket's links (more sources join in Proof.tsx) */}
          {proofCount(ticket) > 0 && (
            <Section title="Proof" icon={<FlaskIcon color={lift(SECTION_HUE.proof)} size={14} />} accent={SECTION_HUE.proof} count={proofCount(ticket)}>
              <ProofPanel ticket={ticket} now={now} timeZone={APP_CONFIG.timeZone} />
            </Section>
          )}

          {/* 7. Comments — discussion, decisions, blockers */}
          {ticket.comments && ticket.comments.length > 0 && (
            <Section title="Comments" icon={<CommentIcon color={lift(SECTION_HUE.comments)} size={14} />} accent={SECTION_HUE.comments} count={ticket.commentCount ?? ticket.comments.length} defaultOpen={false}>
              <div className="flex flex-col gap-2.5">
                {ticket.comments.map((c, i) => (
                  <CommentItem key={i} c={c} now={now} />
                ))}
              </div>
            </Section>
          )}

          {/* 8. Proposed solution — approach / analysis */}
          {ticket.proposedSolution && (
            <Section title="Proposed solution / changes" icon={<WrenchIcon color={lift(SECTION_HUE.solution)} size={14} />} accent={SECTION_HUE.solution}>
              <SafeHtml html={ticket.proposedSolution} />
            </Section>
          )}

          {/* 8b. Effort estimate — sizing / how long */}
          {(ticket.effortEstimate || ticket.estDays) && (
            <Section title="Effort estimate" icon={<ClockIcon color={lift(SECTION_HUE.effort)} size={14} />} accent={SECTION_HUE.effort} defaultOpen={false}>
              {ticket.estDays && (
                <div className="mb-2 inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-semibold" style={{ color: lift(accent), background: tint(accent, 0.12) }}>
                  <ClockIcon color={lift(accent)} size={12} /> {ticket.estDays}
                </div>
              )}
              {ticket.effortEstimate && <SafeHtml html={ticket.effortEstimate} />}
            </Section>
          )}

          {/* 9. Open questions — unknowns to resolve */}
          {ticket.openQuestions && ticket.openQuestions.length > 0 && (
            <Section title="Open questions" icon={<QuestionIcon color={lift(SECTION_HUE.questions)} size={14} />} accent={SECTION_HUE.questions} count={ticket.openQuestions.length}>
              <ul className="flex flex-col gap-1.5">
                {ticket.openQuestions.map((q, i) => (
                  <li key={i} className="flex gap-2 text-[13px] text-[var(--ink-soft)]">
                    <span style={{ color: lift(accent) }}>•</span>
                    {q}
                  </li>
                ))}
              </ul>
            </Section>
          )}

          {/* 10. Related tickets — linked context */}
          {ticket.related && ticket.related.length > 0 && (
            <Section title="Related tickets" icon={<LinkIcon color={lift(SECTION_HUE.related)} size={14} />} accent={SECTION_HUE.related} count={ticket.related.length} defaultOpen={false}>
              <LinkList items={ticket.related} />
            </Section>
          )}

          {/* 11. Confluence & docs — reference */}
          {ticket.confluence && ticket.confluence.length > 0 && (
            <Section title="Confluence & docs" icon={<BookIcon color={lift(SECTION_HUE.docs)} size={14} />} accent={SECTION_HUE.docs} count={ticket.confluence.length}>
              <RefCards items={ticket.confluence} />
            </Section>
          )}

          {/* 12. External links — reference */}
          {ticket.externalLinks && ticket.externalLinks.length > 0 && (
            <Section title="External links" icon={<GlobeIcon color={lift(SECTION_HUE.external)} size={14} />} accent={SECTION_HUE.external} count={ticket.externalLinks.length} defaultOpen={false}>
              <RefCards items={ticket.externalLinks} />
            </Section>
          )}

          {/* 13. Overview — metadata (sprint / people / epic / labels / components) */}
          <OverviewGrid ticket={ticket} />

          {/* 14. Update log — status history + last updated */}
          {((ticket.updateLog && ticket.updateLog.length > 0) || ticket.lastUpdate) && (
            <Section title="Update log" icon={<ClockIcon color={lift(SECTION_HUE.log)} size={14} />} accent={SECTION_HUE.log} count={ticket.updateLog?.length || undefined}>
              {ticket.lastUpdate && (
                <div className="mb-2.5 text-[12px] text-[var(--muted)]">
                  Last updated <span className="font-semibold text-[var(--ink-soft)]">{fmtDateTime(ticket.lastUpdate)}</span> ({relTime(ticket.lastUpdate, now)})
                </div>
              )}
              {ticket.updateLog && ticket.updateLog.length > 0 && <Timeline accent={accent} entries={ticket.updateLog} />}
            </Section>
          )}

          {/* 15. Sources — provenance (least useful) */}
          {ticket.sources && ticket.sources.length > 0 && (
            <Section title="Sources" icon={<PaperclipIcon color={lift(SECTION_HUE.sources)} size={14} />} accent={SECTION_HUE.sources} count={ticket.sources.length} defaultOpen={false}>
              <LinkList items={ticket.sources} />
            </Section>
          )}

          <div className="mt-4 text-center text-[11px] text-[var(--muted)]">
            Generated by JIRA Intern{ticket.lastUpdate ? ` · updated ${fmtDate(ticket.lastUpdate)}` : ''}
          </div>
        </div>

        {/* When another drawer is stacked on top, dim this one and let a click on the
            exposed edge bring it back to the front (closing everything above it). */}
        {!isTop && (
          <button
            onClick={onJumpTo}
            aria-label={`Return to ${ticket.key}`}
            title={`Return to ${ticket.key}`}
            className="absolute inset-0 z-20 cursor-pointer bg-black/45 backdrop-blur-[1px] transition-colors hover:bg-black/35"
          />
        )}
      </motion.aside>
  )
}

// ── Section (open by default, collapsible) ─────────────────────────────────
function Section({
  title,
  icon,
  accent,
  count,
  defaultOpen = true,
  children,
}: {
  title: string
  icon: ReactNode
  accent: string
  count?: number
  defaultOpen?: boolean
  children: ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen) // sections expand by default unless told otherwise
  return (
    <div className="mb-3 overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--surface-solid)]">
      <button aria-expanded={open} onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-2 px-3.5 py-2.5 text-left">
        <span className="inline-flex" aria-hidden>{icon}</span>
        <span className="text-[13px] font-bold text-[var(--ink)]">{title}</span>
        {typeof count === 'number' && (
          <span className="rounded-full px-1.5 py-0.5 text-[10px] font-bold" style={{ color: lift(accent), background: tint(accent, 0.14) }}>
            {count}
          </span>
        )}
        <motion.span animate={{ rotate: open ? 90 : 0 }} className="ml-auto inline-flex text-[var(--muted)]">
          <ChevronIcon size={13} />
        </motion.span>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={COLLAPSE}
            className="overflow-hidden"
          >
            <div className="border-t border-[var(--line)] px-3.5 py-3">{children}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  if (children == null || children === '' || children === '—') return null
  return (
    <div className="flex gap-3 border-b border-[var(--line)] py-1.5 last:border-0">
      <span className="w-[120px] shrink-0 text-[11.5px] font-semibold text-[var(--muted)]">{label}</span>
      <span className="min-w-0 flex-1 text-[12.5px] text-[var(--ink-soft)]">{children}</span>
    </div>
  )
}

// Type/Priority/Status/Story points live in the header; Opened/Closed/Last update live in the
// Update log section; Fix versions moved to the header — so this grid holds the rest.
function OverviewGrid({ ticket }: { ticket: Ticket }) {
  // Derived from the status lifecycle already in updateLog. Shown for in-flight tickets too,
  // where the lead time is "so far" rather than final.
  const ct = cycleTime(ticket)
  const closed = !!ticket.resolved
  return (
    <div className="mb-3 rounded-xl border border-[var(--line)] bg-[var(--surface-solid)] px-3.5 py-2">
      {ct.measurable && (
        <Row label={closed ? 'Time to deliver' : 'Open for'}>
          <span className="tabular-nums">{fmtDays(ct.totalDays)}</span>
          {ct.devDays > 0 && (
            <span
              className="ml-2 text-[var(--muted)]"
              title={`${fmtDays(ct.progressDays)} in progress · ${fmtDays(ct.reviewDays)} in review`}
            >
              · <span className="font-semibold" style={{ color: lift('#8b5cf6') }}>{fmtDays(ct.devDays)}</span> dev
              <span className="text-[11px]">
                {' '}
                ({fmtDays(ct.progressDays)} progress, {fmtDays(ct.reviewDays)} review)
              </span>
            </span>
          )}
        </Row>
      )}
      <Row label="Sprint">{ticket.sprint}</Row>
      <Row label="Reporter">{ticket.reporter}</Row>
      <Row label="Assignee">{ticket.assignee}</Row>
      {ticket.epic?.key && (
        <Row label="Epic">
          <ExternalLink href={ticket.epic.url}>{ticket.epic.key}</ExternalLink>
          {ticket.epic.summary ? ` — ${ticket.epic.summary}` : ''}
        </Row>
      )}
      {ticket.labels && ticket.labels.length > 0 && (
        <Row label="Labels">
          <span className="flex flex-wrap gap-1.5">
            {ticket.labels.map((l) => (
              <Pill key={l}>{l}</Pill>
            ))}
          </span>
        </Row>
      )}
      {ticket.components && ticket.components.length > 0 && (
        <Row label="Components">
          <span className="flex flex-wrap gap-1.5">
            {ticket.components.map((c) => (
              <Pill key={c} color="#0ea5e9">{c}</Pill>
            ))}
          </span>
        </Row>
      )}
    </div>
  )
}

function AcceptanceChecklist({ storageKey, items, accent }: { storageKey: string; items: string[]; accent: string }) {
  // Persist ticks per ticket in localStorage so they survive both section collapse (which unmounts
  // this component) and a full reload. Length-matched to the current criteria; file:// may block
  // localStorage, so every access is guarded.
  const lsKey = `jb-ac:${storageKey}`
  const [checked, setChecked] = useState<boolean[]>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(lsKey) || '[]')
      if (Array.isArray(saved)) return items.map((_, i) => !!saved[i])
    } catch {
      /* ignore */
    }
    return items.map(() => false)
  })
  const setAndPersist = (updater: (c: boolean[]) => boolean[]) =>
    setChecked((c) => {
      const next = updater(c)
      try {
        localStorage.setItem(lsKey, JSON.stringify(next))
      } catch {
        /* file:// localStorage may be blocked */
      }
      return next
    })
  const done = checked.filter(Boolean).length
  const pct = Math.round((done / items.length) * 100)
  return (
    <div>
      <div className="mb-2 flex items-center gap-2">
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--surface-2)]">
          <motion.div className="h-full rounded-full" style={{ background: accent }} animate={{ width: `${pct}%` }} transition={{ type: 'spring', stiffness: 200, damping: 26 }} />
        </div>
        <span className="text-[11px] font-semibold tabular-nums text-[var(--muted)]">{done}/{items.length}</span>
      </div>
      <ul className="flex flex-col gap-1">
        {items.map((it, i) => (
          <li key={i}>
            <button
              onClick={() => setAndPersist((c) => c.map((v, j) => (j === i ? !v : v)))}
              className="flex w-full items-start gap-2 rounded-lg px-1.5 py-1 text-left hover:bg-[var(--surface-2)]"
            >
              <span
                className="mt-[2px] grid h-4 w-4 shrink-0 place-items-center rounded border text-[10px]"
                style={{
                  borderColor: checked[i] ? lift(accent) : 'var(--line-strong)',
                  background: checked[i] ? accent : 'transparent',
                  color: onFill(accent),
                }}
              >
                {checked[i] ? '✓' : ''}
              </span>
              <span className={`text-[13px] ${checked[i] ? 'text-[var(--muted)] line-through' : 'text-[var(--ink-soft)]'}`}>{it}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** Compact PR row: one wrap-line (state · #id link · approvals · comments · merged date) + a branch line. */
function PrRow({ pr }: { pr: PullRequest }) {
  const knownState = pr.state && pr.state !== 'none'
  const cs = prCommentStats(pr)
  const closed = isClosedPr(pr)
  const prHref = safeHref(pr.url)
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-[var(--line)] bg-[var(--surface-2)] px-3 py-2">
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 text-[11px]">
        {knownState ? <PrBadge state={pr.state} /> : <Pill color="#94a3b8">⊙ Pull request</Pill>}
        {pr.id != null &&
          (prHref ? (
            <a href={prHref} target="_blank" rel="noopener noreferrer" className="font-mono font-bold hover:underline" style={{ color: 'var(--pr-link)' }} title={prMeta(pr.state).label}>
              #{pr.id} ↗
            </a>
          ) : (
            <span className="font-mono font-bold" style={{ color: 'var(--pr-link)' }}>
              #{pr.id}
            </span>
          ))}
        {/* Dev info comes from Jira's index, so PRs for one ticket can sit in different
            repos (app, pipeline, infra) — the number alone doesn't identify them. */}
        {pr.repo && (
          <span className="rounded-md bg-[var(--surface-solid)] px-1.5 py-0.5 font-mono text-[10.5px] text-[var(--ink-soft)]" title="Repository">
            {pr.repo}
          </span>
        )}
        {pr.title && <span className="min-w-0 truncate text-[var(--muted)]">{pr.title}</span>}
        {!closed && <Approvals approvals={pr.approvals} />}
        {closed && typeof pr.approvals === 'number' && (
          <span className="font-semibold text-[#22c55e] dark:text-[#4ade80]">✓ {pr.approvals} approval{pr.approvals === 1 ? '' : 's'}</span>
        )}
        {cs && (
          <span className="text-[var(--muted)]">
            <b className="text-[var(--ink-soft)]">{cs.total}</b> comment{cs.total === 1 ? '' : 's'} · <b className="text-[var(--ink-soft)]">{cs.resolved}</b> resolved
          </span>
        )}
        {isMergedPr(pr) && pr.mergedAt && <span className="text-[var(--muted)]">merged {fmtDate(pr.mergedAt)}</span>}
      </div>
      {pr.reviewers && pr.reviewers.length > 0 && (
        <div className="flex flex-wrap items-center gap-1 text-[10.5px] text-[var(--muted)]">
          <PersonIcon size={11} />
          <span>Reviewers:</span>
          <span className="text-[var(--ink-soft)]">{pr.reviewers.join(', ')}</span>
        </div>
      )}
      {(pr.sourceBranch || pr.destinationBranch) && (
        <div className="break-all rounded-md bg-[var(--surface-solid)] px-2 py-1 font-mono text-[10.5px] text-[var(--ink-soft)]">
          {pr.sourceBranch} <span className="text-[var(--muted)]">→</span> {pr.destinationBranch || 'develop'}
        </div>
      )}
    </div>
  )
}

// Lifecycle rank used to order same-day events (and break ties): later stages sit higher.
const STATUS_RANK: Record<string, number> = {
  opened: 0,
  'ticket raised': 0,
  assigned: 0.5,
  'assigned to me': 0.5,
  open: 1,
  'to do': 1,
  todo: 1,
  backlog: 1,
  'in progress': 2,
  'work in progress': 2,
  'dev in progress': 2,
  development: 2,
  'in review': 3,
  'code review': 3,
  ready4review: 3,
  'ready for review': 3,
  review: 3,
  qa: 4,
  'in qa': 4,
  testing: 4,
  verification: 4,
  done: 5,
  completed: 5,
  closed: 5,
  resolved: 5,
}

/** Reduce a raw update-log entry to just the new status (no "Moved X → Y", no embedded date). */
function cleanLogEntry(e: { when?: string | null; text?: string | null }): { label: string; when: string | null } {
  let label = (e.text ?? '').trim()
  // strip a date the intern may have embedded in the text ("— 2025-11-26" / "(2025-11-26)")
  label = label
    .replace(/\s*[—–-]\s*\d{4}-\d{2}-\d{2}.*$/, '')
    .replace(/\s*\(\s*\d{4}-\d{2}-\d{2}\s*\)\s*$/, '')
    .trim()
  // "Moved X → Y" / "Moved X -> Y" / "Moved X to Y"  →  just Y
  const moved = label.match(/^moved\b.*?(?:→|->|»|\bto\b)\s+(.+)$/i)
  if (moved) label = moved[1].trim()
  if (/^marked\s+done/i.test(label)) label = 'Done'
  if (/^ticket\s+raised/i.test(label)) label = 'Opened'
  return { label, when: e.when ?? null }
}

/** Epoch ms for an update-log stamp; undated or unparseable entries sort after every dated one. */
function logTs(when: string | null): number {
  const ts = when ? Date.parse(when) : NaN
  return Number.isNaN(ts) ? -Infinity : ts
}

function Timeline({ entries, accent }: { entries: { when?: string | null; text?: string | null }[]; accent: string }) {
  // Clean → newest-first (latest, usually Done, on top; Opened at the bottom) → drop consecutive duplicates.
  // Dates are compared as instants, not strings, so "2025-11-26" and "2025-11-26T09:00:00Z" and
  // offsets like "+05:30" all order correctly.
  const ranked = entries
    .map(cleanLogEntry)
    .filter((e) => e.label)
    .map((e, i) => ({ ...e, ts: logTs(e.when), rank: STATUS_RANK[e.label.toLowerCase()] ?? -1, i }))
    .sort((a, b) => {
      if (a.ts !== b.ts) return b.ts - a.ts // newer instant first
      if (a.rank !== b.rank) return b.rank - a.rank // later lifecycle stage first within the same day
      return a.i - b.i
    })
  const log: typeof ranked = []
  for (const e of ranked) {
    if (log.length && log[log.length - 1].label.toLowerCase() === e.label.toLowerCase()) continue
    log.push(e)
  }
  return (
    <ul className="relative ml-1 flex flex-col gap-3 border-l-2 pl-4" style={{ borderColor: tint(accent, 0.3) }}>
      {log.map((e, i) => (
        <li key={i} className="relative">
          <span className="absolute -left-[21px] top-1 h-2.5 w-2.5 rounded-full ring-2 ring-[var(--bg)]" style={{ background: i === 0 ? accent : 'var(--muted)' }} />
          <div className={`text-[13px] ${i === 0 ? 'font-semibold text-[var(--ink)]' : 'text-[var(--ink-soft)]'}`}>{e.label}</div>
          {e.when && <div className="text-[10.5px] text-[var(--muted)]">{fmtDate(e.when)}</div>}
        </li>
      ))}
    </ul>
  )
}

function CommentItem({ c, now }: { c: Comment; now: number }) {
  return (
    <div className="rounded-lg border border-[var(--line)] bg-[var(--surface-2)] px-3 py-2">
      <div className="mb-1 flex items-center gap-2 text-[11px]">
        <span className="font-semibold text-[var(--ink)]">{c.author || 'Comment'}</span>
        {c.when && <span className="text-[var(--muted)]">{fmtDate(c.when)} · {relTime(c.when, now)}</span>}
      </div>
      <SafeHtml html={c.body} />
    </div>
  )
}

/** Richer rendering for Confluence / external references: title + extracted excerpt + url. */
// Decode entities the intern sometimes leaves in raw URLs (e.g. &amp; → &). A numeric entity
// outside the Unicode range (String.fromCodePoint throws above 0x10FFFF) is left as written.
const deEnt = (s: string) =>
  s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (entity: string, d: string) => {
      const cp = Number(d)
      return Number.isInteger(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : entity
    })

function RefCards({ items }: { items: LinkRef[] }) {
  return (
    <div className="flex flex-col gap-1.5">
      {items.map((l, i) => {
        const url = safeHref(l.url ? deEnt(l.url) : null) ?? null
        const rawTitle = l.title || l.key
        const hasTitle = !!rawTitle && rawTitle !== l.url
        // With a real title → show it (link) + the URL as a small subtitle. Without one
        // → show ONLY the URL (protocol stripped), truncated, so it never overflows or repeats.
        const label = hasTitle ? deEnt(rawTitle!) : url ? url.replace(/^https?:\/\//, '') : ''
        return (
          <div key={i} className="rounded-lg border border-[var(--line)] bg-[var(--surface-2)] px-3 py-2">
            <div className="flex min-w-0 items-center gap-2">
              {url ? (
                <a
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={url}
                  className="flex min-w-0 flex-1 items-center gap-1 text-[12.5px] font-medium hover:underline"
                  style={{ color: 'var(--link)' }}
                >
                  <span className="min-w-0 truncate">{label}</span>
                  <span className="shrink-0 opacity-70">↗</span>
                </a>
              ) : (
                <span className="min-w-0 flex-1 truncate font-medium text-[var(--ink)]">{label}</span>
              )}
              {l.reachable === false && <Pill color="#ef4444">unreachable</Pill>}
            </div>
            {(l.excerpt || l.summary) && (
              <p className="mt-1 text-[12px] leading-relaxed text-[var(--ink-soft)]">{l.excerpt || l.summary}</p>
            )}
            {hasTitle && url && <div className="mt-0.5 truncate font-mono text-[10px] text-[var(--muted)]">{url}</div>}
          </div>
        )
      })}
    </div>
  )
}

/** Parent → sub-task tree, preserving the hierarchy with indented connector lines. */
type UserRef = { name?: string | null; accountId?: string | null } | null | undefined

function SubtaskTree({ root, onOpen, user }: { root: Ticket; onOpen?: (key: string) => void; user?: UserRef }) {
  return (
    <div className="flex flex-col gap-1.5">
      <TreeRow node={root} onOpen={onOpen} user={user} isRoot />
    </div>
  )
}

function TreeRow({ node, onOpen, isRoot = false, user }: { node: Ticket; onOpen?: (key: string) => void; isRoot?: boolean; user?: UserRef }) {
  const accent = COLUMN_META[node.column]?.accent ?? '#64748b'
  const kids = node.subtasks ?? []
  // For sub-tasks owned by someone else, surface who's on it (those are fetched light, by design).
  const showAssignee = !isRoot && !!node.assignee && !isAssignedToMe(node.assignee, user)
  // Review state at a glance — a master ticket's real progress lives in its sub-tasks' PRs,
  // often spread across repos, so every review is listed and linked rather than just the first.
  const nodePrs = isRoot ? [] : prListOf(node).filter((p) => p.state && p.state !== 'none')
  const nodeBranches = branchesOf(node)
  const label = (
    <>
      <TypeIcon type={effectiveType(node)} color={lift(typeMeta(effectiveType(node)).color)} size={12} />
      <span className="shrink-0 font-mono text-[11px] font-bold" style={{ color: lift(accent) }}>
        {node.key}
      </span>
      <span className="min-w-0 flex-1 truncate text-[12.5px] text-[var(--ink)]">{node.title}</span>
    </>
  )
  const meta = (
    <>
      {showAssignee && (
        <span
          className="hidden shrink-0 items-center gap-1 rounded-full border border-[var(--line)] px-1.5 py-0.5 text-[10px] text-[var(--muted)] sm:inline-flex"
          title={`Assigned to ${node.assignee}`}
        >
          <PersonIcon size={10} /> {node.assignee}
        </span>
      )}
      {!isRoot && nodeBranches.length > 0 && (
        <span className="hidden shrink-0 items-center gap-1 text-[10px] text-[var(--muted)] md:inline-flex" title={nodeBranches.join('\n')}>
          <BranchIcon size={10} /> {nodeBranches.length}
        </span>
      )}
      {nodePrs.map((p, i) => (
        <span key={i} className="hidden shrink-0 items-center gap-1 sm:inline-flex">
          <PrBadge state={p.state} />
          {safeHref(p.url) && (
            <a
              href={safeHref(p.url)}
              target="_blank"
              rel="noopener noreferrer"
              className="font-mono text-[10px] font-bold hover:underline"
              style={{ color: 'var(--pr-link)' }}
              title={[p.repo, p.title].filter(Boolean).join(' — ')}
            >
              #{p.id}
            </a>
          )}
        </span>
      ))}
      {isRoot ? (
        <span className="shrink-0 rounded-full border border-[var(--line)] px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-wide text-[var(--muted)]">this ticket</span>
      ) : (
        <StatusBadge column={node.column} label={node.status} />
      )}
    </>
  )
  return (
    <div>
      {/* The PR links must stay real anchors, so the row is a flex container with a button
          for the ticket itself rather than one big button wrapping everything. */}
      <div
        className={`flex items-center gap-2 rounded-lg px-2.5 py-1.5 ${
          isRoot ? 'bg-[var(--surface-2)]' : 'glass-interactive border border-[var(--line)] bg-[var(--surface-2)] transition-colors hover:border-[var(--muted)]'
        }`}
      >
        {isRoot ? (
          <div className="flex min-w-0 flex-1 items-center gap-2">{label}</div>
        ) : (
          <button onClick={() => onOpen?.(node.key)} className="flex min-w-0 flex-1 items-center gap-2 text-left" title="Open sub-ticket details">
            {label}
          </button>
        )}
        {meta}
      </div>
      {kids.length > 0 && (
        <div className="ml-3 mt-1.5 flex flex-col gap-1.5 border-l-2 pl-3" style={{ borderColor: tint(accent, 0.3) }}>
          {kids.map((k) => (
            <TreeRow key={k.key} node={k} onOpen={onOpen} user={user} />
          ))}
        </div>
      )}
    </div>
  )
}

function LinkList({ items }: { items: LinkRef[] }) {
  return (
    <ul className="flex flex-col gap-1.5">
      {items.map((l, i) => (
        <li key={i} className="flex flex-wrap items-center gap-2 text-[12.5px]">
          {l.key || l.url ? <ExternalLink href={l.url}>{l.key || l.title || l.url}</ExternalLink> : <span className="font-medium text-[var(--ink)]">{l.title}</span>}
          {l.summary && <span className="text-[var(--ink-soft)]">— {l.summary}</span>}
          {l.excerpt && <span className="w-full text-[var(--muted)]">{l.excerpt}</span>}
          {l.status && <Pill>{l.status}</Pill>}
          {l.relation && <span className="text-[11px] italic text-[var(--muted)]">{l.relation}</span>}
          {l.reachable === false && <Pill color="#ef4444">unreachable</Pill>}
        </li>
      ))}
    </ul>
  )
}
