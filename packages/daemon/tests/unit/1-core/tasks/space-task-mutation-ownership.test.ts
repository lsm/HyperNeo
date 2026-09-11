import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository';
import type { ReactiveDatabase } from '../../../../src/storage/reactive-database';

describe('Space mutations with owner-independent task storage', () => {
  let db: Database;
  let tasks: SpaceTaskRepository;
  const notifyChange = mock(() => {});

  beforeEach(() => {
    notifyChange.mockClear();
    db = new Database(':memory:');
    db.exec(`CREATE TABLE space_tasks (
      id TEXT PRIMARY KEY, space_id TEXT, task_number INTEGER DEFAULT 1,
      title TEXT DEFAULT 'Task', description TEXT DEFAULT '', status TEXT DEFAULT 'open',
      priority TEXT DEFAULT 'normal', labels TEXT DEFAULT '[]', depends_on TEXT DEFAULT '[]',
      created_at INTEGER DEFAULT 1, updated_at INTEGER DEFAULT 1,
      started_at INTEGER, completed_at INTEGER, archived_at INTEGER,
      terminal_generation INTEGER DEFAULT 0, task_agent_session_id TEXT
    );
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, status TEXT DEFAULT 'active', type TEXT DEFAULT 'worker',
      task_id TEXT, archived_at TEXT
    );
    CREATE TABLE message_search_content (
      kind TEXT, source_id TEXT, task_id TEXT, space_id TEXT, task_number INTEGER,
      title TEXT, body TEXT, timestamp INTEGER, session_id TEXT
    )`);
    const insert = db.prepare(
      'INSERT INTO space_tasks (id, space_id, task_agent_session_id) VALUES (?, ?, ?)'
    );
    insert.run('standalone', null, 'standalone-session');
    insert.run('owned', 'space', 'owned-session');
    for (const id of ['standalone', 'owned']) {
      db.prepare('INSERT INTO sessions (id, task_id) VALUES (?, ?)').run(`${id}-session`, id);
      db.prepare(
        "INSERT INTO message_search_content (kind, source_id, task_id, session_id, body) VALUES ('message', ?, ?, ?, 'original')"
      ).run(`${id}-message`, id, `${id}-session`);
    }
    tasks = new SpaceTaskRepository(db, { notifyChange } as unknown as ReactiveDatabase);
  });

  afterEach(() => db.close());

  function snapshot(id: string) {
    return {
      task: db.prepare('SELECT * FROM space_tasks WHERE id = ?').get(id),
      session: db.prepare('SELECT * FROM sessions WHERE task_id = ?').get(id),
      search: db.prepare('SELECT * FROM message_search_content WHERE task_id = ?').all(id),
    };
  }

  test.each([
    'update',
    'archive',
    'delete',
  ] as const)('%s leaves standalone state and effects untouched', (operation) => {
    const before = snapshot('standalone');
    const result =
      operation === 'update'
        ? tasks.updateTask('standalone', { title: 'Changed', status: 'archived' })
        : operation === 'archive'
          ? tasks.archiveTask('standalone')
          : tasks.deleteTask('standalone');
    expect(result).toBe(operation === 'delete' ? false : null);
    expect(snapshot('standalone')).toEqual(before);
    expect(notifyChange).not.toHaveBeenCalled();
  });

  test('owned updates preserve indexing and terminal session archival', () => {
    expect(tasks.updateTask('owned', { title: 'Changed', status: 'archived' })).toMatchObject({
      title: 'Changed',
      status: 'archived',
    });
    expect(snapshot('owned').session).toMatchObject({ status: 'archived' });
    expect(snapshot('owned').search).toEqual([
      expect.objectContaining({ kind: 'task', title: 'Changed' }),
    ]);
    expect(notifyChange).toHaveBeenCalledWith('space_tasks');
  });

  test('owned archive and deletion preserve their effects', () => {
    expect(tasks.archiveTask('owned')).toMatchObject({ status: 'archived', terminalGeneration: 1 });
    expect(snapshot('owned').session).toMatchObject({ status: 'archived' });
    expect(tasks.deleteTask('owned')).toBe(true);
    expect(snapshot('owned').task).toBeNull();
    expect(snapshot('owned').search).toEqual([]);
    expect(notifyChange).toHaveBeenCalledTimes(2);
  });

  test('missing IDs retain existing return and notification behavior', () => {
    expect(tasks.updateTask('missing', { title: 'Changed' })).toBeNull();
    expect(tasks.archiveTask('missing')).toBeNull();
    expect(tasks.deleteTask('missing')).toBe(false);
    expect(notifyChange).toHaveBeenCalledTimes(2);
  });
});
