# NeoKai QA Instructions

Project-specific QA guidance for the QA agent.

## Dev Server Startup

- Start with `make dev PORT=<free-port> DB_PATH=/tmp/neokai-qa-<task-id>.db`
- DB path must use the task ID naming pattern (e.g. task 466 → `/tmp/neokai-qa-466.db`)
- Always use a fresh DB for QA — never point at the daemon's primary DB

## Server Lifecycle Discipline

- Do NOT kill a dev server you didn't start yourself
- If a server is already running on your target port, pick a different port
- Shut down your server when QA is complete

## Classifying `ui_changed`

Before deciding whether to browser-test, classify the PR's `ui_changed` status using these rules:

### Rule 1: Frontend file changes → `ui_changed: true`

Changed files matching these patterns always trigger browser testing:
- `packages/web/**`
- `packages/ui/**`
- `*.css`, `*.html`

### Rule 2: Backend modules with UI-visible effects → `ui_changed: true`

Changes to these backend modules also require browser testing because they feed data rendered in the UI:
- `packages/daemon/src/lib/agent/context-fetcher.ts` — context window display (token counts, window size)
- `packages/daemon/src/lib/providers/**` — provider config, model metadata, provider badges, model picker entries
- `packages/shared/src/models.ts` — ModelInfo type changes that affect model list display
- `packages/daemon/src/lib/session/**` — session metadata shown in UI (status indicators, labels)
- `packages/daemon/src/lib/rpc-handlers/**` — RPC responses consumed by frontend components

### Rule 3: Catch-all for UI-rendered data → `ui_changed: true`

If ANY changed file affects data that ends up rendered in the browser — token counts, context windows, model names, provider status, session labels, error messages visible to users — classify `ui_changed: true` and start the dev server.

### Rule 4: Pure backend → browser optional

Only skip browser testing when changes are purely internal backend logic (database schema, internal utilities, build config) with zero path to user-visible UI rendering.

### Standing principle

**When in doubt, browser test.** The cost of testing is 2 minutes; the cost of skipping is a broken UI reaching users.

## UI/Frontend Testing with Playwright

- Use the Playwright skill (`/playwright`) to launch a real browser and test UI changes or new features interactively
- Navigate to the running dev server and exercise the changed UI flow as a real user would
- Look for visual bugs, broken layouts, unfriendly UX, missing loading states, error handling gaps
- Test golden path, edge cases (empty states, long text, network errors), and nearby-regression checks
- Take screenshots to document what was tested

## Backend/API-Only Testing

- For API-only changes, use `curl` or shell scripts against the running dev server
- Test request/response contracts, error codes, edge cases
- No need to start a browser for pure backend changes

## General

- Record all findings in QA result artifact with `pr_url`, `ui_changed`, `dev_server_started`, `browser_validation` fields
- When QA instruction files change, review them as process-affecting code and verify the policy changes preserve required validation rigor
