// @ts-nocheck

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/preact';
import { signal } from '@preact/signals';
import type { Session } from '@hyperneo/shared';
import { useSendMessage } from '../useSendMessage.ts';

const mockConnectionState = signal<'connected' | 'disconnected' | 'connecting'>('connected');

vi.mock('../../lib/state', () => ({
  connectionState: {
    get value() {
      return mockConnectionState.value;
    },
  },
}));

const mockRequest = vi.fn();
const mockGetHubIfConnected = vi.fn();

vi.mock('../../lib/connection-manager', () => ({
  connectionManager: {
    getHubIfConnected: () => mockGetHubIfConnected(),
  },
}));

const mockToastSuccess = vi.fn();
const mockToastError = vi.fn();
const mockToastInfo = vi.fn();

vi.mock('../../lib/toast', () => ({
  toast: {
    success: (msg: string) => mockToastSuccess(msg),
    error: (msg: string) => mockToastError(msg),
    info: (msg: string) => mockToastInfo(msg),
  },
}));

vi.mock('../../lib/outbound-queue', () => ({
  enqueueAction: vi.fn(() => Promise.resolve({ id: 'queue-1', label: 'Test', status: 'pending' })),
}));

vi.mock('../../lib/user-error', () => ({
  sanitizeUserError: (err: unknown) => {
    if (err instanceof Error) return err.message;
    if (typeof err === 'string') return err;
    return 'Something went wrong.';
  },
}));

describe('useSendMessage', () => {
  const defaultSession: Session = {
    id: 'session-1',
    title: 'Test Session',
    status: 'active',
    createdAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
    workspacePath: '/test',
    config: {},
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockConnectionState.value = 'connected';
    mockGetHubIfConnected.mockReturnValue({ request: mockRequest });
    mockRequest.mockResolvedValue({});
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  describe('initialization', () => {
    it('should provide sendMessage function', () => {
      const { result } = renderHook(() =>
        useSendMessage({
          sessionId: 'session-1',
          session: defaultSession,
          isSending: false,
          onSendStart: vi.fn(),
          onSendComplete: vi.fn(),
          onError: vi.fn(),
        })
      );

      expect(typeof result.current.sendMessage).toBe('function');
    });

    it('should provide clearSendTimeout function', () => {
      const { result } = renderHook(() =>
        useSendMessage({
          sessionId: 'session-1',
          session: defaultSession,
          isSending: false,
          onSendStart: vi.fn(),
          onSendComplete: vi.fn(),
          onError: vi.fn(),
        })
      );

      expect(typeof result.current.clearSendTimeout).toBe('function');
    });
  });

  describe('sendMessage validation', () => {
    it('should not send empty message', async () => {
      const onSendStart = vi.fn();

      const { result } = renderHook(() =>
        useSendMessage({
          sessionId: 'session-1',
          session: defaultSession,
          isSending: false,
          onSendStart,
          onSendComplete: vi.fn(),
          onError: vi.fn(),
        })
      );

      await act(async () => {
        await result.current.sendMessage('');
      });

      expect(onSendStart).not.toHaveBeenCalled();
      expect(mockRequest).not.toHaveBeenCalled();
    });

    it('should not send whitespace-only message', async () => {
      const onSendStart = vi.fn();

      const { result } = renderHook(() =>
        useSendMessage({
          sessionId: 'session-1',
          session: defaultSession,
          isSending: false,
          onSendStart,
          onSendComplete: vi.fn(),
          onError: vi.fn(),
        })
      );

      await act(async () => {
        await result.current.sendMessage('   ');
      });

      expect(onSendStart).not.toHaveBeenCalled();
    });

    it('should not send if already sending', async () => {
      const onSendStart = vi.fn();

      const { result } = renderHook(() =>
        useSendMessage({
          sessionId: 'session-1',
          session: defaultSession,
          isSending: true,
          onSendStart,
          onSendComplete: vi.fn(),
          onError: vi.fn(),
        })
      );

      await act(async () => {
        await result.current.sendMessage('Hello');
      });

      expect(onSendStart).not.toHaveBeenCalled();
    });

    it('should send while processing when queueing is enabled', async () => {
      const onSendStart = vi.fn();

      const { result } = renderHook(() =>
        useSendMessage({
          sessionId: 'session-1',
          session: defaultSession,
          isSending: true,
          allowQueueWhileProcessing: true,
          onSendStart,
          onSendComplete: vi.fn(),
          onError: vi.fn(),
        })
      );

      await act(async () => {
        await result.current.sendMessage('Queued message');
      });

      expect(onSendStart).toHaveBeenCalled();
      expect(mockRequest).toHaveBeenCalledWith('message.send', {
        sessionId: 'session-1',
        content: 'Queued message',
        images: undefined,
      });
    });
  });

  describe('archived session handling', () => {
    it('should not send to archived session', async () => {
      const archivedSession: Session = {
        ...defaultSession,
        status: 'archived',
      };

      const onSendStart = vi.fn();

      const { result } = renderHook(() =>
        useSendMessage({
          sessionId: 'session-1',
          session: archivedSession,
          isSending: false,
          onSendStart,
          onSendComplete: vi.fn(),
          onError: vi.fn(),
        })
      );

      await act(async () => {
        await result.current.sendMessage('Hello');
      });

      expect(onSendStart).not.toHaveBeenCalled();
      expect(mockToastError).toHaveBeenCalledWith('Cannot send messages to archived sessions');
    });
  });

  describe('connection state handling', () => {
    it('should not send when disconnected', async () => {
      mockConnectionState.value = 'disconnected';

      const onSendStart = vi.fn();

      const { result } = renderHook(() =>
        useSendMessage({
          sessionId: 'session-1',
          session: defaultSession,
          isSending: false,
          onSendStart,
          onSendComplete: vi.fn(),
          onError: vi.fn(),
        })
      );

      await act(async () => {
        await result.current.sendMessage('Hello');
      });

      expect(onSendStart).not.toHaveBeenCalled();
      expect(mockToastInfo).toHaveBeenCalledWith('Message queued — will send when reconnected.');
    });

    it('should not send when connecting', async () => {
      mockConnectionState.value = 'connecting';

      const onSendStart = vi.fn();

      const { result } = renderHook(() =>
        useSendMessage({
          sessionId: 'session-1',
          session: defaultSession,
          isSending: false,
          onSendStart,
          onSendComplete: vi.fn(),
          onError: vi.fn(),
        })
      );

      await act(async () => {
        await result.current.sendMessage('Hello');
      });

      expect(onSendStart).not.toHaveBeenCalled();
      expect(mockToastInfo).toHaveBeenCalledWith('Message queued — will send when reconnected.');
    });
  });

  describe('successful message sending', () => {
    it('should send message successfully', async () => {
      const onSendStart = vi.fn();
      const onSendComplete = vi.fn();

      const { result } = renderHook(() =>
        useSendMessage({
          sessionId: 'session-1',
          session: defaultSession,
          isSending: false,
          onSendStart,
          onSendComplete,
          onError: vi.fn(),
        })
      );

      await act(async () => {
        await result.current.sendMessage('Hello');
      });

      expect(onSendStart).toHaveBeenCalled();
      expect(mockRequest).toHaveBeenCalledWith('message.send', {
        sessionId: 'session-1',
        content: 'Hello',
        images: undefined,
      });
    });

    it('should notify message accepted callback with messageId', async () => {
      mockRequest.mockResolvedValueOnce({ messageId: 'msg-accepted-1' });
      const onMessageAccepted = vi.fn();

      const { result } = renderHook(() =>
        useSendMessage({
          sessionId: 'session-1',
          session: defaultSession,
          isSending: false,
          onSendStart: vi.fn(),
          onSendComplete: vi.fn(),
          onError: vi.fn(),
          onMessageAccepted,
        })
      );

      await act(async () => {
        await result.current.sendMessage('Hello');
      });

      expect(onMessageAccepted).toHaveBeenCalledWith('msg-accepted-1');
    });

    it('should send message with images', async () => {
      const onSendStart = vi.fn();

      const { result } = renderHook(() =>
        useSendMessage({
          sessionId: 'session-1',
          session: defaultSession,
          isSending: false,
          onSendStart,
          onSendComplete: vi.fn(),
          onError: vi.fn(),
        })
      );

      const images = [{ type: 'base64' as const, mediaType: 'image/png' as const, data: 'abc123' }];

      await act(async () => {
        await result.current.sendMessage('Hello with image', images);
      });

      expect(mockRequest).toHaveBeenCalledWith('message.send', {
        sessionId: 'session-1',
        content: 'Hello with image',
        images,
      });
    });

    it('should include deliveryMode when sending next-turn message', async () => {
      const { result } = renderHook(() =>
        useSendMessage({
          sessionId: 'session-1',
          session: defaultSession,
          isSending: false,
          onSendStart: vi.fn(),
          onSendComplete: vi.fn(),
          onError: vi.fn(),
        })
      );

      await act(async () => {
        await result.current.sendMessage('Queue this', undefined, 'defer');
      });

      expect(mockRequest).toHaveBeenCalledWith('message.send', {
        sessionId: 'session-1',
        content: 'Queue this',
        images: undefined,
        deliveryMode: 'defer',
      });
    });
  });

  describe('hub connection handling', () => {
    it('should queue message when hub disappears during send', async () => {
      mockGetHubIfConnected.mockReturnValue(null);

      const onSendStart = vi.fn();
      const onSendComplete = vi.fn();

      const { result } = renderHook(() =>
        useSendMessage({
          sessionId: 'session-1',
          session: defaultSession,
          isSending: false,
          onSendStart,
          onSendComplete,
          onError: vi.fn(),
        })
      );

      await act(async () => {
        await result.current.sendMessage('Hello');
      });

      expect(onSendStart).toHaveBeenCalled();
      expect(mockToastInfo).toHaveBeenCalledWith('Message queued — will send when reconnected.');
      expect(onSendComplete).toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('should handle send error', async () => {
      mockRequest.mockRejectedValue(new Error('Network error'));

      const onError = vi.fn();
      const onSendComplete = vi.fn();

      const { result } = renderHook(() =>
        useSendMessage({
          sessionId: 'session-1',
          session: defaultSession,
          isSending: false,
          onSendStart: vi.fn(),
          onSendComplete,
          onError,
        })
      );

      await act(async () => {
        await result.current.sendMessage('Hello');
      });

      expect(onError).toHaveBeenCalledWith('Network error');
      expect(mockToastError).toHaveBeenCalledWith('Network error');
      expect(onSendComplete).toHaveBeenCalled();
    });

    it('should handle non-Error exception', async () => {
      mockRequest.mockRejectedValue('Unknown error');

      const onError = vi.fn();

      const { result } = renderHook(() =>
        useSendMessage({
          sessionId: 'session-1',
          session: defaultSession,
          isSending: false,
          onSendStart: vi.fn(),
          onSendComplete: vi.fn(),
          onError,
        })
      );

      await act(async () => {
        await result.current.sendMessage('Hello');
      });

      expect(onError).toHaveBeenCalledWith('Unknown error');
    });
  });

  describe('timeout handling', () => {
    it('should set timeout on send', async () => {
      let resolveCall: (value: unknown) => void;
      const callPromise = new Promise((resolve) => {
        resolveCall = resolve;
      });
      mockRequest.mockImplementation(() => callPromise);

      const onError = vi.fn();
      const onSendComplete = vi.fn();

      const { result } = renderHook(() =>
        useSendMessage({
          sessionId: 'session-1',
          session: defaultSession,
          isSending: false,
          onSendStart: vi.fn(),
          onSendComplete,
          onError,
        })
      );

      act(() => {
        result.current.sendMessage('Hello');
      });

      await act(async () => {
        vi.advanceTimersByTime(15000);
      });

      expect(onSendComplete).toHaveBeenCalled();
      expect(onError).toHaveBeenCalledWith('Message send timed out.');
      expect(mockToastError).toHaveBeenCalledWith('Message send timed out.');

      resolveCall!({});
    });

    it('should clear timeout on successful send', async () => {
      const onError = vi.fn();

      const { result } = renderHook(() =>
        useSendMessage({
          sessionId: 'session-1',
          session: defaultSession,
          isSending: false,
          onSendStart: vi.fn(),
          onSendComplete: vi.fn(),
          onError,
        })
      );

      await act(async () => {
        await result.current.sendMessage('Hello');
      });

      await act(async () => {
        vi.advanceTimersByTime(20000);
      });

      expect(onError).not.toHaveBeenCalled();
    });
  });

  describe('clearSendTimeout', () => {
    it('should be callable without throwing', () => {
      const { result } = renderHook(() =>
        useSendMessage({
          sessionId: 'session-1',
          session: defaultSession,
          isSending: false,
          onSendStart: vi.fn(),
          onSendComplete: vi.fn(),
          onError: vi.fn(),
        })
      );

      act(() => {
        result.current.clearSendTimeout();
      });

      expect(true).toBe(true);
    });

    it('should be callable multiple times', () => {
      const { result } = renderHook(() =>
        useSendMessage({
          sessionId: 'session-1',
          session: defaultSession,
          isSending: false,
          onSendStart: vi.fn(),
          onSendComplete: vi.fn(),
          onError: vi.fn(),
        })
      );

      act(() => {
        result.current.clearSendTimeout();
        result.current.clearSendTimeout();
        result.current.clearSendTimeout();
      });

      expect(true).toBe(true);
    });
  });

  describe('function stability', () => {
    it('should return stable clearSendTimeout reference', () => {
      const { result, rerender } = renderHook(() =>
        useSendMessage({
          sessionId: 'session-1',
          session: defaultSession,
          isSending: false,
          onSendStart: vi.fn(),
          onSendComplete: vi.fn(),
          onError: vi.fn(),
        })
      );

      const firstClearSendTimeout = result.current.clearSendTimeout;

      rerender();

      expect(result.current.clearSendTimeout).toBe(firstClearSendTimeout);
    });
  });

  describe('null session handling', () => {
    it('should handle null session - allow non-archived check to pass', async () => {
      const onSendStart = vi.fn();

      const { result } = renderHook(() =>
        useSendMessage({
          sessionId: 'session-1',
          session: null,
          isSending: false,
          onSendStart,
          onSendComplete: vi.fn(),
          onError: vi.fn(),
        })
      );

      await act(async () => {
        await result.current.sendMessage('Hello');
      });

      expect(onSendStart).toHaveBeenCalled();
    });
  });

  describe('sessionId changes', () => {
    it('should update sendMessage when sessionId changes', () => {
      const { result, rerender } = renderHook(
        ({ sessionId }) =>
          useSendMessage({
            sessionId,
            session: defaultSession,
            isSending: false,
            onSendStart: vi.fn(),
            onSendComplete: vi.fn(),
            onError: vi.fn(),
          }),
        { initialProps: { sessionId: 'session-1' } }
      );

      const firstSendMessage = result.current.sendMessage;

      rerender({ sessionId: 'session-2' });

      expect(result.current.sendMessage).not.toBe(firstSendMessage);
    });
  });

  describe('message content handling', () => {
    it('should handle message with leading/trailing whitespace', async () => {
      const onSendStart = vi.fn();

      const { result } = renderHook(() =>
        useSendMessage({
          sessionId: 'session-1',
          session: defaultSession,
          isSending: false,
          onSendStart,
          onSendComplete: vi.fn(),
          onError: vi.fn(),
        })
      );

      await act(async () => {
        await result.current.sendMessage('  Hello  ');
      });

      expect(onSendStart).toHaveBeenCalled();
      expect(mockRequest).toHaveBeenCalled();
    });

    it('should handle message with newlines only', async () => {
      const onSendStart = vi.fn();

      const { result } = renderHook(() =>
        useSendMessage({
          sessionId: 'session-1',
          session: defaultSession,
          isSending: false,
          onSendStart,
          onSendComplete: vi.fn(),
          onError: vi.fn(),
        })
      );

      await act(async () => {
        await result.current.sendMessage('\n\n\n');
      });

      expect(onSendStart).not.toHaveBeenCalled();
    });

    it('should handle message with tabs only', async () => {
      const onSendStart = vi.fn();

      const { result } = renderHook(() =>
        useSendMessage({
          sessionId: 'session-1',
          session: defaultSession,
          isSending: false,
          onSendStart,
          onSendComplete: vi.fn(),
          onError: vi.fn(),
        })
      );

      await act(async () => {
        await result.current.sendMessage('\t\t\t');
      });

      expect(onSendStart).not.toHaveBeenCalled();
    });
  });
});
