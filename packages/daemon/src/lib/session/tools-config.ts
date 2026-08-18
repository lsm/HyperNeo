import type { Database } from '../../storage/database';

export class ToolsConfigManager {
  constructor(private db: Database) {}

  getGlobal() {
    return this.db.getGlobalToolsConfig();
  }

  saveGlobal(config: ReturnType<typeof this.db.getGlobalToolsConfig>) {
    this.db.saveGlobalToolsConfig(config);
  }
}
