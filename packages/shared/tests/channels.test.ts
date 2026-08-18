import { describe, expect, it } from 'bun:test';
import {
  Channels,
  GLOBAL_CHANNEL_WIRE,
  channelRegistry,
  channelToWire,
  type EventChannel,
} from '../src/message-hub/channels.ts';

describe('Channels factory', () => {
  it('produces a global channel descriptor', () => {
    expect(Channels.global()).toEqual({ kind: 'global' });
  });

  it('produces session/room/space descriptors', () => {
    expect(Channels.session('s1')).toEqual({ kind: 'session', sessionId: 's1' });
    expect(Channels.room('r1')).toEqual({ kind: 'room', roomId: 'r1' });
    expect(Channels.space('sp1')).toEqual({ kind: 'space', spaceId: 'sp1' });
  });

  it('produces workflowRun and task descriptors with both ids', () => {
    expect(Channels.workflowRun('sp1', 'wr1')).toEqual({
      kind: 'workflowRun',
      spaceId: 'sp1',
      workflowRunId: 'wr1',
    });
    expect(Channels.task('sp1', 't1')).toEqual({
      kind: 'task',
      spaceId: 'sp1',
      taskId: 't1',
    });
  });
});

describe('channelRegistry.toWire', () => {
  it('serializes the global channel to "global"', () => {
    expect(channelRegistry.toWire(Channels.global())).toBe(GLOBAL_CHANNEL_WIRE);
    expect(channelRegistry.toWire(Channels.global())).toBe('global');
  });

  it('serializes session channels to "session:${id}"', () => {
    expect(channelRegistry.toWire(Channels.session('abc'))).toBe('session:abc');
  });

  it('serializes room channels to "room:${id}"', () => {
    expect(channelRegistry.toWire(Channels.room('r-1'))).toBe('room:r-1');
  });

  it('serializes space channels to "space:${id}"', () => {
    expect(channelRegistry.toWire(Channels.space('sp-1'))).toBe('space:sp-1');
  });

  it('serializes workflowRun channels using both ids', () => {
    expect(channelRegistry.toWire(Channels.workflowRun('sp1', 'wr1'))).toBe('workflowRun:sp1:wr1');
  });

  it('serializes task channels using both ids', () => {
    expect(channelRegistry.toWire(Channels.task('sp1', 't1'))).toBe('task:sp1:t1');
  });

  it('exposes a top-level channelToWire helper that mirrors the registry', () => {
    const channel: EventChannel = { kind: 'session', sessionId: 's1' };
    expect(channelToWire(channel)).toBe(channelRegistry.toWire(channel));
  });
});

describe('channelRegistry.parse', () => {
  it('parses "global" back to the global descriptor', () => {
    expect(channelRegistry.parse('global')).toEqual({ kind: 'global' });
  });

  it('round-trips every supported channel kind', () => {
    const samples: EventChannel[] = [
      Channels.global(),
      Channels.session('s1'),
      Channels.room('r1'),
      Channels.space('sp1'),
      Channels.workflowRun('sp1', 'wr1'),
      Channels.task('sp1', 't1'),
    ];

    for (const channel of samples) {
      const wire = channelRegistry.toWire(channel);
      const parsed = channelRegistry.parse(wire);
      expect(parsed).toEqual(channel);
    }
  });

  it('returns null for unknown prefixes', () => {
    expect(channelRegistry.parse('unknown:foo')).toBeNull();
  });

  it('returns null for malformed inputs', () => {
    expect(channelRegistry.parse('')).toBeNull();
    expect(channelRegistry.parse('session:')).toBeNull();
    expect(channelRegistry.parse('workflowRun:onlySpace')).toBeNull();
    expect(channelRegistry.parse('task:onlySpace')).toBeNull();
    expect(channelRegistry.parse('workflowRun:sp1:')).toBeNull();
  });

  it('preserves ids that themselves contain colons (workflowRun/task)', () => {
    const parsed = channelRegistry.parse('workflowRun:sp1:wr-1:extra');
    expect(parsed).toEqual({
      kind: 'workflowRun',
      spaceId: 'sp1',
      workflowRunId: 'wr-1:extra',
    });
  });
});

describe('channelRegistry.matches', () => {
  it('returns true when the wire string matches the channel', () => {
    expect(channelRegistry.matches(Channels.session('s1'), 'session:s1')).toBe(true);
    expect(channelRegistry.matches(Channels.global(), 'global')).toBe(true);
  });

  it('returns false when the wire string differs', () => {
    expect(channelRegistry.matches(Channels.session('s1'), 'session:s2')).toBe(false);
    expect(channelRegistry.matches(Channels.global(), 'session:s1')).toBe(false);
  });
});
