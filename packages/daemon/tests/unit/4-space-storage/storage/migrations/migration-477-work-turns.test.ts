import { describe, expect, test } from 'bun:test';
import { WorkTurnRepository } from '../../../../../src/storage/repositories/work-turn-repository.ts';
import { runMigration477 } from '../../../../../src/storage/schema/m477-work-turns.ts';
import { runMigration479 } from '../../../../../src/storage/schema/m479-work-turn-urls.ts';
import { Database } from '../../../../../src/storage/sqlite-compat.ts';

const turn = (id: string, endedAt: number) => ({
  id,
  startedAt: endedAt - 1,
  endedAt,
  ended: 'success',
  inputs: ['in'],
  urls: ['https://example.com/a'],
  finalUrls: [],
  complete: true,
  cursor: `after-${id}`,
});

describe('migration 477: work turns', () => {
  test('a turn is stored once per worker, and the newest cursor is where reading resumes', async () => {
    const db = new Database(':memory:');
    runMigration477(db);
    runMigration479(db);
    const turns = new WorkTurnRepository(db);
    const worker = { adapter: 'hyperneo', id: 'a' };
    const other = { adapter: 'hyperneo', id: 'b' };
    expect(turns.cursor(worker)).toBeNull();
    await turns.record(worker, [turn('t1', 5), turn('t2', 9)]);
    await turns.record(worker, [turn('t2', 9)]);
    await turns.record(other, [turn('t1', 1)]);
    expect(turns.cursor({ id: 'a', adapter: 'hyperneo' })).toBe('after-t2');
    expect(turns.list(worker)).toEqual([turn('t1', 5), turn('t2', 9)]);
    db.close();
  });
});
