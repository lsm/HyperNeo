export type WorkflowConditionType = 'always' | 'human' | 'condition' | 'task_result';

export interface WorkflowCondition {
  type: WorkflowConditionType;
  expression?: string;
  description?: string;
  maxRetries?: number;
  timeoutMs?: number;
}

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

export type NodePosition = Record<string, { x: number; y: number; width: number; height: number }>;

export function screenToCanvas(point: Point, viewport: ViewportState): Point {
  const scale = viewport.scale || 1;
  return {
    x: (point.x - viewport.offsetX) / scale,
    y: (point.y - viewport.offsetY) / scale,
  };
}

export function canvasToScreen(point: Point, viewport: ViewportState): Point {
  return {
    x: point.x * viewport.scale + viewport.offsetX,
    y: point.y * viewport.scale + viewport.offsetY,
  };
}
