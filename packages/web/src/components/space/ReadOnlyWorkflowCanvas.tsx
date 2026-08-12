/**
 * ReadOnlyWorkflowCanvas
 *
 * Read-only runtime view of a workflow using the visual-editor's WorkflowCanvas.
 * Shows the same visual style as the full editor but with no editing affordances.
 *
 * Used in SpaceTaskPane to replace the old custom SVG WorkflowCanvas.
 */

import { useRef, useEffect, useState, useCallback } from 'preact/hooks';
import { WorkflowCanvas } from './visual-editor/WorkflowCanvas';
import { CanvasToolbar } from './visual-editor/CanvasToolbar';
import { useRuntimeCanvasData } from './useRuntimeCanvasData';
import { ChannelInfoPanel } from './ChannelInfoPanel';
import { cn } from '../../lib/utils';

interface ReadOnlyWorkflowCanvasProps {
  workflowId: string;
  runId?: string | null;
  spaceId?: string;
  onNodeClick?: (nodeId: string, nodeName: string, agentNames: string[]) => void;
  class?: string;
}

export function ReadOnlyWorkflowCanvas({
  workflowId,
  runId,
  onNodeClick,
  class: className,
}: ReadOnlyWorkflowCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerSize, setContainerSize] = useState({ width: 800, height: 600 });
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(null);

  // Reset transient UI state whenever the run or workflow the canvas is
  // displaying changes, so a stale channel selection does not survive a swap.
  useEffect(() => {
    setSelectedChannelId(null);
  }, [runId, workflowId]);

  const { nodeData, channelEdges, canvasNodePositions, viewportState, setViewportState } =
    useRuntimeCanvasData(workflowId, runId ?? null);

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
      // Clicking a node clears channel selection
      setSelectedChannelId(null);
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
  }, []);

  const selectedChannel = selectedChannelId
    ? (channelEdges.find((c) => c.id === selectedChannelId) ?? null)
    : null;

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
            onClose={() => setSelectedChannelId(null)}
          />
        )}
      </div>
    </div>
  );
}
