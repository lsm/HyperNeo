import { describe, expect, test } from 'bun:test';
import type { NeoTodo } from '@hyperneo/shared/types/neo-ask';
import type { NeoWorkPr } from '@hyperneo/shared/types/neo-snapshot';
import type { ExternalEvent } from '../../../../src/lib/external-events/types.ts';
import {
  type CodingPrClaim,
  CodingTodoPrRepository,
  codingTodoCheck,
  codingTodoOwnPrs,
  codingTodoStatusLine,
  createCodingTodoPack,
  planCodingTodoClaims,
} from '../../../../src/lib/neo/packs/coding/todo-prs.ts';
import { readNeoProjectFacts } from '../../../../src/lib/neo/project-route-facts.ts';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';

const pr = (
  number: number,
  state: NeoWorkPr['state'],
  more: Partial<NeoWorkPr> = {}
): NeoWorkPr => ({
  url: `https://github.com/lsm/neo-ios/pull/${number}`,
  state,
  checks: 'passing',
  review: 'none',
  ...more,
});

function setup(read: (urls: readonly string[]) => Promise<NeoWorkPr[] | null>) {
  const db = new Database(':memory:');
  runMigrations(db, () => {});
  createTables(db);
  const todos = new NeoAskTodoRepository(db);
  todos.openAsk({
    id: 'ask',
    projectId: null,
    sessionId: 'neo',
    originMessageId: null,
    title: 'iOS card',
    request: 'Redo the iOS card',
    createdAt: 1,
  });
  const repo = new CodingTodoPrRepository(db);
  const pack = createCodingTodoPack(repo, read);
  pack.schema(db);
  pack.schema(db);
  const todo = (check: NeoTodo['check'], report: string | null = null) => {
    const added = todos.addTodo(
      crypto.randomUUID(),
      'ask',
      { title: 'Rows', doneWhen: 'Merged', check, instruction: 'Do it', named: null },
      1
    );
    return report ? todos.updateTodo(added, { report }, 2) : added;
  };
  return { db, repo, pack, todo };
}

describe('coding todo pack', () => {
  test('observed session PRs keep named and reported claims for the same todo', () => {
    const { db, pack, repo, todo } = setup(async () => []);
    const row = todo(
      { pack: 'coding', kind: 'pr_merged', params: { urls: [pr(1, 'OPEN').url] } },
      `Opened ${pr(2, 'OPEN').url}`
    );
    pack.openedPrs!(row, [pr(3, 'OPEN').url]);
    expect(repo.urls(row.id).sort()).toEqual([1, 2, 3].map((n) => pr(n, 'OPEN').url));
    pack.openedPrs!(row, []);
    expect(repo.urls(row.id).sort()).toEqual([1, 2, 3].map((n) => pr(n, 'OPEN').url));
    db.close();
  });
  test('claims PRs the check names and the report names, then checks their merge state', async () => {
    const reads: string[][] = [];
    const { pack, repo, todo } = setup(async (urls) => {
      reads.push([...urls]);
      return [pr(102, 'MERGED'), pr(103, 'OPEN', { checks: 'pending' })];
    });
    const row = todo(
      {
        pack: 'coding',
        kind: 'pr_merged',
        params: { urls: ['https://github.com/lsm/neo-ios/pull/102'] },
      },
      'Opened https://github.com/lsm/neo-ios/pull/103'
    );
    expect(await pack.check(row)).toEqual({ done: false, evidence: null });
    expect(reads).toEqual([
      ['https://github.com/lsm/neo-ios/pull/102', 'https://github.com/lsm/neo-ios/pull/103'],
    ]);
    expect(pack.statusLine(row)?.status).toBe('#102 merged; #103 open, waiting on CI');
    expect(pack.topics(row)).toEqual(['github/lsm/neo-ios/pull_request/103.*']);
    expect(
      pack.event({ topic: 'github/lsm/neo-ios/pull_request/103.closed' } as ExternalEvent)
    ).toEqual([row.id]);
    expect(pack.event({ topic: 'github/lsm/neo-ios/issues/103.closed' } as ExternalEvent)).toEqual(
      []
    );
    expect(repo.urls(row.id)).toHaveLength(2);
  });

  test('reads and records the PRs of a todo without a check, but gives no verdict', async () => {
    const { pack, repo, todo } = setup(async () => [pr(5, 'OPEN', { review: 'approved' })]);
    const row = todo(null, 'Opened https://github.com/lsm/neo-ios/pull/5');
    expect(await pack.check(row)).toBeNull();
    expect(repo.prs(row.id).map((item) => item.url)).toEqual([pr(5, 'OPEN').url]);
    const continued = { ...row, report: null };
    pack.openedPrs!(continued, []);
    expect(await pack.check(continued)).toBeNull();
    expect(repo.urls(row.id)).toEqual(['https://github.com/lsm/neo-ios/pull/5']);
  });

  test('never counts a PR the session merged before the todo started', async () => {
    const { pack, todo, db } = setup(async () => [pr(7381, 'MERGED', { mergedAt: 50 })]);
    const row = {
      ...todo({ pack: 'coding', kind: 'pr_merged', params: {} }),
      state: 'doing' as const,
      startedAt: 100,
    };
    pack.openedPrs!(row, [pr(7381, 'MERGED').url]);
    expect(await pack.check(row)).toEqual({ done: false, evidence: null });
    expect(pack.statusLine(row)).toBeNull();
    db.close();
  });

  test('a PR belongs only to the todo whose dispatch on that session it answers', async () => {
    const opened = [
      pr(7409, 'CLOSED', { createdAt: 50 }),
      pr(7426, 'OPEN', { createdAt: 250 }),
      pr(7427, 'MERGED', { createdAt: 120, mergedAt: 300 }),
      pr(7430, 'OPEN', { createdAt: 130 }),
    ];
    const { db, pack, todo } = setup(async (urls) =>
      opened.filter((item) => urls.includes(item.url))
    );
    const dispatch = (id: string, at: number, session: string) => {
      db.prepare('UPDATE neo_todos SET state = ?, started_at = ? WHERE id = ?').run(
        'doing',
        at,
        id
      );
      db.prepare('INSERT INTO neo_todo_sessions (todo_id, target, ref) VALUES (?, ?, ?)').run(
        id,
        '{}',
        JSON.stringify({ adapter: 'claude-desktop', id: session })
      );
    };
    const check = { pack: 'coding', kind: 'pr_opened', params: {} };
    const gpt = { ...todo(check), state: 'doing' as const, startedAt: 100 };
    const ids = { ...todo(check), state: 'doing' as const, startedAt: 200 };
    const elsewhere = todo(check);
    dispatch(gpt.id, 100, 'fullstack-1');
    dispatch(ids.id, 200, 'fullstack-1');
    dispatch(elsewhere.id, 150, 'fullstack-2');
    for (const row of [gpt, ids])
      pack.openedPrs!(
        row,
        opened.map((item) => item.url)
      );
    await pack.check(gpt);
    await pack.check(ids);
    expect(pack.statusLine(gpt)?.status).toBe('#7427 merged');
    expect(pack.statusLine(ids)?.status).toBe('#7426 open, waiting on review');

    const reported = { ...ids, report: `Done: ${opened[3].url}` };
    await pack.check(reported);
    await pack.check(gpt);
    expect(pack.statusLine(reported)?.status).toBe('#7430 open, waiting on review');
    expect(pack.statusLine(gpt)?.status).toBe('#7427 merged');
    db.close();
  });

  test('records the PRs a todo owns as route references for its ask project', async () => {
    const { db, pack, todo } = setup(async () => [pr(41, 'OPEN')]);
    const row = todo(
      { pack: 'coding', kind: 'pr_opened', params: {} },
      `Opened ${pr(41, 'OPEN').url}`
    );
    const owned = [{ reference: '#41', projectId: null }];
    expect(readNeoProjectFacts(db, 'about #41')).toEqual([
      { reference: '#41', projectId: undefined },
    ]);
    await pack.check(row);
    expect(readNeoProjectFacts(db, 'about #41')).toEqual(owned);
    db.prepare('DELETE FROM neo_todo_pr_refs').run();
    pack.schema(db);
    expect(readNeoProjectFacts(db, 'about #41')).toEqual(owned);
    db.close();
  });

  test('leaves todos of other packs and unreadable PRs to the core', async () => {
    const { pack, todo } = setup(async () => null);
    expect(await pack.check(todo(null))).toBeNull();
    expect(
      await pack.check(todo({ pack: 'life-admin', kind: 'confirmed', params: {} }))
    ).toBeNull();
    expect(
      await pack.check(todo({ pack: 'coding', kind: 'pr_merged', params: {} }, 'see #12'))
    ).toEqual({ done: false, evidence: null });
    expect(
      await pack.check(
        todo(
          { pack: 'coding', kind: 'pr_merged', params: {} },
          'https://github.com/lsm/neo-ios/pull/9'
        )
      )
    ).toBeNull();
  });
});

describe('coding todo claims', () => {
  test('canonical claims, re-derived reports, and no verdict from a partial read', async () => {
    let read: NeoWorkPr[] = [pr(102, 'MERGED')];
    const { pack, repo, todo } = setup(async () => read);
    const row = todo(
      {
        pack: 'coding',
        kind: 'pr_merged',
        params: { urls: ['http://GitHub.com/lsm/neo-ios/pull/102/files?x=1'] },
      },
      'Opened https://github.com/lsm/neo-ios/pull/103'
    );
    expect(await pack.check(row)).toBeNull();
    expect(repo.urls(row.id)).toEqual([
      'https://github.com/lsm/neo-ios/pull/102',
      'https://github.com/lsm/neo-ios/pull/103',
    ]);
    expect(
      pack.event({ topic: 'github/lsm/neo-ios/pull_request/102.closed' } as ExternalEvent)
    ).toEqual([row.id]);
    read = [pr(102, 'MERGED')];
    expect(await pack.check({ ...row, report: 'Superseded; only #102 now' })).toEqual({
      done: true,
      evidence: '#102 merged',
    });
    expect(repo.urls(row.id)).toEqual(['https://github.com/lsm/neo-ios/pull/102']);
  });
});

describe('codingTodoCheck', () => {
  test('pr_merged needs every PR merged and pr_opened any live PR', () => {
    expect(codingTodoCheck('pr_merged', [pr(1, 'MERGED'), pr(2, 'MERGED')])).toEqual({
      done: true,
      evidence: '#1 #2 merged',
    });
    expect(codingTodoCheck('pr_merged', [])).toEqual({ done: false, evidence: null });
    expect(codingTodoCheck('pr_opened', [pr(1, 'CLOSED'), pr(2, 'OPEN')])).toEqual({
      done: true,
      evidence: '#2 opened',
    });
    expect(codingTodoCheck('deployed', [])).toBeNull();
  });
});

describe('codingTodoStatusLine', () => {
  const doing = { state: 'doing' as const, report: null, evidence: null };

  test('a merged PR', () => {
    expect(codingTodoStatusLine(doing, [pr(7426, 'MERGED')])).toEqual({
      status: '#7426 merged',
      statusCodes: [{ code: 'todo.pr.merged', params: { pr: '#7426' } }],
    });
  });

  test('each open and closed PR state has its own code', () => {
    expect(
      codingTodoStatusLine(doing, [pr(1, 'OPEN', { review: 'approved' })])?.statusCodes[0]?.code
    ).toBe('todo.pr.approved');
    expect(
      codingTodoStatusLine(doing, [pr(2, 'OPEN', { checks: 'failing' })])?.statusCodes[0]?.code
    ).toBe('todo.pr.ciFailing');
    expect(
      codingTodoStatusLine(doing, [pr(3, 'OPEN', { review: 'changes_requested' })])?.statusCodes[0]
        ?.code
    ).toBe('todo.pr.changesRequested');
    expect(codingTodoStatusLine(doing, [pr(4, 'OPEN')])?.statusCodes[0]?.code).toBe(
      'todo.pr.waitingReview'
    );
    expect(
      codingTodoStatusLine(doing, [pr(5, 'OPEN', { checks: 'pending' })])?.statusCodes[0]?.code
    ).toBe('todo.pr.waitingCi');
    expect(codingTodoStatusLine(doing, [pr(6, 'CLOSED')])?.statusCodes[0]?.code).toBe(
      'todo.pr.closed'
    );
  });

  test('several PRs give one code each and one English line', () => {
    expect(
      codingTodoStatusLine(doing, [
        pr(1, 'OPEN', { review: 'approved' }),
        pr(2, 'OPEN', { checks: 'failing' }),
        pr(3, 'OPEN', { review: 'changes_requested' }),
        pr(4, 'OPEN'),
        pr(5, 'CLOSED'),
      ])?.status
    ).toBe(
      '#1 approved, waiting to merge; #2 CI failing; #3 needs changes; #4 open, waiting on review; #5 closed'
    );
  });

  test('no PR yet, or a session that claims done without one', () => {
    expect(codingTodoStatusLine(doing, [])).toBeNull();
    expect(codingTodoStatusLine({ state: 'done', report: 'Done', evidence: null }, [])).toEqual({
      status: 'Session says it is done; no PR found',
      statusCodes: [{ code: 'todo.reportedNoPr', params: {} }],
    });
  });
});

describe('codingTodoOwnPrs', () => {
  const row = (todoId: string, number: number, claim: CodingPrClaim, claimedAt = 1) => ({
    todoId,
    url: pr(number, 'OPEN').url,
    claim,
    claimedAt,
  });
  test('the report names the PRs, else the first PR opened in the dispatch window', () => {
    const prs = [
      pr(1, 'MERGED', { mergedAt: 50 }),
      pr(2, 'MERGED', { mergedAt: 50 }),
      pr(3, 'MERGED', { mergedAt: 150 }),
      pr(4, 'OPEN', { createdAt: 120 }),
      pr(5, 'OPEN', { createdAt: 110 }),
      pr(6, 'OPEN', { createdAt: 90 }),
    ];
    const todo = { id: 'a', startedAt: 100 };
    const window = { start: 100, end: 200 };
    expect(
      codingTodoOwnPrs(
        todo,
        [row('a', 1, 'named'), row('a', 2, 'reported'), row('a', 3, 'reported')],
        prs,
        window
      ).map((item) => item.url)
    ).toEqual([prs[0].url, prs[2].url]);
    expect(
      codingTodoOwnPrs(
        todo,
        [row('a', 4, 'branch'), row('a', 5, 'branch'), row('a', 6, 'branch')],
        prs,
        window
      ).map((item) => item.url)
    ).toEqual([prs[4].url]);
    expect(codingTodoOwnPrs(todo, [row('a', 4, 'branch')], prs, { start: 100, end: 115 })).toEqual(
      []
    );
  });

  test('never counts one PR for two todos', () => {
    const prs = [pr(4, 'OPEN', { createdAt: 120 })];
    const window = { start: 100, end: null };
    const own = (claims: ReturnType<typeof row>[], id: string) =>
      codingTodoOwnPrs({ id, startedAt: 100 }, claims, prs, window).length;
    expect(own([row('a', 4, 'branch'), row('b', 4, 'reported')], 'a')).toBe(0);
    expect(own([row('a', 4, 'reported', 2), row('b', 4, 'reported', 1)], 'a')).toBe(0);
    expect(own([row('a', 4, 'reported', 2), row('b', 4, 'reported', 1)], 'b')).toBe(1);
    expect(own([row('a', 4, 'reported'), row('b', 4, 'named')], 'a')).toBe(0);
    expect(own([row('a', 4, 'branch'), row('b', 4, 'branch')], 'a')).toBe(1);
  });
});

describe('planCodingTodoClaims', () => {
  test('claims branch PRs only when they were opened after the todo started', () => {
    expect(
      planCodingTodoClaims({ check: null, startedAt: 100 }, null, [
        pr(1, 'OPEN', { createdAt: 50 }),
        pr(2, 'OPEN', { createdAt: 150 }),
      ])
    ).toEqual([{ url: 'https://github.com/lsm/neo-ios/pull/2', claim: 'branch' }]);
    expect(
      planCodingTodoClaims({ check: null, startedAt: null }, null, [
        pr(2, 'OPEN', { createdAt: 1 }),
      ])
    ).toEqual([]);
  });
});
