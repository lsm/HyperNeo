import { describe, expect, test } from 'bun:test';
import {
  CodingPrLedgerRepository,
  reconcileCodingPrLedger,
} from '../../../../src/lib/neo/packs/coding/pr-ledger.ts';
import {
  CodingPrEventRepository,
  deliverCodingPrEvents,
} from '../../../../src/lib/neo/packs/coding/pr-events.ts';
import {
  CodingTodoPrRepository,
  createCodingTodoPack,
} from '../../../../src/lib/neo/packs/coding/todo-prs.ts';
import { createCodingPackTables } from '../../../../src/lib/neo/packs/coding/schema/coding-tables.ts';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../../src/storage/repositories/neo-todo-session-repository.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { planNeoTodoDraft } from '../../../../src/lib/neo/todo-operations.ts';

const url = 'https://github.com/synthetic/mixedcase/pull/20';
const owner = { adapter: 'codex-desktop', id: 'synthetic-opener' };

function fixture() {
  const db = new Database(':memory:');
  runMigrations(db, () => {});
  createTables(db);
  createCodingPackTables(db, 0);
  const store = new NeoAskTodoRepository(db);
  store.openAsk({
    id: 'ask',
    projectId: null,
    sessionId: 'neo',
    originMessageId: null,
    title: 'Synthetic',
    request: 'Fix issue',
    createdAt: 1,
  });
  const add = (id: string, issue: string, state = 'doing', kind = 'issue_closed') => {
    const todo = store.addTodo(
      id,
      'ask',
      {
        title: id,
        doneWhen: 'Issue completed',
        check: {
          pack: 'coding',
          kind,
          params: kind === 'issue_closed' ? { issue } : { urls: [url] },
        },
        instruction: 'Fix issue',
        named: null,
      },
      1
    );
    db.prepare('UPDATE neo_todos SET state=?, started_at=1 WHERE id=?').run(state, id);
    const sessions = new NeoTodoSessionRepository(db);
    sessions.create(id, {
      verb: 'start',
      adapter: owner.adapter,
      place: { machine: 'synthetic', folder: '/synthetic' },
    });
    sessions.recordRef(id, owner, 1);
    return store.getTodo(todo.id)!;
  };
  const ledger = new CodingPrLedgerRepository(db);
  const claims = new CodingTodoPrRepository(db);
  const told: { ref: unknown; key: string; text: string }[] = [];
  const cycle = async (body: string, ci: string, at: number, additional: number[] = []) => {
    const transitions = await reconcileCodingPrLedger(
      ledger,
      ['synthetic/MixedCase'],
      async () => ({
        data: {
          rateLimit: { remaining: 4000 },
          repository: {
            nameWithOwner: 'synthetic/MixedCase',
            open: {
              pageInfo: { hasNextPage: false },
              nodes: [20, ...additional].map((number) => ({
                number,
                body: number === 20 ? body : '',
                title: 'Synthetic PR',
                headRefName: 'unmatched-branch',
                headRefOid: 'exact-head',
                state: 'OPEN',
                isDraft: false,
                mergeable: 'MERGEABLE',
                reviewDecision: 'APPROVED',
                reviews: {
                  nodes: [
                    {
                      state: 'APPROVED',
                      commit: { oid: 'exact-head' },
                      author: { login: 'synthetic-reviewer' },
                    },
                  ],
                },
                closedAt: null,
                commits: { nodes: [{ commit: { statusCheckRollup: { state: ci } } }] },
              })),
            },
            done: { nodes: [] },
          },
        },
      }),
      at
    );
    await deliverCodingPrEvents(new CodingPrEventRepository(db), transitions, {
      tell: async (ref, key, text) => {
        told.push({ ref, key, text });
        return true;
      },
      wake: async () => true,
    });
  };
  db.prepare(
    "INSERT INTO neo_pack_preferences(pack,scope_kind,scope_key,key,value_json,set_by,set_at) VALUES('coding','repo','synthetic/MixedCase','mergePolicy','\"review_bot\"','human',1)"
  ).run();
  db.prepare(
    "INSERT INTO neo_pack_preferences(pack,scope_kind,scope_key,key,value_json,set_by,set_at) VALUES('coding','repo','synthetic/MixedCase','reviewBot','\"synthetic-reviewer\"','human',1)"
  ).run();
  return { db, store, ledger, claims, told, add, cycle };
}

describe('issue todo PR owner delivery', () => {
  test('closing-issue discovery preserves reported PR owners and their duplicate refusal after settlement', async () => {
    const f = fixture();
    try {
      const other = 'https://github.com/synthetic/mixedcase/pull/21';
      const original = f.add('issue-todo', 'synthetic/MixedCase#7');
      const todo = f.store.updateTodo(original, { report: `PR opened: ${other}` }, 2);
      const todos = createCodingTodoPack(f.claims, async () => []);
      await todos.openedPrs!(todo, [url]);
      await f.cycle('Closes synthetic/MixedCase#7', 'PENDING', 100, [21]);
      expect(f.ledger.snapshot(null, 100).find((row) => row.pr.endsWith('#21'))?.ownerId).toBe(
        owner.id
      );
      const duplicate = planNeoTodoDraft(
        {
          check: { pack: 'coding', kind: 'pr_merged', params: { urls: [other] } },
          instruction: null,
          doneWhen: 'PR merged',
        },
        [{ id: 'coding', describe: 'Synthetic coding', todos }],
        [todo]
      );
      expect(duplicate).toEqual({
        reason: { ok: false, reason: expect.stringContaining('pr_already_tracked:') },
      });
      await f.cycle('Closes synthetic/MixedCase#7', 'SUCCESS', 200, [21]);
      f.store.updateTodo(todo, { state: 'done' }, 300);
      await f.cycle('Closes synthetic/MixedCase#7', 'SUCCESS', 400, [21]);
      expect(f.ledger.snapshot(null, 400).find((row) => row.pr.endsWith('#21'))?.ownerId).toBe(
        owner.id
      );
      expect(f.told.map((event) => event.key)).toEqual(
        [20, 21].map(
          (number) => `neo-pr-event:synthetic/mixedcase#${number}:exact-head:approved_green`
        )
      );
      expect(f.claims.todosFor([other])).toEqual([todo.id]);
    } finally {
      f.db.close();
    }
  });
  test.each(['issue_closed', 'pr_merged'])(
    'a duplicate of a %s todo gets a usable refusal remedy',
    async (kind) => {
      const f = fixture();
      try {
        const todo = f.add('original', 'synthetic/MixedCase#7', 'doing', kind);
        const todos = createCodingTodoPack(f.claims, async () => []);
        await todos.openedPrs!(todo, [url]);
        const result = planNeoTodoDraft(
          {
            check: { pack: 'coding', kind: 'pr_merged', params: { urls: [url] } },
            instruction: null,
            doneWhen: 'PR merged',
          },
          [{ id: 'coding', describe: 'Synthetic coding', todos }],
          [todo]
        );
        expect(result).toEqual({
          reason: { ok: false, reason: expect.stringContaining('pr_already_tracked:') },
        });
        if (!('reason' in result)) throw new Error('Duplicate todo was accepted');
        if (kind === 'issue_closed') {
          expect(result.reason.reason).not.toContain('addUrls');
          expect(result.reason.reason).toContain('Continue that todo');
          expect(todos.addUrls!(todo, [url])).toBeNull();
        } else {
          expect(result.reason.reason).toContain('neo.todo.edit addUrls');
          expect(todos.addUrls!(todo, [url])).not.toBeNull();
        }
        expect(f.store.listTodos('ask')).toHaveLength(1);
      } finally {
        f.db.close();
      }
    }
  );
  test.each([
    'Closes synthetic/MixedCase#7',
    'Fixes #7',
    'Resolves https://github.com/SYNTHETIC/MixedCase/issues/7',
  ])('%s links the issue todo and tells its worker once when CI turns green', async (body) => {
    const f = fixture();
    try {
      f.add('issue-todo', 'Synthetic/MixedCase#7');
      await f.cycle(body, 'PENDING', 100);
      expect(f.ledger.snapshot(null, 100)).toEqual([
        expect.objectContaining({
          pr: 'synthetic/mixedcase#20',
          state: 'approved_pending',
          ownerId: owner.id,
        }),
      ]);
      expect(f.claims.todosFor([url])).toEqual(['issue-todo']);
      await f.cycle(body, 'SUCCESS', 200);
      await f.cycle(body, 'SUCCESS', 300);
      expect(f.told).toEqual([
        expect.objectContaining({
          ref: owner,
          key: 'neo-pr-event:synthetic/mixedcase#20:exact-head:approved_green',
        }),
      ]);
      expect(f.store.getTodo('issue-todo')?.state).toBe('doing');
      expect(f.db.prepare('SELECT told_at FROM pack_coding_pr_ledger').get()).toEqual({
        told_at: expect.any(Number),
      });
    } finally {
      f.db.close();
    }
  });

  test('actual opening evidence survives an empty attached PR list and does not need a matching branch', async () => {
    const f = fixture();
    try {
      f.add('issue-todo', 'synthetic/MixedCase#7');
      f.ledger.observeSessions(
        [
          {
            ref: owner,
            status: 'running',
            remotes: ['git@github.com:synthetic/old-name.git'],
            branches: [],
            linkedPrs: [],
            openedPrs: [url],
            lastActivityAt: 1,
          },
        ],
        1
      );
      await f.cycle('', 'PENDING', 100);
      await f.cycle('', 'SUCCESS', 200);
      expect(f.told).toEqual([expect.objectContaining({ ref: owner })]);
      f.ledger.observeSessions(
        [
          {
            ref: owner,
            status: 'done',
            remotes: [],
            branches: [],
            linkedPrs: [],
            openedPrs: [],
            lastActivityAt: 2,
          },
        ],
        300
      );
      expect(f.ledger.snapshot(null, 300)[0].ownerId).toBe(owner.id);
    } finally {
      f.db.close();
    }
  });

  test('an issue todo records its worker opening even without a closing line', async () => {
    const f = fixture();
    try {
      const todo = f.add('issue-todo', 'synthetic/MixedCase#7');
      const pack = createCodingTodoPack(
        f.claims,
        async () => [],
        undefined,
        async () => []
      );
      await pack.openedPrs!(todo, [url]);
      await pack.readFacts!(todo);
      await f.cycle('', 'PENDING', 100);
      await f.cycle('', 'SUCCESS', 200);
      expect(f.claims.todosFor([url])).toEqual([todo.id]);
      expect(f.told).toEqual([expect.objectContaining({ ref: owner })]);
    } finally {
      f.db.close();
    }
  });

  test.each(['done', 'removed', 'failed'])(
    'a %s issue todo cannot claim an unrelated worker PR',
    async (state) => {
      const f = fixture();
      try {
        f.add('old', 'synthetic/MixedCase#7', state);
        f.add('wrong-repo', 'synthetic/elsewhere#7');
        await f.cycle('Closes synthetic/MixedCase#7', 'PENDING', 100);
        await f.cycle('Closes synthetic/MixedCase#7', 'SUCCESS', 200);
        expect(f.told).toEqual([]);
        expect(f.claims.todosFor([url])).toEqual([]);
      } finally {
        f.db.close();
      }
    }
  );

  test('mentioning the issue without closing it assigns no owner', async () => {
    const f = fixture();
    try {
      f.add('issue-todo', 'synthetic/MixedCase#7');
      await f.cycle('Related to synthetic/MixedCase#7', 'PENDING', 100);
      await f.cycle('Related to synthetic/MixedCase#7', 'SUCCESS', 200);
      expect(f.told).toEqual([]);
    } finally {
      f.db.close();
    }
  });

  test('existing pr_merged claims keep the same owner and delivery', async () => {
    const f = fixture();
    try {
      f.add('pr-todo', '', 'doing', 'pr_merged');
      f.claims.claim('pr-todo', [{ url, claim: 'named' }], 1);
      await f.cycle('', 'PENDING', 100);
      await f.cycle('', 'SUCCESS', 200);
      expect(f.told).toEqual([expect.objectContaining({ ref: owner })]);
    } finally {
      f.db.close();
    }
  });
});
