import { existsSync } from 'node:fs';
import {
  hasNeoWorkRequest,
  neoTargetSessionId,
  readNeoIdleSessions,
  readNeoSessionLoad,
  requireIdleNeoTarget,
} from './session-load.ts';
import {
  NEO_CONSULTATION_RECEIPT_CLOSED,
  NEO_CONSULTATION_RECEIPT_PENDING,
  NEO_CONSULTATION_RECEIPT_RETURNED,
} from '@hyperneo/prompts';
import superpipe, { type PipelineAPI } from 'superpipe';
import { THINKING_LEVELS } from '@hyperneo/shared';
import { z } from 'zod';
import type { OperationCaller } from '../operations/registry.ts';
import { defineOperation } from '../operations/registry.ts';
import type { NeoService } from './service.ts';
import { DaemonInventoryRepository } from '../../storage/repositories/daemon-inventory-repository.ts';
import type { NeoWorkTarget } from '../../storage/repositories/neo-repository.ts';
import type {
  NeoConcern,
  NeoConsultation,
  NeoConsultationWaiter,
  NeoWork,
} from '@hyperneo/shared/types/neo-context';
import {
  isPooledNeoAsk,
  type NeoAsk,
  type NeoReceiptAskOrigin,
  type NeoSnapshot,
  type NeoWaitingOnHuman,
  type NeoWorkResourceReceipt,
} from '@hyperneo/shared/types/neo-snapshot';
import {
  NEO_STANDING_RULE_MAX_CHARS,
  NEO_STANDING_RULES_MAX,
  neoStandingRules,
  type NeoSettings,
} from '@hyperneo/shared/types/settings';
import {
  checkNeoWorkTarget,
  requireCheckedNeoWorkTarget,
  type presentNeoWorkTarget,
} from './work-target.ts';
import { CONSULTATION_STOPPED } from './consultation-policy.ts';
import { requireNeoProposal, type NeoProposal } from './agent-work-target.ts';
import { createNeoIntakeOperation } from './intake.ts';
import { createNeoRouteCorrectOperation } from './route-correct-operation.ts';
import { createNeoAskForwardOperation, neoForwardedText } from './ask-forward-operation.ts';
import { createNeoReorganizeOperation, type NeoReorganizeRuntime } from './reorganize-operation.ts';
import { neoSessionStatus } from './direct-reply-fallback.ts';
import { createNeoRouter, type NeoRouter, reopenNeoHolder } from './router.ts';
import { createNeoPublicationOperation } from './publication-operation.ts';
import { createNeoPublicationReadOperation } from './publication-read-operation.ts';
import {
  createNeoConversationAskReadOperation,
  createNeoConversationImageReadOperation,
} from './conversation-ask-read-operation.ts';
import { createNeoDraftRecoveryOperation } from './draft-recovery-operation.ts';
import {
  compactNeoSnapshotAsks,
  compactNeoSnapshotCards,
  fitNeoSnapshotBudget,
  NEO_MCP_SNAPSHOT_BUDGET,
} from './snapshot-compact.ts';
import { projectNeoSnapshotAskOrigins } from './snapshot-origins.ts';
import {
  admitNeoWorkOrigin,
  hasNeoHumanWorkInput,
  isNeoAskStartApproved,
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
  requireNeoWorkRetryable,
  type NeoDriverTarget,
  type NeoWorkRetryCard,
} from './driver-work.ts';
import { invokeOperation } from '../operations/invoke.ts';
import { spaceWorkRefForSession } from '../drivers/space-adapter.ts';
import type { WorkRef } from '../drivers/types.ts';
import {
  NEO_SESSION_MUTES_MAX,
  NeoSessionNoticeGroupSchema,
  NeoSessionNoticeSchema,
  latestNeoSessionNoticeGroups,
  neoSessionKey,
  planNeoSessionMutes,
  type NeoSessionNotice,
} from './session-watch.ts';
import {
  findNeoSessionNotice,
  isNeoAdoptOnlyAsk,
  isNeoTrackedFollowUp,
  requireNeoTrackRoot,
  requireNeoTrackableSession,
  requireNeoTrackedAdoption,
  reserveNeoAdoption,
} from './session-track.ts';
import { NeoWorkResourceReferences } from './work-resource-refs.ts';
import {
  createNeoAskOperations,
  isNeoCardAsk,
  NeoAskSchema,
  planNeoAskItems,
  planNeoCardAsk,
  projectNeoSnapshotAsks,
  requireNeoWorkAsk,
  requireNeoWorkAskLink,
  requireNeoWorkAskLive,
  requireNeoWorkAskOwner,
} from './ask-operations.ts';
import { isNeoWorkPrWaiting } from './packs/coding/work-prs.ts';
import { neoWaitingOnHuman } from './waiting-reminders.ts';
import {
  neoWorkSupersedeCandidates,
  requireNeoWorkSupersedable,
  requireNeoWorkSupersedeDecision,
} from './work-supersede.ts';
import { createNeoPreferenceOperation } from './model-preference.ts';
import { planNeoSavedRules } from './saved-rules.ts';
import { projectNeoCardViews } from './card-views.ts';
import { NeoAskViewSchema, NeoCardViewSchema } from './card-view-schema.ts';
import { projectNeoAskViews } from './ask-views.ts';
import { unmutedNeoAskSessions } from './session-ask-links.ts';
import { NEO_WORK_FOLLOW_MAX_AGE_MS } from './work-follow.ts';

type ZodShape<T> = { [K in keyof Required<T>]: z.ZodType<T[K]> };

const NEO_SNAPSHOT_FORWARDS = 100;
const Concern = z.object({
  id: z.string(),
  title: z.string(),
  summary: z.string(),
  context: z.string(),
  revision: z.number(),
  createdAt: z.number(),
  updatedAt: z.number(),
} satisfies ZodShape<NeoConcern>);
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
} satisfies ZodShape<NeoWork>);
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
} satisfies ZodShape<NeoConsultation>);
const ConsultationWaiter = z.object({
  id: z.string(),
  requestKey: z.string(),
  concernId: z.string(),
  originSessionId: z.string(),
  originMessageId: z.string(),
  sessionId: z.string(),
  question: z.string(),
  status: z.enum(['queued', 'admitted', 'cancelled']),
  createdAt: z.number(),
} satisfies ZodShape<NeoConsultationWaiter>);
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
const SnapshotOk = z.object({
  ok: z.literal(true),
  sessionId: z.string().nullable(),
  concerns: z.array(Concern),
  publicAuthorBindings: z
    .array(
      z.object({
        sessionId: z.string(),
        concernId: z.string(),
        kind: z.literal('concern'),
      } satisfies ZodShape<NonNullable<NeoSnapshot['publicAuthorBindings']>[number]>)
    )
    .optional(),
  askForwards: z
    .array(
      z.object({
        askSessionId: z.string(),
        askMessageId: z.string(),
        hop: z.number().int(),
        fromSessionId: z.string(),
        toSessionId: z.string(),
      } satisfies ZodShape<NonNullable<NeoSnapshot['askForwards']>[number]>)
    )
    .max(NEO_SNAPSHOT_FORWARDS)
    .optional(),
  work: z.array(Work),
  standingRules: z.array(z.string()).optional(),
  consultations: z.array(Consultation),
  consultationWaiters: z.array(ConsultationWaiter).optional(),
  workResources: z
    .array(
      z.object({
        workId: z.string(),
        refs: NeoWorkResourceReferences.nullable(),
      } satisfies ZodShape<NeoWorkResourceReceipt>)
    )
    .max(100)
    .optional(),
  sessionNotices: z.array(NeoSessionNoticeSchema).max(20).optional(),
  sessionNoticeGroups: z.array(NeoSessionNoticeGroupSchema).max(10).optional(),
  mutedSessions: z.array(z.string()).max(NEO_SESSION_MUTES_MAX).optional(),
  asks: z.array(NeoAskSchema).optional(),
  cards: z.array(NeoCardViewSchema).max(100),
  sessionLoad: z
    .array(z.object({ sessionId: z.string(), liveCards: z.number().int(), busy: z.boolean() }))
    .max(50)
    .optional(),
  askViews: z.array(NeoAskViewSchema),
  waitingOnHuman: z
    .object({
      note: z.string(),
      asks: z.array(
        z.object({
          id: z.string(),
          title: z.string(),
          status: NeoAskSchema.shape.status,
          question: z.string(),
        } satisfies ZodShape<NeoWaitingOnHuman['asks'][number]>)
      ),
    } satisfies ZodShape<NeoWaitingOnHuman>)
    .optional(),
  preferences: z
    .object({
      model: z.string(),
      provider: z.string(),
      thinkingLevel: z.enum(THINKING_LEVELS),
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
      } satisfies ZodShape<NeoReceiptAskOrigin>)
    )
    .optional(),
  trimmed: z.string().optional(),
} satisfies ZodShape<NeoSnapshot>);
const Snapshot = z.union([Failure, SnapshotOk]);
const WorkResult = z.union([Failure, z.object({ ok: z.literal(true), work: Work })]);
const Scope = z
  .object({ concernId: z.string().min(1).optional(), askId: z.string().min(1).optional() })
  .default({});
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
  supersedes: z.string().min(1).max(160).nullable().optional(),
  allowBusyTarget: z.boolean().optional(),
});
const WorkId = z.object({ id: z.string().min(1) });
const SessionMute = z.object({ key: z.string().trim().min(1).max(400), muted: z.boolean() });
const SessionMuteResult = z.union([
  Failure,
  z.object({ ok: z.literal(true), mutedSessions: z.array(z.string()) }),
]);
const SessionTrack = z.object({ key: z.string().trim().min(1).max(400) });
const SessionTrackResult = z.union([Failure, z.object({ ok: z.literal(true) })]);
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
const PackRead = z.object({ id: z.string().trim().min(1).max(80) });
const PackReadResult = z.union([
  Failure,
  z.object({
    ok: z.literal(true),
    pack: z.object({ id: z.string(), describe: z.string() }),
    instructions: z.string(),
  }),
]);
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
type NeoWorkRetryFound = {
  work: NeoWork | null;
  target: ReturnType<NeoService['driverTargets']['get']>;
};
type NeoWorkStartFound = { work: NeoWork | null; ask: NeoAsk | null };

export function presentNeoConsultationReply(
  receipt: { ok: true; consultation: NeoConsultation } | { ok: true; waiter: NeoConsultationWaiter }
) {
  const status = 'consultation' in receipt ? receipt.consultation.status : receipt.waiter.status;
  const replyGuidance =
    status === 'pending' || status === 'queued'
      ? NEO_CONSULTATION_RECEIPT_PENDING
      : status === 'reported'
        ? NEO_CONSULTATION_RECEIPT_RETURNED
        : NEO_CONSULTATION_RECEIPT_CLOSED;
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

export function requireNeoProposalDoneWhen(
  input: { doneWhen?: string; askId?: string },
  caller: OperationCaller
): { value: OperationCaller } | { reason: Rejection } {
  return input.doneWhen || input.askId || caller.source !== 'mcp'
    ? { value: caller }
    : {
        reason: {
          ok: false,
          reason:
            'Set doneWhen to a short checklist of what finished means (and goal to what the human asked), or pass the askId of the ask this work serves.',
        },
      };
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
            'Choose where the work runs: targetSessionId for an existing chat, or work {verb:"start", adapter, place} or {verb:"send", ref} from work.find, or {verb:"adopt", ref} for a session the human tapped Track on. There is no standalone scratch session. If no project, Space or chat clearly fits, ask the human where the work belongs instead of proposing.',
        },
      };
}

type OwnedLookupInput = {
  targetSessionId?: string | null;
  targetAgent?: unknown;
  work?: NeoDriverTarget;
};

export function ownedLookupSessionId(input: OwnedLookupInput): string | null {
  return input.targetSessionId && !input.work && !input.targetAgent ? input.targetSessionId : null;
}

export function adoptOwnedNeoTarget<Input extends OwnedLookupInput>(
  input: Input,
  owned: { ref: WorkRef | null }
): Input {
  return owned.ref && ownedLookupSessionId(input)
    ? { ...input, targetSessionId: undefined, work: { verb: 'send', ref: owned.ref } }
    : input;
}

export function adoptNeoRefTarget<Input extends OwnedLookupInput>(input: Input): Input {
  const id = ownedLookupSessionId(input);
  return id?.startsWith('local_')
    ? {
        ...input,
        targetSessionId: undefined,
        work: { verb: 'send', ref: { adapter: 'claude-desktop', id } },
      }
    : input;
}

const MISSING_TARGET_HINT =
  'target_session_not_found: no HyperNeo session has this id. A work.find ref from another adapter (a Codex thread or a Claude session) is proposed as work {verb:"send", ref} with the whole ref, never as targetSessionId.';

const OWNED_TARGET_HINT =
  'target_owned_context: this session belongs to Neo itself or to Space work with no single owner. To continue Space work, propose with work {verb:"send", ref} using the ref of the task or agent from work.find; snippet session ids are only for work.read.';

function explainOwnedNeoTarget<T>(
  gate: { value: T } | { reason: { reason: string } },
  candidate: { agent?: unknown }
): { value: T } | { reason: { reason: string } } {
  if ('reason' in gate && gate.reason.reason === 'target_session_not_found' && !candidate.agent)
    return { reason: { ok: false, reason: MISSING_TARGET_HINT } as Rejection };
  return 'reason' in gate && gate.reason.reason === 'target_owned_context'
    ? { reason: { ok: false, reason: OWNED_TARGET_HINT } as Rejection }
    : gate;
}

function requireNeoWorkCancellation(
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

function requireNeoWorkProposer(
  work: NeoWork,
  caller: OperationCaller,
  verb: 'continue' | 'retry'
): { value: NeoWork } | { reason: Rejection } {
  if (caller.source === 'mcp' && caller.sessionId !== work.originSessionId)
    return {
      reason: {
        ok: false,
        reason: `Only the Neo session that proposed this work or the user can ${verb} it.`,
      },
    };
  return { value: work };
}

export function requireNeoWorkContinuation(work: NeoWork, caller: OperationCaller) {
  return requireNeoWorkProposer(work, caller, 'continue');
}

export function requireNeoWorkRetryCaller(work: NeoWork, caller: OperationCaller) {
  return requireNeoWorkProposer(work, caller, 'retry');
}

export function neoAskScope(ask: Pick<NeoAsk, 'concernId'> | null): string | null | undefined {
  return ask ? ask.concernId : undefined;
}

function admitNeoCaller(
  service: NeoService,
  caller: OperationCaller,
  name: string,
  concernId?: string | null,
  askApproved = false
): { value: OperationCaller } | { reason: Rejection } {
  if (caller.source === 'rpc' && caller.principal === 'local') return { value: caller };
  const binding = caller.sessionId ? service.repo.getBindingBySession(caller.sessionId) : null;
  if (caller.source !== 'mcp' || !binding || binding.kind === 'worker')
    return { reason: { ok: false, reason: 'This operation belongs to Neo.' } };
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
  if (name === 'neo.work.start' || name === 'neo.ask.approve') {
    const turn = caller.neoTurn;
    const active = service.db.getSession(caller.sessionId!)?.status === 'active';
    const human =
      !!turn?.human &&
      !turn.consultationId &&
      turn.isLive() &&
      hasNeoHumanWorkInput(
        caller,
        service.db.getSDKMessageRepo().getStoredPromptsByUuid(caller.sessionId!, turn.messageId)
      );
    if (!active || !(human || (askApproved && name === 'neo.work.start')))
      return { reason: { ok: false, reason: 'This action needs the user.' } };
  }
  if (
    [
      'neo.open',
      'neo.concern.cancel',
      'neo.work.close',
      'neo.ask.answer',
      'neo.session.track',
    ].includes(name)
  )
    return { reason: { ok: false, reason: 'This action needs the user.' } };
  if (binding.kind === 'concern' && concernId !== undefined && concernId !== binding.concernId)
    return { reason: { ok: false, reason: 'This context holder cannot access another concern.' } };
  return { value: caller };
}

export function neoReorganizeRuntime(
  service: NeoService,
  router: NeoRouter = createNeoRouter(service.db, service.repo, (concernId) =>
    service.open(concernId)
  )
): NeoReorganizeRuntime {
  return {
    getBinding: (sessionId) => service.repo.getBindingBySession(sessionId),
    rootSessionId: () => service.repo.getBindingForConcern(null)?.sessionId ?? null,
    liveAsks: () => service.askRecords.listLive(),
    ask: (id) => service.askRecords.get(id),
    route: (ask) => router(`${ask.title}\n${ask.ask}`, ask.id),
    sessionStatus: (sessionId) =>
      neoSessionStatus(service.db.getSession(sessionId)?.processingState),
    topicSession: (concernId) => service.repo.getBindingForConcern(concernId)?.sessionId ?? null,
    cards: (ask) => ask.workIds.flatMap((id) => service.repo.getWork(id) ?? []),
    deliver: (sessionId, messageId, content, from, parent) =>
      service.deliverForward(sessionId, messageId, content, from, parent),
    move: (ask, cards, owner) => service.moveAsk(ask, cards, owner),
    log: (line) => service.logReorganize(line),
  };
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
  function snapshot(caller: OperationCaller, requested?: string, askId?: string) {
    const built = buildSnapshot(caller, requested, askId);
    return built.ok && caller.source !== 'rpc'
      ? fitNeoSnapshotBudget(built, NEO_MCP_SNAPSHOT_BUDGET, { focused: !!askId })
      : built;
  }
  function buildSnapshot(caller: OperationCaller, requested?: string, askId?: string) {
    const focus = askId ? service.askRecords.get(askId) : null;
    if (askId && !focus) return { ok: false as const, reason: 'Ask not found.' };
    const binding = caller.sessionId ? service.repo.getBindingBySession(caller.sessionId) : null;
    const scope =
      binding?.kind === 'concern'
        ? binding.concernId
        : focus
          ? (focus.concernId ?? undefined)
          : requested;
    const detailed = caller.source === 'rpc' || binding?.kind === 'concern';
    const cardDetail = detailed || !!focus;
    const compact = caller.source !== 'rpc' && !focus;
    const concerns = service.repo
      .listConcerns()
      .filter((item) => (focus ? item.id === focus.concernId : !scope || item.id === scope));
    const work = focus
      ? focus.workIds.flatMap((id) => service.repo.getWork(id) ?? [])
      : service.repo.listWork(scope === undefined ? undefined : scope);
    const limit = caller.source === 'rpc' ? 50 : 10;
    const recentWork = focus ? work.slice(-limit).reverse() : work.slice(0, limit);
    const olderActiveWork =
      caller.source === 'rpc' && !focus
        ? work
            .slice(50)
            .filter((item) => item.status === 'proposed' || item.status === 'queued')
            .slice(0, 50)
        : [];
    const visibleWork = [...recentWork, ...olderActiveWork];
    const consultations = focus ? [] : service.consultations.list(scope ?? undefined);
    const waiters = focus ? [] : service.consultationWaiters.queued(scope ?? undefined);
    const workIds = visibleWork.map((item) => item.id);
    const workDrivers = service.driverTargets.receipts(workIds).map((receipt) => {
      const since = service.uncheckedSince(receipt.workId);
      return {
        ...receipt,
        ...(since === null ? {} : { uncheckedSince: since }),
        ...(service.isRetryable(receipt.workId) ? { retryable: true as const } : {}),
      };
    });
    const workGoals = service.workGoals.list(workIds);
    const workContinues = service.workContinues.list(workIds);
    const workSupersessions = service.workSupersessions.list(workIds);
    const listed = focus
      ? [focus]
      : service.askRecords.list(scope === undefined ? undefined : scope);
    const asks = projectNeoSnapshotAsks(
      listed,
      caller.source === 'rpc' ? 50 : 10,
      Date.now(),
      new Set(
        listed
          .filter((ask) => isPooledNeoAsk(ask))
          .flatMap((ask) => ask.workIds)
          .filter((id) => service.isContinueStalled(id))
      )
    );
    const workPrs = service.workPrs
      .list(workIds)
      .map(({ workId, prs }) => ({ workId, prs, waiting: isNeoWorkPrWaiting(prs) }));
    const cards = projectNeoCardViews({
      work: visibleWork,
      drivers: workDrivers,
      prs: workPrs,
      goals: workGoals,
      continues: workContinues,
      supersessions: workSupersessions,
      asks,
    });
    return {
      ok: true as const,
      sessionId: service.repo.getBindingForConcern(scope ?? null)?.sessionId ?? null,
      waitingOnHuman:
        caller.neoTurn && caller.sessionId
          ? neoWaitingOnHuman(
              service.listWaitingReminders({
                sessionId: caller.sessionId,
                messageId: caller.neoTurn.messageId,
              }).asks
            )
          : undefined,
      standingRules: neoStandingRules(service.db.getGlobalSettings?.().neo),
      publicAuthorBindings:
        caller.source === 'rpc' ? service.repo.listConcernBindings(scope ?? undefined) : [],
      askForwards:
        caller.source === 'rpc'
          ? service.askForwards.listRecent(NEO_SNAPSHOT_FORWARDS).map((forward) => ({
              askSessionId: forward.ask.sessionId,
              askMessageId: forward.ask.messageId,
              hop: forward.hop,
              fromSessionId: forward.fromSessionId,
              toSessionId: forward.toSessionId,
            }))
          : [],
      concerns: concerns.map((item) => ({
        ...item,
        context: detailed ? item.context : '',
      })),
      consultations: consultations.map((item) =>
        detailed ? item : { ...item, question: '', answer: null }
      ),
      consultationWaiters: waiters.map((item) => (detailed ? item : { ...item, question: '' })),
      ...(caller.source === 'rpc' && !focus ? { sessionNotices: service.sessionNotices } : {}),
      sessionNoticeGroups: focus ? [] : latestNeoSessionNoticeGroups(service.sessionNoticeGroups),
      mutedSessions: service.db.getGlobalSettings?.().neo?.mutedSessions ?? [],
      preferences: service.modelPreference(),
      asks: compact ? compactNeoSnapshotAsks(asks) : asks,
      cards: compact ? compactNeoSnapshotCards(cards) : cards,
      sessionLoad: readNeoSessionLoad(service.db.getDatabase()).slice(0, 50),
      askViews: projectNeoAskViews(
        asks,
        cards,
        workPrs,
        unmutedNeoAskSessions(
          service.askSessions,
          service.db.getGlobalSettings?.().neo?.mutedSessions ?? []
        )
      ),
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
              instruction: cardDetail ? item.instruction.slice(0, 1000) : '',
              report: cardDetail ? (item.report?.slice(0, 3000) ?? null) : null,
            }
      ),
    };
  }
  const muteSession = (superpipe({})('neo.session.mute') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(
      (caller: OperationCaller) => admitNeoCaller(service, caller, 'neo.session.mute'),
      'caller',
      'result:admission'
    )
    .pipe(
      (input: z.infer<typeof SessionMute>) => ({
        mutedSessions: planNeoSessionMutes(
          service.db.getGlobalSettings().neo?.mutedSessions ?? [],
          input.key,
          input.muted
        ),
      }),
      'input',
      'planned'
    )
    .pipe(
      (planned: { mutedSessions: string[] }) => {
        const neo = service.db.getGlobalSettings().neo;
        const updated = service.db.updateGlobalSettings({
          neo: { ...neo, mutedSessions: planned.mutedSessions },
        });
        service.publishSettings?.(updated);
        service.notifyChanged();
        return { ok: true as const, mutedSessions: planned.mutedSessions };
      },
      'planned',
      'admission'
    )
    .end('admission') as (
    input: z.infer<typeof SessionMute>,
    caller: OperationCaller
  ) => z.infer<typeof SessionMuteResult>;
  const adopting = new Set<string>();
  const trackSession = (superpipe({})('neo.session.track') as PipelineAPI)
    .input(['input', 'caller', 'now'])
    .pipe(
      (caller: OperationCaller) => admitNeoCaller(service, caller, 'neo.session.track'),
      'caller',
      'result:track'
    )
    .pipe(
      () => requireNeoTrackRoot(service.repo.getBindingForConcern(null)?.sessionId),
      'caller',
      'result:track'
    )
    .pipe((root: string) => root, 'track', 'root')
    .pipe(
      (input: z.infer<typeof SessionTrack>) =>
        findNeoSessionNotice(service.trackableNotices, input.key),
      'input',
      'result:track'
    )
    .pipe(
      (notice: NeoSessionNotice, now: number) =>
        requireNeoTrackableSession(notice, service.followedCardRefs(now)),
      ['track', 'now'],
      'result:track'
    )
    .pipe(
      (root: string, notice: NeoSessionNotice, now: number) =>
        service.trackSession(root, notice, now),
      ['root', 'track', 'now'],
      'track'
    )
    .endAsync('track') as (
    input: z.infer<typeof SessionTrack>,
    caller: OperationCaller,
    now: number
  ) => Promise<z.infer<typeof SessionTrackResult>>;
  const saveRules = (superpipe({})('neo.rule.save') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(
      (caller: OperationCaller) => admitNeoCaller(service, caller, 'neo.rule.save'),
      'caller',
      'result:admission'
    )
    .pipe(() => ({ neo: service.db.getGlobalSettings().neo }), 'input', 'current')
    .pipe(
      (input: z.infer<typeof SaveRules>, current: { neo?: NeoSettings }) =>
        planNeoSavedRules(neoStandingRules(current.neo), input.rules),
      ['input', 'current'],
      'saved'
    )
    .pipe(
      (input: z.infer<typeof SaveRules>, current: { neo?: NeoSettings }) => {
        const updated = service.db.updateGlobalSettings({
          neo: { ...current.neo, standingRules: input.rules },
        });
        service.publishSettings?.(updated);
      },
      ['input', 'current']
    )
    .pipe(
      (caller: OperationCaller, saved: string[]) => service.noteSavedRules(caller, saved),
      ['admission', 'saved']
    )
    .pipe(
      (input: z.infer<typeof SaveRules>) => ({ ok: true as const, standingRules: input.rules }),
      'input',
      'admission'
    )
    .end('admission') as (
    input: z.infer<typeof SaveRules>,
    caller: OperationCaller
  ) => z.infer<typeof RulesResult>;
  const read = path(
    'neo.snapshot',
    (input: z.infer<typeof Scope>) =>
      input.askId ? neoAskScope(service.askRecords.get(input.askId)) : input.concernId,
    (input, caller) => snapshot(caller, input.concernId, input.askId)
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
    .pipe((input: z.infer<typeof Consult>) => service.open(input.concernId), 'input', 'sessionId')
    .pipe(
      (origin: NeoConsultationOrigin, caller: OperationCaller) =>
        requireLiveNeoConsultationOrigin(origin, caller.neoTurn),
      ['admission', 'caller'],
      'result:admission'
    )
    .pipe(
      (input: z.infer<typeof Consult>, root: NeoConsultationOrigin, sessionId: string) =>
        service.consultations.find(root.originSessionId, input.requestKey) ??
        service.consultationWaiters.find(root.originSessionId, input.requestKey) ??
        service.consultationWaiters.enqueue({
          ...input,
          id: crypto.randomUUID(),
          ...root,
          sessionId,
        }),
      ['input', 'admission', 'sessionId'],
      'item'
    )
    .pipe(
      requireNeoConsultationReceipt,
      ['input', 'item', 'admission', 'sessionId'],
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
      (input: z.infer<typeof Propose>) => {
        const sessionId = ownedLookupSessionId(input);
        return {
          ref: sessionId ? spaceWorkRefForSession(service.db.getDatabase(), sessionId) : null,
        };
      },
      'input',
      'owned'
    )
    .pipe(adoptOwnedNeoTarget, ['input', 'owned'], 'input')
    .pipe(adoptNeoRefTarget, 'input', 'input')
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
      (input: z.infer<typeof Propose>, caller: OperationCaller) =>
        requireNeoTrackedAdoption(
          input.work,
          service.trackedSessions,
          service.followedCardRefs(Date.now()),
          Date.now(),
          caller
        ),
      ['input', 'admission'],
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
      (input: z.infer<typeof Propose>) =>
        input.askId ? service.askRecords.get(input.askId) : null,
      'input',
      'workAsk'
    )
    .pipe(requireNeoWorkAsk, ['workAsk', 'input', 'admission'], 'result:admission')
    .pipe(requireNeoWorkAskOwner, ['workAsk', 'input', 'admission'], 'result:admission')
    .pipe(requireNeoWorkAskLive, ['workAsk', 'input', 'admission'], 'result:admission')
    .pipe(
      (input: z.infer<typeof Propose>) => {
        const works = input.supersedes === undefined ? service.repo.listWork(input.concernId) : [];
        const superseded = new Set(
          service.workSupersessions.list(works.map((work) => work.id)).map((row) => row.workId)
        );
        return {
          candidates: neoWorkSupersedeCandidates(works, superseded, input.concernId, Date.now()),
        };
      },
      'input',
      'supersede'
    )
    .pipe(
      (
        input: z.infer<typeof Propose>,
        supersede: { candidates: { id: string; title: string }[] },
        caller: OperationCaller
      ) => requireNeoWorkSupersedeDecision(input, supersede.candidates, caller),
      ['input', 'supersede', 'admission'],
      'result:admission'
    )
    .pipe(
      (input: z.infer<typeof Propose>, caller: OperationCaller) =>
        requireNeoWorkSupersedable(
          input,
          input.supersedes ? service.repo.getWork(input.supersedes) : null,
          caller
        ),
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
      (input: z.infer<typeof Propose>, origin: NeoWorkOrigin) => {
        const requestKey = `${origin.originSessionId}:${input.requestKey}`;
        const db = service.db.getDatabase();
        return requireIdleNeoTarget(
          neoTargetSessionId(input.targetSessionId, input.work),
          readNeoSessionLoad(db, requestKey),
          input.allowBusyTarget || hasNeoWorkRequest(db, requestKey),
          (sessionId, loaded) => readNeoIdleSessions(db, sessionId, loaded)
        );
      },
      ['input', 'origin'],
      'result:admission'
    )
    .pipe(
      (input: z.infer<typeof Propose>) => ({
        id: crypto.randomUUID(),
        targetSessionId: input.targetSessionId ?? null,
        agent: input.targetAgent,
      }),
      'input',
      'candidate'
    )
    .pipe(
      (candidate: NeoWorkTarget) =>
        explainOwnedNeoTarget(
          requireCheckedNeoWorkTarget(
            checkNeoWorkTarget(candidate, {
              readSession: (id) => inventory.readSession(id),
              readAgentOwner: (agent) => service.agentTargets.readOwner(agent),
              readBinding: (id) => service.repo.getBindingBySession(id),
            })
          ),
          candidate
        ),
      'candidate',
      'result:admission'
    )
    .pipe((target: NeoWorkTarget) => target, 'admission', 'target')
    .pipe(requireLiveNeoWorkOrigin, ['origin', 'caller'], 'result:admission')
    .pipe(requireNeoProposalDoneWhen, ['input', 'caller'], 'result:admission')
    .pipe(
      (
        input: z.infer<typeof Propose>,
        origin: NeoWorkOrigin,
        target: NeoWorkTarget
      ): NeoProposal => {
        const proposal = {
          ...input,
          ...origin,
          requestKey: `${origin.originSessionId}:${input.requestKey}`,
          id: target.id,
        };
        if (input.work) {
          const proposed = service.driverTargets.propose(service.repo, proposal, input.work);
          return {
            receipt: { work: proposed.work, agent: null },
            crossTarget: JSON.stringify(proposed.target) !== JSON.stringify(input.work),
          };
        }
        const receipt = service.agentTargets.propose(service.repo, proposal, target.agent);
        return { receipt, crossTarget: !!service.driverTargets.get(receipt.work.id) };
      },
      ['input', 'origin', 'target'],
      'proposal'
    )
    .pipe(requireNeoProposal, ['target', 'origin', 'proposal'], 'result:admission')
    .pipe(
      (input: z.infer<typeof Propose>, receipt: { work: NeoWork }) => {
        if (input.supersedes)
          service.workSupersessions.record(input.supersedes, receipt.work.id, Date.now());
      },
      ['input', 'admission']
    )
    .pipe(
      (input: z.infer<typeof Propose>, origin: NeoWorkOrigin, receipt: { work: NeoWork }) => {
        const planned = planNeoCardAsk(input, origin);
        const filed = service.askRecords.forWork(receipt.work.id);
        const opened =
          planned && !filed
            ? service.askRecords.open(
                { ...planned, id: crypto.randomUUID() },
                planNeoAskItems(planned).items
              )
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
    .pipe(
      async (
        input: z.infer<typeof Propose>,
        ask: { askId?: string },
        receipt: { work: NeoWork }
      ) => {
        if (input.work?.verb !== 'adopt') {
          const owned = ask.askId ? service.askRecords.get(ask.askId) : null;
          const targets = new Map(
            (owned?.workIds ?? []).map((id) => [id, service.driverTargets.get(id)] as const)
          );
          if (
            owned &&
            isNeoTrackedFollowUp(
              owned,
              targets,
              input.work,
              service.driverTargets.adoptedRefs(Date.now() - NEO_WORK_FOLLOW_MAX_AGE_MS)
            )
          )
            service.askRecords.approve(owned.id, Date.now());
          return;
        }
        const tracked = service.trackedSessions;
        tracked.delete(neoSessionKey(input.work.ref));
        service.trackedSessions = tracked;
        const owned = ask.askId && !input.askId ? service.askRecords.get(ask.askId) : null;
        if (owned && isNeoAdoptOnlyAsk(owned, receipt.work.id))
          service.askRecords.approve(owned.id, Date.now());
        await service.start(receipt.work.id);
      },
      ['input', 'ask', 'admission']
    )
    .endAsync('admission') as (
    input: z.infer<typeof Propose>,
    caller: OperationCaller
  ) => Promise<
    | z.infer<typeof WorkResult>
    | Extract<ReturnType<typeof presentNeoWorkTarget>, { accepted: false }>
  >;
  const start = (superpipe({})('neo.work.start') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(
      (input: z.infer<typeof WorkId>) => {
        const work = service.repo.getWork(input.id);
        return { work, ask: work ? service.askRecords.forWork(work.id) : null };
      },
      'input',
      'found'
    )
    .pipe(
      (found: NeoWorkStartFound, caller: OperationCaller) => ({
        approved: !!found.work && isNeoAskStartApproved(found.work, found.ask, caller),
      }),
      ['found', 'caller'],
      'authority'
    )
    .pipe(
      (caller: OperationCaller, found: NeoWorkStartFound, authority: { approved: boolean }) =>
        admitNeoCaller(service, caller, 'neo.work.start', undefined, authority.approved),
      ['caller', 'found', 'authority'],
      'result:start'
    )
    .pipe(
      (found: NeoWorkStartFound) =>
        found.work ? { value: found.work } : { reason: { ok: false, reason: 'Work not found.' } },
      'found',
      'result:start'
    )
    .pipe(
      (work: NeoWork) => {
        const target = service.resolveWorkTarget(work.id);
        return target.accepted ? { value: work } : { reason: { ok: false, reason: target.reason } };
      },
      'start',
      'result:start'
    )
    .pipe(
      (work: NeoWork, caller: OperationCaller, authority: { approved: boolean }) => {
        if (authority.approved) return { value: work };
        const origin = requireNeoHumanWorkOrigin(work, caller);
        return 'reason' in origin ? origin : { value: work };
      },
      ['start', 'caller', 'authority'],
      'result:start'
    )
    .pipe(
      async (work: NeoWork) => {
        await service.start(work.id);
        return { value: { ok: true as const, work: service.repo.getWork(work.id)! } };
      },
      'start',
      'result:start'
    )
    .endAsync('start') as (
    input: z.infer<typeof WorkId>,
    caller: OperationCaller
  ) => Promise<z.infer<typeof WorkResult> | Rejection>;
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
  const retry = (superpipe({})('neo.work.retry') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(
      (caller: OperationCaller) => admitNeoCaller(service, caller, 'neo.work.retry', undefined),
      'caller',
      'result:retry'
    )
    .pipe(
      (input: z.infer<typeof WorkId>) => ({
        work: service.repo.getWork(input.id),
        target: service.driverTargets.get(input.id),
      }),
      'input',
      'found'
    )
    .pipe(
      (found: NeoWorkRetryFound) =>
        found.work ? { value: found.work } : { reason: { ok: false, reason: 'work_not_found' } },
      'found',
      'result:retry'
    )
    .pipe(requireNeoWorkRetryCaller, ['retry', 'caller'], 'result:retry')
    .pipe(
      (found: NeoWorkRetryFound) => readNeoStartFolder(found.target, existsSync),
      'found',
      'folder'
    )
    .pipe(
      (found: NeoWorkRetryFound, folder: { exists: boolean | null }, work: NeoWork) =>
        requireNeoStartFolder(found.target, folder, work),
      ['found', 'folder', 'retry'],
      'result:retry'
    )
    .pipe((work: NeoWork) => ({ card: service.retryCard(work.id) }), 'retry', 'retryCard')
    .pipe(
      (work: NeoWork, retryCard: { card: NeoWorkRetryCard }) =>
        requireNeoWorkRetryable(work, retryCard.card, work),
      ['retry', 'retryCard'],
      'result:retry'
    )
    .pipe(
      async (work: NeoWork) => ({ value: await service.retryWork(work) }),
      'retry',
      'result:retry'
    )
    .endAsync('retry') as (
    input: z.infer<typeof WorkId>,
    caller: OperationCaller
  ) => Promise<Awaited<ReturnType<NeoService['retryWork']>> | Rejection>;
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
  const readPack = path(
    'neo.pack.read',
    (_input: z.infer<typeof PackRead>) => undefined,
    ({ id }) => {
      const pack = service.pack(id);
      if (!pack)
        return { ok: false as const, reason: `pack_not_found: no pack "${id}" is installed.` };
      const instructions = pack.instructions(null);
      return instructions === null
        ? {
            ok: false as const,
            reason: `pack_without_instructions: "${id}" carries no instructions to read.`,
          }
        : { ok: true as const, pack: { id: pack.id, describe: pack.describe }, instructions };
    }
  );
  const router = createNeoRouter(service.db, service.repo, (concernId) => service.open(concernId));
  return [
    createNeoIntakeOperation(service.db, service.repo, service.notifyChanged, router),
    createNeoReorganizeOperation(neoReorganizeRuntime(service, router)),
    createNeoPublicationOperation(service.publish),
    createNeoRouteCorrectOperation(service.db, service.repo),
    createNeoAskForwardOperation({
      getBinding: (sessionId) => service.repo.getBindingBySession(sessionId),
      resolveAskOrigin: (input) => service.resolveAskOrigin(input),
      forwards: (ask) => service.askForwards.list(ask),
      getConcern: (id) => service.repo.getConcern(id),
      listTopics: () => service.repo.listConcerns(),
      rootSessionId: () => service.repo.getBindingForConcern(null)?.sessionId ?? null,
      askText: (ask) => {
        const root = service.repo.getBindingForConcern(null)?.sessionId;
        return root?.startsWith('neo:')
          ? neoForwardedText(service.asks.find(root.slice(4), ask.messageId), ask)
          : null;
      },
      open: (concernId) =>
        reopenNeoHolder(service.repo, service.db, (id) => service.open(id), concernId),
      record: (ask, forward) => service.askForwards.record(ask, forward),
      unrecord: (ask, hop) => service.askForwards.remove(ask, hop),
      delivered: (sessionId, messageId) => service.hasDelivery(sessionId, messageId),
      deliver: (sessionId, messageId, content, from, ask) =>
        service.deliverForward(sessionId, messageId, content, from, ask),
    }),
    createNeoPublicationReadOperation(service.repo, service.publications),
    createNeoConversationAskReadOperation(service.repo, service.asks, (sessionId, messageId) =>
      service.db.getSDKMessageRepo().getUserSendStatus(sessionId, messageId)
    ),
    createNeoConversationImageReadOperation(service.repo, service.asks),
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
      execute: async (input, caller) => saveRules(input, caller),
    }),
    defineOperation({
      name: 'neo.session.mute',
      description:
        'Mute or unmute notices about a session the human started themselves. key is the notice key from snapshot.sessionNoticeGroups or sessionNotices; a muted session gets no more needs-you or failed notices until unmuted. snapshot.mutedSessions lists the muted keys.',
      inputSchema: SessionMute,
      resultSchema: SessionMuteResult,
      policy: { safetyClass: 'mutate', roles: ['neo'] },
      execute: async (input, caller) => muteSession(input, caller),
    }),
    defineOperation({
      name: 'neo.session.track',
      description:
        'Track a session the human started themselves, from its notice: key is the notice key from snapshot.sessionNoticeGroups or sessionNotices. Neo is asked to write the goal and doneWhen from the session\'s first message and propose a card that adopts the session as its driver target ({verb:"adopt", ref}) without sending it anything; the tap counts as the human’s Start for that card, so it starts on its own; the ask the proposal opens for it is approved, but an existing ask Neo names is not, and a shared ask keeps needing the human’s approval for its other work.',
      inputSchema: SessionTrack,
      resultSchema: SessionTrackResult,
      policy: { safetyClass: 'human_only' },
      execute: (input, caller) => trackSession(input, caller, Date.now()),
    }),
    defineOperation({
      name: 'neo.pack.read',
      description:
        'Read the full instructions of an installed domain pack (enabled or not), the guidance an ask names with its pack field: what work in that domain looks like and what done means there. neo.snapshot and the system prompt carry only each enabled pack’s one-line describe.',
      inputSchema: PackRead,
      resultSchema: PackReadResult,
      policy: { safetyClass: 'read', roles: ['neo'] },
      execute: readPack,
    }),
    defineOperation({
      name: 'neo.snapshot',
      description:
        'Read durable concern summaries and execution receipts. Pass concernId to load that concern’s full context, or askId to read one ask with its cards, their reports, drivers and pull requests. Without askId, settled asks keep only their title, status and a short outcome, and finished cards drop their goal and doneWhen; read one with askId when you need its full text. A snapshot over 40 KB is trimmed and carries a trimmed note saying what was cut.',
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
        'Propose work for user approval from the current live input. Every proposal must choose where it runs. targetSessionId names an exact ordinary project/non-project chat, or an existing active long-horizon Space agent with matching targetAgent {spaceId,agentId,sessionId} from daemon.snapshot; there is no standalone scratch session. Instead of targetSessionId, work may name a drivers target: {verb:"start", adapter, place, model?} to start new work in a place from work.find (model only applies to a new HyperNeo session; set it when the human names one) (for a new project folder that does not exist yet, use place {machine, daemon?, folder, name} and add createFolder:true; the folder must be under the home folder with an existing parent; never ask another session to create a folder), or {verb:"send", ref} to continue work it found, or {verb:"adopt", ref} to follow a session the human tapped Track on without sending it anything (that card starts on its own); starting the proposal then runs work.start or work.send as Neo. Managed targets keep native tools and permissions. A targetSessionId that belongs to exactly one Space task or agent is proposed as work {verb:"send"} to that task or agent; other owned and Neo-bound sessions are refused with the route to use. Instructions alone do not bind a target. The target is immutable for this requestKey. When no target clearly fits, ask the human instead of proposing. Set goal to what the human asked, in their own words, and doneWhen to a short checklist of what finished means; both are sent to the worker with the instruction, so a shorter instruction never drops the real goal. When this work replaces a failed or cancelled card, pass supersedes with the id of that card so it shows as replaced; when the concern has failed or cancelled work from the last three days, the proposal is refused until you pass supersedes, using null when it replaces none. A proposal to a session that already holds live cards is refused with its load and the idle sessions in the same place; split independent items across idle sessions, and pass allowBusyTarget:true only to queue behind the work of that session on purpose. This does not start execution.',
      inputSchema: Propose,
      resultSchema: WorkResult,
      policy: { safetyClass: 'mutate', roles: ['neo'] },
      execute: async (input, caller) => {
        const reserved = reserveNeoAdoption(adopting, input.work);
        if ('reason' in reserved) return reserved.reason;
        try {
          const result = await propose(input, caller);
          return 'accepted' in result ? { ok: false as const, reason: result.reason } : result;
        } finally {
          if (reserved.value) adopting.delete(reserved.value);
        }
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
      description:
        'Start a user-approved delegation through the existing session runtime: in the turn where the human asked for it, or any proposed work item under an ask the human approved (neo.ask.approve).',
      inputSchema: WorkId,
      resultSchema: WorkResult,
      policy: { safetyClass: 'human_only' },
      execute: start,
    }),
    defineOperation({
      name: 'neo.work.continue',
      description:
        'Send the next instruction to started work whose session stopped before its doneWhen was met, in the same session with its context. The goal and checklist are attached again. Reported work reopens as queued. Allowed while the work keeps moving: it stops after 3 continues in a row bring no new commit, PR state, review or report, or 12 hours after the work started; work under an approved ask follows the same no-progress rule for 48 hours after approval instead of 12. Past that it rejects with continue_budget_spent and you must ask the human (to approve the ask again, for approved work). Only the Neo session that proposed the work or the user can continue it.',
      inputSchema: Continue,
      resultSchema: WorkResult,
      policy: { safetyClass: 'mutate', roles: ['neo'] },
      execute: continueWork,
    }),
    defineOperation({
      name: 'neo.work.retry',
      description:
        'Try a failed hand-off again on the same work item: only work that failed before its driver started it (for example the claude CLI was logged out) can be retried. The work item goes back to queued and the same approved instruction is sent to the same target. Use this instead of proposing new work for the same ask. Started work uses neo.work.continue instead. Only the Neo session that proposed the work or the user can retry it.',
      inputSchema: WorkId,
      resultSchema: WorkResult,
      policy: { safetyClass: 'mutate', roles: ['neo'] },
      execute: retry,
    }),
    defineOperation({
      name: 'neo.work.close',
      description:
        'Close a work item as done or cancelled from any state, for the user only. Closing queued work stops the Codex or Claude work behind it. Done is recorded as a report saying the user closed it; cancelled work stays cancelled. Neo cannot close work items: when a work item looks stale, propose closing it to the user instead.',
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
