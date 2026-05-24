/**
 * Shared types for the visual editor canvas and nodes.
 */

/**
 * Legacy workflow condition types kept locally for the visual editor's
 * edge transition system (edges between nodes, not channels).
 */
export type WorkflowConditionType = 'always' | 'human' | 'condition' | 'task_result';

export interface WorkflowCondition {
  type: WorkflowConditionType;
  expression?: string;
  description?: string;
  maxRetries?: number;
  timeoutMs?: number;
}

/**
 * A directed edge used internally by the visual editor canvas.
 * This replaces the removed backend `WorkflowTransition` type for UI-only use.
 */
export interface VisualTransition {
  id: string;
  from: string;
  to: string;
  condition?: WorkflowCondition;
  order?: number;
  isCyclic?: boolean;
}

export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface ViewportState {
  offsetX: number;
  offsetY: number;
  scale: number;
}

/** Per-node position and size keyed by node ID. */
export type NodePosition = Record<string, { x: number; y: number; width: number; height: number }>;

/**
 * Convert a screen-space point to canvas-space using the current viewport.
 * Inverse of canvasToScreen.
 */
export function screenToCanvas(point: Point, viewport: ViewportState): Point {
  const scale = viewport.scale || 1;
  return {
    x: (point.x - viewport.offsetX) / scale,
    y: (point.y - viewport.offsetY) / scale,
  };
}

/**
 * Convert a canvas-space point to screen-space using the current viewport.
 * Inverse of screenToCanvas.
 */
export function canvasToScreen(point: Point, viewport: ViewportState): Point {
  return {
    x: point.x * viewport.scale + viewport.offsetX,
    y: point.y * viewport.scale + viewport.offsetY,
  };
}
