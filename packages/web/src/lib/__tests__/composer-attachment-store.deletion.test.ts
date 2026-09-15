// @ts-nocheck

import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  deletedHandler: null,
  connectionListeners: [] as Array<(state: unknown) => void>,
  requestImpl: vi.fn(async () => ({ session: { id: 'session-a' } })),
}));

vi.mock('../connection-manager', () => ({
  connectionManager: {
    getHubIfConnected: () => ({
      onEvent: (topic, handler) => {
        if (topic === 'session.deleted') {
          h.deletedHandler = handler;
        }
        return () => {
          if (h.deletedHandler === handler) {
            h.deletedHandler = null;
          }
        };
      },
      request: (method: string, params: unknown) => h.requestImpl(method, params),
    }),
  },
}));

vi.mock('../state.ts', () => ({
  connectionState: {
    value: 'connected',
    subscribe: (listener) => {
      h.connectionListeners.push(listener);
      return () => {};
    },
  },
}));

import {
  composerAttachmentsSignal,
  readPendingComposerAttachments,
  writePendingComposerAttachments,
} from '../composer-attachment-store.ts';

const attachmentA = { data: 'AAAA', media_type: 'image/png', name: 'a.png', size: 4 };
const attachmentB = { data: 'BBBB', media_type: 'image/png', name: 'b.png', size: 4 };

function flushAsync() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('composer attachment store session.deleted purge', () => {
  beforeEach(() => {
    composerAttachmentsSignal.value = {};
    h.requestImpl.mockReset();
    h.requestImpl.mockResolvedValue({ session: { id: 'session-a' } });
  });

  it('registers a session.deleted subscription on the first persisted write', () => {
    writePendingComposerAttachments('session-a', [attachmentA]);

    expect(h.deletedHandler).toBeTruthy();
  });

  it('purges only the deleted session entry', () => {
    writePendingComposerAttachments('session-a', [attachmentA]);
    writePendingComposerAttachments('session-b', [attachmentB]);

    h.deletedHandler({ sessionId: 'session-a' });

    expect(readPendingComposerAttachments('session-a')).toEqual([]);
    expect(readPendingComposerAttachments('session-b')).toEqual([attachmentB]);
  });

  it('ignores deletion events without a sessionId', () => {
    writePendingComposerAttachments('session-a', [attachmentA]);

    h.deletedHandler({});
    h.deletedHandler(undefined);

    expect(readPendingComposerAttachments('session-a')).toEqual([attachmentA]);
  });
});

describe('composer attachment store reconnect reconciliation', () => {
  beforeEach(() => {
    composerAttachmentsSignal.value = {};
    h.requestImpl.mockReset();
    h.requestImpl.mockResolvedValue({ session: { id: 'session-a' } });
  });

  it('drops sessions that no longer exist when the connection recovers', async () => {
    writePendingComposerAttachments('session-a', [attachmentA]);
    h.requestImpl.mockRejectedValueOnce(new Error('Session not found'));

    h.connectionListeners.forEach((listener) => listener('connected'));
    await flushAsync();

    expect(readPendingComposerAttachments('session-a')).toEqual([]);
    expect(h.requestImpl).toHaveBeenCalledWith('session.get', { sessionId: 'session-a' });
  });

  it('keeps sessions on transient request failures', async () => {
    writePendingComposerAttachments('session-a', [attachmentA]);
    h.requestImpl.mockRejectedValueOnce(new Error('request timed out'));

    h.connectionListeners.forEach((listener) => listener('connected'));
    await flushAsync();

    expect(readPendingComposerAttachments('session-a')).toEqual([attachmentA]);
  });

  it('skips pending target buckets during reconciliation', async () => {
    writePendingComposerAttachments('pending:target-b', [attachmentA]);

    h.connectionListeners.forEach((listener) => listener('connected'));
    await flushAsync();

    expect(h.requestImpl).not.toHaveBeenCalled();
    expect(readPendingComposerAttachments('pending:target-b')).toEqual([attachmentA]);
  });
});
