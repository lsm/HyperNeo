import type { SDKMessage } from '@hyperneo/shared/sdk/sdk.d.ts';
import type { MessageDeliveryStatus } from '@hyperneo/shared';
import type { SpaceTaskThreadMessageRow } from '../useSpaceTaskMessages';
import type { MessageReplacementStatus } from '../../../lib/sdk-message-replacement';

export type SpaceTaskThreadEventKind =
  | 'thinking'
  | 'tool'
  | 'subagent'
  | 'text'
  | 'user'
  | 'system'
  | 'compact_boundary'
  | 'result'
  | 'rate_limit'
  | 'progress'
  | 'unknown';

export interface ParsedThreadRow {
  id: string | number;
  sessionId: string | null;
  kind: 'task_agent' | 'node_agent';
  label: string;
  role: string;
  nodeExecutionId?: string | null;
  taskId: string;
  taskTitle: string;
  createdAt: number;
  turnIndex?: number;
  turnHiddenMessageCount?: number;
  deliveryState?: MessageDeliveryStatus | null;
  message: SDKMessage | null;
  fallbackText: string | null;
  replacementStatus?: MessageReplacementStatus;
}

export interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm: string;
}

export interface SpaceTaskThreadEvent {
  id: string;
  label: string;
  role: string;
  nodeExecutionId?: string | null;
  taskId: string;
  taskTitle: string;
  sessionId: string | null;
  createdAt: number;
  kind: SpaceTaskThreadEventKind;
  title: string;
  summary: string;
  message?: SDKMessage | null;
  iconToolName?: string;
  systemSubtype?: string;
  resultSubtype?: string;
  isError?: boolean;
  todos?: TodoItem[];
}

export function parseThreadRow(row: SpaceTaskThreadMessageRow): ParsedThreadRow {
  try {
    const parsed = JSON.parse(row.content) as SDKMessage;
    const withTimestamp = {
      ...(parsed as Record<string, unknown>),
      timestamp: row.createdAt,
      ...(row.origin ? { origin: row.origin } : {}),
    } as unknown as SDKMessage;

    return {
      id: row.id,
      sessionId: row.sessionId,
      kind: row.kind,
      label: row.label,
      role: row.role,
      nodeExecutionId: row.nodeExecutionId ?? null,
      taskId: row.taskId,
      taskTitle: row.taskTitle,
      createdAt: row.createdAt,
      turnIndex: row.turnIndex,
      turnHiddenMessageCount: row.turnHiddenMessageCount,
      deliveryState: row.deliveryState ?? null,
      message: withTimestamp,
      fallbackText: null,
    };
  } catch {
    return {
      id: row.id,
      sessionId: row.sessionId,
      kind: row.kind,
      label: row.label,
      role: row.role,
      nodeExecutionId: row.nodeExecutionId ?? null,
      taskId: row.taskId,
      taskTitle: row.taskTitle,
      createdAt: row.createdAt,
      turnIndex: row.turnIndex,
      turnHiddenMessageCount: row.turnHiddenMessageCount,
      deliveryState: row.deliveryState ?? null,
      message: null,
      fallbackText: row.content,
    };
  }
}
