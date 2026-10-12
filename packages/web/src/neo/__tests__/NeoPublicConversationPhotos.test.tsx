import type {
  NeoConversationAskPageItem,
  NeoConversationImageRef,
} from '@hyperneo/shared/types/neo-conversation-ask';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NeoPublicConversation } from '../NeoPublicConversation.tsx';
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
