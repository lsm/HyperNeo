import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { signal } from '@preact/signals';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NeoWork } from '@hyperneo/shared/types/neo-context';
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

afterEach(cleanup);

describe('NeoWorkCard detail opening', () => {
  it('gives the title a genuine named keyboard-accessible opener', () => {
    const open = vi.fn();
    const { card } = show(work('p', 'proposed'), open);
    const opener = within(card).getByRole('button', { name: 'Title p' });
    expect(opener.tagName).toBe('BUTTON');
    expect(opener.getAttribute('type')).toBe('button');
    expect(opener.getAttribute('tabindex')).toBeNull();
    expect(within(card).getByRole('heading').contains(opener)).toBe(true);
    fireEvent.click(opener);
    expect(open).toHaveBeenCalledWith('p');
  });

  it('opens from a non-interactive part of the card body', () => {
    const open = vi.fn();
    const { card } = show(work('p', 'proposed'), open);
    fireEvent.click(within(card).getByText('Your call'));
    expect(open).toHaveBeenCalledWith('p');
  });

  it('keeps Start and Not now acting without opening detail', () => {
    const open = vi.fn();
    const action = vi.fn();
    const { card } = show(work('p', 'proposed'), open, action);
    fireEvent.click(within(card).getByRole('button', { name: 'Start work' }));
    fireEvent.click(within(card).getByRole('button', { name: 'Not now' }));
    expect(action).toHaveBeenNthCalledWith(1, 'p', 'start');
    expect(action).toHaveBeenNthCalledWith(2, 'p', 'cancel');
    expect(open).not.toHaveBeenCalled();
  });

  it('keeps a nested SVG target inside an action from opening detail', () => {
    const open = vi.fn();
    const action = vi.fn();
    const { card } = show(work('p', 'proposed'), open, action);
    const icon = within(card).getByRole('button', { name: 'Start work' }).querySelector('svg');
    expect(icon).toBeTruthy();
    fireEvent.click(icon as Element);
    expect(action).toHaveBeenCalledWith('p', 'start');
    expect(open).not.toHaveBeenCalled();
  });

  it('keeps Stop work acting without opening detail', () => {
    const open = vi.fn();
    const action = vi.fn();
    const { card } = show(work('q', 'queued', { sessionId: null }), open, action);
    fireEvent.click(within(card).getByRole('button', { name: 'Stop work' }));
    expect(action).toHaveBeenCalledWith('q', 'cancel');
    expect(open).not.toHaveBeenCalled();
  });

  it('keeps the execution link and both disclosures from opening detail', () => {
    const open = vi.fn();
    const { card } = show(work('r', 'reported'), open);
    fireEvent.click(within(card).getByRole('link', { name: 'Inspect execution ↗' }));
    const summaries = within(card).getAllByText(/What was delegated|Read the execution/);
    expect(summaries).toHaveLength(2);
    for (const summary of summaries) fireEvent.click(summary);
    expect(open).not.toHaveBeenCalled();
    expect(within(card).getByText('Response ready')).toBeTruthy();
  });

  it('renders no opener and ignores body clicks when no onOpen is given', () => {
    const { card } = show(work('p', 'proposed'));
    expect(within(card).queryByRole('button', { name: 'Title p' })).toBeNull();
    expect(within(card).getByRole('heading').textContent).toBe('Title p');
    expect(card.getAttribute('onclick')).toBeNull();
    fireEvent.click(within(card).getByText('Your call'));
    expect(screen.getByRole('article', { name: 'Title p' })).toBeTruthy();
  });

  it('keeps rendered Markdown links and checkboxes acting without opening detail', async () => {
    const open = vi.fn();
    const { card } = show(
      work('r', 'reported', {
        report: 'See [the source](https://example.com/a)\n\n- [ ] verify the date',
      }),
      open
    );
    fireEvent.click(within(card).getByText(/Read the execution/));
    const link = await waitFor(() => {
      const found = card.querySelector('a[href="https://example.com/a"]');
      expect(found).toBeTruthy();
      return found as HTMLAnchorElement;
    });
    const box = await waitFor(() => {
      const found = card.querySelector('input[type="checkbox"]');
      expect(found).toBeTruthy();
      return found as HTMLInputElement;
    });
    fireEvent.click(link as Element);
    fireEvent.click(box as Element);
    expect(open).not.toHaveBeenCalled();
  });

  it('keeps a real question control acting without opening detail', () => {
    const open = vi.fn();
    const { card } = show(work('q', 'queued'), open);
    expect(within(card).getByText('A quick choice')).toBeTruthy();
    fireEvent.click(within(card).getByRole('button', { name: 'Monday' }));
    expect(open).not.toHaveBeenCalled();
  });

  it.each([
    ['both endpoints elsewhere', 'out', 'out', true],
    ['anchor outside and focus inside', 'out', 'in', false],
    ['anchor inside and focus outside', 'in', 'out', false],
  ] as const)('honours a selection with %s', (_name, anchorIn, focusIn, opens) => {
    const open = vi.fn();
    const { card } = show(work('p', 'proposed'), open);
    const label = within(card).getByText('Your call');
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
