import { afterEach, describe, expect, test } from 'bun:test';
import { createCodingPackTables } from '../../../../src/lib/neo/packs/coding/schema/coding-tables.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { DbGateway } from '../../../../src/storage/db-gateway/db-gateway.ts';
import {
  neoAskSettlementWrites,
  neoAskSettlementReads,
  requireNeoAskTurnedSettle,
} from '../../../../src/storage/repositories/neo-ask-settlement.ts';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { CodingTodoPrRepository } from '../../../../src/lib/neo/packs/coding/todo-prs.ts';
import { createCodingPack } from '../../../../src/lib/neo/packs/coding/pack.ts';
import { CodingPrLedgerRepository } from '../../../../src/lib/neo/packs/coding/pr-ledger.ts';
import { CodingPrSweepRepository } from '../../../../src/lib/neo/packs/coding/pr-sweep.ts';
import { CodingPrEventRepository } from '../../../../src/lib/neo/packs/coding/pr-events.ts';
import {
  summarizeNeoWorkPr,
  readGithubPrs,
} from '../../../../src/lib/neo/packs/coding/work-prs.ts';

const opened: { db: Database; gateway: DbGateway }[] = [];
afterEach(async () => {
  for (const { db, gateway } of opened.splice(0)) {
    await gateway.close();
    db.close();
  }
});
function setup(paths = ['docs/design/widget.md']) {
  const db = new Database(':memory:');
  runMigrations(db, () => {});
  createTables(db);
  createCodingPackTables(db);
  const gateway = new DbGateway(':memory:', db);
  opened.push({ db, gateway });
  const store = new NeoAskTodoRepository(db);
  const prs = new CodingTodoPrRepository(db);
  store.openAsk({
    id: 'ask',
    title: 'Ship widget',
    request: 'Build it',
    projectId: null,
    sessionId: 'neo',
    originMessageId: null,
    createdAt: 1,
  });
  const add = (id: string) =>
    store.addTodo(
      id,
      'ask',
      {
        title: id,
        doneWhen: 'PR merged',
        check: { pack: 'coding', kind: 'pr_merged', params: {} },
        instruction: 'Implement the step',
        named: null,
      },
      2
    );
  const design = add('design');
  store.updateTodo(design, { state: 'done', finishedAt: 3 }, 3);
  const pr = {
    url: 'https://github.com/example/widget/pull/1',
    state: 'MERGED' as const,
    checks: 'passing' as const,
    review: 'approved' as const,
    head: 'abc',
    files: paths,
  };
  prs.record(design.id, [pr], 3);
  const wakes: string[] = [];
  const pack = createCodingPack({
    database: () => db,
    todoPrs: prs,
    readPrs: async () => [pr],
    projectRepos: () => [],
    prLedger: new CodingPrLedgerRepository(db),
    prSweep: new CodingPrSweepRepository(db),
    prEvents: new CodingPrEventRepository(db),
    prSweepDeps: {
      tell: async () => true,
      wake: async (_key, text) => {
        wakes.push(text);
        return true;
      },
    },
  });
  const settle = () =>
    gateway.call(
      neoAskSettlementWrites,
      'settle',
      { askId: 'ask', status: 'done', outcome: 'Shipped' },
      4
    );
  return { db, store, add, pack, wakes, settle };
}

describe('Merged design follow-up', () => {
  test('cannot complete an ask with only a merged design', async () => {
    const { settle, store } = setup();
    expect(await settle()).toMatchObject({
      ok: false,
      reason: expect.stringContaining('design_followup_required'),
    });
    expect(store.getAsk('ask')?.status).toBe('open');
  });
  test('the coding sweep asks Neo to create Change-section PR todos', async () => {
    const { pack, wakes } = setup();
    await pack.sweep!(10);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toContain('docs/design/widget.md');
    expect(wakes[0]).toContain('Change');
    expect(wakes[0]).toContain('ask');
  });
  test('an unstarted follow-up releases the design hold and stops the wake', async () => {
    const { add, pack, wakes, settle, store } = setup();
    const next = add('implementation');
    await pack.sweep!(10);
    expect(wakes).toEqual([]);
    store.updateTodo(next, { state: 'done', finishedAt: 11 }, 11);
    expect(await settle()).toMatchObject({ ok: true });
  });
  test('automatic settlement refuses the same design gap', async () => {
    const { db } = setup();
    const gateway = opened.find((item) => item.db === db)!.gateway;
    const snapshot = await gateway.call(neoAskSettlementReads, 'snapshot', 'ask');
    if ('ok' in snapshot) throw new Error(snapshot.reason);
    expect(requireNeoAskTurnedSettle({ ...snapshot, children: [], questions: [] })).toMatchObject({
      reason: { ok: false, reason: expect.stringContaining('design_followup_required') },
    });
  });
  test('a removed follow-up leaves the design gap open', async () => {
    const { add, store, settle } = setup();
    const next = add('implementation');
    store.updateTodo(next, { state: 'removed', reason: 'Replan' }, 4);
    expect(await settle()).toMatchObject({
      ok: false,
      reason: expect.stringContaining('design_followup_required'),
    });
  });
  test('old merged summaries are refreshed before allowing completion', async () => {
    const { db, pack, settle } = setup();
    const saved = JSON.parse(
      (db.prepare('SELECT prs_json FROM pack_coding_todo_prs').get() as { prs_json: string })
        .prs_json
    );
    delete saved[0].files;
    db.prepare('UPDATE pack_coding_todo_prs SET prs_json=?').run(JSON.stringify(saved));
    expect(await settle()).toMatchObject({
      ok: false,
      reason: expect.stringContaining('design_scope_unknown'),
    });
    await pack.sweep!(10);
    expect(await settle()).toMatchObject({
      ok: false,
      reason: expect.stringContaining('design_followup_required'),
    });
  });
  test('ordinary documentation does not create a design hold', async () => {
    const { settle, pack, wakes } = setup(['docs/usage.md']);
    await pack.sweep!(10);
    expect(wakes).toEqual([]);
    expect(await settle()).toMatchObject({ ok: true });
  });
  test('PR summaries retain changed paths for completed todo checks', () => {
    expect(
      summarizeNeoWorkPr({
        url: 'https://github.com/example/widget/pull/1',
        state: 'MERGED',
        headRefOid: 'abc',
        reviews: [],
        statusCheckRollup: [],
        files: [{ path: 'docs/design/widget.md' }],
      })
    ).toMatchObject({ files: ['docs/design/widget.md'] });
  });
});

describe('Merged PR file coverage', () => {
  test.each([false, true])(
    'reads paths beyond the first page, rejects a mismatched head (%s)',
    async (mismatch) => {
      const first = Array.from({ length: 100 }, (_, i) => ({ path: `src/file-${i}.ts` }));
      const paths = [...first, { path: 'docs/design/followup.md' }];
      const spawn = (args: string[]) => {
        const body =
          args[1] === 'pr'
            ? {
                url: 'https://github.com/example/widget/pull/1',
                state: 'MERGED',
                headRefOid: 'abc',
                reviews: [],
                files: first,
                changedFiles: 101,
              }
            : [first, paths.slice(100)].map((nodes, i) => ({
                data: {
                  repository: {
                    pullRequest: {
                      headRefOid: mismatch && i === 1 ? 'changed' : 'abc',
                      files: {
                        nodes,
                        pageInfo: { hasNextPage: i === 0, endCursor: i === 0 ? 'next' : null },
                      },
                    },
                  },
                },
              }));
        return {
          stdout: new Response(JSON.stringify(body)).body,
          stderr: new Response('').body,
          exited: Promise.resolve(0),
          exitCode: 0,
          kill: () => {},
        };
      };
      const read = await readGithubPrs(
        ['https://github.com/example/widget/pull/1'],
        spawn as never
      );
      if (mismatch) expect(read).toBeNull();
      else expect(read?.[0].files).toEqual(paths.map((file) => file.path));
    }
  );
});
