import { existsSync } from 'node:fs';
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
  NeoWork,
} from '@hyperneo/shared/types/neo-context';
import {
  NEO_STANDING_RULE_MAX_CHARS,
  NEO_STANDING_RULES_MAX,
  neoStandingRules,
} from '@hyperneo/shared/types/settings';
import {
  requireNeoWorkTargetSession,
  requireNeoWorkTargetBinding,
  type presentNeoWorkTarget,
} from './work-target.ts';
import { CONSULTATION_STOPPED } from './consultation-policy.ts';
import {
  requireNeoAgentWorkReference,
  requireNeoAgentWorkSession,
  requireNeoAgentWorkBinding,
  requireNeoProposalReceipt,
  type NeoAgentWorkOwner,
} from './agent-work-target.ts';
import { createNeoIntakeOperation } from './intake.ts';
import { createNeoRouteCorrectOperation } from './route-correct-operation.ts';
import { createNeoRouter } from './router.ts';
import { createNeoPublicationOperation } from './publication-operation.ts';
import { createNeoPublicationReadOperation } from './publication-read-operation.ts';
import { createNeoConversationAskReadOperation } from './conversation-ask-read-operation.ts';
import { createNeoDraftRecoveryOperation } from './draft-recovery-operation.ts';
import { projectNeoSnapshotAskOrigins } from './snapshot-origins.ts';
import {
  admitNeoWorkOrigin,
  hasNeoHumanWorkInput,
  requireNeoHumanWorkOrigin,
  requireLiveNeoWorkOrigin,
  type NeoWorkOrigin,
} from './work-origin.ts';
import {
  admitNeoConsultationOrigin,
  requireLiveNeoConsultationOrigin,
  type NeoConsultationOrigin,
} from './consultation-origin.ts';
import {
  driverTargetDaemon,
  NeoDriverTargetSchema,
  readNeoDriverAdapters,
  readNeoStartFolder,
  requireNeoDriverVerb,
  requireNeoStartFolder,
  type NeoDriverTarget,
} from './driver-work.ts';
import { invokeOperation } from '../operations/invoke.ts';
import { spaceWorkRefForSession } from '../drivers/space-adapter.ts';
import { type WorkRef, WorkStatusSchema } from '../drivers/types.ts';
import { NeoWorkResourceReferences } from './work-resource-refs.ts';
import {
  createNeoAskOperations,
  isNeoCardAsk,
  NeoAskSchema,
  planNeoCardAsk,
  projectNeoSnapshotAsks,
  requireNeoWorkAsk,
  requireNeoWorkAskLink,
} from './ask-operations.ts';
import { isNeoWorkPrWaiting } from './work-prs.ts';
import { createNeoPreferenceOperation } from './model-preference.ts';

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
  z.object({
    ok: z.literal(true),
    consultation: Consultation,
    replyGuidance: z.string().optional(),
  }),
  z.object({
    ok: z.literal(true),
    waiter: ConsultationWaiter,
    replyGuidance: z.string().optional(),
  }),
]);
const Snapshot = z.union([
  Failure,
  z.object({
    ok: z.literal(true),
    sessionId: z.string().nullable(),
    concerns: z.array(Concern),
    publicAuthorBindings: z
      .array(
        z.object({
          sessionId: z.string(),
          concernId: z.string(),
          kind: z.literal('concern'),
        })
      )
      .optional(),
    work: z.array(Work),
    standingRules: z.array(z.string()).optional(),
    consultations: z.array(Consultation),
    consultationWaiters: z.array(ConsultationWaiter).optional(),
    workResources: z
      .array(z.object({ workId: z.string(), refs: NeoWorkResourceReferences.nullable() }))
      .max(100)
      .optional(),
    workDrivers: z
      .array(
        z.object({
          workId: z.string(),
          adapter: z.string(),
          daemon: z.string().nullable(),
          status: WorkStatusSchema.nullable(),
          link: z.string().nullable(),
          remoteLink: z.string().optional(),
        })
      )
      .max(100)
      .optional(),
    workContinues: z
      .array(
        z.object({
          workId: z.string(),
          count: z.number().int().nonnegative(),
          continuedAt: z.number(),
          lastMessage: z.string(),
        })
      )
      .max(100)
      .optional(),
    workPrs: z
      .array(
        z.object({
          workId: z.string(),
          prs: z.array(
            z.object({
              url: z.string(),
              state: z.enum(['OPEN', 'MERGED', 'CLOSED']),
              checks: z.enum(['pending', 'failing', 'passing', 'none']),
              review: z.enum(['approved', 'changes_requested', 'none']),
            })
          ),
          waiting: z.boolean(),
        })
      )
      .max(100)
      .optional(),
    workGoals: z
      .array(
        z.object({
          workId: z.string(),
          goal: z.string().nullable(),
          doneWhen: z.string().nullable(),
        })
      )
      .max(100)
      .optional(),
    asks: z.array(NeoAskSchema).optional(),
    preferences: z
      .object({
        model: z.string(),
        provider: z.string(),
        thinkingLevel: z.string(),
        saved: z.boolean(),
      })
      .nullable()
      .optional(),
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
  targetAgent: z
    .object({
      spaceId: z.string().min(1).max(160),
      agentId: z.string().min(1).max(160),
      sessionId: z.string().min(1).max(160),
    })
    .optional(),
  work: NeoDriverTargetSchema.optional(),
  goal: z.string().trim().min(1).max(1000).optional(),
  doneWhen: z.string().trim().min(1).max(2000).optional(),
  askId: z.string().min(1).max(160).optional(),
});
const WorkId = z.object({ id: z.string().min(1) });
const SaveRules = z.object({
  rules: z
    .array(z.string().trim().min(1).max(NEO_STANDING_RULE_MAX_CHARS))
    .max(NEO_STANDING_RULES_MAX),
});
const RulesResult = z.union([
  Failure,
  z.object({ ok: z.literal(true), standingRules: z.array(z.string()) }),
]);
const Close = z.object({ id: z.string().min(1), outcome: z.enum(['done', 'cancelled']) });
const Continue = z.object({
  id: z.string().min(1),
  message: z.string().trim().min(1).max(16000),
});
const WorkReport = z.object({
  id: z.string().min(1),
  status: z.enum(['reported', 'failed']),
  report: z.string().min(1).max(12000),
  resourceRefs: NeoWorkResourceReferences.optional(),
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

export function presentNeoConsultationReply(
  receipt: { ok: true; consultation: NeoConsultation } | { ok: true; waiter: NeoConsultationWaiter }
) {
  const status = 'consultation' in receipt ? receipt.consultation.status : receipt.waiter.status;
  const replyGuidance =
    status === 'pending' || status === 'queued'
      ? 'The context check is still pending. Reply with one short acknowledgement in the user’s language, then end this turn. Do not give a preliminary answer from summaries or older history, list facts or actions not taken, discuss revisions, or poll. Its attributed answer arrives separately.'
      : status === 'reported'
        ? 'This check has already returned. Give its useful conclusion in one or two conversational sentences for this ask only; include only evidence limits or a decision that matters. This is reported context, not proof of external execution. Do not consult again automatically.'
        : 'This check is no longer pending. Briefly explain its recorded reason without inventing an answer or restarting it.';
  return { ...receipt, replyGuidance };
}

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
  input: { targetSessionId?: string | null; work?: NeoDriverTarget },
  caller: OperationCaller
): { value: OperationCaller } | { reason: Rejection } {
  if (input.work && (input.targetSessionId || (input as { targetAgent?: unknown }).targetAgent))
    return {
      reason: {
        ok: false,
        reason: 'Choose either work (a work.find place or ref) or targetSessionId, not both.',
      },
    };
  if (input.work?.verb === 'start' && !input.work.place.folder && !input.work.place.spaceId)
    return {
      reason: {
        ok: false,
        reason:
          'Start new work in a project folder or a Space, not a place without a folder. If none clearly fits, ask the human where the work belongs.',
      },
    };
  return input.targetSessionId || input.work
    ? { value: caller }
    : {
        reason: {
          ok: false,
          reason:
            'Choose where the work runs: targetSessionId for an existing chat, or work {verb:"start", adapter, place} or {verb:"send", ref} from work.find. There is no standalone scratch session. If no project, Space or chat clearly fits, ask the human where the work belongs instead of proposing.',
        },
      };
}

export function adoptOwnedNeoTarget<
  Input extends { targetSessionId?: string | null; targetAgent?: unknown; work?: NeoDriverTarget },
>(input: Input, owned: { ref: WorkRef | null }): Input {
  return owned.ref && input.targetSessionId && !input.work && !input.targetAgent
    ? { ...input, targetSessionId: undefined, work: { verb: 'send', ref: owned.ref } }
    : input;
}

const OWNED_TARGET_HINT =
  'target_owned_context: this session belongs to Neo itself or to Space work with no single owner. To continue Space work, propose with work {verb:"send", ref} using the ref of the task or agent from work.find; snippet session ids are only for work.read.';

export function explainOwnedNeoTarget<T>(
  gate: { value: T } | { reason: { reason: string } }
): { value: T } | { reason: { reason: string } } {
  return 'reason' in gate && gate.reason.reason === 'target_owned_context'
    ? { reason: { ok: false, reason: OWNED_TARGET_HINT } as Rejection }
    : gate;
}

export function requireNeoWorkCancellation(
  work: NeoWork,
  caller: OperationCaller
): { value: NeoWork } | { reason: Rejection } {
  if (caller.source === 'mcp' && caller.sessionId !== work.originSessionId)
    return {
      reason: {
        ok: false,
        reason: 'Only the Neo session that proposed this work or the user can withdraw it.',
      },
    };
  if (work.status === 'proposed' || work.status === 'queued' || work.status === 'cancelled')
    return { value: work };
  return {
    reason: {
      ok: false,
      reason: `work_not_cancelable: this work already ${work.status}; stop it through the owning runtime (session interrupt or Space task cancel)`,
    },
  };
}

export function requireNeoWorkContinuation(
  work: NeoWork,
  caller: OperationCaller
): { value: NeoWork } | { reason: Rejection } {
  if (caller.source === 'mcp' && caller.sessionId !== work.originSessionId)
    return {
      reason: {
        ok: false,
        reason: 'Only the Neo session that proposed this work or the user can continue it.',
      },
    };
  return { value: work };
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
  if (name === 'neo.rule.save' && binding.kind !== 'neo')
    return { reason: { ok: false, reason: 'Only root Neo can save standing rules.' } };
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
  if (name === 'neo.work.start') {
    const turn = caller.neoTurn;
    if (
      !turn?.human ||
      turn.consultationId ||
      !turn.isLive() ||
      service.db.getSession(caller.sessionId!)?.status !== 'active' ||
      !hasNeoHumanWorkInput(
        caller,
        service.db.getSDKMessageRepo().getStoredPromptsByUuid(caller.sessionId!, turn.messageId)
      )
    )
      return { reason: { ok: false, reason: 'This action needs the user.' } };
  }
  if (['neo.open', 'neo.concern.cancel', 'neo.work.close'].includes(name))
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
      standingRules: neoStandingRules(service.db.getGlobalSettings?.().neo),
      publicAuthorBindings:
        caller.source === 'rpc' ? service.repo.listConcernBindings(scope ?? undefined) : [],
      concerns: concerns.map((item) => ({
        ...item,
        context: detailed ? item.context : '',
      })),
      consultations: consultations.map((item) =>
        detailed ? item : { ...item, question: '', answer: null }
      ),
      consultationWaiters: waiters.map((item) => (detailed ? item : { ...item, question: '' })),
      workDrivers: service.driverTargets.receipts(visibleWork.map((item) => item.id)),
      workGoals: service.workGoals.list(visibleWork.map((item) => item.id)),
      workContinues: service.workContinues.list(visibleWork.map((item) => item.id)),
      preferences: service.modelPreference(),
      asks: projectNeoSnapshotAsks(
        service.askRecords.list(scope === undefined ? undefined : scope),
        caller.source === 'rpc' ? 50 : 10
      ),
      workPrs: service.workPrs
        .list(visibleWork.map((item) => item.id))
        .map(({ workId, prs }) => ({ workId, prs, waiting: isNeoWorkPrWaiting(prs) })),
      workResources: visibleWork.map((item) => ({
        workId: item.id,
        refs: service.db?.neoWorkResources?.get(item.id) ?? null,
      })),
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
  const saveRules = path(
    'neo.rule.save',
    (_input: z.infer<typeof SaveRules>) => undefined,
    ({ rules }) => {
      const neo = service.db.getGlobalSettings().neo;
      const updated = service.db.updateGlobalSettings({ neo: { ...neo, standingRules: rules } });
      service.publishSettings?.(updated);
      return { ok: true as const, standingRules: rules };
    }
  );
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
    .pipe(presentNeoConsultationReply, 'admission', 'admission')
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
      (input: z.infer<typeof Propose>) => ({
        ref:
          input.targetSessionId && !input.work && !input.targetAgent
            ? spaceWorkRefForSession(service.db.getDatabase(), input.targetSessionId)
            : null,
      }),
      'input',
      'owned'
    )
    .pipe(adoptOwnedNeoTarget, ['input', 'owned'], 'input')
    .pipe(
      ({ work }: z.infer<typeof Propose>, caller: OperationCaller) =>
        work
          ? readNeoDriverAdapters(() =>
              invokeOperation(
                service.sessions.getOperationRegistry(),
                'work.adapters',
                { daemon: driverTargetDaemon(work) },
                caller
              )
            )
          : null,
      ['input', 'admission'],
      'driverAdapters'
    )
    .pipe(
      (
        input: z.infer<typeof Propose>,
        adapters: Parameters<typeof requireNeoDriverVerb>[1],
        caller: OperationCaller
      ) => requireNeoDriverVerb(input.work, adapters, caller),
      ['input', 'driverAdapters', 'admission'],
      'result:admission'
    )
    .pipe(
      (input: z.infer<typeof Propose>) => readNeoStartFolder(input.work, existsSync),
      'input',
      'startFolder'
    )
    .pipe(
      (
        input: z.infer<typeof Propose>,
        found: { exists: boolean | null },
        caller: OperationCaller
      ) => requireNeoStartFolder(input.work, found, caller),
      ['input', 'startFolder', 'admission'],
      'result:admission'
    )
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
        requireNeoWorkAsk(input.askId ? service.askRecords.get(input.askId) : null, input, caller),
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
        agent: input.targetAgent,
      }),
      'input',
      'candidate'
    )
    .pipe(requireNeoAgentWorkReference, 'candidate', 'result:admission')
    .pipe(
      (target: NeoWorkTarget) => ({
        session:
          target.targetSessionId === null ? null : inventory.readSession(target.targetSessionId),
      }),
      'candidate',
      'targetSession'
    )
    .pipe(
      (target: NeoWorkTarget) => ({
        owner: target.agent ? service.agentTargets.readOwner(target.agent) : null,
      }),
      'candidate',
      'targetOwner'
    )
    .pipe(
      (
        target: NeoWorkTarget,
        { session }: { session: ReturnType<typeof inventory.readSession> },
        { owner }: { owner: NeoAgentWorkOwner | null }
      ) =>
        explainOwnedNeoTarget(
          target.agent
            ? requireNeoAgentWorkSession(target, session, owner)
            : requireNeoWorkTargetSession(target, session)
        ),
      ['candidate', 'targetSession', 'targetOwner'],
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
        explainOwnedNeoTarget(
          target.agent
            ? requireNeoAgentWorkBinding(target, binding)
            : requireNeoWorkTargetBinding(target, binding)
        ),
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
        if (input.work) {
          const proposed = service.driverTargets.propose(
            service.repo,
            {
              ...input,
              ...origin,
              requestKey: `${origin.originSessionId}:${input.requestKey}`,
              id: target.id,
            },
            input.work
          );
          if (JSON.stringify(proposed.target) !== JSON.stringify(input.work))
            return {
              reason: {
                ok: false,
                reason: 'This request key belongs to another execution target.',
              },
            };
          return requireNeoProposalReceipt(target, origin, { work: proposed.work, agent: null });
        }
        const receipt = service.agentTargets.propose(
          service.repo,
          {
            ...input,
            ...origin,
            requestKey: `${origin.originSessionId}:${input.requestKey}`,
            id: target.id,
          },
          target.agent
        );
        if (service.driverTargets.get(receipt.work.id))
          return {
            reason: {
              ok: false,
              reason: 'This request key belongs to another execution target.',
            },
          };
        return requireNeoProposalReceipt(target, origin, receipt);
      },
      ['input', 'origin', 'caller', 'admission'],
      'result:admission'
    )
    .pipe(
      (input: z.infer<typeof Propose>, origin: NeoWorkOrigin, receipt: { work: NeoWork }) => {
        const planned = planNeoCardAsk(input, origin);
        const filed = service.askRecords.forWork(receipt.work.id);
        const opened =
          planned && !filed
            ? service.askRecords.open({ ...planned, id: crypto.randomUUID() })
            : null;
        return {
          askId:
            input.askId ??
            filed?.id ??
            (planned && isNeoCardAsk(opened, planned) ? opened?.id : undefined),
        };
      },
      ['input', 'origin', 'admission'],
      'ask'
    )
    .pipe(
      (ask: { askId?: string }, receipt: { work: NeoWork }) => ({
        owner: ask.askId ? service.askRecords.link(ask.askId, receipt.work.id) : null,
      }),
      ['ask', 'admission'],
      'askLink'
    )
    .pipe(requireNeoWorkAskLink, ['ask', 'askLink', 'admission'], 'result:admission')
    .pipe(
      (input: z.infer<typeof Propose>, receipt: { work: NeoWork }) => {
        service.workGoals.record(receipt.work.id, input.goal ?? null, input.doneWhen ?? null);
        return true;
      },
      ['input', 'admission'],
      'goalRecorded'
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
    async ({ id }, caller) => {
      const work = service.repo.getWork(id);
      if (!work) return { ok: false as const, reason: 'Work not found.' };
      const target = service.resolveWorkTarget(id);
      if (!target.accepted) return { ok: false as const, reason: target.reason };
      const origin = requireNeoHumanWorkOrigin(work, caller);
      if ('reason' in origin) return origin.reason;
      await service.start(id);
      return { ok: true as const, work: service.repo.getWork(id)! };
    }
  );
  const continueWork = path(
    'neo.work.continue',
    (_input: z.infer<typeof Continue>) => undefined,
    async ({ id, message }, caller) => {
      const work = service.repo.getWork(id);
      if (!work) return { ok: false as const, reason: 'work_not_found' };
      const admission = requireNeoWorkContinuation(work, caller);
      if ('reason' in admission) return admission.reason;
      return service.continueWork(id, message);
    }
  );
  const retry = path(
    'neo.work.retry',
    (_input: z.infer<typeof WorkId>) => undefined,
    async ({ id }, caller) => {
      const work = service.repo.getWork(id);
      if (!work) return { ok: false as const, reason: 'work_not_found' };
      const admission = requireNeoWorkContinuation(work, caller);
      if ('reason' in admission) return admission.reason;
      const target = service.driverTargets.get(id);
      const folder = requireNeoStartFolder(target, readNeoStartFolder(target, existsSync), work);
      if ('reason' in folder) return folder.reason;
      return service.retryWork(id);
    }
  );
  const close = path(
    'neo.work.close',
    (_input: z.infer<typeof Close>) => undefined,
    async ({ id, outcome }) => service.close(id, outcome)
  );
  const cancel = path(
    'neo.work.cancel',
    (_input: z.infer<typeof WorkId>) => undefined,
    async ({ id }, caller) => {
      const work = service.repo.getWork(id);
      if (!work) return { ok: false as const, reason: 'work_not_found' };
      const admission = requireNeoWorkCancellation(work, caller);
      if ('reason' in admission) return admission.reason;
      if (work.status !== 'cancelled') await service.cancel(id);
      return { ok: true as const, work: service.repo.getWork(id)! };
    }
  );
  return [
    createNeoIntakeOperation(
      service.db,
      service.repo,
      service.notifyChanged,
      createNeoRouter(service.db, service.repo, (concernId) => service.open(concernId))
    ),
    createNeoPublicationOperation(service.publish),
    createNeoRouteCorrectOperation(service.db, service.repo),
    createNeoPublicationReadOperation(service.repo, service.publications),
    createNeoConversationAskReadOperation(service.repo, service.asks),
    createNeoDraftRecoveryOperation(service),
    createNeoPreferenceOperation(service),
    ...createNeoAskOperations(service, (caller, name, concernId) =>
      admitNeoCaller(service, caller, name, concernId)
    ),
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
      name: 'neo.rule.save',
      description:
        'Replace the saved standing rules that neo.snapshot returns as standingRules. Save when the human states or corrects something lasting about how work should go (what done means, where a project lives, which app to use), answers your question about it, or when you reuse precedent from earlier work, without asking whether to save it; read the current list from neo.snapshot first and keep the rules they did not change. Up to 20 rules of up to 500 characters.',
      inputSchema: SaveRules,
      resultSchema: RulesResult,
      policy: { safetyClass: 'mutate', roles: ['neo'] },
      execute: saveRules,
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
        'Propose work for user approval from the current live input. Every proposal must choose where it runs. targetSessionId names an exact ordinary project/non-project chat, or an existing active long-horizon Space agent with matching targetAgent {spaceId,agentId,sessionId} from daemon.snapshot; there is no standalone scratch session. Instead of targetSessionId, work may name a drivers target: {verb:"start", adapter, place, model?} to start new work in a place from work.find (model only applies to a new HyperNeo session; set it when the human names one) (for a new project folder that does not exist yet, use place {machine, daemon?, folder, name} and add createFolder:true; the folder must be under the home folder with an existing parent; never ask another session to create a folder), or {verb:"send", ref} to continue work it found; starting the proposal then runs work.start or work.send as Neo. Managed targets keep native tools and permissions. A targetSessionId that belongs to exactly one Space task or agent is proposed as work {verb:"send"} to that task or agent; other owned and Neo-bound sessions are refused with the route to use. Instructions alone do not bind a target. The target is immutable for this requestKey. When no target clearly fits, ask the human instead of proposing. Set goal to what the human asked, in their own words, and doneWhen to a short checklist of what finished means; both are sent to the worker with the instruction, so a shorter instruction never drops the real goal. This does not start execution.',
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
        'Return explicit reported or failed evidence (up to 12,000 characters) for the exact work receipt assigned to this execution session. Optionally include resourceRefs: up to 16 exact {kind,id} references from daemon.snapshot or native operation results, for resources involved in this receipt only. Do not include every task sharing this manager. The actual MCP recipient must match; roles or arguments cannot replace it. Identical retries reuse the report and supplied reference set; settled references cannot change. Reports and references are claims, not independently verified completion.',
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
      name: 'neo.work.continue',
      description:
        'Send the next instruction to started work whose session stopped before its doneWhen was met, in the same session with its context. The goal and checklist are attached again. Reported work reopens as queued. Allowed up to 5 continues or until 12 hours after the work started; past that it rejects with continue_budget_spent and you must ask the human. Only the Neo session that proposed the work or the user can continue it.',
      inputSchema: Continue,
      resultSchema: WorkResult,
      policy: { safetyClass: 'mutate', roles: ['neo'] },
      execute: continueWork,
    }),
    defineOperation({
      name: 'neo.work.retry',
      description:
        'Try a failed hand-off again on the same work card: only work that failed before its driver started it (for example the claude CLI was logged out) can be retried. The card goes back to queued and the same approved instruction is sent to the same target. Use this instead of proposing new work for the same ask. Started work uses neo.work.continue instead. Only the Neo session that proposed the work or the user can retry it.',
      inputSchema: WorkId,
      resultSchema: WorkResult,
      policy: { safetyClass: 'mutate', roles: ['neo'] },
      execute: retry,
    }),
    defineOperation({
      name: 'neo.work.close',
      description:
        'Close a work card as done or cancelled from any state, for the user only. Closing queued work stops the Codex or Claude work behind it. Done is recorded as a report saying the user closed it; cancelled work stays cancelled. Neo cannot close cards: when a card looks stale, propose closing it to the user instead.',
      inputSchema: Close,
      resultSchema: WorkResult,
      policy: { safetyClass: 'human_only' },
      execute: close,
    }),
    defineOperation({
      name: 'neo.work.cancel',
      description:
        'Withdraw work before it finishes: proposed or queued work becomes cancelled, disappears from pending surfaces, and its Neo-owned execution session is interrupted. The Neo session that proposed the work or the human can cancel. Retrying on already-cancelled work succeeds without another write. Work that already reported or failed rejects with work_not_cancelable; stop live execution through the owning runtime (session interrupt or Space task cancel) instead.',
      inputSchema: WorkId,
      resultSchema: WorkResult,
      policy: { safetyClass: 'mutate', roles: ['neo'] },
      execute: cancel,
    }),
  ];
}
