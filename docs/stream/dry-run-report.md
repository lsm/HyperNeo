# NeoKai Live UI Demo — Dry-Run Report

- **Base URL:** http://localhost:8383
- **Space:** dev-NeoKai
- **Time:** 2026-06-05T19:43:22.220Z
- **Result:** All steps passed

## Screenshots

Captured in `tmp/demo-screenshots/`:

- `00-app-ready.png` — Spaces list landing
- `01-space-overview.png` — dev-NeoKai space overview
- `02-tasks-view.png` — Space tasks view
- `03-task-thread.png` — Demo task thread panel
- `04-agents-view.png` — Space agents (Coordinator visible)
- `05-forge-view.png` — Forge evidence view
- `06-session-input.png` — New chat session with typed prompt
- `07-settings-skills.png` — Settings / Skills registry content
- `08-spaces-list.png` — Return to Spaces list

## Breakages

None.

## Review fixes applied

- Reused `dev-NeoKai` spaces are no longer deleted by the dry-run (`DEMO_CLEANUP_SPACE=1` to opt in).
- Created demo sessions are deleted before the space is deleted.
- `workspacePath` is passed to `session.create` to match the live UI path.
- Tasks view waits for `[data-testid="space-tasks-view"]` on the route wrapper instead of sidebar text.
- Skills step waits for the `Add Skill` button rendered by `SkillsRegistry`.
- Runbook and demo script now tell the operator to start the daemon with `NEOKAI_USE_DEV_PROXY=1` and to also run `make test-proxy-start`.
- The demo Space is kept after the dry-run so the live demo can open it.
- Demo tasks are created as `blocked` + `human_input_requested` (non-runnable) and any stale previous demo task is archived first (via `cancelled` if needed) to avoid duplicates.
- The dry-run fetches the existing Space's stored `workspacePath` so the created session is bound to the same workspace the live UI uses.
- The `create-session` step is driven through the UI (`Sessions` → `Create session` button) rather than via RPC.

## Notes for the stream

- Use `NEOKAI_USE_DEV_PROXY=1 make dev DB_PATH=/tmp/beokai-8383 PORT=8383` **and** `make test-proxy-start` if the session input will be submitted.
- Run the dry-run once before streaming to seed the `dev-NeoKai` Space in the isolated DB.
- Keep the demo on the isolated DB and `/tmp/neokai-demo-workspace-*` path only.
