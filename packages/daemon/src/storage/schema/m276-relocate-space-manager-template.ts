import type { Database as BunDatabase } from '../sqlite-compat.ts';
import { relocateBuiltInKeyTemplates } from './m271-relocate-built-in-key-templates.ts';

export function runMigration276(db: BunDatabase): void {
  relocateBuiltInKeyTemplates(db, ['space-manager.default']);
}
