import type { Database } from '../../storage/database.ts';
import { neoCoordinatorBinding } from './session-policy.ts';

export function neoModelFallbacks(db: Database, sessionId: string) {
  return neoCoordinatorBinding(db, sessionId)
    ? db.getGlobalSettings().neo?.preferences?.fallbacks
    : undefined;
}
