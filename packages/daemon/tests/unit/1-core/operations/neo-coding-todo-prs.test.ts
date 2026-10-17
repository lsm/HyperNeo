import { describe, expect, test } from 'bun:test';
import type { NeoTodo } from '@hyperneo/shared/types/neo-ask';
import type { NeoWorkPr } from '@hyperneo/shared/types/neo-snapshot';
import {
  CodingTodoPrRepository,
  codingTodoCheck,
  codingTodoStatusLine,
  createCodingTodoPack,
  planCodingTodoClaims,
} from '../../../../src/lib/neo/packs/coding/todo-prs.ts';
import type { ExternalEvent } from '../../../../src/lib/external-events/types.ts';
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
    expect(pack.statusLine(row)).toBe('#102 已合并，#103 开着，等 CI');
    expect(pack.topics(row)).toEqual([
      'github/lsm/neo-ios/pull_request/102.*',
      'github/lsm/neo-ios/pull_request/103.*',
    ]);
    expect(
      pack.event({ topic: 'github/lsm/neo-ios/pull_request/103.closed' } as ExternalEvent)
    ).toEqual([row.id]);
    expect(pack.event({ topic: 'github/lsm/neo-ios/issues/103.closed' } as ExternalEvent)).toEqual(
      []
    );
    expect(repo.urls(row.id)).toHaveLength(2);
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

describe('codingTodoCheck', () => {
  test('pr_merged needs every PR merged and pr_opened any live PR', () => {
    expect(codingTodoCheck('pr_merged', [pr(1, 'MERGED'), pr(2, 'MERGED')])).toEqual({
      done: true,
      evidence: '#1 #2 已合并',
    });
    expect(codingTodoCheck('pr_merged', [])).toEqual({ done: false, evidence: null });
    expect(codingTodoCheck('pr_opened', [pr(1, 'CLOSED'), pr(2, 'OPEN')])).toEqual({
      done: true,
      evidence: '#2 已开出',
    });
    expect(codingTodoCheck('deployed', [])).toBeNull();
  });
});

describe('codingTodoStatusLine', () => {
  test('says one line per PR, or that the session claims done without a PR', () => {
    const doing = { state: 'doing' as const, report: null, evidence: null };
    expect(
      codingTodoStatusLine(doing, [
        pr(1, 'OPEN', { review: 'approved' }),
        pr(2, 'OPEN', { checks: 'failing' }),
        pr(3, 'OPEN', { review: 'changes_requested' }),
        pr(4, 'OPEN'),
        pr(5, 'CLOSED'),
      ])
    ).toBe('#1 已批准，等合并，#2 CI 没过，#3 要改，#4 开着，等 review，#5 已关闭');
    expect(codingTodoStatusLine(doing, [])).toBeNull();
    expect(codingTodoStatusLine({ state: 'done', report: 'Done', evidence: null }, [])).toBe(
      '会话说做完了，没查到 PR'
    );
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
