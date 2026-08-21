import { MessageHub } from './message-hub.ts';
import { InProcessTransportBus, InProcessTransport } from './in-process-transport.ts';
import type { ChannelEventHandler } from './types.ts';

export interface BaseEventData {
  sessionId: string;
}

export interface TypedHubOptions {
  name?: string;

  debug?: boolean;

  simulatedLatency?: number;

  bus?: InProcessTransportBus;
}

export interface TypedSubscribeOptions {
  sessionId?: string;
}

export interface HandlerFailure {
  event: string;

  error: Error;
}

export interface PublishResult {
  delivered: number;

  failures: HandlerFailure[];
}

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

export class TypedHub<TEventMap extends Record<string, BaseEventData>> {
  private readonly name: string;
  private readonly debug: boolean;

  private bus: InProcessTransportBus;
  private transport: InProcessTransport;
  private hub: MessageHub;
  private ownsBus: boolean;
  private initialized = false;

  private localHandlers: Map<string, Map<string, Set<(data: unknown) => void | Promise<void>>>> =
    new Map();

  private handlerNames: Map<
    string,
    Map<string, WeakMap<(data: unknown) => void | Promise<void>, string>>
  > = new Map();

  private handlerNameCounters: Map<string, number> = new Map();

  private hubSubscriptions: Map<string, (() => void)[]> = new Map();

  constructor(options: TypedHubOptions = {}) {
    this.name = options.name || 'typed-hub';
    this.debug = options.debug || false;

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

    this.transport = this.bus.createTransport(this.name);

    this.hub = new MessageHub({
      defaultSessionId: 'global',
    });
    this.hub.registerTransport(this.transport);
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    await this.transport.initialize();
    this.initialized = true;
    this.log('Initialized');
  }

  async publish<K extends keyof TEventMap & string>(
    event: K,
    data: TEventMap[K]
  ): Promise<PublishResult> {
    if (!this.initialized) {
      throw new Error('TypedHub not initialized. Call initialize() first.');
    }

    this.log(`Publishing: ${event}`, data);

    this.hub.event(event, data, { channel: data.sessionId });

    const result = await this.dispatchLocally(event, data);

    if (result.failures.length > 0) {
      throw new TypedHubPublishError(event, result);
    }

    return result;
  }

  publishAsync<K extends keyof TEventMap & string>(event: K, data: TEventMap[K]): void {
    if (!this.initialized) {
      throw new Error('TypedHub not initialized. Call initialize() first.');
    }

    this.log(`Publishing (async): ${event}`, data);

    this.hub.event(event, data, { channel: data.sessionId });

    queueMicrotask(() => {
      this.dispatchLocally(event, data).catch(() => {});
    });
  }

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

    const sessionHandlers = eventHandlers.get(eventSessionId);
    if (sessionHandlers) {
      for (const handler of sessionHandlers) {
        const name = this.getHandlerName(event, eventSessionId, handler);
        targets.push({ handler, name });
      }
    }

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

  subscribe<K extends keyof TEventMap & string>(
    event: K,
    handler: (data: TEventMap[K]) => void | Promise<void>,
    options?: TypedSubscribeOptions
  ): () => void {
    const sessionId = options?.sessionId;
    const subscriptionKey = sessionId || '__global__';

    const typedHandler = handler as (data: unknown) => void | Promise<void>;

    if (!this.localHandlers.has(event)) {
      this.localHandlers.set(event, new Map());
    }
    const eventHandlers = this.localHandlers.get(event)!;
    if (!eventHandlers.has(subscriptionKey)) {
      eventHandlers.set(subscriptionKey, new Set());
    }
    eventHandlers.get(subscriptionKey)!.add(typedHandler);

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

    const hubHandler: ChannelEventHandler = (data) => {
      const eventData = data as TEventMap[K];
      if (sessionId && eventData.sessionId !== sessionId) {
        return;
      }
      handler(eventData);
    };
    const hubUnsub = this.hub.onEvent(event, hubHandler);

    if (!this.hubSubscriptions.has(event)) {
      this.hubSubscriptions.set(event, []);
    }
    this.hubSubscriptions.get(event)!.push(hubUnsub);

    this.log(`Subscribed to ${event}${sessionId ? ` (session: ${sessionId})` : ''}`);

    return () => {
      const eventHandlers = this.localHandlers.get(event);
      if (eventHandlers) {
        const handlers = eventHandlers.get(subscriptionKey);
        if (handlers) {
          handlers.delete(typedHandler);
          if (handlers.size === 0) {
            eventHandlers.delete(subscriptionKey);
            this.handlerNameCounters.delete(`${event}:${subscriptionKey}`);
          }
        }
        if (eventHandlers.size === 0) {
          this.localHandlers.delete(event);
        }
      }

      const nameMap = this.handlerNames.get(event);
      if (nameMap) {
        nameMap.delete(subscriptionKey);
        if (nameMap.size === 0) {
          this.handlerNames.delete(event);
        }
      }

      hubUnsub();

      this.log(`Unsubscribed from ${event}${sessionId ? ` (session: ${sessionId})` : ''}`);
    };
  }

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

  emit<K extends keyof TEventMap & string>(event: K, data: TEventMap[K]): Promise<PublishResult> {
    return this.publish(event, data);
  }

  on<K extends keyof TEventMap & string>(
    event: K,
    handler: (data: TEventMap[K]) => void | Promise<void>,
    options?: TypedSubscribeOptions
  ): () => void {
    return this.subscribe(event, handler, options);
  }

  getMessageHub(): MessageHub {
    return this.hub;
  }

  getBus(): InProcessTransportBus {
    return this.bus;
  }

  createParticipant(name: string): TypedHub<TEventMap> {
    return new TypedHub<TEventMap>({
      name,
      debug: this.debug,
      bus: this.bus,
    });
  }

  async close(): Promise<void> {
    for (const unsubs of this.hubSubscriptions.values()) {
      for (const unsub of unsubs) {
        unsub();
      }
    }
    this.hubSubscriptions.clear();

    this.localHandlers.clear();

    this.handlerNames.clear();

    this.handlerNameCounters.clear();

    await this.transport.close();

    if (this.ownsBus) {
      await this.bus.close();
    }

    this.initialized = false;
    this.log('Closed');
  }

  private log(_message: string, ..._args: unknown[]): void {}
}
