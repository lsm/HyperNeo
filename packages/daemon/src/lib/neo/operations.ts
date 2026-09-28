import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import type { OperationCaller } from '../operations/registry.ts';
import { defineOperation } from '../operations/registry.ts';
import type { NeoService } from './service.ts';
import { DaemonInventoryRepository } from '../../storage/repositories/daemon-inventory-repository.ts';
import type { NeoWorkTarget } from '../../storage/repositories/neo-repository.ts';
import type {
  NeoBinding,
  NeoConsultation,
  NeoConsultationWaiter,
} from '@hyperneo/shared/types/neo-context';
import {
  requireNeoWorkTargetSession,
  requireNeoWorkTargetBinding,
  type presentNeoWorkTarget,
} from './work-target.ts';
import { CONSULTATION_STOPPED } from './consultation-policy.ts';
import { createNeoIntakeOperation } from './intake.ts';
import { projectNeoSnapshotAskOrigins } from './snapshot-origins.ts';
import { admitNeoWorkOrigin, requireLiveNeoWorkOrigin, type NeoWorkOrigin } from './work-origin.ts';
import {
  admitNeoConsultationOrigin,
  requireLiveNeoConsultationOrigin,
  type NeoConsultationOrigin,
} from './consultation-origin.ts';

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
  originMessageId: z.string().nullable(),
  title: z.string(),
  instruction: z.string(),
  targetSessionId: z.string().nullable().optional(),
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
  originMessageId: z.string().nullable(),
  sessionId: z.string(),
  question: z.string(),
  status: z.enum(['pending', 'reported', 'failed']),
  answer: z.string().nullable(),
  createdAt: z.number(),
});
const ConsultationWaiter = Consultation.omit({ answer: true, status: true }).extend({
  originMessageId: z.string(),
  status: z.enum(['queued', 'admitted', 'cancelled']),
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
  z.object({ ok: z.literal(true), waiter: ConsultationWaiter }),
]);
const Snapshot = z.union([
  Failure,
  z.object({
    ok: z.literal(true),
    sessionId: z.string().nullable(),
    concerns: z.array(Concern),
    work: z.array(Work),
    consultations: z.array(Consultation),
    consultationWaiters: z.array(ConsultationWaiter).optional(),
    askOrigins: z
      .array(
        z.object({
          kind: z.enum(['work', 'consultation']),
          id: z.string(),
          origin: z.object({ sessionId: z.string(), messageId: z.string() }).nullable(),
        })
      )
      .optional(),
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
  targetSessionId: z.string().min(1).max(160).nullable().optional(),
});
const WorkId = z.object({ id: z.string().min(1) });
const WorkReport = z.object({
  id: z.string().min(1),
  status: z.enum(['reported', 'failed']),
  report: z.string().min(1).max(12000),
});
const WorkReportResult = z.union([
  z.object({ accepted: z.literal(false), reason: z.string() }),
  z.object({
    accepted: z.literal(true),
    workId: z.string(),
    status: z.enum(['reported', 'failed']),
    replayed: z.boolean(),
  }),
]);
type Rejection = { ok: false; reason: string };

export function requireNeoConsultationReceipt(
  input: z.infer<typeof Consult>,
  item: NeoConsultation | NeoConsultationWaiter | null,
  origin: NeoConsultationOrigin,
  sessionId: string
): { value: NeoConsultation | NeoConsultationWaiter } | { reason: Rejection } {
  if (
    !item ||
    item.requestKey !== input.requestKey ||
    item.question !== input.question ||
    item.concernId !== input.concernId ||
    item.originSessionId !== origin.originSessionId ||
    item.originMessageId !== origin.originMessageId ||
    item.sessionId !== sessionId
  )
    return {
      reason: {
        ok: false,
        reason: 'Request key already belongs to another consultation or input.',
      },
    };
  return item.status === 'cancelled' || item.status === 'admitted'
    ? { reason: { ok: false, reason: 'This queued consultation is no longer available.' } }
    : { value: item };
}

export function requireNeoExecutionChoice(
  input: { targetSessionId?: string | null },
  caller: OperationCaller
): { value: OperationCaller } | { reason: Rejection } {
  return caller.source !== 'mcp' || input.targetSessionId !== undefined
    ? { value: caller }
    : {
        reason: {
          ok: false,
          reason:
            'Choose targetSessionId explicitly: use the exact existing chat ID to reuse it, or null for genuinely self-contained scratch work. An instruction mentioning a chat does not bind its execution target. Inspect operations.describe for neo.work.propose, then retry.',
        },
      };
}

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
  const inventory = new DaemonInventoryRepository(service.db.getDatabase());
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
    const visibleWork = [...recentWork, ...olderActiveWork];
    const consultations = service.consultations.list(scope ?? undefined);
    const waiters = service.consultationWaiters.queued(scope ?? undefined);
    return {
      ok: true as const,
      sessionId: service.repo.getBindingForConcern(scope ?? null)?.sessionId ?? null,
      concerns: concerns.map((item) => ({
        ...item,
        context: detailed ? item.context : '',
      })),
      consultations: consultations.map((item) =>
        detailed ? item : { ...item, question: '', answer: null }
      ),
      consultationWaiters: waiters.map((item) => (detailed ? item : { ...item, question: '' })),
      askOrigins: projectNeoSnapshotAskOrigins(
        visibleWork,
        [...consultations, ...waiters],
        service.resolveAskOrigin
      ),
      work: visibleWork.map((item) =>
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
      (caller: OperationCaller) =>
        admitNeoConsultationOrigin(
          caller,
          caller.sessionId ? service.repo.getBindingBySession(caller.sessionId) : null
        ),
      'caller',
      'result:admission'
    )
    .pipe(
      (input: z.infer<typeof Consult>, root: NeoConsultationOrigin) =>
        service.repo.getConcern(input.concernId)
          ? { value: root }
          : { reason: { ok: false, reason: 'Concern not found.' } },
      ['input', 'admission'],
      'result:admission'
    )
    .pipe((origin: NeoConsultationOrigin) => origin, 'admission', 'origin')
    .pipe((input: z.infer<typeof Consult>) => service.open(input.concernId), 'input', 'sessionId')
    .pipe(
      (origin: NeoConsultationOrigin, caller: OperationCaller) =>
        requireLiveNeoConsultationOrigin(origin, caller.neoTurn),
      ['origin', 'caller'],
      'result:admission'
    )
    .pipe(
      (
        input: z.infer<typeof Consult>,
        root: NeoConsultationOrigin,
        sessionId: string,
        caller: OperationCaller
      ) => {
        const live = requireLiveNeoConsultationOrigin(root, caller.neoTurn);
        if ('reason' in live) return live;
        const item =
          service.consultations.find(root.originSessionId, input.requestKey) ??
          service.consultationWaiters.find(root.originSessionId, input.requestKey) ??
          service.consultationWaiters.enqueue({
            ...input,
            id: crypto.randomUUID(),
            ...root,
            sessionId,
          });
        return { value: item };
      },
      ['input', 'admission', 'sessionId', 'caller'],
      'result:admission'
    )
    .pipe(
      requireNeoConsultationReceipt,
      ['input', 'admission', 'origin', 'sessionId'],
      'result:admission'
    )
    .pipe(
      async (item: NeoConsultation | NeoConsultationWaiter) => {
        if (item.status === 'queued') await service.dispatchConsultationWaiter(item.concernId);
        const consultation = service.consultations.get(item.id);
        if (consultation) {
          await service.syncConsultation(item.id);
          return { ok: true as const, consultation: service.consultations.get(item.id)! };
        }
        return { ok: true as const, waiter: service.consultationWaiters.get(item.id)! };
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
      const waiter = service.consultationWaiters.get(id);
      if (waiter?.status === 'queued' || waiter?.status === 'cancelled') {
        const cancelled = service.consultationWaiters.cancel(id)!;
        await service.dispatchConsultationWaiter(cancelled.concernId);
        return { ok: true as const, waiter: cancelled };
      }
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
  const propose = (superpipe({})('neo.work.propose') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(
      (input: z.infer<typeof Propose>, caller: OperationCaller) =>
        admitNeoCaller(service, caller, 'neo.work.propose', input.concernId),
      ['input', 'caller'],
      'result:admission'
    )
    .pipe(requireNeoExecutionChoice, ['input', 'admission'], 'result:admission')
    .pipe(
      (input: z.infer<typeof Propose>, caller: OperationCaller) =>
        input.concernId && !service.repo.getConcern(input.concernId)
          ? { reason: { ok: false, reason: 'Concern not found.' } }
          : { value: caller },
      ['input', 'admission'],
      'result:admission'
    )
    .pipe(
      (input: z.infer<typeof Propose>, caller: OperationCaller) =>
        admitNeoWorkOrigin(
          caller,
          caller.sessionId ?? service.repo.getBindingForConcern(input.concernId)?.sessionId
        ),
      ['input', 'admission'],
      'result:admission'
    )
    .pipe((origin: NeoWorkOrigin) => origin, 'admission', 'origin')
    .pipe(
      (input: z.infer<typeof Propose>) => ({
        id: crypto.randomUUID(),
        targetSessionId: input.targetSessionId ?? null,
      }),
      'input',
      'candidate'
    )
    .pipe(
      (target: NeoWorkTarget) => ({
        session:
          target.targetSessionId === null ? null : inventory.readSession(target.targetSessionId),
      }),
      'candidate',
      'targetSession'
    )
    .pipe(
      (target: NeoWorkTarget, { session }: { session: ReturnType<typeof inventory.readSession> }) =>
        requireNeoWorkTargetSession(target, session),
      ['candidate', 'targetSession'],
      'result:admission'
    )
    .pipe(
      (target: NeoWorkTarget) => ({
        binding:
          target.targetSessionId === null
            ? null
            : service.repo.getBindingBySession(target.targetSessionId),
      }),
      'admission',
      'targetBinding'
    )
    .pipe(
      (target: NeoWorkTarget, { binding }: { binding: NeoBinding | null }) =>
        requireNeoWorkTargetBinding(target, binding),
      ['admission', 'targetBinding'],
      'result:admission'
    )
    .pipe(
      (
        input: z.infer<typeof Propose>,
        origin: NeoWorkOrigin,
        caller: OperationCaller,
        target: NeoWorkTarget
      ) => {
        const live = requireLiveNeoWorkOrigin(origin, caller);
        if ('reason' in live) return live;
        const work = service.repo.proposeWork({
          ...input,
          ...origin,
          requestKey: `${origin.originSessionId}:${input.requestKey}`,
          id: target.id,
        });
        return work.originMessageId === origin.originMessageId &&
          work.originSessionId === origin.originSessionId
          ? work.targetSessionId === target.targetSessionId
            ? { value: { ok: true as const, work } }
            : {
                reason: {
                  ok: false,
                  reason: 'This request key belongs to another execution target.',
                },
              }
          : { reason: { ok: false, reason: 'This request key belongs to another input.' } };
      },
      ['input', 'origin', 'caller', 'admission'],
      'result:admission'
    )
    .endAsync('admission') as (
    input: z.infer<typeof Propose>,
    caller: OperationCaller
  ) => Promise<
    | z.infer<typeof WorkResult>
    | Extract<ReturnType<typeof presentNeoWorkTarget>, { accepted: false }>
  >;
  const start = path(
    'neo.work.start',
    (_input: z.infer<typeof WorkId>) => undefined,
    async ({ id }) => {
      if (!service.repo.getWork(id)) return { ok: false as const, reason: 'Work not found.' };
      const target = service.resolveWorkTarget(id);
      if (!target.accepted) return { ok: false as const, reason: target.reason };
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
    createNeoIntakeOperation(service.db, service.repo),
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
        'Ask a context holder a bounded question from the current root input. Returns a correlated durable receipt; the answer arrives asynchronously. Reuse requestKey only for retries of this input; use a new key for another ask.',
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
        'Propose work for user approval from the current live input. MCP proposals must explicitly choose targetSessionId: an exact ordinary project/non-project chat from daemon.snapshot, or null for self-contained scratch work. Space/task/workflow-owned and Neo-bound sessions keep their owning operations. Instructions alone do not bind a target. The target is immutable for this requestKey. Local-human RPC retains omitted-target scratch compatibility. This does not start execution.',
      inputSchema: Propose,
      resultSchema: WorkResult,
      policy: { safetyClass: 'mutate', roles: ['neo'] },
      execute: async (input, caller) => {
        const result = await propose(input, caller);
        return 'accepted' in result ? { ok: false as const, reason: result.reason } : result;
      },
    }),
    defineOperation({
      name: 'neo.work.report',
      description:
        'Return explicit reported or failed evidence (up to 12,000 characters) for the exact work receipt assigned to this execution session. The actual MCP recipient must match; roles or arguments cannot replace it. Identical retries reuse the report. A report is a claim, not independently verified completion.',
      inputSchema: WorkReport,
      resultSchema: WorkReportResult,
      policy: { safetyClass: 'mutate' },
      execute: (input, caller) => service.reportWork(input, caller),
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
