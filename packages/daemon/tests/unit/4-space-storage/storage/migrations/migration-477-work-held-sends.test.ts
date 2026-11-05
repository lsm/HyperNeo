import { describe, expect, test } from 'bun:test';
import { WorkHeldSendRepository } from '../../../../../src/storage/repositories/work-held-send-repository.ts';
import { runMigration477 } from '../../../../../src/storage/schema/m477-work-held-sends.ts';
import { Database } from '../../../../../src/storage/sqlite-compat.ts';

describe('migration 477: held work sends', () => {
  test('a repeated key holds one send, and the oldest per worker comes next', async () => {
    const db = new Database(':memory:');
    runMigration477(db);
    runMigration477(db);
    const held = new WorkHeldSendRepository(db);
    const worker = { adapter: 'hyperneo', id: 'a' };
    const other = { adapter: 'hyperneo', id: 'b' };
    await held.hold({ key: 'one', todoId: 't1', ref: worker, message: 'One' }, 1);
    await held.hold({ key: 'one', todoId: 't1', ref: worker, message: 'One' }, 2);
    await held.hold({ key: 'two', todoId: 't2', ref: worker, message: 'Two' }, 3);
    await held.hold({ key: 'three', todoId: 't3', ref: other, message: 'Three' }, 4);
    expect(held.nextPerWorker().map((send) => send.key)).toEqual(['one', 'three']);
    await held.remove({ key: 'one', ref: worker });
    expect(held.nextPerWorker().map((send) => send.key)).toEqual(['two', 'three']);
    db.close();
  });

  test('a fence outlives its repository and lifts once', async () => {
    const db = new Database(':memory:');
    runMigration477(db);
    const worker = { adapter: 'codex-desktop', id: 'a' };
    await new WorkHeldSendRepository(db).fence(worker, { since: 5, submission: 'q' });
    const reopened = new WorkHeldSendRepository(db);
    expect(reopened.fenceOf({ id: 'a', adapter: 'codex-desktop' })).toEqual({
      since: 5,
      submission: 'q',
    });
    await reopened.fence(worker, null);
    expect(reopened.fenceOf(worker)).toBeNull();
    db.close();
  });

  test('one key held for two workers stays two sends', async () => {
    const db = new Database(':memory:');
    runMigration477(db);
    const held = new WorkHeldSendRepository(db);
    const worker = { adapter: 'hyperneo', id: 'a' };
    const other = { adapter: 'hyperneo', id: 'b' };
    await held.hold({ key: 'same', todoId: 't1', ref: worker, message: 'One' }, 1);
    await held.hold({ key: 'same', todoId: 't1', ref: other, message: 'Two' }, 2);
    expect(held.nextPerWorker().map((send) => send.message)).toEqual(['One', 'Two']);
    await held.remove({ key: 'same', ref: { id: 'a', adapter: 'hyperneo' } });
    expect(held.nextPerWorker().map((send) => send.message)).toEqual(['Two']);
    db.close();
  });
});
