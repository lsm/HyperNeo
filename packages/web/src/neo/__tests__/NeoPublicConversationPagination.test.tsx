import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NeoPublicConversation } from '../NeoPublicConversation.tsx';
import {
  projectNeoPublicConversation,
  type NeoPublicConversation as Conversation,
} from '../public-conversation.ts';
import { useNeoPublications } from '../useNeoPublications.ts';
import { useNeoConversationAsks } from '../useNeoConversationAsks.ts';

const io = vi.hoisted(() => ({ request: vi.fn(), listeners: new Set<() => void>() }));
vi.mock('../../lib/connection-manager.ts', () => ({
  connectionManager: {
    getHub: async () => ({
      request: io.request,
      onEvent: (_name: string, callback: () => void) => {
        io.listeners.add(callback);
        return () => io.listeners.delete(callback);
      },
      onConnection: () => () => {},
    }),
  },
}));
const conversationId = '10000000-0000-4000-8000-000000000001';
const root = `neo:${conversationId}`;
const id = (number: number) => `20000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
function page(name: string, after: number) {
  const items = Array.from({ length: after === 0 ? 50 : 1 }, (_, index) => {
    const sequence = after + index + 1;
    const common = {
      conversationId,
      sequence,
      createdAt: '2026-10-02T00:00:00Z',
      askOrigin: { sessionId: root, messageId: id(sequence) },
    };
    return name === 'neo.conversation.asks.read'
      ? {
          ...common,
          requestId: id(sequence),
          content: [{ type: 'text', text: `Fictional request ${sequence}` }],
        }
      : {
          ...common,
          publicationId: id(sequence),
          producerInput: common.askOrigin,
          shortText: `Fictional reply ${sequence}`,
          fullText: `## Full reply ${sequence}\n\nRetained Markdown.`,
          links: [],
        };
  });
  return { ok: true, conversationId, items, nextAfter: after + items.length };
}
function Probe() {
  const asks = useNeoConversationAsks(root);
  const publications = useNeoPublications(root);
  return (
    <NeoPublicConversation
      conversation={projectNeoPublicConversation(root, asks, publications)}
      onRetry={() => {
        asks.retry();
        publications.refresh();
      }}
    />
  );
}
const empty: Conversation = {
  conversationId,
  status: 'ready',
  entries: [],
  hasMore: false,
  hasEarlier: false,
};
beforeEach(() => {
  io.request.mockImplementation(async (_method, args) => page(args.name, args.input.after));
});
afterEach(() => {
  cleanup();
  expect(io.listeners.size).toBe(0);
  vi.resetAllMocks();
});

describe('NeoPublicConversation saved pagination', () => {
  it('loads the 51st ask and reply through the existing real paged readers', async () => {
    const { container } = render(<Probe />);
    await screen.findByText('Fictional reply 50');
    const control = await screen.findByRole('button', { name: 'Load more saved conversation' });
    const detail = container.querySelector('details')!;
    detail.open = true;
    fireEvent(detail, new Event('toggle'));
    await screen.findByRole('heading', { name: 'Full reply 1' });
    fireEvent.click(control);
    await screen.findByText('Fictional reply 51');
    expect(await screen.findByText('Fictional request 51')).toBeTruthy();
    expect(container.querySelectorAll('[data-public-entry]')).toHaveLength(102);
    const keys = [...container.querySelectorAll('[data-public-entry]')].map((item) =>
      item.getAttribute('data-public-entry')
    );
    expect(new Set(keys).size).toBe(102);
    expect(container.querySelector('details')).toBe(detail);
    expect(detail.open).toBe(true);
    expect(screen.getByRole('heading', { name: 'Full reply 1' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Load more saved conversation' })).toBeNull();
    expect(screen.queryByText('Showing part of your saved conversation.')).toBeNull();
    expect(
      io.request.mock.calls.map((call) => [call[1].name, call[1].input.after, call[1].input.limit])
    ).toEqual([
      ['neo.conversation.asks.read', 0, 50],
      ['neo.publication.read', 0, 50],
      ['neo.publication.read', 50, 50],
      ['neo.conversation.asks.read', 50, 50],
    ]);
  });

  it('retains entries and exposes the existing retry after a failed continuation', async () => {
    const { container } = render(<Probe />);
    await screen.findByText('Fictional reply 50');
    io.request.mockImplementation(async (_method, args) => {
      if (args.input.after === 50) throw new Error('Fictional unavailable page');
      return page(args.name, args.input.after);
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Load more saved conversation' }));
    await screen.findByRole('button', { name: 'Retry saved conversation' });
    expect(screen.getByText('Fictional request 1')).toBeTruthy();
    expect(container.querySelectorAll('[data-public-entry]')).toHaveLength(100);
    io.request.mockImplementation(async (_method, args) => page(args.name, args.input.after));
    fireEvent.click(screen.getByRole('button', { name: 'Retry saved conversation' }));
    await screen.findByText('Fictional reply 51');
    await screen.findByText('Fictional request 51');
    expect(container.querySelectorAll('[data-public-entry]')).toHaveLength(102);
  });

  it.each(['loading', 'unavailable'] as const)('does not permit load-more while %s', (status) => {
    const retry = vi.fn();
    render(
      <NeoPublicConversation conversation={{ ...empty, status, hasMore: true }} onRetry={retry} />
    );
    const button = screen.getByRole('button', {
      name: 'Load more saved conversation',
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(retry).not.toHaveBeenCalled();
  });

  it.each([
    { hasMore: false, hasEarlier: false },
    { hasMore: false, hasEarlier: true },
  ])('does not offer a useless next page for %j', (flags) => {
    render(<NeoPublicConversation conversation={{ ...empty, ...flags }} onRetry={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Load more saved conversation' })).toBeNull();
  });

  it('does not invent an inert control without the existing owner callback', () => {
    render(<NeoPublicConversation conversation={{ ...empty, hasMore: true }} />);
    expect(screen.queryByRole('button', { name: 'Load more saved conversation' })).toBeNull();
  });
});
