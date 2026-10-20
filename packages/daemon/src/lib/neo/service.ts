import { neoStateNote, restartNeo } from './restart.ts';
import { projectNeoAskEntries } from './ask-entries.ts';
import { hostname } from 'node:os';
import { neoWorkingKey, readNeoWorking } from './working.ts';
import { fillPrompt, NEO_SESSION_TRACK } from '@hyperneo/prompts';
import type { GlobalSettings, MessageHub, Provider } from '@hyperneo/shared';
import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import type { MailboxMessageContent } from '../mailbox/entry.ts';
import type { NeoPublicationInput } from '@hyperneo/shared/types/neo-publication';
import { type NeoWorkingEvent } from '@hyperneo/shared/types/neo-snapshot';
import { type NeoModelPreference, neoStandingRules } from '@hyperneo/shared/types/settings';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { Database } from '../../storage/database.ts';
import { NeoAskTodoRepository } from '../../storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../storage/repositories/neo-todo-session-repository.ts';
import { createNeoTodoRunner, neoTodoCard, type NeoTodoRunner } from './todo-runner.ts';
import { CodingPrLedgerRepository } from './packs/coding/pr-ledger.ts';
import { CodingPrEventRepository } from './packs/coding/pr-events.ts';
import { CodingPrSweepRepository } from './packs/coding/pr-sweep.ts';
import { CodingTodoPrRepository } from './packs/coding/todo-prs.ts';
import { NeoCardEventSubscriptionRepository } from '../../storage/repositories/neo-card-event-subscription-repository.ts';
import { SessionEventSubscriptionRepository } from '../../storage/repositories/session-event-subscription-repository.ts';
import { NeoConversationAskRepository } from '../../storage/repositories/neo-conversation-ask-repository.ts';
import { NeoInputOriginRepository } from '../../storage/repositories/neo-input-origin-repository.ts';
import { NeoPublicationRepository } from '../../storage/repositories/neo-publication-repository.ts';
import { NeoRepository } from '../../storage/repositories/neo-repository.ts';
import { NeoSessionSeenRepository } from '../../storage/repositories/neo-session-seen-repository.ts';
import { BUILD_METADATA } from '../build-metadata.ts';
import type { WorkRef } from '../drivers/types.ts';
import { readWorkspaceIdentity } from '../drivers/code-identity.ts';
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
import { invokeOperation } from '../operations/invoke.ts';
import type { OperationCaller } from '../operations/registry.ts';
import { remoteDaemons } from '../remote-daemons/registry.ts';
import type { SessionManager } from '../session/session-manager.ts';
import { createNeoAskOriginResolver, type NeoAskOrigin } from './ask-origin.ts';
import {
  planNeoCardEventRoute,
  planNeoCardEventSends,
  planNeoCardSend,
  planNeoCardTopicsEnded,
  neoCardWorkerSession,
} from './card-events.ts';
import { readNeoDaemonCommits } from './daemon-commits.ts';
import { neoNoteDeliveryMode, neoSessionStatus } from './session-status.ts';
import { driverWorkCaller } from './driver-work.ts';
import { neoFolderPath } from './folder.ts';
import { effectiveNeoPreference, planNeoAlignment } from './model-preference.ts';
import {
  type NeoDeliveryTrigger,
  neoDeliveryTrigger,
  neoHumanTrigger,
} from './notification-triggers.ts';
import { type NeoRefStateReader, readGithubRefStates } from './packs/coding/ask-prs.ts';
import {
  localCodingSessionId,
  type NeoBranchPrReader,
  neoWorkBranch,
  readGithubBranchPrs,
} from './packs/coding/branch-prs.ts';
import { type NeoDeployReader, readGithubDeploys } from './packs/coding/deploy-checks.ts';
import { listNeoGithub, type NeoGithubLister } from './packs/coding/github-query.ts';
import { createCodingPack } from './packs/coding/pack.ts';
import { type NeoWorkPrReader, readGithubPrs } from './packs/coding/work-prs.ts';
import { neoEnabledPacks, neoPackBriefs, neoPacks } from './packs/index.ts';
import { createLifeAdminPack } from './packs/life-admin/pack.ts';
import type {
  NeoCardEventSubscription,
  NeoPack,
  NeoPackBrief,
  NeoPackEventRoute,
} from './packs/types.ts';
import { neoPrompt } from './prompt.ts';
import { createNeoPublisher } from './publication-operation.ts';
import { openNeoDefaultSession } from './inbox.ts';
import {
  type NeoSavedRulesNote,
  planNeoSavedRulesAppend,
  planNeoSavedRulesNote,
  withNeoSavedRules,
} from './saved-rules.ts';
import {
  neoCoordinatorAllowedTools,
  neoCoordinatorBinding,
  neoCoordinatorNativeTools,
} from './session-policy.ts';
import type { NeoSessionNotice, NeoSessionNoticeGroup } from './session-watch.ts';
import { NeoSessionWatcher } from './session-watcher.ts';
import { runLagPhase } from '../event-loop-activity.ts';
import type { NeoSnapshotRead } from './snapshot-read.ts';

export class NeoService {
  readonly repo: NeoRepository;
  readonly publications: NeoPublicationRepository;
  readonly asks: NeoConversationAskRepository;
  readonly publish: ReturnType<typeof createNeoPublisher>;
  readonly todos: NeoAskTodoRepository;
  readonly todoSessions: NeoTodoSessionRepository;
  readonly todoRunner: NeoTodoRunner;
  readonly todoPrs: CodingTodoPrRepository;
  readonly cardEvents: NeoCardEventSubscriptionRepository;
  private readonly sessionSubscriptions: SessionEventSubscriptionRepository;
  private readonly sessionEvents: SessionExternalEventStore;
  watchExternalTopic: ((topic: string) => Promise<void>) | null = null;
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
  readPrs: NeoWorkPrReader = readGithubPrs;
  readBranchPrs: NeoBranchPrReader = readGithubBranchPrs;
  readRefStates: NeoRefStateReader = readGithubRefStates;
  listGithub: NeoGithubLister = (args) => listNeoGithub(args);
  readDeploys: NeoDeployReader = (urls) =>
    readGithubDeploys(urls, () =>
      readNeoDaemonCommits({ name: hostname(), commit: BUILD_METADATA.commit }, remoteDaemons)
    );
  readonly resolveAskOrigin: ReturnType<typeof createNeoAskOriginResolver>;
  readonly inputOrigins: NeoInputOriginRepository;
  readonly notifyChanged: () => void;
  private readonly noteWorking: () => void;
  private workingKey = '';
  readonly notifyPublicationsChanged: (conversationId: string) => void;
  private triggerTimer?: ReturnType<typeof setTimeout>;
  private readonly triggerDeliveryRetryAt = new Map<string, number>();
  private opening: Promise<string> | null = null;
  private readonly deliveries = new Map<string, Promise<void>>();
  private readonly processingStatus = new Map<string, string>();
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
      sessionBranchPrs: (ref) => this.sessionBranchPrs(ref),
      readRemotes: async (folder) => (await readWorkspaceIdentity(folder)).remotes ?? [],
      observeSessions: (sessions) => {
        for (const pack of this.packs()) pack.observeSessions?.(sessions, Date.now());
      },
      notifyChanged: () => this.notifyChanged(),
    });
    this.repo = new NeoRepository(db.getDatabase(), this.notifyChanged);
    this.publications = new NeoPublicationRepository(db.getDatabase());
    this.asks = new NeoConversationAskRepository(db.getDatabase());
    this.todos = new NeoAskTodoRepository(db.getDatabase(), this.notifyChanged);
    this.todoSessions = new NeoTodoSessionRepository(db.getDatabase());
    this.todoPrs = new CodingTodoPrRepository(db.getDatabase());
    this.todoRunner = createNeoTodoRunner({
      store: this.todos,
      sessions: this.todoSessions,
      invoke: (caller, name, input) =>
        invokeOperation(this.sessions.getOperationRegistry(), name, input, caller),
      packs: () => this.installedPacks(),
      tell: (ask, todo, note, key) => {
        const parent = ask.originMessageId
          ? { sessionId: ask.sessionId, messageId: ask.originMessageId }
          : null;
        const resolved = parent && this.resolveAskOrigin(parent);
        const origin = resolved && this.db.getSession(resolved.sessionId) ? resolved : parent;
        return this.deliverForward(
          origin?.sessionId ?? ask.sessionId,
          key ?? `neo-todo:${todo.id}:${todo.updatedAt}`,
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
    this.cardEvents = new NeoCardEventSubscriptionRepository(db.getDatabase());
    this.sessionSubscriptions = new SessionEventSubscriptionRepository(db.getDatabase());
    this.sessionEvents = new SessionExternalEventStore(db.getDatabase());
    this.builtinPacks = [
      createCodingPack({
        readPrs: (urls) => this.readPrs(urls),
        todoPrs: this.todoPrs,
        prLedger: new CodingPrLedgerRepository(db.getDatabase()),
        prSweep: new CodingPrSweepRepository(db.getDatabase()),
        prEvents: new CodingPrEventRepository(db.getDatabase()),
        prSweepDeps: {
          tell: (ref, key, text) => this.sendToRef(ref, key, text),
          wake: (key, text) => this.wakeNeo(key, text),
        },
        projectRepos: () => this.repo.allRepositories(),
      }),
      createLifeAdminPack(),
    ];
    for (const pack of this.builtinPacks) pack.todos?.schema(db.getDatabase());
    const inputOrigins = new NeoInputOriginRepository(db.getDatabase());
    this.inputOrigins = inputOrigins;
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
      resolveAskOrigin: (input) => this.resolveAskOrigin(input),
      resolveHumanAskOrigin: (input) => this.resolveHumanAskOrigin(input),
      inputTrigger: (input) => this.inputTrigger(input),
      isDeliveredHumanInput: (input) =>
        this.isHumanInput(input) &&
        this.db.getSDKMessageRepo().getUserSendStatus(input.sessionId, input.messageId) ===
          'consumed',
      append: (input) => this.appendPublication(input),
      notify: notifyPublication,
    });
    const offUpdated = events.subscribe(
      'session.updated',
      async ({ sessionId, processingState, session }) => {
        const status = processingState?.status;
        const previous = this.processingStatus.get(sessionId);
        if (status) this.processingStatus.set(sessionId, status);
        if (status === 'processing' && previous !== 'processing')
          void this.steerQueuedInputs(sessionId);
        const bound = status || session?.status ? this.repo.getBindingBySession(sessionId) : null;
        if (bound?.kind === 'neo') {
          this.noteWorking();
          if (status && previous !== status) this.notifyChanged();
        }
        if (status !== 'idle') return;
        const binding = this.repo.getBindingBySession(sessionId);
        if (binding?.kind === 'neo')
          await this.alignModelPreference(sessionId).catch((error) =>
            this.log.warn('Neo model preference not applied', error)
          );
      },
      { subscriberName: 'neo-work-return' }
    );
    const offStatus = events.subscribe(
      'messages.statusChanged',
      ({ sessionId, status }) => {
        if (status === 'enqueued' && sessionId) void this.steerQueuedInputs(sessionId);
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
    const offCompacted = events.subscribe(
      'session.compacted',
      async ({ sessionId }) => {
        if (this.repo.defaultBinding()?.sessionId !== sessionId) return;
        await this.deliver(
          sessionId,
          crypto.randomUUID(),
          neoStateNote(this.openAskEntries()),
          sessionId
        ).catch((error) => this.log.warn('Neo state note after compaction pending', error));
      },
      { subscriberName: 'neo-compact-state-note' }
    );
    const offExternal = events.subscribe(
      'externalEvent.published',
      async (payload: ExternalEventPublishedPayload) => {
        await this.routeCardEvent(payload).catch((error) =>
          this.log.warn('Card event delivery pending', error)
        );
      },
      { subscriberName: 'neo-card-events', namespaceId: SESSION_EVENT_SCOPE }
    );
    this.unsubscribe = () => {
      offUpdated();
      offStatus();
      offDeleted();
      offCompacted();
      offExternal();
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

  restart() {
    return restartNeo({
      open: () => this.open(),
      clear: async (sessionId) => {
        const live = await this.sessions.getSessionForControl(sessionId);
        if (!live) throw new Error(`Neo session ${sessionId} is not available.`);
        await live.startFreshContext();
      },
      note: (sessionId, text) => this.deliver(sessionId, crypto.randomUUID(), text, sessionId),
      entries: () => this.openAskEntries(),
    });
  }

  private openAskEntries() {
    return projectNeoAskEntries(
      this.todos.listOpenAsks(),
      this.todos,
      this.todoSessions,
      this.installedPacks()
    );
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
          systemPrompt: neoPrompt(this.packBriefs()),
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

  defaultSessionId(): string | undefined {
    return this.repo.defaultBinding()?.sessionId;
  }

  async openDefault(): Promise<string> {
    return openNeoDefaultSession(this.repo, () => this.open());
  }

  async recover(): Promise<void> {
    this.sessionWatcher.loadSessionNoticeGroups();
    const root = this.repo.defaultBinding();
    if (root) await this.removeTurnLimit(root.sessionId);
  }

  async sweepPacks(): Promise<void> {
    for (const pack of this.packs())
      await pack
        .sweep?.(Date.now())
        .catch((error) => this.log.warn(`Neo ${pack.id} sweep failed`, error));
    this.notifyChanged();
  }

  async refreshDriverWork(): Promise<void> {
    try {
      runLagPhase('neo:driver:card_topic_sweep', () => this.endUnfollowedCardTopics(Date.now()));
    } catch (error) {
      this.log.warn('Card event subscription sweep pending', error);
    }
    await runLagPhase('neo:driver:todo_refresh', () =>
      this.todoRunner.refresh((message, error) => this.log.warn(message, error))
    );
    runLagPhase('neo:driver:follow_topics', () => {
      for (const workId of this.packEvidenceWorkIds()) this.followCardTopics(workId);
    });
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

  private followedTodo(workId: string): NeoWork | null {
    const todo = this.todos.getTodo(workId);
    const ask = todo ? this.todos.getAsk(todo.askId) : null;
    return todo &&
      ask &&
      ask.status !== 'dropped' &&
      ((ask.status === 'open' && ['todo', 'doing', 'blocked'].includes(todo.state)) ||
        (todo.state === 'done' && this.todoPrs.prs(workId).some((pr) => pr.state === 'MERGED')))
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
    this.todos.updateTodo(todo, { state: 'doing', startedAt: now }, now);
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
        runLagPhase('neo:packs:eligibility_read', () => this.db.getGlobalSettings?.().neo)
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
    return neoPackBriefs(neoEnabledPacks(this.db.getGlobalSettings?.().neo), this.installedPacks());
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
    .pipe(
      () => runLagPhase('neo:card_topics:list_active', () => this.cardEvents.listActive()),
      'now',
      'rows'
    )
    .pipe(
      (rows: NeoCardEventSubscription[]) =>
        runLagPhase(
          'neo:card_topics:eligibility',
          () =>
            new Map(
              [...new Set(rows.map((row) => row.workId))].map(
                (workId) =>
                  [
                    workId,
                    !!runLagPhase(`neo:card_topics:followed_todo:${workId}`, () =>
                      this.followedTodo(workId)
                    ) &&
                      runLagPhase(`neo:card_topics:card_events_delivered:${workId}`, () =>
                        this.cardEventsDelivered()
                      ),
                  ] as const
              )
            )
        ),
      'rows',
      'followed'
    )
    .pipe(planNeoCardTopicsEnded, ['rows', 'followed'], 'ended')
    .pipe(
      (ended: NeoCardEventSubscription[], now: number) => {
        for (const row of ended)
          runLagPhase(`neo:card_topics:end:${row.workId}`, () =>
            this.cardEvents.end(row.workId, row.topic, now)
          );
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
    ];
  }

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
    .pipe(async () => {
      await this.todoRunner.refresh((message, error) => this.log.warn(message, error));
    }, 'delivered')
    .pipe((route: NeoPackEventRoute) => {
      for (const row of route.ending) this.cardEvents.end(row.workId, row.topic, Date.now());
    }, 'route')
    .endAsync('route') as (payload: ExternalEventPublishedPayload) => Promise<unknown>;

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

  private async sessionBranchPrs(ref: WorkRef | null): Promise<string[]> {
    const localId = localCodingSessionId(ref);
    const branch = neoWorkBranch(localId ? this.db.getSession(localId) : null);
    return branch ? this.readBranchPrs(branch) : [];
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
    return outcome;
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
    return !!turn && !!caller.sessionId && turn.human;
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

  async steerQueuedInputs(sessionId: string): Promise<void> {
    if (this.repo.defaultBinding()?.sessionId !== sessionId) return;
    const status =
      this.processingStatus.get(sessionId) ??
      neoSessionStatus(this.db.getSession(sessionId)?.processingState);
    if (status !== 'processing') return;
    const repo = this.db.getSDKMessageRepo();
    const queued = [
      ...repo.listQueuedInputs(sessionId, 'human'),
      ...repo.listQueuedInputs(sessionId, 'task'),
    ].sort((a, b) => a.seq - b.seq);
    if (!queued.length) return;
    try {
      const live = await this.sessions.getSessionForControl(sessionId);
      for (const { uuid } of queued) live?.steerNeoInput(uuid);
    } catch (error) {
      this.log.warn('Queued input not steered into the running Neo turn', error);
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
