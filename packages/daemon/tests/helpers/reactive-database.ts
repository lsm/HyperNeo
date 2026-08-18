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
