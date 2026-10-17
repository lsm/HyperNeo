import { neoTurnRequestKey } from './request-key.ts';
import { readNeoWorking } from './working.ts';
import { hostname } from 'node:os';
import {
  backfillNeoRepositoryIdentities,
  isNeoPlumbingFolder,
  neoProjectFolders,
} from './project-mirror.ts';
import { neoFolderPath } from './folder.ts';
import { isTempCwd } from '../drivers/claude-feed.ts';
import { createNeoProjectTreeOperations } from './project-tree-operations.ts';
import { neoMirroredAliases } from './project-cleanup.ts';
import { createNeoProjectCleanupApply } from './project-cleanup-apply.ts';
import type { PlaceGroup } from '../drivers/types.ts';
import { readNeoProjectFacts } from './project-route-facts.ts';
import { createNeoCrossProjectOperation } from './cross-project-operation.ts';
import { existsSync } from 'node:fs';
import { neoPromptText } from './reply-language.ts';
import { readNeoSessionLoad } from './session-load.ts';
import {
  NEO_CONSULTATION_RECEIPT_CLOSED,
  NEO_CONSULTATION_RECEIPT_PENDING,
  NEO_CONSULTATION_RECEIPT_RETURNED,
} from '@hyperneo/prompts';
import {
  NEO_SNAPSHOT_UNCHANGED_GUIDANCE,
  planNeoSnapshotRead,
  rememberNeoSnapshotRead,
} from './snapshot-read.ts';
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
import type {
  NeoProject,
  NeoConsultation,
  NeoConsultationWaiter,
  NeoWork,
} from '@hyperneo/shared/types/neo-context';
import { NeoRoutingLogRepository } from '../../storage/repositories/neo-routing-log-repository.ts';
import {
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
import { CONSULTATION_STOPPED } from './consultation-policy.ts';
import { isNeoProjectEventTurn } from './card-events.ts';
import { createNeoIntakeOperation } from './intake.ts';
import { createNeoRouteCorrectOperation } from './route-correct-operation.ts';
import {
  createNeoRouteFailureOperation,
  NeoRouteFailureSchema,
} from './route-failure-operation.ts';
import { createNeoAskForwardOperation, neoForwardHop } from './ask-forward-operation.ts';
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
import { neoSessionStatus } from './session-status.ts';
import {
  createNeoRouter,
  NEO_INBOX_ID,
  type NeoRouter,
  neoNewProject,
  openNeoDefaultSession,
  openNeoNewProject,
  reopenNeoHolder,
} from './router.ts';
import { createNeoInboxPromoteOperation } from './inbox-promote-operation.ts';
import { createNeoPublicationChangeOperations } from './publication-change-operation.ts';
import { createNeoPublicationOperation } from './publication-operation.ts';
import { createNeoConversationReadOperation } from './conversation-read-operation.ts';
import { NeoConversationReader } from '../../storage/repositories/neo-conversation-reader.ts';
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
  neoSnapshotOmitted,
  NEO_SNAPSHOT_SETTLED_ASKS,
  summarizeNeoSnapshot,
} from './snapshot-compact.ts';
import { isNeoAskSettled } from './done-check.ts';
import { projectNeoSnapshotAskOrigins } from './snapshot-origins.ts';
import { hasNeoHumanWorkInput, neoTurnOrigin } from './work-origin.ts';
import {
  admitNeoConsultationOrigin,
  requireLiveNeoConsultationOrigin,
  type NeoConsultationOrigin,
} from './consultation-origin.ts';
import { type NeoDriverTarget } from './driver-work.ts';
import { invokeOperation, type OperationOutcome } from '../operations/invoke.ts';
import type { WorkRef } from '../drivers/types.ts';
import {
  NEO_SESSION_MUTES_MAX,
  NeoSessionNoticeGroupSchema,
  NeoSessionNoticeSchema,
  latestNeoSessionNoticeGroups,
  planNeoSessionMutes,
  type NeoSessionNotice,
} from './session-watch.ts';
import {
  findNeoSessionNotice,
  requireNeoTrackRoot,
  requireNeoTrackableSession,
} from './session-track.ts';
import { NeoWorkResourceReferences } from './work-resource-refs.ts';
import { createNeoQuestionOperations } from './question-operations.ts';
import { createNeoTodoOperations, type NeoTodoControls } from './todo-operations.ts';
import { createNeoAskRecordOperations } from './ask-record-operations.ts';
import { NeoAskEntrySchema, projectNeoAskEntries } from './ask-entries.ts';
import { NeoAskSchema } from './ask-inputs.ts';
import { planNeoAskQuestion, projectNeoSnapshotAsks } from './ask-plans.ts';
import { isNeoWorkPrWaiting } from './packs/coding/work-prs.ts';
import { neoWaitingOnHuman } from './waiting-reminders.ts';
import { createNeoPreferenceOperation } from './model-preference.ts';
import { planNeoRuleEdit, planNeoSavedRules, requireNeoRuleCitation } from './saved-rules.ts';
import { projectNeoCardViews } from './card-views.ts';
import { NeoAskViewSchema, NeoCardViewSchema } from './card-view-schema.ts';
import { projectNeoAskViews } from './ask-views.ts';
import { busyNeoAskSessions, unmutedNeoAskSessions } from './session-ask-links.ts';

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
  repository: z.string().optional(),
  folders: z
    .array(z.object({ machine: z.string(), folder: z.string() }))
    .optional()
    .describe(
      "The project's own folders: start and propose its work in one of these, not in a place found by text search."
    ),
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
  follows: z.string().nullable().optional(),
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
  question: z.string().trim().min(1).max(8000),
});
const Respond = z.object({ id: z.string().min(1), answer: z.string().trim().min(1).max(4000) });
type ConsultRequest = z.infer<typeof Consult> & { requestKey: string };
const NEO_CONSULTATION_SETTLED =
  'Already settled: Neo already received the recorded answer shown here, and this new answer was not recorded.';
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
const NEO_ASK_TOLD_LIMIT = 20;
const NEO_ASK_TOLD_TEXT = 300;
const SnapshotOk = z.object({
  ok: z.literal(true),
  sessionId: z.string().nullable(),
  projects: z.array(Project),
  conversationId: z.string().nullable().optional(),
  defaultSessionId: z.string().nullable().optional(),
  neoSessions: z
    .array(z.object({ sessionId: z.string(), projectId: z.string().nullable() }))
    .optional(),
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
    Work.extend({
      summarized: z.literal(true).optional(),
      askId: z.string().optional(),
      phase: NeoCardViewSchema.shape.phase.optional(),
      label: z.string().optional(),
    })
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
  todoAsks: z.array(NeoAskEntrySchema).optional(),
  told: z
    .array(
      z.object({
        publicationId: z.string(),
        at: z.string(),
        shortText: z.string(),
        triggerId: z.string().optional(),
      })
    )
    .max(NEO_ASK_TOLD_LIMIT)
    .optional(),
  moreSettled: z.boolean().optional(),
  omitted: z
    .object({ work: z.number().int().optional(), asks: z.number().int().optional() })
    .optional(),
  cards: z.array(NeoCardViewSchema).max(100),
  sessionLoad: z
    .array(z.object({ sessionId: z.string(), liveCards: z.number().int(), busy: z.boolean() }))
    .max(50)
    .optional(),
  working: z
    .array(
      z.object({
        sessionId: z.string(),
        projectId: z.string().nullable(),
        title: z.string(),
        status: z.enum(['queued', 'processing', 'rate_limit_cooldown']),
      })
    )
    .max(100)
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
  routeFailure: NeoRouteFailureSchema.optional(),
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
  id: z.string().min(1).max(100).optional(),
  title: z.string().trim().min(1).max(160),
  summary: z.string().max(1000),
  context: z.string().max(16000),
  expectedRevision: z.number().int().min(0),
});
type SaveRequest = z.infer<typeof Save>;

export function requireNeoProjectSaveId(
  input: Pick<SaveRequest, 'id' | 'expectedRevision'>,
  caller: OperationCaller
): { value: OperationCaller } | { reason: z.infer<typeof Failure> } {
  if (input.id && input.expectedRevision === 0)
    return {
      reason: {
        ok: false,
        reason: 'Omit id to create a project; the daemon assigns its id and returns it.',
      },
    };
  if (!input.id && input.expectedRevision > 0)
    return { reason: { ok: false, reason: 'Pass the id of the project you are updating.' } };
  return { value: caller };
}
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
const SessionMute = z.object({ key: z.string().trim().min(1).max(400), muted: z.boolean() });
const SessionMuteResult = z.union([
  Failure,
  z.object({ ok: z.literal(true), mutedSessions: z.array(z.string()) }),
]);
const SessionTrack = z.object({ key: z.string().trim().min(1).max(400) });
const SessionTrackResult = z.union([Failure, z.object({ ok: z.literal(true) })]);
const StandingRule = z.string().trim().min(1).max(NEO_STANDING_RULE_MAX_CHARS);
const SaveRules = z.object({
  add: z.array(StandingRule).max(NEO_STANDING_RULES_MAX).optional(),
  remove: z.array(StandingRule).max(NEO_STANDING_RULES_MAX).optional(),
  from: z.string().trim().min(1).max(2000).optional(),
});
const RulesResult = z.union([
  Failure,
  z.object({ ok: z.literal(true), standingRules: z.array(z.string()) }),
]);
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
type Rejection = { ok: false; reason: string };

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
  input: ConsultRequest,
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

export function requireNeoProposalAsk(
  input: { askId?: string },
  caller: OperationCaller
): { value: OperationCaller } | { reason: Rejection } {
  return input.askId || caller.source !== 'mcp'
    ? { value: caller }
    : {
        reason: {
          ok: false,
          reason:
            'ask_required: work serves an ask. In the human’s turn open it with neo.ask.open (each doneItem declares its check), then propose with its askId; in any other turn, propose under the ask you are working on.',
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

export const NEO_HUMAN_TURN_REFUSAL =
  'Neo can do this only while answering the human’s own chat message, not from a system note or consultation.';

function readNeoAskTold(service: NeoService, ask: NeoAsk): NonNullable<NeoSnapshot['told']> {
  const conversation = service.repo.conversationId();
  if (!conversation) return [];
  return service.publications
    .toldForAsk(conversation, ask)
    .slice(-NEO_ASK_TOLD_LIMIT)
    .map(({ publicationId, createdAt, shortText, triggerId }) => ({
      publicationId,
      at: createdAt,
      shortText: shortText.slice(0, NEO_ASK_TOLD_TEXT),
      ...(triggerId ? { triggerId } : {}),
    }));
}

function readNeoRuleSource(service: NeoService, caller: OperationCaller): string | null {
  if (caller.source === 'rpc' && caller.principal === 'local') return null;
  if (!caller.sessionId || !caller.neoTurn) return '';
  return neoPromptText(
    service.db
      .getSDKMessageRepo()
      .getStoredPromptsByUuid(caller.sessionId, neoTurnOrigin(caller.neoTurn))
      .filter((message) => (message as { inputKind?: unknown }).inputKind === 'human')
  );
}

function isNeoHumanTurn(service: NeoService, caller: OperationCaller): boolean {
  if (caller.source === 'rpc' && caller.principal === 'local') return true;
  const turn = caller.neoTurn;
  if (!turn?.isLive() || !caller.sessionId) return false;
  return (
    service.db.getSession(caller.sessionId)?.status === 'active' &&
    service.ownsHumanMessage(caller) &&
    (neoForwardHop(turn.messageId) !== null ||
      hasNeoHumanWorkInput(
        caller,
        service.db.getSDKMessageRepo().getStoredPromptsByUuid(caller.sessionId, neoTurnOrigin(turn))
      ))
  );
}

function admitNeoCaller(
  service: NeoService,
  caller: OperationCaller,
  name: string
): { value: OperationCaller } | { reason: Rejection } {
  if (caller.source === 'rpc' && caller.principal === 'local') return { value: caller };
  const binding = caller.sessionId ? service.repo.getBindingBySession(caller.sessionId) : null;
  if (caller.source !== 'mcp' || !binding || binding.kind === 'worker')
    return { reason: { ok: false, reason: 'This operation belongs to Neo.' } };
  if (name === 'neo.rule.save' && !isNeoHumanTurn(service, caller))
    return { reason: { ok: false, reason: NEO_HUMAN_TURN_REFUSAL } };
  if (['neo.open', 'neo.project.cancel', 'neo.session.track'].includes(name))
    return { reason: { ok: false, reason: 'This action needs the user.' } };
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
  service: Pick<NeoService, 'repo' | 'askRecords' | 'defaultSessionId'>,
  question: NeoProjectQuestion,
  attempt: number
): boolean {
  const session = service.defaultSessionId();
  if (!session) return false;
  const [source, target] = [question.sourceId, question.targetId].map(
    (id) => service.repo.getProject(id)?.title ?? id
  );
  const text = `Are ${source} and ${target} the same project? ${'why' in question ? question.why : `Both point at ${question.repository.slice(5)}.`}`;
  const opened = service.askRecords.open({
    id: crypto.randomUUID(),
    requestKey: neoProjectQuestionKey(question.key, attempt),
    projectId: NEO_INBOX_ID,
    originSessionId: session,
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

function settleNeoQuestions(
  service: NeoService,
  questions: () => readonly NeoProjectQuestion[]
): ReturnType<typeof settleNeoProjectQuestions> {
  return settleNeoProjectQuestions(
    questions,
    (question) =>
      readNeoProjectDecision(
        readNeoProjectQuestionAsks(service.askRecords, question.key),
        question.key
      ),
    (input) => service.repo.projectMerges.merge(input),
    (question, attempt) => askNeoProjectQuestion(service, question, attempt),
    (line) => service.logReorganize(line)
  );
}

export function neoReorganizeRuntime(
  service: NeoService,
  router: NeoRouter = createNeoRouter(service.db, service.repo, (projectId) =>
    service.open(projectId)
  )
): NeoReorganizeRuntime {
  return {
    getBinding: (sessionId) => service.repo.getBindingBySession(sessionId),
    rootSessionId: () => service.repo.defaultBinding()?.sessionId ?? null,
    liveAsks: () => service.askRecords.listLive(),
    ask: (id) => service.askRecords.get(id),
    route: (ask) => router(`${ask.title}\n${ask.ask}`),
    sessionStatus: (sessionId) =>
      neoSessionStatus(service.db.getSession(sessionId)?.processingState),
    projectSession: (projectId) => service.repo.getBindingForProject(projectId)?.sessionId ?? null,
    cards: (ask) => ask.workIds.flatMap((id) => service.repo.getWork(id) ?? []),
    deliver: (sessionId, messageId, content, from, parent) =>
      service.deliverForward(sessionId, messageId, content, from, parent, null),
    move: (ask, cards, owner) => service.moveAsk(ask, cards, owner),
    mergeProjects: async () => {
      const merges = service.repo.projectMerges;
      const before = new Set(merges.redirects().map((entry) => entry.sourceId));
      if (backfillNeoRepositoryIdentities(service.db.getDatabase())) service.notifyChanged();
      const backfilled = merges
        .redirects()
        .filter((entry) => !before.has(entry.sourceId))
        .map(({ sourceId, targetId }) => ({ sourceId, targetId }));
      const local = merges.localFolders(hostname());
      const fresh = await readNeoProjectIdentities(local, readWorkspaceIdentity);
      merges.recordIdentities(fresh);
      const merged = mergeNeoDuplicateProjects(
        () => merges.plan(fresh),
        (input) => merges.merge(input),
        (line) => service.logReorganize(line)
      );
      const settled = settleNeoQuestions(service, () => merges.questions(fresh));
      return { merged: [...backfilled, ...merged, ...settled.merged], asked: settled.asked };
    },
    projectFacts: () => service.repo.projectCleanupFacts(),
    retiredHolders: () => service.repo.retiredHolders(),
    machine: () => hostname(),
    cleanup: createNeoProjectCleanupApply(service),
    askMerge: async (step) => {
      const [source, target] =
        step.action === 'merge'
          ? [service.repo.getProject(step.projectId), service.repo.getProject(step.targetId)]
          : [null, null];
      if (!source || !target) return 'skipped a question';
      const settled = settleNeoQuestions(service, () => [
        {
          key: `neo-project-merge:${[source.id, target.id].sort().join('\u0000')}`,
          sourceId: source.id,
          targetId: target.id,
          sourceRevision: source.revision,
          targetRevision: target.revision,
          sourceIdentities: [],
          targetIdentities: [],
          why: `${source.title} has no repository, and most of its cards ran in ${target.title}.`,
        },
      ]);
      return settled.merged.length
        ? 'merged after the human said yes'
        : settled.asked.length
          ? 'asked the human'
          : 'still waiting on the human';
    },
    mirroredAliases: async (folders) => {
      const caller = {
        source: 'internal' as const,
        sessionId: service.repo.defaultBinding()?.sessionId,
        role: 'neo' as const,
      };
      const places: PlaceGroup[] = [];
      for (const folder of folders) {
        const outcome = await invokeOperation(
          service.sessions.getOperationRegistry(),
          'work.find',
          { folder, includeClosed: true, localOnly: true, limit: 50 },
          caller
        );
        const value =
          outcome.kind === 'completed'
            ? (outcome.value as {
                places?: PlaceGroup[];
                unreachable?: unknown[];
                more?: boolean;
              } | null)
            : null;
        if (!value?.places || value.unreachable?.length || value.more) return null;
        places.push(...value.places);
      }
      const local = {
        machine: hostname(),
        neoFolder: neoFolderPath(),
        isTemp: isTempCwd,
        exists: existsSync,
      };
      return neoMirroredAliases(places, (place) => isNeoPlumbingFolder(place, local));
    },
    log: (line) => service.logReorganize(line),
  };
}

export function createNeoOperations(service: NeoService) {
  function path<I, O>(name: string, action: (input: I, caller: OperationCaller) => O | Promise<O>) {
    return (superpipe({})(name) as PipelineAPI)
      .input(['input', 'caller'])
      .pipe(
        (caller: OperationCaller) => admitNeoCaller(service, caller, name),
        'caller',
        'result:admission'
      )
      .pipe(action, ['input', 'admission'], 'admission')
      .endAsync('admission') as (input: I, caller: OperationCaller) => Promise<O | Rejection>;
  }
  function unmutedAskSessions() {
    return unmutedNeoAskSessions(
      service.askSessions,
      service.db.getGlobalSettings?.().neo?.mutedSessions ?? []
    );
  }
  function projectCards(visibleWork: NeoWork[], asks: NeoAsk[]) {
    const workOf = new Map(visibleWork.map((item) => [item.id, item]));
    const workIds = [...workOf.keys()];
    const workPrs = service.workPrs
      .list(workIds)
      .map(({ workId, prs }) => ({ workId, prs, waiting: isNeoWorkPrWaiting(prs) }));
    const cards = projectNeoCardViews({
      work: visibleWork,
      drivers: workDrivers(workOf),
      waits: service.cardWaits(workIds, Date.now(), workOf),
      prs: workPrs,
      goals: service.workGoals.list(workIds),
      continues: service.workContinues.list(workIds),
      supersessions: service.workSupersessions.list(workIds),
      asks,
      refusals: service.workRefusals.list(),
      controlFailures: service.cardControlFailures(workIds),
    });
    return { workPrs, cards };
  }
  function workDrivers(workOf: ReadonlyMap<string, NeoWork>) {
    return service.driverTargets.receipts([...workOf.keys()]).map((receipt) => {
      const since = service.uncheckedSince(receipt.workId);
      const checkedAt = service.checkedAt(receipt.workId);
      return {
        ...receipt,
        ...(since === null ? {} : { uncheckedSince: since }),
        ...(checkedAt === null ? {} : { checkedAt }),
        ...(service.isRetryable(receipt.workId, workOf.get(receipt.workId) ?? null)
          ? { retryable: true as const }
          : {}),
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
      ? neoSnapshotOmitted(
          fitNeoSnapshotBudget(built, NEO_MCP_SNAPSHOT_BUDGET, { focused: !!askId }),
          built
        )
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
    const scope = focus
      ? (focus.projectId ?? undefined)
      : requested
        ? (service.repo.projectMerges.resolve(requested) ?? requested)
        : binding?.kind === 'project'
          ? binding.projectId
          : undefined;
    const detailed = caller.source === 'rpc' || binding?.kind === 'project';
    const cardDetail = detailed || !!focus;
    const compact = caller.source !== 'rpc' && !focus;
    const all = service.repo.listProjects();
    const projects = all.filter((item) =>
      focus ? item.id === focus.projectId : !scope || item.id === scope
    );
    const repositories = service.repo.repositories();
    const work = focus
      ? focus.workIds.flatMap((id) => service.repo.getWork(id) ?? [])
      : service.repo.listWork(scope === undefined ? undefined : scope);
    const limit = caller.source === 'rpc' ? 50 : 10;
    const recentWork = focus ? work.slice(-limit).reverse() : work.slice(0, limit);
    const olderActiveWork = focus
      ? []
      : work
          .slice(limit)
          .filter((item) => item.status === 'proposed' || item.status === 'queued')
          .slice(0, limit);
    const visibleWork = [...recentWork, ...olderActiveWork];
    const consultations = focus ? [] : service.consultations.list(scope ?? undefined);
    const waiters = focus ? [] : service.consultationWaiters.queued(scope ?? undefined);
    const listed = focus
      ? [focus]
      : service.askRecords.list(scope === undefined ? undefined : scope);
    const summarize = caller.source === 'rpc' && !focus && summaries;
    const asks = projectNeoSnapshotAsks(
      listed,
      caller.source === 'rpc' && !summarize ? 50 : NEO_SNAPSHOT_SETTLED_ASKS,
      Date.now(),
      new Set()
    );
    const visibleIds = new Set(visibleWork.map((row) => row.id));
    const askWorkIds = new Set(asks.flatMap((ask) => ask.workIds));
    const projectedWork =
      caller.source === 'rpc'
        ? work.filter((row) => visibleIds.has(row.id) || askWorkIds.has(row.id))
        : visibleWork;
    const { workPrs: allWorkPrs, cards: allCards } = projectCards(projectedWork, asks);
    const cards = allCards.filter((card) => visibleIds.has(card.workId));
    const cardOf = new Map(cards.map((card) => [card.workId, card]));
    const omittedWork = work.length - visibleWork.length;
    const omittedAsks = listed.length - asks.length;
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
        ? {
            conversationId: service.repo.conversationId(),
            defaultSessionId: service.defaultSessionId() ?? null,
            neoSessions: [
              service.repo.defaultBinding(),
              ...service.repo.listProjectBindings(),
            ].flatMap((binding) =>
              binding ? [{ sessionId: binding.sessionId, projectId: binding.projectId }] : []
            ),
            projectRedirects: service.repo.projectMerges.redirects(),
            routeFailure:
              new NeoRoutingLogRepository(service.db.getDatabase()).latestFailure() ?? undefined,
          }
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
      projects: projects.map((item) => {
        const aliases = service.repo.workspaceAliases(item.id, all);
        const folders = neoProjectFolders(aliases);
        return {
          ...item,
          ...(item.epicUrl ? { workspaceAliases: aliases } : {}),
          ...(repositories.get(item.id) ? { repository: repositories.get(item.id) } : {}),
          ...(folders.length ? { folders } : {}),
          context: detailed ? item.context : '',
        };
      }),
      consultations: consultations.map((item) =>
        detailed ? item : { ...item, question: '', answer: null }
      ),
      consultationWaiters: waiters.map((item) => (detailed ? item : { ...item, question: '' })),
      ...(caller.source === 'rpc' && !focus ? { sessionNotices: service.sessionNotices } : {}),
      sessionNoticeGroups: focus ? [] : latestNeoSessionNoticeGroups(service.sessionNoticeGroups),
      mutedSessions: service.db.getGlobalSettings?.().neo?.mutedSessions ?? [],
      preferences: service.modelPreference(),
      asks: compact ? compactNeoSnapshotAsks(asks) : asks,
      todoAsks: projectNeoAskEntries(
        focus ? [] : service.todos.listAsks(scope, caller.source === 'rpc' ? 50 : 10),
        service.todos,
        service.todoSessions,
        service.installedPacks()
      ),
      ...(focus ? { told: readNeoAskTold(service, focus) } : {}),
      ...(summarize
        ? { moreSettled: listed.filter(isNeoAskSettled).length > NEO_SNAPSHOT_SETTLED_ASKS }
        : {}),
      ...(omittedWork || omittedAsks
        ? {
            omitted: {
              ...(omittedWork ? { work: omittedWork } : {}),
              ...(omittedAsks ? { asks: omittedAsks } : {}),
            },
          }
        : {}),
      cards: compact ? compactNeoSnapshotCards(cards) : cards,
      sessionLoad: readNeoSessionLoad(service.db.getDatabase()).slice(0, 50),
      working: readNeoWorking(service.db.getDatabase()).slice(0, 100),
      askViews: projectNeoAskViews(
        asks,
        allCards,
        allWorkPrs,
        unmutedAskSessions(),
        busyNeoAskSessions(service.askSessions),
        caller.source === 'rpc'
          ? {
              work: projectedWork,
              supersessions: service.workSupersessions.list(projectedWork.map((row) => row.id)),
            }
          : undefined
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
              ...(cardOf.get(item.id)
                ? { phase: cardOf.get(item.id)!.phase, label: cardOf.get(item.id)!.label }
                : {}),
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
  const trackSession = (superpipe({})('neo.session.track') as PipelineAPI)
    .input(['input', 'caller', 'now'])
    .pipe(
      (caller: OperationCaller) => admitNeoCaller(service, caller, 'neo.session.track'),
      'caller',
      'result:track'
    )
    .pipe(() => requireNeoTrackRoot(service.defaultSessionId()), 'caller', 'result:track')
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
      'result:save'
    )
    .pipe(
      (input: z.infer<typeof SaveRules>, caller: OperationCaller) =>
        requireNeoRuleCitation(input, input.from, readNeoRuleSource(service, caller)),
      ['input', 'caller'],
      'result:save'
    )
    .pipe(() => ({ neo: service.db.getGlobalSettings().neo }), 'input', 'current')
    .pipe(
      (input: z.infer<typeof SaveRules>, current: { neo?: NeoSettings }) =>
        planNeoRuleEdit(neoStandingRules(current.neo), input),
      ['input', 'current'],
      'result:save'
    )
    .pipe(
      (rules: string[], current: { neo?: NeoSettings }) => {
        const updated = service.db.updateGlobalSettings({
          neo: { ...current.neo, standingRules: rules },
        });
        service.publishSettings?.(updated);
      },
      ['save', 'current']
    )
    .pipe(
      (caller: OperationCaller, rules: string[], current: { neo?: NeoSettings }) =>
        service.noteSavedRules(caller, planNeoSavedRules(neoStandingRules(current.neo), rules)),
      ['caller', 'save', 'current']
    )
    .pipe((rules: string[]) => ({ ok: true as const, standingRules: rules }), 'save', 'save')
    .end('save') as (
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
  const read = path('neo.snapshot', (input: z.infer<typeof Scope>, caller) => {
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
  });
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
      (input: ConsultRequest, root: NeoConsultationOrigin) =>
        service.repo.getProject(input.projectId)
          ? { value: root }
          : { reason: { ok: false, reason: 'Project not found.' } },
      ['input', 'admission'],
      'result:admission'
    )
    .pipe(
      (input: ConsultRequest, origin: NeoConsultationOrigin) => {
        const item = service.consultationFor(
          { sessionId: origin.originSessionId, messageId: origin.originMessageId },
          input.projectId
        );
        return item
          ? { reason: presentNeoConsultationReply({ ok: true as const, consultation: item }) }
          : { value: origin };
      },
      ['input', 'admission'],
      'result:admission'
    )
    .pipe((input: ConsultRequest) => service.open(input.projectId), 'input', 'sessionId')
    .pipe(
      (origin: NeoConsultationOrigin, caller: OperationCaller) =>
        requireLiveNeoConsultationOrigin(origin, caller.neoTurn),
      ['admission', 'caller'],
      'result:admission'
    )
    .pipe(
      (input: ConsultRequest, root: NeoConsultationOrigin, sessionId: string) =>
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
    input: ConsultRequest,
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
          : { reason: { ok: true, consultation: item, replyGuidance: NEO_CONSULTATION_SETTLED } },
      ['input', 'admission'],
      'result:admission'
    )
    .pipe(
      async (input: z.infer<typeof Respond>, item: z.infer<typeof Consultation>) => {
        const saved = service.consultations.finish(item.id, 'reported', input.answer)!;
        await service.syncConsultation(saved.id);
        return saved.status !== 'reported' || saved.answer !== input.answer
          ? { ok: true as const, consultation: saved, replyGuidance: NEO_CONSULTATION_SETTLED }
          : { ok: true as const, consultation: saved };
      },
      ['input', 'admission'],
      'admission'
    )
    .endAsync('admission') as (
    input: z.infer<typeof Respond>,
    caller: OperationCaller
  ) => Promise<z.infer<typeof ConsultationResult>>;
  const open = path('neo.open', async (input: z.infer<typeof Scope>, caller) => {
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
  });
  const readReceipt = path('neo.receipt.read', (input: z.infer<typeof ReceiptRead>, caller) => {
    const work = 'workId' in input ? service.repo.getWork(input.workId) : null;
    const consultation =
      'consultationId' in input ? service.consultations.get(input.consultationId) : null;
    if (caller.source !== 'rpc' || caller.principal !== 'local') {
      const binding = caller.sessionId ? service.repo.getBindingBySession(caller.sessionId) : null;
      if (
        !consultation ||
        !binding ||
        binding.kind === 'worker' ||
        consultation.originSessionId !== caller.sessionId ||
        !caller.neoTurn?.isLive()
      )
        return { ok: false as const, reason: 'This action needs the user.' };
    }
    if (work) return { ok: true as const, work };
    if (consultation) return { ok: true as const, consultation };
    return { ok: false as const, reason: 'Receipt not found.' };
  });
  const cancelConsultation = path('neo.project.cancel', async ({ id }: z.infer<typeof WorkId>) => {
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
  });
  const isHolder = (caller: OperationCaller) =>
    caller.source === 'mcp' &&
    !!caller.sessionId &&
    service.repo.getBindingBySession(caller.sessionId)?.kind === 'project';
  const save = (superpipe({})('neo.project.save') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(
      (input: SaveRequest, caller: OperationCaller) =>
        admitNeoCaller(service, caller, 'neo.project.save'),
      ['input', 'caller'],
      'result:admission'
    )
    .pipe(
      (input: SaveRequest, caller: OperationCaller) => requireNeoProjectSaveId(input, caller),
      ['input', 'admission'],
      'result:admission'
    )
    .pipe(
      (input: SaveRequest, caller: OperationCaller) => {
        const turn = caller.neoTurn;
        const origin =
          turn && caller.sessionId
            ? service.resolveAskOrigin({ sessionId: caller.sessionId, messageId: turn.messageId })
            : null;
        return isHolder(caller) &&
          (!turn?.isLive() ||
            (!turn.human && !turn.consultationId && !isNeoProjectEventTurn(origin ?? turn)))
          ? {
              reason: {
                ok: false as const,
                reason: 'A live holder input is required to save context.',
              },
            }
          : { value: caller };
      },
      ['input', 'admission'],
      'result:admission'
    )
    .pipe(
      (input: SaveRequest, caller: OperationCaller) => ({
        ...input,
        id: input.id ?? neoTurnRequestKey(caller, 'neo.project.save', input),
      }),
      ['input', 'admission'],
      'request'
    )
    .pipe(
      (input: SaveRequest, request: SaveRequest & { id: string }, caller: OperationCaller) => {
        const created = input.id ? null : service.repo.getProject(request.id);
        return created ? { reason: { ok: true as const, project: created } } : { value: caller };
      },
      ['input', 'request', 'admission'],
      'result:admission'
    )
    .pipe(
      (input: SaveRequest & { id: string }, caller: OperationCaller) => {
        const turn = caller.neoTurn;
        const consultation = isHolder(caller) && turn?.consultationId;
        const project = consultation
          ? service.repo.saveConsultationContext(
              input,
              input.expectedRevision,
              consultation,
              caller.sessionId!
            )
          : service.repo.saveProject(input, input.expectedRevision);
        return project
          ? { ok: true as const, project }
          : {
              ok: false as const,
              reason: consultation
                ? 'superseded: this request cannot save context. Return the uncertainty to Neo; a fresh consultation is required.'
                : 'superseded: read the current project before saving again',
            };
      },
      ['request', 'admission'],
      'admission'
    )
    .endAsync('admission') as (
    input: SaveRequest,
    caller: OperationCaller
  ) => Promise<
    | z.infer<typeof Failure>
    | { ok: true; project: NonNullable<ReturnType<NeoService['repo']['getProject']>> }
  >;
  const readGithub = path(
    'neo.github.read',
    async (
      input: z.infer<typeof GithubRead>
    ): Promise<NeoGithubReadResult | NeoGithubQueryResult> =>
      input.url
        ? await readNeoGithubRef(service, input.url)
        : await queryNeoGithub((args: string[]) => service.listGithub(args), {
            ...input,
            repo: input.repo!,
          })
  );
  const readPack = path('neo.pack.read', ({ id }: z.infer<typeof PackRead>) => {
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
  });
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
  const todoControls: NeoTodoControls = {
    start: (todoId) => service.todoRunner.start(todoId),
    proceed: (todoId, message) => service.todoRunner.proceed(todoId, message),
    retry: (todoId) => service.todoRunner.retry(todoId),
    stop: (todo) => service.todoRunner.stop(todo),
  };
  return [
    ...createNeoProjectTreeOperations(service.repo),
    createNeoCrossProjectOperation(service),
    createNeoIntakeOperation(
      service.db,
      service.repo,
      (sessionId) => {
        service.notifyChanged();
        void service.preemptForHumanMessage(sessionId);
      },
      router
    ),
    createNeoReorganizeOperation(neoReorganizeRuntime(service, router)),
    createNeoPublicationOperation(service.publish),
    ...createNeoPublicationChangeOperations({
      getBinding: (id) => service.repo.getBindingBySession(id),
      getRootBinding: () => service.repo.defaultBinding(),
      publications: service.publications,
      isConsultationReturn: (conversationId, publicationId) =>
        service.consultations.returnsPublication(conversationId, publicationId),
      resolveAskOrigin: (input) => service.resolveAskOrigin(input),
      resolveHumanAskOrigin: (input) => service.resolveHumanAskOrigin(input),
      notify: (conversationId) => {
        service.notifyChanged();
        service.notifyPublicationsChanged(conversationId);
      },
    }),
    createNeoRouteCorrectOperation(service.db, service.repo),
    createNeoRouteFailureOperation(service.db),
    createNeoInboxPromoteOperation({
      ...neoReorganizeRuntime(service, router),
      createProject: (title) =>
        openNeoNewProject(
          service.repo,
          (projectId) => service.open(projectId),
          neoNewProject(title, crypto.randomUUID())
        ),
    }),
    createNeoAskForwardOperation({
      getBinding: (sessionId) => service.repo.getBindingBySession(sessionId),
      resolveAskOrigin: (input) => service.resolveAskOrigin(input),
      forwards: (ask) => service.askForwards.list(ask),
      getProject: (id) => service.repo.getProject(id),
      listProjects: () => service.repo.listProjects(),
      openDefault: async () =>
        (
          await openNeoDefaultSession(service.repo, (projectId) =>
            reopenNeoHolder(service.repo, service.db, (id) => service.open(id), projectId)
          )
        ).sessionId,
      askContent: (ask) => {
        const conversation = service.repo.conversationId();
        const stored = conversation ? service.asks.find(conversation, ask.messageId) : null;
        return stored?.askOrigin.sessionId === ask.sessionId &&
          stored.askOrigin.messageId === ask.messageId
          ? stored.content
          : null;
      },
      open: (projectId) =>
        reopenNeoHolder(service.repo, service.db, (id) => service.open(id), projectId),
      record: (ask, forward) => service.askForwards.record(ask, forward),
      moveAsks: (from, to) => service.todos.moveAsks(from, to),
      unrecord: (ask, hop) => service.askForwards.remove(ask, hop),
      delivered: (sessionId, messageId) => service.hasDelivery(sessionId, messageId),
      delivering: (sessionId, messageId) => service.isDelivering(sessionId, messageId),
      deliver: (sessionId, messageId, content, from, ask) =>
        service.deliverForward(sessionId, messageId, content, from, ask, 'continues'),
    }),
    createNeoPublicationReadOperation(service.repo, service.publications),
    createNeoConversationReadOperation(
      service.repo,
      new NeoConversationReader(service.db.getDatabase())
    ),
    createNeoConversationAskReadOperation(service.repo, service.asks, (sessionId, messageId) =>
      service.db.getSDKMessageRepo().getUserSendStatus(sessionId, messageId)
    ),
    createNeoConversationImageReadOperation(service.repo, service.asks),
    createNeoDraftRecoveryOperation(service),
    createNeoPreferenceOperation(service),
    ...createNeoTodoOperations(service.todos, service.todoSessions, todoControls),
    ...createNeoAskRecordOperations(
      service.todos,
      service.todoSessions,
      todoControls,
      (sessionId) => service.repo.getBindingBySession(sessionId)?.projectId ?? null,
      (projectId) => service.repo.resolveProjectRef(projectId),
      (sessionId) => {
        const binding = service.repo.getBindingBySession(sessionId);
        return !!binding && binding.kind !== 'worker';
      },
      () => service.repo.listProjects()
    ),
    ...createNeoQuestionOperations(
      service.todos,
      (ask, question, note) =>
        service.deliverForward(
          ask.sessionId,
          `neo-question:${question.id}`,
          note,
          ask.sessionId,
          ask.originMessageId ? { sessionId: ask.sessionId, messageId: ask.originMessageId } : null,
          'continues'
        ),
      (todoId) => service.todoRunner.start(todoId)
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
        'Ask a context holder a question from the current root input. Returns a durable receipt; its answer arrives asynchronously. Repeating a completed consultation for the same human request returns its recorded receipt and full answer. Identical in-flight retries reuse their receipt.',
      inputSchema: Consult,
      resultSchema: ConsultationResult,
      policy: { safetyClass: 'mutate', roles: ['neo'] },
      execute: async (input, caller) =>
        consult(
          {
            ...input,
            requestKey: neoTurnRequestKey(caller, 'neo.project.consult', input),
          },
          caller
        ),
    }),
    defineOperation({
      name: 'neo.project.respond',
      description:
        'Record an answer to the root Neo for a consultation assigned to this context holder. A consultation that is already settled returns its recorded answer with replyGuidance; the new answer is not recorded and nothing more is sent.',
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
        'Read a receipt in full by workId or consultationId. Root Neo can read consultations it started; the human can read any receipt.',
      inputSchema: ReceiptRead,
      resultSchema: ReceiptResult,
      policy: { safetyClass: 'read', roles: ['neo'] },
      execute: readReceipt,
    }),
    defineOperation({
      name: 'neo.rule.save',
      description:
        'Add or remove standing rules (neo.snapshot standingRules); the other rules stay. Only while answering the human’s own message, when they state or correct something lasting about how work should go (what done means, where a project lives, which app to use) or answer your question about it: pass add with the new rule, remove with the exact text of a rule they replaced or withdrew, and from with the words of their message that state it, quoted exactly. Up to 20 rules of up to 500 characters.',
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
        'Track a session the human started themselves, from its notice: key is the notice key from snapshot.sessionNoticeGroups or sessionNotices. The daemon opens and approves one ask for the tap (a repeated tap within the track window reuses it), and Neo is asked to propose under that askId a card that adopts the session as its driver target ({verb:"adopt", ref}) without sending it anything; the tap counts as the human’s Start for that card, so it starts on its own.',
      inputSchema: SessionTrack,
      resultSchema: SessionTrackResult,
      policy: { safetyClass: 'human_only' },
      execute: (input, caller) => trackSession(input, caller, Date.now()),
    }),
    defineOperation({
      name: 'neo.github.read',
      description:
        'Read GitHub as it is now. With {url}, one pull request or issue: a pull request returns its state (OPEN, MERGED or CLOSED), checks (passing, failing, pending or none), review verdict on its current head (approved, changes_requested or none), merge blockers and title; an issue returns its state, how it closed (completed, not_planned or duplicate), the merged pull request that closed it, and its parent issue. With {repo: "owner/name", kind: "pr" or "issue", state: "open", "merged", "closed" or "all", by: "created", "updated", "merged" or "closed", since, until (ISO times) or withinHours (the last N hours up to now), limit}, a list: every match in that window with number, title, url, state, createdAt, updatedAt, mergedAt and closedAt, newest first, truncated when more matched than limit, and window {by, since, until} saying what the read covered (until is the read time when you leave it out, so leave it out for "recently" or "last N hours"). by defaults to merged for state merged, closed for closed, otherwise created. Use the list for any question about what happened in a time range ("which PRs merged in the last 2 hours") instead of guessing numbers and reading them one by one. Read-only.',
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
        'Read durable project summaries and execution receipts. Pass projectId to load that project’s full context, or askId to read one ask with its cards, their reports, drivers and pull requests, and told: every message the human actually received for it (read it before saying something was already sent). Without askId, settled asks keep only their title, status and a short outcome, and finished cards drop their goal and doneWhen; read one with askId when you need its full text. Each work item carries phase and label, the same card view the human sees: handed means given to a worker but not seen working yet; running means the worker reports it running, and its label says when that is not confirmed; cancelled closes the human request; it does not prove the external execution stopped. Optional controlFailure names unsupported/unavailable stop or withdraw, with detail and time; open the session to check. Phase labels describe the last observation, not a process shutdown guarantee. status is only storage, and queued does not mean running. A list that does not hold every item says so in omitted ({work, asks}: how many were left out), so never answer all or none from it. A snapshot over 40 KB is trimmed and carries a trimmed note saying what was cut. In a turn that belongs to an ask, the snapshot is scoped to that ask (scopedTo says which) unless you pass askId, projectId or all: true. Every snapshot carries rev; pass it back as sinceRev and an unchanged snapshot answers only {unchanged: true, rev}, so read again only after something happened.',
      inputSchema: Scope,
      resultSchema: Snapshot,
      policy: { safetyClass: 'read', roles: ['neo'] },
      execute: read,
    }),
    defineOperation({
      name: 'neo.project.save',
      description:
        'Create a continuing context only when needed, or update an existing context with revision protection. Never one project per message. To create, omit id and pass expectedRevision 0; the daemon assigns the id and returns it, and a retry of the same call in one Neo turn returns the same project; a call outside a Neo turn always creates a new one. To update, pass the id and current revision.',
      inputSchema: Save,
      resultSchema: z.union([Failure, z.object({ ok: z.literal(true), project: Project })]),
      policy: { safetyClass: 'mutate', roles: ['neo'] },
      execute: save,
    }),
  ];
}
