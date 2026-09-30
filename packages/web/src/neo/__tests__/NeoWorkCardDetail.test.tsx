import { cleanup, fireEvent, render, screen, within } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import { NeoWorkCard } from '../NeoWorkCard.tsx';

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
});
