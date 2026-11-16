import type { NeoAskEntry, NeoQuestionEntry } from '@hyperneo/shared/types/neo-ask';
import type { NeoHumanQueue as Queue } from '@hyperneo/shared/types/neo-snapshot';
import { cleanup, fireEvent, render, within } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NeoHumanQueue } from '../NeoHumanQueue.tsx';
import { locale } from '../../lib/i18n/index.ts';

beforeEach(() => {
  locale.value = 'en';
});

afterEach(() => cleanup());

const question = (id: string, askId: string, patch: Partial<NeoQuestionEntry> = {}) =>
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
  ({ ask: { id, title, updatedAt: 1 }, todos: [], questions }) as unknown as NeoAskEntry;

const entries = [
  entry('trip', 'Plan the trip', [question('q1', 'trip'), question('q2', 'trip')]),
  entry('tax', 'File taxes', [question('q3', 'tax')]),
  entry('car', 'Service the car'),
];

const queue: Queue = {
  items: [
    {
      state: 'waiting',
      askId: 'trip',
      questionId: 'q1',
      text: 'Question q1',
      todos: [{ id: 't1', title: 'Book hotel' }],
    },
    { state: 'held', askId: 'trip', questionId: 'q2', text: 'Question q2', todos: [] },
    {
      state: 'waiting',
      askId: 'tax',
      questionId: 'q3',
      text: 'Question q3',
      todos: [{ id: 't3', title: 'Find receipts' }],
    },
    { state: 'progress', askId: 'car', todoId: 't4', title: 'Call the garage', owner: 'worker' },
    { state: 'progress', askId: 'trip', todoId: 't5', title: 'Pack bags', owner: 'human' },
  ],
  counts: {
    trip: { waiting: 1, held: 1, progress: 1 },
    tax: { waiting: 1, held: 0, progress: 0 },
    car: { waiting: 0, held: 0, progress: 1 },
  },
};

function show(onHold = vi.fn(), onAnswer = vi.fn()) {
  const view = render(
    <NeoHumanQueue queue={queue} entries={entries} onHold={onHold} onAnswer={onAnswer} />
  );
  const states = within(view.getByRole('group', { name: 'State' }));
  const asks = within(view.getByRole('group', { name: 'Ask' }));
  return { view, states, asks, onHold, onAnswer };
}

describe('NeoHumanQueue', () => {
  it('shows what waits on the human by default, grouped by ask, with counts', async () => {
    const { view, states } = show();
    expect(
      states.getByRole('button', { name: 'Waiting on you 2' }).getAttribute('aria-pressed')
    ).toBe('true');
    expect(states.getByRole('button', { name: 'Held 1' })).toBeTruthy();
    expect(states.getByRole('button', { name: 'In progress 2' })).toBeTruthy();
    const trip = within(view.getByRole('region', { name: 'Plan the trip' }));
    expect(await trip.findByText('Question q1')).toBeTruthy();
    expect(trip.getByText('Book hotel')).toBeTruthy();
    expect(trip.queryByText('Question q2')).toBeNull();
    expect(view.getByRole('region', { name: 'File taxes' })).toBeTruthy();
    expect(view.queryByRole('region', { name: 'Service the car' })).toBeNull();
  });

  it('answers a card and holds it with one button', () => {
    const { view, onHold, onAnswer } = show();
    const card = within(view.getByRole('region', { name: 'Plan the trip' }));
    fireEvent.click(card.getByRole('button', { name: 'Agree' }));
    expect(onAnswer).toHaveBeenCalledWith('q1', 'yes');
    fireEvent.click(card.getByRole('button', { name: 'Hold' }));
    expect(onHold).toHaveBeenCalledWith('q1', true);
  });

  it('lists held cards with a take-back button and says when a card is about the whole ask', async () => {
    const { view, states, onHold } = show();
    fireEvent.click(states.getByRole('button', { name: 'Held 1' }));
    const trip = within(view.getByRole('region', { name: 'Plan the trip' }));
    expect(await trip.findByText('Question q2')).toBeTruthy();
    expect(trip.getByText('The whole ask')).toBeTruthy();
    expect(trip.getByText('On hold')).toBeTruthy();
    expect(trip.queryByText('Awaiting your answer')).toBeNull();
    fireEvent.click(trip.getByRole('button', { name: 'Take back' }));
    expect(onHold).toHaveBeenCalledWith('q2', false);
  });

  it('shows work in progress with whose step it is', () => {
    const { view, states } = show();
    fireEvent.click(states.getByRole('button', { name: 'In progress 2' }));
    const car = within(view.getByRole('region', { name: 'Service the car' }));
    expect(car.getByText('Call the garage')).toBeTruthy();
    expect(car.getByText("A worker's step")).toBeTruthy();
    expect(
      within(view.getByRole('region', { name: 'Plan the trip' })).getByText('Your step')
    ).toBeTruthy();
  });

  it('filters by ask, and each row counts what follows the other choice', () => {
    const { view, states, asks } = show();
    expect(asks.getByRole('button', { name: 'All 2' }).getAttribute('aria-pressed')).toBe('true');
    expect(asks.getByRole('button', { name: 'Plan the trip 1' })).toBeTruthy();
    expect(asks.queryByRole('button', { name: /Service the car/ })).toBeNull();
    fireEvent.click(asks.getByRole('button', { name: 'Plan the trip 1' }));
    expect(view.queryByRole('region', { name: 'File taxes' })).toBeNull();
    expect(states.getByRole('button', { name: 'Waiting on you 1' })).toBeTruthy();
    fireEvent.click(states.getByRole('button', { name: 'In progress 1' }));
    expect(view.getByText('Pack bags')).toBeTruthy();
    expect(view.queryByText('Call the garage')).toBeNull();
  });

  it('keeps the chosen ask visible after a state switch empties it', () => {
    const { states, asks } = show();
    fireEvent.click(states.getByRole('button', { name: 'In progress 2' }));
    fireEvent.click(asks.getByRole('button', { name: 'Service the car 1' }));
    fireEvent.click(states.getByRole('button', { name: 'Waiting on you 0' }));
    expect(
      asks.getByRole('button', { name: 'Service the car 0' }).getAttribute('aria-pressed')
    ).toBe('true');
  });

  it('loads the full card before the human decides on a summarised ask', async () => {
    const full = 'Full report. '.repeat(300);
    const summarised = {
      ...entry('trip', 'Plan the trip', [
        question('q1', 'trip', { document: 'Preview\n\n[Document preview truncated]' }),
      ]),
      summary: {},
    } as unknown as NeoAskEntry;
    const detailed = entry('trip', 'Plan the trip', [question('q1', 'trip', { document: full })]);
    const onLoadDetails = vi.fn(async () => detailed);
    const view = render(
      <NeoHumanQueue
        queue={{ items: [queue.items[0]], counts: { trip: { waiting: 1, held: 0, progress: 0 } } }}
        entries={[summarised]}
        onHold={vi.fn()}
        onAnswer={vi.fn()}
        onLoadDetails={onLoadDetails}
      />
    );
    expect(onLoadDetails).toHaveBeenCalledWith('trip');
    expect(view.queryByRole('button', { name: 'Agree' })).toBeNull();
    fireEvent.click(await view.findByRole('button', { name: 'View full report' }));
    expect((await view.findByText(/Full report\./)).textContent).toBe(full);
  });

  it('keeps the card reply in chat', async () => {
    const onReply = vi.fn();
    const view = render(
      <NeoHumanQueue
        queue={queue}
        entries={entries}
        onHold={vi.fn()}
        onAnswer={vi.fn()}
        onReply={onReply}
      />
    );
    const trip = within(view.getByRole('region', { name: 'Plan the trip' }));
    fireEvent.click(trip.getByRole('button', { name: 'Reply in chat' }));
    expect(onReply).toHaveBeenCalledWith(expect.objectContaining({ id: 'q1' }));
  });

  it('reveals a card the conversation points at, whatever filter is on', async () => {
    const view = render(
      <NeoHumanQueue
        queue={queue}
        entries={entries}
        onHold={vi.fn()}
        onAnswer={vi.fn()}
        focusQuestionId="q2"
      />
    );
    const states = within(view.getByRole('group', { name: 'State' }));
    expect(states.getByRole('button', { name: 'Held 1' }).getAttribute('aria-pressed')).toBe(
      'true'
    );
    expect(await view.findByText('Question q2')).toBeTruthy();
  });

  it('shows nothing when nothing waits', () => {
    const view = render(
      <NeoHumanQueue
        queue={{ items: [], counts: {} }}
        entries={[]}
        onHold={vi.fn()}
        onAnswer={vi.fn()}
      />
    );
    expect(view.container.textContent).toBe('');
  });

  it('puts asks that do not fit under More', () => {
    const many: Queue = {
      items: Array.from({ length: 6 }, (_, i) => ({
        state: 'waiting' as const,
        askId: `a${i}`,
        questionId: `q${i}`,
        text: `Question ${i}`,
        todos: [],
      })),
      counts: Object.fromEntries(
        Array.from({ length: 6 }, (_, i) => [`a${i}`, { waiting: 1, held: 0, progress: 0 }])
      ),
    };
    const view = render(
      <NeoHumanQueue
        queue={many}
        entries={Array.from({ length: 6 }, (_, i) => entry(`a${i}`, `Ask ${i}`))}
        onHold={vi.fn()}
        onAnswer={vi.fn()}
      />
    );
    const asks = within(view.getByRole('group', { name: 'Ask' }));
    expect(asks.getAllByRole('button')).toHaveLength(4);
    const more = asks.getByRole('combobox', { name: 'More' });
    fireEvent.change(more, { target: { value: 'a5' } });
    expect(view.getAllByRole('region')).toHaveLength(1);
    expect(view.getByRole('region', { name: 'Ask 5' })).toBeTruthy();
  });
});
