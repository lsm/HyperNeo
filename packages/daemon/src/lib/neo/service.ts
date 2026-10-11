import {
  fillPrompt,
  NEO_WORK_DELEGATED,
  NEO_WORK_PACK_NOTE,
  NEO_WORK_RETURNED,
  NEO_WORK_RETURNED_RETRIED,
  NEO_WORK_RETURNED_RETRY,
} from '@hyperneo/prompts';
import type { GlobalSettings, MessageHub, Provider } from '@hyperneo/shared';
import type { SDKMessage } from '@hyperneo/shared/sdk';
import { type NeoModelPreference, neoStandingRules } from '@hyperneo/shared/types/settings';
import type { NeoConsultation, NeoWork } from '@hyperneo/shared/types/neo-context';
import type { NeoPublicationInput } from '@hyperneo/shared/types/neo-publication';
import {
  NEO_ASK_CONTINUE_LIMIT,
  NEO_WORK_CLOSED_DONE,
  type NeoAsk,
  type NeoAskSessionView,
  type NeoWorkGoal,
  type NeoWorkPr,
} from '@hyperneo/shared/types/neo-snapshot';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { Database } from '../../storage/database.ts';
import type { OperationCaller } from '../operations/registry.ts';
import { DaemonInventoryRepository } from '../../storage/repositories/daemon-inventory-repository.ts';
import { NeoAgentWorkTargetRepository } from '../../storage/repositories/neo-agent-work-target-repository.ts';
import { NeoAskRepository } from '../../storage/repositories/neo-ask-repository.ts';
import { NeoInputOriginRepository } from '../../storage/repositories/neo-input-origin-repository.ts';
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
import { NeoWorkContinueRepository } from '../../storage/repositories/neo-work-continue-repository.ts';
import { NeoWorkSupersessionRepository } from '../../storage/repositories/neo-work-supersession-repository.ts';
import { NeoWorkGoalRepository } from '../../storage/repositories/neo-work-goal-repository.ts';
import { planNeoAskTickStatus, writeNeoAskTickStatus } from './ask-operations.ts';
import { NeoWorkPrRepository, type NeoWorkPrRow } from './packs/coding/neo-work-pr-repository.ts';
import { NeoWorkResourceRepository } from '../../storage/repositories/neo-work-resource-repository.ts';
import type { PlaceGroup, WorkRef, WorkStatus } from '../drivers/types.ts';
import type { DaemonInternalEventMap, InternalEventBus } from '../internal-event-bus.ts';
import { Logger } from '../logger.ts';
import { renderAddress } from '../mailbox/address.ts';
import { handoffPromptToMailbox } from '../mailbox/handoff.ts';
import { invokeOperation, type OperationOutcome } from '../operations/invoke.ts';
import type { SessionManager } from '../session/session-manager.ts';
import {
  createNeoAskOriginResolver,
  neoAskEvidenceMessageId,
  neoAskParent,
  neoConsultationParent,
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
  publishNeoDirectReplyFallback,
} from './direct-reply-fallback.ts';
import {
  driverStartedReport,
  driverWorkCall,
  driverWorkCaller,
  type DriverSent,
  type NeoDriverTarget,
  readDriverOutcome,
  readDriverSendBaseline,
  neoCardSent,
  readDriverSent,
  messageOpening,
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
  readDriverLastInputAt,
  readDriverLive,
  readDriverOpenedPrs,
  requireNeoWorkRetryable,
  type NeoWorkRetryCard,
  withWorkGoal,
  readNeoWorkContinueBudget,
} from './driver-work.ts';
import {
  admitNeoWorkContinue,
  type NeoContinueDeps,
  type NeoContinueResult,
  sendNeoWorkContinue,
} from './continue-work.ts';
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
import { neoCoordinatorAllowedTools, neoCoordinatorNativeTools } from './session-policy.ts';
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
  neoWorkBranch,
  neoWorkRepoCwd,
  readGithubBranchPrs,
  readGithubWorkRepo,
  type NeoBranchPrReader,
  type NeoWorkRepoReader,
} from './packs/coding/branch-prs.ts';
import { planNeoCardPrCandidates, type NeoCardPrCandidate } from './packs/coding/card-pr-claims.ts';
import { NeoWorkPrClaimRepository } from './packs/coding/neo-work-pr-claim-repository.ts';
import { planNeoCardCheck } from './card-check.ts';
import {
  CODING_PACK_BRIEF,
  createCodingPack,
  type NeoCardPrDeps,
  readNeoCardPrs,
} from './packs/coding/pack.ts';
import { createLifeAdminPack } from './packs/life-admin/pack.ts';
import {
  neoEnabledPacks,
  neoPackBriefs,
  neoPackAskCardEvidence,
  neoPackChecks,
  neoPackEvidenceOrNone,
  neoPackFragment,
  neoPacks,
  planNeoPackTicks,
  readNeoAskPackEvidence,
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
import {
  keepNeoSessionNoticeGroups,
  keepNeoSessionNotices,
  listNeoWatchedSessions,
  neoSessionNoticeGroup,
  planNeoSessionNotice,
  planNeoSessionNoticeGroup,
  planNeoSessionWatch,
  savedNeoSessionNoticeGroups,
  NEO_SESSION_GROUPS_MAX,
  NEO_SESSION_WATCH_LIMIT,
  type NeoListedSession,
  type NeoSessionNotice,
  type NeoSessionNoticeGroup,
  type NeoSessionSeen,
} from './session-watch.ts';
import {
  describeNeoAskSessions,
  keepNeoSessionPrs,
  linkNeoSessionsToAsks,
  neoAskPrKeys,
  type NeoAskPrs,
  type NeoSessionAskLink,
  planNeoHeldSessionNotices,
  planNeoSessionPrReads,
} from './session-ask-links.ts';
import {
  neoAskEvidenceNote,
  planNeoAskEvidenceNote,
  requireNeoAskEvidenceDue,
} from './ask-evidence.ts';
import { neoAskStalledNote, requireNeoAskStalled, requireNeoAskStallUntold } from './ask-stall.ts';
import {
  extractNeoCardRefs,
  readGithubRefStates,
  readNeoPrRefUrls,
  type NeoRefStateReader,
} from './packs/coding/ask-prs.ts';
import {
  NeoAskCheckRepository,
  type NeoAskCheckRow,
} from '../../storage/repositories/neo-ask-check-repository.ts';
import { planNeoNeedsYou } from './needs-you.ts';
import {
  NEO_WORK_FOLLOW_MAX_AGE_MS,
  planNeoWorkFollow,
  planNeoWorkFollowLive,
  requireNeoWorkFollow,
  requireNeoWorkFollowAnswered,
  requireNeoWorkFollowUp,
} from './work-follow.ts';

const dispatchNeoConsultationWaiter = (
  superpipe({})('neo-consultation-waiter-dispatch') as PipelineAPI
)
  .input(['service', 'concernId'])
  .pipe(
    (service: NeoService, concernId: string) => {
      const item = service.consultationWaiters.admitNext(concernId);
      return item ? { value: item } : { reason: null };
    },
    ['service', 'concernId'],
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
const NEO_WORK_REPORT_LIMIT = 12_000;

type NeoWorkPrCard = {
  ask: NeoAsk | null;
  goal: NeoWorkGoal | null;
  row: NeoWorkPrRow | null;
  session: boolean;
  packEvidence: boolean;
  toldAt: number | null;
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
  ready?: boolean;
  remind?: boolean;
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

export class NeoService {
  readonly repo: NeoRepository;
  readonly publications: NeoPublicationRepository;
  readonly asks: NeoConversationAskRepository;
  readonly publish: ReturnType<typeof createNeoPublisher>;
  readonly agentTargets: NeoAgentWorkTargetRepository;
  readonly driverTargets: NeoWorkDriverTargetRepository;
  readonly workGoals: NeoWorkGoalRepository;
  readonly workContinues: NeoWorkContinueRepository;
  readonly workSupersessions: NeoWorkSupersessionRepository;
  readonly askRecords: NeoAskRepository;
  readonly workPrs: NeoWorkPrRepository;
  readonly workPrClaims: NeoWorkPrClaimRepository;
  readonly workChecks: NeoWorkCheckRepository;
  readonly askChecks: NeoAskCheckRepository;
  private readonly askEvidenceReads = new Map<string, number>();
  private readonly sessionsSeen = new Map<string, NeoSessionSeen>();
  private sessionPrs = new Map<string, string[]>();
  private heldSessionNotices = new Map<string, NeoSessionNotice>();
  askSessions = new Map<string, NeoAskSessionView[]>();
  sessionNotices: NeoSessionNotice[] = [];
  sessionNoticeGroups: NeoSessionNoticeGroup[] = [];
  private openSessionNotices: NeoSessionNotice[] = [];
  private watching: Promise<unknown> | null = null;
  private disposed = false;
  filePacks: readonly NeoPack[] = [];
  private readonly builtinPacks: NeoPack[];
  readPrs: NeoWorkPrReader = readGithubPrs;
  readBranchPrs: NeoBranchPrReader = readGithubBranchPrs;
  readWorkRepo: NeoWorkRepoReader = readGithubWorkRepo;
  readRefStates: NeoRefStateReader = readGithubRefStates;
  readonly consultations: NeoConsultationRepository;
  readonly consultationWaiters: NeoConsultationWaiterRepository;
  readonly reportWork: ReturnType<typeof createNeoWorkReporter>;
  readonly resolveAskOrigin: ReturnType<typeof createNeoAskOriginResolver>;
  private readonly inputOrigins: NeoInputOriginRepository;
  readonly resolveWorkTarget: ReturnType<typeof createNeoWorkTargetResolver>;
  readonly notifyChanged: () => void;
  private readonly announceSessionNotice: (notice: NeoSessionNotice) => void;
  private readonly announceSessionNoticeGroup: (group: NeoSessionNoticeGroup) => void;
  private readonly pending = new Map<string | null, Promise<string>>();
  private readonly workPending = new Map<string, Promise<void>>();
  private readonly deliveries = new Map<string, Promise<void>>();
  private readonly processingStatus = new Map<string, string>();
  private readonly interruptedSessions = new Set<string>();
  private readonly continuing = new Set<string>();
  private readonly activitySeen = new Map<string, { at: number; seenAt: number }>();
  private readonly followReads = new Map<string, number>();
  private readonly followWork = (superpipe({})('neo-work-follow') as PipelineAPI)
    .input(['work', 'now'])
    .pipe(
      (work: NeoWork) => {
        const driver = this.driverTargets.readCard(work.id);
        return {
          ref: driver?.ref ?? null,
          goal: !!this.workDoneGoal(work.id)?.doneWhen,
          ask: this.askRecords.forWork(work.id),
          readAt: this.followReads.get(work.id) ?? null,
          since: driver?.followAnchor ?? work.updatedAt,
          superseded: this.driverTargets.readSupersededAt(work.id) !== null,
          live: driver?.liveStatus ?? null,
        };
      },
      'work',
      'card'
    )
    .pipe(requireNeoWorkFollow, ['work', 'card', 'now'], 'result:follow')
    .pipe(
      async (work: NeoWork, ref: WorkRef, now: number, card: { since: number }) => {
        this.followReads.set(work.id, now);
        return {
          outcome: await invokeOperation(
            this.sessions.getOperationRegistry(),
            'work.status',
            { ref, since: card.since },
            driverWorkCaller(work)
          ),
        };
      },
      ['work', 'follow', 'now', 'card'],
      'read'
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
        if (live?.status !== 'needs_you') return;
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
          this.toldDoneCheck(work, neoDoneCheckToldIds(work, card.continued, undefined, followed)),
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
            neoDoneCheckToldIds(work, card.continued, found.row.revision, false)
          ),
      }),
      ['work', 'card', 'followed', 'found'],
      'reread'
    )
    .pipe(requireNeoDoneCheckUntold, ['reread', 'check'], 'result:check')
    .pipe(requireNeoDoneCheckDue, ['found', 'check'], 'result:check')
    .pipe(
      async (
        work: NeoWork,
        goal: NeoWorkGoal,
        card: NeoDoneCheckCard,
        found: NeoDoneCheckRead,
        followed: boolean
      ) => {
        await this.deliverDoneCheck(work, goal, found.row, {
          ask: card.ask,
          stale: found.stale,
          followedAt: followed ? work.updatedAt : undefined,
          signature: found.read ? neoEvidenceSignature(found.read.evidence) : undefined,
        });
        return 'checked' as const;
      },
      ['work', 'check', 'card', 'found', 'followed'],
      'check'
    )
    .endAsync('check') as (
    work: NeoWork,
    followed: boolean
  ) => Promise<'checked' | NeoDoneCheckSkip>;
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
    this.announceSessionNotice = (notice) => hub.event('neo.session.notice', notice);
    this.announceSessionNoticeGroup = (group) => hub.event('neo.session.notices', { group });
    this.notifyChanged = () => {
      hub.event('neo.changed', {});
    };
    this.repo = new NeoRepository(db.getDatabase(), () => hub.event('neo.changed', {}));
    this.publications = new NeoPublicationRepository(db.getDatabase());
    this.asks = new NeoConversationAskRepository(db.getDatabase());
    this.agentTargets = new NeoAgentWorkTargetRepository(db.getDatabase());
    this.driverTargets = new NeoWorkDriverTargetRepository(db.getDatabase());
    this.workGoals = new NeoWorkGoalRepository(db.getDatabase());
    this.workContinues = new NeoWorkContinueRepository(db.getDatabase());
    this.workSupersessions = new NeoWorkSupersessionRepository(db.getDatabase());
    this.askRecords = new NeoAskRepository(db.getDatabase(), () => hub.event('neo.changed', {}));
    this.workPrs = new NeoWorkPrRepository(db.getDatabase());
    this.workPrClaims = new NeoWorkPrClaimRepository(db.getDatabase());
    this.workChecks = new NeoWorkCheckRepository(db.getDatabase());
    this.askChecks = new NeoAskCheckRepository(db.getDatabase());
    this.builtinPacks = [
      createCodingPack({
        ...this.cardPrDeps,
        runningPrUrls: (workIds) => this.runningPrUrls(workIds),
        readRefStates: (refs) => this.readRefStates(refs),
      }),
      createLifeAdminPack(),
    ];
    this.consultations = new NeoConsultationRepository(db.getDatabase(), () =>
      hub.event('neo.changed', {})
    );
    this.consultationWaiters = new NeoConsultationWaiterRepository(db.getDatabase(), () =>
      hub.event('neo.changed', {})
    );
    this.reportWork = createNeoWorkReporter({
      readWork: (id) => this.repo.getWork(id),
      readBinding: (id) => this.repo.getBindingBySession(id),
      transitionWork: (id, expected, patch) => this.repo.transitionWork(id, expected, patch),
      returnReport: (work) => this.returnReport(work),
      resourceReports: new NeoWorkResourceRepository(db.getDatabase(), () =>
        hub.event('neo.changed', {})
      ),
    });
    const inputOrigins = new NeoInputOriginRepository(db.getDatabase());
    this.inputOrigins = inputOrigins;
    this.resolveAskOrigin = createNeoAskOriginResolver({
      getBinding: (id) => this.repo.getBindingBySession(id),
      getPrompts: (sessionId, messageId) =>
        this.db.getSDKMessageRepo().getStoredPromptsByUuid(sessionId, messageId),
      getConsultation: (id) => this.consultations.get(id),
      getWork: (id) => this.repo.getWork(id),
      getAsk: (id) => this.askRecords.get(id),
      getRootBinding: () => this.repo.getBindingForConcern(null),
      getStamp: (sessionId, messageId) => inputOrigins.get(sessionId, messageId),
      stamp: (input, origin) => inputOrigins.record(input, origin, Date.now()),
    });
    const publicationSettlements = new NeoConsultationRepository(db.getDatabase(), () => {});
    const notifyPublication = () => {
      try {
        void hub.event('neo.changed', {});
      } catch {}
    };
    this.publish = createNeoPublisher({
      getBinding: (id) => this.repo.getBindingBySession(id),
      getRootBinding: () => this.repo.getBindingForConcern(null),
      hasConcern: (id) => !!this.repo.getConcern(id),
      getWork: (id) => this.repo.getWork(id),
      getConsultation: (id) => this.consultations.get(id),
      resolveAskOrigin: (input) => this.resolveAskOrigin(input),
      replay: (input, caller) => {
        const turn = caller.neoTurn;
        const item = turn?.consultationId ? this.consultations.get(turn.consultationId) : null;
        const binding = caller.sessionId ? this.repo.getBindingBySession(caller.sessionId) : null;
        if (
          caller.source !== 'mcp' ||
          !item ||
          binding?.kind !== 'concern' ||
          binding.sessionId !== item.sessionId ||
          binding.concernId !== item.concernId ||
          turn?.messageId !== `neo-consult:${item.id}:request`
        )
          return null;
        const association = this.consultations.getPublication(item.id);
        if (!association) return null;
        const root = this.repo.getBindingForConcern(null);
        if (root?.kind !== 'neo' || root.sessionId !== `neo:${association.conversationId}`)
          return { accepted: false, reason: 'publication_superseded' };
        const publication = this.publications.get(
          association.conversationId,
          association.publicationId
        );
        if (!publication) throw new Error('Committed consultation publication is missing');
        if (
          publication.producerInput.sessionId !== caller.sessionId ||
          publication.producerInput.messageId !== turn.messageId ||
          publication.publicationId !== input.publicationId ||
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
      append: (input, consultationId) => {
        if (!consultationId) return this.appendPublication(input);
        const receipt = publicationSettlements.settleWithPublication({
          consultationId,
          answer: input.fullText,
          publication: input,
        });
        if (!receipt.accepted) return receipt;
        const publication = this.publications.get(input.conversationId, input.publicationId);
        if (!publication) throw new Error('Committed consultation publication is missing');
        return { accepted: true, created: receipt.created, publication };
      },
      notify: notifyPublication,
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
      getRootBinding: () => this.repo.getBindingForConcern(null),
      recentAsks: (conversationId, id) => this.asks.recentFrom(conversationId, id, 5),
      isPublished: (id, messageId) => !!this.publications.findByProducer(id, messageId),
      startedWork: (id, messageId) => neoAskStartedWork(db, id, messageId),
      turnReply: (id, messageId) => readNeoTurnReply(db, id, messageId),
      hasNudge: (id, nudgeId) => this.hasDelivery(id, nudgeId),
      recheck: (id) => this.scheduleReplyRecheck(id, directReplies),
      nudge: (id, nudgeId) =>
        void this.deliver(id, nudgeId, NEO_PUBLISH_NUDGE, id, {
          sessionId: id,
          messageId: nudgedMessageId(nudgeId) ?? nudgeId,
        }).catch((error) => this.log.warn('Publish nudge failed', error)),
      append: (input) => this.appendPublication(input),
      notify: notifyPublication,
      newId: () => crypto.randomUUID(),
    };
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
        if (binding && binding.kind !== 'worker') {
          try {
            publishNeoDirectReplyFallback(sessionId, directReplies, {
              settled: false,
              interrupted: this.interruptedSessions.has(sessionId),
            });
          } catch (error) {
            this.log.warn('Direct reply fallback failed', error);
          }
        }
        if (binding?.kind === 'concern' && binding.concernId)
          await this.dispatchConsultationWaiter(binding.concernId).catch((error) =>
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
    this.unsubscribe = () => {
      offUpdated();
      offStatus();
      offDeleted();
    };
  }

  private recordCardCheck(workId: string, read: boolean, now: number): boolean {
    const prior = this.driverTargets.readCardCheck(workId) ?? undefined;
    const { next, changed } = planNeoCardCheck(prior, read, now);
    this.driverTargets.recordCardCheck(workId, next);
    return changed;
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

  private appendPublication(input: NeoPublicationInput) {
    const plan = planNeoSavedRulesAppend(input, this.savedRules, {
      standingRules: neoStandingRules(this.db.getGlobalSettings?.().neo),
      stored: !!this.publications.get(input.conversationId, input.publicationId),
    });
    const receipt = this.publications.append(withNeoSavedRules(input, plan.rules));
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
    const root = this.repo.getBindingForConcern(null)?.sessionId;
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
      this.repo.getBindingForConcern(null),
      ...this.repo.listConcernBindings(),
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

  private forgetSession(sessionId: string): void {
    this.processingStatus.delete(sessionId);
    this.interruptedSessions.delete(sessionId);
    const timer = this.replyRechecks.get(sessionId);
    if (timer) clearTimeout(timer);
    this.replyRechecks.delete(sessionId);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.unsubscribe();
    for (const timer of this.replyRechecks.values()) clearTimeout(timer);
    this.replyRechecks.clear();
    this.processingStatus.clear();
    this.interruptedSessions.clear();
    if (this.watching) await this.watching;
    this.flushSessionNoticeGroup();
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

  open(concernId: string | null): Promise<string> {
    const key = concernId;
    const existing = this.pending.get(key);
    if (existing) return existing;
    const operation = this.ensureCoordinator(concernId).finally(() => this.pending.delete(key));
    this.pending.set(key, operation);
    return operation;
  }

  private async ensureCoordinator(concernId: string | null): Promise<string> {
    const concern = concernId ? this.repo.getConcern(concernId) : null;
    if (concernId && !concern) throw new Error('This concern no longer exists.');
    let binding = this.repo.getBindingForConcern(concernId);
    if (!binding) {
      this.repo.reserveBinding({
        sessionId: `neo:${crypto.randomUUID()}`,
        concernId,
        kind: concernId ? 'concern' : 'neo',
      });
      binding = this.repo.getBindingForConcern(concernId);
    }
    if (!binding) throw new Error('Could not reserve Neo context.');
    if (!this.db.getSession(binding.sessionId)) {
      const root = concernId ? this.repo.getBindingForConcern(null)?.sessionId : undefined;
      const rootSession = root ? this.db.getSession(root) : null;
      const preference = this.modelPreference();
      await this.sessions.createSession({
        sessionId: binding.sessionId,
        parentSessionId: rootSession ? root : undefined,
        title: concern ? `Neo · ${concern.title}` : 'Neo',
        workspacePath: neoFolderPath(),
        detectGit: false,
        config: {
          systemPrompt: neoPrompt(concernId, this.packBriefs()),
          sdkToolsPreset: neoCoordinatorNativeTools(concernId),
          permissionMode: 'dontAsk',
          allowedTools: neoCoordinatorAllowedTools(concernId),
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
      const brief = `${NEO_WORK_DELEGATED}\n${JSON.stringify({ workId: work.id, title: work.title, instruction: withWorkGoal(work.instruction, this.workDoneGoal(work.id)) })}`;
      await this.deliver(work.sessionId, work.id, brief, work.originSessionId);
      return;
    }
    await this.failWork(
      work,
      'Neo did not choose where this work runs. Ask Neo again and say which project, Space or chat it belongs to.'
    );
  }

  async continueWork(id: string, message: string, now = Date.now()): Promise<NeoContinueResult> {
    const admitted = admitNeoWorkContinue(this.continueDeps, id, now);
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
    readContinuedCount: (id) => this.workContinues.get(id)?.count ?? null,
    readAsk: (id) => this.askRecords.forWork(id),
    isContinuing: (id) => this.continuing.has(id),
    withGoal: (id, message) => withWorkGoal(message, this.workDoneGoal(id)),
    readSendBaseline: ({ ref, work }, message) => this.readSendBaseline(ref, work, message),
    send: ({ ref, work }, message) =>
      invokeOperation(
        this.sessions.getOperationRegistry(),
        'work.send',
        { ref, message },
        driverWorkCaller(work)
      ),
    recordSent: (id, startedAt, sent) => {
      this.driverTargets.recordStartedAt(id, startedAt);
      this.driverTargets.recordSent(id, sent);
    },
    recordContinue: (id, message, now) =>
      this.workContinues.record(id, message, now)?.count ?? null,
    reserveAskContinue: (ask) =>
      this.askRecords.reserveApprovedContinue(ask.id, NEO_ASK_CONTINUE_LIMIT),
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
    const outcome = await invokeOperation(
      this.sessions.getOperationRegistry(),
      'work.status',
      { ref },
      driverWorkCaller(work)
    );
    return {
      baseline: readDriverSendBaseline(outcome, sentAt, !!ref.daemon),
      sent: readDriverSent(outcome, message, work.createdAt),
    };
  }

  close(id: string, outcome: NeoWorkCloseOutcome): Promise<NeoWorkCloseResult> {
    return closeNeoWork(
      {
        repo: this.repo,
        readDriverRef: (workId: string) => this.driverTargets.readRef(workId),
        stopDriver: (ref: WorkRef, work: NeoWork) => this.stopDriverWork(ref, work),
      },
      id,
      outcome
    );
  }

  async cancel(id: string): Promise<void> {
    const work = this.repo.getWork(id);
    if (work?.status === 'proposed' || work?.status === 'queued') await this.close(id, 'cancelled');
  }

  private async startDriverWork(work: NeoWork, target: NeoDriverTarget): Promise<void> {
    if (work.status === 'queued') {
      if (this.driverTargets.readRef(work.id)) return;
      this.driverTargets.recordStartInterrupted(work.id);
      await this.failWork(
        work,
        `${NEO_DRIVER_START_INTERRUPTED} ${target.verb === 'start' ? target.adapter : target.ref.adapter} confirmed it. It may still have started; check work.find before trying again.`
      );
      return;
    }
    const queued = this.repo.transitionWork(work.id, work, { status: 'queued' });
    if (!queued || queued.status !== 'queued') return;
    const call = driverWorkCall(target, queued, this.workDoneGoal(queued.id));
    const probe =
      target.verb === 'send'
        ? await this.readSendBaseline(target.ref, queued, String(call.input.message))
        : null;
    const baseline = probe ? probe.baseline : Date.now();
    const outcome = await invokeOperation(
      this.sessions.getOperationRegistry(),
      call.name,
      call.input,
      driverWorkCaller(queued)
    );
    const result = readDriverOutcome(target, outcome);
    if ('ref' in result) {
      this.driverTargets.recordRef(
        queued.id,
        result.ref,
        result.startedAt ?? ('queued' in result ? undefined : (baseline ?? undefined)),
        result.link
      );
      const opening = messageOpening(String(call.input.message));
      this.driverTargets.recordSent(
        queued.id,
        probe ? probe.sent : opening ? { inputBefore: 0, opening } : null
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
    await this.failWork(queued, `Could not start the execution: ${result.failure}`);
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
    return !!work && 'value' in requireNeoWorkRetryable(work, this.retryCard(workId), true);
  }

  async retryWork(
    work: NeoWork
  ): Promise<{ ok: true; work: NeoWork } | { ok: false; reason: string }> {
    const id = work.id;
    const proposed = this.repo.transitionWork(id, work, { status: 'proposed', report: null });
    if (!proposed) return { ok: false, reason: 'This work changed meanwhile; read it again.' };
    await this.workPending.get(id)?.catch(() => undefined);
    this.driverTargets.recordRetry(id);
    await this.start(id);
    return { ok: true, work: this.repo.getWork(id)! };
  }

  private async stopDriverWork(ref: WorkRef, work: NeoWork): Promise<void> {
    await invokeOperation(
      this.sessions.getOperationRegistry(),
      'work.stop',
      { ref },
      driverWorkCaller(work)
    ).catch(() => undefined);
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
    this.loadSessionNoticeGroups();
    await this.recoverConsultations();
    for (const work of this.repo.listWork()) {
      try {
        if (work.status === 'queued') await this.start(work.id);
        await this.reconcile(work.id);
      } catch (error) {
        this.log.warn('Neo recovery pending', error);
      }
    }
    await this.reclaimCardPrs();
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
    }
    for (const { work } of cards) {
      if (work.status !== 'reported') continue;
      await this.followWork(work, Date.now()).catch((error) =>
        this.log.warn('Reported work follow-up pending', error)
      );
    }
    for (const workId of this.packEvidenceWorkIds()) {
      await this.refreshWorkPrs(workId, Date.now()).catch((error) =>
        this.log.warn('Work pull request refresh pending', error)
      );
    }
    for (const ask of this.askRecords.listLive()) {
      try {
        this.runAskPackTicks(ask.id);
      } catch (error) {
        this.log.warn('Neo ask ticks pending', error);
      }
      await this.checkAskEvidence(ask, Date.now()).catch((error) =>
        this.log.warn('Ask evidence check pending', error)
      );
    }
    for (const ask of this.askRecords.listLive()) {
      await this.noteAskStall(ask, Date.now()).catch((error) =>
        this.log.warn('Ask stall note pending', error)
      );
    }
    this.pruneReadThrottles(Date.now());
    if (this.watching || this.disposed) return;
    this.watching = this.watchSessions(Date.now())
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

  private followedCardRefs(now: number): WorkRef[] {
    return this.driverTargets.cardRefs(now - NEO_WORK_FOLLOW_MAX_AGE_MS).flatMap((card) => {
      const work = this.repo.getWork(card.workId);
      if (!work) return [];
      if (work.status !== 'reported') return [card.ref];
      const following = requireNeoWorkFollow(
        work,
        {
          ref: card.ref,
          goal: !!this.workDoneGoal(work.id)?.doneWhen,
          ask: this.askRecords.forWork(work.id),
          readAt: null,
          superseded: this.driverTargets.readSupersededAt(work.id) !== null,
          live: this.driverTargets.readLiveStatus(work.id),
        },
        now
      );
      return 'value' in following ? [card.ref] : [];
    });
  }

  private readonly watchSessions = (superpipe({})('neo-session-watch') as PipelineAPI)
    .input(['now'])
    .pipe(
      () => {
        const root = this.repo.getBindingForConcern(null)?.sessionId;
        return root ? { value: root } : { reason: 'no_root' as const };
      },
      'now',
      'result:root'
    )
    .pipe(
      async (root: string, now: number) => {
        const outcome = await invokeOperation(
          this.sessions.getOperationRegistry(),
          'work.find',
          { localOnly: true, limit: NEO_SESSION_WATCH_LIMIT },
          { source: 'internal', sessionId: root, role: 'neo' }
        );
        const value =
          outcome.kind === 'completed'
            ? (outcome.value as {
                places?: PlaceGroup[];
                unreachable?: unknown[];
                more?: boolean;
              } | null)
            : null;
        return {
          sessions: listNeoWatchedSessions(
            value?.places ?? [],
            this.followedCardRefs(now),
            now,
            this.db.getGlobalSettings?.().neo?.mutedSessions
          ),
          complete: !!value?.places && !value.unreachable?.length && !value.more,
        };
      },
      ['root', 'now'],
      'listed'
    )
    .pipe(
      (listed: { sessions: NeoListedSession[]; complete: boolean }, now: number) =>
        planNeoSessionWatch(listed.sessions, this.sessionsSeen, now),
      ['listed', 'now'],
      'plan'
    )
    .pipe(
      (
        listed: { sessions: NeoListedSession[]; complete: boolean },
        plan: ReturnType<typeof planNeoSessionWatch>
      ) => ({ sessions: planNeoSessionPrReads(listed.sessions, this.sessionPrs, plan.reads) }),
      ['listed', 'plan'],
      'prReads'
    )
    .pipe(
      async (
        root: string,
        plan: ReturnType<typeof planNeoSessionWatch>,
        prReads: { sessions: NeoListedSession[] }
      ) => {
        const sessions = [...plan.reads, ...prReads.sessions];
        const reads = await Promise.all(
          sessions.map(async (session) => {
            const outcome = await invokeOperation(
              this.sessions.getOperationRegistry(),
              'work.status',
              { ref: session.ref },
              { source: 'internal', sessionId: root, role: 'neo' }
            );
            const live = readDriverLive(outcome);
            return live
              ? {
                  detail: { status: live.status, lastInputAt: readDriverLastInputAt(outcome) },
                  opened: [
                    ...readDriverOpenedPrs(outcome),
                    ...(await this.sessionBranchPrs(session.ref)),
                  ],
                }
              : null;
          })
        );
        return {
          details: reads.slice(0, plan.reads.length).map((read) => read?.detail ?? null),
          found: new Map(
            sessions.flatMap((session, index) => {
              const opened = reads[index]?.opened;
              return opened ? [[session.key, opened] as const] : [];
            })
          ),
        };
      },
      ['root', 'plan', 'prReads'],
      'read'
    )
    .pipe(
      (
        plan: ReturnType<typeof planNeoSessionWatch>,
        read: { details: ({ status: WorkStatus; lastInputAt: number | null } | null)[] },
        now: number
      ) => ({
        planned: plan.reads.map((session, index) =>
          planNeoSessionNotice(
            session,
            this.sessionsSeen.get(session.key)!,
            read.details[index],
            now
          )
        ),
      }),
      ['plan', 'read', 'now'],
      'notices'
    )
    .pipe(
      (
        listed: { sessions: NeoListedSession[]; complete: boolean },
        read: { found: ReadonlyMap<string, readonly string[]> }
      ) => {
        const kept = keepNeoSessionPrs(this.sessionPrs, read.found);
        const keep = new Set(listed.sessions.map((session) => session.key));
        const prs = listed.complete ? new Map([...kept].filter(([key]) => keep.has(key))) : kept;
        const watched = new Map([...prs].filter(([key, urls]) => keep.has(key) && urls.length));
        const asks = watched.size ? this.askRecords.listLive().map((ask) => this.askPrs(ask)) : [];
        return { prs, links: linkNeoSessionsToAsks(asks, watched) };
      },
      ['listed', 'read'],
      'linked'
    )
    .pipe(
      (
        notices: { planned: ReturnType<typeof planNeoSessionNotice>[] },
        linked: { links: NeoSessionAskLink[] }
      ) => {
        const planned = new Map(
          notices.planned.flatMap((item) => (item.notice ? [[item.notice.key, item] as const] : []))
        );
        const next = planNeoHeldSessionNotices(
          this.heldSessionNotices,
          [...planned.values()].flatMap((item) => (item.notice ? [item.notice] : [])),
          new Set(linked.links.map((link) => link.key)),
          (key) => planned.get(key)?.seen.status ?? this.sessionsSeen.get(key)?.status
        );
        this.heldSessionNotices = next.held;
        return { notices: next.notices };
      },
      ['notices', 'linked'],
      'added'
    )
    .pipe(
      (added: { notices: NeoSessionNotice[] }, now: number) =>
        planNeoSessionNoticeGroup(this.openSessionNotices, added.notices, now),
      ['added', 'now'],
      'grouped'
    )
    .pipe(
      (
        listed: { sessions: NeoListedSession[]; complete: boolean },
        plan: ReturnType<typeof planNeoSessionWatch>,
        notices: { planned: ReturnType<typeof planNeoSessionNotice>[] }
      ) => {
        const keep = new Set(listed.sessions.map((session) => session.key));
        if (listed.complete)
          for (const key of [...this.sessionsSeen.keys()])
            if (!keep.has(key)) this.sessionsSeen.delete(key);
        for (const [key, seen] of plan.baseline) this.sessionsSeen.set(key, seen);
        plan.reads.forEach((session, index) =>
          this.sessionsSeen.set(session.key, notices.planned[index].seen)
        );
      },
      ['listed', 'plan', 'notices']
    )
    .pipe(
      (
        root: string,
        listed: { sessions: NeoListedSession[]; complete: boolean },
        linked: { prs: Map<string, string[]>; links: NeoSessionAskLink[] },
        added: { notices: NeoSessionNotice[] },
        grouped: ReturnType<typeof planNeoSessionNoticeGroup>
      ) => {
        const askSessions = describeNeoAskSessions(
          linked.links,
          listed.sessions,
          (session) => this.sessionsSeen.get(session.key)?.status ?? session.status
        );
        const moved = JSON.stringify([...askSessions]) !== JSON.stringify([...this.askSessions]);
        this.sessionPrs = linked.prs;
        this.askSessions = askSessions;
        this.openSessionNotices = grouped.open;
        this.sessionNotices = keepNeoSessionNotices(this.sessionNotices, added.notices);
        for (const notice of added.notices) this.announceSessionNotice(notice);
        for (const group of grouped.closed) this.postSessionNoticeGroup(root, group);
        if (added.notices.length || grouped.closed.length || moved) this.notifyChanged();
      },
      ['root', 'listed', 'linked', 'added', 'grouped']
    )
    .endAsync('root') as (now: number) => Promise<unknown>;

  private flushSessionNoticeGroup(): void {
    const group = neoSessionNoticeGroup(this.openSessionNotices);
    this.openSessionNotices = [];
    const root = group && this.repo.getBindingForConcern(null)?.sessionId;
    if (!group || !root) return;
    try {
      this.postSessionNoticeGroup(root, group);
    } catch (error) {
      this.log.warn('Neo session notice group could not be saved at shutdown', error);
    }
  }

  private loadSessionNoticeGroups(): void {
    const root = this.repo.getBindingForConcern(null)?.sessionId;
    if (!root) return;
    try {
      this.sessionNoticeGroups = savedNeoSessionNoticeGroups(
        this.db
          .getSDKMessageRepo()
          .getLatestSDKMessagesByType(root, 'system', 'session_notices', NEO_SESSION_GROUPS_MAX)
      );
    } catch (error) {
      this.log.warn('Neo session notice groups could not be reloaded', error);
    }
  }

  private postSessionNoticeGroup(root: string, group: NeoSessionNoticeGroup): void {
    if (this.sessionNoticeGroups.some((kept) => kept.id === group.id)) return;
    const saved = this.db.getSDKMessageRepo().saveSDKMessage(root, {
      type: 'system',
      subtype: 'session_notices',
      uuid: group.id,
      session_id: root,
      content: group.line,
      group,
    } as unknown as SDKMessage);
    if (!saved) {
      this.log.warn(`Neo session notice group ${group.id} could not be saved`);
      return;
    }
    this.sessionNoticeGroups = keepNeoSessionNoticeGroups(this.sessionNoticeGroups, group);
    this.announceSessionNoticeGroup(group);
  }

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
        await this.deliver(
          ask.originSessionId,
          note.id,
          neoAskStalledNote(ask, read.cards, read.newer),
          ask.originSessionId,
          neoAskParent(ask)
        );
      },
      ['ask', 'read', 'note']
    )
    .endAsync('stall') as (ask: NeoAsk, now: number) => Promise<unknown>;

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
        await this.deliver(
          check.originSessionId,
          neoAskEvidenceMessageId(check.id, note.signature),
          neoAskEvidenceNote(check, note.evidence),
          check.originSessionId,
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
          NEO_WORK_CLOSED_DONE
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
            ? planNeoDoneCheck(planned.read.evidence, told.row, planned.read.read, now, {
                quietSince: refresh.work.updatedAt,
                remindable: !card.ask || card.ask.status === 'open',
              })
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
        refresh: { work: NeoWork; delivery: 'deliver' | 'remind' },
        card: NeoWorkPrCard,
        refreshed: NeoWorkPrRefreshed,
        told: NeoWorkTold,
        planned: { read: NeoEvidenceRead | null }
      ) => {
        if (!card.goal) return;
        await this.deliverDoneCheck(
          refresh.work,
          card.goal,
          this.workPrs.get(refresh.work.id),
          refresh.delivery === 'remind'
            ? {
                ask: card.ask,
                ready: true,
                remind: true,
                followedAt: told.row?.toldAt ?? refresh.work.updatedAt,
                signature: planned.read ? neoEvidenceSignature(planned.read.evidence) : undefined,
              }
            : {
                stale: refreshed.failed || refreshed.read?.read.ok === false,
                ask: card.ask,
                signature: planned.read ? neoEvidenceSignature(planned.read.evidence) : undefined,
              }
        );
      },
      ['refresh', 'card', 'refreshed', 'told', 'planned']
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

  pack(id: string): NeoPack | null {
    return this.installedPacks().find((pack) => pack.id === id) ?? null;
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
    return row;
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
      !!this.workContinues.get(workId) || this.driverTargets.get(workId)?.verb === 'send',
    readStatus: (work, ref, since) =>
      invokeOperation(
        this.sessions.getOperationRegistry(),
        'work.status',
        { ref, ...(since !== null ? { since } : {}) },
        driverWorkCaller(work)
      ),
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

  private continueBudget(work: NeoWork, now: number): string | null {
    return readNeoWorkContinueBudget(
      this.workContinues.get(work.id),
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
    await this.deliver(
      work.originSessionId,
      neoStallMessageId(work.id, live.lastActivityAt),
      driverStallNote(work, this.workDoneGoal(work.id), live.lastReply, budget),
      work.originSessionId,
      neoWorkParent(work)
    );
  }

  private async noteDriverStuck(work: NeoWork): Promise<void> {
    const now = Date.now();
    const reminder = decideStuckReminder(work.updatedAt, now);
    if (!reminder || !this.db.getSession(work.originSessionId)) return;
    await this.deliver(
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
      work.originSessionId,
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
      (card: NeoNeedsYouCard) =>
        planNeoNeedsYou(card.state, card.noted, card.ask, card.siblingsWaiting),
      'card',
      'plan'
    )
    .pipe(
      async (work: NeoWork, ref: WorkRef, card: NeoNeedsYouCard, plan: NeoNeedsYouPlan) => {
        if (plan.notify !== null && this.db.getSession(work.originSessionId))
          await this.deliver(
            work.originSessionId,
            neoNeedsYouMessageId(work.id, plan.notify),
            driverNeedsYouNote(work, ref, card.state?.lastReply),
            work.originSessionId,
            neoWorkParent(work)
          );
        if (plan.record !== undefined) this.driverTargets.recordNeedsYouSince(work.id, plan.record);
        if (!plan.resume) return;
        for (const id of plan.resume.items)
          this.askRecords.tickItem(
            plan.resume.ask.id,
            { id, state: 'pending', evidence: null, metBy: null },
            Date.now()
          );
        if (plan.resume.reopen) this.askRecords.reopen(plan.resume.ask);
      },
      ['work', 'ref', 'card', 'plan']
    )
    .endAsync('plan') as (
    work: NeoWork,
    ref: WorkRef,
    outcome: OperationOutcome
  ) => Promise<unknown>;

  async recoverConsultations(): Promise<void> {
    for (const item of this.consultations.unsettled()) {
      await this.syncConsultation(item.id).catch((error) =>
        this.log.warn('Consultation recovery pending', error)
      );
    }
    for (const concernId of this.consultationWaiters.queuedConcerns())
      await this.dispatchConsultationWaiter(concernId).catch((error) =>
        this.log.warn('Consultation admission pending', error)
      );
  }

  async dispatchConsultationWaiter(concernId: string): Promise<void> {
    await dispatchNeoConsultationWaiter(this, concernId);
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
          'failed',
          failure
            ? `The context holder stopped: ${failure}.`
            : 'The context holder ended without returning an answer.'
        );
      } else {
        await this.open(item.concernId);
        const content = neoConsultationRequestContent(item);
        await this.deliver(
          item.sessionId,
          requestId,
          content,
          item.originSessionId,
          neoConsultationParent(item)
        );
        return;
      }
    }
    if (!item) return;
    const association = this.consultations.getPublication(id);
    const captured = this.consultations.getPublicationInput(id);
    const publication = association
      ? this.publications.get(association.conversationId, association.publicationId)
      : this.publications.findByProducer(item.sessionId, requestId);
    const route = planNeoConsultationReturn(
      item,
      association,
      publication,
      captured?.askOrigin ?? null,
      captured
    );
    if (route === 'inconsistent')
      throw new Error('Consultation publication return is inconsistent');
    if (route === 'pending') return;
    if (route === 'legacy') {
      const content = neoConsultationReplyContent(item);
      if (content === null) return;
      await this.deliver(
        item.originSessionId,
        `neo-consult:${id}:reply`,
        content,
        item.sessionId,
        neoConsultationParent(item)
      );
    }
    this.consultations.returned(id);
    await this.dispatchConsultationWaiter(item.concernId);
    for (const work of this.repo.listWork(item.concernId)) {
      if (work.status === 'reported' || work.status === 'failed') await this.returnReport(work);
    }
  }

  async reconcile(id: string): Promise<void> {
    let work = this.repo.getWork(id);
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

  private async returnReport(work: NeoWork): Promise<void> {
    if (work.status === 'reported' && work.report === NEO_WORK_CLOSED_DONE) return;
    if ((await this.checkDone(work, false)) !== 'not_checked') return;
    if (work.status === 'reported')
      await readNeoPackEvidence(
        this.evidencePacks(this.askRecords.forWork(work.id), !!this.workPrs.get(work.id)),
        work,
        (id, error) => this.log.warn(`Neo pack ${id} evidence read failed`, error)
      );
    const rootId = await this.open(null);
    if (work.concernId) {
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
      ? `\n${fillPrompt(NEO_WORK_PACK_NOTE, { pack: packNote.id })}\n${packNote.instructions}\n`
      : '';
    const content = `${fillPrompt(NEO_WORK_RETURNED, { retry: retryNote, summary: NEO_WORK_SUMMARY_NOTE })}${packLine}\n${JSON.stringify({ workId: work.id, originSessionId: work.originSessionId, originMessageId: work.originMessageId, concernId: work.concernId, status: work.status, executionSessionId: work.sessionId, title: work.title, report: work.report })}`;
    for (const target of targets) {
      if (this.db.getSession(target))
        await this.deliver(
          target,
          neoWorkReturnMessageId(work.id, retries, this.workContinues.get(work.id)?.count ?? 0),
          content,
          work.sessionId ?? work.originSessionId,
          neoWorkParent(work)
        );
    }
  }

  private async cardPrCandidates(
    work: NeoWork,
    stored: { prs: readonly NeoWorkPr[] } | null
  ): Promise<NeoCardPrCandidate[]> {
    const goal = this.workGoals.get(work.id);
    const brief = [work.instruction, goal?.goal, goal?.doneWhen].filter(Boolean).join('\n');
    return planNeoCardPrCandidates({
      report: work.report,
      brief,
      branch: await this.branchPrUrls(work.id),
      stored: stored?.prs ?? [],
      refs: await this.cardPrRefs(work, brief),
    });
  }

  private async cardPrRefs(
    work: NeoWork,
    brief: string
  ): Promise<{ named: string[]; mentioned: string[] }> {
    if (!/#\d/.test(`${brief}\n${work.report ?? ''}`)) return { named: [], mentioned: [] };
    const ref = this.driverTargets.readRef(work.id);
    const cwd = neoWorkRepoCwd(ref?.adapter === 'hyperneo' ? this.db.getSession(ref.id) : null);
    const repo = cwd ? await this.readWorkRepo(cwd) : null;
    const read = (text: string) =>
      readNeoPrRefUrls(extractNeoCardRefs(text, repo), (refs) => this.readRefStates(refs));
    return { named: await read(brief), mentioned: await read(work.report ?? '') };
  }

  private async branchPrUrls(workId: string): Promise<string[]> {
    return this.sessionBranchPrs(this.driverTargets.readRef(workId));
  }

  private async sessionBranchPrs(ref: WorkRef | null): Promise<string[]> {
    const branch = neoWorkBranch(ref?.adapter === 'hyperneo' ? this.db.getSession(ref.id) : null);
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
      (ask: NeoAsk, plan: { ticks: ReturnType<typeof planNeoPackTicks> }) => {
        for (const tick of plan.ticks)
          this.askRecords.tickItem(
            ask.id,
            { id: tick.id, state: 'met', evidence: tick.evidence, metBy: 'daemon' },
            Date.now()
          );
        return { ask: plan.ticks.length ? this.askRecords.get(ask.id) : null };
      },
      ['ticks', 'plan'],
      'ticked'
    )
    .pipe(
      (ticked: { ask: NeoAsk | null }) => ({
        plan: ticked.ask ? planNeoAskTickStatus(ticked.ask) : null,
      }),
      'ticked',
      'status'
    )
    .pipe(
      (
        ask: NeoAsk,
        ticked: { ask: NeoAsk | null },
        status: { plan: ReturnType<typeof planNeoAskTickStatus> | null }
      ) => ({
        value:
          ticked.ask && status.plan
            ? (writeNeoAskTickStatus(this.askRecords, ticked.ask, status.plan) ?? ticked.ask)
            : ask,
      }),
      ['ticks', 'ticked', 'status'],
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
          id: neoDoneCheckMessageId(work.id, continued, found.row?.revision, options.followedAt),
          content: driverDoneCheckNote(
            work,
            goal,
            continued,
            this.continueBudget(work, Date.now()),
            {
              prs: found.row?.prs,
              stale: options.stale ?? false,
              ready: options.ready ?? false,
              ask: current.ask,
              pack: options.remind ? null : this.askPackFragment(current.ask),
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
        await this.deliver(
          work.originSessionId,
          note.id,
          note.content,
          work.originSessionId,
          neoWorkParent(work)
        );
        return { at: Date.now() };
      },
      ['work', 'note'],
      'sent'
    )
    .pipe(
      (work: NeoWork, options: NeoDoneCheckDelivery, sent: { at: number }) => {
        if (options.signature)
          this.workChecks.markTold(work.id, options.signature, sent.at, options.ready ?? false);
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

  private hasDelivery(sessionId: string, messageId: string): boolean {
    return (
      this.deliveries.has(`${sessionId}:${messageId}`) ||
      !!this.db.getSDKMessageRepo().findMessageIdByUuid(sessionId, messageId) ||
      this.db
        .getJobQueueRepo()
        .listActiveByPayload('mailbox', { 'to.sessionId': sessionId, messageUuid: messageId })
        .length > 0
    );
  }

  private deliver(
    sessionId: string,
    messageId: string,
    content: string,
    originSessionId: string,
    parent: NeoAskOrigin | null = null
  ): Promise<void> {
    const key = `${sessionId}:${messageId}`;
    const existing = this.deliveries.get(key);
    if (existing) return existing;
    const delivery = this.enqueueDelivery(sessionId, messageId, content, originSessionId)
      .then(() => this.stampDelivery({ sessionId, messageId }, parent))
      .finally(() => this.deliveries.delete(key));
    this.deliveries.set(key, delivery);
    return delivery;
  }

  private stampDelivery(input: NeoAskOrigin, parent: NeoAskOrigin | null): void {
    const origin = parent ? this.resolveAskOrigin(parent) : null;
    if (origin) this.inputOrigins.record(input, origin, Date.now());
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
      jobQueue: queue,
    });
    if (outcome.kind === 'rejected') throw new Error(outcome.reason);
  }
}
