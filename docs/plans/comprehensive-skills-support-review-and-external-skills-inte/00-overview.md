# Comprehensive Skills Support Review and External Skills Integration

## Goal Summary

HyperNeo currently has **no application-level Skills registry**. The term "Skill" in HyperNeo maps directly to the Claude Agent SDK's slash-command system (markdown files in `.claude/commands/`). The SDK also supports local **Plugins** (directories providing agents, skills, hooks) and **MCP tools** (MCP servers). This goal delivers:

1. A thorough audit of the current state
2. An application-level Skills registry — add, configure, and manage custom skills from the UI
3. Support for external skill sources: built-in (SDK slash commands), plugin-based (local plugin directories), and MCP-based web search
4. Web search capability for the Planner agent via the SDK's built-in `WebSearch` tool (already wired in; needs verification and prompt enhancement)
5. Room/session-level Skill enablement
6. Tests at all layers

## Key Findings from Codebase Audit

- **"Skill" tool** in HyperNeo = SDK's built-in `Skill` tool, which invokes slash commands from `.claude/commands/*.md`. Already included in allowed tool lists for `room_chat` and coordinator modes.
- **SDK Plugins** (`{ type: 'local', path: string }`) can provide custom commands/agents/hooks. HyperNeo's `SDKConfig` has a `plugins?: PluginConfig[]` field but no UI or management system for it.
- **Planner/plan-writer agents already include `WebSearch` and `WebFetch`** in their tool lists — planner web search capability exists at the code level but needs verification and possibly prompt guidance.
- **No Skills registry exists**: no CRUD UI, no config file, no RPC handlers for Skills management.
- **MCP is the established extensibility mechanism**: `.mcp.json` in workspace, managed via `ToolsConfig.disabledMcpServers`.
- **Settings pattern**: GlobalSettings → SettingsManager → SQLite → SDK options.
- **Application config dir**: `~/.neokai/` (already in `additionalDirectories`).

## High-Level Approach

- Build an application-level **Skills registry** backed by **SQLite** (new `skills` table, following the same repository pattern as `goals`/`goal-repository.ts`) — not a JSON file, to align with the established persistence pattern and gain native concurrency safety.
- Support three skill source types: **built-in** (SDK slash commands), **plugin** (local plugin dir via SDK's `plugins` option), **mcp-server** (MCP server used as a skill provider)
- **Input validation** in `SkillsManager`: `pluginPath` must be an absolute path with no `../` traversal; for `mcp_server` skills `appMcpServerId` must be non-empty and reference an existing `app_mcp_servers` entry (checked via `AppMcpServerRepository.get()`); `commandName` for built-in skills must be non-empty.
- **`strictMcpConfig` compatibility**: `room_chat` uses `strictMcpConfig` which blocks unlisted MCP servers. Skill-injected MCP servers must be added to the allowed list or `strictMcpConfig` must be conditionally relaxed when skills inject additional MCP servers. This must be handled explicitly in Task 3.1.
- **LiveQuery integration (ADR 0001 — mandatory)**: `SkillRepository` and `RoomSkillOverrideRepository` must call `reactiveDb.notifyChange('skills')` and `reactiveDb.notifyChange('room_skill_overrides')` directly after each write — the same pattern used by `AppMcpServerRepository` (see `packages/daemon/src/storage/repositories/app-mcp-server-repository.ts`). `METHOD_TABLE_MAP` is only for `Database` facade methods and must NOT be used here. Named queries `skills.list` (0 params) and `skills.byRoom` (1 param: roomId) must be added to `NAMED_QUERY_REGISTRY` in `live-query-handlers.ts` — use existing `mcpServers.global` (0 params) and `mcpEnablement.byRoom` (1 param) as the exact structural templates. `skills.byRoom` must also be added to the auth guard allow-list at line ~453 in `live-query-handlers.ts`. The frontend Skills store must use `liveQuery.subscribe` — not one-shot RPC — for real-time updates. Per-room skill overrides must live in a dedicated `room_skill_overrides` table (not the room `config` JSON blob) so `skills.byRoom` can JOIN across both tables reactively.
- **Job Queue for async operations**: Skill validation operations (checking plugin path accessibility, verifying `mcp_server` skill's referenced `app_mcp_servers` entry still exists) must use `JobQueueProcessor` + `JobQueueRepository` for reliable background execution with retry. A `SKILL_VALIDATE` queue constant and corresponding job handler must be implemented.
- Add a **Skills Manager** backend service with CRUD operations + RPC handlers
- Expose Skills configuration via the **Settings UI** (global skills) and **Room Settings** (per-room overrides)
- Verify and enhance the planner's **WebSearch** capability with explicit prompt guidance
- Cover everything with unit tests and E2E tests

## Milestones

The plan spans 7 milestones across 7 files (01–07):

1. **Skills Audit and Baseline Documentation** (`01-skills-audit-and-baseline.md`) — Audit current Skills/MCP/Plugin integration; document the as-is state; identify gaps and establish the target architecture.
2. **Skills Registry Data Model and Backend** (`02-skills-registry-backend.md`) — Define `AppSkill` types, create `SkillsManager` backed by SQLite (`SkillRepository`), wire up RPC handlers (CRUD + list), add input validation, wire `reactiveDb.notifyChange('skills')` in `SkillRepository` (following `AppMcpServerRepository` pattern — do NOT modify `METHOD_TABLE_MAP`), add `skills.list` named query to `NAMED_QUERY_REGISTRY` (Task 2.4), and add the `SKILL_VALIDATE` job queue with handler for async validation. Note: `skills.byRoom` named query and `room_skill_overrides` LiveQuery wiring are in Milestone 3 (Task 3.2) to avoid a circular dependency.
3. **Skills Distribution to Agent Sessions** (`03-skills-distribution.md`) — Inject Skills from registry into SDK options (`plugins`, `mcpServers`) for regular sessions; handle `strictMcpConfig` for skill-injected MCP servers; apply room-level enablement overrides.
4. **Room Settings UI — Per-Room Skill Enablement** (`04-room-skills-ui.md`) — Extend the Room Settings panel to show available registry skills with per-room toggles.
5. **Settings UI: Global Skills Registry** (`05-global-skills-ui.md`) — Build the Skills management UI in the global settings panel (list, add, remove, enable/disable skills).
6. **Planner Web Search Verification and Enhancement** (`06-planner-websearch.md`) — Confirm the Planner's `WebSearch` tool works end-to-end; add prompt guidance for web search use; write an online test.
7. **Integration and Regression** (`07-integration-and-regression.md`) — Full end-to-end integration test, regression checks, and final validation.

## Cross-Milestone Dependencies

- Milestone 3 depends on Milestone 2 (data model must exist first)
- Milestone 4 depends on Milestones 2 and 3 (RPC handlers and room persistence must exist)
- Milestone 5 depends on Milestone 2 (RPC handlers must exist)
- Milestone 6 is mostly independent: Tasks 6.1–6.3 (verification and prompt work) can proceed in parallel with Milestones 2–5; Task 6.4 (WebSearch MCP skill built-in) depends on Task 3.1 (Skills Injection)
- Milestone 7 depends on all preceding milestones

## Total Estimated Task Count

~22 tasks across 7 milestones
