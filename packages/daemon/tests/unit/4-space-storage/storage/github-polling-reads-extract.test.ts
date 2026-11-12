import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { vi } from 'vitest';
import { Database } from '../../../../src/storage/sqlite-compat';
import { SESSION_EVENT_SCOPE } from '../../../../src/lib/external-events/session-external-event-store';
import {
  GitHubEventExtensionRepository,
  type GitHubWatchedRepo,
} from '../../../../src/lib/external-events/github/github-repository';
import { createWatchedTable, insertWatchedRow } from '../../helpers/github-watched-read-fixture';

type Readers = {
  countGitHubSpacesWithPollingIntent: (db: Database) => number;
  listGitHubPollingRepos: (db: Database, spaceId?: string) => GitHubWatchedRepo[];
  listGitHubPollingConfiguredRepos: (db: Database, spaceId?: string) => GitHubWatchedRepo[];
};
async function readers(): Promise<Readers> {
  const file = new URL(
    '../../../../src/storage/repositories/github-polling-repos-read.ts',
    import.meta.url
  );
  if (!existsSync(file)) throw new Error('Constructor-free GitHub polling reads are unavailable');
  return import(file.href);
}
describe('GitHub polling query extraction', () => {
  let db: Database, repo: GitHubEventExtensionRepository;
  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(
      "CREATE TABLE spaces(id TEXT PRIMARY KEY); INSERT INTO spaces VALUES('a-space'),('z-space')"
    );
    createWatchedTable(db);
    db.exec(
      'CREATE TABLE space_github_source_settings(space_id TEXT PRIMARY KEY,enabled INTEGER,polling_intent INTEGER,filter_current_user INTEGER,created_at INTEGER,updated_at INTEGER)'
    );
    repo = new GitHubEventExtensionRepository(db);
    for (const [id, space, enabled, polling, owner] of [
      ['active', 'a-space', 1, 1, 'Z'],
      ['disabled', 'a-space', 0, 1, 'A'],
      ['not-polling', 'a-space', 1, 0, 'B'],
      ['other', 'z-space', 1, 1, 'A'],
      ['orphan', 'orphan-space', 1, 1, 'A'],
      ['session', SESSION_EVENT_SCOPE, 1, 1, 'A'],
    ] as const)
      insertWatchedRow(db, { id, space_id: space, owner, enabled, polling_enabled: polling });
    db.exec(
      "INSERT INTO space_github_source_settings(space_id,enabled,polling_intent,created_at,updated_at) VALUES('a-space',0,1,1,1),('z-space',1,1,1,1),('orphan-space',1,1,1,1)"
    );
  });
  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
  });
  test('legacy decisions include disabled configured rows and exclude orphan intent', () => {
    expect(repo.countSpacesWithPollingIntent()).toBe(2);
    expect(repo.listAllPollingConfiguredRepos().map((r) => r.id)).toEqual([
      'disabled',
      'active',
      'other',
    ]);
    expect(repo.listPollingRepos().map((r) => r.id)).toEqual([
      'active',
      'orphan',
      'session',
      'other',
    ]);
    expect(repo.listPollingRepos(SESSION_EVENT_SCOPE).map((r) => r.id)).toEqual(['session']);
    expect(repo.listAllPollingConfiguredRepos(SESSION_EVENT_SCOPE)).toEqual([]);
  });
  test('extracted query bodies retain exact SQL ASTs within the fully counted boundary', () => {
    const dir = mkdtempSync(join(tmpdir(), 'polling-read-measure-'));
    try {
      const root = fileURLToPath(new URL('../../../../../../', import.meta.url));
      const output = join(dir, 'measure.json');
      execFileSync(
        process.execPath,
        ['.claude/skills/verify/lane-c-github-polling-read-measure.cjs', output],
        { cwd: root }
      );
      expect(JSON.parse(readFileSync(output, 'utf8'))).toMatchObject({
        fullOwnedGraphLines: 76,
        excludedLines: 0,
        netPrepare: 0,
        netRun: 0,
        completeHelper: { lines: 25 },
        completeMapper: { lines: 38 },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test('constructor-free helpers retain complete query-only rows and filter semantics', async () => {
    const r = await readers();
    const before = db.prepare('SELECT * FROM space_github_watched_repos ORDER BY id').all();
    const schema = db.prepare('SELECT name,sql FROM sqlite_master ORDER BY name').all();
    db.exec('PRAGMA query_only=ON');
    vi.spyOn(Date, 'now').mockImplementation(() => {
      throw new Error('Read must not initialize or read a clock');
    });
    expect(r.countGitHubSpacesWithPollingIntent(db)).toBe(2);
    for (const space of [undefined, '', 'a-space', 'z-space', SESSION_EVENT_SCOPE, 'missing']) {
      expect(r.listGitHubPollingRepos(db, space)).toEqual(repo.listPollingRepos(space));
      expect(r.listGitHubPollingConfiguredRepos(db, space)).toEqual(
        repo.listAllPollingConfiguredRepos(space)
      );
    }
    expect(db.prepare('SELECT * FROM space_github_watched_repos ORDER BY id').all()).toEqual(
      before
    );
    expect(db.prepare('SELECT name,sql FROM sqlite_master ORDER BY name').all()).toEqual(schema);
  });
  test('inactive configured malformed cursors still fail while unrelated scopes remain readable', async () => {
    const r = await readers();
    db.prepare('UPDATE space_github_watched_repos SET poll_cursor=? WHERE id=?').run(
      '{broken',
      'disabled'
    );
    expect(() => r.listGitHubPollingConfiguredRepos(db, 'a-space')).toThrow(SyntaxError);
    expect(() => repo.listAllPollingConfiguredRepos('a-space')).toThrow(SyntaxError);
    expect(r.listGitHubPollingRepos(db, 'a-space').map((row) => row.id)).toEqual(['active']);
    expect(r.listGitHubPollingConfiguredRepos(db, 'z-space').map((row) => row.id)).toEqual([
      'other',
    ]);
    expect(r.countGitHubSpacesWithPollingIntent(db)).toBe(2);
  });
  test('missing schema fails without creating tables or inventing defaults', async () => {
    const r = await readers(),
      empty = new Database(':memory:');
    try {
      empty.exec('PRAGMA query_only=ON');
      expect(r.countGitHubSpacesWithPollingIntent(empty)).toBe(0);
      expect(r.listGitHubPollingRepos(empty)).toEqual([]);
      expect(r.listGitHubPollingConfiguredRepos(empty)).toEqual([]);
      expect(empty.prepare('SELECT name FROM sqlite_master').all()).toEqual([]);
    } finally {
      empty.close();
    }
  });
});
