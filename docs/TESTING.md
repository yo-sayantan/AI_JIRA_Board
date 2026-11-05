# Testing and SDLC

The board uses layered tests because no one layer can prove the shipped app works. A jsdom test can
prove component logic; only the compiled artifact can prove Vite did not tree-shake a production
feature; only a browser flow can prove the user can operate it.

## Test layout

- `src/**/*.test.ts(x)` — focused unit and component tests kept beside settled code.
- `src/tests/demo/` — cross-component Demo mode logic, fixture, persistence and accessibility
  regressions. These files are permanent and Vitest discovers both `.test.ts` and `.test.tsx`.
- `tests/*.py` — Python fetch, archive, report, integration and configuration behavior.
- `tests/production/` — contracts against the generated `dist/index.html`.
- `tests/e2e/` — Playwright flows against Vite Preview of the production build.
- `test-results/` — generated HTML/JSON summary plus Playwright traces, screenshots and video.
  This directory is git-ignored and uploaded by CI even when tests fail.

## Commands

- `npm run test:js` — Vitest unit, component and in-browser integration tests.
- `npm run test:py` — Python logic and integration tests.
- `npm test` — both fast suites.
- `npm run test:production` — contracts against an existing production bundle.
- `npm run test:coverage` — Vitest plus text, JSON and HTML coverage under `coverage/`.
- `npm run test:e2e` — rebuild, then run the full Chromium UI and flow suite.
- `npm run test:e2e:built` — run E2E against the current `dist/` without rebuilding (CI/internal).
- `npm run test:e2e:smoke` — the smallest production UI journey.
- `npm run lint:hooks` — hook-order/dependency lint on changed production TypeScript files.
- `npm run verify:fast` — test-change policy, TypeScript and Vitest.
- `npm run verify` — config validation, a tested production build and all E2E flows.
- `npm run build` — always runs the test-change policy and the full Python/Vitest suite before
  bundling, then production-artifact contracts after bundling.

Every package-level test command refreshes `test-results/index.html` and
`test-results/latest.json`. The report shows the latest status, totals, pass/fail/skip counts, pass
rate, flaky count, duration and timestamp for each suite. Results from a different branch/workspace
revision are removed from the “latest” view rather than shown as current. Playwright writes each
run to an isolated artifact folder and retains trace, screenshot and video on failure.

Coverage cannot fall below the checked-in baseline floors: 72% statements, 62% branches, 70%
functions and 75% lines. Raise these floors as meaningful coverage is added; do not lower them to
make a change pass.

## Merge gates

CI runs these gates in order:

1. Shell and project-config validation.
2. `npm run build`: change/test policy, Python, Vitest, typecheck, bundle and production contracts.
3. Vitest code coverage.
4. Chromium production UI and flow tests, including axe accessibility checks.
5. Docker image smoke build. Its Node-only stage uses `build:app`; the host CI gates above have
   already tested that source because the image context intentionally has no Git/Python test setup.
6. Upload the built board, unified results, coverage and browser reports.

No pull request should merge with a red gate. Run `npm run verify` before committing or pushing a
behavior change.

## Regression ownership

- Demo dataset pill: native radio semantics, all options, URL restoration and query preservation in
  `src/tests/demo/DevDataToggle.test.tsx`.
- Demo fixture logic: every fixture exists, empty/one/400 counts and URL integrity in
  `src/tests/demo/devData.test.ts`.
- Demo/live isolation: immediate fixture switching, stale URL handling, archive isolation and Reset
  demo in `src/tests/demo/useBoardData.test.ts`.
- Shipped bundle: single-file output, production pill labels and fixture markers in
  `tests/production/dist-contract.test.mjs`.
- User flow: production visibility, persistence, keyboard arrows, archive/reset, leaving Demo mode,
  1024px fit and axe in `tests/e2e/demo-mode.spec.ts`.
- Refresh dot lifecycle and lane move: `src/components/board/TicketCard.test.ts`.
- Colour contrast and filled-label readability: `src/lib/tone.test.ts`.

## Change policy

`npm run test:changed` compares the branch and working tree with `origin/main`. A behavioral source
change under `src/`, `server/`, `jira-intern/`, `ai-intern/`, `scripts/` or `docker/` must include a
unit, component, integration, production-contract or E2E test change. Docs-only and generated-only
changes do not need artificial tests. Docker build contexts have no `.git`, so the policy reports a
skip there; the host CI gate has already enforced it.

When changing behavior:

1. Add the failing regression at the cheapest layer that can reproduce the problem.
2. Add a production contract when bundling/tree-shaking can change the outcome.
3. Add or update an E2E flow when the behavior crosses components or depends on browser semantics.
4. Implement the smallest fix.
5. Run `npm run verify`; inspect `test-results/index.html`.
6. Commit only after the report is green.

Do not replace behavioral assertions with snapshots. Use screenshots for failure evidence, not as
the only proof of correctness.
