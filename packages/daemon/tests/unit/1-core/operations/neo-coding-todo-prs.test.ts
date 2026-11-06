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
  codingTodoStatusLine,
  createCodingTodoPack,
} from '../../../../src/lib/neo/packs/coding/todo-prs.ts';
import { codingPrUrl } from '../../../../src/lib/neo/packs/coding/pr-sweep.ts';
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
  test('a todo that replaces a removed one owns the PR they both name and closes on merge', async () => {
    const { db, pack, repo, todo } = setup(async () => [pr(9, 'MERGED')]);
    const check = { pack: 'coding', kind: 'pr_merged', params: { urls: [pr(9, 'OPEN').url] } };
    const removed = todo(check);
    new NeoAskTodoRepository(db).updateTodo(removed, { state: 'removed', reason: 'Replaced.' }, 2);
    expect(await pack.check(todo(check))).toEqual({ done: true, evidence: '#9 merged' });
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

describe('CodingTodoPrRepository.holder', () => {
  test('a PR url follows the configured GitHub host', () => {
    expect(codingPrUrl('github.example.test', { repo: 'lsm/hyperneo', number: 9 })).toBe(
      'https://github.example.test/lsm/hyperneo/pull/9'
    );
  });

  test('finds the open todo on this session that holds the PR, not one that merely shares it', () => {
    const { db, repo, todo, todos } = setup(async () => []);
    const worker = { adapter: 'codex-desktop', id: 'shared-thread' };
    const url = 'https://github.com/lsm/HyperNeo/pull/9553';
    const docs = todo(null);
    const holder = todo(null);
    for (const item of [docs, holder])
      db.prepare('INSERT INTO neo_todo_sessions (todo_id, target, ref) VALUES (?, ?, ?)').run(
        item.id,
        JSON.stringify({ verb: 'send', ref: worker }),
        JSON.stringify(worker)
      );
    repo.record(docs.id, [], 1);
    repo.record(holder.id, [pr(9553, 'OPEN', { url })], 1);
    expect(repo.holder('https://github.com/lsm/hyperneo/pull/9553', worker)).toBe(holder.id);
    expect(repo.holder(url, { ...worker, id: 'other-thread' })).toBeUndefined();
    repo.record(docs.id, [pr(9553, 'OPEN', { url })], 1);
    expect(repo.holder(url, worker)).toBeUndefined();
    repo.record(docs.id, [], 1);
    todos.updateTodo(holder, { state: 'done' }, 2);
    expect(repo.holder(url, worker)).toBeUndefined();
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
    ).toBe('pr_merged_invalid_urls: every URL must name a pull request.');
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
