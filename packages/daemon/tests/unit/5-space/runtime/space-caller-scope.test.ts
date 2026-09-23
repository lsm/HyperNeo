import { describe, expect, test } from 'bun:test';
import type { NodeExecution, Session, SpaceLongHorizonAgent } from '@hyperneo/shared';
import { longTermAgentSessionId } from '../../helpers/legacy-agent-session-id';
import {
  createSpaceCallerScopeResolver,
  resolveSessionSpaceId,
  type SpaceCallerScopeDependencies,
} from '../../../../src/lib/space/runtime/space-caller-scope';

function session(
  id: string,
  type: string,
  context: Record<string, unknown> = {},
  promptProvenance?: Record<string, unknown>
): Session {
  return {
    id,
    type,
    context,
    metadata: promptProvenance ? { promptProvenance } : {},
  } as unknown as Session;
}

const workerExecution = {
  id: 'exec-1',
  agentName: 'coder',
  agentId: 'agent-coder',
  agentSessionId: 'worker-1',
} as unknown as NodeExecution;

const planner = {
  id: 'agent-7',
  spaceId: 'space-3',
  handle: 'planner',
  status: 'active',
} as unknown as SpaceLongHorizonAgent;

const PLANNER_SESSION_ID = longTermAgentSessionId('space-3', 'agent-7');

const sessions: Record<string, Session> = {
  'space:chat:space-9': session('space:chat:space-9', 'space_chat', { spaceId: 'space-9' }),
  'worker-1': session('worker-1', 'worker', { spaceId: 'space-2', taskId: 'task-2' }),
  [PLANNER_SESSION_ID]: session(
    PLANNER_SESSION_ID,
    'worker',
    { spaceId: 'space-3' },
    { source: 'agent', hash: 'h', agentId: 'agent-7', agentName: 'stale-name' }
  ),
  'direct-1': session('direct-1', 'worker', {}),
  'member-1': session(
    'member-1',
    'worker',
    { spaceId: 'space-5' },
    { source: 'custom', hash: 'h', agentId: 'agent-5', agentName: 'reviewer' }
  ),
};

function deps(): SpaceCallerScopeDependencies {
  return {
    getSession: (sessionId) => sessions[sessionId] ?? null,
    nodeExecutionRepo: {
      getByAgentSessionId: (sessionId) => (sessionId === 'worker-1' ? workerExecution : null),
      getById: () => null,
    },
    longHorizonAgentRepo: { getById: (id) => (id === 'agent-7' ? planner : null) },
    resolveDirectWorker: (sessionId) =>
      sessionId === 'direct-1'
        ? ({ sessionId, spaceId: 'space-4', role: 'direct_task_worker' } as never)
        : null,
  };
}

describe('createSpaceCallerScopeResolver', () => {
  const resolve = createSpaceCallerScopeResolver(deps());

  test('unknown sessions resolve to no scope', () => {
    expect(resolve('missing')).toBeNull();
  });

  test('space chat sessions are ad hoc members of their space', () => {
    expect(resolve('space:chat:space-9')).toEqual({ role: 'ad_hoc_member', spaceId: 'space-9' });
  });

  test('workflow workers carry their execution identity', () => {
    expect(resolve('worker-1')).toEqual({
      role: 'workflow_worker',
      spaceId: 'space-2',
      agentId: 'agent-coder',
      agentName: 'coder',
    });
  });

  test('long-term agents carry the live handle over stale provenance', () => {
    expect(resolve(PLANNER_SESSION_ID)).toEqual({
      role: 'long_term_agent',
      spaceId: 'space-3',
      agentId: 'agent-7',
      agentName: 'planner',
    });
  });

  test('direct task workers carry their space and no agent identity', () => {
    expect(resolve('direct-1')).toEqual({ role: 'direct_task_worker', spaceId: 'space-4' });
  });

  test('members fall back to prompt provenance for agent identity', () => {
    expect(resolve('member-1')).toEqual({
      role: 'ad_hoc_member',
      spaceId: 'space-5',
      agentId: 'agent-5',
      agentName: 'reviewer',
    });
  });
});

describe('resolveSessionSpaceId', () => {
  test('falls back to the chat session id when the policy has no space', () => {
    const chat = session('space:chat:space-8', 'space_chat');
    expect(resolveSessionSpaceId(chat, deps())).toBe('space-8');
    expect(resolveSessionSpaceId(null, deps())).toBeUndefined();
  });
});
