# Skills

Skills extend HyperNeo's capabilities by integrating external tools, commands, and services into agent sessions. A skill can be a plugin that adds custom behavior, or an MCP server that provides additional tools.

## What are Skills?

In HyperNeo, a skill is a configured capability that can be invoked by an agent during a session. Skills fall into three categories:

- **Plugin skills** — Local executable scripts or programs that extend agent functionality
- **MCP server skills** — [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) servers that provide tools via the MCP standard
- **Built-in skills** — Capabilities shipped with HyperNeo that require no configuration (Web Search MCP, Chrome DevTools MCP, Playwright, and Playwright Interactive)

Skills are configured **globally** at the application level and are available to all sessions.

Note: SDK slash commands (e.g., `/merge-session`) are managed by the SDK and are always available — they are not part of the Skills system.

## Adding a Skill

### Via Settings > Skills

1. Open **Settings** (gear icon in the top-right navigation)
2. Select **Skills** in the left sidebar
3. Click **Add Skill**
4. Fill in the skill details (see Source Types below)
5. Click **Save**

The skill is now registered in the global skills registry and can be enabled in any Space.

### Source Types

When adding a skill, you choose a source type that determines how the skill is invoked:

#### Plugin

Plugin skills execute a local executable. They require:
- **Plugin Path** — Absolute path to the plugin executable (must start with `/`)

Plugins are injected as `{ type: 'local', path }` into the SDK's plugins array.

Security: Path traversal (`..`) is rejected. Only absolute paths are accepted.

#### MCP Server

MCP server skills wrap an existing MCP server from the application-level MCP registry. They require:
- **MCP Server** — Select an existing MCP server entry from the dropdown

When enabled, all tools exposed by that MCP server become available to the agent.

#### Built-in

Built-in skills are shipped with HyperNeo and cannot be deleted. HyperNeo ships with four built-in skills: **Fetch MCP**, **Chrome DevTools (MCP)**, **Playwright**, and **Playwright Interactive**.

## Built-in Skills

### Chrome DevTools (MCP)

Provides browser automation and DevTools integration via the Chrome DevTools MCP server. Runs in isolated mode.

- **Name**: `chrome-devtools-mcp`
- **Type**: MCP Server (built-in, opt-in — disabled by default)
- **Command**: `bunx chrome-devtools-mcp@latest --isolated`

This skill is **opt-in**, not automatically enabled. Enable it in the global skills registry when you need browser automation capabilities.

### Playwright

CLI-first browser automation using `playwright-cli`. Invoke with `/playwright` in a session.

- **Name**: `playwright`
- **Type**: Built-in (enabled by default)
- **Skill directory (source)**: `packages/skills/playwright/`
- **Skill directory (installed)**: `~/.hyperneo/skills/playwright/`
- **Usage**: `/playwright` — drives a real browser for scraping, form filling, UI interaction, screenshots, and navigation. **Not** for running test suites.

Core workflow: open a URL → snapshot the accessibility tree to get element refs → interact via CLI commands (click, fill, type, press) → re-snapshot after DOM changes. Use the bundled `playwright_cli.sh` wrapper script (`scripts/playwright_cli.sh`) which runs via `npx` without requiring a global install.

This skill is **enabled by default**. The skill definition lives at `packages/skills/playwright/SKILL.md` in the HyperNeo repository. At startup the dev server copies it (and all other built-in skill directories) to `~/.hyperneo/skills/playwright/`; the compiled binary extracts the same files from its embedded VFS. `QueryOptionsBuilder` then registers `~/.hyperneo/skills/playwright/` as a local SDK plugin so the agent can invoke `/playwright`.

### Playwright Interactive

Persistent browser session for iterative UI debugging and visual QA. Invoke with `/playwright-interactive` in a session.

- **Name**: `playwright-interactive`
- **Type**: Built-in (enabled by default)
- **Skill directory (source)**: `packages/skills/playwright-interactive/`
- **Skill directory (installed)**: `~/.hyperneo/skills/playwright-interactive/`
- **Usage**: `/playwright-interactive` — bootstraps browser/context/page handles once and reuses them across interactions for fast iterative debugging without reopening the browser

Covers desktop and mobile web contexts, screenshot capture, functional QA checklist, visual QA checklist, signoff criteria, and cleanup with try/finally. Uses a persistent `js_repl` Playwright session.

This skill is **enabled by default**. The skill definition lives at `packages/skills/playwright-interactive/SKILL.md` in the HyperNeo repository. At startup the dev server copies it to `~/.hyperneo/skills/playwright-interactive/`; the compiled binary extracts it from its embedded VFS. `QueryOptionsBuilder` registers the directory as a local SDK plugin so the agent can invoke `/playwright-interactive`.

## Skills Architecture

For developers working on the skills system:

```
User adds skill (via Settings UI)
    ↓
skills-store.ts (frontend) → skill.create RPC
    ↓
skill-handlers.ts → SkillsManager.addSkill()
    ↓
SkillRepository.insert() → SQLite skills table
    ↓
reactiveDb.notifyChange('skills') → LiveQuery propagates to all clients

Server starts (dev or prod)
    ↓
Dev: ensureBuiltinSkills() copies packages/skills/{name}/ → ~/.hyperneo/skills/{name}/
Prod: prod-server-embedded.ts extracts VFS-embedded files → ~/.hyperneo/skills/{name}/
(existing files are never overwritten so user edits are preserved)
    ↓
Agent session starts
    ↓
QueryOptionsBuilder.build() calls SkillsManager.getEnabledSkills()
    ↓
buildPluginsFromBuiltinSkills() → SDK plugins[] (builtin skills → ~/.hyperneo/skills/{commandName}/)
buildPluginsFromSkills()        → SDK plugins[] (plugin skills → pluginPath)
getMcpServersFromSkills()       → SDK mcpServers{} (mcp_server skills)
    ↓
AgentSession initializes with skills injected
```

#### Builtin skill directory layout

`packages/skills/{commandName}/` is the canonical source. Each skill directory contains:

| Path | Purpose |
|------|---------|
| `SKILL.md` | Frontmatter + instructions — what the SDK reads as the slash command definition |
| `scripts/` | Shell or JS helpers the SKILL.md instructs the agent to invoke |
| `references/` | Reference documents (CLI help, workflow guides) loaded via `@include` |
| `agents/openai.yaml` | Display metadata (name, icon, short description) |
| `assets/` | Icons and other static assets |
| `LICENSE.txt`, `NOTICE.txt` | Attribution for any upstream content |

At runtime the agent discovers these as slash commands via the SDK's local plugin mechanism — `/playwright` maps to `~/.hyperneo/skills/playwright/`.

### Key Files

| File | Purpose |
|------|---------|
| `packages/shared/src/types/skills.ts` | TypeScript types for skills (AppSkill, configs, status) |
| `packages/daemon/src/lib/skills-manager.ts` | SkillsManager: CRUD, validation, built-in initialization |
| `packages/daemon/src/lib/rpc-handlers/skill-handlers.ts` | RPC handlers: list, get, create, update, delete, setEnabled |
| `packages/daemon/src/lib/rpc-handlers/live-query-handlers.ts` | LiveQuery: `skills.list`, `skills.byRoom` named queries |
| `packages/daemon/src/lib/agent/query-options-builder.ts` | Injects enabled builtin, plugin, and MCP server skills into SDK session options |
| `packages/cli/src/skill-utils.ts` | `ensureBuiltinSkills()` — copies `packages/skills/` → `~/.hyperneo/skills/` at dev startup |
| `packages/skills/` | Built-in skill directories (source of truth; embedded in binary) |
| `packages/web/src/lib/skills-store.ts` | Frontend reactive store with LiveQuery subscription |
| `packages/web/src/components/settings/SkillsRegistry.tsx` | Global skills management UI |
| `packages/web/src/components/room/RoomSkillsSettings.tsx` | Per-room skill override UI |

### Validation

When a skill is added or updated, an async validation job runs to verify:
- **Plugin skills**: The executable path is accessible (`fs.promises.access`)
- **MCP server skills**: The referenced MCP server entry exists in `app_mcp_servers`
- **Built-in skills**: No validation needed (always valid)

Validation status is stored in `AppSkill.validationStatus`: `pending | valid | invalid | unknown`

## Restrictions

- Built-in skills cannot be deleted
- Path traversal (`..`) is rejected for plugin paths
- MCP server skills must reference an existing MCP server entry
- Room overrides can only disable globally-enabled skills; they cannot enable a globally-disabled skill
