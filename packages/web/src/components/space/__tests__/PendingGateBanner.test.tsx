/**
 * Unit tests for PendingGateBanner.
 *
 * Covers:
 * - hidden when no pending gates
 * - rendered when a gate is waiting_human
 * - multi-gate stack
 * - approve click fires spaceWorkflowRun.approveGate
 * - reject click fires spaceWorkflowRun.approveGate with approved=false
 * - fetch error surfaces with a Retry button
 * - Review opens the artifacts overlay
 */

// @ts-nocheck
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/preact';
import { signal } from '@preact/signals';
import type { Gate, SpaceWorkflow } from '@neokai/shared';

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

// ---- Mock GateArtifactsView ----
vi.mock('../GateArtifactsView', () => ({
  GateArtifactsView: (props: Record<string, unknown>) => (
    <div data-testid="gate-artifacts-view" data-gate-id={props.gateId as string}>
      GateArtifactsView
      <button data-testid="gate-close" onClick={props.onClose as () => void}>
        Close
      </button>
    </div>
  ),
}));

import { PendingGateBanner } from '../PendingGateBanner';

function approvalGate(id: string, label?: string): Gate {
  return {
    id,
    label,
    resetOnCycle: false,
    fields: [
      {
        name: 'approved',
        type: 'boolean',
        writers: [],
        check: { op: '==', value: true },
      },
    ],
  };
}

function makeWorkflow(gates: Gate[]): SpaceWorkflow {
  return {
    id: 'wf-1',
    name: 'Test Workflow',
    description: '',
    nodes: [],
    channels: [],
    gates,
    startNodeId: null,
    endNodeId: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    spaceId: 'space-1',
  } as unknown as SpaceWorkflow;
}

describe('PendingGateBanner', () => {
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

  it('renders nothing when there are no pending gates', async () => {
    workflowsSignal.value = [makeWorkflow([approvalGate('g1')])];
    mockRequest.mockResolvedValue({
      gateData: [{ runId: 'r1', gateId: 'g1', data: { approved: true }, updatedAt: 0 }],
    });
    const { queryByTestId } = render(
      <PendingGateBanner runId="r1" spaceId="s1" workflowId="wf-1" />
    );
    await waitFor(() =>
      expect(mockRequest).toHaveBeenCalledWith('spaceWorkflowRun.listGateData', { runId: 'r1' })
    );
    expect(queryByTestId('pending-gate-banner')).toBeNull();
    expect(queryByTestId('pending-gate-fetch-error')).toBeNull();
  });

  it('does not show banner for gates with no data (not yet activated)', async () => {
    workflowsSignal.value = [makeWorkflow([approvalGate('g1', 'Review')])];
    mockRequest.mockResolvedValue({ gateData: [] });
    const { queryByTestId } = render(
      <PendingGateBanner runId="r1" spaceId="s1" workflowId="wf-1" />
    );
    await waitFor(() =>
      expect(mockRequest).toHaveBeenCalledWith('spaceWorkflowRun.listGateData', { runId: 'r1' })
    );
    expect(queryByTestId('pending-gate-banner')).toBeNull();
    expect(queryByTestId('pending-gate-fetch-error')).toBeNull();
  });

  it('renders the banner for a gate that is waiting_human', async () => {
    workflowsSignal.value = [makeWorkflow([approvalGate('g1', 'Merge PR')])];
    mockRequest.mockResolvedValue({
      gateData: [{ runId: 'r1', gateId: 'g1', data: {}, updatedAt: 0 }],
    });
    const { findByTestId, getByTestId } = render(
      <PendingGateBanner runId="r1" spaceId="s1" workflowId="wf-1" />
    );
    await findByTestId('pending-gate-banner');
    expect(getByTestId('pending-gate-approve-btn')).toBeTruthy();
    expect(getByTestId('pending-gate-reject-btn')).toBeTruthy();
    expect(getByTestId('pending-gate-review-btn')).toBeTruthy();
  });

  it('renders one row per pending gate in multi-gate workflows', async () => {
    workflowsSignal.value = [
      makeWorkflow([approvalGate('g1', 'First'), approvalGate('g2', 'Second')]),
    ];
    mockRequest.mockResolvedValue({
      gateData: [
        { runId: 'r1', gateId: 'g1', data: {}, updatedAt: 0 },
        { runId: 'r1', gateId: 'g2', data: {}, updatedAt: 0 },
      ],
    });
    const { findByTestId, getAllByTestId } = render(
      <PendingGateBanner runId="r1" spaceId="s1" workflowId="wf-1" />
    );
    await findByTestId('pending-gate-banner');
    expect(getAllByTestId('pending-gate-approve-btn')).toHaveLength(2);
  });

  it('approve click fires approveGate with approved=true', async () => {
    workflowsSignal.value = [makeWorkflow([approvalGate('g1')])];
    mockRequest.mockImplementation((method: string) => {
      if (method === 'spaceWorkflowRun.listGateData')
        return Promise.resolve({
          gateData: [{ runId: 'r1', gateId: 'g1', data: {}, updatedAt: 0 }],
        });
      return Promise.resolve({});
    });
    const { findByTestId } = render(
      <PendingGateBanner runId="r1" spaceId="s1" workflowId="wf-1" />
    );
    const btn = await findByTestId('pending-gate-approve-btn');
    fireEvent.click(btn);
    await waitFor(() =>
      expect(mockRequest).toHaveBeenCalledWith('spaceWorkflowRun.approveGate', {
        runId: 'r1',
        gateId: 'g1',
        approved: true,
      })
    );
  });

  it('reject click fires approveGate with approved=false', async () => {
    workflowsSignal.value = [makeWorkflow([approvalGate('g1')])];
    mockRequest.mockImplementation((method: string) => {
      if (method === 'spaceWorkflowRun.listGateData')
        return Promise.resolve({
          gateData: [{ runId: 'r1', gateId: 'g1', data: {}, updatedAt: 0 }],
        });
      return Promise.resolve({});
    });
    const { findByTestId } = render(
      <PendingGateBanner runId="r1" spaceId="s1" workflowId="wf-1" />
    );
    const btn = await findByTestId('pending-gate-reject-btn');
    fireEvent.click(btn);
    await waitFor(() =>
      expect(mockRequest).toHaveBeenCalledWith('spaceWorkflowRun.approveGate', {
        runId: 'r1',
        gateId: 'g1',
        approved: false,
      })
    );
  });

  it('surfaces fetch errors with a Retry button', async () => {
    workflowsSignal.value = [makeWorkflow([approvalGate('g1')])];
    mockRequest.mockRejectedValueOnce(new Error('network down'));
    const { findByTestId, getByTestId } = render(
      <PendingGateBanner runId="r1" spaceId="s1" workflowId="wf-1" />
    );
    await findByTestId('pending-gate-fetch-error');
    expect(getByTestId('pending-gate-fetch-error').textContent).toContain('network down');
    // Retry re-issues the listGateData request
    mockRequest.mockResolvedValueOnce({ gateData: [] });
    fireEvent.click(getByTestId('pending-gate-fetch-retry'));
    await waitFor(() => expect(mockRequest).toHaveBeenCalledTimes(2));
  });

  it('Review button opens the artifacts overlay', async () => {
    workflowsSignal.value = [makeWorkflow([approvalGate('g1')])];
    mockRequest.mockResolvedValue({
      gateData: [{ runId: 'r1', gateId: 'g1', data: {}, updatedAt: 0 }],
    });
    const { findByTestId, queryByTestId, getByTestId } = render(
      <PendingGateBanner runId="r1" spaceId="s1" workflowId="wf-1" />
    );
    await findByTestId('pending-gate-banner');
    expect(queryByTestId('pending-gate-review-overlay')).toBeNull();
    fireEvent.click(getByTestId('pending-gate-review-btn'));
    expect(getByTestId('pending-gate-review-overlay')).toBeTruthy();
    expect(getByTestId('gate-artifacts-view').getAttribute('data-gate-id')).toBe('g1');
  });

  it('Escape key closes the review overlay', async () => {
    workflowsSignal.value = [makeWorkflow([approvalGate('g1')])];
    mockRequest.mockResolvedValue({
      gateData: [{ runId: 'r1', gateId: 'g1', data: {}, updatedAt: 0 }],
    });
    const { findByTestId, queryByTestId, getByTestId } = render(
      <PendingGateBanner runId="r1" spaceId="s1" workflowId="wf-1" />
    );
    await findByTestId('pending-gate-banner');
    fireEvent.click(getByTestId('pending-gate-review-btn'));
    expect(getByTestId('pending-gate-review-overlay')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(queryByTestId('pending-gate-review-overlay')).toBeNull());
  });

  it('per-gate busy state: rejecting gate A does not disable gate B buttons', async () => {
    // Two pending gates. We fire rejection on g1 using a pending request so
    // the RPC never resolves within the test — if busy state were a single
    // value, gate B's buttons would appear disabled, which is the bug we
    // want to prevent.
    workflowsSignal.value = [
      makeWorkflow([approvalGate('g1', 'First'), approvalGate('g2', 'Second')]),
    ];
    let resolveApprove: (v: unknown) => void = () => {};
    const pending = new Promise((resolve) => {
      resolveApprove = resolve;
    });
    mockRequest.mockImplementation((method: string) => {
      if (method === 'spaceWorkflowRun.listGateData')
        return Promise.resolve({
          gateData: [
            { runId: 'r1', gateId: 'g1', data: {}, updatedAt: 0 },
            { runId: 'r1', gateId: 'g2', data: {}, updatedAt: 0 },
          ],
        });
      if (method === 'spaceWorkflowRun.approveGate') return pending;
      return Promise.resolve({});
    });
    const { findByTestId, getAllByTestId } = render(
      <PendingGateBanner runId="r1" spaceId="s1" workflowId="wf-1" />
    );
    await findByTestId('pending-gate-banner');
    const rejectBtns = getAllByTestId('pending-gate-reject-btn') as HTMLButtonElement[];
    const approveBtns = getAllByTestId('pending-gate-approve-btn') as HTMLButtonElement[];
    fireEvent.click(rejectBtns[0]);
    // First gate's buttons become busy; second gate's stay enabled.
    await waitFor(() => expect(rejectBtns[0].disabled).toBe(true));
    expect(approveBtns[0].disabled).toBe(true);
    expect(rejectBtns[1].disabled).toBe(false);
    expect(approveBtns[1].disabled).toBe(false);
    resolveApprove({});
  });

  it('per-gate error: an error on gate A renders inside gate A row, not globally', async () => {
    workflowsSignal.value = [
      makeWorkflow([approvalGate('g1', 'First'), approvalGate('g2', 'Second')]),
    ];
    mockRequest.mockImplementation((method: string, params: { gateId?: string }) => {
      if (method === 'spaceWorkflowRun.listGateData')
        return Promise.resolve({
          gateData: [
            { runId: 'r1', gateId: 'g1', data: {}, updatedAt: 0 },
            { runId: 'r1', gateId: 'g2', data: {}, updatedAt: 0 },
          ],
        });
      if (method === 'spaceWorkflowRun.approveGate' && params.gateId === 'g1') {
        return Promise.reject(new Error('backend exploded'));
      }
      return Promise.resolve({});
    });
    const { findByTestId, getAllByTestId, findAllByTestId } = render(
      <PendingGateBanner runId="r1" spaceId="s1" workflowId="wf-1" />
    );
    await findByTestId('pending-gate-banner');
    const rejectBtns = getAllByTestId('pending-gate-reject-btn') as HTMLButtonElement[];
    fireEvent.click(rejectBtns[0]);
    const errors = await findAllByTestId('pending-gate-error');
    // Exactly one error rendered (gate A's), not a global error for both.
    expect(errors).toHaveLength(1);
    expect(errors[0].textContent).toContain('backend exploded');
  });

  it('runId swap clears busyGateIds so buttons are not stuck disabled', async () => {
    workflowsSignal.value = [makeWorkflow([approvalGate('g1')])];
    let resolveApprove: (v: unknown) => void = () => {};
    const pending = new Promise((resolve) => {
      resolveApprove = resolve;
    });
    mockRequest.mockImplementation((method: string) => {
      if (method === 'spaceWorkflowRun.listGateData')
        return Promise.resolve({
          gateData: [{ runId: 'r1', gateId: 'g1', data: {}, updatedAt: 0 }],
        });
      if (method === 'spaceWorkflowRun.approveGate') return pending;
      return Promise.resolve({});
    });
    const { findByTestId, rerender } = render(
      <PendingGateBanner runId="r1" spaceId="s1" workflowId="wf-1" />
    );
    const rejectBtn = (await findByTestId('pending-gate-reject-btn')) as HTMLButtonElement;
    fireEvent.click(rejectBtn);
    await waitFor(() => expect(rejectBtn.disabled).toBe(true));
    // Swap runId while the RPC is still pending — busyGateIds must reset.
    rerender(<PendingGateBanner runId="r2" spaceId="s1" workflowId="wf-1" />);
    const rejectBtnAfterSwap = (await findByTestId('pending-gate-reject-btn')) as HTMLButtonElement;
    await waitFor(() => expect(rejectBtnAfterSwap.disabled).toBe(false));
    resolveApprove({});
  });

  it('merges gate-data events that fire during the initial fetch', async () => {
    // Regression: previously the subscription was registered AFTER awaiting
    // listGateData, so updates pushed during the fetch window were dropped.
    workflowsSignal.value = [makeWorkflow([approvalGate('g1')])];
    let resolveFetch: (v: unknown) => void = () => {};
    const pendingFetch = new Promise((resolve) => {
      resolveFetch = resolve;
    });
    mockRequest.mockImplementation((method: string) => {
      if (method === 'spaceWorkflowRun.listGateData') return pendingFetch;
      return Promise.resolve({});
    });
    let emittedEvent: ((payload: unknown) => void) | undefined;
    mockOnEvent.mockImplementation((_name: string, handler: (payload: unknown) => void) => {
      emittedEvent = handler;
      return () => {};
    });

    const { findByTestId, queryByTestId } = render(
      <PendingGateBanner runId="r1" spaceId="s1" workflowId="wf-1" />
    );
    await waitFor(() => expect(emittedEvent).toBeDefined());
    // Push an event BEFORE the fetch resolves — this data carries
    // `approved: true` so the gate should no longer be waiting_human.
    emittedEvent!({ runId: 'r1', gateId: 'g1', data: { approved: true } });
    // Now resolve the fetch with a stale snapshot (no data yet).
    resolveFetch({ gateData: [] });
    // The banner must NOT appear: the event's approved=true wins over the
    // empty fetch snapshot. If the race is present, the fetch overwrites
    // the event and the gate shows as pending.
    await waitFor(() => expect(queryByTestId('pending-gate-banner')).toBeNull());
    // Sanity: fetch-error banner should not appear either.
    expect(queryByTestId('pending-gate-fetch-error')).toBeNull();
    // Suppress unused warning for findByTestId.
    void findByTestId;
  });

  it('closing overlay restores focus to the opening Review button', async () => {
    workflowsSignal.value = [makeWorkflow([approvalGate('g1')])];
    mockRequest.mockResolvedValue({
      gateData: [{ runId: 'r1', gateId: 'g1', data: {}, updatedAt: 0 }],
    });
    const { findByTestId, queryByTestId, getByTestId } = render(
      <PendingGateBanner runId="r1" spaceId="s1" workflowId="wf-1" />
    );
    const reviewBtn = (await findByTestId('pending-gate-review-btn')) as HTMLButtonElement;
    reviewBtn.focus();
    expect(document.activeElement).toBe(reviewBtn);
    fireEvent.click(reviewBtn);
    expect(getByTestId('pending-gate-review-overlay')).toBeTruthy();
    // Close via Escape
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(queryByTestId('pending-gate-review-overlay')).toBeNull());
    // Focus must be restored to the opener
    expect(document.activeElement).toBe(reviewBtn);
  });
});
