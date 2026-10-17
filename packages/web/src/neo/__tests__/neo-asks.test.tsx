import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import type {
  NeoAsk,
  NeoAskItem,
  NeoAskTodo,
  NeoAskView,
} from '@hyperneo/shared/types/neo-snapshot';
import { cleanup, fireEvent, render, within } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NeoAskCard } from '../NeoAskCard.tsx';
import {
  describeNeoAskFromView,
  groupNeoAsks,
  NEO_ASK_NEEDS_YOU_LABEL,
  neoAskItems,
  neoAskOpenTarget,
} from '../neo-asks.ts';
import { type NeoProjectBoard, projectNeoProjectBoard } from '../neo-project-board.ts';
import {
  classifyNeoScenes,
  groupNeoScenes,
  projectNeoScenes,
  type NeoScene,
} from '../neo-scenes.ts';
import { testAskView, testCard } from './neo-test-views.ts';

afterEach(cleanup);

type Receipt = NeoProjectBoard['receipts'][number];
const work = (id: string, status: NeoWork['status']): Receipt =>
  ({
    kind: 'work',
    id,
    requestKey: id,
    projectId: null,
    originSessionId: 'root',
    originMessageId: 'm',
    title: `Card ${id}`,
    instruction: `Do ${id}`,
    sessionId: status === 'proposed' ? null : `${id}-session`,
    status,
    report: status === 'reported' ? `Report ${id}` : null,
    createdAt: 1,
    updatedAt: 2,
  }) as Receipt;
const ask = (id: string, status: NeoAsk['status'], workIds: string[]): NeoAsk => ({
  id,
  requestKey: id,
  projectId: null,
  originSessionId: 'root',
  originMessageId: 'm',
  title: `Ask ${id}`,
  ask: `Please ${id}`,
  doneWhen: 'Merged to dev with CI green',
  doneSource: 'human',
  status,
  outcome: status === 'achieved' ? 'Merged in #12.' : null,
  workIds,
  createdAt: 1,
  updatedAt: 2,
  settledAt: status === 'achieved' ? 3 : null,
});
const scenes = groupNeoScenes(
  classifyNeoScenes([
    work('a1', 'reported'),
    work('a2', 'queued'),
    work('b1', 'proposed'),
    work('loose', 'queued'),
    work('c1', 'reported'),
  ])
);

const item = (
  id: string,
  state: NeoAskItem['state'],
  extra: Partial<NeoAskItem> = {}
): NeoAskItem => ({
  id,
  text: `Item ${id}`,
  state,
  evidence: null,
  check: null,
  metBy: state === 'met' ? 'neo' : null,
  removed: false,
  addedAt: null,
  ...extra,
});
const describeAsk = (value: NeoAsk, owned: readonly NeoScene[], extra: Partial<NeoAskView> = {}) =>
  describeNeoAskFromView(value, owned, testAskView(value, extra));

describe('groupNeoAsks', () => {
  it.each([false, true, undefined])(
    'keeps daemon-visible cancelled work openable (%j)',
    (hidden) => {
      const receipt = work('external', 'cancelled');
      if (receipt.kind !== 'work') throw new Error('Expected work');
      const cancelled = { ...receipt, sessionId: null };
      const card = testCard(cancelled, {
        hidden: hidden ?? true,
        label: 'Cancelled · stop unsupported',
        controlFailure: {
          operation: 'stop',
          reason: 'unsupported',
          detail: 'Desktop owns it.',
          at: 2,
        },
        open: {
          link: 'claude://claude.ai/epitaxy/local_one',
          remoteLink: null,
          sessionId: null,
          daemon: null,
        },
      });
      const cards = new Map(hidden === undefined ? [] : [[cancelled.id, card]]);
      const board = projectNeoProjectBoard(
        {
          ok: true,
          sessionId: 'root',
          projects: [],
          work: [cancelled],
          consultations: [],
          cards: [],
          askViews: [],
        },
        null,
        null
      );
      const value = ask('external-ask', 'open', [cancelled.id]);
      const projected = projectNeoScenes(board, new Map(), new Map(), cards);
      const grouped = groupNeoAsks([value], projected, [testAskView(value)], cards);
      const view = grouped.asks.running[0];
      expect(view.scenes).toHaveLength(hidden === false ? 1 : 0);
      if (hidden === false) {
        expect(view.scenes[0].label).toBe('Cancelled · stop unsupported');
        expect(neoAskOpenTarget(view, cards)?.link).toBe(card.open.link);
      } else {
        expect(neoAskOpenTarget(view, cards)).toBeNull();
      }
    }
  );

  it('nests each ask’s cards under it and leaves the rest where they were', () => {
    const asks = [
      ask('a', 'open', ['a1', 'a2']),
      ask('b', 'open', ['b1']),
      ask('c', 'achieved', ['c1']),
      ask('w', 'waiting', []),
    ];
    const grouped = groupNeoAsks(
      asks,
      scenes,
      asks.map((value) => testAskView(value, value.id === 'a' ? { done: 1 } : {}))
    );
    expect(
      grouped.asks.running.map((view) => [view.ask.id, view.label, view.done, view.total])
    ).toEqual([['a', 'Working on it', 1, 2]]);
    expect(grouped.asks.attention.map((view) => [view.ask.id, view.label])).toEqual([
      ['b', NEO_ASK_NEEDS_YOU_LABEL],
      ['w', 'Waiting on you'],
    ]);
    expect(grouped.asks.outcomes.map((view) => [view.ask.id, view.label])).toEqual([['c', 'Done']]);
    expect(grouped.loose.running.map((scene) => scene.ref.id)).toEqual(['loose']);
    expect(grouped.loose.attention).toEqual([]);
    expect(grouped.loose.outcomes).toEqual([]);
  });

  it('hides failed attempts a card view marks superseded, and marks the cards of settled asks', () => {
    const retried = groupNeoScenes(
      classifyNeoScenes([
        { ...work('f1', 'failed'), createdAt: 1 } as Receipt,
        { ...work('f2', 'reported'), createdAt: 2 } as Receipt,
        { ...work('lone', 'failed'), createdAt: 1 } as Receipt,
        work('c1', 'reported'),
      ])
    );
    const settled = ask('c', 'achieved', ['c1']);
    const cards = new Map([
      [
        'f1',
        testCard({ id: 'f1', status: 'failed', sessionId: 'f1-session' }, { superseded: true }),
      ],
    ]);
    const grouped = groupNeoAsks([settled], retried, [testAskView(settled)], cards);
    expect(grouped.loose.outcomes.map((scene) => scene.ref.id)).toEqual(['f2', 'lone']);
    expect([...grouped.settledWork]).toEqual(['c1']);
  });

  it('leaves an ask without a published view out, and its cards loose', () => {
    const grouped = groupNeoAsks([ask('a', 'open', ['a2'])], scenes, []);
    expect(grouped.asks.running).toEqual([]);
    expect(grouped.loose.running.map((scene) => scene.ref.id)).toEqual(['a2', 'loose']);
  });
});

describe('neoAskItems', () => {
  it('reads the checklist, and nothing for an ask opened before checklists', () => {
    expect(neoAskItems({ ...ask('a', 'open', []), doneItems: [item('i1', 'met')] })).toHaveLength(
      1
    );
    expect(neoAskItems(ask('a', 'open', []))).toEqual([]);
  });
});

describe('neoAskOpenTarget', () => {
  const receipt = (id: string, status: NeoWork['status'], sessionId: string | null) =>
    ({ ...(work(id, status) as NeoWork), sessionId, kind: 'work' }) as Receipt;
  const target = (receipts: Receipt[], links: Record<string, string> = {}) => {
    const value = ask(
      'a',
      'open',
      receipts.map((item) => item.id)
    );
    const cards = new Map(
      Object.entries(links).map(([id, link]) => [
        id,
        testCard(
          { id, status: 'queued', sessionId: null },
          { open: { link, remoteLink: null, sessionId: null, daemon: null } }
        ),
      ])
    );
    const found = neoAskOpenTarget(describeAsk(value, classifyNeoScenes(receipts)), cards);
    return found && [found.work.id, found.link];
  };

  it('opens the card still running, else the latest one that can be opened', () => {
    expect(
      target(
        [
          receipt('old', 'reported', 'old-session'),
          receipt('run', 'queued', null),
          receipt('next', 'proposed', null),
        ],
        { run: 'claude://claude.ai/epitaxy/run' }
      )
    ).toEqual(['run', 'claude://claude.ai/epitaxy/run']);
    expect(
      target([receipt('old', 'reported', 'old-session'), receipt('new', 'reported', 'new-session')])
    ).toEqual(['new', null]);
    expect(target([receipt('p', 'proposed', null)])).toBeNull();
  });
});

describe('describeNeoAskFromView', () => {
  it('keeps the daemon todo status even when a proposed or failed scene is attention', () => {
    const value = ask('fact', 'open', ['b1']);
    const view = describeAsk(value, scenes.attention, {
      label: '在做',
      group: 'running',
      todos: [todo('b1', 'pending')],
    });
    expect(view.label).toBe('在做');
    expect(view.group).toBe('running');
  });

  it('keeps the daemon label of an idle ask and shows why it could not start', () => {
    const trying = describeAsk(ask('a', 'open', []), [], {
      group: 'attention',
      label: 'Not started · Neo is trying another way',
      idle: true,
      idleReason: "Couldn't start: No adapter can start work",
    });
    expect(trying.label).toBe('Not started · Neo is trying another way');
    expect(trying.idleReason).toBe("Couldn't start: No adapter can start work");
    const stuck = describeAsk(ask('a', 'open', []), [], {
      group: 'attention',
      needsYou: true,
      label: "Needs you · Couldn't start: No adapter can start work",
      idle: true,
      idleReason: "Couldn't start: No adapter can start work",
    });
    expect(stuck.label).toBe("Needs you · Couldn't start: No adapter can start work");
    expect(stuck.idleReason).toBeUndefined();
    const card = render(<NeoAskCard view={trying} />);
    expect(card.queryByText("Couldn't start: No adapter can start work")).toBeNull();
    fireEvent.click(card.getByRole('button', { name: 'Details' }));
    expect(card.getByText("Couldn't start: No adapter can start work")).toBeTruthy();
    cleanup();
  });
});

const todo = (
  id: string,
  state: NeoAskTodo['state'],
  extra: Partial<NeoAskTodo> = {}
): NeoAskTodo => ({
  id,
  workId: null,
  title: `任务 ${id}`,
  state,
  status: `状态 ${id}`,
  added: false,
  ...extra,
});

describe('NeoAskCard', () => {
  it('renders one todo list with factual marks, Chinese progress, removals and post-start additions', () => {
    const view = describeAsk(ask('a', 'open', ['a2']), scenes.running, {
      todos: [
        todo('pending', 'pending'),
        todo('running', 'running'),
        todo('done', 'done'),
        todo('failed', 'failed', { status: '没交出去：目标不可用' }),
        todo('old', 'cancelled', { status: '换成「新会话」' }),
        todo('new', 'pending', { added: true }),
        todo('a2', 'running', { workId: 'a2', status: '#103 开着，等 bot 批准' }),
      ],
    });
    const onOpen = vi.fn();
    const app = render(<NeoAskCard view={view} onOpen={onOpen} />);
    const rows = [...app.container.querySelectorAll('[data-ask-todo]')];
    expect(rows.map((row) => row.querySelector('[aria-hidden]')?.textContent)).toEqual([
      '○',
      '●',
      '✓',
      '✕',
      '',
      '○',
      '●',
    ]);
    expect(rows[4].querySelector('.line-through')?.textContent).toBe('任务 old');
    expect(app.getByText('新')).toBeTruthy();
    expect(app.getByText('没交出去：目标不可用')).toBeTruthy();
    expect(app.getByText('#103 开着，等 bot 批准')).toBeTruthy();
    expect(app.queryByText(/还要|做完 =|verified|Reply received|Watched:/)).toBeNull();
    const buttons = app.getAllByRole('button', { name: /^打开 / });
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0]);
    expect(onOpen).toHaveBeenCalledExactlyOnceWith('a2');
    fireEvent.click(app.getByRole('button', { name: 'Details' }));
    expect(app.container.querySelectorAll('[data-ask-todo]')).toHaveLength(7);
    expect(app.getAllByRole('button', { name: /^打开 / })).toHaveLength(1);
  });

  it.each([1, 3])(
    'uses the same %i todo rows inside a start question and never repeats them below',
    (count) => {
      const answer = vi.fn();
      const steps = Array.from({ length: count }, (_, n) => ({
        id: `w${n}`,
        title: `中文步骤 ${n}`,
      }));
      const view = describeAsk(ask('start', 'waiting', []), [], {
        humanActions: [
          {
            kind: 'question',
            itemId: 'q',
            question: count === 1 ? '开始「中文步骤 0」？' : '开始这 3 件？',
            options: ['先不做', '开始'],
            steps,
          },
        ],
        todos: [
          ...steps.map((step) =>
            todo(step.id, 'pending', { title: step.title, workId: step.id, status: 'PR 合进 dev' })
          ),
          todo('daemon', 'pending'),
        ],
      });
      const app = render(<NeoAskCard view={view} onAnswer={answer} />);
      const box = app.getByRole('list', { name: 'Needs you' });
      expect(box.querySelectorAll('[data-ask-todo]')).toHaveLength(count);
      expect(app.container.querySelectorAll('[data-ask-todo]')).toHaveLength(count + 1);
      expect([...box.querySelectorAll('[aria-hidden]')].map((row) => row.textContent)).toEqual(
        steps.map((_, n) => String(n + 1))
      );
      const choices = within(box).getAllByRole('button');
      expect(choices.map((button) => button.textContent)).toEqual(['先不做', '开始']);
      expect(choices[1].className).toContain('bg-accent');
      fireEvent.click(choices[1]);
      expect(answer).toHaveBeenCalledExactlyOnceWith('q', '开始');
    }
  );

  it('presents one current question while retaining the remaining question records in the view', () => {
    const answer = vi.fn();
    const view = describeAsk(ask('multiple', 'waiting', []), [], {
      humanActions: [
        { kind: 'question', itemId: 'older', question: '旧决定？', options: ['不要', '要'] },
        { kind: 'question', itemId: 'latest', question: '当前决定？', options: ['先不做', '继续'] },
      ],
    });
    const app = render(<NeoAskCard view={view} onAnswer={answer} />);
    expect(app.queryByText('旧决定？')).toBeNull();
    fireEvent.click(app.getByRole('button', { name: 'Answer 当前决定？: 继续' }));
    expect(answer).toHaveBeenCalledExactlyOnceWith('latest', '继续');
    expect(view.humanActions).toHaveLength(2);
  });

  it('shows decisions above todos and replies to the original question from the chat control', () => {
    const reply = vi.fn();
    const view = describeAsk(ask('decision', 'waiting', []), [], {
      humanActions: [{ kind: 'question', itemId: 'q', question: '换成新会话？', options: [] }],
      todos: [todo('failed', 'failed')],
    });
    const app = render(<NeoAskCard view={view} onReply={reply} />);
    fireEvent.click(app.getByRole('button', { name: '在聊天里回复' }));
    expect(reply.mock.calls[0][0]).toMatchObject({
      author: 'Neo',
      anchor: 'neo-question-decision-q',
      text: '换成新会话？',
    });
    expect(app.container.innerHTML.indexOf('data-ask-needs-you')).toBeLessThan(
      app.container.innerHTML.indexOf('data-ask-todo')
    );
    app.rerender(<NeoAskCard view={view} onReply={reply} disabled />);
    expect((app.getByRole('button', { name: '在聊天里回复' }) as HTMLButtonElement).disabled).toBe(
      true
    );
  });

  it('keeps real human answers and selection times only in Details, without evidence tags', () => {
    const at = 1792173600000;
    const value = {
      ...ask('a', 'achieved', []),
      doneItems: [
        item('answered', 'met', {
          decision: true,
          question: '原问题？',
          answer: { choice: '改派新会话', at },
          metBy: 'human',
          evidence: 'internal receipt',
        }),
        item('retired', 'needs_you', { decision: true, question: '过时问题？', removed: true }),
      ],
    };
    const app = render(<NeoAskCard view={describeAsk(value, [])} />);
    expect(app.queryByText('改派新会话')).toBeNull();
    fireEvent.click(app.getByRole('button', { name: 'Details' }));
    const answers = within(app.getByRole('list', { name: '已回答' }));
    expect(answers.getByText('改派新会话')).toBeTruthy();
    expect(app.container.querySelector('time')?.dateTime).toBe(new Date(at).toISOString());
    expect(app.getByText(/原问题？/)).toBeTruthy();
    expect(app.queryByText(/过时问题|internal receipt/)).toBeNull();
  });

  it('opens remote todos at their session link and gives daemon todos no Open control', () => {
    const view = describeAsk(ask('a', 'open', []), [], {
      todos: [todo('remote', 'running', { workId: 'remote' }), todo('daemon', 'done')],
    });
    const card = testCard(
      { id: 'remote', status: 'queued', sessionId: null },
      { open: { link: 'codex://threads/t1', sessionId: null, remoteLink: null, daemon: null } }
    );
    const app = render(<NeoAskCard view={view} cards={new Map([['remote', card]])} />);
    expect(app.getByRole('link', { name: '打开 任务 remote' }).getAttribute('href')).toBe(
      'codex://threads/t1'
    );
    expect(app.getAllByRole('link')).toHaveLength(1);
  });

  it('opens an older local todo directly from its structured target without a recent-work scene', () => {
    const openSession = vi.fn();
    const view = describeAsk(ask('older', 'open', []), [], {
      todos: [
        todo('old', 'done', {
          workId: 'old',
          open: {
            sessionId: 'old-session',
            link: '/session/old-session',
            daemon: null,
            remoteLink: null,
          },
        }),
      ],
    });
    const withSession: typeof view = {
      ...view,
      sessions: [
        {
          key: 'old-session',
          title: '旧会话',
          adapter: 'hyperneo',
          status: 'done',
          kind: null,
          open: {
            sessionId: 'old-session',
            link: '/session/old-session',
            daemon: null,
            remoteLink: null,
          },
        },
      ],
    };
    const app = render(<NeoAskCard view={withSession} onOpenSession={openSession} />);
    fireEvent.click(app.getByRole('button', { name: 'Details' }));
    expect(app.queryByRole('button', { name: 'Open 旧会话' })).toBeNull();
    fireEvent.click(app.getByRole('button', { name: '打开 任务 old' }));
    expect(openSession).toHaveBeenCalledExactlyOnceWith('old-session', '任务 old');
  });

  it('loads a summarized ask only when expanded and retries an unsuccessful detail read', () => {
    const expand = vi.fn();
    const view = describeAsk({ ...ask('a', 'achieved', []), summarized: true }, []);
    const app = render(<NeoAskCard view={view} onExpand={expand} />);
    expect(expand).not.toHaveBeenCalled();
    fireEvent.click(app.getByRole('button', { name: 'Details' }));
    expect(expand).toHaveBeenCalledTimes(1);
    expect(app.getByText('Loading details…')).toBeTruthy();
    app.rerender(<NeoAskCard view={view} onExpand={expand} detailFailed />);
    fireEvent.click(app.getByRole('button', { name: 'Retry' }));
    expect(expand).toHaveBeenCalledTimes(2);
  });

  it('disables question options while busy', () => {
    const answer = vi.fn();
    const view = describeAsk(ask('a', 'waiting', []), [], {
      humanActions: [
        { kind: 'question', itemId: 'q', question: '开始？', options: ['先不做', '开始'] },
      ],
    });
    const app = render(<NeoAskCard view={view} onAnswer={answer} disabled />);
    const choices = within(app.getByRole('list', { name: 'Needs you' })).getAllByRole('button');
    expect(choices.every((button) => (button as HTMLButtonElement).disabled)).toBe(true);
    fireEvent.click(choices[0]);
    expect(answer).not.toHaveBeenCalled();
  });
});
