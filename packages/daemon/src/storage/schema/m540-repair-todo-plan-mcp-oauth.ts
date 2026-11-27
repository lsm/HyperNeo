import type { Database } from '../sqlite-compat.ts';
import { runMigration537 } from './m537-neo-todo-plan.ts';
import { runMigration539 } from './m539-mcp-oauth-auth.ts';

export function runMigration540(db: Database): void {
  runMigration537(db);
  runMigration539(db);
}
