import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository';

describe('Space spawn reservations with owner-independent task storage', () => {
  let db: Database;
  let tasks: SpaceTaskRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`CREATE TABLE space_tasks (
      id TEXT PRIMARY KEY, space_id TEXT, status TEXT DEFAULT 'open',
      spawn_reservation_token TEXT
    )`);
    const insert = db.prepare('INSERT INTO space_tasks (id, space_id) VALUES (?, ?)');
    insert.run('standalone', null);
    insert.run('owned-a', 'space-a');
    insert.run('owned-b', 'space-b');
    tasks = new SpaceTaskRepository(db);
  });

  afterEach(() => db.close());

  function row(id: string) {
    return db.prepare('SELECT * FROM space_tasks WHERE id = ?').get(id);
  }

  test('acquires only Space tasks with allowed status and no existing reservation', () => {
    const before = row('standalone');
    expect(tasks.reserveSpawnForTick('standalone', ['open'])).toBe('superseded');
    expect(row('standalone')).toEqual(before);
    expect(tasks.reserveSpawnForTick('owned-a', ['open'])).toBe('won');
    expect(row('owned-a')).toMatchObject({ spawn_reservation_token: expect.any(String) });
    const reserved = row('owned-a');
    expect(tasks.reserveSpawnForTick('owned-a', ['open'])).toBe('superseded');
    expect(row('owned-a')).toEqual(reserved);
    expect(tasks.reserveSpawnForTick('owned-b', ['in_progress'])).toBe('superseded');
    expect(tasks.reserveSpawnForTick('owned-b', [])).toBe('superseded');
    expect(tasks.reserveSpawnForTick('missing', ['open'])).toBe('superseded');
  });

  test('release leaves standalone reservations intact and permits Space reacquisition', () => {
    db.exec("UPDATE space_tasks SET spawn_reservation_token = 'held'");
    tasks.releaseSpawnReservation('standalone');
    expect(row('standalone')).toMatchObject({ spawn_reservation_token: 'held' });
    tasks.releaseSpawnReservation('owned-a');
    expect(row('owned-a')).toMatchObject({ spawn_reservation_token: null });
    expect(row('owned-b')).toMatchObject({ spawn_reservation_token: 'held' });
    expect(tasks.reserveSpawnForTick('owned-a', ['open'])).toBe('won');
  });

  test('startup clearing spans Spaces but leaves standalone reservations intact', () => {
    db.exec("UPDATE space_tasks SET spawn_reservation_token = 'held'");
    tasks.clearAllSpawnReservations();
    expect(row('standalone')).toMatchObject({ spawn_reservation_token: 'held' });
    expect(row('owned-a')).toMatchObject({ spawn_reservation_token: null });
    expect(row('owned-b')).toMatchObject({ spawn_reservation_token: null });
  });
});
