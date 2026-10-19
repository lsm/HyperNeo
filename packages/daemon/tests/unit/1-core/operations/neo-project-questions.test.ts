import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import type { NeoProject } from '@hyperneo/shared/types/neo-context';
import { neoReorganizeRuntime } from '../../../../src/lib/neo/operations.ts';
import type { NeoService } from '../../../../src/lib/neo/service.ts';
import { NeoRepository } from '../../../../src/storage/repositories/neo-repository.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';

const identity = `git:${'a'.repeat(40)}`;
const repository = 'repo:lsm/web';
const project = (id: string, extra: Partial<NeoProject> = {}): NeoProject => ({
  id,
  title: id,
  summary: id,
  context: '',
  revision: 1,
  parentId: null,
  epicUrl: null,
  createdAt: 1,
  updatedAt: 1,
  ...extra,
});

describe('reorganize identities on a real store', () => {
  let directory: string;
  let db: Database;
  let repo: NeoRepository;
  let logged: string[];
  const notified: number[] = [];
  const root = 'neo:10000000-0000-4000-8000-000000000001';
  const inbox = 'neo:10000000-0000-4000-8000-000000000002';

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'neo-project-questions-'));
    db = new Database(join(directory, 'fictional.db'));
    createTables(db);
    runMigrations(db, () => {});
    repo = new NeoRepository(db);
    logged = [];
    repo.reserveBinding({ sessionId: root, kind: 'neo', projectId: null });
    repo.saveProject({ id: 'inbox', title: 'Inbox', summary: 'Inbox', context: '' }, 0);
    for (const id of ['web', 'web-shallow'])
      repo.saveProject({ id, title: id, summary: id, context: id }, 0);
    db.prepare('INSERT INTO neo_project_workspaces VALUES (?, ?)').run(identity, 'web');
    for (const [alias, id] of [
      [`${repository}\u0000laptop`, 'web'],
      [`${repository}\u0000desktop`, 'web-shallow'],
    ])
      db.prepare('INSERT INTO neo_project_workspaces VALUES (?, ?)').run(alias, id);
  });
  afterEach(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const runtime = () =>
    neoReorganizeRuntime({
      repo,
      db: { getDatabase: () => db },
      notifyChanged: () => notified.push(1),
      defaultSessionId: () => inbox,
      logReorganize: (line: string) => logged.push(line),
    } as unknown as NeoService);
  test('keeps every title, even a generated one, and records local identity', async () => {
    const uuid = '50028a5f-f9ce-4692-a1ab-63f786f65b1f';
    const save = (id: string, title: string, summary = `Project: ${title}`) =>
      repo.saveProject({ id, title, summary, context: '' }, 0);
    save('gone', uuid);
    db.prepare('INSERT INTO neo_project_workspaces VALUES (?, ?)').run(
      `folder:elsewhere\u0000/w/bg-test-repo-2448f54b/worktrees/${uuid}`,
      'gone'
    );
    save('kept', 'e6e0cc8b-1aba-47ce-9453-838b17d96dda', 'Human notes');
    db.prepare('INSERT INTO neo_project_workspaces VALUES (?, ?)').run(
      'folder:elsewhere\u0000/w/readable/e6e0cc8b-1aba-47ce-9453-838b17d96dda',
      'kept'
    );
    const checkout = join(directory, 'neo-ios');
    const tree = join(directory, 'ee72a104-5c52-4e27-b08d-dcbfc49a1d7f');
    mkdirSync(checkout);
    const git = (cwd: string, ...args: string[]) =>
      execFileSync('git', ['-C', cwd, ...args], {
        env: {
          ...process.env,
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_AUTHOR_NAME: 't',
          GIT_AUTHOR_EMAIL: 't@example.com',
          GIT_COMMITTER_NAME: 't',
          GIT_COMMITTER_EMAIL: 't@example.com',
        },
      })
        .toString()
        .trim();
    git(checkout, 'init');
    git(checkout, 'commit', '--allow-empty', '-m', 'first');
    git(checkout, 'worktree', 'add', '-b', 'topic', tree);
    save('local', 'ee72a104-5c52-4e27-b08d-dcbfc49a1d7f');
    db.prepare('INSERT INTO neo_project_workspaces VALUES (?, ?)').run(
      `folder:${hostname()}\u0000${tree}`,
      'local'
    );
    await runtime().recordIdentities();
    expect(repo.getProject('gone')?.title).toBe(uuid);
    expect(repo.getProject('kept')?.title).toBe('e6e0cc8b-1aba-47ce-9453-838b17d96dda');
    expect(repo.getProject('local')?.title).toBe('ee72a104-5c52-4e27-b08d-dcbfc49a1d7f');
    expect(
      db
        .prepare('SELECT project_id FROM neo_project_workspaces WHERE alias = ?')
        .get(`git:${git(checkout, 'rev-parse', 'HEAD')}`)
    ).toEqual({ project_id: 'local' });
  });

  test('siblings sharing a repository stay separate projects', async () => {
    await runtime().recordIdentities();
    expect(
      repo
        .listProjects()
        .map((item) => item.id)
        .sort()
    ).toEqual(['inbox', 'web', 'web-shallow']);
    expect(repo.projectMerges.redirects()).toEqual([]);
  });
});
