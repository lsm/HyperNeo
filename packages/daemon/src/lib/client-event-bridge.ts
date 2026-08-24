import type { IClientEventGateway, EventChannel } from '@hyperneo/shared';
import { Channels } from '@hyperneo/shared';
import type { DaemonInternalEventMap, InternalEventBus } from './internal-event-bus.ts';
import { Logger } from './logger.ts';

type ClientBridgeEventName = keyof DaemonInternalEventMap & string;
type ClientBridgePayload = DaemonInternalEventMap[keyof DaemonInternalEventMap];

interface BridgeMapping {
  event: ClientBridgeEventName;
  clientEvent: string;
  channel: (payload: ClientBridgePayload) => EventChannel;
  transform?: (payload: ClientBridgePayload) => unknown;
}

export interface StateBroadcasts {
  broadcastSystemChange(): Promise<void>;
  broadcastSessionStateChange(sessionId: string): Promise<void>;
}

const SPACE_BRIDGE_MAPPINGS: BridgeMapping[] = [
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
  {
    event: 'space.schedule.updated',
    clientEvent: 'space.schedule.updated',
    channel: () => Channels.global(),
  },
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
  {
    event: 'messages.statusChanged',
    clientEvent: 'messages.statusChanged',
    channel: () => Channels.global(),
    transform: (payload) => {
      const p = payload as DaemonInternalEventMap['messages.statusChanged'];
      return { sessionId: p.sessionId };
    },
  },
];

export class ClientEventBridge {
  private unsubscribers: (() => void)[] = [];
  private logger = new Logger('ClientEventBridge');

  constructor(
    private internalEventBus: InternalEventBus<DaemonInternalEventMap>,
    private gateway: IClientEventGateway,
    private broadcasts?: StateBroadcasts
  ) {}

  start(): void {
    if (this.unsubscribers.length > 0) {
      return;
    }

    for (const mapping of SPACE_BRIDGE_MAPPINGS) {
      this.subscribeMapping(mapping);
    }

    for (const mapping of SESSION_BRIDGE_MAPPINGS) {
      this.subscribeMapping(mapping);
    }
    this.subscribeBroadcast('context.updated', (data) =>
      this.broadcasts?.broadcastSessionStateChange(data.sessionId)
    );

    this.subscribeBroadcast('api.connection', () => this.broadcasts?.broadcastSystemChange());
    this.subscribeBroadcast('auth.changed', () => this.broadcasts?.broadcastSystemChange());

    this.subscribeBroadcast('commands.updated', (data) =>
      this.broadcasts?.broadcastSessionStateChange(data.sessionId)
    );

    this.subscribeBroadcast('session.error', (data) =>
      this.broadcasts?.broadcastSessionStateChange(data.sessionId)
    );
    this.subscribeBroadcast('session.errorClear', (data) =>
      this.broadcasts?.broadcastSessionStateChange(data.sessionId)
    );
  }

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
            this.logger.warn(`Broadcast failed for ${event}:`, err);
          });
        }
      },
      { subscriberName: `ClientEventBridge.${event}.broadcast` }
    );
    this.unsubscribers.push(unsub);
  }
}

export function createClientEventBridge(
  internalEventBus: InternalEventBus<DaemonInternalEventMap>,
  gateway: IClientEventGateway,
  broadcasts?: StateBroadcasts
): ClientEventBridge {
  return new ClientEventBridge(internalEventBus, gateway, broadcasts);
}
