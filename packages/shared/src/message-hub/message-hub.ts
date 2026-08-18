import { createLogger } from '../logger.ts';
import { generateUUID } from '../utils.ts';

const log = createLogger('hyperneo:messagehub');

import {
  createErrorResponseMessage,
  createEventMessage,
  createRequestMessage,
  createResponseMessage,
  ErrorCode,
  GLOBAL_SESSION_ID,
  type HubMessage,
  isEventMessage,
  isRequestMessage,
  isResponseMessage,
  isValidMessage,
  MessageType,
  validateMethod,
} from './protocol.ts';
import type { MessageHubRouter } from './router.ts';
import type {
  CallContext,
  ChannelEventHandler,
  ConnectionState,
  ConnectionStateHandler,
  EventOptions,
  IMessageTransport,
  MessageHandler,
  MessageHubOptions,
  PendingCall,
  QueryOptions,
  RequestHandler,
} from './types.ts';

type UnsubscribeFn = () => void;

export class MessageHubResponseError extends Error {
  constructor(
    message: string,
    public readonly code?: string
  ) {
    super(message);
    this.name = 'MessageHubResponseError';
  }
}

export class MessageHubHandlerError extends Error {
  constructor(
    message: string,
    public readonly code?: string
  ) {
    super(message);
    this.name = 'MessageHubHandlerError';
  }
}

export class MessageHub {
  private transports: Map<string, IMessageTransport> = new Map();
  private primaryTransportName: string | null = null;
  private router: MessageHubRouter | null = null;
  private readonly defaultSessionId: string;
  private readonly defaultTimeout: number;

  private readonly maxPendingCalls: number;
  private readonly maxEventDepth: number;

  private pendingCalls: Map<string, PendingCall<unknown>> = new Map();

  private requestHandlers: Map<string, RequestHandler> = new Map();
  private channelEventHandlers: Map<string, Set<ChannelEventHandler>> = new Map();

  private eventDepthMap = new Map<string, number>();

  private readonly stopOnEventHandlerError: boolean;

  private messageHandlers: Set<MessageHandler> = new Set();

  private connectionStateHandlers: Set<ConnectionStateHandler> = new Set();

  constructor(options: MessageHubOptions = {}) {
    this.defaultSessionId = options.defaultSessionId || GLOBAL_SESSION_ID;
    this.defaultTimeout = options.timeout || 10000;
    this.maxPendingCalls = options.maxPendingCalls || 1000;
    this.maxEventDepth = options.maxEventDepth || 10;
    this.stopOnEventHandlerError = options.stopOnEventHandlerError ?? false;
  }

  registerTransport(
    transport: IMessageTransport,
    name?: string,
    isPrimary?: boolean
  ): UnsubscribeFn {
    const transportName = name || transport.name || `transport-${Date.now()}`;

    if (this.transports.has(transportName)) {
      throw new Error(`Transport '${transportName}' already registered. Unregister it first.`);
    }

    this.transports.set(transportName, transport);

    if (this.transports.size === 1 || isPrimary) {
      this.primaryTransportName = transportName;
    }

    this.logDebug(
      `Transport registered: ${transportName} (primary: ${this.primaryTransportName === transportName})`
    );

    const unsubMessage = transport.onMessage((message) => {
      message._transportName = transportName;
      this.handleIncomingMessage(message);
    });

    const unsubConnection = transport.onConnectionChange((state, error) => {
      this.logDebug(`Connection state: ${state} on ${transportName}`, error);
      this.notifyConnectionStateHandlers(state, error);
    });

    return () => {
      this.transports.delete(transportName);
      if (this.primaryTransportName === transportName) {
        this.primaryTransportName = this.transports.keys().next().value || null;
      }
      unsubMessage();
      unsubConnection();
      this.logDebug(`Transport unregistered: ${transportName}`);
    };
  }

  getState(): ConnectionState {
    const primary = this.primaryTransportName
      ? this.transports.get(this.primaryTransportName)
      : null;
    return primary?.getState() || 'disconnected';
  }

  isConnected(): boolean {
    for (const transport of this.transports.values()) {
      if (transport.isReady()) return true;
    }
    return false;
  }

  onConnection(handler: ConnectionStateHandler): UnsubscribeFn {
    this.connectionStateHandlers.add(handler);
    return () => {
      this.connectionStateHandlers.delete(handler);
    };
  }

  onClientDisconnect(handler: (clientId: string) => void): UnsubscribeFn {
    const transport = this.primaryTransportName
      ? this.transports.get(this.primaryTransportName)
      : null;
    if (transport?.onClientDisconnect) {
      return transport.onClientDisconnect(handler);
    }
    return () => {};
  }

  registerRouter(router: MessageHubRouter): void {
    if (this.router) {
      log.warn('Router already registered, replacing...');
    }
    this.router = router;
    this.logDebug(`Router registered`);
  }

  getRouter(): MessageHubRouter | null {
    return this.router;
  }

  async request<TResult = unknown>(
    method: string,
    data?: unknown,
    options: QueryOptions = {}
  ): Promise<TResult> {
    if (!this.isConnected()) {
      throw new Error('Not connected to transport');
    }
    const sessionId = options.channel || this.defaultSessionId;
    if (!validateMethod(method)) {
      throw new Error(`Invalid method name: ${method}`);
    }
    if (this.pendingCalls.size >= this.maxPendingCalls) {
      throw new Error(
        `Too many pending calls (${this.pendingCalls.size}/${this.maxPendingCalls}).`
      );
    }

    const messageId = generateUUID();
    const timeout = options.timeout || this.defaultTimeout;

    return new Promise<TResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCalls.delete(messageId);
        reject(new Error(`Request timeout: ${method} (${timeout}ms)`));
      }, timeout);

      this.pendingCalls.set(messageId, {
        resolve: resolve as (result: unknown) => void,
        reject,
        timer,
        method,
        sessionId,
      });

      const message = createRequestMessage({ method, data, sessionId, id: messageId });
      this.sendMessage(message).catch((error) => {
        clearTimeout(timer);
        this.pendingCalls.delete(messageId);
        reject(error);
      });
    });
  }

  event(method: string, data?: unknown, options: EventOptions = {}): void {
    if (!this.isConnected()) {
      this.logDebug(`Event skipped (no transport): ${method}`);
      return;
    }
    if (!validateMethod(method)) {
      throw new Error(`Invalid method name: ${method}`);
    }
    const sessionId = options.channel || this.defaultSessionId;
    const message = createEventMessage({ method, data, sessionId });
    message.channel = options.channel;
    this.sendMessage(message).catch((error) => {
      log.error(`Failed to send event ${method}:`, error);
    });
  }

  onRequest<TData = unknown, TResult = unknown>(
    method: string,
    handler: RequestHandler<TData, TResult>
  ): UnsubscribeFn {
    if (!validateMethod(method)) {
      throw new Error(`Invalid method name: ${method}`);
    }
    if (this.requestHandlers.has(method)) {
      log.warn(`Overwriting existing request handler for: ${method}`);
    }
    this.requestHandlers.set(method, handler as RequestHandler);
    this.logDebug(`Request handler registered: ${method}`);
    return () => {
      this.requestHandlers.delete(method);
      this.logDebug(`Request handler unregistered: ${method}`);
    };
  }

  onEvent<TData = unknown>(method: string, handler: ChannelEventHandler<TData>): UnsubscribeFn {
    if (!validateMethod(method)) {
      throw new Error(`Invalid method name: ${method}`);
    }
    if (!this.channelEventHandlers.has(method)) {
      this.channelEventHandlers.set(method, new Set());
    }
    this.channelEventHandlers.get(method)!.add(handler as ChannelEventHandler);
    this.logDebug(`Event handler registered: ${method}`);
    return () => {
      this.channelEventHandlers.get(method)?.delete(handler as ChannelEventHandler);
      this.logDebug(`Event handler unregistered: ${method}`);
    };
  }

  async joinChannel(
    channel: string,
    maxRetries: number = 3,
    retryDelay: number = 1000
  ): Promise<void> {
    if (!this.isConnected()) {
      this.logDebug(`joinChannel skipped (not connected): ${channel}`);
      return;
    }

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await this.request('channel.join', { channel }, { timeout: 5000 });
        if (attempt > 1) {
          this.logDebug(`joinChannel succeeded for ${channel} on attempt ${attempt}`);
        }
        return;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.logDebug(
          `joinChannel attempt ${attempt}/${maxRetries} failed for ${channel}: ${errorMessage}`
        );

        if (attempt < maxRetries) {
          if (!this.isConnected()) {
            log.error(`joinChannel aborted for ${channel} - disconnected during retry`);
            return;
          }

          const baseDelay = retryDelay * 2 ** (attempt - 1);
          const jitter = Math.random() * baseDelay * 0.3;
          await new Promise((resolve) => setTimeout(resolve, baseDelay + jitter));
        }
      }
    }

    log.error(`joinChannel failed after ${maxRetries} attempts for ${channel}`);
  }

  async leaveChannel(channel: string): Promise<void> {
    if (!this.isConnected()) {
      this.logDebug(`leaveChannel skipped (not connected): ${channel}`);
      return;
    }
    try {
      await this.request('channel.leave', { channel });
    } catch (error) {
      this.logDebug(`leaveChannel failed for ${channel}:`, error);
    }
  }

  onMessage(handler: MessageHandler): UnsubscribeFn {
    this.messageHandlers.add(handler);
    return () => {
      this.messageHandlers.delete(handler);
    };
  }

  private async handleIncomingMessage(message: HubMessage): Promise<void> {
    if (!isValidMessage(message)) {
      log.warn(`Dropping invalid message:`, message);
      return;
    }

    this.logDebug(`← Incoming: ${message.type} ${message.method}`, message);

    this.notifyMessageHandlers(message, 'in');

    try {
      if (message.type === MessageType.PING) {
        await this.handlePing(message);
      } else if (message.type === MessageType.PONG) {
        this.handlePong(message);
      } else if (isRequestMessage(message)) {
        await this.handleIncomingRequest(message);
      } else if (isResponseMessage(message)) {
        this.handleResponse(message);
      } else if (isEventMessage(message)) {
        await this.handleEvent(message);
      }
    } catch (error) {
      log.error(`Error handling message:`, error);
    }
  }

  private async handleIncomingRequest(message: HubMessage): Promise<void> {
    const clientId = (message as import('./protocol').HubMessageWithMetadata).clientId;

    if (message.method === 'channel.join' || message.method === 'channel.leave') {
      if (this.router) {
        if (
          clientId &&
          message.data &&
          typeof (message.data as Record<string, unknown>).channel === 'string'
        ) {
          const channel = (message.data as Record<string, unknown>).channel as string;
          if (message.method === 'channel.join') {
            this.router.joinChannel(clientId, channel);
          } else {
            this.router.leaveChannel(clientId, channel);
          }
        }
      }
      const ackMsg = createResponseMessage({
        method: message.method,
        data: { acknowledged: true },
        sessionId: message.sessionId,
        requestId: message.id,
      });
      ackMsg._transportName = message._transportName;
      await this.sendResponseToClient(ackMsg, clientId);
      return;
    }

    const handler = this.requestHandlers.get(message.method);

    if (!handler) {
      const errorMsg = createErrorResponseMessage({
        method: message.method,
        error: {
          message: `No handler for method: ${message.method}`,
          code: ErrorCode.METHOD_NOT_FOUND,
        },
        sessionId: message.sessionId,
        requestId: message.id,
      });
      errorMsg._transportName = message._transportName;
      await this.sendResponseToClient(errorMsg, clientId);
      return;
    }

    try {
      const context: CallContext = {
        messageId: message.id,
        sessionId: message.sessionId,
        method: message.method,
        timestamp: message.timestamp,
        ...(clientId !== undefined ? { clientId } : {}),
      };
      const result = await Promise.resolve(handler(message.data, context));

      const responseData = result === undefined ? { acknowledged: true } : result;

      const resultMsg = createResponseMessage({
        method: message.method,
        data: responseData,
        sessionId: message.sessionId,
        requestId: message.id,
      });
      resultMsg._transportName = message._transportName;
      await this.sendResponseToClient(resultMsg, clientId);
    } catch (error) {
      const code =
        error instanceof MessageHubHandlerError && error.code
          ? error.code
          : ErrorCode.HANDLER_ERROR;
      const errorMsg = createErrorResponseMessage({
        method: message.method,
        error: {
          message: error instanceof Error ? error.message : String(error),
          code,
        },
        sessionId: message.sessionId,
        requestId: message.id,
      });
      errorMsg._transportName = message._transportName;
      await this.sendResponseToClient(errorMsg, clientId);
    }
  }

  private handleResponse(message: HubMessage): void {
    const requestId = message.requestId;
    if (!requestId) {
      log.warn(`Response without requestId:`, message);
      return;
    }

    const pending = this.pendingCalls.get(requestId);
    if (!pending) {
      this.logDebug(`Response for unknown request: ${requestId} (method: ${message.method})`);
      return;
    }

    clearTimeout(pending.timer);
    this.pendingCalls.delete(requestId);

    if (message.error) {
      pending.reject(new MessageHubResponseError(message.error, message.errorCode));
    } else {
      pending.resolve(message.data);
    }
  }

  private async handleEvent(message: HubMessage): Promise<void> {
    const currentDepth = this.eventDepthMap.get(message.id) || 0;
    if (currentDepth >= this.maxEventDepth) {
      log.error(
        `Max event depth (${this.maxEventDepth}) exceeded for ${message.method}. ` +
          `Possible circular dependency or infinite loop.`
      );
      return;
    }

    this.eventDepthMap.set(message.id, currentDepth + 1);

    try {
      this.dispatchToChannelEventHandlers(message);
    } finally {
      this.eventDepthMap.delete(message.id);
    }
  }

  private dispatchToChannelEventHandlers(message: HubMessage): void {
    const handlers = this.channelEventHandlers.get(message.method);
    if (!handlers || handlers.size === 0) return;

    const context = {
      messageId: message.id,
      sessionId: message.sessionId,
      method: message.method,
      timestamp: message.timestamp,
      channel: message.channel,
    };

    for (const handler of handlers) {
      try {
        Promise.resolve(handler(message.data, context)).catch((error) => {
          log.error(`Channel event handler error for ${message.method}:`, error);
        });
      } catch (error) {
        log.error(`Channel event handler sync error for ${message.method}:`, error);
      }
    }
  }

  private async handlePing(message: HubMessage): Promise<void> {
    this.logDebug(`Received PING from session: ${message.sessionId}`);

    const pongMessage: HubMessage = {
      id: generateUUID(),
      type: MessageType.PONG,
      sessionId: message.sessionId,
      method: 'heartbeat',
      timestamp: new Date().toISOString(),
      requestId: message.id,
    };

    await this.sendMessage(pongMessage);
  }

  private handlePong(message: HubMessage): void {
    this.logDebug(`Received PONG from session: ${message.sessionId}`);
  }

  private async sendMessage(message: HubMessage): Promise<void> {
    this.logDebug(`→ Outgoing: ${message.type} ${message.method}`, message);

    this.notifyMessageHandlers(message, 'out');

    if (this.router && message.type === MessageType.EVENT) {
      if (message.channel && this.router) {
        this.router.routeEventToChannel(message);
      } else {
        const result = this.router.routeEvent(message);
        this.logDebug(`Routed event: ${result.sent}/${result.totalSubscribers} delivered`);
      }
      this.dispatchToChannelEventHandlers(message);
      return;
    }

    const targetTransport = message._transportName
      ? this.transports.get(message._transportName)
      : null;

    if (targetTransport && targetTransport.isReady()) {
      await targetTransport.send(message);
      return;
    }

    const primary = this.primaryTransportName
      ? this.transports.get(this.primaryTransportName)
      : null;
    if (primary && primary.isReady()) {
      await primary.send(message);
      return;
    }

    throw new Error('No transport ready');
  }

  private async sendResponseToClient(message: HubMessage, clientId?: string): Promise<void> {
    this.notifyMessageHandlers(message, 'out');

    if (this.router && clientId) {
      const result = this.router.sendToClientDetailed(clientId, message);
      if (!result.ok && result.reason === 'message_too_large') {
        const errorMessage = createErrorResponseMessage({
          method: message.method,
          error: {
            code: ErrorCode.MESSAGE_TOO_LARGE,
            message: 'Response is too large to send; load a smaller window',
          },
          sessionId: message.sessionId,
          requestId: message.requestId ?? message.id,
          channel: message.channel,
        });
        const errorResult = this.router.sendToClientDetailed(clientId, errorMessage);
        if (!errorResult.ok) log.warn(`Failed to send size error to client ${clientId}`);
      } else if (!result.ok) {
        log.warn(`Failed to send response to client ${clientId}`);
      }
      return;
    }

    const targetTransport = message._transportName
      ? this.transports.get(message._transportName)
      : null;

    if (targetTransport && targetTransport.isReady()) {
      await targetTransport.send(message);
      return;
    }

    const primary = this.primaryTransportName
      ? this.transports.get(this.primaryTransportName)
      : null;

    if (primary && primary.isReady()) {
      await primary.send(message);
      return;
    }

    throw new Error('No transport ready for response');
  }

  private notifyMessageHandlers(message: HubMessage, direction: 'in' | 'out'): void {
    for (const handler of this.messageHandlers) {
      try {
        handler(message, direction);
      } catch (error) {
        log.error(`Error in message handler:`, error);
      }
    }
  }

  private notifyConnectionStateHandlers(state: ConnectionState, error?: Error): void {
    for (const handler of this.connectionStateHandlers) {
      try {
        handler(state, error);
      } catch (err) {
        log.error(`Error in connection state handler:`, err);
      }
    }
  }

  cleanup(): void {
    for (const [_requestId, pending] of this.pendingCalls) {
      clearTimeout(pending.timer);
      pending.reject(new Error('MessageHub cleanup'));
    }
    this.pendingCalls.clear();

    this.requestHandlers.clear();
    this.channelEventHandlers.clear();
    this.messageHandlers.clear();
    this.connectionStateHandlers.clear();
    this.eventDepthMap.clear();

    this.transports.clear();
    this.primaryTransportName = null;

    this.logDebug('MessageHub cleaned up');
  }

  private logDebug(message: string, ...args: unknown[]): void {
    log.debug(message, ...args);
  }

  getPendingCallCount(): number {
    return this.pendingCalls.size;
  }
}
