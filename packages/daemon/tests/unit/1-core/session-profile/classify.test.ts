import { describe, expect, test } from 'bun:test';
import {
  classifySession,
  hasCapability,
  requiredMcpServersFor,
  type SessionFacts,
} from '../../../../src/lib/session-profile/classify.ts';

function facts(overrides: Partial<SessionFacts> = {}): SessionFacts {
  return { sessionId: 'session-1', sessionType: 'worker', ...overrides };
}

describe('classifySession', () => {
  test('classifies a session without a space as chat.default', () => {
    const profile = classifySession(facts());

    expect(profile).toEqual({
      kind: 'chat.default',
      sessionId: 'session-1',
      spaceId: undefined,
      taskId: undefined,
      agentId: undefined,
      capabilities: ['mcp.space-actions'],
    });
  });

  test('classifies the space console session as space.chat', () => {
    const profile = classifySession(
      facts({ sessionId: 'space:chat:space-1', sessionType: 'space_chat', spaceId: 'space-1' })
    );

    expect(profile.kind).toBe('space.chat');
    expect(profile.spaceId).toBe('space-1');
  });

  test('does not treat a space_chat session without a space as the console kind', () => {
    expect(classifySession(facts({ sessionType: 'space_chat' })).kind).toBe('chat.default');
  });

  test('classifies a workflow worker by execution ownership', () => {
    const profile = classifySession(
      facts({ spaceId: 'space-1', taskId: 'task-1', isWorkflowWorker: true })
    );

    expect(profile.kind).toBe('space.task.worker');
    expect(profile.taskId).toBe('task-1');
  });

  test('resolves the workflow worker space from the owning task', () => {
    const profile = classifySession(
      facts({
        sessionId: 'opaque',
        taskId: 'task-1',
        taskSpaceId: 'space-from-task',
        isWorkflowWorker: true,
      })
    );

    expect(profile.kind).toBe('space.task.worker');
    expect(profile.spaceId).toBe('space-from-task');
  });

  test('classifies a canonical agent session as space.agent and binds the agent', () => {
    const profile = classifySession(
      facts({ spaceId: 'space-1', agentId: 'agent-1', isCanonicalAgentSession: true })
    );

    expect(profile.kind).toBe('space.agent');
    expect(profile.agentId).toBe('agent-1');
  });

  test('keeps a claimed agent that is not the canonical session out of space.agent', () => {
    const profile = classifySession(facts({ spaceId: 'space-1', agentId: 'agent-1' }));

    expect(profile.kind).toBe('space.member');
    expect(profile.agentId).toBeUndefined();
  });

  test('classifies post-approval sub-sessions by their session id', () => {
    const profile = classifySession(
      facts({ sessionId: 'space:space-1:task:task-1:post-approval:merger', spaceId: 'space-1' })
    );

    expect(profile.kind).toBe('space.task.postApproval');
  });

  test('classifies any other space-scoped session as space.member', () => {
    expect(classifySession(facts({ spaceId: 'space-1' })).kind).toBe('space.member');
  });

  test('classifies legacy space task agents before every other rule', () => {
    const profile = classifySession(
      facts({
        sessionType: 'space_task_agent',
        spaceId: 'space-1',
        isWorkflowWorker: true,
        isCanonicalAgentSession: true,
        agentId: 'agent-1',
      })
    );

    expect(profile.kind).toBe('space.task.legacy');
    expect(profile.capabilities).toEqual([]);
  });
});

describe('session capabilities', () => {
  test('derives the required MCP servers per kind', () => {
    expect(requiredMcpServersFor('space.chat')).toEqual(['space-agent-tools']);
    expect(requiredMcpServersFor('space.agent')).toEqual(['space-agent-tools']);
    expect(requiredMcpServersFor('space.member')).toEqual(['space-agent-tools']);
    expect(requiredMcpServersFor('space.task.postApproval')).toEqual(['space-agent-tools']);
    expect(requiredMcpServersFor('space.task.worker')).toEqual(['node-agent']);
    expect(requiredMcpServersFor('chat.default')).toEqual(['space-actions']);
    expect(requiredMcpServersFor('space.task.legacy')).toEqual([]);
  });

  test('declares the capability row per kind', () => {
    const console = classifySession(
      facts({ sessionType: 'space_chat', spaceId: 'space-1', sessionId: 'space:chat:space-1' })
    );
    const member = classifySession(facts({ spaceId: 'space-1' }));
    const agent = classifySession(
      facts({ spaceId: 'space-1', agentId: 'agent-1', isCanonicalAgentSession: true })
    );
    const worker = classifySession(facts({ spaceId: 'space-1', isWorkflowWorker: true }));
    const legacy = classifySession(facts({ sessionType: 'space_task_agent', spaceId: 'space-1' }));

    expect(console.capabilities).toEqual(['mcp.space-agent-tools', 'surface.console']);
    expect(member.capabilities).toEqual(['mcp.space-agent-tools', 'surface.member']);
    expect(agent.capabilities).toEqual(['mcp.space-agent-tools', 'surface.longHorizonAgent']);
    expect(worker.capabilities).toEqual(['mcp.node-agent', 'surface.workflowNode']);
    expect(legacy.capabilities).toEqual([]);
  });

  test('reports held capabilities on a profile', () => {
    expect(hasCapability(classifySession(facts({ spaceId: 'space-1' })), 'surface.member')).toBe(
      true
    );
    expect(hasCapability(classifySession(facts({ spaceId: 'space-1' })), 'surface.console')).toBe(
      false
    );
  });
});
