/**
 * Shared test helper: no-op ReactiveDatabase stub.
 *
 * Use this in unit tests that construct GoalRepository, GoalManager, or other
 * classes that require a ReactiveDatabase but don't need real change notifications.
 */

import type { ReactiveDatabase } from '../../src/storage/reactive-database';

export const noOpReactiveDb: ReactiveDatabase = {
  notifyChange: () => {},
  on: () => {},
  off: () => {},
  getTableVersion: () => 0,
  beginTransaction: () => {},
  commitTransaction: () => {},
  abortTransaction: () => {},
  db: null as never,
};
