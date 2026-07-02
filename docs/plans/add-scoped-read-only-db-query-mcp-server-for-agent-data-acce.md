# Plan: Add Scoped Read-Only DB-Query MCP Server for Agent Data Access

## Goal Summary

Create an in-process `db-query` MCP server that gives agent sessions safe, scoped, read-only access to the daemon's SQLite database. One instance per agent session, initialized with the appropriate entity scope (global/room/space). This enables agents to answer questions about system state (tasks, goals, sessions, etc.) without needing dedicated MCP tools for every query pattern.

## Approach

Follow the established `createSdkMcpServer` pattern used by `room-agent-tools`, `task-agent-tools`, `space-agent-tools`, and `neo-query-tools`. The server provides three tools:

1. **`db_query`** -- Execute a read-only SQL `SELECT` against allowed tables, with automatic scope filtering and result size limits.
2. **`db_list_tables`** -- List tables accessible to the current scope.
3. **`db_describe_table`** -- Show column schema for an accessible table.

### Safety Layers (Defense in Depth)

The security model has a clear hierarchy. The **primary** defense against writes is the SQLite connection itself (`readonly: true` + `PRAGMA query_only = ON`). Everything else is supplementary:

| Layer | Mechanism | Purpose |
|-------|-----------|---------|
| **Primary** | `new Database(path, { readonly: true })` | File-level write rejection |
| **Primary** | `PRAGMA query_only = ON` | SQL-level write rejection (catches `CREATE TEMP TABLE`, `ATTACH`) |
| **Supplementary** | Regex-based SQL validation | Early-reject obvious non-SELECT statements before reaching SQLite |
| **Supplementary** | Table access list per scope | Restrict which tables each scope can reference |
| **Supplementary** | Column blacklist per table | Exclude known-sensitive columns (e.g., `session_context`, `config`) |
| **Supplementary** | Auto-injected scope subquery filter | Agents cannot read rows outside their entity scope |
| **Supplementary** | Row limit cap | Prevent large result sets (max 1000 rows, default 200) |
| **Supplementary** | `PRAGMA busy_timeout = 5000` | WAL-compatible concurrent reader |

**Important:** The regex-based SQL validator is an **early-rejection optimization**, not a security boundary. It provides helpful error messages to the agent (e.g., "only SELECT statements are allowed") before the query hits SQLite. The actual write prevention relies on `readonly: true` + `PRAGMA query_only = ON`. The validator's acceptance criteria are about rejecting obvious non-SELECT patterns, not about being a complete SQL parser.

### Scope Types

Three scope types, mapped from session context:

| Scope | Source | Filter Mechanism |
|-------|--------|-----------------|
| `global` | Neo agent (no roomId/spaceId) | No filter injection, all non-sensitive tables |
| `room` | Room chat, worker, leader sessions | Per-table scope filter (direct or indirect join) |
| `space` | Space chat, task agent sessions | Per-table scope filter (direct or indirect join) |

### Table Access by Scope

Tables are categorized by scope with their filtering mechanism:

**Room-scoped tables:**
| Table | Scope Column | Filter Type |
|-------|-------------|-------------|
| `tasks` | `room_id` | Direct |
| `goals` | `room_id` | Direct |
| `mission_executions` | `goal_id` -> `goals.room_id` | Indirect join |
| `mission_metric_history` | `goal_id` -> `goals.room_id` | Indirect join |
| `room_github_mappings` | `room_id` | Direct |
| `room_mcp_enablement` | `room_id` | Direct |
| `room_skill_overrides` | `room_id` | Direct |

**Space-scoped tables:**
| Table | Scope Column | Filter Type |
|-------|-------------|-------------|
| `space_agents` | `space_id` | Direct |
| `space_workflows` | `space_id` | Direct |
| `space_workflow_steps` | `workflow_id` -> `space_workflows.space_id` | Indirect join |
| `space_workflow_runs` | `space_id` | Direct |
| `space_tasks` | `space_id` | Direct |
| `space_worktrees` | `space_id` | Direct |
| `gate_data` | `run_id` -> `space_workflow_runs.space_id` | Indirect join |
| `channel_cycles` | `run_id` -> `space_workflow_runs.space_id` | Indirect join |

**Global tables (no scope filter):**
`sessions`, `rooms`, `spaces`, `app_mcp_servers`, `skills`, `inbox_items`, `neo_activity_log`, `job_queue`, `short_id_counters`

**Always excluded (all scopes):**
- `auth_config`, `global_tools_config`, `global_settings` -- contain credentials/API keys
- `sdk_messages` -- excluded due to size (millions of rows) and limited analytical value; agents have other tools for message history
- `session_groups`, `session_group_members`, `task_group_events` -- internal session lifecycle infrastructure tables, not useful for agent data analysis

**Dropped tables (not in current schema, do not include):**
- `space_session_groups`, `space_session_group_members` -- dropped in migration 60
- `space_workflow_transitions` -- dropped in migration 59

**Not classified -- intentionally deferred:**
- `spaces` table is in global scope, meaning space-scoped agents cannot directly query their own space record. This is intentional: space agents have other MCP tools for space metadata access, and adding `spaces` to space scope would be misleading since it has no per-row space_id filter (every space-scoped agent can only see one space).

### Scope Filter Injection Strategy

Instead of string-manipulating WHERE clauses into arbitrary SQL (fragile for CTEs, subqueries, UNION, ORDER BY), use a **subquery wrapping** approach:

```sql
-- Agent provides:  SELECT * FROM tasks WHERE status = 'active' ORDER BY created_at
-- System wraps:    SELECT * FROM (SELECT * FROM tasks WHERE status = 'active' ORDER BY created_at) AS _dbq WHERE room_id = ?
```

For tables with indirect scope (e.g., `mission_executions` -> `goals.room_id`):

```sql
-- Agent provides:  SELECT * FROM mission_executions WHERE status = 'completed'
-- System wraps:    SELECT * FROM (SELECT * FROM mission_executions WHERE status = 'completed') AS _dbq WHERE goal_id IN (SELECT id FROM goals WHERE room_id = ?)
```

The wrapping approach handles all SQL edge cases (CTEs, subqueries, UNION, ORDER BY, GROUP BY) without needing to parse SQL structure.

**Cross-scope join prevention:** The regex validator extracts table references from FROM/JOIN clauses. If any referenced table is outside the current scope's table list, the query is rejected before execution. This prevents a room-scoped agent from joining to space tables.

**Multi-table queries:** If a query references multiple tables (e.g., `tasks JOIN goals`), the inner subquery uses `SELECT *` (not the user's column selection) to ensure all scope columns are available in the outer `_dbq`. The user's column selection is applied after scope filtering. When multiple tables share a scope column name (e.g., both `tasks` and `goals` have `room_id`), the outer WHERE clause qualifies with the `_dbq` alias to avoid ambiguity: `_dbq.room_id = ?`. If different tables in the same query require different scope filters (e.g., one direct, one indirect), each filter is combined with AND and column names are qualified. All referenced tables must be in the same scope.

```sql
-- Agent provides:  SELECT me.status, g.title FROM mission_executions me JOIN goals g ON me.goal_id = g.id
-- System wraps:    SELECT me.status, g.title FROM (
--                     SELECT * FROM mission_executions me JOIN goals g ON me.goal_id = g.id
--                   ) AS _dbq
--                   WHERE _dbq.goal_id IN (SELECT id FROM goals WHERE room_id = ?)
```

### Connection Management

Each MCP server instance gets **one read-only connection**, created at server initialization time, closed when the session/runtime is torn down. No pool abstraction needed -- SQLite read-only connections are cheap in WAL mode.

```typescript
// Connection setup (at MCP server creation)
const db = new Database(dbPath, { readonly: true });
db.exec('PRAGMA busy_timeout = 5000');
db.exec('PRAGMA query_only = ON');
```

### Column Access Strategy

Use a **column blacklist** per table instead of a whitelist. Blacklisted columns are excluded from `db_describe_table` output and from `SELECT *` expansion. New columns added by future migrations are automatically visible unless explicitly blacklisted.

Blacklists are **global per-table**, not scope-dependent — a column blacklisted on `sessions` (e.g., `session_context`) is excluded regardless of whether the query runs under global, room, or space scope. The `getBlacklistedColumns(tableName)` function takes only the table name, not the scope type.

**Blacklisted columns (all scopes):**
- `session_context` (on `sessions`) -- JSON with IDs that could enable cross-session access
- `config` (on `rooms`, `spaces`) -- may contain sensitive JSON blobs
- `oauth_token_encrypted` (if present)
- `restrictions` (on `tasks`) -- internal use

### Schema Evolution

A unit test in Task 5 will compare the scope config's table list against the actual live schema. If tables exist in the DB but are not in any scope config and not in the exclusion list, the test fails, flagging that the config needs updating. This prevents the table list from silently going stale when new migrations add tables.

### Query Timeout

For the initial implementation, rely on `PRAGMA busy_timeout = 5000` for lock contention. Pathological query performance (e.g., cartesian products) is deferred to a follow-up. A TODO comment in the code will note that `AbortController`-based timeout or a worker thread with `sqlite3_interrupt()` could be added later.

## Files to Create

- `packages/daemon/src/lib/db-query/tools.ts` -- Main MCP server implementation
- `packages/daemon/src/lib/db-query/scope-config.ts` -- Table access lists, column blacklists, and scope definitions
- `packages/daemon/src/lib/db-query/sql-validator.ts` -- SQL validation (early rejection optimization)
- `packages/daemon/tests/unit/db-query/sql-validator.test.ts` -- SQL validation unit tests
- `packages/daemon/tests/unit/db-query/scope-config.test.ts` -- Scope configuration unit tests
- `packages/daemon/tests/unit/db-query/tools.test.ts` -- Tool handler unit tests
- `packages/daemon/tests/unit/db-query/db-query-integration.test.ts` -- Integration test with full schema

## Files to Modify

- `packages/daemon/src/lib/neo/neo-agent-manager.ts` -- Inject `db-query` MCP server into Neo agent session (global scope)
- `packages/daemon/src/lib/rpc-handlers/index.ts` -- Wire `dbPath` into NeoAgentManager via `setDbPath()`
- `packages/daemon/src/lib/room/runtime/room-runtime-service.ts` -- Inject `db-query` MCP server into room chat, worker, and leader sessions
- `packages/daemon/src/lib/space/runtime/task-agent-manager.ts` -- Inject `db-query` MCP server into task agent sessions
- `packages/daemon/src/lib/space/runtime/space-runtime-service.ts` -- Inject `db-query` MCP server into space chat sessions

---

## Task 1: SQL Validator (Early-Rejection Layer)

**Title:** Implement SQL validation layer for early rejection of non-SELECT statements

**Description:**
Create `packages/daemon/src/lib/db-query/sql-validator.ts`. This module provides fast, helpful error messages for obviously invalid queries before they reach SQLite. It is **not** a security boundary -- write prevention is handled by the read-only connection.

**Subtasks:**
1. Create the `packages/daemon/src/lib/db-query/` directory
2. Implement `validateSql(sql: string): { valid: boolean; error?: string; tableRefs: string[] }` that:
   - Normalizes whitespace and strips SQL comments (`--` line comments, `/* */` block comments)
   - Checks if the normalized statement starts with `SELECT` (case-insensitive, allowing leading whitespace)
   - Rejects if the first keyword is not `SELECT` -- returns a helpful error message (e.g., "Only SELECT statements are allowed")
   - Extracts table name candidates from `FROM` and `JOIN` clauses using regex (`FROM\s+(\w+)`, `JOIN\s+(\w+)`)
   - For CTEs: strips `WITH ... AS (...)` wrapper and extracts table refs from both the CTE bodies and the main query
   - CTE names are tracked separately and excluded from the returned `tableRefs` (they are not real tables)
   - Rejects semicolons (prevents multi-statement injection)
   - Returns `{ valid, error?, tableRefs }` for downstream scope checking
3. The function does NOT need to:
   - Parse full SQL AST (that's SQLite's job)
   - Catch every possible injection vector (the read-only connection handles writes)
   - Handle `PRAGMA` statements (those are called internally by the server for `db_describe_table`, not passed through user SQL)
4. Create `packages/daemon/tests/unit/db-query/sql-validator.test.ts` covering:
   - Valid SELECT queries are accepted, table refs extracted correctly
   - INSERT/UPDATE/DELETE/DROP/ALTER/CREATE/REPLACE/ATTACH are rejected with error message
   - Semicolons are rejected
   - Comments are stripped before validation (`SELECT/* comment */* FROM tasks`)
   - CTEs: `WITH x AS (...) SELECT * FROM x JOIN tasks` -- `x` excluded from tableRefs, `tasks` included
   - Subqueries: table refs in subqueries are extracted
   - Mixed case and whitespace variations
   - Unicode in table/column names
   - Very long SQL strings
   - NULL byte injection rejected

**Acceptance criteria:**
- All SQL validation tests pass
- Valid SELECT queries pass validation (no false positives)
- Obvious non-SELECT statements are rejected with helpful error messages
- CTE names are excluded from table reference extraction
- Table references are extracted for downstream scope checking

**Dependencies:** None

**Agent type:** coder

---

## Task 2: Scope Configuration

**Title:** Implement table access lists, column blacklists, and scope definitions

**Description:**
Create `packages/daemon/src/lib/db-query/scope-config.ts` that defines which tables each scope can access and which columns are blacklisted.

**Subtasks:**
1. Define `DbScopeType = 'global' | 'room' | 'space'`
2. Define `ScopeTableConfig` with:
   - `tableName: string` -- must match actual table name in the schema
   - `scopeColumn?: string` -- direct scope column (e.g., `'room_id'`, `'space_id'`)
   - `scopeJoin?: { localColumn: string; joinTable: string; joinPkColumn: string; scopeColumn: string }` -- for indirect scoping (e.g., `mission_executions.goal_id` -> `goals.id` -> `goals.room_id`)
   - `blacklistedColumns: string[]` -- columns to exclude from `db_describe_table` and `SELECT *`
   - `description: string` -- human-readable description for the agent
3. Define scope configurations matching the "Table Access by Scope" table in the Approach section above:
   - **`global` scope**: sessions, rooms, spaces, app_mcp_servers, skills, inbox_items, neo_activity_log, job_queue, short_id_counters -- no filter, column blacklists applied
   - **`room` scope**: tasks, goals, mission_executions (indirect via goals), mission_metric_history (indirect via goals), room_github_mappings, room_mcp_enablement, room_skill_overrides
   - **`space` scope**: space_agents, space_workflows, space_workflow_steps (indirect via space_workflows), space_workflow_runs, space_tasks, space_worktrees, gate_data (indirect via space_workflow_runs), channel_cycles (indirect via space_workflow_runs)
4. Implement `getScopeConfig(scopeType: DbScopeType): ScopeTableConfig[]`
5. Implement `getScopeForSession(context: SessionContext): { scopeType: DbScopeType; scopeValue: string } | null` that maps session context to scope:
   - `context.roomId` -> `{ scopeType: 'room', scopeValue: roomId }`
   - `context.spaceId` -> `{ scopeType: 'space', scopeValue: spaceId }`
   - Neither -> `{ scopeType: 'global', scopeValue: '' }`
6. Implement `getAccessibleTableNames(scopeType: DbScopeType): string[]`
7. Implement `getBlacklistedColumns(tableName: string): string[]` (blacklists are global per-table, not scope-dependent)
8. Implement `buildScopeFilter(tableConfig: ScopeTableConfig, scopeValue: string): { whereClause: string; params: unknown[] }` that returns the WHERE clause for a given table's scope config:
   - Direct: `room_id = ?` or `space_id = ?` (with scopeValue as param)
   - Indirect: `goal_id IN (SELECT id FROM goals WHERE room_id = ?)` (with scopeValue as param)
9. Implement `getExcludedTableNames(): string[]` returning the list of tables excluded from all scopes (for the schema evolution test)
10. Create `packages/daemon/tests/unit/db-query/scope-config.test.ts` covering:
    - Each scope returns the correct set of tables
    - Column blacklists are applied correctly
    - `getScopeForSession` maps roomId/spaceId/neither correctly
    - Sensitive tables are never in any scope
    - `buildScopeFilter` returns correct parameterized SQL for direct and indirect scope configs
    - Indirect scope configs for `mission_executions`, `mission_metric_history`, `space_workflow_steps`, `gate_data`, `channel_cycles` produce valid SQL with correct params
    - Dropped tables are not in any scope config

**Acceptance criteria:**
- All scope configuration tests pass
- No sensitive tables (`auth_config`, `global_tools_config`, `global_settings`) are in any scope
- `sdk_messages` is excluded from all scopes
- Internal infrastructure tables (`session_groups`, `session_group_members`, `task_group_events`) are excluded from all scopes
- Dropped tables (`space_session_groups`, `space_session_group_members`, `space_workflow_transitions`) are not in any scope config
- `buildScopeFilter` produces correct parameterized SQL for both direct and indirect scope configs
- Column blacklists exclude known-sensitive columns
- `getExcludedTableNames()` includes all always-excluded tables for schema validation

**Dependencies:** None

**Agent type:** coder

---

## Task 3: DB-Query MCP Server Implementation

**Title:** Implement the db-query MCP server with read-only connection and three tools

**Description:**
Create the core `db-query` MCP server. Each instance owns one read-only SQLite connection (created at init, closed on teardown). No connection pool needed.

**Subtasks:**
1. Create `packages/daemon/src/lib/db-query/tools.ts`:

   **Types and Config:**
   - `DbQueryToolsConfig`: `{ dbPath: string; scopeType: DbScopeType; scopeValue: string }`
   - The server creates its own read-only connection at creation time:
     ```typescript
     const db = new Database(dbPath, { readonly: true });
     db.exec('PRAGMA busy_timeout = 5000');
     db.exec('PRAGMA query_only = ON');
     ```
   - Expose a `close()` method that calls `db.close()` for cleanup

   **Handler factory `createDbQueryToolHandlers(config, db)`:**
   - **`db_query(sql: string, params?: unknown[], limit?: number)`**:
     1. Call `validateSql(sql)` -- reject if invalid (return `{ isError: true }`)
     2. Check all extracted `tableRefs` are in the current scope's accessible tables -- reject if any table is out-of-scope (prevents cross-scope joins)
     3. For each referenced table, look up its `ScopeTableConfig` and `buildScopeFilter()`
     4. Combine all scope filters with AND, qualifying column names with `_dbq.` prefix to avoid ambiguity when multiple tables share column names
     5. Rewrite the inner query to use `SELECT *` (ensuring scope columns are available), then wrap: `SELECT <user_columns> FROM (SELECT * FROM <user_tables_and_joins>) AS _dbq WHERE <combined_scope_filter>`. For single-table queries without explicit column selection, the outer SELECT defaults to `*`.
     6. Append LIMIT cap: `Math.min(limit ?? 200, 1000)`
     7. Execute via `db.query(wrappedSql, [...userParams, ...scopeParams])`
     8. Apply column blacklist: remove blacklisted columns from each row before returning
     9. Return `{ rows: [...], rowCount, truncated: boolean }` as JSON text
     10. On error: return `{ isError: true, content: [{ type: 'text', text: error_message }] }`

   - **`db_list_tables()`**:
     1. Return all tables in the current scope with their descriptions
     2. Format as markdown table for readability
     3. Note: `PRAGMA table_info()` is called internally by `db_describe_table`, NOT passed through `validateSql`

   - **`db_describe_table(table_name: string)`**:
     1. Verify table is in current scope -- reject if not
     2. Execute `PRAGMA table_info(table_name)` internally (server-side, not user SQL)
     3. Filter out blacklisted columns
     4. Execute `PRAGMA foreign_key_list(table_name)` for FK info
     5. Return column definitions as formatted text

   **Server factory `createDbQueryMcpServer(config)`:**
   - Create the read-only connection
   - Wrap handlers with `tool()` from `@anthropic-ai/claude-agent-sdk`
   - Call `createSdkMcpServer({ name: 'db-query', version: '1.0.0', tools })`
   - All three tools use `readOnlyHint: true` in the `tool()` call
   - `db_query` tool description should explain scope limitations clearly to the agent
   - Return value includes a `close()` method for connection cleanup

   **Timeout note:** Add a `// TODO: Add query timeout` comment noting that `AbortController`-based cancellation or a worker thread with `sqlite3_interrupt()` could be added in a follow-up to handle pathological queries. For now, `PRAGMA busy_timeout = 5000` handles lock contention only.

2. Create `packages/daemon/tests/unit/db-query/tools.test.ts`:
   - Use an in-memory SQLite database with a test schema (subset of HyperNeo tables including rooms, tasks, goals, mission_executions, spaces, space_tasks, gate_data, space_workflow_runs)
   - Test `db_query` with valid SELECT returns rows
   - Test `db_query` rejects non-SELECT statements with `isError: true`
   - Test `db_query` rejects queries referencing tables outside scope
   - Test `db_query` scope subquery wrapping filters results correctly
   - Test `db_query` indirect scope tables (mission_executions via goals, gate_data via space_workflow_runs) filtered correctly
   - Test `db_query` row limit cap enforced (default 200, max 1000)
   - Test `db_query` column blacklist removes sensitive columns from results
   - Test `db_query` SQL execution errors return `isError: true`
   - Test `db_list_tables` returns only scope-appropriate tables
   - Test `db_describe_table` returns column info, excludes blacklisted columns
   - Test `db_describe_table` rejects tables outside scope
   - Test `close()` properly closes the connection

**Acceptance criteria:**
- All tool tests pass
- Read-only enforcement at connection level (`readonly: true` + `PRAGMA query_only = ON`)
- Scope enforcement via subquery wrapping prevents reading out-of-scope data
- Cross-scope join prevention (table ref validation rejects queries referencing tables outside scope)
- Row limit enforced (max 1000, default 200)
- Column blacklist removes sensitive columns from results
- No `console.log` calls
- Connection properly closed via `close()` method

**Dependencies:** Task 1 (SQL validator), Task 2 (scope config)

**Agent type:** coder

---

## Task 4: Integration into Agent Sessions

**Title:** Inject db-query MCP server into Neo, room, task agent, space, and leader sessions

**Description:**
Wire the `db-query` MCP server into all agent session types. Each session gets its own MCP server instance with a single read-only connection.

**Subtasks:**
1. Modify `packages/daemon/src/lib/neo/neo-agent-manager.ts`:
   - Add a private `dbPath: string | null = null` field and a public `setDbPath(dbPath: string): void` setter method (follows the same order-independent wiring pattern as `setToolsConfig`, `setActionToolsConfig`, `setActivityLogger`)
   - Call `deps.neoAgentManager.setDbPath(deps.db.getDatabasePath())` in `packages/daemon/src/lib/rpc-handlers/index.ts` alongside the existing `setToolsConfig()` call (lines 388 area) — `deps.db.getDatabasePath()` is already available in that scope
   - In `attachTools()`: at the top, close any existing db-query server instance (`this.dbQueryServer?.close(); this.dbQueryServer = null;`) before creating a new one — this prevents connection leaks when `attachTools()` is called multiple times during mid-lifecycle resets (e.g., `destroyAndRecreate()`, `clearSession()`). Then if `this.dbPath` is set, create `createDbQueryMcpServer({ dbPath: this.dbPath, scopeType: 'global', scopeValue: '' })` and merge it into the `setRuntimeMcpServers()` call alongside the existing `inProcessServers` and `registryMcpServers` under the key `'db-query'`
   - Store a reference to the created server instance for cleanup (call `close()` on session teardown)
   - The Neo agent's session context has no `roomId` or `spaceId`, so it receives `global` scope (all non-sensitive tables, no WHERE filter injection)
2. Modify `packages/daemon/src/lib/room/runtime/room-runtime-service.ts`:
   - Import `createDbQueryMcpServer` and `getScopeForSession`
   - In `setupRoomAgentSession()`: create `createDbQueryMcpServer({ dbPath: ctx.db.getDatabasePath(), scopeType: 'room', scopeValue: room.id })` and merge into `setRuntimeMcpServers()` under the key `'db-query'`
   - In worker/leader session setup paths: same pattern with room scope
   - Store a reference to the created server instance for cleanup (call `close()` when session ends)
3. Modify `packages/daemon/src/lib/space/runtime/task-agent-manager.ts`:
   - In task agent session creation: create `createDbQueryMcpServer({ dbPath, scopeType: 'space', scopeValue: space.id })` and merge into the task agent's MCP servers
4. Modify `packages/daemon/src/lib/space/runtime/space-runtime-service.ts`:
   - In space chat session setup: create `createDbQueryMcpServer({ dbPath, scopeType: 'space', scopeValue: space.id })` and merge into the space chat session's MCP servers
5. Add connection cleanup to session teardown paths:
   - When a session ends, call the db-query server's `close()` method to release the read-only connection
   - In `RoomRuntime.stop()`: close all db-query server instances for sessions in that room
   - In Neo agent session teardown: close the db-query server instance
   - In space runtime cleanup: close db-query server instances for space sessions

**Integration details:**
- The `db-query` server is placed last in the MCP server merge map (same pattern as existing in-process servers) so it wins on name collision
- The `dbPath` is obtained from `ctx.db.getDatabasePath()` (verified to exist at `packages/daemon/src/storage/index.ts`)
- The `createSdkMcpServer` return type is cast to `McpServerConfig` via `as unknown as McpServerConfig` (same pattern as `room-agent-tools`)
- Each MCP server instance owns its own connection (no pool). The `close()` method is called on session teardown.

**Out of scope for initial implementation (can be added in follow-ups):**
- **Node agent sub-sessions**: spawned by `TaskAgentManager` for individual workflow steps. Deferred because node agents already inherit MCP tools from their parent task agent session.
- **Planner agent sessions**: used for planning phases in room missions. Deferred because planner sessions have access to the same room-scoped MCP tools as the leader/worker.
- **`readOnlyHint: true`**: the `tool()` helper from `@anthropic-ai/claude-agent-sdk` may or may not support this field in the version currently used (v0.2.86). The implementer should verify against the SDK's `tool()` type signature and omit the field if it causes a type error.

**Acceptance criteria:**
- Neo agent session has a `db-query` MCP server with `global` scope (no WHERE filter, all non-sensitive tables)
- Room chat sessions have a `db-query` MCP server with `room` scope
- Worker/leader sessions have a `db-query` MCP server with `room` scope
- Space chat sessions have a `db-query` MCP server with `space` scope
- Task agent sessions have a `db-query` MCP server with `space` scope
- No runtime errors when the MCP server is injected
- Connections are properly closed when sessions/runtimes stop (no leaks)
- The `db-query` server key does not conflict with existing MCP server keys

**Dependencies:** Task 3 (tool implementation)

**Agent type:** coder

---

## Task 5: Integration Tests and Schema Validation

**Title:** Add integration tests and schema evolution validation

**Description:**
Add comprehensive integration tests and a schema-sync validation test.

**Subtasks:**
1. Create `packages/daemon/tests/unit/db-query/db-query-integration.test.ts`:
   - Set up an in-memory database with the full HyperNeo schema (using `createTables()` from `packages/daemon/src/storage/schema/index.ts`)
   - Seed with test data across rooms, spaces, goals, tasks, space_tasks, etc.
   - **Room scope test**: create a room-scoped `db-query` server and verify:
     - Can query room-scoped tables (`tasks`, `goals`, `room_github_mappings`)
     - Results are filtered to the specified `room_id`
     - Can query indirect scope tables (`mission_executions` filtered through `goals`)
     - Cannot query space-scoped tables (`space_tasks`, `space_workflows`) -- rejected with scope error
     - Cannot query sensitive tables (`auth_config`, `global_settings`) -- rejected
   - **Space scope test**: create a space-scoped `db-query` server and verify:
     - Can query space-scoped tables (`space_tasks`, `space_workflows`, `space_agents`)
     - Can query indirect scope tables (`gate_data` filtered through `space_workflow_runs`, `space_workflow_steps` filtered through `space_workflows`)
     - Results are filtered to the specified `space_id`
     - Cannot query room-scoped tables -- rejected with scope error
   - **Global scope test**: create a global-scoped `db-query` server and verify:
     - Can query all global tables
     - Cannot query sensitive tables
     - No scope filter is applied
   - **Cross-scope join prevention**: verify `SELECT * FROM tasks JOIN space_tasks ON ...` is rejected for room scope

2. Add edge-case tests to existing test files:
   - `sql-validator.test.ts`: CTE queries where the main SELECT references only in-scope tables
   - `tools.test.ts`: JOINs across scope-appropriate tables (e.g., `tasks JOIN goals` for room scope), parameterized queries with `?` placeholders, aggregate functions (COUNT, SUM), GROUP BY, ORDER BY, LIMIT/OFFSET

3. Create a **schema evolution validation test** in `packages/daemon/tests/unit/db-query/scope-config.test.ts`:
   - Import the schema module or use a fresh in-memory DB with `createTables()`
   - Get all actual table names from the DB via `SELECT name FROM sqlite_master WHERE type='table'`
   - Get all scope-configured table names via `getAccessibleTableNames('global')` + `getAccessibleTableNames('room')` + `getAccessibleTableNames('space')`
   - Assert that every actual table is either: in a scope config, in `getExcludedTableNames()`, or in the known-dropped list
   - If a new table is added by a migration but not added to any scope config, this test will fail, prompting the developer to update the config

4. Run full test suite to verify no regressions: `make test-daemon`

**Acceptance criteria:**
- All new tests pass
- All existing tests still pass (`make test-daemon`)
- Integration test validates end-to-end scope enforcement with real schema
- Schema evolution test catches tables missing from scope config
- Cross-scope join prevention works correctly
- Indirect scope filtering (mission_executions via goals, gate_data via space_workflow_runs) produces correct results

**Dependencies:** Task 3 (tool implementation), Task 4 (integration)

**Agent type:** coder
