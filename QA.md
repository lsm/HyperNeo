# NeoKai QA Instructions

Project-specific QA guidance for the QA agent.

## Dev Server Startup

- Start with `make dev PORT=<free-port> DB_PATH=/tmp/neokai-qa-<task-id>.db`
- DB path must match port number pattern (e.g. port 8383 → `/tmp/neokai-qa-8383.db`)
- Always use a fresh DB for QA — never point at the daemon's primary DB

## Server Lifecycle Discipline

- Do NOT kill a dev server you didn't start yourself
- If a server is already running on your target port, pick a different port
- Shut down your server when QA is complete

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

- Record all findings in QA result artifact with `ui_changed`, `dev_server_started`, `browser_validation` fields
- If QA.md itself is the only change, minimal validation (file exists, content renders) is sufficient
