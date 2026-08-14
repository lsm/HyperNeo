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
import type { SpaceWorkflow, HookStateSnapshot, HookBinding } from '@hyperneo/shared';

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
import { evaluateHookStatus } from '../use-run-hook-states';

/**
 * Build a v2 HookStateSnapshot. `flow` maps to `lastFlow`:
 *   'stop' → blocked, 'retry' → waiting_on_retry, 'continue'/undefined → allowed.
 */
function makeHookState(
  hookId: string,
  flow: 'stop' | 'retry' | 'continue',
  options: { reason?: string; retryCount?: number; nextRetryAt?: number } = {}
): HookStateSnapshot {
  return {
    runId: 'r1',
    hookId,
    version: 1,
    localState: {},
    lastFlow: flow,
    lastReason: options.reason,
    retryCount: options.retryCount ?? 0,
    nextRetryAt: options.nextRetryAt,
    createdAt: 0,
    updatedAt: 0,
  };
}

function makeWorkflow(
  hookDefs: Array<{
    id: string;
    label?: string;
    method?: string;
  }>
): SpaceWorkflow {
  return {
    id: 'wf-1',
    name: 'Test Workflow',
    description: '',
    nodes: [{ id: 'n1', name: 'Plan', agents: [] }],
    channels: [],
    hookBindings: hookDefs.map(
      (h): HookBinding => ({
        hookId: h.id,
        sourceNode: 'Plan',
        targetNode: '',
        method: (h.method || 'send_message') as HookBinding['method'],
        order: 0,
        enabled: true,
      })
    ),
    startNodeId: 'n1',
    endNodeId: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    spaceId: 'space-1',
  } as unknown as SpaceWorkflow;
}

describe('evaluateHookStatus', () => {
  it('maps lastFlow=stop to blocked_by_hook', () => {
    expect(
      evaluateHookStatus(makeHookState('h1', 'stop'), makeWorkflow([{ id: 'h1' }]).hookBindings[0])
        .status
    ).toBe('blocked_by_hook');
  });

  it('maps lastFlow=retry to waiting_on_hook_retry', () => {
    expect(
      evaluateHookStatus(makeHookState('h1', 'retry'), makeWorkflow([{ id: 'h1' }]).hookBindings[0])
        .status
    ).toBe('waiting_on_hook_retry');
  });

  it('maps lastFlow=continue to allowed', () => {
    expect(
      evaluateHookStatus(
        makeHookState('h1', 'continue'),
        makeWorkflow([{ id: 'h1' }]).hookBindings[0]
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
      hookStates: [makeHookState('h1', 'continue')],
      hookBindings: makeWorkflow([{ id: 'h1' }]).hookBindings,
    });
    const { queryByTestId } = render(<PendingHookBanner runId="r1" spaceId="s1" />);
    await waitFor(() =>
      expect(mockRequest).toHaveBeenCalledWith('spaceWorkflowRun.listHookStates', { runId: 'r1' })
    );
    expect(queryByTestId('pending-hook-banner')).toBeNull();
    expect(queryByTestId('pending-hook-fetch-error')).toBeNull();
  });

  it('renders the banner with approve/reject actions for a blocked_by_hook hook (v2)', async () => {
    // v2: a blocked hook always offers approve/reject — the old
    // allowHumanApproval opt-in has no v2 equivalent.
    workflowsSignal.value = [makeWorkflow([{ id: 'h1', label: 'Merge Check' }])];
    mockRequest.mockResolvedValue({
      hookStates: [makeHookState('h1', 'stop')],
      hookBindings: makeWorkflow([{ id: 'h1', label: 'Merge Check' }]).hookBindings,
    });
    const { findByTestId, getByTestId, queryByTestId } = render(
      <PendingHookBanner runId="r1" spaceId="s1" />
    );
    await findByTestId('pending-hook-banner');
    expect(getByTestId('pending-hook-approve-btn')).toBeTruthy();
    expect(getByTestId('pending-hook-reject-btn')).toBeTruthy();
    expect(queryByTestId('pending-hook-retry-btn')).toBeNull();
  });

  it('renders the banner for a waiting_on_hook_retry hook', async () => {
    workflowsSignal.value = [makeWorkflow([{ id: 'h1', label: 'Poll Check' }])];
    mockRequest.mockResolvedValue({
      hookStates: [makeHookState('h1', 'retry')],
      hookBindings: makeWorkflow([{ id: 'h1', label: 'Poll Check' }]).hookBindings,
    });
    const { findByTestId, getByTestId, queryByTestId } = render(
      <PendingHookBanner runId="r1" spaceId="s1" />
    );
    await findByTestId('pending-hook-banner');
    expect(getByTestId('pending-hook-retry-btn')).toBeTruthy();
    expect(queryByTestId('pending-hook-approve-btn')).toBeNull();
    expect(queryByTestId('pending-hook-reject-btn')).toBeNull();
  });

  it('ignores disabled hooks with stale block state', async () => {
    const workflow = makeWorkflow([{ id: 'h1' }]);
    workflow.hookBindings![0].enabled = false;
    workflowsSignal.value = [workflow];
    mockRequest.mockResolvedValue({
      hookStates: [makeHookState('h1', 'stop')],
      hookBindings: workflow.hookBindings,
    });
    const { queryByTestId } = render(<PendingHookBanner runId="r1" spaceId="s1" />);
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

  it('a stale pre-RPC event does not overwrite the newer fetched snapshot', async () => {
    // An event queued before listHookStates returns can carry an OLDER
    // version than the RPC read (a newer write landed between them). The
    // merge must retain the higher-version fetched snapshot — otherwise the
    // banner regresses to the obsolete stop state and the next approval
    // submits the stale expectedVersion.
    workflowsSignal.value = [makeWorkflow([{ id: 'h1' }])];
    let onHookStateUpdated: ((event: unknown) => void) | undefined;
    mockOnEvent.mockImplementation((eventName: string, cb: (event: unknown) => void) => {
      if (eventName === 'space.hookState.updated') onHookStateUpdated = cb;
      return () => {};
    });
    // The RPC returns version 2 (continue — newer state resolved the stop).
    const newer = makeHookState('h1', 'continue');
    newer.version = 2;
    let resolveList: ((v: unknown) => void) | undefined;
    mockRequest.mockImplementation((method: string) => {
      if (method === 'spaceWorkflowRun.listHookStates')
        return new Promise((resolve) => {
          resolveList = resolve;
        });
      return Promise.resolve({});
    });
    const { queryByTestId, findByTestId } = render(<PendingHookBanner runId="r1" spaceId="s1" />);
    await waitFor(() => expect(onHookStateUpdated).toBeTruthy());

    // Stale event (version 1, stop) lands BEFORE the RPC resolves. The
    // bindings from the same RPC response drive the banner; without them the
    // event snapshot alone renders nothing (the run-scoped bindings arrive
    // with the fetch). Provide them via a separately-resolved promise so the
    // event lands strictly first.
    onHookStateUpdated?.({ runId: 'r1', hookId: 'h1', hookState: makeHookState('h1', 'stop') });
    resolveList?.({
      hookStates: [newer],
      hookBindings: makeWorkflow([{ id: 'h1' }]).hookBindings,
    });

    // The fetched snapshot (version 2, continue) must win the merge: the
    // banner never appears, and any later approval reads version 2.
    await waitFor(() => expect(mockRequest).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 50));
    expect(queryByTestId('pending-hook-banner')).toBeNull();
  });

  it('updates from hook state subscription events', async () => {
    workflowsSignal.value = [makeWorkflow([{ id: 'h1' }])];
    let onHookStateUpdated: ((event: unknown) => void) | undefined;
    mockOnEvent.mockImplementation((eventName: string, cb: (event: unknown) => void) => {
      if (eventName === 'space.hookState.updated') onHookStateUpdated = cb;
      return () => {};
    });
    mockRequest.mockResolvedValue({
      hookStates: [],
      hookBindings: makeWorkflow([{ id: 'h1' }]).hookBindings,
    });
    const { findByTestId } = render(<PendingHookBanner runId="r1" spaceId="s1" />);
    await waitFor(() => expect(onHookStateUpdated).toBeTruthy());

    onHookStateUpdated?.({ runId: 'r1', hookId: 'h1', hookState: makeHookState('h1', 'stop') });

    await findByTestId('pending-hook-banner');
  });

  it('approve click fires approveHook with approved=true', async () => {
    workflowsSignal.value = [makeWorkflow([{ id: 'h1' }])];
    mockRequest.mockImplementation((method: string) => {
      if (method === 'spaceWorkflowRun.listHookStates')
        return Promise.resolve({
          hookStates: [makeHookState('h1', 'stop')],
          hookBindings: makeWorkflow([{ id: 'h1' }]).hookBindings,
        });
      return Promise.resolve({});
    });
    const { findByTestId } = render(<PendingHookBanner runId="r1" spaceId="s1" />);
    const btn = await findByTestId('pending-hook-approve-btn');
    fireEvent.click(btn);
    await waitFor(() =>
      expect(mockRequest).toHaveBeenCalledWith('spaceWorkflowRun.approveHook', {
        runId: 'r1',
        hookId: 'h1',
        approved: true,
        // The DISPLAYED snapshot's version — the daemon version-guards the
        // approval against it.
        expectedVersion: 1,
      })
    );
  });

  it('reject click fires approveHook with approved=false', async () => {
    workflowsSignal.value = [makeWorkflow([{ id: 'h1' }])];
    mockRequest.mockImplementation((method: string) => {
      if (method === 'spaceWorkflowRun.listHookStates')
        return Promise.resolve({
          hookStates: [makeHookState('h1', 'stop')],
          hookBindings: makeWorkflow([{ id: 'h1' }]).hookBindings,
        });
      return Promise.resolve({});
    });
    const { findByTestId } = render(<PendingHookBanner runId="r1" spaceId="s1" />);
    const btn = await findByTestId('pending-hook-reject-btn');
    fireEvent.click(btn);
    await waitFor(() =>
      expect(mockRequest).toHaveBeenCalledWith('spaceWorkflowRun.approveHook', {
        runId: 'r1',
        hookId: 'h1',
        approved: false,
        expectedVersion: 1,
      })
    );
  });

  it('retry click fires retryHook', async () => {
    workflowsSignal.value = [makeWorkflow([{ id: 'h1' }])];
    mockRequest.mockImplementation((method: string) => {
      if (method === 'spaceWorkflowRun.listHookStates')
        return Promise.resolve({
          hookStates: [makeHookState('h1', 'retry')],
          hookBindings: makeWorkflow([{ id: 'h1' }]).hookBindings,
        });
      return Promise.resolve({});
    });
    const { findByTestId } = render(<PendingHookBanner runId="r1" spaceId="s1" />);
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
    const { findByTestId, getByTestId } = render(<PendingHookBanner runId="r1" spaceId="s1" />);
    await findByTestId('pending-hook-fetch-error');
    expect(getByTestId('pending-hook-fetch-error').textContent).toContain('network down');
    mockRequest.mockResolvedValueOnce({ hookStates: [], hookBindings: [] });
    fireEvent.click(getByTestId('pending-hook-fetch-retry'));
    await waitFor(() => expect(mockRequest).toHaveBeenCalledTimes(2));
  });

  it('renders retry count and remediation details', async () => {
    workflowsSignal.value = [makeWorkflow([{ id: 'h1' }])];
    mockRequest.mockResolvedValue({
      hookStates: [
        makeHookState('h1', 'retry', {
          reason: 'Try again later',
          retryCount: 2,
          nextRetryAt: Date.now() + 1000,
        }),
      ],
      hookBindings: makeWorkflow([{ id: 'h1' }]).hookBindings,
    });
    const { findByTestId } = render(<PendingHookBanner runId="r1" spaceId="s1" />);

    // The reason is surfaced in the row label (the old duplicate
    // remediation block was removed).
    expect((await findByTestId('pending-hook-row')).textContent).toContain('Try again later');
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
          hookStates: [makeHookState('h1', 'retry'), makeHookState('h2', 'retry')],
          hookBindings: makeWorkflow([{ id: 'h1' }, { id: 'h2' }]).hookBindings,
        });
      if (method === 'spaceWorkflowRun.retryHook') return pending;
      return Promise.resolve({});
    });
    const { findByTestId, getAllByTestId } = render(<PendingHookBanner runId="r1" spaceId="s1" />);
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
          hookStates: [makeHookState('h1', 'stop'), makeHookState('h2', 'stop')],
          hookBindings: makeWorkflow([{ id: 'h1' }, { id: 'h2' }]).hookBindings,
        });
      if (method === 'spaceWorkflowRun.approveHook' && params.hookId === 'h1') {
        return Promise.reject(new Error('backend exploded'));
      }
      return Promise.resolve({});
    });
    const { findByTestId, getAllByTestId, findAllByTestId } = render(
      <PendingHookBanner runId="r1" spaceId="s1" />
    );
    await findByTestId('pending-hook-banner');
    const rejectBtns = getAllByTestId('pending-hook-reject-btn') as HTMLButtonElement[];
    fireEvent.click(rejectBtns[0]);
    const errors = await findAllByTestId('pending-hook-error');
    expect(errors).toHaveLength(1);
    expect(errors[0].textContent).toContain('backend exploded');
  });
});
