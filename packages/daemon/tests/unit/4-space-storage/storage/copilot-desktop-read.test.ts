import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { readCopilotDesktop } from '../../../../src/storage/copilot-desktop-read.ts';

describe('readCopilotDesktop', () => {
  test('reads local Desktop sessions and keeps the database intact', () => {
    const dir = mkdtempSync(join(tmpdir(), 'copilot-desktop-'));
    const statePath = join(dir, 'data.db');
    try {
      const db = new Database(statePath);
      try {
        db.exec(`
          CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT, main_repo_path TEXT);
          CREATE TABLE worktrees (id TEXT PRIMARY KEY, path TEXT);
          CREATE TABLE sessions (
            id TEXT PRIMARY KEY, title TEXT, updated_at TEXT, is_running INTEGER,
            was_interrupted INTEGER, archived_at TEXT, execution_location TEXT, provisional INTEGER
          );
          CREATE TABLE workspaces (
            id TEXT PRIMARY KEY, session_id TEXT UNIQUE, project_id TEXT, worktree_id TEXT,
            name TEXT, source_path TEXT, archived_at TEXT, host_id TEXT, workspace_type TEXT
          );
          INSERT INTO projects VALUES ('p', 'Project', '/project');
          INSERT INTO worktrees VALUES ('t', '/worktree');
          INSERT INTO sessions VALUES
            ('active', 'Desktop work', '2026-11-19T15:00:00Z', 1, 0, NULL, 'local', 0),
            ('old', NULL, '2026-11-19T14:00:00Z', 0, 0, NULL, 'local', 0),
            ('cloud', 'Cloud work', '2026-11-19T13:00:00Z', 1, 0, NULL, 'cloud', 0),
            ('draft', 'Draft work', '2026-11-19T12:00:00Z', 0, 0, NULL, 'local', 1);
          INSERT INTO workspaces VALUES
            ('w1', 'active', 'p', 't', 'Active', '/project', NULL, 'local', 'worktree'),
            ('w2', 'old', 'p', NULL, 'Archived work', '/project', '2026-11-19', 'local', 'folder'),
            ('w3', 'cloud', 'p', NULL, 'Cloud', '/project', NULL, 'local', 'cloud'),
            ('w4', 'draft', 'p', NULL, 'Draft', '/project', NULL, 'local', 'folder');
        `);
      } finally {
        db.close();
      }
      const before = readFileSync(statePath);
      const query = { includeClosed: false, limit: 20 };
      expect(readCopilotDesktop({ statePath, query })).toEqual([
        expect.objectContaining({
          id: 'active',
          workspaceId: 'w1',
          folder: '/project',
          directory: '/worktree',
          running: 1,
        }),
      ]);
      expect(
        readCopilotDesktop({
          statePath,
          query: { ...query, includeClosed: true, text: 'archived' },
        })
      ).toEqual([expect.objectContaining({ id: 'old', title: 'Archived work', archived: 1 })]);
      expect(readCopilotDesktop({ statePath, id: 'cloud', query })).toEqual([]);
      expect(readFileSync(statePath)).toEqual(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
