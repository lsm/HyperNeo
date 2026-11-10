import { createWorkerNameSource } from '../drivers/worker-names.ts';
import type { NeoWorkerNameSource } from './worker-name.ts';
import { sweepNeoTrackerMirrors } from './tracker-mirror.ts';
import { createQuestionRetirement } from './question-retirement.ts';
import { neoStallReminderWrite } from '../../storage/repositories/neo-stall-reminder-write.ts';
import { NeoSpeech } from './speech.ts';
import { ensurePrompt } from '../agent/message-delivery-outbox.ts';
import type { RunDbOp } from '../../storage/db-gateway/db-op.ts';
import { neoSessionTrackWrites } from '../../storage/repositories/neo-session-track-write.ts';
import { neoAskSettlementWrites } from '../../storage/repositories/neo-ask-settlement.ts';
import { createNeoQuestionAnswerDelivery } from './question-answer-delivery.ts';
import { wakeFailedHyperneoSession } from './query-failure.ts';
import type { UUID } from 'node:crypto';
import type { SDKMessage, SDKUserMessage } from '@hyperneo/shared/sdk';
import {
  NeoSessionMessageRepository,
  WORKER_BATCH_SENDER,
} from '../../storage/repositories/neo-session-message-repository.ts';
import { gatewayFor } from '../../storage/db-gateway/db-gateway.ts';
import { globalSettingsWrites } from '../../storage/repositories/global-settings-writes.ts';
import { neoWakeQueueWrite } from '../../storage/repositories/neo-wake-queue-repository.ts';
import { sdkNeoWakeQueue } from '../../storage/repositories/sdk-message-transactions.ts';
import { createMailboxEntry } from '../mailbox/entry.ts';
import { decodeUlidTimestamp } from '../mailbox/ulid.ts';
import { requireHumanCard } from './human-card.ts';
import {
  createNeoWorkerQuestionWriter,
  expectedReportLanguage,
  stageNeoWorkerQuestion,
} from './question-operations.ts';
import {
  sessionSender,
  type SessionReportHandler,
  type SendMessageResultSchema,
} from '../messaging/message-send.ts';
import { enqueueMailboxEntry } from '../mailbox/enqueue.ts';
import { wrapSessionContent } from '../messaging/session-envelope.ts';
import { publishDroppedWork } from './dropped-work.ts';
import { wakeStalledAsks } from './stalled-asks.ts';
import type { SessionSchedule } from '../../storage/repositories/session-schedule-repository.ts';
import { neoDerivedId } from './derived-id.ts';
import { receivedNeoHumanInput } from './human-input.ts';
import { parseProcessingState } from '../session/space-session-reads.ts';
import { workerIdentity } from '@hyperneo/shared/types/worker-identity';
import { z } from 'zod';
import { readNeoSessionSource } from './session-open-source.ts';
import { presentNeoPublications } from './publication-presentation.ts';
import type { NeoPublication } from '@hyperneo/shared/types/neo-publication';
import { fillPrompt, NEO_PREFERENCE_CHANGED, NEO_SESSION_TRACK } from '@hyperneo/prompts';
import { listPackPreferences, type PackPreferenceChange } from './preference-operations.ts';
import type {
  GlobalSettings,
  MessageHub,
  Provider,
  Session,
  SessionConfig,
} from '@hyperneo/shared';
import type { NeoQuestion, NeoQuestionSource, NeoTodo } from '@hyperneo/shared/types/neo-ask';
import type { NeoPublicationInput } from '@hyperneo/shared/types/neo-publication';
import type { NeoWorkingEvent } from '@hyperneo/shared/types/neo-snapshot';
import {
  type NeoModelPreference,
  neoStandingRules,
  neoTodoLimits,
} from '@hyperneo/shared/types/settings';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { Database } from '../../storage/database.ts';
import { NeoAskTodoRepository } from '../../storage/repositories/neo-ask-todo-repository.ts';
import { NeoConversationAskRepository } from '../../storage/repositories/neo-conversation-ask-repository.ts';
import {
  NeoPublicationRepository,
  neoPublicationWrites,
} from '../../storage/repositories/neo-publication-repository.ts';
import { NeoRepository } from '../../storage/repositories/neo-repository.ts';
import { NeoSessionSeenRepository } from '../../storage/repositories/neo-session-seen-repository.ts';
import {
  NeoTodoSessionRepository,
  neoTodoSessionReads,
} from '../../storage/repositories/neo-todo-session-repository.ts';
import { createArtifactRefReader } from '../artifacts/read-operations.ts';
import { sessionWorkerRef } from './worker-identity.ts';
import type { WorkRef } from '../drivers/types.ts';
import { WorkTurnRepository } from '../../storage/repositories/work-turn-repository.ts';
import { runLagPhase } from '../event-loop-activity.ts';
import type { DaemonInternalEventMap, InternalEventBus } from '../internal-event-bus.ts';
import { Logger } from '../logger.ts';
import { renderAddress } from '../mailbox/address.ts';
import type { MailboxMessageContent } from '../mailbox/entry.ts';
import { handoffPromptToMailbox } from '../mailbox/handoff.ts';
import { invokeOperation } from '../operations/invoke.ts';
import { onHumanDevicesReset } from '../pairing/human-device-reset.ts';
import type { SessionManager } from '../session/session-manager.ts';
import { driverWorkCaller } from './driver-work.ts';
import { WorkDeliveryInputRepository } from '../../storage/repositories/work-delivery-input-repository.ts';
import { catchUpWorkerTurns, planTurnCatchUp, recordWorkerTurns } from './turn-recording.ts';
import { neoFolderPath, neoUserFolder } from './folder.ts';
import { openNeoDefaultSession } from './inbox.ts';
import {
  effectiveNeoPreference,
  neoCompactPercentFor,
  planNeoAlignment,
} from './model-preference.ts';
import { neoEnabledPacks, neoPackBriefs, neoPacks } from './pack-selection.ts';
import type { NeoPack, NeoPackBrief, NeoPackRuntime } from './pack-contract.ts';
import { neoPromptTools, planNeoSessionConfig } from './session-config.ts';
import { changeSessionToolChoice } from '../tools/change-session-tool-choice.ts';
import { createNeoPublisher } from './publication-operation.ts';
import {
  neoSessionQuestionNote,
  type NeoSessionNotice,
  type NeoSessionNoticeGroup,
} from './session-watch.ts';
import { NeoSessionWatcher } from './session-watcher.ts';
import { findNeoSessionNotice } from './session-track.ts';
import { createNeoTodoRunner, type NeoTodoRunner } from './todo-runner.ts';
import { neoWorkingKey, readNeoWorking } from './working.ts';

const MODEL_CHANGE_SOURCES = new Set([
  'model-switch',
  'model-switch-rollback',
  'model-refusal-fallback',
  'runtime-settings',
]);

export class NeoService {
  readonly repo: NeoRepository;
  readonly speech: NeoSpeech;
  readonly publications: NeoPublicationRepository;
  readonly asks: NeoConversationAskRepository;
  readonly publish: ReturnType<typeof createNeoPublisher>;
  readonly todos: NeoAskTodoRepository;
  readonly todoSessions: NeoTodoSessionRepository;
  readonly todoRunner: NeoTodoRunner;
  readonly runDbOp: RunDbOp;
  get sessionNotices(): NeoSessionNotice[] {
    return this.sessionWatcher.sessionNotices;
  }

  get sessionNoticeGroups(): NeoSessionNoticeGroup[] {
    return this.sessionWatcher.sessionNoticeGroups;
  }

  get trackableNotices(): NeoSessionNotice[] {
    return [
      ...this.sessionWatcher.sessionNoticeGroups.flatMap((group) => group.notices),
      ...this.sessionWatcher.sessionNotices,
    ];
  }

  workerNames?: NeoWorkerNameSource;

  readonly sessionWatcher: NeoSessionWatcher;
  private watching: Promise<unknown> | null = null;
  private disposed = false;
  private catchingUpTurns = false;
  private readonly turnsSeen = new Map<string, number>();
  filePacks: readonly NeoPack[] = [];
  readonly builtinPacks: NeoPack[];
  private readonly defaultPacks: readonly string[];
  readonly packOperations: NeoPackRuntime['operations'];
  readonly notifyChanged: () => void;
  private readonly noteWorking: () => void;
  private workingKey = '';
  readonly notifyPublicationsChanged: (conversationId: string) => void;
  private triggerTimer?: ReturnType<typeof setTimeout>;
  private readonly triggerDeliveryRetryAt = new Map<string, number>();
  private opening: Promise<string> | null = null;
  private readonly deliveries = new Map<string, Promise<void>>();
  private readonly log = new Logger('Neo');
  private readonly unsubscribe: () => void;

  constructor(
    composePacks: (service: NeoService) => NeoPackRuntime,
    readonly db: Database,
    readonly sessions: SessionManager,
    hub: MessageHub,
    readonly events: InternalEventBus<DaemonInternalEventMap>,
    readonly publishSettings?: (settings: GlobalSettings) => void,
    readonly userFolder = neoUserFolder()
  ) {
    this.runDbOp = gatewayFor(db.getDatabase()).run.bind(gatewayFor(db.getDatabase()));
    this.notifyChanged = () => {
      hub.event('neo.changed', {});
      void events.publish('neo.changed', {});
    };
    this.notifyPublicationsChanged = (conversationId) => {
      hub.event('neo.publications.changed', { conversationId });
    };
    this.sessionWatcher = new NeoSessionWatcher({
      db,
      defaultSessionId: () => this.defaultSessionId(),
      announceSessionNoticeGroup: (group) => hub.event('neo.session.notices', { group }),
      seen: new NeoSessionSeenRepository(db.getDatabase()),
      announceSessionNotice: (notice) => hub.event('neo.session.notice', notice),
      tellSessionQuestion: (root, notice) =>
        this.deliverForward(
          root,
          `neo-session-question:${notice.key}:${notice.at}`,
          neoSessionQuestionNote(notice),
          root,
          'event'
        ),
      log: this.log,
      registry: () => this.sessions.getOperationRegistry(),
      followedCardRefs: (now) => this.followedCardRefs(now),
      recordTurns: (ref) => recordWorkerTurns(ref, this.turnRecording()),
      mutedSessions: () => this.db.getGlobalSettings?.().neo?.mutedSessions,
      notifyChanged: () => this.notifyChanged(),
    });
    this.repo = new NeoRepository(db.getDatabase(), this.notifyChanged);
    this.speech = new NeoSpeech(
      hub,
      this.runDbOp,
      (id) => this.repo.getBindingBySession(id)?.kind === 'neo',
      undefined,
      undefined,
      async (id, listening) => {
        if (this.sessions.getCachedSession(id)?.getProcessingState().status === 'processing')
          await ensurePrompt({
            db: this.db.getDatabase(),
            sdkMessageRepo: this.db.getSDKMessageRepo(),
            jobQueue: this.db.getJobQueueRepo(),
            sessionId: id,
            message: {
              type: 'user',
              uuid: crypto.randomUUID() as UUID,
              session_id: id,
              parent_tool_use_id: null,
              inputKind: 'system',
              isSynthetic: true,
              message: {
                role: 'user',
                content: [
                  {
                    type: 'text',
                    text: listening
                      ? 'The human is now listening.'
                      : 'The human stopped listening.',
                  },
                ],
              },
            } as SDKUserMessage,
            origin: 'system',
            delivery: { origin: 'space_inject', injectedMidTurn: true },
          });
      },
      (id) => !!this.db.getSession(id)
    );
    this.publications = new NeoPublicationRepository(db.getDatabase());
    this.asks = new NeoConversationAskRepository(db.getDatabase());
    this.todos = new NeoAskTodoRepository(db.getDatabase(), this.notifyChanged, (setting) => {
      if (setting === 'preferences') {
        void this.refreshPackPreferences();
        return;
      }
      this.publishSettings?.(db.getGlobalSettings());
      void this.rulesChanged();
    });
    this.todoSessions = new NeoTodoSessionRepository(db.getDatabase());
    const fallbackWorkerNames = createWorkerNameSource(() => [], {
      machine: '',
      folder: this.userFolder,
      name: this.userFolder,
    });
    this.todoRunner = createNeoTodoRunner({
      write: gatewayFor(db.getDatabase()).run.bind(gatewayFor(db.getDatabase())),
      store: this.todos,
      sessions: this.todoSessions,
      workerNames: () => this.workerNames ?? fallbackWorkerNames,
      invoke: (caller, name, input) =>
        invokeOperation(this.sessions.getOperationRegistry(), name, input, caller),
      packs: () => this.installedPacks(),
      enabledPacks: () => this.packs(),
      tell: (ask, todo, note, key, kind) => {
        return this.deliverForward(
          ask.sessionId,
          key ?? `neo-todo:${todo.id}:${todo.updatedAt}`,
          note,
          ask.sessionId,
          kind
        );
      },
      changed: this.notifyChanged,
      limits: () => neoTodoLimits(this.db.getGlobalSettings?.().neo),
    });
    const runtime = composePacks(this);
    this.builtinPacks = runtime.packs;
    this.defaultPacks = runtime.defaults;
    this.packOperations = runtime.operations;
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
      receivedHumanInput: (sessionId, id) => !!receivedNeoHumanInput(this, sessionId, id),
      currentHumanInputs: (sessionId) => this.currentInputIds(sessionId),
      sourceSession: (sessionId) => {
        const conversation = this.repo.conversationId();
        if (!conversation) return undefined;
        const messages = new NeoSessionMessageRepository(this.db.getDatabase());
        const sources = this.currentInputIds(sessionId).map((id) => {
          const message = messages.get(conversation, id);
          return message?.toSession === sessionId &&
            message.fromSession !== sessionId &&
            message.fromSession !== WORKER_BATCH_SENDER
            ? message.fromSession
            : undefined;
        });
        return sources.length && sources.every((source) => source === sources[0])
          ? sources[0]
          : undefined;
      },
      getBinding: (id) => this.repo.getBindingBySession(id),
      getRootBinding: () => this.repo.defaultBinding(),
      hasProject: (id) => !!this.repo.getProject(id),
      publication: (conversation, id) => this.publications.get(conversation, id),
      lookupSession: async (id) => (await this.resolveSessionSource(id)).status,
      append: (input) => this.db.gateway.call(neoPublicationWrites, 'append', input),
      speech: (sessionId, version, text) => this.speech.publish(sessionId, version, text),
      notify: notifyPublication,
      artifact: createArtifactRefReader(() => this.db.getDatabase()),
    });
    const offSpeech = events.subscribe(
      'sdk.message',
      ({ sessionId, message }) =>
        sessionId
          ? this.speech
              .complete(sessionId, message as SDKMessage)
              .catch((error) => this.log.warn('Session speech delivery failed', error))
          : undefined,
      { subscriberName: 'session-spoken-replies' }
    );
    const offUpdated = events.subscribe(
      'session.updated',
      async ({ sessionId, processingState, session }) => {
        const status = processingState?.status;
        const bound = status || session?.status ? this.repo.getBindingBySession(sessionId) : null;
        if (bound?.kind === 'neo') {
          this.noteWorking();
          if (status) this.notifyChanged();
        }
      },
      { subscriberName: 'neo-work-return' }
    );
    const offModelSwitch = events.subscribe(
      'session.updated',
      async ({ sessionId, source }) => {
        if (!source || !MODEL_CHANGE_SOURCES.has(source)) return;
        if (sessionId !== this.defaultSessionId()) return;
        const preferences = this.db.getGlobalSettings().neo?.preferences;
        if (!preferences) return;
        await this.applyCompactPercentNow(sessionId, preferences).catch((error) =>
          this.log.warn('Neo auto-compact percentage not applied', error)
        );
      },
      { subscriberName: 'neo-model-compact' }
    );
    const offStatus = events.subscribe(
      'messages.statusChanged',
      ({ sessionId }) => {
        if (sessionId && this.repo.getBindingBySession(sessionId)) this.notifyChanged();
      },
      { subscriberName: 'neo-ask-delivery' }
    );
    const offDeleted = events.subscribe(
      'session.deleted',
      () => {
        this.noteWorking();
      },
      { subscriberName: 'neo-session-forget' }
    );
    const offQueryFailure = events.subscribe(
      'session.error',
      async (event) => {
        if (await wakeFailedHyperneoSession(db.getDatabase(), this.wakeNeo.bind(this), event))
          this.notifyChanged();
      },
      { subscriberName: 'neo-query-failure' }
    );
    const offHumanReset = onHumanDevicesReset(this.notifyPublicationsChanged);
    this.unsubscribe = () => {
      offSpeech();
      offHumanReset();
      offQueryFailure();
      offUpdated();
      offModelSwitch();
      offStatus();
      offDeleted();
    };
  }

  readonly notifyScheduleIdle = (schedule: SessionSchedule): void => {
    const conversationId = this.repo.conversationId();
    if (!conversationId) return;
    const publicationId = neoDerivedId(`schedule-idle:${schedule.id}:${schedule.nextRunAt}`);
    if (this.publications.get(conversationId, publicationId)) return;
    const name = this.db.getSession(schedule.target.id)?.title ?? schedule.target.id;
    const elapsed =
      schedule.cadence.kind === 'every'
        ? ` for ${Math.round((schedule.cadence.everyMs * 3) / 60_000)} minutes`
        : '';
    const suffix = ` has been idle${elapsed}, waiting for work.`;
    const text = `${name.slice(0, 2000 - suffix.length)}${suffix}`;
    const receipt = this.appendPublication({
      conversationId,
      publicationId,
      shortText: text,
      fullText: text,
      links: [],
    });
    if (!receipt.accepted) throw new Error(`Idle notice: ${receipt.reason}`);
    if (receipt.created) {
      this.notifyPublicationsChanged(conversationId);
      this.notifyChanged();
    }
  };

  private currentInputIds(sessionId: string): string[] {
    const state = parseProcessingState(this.db.getSession(sessionId)?.processingState);
    if (state.status !== 'processing') return [];
    if (Array.isArray(state.messageIds))
      return state.messageIds.filter((id): id is string => typeof id === 'string');
    return typeof state.messageId === 'string' ? [state.messageId] : [];
  }

  private appendPublication(input: NeoPublicationInput) {
    return this.publications.append(input);
  }

  modelPreference(): (NeoModelPreference & { saved: boolean }) | null {
    const fallback = this.defaultSessionId();
    const settings = this.db.getGlobalSettings?.();
    return effectiveNeoPreference(
      settings?.neo?.preferences,
      fallback ? (this.db.getSession(fallback)?.config ?? null) : null,
      settings?.thinkingLevel
    );
  }

  async saveModelPreference(preferences: NeoModelPreference): Promise<NeoModelPreference> {
    const updated = await gatewayFor(this.db.getDatabase()).call(
      globalSettingsWrites,
      'neoPreferences',
      preferences
    );
    const saved = updated.neo!.preferences!;
    this.publishSettings?.(updated);
    const root = this.repo.defaultBinding();
    if (!root) return saved;
    await this.alignModelPreference(root.sessionId).catch((error) => {
      this.log.warn('Neo model preference not applied', error);
    });
    await this.applyCompactPercent(root.sessionId, saved);
    return saved;
  }

  private async applyCompactPercent(
    sessionId: string,
    preferences: NeoModelPreference
  ): Promise<void> {
    const session = this.db.getSession(sessionId);
    if (!session) return;
    const percent = neoCompactPercentFor(preferences, session.config);
    if (
      session.config.autoCompactPercent !== percent ||
      session.metadata.pendingAutoCompactPercent !== undefined
    )
      await this.sessions.updateSession(sessionId, {
        config: { ...session.config, autoCompactPercent: percent },
      });
  }

  private async applyCompactPercentNow(
    sessionId: string,
    preferences: NeoModelPreference
  ): Promise<void> {
    const session = this.db.getSession(sessionId);
    if (!session) return;
    const percent = neoCompactPercentFor(preferences, session.config);
    if (
      session.config.autoCompactPercent === percent &&
      session.metadata.pendingAutoCompactPercent === undefined
    )
      return;
    const config = { ...session.config, autoCompactPercent: percent };
    const metadata = { ...session.metadata, pendingAutoCompactPercent: undefined };
    const live = await this.sessions.getSessionForControl(sessionId);
    if (live) await live.updateMetadata({ config, metadata });
    else await this.db.updateSession(sessionId, { config, metadata });
    await this.events.publish('session.updated', {
      sessionId,
      source: 'update',
      session: { config },
    });
  }

  private async alignModelPreference(sessionId: string): Promise<void> {
    const preference = this.modelPreference();
    const config = this.db.getSession(sessionId)?.config;
    const plan = preference && config ? planNeoAlignment(config, preference) : null;
    if (!preference || !plan) return;
    const live = await this.sessions.getSessionForControl(sessionId);
    if (!live) return;
    if (live.isLimitRecoveryPending?.() || live.getRateLimitWatchdogState?.().lastUserMessage)
      return;
    const previousThinking = live.getSessionData().config.thinkingLevel;
    if (plan.thinking)
      await this.sessions.updateSession(sessionId, {
        config: { ...live.getSessionData().config, thinkingLevel: preference.thinkingLevel },
      });
    if (!plan.model) return;
    let restored = false;
    try {
      const switched = await live.requestModelSwitch(preference.model, preference.provider);
      restored = switched.success && !switched.pending;
      if (!switched.success)
        this.log.warn(`Neo session ${sessionId} keeps its model: ${switched.error ?? ''}`);
    } finally {
      if (!restored && plan.thinking)
        await this.sessions.updateSession(sessionId, {
          config: { ...live.getSessionData().config, thinkingLevel: previousThinking },
        });
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.unsubscribe();
    if (this.triggerTimer) clearTimeout(this.triggerTimer);
    this.triggerTimer = undefined;
    this.triggerDeliveryRetryAt.clear();
    if (this.watching) await this.watching;
    await this.sessionWatcher.flushSessionNoticeGroup();
    await this.speech.dispose();
  }

  async readWorker(ref: WorkRef) {
    if (ref.adapter === 'hyperneo' && !ref.daemon)
      return workerIdentity(ref, this.db.getSession(ref.id)?.title ?? null);
    return workerIdentity(ref, await this.db.gateway.call(neoTodoSessionReads, 'workerName', ref));
  }

  resolveSessionSource(session: string | WorkRef) {
    return readNeoSessionSource(
      session,
      (id) => this.db.getSession(id),
      (name, input) =>
        invokeOperation(this.sessions.getOperationRegistry(), name, input, { source: 'internal' })
    );
  }

  async readQuestionSource(ref: WorkRef): Promise<NeoQuestionSource | null> {
    return (await this.resolveSessionSource(ref)).source;
  }

  presentPublications(items: NeoPublication[]) {
    return presentNeoPublications(
      items,
      async (id) => (await this.resolveSessionSource(id)).source
    );
  }

  storeWorkerQuestion(ref: WorkRef, report: unknown, stored?: (question: NeoQuestion) => void) {
    return createNeoWorkerQuestionWriter(
      this.todos,
      this.todoSessions,
      () => this.db.getGlobalSettings().language,
      (source) => this.readQuestionSource(source),
      stored
    )(ref, report);
  }

  async relayWorkerQuestion(
    input: { todoId: string; title: string; options: string[] },
    sessionId: string | undefined
  ) {
    const todo = this.todos.getTodo(input.todoId);
    const staged = this.todoSessions.readNudge(input.todoId)?.workerQuestion;
    const ref = this.todoSessions.readRef(input.todoId);
    if (!todo || !staged || !ref || this.todos.getAsk(todo.askId)?.sessionId !== sessionId)
      return {
        ok: false,
        reason: 'no_worker_question: this todo has no worker question to relay.',
      };
    const setting = this.db.getGlobalSettings().language;
    const card = requireHumanCard(
      { text: input.title, kind: 'choice' },
      this.todos.listQuestions(todo.askId),
      null,
      setting
    );
    if ('reason' in card) return card.reason;
    const language = expectedReportLanguage(setting);
    const result = await this.storeWorkerQuestion(ref, { ...staged, ...input, language });
    const current = this.todoSessions.readNudge(input.todoId);
    if (result.ok && current && JSON.stringify(current.workerQuestion) === JSON.stringify(staged))
      this.todoSessions.recordNudge(input.todoId, { ...current, workerQuestion: undefined });
    return result;
  }

  readonly relaySessionQuestion = (superpipe({})('neo.question.relaySession') as PipelineAPI)
    .input(['input', 'sessionId', 'now'])
    .pipe(
      (input: { session?: string }) =>
        findNeoSessionNotice(this.trackableNotices, input.session ?? ''),
      'input',
      'result:relayed'
    )
    .pipe(
      (notice: NeoSessionNotice, input: { title: string }, sessionId: string | undefined) => {
        const card = requireHumanCard(
          { text: input.title, kind: 'choice' },
          [],
          null,
          this.db.getGlobalSettings().language
        );
        if ('reason' in card) return card;
        return notice.question && sessionId === this.defaultSessionId()
          ? { value: notice }
          : {
              reason: {
                ok: false,
                reason: 'no_worker_question: this session has no question to relay.',
              },
            };
      },
      ['relayed', 'input', 'sessionId'],
      'result:relayed'
    )
    .pipe((notice: NeoSessionNotice) => notice, 'relayed', 'notice')
    .pipe(
      async (notice: NeoSessionNotice, now: number) => {
        const tracked = await this.runDbOp(neoSessionTrackWrites, {
          askId: crypto.randomUUID(),
          todoId: crypto.randomUUID(),
          notice,
          now,
        });
        return tracked.ok ? { value: tracked } : { reason: tracked };
      },
      ['relayed', 'now'],
      'result:relayed'
    )
    .pipe(
      async (
        tracked: { ask: { id: string }; todo: NeoTodo; root: string },
        notice: NeoSessionNotice,
        input: { title: string; options: string[] },
        now: number
      ) => {
        let relayed: { ok: boolean } | undefined;
        try {
          await this.todoSessions.write(
            'stageTurnQuestion',
            tracked.todo.id,
            notice.question!,
            now
          );
          this.notifyChanged();
          relayed = await this.relayWorkerQuestion(
            { todoId: tracked.todo.id, title: input.title, options: input.options },
            tracked.root
          );
          return relayed;
        } finally {
          if (!relayed?.ok) {
            await gatewayFor(this.db.getDatabase()).call(
              neoAskSettlementWrites,
              'settle',
              {
                askId: tracked.ask.id,
                status: 'dropped',
                outcome: 'The question card could not open.',
              },
              now
            );
            this.notifyChanged();
          }
        }
      },
      ['relayed', 'notice', 'input', 'now'],
      'relayed'
    )
    .endAsync('relayed') as (
    input: { session?: string; title: string; options: string[] },
    sessionId: string | undefined,
    now: number
  ) => Promise<unknown>;

  readonly handleWorkerQuestion = (superpipe({})('neo.workerQuestionReport') as PipelineAPI)
    .input(['input', 'origin', 'retry'])
    .pipe(
      (input: Parameters<SessionReportHandler>[0], origin: string) => {
        const sender = sessionSender(origin);
        if (
          !sender ||
          !['question', 'blocked'].includes(input.kind ?? '') ||
          this.repo.getBindingBySession(input.sessionId)?.kind !== 'neo'
        )
          return { reason: null };
        return { value: sender };
      },
      ['input', 'origin'],
      'result:receipt'
    )
    .pipe(
      async (
        sender: string,
        input: Parameters<SessionReportHandler>[0],
        origin: string,
        retry: Parameters<SessionReportHandler>[2]
      ) => {
        const content = input.message.message.content;
        const media = typeof content === 'string' ? [] : content.filter((b) => b.type === 'image');
        const text =
          input.handoff?.text ??
          (typeof content === 'string'
            ? content
            : content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n'));
        const files = input.handoff?.files ?? [];
        const jobs = this.db.getJobQueueRepo();
        let receipt: z.infer<typeof SendMessageResultSchema> | null = null;
        const wake = (incident: string, note: string) => {
          if (files.length) note += `\n${JSON.stringify({ handoffFiles: files })}`;
          type Prior = { mailboxId: string; messageId: string };
          let key = `worker-question:${incident}`;
          for (;;) {
            const prior = jobs.submissionReceipt<Prior>(key, key);
            if (!prior) break;
            const status = this.db
              .getSDKMessageRepo()
              .getUserSendStatus(input.sessionId, prior.messageId);
            const job = jobs.getLatestByPayload('mailbox', { id: prior.mailboxId });
            const live = job && ['pending', 'processing', 'completed'].includes(job.status);
            const recent =
              !!input.question || Date.now() - decodeUlidTimestamp(prior.mailboxId) < 10 * 60_000;
            if (status === 'consumed' ? recent : status !== 'failed' && live) break;
            key = `worker-question:${incident}:${prior.mailboxId}`;
          }
          const submit = () =>
            jobs.commitSubmissionReceipt(key, key, () => {
              const messageId = neoDerivedId(key);
              const outcome = enqueueMailboxEntry(
                jobs,
                createMailboxEntry({
                  to: { kind: 'session', sessionId: input.sessionId },
                  origin,
                  messageUuid: messageId,
                  message: {
                    type: 'user',
                    parent_tool_use_id: null,
                    inputKind: 'task',
                    workerReportKind: input.kind,
                    message: {
                      content: wrapSessionContent(
                        media.length
                          ? [{ type: 'text', text: note || 'Worker report' }, ...media]
                          : note,
                        { sessionId: sender, name: null }
                      ) as MailboxMessageContent,
                    },
                  },
                })
              );
              if (outcome.kind === 'rejected') throw new Error(outcome.reason);
              return {
                kind: 'accepted' as const,
                mailboxId: outcome.id,
                messageId,
                ...(files.length ? { files } : {}),
              };
            });
          receipt = retry
            ? jobs.commitSubmissionReceipt(retry.key, retry.fingerprint, submit)
            : submit();
        };
        if (!input.question) {
          wake(
            neoDerivedId(
              JSON.stringify([origin, input.sessionId, text, media, files.map((f) => f.sha256)])
            ),
            input.handoff && typeof content !== 'string'
              ? (content.find((b) => b.type === 'text')?.text ?? text)
              : text
          );
          return receipt;
        }
        const todo = this.todos.getTodo(input.question.todoId);
        if (!todo || this.todos.getAsk(todo.askId)?.sessionId !== input.sessionId)
          return {
            kind: 'rejected',
            reason: 'report_assignment: choose a todo owned by the receiving Neo.',
          };
        const result = stageNeoWorkerQuestion(
          this.todos,
          this.todoSessions,
          sessionWorkerRef(sender, !!this.db.getSession(sender)),
          { ...input.question, kind: input.kind, report: text },
          this.db.getGlobalSettings().language,
          (staged, question, reportId) =>
            wake(
              reportId,
              `Worker question on todo ${staged.id}: ${question.title}\nOptions: ${question.options.join(' | ')}\nAnswer the worker and continue if you can. If only the human can decide, call neo.question.relay with your own plain words.`
            )
        );
        return result.ok ? receipt : { kind: 'rejected', reason: result.reason };
      },
      ['receipt', 'input', 'origin', 'retry'],
      'receipt'
    )
    .endAsync('receipt') as SessionReportHandler;

  readSessionWorker(id: string) {
    return this.readWorker(sessionWorkerRef(id, !!this.db.getSession(id)));
  }

  async todoWorkers<T extends NeoTodo>(todos: readonly T[]): Promise<T[]> {
    const links = await this.todos.read(
      'todoLinks',
      todos.filter((todo) => todo.worker === undefined).map((todo) => todo.id)
    );
    const reads = new Map<string, ReturnType<typeof this.readWorker>>();
    return Promise.all(
      todos.map(async (todo) => {
        const ref = todo.worker === undefined ? links.get(todo.id)?.worker : todo.worker;
        const key = JSON.stringify(ref);
        if (ref && !reads.has(key)) reads.set(key, this.readWorker(ref));
        return { ...todo, worker: ref ? await reads.get(key)! : null };
      })
    );
  }

  async messageNames<T extends { fromSession: string; toSession: string }>(message: T) {
    if (message.fromSession === WORKER_BATCH_SENDER)
      return {
        ...message,
        fromName: 'System-forwarded worker messages',
        toName: (await this.readSessionWorker(message.toSession)).label,
      };
    const [from, to] = await Promise.all([
      this.readSessionWorker(message.fromSession),
      this.readSessionWorker(message.toSession),
    ]);
    return { ...message, fromName: from.label, toName: to.label };
  }

  async restart(): Promise<{ ok: true; sessionId: string }> {
    const sessionId = await this.open();
    const live = await this.sessions.getSessionForControl(sessionId);
    if (!live) throw new Error(`Neo session ${sessionId} is not available.`);
    await live.startFreshContext();
    return { ok: true, sessionId };
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
          ...neoPromptTools(this.packBriefs(), this.standingRules(), this.packPreferences()),
          autoCompactPercent: preference?.autoCompactPercent,
          ...(preference
            ? {
                model: preference.model,
                provider: preference.provider as Provider,
                thinkingLevel: preference.thinkingLevel,
              }
            : {}),
        },
      });
    } else {
      await this.alignCoordinatorConfig(binding.sessionId);
    }
    await this.alignNeoSkills(binding.sessionId);

    return binding.sessionId;
  }

  private async alignNeoSkills(sessionId: string): Promise<void> {
    const wanted = new Set(this.packBriefs().flatMap((pack) => (pack.skill ? [pack.skill] : [])));
    const skills = this.db.skills.findAll();
    if (!skills.length) return;
    const current = this.db.getSession(sessionId)?.config.toolSelection;
    const changes = skills
      .filter((skill) => skill.sourceType !== 'mcp_server')
      .map((skill) => ({
        key: `skill:${skill.id}` as const,
        selected:
          skill.builtIn && skill.config.type === 'builtin' && wanted.has(skill.config.commandName),
      }))
      .filter((edit) => (current?.choices[edit.key]?.selected ?? false) !== edit.selected);
    if (!changes.length) return;
    const result = await changeSessionToolChoice(
      { sessionId, changes },
      {
        capture: (id) => this.db.captureSessionRuntimeSettings(id),
        commit: (snapshot, patch) => this.db.casSessionRuntimeSettings(snapshot, patch),
        catalog: () => ({
          skills,
          registry: this.db.appMcpServers.list(),
          overrides: this.db.mcpEnablement.listAll(),
        }),
        pinnedSlotVetoes: () => [],
      }
    );
    if (!result.ok) {
      this.log.warn(`Neo pack skills not selected: ${result.reason}`);
      return;
    }
    const live = this.sessions.getCachedSession(sessionId)?.getSessionData();
    if (live) live.config = { ...live.config, toolSelection: result.selection };
    await this.events.publish('session.updated', {
      sessionId,
      source: 'tool-preferences',
      session: { config: this.db.getSession(sessionId)?.config },
    });
  }

  private readonly alignCoordinatorConfig = (superpipe({})('neo-session-config') as PipelineAPI)
    .input(['sessionId'])
    .pipe((sessionId: string) => this.db.getSession(sessionId), 'sessionId', 'session')
    .pipe(
      (session: Session | null) =>
        planNeoSessionConfig(
          session,
          this.packBriefs(),
          this.standingRules(),
          this.packPreferences()
        ),
      'session',
      'config'
    )
    .pipe(
      async (session: Session | null, config: SessionConfig | null) => {
        if (session && config) await this.sessions.updateSession(session.id, { config });
      },
      ['session', 'config'],
      'updated'
    )
    .endAsync('updated') as (sessionId: string) => Promise<void>;

  defaultSessionId(): string | undefined {
    return this.repo.defaultBinding()?.sessionId;
  }

  standingRules(): string[] {
    return neoStandingRules(this.db.getGlobalSettings().neo);
  }

  async rulesChanged(): Promise<void> {
    const root = this.defaultSessionId();
    if (!root) return;
    await this.alignCoordinatorConfig(root).catch((error) =>
      this.log.warn('Neo prompt refresh after a standing rule change failed', error)
    );
  }

  packPreferences() {
    return listPackPreferences(this.db.getDatabase());
  }

  async refreshPackPreferences(): Promise<void> {
    const root = this.defaultSessionId();
    if (!root) return;
    await this.alignCoordinatorConfig(root).catch((error) =>
      this.log.warn('Neo prompt refresh after pack setting change failed', error)
    );
  }

  async preferenceChanged(change: PackPreferenceChange): Promise<void> {
    const root = this.defaultSessionId();
    if (!root || !this.db.getSession(root)) return;
    await this.refreshPackPreferences();
    const scope =
      change.scope.kind === 'global' ? 'global' : `${change.scope.kind} ${change.scope.key}`;
    await this.deliverForward(
      root,
      `neo-preference:${crypto.randomUUID()}`,
      fillPrompt(NEO_PREFERENCE_CHANGED, {
        pack: change.pack,
        key: change.key,
        scope,
        value: JSON.stringify(change.value),
        before: change.before === undefined ? 'unset (default)' : JSON.stringify(change.before),
      }),
      root,
      'event'
    ).catch((error) => this.log.warn('Neo pack setting notice delivery failed', error));
  }

  async openDefault(): Promise<string> {
    return openNeoDefaultSession(this.repo, () => this.open());
  }

  async recover(): Promise<void> {
    this.sessionWatcher.loadSessionNoticeGroups();
    const id = this.defaultSessionId();
    if (id) await this.alignCoordinatorConfig(id);
    if (id && this.db.getSession(id)) await this.alignNeoSkills(id);
    const session = id ? this.db.getSession(id) : null;
    const metadata = session?.metadata as
      | (NonNullable<typeof session>['metadata'] & { neoAutoCompactPercent?: number })
      | undefined;
    if (session && metadata?.neoAutoCompactPercent !== undefined) {
      const ordinaryMetadata = { ...metadata, neoAutoCompactPercent: undefined };
      await this.sessions.updateSession(session.id, {
        config: { ...session.config, autoCompactPercent: metadata.neoAutoCompactPercent },
        metadata: ordinaryMetadata,
      });
    }
  }

  private turnRecording() {
    return {
      turns: new WorkTurnRepository(this.db.getDatabase()),
      read: (work: WorkRef, cursor: string | null, limit?: number) =>
        invokeOperation(
          this.sessions.getOperationRegistry(),
          'work.turns',
          { ref: work, ...(cursor ? { cursor } : {}), ...(limit ? { limit } : {}) },
          { source: 'internal', role: 'neo' }
        ),
    };
  }

  private async catchUpOpenTodoTurns(): Promise<void> {
    if (this.catchingUpTurns) return;
    const workers = new WorkDeliveryInputRepository(this.db.getDatabase()).openWorkerRefs();
    this.catchingUpTurns = true;
    try {
      for (const { ref, lastActivityAt } of planTurnCatchUp(workers, this.turnsSeen)) {
        const caughtUp = await catchUpWorkerTurns(ref, this.turnRecording()).catch((error) => {
          this.log.warn('Worker turns pending', error);
          return false;
        });
        if (caughtUp && lastActivityAt !== null)
          this.turnsSeen.set(JSON.stringify(ref), lastActivityAt);
      }
    } finally {
      this.catchingUpTurns = false;
    }
  }

  async sweepPacks(): Promise<void> {
    await sweepNeoTrackerMirrors(
      this.db.getDatabase(),
      this.packs().flatMap((pack) => pack.tracker ?? [])
    ).catch((error) => this.log.warn('Tracker mirror pending', error));
    await this.catchUpOpenTodoTurns().catch((error) =>
      this.log.warn('Worker turns pending', error)
    );
    for (const pack of this.packs())
      await pack
        .sweep?.(Date.now())
        .catch((error) => this.log.warn(`Neo ${pack.id} sweep failed`, error));
    const retire = createQuestionRetirement(this.todos, () => this.installedPacks());
    for (const { question, todo } of await this.todos.read('openQuestionChecks'))
      await retire(question, todo, Date.now()).catch((error) =>
        this.log.warn('Question check pending', error)
      );
    await publishDroppedWork(this, Date.now(), this.appendPublication.bind(this));
    this.notifyChanged();
  }

  async deliverQuestionAnswers(questionId?: string): Promise<void> {
    const warn = (error: unknown) => this.log.warn('Worker answer delivery pending', error);
    await createNeoQuestionAnswerDelivery(
      this.todos,
      this.todoSessions,
      (caller, name, input) =>
        invokeOperation(this.sessions.getOperationRegistry(), name, input, caller),
      this.deliverForward.bind(this),
      this.todoRunner.recompute,
      warn
    )(questionId).catch(warn);
    if (questionId)
      await this.todoRunner.checkNow({ questionId }, (message, error) =>
        this.log.warn(message, error)
      );
  }

  async refreshDriverWork(): Promise<void> {
    await this.deliverQuestionAnswers();
    await this.db.getSDKMessageRepo().runWrite(sdkNeoWakeQueue, { flush: Date.now() });
    await runLagPhase('neo:driver:todo_refresh', () =>
      this.todoRunner.refresh((message, error) => this.log.warn(message, error))
    );
    if (this.watching || this.disposed) return;
    this.watching = runLagPhase('neo:driver:session_watch', async () => {
      await this.runDbOp(neoStallReminderWrite, { now: Date.now() }).catch((error) =>
        this.log.warn('Stalled todo reminders pending', error)
      );
      await wakeStalledAsks(this.todos, this.deliverForward.bind(this), Date.now()).catch((error) =>
        this.log.warn('Stalled ask wake pending', error)
      );
      await this.sessionWatcher.watchSessions(Date.now());
    })
      .catch((error) => this.log.warn('Neo refresh pending', error))
      .finally(() => {
        this.watching = null;
      });
    await this.watching;
  }

  async trackSession(
    _root: string,
    notice: NeoSessionNotice,
    now: number
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const receipt = await this.runDbOp(neoSessionTrackWrites, {
      askId: crypto.randomUUID(),
      todoId: crypto.randomUUID(),
      notice,
      now,
    });
    if (!receipt.ok) return receipt;
    this.notifyChanged();
    const content = fillPrompt(NEO_SESSION_TRACK, {
      title: JSON.stringify(receipt.ask.title),
      ref: JSON.stringify(receipt.ref),
      askId: JSON.stringify(receipt.ask.id),
      todoId: JSON.stringify(receipt.todo.id),
    });
    await this.deliver(receipt.root, receipt.messageId, content, receipt.root);
    return { ok: true };
  }

  followedCardRefs(_now: number): Promise<WorkRef[]> {
    return this.todos.read('followedRefs');
  }

  readonly enabledOperationPackIds = () => this.packs().map((pack) => pack.id);

  packs(): NeoPack[] {
    return neoPacks({
      builtins: this.builtinPacks,
      filePacks: this.filePacks,
      enabled: neoEnabledPacks(
        runLagPhase('neo:packs:eligibility_read', () => this.db.getGlobalSettings?.().neo),
        this.defaultPacks
      ),
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

  packBriefs(): NeoPackBrief[] {
    return neoPackBriefs(
      neoEnabledPacks(this.db.getGlobalSettings?.().neo, this.defaultPacks),
      this.installedPacks()
    );
  }

  async sendToRef(ref: WorkRef, key: string, text: string, todoId?: string): Promise<boolean> {
    const root = this.defaultSessionId();
    if (!root) return false;
    const sent = await invokeOperation(
      this.sessions.getOperationRegistry(),
      'work.send',
      { ref, message: text, idempotencyKey: key, ...(todoId ? { todoId } : { notice: true }) },
      driverWorkCaller({ originSessionId: root })
    );
    return sent.kind === 'completed' && (sent.value as { ok?: unknown } | null)?.ok === true;
  }

  async wakeNeo(key: string, text: string): Promise<boolean> {
    const root = this.defaultSessionId();
    if (!root) return false;
    await this.deliver(root, key, text, root);
    return true;
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

  deliverForward(
    sessionId: string,
    messageId: string,
    content: MailboxMessageContent,
    fromSessionId: string,
    kind?: 'focused_status' | 'quiet_heartbeat' | 'event'
  ): Promise<void> {
    return this.deliver(
      sessionId,
      messageId,
      content,
      fromSessionId,
      kind !== 'event' && this.repo.getBindingBySession(sessionId)?.kind === 'neo'
    );
  }

  logReorganize(line: string): void {
    this.log.info(line);
  }

  private deliver(
    sessionId: string,
    messageId: string,
    content: MailboxMessageContent,
    originSessionId: string,
    recordOnly = false
  ): Promise<void> {
    const key = `${sessionId}:${messageId}`;
    const existing = this.deliveries.get(key);
    if (existing) return existing;
    const delivery = Promise.resolve()
      .then(() => this.enqueueDelivery(sessionId, messageId, content, originSessionId, recordOnly))
      .finally(() => this.deliveries.delete(key));
    this.deliveries.set(key, delivery);
    return delivery;
  }

  private async enqueueDelivery(
    sessionId: string,
    messageId: string,
    content: MailboxMessageContent,
    originSessionId: string,
    recordOnly: boolean
  ): Promise<void> {
    const queue = this.db.getJobQueueRepo();
    if (this.db.getSDKMessageRepo().findMessageIdByUuid(sessionId, messageId)) return;
    if (
      queue.listActiveByPayload('mailbox', { 'to.sessionId': sessionId, messageUuid: messageId })
        .length
    )
      return;
    if (recordOnly) {
      await gatewayFor(this.db.getDatabase()).call(
        neoWakeQueueWrite,
        'hold',
        createMailboxEntry({
          to: { kind: 'session', sessionId },
          origin: renderAddress({ kind: 'session', sessionId: originSessionId }),
          messageUuid: messageId,
          message: {
            type: 'user',
            parent_tool_use_id: null,
            message: { content },
            inputKind: 'system',
          },
        })
      );
      const message = {
        type: 'user' as const,
        uuid: messageId as UUID,
        session_id: sessionId,
        parent_tool_use_id: null,
        message: { role: 'user' as const, content },
        inputKind: 'system' as const,
        isSynthetic: true,
      };
      await this.db.saveUserMessage(sessionId, message, 'consumed');
      return;
    }
    const outcome = await handoffPromptToMailbox({
      to: renderAddress({ kind: 'session', sessionId }),
      origin: renderAddress({ kind: 'session', sessionId: originSessionId }),
      messageUuid: messageId,
      message: {
        type: 'user',
        message: { role: 'user', content },
        parent_tool_use_id: null,
        inputKind: 'system',
        neoWakeEvent: true,
      },
      deliveryMode: 'immediate',
      jobQueue: queue,
    });
    if (outcome.kind === 'rejected') throw new Error(outcome.reason);
  }
}
