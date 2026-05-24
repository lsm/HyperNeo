/**
 * TypedHub - Type-safe wrapper over MessageHub + InProcessTransportBus
 *
 * Provides EventBus-like typed API while using MessageHub for actual messaging.
 * This enables:
 * 1. Type safety (typed events with TypeScript inference)
 * 2. Session-scoped subscriptions
 * 3. Async-everywhere design
 * 4. Cluster distribution readiness (same MessageHub protocol)
 *
 * ARCHITECTURE:
 * - Uses InProcessTransportBus for in-process multi-party communication
 * - Each participant gets a MessageHub connected to shared bus
 * - Messages routed via MessageHub protocol (method names like 'session.created')
 * - Type safety via generics (like EventBus's EventMap)
 *
 * USAGE:
 * ```typescript
 * // Define event types (like EventMap)
 * interface ServerEvents extends Record<string, BaseEventData> {
 *   'session.created': { sessionId: string; session: Session };
 *   'session.updated': { sessionId: string; data: Partial<Session> };
 * }
 *
 * // Create typed hub (server-side singleton)
 * const serverHub = new TypedHub<ServerEvents>({ name: 'server' });
 * await serverHub.initialize();
 *
 * // Publish events (type-safe) — awaits all handlers, throws on failures
 * await serverHub.publish('session.created', { sessionId: '123', session: {...} });
 *
 * // Fire-and-forget publish — returns immediately, swallows handler errors
 * serverHub.publishAsync('session.created', { sessionId: '123', session: {...} });
 *
 * // Subscribe to events (type-safe)
 * serverHub.subscribe('session.created', (data) => {
 *   console.log(data.session); // TypeScript knows the shape
 * });
 *
 * // Session-scoped subscription
 * serverHub.subscribe('session.updated', handler, { sessionId: 'abc123' });
 * ```
 */

import { MessageHub } from './message-hub.ts';
import { InProcessTransportBus, InProcessTransport } from './in-process-transport.ts';
import type { ChannelEventHandler } from './types.ts';

/**
 * Base constraint for event data
 * All events must include sessionId for routing
 */
export interface BaseEventData {
  sessionId: string;
}

/**
 * Options for TypedHub
 */
export interface TypedHubOptions {
  /**
   * Hub name for debugging
   * @default 'typed-hub'
   */
  name?: string;

  /**
   * Enable debug logging
   * @default false
   */
  debug?: boolean;

  /**
   * Simulated latency in ms (for testing)
   * @default 0
   */
  simulatedLatency?: number;

  /**
   * Existing bus to join (for multi-hub scenarios)
   * If not provided, creates a new bus
   */
  bus?: InProcessTransportBus;
}

/**
 * Subscribe options
 */
export interface TypedSubscribeOptions {
  /**
   * Filter events to only this session
   * If not specified, receives all events (global subscription)
   */
  sessionId?: string;
}

/**
 * Structured failure from a single handler.
 */
export interface HandlerFailure {
  /** Event name being handled when the failure occurred. */
  event: string;

  /** The raw Error (or Error-like) thrown by the handler. */
  error: Error;
}

/**
 * Result returned by {@link TypedHub.publish}.
 */
export interface PublishResult {
  /** Number of handlers that completed successfully. */
  delivered: number;

  /** Structured failures from handlers that threw or rejected. */
  failures: HandlerFailure[];
}

/**
 * Thrown by {@link TypedHub.publish} when one or more handlers fail.
 * The `result` field contains the full breakdown so callers can decide
 * whether to abort, partially retry, or continue.
 */
export class TypedHubPublishError extends Error {
  constructor(
    public readonly event: string,
    public readonly result: PublishResult
  ) {
    super(
      `Publish of '${event}' failed with ${result.failures.length} handler failure(s) ` +
        `(${result.delivered} succeeded)`
    );
    this.name = 'TypedHubPublishError';
  }
}

/**
 * TypedHub - Type-safe MessageHub wrapper
 *
 * @template TEventMap - Map of event names to their data types
 */
export class TypedHub<TEventMap extends Record<string, BaseEventData>> {
  private readonly name: string;
  private readonly debug: boolean;

  private bus: InProcessTransportBus;
  private transport: InProcessTransport;
  private hub: MessageHub;
  private ownsBus: boolean;
  private initialized = false;

  // Track local handlers for direct dispatch (like EventBus)
  // event → sessionId → handlers
  // This enables EventBus-like behavior where publisher receives own events
  private localHandlers: Map<string, Map<string, Set<(data: unknown) => void | Promise<void>>>> =
    new Map();

  // Track handler names for diagnostics (event → sessionId → handler → name)
  private handlerNames: Map<
    string,
    Map<string, WeakMap<(data: unknown) => void | Promise<void>, string>>
  > = new Map();

  // Per-subscription-key counter for unique handler names
  private handlerNameCounters: Map<string, number> = new Map();

  // Track MessageHub subscriptions for cleanup
  private hubSubscriptions: Map<string, (() => void)[]> = new Map();

  constructor(options: TypedHubOptions = {}) {
    this.name = options.name || 'typed-hub';
    this.debug = options.debug || false;

    // Use provided bus or create new one
    if (options.bus) {
      this.bus = options.bus;
      this.ownsBus = false;
    } else {
      this.bus = new InProcessTransportBus({
        name: `${this.name}-bus`,
        simulatedLatency: options.simulatedLatency,
      });
      this.ownsBus = true;
    }

    // Create transport for this hub
    this.transport = this.bus.createTransport(this.name);

    // Create MessageHub with transport
    this.hub = new MessageHub({
      defaultSessionId: 'global',
    });
    this.hub.registerTransport(this.transport);
  }

  /**
   * Initialize the hub
   * Must be called before publish/subscribe
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    await this.transport.initialize();
    this.initialized = true;
    this.log('Initialized');
  }

  /**
   * Publish an event to all subscribers and **await** every local handler.
   *
   * All matching handlers are executed concurrently. If any handler throws,
   * the error is captured in a structured {@link HandlerFailure}, every other
   * handler still runs, and the method finally throws
   * {@link TypedHubPublishError} containing the full {@link PublishResult}.
   *
   * When **all** handlers succeed the returned {@link PublishResult} contains
   * `failures: []` and is never thrown.
   *
   * @param event - Event name (e.g., 'session.created')
   * @param data - Event data (must include sessionId)
   * @returns Structured result with handler counts and failures
   */
  async publish<K extends keyof TEventMap & string>(
    event: K,
    data: TEventMap[K]
  ): Promise<PublishResult> {
    if (!this.initialized) {
      throw new Error('TypedHub not initialized. Call initialize() first.');
    }

    this.log(`Publishing: ${event}`, data);

    // Send event via MessageHub for cross-transport delivery FIRST.
    // Local handlers are awaited afterwards so a slow local subscriber
    // cannot stall inter-participant delivery.
    // Note: Bus excludes sender, so this only reaches other participants.
    this.hub.event(event, data, { channel: data.sessionId });

    // Dispatch to local handlers (EventBus-like behavior)
    // This ensures publisher receives own events, even with single hub
    const result = await this.dispatchLocally(event, data);

    if (result.failures.length > 0) {
      throw new TypedHubPublishError(event, result);
    }

    return result;
  }

  /**
   * Fire-and-forget publish.
   *
   * Sends the event to the bus and schedules local handlers asynchronously,
   * returning immediately.  Handler failures are silently swallowed; they
   * are never thrown and the caller cannot await them.
   *
   * Unlike {@link publish}, this does **not** wait for local handlers or
   * the bus send before returning, so cross-transport delivery and local
   * dispatch proceed concurrently with the caller.
   *
   * @param event - Event name (e.g., 'session.created')
   * @param data - Event data (must include sessionId)
   */
  publishAsync<K extends keyof TEventMap & string>(event: K, data: TEventMap[K]): void {
    if (!this.initialized) {
      throw new Error('TypedHub not initialized. Call initialize() first.');
    }

    this.log(`Publishing (async): ${event}`, data);

    // Send bus event immediately (fire-and-forget)
    this.hub.event(event, data, { channel: data.sessionId });

    // Dispatch local handlers in a microtask so the caller returns
    // immediately.  Errors are swallowed by design.
    queueMicrotask(() => {
      this.dispatchLocally(event, data).catch(() => {
        // Swallow — publishAsync is explicit fire-and-forget.
      });
    });
  }

  /**
   * Dispatch event to local handlers.
   * All matching handlers are executed concurrently.  Returns a structured
   * result so callers can decide whether to throw or continue.
   */
  private async dispatchLocally<K extends keyof TEventMap & string>(
    event: K,
    data: TEventMap[K]
  ): Promise<PublishResult> {
    const eventHandlers = this.localHandlers.get(event);
    if (!eventHandlers || eventHandlers.size === 0) {
      return { delivered: 0, failures: [] };
    }

    const eventSessionId = data.sessionId;
    const GLOBAL_KEY = '__global__';

    const targets: { handler: (data: unknown) => void | Promise<void>; name: string }[] = [];

    // 1. Session-specific handlers (O(1) lookup)
    const sessionHandlers = eventHandlers.get(eventSessionId);
    if (sessionHandlers) {
      for (const handler of sessionHandlers) {
        const name = this.getHandlerName(event, eventSessionId, handler);
        targets.push({ handler, name });
      }
    }

    // 2. Global handlers (O(1) lookup)
    const globalHandlers = eventHandlers.get(GLOBAL_KEY);
    if (globalHandlers) {
      for (const handler of globalHandlers) {
        const name = this.getHandlerName(event, GLOBAL_KEY, handler);
        targets.push({ handler, name });
      }
    }

    if (targets.length === 0) {
      return { delivered: 0, failures: [] };
    }

    const failures: HandlerFailure[] = [];
    let delivered = 0;

    // Run every handler concurrently; collect failures individually.
    await Promise.all(
      targets.map(async ({ handler, name }) => {
        try {
          await handler(data);
          delivered++;
        } catch (raw) {
          const error = raw instanceof Error ? raw : new Error(String(raw));
          failures.push({ event, error });
          this.log(`Handler '${name}' failed for event '${event}':`, error);
        }
      })
    );

    return { delivered, failures };
  }

  /**
   * Look up the diagnostic name for a handler.
   */
  private getHandlerName(
    event: string,
    sessionId: string,
    handler: (data: unknown) => void | Promise<void>
  ): string {
    const sessionMap = this.handlerNames.get(event);
    if (!sessionMap) return '<anonymous>';
    const nameMap = sessionMap.get(sessionId);
    if (!nameMap) return '<anonymous>';
    return nameMap.get(handler) ?? '<anonymous>';
  }

  /**
   * Subscribe to an event
   *
   * @param event - Event name to subscribe to
   * @param handler - Handler function
   * @param options - Subscribe options (sessionId for filtering)
   * @returns Unsubscribe function
   */
  subscribe<K extends keyof TEventMap & string>(
    event: K,
    handler: (data: TEventMap[K]) => void | Promise<void>,
    options?: TypedSubscribeOptions
  ): () => void {
    const sessionId = options?.sessionId;
    const subscriptionKey = sessionId || '__global__';

    // Cast handler to unknown type for storage
    const typedHandler = handler as (data: unknown) => void | Promise<void>;

    // Add to local handlers for direct dispatch
    if (!this.localHandlers.has(event)) {
      this.localHandlers.set(event, new Map());
    }
    const eventHandlers = this.localHandlers.get(event)!;
    if (!eventHandlers.has(subscriptionKey)) {
      eventHandlers.set(subscriptionKey, new Set());
    }
    eventHandlers.get(subscriptionKey)!.add(typedHandler);

    // Track handler name for diagnostics (unique per subscription)
    const counterKey = `${event}:${subscriptionKey}`;
    const counter = (this.handlerNameCounters.get(counterKey) ?? 0) + 1;
    this.handlerNameCounters.set(counterKey, counter);
    const handlerName = options?.sessionId
      ? `session:${options.sessionId}#${counter}`
      : `global#${counter}`;
    if (!this.handlerNames.has(event)) {
      this.handlerNames.set(event, new Map());
    }
    const nameSessionMap = this.handlerNames.get(event)!;
    if (!nameSessionMap.has(subscriptionKey)) {
      nameSessionMap.set(subscriptionKey, new WeakMap());
    }
    nameSessionMap.get(subscriptionKey)!.set(typedHandler, handlerName);

    // Also subscribe via MessageHub for cross-transport events (from other participants)
    // Create wrapper that applies session filtering
    const hubHandler: ChannelEventHandler = (data) => {
      const eventData = data as TEventMap[K];
      if (sessionId && eventData.sessionId !== sessionId) {
        return;
      }
      handler(eventData);
    };
    const hubUnsub = this.hub.onEvent(event, hubHandler);

    // Track MessageHub subscription for cleanup
    if (!this.hubSubscriptions.has(event)) {
      this.hubSubscriptions.set(event, []);
    }
    this.hubSubscriptions.get(event)!.push(hubUnsub);

    this.log(`Subscribed to ${event}${sessionId ? ` (session: ${sessionId})` : ''}`);

    // Return unsubscribe function
    return () => {
      // Remove from local handlers
      const eventHandlers = this.localHandlers.get(event);
      if (eventHandlers) {
        const handlers = eventHandlers.get(subscriptionKey);
        if (handlers) {
          handlers.delete(typedHandler);
          if (handlers.size === 0) {
            eventHandlers.delete(subscriptionKey);
            // Prune counter when the last handler for this key is gone
            this.handlerNameCounters.delete(`${event}:${subscriptionKey}`);
          }
        }
        if (eventHandlers.size === 0) {
          this.localHandlers.delete(event);
        }
      }

      // Remove from handler names
      const nameMap = this.handlerNames.get(event);
      if (nameMap) {
        nameMap.delete(subscriptionKey);
        if (nameMap.size === 0) {
          this.handlerNames.delete(event);
        }
      }

      // Unsubscribe from MessageHub
      hubUnsub();

      this.log(`Unsubscribed from ${event}${sessionId ? ` (session: ${sessionId})` : ''}`);
    };
  }

  /**
   * Subscribe once (auto-unsubscribes after first matching event)
   */
  once<K extends keyof TEventMap & string>(
    event: K,
    handler: (data: TEventMap[K]) => void | Promise<void>,
    options?: TypedSubscribeOptions
  ): () => void {
    let unsub: (() => void) | null = null;

    const wrappedHandler = async (data: TEventMap[K]) => {
      if (unsub) {
        unsub();
      }
      await handler(data);
    };

    unsub = this.subscribe(event, wrappedHandler, options);
    return unsub;
  }

  /**
   * Alias for publish() - EventBus compatibility
   */
  emit<K extends keyof TEventMap & string>(event: K, data: TEventMap[K]): Promise<PublishResult> {
    return this.publish(event, data);
  }

  /**
   * Alias for subscribe() - EventBus compatibility
   */
  on<K extends keyof TEventMap & string>(
    event: K,
    handler: (data: TEventMap[K]) => void | Promise<void>,
    options?: TypedSubscribeOptions
  ): () => void {
    return this.subscribe(event, handler, options);
  }

  /**
   * Get underlying MessageHub (for advanced usage like RPC)
   */
  getMessageHub(): MessageHub {
    return this.hub;
  }

  /**
   * Get underlying bus (for creating additional participants)
   */
  getBus(): InProcessTransportBus {
    return this.bus;
  }

  /**
   * Create another participant connected to the same bus
   * Useful for component isolation with shared event space
   */
  createParticipant(name: string): TypedHub<TEventMap> {
    return new TypedHub<TEventMap>({
      name,
      debug: this.debug,
      bus: this.bus, // Share the same bus
    });
  }

  /**
   * Close the hub and cleanup resources
   */
  async close(): Promise<void> {
    // Unsubscribe all MessageHub subscriptions
    for (const unsubs of this.hubSubscriptions.values()) {
      for (const unsub of unsubs) {
        unsub();
      }
    }
    this.hubSubscriptions.clear();

    // Clear local handlers
    this.localHandlers.clear();

    // Clear handler names
    this.handlerNames.clear();

    // Clear handler name counters
    this.handlerNameCounters.clear();

    // Close transport
    await this.transport.close();

    // Close bus if we own it
    if (this.ownsBus) {
      await this.bus.close();
    }

    this.initialized = false;
    this.log('Closed');
  }

  /**
   * Debug logging
   */
  private log(_message: string, ..._args: unknown[]): void {
    // Debug logging removed - use proper debugging tools instead
  }
}
