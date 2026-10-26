import type { NeoPublication } from '@hyperneo/shared/types/neo-publication';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NeoPublicConversation, PendingAsk } from '../NeoPublicConversation.tsx';
import { NeoWakeRow } from '../NeoWakeRow.tsx';
import type { NeoPublicEntry } from '../public-conversation.ts';

afterEach(cleanup);
const root = 'neo:10000000-0000-4000-8000-000000008098';
const origin = { sessionId: root, messageId: 'synthetic' };
const conversation = (entries: NeoPublicEntry[]) => ({
  conversationId: root.slice(4),
  status: 'ready' as const,
  hasEarlier: false,
  hasMore: false,
  entries,
});

function assertTrailingControl(body: HTMLElement, context: RegExp) {
  const less = screen.getByRole('button', { name: context, expanded: true });
  expect(less.textContent).toContain('less');
  expect(
    body.contains(less) ||
      Boolean(body.compareDocumentPosition(less) & Node.DOCUMENT_POSITION_FOLLOWING)
  ).toBe(true);
  fireEvent.click(body);
  expect(less.getAttribute('aria-expanded')).toBe('true');
  return less;
}

describe('Wake and conversation explicit disclosures', () => {
  it('keeps wake summaries inert, preserves native navigation and uses a trailing control', async () => {
    const wake = {
      scheduleId: 'synthetic-wake',
      sourceKind: 'goal' as const,
      sourceId: 'goal',
      title: 'Synthetic wake',
      summary: 'Short ending.',
      firedAt: Date.now(),
      settledAt: Date.now(),
      additions: [{ kind: 'journal' as const, id: 'journal', label: 'Synthetic wake detail' }],
    };
    const view = render(
      <NeoWakeRow entryKey="wake" conversationId={root.slice(4)} wake={wake}>
        <p>Synthetic nested reply</p>
      </NeoWakeRow>
    );
    const row = view.container.querySelector<HTMLDetailsElement>('details')!;
    fireEvent.click(screen.getByText('Synthetic wake'));
    expect(row.open).toBe(false);
    const more = screen.getByRole('button', { name: /more.*Synthetic wake/ });
    fireEvent.click(more);
    expect(row.open).toBe(true);
    const less = assertTrailingControl(
      screen.getByText('Synthetic nested reply'),
      /less.*Synthetic wake/
    );
    view.rerender(
      <NeoWakeRow
        entryKey="wake"
        conversationId={root.slice(4)}
        wake={{ ...wake, summary: 'Updated summary.' }}
      >
        <p>Synthetic nested reply</p>
      </NeoWakeRow>
    );
    expect(row.open).toBe(true);
    fireEvent.click(less);
    expect(row.open).toBe(false);
    row.open = true;
    fireEvent(row, new Event('toggle'));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /less.*Synthetic wake/ })).toBeTruthy()
    );
  });

  it('keeps a session-message preview inert and preserves full text for selection', () => {
    render(
      <NeoPublicConversation
        conversation={conversation([
          {
            kind: 'session',
            key: 'session',
            message: {
              messageId: 'msg',
              conversationId: root.slice(4),
              sequence: 1,
              fromSession: root,
              fromName: 'Neo',
              toSession: 'worker',
              toName: 'Synthetic worker',
              createdAt: new Date().toISOString(),
              text: 'Synthetic preview\nLong message detail. '.repeat(8),
              kind: 'session' as const,
            },
          },
        ])}
      />
    );
    const summary = screen.getByText('Synthetic preview');
    fireEvent.click(summary);
    const row = summary.closest('details')!;
    expect(row.open).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: /more.*Synthetic worker/ }));
    const detail = screen.getByText(/Long message detail/, { selector: 'p' });
    const less = assertTrailingControl(detail, /less.*Synthetic worker/);
    fireEvent.click(less);
    expect(row.open).toBe(false);
  });

  it('keeps Edited as a marker and folds revision history from its bottom-right control', async () => {
    const publication = {
      conversationId: root.slice(4),
      publicationId: 'publication',
      sequence: 1,
      createdAt: new Date().toISOString(),
      askOrigin: origin,
      producerInput: origin,
      shortText: 'Current reply',
      fullText: 'Current reply',
      links: [],
      editedAt: new Date().toISOString(),
      revisions: [
        {
          revisionId: 'old',
          createdAt: new Date().toISOString(),
          shortText: 'Original reply',
          fullText: 'Original reply',
          producerInput: origin,
        },
      ],
    } as NeoPublication;
    render(
      <NeoPublicConversation
        conversation={conversation([
          { kind: 'publication', key: 'publication', publication, replyTo: null },
        ])}
      />
    );
    fireEvent.click(screen.getByText('Edited'));
    expect(screen.queryByRole('region', { name: 'Revision history' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /more.*Edited/ }));
    const history = screen.getByRole('region', { name: 'Revision history' });
    const original = await within(history).findByText('Original reply');
    const less = assertTrailingControl(original, /less.*Edited/);
    expect(less.getAttribute('aria-controls')).toBe(history.id);
    fireEvent.click(less);
    expect(screen.queryByRole('region', { name: 'Revision history' })).toBeNull();
  });

  it('leaves the failed-delivery indicator inert and keeps edit/resend separate', () => {
    const edit = vi.fn();
    render(
      <NeoPublicConversation
        onEditUndelivered={edit}
        conversation={conversation([
          {
            kind: 'ask',
            key: 'ask',
            ask: {
              conversationId: root.slice(4),
              requestId: 'ask',
              askOrigin: origin,
              sequence: 1,
              createdAt: new Date().toISOString(),
              content: 'Synthetic failed ask',
              delivery: { state: 'failed' },
            },
          },
        ])}
      />
    );
    fireEvent.click(screen.getByRole('img', { name: /Not delivered/ }));
    expect(screen.queryByText('Not delivered: Neo never got this message.')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /more.*Not delivered/ }));
    const less = assertTrailingControl(
      screen.getByText('Not delivered: Neo never got this message.'),
      /less.*Not delivered/
    );
    fireEvent.click(less);
    fireEvent.click(screen.getByRole('button', { name: 'Edit and send again' }));
    expect(edit).toHaveBeenCalledOnce();
  });

  it('uses the same explicit reason control for an unaccepted pending send', () => {
    const retry = vi.fn(),
      edit = vi.fn();
    render(
      <PendingAsk
        ask={{
          requestId: 'pending',
          sessionId: root,
          state: 'failed',
          text: 'Synthetic pending ask',
          images: [],
          reason: 'Synthetic refusal',
          createdAt: new Date().toISOString(),
        }}
        onRetry={retry}
        onEdit={edit}
      />
    );
    fireEvent.click(screen.getByRole('img', { name: /Not sent/ }));
    expect(screen.queryByText('Not sent: Synthetic refusal')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /more.*Not sent/ }));
    fireEvent.click(
      assertTrailingControl(screen.getByText('Not sent: Synthetic refusal'), /less.*Not sent/)
    );
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(retry).toHaveBeenCalledWith('pending');
    expect(edit).toHaveBeenCalledWith('pending');
  });
});
