import { neoStallReminderWrite } from '../../storage/repositories/neo-stall-reminder-write.ts';
import { NeoSpeech } from './speech.ts';
import type { RunDbOp } from '../../storage/db-gateway/db-op.ts';
import { neoSessionTrackWrites } from '../../storage/repositories/neo-session-track-write.ts';
import { createNeoQuestionAnswerDelivery } from './question-answer-delivery.ts';
import { wakeFailedHyperneoSession } from './query-failure.ts';
import type { UUID } from 'node:crypto';
import { WORKER_BATCH_SENDER } from '../../storage/repositories/neo-session-message-repository.ts';
import { gatewayFor } from '../../storage/db-gateway/db-gateway.ts';
import { globalSettingsWrites } from '../../storage/repositories/global-settings-writes.ts';
import { neoWakeQueueWrite } from '../../storage/repositories/neo-wake-queue-repository.ts';
import { sdkNeoWakeQueue } from '../../storage/repositories/sdk-message-transactions.ts';
import { createMailboxEntry } from '../mailbox/entry.ts';
import { decodeUlidTimestamp } from '../mailbox/ulid.ts';
import { createNeoWorkerQuestionWriter } from './question-operations.ts';
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
import { workerIdentity, workerEngine } from '@hyperneo/shared/types/worker-identity';
import { z } from 'zod';
import { WorkSummarySchema } from '../drivers/types.ts';
import { fillPrompt, NEO_SESSION_TRACK } from '@hyperneo/prompts';
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
import { type NeoModelPreference, neoTodoLimits } from '@hyperneo/shared/types/settings';
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
  neoSafeSessionLink,
} from '../../storage/repositories/neo-todo-session-repository.ts';
import { createArtifactRefReader } from '../artifacts/read-operations.ts';
import { readWorkerIdentity, sessionWorkerRef } from './worker-identity.ts';
import { readWorkspaceIdentity } from '../drivers/code-identity.ts';
import type { WorkRef } from '../drivers/types.ts';
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
import { neoFolderPath } from './folder.ts';
import { openNeoDefaultSession } from './inbox.ts';
import {
  effectiveNeoPreference,
  neoCompactPercentFor,
  planNeoAlignment,
} from './model-preference.ts';
import { neoEnabledPacks, neoPackBriefs, neoPacks } from './pack-selection.ts';
import type { NeoPack, NeoPackBrief, NeoPackRuntime } from './pack-contract.ts';
import { neoPromptTools, planNeoSessionConfig } from './session-config.ts';
import { createNeoPublisher } from './publication-operation.ts';
import type { NeoSessionNotice, NeoSessionNoticeGroup } from './session-watch.ts';
import { NeoSessionWatcher } from './session-watcher.ts';
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

  readonly sessionWatcher: NeoSessionWatcher;
  private watching: Promise<unknown> | null = null;
  private disposed = false;
  filePacks: readonly NeoPack[] = [];
  private readonly builtinPacks: NeoPack[];
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
    readonly publishSettings?: (settings: GlobalSettings) => void
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
      log: this.log,
      registry: () => this.sessions.getOperationRegistry(),
      followedCardRefs: (now) => this.followedCardRefs(now),
      mutedSessions: () => this.db.getGlobalSettings?.().neo?.mutedSessions,
      sessionBranchPrs: async (ref) =>
        (
          await Promise.all(this.installedPacks().map((pack) => pack.sessionLinks?.(ref) ?? []))
        ).flat(),
      readRemotes: async (folder) => (await readWorkspaceIdentity(folder)).remotes ?? [],
      observeSessions: async (sessions) => {
        for (const pack of this.packs()) await pack.observeSessions?.(sessions, Date.now());
      },
      notifyChanged: () => this.notifyChanged(),
    });
    this.repo = new NeoRepository(db.getDatabase(), this.notifyChanged);
    this.speech = new NeoSpeech(
      hub,
      this.runDbOp,
      (id) => this.repo.getBindingBySession(id)?.kind === 'neo'
    );
    this.publications = new NeoPublicationRepository(db.getDatabase());
    this.asks = new NeoConversationAskRepository(db.getDatabase());
    this.todos = new NeoAskTodoRepository(db.getDatabase(), this.notifyChanged, () =>
      this.publishSettings?.(db.getGlobalSettings())
    );
    this.todoSessions = new NeoTodoSessionRepository(db.getDatabase());
    this.todoRunner = createNeoTodoRunner({
      write: gatewayFor(db.getDatabase()).run.bind(gatewayFor(db.getDatabase())),
      store: this.todos,
      sessions: this.todoSessions,
      invoke: (caller, name, input) =>
        invokeOperation(this.sessions.getOperationRegistry(), name, input, caller),
      packs: () => this.installedPacks(),
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
    for (const pack of this.builtinPacks) pack.todos?.schema(db.getDatabase());
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
      currentHumanInputs: (sessionId) => {
        const state = parseProcessingState(this.db.getSession(sessionId)?.processingState);
        if (state.status !== 'processing') return [];
        if (Array.isArray(state.messageIds))
          return state.messageIds.filter((id): id is string => typeof id === 'string');
        return typeof state.messageId === 'string' ? [state.messageId] : [];
      },
      getBinding: (id) => this.repo.getBindingBySession(id),
      getRootBinding: () => this.repo.defaultBinding(),
      hasProject: (id) => !!this.repo.getProject(id),
      append: (input) => this.db.gateway.call(neoPublicationWrites, 'append', input),
      notify: notifyPublication,
      artifact: createArtifactRefReader(() => this.db.getDatabase()),
    });
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

  readWorker(ref: WorkRef) {
    if (ref.adapter === 'hyperneo' && !ref.daemon)
      return Promise.resolve(workerIdentity(ref, this.db.getSession(ref.id)?.title ?? null));
    return readWorkerIdentity(ref, (ref) =>
      invokeOperation(
        this.sessions.getOperationRegistry(),
        'work.status',
        { ref },
        { source: 'internal' }
      )
    );
  }

  async readQuestionSource(ref: WorkRef): Promise<NeoQuestionSource | null> {
    const result = await invokeOperation(
      this.sessions.getOperationRegistry(),
      'work.status',
      { ref },
      { source: 'internal' }
    );
    const current = z
      .object({ ok: z.literal(true), value: WorkSummarySchema })
      .safeParse(result.kind === 'completed' ? result.value : null);
    if (!current.success) return null;
    const local = ref.adapter === 'hyperneo' && !ref.daemon ? this.db.getSession(ref.id) : null;
    return {
      ...workerIdentity(ref, current.data.value.title),
      provider: local?.config.provider ?? workerEngine(ref.adapter),
      link:
        neoSafeSessionLink(current.data.value.link, !!ref.daemon) ??
        neoSafeSessionLink(current.data.value.remoteLink, true),
    };
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
        const result = await this.storeWorkerQuestion(
          sessionWorkerRef(sender, !!this.db.getSession(sender)),
          { ...input.question, kind: input.kind, report: text },
          (question) =>
            wake(
              question.id,
              `Worker needs a human decision. Read card ${question.id}: ${question.text}`
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
          ...neoPromptTools(this.packBriefs()),
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

    return binding.sessionId;
  }

  private readonly alignCoordinatorConfig = (superpipe({})('neo-session-config') as PipelineAPI)
    .input(['sessionId'])
    .pipe((sessionId: string) => this.db.getSession(sessionId), 'sessionId', 'session')
    .pipe(
      (session: Session | null) => planNeoSessionConfig(session, this.packBriefs()),
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

  async openDefault(): Promise<string> {
    return openNeoDefaultSession(this.repo, () => this.open());
  }

  async recover(): Promise<void> {
    this.sessionWatcher.loadSessionNoticeGroups();
    const id = this.defaultSessionId();
    if (id) await this.alignCoordinatorConfig(id);
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

  async sweepPacks(): Promise<void> {
    for (const pack of this.packs())
      await pack
        .sweep?.(Date.now())
        .catch((error) => this.log.warn(`Neo ${pack.id} sweep failed`, error));
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

  async sendToRef(ref: WorkRef, key: string, text: string): Promise<boolean> {
    const root = this.defaultSessionId();
    if (!root) return false;
    if (ref.adapter === 'hyperneo' && !ref.daemon && this.db.getSession(ref.id)) {
      await this.deliver(ref.id, key, text, root);
      return true;
    }
    const sent = await invokeOperation(
      this.sessions.getOperationRegistry(),
      'work.send',
      { ref, message: text },
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
