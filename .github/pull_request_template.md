<!-- Thanks for contributing! Keep PRs focused and small where you can. -->

## What & why

<!-- What does this change, and what problem does it solve? -->

## How to test

<!-- Steps a reviewer can follow. e.g. `docker compose up -d --build`, then … -->

## Checklist

- [ ] `npm run verify` passes (config, test-change policy, Python, Vitest, typecheck, production bundle/contracts and Playwright)
- [ ] `test-results/index.html` is green; browser failures include a trace/screenshot/video
- [ ] New or changed behaviour has a regression test at the right layer (unit/component, flow, production contract or E2E)
- [ ] Docs updated for any behaviour change (`docs/`, `setup/`, `README.md`, `jira-intern/CONFIG.md`) and a line added to `docs/CHANGELOG.md`
- [ ] The keep-in-sync contracts still agree (`src/types.ts` ↔ `intern-prompt.md`, `reportTypes.ts` ↔ `pr_report.py`, `columns.ts` ↔ `_jira.py`) — see `docs/CONTRIBUTING.md`
- [ ] No secrets, tokens, real ticket content, company names, internal hostnames, tenant ids or project keys in the diff
- [ ] No runtime files staged (`jira-intern/data.*`, `reports/`, `.settings.json`, `logs/`, `cache/`)
