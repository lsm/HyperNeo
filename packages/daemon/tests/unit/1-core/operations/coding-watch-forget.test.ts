import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import type { MessageHub } from '@hyperneo/shared';
import { createNeoService } from '../../../../src/lib/neo/packs/runtime.ts';
import { createNeoOperations } from '../../../../src/lib/neo/operations.ts';
import { InternalEventBus } from '../../../../src/lib/internal-event-bus.ts';
import { createOperationRegistry } from '../../../../src/lib/operations/registry.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import type { SessionManager } from '../../../../src/lib/session/session-manager.ts';
import {
  CodingPrLedgerRepository,
  reconcileCodingPrLedger,
} from '../../../../src/lib/neo/packs/coding/pr-ledger.ts';
import { createTestDb } from '../../../helpers/database.ts';

let db: Awaited<ReturnType<typeof createTestDb>>;
let service: ReturnType<typeof createNeoService>;
const global = { kind: 'global', key: '' };
const human = { source: 'rpc', principal: 'local' } as const;
const call = (name: string, input: unknown) =>
  invokeOperation(createOperationRegistry(createNeoOperations(service)), name, input, human);
const setWatches = async (value: string[]) =>
  expect(
    await call('pack.preferences.set', {
      pack: 'coding',
      scope: global,
      key: 'watchedRepos',
      value,
    })
  ).toMatchObject({ value: { ok: true } });
const readWatches = () =>
  call('pack.preferences.get', { pack: 'coding', scope: global, key: 'watchedRepos' });
beforeEach(async () => {
  db = await createTestDb();
  service = createNeoService(
    db,
    {} as SessionManager,
    { event: mock(() => {}) } as unknown as MessageHub,
    new InternalEventBus()
  );
  for (const [id, repo] of [
    ['forgotten', 'chosen/repo'],
    ['retained', 'kept/repo'],
  ]) {
    service.repo.saveProject({ id, title: id, summary: '', context: '' }, 0);
    db.getDatabase()
      .prepare('INSERT INTO neo_project_workspaces VALUES (?, ?)')
      .run(`repository:github.com/${repo}`, id);
  }
  await setWatches(['chosen/repo', 'kept/repo']);
});
afterEach(async () => {
  await service.dispose();
  db.close();
});

test('forgetting a project stops its polling without deleting retained history or other watches', async () => {
  const ledger = new CodingPrLedgerRepository(db.getDatabase()),
    now = Date.now();
  ledger.replace(
    'chosen/repo',
    [
      {
        repo: 'chosen/repo',
        number: 1,
        title: 'Stored history',
        branch: 'work',
        head: 'one',
        state: 'unreviewed',
        closedAt: null,
      },
    ],
    now
  );
  expect(await call('neo.project.forget', { projectId: 'forgotten' })).toMatchObject({
    value: { ok: true, repos: ['chosen/repo'] },
  });
  expect(await readWatches()).toMatchObject({ value: { preference: { value: ['kept/repo'] } } });
  const requests: string[] = [];
  await reconcileCodingPrLedger(
    ledger,
    ['chosen/repo', 'kept/repo'],
    async (repo) => {
      requests.push(repo);
      return null;
    },
    now
  );
  expect(requests).toEqual(['kept/repo']);
  expect(ledger.snapshot(null, now)).toEqual([]);
  expect(db.getDatabase().prepare('SELECT repo FROM pack_coding_pr_ledger').all()).toEqual([
    { repo: 'chosen/repo' },
  ]);
});

test('a refused forget leaves repository watches untouched', async () => {
  service.todos.openAsk({
    id: 'open',
    sessionId: 'synthetic-root',
    projectId: 'forgotten',
    originMessageId: null,
    title: 'Open',
    request: 'Synthetic',
    createdAt: 1,
  });
  expect(await call('neo.project.forget', { projectId: 'forgotten' })).toMatchObject({
    value: { ok: false, reason: 'project_in_use' },
  });
  expect(await readWatches()).toMatchObject({
    value: { preference: { value: ['chosen/repo', 'kept/repo'] } },
  });
});

test('a repository still referenced by another project remains watched', async () => {
  db.getDatabase()
    .prepare('INSERT INTO neo_project_workspaces VALUES (?, ?)')
    .run('repo:chosen/repo\u0000', 'retained');
  expect(await call('neo.project.forget', { projectId: 'forgotten' })).toMatchObject({
    value: { ok: true },
  });
  expect(await readWatches()).toMatchObject({
    value: { preference: { value: ['chosen/repo', 'kept/repo'] } },
  });
});

test('forgetting a renamed repository removes its canonical watch', async () => {
  new CodingPrLedgerRepository(db.getDatabase()).recordAlias('chosen/repo', 'chosen/renamed');
  await setWatches(['chosen/renamed', 'kept/repo']);
  await call('neo.project.forget', { projectId: 'forgotten' });
  expect(await readWatches()).toMatchObject({ value: { preference: { value: ['kept/repo'] } } });
});

test('disabled packs also forget their watches', async () => {
  db.updateGlobalSettings({ neo: { packs: [] } });
  await call('neo.project.forget', { projectId: 'forgotten' });
  expect(await readWatches()).toMatchObject({ value: { preference: { value: ['kept/repo'] } } });
});

test('a failed unwatch rolls back the project removal and its aliases', async () => {
  db.getDatabase().exec(
    "CREATE TRIGGER reject_unwatch BEFORE UPDATE ON neo_pack_preferences WHEN NEW.key = 'watchedRepos' BEGIN SELECT RAISE(ABORT, 'synthetic_unwatch_failure'); END"
  );
  expect(await call('neo.project.forget', { projectId: 'forgotten' })).toMatchObject({
    kind: 'failed',
  });
  expect(service.repo.getProject('forgotten')).not.toBeNull();
  expect(service.repo.allRepositories()).toEqual(['chosen/repo', 'kept/repo']);
  expect(await readWatches()).toMatchObject({
    value: { preference: { value: ['chosen/repo', 'kept/repo'] } },
  });
});
