import type { Session } from '@hyperneo/shared';
import type { NeoQuestionSource } from '@hyperneo/shared/types/neo-ask';
import { workerIdentity, workerEngine } from '@hyperneo/shared/types/worker-identity';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import { FindWorkResultSchema } from '../drivers/find-operation.ts';
import { WorkSummarySchema, type WorkRef } from '../drivers/types.ts';
import type { OperationOutcome } from '../operations/invoke.ts';
import { neoSafeSessionLink } from '../../storage/repositories/neo-todo-session-repository.ts';
import { sessionWorkerRef } from './worker-identity.ts';

type Outcome =
  | { status: 'found'; source: NeoQuestionSource }
  | { status: 'not_found' | 'unavailable'; source: null };
type Plan = { ref: WorkRef; local: Session | null; bare: boolean };
type Read = (name: 'work.find' | 'work.status', input: unknown) => Promise<OperationOutcome>;
const failed = (status: 'not_found' | 'unavailable') => ({ reason: { status, source: null } });

export const readNeoSessionSource = (superpipe({})('neo.session.open-source') as PipelineAPI)
  .input(['session', 'getLocal', 'read'])
  .pipe(
    (session: string | WorkRef, getLocal: (id: string) => Session | null): Plan => {
      const ref = typeof session === 'string' ? sessionWorkerRef(session, false) : session;
      const local = ref.adapter === 'hyperneo' && !ref.daemon ? getLocal(ref.id) : null;
      return { ref, local, bare: typeof session === 'string' && !session.includes(':') && !local };
    },
    ['session', 'getLocal'],
    'target'
  )
  .pipe(
    async (plan: Plan, read: Read) => {
      if (!plan.bare) return { value: plan };
      const result = await read('work.find', {
        idPrefix: plan.ref.id,
        includeClosed: true,
        localOnly: true,
        limit: 50,
      });
      const found = FindWorkResultSchema.safeParse(
        result.kind === 'completed' ? result.value : null
      );
      if (!found.success || found.data.more || found.data.unreachable.length)
        return failed('unavailable');
      const refs = [
        ...new Map(
          found.data.places
            .flatMap((place) => place.work)
            .filter((work) => work.ref.id === plan.ref.id && !work.ref.daemon)
            .map((work) => [JSON.stringify(work.ref), work.ref])
        ).values(),
      ];
      return refs.length === 1
        ? { value: { ...plan, ref: refs[0] } }
        : failed(refs.length ? 'unavailable' : 'not_found');
    },
    ['target', 'read'],
    'result:target'
  )
  .pipe(
    async ({ ref, local }: Plan, read: Read) => {
      if (local)
        return {
          value: {
            status: 'found',
            source: {
              ...workerIdentity(ref, local.title),
              provider: local.config.provider ?? 'hyperneo',
              link: neoSafeSessionLink(`/session/${local.id}`, false),
            },
          },
        };
      const result = await read('work.status', { ref });
      const current = z
        .object({ ok: z.literal(true), value: WorkSummarySchema })
        .safeParse(result.kind === 'completed' ? result.value : null);
      if (!current.success)
        return failed(
          z
            .object({ ok: z.literal(false), reason: z.literal('not_found') })
            .safeParse(result.kind === 'completed' ? result.value : null).success
            ? 'not_found'
            : 'unavailable'
        );
      return {
        value: {
          status: 'found',
          source: {
            ...workerIdentity(ref, current.data.value.title),
            provider: workerEngine(ref.adapter),
            link:
              neoSafeSessionLink(current.data.value.link, !!ref.daemon) ??
              neoSafeSessionLink(current.data.value.remoteLink, true),
          },
        },
      };
    },
    ['target', 'read'],
    'result:target'
  )
  .endAsync('target') as (
  session: string | WorkRef,
  getLocal: (id: string) => Session | null,
  read: Read
) => Promise<Outcome>;
