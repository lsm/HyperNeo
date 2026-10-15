import { hostname } from 'node:os';
import { createNeoProjectTreeOperations } from './project-tree-operations.ts';
import { readNeoProjectFacts } from './project-route-facts.ts';
import { createNeoCrossProjectOperation } from './cross-project-operation.ts';
import { existsSync } from 'node:fs';
import { requireNeoReadOperation } from './read-work.ts';
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
  NEO_WORK_PROPOSE_DESCRIPTION,
} from '@hyperneo/prompts';
import {
  NEO_SNAPSHOT_UNCHANGED_GUIDANCE,
  planNeoSnapshotRead,
  rememberNeoSnapshotRead,
} from './snapshot-read.ts';
import { neoAdmissionRefusal } from './work-admission.ts';
import superpipe, { type PipelineAPI } from 'superpipe';
import { THINKING_LEVELS } from '@hyperneo/shared';
import { z } from 'zod';
import { NeoGithubReadResult, readNeoGithubRef } from './packs/coding/github-read.ts';
import {
  NeoGithubQuery,
  NeoGithubQueryResult,
  queryNeoGithub,
} from './packs/coding/github-query.ts';
import type { OperationCaller } from '../operations/registry.ts';
import { defineOperation } from '../operations/registry.ts';
import { hashString32 } from '../runtime-hash.ts';
import type { NeoService } from './service.ts';
import { DaemonInventoryRepository } from '../../storage/repositories/daemon-inventory-repository.ts';
import type { NeoWorkTarget } from '../../storage/repositories/neo-repository.ts';
import type {
  NeoProject,
  NeoConsultation,
  NeoConsultationWaiter,
  NeoWork,
} from '@hyperneo/shared/types/neo-context';
import {
  NEO_WORK_CLOSED_DONE_PREFIX,
  type NeoAsk,
  type NeoCardView,
  type NeoReceiptAskOrigin,
  type NeoWorkPr,
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
import {
  mergeNeoDuplicateProjects,
  NEO_PROJECT_SAME,
  NEO_PROJECT_SEPARATE,
  type NeoProjectQuestion,
  neoProjectQuestionKey,
  NEO_PROJECT_QUESTION_ATTEMPTS,
  readNeoProjectDecision,
  readNeoProjectIdentities,
  settleNeoProjectQuestions,
} from './project-merge.ts';
import { readWorkspaceIdentity } from '../drivers/code-identity.ts';
import { neoSessionStatus } from './direct-reply-fallback.ts';
import { createNeoRouter, type NeoRouter, reopenNeoHolder } from './router.ts';
import { createNeoPublicationChangeOperations } from './publication-change-operation.ts';
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
  NEO_SNAPSHOT_SETTLED_ASKS,
  summarizeNeoSnapshot,
} from './snapshot-compact.ts';
import { isNeoAskSettled } from './done-check.ts';
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
  neoNoteChecklist,
  neoNotePrVerdict,
  readNeoStartFolder,
  requireNeoDriverVerb,
  requireNeoStartFolder,
  requireNeoWorkRetryable,
  type NeoDriverTarget,
  type NeoWorkRetryCard,
} from './driver-work.ts';
import { invokeOperation, type OperationOutcome } from '../operations/invoke.ts';
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
  planNeoAskQuestion,
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
import { NeoAskStateViewSchema, NeoAskViewSchema, NeoCardViewSchema } from './card-view-schema.ts';
import { projectNeoAskViews } from './ask-views.ts';
import { busyNeoAskSessions, unmutedNeoAskSessions } from './session-ask-links.ts';
import { NEO_WORK_FOLLOW_MAX_AGE_MS } from './work-follow.ts';

type ZodShape<T> = { [K in keyof Required<T>]: z.ZodType<T[K]> };

const NEO_SNAPSHOT_FORWARDS = 100;
const Project = z.object({
  id: z.string(),
  title: z.string(),
  summary: z.string(),
  context: z.string(),
  parentId: z.string().nullable().optional(),
  epicUrl: z.string().nullable().optional(),
  workspaceAliases: z.array(z.string()).optional(),
  revision: z.number(),
  createdAt: z.number(),
  updatedAt: z.number(),
} satisfies ZodShape<NeoProject>);
const Work = z.object({
  id: z.string(),
  requestKey: z.string(),
  projectId: z.string().nullable(),
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
  projectId: z.string(),
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
  projectId: z.string(),
  originSessionId: z.string(),
  originMessageId: z.string(),
  sessionId: z.string(),
  question: z.string(),
  status: z.enum(['queued', 'admitted', 'cancelled']),
  createdAt: z.number(),
} satisfies ZodShape<NeoConsultationWaiter>);
const Consult = z.object({
  projectId: z.string().min(1),
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
  projects: z.array(Project),
  projectRedirects: z.array(z.object({ sourceId: z.string(), targetId: z.string() })).optional(),
  projectFacts: z
    .array(z.object({ reference: z.string(), projectId: z.string().nullable().optional() }))
    .optional(),
  publicAuthorBindings: z
    .array(
      z.object({
        sessionId: z.string(),
        projectId: z.string(),
        kind: z.literal('project'),
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
  work: z.array(
    Work.extend({ summarized: z.literal(true).optional(), askId: z.string().optional() })
  ),
  standingRules: z.array(z.string()).optional(),
  consultations: z.array(Consultation.extend({ summarized: z.literal(true).optional() })),
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
  moreSettled: z.boolean().optional(),
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
  rev: z.string().optional(),
  scopedTo: z.string().optional(),
} satisfies ZodShape<NeoSnapshot>);
const SnapshotUnchanged = z.object({
  ok: z.literal(true),
  unchanged: z.literal(true),
  rev: z.string(),
  note: z.string(),
  scopedTo: z.string().optional(),
});
const Snapshot = z.union([Failure, SnapshotUnchanged, SnapshotOk]);
const WorkAskView = NeoAskStateViewSchema;
const WorkResult = z.union([
  Failure.extend({
    blockers: z
      .array(z.object({ workId: z.string(), reason: z.string(), itemIds: z.array(z.string()) }))
      .optional(),
  }),
  z.object({ ok: z.literal(true), work: Work, ask: WorkAskView.nullable().optional() }),
]);
const Scope = z
  .object({
    projectId: z.string().min(1).optional(),
    askId: z.string().min(1).optional(),
    all: z.boolean().optional(),
    sinceRev: z.string().min(1).max(40).optional(),
    summaries: z.boolean().optional(),
  })
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
  projectId: z.string().min(1).nullable().default(null),
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
const Refused = z.object({ workId: z.string().min(1), what: z.string().trim().min(1).max(500) });
const WorkId = z.object({ id: z.string().min(1) });
const ReceiptRead = z.union([
  z.object({ workId: z.string().min(1) }),
  z.object({ consultationId: z.string().min(1) }),
]);
const ReceiptResult = z.union([
  Failure,
  z.object({ ok: z.literal(true), work: Work }),
  z.object({ ok: z.literal(true), consultation: Consultation }),
]);
const StartWork = WorkId.extend({
  dependsOn: z
    .array(z.string().min(1))
    .max(20)
    .optional()
    .describe(
      'Card ids this card must wait for. Each card needs an outcome item bound to it (deliveredBy); changing them needs the ask approved again.'
    ),
});
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
const Close = z.object({
  id: z.string().min(1),
  outcome: z.enum(['done', 'cancelled']),
  reason: z.string().trim().min(1).max(500).optional(),
});
const PackRead = z.object({ id: z.string().trim().min(1).max(80) });
const GithubRead = NeoGithubQuery.partial({ repo: true })
  .extend({ url: z.string().trim().min(1).max(500).optional() })
  .refine((input) => !input.url !== !input.repo, 'Pass either url or repo.');
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
    item.projectId !== input.projectId ||
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
            'Choose where the work runs: targetSessionId for an existing chat, or work {verb:"start", adapter, place} or {verb:"send", ref} from work.find, or {verb:"adopt", ref} for a session the human named in chat. There is no standalone scratch session. If no project, Space or chat clearly fits, ask the human where the work belongs instead of proposing.',
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

export function isNeoWorkMissingHere(outcome: OperationOutcome | null): boolean {
  if (outcome?.kind !== 'completed') return false;
  const value = outcome.value as { ok?: boolean; reason?: string } | null;
  return value?.ok === false && value.reason === 'not_found';
}

const MISSING_TARGET_HINT =
  'target_session_not_found: no HyperNeo session or Claude session on this daemon has this id. A work.find ref from another adapter or daemon (a Codex thread, or a Claude session on another machine) is proposed as work {verb:"send", ref} with the whole ref, daemon included, never as targetSessionId.';

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
  verb: 'continue' | 'retry' | 'record a refusal on',
  humanTurn: boolean
): { value: NeoWork } | { reason: Rejection } {
  if (caller.source === 'mcp' && caller.sessionId !== work.originSessionId && !humanTurn)
    return {
      reason: {
        ok: false,
        reason: `Only the Neo session that proposed this work, Neo answering the human’s own chat message, or the user can ${verb} it.`,
      },
    };
  return { value: work };
}

export function requireNeoWorkContinuation(
  work: NeoWork,
  caller: OperationCaller,
  humanTurn = false
) {
  return requireNeoWorkProposer(work, caller, 'continue', humanTurn);
}

export function requireNeoWorkRetryCaller(
  work: NeoWork,
  caller: OperationCaller,
  humanTurn = false
) {
  return requireNeoWorkProposer(work, caller, 'retry', humanTurn);
}

export function isNeoTurnAskReadable(
  binding: { kind: string; projectId: string | null } | null,
  ask: Pick<NeoAsk, 'projectId'>
): boolean {
  return (
    binding?.kind === 'neo' ||
    (binding?.kind === 'project' &&
      binding.projectId !== null &&
      ask.projectId === binding.projectId)
  );
}

export function neoSnapshotRevision<T extends { ok: boolean }>(
  snapshot: T,
  sinceRev: string | undefined,
  scopedTo: string | undefined
):
  | T
  | (T & { rev: string; scopedTo?: string })
  | {
      ok: true;
      unchanged: true;
      rev: string;
      note: string;
      scopedTo?: string;
    } {
  if (!snapshot.ok) return snapshot;
  const rev = hashString32(
    JSON.stringify(snapshot, (key, value) => (key === 'checkedAt' ? undefined : value))
  ).toString(36);
  const scoped = scopedTo ? { scopedTo } : {};
  return sinceRev === rev
    ? {
        ok: true,
        unchanged: true,
        rev,
        note: `unchanged since rev ${rev}: nothing changed since your last read. ${NEO_SNAPSHOT_UNCHANGED_GUIDANCE}`,
        ...scoped,
      }
    : { ...snapshot, rev, ...scoped };
}

export function neoWorkAskView(
  ask: NeoAsk | null,
  works: readonly Pick<NeoWork, 'id' | 'title' | 'status'>[],
  humanActions: z.infer<typeof WorkAskView>['humanActions'] = [],
  cards: readonly Pick<NeoCardView, 'workId' | 'phase'>[] = [],
  prs: readonly { workId: string; prs: NeoWorkPr[] }[] = []
): z.infer<typeof WorkAskView> | null {
  const byId = new Map(cards.map((card) => [card.workId, card]));
  const prsById = new Map(prs.map((receipt) => [receipt.workId, receipt.prs]));
  return ask
    ? {
        id: ask.id,
        status: ask.status,
        outcome: ask.outcome,
        items: neoNoteChecklist(ask),
        cards: works.map(({ id, title, status }) => ({
          id,
          title,
          status,
          phase: byId.get(id)?.phase ?? null,
          pr: neoNotePrVerdict(prsById.get(id) ?? []) ?? null,
        })),
        humanActions,
      }
    : null;
}

export function neoAskScope(ask: Pick<NeoAsk, 'projectId'> | null): string | null | undefined {
  return ask ? ask.projectId : undefined;
}

export const NEO_HUMAN_TURN_REFUSAL =
  'Neo can do this only while answering the human’s own chat message, not from a system note or consultation.';

export function requireNeoWorkCloser(
  work: NeoWork | null,
  caller: OperationCaller,
  humanTurn: boolean,
  outcome: 'done' | 'cancelled',
  reason: string | undefined
): { value: string | null } | { reason: Rejection } {
  if (!work) return { reason: { ok: false, reason: 'work_not_found' } };
  if (caller.source !== 'mcp') return { value: null };
  if (caller.sessionId !== work.originSessionId && !humanTurn)
    return {
      reason: {
        ok: false,
        reason:
          'Neo closes a card it started at any time, and any other card only while answering the human’s own chat message.',
      },
    };
  if (!reason) return { reason: { ok: false, reason: 'Give a reason; the card shows it.' } };
  return {
    value: `${outcome === 'done' ? NEO_WORK_CLOSED_DONE_PREFIX : 'Cancelled by '}Neo: ${reason}`,
  };
}

function isNeoHumanTurn(service: NeoService, caller: OperationCaller): boolean {
  if (caller.source === 'rpc' && caller.principal === 'local') return true;
  const turn = caller.neoTurn;
  if (!turn?.isLive() || !caller.sessionId) return false;
  return (
    service.db.getSession(caller.sessionId)?.status === 'active' &&
    hasNeoHumanWorkInput(
      caller,
      service.db.getSDKMessageRepo().getStoredPromptsByUuid(caller.sessionId, turn.messageId)
    )
  );
}

function admitNeoCaller(
  service: NeoService,
  caller: OperationCaller,
  name: string,
  projectId?: string | null,
  askApproved = false
): { value: OperationCaller } | { reason: Rejection } {
  if (caller.source === 'rpc' && caller.principal === 'local') return { value: caller };
  const binding = caller.sessionId ? service.repo.getBindingBySession(caller.sessionId) : null;
  if (caller.source !== 'mcp' || !binding || binding.kind === 'worker')
    return { reason: { ok: false, reason: 'This operation belongs to Neo.' } };
  if (name === 'neo.rule.save' && binding.kind !== 'neo')
    return { reason: { ok: false, reason: 'Only root Neo can save standing rules.' } };
  if (
    name === 'neo.project.save' &&
    binding.kind === 'neo' &&
    projectId &&
    service.repo.getProject(projectId)
  )
    return {
      reason: {
        ok: false,
        reason: 'Consult this project’s holder to save corrections; Neo only has its summary.',
      },
    };
  if (
    ['neo.work.start', 'neo.ask.approve'].includes(name) &&
    !(askApproved && name === 'neo.work.start'
      ? service.db.getSession(caller.sessionId!)?.status === 'active'
      : isNeoHumanTurn(service, caller))
  )
    return { reason: { ok: false, reason: NEO_HUMAN_TURN_REFUSAL } };
  if (['neo.open', 'neo.receipt.read', 'neo.project.cancel', 'neo.session.track'].includes(name))
    return { reason: { ok: false, reason: 'This action needs the user.' } };
  if (binding.kind === 'project' && projectId !== undefined && projectId !== binding.projectId)
    return { reason: { ok: false, reason: 'This context holder cannot access another project.' } };
  return { value: caller };
}

function readNeoProjectQuestionAsks(
  asks: Pick<NeoService['askRecords'], 'forRequest'>,
  key: string
): NeoAsk[] {
  const found: NeoAsk[] = [];
  for (let attempt = 1; attempt <= NEO_PROJECT_QUESTION_ATTEMPTS; attempt++) {
    const ask = asks.forRequest(neoProjectQuestionKey(key, attempt));
    if (!ask) break;
    found.push(ask);
  }
  return found;
}

function askNeoProjectQuestion(
  service: Pick<NeoService, 'repo' | 'askRecords'>,
  question: NeoProjectQuestion,
  attempt: number
): boolean {
  const root = service.repo.getBindingForProject(null)?.sessionId;
  if (!root) return false;
  const [source, target] = [question.sourceId, question.targetId].map(
    (id) => service.repo.getProject(id)?.title ?? id
  );
  const text = `Are ${source} and ${target} the same project? Both point at ${question.repository.slice(5)}.`;
  const opened = service.askRecords.open({
    id: crypto.randomUUID(),
    requestKey: neoProjectQuestionKey(question.key, attempt),
    projectId: null,
    originSessionId: root,
    originMessageId: null,
    title: `${source} and ${target}: one project?`,
    ask: `${text} The daemon asked this while reorganizing projects; after the human answers, run neo.projects.reorganize to apply it.`,
    doneWhen: 'The human decided whether the two are one project.',
    doneSource: 'daemon',
  });
  if (!opened || opened.doneItems?.length) return false;
  const item = planNeoAskQuestion(opened, {
    question: text,
    options: [NEO_PROJECT_SAME, NEO_PROJECT_SEPARATE],
    decides: question.key,
  });
  return !!service.askRecords.settle(opened, 'waiting', text, text, item.id, item);
}

export function neoReorganizeRuntime(
  service: NeoService,
  router: NeoRouter = createNeoRouter(service.db, service.repo, (projectId) =>
    service.open(projectId)
  )
): NeoReorganizeRuntime {
  return {
    getBinding: (sessionId) => service.repo.getBindingBySession(sessionId),
    rootSessionId: () => service.repo.getBindingForProject(null)?.sessionId ?? null,
    liveAsks: () => service.askRecords.listLive(),
    ask: (id) => service.askRecords.get(id),
    route: (ask) => router(`${ask.title}\n${ask.ask}`, ask.id),
    sessionStatus: (sessionId) =>
      neoSessionStatus(service.db.getSession(sessionId)?.processingState),
    projectSession: (projectId) => service.repo.getBindingForProject(projectId)?.sessionId ?? null,
    cards: (ask) => ask.workIds.flatMap((id) => service.repo.getWork(id) ?? []),
    deliver: (sessionId, messageId, content, from, parent) =>
      service.deliverForward(sessionId, messageId, content, from, parent, null),
    move: (ask, cards, owner) => service.moveAsk(ask, cards, owner),
    mergeProjects: async () => {
      const merges = service.repo.projectMerges;
      const fresh = await readNeoProjectIdentities(
        merges.localFolders(hostname()),
        readWorkspaceIdentity
      );
      const merged = mergeNeoDuplicateProjects(
        () => merges.plan(fresh),
        (input) => merges.merge(input),
        (line) => service.logReorganize(line)
      );
      const settled = settleNeoProjectQuestions(
        () => merges.questions(fresh),
        (question) =>
          readNeoProjectDecision(
            readNeoProjectQuestionAsks(service.askRecords, question.key),
            question.key
          ),
        (input) => merges.merge(input),
        (question, attempt) => askNeoProjectQuestion(service, question, attempt),
        (line) => service.logReorganize(line)
      );
      return { merged: [...merged, ...settled.merged], asked: settled.asked };
    },
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
  function withAskView<T extends { ok: boolean }>(result: T): T {
    if (!result.ok || !('work' in result)) return result;
    const work = (result as { work: NeoWork }).work;
    return { ...result, ask: askView(service.askRecords.forWork(work.id)) };
  }
  function askView(ask: NeoAsk | null): z.infer<typeof WorkAskView> | null {
    if (!ask) return null;
    const work = ask.workIds.flatMap((id) => service.repo.getWork(id) ?? []);
    const asks = projectNeoSnapshotAsks(
      [ask],
      1,
      Date.now(),
      new Set(ask.workIds.filter((id) => service.isContinueStalled(id)))
    );
    const { workPrs, cards } = projectCards(work, asks);
    const [view] = projectNeoAskViews(
      asks,
      cards,
      workPrs,
      unmutedAskSessions(),
      busyNeoAskSessions(service.askSessions)
    );
    return neoWorkAskView(ask, work, view?.humanActions ?? [], cards, workPrs);
  }
  function unmutedAskSessions() {
    return unmutedNeoAskSessions(
      service.askSessions,
      service.db.getGlobalSettings?.().neo?.mutedSessions ?? []
    );
  }
  function projectCards(visibleWork: NeoWork[], asks: NeoAsk[]) {
    const workIds = visibleWork.map((item) => item.id);
    const workPrs = service.workPrs
      .list(workIds)
      .map(({ workId, prs }) => ({ workId, prs, waiting: isNeoWorkPrWaiting(prs) }));
    const cards = projectNeoCardViews({
      work: visibleWork,
      drivers: workDrivers(workIds),
      waits: service.cardWaits(workIds),
      prs: workPrs,
      goals: service.workGoals.list(workIds),
      continues: service.workContinues.list(workIds),
      supersessions: service.workSupersessions.list(workIds),
      asks,
      refusals: service.workRefusals.list(),
    });
    return { workPrs, cards };
  }
  function workDrivers(workIds: string[]) {
    return service.driverTargets.receipts(workIds).map((receipt) => {
      const since = service.uncheckedSince(receipt.workId);
      const checkedAt = service.checkedAt(receipt.workId);
      return {
        ...receipt,
        ...(since === null ? {} : { uncheckedSince: since }),
        ...(checkedAt === null ? {} : { checkedAt }),
        ...(service.isRetryable(receipt.workId) ? { retryable: true as const } : {}),
      };
    });
  }

  function snapshot(
    caller: OperationCaller,
    requested?: string,
    askId?: string,
    summaries = false
  ) {
    const built = buildSnapshot(caller, requested, askId, summaries);
    return built.ok && caller.source !== 'rpc'
      ? fitNeoSnapshotBudget(built, NEO_MCP_SNAPSHOT_BUDGET, { focused: !!askId })
      : built;
  }
  function buildSnapshot(
    caller: OperationCaller,
    requested: string | undefined,
    askId: string | undefined,
    summaries: boolean
  ) {
    const focus = askId ? service.askRecords.get(askId) : null;
    if (askId && !focus) return { ok: false as const, reason: 'Ask not found.' };
    const binding = caller.sessionId ? service.repo.getBindingBySession(caller.sessionId) : null;
    const scope =
      binding?.kind === 'project'
        ? binding.projectId
        : focus
          ? (focus.projectId ?? undefined)
          : requested && (service.repo.projectMerges.resolve(requested) ?? requested);
    const detailed = caller.source === 'rpc' || binding?.kind === 'project';
    const cardDetail = detailed || !!focus;
    const compact = caller.source !== 'rpc' && !focus;
    const projects = service.repo
      .listProjects()
      .filter((item) => (focus ? item.id === focus.projectId : !scope || item.id === scope));
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
    const listed = focus
      ? [focus]
      : service.askRecords.list(scope === undefined ? undefined : scope);
    const summarize = caller.source === 'rpc' && !focus && summaries;
    const asks = projectNeoSnapshotAsks(
      listed,
      caller.source === 'rpc' && !summarize ? 50 : NEO_SNAPSHOT_SETTLED_ASKS,
      Date.now(),
      new Set(workIds.filter((id) => service.isContinueStalled(id)))
    );
    const { workPrs, cards } = projectCards(visibleWork, asks);
    const built = {
      ok: true as const,
      sessionId: service.repo.getBindingForProject(scope ?? null)?.sessionId ?? null,
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
      ...(caller.source === 'rpc'
        ? { projectRedirects: service.repo.projectMerges.redirects() }
        : {}),
      publicAuthorBindings:
        caller.source === 'rpc' ? service.repo.listProjectBindings(scope ?? undefined) : [],
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
      projectFacts:
        binding?.kind === 'neo' && caller.sessionId && caller.neoTurn
          ? readNeoProjectFacts(
              service.db.getDatabase(),
              service.humanAskText(
                service.resolveAskOrigin({
                  sessionId: caller.sessionId,
                  messageId: caller.neoTurn.messageId,
                }) ?? { sessionId: caller.sessionId, messageId: caller.neoTurn.messageId }
              ) ?? ''
            )
          : undefined,
      projects: projects.map((item) => ({
        ...item,
        ...(item.epicUrl ? { workspaceAliases: service.repo.workspaceAliases(item.id) } : {}),
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
      ...(summarize
        ? { moreSettled: listed.filter(isNeoAskSettled).length > NEO_SNAPSHOT_SETTLED_ASKS }
        : {}),
      cards: compact ? compactNeoSnapshotCards(cards) : cards,
      sessionLoad: readNeoSessionLoad(service.db.getDatabase()).slice(0, 50),
      askViews: projectNeoAskViews(
        asks,
        cards,
        workPrs,
        unmutedAskSessions(),
        busyNeoAskSessions(service.askSessions)
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
    return summarize ? summarizeNeoSnapshot(built, listed) : built;
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
      () => requireNeoTrackRoot(service.repo.getBindingForProject(null)?.sessionId),
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
  const turnAsk = (caller: OperationCaller): string | undefined => {
    if (caller.source !== 'mcp' || !caller.sessionId || !caller.neoTurn?.messageId)
      return undefined;
    const origin = service.resolveAskOrigin({
      sessionId: caller.sessionId,
      messageId: caller.neoTurn.messageId,
    });
    const ask = origin
      ? service.askRecords.liveForOrigin(origin.sessionId, origin.messageId)
      : null;
    const binding = service.repo.getBindingBySession(caller.sessionId);
    return ask && isNeoTurnAskReadable(binding, ask) ? ask.id : undefined;
  };
  const scopeOf = (input: z.infer<typeof Scope>, caller: OperationCaller) => {
    if (input.askId || input.projectId || input.all)
      return { askId: input.askId, scopedTo: undefined };
    const askId = turnAsk(caller);
    return { askId, scopedTo: askId };
  };
  const read = path(
    'neo.snapshot',
    (input: z.infer<typeof Scope>) =>
      input.askId ? neoAskScope(service.askRecords.get(input.askId)) : input.projectId,
    (input, caller) => {
      const scope = scopeOf(input, caller);
      const read = neoSnapshotRevision(
        snapshot(caller, input.projectId, scope.askId, input.summaries),
        input.sinceRev,
        scope.scopedTo
      );
      const turn = caller.source === 'mcp' ? caller.neoTurn?.messageId : undefined;
      if (!caller.sessionId || !turn) return read;
      const key = [caller.sessionId, turn, input.projectId, scope.askId, input.all].join('\n');
      const planned = planNeoSnapshotRead(
        read,
        service.snapshotReads.get(key) ?? null,
        service.db.getSDKMessageRepo().latestCompactionSeq(caller.sessionId)
      );
      if (planned.remember) rememberNeoSnapshotRead(service.snapshotReads, key, planned.remember);
      return planned.result;
    }
  );
  const consult = (superpipe({})('neo.project.consult') as PipelineAPI)
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
        service.repo.getProject(input.projectId)
          ? { value: root }
          : { reason: { ok: false, reason: 'Project not found.' } },
      ['input', 'admission'],
      'result:admission'
    )
    .pipe((input: z.infer<typeof Consult>) => service.open(input.projectId), 'input', 'sessionId')
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
        if (item.status === 'queued') await service.dispatchConsultationWaiter(item.projectId);
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
  const respond = (superpipe({})('neo.project.respond') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(
      (input: z.infer<typeof Respond>, caller: OperationCaller) => {
        const item = service.consultations.get(input.id);
        const holder = caller.sessionId && service.repo.getBindingBySession(caller.sessionId);
        return caller.source === 'mcp' &&
          item &&
          holder &&
          holder.kind === 'project' &&
          holder.sessionId === item.sessionId &&
          holder.projectId === item.projectId
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
    (input: z.infer<typeof Scope>) => input.projectId,
    async (input, caller) => {
      const projectId = input.projectId
        ? (service.repo.projectMerges.resolve(input.projectId) ?? input.projectId)
        : null;
      if (projectId && !service.repo.getProject(projectId))
        return { ok: false as const, reason: 'Project not found.' };
      setTimeout(
        () =>
          void invokeOperation(
            service.sessions.getOperationRegistry(),
            'work.find',
            { limit: 50 },
            caller
          ).catch(() => null),
        0
      );
      const sessionId = await service.open(projectId);
      return { ...snapshot(caller, undefined, undefined, input.summaries), sessionId };
    }
  );
  const readReceipt = path(
    'neo.receipt.read',
    (_input: z.infer<typeof ReceiptRead>) => undefined,
    (input) => {
      const work = 'workId' in input ? service.repo.getWork(input.workId) : null;
      const consultation =
        'consultationId' in input ? service.consultations.get(input.consultationId) : null;
      if (work) return { ok: true as const, work };
      if (consultation) return { ok: true as const, consultation };
      return { ok: false as const, reason: 'Receipt not found.' };
    }
  );
  const cancelConsultation = path(
    'neo.project.cancel',
    (_input: z.infer<typeof WorkId>) => undefined,
    async ({ id }) => {
      const waiter = service.consultationWaiters.get(id);
      if (waiter?.status === 'queued' || waiter?.status === 'cancelled') {
        const cancelled = service.consultationWaiters.cancel(id)!;
        await service.dispatchConsultationWaiter(cancelled.projectId);
        return { ok: true as const, waiter: cancelled };
      }
      const item = service.consultations.finish(id, 'failed', CONSULTATION_STOPPED);
      if (!item) return { ok: false as const, reason: 'Consultation not found.' };
      await service.syncConsultation(id);
      return { ok: true as const, consultation: service.consultations.get(id)! };
    }
  );
  const save = path(
    'neo.project.save',
    (input: z.infer<typeof Save>) => input.id,
    (input, caller) => {
      const holder =
        caller.source === 'mcp' &&
        caller.sessionId &&
        service.repo.getBindingBySession(caller.sessionId)?.kind === 'project';
      const turn = caller.neoTurn;
      if (holder && (!turn?.isLive() || (!turn.human && !turn.consultationId)))
        return { ok: false as const, reason: 'A live holder input is required to save context.' };
      const project =
        holder && turn?.consultationId
          ? service.repo.saveConsultationContext(
              input,
              input.expectedRevision,
              turn.consultationId,
              caller.sessionId!
            )
          : service.repo.saveProject(input, input.expectedRevision);
      return project
        ? { ok: true as const, project }
        : {
            ok: false as const,
            reason:
              holder && turn?.consultationId
                ? 'superseded: this request cannot save context. Return the uncertainty to Neo; a fresh consultation is required.'
                : 'superseded: read the current project before saving again',
          };
    }
  );
  const propose = (superpipe({})('neo.work.propose') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(
      (input: z.infer<typeof Propose>, caller: OperationCaller) =>
        admitNeoCaller(service, caller, 'neo.work.propose', input.projectId),
      ['input', 'caller'],
      'result:admission'
    )
    .pipe(requireNeoExecutionChoice, ['input', 'admission'], 'result:admission')
    .pipe(
      (input: z.infer<typeof Propose>, caller: OperationCaller) => {
        if (input.work?.verb !== 'read') return { value: caller };
        const checked = requireNeoReadOperation(
          input.work,
          service.sessions.getOperationRegistry()
        );
        return 'reason' in checked ? checked : { value: caller };
      },
      ['input', 'admission'],
      'result:admission'
    )
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
    .pipe(
      async (input: z.infer<typeof Propose>, caller: OperationCaller) => {
        const id = ownedLookupSessionId(input);
        if (!id?.startsWith('local_')) return input;
        const outcome = await Promise.resolve()
          .then(() =>
            invokeOperation(
              service.sessions.getOperationRegistry(),
              'work.status',
              { ref: { adapter: 'claude-desktop', id } },
              caller
            )
          )
          .catch(() => null);
        return isNeoWorkMissingHere(outcome) ? input : adoptNeoRefTarget(input);
      },
      ['input', 'admission'],
      'input'
    )
    .pipe(
      ({ work }: z.infer<typeof Propose>, caller: OperationCaller) =>
        work && work.verb !== 'read'
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
        requireNeoTrackedAdoption(input.work, service.followedCardRefs(Date.now()), caller),
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
        input.projectId && !service.repo.getProject(input.projectId)
          ? { reason: { ok: false, reason: 'Project not found.' } }
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
        const works = input.supersedes === undefined ? service.repo.listWork(input.projectId) : [];
        const superseded = new Set(
          service.workSupersessions.list(works.map((work) => work.id)).map((row) => row.workId)
        );
        return {
          candidates: neoWorkSupersedeCandidates(works, superseded, input.projectId, Date.now()),
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
          caller.sessionId ?? service.repo.getBindingForProject(input.projectId)?.sessionId
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
      (input: z.infer<typeof Propose>, origin: NeoWorkOrigin, caller: OperationCaller) => {
        const planned = planNeoCardAsk(input, origin);
        const stored = service.repo.workForRequest(`${origin.originSessionId}:${input.requestKey}`);
        if (stored && service.askRecords.forWork(stored.id)) return { value: caller };
        const checked = service.outcomeCheckPolicy.requireChecks(
          planned ? planNeoAskItems(planned).items : []
        );
        return 'reason' in checked
          ? {
              reason: {
                ...checked.reason,
                reason: `${checked.reason.reason} Open a checked ask with neo.ask.open, then pass its askId.`,
              },
            }
          : { value: caller };
      },
      ['input', 'origin', 'caller'],
      'result:admission'
    )
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
        if (input.work?.verb === 'read') {
          await service.start(receipt.work.id);
          receipt.work = service.repo.getWork(receipt.work.id)!;
          return;
        }
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
            service.askRecords.approve(owned.id, Date.now(), owned.revision ?? 0);
          return;
        }
        const tracked = service.trackedSessions;
        tracked.delete(neoSessionKey(input.work.ref));
        service.trackedSessions = tracked;
        const owned = ask.askId && !input.askId ? service.askRecords.get(ask.askId) : null;
        if (owned && isNeoAdoptOnlyAsk(owned, receipt.work.id))
          service.askRecords.approve(owned.id, Date.now(), owned.revision ?? 0);
        await service.admitWork(receipt.work.id, true);
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
      (input: z.infer<typeof StartWork>) => {
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
      (input: z.infer<typeof StartWork>, work: NeoWork) => {
        if (!input.dependsOn) return { value: work };
        const edited = service.editDependencies(work.id, input.dependsOn);
        return edited.ok
          ? { value: work }
          : { reason: { ok: false, reason: edited.reason ?? 'dependency_rejected' } };
      },
      ['input', 'start'],
      'result:start'
    )
    .pipe(
      async (work: NeoWork, authority: { approved: boolean }) => {
        const refused = neoAdmissionRefusal(await service.admitWork(work.id, !authority.approved));
        return refused
          ? { reason: refused }
          : { value: { ok: true as const, work: service.repo.getWork(work.id)! } };
      },
      ['start', 'authority'],
      'result:start'
    )
    .endAsync('start') as (
    input: z.infer<typeof StartWork>,
    caller: OperationCaller
  ) => Promise<z.infer<typeof WorkResult> | Rejection>;
  const continueWork = path(
    'neo.work.continue',
    (_input: z.infer<typeof Continue>) => undefined,
    async ({ id, message }, caller) => {
      const work = service.repo.getWork(id);
      if (!work) return { ok: false as const, reason: 'work_not_found' };
      const humanTurn = isNeoHumanTurn(service, caller);
      const admission = requireNeoWorkContinuation(work, caller, humanTurn);
      if ('reason' in admission) return admission.reason;
      return service.continueWork(id, message, Date.now(), {
        guarded: caller.source === 'mcp',
        human: caller.source !== 'mcp' || humanTurn,
      });
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
    .pipe((caller: OperationCaller) => isNeoHumanTurn(service, caller), 'caller', 'humanTurn')
    .pipe(requireNeoWorkRetryCaller, ['retry', 'caller', 'humanTurn'], 'result:retry')
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
  const refused = (superpipe({})('neo.work.refused') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(
      (caller: OperationCaller) => admitNeoCaller(service, caller, 'neo.work.refused', undefined),
      'caller',
      'result:refused'
    )
    .pipe(
      ({ workId }: z.infer<typeof Refused>) => {
        const work = service.repo.getWork(workId);
        return work ? { value: work } : { reason: { ok: false, reason: 'work_not_found' } };
      },
      'input',
      'result:refused'
    )
    .pipe(
      (work: NeoWork, caller: OperationCaller) =>
        requireNeoWorkProposer(work, caller, 'record a refusal on', false),
      ['refused', 'caller'],
      'result:refused'
    )
    .pipe(
      (work: NeoWork) => ({
        ref:
          service.driverTargets.readCard(work.id)?.ref ??
          (work.sessionId ? { adapter: 'hyperneo', id: work.sessionId } : null),
      }),
      'refused',
      'target'
    )
    .pipe(
      (work: NeoWork, { ref }: { ref: WorkRef | null }) =>
        ref && work.status !== 'cancelled' && work.status !== 'proposed'
          ? { value: work }
          : { reason: { ok: false, reason: 'Only a started card can report a session refusal.' } },
      ['refused', 'target'],
      'result:refused'
    )
    .pipe(
      (work: NeoWork, { what }: z.infer<typeof Refused>, { ref }: { ref: WorkRef }) => {
        service.workRefusals.record({
          workId: work.id,
          ref,
          what: what.replace(/\s+/g, ' '),
          at: Date.now(),
        });
        service.notifyChanged();
        return { value: { ok: true, work } };
      },
      ['refused', 'input', 'target'],
      'result:refused'
    )
    .endAsync('refused') as (
    input: z.infer<typeof Refused>,
    caller: OperationCaller
  ) => Promise<z.infer<typeof WorkResult>>;
  const close = path(
    'neo.work.close',
    (_input: z.infer<typeof Close>) => undefined,
    async ({ id, outcome, reason }, caller) => {
      const closer = requireNeoWorkCloser(
        service.repo.getWork(id),
        caller,
        isNeoHumanTurn(service, caller),
        outcome,
        reason
      );
      return 'reason' in closer ? closer.reason : service.close(id, outcome, closer.value);
    }
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
  const readGithub = path(
    'neo.github.read',
    (_input: z.infer<typeof GithubRead>) => undefined,
    async (input): Promise<NeoGithubReadResult | NeoGithubQueryResult> =>
      input.url
        ? await readNeoGithubRef(service, input.url)
        : await queryNeoGithub((args: string[]) => service.listGithub(args), {
            ...input,
            repo: input.repo!,
          })
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
  const router = createNeoRouter(
    service.db,
    service.repo,
    (projectId) => service.open(projectId),
    async (text) => {
      const registry = service.sessions.getOperationRegistry();
      const caller: OperationCaller = { source: 'rpc', principal: 'local' };
      await invokeOperation(registry, 'work.find', { limit: 50 }, caller);
      for (const [id] of [
        ...text.matchAll(/\b[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\b/gi),
      ].slice(0, 10))
        await invokeOperation(registry, 'work.find', { id, limit: 50 }, caller);
    }
  );
  return [
    ...createNeoProjectTreeOperations(service.repo),
    createNeoCrossProjectOperation(service),
    createNeoIntakeOperation(service.db, service.repo, service.notifyChanged, router),
    createNeoReorganizeOperation(neoReorganizeRuntime(service, router)),
    createNeoPublicationOperation(service.publish),
    ...createNeoPublicationChangeOperations({
      getBinding: (id) => service.repo.getBindingBySession(id),
      getRootBinding: () => service.repo.getBindingForProject(null),
      publications: service.publications,
      isConsultationReturn: (conversationId, publicationId) =>
        service.consultations.returnsPublication(conversationId, publicationId),
      resolveAskOrigin: (input) => service.resolveAskOrigin(input),
      inputTrigger: (input) => service.inputTrigger(input),
      isTriggerPublished: (conversationId, triggerId, publicationId) =>
        service.publications.hasTrigger(conversationId, triggerId, publicationId),
      noteReply: (publication) => service.noteCorrectionReply(publication),
      notify: (conversationId) => {
        service.notifyChanged();
        service.notifyPublicationsChanged(conversationId);
      },
    }),
    createNeoRouteCorrectOperation(service.db, service.repo),
    createNeoAskForwardOperation({
      getBinding: (sessionId) => service.repo.getBindingBySession(sessionId),
      resolveAskOrigin: (input) => service.resolveAskOrigin(input),
      forwards: (ask) => service.askForwards.list(ask),
      getProject: (id) => service.repo.getProject(id),
      listProjects: () => service.repo.listProjects(),
      rootSessionId: () => service.repo.getBindingForProject(null)?.sessionId ?? null,
      askText: (ask) => {
        const root = service.repo.getBindingForProject(null)?.sessionId;
        return root?.startsWith('neo:')
          ? neoForwardedText(service.asks.find(root.slice(4), ask.messageId), ask)
          : null;
      },
      open: (projectId) =>
        reopenNeoHolder(service.repo, service.db, (id) => service.open(id), projectId),
      record: (ask, forward) => service.askForwards.record(ask, forward),
      unrecord: (ask, hop) => service.askForwards.remove(ask, hop),
      delivered: (sessionId, messageId) => service.hasDelivery(sessionId, messageId),
      deliver: (sessionId, messageId, content, from, ask) =>
        service.deliverForward(sessionId, messageId, content, from, ask, 'continues'),
    }),
    createNeoPublicationReadOperation(service.repo, service.publications),
    createNeoConversationAskReadOperation(service.repo, service.asks, (sessionId, messageId) =>
      service.db.getSDKMessageRepo().getUserSendStatus(sessionId, messageId)
    ),
    createNeoConversationImageReadOperation(service.repo, service.asks),
    createNeoDraftRecoveryOperation(service),
    createNeoPreferenceOperation(service),
    ...createNeoAskOperations(
      service,
      (caller, name, projectId) => admitNeoCaller(service, caller, name, projectId),
      askView
    ),
    defineOperation({
      name: 'neo.project.cancel',
      description:
        'Stop waiting for a context check. Rejects later answers without interrupting the holder session or undoing saved context.',
      inputSchema: WorkId,
      resultSchema: ConsultationResult,
      policy: { safetyClass: 'human_only' },
      execute: cancelConsultation,
    }),
    defineOperation({
      name: 'neo.project.consult',
      description:
        'Ask a context holder a bounded question from the current root input. Returns a correlated durable receipt; the answer arrives asynchronously. Reuse requestKey only for retries of this input; use a new key for another ask.',
      inputSchema: Consult,
      resultSchema: ConsultationResult,
      policy: { safetyClass: 'mutate', roles: ['neo'] },
      execute: consult,
    }),
    defineOperation({
      name: 'neo.project.respond',
      description:
        'Return a concise answer to the root Neo for a consultation assigned to this context holder.',
      inputSchema: Respond,
      resultSchema: ConsultationResult,
      policy: { safetyClass: 'mutate', roles: ['neo'] },
      execute: respond,
    }),
    defineOperation({
      name: 'neo.open',
      description: 'Open the human Neo or project conversation.',
      inputSchema: Scope,
      resultSchema: Snapshot,
      policy: { safetyClass: 'human_only' },
      execute: open,
    }),
    defineOperation({
      name: 'neo.receipt.read',
      description:
        'Read one work item or consultation in full, by workId or consultationId, for a row the snapshot sent summarized.',
      inputSchema: ReceiptRead,
      resultSchema: ReceiptResult,
      policy: { safetyClass: 'human_only' },
      execute: readReceipt,
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
      name: 'neo.github.read',
      description:
        'Read GitHub as it is now. With {url}, one pull request or issue: a pull request returns its state (OPEN, MERGED or CLOSED), checks (passing, failing, pending or none), review verdict on its current head (approved, changes_requested or none), merge blockers and title; an issue returns its state, how it closed (completed, not_planned or duplicate), the merged pull request that closed it, and its parent issue. With {repo: "owner/name", kind: "pr" or "issue", state: "open", "merged", "closed" or "all", by: "created", "updated", "merged" or "closed", since, until (ISO times), limit}, a list: every match in that window with number, title, url, state, createdAt, updatedAt, mergedAt and closedAt, newest first, and truncated when more matched than limit. by defaults to merged for state merged, closed for closed, otherwise created. Use the list for any question about what happened in a time range ("which PRs merged in the last 2 hours") instead of guessing numbers and reading them one by one. Read-only.',
      inputSchema: GithubRead,
      resultSchema: z.union([NeoGithubReadResult, NeoGithubQueryResult]),
      policy: { safetyClass: 'read', roles: ['neo'] },
      execute: readGithub,
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
        'Read durable project summaries and execution receipts. Pass projectId to load that project’s full context, or askId to read one ask with its cards, their reports, drivers and pull requests. Without askId, settled asks keep only their title, status and a short outcome, and finished cards drop their goal and doneWhen; read one with askId when you need its full text. A snapshot over 40 KB is trimmed and carries a trimmed note saying what was cut. In a turn that belongs to an ask, the snapshot is scoped to that ask (scopedTo says which) unless you pass askId, projectId or all: true. Every snapshot carries rev; pass it back as sinceRev and an unchanged snapshot answers only {unchanged: true, rev}, so read again only after something happened.',
      inputSchema: Scope,
      resultSchema: Snapshot,
      policy: { safetyClass: 'read', roles: ['neo'] },
      execute: read,
    }),
    defineOperation({
      name: 'neo.project.save',
      description:
        'Create a continuing context only when needed, or update an existing context with revision protection. Never one project per message.',
      inputSchema: Save,
      resultSchema: z.union([Failure, z.object({ ok: z.literal(true), project: Project })]),
      policy: { safetyClass: 'mutate', roles: ['neo'] },
      execute: save,
    }),
    defineOperation({
      name: 'neo.work.propose',
      description: NEO_WORK_PROPOSE_DESCRIPTION,
      inputSchema: Propose,
      resultSchema: WorkResult,
      policy: { safetyClass: 'mutate', roles: ['neo'] },
      execute: async (input, caller) => {
        const reserved = reserveNeoAdoption(adopting, input.work);
        if ('reason' in reserved) return reserved.reason;
        try {
          const result = await propose(input, caller);
          return 'accepted' in result
            ? { ok: false as const, reason: result.reason }
            : withAskView(result);
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
        "Start a user-approved delegation through the existing session runtime: in the turn where the human asked for it, or any proposed work item under an ask the human approved (neo.ask.approve). With dependsOn, the card waits until every listed card's bound outcome items are verified met; the result lists blockers while it waits.",
      inputSchema: StartWork,
      resultSchema: WorkResult,
      policy: { safetyClass: 'human_only' },
      execute: async (input, caller) => withAskView(await start(input, caller)),
    }),
    defineOperation({
      name: 'neo.work.continue',
      description:
        'Send the next instruction to started work whose session stopped before its doneWhen was met, in the same session with its context. The goal and checklist are attached again. Reported work reopens as queued. Allowed while the work keeps moving: it stops after 3 continues in a row bring no new commit, PR state, review or report, or 12 hours after the work started; work under an approved ask follows the same no-progress rule for 48 hours after approval instead of 12. Past that it rejects with continue_budget_spent and you must ask the human (to approve the ask again, for approved work). The Neo session that proposed the work can continue it at any time; any Neo session can while answering the human’s own chat message, and the user always can.',
      inputSchema: Continue,
      resultSchema: WorkResult,
      policy: { safetyClass: 'mutate', roles: ['neo'] },
      execute: async (input, caller) => withAskView(await continueWork(input, caller)),
    }),
    defineOperation({
      name: 'neo.work.retry',
      description:
        'Try a hand-off again on the same work item: work that failed before its driver started it (for example the claude CLI was logged out), or a card waiting for an open worker, can be retried. The work item goes back to queued and the same approved instruction is sent; an archived or ended target is replaced by an idle worker in the same project. Use this instead of proposing new work for the same ask. Started work uses neo.work.continue instead. The Neo session that proposed the work can retry it at any time; any Neo session can while answering the human’s own chat message, and the user always can.',
      inputSchema: WorkId,
      resultSchema: WorkResult,
      policy: { safetyClass: 'mutate', roles: ['neo'] },
      execute: async (input, caller) => withAskView(await retry(input, caller)),
    }),
    defineOperation({
      name: 'neo.work.refused',
      description:
        'Record that this card’s session refused the request or needs the human to tell it directly. what is one plain line naming the session and what it refused. The card points at its Open button; the daemon clears the line on that session’s next human input. Do not relay, repeat or argue with it. Only the card’s owning Neo or the user records this.',
      inputSchema: Refused,
      resultSchema: WorkResult,
      policy: { safetyClass: 'mutate', roles: ['neo'] },
      execute: async (input, caller) => withAskView(await refused(input, caller)),
    }),
    defineOperation({
      name: 'neo.work.close',
      description:
        'Close a work item as done or cancelled from any state. Closing queued work stops the Codex or Claude work behind it; cancelled work stays cancelled. Neo closes a card it started at any time, and any other card while answering the human’s own chat message, always with a reason, which the card shows. The user closes any card without a reason.',
      inputSchema: Close,
      resultSchema: WorkResult,
      policy: { safetyClass: 'mutate', roles: ['neo'] },
      execute: async (input, caller) => withAskView(await close(input, caller)),
    }),
    defineOperation({
      name: 'neo.work.cancel',
      description:
        'Withdraw work before it finishes: proposed or queued work becomes cancelled, disappears from pending surfaces, and its Neo-owned execution session is interrupted. The Neo session that proposed the work or the human can cancel. Retrying on already-cancelled work succeeds without another write. Work that already reported or failed rejects with work_not_cancelable; stop live execution through the owning runtime (session interrupt or Space task cancel) instead.',
      inputSchema: WorkId,
      resultSchema: WorkResult,
      policy: { safetyClass: 'mutate', roles: ['neo'] },
      execute: async (input, caller) => withAskView(await cancel(input, caller)),
    }),
  ];
}
