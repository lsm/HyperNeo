/**
 * GateArtifactsView — shows changed files and diff summary for a workflow run gate.
 *
 * Fetches `spaceWorkflowRun.getGateArtifacts` and renders:
 *   - PR link (if available in gate data)
 *   - Diff summary: N files, +additions, -deletions
 *   - Clickable file tree → opens FileDiffView for the selected file
 *   - Approve / Reject primary action buttons
 *   - Chat-command input as secondary approval mechanism
 *     (accepts "approve" / "yes" / "lgtm" → approve, "reject" / "no" → reject)
 */

import { useState, useEffect, useCallback } from 'preact/hooks';
import { connectionManager } from '../../lib/connection-manager';
import { cn } from '../../lib/utils';
import { FileDiffView } from './FileDiffView';

// ============================================================================
// Types
// ============================================================================

export interface GateArtifactsViewProps {
  /** Workflow run ID */
  runId: string;
  /** Gate ID to approve/reject */
  gateId: string;
  /** Space ID (for future event filtering if needed) */
  spaceId: string;
  /** Current gate data — used to extract PR link */
  gateData?: Record<string, unknown>;
  /** Called when the panel should close */
  onClose?: () => void;
  /** Called after a successful approve or reject */
  onDecision?: () => void;
  class?: string;
}

interface FileDiffStat {
  path: string;
  additions: number;
  deletions: number;
}

interface GateArtifactsResult {
  files: FileDiffStat[];
  totalAdditions: number;
  totalDeletions: number;
  worktreePath?: string;
  baseRef?: string;
}

// ============================================================================
// Component
// ============================================================================

export function GateArtifactsView({
  runId,
  gateId,
  spaceId: _spaceId,
  gateData,
  onClose,
  onDecision,
  class: className,
}: GateArtifactsViewProps) {
  // ---- Artifacts fetch ----
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [artifacts, setArtifacts] = useState<GateArtifactsResult | null>(null);

  // ---- Selected file for diff view ----
  const [selectedFile, setSelectedFile] = useState<string | null>(null);

  // ---- Approval state ----
  const [approving, setApproving] = useState(false);
  const [approveError, setApproveError] = useState<string | null>(null);

  // ---- Chat command input ----
  const [chatInput, setChatInput] = useState('');

  // ---- Extract PR info from gate data ----
  const prUrl = typeof gateData?.pr_url === 'string' ? gateData.pr_url : null;
  const prNumber = typeof gateData?.pr_number === 'number' ? gateData.pr_number : null;
  // ---- Fetch artifacts ----
  useEffect(() => {
    setLoading(true);
    setFetchError(null);
    setArtifacts(null);

    const hub = connectionManager.getHubIfConnected();
    if (!hub) {
      setFetchError('Not connected');
      setLoading(false);
      return;
    }

    hub
      .request<GateArtifactsResult>('spaceWorkflowRun.getGateArtifacts', { runId })
      .then((result) => setArtifacts(result))
      .catch((err: unknown) => {
        setFetchError(err instanceof Error ? err.message : 'Failed to load artifacts');
      })
      .finally(() => setLoading(false));
  }, [runId]);

  // ---- Approve / Reject handler ----
  const handleDecision = useCallback(
    async (approved: boolean) => {
      setApproving(true);
      setApproveError(null);
      try {
        const hub = await connectionManager.getHub();
        await hub.request('spaceWorkflowRun.approveGate', { runId, gateId, approved });
        onDecision?.();
        onClose?.();
      } catch (err: unknown) {
        setApproveError(err instanceof Error ? err.message : 'Failed to submit decision');
      } finally {
        setApproving(false);
      }
    },
    [runId, gateId, onDecision, onClose]
  );

  // ---- Chat command handler ----
  const handleChatSubmit = (e: Event) => {
    e.preventDefault();
    const cmd = chatInput.trim().toLowerCase();
    if (cmd === 'approve' || cmd === 'yes' || cmd === 'lgtm') {
      setChatInput('');
      void handleDecision(true);
    } else if (cmd === 'reject' || cmd === 'no') {
      setChatInput('');
      void handleDecision(false);
    } else {
      setApproveError('Type "approve" or "reject" to submit your decision');
    }
  };

  // ---- If a file is selected, show FileDiffView ----
  if (selectedFile) {
    return (
      <FileDiffView
        runId={runId}
        filePath={selectedFile}
        onBack={() => setSelectedFile(null)}
        class={className}
      />
    );
  }

  // ---- Main view ----
  return (
    <div
      class={cn('flex flex-col h-full overflow-hidden', className)}
      data-testid="gate-artifacts-view"
    >
      {/* Header */}
      <div class="flex items-center justify-between px-4 py-3 border-b border-dark-700 flex-shrink-0 bg-dark-850">
        <div>
          <h2 class="text-sm font-semibold text-gray-100">Review Changes</h2>
          <p class="text-xs text-gray-500 mt-0.5">Approve or reject the proposed changes</p>
        </div>
        {onClose && (
          <button
            onClick={onClose}
            class="text-gray-600 hover:text-gray-400 transition-colors flex-shrink-0 ml-3"
            aria-label="Close"
            data-testid="artifacts-close"
          >
            <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        )}
      </div>

      {/* Scrollable body */}
      <div class="flex-1 overflow-y-auto min-h-0">
        {/* Loading */}
        {loading && (
          <div class="flex items-center justify-center h-32" data-testid="artifacts-loading">
            <div class="w-5 h-5 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
          </div>
        )}

        {/* Fetch error */}
        {fetchError && !loading && (
          <div class="px-4 py-4" data-testid="artifacts-error">
            <p class="text-sm text-red-400">{fetchError}</p>
          </div>
        )}

        {/* Artifacts content */}
        {!loading && !fetchError && artifacts && (
          <div class="p-4 space-y-4">
            {/* PR link */}
            {prUrl && (
              <div class="flex items-center gap-2 p-3 bg-blue-950/30 border border-blue-800/40 rounded-lg">
                <svg
                  class="w-4 h-4 text-blue-400 flex-shrink-0"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    stroke-width={2}
                    d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
                  />
                </svg>
                <a
                  href={prUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  class="text-xs text-blue-400 hover:text-blue-300 transition-colors"
                  data-testid="pr-link"
                >
                  {prNumber != null ? `PR #${prNumber}` : 'Pull Request'}
                </a>
              </div>
            )}

            {/* Diff summary */}
            <div class="flex items-center gap-4 text-xs" data-testid="diff-summary">
              <span class="text-gray-400">
                {artifacts.files.length} {artifacts.files.length === 1 ? 'file' : 'files'} changed
              </span>
              <span class="text-green-400 font-mono">+{artifacts.totalAdditions}</span>
              <span class="text-red-400 font-mono">-{artifacts.totalDeletions}</span>
            </div>

            {/* File tree */}
            {artifacts.files.length === 0 ? (
              <p class="text-sm text-gray-500" data-testid="no-files">
                No changed files found
              </p>
            ) : (
              <div class="space-y-0.5" data-testid="file-list">
                {artifacts.files.map((file) => (
                  <button
                    key={file.path}
                    onClick={() => setSelectedFile(file.path)}
                    class={cn(
                      'w-full flex items-center gap-3 px-3 py-2 rounded text-left',
                      'hover:bg-dark-700 transition-colors group'
                    )}
                    data-testid={`file-row-${file.path}`}
                  >
                    {/* File icon */}
                    <svg
                      class="w-3.5 h-3.5 text-gray-500 flex-shrink-0"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                    >
                      <path
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        stroke-width={2}
                        d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                      />
                    </svg>
                    {/* Path */}
                    <span
                      class="flex-1 text-xs font-mono text-gray-300 truncate min-w-0 group-hover:text-gray-100"
                      title={file.path}
                    >
                      {file.path}
                    </span>
                    {/* Stats */}
                    <span class="flex-shrink-0 flex items-center gap-1.5 text-xs font-mono">
                      <span class="text-green-400">+{file.additions}</span>
                      <span class="text-red-400">-{file.deletions}</span>
                    </span>
                    {/* Chevron */}
                    <svg
                      class="w-3 h-3 text-gray-600 flex-shrink-0 group-hover:text-gray-400"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                    >
                      <path
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        stroke-width={2}
                        d="M9 5l7 7-7 7"
                      />
                    </svg>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Footer: primary approve/reject + chat command */}
      <div class="flex-shrink-0 border-t border-dark-700 p-4 space-y-3 bg-dark-850">
        {approveError && (
          <p class="text-xs text-red-400" data-testid="approve-error">
            {approveError}
          </p>
        )}

        {/* Primary buttons */}
        <div class="flex gap-3">
          <button
            onClick={() => void handleDecision(true)}
            disabled={approving}
            data-testid="approve-button"
            class={cn(
              'flex-1 py-2 text-sm font-medium rounded-lg transition-colors',
              'bg-green-900/40 text-green-300 border border-green-700/50',
              'hover:bg-green-800/50 disabled:opacity-50 disabled:cursor-not-allowed'
            )}
          >
            {approving ? 'Submitting…' : 'Approve'}
          </button>
          <button
            onClick={() => void handleDecision(false)}
            disabled={approving}
            data-testid="reject-button"
            class={cn(
              'flex-1 py-2 text-sm font-medium rounded-lg transition-colors',
              'bg-red-900/40 text-red-300 border border-red-700/50',
              'hover:bg-red-800/50 disabled:opacity-50 disabled:cursor-not-allowed'
            )}
          >
            {approving ? 'Submitting…' : 'Reject'}
          </button>
        </div>

        {/* Chat-based secondary mechanism */}
        <form
          onSubmit={handleChatSubmit}
          class="flex items-center gap-2"
          data-testid="chat-approval-form"
        >
          <input
            type="text"
            value={chatInput}
            onInput={(e) => setChatInput((e.target as HTMLInputElement).value)}
            placeholder='Type "approve" or "reject"'
            disabled={approving}
            data-testid="chat-input"
            class={cn(
              'flex-1 bg-dark-800 border border-dark-600 rounded-md px-3 py-1.5 text-xs text-gray-100',
              'placeholder-gray-600 focus:outline-none focus:border-gray-500',
              'disabled:opacity-50'
            )}
          />
          <button
            type="submit"
            disabled={!chatInput.trim() || approving}
            data-testid="chat-submit"
            class={cn(
              'px-3 py-1.5 text-xs font-medium rounded-md transition-colors flex-shrink-0',
              'bg-dark-700 text-gray-300 border border-dark-600',
              'hover:bg-dark-600 disabled:opacity-50 disabled:cursor-not-allowed'
            )}
          >
            Send
          </button>
        </form>
      </div>
    </div>
  );
}
