// @ts-nocheck
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, waitFor, cleanup } from '@testing-library/preact';

const mockGetExternalEventQueueHealth = vi.fn();

vi.mock('../../../lib/space-store', () => ({
  spaceStore: {
    get getExternalEventQueueHealth() {
      return mockGetExternalEventQueueHealth;
    },
  },
}));

vi.mock('../../ui/Button', () => ({
  Button: ({ children, onClick, type, loading }) => (
    <button type={type ?? 'button'} onClick={onClick} disabled={loading}>
      {loading ? 'Loading...' : children}
    </button>
  ),
}));

import { QueueHealthSummary } from '../QueueHealthSummary';

const sampleSnapshot = {
  collectedAt: Date.now(),
  counters: {
    since: Date.now() - 60_000,
    enqueue: 5,
    enqueueBySource: { github: 4, slack: 1 },
    enqueueByTargetState: { 'run=in_progress;node=pending': 5 },
    flushAttempts: 3,
    flushItemsDispatched: 4,
    delivered: 2,
    finalFailuresByReason: { ttl_expired: 1, pending_node_queue_overflow: 1 },
    claimConflicts: 1,
    staleSessionSkips: 2,
    pausedSpaceSkips: 0,
    cooldownSkips: 0,
    directSteerEnqueued: 0,
    directSteerSuppressedByBufferCap: 0,
    directSteerEnqueuedByClass: {},
  },
  failuresByCategory: {
    ttl_expired: 1,
    cap_eviction: 1,
    deliverability: 0,
    retry_exhausted: 0,
    injection_error: 0,
    other: 0,
  },
  gauges: {
    queueDepth: 2,
    queueKeys: 1,
    inFlight: 1,
    digestBacklog: 0,
    retryTimers: 1,
    persistedPending: 0,
    queueAgeMs: { count: 2, minMs: 1000, maxMs: 5000, avgMs: 3000, p95Ms: 5000 },
    persistedAgeMs: null,
  },
};

describe('QueueHealthSummary', () => {
  beforeEach(() => {
    cleanup();
    mockGetExternalEventQueueHealth.mockReset();
  });

  afterEach(() => cleanup());

  it('renders counters, gauges, and breakdowns from the snapshot', async () => {
    mockGetExternalEventQueueHealth.mockResolvedValue(sampleSnapshot);
    const { getByText, getAllByText, findByText, getByTestId } = render(<QueueHealthSummary />);

    await findByText('Queue health');
    expect(getByTestId('queue-health-summary')).toBeTruthy();
    await waitFor(() => {
      expect(getByText('github')).toBeTruthy();
      expect(getByText('slack')).toBeTruthy();
      expect(getAllByText('ttl_expired')).toHaveLength(2);
      expect(getByText('pending_node_queue_overflow')).toBeTruthy();
    });
    expect(mockGetExternalEventQueueHealth).toHaveBeenCalledTimes(1);
  });

  it('shows an error banner when the fetch rejects', async () => {
    mockGetExternalEventQueueHealth.mockRejectedValue(new Error('boom'));
    const { findByText } = render(<QueueHealthSummary />);

    expect(await findByText(/Failed to load queue health: boom/)).toBeTruthy();
  });

  it('re-fetches the snapshot when Refresh is clicked', async () => {
    mockGetExternalEventQueueHealth.mockResolvedValue(sampleSnapshot);
    const { findByText, getByText: getByTextSync } = render(<QueueHealthSummary />);

    await findByText('Queue health');
    fireEvent.click(getByTextSync('Refresh'));
    await waitFor(() => {
      expect(mockGetExternalEventQueueHealth).toHaveBeenCalledTimes(2);
    });
  });
});
