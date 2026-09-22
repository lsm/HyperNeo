import { describe, expect, test } from 'bun:test';
import {
  outboundSenderLevel,
  resolveOutboundSender,
  OUTBOUND_SENDER_REJECTION,
} from '../../../../src/lib/messaging/outbound-sender-identity.ts';
import type { OperationCallerRole } from '../../../../src/lib/operations/registry.ts';

describe('outboundSenderLevel', () => {
  test.each([
    ['long_term_agent', 'long-horizon-agent'],
    ['workflow_worker', 'node-agent'],
    ['legacy_task_agent', 'task-agent'],
    ['ad_hoc_member', 'session-agent'],
    ['direct_task_worker', 'session-agent'],
  ] as const)('maps %s to %s', (role, level) => {
    expect(outboundSenderLevel(role)).toBe(level);
  });

  test.each(['universal_read', 'outside_space', undefined] as const)(
    'has no sender level for %s',
    (role) => {
      expect(outboundSenderLevel(role as OperationCallerRole | undefined)).toBeNull();
    }
  );
});

describe('resolveOutboundSender', () => {
  test('takes the display name and reply handle from the caller agent name', () => {
    const outcome = resolveOutboundSender({
      source: 'mcp',
      sessionId: 'session-1',
      role: 'long_term_agent',
      agentName: 'Task Manager',
    });
    expect(outcome).toEqual({
      value: {
        sessionId: 'session-1',
        level: 'long-horizon-agent',
        displayName: 'Task Manager',
        replyTargetHandle: '@task-manager',
      },
    });
  });

  test('falls back to the level name and session handle when the caller is unnamed', () => {
    const outcome = resolveOutboundSender({
      source: 'mcp',
      sessionId: 'session-2',
      role: 'ad_hoc_member',
    });
    expect(outcome).toEqual({
      value: {
        sessionId: 'session-2',
        level: 'session-agent',
        displayName: 'space-member',
        replyTargetHandle: '@session:session-2',
      },
    });
  });

  test('falls back to the session handle when the agent name has no usable slug', () => {
    const outcome = resolveOutboundSender({
      source: 'internal',
      sessionId: 'session-3',
      role: 'workflow_worker',
      agentName: '!!!',
    });
    expect(outcome).toEqual({
      value: {
        sessionId: 'session-3',
        level: 'node-agent',
        displayName: '!!!',
        replyTargetHandle: '@session:session-3',
      },
    });
  });

  test('rejects a caller outside any Space role', () => {
    expect(
      resolveOutboundSender({ source: 'mcp', sessionId: 'session-4', role: 'universal_read' })
    ).toEqual({ reason: OUTBOUND_SENDER_REJECTION });
  });

  test('rejects an RPC caller with no identity at all', () => {
    expect(resolveOutboundSender({ source: 'rpc', principal: 'local' })).toEqual({
      reason: OUTBOUND_SENDER_REJECTION,
    });
  });

  test('rejects a Space role with no session to route replies to', () => {
    expect(
      resolveOutboundSender({ source: 'mcp', role: 'workflow_worker', agentName: 'coder' })
    ).toEqual({ reason: OUTBOUND_SENDER_REJECTION });
  });
});
