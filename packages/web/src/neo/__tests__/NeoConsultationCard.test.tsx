import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NeoConsultationCard } from '../NeoConsultationCard.tsx';
import type { NeoScene } from '../neo-scenes.ts';
import { SessionStore } from '../../lib/session-store.ts';

type Consultation = Extract<NeoScene['receipt'], { kind: 'consultation' }>;
const receipt = (status: Consultation['status']): Consultation => ({
  kind: 'consultation',
  id: 'fictional-consultation',
  requestKey: 'fictional-request',
  concernId: 'fictional-garden',
  originSessionId: 'neo:fictional-root',
  originMessageId: 'fictional-human-ask',
  sessionId: 'fictional-holder',
  question: 'The full fictional question\nwith its original second line.',
  status,
  answer: status === 'reported' ? '## Fictional answer\n\n**Three** blue flowers.' : null,
  createdAt: 1,
});
const props = (status: Consultation['status']) => ({
  consultation: receipt(status),
  label: 'Fictional context check',
  holderName: 'Fictional garden',
  onOpen: vi.fn(),
  onOpenHolder: vi.fn(),
  onStopWaiting: vi.fn(),
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Neo consultation card presentation', () => {
  it.each([
    ['pending', 'Checking context'],
    ['queued', 'Waiting for context'],
    ['reported', 'Response ready'],
    ['failed', 'Needs attention'],
  ] as const)('keeps %s summaries non-owning navigation with recorded truth', (status, truth) => {
    const select = vi.spyOn(SessionStore.prototype, 'select');
    const bindings = props(status);
    const view = render(
      <NeoConsultationCard {...bindings} presentation="summary" busy={true} disabled={true} />
    );
    const opener = screen.getByRole('button', { name: 'View details for Fictional context check' });
    expect(opener.getAttribute('disabled')).toBeNull();
    expect(opener.getAttribute('data-consultation-open')).toBe('fictional-consultation');
    expect(screen.getByText(`Fictional garden · ${truth}`)).toBeTruthy();
    expect(view.container.querySelector('article, details, textarea, input, a')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Stop waiting' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Fictional garden' })).toBeNull();
    fireEvent.click(opener.querySelector('svg')!);
    expect(bindings.onOpen).toHaveBeenCalledExactlyOnceWith('fictional-consultation');
    expect(bindings.onOpenHolder).not.toHaveBeenCalled();
    expect(bindings.onStopWaiting).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
  });

  it.each(['pending', 'queued', 'reported', 'failed'] as const)(
    'preserves the full %s question and separates holder navigation from closing a request',
    (status) => {
      const bindings = props(status);
      render(<NeoConsultationCard {...bindings} />);
      const card = screen.getByRole('article', { name: bindings.label });
      fireEvent.click(within(card).getByText('What was asked'));
      expect(card.querySelector('details p')?.textContent).toBe(bindings.consultation.question);
      fireEvent.click(within(card).getByRole('button', { name: 'Fictional garden', exact: true }));
      expect(bindings.onOpenHolder).toHaveBeenCalledExactlyOnceWith('fictional-garden');
      expect(bindings.onOpen).not.toHaveBeenCalled();
      expect(bindings.onStopWaiting).not.toHaveBeenCalled();
      fireEvent.click(within(card).getByRole('button', { name: bindings.label, exact: true }));
      expect(bindings.onOpen).toHaveBeenCalledExactlyOnceWith('fictional-consultation');
      const waiting = status === 'pending' || status === 'queued';
      expect(within(card).queryByRole('button', { name: 'Stop waiting' }) !== null).toBe(waiting);
      if (waiting) {
        fireEvent.click(within(card).getByRole('button', { name: 'Stop waiting' }));
        expect(bindings.onStopWaiting).toHaveBeenCalledExactlyOnceWith('fictional-consultation');
      }
      expect(within(card).queryByRole('button', { name: 'Start work' })).toBeNull();
      expect(within(card).queryByRole('button', { name: 'Stop work' })).toBeNull();
      expect(within(card).queryByRole('link', { name: 'Inspect execution ↗' })).toBeNull();
    }
  );

  it.each([
    ['disabled', false, true, 'Stop waiting'],
    ['busy', true, false, 'Closing…'],
  ] as const)('disables the existing wait closure when %s', (_, busy, disabled, label) => {
    const bindings = props('pending');
    render(<NeoConsultationCard {...bindings} busy={busy} disabled={disabled} />);
    const button = screen.getByRole('button', { name: label });
    expect(button.hasAttribute('disabled')).toBe(true);
    expect(button.getAttribute('title')).toContain('without interrupting the holder');
    fireEvent.click(button);
    expect(bindings.onStopWaiting).not.toHaveBeenCalled();
    expect(
      screen.getByRole('button', { name: 'Fictional garden', exact: true }).hasAttribute('disabled')
    ).toBe(false);
  });

  it('renders the stored response as Markdown without claiming verified completion', async () => {
    render(<NeoConsultationCard {...props('reported')} />);
    fireEvent.click(screen.getByText('Read the context response', { exact: true }));
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Fictional answer' })).toBeTruthy()
    );
    expect(screen.getByText('Three').tagName).toBe('STRONG');
    expect(screen.getByRole('button', { name: 'Copy context response' })).toBeTruthy();
    expect(screen.getByText(/not verified completion/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Stop waiting' })).toBeNull();
  });

  it('offers no guessed navigation or wait closure when callbacks are unavailable', () => {
    render(
      <NeoConsultationCard
        consultation={receipt('pending')}
        label="Fictional context check"
        holderName="Fictional garden"
      />
    );
    expect(screen.getByRole('article', { name: 'Fictional context check' })).toBeTruthy();
    expect(screen.getByText('Context held by Fictional garden')).toBeTruthy();
    expect(screen.queryAllByRole('button')).toEqual([]);
  });

  it('keeps a summary non-owning when its opener disappears but action callbacks remain', () => {
    const bindings = props('queued');
    const view = render(
      <NeoConsultationCard {...bindings} onOpen={undefined} presentation="summary" />
    );
    const opener = screen.getByRole('button', { name: 'View details for Fictional context check' });
    expect(opener.hasAttribute('disabled')).toBe(true);
    fireEvent.click(opener);
    expect(view.container.querySelector('article, details, textarea, input, a')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Stop waiting' })).toBeNull();
    expect(bindings.onStopWaiting).not.toHaveBeenCalled();
    expect(bindings.onOpenHolder).not.toHaveBeenCalled();
  });

  it('rebinds closure to the current receipt and removes it on a reported transition', () => {
    const bindings = props('pending');
    const view = render(<NeoConsultationCard {...bindings} />);
    const next = {
      ...receipt('queued'),
      id: 'replacement-consultation',
      concernId: 'other-holder',
    };
    view.rerender(<NeoConsultationCard {...bindings} consultation={next} />);
    fireEvent.click(screen.getByRole('button', { name: 'Stop waiting' }));
    expect(bindings.onStopWaiting).toHaveBeenCalledExactlyOnceWith('replacement-consultation');
    fireEvent.click(screen.getByRole('button', { name: 'Fictional garden', exact: true }));
    expect(bindings.onOpenHolder).toHaveBeenCalledExactlyOnceWith('other-holder');
    view.rerender(
      <NeoConsultationCard
        {...bindings}
        consultation={{ ...next, status: 'reported', answer: 'Recorded response' }}
      />
    );
    expect(screen.queryByRole('button', { name: 'Stop waiting' })).toBeNull();
    expect(screen.getByText('Read the context response')).toBeTruthy();
    expect(bindings.onStopWaiting).toHaveBeenCalledTimes(1);
  });
});
