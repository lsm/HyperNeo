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
import type { NeoProjectBoard } from '../neo-project-board.ts';
import { classifyNeoScenes, groupNeoScenes, type NeoScene } from '../neo-scenes.ts';
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
          adapter: 'hyperneo-sessions',
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

  it('names its card without counting steps as outcomes, and keeps the done definition and the full card behind Details', () => {
    const view = describeAsk(ask('a', 'waiting', ['a1', 'a2']), scenes.running.slice(0, 1));
    const card = render(<NeoAskCard view={view} renderCard={() => <p>Step card</p>} />);
    expect(card.container.querySelector('[data-ask-step]')?.textContent).toBe(
      '●Card a2Handed to HyperNeo'
    );
    expect(card.getByText('Waiting on you')).toBeTruthy();
    expect(card.queryByText(/outcomes verified/)).toBeNull();
    expect(card.queryByText('Merged to dev with CI green')).toBeNull();
    expect(card.queryByText('Step card')).toBeNull();
    const toggle = card.getByRole('button', { name: 'Details' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(card.getByText('Merged to dev with CI green')).toBeTruthy();
    expect(card.getByText('Step card')).toBeTruthy();
  });

  it('lists several cards as rows with their stage and shows a card that needs you in full', () => {
    const owned = [scenes.outcomes[0]!, scenes.running[0]!, scenes.attention[0]!];
    const view = describeAsk(ask('a', 'open', ['a1', 'a2', 'b1']), owned, { doneWorkIds: ['a1'] });
    const rendered: string[] = [];
    const card = render(
      <NeoAskCard
        view={view}
        renderCard={(scene) => {
          rendered.push(scene.ref.id);
          return <p>Full {scene.ref.id}</p>;
        }}
      />
    );
    expect(card.getByRole('button', { name: 'Details' }).getAttribute('aria-expanded')).toBe(
      'false'
    );
    const rows = [...card.container.querySelectorAll('[data-ask-step]')].map((row) => [
      row.getAttribute('data-ask-step'),
      row.textContent,
    ]);
    expect(rows).toEqual([
      ['a1', '✓Card a1Reply received'],
      ['a2', '●Card a2Handed to HyperNeo'],
    ]);
    expect(rendered).toEqual(['b1']);
    expect(card.getByText('Full b1')).toBeTruthy();
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
    const link = app.getByRole('link', { name: 'Open Ask a' });
    expect([link.getAttribute('href'), link.textContent]).toEqual([
      'codex://threads/t1',
      'Open in Codex',
    ]);
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
    fireEvent.click(chat.getByRole('button', { name: 'Open Ask c' }));
    expect(open).toHaveBeenCalledExactlyOnceWith('c1');
    expect(chat.getByRole('button', { name: 'Open Ask c' }).textContent).toBe('Open chat');
    cleanup();
    const unstarted = render(
      <NeoAskCard view={describeAsk(ask('b', 'open', ['b1']), scenes.attention)} onOpen={open} />
    );
    expect(unstarted.queryByRole('button', { name: 'Open Ask b' })).toBeNull();
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
    expect(card.getByText('1 of 2 outcomes verified')).toBeTruthy();
    fireEvent.click(card.getByRole('button', { name: 'Details' }));
    const rows = [
      ...card.getByRole('list', { name: 'Done when' }).querySelectorAll('[data-ask-item]'),
    ].map((row) => [row.getAttribute('data-ask-item'), row.textContent]);
    expect(rows).toEqual([
      ['i1', '✓Item i1verifiedPR #6099 merged'],
      ['i2', '○Item i2'],
      ['i3', '○Item i3removedRemoved by the human.'],
    ]);
    expect(
      within(card.getByRole('list', { name: 'Questions' })).getByText('Ship it?')
    ).toBeTruthy();
    expect(card.container.querySelector('[data-ask-item="i3"] .line-through')).toBeTruthy();
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
    const questions = within(card.getByRole('list', { name: 'Questions' }));
    expect(questions.getByRole('button', { name: 'Question above' })).toBeTruthy();
    expect(questions.queryByRole('button', { name: /开始调查/ })).toBeNull();
    expect(card.getAllByRole('button', { name: /: 开始调查$/ })).toHaveLength(1);
  });

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
    expect(card.queryByRole('list', { name: 'Done when' })).toBeNull();
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
