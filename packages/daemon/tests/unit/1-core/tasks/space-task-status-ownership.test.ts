import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository';

describe('Space status arbitration with owner-independent task storage', () => {
  let db: Database;
  let tasks: SpaceTaskRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`CREATE TABLE space_tasks (
      id TEXT PRIMARY KEY, space_id TEXT, status TEXT DEFAULT 'open',
      terminal_generation INTEGER DEFAULT 0, restrictions TEXT,
      updated_at INTEGER DEFAULT 1, started_at INTEGER, completed_at INTEGER
    )`);
    const insert = db.prepare('INSERT INTO space_tasks (id, space_id) VALUES (?, ?)');
    insert.run('standalone', null);
    insert.run('owned', 'space');
    tasks = new SpaceTaskRepository(db);
  });

  afterEach(() => db.close());

  function row(id: string) {
    return db.prepare('SELECT * FROM space_tasks WHERE id = ?').get(id);
  }

  test('plain status arbitration cannot modify standalone tasks', () => {
    const before = row('standalone');
    expect(tasks.casStatus('standalone', ['open', 'review'], 'done')).toBe('superseded');
    expect(row('standalone')).toEqual(before);
    expect(tasks.casStatus('owned', ['open', 'review'], 'done')).toBe('won');
    expect(row('owned')).toMatchObject({ status: 'done', terminal_generation: 1, updated_at: 1 });
    expect(tasks.casStatus('owned', 'done', 'done')).toBe('won');
    expect(row('owned')).toMatchObject({ terminal_generation: 1 });
    expect(tasks.casStatus('owned', 'open', 'cancelled')).toBe('superseded');
    expect(tasks.casStatus('missing', 'open', 'done')).toBe('superseded');
    expect(tasks.casStatus('owned', [], 'done')).toBe('superseded');
  });

  test('payload arbitration cannot alter standalone timestamps or restrictions', () => {
    db.prepare('UPDATE space_tasks SET restrictions = ?, completed_at = 12').run('existing');
    const before = row('standalone');
    expect(
      tasks.casStatusWithPayload('standalone', 'open', 'in_progress', { restrictions: null })
    ).toBe('superseded');
    expect(row('standalone')).toEqual(before);
    expect(tasks.casStatusWithPayload('owned', 'open', 'in_progress', { restrictions: null })).toBe(
      'won'
    );
    expect(row('owned')).toMatchObject({
      status: 'in_progress',
      restrictions: null,
      completed_at: null,
      started_at: expect.any(Number),
      updated_at: expect.any(Number),
      terminal_generation: 0,
    });
    const changed = row('owned');
    expect(tasks.casStatusWithPayload('owned', 'open', 'done', { restrictions: null })).toBe(
      'superseded'
    );
    expect(row('owned')).toEqual(changed);
    expect(tasks.casStatusWithPayload('owned', 'in_progress', 'done', { restrictions: null })).toBe(
      'won'
    );
    expect(row('owned')).toMatchObject({ status: 'done', terminal_generation: 1 });
    expect(tasks.casStatusWithPayload('missing', 'open', 'done', { restrictions: null })).toBe(
      'superseded'
    );
    expect(tasks.casStatusWithPayload('owned', [], 'done', { restrictions: null })).toBe(
      'superseded'
    );
  });
});
