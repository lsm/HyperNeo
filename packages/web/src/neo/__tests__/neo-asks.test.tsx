import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import type { NeoAsk, NeoAskItem, NeoAskView } from '@hyperneo/shared/types/neo-snapshot';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/preact';
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
    expect(card.getByText("Couldn't start: No adapter can start work")).toBeTruthy();
    cleanup();
  });
});

describe('NeoAskCard', () => {
  it('lists the linked sessions with their app, state and how to open them', () => {
    const openSession = vi.fn();
    const view = describeAsk(ask('a', 'waiting', []), [], {
      sessions: [
        {
          key: 'claude',
          title: 'Fix the login bug',
          adapter: 'claude-desktop',
          status: 'running',
          kind: 'needs_you',
          open: {
            link: 'claude://claude.ai/epitaxy/x',
            remoteLink: null,
            sessionId: null,
            daemon: null,
          },
        },
        {
          key: 'local',
          title: 'Review the docs',
          adapter: 'hyperneo',
          status: 'failed',
          kind: 'failed',
          open: { link: '/session/s1', remoteLink: null, sessionId: 's1', daemon: null },
        },
        {
          key: 'codex',
          title: 'Bump the deps',
          adapter: 'codex-desktop',
          status: 'running',
          kind: null,
          open: { link: null, remoteLink: null, sessionId: null, daemon: null },
        },
      ],
    });
    const card = render(<NeoAskCard view={view} onOpenSession={openSession} />);
    const rows = [...card.container.querySelectorAll('[data-ask-session]')].map((row) => [
      row.tagName,
      row.textContent,
    ]);
    expect(rows).toEqual([
      ['A', 'Fix the login bugClaude Code · Needs you'],
      ['BUTTON', 'Review the docsHyperNeo · Failed'],
      ['DIV', 'Bump the depsCodex · Running'],
    ]);
    expect(card.getByRole('link', { name: 'Open Fix the login bug' }).getAttribute('href')).toBe(
      'claude://claude.ai/epitaxy/x'
    );
    fireEvent.click(card.getByRole('button', { name: 'Open Review the docs' }));
    expect(openSession).toHaveBeenCalledExactlyOnceWith('s1', 'Review the docs');
  });

  it('asks for the full ask when a summarized one is expanded, and shows it once it arrives', () => {
    const full = ask('a', 'achieved', []);
    const summarized = { ...full, doneWhen: '', summarized: true as const };
    const onExpand = vi.fn();
    const card = render(
      <NeoAskCard view={describeAsk(summarized, [], { settled: true })} onExpand={onExpand} />
    );
    const toggle = card.getByRole('button', { name: 'Details' });
    fireEvent.click(toggle);
    expect(onExpand).toHaveBeenCalledTimes(1);
    expect(card.getByRole('status').textContent).toBe('Loading details…');
    fireEvent.click(toggle);
    expect(onExpand).toHaveBeenCalledTimes(1);
    fireEvent.click(toggle);
    expect(onExpand).toHaveBeenCalledTimes(2);
    card.rerender(
      <NeoAskCard view={describeAsk(full, [], { settled: true })} onExpand={onExpand} />
    );
    expect(card.queryByRole('status')).toBeNull();
    expect(card.getByText('Merged to dev with CI green')).toBeTruthy();
  });

  it('asks for the detail of an ask that becomes summarized while open, and retries a failed read', () => {
    const full = ask('a', 'achieved', []);
    const summarized = { ...full, doneWhen: '', summarized: true as const };
    const onExpand = vi.fn();
    const card = render(
      <NeoAskCard view={describeAsk(full, [], { settled: true })} onExpand={onExpand} />
    );
    fireEvent.click(card.getByRole('button', { name: 'Details' }));
    expect(onExpand).not.toHaveBeenCalled();
    card.rerender(
      <NeoAskCard view={describeAsk(summarized, [], { settled: true })} onExpand={onExpand} />
    );
    expect(onExpand).toHaveBeenCalledTimes(1);
    card.rerender(
      <NeoAskCard
        view={describeAsk(summarized, [], { settled: true })}
        onExpand={onExpand}
        detailFailed
      />
    );
    expect(card.getByRole('status').textContent).toContain('Couldn’t load details.');
    fireEvent.click(card.getByRole('button', { name: 'Retry' }));
    expect(onExpand).toHaveBeenCalledTimes(2);
    card.rerender(
      <NeoAskCard
        view={describeAsk(summarized, [], { settled: true })}
        onExpand={onExpand}
        detailEpoch={1}
      />
    );
    expect(onExpand).toHaveBeenCalledTimes(3);
    card.rerender(
      <NeoAskCard
        view={describeAsk({ ...summarized, revision: 9 }, [], { settled: true })}
        onExpand={onExpand}
        detailEpoch={1}
      />
    );
    expect(onExpand).toHaveBeenCalledTimes(4);
  });

  it('shows no session rows when the ask has none', () => {
    const card = render(<NeoAskCard view={describeAsk(ask('a', 'open', []), [])} />);
    expect(card.container.querySelector('[data-ask-session]')).toBeNull();
  });

  it('shows 还要 before Details and renders each step once without nested cards', () => {
    const owned = [scenes.outcomes[0]!, scenes.running[0]!, scenes.attention[0]!];
    const view = describeAsk(ask('a', 'open', ['a1', 'a2', 'b1']), owned, { doneWorkIds: ['a1'] });
    const card = render(<NeoAskCard view={view} onOpen={vi.fn()} />);
    expect(card.getByText('还要')).toBeTruthy();
    expect(card.getByText('Merged to dev with CI green')).toBeTruthy();
    expect(card.queryByText(/outcomes verified/)).toBeNull();
    expect(card.container.querySelectorAll('[data-ask-step]')).toHaveLength(3);
    expect(card.container.querySelectorAll('article')).toHaveLength(1);
    expect(card.getAllByText('Handed to HyperNeo')).toHaveLength(1);
    const opener = card.getByRole('button', { name: 'Open Card a2' });
    expect(opener.closest('[data-ask-step]')?.getAttribute('data-ask-step')).toBe('a2');
    fireEvent.click(card.getByRole('button', { name: 'Details' }));
    expect(card.getAllByRole('button', { name: 'Open Card a2' })).toHaveLength(1);
    expect(card.container.querySelectorAll('article')).toHaveLength(1);
  });

  it('opens the ask’s current card in its app or in chat', () => {
    const queued = { ...(work('a2', 'queued') as NeoWork), sessionId: null };
    const linked = groupNeoScenes(classifyNeoScenes([{ ...queued, kind: 'work' }])).running;
    const card = testCard(
      { id: 'a2', status: 'queued', sessionId: null },
      {
        adapter: 'codex-desktop',
        open: { link: 'codex://threads/t1', remoteLink: null, sessionId: null, daemon: null },
      }
    );
    const view = describeAsk(ask('a', 'open', ['a2']), linked);
    const app = render(<NeoAskCard view={view} cards={new Map([['a2', card]])} />);
    const link = app.getByRole('link', { name: 'Open Card a2' });
    expect([link.getAttribute('href'), link.textContent]).toEqual(['codex://threads/t1', 'Open']);
    expect(link.querySelector('[data-app-logo]')?.getAttribute('data-app-logo')).toBe(
      'anthropic-codex'
    );
    cleanup();
    const open = vi.fn();
    const chat = render(
      <NeoAskCard
        view={describeAsk(ask('c', 'achieved', ['c1']), scenes.outcomes.slice(1))}
        onOpen={open}
      />
    );
    fireEvent.click(chat.getByRole('button', { name: 'Open Card c1' }));
    expect(open).toHaveBeenCalledExactlyOnceWith('c1');
    expect(chat.getByRole('button', { name: 'Open Card c1' }).textContent).toBe('Open');
    cleanup();
    const unstarted = render(
      <NeoAskCard view={describeAsk(ask('b', 'open', ['b1']), scenes.attention)} onOpen={open} />
    );
    expect(unstarted.queryByRole('button', { name: 'Open Card b1' })).toBeNull();
  });

  it('counts checklist items, not cards, and leaves removed items out of the count', () => {
    const view = describeAsk(
      {
        ...ask('a', 'open', ['a1', 'a2']),
        doneItems: [
          item('i1', 'met', {
            metBy: 'daemon',
            check: 'coding.pr_merged',
            evidence: 'PR #6099 merged',
          }),
          item('i2', 'pending'),
          item('i3', 'pending', { removed: true, removedReason: 'Removed by the human.' }),
          item('i4', 'needs_you', { text: 'Ship it?', options: ['Yes', 'No'] }),
        ],
      },
      scenes.running.slice(0, 1),
      { done: 1, total: 2 }
    );
    expect([view.done, view.total]).toEqual([1, 2]);
    const card = render(<NeoAskCard view={view} />);
    expect(card.queryByText(/outcomes verified/)).toBeNull();
    fireEvent.click(card.getByRole('button', { name: 'Details' }));
    const rows = [
      ...card.getByRole('list', { name: '还要' }).querySelectorAll('[data-ask-item]'),
    ].map((row) => [row.getAttribute('data-ask-item'), row.textContent]);
    expect(rows).toEqual([
      ['i1', '✓Item i1verifiedPR #6099 merged'],
      ['i2', '○Item i2'],
      ['i3', '○Item i3removedRemoved by the human.'],
    ]);
    expect(card.queryByRole('list', { name: 'Answered questions' })).toBeNull();
    expect(card.container.querySelector('[data-ask-item="i3"] .line-through')).toBeTruthy();
  });

  it('places each todo under its delivering step and puts unassigned or missing steps under 还要', () => {
    const value = {
      ...ask('owned-todos', 'open', ['a1', 'a2']),
      doneItems: [
        item('one', 'pending', { text: 'Backend merged', deliveredBy: 'a1' }),
        item('two', 'pending', { text: 'Web merged', deliveredBy: 'a2' }),
        item('manual', 'pending', { text: 'Try it on the laptop' }),
        item('missing', 'pending', {
          text: 'Retain the missing step outcome',
          deliveredBy: 'gone',
        }),
      ],
    };
    const app = render(
      <NeoAskCard view={describeAsk(value, [...scenes.running, ...scenes.outcomes])} />
    );
    const first = app.container.querySelector<HTMLElement>('[data-ask-step="a1"]')!;
    const second = app.container.querySelector<HTMLElement>('[data-ask-step="a2"]')!;
    expect(within(first).getByText('Backend merged')).toBeTruthy();
    expect(within(first).queryByText('Web merged')).toBeNull();
    expect(within(second).getByText('Web merged')).toBeTruthy();
    expect(within(second).getByText('做完 =')).toBeTruthy();
    const rest = within(app.getByRole('list', { name: '还要' }));
    expect(rest.getByText('Try it on the laptop')).toBeTruthy();
    expect(rest.getByText('Retain the missing step outcome')).toBeTruthy();
    expect(rest.queryByText('Web merged')).toBeNull();
    expect(app.queryByText('Todos')).toBeNull();
    expect(app.queryByText('Done when')).toBeNull();
  });

  it('places proposed step outcomes inside the start question for one or several steps', () => {
    for (const ids of [['one'], ['one', 'two', 'three']]) {
      const steps = ids.map((id) => ({ id, title: `Step ${id}` }));
      const owned = groupNeoScenes(
        classifyNeoScenes(ids.map((id) => work(id, 'proposed')))
      ).attention;
      const value = {
        ...ask('question-todos', 'waiting', ids),
        doneItems: ids.map((id) => item(id, 'pending', { text: `Outcome ${id}`, deliveredBy: id })),
      };
      const view = describeAsk(value, owned, {
        humanActions: [
          {
            kind: 'question',
            itemId: 'q',
            question: 'Start these steps?',
            options: ['Later', 'Start'],
            steps,
          },
        ],
      });
      const app = render(<NeoAskCard view={view} onAnswer={vi.fn()} />);
      const question = within(app.getByRole('list', { name: 'Needs you' }));
      for (const id of ids) expect(question.getByText(`Outcome ${id}`)).toBeTruthy();
      expect(app.container.querySelectorAll('[data-ask-step]')).toHaveLength(0);
      expect(app.queryByText('还要')).toBeNull();
      cleanup();
    }
  });

  it('updates a step todo from waiting for a PR to live PR progress without premature verification', () => {
    const value = {
      ...ask('pr-progress', 'open', ['a2']),
      doneItems: [
        item('merge', 'pending', {
          text: 'Merge the PR',
          deliveredBy: 'a2',
          check: 'coding.pr_merged',
        }),
      ],
    };
    const view = describeAsk(value, scenes.running);
    const app = render(<NeoAskCard view={view} />);
    expect(app.getByText('等 PR 开出来')).toBeTruthy();
    const card = testCard(
      { id: 'a2', status: 'queued', sessionId: 'a2-session' },
      {
        pr: {
          number: '42',
          label: 'Waiting on CI · #42',
          count: 1,
          inProgress: true,
          setback: false,
          merged: [],
        },
      }
    );
    app.rerender(<NeoAskCard view={view} cards={new Map([['a2', card]])} />);
    expect(app.queryByText('等 PR 开出来')).toBeNull();
    expect(app.getByText('Waiting on CI · #42')).toBeTruthy();
    expect(app.queryByText('verified')).toBeNull();
    expect(app.getByText('○')).toBeTruthy();
  });

  it('renders grouped start steps from structured data and does not repeat proposed cards', () => {
    const steps = ['one', 'two', 'three'].map((id, index) => ({ id, title: `第 ${index + 1} 步` }));
    const owned = groupNeoScenes(
      classifyNeoScenes(steps.map((step) => work(step.id, 'proposed')))
    ).attention;
    const answer = vi.fn();
    const view = describeAsk(
      ask(
        'start-steps',
        'waiting',
        steps.map((step) => step.id)
      ),
      owned,
      {
        humanActions: [
          {
            kind: 'question',
            itemId: 'q',
            question: '开始这 3 步？',
            options: ['先不做', '开始'],
            steps,
          },
        ],
      }
    );
    const app = render(<NeoAskCard view={view} onAnswer={answer} />);
    const list = app.getByRole('list', { name: '待开始步骤' });
    expect(list.tagName).toBe('OL');
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((row) => [row.getAttribute('data-question-step'), row.textContent])
    ).toEqual(steps.map((step) => [step.id, step.title]));
    expect(app.container.querySelectorAll('[data-ask-step]')).toHaveLength(0);
    fireEvent.click(app.getByRole('button', { name: 'Answer 开始这 3 步？: 开始' }));
    expect(answer).toHaveBeenCalledExactlyOnceWith('q', '开始');
  });

  it('shows a named single-step question once while retaining an unrelated running row', () => {
    const owned = [...scenes.attention, ...scenes.running];
    const view = describeAsk(ask('single-step', 'waiting', ['b1', 'a2']), owned, {
      humanActions: [
        {
          kind: 'question',
          itemId: 'q',
          question: '开始「按样图改网页」？',
          options: ['先不做', '开始'],
          steps: [{ id: 'b1', title: '按样图改网页' }],
        },
      ],
    });
    const app = render(<NeoAskCard view={view} onAnswer={vi.fn()} />);
    expect(app.getAllByText('开始「按样图改网页」？')).toHaveLength(1);
    expect(app.queryByRole('list', { name: '待开始步骤' })).toBeNull();
    expect(app.container.querySelector('[data-ask-step="b1"]')).toBeNull();
    expect(app.container.querySelector('[data-ask-step="a2"]')).toBeTruthy();
  });

  it('renders each question once with the decline option left and positive option right', () => {
    const answer = vi.fn();
    const view = describeAsk(
      {
        ...ask('w', 'waiting', []),
        doneItems: [item('i2', 'needs_you', { text: '开始调查？', decision: true })],
      },
      [],
      {
        humanActions: [
          {
            kind: 'question',
            itemId: 'i2',
            question: '开始调查？',
            options: ['先不做', '开始调查'],
          },
        ],
      }
    );
    const card = render(<NeoAskCard view={view} onAnswer={answer} />);
    const choices = within(card.getByRole('list', { name: 'Needs you' })).getAllByRole('button');
    expect(choices.map((button) => button.textContent)).toEqual(['先不做', '开始调查']);
    expect(choices[1].className).toContain('bg-accent');
    fireEvent.click(choices[0]);
    expect(answer).toHaveBeenCalledExactlyOnceWith('i2', '先不做');
    fireEvent.click(card.getByRole('button', { name: 'Details' }));
    expect(card.queryByRole('list', { name: 'Answered questions' })).toBeNull();
    expect(card.getAllByText('开始调查？')).toHaveLength(1);
    expect(card.getAllByRole('button', { name: /: 开始调查$/ })).toHaveLength(1);
  });

  it.each([undefined, ['https://github.com/lsm/HyperNeo/issues/7264']])(
    'preserves Chinese titles and waits for a PR with issue watch %s, with answers in Details',
    (watch) => {
      const scene = {
        ...scenes.running[0]!,
        receipt: { ...scenes.running[0]!.receipt, title: '实现会话归属控制' },
      };
      const view = describeAsk(
        {
          ...ask('mock', 'open', ['a2']),
          title: '按会话归属改驱动控制',
          doneItems: [
            item('merge', 'pending', {
              text: '这次的 PR 合并进 dev',
              check: 'coding.pr_merged',
              watch,
              deliveredBy: 'a2',
            }),
            item('answered', 'met', {
              text: '开始这 1 步？',
              decision: true,
              metBy: 'human',
              evidence: 'The human answered: 开始',
            }),
          ],
        },
        [scene]
      );
      const card = render(<NeoAskCard view={view} onOpen={vi.fn()} />);
      expect(card.getByRole('article', { name: '按会话归属改驱动控制' })).toBeTruthy();
      expect(card.getByText('实现会话归属控制')).toBeTruthy();
      expect(card.getByText('等 PR 开出来')).toBeTruthy();
      expect(card.queryByText(/outcomes verified/)).toBeNull();
      expect(card.queryByText('开始这 1 步？')).toBeNull();
      fireEvent.click(card.getByRole('button', { name: 'Details' }));
      expect(
        within(card.getByRole('list', { name: 'Answered questions' })).getByText('开始这 1 步？')
      ).toBeTruthy();
      expect(card.getByText('The human answered: 开始')).toBeTruthy();
      const openedCard = testCard(
        { id: 'a2', status: 'queued', sessionId: 'a2-session' },
        {
          pr: {
            number: '7255',
            label: 'Checks pending',
            count: 1,
            inProgress: true,
            setback: false,
            merged: [],
          },
        }
      );
      card.rerender(
        <NeoAskCard
          view={{
            ...view,
            scenes: [{ ...scene, label: 'PR #7255 · checks pending · waiting for bot approval' }],
          }}
          cards={new Map([['a2', openedCard]])}
          onOpen={vi.fn()}
        />
      );
      expect(card.queryByText('等 PR 开出来')).toBeNull();
      expect(
        card.getAllByText('PR #7255 · checks pending · waiting for bot approval')
      ).toHaveLength(1);
      expect(card.queryByText(/outcomes verified/)).toBeNull();
      expect(card.getAllByRole('button', { name: 'Open 实现会话归属控制' })).toHaveLength(1);
    }
  );

  it('disables option submission while busy', () => {
    const view = describeAsk(ask('w', 'waiting', []), [], {
      humanActions: [
        { kind: 'question', itemId: 'i2', question: 'Did it work?', options: ['No', 'Yes'] },
      ],
    });
    const card = render(<NeoAskCard view={view} onAnswer={vi.fn()} disabled />);
    expect(
      (card.getByRole('button', { name: 'Answer Did it work?: Yes' }) as HTMLButtonElement).disabled
    ).toBe(true);
  });

  it('offers a secondary right-aligned reply button that targets the open question', () => {
    const reply = vi.fn();
    const answer = vi.fn();
    const view = describeAsk(ask('w', 'waiting', []), [], {
      humanActions: [{ kind: 'question', itemId: 'i2', question: 'Which repo?', options: [] }],
    });
    const card = render(<NeoAskCard view={view} onAnswer={answer} onReply={reply} />);
    const button = within(card.getByRole('list', { name: 'Needs you' })).getByRole('button', {
      name: 'Reply in chat',
    });
    expect(button.parentElement?.classList.contains('justify-end')).toBe(true);
    expect(button.classList.contains('bg-accent')).toBe(false);
    fireEvent.click(button);
    expect(reply).toHaveBeenCalledExactlyOnceWith({
      author: 'Neo',
      text: 'Which repo?',
      anchor: button.closest('li')!.id,
    });
    expect(button.closest('li')!.id).not.toBe('');
    expect(answer).not.toHaveBeenCalled();
  });

  it('disables open-question replies while unavailable', () => {
    const reply = vi.fn();
    const view = describeAsk(ask('w', 'waiting', []), [], {
      humanActions: [{ kind: 'question', itemId: 'i2', question: 'Which repo?', options: [] }],
    });
    const card = render(<NeoAskCard view={view} onReply={reply} disabled />);
    const button = card.getByRole('button', { name: 'Reply in chat' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(reply).not.toHaveBeenCalled();
  });

  it('does not invent confirm, retry or approval controls from reported items or expired approval facts', () => {
    const view = describeAsk(
      {
        ...ask('w', 'open', []),
        approvedAt: 1,
        approvalSpent: 'expired',
        stalledWorkIds: ['w1'],
        doneItems: [item('i2', 'reported', { text: 'The iMac runs the fix' })],
      },
      []
    );
    const card = render(<NeoAskCard view={view} />);
    expect(card.queryByRole('list', { name: 'Needs you' })).toBeNull();
    expect(card.queryByRole('button', { name: /Confirm|Retry|Approve/ })).toBeNull();
  });

  it('hides outcome progress while all cards are still proposed', () => {
    const proposed = [...scenes.attention, ...scenes.running].filter(
      (scene) => scene.receipt.kind === 'work' && scene.receipt.status === 'proposed'
    );
    expect(proposed.length).toBeGreaterThan(0);
    const view = describeAsk(
      { ...ask('b', 'open', ['b1']), doneItems: [item('i1', 'pending')] },
      proposed
    );
    const card = render(<NeoAskCard view={view} />);
    expect(card.queryByText(/outcomes verified/)).toBeNull();
    expect(card.queryByRole('button', { name: 'Approve all steps' })).toBeNull();
  });

  it('shows the done-when text for an ask opened before checklists', () => {
    const card = render(<NeoAskCard view={describeAsk(ask('a', 'open', []), [])} />);
    fireEvent.click(card.getByRole('button', { name: 'Details' }));
    expect(card.getByText('Merged to dev with CI green')).toBeTruthy();
    expect(card.queryByRole('list', { name: '还要' })).toBeNull();
  });

  it('drops the count once settled and keeps a long outcome behind Details', () => {
    const outcome = `Merged after review. ${'evidence '.repeat(30)}`;
    const view = describeAsk(
      { ...ask('c', 'achieved', ['c1']), outcome },
      scenes.outcomes.slice(1),
      { summary: 'Merged after review.' }
    );
    const card = render(<NeoAskCard view={view} />);
    expect(card.queryByText(/of \d+ done/)).toBeNull();
    expect(card.getByText('Merged after review.')).toBeTruthy();
    expect(card.queryByText(outcome)).toBeNull();
    fireEvent.click(card.getByRole('button', { name: 'Details' }));
    expect(card.getByText(outcome.trim())).toBeTruthy();
  });

  it('closes an open ask as done or dropped from its menu, and offers nothing once settled', () => {
    const settle = vi.fn();
    for (const item of ['Mark done', 'Drop this ask']) {
      const card = render(
        <NeoAskCard view={describeAsk(ask('a', 'open', []), [])} onSettle={settle} />
      );
      fireEvent.click(card.getByRole('button', { name: 'Ask actions' }));
      fireEvent.click(screen.getByRole('menuitem', { name: item }));
      cleanup();
    }
    expect(settle.mock.calls).toEqual([['achieved'], ['abandoned']]);
    const settled = render(
      <NeoAskCard view={describeAsk(ask('c', 'achieved', []), [])} onSettle={settle} />
    );
    expect(settled.queryByRole('button', { name: 'Ask actions' })).toBeNull();
  });
});
