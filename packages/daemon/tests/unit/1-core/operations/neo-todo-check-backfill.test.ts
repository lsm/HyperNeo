import { expect, test } from 'bun:test';
import { planNeoTodoCheckBackfill } from '../../../../../../scripts/backfill-neo-todo-checks.ts';
import type { NeoTodo } from '@hyperneo/shared/types/neo-ask';

function todo(id: string, title: string, report: string | null = null, repo: string | null = null) {
  return { id, askId: 'ask', title, report, repo, check: null, state: 'todo' as NeoTodo['state'] };
}

test('derives all named PRs from title and report without changing the input', () => {
  const rows = [
    todo(
      'pr',
      'Land https://github.com/Example/Repo/pull/12',
      'Also https://github.com/example/repo/pull/13 and https://github.com/example/repo/pull/12#discussion-1'
    ),
  ];
  const before = structuredClone(rows);
  expect(planNeoTodoCheckBackfill(rows)).toEqual({
    edits: [
      {
        todoId: 'pr',
        check: {
          pack: 'coding',
          kind: 'pr_merged',
          params: {
            urls: [
              'https://github.com/example/repo/pull/12',
              'https://github.com/example/repo/pull/13',
            ],
          },
        },
      },
    ],
    unresolved: [],
  });
  expect(rows).toEqual(before);
});

test('uses explicit issue URLs and labelled shorthand with a known repository', () => {
  expect(
    planNeoTodoCheckBackfill([
      todo('url', 'Resolve https://github.com/example/repo/issues/9'),
      todo('named', 'Issue example/repo#10'),
      todo('bare', 'Land PR #11', null, 'github.com/example/repo'),
    ]).edits
  ).toEqual([
    {
      todoId: 'url',
      check: { pack: 'coding', kind: 'issue_closed', params: { issue: 'example/repo#9' } },
    },
    {
      todoId: 'named',
      check: { pack: 'coding', kind: 'issue_closed', params: { issue: 'example/repo#10' } },
    },
    {
      todoId: 'bare',
      check: {
        pack: 'coding',
        kind: 'pr_merged',
        params: { urls: ['https://github.com/example/repo/pull/11'] },
      },
    },
  ]);
});

test('lists ambiguous or non-coding outcomes instead of guessing or dropping references', () => {
  const rows = [
    todo('decision', 'Choose a dentist'),
    todo('bare', 'Fix #11', null, 'github.com/example/repo'),
    todo('unknown', 'PR #12'),
    todo('partial', 'PR #12 and #13', null, 'github.com/example/repo'),
    todo(
      'mixed',
      'https://github.com/example/repo/pull/1',
      'https://github.com/example/repo/issues/2'
    ),
    todo(
      'issues',
      'https://github.com/example/repo/issues/2 https://github.com/example/repo/issues/3'
    ),
  ];
  const plan = planNeoTodoCheckBackfill(rows);
  expect(plan.edits).toEqual([]);
  expect(plan.unresolved.map((row) => row.todoId)).toEqual(rows.map((row) => row.id));
});

test('leaves checked and settled rows alone and plans unfinished rows', () => {
  const named = todo('open', 'PR example/repo#1');
  const checked = {
    ...named,
    id: 'checked',
    check: { pack: 'core', kind: 'human_confirmed', params: { questionId: 'q' } },
  };
  const plan = planNeoTodoCheckBackfill([
    checked,
    ...(['done', 'closed_unverified', 'removed'] as const).map((state) => ({
      ...named,
      id: state,
      state,
    })),
    ...(['doing', 'blocked', 'failed'] as const).map((state) => ({ ...named, id: state, state })),
  ]);
  expect(plan.unresolved).toEqual([]);
  expect(plan.edits.map((edit) => edit.todoId)).toEqual(['doing', 'blocked', 'failed']);
  expect(
    planNeoTodoCheckBackfill(
      plan.edits.map((edit) => ({ ...named, id: edit.todoId, check: edit.check }))
    )
  ).toEqual({ edits: [], unresolved: [] });
});

test('uses supplied ref kinds and the sole named repo for unlabelled shorthand', () => {
  const kinds = {
    'example/repo#101': 'pr' as const,
    'example/repo#102': 'pr' as const,
    'example/repo#103': 'pr' as const,
    'example/repo#104': 'issue' as const,
  };
  const plan = planNeoTodoCheckBackfill(
    [
      todo('named', 'Finish example/repo#101'),
      todo('many', 'Finish example/repo#101', 'Remaining references: #102 and #103'),
      todo('issue', 'Resolve #104', null, 'github.com/example/repo'),
      todo('unknown', 'Finish example/repo#105'),
      todo('prose', 'Merged #106', null, 'github.com/example/repo'),
    ],
    kinds
  );
  expect(plan.edits).toEqual([
    {
      todoId: 'named',
      check: {
        pack: 'coding',
        kind: 'pr_merged',
        params: { urls: ['https://github.com/example/repo/pull/101'] },
      },
    },
    {
      todoId: 'many',
      check: {
        pack: 'coding',
        kind: 'pr_merged',
        params: {
          urls: [
            'https://github.com/example/repo/pull/101',
            'https://github.com/example/repo/pull/102',
            'https://github.com/example/repo/pull/103',
          ],
        },
      },
    },
    {
      todoId: 'issue',
      check: { pack: 'coding', kind: 'issue_closed', params: { issue: 'example/repo#104' } },
    },
  ]);
  expect(plan.unresolved.map((row) => row.todoId)).toEqual(['unknown', 'prose']);
});

test('missing ref kinds or multiple possible repos never produce a partial check', () => {
  const rows = [
    todo('partial', 'Finish example/repo#101 and #102'),
    todo('repos', 'example/one#1 and example/two#2', 'Then #3'),
    todo('invalid', 'example/repo#103'),
  ];
  const kinds = {
    'example/repo#101': 'pr',
    'example/one#1': 'pr',
    'example/two#2': 'pr',
    'example/repo#103': 'unknown',
  } as never;
  const plan = planNeoTodoCheckBackfill(rows, kinds);
  expect(plan.edits).toEqual([]);
  expect(plan.unresolved.map((row) => row.todoId)).toEqual(['partial', 'repos', 'invalid']);
});
