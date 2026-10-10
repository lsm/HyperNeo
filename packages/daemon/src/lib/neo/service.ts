import {
  fillPrompt,
  NEO_WORK_DELEGATED,
  NEO_WORK_RETURNED,
  NEO_WORK_RETURNED_RETRIED,
  NEO_WORK_RETURNED_RETRY,
} from '@hyperneo/prompts';
import type { GlobalSettings, MessageHub, Provider } from '@hyperneo/shared';
import { type NeoModelPreference, neoStandingRules } from '@hyperneo/shared/types/settings';
import type { NeoConsultation, NeoWork } from '@hyperneo/shared/types/neo-context';
import type { NeoPublicationInput } from '@hyperneo/shared/types/neo-publication';
import {
  NEO_WORK_CLOSED_DONE,
  type NeoAsk,
  type NeoWorkGoal,
  type NeoWorkPr,
} from '@hyperneo/shared/types/neo-snapshot';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { Database } from '../../storage/database.ts';
import type { OperationCaller } from '../operations/registry.ts';
import { DaemonInventoryRepository } from '../../storage/repositories/daemon-inventory-repository.ts';
import { NeoAgentWorkTargetRepository } from '../../storage/repositories/neo-agent-work-target-repository.ts';
import { NeoAskRepository } from '../../storage/repositories/neo-ask-repository.ts';
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
import { NeoWorkGoalRepository } from '../../storage/repositories/neo-work-goal-repository.ts';
import { planNeoAskTickStatus, writeNeoAskTickStatus } from './ask-operations.ts';
import { NeoWorkPrRepository, type NeoWorkPrRow } from './packs/coding/neo-work-pr-repository.ts';
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
  readDriverActivity,
  withWorkGoal,
  readContinueBudget,
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
import { createNeoPublisher } from './publication-operation.ts';
import { neoCoordinatorAllowedTools, neoCoordinatorNativeTools } from './session-policy.ts';
import { neoAskStartedWork, readNeoTurnReply } from './turn-reply.ts';
import { createNeoWorkReporter } from './work-report.ts';
import { returnWorkThroughHolder } from './work-return.ts';
import { createNeoWorkTargetResolver } from './work-target.ts';
import { type NeoEvidenceRead, neoEvidenceSignature, planNeoDoneCheck } from './evidence.ts';
import { createCodingPack } from './packs/coding/pack.ts';
import {
  NEO_DEFAULT_PACKS,
  neoPackChecks,
  neoPacks,
  planNeoPackTicks,
  readNeoPackEvidence,
  requireNeoPackTickable,
} from './packs/index.ts';
import type { NeoPack } from './packs/types.ts';
import {
  extractNeoWorkPrUrls,
  neoAskPrEvidence,
  neoWorkPrEvidence,
  neoWorkPrSignature,
  requireNeoWorkPrDelivery,
  requireNeoWorkPrRefresh,
  readGithubPrs,
  shouldReadNeoWorkPrs,
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
} from './done-check.ts';
import { planNeoWaitingReminders } from './waiting-reminders.ts';
import { planNeoNeedsYou } from './needs-you.ts';
import { planNeoWorkFollow, requireNeoWorkFollow } from './work-follow.ts';

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
const DRIVER_START_INTERRUPTED = 'Starting was interrupted before';

type NeoWorkPrCard = {
  ask: NeoAsk | null;
  goal: NeoWorkGoal | null;
  row: NeoWorkPrRow | null;
  session: boolean;
};
type NeoWorkPrRefreshed = { read: NeoEvidenceRead | null };
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
  ask?: NeoAsk | null;
  followedAt?: number;
};
type NeoWorkTold = { row: NeoWorkCheckRow | null };
type NeoDoneCheckCard = {
  ask: NeoAsk | null;
  continued: number;
  stored: NeoWorkPrRow | null;
};
type NeoDoneCheckFound = { row: NeoWorkPrRow | null };

export class NeoService {
  readonly repo: NeoRepository;
  readonly publications: NeoPublicationRepository;
  readonly asks: NeoConversationAskRepository;
  readonly publish: ReturnType<typeof createNeoPublisher>;
  readonly agentTargets: NeoAgentWorkTargetRepository;
  readonly driverTargets: NeoWorkDriverTargetRepository;
  readonly workGoals: NeoWorkGoalRepository;
  readonly workContinues: NeoWorkContinueRepository;
  readonly askRecords: NeoAskRepository;
  readonly workPrs: NeoWorkPrRepository;
  readonly workChecks: NeoWorkCheckRepository;
  filePacks: readonly NeoPack[] = [];
  private readonly builtinPacks: NeoPack[];
  readPrs: NeoWorkPrReader = readGithubPrs;
  readonly consultations: NeoConsultationRepository;
  readonly consultationWaiters: NeoConsultationWaiterRepository;
  readonly reportWork: ReturnType<typeof createNeoWorkReporter>;
  readonly resolveAskOrigin: ReturnType<typeof createNeoAskOriginResolver>;
  readonly resolveWorkTarget: ReturnType<typeof createNeoWorkTargetResolver>;
  readonly notifyChanged: () => void;
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
      (work: NeoWork) => ({
        ref: this.driverTargets.readRef(work.id),
        goal: !!this.workDoneGoal(work.id)?.doneWhen,
        ask: this.askRecords.forWork(work.id),
        readAt: this.followReads.get(work.id) ?? null,
        since: this.driverTargets.readFollowAnchor(work.id) ?? work.updatedAt,
        superseded: this.driverTargets.readSupersededAt(work.id) !== null,
      }),
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
        const urls = extractNeoWorkPrUrls(work.report, card.stored?.prs);
        const prs = shouldReadNeoWorkPrs(card.stored, urls, Date.now())
          ? await this.readPrs(urls)
          : null;
        return { row: prs ? this.recordWorkPrs(work.id, prs, card.stored) : card.stored };
      },
      ['work', 'card'],
      'found'
    )
    .pipe(
      (work: NeoWork, card: NeoDoneCheckCard, followed: boolean, found: NeoDoneCheckFound) => ({
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
        found: NeoDoneCheckFound,
        followed: boolean
      ) => {
        await this.deliverDoneCheck(work, goal, found.row, {
          ask: card.ask,
          followedAt: followed ? work.updatedAt : undefined,
        });
        return true;
      },
      ['work', 'check', 'card', 'found', 'followed'],
      'check'
    )
    .endAsync('check') as (work: NeoWork, followed: boolean) => Promise<boolean>;
  private readonly replyRechecks = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly savedRules = new Map<string, NeoSavedRulesNote>();
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
    };
    this.repo = new NeoRepository(db.getDatabase(), () => hub.event('neo.changed', {}));
    this.publications = new NeoPublicationRepository(db.getDatabase());
    this.asks = new NeoConversationAskRepository(db.getDatabase());
    this.agentTargets = new NeoAgentWorkTargetRepository(db.getDatabase());
    this.driverTargets = new NeoWorkDriverTargetRepository(db.getDatabase());
    this.workGoals = new NeoWorkGoalRepository(db.getDatabase());
    this.workContinues = new NeoWorkContinueRepository(db.getDatabase());
    this.askRecords = new NeoAskRepository(db.getDatabase(), () => hub.event('neo.changed', {}));
    this.workPrs = new NeoWorkPrRepository(db.getDatabase());
    this.workChecks = new NeoWorkCheckRepository(db.getDatabase());
    this.builtinPacks = [
      createCodingPack({
        readPrs: (urls) => this.readPrs(urls),
        workPrs: this.workPrs,
        record: (workId, prs, before) => this.recordWorkPrs(workId, prs, before),
      }),
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
    this.resolveAskOrigin = createNeoAskOriginResolver({
      getBinding: (id) => this.repo.getBindingBySession(id),
      getPrompts: (sessionId, messageId) =>
        this.db.getSDKMessageRepo().getStoredPromptsByUuid(sessionId, messageId),
      getConsultation: (id) => this.consultations.get(id),
      getWork: (id) => this.repo.getWork(id),
      getRootBinding: () => this.repo.getBindingForConcern(null),
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
        void this.deliver(id, nudgeId, NEO_PUBLISH_NUDGE, id).catch((error) =>
          this.log.warn('Publish nudge failed', error)
        ),
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
      this.askRecords.markReminded(
        this.waitingReminders(input.producerInput).map((ask) => ask.id),
        Date.now()
      );
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

  dispose() {
    this.unsubscribe();
    for (const timer of this.replyRechecks.values()) clearTimeout(timer);
    this.replyRechecks.clear();
    this.processingStatus.clear();
    this.interruptedSessions.clear();
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
          systemPrompt: neoPrompt(concernId),
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
      .catch((error) => {
        const work = this.repo.getWork(id);
        if (work?.status === 'queued')
          this.repo.transitionWork(id, work, {
            status: 'failed',
            report:
              `Could not start the execution: ${error instanceof Error ? error.message : String(error)}`.slice(
                0,
                12000
              ),
          });
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
    const failed = this.repo.transitionWork(id, work, {
      status: 'failed',
      report:
        'Neo did not choose where this work runs. Ask Neo again and say which project, Space or chat it belongs to.',
    });
    if (failed) await this.returnReport(failed);
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
      const interrupted = this.repo.transitionWork(work.id, work, {
        status: 'failed',
        report: `${DRIVER_START_INTERRUPTED} ${target.verb === 'start' ? target.adapter : target.ref.adapter} confirmed it. It may still have started; check work.find before trying again.`,
      });
      if (interrupted) await this.returnReport(interrupted);
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
    const failed = this.repo.transitionWork(queued.id, queued, {
      status: 'failed',
      report: `Could not start the execution: ${result.failure}`.slice(0, 12000),
    });
    if (failed) await this.returnReport(failed);
  }

  private neverStarted(work: NeoWork): boolean {
    return (
      work.status === 'failed' &&
      !!this.driverTargets.get(work.id) &&
      !this.driverTargets.readRef(work.id)
    );
  }

  async retryWork(
    id: string
  ): Promise<{ ok: true; work: NeoWork } | { ok: false; reason: string }> {
    const work = this.repo.getWork(id);
    if (!work) return { ok: false, reason: 'work_not_found' };
    if (work.report?.startsWith(DRIVER_START_INTERRUPTED))
      return {
        ok: false,
        reason:
          'Starting was interrupted and it may have started anyway; check work.find before proposing it again.',
      };
    if (!this.neverStarted(work))
      return {
        ok: false,
        reason:
          'Only a hand-off that failed before it started can be retried; use neo.work.continue for started work.',
      };
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
    const failed = this.repo.transitionWork(work.id, work, {
      status: 'failed',
      report: `The chosen execution chat is no longer available: ${reason}.`,
    });
    if (failed) await this.returnReport(failed);
  }

  private async failErroredTurn(work: NeoWork): Promise<void> {
    if (!work.sessionId) return;
    const failure = this.db.getSDKMessageRepo().getTurnErrorResultSubtype(work.sessionId, work.id);
    if (!failure) return;
    const failed = this.repo.transitionWork(work.id, work, {
      status: 'failed',
      report: `The chat stopped with an error before reporting: ${failure}.`,
    });
    if (failed) await this.returnReport(failed);
  }

  async recover(): Promise<void> {
    await this.recoverConsultations();
    for (const work of this.repo.listWork()) {
      try {
        if (work.status === 'queued') await this.start(work.id);
        await this.reconcile(work.id);
      } catch (error) {
        this.log.warn('Neo recovery pending', error);
      }
    }
    for (const ask of this.askRecords.list().filter(isNeoAskLive)) {
      try {
        this.runAskPackTicks(ask.id);
      } catch (error) {
        this.log.warn('Neo ask ticks pending', error);
      }
    }
  }

  async refreshDriverWork(): Promise<void> {
    const works = this.repo.listWork();
    for (const work of works) {
      const ref = work.status === 'queued' ? this.driverTargets.readRef(work.id) : null;
      if (!ref) continue;
      await this.settleDriverWork(work, ref).catch((error) =>
        this.log.warn('Driver work refresh pending', error)
      );
    }
    for (const work of works.filter((item) => item.status === 'reported')) {
      await this.followWork(work, Date.now()).catch((error) =>
        this.log.warn('Reported work follow-up pending', error)
      );
    }
    for (const workId of this.workPrs.listOpen()) {
      await this.refreshWorkPrs(workId, Date.now()).catch((error) =>
        this.log.warn('Work pull request refresh pending', error)
      );
    }
  }

  private readonly refreshWorkPrs = (superpipe({})('neo-work-pr-refresh') as PipelineAPI)
    .input(['workId', 'now'])
    .pipe((workId: string) => ({ work: this.repo.getWork(workId) }), 'workId', 'current')
    .pipe(
      (current: { work: NeoWork | null }) =>
        current.work ? { value: current.work } : { reason: null },
      'current',
      'result:work'
    )
    .pipe(
      (work: NeoWork) => {
        const ask = this.askRecords.forWork(work.id);
        return {
          ask,
          goal: neoWorkDoneGoal(work.id, this.workGoals.get(work.id), ask),
          row: this.workPrs.get(work.id),
          session: !!this.db.getSession(work.originSessionId),
        };
      },
      'work',
      'card'
    )
    .pipe(
      (work: NeoWork, card: NeoWorkPrCard, now: number) =>
        requireNeoWorkPrRefresh(work, { ...card, goal: !!card.goal }, now, NEO_WORK_CLOSED_DONE),
      ['work', 'card', 'now'],
      'result:row'
    )
    .pipe(
      async (work: NeoWork) => ({
        read: await readNeoPackEvidence(this.packs(), work, (id, error) =>
          this.log.warn(`Neo pack ${id} evidence read failed`, error)
        ),
      }),
      ['work', 'row'],
      'refreshed'
    )
    .pipe((work: NeoWork) => ({ row: this.workChecks.get(work.id) }), 'work', 'told')
    .pipe(
      (
        work: NeoWork,
        card: NeoWorkPrCard,
        refreshed: NeoWorkPrRefreshed,
        told: NeoWorkTold,
        now: number
      ) =>
        refreshed.read
          ? planNeoDoneCheck(refreshed.read.evidence, told.row, refreshed.read.read, now, {
              quietSince: work.updatedAt,
              remindable: !card.ask || card.ask.status === 'open',
            })
          : 'wait',
      ['work', 'card', 'refreshed', 'told', 'now'],
      'plan'
    )
    .pipe(
      (plan: ReturnType<typeof planNeoDoneCheck>, card: NeoWorkPrCard) =>
        requireNeoWorkPrDelivery(plan, isNeoAskLive(card.ask)),
      ['plan', 'card'],
      'result:delivery'
    )
    .pipe(
      async (
        work: NeoWork,
        card: NeoWorkPrCard,
        refreshed: NeoWorkPrRefreshed,
        told: NeoWorkTold,
        delivery: 'deliver' | 'remind'
      ) => {
        if (!card.goal) return;
        await this.deliverDoneCheck(
          work,
          card.goal,
          this.workPrs.get(work.id),
          delivery === 'remind'
            ? {
                ask: card.ask,
                ready: true,
                followedAt: told.row?.toldAt ?? work.updatedAt,
              }
            : { stale: !refreshed.read?.read.ok, ask: card.ask }
        );
      },
      ['work', 'card', 'refreshed', 'told', 'delivery']
    )
    .endAsync('delivery') as (workId: string, now: number) => Promise<unknown>;

  packs(): NeoPack[] {
    return neoPacks({
      builtins: this.builtinPacks,
      filePacks: this.filePacks,
      enabled: NEO_DEFAULT_PACKS,
    });
  }

  private recordWorkPrs(
    workId: string,
    prs: readonly NeoWorkPr[],
    before: NeoWorkPrRow | null
  ): NeoWorkPrRow | null {
    const row = this.workPrs.record(workId, prs, Date.now());
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
    notifyChanged: () => this.notifyChanged(),
    noteUnsettled: async (work, ref, outcome) => {
      await this.noteDriverStall(work, outcome);
      await this.noteDriverStuck(work);
      await this.noteDriverNeedsYou(work, ref, outcome);
    },
    forgetActivity: (workId) => this.activitySeen.delete(workId),
    transition: (work, settled) =>
      this.repo.transitionWork(work.id, work, {
        status: settled.status,
        report: settled.report.slice(0, 12000),
      }),
    anchorFollow: (workId, at) => this.driverTargets.recordFollowAnchor(workId, at),
    returnReport: (work) => this.returnReport(work),
  };

  private workDoneGoal(workId: string): NeoWorkGoal | null {
    return neoWorkDoneGoal(workId, this.workGoals.get(workId), this.askRecords.forWork(workId));
  }

  private continueBudget(work: NeoWork, now: number): string | null {
    return readContinueBudget(this.workContinues.get(work.id), work.createdAt, now);
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
      work.originSessionId
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
      work.originSessionId
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
            `${work.id}:needs-you:${plan.notify}`,
            driverNeedsYouNote(work, ref, card.state?.lastReply),
            work.originSessionId
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
        await this.deliver(item.sessionId, requestId, content, item.originSessionId);
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
      await this.deliver(item.originSessionId, `neo-consult:${id}:reply`, content, item.sessionId);
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
    if (await this.checkDone(work, false)) return;
    const rootId = await this.open(null);
    if (work.concernId) {
      await returnWorkThroughHolder(this, work, rootId);
      return;
    }
    const targets = new Set([rootId, work.originSessionId]);
    const retries = this.driverTargets.readRetries(work.id);
    const retryNote =
      this.neverStarted(work) && !work.report?.startsWith(DRIVER_START_INTERRUPTED)
        ? ` ${fillPrompt(NEO_WORK_RETURNED_RETRY, {
            retried: retries
              ? fillPrompt(NEO_WORK_RETURNED_RETRIED, {
                  count: String(retries),
                  times: retries === 1 ? 'time' : 'times',
                })
              : '',
          })}`
        : '';
    const content = `${fillPrompt(NEO_WORK_RETURNED, { retry: retryNote, summary: NEO_WORK_SUMMARY_NOTE })}\n${JSON.stringify({ workId: work.id, originSessionId: work.originSessionId, originMessageId: work.originMessageId, concernId: work.concernId, status: work.status, executionSessionId: work.sessionId, title: work.title, report: work.report })}`;
    for (const target of targets) {
      if (this.db.getSession(target))
        await this.deliver(
          target,
          neoWorkReturnMessageId(work.id, retries, this.workContinues.get(work.id)?.count ?? 0),
          content,
          work.sessionId ?? work.originSessionId
        );
    }
  }

  private readonly runAskPackTicks = (superpipe({})('neo-ask-pack-ticks') as PipelineAPI)
    .input(['askId'])
    .pipe((askId: string) => ({ ask: this.askRecords.get(askId) }), 'askId', 'read')
    .pipe(requireNeoPackTickable, 'read', 'result:ticks')
    .pipe(
      (ask: NeoAsk) => ({
        works: ask.workIds.flatMap((id) => this.repo.getWork(id) ?? []),
        rows: this.workPrs.list(ask.workIds),
      }),
      'ticks',
      'linked'
    )
    .pipe(
      (ask: NeoAsk, linked: { works: NeoWork[]; rows: NeoWorkPrRow[] }) => ({
        ticks: planNeoPackTicks(
          ask,
          neoAskPrEvidence(linked.works, linked.rows),
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
        await this.deliver(work.originSessionId, note.id, note.content, work.originSessionId);
        return { at: Date.now() };
      },
      ['work', 'note'],
      'sent'
    )
    .pipe(
      (
        work: NeoWork,
        found: NeoDoneCheckFound,
        options: NeoDoneCheckDelivery,
        sent: { at: number }
      ) => {
        if (!found.row) return;
        const ready = options.ready ?? false;
        this.workPrs.markDelivered(work.id, neoWorkPrSignature(found.row.prs), sent.at, ready);
        this.workChecks.markTold(
          work.id,
          neoEvidenceSignature(neoWorkPrEvidence(found.row.prs)),
          sent.at,
          ready
        );
      },
      ['work', 'found', 'options', 'sent']
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
    originSessionId: string
  ): Promise<void> {
    const key = `${sessionId}:${messageId}`;
    const existing = this.deliveries.get(key);
    if (existing) return existing;
    const delivery = this.enqueueDelivery(sessionId, messageId, content, originSessionId).finally(
      () => this.deliveries.delete(key)
    );
    this.deliveries.set(key, delivery);
    return delivery;
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
