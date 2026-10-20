import type { NeoConversationWake } from '@hyperneo/shared/types/neo-wake';
import type { NeoPublication } from '@hyperneo/shared/types/neo-publication';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NeoPublicConversation } from '../NeoPublicConversation.tsx';
import { presentNeoPublicConversation } from '../public-conversation.ts';
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
  return presentNeoPublicConversation(sources);
};
const originalLocale = locale.value;
afterEach(() => {
  cleanup();
  locale.value = originalLocale;
});

describe('scheduled wake disclosures in the public conversation', () => {
  it('folds the attributed publication under one closed row with time, title and summary', () => {
    const { container } = render(<NeoPublicConversation conversation={conversation()} />);
    const row = container.querySelector<HTMLDetailsElement>('[data-wake]')!;
    expect(row).toBeTruthy();
    expect(row.open).toBe(false);
    expect(row.querySelector('summary')?.textContent).toContain(wake.title);
    expect(row.querySelector('summary')?.textContent).toContain(wake.summary);
    expect(row.querySelector('time')?.dateTime).toBe(new Date(firedAt).toISOString());
    const message = container.querySelector('[data-message-ref="publication-one"]');
    expect(message?.closest('[data-wake]')).toBe(row);
    expect(container.querySelectorAll('[data-message-ref="publication-one"]')).toHaveLength(1);
    expect(within(row).getByRole('link', { name: 'Which language?' }).getAttribute('href')).toBe(
      '#neo-ref-question-question-one'
    );
    expect(within(row).getByText('Guide reviewed.').closest('a')).toBeNull();
  });
  it('navigates work additions without changing their labels or asking extra questions', () => {
    const open = vi.fn();
    const props = { conversation: conversation(), onOpenWork: open };
    render(<NeoPublicConversation {...props} />);
    fireEvent.click(screen.getByRole('link', { name: 'Review guide' }));
    expect(open).toHaveBeenCalledWith('neo-ref-todo-todo-one');
  });
  it('keeps an active wake working until settlement and preserves its disclosure through refresh', () => {
    const { container, rerender } = render(
      <NeoPublicConversation conversation={conversation([{ ...wake, settledAt: null }])} />
    );
    const row = container.querySelector<HTMLDetailsElement>('[data-wake]')!;
    expect(row.querySelector('summary')?.textContent).toContain('Working…');
    expect(row.querySelector('summary')?.textContent).not.toContain(wake.summary);
    row.open = true;
    rerender(<NeoPublicConversation conversation={conversation()} />);
    expect(container.querySelector('[data-wake]')).toBe(row);
    expect(row.open).toBe(true);
    expect(row.querySelector('summary')?.textContent).toContain(wake.summary);
  });
  it('retains empty wakes and leaves unrelated publications outside the disclosure', () => {
    const other = { ...publication, publicationId: 'other', sequence: 2 };
    const { container } = render(
      <NeoPublicConversation
        conversation={conversation([{ ...wake, summary: null, additions: [] }], [other])}
      />
    );
    expect(container.querySelector('[data-wake] summary')?.textContent).toContain(
      'Check-in finished'
    );
    expect(
      container.querySelector('[data-message-ref="other"]')?.closest('[data-wake]')
    ).toBeNull();
    expect(container.querySelector('[data-message-ref="other"]')).toBeTruthy();
  });
  it('uses Chinese labels for an active wake', () => {
    locale.value = 'zh-Hans';
    const { container } = render(
      <NeoPublicConversation
        conversation={conversation([{ ...wake, settledAt: null, additions: [] }], [])}
      />
    );
    expect(container.querySelector('summary')?.textContent).toContain('正在处理');
  });
});
