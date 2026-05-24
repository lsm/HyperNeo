/**
 * Application-level MCP Server Registry Types
 *
 * These types define the schema for MCP servers registered at the application level.
 * Registered servers are available to any room or session that enables them.
 *
 * Env var handling note:
 * The `env` field stores plain JSON key-value pairs intended for non-secret configuration.
 * For secrets such as API keys, the field stores a reference key and the actual value
 * is read from the system environment at spawn time (process.env[key]). Do NOT store raw
 * secret values in SQLite.
 */

export type AppMcpServerSourceType = 'stdio' | 'sse' | 'http';

/**
 * Provenance of a registry entry. Written once at create time; never mutates.
 *
 *   - `builtin`  — seeded by `seedDefaultMcpEntries` on daemon startup.
 *   - `user`     — created via the MCP Servers UI / `mcp.registry.create` RPC.
 *   - `imported` — discovered by `McpImportService` scanning `.mcp.json` files.
 *                  `sourcePath` records the absolute path of the originating file.
 */
export type AppMcpServerSource = 'builtin' | 'user' | 'imported';

/**
 * An MCP server registered at the application level.
 */
export interface AppMcpServer {
  /** Unique identifier (UUID) */
  id: string;
  /** Human-readable name, unique across the registry */
  name: string;
  /** Optional description of what the server provides */
  description?: string;
  /** Transport type: stdio, SSE, or HTTP */
  sourceType: AppMcpServerSourceType;
  /** Executable command (stdio servers) */
  command?: string;
  /** Command arguments (stdio servers) */
  args?: string[];
  /**
   * Environment variable overrides for the server process (stdio servers).
   * Values are non-secret config or reference keys (e.g. "MY_API_KEY" → read from process.env).
   */
  env?: Record<string, string>;
  /** Server URL (SSE or HTTP servers) */
  url?: string;
  /** Additional HTTP headers (SSE or HTTP servers) */
  headers?: Record<string, string>;
  /** Whether this server is enabled globally */
  enabled: boolean;
  /**
   * Where this entry came from. See `AppMcpServerSource`. Always set; defaults
   * to `'user'` when omitted from create requests so the existing
   * `mcp.registry.create` RPC works without a schema change.
   */
  source: AppMcpServerSource;
  /**
   * Absolute path of the originating `.mcp.json` file for `source='imported'`
   * entries. Always undefined for `builtin` and `user` entries.
   */
  sourcePath?: string;
  /** Unix timestamp (ms) when the record was created */
  createdAt?: number;
  /** Unix timestamp (ms) when the record was last updated */
  updatedAt?: number;
}

/**
 * Request payload to create a new application-level MCP server entry.
 * `id` is generated server-side. `enabled` defaults to `true` if omitted,
 * `source` defaults to `'user'` if omitted.
 */
export type CreateAppMcpServerRequest = Omit<AppMcpServer, 'id' | 'enabled' | 'source'> & {
  enabled?: boolean;
  source?: AppMcpServerSource;
};

/**
 * Request payload to update an existing application-level MCP server entry.
 * All fields except `id` are optional.
 *
 * Note: `source` and `sourcePath` are write-once-at-create in normal flows.
 * They are exposed here as optional only so the import service can adjust
 * provenance when a row transitions between `imported` and `user` (e.g. a
 * user takes over an imported entry by editing it).
 */
export type UpdateAppMcpServerRequest = { id: string } & Partial<Omit<AppMcpServer, 'id'>>;
