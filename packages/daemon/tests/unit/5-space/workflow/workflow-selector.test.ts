import { describe, test, expect } from 'bun:test';
import { selectWorkflow } from '../../../../src/lib/space/runtime/workflow-selector.ts';
import type { WorkflowSelectionContext } from '../../../../src/lib/space/runtime/workflow-selector.ts';
import type { SpaceWorkflow } from '@hyperneo/shared';

let idCounter = 0;
function makeId(): string {
  return `wf-${++idCounter}`;
}

function makeWorkflow(overrides: Partial<SpaceWorkflow> = {}): SpaceWorkflow {
  const id = makeId();
  return {
    id,
    spaceId: 'space-1',
    name: `Workflow ${id}`,
    description: '',
    nodes: [],
    transitions: [],
    startNodeId: 'step-1',
    rules: [],
    tags: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

function makeContext(overrides: Partial<WorkflowSelectionContext> = {}): WorkflowSelectionContext {
  return {
    spaceId: 'space-1',
    availableWorkflows: [],
    ...overrides,
  };
}

describe('selectWorkflow — explicit workflowId', () => {
  test('returns the workflow with the matching id', () => {
    const wf1 = makeWorkflow({ id: 'wf-explicit-1' });
    const wf2 = makeWorkflow({ id: 'wf-explicit-2' });
    const ctx = makeContext({
      workflowId: 'wf-explicit-1',
      availableWorkflows: [wf1, wf2],
    });
    expect(selectWorkflow(ctx)).toBe(wf1);
  });

  test('returns the correct workflow when multiple are available', () => {
    const wf1 = makeWorkflow({ id: 'wf-multi-1' });
    const wf2 = makeWorkflow({ id: 'wf-multi-2' });
    const wf3 = makeWorkflow({ id: 'wf-multi-3' });
    const ctx = makeContext({
      workflowId: 'wf-multi-3',
      availableWorkflows: [wf1, wf2, wf3],
    });
    expect(selectWorkflow(ctx)).toBe(wf3);
  });

  test('returns null when explicit id not found in availableWorkflows', () => {
    const wf = makeWorkflow({ id: 'wf-other' });
    const ctx = makeContext({
      workflowId: 'wf-missing',
      availableWorkflows: [wf],
    });
    expect(selectWorkflow(ctx)).toBeNull();
  });

  test('returns null when explicit id not found and list is empty', () => {
    const ctx = makeContext({
      workflowId: 'wf-missing',
      availableWorkflows: [],
    });
    expect(selectWorkflow(ctx)).toBeNull();
  });

  test('is deterministic — same input always returns same output', () => {
    const wf1 = makeWorkflow({ id: 'wf-det-1' });
    const wf2 = makeWorkflow({ id: 'wf-det-2' });
    const ctx = makeContext({ workflowId: 'wf-det-1', availableWorkflows: [wf1, wf2] });
    expect(selectWorkflow(ctx)).toBe(selectWorkflow(ctx));
  });
});

describe('selectWorkflow — no workflowId (LLM must pick)', () => {
  test('returns null when no workflowId and no workflows', () => {
    const ctx = makeContext({ availableWorkflows: [] });
    expect(selectWorkflow(ctx)).toBeNull();
  });

  test('returns null when no workflowId even if workflows are available', () => {
    const wf = makeWorkflow({ id: 'wf-noworkflowid', tags: ['coding'] });
    const ctx = makeContext({ availableWorkflows: [wf] });
    expect(selectWorkflow(ctx)).toBeNull();
  });

  test('returns null when no workflowId and multiple workflows exist', () => {
    const wf1 = makeWorkflow({ id: 'wf-nm1', name: 'Coding Workflow' });
    const wf2 = makeWorkflow({ id: 'wf-nm2', name: 'Research Workflow' });
    const ctx = makeContext({ availableWorkflows: [wf1, wf2] });
    expect(selectWorkflow(ctx)).toBeNull();
  });
});
