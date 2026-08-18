import { describe, test, expect } from 'bun:test';
import type { WorkflowNode } from '@hyperneo/shared';
import {
  findMissingNodeAgentReferences,
  formatMissingAgentReference,
  isMissingWorkflowAgentError,
  MissingWorkflowAgentError,
  PermanentSpawnError,
} from '../../../../src/lib/space/runtime/workflow-node-execution-validation.ts';

function makeNode(agents: Array<{ agentId?: string | null; name: string }>): WorkflowNode {
  return {
    id: 'node-1',
    name: 'Review',
    agents: agents as WorkflowNode['agents'],
  } as WorkflowNode;
}

describe('findMissingNodeAgentReferences', () => {
  test('returns [] when every configured agent exists', () => {
    const node = makeNode([{ agentId: 'a1', name: 'coder' }]);
    expect(findMissingNodeAgentReferences(node, () => true)).toEqual([]);
  });

  test('reports a configured custom agent that no longer exists', () => {
    const node = makeNode([{ agentId: 'gone', name: 'reviewer' }]);
    expect(findMissingNodeAgentReferences(node, (id) => id !== 'gone')).toEqual([
      { agentName: 'reviewer', agentId: 'gone' },
    ]);
  });

  test('reports only the missing slot among a mixed set', () => {
    const node = makeNode([
      { agentId: 'present', name: 'coder' },
      { agentId: 'gone', name: 'reviewer' },
    ]);
    expect(findMissingNodeAgentReferences(node, (id) => id !== 'gone')).toEqual([
      { agentName: 'reviewer', agentId: 'gone' },
    ]);
  });

  test('preserves built-in/worker slots with no agent id (null/empty)', () => {
    const node = makeNode([
      { agentId: null, name: 'worker-null' },
      { agentId: '', name: 'worker-empty' },
      { agentId: undefined, name: 'worker-undefined' },
    ]);
    expect(findMissingNodeAgentReferences(node, () => false)).toEqual([]);
  });
});

describe('MissingWorkflowAgentError', () => {
  test('is a PermanentSpawnError (terminal — no retry storm)', () => {
    const err = new MissingWorkflowAgentError('boom', {
      agentName: 'reviewer',
      agentId: 'gone',
    });
    expect(err).toBeInstanceOf(PermanentSpawnError);
    expect(err.permanent).toBe(true);
    expect(err.reference).toEqual({ agentName: 'reviewer', agentId: 'gone' });
    expect(isMissingWorkflowAgentError(err)).toBe(true);
    expect(isMissingWorkflowAgentError(new PermanentSpawnError('other'))).toBe(false);
  });
});

describe('formatMissingAgentReference', () => {
  test('includes run id, target node, agent name, and stale agent id', () => {
    const message = formatMissingAgentReference({
      runId: 'run-123',
      nodeLabel: 'Review',
      agentName: 'reviewer',
      agentId: 'gone',
    });
    expect(message).toContain('run-123');
    expect(message).toContain('Review');
    expect(message).toContain('reviewer');
    expect(message).toContain('gone');
    expect(message).not.toMatch(/FOREIGN KEY/i);
  });
});
