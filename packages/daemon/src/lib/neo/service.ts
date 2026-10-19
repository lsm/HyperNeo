import { NeoWorkControlFailureRepository } from '../../storage/repositories/neo-work-control-failure-repository.ts';
import { neoControlFailure, neoControlFailureForRef } from './control-failure.ts';
import { planNeoHolderTitles } from './holder-title.ts';
import { hostname } from 'node:os';
import { neoWorkingKey, readNeoWorking } from './working.ts';
import {
  fillPrompt,
  NEO_ASK_EVIDENCE,
  NEO_ASK_IDLE,
  NEO_ASK_STALLED,
  NEO_SESSION_TRACK,
  NEO_WORK_PACK_NOTE,
  NEO_WORK_RETURNED,
  NEO_WORK_RETURNED_RETRIED,
  NEO_WORK_RETURNED_RETRY,
} from '@hyperneo/prompts';
import type { GlobalSettings, MessageHub, Provider } from '@hyperneo/shared';
import type { NeoConsultation, NeoWork } from '@hyperneo/shared/types/neo-context';
import type { MailboxMessageContent } from '../mailbox/entry.ts';
import type { NeoPublication, NeoPublicationInput } from '@hyperneo/shared/types/neo-publication';
import {
  isNeoWorkClosedDone,
  NEO_WORK_CLOSED_DONE_PREFIX,
  type NeoAsk,
  type NeoAskItem,
  type NeoAskSessionView,
  type NeoWorkGoal,
  type NeoWorkPr,
  type NeoWorkingEvent,
} from '@hyperneo/shared/types/neo-snapshot';
import { type NeoModelPreference, neoStandingRules } from '@hyperneo/shared/types/settings';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { Database } from '../../storage/database.ts';
import { DaemonInventoryRepository } from '../../storage/repositories/daemon-inventory-repository.ts';
import { NeoAgentWorkTargetRepository } from '../../storage/repositories/neo-agent-work-target-repository.ts';
import {
  NeoAskCheckRepository,
  type NeoAskCheckRow,
} from '../../storage/repositories/neo-ask-check-repository.ts';
import { NeoAskForwardRepository } from '../../storage/repositories/neo-ask-forward-repository.ts';
import {
  neoQuestionStartTargets,
  neoStartDecision,
  neoStartChoice,
  planNeoStartQuestion,
} from './start-question.ts';
import { NeoAskRepository } from '../../storage/repositories/neo-ask-repository.ts';
import { NeoAskTodoRepository } from '../../storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../storage/repositories/neo-todo-session-repository.ts';
import { createNeoTodoRunner, neoTodoCard, type NeoTodoRunner } from './todo-runner.ts';
import { CodingTodoPrRepository } from './packs/coding/todo-prs.ts';
import { neoCardPrAttention } from './packs/coding/card-facts.ts';
import { neoDerivedId } from './derived-id.ts';
import { NeoCardEventSubscriptionRepository } from '../../storage/repositories/neo-card-event-subscription-repository.ts';
import { SessionEventSubscriptionRepository } from '../../storage/repositories/session-event-subscription-repository.ts';
import { pullRequestUrlOfTopic } from '../github/parse-pr-url.ts';
import { NeoCardPrRelayRepository } from '../../storage/repositories/neo-card-pr-relay-repository.ts';
import { NeoConsultationRepository } from '../../storage/repositories/neo-consultation-repository.ts';
import { NeoConsultationWaiterRepository } from '../../storage/repositories/neo-consultation-waiter-repository.ts';
import { NeoConversationAskRepository } from '../../storage/repositories/neo-conversation-ask-repository.ts';
import {
  type NeoCrossProjectGroup,
  type NeoCrossProjectMember,
  NeoCrossProjectRepository,
  neoCrossProjectReplyId,
} from '../../storage/repositories/neo-cross-project-repository.ts';
import { NeoDependencyRepository } from '../../storage/repositories/neo-dependency-repository.ts';
import { NeoInputOriginRepository } from '../../storage/repositories/neo-input-origin-repository.ts';
import { NeoNotificationTriggerRepository } from '../../storage/repositories/neo-notification-trigger-repository.ts';
import { NeoPublicationRepository } from '../../storage/repositories/neo-publication-repository.ts';
import { NeoRepository } from '../../storage/repositories/neo-repository.ts';
import { NeoSessionSeenRepository } from '../../storage/repositories/neo-session-seen-repository.ts';
import {
  NeoWorkCheckRepository,
  type NeoWorkCheckRow,
} from '../../storage/repositories/neo-work-check-repository.ts';
import { NeoWorkContinueRepository } from '../../storage/repositories/neo-work-continue-repository.ts';
import { NeoWorkDriverTargetRepository } from '../../storage/repositories/neo-work-driver-target-repository.ts';
import { NeoWorkGoalRepository } from '../../storage/repositories/neo-work-goal-repository.ts';
import { NeoWorkRefusalRepository } from '../../storage/repositories/neo-work-refusal-repository.ts';
import { NeoWorkResourceRepository } from '../../storage/repositories/neo-work-resource-repository.ts';
import { NeoWorkSupersessionRepository } from '../../storage/repositories/neo-work-supersession-repository.ts';
import { NeoWorkWakeRepository } from '../../storage/repositories/neo-work-wake-repository.ts';
import { BUILD_METADATA } from '../build-metadata.ts';
import { spaceWorkRefForSession } from '../drivers/space-adapter.ts';
import type { WorkRef } from '../drivers/types.ts';
import type { ExternalEventPublishedPayload } from '../external-events/external-event-service.ts';
import { sessionEventText } from '../external-events/session-event-delivery.ts';
import {
  SESSION_EVENT_SCOPE,
  SessionExternalEventStore,
} from '../external-events/session-external-event-store.ts';
import type { ExternalEvent } from '../external-events/types.ts';
import type { DaemonInternalEventMap, InternalEventBus } from '../internal-event-bus.ts';
import { Logger } from '../logger.ts';
import { renderAddress } from '../mailbox/address.ts';
import { handoffPromptToMailbox } from '../mailbox/handoff.ts';
import { invokeOperation, type OperationOutcome } from '../operations/invoke.ts';
import type { OperationCaller } from '../operations/registry.ts';
import { remoteDaemons } from '../remote-daemons/registry.ts';
import { hashString32 } from '../runtime-hash.ts';
import type { SessionManager } from '../session/session-manager.ts';
import { planNeoAvailabilityWakes, scheduleNeoAdmissionWake } from './admission-wake.ts';
import { isNeoAskAnswerReady, planNeoAnswerPublished } from './answer-outcome.ts';
import { planNeoAskEvidenceNote, requireNeoAskEvidenceDue } from './ask-evidence.ts';
import {
  neoForwardedText,
  neoForwardMessageId,
  neoTurnOwnsMessage,
} from './ask-forward-operation.ts';
import {
  type NeoAskIdleSeen,
  neoAskIdleSignature,
  requireNeoAskIdle,
  trackNeoAskIdle,
} from './ask-idle.ts';
import {
  neoAskLiveOutcomeCards,
  planNeoAskTickStatus,
  planNeoAskWorkStops,
  writeNeoAskTickStatus,
} from './ask-plans.ts';
import {
  createNeoAskOriginResolver,
  type NeoAskOrigin,
  neoAskAnswerMessageId,
  neoAskEvidenceMessageId,
  neoAskParent,
  neoAskTickedMessageId,
  neoConsultationParent,
  neoDoneCheckMessageId,
  neoNeedsYouMessageId,
  neoReviewWorkId,
  neoStallMessageId,
  neoWorkParent,
  neoWorkReturnMessageId,
  nudgedMessageId,
} from './ask-origin.ts';
import { requireNeoAskStalled, requireNeoAskStallUntold } from './ask-stall.ts';
import { neoAskProgressNote } from './ask-progress.ts';
import { neoCardAttentionNeoNote, requireNeoCardAttentionRelay } from './card-attention.ts';
import { planNeoCardCheck } from './card-check.ts';
import {
  neoProjectEventMessageId,
  planNeoCardEventRoute,
  planNeoCardEventSends,
  planNeoCardSend,
  planNeoCardTopicsEnded,
  planNeoProjectEventHolders,
  neoCardWorkerSession,
} from './card-events.ts';
import { planNeoDaemonCardSettle, requireNeoCardTurn } from './card-settle.ts';
import type { NeoCardWait } from './card-views.ts';
import {
  isNeoCardAwaitingPr,
  isNeoCardDoneWhenMet,
  neoContinueFacts,
  isNeoHumanInputSince,
  neoCardWakeProgress,
} from './card-wake.ts';
import { neoConsultationReplyContent } from './consultation-reply-content.ts';
import { neoConsultationRequestContent } from './consultation-request-content.ts';
import {
  admitNeoWorkContinue,
  type NeoContinueCaller,
  type NeoContinueDeps,
  type NeoContinueResult,
  sendNeoWorkContinue,
} from './continue-work.ts';
import { readNeoDaemonCommits } from './daemon-commits.ts';
import {
  isNeoDeliveryRetryPending,
  planNeoDeliveryRetry,
  scheduleNeoDeliveryRetry,
} from './delivery-retry.ts';
import { neoNoteDeliveryMode, neoSessionStatus } from './session-status.ts';
import {
  isNeoAskLive,
  type NeoDoneCheckSkip,
  neoDoneCheckToldIds,
  neoWorkReturnToldIds,
  requireNeoDoneCheck,
  requireNeoDoneCheckDue,
  requireNeoDoneCheckUntold,
  requireNeoWorkReturnUntold,
} from './done-check.ts';
import {
  type DriverSent,
  decideStuckReminder,
  driverAdoptedReport,
  driverDoneCheckNote,
  driverNeedsYouNote,
  driverStallNote,
  driverStartedReport,
  driverStuckNote,
  driverTargetDaemon,
  driverWorkCall,
  driverWorkCaller,
  messageOpening,
  NEO_DRIVER_START_INTERRUPTED,
  NEO_WORK_STALL_MS,
  type NeoDriverTarget,
  type NeoWorkRetryCard,
  neoCardSent,
  neoWorkDoneGoal,
  neoWorkProgress,
  planNeoStartReceiptAdoption,
  projectNeoAskCards,
  readDriverActivity,
  readDriverAdoptedSent,
  readDriverCardExchange,
  readDriverLive,
  readDriverNeedsYou,
  readDriverOpenedPrs,
  readDriverOutcome,
  readDriverSendBaseline,
  readDriverSent,
  readNeoDriverAdapters,
  requireNeoWorkRetryable,
  withWorkGoal,
} from './driver-work.ts';
import {
  type NeoEvidence,
  type NeoEvidenceRead,
  neoEvidenceSignature,
  planNeoDoneCheck,
} from './evidence.ts';
import { neoFolderPath } from './folder.ts';
import { reconcileNeoHandoff } from './handoff-reconcile.ts';
import { effectiveNeoPreference, planNeoAlignment } from './model-preference.ts';
import {
  neoAskAnswerNote,
  neoAskReopensAfterClear,
  neoAskTickedNote,
  neoNeedsYouClearedNote,
  neoResumeWhy,
  planNeoNeedsYou,
  planNeoNeedsYouCleared,
  planNeoQuestionsWithdrawn,
} from './needs-you.ts';
import {
  NEO_TRIGGER_DELIVERY_RETRY_MS,
  NEO_TRIGGER_SWEEP_MS,
  type NeoAskTrigger,
  type NeoDeliveryTrigger,
  type NeoTriggerSweepDeps,
  neoAskOutcomeBase,
  neoAskTriggerKeys,
  neoAskTriggerConcern,
  neoConsultationDelivery,
  neoDeliveryTrigger,
  neoHumanTrigger,
  neoHumanTriggerMessageId,
  neoTriggerMessageId,
  neoTriggerNote,
  neoTriggerWatchSessions,
  noteNeoAskTrigger,
  planNeoAskTrigger,
  planNeoSettledReports,
} from './notification-triggers.ts';
import { neoOutcomeCheckPolicy } from './outcome-check-policy.ts';
import { buildNeoCheckRegistry } from './packs/check-registry.ts';
import {
  type NeoRefStateReader,
  readCodingCardRefs,
  readGithubRefStates,
} from './packs/coding/ask-prs.ts';
import {
  currentCodingExecutionDirectory,
  localCodingExecutionDirectory,
  localCodingSessionId,
  type NeoBranchPrReader,
  type NeoWorkRepoReader,
  neoWorkBranch,
  neoWorkRepoCwd,
  readGithubBranchPrs,
  readGithubWorkRepo,
} from './packs/coding/branch-prs.ts';
import {
  type NeoCardPrCandidate,
  planNeoCardPrCandidates,
  neoCardPrWindow,
} from './packs/coding/card-pr-claims.ts';
import {
  type NeoDeployReader,
  readGithubDeploys,
  readMergeCommit,
} from './packs/coding/deploy-checks.ts';
import { listNeoGithub, type NeoGithubLister } from './packs/coding/github-query.ts';
import { NeoWorkPrClaimRepository } from './packs/coding/neo-work-pr-claim-repository.ts';
import { NeoWorkPrRepository, type NeoWorkPrRow } from './packs/coding/neo-work-pr-repository.ts';
import { createCodingPack, type NeoCardPrDeps } from './packs/coding/pack.ts';
import { neoPrQuestionWithdrawalPolicy } from './packs/coding/question-withdrawal-policy.ts';
import { codingCardBase } from './packs/coding/watch-checks.ts';
import {
  type NeoWorkPrReader,
  type NeoWorkPrRefreshSkip,
  readGithubPrs,
  requireNeoWorkPrCurrent,
  requireNeoWorkPrDelivery,
} from './packs/coding/work-prs.ts';
import {
  neoEnabledPacks,
  neoPackAskCardEvidence,
  neoPackAskTopics,
  neoPackBriefs,
  neoPackCardFacts,
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
import { createLifeAdminPack } from './packs/life-admin/pack.ts';
import type {
  NeoCardEventSubscription,
  NeoPack,
  NeoPackBrief,
  NeoPackCardAttention,
  NeoPackEventRoute,
  NeoPackFragment,
} from './packs/types.ts';
import { neoPrompt } from './prompt.ts';
import { createNeoPublicationCommit } from './publication-commit.ts';
import { createNeoPublisher } from './publication-operation.ts';
import { runNeoReadWork } from './read-work.ts';
import { NEO_INBOX_ID, openNeoDefaultSession } from './inbox.ts';
import {
  type NeoSavedRulesNote,
  planNeoSavedRulesAppend,
  planNeoSavedRulesNote,
  withNeoSavedRules,
} from './saved-rules.ts';
import { readNeoAskTriggerView } from './service-card-views.ts';
import { type NeoAskPrs, neoAskPrKeys } from './session-ask-links.ts';
import {
  neoCoordinatorAllowedTools,
  neoCoordinatorBinding,
  neoCoordinatorNativeTools,
} from './session-policy.ts';
import { keepNeoTrackedSessions } from './session-track.ts';
import type { NeoSessionNotice, NeoSessionNoticeGroup } from './session-watch.ts';
import { NeoSessionWatcher } from './session-watcher.ts';
import { type NeoDriverSettleDeps, settleNeoDriverWork } from './settle-driver-work.ts';
import type { NeoSnapshotRead } from './snapshot-read.ts';
import {
  type NeoReminderListing,
  neoReminderTurn,
  planNeoReminderListings,
  planNeoRemindersSpent,
  planNeoWaitingReminders,
} from './waiting-reminders.ts';
import {
  admitNeoWork,
  isNeoAdmissionApproved,
  neoAdmissionRefusal,
  neoOutcomeEligibility,
} from './work-admission.ts';
import {
  NEO_WORK_REPORT_LIMIT,
  type NeoEnvironmentMove,
  type NeoWorkBlocker,
  neoEnvironmentMoveNote,
  planNeoEnvironmentMove,
  readNeoWorkBlocker,
} from './work-blocker.ts';
import { closeNeoWork, type NeoWorkCloseOutcome, type NeoWorkCloseResult } from './work-close.ts';
import { NEO_WORK_FOLLOW_MAX_AGE_MS } from './work-follow.ts';
import { reconcileNeoWorkRefusal } from './work-refusal.ts';
import { createNeoWorkReporter } from './work-report.ts';
import {
  awaitingNeoWorker,
  NEO_WORK_AWAITING_WORKER,
  NEO_WORK_RESERVED_WORKER,
  neoWorkerRefKey,
  rerouteNeoDriverWork,
} from './work-reroute.ts';
import { createNeoWorkTargetResolver } from './work-target.ts';

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

const NEO_PROJECT_EVENT_NOTE =
  'An event on one of this project’s cards. Its ask belongs to another Neo session, which acts on it.';
const NEO_WORK_REVIEWED = 'The context holder reviewed the returned work.';

type NeoWorkPrCard = {
  ask: NeoAsk | null;
  goal: NeoWorkGoal | null;
  row: NeoWorkPrRow | null;
  session: boolean;
  packEvidence: boolean;
  toldAt: number | null;
  doneWhenMet: boolean;
  changedAt: number | null;
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
  readonly todos: NeoAskTodoRepository;
  readonly todoSessions: NeoTodoSessionRepository;
  readonly todoRunner: NeoTodoRunner;
  readonly todoPrs: CodingTodoPrRepository;
  readonly dependencies: NeoDependencyRepository;
  readonly workPrs: NeoWorkPrRepository;
  readonly cardEvents: NeoCardEventSubscriptionRepository;
  private readonly sessionSubscriptions: SessionEventSubscriptionRepository;
  private readonly sessionEvents: SessionExternalEventStore;
  watchExternalTopic: ((topic: string) => Promise<void>) | null = null;
  readonly workPrClaims: NeoWorkPrClaimRepository;
  readonly workRefusals: NeoWorkRefusalRepository;
  readonly controlFailures: NeoWorkControlFailureRepository;
  readonly workChecks: NeoWorkCheckRepository;
  readonly askChecks: NeoAskCheckRepository;
  private readonly askEvidenceReads = new Map<string, number>();
  private readonly cardPrRelays: NeoCardPrRelayRepository;
  private askIdleSeen: NeoAskIdleSeen = new Map();
  private settledReports = new Map<string, number>();
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
  private readonly noteWorking: () => void;
  private workingKey = '';
  readonly notifyPublicationsChanged: (conversationId: string) => void;
  private readonly triggers: NeoNotificationTriggerRepository;
  private readonly triggerDeps: NeoTriggerSweepDeps;
  private triggerTimer?: ReturnType<typeof setTimeout>;
  private readonly triggerDeliveryRetryAt = new Map<string, number>();
  private opening: Promise<string> | null = null;
  private readonly workPending = new Map<string, Promise<void>>();
  private readonly bootedAt = Date.now();
  private readonly deliveries = new Map<string, Promise<void>>();
  private readonly processingStatus = new Map<string, string>();
  private readonly continuing = new Set<string>();
  private readonly activitySeen = new Map<string, { at: number; seenAt: number }>();
  private readonly cardOpenedPrs = new Map<string, string[]>();
  private readonly openedPrsTried = new Map<string, string>();
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
            neoDoneCheckToldIds(work, card.continued, undefined, followed, 0)
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
            neoDoneCheckToldIds(work, card.continued, found.row.revision, false, 0)
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
      void Promise.resolve()
        .then(() => this.alignHolderTitles())
        .catch((error) => this.log.warn(`Neo holder titles not aligned: ${error}`));
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
      reportSettled: (id, updatedAt) => this.settledReports.get(id) === updatedAt,
      recorded: (askId, id) => this.triggers.recorded(askId, id),
      record: (askId, keys, triggerId) => this.triggers.record(askId, keys, triggerId, Date.now()),
      wake: (ask, trigger) => this.deliverAskTrigger(ask, trigger),
    };
    this.sessionWatcher = new NeoSessionWatcher({
      db,
      defaultSessionId: () => this.defaultSessionId(),
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
    this.controlFailures = new NeoWorkControlFailureRepository(db.getDatabase());
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
    this.todos = new NeoAskTodoRepository(db.getDatabase(), this.notifyChanged);
    this.todoSessions = new NeoTodoSessionRepository(db.getDatabase());
    this.todoPrs = new CodingTodoPrRepository(db.getDatabase());
    this.todoRunner = createNeoTodoRunner({
      store: this.todos,
      sessions: this.todoSessions,
      invoke: (caller, name, input) =>
        invokeOperation(this.sessions.getOperationRegistry(), name, input, caller),
      packs: () => this.installedPacks(),
      tell: (ask, todo, note) => {
        const parent = ask.originMessageId
          ? { sessionId: ask.sessionId, messageId: ask.originMessageId }
          : null;
        const resolved = parent && this.resolveAskOrigin(parent);
        const origin = resolved && this.db.getSession(resolved.sessionId) ? resolved : parent;
        return this.deliverForward(
          origin?.sessionId ?? ask.sessionId,
          `neo-todo:${todo.id}:${todo.updatedAt}`,
          note,
          ask.sessionId,
          origin,
          'continues'
        );
      },
      tellAsk: async (ask, messageId, note) => {
        const status =
          this.processingStatus.get(ask.sessionId) ??
          neoSessionStatus(this.db.getSession(ask.sessionId)?.processingState);
        if (status !== 'idle' || this.hasDelivery(ask.sessionId, messageId)) return;
        await this.deliverForward(
          ask.sessionId,
          messageId,
          note,
          ask.sessionId,
          ask.originMessageId ? { sessionId: ask.sessionId, messageId: ask.originMessageId } : null,
          'continues'
        );
      },
      changed: this.notifyChanged,
    });
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
    this.sessionSubscriptions = new SessionEventSubscriptionRepository(db.getDatabase());
    this.sessionEvents = new SessionExternalEventStore(db.getDatabase());
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
        cardStartedAt: (workId) => this.repo.workStartedAt(workId),
        todoPrs: this.todoPrs,
      }),
      createLifeAdminPack(),
    ];
    for (const pack of this.builtinPacks) pack.todos?.schema(db.getDatabase());
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
    const notifyPublication = () => {
      try {
        void hub.event('neo.changed', {});
      } catch {}
    };
    this.noteWorking = () => {
      try {
        const working = readNeoWorking(this.db.getDatabase());
        const key = neoWorkingKey(working);
        if (key === this.workingKey) return;
        this.workingKey = key;
        void hub.event('neo.working', { working } satisfies NeoWorkingEvent);
      } catch (error) {
        this.log.warn('Neo working list not sent', error);
      }
    };
    this.publish = createNeoPublisher({
      getBinding: (id) => this.repo.getBindingBySession(id),
      getRootBinding: () => this.repo.defaultBinding(),
      hasProject: (id) => !!this.repo.getProject(id),
      getWork: (id) => this.repo.getWork(id),
      getConsultation: (id) => this.consultations.get(id),
      resolveAskOrigin: (input) => this.resolveAskOrigin(input),
      resolveHumanAskOrigin: (input) => this.resolveHumanAskOrigin(input),
      inputTrigger: (input) => this.inputTrigger(input),
      isDeliveredHumanInput: (input) =>
        this.isHumanInput(input) &&
        this.db.getSDKMessageRepo().getUserSendStatus(input.sessionId, input.messageId) ===
          'consumed',
      append: (input) => this.commitPublication(input),
      notify: notifyPublication,
    });
    this.commitPublication = createNeoPublicationCommit({
      commit: (input) => {
        const problem = this.crossProjects.publicationProblem(input);
        if (problem) return { accepted: false, reason: problem };
        return this.appendPublication(input);
      },
      published: (input, publication) => {
        this.notePublishedAnswer(publication);
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
      async ({ sessionId, processingState, session }) => {
        const status = processingState?.status;
        const previous = this.processingStatus.get(sessionId);
        if (status) this.processingStatus.set(sessionId, status);
        if (status === 'processing' && previous !== 'processing')
          void this.steerHumanMessages(sessionId);
        const bound = status || session?.status ? this.repo.getBindingBySession(sessionId) : null;
        if (bound && bound.kind !== 'worker') this.noteWorking();
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
        if (binding && binding.kind !== 'worker') this.scheduleTriggerSweep();
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
      ({ sessionId }) => {
        this.forgetSession(sessionId);
        this.noteWorking();
      },
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

  private pruneReadThrottles(_now: number): void {
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

  resolveHumanAskOrigin(input: NeoAskOrigin): NeoAskOrigin | null {
    const origin = this.resolveAskOrigin(input);
    return origin && this.isHumanInput(origin) ? origin : null;
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
    return this.askRecords.list().filter((ask) => ask.status !== 'abandoned');
  }

  private initializeTriggerFacts(): void {
    this.triggers.initializeFacts(() => {
      for (const ask of this.askRecords.list()) {
        if (ask.status !== 'achieved') continue;
        const read = this.triggerDeps.read(ask);
        if (!read) continue;
        const plan = planNeoAskTrigger(
          ask,
          neoAskTriggerKeys(
            ask,
            read,
            this.triggerDeps.work,
            this.triggerDeps.deliveryRetryPending,
            this.triggerDeps.reportSettled
          )
        );
        if ('value' in plan) this.triggerDeps.record(ask.id, plan.value.keys, plan.value.triggerId);
      }
    }, Date.now());
  }

  private async deliverAskTrigger(ask: NeoAsk, trigger: NeoAskTrigger): Promise<boolean> {
    const delay = (this.triggerDeliveryRetryAt.get(trigger.triggerId) ?? 0) - Date.now();
    if (delay > 0) {
      this.scheduleTriggerSweep(delay);
      return false;
    }
    this.triggerDeliveryRetryAt.delete(trigger.triggerId);
    try {
      const target = await this.open();
      await this.deliver(
        target,
        neoTriggerMessageId(trigger.triggerId),
        neoTriggerNote(ask, trigger),
        target,
        neoAskParent(ask),
        { id: trigger.triggerId }
      );
      return true;
    } catch (error) {
      this.log.warn('Trigger note pending; the next sweep retries it', error);
      this.triggerDeliveryRetryAt.set(
        trigger.triggerId,
        Date.now() + NEO_TRIGGER_DELIVERY_RETRY_MS
      );
      this.scheduleTriggerSweep(NEO_TRIGGER_DELIVERY_RETRY_MS);
      return false;
    }
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
    if (this.disposed) return;
    for (const ask of this.triggerAsks()) {
      try {
        this.reconcilePublishedAnswer(ask);
        await noteNeoAskTrigger(ask, this.triggerDeps);
      } catch (error) {
        this.log.warn(`Trigger check for ask ${ask.id} failed`, error);
      }
    }
  }

  private triggerConcern(ask: NeoAsk): string | null {
    return neoAskTriggerConcern(ask, this.repo.getBindingBySession(ask.originSessionId));
  }

  private triggerOwner(ask: NeoAsk): string | null {
    return this.repo.getBindingForProject(this.triggerConcern(ask))?.sessionId ?? null;
  }

  private isTriggerOwnerBusy(ask: NeoAsk): boolean {
    const owner = this.triggerOwner(ask);
    if (!owner) return true;
    return neoTriggerWatchSessions(
      owner,
      ask.workIds.map((id) => this.repo.getWork(id))
    ).some((session) => {
      const status =
        this.processingStatus.get(session) ??
        neoSessionStatus(this.db.getSession(session)?.processingState);
      return status !== null && status !== 'idle';
    });
  }

  private reconcilePublishedAnswer(ask: NeoAsk): void {
    const conversation = this.repo.conversationId();
    if (!isNeoAskAnswerReady(ask) || !conversation) return;
    for (const triggerId of this.triggers.triggerIdsFor(ask.id, neoAskOutcomeBase(ask))) {
      const publication = this.publications.byTrigger(conversation, triggerId);
      if (publication) this.notePublishedAnswer(publication);
    }
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
      if (ticked) this.writeAskStatus(ticked, publication.shortText);
    }
  }

  private appendPublication(input: NeoPublicationInput) {
    const plan = planNeoSavedRulesAppend(input, this.savedRules, {
      standingRules: neoStandingRules(this.db.getGlobalSettings?.().neo),
      stored: !!this.publications.get(input.conversationId, input.publicationId),
    });
    const receipt = this.crossProjects.append(input, () =>
      this.publications.append(withNeoSavedRules(input, plan.rules))
    );
    if (receipt.accepted && plan.keep) this.keepSavedRules(plan.keep);
    if (receipt.accepted && receipt.created) this.spendWaitingReminders(input.producerInput);
    return receipt;
  }

  waitingReminders(turn: { sessionId: string; messageId: string }) {
    const prompt = this.db
      .getSDKMessageRepo()
      .getHumanPrompt(turn.sessionId, nudgedMessageId(turn.messageId) ?? turn.messageId);
    return prompt
      ? planNeoWaitingReminders(this.askRecords.waitingFor(turn.sessionId), prompt.at)
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
    const fallback = this.defaultSessionId();
    const settings = this.db.getGlobalSettings?.();
    return effectiveNeoPreference(
      settings?.neo?.preferences,
      fallback ? (this.db.getSession(fallback)?.config ?? null) : null,
      settings?.thinkingLevel
    );
  }

  async saveModelPreference(preferences: NeoModelPreference): Promise<void> {
    const neo = this.db.getGlobalSettings().neo;
    const updated = this.db.updateGlobalSettings({ neo: { ...neo, preferences } });
    this.publishSettings?.(updated);
    const root = this.repo.defaultBinding();
    if (root)
      await this.alignModelPreference(root.sessionId).catch((error) =>
        this.log.warn('Neo model preference not applied', error)
      );
  }

  private async alignHolderTitles(): Promise<void> {
    if (!this.repo) return;
    const fixes = planNeoHolderTitles(
      this.repo.listProjectTitles().flatMap((project) => {
        const binding = this.repo.getBindingForProject(project.id);
        const session = binding ? this.db.getSession(binding.sessionId) : null;
        return binding
          ? [
              {
                sessionId: binding.sessionId,
                projectTitle: project.title,
                sessionTitle: session?.title,
                titleSetBy: session?.metadata?.titleSetBy,
              },
            ]
          : [];
      })
    );
    for (const fix of fixes) await this.sessions.updateSession(fix.sessionId, { title: fix.title });
  }

  private async alignModelPreference(sessionId: string): Promise<void> {
    const preference = this.modelPreference();
    const config = this.db.getSession(sessionId)?.config;
    const plan = preference && config ? planNeoAlignment(config, preference) : null;
    if (!preference || !plan) return;
    const live = await this.sessions.getSessionForControl(sessionId);
    if (!live) return;
    if (plan.model) {
      const switched = await live.requestModelSwitch(preference.model, preference.provider);
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
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.unsubscribe();
    if (this.triggerTimer) clearTimeout(this.triggerTimer);
    this.triggerTimer = undefined;
    this.triggerDeliveryRetryAt.clear();
    this.processingStatus.clear();
    if (this.watching) await this.watching;
    this.sessionWatcher.flushSessionNoticeGroup();
  }

  open(): Promise<string> {
    this.opening ??= this.ensureCoordinator().finally(() => {
      this.opening = null;
    });
    return this.opening;
  }

  private async ensureCoordinator(): Promise<string> {
    let binding = this.repo.defaultBinding();
    if (!binding) {
      this.repo.reserveBinding({
        sessionId: `neo:${crypto.randomUUID()}`,
        projectId: null,
        kind: 'neo',
      });
      binding = this.repo.defaultBinding();
    }
    if (!binding) throw new Error('Could not reserve Neo context.');
    if (!this.db.getSession(binding.sessionId)) {
      const preference = this.modelPreference();
      await this.sessions.createSession({
        sessionId: binding.sessionId,
        title: 'Neo',
        workspacePath: neoFolderPath(),
        detectGit: false,
        config: {
          systemPrompt: neoPrompt(null, this.packBriefs()),
          sdkToolsPreset: neoCoordinatorNativeTools(),
          permissionMode: 'dontAsk',
          allowedTools: neoCoordinatorAllowedTools(),
          ...(preference
            ? {
                model: preference.model,
                provider: preference.provider as Provider,
                thinkingLevel: preference.thinkingLevel,
              }
            : {}),
        },
      });
    }
    await this.removeTurnLimit(binding.sessionId);
    return binding.sessionId;
  }

  private async removeTurnLimit(sessionId: string): Promise<void> {
    const session = this.db.getSession(sessionId);
    if (session?.config?.maxTurns !== undefined)
      await this.sessions.updateSession(sessionId, {
        config: { ...session.config, maxTurns: undefined },
      });
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
    if (work.report === NEO_WORK_RESERVED_WORKER) this.proposeStartQuestion(id);
    if (work.status === 'proposed' && this.proposalApproval(id) === false) return;
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
      await this.failWork(
        work,
        'Work handed to a chat no longer runs; add a todo with a target to run it.'
      );
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

  private startTarget(workId: string) {
    const work = this.repo.getWork(workId);
    return {
      workId,
      title: work?.title,
      target: JSON.stringify(
        this.driverTargets.get(workId) ??
          this.agentTargets.get(workId) ??
          work?.targetSessionId ??
          null
      ),
    };
  }

  proposalApproval(workId: string): boolean | null {
    const ask = this.askRecords.forWork(workId);
    const decision = ask && neoStartDecision(ask, this.startTarget(workId));
    return decision === null ? null : decision === 'approved';
  }

  readonly proposeStartQuestion = (superpipe({})('neo-proposal-start-question') as PipelineAPI)
    .input(['workId'])
    .pipe(
      (workId: string) => {
        const work = this.repo.getWork(workId);
        return work?.status === 'proposed' &&
          !['read', 'adopt'].includes(this.driverTargets.get(work.id)?.verb ?? '')
          ? work
          : null;
      },
      'workId',
      'proposal'
    )
    .pipe(
      (work: NeoWork | null) => {
        if (!work) return null;
        const existing = this.askRecords.forWork(work.id);
        if (existing) return existing;
        const goal = this.workGoals.get(work.id);
        const id = neoDerivedId(`neo-proposal-ask:${work.id}`);
        return this.askRecords.open(
          {
            id,
            requestKey: id,
            projectId: work.projectId,
            originSessionId: work.originSessionId,
            originMessageId: work.originMessageId,
            title: work.title,
            ask: goal?.goal ?? work.instruction,
            doneWhen: goal?.doneWhen ?? work.title,
            doneSource: 'proposal',
          },
          [{ text: goal?.doneWhen ?? work.title, check: null, deliveredBy: work.id }]
        );
      },
      'proposal',
      'ask'
    )
    .pipe(
      (ask: NeoAsk | null) =>
        ask &&
        planNeoStartQuestion(
          ask,
          ask.workIds
            .filter(
              (id) =>
                this.repo.getWork(id)?.status === 'proposed' &&
                !['read', 'adopt'].includes(this.driverTargets.get(id)?.verb ?? '')
            )
            .map((id) => this.startTarget(id))
        ),
      'ask',
      'question'
    )
    .pipe(
      (ask: NeoAsk | null, question: ReturnType<typeof planNeoStartQuestion>) => {
        if (ask && question) this.askRecords.proposeStartQuestion(ask.id, question, Date.now());
      },
      ['ask', 'question']
    )
    .end('question') as (workId: string) => ReturnType<typeof planNeoStartQuestion>;

  async answerStartQuestion(ask: NeoAsk, item: NeoAskItem, choice: string): Promise<void> {
    const targets = neoQuestionStartTargets(item);
    const ids = targets
      .filter((entry) => entry.target === this.startTarget(entry.workId).target)
      .map((entry) => entry.workId);
    if (!ids.length) return;
    if (neoStartChoice(item, choice) === 'approved') {
      this.askRecords.approve(ask.id, Date.now(), this.askRecords.get(ask.id)?.revision ?? 0);
      await this.startApprovedWork(ids);
    } else if (neoStartChoice(item, choice) === 'declined') {
      await Promise.all(ids.map((id) => this.cancel(id)));
    } else this.proposeStartQuestion(ids[0]);
  }

  async startApprovedWork(workIds: readonly string[]): Promise<void> {
    const startable = workIds.filter(
      (id) => this.repo.getWork(id)?.status === 'proposed' && this.resolveWorkTarget(id).accepted
    );
    await Promise.allSettled(startable.map((id) => this.admitWork(id, false)));
  }

  async admitWork(id: string, authorized: boolean, now = Date.now()) {
    const admitted = await admitNeoWork(id, authorized, now, {
      bootedAt: this.bootedAt,
      readWork: (workId: string) => this.repo.getWork(workId),
      readApproval: (workId: string) => this.proposalApproval(workId),
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

  cardWaits(
    workIds: readonly string[],
    now = Date.now(),
    workOf?: ReadonlyMap<string, NeoWork>
  ): NeoCardWait[] {
    const waiting = this.waitingCards();
    const auto = this.db.getGlobalSettings?.().neo?.autoDispatch === true;
    return workIds.flatMap((id) => {
      const blockers = waiting.get(id) ?? [];
      const status = (workOf ? workOf.get(id) : this.repo.getWork(id))?.status;
      const uncertain =
        ['proposed', 'queued', 'failed'].includes(status ?? '') &&
        this.driverTargets.readStartInterrupted(id);
      if (!blockers.length && !uncertain) return [];
      const authorized =
        this.proposalApproval(id) ??
        (this.dependencies.hasStartIntent(id) ||
          isNeoAdmissionApproved(this.askRecords.forWork(id), now));
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
    const changed = edited.ok && edited.revision !== expectedRevision;
    if (changed) this.dependencies.clearStartIntent(workId);
    return { ...edited, changed };
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
            this.db.getSDKMessageRepo().lastHumanPromptAt(work.originSessionId),
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
      start: async (next, target) => {
        this.proposeStartQuestion(next.id);
        if (this.proposalApproval(next.id) !== false)
          await this.startDriverWork(next, target, tried);
      },
      returnToNeo: async (next) => {
        await this.failWork(
          next,
          'Its session is archived, ended or taken, so it was not delivered; add a todo with a target to run it.'
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

  isRetryable(workId: string, work = this.repo.getWork(workId)): boolean {
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

  cardControlFailures(workIds: readonly string[]) {
    const rows = this.controlFailures.list(workIds);
    return workIds.flatMap((workId) => {
      const failure = neoControlFailureForRef(rows, workId, this.driverTargets.readRef(workId));
      return failure ? [{ workId, ...failure }] : [];
    });
  }

  private async stopDriverWork(ref: WorkRef, work: NeoWork): Promise<void> {
    const outcome = await this.invokeAsCard(work, 'work.stop', { ref }).catch(
      (error: unknown): OperationOutcome => ({
        kind: 'failed',
        code: 'execution_failed',
        message: error instanceof Error ? error.message : String(error),
      })
    );
    const failure = neoControlFailure('stop', outcome, Date.now());
    if (failure) this.controlFailures.record({ workId: work.id, ref, ...failure });
    else this.controlFailures.clear(work.id, ref, 'stop');
    this.notifyChanged();
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

  defaultSessionId(): string | undefined {
    return this.repo.defaultBinding()?.sessionId;
  }

  async openDefault(): Promise<string> {
    return (await openNeoDefaultSession(this.repo, () => this.open())).sessionId;
  }

  async recover(): Promise<void> {
    this.sessionWatcher.loadSessionNoticeGroups();
    this.initializeTriggerFacts();
    for (const binding of [this.repo.defaultBinding(), ...this.repo.listProjectBindings()])
      if (binding) await this.removeTurnLimit(binding.sessionId);
    await this.recoverConsultations();
    await this.clearStaleNeedsYou().catch((error) =>
      this.log.warn('Stale needs_you check pending', error)
    );
    for (const work of this.repo.listWork()) {
      try {
        const recovered = await this.recoverHandoff(work);
        if (!recovered && work.status === 'queued' && this.driverTargets.get(work.id))
          await this.start(work.id);
        else if (
          !recovered &&
          this.driverTargets.get(work.id) &&
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
    const unprocessed = new Set<string>();
    for (const { work, ref } of cards) {
      if (work.status !== 'queued') continue;
      await this.settleDriverWork(work, ref).catch((error) => {
        unprocessed.add(work.id);
        this.log.warn('Driver work refresh pending', error);
      });
    }
    try {
      this.endUnfollowedCardTopics(Date.now());
    } catch (error) {
      this.log.warn('Card event subscription sweep pending', error);
    }
    await this.todoRunner.refresh((message, error) => this.log.warn(message, error));
    for (const workId of this.packEvidenceWorkIds()) {
      this.followCardTopics(workId);
      await this.relayCardPr(workId).catch((error) =>
        this.log.warn('Card pull request relay pending', error)
      );
    }
    this.forgetUnfollowedAskTopics();
    for (const ask of this.askRecords.listLive()) {
      this.writeAskStatus(ask);
      this.followAskTopics(ask);
      try {
        this.runAskPackTicks(ask.id);
      } catch (error) {
        for (const id of ask.workIds) unprocessed.add(id);
        this.log.warn('Neo ask ticks pending', error);
      }
      await this.runAskReadTicks(this.askRecords.get(ask.id) ?? ask).catch((error) => {
        for (const id of ask.workIds) unprocessed.add(id);
        this.log.warn('Neo ask read ticks pending', error);
      });
      await this.checkAskEvidence(ask, Date.now()).catch((error) =>
        this.log.warn('Ask evidence check pending', error)
      );
    }
    this.settledReports = planNeoSettledReports(
      this.askRecords
        .listLive()
        .flatMap((ask) => ask.workIds.flatMap((id) => this.repo.getWork(id) ?? [])),
      unprocessed
    );
    this.scheduleTriggerSweep();
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
    return this.todos.listCheckable().map((todo) => todo.id);
  }

  private followedTodo(workId: string): NeoWork | null {
    const todo = this.todos.getTodo(workId);
    const ask = todo ? this.todos.getAsk(todo.askId) : null;
    return todo &&
      ask &&
      ask.status !== 'dropped' &&
      ((ask.status === 'open' && (todo.state === 'todo' || todo.state === 'doing')) ||
        (todo.state === 'done' && this.todoPrs.prs(workId).some((pr) => pr.state === 'MERGED')))
      ? neoTodoCard(todo, ask)
      : null;
  }

  async trackSession(root: string, notice: NeoSessionNotice, now: number): Promise<{ ok: true }> {
    const tracked = keepNeoTrackedSessions(this.trackedSessions, notice.key, now);
    this.trackedSessions = tracked;
    const messageId = `neo-track:${notice.key}:${tracked.get(notice.key)}`;
    const done = 'The session finishes its work';
    const ask = this.askRecords.open(
      {
        id: crypto.randomUUID(),
        requestKey: messageId,
        projectId: NEO_INBOX_ID,
        originSessionId: root,
        originMessageId: messageId,
        title: notice.title,
        ask: `See ${notice.title} through.`,
        doneWhen: `- ${done}`,
        doneSource: 'human',
      },
      [{ text: done, check: null }]
    );
    if (ask) this.askRecords.approve(ask.id, now, ask.revision ?? 0);
    const content = fillPrompt(NEO_SESSION_TRACK, {
      title: JSON.stringify(notice.title),
      ref: JSON.stringify(notice.ref),
      askId: JSON.stringify(ask?.id ?? null),
    });
    await this.deliver(root, messageId, content, root);
    return { ok: true };
  }

  followedCardRefs(_now: number): WorkRef[] {
    return this.packEvidenceWorkIds().flatMap((id) => this.todoSessions.readRef(id) ?? []);
  }

  private readonly relayCardPr = (superpipe({})('neo-card-pr-relay') as PipelineAPI)
    .input(['workId'])
    .pipe((workId: string) => this.followedTodo(workId), 'workId', 'work')
    .pipe((workId: string) => neoCardPrAttention(this.todoPrs.prs(workId)), 'workId', 'read')
    .pipe(
      (workId: string, read: NeoPackCardAttention) => {
        if (!read.attention && !read.pending) this.cardPrRelays.clear(workId);
        return read.attention ? this.cardPrRelays.get(workId) : null;
      },
      ['workId', 'read'],
      'told'
    )
    .pipe(
      (work: NeoWork | null, read: NeoPackCardAttention, told: string | null) =>
        requireNeoCardAttentionRelay(work, read.attention, told),
      ['work', 'read', 'told'],
      'result:relay'
    )
    .pipe(
      async (work: NeoWork, relay: { signature: string; message: string }) => {
        const sent = await this.todoRunner.proceed(work.id, relay.message);
        if (sent.ok) {
          this.cardPrRelays.markTold(work.id, relay.signature, Date.now());
          return sent;
        }
        const note = neoCardAttentionNeoNote(work, relay.message, sent.reason);
        if (!note || !this.db.getSession(work.originSessionId)) return sent;
        await this.deliverForward(
          work.originSessionId,
          `neo-card-pr:${work.id}:${hashString32(relay.signature).toString(36)}`,
          note,
          work.originSessionId,
          neoWorkParent(work),
          'continues'
        );
        this.cardPrRelays.markTold(work.id, relay.signature, Date.now());
        return sent;
      },
      ['work', 'relay'],
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
          neoAskProgressNote(ask, NEO_ASK_STALLED, {
            cards: read.cards.map(({ id, title, status }) => ({ id, title, status })),
            ...(read.newer ? { replacedBy: read.newer } : {}),
          }),
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
          neoAskProgressNote(ask, NEO_ASK_IDLE, {
            cards: read.cards.map(({ id, title, status }) => ({ id, title, status })),
          }),
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
          neoAskProgressNote(check, NEO_ASK_EVIDENCE, {
            summary: check.outcome,
            changed: note.evidence.map(({ key, summary }) => ({ key, summary })),
          }),
          neoAskParent(check)
        );
        this.askChecks.markTold(check.id, note.signature, Date.now());
      },
      ['check', 'note']
    )
    .endAsync('note') as (ask: NeoAsk, now: number) => Promise<unknown>;

  private readonly refreshWorkPrs = (superpipe({})('neo-work-pr-refresh') as PipelineAPI)
    .input(['workId', 'now', 'changedAt'])
    .pipe((workId: string) => ({ work: this.repo.getWork(workId) }), 'workId', 'current')
    .pipe(requireNeoWorkPrCurrent, 'current', 'result:refresh')
    .pipe(
      (refresh: { work: NeoWork }, changedAt: number | undefined) => {
        const ask = this.askRecords.forWork(refresh.work.id);
        return {
          ask,
          goal: neoWorkDoneGoal(refresh.work.id, this.workGoals.get(refresh.work.id), ask),
          row: this.workPrs.get(refresh.work.id),
          session: !!this.db.getSession(refresh.work.originSessionId),
          packEvidence: this.askPackReadsReport(ask),
          toldAt: this.workChecks.get(refresh.work.id)?.toldAt ?? null,
          doneWhenMet: isNeoCardDoneWhenMet(refresh.work, ask),
          changedAt: changedAt ?? null,
        };
      },
      ['refresh', 'changedAt'],
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
          },
          card.changedAt
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
    now: number,
    changedAt?: number
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
      neoAskParent(ask),
      'continues'
    );
  }

  packBriefing(ask: NeoAsk): string | undefined {
    return ask.pack ? (this.pack(ask.pack)?.instructions(ask) ?? undefined) : undefined;
  }

  packBriefs(): NeoPackBrief[] {
    return neoPackBriefs(neoEnabledPacks(this.db.getGlobalSettings?.().neo), this.installedPacks());
  }

  askPackFragment(ask: NeoAsk | null | undefined): NeoPackFragment | null {
    return neoPackFragment(ask, this.installedPacks());
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
    const todo = this.todos.getTodo(workId);
    if (!todo || !this.followedTodo(workId)) return;
    const topics = this.packs().flatMap((pack) => pack.todos?.topics(todo) ?? []);
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
            (workId) => [workId, !!this.followedTodo(workId) && this.cardEventsDelivered()] as const
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
    return this.packs().some((pack) => !!pack.todos);
  }

  followedTopics(): { topic: string; session: string | null }[] {
    return [
      ...this.cardEvents.listActive().map((row) => ({
        topic: row.topic,
        session: neoCardWorkerSession(
          planNeoCardSend({
            work: this.followedTodo(row.workId),
            ref: this.todoSessions.readRef(row.workId),
          })
        ),
      })),
      ...neoPackAskTopics(this.packs(), this.askRecords.listLive()).map((topic) => ({
        topic,
        session: null,
      })),
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
        this.todoRunner.checkNow(
          this.packs().flatMap((pack) => pack.todos?.event(event) ?? []),
          (message, error) => this.log.warn(message, error)
        ),
      'event',
      'checked'
    )
    .pipe(
      (event: ExternalEvent) =>
        planNeoCardEventRoute(this.packs(), event, this.cardEvents.listActive()),
      'event',
      'result:route'
    )
    .pipe(
      async (event: ExternalEvent, route: NeoPackEventRoute) => {
        const delivered: string[] = [];
        const sends = planNeoCardEventSends(route.workIds, (workId) =>
          planNeoCardSend({
            work: this.followedTodo(workId),
            ref: this.todoSessions.readRef(workId),
          })
        );
        for (const send of sends)
          if (
            await this.sendToCard(
              send.workIds[0],
              `neo-card-event:${send.target}:${event.id}`,
              sessionEventText(event)
            ).catch((error) => {
              this.log.warn('Card event not delivered', error);
              return false;
            })
          )
            delivered.push(...send.workIds);
        return delivered;
      },
      ['event', 'route'],
      'delivered'
    )
    .pipe(
      (route: NeoPackEventRoute) =>
        planNeoProjectEventHolders(
          route.workIds.flatMap((id) => {
            const todo = this.todos.getTodo(id);
            const work = this.followedTodo(id);
            const ask = todo ? this.todos.getAsk(todo.askId) : null;
            return work
              ? [
                  {
                    projectId: work.projectId,
                    owner: ask?.projectId ?? null,
                  },
                ]
              : [];
          })
        ),
      'route',
      'holders'
    )
    .pipe(
      async (event: ExternalEvent, holders: string[]) => {
        for (const projectId of holders)
          await this.open()
            .then((holder) =>
              this.deliver(
                holder,
                neoProjectEventMessageId(projectId, event.id),
                `${NEO_PROJECT_EVENT_NOTE}\n${sessionEventText(event)}`,
                holder
              )
            )
            .catch((error) => this.log.warn('Project event not delivered', error));
      },
      ['event', 'holders']
    )
    .pipe(async (delivered: string[]) => {
      await this.todoRunner.refresh((message, error) => this.log.warn(message, error));
      for (const workId of delivered) {
        const told = neoCardPrAttention(this.todoPrs.prs(workId), false).attention;
        if (told) this.cardPrRelays.markTold(workId, told.signature, Date.now());
      }
    }, 'delivered')
    .pipe((route: NeoPackEventRoute) => {
      for (const row of route.ending) this.cardEvents.end(row.workId, row.topic, Date.now());
    }, 'route')
    .endAsync('route') as (payload: ExternalEventPublishedPayload) => Promise<unknown>;

  async sendToCard(workId: string, key: string, text: string): Promise<boolean> {
    const work = this.followedTodo(workId);
    const send = planNeoCardSend({ work, ref: this.todoSessions.readRef(workId) });
    if (!work || send.via === 'none') return false;
    if (send.via === 'session') {
      await this.deliver(send.sessionId, key, text, work.originSessionId);
      return true;
    }
    const sent = await this.invokeAsCard(work, 'work.send', { ref: send.ref, message: text });
    return sent.kind === 'completed' && (sent.value as { ok?: unknown } | null)?.ok === true;
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
    await this.wakeCards(
      [work.id],
      work.originSessionId,
      neoStallMessageId(work.id, live.lastActivityAt),
      driverStallNote(
        work,
        this.askRecords.forWork(work.id),
        this.workDoneGoal(work.id),
        live.lastReply
      ),
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
        this.askRecords.forWork(work.id),
        this.workDoneGoal(work.id),
        work.updatedAt,
        now,
        reminder.abandoned
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
            driverNeedsYouNote(work, card.ask, ref, card.state?.lastReply),
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
                    stalled: false,
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
    else if (ticked) this.writeAskStatus(ticked);
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
    const conversation = this.repo.conversationId();
    return conversation ? neoForwardedText(this.asks.find(conversation, ask.messageId), ask) : null;
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
          `All assigned cross-project owners have returned for this original human ask.\n${JSON.stringify({ humanMessageId: group.askMessageId, parts: JSON.parse(group.partsJson), results: members })}`,
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

  async syncConsultation(id: string): Promise<void> {
    let item = this.consultations.get(id);
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
        await this.open();
        const content = neoConsultationRequestContent(
          item,
          !!this.crossProjects.forReceipt(item.id),
          this.crossProjects.forReceipt(item.id)?.askMessageId
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
    if (item.status === 'pending') return;
    if (
      !(neoReviewWorkId(id) && item.originSessionId === item.sessionId) &&
      !this.consultations.isReturned(id) &&
      !this.consultations.wasPublished(id) &&
      !(item.status === 'reported' && item.answer === NEO_WORK_REVIEWED)
    ) {
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
          })
        ),
      }),
      'work',
      'told'
    )
    .pipe(requireNeoWorkReturnUntold, 'told', 'result:recover')
    .pipe((work: NeoWork) => this.returnReport(work), 'work')
    .endAsync('recover') as (work: NeoWork) => Promise<unknown>;

  private readonly readEnvironmentMove = (superpipe({})('neo-environment-move') as PipelineAPI)
    .input(['work'])
    .pipe((work: NeoWork) => readNeoWorkBlocker(work.report), 'work', 'blocker')
    .pipe((work: NeoWork) => this.driverTargets.get(work.id), 'work', 'target')
    .pipe(
      (work: NeoWork, blocker: NeoWorkBlocker | null, target: NeoDriverTarget | null) =>
        blocker?.kind === 'environment' && target?.verb === 'start'
          ? readNeoDriverAdapters(() =>
              invokeOperation(
                this.sessions.getOperationRegistry(),
                'work.adapters',
                { daemon: driverTargetDaemon(target) },
                driverWorkCaller(work)
              )
            )
          : null,
      ['work', 'blocker', 'target'],
      'adapters'
    )
    .pipe(planNeoEnvironmentMove, ['blocker', 'target', 'adapters'], 'result:move')
    .endAsync('move') as (work: NeoWork) => Promise<NeoEnvironmentMove | null>;

  async environmentMoveNote(work: NeoWork): Promise<string> {
    return neoEnvironmentMoveNote(await this.readEnvironmentMove(work));
  }

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
    const packLine = packNote ? `\n${fillPrompt(NEO_WORK_PACK_NOTE, { pack: packNote.id })}\n` : '';
    const move = await this.environmentMoveNote(work);
    const content = `${fillPrompt(NEO_WORK_RETURNED, { retry: retryNote })}${move}${packLine}\n${JSON.stringify({ workId: work.id, originSessionId: work.originSessionId, originMessageId: work.originMessageId, projectId: work.projectId, status: work.status, executionSessionId: work.sessionId, title: work.title, report: work.report })}`;
    const messageId = neoWorkReturnMessageId(
      work.id,
      retries,
      this.workContinues.get(work.id)?.count ?? 0
    );
    const target = work.originSessionId;
    if (!this.db.getSession(target)) return;
    const fresh = !this.hasDelivery(target, messageId);
    await this.deliver(
      target,
      messageId,
      content,
      work.sessionId ?? work.originSessionId,
      neoWorkParent(work)
    );
    if (fresh) this.recordCardWake(work.id, messageId);
  }

  private async cardPrCandidates(
    work: NeoWork,
    stored: { prs: readonly NeoWorkPr[] } | null
  ): Promise<NeoCardPrCandidate[]> {
    const ref = this.driverTargets.readRef(work.id);
    const sent = neoCardSent(this.driverTargets.readSent(work.id), work);
    const outcome =
      ref && sent
        ? await this.invokeAsCard(work, 'work.status', { ref, since: sent.inputBefore })
        : null;
    const exchange = outcome ? readDriverCardExchange(outcome, sent) : null;
    const cwd = currentCodingExecutionDirectory(
      ref,
      outcome,
      hostname(),
      exchange?.current === true
    );
    const worker = neoCardWorkerSession(planNeoCardSend({ work, ref }));
    const window = neoCardPrWindow(work, this.repo.workStartedAt(work.id));
    return planNeoCardPrCandidates({
      window,
      report: work.report,
      follows: work.follows,
      subscribed: worker
        ? this.sessionSubscriptions
            .listBySession(worker)
            .filter((row) => row.createdAt >= window.start)
            .flatMap((row) => pullRequestUrlOfTopic(row.topic) ?? [])
        : [],
      branch: cwd ? await this.readCheckoutPrs(cwd) : await this.branchPrUrls(work.id),
      opened: this.cardOpenedPrs.get(work.id) ?? [],
      stored: stored?.prs ?? [],
      rejected: this.workPrClaims.rejectedUrls(work.id),
      mentioned: await this.cardPrRefs(work, outcome),
    });
  }

  private async cardPrRefs(work: NeoWork, outcome: OperationOutcome | null): Promise<string[]> {
    const ref = this.driverTargets.readRef(work.id);
    const localId = localCodingSessionId(ref);
    const cwd =
      neoWorkRepoCwd(localId ? this.db.getSession(localId) : null) ??
      localCodingExecutionDirectory(ref, outcome, hostname());
    return readCodingCardRefs(
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
    return ticked ? this.writeAskStatus(ticked) : ask;
  }

  writeAskStatus(ask: NeoAsk, outcome?: string): NeoAsk {
    const cards = ask.workIds.flatMap((id) => this.repo.getWork(id) ?? []);
    const plan = planNeoAskTickStatus(ask, {
      cardLive: neoAskLiveOutcomeCards(ask, cards).length > 0,
      outcome,
      changes: this.askRecords.itemChanges(ask.id),
    });
    const written = writeNeoAskTickStatus(this.askRecords, ask, plan);
    if (plan.status === 'achieved' && written)
      for (const stop of planNeoAskWorkStops(cards, 'achieved'))
        void this.close(stop.id, stop.close).catch((error) =>
          this.log.warn(`Closing card ${stop.id} after its ask was met failed`, error)
        );
    return written ?? ask;
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
    .pipe(async (work: NeoWork) => ({ note: await this.environmentMoveNote(work) }), 'work', 'move')
    .pipe(
      (
        work: NeoWork,
        goal: NeoWorkGoal,
        found: NeoDoneCheckFound,
        options: NeoDoneCheckDelivery,
        current: { ask: NeoAsk | null },
        move: { note: string }
      ) => {
        const continued = this.workContinues.get(work.id)?.count ?? 0;
        return {
          id: neoDoneCheckMessageId(work.id, continued, found.row?.revision, options.followedAt, 0),
          content: driverDoneCheckNote(work, goal, continued, {
            continuation: neoContinueFacts(
              this.continueDeps.readTurn(work, { guarded: false, human: false }),
              this.workContinues.get(work.id)
            ),
            facts: neoPackCardFacts(this.installedPacks(), work.id, options.stale ?? false),
            ask: current.ask,
            pack: this.askPackFragment(current.ask),
            cards: current.ask
              ? projectNeoAskCards(
                  work.id,
                  current.ask.workIds.flatMap((id) => this.repo.getWork(id) ?? []),
                  this.workPrs.list(current.ask.workIds)
                )
              : [],
            move: move.note,
          }),
        };
      },
      ['work', 'goal', 'found', 'options', 'current', 'move'],
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

  isDelivering(sessionId: string, messageId: string): boolean {
    return this.deliveries.has(`${sessionId}:${messageId}`);
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
    content: MailboxMessageContent,
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
  ): boolean {
    const to = {
      projectId: owner.projectId,
      originSessionId: owner.sessionId,
      originMessageId: owner.messageId,
    };
    return this.db.getDatabase().transaction(() => {
      if (!this.askRecords.moveTo(ask, to)) return false;
      this.repo.moveWork(
        cards.map((card) => card.id),
        to
      );
      return true;
    })();
  }

  logReorganize(line: string): void {
    this.log.info(line);
  }

  private deliver(
    sessionId: string,
    messageId: string,
    content: MailboxMessageContent,
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
    const origin = (parent ? this.resolveAskOrigin(parent) : null) ?? input;
    const triggerId = neoDeliveryTrigger(trigger, () => this.parentTrigger(parent));
    this.inputOrigins.record(input, origin, Date.now(), triggerId);
  }

  ownsHumanMessage(caller: OperationCaller): boolean {
    const turn = caller.neoTurn;
    if (!turn || !caller.sessionId) return false;
    const ask = this.resolveAskOrigin({ sessionId: caller.sessionId, messageId: turn.messageId });
    const delivered = (ask ? this.askForwards.list(ask) : []).filter(
      (forward) =>
        !!ask && this.hasDelivery(forward.toSessionId, neoForwardMessageId(ask, forward.hop))
    );
    return neoTurnOwnsMessage(caller.sessionId, turn, delivered);
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

  consultationFor(origin: NeoAskOrigin, projectId: string): NeoConsultation | null {
    const ask = this.resolveAskOrigin(origin) ?? origin;
    return (
      this.consultations.startedBy(origin.sessionId, projectId).find((item) => {
        if (!item.originMessageId) return false;
        const input = { sessionId: item.originSessionId, messageId: item.originMessageId };
        const previous = this.resolveAskOrigin(input) ?? input;
        return previous.sessionId === ask.sessionId && previous.messageId === ask.messageId;
      }) ?? null
    );
  }

  async steerHumanMessages(sessionId: string): Promise<void> {
    if (this.repo.defaultBinding()?.sessionId !== sessionId) return;
    const status =
      this.processingStatus.get(sessionId) ??
      neoSessionStatus(this.db.getSession(sessionId)?.processingState);
    if (status !== 'processing') return;
    const queued = this.db.getSDKMessageRepo().listQueuedInputs(sessionId, 'human');
    if (!queued.length) return;
    try {
      const live = await this.sessions.getSessionForControl(sessionId);
      for (const { uuid } of queued) live?.steerNeoInput(uuid);
    } catch (error) {
      this.log.warn('Human message not steered into the running Neo turn', error);
    }
  }

  private parentTrigger(parent: NeoAskOrigin | null): string | null {
    return parent ? this.inputTrigger(parent) : null;
  }

  private async enqueueDelivery(
    sessionId: string,
    messageId: string,
    content: MailboxMessageContent,
    originSessionId: string
  ): Promise<void> {
    const queue = this.db.getJobQueueRepo();
    if (this.db.getSDKMessageRepo().findMessageIdByUuid(sessionId, messageId)) return;
    if (
      queue.listActiveByPayload('mailbox', { 'to.sessionId': sessionId, messageUuid: messageId })
        .length
    )
      return;
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
