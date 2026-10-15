import { NeoDependencyRepository } from '../../storage/repositories/neo-dependency-repository.ts';
import { listNeoGithub, type NeoGithubLister } from './packs/coding/github-query.ts';
import { runNeoReadWork } from './read-work.ts';
import { spaceWorkRefForSession } from '../drivers/space-adapter.ts';
import { NeoWorkRefusalRepository } from '../../storage/repositories/neo-work-refusal-repository.ts';
import { reconcileNeoWorkRefusal } from './work-refusal.ts';
import {
  NeoCrossProjectRepository,
  neoCrossProjectReplyId,
  type NeoCrossProjectGroup,
  type NeoCrossProjectMember,
} from '../../storage/repositories/neo-cross-project-repository.ts';
import { neoForwardedText } from './ask-forward-operation.ts';
import { neoOutcomeCheckPolicy } from './outcome-check-policy.ts';
import { neoPrQuestionWithdrawalPolicy } from './packs/coding/question-withdrawal-policy.ts';
import {
  fillPrompt,
  NEO_SESSION_TRACK,
  NEO_WORK_DELEGATED,
  NEO_WORK_PACK_NOTE,
  NEO_WORK_RETURNED,
  NEO_WORK_RETURNED_RETRIED,
  NEO_WORK_RETURNED_RETRY,
} from '@hyperneo/prompts';
import type { GlobalSettings, MessageHub, Provider } from '@hyperneo/shared';
import { type NeoModelPreference, neoStandingRules } from '@hyperneo/shared/types/settings';
import type { NeoConsultation, NeoWork } from '@hyperneo/shared/types/neo-context';
import type { NeoPublication, NeoPublicationInput } from '@hyperneo/shared/types/neo-publication';
import { planNeoAnswerPublished } from './answer-outcome.ts';
import type { NeoConversationAsk } from '@hyperneo/shared/types/neo-conversation-ask';
import {
  isNeoWorkClosedDone,
  NEO_WORK_CLOSED_DONE_PREFIX,
  NEO_WORK_STALLED_CONTINUES,
  type NeoAsk,
  type NeoAskItem,
  type NeoAskSessionView,
  type NeoWorkGoal,
  type NeoWorkPr,
} from '@hyperneo/shared/types/neo-snapshot';
import { hostname } from 'node:os';
import type { NeoSnapshotRead } from './snapshot-read.ts';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { Database } from '../../storage/database.ts';
import type { OperationCaller } from '../operations/registry.ts';
import { DaemonInventoryRepository } from '../../storage/repositories/daemon-inventory-repository.ts';
import { NeoAgentWorkTargetRepository } from '../../storage/repositories/neo-agent-work-target-repository.ts';
import { NeoAskRepository } from '../../storage/repositories/neo-ask-repository.ts';
import { NeoInputOriginRepository } from '../../storage/repositories/neo-input-origin-repository.ts';
import { NeoAskForwardRepository } from '../../storage/repositories/neo-ask-forward-repository.ts';
import { neoForwardedAskMessageId, neoForwardMessageId } from './ask-forward-operation.ts';
import { NeoConsultationRepository } from '../../storage/repositories/neo-consultation-repository.ts';
import { NeoConsultationWaiterRepository } from '../../storage/repositories/neo-consultation-waiter-repository.ts';
import { NeoConversationAskRepository } from '../../storage/repositories/neo-conversation-ask-repository.ts';
import { NeoPublicationRepository } from '../../storage/repositories/neo-publication-repository.ts';
import { NeoRepository } from '../../storage/repositories/neo-repository.ts';
import { NeoRoutingLogRepository } from '../../storage/repositories/neo-routing-log-repository.ts';
import { NeoWorkDriverTargetRepository } from '../../storage/repositories/neo-work-driver-target-repository.ts';
import {
  NeoWorkCheckRepository,
  type NeoWorkCheckRow,
} from '../../storage/repositories/neo-work-check-repository.ts';
import { NeoCardPrRelayRepository } from '../../storage/repositories/neo-card-pr-relay-repository.ts';
import { NeoWorkContinueRepository } from '../../storage/repositories/neo-work-continue-repository.ts';
import { NeoWorkWakeRepository } from '../../storage/repositories/neo-work-wake-repository.ts';
import { NeoWorkSupersessionRepository } from '../../storage/repositories/neo-work-supersession-repository.ts';
import { NeoWorkGoalRepository } from '../../storage/repositories/neo-work-goal-repository.ts';
import {
  planNeoAskTickStatus,
  planNeoAskWorkStops,
  writeNeoAskTickStatus,
} from './ask-operations.ts';
import { NeoWorkPrRepository, type NeoWorkPrRow } from './packs/coding/neo-work-pr-repository.ts';
import { NeoCardEventSubscriptionRepository } from '../../storage/repositories/neo-card-event-subscription-repository.ts';
import {
  isNeoCardLive,
  planNeoCardEventRoute,
  planNeoCardSend,
  planNeoCardTopicsEnded,
  planNeoSessionTopicsHandedOver,
} from './card-events.ts';
import { sessionEventText } from '../external-events/session-event-delivery.ts';
import { SessionEventSubscriptionRepository } from '../../storage/repositories/session-event-subscription-repository.ts';
import type { ExternalEvent } from '../external-events/types.ts';
import type { NeoCardEventSubscription, NeoPackEventRoute } from './packs/types.ts';
import type { ExternalEventPublishedPayload } from '../external-events/external-event-service.ts';
import {
  SESSION_EVENT_SCOPE,
  SessionExternalEventStore,
} from '../external-events/session-external-event-store.ts';
import { NeoWorkResourceRepository } from '../../storage/repositories/neo-work-resource-repository.ts';
import type { WorkRef } from '../drivers/types.ts';
import type { DaemonInternalEventMap, InternalEventBus } from '../internal-event-bus.ts';
import { Logger } from '../logger.ts';
import { renderAddress } from '../mailbox/address.ts';
import { handoffPromptToMailbox } from '../mailbox/handoff.ts';
import { invokeOperation, type OperationOutcome } from '../operations/invoke.ts';
import type { SessionManager } from '../session/session-manager.ts';
import {
  createNeoAskOriginResolver,
  neoAskAnswerMessageId,
  neoAskTickedMessageId,
  neoAskEvidenceMessageId,
  neoAskParent,
  neoConsultationParent,
  neoReviewWorkId,
  neoWorkParent,
  type NeoAskOrigin,
  neoNeedsYouMessageId,
  neoDoneCheckMessageId,
  neoWorkReturnMessageId,
  neoStallMessageId,
  nudgedMessageId,
} from './ask-origin.ts';
import { neoConsultationReplyContent } from './consultation-reply-content.ts';
import { neoConsultationRequestContent } from './consultation-request-content.ts';
import { planNeoConsultationReturn } from './consultation-return-route.ts';
import {
  NEO_PUBLISH_NUDGE,
  type NeoDirectReplyRuntime,
  neoIdleReplySessions,
  neoNoteDeliveryMode,
  neoSessionStatus,
  publishNeoDirectReplyFallback,
} from './direct-reply-fallback.ts';
import {
  driverStartedReport,
  driverWorkCall,
  driverWorkCaller,
  type DriverSent,
  type NeoDriverTarget,
  readDriverOutcome,
  driverAdoptedReport,
  readDriverLive,
  readDriverOpenedPrs,
  readDriverCardExchange,
  isDriverCardCurrent,
  readDriverAdoptedSent,
  readDriverSendBaseline,
  neoCardSent,
  readDriverSent,
  messageOpening,
  planNeoStartReceiptAdoption,
  readDriverNeedsYou,
  driverNeedsYouNote,
  driverStuckNote,
  decideStuckReminder,
  driverDoneCheckNote,
  projectNeoAskCards,
  neoWorkDoneGoal,
  NEO_WORK_SUMMARY_NOTE,
  driverStallNote,
  NEO_WORK_STALL_MS,
  NEO_DRIVER_START_INTERRUPTED,
  readDriverActivity,
  requireNeoWorkRetryable,
  type NeoWorkRetryCard,
  withWorkGoal,
  readNeoWorkContinueBudget,
  neoStalledContinues,
  neoWorkProgress,
} from './driver-work.ts';
import {
  admitNeoWorkContinue,
  type NeoContinueCaller,
  type NeoContinueDeps,
  type NeoContinueResult,
  sendNeoWorkContinue,
} from './continue-work.ts';
import {
  isNeoCardAwaitingPr,
  isNeoCardDoneWhenMet,
  isNeoHumanInputSince,
  neoCardStalledWakes,
  neoCardWakeProgress,
} from './card-wake.ts';
import { type NeoDriverSettleDeps, settleNeoDriverWork } from './settle-driver-work.ts';
import { effectiveNeoPreference, planNeoAlignment } from './model-preference.ts';
import {
  type NeoSavedRulesNote,
  planNeoSavedRulesAppend,
  planNeoSavedRulesNote,
  withNeoSavedRules,
} from './saved-rules.ts';
import { neoFolderPath } from './folder.ts';
import { neoPrompt } from './prompt.ts';
import type { NeoPackFragment } from './packs/types.ts';
import { createNeoPublisher } from './publication-operation.ts';
import {
  neoCoordinatorAllowedTools,
  neoCoordinatorBinding,
  neoCoordinatorNativeTools,
} from './session-policy.ts';
import { neoAskStartedWork, readNeoTurnReply } from './turn-reply.ts';
import { createNeoWorkReporter } from './work-report.ts';
import { returnWorkThroughHolder } from './work-return.ts';
import { createNeoWorkTargetResolver } from './work-target.ts';
import {
  type NeoEvidence,
  type NeoEvidenceRead,
  neoEvidenceSignature,
  planNeoDoneCheck,
} from './evidence.ts';
import {
  localCodingSessionId,
  localCodingExecutionDirectory,
  currentCodingExecutionDirectory,
  neoWorkBranch,
  neoWorkRepoCwd,
  readGithubBranchPrs,
  readGithubWorkRepo,
  type NeoBranchPrReader,
  type NeoWorkRepoReader,
} from './packs/coding/branch-prs.ts';
import {
  hasNeoUnattachedOpenedPrs,
  neoCardOpenedPrs,
  planNeoCardPrCandidates,
  type NeoCardPrCandidate,
} from './packs/coding/card-pr-claims.ts';
import { NeoWorkPrClaimRepository } from './packs/coding/neo-work-pr-claim-repository.ts';
import { planNeoCardCheck } from './card-check.ts';
import {
  CODING_PACK_BRIEF,
  createCodingPack,
  type NeoCardPrDeps,
  readNeoCardPrs,
} from './packs/coding/pack.ts';
import { codingCardBase } from './packs/coding/watch-checks.ts';
import { createLifeAdminPack } from './packs/life-admin/pack.ts';
import { type NeoDeployReader, readGithubDeploys } from './packs/coding/deploy-checks.ts';
import { readNeoDaemonCommits } from './daemon-commits.ts';
import { remoteDaemons } from '../remote-daemons/registry.ts';
import { BUILD_METADATA } from '../build-metadata.ts';
import { buildNeoCheckRegistry } from './packs/check-registry.ts';
import { planNeoAvailabilityWakes, scheduleNeoAdmissionWake } from './admission-wake.ts';
import {
  admitNeoWork,
  isNeoAdmissionApproved,
  neoAdmissionRefusal,
  neoOutcomeEligibility,
} from './work-admission.ts';
import type { NeoCardWait } from './card-views.ts';
import { reconcileNeoHandoff } from './handoff-reconcile.ts';
import { readMergeCommit } from './packs/coding/deploy-checks.ts';
import {
  neoEnabledPacks,
  neoSettingsPackBriefs,
  neoPackBriefs,
  neoPackAskCardEvidence,
  neoPackAskTopics,
  neoPackChecks,
  neoPackEvidenceOrNone,
  neoPackFragment,
  neoPacks,
  neoPackTickWrite,
  planNeoPackTicks,
  readNeoAskEventTicks,
  readNeoAskPackEvidence,
  readNeoAskPackTicks,
  readNeoPackEvidence,
  requireNeoEvidenceRefresh,
  requireNeoPackTickable,
} from './packs/index.ts';
import type { NeoPack, NeoPackBrief } from './packs/types.ts';
import {
  requireNeoWorkPrCurrent,
  requireNeoWorkPrDelivery,
  type NeoWorkPrRefreshSkip,
  readGithubPrs,
  type NeoWorkPrReader,
} from './packs/coding/work-prs.ts';
import { closeNeoWork, type NeoWorkCloseOutcome, type NeoWorkCloseResult } from './work-close.ts';
import { planNeoDaemonCardSettle, requireNeoCardTurn } from './card-settle.ts';
import {
  isNeoAskLive,
  neoDoneCheckToldIds,
  requireNeoDoneCheck,
  requireNeoDoneCheckDue,
  requireNeoDoneCheckUntold,
  neoWorkReturnToldIds,
  requireNeoWorkReturnUntold,
  type NeoDoneCheckSkip,
} from './done-check.ts';
import {
  neoReminderTurn,
  planNeoReminderListings,
  planNeoRemindersSpent,
  planNeoWaitingReminders,
  type NeoReminderListing,
} from './waiting-reminders.ts';
import { type NeoSessionNotice, type NeoSessionNoticeGroup } from './session-watch.ts';
import { keepNeoTrackedSessions } from './session-track.ts';
import { neoAskPrKeys, type NeoAskPrs } from './session-ask-links.ts';
import {
  neoAskEvidenceNote,
  planNeoAskEvidenceNote,
  requireNeoAskEvidenceDue,
} from './ask-evidence.ts';
import {
  type NeoAskIdleSeen,
  neoAskIdleNote,
  neoAskIdleSignature,
  requireNeoAskIdle,
  trackNeoAskIdle,
} from './ask-idle.ts';
import { neoAskStalledNote, requireNeoAskStalled, requireNeoAskStallUntold } from './ask-stall.ts';
import { hashString32 } from '../runtime-hash.ts';
import {
  neoCardPrAttention,
  neoCardPrNeoNote,
  neoCardPrPending,
  requireNeoCardPrRelay,
} from './card-pr-relay.ts';
import {
  readCodingCardRefs,
  readGithubRefStates,
  type NeoRefStateReader,
} from './packs/coding/ask-prs.ts';
import {
  NeoAskCheckRepository,
  type NeoAskCheckRow,
} from '../../storage/repositories/neo-ask-check-repository.ts';
import {
  neoAskAnswerNote,
  neoAskTickedNote,
  neoAskReopensAfterClear,
  neoNeedsYouClearedNote,
  neoResumeWhy,
  planNeoNeedsYou,
  planNeoNeedsYouCleared,
  planNeoQuestionsWithdrawn,
} from './needs-you.ts';
import { NeoSessionWatcher } from './session-watcher.ts';
import { createNeoNoteQueueDeps, issueNeoNote, type NeoNoteQueueDeps } from './note-queue.ts';
import { createNeoPublicationCommit } from './publication-commit.ts';
import { NEO_TURN_LIMIT_PREFIX, neoTurnLimitNote, planNeoTurnLimitNote } from './turn-limit.ts';
import {
  isNeoDeliveryRetryPending,
  planNeoDeliveryRetry,
  scheduleNeoDeliveryRetry,
} from './delivery-retry.ts';
import { NeoSessionSeenRepository } from '../../storage/repositories/neo-session-seen-repository.ts';
import { NeoNotificationTriggerRepository } from '../../storage/repositories/neo-notification-trigger-repository.ts';
import {
  coverNeoAskTriggers,
  isNeoAskAnsweredByReply,
  neoReplyOriginKey,
  neoConsultationDelivery,
  neoDeliveryTrigger,
  neoHumanTrigger,
  type NeoDeliveryTrigger,
  NEO_TRIGGER_ACHIEVED_WINDOW_MS,
  NEO_TRIGGER_RETRY_MS,
  NEO_TRIGGER_SWEEP_MS,
  neoHumanTriggerMessageId,
  neoTriggerMessageId,
  neoTriggerMessageIds,
  planNeoTriggerRetry,
  neoTriggerNote,
  noteNeoAskTrigger,
  type NeoTriggerSweepDeps,
} from './notification-triggers.ts';
import { readNeoAskTriggerView } from './service-card-views.ts';
import {
  NEO_WORK_FOLLOW_MAX_AGE_MS,
  planNeoWorkFollow,
  planNeoWorkFollowLive,
  type NeoWorkFollowCard,
  requireNeoWorkFollow,
  requireNeoWorkFollowAnswered,
  requireNeoWorkFollowUp,
} from './work-follow.ts';
import {
  awaitingNeoWorker,
  NEO_WORK_AWAITING_WORKER,
  NEO_WORK_RESERVED_WORKER,
  neoWorkerRefKey,
  rerouteNeoDriverWork,
} from './work-reroute.ts';

const dispatchNeoConsultationWaiter = (
  superpipe({})('neo-consultation-waiter-dispatch') as PipelineAPI
)
  .input(['service', 'projectId'])
  .pipe(
    (service: NeoService, projectId: string) => {
      const item = service.consultationWaiters.admitNext(projectId);
      return item ? { value: item } : { reason: null };
    },
    ['service', 'projectId'],
    'result:admission'
  )
  .pipe(
    async (service: NeoService, item: NeoConsultation) => {
      await service.syncConsultation(item.id);
    },
    ['service', 'admission']
  )
  .endAsync('admission');

const NEO_STALLED_TURN_SETTLE_MS = 20_000;
const NEO_WORK_REVIEWED = 'The context holder reviewed the returned work.';
const NEO_WORK_REPORT_LIMIT = 12_000;

type NeoWorkPrCard = {
  ask: NeoAsk | null;
  goal: NeoWorkGoal | null;
  row: NeoWorkPrRow | null;
  session: boolean;
  packEvidence: boolean;
  toldAt: number | null;
  doneWhenMet: boolean;
};
type NeoWorkPrRefreshed = { read: NeoEvidenceRead | null; failed: boolean };
type NeoNeedsYouCard = {
  state: ReturnType<typeof readDriverNeedsYou>;
  noted: number | null;
  ask: NeoAsk | null;
  siblingsWaiting: boolean;
};
type NeoNeedsYouPlan = ReturnType<typeof planNeoNeedsYou>;
type NeoDoneCheckDelivery = {
  stale?: boolean;
  ask?: NeoAsk | null;
  followedAt?: number;
  signature?: string;
};
type NeoWorkTold = { row: NeoWorkCheckRow | null };
type NeoDoneCheckCard = {
  ask: NeoAsk | null;
  continued: number;
  stored: NeoWorkPrRow | null;
};
type NeoDoneCheckFound = { row: NeoWorkPrRow | null };
type NeoDoneCheckRead = NeoDoneCheckFound & { read: NeoEvidenceRead | null; stale: boolean };
type NeoReminderTurnInput = { sessionId: string; messageId: string };
type NeoRemindersDue = { key: string; asks: ReturnType<typeof planNeoWaitingReminders> };

const NEO_PREREQUISITE_BASE_RETRY_MS = 5 * 60_000;

export class NeoService {
  readonly outcomeCheckPolicy = neoOutcomeCheckPolicy;
  readonly prQuestionWithdrawalPolicy = neoPrQuestionWithdrawalPolicy;
  readonly repo: NeoRepository;
  readonly publications: NeoPublicationRepository;
  readonly asks: NeoConversationAskRepository;
  readonly publish: ReturnType<typeof createNeoPublisher>;
  readonly agentTargets: NeoAgentWorkTargetRepository;
  readonly driverTargets: NeoWorkDriverTargetRepository;
  readonly workGoals: NeoWorkGoalRepository;
  readonly workContinues: NeoWorkContinueRepository;
  readonly workWakes: NeoWorkWakeRepository;
  readonly workSupersessions: NeoWorkSupersessionRepository;
  readonly askRecords: NeoAskRepository;
  readonly dependencies: NeoDependencyRepository;
  readonly workPrs: NeoWorkPrRepository;
  readonly cardEvents: NeoCardEventSubscriptionRepository;
  private readonly sessionEvents: SessionExternalEventStore;
  private readonly sessionSubscriptions: SessionEventSubscriptionRepository;
  watchExternalTopic: ((topic: string) => Promise<void>) | null = null;
  readonly workPrClaims: NeoWorkPrClaimRepository;
  readonly workRefusals: NeoWorkRefusalRepository;
  readonly workChecks: NeoWorkCheckRepository;
  readonly askChecks: NeoAskCheckRepository;
  private readonly askEvidenceReads = new Map<string, number>();
  private readonly cardPrRelays: NeoCardPrRelayRepository;
  private askIdleSeen: NeoAskIdleSeen = new Map();
  get sessionNotices(): NeoSessionNotice[] {
    return this.sessionWatcher.sessionNotices;
  }

  get sessionNoticeGroups(): NeoSessionNoticeGroup[] {
    return this.sessionWatcher.sessionNoticeGroups;
  }

  get askSessions(): Map<string, NeoAskSessionView[]> {
    return this.sessionWatcher.askSessions;
  }

  get trackableNotices(): NeoSessionNotice[] {
    return [
      ...this.sessionWatcher.sessionNoticeGroups.flatMap((group) => group.notices),
      ...this.sessionWatcher.sessionNotices,
    ];
  }

  get trackedSessions(): Map<string, number> {
    return new Map(Object.entries(this.db.getGlobalSettings?.().neo?.trackedSessions ?? {}));
  }

  set trackedSessions(tracked: ReadonlyMap<string, number>) {
    const neo = this.db.getGlobalSettings().neo;
    this.db.updateGlobalSettings({
      neo: { ...neo, trackedSessions: Object.fromEntries(tracked) },
    });
  }

  readonly sessionWatcher: NeoSessionWatcher;
  private watching: Promise<unknown> | null = null;
  private disposed = false;
  filePacks: readonly NeoPack[] = [];
  private readonly builtinPacks: NeoPack[];
  readPrs: NeoWorkPrReader = readGithubPrs;
  readBranchPrs: NeoBranchPrReader = readGithubBranchPrs;
  readCheckoutPrs = (cwd: string): Promise<string[]> => readGithubBranchPrs({ cwd });
  readWorkRepo: NeoWorkRepoReader = readGithubWorkRepo;
  readRefStates: NeoRefStateReader = readGithubRefStates;
  listGithub: NeoGithubLister = (args) => listNeoGithub(args);
  readMergeCommit = (url: string): Promise<string | null> => readMergeCommit(url);
  readDeploys: NeoDeployReader = (urls) =>
    readGithubDeploys(urls, () =>
      readNeoDaemonCommits({ name: hostname(), commit: BUILD_METADATA.commit }, remoteDaemons)
    );
  private readonly watchedAskTopics = new Set<string>();
  readonly crossProjects: NeoCrossProjectRepository;
  readonly consultations: NeoConsultationRepository;
  readonly consultationWaiters: NeoConsultationWaiterRepository;
  readonly reportWork: ReturnType<typeof createNeoWorkReporter>;
  readonly resolveAskOrigin: ReturnType<typeof createNeoAskOriginResolver>;
  private readonly commitPublication: ReturnType<typeof createNeoPublicationCommit>;
  readonly inputOrigins: NeoInputOriginRepository;
  readonly askForwards: NeoAskForwardRepository;
  readonly resolveWorkTarget: ReturnType<typeof createNeoWorkTargetResolver>;
  readonly notifyChanged: () => void;
  readonly notifyPublicationsChanged: (conversationId: string) => void;
  private readonly noteQueue: NeoNoteQueueDeps;
  private readonly triggers: NeoNotificationTriggerRepository;
  private readonly triggerDeps: NeoTriggerSweepDeps;
  private readonly triggerCovers = new Map<string, Set<string>>();
  private triggerTimer?: ReturnType<typeof setTimeout>;
  private readonly pending = new Map<string | null, Promise<string>>();
  private readonly workPending = new Map<string, Promise<void>>();
  private readonly bootedAt = Date.now();
  private readonly deliveries = new Map<string, Promise<void>>();
  private readonly processingStatus = new Map<string, string>();
  private readonly interruptedSessions = new Set<string>();
  private readonly continuing = new Set<string>();
  private readonly activitySeen = new Map<string, { at: number; seenAt: number }>();
  private readonly cardOpenedPrs = new Map<string, string[]>();
  private readonly openedPrsTried = new Map<string, string>();
  private readonly followReads = new Map<string, number>();
  private readonly followWork = (superpipe({})('neo-work-follow') as PipelineAPI)
    .input(['work', 'now'])
    .pipe(
      (work: NeoWork) => this.followCard(work, this.followReads.get(work.id) ?? null),
      'work',
      'card'
    )
    .pipe(requireNeoWorkFollow, ['work', 'card', 'now'], 'result:follow')
    .pipe(
      async (
        work: NeoWork,
        ref: WorkRef,
        now: number,
        card: { since: number; sent: DriverSent | null }
      ) => {
        this.followReads.set(work.id, now);
        return {
          outcome: await this.invokeAsCard(work, 'work.status', {
            ref,
            since: card.sent?.inputBefore ?? card.since,
            ...(card.sent?.receipt ? { receipt: card.sent.receipt } : {}),
          }),
        };
      },
      ['work', 'follow', 'now', 'card'],
      'read'
    )
    .pipe(
      (work: NeoWork, read: { outcome: OperationOutcome }) =>
        this.adoptStartReceipt(work.id, read.outcome),
      ['work', 'read']
    )
    .pipe(planNeoWorkFollowLive, 'read', 'live')
    .pipe(
      (work: NeoWork, live: ReturnType<typeof planNeoWorkFollowLive>, now: number) => {
        const recorded =
          !!live && this.driverTargets.recordLive(work.id, live.status, live.link, live.remoteLink);
        if (this.recordCardCheck(work.id, !!live, now) || recorded) this.notifyChanged();
      },
      ['work', 'live', 'now']
    )
    .pipe(
      async (
        work: NeoWork,
        ref: WorkRef,
        live: ReturnType<typeof planNeoWorkFollowLive>,
        read: { outcome: OperationOutcome }
      ) => {
        if (
          live?.status !== 'needs_you' ||
          !isDriverCardCurrent(read.outcome, this.driverTargets.readSent(work.id))
        )
          return;
        const queued = this.repo.transitionWork(work.id, work, { status: 'queued' });
        if (queued) await this.noteDriverNeedsYou(queued, ref, read.outcome);
      },
      ['work', 'follow', 'live', 'read']
    )
    .pipe(requireNeoWorkFollowAnswered, ['live', 'follow'], 'result:follow')
    .pipe(requireNeoWorkFollowUp, ['work', 'card'], 'result:follow')
    .pipe(planNeoWorkFollow, ['work', 'read', 'card'], 'result:follow')
    .pipe(
      (work: NeoWork, report: string, read: { outcome: OperationOutcome }) => {
        const followed = this.repo.transitionWork(work.id, work, { status: 'reported', report });
        const seen = readDriverActivity(read.outcome)?.lastActivityAt;
        if (followed && seen !== undefined) this.driverTargets.recordFollowAnchor(work.id, seen);
        return { work: followed };
      },
      ['work', 'follow', 'read'],
      'follow'
    )
    .pipe(async (followed: { work: NeoWork | null }) => {
      if (followed.work) await this.checkDone(followed.work, true);
    }, 'follow')
    .endAsync('follow') as (work: NeoWork, now: number) => Promise<unknown>;
  private readonly checkDone = (superpipe({})('neo-work-done-check') as PipelineAPI)
    .input(['work', 'followed'])
    .pipe(
      (work: NeoWork) => {
        const ask = this.askRecords.forWork(work.id);
        return {
          ask,
          goal: neoWorkDoneGoal(work.id, this.workGoals.get(work.id), ask),
          driver: !!this.driverTargets.get(work.id),
          session: !!this.db.getSession(work.originSessionId),
          stored: this.workPrs.get(work.id),
          continued: this.workContinues.get(work.id)?.count ?? 0,
        };
      },
      'work',
      'card'
    )
    .pipe(requireNeoDoneCheck, ['work', 'card'], 'result:check')
    .pipe(
      (work: NeoWork, card: NeoDoneCheckCard, followed: boolean) => ({
        told:
          !card.stored &&
          this.toldDoneCheck(
            work,
            neoDoneCheckToldIds(
              work,
              card.continued,
              undefined,
              followed,
              this.stalledContinues(work)
            )
          ),
      }),
      ['work', 'card', 'followed'],
      'unread'
    )
    .pipe(requireNeoDoneCheckUntold, ['unread', 'check'], 'result:check')
    .pipe(
      async (work: NeoWork, card: NeoDoneCheckCard) => {
        let failed = false;
        const read = await readNeoPackEvidence(
          this.evidencePacks(card.ask, !!card.stored),
          work,
          (id, error) => {
            failed = true;
            this.log.warn(`Neo pack ${id} evidence read failed`, error);
          }
        );
        return {
          row: this.workPrs.get(work.id),
          read: neoPackEvidenceOrNone(read, failed, Date.now()),
          stale: failed || read?.read.ok === false,
        };
      },
      ['work', 'card'],
      'found'
    )
    .pipe(
      (work: NeoWork, card: NeoDoneCheckCard, followed: boolean, found: NeoDoneCheckRead) => ({
        told:
          !followed &&
          !!found.row &&
          this.toldDoneCheck(
            work,
            neoDoneCheckToldIds(
              work,
              card.continued,
              found.row.revision,
              false,
              this.stalledContinues(work)
            )
          ),
      }),
      ['work', 'card', 'followed', 'found'],
      'reread'
    )
    .pipe(requireNeoDoneCheckUntold, ['reread', 'check'], 'result:check')
    .pipe(requireNeoDoneCheckDue, ['found', 'check'], 'result:check')
    .pipe(
      (card: NeoDoneCheckCard) => ({
        ask: card.ask ? (this.runAskPackTicks(card.ask.id) ?? card.ask) : null,
      }),
      'card',
      'ticked'
    )
    .pipe(
      (work: NeoWork, found: NeoDoneCheckRead, ticked: { ask: NeoAsk | null }) =>
        planNeoDaemonCardSettle(work, found.read, ticked.ask),
      ['work', 'found', 'ticked'],
      'settle'
    )
    .pipe(
      (work: NeoWork, settle: { report: string | null }) => {
        const closed = settle.report
          ? this.repo.transitionWork(work.id, work, { status: 'reported', report: settle.report })
          : null;
        if (closed) this.endUnfollowedCardTopics(Date.now());
        return { report: closed ? settle.report : null };
      },
      ['work', 'settle'],
      'settled'
    )
    .pipe(requireNeoCardTurn, ['settled', 'check'], 'result:check')
    .pipe(
      async (
        work: NeoWork,
        goal: NeoWorkGoal,
        ticked: { ask: NeoAsk | null },
        found: NeoDoneCheckRead,
        followed: boolean
      ) => {
        await this.deliverDoneCheck(work, goal, found.row, {
          ask: ticked.ask,
          stale: found.stale,
          followedAt: followed ? work.updatedAt : undefined,
          signature: found.read ? neoEvidenceSignature(found.read.evidence) : undefined,
        });
        return 'checked' as const;
      },
      ['work', 'check', 'ticked', 'found', 'followed'],
      'check'
    )
    .endAsync('check') as (
    work: NeoWork,
    followed: boolean
  ) => Promise<'checked' | NeoDoneCheckSkip | 'daemon_settled'>;
  private readonly directReplies: NeoDirectReplyRuntime;
  private readonly replyRechecks = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly savedRules = new Map<string, NeoSavedRulesNote>();
  private readonly reminderListings = new Map<string, NeoReminderListing>();
  private readonly log = new Logger('Neo');
  private readonly unsubscribe: () => void;

  constructor(
    readonly db: Database,
    readonly sessions: SessionManager,
    hub: MessageHub,
    events: InternalEventBus<DaemonInternalEventMap>,
    readonly publishSettings?: (settings: GlobalSettings) => void
  ) {
    this.notifyChanged = () => {
      hub.event('neo.changed', {});
      this.scheduleTriggerSweep();
    };
    this.notifyPublicationsChanged = (conversationId) => {
      hub.event('neo.publications.changed', { conversationId });
    };
    this.triggers = new NeoNotificationTriggerRepository(db.getDatabase());
    this.triggerDeps = {
      busy: (ask) => this.isTriggerOwnerBusy(ask),
      read: (ask) => readNeoAskTriggerView(this, ask),
      work: (id) => this.repo.getWork(id),
      deliveryRetryPending: (id) => isNeoDeliveryRetryPending(this.db.getJobQueueRepo(), id),
      told: (askId) => this.triggers.told(askId),
      record: (askId, keys, triggerId) => this.triggers.record(askId, keys, triggerId, Date.now()),
      wake: (ask, trigger) =>
        this.open(ask.projectId)
          .then((target) =>
            this.deliver(
              target,
              neoTriggerMessageId(
                trigger.triggerId,
                this.triggers.noteStatuses(target, neoTriggerMessageIds(trigger.triggerId)).length
              ),
              neoTriggerNote(ask, trigger, this.lastHumanText()),
              target,
              neoAskParent(ask),
              { id: trigger.triggerId }
            )
          )
          .then(
            () => true,
            (error) => {
              this.log.warn('Trigger note pending; the next sweep retries it', error);
              this.scheduleTriggerSweep(NEO_TRIGGER_RETRY_MS);
              return false;
            }
          ),
    };
    this.noteQueue = createNeoNoteQueueDeps(db, (sessionId, messageIds) => {
      void events
        .publish('messages.statusChanged', { sessionId, messageIds, status: 'failed' })
        .catch(() => {});
    });
    this.sessionWatcher = new NeoSessionWatcher({
      db,
      rootSessionId: () => this.repo.getBindingForProject(null)?.sessionId,
      announceSessionNoticeGroup: (group) => hub.event('neo.session.notices', { group }),
      seen: new NeoSessionSeenRepository(db.getDatabase()),
      announceSessionNotice: (notice) => hub.event('neo.session.notice', notice),
      log: this.log,
      registry: () => this.sessions.getOperationRegistry(),
      followedCardRefs: (now) => this.followedCardRefs(now),
      mutedSessions: () => this.db.getGlobalSettings?.().neo?.mutedSessions,
      liveAskPrs: () => this.askRecords.listLive().map((ask) => this.askPrs(ask)),
      sessionBranchPrs: (ref) => this.sessionBranchPrs(ref),
      notifyChanged: () => this.notifyChanged(),
    });
    this.workRefusals = new NeoWorkRefusalRepository(db.getDatabase());
    this.repo = new NeoRepository(db.getDatabase(), this.notifyChanged, (settled) => {
      const wakes = planNeoAvailabilityWakes(settled, this.repo.listWork(), (id) =>
        this.dependencyBlockers(id).some((blocker) => blocker.workId !== id)
      );
      for (const id of wakes) scheduleNeoAdmissionWake(db.getJobQueueRepo(), id);
    });
    this.publications = new NeoPublicationRepository(db.getDatabase());
    this.asks = new NeoConversationAskRepository(db.getDatabase());
    this.agentTargets = new NeoAgentWorkTargetRepository(db.getDatabase());
    this.driverTargets = new NeoWorkDriverTargetRepository(db.getDatabase());
    this.workGoals = new NeoWorkGoalRepository(db.getDatabase());
    this.workContinues = new NeoWorkContinueRepository(db.getDatabase());
    this.workWakes = new NeoWorkWakeRepository(db.getDatabase());
    this.workSupersessions = new NeoWorkSupersessionRepository(db.getDatabase());
    this.askRecords = new NeoAskRepository(db.getDatabase(), this.notifyChanged, (cardId) => {
      for (const id of this.dependencies.dependents(cardId))
        scheduleNeoAdmissionWake(db.getJobQueueRepo(), id);
    });
    this.dependencies = new NeoDependencyRepository(
      db.getDatabase(),
      this.askRecords,
      this.notifyChanged
    );
    this.workPrs = new NeoWorkPrRepository(db.getDatabase());
    this.cardEvents = new NeoCardEventSubscriptionRepository(db.getDatabase());
    this.sessionEvents = new SessionExternalEventStore(db.getDatabase());
    this.sessionSubscriptions = new SessionEventSubscriptionRepository(db.getDatabase());
    this.cardPrRelays = new NeoCardPrRelayRepository(db.getDatabase());
    this.workPrClaims = new NeoWorkPrClaimRepository(db.getDatabase());
    this.workChecks = new NeoWorkCheckRepository(db.getDatabase());
    this.askChecks = new NeoAskCheckRepository(db.getDatabase());
    this.builtinPacks = [
      createCodingPack({
        ...this.cardPrDeps,
        runningPrUrls: (workIds) => this.runningPrUrls(workIds),
        cardReports: (workIds) => workIds.flatMap((id) => this.repo.getWork(id)?.report ?? []),
        readRefStates: (refs) => this.readRefStates(refs),
        readDeploys: (urls) => this.readDeploys(urls),
        readMergeCommit: (url) => this.readMergeCommit(url),
        cardBase: (workId) => codingCardBase(this.driverTargets.get(workId)),
      }),
      createLifeAdminPack(),
    ];
    this.crossProjects = new NeoCrossProjectRepository(db.getDatabase());
    this.consultations = new NeoConsultationRepository(db.getDatabase(), this.notifyChanged);
    this.consultationWaiters = new NeoConsultationWaiterRepository(
      db.getDatabase(),
      this.notifyChanged
    );
    this.reportWork = createNeoWorkReporter({
      readWork: (id) => this.repo.getWork(id),
      readBinding: (id) => this.repo.getBindingBySession(id),
      transitionWork: (id, expected, patch) => this.repo.transitionWork(id, expected, patch),
      returnReport: (work) => this.returnReport(work),
      resourceReports: new NeoWorkResourceRepository(db.getDatabase(), this.notifyChanged),
    });
    const inputOrigins = new NeoInputOriginRepository(db.getDatabase());
    this.inputOrigins = inputOrigins;
    this.askForwards = new NeoAskForwardRepository(db.getDatabase());
    this.resolveAskOrigin = createNeoAskOriginResolver({
      getBinding: (id) => this.repo.getBindingBySession(id),
      getPrompts: (sessionId, messageId) =>
        this.db.getSDKMessageRepo().getStoredPromptsByUuid(sessionId, messageId),
      getStamp: (sessionId, messageId) => inputOrigins.get(sessionId, messageId),
    });
    const publicationSettlements = new NeoConsultationRepository(db.getDatabase(), () => {});
    const notifyPublication = () => {
      try {
        void hub.event('neo.changed', {});
      } catch {}
    };
    this.publish = createNeoPublisher({
      getBinding: (id) => this.repo.getBindingBySession(id),
      getRootBinding: () => this.repo.getBindingForProject(null),
      hasProject: (id) => !!this.repo.getProject(id),
      getWork: (id) => this.repo.getWork(id),
      getConsultation: (id) => this.consultations.get(id),
      resolveAskOrigin: (input) => this.resolveAskOrigin(input),
      inputTrigger: (input) => this.inputTrigger(input),
      replay: (input, caller) => {
        const turn = caller.neoTurn;
        const item = turn?.consultationId ? this.consultations.get(turn.consultationId) : null;
        const binding = caller.sessionId ? this.repo.getBindingBySession(caller.sessionId) : null;
        if (
          caller.source !== 'mcp' ||
          !item ||
          binding?.kind !== 'project' ||
          binding.sessionId !== item.sessionId ||
          binding.projectId !== item.projectId ||
          turn?.messageId !== `neo-consult:${item.id}:request`
        )
          return null;
        const association = this.consultations.getPublication(item.id);
        if (!association) return null;
        const root = this.repo.getBindingForProject(null);
        if (root?.kind !== 'neo' || root.sessionId !== `neo:${association.conversationId}`)
          return { accepted: false, reason: 'publication_superseded' };
        const publication = this.publications.get(
          association.conversationId,
          association.publicationId
        );
        if (!publication) throw new Error('Committed consultation publication is missing');
        if (
          (publication.answerInput ?? publication.producerInput).sessionId !== caller.sessionId ||
          (publication.answerInput ?? publication.producerInput).messageId !== turn.messageId ||
          (!publication.answerInput && publication.publicationId !== input.publicationId) ||
          publication.shortText !== input.shortText ||
          publication.fullText !== input.fullText ||
          publication.askSummary !== input.askSummary ||
          publication.awaiting !== input.awaiting ||
          JSON.stringify(publication.links) !== JSON.stringify(input.links)
        )
          return { accepted: false, reason: 'publication_conflict' };
        notifyPublication();
        return { accepted: true, created: false, publication };
      },
      append: (input, consultationId) => this.commitPublication(input, consultationId),
      notify: notifyPublication,
    });
    this.commitPublication = createNeoPublicationCommit({
      commit: (input, consultationId) => {
        const problem = this.crossProjects.publicationProblem(input, consultationId);
        if (problem) return { accepted: false, reason: problem };
        if (!consultationId) return this.appendPublication(input);
        const receipt = publicationSettlements.settleWithPublication({
          consultationId,
          answer: input.fullText,
          publication: input,
        });
        if (!receipt.accepted) return receipt;
        const publication = this.publications.get(
          receipt.association.conversationId,
          receipt.association.publicationId
        );
        if (!publication) throw new Error('Committed consultation publication is missing');
        return { accepted: true, created: receipt.created, publication };
      },
      published: (input, publication) => {
        this.noteHumanReply(input);
        this.notePublishedAnswer(publication);
        if (publication.answerInput) this.notifyPublicationsChanged(publication.conversationId);
      },
    });
    this.resolveWorkTarget = createNeoWorkTargetResolver({
      readTarget: (id) => {
        const target = this.repo.getWorkTarget(id);
        const agent = target ? this.agentTargets.get(id) : null;
        return target && (agent ? { ...target, agent } : target);
      },
      readAgentOwner: (agent) => this.agentTargets.readOwner(agent),
      readSession: (id) => new DaemonInventoryRepository(db.getDatabase()).readSession(id),
      readBinding: (id) => this.repo.getBindingBySession(id),
    });
    const directReplies: NeoDirectReplyRuntime = {
      getBinding: (id) => this.repo.getBindingBySession(id),
      getRootBinding: () => this.repo.getBindingForProject(null),
      recentAsks: (conversationId, id) => this.recentAsksFor(conversationId, id),
      isPublished: (id, messageId) => !!this.publications.findByProducer(id, messageId),
      startedWork: (id, messageId) =>
        neoAskStartedWork(db, id, messageId) || this.forwardedAway(id, messageId),
      turnReply: (id, messageId) => readNeoTurnReply(db, id, messageId),
      hasNudge: (id, nudgeId) => this.hasDelivery(id, nudgeId),
      recheck: (id) => this.scheduleReplyRecheck(id, directReplies),
      nudge: (id, nudgeId) =>
        void this.deliver(
          id,
          nudgeId,
          NEO_PUBLISH_NUDGE,
          id,
          { sessionId: id, messageId: nudgedMessageId(nudgeId) ?? nudgeId },
          'continues'
        ).catch((error) => this.log.warn('Publish nudge failed', error)),
      append: (input) => this.commitPublication(input),
      notify: notifyPublication,
      newId: () => crypto.randomUUID(),
    };
    this.directReplies = directReplies;
    const offHumanInput = events.subscribe(
      'message.persisted',
      ({ sessionId, messageId }) => {
        const human = db
          .getSDKMessageRepo()
          .getStoredPromptsByUuid(sessionId, messageId)
          .some((message) => 'inputKind' in message && message.inputKind === 'human');
        if (!human) return;
        const at =
          db.getSDKMessageRepo().getUserMessageByUuid(sessionId, messageId)?.timestamp ?? 0;
        for (const row of this.workRefusals.list()) {
          if (
            at > row.at &&
            !row.ref.daemon &&
            ((row.ref.adapter === 'hyperneo' && row.ref.id === sessionId) ||
              (row.ref.adapter === 'space' &&
                row.ref.id === spaceWorkRefForSession(db.getDatabase(), sessionId)?.id)) &&
            this.workRefusals.clear(row)
          )
            this.notifyChanged();
        }
      },
      { subscriberName: 'neo-work-refusal-human-input' }
    );
    const offUpdated = events.subscribe(
      'session.updated',
      async ({ sessionId, processingState }) => {
        const status = processingState?.status;
        if (status) this.processingStatus.set(sessionId, status);
        if (status === 'interrupted') this.interruptedSessions.add(sessionId);
        else if (status && status !== 'idle') this.interruptedSessions.delete(sessionId);
        if (status !== 'idle') return;
        for (const item of this.consultations
          .unsettled()
          .filter((item) => item.sessionId === sessionId)) {
          await this.syncConsultation(item.id).catch((error) =>
            this.log.warn('Consultation return pending', error)
          );
        }
        const binding = this.repo.getBindingBySession(sessionId);
        if (binding && binding.kind !== 'worker')
          await this.alignModelPreference(sessionId).catch((error) =>
            this.log.warn('Neo model preference not applied', error)
          );
        if (binding && binding.kind !== 'worker')
          await this.noteTurnLimit(sessionId).catch((error) =>
            this.log.warn('Turn-limit note pending', error)
          );
        if (binding && binding.kind !== 'worker') {
          try {
            publishNeoDirectReplyFallback(sessionId, directReplies, {
              settled: false,
              interrupted: this.interruptedSessions.has(sessionId),
            });
          } catch (error) {
            this.log.warn('Direct reply fallback failed', error);
          }
          this.coverHumanReply(sessionId);
          this.scheduleTriggerSweep();
        }
        if (binding?.kind === 'project' && binding.projectId)
          await this.dispatchConsultationWaiter(binding.projectId).catch((error) =>
            this.log.warn('Consultation admission pending', error)
          );
        const work = this.repo.findWorkBySession(sessionId);
        if (work)
          return this.reconcile(work.id).catch((error) =>
            this.log.warn('Work return pending', error)
          );
      },
      { subscriberName: 'neo-work-return' }
    );
    const offStatus = events.subscribe(
      'messages.statusChanged',
      ({ sessionId, status }) => {
        if (status === 'failed' && sessionId && this.repo.getBindingBySession(sessionId))
          this.notifyChanged();
      },
      { subscriberName: 'neo-ask-delivery' }
    );
    const offDeleted = events.subscribe(
      'session.deleted',
      ({ sessionId }) => this.forgetSession(sessionId),
      { subscriberName: 'neo-session-forget' }
    );
    const offExternal = events.subscribe(
      'externalEvent.published',
      async (payload: ExternalEventPublishedPayload) => {
        await this.routeCardEvent(payload).catch((error) =>
          this.log.warn('Card event delivery pending', error)
        );
        await this.runAskEventTicks(payload).catch((error) =>
          this.log.warn('Neo ask event ticks pending', error)
        );
      },
      { subscriberName: 'neo-card-events', namespaceId: SESSION_EVENT_SCOPE }
    );
    this.unsubscribe = () => {
      offHumanInput();
      offUpdated();
      offStatus();
      offDeleted();
      offExternal();
    };
  }

  private adoptStartReceipt(workId: string, outcome: OperationOutcome): void {
    const sent = planNeoStartReceiptAdoption(
      outcome,
      this.driverTargets.readSent(workId),
      this.driverTargets.get(workId)?.verb
    );
    if (sent) this.driverTargets.recordSent(workId, sent);
  }

  private recordCardCheck(workId: string, read: boolean, now: number): boolean {
    const prior = this.driverTargets.readCardCheck(workId) ?? undefined;
    const { next, changed } = planNeoCardCheck(prior, read, now);
    this.driverTargets.recordCardCheck(workId, next);
    return changed;
  }

  checkedAt(workId: string): number | null {
    return this.driverTargets.readCardCheck(workId)?.checkedAt ?? null;
  }

  uncheckedSince(workId: string): number | null {
    const check = this.driverTargets.readCardCheck(workId);
    return check?.unchecked ? check.checkedAt : null;
  }

  private pruneReadThrottles(now: number): void {
    const followed = new Set(
      this.driverTargets.cardRefs(now - NEO_WORK_FOLLOW_MAX_AGE_MS).map((card) => card.workId)
    );
    for (const workId of this.followReads.keys())
      if (!followed.has(workId)) this.followReads.delete(workId);
    const live = new Set(this.askRecords.listLive().map((ask) => ask.id));
    for (const askId of this.askEvidenceReads.keys())
      if (!live.has(askId)) this.askEvidenceReads.delete(askId);
  }

  noteSavedRules(caller: OperationCaller, saved: readonly string[]): void {
    const keep = planNeoSavedRulesNote(
      { sessionId: caller.sessionId, messageId: caller.neoTurn?.messageId },
      saved,
      this.savedRules
    );
    if (keep) this.keepSavedRules(keep);
  }

  private keepSavedRules({
    key,
    note,
    evict,
  }: {
    key: string;
    note: NeoSavedRulesNote;
    evict: string[];
  }) {
    for (const old of [...evict, key]) this.savedRules.delete(old);
    this.savedRules.set(key, note);
  }

  private isHumanInput(input: NeoAskOrigin): boolean {
    return this.db
      .getSDKMessageRepo()
      .getStoredPromptsByUuid(input.sessionId, input.messageId)
      .some(
        (message) =>
          message.type === 'user' && 'inputKind' in message && message.inputKind === 'human'
      );
  }

  private triggerAsks(): NeoAsk[] {
    return [
      ...this.askRecords.listLive(),
      ...this.askRecords.achievedSince(Date.now() - NEO_TRIGGER_ACHIEVED_WINDOW_MS),
    ];
  }

  private scheduleTriggerSweep(delay = NEO_TRIGGER_SWEEP_MS): void {
    if (this.triggerTimer || this.disposed) return;
    this.triggerTimer = setTimeout(() => {
      this.triggerTimer = undefined;
      void this.sweepTriggers().catch((error) => this.log.warn('Trigger sweep pending', error));
    }, delay);
    this.triggerTimer.unref?.();
  }

  private async sweepTriggers(): Promise<void> {
    if (this.disposed || !this.triggers.isSeeded()) return;
    this.retryUnpublishedTriggers();
    for (const ask of this.triggerAsks()) {
      try {
        await noteNeoAskTrigger(ask, this.triggerDeps);
      } catch (error) {
        this.log.warn(`Trigger check for ask ${ask.id} failed`, error);
      }
    }
  }

  private seedTriggers(): void {
    if (this.triggers.isSeeded()) return;
    for (const ask of this.triggerAsks())
      coverNeoAskTriggers(ask, this.triggerDeps, ['outcome', 'failed', 'idle', 'action']);
    this.triggers.markSeeded(Date.now());
  }

  private retryUnpublishedTriggers(): void {
    const root = this.repo.getBindingForProject(null);
    if (!root?.sessionId.startsWith('neo:')) return;
    const conversationId = root.sessionId.slice(4);
    for (const { askId, triggerId } of this.triggers.pending(
      Date.now() - NEO_TRIGGER_ACHIEVED_WINDOW_MS
    )) {
      const ask = this.askRecords.get(askId);
      const target = ask ? this.repo.getBindingForProject(ask.projectId)?.sessionId : null;
      if (!ask || !target || this.isTriggerOwnerBusy(ask)) continue;
      const plan = planNeoTriggerRetry(
        this.publications.hasTrigger(conversationId, triggerId, ''),
        this.triggers.noteStatuses(target, neoTriggerMessageIds(triggerId))
      );
      if (plan === 'retry') this.triggers.forget(askId, triggerId);
    }
  }

  private isTriggerOwnerBusy(ask: NeoAsk): boolean {
    const owner = this.repo.getBindingForProject(ask.projectId)?.sessionId;
    if (!owner) return true;
    const status =
      this.processingStatus.get(owner) ??
      neoSessionStatus(this.db.getSession(owner)?.processingState);
    return status !== null && status !== 'idle';
  }

  private lastHumanText(): string | null {
    const root = this.repo.getBindingForProject(null);
    if (!root?.sessionId.startsWith('neo:')) return null;
    const content = this.asks.list(root.sessionId.slice(4), 0, 1, Number.MAX_SAFE_INTEGER)?.[0]
      ?.content;
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return null;
    return (
      content
        .flatMap((block) =>
          block.type === 'text' && typeof block.text === 'string' ? [block.text] : []
        )
        .join('\n')
        .trim() || null
    );
  }

  private notePublishedAnswer(publication: NeoPublication): void {
    const triggerId = publication.triggerId;
    if (!triggerId) return;
    const traced = this.triggers.trigger(triggerId);
    const outcome = traced?.keys.some((key) => key.startsWith('outcome:'))
      ? this.askRecords.get(traced.askId)
      : null;
    const human =
      neoHumanTriggerMessageId(triggerId) === publication.askOrigin.messageId
        ? this.askRecords.liveForOrigin(
            publication.askOrigin.sessionId,
            publication.askOrigin.messageId
          )
        : null;
    for (const ask of new Set([outcome, human].filter((ask) => ask !== null))) {
      const plan = planNeoAnswerPublished(ask, publication.publicationId);
      if (!plan) continue;
      for (const { item, evidence } of plan.ticks)
        this.askRecords.tickItem(
          ask.id,
          { ...item, state: 'met', evidence, metBy: 'daemon' },
          Date.now(),
          item,
          true
        );
      const ticked = this.askRecords.get(ask.id);
      if (!plan.settle || !ticked) continue;
      this.askRecords.settle(
        ticked,
        'achieved',
        publication.shortText,
        `Answered the human in publication ${publication.publicationId}.`
      );
      const works = ticked.workIds.flatMap((id) => this.repo.getWork(id) ?? []);
      for (const stop of planNeoAskWorkStops(works, 'achieved'))
        void this.close(stop.id, stop.close).catch((error) =>
          this.log.warn(`Closing card ${stop.id} after its answer was published failed`, error)
        );
    }
  }

  private noteHumanReply(input: NeoPublicationInput): void {
    const human = neoHumanTriggerMessageId(
      input.triggerId ?? this.inputTrigger(input.producerInput) ?? undefined
    );
    if (!human) return;
    const covers = this.triggerCovers.get(input.producerInput.sessionId) ?? new Set<string>();
    covers.add(neoReplyOriginKey(input.askOrigin));
    covers.add(neoReplyOriginKey({ sessionId: input.askOrigin.sessionId, messageId: human }));
    this.triggerCovers.set(input.producerInput.sessionId, covers);
    this.coverHumanReply(input.producerInput.sessionId, false);
  }

  private coverHumanReply(sessionId: string, settled = true): void {
    const covers = this.triggerCovers.get(sessionId);
    if (!covers) return;
    if (settled) this.triggerCovers.delete(sessionId);
    for (const ask of this.triggerAsks())
      if (isNeoAskAnsweredByReply(ask, covers))
        coverNeoAskTriggers(ask, this.triggerDeps, ['outcome', 'action']);
  }

  noteCorrectionReply(publication: NeoPublicationInput): void {
    if (!publication.triggerId) return;
    this.spendWaitingReminders(publication.producerInput);
    this.noteHumanReply(publication);
  }

  private appendPublication(input: NeoPublicationInput) {
    const plan = planNeoSavedRulesAppend(input, this.savedRules, {
      standingRules: neoStandingRules(this.db.getGlobalSettings?.().neo),
      stored: !!this.publications.get(input.conversationId, input.publicationId),
    });
    const receipt = this.crossProjects.append(input, undefined, () =>
      this.publications.append(withNeoSavedRules(input, plan.rules))
    );
    if (receipt.accepted && plan.keep) this.keepSavedRules(plan.keep);
    if (receipt.accepted && receipt.created && !input.interim)
      this.spendWaitingReminders(input.producerInput);
    return receipt;
  }

  waitingReminders(turn: { sessionId: string; messageId: string }) {
    const route = new NeoRoutingLogRepository(this.db.getDatabase()).find(
      nudgedMessageId(turn.messageId) ?? turn.messageId
    );
    return route
      ? planNeoWaitingReminders(this.askRecords.waitingFor(turn.sessionId), route.askedAt)
      : [];
  }

  readonly listWaitingReminders = (superpipe({})('neo-waiting-reminders-list') as PipelineAPI)
    .input(['turn'])
    .pipe(
      (turn: NeoReminderTurnInput) => ({
        key: neoReminderTurn(turn),
        asks: this.waitingReminders(turn),
      }),
      'turn',
      'due'
    )
    .pipe(
      (due: NeoRemindersDue) => planNeoReminderListings(this.reminderListings, due.asks, due.key),
      'due',
      'plan'
    )
    .pipe((plan: ReturnType<typeof planNeoReminderListings>) => {
      for (const id of plan.evict) this.reminderListings.delete(id);
      for (const [id, listing] of plan.entries) {
        this.reminderListings.delete(id);
        this.reminderListings.set(id, listing);
      }
    }, 'plan')
    .end('due') as (turn: NeoReminderTurnInput) => NeoRemindersDue;

  private readonly spendWaitingReminders = (
    superpipe({})('neo-waiting-reminders-spend') as PipelineAPI
  )
    .input(['turn'])
    .pipe(
      (turn: NeoReminderTurnInput) => ({
        key: neoReminderTurn(turn),
        asks: this.waitingReminders(turn),
      }),
      'turn',
      'due'
    )
    .pipe(
      (due: NeoRemindersDue) => planNeoRemindersSpent(this.reminderListings, due.asks, due.key),
      'due',
      'plan'
    )
    .pipe((plan: ReturnType<typeof planNeoRemindersSpent>) => {
      this.askRecords.markReminded(plan.spent, Date.now());
      for (const id of plan.drop) this.reminderListings.delete(id);
    }, 'plan')
    .end('plan') as (turn: NeoReminderTurnInput) => unknown;

  modelPreference(): (NeoModelPreference & { saved: boolean }) | null {
    const root = this.repo.getBindingForProject(null)?.sessionId;
    const settings = this.db.getGlobalSettings?.();
    return effectiveNeoPreference(
      settings?.neo?.preferences,
      root ? (this.db.getSession(root)?.config ?? null) : null,
      settings?.thinkingLevel
    );
  }

  async saveModelPreference(preferences: NeoModelPreference): Promise<void> {
    const neo = this.db.getGlobalSettings().neo;
    const updated = this.db.updateGlobalSettings({ neo: { ...neo, preferences } });
    this.publishSettings?.(updated);
    for (const binding of [
      this.repo.getBindingForProject(null),
      ...this.repo.listProjectBindings(),
    ]) {
      if (binding)
        await this.alignModelPreference(binding.sessionId).catch((error) =>
          this.log.warn('Neo model preference not applied', error)
        );
    }
  }

  private async alignModelPreference(sessionId: string): Promise<void> {
    const preference = this.modelPreference();
    const config = this.db.getSession(sessionId)?.config;
    const plan = preference && config ? planNeoAlignment(config, preference) : null;
    if (!preference || !plan) return;
    const live = await this.sessions.getSessionForControl(sessionId);
    if (!live) return;
    if (plan.model) {
      const switched = await live.handleModelSwitch(preference.model, preference.provider, true);
      if (!switched.success)
        return this.log.warn(`Neo session ${sessionId} keeps its model: ${switched.error ?? ''}`);
    }
    if (plan.thinking)
      await this.sessions.updateSession(sessionId, {
        config: { ...live.getSessionData().config, thinkingLevel: preference.thinkingLevel },
      });
  }

  readonly snapshotReads = new Map<string, NeoSnapshotRead>();

  private forgetSession(sessionId: string): void {
    for (const key of this.snapshotReads.keys())
      if (key.startsWith(`${sessionId}\n`)) this.snapshotReads.delete(key);
    this.processingStatus.delete(sessionId);
    this.interruptedSessions.delete(sessionId);
    const timer = this.replyRechecks.get(sessionId);
    if (timer) clearTimeout(timer);
    this.replyRechecks.delete(sessionId);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.unsubscribe();
    if (this.triggerTimer) clearTimeout(this.triggerTimer);
    this.triggerTimer = undefined;
    for (const timer of this.replyRechecks.values()) clearTimeout(timer);
    this.replyRechecks.clear();
    this.processingStatus.clear();
    this.interruptedSessions.clear();
    if (this.watching) await this.watching;
    this.sessionWatcher.flushSessionNoticeGroup();
  }

  private resumeDirectReplies(): void {
    const bindings = [this.repo.getBindingForProject(null), ...this.repo.listProjectBindings()];
    const idle = neoIdleReplySessions(bindings, (id) =>
      neoSessionStatus(this.db.getSession(id)?.processingState)
    );
    for (const sessionId of idle) {
      this.processingStatus.set(sessionId, 'idle');
      try {
        publishNeoDirectReplyFallback(sessionId, this.directReplies, {
          settled: false,
          interrupted: true,
        });
      } catch (error) {
        this.log.warn('Direct reply recovery pending', error);
      }
    }
  }

  private scheduleReplyRecheck(sessionId: string, runtime: NeoDirectReplyRuntime): void {
    if (this.replyRechecks.has(sessionId)) return;
    const timer = setTimeout(() => {
      this.replyRechecks.delete(sessionId);
      if (this.processingStatus.get(sessionId) !== 'idle') return;
      try {
        publishNeoDirectReplyFallback(sessionId, runtime, {
          settled: true,
          interrupted: this.interruptedSessions.has(sessionId),
        });
      } catch (error) {
        this.log.warn('Direct reply recheck failed', error);
      }
    }, NEO_STALLED_TURN_SETTLE_MS);
    timer.unref?.();
    this.replyRechecks.set(sessionId, timer);
  }

  open(projectId: string | null): Promise<string> {
    const key = projectId;
    const existing = this.pending.get(key);
    if (existing) return existing;
    const operation = this.ensureCoordinator(projectId).finally(() => this.pending.delete(key));
    this.pending.set(key, operation);
    return operation;
  }

  private async ensureCoordinator(projectId: string | null): Promise<string> {
    const project = projectId ? this.repo.getProject(projectId) : null;
    if (projectId && !project) throw new Error('This project no longer exists.');
    let binding = this.repo.getBindingForProject(projectId);
    if (!binding) {
      this.repo.reserveBinding({
        sessionId: `neo:${crypto.randomUUID()}`,
        projectId,
        kind: projectId ? 'project' : 'neo',
      });
      binding = this.repo.getBindingForProject(projectId);
    }
    if (!binding) throw new Error('Could not reserve Neo context.');
    if (!this.db.getSession(binding.sessionId)) {
      const root = projectId ? this.repo.getBindingForProject(null)?.sessionId : undefined;
      const rootSession = root ? this.db.getSession(root) : null;
      const preference = this.modelPreference();
      await this.sessions.createSession({
        sessionId: binding.sessionId,
        parentSessionId: rootSession ? root : undefined,
        title: project ? `Neo · ${project.title}` : 'Neo',
        workspacePath: neoFolderPath(),
        detectGit: false,
        config: {
          systemPrompt: neoPrompt(projectId, this.packBriefs()),
          sdkToolsPreset: neoCoordinatorNativeTools(projectId),
          permissionMode: 'dontAsk',
          allowedTools: neoCoordinatorAllowedTools(projectId),
          maxTurns: 32,
          ...(preference
            ? {
                model: preference.model,
                provider: preference.provider as Provider,
                thinkingLevel: preference.thinkingLevel,
              }
            : rootSession?.config?.model
              ? { model: rootSession.config.model, provider: rootSession.config.provider }
              : {}),
        },
      });
    }
    return binding.sessionId;
  }

  async start(id: string): Promise<void> {
    return this.startPending(id);
  }

  private startPending(id: string): Promise<void> {
    const current = this.workPending.get(id);
    if (current) return current;
    const operation = this.startReservedWork(id)
      .catch(async (error) => {
        const work = this.repo.getWork(id);
        if (work?.status === 'queued')
          await this.failWork(
            work,
            `Could not start the execution: ${error instanceof Error ? error.message : String(error)}`
          ).catch((returnError) => this.log.warn('Returning a failed start failed', returnError));
        throw error;
      })
      .finally(() => this.workPending.delete(id));
    this.workPending.set(id, operation);
    return operation;
  }

  private async startReservedWork(id: string): Promise<void> {
    let work = this.repo.getWork(id);
    if (!work || !['proposed', 'queued'].includes(work.status)) return;
    this.askRecords.reopenForWork(id);
    const driver = this.driverTargets.get(id);
    if (driver) return this.startDriverWork(work, driver);
    const target = this.resolveWorkTarget(id);
    if (!target.accepted) {
      await this.failUnavailableTarget(work, target.reason);
      return;
    }
    if (target.targetSessionId !== null) {
      if (work.status === 'proposed')
        work = this.repo.transitionWork(id, work, {
          status: 'queued',
          sessionId: target.targetSessionId,
        });
      if (!work || work.status !== 'queued' || work.sessionId !== target.targetSessionId) return;
      const current = this.resolveWorkTarget(id);
      if (!current.accepted || current.targetSessionId !== work.sessionId) {
        await this.failUnavailableTarget(
          work,
          current.accepted ? 'target_recipient_mismatch' : current.reason
        );
        return;
      }
      const brief = `${NEO_WORK_DELEGATED}\n${JSON.stringify({ workId: work.id, title: work.title, instruction: withWorkGoal(work.instruction, this.workDoneGoal(work.id), this.cardEventsDelivered()) })}`;
      await this.deliver(work.sessionId, work.id, brief, work.originSessionId);
      return;
    }
    await this.failWork(
      work,
      'Neo did not choose where this work runs. Ask Neo again and say which project, Space or chat it belongs to.'
    );
  }

  private dependencyBlockers(id: string) {
    return this.dependencies.blockers(id, neoOutcomeEligibility(this.checkRegistry()));
  }

  private async holdUncertainHandoff(work: NeoWork, target: NeoDriverTarget): Promise<void> {
    this.driverTargets.recordStartInterrupted(work.id);
    if (work.status !== 'queued') return;
    await this.failWork(
      work,
      `${NEO_DRIVER_START_INTERRUPTED} ${target.verb === 'start' ? target.adapter : 'ref' in target ? target.ref.adapter : target.verb} confirmed it. It may still have started; check work.find before trying again.`
    );
  }

  private async recoverHandoff(work: NeoWork): Promise<boolean> {
    const target = this.driverTargets.get(work.id);
    if (!target || (target.verb !== 'start' && target.verb !== 'send')) return false;
    const verdict = await this.reconcileHandoff(work.id);
    if (verdict.state === 'uncertain') await this.holdUncertainHandoff(work, target);
    else if (verdict.state === 'not_started') await this.admitWork(work.id, true);
    return verdict.state !== 'idle' || work.status === 'queued';
  }

  private async prerequisiteParameters(
    workId: string,
    target: NeoDriverTarget
  ): Promise<
    { ok: true; value: Record<string, string[]> } | { ok: false; reason: string; retry: boolean }
  > {
    const pack = this.pack(this.askRecords.forWork(workId)?.pack ?? '');
    if (target.verb !== 'start' || !pack?.prepareExecution) return { ok: true, value: {} };
    const items = this.dependencies
      .edges()
      .filter((edge) => edge.workId === workId)
      .flatMap((edge) =>
        (this.askRecords.forWork(edge.prerequisiteId)?.doneItems ?? []).filter(
          (item) => item.deliveredBy === edge.prerequisiteId
        )
      );
    return items.length && pack.prerequisiteParameters
      ? pack.prerequisiteParameters(items)
      : { ok: true, value: {} };
  }

  reconcileHandoff(id: string) {
    return reconcileNeoHandoff(id, {
      bootedAt: this.bootedAt,
      readWork: (workId: string) => this.repo.getWork(workId),
      readCard: (workId: string) => this.driverTargets.readCard(workId),
      readSent: (workId: string) => this.driverTargets.readSent(workId),
      readStatus: (work: NeoWork, ref: WorkRef, receipt: DriverSent['receipt']) =>
        this.invokeAsCard(work, 'work.status', { ref, ...(receipt ? { receipt } : {}) }),
    });
  }

  async admitWork(id: string, authorized: boolean, now = Date.now()) {
    const admitted = await admitNeoWork(id, authorized, now, {
      bootedAt: this.bootedAt,
      readWork: (workId: string) => this.repo.getWork(workId),
      readAsk: (workId: string) => this.askRecords.forWork(workId),
      readCard: (workId: string) => this.driverTargets.readCard(workId),
      readBlockers: (workId: string) => this.dependencyBlockers(workId),
      claim: (workId: string, admitted: () => boolean) =>
        this.driverTargets.claimAdmission(workId, now, admitted, this.bootedAt),
      handOff: (work: NeoWork) => this.startPending(work.id),
      release: (workId: string) => this.driverTargets.releaseAdmission(workId),
      markUncertain: (workId: string) => this.driverTargets.recordStartInterrupted(workId),
    });
    if (authorized && !admitted.ok && admitted.reason === 'prerequisites_unmet')
      this.dependencies.recordStartIntent(id, now);
    return admitted;
  }

  private waitingCardIds(): ReadonlySet<string> {
    return new Set(this.waitingCards().keys());
  }

  private workerHeldElsewhere(work: NeoWork, ref: WorkRef): boolean {
    return this.driverTargets
      .occupiedWorkers(this.repo, work.id, this.waitingCardIds())
      .has(neoWorkerRefKey(ref));
  }

  private waitingCards() {
    return this.dependencies.waiting(neoOutcomeEligibility(this.checkRegistry()));
  }

  cardWaits(workIds: readonly string[], now = Date.now()): NeoCardWait[] {
    const waiting = this.waitingCards();
    const auto = this.db.getGlobalSettings?.().neo?.autoDispatch === true;
    return workIds.flatMap((id) => {
      const blockers = waiting.get(id) ?? [];
      const status = this.repo.getWork(id)?.status;
      const uncertain =
        ['proposed', 'queued', 'failed'].includes(status ?? '') &&
        this.driverTargets.readStartInterrupted(id);
      if (!blockers.length && !uncertain) return [];
      const authorized =
        this.dependencies.hasStartIntent(id) ||
        isNeoAdmissionApproved(this.askRecords.forWork(id), now);
      return [
        {
          workId: id,
          waitingFor: blockers.map((blocker) => {
            const items = this.askRecords.forWork(blocker.workId)?.doneItems ?? [];
            return {
              workId: blocker.workId,
              title: this.repo.getWork(blocker.workId)?.title ?? blocker.workId,
              reason: blocker.reason,
              items: blocker.itemIds.map((itemId) => ({
                id: itemId,
                text: items.find((item) => item.id === itemId)?.text ?? itemId,
              })),
            };
          }),
          autoStart: auto && blockers.length > 0 && authorized,
          uncertain,
        },
      ];
    });
  }

  editDependencies(workId: string, dependsOn: readonly string[], now = Date.now()) {
    const work = this.repo.getWork(workId);
    if (work && awaitingNeoWorker(work))
      return { ok: false, reason: 'dependency_already_dispatched' };
    const expectedRevision = this.askRecords.forWork(workId)?.revision ?? 0;
    const edited = this.dependencies.replace(
      { workId, dependsOn, expectedRevision },
      new Set(this.repo.listWork().map((work) => work.id)),
      now
    );
    if (edited.ok && edited.revision !== expectedRevision)
      this.dependencies.clearStartIntent(workId);
    return edited;
  }

  async continueWork(
    id: string,
    message: string,
    now = Date.now(),
    caller: NeoContinueCaller = { guarded: false, human: false }
  ): Promise<NeoContinueResult> {
    const admitted = admitNeoWorkContinue(this.continueDeps, id, now, caller);
    if ('ok' in admitted) return admitted;
    this.continuing.add(id);
    try {
      return await sendNeoWorkContinue(this.continueDeps, admitted, message, now);
    } finally {
      this.continuing.delete(id);
    }
  }

  private readonly continueDeps: NeoContinueDeps = {
    readWork: (id) => this.repo.getWork(id),
    readRef: (id) => this.driverTargets.readRef(id),
    readTurn: (work, caller) => {
      const ask = this.askRecords.forWork(work.id);
      return {
        guarded: caller.guarded,
        human:
          caller.human ||
          isNeoHumanInputSince(
            new NeoRoutingLogRepository(this.db.getDatabase()).lastAskedAt(work.originSessionId),
            this.workContinues.get(work.id)?.continuedAt ?? work.createdAt
          ),
        doneWhenMet: isNeoCardDoneWhenMet(work, ask),
        prs: this.workPrs.get(work.id)?.prs ?? [],
        wake: this.workWakes.get(work.id),
      };
    },
    readProgress: (work) => this.workProgress(work),
    readAsk: (id) => this.askRecords.forWork(id),
    isContinuing: (id) => this.continuing.has(id),
    withGoal: (id, message) =>
      withWorkGoal(message, this.workDoneGoal(id), this.cardEventsDelivered()),
    readSendBaseline: ({ ref, work }, message) => this.readSendBaseline(ref, work, message),
    send: ({ ref, work }, message) => this.invokeAsCard(work, 'work.send', { ref, message }),
    recordSent: (id, startedAt, sent) => {
      this.driverTargets.recordStartedAt(id, startedAt);
      this.driverTargets.recordSent(id, sent);
    },
    recordContinue: (id, message, now, progress) =>
      this.workContinues.record(id, message, now, progress)?.count ?? null,
    recordWakeContinue: (work, human) =>
      this.workWakes.recordContinue(work.id, this.cardWakeProgress(work), human),
    reserveAskContinue: (ask) => this.askRecords.reserveApprovedContinue(ask.id),
    refundAskContinue: (ask) => this.askRecords.refundApprovedContinue(ask.id),
    reopen: (id, current, report) =>
      this.repo.transitionWork(id, current, { status: 'queued', report }),
    reopenAsk: (id) => this.askRecords.reopenForWork(id),
  };

  private async readSendBaseline(
    ref: WorkRef,
    work: NeoWork,
    message: string
  ): Promise<{ baseline: number | null; sent: DriverSent | null }> {
    const sentAt = Date.now();
    const outcome = await this.invokeAsCard(work, 'work.status', { ref });
    return {
      baseline: readDriverSendBaseline(outcome, sentAt, !!ref.daemon),
      sent: readDriverSent(outcome, message, work.createdAt),
    };
  }

  close(
    id: string,
    outcome: NeoWorkCloseOutcome,
    note: string | null = null
  ): Promise<NeoWorkCloseResult> {
    return closeNeoWork(
      {
        repo: this.repo,
        readDriverRef: (workId: string) => this.driverTargets.readRef(workId),
        stopDriver: (ref: WorkRef, work: NeoWork) =>
          this.driverTargets.get(work.id)?.verb === 'adopt'
            ? Promise.resolve()
            : this.stopDriverWork(ref, work),
      },
      id,
      outcome,
      note
    );
  }

  async cancel(id: string): Promise<void> {
    const work = this.repo.getWork(id);
    if (work?.status === 'proposed' || work?.status === 'queued') await this.close(id, 'cancelled');
  }

  private async startDriverWork(
    work: NeoWork,
    target: NeoDriverTarget,
    tried = new Set<string>()
  ): Promise<void> {
    if (target.verb === 'read') {
      const failure = await runNeoReadWork(
        this.repo,
        this.sessions.getOperationRegistry(),
        work,
        target,
        (reported) => this.returnReport(reported)
      );
      if (failure && !failure.ok) await this.failWork(work, failure.reason);
      return;
    }
    if (
      target.verb === 'send' &&
      ((awaitingNeoWorker(work) && work.report !== NEO_WORK_RESERVED_WORKER) ||
        (work.status === 'proposed' && this.workerHeldElsewhere(work, target.ref)))
    ) {
      await this.rerouteDriverWork(work, target.ref, tried);
      return;
    }
    if (work.status === 'queued') {
      if (this.driverTargets.readRef(work.id)) return;
      if (target.verb === 'adopt') return this.adoptDriverWork(work, target.ref);
      const verdict = await this.reconcileHandoff(work.id);
      if (verdict.state === 'uncertain') await this.holdUncertainHandoff(work, target);
      return;
    }
    const base = await this.prerequisiteParameters(work.id, target);
    if (!base.ok && base.retry && this.db.getGlobalSettings?.().neo?.autoDispatch === true) {
      this.log.warn(`Neo card ${work.id} waits for its prerequisite base: ${base.reason}`);
      scheduleNeoAdmissionWake(
        this.db.getJobQueueRepo(),
        work.id,
        Date.now() + NEO_PREREQUISITE_BASE_RETRY_MS
      );
      return;
    }
    if (!base.ok) {
      await this.failWork(work, `prerequisite_base: ${base.reason}`);
      return;
    }
    const queued = this.repo.transitionWork(work.id, work, { status: 'queued' });
    if (!queued || queued.status !== 'queued') return;
    if (target.verb === 'adopt') return this.adoptDriverWork(queued, target.ref);
    const call = driverWorkCall(
      target,
      queued,
      this.workDoneGoal(queued.id),
      this.cardEventsDelivered()
    );
    const packId = this.askRecords.forWork(queued.id)?.pack;
    const pack = this.pack(packId ?? '');
    if (target.verb === 'start' && packId && !pack) {
      await this.failWork(queued, `unsupported_preparation: pack ${packId} is not installed.`);
      return;
    }
    if (target.verb === 'start' && pack?.prepareExecution)
      call.input.preparation = {
        pack: pack.id,
        parameters: { ...(target.preparationParameters ?? {}), ...base.value },
      };
    const probe =
      target.verb === 'send'
        ? await this.readSendBaseline(target.ref, queued, String(call.input.message))
        : null;
    const baseline = probe ? probe.baseline : Date.now();
    const outcome = await this.invokeAsCard(queued, call.name, call.input);
    const result = readDriverOutcome(target, outcome);
    if ('ref' in result) {
      this.driverTargets.recordRef(
        queued.id,
        result.ref,
        result.startedAt ?? ('queued' in result ? undefined : (baseline ?? undefined)),
        result.link,
        { model: result.model, effort: result.effort }
      );
      const opening = messageOpening(String(call.input.message));
      this.driverTargets.recordSent(
        queued.id,
        probe
          ? probe.sent && { ...probe.sent, receipt: result.receipt }
          : opening
            ? { inputBefore: 0, opening, ...(result.receipt ? { receipt: result.receipt } : {}) }
            : null
      );
      const current = this.repo.getWork(queued.id);
      if (current?.status !== 'queued') {
        await this.stopDriverWork(result.ref, queued);
        return;
      }
      this.repo.transitionWork(queued.id, current, {
        status: 'queued',
        report: driverStartedReport(result.ref, result.link, result.model),
      });
      return;
    }
    if (target.verb === 'send' && result.reason === 'not_open') {
      await this.rerouteDriverWork(queued, target.ref, tried, true);
      return;
    }
    await this.failWork(queued, `Could not start the execution: ${result.failure}`);
  }

  private async rerouteDriverWork(
    work: NeoWork,
    ref: WorkRef,
    tried: Set<string>,
    closed = false
  ): Promise<void> {
    if (closed) tried.add(neoWorkerRefKey(ref));
    await rerouteNeoDriverWork(work, ref, tried, {
      pause: (current) =>
        this.repo.transitionWork(current.id, current, {
          status: 'proposed',
          report: NEO_WORK_AWAITING_WORKER,
        }),
      find: (input) => this.invokeAsCard(work, 'work.find', input),
      reserve: (current, candidates) =>
        this.driverTargets.reassign(this.repo, current, candidates, this.waitingCardIds()),
      start: (next, target) => this.startDriverWork(next, target, tried),
      returnToNeo: async (next, place) => {
        await this.deliver(
          next.originSessionId,
          `neo-work-reroute:${next.id}:${this.driverTargets.readRetries(next.id)}`,
          `The card's target is archived, ended or taken by another card; its instruction was not delivered. The card is still approved and has not failed. Arrange an open idle worker in the same project, then call neo.work.retry with this workId; it will select an open worker and send the original instruction. Do not ask the human to approve again or duplicate the card.\n${JSON.stringify({ workId: next.id, title: next.title, ref, place })}`,
          next.originSessionId,
          neoWorkParent(next)
        );
      },
    });
  }

  private async adoptDriverWork(work: NeoWork, ref: WorkRef): Promise<void> {
    const outcome = await this.invokeAsCard(work, 'work.status', { ref });
    const live = readDriverLive(outcome);
    if (!live) {
      await this.failWork(work, `Could not track the session: ${ref.adapter} did not find it.`);
      return;
    }
    this.driverTargets.recordRef(work.id, ref, Date.now(), live.link);
    this.driverTargets.recordSent(work.id, readDriverAdoptedSent(outcome));
    this.driverTargets.recordLive(work.id, live.status, live.link, live.remoteLink);
    const current = this.repo.getWork(work.id);
    if (current?.status === 'queued')
      this.repo.transitionWork(work.id, current, {
        status: 'queued',
        report: driverAdoptedReport(ref, live.status, live.link),
      });
  }

  retryCard(workId: string): NeoWorkRetryCard {
    const driver = this.driverTargets.readCard(workId);
    return {
      target: !!driver?.target,
      ref: !!driver?.ref,
      interrupted: !!driver?.startInterrupted,
    };
  }

  isRetryable(workId: string): boolean {
    const work = this.repo.getWork(workId);
    return (
      !!work &&
      'value' in requireNeoWorkRetryable(work, this.retryCard(workId), true) &&
      !isNeoDeliveryRetryPending(this.db.getJobQueueRepo(), workId)
    );
  }

  private deferToDeliveryRetry(work: NeoWork): boolean {
    const plan = planNeoDeliveryRetry({
      retryable: 'value' in requireNeoWorkRetryable(work, this.retryCard(work.id), true),
      ask: this.askRecords.forWork(work.id),
      retries: this.driverTargets.readRetries(work.id),
      now: Date.now(),
    });
    if ('reason' in plan) return false;
    scheduleNeoDeliveryRetry(this.db.getJobQueueRepo(), work.id, Date.now() + plan.value);
    return true;
  }

  async retryWork(
    work: NeoWork
  ): Promise<{ ok: true; work: NeoWork } | { ok: false; reason: string }> {
    const id = work.id;
    if (this.dependencyBlockers(id).some((blocker) => blocker.workId !== id))
      return { ok: false, reason: 'prerequisites_unmet' };
    const proposed = this.repo.transitionWork(id, work, {
      status: 'proposed',
      report: awaitingNeoWorker(work) ? work.report : null,
    });
    if (!proposed) return { ok: false, reason: 'This work changed meanwhile; read it again.' };
    await this.workPending.get(id)?.catch(() => undefined);
    this.driverTargets.recordRetry(id);
    const refused = neoAdmissionRefusal(await this.admitWork(id, true));
    if (!refused) return { ok: true, work: this.repo.getWork(id)! };
    const current = this.repo.getWork(id);
    if (current?.status === 'proposed' && !this.driverTargets.readRef(id))
      this.repo.transitionWork(id, current, { status: work.status, report: work.report });
    return { ok: false, reason: refused.reason };
  }

  private async stopDriverWork(ref: WorkRef, work: NeoWork): Promise<void> {
    await this.invokeAsCard(work, 'work.stop', { ref }).catch(() => undefined);
  }

  private async failUnavailableTarget(work: NeoWork, reason: string): Promise<void> {
    if (work.status !== 'queued') return;
    await this.failWork(work, `The chosen execution chat is no longer available: ${reason}.`);
  }

  private async failErroredTurn(work: NeoWork): Promise<void> {
    if (!work.sessionId) return;
    const failure = this.db.getSDKMessageRepo().getTurnErrorResultSubtype(work.sessionId, work.id);
    if (!failure) return;
    await this.failWork(work, `The chat stopped with an error before reporting: ${failure}.`);
  }

  private async failWork(work: NeoWork, report: string): Promise<void> {
    const failed = this.repo.transitionWork(work.id, work, {
      status: 'failed',
      report: report.slice(0, NEO_WORK_REPORT_LIMIT),
    });
    if (failed) await this.returnReport(failed);
  }

  async recover(): Promise<void> {
    this.sessionWatcher.loadSessionNoticeGroups();
    this.resumeDirectReplies();
    this.seedTriggers();
    await this.recoverConsultations();
    await this.clearStaleNeedsYou().catch((error) =>
      this.log.warn('Stale needs_you check pending', error)
    );
    for (const work of this.repo.listWork()) {
      try {
        const recovered = await this.recoverHandoff(work);
        if (!recovered && work.status === 'queued') await this.start(work.id);
        else if (
          !recovered &&
          (awaitingNeoWorker(work) ||
            (work.status === 'proposed' && this.driverTargets.get(work.id)?.verb === 'read'))
        )
          await this.admitWork(work.id, true);
        await this.reconcile(work.id);
      } catch (error) {
        this.log.warn('Neo recovery pending', error);
      }
    }
    for (const workId of new Set(this.dependencies.edges().map((edge) => edge.workId)))
      scheduleNeoAdmissionWake(this.db.getJobQueueRepo(), workId);
    await this.reclaimCardPrs();
  }

  private async attachOpenedPrs(workId: string): Promise<void> {
    const work = this.repo.getWork(workId);
    const stored = this.workPrs.get(workId);
    const opened = this.cardOpenedPrs.get(workId) ?? [];
    const tried = neoCardOpenedPrs(opened).join(' ');
    if (
      !work ||
      !this.packs().some((pack) => pack.id === CODING_PACK_BRIEF.id) ||
      this.openedPrsTried.get(workId) === tried ||
      !hasNeoUnattachedOpenedPrs(opened, stored?.prs ?? [])
    )
      return;
    const read = await readNeoCardPrs(this.cardPrDeps, work, stored, Date.now());
    if (read.ok) this.openedPrsTried.set(workId, tried);
  }

  private async reclaimCardPrs(): Promise<void> {
    if (!this.packs().some((pack) => pack.id === CODING_PACK_BRIEF.id)) return;
    const works = this.workPrClaims
      .cardsToReclaim()
      .flatMap((id) => this.repo.getWork(id) ?? [])
      .sort((a, b) => a.createdAt - b.createdAt);
    for (const work of works) {
      if (this.disposed) return;
      await readNeoCardPrs(
        this.cardPrDeps,
        work,
        this.workPrs.get(work.id),
        Date.now(),
        true
      ).catch((error) => this.log.warn('Card pull request reclaim pending', error));
    }
  }

  async refreshDriverWork(): Promise<void> {
    for (const refusal of this.workRefusals.list()) {
      const work = this.repo.getWork(refusal.workId);
      if (!work) continue;
      await reconcileNeoWorkRefusal(refusal, {
        read: () => this.invokeAsCard(work, 'work.status', { ref: refusal.ref, since: refusal.at }),
        clear: () => {
          if (this.workRefusals.clear(refusal)) this.notifyChanged();
        },
      }).catch((error) => this.log.warn('Card refusal refresh pending', error));
    }
    const cards = this.driverTargets
      .cardRefs(Date.now() - NEO_WORK_FOLLOW_MAX_AGE_MS)
      .flatMap((card) => {
        const work = this.repo.getWork(card.workId);
        return work ? [{ work, ref: card.ref }] : [];
      });
    for (const { work, ref } of cards) {
      if (work.status !== 'queued') continue;
      await this.settleDriverWork(work, ref).catch((error) =>
        this.log.warn('Driver work refresh pending', error)
      );
      await this.attachOpenedPrs(work.id).catch((error) =>
        this.log.warn('Card opened pull request read pending', error)
      );
    }
    for (const { work } of cards) {
      if (work.status !== 'reported') continue;
      await this.followWork(work, Date.now()).catch((error) =>
        this.log.warn('Reported work follow-up pending', error)
      );
    }
    try {
      this.endUnfollowedCardTopics(Date.now());
    } catch (error) {
      this.log.warn('Card event subscription sweep pending', error);
    }
    for (const workId of this.packEvidenceWorkIds()) {
      await this.refreshWorkPrs(workId, Date.now()).catch((error) =>
        this.log.warn('Work pull request refresh pending', error)
      );
      await this.relayCardPr(workId).catch((error) =>
        this.log.warn('Card pull request relay pending', error)
      );
    }
    this.forgetUnfollowedAskTopics();
    for (const ask of this.askRecords.listLive()) {
      this.followAskTopics(ask);
      try {
        this.runAskPackTicks(ask.id);
      } catch (error) {
        this.log.warn('Neo ask ticks pending', error);
      }
      await this.runAskReadTicks(this.askRecords.get(ask.id) ?? ask).catch((error) =>
        this.log.warn('Neo ask read ticks pending', error)
      );
      await this.checkAskEvidence(ask, Date.now()).catch((error) =>
        this.log.warn('Ask evidence check pending', error)
      );
    }
    for (const ask of this.askRecords.listLive()) {
      await this.noteAskStall(ask, Date.now()).catch((error) =>
        this.log.warn('Ask stall note pending', error)
      );
    }
    const idleAsks = this.askRecords.listLive();
    this.askIdleSeen = trackNeoAskIdle(
      this.askIdleSeen,
      idleAsks,
      new Map(idleAsks.map((ask) => [ask.id, neoAskIdleSignature(ask, this.askIdleCards(ask))])),
      Date.now()
    );
    for (const ask of idleAsks) {
      await this.noteAskIdle(ask, Date.now()).catch((error) =>
        this.log.warn('Ask idle note pending', error)
      );
    }
    this.pruneReadThrottles(Date.now());
    if (this.watching || this.disposed) return;
    this.watching = this.sessionWatcher
      .watchSessions(Date.now())
      .catch((error) => this.log.warn('Session watch pending', error))
      .finally(() => {
        this.watching = null;
      });
    await this.watching;
  }

  private askPackReadsReport(ask: NeoAsk | null): boolean {
    return (
      !!ask?.pack && this.packs().some((pack) => pack.id === ask.pack && !!pack.reportEvidence)
    );
  }

  private evidencePacks(ask: NeoAsk | null, hasRow: boolean): NeoPack[] {
    const packs = this.packs();
    const named = ask?.pack ? packs.find((pack) => pack.id === ask.pack) : null;
    if (!named?.readEvidence) return packs;
    return hasRow ? packs.filter((pack) => pack.readEvidence || pack === named) : [named];
  }

  private packEvidenceWorkIds(): string[] {
    const ids = new Set(this.workPrs.listOpen());
    for (const ask of this.askRecords.listLive()) {
      if (this.askPackReadsReport(ask)) ask.workIds.forEach((id) => ids.add(id));
    }
    return [...ids];
  }

  private followCard(
    work: NeoWork,
    readAt: number | null
  ): NeoWorkFollowCard & { since: number; sent: DriverSent | null } {
    const driver = this.driverTargets.readCard(work.id);
    return {
      ref: driver?.ref ?? null,
      goal: !!this.workDoneGoal(work.id)?.doneWhen,
      ask: this.askRecords.forWork(work.id),
      readAt,
      since: driver?.followAnchor ?? work.updatedAt,
      sent: this.driverTargets.readSent(work.id),
      superseded: this.driverTargets.readSupersededAt(work.id) !== null,
      live: driver?.liveStatus ?? null,
    };
  }

  async trackSession(root: string, notice: NeoSessionNotice, now: number): Promise<{ ok: true }> {
    this.trackedSessions = keepNeoTrackedSessions(this.trackedSessions, notice.key, now);
    const content = fillPrompt(NEO_SESSION_TRACK, {
      title: JSON.stringify(notice.title),
      ref: JSON.stringify(notice.ref),
    });
    await this.deliver(root, `neo-track:${notice.key}:${now}`, content, root);
    return { ok: true };
  }

  followedCardRefs(now: number): WorkRef[] {
    return this.driverTargets.cardRefs(now - NEO_WORK_FOLLOW_MAX_AGE_MS).flatMap((card) => {
      const work = this.repo.getWork(card.workId);
      if (!work) return [];
      if (work.status !== 'reported') return [card.ref];
      const following = requireNeoWorkFollow(work, this.followCard(work, null), now);
      return 'value' in following ? [card.ref] : [];
    });
  }

  private readonly relayCardPr = (superpipe({})('neo-card-pr-relay') as PipelineAPI)
    .input(['workId'])
    .pipe((workId: string) => this.repo.getWork(workId), 'workId', 'work')
    .pipe((workId: string) => this.workPrs.get(workId)?.prs ?? [], 'workId', 'prs')
    .pipe(neoCardPrAttention, 'prs', 'attention')
    .pipe(
      (workId: string, prs: NeoWorkPr[], attention: unknown) => {
        if (!attention && !neoCardPrPending(prs)) this.cardPrRelays.clear(workId);
        return attention ? this.cardPrRelays.get(workId) : null;
      },
      ['workId', 'prs', 'attention'],
      'told'
    )
    .pipe(requireNeoCardPrRelay, ['work', 'attention', 'told'], 'result:relay')
    .pipe(
      async (
        work: NeoWork,
        attention: { items: string },
        relay: { signature: string; message: string }
      ) => {
        const sent = await this.continueWork(work.id, relay.message);
        if (sent.ok) {
          this.cardPrRelays.markTold(work.id, relay.signature, Date.now());
          return sent;
        }
        const note = neoCardPrNeoNote(work, attention.items, sent.reason);
        if (!note || !this.db.getSession(work.originSessionId)) return sent;
        await this.wakeCards(
          [work.id],
          work.originSessionId,
          `neo-card-pr:${work.id}:${hashString32(relay.signature).toString(36)}`,
          note,
          neoWorkParent(work)
        );
        this.cardPrRelays.markTold(work.id, relay.signature, Date.now());
        return sent;
      },
      ['work', 'attention', 'relay'],
      'relay'
    )
    .endAsync('relay') as (workId: string) => Promise<unknown>;

  private readonly noteAskStall = (superpipe({})('neo-ask-stall-note') as PipelineAPI)
    .input(['ask', 'now'])
    .pipe(
      (ask: NeoAsk) => ({
        cards: ask.workIds.flatMap((id) => this.repo.getWork(id) ?? []),
        session: !!this.db.getSession(ask.originSessionId),
        newer:
          this.workSupersessions
            .list(ask.workIds)
            .flatMap((row) => this.askRecords.forWork(row.supersededBy) ?? [])
            .find((other) => other.id !== ask.id)?.id ?? null,
      }),
      'ask',
      'read'
    )
    .pipe(requireNeoAskStalled, ['ask', 'read', 'now'], 'result:stall')
    .pipe(
      (ask: NeoAsk, signature: string) => ({ id: neoAskEvidenceMessageId(ask.id, signature) }),
      ['ask', 'stall'],
      'note'
    )
    .pipe(
      (ask: NeoAsk, note: { id: string }) =>
        requireNeoAskStallUntold(this.hasDelivery(ask.originSessionId, note.id)),
      ['ask', 'note'],
      'result:stall'
    )
    .pipe(
      async (
        ask: NeoAsk,
        read: { cards: NeoWork[]; newer: string | null },
        note: { id: string }
      ) => {
        await this.deliverToOrigin(
          ask.originSessionId,
          note.id,
          neoAskStalledNote(ask, read.cards, read.newer),
          neoAskParent(ask)
        );
      },
      ['ask', 'read', 'note']
    )
    .endAsync('stall') as (ask: NeoAsk, now: number) => Promise<unknown>;

  private askIdleCards(ask: NeoAsk) {
    return ask.workIds.flatMap((id) => {
      const work = this.repo.getWork(id);
      return work
        ? [
            {
              id: work.id,
              title: work.title,
              status: work.status,
              progress: `${this.workProgress(work)}:${this.workContinues.get(work.id)?.count ?? 0}`,
              awaited: isNeoCardAwaitingPr(this.workPrs.get(work.id)?.prs ?? []),
            },
          ]
        : [];
    });
  }

  private readonly noteAskIdle = (superpipe({})('neo-ask-idle-note') as PipelineAPI)
    .input(['ask', 'now'])
    .pipe(
      (ask: NeoAsk, now: number) => {
        const cards = this.askIdleCards(ask);
        const seen = this.askIdleSeen.get(ask.id);
        return {
          cards,
          session: !!this.db.getSession(ask.originSessionId),
          since: seen?.since ?? now,
          signature: seen?.signature ?? neoAskIdleSignature(ask, cards),
        };
      },
      ['ask', 'now'],
      'read'
    )
    .pipe(requireNeoAskIdle, ['ask', 'read', 'now'], 'result:idle')
    .pipe(
      (ask: NeoAsk, signature: string) => ({ id: neoAskEvidenceMessageId(ask.id, signature) }),
      ['ask', 'idle'],
      'note'
    )
    .pipe(
      (ask: NeoAsk, note: { id: string }) =>
        requireNeoAskStallUntold(this.hasDelivery(ask.originSessionId, note.id)),
      ['ask', 'note'],
      'result:idle'
    )
    .pipe(
      async (
        ask: NeoAsk,
        read: { cards: ReturnType<NeoService['askIdleCards']> },
        note: { id: string }
      ) => {
        await this.wakeCards(
          read.cards.map((card) => card.id),
          ask.originSessionId,
          note.id,
          neoAskIdleNote(ask, read.cards),
          neoAskParent(ask)
        );
      },
      ['ask', 'read', 'note']
    )
    .endAsync('idle') as (ask: NeoAsk, now: number) => Promise<unknown>;

  private readonly checkAskEvidence = (superpipe({})('neo-ask-evidence-check') as PipelineAPI)
    .input(['ask', 'now'])
    .pipe(
      (ask: NeoAsk, now: number) =>
        requireNeoAskEvidenceDue(
          ask,
          {
            readAt: this.askEvidenceReads.get(ask.id),
            session: !!this.db.getSession(ask.originSessionId),
          },
          now
        ),
      ['ask', 'now'],
      'result:check'
    )
    .pipe(
      (check: NeoAsk, now: number) => {
        this.askEvidenceReads.set(check.id, now);
      },
      ['check', 'now']
    )
    .pipe(
      async (check: NeoAsk) => ({
        evidence: await readNeoAskPackEvidence(this.packs(), check, (id, error) =>
          this.log.warn(`Neo pack ${id} ask evidence read failed`, error)
        ),
        told: this.askChecks.get(check.id),
      }),
      'check',
      'read'
    )
    .pipe(
      (read: { evidence: NeoEvidence[]; told: NeoAskCheckRow | null }) =>
        planNeoAskEvidenceNote(read.evidence, read.told),
      'read',
      'result:note'
    )
    .pipe(
      async (check: NeoAsk, note: { signature: string; evidence: NeoEvidence[] }) => {
        await this.deliverToOrigin(
          check.originSessionId,
          neoAskEvidenceMessageId(check.id, note.signature),
          neoAskEvidenceNote(check, note.evidence),
          neoAskParent(check)
        );
        this.askChecks.markTold(check.id, note.signature, Date.now());
      },
      ['check', 'note']
    )
    .endAsync('note') as (ask: NeoAsk, now: number) => Promise<unknown>;

  private readonly refreshWorkPrs = (superpipe({})('neo-work-pr-refresh') as PipelineAPI)
    .input(['workId', 'now'])
    .pipe((workId: string) => ({ work: this.repo.getWork(workId) }), 'workId', 'current')
    .pipe(requireNeoWorkPrCurrent, 'current', 'result:refresh')
    .pipe(
      (refresh: { work: NeoWork }) => {
        const ask = this.askRecords.forWork(refresh.work.id);
        return {
          ask,
          goal: neoWorkDoneGoal(refresh.work.id, this.workGoals.get(refresh.work.id), ask),
          row: this.workPrs.get(refresh.work.id),
          session: !!this.db.getSession(refresh.work.originSessionId),
          packEvidence: this.askPackReadsReport(ask),
          toldAt: this.workChecks.get(refresh.work.id)?.toldAt ?? null,
          doneWhenMet: isNeoCardDoneWhenMet(refresh.work, ask),
        };
      },
      'refresh',
      'card'
    )
    .pipe(
      (refresh: { work: NeoWork }, card: NeoWorkPrCard, now: number) =>
        requireNeoEvidenceRefresh(
          refresh,
          { ...card, goal: !!card.goal },
          now,
          NEO_WORK_CLOSED_DONE_PREFIX
        ),
      ['refresh', 'card', 'now'],
      'result:refresh'
    )
    .pipe(
      async (refresh: { work: NeoWork }, card: NeoWorkPrCard) => {
        let failed = false;
        const read = await readNeoPackEvidence(
          this.evidencePacks(card.ask, !!card.row),
          refresh.work,
          (id, error) => {
            failed = true;
            this.log.warn(`Neo pack ${id} evidence read failed`, error);
          }
        );
        return { read, failed };
      },
      ['refresh', 'card'],
      'refreshed'
    )
    .pipe(
      (refresh: { work: NeoWork }) => ({ row: this.workChecks.get(refresh.work.id) }),
      'refresh',
      'told'
    )
    .pipe(
      (refreshed: NeoWorkPrRefreshed, now: number) => ({
        read: neoPackEvidenceOrNone(refreshed.read, refreshed.failed, now),
        stand: !refreshed.read && !refreshed.failed,
      }),
      ['refreshed', 'now'],
      'planned'
    )
    .pipe(
      (
        refresh: { work: NeoWork },
        card: NeoWorkPrCard,
        planned: { read: NeoEvidenceRead | null; stand: boolean },
        told: NeoWorkTold,
        now: number
      ) =>
        planned.stand && told.row
          ? 'unchanged'
          : planned.read && card.goal
            ? planNeoDoneCheck(planned.read.evidence, told.row, planned.read.read, now)
            : 'wait',
      ['refresh', 'card', 'planned', 'told', 'now'],
      'plan'
    )
    .pipe(
      (
        refresh: { work: NeoWork },
        plan: ReturnType<typeof planNeoDoneCheck>,
        card: NeoWorkPrCard
      ) => requireNeoWorkPrDelivery(refresh, plan, isNeoAskLive(card.ask)),
      ['refresh', 'plan', 'card'],
      'result:refresh'
    )
    .pipe(
      async (
        refresh: { work: NeoWork },
        card: NeoWorkPrCard,
        refreshed: NeoWorkPrRefreshed,
        planned: { read: NeoEvidenceRead | null }
      ) => {
        if (!card.goal) return;
        await this.deliverDoneCheck(refresh.work, card.goal, this.workPrs.get(refresh.work.id), {
          stale: refreshed.failed || refreshed.read?.read.ok === false,
          ask: card.ask,
          signature: planned.read ? neoEvidenceSignature(planned.read.evidence) : undefined,
        });
      },
      ['refresh', 'card', 'refreshed', 'planned']
    )
    .endAsync('refresh') as (
    workId: string,
    now: number
  ) => Promise<{ work: NeoWork } | NeoWorkPrRefreshSkip>;

  packs(): NeoPack[] {
    return neoPacks({
      builtins: this.builtinPacks,
      filePacks: this.filePacks,
      enabled: neoEnabledPacks(this.db.getGlobalSettings?.().neo),
    });
  }

  installedPacks(): NeoPack[] {
    const seen = new Set<string>();
    return [...this.builtinPacks, ...this.filePacks].filter((pack) => {
      if (seen.has(pack.id)) return false;
      seen.add(pack.id);
      return true;
    });
  }

  checkRegistry() {
    return buildNeoCheckRegistry(this.packs());
  }

  pack(id: string): NeoPack | null {
    return this.installedPacks().find((pack) => pack.id === id) ?? null;
  }

  deliverAskTicked(ask: NeoAsk, item: NeoAskItem): Promise<void> {
    return this.deliverToOrigin(
      ask.originSessionId,
      neoAskTickedMessageId(ask.id, item.id, Date.now()),
      neoAskTickedNote(ask, item),
      neoAskParent(ask)
    );
  }

  deliverAskAnswer(ask: NeoAsk, item: NeoAskItem, choice: string, met = true): Promise<void> {
    return this.deliverToOrigin(
      ask.originSessionId,
      neoAskAnswerMessageId(ask.id, item.id, Date.now()),
      neoAskAnswerNote(ask, item, choice, met),
      neoAskParent(ask)
    );
  }

  packBriefing(ask: NeoAsk): string | undefined {
    return ask.pack ? (this.pack(ask.pack)?.instructions(ask) ?? undefined) : undefined;
  }

  packBriefs(): NeoPackBrief[] {
    return neoPackBriefs(neoEnabledPacks(this.db.getGlobalSettings?.().neo), this.installedPacks());
  }

  askPackFragment(ask: NeoAsk | null | undefined): NeoPackFragment | null {
    const fragment = neoPackFragment(ask, this.installedPacks());
    return fragment
      ? {
          ...fragment,
          inPrompt: neoSettingsPackBriefs(this.db.getGlobalSettings?.().neo).some(
            (pack) => pack.id === fragment.id && !!pack.guidance
          ),
        }
      : null;
  }

  private get cardPrDeps(): NeoCardPrDeps {
    return {
      readPrs: (urls) => this.readPrs(urls),
      prCandidates: (work, stored) => this.cardPrCandidates(work, stored),
      claims: this.workPrClaims,
      workPrs: this.workPrs,
      record: (workId, prs, before, read) => this.recordWorkPrs(workId, prs, before, read),
    };
  }

  private recordWorkPrs(
    workId: string,
    prs: readonly NeoWorkPr[],
    before: NeoWorkPrRow | null,
    read = true
  ): NeoWorkPrRow | null {
    const row = read
      ? this.workPrs.record(workId, prs, Date.now())
      : this.workPrs.replacePrs(workId, prs);
    if (row && row.revision !== before?.revision) this.notifyChanged();
    if (row) this.followCardTopics(workId);
    return row;
  }

  followCardTopics(workId: string): void {
    const work = this.repo.getWork(workId);
    if (!work || !isNeoCardLive(work)) return;
    const topics = this.packs().flatMap((pack) => pack.externalTopics?.(work) ?? []);
    if (work.sessionId)
      for (const row of planNeoSessionTopicsHandedOver(
        this.sessionSubscriptions.listBySession(work.sessionId),
        topics
      ))
        this.sessionSubscriptions.delete(row.sessionId, row.topic);
    for (const topic of topics) {
      if (!this.cardEvents.subscribe(workId, topic, Date.now())) continue;
      void this.watchExternalTopic?.(topic).catch((error) =>
        this.log.warn('Card event source watch pending', error)
      );
    }
  }

  readonly endUnfollowedCardTopics = (superpipe({})('neo-card-topics-end') as PipelineAPI)
    .input(['now'])
    .pipe(() => this.cardEvents.listActive(), 'now', 'rows')
    .pipe(
      (rows: NeoCardEventSubscription[]) =>
        new Map(
          [...new Set(rows.map((row) => row.workId))].map(
            (workId) =>
              [
                workId,
                isNeoCardLive(this.repo.getWork(workId)) && this.cardEventsDelivered(),
              ] as const
          )
        ),
      'rows',
      'followed'
    )
    .pipe(planNeoCardTopicsEnded, ['rows', 'followed'], 'ended')
    .pipe(
      (ended: NeoCardEventSubscription[], now: number) => {
        for (const row of ended) this.cardEvents.end(row.workId, row.topic, now);
        return ended;
      },
      ['ended', 'now'],
      'done'
    )
    .end('done') as (now: number) => NeoCardEventSubscription[];

  cardEventsDelivered(): boolean {
    return this.packs().some((pack) => !!pack.externalTopics);
  }

  followedTopics(): string[] {
    return [
      ...this.cardEvents.listActive().map((row) => row.topic),
      ...neoPackAskTopics(this.packs(), this.askRecords.listLive()),
    ];
  }

  private forgetUnfollowedAskTopics(): void {
    const followed = new Set(neoPackAskTopics(this.packs(), this.askRecords.listLive()));
    for (const topic of this.watchedAskTopics)
      if (!followed.has(topic)) this.watchedAskTopics.delete(topic);
  }

  private followAskTopics(ask: NeoAsk): void {
    for (const topic of neoPackAskTopics(this.packs(), [ask])) {
      if (this.watchedAskTopics.has(topic)) continue;
      this.watchedAskTopics.add(topic);
      void this.watchExternalTopic?.(topic).catch((error) => {
        this.watchedAskTopics.delete(topic);
        this.log.warn('Ask event source watch pending', error);
      });
    }
  }

  private readonly runAskEventTicks = (superpipe({})('neo-ask-event-ticks') as PipelineAPI)
    .input(['payload'])
    .pipe(
      (payload: ExternalEventPublishedPayload) => {
        const event = this.sessionEvents.getById(payload.eventId)?.event;
        return event ? { value: event } : { reason: 'event_missing' };
      },
      'payload',
      'result:event'
    )
    .pipe(
      async (event: ExternalEvent) => {
        for (const ask of this.askRecords.listLive()) {
          const ticks = await readNeoAskEventTicks(this.packs(), ask, event, (id, error) =>
            this.log.warn(`Neo pack ${id} event ticks pending`, error)
          );
          if (ticks.length) this.writeAskTicks(ask, ticks);
        }
      },
      'event',
      'ticked'
    )
    .endAsync('ticked') as (payload: ExternalEventPublishedPayload) => Promise<unknown>;

  private readonly routeCardEvent = (superpipe({})('neo-card-event') as PipelineAPI)
    .input(['payload'])
    .pipe(
      (payload: ExternalEventPublishedPayload) => {
        const event = this.sessionEvents.getById(payload.eventId)?.event;
        return event ? { value: event } : { reason: 'event_missing' };
      },
      'payload',
      'result:event'
    )
    .pipe(
      (event: ExternalEvent) =>
        planNeoCardEventRoute(this.packs(), event, this.cardEvents.listActive()),
      'event',
      'result:route'
    )
    .pipe(
      async (event: ExternalEvent, route: NeoPackEventRoute) => {
        for (const workId of route.workIds)
          await this.sendToCard(
            workId,
            `neo-card-event:${workId}:${event.id}`,
            sessionEventText(event)
          ).catch((error) => this.log.warn('Card event not delivered', error));
      },
      ['event', 'route']
    )
    .pipe((route: NeoPackEventRoute) => {
      for (const row of route.ending) this.cardEvents.end(row.workId, row.topic, Date.now());
    }, 'route')
    .endAsync('route') as (payload: ExternalEventPublishedPayload) => Promise<unknown>;

  async sendToCard(workId: string, key: string, text: string): Promise<void> {
    const work = this.repo.getWork(workId);
    const send = planNeoCardSend({ work, ref: this.driverTargets.readRef(workId) });
    if (!work || send.via === 'none') return;
    if (send.via === 'session')
      return this.deliver(send.sessionId, key, text, work.originSessionId);
    await this.invokeAsCard(work, 'work.send', { ref: send.ref, message: text });
  }

  private async settleDriverWork(work: NeoWork, ref: WorkRef): Promise<void> {
    await settleNeoDriverWork(this.driverSettleDeps, work, ref);
  }

  private readonly driverSettleDeps: NeoDriverSettleDeps = {
    readStartedAt: (workId) => this.driverTargets.readStartedAt(workId),
    readSent: (workId) =>
      neoCardSent(this.driverTargets.readSent(workId), this.repo.getWork(workId)),
    readLiveStatus: (workId) => this.driverTargets.readLiveStatus(workId),
    isContinuing: (workId) =>
      !!this.workContinues.get(workId) ||
      ['send', 'adopt'].includes(this.driverTargets.get(workId)?.verb ?? ''),
    readStatus: async (work, ref, since, receipt) => {
      const outcome = await this.invokeAsCard(work, 'work.status', {
        ref,
        ...(since !== null ? { since } : {}),
        ...(receipt ? { receipt } : {}),
      });
      this.adoptStartReceipt(work.id, outcome);
      return outcome;
    },
    recordStartedAt: (workId, at) => this.driverTargets.recordStartedAt(workId, at),
    recordLive: (workId, status, live) =>
      this.driverTargets.recordLive(workId, status, live.link, live.remoteLink),
    recordCheck: (workId, read, now) => this.recordCardCheck(workId, read, now),
    notifyChanged: () => this.notifyChanged(),
    noteUnsettled: async (work, ref, outcome) => {
      await this.noteDriverStall(work, outcome);
      await this.noteDriverStuck(work);
      await this.noteDriverNeedsYou(work, ref, outcome);
    },
    forgetActivity: (workId) => this.activitySeen.delete(workId),
    transition: (work, settled) => {
      const moved = this.repo.transitionWork(work.id, work, {
        status: settled.status,
        report: settled.report.slice(0, NEO_WORK_REPORT_LIMIT),
      });
      if (moved) this.driverTargets.recordNeedsYouSince(work.id, null);
      return moved;
    },
    anchorFollow: (workId, at) => this.driverTargets.recordFollowAnchor(workId, at),
    returnReport: (work) => this.returnReport(work),
  };

  private workDoneGoal(workId: string): NeoWorkGoal | null {
    return neoWorkDoneGoal(workId, this.workGoals.get(workId), this.askRecords.forWork(workId));
  }

  private workProgress(work: NeoWork): string {
    return neoWorkProgress(
      work,
      this.workPrs.get(work.id)?.revision ?? null,
      this.workContinues.get(work.id)?.progress ?? null
    );
  }

  private stalledContinues(work: NeoWork): number {
    return neoStalledContinues(this.workContinues.get(work.id), this.workProgress(work));
  }

  private stalledWakes(workId: string): number {
    return neoCardStalledWakes(this.workWakes.get(workId), false);
  }

  private cardWakeProgress(work: NeoWork): string {
    return neoCardWakeProgress(this.workProgress(work), this.askRecords.forWork(work.id));
  }

  private recordCardWake(workId: string, note: string): void {
    const work = this.repo.getWork(workId);
    if (work && (work.status === 'queued' || work.status === 'reported'))
      this.workWakes.recordWake(work.id, note, this.cardWakeProgress(work), Date.now());
  }

  resetCardStalls(workIds: readonly string[]): void {
    for (const id of workIds) {
      const work = this.repo.getWork(id);
      if (work) this.workWakes.resetStall(id, this.cardWakeProgress(work));
    }
  }

  isContinueStalled(workId: string): boolean {
    const work = this.repo.getWork(workId);
    return (
      !!work &&
      (work.status === 'queued' || work.status === 'reported') &&
      this.stalledWakes(workId) >= NEO_WORK_STALLED_CONTINUES
    );
  }

  private continueBudget(work: NeoWork, now: number): string | null {
    return readNeoWorkContinueBudget(
      this.stalledWakes(work.id),
      work.createdAt,
      this.askRecords.forWork(work.id),
      now
    );
  }

  private async noteDriverStall(work: NeoWork, outcome: OperationOutcome): Promise<void> {
    const live = readDriverActivity(outcome);
    if (live?.status !== 'running') {
      this.activitySeen.delete(work.id);
      return;
    }
    const now = Date.now();
    const seen = this.activitySeen.get(work.id);
    if (seen?.at !== live.lastActivityAt) {
      this.activitySeen.set(work.id, { at: live.lastActivityAt, seenAt: now });
      return;
    }
    if (now - seen.seenAt < NEO_WORK_STALL_MS || !this.db.getSession(work.originSessionId)) return;
    const budget = this.continueBudget(work, now);
    await this.wakeCards(
      [work.id],
      work.originSessionId,
      neoStallMessageId(work.id, live.lastActivityAt),
      driverStallNote(work, this.workDoneGoal(work.id), live.lastReply, budget),
      neoWorkParent(work)
    );
  }

  private async noteDriverStuck(work: NeoWork): Promise<void> {
    const now = Date.now();
    const reminder = decideStuckReminder(work.updatedAt, now);
    if (!reminder || !this.db.getSession(work.originSessionId)) return;
    await this.wakeCards(
      [work.id],
      work.originSessionId,
      neoStallMessageId(work.id, reminder.due),
      driverStuckNote(
        work,
        this.workDoneGoal(work.id),
        work.updatedAt,
        now,
        reminder.abandoned,
        this.continueBudget(work, now)
      ),
      neoWorkParent(work)
    );
  }

  private readonly noteDriverNeedsYou = (superpipe({})('neo-work-needs-you') as PipelineAPI)
    .input(['work', 'ref', 'outcome'])
    .pipe(
      (work: NeoWork, outcome: OperationOutcome) => {
        const ask = this.askRecords.forWork(work.id);
        return {
          state: readDriverNeedsYou(outcome),
          noted: this.driverTargets.readNeedsYouSince(work.id),
          ask,
          siblingsWaiting: (ask?.workIds ?? []).some(
            (id) =>
              id !== work.id &&
              this.repo.getWork(id)?.status === 'queued' &&
              this.driverTargets.readNeedsYouSince(id) !== null
          ),
        };
      },
      ['work', 'outcome'],
      'card'
    )
    .pipe(
      (card: NeoNeedsYouCard, work: NeoWork) =>
        planNeoNeedsYou(card.state, card.noted, card.ask, card.siblingsWaiting, work.id),
      ['card', 'work'],
      'plan'
    )
    .pipe(
      async (work: NeoWork, ref: WorkRef, card: NeoNeedsYouCard, plan: NeoNeedsYouPlan) => {
        if (plan.notify !== null && this.db.getSession(work.originSessionId))
          await this.deliverToOrigin(
            work.originSessionId,
            neoNeedsYouMessageId(work.id, plan.notify),
            driverNeedsYouNote(work, ref, card.state?.lastReply),
            neoWorkParent(work)
          );
        if (plan.record !== undefined) this.driverTargets.recordNeedsYouSince(work.id, plan.record);
        if (!plan.resume) return;
        for (const id of plan.resume.items)
          this.askRecords.tickItem(
            plan.resume.ask.id,
            { id, state: 'pending', evidence: null, metBy: null },
            Date.now(),
            plan.resume.ask.doneItems?.find((item) => item.id === id)
          );
        if (plan.resume.reopen) this.askRecords.reopen(plan.resume.ask);
        if (plan.resume.items.length && this.db.getSession(plan.resume.ask.originSessionId))
          await this.deliverToOrigin(
            plan.resume.ask.originSessionId,
            `neo-ask-cleared:${plan.resume.ask.id}:${plan.resume.items.join(',')}:${Date.now()}`,
            neoNeedsYouClearedNote(
              plan.resume.ask,
              plan.resume.items.map((id) => ({
                id,
                why: neoResumeWhy(
                  plan.resume?.ask.doneItems?.find((item) => item.id === id),
                  work.id
                ),
              })),
              plan.resume.ask.doneItems ?? []
            ),
            neoAskParent(plan.resume.ask)
          );
      },
      ['work', 'ref', 'card', 'plan']
    )
    .endAsync('plan') as (
    work: NeoWork,
    ref: WorkRef,
    outcome: OperationOutcome
  ) => Promise<unknown>;

  async noteTurnLimit(sessionId: string): Promise<void> {
    const messages = this.db.getSDKMessageRepo();
    const plan = planNeoTurnLimitNote(messages.latestTurnResults(sessionId, 2), (since) =>
      messages.hasUserUuidPrefixSince(sessionId, NEO_TURN_LIMIT_PREFIX, since)
    );
    if (!plan) return;
    const interrupted = messages.firstUserUuidBetween(sessionId, plan.sinceAt, plan.untilAt);
    await this.deliverToOrigin(
      sessionId,
      `${NEO_TURN_LIMIT_PREFIX}${plan.resultUuid}`,
      neoTurnLimitNote(
        this.askRecords.openedBy(sessionId, plan.since, plan.until),
        this.repo.proposedBy(sessionId, plan.since, plan.until)
      ),
      interrupted ? { sessionId, messageId: interrupted } : null,
      'continues'
    );
  }

  readonly withdrawObsoletePrQuestions = (superpipe({})('neo-withdraw-pr-questions') as PipelineAPI)
    .input(['askId'])
    .pipe(
      (askId: string) => {
        const ask = this.askRecords.get(askId);
        return ask && isNeoAskLive(ask) ? { value: ask } : { reason: undefined };
      },
      'askId',
      'result:ask'
    )
    .pipe(
      async (ask: NeoAsk) => {
        const refs = this.prQuestionWithdrawalPolicy.refs(ask.doneItems ?? []);
        return refs.length ? this.readRefStates(refs) : [];
      },
      'ask',
      'states'
    )
    .pipe(
      async (askId: string, states: Awaited<ReturnType<NeoRefStateReader>>) => {
        const ask = this.askRecords.get(askId);
        if (!ask || !isNeoAskLive(ask)) return;
        const cleared = this.prQuestionWithdrawalPolicy
          .plan(ask.doneItems ?? [], states)
          .map((entry) => ({ id: entry.id, why: entry.evidence }));
        if (cleared.length) await this.wakeForClearedNeedsYou(ask, cleared, true);
      },
      ['askId', 'states'],
      'withdrawn'
    )
    .endAsync('withdrawn') as (askId: string) => Promise<void>;

  async clearStaleNeedsYou(): Promise<void> {
    for (const { id: askId } of this.askRecords.needingHuman()) {
      await this.withdrawObsoletePrQuestions(askId).catch((error) =>
        this.log.warn('Obsolete PR question reconciliation pending', error)
      );
      const ask = this.askRecords.get(askId);
      if (!ask || !isNeoAskLive(ask)) continue;
      const cards = new Map(
        ask.workIds.flatMap((id) => {
          const work = this.repo.getWork(id);
          return work
            ? [
                [
                  id,
                  {
                    status: work.status,
                    needsYou: this.driverTargets.readNeedsYouSince(id) != null,
                    stalled: this.isContinueStalled(id),
                    targetReady: this.resolveWorkTarget(id).accepted,
                  },
                ] as const,
              ]
            : [];
        })
      );
      const withdrawn = planNeoQuestionsWithdrawn(ask, cards);
      if (withdrawn.length)
        await this.wakeForClearedNeedsYou(ask, withdrawn, true).catch((error) =>
          this.log.warn('Obsolete question withdrawal pending', error)
        );
      const current = withdrawn.length ? this.askRecords.get(askId) : ask;
      if (!current || !isNeoAskLive(current)) continue;
      const cleared = planNeoNeedsYouCleared(current, cards, Date.now());
      if (cleared.length)
        await this.wakeForClearedNeedsYou(current, cleared).catch((error) =>
          this.log.warn('Stale needs_you note pending', error)
        );
    }
  }

  private async wakeForClearedNeedsYou(
    ask: NeoAsk,
    cleared: readonly { id: string; why: string }[],
    withdrawQuestions = false
  ): Promise<void> {
    const now = Date.now();
    for (const entry of cleared)
      this.askRecords.tickItem(
        ask.id,
        {
          id: entry.id,
          state: 'pending',
          evidence: withdrawQuestions ? entry.why : null,
          metBy: withdrawQuestions ? 'daemon' : null,
        },
        now,
        ask.doneItems?.find((item) => item.id === entry.id)
      );
    if (withdrawQuestions)
      for (const entry of cleared)
        if (ask.doneItems?.some((item) => item.id === entry.id && item.decision))
          this.askRecords.editItems(
            ask.id,
            { add: [], remove: [entry.id], removedReason: `No longer needed: ${entry.why}` },
            now
          );
    const ticked = this.askRecords.get(ask.id);
    if (ticked && neoAskReopensAfterClear(ticked)) this.askRecords.reopen(ticked);
    else if (ticked) writeNeoAskTickStatus(this.askRecords, ticked, planNeoAskTickStatus(ticked));
    if (!this.db.getSession(ask.originSessionId)) return;
    await this.deliverToOrigin(
      ask.originSessionId,
      `neo-ask-cleared:${ask.id}:${cleared.map((entry) => entry.id).join(',')}:${now}`,
      withdrawQuestions
        ? `The daemon withdrew questions on ask ${ask.id} whose reason is gone; the human sees them as no longer needed. Standalone questions were removed; original outcome items remain pending.\n${cleared.map((entry) => `${entry.id}: ${entry.why}`).join('\n')}`
        : neoNeedsYouClearedNote(ask, cleared, ask.doneItems ?? []),
      neoAskParent(ask)
    );
  }

  humanAskText(ask: NeoAskOrigin): string | null {
    const root = this.repo.getBindingForProject(null)?.sessionId;
    return root ? neoForwardedText(this.asks.find(root.slice(4), ask.messageId), ask) : null;
  }

  private readonly returnCrossProjectGroup = (
    superpipe({})('neo-cross-project-return') as PipelineAPI
  )
    .input(['group'])
    .pipe((group: NeoCrossProjectGroup) => this.crossProjects.members(group), 'group', 'members')
    .pipe(
      (group: NeoCrossProjectGroup, members: NeoCrossProjectMember[]) =>
        members.length === (JSON.parse(group.partsJson) as unknown[]).length &&
        members.every((member) => ['reported', 'failed', 'cancelled'].includes(member.status))
          ? { value: group }
          : { reason: null },
      ['group', 'members'],
      'result:return'
    )
    .pipe(
      (group: NeoCrossProjectGroup, members: NeoCrossProjectMember[]) =>
        this.deliver(
          group.rootSessionId,
          neoCrossProjectReplyId(group),
          `All assigned cross-project owners have returned. Publish one combined answer for this original human ask, covering every reported, failed or cancelled part honestly. Do not consult or dispatch the parts again.\n${JSON.stringify({ humanMessageId: group.askMessageId, parts: JSON.parse(group.partsJson), results: members })}`,
          group.rootSessionId,
          { sessionId: group.askSessionId, messageId: group.askMessageId },
          'continues'
        ),
      ['return', 'members']
    )
    .endAsync() as (group: NeoCrossProjectGroup) => Promise<unknown>;

  async recoverConsultations(): Promise<void> {
    for (const item of this.consultations.unsettled()) {
      await this.syncConsultation(item.id).catch((error) =>
        this.log.warn('Consultation recovery pending', error)
      );
    }
    for (const group of this.crossProjects.pending())
      await this.returnCrossProjectGroup(group).catch((error) =>
        this.log.warn('Cross-project return recovery pending', error)
      );
    for (const projectId of this.consultationWaiters.queuedProjects())
      await this.dispatchConsultationWaiter(projectId).catch((error) =>
        this.log.warn('Consultation admission pending', error)
      );
  }

  async dispatchConsultationWaiter(projectId: string): Promise<void> {
    await dispatchNeoConsultationWaiter(this, projectId);
  }

  private planConsultationReturn(item: NeoConsultation) {
    const association = this.consultations.getPublication(item.id);
    const captured = this.consultations.getPublicationInput(item.id);
    const publication = association
      ? this.publications.get(association.conversationId, association.publicationId)
      : this.publications.findByProducer(item.sessionId, `neo-consult:${item.id}:request`);
    return planNeoConsultationReturn(
      item,
      association,
      publication,
      captured?.askOrigin ?? null,
      captured
    );
  }

  async syncConsultation(id: string): Promise<void> {
    let item = this.consultations.expire(id);
    if (!item) return;
    const messages = this.db.getSDKMessageRepo();
    const requestId = `neo-consult:${id}:request`;
    if (item.status === 'pending') {
      const failure = messages.getErrorTerminalResultSubtypeAfter(item.sessionId, requestId);
      if (failure || messages.hasTerminalResultAfter(item.sessionId, requestId)) {
        item = this.consultations.finish(
          id,
          failure || !neoReviewWorkId(id) ? 'failed' : 'reported',
          failure
            ? `The context holder stopped: ${failure}.`
            : neoReviewWorkId(id)
              ? NEO_WORK_REVIEWED
              : 'The context holder ended without returning an answer.'
        );
      } else {
        await this.open(item.projectId);
        const content = neoConsultationRequestContent(
          item,
          !!this.crossProjects.forReceipt(item.id),
          this.crossProjects.forReceipt(item.id)?.askMessageId,
          item.originMessageId !== null &&
            this.parentTrigger(this.consultationParent(item)) !== null
        );
        await this.deliver(
          item.sessionId,
          requestId,
          content,
          item.originSessionId,
          this.consultationParent(item),
          neoConsultationDelivery(item)
        );
        return;
      }
    }
    if (!item) return;
    const group = this.crossProjects.forReceipt(id);
    if (group) {
      await this.returnCrossProjectGroup(group);
      this.consultations.returned(id);
      await this.dispatchConsultationWaiter(item.projectId);
      return;
    }
    const route = this.consultations.isReturned(id)
      ? 'returned'
      : this.planConsultationReturn(item);
    if (route === 'inconsistent')
      throw new Error('Consultation publication return is inconsistent');
    if (route === 'pending') return;
    if (route === 'legacy' && !(item.status === 'reported' && item.answer === NEO_WORK_REVIEWED)) {
      const content = neoConsultationReplyContent(item);
      if (content === null) return;
      await this.deliver(
        item.originSessionId,
        `neo-consult:${id}:reply`,
        content,
        item.sessionId,
        this.consultationParent(item),
        'continues'
      );
    }
    this.consultations.returned(id);
    await this.dispatchConsultationWaiter(item.projectId);
    for (const work of this.repo.listWork(item.projectId)) {
      if (work.status === 'reported' || work.status === 'failed') await this.returnReport(work);
    }
  }

  async reconcile(id: string): Promise<void> {
    const work = this.repo.getWork(id);
    if (!work?.sessionId) {
      if ((work?.status === 'reported' || work?.status === 'failed') && this.driverTargets.get(id))
        await this.recoverWorkReturn(work);
      return;
    }
    if (work.status === 'cancelled' || work.status === 'proposed') return;
    if (work.status === 'queued') {
      const target = this.resolveWorkTarget(id);
      if (!target.accepted) await this.failUnavailableTarget(work, target.reason);
      else await this.failErroredTurn(work);
      return;
    }
    if (work && (work.status === 'reported' || work.status === 'failed'))
      await this.recoverWorkReturn(work);
  }

  private readonly recoverWorkReturn = (superpipe({})('neo-work-recover-return') as PipelineAPI)
    .input(['work'])
    .pipe(
      (work: NeoWork) => ({
        told: this.toldDoneCheck(
          work,
          neoWorkReturnToldIds(work, {
            retries: this.driverTargets.readRetries(work.id),
            continued: this.workContinues.get(work.id)?.count ?? 0,
            prRevision: this.workPrs.get(work.id)?.revision,
            stalled: this.stalledContinues(work),
          })
        ),
      }),
      'work',
      'told'
    )
    .pipe(requireNeoWorkReturnUntold, 'told', 'result:recover')
    .pipe((work: NeoWork) => this.returnReport(work), 'work')
    .endAsync('recover') as (work: NeoWork) => Promise<unknown>;

  private async returnReport(work: NeoWork): Promise<void> {
    if (work.status === 'reported' && isNeoWorkClosedDone(work.report)) return;
    if (this.deferToDeliveryRetry(work)) return;
    if ((await this.checkDone(work, false)) !== 'not_checked') return;
    if (work.status === 'reported')
      await readNeoPackEvidence(
        this.evidencePacks(this.askRecords.forWork(work.id), !!this.workPrs.get(work.id)),
        work,
        (id, error) => this.log.warn(`Neo pack ${id} evidence read failed`, error)
      );
    const rootId = await this.open(null);
    if (work.projectId) {
      await returnWorkThroughHolder(this, work, rootId);
      return;
    }
    const targets = new Set([rootId, work.originSessionId]);
    const retries = this.driverTargets.readRetries(work.id);
    const retryNote =
      'value' in requireNeoWorkRetryable(work, this.retryCard(work.id), true)
        ? ` ${fillPrompt(NEO_WORK_RETURNED_RETRY, {
            retried: retries
              ? fillPrompt(NEO_WORK_RETURNED_RETRIED, {
                  count: String(retries),
                  times: retries === 1 ? 'time' : 'times',
                })
              : '',
          })}`
        : '';
    const packNote = this.askPackFragment(this.askRecords.forWork(work.id));
    const packLine = packNote
      ? `\n${fillPrompt(NEO_WORK_PACK_NOTE, { pack: packNote.id })}${packNote.inPrompt ? '' : `\n${packNote.instructions}`}\n`
      : '';
    const content = `${fillPrompt(NEO_WORK_RETURNED, { retry: retryNote, summary: NEO_WORK_SUMMARY_NOTE })}${packLine}\n${JSON.stringify({ workId: work.id, originSessionId: work.originSessionId, originMessageId: work.originMessageId, projectId: work.projectId, status: work.status, executionSessionId: work.sessionId, title: work.title, report: work.report })}`;
    const messageId = neoWorkReturnMessageId(
      work.id,
      retries,
      this.workContinues.get(work.id)?.count ?? 0
    );
    for (const target of targets) {
      if (!this.db.getSession(target)) continue;
      const fresh = !this.hasDelivery(target, messageId);
      await this.deliver(
        target,
        messageId,
        content,
        work.sessionId ?? work.originSessionId,
        neoWorkParent(work)
      );
      if (fresh && target === work.originSessionId) this.recordCardWake(work.id, messageId);
    }
  }

  private async cardPrCandidates(
    work: NeoWork,
    stored: { prs: readonly NeoWorkPr[] } | null
  ): Promise<NeoCardPrCandidate[]> {
    const goal = this.workGoals.get(work.id);
    const brief = [work.title, work.instruction, goal?.goal, goal?.doneWhen]
      .filter(Boolean)
      .join('\n');
    const ref = this.driverTargets.readRef(work.id);
    const sent = neoCardSent(this.driverTargets.readSent(work.id), work);
    const outcome =
      ref && sent
        ? await this.invokeAsCard(work, 'work.status', { ref, since: sent.inputBefore })
        : null;
    const window = outcome ? readDriverCardExchange(outcome, sent) : null;
    const cwd = currentCodingExecutionDirectory(ref, outcome, hostname(), window?.current === true);
    return planNeoCardPrCandidates({
      window,
      report: work.report,
      brief,
      branch: cwd ? await this.readCheckoutPrs(cwd) : await this.branchPrUrls(work.id),
      opened: this.cardOpenedPrs.get(work.id) ?? [],
      stored: stored?.prs ?? [],
      refs: await this.cardPrRefs(work, brief, outcome),
    });
  }

  private async cardPrRefs(
    work: NeoWork,
    brief: string,
    outcome: OperationOutcome | null
  ): Promise<{ named: string[]; mentioned: string[] }> {
    const ref = this.driverTargets.readRef(work.id);
    const localId = localCodingSessionId(ref);
    const cwd =
      neoWorkRepoCwd(localId ? this.db.getSession(localId) : null) ??
      localCodingExecutionDirectory(ref, outcome, hostname());
    return readCodingCardRefs(
      brief,
      work.report,
      () => (cwd ? this.readWorkRepo(cwd) : Promise.resolve(null)),
      (refs) => this.readRefStates(refs)
    );
  }

  private async branchPrUrls(workId: string): Promise<string[]> {
    return this.sessionBranchPrs(this.driverTargets.readRef(workId));
  }

  private async sessionBranchPrs(ref: WorkRef | null): Promise<string[]> {
    const localId = localCodingSessionId(ref);
    const branch = neoWorkBranch(localId ? this.db.getSession(localId) : null);
    return branch ? this.readBranchPrs(branch) : [];
  }

  private askPrs(ask: NeoAsk): NeoAskPrs {
    const works = ask.workIds.flatMap((id) => this.repo.getWork(id) ?? []);
    return {
      id: ask.id,
      status: ask.status,
      prs: neoAskPrKeys(ask, neoPackAskCardEvidence(this.packs(), ask, works)),
    };
  }

  private async runningPrUrls(workIds: readonly string[]): Promise<string[]> {
    const running = workIds.filter((id) => this.repo.getWork(id)?.status === 'queued');
    return (await Promise.all(running.map((id) => this.branchPrUrls(id)))).flat();
  }

  private writeAskTicks(ask: NeoAsk, ticks: readonly { id: string; evidence: string }[]): NeoAsk {
    const registry = this.checkRegistry();
    if (!registry.ok) return this.askRecords.get(ask.id) ?? ask;
    for (const tick of ticks) {
      const item = ask.doneItems?.find((item) => item.id === tick.id);
      const entry = item?.check ? registry.resolve(item.check) : null;
      if (!item || (entry && !entry.ok)) continue;
      const write = neoPackTickWrite(item, entry?.ok ? entry.value : null, tick.evidence);
      if (write) this.askRecords.tickItem(ask.id, write, Date.now(), item, write.state === 'met');
    }
    const ticked = ticks.length ? this.askRecords.get(ask.id) : null;
    return ticked
      ? (writeNeoAskTickStatus(this.askRecords, ticked, planNeoAskTickStatus(ticked)) ?? ticked)
      : ask;
  }

  private readonly runAskReadTicks = (superpipe({})('neo-ask-read-ticks') as PipelineAPI)
    .input(['ask'])
    .pipe((ask: NeoAsk) => ({ ask }), 'ask', 'read')
    .pipe(requireNeoPackTickable, 'read', 'result:ticks')
    .pipe(
      async (ask: NeoAsk) => ({
        ticks: await readNeoAskPackTicks(
          this.packs(),
          ask,
          ask.workIds.flatMap((id) => this.repo.getWork(id) ?? []),
          (id, error) => this.log.warn(`Neo pack ${id} ask ticks pending`, error)
        ),
      }),
      'ticks',
      'plan'
    )
    .pipe(
      (ask: NeoAsk, plan: { ticks: { id: string; evidence: string }[] }) => ({
        value: this.writeAskTicks(ask, plan.ticks),
      }),
      ['ticks', 'plan'],
      'result:ticks'
    )
    .endAsync('ticks') as (ask: NeoAsk) => Promise<NeoAsk | null>;

  private readonly runAskPackTicks = (superpipe({})('neo-ask-pack-ticks') as PipelineAPI)
    .input(['askId'])
    .pipe((askId: string) => ({ ask: this.askRecords.get(askId) }), 'askId', 'read')
    .pipe(requireNeoPackTickable, 'read', 'result:ticks')
    .pipe(
      (ask: NeoAsk) => ({ works: ask.workIds.flatMap((id) => this.repo.getWork(id) ?? []) }),
      'ticks',
      'linked'
    )
    .pipe(
      (ask: NeoAsk, linked: { works: NeoWork[] }) => ({
        ticks: planNeoPackTicks(
          ask,
          neoPackAskCardEvidence(this.packs(), ask, linked.works),
          neoPackChecks(this.packs())
        ),
      }),
      ['ticks', 'linked'],
      'plan'
    )
    .pipe(
      (ask: NeoAsk, plan: { ticks: ReturnType<typeof planNeoPackTicks> }) => ({
        value: this.writeAskTicks(ask, plan.ticks),
      }),
      ['ticks', 'plan'],
      'result:ticks'
    )
    .end('ticks') as (askId: string) => NeoAsk | null;

  private deliverDoneCheck(
    work: NeoWork,
    goal: NeoWorkGoal,
    row: NeoWorkPrRow | null,
    options: NeoDoneCheckDelivery = {}
  ): Promise<unknown> {
    return this.runDoneCheckDelivery(work, goal, { row }, options);
  }

  private readonly runDoneCheckDelivery = (superpipe({})('neo-done-check-delivery') as PipelineAPI)
    .input(['work', 'goal', 'found', 'options'])
    .pipe(
      (options: NeoDoneCheckDelivery) => ({
        ask: options.ask ? (this.runAskPackTicks(options.ask.id) ?? options.ask) : null,
      }),
      'options',
      'current'
    )
    .pipe(
      (
        work: NeoWork,
        goal: NeoWorkGoal,
        found: NeoDoneCheckFound,
        options: NeoDoneCheckDelivery,
        current: { ask: NeoAsk | null }
      ) => {
        const continued = this.workContinues.get(work.id)?.count ?? 0;
        return {
          id: neoDoneCheckMessageId(
            work.id,
            continued,
            found.row?.revision,
            options.followedAt,
            this.stalledContinues(work)
          ),
          content: driverDoneCheckNote(
            work,
            goal,
            continued,
            this.continueBudget(work, Date.now()),
            {
              stalled: this.stalledWakes(work.id),
              prs: found.row?.prs,
              stale: options.stale ?? false,
              ask: current.ask,
              pack: this.askPackFragment(current.ask),
              cards: current.ask
                ? projectNeoAskCards(
                    work.id,
                    current.ask.workIds.flatMap((id) => this.repo.getWork(id) ?? []),
                    this.workPrs.list(current.ask.workIds)
                  )
                : [],
            }
          ),
        };
      },
      ['work', 'goal', 'found', 'options', 'current'],
      'note'
    )
    .pipe(
      async (work: NeoWork, note: { id: string; content: string }) => {
        await this.wakeCards(
          [work.id],
          work.originSessionId,
          note.id,
          note.content,
          neoWorkParent(work)
        );
        return { at: Date.now() };
      },
      ['work', 'note'],
      'sent'
    )
    .pipe(
      (work: NeoWork, options: NeoDoneCheckDelivery, sent: { at: number }) => {
        if (options.signature) this.workChecks.markTold(work.id, options.signature, sent.at);
      },
      ['work', 'options', 'sent']
    )
    .endAsync('sent') as (
    work: NeoWork,
    goal: NeoWorkGoal,
    found: NeoDoneCheckFound,
    options: NeoDoneCheckDelivery
  ) => Promise<unknown>;

  private toldDoneCheck(work: NeoWork, ids: readonly string[]): boolean {
    return ids.some((id) => this.hasDelivery(work.originSessionId, id));
  }

  recentAsksFor(conversationId: string, sessionId: string): NeoConversationAsk[] {
    const forwarded = this.askForwards.listTo(sessionId, 5).flatMap((forward) => {
      const ask = this.asks.find(conversationId, forward.ask.messageId);
      return ask && ask.askOrigin.sessionId === forward.ask.sessionId
        ? [{ ...ask, requestId: neoForwardMessageId(forward.ask, forward.hop) }]
        : [];
    });
    return [...this.asks.recentFrom(conversationId, sessionId, 5), ...forwarded].sort(
      (a, b) => a.sequence - b.sequence
    );
  }

  forwardedAway(sessionId: string, messageId: string): boolean {
    return this.askForwards
      .listFrom(sessionId, neoForwardedAskMessageId(messageId) ?? messageId)
      .some((forward) =>
        this.hasDelivery(forward.toSessionId, neoForwardMessageId(forward.ask, forward.hop))
      );
  }

  hasDelivery(sessionId: string, messageId: string): boolean {
    return (
      this.deliveries.has(`${sessionId}:${messageId}`) ||
      !!this.db.getSDKMessageRepo().findMessageIdByUuid(sessionId, messageId) ||
      this.db
        .getJobQueueRepo()
        .listActiveByPayload('mailbox', { 'to.sessionId': sessionId, messageUuid: messageId })
        .length > 0
    );
  }

  private async invokeAsCard(work: NeoWork, name: string, input: Record<string, unknown>) {
    const outcome = await invokeOperation(
      this.sessions.getOperationRegistry(),
      name,
      input,
      driverWorkCaller(work)
    );
    if (name === 'work.status') {
      const opened = readDriverOpenedPrs(outcome);
      if (opened.length) this.cardOpenedPrs.set(work.id, opened);
    }
    return outcome;
  }

  private consultationParent(item: NeoConsultation): NeoAskOrigin | null {
    const reviewed = neoReviewWorkId(item.id);
    return neoConsultationParent(item, reviewed ? this.repo.getWork(reviewed) : null);
  }

  private async wakeCards(
    workIds: readonly string[],
    originSessionId: string,
    messageId: string,
    content: string,
    parent: NeoAskOrigin | null
  ): Promise<void> {
    const fresh = !this.hasDelivery(originSessionId, messageId);
    await this.deliverToOrigin(originSessionId, messageId, content, parent);
    if (fresh) for (const id of workIds) this.recordCardWake(id, messageId);
  }

  private deliverToOrigin(
    originSessionId: string,
    messageId: string,
    content: string,
    parent: NeoAskOrigin | null,
    trigger: NeoDeliveryTrigger = null
  ): Promise<void> {
    return this.deliver(originSessionId, messageId, content, originSessionId, parent, trigger);
  }

  deliverForward(
    sessionId: string,
    messageId: string,
    content: string,
    fromSessionId: string,
    ask: NeoAskOrigin | null,
    trigger: NeoDeliveryTrigger
  ): Promise<void> {
    return this.deliver(sessionId, messageId, content, fromSessionId, ask, trigger);
  }

  moveAsk(
    ask: NeoAsk,
    cards: readonly NeoWork[],
    owner: { projectId: string; sessionId: string; messageId: string }
  ): void {
    const to = {
      projectId: owner.projectId,
      originSessionId: owner.sessionId,
      originMessageId: owner.messageId,
    };
    this.db.getDatabase().transaction(() => {
      this.askRecords.moveTo(ask.id, to);
      this.repo.moveWork(
        cards.map((card) => card.id),
        to
      );
    })();
  }

  logReorganize(line: string): void {
    this.log.info(line);
  }

  private deliver(
    sessionId: string,
    messageId: string,
    content: string,
    originSessionId: string,
    parent: NeoAskOrigin | null = null,
    trigger: NeoDeliveryTrigger = null
  ): Promise<void> {
    const key = `${sessionId}:${messageId}`;
    const existing = this.deliveries.get(key);
    if (existing) return existing;
    const delivery = Promise.resolve()
      .then(() => this.stampDelivery({ sessionId, messageId }, parent, trigger))
      .then(() => this.enqueueDelivery(sessionId, messageId, content, originSessionId))
      .finally(() => this.deliveries.delete(key));
    this.deliveries.set(key, delivery);
    return delivery;
  }

  private stampDelivery(
    input: NeoAskOrigin,
    parent: NeoAskOrigin | null,
    trigger: NeoDeliveryTrigger
  ): void {
    const origin = parent ? this.resolveAskOrigin(parent) : null;
    if (!origin) return;
    const triggerId = neoDeliveryTrigger(trigger, () => this.parentTrigger(parent));
    this.inputOrigins.record(input, origin, Date.now(), triggerId);
  }

  stampContinuation(input: NeoAskOrigin, parent: NeoAskOrigin): void {
    if (!this.repo.getBindingBySession(input.sessionId)) return;
    this.stampDelivery(input, parent, 'continues');
  }

  inputTrigger(input: NeoAskOrigin): string | null {
    return (
      this.inputOrigins.trigger(input.sessionId, input.messageId) ??
      (this.isHumanInput(input) ? neoHumanTrigger(input.messageId) : null)
    );
  }

  private parentTrigger(parent: NeoAskOrigin | null): string | null {
    return parent ? this.inputTrigger(parent) : null;
  }

  private async enqueueDelivery(
    sessionId: string,
    messageId: string,
    content: string,
    originSessionId: string
  ): Promise<void> {
    const queue = this.db.getJobQueueRepo();
    if (this.db.getSDKMessageRepo().findMessageIdByUuid(sessionId, messageId)) return;
    if (
      queue.listActiveByPayload('mailbox', { 'to.sessionId': sessionId, messageUuid: messageId })
        .length
    )
      return;
    if (!issueNeoNote(this.noteQueue, sessionId, messageId).issue) return;
    const outcome = await handoffPromptToMailbox({
      to: renderAddress({ kind: 'session', sessionId }),
      origin: renderAddress({ kind: 'session', sessionId: originSessionId }),
      messageUuid: messageId,
      message: {
        type: 'user',
        message: { role: 'user', content },
        parent_tool_use_id: null,
        inputKind: 'system',
      },
      deliveryMode: neoCoordinatorBinding(this.db, sessionId)
        ? neoNoteDeliveryMode(
            this.processingStatus.get(sessionId) ??
              neoSessionStatus(this.db.getSession(sessionId)?.processingState)
          )
        : 'immediate',
      jobQueue: queue,
    });
    if (outcome.kind === 'rejected') throw new Error(outcome.reason);
  }
}
