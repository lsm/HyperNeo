import { describe, test, expect } from 'bun:test';
import type { WorkflowNode } from '@hyperneo/shared';
import type { NodeExecution, SpaceWorkflow } from '@hyperneo/shared';
import {
  findMissingNodeAgentReferences,
  findMissingSlotTemplateReference,
  formatEmptyTemplateInstructionsReference,
  formatMissingAgentReference,
  formatMissingNodeAgentReference,
  formatMissingTemplateReference,
  isMissingWorkflowAgentError,
  MissingWorkflowAgentError,
  PermanentSpawnError,
  slotTemplateAuditSources,
  validateExecutionAgainstWorkflow,
} from '../../../../src/lib/space/runtime/workflow-node-execution-validation.ts';

function makeNode(
  agents: Array<{
    agentId?: string | null;
    templateKey?: string;
    name: string;
    customPrompt?: { value: string };
    replaceAgentPrompt?: boolean;
    systemPrompt?: { value: string };
  }>
): WorkflowNode {
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

describe('validateExecutionAgainstWorkflow', () => {
  function makeExecution(overrides: Partial<NodeExecution> = {}): NodeExecution {
    return {
      id: 'exec-1',
      taskId: 'task-1',
      workflowRunId: 'run-1',
      workflowNodeId: 'node-1',
      agentName: 'coder',
      agentId: '',
      status: 'pending',
      createdAt: 0,
      updatedAt: 0,
      ...overrides,
    } as NodeExecution;
  }

  function makeWorkflow(agents: WorkflowNode['agents']): SpaceWorkflow {
    return {
      id: 'wf-1',
      spaceId: 'space-1',
      name: 'Test',
      nodes: [{ id: 'node-1', name: 'Review', agents }],
      tags: [],
      createdAt: 0,
      updatedAt: 0,
    } as unknown as SpaceWorkflow;
  }

  test('is valid for a template-only slot', () => {
    const workflow = makeWorkflow([{ agentId: '', templateKey: 'coder.default', name: 'coder' }]);
    const result = validateExecutionAgainstWorkflow(makeExecution(), workflow);
    expect(result).toEqual({ valid: true });
  });

  test('is invalid when the slot has neither agentId nor templateKey', () => {
    const workflow = makeWorkflow([{ agentId: '', name: 'coder' }]);
    const result = validateExecutionAgainstWorkflow(makeExecution(), workflow);
    expect(result).toEqual({
      valid: false,
      reason: 'Agent slot coder no longer exists on workflow node node-1',
      permanent: true,
    });
  });

  test('whitespace templateKey falls back to agentId', () => {
    const workflow = makeWorkflow([{ agentId: 'agent-1', templateKey: '   ', name: 'coder' }]);
    const result = validateExecutionAgainstWorkflow(
      makeExecution({ agentId: 'agent-1' }),
      workflow
    );
    expect(result).toEqual({ valid: true });
  });

  test('templateKey takes precedence over stale agentId', () => {
    const workflow = makeWorkflow([
      { agentId: 'stale', templateKey: 'coder.default', name: 'coder' },
    ]);
    const result = validateExecutionAgainstWorkflow(
      makeExecution({ agentId: 'template:coder.default' }),
      workflow
    );
    expect(result).toEqual({ valid: true });
  });

  test('accepts a legacy execution identity migrated to a collision-suffixed template', () => {
    const workflow = makeWorkflow([
      { agentId: '', templateKey: 'migrated.agent.agent-1.m228', name: 'coder' },
    ]);
    const result = validateExecutionAgainstWorkflow(
      makeExecution({ agentId: 'agent-1' }),
      workflow
    );
    expect(result).toEqual({ valid: true });
  });

  test('accepts a legacy execution identity migrated to its matching template', () => {
    const workflow = makeWorkflow([
      { agentId: '', templateKey: 'migrated.agent.agent-1', name: 'coder' },
    ]);
    const result = validateExecutionAgainstWorkflow(
      makeExecution({ agentId: 'agent-1' }),
      workflow
    );
    expect(result).toEqual({ valid: true });
  });

  test('rejects a legacy execution identity migrated to another agent template', () => {
    const workflow = makeWorkflow([
      { agentId: '', templateKey: 'migrated.agent.agent-2', name: 'coder' },
    ]);
    const result = validateExecutionAgainstWorkflow(
      makeExecution({ agentId: 'agent-1' }),
      workflow
    );
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.permanent).toBe(true);
  });

  test('rejects an unrelated template when execution carries a legacy identity', () => {
    const workflow = makeWorkflow([{ agentId: '', templateKey: 'coder.default', name: 'coder' }]);
    const result = validateExecutionAgainstWorkflow(
      makeExecution({ agentId: 'agent-1' }),
      workflow
    );
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.permanent).toBe(true);
  });
});

describe('findMissingNodeAgentReferences template precedence', () => {
  test('skips agent-existence check when templateKey is present', () => {
    const node = makeNode([{ agentId: 'missing', templateKey: 'coder.default', name: 'coder' }]);
    expect(findMissingNodeAgentReferences(node, () => false)).toEqual([]);
  });

  test('still reports a missing agent when no templateKey is present', () => {
    const node = makeNode([{ agentId: 'missing', name: 'coder' }]);
    expect(findMissingNodeAgentReferences(node, () => false)).toEqual([
      { agentName: 'coder', agentId: 'missing' },
    ]);
  });

  test('skips check for whitespace-only templateKey', () => {
    const node = makeNode([{ agentId: 'missing', templateKey: '   ', name: 'coder' }]);
    expect(findMissingNodeAgentReferences(node, () => false)).toEqual([
      { agentName: 'coder', agentId: 'missing' },
    ]);
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

describe('findMissingNodeAgentReferences template drift', () => {
  test('reports a templateKey that resolves to nothing when templateResolves is provided', () => {
    const node = makeNode([{ agentId: '', templateKey: 'ghost.preview', name: 'ghost' }]);
    expect(
      findMissingNodeAgentReferences(node, () => true, { templateResolves: () => false })
    ).toEqual([
      {
        agentName: 'ghost',
        agentId: '',
        templateKey: 'ghost.preview',
        templateReason: 'unknown-template',
      },
    ]);
  });

  test('skips a templateKey that resolves', () => {
    const node = makeNode([{ agentId: '', templateKey: 'worker.swe', name: 'coder' }]);
    expect(
      findMissingNodeAgentReferences(node, () => false, { templateResolves: () => true })
    ).toEqual([]);
  });

  test('keeps skipping templateKey slots entirely when no templateResolves predicate is given', () => {
    const node = makeNode([{ agentId: 'gone', templateKey: 'ghost.preview', name: 'ghost' }]);
    expect(findMissingNodeAgentReferences(node, () => false)).toEqual([]);
  });

  test('falls back to a live agentId when the templateKey does not resolve', () => {
    const node = makeNode([{ agentId: 'live', templateKey: 'ghost.preview', name: 'ghost' }]);
    expect(
      findMissingNodeAgentReferences(node, (id) => id === 'live', {
        templateResolves: () => false,
      })
    ).toEqual([]);
  });

  test('reports when neither the templateKey resolves nor the agentId exists', () => {
    const node = makeNode([{ agentId: 'gone', templateKey: 'ghost.preview', name: 'ghost' }]);
    expect(
      findMissingNodeAgentReferences(node, (id) => id !== 'gone', {
        templateResolves: () => false,
      })
    ).toEqual([
      {
        agentName: 'ghost',
        agentId: 'gone',
        templateKey: 'ghost.preview',
        templateReason: 'unknown-template',
      },
    ]);
  });

  test('honors slotNames alongside template drift', () => {
    const node = makeNode([
      { agentId: '', templateKey: 'ghost.preview', name: 'ghost' },
      { agentId: 'present', name: 'reviewer' },
    ]);
    expect(
      findMissingNodeAgentReferences(node, () => true, {
        slotNames: new Set(['reviewer']),
        templateResolves: () => false,
      })
    ).toEqual([]);
  });
});

describe('findMissingNodeAgentReferences empty-instruction audit', () => {
  test('flags a templateKey that resolves to a template with empty instructions', () => {
    const node = makeNode([{ agentId: '', templateKey: 'migrated.agent.gone', name: 'orphan' }]);
    expect(
      findMissingNodeAgentReferences(node, () => true, {
        templateResolves: () => true,
        templateInstructions: () => '',
      })
    ).toEqual([
      {
        agentName: 'orphan',
        agentId: '',
        templateKey: 'migrated.agent.gone',
        templateReason: 'empty-instructions',
      },
    ]);
  });

  test('flags whitespace-only instructions as empty', () => {
    const node = makeNode([{ agentId: '', templateKey: 'blank.role', name: 'blank' }]);
    expect(
      findMissingNodeAgentReferences(node, () => true, {
        templateResolves: () => true,
        templateInstructions: () => '   ',
      })
    ).toEqual([
      {
        agentName: 'blank',
        agentId: '',
        templateKey: 'blank.role',
        templateReason: 'empty-instructions',
      },
    ]);
  });

  test('skips a templateKey whose instructions are non-empty', () => {
    const node = makeNode([{ agentId: '', templateKey: 'worker.swe', name: 'coder' }]);
    expect(
      findMissingNodeAgentReferences(node, () => false, {
        templateResolves: () => true,
        templateInstructions: () => 'You are the SWE worker.',
      })
    ).toEqual([]);
  });

  test('does not rescue an empty-instruction template via a live agentId (the template wins at spawn)', () => {
    const node = makeNode([
      { agentId: 'live', templateKey: 'migrated.agent.gone', name: 'orphan' },
    ]);
    expect(
      findMissingNodeAgentReferences(node, () => true, {
        templateResolves: () => true,
        templateInstructions: () => '',
      })
    ).toEqual([
      {
        agentName: 'orphan',
        agentId: 'live',
        templateKey: 'migrated.agent.gone',
        templateReason: 'empty-instructions',
      },
    ]);
  });

  test('reports unknown-template (not empty-instructions) when templateInstructions resolves nothing', () => {
    const node = makeNode([{ agentId: '', templateKey: 'ghost.preview', name: 'ghost' }]);
    expect(
      findMissingNodeAgentReferences(node, () => true, {
        templateInstructions: () => null,
      })
    ).toEqual([
      {
        agentName: 'ghost',
        agentId: '',
        templateKey: 'ghost.preview',
        templateReason: 'unknown-template',
      },
    ]);
  });

  test('audits instructions with templateInstructions alone, no templateResolves predicate', () => {
    const node = makeNode([{ agentId: '', templateKey: 'migrated.agent.gone', name: 'orphan' }]);
    expect(
      findMissingNodeAgentReferences(node, () => true, {
        templateInstructions: (key) => (key === 'migrated.agent.gone' ? '' : null),
      })
    ).toEqual([
      {
        agentName: 'orphan',
        agentId: '',
        templateKey: 'migrated.agent.gone',
        templateReason: 'empty-instructions',
      },
    ]);
  });

  test('reports only the degraded slot among a mixed set', () => {
    const node = makeNode([
      { agentId: '', templateKey: 'worker.swe', name: 'coder' },
      { agentId: '', templateKey: 'migrated.agent.gone', name: 'orphan' },
    ]);
    expect(
      findMissingNodeAgentReferences(node, () => true, {
        templateResolves: () => true,
        templateInstructions: (key) => (key === 'worker.swe' ? 'You are the SWE worker.' : ''),
      })
    ).toEqual([
      {
        agentName: 'orphan',
        agentId: '',
        templateKey: 'migrated.agent.gone',
        templateReason: 'empty-instructions',
      },
    ]);
  });

  test('keeps a slot whose customPrompt supplies the effective prompt in append mode', () => {
    const node = makeNode([
      {
        agentId: '',
        templateKey: 'migrated.agent.gone',
        name: 'orphan',
        customPrompt: { value: 'You handle orphaned review work.' },
      },
    ]);
    expect(
      findMissingNodeAgentReferences(node, () => true, {
        templateResolves: () => true,
        templateInstructions: () => '',
      })
    ).toEqual([]);
  });

  test('keeps a replace-mode slot regardless of template instructions', () => {
    const node = makeNode([
      {
        agentId: '',
        templateKey: 'migrated.agent.gone',
        name: 'orphan',
        replaceAgentPrompt: true,
      },
    ]);
    expect(
      findMissingNodeAgentReferences(node, () => true, {
        templateResolves: () => true,
        templateInstructions: () => '',
      })
    ).toEqual([]);
  });

  test('keeps a slot whose legacy systemPrompt override supplies the effective prompt', () => {
    const node = makeNode([
      {
        agentId: '',
        templateKey: 'migrated.agent.gone',
        name: 'orphan',
        systemPrompt: { value: 'Legacy slot instructions.' },
      },
    ]);
    expect(
      findMissingNodeAgentReferences(node, () => true, {
        templateResolves: () => true,
        templateInstructions: () => '',
      })
    ).toEqual([]);
  });

  test('flags a slot whose customPrompt is whitespace-only alongside empty instructions', () => {
    const node = makeNode([
      {
        agentId: '',
        templateKey: 'migrated.agent.gone',
        name: 'orphan',
        customPrompt: { value: '   ' },
      },
    ]);
    expect(
      findMissingNodeAgentReferences(node, () => true, {
        templateResolves: () => true,
        templateInstructions: () => '',
      })
    ).toEqual([
      {
        agentName: 'orphan',
        agentId: '',
        templateKey: 'migrated.agent.gone',
        templateReason: 'empty-instructions',
      },
    ]);
  });
});

describe('formatMissingNodeAgentReference', () => {
  test('formats the empty-instructions arm for a degraded template binding', () => {
    const message = formatMissingNodeAgentReference({
      reference: {
        agentName: 'orphan',
        agentId: '',
        templateKey: 'migrated.agent.agent-9',
        templateReason: 'empty-instructions',
      },
      runId: 'run-777',
      nodeLabel: 'Gate',
      workflowName: 'Migrated Flow',
    });
    expect(message).toContain('empty instructions');
    expect(message).toContain('migrated.agent.agent-9');
    expect(message).toContain('run-777');
  });

  test('formats the unknown-template arm for an unresolvable key', () => {
    const message = formatMissingNodeAgentReference({
      reference: {
        agentName: 'ghost',
        agentId: '',
        templateKey: 'ghost.preview',
        templateReason: 'unknown-template',
      },
      runId: 'run-778',
      nodeLabel: 'Gate',
      workflowName: 'Drift Flow',
    });
    expect(message).toContain('resolves to neither a code built-in nor a user template');
    expect(message).toContain('ghost.preview');
  });

  test('formats the missing-agent arm for a stale agent id', () => {
    const message = formatMissingNodeAgentReference({
      reference: { agentName: 'reviewer', agentId: 'gone' },
      runId: 'run-779',
      nodeLabel: 'Gate',
      workflowName: 'Agent Flow',
    });
    expect(message).toContain('no longer exists in this Space');
    expect(message).toContain('gone');
  });
});

describe('formatMissingTemplateReference', () => {
  test('names the template key, workflow, run, node, and slot', () => {
    const message = formatMissingTemplateReference({
      runId: 'run-321',
      nodeLabel: 'Preview',
      workflowName: 'Release Flow',
      agentName: 'reviewer',
      templateKey: 'ghost.preview',
    });
    expect(message).toContain('ghost.preview');
    expect(message).toContain('Release Flow');
    expect(message).toContain('run-321');
    expect(message).toContain('Preview');
    expect(message).toContain('reviewer');
  });
});

describe('formatEmptyTemplateInstructionsReference', () => {
  test('names the template key, workflow, run, node, slot, and the empty-instructions cause', () => {
    const message = formatEmptyTemplateInstructionsReference({
      runId: 'run-655',
      nodeLabel: 'Orphan Gate',
      workflowName: 'Migrated Flow',
      agentName: 'reviewer',
      templateKey: 'migrated.agent.agent-9',
    });
    expect(message).toContain('migrated.agent.agent-9');
    expect(message).toContain('Migrated Flow');
    expect(message).toContain('run-655');
    expect(message).toContain('Orphan Gate');
    expect(message).toContain('reviewer');
    expect(message).toContain('empty instructions');
  });
});

describe('findMissingSlotTemplateReference spawn-boundary audit', () => {
  const sources = {
    templateResolves: (key: string) => key === 'worker.swe',
    templateInstructions: (key: string) => (key === 'worker.swe' ? 'You are the SWE worker.' : ''),
  };

  test('flags the named slot bound to an empty-instruction template', () => {
    const node = makeNode([{ agentId: '', templateKey: 'migrated.agent.gone', name: 'orphan' }]);
    expect(findMissingSlotTemplateReference(node, 'orphan', sources)?.templateReason).toBe(
      'empty-instructions'
    );
  });

  test('slotTemplateAuditSources prefers the pinned snapshot over the live template', () => {
    const repo = {
      getByKey: (key: string) =>
        key === 'worker.pinned' ? { key, instructions: 'Repaired live instructions.' } : null,
    };
    const snapshots = {
      'worker.pinned': {
        key: 'worker.pinned',
        handle: 'pinned',
        displayName: 'Pinned',
        description: '',
        instructions: '',
      },
    };
    expect(slotTemplateAuditSources(repo, snapshots).templateInstructions('worker.pinned')).toBe(
      ''
    );
    expect(slotTemplateAuditSources(repo).templateInstructions('worker.pinned')).toBe(
      'Repaired live instructions.'
    );
  });

  test('slotTemplateAuditSources falls back to live resolution for keys absent from snapshots', () => {
    const repo = {
      getByKey: (key: string) =>
        key === 'worker.live' ? { key, instructions: 'Live instructions.' } : null,
    };
    const liveFallback = slotTemplateAuditSources(repo, {});
    expect(liveFallback.templateInstructions('worker.live')).toBe('Live instructions.');
    expect(liveFallback.templateInstructions('ghost.preview')).toBeNull();
  });

  test('returns null for a healthy target slot', () => {
    const node = makeNode([{ agentId: '', templateKey: 'worker.swe', name: 'coder' }]);
    expect(findMissingSlotTemplateReference(node, 'coder', sources)).toBeNull();
  });

  test('ignores sibling slots outside the audit target', () => {
    const node = makeNode([
      { agentId: '', templateKey: 'worker.swe', name: 'coder' },
      { agentId: '', templateKey: 'migrated.agent.gone', name: 'orphan' },
    ]);
    expect(findMissingSlotTemplateReference(node, 'coder', sources)).toBeNull();
  });

  test('never flags agentId-only slots at the spawn boundary', () => {
    const node = makeNode([{ agentId: 'legacy-agent', name: 'reviewer' }]);
    expect(findMissingSlotTemplateReference(node, 'reviewer', sources)).toBeNull();
  });

  test('honors the slot customPrompt exemption', () => {
    const node = makeNode([
      {
        agentId: '',
        templateKey: 'migrated.agent.gone',
        name: 'orphan',
        customPrompt: { value: 'Slot-level role instructions.' },
      },
    ]);
    expect(findMissingSlotTemplateReference(node, 'orphan', sources)).toBeNull();
  });

  test('returns null when the node has no agents', () => {
    const node = { id: 'node-1', name: 'Empty' } as WorkflowNode;
    expect(findMissingSlotTemplateReference(node, 'orphan', sources)).toBeNull();
  });
});
