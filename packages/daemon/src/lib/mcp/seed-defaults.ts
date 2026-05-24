/**
 * seedDefaultMcpEntries
 *
 * Seeds the built-in MCP server definitions from the central registry
 * (`src/lib/builtins.ts → BUILTIN_MCP_SERVERS`) into the application-level
 * `app_mcp_servers` table on daemon startup.
 *
 * The operation is idempotent — entries that already exist (matched by
 * `name`) are left untouched, except that legacy rows created before the
 * `source` column existed have their provenance upgraded to `'builtin'`
 * so the UI can correctly flag them.
 *
 * To add or remove a default, edit {@link BUILTIN_MCP_SERVERS} in
 * `src/lib/builtins.ts`. Do not hand-write new seeders here.
 */

import type { Database } from '../../storage/database';
import { BUILTIN_MCP_SERVERS } from '../builtins';

export function seedDefaultMcpEntries(db: Database): void {
  const repo = db.appMcpServers;

  for (const def of BUILTIN_MCP_SERVERS) {
    const existing = repo.getByName(def.name);
    if (!existing) {
      repo.create({
        name: def.name,
        description: def.description,
        sourceType: def.sourceType,
        command: def.command,
        args: def.args,
        env: def.env,
        enabled: def.enabled,
        source: 'builtin',
      });
    } else if (existing.source !== 'builtin') {
      // Upgrade provenance for legacy rows seeded before the `source` column
      // existed. Never overwrites user-customised fields (command/args/env).
      repo.update(existing.id, { source: 'builtin' });
    }
  }
}
