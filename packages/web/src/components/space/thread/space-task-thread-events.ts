import type { SDKMessage } from '@hyperneo/shared/sdk/sdk.d.ts';
import type { MessageDeliveryStatus } from '@hyperneo/shared';
import type { SpaceTaskThreadMessageRow } from '../useSpaceTaskMessages';
import type { MessageReplacementStatus } from '../../../lib/sdk-message-replacement';

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
