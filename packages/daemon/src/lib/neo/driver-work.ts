import { z } from 'zod';
import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import { PlaceSchema, WorkRefSchema, type WorkRef } from '../drivers/types.ts';
import type { OperationOutcome } from '../operations/invoke.ts';
import type { OperationCaller } from '../operations/registry.ts';

export const NeoDriverTargetSchema = z.discriminatedUnion('verb', [
  z.object({ verb: z.literal('start'), adapter: z.string().min(1).max(80), place: PlaceSchema }),
  z.object({ verb: z.literal('send'), ref: WorkRefSchema }),
]);

export type NeoDriverTarget = z.infer<typeof NeoDriverTargetSchema>;

const DriverReplySchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    value: z.union([
      z.object({ ref: WorkRefSchema }).passthrough(),
      z.object({ delivered: z.boolean() }),
    ]),
  }),
  z.object({ ok: z.literal(false), reason: z.string(), detail: z.string() }),
]);

export function driverWorkCall(
  target: NeoDriverTarget,
  work: Pick<NeoWork, 'title' | 'instruction'>
): { name: 'work.start' | 'work.send'; input: Record<string, unknown> } {
  return target.verb === 'start'
    ? {
        name: 'work.start',
        input: {
          adapter: target.adapter,
          place: target.place,
          title: work.title,
          message: work.instruction,
        },
      }
    : { name: 'work.send', input: { ref: target.ref, message: work.instruction } };
}

export function driverWorkCaller(work: Pick<NeoWork, 'originSessionId'>): OperationCaller {
  return { source: 'internal', sessionId: work.originSessionId, role: 'neo' };
}

export function readDriverOutcome(
  target: NeoDriverTarget,
  outcome: OperationOutcome
): { ref: WorkRef } | { failure: string } {
  if (outcome.kind === 'failed') return { failure: outcome.message };
  const reply = DriverReplySchema.safeParse(outcome.value);
  if (!reply.success) return { failure: 'The work operation returned an unusable reply.' };
  if (!reply.data.ok) return { failure: `${reply.data.reason}: ${reply.data.detail}` };
  if ('ref' in reply.data.value) return { ref: reply.data.value.ref as WorkRef };
  return target.verb === 'send'
    ? { ref: target.ref }
    : { failure: 'work.start returned no reference.' };
}
