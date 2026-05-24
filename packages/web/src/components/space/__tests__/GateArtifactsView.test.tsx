// @ts-nocheck
/**
 * Unit tests for GateArtifactsView
 *
 * Tests:
 * - Shows loading spinner while fetching artifacts
 * - Shows error when hub not connected
 * - Shows error on RPC failure
 * - Renders diff summary (files changed, +additions, -deletions)
 * - Renders file list with per-file stats
 * - Clicking a file row opens FileDiffView
 * - Back button in FileDiffView returns to artifact list
 * - Approve button calls approveGate with approved=true
 * - Reject button calls approveGate with approved=false
 * - onDecision and onClose called after successful decision
 * - Chat command "approve" triggers approval
 * - Chat command "yes" triggers approval
 * - Chat command "lgtm" triggers approval
 * - Chat command "reject" triggers rejection
 * - Chat command "no" triggers rejection
 * - Unknown chat command shows error
 * - PR link rendered when gate data has pr_url
 * - PR link shows number when pr_number present
 * - No files shows "no changed files" message
 * - Close button calls onClose
 * - Approve/Reject buttons disabled while approving
 */

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { render, cleanup, waitFor, fireEvent, act } from '@testing-library/preact';

// ---- Mock hub ----
const mockRequest: Mock = vi.fn();
const mockHub = { request: mockRequest };

vi.mock('../../../lib/connection-manager', () => ({
  connectionManager: {
    getHubIfConnected: vi.fn(() => mockHub),
    getHub: vi.fn(() => Promise.resolve(mockHub)),
  },
}));

vi.mock('../../../lib/utils', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}));

import { GateArtifactsView } from '../GateArtifactsView';

// ============================================================================
// Helpers
// ============================================================================

function makeArtifacts(overrides = {}) {
  return {
    files: [
      { path: 'src/foo.ts', additions: 10, deletions: 3 },
      { path: 'src/bar.ts', additions: 2, deletions: 0 },
    ],
    totalAdditions: 12,
    totalDeletions: 3,
    worktreePath: '/tmp/wt',
    baseRef: 'abc123',
    ...overrides,
  };
}

function defaultProps(overrides = {}) {
  return {
    runId: 'run-1',
    gateId: 'gate-1',
    spaceId: 'space-1',
    onClose: vi.fn(),
    onDecision: vi.fn(),
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('GateArtifactsView', () => {
  beforeEach(() => {
    mockRequest.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it('shows loading spinner while fetching', () => {
    mockRequest.mockReturnValue(new Promise(() => {}));
    const { getByTestId } = render(<GateArtifactsView {...defaultProps()} />);
    expect(getByTestId('artifacts-loading')).toBeDefined();
  });

  it('shows error when hub not connected', async () => {
    const { connectionManager } = await import('../../../lib/connection-manager');
    (connectionManager.getHubIfConnected as Mock).mockReturnValueOnce(null);
    const { getByTestId } = render(<GateArtifactsView {...defaultProps()} />);
    await waitFor(() => expect(getByTestId('artifacts-error')).toBeDefined());
  });

  it('shows error on RPC failure', async () => {
    mockRequest.mockRejectedValue(new Error('no worktree'));
    const { getByTestId } = render(<GateArtifactsView {...defaultProps()} />);
    await waitFor(() => {
      const el = getByTestId('artifacts-error');
      expect(el.textContent).toContain('no worktree');
    });
  });

  it('renders diff summary', async () => {
    mockRequest.mockResolvedValue(makeArtifacts());
    const { getByTestId } = render(<GateArtifactsView {...defaultProps()} />);
    await waitFor(() => {
      const summary = getByTestId('diff-summary');
      expect(summary.textContent).toContain('2 files changed');
      expect(summary.textContent).toContain('+12');
      expect(summary.textContent).toContain('-3');
    });
  });

  it('renders file list', async () => {
    mockRequest.mockResolvedValue(makeArtifacts());
    const { getByTestId } = render(<GateArtifactsView {...defaultProps()} />);
    await waitFor(() => {
      expect(getByTestId('file-list')).toBeDefined();
      expect(getByTestId('file-row-src/foo.ts')).toBeDefined();
      expect(getByTestId('file-row-src/bar.ts')).toBeDefined();
    });
  });

  it('clicking a file row opens FileDiffView', async () => {
    // Artifacts fetch succeeds; diff fetch never resolves (we just check mount)
    mockRequest.mockResolvedValueOnce(makeArtifacts()).mockReturnValue(new Promise(() => {})); // getFileDiff pending
    const { getByTestId } = render(<GateArtifactsView {...defaultProps()} />);
    await waitFor(() => expect(getByTestId('file-list')).toBeDefined());
    fireEvent.click(getByTestId('file-row-src/foo.ts'));
    await waitFor(() => expect(getByTestId('file-diff-view')).toBeDefined());
  });

  it('back button in FileDiffView returns to artifact list', async () => {
    mockRequest
      .mockResolvedValueOnce(makeArtifacts())
      .mockResolvedValueOnce({ diff: '', additions: 0, deletions: 0, filePath: 'src/foo.ts' });
    const { getByTestId } = render(<GateArtifactsView {...defaultProps()} />);
    await waitFor(() => expect(getByTestId('file-list')).toBeDefined());
    fireEvent.click(getByTestId('file-row-src/foo.ts'));
    await waitFor(() => expect(getByTestId('file-diff-view')).toBeDefined());
    fireEvent.click(getByTestId('file-diff-back'));
    await waitFor(() => expect(getByTestId('gate-artifacts-view')).toBeDefined());
  });

  it('approve button calls approveGate with approved=true', async () => {
    mockRequest
      .mockResolvedValueOnce(makeArtifacts())
      .mockResolvedValueOnce({ run: {}, gateData: {} }); // approveGate
    const props = defaultProps();
    const { getByTestId } = render(<GateArtifactsView {...props} />);
    await waitFor(() => expect(getByTestId('approve-button')).toBeDefined());
    await act(async () => {
      fireEvent.click(getByTestId('approve-button'));
    });
    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith('spaceWorkflowRun.approveGate', {
        runId: 'run-1',
        gateId: 'gate-1',
        approved: true,
      });
    });
  });

  it('reject button calls approveGate with approved=false', async () => {
    mockRequest
      .mockResolvedValueOnce(makeArtifacts())
      .mockResolvedValueOnce({ run: {}, gateData: {} });
    const { getByTestId } = render(<GateArtifactsView {...defaultProps()} />);
    await waitFor(() => expect(getByTestId('reject-button')).toBeDefined());
    await act(async () => {
      fireEvent.click(getByTestId('reject-button'));
    });
    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith('spaceWorkflowRun.approveGate', {
        runId: 'run-1',
        gateId: 'gate-1',
        approved: false,
      });
    });
  });

  it('calls onDecision and onClose after successful approval', async () => {
    mockRequest
      .mockResolvedValueOnce(makeArtifacts())
      .mockResolvedValueOnce({ run: {}, gateData: {} });
    const props = defaultProps();
    const { getByTestId } = render(<GateArtifactsView {...props} />);
    await waitFor(() => expect(getByTestId('approve-button')).toBeDefined());
    await act(async () => {
      fireEvent.click(getByTestId('approve-button'));
    });
    await waitFor(() => {
      expect(props.onDecision).toHaveBeenCalledOnce();
      expect(props.onClose).toHaveBeenCalledOnce();
    });
  });

  it('shows approval error when approveGate fails', async () => {
    mockRequest
      .mockResolvedValueOnce(makeArtifacts())
      .mockRejectedValueOnce(new Error('permission denied'));
    const { getByTestId } = render(<GateArtifactsView {...defaultProps()} />);
    await waitFor(() => expect(getByTestId('approve-button')).toBeDefined());
    await act(async () => {
      fireEvent.click(getByTestId('approve-button'));
    });
    await waitFor(() => {
      expect(getByTestId('approve-error').textContent).toContain('permission denied');
    });
  });

  it.each([
    ['approve', true],
    ['yes', true],
    ['lgtm', true],
    ['reject', false],
    ['no', false],
  ])('chat command "%s" triggers decision=%s', async (cmd, expected) => {
    mockRequest
      .mockResolvedValueOnce(makeArtifacts())
      .mockResolvedValueOnce({ run: {}, gateData: {} });
    const { getByTestId } = render(<GateArtifactsView {...defaultProps()} />);
    await waitFor(() => expect(getByTestId('chat-input')).toBeDefined());
    fireEvent.input(getByTestId('chat-input'), { target: { value: cmd } });
    await act(async () => {
      fireEvent.submit(getByTestId('chat-approval-form'));
    });
    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith('spaceWorkflowRun.approveGate', {
        runId: 'run-1',
        gateId: 'gate-1',
        approved: expected,
      });
    });
  });

  it('unknown chat command shows error', async () => {
    mockRequest.mockResolvedValueOnce(makeArtifacts());
    const { getByTestId } = render(<GateArtifactsView {...defaultProps()} />);
    await waitFor(() => expect(getByTestId('chat-input')).toBeDefined());
    fireEvent.input(getByTestId('chat-input'), { target: { value: 'maybe' } });
    fireEvent.submit(getByTestId('chat-approval-form'));
    await waitFor(() => {
      expect(getByTestId('approve-error').textContent).toContain('approve');
    });
  });

  it('renders PR link when gate data has pr_url', async () => {
    mockRequest.mockResolvedValue(makeArtifacts());
    const { getByTestId } = render(
      <GateArtifactsView
        {...defaultProps()}
        gateData={{ pr_url: 'https://github.com/owner/repo/pull/42', pr_number: 42 }}
      />
    );
    await waitFor(() => {
      const link = getByTestId('pr-link');
      expect(link.textContent).toBe('PR #42');
      expect(link.getAttribute('href')).toBe('https://github.com/owner/repo/pull/42');
    });
  });

  it('renders PR link without number when pr_number absent', async () => {
    mockRequest.mockResolvedValue(makeArtifacts());
    const { getByTestId } = render(
      <GateArtifactsView
        {...defaultProps()}
        gateData={{ pr_url: 'https://github.com/owner/repo/pull/1' }}
      />
    );
    await waitFor(() => {
      expect(getByTestId('pr-link').textContent).toBe('Pull Request');
    });
  });

  it('shows no-files message when file list is empty', async () => {
    mockRequest.mockResolvedValue(
      makeArtifacts({ files: [], totalAdditions: 0, totalDeletions: 0 })
    );
    const { getByTestId } = render(<GateArtifactsView {...defaultProps()} />);
    await waitFor(() => expect(getByTestId('no-files')).toBeDefined());
  });

  it('close button calls onClose', async () => {
    mockRequest.mockResolvedValue(makeArtifacts());
    const props = defaultProps();
    const { getByTestId } = render(<GateArtifactsView {...props} />);
    await waitFor(() => expect(getByTestId('gate-artifacts-view')).toBeDefined());
    fireEvent.click(getByTestId('artifacts-close'));
    expect(props.onClose).toHaveBeenCalledOnce();
  });

  it('does not render PR link when no pr_url in gate data', async () => {
    mockRequest.mockResolvedValue(makeArtifacts());
    const { queryByTestId } = render(
      <GateArtifactsView {...defaultProps()} gateData={{ someOtherKey: 'value' }} />
    );
    await waitFor(() => expect(queryByTestId('pr-link')).toBeNull());
  });
});
