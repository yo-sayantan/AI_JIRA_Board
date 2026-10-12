import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import type { ColumnKey } from './types'
import type { MoveTarget } from './lib/columns'
import { RUN_COMMAND, aiModelLabel, enrichJobsRunning, isServed, setDemoMode, testApiKey } from './lib/runner'
import { countMyCompleted, countRaised, countTicketsWithPr, dashboardPrTickets, hasActiveWork, indexByKey, splitBoard, type BoardSections } from './lib/boardView'
import { parseQuery } from './lib/search'
import { useBoardData } from './hooks/useBoardData'
import { useBoardSettings } from './hooks/useBoardSettings'
import { useClock } from './hooks/useClock'
import { useDrawerStack } from './hooks/useDrawerStack'
import { useInternJobs } from './hooks/useInternJobs'
import { useInternStatus } from './hooks/useInternStatus'
import { useScrollLock, useShortcuts } from './hooks/usePageEffects'
import { useReports } from './hooks/useReports'
import { useTicketMoves } from './hooks/useTicketMoves'
import { useToasts, type ToastFn } from './hooks/useToasts'
import { Header } from './components/header/Header'
import type { ReportsMenuProps } from './components/header/ReportsMenu'
import { Stats, type StatSelection } from './components/board/Stats'
import { Board } from './components/board/Board'
import { ArchivedUndo, DemoBanner, NoMatches } from './components/board/BoardNotices'
import { EmptyState } from './components/board/EmptyState'
import { FunEmptyBoard } from './components/board/FunEmptyBoard'
import { CompletedOverlay } from './components/completed/Completed'
import { RaisedOverlay } from './components/raised/Raised'
import { TicketDetail } from './components/ticket/TicketDetail'
import { PrReportOverlay } from './components/reports/PrReport'
import { SettingsPanel } from './components/settings/Settings'
import { ApiKeysDialog } from './components/keys/ApiKeys'
import { useApiKeys } from './hooks/useApiKeys'
import { useKeyHealth } from './hooks/useKeyHealth'
import { keysBadge, missingRequired, visibleHealth } from './lib/apiKeys'
import { Toasts } from './components/common/Toast'
import { NoticesDock } from './components/common/NoticesDock'
import { Footer } from './components/common/Footer'
import { ErrorBoundary } from './components/common/ErrorBoundary'

const served = isServed()

export default function App() {
  const now = useClock()
  // Settings and toasts need each other (toast sizing comes from settings; a settings save may
  // announce the Ollama container starting/stopping), so the announcement goes through a ref.
  const toastRef = useRef<ToastFn | null>(null)
  const { settings, setSettings, ready: settingsReady, dark, toggleTheme, saveFailed } = useBoardSettings(served, now, (action) =>
    toastRef.current?.(
      action === 'starting'
        ? 'Starting the AI-Ollama container…'
        : action === 'stopping'
          ? 'Stopping the AI-Ollama container.'
          : 'AI-Ollama stays off: put a model in jira-intern/models/ first (pull one, or drop a .gguf there).',
      action === 'no-models' ? 'error' : 'info',
    ),
  )
  const { features } = settings
  // Demo mode: a sample board, and every call that would reach Jira or the AI intern switched
  // off. Set during render, not in an effect, so no fetch can slip out before the flag lands.
  const demo = features.demoMode
  setDemoMode(demo)
  const { toasts, toast, dismiss, clear: clearToasts } = useToasts(settings.toastSeconds, settings.toastMax)
  toastRef.current = toast
  const { data, source, userArchived, reload, archive, restoreArchived, resetDemo } = useBoardData(served, (m) => toast(m, 'error'), demo)
  const jobs = useInternJobs({ served, toast, dismiss, reload, demo })
  const moves = useTicketMoves({ served, toast, refreshTicket: jobs.refreshTicket, demo })
  const exitDemo = useCallback(() => setSettings((s) => ({ ...s, features: { ...s.features, demoMode: false } })), [setSettings])
  // Moves made on one board mean nothing on the other: entering or leaving Demo mode starts clean.
  const resetMoves = moves.reset
  useEffect(() => resetMoves(), [demo, resetMoves])

  const [settingsOpen, setSettingsOpen] = useState(false)
  const [keysOpen, setKeysOpen] = useState(false)
  const apiKeys = useApiKeys(served)
  const keysMissing = missingRequired(apiKeys.status).length > 0
  // The latest real outcome per service (any call, anywhere): the dialog's dots and the key button's badge.
  const keyHealth = useKeyHealth(served, keysOpen, demo)
  const keyHealthShown = useMemo(() => visibleHealth(keyHealth.health, apiKeys.status, demo), [keyHealth.health, apiKeys.status, demo])
  const keyBadge = useMemo(() => keysBadge(keyHealthShown), [keyHealthShown])
  const refreshKeyHealth = keyHealth.refresh
  const testKey = useCallback(
    async (service: string) => {
      const result = await testApiKey(service)
      void refreshKeyHealth() // the server just recorded this test; show it at once
      return result
    },
    [refreshKeyHealth],
  )
  const [completedOpen, setCompletedOpen] = useState(false)
  const [raisedOpen, setRaisedOpen] = useState(false)
  const [query, setQuery] = useState('')
  // One selection drives the chip row: a column filters the board; null is "All" (the default).
  const [sel, setSel] = useState<StatSelection>(null)
  // Settings → Board sections: which optional parts of the board are shown. A switched-off one is gone —
  // its tickets are not on the board, not counted, and a chip focused on it falls back to the whole board.
  const sections = useMemo<BoardSections>(
    () => ({ blocked: features.blocked, onHold: features.onHold, qaInProgress: features.qaInProgress }),
    [features.blocked, features.onHold, features.qaInProgress],
  )
  const focus: ColumnKey | null = sel === 'blocked' && !features.blocked ? null : sel

  const status = useInternStatus(served, features.autoRefresh || settingsOpen || jobs.running != null)
  // Settings → Features → AI off: the intern's state, model and "working" lines disappear from the report menu, the report
  // drawer and Settings along with the briefs (the server stops every AI job; this stops the board showing any of it).
  const ai = settings.aiEnabled ? (status?.ai ?? null) : null
  const reports = useReports({ served, enabled: features.prReports, status, toast, demo })

  const byKey = useMemo(() => indexByKey(data), [data])
  // Dropped cards show in their new column at once; Jira confirms (or refuses) in the background.
  const boardTickets = useMemo(() => moves.applyOverrides(data.tickets), [moves, data.tickets])
  const drawers = useDrawerStack(byKey)
  // Demo mode → Reset: every card back where the sample board starts, hand-archived ones restored,
  // and the old Undo toasts gone (they would undo moves that no longer exist).
  const demoChanges = moves.moved + userArchived.length
  const resetDemoBoard = useCallback(() => {
    clearToasts()
    moves.reset()
    resetDemo()
    drawers.closeAll()
    toast('Demo board reset — every ticket is back where it started.', 'success')
  }, [clearToasts, moves, resetDemo, drawers.closeAll, toast])
  useScrollLock(drawers.open || completedOpen || raisedOpen || settingsOpen || keysOpen || !!reports.openReport)
  useShortcuts(features.shortcuts && !drawers.open && !completedOpen && !raisedOpen && !settingsOpen && !keysOpen && !reports.openReport, jobs.refreshBoard)

  useEffect(() => {
    if (saveFailed) toast('Settings did not reach the server — your changes are saved in this browser only.', 'error')
  }, [saveFailed, toast])

  const terms = useMemo(() => parseQuery(query), [query])
  const view = useMemo(() => splitBoard(boardTickets, terms, now, sections), [boardTickets, terms, now, sections])
  // A drop judges "from" by the card AS DISPLAYED — moved by an earlier drop (its pin) or folded into
  // To Do (Settings → On Hold off) — not by the dump: dragging a card straight back is then a real
  // move, and dropping a card where it already shows is a no-op instead of a Jira transition.
  const shownByKey = useMemo(() => new Map([...view.board, ...view.hold, ...view.nextSprint].map((t) => [t.key, t] as const)), [view])
  const moveTicket = useCallback(
    (key: string, to: MoveTarget, force = false) => {
      const t = shownByKey.get(key) ?? byKey.get(key)
      if (t) void moves.moveTicket(t, to, { forceAsk: force, lookup: byKey })
    },
    [shownByKey, byKey, moves],
  )
  // Chip counts: everything on the board — On Hold and Next Sprint are spaces inside Blocked and To Do.
  const statTickets = useMemo(() => [...view.board, ...view.hold, ...(features.nextSprint ? view.nextSprint : [])], [view, features.nextSprint])
  const hasAnyActive = useMemo(() => hasActiveWork(data.tickets, now), [data.tickets, now])
  const myCompletedCount = useMemo(() => countMyCompleted(data), [data])
  const raisedCount = useMemo(() => countRaised(data), [data])
  const ticketsWithPr = useMemo(() => countTicketsWithPr(data), [data])
  const boardWithPr = useMemo(() => dashboardPrTickets(data.tickets), [data.tickets])
  const doneOnBoard = useMemo(() => new Set(data.tickets.filter((t) => t.column === 'done').map((t) => t.key)), [data.tickets])
  const refreshing = jobs.running === 'daily'
  const archiveRefreshing = jobs.running === 'archive'

  const refreshedOnOpen = useRef(false)
  useEffect(() => {
    if (!served || demo || !features.reloadActive || refreshedOnOpen.current) return
    refreshedOnOpen.current = true
    void jobs.refreshBoard()
  }, [demo, features.reloadActive, jobs.refreshBoard])

  const archiveTicket = useCallback(
    (key: string) => {
      archive(key)
      toast(`${key} moved to Completed`, 'success')
    },
    [archive, toast],
  )
  const archiveAndClose = useCallback(
    (key: string) => {
      archiveTicket(key)
      drawers.closeAll()
    },
    [archiveTicket, drawers.closeAll],
  )
  const openSettings = useCallback(() => {
    if (settingsReady) setSettingsOpen(true)
    else toast('Loading saved settings…', 'loading')
  }, [settingsReady, toast])
  const closeSettings = useCallback(() => setSettingsOpen(false), [])
  const openKeys = useCallback(() => setKeysOpen(true), [])
  const closeKeys = useCallback(() => setKeysOpen(false), [])
  // Rendered in both returns below at the same position (right after the first child), so React
  // keeps its state when a first fetch turns the empty state into the board.
  const keysDialog = (
    <ErrorBoundary label="API keys" overlay onClose={closeKeys}>
      <ApiKeysDialog open={keysOpen} status={apiKeys.status} failed={apiKeys.failed} onClose={closeKeys} onRefresh={apiKeys.refresh} onSave={apiKeys.save} onTest={testKey} health={keyHealthShown} lastFetch={data.proofSources} />
    </ErrorBoundary>
  )
  const openCompleted = useCallback(() => setCompletedOpen(true), [])
  const closeCompleted = useCallback(() => setCompletedOpen(false), [])
  const openRaised = useCallback(() => setRaisedOpen(true), [])
  const closeRaised = useCallback(() => setRaisedOpen(false), [])
  const clearSearch = useCallback(() => {
    setQuery('')
    setSel(null)
  }, [])

  const reportsMenu = useMemo<ReportsMenuProps | undefined>(
    () =>
      features.prReports
        ? {
            served,
            generating: reports.working,
            withPrCount: ticketsWithPr,
            reportCount: Object.keys(reports.index?.reports ?? {}).length,
            board: boardWithPr,
            onBulk: reports.generateBulk,
            onOne: reports.generateOne,
            onStop: reports.stopAll,
            runningCount: enrichJobsRunning(ai),
            modelLabel: aiModelLabel(ai),
          }
        : undefined,
    [features.prReports, reports.working, reports.index, reports.generateBulk, reports.generateOne, reports.stopAll, ticketsWithPr, boardWithPr, ai],
  )

  if (source === 'empty') {
    return (
      <div className="w-full px-4 pb-24 md:px-6 lg:px-8">
        <EmptyState
          served={served}
          refreshing={refreshing}
          onRefresh={jobs.refreshBoard}
          runCommand={RUN_COMMAND}
          onOpenKeys={served ? openKeys : undefined}
          keysMissing={keysMissing}
        />
        {keysDialog}
        <Footer />
        <Toasts toasts={toasts} onDismiss={dismiss} />
      </div>
    )
  }

  return (
    <div className="w-full px-4 pb-24 md:px-6 lg:px-8">
      <Header
        data={data}
        now={now}
        query={query}
        setQuery={setQuery}
        dark={dark}
        toggleTheme={toggleTheme}
        refreshing={refreshing}
        archiveRefreshing={archiveRefreshing}
        archiveParallel={settings.archiveParallel}
        runProgress={jobs.progress}
        served={served}
        onRefresh={jobs.refreshBoard}
        shortcuts={features.shortcuts}
        onArchiveRefresh={jobs.rebuildArchive}
        onStopArchive={jobs.stopArchive}
        onOpenSettings={openSettings}
        onOpenKeys={served ? openKeys : undefined}
        keysMissing={keysMissing}
        keysBadge={keyBadge}
        reports={reportsMenu}
      />
      {keysDialog}

      <ErrorBoundary label="Settings" overlay onClose={closeSettings}>
        <SettingsPanel open={settingsOpen} settings={settings} onChange={setSettings} onClose={closeSettings} aiLevelSynced={served} aiStatus={status?.ai ?? null} />
      </ErrorBoundary>

      {/* Counts follow the search. The Completed chip counts MY tickets only, like the archive's default scope. */}
      {demo && <DemoBanner onExit={exitDemo} onReset={resetDemoBoard} changes={demoChanges} />}

      <Stats
        tickets={statTickets}
        hideBlocked={!features.blocked}
        completedCount={features.completedArchive ? myCompletedCount : null}
        raisedCount={features.raisedTickets && raisedCount.total > 0 ? raisedCount : null}
        active={sel}
        onSelect={setSel}
        onOpenCompleted={features.completedArchive ? openCompleted : undefined}
        onOpenRaised={features.raisedTickets ? openRaised : undefined}
      />

      {!hasAnyActive ? (
        <FunEmptyBoard
          served={served}
          refreshing={refreshing}
          onRefresh={jobs.refreshBoard}
          archivedCount={userArchived.length}
          archivedKeys={userArchived}
          onUndo={restoreArchived}
        />
      ) : view.matched.length === 0 && terms.length > 0 ? (
        // A search that only hits On Hold (under Blocked) or Next Sprint (under To Do) still shows them.
        <NoMatches query={query} onClear={clearSearch} />
      ) : (
        <Board
          tickets={view.board}
          now={now}
          onOpen={drawers.openTicket}
          focus={focus}
          onArchive={archiveTicket}
          onRefreshTicket={jobs.refreshTicket}
          refreshingKeys={jobs.refreshingKeys}
          onMove={features.dragMove ? moveTicket : undefined}
          movingKeys={moves.movingKeys}
          bottomOrder={moves.bottomOrder}
          lookup={byKey}
          readiness={features.dragMove && features.moveReadiness}
          held={features.onHold ? view.hold : undefined}
          nextSprint={features.nextSprint ? view.nextSprint : undefined}
          sections={sections}
        />
      )}

      {hasAnyActive && userArchived.length > 0 && <ArchivedUndo keys={userArchived} onUndo={restoreArchived} />}

      <Footer />

      {/* Shared backdrop behind the whole drawer stack; click it to dismiss everything. */}
      <AnimatePresence>
        {drawers.open && (
          <motion.div
            key="jb-scrim"
            className="fixed inset-0 z-[46] bg-black/55 backdrop-blur-sm"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={drawers.closeAll}
          />
        )}
      </AnimatePresence>

      <ErrorBoundary label="the ticket drawer" overlay onClose={drawers.closeAll}>
        <AnimatePresence>
          {drawers.stack.map((key, i) => {
            const t = byKey.get(key)
            return t ? (
              <TicketDetail
                key={`${i}:${key}`}
                ticket={t}
                now={now}
                depth={i}
                topDepth={drawers.stack.length - 1}
                onClose={drawers.goBack}
                onJumpTo={() => drawers.jumpTo(i)}
                onOpen={drawers.pushTicket}
                // Only a Done ticket still on the board can move to Completed; archive rows already live there.
                onArchive={doneOnBoard.has(key) ? archiveAndClose : undefined}
                onRefreshTicket={jobs.refreshTicket}
                refreshing={jobs.refreshingKeys.has(t.key)}
                user={data.user}
                report={features.prReports ? (reports.index?.reports[t.key] ?? null) : null}
                reportsEnabled={features.prReports}
                briefsEnabled={features.aiBriefs && settings.aiEnabled}
                reportGenerating={reports.generating.has(t.key)}
                reportLoading={reports.loadingKey === t.key}
                onOpenReport={reports.openReportFor}
                onGenerateReport={reports.generateOne}
                served={served}
              />
            ) : null
          })}
        </AnimatePresence>
      </ErrorBoundary>

      <ErrorBoundary label="the Completed archive" overlay onClose={closeCompleted}>
        <CompletedOverlay open={completedOpen} onClose={closeCompleted} items={data.completed} onOpen={drawers.openTicket} pauseEsc={drawers.open} />
      </ErrorBoundary>

      <ErrorBoundary label="Raised by me" overlay onClose={closeRaised}>
        <RaisedOverlay
          open={raisedOpen}
          onClose={closeRaised}
          items={data.raised ?? []}
          onOpen={drawers.openTicket}
          user={data.user}
          onRefresh={served ? jobs.refreshRaised : undefined}
          refreshing={jobs.running === 'raised'}
          fetchedAt={data.raisedAt ?? null}
          briefsEnabled={features.aiBriefs && settings.aiEnabled}
          pauseEsc={drawers.open}
        />
      </ErrorBoundary>

      <ErrorBoundary label="the report" overlay onClose={reports.closeReport}>
        <PrReportOverlay
          report={reports.openReport}
          onClose={reports.closeReport}
          onRegenerate={served ? reports.generateOne : undefined}
          generating={reports.openReport ? reports.generating.has(reports.openReport.key) : false}
          internStatus={ai}
        />
      </ErrorBoundary>

      <NoticesDock notes={data.notes ?? []} seconds={settings.toastSeconds} />
      <Toasts toasts={toasts} onDismiss={dismiss} />
    </div>
  )
}
