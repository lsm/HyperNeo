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
function page(name: string, after: number, count = after === 0 ? 50 : 1) {
  const items = Array.from({ length: count }, (_, index) => {
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
          fullText: `Fictional reply ${sequence}\n\n## Full reply ${sequence}\n\nRetained Markdown.`,
          links: [],
        };
  });
  return { ok: true, conversationId, items, nextAfter: after + items.length };
}
function saved(name: string, input: { after: number; before?: number; limit: number }) {
  const total = 51;
  const last =
    input.before === undefined
      ? Math.min(total, input.after + input.limit)
      : Math.min(total, input.before - 1);
  const first = input.before === undefined ? input.after + 1 : Math.max(1, last - input.limit + 1);
  const full = page(name, first - 1, Math.max(0, last - first + 1));
  return { ...full, nextAfter: full.items.at(-1)?.sequence ?? input.after };
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
      onLoadEarlier={() => {
        asks.loadEarlier();
        publications.loadEarlier();
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
  it('opens on the newest page and loads the first ask and reply on request', async () => {
    io.request.mockImplementation(async (_method, args) => saved(args.name, args.input));
    const { container } = render(<Probe />);
    await screen.findByText('Fictional reply 51');
    expect(screen.queryByText('Fictional reply 1')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Load more saved conversation' })).toBeNull();
    const control = await screen.findByRole('button', { name: 'Load earlier saved conversation' });
    const second = () =>
      container.querySelector(
        `[data-public-entry='${JSON.stringify([conversationId, 'publication', id(2)])}']`
      );
    await screen.findByText('Fictional reply 2');
    const entry = second();
    fireEvent.click(control);
    await screen.findByText('Fictional reply 1');
    expect(await screen.findByText('Fictional request 1')).toBeTruthy();
    const keys = [...container.querySelectorAll('[data-public-entry]')].map((item) =>
      item.getAttribute('data-public-entry')
    );
    expect(keys).toHaveLength(102);
    expect(new Set(keys).size).toBe(102);
    expect(second()).toBe(entry);
    expect(screen.queryByRole('button', { name: 'Load earlier saved conversation' })).toBeNull();
    expect(screen.queryByText('Showing part of your saved conversation.')).toBeNull();
    expect(
      io.request.mock.calls.map((call) => [
        call[1].name,
        call[1].input.after,
        call[1].input.before,
        call[1].input.limit,
      ])
    ).toEqual([
      ['neo.conversation.asks.read', 0, Number.MAX_SAFE_INTEGER, 50],
      ['neo.publication.read', 0, Number.MAX_SAFE_INTEGER, 50],
      ['neo.conversation.asks.read', 0, 2, 50],
      ['neo.publication.read', 0, 2, 50],
    ]);
  });

  it('retains entries after a failed earlier page and loads it once ready again', async () => {
    io.request.mockImplementation(async (_method, args) => saved(args.name, args.input));
    const { container } = render(<Probe />);
    await screen.findByText('Fictional reply 51');
    io.request.mockImplementation(async (_method, args) => {
      if (args.input.before === 2) throw new Error('Fictional unavailable page');
      return saved(args.name, args.input);
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Load earlier saved conversation' }));
    await screen.findByRole('button', { name: 'Retry saved conversation' });
    expect(screen.getByText('Fictional request 51')).toBeTruthy();
    expect(container.querySelectorAll('[data-public-entry]')).toHaveLength(100);
    io.request.mockImplementation(async (_method, args) => saved(args.name, args.input));
    fireEvent.click(screen.getByRole('button', { name: 'Retry saved conversation' }));
    await waitFor(() =>
      expect(
        (
          screen.getByRole('button', {
            name: 'Load earlier saved conversation',
          }) as HTMLButtonElement
        ).disabled
      ).toBe(false)
    );
    fireEvent.click(screen.getByRole('button', { name: 'Load earlier saved conversation' }));
    await screen.findByText('Fictional reply 1');
    await screen.findByText('Fictional request 1');
    expect(container.querySelectorAll('[data-public-entry]')).toHaveLength(102);
  });

  it('shows earlier history only when the owner can load it', () => {
    const { rerender } = render(
      <NeoPublicConversation conversation={{ ...empty, hasEarlier: true }} onRetry={vi.fn()} />
    );
    expect(screen.queryByRole('button', { name: 'Load earlier saved conversation' })).toBeNull();
    const earlier = vi.fn();
    rerender(
      <NeoPublicConversation
        conversation={{ ...empty, hasEarlier: true }}
        onLoadEarlier={earlier}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Load earlier saved conversation' }));
    expect(earlier).toHaveBeenCalledTimes(1);
    rerender(
      <NeoPublicConversation
        conversation={{ ...empty, status: 'loading', hasEarlier: true }}
        onLoadEarlier={earlier}
      />
    );
    expect(
      (screen.getByRole('button', { name: 'Load earlier saved conversation' }) as HTMLButtonElement)
        .disabled
    ).toBe(true);
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
