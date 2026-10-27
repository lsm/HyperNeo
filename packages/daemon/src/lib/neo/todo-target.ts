import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import { FindWorkResultSchema } from '../drivers/find-operation.ts';
import { type WorkRef, WorkRefSchema } from '../drivers/types.ts';
import type { OperationOutcome } from '../operations/invoke.ts';

type Invoke = (name: string, input: unknown) => Promise<OperationOutcome>;
type Result = { value: WorkRef } | { reason: { ok: false; reason: string } };
const Status = z.object({ ok: z.literal(true), value: z.object({ ref: WorkRefSchema }) });
const missing = (reason: string): Result => ({ reason: { ok: false, reason } });
const sameOwner = (a: WorkRef, b: WorkRef) => a.adapter === b.adapter && a.daemon === b.daemon;

export const resolveNeoTodoTarget = (superpipe({})('neo.todo.resolve-target') as PipelineAPI)
  .input(['ref', 'invoke'])
  .pipe(
    (ref: WorkRef, invoke: Invoke) => invoke('work.status', { ref }),
    ['ref', 'invoke'],
    'status'
  )
  .pipe(
    async (ref: WorkRef, status: OperationOutcome, invoke: Invoke): Promise<Result> => {
      const known = status.kind === 'completed' && Status.safeParse(status.value);
      if (known && known.success && sameOwner(ref, known.data.value.ref))
        return { value: known.data.value.ref };
      const found = await invoke('work.find', {
        idPrefix: ref.id,
        adapters: [ref.adapter],
        localOnly: !ref.daemon,
        includeClosed: true,
        limit: 50,
      });
      const result = found.kind === 'completed' && FindWorkResultSchema.safeParse(found.value);
      if (!result || !result.success) return missing('target_unresolved: work lookup failed.');
      const refs = result.data.places
        .flatMap((place) => place.work.map((work) => work.ref))
        .filter((candidate) => sameOwner(ref, candidate));
      const exact = refs.find((candidate) => candidate.id === ref.id);
      if (exact) return { value: exact };
      if (result.data.more || result.data.unreachable.length)
        return missing(
          'target_unresolved: work lookup was incomplete; use the full id from work.find.'
        );
      const matches = [
        ...new Map(
          refs
            .filter((candidate) => candidate.id.startsWith(ref.id))
            .map((candidate) => [candidate.id, candidate])
        ).values(),
      ];
      return matches.length === 1
        ? { value: matches[0] }
        : missing(
            matches.length
              ? 'target_ambiguous: use the full id from work.find.'
              : `target_not_found: no ${ref.adapter} work matches ${ref.id}.`
          );
    },
    ['ref', 'status', 'invoke'],
    'target'
  )
  .endAsync('target') as (ref: WorkRef, invoke: Invoke) => Promise<Result>;
