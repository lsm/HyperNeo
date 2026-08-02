import { describe, test, expect } from 'bun:test';
import type { WorkflowHook, WorkflowNodeInput } from '@hyperneo/shared';
import { validateWorkflowHooks } from '../../../../src/lib/space/workflow-hook-validation.ts';
import { WorkflowHookRuntimeService } from '../../../../src/lib/space/workflow-hook-runtime-service.ts';

const runtimeService = new WorkflowHookRuntimeService();

const nodes: WorkflowNodeInput[] = [
  { id: 'n1', name: 'Coding', agents: [{ agentId: 'a1', name: 'coder' }] },
  { id: 'n2', name: 'Review', agents: [{ agentId: 'a2', name: 'reviewer' }] },
];

const nodesWithRoute: WorkflowNodeInput[] = [
  { id: 'n1', name: 'Coding', agents: [{ agentId: 'a1', name: 'coder' }] },
  {
    id: 'n2',
    name: 'Review',
    agents: [{ agentId: 'a2', name: 'reviewer' }],
    postApproval: { targetAgent: 'reviewer', instructions: 'Merge the PR.' },
  },
];

function validHook(overrides: Partial<WorkflowHook> = {}): WorkflowHook {
  return {
    id: 'hook-1',
    enabled: true,
    sourceNode: 'Coding',
    targetNode: 'Review',
    method: 'send_message',
    validator: { kind: 'script', interpreter: 'bash', source: 'echo \'{"type":"allow"}\'' },
    authorizedCallers: [{ sourceNode: 'Coding', agentSlots: ['coder'] }],
    ...overrides,
  };
}

function prMergedHook(overrides: Partial<WorkflowHook> = {}): WorkflowHook {
  return validHook({
    id: 'pr-merged',
    method: 'mark_complete',
    sourceNode: 'Review',
    targetNode: undefined,
    validator: { kind: 'built_in', id: 'pr_merged' },
    authorizedCallers: [{ sourceNode: 'Review', agentSlots: ['reviewer'] }],
    ...overrides,
  });
}

describe('workflow hook validation', () => {
  test('accepts valid hook definitions', () => {
    expect(validateWorkflowHooks([validHook()], nodes)).toEqual([]);
  });

  test('rejects unknown MCP methods and invalid node references', () => {
    const errors = validateWorkflowHooks(
      [validHook({ method: 'unknown' as never, sourceNode: 'Missing', targetNode: 'Gone' })],
      nodes
    );
    expect(errors.join('\n')).toContain('unknown MCP method');
    expect(errors.join('\n')).toContain('unknown node "Missing"');
    expect(errors.join('\n')).toContain('unknown node "Gone"');
  });

  test('rejects gate-only fields and role terminology', () => {
    const hook = { ...validHook(), fields: [], roleName: 'writer' } as unknown;
    const errors = validateWorkflowHooks([hook], nodes).join('\n');
    expect(errors).toContain('gate-only field');
    expect(errors).toContain('role terminology is not allowed');
  });

  test('fails closed for absent callers', () => {
    expect(
      validateWorkflowHooks([validHook({ authorizedCallers: undefined })], nodes).join('\n')
    ).toContain('authorizedCallers');
  });

  test('rejects humanOnly hooks as not yet supported', () => {
    const errors = validateWorkflowHooks(
      [validHook({ humanOnly: true, authorizedCallers: undefined })],
      nodes
    ).join('\n');
    expect(errors).toContain('human-only hooks are not yet supported');
  });

  test('rejects disabled hooks during caller authorization', () => {
    const hook = validHook({ enabled: false });
    expect(
      runtimeService.isCallerAuthorized(hook, {
        kind: 'agent',
        sourceNode: 'Coding',
        agentSlot: 'coder',
      })
    ).toBe(false);
  });

  test('authorizes only declared node and agent slots', () => {
    const hook = validHook();
    expect(
      runtimeService.isCallerAuthorized(hook, {
        kind: 'agent',
        sourceNode: 'Coding',
        agentSlot: 'coder',
      })
    ).toBe(true);
    expect(
      runtimeService.isCallerAuthorized(hook, {
        kind: 'agent',
        sourceNode: 'Coding',
        agentSlot: 'reviewer',
      })
    ).toBe(false);
  });

  test('narrows script hooks to bash and GitHub-only external lookups', () => {
    const errors = validateWorkflowHooks(
      [
        validHook({
          validator: {
            kind: 'script',
            interpreter: 'python3' as never,
            source: 'print(1)',
            externalLookups: ['github', 'jira' as never],
          },
        }),
      ],
      nodes
    ).join('\n');
    expect(errors).toContain('expected "bash"');
    expect(errors).toContain('only "github" is allowed');
  });

  test('bounds hook result shapes', () => {
    expect(runtimeService.validateResult({ type: 'allow' })).toEqual([]);
    expect(runtimeService.validateResult({ type: 'allow', message: 123 }).join('\n')).toContain(
      'result.message: expected string'
    );
    expect(runtimeService.validateResult({ type: 'block' }).join('\n')).toContain('reason');
    expect(runtimeService.validateResult({ type: 'shell_out', command: 'x' }).join('\n')).toContain(
      'bounded hook result type'
    );
  });

  test('rejects unimplemented built-in validators', () => {
    const errors = validateWorkflowHooks(
      [validHook({ validator: { kind: 'built_in', id: 'pr_open' } })],
      nodes
    ).join('\n');
    expect(errors).toContain('unknown built-in validator');
  });

  test('pr_merged is only valid on mark_complete', () => {
    // A pr_merged gate on send_message would permanently block a normal
    // coder→reviewer handoff (the PR is necessarily still open at handoff).
    const errors = validateWorkflowHooks(
      [prMergedHook({ method: 'send_message', targetNode: 'Review' })],
      nodesWithRoute
    ).join('\n');
    expect(errors).toContain('pr_merged validator only applies to mark_complete');
  });

  test('pr_merged requires a reachable post-approval route', () => {
    // Without a route, PostApprovalRouter transitions approved→done directly and
    // mark_complete is never invoked, so the hook would silently never fire.
    const errors = validateWorkflowHooks([prMergedHook()], nodes).join('\n');
    expect(errors).toContain('requires a reachable post-approval route');
  });

  test('pr_merged accepts a node-level post-approval route on the end node', () => {
    expect(validateWorkflowHooks([prMergedHook()], nodesWithRoute, { endNodeId: 'n2' })).toEqual(
      []
    );
  });

  test('pr_merged accepts a workflow-level post-approval route', () => {
    const errors = validateWorkflowHooks([prMergedHook()], nodes, {
      workflowPostApproval: { targetAgent: 'reviewer', instructions: 'Merge the PR.' },
    });
    expect(errors).toEqual([]);
  });

  test('pr_merged route requirement ignores a disabled hook', () => {
    // A disabled pr_merged hook never fires, so it must not force a route.
    expect(validateWorkflowHooks([prMergedHook({ enabled: false })], nodes)).toEqual([]);
  });

  test('pr_merged rejects a route on an unrelated (non-source, non-end) node', () => {
    // resolvePostApprovalRoute only honors a node-level route on the completing
    // node (pendingCompletionSubmittedByNodeId || endNodeId) — never an arbitrary
    // node's. A route on Coding does not make a Review-declared pr_merged reachable.
    const routeOnCoding: WorkflowNodeInput[] = [
      {
        id: 'n1',
        name: 'Coding',
        agents: [{ agentId: 'a1', name: 'coder' }],
        postApproval: { targetAgent: 'reviewer', instructions: 'Merge the PR.' },
      },
      { id: 'n2', name: 'Review', agents: [{ agentId: 'a2', name: 'reviewer' }] },
    ];
    const errors = validateWorkflowHooks([prMergedHook({ sourceNode: 'Review' })], routeOnCoding, {
      endNodeId: 'n2',
    }).join('\n');
    expect(errors).toContain('requires a reachable post-approval route');
    expect(errors).toContain('"Review"');
  });

  test('pr_merged accepts a route on the workflow endNodeId', () => {
    // The router falls back to endNodeId when no pendingCompletionSubmittedByNodeId
    // is set, so a route there is reachable even if it is not the hook's sourceNode.
    const errors = validateWorkflowHooks([prMergedHook({ sourceNode: 'Coding' })], nodesWithRoute, {
      endNodeId: 'n2',
    });
    expect(errors).toEqual([]);
  });

  test('pr_merged must be classification validation, not side_effect', () => {
    // Only validation-classified blocks stop the action; a side_effect pr_merged
    // hook would return block yet let mark_complete proceed → done on an unmerged PR.
    const errors = validateWorkflowHooks(
      [prMergedHook({ classification: 'side_effect' })],
      nodesWithRoute,
      { endNodeId: 'n2' }
    ).join('\n');
    expect(errors).toContain('must be classification "validation"');
  });

  test('pr_merged must not declare a targetNode', () => {
    // resolveMatchingHooks skips any hook with a targetNode for non-send_message
    // methods, so a targetNode would silently prevent the gate from firing.
    const errors = validateWorkflowHooks([prMergedHook({ targetNode: 'Review' })], nodesWithRoute, {
      endNodeId: 'n2',
    }).join('\n');
    expect(errors).toContain('must not declare a targetNode');
  });

  test('pr_merged rejects a route on a non-end sourceNode', () => {
    // approve_task/submit_for_approval are end-node-only, so the completing node
    // is always the endNodeId. A route on the hook's sourceNode only counts when
    // that source IS the end node — here Coding (sourceNode) has the route but the
    // end node is Review (un-routed), so the router takes its no-route path.
    const routeOnCoding: WorkflowNodeInput[] = [
      {
        id: 'n1',
        name: 'Coding',
        agents: [{ agentId: 'a1', name: 'coder' }],
        postApproval: { targetAgent: 'reviewer', instructions: 'Merge the PR.' },
      },
      { id: 'n2', name: 'Review', agents: [{ agentId: 'a2', name: 'reviewer' }] },
    ];
    const errors = validateWorkflowHooks([prMergedHook({ sourceNode: 'Coding' })], routeOnCoding, {
      endNodeId: 'n2',
    }).join('\n');
    expect(errors).toContain('requires a reachable post-approval route');
  });

  test('pr_merged route is unreachable when targetAgent has surrounding whitespace', () => {
    // spawnPostApprovalSubSession resolves the target by exact slot-name match
    // (no trimming), so ' reviewer ' validates (validatePostApproval trims for
    // eligibility) but throws at spawn — leaving no session to invoke mark_complete.
    const routePaddedTarget: WorkflowNodeInput[] = [
      { id: 'n1', name: 'Coding', agents: [{ agentId: 'a1', name: 'coder' }] },
      {
        id: 'n2',
        name: 'Review',
        agents: [{ agentId: 'a2', name: 'reviewer' }],
        postApproval: { targetAgent: ' reviewer ', instructions: 'Merge the PR.' },
      },
    ];
    const errors = validateWorkflowHooks(
      [prMergedHook({ sourceNode: 'Review' })],
      routePaddedTarget,
      { endNodeId: 'n2' }
    ).join('\n');
    expect(errors).toContain('requires a reachable post-approval route');
  });

  test('pr_merged route is unreachable when targetAgent is the legacy task-agent', () => {
    // The router skips spawning for the legacy task-agent target, so such a route
    // does not make pr_merged reachable (mark_complete would never be invoked).
    const routeOnTaskAgent: WorkflowNodeInput[] = [
      { id: 'n1', name: 'Coding', agents: [{ agentId: 'a1', name: 'coder' }] },
      {
        id: 'n2',
        name: 'Review',
        agents: [{ agentId: 'a2', name: 'reviewer' }],
        postApproval: { targetAgent: 'task-agent', instructions: 'Merge the PR.' },
      },
    ];
    const errors = validateWorkflowHooks(
      [prMergedHook({ sourceNode: 'Review' })],
      routeOnTaskAgent,
      { endNodeId: 'n2' }
    ).join('\n');
    expect(errors).toContain('requires a reachable post-approval route');
  });

  test('pr_merged route is unreachable when instructions are empty', () => {
    // The router skips spawning when the interpolated instructions are empty; a
    // route with empty raw instructions can never spawn.
    const routeEmptyInstructions: WorkflowNodeInput[] = [
      { id: 'n1', name: 'Coding', agents: [{ agentId: 'a1', name: 'coder' }] },
      {
        id: 'n2',
        name: 'Review',
        agents: [{ agentId: 'a2', name: 'reviewer' }],
        postApproval: { targetAgent: 'reviewer', instructions: '   ' },
      },
    ];
    const errors = validateWorkflowHooks(
      [prMergedHook({ sourceNode: 'Review' })],
      routeEmptyInstructions,
      { endNodeId: 'n2' }
    ).join('\n');
    expect(errors).toContain('requires a reachable post-approval route');
  });

  test('validates localState.recentResultRef shape and cross-hook references', () => {
    const ref = { hookId: 'missing-hook', key: 'priorResult' };
    const errors = validateWorkflowHooks(
      [validHook({ localState: { recentResultRef: ref } })],
      nodes
    ).join('\n');
    expect(errors).toContain('recentResultRef.hookId: unknown hook id "missing-hook"');

    const badKey = validateWorkflowHooks(
      [validHook({ id: 'hook-a', localState: { recentResultRef: { hookId: 'hook-a', key: '' } } })],
      nodes
    ).join('\n');
    expect(badKey).toContain('recentResultRef.key: expected non-empty string');

    const badType = validateWorkflowHooks(
      [validHook({ localState: { recentResultRef: 'not-an-object' } as unknown })],
      nodes
    ).join('\n');
    expect(badType).toContain('recentResultRef: expected object');
  });
});
