import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import type { NeoAsk } from '@hyperneo/shared/types/neo-snapshot';
import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NeoAskCard } from '../NeoAskCard.tsx';
import { describeNeoAsk, groupNeoAsks, NEO_ASK_NEEDS_YOU_LABEL } from '../neo-asks.ts';
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
      [ask('a', 'waiting', ['a1', 'a2']), ask('b', 'open', ['b1']), ask('c', 'achieved', ['c1'])],
      scenes
    );
    expect(
      grouped.asks.running.map((view) => [view.ask.id, view.label, view.done, view.total])
    ).toEqual([['a', 'Waiting on checks or review', 1, 2]]);
    expect(grouped.asks.attention.map((view) => [view.ask.id, view.label])).toEqual([
      ['b', NEO_ASK_NEEDS_YOU_LABEL],
    ]);
    expect(grouped.asks.outcomes.map((view) => [view.ask.id, view.label])).toEqual([['c', 'Done']]);
    expect(grouped.loose.running.map((scene) => scene.ref.id)).toEqual(['loose']);
    expect(grouped.loose.attention).toEqual([]);
    expect(grouped.loose.outcomes).toEqual([]);
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
    expect([settled.group, settled.label]).toEqual(['outcomes', 'Dropped']);
  });
});

describe('NeoAskCard', () => {
  it('shows progress, the done definition and its steps on demand', () => {
    const view = describeNeoAsk(ask('a', 'waiting', ['a1', 'a2']), scenes.running.slice(0, 1));
    const card = render(
      <NeoAskCard view={view}>
        <p>Step card</p>
      </NeoAskCard>
    );
    expect(card.getByText('Waiting on checks or review')).toBeTruthy();
    expect(card.getByText('0 of 2 done')).toBeTruthy();
    expect(card.getByText('Merged to dev with CI green')).toBeTruthy();
    expect(card.queryByText('Step card')).toBeNull();
    fireEvent.click(card.getByRole('button', { name: 'Show steps · 1' }));
    expect(card.getByText('Step card')).toBeTruthy();
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
