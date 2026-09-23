import { describe, expect, test } from 'bun:test';
import { type FindTarget, type SessionTarget } from '../../../../src/lib/session-resolution/target';
import {
  longTermAgentSessionId,
  resolveAgentSessionId,
} from '../../../../src/lib/space/long-term-agent-session';

describe('session-resolution type assignment tests', () => {
  test('new types accept their literal shapes', () => {
    const sessionTarget: SessionTarget = { kind: 'session', sessionId: 's' };
    const agentTarget: SessionTarget = { kind: 'agent', spaceId: 'sp', agentId: 'ag' };
    const workerTarget: SessionTarget = { kind: 'worker', taskId: 't', agentName: 'a' };
    const findTarget: FindTarget = { kind: 'agent', spaceId: 'sp', agentId: 'ag' };

    expect([sessionTarget, agentTarget, workerTarget, findTarget]).toHaveLength(4);
  });
});

describe('resolveAgentSessionId', () => {
  test('reads the session the agent record stores', () => {
    const agents = { getById: () => ({ id: 'agent-1', spaceId: 'space-1', sessionId: 'stored' }) };
    expect(resolveAgentSessionId(agents, 'space-1', 'agent-1')).toBe('stored');
  });

  test('falls back to the derived id for an agent with no stored session', () => {
    const agents = { getById: () => ({ id: 'agent-1', spaceId: 'space-1', sessionId: null }) };
    expect(resolveAgentSessionId(agents, 'space-1', 'agent-1')).toBe(
      longTermAgentSessionId('space-1', 'agent-1')
    );
  });

  test('ignores an agent record from another Space', () => {
    const agents = { getById: () => ({ id: 'agent-1', spaceId: 'other', sessionId: 'stored' }) };
    expect(resolveAgentSessionId(agents, 'space-1', 'agent-1')).toBe(
      longTermAgentSessionId('space-1', 'agent-1')
    );
  });
});
