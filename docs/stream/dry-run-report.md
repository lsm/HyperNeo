# NeoKai Live UI Demo — Dry-Run Report

- **Base URL:** http://localhost:8383
- **Time:** 2026-06-05T19:00:18.403Z
- **Result:** All steps passed

## Screenshots

Captured in `tmp/demo-screenshots/`:

- `00-app-ready.png` — Spaces list landing
- `01-space-overview.png` — dev-NeoKai Demo space overview
- `02-tasks-view.png` — Space tasks list
- `03-task-thread.png` — Demo task thread panel
- `04-agents-view.png` — Space agents (Coordinator visible)
- `05-forge-view.png` — Forge evidence view
- `06-session-input.png` — New chat session with typed prompt
- `07-settings-skills.png` — Settings / Skills tab
- `08-spaces-list.png` — Return to Spaces list

## Breakages

None.

## Notes for the stream

- Use `make dev DB_PATH=/tmp/beokai-8383 PORT=8383` for the demo server.
- Keep the demo on the isolated DB and `/tmp/neokai-demo-workspace-*` path only.
- Do not press Enter in the session input unless the dev proxy is running.
