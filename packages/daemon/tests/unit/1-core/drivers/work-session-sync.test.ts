import { describe, expect, test } from 'bun:test';
import { workerIdentity } from '@hyperneo/shared/types/worker-identity';
import { Database } from '../../../../src/storage/sqlite-compat';
import { createTables, runMigrations } from '../../../../src/storage/schema';
import { runMigration478 } from '../../../../src/storage/schema/m478-work-sessions';
import { runMigration479 } from '../../../../src/storage/schema/m479-work-session-activity';
import { NeoTodoSessionRepository } from '../../../../src/storage/repositories/neo-todo-session-repository';
import { workSessionWrites } from '../../../../src/storage/repositories/work-session-repository';
import { syncWorkSessions, workSessionRows } from '../../../../src/lib/drivers/work-session-sync';
import type { WorkAdapter } from '../../../../src/lib/drivers/types';
import { claudeCodeSessions } from '../../../../src/lib/drivers/claude-code-adapter';

const adapter = (id: string, sessions?: WorkAdapter['sessions']) =>
  ({ id, capabilities: [], find: () => [], sessions }) as WorkAdapter;

describe('workSessionRows', () => {
  test('keeps every session under its adapter, named or not', () => {
    expect(
      workSessionRows('codex-desktop', [
        { id: 'a', name: 'Alpha', status: 'running', lastActivityAt: 7 },
        { id: 'b', name: '', status: 'done', lastActivityAt: 8 },
      ])
    ).toEqual([
      { adapter: 'codex-desktop', id: 'a', name: 'Alpha', status: 'running', lastActivityAt: 7 },
      { adapter: 'codex-desktop', id: 'b', name: '', status: 'done', lastActivityAt: 8 },
    ]);
  });
});

describe('claudeCodeSessions', () => {
  test('marks a session with no live process stopped, so refresh reads it once', () => {
    expect(
      claudeCodeSessions(
        [
          { sessionId: 'live', folder: '/a', at: 5 },
          { sessionId: 'gone', folder: '/b', at: 6 },
        ],
        [{ sessionId: 'live', status: 'busy', name: 'Worker' }]
      )
    ).toEqual([
      { id: 'live', name: 'Worker', status: 'running', lastActivityAt: 5 },
      { id: 'gone', name: '', status: 'stopped', lastActivityAt: 6 },
    ]);
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
          return [{ id: 'a', name: 'Alpha', status: 'done', lastActivityAt: 1 }];
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
    expect(saved).toEqual([
      { adapter: 'one', id: 'a', name: 'Alpha', status: 'done', lastActivityAt: 1 },
    ]);
  });
});

describe('saveSessions', () => {
  test('writes new and changed sessions, leaves unchanged rows alone', () => {
    const db = new Database(':memory:');
    runMigration478(db);
    runMigration479(db);
    const repository = new workSessionWrites.Repository(db);
    const row = { adapter: 'one', id: 'a', name: 'Alpha', status: 'done', lastActivityAt: 1 };
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

describe('workerName', () => {
  function database() {
    const db = new Database(':memory:');
    createTables(db);
    runMigrations(db, () => {});
    db.exec('PRAGMA foreign_keys = OFF');
    return db;
  }

  test('prefers the synced name, then the latest todo title, else nothing', () => {
    const db = database();
    const repository = new NeoTodoSessionRepository(db);
    const ref = { adapter: 'claude-code', id: 'a' };
    const session = db.prepare(
      'INSERT INTO neo_todo_sessions (todo_id, target, ref) VALUES (?, ?, ?)'
    );
    const todo = db.prepare(
      `INSERT INTO neo_todos (id, ask_id, position, title, done_when, created_at, updated_at)
       VALUES (?, 'ask', 0, ?, 'Seen', 0, ?)`
    );
    for (const [id, title, at] of [
      ['t1', 'Older todo', 1],
      ['t2', 'Newer todo', 2],
    ] as const) {
      todo.run(id, title, at);
      session.run(id, '{}', JSON.stringify(ref));
    }
    expect(repository.workerName({ adapter: 'claude-code', id: 'none' })).toBeNull();
    expect(repository.workerName(ref)).toBe('Newer todo');
    expect(repository.workerName(workerIdentity(ref, null))).toBe('Newer todo');
    todo.run('t3', 'Remote todo', 3);
    session.run('t3', '{}', '{"adapter":"codex-desktop","daemon":"other","id":"b"}');
    expect(repository.workerName({ adapter: 'codex-desktop', id: 'b', daemon: 'other' })).toBe(
      'Remote todo'
    );
    todo.run('t4', 'Queued todo', 4);
    db.prepare('INSERT INTO neo_todo_sessions (todo_id, target) VALUES (?, ?)').run(
      't4',
      JSON.stringify({ ref: { adapter: 'claude-code', id: 'queued' } })
    );
    expect(repository.workerName({ adapter: 'claude-code', id: 'queued' })).toBe('Queued todo');
    new workSessionWrites.Repository(db).saveSessions(
      [{ ...ref, name: 'Synced', status: 'done', lastActivityAt: 1 }],
      1
    );
    expect(repository.workerName(ref)).toBe('Synced');
    new workSessionWrites.Repository(db).saveSessions(
      [{ ...ref, name: '', status: 'done', lastActivityAt: 2 }],
      2
    );
    expect(repository.workerName(ref)).toBe('Newer todo');
    expect(repository.workerName({ ...ref, daemon: 'other' })).toBeNull();
    db.close();
  });
});
