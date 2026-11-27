import type { WorkRef } from '../../lib/drivers/types.ts';
import type { TurnTodoFacts } from '../../lib/neo/turn-todo.ts';
import { gatewayFor } from '../db-gateway/db-gateway.ts';
import { defineDbOp } from '../db-gateway/db-op.ts';
import type { Database } from '../sqlite-compat.ts';
import { WorkDeliveryInputRepository } from './work-delivery-input-repository.ts';

type Delivery = ReturnType<WorkDeliveryInputRepository['list']>[number];

const PENDING_RECEIPT = /^desktop-pending:\d+:([a-f0-9]+)$/;

export function deliveryKeys({ outcome }: Pick<Delivery, 'outcome'>): string[] {
  const reply = outcome as {
    receipt?: { inputId?: string };
    clientMessageId?: string;
    delivery?: { startedTurnId?: string; steeredIntoTurnId?: string; clientMessageId?: string };
  } | null;
  const input = reply?.receipt?.inputId;
  const pending = input && PENDING_RECEIPT.exec(input);
  return [
    ...(pending ? [`desktop-pending:${pending[1]}`] : input ? [input] : []),
    ...(reply?.delivery?.startedTurnId ? [reply.delivery.startedTurnId] : []),
    ...(reply?.delivery?.steeredIntoTurnId ? [reply.delivery.steeredIntoTurnId] : []),
    ...(reply?.delivery?.clientMessageId ? [reply.delivery.clientMessageId] : []),
    ...(reply?.clientMessageId ? [reply.clientMessageId] : []),
  ];
}

function readStarter(db: Database, ref: WorkRef, rows: readonly Delivery[]): string | null {
  if (ref.daemon) return null;
  const started = db
    .prepare(`SELECT w.todo_id AS todoId FROM work_started_sessions w
      JOIN migration_markers m ON m.key = 'migration_541'
      WHERE w.adapter = ? AND w.id = ? AND w.todo_id IS NOT NULL AND w.started_at >= m.applied_at`)
    .get(ref.adapter, ref.id) as { todoId: string } | null;
  const starter = started?.todoId ?? null;
  if (!starter) return null;
  const named = rows.some(
    (row) => row.todoId !== starter && !(row.outcome as { notSent?: true } | null)?.notSent
  );
  const adopted = db
    .prepare(`SELECT 1 FROM work_adoptions
      WHERE adapter = ? AND id = ? AND daemon IS ? AND todo_id != ? LIMIT 1`)
    .get(ref.adapter, ref.id, ref.daemon ?? null, starter);
  return named || adopted ? null : starter;
}

export function readTurnTodoFacts(db: Database, ref: WorkRef): TurnTodoFacts {
  const rows = new WorkDeliveryInputRepository(db).list(ref);
  const keys: Record<string, string[]> = {};
  for (const row of rows)
    if (row.todoId)
      for (const key of deliveryKeys(row))
        if (!keys[key]?.includes(row.todoId)) (keys[key] ??= []).push(row.todoId);
  const roles = ref.daemon
    ? []
    : (db
        .prepare(`SELECT todo_id AS todoId, role FROM neo_todo_roles
          WHERE adapter = ? AND id = ? ORDER BY at, rowid`)
        .all(ref.adapter, ref.id) as { todoId: string; role: string }[]);
  return {
    keys,
    starter: readStarter(db, ref, rows),
    roles: Object.fromEntries(roles.map(({ todoId, role }) => [todoId, role])),
  };
}

export const retargetWorkDeliveryInput = defineDbOp({
  name: 'work.deliveryInput.retarget',
  mode: 'write',
  run: (db: Database, { id, ref }: { id: string; ref: WorkRef | null }) => {
    const updated = db
      .prepare(`UPDATE work_delivery_inputs SET target = CASE WHEN ?1 IS NULL
          THEN json_remove(target, '$.ref') ELSE json_set(target, '$.ref', json(?1)) END
        WHERE id = ?2`)
      .run(ref ? JSON.stringify(ref) : null, id);
    if (updated.changes !== 1) throw new Error('Delivery input is missing.');
  },
});

export function retargetDeliveryInput(db: Database, id: string, ref: WorkRef | null) {
  return gatewayFor(db).run(retargetWorkDeliveryInput, { id, ref });
}
