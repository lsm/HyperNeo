/**
 * useMessageHub Hook
 *
 * A Preact hook for safe, non-blocking access to the MessageHub connection.
 * Provides reactive connection state and type-safe RPC/subscription methods.
 *
 * ## Key Features:
 * - Non-blocking by default - never freezes UI
 * - Reactive connection state
 * - Type-safe RPC calls
 * - Automatic subscription cleanup
 * - Connection-aware operations
 *
 * ## Usage:
 * ```typescript
 * function MyComponent() {
 *   const { isConnected, call, subscribe } = useMessageHub();
 *
 *   const handleClick = async () => {
 *     if (!isConnected) {
 *       toast.error('Not connected');
 *       return;
 *     }
 *     const result = await call('session.create', { ... });
 *   };
 * }
 * ```
 */

import { useCallback, useEffect, useRef } from 'preact/hooks';
import { useComputed } from '@preact/signals';
import { connectionManager } from '../lib/connection-manager';
import { connectionState } from '../lib/state';
import { ConnectionNotReadyError } from '../lib/errors';
import type { MessageHub, ChannelEventHandler } from '@hyperneo/shared';

// Define SubscribeOptions locally (removed from shared types)
interface SubscribeOptions {
  once?: boolean;
}

// EventHandler is now ChannelEventHandler in the new API
type EventHandler<TData = unknown> = ChannelEventHandler<TData>;

/**
 * Options for the useMessageHub hook
 */
export interface UseMessageHubOptions {
  /**
   * Default timeout for RPC calls in milliseconds
   * @default 30000
   */
  defaultTimeout?: number;

  /**
   * Whether to log connection state changes
   * @default false
   */
  debug?: boolean;
}

/**
 * Result of the useMessageHub hook
 */
export interface UseMessageHubResult {
  /**
   * Whether the WebSocket is currently connected
   * This is a reactive value - components will re-render when it changes
   */
  isConnected: boolean;

  /**
   * Current connection state ('connecting' | 'connected' | 'disconnected' | 'error' | 'reconnecting')
   * This is a reactive value
   */
  state: typeof connectionState.value;

  /**
   * Get the MessageHub if connected, null otherwise (NON-BLOCKING)
   */
  getHub: () => MessageHub | null;

  /**
   * Make a request call (request-response) (NON-BLOCKING - throws if not connected)
   * @throws {ConnectionNotReadyError} If not connected
   */
  request: <TResult = unknown, TData = unknown>(
    method: string,
    data?: TData,
    options?: { timeout?: number }
  ) => Promise<TResult>;

  /**
   * Listen for events (replaces subscribe for new API)
   * Returns unsubscribe function
   */
  onEvent: <TData = unknown>(
    method: string,
    handler: EventHandler<TData>,
    options?: SubscribeOptions
  ) => () => void;

  /**
   * Join a room for receiving room-specific events
   */
  joinRoom: (room: string) => void;

  /**
   * Leave a room
   */
  leaveRoom: (room: string) => void;

  /**
   * Make an RPC call (NON-BLOCKING - throws if not connected)
   * @deprecated Use query() instead
   * @throws {ConnectionNotReadyError} If not connected
   */
  call: <TResult = unknown, TData = unknown>(
    method: string,
    data?: TData,
    options?: { timeout?: number }
  ) => Promise<TResult>;

  /**
   * Make an RPC call if connected, returns null if not (NON-BLOCKING)
   * Use this when you want to silently skip operations when disconnected
   */
  callIfConnected: <TResult = unknown, TData = unknown>(
    method: string,
    data?: TData,
    options?: { timeout?: number }
  ) => Promise<TResult | null>;

  /**
   * Subscribe to events with optimistic registration (NON-BLOCKING)
   * Returns unsubscribe function immediately
   */
  subscribe: <TData = unknown>(
    method: string,
    handler: EventHandler<TData>,
    options?: SubscribeOptions
  ) => () => void;

  /**
   * Wait for connection to be established
   * @param timeout - Timeout in milliseconds (default: 30000)
   * @throws {ConnectionTimeoutError} If timeout exceeded
   */
  waitForConnection: (timeout?: number) => Promise<void>;

  /**
   * Register a callback for when connection is established
   * If already connected, callback is called immediately
   * @returns Unsubscribe function
   */
  onConnected: (callback: () => void) => () => void;
}

/**
 * Hook for accessing MessageHub connection in a non-blocking, reactive way
 *
 * @param options - Configuration options
 * @returns Hook result with connection state and methods
 *
 * @example
 * ```typescript
 * function SessionCreator() {
 *   const { isConnected, call } = useMessageHub();
 *   const [loading, setLoading] = useState(false);
 *
 *   const createSession = async () => {
 *     if (!isConnected) {
 *       toast.error('Not connected to server');
 *       return;
 *     }
 *
 *     setLoading(true);
 *     try {
 *       const session = await call('session.create', { workspacePath: '/path' });
 *       navigate(`/session/${session.id}`);
 *     } catch (err) {
 *       if (err instanceof ConnectionNotReadyError) {
 *         toast.error('Connection lost. Please try again.');
 *       } else {
 *         toast.error(err.message);
 *       }
 *     } finally {
 *       setLoading(false);
 *     }
 *   };
 *
 *   return (
 *     <button onClick={createSession} disabled={!isConnected || loading}>
 *       {isConnected ? 'Create Session' : 'Connecting...'}
 *     </button>
 *   );
 * }
 * ```
 */
export function useMessageHub(options: UseMessageHubOptions = {}): UseMessageHubResult {
  const { defaultTimeout = 30000, debug = false } = options;

  // Track active subscriptions for cleanup
  const subscriptionsRef = useRef<Array<() => void>>([]);

  // Computed reactive connection state
  const isConnected = useComputed(() => connectionState.value === 'connected');
  const state = useComputed(() => connectionState.value);

  // Connection state tracking (for debug mode)
  useEffect(() => {
    if (debug) {
      return connectionState.subscribe(() => {});
    }
  }, [debug]);

  // Cleanup subscriptions on unmount
  useEffect(() => {
    return () => {
      subscriptionsRef.current.forEach((unsub) => {
        try {
          unsub();
        } catch {
          // Ignore cleanup errors
        }
      });
      subscriptionsRef.current = [];
    };
  }, []);

  /**
   * Get the MessageHub if connected (NON-BLOCKING)
   */
  const getHub = useCallback((): MessageHub | null => {
    return connectionManager.getHubIfConnected();
  }, []);

  /**
   * Make a request call (request-response) (NON-BLOCKING - throws if not connected)
   */
  const request = useCallback(
    async <TResult = unknown, TData = unknown>(
      method: string,
      data?: TData,
      callOptions?: { timeout?: number }
    ): Promise<TResult> => {
      const hub = connectionManager.getHubIfConnected();
      if (!hub) {
        throw new ConnectionNotReadyError(`Cannot call '${method}': not connected to server`);
      }
      return hub.request<TResult>(method, data, {
        timeout: callOptions?.timeout ?? defaultTimeout,
      });
    },
    [defaultTimeout]
  );

  /**
   * Listen for events (replaces subscribe for new API)
   */
  const onEvent = useCallback(
    <TData = unknown>(
      method: string,
      handler: EventHandler<TData>,
      _subOptions?: SubscribeOptions
    ): (() => void) => {
      const hub = connectionManager.getHubIfConnected();

      if (!hub) {
        // Queue subscription for when connected
        let actualUnsub: (() => void) | null = null;
        let cancelled = false;

        const connectionUnsub = connectionManager.onceConnected(() => {
          if (cancelled) return;

          const connectedHub = connectionManager.getHubIfConnected();
          if (connectedHub) {
            actualUnsub = connectedHub.onEvent(method, handler);
          }
        });

        // Return unsubscribe function
        const unsub = () => {
          cancelled = true;
          connectionUnsub();
          if (actualUnsub) {
            actualUnsub();
          }
        };

        // Track for cleanup
        subscriptionsRef.current.push(unsub);

        return unsub;
      }

      // Already connected - subscribe immediately
      const unsub = hub.onEvent(method, handler);

      // Track for cleanup
      subscriptionsRef.current.push(unsub);

      return () => {
        unsub();
        // Remove from tracked subscriptions
        const index = subscriptionsRef.current.indexOf(unsub);
        if (index !== -1) {
          subscriptionsRef.current.splice(index, 1);
        }
      };
    },
    []
  );

  /**
   * Join a room
   */
  const joinRoom = useCallback((room: string): void => {
    const hub = connectionManager.getHubIfConnected();
    if (hub) {
      hub.joinChannel(room);
    }
  }, []);

  /**
   * Leave a room
   */
  const leaveRoom = useCallback((room: string): void => {
    const hub = connectionManager.getHubIfConnected();
    if (hub) {
      hub.leaveChannel(room);
    }
  }, []);

  /**
   * Make an RPC call (NON-BLOCKING - throws if not connected)
   * @deprecated Use request() instead
   */
  const call = useCallback(
    async <TResult = unknown, TData = unknown>(
      method: string,
      data?: TData,
      callOptions?: { timeout?: number }
    ): Promise<TResult> => {
      return request<TResult, TData>(method, data, callOptions);
    },
    [request]
  );

  /**
   * Make an RPC call if connected, returns null otherwise (NON-BLOCKING)
   */
  const callIfConnected = useCallback(
    async <TResult = unknown, TData = unknown>(
      method: string,
      data?: TData,
      callOptions?: { timeout?: number }
    ): Promise<TResult | null> => {
      const hub = connectionManager.getHubIfConnected();
      if (!hub) {
        return null;
      }
      return hub.request<TResult>(method, data, {
        timeout: callOptions?.timeout ?? defaultTimeout,
      });
    },
    [defaultTimeout]
  );

  /**
   * Subscribe to events with optimistic registration (NON-BLOCKING)
   * @deprecated Use onEvent() instead
   */
  const subscribe = useCallback(
    <TData = unknown>(
      method: string,
      handler: EventHandler<TData>,
      _subOptions?: SubscribeOptions
    ): (() => void) => {
      const hub = connectionManager.getHubIfConnected();

      if (!hub) {
        // Queue subscription for when connected
        let actualUnsub: (() => void) | null = null;
        let cancelled = false;

        const connectionUnsub = connectionManager.onceConnected(() => {
          if (cancelled) return;

          const connectedHub = connectionManager.getHubIfConnected();
          if (connectedHub) {
            actualUnsub = connectedHub.onEvent(method, handler);
          }
        });

        // Return unsubscribe function
        const unsub = () => {
          cancelled = true;
          connectionUnsub();
          if (actualUnsub) {
            actualUnsub();
          }
        };

        // Track for cleanup
        subscriptionsRef.current.push(unsub);

        return unsub;
      }

      // Already connected - subscribe immediately
      const unsub = hub.onEvent(method, handler);

      // Track for cleanup
      subscriptionsRef.current.push(unsub);

      return () => {
        unsub();
        // Remove from tracked subscriptions
        const index = subscriptionsRef.current.indexOf(unsub);
        if (index !== -1) {
          subscriptionsRef.current.splice(index, 1);
        }
      };
    },
    []
  );

  /**
   * Wait for connection to be established
   */
  const waitForConnection = useCallback(
    (timeout?: number): Promise<void> => {
      return connectionManager.onConnected(timeout ?? defaultTimeout);
    },
    [defaultTimeout]
  );

  /**
   * Register a callback for when connection is established
   */
  const onConnected = useCallback((callback: () => void): (() => void) => {
    return connectionManager.onceConnected(callback);
  }, []);

  return {
    isConnected: isConnected.value,
    state: state.value,
    getHub,
    request,
    onEvent,
    joinRoom,
    leaveRoom,
    call,
    callIfConnected,
    subscribe,
    waitForConnection,
    onConnected,
  };
}
