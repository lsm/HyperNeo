import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import type { NeoRepository } from '../../storage/repositories/neo-repository.ts';
import { invokeOperation, type OperationOutcome } from '../operations/invoke.ts';
import {
  createOperationRegistry,
  type OperationDefinition,
  type OperationRegistry,
} from '../operations/registry.ts';

export const NeoReadWorkTarget = z
  .object({
    verb: z.literal('read'),
    operation: z.string().trim().min(1).max(160),
    input: z.record(z.string(), z.unknown()),
  })
  .strict();
type ReadTarget = z.infer<typeof NeoReadWorkTarget>;
type Failure = { ok: false; reason: string };

export function requireNeoReadOperation(
  target: ReadTarget,
  registry: OperationRegistry
): { value: OperationDefinition } | { reason: Failure } {
  const operation = registry.get(target.operation);
  return operation?.policy?.safetyClass === 'read' &&
    (!operation.policy.roles || operation.policy.roles.includes('neo'))
    ? { value: operation }
    : {
        reason: {
          ok: false,
          reason: `read_operation_required: ${target.operation} must be a registered read operation available to Neo. Mutating work needs its ordinary approval.`,
        },
      };
}

function readWorkReport(outcome: OperationOutcome): Pick<NeoWork, 'status' | 'report'> {
  const failed =
    outcome.kind === 'failed' ||
    (typeof outcome.value === 'object' &&
      outcome.value !== null &&
      (('ok' in outcome.value && outcome.value.ok === false) ||
        ('accepted' in outcome.value && outcome.value.accepted === false)));
  return {
    status: failed ? 'failed' : 'reported',
    report: JSON.stringify(outcome).slice(0, 12000),
  };
}

export const runNeoReadWork = (superpipe({})('neo-read-work') as PipelineAPI)
  .input(['repo', 'registry', 'work', 'target', 'returned'])
  .pipe(requireNeoReadOperation, ['target', 'registry'], 'result:read')
  .pipe((operation: OperationDefinition) => operation, 'read', 'operation')
  .pipe(
    (repo: NeoRepository, work: NeoWork) => {
      const queued = repo.transitionWork(work.id, work, { status: 'queued' });
      return queued ? { value: queued } : { reason: null };
    },
    ['repo', 'work'],
    'result:read'
  )
  .pipe(
    (operation: OperationDefinition, target: ReadTarget, work: NeoWork) =>
      invokeOperation(createOperationRegistry([operation]), target.operation, target.input, {
        source: 'mcp',
        sessionId: work.originSessionId,
        role: 'neo',
      }),
    ['operation', 'target', 'read'],
    'outcome'
  )
  .pipe(
    (repo: NeoRepository, work: NeoWork, outcome: OperationOutcome) => {
      const reported = repo.transitionWork(work.id, work, readWorkReport(outcome));
      return reported ? { value: reported } : { reason: null };
    },
    ['repo', 'read', 'outcome'],
    'result:read'
  )
  .pipe(
    async (work: NeoWork, returned: (work: NeoWork) => Promise<void>) => {
      await returned(work);
      return { ok: true as const };
    },
    ['read', 'returned'],
    'read'
  )
  .endAsync('read') as (
  repo: NeoRepository,
  registry: OperationRegistry,
  work: NeoWork,
  target: ReadTarget,
  returned: (work: NeoWork) => Promise<void>
) => Promise<{ ok: true } | Failure | null>;
