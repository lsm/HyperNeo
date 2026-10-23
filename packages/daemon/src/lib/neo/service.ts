import { receivedNeoHumanInput } from './human-input.ts';
import { workerIdentity } from '@hyperneo/shared/types/worker-identity';
import { fillPrompt, NEO_SESSION_TRACK } from '@hyperneo/prompts';
import type {
  GlobalSettings,
  MessageHub,
  Provider,
  Session,
  SessionConfig,
} from '@hyperneo/shared';
import type { NeoAsk, NeoTodo } from '@hyperneo/shared/types/neo-ask';
import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import type { NeoPublicationInput } from '@hyperneo/shared/types/neo-publication';
import type { NeoWorkingEvent } from '@hyperneo/shared/types/neo-snapshot';
import { type NeoModelPreference } from '@hyperneo/shared/types/settings';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { Database } from '../../storage/database.ts';
import { NeoAskTodoRepository } from '../../storage/repositories/neo-ask-todo-repository.ts';
import { NeoCardEventSubscriptionRepository } from '../../storage/repositories/neo-card-event-subscription-repository.ts';
import { NeoConversationAskRepository } from '../../storage/repositories/neo-conversation-ask-repository.ts';
import { NeoPublicationRepository } from '../../storage/repositories/neo-publication-repository.ts';
import { NeoRepository } from '../../storage/repositories/neo-repository.ts';
import { NeoSessionSeenRepository } from '../../storage/repositories/neo-session-seen-repository.ts';
import { NeoTodoSessionRepository } from '../../storage/repositories/neo-todo-session-repository.ts';
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
import { neoSessionStatus } from './session-status.ts';
import { createNeoPublisher } from './publication-operation.ts';
import type { NeoSessionNotice, NeoSessionNoticeGroup } from './session-watch.ts';
import { NeoSessionWatcher } from './session-watcher.ts';
import { createNeoTodoRunner, type NeoTodoRunner, neoTodoCard } from './todo-runner.ts';
import { neoWorkingKey, readNeoWorking } from './working.ts';

type NeoFollowedTodoSnapshot = {
  todos: Map<string, NeoTodo>;
  asks: Map<string, NeoAsk>;
  retained: Set<string>;
};

export class NeoService {
  readonly repo: NeoRepository;
  readonly publications: NeoPublicationRepository;
  readonly asks: NeoConversationAskRepository;
  readonly publish: ReturnType<typeof createNeoPublisher>;
  readonly todos: NeoAskTodoRepository;
  readonly todoSessions: NeoTodoSessionRepository;
  readonly todoRunner: NeoTodoRunner;
  readonly cardEvents: NeoCardEventSubscriptionRepository;
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
    events: InternalEventBus<DaemonInternalEventMap>,
    readonly publishSettings?: (settings: GlobalSettings) => void
  ) {
    this.notifyChanged = () => {
      hub.event('neo.changed', {});
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
      observeSessions: (sessions) => {
        for (const pack of this.packs()) pack.observeSessions?.(sessions, Date.now());
      },
      notifyChanged: () => this.notifyChanged(),
    });
    this.repo = new NeoRepository(db.getDatabase(), this.notifyChanged);
    this.publications = new NeoPublicationRepository(db.getDatabase());
    this.asks = new NeoConversationAskRepository(db.getDatabase());
    this.todos = new NeoAskTodoRepository(db.getDatabase(), this.notifyChanged, () =>
      this.publishSettings?.(db.getGlobalSettings())
    );
    this.todoSessions = new NeoTodoSessionRepository(db.getDatabase());
    this.todoRunner = createNeoTodoRunner({
      store: this.todos,
      sessions: this.todoSessions,
      invoke: (caller, name, input) =>
        invokeOperation(this.sessions.getOperationRegistry(), name, input, caller),
      packs: () => this.installedPacks(),
      tell: (ask, todo, note, key) => {
        return this.deliverForward(
          ask.sessionId,
          key ?? `neo-todo:${todo.id}:${todo.updatedAt}`,
          note,
          ask.sessionId
        );
      },
      tellAsk: async (ask, messageId, note) => {
        const status = neoSessionStatus(this.db.getSession(ask.sessionId)?.processingState);
        if (status !== 'idle' || this.hasDelivery(ask.sessionId, messageId)) return;
        await this.deliverForward(ask.sessionId, messageId, note, ask.sessionId);
      },
      changed: this.notifyChanged,
    });
    this.cardEvents = new NeoCardEventSubscriptionRepository(db.getDatabase());
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
      getBinding: (id) => this.repo.getBindingBySession(id),
      getRootBinding: () => this.repo.defaultBinding(),
      hasProject: (id) => !!this.repo.getProject(id),
      append: (input) => this.appendPublication(input),
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
    const offHumanReset = onHumanDevicesReset(this.notifyPublicationsChanged);
    this.unsubscribe = () => {
      offHumanReset();
      offUpdated();
      offStatus();
      offDeleted();
    };
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

  async saveModelPreference(preferences: NeoModelPreference): Promise<void> {
    const neo = this.db.getGlobalSettings().neo;
    const updated = this.db.updateGlobalSettings({ neo: { ...neo, preferences } });
    this.publishSettings?.(updated);
    const root = this.repo.defaultBinding();
    if (!root) return;
    const target = await this.alignModelPreference(root.sessionId).catch((error) => {
      this.log.warn('Neo model preference not applied', error);
      return null;
    });
    const session = this.db.getSession(root.sessionId);
    const percent = session
      ? neoCompactPercentFor(preferences, target ?? session.config)
      : undefined;
    if (
      session &&
      (session.config.autoCompactPercent !== percent ||
        session.metadata.pendingAutoCompactPercent !== undefined)
    )
      await this.sessions.updateSession(root.sessionId, {
        config: { ...session.config, autoCompactPercent: percent },
      });
  }

  private async alignModelPreference(
    sessionId: string
  ): Promise<{ model: string; provider: string } | null> {
    const preference = this.modelPreference();
    const config = this.db.getSession(sessionId)?.config;
    const plan = preference && config ? planNeoAlignment(config, preference) : null;
    if (!preference || !plan) return null;
    const live = await this.sessions.getSessionForControl(sessionId);
    if (!live) return null;
    if (live.isLimitRecoveryPending?.() || live.getRateLimitWatchdogState?.().lastUserMessage)
      return null;
    const previousThinking = live.getSessionData().config.thinkingLevel;
    if (plan.thinking)
      await this.sessions.updateSession(sessionId, {
        config: { ...live.getSessionData().config, thinkingLevel: preference.thinkingLevel },
      });
    if (!plan.model) return null;
    let restored = false;
    try {
      const switched = await live.requestModelSwitch(preference.model, preference.provider);
      restored = switched.success && !switched.pending;
      if (switched.success) return { model: preference.model, provider: preference.provider };
      this.log.warn(`Neo session ${sessionId} keeps its model: ${switched.error ?? ''}`);
      return null;
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
    this.sessionWatcher.flushSessionNoticeGroup();
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

  readSessionWorker(id: string) {
    return this.readWorker(sessionWorkerRef(id, !!this.db.getSession(id)));
  }

  async todoWorkers<T extends NeoTodo>(todos: readonly T[]): Promise<T[]> {
    const links = this.todoSessions.readLinksForTodos(todos.map((todo) => todo.id));
    const reads = new Map<string, ReturnType<typeof this.readWorker>>();
    return Promise.all(
      todos.map(async (todo) => {
        const ref = links.get(todo.id)?.worker;
        const key = JSON.stringify(ref);
        if (ref && !reads.has(key)) reads.set(key, this.readWorker(ref));
        return { ...todo, worker: ref ? await reads.get(key)! : null };
      })
    );
  }

  async messageNames<T extends { fromSession: string; toSession: string }>(message: T) {
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
    this.notifyChanged();
  }

  async refreshDriverWork(): Promise<void> {
    await runLagPhase('neo:driver:todo_refresh', () =>
      this.todoRunner.refresh((message, error) => this.log.warn(message, error))
    );
    if (this.watching || this.disposed) return;
    this.watching = runLagPhase('neo:driver:session_watch', () =>
      this.sessionWatcher.watchSessions(Date.now())
    )
      .catch((error) => this.log.warn('Session watch pending', error))
      .finally(() => {
        this.watching = null;
      });
    await this.watching;
  }

  private packEvidenceWorkIds(): string[] {
    return this.todos.listCheckable().map((todo) => todo.id);
  }

  private followedTodo(workId: string, snapshot?: NeoFollowedTodoSnapshot): NeoWork | null {
    const todo = snapshot ? snapshot.todos.get(workId) : this.todos.getTodo(workId);
    const ask = todo
      ? snapshot
        ? snapshot.asks.get(todo.askId)
        : this.todos.getAsk(todo.askId)
      : null;
    return todo &&
      ask &&
      ask.status !== 'dropped' &&
      ((ask.status === 'open' && ['todo', 'doing', 'blocked'].includes(todo.state)) ||
        (todo.state === 'done' &&
          (snapshot
            ? snapshot.retained.has(workId)
            : this.installedPacks().some((pack) => pack.retainedTodoIds?.([workId]).has(workId)))))
      ? neoTodoCard(todo, ask)
      : null;
  }

  async trackSession(root: string, notice: NeoSessionNotice, now: number): Promise<{ ok: true }> {
    const askId = crypto.randomUUID();
    const messageId = `neo-track:${notice.key}:${askId}`;
    const done = 'The session finishes its work';
    const ask = this.todos.openAsk({
      id: askId,
      projectId: null,
      sessionId: root,
      originMessageId: messageId,
      title: notice.title,
      request: `See ${notice.title} through.`,
      createdAt: now,
    });
    const todo = this.todos.addTodo(
      crypto.randomUUID(),
      ask.id,
      { title: done, doneWhen: done, check: null, instruction: null, named: null },
      now
    );
    this.todoSessions.create(todo.id, { verb: 'adopt', ref: notice.ref });
    this.todoSessions.recordRef(todo.id, notice.ref, now, notice.link);
    this.todoSessions.recordFollowAnchor(todo.id, now);
    await this.todoRunner.recompute(todo, { state: 'doing', startedAt: now }, now);
    const content = fillPrompt(NEO_SESSION_TRACK, {
      title: JSON.stringify(notice.title),
      ref: JSON.stringify(notice.ref),
      askId: JSON.stringify(ask.id),
      todoId: JSON.stringify(todo.id),
    });
    await this.deliver(root, messageId, content, root);
    return { ok: true };
  }

  followedCardRefs(_now: number): WorkRef[] {
    return this.packEvidenceWorkIds().flatMap((id) => this.todoSessions.readRef(id) ?? []);
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
    fromSessionId: string
  ): Promise<void> {
    return this.deliver(sessionId, messageId, content, fromSessionId);
  }

  logReorganize(line: string): void {
    this.log.info(line);
  }

  private deliver(
    sessionId: string,
    messageId: string,
    content: MailboxMessageContent,
    originSessionId: string
  ): Promise<void> {
    const key = `${sessionId}:${messageId}`;
    const existing = this.deliveries.get(key);
    if (existing) return existing;
    const delivery = Promise.resolve()
      .then(() => this.enqueueDelivery(sessionId, messageId, content, originSessionId))
      .finally(() => this.deliveries.delete(key));
    this.deliveries.set(key, delivery);
    return delivery;
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
      deliveryMode: 'immediate',
      jobQueue: queue,
    });
    if (outcome.kind === 'rejected') throw new Error(outcome.reason);
  }
}
