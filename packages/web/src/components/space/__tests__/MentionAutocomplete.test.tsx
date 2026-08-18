// @ts-nocheck
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/preact';

vi.mock('../../../lib/utils', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}));

vi.mock('../../../lib/design-tokens', () => ({
  borderColors: {
    ui: { default: 'border-dark-700' },
  },
}));

import MentionAutocomplete from '../MentionAutocomplete';

const agents = [
  { id: '1', name: 'Coder' },
  { id: '2', name: 'Reviewer' },
  { id: '3', name: 'Planner' },
];

describe('MentionAutocomplete', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders nothing when agents list is empty', () => {
    const { queryByTestId } = render(
      <MentionAutocomplete agents={[]} selectedIndex={0} onSelect={vi.fn()} onClose={vi.fn()} />
    );
    expect(queryByTestId('mention-autocomplete')).toBeNull();
  });

  it('renders the dropdown with all agent names when agents are provided', () => {
    const { getByTestId, getAllByTestId } = render(
      <MentionAutocomplete agents={agents} selectedIndex={0} onSelect={vi.fn()} onClose={vi.fn()} />
    );
    expect(getByTestId('mention-autocomplete')).toBeTruthy();
    const items = getAllByTestId('mention-item');
    expect(items.length).toBe(3);
    expect(items[0].textContent).toContain('@Coder');
    expect(items[1].textContent).toContain('@Reviewer');
    expect(items[2].textContent).toContain('@Planner');
  });

  it('highlights the item at selectedIndex', () => {
    const { getAllByTestId } = render(
      <MentionAutocomplete agents={agents} selectedIndex={1} onSelect={vi.fn()} onClose={vi.fn()} />
    );
    const items = getAllByTestId('mention-item');
    expect(items[1].className).toContain('bg-blue-500/20');
    expect(items[0].className).not.toContain('bg-blue-500/20');
    expect(items[2].className).not.toContain('bg-blue-500/20');
  });

  it('calls onSelect with agent name when an item is clicked', () => {
    const onSelect = vi.fn();
    const { getAllByTestId } = render(
      <MentionAutocomplete
        agents={agents}
        selectedIndex={0}
        onSelect={onSelect}
        onClose={vi.fn()}
      />
    );
    const items = getAllByTestId('mention-item');
    fireEvent.click(items[1]);
    expect(onSelect).toHaveBeenCalledWith('Reviewer');
  });

  it('calls onSelect exactly once when an item is clicked', () => {
    const onSelect = vi.fn();
    const { getAllByTestId } = render(
      <MentionAutocomplete
        agents={agents}
        selectedIndex={0}
        onSelect={onSelect}
        onClose={vi.fn()}
      />
    );
    const items = getAllByTestId('mention-item');
    fireEvent.click(items[0]);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith('Coder');
  });

  it('shows the "Mention Agent" header text', () => {
    const { getByText } = render(
      <MentionAutocomplete agents={agents} selectedIndex={0} onSelect={vi.fn()} onClose={vi.fn()} />
    );
    expect(getByText('Mention Agent')).toBeTruthy();
  });

  it('calls onClose when clicking outside the dropdown', () => {
    const onClose = vi.fn();
    render(
      <MentionAutocomplete agents={agents} selectedIndex={0} onSelect={vi.fn()} onClose={onClose} />
    );
    fireEvent.mouseDown(document.body);
    expect(onClose).toHaveBeenCalled();
  });

  beforeEach(() => {
    cleanup();
  });
});
