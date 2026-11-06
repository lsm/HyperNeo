import { describe, expect, test } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat';
import { runMigration478 } from '../../../../src/storage/schema/m478-work-sessions';
import { workSessionWrites } from '../../../../src/storage/repositories/work-session-repository';
import { syncWorkSessions, workSessionRows } from '../../../../src/lib/drivers/work-session-sync';
import type { WorkAdapter } from '../../../../src/lib/drivers/types';

const adapter = (id: string, sessions?: WorkAdapter['sessions']) =>
  ({ id, capabilities: [], find: () => [], sessions }) as WorkAdapter;

describe('workSessionRows', () => {
  test('keeps named sessions under their adapter', () => {
    expect(
      workSessionRows('codex-desktop', [
        { id: 'a', name: 'Alpha', status: 'running' },
        { id: 'b', name: '', status: 'done' },
      ])
    ).toEqual([{ adapter: 'codex-desktop', id: 'a', name: 'Alpha', status: 'running' }]);
  });
});

describe('syncWorkSessions', () => {
  test('scans each adapter once, skips one without sessions, survives a failed scan', async () => {
    let scans = 0;
    const saved: unknown[] = [];
    const changed = await syncWorkSessions(
      [
        adapter('one', async () => {
          scans += 1;
          return [{ id: 'a', name: 'Alpha', status: 'done' }];
        }),
        adapter('none'),
        adapter('broken', async () => {
          throw new Error('scan failed');
        }),
      ],
      async (rows) => {
        saved.push(...rows);
        return rows.length;
      }
    );
    expect(scans).toBe(1);
    expect(changed).toBe(1);
    expect(saved).toEqual([{ adapter: 'one', id: 'a', name: 'Alpha', status: 'done' }]);
  });
});

describe('saveSessions', () => {
  test('writes new and changed sessions, leaves unchanged rows alone', () => {
    const db = new Database(':memory:');
    runMigration478(db);
    const repository = new workSessionWrites.Repository(db);
    const row = { adapter: 'one', id: 'a', name: 'Alpha', status: 'done' };
    expect(repository.saveSessions([row], 1)).toBe(1);
    expect(repository.saveSessions([row], 2)).toBe(0);
    expect(repository.saveSessions([{ ...row, name: 'Beta' }], 3)).toBe(1);
    expect(db.prepare('SELECT name, updated_at AS at FROM work_sessions').get()).toEqual({
      name: 'Beta',
      at: 3,
    });
    db.close();
  });
});
