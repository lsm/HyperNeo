import type { NeoAskEntry, NeoQuestionEntry } from '@hyperneo/shared/types/neo-ask';
import type { NeoHumanQueue as Queue } from '@hyperneo/shared/types/neo-snapshot';
import { cleanup, fireEvent, render, within } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NeoHumanQueue } from '../NeoHumanQueue.tsx';

afterEach(cleanup);

const card = (id: string, askId: string, patch: Partial<NeoQuestionEntry> = {}) =>
  ({
    id,
    askId,
    text: `Question ${id}`,
    kind: 'yesno',
    options: null,
    multiple: false,
    noLabel: 'No',
    yesLabel: 'Agree',
    todos: [],
    state: 'open',
    answer: null,
    answeredBy: null,
    answeredAt: null,
    retiredReason: null,
    replacedBy: null,
    createdAt: 1,
    ...patch,
  }) as NeoQuestionEntry;

const entry = (id: string, title: string, questions: NeoQuestionEntry[] = []) =>
  ({ ask: { id, title }, questions }) as unknown as NeoAskEntry;

const queue: Queue = {
  items: [
    {
      state: 'waiting',
      askId: 'a1',
      questionId: 'q1',
      text: 'Question q1',
      todos: [{ id: 't1', title: 'Ship the build' }],
    },
    { state: 'waiting', askId: 'a2', questionId: 'q2', text: 'Question q2', todos: [] },
    {
      state: 'held',
      askId: 'a1',
      questionId: 'q3',
      text: 'Question q3',
      todos: [{ id: 't2', title: 'Pick a name' }],
    },
    { state: 'progress', askId: 'a2', todoId: 't3', title: 'Write docs', owner: 'worker' },
  ],
  counts: {
    a1: { waiting: 1, held: 1, progress: 0 },
    a2: { waiting: 1, held: 0, progress: 1 },
  },
};

const entries = [
  entry('a1', 'Release', [card('q1', 'a1'), card('q3', 'a1', { heldAt: 5 })]),
  entry('a2', 'Docs', [card('q2', 'a2')]),
];

function show(props: Partial<Parameters<typeof NeoHumanQueue>[0]> = {}) {
  return render(
    <NeoHumanQueue
      queue={queue}
      entries={entries}
      onAnswer={vi.fn()}
      onHold={vi.fn()}
      {...props}
    />
  );
}

const states = (view: ReturnType<typeof show>) =>
  within(view.getByRole('group', { name: 'State' }))
    .getAllByRole('button')
    .map((button) => `${button.textContent}${button.getAttribute('aria-pressed') === 'true' ? '*' : ''}`);

describe('NeoHumanQueue', () => {
  it('opens on what waits on you across all asks, grouped by ask', () => {
    const view = show();
    expect(states(view)).toEqual(['Waiting on you 2*', 'Held 1', 'In progress 1']);
    const asks = within(view.getByRole('group', { name: 'Ask' })).getAllByRole('button');
    expect(asks.map((button) => button.textContent)).toEqual(['All 2', 'Release 1', 'Docs 1']);
    const groups = view.getAllByRole('region').map((group) => group.getAttribute('aria-label'));
    expect(groups).toEqual(['Release', 'Docs']);
    expect(view.getByText('Question q1')).toBeTruthy();
    expect(view.getByText('About: Ship the build')).toBeTruthy();
    expect(view.getByText('About the whole ask')).toBeTruthy();
    expect(view.queryByText('Question q3')).toBeNull();
  });

  it('answers a waiting card from its agree button', () => {
    const onAnswer = vi.fn();
    const view = show({ onAnswer });
    const item = view.getByRole('region', { name: 'Release' });
    fireEvent.click(within(item).getByRole('button', { name: 'Agree' }));
    expect(onAnswer).toHaveBeenCalledWith('q1', 'yes');
  });

  it('puts a card aside with one Hold button and takes a held card back', () => {
    const onHold = vi.fn();
    const view = show({ onHold });
    fireEvent.click(within(view.getByRole('region', { name: 'Release' })).getByRole('button', { name: 'Hold' }));
    expect(onHold).toHaveBeenLastCalledWith('q1', true);
    fireEvent.click(view.getByRole('button', { name: 'Held 1' }));
    expect(view.getByText('Question q3')).toBeTruthy();
    fireEvent.click(view.getByRole('button', { name: 'Take back' }));
    expect(onHold).toHaveBeenLastCalledWith('q3', false);
  });

  it('shows in-progress todos with whose step they are', () => {
    const view = show();
    fireEvent.click(view.getByRole('button', { name: 'In progress 1' }));
    expect(view.getByText('Write docs')).toBeTruthy();
    expect(view.getByText('A worker is on it')).toBeTruthy();
    expect(view.queryByRole('button', { name: 'Hold' })).toBeNull();
  });

  it('filters by ask, and each row counts what the other row chose', () => {
    const view = show();
    fireEvent.click(view.getByRole('button', { name: 'Release 1' }));
    expect(states(view)).toEqual(['Waiting on you 1*', 'Held 1', 'In progress 0']);
    expect(view.queryByText('Question q2')).toBeNull();
    fireEvent.click(view.getByRole('button', { name: 'Held 1' }));
    const asks = within(view.getByRole('group', { name: 'Ask' })).getAllByRole('button');
    expect(asks.map((button) => button.textContent)).toEqual(['All 1', 'Release 1', 'Docs 0']);
  });

  it('keeps the ask row on one line and moves the rest under More', () => {
    const many: Queue = {
      items: ['a1', 'a2', 'a3', 'a4', 'a5'].map((askId, index) => ({
        state: 'waiting' as const,
        askId,
        questionId: `m${index}`,
        text: `Question m${index}`,
        todos: [],
      })),
      counts: Object.fromEntries(
        ['a1', 'a2', 'a3', 'a4', 'a5'].map((askId) => [askId, { waiting: 1, held: 0, progress: 0 }])
      ),
    };
    const view = show({
      queue: many,
      entries: ['a1', 'a2', 'a3', 'a4', 'a5'].map((id) => entry(id, `Ask ${id}`)),
    });
    const row = view.getByRole('group', { name: 'Ask' });
    expect(within(row).getAllByRole('button').map((button) => button.textContent)).toEqual([
      'All 5',
      'Ask a1 1',
      'Ask a2 1',
      'More',
    ]);
    fireEvent.click(within(row).getByRole('button', { name: 'More' }));
    fireEvent.click(view.getByRole('menuitem', { name: 'Ask a5 1' }));
    expect(view.getAllByRole('region').map((group) => group.getAttribute('aria-label'))).toEqual([
      'Ask a5',
    ]);
  });

  it('says so when nothing waits on you', () => {
    const view = show({ queue: { items: [], counts: {} } });
    expect(view.getByText('Nothing waits on you.')).toBeTruthy();
  });
});
