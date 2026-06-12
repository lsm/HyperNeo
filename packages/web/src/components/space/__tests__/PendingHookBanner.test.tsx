/**
 * Unit tests for PendingHookBanner.
 *
 * Covers:
 * - hidden when no pending hooks
 * - rendered when a hook is blocked_by_hook
 * - rendered when a hook is waiting_on_hook_retry
 * - approve click fires spaceWorkflowRun.approveHook
 * - reject click fires spaceWorkflowRun.approveHook with approved=false
 * - retry click fires spaceWorkflowRun.retryHook
 * - fetch error surfaces with a Retry button
 * - per-hook busy and error states
 */

// @ts-nocheck
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/preact';
import { signal } from '@preact/signals';
import type { SpaceWorkflow, WorkflowHookStateSnapshot } from '@neokai/shared';

// ---- Mock hub ----
const mockRequest: Mock = vi.fn();
const mockOnEvent: Mock = vi.fn(() => () => {});
const mockHub = { request: mockRequest, onEvent: mockOnEvent };

vi.mock('../../../lib/connection-manager', () => ({
  connectionManager: {
    getHub: vi.fn(() => Promise.resolve(mockHub)),
    getHubIfConnected: vi.fn(() => mockHub),
  },
}));

// ---- Mock space-store.workflows signal ----
const workflowsSignal = signal<SpaceWorkflow[]>([]);
vi.mock('../../../lib/space-store', () => ({
  spaceStore: {
    get workflows() {
      return workflowsSignal;
    },
    workflowVersions: signal(new Map()),
    fetchWorkflowDetail: vi.fn((id: string) =>
      Promise.resolve(workflowsSignal.value.find((w) => w.id === id) ?? null)
    ),
  },
}));

import { PendingHookBanner } from '../PendingHookBanner';

function makeHookState(
  hookId: string,
  status: WorkflowHookStateSnapshot['lastResult']['type']
): WorkflowHookStateSnapshot {
  return {
    runId: 'r1',
    hookId,
    version: 1,
    localState: {},
    lastResult:
      status === 'block'
        ? { type: 'block', reason: 'Needs approval' }
        : status === 'retryable_block'
          ? { type: 'retryable_block', reason: 'Retry me' }
          : { type: 'allow' },
    retryCount: 0,
    createdAt: 0,
    updatedAt: 0,
    voteMaps: {},
  };
}

function makeWorkflow(
  hookDefs: Array<{ id: string; label?: string; method?: string }>
): SpaceWorkflow {
  return {
    id: 'wf-1',
    name: 'Test Workflow',
    description: '',
    nodes: [{ id: 'n1', name: 'Plan', agents: [] }],
    channels: [],
    hooks: hookDefs.map((h) => ({
      id: h.id,
      enabled: true,
      sourceNode: 'Plan',
      method: h.method || 'send_message',
      label: h.label,
      validator: { kind: 'built_in', id: 'pr_open' },
    })),
    startNodeId: 'n1',
    endNodeId: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    spaceId: 'space-1',
  } as unknown as SpaceWorkflow;
}

describe('PendingHookBanner', () => {
  beforeEach(() => {
    cleanup();
    mockRequest.mockReset();
    mockOnEvent.mockReset();
    mockOnEvent.mockImplementation(() => () => {});
    workflowsSignal.value = [];
  });

  afterEach(() => {
    cleanup();
  });

  it('renders nothing when there are no pending hooks', async () => {
    workflowsSignal.value = [makeWorkflow([{ id: 'h1' }])];
    mockRequest.mockResolvedValue({
      hookStates: [makeHookState('h1', 'allow')],
      hooks: makeWorkflow([{ id: 'h1' }]).hooks,
    });
    const { queryByTestId } = render(
      <PendingHookBanner runId="r1" spaceId="s1" workflowId="wf-1" />
    );
    await waitFor(() =>
      expect(mockRequest).toHaveBeenCalledWith('spaceWorkflowRun.listHookStates', { runId: 'r1' })
    );
    expect(queryByTestId('pending-hook-banner')).toBeNull();
    expect(queryByTestId('pending-hook-fetch-error')).toBeNull();
  });

  it('renders the banner for a blocked_by_hook hook', async () => {
    workflowsSignal.value = [makeWorkflow([{ id: 'h1', label: 'Merge Check' }])];
    mockRequest.mockResolvedValue({
      hookStates: [makeHookState('h1', 'block')],
      hooks: makeWorkflow([{ id: 'h1', label: 'Merge Check' }]).hooks,
    });
    const { findByTestId, getByTestId, queryByTestId } = render(
      <PendingHookBanner runId="r1" spaceId="s1" workflowId="wf-1" />
    );
    await findByTestId('pending-hook-banner');
    expect(getByTestId('pending-hook-approve-btn')).toBeTruthy();
    expect(getByTestId('pending-hook-reject-btn')).toBeTruthy();
    expect(queryByTestId('pending-hook-retry-btn')).toBeNull();
  });

  it('renders the banner for a waiting_on_hook_retry hook', async () => {
    workflowsSignal.value = [makeWorkflow([{ id: 'h1', label: 'Poll Check' }])];
    mockRequest.mockResolvedValue({
      hookStates: [makeHookState('h1', 'retryable_block')],
      hooks: makeWorkflow([{ id: 'h1', label: 'Poll Check' }]).hooks,
    });
    const { findByTestId, getByTestId, queryByTestId } = render(
      <PendingHookBanner runId="r1" spaceId="s1" workflowId="wf-1" />
    );
    await findByTestId('pending-hook-banner');
    expect(getByTestId('pending-hook-retry-btn')).toBeTruthy();
    expect(queryByTestId('pending-hook-approve-btn')).toBeNull();
    expect(queryByTestId('pending-hook-reject-btn')).toBeNull();
  });

  it('approve click fires approveHook with approved=true', async () => {
    workflowsSignal.value = [makeWorkflow([{ id: 'h1' }])];
    mockRequest.mockImplementation((method: string) => {
      if (method === 'spaceWorkflowRun.listHookStates')
        return Promise.resolve({
          hookStates: [makeHookState('h1', 'block')],
          hooks: makeWorkflow([{ id: 'h1' }]).hooks,
        });
      return Promise.resolve({});
    });
    const { findByTestId } = render(
      <PendingHookBanner runId="r1" spaceId="s1" workflowId="wf-1" />
    );
    const btn = await findByTestId('pending-hook-approve-btn');
    fireEvent.click(btn);
    await waitFor(() =>
      expect(mockRequest).toHaveBeenCalledWith('spaceWorkflowRun.approveHook', {
        runId: 'r1',
        hookId: 'h1',
        approved: true,
      })
    );
  });

  it('reject click fires approveHook with approved=false', async () => {
    workflowsSignal.value = [makeWorkflow([{ id: 'h1' }])];
    mockRequest.mockImplementation((method: string) => {
      if (method === 'spaceWorkflowRun.listHookStates')
        return Promise.resolve({
          hookStates: [makeHookState('h1', 'block')],
          hooks: makeWorkflow([{ id: 'h1' }]).hooks,
        });
      return Promise.resolve({});
    });
    const { findByTestId } = render(
      <PendingHookBanner runId="r1" spaceId="s1" workflowId="wf-1" />
    );
    const btn = await findByTestId('pending-hook-reject-btn');
    fireEvent.click(btn);
    await waitFor(() =>
      expect(mockRequest).toHaveBeenCalledWith('spaceWorkflowRun.approveHook', {
        runId: 'r1',
        hookId: 'h1',
        approved: false,
      })
    );
  });

  it('retry click fires retryHook', async () => {
    workflowsSignal.value = [makeWorkflow([{ id: 'h1' }])];
    mockRequest.mockImplementation((method: string) => {
      if (method === 'spaceWorkflowRun.listHookStates')
        return Promise.resolve({
          hookStates: [makeHookState('h1', 'retryable_block')],
          hooks: makeWorkflow([{ id: 'h1' }]).hooks,
        });
      return Promise.resolve({});
    });
    const { findByTestId } = render(
      <PendingHookBanner runId="r1" spaceId="s1" workflowId="wf-1" />
    );
    const btn = await findByTestId('pending-hook-retry-btn');
    fireEvent.click(btn);
    await waitFor(() =>
      expect(mockRequest).toHaveBeenCalledWith('spaceWorkflowRun.retryHook', {
        runId: 'r1',
        hookId: 'h1',
      })
    );
  });

  it('surfaces fetch errors with a Retry button', async () => {
    workflowsSignal.value = [makeWorkflow([{ id: 'h1' }])];
    mockRequest.mockRejectedValueOnce(new Error('network down'));
    const { findByTestId, getByTestId } = render(
      <PendingHookBanner runId="r1" spaceId="s1" workflowId="wf-1" />
    );
    await findByTestId('pending-hook-fetch-error');
    expect(getByTestId('pending-hook-fetch-error').textContent).toContain('network down');
    mockRequest.mockResolvedValueOnce({ hookStates: [], hooks: [] });
    fireEvent.click(getByTestId('pending-hook-fetch-retry'));
    await waitFor(() => expect(mockRequest).toHaveBeenCalledTimes(2));
  });

  it('per-hook busy state: retrying hook A does not disable hook B buttons', async () => {
    workflowsSignal.value = [makeWorkflow([{ id: 'h1' }, { id: 'h2' }])];
    let resolveRetry: (v: unknown) => void = () => {};
    const pending = new Promise((resolve) => {
      resolveRetry = resolve;
    });
    mockRequest.mockImplementation((method: string) => {
      if (method === 'spaceWorkflowRun.listHookStates')
        return Promise.resolve({
          hookStates: [
            makeHookState('h1', 'retryable_block'),
            makeHookState('h2', 'retryable_block'),
          ],
          hooks: makeWorkflow([{ id: 'h1' }, { id: 'h2' }]).hooks,
        });
      if (method === 'spaceWorkflowRun.retryHook') return pending;
      return Promise.resolve({});
    });
    const { findByTestId, getAllByTestId } = render(
      <PendingHookBanner runId="r1" spaceId="s1" workflowId="wf-1" />
    );
    await findByTestId('pending-hook-banner');
    const retryBtns = getAllByTestId('pending-hook-retry-btn') as HTMLButtonElement[];
    fireEvent.click(retryBtns[0]);
    await waitFor(() => expect(retryBtns[0].disabled).toBe(true));
    expect(retryBtns[1].disabled).toBe(false);
    resolveRetry({});
  });

  it('per-hook error: an error on hook A renders inside hook A row, not globally', async () => {
    workflowsSignal.value = [makeWorkflow([{ id: 'h1' }, { id: 'h2' }])];
    mockRequest.mockImplementation((method: string, params: { hookId?: string }) => {
      if (method === 'spaceWorkflowRun.listHookStates')
        return Promise.resolve({
          hookStates: [makeHookState('h1', 'block'), makeHookState('h2', 'block')],
          hooks: makeWorkflow([{ id: 'h1' }, { id: 'h2' }]).hooks,
        });
      if (method === 'spaceWorkflowRun.approveHook' && params.hookId === 'h1') {
        return Promise.reject(new Error('backend exploded'));
      }
      return Promise.resolve({});
    });
    const { findByTestId, getAllByTestId, findAllByTestId } = render(
      <PendingHookBanner runId="r1" spaceId="s1" workflowId="wf-1" />
    );
    await findByTestId('pending-hook-banner');
    const rejectBtns = getAllByTestId('pending-hook-reject-btn') as HTMLButtonElement[];
    fireEvent.click(rejectBtns[0]);
    const errors = await findAllByTestId('pending-hook-error');
    expect(errors).toHaveLength(1);
    expect(errors[0].textContent).toContain('backend exploded');
  });
});
