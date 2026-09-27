import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import type { OperationCaller } from '../operations/registry.ts';
import { defineOperation } from '../operations/registry.ts';
import type { NeoService } from './service.ts';
import { CONSULTATION_STOPPED } from './consultation-policy.ts';

const Concern = z.object({
  id: z.string(),
  title: z.string(),
  summary: z.string(),
  context: z.string(),
  revision: z.number(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
const Work = z.object({
  id: z.string(),
  requestKey: z.string(),
  concernId: z.string().nullable(),
  originSessionId: z.string(),
  title: z.string(),
  instruction: z.string(),
  sessionId: z.string().nullable(),
  status: z.enum(['proposed', 'queued', 'reported', 'failed', 'cancelled']),
  report: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
const Failure = z.object({ ok: z.literal(false), reason: z.string() });
const Consultation = z.object({
  id: z.string(),
  requestKey: z.string(),
  concernId: z.string(),
  originSessionId: z.string(),
  sessionId: z.string(),
  question: z.string(),
  status: z.enum(['pending', 'reported', 'failed']),
  answer: z.string().nullable(),
  createdAt: z.number(),
});
const Consult = z.object({
  concernId: z.string().min(1),
  requestKey: z.string().min(1).max(160),
  question: z.string().trim().min(1).max(8000),
});
const Respond = z.object({ id: z.string().min(1), answer: z.string().trim().min(1).max(4000) });
const ConsultationResult = z.union([
  Failure,
  z.object({ ok: z.literal(true), consultation: Consultation }),
]);
const Snapshot = z.union([
  Failure,
  z.object({
    ok: z.literal(true),
    sessionId: z.string().nullable(),
    concerns: z.array(Concern),
    work: z.array(Work),
    consultations: z.array(Consultation),
  }),
]);
const WorkResult = z.union([Failure, z.object({ ok: z.literal(true), work: Work })]);
const Scope = z.object({ concernId: z.string().min(1).optional() }).default({});
const Save = z.object({
  id: z.string().min(1).max(100),
  title: z.string().trim().min(1).max(160),
  summary: z.string().max(1000),
  context: z.string().max(16000),
  expectedRevision: z.number().int().min(0),
});
const Propose = z.object({
  requestKey: z.string().min(1).max(160),
  concernId: z.string().min(1).nullable().default(null),
  title: z.string().trim().min(1).max(160),
  instruction: z.string().trim().min(1).max(16000),
});
const WorkId = z.object({ id: z.string().min(1) });
type Rejection = { ok: false; reason: string };

export function admitNeoCaller(
  service: NeoService,
  caller: OperationCaller,
  name: string,
  concernId?: string | null
): { value: OperationCaller } | { reason: Rejection } {
  if (caller.source === 'rpc' && caller.principal === 'local') return { value: caller };
  const binding = caller.sessionId ? service.repo.getBindingBySession(caller.sessionId) : null;
  if (caller.source !== 'mcp' || !binding || binding.kind === 'worker')
    return { reason: { ok: false, reason: 'This operation belongs to Neo.' } };
  if (name === 'neo.concern.consult' && binding.kind !== 'neo')
    return { reason: { ok: false, reason: 'Only root Neo can consult a context holder.' } };
  if (
    name === 'neo.concern.save' &&
    binding.kind === 'neo' &&
    concernId &&
    service.repo.getConcern(concernId)
  )
    return {
      reason: {
        ok: false,
        reason: 'Consult this concern’s holder to save corrections; Neo only has its summary.',
      },
    };
  if (['neo.open', 'neo.work.start', 'neo.work.cancel', 'neo.concern.cancel'].includes(name))
    return { reason: { ok: false, reason: 'This action needs the user.' } };
  if (binding.kind === 'concern' && concernId !== undefined && concernId !== binding.concernId)
    return { reason: { ok: false, reason: 'This context holder cannot access another concern.' } };
  return { value: caller };
}

export function createNeoOperations(service: NeoService) {
  function path<I, O>(
    name: string,
    scope: (input: I) => string | null | undefined,
    action: (input: I, caller: OperationCaller) => O | Promise<O>
  ) {
    return (superpipe({})(name) as PipelineAPI)
      .input(['input', 'caller'])
      .pipe(
        (input: I, caller: OperationCaller) => admitNeoCaller(service, caller, name, scope(input)),
        ['input', 'caller'],
        'result:admission'
      )
      .pipe(action, ['input', 'admission'], 'admission')
      .endAsync('admission') as (input: I, caller: OperationCaller) => Promise<O | Rejection>;
  }
  function snapshot(caller: OperationCaller, requested?: string) {
    const binding = caller.sessionId ? service.repo.getBindingBySession(caller.sessionId) : null;
    const scope = binding?.kind === 'concern' ? binding.concernId : requested;
    const detailed = caller.source === 'rpc' || binding?.kind === 'concern';
    const concerns = service.repo.listConcerns().filter((item) => !scope || item.id === scope);
    const work = service.repo.listWork(scope === undefined ? undefined : scope);
    const recentWork = work.slice(0, caller.source === 'rpc' ? 50 : 10);
    const olderActiveWork =
      caller.source === 'rpc'
        ? work
            .slice(50)
            .filter((item) => item.status === 'proposed' || item.status === 'queued')
            .slice(0, 50)
        : [];
    return {
      ok: true as const,
      sessionId: service.repo.getBindingForConcern(scope ?? null)?.sessionId ?? null,
      concerns: concerns.map((item) => ({
        ...item,
        context: detailed ? item.context : '',
      })),
      consultations: service.consultations
        .list(scope ?? undefined)
        .map((item) => (detailed ? item : { ...item, question: '', answer: null })),
      work: [...recentWork, ...olderActiveWork].map((item) =>
        caller.source === 'rpc'
          ? item
          : {
              ...item,
              instruction: detailed ? item.instruction.slice(0, 1000) : '',
              report: detailed ? (item.report?.slice(0, 3000) ?? null) : null,
            }
      ),
    };
  }
  const read = path(
    'neo.snapshot',
    (input: z.infer<typeof Scope>) => input.concernId,
    (input, caller) => snapshot(caller, input.concernId)
  );
  const consult = (superpipe({})('neo.concern.consult') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(
      (caller: OperationCaller) => {
        const root = caller.sessionId && service.repo.getBindingBySession(caller.sessionId);
        return caller.source === 'mcp' && root && root.kind === 'neo'
          ? { value: root.sessionId }
          : { reason: { ok: false, reason: 'Only root Neo can consult.' } };
      },
      'caller',
      'result:admission'
    )
    .pipe(
      (input: z.infer<typeof Consult>, root: string) =>
        service.repo.getConcern(input.concernId)
          ? { value: root }
          : { reason: { ok: false, reason: 'Concern not found.' } },
      ['input', 'admission'],
      'result:admission'
    )
    .pipe((input: z.infer<typeof Consult>) => service.open(input.concernId), 'input', 'sessionId')
    .pipe(
      (input: z.infer<typeof Consult>, root: string, sessionId: string) => {
        const item = service.consultations.reserve({
          ...input,
          id: crypto.randomUUID(),
          originSessionId: root,
          sessionId,
        });
        return item
          ? { value: item }
          : {
              reason: {
                ok: false,
                reason: 'This context holder already has a pending consultation.',
              },
            };
      },
      ['input', 'admission', 'sessionId'],
      'result:admission'
    )
    .pipe(
      (input: z.infer<typeof Consult>, item: z.infer<typeof Consultation>) =>
        item.question === input.question && item.concernId === input.concernId
          ? { value: item }
          : {
              reason: { ok: false, reason: 'Request key already belongs to another consultation.' },
            },
      ['input', 'admission'],
      'result:admission'
    )
    .pipe(
      async (item: z.infer<typeof Consultation>) => {
        await service.syncConsultation(item.id);
        return { ok: true as const, consultation: service.consultations.get(item.id)! };
      },
      'admission',
      'admission'
    )
    .endAsync('admission') as (
    input: z.infer<typeof Consult>,
    caller: OperationCaller
  ) => Promise<z.infer<typeof ConsultationResult>>;
  const respond = (superpipe({})('neo.concern.respond') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(
      (input: z.infer<typeof Respond>, caller: OperationCaller) => {
        const item = service.consultations.get(input.id);
        const holder = caller.sessionId && service.repo.getBindingBySession(caller.sessionId);
        return caller.source === 'mcp' &&
          item &&
          holder &&
          holder.kind === 'concern' &&
          holder.sessionId === item.sessionId &&
          holder.concernId === item.concernId
          ? { value: item }
          : {
              reason: { ok: false, reason: 'This consultation belongs to another context holder.' },
            };
      },
      ['input', 'caller'],
      'result:admission'
    )
    .pipe(
      (input: z.infer<typeof Respond>, item: z.infer<typeof Consultation>) =>
        item.status === 'pending' || (item.status === 'reported' && item.answer === input.answer)
          ? { value: item }
          : { reason: { ok: false, reason: 'This consultation is already settled.' } },
      ['input', 'admission'],
      'result:admission'
    )
    .pipe(
      async (input: z.infer<typeof Respond>, item: z.infer<typeof Consultation>) => {
        const saved = service.consultations.finish(item.id, 'reported', input.answer)!;
        await service.syncConsultation(saved.id);
        if (saved.status !== 'reported' || saved.answer !== input.answer)
          return { ok: false as const, reason: 'This consultation is already settled.' };
        return { ok: true as const, consultation: saved };
      },
      ['input', 'admission'],
      'admission'
    )
    .endAsync('admission') as (
    input: z.infer<typeof Respond>,
    caller: OperationCaller
  ) => Promise<z.infer<typeof ConsultationResult>>;
  const open = path(
    'neo.open',
    (input: z.infer<typeof Scope>) => input.concernId,
    async (input, caller) => {
      if (input.concernId && !service.repo.getConcern(input.concernId))
        return { ok: false as const, reason: 'Concern not found.' };
      return { ...snapshot(caller), sessionId: await service.open(input.concernId ?? null) };
    }
  );
  const cancelConsultation = path(
    'neo.concern.cancel',
    (_input: z.infer<typeof WorkId>) => undefined,
    async ({ id }) => {
      const item = service.consultations.finish(id, 'failed', CONSULTATION_STOPPED);
      if (!item) return { ok: false as const, reason: 'Consultation not found.' };
      await service.syncConsultation(id);
      return { ok: true as const, consultation: service.consultations.get(id)! };
    }
  );
  const save = path(
    'neo.concern.save',
    (input: z.infer<typeof Save>) => input.id,
    (input, caller) => {
      const holder =
        caller.source === 'mcp' &&
        caller.sessionId &&
        service.repo.getBindingBySession(caller.sessionId)?.kind === 'concern';
      const turn = caller.neoTurn;
      if (holder && (!turn?.isLive() || (!turn.human && !turn.consultationId)))
        return { ok: false as const, reason: 'A live holder input is required to save context.' };
      const concern =
        holder && turn?.consultationId
          ? service.repo.saveConsultationContext(
              input,
              input.expectedRevision,
              turn.consultationId,
              caller.sessionId!
            )
          : service.repo.saveConcern(input, input.expectedRevision);
      return concern
        ? { ok: true as const, concern }
        : {
            ok: false as const,
            reason:
              holder && turn?.consultationId
                ? 'superseded: this request cannot save context. Return the uncertainty to Neo; a fresh consultation is required.'
                : 'superseded: read the current concern before saving again',
          };
    }
  );
  const propose = path(
    'neo.work.propose',
    (input: z.infer<typeof Propose>) => input.concernId,
    (input, caller) => {
      if (input.concernId && !service.repo.getConcern(input.concernId))
        return { ok: false as const, reason: 'Concern not found.' };
      const originSessionId =
        caller.sessionId ?? service.repo.getBindingForConcern(input.concernId)?.sessionId;
      if (!originSessionId) return { ok: false as const, reason: 'Open Neo first.' };
      const work = service.repo.proposeWork({
        ...input,
        requestKey: `${originSessionId}:${input.requestKey}`,
        id: crypto.randomUUID(),
        originSessionId,
      });
      return { ok: true as const, work };
    }
  );
  const start = path(
    'neo.work.start',
    (_input: z.infer<typeof WorkId>) => undefined,
    async ({ id }) => {
      if (!service.repo.getWork(id)) return { ok: false as const, reason: 'Work not found.' };
      await service.start(id);
      return { ok: true as const, work: service.repo.getWork(id)! };
    }
  );
  const cancel = path(
    'neo.work.cancel',
    (_input: z.infer<typeof WorkId>) => undefined,
    async ({ id }) => {
      if (!service.repo.getWork(id)) return { ok: false as const, reason: 'Work not found.' };
      await service.cancel(id);
      return { ok: true as const, work: service.repo.getWork(id)! };
    }
  );
  return [
    defineOperation({
      name: 'neo.concern.cancel',
      description:
        'Stop waiting for a context check. Rejects later answers without interrupting the holder session or undoing saved context.',
      inputSchema: WorkId,
      resultSchema: ConsultationResult,
      policy: { safetyClass: 'human_only' },
      execute: cancelConsultation,
    }),
    defineOperation({
      name: 'neo.concern.consult',
      description:
        'Ask a context holder a bounded question. Returns a durable receipt; the answer arrives asynchronously. Reuse requestKey on retry.',
      inputSchema: Consult,
      resultSchema: ConsultationResult,
      policy: { safetyClass: 'mutate', roles: ['neo'] },
      execute: consult,
    }),
    defineOperation({
      name: 'neo.concern.respond',
      description:
        'Return a concise answer to the root Neo for a consultation assigned to this context holder.',
      inputSchema: Respond,
      resultSchema: ConsultationResult,
      policy: { safetyClass: 'mutate', roles: ['neo'] },
      execute: respond,
    }),
    defineOperation({
      name: 'neo.open',
      description: 'Open the human Neo or concern conversation.',
      inputSchema: Scope,
      resultSchema: Snapshot,
      policy: { safetyClass: 'human_only' },
      execute: open,
    }),
    defineOperation({
      name: 'neo.snapshot',
      description:
        'Read durable concern summaries and execution receipts. Pass concernId to load that concern’s full context.',
      inputSchema: Scope,
      resultSchema: Snapshot,
      policy: { safetyClass: 'read', roles: ['neo'] },
      execute: read,
    }),
    defineOperation({
      name: 'neo.concern.save',
      description:
        'Create a continuing context only when needed, or update an existing context with revision protection. Never one concern per message.',
      inputSchema: Save,
      resultSchema: z.union([Failure, z.object({ ok: z.literal(true), concern: Concern })]),
      policy: { safetyClass: 'mutate', roles: ['neo'] },
      execute: save,
    }),
    defineOperation({
      name: 'neo.work.propose',
      description:
        'Propose work for user approval. Reuse requestKey to avoid duplicate proposals. This does not start execution.',
      inputSchema: Propose,
      resultSchema: WorkResult,
      policy: { safetyClass: 'mutate', roles: ['neo'] },
      execute: propose,
    }),
    defineOperation({
      name: 'neo.work.start',
      description: 'Start a user-approved delegation through the existing session runtime.',
      inputSchema: WorkId,
      resultSchema: WorkResult,
      policy: { safetyClass: 'human_only' },
      execute: start,
    }),
    defineOperation({
      name: 'neo.work.cancel',
      description: 'Cancel a proposal or interrupt its execution.',
      inputSchema: WorkId,
      resultSchema: WorkResult,
      policy: { safetyClass: 'human_only' },
      execute: cancel,
    }),
  ];
}
