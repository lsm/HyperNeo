/**
 * Tools Configuration Manager
 *
 * Handles global tools configuration for sessions:
 * - Get/save global tools configuration from database
 *
 * NOTE: Per-session MCP enablement defaults are no longer derived here. New
 * sessions inherit MCP server selection directly from the unified
 * `app_mcp_servers` registry plus `mcp_enablement` overrides at query-build
 * time (see `QueryOptionsBuilder`). The legacy
 * `getDefaultForNewSession()` derivation was removed in M5.
 */

import type { Database } from '../../storage/database';

export class ToolsConfigManager {
  constructor(private db: Database) {}

  /**
   * Get the global tools configuration
   */
  getGlobal() {
    return this.db.getGlobalToolsConfig();
  }

  /**
   * Save the global tools configuration
   */
  saveGlobal(config: ReturnType<typeof this.db.getGlobalToolsConfig>) {
    this.db.saveGlobalToolsConfig(config);
  }
}
