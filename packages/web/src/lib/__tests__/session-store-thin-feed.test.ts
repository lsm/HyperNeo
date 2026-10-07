import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@hyperneo/shared';

const mockHub = {
  request: vi.fn(),
  onEvent: vi.fn(() => vi.fn()),
  onConnection: vi.fn(() => vi.fn()),
  joinChannel: vi.fn(),
  leaveChannel: vi.fn(),
  isConnected: vi.fn(() => true),
  getHubIfConnected: vi.fn(() => mockHub),
};

vi.mock('../connection-manager', () => ({
  connectionManager: {
    getHub: vi.fn(() => Promise.resolve(mockHub)),
    getHubIfConnected: vi.fn(() => mockHub),
  },
}));
vi.mock('../signals', () => ({ slashCommandsSignal: { value: [] } }));
vi.mock('../toast', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));

import { SessionStore, sessionStore } from '../session-store';

const subscribedQueries = () =>
  mockHub.request.mock.calls
    .filter(([method]) => method === 'liveQuery.subscribe')
    .map(([, data]) => (data as { queryName: string }).queryName);

describe('SessionStore message detail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHub.request.mockImplementation(async (method: string) =>
      method === 'message.sdkMessage'
        ? {
            sdkMessage: {
              type: 'assistant',
              uuid: 'a-1',
              message: { content: [{ type: 'text', text: 'full body' }] },
            },
          }
        : { acknowledged: true }
    );
  });
  afterEach(async () => {
    await sessionStore.select(null);
  });

  it('subscribes compact chats to the thin feed and switches back for full', async () => {
    await sessionStore.select('session-1');
    expect(subscribedQueries()).toEqual(['messages.bySession.compact']);

    sessionStore.setMessageDetail('full');
    sessionStore.setMessageDetail('full');

    expect(subscribedQueries()).toEqual(['messages.bySession.compact', 'messages.bySession']);
  });

  it('swaps a thinned message for its capped full version', async () => {
    await sessionStore.select('session-1');
    sessionStore.sdkMessages.value = [
      { type: 'assistant', uuid: 'a-1', thinned: true, timestamp: 5, message: { content: [] } },
    ] as unknown as ChatMessage[];

    await sessionStore.hydrateMessages(['a-1', 'missing']);

    expect(mockHub.request).toHaveBeenCalledWith('message.sdkMessage', {
      sessionId: 'session-1',
      messageUuid: 'a-1',
      capped: true,
    });
    expect(sessionStore.sdkMessages.value).toEqual([
      {
        type: 'assistant',
        uuid: 'a-1',
        timestamp: 5,
        message: { content: [{ type: 'text', text: 'full body' }] },
      },
    ]);
  });

  it('keeps a store that does not follow the display mode on the full feed', async () => {
    const neoStore = new SessionStore();
    await neoStore.select('session-2');
    neoStore.setMessageDetail('compact');
    expect(subscribedQueries()).toEqual(['messages.bySession']);
    await neoStore.select(null);
  });
});
