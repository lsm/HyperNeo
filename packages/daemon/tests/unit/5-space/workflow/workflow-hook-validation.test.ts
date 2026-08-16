import { describe, test, expect, beforeAll } from 'bun:test';
import type { WorkflowHook, WorkflowNodeInput } from '@hyperneo/shared';
import { validateWorkflowHooks } from '../../../../src/lib/space/workflow-hook-validation.ts';
import { WorkflowHookRuntimeService } from '../../../../src/lib/space/workflow-hook-runtime-service.ts';
import { registerProductionConnectors } from '../../../../src/lib/space/runtime/connectors/production.ts';

const runtimeService = new WorkflowHookRuntimeService();

// externalLookups are admitted via the connector registry, so seed it with the
// github connector before exercising validation.
beforeAll(() => {
  registerProductionConnectors();
});

const nodes: WorkflowNodeInput[] = [
  { id: 'n1', name: 'Coding', agents: [{ agentId: 'a1', name: 'coder' }] },
  { id: 'n2', name: 'Review', agents: [{ agentId: 'a2', name: 'reviewer' }] },
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

describe('workflow hook validation', () => {
  test('accepts valid hook definitions', () => {
    expect(validateWorkflowHooks([validHook()], nodes)).toEqual([]);
  });

  test('admits complete_validation_task as a hook method (task #918)', () => {
    // The validation-completion tool is node-agent-exclusive and wrapped by
    // the hook engine, so workflows must be able to declare validators on
    // this method through every supported configuration path.
    const errors = validateWorkflowHooks(
      [validHook({ method: 'complete_validation_task' })],
      nodes
    );
    expect(errors).toEqual([]);
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

  test('narrows script hooks to bash and registered-connector external lookups', () => {
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
    // 'github' is a registered connector (admitted); 'jira' is not.
    expect(errors).toContain('"jira" is not a registered connector');
    expect(errors).not.toContain('"github" is not a registered connector');
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
    // Admission is registry-driven: the error lists the registered presets
    // rather than a hardcoded literal (epic #2299, P2 #2302).
    expect(errors).toContain('registered presets');
    expect(errors).toContain('"pr_ready"');
    expect(errors).toContain('"pr_merged"');
  });

  test('admits registered built-in presets (pr_ready, pr_merged) with no errors', () => {
    expect(
      validateWorkflowHooks([validHook({ validator: { kind: 'built_in', id: 'pr_ready' } })], nodes)
    ).toEqual([]);
    expect(
      validateWorkflowHooks(
        [validHook({ validator: { kind: 'built_in', id: 'pr_merged' } })],
        nodes
      )
    ).toEqual([]);
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
