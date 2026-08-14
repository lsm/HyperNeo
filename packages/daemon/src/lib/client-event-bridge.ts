/**
 * ClientEventBridge — declarative mapping from InternalEventBus internal events to client-safe events.
 *
 * Today, StateProjectionService (formerly StateManager) contains ~30 repetitive
 * daemon-to-client forwarding handlers that do nothing but call
 * `messageHub.event(method, data, { channel })`.  This module extracts those
 * into a single bridge that:
 *
 *   1. Subscribes to selected InternalEventBus events.
 *   2. Forwards the payload verbatim (or via a lightweight transform) through
 *      ClientEventGateway using typed Channels.
 *
 * Scope
 * -----
 * This module now contains ALL pure forwarding paths that were formerly in
 * StateManager:
 * - Space events (16 mappings) — first slice
 * - Session events (session.created, session.deleted, context.updated)
 * - Connection/auth events (api.connection, auth.changed)
 * - Config events (commands.updated)
 * - Error events (session.error, session.errorClear)
 *
 * StateProjectionService retains:
 * - State cache updates (sessionCache, processingStateCache, commandsCache, errorCache)
 * - Versioned broadcast methods (broadcastSystemChange, broadcastSettingsChange,
 *   broadcastSessionStateChange, broadcastSDKMessagesChange, broadcastSDKMessagesDelta)
 * - RPC handlers for state snapshots
 * - channelVersions lifecycle management
 *
 * Design notes
 * ------------
 * - The bridge intentionally does NOT own channelVersions; that stays in
 *   StateProjectionService.
 * - Each bridge mapping is a plain object so the registry is auditable in one
 *   place.
 * - The bridge is constructed in DaemonApp and wired before handlers start
 *   emitting events.
 */

import type { IClientEventGateway, EventChannel } from '@hyperneo/shared';
import { Channels } from '@hyperneo/shared';
import type { DaemonInternalEventMap, InternalEventBus } from './internal-event-bus';
import { Logger } from './logger';

type ClientBridgeEventName = keyof DaemonInternalEventMap & string;
type ClientBridgePayload = DaemonInternalEventMap[keyof DaemonInternalEventMap];

interface BridgeMapping {
  event: ClientBridgeEventName;
  clientEvent: string;
  channel: (payload: ClientBridgePayload) => EventChannel;
  transform?: (payload: ClientBridgePayload) => unknown;
}

/**
 * Narrow interface for the broadcast methods StateProjectionService exposes to
 * the bridge. Keeping this minimal prevents the bridge from depending on the
 * full StateProjectionService surface and makes testing straightforward.
 */
export interface StateBroadcasts {
  broadcastSystemChange(): Promise<void>;
  broadcastSessionStateChange(sessionId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Space bridge mappings
// ---------------------------------------------------------------------------

const SPACE_BRIDGE_MAPPINGS: BridgeMapping[] = [
  // Broad space events → global
  {
    event: 'space.created',
    clientEvent: 'space.created',
    channel: () => Channels.global(),
  },
  {
    event: 'space.updated',
    clientEvent: 'space.updated',
    channel: () => Channels.global(),
  },
  {
    event: 'space.archived',
    clientEvent: 'space.archived',
    channel: () => Channels.global(),
  },
  {
    event: 'space.deleted',
    clientEvent: 'space.deleted',
    channel: () => Channels.global(),
  },
  // Space task events → global
  {
    event: 'space.task.created',
    clientEvent: 'space.task.created',
    channel: () => Channels.global(),
  },
  {
    event: 'space.task.updated',
    clientEvent: 'space.task.updated',
    channel: () => Channels.global(),
  },
  // Space schedule events → global
  {
    event: 'space.schedule.updated',
    clientEvent: 'space.schedule.updated',
    channel: () => Channels.global(),
  },
  // Space workflow run events → global
  {
    event: 'space.workflowRun.created',
    clientEvent: 'space.workflowRun.created',
    channel: () => Channels.global(),
  },
  {
    event: 'space.workflowRun.updated',
    clientEvent: 'space.workflowRun.updated',
    channel: () => Channels.global(),
  },
  // Misc client-visible space events → global
  {
    event: 'space.hookState.updated',
    clientEvent: 'space.hookState.updated',
    channel: () => Channels.global(),
  },
  {
    event: 'space.artifactCache.updated',
    clientEvent: 'space.artifactCache.updated',
    channel: () => Channels.global(),
  },
  {
    event: 'space.pendingMessage.queued',
    clientEvent: 'space.pendingMessage.queued',
    channel: () => Channels.global(),
  },
  {
    event: 'space.pendingMessage.delivered',
    clientEvent: 'space.pendingMessage.delivered',
    channel: () => Channels.global(),
  },
  {
    event: 'space.workflowRun.cyclesReset',
    clientEvent: 'space.workflowRun.cyclesReset',
    channel: () => Channels.global(),
  },
  {
    event: 'space.workflowRun.deadLoop',
    clientEvent: 'space.workflowRun.deadLoop',
    channel: () => Channels.global(),
  },
  // Space agent events → space-scoped
  {
    event: 'spaceAgent.created',
    clientEvent: 'spaceAgent.created',
    channel: (p) => Channels.space((p as DaemonInternalEventMap['spaceAgent.created']).spaceId),
  },
  {
    event: 'spaceAgent.updated',
    clientEvent: 'spaceAgent.updated',
    channel: (p) => Channels.space((p as DaemonInternalEventMap['spaceAgent.updated']).spaceId),
  },
  {
    event: 'spaceAgent.deleted',
    clientEvent: 'spaceAgent.deleted',
    channel: (p) => Channels.space((p as DaemonInternalEventMap['spaceAgent.deleted']).spaceId),
  },
  {
    event: 'spaceLongHorizonAgent.created',
    clientEvent: 'spaceLongHorizonAgent.created',
    channel: (p) =>
      Channels.space((p as DaemonInternalEventMap['spaceLongHorizonAgent.created']).spaceId),
  },
  {
    event: 'spaceLongHorizonAgent.updated',
    clientEvent: 'spaceLongHorizonAgent.updated',
    channel: (p) =>
      Channels.space((p as DaemonInternalEventMap['spaceLongHorizonAgent.updated']).spaceId),
  },
  {
    event: 'spaceLongHorizonAgent.deleted',
    clientEvent: 'spaceLongHorizonAgent.deleted',
    channel: (p) =>
      Channels.space((p as DaemonInternalEventMap['spaceLongHorizonAgent.deleted']).spaceId),
  },
  // Space workflow definition events → global
  {
    event: 'spaceWorkflow.created',
    clientEvent: 'spaceWorkflow.created',
    channel: () => Channels.global(),
  },
  {
    event: 'spaceWorkflow.updated',
    clientEvent: 'spaceWorkflow.updated',
    channel: () => Channels.global(),
  },
  {
    event: 'spaceWorkflow.deleted',
    clientEvent: 'spaceWorkflow.deleted',
    channel: () => Channels.global(),
  },
];

// ---------------------------------------------------------------------------
// Session bridge mappings (pure gateway forwarding)
// ---------------------------------------------------------------------------

const SESSION_BRIDGE_MAPPINGS: BridgeMapping[] = [
  {
    event: 'session.created',
    clientEvent: 'session.created',
    channel: () => Channels.global(),
    transform: (payload) => {
      const p = payload as DaemonInternalEventMap['session.created'];
      return { sessionId: p.session.id };
    },
  },
  {
    event: 'session.deleted',
    clientEvent: 'session.deleted',
    channel: () => Channels.global(),
    transform: (payload) => {
      const p = payload as DaemonInternalEventMap['session.deleted'];
      return { sessionId: p.sessionId };
    },
  },
  {
    event: 'context.updated',
    clientEvent: 'context.updated',
    channel: (payload) => {
      const p = payload as DaemonInternalEventMap['context.updated'];
      return Channels.session(p.sessionId);
    },
    transform: (payload) => {
      const p = payload as DaemonInternalEventMap['context.updated'];
      return p.contextInfo;
    },
  },
  {
    event: 'providers.changed',
    clientEvent: 'providers.changed',
    channel: () => Channels.global(),
  },
];

/**
 * ClientEventBridge wires InternalEventBus event subscriptions to ClientEventGateway
 * deliveries. Each mapping in the registry becomes one `internalEventBus.subscribe(...)`
 * subscriber that forwards through the gateway.
 */
export class ClientEventBridge {
  private unsubscribers: (() => void)[] = [];
  private logger = new Logger('ClientEventBridge');

  constructor(
    private internalEventBus: InternalEventBus<DaemonInternalEventMap>,
    private gateway: IClientEventGateway,
    private broadcasts?: StateBroadcasts
  ) {}

  /**
   * Subscribe to all registered events and start forwarding.
   * Idempotent: calling start() on an already-started bridge is a no-op.
   */
  start(): void {
    if (this.unsubscribers.length > 0) {
      return;
    }

    // Space events
    for (const mapping of SPACE_BRIDGE_MAPPINGS) {
      this.subscribeMapping(mapping);
    }

    // Session events (pure forwarding + broadcast triggers)
    for (const mapping of SESSION_BRIDGE_MAPPINGS) {
      this.subscribeMapping(mapping);
    }
    this.subscribeBroadcast('context.updated', (data) =>
      this.broadcasts?.broadcastSessionStateChange(data.sessionId)
    );

    // Connection/auth events (trigger broadcasts via StateManager)
    this.subscribeBroadcast('api.connection', () => this.broadcasts?.broadcastSystemChange());
    this.subscribeBroadcast('auth.changed', () => this.broadcasts?.broadcastSystemChange());

    // Config events (trigger broadcast via StateManager)
    this.subscribeBroadcast('commands.updated', (data) =>
      this.broadcasts?.broadcastSessionStateChange(data.sessionId)
    );

    // Error events (trigger broadcast via StateManager)
    this.subscribeBroadcast('session.error', (data) =>
      this.broadcasts?.broadcastSessionStateChange(data.sessionId)
    );
    this.subscribeBroadcast('session.errorClear', (data) =>
      this.broadcasts?.broadcastSessionStateChange(data.sessionId)
    );
  }

  /**
   * Unsubscribe from all events.  After stop(), start() may be called again.
   */
  stop(): void {
    for (const unsub of this.unsubscribers) {
      unsub();
    }
    this.unsubscribers = [];
  }

  private subscribeMapping(mapping: BridgeMapping): void {
    const unsub = this.internalEventBus.subscribe(
      mapping.event,
      (data: ClientBridgePayload) => {
        const payload = mapping.transform ? mapping.transform(data) : data;
        this.gateway.publish(mapping.clientEvent, payload, mapping.channel(data));
      },
      { subscriberName: `ClientEventBridge.${mapping.event}` }
    );
    this.unsubscribers.push(unsub);
  }

  private subscribeBroadcast<K extends ClientBridgeEventName>(
    event: K,
    broadcast: (data: DaemonInternalEventMap[K]) => Promise<void> | undefined
  ): void {
    const unsub = this.internalEventBus.subscribe(
      event,
      (data: DaemonInternalEventMap[K]) => {
        const promise = broadcast(data);
        if (promise) {
          return promise.catch((err) => {
            // Return the promise so InternalEventBus awaits it, preserving publish
            // completion semantics. Log here so failures are visible even
            // when StateManager's own logging is insufficient.
            this.logger.warn(`Broadcast failed for ${event}:`, err);
          });
        }
      },
      { subscriberName: `ClientEventBridge.${event}.broadcast` }
    );
    this.unsubscribers.push(unsub);
  }
}

/**
 * Convenience factory.
 */
export function createClientEventBridge(
  internalEventBus: InternalEventBus<DaemonInternalEventMap>,
  gateway: IClientEventGateway,
  broadcasts?: StateBroadcasts
): ClientEventBridge {
  return new ClientEventBridge(internalEventBus, gateway, broadcasts);
}
