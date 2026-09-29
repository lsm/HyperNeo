import { fireEvent, render, screen, within } from '@testing-library/preact';
import type { NeoConcern, NeoConsultation, NeoWork } from '@hyperneo/shared/types/neo-context';
import { describe, expect, it, vi } from 'vitest';
import { NeoConcerns, prioritizedConcerns } from '../NeoConcerns.tsx';

function concern(id: string, updatedAt: number): NeoConcern {
  return {
    id,
    title: id,
    summary: `${id} summary`,
    context: '',
    revision: 1,
    createdAt: 1,
    updatedAt,
  };
}

function work(concernId: string | null, status: NeoWork['status'], updatedAt: number): NeoWork {
  return { id: `${concernId}-${status}-${updatedAt}`, concernId, status, updatedAt } as NeoWork;
}

function consultation(concernId: string, status: NeoConsultation['status']): NeoConsultation {
  return { id: `${concernId}-${status}`, concernId, status, createdAt: 7 } as NeoConsultation;
}

describe('prioritizedConcerns', () => {
  it('puts decisions, live work and pending checks before quiet concerns', () => {
    const ordered = prioritizedConcerns(
      [
        concern('quiet', 100),
        concern('checking', 80),
        concern('working', 60),
        concern('decision', 40),
      ],
      [work('working', 'queued', 11), work('decision', 'proposed', 10)],
      [consultation('checking', 'pending')]
    );
    expect(ordered.map(({ concern: item, attention }) => [item.id, attention])).toEqual([
      ['decision', 'decision'],
      ['working', 'working'],
      ['checking', 'checking'],
      ['quiet', null],
    ]);
  });

  it('keeps terminal and one-off work out of concern attention', () => {
    const ordered = prioritizedConcerns(
      [concern('older', 1), concern('newer', 2)],
      [work('older', 'reported', 20), work('older', 'cancelled', 30), work(null, 'proposed', 40)],
      [consultation('older', 'reported')]
    );
    expect(ordered.map(({ concern: item, attention }) => [item.id, attention])).toEqual([
      ['newer', null],
      ['older', null],
    ]);
  });
});

describe('NeoConcerns', () => {
  it('shows one parked attention cue per concern and still opens the selected holder', () => {
    const onOpen = vi.fn();
    render(
      <NeoConcerns
        concerns={[concern('Book club', 1), concern('Garden', 2)]}
        works={[work('Book club', 'proposed', 3), work('Book club', 'proposed', 4)]}
        selectedId={null}
        onOpen={onOpen}
      />
    );
    const trigger = screen.getByRole('button', {
      name: 'Your concerns · 2 · 1 thing needs your call',
    });
    fireEvent.click(trigger);
    const list = screen.getByRole('complementary', { name: 'Your concerns' });
    expect(within(list).getByText('1 thing needs your call')).toBeTruthy();
    expect(within(list).getAllByText('Your call').length).toBeGreaterThan(0);
    fireEvent.click(within(list).getByRole('button', { name: /Book club/ }));
    expect(onOpen).toHaveBeenCalledWith('Book club');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });
});
