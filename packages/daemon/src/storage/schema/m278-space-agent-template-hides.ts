import type { Database } from '../sqlite-compat.ts';
import { createSpaceAgentTemplateHidesTable } from './space-agent-templates.ts';

export function runMigration278(db: Database): void {
  createSpaceAgentTemplateHidesTable(db);
}
