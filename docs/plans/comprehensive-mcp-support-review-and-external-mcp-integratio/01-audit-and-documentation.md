# Milestone 1: Audit and Documentation

## Milestone Goal

Produce a comprehensive audit of HyperNeo's current MCP support covering server registration, tool distribution, session/room integration, and identify all gaps that the subsequent milestones address.

## Scope

Read-only investigation — no code changes. Output is a Markdown document committed to the repo.

---

## Task 1.1: MCP Architecture Audit

**Agent type:** general

**Description:**
Conduct a thorough audit of the current MCP support in HyperNeo. Produce a structured report at `docs/mcp-audit.md`.

**Subtasks (ordered):**

1. Read `packages/daemon/src/lib/settings-manager.ts` — understand `listMcpServersFromSources()` and `getEnabledMcpServersConfig()` and how servers are read from `.mcp.json`, `settings.json`.
2. Read `packages/daemon/src/lib/agent/query-options-builder.ts` — understand how `getMcpServers()` assembles the `mcpServers` option passed to the SDK, and the special handling for `room_chat` sessions (strict mode, wildcard allow-listing).
3. Read `packages/daemon/src/lib/agent/agent-session.ts` — understand `setRuntimeMcpServers()` and how runtime MCP servers are merged at query time.
4. Read `packages/daemon/src/lib/room/runtime/room-runtime-service.ts` — understand how `getEnabledMcpServersConfig()` feeds into `setRuntimeMcpServers()` alongside `room-agent-tools`.
5. Read `packages/daemon/src/lib/room/agents/planner-agent.ts` — understand the plan-writer sub-agent's tool list. Note: both the Planner and plan-writer already include `WebFetch` and `WebSearch` as built-in tools; document this as an existing capability (not a gap).
6. Read `packages/daemon/src/lib/room/agents/coder-agent.ts` and `general-agent.ts` — understand how worker agents receive (or don't receive) MCP servers.
7. Read `packages/daemon/src/lib/rpc-handlers/mcp-handlers.ts` and `settings-handlers.ts` — catalogue all existing MCP-related RPC endpoints.
8. Read `packages/web/src/components/settings/McpServersSettings.tsx` — understand the existing UI for toggling MCP servers.
9. Read `packages/shared/src/types/sdk-config.ts` (McpStdioServerConfig, McpSSEServerConfig, McpHttpServerConfig) and `packages/shared/src/types/settings.ts` (FileOnlySettings, McpServerSettings).
10. Write `docs/mcp-audit.md` covering: (a) how MCPs are registered today, (b) server types supported, (c) tool distribution chain, (d) per-session vs per-room vs global granularity, (e) gaps: no app-level registry, no UI to add servers, no per-room enablement UI. **Note:** planner web search is NOT a gap — `WebFetch` and `WebSearch` are already in both the Planner and plan-writer tool lists.

**Acceptance criteria:**
- `docs/mcp-audit.md` exists and is committed on a feature branch.
- The document covers all five audit areas listed in subtask 10.
- A GitHub PR is created via `gh pr create` targeting `dev`.

**Depends on:** (none)

**Notes:**
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`.
- **Feedback loop:** If the audit uncovers a critical architectural gap not already addressed in this plan (e.g., a third injection path, an undocumented session type that uses MCPs, a constraint that invalidates the proposed merge strategy), the implementing agent must flag it explicitly in `docs/mcp-audit.md` under a "**Plan Adjustments Required**" section. The plan owner should review that section before Milestone 2 implementation begins. This ensures audit findings feed back into the implementation milestones rather than being silently discarded.
