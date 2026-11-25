import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { readAntigravityDesktop } from '../../../../src/storage/antigravity-desktop-read.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';

describe('readAntigravityDesktop', () => {
  const query = { includeClosed: false, limit: 10 };
  const remoteRoot = 'vscode-remote://ssh-remote+fixture/project';
  let dir: string;
  let statePath: string;
  let db: Database;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'antigravity-desktop-'));
    statePath = join(dir, 'catalog.db');
    db = new Database(statePath);
    db.exec(`CREATE TABLE conversation_summaries (
      conversation_id TEXT PRIMARY KEY, title TEXT, source TEXT, app_data_dir TEXT,
      workspace_uris TEXT, last_modified_time TEXT, parent_conversation_id TEXT, nesting_depth INTEGER
    )`);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function insert(id: string, roots: string, source = '', origin = 'antigravity', parent = '') {
    db.prepare('INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      id,
      `  ${id}  `,
      source,
      origin,
      roots,
      '2026-11-19T15:00:00Z',
      parent,
      parent ? 1 : 0
    );
  }

  test('finds local Desktop conversations and reports Desktop IDs for CLI deduplication', () => {
    const folder = join(dir, 'First project # %20');
    const alternate = join(dir, 'Second project');
    const roots = JSON.stringify([
      remoteRoot,
      pathToFileURL(folder).href,
      pathToFileURL(alternate).href,
    ]);
    insert('desktop', roots);
    insert('child', roots, '', 'antigravity', 'desktop');
    insert('cli', roots, 'CORTEX_TRAJECTORY_SOURCE_CLI');
    insert('cli-profile', roots, '', 'antigravity-cli');

    const result = readAntigravityDesktop({ statePath, query });
    expect(result.sessions).toEqual([
      { id: 'desktop', title: 'desktop', folder, updatedAt: Date.parse('2026-11-19T15:00:00Z') },
    ]);
    expect(
      readAntigravityDesktop({ statePath, query: { ...query, folder: alternate, text: 'second' } })
        .sessions
    ).toEqual([expect.objectContaining({ id: 'desktop', folder: alternate })]);
    expect(readAntigravityDesktop({ statePath }).ids.sort()).toEqual(['child', 'desktop']);
  });

  test.each(['', '[]'])('shows a conversation without a project for roots %j', (roots) => {
    insert('desktop', roots);
    expect(readAntigravityDesktop({ statePath, query }).sessions).toEqual([
      expect.objectContaining({ id: 'desktop', folder: undefined }),
    ]);
  });

  test.each(['[invalid', '{}', JSON.stringify([remoteRoot])])(
    'hides a conversation with no usable local roots for %j',
    (roots) => {
      insert('desktop', roots);
      expect(readAntigravityDesktop({ statePath, query }).sessions).toEqual([]);
    }
  );

  test.each([false, true])('guards the read-only fallback with a live WAL: %s', (liveWal) => {
    if (liveWal) db.exec('PRAGMA journal_mode=WAL');
    insert('desktop', '[]');
    const wal = liveWal ? readFileSync(`${statePath}-wal`) : null;
    if (wal) expect(wal.length).toBeGreaterThan(0);
    const error = new Error('attempt to write a readonly database');
    const failRead = vi.spyOn(Database.prototype, 'exec').mockImplementationOnce(() => {
      throw error;
    });
    try {
      if (wal) {
        expect(() => readAntigravityDesktop({ statePath, query })).toThrow(error);
        expect(readFileSync(`${statePath}-wal`)).toEqual(wal);
      } else {
        expect(readAntigravityDesktop({ statePath, query }).sessions).toEqual([
          expect.objectContaining({ id: 'desktop' }),
        ]);
      }
    } finally {
      failRead.mockRestore();
    }
  });
});
