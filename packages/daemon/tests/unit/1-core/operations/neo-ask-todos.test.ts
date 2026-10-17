import { describe, expect, test } from 'bun:test';
import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import type { NeoAsk, NeoAskItem, NeoWorkPr } from '@hyperneo/shared/types/neo-snapshot';
import { projectNeoAskTodos } from '../../../../src/lib/neo/ask-todo-views.ts';
import { projectNeoAskViews } from '../../../../src/lib/neo/ask-views.ts';
import { projectNeoCardViews } from '../../../../src/lib/neo/card-views.ts';

const work = (id: string, status: NeoWork['status'] = 'reported'): NeoWork => ({
  id,
  title: id,
  requestKey: id,
  projectId: null,
  originSessionId: 'neo',
  originMessageId: null,
  instruction: '',
  sessionId: `session-${id}`,
  status,
  report: '测试没过',
  createdAt: 10,
  updatedAt: 20,
});
const item = (id: string, extra: Partial<NeoAskItem> = {}): NeoAskItem => ({
  id,
  text: id,
  state: 'pending',
  evidence: null,
  check: null,
  metBy: null,
  removed: false,
  addedAt: null,
  ...extra,
});
const ask = (work: NeoWork[], items: NeoAskItem[]): NeoAsk => ({
  id: 'ask',
  requestKey: 'ask',
  projectId: null,
  originSessionId: 'neo',
  originMessageId: null,
  title: '一张清单',
  ask: '',
  doneWhen: '',
  doneSource: '',
  status: 'open',
  outcome: null,
  workIds: work.map((row) => row.id),
  doneItems: items,
  createdAt: 1,
  updatedAt: 20,
  settledAt: null,
});
const pr = (state: NeoWorkPr['state'], extra: Partial<NeoWorkPr> = {}): NeoWorkPr => ({
  url: 'https://github.com/o/r/pull/103',
  state,
  checks: 'passing',
  review: 'none',
  ...extra,
});
function project(
  rows: NeoWork[],
  items: NeoAskItem[],
  prs: NeoWorkPr[] = [],
  extra: Partial<NeoAsk> = {}
) {
  const input = {
    work: rows,
    drivers: [],
    prs: [{ workId: rows[0]?.id ?? '', prs, waiting: false }],
    goals: [],
    continues: [],
    supersessions: [{ workId: 'old', supersededBy: 'new', supersededAt: 20 }],
    asks: [{ ...ask(rows, items), ...extra }],
  };
  return projectNeoAskViews(
    input.asks,
    projectNeoCardViews(input),
    input.prs,
    undefined,
    undefined,
    input
  )[0];
}

describe('projectNeoAskViews todo projection', () => {
  test.each([
    ['proposed', 'pending', '要求合并'],
    ['queued', 'running', '等 PR 开出来'],
    ['reported', 'running', '等 PR 开出来'],
    ['failed', 'failed', '没交出去：测试没过'],
    ['cancelled', 'cancelled', '已取消'],
  ] as const)('%s is a single todo with its own state', (status, state, label) => {
    const view = project(
      [work('w', status)],
      [item('要求合并', { check: 'coding.pr_merged', deliveredBy: 'w' })]
    );
    expect(view.todos).toEqual([
      { id: 'w', workId: 'w', title: 'w', state, status: label, added: false },
    ]);
  });
  test.each([
    [pr('MERGED'), 'done', '#103 已合并'],
    [pr('OPEN'), 'running', '#103 开着，等 bot 批准'],
    [pr('OPEN', { checks: 'failing' }), 'running', '#103 开着，CI 没过'],
    [pr('OPEN', { review: 'approved' }), 'running', '#103 开着，已批准，等合并'],
    [pr('CLOSED'), 'failed', '#103 已关闭，没合并'],
  ] as const)('uses independently read PR facts %j', (read, state, status) => {
    expect(
      project(
        [work('w')],
        [item('merged', { check: 'coding.pr_merged', deliveredBy: 'w' })],
        [read]
      ).todos
    ).toEqual([{ id: 'w', workId: 'w', title: 'w', state, status, added: false }]);
  });
  test.each([
    ['abandoned', 'failed', '会话没有回报结果'],
    ['checking', 'running', '会话已结束，daemon 正在核实'],
  ] as const)('does not claim work is running in phase %s', (phase, state, status) => {
    const row = work('w', 'queued');
    const cards = projectNeoCardViews({
      work: [row],
      drivers: [{ workId: 'w', adapter: 'hyperneo', daemon: null, status: 'done', link: null }],
      prs: [],
      goals: [],
      continues: [],
      supersessions: [],
      asks: [],
    });
    expect(
      projectNeoAskTodos(ask([row], []), [{ ...cards[0], phase }], [], {
        work: [row],
        supersessions: [],
      })[0]
    ).toMatchObject({ state, status });
  });

  test('merged PRs do not claim an unmet deployment is done', () => {
    expect(
      project(
        [work('w')],
        [item('deployed', { check: 'coding.deployed', deliveredBy: 'w' })],
        [pr('MERGED')]
      ).todos?.[0].state
    ).toBe('running');
  });
  test('a report is enough only without a readable completion standard', () => {
    expect(project([work('w')], []).todos?.[0]).toMatchObject({
      state: 'done',
      status: '会话说做完了，没查到 PR',
    });
    expect(
      project([work('w')], [item('deployment', { deliveredBy: 'w', check: 'coding.deployed' })])
        .todos?.[0].state
    ).toBe('running');
    expect(
      project([work('w')], [item('confirmed', { deliveredBy: 'w', state: 'met' })]).todos?.[0].state
    ).toBe('done');
  });
  test('retains replaced and cancelled work, independent outcomes, and no question todos', () => {
    const view = project(
      [work('old', 'failed'), work('new'), work('cancelled', 'cancelled')],
      [
        item('unassigned', { state: 'met' }),
        item('bound', { deliveredBy: 'old' }),
        item('removed', { removed: true, removedReason: '已取消部署' }),
        item('question', { decision: true, state: 'needs_you', question: '选哪个？' }),
      ]
    );
    expect(view.todos?.map((todo) => todo.id)).toEqual([
      'old',
      'new',
      'cancelled',
      'unassigned',
      'removed',
    ]);
    expect(view.todos?.[0]).toMatchObject({ state: 'cancelled', status: '换成「new」' });
    expect(view.todos?.[3]).toMatchObject({ workId: null, state: 'done' });
    expect(view.todos?.[4]).toMatchObject({
      workId: null,
      state: 'cancelled',
      status: '已取消部署',
    });
  });
  test('keeps the ask order when snapshot work arrives newest first', () => {
    const rows = [work('first'), work('second')];
    expect(
      project(rows.slice().reverse(), [], [], { workIds: ['first', 'second'] }).todos?.map(
        (todo) => todo.id
      )
    ).toEqual(['first', 'second']);
  });

  test('only work added after the first human start gets 新, even after a replan resets approval', () => {
    const approval = item('start', {
      kind: 'approval',
      options: ['先不做', '开始'],
      state: 'met',
      answer: { choice: '开始', at: 5 },
    });
    const view = project(
      [work('w')],
      [approval, item('later', { addedAt: 6 }), item('before', { addedAt: 3 })],
      [],
      { approvedAt: null }
    );
    expect(view.todos?.map((todo) => todo.added)).toEqual([true, true, false]);
    expect(
      project([work('w')], [item('later', { addedAt: 6 })]).todos?.every((todo) => !todo.added)
    ).toBe(true);
  });
});
