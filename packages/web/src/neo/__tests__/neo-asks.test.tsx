import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import type { NeoAsk } from '@hyperneo/shared/types/neo-snapshot';
import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NeoAskCard } from '../NeoAskCard.tsx';
import {
  describeNeoAsk,
  groupNeoAsks,
  NEO_ASK_NEEDS_YOU_LABEL,
  neoAskOpenTarget,
  neoAskSummary,
  neoSupersededAttempts,
} from '../neo-asks.ts';
import type { NeoConcernBoard } from '../neo-concern-board.ts';
import { classifyNeoScenes, groupNeoScenes } from '../neo-scenes.ts';

afterEach(cleanup);

type Receipt = NeoConcernBoard['receipts'][number];
const work = (id: string, status: NeoWork['status']): Receipt =>
  ({
    kind: 'work',
    id,
    requestKey: id,
    concernId: null,
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
  concernId: null,
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

describe('groupNeoAsks', () => {
  it('nests each ask’s cards under it and leaves the rest where they were', () => {
    const grouped = groupNeoAsks(
      [
        ask('a', 'open', ['a1', 'a2']),
        ask('b', 'open', ['b1']),
        ask('c', 'achieved', ['c1']),
        ask('w', 'waiting', []),
      ],
      scenes
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

  it('hides failed attempts a later attempt replaced, and marks the cards of settled asks', () => {
    const retried = groupNeoScenes(
      classifyNeoScenes([
        { ...work('f1', 'failed'), title: 'Fix it', createdAt: 1 } as Receipt,
        { ...work('f2', 'reported'), title: 'Fix it', createdAt: 2 } as Receipt,
        { ...work('lone', 'failed'), title: 'Only try', createdAt: 1 } as Receipt,
        work('c1', 'reported'),
      ])
    );
    const grouped = groupNeoAsks([ask('c', 'achieved', ['c1'])], retried);
    expect(grouped.loose.outcomes.map((scene) => scene.ref.id)).toEqual(['f2', 'lone']);
    expect([...grouped.settledWork]).toEqual(['c1']);
  });

  it('keeps every card loose when there are no asks', () => {
    const grouped = groupNeoAsks(undefined, scenes);
    expect(grouped.loose.running.map((scene) => scene.ref.id)).toEqual(['a2', 'loose']);
    expect(grouped.asks.running).toEqual([]);
  });
});

describe('describeNeoAsk', () => {
  it('counts cards the daemon has not sent yet, not cards still waiting on or stuck on a PR, and never raises a settled ask', () => {
    const view = describeNeoAsk(ask('a', 'open', ['a1', 'gone']), scenes.outcomes.slice(0, 1));
    expect([view.done, view.total]).toEqual([1, 2]);
    const waitingOnPr = { ...scenes.outcomes[0]!, group: 'running' as const };
    expect(describeNeoAsk(ask('a', 'waiting', ['a1']), [waitingOnPr]).done).toBe(0);
    const failing = new Map([
      [
        'a1',
        {
          workId: 'a1',
          waiting: false,
          prs: [
            {
              url: 'https://github.com/lsm/HyperNeo/pull/1',
              state: 'OPEN' as const,
              checks: 'failing' as const,
              review: 'none' as const,
            },
          ],
        },
      ],
    ]);
    expect(
      describeNeoAsk(ask('a', 'open', ['a1']), scenes.outcomes.slice(0, 1), failing).done
    ).toBe(0);
    const settled = describeNeoAsk(ask('b', 'abandoned', ['b1']), scenes.attention);
    expect([settled.group, settled.label, settled.settled]).toEqual(['outcomes', 'Dropped', true]);
    const attempts = classifyNeoScenes([
      { ...work('x1', 'failed'), title: 'Same', createdAt: 1 } as Receipt,
      { ...work('x2', 'cancelled'), title: 'Same', createdAt: 2 } as Receipt,
      { ...work('x3', 'reported'), title: 'Same', createdAt: 3 } as Receipt,
    ]);
    const retried = describeNeoAsk(ask('x', 'open', ['x1', 'x2', 'x3']), attempts);
    expect([retried.done, retried.total, retried.scenes.map((scene) => scene.ref.id)]).toEqual([
      1,
      1,
      ['x3'],
    ]);
  });
});

describe('neoSupersededAttempts', () => {
  it('names failed cards whose title a later card reuses', () => {
    const scenes = classifyNeoScenes([
      { ...work('a', 'failed'), title: 'Audit', createdAt: 1 } as Receipt,
      { ...work('b', 'failed'), title: 'Audit ', createdAt: 2 } as Receipt,
      { ...work('c', 'failed'), title: 'Audit', createdAt: 3 } as Receipt,
      { ...work('d', 'reported'), title: 'Other', createdAt: 0 } as Receipt,
    ]);
    expect([...neoSupersededAttempts(scenes)]).toEqual(['a', 'b']);
  });
});

describe('neoAskSummary', () => {
  const long = `All doneWhen items met, live-verified on GitHub: ${'evidence '.repeat(30)}`;
  const merged = new Map([
    [
      'a1',
      {
        workId: 'a1',
        waiting: false,
        prs: [
          {
            url: 'https://github.com/lsm/HyperNeo/pull/6071',
            state: 'MERGED' as const,
            checks: 'passing' as const,
            review: 'approved' as const,
          },
        ],
      },
    ],
  ]);

  it('keeps a short outcome, names the merged PRs for a long one, and else cuts to one sentence', () => {
    expect(neoAskSummary(ask('a', 'achieved', ['a1']), scenes.outcomes)).toBe('Merged in #12.');
    const verbose = { ...ask('a', 'achieved', ['a1']), outcome: long };
    expect(neoAskSummary(verbose, scenes.outcomes, merged)).toBe('Merged in #6071.');
    expect(
      neoAskSummary({ ...verbose, outcome: `Shipped the fix. ${long}` }, scenes.outcomes)
    ).toBe('Shipped the fix.');
    const cut = neoAskSummary(verbose, scenes.outcomes) ?? '';
    expect([cut.length, cut.endsWith('…')]).toEqual([160, true]);
    expect(neoAskSummary(ask('b', 'open', []), [])).toBeNull();
  });
});

describe('neoAskOpenTarget', () => {
  const receipt = (id: string, status: NeoWork['status'], sessionId: string | null) =>
    ({ ...(work(id, status) as NeoWork), sessionId, kind: 'work' }) as Receipt;
  const driver = (id: string, link: string | null) => ({
    workId: id,
    adapter: 'claude-desktop',
    daemon: null,
    status: 'running' as const,
    link,
  });
  const target = (receipts: Receipt[], drivers = new Map<string, ReturnType<typeof driver>>()) => {
    const view = describeNeoAsk(
      ask(
        'a',
        'open',
        receipts.map((item) => item.id)
      ),
      classifyNeoScenes(receipts)
    );
    const found = neoAskOpenTarget(view, drivers);
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
        new Map([['run', driver('run', 'claude://claude.ai/epitaxy/run')]])
      )
    ).toEqual(['run', 'claude://claude.ai/epitaxy/run']);
    expect(
      target([receipt('old', 'reported', 'old-session'), receipt('new', 'reported', 'new-session')])
    ).toEqual(['new', null]);
    expect(
      target(
        [receipt('old', 'reported', 'old-session'), receipt('run', 'queued', null)],
        new Map([['run', driver('run', 'javascript:alert(1)')]])
      )
    ).toEqual(['old', null]);
    expect(target([receipt('p', 'proposed', null)])).toBeNull();
  });
});

describe('NeoAskCard', () => {
  it('shows progress and names its card, and keeps the done definition and the full card behind Details', () => {
    const view = describeNeoAsk(ask('a', 'waiting', ['a1', 'a2']), scenes.running.slice(0, 1));
    const card = render(<NeoAskCard view={view} renderCard={() => <p>Step card</p>} />);
    expect(card.container.querySelector('[data-ask-step]')?.textContent).toBe(
      '●Card a2Handed to HyperNeo'
    );
    expect(card.getByText('Waiting on you')).toBeTruthy();
    expect(card.getByText('0 of 2 done')).toBeTruthy();
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
    const view = describeNeoAsk(ask('a', 'open', ['a1', 'a2', 'b1']), owned);
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
      ['a1', '✓Card a1Response ready'],
      ['a2', '●Card a2Handed to HyperNeo'],
    ]);
    expect(rendered).toEqual(['b1']);
    expect(card.getByText('Full b1')).toBeTruthy();
  });

  it('opens the ask’s current card in its app or in chat', () => {
    const queued = { ...(work('a2', 'queued') as NeoWork), sessionId: null };
    const linked = groupNeoScenes(classifyNeoScenes([{ ...queued, kind: 'work' }])).running;
    const driver = {
      workId: 'a2',
      adapter: 'codex-desktop',
      daemon: null,
      status: 'running' as const,
      link: 'codex://threads/t1',
    };
    const view = describeNeoAsk(ask('a', 'open', ['a2']), linked);
    const app = render(<NeoAskCard view={view} drivers={new Map([['a2', driver]])} />);
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
        view={describeNeoAsk(ask('c', 'achieved', ['c1']), scenes.outcomes.slice(1))}
        onOpen={open}
      />
    );
    fireEvent.click(chat.getByRole('button', { name: 'Open Ask c' }));
    expect(open).toHaveBeenCalledExactlyOnceWith('c1');
    expect(chat.getByRole('button', { name: 'Open Ask c' }).textContent).toBe('Open chat');
    cleanup();
    const unstarted = render(
      <NeoAskCard view={describeNeoAsk(ask('b', 'open', ['b1']), scenes.attention)} onOpen={open} />
    );
    expect(unstarted.queryByRole('button', { name: 'Open Ask b' })).toBeNull();
  });

  it('drops the count once settled and keeps a long outcome behind Details', () => {
    const outcome = `Merged after review. ${'evidence '.repeat(30)}`;
    const view = describeNeoAsk(
      { ...ask('c', 'achieved', ['c1']), outcome },
      scenes.outcomes.slice(1)
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
        <NeoAskCard view={describeNeoAsk(ask('a', 'open', []), [])} onSettle={settle} />
      );
      fireEvent.click(card.getByRole('button', { name: 'Ask actions' }));
      fireEvent.click(screen.getByRole('menuitem', { name: item }));
      cleanup();
    }
    expect(settle.mock.calls).toEqual([['achieved'], ['abandoned']]);
    const settled = render(
      <NeoAskCard view={describeNeoAsk(ask('c', 'achieved', []), [])} onSettle={settle} />
    );
    expect(settled.queryByRole('button', { name: 'Ask actions' })).toBeNull();
  });
});
