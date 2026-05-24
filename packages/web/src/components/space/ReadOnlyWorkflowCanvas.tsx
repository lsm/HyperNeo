/**
 * ReadOnlyWorkflowCanvas
 *
 * Read-only runtime view of a workflow using the visual-editor's WorkflowCanvas.
 * Shows the same visual style as the full editor but with no editing affordances.
 *
 * Used in SpaceTaskPane to replace the old custom SVG WorkflowCanvas.
 *
 * When a gate icon in `waiting_human` state is clicked, a popup appears with
 * "View Artifacts", "Approve", and "Reject" buttons. "View Artifacts" opens a
 * full overlay containing GateArtifactsView.
 */

import { useRef, useEffect, useState, useCallback } from 'preact/hooks';
import { WorkflowCanvas } from './visual-editor/WorkflowCanvas';
import { CanvasToolbar } from './visual-editor/CanvasToolbar';
import { useRuntimeCanvasData } from './useRuntimeCanvasData';
import { ChannelInfoPanel } from './ChannelInfoPanel';
import { GateArtifactsView } from './GateArtifactsView';
import { connectionManager } from '../../lib/connection-manager';
import { cn } from '../../lib/utils';

interface ReadOnlyWorkflowCanvasProps {
  workflowId: string;
  runId?: string | null;
  spaceId?: string;
  onNodeClick?: (nodeId: string, nodeName: string, agentNames: string[]) => void;
  class?: string;
}

interface GatePopupState {
  gateId: string;
  x: number;
  y: number;
}

export function ReadOnlyWorkflowCanvas({
  workflowId,
  runId,
  spaceId,
  onNodeClick,
  class: className,
}: ReadOnlyWorkflowCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerSize, setContainerSize] = useState({ width: 800, height: 600 });
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(null);

  // Gate popup / overlay state
  const [gatePopup, setGatePopup] = useState<GatePopupState | null>(null);
  const [artifactsOverlay, setArtifactsOverlay] = useState<{ gateId: string } | null>(null);
  // Per-gate in-flight set so approving one gate never disables another gate's
  // buttons — previously a single boolean disabled every decision affordance
  // in the canvas while any RPC was pending.
  const [approvingGateIds, setApprovingGateIds] = useState<Set<string>>(() => new Set());
  const [channelDecisionError, setChannelDecisionError] = useState<string | null>(null);
  const [popupDecisionError, setPopupDecisionError] = useState<string | null>(null);

  // Reset transient UI state whenever the run or workflow the canvas is
  // displaying changes. Without this, a gate popup, artifacts overlay, or
  // in-flight approving entry from the prior run remains mounted after
  // swap — clicking Approve would then POST a gateId that doesn't exist in
  // the new run and the server returns an error.
  useEffect(() => {
    setGatePopup(null);
    setArtifactsOverlay(null);
    setApprovingGateIds(new Set());
    setSelectedChannelId(null);
    setChannelDecisionError(null);
    setPopupDecisionError(null);
  }, [runId, workflowId]);

  const {
    nodeData,
    channelEdges,
    canvasNodePositions,
    viewportState,
    setViewportState,
    gateDataLoading,
    gateDataMap,
    gateDataError,
    retryGateData,
  } = useRuntimeCanvasData(workflowId, runId ?? null);

  // Track container dimensions for the toolbar's fit-to-view
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) {
        setContainerSize({
          width: entry.contentRect.width,
          height: entry.contentRect.height,
        });
      }
    });

    observer.observe(el);
    setContainerSize({ width: el.clientWidth, height: el.clientHeight });

    return () => observer.disconnect();
  }, []);

  const handleNodeSelect = useCallback(
    (stepId: string | null) => {
      // Clicking a node clears channel selection and gate popup
      setSelectedChannelId(null);
      setGatePopup(null);
      if (!stepId || !onNodeClick) return;
      // stepId is localId — find the persisted node ID, name, and agent names
      const nodeEntry = nodeData.find((n) => n.step.localId === stepId);
      const persistedId = nodeEntry?.step.id ?? stepId;
      const nodeName = nodeEntry?.step.name ?? '';
      const agentNames = nodeEntry?.step.agents?.map((a) => a.name) ?? [];
      onNodeClick(persistedId, nodeName, agentNames);
    },
    [onNodeClick, nodeData]
  );

  const handleChannelSelect = useCallback((channelId: string | null) => {
    setSelectedChannelId(channelId);
    setGatePopup(null);
    setChannelDecisionError(null);
  }, []);

  // Gate icon click — open action popup
  const handleGateClick = useCallback((gateId: string, event: MouseEvent) => {
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    setGatePopup({
      gateId,
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    });
    setSelectedChannelId(null);
    setPopupDecisionError(null);
  }, []);

  const approveGateRequest = useCallback(
    async (gateId: string, approved: boolean): Promise<{ ok: boolean; error?: string }> => {
      if (!runId) return { ok: false, error: 'Missing run ID' };
      setApprovingGateIds((prev) => {
        const next = new Set(prev);
        next.add(gateId);
        return next;
      });
      try {
        const hub = await connectionManager.getHub();
        await hub.request('spaceWorkflowRun.approveGate', {
          runId,
          gateId,
          approved,
        });
        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : 'Failed to submit decision',
        };
      } finally {
        setApprovingGateIds((prev) => {
          if (!prev.has(gateId)) return prev;
          const next = new Set(prev);
          next.delete(gateId);
          return next;
        });
      }
    },
    [runId]
  );

  // Direct approve/reject from popup
  const handlePopupDecision = useCallback(
    async (approved: boolean) => {
      if (!gatePopup) return;
      setPopupDecisionError(null);
      const result = await approveGateRequest(gatePopup.gateId, approved);
      if (result.ok) {
        setGatePopup(null);
        setPopupDecisionError(null);
      } else {
        setPopupDecisionError(result.error ?? 'Failed to submit decision');
      }
    },
    [gatePopup, approveGateRequest]
  );

  // Approve/reject from inline channel info panel
  const handleChannelGateDecision = useCallback(
    async (gateId: string, approved: boolean) => {
      setChannelDecisionError(null);
      const result = await approveGateRequest(gateId, approved);
      if (result.ok) {
        setSelectedChannelId(null);
      } else {
        setChannelDecisionError(result.error ?? 'Failed to submit decision');
      }
    },
    [approveGateRequest]
  );

  // Tracks the element that opened the artifacts overlay so focus can be
  // restored to it on close (WCAG 2.4.3). We capture `event.currentTarget`
  // from the triggering click — `document.activeElement` is unreliable here
  // because Safari and Firefox don't move focus to buttons on click. Mirrors
  // PendingGateBanner's pattern for consistency. If the opener unmounts
  // while the overlay is open (e.g. approve/reject clears the popup or
  // ChannelInfoPanel context), we fall back to the canvas container.
  const overlayOpenerRef = useRef<HTMLElement | null>(null);

  // Open artifacts overlay directly from channel info panel
  const handleChannelViewArtifacts = useCallback((gateId: string, event: Event) => {
    const target = event.currentTarget;
    overlayOpenerRef.current = target instanceof HTMLElement ? target : null;
    setArtifactsOverlay({ gateId });
  }, []);

  // Open artifacts overlay from popup
  const handleOpenArtifacts = useCallback(
    (event: MouseEvent) => {
      if (!gatePopup) return;
      const target = event.currentTarget;
      overlayOpenerRef.current = target instanceof HTMLElement ? target : null;
      setArtifactsOverlay({ gateId: gatePopup.gateId });
      setGatePopup(null);
    },
    [gatePopup]
  );

  // Close artifacts overlay after decision
  const handleArtifactsDecision = useCallback(() => {
    setArtifactsOverlay(null);
  }, []);

  // Close the artifacts overlay on Escape — matches PendingGateBanner's twin.
  useEffect(() => {
    if (!artifactsOverlay) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setArtifactsOverlay(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [artifactsOverlay]);

  // Restore focus to the overlay opener when the overlay closes. If the
  // opener was detached (e.g. the popup closed when the overlay opened, or
  // the channel info panel collapsed), fall back to the canvas container so
  // focus doesn't collapse to <body>.
  useEffect(() => {
    if (artifactsOverlay) return;
    const opener = overlayOpenerRef.current;
    if (!opener) return;
    if (opener.isConnected && typeof opener.focus === 'function') {
      opener.focus();
    } else if (containerRef.current && typeof containerRef.current.focus === 'function') {
      containerRef.current.focus();
    }
    overlayOpenerRef.current = null;
  }, [artifactsOverlay]);

  const selectedChannel = selectedChannelId
    ? (channelEdges.find((c) => c.id === selectedChannelId) ?? null)
    : null;

  // Show a banner when a human-approval gate has been rejected (approved === false).
  const isWorkflowRejected = [...gateDataMap.values()].some((data) => data['approved'] === false);

  // Resolve node names for the info panel
  const getNodeName = (stepLocalId: string): string => {
    const node = nodeData.find((n) => n.step.localId === stepLocalId);
    return node?.step.name ?? stepLocalId;
  };

  return (
    <div
      class={cn('relative flex flex-col h-full', className)}
      data-testid="workflow-canvas"
      data-mode="runtime"
    >
      {gateDataLoading && (
        <div class="absolute top-2 right-2 z-10 text-xs text-gray-500 px-2 py-0.5 bg-dark-800 rounded">
          Loading…
        </div>
      )}
      {gateDataError && !gateDataLoading && (
        <div
          class="absolute top-2 right-2 z-10 flex items-center gap-2 text-xs px-2 py-0.5 bg-red-900/50 border border-red-700/50 text-red-200 rounded"
          data-testid="canvas-gate-data-error"
          title={gateDataError}
        >
          <span>Gate status unavailable</span>
          <button
            type="button"
            onClick={retryGateData}
            data-testid="canvas-gate-data-retry"
            class="underline hover:text-red-100"
          >
            Retry
          </button>
        </div>
      )}
      {isWorkflowRejected && (
        <div class="flex-shrink-0 flex items-center justify-center px-4 py-2 bg-red-900/80 border-b border-red-700/60 text-sm text-red-200">
          Workflow paused — awaiting approval
        </div>
      )}
      <div
        ref={containerRef}
        tabIndex={-1}
        class="flex-1 min-h-0 relative focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-400/70"
      >
        <WorkflowCanvas
          nodes={nodeData}
          viewportState={viewportState}
          onViewportChange={setViewportState}
          channels={channelEdges}
          nodePositions={canvasNodePositions}
          onNodeSelect={handleNodeSelect}
          onChannelSelect={handleChannelSelect}
          onGateClick={handleGateClick}
          selectedChannelId={selectedChannelId}
          readOnly
        />
        <CanvasToolbar
          viewport={viewportState}
          nodes={canvasNodePositions}
          viewportWidth={containerSize.width}
          viewportHeight={containerSize.height}
          onViewportChange={setViewportState}
        />
        {selectedChannel && (
          <ChannelInfoPanel
            channel={selectedChannel}
            fromNodeName={getNodeName(selectedChannel.fromStepId)}
            toNodeName={getNodeName(selectedChannel.toStepId)}
            onClose={() => {
              setSelectedChannelId(null);
              setChannelDecisionError(null);
            }}
            onGateDecision={handleChannelGateDecision}
            onViewArtifacts={handleChannelViewArtifacts}
            decisionPending={
              !!selectedChannel.gateId && approvingGateIds.has(selectedChannel.gateId)
            }
            decisionError={channelDecisionError}
          />
        )}

        {/* Gate action popup */}
        {gatePopup && (
          <div
            class="absolute z-30"
            style={{
              left: `${gatePopup.x}px`,
              top: `${gatePopup.y + 12}px`,
            }}
          >
            <div class="bg-dark-800 border border-dark-600 rounded-lg shadow-xl p-2 space-y-2 min-w-[160px]">
              <button
                data-testid="view-artifacts-btn"
                onClick={handleOpenArtifacts}
                class="w-full text-left px-3 py-1.5 text-xs text-gray-200 hover:bg-dark-700 rounded transition-colors"
              >
                View Artifacts
              </button>
              <div class="flex gap-2">
                <button
                  onClick={() => void handlePopupDecision(true)}
                  disabled={approvingGateIds.has(gatePopup.gateId)}
                  class="flex-1 px-2 py-1.5 text-xs font-medium rounded bg-green-900/40 text-green-300 border border-green-700/50 hover:bg-green-800/50 disabled:opacity-50 transition-colors"
                >
                  Approve
                </button>
                <button
                  data-testid="popup-reject-btn"
                  onClick={() => void handlePopupDecision(false)}
                  disabled={approvingGateIds.has(gatePopup.gateId)}
                  class="flex-1 px-2 py-1.5 text-xs font-medium rounded bg-red-900/40 text-red-300 border border-red-700/50 hover:bg-red-800/50 disabled:opacity-50 transition-colors"
                >
                  Reject
                </button>
              </div>
              {popupDecisionError && (
                <p class="text-xs text-red-400 break-words" data-testid="popup-decision-error">
                  {popupDecisionError}
                </p>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Artifacts panel overlay */}
      {artifactsOverlay && runId && (
        <div
          data-testid="artifacts-panel-overlay"
          class="absolute inset-0 z-40 bg-black/50 flex items-center justify-center"
          role="dialog"
          aria-modal="true"
          aria-label="Review gate artifacts"
          onClick={(e) => {
            if (e.target === e.currentTarget) setArtifactsOverlay(null);
          }}
        >
          <div class="w-full max-w-2xl max-h-[80vh] bg-dark-900 border border-dark-600 rounded-xl shadow-2xl overflow-hidden flex flex-col">
            <GateArtifactsView
              runId={runId}
              gateId={artifactsOverlay.gateId}
              spaceId={spaceId ?? ''}
              gateData={gateDataMap.get(artifactsOverlay.gateId)}
              onClose={() => setArtifactsOverlay(null)}
              onDecision={handleArtifactsDecision}
              class="flex-1 min-h-0"
            />
          </div>
        </div>
      )}
    </div>
  );
}
