import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import type { NeoAsk, NeoAskItem, NeoAskView } from '@hyperneo/shared/types/neo-snapshot';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NeoAskCard } from '../NeoAskCard.tsx';
import {
  describeNeoAskFromView,
  groupNeoAsks,
  NEO_ASK_NEEDS_YOU_LABEL,
  neoAskApproval,
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

  it('puts only the daemon’s human actions on the card face and marks items added later', () => {
    const view = describeAsk(
      {
        ...ask('w', 'waiting', []),
        doneItems: [
          item('i1', 'met'),
          item('i2', 'needs_you', { text: 'Check the keyboard hides', kind: 'action' }),
          item('i3', 'pending', { addedAt: 5 }),
          item('i4', 'needs_you', { text: 'Wait for #6618 to merge' }),
        ],
      },
      [],
      {
        humanActions: [
          {
            kind: 'answer',
            itemId: 'i2',
            step: 'Check the keyboard hides',
            question: 'Did it work?',
            options: ['Yes', 'No'],
          },
        ],
      }
    );
    const card = render(<NeoAskCard view={view} onAnswer={vi.fn()} onDone={vi.fn()} />);
    const face = card.getByRole('list', { name: 'Needs you' });
    expect(face.textContent).toBe('!Check the keyboard hidesDid it work?YesNo');
    expect(card.queryByText('Wait for #6618 to merge')).toBeNull();
    expect(card.queryByRole('button', { name: /^Mark done/ })).toBeNull();
    fireEvent.click(card.getByRole('button', { name: 'Details' }));
    expect(
      card.getByRole('list', { name: 'Done when' }).querySelector('[data-ask-item="i3"]')
        ?.textContent
    ).toBe('○Item i3added');
  });

  it('answers a human-only step’s result question from the card face', () => {
    const answer = vi.fn();
    const view = describeAsk(
      {
        ...ask('w', 'waiting', []),
        doneItems: [item('i2', 'needs_you', { text: 'Check the keyboard hides', kind: 'action' })],
      },
      [],
      {
        humanActions: [
          {
            kind: 'answer',
            itemId: 'i2',
            step: 'Check the keyboard hides',
            question: 'Did it work?',
            options: ['Yes', 'No'],
          },
        ],
      }
    );
    const card = render(<NeoAskCard view={view} onAnswer={answer} />);
    fireEvent.click(card.getByRole('button', { name: 'Answer Did it work?: Yes' }));
    expect(answer).toHaveBeenCalledExactlyOnceWith('i2', 'Yes');
    cleanup();
    const busy = render(<NeoAskCard view={view} onAnswer={answer} disabled />);
    expect(
      (busy.getByRole('button', { name: 'Answer Did it work?: No' }) as HTMLButtonElement).disabled
    ).toBe(true);
  });

  it('confirms a reported claim only when the daemon offers it', () => {
    const done = vi.fn();
    const reported = item('i2', 'reported', { text: 'The iMac runs the fix' });
    const view = describeAsk({ ...ask('w', 'open', []), doneItems: [reported] }, [], {
      humanActions: [{ kind: 'confirm', itemId: 'i2', step: 'The iMac runs the fix' }],
    });
    const card = render(<NeoAskCard view={view} onDone={done} />);
    fireEvent.click(card.getByRole('button', { name: 'Confirm: The iMac runs the fix' }));
    expect(done).toHaveBeenCalledExactlyOnceWith('i2');
    cleanup();
    const none = render(
      <NeoAskCard
        view={describeAsk({ ...ask('w', 'open', []), doneItems: [reported] }, [])}
        onDone={done}
      />
    );
    expect(none.queryByRole('button', { name: /^Confirm/ })).toBeNull();
  });

  it('answers a decision with its options in one place and points the checklist there', () => {
    const answer = vi.fn();
    const inChat = vi.fn();
    const decision = item('i2', 'needs_you', {
      text: 'Assign #6545?',
      options: ['Assign it', 'Leave it'],
    });
    const view = describeAsk({ ...ask('w', 'waiting', []), doneItems: [decision] }, [], {
      humanActions: [
        {
          kind: 'answer',
          itemId: 'i2',
          step: null,
          question: 'Assign #6545?',
          options: ['Assign it', 'Leave it'],
        },
      ],
      answer: {
        itemId: 'i2',
        question: 'Assign #6545?',
        label: 'Answer in chat',
        options: ['Assign it', 'Leave it'],
      },
    });
    const card = render(
      <NeoAskCard view={view} onAnswer={answer} onAnswerInChat={inChat} onDone={vi.fn()} />
    );
    fireEvent.click(card.getByRole('button', { name: 'Answer Assign #6545?: Leave it' }));
    expect(answer).toHaveBeenCalledExactlyOnceWith('i2', 'Leave it');
    expect(card.queryByRole('button', { name: 'Mark done: Assign #6545?' })).toBeNull();
    expect(card.queryByRole('button', { name: 'Answer in chat' })).toBeNull();
    fireEvent.click(card.getByRole('button', { name: 'Details' }));
    const questions = within(card.getByRole('list', { name: 'Questions' }));
    expect(questions.getByText('Assign #6545?')).toBeTruthy();
    expect(questions.getByRole('button', { name: 'Answer above' })).toBeTruthy();
    expect(questions.queryByRole('button', { name: /Leave it/ })).toBeNull();
    expect(card.getAllByRole('button', { name: /: Leave it$/ })).toHaveLength(1);
  });

  it('counts only daemon- or human-checked outcomes as verified and keeps decisions out of the count', () => {
    const view = describeAsk(
      {
        ...ask('a', 'open', []),
        doneItems: [
          item('i1', 'met', { metBy: 'daemon' }),
          item('i2', 'met', { metBy: 'human' }),
          item('i3', 'met', { metBy: 'neo' }),
          item('i4', 'needs_you', { decision: true }),
        ],
      },
      []
    );
    const card = render(<NeoAskCard view={view} />);
    expect(card.getByText('2 of 3 outcomes verified')).toBeTruthy();
    fireEvent.click(card.getByRole('button', { name: 'Details' }));
    const done = within(card.getByRole('list', { name: 'Done when' }));
    expect(done.getByText('Neo says done, not verified')).toBeTruthy();
    expect(done.getByText('confirmed by you')).toBeTruthy();
    expect(within(card.getByRole('list', { name: 'Questions' })).getByText('Item i4')).toBeTruthy();
  });

  it('points a reported question at its Confirm control, not an answer', () => {
    const view = describeAsk(
      {
        ...ask('w', 'waiting', []),
        doneItems: [item('i2', 'reported', { text: 'Ship it?', kind: 'decision' })],
      },
      [],
      { humanActions: [{ kind: 'confirm', itemId: 'i2', step: 'Ship it?' }] }
    );
    const card = render(<NeoAskCard view={view} onDone={vi.fn()} />);
    fireEvent.click(card.getByRole('button', { name: 'Details' }));
    const questions = within(card.getByRole('list', { name: 'Questions' }));
    expect(questions.getByRole('button', { name: 'Confirm above' })).toBeTruthy();
    expect(questions.queryByRole('button', { name: 'Answer above' })).toBeNull();
  });

  it('keeps Answer in chat when a question has no options to tap', () => {
    const inChat = vi.fn();
    const view = describeAsk(
      {
        ...ask('w', 'waiting', []),
        doneItems: [item('i2', 'needs_you', { text: 'Which repo?', kind: 'decision' })],
      },
      [],
      {
        humanActions: [
          { kind: 'answer', itemId: 'i2', step: null, question: 'Which repo?', options: [] },
        ],
        answer: { itemId: 'i2', question: 'Which repo?', label: 'Answer in chat', options: [] },
      }
    );
    const card = render(<NeoAskCard view={view} onAnswer={vi.fn()} onAnswerInChat={inChat} />);
    fireEvent.click(card.getByRole('button', { name: 'Answer in chat' }));
    expect(inChat).toHaveBeenCalledExactlyOnceWith('Which repo?');
  });

  it.each([
    [[], 'Approved'],
    [[{ kind: 'approve' as const, reason: 'expired' as const }], 'Approval expired'],
    [[{ kind: 'approve' as const, reason: 'stalled' as const, workIds: ['a1'] }], 'Stalled'],
  ])('labels approval from the current approve action: %j', (humanActions, label) => {
    const view = describeAsk({ ...ask('a', 'open', []), approvedAt: 1 }, [], { humanActions });
    const card = render(<NeoAskCard view={view} onApprove={vi.fn()} />);
    expect(card.getByText(label)).toBeTruthy();
    if (humanActions.length) {
      expect(card.queryByText('Approved')).toBeNull();
      expect(card.getByRole('button', { name: 'Approve again' })).toBeTruthy();
    }
  });

  it('approves an ask with proposed steps once, and marks it approved after', () => {
    const proposed = [...scenes.attention, ...scenes.running].filter(
      (scene) => scene.receipt.kind === 'work' && scene.receipt.status === 'proposed'
    );
    expect(proposed.length).toBeGreaterThan(0);
    const approve = vi.fn();
    const view = describeAsk(ask('b', 'open', ['b1']), proposed, {
      humanActions: [{ kind: 'start', workId: 'b1' }],
    });
    const card = render(<NeoAskCard view={view} onApprove={approve} />);
    fireEvent.click(card.getByRole('button', { name: 'Approve all steps' }));
    expect(approve).toHaveBeenCalledOnce();
    expect(card.queryByText('Approved')).toBeNull();
    cleanup();
    const approved = describeAsk({ ...ask('b', 'open', ['b1']), approvedAt: 5 }, proposed);
    const after = render(<NeoAskCard view={approved} onApprove={approve} />);
    expect(after.queryByRole('button', { name: 'Approve all steps' })).toBeNull();
    expect(after.getByText('Approved')).toBeTruthy();
    cleanup();
    const nothing = render(
      <NeoAskCard
        view={describeAsk(ask('a', 'open', ['a2']), scenes.running.slice(0, 1))}
        onApprove={approve}
      />
    );
    expect(nothing.queryByRole('button', { name: 'Approve all steps' })).toBeNull();
  });

  it('puts Retry on the card face when the daemon offers it for a failed step', () => {
    const retry = vi.fn();
    const owned = scenes.running.slice(0, 1);
    const id = owned[0].ref.id;
    const view = describeAsk(ask('a', 'open', [id]), owned, {
      humanActions: [{ kind: 'retry', workId: id }],
    });
    const card = render(<NeoAskCard view={view} onRetry={retry} />);
    const title = owned[0].receipt.kind === 'work' ? owned[0].receipt.title : '';
    fireEvent.click(card.getByRole('button', { name: `Retry ${title}` }));
    expect(retry).toHaveBeenCalledExactlyOnceWith(id);
    cleanup();
    const none = render(
      <NeoAskCard view={describeAsk(ask('a', 'open', [id]), owned)} onRetry={retry} />
    );
    expect(none.queryByRole('button', { name: /^Retry/ })).toBeNull();
  });

  it('reads an approval’s budget from the ask and offers Approve again only when the daemon asks', () => {
    expect(neoAskApproval(ask('a', 'open', []), [])).toBeNull();
    const approved = { ...ask('a', 'open', []), approvedAt: 5 };
    expect(neoAskApproval(approved, [])).toEqual({ line: '0 continues used', spent: false });
    const budget = {
      ...approved,
      approvedContinues: 3,
      approvedContinueLimit: 20,
      approvedUntil: 100,
    };
    expect(neoAskApproval(budget, [])).toEqual({ line: '3 of 20 continues used', spent: false });
    expect(neoAskApproval(budget, [{ kind: 'approve', reason: 'expired' }])).toEqual({
      line: '3 of 20 continues used · approval ran out',
      spent: true,
    });
    expect(
      neoAskApproval(budget, [{ kind: 'approve', reason: 'stalled', workIds: ['a1'] }])
    ).toEqual({ line: '3 of 20 continues used · a step stalled', spent: true });
    const approve = vi.fn();
    const counted = { ...budget, approvedContinues: 20, approvalSpent: 'continues' as const };
    const quiet = render(<NeoAskCard view={describeAsk(counted, [])} onApprove={approve} />);
    expect(quiet.queryByRole('button', { name: 'Approve again' })).toBeNull();
    cleanup();
    const expired = describeAsk({ ...counted, approvalSpent: 'expired' as const }, [], {
      humanActions: [{ kind: 'approve', reason: 'expired' }],
    });
    const card = render(<NeoAskCard view={expired} onApprove={approve} />);
    fireEvent.click(card.getByRole('button', { name: 'Approve again' }));
    expect(approve).toHaveBeenCalledOnce();
    fireEvent.click(card.getByRole('button', { name: 'Details' }));
    expect(card.getByText('20 of 20 continues used · approval ran out')).toBeTruthy();
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
