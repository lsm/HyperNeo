import { parseRemoteAddress } from '../mailbox/address.ts';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import {
  isWorkerAdapter,
  workerIdentity,
  type WorkerIdentity,
} from '@hyperneo/shared/types/worker-identity';
import type { WorkRef } from '../drivers/types.ts';
import type { OperationOutcome } from '../operations/invoke.ts';

const Current = z.object({ ok: z.literal(true), value: z.object({ title: z.string() }) });
export const readWorkerIdentity = (superpipe({})('read-worker-identity') as PipelineAPI)
  .input(['ref', 'read'])
  .pipe(
    (ref: WorkRef, read: (ref: WorkRef) => Promise<OperationOutcome>) => read(ref),
    ['ref', 'read'],
    'status'
  )
  .pipe(
    (ref: WorkRef, status: OperationOutcome) => {
      const current = Current.safeParse(status.kind === 'completed' ? status.value : null);
      return workerIdentity(ref, current.success ? current.data.value.title : null);
    },
    ['ref', 'status'],
    'worker'
  )
  .endAsync('worker') as (
  ref: WorkRef,
  read: (ref: WorkRef) => Promise<OperationOutcome>
) => Promise<WorkerIdentity>;

export function sessionWorkerRef(id: string, local: boolean): WorkRef {
  const remote = parseRemoteAddress(id);
  if (remote) return { adapter: 'hyperneo', id: remote.sessionId, daemon: remote.daemonId };
  const split = id.indexOf(':');
  return !local && split > 0 && isWorkerAdapter(id.slice(0, split))
    ? { adapter: id.slice(0, split), id: id.slice(split + 1) }
    : { adapter: 'hyperneo', id };
}
