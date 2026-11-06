import { describe, expect, test } from 'bun:test';
import { WorkTurnRepository } from '../../../../../src/storage/repositories/work-turn-repository.ts';
import { runMigration477 } from '../../../../../src/storage/schema/m477-work-turns.ts';
import { runMigration480 } from '../../../../../src/storage/schema/m480-work-turn-urls.ts';
import { Database } from '../../../../../src/storage/sqlite-compat.ts';

const turn = (id: string, endedAt: number, seq = endedAt) => ({
  id,
  startedAt: endedAt - 1,
  endedAt,
  ended: 'success',
  inputs: ['in'],
  urls: ['https://example.com/a'],
  finalUrls: [],
  complete: true,
  cursor: JSON.stringify({ seq, consumed: 0 }),
});

describe('migration 477: work turns', () => {
  test('a turn is stored once per worker, and the newest cursor is where reading resumes', async () => {
    const db = new Database(':memory:');
    runMigration477(db);
    runMigration480(db);
    const turns = new WorkTurnRepository(db);
    const worker = { adapter: 'hyperneo', id: 'a' };
    const other = { adapter: 'hyperneo', id: 'b' };
    expect(turns.cursor(worker)).toBeNull();
    await turns.record(worker, [turn('t1', 5), turn('t2', 9)]);
    await turns.record(worker, [turn('t2', 9)]);
    await turns.record(other, [turn('t1', 1)]);
    expect(turns.cursor({ id: 'a', adapter: 'hyperneo' })).toBe(turn('t2', 9).cursor);
    expect(turns.list(worker)).toEqual([turn('t1', 5), turn('t2', 9)]);
    db.close();
  });

  test('reading resumes after the last turn in the log, even when older timestamps follow it', async () => {
    const db = new Database(':memory:');
    runMigration477(db);
    runMigration480(db);
    const turns = new WorkTurnRepository(db);
    const worker = { adapter: 'claude-desktop', id: 'a' };
    await turns.record(worker, [turn('live', 9, 100), turn('replayed', 5, 200)]);
    expect(turns.cursor(worker)).toBe(turn('replayed', 5, 200).cursor);
    db.close();
  });
});
