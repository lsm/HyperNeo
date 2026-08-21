import { useCallback, useEffect, useRef } from 'preact/hooks';
import { useComputed } from '@preact/signals';
import { connectionManager } from '../lib/connection-manager';
import { connectionState } from '../lib/state';
import { ConnectionNotReadyError } from '../lib/errors';
import type { MessageHub, ChannelEventHandler } from '@hyperneo/shared';

interface SubscribeOptions {
  once?: boolean;
}

type EventHandler<TData = unknown> = ChannelEventHandler<TData>;

export interface UseMessageHubOptions {
  defaultTimeout?: number;

  debug?: boolean;
}

export interface UseMessageHubResult {
  isConnected: boolean;

  state: typeof connectionState.value;

  getHub: () => MessageHub | null;

  request: <TResult = unknown, TData = unknown>(
    method: string,
    data?: TData,
    options?: { timeout?: number }
  ) => Promise<TResult>;

  onEvent: <TData = unknown>(
    method: string,
    handler: EventHandler<TData>,
    options?: SubscribeOptions
  ) => () => void;

  joinRoom: (room: string) => void;

  leaveRoom: (room: string) => void;

  call: <TResult = unknown, TData = unknown>(
    method: string,
    data?: TData,
    options?: { timeout?: number }
  ) => Promise<TResult>;

  callIfConnected: <TResult = unknown, TData = unknown>(
    method: string,
    data?: TData,
    options?: { timeout?: number }
  ) => Promise<TResult | null>;

  subscribe: <TData = unknown>(
    method: string,
    handler: EventHandler<TData>,
    options?: SubscribeOptions
  ) => () => void;

  waitForConnection: (timeout?: number) => Promise<void>;

  onConnected: (callback: () => void) => () => void;
}

export function useMessageHub(options: UseMessageHubOptions = {}): UseMessageHubResult {
  const { defaultTimeout = 30000, debug = false } = options;

  const subscriptionsRef = useRef<Array<() => void>>([]);

  const isConnected = useComputed(() => connectionState.value === 'connected');
  const state = useComputed(() => connectionState.value);

  useEffect(() => {
    if (debug) {
      return connectionState.subscribe(() => {});
    }
  }, [debug]);

  useEffect(() => {
    return () => {
      subscriptionsRef.current.forEach((unsub) => {
        try {
          unsub();
        } catch {}
      });
      subscriptionsRef.current = [];
    };
  }, []);

  const getHub = useCallback((): MessageHub | null => {
    return connectionManager.getHubIfConnected();
  }, []);

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

  const onEvent = useCallback(
    <TData = unknown>(
      method: string,
      handler: EventHandler<TData>,
      _subOptions?: SubscribeOptions
    ): (() => void) => {
      const hub = connectionManager.getHubIfConnected();

      if (!hub) {
        let actualUnsub: (() => void) | null = null;
        let cancelled = false;

        const connectionUnsub = connectionManager.onceConnected(() => {
          if (cancelled) return;

          const connectedHub = connectionManager.getHubIfConnected();
          if (connectedHub) {
            actualUnsub = connectedHub.onEvent(method, handler);
          }
        });

        const unsub = () => {
          cancelled = true;
          connectionUnsub();
          if (actualUnsub) {
            actualUnsub();
          }
        };

        subscriptionsRef.current.push(unsub);

        return unsub;
      }

      const unsub = hub.onEvent(method, handler);

      subscriptionsRef.current.push(unsub);

      return () => {
        unsub();
        const index = subscriptionsRef.current.indexOf(unsub);
        if (index !== -1) {
          subscriptionsRef.current.splice(index, 1);
        }
      };
    },
    []
  );

  const joinRoom = useCallback((room: string): void => {
    const hub = connectionManager.getHubIfConnected();
    if (hub) {
      hub.joinChannel(room);
    }
  }, []);

  const leaveRoom = useCallback((room: string): void => {
    const hub = connectionManager.getHubIfConnected();
    if (hub) {
      hub.leaveChannel(room);
    }
  }, []);

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

  const subscribe = useCallback(
    <TData = unknown>(
      method: string,
      handler: EventHandler<TData>,
      _subOptions?: SubscribeOptions
    ): (() => void) => {
      const hub = connectionManager.getHubIfConnected();

      if (!hub) {
        let actualUnsub: (() => void) | null = null;
        let cancelled = false;

        const connectionUnsub = connectionManager.onceConnected(() => {
          if (cancelled) return;

          const connectedHub = connectionManager.getHubIfConnected();
          if (connectedHub) {
            actualUnsub = connectedHub.onEvent(method, handler);
          }
        });

        const unsub = () => {
          cancelled = true;
          connectionUnsub();
          if (actualUnsub) {
            actualUnsub();
          }
        };

        subscriptionsRef.current.push(unsub);

        return unsub;
      }

      const unsub = hub.onEvent(method, handler);

      subscriptionsRef.current.push(unsub);

      return () => {
        unsub();
        const index = subscriptionsRef.current.indexOf(unsub);
        if (index !== -1) {
          subscriptionsRef.current.splice(index, 1);
        }
      };
    },
    []
  );

  const waitForConnection = useCallback(
    (timeout?: number): Promise<void> => {
      return connectionManager.onConnected(timeout ?? defaultTimeout);
    },
    [defaultTimeout]
  );

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
