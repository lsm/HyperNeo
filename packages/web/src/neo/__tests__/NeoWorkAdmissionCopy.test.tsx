import { cleanup, render, screen } from '@testing-library/preact';
import { signal } from '@preact/signals';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NeoLive } from '../NeoLive.tsx';
import { connectionState } from '../../lib/state.ts';

const useNeoMock = vi.hoisted(() => vi.fn());
vi.mock('../useNeo.ts', () => ({ useNeo: useNeoMock }));
vi.mock('../NeoComposer.tsx', () => ({ NeoComposer: () => null }));
vi.mock('../NeoConversation.tsx', () => ({ NeoConversation: () => null }));
vi.mock('../../islands/ToastContainer.tsx', () => ({ default: () => null }));

beforeEach(() => {
  connectionState.value = 'connected';
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    }
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Neo empty-conversation admission guidance', () => {
  it.each([false, true])(
    'distinguishes clear instructions from proposals in public=%s',
    (publicMode) => {
      const sessionId = 'neo:10000000-0000-4000-8000-000000000001';
      const snapshot = {
        ok: true,
        sessionId,
        concerns: [
          {
            id: 'garden',
            title: 'Fictional garden',
            summary: 'S',
            context: 'C',
            revision: 1,
            createdAt: 1,
            updatedAt: 1,
          },
        ],
        work: [],
        consultations: [],
      };
      const act = vi.fn();
      useNeoMock.mockReturnValue({
        sessionId,
        selectedId: null,
        snapshot,
        viewSnapshot: snapshot,
        viewPublicConversation: publicMode
          ? {
              conversationId: sessionId.slice(4),
              status: 'ready',
              entries: [],
              hasEarlier: false,
              hasMore: false,
            }
          : undefined,
        error: null,
        setError: vi.fn(),
        open: vi.fn(),
        act,
        busyWork: null,
        asks: { retry: vi.fn() },
        publications: { refresh: vi.fn() },
        store: {
          sessionInfo: signal({ metadata: {} }),
          sdkMessages: signal([]),
          messagesLoaded: signal(true),
          activeSessionId: signal(sessionId),
          loadErrorKind: signal(null),
          agentState: signal({ status: 'idle' }),
          error: signal(null),
          hasMoreMessages: signal(false),
          isWorking: signal(false),
        },
      });
      render(<NeoLive />);
      expect(screen.getByText(/A clear work request can start work/).textContent).toContain(
        'Proposal-only requests wait for the card’s Start work button.'
      );
      expect(screen.queryByText(/Work starts when you approve its card/)).toBeNull();
      expect(screen.queryByRole('button', { name: 'Start work', exact: true })).toBeNull();
      expect(act).not.toHaveBeenCalled();
      expect(screen.getByRole('heading', { name: 'A little less on your mind.' })).toBeTruthy();
    }
  );
});
