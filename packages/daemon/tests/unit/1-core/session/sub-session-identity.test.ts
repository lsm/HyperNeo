import { describe, expect, it } from 'bun:test';
import {
  buildExecutionBaseSessionId,
  buildPostApprovalSessionId,
  hasRuntimeNodeAgentServer,
  isWorkflowSubSessionIdentity,
  taskIdFromSubSessionIdentity,
} from '../../../../src/lib/session/sub-session-identity';

describe('sub-session identity', () => {
  it('builds and parses execution identities symmetrically', () => {
    const sessionId = buildExecutionBaseSessionId('space-1', 'task-2', 'exec-3');

    expect(sessionId).toBe('space:space-1:task:task-2:exec:exec-3');
    expect(taskIdFromSubSessionIdentity(sessionId)).toBe('task-2');
    expect(taskIdFromSubSessionIdentity(sessionId, 'space')).toBe('space-1');
  });

  it('builds and parses post-approval identities symmetrically', () => {
    const sessionId = buildPostApprovalSessionId('space-1', 'task-2', 'coder');

    expect(sessionId).toBe('space:space-1:task:task-2:post-approval:coder');
    expect(taskIdFromSubSessionIdentity(sessionId)).toBe('task-2');
  });

  it('recognizes workflow sub-session identities only', () => {
    expect(isWorkflowSubSessionIdentity('space:s:task:t:exec:e')).toBe(true);
    expect(isWorkflowSubSessionIdentity('space:s:task:t:post-approval:coder')).toBe(true);
    expect(isWorkflowSubSessionIdentity('space:s:task:t')).toBe(false);
    expect(isWorkflowSubSessionIdentity('chat:room-1')).toBe(false);
  });
});

describe('hasRuntimeNodeAgentServer', () => {
  it('accepts the runtime SDK node-agent server', () => {
    expect(hasRuntimeNodeAgentServer({ mcpServers: { 'node-agent': { type: 'sdk' } } })).toBe(true);
  });

  it('rejects a user-configured server named node-agent', () => {
    expect(
      hasRuntimeNodeAgentServer({
        mcpServers: { 'node-agent': { type: 'stdio', command: 'npx' } },
      })
    ).toBe(false);
    expect(hasRuntimeNodeAgentServer({ mcpServers: {} })).toBe(false);
    expect(hasRuntimeNodeAgentServer(undefined)).toBe(false);
  });
});
