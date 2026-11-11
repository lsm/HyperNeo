import type { NeoConversationWake } from '@hyperneo/shared/types/neo-wake';
import type { NeoPublication } from '@hyperneo/shared/types/neo-publication';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/preact';
import { afterEach, describe, expect, it } from 'vitest';
import { NeoWakeRow } from '../NeoWakeRow.tsx';
import { NeoPublicConversation } from '../NeoPublicConversation.tsx';
import { projectNeoPublicConversation } from '../public-conversation.ts';
import { locale } from '../../lib/i18n/index.ts';

const id = '10000000-0000-4000-8000-000000000001';
const root = `neo:${id}`;
const firedAt = Date.parse('2026-10-20T12:00:00.000Z');
const wake: NeoConversationWake = {
  scheduleId: 'schedule-one',
  sourceKind: 'goal',
  sourceId: 'goal-one',
  title: 'Check the guide',
  firedAt,
  settledAt: firedAt + 1000,
  summary: 'The guide is ready.',
  additions: [
    { kind: 'ask', id: 'ask-one', label: 'Publish guide' },
    { kind: 'todo', id: 'todo-one', label: 'Review guide' },
    { kind: 'question', id: 'question-one', label: 'Which language?' },
    { kind: 'publication', id: 'publication-one', label: 'Guide ready.' },
    { kind: 'journal', id: 'journal-one', label: 'Guide reviewed.' },
  ],
};
const publication: NeoPublication = {
  conversationId: id,
  publicationId: 'publication-one',
  sequence: 1,
  createdAt: new Date(firedAt + 500).toISOString(),
  askOrigin: { sessionId: root, messageId: 'wake' },
  producerInput: { sessionId: root, messageId: 'wake' },
  shortText: 'Guide ready.',
  fullText: 'The detailed guide result.',
  links: [],
};
const conversation = (wakes = [wake], publications = [publication]) => {
  const sources = {
    asks: {
      conversationId: id,
      status: 'ready' as const,
      items: [],
      nextAfter: 0,
      hasMore: false,
      hasEarlier: false,
    },
    publications: {
      conversationId: id,
      status: 'ready' as const,
      items: publications,
      nextAfter: publications.length,
      hasMore: false,
      hasEarlier: false,
    },
    wakes,
  };
  return projectNeoPublicConversation(root, sources.asks, sources.publications, [], [], wakes);
};
const originalLocale = locale.value;
afterEach(() => {
  cleanup();
  locale.value = originalLocale;
});

describe('scheduled work stays outside the public conversation', () => {
  it('keeps scheduled rows and internal settlement text out of chat while retaining Neo replies', () => {
    const internal = 'That ask was already settled as done after its todo completed.';
    const { container } = render(
      <NeoPublicConversation conversation={conversation([{ ...wake, summary: internal }])} />
    );
    expect(container.querySelector('[data-wake]')).toBeNull();
    expect(container.textContent).not.toContain(wake.title);
    expect(container.textContent).not.toContain(internal);
    expect(container.querySelectorAll('[data-message-ref="publication-one"]')).toHaveLength(1);
    expect(screen.getByText('Guide ready.')).toBeTruthy();
  });
  it('keeps an active scheduled task out of chat, including repeated refreshes', () => {
    const view = conversation([{ ...wake, settledAt: null }], []);
    const { container, rerender } = render(<NeoPublicConversation conversation={view} />);
    rerender(<NeoPublicConversation conversation={view} />);
    expect(container.querySelector('[data-wake]')).toBeNull();
    expect(container.textContent).not.toContain(wake.title);
  });
  it('shows title and state in the work panel and keeps internal reasons behind more', () => {
    const internal = 'That ask was already settled as done after its todo completed.';
    const { container, rerender } = render(
      <NeoWakeRow entryKey="wake" wake={{ ...wake, summary: internal }} conversationId={id} />
    );
    const row = container.querySelector('details')!;
    expect(row.open).toBe(false);
    expect(row.querySelector('summary')?.textContent).toContain(wake.title);
    expect(row.querySelector('summary')?.textContent).toContain('Check-in finished');
    expect(row.querySelector('summary')?.textContent).not.toContain(internal);
    fireEvent.click(within(row).getByRole('button', { name: /more/i }));
    expect(row.open).toBe(true);
    expect(within(row).getByText(internal)).toBeTruthy();
    rerender(
      <NeoWakeRow entryKey="wake" wake={{ ...wake, settledAt: null }} conversationId={id} />
    );
    expect(row.querySelector('summary')?.textContent).toContain('Working…');
  });
});
