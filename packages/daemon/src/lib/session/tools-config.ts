import type { Database } from '../../storage/database.ts';

export class ToolsConfigManager {
  constructor(private db: Database) {}

  getGlobal() {
    return this.db.getGlobalToolsConfig();
  }
}
