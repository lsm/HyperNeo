/**
 * Built-in MCP servers and skills registry.
 *
 * This file is the **single source of truth** for everything that ships
 * pre-configured with the daemon:
 *
 *   • `BUILTIN_MCP_SERVERS` — rows inserted into `app_mcp_servers` on first
 *     boot by `seedDefaultMcpEntries()`.
 *   • `BUILTIN_SKILLS`      — rows inserted into `skills` on first boot by
 *     `SkillsManager.initializeBuiltins()`.
 *
 * Adding a new built-in is a one-file data change: append to the relevant
 * array below. The seeders iterate these tables — no ad-hoc `initFoo()`
 * methods to keep in sync across files.
 *
 * # Wiring
 *
 * Under M1 MCP unification the SDK runs with `strictMcpConfig: true`, which
 * means it no longer auto-discovers `.mcp.json` / settings-file servers.
 * Sessions only see MCP servers that are referenced by an enabled skill. So
 * for an MCP server to reach a session, there must be:
 *
 *   1. an `app_mcp_servers` row (defined here in `BUILTIN_MCP_SERVERS`), AND
 *   2. a `skills` row with `sourceType: 'mcp_server'` pointing at it
 *      (defined here in `BUILTIN_SKILLS`).
 *
 * `QueryOptionsBuilder.getMcpServersFromSkills()` walks the skills table and
 * resolves each `mcp_server` skill back to its app_mcp_servers row, which is
 * how the server config finds its way into the SDK query options.
 */

/**
 * A pre-configured entry in the `app_mcp_servers` registry.
 *
 * All built-in MCP servers are `stdio` transports today; that constraint is
 * encoded in the type so typos can't silently produce invalid registry rows.
 */
export interface BuiltinMcpServer {
  name: string;
  description: string;
  sourceType: 'stdio';
  command: string;
  args: string[];
  env: Record<string, string>;
  /**
   * Initial `enabled` flag on the `app_mcp_servers` row. Independent of
   * whether the skill that references it is enabled — users can keep a
   * server around while turning its skill on/off.
   */
  enabled: boolean;
}

/**
 * A pre-configured entry in the `skills` registry.
 *
 * Discriminated by `kind`:
 *   • `mcp_server` skills are backed by a row in `app_mcp_servers` — the
 *     `appMcpServerName` field must match a `name` in `BUILTIN_MCP_SERVERS`.
 *   • `builtin-command` skills are backed by a local command handler and
 *     have no MCP server (e.g. Playwright).
 */
export type BuiltinSkill =
  | {
      kind: 'mcp_server';
      name: string;
      displayName: string;
      description: string;
      /** Must match `name` of an entry in {@link BUILTIN_MCP_SERVERS}. */
      appMcpServerName: string;
      enabled: boolean;
    }
  | {
      kind: 'builtin-command';
      name: string;
      displayName: string;
      description: string;
      commandName: string;
      enabled: boolean;
      /** Restrict this built-in skill to sessions with Space context. */
      spaceOnly?: boolean;
    };

/**
 * Built-in MCP server definitions, seeded into `app_mcp_servers` on first
 * boot (idempotent — pre-existing rows by name are left untouched).
 */
export const BUILTIN_MCP_SERVERS: readonly BuiltinMcpServer[] = [
  {
    name: 'fetch-mcp',
    description: 'Fetch web pages and convert to Markdown for reading documentation and articles',
    sourceType: 'stdio',
    command: 'npx',
    args: ['-y', '@tokenizin/mcp-npx-fetch'],
    env: {},
    enabled: true,
  },
  {
    name: 'chrome-devtools',
    description:
      'Browser automation and DevTools integration via Chrome DevTools MCP (isolated mode)',
    sourceType: 'stdio',
    command: 'bunx',
    args: ['chrome-devtools-mcp@latest', '--isolated'],
    env: {},
    enabled: false,
  },
] as const;

/**
 * Built-in skill definitions, seeded into `skills` on first boot (idempotent
 * — pre-existing rows by name are left untouched).
 *
 * Every `mcp_server` entry here must have its `appMcpServerName` present in
 * {@link BUILTIN_MCP_SERVERS}; this invariant is enforced by a unit test so
 * the registry can't ship in a broken state.
 */
export const BUILTIN_SKILLS: readonly BuiltinSkill[] = [
  {
    kind: 'mcp_server',
    name: 'fetch-mcp',
    displayName: 'Fetch MCP',
    description: 'Fetch web pages and convert to Markdown for reading documentation and articles',
    appMcpServerName: 'fetch-mcp',
    enabled: true, // was always on before M1 strictMcpConfig — preserve that
  },
  {
    kind: 'mcp_server',
    name: 'chrome-devtools-mcp',
    displayName: 'Chrome DevTools (MCP)',
    description:
      'Browser automation and DevTools integration via Chrome DevTools MCP. Runs in isolated mode.',
    appMcpServerName: 'chrome-devtools',
    enabled: false, // opt-in, not default
  },
  {
    kind: 'builtin-command',
    name: 'playwright',
    displayName: 'Playwright',
    description: 'Browser automation and testing via Playwright.',
    commandName: 'playwright',
    enabled: true,
  },
  {
    kind: 'builtin-command',
    name: 'playwright-interactive',
    displayName: 'Playwright Interactive',
    description: 'Interactive browser automation via Playwright with step-by-step control.',
    commandName: 'playwright-interactive',
    enabled: true,
  },
  {
    kind: 'builtin-command',
    name: 'space-coordination',
    displayName: 'Space Coordination (POC)',
    description:
      'POC fallback for Space task/workflow coordination through local runtime APIs instead of MCP.',
    commandName: 'space-coordination',
    enabled: true,
    spaceOnly: true,
  },
] as const;
