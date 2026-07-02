# Milestone 1: Skills Audit and Baseline Documentation

## Milestone Goal

Produce a definitive audit of HyperNeo's current Skills, MCP, and Plugin implementation. Document the as-is state, the gap analysis, and an agreed-upon architecture for the Skills registry. This milestone is a prerequisite for all implementation milestones.

## Tasks

---

### Task 1.1: Skills and MCP System Audit

**Agent type:** general

**Description:**
Conduct a full code-level audit of the existing Skills, MCP, and Plugin integration in HyperNeo. Produce a structured audit document in `docs/architecture/skills-audit.md`.

**Subtasks (ordered):**

1. Read and document `packages/daemon/src/lib/agent/query-options-builder.ts` — how `Skill`, `WebSearch`, `WebFetch`, `plugins`, `mcpServers` are configured per session type.
2. Read and document all coordinator agent definitions (`packages/daemon/src/lib/agent/coordinator/`) — which tools each sub-agent receives.
3. Read and document all room agent definitions (`packages/daemon/src/lib/room/agents/`) — planner, leader, coder, general. Confirm `Skill`, `WebSearch` inclusion.
4. Read `packages/daemon/src/lib/built-in-commands.ts` — HyperNeo built-in slash commands.
5. Read `packages/daemon/src/lib/agent/slash-command-manager.ts` — how SDK slash commands are fetched, cached, and surfaced to the UI.
6. Read `packages/shared/src/sdk/sdk.d.ts` and `sdk-tools.d.ts` — confirm the SDK's `skills`, `plugins`, `SlashCommand`, `SdkPluginConfig` type definitions.
7. Read `packages/shared/src/types/sdk-config.ts` — confirm `PluginConfig`, `SDKConfig.plugins`.
8. Read `packages/shared/src/types.ts` — `ToolsConfig`, `GlobalToolsConfig`, `DEFAULT_GLOBAL_TOOLS_CONFIG`.
9. Read MCP handler `packages/daemon/src/lib/rpc-handlers/mcp-handlers.ts` — `globalTools.getConfig`, `globalTools.saveConfig`.
10. Check web UI for any existing Skills-related components.
11. Write `docs/architecture/skills-audit.md` summarizing:
    - What "Skill" means in the SDK context (slash commands from `.claude/commands/`)
    - How Plugins work (`{ type: 'local', path }` passed to SDK)
    - Which agents currently receive the `Skill` tool
    - Current planner `WebSearch` configuration
    - Gaps: no registry, no UI, no plugin management, no per-room skill overrides
    - Recommended architecture (Skills registry backed by SQLite `skills` table, using existing repository pattern)
    - Security considerations: input validation for `pluginPath` (no `../` traversal); for `mcp_server` skills `appMcpServerId` must reference an existing `app_mcp_servers` entry; for `builtin` skills `commandName` must be non-empty
    - `strictMcpConfig` compatibility: how skill-injected MCP servers must be handled

**Acceptance criteria:**
- `docs/architecture/skills-audit.md` is committed and covers all points above
- Document is accurate and agrees with the code (no hallucinated details)
- Changes are on a feature branch with a GitHub PR created via `gh pr create`

**depends_on:** []

---

### Task 1.2: Skills Registry Architecture Design

**Agent type:** general

**Description:**
Design the `AppSkill` data model, the `SkillsManager` interface, and the RPC API surface. Produce a design document in `docs/architecture/skills-registry-design.md`.

**Subtasks (ordered):**

1. Read the audit document from Task 1.1.
2. Design the `AppSkill` type with fields: `id` (uuid), `name` (unique slug), `displayName`, `description`, `sourceType` (`'builtin' | 'plugin' | 'mcp_server'`), `config` (source-specific), `enabled` (default true), `createdAt`.
3. Design source-specific config sub-types:
   - `BuiltinSkillConfig`: references an SDK slash command name from `.claude/commands/`
   - `PluginSkillConfig`: `{ pluginPath: string }` — a local plugin directory
   - `McpServerSkillConfig`: `{ appMcpServerId: string }` — references an existing `app_mcp_servers` entry by ID (MCP server config is owned by the app-level MCP registry, not duplicated in the skill)
4. Design `SkillsManager` interface: `listSkills()`, `getSkill(id)`, `addSkill(skill)`, `updateSkill(id, updates)`, `removeSkill(id)`, `getEnabledSkills()`.
5. Design persistence: **SQLite** — a new `skills` table in the existing HyperNeo database, using the same `Repository` pattern as `goal-repository.ts`. Justify: SQLite is the established persistence pattern in the codebase; it provides concurrency safety via WAL mode; no file-locking or atomic-write logic needed; consistent with all other managers.
6. Design RPC API: `skills.list`, `skills.add`, `skills.update`, `skills.remove`, `skills.get`.
7. Design per-room skill enablement: a dedicated `room_skill_overrides` table (`skill_id TEXT`, `room_id TEXT`, `enabled INTEGER`, `PRIMARY KEY (skill_id, room_id)`) — NOT the `rooms.config` JSON column. This allows `skills.byRoom` LiveQuery to reactively JOIN across both tables and receive change events when an override is added or removed.
8. Design session injection: how `PluginSkillConfig` maps to `SDKConfig.plugins`, how `McpServerSkillConfig` maps to `mcpServers`, how `BuiltinSkillConfig` is surfaced.
9. Write `docs/architecture/skills-registry-design.md` covering all above.

**Acceptance criteria:**
- `docs/architecture/skills-registry-design.md` is committed with all design decisions
- Design is compatible with existing SDK config types and HyperNeo patterns
- Changes are on a feature branch with a GitHub PR created via `gh pr create`

**depends_on:** ["Task 1.1: Skills and MCP System Audit"]
