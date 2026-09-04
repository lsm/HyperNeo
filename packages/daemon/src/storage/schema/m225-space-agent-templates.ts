import type { Database as BunDatabase } from '../sqlite-compat.ts';
import { createSpaceAgentTemplatesTable } from './space-agent-templates.ts';

export function runMigration225(db: BunDatabase): void {
  createSpaceAgentTemplatesTable(db);
}
