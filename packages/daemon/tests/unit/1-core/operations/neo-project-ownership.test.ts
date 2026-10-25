import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mirrorNeoWorkspaceProjectsAsync } from '../../../../src/lib/neo/project-mirror-async';
import { mergePlaceGroups } from '../../../../src/lib/drivers/places';
import type { PlaceGroup } from '../../../../src/lib/drivers/types';
import { recordStartedWork } from '../../../../src/storage/work-started-sessions';
import { NeoRepository } from '../../../../src/storage/repositories/neo-repository';
import { createTestDb } from '../../../helpers/database';

let db: Awaited<ReturnType<typeof createTestDb>>;
let repo: NeoRepository;
const place = (folder: string) => ({
  machine: 'synthetic-machine',
  folder,
  name: folder,
  codeIdentity: `git:${folder}`,
  remotes: [`https://example.test/team/${folder.slice(1)}.git`],
});
const group = (id: string, folder: string): PlaceGroup => ({
  place: place(folder),
  lastActivityAt: 1,
  openCount: 1,
  archivedCount: 0,
  adapters: ['codex-desktop'],
  work: [
    {
      ref: { adapter: 'codex-desktop', id },
      title: id,
      place: place(folder),
      status: 'done',
      lastActivityAt: 1,
    },
  ],
});
const aliases = () =>
  db.getDatabase().prepare('SELECT alias FROM neo_project_workspaces ORDER BY alias').all() as {
    alias: string;
  }[];

beforeEach(async () => {
  db = await createTestDb();
  repo = new NeoRepository(db.getDatabase());
});
afterEach(() => db.close());

describe('automatic project ownership', () => {
  test.each(['own', 'all'] as const)(
    'new instance imports no foreign project or alias with %s feed',
    async (workFeedScope) => {
      db.updateGlobalSettings({ workFeedScope });
      const toolOnly = { ...group('unused', '/tool-only'), work: [] };
      await mirrorNeoWorkspaceProjectsAsync(db, [group('foreign', '/foreign'), toolOnly]);
      expect(repo.listProjects()).toEqual([]);
      expect(aliases()).toEqual([]);
    }
  );

  test('only owned work contributes aliases from a mixed discovery group', async () => {
    recordStartedWork(db.getDatabase(), { adapter: 'codex-desktop', id: 'owned' });
    const foreign = group('foreign', '/foreign');
    const owned = group('owned', '/owned');
    foreign.place.codeIdentity = owned.place.codeIdentity;
    foreign.work[0].place = foreign.place;
    await mirrorNeoWorkspaceProjectsAsync(db, mergePlaceGroups([foreign, owned], 50));
    expect(repo.listProjects()).toHaveLength(1);
    expect(
      aliases().some(({ alias }) => alias.includes('/foreign') || alias.includes('\u0000foreign'))
    ).toBe(false);
    expect(aliases().some(({ alias }) => alias.includes('/owned'))).toBe(true);
  });

  test('native sessions in this instance are owned without an external start record', async () => {
    db.getDatabase().exec(`INSERT INTO sessions (id,title,created_at,last_active_at,status,config,metadata,type)
      VALUES ('native','Synthetic','2026-01-01','2026-01-01','active','{}','{}','worker')`);
    const native = group('native', '/native');
    native.work[0].ref.adapter = 'hyperneo';
    await mirrorNeoWorkspaceProjectsAsync(db, [native]);
    expect(repo.listProjects()).toHaveLength(1);
  });

  test('foreign work adds no aliases to an existing explicit project', async () => {
    repo.saveProject({ id: 'explicit', title: 'Explicit', summary: '', context: 'Keep' }, 0);
    db.getDatabase()
      .prepare('INSERT INTO neo_project_workspaces VALUES (?, ?)')
      .run('git:/foreign', 'explicit');
    await mirrorNeoWorkspaceProjectsAsync(db, [group('foreign', '/foreign')]);
    expect(repo.listProjects()).toMatchObject([{ id: 'explicit', context: 'Keep' }]);
    expect(aliases()).toEqual([{ alias: 'git:/foreign' }]);
  });

  test('remote work cannot claim a colliding local owned id', async () => {
    recordStartedWork(db.getDatabase(), { adapter: 'codex-desktop', id: 'owned' });
    const remote = group('owned', '/remote');
    remote.work[0].ref.daemon = 'other';
    await mirrorNeoWorkspaceProjectsAsync(db, [remote]);
    expect(repo.listProjects()).toEqual([]);
  });
});
