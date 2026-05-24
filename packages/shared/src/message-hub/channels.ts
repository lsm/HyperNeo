/**
 * Channels & ChannelRegistry
 *
 * Canonical, typed construction and parsing of daemon ↔ client channel names.
 *
 * Today's channel routing uses opaque strings such as `'global'`, `'session:abc'`,
 * `'room:r1'`, and `'space:s1'`. Spreading these literals through call sites makes
 * it easy to introduce typos and hard to evolve the channel scheme. This module
 * gives channels a single owner: a typed `EventChannel` ADT plus a registry that
 * serializes/parses to the wire strings the router already understands.
 *
 * Goals (foundation milestone)
 * ----------------------------
 * 1. Provide a `Channels` factory that mirrors the architecture plan
 *    (`docs/plans/internal-event-command-query-architecture.md`).
 * 2. Provide a small `ChannelRegistry` instance that serializes and parses
 *    channel descriptors to/from the existing wire strings without forcing
 *    callers to migrate immediately.
 * 3. Stay zero-overhead: the helpers are pure, allocation-light, and free of
 *    dependencies on `MessageHub` / `DaemonHub`. They can be imported from any
 *    package safely.
 *
 * Migration steps
 * ---------------
 * 1. New code constructs channels via `Channels.*` and serializes via
 *    `channelRegistry.toWire(...)` (or accepts an `EventChannel` and lets
 *    `ClientEventGateway` handle serialization).
 * 2. Existing call sites that pass raw channel strings stay untouched until a
 *    follow-up extraction PR migrates them. The wire format is intentionally
 *    unchanged so the router and `MessageHubRouter` continue to work as-is.
 * 3. Down the line, `Channels` becomes the only public way to construct a
 *    channel and the wire format itself can evolve behind the registry.
 *
 * Versioning note
 * ---------------
 * `StateManager` keeps a `channelVersions` map keyed by the wire string. This
 * registry deliberately preserves the existing wire format so that bookkeeping
 * keeps working without changes during the foundation milestone. A future
 * change can move version tracking onto the registry once all publishers go
 * through it.
 */

/**
 * Tagged union describing every channel a daemon-side publisher can target.
 *
 * Add new variants here as new domains acquire client-visible scopes. The
 * registry below must learn how to serialize/parse any new variant.
 */
export type EventChannel =
  | { kind: 'global' }
  | { kind: 'session'; sessionId: string }
  | { kind: 'room'; roomId: string }
  | { kind: 'space'; spaceId: string }
  | { kind: 'workflowRun'; spaceId: string; workflowRunId: string }
  | { kind: 'task'; spaceId: string; taskId: string };

/**
 * The wire-level form used by the router and the existing `messageHub.event`
 * call sites.  Kept as a string alias so existing code can adopt the helpers
 * without a heavy type cascade.
 */
export type ChannelWireString = string;

/**
 * Pure factories for `EventChannel` values.
 *
 * Prefer these over inline object literals — adding a new factory makes it
 * easy to grep for every publisher targeting a particular scope.
 */
export const Channels = {
  global: (): EventChannel => ({ kind: 'global' }),
  session: (sessionId: string): EventChannel => ({ kind: 'session', sessionId }),
  room: (roomId: string): EventChannel => ({ kind: 'room', roomId }),
  space: (spaceId: string): EventChannel => ({ kind: 'space', spaceId }),
  workflowRun: (spaceId: string, workflowRunId: string): EventChannel => ({
    kind: 'workflowRun',
    spaceId,
    workflowRunId,
  }),
  task: (spaceId: string, taskId: string): EventChannel => ({ kind: 'task', spaceId, taskId }),
} as const;

/**
 * Wire prefix for the global broadcast channel.
 *
 * Exported as a constant so `ClientEventGateway` and tests don't repeat the
 * literal.
 */
export const GLOBAL_CHANNEL_WIRE = 'global';

/**
 * The result of parsing a wire string back into an `EventChannel`.
 *
 * Returns `null` for inputs the registry can't recognise (e.g. an arbitrary
 * sessionId that pre-dates this helper). Callers that need to be tolerant of
 * legacy strings should fall through to passing the raw value to the router
 * unchanged — the registry is descriptive, not prescriptive.
 */
export interface ChannelRegistry {
  /** Serialize a typed channel descriptor to the wire string. */
  toWire(channel: EventChannel): ChannelWireString;

  /**
   * Parse a wire string into a typed channel descriptor.
   *
   * Returns `null` if the string does not match a known shape. We avoid
   * throwing here because this code path is also used by passive observers
   * (logging, tests) that should not break on unfamiliar channels.
   */
  parse(wire: ChannelWireString): EventChannel | null;

  /**
   * Type-narrowing helper: does the wire string serialize the given channel?
   *
   * Useful in tests to assert that a publisher targeted a specific channel
   * without relying on string equality.
   */
  matches(channel: EventChannel, wire: ChannelWireString): boolean;
}

/**
 * Default registry implementation.
 *
 * Wire format:
 *   global               → 'global'
 *   session              → 'session:${sessionId}'
 *   room                 → 'room:${roomId}'
 *   space                → 'space:${spaceId}'
 *   workflowRun          → 'workflowRun:${spaceId}:${workflowRunId}'
 *   task                 → 'task:${spaceId}:${taskId}'
 */
class DefaultChannelRegistry implements ChannelRegistry {
  toWire(channel: EventChannel): ChannelWireString {
    switch (channel.kind) {
      case 'global':
        return GLOBAL_CHANNEL_WIRE;
      case 'session':
        return `session:${channel.sessionId}`;
      case 'room':
        return `room:${channel.roomId}`;
      case 'space':
        return `space:${channel.spaceId}`;
      case 'workflowRun':
        return `workflowRun:${channel.spaceId}:${channel.workflowRunId}`;
      case 'task':
        return `task:${channel.spaceId}:${channel.taskId}`;
    }
  }

  parse(wire: ChannelWireString): EventChannel | null {
    if (wire === GLOBAL_CHANNEL_WIRE) {
      return { kind: 'global' };
    }

    const colon = wire.indexOf(':');
    if (colon === -1) return null;

    const prefix = wire.slice(0, colon);
    const rest = wire.slice(colon + 1);

    switch (prefix) {
      case 'session':
        return rest.length > 0 ? { kind: 'session', sessionId: rest } : null;
      case 'room':
        return rest.length > 0 ? { kind: 'room', roomId: rest } : null;
      case 'space':
        return rest.length > 0 ? { kind: 'space', spaceId: rest } : null;
      case 'workflowRun': {
        const split = rest.indexOf(':');
        if (split === -1) return null;
        const spaceId = rest.slice(0, split);
        const workflowRunId = rest.slice(split + 1);
        if (!spaceId || !workflowRunId) return null;
        return { kind: 'workflowRun', spaceId, workflowRunId };
      }
      case 'task': {
        const split = rest.indexOf(':');
        if (split === -1) return null;
        const spaceId = rest.slice(0, split);
        const taskId = rest.slice(split + 1);
        if (!spaceId || !taskId) return null;
        return { kind: 'task', spaceId, taskId };
      }
      default:
        return null;
    }
  }

  matches(channel: EventChannel, wire: ChannelWireString): boolean {
    return this.toWire(channel) === wire;
  }
}

/**
 * Process-wide default registry. Stateless — safe to share across all callers.
 *
 * If a future requirement needs alternative wire formats (e.g. for a different
 * transport), instantiate a new `ChannelRegistry` rather than swapping the
 * default. The default is exported as the canonical mapping.
 */
export const channelRegistry: ChannelRegistry = new DefaultChannelRegistry();

/**
 * Convenience helper: serialize a channel descriptor without importing the
 * registry. Equivalent to `channelRegistry.toWire(channel)`.
 */
export function channelToWire(channel: EventChannel): ChannelWireString {
  return channelRegistry.toWire(channel);
}
