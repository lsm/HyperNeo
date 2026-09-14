// @ts-nocheck

import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  deletedHandler: null,
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
    }),
  },
}));

vi.mock('../state.ts', () => ({
  connectionState: {
    value: 'connected',
    subscribe: () => () => {},
  },
}));

import {
  composerAttachmentsSignal,
  readPendingComposerAttachments,
  writePendingComposerAttachments,
} from '../composer-attachment-store.ts';

const attachmentA = { data: 'AAAA', media_type: 'image/png', name: 'a.png', size: 4 };
const attachmentB = { data: 'BBBB', media_type: 'image/png', name: 'b.png', size: 4 };

describe('composer attachment store session.deleted purge', () => {
  beforeEach(() => {
    composerAttachmentsSignal.value = {};
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
