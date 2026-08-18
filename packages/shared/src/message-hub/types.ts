import type { HubMessage } from './protocol.ts';

export type { HubMessage };

export type TimeoutId = ReturnType<typeof setTimeout>;

export type IntervalId = ReturnType<typeof setInterval>;

export type RequestHandler<TData = unknown, TResult = unknown> = (
  data: TData,
  context: CallContext
) => TResult | Promise<TResult> | void | Promise<void>;

export type ChannelEventHandler<TData = unknown> = (
  data: TData,
  context: EventContext & { channel?: string }
) => void | Promise<void>;

export type MessageHandler = (message: HubMessage, direction: 'in' | 'out') => void | Promise<void>;

export type ConnectionStateHandler = (state: ConnectionState, error?: Error) => void;

export interface CallContext {
  messageId: string;

  sessionId: string;

  method: string;

  timestamp: string;

  clientId?: string;
}

export interface EventContext {
  messageId: string;

  sessionId: string;

  method: string;

  timestamp: string;
}

export type ConnectionState =
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'error'
  | 'reconnecting'
  | 'failed';

export interface QueryOptions {
  timeout?: number;

  channel?: string;
}

export interface EventOptions {
  channel?: string;
}

export interface MessageHubOptions {
  defaultSessionId?: string;

  debug?: boolean;

  timeout?: number;

  autoReconnect?: boolean;

  maxReconnectAttempts?: number;

  reconnectDelay?: number;

  pingInterval?: number;

  maxPendingCalls?: number;

  maxCacheSize?: number;

  cacheTTL?: number;

  maxEventDepth?: number;

  stopOnEventHandlerError?: boolean;
}

export interface BroadcastResult {
  sent: number;
  failed: number;
  totalTargets: number;
}

export interface IMessageTransport {
  readonly name: string;

  initialize(): Promise<void>;

  sendToClient?(clientId: string, message: HubMessage): Promise<boolean>;

  broadcastToClients?(clientIds: string[], message: HubMessage): Promise<BroadcastResult>;

  send(message: HubMessage): Promise<void>;

  close(): Promise<void>;

  isReady(): boolean;

  getState(): ConnectionState;

  onMessage(handler: (message: HubMessage) => void): () => void;

  onConnectionChange(handler: ConnectionStateHandler): () => void;

  onClientDisconnect?(handler: (clientId: string) => void): () => void;
}

export interface PendingCall<TResult = unknown> {
  resolve: (data: TResult) => void;

  reject: (error: Error) => void;

  timer: TimeoutId;

  method: string;

  sessionId: string;
}

export type MethodSubscribers = Map<string, Set<string>>;

export type RouterSubscriptions = Map<string, MethodSubscribers>;
