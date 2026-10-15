import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import { defineOperation, type OperationCaller } from '../operations/registry.ts';
import type { NeoService } from './service.ts';
import {
  admitNeoConsultationOrigin,
  requireLiveNeoConsultationOrigin,
  type NeoConsultationOrigin,
} from './consultation-origin.ts';
import { neoFactOwners, readNeoProjectFacts } from './project-route-facts.ts';
import type {
  NeoCrossProjectGroup,
  NeoCrossProjectPart,
} from '../../storage/repositories/neo-cross-project-repository.ts';
import type { NeoAskOrigin } from './ask-origin.ts';

const Input = z
  .object({
    parts: z
      .array(
        z
          .object({
            projectId: z.string().min(1),
            quote: z.string().trim().min(1).max(4000),
            question: z.string().trim().min(1).max(3000),
          })
          .strict()
      )
      .min(1)
      .max(50),
  })
  .strict();
const Result = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(false), reason: z.string() }),
  z.object({ ok: z.literal(true), groupId: z.string() }),
]);
type Rejection = { ok: false; reason: string };
type Gate<T> = { value: T } | { reason: Rejection };
type Draft = { root: NeoConsultationOrigin; ask: NeoAskOrigin; parts: NeoCrossProjectPart[] };

export function requireNeoCrossProjectParts(
  parts: readonly NeoCrossProjectPart[],
  text: string,
  owners: readonly (string | null)[] | null,
  exists: (id: string) => boolean
): Gate<NeoCrossProjectPart[]> {
  const ids = parts.map((part) => part.projectId);
  if (!owners || new Set(ids).size !== ids.length || ids.some((id) => !exists(id)))
    return { reason: { ok: false, reason: 'invalid_project_owners' } };
  const expected = owners.filter((id): id is string => id !== null);
  if (
    owners.length &&
    (owners.length < 2 ||
      expected.length !== ids.length ||
      expected.some((id) => !ids.includes(id)))
  )
    return { reason: { ok: false, reason: `parts_must_cover_owners:${expected.join(',')}` } };
  if (!owners.length && ids.length < 2)
    return { reason: { ok: false, reason: 'cross_project_required' } };
  if (parts.some((part) => !text.includes(part.quote)))
    return { reason: { ok: false, reason: 'quote_must_match_human' } };
  return { value: [...parts] };
}

function prepareCrossProjectDraft(
  input: z.infer<typeof Input>,
  root: NeoConsultationOrigin,
  service: NeoService
): Gate<Draft> {
  const ask = service.resolveAskOrigin({
    sessionId: root.originSessionId,
    messageId: root.originMessageId,
  });
  const text = ask ? service.humanAskText(ask) : null;
  if (!ask || !text) return { reason: { ok: false, reason: 'human_ask_required' } };
  const parts = requireNeoCrossProjectParts(
    input.parts,
    text,
    neoFactOwners(readNeoProjectFacts(service.db.getDatabase(), text)),
    (id) => !!service.repo.getProject(id)
  );
  if ('reason' in parts) return parts;
  if (
    parts.value.some((part) => {
      const owners = neoFactOwners(readNeoProjectFacts(service.db.getDatabase(), part.question));
      return !owners || owners.some((owner) => owner !== part.projectId);
    })
  )
    return { reason: { ok: false, reason: 'part_references_another_owner' } };
  return { value: { root, ask, parts: parts.value } };
}

export function createNeoCrossProjectOperation(service: NeoService) {
  const dispatch = (superpipe({})('neo-cross-project-dispatch') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(
      (caller: OperationCaller) =>
        admitNeoConsultationOrigin(
          caller,
          caller.sessionId ? service.repo.getBindingBySession(caller.sessionId) : null
        ),
      'caller',
      'result:dispatch'
    )
    .pipe(
      (input: z.infer<typeof Input>, root: NeoConsultationOrigin) =>
        prepareCrossProjectDraft(input, root, service),
      ['input', 'dispatch'],
      'result:dispatch'
    )
    .pipe((draft: Draft) => draft, 'dispatch', 'draft')
    .pipe(
      async (draft: Draft) => {
        const sessions = new Map<string, string>();
        for (const part of draft.parts)
          sessions.set(part.projectId, await service.open(part.projectId));
        return sessions;
      },
      'draft',
      'sessions'
    )
    .pipe(
      (draft: Draft, caller: OperationCaller) =>
        requireLiveNeoConsultationOrigin(draft.root, caller.neoTurn),
      ['draft', 'caller'],
      'result:dispatch'
    )
    .pipe(
      (input: z.infer<typeof Input>, root: NeoConsultationOrigin) =>
        prepareCrossProjectDraft(input, root, service),
      ['input', 'dispatch'],
      'result:dispatch'
    )
    .pipe(
      (draft: Draft, sessions: ReadonlyMap<string, string>) => {
        const result = service.crossProjects.bind(
          draft.root.originSessionId,
          draft.root.originMessageId,
          draft.ask,
          draft.parts,
          sessions,
          service.consultationWaiters
        );
        return 'value' in result ? result : { reason: { ok: false, reason: result.reason } };
      },
      ['dispatch', 'sessions'],
      'result:dispatch'
    )
    .pipe(
      async (group: NeoCrossProjectGroup) => {
        for (const member of service.crossProjects.members(group))
          await service.dispatchConsultationWaiter(member.projectId);
        return { ok: true as const, groupId: group.id };
      },
      'dispatch',
      'dispatch'
    )
    .endAsync('dispatch') as (
    input: z.infer<typeof Input>,
    caller: OperationCaller
  ) => Promise<z.infer<typeof Result>>;
  return defineOperation({
    name: 'neo.projects.dispatch',
    description:
      'Split the current human request across its owning projects. Quote the human exactly in each part and give only that owner its instruction. Parts must cover every known owner. Returns one durable group; holders return privately and root receives all results together for one final publication. Identical retries reuse the group.',
    inputSchema: Input,
    resultSchema: Result,
    policy: { safetyClass: 'mutate', roles: ['neo'] },
    execute: async (input, caller) => service.triggerWorkProblem(caller) ?? dispatch(input, caller),
  });
}
