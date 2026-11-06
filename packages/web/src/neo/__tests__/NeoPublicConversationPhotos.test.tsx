import type {
  NeoConversationAskPageItem,
  NeoConversationImageRef,
} from '@hyperneo/shared/types/neo-conversation-ask';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NeoPublicConversation, PendingAsk } from '../NeoPublicConversation.tsx';
import { projectNeoPublicConversation } from '../public-conversation.ts';

const request = vi.hoisted(() => vi.fn());
vi.mock('../../lib/connection-manager.ts', () => ({
  connectionManager: { getHub: async () => ({ request }) },
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const conversationId = '10000000-0000-4000-8000-000000000001';
const root = `neo:${conversationId}`;
let refs = 0;
const ref = (fields: Partial<NeoConversationImageRef> = {}): NeoConversationImageRef => ({
  type: 'image_ref',
  imageId: `ref-${++refs}`,
  mediaType: 'image/png',
  bytes: 5,
  width: 1200,
  height: 800,
  thumbnail: { mediaType: 'image/jpeg', data: 'dGh1bWI=' },
  ...fields,
});
const view = (content: NeoConversationAskPageItem['content']) => {
  const ask: NeoConversationAskPageItem = {
    conversationId,
    requestId: 'photo-ask',
    askOrigin: { sessionId: root, messageId: 'photo-ask' },
    content,
    sequence: 1,
    createdAt: '2026-09-30T12:00:00Z',
  };
  const empty = { conversationId, status: 'ready' as const, hasMore: false, hasEarlier: false };
  return projectNeoPublicConversation(
    root,
    { ...empty, items: [ask], nextAfter: 1 },
    { ...empty, items: [], nextAfter: 0 }
  );
};
const full = { ok: true, imageId: '1:0', mediaType: 'image/png', data: 'ZnVsbA==' };

describe('public ask photo references', () => {
  it('puts sent photos before a right-aligned words bubble and opens them full size', () => {
    const { container } = render(
      <NeoPublicConversation
        conversation={view([
          { type: 'text', text: 'The lamp flickers' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aW4=' } },
        ])}
      />
    );
    const photo = screen.getByRole('img', { name: 'Attached photo 1' });
    const bubble = container.querySelector('.neo-message-bubble')!;
    expect(bubble.contains(photo)).toBe(false);
    expect(photo.compareDocumentPosition(bubble) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(photo.closest('.justify-end')).toBeTruthy();
    fireEvent.click(photo);
    expect(screen.getByRole('dialog', { name: 'Attached photo 1' })).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('omits the photo-only bubble, dummy words and reply action', () => {
    const { container } = render(
      <NeoPublicConversation
        conversation={view([{ type: 'text', text: 'Attached files' }, ref()])}
        onQuote={vi.fn()}
      />
    );
    expect(container.querySelector('.neo-message-bubble')).toBeNull();
    expect(screen.queryByText('Attached files')).toBeNull();
    expect(screen.getByRole('button', { name: 'Copy your message' }).hasAttribute('disabled')).toBe(
      true
    );
    expect(screen.queryByRole('button', { name: 'Reply to your message' })).toBeNull();
    fireEvent.contextMenu(container.querySelector('article')!);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('keeps retry and edit on a failed photo-only send and keeps a quoted bubble', () => {
    const onRetry = vi.fn();
    const onEdit = vi.fn();
    const ask = {
      requestId: 'pending-photo',
      sessionId: root,
      text: 'Attached files',
      images: [{ media_type: 'image/png' as const, data: 'aW4=' }],
      createdAt: '2026-09-30T12:00:00Z',
      state: 'failed' as const,
    };
    const result = render(<PendingAsk ask={ask} onRetry={onRetry} onEdit={onEdit} />);
    expect(result.container.querySelector('.neo-message-bubble')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(onRetry).toHaveBeenCalledWith(ask.requestId);
    expect(onEdit).toHaveBeenCalledWith(ask.requestId);
    result.rerender(
      <PendingAsk
        ask={{
          ...ask,
          quote: {
            author: 'Neo',
            text: 'Which lamp?',
            anchor: 'lamp',
            replyTo: { kind: 'message', id: 'lamp' },
          },
        }}
      />
    );
    expect(result.container.querySelector('.neo-message-bubble')).toBeTruthy();
    expect(screen.getByText('Which lamp?')).toBeTruthy();
    expect(screen.queryByText('Attached files')).toBeNull();
    result.rerender(
      <PendingAsk
        ask={{
          ...ask,
          previewContext: {
            artifactId: 'photo-report',
            snapshot: 'a'.repeat(64),
            displayName: 'Lamp report',
            state: 'available',
          },
        }}
      />
    );
    expect(result.container.querySelector('.neo-message-bubble')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Preview.*Lamp report/ })).toBeTruthy();
  });

  it('shows a thumbnail sized from the photo, then the full photo once opened', async () => {
    const photo = ref();
    request.mockResolvedValue({ ...full, imageId: photo.imageId });
    render(<NeoPublicConversation conversation={view([photo])} />);
    const open = screen.getByRole('button', { name: 'Open attached photo 1' });
    expect(open.getAttribute('style')).toContain('width: 384px');
    expect(open.getAttribute('style')).toContain('aspect-ratio: 1200 / 800');
    expect(screen.getByRole('img', { name: 'Attached photo 1' }).getAttribute('src')).toBe(
      'data:image/jpeg;base64,dGh1bWI='
    );
    fireEvent.click(open);
    await waitFor(() =>
      expect(screen.getByRole('img', { name: 'Attached photo 1' }).getAttribute('src')).toBe(
        'data:image/png;base64,ZnVsbA=='
      )
    );
    expect(request).toHaveBeenCalledExactlyOnceWith('operation.invoke', {
      name: 'neo.conversation.image.read',
      input: { conversationId, imageId: photo.imageId },
    });
    expect(screen.queryByRole('button', { name: 'Open attached photo 1' })).toBeNull();
  });

  it('shows a placeholder for a photo without a thumbnail', () => {
    render(
      <NeoPublicConversation
        conversation={view([ref({ imageId: '2:0', thumbnail: null, width: null, height: null })])}
      />
    );
    const placeholder = screen.getByRole('img', { name: 'Attached photo 1' });
    expect(placeholder.tagName).toBe('SPAN');
    expect(
      screen.getByRole('button', { name: 'Open attached photo 1' }).getAttribute('style')
    ).toContain('height: 8rem');
  });

  it('shows loading, then a retryable error when the full photo cannot be read', async () => {
    let fail!: (value: unknown) => void;
    request.mockImplementationOnce(() => new Promise((resolve) => (fail = resolve)));
    render(<NeoPublicConversation conversation={view([ref({ imageId: '3:0' })])} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open attached photo 1' }));
    expect(await screen.findByRole('status', { name: 'Loading photo' })).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Open attached photo 1' }).hasAttribute('disabled')
    ).toBe(true);
    fail({ ok: false, reason: 'image_not_found' });
    const retry = await screen.findByRole('button', { name: 'Photo could not load. Retry' });
    expect(screen.queryByRole('status', { name: 'Loading photo' })).toBeNull();
    request.mockResolvedValueOnce({ ...full, imageId: '3:0' });
    fireEvent.click(retry);
    await waitFor(() =>
      expect(screen.getByRole('img', { name: 'Attached photo 1' }).getAttribute('src')).toBe(
        'data:image/png;base64,ZnVsbA=='
      )
    );
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('loads the full photo by itself once it scrolls into view, and keeps it', async () => {
    const seen: Array<() => void> = [];
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(private readonly callback: IntersectionObserverCallback) {}
        observe() {
          seen.push(() =>
            this.callback(
              [{ isIntersecting: true } as IntersectionObserverEntry],
              this as unknown as IntersectionObserver
            )
          );
        }
        disconnect() {}
      }
    );
    request.mockResolvedValue({ ...full, imageId: '5:0' });
    const conversation = view([ref({ imageId: '5:0', thumbnail: null })]);
    const first = render(<NeoPublicConversation conversation={conversation} />);
    expect(request).not.toHaveBeenCalled();
    seen[0]();
    await waitFor(() =>
      expect(screen.getByRole('img', { name: 'Attached photo 1' }).getAttribute('src')).toBe(
        'data:image/png;base64,ZnVsbA=='
      )
    );
    first.unmount();
    render(<NeoPublicConversation conversation={conversation} />);
    expect(screen.getByRole('img', { name: 'Attached photo 1' }).getAttribute('src')).toBe(
      'data:image/png;base64,ZnVsbA=='
    );
    expect(request).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it('keeps inline photos from older daemons unchanged beside references', () => {
    render(
      <NeoPublicConversation
        conversation={view([
          { type: 'image', source: { type: 'base64', media_type: 'image/webp', data: 'aW4=' } },
          ref({ imageId: '1:1' }),
        ])}
      />
    );
    expect(screen.getByRole('img', { name: 'Attached photo 1' }).getAttribute('src')).toBe(
      'data:image/webp;base64,aW4='
    );
    expect(screen.getByRole('button', { name: 'Open attached photo 2' })).toBeTruthy();
    expect(request).not.toHaveBeenCalled();
  });
});
