import { describe, it, expect, beforeEach } from 'bun:test';
import {
  ClientEventGateway,
  createClientEventGateway,
  type ClientEventSink,
} from '../src/message-hub/client-event-gateway.ts';
import {
  Channels,
  channelRegistry,
  type ChannelRegistry,
  type EventChannel,
} from '../src/message-hub/channels.ts';

interface RecordedCall {
  method: string;
  data: unknown;
  options?: { channel?: string };
}

class FakeHub implements ClientEventSink {
  calls: RecordedCall[] = [];

  event(method: string, data?: unknown, options?: { channel?: string }): void {
    this.calls.push({ method, data, options });
  }
}

describe('ClientEventGateway', () => {
  let hub: FakeHub;
  let gateway: ClientEventGateway;

  beforeEach(() => {
    hub = new FakeHub();
    gateway = new ClientEventGateway({ hub });
  });

  it('serializes a typed channel and forwards to the sink', () => {
    gateway.publish('session.created', { sessionId: 's1' }, Channels.global());

    expect(hub.calls).toHaveLength(1);
    expect(hub.calls[0]).toEqual({
      method: 'session.created',
      data: { sessionId: 's1' },
      options: { channel: 'global' },
    });
  });

  it('serializes session channels into the existing wire format', () => {
    gateway.publish('context.updated', { tokens: 42 }, Channels.session('abc'));

    expect(hub.calls).toHaveLength(1);
    expect(hub.calls[0]).toEqual({
      method: 'context.updated',
      data: { tokens: 42 },
      options: { channel: 'session:abc' },
    });
  });

  it('exposes publishGlobal as a convenience for global broadcasts', () => {
    gateway.publishGlobal('session.deleted', { sessionId: 's2' });

    expect(hub.calls).toHaveLength(1);
    expect(hub.calls[0]).toEqual({
      method: 'session.deleted',
      data: { sessionId: 's2' },
      options: { channel: 'global' },
    });
  });

  it('honours an injected registry', () => {
    const fakeRegistry: ChannelRegistry = {
      toWire: (channel: EventChannel) => `prefix:${channelRegistry.toWire(channel)}`,
      parse: () => null,
      matches: () => false,
    };

    const customGateway = createClientEventGateway({ hub, registry: fakeRegistry });
    customGateway.publish('foo', { ok: true }, Channels.session('s1'));

    expect(hub.calls).toHaveLength(1);
    expect(hub.calls[0]?.options?.channel).toBe('prefix:session:s1');
  });

  it('does not transform the payload', () => {
    const payload = { nested: { value: 1 }, list: [1, 2] };
    gateway.publish('event.x', payload, Channels.space('sp1'));

    expect(hub.calls[0]?.data).toBe(payload);
    expect(hub.calls[0]?.options?.channel).toBe('space:sp1');
  });

  it('supports an undefined payload (mirrors MessageHub.event signature)', () => {
    gateway.publishGlobal('ping');

    expect(hub.calls[0]?.method).toBe('ping');
    expect(hub.calls[0]?.data).toBeUndefined();
    expect(hub.calls[0]?.options?.channel).toBe('global');
  });

  it('routes multiple publishes to the right channels in order', () => {
    gateway.publish('a', 1, Channels.global());
    gateway.publish('b', 2, Channels.session('s1'));
    gateway.publish('c', 3, Channels.task('sp1', 't1'));

    expect(hub.calls.map((c) => c.options?.channel)).toEqual([
      'global',
      'session:s1',
      'task:sp1:t1',
    ]);
  });
});
