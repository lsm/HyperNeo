import type { NeoAskEntry, NeoQuestionEntry } from '@hyperneo/shared/types/neo-ask';
import type { NeoHumanQueue as Queue } from '@hyperneo/shared/types/neo-snapshot';
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NeoAskTodos } from '../NeoAskTodos.tsx';
import { NeoHumanQueue } from '../NeoHumanQueue.tsx';
import { locale } from '../../lib/i18n/index.ts';
import { testAskEntry, testTodo } from './neo-test-views.ts';

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
  ({
    ask: { id, title, updatedAt: 1 },
    todos: [],
    questions,
  }) as unknown as NeoAskEntry;

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
        focus={{ askId: 'trip', questionId: 'q2' }}
      />
    );
    const states = within(view.getByRole('group', { name: 'State' }));
    expect(states.getByRole('button', { name: 'Held 1' }).getAttribute('aria-pressed')).toBe(
      'true'
    );
    expect(await view.findByText('Question q2')).toBeTruthy();
  });

  it('says when the full card failed to load, retries, and only then offers a decision', async () => {
    const summarised = {
      ...entry('trip', 'Plan the trip', [question('q1', 'trip', { document: 'Preview' })]),
      summary: {},
    } as unknown as NeoAskEntry;
    const detailed = entry('trip', 'Plan the trip', [question('q1', 'trip')]);
    const onLoadDetails = vi
      .fn<(askId: string) => Promise<NeoAskEntry>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(detailed);
    const props = {
      queue: { items: [queue.items[0]], counts: { trip: { waiting: 1, held: 0, progress: 0 } } },
      onHold: vi.fn(),
      onAnswer: vi.fn(),
      onLoadDetails,
    };
    const view = render(<NeoHumanQueue {...props} entries={[summarised]} />);
    expect(await view.findByText('Couldn’t load the full card.')).toBeTruthy();
    expect(view.queryByRole('button', { name: 'Agree' })).toBeNull();
    view.rerender(<NeoHumanQueue {...props} entries={[{ ...summarised }]} />);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(onLoadDetails).toHaveBeenCalledTimes(1);
    view.rerender(
      <NeoHumanQueue {...props} queue={{ ...props.queue }} entries={[{ ...summarised }]} />
    );
    await waitFor(() => expect(onLoadDetails).toHaveBeenCalledTimes(2));
    expect(await view.findByText('Couldn’t load the full card.')).toBeTruthy();
    fireEvent.click(view.getByRole('button', { name: 'Retry' }));
    expect(await view.findByRole('button', { name: 'Agree' })).toBeTruthy();
    expect(onLoadDetails).toHaveBeenCalledTimes(3);
    expect(view.queryByText('Couldn’t load the full card.')).toBeNull();
  });

  it.each([
    [{ askId: 'car', todoId: 't4' }, 'In progress 2', 'neo-ref-todo-t4'],
    [{ askId: 'trip', todoId: 't1' }, 'Waiting on you 2', 'neo-ref-todo-t1'],
    [{ askId: 'trip', questionId: 'q2' }, 'Held 1', 'neo-ref-question-q2'],
    [{ askId: 'car' }, 'In progress 2', 'neo-ref-ask-car'],
  ])('reveals and focuses the referenced %o', async (focus, chip, anchor) => {
    const view = render(
      <NeoHumanQueue
        queue={queue}
        entries={entries}
        onHold={vi.fn()}
        onAnswer={vi.fn()}
        focus={focus}
      />
    );
    const states = within(view.getByRole('group', { name: 'State' }));
    expect(states.getByRole('button', { name: chip }).getAttribute('aria-pressed')).toBe('true');
    await waitFor(() => expect(document.activeElement?.id).toBe(anchor));
  });

  it('loads an ask the snapshot left out, so its card has a title and can be answered', async () => {
    const onLoadDetails = vi.fn(async () => entry('far', 'Far ask', [question('qf', 'far')]));
    const view = render(
      <NeoHumanQueue
        queue={{
          items: [
            { state: 'waiting', askId: 'far', questionId: 'qf', text: 'Question qf', todos: [] },
          ],
          counts: { far: { waiting: 1, held: 0, progress: 0 } },
        }}
        entries={[]}
        onHold={vi.fn()}
        onAnswer={vi.fn()}
        onLoadDetails={onLoadDetails}
      />
    );
    expect(onLoadDetails).toHaveBeenCalledWith('far');
    const far = within(await view.findByRole('region', { name: 'Far ask' }));
    expect(await far.findByRole('button', { name: 'Agree' })).toBeTruthy();
  });

  it('reads an omitted ask again when the queue names a card its loaded copy lacks', async () => {
    const onLoadDetails = vi
      .fn<(askId: string) => Promise<NeoAskEntry>>()
      .mockResolvedValueOnce(entry('far', 'Far ask', [question('q1', 'far')]))
      .mockResolvedValue(entry('far', 'Far ask', [question('q2', 'far', { text: 'Second' })]));
    const queued = (questionId: string) => ({
      items: [{ state: 'waiting' as const, askId: 'far', questionId, text: questionId, todos: [] }],
      counts: { far: { waiting: 1, held: 0, progress: 0 } },
    });
    const props = { entries: [], onHold: vi.fn(), onAnswer: vi.fn(), onLoadDetails };
    const view = render(<NeoHumanQueue {...props} queue={queued('q1')} />);
    expect(await view.findByText('Question q1')).toBeTruthy();
    view.rerender(<NeoHumanQueue {...props} entries={[]} queue={queued('q2')} />);
    await waitFor(() => expect(onLoadDetails).toHaveBeenCalledTimes(2));
    expect(await view.findByText('Second')).toBeTruthy();
    expect(view.getByRole('button', { name: 'Agree' })).toBeTruthy();
  });

  it('keeps focus on a referenced card after its full copy loads', async () => {
    const scrolled: Element[] = [];
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this);
    };
    try {
      let release = (_: NeoAskEntry) => {};
      const onLoadDetails = vi.fn(() => new Promise<NeoAskEntry>((resolve) => (release = resolve)));
      const summarised = {
        ...entry('trip', 'Plan the trip', [question('q1', 'trip', { document: 'Preview' })]),
        summary: {},
      } as unknown as NeoAskEntry;
      const view = render(
        <NeoHumanQueue
          queue={{
            items: [queue.items[0]],
            counts: { trip: { waiting: 1, held: 0, progress: 0 } },
          }}
          entries={[summarised]}
          onHold={vi.fn()}
          onAnswer={vi.fn()}
          onLoadDetails={onLoadDetails}
          focus={{ askId: 'trip', questionId: 'q1' }}
        />
      );
      await waitFor(() => expect(document.activeElement?.id).toBe('neo-ref-question-q1'));
      const preview = document.activeElement;
      release(entry('trip', 'Plan the trip', [question('q1', 'trip')]));
      const agree = await view.findByRole('button', { name: 'Agree' });
      const card = agree.closest('[id="neo-ref-question-q1"]');
      expect(card).not.toBe(preview);
      await waitFor(() => expect(document.activeElement).toBe(card));
      expect(scrolled.at(-1)).toBe(card);
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });

  it('drops the ask filter when that ask leaves the queue', () => {
    const props = { entries, onHold: vi.fn(), onAnswer: vi.fn() };
    const view = render(<NeoHumanQueue {...props} queue={queue} />);
    const states = within(view.getByRole('group', { name: 'State' }));
    const asks = within(view.getByRole('group', { name: 'Ask' }));
    fireEvent.click(states.getByRole('button', { name: 'In progress 2' }));
    fireEvent.click(asks.getByRole('button', { name: 'Service the car 1' }));
    const { car: _car, ...counts } = queue.counts;
    view.rerender(
      <NeoHumanQueue
        {...props}
        queue={{ items: queue.items.filter((item) => item.askId !== 'car'), counts }}
      />
    );
    expect(asks.getByRole('button', { name: 'All 1' }).getAttribute('aria-pressed')).toBe('true');
    expect(states.getByRole('button', { name: 'Waiting on you 2' })).toBeTruthy();
    expect(view.getByText('Pack bags')).toBeTruthy();
  });

  it('reads an ask again when a newer snapshot arrives during its read', async () => {
    let first = (_: NeoAskEntry) => {};
    const onLoadDetails = vi
      .fn<(askId: string) => Promise<NeoAskEntry>>()
      .mockImplementationOnce(() => new Promise((resolve) => (first = resolve)))
      .mockResolvedValue(entry('far', 'Far ask', [question('q2', 'far', { text: 'Second' })]));
    const queued = (questionId: string) => ({
      items: [{ state: 'waiting' as const, askId: 'far', questionId, text: questionId, todos: [] }],
      counts: { far: { waiting: 1, held: 0, progress: 0 } },
    });
    const props = { onHold: vi.fn(), onAnswer: vi.fn(), onLoadDetails };
    const view = render(<NeoHumanQueue {...props} entries={[]} queue={queued('q1')} />);
    view.rerender(<NeoHumanQueue {...props} entries={[]} queue={queued('q2')} />);
    first(entry('far', 'Far ask', [question('q1', 'far')]));
    await waitFor(() => expect(onLoadDetails).toHaveBeenCalledTimes(2));
    expect(await view.findByText('Second')).toBeTruthy();
    expect(view.getByRole('button', { name: 'Agree' })).toBeTruthy();
  });

  it('gives a todo shared by two cards one anchor', () => {
    const shared: Queue = {
      items: ['q1', 'q2'].map((questionId) => ({
        state: 'waiting' as const,
        askId: 'trip',
        questionId,
        text: `Question ${questionId}`,
        todos: [{ id: 't1', title: 'Book hotel' }],
      })),
      counts: { trip: { waiting: 2, held: 0, progress: 0 } },
    };
    render(<NeoHumanQueue queue={shared} entries={entries} onHold={vi.fn()} onAnswer={vi.fn()} />);
    expect(document.querySelectorAll('[id="neo-ref-todo-t1"]')).toHaveLength(1);
  });

  it('reveals a reference once and leaves later snapshot changes alone', async () => {
    const props = { entries, onHold: vi.fn(), onAnswer: vi.fn() };
    const view = render(
      <NeoHumanQueue
        {...props}
        queue={queue}
        focus={{ askId: 'trip', questionId: 'q1' }}
        reveal={1}
      />
    );
    await waitFor(() => expect(document.activeElement?.id).toBe('neo-ref-question-q1'));
    const input = document.createElement('input');
    document.body.append(input);
    input.focus();
    const states = within(view.getByRole('group', { name: 'State' }));
    fireEvent.click(states.getByRole('button', { name: 'In progress 2' }));
    const held: Queue = {
      items: queue.items.map((item) =>
        'questionId' in item && item.questionId === 'q1' ? { ...item, state: 'held' } : item
      ),
      counts: { ...queue.counts, trip: { waiting: 0, held: 2, progress: 1 } },
    };
    view.rerender(
      <NeoHumanQueue
        {...props}
        queue={held}
        focus={{ askId: 'trip', questionId: 'q1' }}
        reveal={1}
      />
    );
    view.rerender(
      <NeoHumanQueue
        {...props}
        queue={held}
        focus={{ askId: 'trip', questionId: 'q2' }}
        reveal={1}
      />
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(document.activeElement).toBe(input);
    expect(states.getByRole('button', { name: 'In progress 2' }).getAttribute('aria-pressed')).toBe(
      'true'
    );
    view.rerender(
      <NeoHumanQueue
        {...props}
        queue={held}
        focus={{ askId: 'trip', questionId: 'q2' }}
        reveal={2}
      />
    );
    await waitFor(() => expect(document.activeElement?.id).toBe('neo-ref-question-q2'));
    input.remove();
  });

  it('offers no answer buttons for a card answered since the snapshot', () => {
    const view = render(
      <NeoHumanQueue
        queue={{ items: [queue.items[0]], counts: { trip: { waiting: 1, held: 0, progress: 0 } } }}
        entries={[entry('trip', 'Plan the trip', [question('q1', 'trip', { state: 'answered' })])]}
        onHold={vi.fn()}
        onAnswer={vi.fn()}
      />
    );
    expect(view.queryByRole('button', { name: 'Agree' })).toBeNull();
    expect(view.getByText('Question q1')).toBeTruthy();
  });

  it('treats a card the newer detail read shows answered as closed and refreshes the queue', async () => {
    const summarised = {
      ...entry('trip', 'Plan the trip', [question('q1', 'trip', { document: 'Preview' })]),
      summary: {},
    } as unknown as NeoAskEntry;
    const answered = entry('trip', 'Plan the trip', [
      question('q1', 'trip', { state: 'answered' }),
    ]);
    const onStale = vi.fn();
    const view = render(
      <NeoHumanQueue
        queue={{ items: [queue.items[0]], counts: { trip: { waiting: 1, held: 0, progress: 0 } } }}
        entries={[summarised]}
        onHold={vi.fn()}
        onAnswer={vi.fn()}
        onLoadDetails={async () => answered}
        onStale={onStale}
      />
    );
    await waitFor(() => expect(onStale).toHaveBeenCalledTimes(1));
    expect(view.getByText('Question q1')).toBeTruthy();
    for (const name of ['Agree', 'No', 'Hold', 'Reply in chat'])
      expect(view.queryByRole('button', { name })).toBeNull();
  });

  it('keeps a picked option while a newer ask revision reloads the card', async () => {
    const choice = (updatedAt: number) =>
      ({
        ask: { id: 'trip', title: 'Plan the trip', updatedAt },
        todos: [],
        questions: [
          question('q1', 'trip', { kind: 'choice', multiple: true, options: ['Train', 'Car'] }),
        ],
      }) as unknown as NeoAskEntry;
    const summarised = (updatedAt: number) =>
      ({ ...choice(updatedAt), summary: {} }) as unknown as NeoAskEntry;
    let second = (_: NeoAskEntry) => {};
    const onLoadDetails = vi
      .fn<(askId: string) => Promise<NeoAskEntry>>()
      .mockResolvedValueOnce(choice(1))
      .mockImplementationOnce(() => new Promise((resolve) => (second = resolve)));
    const props = {
      queue: { items: [queue.items[0]], counts: { trip: { waiting: 1, held: 0, progress: 0 } } },
      onHold: vi.fn(),
      onAnswer: vi.fn(),
      onLoadDetails,
    };
    const view = render(<NeoHumanQueue {...props} entries={[summarised(1)]} />);
    const train = (await view.findByText('Train')).closest('label')!.querySelector('input')!;
    fireEvent.click(train);
    expect(train.checked).toBe(true);
    view.rerender(<NeoHumanQueue {...props} entries={[summarised(2)]} />);
    await waitFor(() => expect(onLoadDetails).toHaveBeenCalledTimes(2));
    expect(train.isConnected).toBe(true);
    expect(train.checked).toBe(true);
    second(choice(2));
    await waitFor(() => expect(train.isConnected && train.checked).toBe(true));
  });

  it('lets the human take this computer back from an eligible in-progress todo', () => {
    const onDesktopControl = vi.fn();
    const car = {
      ...entry('car', 'Service the car'),
      todos: [
        testTodo('t4', { title: 'Call the garage', state: 'doing' }),
        testTodo('t6', {
          title: 'Remote step',
          state: 'doing',
          worker: { id: 'w', adapter: 'hyperneo', name: null, label: 'Remote', daemon: 'other' },
        }),
      ],
    } as NeoAskEntry;
    const view = render(
      <NeoHumanQueue
        queue={{
          items: [
            queue.items[3],
            {
              state: 'progress',
              askId: 'car',
              todoId: 't6',
              title: 'Remote step',
              owner: 'worker',
            },
          ],
          counts: { car: { waiting: 0, held: 0, progress: 2 } },
        }}
        entries={[car]}
        onHold={vi.fn()}
        onAnswer={vi.fn()}
        onDesktopControl={onDesktopControl}
      />
    );
    const label = 'Let the agent use this computer';
    fireEvent.click(view.getByRole('button', { name: 'In progress 2' }));
    expect(view.getByText('Remote step')).toBeTruthy();
    expect(view.queryByRole('checkbox', { name: label })).toBeNull();
    expect(view.queryByRole('button', { name: 'Show details: Remote step' })).toBeNull();
    const row = view.container.querySelector('[data-ask-todo="t4"]') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: 'Show details: Call the garage' }));
    const box = within(row).getByRole('checkbox', { name: label }) as HTMLInputElement;
    expect(box.checked).toBe(true);
    fireEvent.click(box);
    expect(onDesktopControl).toHaveBeenCalledWith('t4', false);
  });

  it('offers the desktop switch before the full read and enables it once loaded', async () => {
    const garage = testTodo('t4', { title: 'Call the garage', state: 'doing' });
    const summarised = {
      ...entry('car', 'Service the car'),
      todos: [garage],
      summary: {},
    } as unknown as NeoAskEntry;
    let load = (_: NeoAskEntry) => {};
    const view = render(
      <NeoHumanQueue
        queue={{ items: [queue.items[3]], counts: { car: { waiting: 0, held: 0, progress: 1 } } }}
        entries={[summarised]}
        onHold={vi.fn()}
        onAnswer={vi.fn()}
        onLoadDetails={() => new Promise((resolve) => (load = resolve))}
        onDesktopControl={vi.fn()}
      />
    );
    fireEvent.click(view.getByRole('button', { name: 'In progress 1' }));
    fireEvent.click(view.getByRole('button', { name: 'Show details: Call the garage' }));
    const box = view.getByRole('checkbox', {
      name: 'Let the agent use this computer',
    }) as HTMLInputElement;
    expect(box.disabled).toBe(true);
    load({
      ...entry('car', 'Service the car'),
      todos: [{ ...garage, named: { desktopControl: true } }],
    } as NeoAskEntry);
    await waitFor(() => expect(box.disabled).toBe(false));
    expect(box.checked).toBe(true);
  });

  it('says when an in-progress step failed to load and retries it', async () => {
    const garage = testTodo('t4', { title: 'Call the garage', state: 'doing' });
    const summarised = {
      ...entry('car', 'Service the car'),
      todos: [garage],
      summary: {},
    } as unknown as NeoAskEntry;
    const onLoadDetails = vi
      .fn<(askId: string) => Promise<NeoAskEntry>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue({ ...entry('car', 'Service the car'), todos: [garage] } as NeoAskEntry);
    const view = render(
      <NeoHumanQueue
        queue={{ items: [queue.items[3]], counts: { car: { waiting: 0, held: 0, progress: 1 } } }}
        entries={[summarised]}
        onHold={vi.fn()}
        onAnswer={vi.fn()}
        onLoadDetails={onLoadDetails}
        onDesktopControl={vi.fn()}
      />
    );
    fireEvent.click(view.getByRole('button', { name: 'In progress 1' }));
    fireEvent.click(view.getByRole('button', { name: 'Show details: Call the garage' }));
    expect((await view.findByRole('alert')).textContent).toContain('Couldn’t load this step.');
    const box = view.getByRole('checkbox', { name: 'Let the agent use this computer' });
    expect((box as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(view.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect((box as HTMLInputElement).disabled).toBe(false));
    expect(onLoadDetails).toHaveBeenCalledTimes(2);
    expect(view.queryByRole('alert')).toBeNull();
  });

  it('shows the full ask in place of its queued cards, titled once', () => {
    const view = render(
      <NeoHumanQueue
        queue={queue}
        entries={entries}
        onHold={vi.fn()}
        onAnswer={vi.fn()}
        renderAsk={(entry) => <p>Full ask {entry.ask.title}</p>}
      />
    );
    const trip = within(view.getByRole('region', { name: 'Plan the trip' }));
    expect(trip.getByText('Full ask Plan the trip')).toBeTruthy();
    expect(trip.queryByText('Book hotel')).toBeNull();
    expect(trip.queryByRole('heading', { name: 'Plan the trip' })).toBeNull();
    expect(view.getByText('Full ask File taxes')).toBeTruthy();
  });

  it('leaves the full ask to the scene card a reference already shows', () => {
    const props = {
      queue,
      entries,
      onHold: vi.fn(),
      onAnswer: vi.fn(),
      renderAsk: (entry: NeoAskEntry) => <p>Full ask {entry.ask.title}</p>,
    };
    const view = render(<NeoHumanQueue {...props} />);
    expect(view.getByText('Full ask Plan the trip')).toBeTruthy();
    view.rerender(<NeoHumanQueue {...props} focus={{ askId: 'trip', todoId: 'unqueued-step' }} />);
    const trip = within(view.getByRole('region', { name: 'Plan the trip' }));
    expect(view.queryByText('Full ask Plan the trip')).toBeNull();
    expect(trip.getByText('Book hotel')).toBeTruthy();
  });

  it('opens the full ask only from the validated read, never the summary', async () => {
    const summarised = {
      ...entry('trip', 'Plan the trip', [question('q1', 'trip', { document: 'Preview' })]),
      summary: {},
    } as unknown as NeoAskEntry;
    const detailed = entry('trip', 'Plan the trip', [question('q1', 'trip')]);
    let settle = { resolve: (_: NeoAskEntry) => {}, reject: (_: Error) => {} };
    const onLoadDetails = vi.fn(
      () =>
        new Promise<NeoAskEntry>((resolve, reject) => {
          settle = { resolve, reject };
        })
    );
    const view = render(
      <NeoHumanQueue
        queue={{ items: [queue.items[0]], counts: { trip: { waiting: 1, held: 0, progress: 0 } } }}
        entries={[summarised]}
        onHold={vi.fn()}
        onAnswer={vi.fn()}
        onLoadDetails={onLoadDetails}
        renderAsk={(shown) => <p>{shown.summary ? 'Summary ask' : 'Validated ask'}</p>}
      />
    );
    expect(view.queryByText('Summary ask')).toBeNull();
    settle.reject(new Error('offline'));
    expect(await view.findByText('Couldn’t load the full card.')).toBeTruthy();
    expect(view.queryByText('Summary ask')).toBeNull();
    fireEvent.click(view.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(onLoadDetails).toHaveBeenCalledTimes(2));
    settle.resolve(detailed);
    expect(await view.findByText('Validated ask')).toBeTruthy();
    expect(view.queryByText('Summary ask')).toBeNull();
  });

  it.each([false, true])(
    'keeps the open full ask, its unsent choice and its disabled controls while a newer revision loads, read failing first %s',
    async (failing) => {
      const choice = question('q1', 'trip', {
        kind: 'choice',
        options: ['iPhone', 'iPad'],
        multiple: true,
      });
      const at = (updatedAt: number, summary: boolean) => {
        const shown = testAskEntry('trip', 'Plan the trip', {
          state: 'waiting',
          questions: [choice],
          todos: [testTodo('t1', { askId: 'trip', title: 'Call the garage', state: 'doing' })],
        });
        return {
          ...shown,
          ask: { ...shown.ask, updatedAt },
          ...(summary ? { summary: {} } : {}),
        } as unknown as NeoAskEntry;
      };
      const reads: { resolve: (value: NeoAskEntry) => void; reject: (cause: Error) => void }[] = [];
      const props = {
        queue: { items: [queue.items[0]], counts: { trip: { waiting: 1, held: 0, progress: 0 } } },
        onHold: vi.fn(),
        onAnswer: vi.fn(),
        onLoadDetails: () =>
          new Promise<NeoAskEntry>((resolve, reject) => reads.push({ resolve, reject })),
        renderAsk: (shown: NeoAskEntry, refreshing?: boolean) => (
          <NeoAskTodos
            entry={shown}
            disabled={refreshing}
            onAnswer={vi.fn()}
            onDesktopControl={vi.fn()}
          />
        ),
      };
      const view = render(<NeoHumanQueue {...props} entries={[at(1, true)]} />);
      await waitFor(() => expect(reads).toHaveLength(1));
      reads[0].resolve(at(1, false));
      await view.findByRole('checkbox', { name: 'iPad' });
      const pick = () => view.getByRole('checkbox', { name: 'iPad' }) as HTMLInputElement;
      const confirm = () => view.getByRole('button', { name: 'Confirm' }) as HTMLButtonElement;
      const desktop = () => {
        if (!view.queryByRole('menuitem', { name: 'Stop letting it use this computer' }))
          fireEvent.click(view.getByRole('button', { name: 'Step actions: Call the garage' }));
        return view.getByRole('menuitem', {
          name: 'Stop letting it use this computer',
        }) as HTMLButtonElement;
      };
      fireEvent.click(pick());
      expect(desktop().disabled).toBe(false);
      view.rerender(<NeoHumanQueue {...props} entries={[at(2, true)]} />);
      await waitFor(() => expect(reads).toHaveLength(2));
      expect(pick().checked).toBe(true);
      expect(confirm().disabled).toBe(true);
      expect(desktop().disabled).toBe(true);
      if (failing) {
        reads[1].reject(new Error('offline'));
        const trip = within(view.getByRole('region', { name: 'Plan the trip' }));
        expect((await trip.findByRole('alert')).textContent).toContain(
          'Couldn’t load the full card.'
        );
        expect(pick().checked).toBe(true);
        expect(confirm().disabled).toBe(true);
        fireEvent.click(trip.getByRole('button', { name: 'Retry' }));
        await waitFor(() => expect(reads).toHaveLength(3));
      }
      reads.at(-1)!.resolve(at(2, false));
      await waitFor(() => expect(confirm().disabled).toBe(false));
      expect(desktop().disabled).toBe(false);
      expect(pick().checked).toBe(true);
      expect(view.queryByRole('alert')).toBeNull();
    }
  );

  it.each([
    [
      'a remote worker',
      { worker: { id: 'w', adapter: 'codex', name: null, label: 'Remote', daemon: 'remote' } },
      true,
    ],
    ['a todo the summary leaves out', {}, false],
  ])('says when the read for %s failed and retries it', async (_name, patch, listed) => {
    const garage = testTodo('t4', { title: 'Call the garage', state: 'doing', ...patch });
    const summarised = {
      ...entry('car', 'Service the car'),
      todos: listed ? [garage] : [],
      summary: {},
    } as unknown as NeoAskEntry;
    const onLoadDetails = vi
      .fn<(askId: string) => Promise<NeoAskEntry>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue({ ...entry('car', 'Service the car'), todos: [garage] } as NeoAskEntry);
    const view = render(
      <NeoHumanQueue
        queue={{ items: [queue.items[3]], counts: { car: { waiting: 0, held: 0, progress: 1 } } }}
        entries={[summarised]}
        onHold={vi.fn()}
        onAnswer={vi.fn()}
        onLoadDetails={onLoadDetails}
        onDesktopControl={vi.fn()}
      />
    );
    fireEvent.click(view.getByRole('button', { name: 'In progress 1' }));
    expect((await view.findByRole('alert')).textContent).toContain('Couldn’t load this step.');
    fireEvent.click(view.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(view.queryByRole('alert')).toBeNull());
    expect(onLoadDetails).toHaveBeenCalledTimes(2);
  });

  it('keeps cards in the queue order across asks, in runs labelled by ask', () => {
    const props = {
      queue: {
        items: [
          { state: 'waiting', askId: 'trip', questionId: 'q1', text: 'A new', todos: [] },
          { state: 'waiting', askId: 'tax', questionId: 'q3', text: 'B middle', todos: [] },
          { state: 'waiting', askId: 'trip', questionId: 'q2', text: 'A old', todos: [] },
        ],
        counts: {
          trip: { waiting: 2, held: 0, progress: 0 },
          tax: { waiting: 1, held: 0, progress: 0 },
        },
      } as Queue,
      entries,
      onHold: vi.fn(),
      onAnswer: vi.fn(),
    };
    const view = render(<NeoHumanQueue {...props} />);
    const runs = [...view.container.querySelectorAll('[data-queue-ask]')];
    expect(runs.map((run) => run.getAttribute('aria-label'))).toEqual([
      'Plan the trip',
      'File taxes',
      'Plan the trip',
    ]);
    expect(
      [...view.container.querySelectorAll('[data-queue-card]')].map((card) =>
        card.getAttribute('data-queue-card')
      )
    ).toEqual(['q1', 'q3', 'q2']);
    expect(view.container.querySelectorAll('[id="neo-ref-ask-trip"]')).toHaveLength(1);
    view.rerender(
      <NeoHumanQueue {...props} renderAsk={(shown) => <p>Full ask {shown.ask.title}</p>} />
    );
    expect(
      [...view.container.querySelectorAll('[data-queue-ask]')].map((run) =>
        run.getAttribute('aria-label')
      )
    ).toEqual(['Plan the trip', 'File taxes']);
    expect(view.getAllByText('Full ask Plan the trip')).toHaveLength(1);
  });

  it('keeps the open full ask and its unsent choice when its leading card changes', async () => {
    const choice = question('q1', 'trip', {
      kind: 'choice',
      options: ['iPhone', 'iPad'],
      multiple: true,
      createdAt: 1,
    });
    const newer = question('q0', 'trip', { text: 'Question q0', createdAt: 5 });
    const at = (updatedAt: number, summary: boolean, questions: NeoQuestionEntry[]) => {
      const shown = testAskEntry('trip', 'Plan the trip', { state: 'waiting', questions });
      return {
        ...shown,
        ask: { ...shown.ask, updatedAt },
        ...(summary ? { summary: {} } : {}),
      } as unknown as NeoAskEntry;
    };
    const wait = (id: string): Queue['items'][number] => ({
      state: 'waiting',
      askId: 'trip',
      questionId: id,
      text: `Question ${id}`,
      todos: [],
    });
    const counts = (waiting: number) => ({ trip: { waiting, held: 0, progress: 0 } });
    const reads: ((value: NeoAskEntry) => void)[] = [];
    const props = {
      onHold: vi.fn(),
      onAnswer: vi.fn(),
      onLoadDetails: () => new Promise<NeoAskEntry>((resolve) => reads.push(resolve)),
      renderAsk: (shown: NeoAskEntry, refreshing?: boolean) => (
        <NeoAskTodos entry={shown} disabled={refreshing} onAnswer={vi.fn()} />
      ),
    };
    const view = render(
      <NeoHumanQueue
        {...props}
        queue={{ items: [wait('q1')], counts: counts(1) }}
        entries={[at(1, true, [choice])]}
      />
    );
    await waitFor(() => expect(reads).toHaveLength(1));
    reads[0](at(1, false, [choice]));
    const pick = (await view.findByRole('checkbox', { name: 'iPad' })) as HTMLInputElement;
    fireEvent.click(pick);
    view.rerender(
      <NeoHumanQueue
        {...props}
        queue={{ items: [wait('q0'), wait('q1')], counts: counts(2) }}
        entries={[at(2, true, [newer, choice])]}
      />
    );
    await waitFor(() => expect(reads).toHaveLength(2));
    expect(view.getByRole('checkbox', { name: 'iPad' })).toBe(pick);
    expect(pick.checked).toBe(true);
    reads[1](at(2, false, [newer, choice]));
    view.rerender(
      <NeoHumanQueue
        {...props}
        queue={{ items: [wait('q1')], counts: counts(1) }}
        entries={[at(3, true, [{ ...newer, state: 'answered' }, choice])]}
      />
    );
    await waitFor(() => expect(reads).toHaveLength(3));
    expect(view.getByRole('checkbox', { name: 'iPad' })).toBe(pick);
    expect(pick.checked).toBe(true);
    reads[2](at(3, false, [{ ...newer, state: 'answered' }, choice]));
    await waitFor(() =>
      expect((view.getByRole('button', { name: 'Confirm' }) as HTMLButtonElement).disabled).toBe(
        false
      )
    );
    expect(view.getByRole('checkbox', { name: 'iPad' })).toBe(pick);
    expect(pick.checked).toBe(true);
  });

  it('names a group by its queued card until the ask title is known', () => {
    const view = render(
      <NeoHumanQueue
        queue={{
          items: [
            {
              state: 'waiting',
              askId: 'far',
              questionId: 'qf',
              text: 'Book the far trip?',
              todos: [],
            },
          ],
          counts: { far: { waiting: 1, held: 0, progress: 0 } },
        }}
        entries={[]}
        onHold={vi.fn()}
        onAnswer={vi.fn()}
      />
    );
    expect(view.queryByText('far')).toBeNull();
    expect(view.getByRole('region', { name: 'Book the far trip?' })).toBeTruthy();
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

describe('NeoHumanQueue states match the phone', () => {
  const parity: Queue = {
    items: [
      {
        state: 'waiting',
        askId: 'idle',
        todoId: 'stalled',
        title: 'Not started for days',
        owner: 'neo',
        step: 'neo',
      },
      {
        state: 'progress',
        askId: 'idle',
        todoId: 'paused',
        title: 'Paused step',
        owner: 'nobody',
        step: 'paused',
      },
      {
        state: 'progress',
        askId: 'idle',
        todoId: 'after',
        title: 'After an earlier step',
        owner: 'prerequisite',
        step: 'waiting',
        waitingOn: 'earlier_step',
      },
      {
        state: 'progress',
        askId: 'busy',
        todoId: 'running',
        title: 'Session running',
        owner: 'worker',
        step: 'working',
      },
    ],
    counts: {
      idle: { waiting: 1, held: 0, progress: 2 },
      busy: { waiting: 0, held: 0, progress: 1 },
    },
  };
  const asks = [entry('idle', 'Idle ask'), entry('busy', 'Busy ask')];

  it('waits on you only for your cards and steps, and is in progress only while a session runs', () => {
    locale.value = 'zh-Hans';
    const view = render(
      <NeoHumanQueue queue={parity} entries={asks} onHold={vi.fn()} onAnswer={vi.fn()} />
    );
    const states = within(view.getByRole('group', { name: '状态' }));
    expect(states.getByRole('button', { name: '等你 0' })).toBeTruthy();
    expect(states.getByRole('button', { name: '已搁置 1' })).toBeTruthy();
    expect(states.getByRole('button', { name: '进行中 1' })).toBeTruthy();
    expect(states.getByRole('button', { name: '所有工作 4' })).toBeTruthy();
    expect(view.queryByText('Not started for days')).toBeNull();
    fireEvent.click(states.getByRole('button', { name: '进行中 1' }));
    expect(view.getByText('Session running')).toBeTruthy();
    expect(view.queryByText('After an earlier step')).toBeNull();
    expect(view.queryByText('Paused step')).toBeNull();
    fireEvent.click(states.getByRole('button', { name: '已搁置 1' }));
    expect(view.getByText('Paused step')).toBeTruthy();
  });

  it('counts each ask once under waiting on you, like the phone', () => {
    const cards: Queue = {
      items: ['q1', 'q2'].map((questionId) => ({
        state: 'waiting' as const,
        askId: 'idle',
        questionId,
        text: `Question ${questionId}`,
        todos: [],
      })),
      counts: { idle: { waiting: 2, held: 0, progress: 0 } },
    };
    const view = render(
      <NeoHumanQueue queue={cards} entries={asks} onHold={vi.fn()} onAnswer={vi.fn()} />
    );
    const states = within(view.getByRole('group', { name: 'State' }));
    expect(states.getByRole('button', { name: 'Waiting on you 1' })).toBeTruthy();
    expect(view.getByText('Question q2')).toBeTruthy();
  });
});
