import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import { signal } from '@preact/signals';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NeoWorkCard } from '../NeoWorkCard.tsx';

vi.mock('../../lib/state.ts', () => ({
  connectionState: { value: 'connected', subscribe: () => () => {} },
}));
vi.mock('../../lib/session-store.ts', () => ({
  SessionStore: class {
    sessionState = signal({
      sessionInfo: { id: 'q-session' },
      agentState: {
        status: 'waiting_for_input',
        pendingQuestion: {
          toolUseId: 'tool-q',
          askedAt: 1,
          inputOrigin: { sessionId: 'q-session', messageId: 'q' },
          questions: [
            {
              question: 'Which day?',
              header: 'Pick',
              multiSelect: false,
              options: [{ label: 'Monday' }],
            },
          ],
        },
      },
      commandsData: {},
      error: null,
      timestamp: 1,
    });
    activeSessionId = signal('q-session');
    isRecovering = signal(false);
    error = signal(null);
    async select() {}
    async refresh() {}
    async destroy() {}
  },
}));

const work = (id: string, status: NeoWork['status'], extra: Partial<NeoWork> = {}): NeoWork => ({
  id,
  requestKey: id,
  concernId: 'a',
  originSessionId: 'root',
  originMessageId: `ask-${id}`,
  title: `Title ${id}`,
  instruction: `Instruction ${id}`,
  targetSessionId: null,
  sessionId: status === 'proposed' ? null : `${id}-session`,
  status,
  report: status === 'reported' ? `Report ${id}` : null,
  createdAt: 10,
  updatedAt: 11,
  ...extra,
});

const show = (item: NeoWork, onOpen?: (id: string) => void, onAction = vi.fn()) => {
  const result = render(
    <NeoWorkCard
      work={item}
      busy={false}
      disabled={false}
      onAction={onAction}
      {...(onOpen ? { onOpen } : {})}
    />
  );
  return { ...result, action: onAction, card: screen.getByRole('article', { name: item.title }) };
};

const names = (card: HTMLElement) =>
  within(card)
    .queryAllByRole('button')
    .map((button) => button.getAttribute('aria-label') ?? button.textContent);

afterEach(cleanup);

describe('NeoWorkCard detail opening', () => {
  it.each(['queued', 'reported', 'cancelled'] as const)(
    'makes a %s card one keyboard-reachable opener with Open chat and at most its card menu',
    (status) => {
      const open = vi.fn();
      const { card } = show(work('r', status), open);
      expect(card.getAttribute('data-scene-open')).toBe('r');
      expect(card.getAttribute('tabindex')).toBe('0');
      expect(within(card).getByRole('heading').textContent).toBe('Title r');
      expect(card.querySelector('details, a')).toBeNull();
      expect(names(card)).toEqual(
        status === 'queued' ? ['Card actions', 'Open chat'] : ['Open chat']
      );
      expect(within(card).queryByText('Report r')).toBeNull();
      fireEvent.keyDown(card, { key: 'Enter' });
      expect(open).toHaveBeenCalledExactlyOnceWith('r');
      fireEvent.click(within(card).getByRole('heading'));
      expect(open).toHaveBeenCalledTimes(2);
      fireEvent.click(within(card).getByRole('button', { name: 'Open chat' }));
      expect(open).toHaveBeenCalledTimes(3);
    }
  );

  it('gives an actionable proposed card ordered actions and no card click', () => {
    const open = vi.fn();
    const action = vi.fn();
    const item = work('w', 'proposed', { sessionId: 'w-session', report: 'Report w' });
    const names = ['Decline', 'Start work'];
    render(
      <NeoWorkCard work={item} busy={false} disabled={false} onAction={action} onOpen={open} />
    );
    const card = screen.getByRole('article', { name: item.title });
    expect(card.getAttribute('data-scene-open')).toBeNull();
    expect(card.getAttribute('tabindex')).toBeNull();
    const buttons = within(card)
      .getAllByRole('button')
      .map((button) => button.textContent);
    expect(buttons.filter((name) => name !== 'Open chat')).toEqual(names);
    expect(buttons.filter((name) => name === 'Open chat')).toHaveLength(1);
    fireEvent.click(within(card).getByRole('heading'));
    fireEvent.keyDown(card, { key: 'Enter' });
    expect(open).not.toHaveBeenCalled();
    fireEvent.click(within(card).getByRole('button', { name: 'Open chat' }));
    expect(open).toHaveBeenCalledExactlyOnceWith('w');
    expect(action).not.toHaveBeenCalled();
  });

  it('closes queued work as done or cancelled from its card menu without opening it', () => {
    const open = vi.fn();
    const action = vi.fn();
    for (const item of ['Mark done', 'Cancel work']) {
      const { card } = show(work('q', 'queued'), open, action);
      fireEvent.click(within(card).getByRole('button', { name: 'Card actions' }));
      fireEvent.click(screen.getByRole('menuitem', { name: item }));
      cleanup();
    }
    expect(action.mock.calls).toEqual([
      ['q', 'done'],
      ['q', 'close'],
    ]);
    expect(open).not.toHaveBeenCalled();
  });

  it('makes a failed card an opener with its card menu and Open chat', () => {
    const open = vi.fn();
    const { card } = show(work('f', 'failed', { sessionId: 'f-session' }), open);
    expect(names(card)).toEqual(['Card actions', 'Open chat']);
    expect(within(card).getByText('Failed')).toBeTruthy();
    fireEvent.keyDown(card, { key: 'Enter' });
    expect(open).toHaveBeenCalledExactlyOnceWith('f');
  });

  it('retries a hand-off that never started from its footer', () => {
    const action = vi.fn();
    const failed = work('f', 'failed', {
      sessionId: null,
      report: 'Could not start the execution: logged out',
    });
    const { card } = show(failed, vi.fn(), action);
    fireEvent.click(within(card).getByRole('button', { name: 'Retry' }));
    expect(action).toHaveBeenCalledExactlyOnceWith('f', 'retry');
    cleanup();
    render(<NeoWorkCard work={failed} busy={true} disabled={false} onAction={action} />);
    expect((screen.getByRole('button', { name: 'Retrying…' }) as HTMLButtonElement).disabled).toBe(
      true
    );
  });

  it('offers no Open chat before the work has a chat', () => {
    const { card } = show(work('p', 'proposed'), vi.fn());
    expect(within(card).queryByRole('button', { name: 'Open chat' })).toBeNull();
    expect(within(card).getByRole('button', { name: 'Start work' })).toBeTruthy();
  });

  it('keeps Start and Decline acting without opening the chat', () => {
    const open = vi.fn();
    const action = vi.fn();
    const { card } = show(work('p', 'proposed', { sessionId: 'p-session' }), open, action);
    fireEvent.click(within(card).getByRole('button', { name: 'Start work' }));
    fireEvent.click(within(card).getByRole('button', { name: 'Decline' }));
    expect(action).toHaveBeenNthCalledWith(1, 'p', 'start');
    expect(action).toHaveBeenNthCalledWith(2, 'p', 'cancel');
    expect(open).not.toHaveBeenCalled();
  });

  it('shows the brief inline for proposed work and the reason inline for failed work', () => {
    show(work('p', 'proposed'));
    expect(screen.getByText('Instruction p')).toBeTruthy();
    cleanup();
    const { card } = show(work('f', 'failed', { report: 'Report f' }));
    expect(within(card).getByText('Report f')).toBeTruthy();
    expect(within(card).queryByText('Instruction f')).toBeNull();
  });

  it('renders no opener and ignores body clicks when no onOpen is given', () => {
    const { card } = show(work('r', 'reported'));
    expect(card.getAttribute('data-scene-open')).toBeNull();
    expect(card.getAttribute('tabindex')).toBeNull();
    fireEvent.click(within(card).getByText('Response ready'));
    expect(screen.getByRole('article', { name: 'Title r' })).toBeTruthy();
  });

  it('leads queued work waiting for an answer to its chat as the only action', () => {
    const open = vi.fn();
    const action = vi.fn();
    render(
      <NeoWorkCard
        work={work('q', 'queued')}
        busy={false}
        disabled={false}
        onAction={action}
        onOpen={open}
        waiting
      />
    );
    const card = screen.getByRole('article', { name: 'Title q' });
    expect(within(card).getByText('Waiting for your answer')).toBeTruthy();
    expect(within(card).queryByText('Handed to HyperNeo')).toBeNull();
    expect(card.getAttribute('data-scene-open')).toBeNull();
    expect(
      within(card)
        .getAllByRole('button')
        .map((button) => button.textContent)
    ).toEqual(['Answer in chat']);
    expect(within(card).queryByRole('button', { name: 'Monday' })).toBeNull();
    fireEvent.click(within(card).getByRole('button', { name: 'Answer in chat' }));
    expect(open).toHaveBeenCalledExactlyOnceWith('q');
    expect(action).not.toHaveBeenCalled();
  });

  it.each([
    ['both endpoints elsewhere', 'out', 'out', true],
    ['anchor outside and focus inside', 'out', 'in', false],
    ['anchor inside and focus outside', 'in', 'out', false],
  ] as const)('honours a selection with %s', (_name, anchorIn, focusIn, opens) => {
    const open = vi.fn();
    const { card } = show(work('r', 'reported'), open);
    const label = within(card).getByText('Response ready');
    const outside = document.createElement('p');
    outside.textContent = 'chosen elsewhere';
    document.body.append(outside);
    const selection = document.getSelection()!;
    const at = (where: 'in' | 'out') => (where === 'in' ? label : outside).firstChild as Text;
    selection.removeAllRanges();
    selection.collapse(at(anchorIn), 0);
    selection.extend(at(focusIn), Math.min(4, at(focusIn).length));
    const side = (node: Node | null) => (node && card.contains(node) ? 'in' : 'out');
    const owned = [side(selection.anchorNode), side(selection.focusNode)];
    expect([owned, selection.isCollapsed]).toEqual([[anchorIn, focusIn], false]);
    fireEvent.click(label);
    expect(open).toHaveBeenCalledTimes(opens ? 1 : 0);
    selection.removeAllRanges();
    outside.remove();
  });
});

describe('NeoWorkCard goal', () => {
  afterEach(() => cleanup());

  it('shows the goal and its done checklist on a detailed card, not on a summary', () => {
    const goal = { workId: 'g1', goal: 'A full iOS app', doneWhen: '- runs in the simulator' };
    const props = {
      work: work('g1', 'queued'),
      goal,
      busy: false,
      disabled: false,
      onAction: () => {},
    };
    const { unmount } = render(<NeoWorkCard {...props} />);
    expect(screen.getByText('A full iOS app')).toBeTruthy();
    expect(screen.getByText('Done when')).toBeTruthy();
    expect(screen.getByText('- runs in the simulator')).toBeTruthy();
    unmount();

    render(<NeoWorkCard {...props} presentation="summary" />);
    expect(screen.queryByText('A full iOS app')).toBeNull();
  });
});

describe('NeoWorkCard continues', () => {
  afterEach(() => cleanup());

  it('shows how many times Neo continued the work', () => {
    render(
      <NeoWorkCard
        work={work('c1', 'queued')}
        continued={{ workId: 'c1', count: 2, continuedAt: 1, lastMessage: 'Build settings.' }}
        busy={false}
        disabled={false}
        onAction={() => {}}
      />
    );
    expect(screen.getByText('Neo continued it 2/5').getAttribute('title')).toBe('Build settings.');
  });
});

describe('NeoWorkCard result', () => {
  it('shows Neo’s summary instead of the raw report, and a failure’s reason', () => {
    render(
      <NeoWorkCard
        work={work('r', 'reported', { report: 'A long raw agent reply' })}
        busy={false}
        disabled={false}
        onAction={vi.fn()}
        summary="Blocked: two files are missing."
      />
    );
    expect(screen.getByText('Blocked: two files are missing.')).toBeTruthy();
    expect(screen.queryByText('A long raw agent reply')).toBeNull();
    cleanup();
    render(
      <NeoWorkCard
        work={work('n', 'reported', { report: 'A long raw agent reply' })}
        busy={false}
        disabled={false}
        onAction={vi.fn()}
      />
    );
    expect(screen.queryByText('A long raw agent reply')).toBeNull();
    cleanup();
    render(
      <NeoWorkCard
        work={work('f', 'failed', { report: 'Could not start.' })}
        busy={false}
        disabled={false}
        onAction={vi.fn()}
      />
    );
    expect(screen.getByText('Could not start.')).toBeTruthy();
  });
});
