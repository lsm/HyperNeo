import type { SessionToolChoiceInput } from '../../lib/tools/session-tool-choice.ts';
import type { Database } from '../sqlite-compat.ts';

export type ToolSelectionCatalog = Pick<
  SessionToolChoiceInput,
  'skills' | 'registry' | 'overrides'
>;

export function migrateSessionToolSelections(
  _db: Database,
  _catalog: ToolSelectionCatalog
): number {
  return 0;
}
