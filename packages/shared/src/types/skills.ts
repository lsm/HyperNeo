/**
 * Application-level Skills Registry Types
 *
 * These types define the schema for Skills registered at the application level.
 * Registered skills are available to any room or session that enables them.
 *
 * Source type guide:
 * - 'builtin'    — references a slash command in .claude/commands/
 * - 'plugin'     — references a local plugin directory on disk
 * - 'mcp_server' — references an existing app_mcp_servers entry by ID;
 *                  avoids duplicating MCP server config that is already
 *                  managed by the app-level MCP registry
 */

export type SkillSourceType = 'builtin' | 'plugin' | 'mcp_server';

/**
 * Config for a built-in skill backed by a .claude/commands/ slash command.
 * The `type` discriminator enables safe JSON round-tripping from SQLite.
 */
export interface BuiltinSkillConfig {
  type: 'builtin';
  /** The slash-command name (e.g. "update-config", "claude-api"). */
  commandName: string;
  /** Restrict this built-in skill to sessions scoped to a Space. */
  spaceOnly?: boolean;
}

/**
 * Config for a skill backed by a local plugin directory.
 * The `type` discriminator enables safe JSON round-tripping from SQLite.
 */
export interface PluginSkillConfig {
  type: 'plugin';
  /** Absolute path to the plugin directory on disk. */
  pluginPath: string;
}

/**
 * Config for a skill backed by an existing app-level MCP server.
 * References the server by its UUID in app_mcp_servers — no config duplication.
 * The `type` discriminator enables safe JSON round-tripping from SQLite.
 */
export interface McpServerSkillConfig {
  type: 'mcp_server';
  /** UUID of the corresponding `app_mcp_servers` row. */
  appMcpServerId: string;
}

/** Discriminated union of all possible skill configurations. */
export type AppSkillConfig = BuiltinSkillConfig | PluginSkillConfig | McpServerSkillConfig;

/** Lifecycle validation state of a skill. */
export type SkillValidationStatus = 'pending' | 'valid' | 'invalid' | 'unknown';

/**
 * A skill registered at the application level.
 * Skills can originate from built-in commands, local plugins, or MCP servers.
 */
export interface AppSkill {
  /** Unique identifier (UUID). */
  id: string;
  /** Internal unique name (slug-style, e.g. "web-search"). Immutable after creation. */
  name: string;
  /** Human-readable display name shown in the UI. */
  displayName: string;
  /** Short description of what the skill does (used for agent discovery). */
  description: string;
  /** Where the skill comes from. Immutable after creation. */
  sourceType: SkillSourceType;
  /** Source-type-specific configuration. */
  config: AppSkillConfig;
  /** Whether this skill is globally enabled. */
  enabled: boolean;
  /** True when the skill is shipped with HyperNeo and cannot be deleted. */
  builtIn: boolean;
  /**
   * Current validation state (set by the async validation job — not user-editable).
   */
  validationStatus: SkillValidationStatus;
  /** Unix timestamp (ms) when the record was created. Consistent with other HyperNeo tables. */
  createdAt: number;
}

/**
 * Payload for creating a new skill entry.
 * `id`, `createdAt`, and `builtIn` are generated / set server-side.
 */
export type CreateSkillParams = Omit<AppSkill, 'id' | 'createdAt' | 'builtIn'>;

/**
 * Payload for updating an existing skill entry.
 * Restricted to user-editable fields only:
 * - `name` and `sourceType` are immutable after creation
 * - `validationStatus` is managed by the async validation job
 */
export interface UpdateSkillParams {
  displayName?: string;
  description?: string;
  enabled?: boolean;
  config?: AppSkillConfig;
}

/**
 * Session-spawn skill override used to disable globally enabled skills for a
 * specific runtime session.
 */
export interface SkillEnablementOverride {
  skillId: string;
  enabled: boolean;
}

/**
 * Params for the skill.installFromGit RPC handler.
 */
export interface InstallSkillFromGitParams {
  /** GitHub tree/blob URL or raw content URL for the skill directory or file. */
  repoUrl: string;
  /** Name to register the skill under (also used as the command file name). */
  commandName: string;
}

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

/** Returns true when `config` is a {@link BuiltinSkillConfig}. */
export function isBuiltinSkillConfig(config: AppSkillConfig): config is BuiltinSkillConfig {
  return config.type === 'builtin';
}

/** Returns true when `config` is a {@link PluginSkillConfig}. */
export function isPluginSkillConfig(config: AppSkillConfig): config is PluginSkillConfig {
  return config.type === 'plugin';
}

/** Returns true when `config` is a {@link McpServerSkillConfig}. */
export function isMcpServerSkillConfig(config: AppSkillConfig): config is McpServerSkillConfig {
  return config.type === 'mcp_server';
}
