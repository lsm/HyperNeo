import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import type { NeoCardView } from '@hyperneo/shared/types/neo-snapshot';
import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NeoWorkCard } from '../NeoWorkCard.tsx';
import { testCard } from './neo-test-views.ts';

vi.mock('../../lib/state.ts', () => ({
  connectionState: { value: 'connected', subscribe: () => () => {} },
}));

const work: NeoWork = {
  id: 'w1',
  requestKey: 'w1',
  projectId: null,
  originSessionId: 'root',
  originMessageId: 'ask-1',
  title: 'Bigger font',
  instruction: 'Raise the body font to 16px.',
  targetSessionId: null,
  sessionId: null,
  status: 'queued',
  report: null,
  createdAt: 10,
  updatedAt: 11,
};
const codex = (extra: Partial<NeoCardView>) =>
  testCard(work, {
    adapter: 'codex-desktop',
    open: { link: 'codex://threads/t1', remoteLink: null, sessionId: null, daemon: 'laptop' },
    ...extra,
  });
const renderCard = (card: NeoCardView, props: Partial<Parameters<typeof NeoWorkCard>[0]> = {}) =>
  render(
    <NeoWorkCard
      work={work}
      card={card}
      busy={false}
      disabled={false}
      onAction={vi.fn()}
      onOpen={vi.fn()}
      {...props}
    />
  );

afterEach(cleanup);

describe('NeoWorkCard with drivers work', () => {
  it.each(['detail', 'summary'] as const)(
    'shows a failed stop with its Desktop opener in %s',
    (presentation) => {
      const cancelled = { ...work, status: 'cancelled' as const };
      renderCard(
        testCard(cancelled, {
          adapter: 'claude-desktop',
          label: 'Cancelled · stop unsupported',
          open: {
            link: 'claude://claude.ai/epitaxy/local_one',
            remoteLink: null,
            sessionId: null,
            daemon: null,
          },
          controlFailure: {
            operation: 'stop',
            reason: 'unsupported',
            detail: 'Desktop cannot be stopped here.',
            at: 2,
          },
        }),
        { presentation, work: cancelled }
      );
      expect(screen.getByText('Cancelled · stop unsupported')).toBeTruthy();
      expect(screen.getByText(/Desktop cannot be stopped here.*Open the session/)).toBeTruthy();
      expect(screen.getByRole('link', { name: 'Open Bigger font' }).getAttribute('href')).toBe(
        'claude://claude.ai/epitaxy/local_one'
      );
      expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Start work' })).toBeNull();
    }
  );

  it.each(['detail', 'summary'] as const)(
    'shows confirmed start configuration in %s',
    (presentation) => {
      renderCard(codex({ model: 'gpt-6.1-sol', effort: 'medium' }), { presentation });
      expect(screen.getByText('Started with gpt-6.1-sol · medium effort')).toBeTruthy();
    }
  );

  it('leaves unknown model and effort absent', () => {
    renderCard(codex({}));
    expect(screen.queryByText(/Started with/)).toBeNull();
  });

  it('shows where the work went and opens it there', () => {
    renderCard(
      codex({
        phase: 'needs_you',
        label: 'Needs you in Codex Desktop on laptop',
        primary: { kind: 'answer', label: 'Answer in Codex', link: 'codex://threads/t1' },
      })
    );
    expect(screen.getByText('Needs you in Codex Desktop on laptop')).toBeTruthy();
    const link = screen.getByRole('link', { name: 'Open Bigger font' });
    expect([link.getAttribute('href'), link.textContent]).toEqual([
      'codex://threads/t1',
      'Open in Codex',
    ]);
  });

  it('keeps abandoned work openable with stop in its menu', () => {
    const onAction = vi.fn();
    renderCard(
      codex({
        phase: 'abandoned',
        primary: { kind: 'close', label: 'Close', link: 'codex://threads/t1' },
      }),
      { onAction }
    );
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Card actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Stop work' }));
    expect(onAction).toHaveBeenCalledWith('w1', 'close');
    const link = screen.getByRole('link', { name: 'Open Bigger font' });
    expect([link.getAttribute('href'), link.textContent]).toEqual([
      'codex://threads/t1',
      'Open in Codex',
    ]);
  });

  it('keeps the summary row openable through the link', () => {
    renderCard(
      codex({
        label: 'Running in Codex Desktop on laptop',
        primary: { kind: 'open', label: 'Open in Codex', link: 'codex://threads/t1' },
      }),
      { presentation: 'summary' }
    );
    expect(screen.getByText('Running in Codex Desktop on laptop')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open Bigger font' }).textContent).toBe(
      'Open in Codex'
    );
  });

  it('tints the row from the card tone, and warns while it waits on a chat answer', () => {
    const tones = (['accent', 'warning', 'success'] as const).map((tone) => {
      const { container, unmount } = renderCard(testCard(work, { tone }), {
        presentation: 'summary',
      });
      const shown = container.querySelector('[data-tone]')?.getAttribute('data-tone');
      unmount();
      return shown;
    });
    expect(tones).toEqual(['accent', 'warning', 'success']);
    const session = { ...work, sessionId: 's1' };
    const { container } = renderCard(testCard(session), { work: session, waiting: true });
    expect(screen.getByText('Waiting for your answer')).toBeTruthy();
    expect(container.querySelector('[data-tone]')?.getAttribute('data-tone')).toBe('warning');
  });

  it.each(['open', 'answer'] as const)(
    'keeps the in-app chat opener when a %s card also has a driver link',
    (kind) => {
      const onOpen = vi.fn();
      const native = { ...work, sessionId: 'native-session' };
      renderCard(codex({ primary: { kind, label: 'Driver', link: null } }), {
        work: native,
        onOpen,
      });
      expect(screen.queryByRole('link', { name: 'Open Bigger font' })).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Open chat' }));
      expect(onOpen).toHaveBeenCalledExactlyOnceWith('w1');
      if (kind === 'answer') expect(screen.getByText('Waiting for your answer')).toBeTruthy();
    }
  );

  it('shows the PR label and number from the card', () => {
    const reported = { ...work, status: 'reported' as const };
    renderCard(
      testCard(reported, {
        label: 'Checks failing · #6039',
        pr: {
          number: '#6039',
          label: 'Checks failing · #6039',
          count: 1,
          inProgress: false,
          setback: true,
          merged: [],
        },
      }),
      { work: reported, onOpen: undefined }
    );
    expect(screen.getByText('Checks failing · #6039')).toBeTruthy();
    expect(screen.getByText('PR #6039')).toBeTruthy();
  });

  it('marks the Open link with the app it opens', () => {
    const logos = ['codex-desktop', 'claude-desktop', 'hyperneo'].map((adapter) => {
      const { unmount } = renderCard(
        testCard(work, {
          adapter,
          open: { link: '/session/s1', remoteLink: null, sessionId: null, daemon: null },
          primary: { kind: 'open', label: 'Open', link: '/session/s1' },
        }),
        { presentation: 'summary' }
      );
      const link = screen.getByRole('link', { name: 'Open Bigger font' });
      const logo = link.querySelector('[data-app-logo]')?.getAttribute('data-app-logo') ?? null;
      unmount();
      return logo;
    });
    expect(logos).toEqual(['anthropic-codex', 'anthropic', null]);
  });
});
