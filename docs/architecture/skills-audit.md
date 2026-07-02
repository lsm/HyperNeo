# Skills, MCP & Plugin System Audit

**Date:** 2026-03-25
**Status:** Complete

---

## 1. What "Skill" Means in the SDK Context

In the Claude Agent SDK, a **Skill** is a slash-command—specifically, a command that lives in `.claude/commands/` as a `.md` file whose filename (without extension) becomes the command name (e.g., `/my-command`). These are discovered and managed by the SDK itself, not by HyperNeo.

**SDK Type Definition** (`packages/shared/src/sdk/sdk.d.ts`):
```typescript
export type SlashCommand = {
  name: string;        // skill name (without the leading slash)
  description: string; // what the skill does
  argumentHint: string; // e.g. "<file>"
};
```

The SDK exposes `supportedCommands()` → `Promise<SlashCommand[]>` to list available skills. Skills are invoked with the `Skill` tool (a built-in tool name, not an MCP tool). When the agent types `/my-command arg`, the SDK resolves it to the `.claude/commands/my-command.md` file and expands the content into the prompt.

**In HyperNeo**, the `SlashCommandManager` (`packages/daemon/src/lib/agent/slash-command-manager.ts`) wraps this SDK behavior:
- It calls `queryObject.supportedCommands()` to fetch skills from the SDK
- It merges in SDK built-in commands (`clear`, `help`)
- It merges in HyperNeo built-in commands (`merge-session`)
- It persists the combined list to `session.availableCommands` in SQLite
- It emits `commands.updated` events to the UI via the DaemonHub

---

## 2. How Plugins Work

Plugins are configured via `SDKConfig.plugins`, which takes an array of `PluginConfig`:

**SDK Type Definition** (`packages/shared/src/types/sdk-config.ts`):
```typescript
export interface PluginConfig {
  type: 'local';
  /** Absolute or relative path to plugin directory */
  path: string;
}
```

Currently only `type: 'local'` is defined. The `path` is passed directly to the SDK subprocess. Plugins are invoked by the SDK as part of the agent session.

**In HyperNeo**, plugins flow through `QueryOptionsBuilder`:
```typescript
// packages/daemon/src/lib/agent/query-options-builder.ts
const queryOptions: Options = {
  // ...
  plugins: config.plugins,  // SDKConfig.plugins → Options.plugins
  // ...
};
```

The `plugins` field on `SDKConfig` (which extends `ToolsSettings`, `AgentsConfig`, `McpSettings`, etc.) is where plugin configuration lives. There is currently **no HyperNeo-specific plugin management UI or persistence layer**—plugins can only be set programmatically at session creation.

---

## 3. Which Agents Currently Receive the `Skill` Tool

The `Skill` tool (the SDK-built-in tool for invoking slash commands) is explicitly listed in the tools array of the following agents:

### Coordinator Mode Specialists

| Agent | Has `Skill`? | File |
|-------|-------------|------|
| Coordinator (main thread) | **Yes** | `query-options-builder.ts` (via `allTools` in coordinator mode) |
| Coder | **Yes** | `packages/daemon/src/lib/agent/coordinator/coder.ts` |
| Debugger | **Yes** | `packages/daemon/src/lib/agent/coordinator/debugger.ts` |
| Tester | **Yes** | `packages/daemon/src/lib/agent/coordinator/tester.ts` |
| Reviewer | **Yes** | `packages/daemon/src/lib/agent/coordinator/reviewer.ts` |
| VCS | **Yes** | `packages/daemon/src/lib/agent/coordinator/vcs.ts` |
| Verifier | **Yes** | `packages/daemon/src/lib/agent/coordinator/verifier.ts` |

### Room Agents

**Note:** The Planner, room Coder, and General agents all use the `claude_code` preset with explicit `tools` arrays. The Coordinator main thread and all Coordinator specialists explicitly list `Skill` in their tools arrays. Room agents (Planner, room Coder, General) do **not** list `Skill` in their tools arrays — they rely on the SDK preset.

| Agent | Has `Skill` explicitly listed? | Has `WebSearch` explicitly listed? | File |
|-------|-------------|-----------------|------|
| Planner | No | **Yes** | `packages/daemon/src/lib/room/agents/planner-agent.ts` |
| Plan Writer (sub-agent) | No | **Yes** | `packages/daemon/src/lib/room/agents/planner-agent.ts` (via `buildPlanWriterAgentDef`) |
| Leader | No | No | `packages/daemon/src/lib/room/agents/leader-agent.ts` |
| Coder (with helpers) | No | **Yes** | `packages/daemon/src/lib/room/agents/coder-agent.ts` |
| Coder (simple path) | No | Inferred from `claude_code` preset | `packages/daemon/src/lib/room/agents/coder-agent.ts` |
| General | No | Inferred from `claude_code` preset | `packages/daemon/src/lib/room/agents/general-agent.ts` |

### Coordinator Mode Main Thread

In `query-options-builder.ts`, when `config.coordinatorMode` is true:
```typescript
const allTools = [
  'Task', 'TaskOutput', 'TaskStop', 'Bash', 'Read', 'Edit', 'Write',
  'Glob', 'Grep', 'NotebookEdit', 'WebFetch', 'WebSearch', 'TodoWrite',
  'AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode', 'Skill', 'ToolSearch',
];
queryOptions.allowedTools = [...new Set([...existing, ...allTools])];
```
The Coordinator main thread also gets `Skill`.

### Room Chat Sessions

For `room_chat` session types, `QueryOptionsBuilder` sets:
```typescript
const roomAllowedBuiltinTools = [
  'Read', 'Glob', 'Grep', 'Bash', 'WebFetch', 'WebSearch', 'ToolSearch',
  'AskUserQuestion', 'Skill',
];
```
`Skill` is included in the room chat allowed tools list.

### Note on the `Skill` Tool Name

There is a distinction between:
- **`Skill`** (built-in SDK tool name): used to invoke a slash command
- **`SlashCommand`** (SDK type): the metadata for a skill (`name`, `description`, `argumentHint`)

Both use the string `"Skill"` as the tool identifier in agent tools arrays.

---

## 4. Current Planner `WebSearch` Configuration

The Planner agent and its Plan Writer sub-agent both have `WebSearch` explicitly listed in their tools arrays. Neither has `Skill`.

**Planner agent definition** (`packages/daemon/src/lib/room/agents/planner-agent.ts`):
```typescript
const plannerAgentDef: AgentDefinition = {
  // ...
  tools: [
    'Task', 'TaskOutput', 'TaskStop', 'Read', 'Write', 'Edit', 'Bash',
    'Grep', 'Glob', 'WebFetch', 'WebSearch',
  ],
  // ...
};
```

Note: `Skill` is **not** in the Planner's tools array. The Planner does not have access to the `Skill` tool.

The Plan Writer sub-agent (spawned via `Task` tool) also has `WebSearch`:
```typescript
return {
  // ...
  tools: [
    'Task', 'TaskOutput', 'TaskStop', 'Read', 'Write', 'Edit', 'Bash',
    'Grep', 'Glob', 'WebFetch', 'WebSearch',
  ],
  // ...
};
```

`WebSearch` is a **built-in SDK tool**, not an MCP tool. It does not require any additional MCP server configuration. It is available to any agent that lists it in its tools array.

The Planner does **not** currently have a dedicated web search Skill. It uses the SDK's built-in `WebSearch` which routes through the SDK's internal search implementation.

---

## 5. Current Gaps

### 5.1 No Application-Level Skills Registry

There is no `skills` table in SQLite and no `SkillsManager` or `SkillRepository`. Skills are entirely SDK-managed (`.claude/commands/` directory). Users cannot:
- Add skills from external sources (npm packages, Python packages, custom scripts)
- View which skills are registered
- Enable/disable skills per room or session
- Persist skill configurations across sessions

### 5.2 No Skills UI

The web frontend has no skills management interface. There is no:
- Skills list view
- Add/remove skill flow
- Per-room skill enablement toggle
- Skill source configuration (npm path, script path, etc.)

The only skill-related UI is the `Skill` tool being listed in the tool categorization in `ToolResultCard.test.tsx` (categorizing it as a "command tool").

### 5.3 No Plugin Management UI

While `PluginConfig` is defined, there is no UI for:
- Adding a local plugin by path
- Viewing configured plugins
- Removing plugins

Plugins must be set programmatically via session config.

### 5.4 No Per-Room Skill Overrides

There is no mechanism to enable/disable specific skills per room. All sessions in a room get whatever skills the SDK discovers from `.claude/commands/`. Skills are not part of the `RoomConfig` or `SessionConfig`.

### 5.5 `strictMcpConfig` Interaction

When `strictMcpConfig: true` is set (as it is for `room_chat` sessions in `query-options-builder.ts`), the SDK only uses the MCP servers explicitly passed via `mcpServers` in `Options` — it ignores `settings.json` and `.mcp.json`. This means **any skill-injected MCP servers must be passed explicitly in `mcpServers`**, not discovered via settings files. This has implications for the Skills registry design (see Section 7.4).

---

## 6. Recommended Architecture

### 6.1 Skills Registry Schema (SQLite)

Following the existing repository pattern (e.g., `GoalRepository`, `TaskRepository`), add a `skills` table:

```sql
CREATE TABLE skills (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  source_type TEXT NOT NULL, -- 'builtin' | 'local' | 'npm' | 'python'
  source_path TEXT,         -- for local/npm/python: the path or package name
  command_name TEXT NOT NULL, -- the slash command name (e.g. "pdf" for /pdf)
  is_enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Per-room skill overrides
CREATE TABLE room_skill_overrides (
  room_id TEXT NOT NULL,
  skill_id TEXT NOT NULL,
  is_enabled INTEGER NOT NULL,
  PRIMARY KEY (room_id, skill_id),
  FOREIGN KEY (skill_id) REFERENCES skills(id)
);
```

### 6.2 Skill Source Types

| Source Type | Description | Example |
|-------------|-------------|---------|
| `builtin` | Built-in HyperNeo skill (e.g., `merge-session`) | `command_name: "merge-session"` |
| `local` | Local script in workspace | `source_path: "./skills/my-skill"` |
| `npm` | npm package | `source_path: "@neokai/skill-pdf"` |
| `python` | Python script via `uvx` | `source_path: "uvx:my-skill"` |

### 6.3 SkillsManager

A `SkillsManager` (in `packages/daemon/src/lib/skills/skills-manager.ts`) would:
- Provide CRUD operations on the `skills` table
- Validate skill configurations before saving
- Support async validation (spawn the skill and verify it responds)
- Emit `skills.updated` events for LiveQuery sync

### 6.4 QueryOptionsBuilder Integration

The `QueryOptionsBuilder` would be extended to:
1. Query `SkillsManager` for enabled skills for the session/room
2. For `builtin` skills: add the command name to the session's `availableCommands`
3. For `local`/`npm`/`python` skills: convert to the appropriate SDK plugin or MCP server config
4. Apply `room_skill_overrides` to filter/enable per-room

### 6.5 RPC Handlers

New handlers in `skills-handlers.ts`:
- `skills.list` — list all skills (global registry)
- `skills.get` — get a skill by ID
- `skills.create` — add a new skill
- `skills.update` — update a skill
- `skills.delete` — remove a skill
- `skills.validate` — async validation job
- `skills.byRoom` — list skills for a specific room (with overrides applied)

### 6.6 Frontend Integration

- `RoomStore.listSkills()` and `RoomStore.listSkillsForRoom(roomId)` — LiveQuery hooks
- Skills settings panel in room settings UI
- Global skills registry UI in application settings

---

## 7. Security Considerations

### 7.1 Path Traversal Prevention for `pluginPath`

Local plugin paths and skill source paths must be validated to prevent directory traversal attacks.

**Required validation:**
- Reject paths containing `..` (parent directory reference)
- Reject absolute paths outside the workspace or home directory
- Canonicalize paths with `realpath()` or equivalent before use
- Log all path validation failures

```typescript
function isSafePath(path: string, baseDir: string): boolean {
  const canonical = path.resolve(baseDir, path);
  return canonical.startsWith(baseDir) && !path.includes('..');
}
```

### 7.2 `mcp_server` Skill Type — `appMcpServerId` Must Reference Existing Entry

If a skill type `mcp_server` is introduced (a skill that wraps an MCP tool), the `appMcpServerId` must reference a valid entry in `app_mcp_servers`. Before creating the skill:
1. Query `AppMcpLifecycleManager` to verify the MCP server exists
2. Verify the skill has permission to access that MCP server
3. Reject if the referenced MCP server has validation errors

### 7.3 `builtin` Skill Type — `commandName` Must Be Non-Empty

For `builtin` skills, `commandName` must:
- Be a non-empty string
- Contain only alphanumeric characters, hyphens, and underscores
- Match an existing built-in command (e.g., `merge-session`)

### 7.4 `strictMcpConfig` Compatibility

When a session uses `strictMcpConfig: true` (room_chat sessions), MCP servers from skill configurations must be injected into `Options.mcpServers` explicitly, not discovered via settings files.

**Design constraint:** If a skill configures an MCP server, that server must be included in the session's `Options.mcpServers` at query build time. The `QueryOptionsBuilder.getMcpServers()` method would merge in skill-derived MCP servers alongside room-configured MCP servers.

```typescript
private getMcpServers(): Record<string, unknown> | undefined {
  const config = this.ctx.session.config;
  const roomMcpServers = config.mcpServers ?? {};
  const skillMcpServers = this.getSkillMcpServers(); // from SkillsManager
  return { ...roomMcpServers, ...skillMcpServers };
}
```

### 7.5 Skill Validation

Before a skill is marked as "enabled", it should be validated:
- **Syntax/parse check:** Verify the skill file/script is readable and not malformed
- **Execution check:** Spawn the skill with a minimal input and verify it responds within a timeout
- **Permission check:** Verify the skill process runs with appropriate sandbox restrictions

---

## 8. SDK Type Summary

### Relevant SDK Types (`packages/shared/src/sdk/sdk.d.ts`)

```typescript
// Skill metadata
export type SlashCommand = {
  name: string;           // "my-skill"
  description: string;    // "Does X"
  argumentHint: string;   // "<arg>"
};

// Available via query.supportedCommands()
export type Query = {
  supportedCommands(): Promise<SlashCommand[]>;
  // ...
};

// Agent definition supports skills preload
export type AgentDefinition = {
  skills?: string[];  // Array of skill names to preload
  // ...
};
```

### Plugin Config (`packages/shared/src/types/sdk-config.ts`)

```typescript
export interface PluginConfig {
  type: 'local';
  path: string;  // Absolute or relative path to plugin directory
}

export interface SDKConfig {
  plugins?: PluginConfig[];
  // ...
}
```

### Tools Config (`packages/shared/src/types.ts`)

```typescript
export interface ToolsConfig {
  useClaudeCodePreset?: boolean;
  settingSources?: SettingSource[];
  loadSettingSources?: boolean;
  disabledMcpServers?: string[];
}

export interface GlobalToolsConfig {
  systemPrompt: { claudeCodePreset: { allowed: boolean; defaultEnabled: boolean; } };
  settingSources: { project: { allowed: boolean; defaultEnabled: boolean; } };
  mcp: { allowProjectMcp: boolean; defaultProjectMcp: boolean; };
}

export const DEFAULT_GLOBAL_TOOLS_CONFIG: GlobalToolsConfig = { ... };
```

---

## 9. Built-in Commands

HyperNeo has a single built-in command (`merge-session`) defined in `packages/daemon/src/lib/built-in-commands.ts`:

```typescript
const BUILT_IN_COMMANDS: BuiltInCommand[] = [
  {
    name: 'merge-session',
    description: 'Complete the current worktree session by committing, merging to target branch, and pushing',
    prompt: `Complete the current worktree session workflow: ...`,
  },
];
```

This is expanded by `expandBuiltInCommand()` when a user types `/merge-session`. It is merged into the slash command list by `SlashCommandManager.updateFromInit()`.

---

## 10. MCP Handlers

The MCP handlers file (`packages/daemon/src/lib/rpc-handlers/mcp-handlers.ts`) exposes:

| RPC Method | Description |
|-----------|-------------|
| `tools.save` | Save tools config for a session (with SDK restart) |
| `mcp.updateDisabledServers` | Update disabled MCP server list |
| `mcp.getDisabledServers` | Get disabled MCP servers for a session |
| `mcp.listServers` | List MCP servers from workspace `.mcp.json` |
| `globalTools.getConfig` | Get global tools configuration |
| `globalTools.saveConfig` | Save global tools configuration |
| `mcp.registry.listErrors` | List MCP registry entries with validation errors |

There is **no `skills.*` handler** currently.

---

## 11. File Inventory

| File | Purpose |
|------|---------|
| `packages/daemon/src/lib/agent/query-options-builder.ts` | Builds SDK `Options` from session config; handles `Skill`, `WebSearch`, `plugins`, `mcpServers` per session |
| `packages/daemon/src/lib/agent/slash-command-manager.ts` | Fetches/cache/persists SDK slash commands; merges SDK + HyperNeo built-ins |
| `packages/daemon/src/lib/built-in-commands.ts` | HyperNeo's single built-in slash command (`merge-session`) |
| `packages/daemon/src/lib/agent/coordinator/coordinator.ts` | Coordinator agent definition |
| `packages/daemon/src/lib/agent/coordinator/coder.ts` | Coordinator Coder (has `Skill`) |
| `packages/daemon/src/lib/agent/coordinator/debugger.ts` | Coordinator Debugger (has `Skill`) |
| `packages/daemon/src/lib/agent/coordinator/tester.ts` | Coordinator Tester (has `Skill`) |
| `packages/daemon/src/lib/agent/coordinator/reviewer.ts` | Coordinator Reviewer (has `Skill`) |
| `packages/daemon/src/lib/agent/coordinator/vcs.ts` | Coordinator VCS (has `Skill`) |
| `packages/daemon/src/lib/agent/coordinator/verifier.ts` | Coordinator Verifier (has `Skill`) |
| `packages/daemon/src/lib/room/agents/planner-agent.ts` | Planner + Plan Writer sub-agent; both have `WebSearch`, no `Skill` |
| `packages/daemon/src/lib/room/agents/leader-agent.ts` | Leader agent; no `Skill`, no `WebSearch` |
| `packages/daemon/src/lib/room/agents/coder-agent.ts` | Room Coder; helpers path has `WebSearch`, no `Skill`; simple path uses `claude_code` preset |
| `packages/daemon/src/lib/room/agents/general-agent.ts` | General agent; uses `claude_code` preset, no explicit tools array |
| `packages/daemon/src/lib/rpc-handlers/mcp-handlers.ts` | MCP/global tools RPC handlers |
| `packages/shared/src/sdk/sdk.d.ts` | SDK types: `SlashCommand`, `AgentDefinition.skills`, `Query.supportedCommands()` |
| `packages/shared/src/types/sdk-config.ts` | `PluginConfig`, `SDKConfig.plugins` |
| `packages/shared/src/types.ts` | `ToolsConfig`, `GlobalToolsConfig`, `DEFAULT_GLOBAL_TOOLS_CONFIG` |
| `packages/web/src/components/sdk/tools/__tests__/ToolResultCard.test.tsx` | Test categorizing `Skill` as a "command tool" |

---

## 12. Summary

| Concern | Current State |
|---------|--------------|
| Skill discovery | SDK-managed (`.claude/commands/`) |
| Skill invocation | `Skill` tool in SDK; triggered via `/<name>` |
| Skill registry | None |
| Skill persistence | `session.availableCommands` in SQLite (runtime list, not config) |
| Plugin support | `PluginConfig` typed but no HyperNeo management |
| Per-room skill overrides | None |
| Skills UI | None |
| Built-in commands | 1 (`merge-session`) |
| Planner WebSearch | Available via built-in SDK tool (no skill needed) |
| MCP integration | Via `Options.mcpServers`; `strictMcpConfig` blocks settings-file discovery |
