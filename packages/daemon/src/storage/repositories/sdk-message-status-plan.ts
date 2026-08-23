import type { Database as BunDatabase } from '../sqlite-compat';
import type { SendStatus } from './sdk-message-admission';

export const PENDING_ROW_FROM_STATUSES: readonly SendStatus[] = [
  'deferred',
  'enqueued',
  'submitted',
];

export type PendingStatusRow = {
  rowId: string;
  taskId: string | null;
  isRenderable: boolean;
};

export type MessageStatusInstruction =
  | { kind: 'touch-timestamp'; rowId: string }
  | { kind: 'promote-turn'; rowId: string; taskId: string; sharedTurn: boolean }
  | { kind: 'allocate-consumed-seq'; rowId: string; providedSeq: number | null };

export interface MessageStatusApplicationPlan {
  targetStatus: SendStatus;
  fromStatuses: readonly SendStatus[];
  plannedRowIds: readonly string[];
  instructions: readonly MessageStatusInstruction[];
}

export function planMessageStatusApplication(
  rows: readonly PendingStatusRow[],
  targetStatus: SendStatus,
  options?: { sharedTurn?: boolean; consumedSeq?: number }
): MessageStatusApplicationPlan {
  const instructions: MessageStatusInstruction[] = [];
  for (const row of rows) {
    if (row.taskId && row.isRenderable) {
      instructions.push({
        kind: 'promote-turn',
        rowId: row.rowId,
        taskId: row.taskId,
        sharedTurn: options?.sharedTurn === true,
      });
    } else {
      instructions.push({ kind: 'touch-timestamp', rowId: row.rowId });
    }
    if (targetStatus === 'consumed') {
      instructions.push({
        kind: 'allocate-consumed-seq',
        rowId: row.rowId,
        providedSeq: options?.consumedSeq ?? null,
      });
    }
  }
  return {
    targetStatus,
    fromStatuses: PENDING_ROW_FROM_STATUSES,
    plannedRowIds: rows.map((row) => row.rowId),
    instructions,
  };
}

export function applyMessageStatusPlan(
  db: BunDatabase,
  plan: MessageStatusApplicationPlan,
  messageIds: readonly string[],
  allocateNextConsumedSeq: () => number | null
): void {
  const plannedIds = new Set(plan.plannedRowIds);
  const unplannedIds = messageIds.filter((id) => !plannedIds.has(id));
  const fromList = plan.fromStatuses.map(() => '?').join(', ');
  const now = new Date().toISOString();
  const maxTurnStmt = db.prepare(
    'SELECT MAX(conversation_turn_index) AS m FROM sdk_messages WHERE task_id = ?'
  );
  const sharedBases = new Map<string, number>();
  const readMaxTurn = (taskId: string): number =>
    (maxTurnStmt.get(taskId) as { m: number | null } | undefined)?.m ?? 0;
  const touchStmt = db.prepare(
    `UPDATE sdk_messages SET timestamp = ? WHERE id = ? AND send_status IN (${fromList})`
  );
  const promoteStmt = db.prepare(
    `UPDATE sdk_messages SET conversation_turn_index = ?, timestamp = ?
     WHERE id = ? AND send_status IN (${fromList})`
  );
  const seqStmt = db.prepare(
    `UPDATE sdk_messages SET consumed_seq = ?, timestamp = ?
     WHERE id = ? AND send_status IN (${fromList})`
  );
  for (const instruction of plan.instructions) {
    switch (instruction.kind) {
      case 'touch-timestamp':
        touchStmt.run(now, instruction.rowId, ...plan.fromStatuses);
        break;
      case 'promote-turn': {
        let base: number;
        if (instruction.sharedTurn) {
          let shared = sharedBases.get(instruction.taskId);
          if (shared === undefined) {
            shared = readMaxTurn(instruction.taskId);
            sharedBases.set(instruction.taskId, shared);
          }
          base = shared;
        } else {
          base = readMaxTurn(instruction.taskId);
        }
        promoteStmt.run(base + 1, now, instruction.rowId, ...plan.fromStatuses);
        break;
      }
      case 'allocate-consumed-seq':
        seqStmt.run(
          instruction.providedSeq ?? allocateNextConsumedSeq(),
          now,
          instruction.rowId,
          ...plan.fromStatuses
        );
        break;
    }
  }
  if (plan.plannedRowIds.length > 0) {
    const plannedList = plan.plannedRowIds.map(() => '?').join(',');
    db.prepare(
      `UPDATE sdk_messages SET send_status = ?
        WHERE id IN (${plannedList}) AND send_status IN (${fromList})`
    ).run(plan.targetStatus, ...plan.plannedRowIds, ...plan.fromStatuses);
  }
  if (unplannedIds.length > 0) {
    const unplannedList = unplannedIds.map(() => '?').join(',');
    db.prepare(`UPDATE sdk_messages SET send_status = ? WHERE id IN (${unplannedList})`).run(
      plan.targetStatus,
      ...unplannedIds
    );
  }
}
