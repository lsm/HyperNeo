import { DbGateway, spaceTaskLaneFor } from '../../../src/storage/db-gateway/db-gateway';
import { ChangeRecorder, type RunDbOp } from '../../../src/storage/db-gateway/db-op';
import {
  spaceTaskWrites,
  type WriteSpaceTask,
} from '../../../src/storage/repositories/space-task-repository';
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

export function writeSpaceTaskOn(db: Database): WriteSpaceTask {
  return (method, ...args) => spaceTaskLaneFor(db).call(spaceTaskWrites, method, ...args);
}
