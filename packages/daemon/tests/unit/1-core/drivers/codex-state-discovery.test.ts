import { describe, expect, spyOn, test } from 'bun:test';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testDirectories } from '../../../helpers/temporary-directory';
import { Database } from '../../../../src/storage/sqlite-compat';
import { codexStatePath, readCodexSnapshot } from '../../../../src/storage/codex-desktop-read';

const directory = testDirectories();
function home() {
  const path = directory(join(tmpdir(), 'codex-discovery-'));
  mkdirSync(join(path, '.codex'));
  return path;
}
function state(path: string) {
  const db = new Database(path);
  db.exec(`CREATE TABLE projects(id TEXT, name TEXT, updated_at_ms INTEGER);
    CREATE TABLE project_roots(project_id TEXT, path TEXT);
    CREATE TABLE threads(id TEXT, name TEXT, title TEXT, first_user_message TEXT,
      cwd TEXT, source TEXT, archived INTEGER, updated_at_ms INTEGER)`);
  return db;
}

describe('codexStatePath', () => {
  test('a non-directory Codex home keeps daemon discovery unavailable without throwing', () => {
    const root = directory(join(tmpdir(), 'codex-invalid-'));
    writeFileSync(join(root, '.codex'), 'Not a directory');
    expect(codexStatePath(root)).toBe(join(root, '.codex', 'state_5.sqlite'));
  });

  test('an unreadable Codex directory keeps the absent-state fallback', () => {
    const root = home();
    const read = spyOn(fs, 'readdirSync').mockImplementation(() => {
      throw Object.assign(new Error('Directory unavailable'), { code: 'EACCES' });
    });
    syncBuiltinESMExports();
    try {
      expect(codexStatePath(root)).toBe(join(root, '.codex', 'state_5.sqlite'));
    } finally {
      read.mockRestore();
      syncBuiltinESMExports();
    }
  });

  test('selects the newest numbered database when the previous version remains', () => {
    const root = home();
    for (const version of [5, 6])
      writeFileSync(join(root, '.codex', `state_${version}.sqlite`), '');
    expect(codexStatePath(root)).toBe(join(root, '.codex', 'state_6.sqlite'));
  });

  test('compares numeric versions and ignores sidecars, unrelated files and directories', () => {
    const root = home();
    for (const name of [
      'state_5.sqlite',
      'state_9.sqlite',
      'state_10.sqlite',
      'state_99.sqlite-wal',
      'state_latest.sqlite',
    ])
      writeFileSync(join(root, '.codex', name), '');
    mkdirSync(join(root, '.codex', 'state_20.sqlite'));
    expect(codexStatePath(root)).toBe(join(root, '.codex', 'state_10.sqlite'));
  });

  test('preserves the absent-installation path without creating a database', () => {
    const root = directory(join(tmpdir(), 'codex-absent-'));
    expect(codexStatePath(root)).toBe(join(root, '.codex', 'state_5.sqlite'));
  });
});

describe('readCodexSnapshot schema failures', () => {
  test.each(['projects', 'project_roots', 'threads'])(
    'names the missing required %s table',
    (table) => {
      const root = home();
      const path = join(root, '.codex', 'state_6.sqlite');
      const db = state(path);
      db.exec(`DROP TABLE ${table}`);
      db.close();
      expect(() => readCodexSnapshot(path, false)).toThrow(
        new RegExp(`Unsupported Codex state schema:.*${table}`)
      );
    }
  );

  test('names a missing required column instead of returning no work', () => {
    const root = home();
    const path = join(root, '.codex', 'state_6.sqlite');
    const db = state(path);
    db.exec('ALTER TABLE threads DROP COLUMN source');
    db.close();
    expect(() => readCodexSnapshot(path, false)).toThrow(/Unsupported Codex state schema:.*source/);
  });

  test('a compatible empty database remains an ordinary empty snapshot', () => {
    const root = home();
    const path = join(root, '.codex', 'state_6.sqlite');
    state(path).close();
    expect(readCodexSnapshot(path, false)).toEqual({ roots: [], folders: [], threads: [] });
  });
});
