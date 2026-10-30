# Board Shell UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the main Jira board shell as a quiet, neutral operations console while preserving all board behavior.

**Architecture:** Keep the existing React state and data flow intact. Apply the redesign at component boundaries (`Header`, `Stats`, `Board`, `Column`, `TicketCard`) and use narrowly scoped CSS classes so drawers, dialogs, reports, and archive views retain their current presentation. Preserve Motion only for functional spatial changes such as drag layout; remove decorative shell animation.

**Tech Stack:** React 19, TypeScript 7, Tailwind CSS 4, Motion 14, Vitest with jsdom, Python `unittest`, Vite 8.

## Global Constraints

- Apply the requested guidance in this order: `unslop-ui`, `frontend-patterns`, `frontend-design-direction`, `frontend-a11y`.
- Before changing animation code, read and apply `.claude/skills/apple-design/SKILL.md` and `.claude/skills/animate/SKILL.md`.
- Do not add dependencies.
- Do not change board data, sorting, move rules, server APIs, persistence, drawers, dialogs, reports, or archive behavior.
- Neutral surfaces must dominate; semantic lane color is limited to markers, counts, selected states, and drag targets.
- Add no decorative entrance or hover transform animation.
- Existing necessary motion must honor `prefers-reduced-motion` and `.jb-no-anim`.
- Keep the app-shell scroll model: only `.jb-board-scroll` scrolls at normal viewport heights.
- Preserve `file://` behavior.
- Standalone icon controls must reach 44-by-44 CSS pixels at touch breakpoints.
- The shell must remain usable at 320 CSS pixels and 200% text zoom.
- Run `npm run build` before every commit and stage files by explicit path.

---

### Task 1: Neutral Header and Accessible Search

**Files:**
- Create: `src/components/header/Header.test.ts`
- Modify: `src/components/header/Header.tsx:1-393`
- Modify: `src/styles/index.css:20-168`
- Modify: `src/styles/glass.css:140-215`

**Interfaces:**
- Consumes: existing `Header` props and the existing icon set.
- Produces: `.jb-board-header`, `.jb-primary-action`, and `.jb-icon-action` shell classes; a connected `label[for="jb-search"]`; a `Clear search` action; polite refresh status.

- [ ] **Step 1: Read the repository-required motion guidance**

Read:

```text
.claude/skills/apple-design/SKILL.md
.claude/skills/animate/SKILL.md
```

Confirm that the implementation removes decorative header entrance, hover-lift, glow, and shimmer while retaining progress feedback.

- [ ] **Step 2: Write the failing header accessibility tests**

Create `src/components/header/Header.test.ts`:

```tsx
// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Header } from './Header'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement | null = null
let root: ReturnType<typeof createRoot> | null = null

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  host = root = null
})

function mount(overrides: Record<string, unknown> = {}) {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  const setQuery = vi.fn()
  act(() =>
    root!.render(
      createElement(Header, {
        data: { tickets: [], completed: [], generatedAt: '2026-10-30T10:00:00Z', user: { name: 'Doe, Alex' } },
        now: Date.parse('2026-10-30T11:00:00Z'),
        query: 'fraud',
        setQuery,
        dark: false,
        toggleTheme: () => {},
        refreshing: false,
        archiveRefreshing: false,
        archiveParallel: 1,
        served: false,
        onRefresh: () => {},
        onArchiveRefresh: () => {},
        onStopArchive: () => {},
        ...overrides,
      }),
    ),
  )
  return { host, setQuery }
}

describe('Header accessibility', () => {
  it('connects a visible-to-AT label to search and names the clear action', () => {
    const { host, setQuery } = mount()
    expect(host.querySelector('label[for="jb-search"]')?.textContent).toContain('Search tickets')
    const clear = host.querySelector('button[aria-label="Clear search"]') as HTMLButtonElement
    act(() => clear.click())
    expect(setQuery).toHaveBeenCalledWith('')
  })

  it('exposes refresh progress through one polite live region', () => {
    const { host } = mount({
      refreshing: true,
      runProgress: { done: 2, total: 5, pct: 40, phase: 'building' },
    })
    const status = host.querySelector('[role="status"][aria-live="polite"]')
    expect(status?.textContent).toMatch(/2\/5.*40%/)
  })
})
```

- [ ] **Step 3: Run the header test and verify the new expectations fail**

Run:

```bash
npx vitest run --config tooling/vitest.config.ts src/components/header/Header.test.ts
```

Expected: FAIL because there is no connected `Search tickets` label, the clear button is named `Clear`, and no polite live region exists.

- [ ] **Step 4: Simplify the header implementation**

In `Header.tsx`:

- Replace the animated gradient logo container with a plain inline icon.
- Replace the gradient heading with plain text.
- Remove `gradient` and `shadow` from `ProgressButton`.
- Remove shimmer, glowing progress edge, text shadow, hover lift, and colored shadow.
- Add a stable class to the header and its control groups.
- Keep refresh progress as a solid blue fill.
- Add the connected search label and rename the clear button.
- Add a polite live region that mirrors the progress label.

Replace the current animated logo-and-title block with this exact identity block:

```tsx
<div className="flex min-w-0 items-center gap-2">
  <TicketGlyph size={18} />
  <div className="min-w-0 leading-tight">
    <h1 className="truncate text-[16px] font-bold tracking-tight text-[var(--ink)]">My Jira Board</h1>
    <span className="block truncate text-[11.5px] text-[var(--muted)]">{name}</span>
  </div>
</div>
```

Set the outer element to:

```tsx
<header className="jb-board-header sticky top-0 z-30 mb-3 border-b border-[var(--line)] bg-[var(--surface-solid)] px-1 py-3 md:px-2">
```

Keep the existing freshness and sprint content, but remove their tinted backgrounds and colored borders by using `border-[var(--line)] bg-transparent`.

Use this search markup:

```tsx
<div className="jb-search min-w-[12rem] flex-1 md:max-w-[24rem]">
  <label htmlFor="jb-search" className="sr-only">Search tickets</label>
  <div className="flex h-9 items-center gap-2 rounded-lg border border-[var(--line)] bg-[var(--surface-solid)] px-3">
    <SearchIcon size={14} />
    <input
      id="jb-search"
      value={query}
      onChange={(event) => setQuery(event.target.value)}
      type="search"
      placeholder={shortcuts ? 'Search tickets  /' : 'Search tickets'}
      className="min-w-0 flex-1 bg-transparent text-[13px] text-[var(--ink)] outline-none placeholder:text-[var(--muted)]"
    />
    {query && (
      <button type="button" onClick={() => setQuery('')} aria-label="Clear search" className="text-[var(--muted)] hover:text-[var(--ink)]">
        <span aria-hidden>×</span>
      </button>
    )}
  </div>
</div>
```

Render this inside `ProgressButton` after the visible label:

```tsx
<span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
  {busy ? label : ''}
</span>
```

Use a solid action class:

```tsx
className="jb-primary-action relative inline-flex h-9 w-[148px] shrink-0 items-center justify-center gap-1.5 overflow-hidden rounded-lg px-3 text-[13px] font-semibold"
```

- [ ] **Step 5: Scope the shell out of Liquid Glass and add restrained tokens**

In `index.css`, define:

```css
:root,
.light {
  --primary: #155eef;
  --primary-hover: #0b4fd4;
  --primary-contrast: #ffffff;
}

.dark {
  --primary: #4f8cff;
  --primary-hover: #6da0ff;
  --primary-contrast: #07101f;
}

body {
  background: var(--bg);
}

.jb-primary-action {
  background: var(--primary);
  color: var(--primary-contrast);
}

.jb-primary-action:not(:disabled):hover {
  background: var(--primary-hover);
}

.jb-icon-action {
  display: inline-grid;
  height: 2.25rem;
  width: 2.25rem;
  place-items: center;
  border: 1px solid var(--line);
  border-radius: 0.5rem;
  background: var(--surface-solid);
  color: var(--ink-soft);
}

.jb-icon-action:hover {
  border-color: var(--line-strong);
  color: var(--ink);
}

.jb-search:focus-within > div {
  border-color: var(--link);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--link) 18%, transparent);
}
```

In `glass.css`, add a board-header opt-out after the bar rules:

```css
.jb-board-header {
  -webkit-backdrop-filter: none;
  backdrop-filter: none;
  background-color: var(--surface-solid);
  background-image: none;
  box-shadow: none;
}

.jb-board-header::before {
  display: none;
}
```

- [ ] **Step 6: Run the focused test and typecheck**

Run:

```bash
npx vitest run --config tooling/vitest.config.ts src/components/header/Header.test.ts
npm run typecheck
```

Expected: both commands PASS.

- [ ] **Step 7: Build and commit Task 1**

Run:

```bash
npm run build
git add src/components/header/Header.tsx src/components/header/Header.test.ts src/styles/index.css src/styles/glass.css
git diff --cached --check
git commit -m "feat(ui): simplify the board header"
```

Expected: build succeeds and the commit contains only the four named files.

---

### Task 2: Semantic Board and Destination Toolbars

**Files:**
- Modify: `src/components/board/Stats.tsx:1-166`
- Modify: `src/components/board/Stats.test.ts:20-81`
- Modify: `src/App.tsx:240-338`
- Modify: `src/styles/index.css`

**Interfaces:**
- Consumes: existing `StatSelection`, counts, and open callbacks.
- Produces: `role="toolbar"` groups named `Board filters` and `Board destinations`; plain counts; no main-board footer.

- [ ] **Step 1: Write failing toolbar semantics tests**

Add to `Stats.test.ts`:

```tsx
it('separates board filters from destination actions with accessible names', () => {
  const el = mountWith({
    raisedCount: { total: 8, open: 3 },
    takenCount: { total: 2, worked: 1 },
  })
  const toolbars = [...el.querySelectorAll('[role="toolbar"]')]
  expect(toolbars.map((bar) => bar.getAttribute('aria-label'))).toEqual([
    'Board filters',
    'Board destinations',
  ])
  const filters = [...toolbars[0].querySelectorAll('button')]
  expect(filters.every((button) => button.hasAttribute('aria-pressed'))).toBe(true)
  const destinations = [...toolbars[1].querySelectorAll('button')]
  expect(destinations.every((button) => !button.hasAttribute('aria-pressed'))).toBe(true)
})
```

Update the existing selected-filter test:

```tsx
expect(todo.getAttribute('aria-pressed')).toBe('true')
```

- [ ] **Step 2: Run the Stats test and verify it fails**

Run:

```bash
npx vitest run --config tooling/vitest.config.ts src/components/board/Stats.test.ts
```

Expected: FAIL because the current root is an unlabeled `div`, destination controls are not grouped as a toolbar, and column filters lack `aria-pressed`.

- [ ] **Step 3: Replace animated chips with semantic toolbar buttons**

In `Stats.tsx`:

- Remove `useEffect`, `useState`, `motion`, `useSpring`, `PRESS`, and `PRESS_SCALE`.
- Delete `AnimatedNumber`; render plain tabular counts.
- Use one horizontally scrollable shell containing two labeled toolbars.
- Use native `<button type="button">` for every control.
- Add `aria-pressed={isActive}` to every board filter.
- Replace the gold Completed treatment with the same quiet destination-button anatomy.
- Keep semantic accent as a dot, count, and selected outline only.

Wrap the existing All/column controls in `<div role="toolbar" aria-label="Board filters" className="flex min-w-max items-center gap-1.5">`. Wrap the existing Raised/Taken/Completed controls in `<div role="toolbar" aria-label="Board destinations" className="ml-auto flex min-w-max items-center gap-1.5 border-l border-[var(--line)] pl-3">`. Place both inside `<nav className="jb-board-tools mb-3 flex min-w-0 items-center gap-3" aria-label="Board controls">`.

Use this common filter anatomy:

```tsx
<button
  type="button"
  aria-pressed={isActive}
  onClick={() => onSelect(isActive ? null : c.key)}
  className="jb-filter-button inline-flex h-8 items-center gap-1.5 rounded-full border px-2.5 text-[12px] font-semibold"
  style={{ ['--filter-accent' as string]: lift(c.accent) }}
>
  <span aria-hidden className="h-1.5 w-1.5 rounded-full" style={{ background: c.accent }} />
  <span>{c.label}</span>
  <span className="tabular-nums" style={{ color: lift(c.accent) }}>{n}</span>
</button>
```

- [ ] **Step 4: Remove the main-board footer and recover viewport space**

In the non-empty `App` return:

- Change the root bottom padding from `pb-14` to `pb-4`.
- Remove the `<Footer />` after `</motion.main>`.
- Keep the footer in the empty setup screen because it is outside the repeated-use board.

The root becomes:

```tsx
<div className="flex h-dvh w-full flex-col px-4 pb-4 md:px-6 lg:px-8 [@media(max-height:640px)]:h-auto [@media(max-height:640px)]:pb-8">
```

- [ ] **Step 5: Add toolbar overflow and selected-state CSS**

Add to `index.css`:

```css
.jb-board-tools {
  overflow-x: auto;
  scrollbar-width: none;
}

.jb-board-tools::-webkit-scrollbar {
  display: none;
}

.jb-filter-button {
  border-color: var(--line);
  background: var(--surface-solid);
  color: var(--ink-soft);
}

.jb-filter-button:hover {
  border-color: var(--line-strong);
  color: var(--ink);
}

.jb-filter-button[aria-pressed='true'] {
  border-color: var(--filter-accent);
  background: color-mix(in srgb, var(--filter-accent) 9%, var(--surface-solid));
  color: var(--ink);
}
```

- [ ] **Step 6: Run focused tests and typecheck**

Run:

```bash
npx vitest run --config tooling/vitest.config.ts src/components/board/Stats.test.ts
npm run typecheck
```

Expected: both commands PASS.

- [ ] **Step 7: Build and commit Task 2**

Run:

```bash
npm run build
git add src/components/board/Stats.tsx src/components/board/Stats.test.ts src/App.tsx src/styles/index.css
git diff --cached --check
git commit -m "feat(ui): clarify board navigation controls"
```

Expected: build succeeds and the commit contains only the four named files.

---

### Task 3: Quiet Lanes and Ticket Cards

**Files:**
- Modify: `src/components/board/Board.tsx:1-166`
- Modify: `src/components/board/Column.tsx:211-307`
- Modify: `src/components/board/boardParts.tsx:1-84`
- Modify: `src/components/board/TicketCard.tsx:1-422`
- Modify: `src/components/board/TicketCard.test.ts`
- Modify: `src/components/board/Column.test.ts`
- Modify: `src/styles/index.css:168-251,530-550`
- Modify: `src/styles/glass.css:125-139,266-284`

**Interfaces:**
- Consumes: existing drag MIME, card callbacks, lane metadata, and Motion layout behavior.
- Produces: `aria-label="Ticket board"` region; semantic lane and card headings; flat cards with one status marker; no decorative board/card entrance or hover transform.

- [ ] **Step 1: Write failing semantic and visual-contract tests**

Add to `TicketCard.test.ts`:

```tsx
describe('quiet card semantics', () => {
  it('uses the ticket title as a heading inside the operable card', () => {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    act(() => root!.render(createElement(TicketCard, { ticket, now: Date.now(), onOpen: () => {} })))
    const card = host.querySelector('[role="button"]')!
    expect(card.querySelector('h3')?.textContent).toBe('A card')
  })

  it('does not render decorative wash, glow, or edge layers', () => {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    act(() => root!.render(createElement(TicketCard, { ticket, now: Date.now(), onOpen: () => {} })))
    expect(host.querySelector('.ticket-card-wash, .ticket-card-glow, .ticket-card-edge')).toBeNull()
  })
})
```

Add to `Column.test.ts`:

```tsx
it('exposes the lane name as a heading', () => {
  const waiting = { key: 'Q-1', title: 'Waiting', status: 'Ready for QA', column: 'qa' as const }
  const section = render({ meta: COLUMN_META.qa, tickets: [waiting] })
  expect(section.querySelector('h2')?.textContent).toContain('QA')
})
```

- [ ] **Step 2: Run focused tests and verify they fail**

Run:

```bash
npx vitest run --config tooling/vitest.config.ts src/components/board/TicketCard.test.ts src/components/board/Column.test.ts
```

Expected: FAIL because lane labels and ticket titles are spans/divs and decorative layers are still rendered.

- [ ] **Step 3: Remove the board entrance cascade**

In `Board.tsx`:

- Remove `INTRO_MS`, `introPlayed`, `intro`, and its timer effect.
- Keep the drag settle timer and state.
- Add `role="region"` and `aria-label="Ticket board"` to the board root.
- Remove `jb-board-intro` from the class list.

Use:

```tsx
className={`-mx-1.5 flex min-w-fit items-stretch gap-3 px-1.5 pb-3 ${calm ? 'jb-dragging' : ''}`}
```

Delete the `.jb-board-intro` keyframes and selectors from `index.css`.

- [ ] **Step 4: Flatten shared lane parts**

In `boardParts.tsx`, make idle drop areas neutral and active targets semantic:

```tsx
export function dropBoxStyle(accent: string, active: boolean): CSSProperties {
  return {
    borderColor: active ? tint(accent, 0.72) : 'var(--line)',
    background: active ? tint(accent, 0.1) : 'transparent',
    boxShadow: active ? `0 0 0 2px ${tint(accent, 0.16)}` : undefined,
  }
}
```

Replace the icon container in `SpaceHeader` with an unboxed inline icon and make the label an `h2`:

```tsx
<header className="relative mb-2 flex h-6 items-center gap-2 px-1">
  <span className="inline-flex shrink-0 items-center justify-center" title={title}>
    {icon}
  </span>
  <AnimatePresence initial={false}>
    {!folded && (
      <motion.div key="label" className="flex min-w-0 flex-1 items-center gap-2" initial={false}>
        <h2 className="truncate text-[11px] font-bold uppercase tracking-wider text-[var(--ink-soft)]">
          {label}
        </h2>
        {count !== undefined && <CountPill accent={accent} count={count} />}
      </motion.div>
    )}
  </AnimatePresence>
  {denied && !folded && <DeniedChip check={denied} alt={alt} active={active} />}
</header>
```

In `Column.tsx`, change full lane boxes from `rounded-2xl` to `rounded-xl`, retain dashed borders only for actual drop areas, and keep all drag handlers and move checks unchanged.

- [ ] **Step 5: Flatten `TicketCard` while preserving interaction**

In `TicketCard.tsx`:

- Remove `celebratedDone`, `burst`, `DoneBurst`, the `useState` import, and decorative entrance/exit/hover/tap props.
- Keep `motion.div` and `layout` because card movement during drag is functional spatial feedback.
- Remove `ticket-card-wash`, `ticket-card-glow`, and `ticket-card-edge`.
- Replace the title `div` with `h3`.
- Replace colored/glowing shadows with a simple inset status marker and neutral shadow.

Use:

```tsx
const baseShadow = [
  `inset 3px 0 0 ${accent}`,
  '0 1px 2px rgba(2, 6, 23, 0.08)',
  urgent ? `0 0 0 1px ${tint(prio.color, 0.3)}` : '',
  overflow ? '0 0 0 2px #dc2626' : '',
].filter(Boolean).join(', ')
```

Use this motion shell:

```tsx
<motion.div
  ref={cardRef}
  layout={calm ? false : 'position'}
  draggable={draggable || undefined}
  role="button"
  tabIndex={0}
  data-ticket-key={ticket.key}
  aria-label={`Open ${ticket.key}: ${ticket.title}`}
  onClick={() => onOpen(ticket.key)}
  onKeyDown={(event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      onOpen(ticket.key)
    }
  }}
  transition={{ layout: LAYOUT }}
  className={`ticket-card @container group relative flex w-full flex-col ${draggable ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer'} overflow-hidden rounded-lg border bg-[var(--surface-solid)] text-left ${sub ? 'px-2.5 py-2' : 'min-h-[168px] p-2.5'}`}
  style={{ boxShadow: baseShadow, borderColor: overflow ? '#dc2626' : undefined, ['--card-accent' as string]: accent }}
>
```

Use this title:

```tsx
<h3 className={`relative mt-1 line-clamp-2 font-semibold leading-snug text-[var(--ink)] ${sub ? 'text-[12px]' : 'text-[13px]'}`}>
  {ticket.title}
</h3>
```

- [ ] **Step 6: Remove glass pointer effects from cards and simplify hover CSS**

In `glass.css`, remove the `.ticket-card::before`, `.ticket-card::after`, and `.ticket-card:hover::after` rules while leaving dialog and `.glass-interactive` behavior unchanged.

In `index.css`, replace card bloom styles with:

```css
.ticket-card {
  --card-accent: var(--muted);
  border-color: var(--line);
  transition: border-color 150ms ease, background-color 150ms ease;
}

.ticket-card:hover {
  border-color: color-mix(in srgb, var(--card-accent) 35%, var(--line));
  background-color: color-mix(in srgb, var(--card-accent) 4%, var(--surface-solid));
}
```

- [ ] **Step 7: Run focused board tests and typecheck**

Run:

```bash
npx vitest run --config tooling/vitest.config.ts src/components/board/Board.test.ts src/components/board/Column.test.ts src/components/board/TicketCard.test.ts
npm run typecheck
```

Expected: all commands PASS, including existing drag/drop tests.

- [ ] **Step 8: Build and commit Task 3**

Run:

```bash
npm run build
git add src/components/board/Board.tsx src/components/board/Column.tsx src/components/board/boardParts.tsx src/components/board/TicketCard.tsx src/components/board/TicketCard.test.ts src/components/board/Column.test.ts src/styles/index.css src/styles/glass.css
git diff --cached --check
git commit -m "feat(ui): quiet the board lanes and cards"
```

Expected: build succeeds and the commit contains only the named board and style files.

---

### Task 4: Responsive, Accessibility, and Documentation Verification

**Files:**
- Modify: `src/styles/index.css`
- Modify: `src/components/header/Header.tsx`
- Modify: `src/components/board/Stats.tsx`
- Modify: `docs/AGENTS.md`
- Generated: `help/help-data.js`

**Interfaces:**
- Consumes: `.jb-board-header`, `.jb-icon-action`, `.jb-board-tools`, and existing theme tokens from Tasks 1–3.
- Produces: touch-size and narrow-layout guarantees; documentation aligned with the new shell direction.

- [ ] **Step 1: Add responsive CSS for touch and narrow screens**

Add to `index.css`:

```css
@media (pointer: coarse), (max-width: 640px) {
  .jb-icon-action {
    min-width: 2.75rem;
    width: 2.75rem;
    height: 2.75rem;
  }

  .jb-board-header {
    position: static;
  }

  .jb-board-tools {
    margin-inline: -1rem;
    padding-inline: 1rem;
  }
}

@media (max-width: 420px) {
  .jb-primary-action {
    width: auto;
    min-width: 7.5rem;
  }

  .jb-search {
    min-width: 100%;
    order: 3;
  }
}
```

Ensure every utility button in `Header.tsx` uses `jb-icon-action`; do not change menu behavior or callbacks.

- [ ] **Step 2: Verify keyboard and accessible-state behavior in component tests**

Run:

```bash
npx vitest run --config tooling/vitest.config.ts src/components/header/Header.test.ts src/components/board/Stats.test.ts src/components/board/Column.test.ts src/components/board/TicketCard.test.ts
```

Expected: PASS.

Then inspect the rendered DOM in the local app:

1. Tab through search, clear search, Refresh, utility controls, filters, destinations, and the first ticket.
2. Confirm every focus indicator is visible.
3. Confirm Enter and Space open the focused ticket.
4. Confirm selected filters expose `aria-pressed="true"`.
5. Confirm search clearing restores an empty query.

- [ ] **Step 3: Capture desktop and mobile screenshots in both themes**

Run the local app:

```bash
npm run dev -- --host 127.0.0.1
```

Use the browser inspection tools to capture:

- 1440×900 light
- 1440×900 dark
- 390×844 light
- 390×844 dark

Verify:

- no content overlap or clipped controls;
- search remains usable;
- toolbars scroll horizontally;
- ticket titles and metadata remain legible;
- semantic accents are visible without tinting entire lanes;
- no board-shell blur, gradient text/button, glow, or decorative icon box remains.

- [ ] **Step 4: Update repository UI guidance**

In `docs/AGENTS.md`, update only the board-shell portions of “UI style guardrails”:

- Document the quiet operations-console direction.
- State that header, filter toolbar, lanes, cards, and repeated-use footer are flat and neutral.
- Preserve Liquid Glass guidance for dialogs, drawers, menus, and overlays.
- Preserve semantic column colors for markers, counts, selected states, and drag targets.
- Preserve functional drag layout motion while prohibiting decorative board/card entrance and hover transforms.

Do not change unrelated backend or integration guidance.

- [ ] **Step 5: Run the full verification suite**

Run:

```bash
npm run build
npm test
```

Expected:

- TypeScript and Vite build PASS.
- JavaScript Vitest suite PASS.
- Python unittest suite PASS.
- `help/help-data.js` is regenerated by `prebuild` and matches `docs/AGENTS.md`.

- [ ] **Step 6: Check edited-file lints**

Use Cursor’s lint inspection on:

```text
src/components/header/Header.tsx
src/components/header/Header.test.ts
src/components/board/Stats.tsx
src/components/board/Stats.test.ts
src/components/board/Board.tsx
src/components/board/Column.tsx
src/components/board/boardParts.tsx
src/components/board/TicketCard.tsx
src/components/board/TicketCard.test.ts
src/styles/index.css
src/styles/glass.css
```

Expected: no newly introduced linter errors.

- [ ] **Step 7: Review the complete diff**

Run:

```bash
git status --short
git diff --check
git diff --stat HEAD~3
```

Confirm:

- no data contract, server, move-rule, or persistence files changed;
- no new dependency was added;
- no secrets, internal hosts, personal identifiers, or runtime data are staged;
- only the approved board shell and required generated documentation changed.

- [ ] **Step 8: Commit responsive and documentation updates**

Run:

```bash
git add src/styles/index.css src/components/header/Header.tsx src/components/board/Stats.tsx docs/AGENTS.md help/help-data.js
git diff --cached --check
git commit -m "docs(ui): align board shell guidance"
```

Expected: final build and tests remain green after the commit.
