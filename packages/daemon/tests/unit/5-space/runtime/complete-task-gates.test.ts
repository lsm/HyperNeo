import { expect, mock, test } from 'bun:test';
import type { SpaceTask, SpaceWorkflow } from '@hyperneo/shared';
import { createCompletionGateBindings } from '../../../../src/lib/space/operations/complete-task-gates';

const task = { id: 'task-1' } as unknown as SpaceTask;
const workflow = { id: 'wf-1' } as unknown as SpaceWorkflow;

function bindings(overrides: Partial<Parameters<typeof createCompletionGateBindings>[0]> = {}) {
  return createCompletionGateBindings({
    resolveWorkflowForTask: () => workflow,
    isCoderOwnedMergeWorkflow: () => false,
    resolvePrUrl: () => '',
    getPrState: async () => 'MERGED',
    workflowDeclaresPostApprovalRoute: () => false,
    ...overrides,
  });
}

test('requiresPostApprovalOwner delegates to the runtime query regardless of caller', () => {
  const workflowDeclaresPostApprovalRoute = mock(() => true);
  const { requiresPostApprovalOwner } = bindings({ workflowDeclaresPostApprovalRoute });
  expect(requiresPostApprovalOwner!(task, { source: 'rpc' })).toBe(true);
  expect(requiresPostApprovalOwner!(task, { source: 'internal' })).toBe(true);
  expect(requiresPostApprovalOwner!(task, { source: 'mcp', sessionId: 'session-1' })).toBe(true);
  expect(workflowDeclaresPostApprovalRoute).toHaveBeenCalledWith('task-1');
});

test('requiresPostApprovalOwner returns false when the runtime query says so', () => {
  const { requiresPostApprovalOwner } = bindings({
    workflowDeclaresPostApprovalRoute: () => false,
  });
  expect(requiresPostApprovalOwner!(task, { source: 'mcp', sessionId: 'session-1' })).toBe(false);
});

test('completionGate admits directly when the workflow is not a coder-owned-merge workflow', async () => {
  const resolvePrUrl = mock(() => 'https://example.com/pr/1');
  const getPrState = mock(async () => 'OPEN');
  const { completionGate } = bindings({
    isCoderOwnedMergeWorkflow: () => false,
    resolvePrUrl,
    getPrState,
  });
  expect(await completionGate!(task, { source: 'rpc' })).toEqual({ ok: true });
  expect(resolvePrUrl).not.toHaveBeenCalled();
  expect(getPrState).not.toHaveBeenCalled();
});

test('completionGate resolves the workflow for the task before checking ownership', async () => {
  const resolveWorkflowForTask = mock(() => workflow);
  const isCoderOwnedMergeWorkflow = mock(() => false);
  const { completionGate } = bindings({ resolveWorkflowForTask, isCoderOwnedMergeWorkflow });
  await completionGate!(task, { source: 'rpc' });
  expect(resolveWorkflowForTask).toHaveBeenCalledWith(task);
  expect(isCoderOwnedMergeWorkflow).toHaveBeenCalledWith(workflow);
});

test('completionGate delegates to the PR-merge gate for a coder-owned-merge workflow and admits a merged PR', async () => {
  const { completionGate } = bindings({
    isCoderOwnedMergeWorkflow: () => true,
    resolvePrUrl: () => 'https://example.com/pr/1',
    getPrState: async () => 'MERGED',
  });
  expect(await completionGate!(task, { source: 'rpc' })).toEqual({ ok: true });
});

test('completionGate rejects a coder-owned-merge workflow with an unmerged PR', async () => {
  const { completionGate } = bindings({
    isCoderOwnedMergeWorkflow: () => true,
    resolvePrUrl: () => 'https://example.com/pr/1',
    getPrState: async () => 'OPEN',
  });
  const result = await completionGate!(task, { source: 'rpc' });
  expect(result.ok).toBe(false);
  expect((result as { ok: false; error: string }).error).toContain('still OPEN');
});

test('completionGate rejects a coder-owned-merge workflow with no resolvable PR URL', async () => {
  const { completionGate } = bindings({
    isCoderOwnedMergeWorkflow: () => true,
    resolvePrUrl: () => '',
  });
  const result = await completionGate!(task, { source: 'rpc' });
  expect(result.ok).toBe(false);
  expect((result as { ok: false; error: string }).error).toContain(
    "could not resolve the run's PR URL"
  );
});
