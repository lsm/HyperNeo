import { describe, expect, test } from 'bun:test';
import type { NeoTodo } from '@hyperneo/shared/types/neo-ask';
import type { NeoWorkPr } from '@hyperneo/shared/types/neo-snapshot';
import { codexTurnState } from '../../../../src/lib/drivers/codex-desktop-adapter.ts';
import {
  type CodingPrClaim,
  CodingTodoPrRepository,
  codingTodoCheck,
  codingTodoCheckRefusal,
  codingTodoDoneWhen,
  codingTodoOwnPrs,
  codingTodoStatusLine,
  createCodingTodoPack,
  planCodingTodoClaims,
} from '../../../../src/lib/neo/packs/coding/todo-prs.ts';
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
  return { db, repo, pack, todo, todos };
}

describe('coding todo pack', () => {
  test('observed session PRs keep named and reported claims for the same todo', async () => {
    const { db, pack, repo, todo } = setup(async () => []);
    const row = todo(
      { pack: 'coding', kind: 'pr_merged', params: { urls: [pr(1, 'OPEN').url] } },
      `Opened ${pr(2, 'OPEN').url}`
    );
    await pack.openedPrs!(row, [pr(3, 'OPEN').url]);
    expect(repo.urls(row.id).sort()).toEqual([1, 2, 3].map((n) => pr(n, 'OPEN').url));
    await pack.openedPrs!(row, []);
    expect(repo.urls(row.id).sort()).toEqual([1, 2, 3].map((n) => pr(n, 'OPEN').url));
    db.close();
  });
  test('a todo that replaces a removed one owns the PR they both name and closes on merge', async () => {
    const { db, pack, repo, todo } = setup(async () => [pr(9, 'MERGED')]);
    const check = { pack: 'coding', kind: 'pr_merged', params: { urls: [pr(9, 'OPEN').url] } };
    const removed = todo(check);
    repo.claim(removed.id, [{ url: pr(9, 'OPEN').url, claim: 'named' }], 1);
    new NeoAskTodoRepository(db).updateTodo(removed, { state: 'removed', reason: 'Replaced.' }, 2);
    expect(await pack.check(todo(check))).toEqual({ done: true, evidence: '#9 merged' });
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
    expect(repo.urls(row.id)).toHaveLength(2);
  });

  test('a turn that names its PR only before its last message still claims it, done once merged', async () => {
    const said = (text: string) =>
      JSON.stringify({
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] },
      });
    const report = codexTurnState([
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } }),
      said(`Opened ${pr(104, 'OPEN').url}; waiting on CI.`),
      said('CI is green and the review approved it.'),
      JSON.stringify({
        type: 'event_msg',
        payload: { type: 'task_complete', last_agent_message: 'Merged. All done.' },
      }),
    ]).reply;
    let state: NeoWorkPr['state'] = 'OPEN';
    const { pack, todo } = setup(async () => [pr(104, state)]);
    const row = todo({ pack: 'coding', kind: 'pr_merged', params: {} }, report);
    expect(await pack.check(row)).toEqual({ done: false, evidence: null });
    state = 'MERGED';
    expect(await pack.check(row)).toEqual({ done: true, evidence: '#104 merged' });
  });

  test('reads and records the PRs of a todo without a check, but gives no verdict', async () => {
    const { pack, repo, todo } = setup(async () => [pr(5, 'OPEN', { review: 'approved' })]);
    const row = todo(null, 'Opened https://github.com/lsm/neo-ios/pull/5');
    expect(await pack.check(row)).toBeNull();
    expect(repo.prs(row.id).map((item) => item.url)).toEqual([pr(5, 'OPEN').url]);
    const continued = { ...row, report: null };
    await pack.openedPrs!(continued, []);
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
    await pack.openedPrs!(row, [pr(7381, 'MERGED').url]);
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
    const check = { pack: 'coding', kind: 'pr_merged', params: {} };
    const gpt = { ...todo(check), state: 'doing' as const, startedAt: 100 };
    const ids = { ...todo(check), state: 'doing' as const, startedAt: 200 };
    const elsewhere = todo(check);
    dispatch(gpt.id, 100, 'fullstack-1');
    dispatch(ids.id, 200, 'fullstack-1');
    dispatch(elsewhere.id, 150, 'fullstack-2');
    for (const row of [gpt, ids])
      await pack.openedPrs!(
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

  test('leaves todos of other packs to the core and holds a coding todo whose PRs are unread', async () => {
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
    ).toEqual({ done: false, evidence: null });
  });
});

describe('coding todo claims', () => {
  test('canonical claims, re-derived reports, and not done from a partial read', async () => {
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
    expect(await pack.check(row)).toEqual({ done: false, evidence: null });
    expect(repo.urls(row.id)).toEqual([
      'https://github.com/lsm/neo-ios/pull/102',
      'https://github.com/lsm/neo-ios/pull/103',
    ]);
    read = [pr(102, 'MERGED')];
    expect(await pack.check({ ...row, report: 'Superseded; only #102 now' })).toEqual({
      done: true,
      evidence: '#102 merged',
    });
    expect(repo.urls(row.id)).toEqual(['https://github.com/lsm/neo-ios/pull/102']);
  });
});

describe('codingTodoCheck', () => {
  test('pr_merged needs every PR merged, and pr_opened is gone', () => {
    expect(codingTodoCheck('pr_merged', [pr(1, 'MERGED'), pr(2, 'MERGED')])).toEqual({
      done: true,
      evidence: '#1 #2 merged',
    });
    expect(codingTodoCheck('pr_merged', [pr(1, 'MERGED'), pr(2, 'OPEN')])).toEqual({
      done: false,
      evidence: null,
    });
    expect(codingTodoCheck('pr_merged', [])).toEqual({ done: false, evidence: null });
    expect(codingTodoCheck('pr_opened', [pr(1, 'OPEN')])).toBeNull();
    expect(codingTodoCheck('deployed', [])).toBeNull();
  });

  test("a newer PR takes a closed one's place, and an unreplaced closed PR fails the todo", () => {
    const closed = pr(2, 'CLOSED', { createdAt: 20 });
    expect(
      codingTodoCheck('pr_merged', [
        pr(1, 'MERGED', { createdAt: 10 }),
        closed,
        pr(3, 'MERGED', { createdAt: 30 }),
      ])
    ).toEqual({ done: true, evidence: '#1 #3 merged' });
    expect(
      codingTodoCheck('pr_merged', [
        pr(1, 'MERGED', { createdAt: 10 }),
        closed,
        pr(3, 'OPEN', { createdAt: 30 }),
      ])
    ).toEqual({ done: false, evidence: null });
    const failed = {
      done: false,
      evidence: null,
      failed: '#2 closed without merging and no pull request replaced it',
    };
    expect(codingTodoCheck('pr_merged', [pr(1, 'MERGED', { createdAt: 30 }), closed])).toEqual({
      done: true,
      evidence: '#1 merged',
    });
    expect(codingTodoCheck('pr_merged', [pr(1, 'MERGED', { createdAt: 10 }), closed])).toEqual(
      failed
    );
    expect(
      codingTodoCheck('pr_merged', [
        closed,
        pr(4, 'CLOSED', { createdAt: 25 }),
        pr(5, 'MERGED', { createdAt: 40 }),
      ])
    ).toEqual({ ...failed, failed: '#4 closed without merging and no pull request replaced it' });
  });
});

describe('codingTodoCheck replacement grace', () => {
  test('matches replacements by creation time, not claim order', () => {
    expect(
      codingTodoCheck('pr_merged', [
        pr(50, 'CLOSED', { createdAt: 10 }),
        pr(60, 'CLOSED', { createdAt: 20 }),
        pr(70, 'MERGED', { createdAt: 30 }),
        pr(55, 'MERGED', { createdAt: 15 }),
      ])
    ).toEqual({ done: true, evidence: '#70 #55 merged' });
  });

  test('a PR closed unmerged fails the todo only after 15 minutes without a replacement', () => {
    const closedAt = 1_000_000;
    const prs = [pr(1, 'MERGED', { createdAt: 10 }), pr(2, 'CLOSED', { createdAt: 20, closedAt })];
    expect(codingTodoCheck('pr_merged', prs, closedAt + 14 * 60_000)).toEqual({
      done: false,
      evidence: null,
    });
    expect(codingTodoCheck('pr_merged', prs, closedAt + 15 * 60_000)).toEqual({
      done: false,
      evidence: null,
      failed: '#2 closed without merging and no pull request replaced it',
    });
    expect(
      codingTodoCheck(
        'pr_merged',
        [...prs, pr(3, 'MERGED', { createdAt: closedAt + 60_000 })],
        closedAt + 60 * 60_000
      )
    ).toEqual({ done: true, evidence: '#1 #3 merged' });
  });
});

describe('codingTodoStatusLine', () => {
  const doing = { state: 'doing' as const, report: null, evidence: null };

  test('policy states show human or CI waits without claiming approval', () => {
    expect(codingTodoStatusLine(doing, [pr(19, 'OPEN')], () => 'waiting_human')?.status).toBe(
      '#19 waiting on the human'
    );
    expect(codingTodoStatusLine(doing, [pr(19, 'OPEN')], () => 'waiting_ci')?.status).toBe(
      '#19 open, waiting on CI'
    );
  });

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

describe('coding todo pack waiting', async () => {
  test('a todo with an open PR of its own is waiting on that PR, not idle', async () => {
    const { db, pack, repo, todo } = setup(async () => []);
    const row = todo({ pack: 'coding', kind: 'pr_merged', params: {} });
    expect(await pack.waiting!(row)).toBe(false);
    repo.record(row.id, [pr(1, 'OPEN')], 2);
    expect(await pack.waiting!(row)).toBe(true);
    repo.record(row.id, [pr(1, 'MERGED')], 3);
    expect(await pack.waiting!(row)).toBe(false);
    db.close();
  });
  test('a todo whose reported PRs merged still waits on a later PR its branch opened, even when a retry claims it too', async () => {
    let later: NeoWorkPr['state'] = 'OPEN';
    const { db, pack, todo, todos } = setup(async () => [
      pr(1, 'MERGED', { createdAt: 10, mergedAt: 20 }),
      pr(2, 'MERGED', { createdAt: 30, mergedAt: 40 }),
      pr(3, later, { createdAt: 50 }),
    ]);
    const started = todos.updateTodo(todo(null), { startedAt: 5 }, 3);
    const row = todos.updateTodo(
      started,
      { report: `Merged ${pr(1, 'MERGED').url} and ${pr(2, 'MERGED').url}.` },
      4
    );
    await pack.openedPrs!(row, [pr(3, 'OPEN').url]);
    await pack.openedPrs!(todo(null), [pr(3, 'OPEN').url]);
    await pack.check(row);
    expect(await pack.waiting!(row)).toBe(true);
    expect(pack.statusLine(row)?.status).toContain('#3 open');
    later = 'MERGED';
    await pack.check(row);
    expect(await pack.waiting!(row)).toBe(false);
    db.close();
  });
});

describe('codingTodoStatusLine from the ledger', () => {
  const doing = { state: 'doing' as const, report: null, evidence: null };

  test('reads each PR state from the ledger when it has the PR, and falls back otherwise', () => {
    const ledger = (url: string) =>
      url.endsWith('/7426')
        ? ('approved_green' as const)
        : url.endsWith('/7427')
          ? ('dirty' as const)
          : null;
    expect(
      codingTodoStatusLine(doing, [pr(7426, 'OPEN'), pr(7427, 'OPEN'), pr(7428, 'MERGED')], ledger)
    ).toEqual({
      status: '#7426 approved and green; #7427 in conflict with its base; #7428 merged',
      statusCodes: [
        { code: 'todo.pr.approvedGreen', params: { pr: '#7426' } },
        { code: 'todo.pr.dirty', params: { pr: '#7427' } },
        { code: 'todo.pr.merged', params: { pr: '#7428' } },
      ],
    });
  });

  test('a PR in a repo with no reviewer yet says so', () => {
    expect(codingTodoStatusLine(doing, [pr(1, 'OPEN')], () => 'unreviewed')).toEqual({
      status: '#1 open, no reviewer yet',
      statusCodes: [{ code: 'todo.pr.noReviewer', params: { pr: '#1' } }],
    });
  });
});

describe('coding pr_merged check wording and rules', () => {
  const merged = (params: Record<string, unknown>) => ({
    pack: 'coding',
    kind: 'pr_merged',
    params,
  });

  test('done-when names the pull requests, or the one the todo opens', () => {
    expect(
      codingTodoDoneWhen(
        merged({
          urls: [
            'https://github.com/lsm/HyperNeo/pull/7709',
            'https://github.com/lsm/qlark/pull/4',
          ],
        })
      )
    ).toBe('lsm/HyperNeo#7709, lsm/qlark#4 merged');
    expect(codingTodoDoneWhen(merged({}))).toBe(
      "The one pull request this todo's session opens is merged"
    );
    expect(codingTodoDoneWhen({ pack: 'coding', kind: 'issue_filed', params: {} })).toBeNull();
  });

  test('a check without urls needs an instruction, since only its own session can claim one', () => {
    expect(codingTodoCheckRefusal({ check: merged({}), instruction: 'Fix it' })).toBeNull();
    expect(codingTodoCheckRefusal({ check: merged({}), instruction: null })).toBe(
      'pr_merged_needs_urls: a todo with no instruction opens no pull request; name each one in params.urls.'
    );
    expect(
      codingTodoCheckRefusal({
        check: merged({ urls: ['https://github.com/lsm/HyperNeo/pull/1'] }),
        instruction: null,
      })
    ).toBeNull();
    expect(
      codingTodoCheckRefusal({ check: merged({ urls: ['lsm/HyperNeo#7709'] }), instruction: null })
    ).toBe(
      'pr_merged_needs_urls: a todo with no instruction opens no pull request; name each one in params.urls.'
    );
  });
});

test('merged PR completion ignores failing CI, requested changes and ledger human wait', async () => {
  const merged = pr(42, 'MERGED', { checks: 'failing', review: 'changes_requested' });
  const { db, repo, todo } = setup(async () => [merged]);
  try {
    const pack = createCodingTodoPack(
      repo,
      async () => [merged],
      () => 'waiting_human'
    );
    const row = todo({ pack: 'coding', kind: 'pr_merged', params: { urls: [merged.url] } });
    const facts = await pack.readFacts(row);
    expect(pack.judge(row, facts)).toEqual({ state: 'done', evidence: '#42 merged' });
    expect(await pack.check(row)).toEqual({ done: true, evidence: '#42 merged' });
    expect(pack.statusLine(row)?.status).toContain('waiting on the human');
  } finally {
    db.close();
  }
});
