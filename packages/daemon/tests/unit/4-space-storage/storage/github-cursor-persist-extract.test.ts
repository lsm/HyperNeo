import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { vi } from 'vitest';
import { Database } from '../../../../src/storage/sqlite-compat';
import {
  GitHubEventExtensionRepository,
  type PollCursor,
} from '../../../../src/lib/external-events/github/github-repository';
import { createWatchedTable, insertWatchedRow } from '../../helpers/github-watched-read-fixture';

type Persist = (db: Database, id: string, cursor: PollCursor) => void;
async function persistence(): Promise<Persist> {
  const file = new URL(
    '../../../../src/storage/repositories/github-cursor-persist.ts',
    import.meta.url
  );
  if (!existsSync(file))
    throw new Error('Constructor-free GitHub cursor persistence is unavailable');
  return (await import(file.href)).persistGitHubPollCursorJson;
}
describe('GitHub cursor persistence extraction', () => {
  let db: Database;
  let repo: GitHubEventExtensionRepository;
  const cursor: PollCursor = { lastSeenAt: 51, etags: { issues: 'synthetic-etag' } };
  const rows = () =>
    db.prepare('SELECT * FROM space_github_watched_repos ORDER BY id').all() as Record<
      string,
      unknown
    >[];
  beforeEach(() => {
    db = new Database(':memory:');
    db.exec('CREATE TABLE spaces(id TEXT PRIMARY KEY)');
    createWatchedTable(db);
    repo = new GitHubEventExtensionRepository(db);
    insertWatchedRow(db);
    insertWatchedRow(db, { id: 'synthetic-peer', space_id: 'another-space' });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
  });
  test('legacy update reads one clock and preserves every unrelated row field', () => {
    const before = rows();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(41);
    expect(repo.updatePollCursorJson('synthetic-one', cursor)).toBeUndefined();
    expect(clock).toHaveBeenCalledTimes(1);
    expect(rows()).toEqual([
      { ...before[0], poll_cursor: JSON.stringify(cursor), updated_at: 41 },
      before[1],
    ]);
  });
  test('helper preserves SQL, bindings and prepare/serialize/clock/run evaluation order', async () => {
    const persist = await persistence(),
      prepare = db.prepare.bind(db),
      events: string[] = [],
      captures: { sql: string; args: unknown[] }[] = [];
    vi.spyOn(db, 'prepare').mockImplementation((...args) => {
      const target = args[0].startsWith('UPDATE space_github_watched_repos SET poll_cursor');
      if (target) events.push('prepare');
      const statement = prepare(...args);
      if (!target) return statement;
      return new Proxy(statement, {
        get(object, key) {
          const value = Reflect.get(object, key);
          if (typeof value !== 'function') return value;
          return (...bindings: unknown[]) => {
            if (key === 'run') {
              events.push('run');
              captures.push({ sql: args[0], args: bindings });
            }
            return Reflect.apply(value, object, bindings);
          };
        },
      });
    });
    const serializable = {
      toJSON() {
        events.push('serialize');
        return cursor;
      },
    } as unknown as PollCursor;
    vi.spyOn(Date, 'now').mockImplementation(() => {
      events.push('clock');
      return 41;
    });
    const legacy = repo.updatePollCursorJson('synthetic-one', serializable);
    expect(events).toEqual(['prepare', 'serialize', 'clock', 'run']);
    events.length = 0;
    expect(persist(db, 'synthetic-one', serializable)).toBe(legacy);
    expect(events).toEqual(['prepare', 'serialize', 'clock', 'run']);
    expect(captures[1]).toEqual(captures[0]);
    expect(captures[0].args).toEqual([JSON.stringify(cursor), 41, 'synthetic-one']);
  });
  test('serialization failure leaves rows unchanged and does not read the clock', async () => {
    const persist = await persistence(),
      before = rows();
    const invalid = {
      toJSON() {
        throw new Error('synthetic serialization rejected');
      },
    } as unknown as PollCursor;
    const clock = vi.spyOn(Date, 'now');
    expect(() => repo.updatePollCursorJson('synthetic-one', invalid)).toThrow(
      'synthetic serialization rejected'
    );
    expect(() => persist(db, 'synthetic-one', invalid)).toThrow('synthetic serialization rejected');
    expect(clock).not.toHaveBeenCalled();
    expect(rows()).toEqual(before);
  });
  test('statement preparation fails before serialization and clock with no initialization', async () => {
    const persist = await persistence(),
      scratch = new Database(':memory:');
    const serialize = vi.fn(() => {
      throw new Error('serialization must not run');
    });
    const invalid = { toJSON: serialize } as unknown as PollCursor;
    const clock = vi.spyOn(Date, 'now');
    try {
      expect(() => persist(scratch, 'synthetic-one', invalid)).toThrow(/no such table/);
      expect(serialize).not.toHaveBeenCalled();
      expect(clock).not.toHaveBeenCalled();
      expect(
        scratch
          .prepare("SELECT name FROM sqlite_master WHERE name='space_github_source_settings'")
          .get()
      ).toBeNull();
    } finally {
      scratch.close();
    }
  });
  test('helper retains caller rollback, row-id isolation and missing-id void result', async () => {
    const persist = await persistence(),
      before = rows();
    expect(() =>
      db.transaction(() => {
        persist(db, 'synthetic-one', cursor);
        throw new Error('synthetic rollback');
      })()
    ).toThrow('synthetic rollback');
    expect(rows()).toEqual(before);
    expect(persist(db, 'missing', cursor)).toBeUndefined();
    expect(rows()).toEqual(before);
  });
});
