import type { MessageHub } from '@hyperneo/shared/message-hub/message-hub.ts';
import type { ExternalEventPublisher } from './external-event-service';

export interface ExternalEvent {
  id: string;
  spaceId: string;
  topic: string;
  occurredAt: number;
  ingestedAt: number;
  source: string;
  sourceEventId?: string;
  summary: string;
  externalUrl?: string;
  payload: Record<string, unknown>;
  dedupeKey: string;
}

export type ExternalEventState = 'published' | 'delivered' | 'failed' | 'ignored';

export const TERMINAL_EVENT_STATES: ReadonlySet<ExternalEventState> = new Set<ExternalEventState>([
  'delivered',
  'failed',
  'ignored',
]);

export type ExternalEventDeliveryState = 'pending' | 'delivered' | 'failed';

export const TERMINAL_DELIVERY_STATES: ReadonlySet<ExternalEventDeliveryState> =
  new Set<ExternalEventDeliveryState>(['delivered', 'failed']);

export interface ExternalEventRecord {
  event: ExternalEvent;
  state: ExternalEventState;
  createdAt: number;
  updatedAt: number;
}

export interface ExternalEventDeliveryRecord {
  eventId: string;
  deliveryKey: string;
  workflowRunId: string;
  taskId: string;
  nodeId: string;
  agentName: string;
  state: ExternalEventDeliveryState;
  failureReason: string | null;
  deliveredAt: number | null;
  updatedAt: number;
}

export interface ExternalEventDeliveryLogFilters {
  spaceId: string;
  status?: ExternalEventDeliveryState;
  source?: string;
  eventId?: string;
  agentName?: string;
  workflowRunId?: string;
  nodeId?: string;
  limit?: number;
  offset?: number;
}

export interface ExternalEventDeliveryLogRecord extends ExternalEventDeliveryRecord {
  event: ExternalEvent;
  eventState: ExternalEventState;
  eventCreatedAt: number;
  eventUpdatedAt: number;
}

export interface StoreResult {
  event: ExternalEvent;
  duplicate: boolean;
  terminal: boolean;
}

export interface DeliveryTarget {
  workflowRunId: string;
  taskId: string;
  nodeId: string;
  agentName: string;
}

export interface DeliveryFailure {
  terminal: boolean;
  reason: string;
}

export interface ExternalEventExtensionConfig {
  source: string;
  globallyEnabled: boolean;
  capabilities: {
    webhooks?: boolean;
    polling?: boolean;
    rpcConfig?: boolean;
  };
  secretsRef?: string;
  settings?: Record<string, unknown>;
}

export interface SpaceExternalEventSourceConfig {
  spaceId: string;
  source: string;
  enabled: boolean;
  settings: Record<string, unknown>;
}

export interface ExternalEventExtensionContext {
  publisher: ExternalEventPublisher;
  config: ExternalEventExtensionConfigStore;
  onSourceConfigChanged(change: { source: string; spaceId?: string; kind: string }): void;
}

export interface ExternalEventExtensionConfigStore {
  getGlobalConfig(source: string): Promise<ExternalEventExtensionConfig>;
  getSpaceConfig(spaceId: string, source: string): Promise<SpaceExternalEventSourceConfig | null>;
  listEnabledSpaces(source: string): Promise<SpaceExternalEventSourceConfig[]>;
  setGlobalConfig(source: string, config: ExternalEventExtensionConfig): Promise<void>;
  setSpaceConfig(
    spaceId: string,
    source: string,
    config: SpaceExternalEventSourceConfig
  ): Promise<void>;
}

export interface ExternalEventExtension {
  readonly sourceId: string;

  start(context: ExternalEventExtensionContext): Promise<void>;

  stop(): Promise<void>;
}

export interface Route {
  readonly method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  readonly path: string;
  handle(req: Request, context: ExternalEventExtensionContext): Promise<Response>;
}

export interface HttpExternalEventExtension extends ExternalEventExtension {
  readonly routes: readonly Route[];
}

export interface RpcExternalEventExtension extends ExternalEventExtension {
  registerRpcHandlers(hub: MessageHub, context: ExternalEventExtensionContext): void;
}
