import type { NeoCardControlFailure } from '@hyperneo/shared/types/neo-snapshot';
import { z } from 'zod';
import type { WorkRef } from '../drivers/types.ts';
import type { OperationOutcome } from '../operations/invoke.ts';
import type { NeoWorkControlFailure } from '../../storage/repositories/neo-work-control-failure-repository.ts';

const ControlReplySchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(false), reason: z.string(), detail: z.string() }),
  z.object({
    ok: z.literal(true),
    value: z.object({ stopped: z.boolean().optional(), withdrawn: z.boolean().optional() }),
  }),
]);

export function neoControlFailure(
  operation: NeoCardControlFailure['operation'],
  outcome: OperationOutcome,
  at: number
): NeoCardControlFailure | null {
  if (outcome.kind === 'failed')
    return { operation, reason: 'unavailable', detail: outcome.message, at };
  const parsed = ControlReplySchema.safeParse(outcome.value);
  if (!parsed.success)
    return {
      operation,
      reason: 'unavailable',
      detail: 'The driver returned no usable control result.',
      at,
    };
  const reply = parsed.data;
  if (!reply.ok)
    return {
      operation,
      reason: reply.reason === 'unsupported' ? 'unsupported' : 'unavailable',
      detail: reply.detail,
      at,
    };
  return reply.value[operation === 'stop' ? 'stopped' : 'withdrawn'] === true
    ? null
    : {
        operation,
        reason: 'unavailable',
        detail: 'The driver did not confirm the control took effect.',
        at,
      };
}

export function neoControlFailureForRef(
  rows: readonly NeoWorkControlFailure[],
  workId: string,
  ref: WorkRef | null
): NeoCardControlFailure | null {
  if (!ref) return null;
  const row = rows
    .filter(
      (row) =>
        row.workId === workId &&
        row.ref.adapter === ref.adapter &&
        row.ref.id === ref.id &&
        row.ref.daemon === ref.daemon
    )
    .sort((a, b) => b.at - a.at)[0];
  return row
    ? { operation: row.operation, reason: row.reason, detail: row.detail, at: row.at }
    : null;
}
