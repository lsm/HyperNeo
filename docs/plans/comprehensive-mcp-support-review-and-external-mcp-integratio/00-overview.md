# Comprehensive MCP Support Review and External MCP Integration

## Goal Summary

HyperNeo currently supports MCP servers defined in project-level `.mcp.json` or `~/.claude/settings.json` files, which are auto-loaded by the Claude Agent SDK. There is no application-level registry for managing, adding, or importing MCP servers from external sources, no UI to configure MCPs beyond toggling existing ones, and no persistent CRUD API for registering new MCPs.

This plan audits the current MCP system, then implements:
1. A daemon-managed **Application-Level MCP Registry** (SQLite-backed) for CRUD on named MCP server configs.
2. A **Lifecycle Manager** that converts registry entries to SDK configs, integrates them into room/session and space/task-agent contexts, and provides error feedback for failed MCP servers.
3. A **Web UI** for adding, editing, enabling/disabling, and deleting application-level MCPs (including secure env-var editor for API keys).
4. **Room/session MCP enablement**: per-room opt-in from the registry.
5. **Default MCP seeds** (`fetch-mcp`) as a useful out-of-the-box registry entry for end-users, plus documentation confirming that the Planner and plan-writer already have built-in `WebFetch`/`WebSearch` tools.

## Approach

The existing system reads MCP server configs from `.mcp.json` / `settings.json` files on disk and delegates spawning entirely to the Claude Agent SDK subprocess. The new system layered on top:

- Stores registry entries in the SQLite `app_mcp_servers` table.
- At room-chat session startup, `RoomRuntimeService` reads the registry, applies per-room enablement, and passes the resolved `mcpServers` map to `setRuntimeMcpServers()` alongside the existing `room-agent-tools` server.
- For worker (coder/general) sessions, enabled registry entries are injected via `session.setRuntimeMcpServers()` after session creation — preserving the SDK's existing auto-load of file-based MCP servers (`config.mcpServers` remains `undefined`).
- The Planner and plan-writer sub-agents already have built-in `WebFetch` and `WebSearch` tools — no additional wiring needed. Milestone 6 documents this and seeds useful default MCP entries for end-users.

No existing MCP file-based flows are removed — the registry is additive.

## Milestones

1. **Audit and Documentation** — Deep-dive into current MCP flows, document gaps, and produce an audit report.
2. **Application-Level MCP Registry (Backend)** — SQLite schema, repository, RPC handlers (CRUD + list), and unit tests.
3. **MCP Lifecycle Manager** — Convert registry entries to SDK configs, inject via `setRuntimeMcpServers()` into room sessions (Task 3.2), worker sessions (Task 3.3), and space agents (Task 3.4). Validation error reporting for misconfigured entries. Health-check/auto-restart deferred to a future iteration.
4. **Room and Session MCP Integration** — Per-room enablement stored in the DB, integration in `RoomRuntimeService` and `QueryOptionsBuilder`, and online tests.
5. **Web UI for MCP Registry** — Settings panel for adding/editing/deleting application-level MCP entries with enable/disable per room.
6. **Default MCP Seeds and Planner Web Search Verification** — Document that the Planner and plan-writer already have `WebFetch`/`WebSearch` built-in tools (no new wiring needed). Seed `fetch-mcp` as a default registry entry for end-users.
7. **E2E Tests** — End-to-end Playwright test: add an MCP, enable in a room, verify tools available to the room agent.

## Cross-Milestone Dependencies

- Milestone 2 (registry backend) must land before 3, 4, 5, and 6.
- Milestone 3 (lifecycle manager) must land before 4 (room integration) and 6.2 (default MCP seeds).
- Milestone 4 (room integration) must land before 5 (UI reflects per-room state) and 7 (E2E test).
- Milestone 5 (UI) can be developed in parallel with 6 (default seeds) after milestone 4 is done.
- Milestone 7 (E2E) depends on all prior milestones.
- **Task 6.1** (planner web search documentation) and **Task 6.2** (default MCP seeds) have **no dependencies on each other** and can start as soon as Milestone 2 (Task 6.2) and day one (Task 6.1) allow.

## Architectural Patterns

### LiveQuery (reactive frontend reads)

The `app_mcp_servers` and `room_mcp_enablement` tables integrate with HyperNeo's **LiveQuery** system for reactive frontend reads — the same pattern used for `tasks.byRoom` and `goals.byRoom`. This means:

- Repository write methods (`create`, `update`, `delete`, `setEnabled`, `resetToGlobal`) call `reactiveDb.notifyChange('<table>')` after each SQL write.
- Two named queries are registered in `NAMED_QUERY_REGISTRY` (`live-query-handlers.ts`):
  - `'mcpServers.global'` — full registry, no params (Task 2.2)
  - `'mcpEnablement.byRoom'` — per-room overrides, param: `[roomId]` (Task 4.1)
- The frontend `appMcpStore` (Task 5.1) subscribes via `hub.request('liveQuery.subscribe', ...)` and applies `liveQuery.snapshot` / `liveQuery.delta` events to Preact Signals — no polling, no `mcp.registry.changed` event on the frontend.
- `mcp.registry.changed` remains a daemon-internal event used only by `RoomRuntimeService` for live session hot-reload (Task 3.2). It is NOT propagated to the frontend.

### Job Queue (background processing)

The `JobQueueProcessor` is **not used in this iteration** — health-check/auto-restart of MCP server processes is explicitly deferred. When that work is undertaken, it must use a self-scheduling Job Queue entry (queue name `mcp.health_check`, following the `github.poll` pattern), not `setInterval` or in-memory state. The `job-queue-constants.ts` file is the right place to register the queue name constant.

## Audit Feedback Loop

Milestone 1 (Audit) should complete before implementation milestones begin. If the audit uncovers a critical architectural gap not covered by this plan, implementation tasks should be adjusted before proceeding with the affected milestone. The audit document (`docs/mcp-audit.md`) serves as the authoritative reference for implementation decisions.

## Total Estimated Task Count

15 tasks across 7 milestones. (Task 6.3 "wire web search into planner" and Task 7.2 "planner web search smoke test" were removed — the planner already has built-in WebFetch/WebSearch tools.)
