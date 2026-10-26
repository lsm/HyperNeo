import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { NeoTodo } from '@hyperneo/shared/types/neo-ask';
import type { NeoTodoPack } from '../../../../src/lib/neo/pack-contract.ts';
import * as coding from '../../../../src/lib/neo/packs/coding/todo-prs.ts';
import { createCodingPackTables } from '../../../../src/lib/neo/packs/coding/schema/coding-tables.ts';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';

type Policy = Required<Pick<NeoTodoPack, 'doneWhen' | 'addUrls' | 'refuse'>>;
const url = (number: number) => `https://github.com/example/repo/pull/${number}`;
const factories = [
  {
    name: 'runtime pack',
    create: (repo: coding.CodingTodoPrRepository) =>
      coding.createCodingTodoPack(repo, async () => []) as Policy,
  },
  {
    name: 'writer policy',
    create: (repo: coding.CodingTodoPrRepository) => coding.createCodingTodoPolicy(repo),
  },
];

for (const factory of factories)
  describe(`${factory.name} admission`, () => {
    let db: Database;
    let todos: NeoAskTodoRepository;
    let prs: coding.CodingTodoPrRepository;
    let policy: Policy;
    beforeEach(() => {
      db = new Database(':memory:');
      runMigrations(db, () => {});
      createTables(db);
      createCodingPackTables(db);
      todos = new NeoAskTodoRepository(db);
      todos.openAsk({
        id: 'ask',
        projectId: null,
        sessionId: 'neo',
        originMessageId: null,
        title: 'Synthetic policy',
        request: 'Keep PR ownership',
        createdAt: 1,
      });
      prs = new coding.CodingTodoPrRepository(db);
      policy = factory.create(prs);
    });
    afterEach(() => db.close());
    const todo = (id: string, urls: string[] = []) =>
      todos.addTodo(
        id,
        'ask',
        {
          title: `Title ${id}`,
          doneWhen: 'Merged',
          check: { pack: 'coding', kind: 'pr_merged', params: { urls } },
          instruction: 'Complete synthetic work',
          named: null,
        },
        1
      );

    test('URL edits normalize and deduplicate while retaining existing requirements', () => {
      const current = todo('target', [url(1)]);
      current.check!.params.keep = 'unchanged';
      const check = policy.addUrls(current, [
        url(2),
        'https://github.com/EXAMPLE/REPO/pull/2?diff=split#discussion-1',
      ]);
      expect(check).toEqual({
        pack: 'coding',
        kind: 'pr_merged',
        params: { urls: [url(1), url(2)], keep: 'unchanged' },
      });
      expect(current.check?.params.urls).toEqual([url(1)]);
      expect(policy.doneWhen(check!)).toBe('example/repo#1, example/repo#2 merged');
    });

    test('invalid added URLs remain visible to the admission refusal', () => {
      const current = todo('target', [url(1)]);
      const check = policy.addUrls(current, ['https://example.invalid/not-a-pr']);
      expect(policy.refuse({ ...current, check })).toBe(
        'pr_merged_invalid_urls: every URL must name a pull request.'
      );
    });

    test('URL-less work needs an instruction and issue checks keep exact labels', () => {
      const current = todo('target');
      expect(policy.refuse({ ...current, instruction: null })).toBe(
        'pr_merged_needs_urls: a todo with no instruction opens no pull request; name each one in params.urls.'
      );
      expect(policy.refuse(current)).toBeNull();
      const issue = {
        ...current,
        check: { pack: 'coding', kind: 'issue_closed', params: { issue: 'example/repo#9' } },
      };
      expect(policy.refuse(issue)).toBeNull();
      expect(policy.doneWhen(issue.check)).toBe('example/repo#9 completed');
      expect(policy.addUrls(issue, [url(2)])).toBeNull();
      expect(
        policy.refuse({ ...issue, check: { ...issue.check, params: { issue: 'not-an-issue' } } })
      ).toBe('issue_closed_invalid_issue: params.issue must be owner/repo#N.');
    });

    test.each(['todo', 'doing', 'blocked'] as const)('a %s peer keeps its named PR', (state) => {
      const peer = todos.updateTodo(todo('owner', [url(2)]), { state }, 2);
      const target = todo('target', [url(1)]);
      const check = policy.addUrls(target, [url(2)]);
      expect(policy.refuse({ ...target, check }, [peer, target])).toBe(
        `pr_already_tracked: ${url(2)} is already tracked by todo owner "Title owner". Use neo.todo.edit addUrls on that todo.`
      );
    });

    test('a newly committed recorded claim is checked on every admission', () => {
      const peer = todo('owner');
      const target = todo('target', [url(2)]);
      expect(policy.refuse(target, [peer, target])).toBeNull();
      prs.claim(peer.id, [{ url: url(2), claim: 'branch' }], 2);
      expect(policy.refuse(target, [peer, target])).toContain('already tracked by todo owner');
    });

    test.each(['done', 'closed_unverified', 'failed', 'removed'] as const)(
      'a %s peer releases named and recorded ownership',
      (state) => {
        const peer = todo('owner', [url(2)]);
        prs.claim(peer.id, [{ url: url(2), claim: 'branch' }], 2);
        const settled = todos.updateTodo(peer, { state }, 3);
        expect(settled.state).toBe(state);
        expect(policy.refuse(todo('target', [url(2)]), [settled])).toBeNull();
      }
    );

    test('editing the current owner never conflicts with its own recorded claim', () => {
      const current = todo('owner', [url(2)]);
      prs.claim(current.id, [{ url: url(2), claim: 'named' }], 2);
      expect(policy.refuse(current, [current])).toBeNull();
    });

    test('an issue-tracking owner points duplicate PR edits back to the original todo', () => {
      const current = todo('owner');
      const peer: NeoTodo = {
        ...current,
        check: { pack: 'coding', kind: 'issue_closed', params: { issue: 'example/repo#9' } },
      };
      prs.claim(peer.id, [{ url: url(2), claim: 'branch' }], 2);
      expect(policy.refuse(todo('target', [url(2)]), [peer])).toBe(
        `pr_already_tracked: ${url(2)} is already tracked by todo owner "Title owner". Continue that todo instead.`
      );
    });
  });
