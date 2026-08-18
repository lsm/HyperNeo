export type EventChannel =
  | { kind: 'global' }
  | { kind: 'session'; sessionId: string }
  | { kind: 'room'; roomId: string }
  | { kind: 'space'; spaceId: string }
  | { kind: 'workflowRun'; spaceId: string; workflowRunId: string }
  | { kind: 'task'; spaceId: string; taskId: string };

export type ChannelWireString = string;

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

export const GLOBAL_CHANNEL_WIRE = 'global';

export interface ChannelRegistry {
  toWire(channel: EventChannel): ChannelWireString;

  parse(wire: ChannelWireString): EventChannel | null;

  matches(channel: EventChannel, wire: ChannelWireString): boolean;
}

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

export const channelRegistry: ChannelRegistry = new DefaultChannelRegistry();

export function channelToWire(channel: EventChannel): ChannelWireString {
  return channelRegistry.toWire(channel);
}
