import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '../../../../src/storage/sqlite-compat';
import { readCodexThread, withCodexState } from '../../../../src/lib/drivers/codex-desktop-adapter';

describe('withCodexState', () => {
  let dir: string;

  afterEach(() => {
    chmodSync(dir, 0o755);
    rmSync(dir, { recursive: true, force: true });
  });

  test('reads a WAL state file that Codex is not running against', () => {
    dir = mkdtempSync(join(tmpdir(), 'codex-state-'));
    const statePath = join(dir, 'state_5.sqlite');
    const db = new Database(statePath);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT, updated_at_ms INTEGER)`);
    db.exec(`CREATE TABLE project_roots (project_id TEXT, position INTEGER, path TEXT)`);
    db.exec(`CREATE TABLE threads (id TEXT PRIMARY KEY, name TEXT, title TEXT, first_user_message TEXT,
      cwd TEXT, source TEXT, archived INTEGER, updated_at_ms INTEGER, rollout_path TEXT)`);
    db.exec(
      `INSERT INTO threads VALUES ('t1', 'loader', '', '', '/focus/dolmen', 'vscode', 0, 5, '/r.jsonl')`
    );
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.close();
    rmSync(`${statePath}-wal`, { force: true });
    rmSync(`${statePath}-shm`, { force: true });
    chmodSync(dir, 0o555);
    expect(existsSync(`${statePath}-shm`)).toBe(false);
    expect(readCodexThread(statePath, 't1')?.thread).toMatchObject({ id: 't1', title: 'loader' });
    expect(withCodexState(statePath, (state) => state.prepare('SELECT 1 AS one').get())).toEqual({
      one: 1,
    });
  });
});
