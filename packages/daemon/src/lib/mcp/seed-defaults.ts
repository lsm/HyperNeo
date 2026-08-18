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
      repo.update(existing.id, { source: 'builtin' });
    }
  }
}
