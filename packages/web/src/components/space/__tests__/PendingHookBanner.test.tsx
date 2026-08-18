// @ts-nocheck
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/preact';
import { signal } from '@preact/signals';
import type { SpaceWorkflow, WorkflowHookStateSnapshot } from '@hyperneo/shared';

const mockRequest: Mock = vi.fn();
const mockOnEvent: Mock = vi.fn(() => () => {});
const mockHub = { request: mockRequest, onEvent: mockOnEvent };

vi.mock('../../../lib/connection-manager', () => ({
  connectionManager: {
    getHub: vi.fn(() => Promise.resolve(mockHub)),
    getHubIfConnected: vi.fn(() => mockHub),
  },
}));

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
import { evaluateHookStatus } from '../use-run-hook-states';

function makeHookState(
  hookId: string,
  status: WorkflowHookStateSnapshot['lastResult']['type'],
  options: { allowHumanApproval?: boolean } = {}
): WorkflowHookStateSnapshot {
  return {
    runId: 'r1',
    hookId,
    version: 1,
    localState: {},
    lastResult:
      status === 'block'
        ? {
            type: 'block',
            reason: 'Needs approval',
            data: options.allowHumanApproval ? { allowHumanApproval: true } : undefined,
          }
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
  hookDefs: Array<{
    id: string;
    label?: string;
    method?: string;
    classification?: 'validation' | 'side_effect';
  }>
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
      classification: h.classification,
      validator: { kind: 'built_in', id: 'pr_open' },
    })),
    startNodeId: 'n1',
    endNodeId: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    spaceId: 'space-1',
  } as unknown as SpaceWorkflow;
}

describe('evaluateHookStatus', () => {
  it('maps validation hook block results to pending statuses', () => {
    expect(
      evaluateHookStatus(makeHookState('h1', 'block'), makeWorkflow([{ id: 'h1' }]).hooks[0]).status
    ).toBe('blocked_by_hook');
    expect(
      evaluateHookStatus(
        makeHookState('h1', 'retryable_block'),
        makeWorkflow([{ id: 'h1' }]).hooks[0]
      ).status
    ).toBe('waiting_on_hook_retry');
  });

  it('treats side-effect hook failures as allowed for banners', () => {
    expect(
      evaluateHookStatus(
        makeHookState('h1', 'block'),
        makeWorkflow([{ id: 'h1', classification: 'side_effect' }]).hooks[0]
      ).status
    ).toBe('allowed');
  });
});

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

  it('renders the banner for a blocked_by_hook hook without approval actions by default', async () => {
    workflowsSignal.value = [makeWorkflow([{ id: 'h1', label: 'Merge Check' }])];
    mockRequest.mockResolvedValue({
      hookStates: [makeHookState('h1', 'block')],
      hooks: makeWorkflow([{ id: 'h1', label: 'Merge Check' }]).hooks,
    });
    const { findByTestId, queryByTestId } = render(
      <PendingHookBanner runId="r1" spaceId="s1" workflowId="wf-1" />
    );
    await findByTestId('pending-hook-banner');
    expect(queryByTestId('pending-hook-approve-btn')).toBeNull();
    expect(queryByTestId('pending-hook-reject-btn')).toBeNull();
    expect(queryByTestId('pending-hook-retry-btn')).toBeNull();
  });

  it('renders approval actions for blocks that opt into human approval', async () => {
    workflowsSignal.value = [makeWorkflow([{ id: 'h1', label: 'Merge Check' }])];
    mockRequest.mockResolvedValue({
      hookStates: [makeHookState('h1', 'block', { allowHumanApproval: true })],
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

  it('ignores side-effect hook block results', async () => {
    workflowsSignal.value = [makeWorkflow([{ id: 'h1', classification: 'side_effect' }])];
    mockRequest.mockResolvedValue({
      hookStates: [makeHookState('h1', 'block')],
      hooks: makeWorkflow([{ id: 'h1', classification: 'side_effect' }]).hooks,
    });
    const { queryByTestId } = render(
      <PendingHookBanner runId="r1" spaceId="s1" workflowId="wf-1" />
    );
    await waitFor(() =>
      expect(mockRequest).toHaveBeenCalledWith('spaceWorkflowRun.listHookStates', { runId: 'r1' })
    );
    expect(queryByTestId('pending-hook-banner')).toBeNull();
  });

  it('ignores disabled hooks with stale block state', async () => {
    const workflow = makeWorkflow([{ id: 'h1' }]);
    workflow.hooks![0].enabled = false;
    workflowsSignal.value = [workflow];
    mockRequest.mockResolvedValue({
      hookStates: [makeHookState('h1', 'block')],
      hooks: workflow.hooks,
    });
    const { queryByTestId } = render(
      <PendingHookBanner runId="r1" spaceId="s1" workflowId="wf-1" />
    );
    await waitFor(() =>
      expect(mockRequest).toHaveBeenCalledWith('spaceWorkflowRun.listHookStates', { runId: 'r1' })
    );
    expect(queryByTestId('pending-hook-banner')).toBeNull();
  });

  it('uses provided fetch retry instead of a separate hook state request', async () => {
    const retry = vi.fn();
    const { getByTestId } = render(
      <PendingHookBanner
        runId="r1"
        spaceId="s1"
        workflowId="wf-1"
        summaries={[]}
        fetchError="network down"
        retry={retry}
      />
    );
    await Promise.resolve();
    expect(mockRequest).not.toHaveBeenCalledWith('spaceWorkflowRun.listHookStates', {
      runId: 'r1',
    });
    fireEvent.click(getByTestId('pending-hook-fetch-retry'));
    expect(retry).toHaveBeenCalled();
  });

  it('updates from hook state subscription events', async () => {
    workflowsSignal.value = [makeWorkflow([{ id: 'h1' }])];
    let onHookStateUpdated: ((event: unknown) => void) | undefined;
    mockOnEvent.mockImplementation((eventName: string, cb: (event: unknown) => void) => {
      if (eventName === 'space.hookState.updated') onHookStateUpdated = cb;
      return () => {};
    });
    mockRequest.mockResolvedValue({ hookStates: [], hooks: makeWorkflow([{ id: 'h1' }]).hooks });
    const { findByTestId } = render(
      <PendingHookBanner runId="r1" spaceId="s1" workflowId="wf-1" />
    );
    await waitFor(() => expect(onHookStateUpdated).toBeTruthy());

    onHookStateUpdated?.({ runId: 'r1', hookId: 'h1', hookState: makeHookState('h1', 'block') });

    await findByTestId('pending-hook-banner');
  });

  it('approve click fires approveHook with approved=true', async () => {
    workflowsSignal.value = [makeWorkflow([{ id: 'h1' }])];
    mockRequest.mockImplementation((method: string) => {
      if (method === 'spaceWorkflowRun.listHookStates')
        return Promise.resolve({
          hookStates: [makeHookState('h1', 'block', { allowHumanApproval: true })],
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
          hookStates: [makeHookState('h1', 'block', { allowHumanApproval: true })],
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

  it('renders retry count and remediation details', async () => {
    workflowsSignal.value = [makeWorkflow([{ id: 'h1' }])];
    mockRequest.mockResolvedValue({
      hookStates: [
        {
          ...makeHookState('h1', 'retryable_block'),
          retryCount: 2,
          nextRetryAt: Date.now() + 1000,
          lastResult: { type: 'retryable_block', reason: 'Retry me', message: 'Try again later' },
        },
      ],
      hooks: makeWorkflow([{ id: 'h1' }]).hooks,
    });
    const { findByTestId } = render(
      <PendingHookBanner runId="r1" spaceId="s1" workflowId="wf-1" />
    );

    expect((await findByTestId('pending-hook-remediation')).textContent).toContain(
      'Try again later'
    );
    expect((await findByTestId('pending-hook-retry-count')).textContent).toContain(
      'Retry attempt 2'
    );
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
          hookStates: [
            makeHookState('h1', 'block', { allowHumanApproval: true }),
            makeHookState('h2', 'block', { allowHumanApproval: true }),
          ],
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
