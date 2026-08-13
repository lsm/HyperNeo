import { describe, test, expect } from 'bun:test';
import type { CustomHook, HookBinding, WorkflowNodeInput } from '@hyperneo/shared';
import {
  validateWorkflowHookBindings,
  validateCustomHooks,
  availableHookIds,
} from '../../../../src/lib/space/workflow-hook-validation.ts';

// Built-in hook ids registered by @hyperneo/extensions-hooks.
const BUILT_IN_IDS = [
  'pr_ready',
  'review_posted',
  'post_approval_only',
  'pr_merged',
  'codex_review_approved',
];

const nodes: WorkflowNodeInput[] = [
  { id: 'n1', name: 'Coding', agents: [{ agentId: 'a1', name: 'coder' }] },
  { id: 'n2', name: 'Review', agents: [{ agentId: 'a2', name: 'reviewer' }] },
  { id: 'n3', name: 'QA', agents: [{ agentId: 'a3', name: 'qa' }] },
];

function validBinding(overrides: Partial<HookBinding> = {}): HookBinding {
  return {
    hookId: 'pr_ready',
    sourceNode: 'Coding',
    targetNode: 'Review',
    method: 'send_message',
    order: 0,
    enabled: true,
    authorizedCallers: [{ sourceNode: 'Coding', agentSlots: ['coder'] }],
    ...overrides,
  };
}

function validCustomHook(overrides: Partial<CustomHook> = {}): CustomHook {
  return {
    id: 'audit-hook',
    requiredData: [{ key: 'pr_link', type: 'link', required: true }],
    run: { kind: 'script', interpreter: 'bash', source: 'echo ok' },
    ...overrides,
  };
}

describe('validateWorkflowHookBindings', () => {
  test('accepts bindings that reference a built-in hook id', () => {
    expect(validateWorkflowHookBindings([validBinding()], undefined, nodes)).toEqual([]);
  });

  test('accepts bindings that reference a declared custom hook', () => {
    const custom = validCustomHook();
    const binding = validBinding({ hookId: 'audit-hook' });
    expect(validateWorkflowHookBindings([binding], [custom], nodes)).toEqual([]);
  });

  test('rejects a binding whose hookId resolves to neither a built-in nor a custom hook', () => {
    const errors = validateWorkflowHookBindings(
      [validBinding({ hookId: 'nope-not-a-hook' })],
      undefined,
      nodes
    );
    expect(errors.join('\n')).toContain(
      '"nope-not-a-hook" is neither a registered built-in hook nor a declared custom hook'
    );
  });

  test('rejects unknown source/target node references', () => {
    const errors = validateWorkflowHookBindings(
      [validBinding({ sourceNode: 'Missing', targetNode: 'Gone' })],
      undefined,
      nodes
    );
    expect(errors.join('\n')).toContain('unknown node "Missing"');
    expect(errors.join('\n')).toContain('unknown node "Gone"');
  });

  test('rejects an invalid MCP method', () => {
    const errors = validateWorkflowHookBindings(
      [validBinding({ method: 'teleport' as never })],
      undefined,
      nodes
    );
    expect(errors.join('\n')).toContain('unknown method');
  });

  test('rejects a non-boolean enabled field', () => {
    const errors = validateWorkflowHookBindings(
      [{ ...validBinding(), enabled: 'yes' as unknown as boolean }],
      undefined,
      nodes
    );
    expect(errors.join('\n')).toContain('enabled: expected boolean');
  });

  test('validates authorizedCallers against the node set', () => {
    const binding = validBinding({
      authorizedCallers: [{ sourceNode: 'Nope' }],
    });
    const errors = validateWorkflowHookBindings([binding], undefined, nodes);
    expect(errors.join('\n')).toContain('unknown node "Nope"');
  });

  test('validates authorizedCaller agentSlots against the source node slot set', () => {
    const binding = validBinding({
      authorizedCallers: [{ sourceNode: 'Coding', agentSlots: ['ghost'] }],
    });
    const errors = validateWorkflowHookBindings([binding], undefined, nodes);
    expect(errors.join('\n')).toContain('unknown agent slot "ghost" for node "Coding"');
  });

  test('authorizes an empty agentSlots array as invalid (must be non-empty when present)', () => {
    const binding = validBinding({
      authorizedCallers: [{ sourceNode: 'Coding', agentSlots: [] }],
    });
    const errors = validateWorkflowHookBindings([binding], undefined, nodes);
    expect(errors.join('\n')).toContain('agentSlots: expected non-empty string array when present');
  });

  test('rejects authorizedCallers set to an empty array', () => {
    const binding = { ...validBinding(), authorizedCallers: [] };
    const errors = validateWorkflowHookBindings([binding], undefined, nodes);
    expect(errors.join('\n')).toContain('authorizedCallers: required non-empty array');
  });

  test('rejects a binding missing authorizedCallers (the engine would never match it)', () => {
    const { authorizedCallers: _omit, ...withoutCallers } = validBinding();
    const errors = validateWorkflowHookBindings([withoutCallers], undefined, nodes);
    expect(errors.join('\n')).toContain('authorizedCallers: required non-empty array');
  });

  test('treats undefined / null bindings as no-op', () => {
    expect(validateWorkflowHookBindings(undefined, undefined, nodes)).toEqual([]);
    expect(validateWorkflowHookBindings(null, undefined, nodes)).toEqual([]);
  });

  test('rejects a non-array bindings value', () => {
    expect(validateWorkflowHookBindings({ bad: true }, undefined, nodes)).toEqual([
      expect.stringContaining('hookBindings: expected array'),
    ]);
  });

  test('all six hook methods are admissible', () => {
    const methods = [
      'send_message',
      'save_artifact',
      'create_standalone_task',
      'mark_complete',
      'submit_for_approval',
      'approve_task',
    ] as const;
    const bindings = methods.map((method, i) => validBinding({ method, order: i }));
    expect(validateWorkflowHookBindings(bindings, undefined, nodes)).toEqual([]);
  });
});

describe('validateCustomHooks', () => {
  test('accepts a well-formed custom hook', () => {
    expect(validateCustomHooks([validCustomHook()])).toEqual([]);
  });

  test('accepts an optional description on a requiredData field', () => {
    const hook = validCustomHook({
      requiredData: [{ key: 'pr_link', type: 'link', required: true, description: 'The PR URL' }],
    });
    expect(validateCustomHooks([hook])).toEqual([]);
  });

  test('rejects a duplicate custom hook id', () => {
    const errors = validateCustomHooks([validCustomHook(), validCustomHook()]);
    expect(errors.join('\n')).toContain('duplicate custom hook id "audit-hook"');
  });

  test('rejects an empty custom hook id', () => {
    const errors = validateCustomHooks([validCustomHook({ id: '' })]);
    expect(errors.join('\n')).toContain('expected non-empty string');
  });

  test('rejects a custom hook whose run.kind is not "script"', () => {
    const hook = validCustomHook({
      run: { kind: 'wasm' as never, interpreter: 'bash', source: 'echo' },
    });
    const errors = validateCustomHooks([hook]);
    expect(errors.join('\n')).toContain('run.kind: expected "script"');
  });

  test('rejects a custom hook whose run.interpreter is not "bash"', () => {
    const hook = validCustomHook({
      run: { kind: 'script', interpreter: 'python3' as never, source: 'print(1)' },
    });
    const errors = validateCustomHooks([hook]);
    expect(errors.join('\n')).toContain('run.interpreter: expected "bash"');
  });

  test('rejects an empty run.source', () => {
    const hook = validCustomHook({
      run: { kind: 'script', interpreter: 'bash', source: '' },
    });
    const errors = validateCustomHooks([hook]);
    expect(errors.join('\n')).toContain('run.source: expected non-empty string');
  });

  test('rejects a malformed requiredData field', () => {
    const hook = validCustomHook({
      requiredData: [{ key: '', type: 'link', required: true }],
    });
    const errors = validateCustomHooks([hook]);
    expect(errors.join('\n')).toContain('key: expected non-empty string');
  });

  test('rejects an invalid requiredData type', () => {
    const hook = validCustomHook({
      requiredData: [{ key: 'x', type: 'json' as never, required: true }],
    });
    const errors = validateCustomHooks([hook]);
    expect(errors.join('\n')).toContain('type: expected one of string|number|boolean|link');
  });

  test('rejects a non-boolean required flag', () => {
    const hook = validCustomHook({
      requiredData: [{ key: 'x', type: 'string', required: 'yes' as unknown as boolean }],
    });
    const errors = validateCustomHooks([hook]);
    expect(errors.join('\n')).toContain('required: expected boolean');
  });

  test('rejects an out-of-range timeoutMs', () => {
    const hook = validCustomHook({
      run: { kind: 'script', interpreter: 'bash', source: 'echo', timeoutMs: 999_999_999 },
    });
    const errors = validateCustomHooks([hook]);
    expect(errors.join('\n')).toContain('run.timeoutMs: expected positive number');
  });

  test('treats undefined / null as no custom hooks', () => {
    expect(validateCustomHooks(undefined)).toEqual([]);
    expect(validateCustomHooks(null)).toEqual([]);
  });

  test('rejects a non-array customHooks value', () => {
    expect(validateCustomHooks({ nope: true })).toEqual([
      expect.stringContaining('customHooks: expected array'),
    ]);
  });
});

describe('availableHookIds', () => {
  test('includes the built-in hook ids even when no custom hooks are declared', () => {
    const ids = availableHookIds(undefined);
    for (const id of BUILT_IN_IDS) {
      expect(ids.has(id)).toBe(true);
    }
  });

  test('unions in the custom hook ids', () => {
    const ids = availableHookIds([validCustomHook({ id: 'extra' })]);
    expect(ids.has('extra')).toBe(true);
    // Built-ins are still present.
    expect(ids.has('pr_ready')).toBe(true);
  });
});
