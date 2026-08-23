import type { ReactiveDatabase } from '../../src/storage/reactive-database';

export const noOpReactiveDb: ReactiveDatabase = {
  notifyChange: () => {},
  willEmitTableChange: () => false,
  on: () => {},
  off: () => {},
  getTableVersion: () => 0,
  beginTransaction: () => {},
  commitTransaction: () => {},
  abortTransaction: () => {},
  resolveTaskIdForSession: () => null,
  db: null as never,
};
