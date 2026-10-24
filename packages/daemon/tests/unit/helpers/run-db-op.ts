import { DbGateway } from '../../../src/storage/db-gateway/db-gateway';
import { ChangeRecorder, type RunDbOp } from '../../../src/storage/db-gateway/db-op';
import type { Database } from '../../../src/storage/sqlite-compat';

export function runDbOpOn(db: Database, notify: (table: string) => void = () => {}): RunDbOp {
  const lane = new DbGateway(':memory:', db);
  lane.onChanges = (changes) => {
    for (const { table } of changes) notify(table);
  };
  return (op, args) => lane.run(op, args);
}

export function fixtureChanges(): ChangeRecorder {
  return new ChangeRecorder();
}
