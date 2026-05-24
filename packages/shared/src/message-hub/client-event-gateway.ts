/**
 * ClientEventGateway — typed boundary around client-facing event delivery.
 *
 * Today, daemon code reaches into `MessageHub.event(method, data, { channel })`
 * directly whenever it needs to push state to WebSocket clients. That works,
 * but it means every domain service is coupled to the transport API and
 * must remember to construct the channel string by hand.
 *
 * `ClientEventGateway` is the seam introduced in the architecture plan
 * (`docs/plans/internal-event-command-query-architecture.md`):
 *
 *   • daemon services emit a typed `EventChannel`,
 *   • the gateway serializes the channel via {@link channelRegistry} and
 *     delegates to `MessageHub.event(...)`.
 *
 * Scope (foundation milestone)
 * ----------------------------
 * This is a thin adapter, intentionally. It does **not** yet:
 *   • own state projection (still in `StateManager`),
 *   • implement the declarative `ClientEventBridge` mapping internal events
 *     to client events (a later milestone),
 *   • track per-channel cycle versions (still in `StateManager`).
 *
 * Keeping the gateway minimal lets us migrate one or two `messageHub.event(...)`
 * call sites at a time without rewriting `StateManager` wholesale, while still
 * giving every new client-facing publisher a single place to land.
 *
 * Migration strategy
 * ------------------
 * 1. Add the gateway and start using it for low-conflict broadcasts (e.g.
 *    `session.created`, `session.deleted`, `context.updated`). These have
 *    simple payloads and clear channels.
 * 2. As `StateManager` is split into projection + bridge in follow-up PRs,
 *    each new bridge handler emits via `ClientEventGateway` from day one.
 * 3. Eventually the direct `messageHub.event(...)` import disappears from
 *    daemon application code; only the gateway and transport-internal code
 *    talk to `MessageHub`.
 */

import type { EventChannel, ChannelRegistry } from './channels.ts';
import { channelRegistry as defaultChannelRegistry } from './channels.ts';

/**
 * The minimal hub surface the gateway needs.
 *
 * `MessageHub` structurally satisfies this interface, so production code
 * passes a `MessageHub` instance directly and tests pass a fake — no extra
 * adapter required. The gateway intentionally avoids importing `MessageHub`
 * so the module stays free of transport dependencies.
 */
export interface ClientEventSink {
  event(method: string, data?: unknown, options?: { channel?: string }): void;
}

/**
 * Options for constructing a `ClientEventGateway`.
 */
export interface ClientEventGatewayOptions {
  /**
   * Underlying sink — production code passes a `MessageHub` (which
   * structurally satisfies `ClientEventSink`); tests can pass any object
   * implementing the interface.
   */
  hub: ClientEventSink;

  /**
   * Channel registry to serialize `EventChannel` descriptors. Defaults to the
   * package-level `channelRegistry`.
   */
  registry?: ChannelRegistry;
}

/**
 * Public API surface for client-facing event delivery.
 *
 * Application code should depend on this interface rather than the concrete
 * implementation so that future bridges (auth, batching, fan-out filtering)
 * can slot in without touching publishers.
 */
export interface IClientEventGateway {
  /**
   * Publish an event to a typed channel.
   *
   * @param method The event/method name (matches the wire `method` clients
   *               see when they `onEvent('foo', ...)`).
   * @param data   Optional payload. Must already be JSON-serializable; the
   *               gateway does not transform payloads.
   * @param channel Typed `EventChannel` descriptor — serialized via the
   *                registry before being handed to the transport.
   */
  publish(method: string, data: unknown, channel: EventChannel): void;

  /**
   * Publish an event globally (channel = `Channels.global()`).
   *
   * Convenience wrapper for the common case where a publisher knows the
   * event is application-wide. Equivalent to passing `{ kind: 'global' }`.
   */
  publishGlobal(method: string, data?: unknown): void;
}

/**
 * Default `ClientEventGateway` implementation.
 *
 * Stateless aside from references to the hub and registry, so a single
 * gateway can be shared across every service that needs to broadcast to
 * clients. Construct one in `DaemonApp` and inject it where today services
 * receive the bare `MessageHub`.
 */
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

/**
 * Convenience factory mirroring the rest of the message-hub module.
 */
export function createClientEventGateway(options: ClientEventGatewayOptions): ClientEventGateway {
  return new ClientEventGateway(options);
}
