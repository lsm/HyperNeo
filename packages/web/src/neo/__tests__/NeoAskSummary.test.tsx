import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NeoAskSummaryLine, neoAskSummaryLine, projectNeoAskSummary } from '../NeoAskSummary.tsx';
import type { NeoAskGroups, NeoAskView } from '../neo-asks.ts';
import type { NeoSceneCards } from '../neo-scenes.ts';
import { revealNeoAsk } from '../reveal-work.ts';
import { testCard } from './neo-test-views.ts';

afterEach(cleanup);

const view = (id: string, group: NeoAskView['group'], workIds: string[] = [], settled = false) =>
  ({
    ask: { id, title: `Ask ${id}` },
    group,
    settled,
    scenes: workIds.map((workId) => ({ ref: { kind: 'work', id: workId } })),
  }) as unknown as NeoAskView;
const groups = (...views: NeoAskView[]): NeoAskGroups =>
  ({
    asks: {
      attention: views.filter((item) => item.group === 'attention'),
      running: views.filter((item) => item.group === 'running'),
      outcomes: views.filter((item) => item.group === 'outcomes'),
    },
    loose: { attention: [], running: [], outcomes: [] },
    settledWork: new Set(),
  }) as NeoAskGroups;
const prCard = (workId: string, label: string) =>
  testCard(
    { id: workId, status: 'reported', sessionId: null },
    {
      phase: 'pr_open',
      pr: { number: '#1', label, count: 1, inProgress: true, setback: false, merged: [] },
    }
  );

describe('projectNeoAskSummary', () => {
  it('counts live asks and what their cards wait on, leaving finished asks out', () => {
    const cards: NeoSceneCards = new Map([
      ['w1', prCard('w1', 'Waiting on CI · #1')],
      ['w2', prCard('w2', 'Waiting on review · #2')],
    ]);
    const summary = projectNeoAskSummary(
      groups(
        view('a', 'running', ['w1']),
        view('b', 'running', ['w2']),
        view('c', 'attention'),
        view('d', 'outcomes', [], true)
      ),
      cards
    );
    expect(summary).toEqual({
      line: 'Two asks running · one needs you · one waiting on CI · one waiting on review',
      asks: [
        { id: 'c', title: 'Ask c' },
        { id: 'a', title: 'Ask a' },
        { id: 'b', title: 'Ask b' },
      ],
    });
  });

  it('shows nothing when no ask is live', () => {
    expect(projectNeoAskSummary(groups(view('d', 'outcomes', [], true)), new Map())).toBeNull();
  });
});

describe('neoAskSummaryLine', () => {
  it('says asks need you when none are running', () => {
    expect(neoAskSummaryLine({ running: 0, needsYou: 2, ci: 0, review: 0 })).toBe(
      'Two asks need you'
    );
    expect(neoAskSummaryLine({ running: 12, needsYou: 0, ci: 0, review: 0 })).toBe(
      '12 asks running'
    );
  });
});

describe('NeoAskSummaryLine', () => {
  it('links each live ask to its card', () => {
    const open = vi.fn();
    render(
      <NeoAskSummaryLine
        summary={{ line: 'One ask running', asks: [{ id: 'a', title: 'Ship it' }] }}
        onOpenAsk={open}
      />
    );
    expect(screen.getByRole('navigation', { name: 'Live asks' }).textContent).toContain(
      'One ask running'
    );
    fireEvent.click(screen.getByRole('button', { name: 'Ship it' }));
    expect(open).toHaveBeenCalledExactlyOnceWith('a');
  });
});

describe('revealNeoAsk', () => {
  it('scrolls to and flashes the ask card', () => {
    const root = document.createElement('div');
    root.innerHTML = '<article data-ask="a"></article>';
    const target = root.querySelector('article') as HTMLElement;
    target.scrollIntoView = vi.fn();
    const later = vi.fn();
    expect(revealNeoAsk(root, 'a', later)).toBe(true);
    expect(target.scrollIntoView).toHaveBeenCalledOnce();
    expect(target.classList.contains('ring-accent')).toBe(true);
    expect(revealNeoAsk(root, 'missing', later)).toBe(false);
  });
});
