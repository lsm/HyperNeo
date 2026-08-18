import type { EventChannel, ChannelRegistry } from './channels.ts';
import { channelRegistry as defaultChannelRegistry } from './channels.ts';

export interface ClientEventSink {
  event(method: string, data?: unknown, options?: { channel?: string }): void;
}

export interface ClientEventGatewayOptions {
  hub: ClientEventSink;

  registry?: ChannelRegistry;
}

export interface IClientEventGateway {
  publish(method: string, data: unknown, channel: EventChannel): void;

  publishGlobal(method: string, data?: unknown): void;
}

export class ClientEventGateway implements IClientEventGateway {
  private readonly hub: ClientEventSink;
  private readonly registry: ChannelRegistry;

  constructor(options: ClientEventGatewayOptions) {
    this.hub = options.hub;
    this.registry = options.registry ?? defaultChannelRegistry;
  }

  publish(method: string, data: unknown, channel: EventChannel): void {
    const wire = this.registry.toWire(channel);
    this.hub.event(method, data, { channel: wire });
  }

  publishGlobal(method: string, data?: unknown): void {
    this.publish(method, data, { kind: 'global' });
  }
}

export function createClientEventGateway(options: ClientEventGatewayOptions): ClientEventGateway {
  return new ClientEventGateway(options);
}
