import { useEffect, useCallback, useRef } from 'preact/hooks';
import type { SpaceWorkerAgent, WorkflowChannel } from '@hyperneo/shared';
import type { NodeDraft, AgentTaskState } from '../WorkflowNodeCard';
import { isMultiAgentNode, AgentStatusIcon } from '../WorkflowNodeCard';
import type { Point } from './types';
import type { AnchorSide } from './semanticWorkflowGraph';
import { getVisualNodeDimensions } from './nodeMetrics';

export type PortType = 'input' | 'output';

export interface WorkflowNodeProps {
  stepIndex: number;
  step: NodeDraft;
  position: Point;
  agents: SpaceWorkerAgent[];
  workflowChannels?: WorkflowChannel[];
  isSelected?: boolean;
  isStartNode?: boolean;
  isEndNode?: boolean;
  scale: number;
  onPositionChange: (stepId: string, newPosition: Point) => void;
  onPortMouseDown?: (stepId: string, portType: PortType, e: MouseEvent, portEl: Element) => void;
  onPortMouseEnter?: (stepId: string, portType: PortType) => void;
  onPortMouseLeave?: (stepId: string, portType: PortType) => void;
  isDropTarget?: boolean;
  onClick?: (stepId: string) => void;
  nodeTaskStates?: AgentTaskState[];
  activeAnchorSides?: AnchorSide[];
  draggable?: boolean;
}

function renderDock(side: AnchorSide, visible: boolean, highlighted = false) {
  const commonStyle = {
    position: 'absolute' as const,
    width: 14,
    height: 14,
    borderRadius: '50%',
    border: `2px solid ${highlighted ? '#16a34a' : '#374151'}`,
    background: highlighted ? '#22c55e' : '#6b7280',
    zIndex: highlighted ? 10 : 5,
  };

  if (side === 'top') {
    return (
      <div
        data-testid="dock-top"
        style={{
          ...commonStyle,
          top: -7,
          left: '50%',
          transform: highlighted ? 'translateX(-50%) scale(1.4)' : 'translateX(-50%)',
          transition: 'transform 0.1s, background 0.1s, opacity 0.15s',
        }}
        class={visible ? 'opacity-100' : 'opacity-0 transition-opacity group-hover:opacity-100'}
      />
    );
  }

  if (side === 'bottom') {
    return (
      <div
        data-testid="dock-bottom"
        style={{
          ...commonStyle,
          bottom: -7,
          left: '50%',
          transform: 'translateX(-50%)',
          transition: 'opacity 0.15s',
        }}
        class={visible ? 'opacity-100' : 'opacity-0 transition-opacity group-hover:opacity-100'}
      />
    );
  }

  if (side === 'left') {
    return (
      <div
        data-testid="dock-left"
        style={{
          ...commonStyle,
          left: -7,
          top: '50%',
          transform: 'translateY(-50%)',
        }}
        class={visible ? 'opacity-100' : 'opacity-0'}
      />
    );
  }

  return (
    <div
      data-testid="dock-right"
      style={{
        ...commonStyle,
        right: -7,
        top: '50%',
        transform: 'translateY(-50%)',
      }}
      class={visible ? 'opacity-100' : 'opacity-0'}
    />
  );
}

export function WorkflowNode({
  stepIndex,
  step,
  position,
  agents,
  workflowChannels: _workflowChannels = [],
  isSelected = false,
  isStartNode = false,
  isEndNode = false,
  isDropTarget = false,
  scale,
  onPositionChange,
  onPortMouseDown,
  onPortMouseEnter,
  onPortMouseLeave,
  onClick,
  nodeTaskStates,
  activeAnchorSides = [],
  draggable = true,
}: WorkflowNodeProps) {
  const stepId = step.localId;
  const dimensions = getVisualNodeDimensions(step);

  const multi = isMultiAgentNode(step);
  const singleSlot =
    !multi && Array.isArray(step.agents) && step.agents.length === 1 ? step.agents[0] : null;
  const resolvedSingleAgentId = singleSlot?.agentId ?? step.agentId;
  const agentName =
    singleSlot?.name ??
    agents.find((a) => a.id === resolvedSingleAgentId)?.name ??
    resolvedSingleAgentId;

  const taskStateByAgent = new Map<string | null, AgentTaskState>(
    (nodeTaskStates ?? []).map((s) => [s.agentName, s])
  );

  const dragState = useRef<{
    startX: number;
    startY: number;
    origX: number;
    origY: number;
  } | null>(null);

  const hasDraggedRef = useRef(false);
  const DRAG_THRESHOLD = 3;

  const scaleRef = useRef(scale);
  scaleRef.current = scale;

  const onPositionChangeRef = useRef(onPositionChange);
  onPositionChangeRef.current = onPositionChange;

  const nodeRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!dragState.current) return;
      const dx = e.clientX - dragState.current.startX;
      const dy = e.clientY - dragState.current.startY;

      if (Math.abs(dx) <= DRAG_THRESHOLD && Math.abs(dy) <= DRAG_THRESHOLD) return;

      hasDraggedRef.current = true;

      const safeScale = Math.max(scaleRef.current, 0.01);
      const canvasDx = dx / safeScale;
      const canvasDy = dy / safeScale;
      onPositionChangeRef.current(stepId, {
        x: dragState.current.origX + canvasDx,
        y: dragState.current.origY + canvasDy,
      });
    };

    const onMouseUp = () => {
      if (!dragState.current) return;
      dragState.current = null;
      if (nodeRef.current) {
        nodeRef.current.style.cursor = 'grab';
        nodeRef.current.style.boxShadow = '';
      }
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, [stepId]);

  const handleMouseDown = useCallback(
    (e: MouseEvent) => {
      if (!draggable) {
        e.stopPropagation();
        return;
      }
      if (e.button !== 0) return;
      e.stopPropagation();
      e.preventDefault();

      hasDraggedRef.current = false;

      dragState.current = {
        startX: e.clientX,
        startY: e.clientY,
        origX: position.x,
        origY: position.y,
      };

      if (nodeRef.current) {
        nodeRef.current.style.cursor = 'grabbing';
        nodeRef.current.style.boxShadow = '0 8px 24px rgba(0,0,0,0.4)';
      }
    },
    [draggable, position.x, position.y]
  );

  const handleClick = useCallback(
    (e: MouseEvent) => {
      e.stopPropagation();
      if (hasDraggedRef.current) return;
      onClick?.(stepId);
    },
    [onClick, stepId]
  );

  const handleInputPortMouseDown = useCallback(
    (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      onPortMouseDown?.(stepId, 'input', e, e.currentTarget as Element);
    },
    [onPortMouseDown, stepId]
  );

  const handleOutputPortMouseDown = useCallback(
    (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      onPortMouseDown?.(stepId, 'output', e, e.currentTarget as Element);
    },
    [onPortMouseDown, stepId]
  );

  const stopClickPropagation = useCallback((e: MouseEvent) => {
    e.stopPropagation();
  }, []);

  const handleInputPortMouseEnter = useCallback(() => {
    onPortMouseEnter?.(stepId, 'input');
  }, [onPortMouseEnter, stepId]);

  const handleInputPortMouseLeave = useCallback(() => {
    onPortMouseLeave?.(stepId, 'input');
  }, [onPortMouseLeave, stepId]);

  const borderClass = isStartNode
    ? 'border-green-500'
    : isSelected
      ? 'border-blue-500'
      : 'border-gray-700';

  const bgClass = 'bg-gray-800';

  const inputPortBg = isDropTarget ? '#22c55e' : '#6b7280';
  const inputPortBorder = isDropTarget ? '#16a34a' : '#374151';
  const inputPortScale = isDropTarget ? 'scale(1.4)' : '';

  const ringClass = isSelected ? 'ring-2 ring-blue-500' : '';
  const hasActiveExecution = nodeTaskStates?.some((s) => s.status === 'in_progress') ?? false;
  const pulseClass = hasActiveExecution ? 'animate-pulse' : '';
  const activeAnchorSideSet = new Set(activeAnchorSides);

  return (
    <div
      ref={nodeRef}
      data-testid={`workflow-node-${stepId}`}
      data-step-id={stepId}
      style={{
        position: 'absolute',
        left: position.x,
        top: position.y,
        width: dimensions.width,
        minHeight: dimensions.height,
        cursor: draggable ? 'grab' : 'default',
        userSelect: 'none',
      }}
      class={`group rounded-lg border-2 ${bgClass} ${borderClass} ${ringClass} ${pulseClass}`}
      onMouseDown={handleMouseDown}
      onClick={handleClick}
    >
      {activeAnchorSideSet.has('left') && renderDock('left', true)}
      {activeAnchorSideSet.has('right') && renderDock('right', true)}

      {(!isStartNode || activeAnchorSideSet.has('top')) && (
        <div
          data-testid="port-input"
          style={{
            position: 'absolute',
            top: -7,
            left: '50%',
            transform: `translateX(-50%) ${inputPortScale}`,
            width: 14,
            height: 14,
            borderRadius: '50%',
            background: inputPortBg,
            border: `2px solid ${inputPortBorder}`,
            cursor: 'crosshair',
            transition: 'transform 0.1s, background 0.1s, opacity 0.15s',
            zIndex: isDropTarget ? 10 : 6,
          }}
          class={
            isDropTarget || activeAnchorSideSet.has('top')
              ? 'opacity-100'
              : 'opacity-0 transition-opacity group-hover:opacity-100'
          }
          onMouseDown={!isStartNode ? handleInputPortMouseDown : undefined}
          onMouseEnter={!isStartNode ? handleInputPortMouseEnter : undefined}
          onMouseLeave={!isStartNode ? handleInputPortMouseLeave : undefined}
          onClick={stopClickPropagation}
        />
      )}

      <div class="px-3 py-2">
        <div class="flex items-center justify-between mb-1">
          <span
            data-testid="step-badge"
            class="text-xs font-mono bg-gray-700 text-gray-300 rounded px-1.5 py-0.5"
          >
            {stepIndex + 1}
          </span>
          <div class="flex min-w-0 items-center gap-1">
            {isStartNode && (
              <span
                data-testid="start-badge"
                class="text-xs font-bold text-green-400 uppercase tracking-wider"
              >
                START
              </span>
            )}
            {isEndNode && (
              <span
                data-testid="end-badge"
                class="text-xs font-bold text-purple-400 uppercase tracking-wider"
              >
                END
              </span>
            )}
            {step.postApproval && (
              <span
                data-testid="post-approval-badge"
                title="Post-approval instruction configured"
                class="rounded bg-blue-500/10 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-blue-300"
              >
                Post
              </span>
            )}
          </div>
        </div>

        <p
          data-testid="step-name"
          class="text-sm font-medium text-white truncate"
          style={{ maxWidth: 180 }}
        >
          {step.name || '(unnamed)'}
        </p>

        {multi ? (
          <div data-testid="agent-badges" class="flex flex-wrap gap-1 mt-1">
            {step.agents!.map((sa) => {
              const hasOverrides = !!sa.customPrompt;
              const taskState = taskStateByAgent.get(sa.name);
              return (
                <span
                  key={sa.name}
                  class={`text-xs rounded px-1.5 py-0.5 flex items-center gap-0.5 ${hasOverrides ? 'bg-amber-900/40 text-amber-300' : 'bg-gray-700 text-gray-300'}`}
                  title={hasOverrides ? `${sa.name} (has overrides)` : sa.name}
                >
                  {sa.name}
                  {hasOverrides && !taskState && (
                    <span
                      data-testid="override-indicator"
                      class="w-1.5 h-1.5 rounded-full bg-amber-400 flex-shrink-0"
                    />
                  )}
                  {taskState && <AgentStatusIcon state={taskState} />}
                </span>
              );
            })}
          </div>
        ) : (
          <div
            data-testid="agent-name"
            class="flex items-center gap-1 text-xs text-gray-400 truncate mt-0.5"
          >
            <span class="truncate">{agentName}</span>
            {taskStateByAgent.get(null) && <AgentStatusIcon state={taskStateByAgent.get(null)!} />}
          </div>
        )}
      </div>

      <div
        data-testid="port-output"
        style={{
          position: 'absolute',
          bottom: -7,
          left: '50%',
          transform: 'translateX(-50%)',
          width: 14,
          height: 14,
          borderRadius: '50%',
          background: '#6b7280',
          border: '2px solid #374151',
          cursor: 'crosshair',
          zIndex: 6,
        }}
        class={
          activeAnchorSideSet.has('bottom')
            ? 'opacity-100'
            : 'opacity-0 transition-opacity group-hover:opacity-100'
        }
        onMouseDown={handleOutputPortMouseDown}
        onClick={stopClickPropagation}
      />
    </div>
  );
}
