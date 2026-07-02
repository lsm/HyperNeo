# Unify MCP Configuration Model

## Goal

Collapse HyperNeo's six overlapping MCP configuration sources into a single registry with a single override table. Remove SDK-auto-load pathways so every server the SDK sees is explicitly placed there by HyperNeo. This eliminates a class of bugs where toggles in one UI silently don't apply because another pathway still injects the server.

## Motivation — current state

Today, the same "is server X active for this session?" question can be answered by six independent mechanisms. At least two of them disagree in real sessions:

| Source | Scope | How it enters SDK |
|---|---|---|
| `~/.claude/settings.json` MCPs | global user | `settingSources: ['project','local']` auto-load |
| Project `.mcp.json` | workspace | same |
| `.claude/settings.local.json` (`disabledMcpjsonServers`) | workspace-shared file | same |
| `GlobalSettings.disabledMcpServers` (string[]) | app global | written into `settings.local.json` |
| `GlobalSettings.mcpServerSettings` (`{allowed, defaultOn}`) | app global | fed into `ToolsConfigManager.getDefaultForNewSession()` |
| `app_mcp_servers` + skills bridge | app global + per-room override (`room_mcp_enablement`) | `QueryOptionsBuilder.getMcpServersFromSkills()` |
| `Session.config.tools.disabledMcpServers` | per-session | `filterDisabledMcpServers()` + written to workspace `settings.local.json` |
| Runtime-attached (`space-agent-tools`, `db-query`, `task-agent`, `node-agent`, `room-tools`) | per-session | `mergeRuntimeMcpServers()` / `setRuntimeMcpServers()` |

### Concrete defects this causes

1. **`.mcp.json` bypass (Part A reproducer).** Space ad-hoc, `space_task_agent`, and node-agent sessions run with `strictMcpConfig: false` and `settingSources: ['project','local']`, so the SDK auto-loads project `.mcp.json` regardless of what HyperNeo's UI says. Disabling chrome anywhere in HyperNeo has zero effect on the chrome entry defined in `.mcp.json`.
2. **Workspace leakage.** Per-session "disable X" writes to workspace-shared `.claude/settings.local.json`. Last session to build query options wins; concurrent sessions fight over the same file.
3. **Redundant global state.** `disabledMcpServers` (string[]) and `mcpServerSettings` ({allowed, defaultOn}) both exist and are both consumed. `ToolsConfigManager.getDefaultForNewSession()` reads the second to derive the first.
4. **Dead-write RPCs.** `settings.mcp.toggle` and `settings.mcp.setDisabled` still mutate `GlobalSettings.disabledMcpServers` even though the UI that wrote them was removed.
5. **No per-space override.** Rooms can opt in/out of registry entries via `room_mcp_enablement`; spaces cannot. Spaces silently inherit workspace-level settings.
6. **Asymmetric coordinator rules.** `space_chat` and `room_chat` are strict (`strictMcpConfig: true`, `settingSources: []`); their orchestrator siblings (`space_task_agent`, node-agents) are not. Coordinators get a vetted MCP set; the workers they spawn don't.

## Target architecture

**One registry + one override table + one resolver + strict SDK wiring.**

### Registry (single source of truth)

The existing `app_mcp_servers` table, extended:

- `id`, `name`, `config` (SDK-shape MCP config) — already present
- `enabled` (bool) — global default on/off
- `source` ∈ `builtin` | `user` | `imported` — new. `builtin` for seeded entries (e.g. chrome-devtools-mcp seed), `user` for rows added via UI, `imported` for rows discovered on disk.

Every MCP the user could ever toggle lives here. No ambient MCP-from-a-file path.

### Project `.mcp.json` — import, don't auto-load

On daemon startup and on workspace change, scan project `.mcp.json` + `~/.claude/.mcp.json`. For each entry:
- If a matching `app_mcp_servers` row (by `name` + equivalent `config`) exists, no-op.
- Otherwise, upsert with `source: 'imported'`, `enabled: false` (user has to explicitly accept before it's used).

This preserves the Claude Code convention ("drop a `.mcp.json` into your repo") while routing every toggle through the registry. Rows keep a `sourcePath` field so the UI can show "imported from ./project/.mcp.json" and offer a "remove import" action.

### Overrides (one generalized table)

Rename `room_mcp_enablement` → `mcp_enablement` with a `scope_type` column:

```sql
CREATE TABLE mcp_enablement (
  server_id   TEXT NOT NULL REFERENCES app_mcp_servers(id),
  scope_type  TEXT NOT NULL CHECK (scope_type IN ('space','room','session')),
  scope_id    TEXT NOT NULL,
  enabled     INTEGER NOT NULL,
  PRIMARY KEY (server_id, scope_type, scope_id)
);
```

Missing row = inherit. Present row = explicit override. This is the only place "is X enabled for scope Y?" can be written to.

### Resolver (one pure function)

```ts
function resolveMcpServers(session, registry, overrides): McpServerMap {
  const globallyEnabled = registry.filter(s => s.enabled);
  const withOverrides = applyOverrides(globallyEnabled, overrides, [
    ['space',   session.context?.spaceId],
    ['room',    session.context?.roomId],
    ['session', session.id],
  ]);
  return Object.fromEntries(
    withOverrides.map(s => [s.name, toSdkConfig(s.config)])
  );
}
```

Called once in `QueryOptionsBuilder.build()`. Runtime-attached builtins (space-agent-tools, etc.) are merged on top after — they're not overridable because they're the agent's own coordination surface.

### Strict SDK wiring for all session types

- `strictMcpConfig: true` unconditionally
- `settingSources: []` unconditionally

After this:
- `.mcp.json` auto-load no longer happens — the SDK only sees what the resolver returned
- `settings.local.json` `disabledMcpjsonServers` writes become dead code (remove)
- Asymmetry between coordinator/worker session types disappears

### UI changes

- **Global MCP Servers page** (already renamed to primary `MCP Servers` tab after `McpServersSettings.tsx` deletion): becomes the registry CRUD + global enable/disable. Shows `source` badge (builtin/user/imported).
- **Space settings → MCP overrides** (new): per-space enable/disable checklist against the global set.
- **Room settings → MCP overrides**: current UI, repointed at `mcp_enablement` with `scope_type='room'`.
- **Session Tool Modal**: lists effective set with source badges; each row has a per-session override toggle that writes `scope_type='session'`. The existing "Agent Runtime Tools" section remains read-only.

## What gets deleted

- `GlobalSettings.disabledMcpServers` (field + migrations + RPC writers)
- `GlobalSettings.mcpServerSettings` (field + `toggleMcpServer` / `setDisabledMcpServers` logic)
- RPCs: `settings.mcp.toggle`, `settings.mcp.setDisabled`
- `settings.local.json` writes for `disabledMcpjsonServers`, `enabledMcpjsonServers`, `enableAllProjectMcpServers` (in `SettingsManager.writeFileOnlySettings`)
- `ToolsConfigManager.getDefaultForNewSession()` disabled-derivation branch
- `QueryOptionsBuilder.filterDisabledMcpServers()` + the `disabledMcpServers` plumb through `Session.config.tools`
- `getSettingsOptions()` on QueryOptionsBuilder (no longer needed — no settings to derive)
- Per-session `Session.config.tools.disabledMcpServers` (replaced by `mcp_enablement` session-scope rows)

## Milestones

Work lands in order; each milestone is independently shippable and reduces the surface area of the next.

### M1 — Kill the `.mcp.json` leak (fast win, unblocks Part A)

**Scope**: force `strictMcpConfig: true` + `settingSources: []` for every session type in `QueryOptionsBuilder.build()`. Keep everything else intact (registry, filters, etc.).

**Effect**: `.mcp.json` auto-load stops. Users who rely on `.mcp.json` entries will notice them disappearing from non-coordinator sessions — acceptable because M2 imports them back.

**Risk**: `.mcp.json` auto-load disappears until the user explicitly accepts imported rows in M2. Gate behind a kill switch (`NEOKAI_LEGACY_MCP_AUTOLOAD=1`) for one release if needed.

**Kill switch semantics.** When `NEOKAI_LEGACY_MCP_AUTOLOAD=1` is set, `QueryOptionsBuilder.build()` preserves the *pre-M1* asymmetry: coordinators (`space_chat`, `room_chat`) stay strict with empty `settingSources`; workers / task agents / ad-hoc sessions retain `settingSources: ['project', 'local']` and `strictMcpConfig: false`. The flag does NOT globally re-enable auto-load across all session types — that would regress the coordinator hardening we already have. Implementation: one conditional per session type inside `build()`, guarded by the env var.

**Tests**:
- Daemon unit: `query-options-builder.test.ts` — all session types have `strictMcpConfig: true` and empty `settingSources`
- Online: Space ad-hoc session should NOT see `chrome-devtools` when defined only in project `.mcp.json`

### M2 — `.mcp.json` import path

**Scope**: add `source` + `sourcePath` columns to `app_mcp_servers`. On workspace attach, scan `.mcp.json` and upsert rows with `source: 'imported'`, `enabled: false`. UI shows import badge + accept/remove actions. Accepting flips `enabled: true`.

**Effect**: users get the Claude Code convention back, but gated on an explicit accept. No ambient injection.

**When scanning happens.** Only on explicit workspace-level triggers: daemon startup (for each registered workspace), workspace add/change events, and a user-initiated "Refresh imports" button in the MCP Servers panel. `session.create` must never touch the filesystem — scanning on every session is a latency trap and a silent fd/stat dependency. Treat the registry as the only source the session path reads from.

**Dedupe key.** `(sourcePath, name)`. Rationale: one `.mcp.json` can define multiple servers, so `name` alone collides across files; `sourcePath` alone can't distinguish servers within a single file. If a user renames a server in `.mcp.json`, the old row is deleted (the old name disappeared from that sourcePath) and a new `imported+disabled` row appears under the new name — the rename is treated as a remove + add, intentionally, so the user has to re-accept. A future "rename detection" heuristic can be added if this proves annoying.

**Tests**:
- Repository unit tests for idempotent upsert under the dedupe key (same `.mcp.json` re-scanned = no duplicates; renaming a server in-place produces remove+add)
- E2E: drop a `.mcp.json`, see the imported row appear disabled, enable it, verify it reaches a session
- Unit: `session.create` does not call any `.mcp.json` scan path (observable via spy on the scanner)

### M3 — Generalize `mcp_enablement`

**Scope**: schema migration rename `room_mcp_enablement` → `mcp_enablement`, add `scope_type` column (default `'room'` for existing rows). Introduce `resolveMcpServers()` helper; wire into `QueryOptionsBuilder`. Per-session override path replaces `Session.config.tools.disabledMcpServers`.

**Effect**: unified resolver. Per-room control unchanged (data migrated). Per-session control moves from session config to enablement table.

**Tests**:
- Unit tests on resolver (precedence, missing-row-inherits, etc.)
- Migration test that a pre-migration `room_mcp_enablement` row round-trips
- Online: space override beats global; session override beats space

### M4 — Per-space override UI

**Scope**: space settings panel gains an MCP checklist. Writes `scope_type: 'space'` rows.

**Tests**:
- E2E: enable a server globally, disable it for space A, confirm it's absent in space A sessions but present in non-space sessions

### M5 — Dead-code purge

**Scope**: remove everything in the "What gets deleted" list above. One PR per logical chunk:
- Purge `GlobalSettings.disabledMcpServers` + RPCs
- Purge `GlobalSettings.mcpServerSettings` + `ToolsConfigManager` branch
- Purge `settings.local.json` writes
- Purge `filterDisabledMcpServers` + session tools config field

**Tests**: existing test suite should pass; any test that specifically exercises the removed paths is deleted (not adapted).

### M6 — Session Tool Modal overrides

**Scope**: add per-session override toggles to the existing Tool Modal. Writes `scope_type: 'session'`.

**Tests**:
- Vitest: toggle writes the correct enablement row, refresh preserves state
- E2E: toggle in modal, send a turn, confirm tool (un)available

## Non-goals

- Hot-reload of MCP servers mid-session. Today task agents freeze their MCP set at spawn; we keep that behavior.
- Secrets UI (env-var editor) redesign. Current `AppMcpServersSettings` env handling stays.
- Removing the Claude Code `.mcp.json` convention — we import, not abandon.

## Open questions

1. Should `imported` rows auto-enable when they originated from a `.mcp.json` the user manually committed? Argues for yes (low friction) vs. no (explicit is better). Default to no; add a `trustLocalMcpJson` global setting if enough users complain.
2. ~~Workspace-change detection~~ — *resolved in M2 scope above: scan on workspace attach/change + explicit refresh button; never on session.create.*
3. Do we want a fourth scope (`user` / `workspace`) between global and space? Probably not for v1 — YAGNI.
