import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Session } from '@hyperneo/shared';
import type { NeoBinding, NeoProject } from '@hyperneo/shared/types/neo-context';
import {
  mergeNeoDuplicateProjects,
  planNeoProjectMerges,
  readNeoProjectIdentities,
} from '../../../../src/lib/neo/project-merge.ts';
import type { Database } from '../../../../src/storage/database.ts';
import { JobQueueRepository } from '../../../../src/storage/repositories/job-queue-repository.ts';
import { NeoRepository } from '../../../../src/storage/repositories/neo-repository.ts';
import { SDKMessageRepository } from '../../../../src/storage/repositories/sdk-message-repository.ts';
import { SessionRepository } from '../../../../src/storage/repositories/session-repository.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database as Sqlite } from '../../../../src/storage/sqlite-compat.ts';

const identity = `git:${'a'.repeat(40)}`;
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

describe('planNeoProjectMerges', () => {
  test('merges newer siblings with the same code identity into the oldest', () => {
    expect(
      planNeoProjectMerges(
        {
          projects: [
            project('web-copy', { createdAt: 5, revision: 3 }),
            project('web', { createdAt: 2 }),
            project('web-nested', { createdAt: 6, parentId: 'travel' }),
            project('notes', { createdAt: 1 }),
          ],
          identities: { web: [identity] },
          unavailable: [],
          retired: [],
        },
        { 'web-copy': [identity], 'web-nested': [identity] }
      )
    ).toEqual([
      {
        sourceId: 'web-copy',
        targetId: 'web',
        sourceRevision: 3,
        targetRevision: 1,
        sourceIdentities: [identity],
        targetIdentities: [],
      },
    ]);
  });

  test('never plans a merge without identity, for a section, the inbox or a retired project', () => {
    expect(
      planNeoProjectMerges(
        {
          projects: [
            project('a'),
            project('b'),
            project('inbox'),
            project('section', { epicUrl: 'https://github.com/o/r/issues/1' }),
            project('old'),
          ],
          identities: { inbox: [identity], section: [identity], old: [identity] },
          unavailable: [],
          retired: ['old'],
        },
        { a: [identity], c: [identity] }
      )
    ).toEqual([]);
  });
});

describe('readNeoProjectIdentities', () => {
  test("collects each project's code identities from its folders and skips unreadable ones", async () => {
    const other = `git:${'b'.repeat(40)}`;
    const read = async (folder: string) =>
      folder === '/w/a'
        ? { codeIdentity: identity }
        : folder === '/w/b'
          ? { codeIdentity: other }
          : {};
    expect(
      await readNeoProjectIdentities(
        [
          { projectId: 'web', folder: '/w/a' },
          { projectId: 'web', folder: '/w/b' },
          { projectId: 'web', folder: '/w/a' },
          { projectId: 'notes', folder: '/w/plain' },
        ],
        read
      )
    ).toEqual({ web: [identity, other] });
  });
});

describe('a merged project in a real store', () => {
  const conversationId = '10000000-0000-4000-8000-000000000001';
  const root: NeoBinding = { sessionId: `neo:${conversationId}`, kind: 'neo', projectId: null };
  let directory: string;
  let writer: Sqlite;
  let db: Database;
  let repo: NeoRepository;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'neo-project-merge-wire-'));
    writer = new Sqlite(join(directory, 'fictional.db'));
    createTables(writer);
    runMigrations(writer, () => {});
    const sessions = new SessionRepository(writer);
    const sdk = new SDKMessageRepository(writer as never);
    const jobs = new JobQueueRepository(writer);
    repo = new NeoRepository(writer);
    for (const id of ['web', 'web-copy'])
      repo.saveProject({ id, title: id, summary: id, context: id }, 0);
    writer.prepare('INSERT INTO neo_project_workspaces VALUES (?, ?)').run(identity, 'web');
    writer
      .prepare('INSERT INTO neo_project_workspaces VALUES (?, ?)')
      .run('folder:laptop\u0000/w/web-copy', 'web-copy');
    for (const binding of [root]) {
      repo.reserveBinding(binding);
      sessions.createSession({
        id: binding.sessionId,
        title: 'Fictional',
        createdAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
        status: 'active',
        config: {},
        metadata: {},
      } as Session);
    }
    db = {
      getDatabase: () => writer,
      getSDKMessageRepo: () => sdk,
      getJobQueueRepo: () => jobs,
      getSession: (id: string) => sessions.getSession(id),
    } as unknown as Database;
  });
  afterEach(() => {
    writer.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const mergeCopyIntoWeb = () =>
    repo.projectMerges.merge({
      sourceId: 'web-copy',
      targetId: 'web',
      sourceRevision: 1,
      targetRevision: 1,
      sourceIdentities: [identity],
      targetIdentities: [],
    });

  test('merges every duplicate in one run', () => {
    repo.saveProject({ id: 'web-third', title: 'web-third', summary: '', context: '' }, 0);
    const fresh = { 'web-copy': [identity], 'web-third': [identity] };
    const logged: string[] = [];
    expect(
      mergeNeoDuplicateProjects(
        () => repo.projectMerges.plan(fresh),
        (input) => repo.projectMerges.merge(input),
        (line) => logged.push(line)
      )
    ).toEqual([
      { sourceId: 'web-copy', targetId: 'web' },
      { sourceId: 'web-third', targetId: 'web' },
    ]);
    expect(logged).toEqual([]);
    expect(repo.listProjects().map((item) => item.id)).toEqual(['web']);
  });

  test('the merged project leaves the project list but its old links still resolve', () => {
    expect(repo.projectMerges.localFolders('laptop')).toEqual([
      { projectId: 'web-copy', folder: '/w/web-copy' },
    ]);
    expect(repo.projectMerges.plan({ 'web-copy': [identity] })).toMatchObject([
      { sourceId: 'web-copy', targetId: 'web' },
    ]);
    expect(mergeCopyIntoWeb()).toMatchObject({ ok: true });
    expect(repo.listProjects().map((item) => item.id)).toEqual(['web']);
    expect(repo.getProject('web-copy')?.id).toBe('web-copy');
    expect(repo.projectMerges.redirects()).toEqual([{ sourceId: 'web-copy', targetId: 'web' }]);
  });
});
