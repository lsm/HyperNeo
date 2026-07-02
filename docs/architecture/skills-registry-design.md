# Skills Registry Architecture Design

**Date:** 2026-03-25
**Status:** Design Complete
**Parent:** [Skills & MCP System Audit](./skills-audit.md) (Task 1.1)

---

## 1. Overview

Building on the audit findings, this document specifies the design for an application-level Skills Registry that allows users to add Skills from external sources (plugin packages, MCP servers) and enable them per room/session.

The design follows the established HyperNeo patterns: SQLite persistence via the Repository pattern, reactive `notifyChange()` for LiveQuery invalidation, RPC handlers for the API surface, and `QueryOptionsBuilder` injection for session initialization.

---

## 2. `AppSkill` Data Model

### 2.1 Core Type

```typescript
// packages/shared/src/types/app-skill.ts

/**
 * Source type classification for an AppSkill.
 *
 * - 'builtin': A slash command defined in .claude/commands/ discovered at startup.
 * - 'plugin':   A local plugin directory referenced by path.
 * - 'mcp_server': A skill that surfaces MCP server tools, referenced by app_mcp_servers ID.
 */
export type AppSkillSourceType = 'builtin' | 'plugin' | 'mcp_server';

/**
 * An application-level skill registered in the global skills table.
 * Skills are configured once at the app level and may be selectively enabled per room.
 */
export interface AppSkill {
  /** UUID primary key */
  id: string;
  /** Unique slug, used as the slash-command name (e.g. "pdf", "web-search") */
  name: string;
  /** Human-readable name for UI display */
  displayName: string;
  /** What this skill does, surfaced to the agent for discovery */
  description: string;
  /** Classification of where the skill comes from */
  sourceType: AppSkillSourceType;
  /** Source-specific configuration (discriminated union below) */
  config: BuiltinSkillConfig | PluginSkillConfig | McpServerSkillConfig;
  /** Whether this skill is globally enabled (default: true) */
  enabled: boolean;
  /** Unix timestamp (ms) when the record was created */
  createdAt: number;
}
```

### 2.2 Source-Specific Config Sub-Types

```typescript
/**
 * BuiltinSkillConfig — references an SDK slash command name from .claude/commands/
 *
 * At session init, the slash command name is added to the session's availableCommands
 * so the SDK's Skill tool can resolve it to the .md file.
 */
export interface BuiltinSkillConfig {
  type: 'builtin';
  /** The slash-command name without the leading slash (e.g. "merge-session", "my-cmd") */
  commandName: string;
}

/**
 * PluginSkillConfig — a local plugin directory mapped to SDKConfig.plugins.
 *
 * The path is passed as PluginConfig { type: 'local', path } to the SDK subprocess.
 * Path must be validated to prevent directory-traversal attacks (see Section 8.1).
 */
export interface PluginSkillConfig {
  type: 'plugin';
  /** Absolute or workspace-relative path to a plugin directory */
  pluginPath: string;
}

/**
 * McpServerSkillConfig — references an existing app_mcp_servers entry by ID.
 *
 * MCP server configuration is owned by the app-level MCP registry (app_mcp_servers table).
 * A skill of type 'mcp_server' simply surfaces those already-registered servers to a room.
 * The skill's config points at the app_mcp_servers.id; no config is duplicated.
 *
 * At session init, the referenced AppMcpServer is converted to SDK McpServerConfig
 * and merged into Options.mcpServers (see Section 9.3).
 */
export interface McpServerSkillConfig {
  type: 'mcp_server';
  /** References an existing app_mcp_servers.id */
  appMcpServerId: string;
}
```

### 2.3 Design Rationale

- **`sourceType` as a flat enum** (instead of embedding type in config) allows efficient SQL filtering and indexing.
- **`McpServerSkillConfig.appMcpServerId`** is a reference, not embedded config — this avoids duplication and ensures the MCP lifecycle manager owns validation. If the underlying MCP server has errors, the skill is effectively broken.
- **`name`** is the slash-command slug — must be unique and contain only `[a-z0-9-]`. This maps directly to the SDK's `SlashCommand.name`.
- **`displayName`** is separate from `name` to allow spaces and capitalisation for UI.

---

## 3. SQLite Schema

### 3.1 `skills` Table

```sql
CREATE TABLE skills (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  source_type   TEXT NOT NULL CHECK(source_type IN ('builtin', 'plugin', 'mcp_server')),
  config        TEXT NOT NULL,  -- JSON: BuiltinSkillConfig | PluginSkillConfig | McpServerSkillConfig
  enabled       INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL
);
```

- `config` is a JSON column serialising the discriminated config union.
- `created_at` is Unix ms (not ISO string — consistent with other HyperNeo tables).
- `id` is generated client-side with `generateUUID()` (same pattern as `GoalRepository`).

### 3.2 `room_skill_overrides` Table

```sql
CREATE TABLE room_skill_overrides (
  skill_id  TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  room_id   TEXT NOT NULL,
  enabled   INTEGER NOT NULL,
  PRIMARY KEY (skill_id, room_id)
);
```

**Why a dedicated table (not `rooms.config` JSON column):**

The LiveQuery system watches named SQL queries. A `room_skill_overrides` table with its own row-level change events enables `skills.byRoom` named query to reactively JOIN across both tables and receive `notifyChange()` events on every override insert/update/delete. Storing overrides inside `rooms.config` JSON would require modifying `rooms` rows on every override change, firing unrelated LiveQuery subscriptions.

### 3.3 Migration

A new migration (after migration 50) will add both tables using `CREATE TABLE IF NOT EXISTS` for idempotency.

---

## 4. `SkillRepository` Pattern

Located at `packages/daemon/src/storage/repositories/skill-repository.ts`, following the same constructor and method-signature conventions as `GoalRepository` and `AppMcpServerRepository`:

```typescript
export class SkillRepository {
  constructor(
    private db: BunDatabase,
    private reactiveDb: ReactiveDatabase,
  ) {}

  // CREATE
  createSkill(params: CreateSkillParams): AppSkill;
  upsertSkillOverride(roomId: string, skillId: string, enabled: boolean): void;

  // READ
  getSkill(id: string): AppSkill | null;
  getSkillByName(name: string): AppSkill | null;
  listSkills(enabledOnly?: boolean): AppSkill[];
  listSkillsForRoom(roomId: string): AppSkill[];  // global + overrides applied
  getSkillOverride(roomId: string, skillId: string): boolean | null;  // null = no override

  // UPDATE
  updateSkill(id: string, params: UpdateSkillParams): AppSkill | null;
  removeSkillOverride(roomId: string, skillId: string): void;

  // DELETE
  deleteSkill(id: string): boolean;
}
```

**Key behaviours:**
- Every mutating method calls `this.reactiveDb.notifyChange('skills')`.
- `upsertSkillOverride` uses `ON CONFLICT ... DO UPDATE` (same pattern as `RoomMcpEnablementRepository`).
- `listSkillsForRoom` performs a LEFT JOIN of `skills` with `room_skill_overrides`, applying overrides to the `enabled` field.

---

## 5. `SkillsManager` Interface

Located at `packages/daemon/src/lib/skills/skills-manager.ts`. The Manager wraps the Repository and adds business logic:

```typescript
export interface SkillsManager {
  // Derived from SkillRepository (direct pass-through)
  listSkills(): AppSkill[];
  getSkill(id: string): AppSkill | null;
  listSkillsForRoom(roomId: string): AppSkill[];

  // Business logic
  addSkill(params: CreateSkillParams): AppSkill;
  updateSkill(id: string, updates: UpdateSkillParams): AppSkill | null;
  removeSkill(id: string): boolean;

  // Per-room overrides
  setRoomSkillEnabled(roomId: string, skillId: string, enabled: boolean): void;
  getRoomSkillEnabled(roomId: string, skillId: string): boolean | null;  // null = use global
  resetRoomSkillOverrides(roomId: string): void;

  // Validation helpers (used by async validation job)
  validateSkill(skill: AppSkill): Promise<ValidationResult>;
}

export interface CreateSkillParams {
  name: string;
  displayName: string;
  description?: string;
  sourceType: AppSkillSourceType;
  config: BuiltinSkillConfig | PluginSkillConfig | McpServerSkillConfig;
  enabled?: boolean;
}

export interface UpdateSkillParams {
  displayName?: string;
  description?: string;
  enabled?: boolean;
  config?: BuiltinSkillConfig | PluginSkillConfig | McpServerSkillConfig;
}
```

---

## 6. RPC API Surface

Handlers registered in `packages/daemon/src/lib/rpc-handlers/skills-handlers.ts`:

| RPC Method | Direction | Description |
|-----------|-----------|-------------|
| `skills.list` | request/response | List all skills in the global registry |
| `skills.get` | request/response | Get a single skill by ID |
| `skills.add` | request/response | Create a new skill (returns created record) |
| `skills.update` | request/response | Partial update (enabled, displayName, description, config) |
| `skills.remove` | request/response | Delete a skill by ID |
| `skills.listForRoom` | request/response | List skills for a room with per-room overrides applied |
| `skills.setRoomEnabled` | request/response | Upsert a per-room override for one skill |
| `skills.resetRoomOverrides` | request/response | Remove all per-room overrides for a room |

### Request / Response Shapes

```typescript
// skills.list → AppSkill[]
// skills.get  → AppSkill | null
// skills.add  → AppSkill
type SkillsListResponse  = AppSkill[];
type SkillsGetResponse   = { skill: AppSkill | null };
type SkillsAddResponse   = { skill: AppSkill };
type SkillsUpdateResponse = { skill: AppSkill | null };
type SkillsRemoveResponse = { deleted: boolean };

// skills.listForRoom → { skills: RoomSkill[] }
interface RoomSkill {
  skill: AppSkill;
  enabled: boolean;       // global or override value
  hasOverride: boolean;   // true if this row comes from room_skill_overrides
}
type SkillsListForRoomResponse = { skills: RoomSkill[] };

// skills.setRoomEnabled
type SkillsSetRoomEnabledRequest  = { roomId: string; skillId: string; enabled: boolean };
type SkillsSetRoomEnabledResponse = {};

// skills.resetRoomOverrides
type SkillsResetRoomOverridesRequest  = { roomId: string };
type SkillsResetRoomOverridesResponse = {};
```

---

## 7. LiveQuery Integration

### 7.1 Named Queries

Two named queries are registered in `live-query-handlers.ts`:

```typescript
// skills.list — all skills, optionally filtered by enabled
NAMED_QUERY_REGISTRY.set('skills.list', {
  sql: `SELECT id, name, display_name AS displayName, description,
               source_type AS sourceType, config, enabled, created_at AS createdAt
        FROM skills
        ORDER BY created_at ASC`,
  paramCount: 0,
  mapRow: mapSkillRow,
});

// skills.byRoom — skills for a room with per-room overrides applied
NAMED_QUERY_REGISTRY.set('skills.byRoom', {
  sql: `SELECT s.id, s.name, s.display_name AS displayName, s.description,
              s.source_type AS sourceType, s.config,
              COALESCE(rso.enabled, s.enabled) AS enabled,
              (rso.skill_id IS NOT NULL) AS hasOverride,
              s.created_at AS createdAt
        FROM skills s
        LEFT JOIN room_skill_overrides rso ON rso.skill_id = s.id AND rso.room_id = ?
        ORDER BY s.created_at ASC`,
  paramCount: 1,
  mapRow: mapSkillRow,
});
```

### 7.2 Change Notification

Every mutating repository method calls `this.reactiveDb.notifyChange('skills')`, which invalidates all active `skills.list` subscriptions. The `skills.byRoom` subscription is independently invalidated when `room_skill_overrides` changes (the repository also calls `notifyChange('room_skill_overrides')`).

---

## 8. Session Injection via `QueryOptionsBuilder`

### 8.1 `PluginSkillConfig` → `SDKConfig.plugins`

```typescript
// Inside QueryOptionsBuilder.build() or a new getSkillPlugins() helper
private getSkillPlugins(skills: AppSkill[]): PluginConfig[] {
  return skills
    .filter((s) => s.sourceType === 'plugin' && s.enabled)
    .map((s) => {
      const config = s.config as PluginSkillConfig;
      // Path validation — reject traversal attempts
      if (!isSafePath(config.pluginPath, this.ctx.session.workspaceRoot)) {
        throw new Error(`Unsafe plugin path: ${config.pluginPath}`);
      }
      return { type: 'local', path: config.pluginPath };
    });
}
```

`isSafePath` validates that the resolved path does not escape the workspace root:
```typescript
function isSafePath(path: string, baseDir: string): boolean {
  const resolved = path.startsWith('/')
    ? path
    : join(baseDir, path);
  const canonical = realpathSync(resolved);
  return canonical.startsWith(realpathSync(baseDir)) && !path.includes('..');
}
```

### 8.2 `McpServerSkillConfig` → `Options.mcpServers`

```typescript
private async getSkillMcpServers(skills: AppSkill[]): Promise<Record<string, McpServerConfig>> {
  const mcpSkills = skills.filter((s) => s.sourceType === 'mcp_server' && s.enabled);
  if (mcpSkills.length === 0) return {};

  const servers = this.db.appMcpServers.getServersByIds(
    mcpSkills.map((s) => (s.config as McpServerSkillConfig).appMcpServerId)
  );

  const result: Record<string, McpServerConfig> = {};
  for (const server of servers) {
    if (server.sourceType === 'stdio') {
      result[server.name] = {
        type: 'stdio',
        command: server.command!,
        args: server.args ?? [],
        env: server.env ?? {},
      };
    } else if (server.sourceType === 'sse') {
      result[server.name] = { type: 'sse', url: server.url!, headers: server.headers };
    } else if (server.sourceType === 'http') {
      result[server.name] = { type: 'http', url: server.url!, headers: server.headers };
    }
  }
  return result;
}
```

### 8.3 `BuiltinSkillConfig` → `availableCommands`

For builtin skills, the `commandName` is added to the session's `availableCommands` list so the SDK's `Skill` tool can resolve the slash command:

```typescript
// In SlashCommandManager or QueryOptionsBuilder
const builtinSkills = skills.filter((s) => s.sourceType === 'builtin' && s.enabled);
for (const skill of builtinSkills) {
  const config = skill.config as BuiltinSkillConfig;
  session.availableCommands.push({ name: config.commandName, description: skill.description });
}
```

### 8.4 `strictMcpConfig` Compatibility

When `strictMcpConfig: true` (room_chat sessions), skill-derived MCP servers are merged into `Options.mcpServers` at query-build time — they are never discovered via settings files. This is already the case for room-configured MCP servers; skill servers follow the same injection path.

---

## 9. File Structure

```
packages/
  shared/src/
    types/
      app-skill.ts           # AppSkill, config types, request/response types

  daemon/src/
    storage/
      schema/
        index.ts             # Add skills + room_skill_overrides CREATE TABLE statements
        migrations.ts        # New migration N: add skills + room_skill_overrides
      repositories/
        skill-repository.ts   # SkillRepository (full CRUD + override methods)

    lib/
      skills/
        skills-manager.ts    # SkillsManager (business logic, validation)
      rpc-handlers/
        skills-handlers.ts   # All skills.* RPC handlers
        live-query-handlers.ts  # Register skills.list + skills.byRoom named queries

    lib/agent/
      query-options-builder.ts  # Merge skill plugins + MCP servers at session init
```

---

## 10. Compatibility with Existing Audit Findings

| Audit Finding | Design Response |
|--------------|----------------|
| No app-level skills registry | New `skills` SQLite table + `SkillRepository` + `SkillsManager` |
| No per-room skill overrides | New `room_skill_overrides` table + `upsertSkillOverride()` |
| `strictMcpConfig` blocks settings-file discovery | Skill MCP servers injected into `Options.mcpServers` at query-build time |
| Path traversal risk for local plugins | `isSafePath()` validation before passing `pluginPath` to SDK |
| MCP skill config duplication risk | `McpServerSkillConfig` references `app_mcp_servers.id` — single source of truth |
| No LiveQuery for skills | Named queries `skills.list` + `skills.byRoom` with `notifyChange()` |

---

## 11. Open Questions / Future Extensions

1. **Async skill validation job** — A background job (using the existing job queue pattern) that spawns each newly added skill and verifies it responds within a timeout. Not in scope for Task 1.2 but noted for Task 2.5.

2. **npm/Python skill source types** — The audit mentioned `npm` and `python` as source types. These require a skill executor that can spawn external processes. Deferred to a future task after the `plugin` and `mcp_server` types are validated.

3. **Skill version/pinning** — No version field is included in `AppSkill` for this iteration. A future version of the schema may add `version` or `packageSpec` fields for reproducible installs.

4. **Skill invocation logging** — Tracking which skill was invoked in which session is useful for audit/debugging. This can be added as a `skill_invocation_log` table in a future task.
