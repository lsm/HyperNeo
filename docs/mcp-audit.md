# MCP Architecture Audit

**Audited:** 2026-03-24
**Task:** Task 1.1 — MCP Architecture Audit
**Branch:** `task/task-11-mcp-architecture-audit`

---

## 1. How MCPs Are Registered Today

HyperNeo's MCP server system is entirely **file-based and read-only at startup**. There is no application-level registry — servers are discovered by reading standard Claude Code configuration files.

### Configuration File Sources

MCP servers are read from three standard sources, controlled by `settingSources` in global settings (`['user', 'project', 'local']` by default):

| Source | File Locations | Setting Source Key |
|--------|---------------|-------------------|
| **User** | `~/.claude/settings.json` (mcpServers key), `~/.mcp.json` | `user` |
| **Project** | `{workspace}/.claude/settings.json`, `{workspace}/.mcp.json` | `project` |
| **Local** | `{workspace}/.claude/settings.local.json` | `local` |

**Critical security constraint:** The `local` source (`.claude/settings.local.json`) is intentionally excluded from `getEnabledMcpServersConfig()`. This prevents the daemon from injecting arbitrary MCP servers into room agent sessions via its own writes to that file. The daemon only writes to `settings.local.json` for file-only settings (disabledMcpServers, enabledMcpServers, etc.) — not raw MCP server configs.

### Reading Mechanism

`SettingsManager.listMcpServersFromSources()` (`packages/daemon/src/lib/settings-manager.ts:361`) enumerates all MCP server entries from the enabled sources, returning `McpServerInfo[]` with name, source, command, and args.

`SettingsManager.getEnabledMcpServersConfig()` (`packages/daemon/src/lib/settings-manager.ts:463`) reads raw `McpServerConfig` objects (command, args, env, type, url, etc.) from the same files. This is the method used at query-build time.

### Per-Server Allow/Deny

`GlobalSettings.mcpServerSettings` (in `packages/shared/src/types/settings.ts:111`) stores per-server overrides:

```typescript
interface McpServerSettings {
  allowed?: boolean;    // false = exclude from getEnabledMcpServersConfig()
  defaultOn?: boolean;
}
```

If `allowed === false`, the server is removed from the merged config even if present in a settings file.

### Global Enable/Disable

`GlobalSettings.disabledMcpServers: string[]` is a global denylist. When a server name appears here, it is excluded from queries. This is written to `settings.local.json` as `disabledMcpjsonServers` (note: typo in the key name).

---

## 2. Server Types Supported

Three transport types are supported, matching the MCP protocol specification:

### Stdio (`McpStdioServerConfig`)
```typescript
interface McpStdioServerConfig {
  type?: 'stdio';
  command: string;        // e.g., "npx", "python", "/path/to/script"
  args?: string[];       // e.g., ["@modelcontextprotocol/server-filesystem", "./data"]
  env?: Record<string, string>;
}
```
This is the most common type, used for npm-based servers, Python scripts, and local executables.

### SSE (`McpSSEServerConfig`)
```typescript
interface McpSSEServerConfig {
  type: 'sse';
  url: string;           // HTTP(S) endpoint
  headers?: Record<string, string>;
}
```
Used for remote MCP servers accessible over HTTP with Server-Sent Events transport.

### HTTP (`McpHttpServerConfig`)
```typescript
interface McpHttpServerConfig {
  type: 'http';
  url: string;
  headers?: Record<string, string>;
}
```
Used for remote MCP servers with basic HTTP transport.

### Custom In-Process MCP Servers (SDK-based)

HyperNeo also creates custom MCP servers in-process using the SDK's `createSdkMcpServer()` API. These are passed as live `McpServer` instances (not config objects) via `AgentSessionInit.mcpServers`:

| Server Name | Created By | Available To |
|-------------|-----------|-------------|
| `room-agent-tools` | `createRoomAgentMcpServer()` in `room-runtime-service.ts` | Room chat session |
| `planner-tools` | `createPlannerMcpServer()` in `planner-agent.ts` | Planner session |
| `leader-agent-tools` | `createLeaderMcpServer()` in room runtime | Leader session |
| `global-spaces-tools` | `provision-global-agent.ts` | Global spaces session |
| `task-agent` | `createTaskAgentMcpServer()` in space | Task agent session |
| `step-agent` | `createStepAgentMcpServer()` in space | Step agent session |

These in-process servers are **runtime-injected** via `AgentSession.setRuntimeMcpServers()` and are not read from any file. They are non-serializable and are lost on daemon restart — requiring explicit restoration via `restoreMcpServersForGroup()`.

---

## 3. Tool Distribution Chain

### Session Types and Their MCP Tool Sets

#### `room_chat` Session (Orchestrator)
- **File-based MCPs:** `getEnabledMcpServersConfig()` (from `.mcp.json`, settings files)
- **Custom MCPs:** `room-agent-tools` (always injected last)
- **Allowed tools:** `roomAllowedBuiltinTools` = `[Read, Glob, Grep, Bash, WebFetch, WebSearch, ToolSearch, AskUserQuestion, Skill]` plus wildcard allow-listing `name__*` for all explicitly configured MCP server tools
- **Security:** `strictMcpConfig: true` — prevents user settings file from injecting extra tools; `settingSources: []` — skips settings file loading entirely
- **Code:** `query-options-builder.ts:191–244`

#### `planner` Session (Goal Planning)
- **Custom MCPs:** `planner-tools` (create_task, update_task, remove_task — phase-gated by `isPlanApproved()`)
- **Built-in tools:** `Task, TaskOutput, TaskStop, Read, Write, Edit, Bash, Grep, Glob, WebFetch, WebSearch`
- **Note:** `planner-tools` MCP is passed via `AgentSessionInit.mcpServers` at session creation time (`createPlannerAgentInit()` in `planner-agent.ts:571`). The plan-writer sub-agent also has WebFetch and WebSearch.
- **MCP injection:** `createPlannerMcpServer()` is called with fresh closures at session creation; on daemon restart, `restoreMcpServersForGroup()` recreates it

#### `leader` Session (Review Orchestration)
- **Custom MCPs:** `leader-agent-tools` (send_to_worker, complete_task, etc.)
- **Injection:** `createLeaderMcpServer()` called in `room-runtime.ts:restoreMcpServersForGroup()`, attached via `sessionFactory.setSessionMcpServers()`
- **Available to:** Leader sessions in active task groups

#### `coder` / `general` Sessions (Worker)
- **File-based MCPs:** `getEnabledMcpServersConfig()` applied at query-build time via `getSettingsOptions()` in `query-options-builder.ts:712`
- **Custom MCPs:** None injected (no room-specific tools for workers)
- **Built-in tools:** Standard Claude Code preset tools (via `useClaudeCodePreset: true`)
- **Note:** Workers receive project/user MCP servers from file-based settings at query-build time. They do NOT receive `room-agent-tools` or any room-specific MCPs.

#### `lobby` Session
- **MCPs:** None injected or file-based

#### Space Sessions
- **Custom MCPs:** `global-spaces-tools`, `task-agent`, `step-agent` injected via `provision-global-agent.ts` and `task-agent-manager.ts`
- **No file-based MCPs:** Space sessions do not receive `getEnabledMcpServersConfig()` — they only get their custom in-process MCPs

### Tool Distribution Flow at Query Build Time

```
SDK query() options construction (QueryOptionsBuilder.build())
  │
  ├─ getSettingsOptions() → reads GlobalSettings
  │     └─ prepareSDKOptions() → writes file-only settings to .claude/settings.local.json
  │
  ├─ getMcpServers() → returns session.config.mcpServers (runtime-injected)
  │     └─ If undefined, SDK auto-loads from settings files
  │
  └─ room_chat special handling:
       ├─ strictMcpConfig: true
       ├─ settingSources: [] (skip settings files)
       └─ allowedTools = roomAllowedBuiltinTools + mcpServerWildcards
```

### MCP Server Merge Strategy at Room Runtime

In `RoomRuntimeService.setupRoomAgentSession()` (`room-runtime-service.ts:546`):

```typescript
const enabledMcpServers = this.ctx.settingsManager.getEnabledMcpServersConfig();
roomChatSession.setRuntimeMcpServers({
  ...enabledMcpServers,       // file-based servers first
  'room-agent-tools': roomAgentMcpServer,  // room tools override on conflict
});
```

This means `room-agent-tools` always takes precedence over any file-based server with the same name.

---

## 4. Per-Session vs Per-Room vs Global Granularity

### Global (File-Based)
- Servers are defined in `~/.mcp.json`, `~/.claude/settings.json`, project `.mcp.json`, or project `.claude/settings.json`
- Apply to **any session** that loads those settings files (subject to `settingSources` and `disabledMcpServers`)
- No UI exists to add/edit/remove these servers — users must edit the files manually
- Per-server `allowed: false` in `mcpServerSettings` can exclude individual servers globally

### Per-Room
- `room-agent-tools` is a custom in-process MCP server unique to each room, providing room-specific tools (create_task is NOT in room-agent-tools — that's planner-tools)
- Room chat sessions receive the **union** of file-based servers + `room-agent-tools`
- **No per-room MCP enablement UI** — all file-based servers from enabled sources are available to the room chat, subject only to the global `disabledMcpServers` denylist
- Rooms do NOT have a stored list of "enabled MCPs" — enablement is purely global via `disabledMcpServers`

### Per-Session
- `setRuntimeMcpServers()` on `AgentSession` merges runtime MCPs into `session.config.mcpServers` in-memory only (not persisted)
- Used for: `planner-tools`, `leader-agent-tools`, `task-agent`, `step-agent`, `global-spaces-tools`, `room-agent-tools`
- These are non-serializable and lost on daemon restart — must be explicitly restored via `restoreMcpServersForGroup()`
- Worker sessions (coder/general) do NOT receive runtime-injected MCPs — they only get file-based servers at query-build time

### Permission Granularity
| Dimension | Mechanism |
|-----------|-----------|
| Global disable | `disabledMcpServers[]` in `GlobalSettings` |
| Per-server allow/deny | `mcpServerSettings[name].allowed: false` |
| Per-source enable/disable | `settingSources[]` array |
| Room chat MCP isolation | `strictMcpConfig: true` + `settingSources: []` |
| Local source blocked for injection | `getEnabledMcpServersConfig()` excludes `local` |

---

## 5. Gaps

### Gap 1: No Application-Level MCP Registry

There is no persistent application-level store for MCP server configurations. Users must manually create/edit `.mcp.json` or `settings.json` files. There is:
- No database table for MCP server definitions
- No CRUD API for managing MCP servers
- No UI to add, edit, or remove MCP servers
- No concept of "installing" an MCP from npm, Docker, or a script URL

The implementation plan (Task 2.1–2.2) addresses this with a SQLite `app_mcp_servers` table, `AppMcpServerRepository`, and 6 CRUD RPC handlers (`mcp.registry.*`).

### Gap 2: No UI to Add/Configure MCP Servers

`McpServersSettings.tsx` only provides a **toggle UI** — it shows discovered servers from file-based sources and lets users enable/disable them. There is no UI to:
- Add a new MCP server (enter command, args, env)
- Edit an existing server's configuration
- Delete a server
- See server health/status
- Configure per-room enablement

### Gap 3: No Per-Room MCP Enablement UI

While `room-agent-tools` is automatically attached to room chat sessions, there is:
- No per-room MCP enablement list in room settings
- No UI to select which MCP servers from the registry are active for a given room
- No concept of "room MCP profiles" or room-level server lists

The implementation plan (Tasks 4.1–4.2 and 5.3) addresses this with per-room enablement storage and UI.

### Gap 4: No Health Checking or Lifecycle Management

There is no `AppMcpLifecycleManager` today. MCP server processes are spawned by the SDK subprocess and managed entirely by the SDK. If a server crashes:
- The SDK may retry or report failure
- HyperNeo has no visibility into server health
- No auto-restart mechanism exists
- No way to query server status via RPC

The implementation plan (Task 3.1) addresses this with `AppMcpLifecycleManager` class.

### Gap 5: Planner Web Search Is NOT a Gap

**Confirmed existing capability:** Both the Planner agent and the plan-writer sub-agent already have `WebFetch` and `WebSearch` in their tool lists:

- `buildPlanWriterAgentDef()` (`planner-agent.ts:232–243`): `tools: [Task, TaskOutput, TaskStop, Read, Write, Edit, Bash, Grep, Glob, WebFetch, WebSearch]`
- Planner agent def (`planner-agent.ts:582–593`): `tools: [Task, TaskOutput, TaskStop, Read, Write, Edit, Bash, Grep, Glob, WebFetch, WebSearch]`
- Coordinator mode tools (`query-options-builder.ts:273–293`): includes `WebFetch`, `WebSearch`
- Room chat `roomAllowedBuiltinTools` (`query-options-builder.ts:193–201`): includes `WebFetch`, `WebSearch`
- Coder helper agents (`coder-agent.ts:193`): includes `WebFetch`, `WebSearch`
- Coder simple path: uses Claude Code preset which includes web search

The goal description's concern about "Planner agent likely lacks web search capability" is **not a gap in the current implementation**. The plan-writer uses `Task(subagent_type: "Explore", ...)` for deep codebase exploration and has `WebFetch`/`WebSearch` available directly.

---

## Summary: Current Architecture

```
File-based MCP Sources (.mcp.json, settings.json)
         │
         ▼
SettingsManager.getEnabledMcpServersConfig()
         │
         ├─► room_chat session ──► + room-agent-tools ──► SDK query
         │
         ├─► worker (coder/general) ──► SDK query (file-based only)
         │
         ├─► planner ──► + planner-tools (runtime) ──► SDK query
         │
         ├─► leader ──► + leader-agent-tools (runtime) ──► SDK query
         │
         └─► space sessions ──► + space-specific tools (runtime) ──► SDK query

Runtime MCP injection: AgentSession.setRuntimeMcpServers()
  - Non-serializable (SDK Server instances)
  - Lost on daemon restart
  - Restored via restoreMcpServersForGroup() for planner/leader
```

---

## Plan Adjustments Required

After reviewing the merge strategy in `RoomRuntimeService.setupRoomAgentSession()` and `query-options-builder.ts` room_chat restrictions, no critical architectural gaps were found that invalidate the proposed implementation plan. The verified merge strategy is:

1. File-based servers from `getEnabledMcpServersConfig()` are merged first
2. Custom runtime servers (`room-agent-tools`, etc.) override on name conflict
3. `strictMcpConfig: true` + `settingSources: []` for room_chat ensures no injection via settings files
4. Local source is intentionally excluded from `getEnabledMcpServersConfig()` to prevent daemon self-injection

**One minor note:** Worker sessions (coder/general) receive file-based MCPs at query-build time via `getSettingsOptions()`. This means changes to `disabledMcpServers` require a session restart to take effect (the SDK reads settings files at query creation). This is existing behavior and consistent with how the SDK works. The plan's `AppMcpLifecycleManager` with hot-reload via `mcp.registry.changed` event will address live updates for runtime-injected servers only; file-based server changes already require session restart.

---

## Audit Sources

| File | Purpose |
|------|---------|
| `packages/daemon/src/lib/settings-manager.ts` | MCP server discovery from files, per-server settings, toggle |
| `packages/daemon/src/lib/agent/query-options-builder.ts` | `getMcpServers()`, room_chat restrictions, `strictMcpConfig` |
| `packages/daemon/src/lib/agent/agent-session.ts` | `setRuntimeMcpServers()` in-memory merge |
| `packages/daemon/src/lib/room/runtime/room-runtime-service.ts` | `getEnabledMcpServersConfig()` → room chat merge |
| `packages/daemon/src/lib/room/runtime/room-runtime.ts` | `restoreMcpServersForGroup()` for planner/leader |
| `packages/daemon/src/lib/room/agents/planner-agent.ts` | `planner-tools`, plan-writer tool list |
| `packages/daemon/src/lib/room/agents/coder-agent.ts` | Coder agent tool list |
| `packages/daemon/src/lib/room/agents/general-agent.ts` | General agent tool list |
| `packages/daemon/src/lib/rpc-handlers/mcp-handlers.ts` | `tools.save`, `mcp.updateDisabledServers`, `mcp.listServers` |
| `packages/daemon/src/lib/rpc-handlers/settings-handlers.ts` | `settings.mcp.toggle`, `settings.mcp.listFromSources` |
| `packages/web/src/components/settings/McpServersSettings.tsx` | Existing toggle-only UI |
| `packages/shared/src/types/sdk-config.ts` | `McpStdioServerConfig`, `McpSSEServerConfig`, `McpHttpServerConfig` |
| `packages/shared/src/types/settings.ts` | `GlobalSettings`, `FileOnlySettings`, `McpServerSettings` |
| `packages/daemon/src/lib/space/provision-global-agent.ts` | Space global-spaces-tools injection |
| `packages/daemon/src/lib/space/runtime/task-agent-manager.ts` | Space task-agent, step-agent injection |
