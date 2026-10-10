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
  NEO_WORK_CONTINUE_LIMIT,
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
import { NeoWorkDriverTargetRepository } from '../../storage/repositories/neo-work-driver-target-repository.ts';
import { NeoWorkContinueRepository } from '../../storage/repositories/neo-work-continue-repository.ts';
import { NeoWorkGoalRepository } from '../../storage/repositories/neo-work-goal-repository.ts';
import {
  NeoWorkPrRepository,
  type NeoWorkPrRow,
} from '../../storage/repositories/neo-work-pr-repository.ts';
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
  readDriverLive,
  readDriverSendBaseline,
  readDriverSent,
  messageOpening,
  readDriverLanded,
  decideCardLiveStatus,
  readDriverNeedsYou,
  readDriverSettlement,
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
import { effectiveNeoPreference, planNeoAlignment } from './model-preference.ts';
import {
  type NeoSavedRulesNote,
  planNeoSavedRulesAppend,
  planNeoSavedRulesNote,
  withNeoSavedRules,
} from './saved-rules.ts';
import { neoPrompt } from './prompt.ts';
import { createNeoPublisher } from './publication-operation.ts';
import { neoCoordinatorAllowedTools, neoCoordinatorNativeTools } from './session-policy.ts';
import { neoAskStartedWork, readNeoTurnReply } from './turn-reply.ts';
import { createNeoWorkReporter } from './work-report.ts';
import { returnWorkThroughHolder } from './work-return.ts';
import { createNeoWorkTargetResolver } from './work-target.ts';
import {
  extractNeoWorkPrUrls,
  isNeoWorkPrWaiting,
  NEO_WORK_PR_READ_MS,
  neoWorkPrSignature,
  planNeoWorkPrRefresh,
  readGithubPrs,
  shouldReadNeoWorkPrs,
  type NeoWorkPrReader,
} from './work-prs.ts';
import { closeNeoWork, type NeoWorkCloseOutcome, type NeoWorkCloseResult } from './work-close.ts';

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
    const offDeleted = events.subscribe(
      'session.deleted',
      ({ sessionId }) => this.forgetSession(sessionId),
      { subscriberName: 'neo-session-forget' }
    );
    this.unsubscribe = () => {
      offUpdated();
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
    return receipt;
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
        workspacePath: null,
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

  async continueWork(
    id: string,
    message: string,
    now = Date.now()
  ): Promise<{ ok: true; work: NeoWork } | { ok: false; reason: string }> {
    const work = this.repo.getWork(id);
    const ref = this.driverTargets.readRef(id);
    if (!work || !ref) return { ok: false, reason: 'Only started driver work can be continued.' };
    if (work.status !== 'queued' && work.status !== 'reported')
      return { ok: false, reason: `This work already ${work.status}; it cannot be continued.` };
    const budget = this.continueBudget(work, now);
    if (budget) return { ok: false, reason: budget };
    if (this.continuing.has(id))
      return { ok: false, reason: 'This work is already being continued; wait for that first.' };
    this.continuing.add(id);
    try {
      const sending = withWorkGoal(message, this.workDoneGoal(id));
      const probe = await this.readSendBaseline(ref, work, sending);
      const outcome = await invokeOperation(
        this.sessions.getOperationRegistry(),
        'work.send',
        { ref, message: sending },
        driverWorkCaller(work)
      );
      const sent = readDriverOutcome({ verb: 'send', ref }, outcome);
      if ('failure' in sent) return { ok: false, reason: sent.failure };
      this.driverTargets.recordStartedAt(id, 'queued' in sent ? null : probe.baseline);
      this.driverTargets.recordSent(id, probe.sent);
      const continued = this.workContinues.record(id, message, now);
      const count = continued?.count ?? 1;
      const current = this.repo.getWork(id) ?? work;
      if (current.status !== 'queued' && current.status !== 'reported')
        return {
          ok: false,
          reason: `The message was sent, but this work was ${current.status} meanwhile; it stays ${current.status}.`,
        };
      const reopened = this.repo.transitionWork(id, current, {
        status: 'queued',
        report: `Continued ${count}/${NEO_WORK_CONTINUE_LIMIT}: ${message.slice(0, 300)}`,
      });
      this.askRecords.reopenForWork(id);
      return { ok: true, work: reopened ?? this.repo.getWork(id) ?? current };
    } finally {
      this.continuing.delete(id);
    }
  }

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
      sent: readDriverSent(outcome, message),
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
  }

  async refreshDriverWork(): Promise<void> {
    for (const work of this.repo.listWork()) {
      const ref = work.status === 'queued' ? this.driverTargets.readRef(work.id) : null;
      if (!ref) continue;
      await this.settleDriverWork(work, ref).catch((error) =>
        this.log.warn('Driver work refresh pending', error)
      );
    }
    for (const workId of this.workPrs.listOpen()) {
      await this.refreshWorkPrs(workId).catch((error) =>
        this.log.warn('Work pull request refresh pending', error)
      );
    }
  }

  private async refreshWorkPrs(workId: string): Promise<void> {
    const work = this.repo.getWork(workId);
    const ask = this.askRecords.forWork(workId);
    const goal = neoWorkDoneGoal(workId, this.workGoals.get(workId), ask);
    const row = this.workPrs.get(workId);
    if (work?.status !== 'reported' || work.report === NEO_WORK_CLOSED_DONE || !goal || !row)
      return;
    if (Date.now() - row.readAt < NEO_WORK_PR_READ_MS || !this.db.getSession(work.originSessionId))
      return;
    const prs = await this.readPrs(row.prs.map((pr) => pr.url));
    if (!prs) this.workPrs.recordFailedRead(workId, Date.now());
    const next = prs ? this.recordWorkPrs(workId, prs, row) : row;
    if (next && planNeoWorkPrRefresh(next, !!prs, Date.now()) === 'deliver')
      await this.deliverDoneCheck(work, goal, next, { stale: !prs, ask });
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
    const startedAt = this.driverTargets.readStartedAt(work.id);
    const sent = this.driverTargets.readSent(work.id);
    const since = startedAt ?? sent?.inputBefore ?? null;
    const outcome = await invokeOperation(
      this.sessions.getOperationRegistry(),
      'work.status',
      { ref, ...(since !== null ? { since } : {}) },
      driverWorkCaller(work)
    );
    const landed = startedAt === null ? readDriverLanded(outcome, sent) : null;
    if (landed !== null) this.driverTargets.recordStartedAt(work.id, landed);
    const live = readDriverLive(outcome);
    const cardStatus = live
      ? decideCardLiveStatus(live, startedAt ?? landed, this.driverTargets.readLiveStatus(work.id))
      : null;
    if (
      live &&
      cardStatus &&
      this.driverTargets.recordLive(work.id, cardStatus, live.link, live.remoteLink)
    )
      this.notifyChanged();
    const settled =
      landed === null &&
      readDriverSettlement(
        work,
        outcome,
        Date.now(),
        startedAt,
        !!this.workContinues.get(work.id) || this.driverTargets.get(work.id)?.verb === 'send',
        sent?.opening ?? (messageOpening(work.instruction) || null)
      );
    if (!settled) {
      await this.noteDriverStall(work, outcome);
      await this.noteDriverStuck(work);
      return this.noteDriverNeedsYou(work, ref, outcome);
    }
    this.activitySeen.delete(work.id);
    const done = this.repo.transitionWork(work.id, work, {
      status: settled.status,
      report: settled.report.slice(0, 12000),
    });
    if (done) await this.returnReport(done);
  }

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

  private async noteDriverNeedsYou(
    work: NeoWork,
    ref: WorkRef,
    outcome: OperationOutcome
  ): Promise<void> {
    const state = readDriverNeedsYou(outcome);
    if (!state) return;
    const noted = this.driverTargets.readNeedsYouSince(work.id);
    if (!state.needsYou) {
      if (noted !== null) this.driverTargets.recordNeedsYouSince(work.id, null);
      return;
    }
    if (noted !== null) return;
    if (this.db.getSession(work.originSessionId))
      await this.deliver(
        work.originSessionId,
        `${work.id}:needs-you:${state.since}`,
        driverNeedsYouNote(work, ref, state.lastReply),
        work.originSessionId
      );
    this.driverTargets.recordNeedsYouSince(work.id, state.since);
  }

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
        await this.returnReport(work);
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
      await this.returnReport(work);
  }

  private async returnReport(work: NeoWork): Promise<void> {
    if (work.status === 'reported' && work.report === NEO_WORK_CLOSED_DONE) return;
    if (await this.askDoneCheck(work)) return;
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
          neoWorkReturnMessageId(work.id, retries),
          content,
          work.sessionId ?? work.originSessionId
        );
    }
  }

  private async askDoneCheck(work: NeoWork): Promise<boolean> {
    const ask = this.askRecords.forWork(work.id);
    const goal = neoWorkDoneGoal(work.id, this.workGoals.get(work.id), ask);
    if (work.status !== 'reported' || !goal?.doneWhen || !this.driverTargets.get(work.id))
      return false;
    if (!this.db.getSession(work.originSessionId)) return false;
    const stored = this.workPrs.get(work.id);
    const continued = this.workContinues.get(work.id)?.count ?? 0;
    if (
      !stored &&
      this.hasDelivery(work.originSessionId, neoDoneCheckMessageId(work.id, continued))
    )
      return true;
    const urls = extractNeoWorkPrUrls(work.report);
    const prs = shouldReadNeoWorkPrs(stored, urls, Date.now()) ? await this.readPrs(urls) : null;
    const row = prs ? this.recordWorkPrs(work.id, prs, stored) : stored;
    if (!row || !isNeoWorkPrWaiting(row.prs)) await this.deliverDoneCheck(work, goal, row, { ask });
    return true;
  }

  private async deliverDoneCheck(
    work: NeoWork,
    goal: NeoWorkGoal,
    row: NeoWorkPrRow | null,
    { stale = false, ask }: { stale?: boolean; ask?: NeoAsk | null } = {}
  ): Promise<void> {
    const continued = this.workContinues.get(work.id)?.count ?? 0;
    await this.deliver(
      work.originSessionId,
      neoDoneCheckMessageId(work.id, continued, row?.revision),
      driverDoneCheckNote(work, goal, continued, this.continueBudget(work, Date.now()), {
        prs: row?.prs,
        stale,
        ask,
        cards: ask
          ? projectNeoAskCards(
              work.id,
              ask.workIds.flatMap((id) => this.repo.getWork(id) ?? []),
              this.workPrs.list(ask.workIds)
            )
          : [],
      }),
      work.originSessionId
    );
    if (row) this.workPrs.markDelivered(work.id, neoWorkPrSignature(row.prs));
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
