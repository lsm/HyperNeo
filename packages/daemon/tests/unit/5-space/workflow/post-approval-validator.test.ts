import { describe, expect, test } from 'bun:test';
import type { PostApprovalRoute, WorkflowNode } from '@hyperneo/shared';
import {
  POST_APPROVAL_TASK_AGENT_TARGET,
  collectEligiblePostApprovalTargets,
  validatePostApproval,
  validatePostApprovalRoutes,
} from '../../../../src/lib/space/workflows/post-approval-validator.ts';

const node = (
  id: string,
  name: string,
  agents: Array<{ agentId: string; name: string }>
): WorkflowNode => ({ id, name, agents });

const CODING_NODES: WorkflowNode[] = [
  node('n1', 'Coding', [{ agentId: 'a1', name: 'coder' }]),
  node('n2', 'Review', [{ agentId: 'a2', name: 'reviewer' }]),
];

describe('collectEligiblePostApprovalTargets', () => {
  test('returns empty array when no nodes provided', () => {
    expect(collectEligiblePostApprovalTargets([])).toEqual([POST_APPROVAL_TASK_AGENT_TARGET]);
  });

  test('appends each node-agent name in document order, without duplicates', () => {
    const duplicate: WorkflowNode[] = [
      node('n1', 'A', [
        { agentId: 'a1', name: 'coder' },
        { agentId: 'a2', name: 'coder' },
      ]),
      node('n2', 'B', [{ agentId: 'a3', name: 'reviewer' }]),
    ];
    expect(collectEligiblePostApprovalTargets(duplicate)).toEqual([
      'task-agent',
      'coder',
      'reviewer',
    ]);
  });
});

describe('validatePostApproval', () => {
  test('missing postApproval is valid (optional field)', () => {
    expect(validatePostApproval({ nodes: CODING_NODES })).toEqual({ ok: true });
  });

  test('declared node-agent name is valid', () => {
    const route: PostApprovalRoute = {
      targetAgent: 'reviewer',
      instructions: 'post final review on {{pr_url}}',
    };
    expect(validatePostApproval({ postApproval: route, nodes: CODING_NODES })).toEqual({
      ok: true,
    });
  });

  test('"task-agent" is valid for backward compatibility', () => {
    const route: PostApprovalRoute = {
      targetAgent: 'task-agent',
      instructions: 'merge {{pr_url}}',
    };
    const result = validatePostApproval({ postApproval: route, nodes: CODING_NODES });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
  });

  test('unknown target is invalid; error lists every eligible target', () => {
    const route: PostApprovalRoute = {
      targetAgent: 'ghost-agent',
      instructions: '',
    };
    const result = validatePostApproval({ postApproval: route, nodes: CODING_NODES });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.eligibleTargets).toEqual(['task-agent', 'coder', 'reviewer']);
    expect(result.error).toContain('"ghost-agent"');
    for (const target of ['task-agent', 'coder', 'reviewer']) {
      expect(result.error).toContain(`"${target}"`);
    }
  });

  test('empty/whitespace targetAgent is invalid', () => {
    const route: PostApprovalRoute = { targetAgent: '   ', instructions: '' };
    const result = validatePostApproval({ postApproval: route, nodes: CODING_NODES });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('non-empty');
  });

  test('target agent name is trimmed before comparison', () => {
    const route: PostApprovalRoute = { targetAgent: '  coder  ', instructions: '' };
    const result = validatePostApproval({ postApproval: route, nodes: CODING_NODES });
    expect(result).toEqual({ ok: true });
  });
});

describe('validatePostApprovalRoutes', () => {
  test('validates node-level routes', () => {
    const result = validatePostApprovalRoutes({
      nodes: [
        {
          ...CODING_NODES[0],
          postApproval: {
            targetAgent: 'reviewer',
            instructions: 'Merge {{pr_url}}',
          },
        },
        CODING_NODES[1],
      ],
    });
    expect(result).toEqual({ ok: true });
  });

  test('reports the node name when a node-level route target is stale', () => {
    const result = validatePostApprovalRoutes({
      nodes: [
        {
          ...CODING_NODES[0],
          postApproval: {
            targetAgent: 'ghost-agent',
            instructions: '',
          },
        },
        CODING_NODES[1],
      ],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('node "Coding"');
    expect(result.error).toContain('"ghost-agent"');
  });
});
