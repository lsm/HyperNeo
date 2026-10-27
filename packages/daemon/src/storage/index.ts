import { searchNeoCards, type NeoCardSearchPage } from './neo-card-search.ts';
import { readHyperneoTurnEnds } from './hyperneo-turn-ends-read.ts';
import { bindGateway, bindSpaceTaskLane, DbGateway } from './db-gateway/db-gateway.ts';
import type { RunDbOp, TableChange } from './db-gateway/db-op.ts';
import { countPendingTurns, readPendingTurns } from './turn-vectors.ts';
import { readMessageFacts, type NeoMessageStatusRef } from '../lib/neo/message-status.ts';
import { readMessageFeed, type MessageFeedArgs } from './sdk-message-feed-read.ts';
import { Database as BunDatabase } from './sqlite-compat.ts';
import { Logger } from '../lib/logger.ts';
import type {
  Session,
  GlobalToolsConfig,
  GlobalSettings,
  InboxItem,
  MessageOrigin,
  HyperNeoActionMessage,
  ChatMessage,
} from '@hyperneo/shared';
import type { SDKMessage, SDKUserMessage } from '@hyperneo/shared/sdk';
import { DatabaseCore } from './database-core.ts';
import type { SQLiteQueryObservabilityOptions } from './sqlite-query-observability.ts';
import { ShortIdAllocator } from '../lib/short-id-allocator.ts';
export { ShortIdAllocator } from '../lib/short-id-allocator.ts';
import {
  sessionConfigReplacer,
  type SessionCreationOptions,
  SessionRepository,
  sessionWrites,
} from './repositories/session-repository.ts';
import type {
  SessionMcpPreferenceEdit,
  ToolPreferenceSnapshot,
} from './repositories/tool-preference-commit.ts';
import type { SessionInputDraftSnapshot } from './repositories/session-input-draft-write.ts';
import type { SessionWriteOutcome } from './repositories/session-status-write.ts';
import type {
  RuntimeSettingsPatch,
  SessionRuntimeSettingsSnapshot,
} from './repositories/session-runtime-settings-write.ts';
import {
  messageSearchIndexWrites,
  SDKMessageRepository,
  type SendStatus,
} from './repositories/sdk-message-repository.ts';
import type { SdkMessageWriteMethod } from './repositories/sdk-message-writes.ts';
import { SettingsRepository } from './repositories/settings-repository.ts';
import {
  InboxItemRepository,
  type CreateInboxItemParams,
} from './repositories/inbox-item-repository.ts';
import { JobQueueRepository } from './repositories/job-queue-repository.ts';
import { AppMcpServerRepository } from './repositories/app-mcp-server-repository.ts';
import { SpaceTaskRepository } from './repositories/space-task-repository.ts';
import { NodeExecutionRepository } from './repositories/node-execution-repository.ts';
import { SpaceLongHorizonAgentRepository } from './repositories/space-long-horizon-agent-repository.ts';
import { McpEnablementRepository } from './repositories/mcp-enablement-repository.ts';
import { SkillRepository } from './repositories/skill-repository.ts';
import { WorkspaceHistoryRepository } from './repositories/workspace-history-repository.ts';
import { WorkerAgentMemoryEmbedder } from './repositories/agent-memory-worker-embedder.ts';
import type { WorkChatKind } from './work-chat-search.ts';
import {
  SDKStatusReader,
  projectSDKStatusPage,
  readSDKMessagePage,
  type SDKPageParams,
} from './sdk-status-reader.ts';
import {
  type AgentMemoryEmbedder,
  AgentMemoryRepository,
} from './repositories/agent-memory-repository.ts';
import { EvolutionRepository } from './repositories/evolution-repository.ts';
import { GoalAutomationCursorRepository } from './repositories/goal-automation-cursor-repository.ts';
import { ProviderRepository } from './repositories/provider-repository.ts';
import type { ReactiveDatabase } from './reactive-database.ts';

export type { SendStatus } from './repositories/sdk-message-repository.ts';
export type { SQLiteValue } from './types.ts';
export type {
  CreateInboxItemParams,
  InboxItemFilter,
} from './repositories/inbox-item-repository.ts';
export type {
  CreateGoalParams,
  UpdateGoalParams,
  CreateExecutionParams,
  UpdateExecutionParams,
} from './repositories/goal-repository.ts';
export { getEffectiveMaxPlanningAttempts } from './repositories/goal-repository.ts';
export type { Job, EnqueueParams } from './repositories/job-queue-repository.ts';
export { JobQueueProcessor } from './job-queue-processor.ts';
export type {
  JobHandler,
  JobHandlerContext,
  JobQueueProcessorOptions,
} from './job-queue-processor.ts';

// @public - Library export
export { GoalRepository } from './repositories/goal-repository.ts';
export { AppMcpServerRepository } from './repositories/app-mcp-server-repository.ts';
export { McpEnablementRepository } from './repositories/mcp-enablement-repository.ts';
export { SkillRepository } from './repositories/skill-repository.ts';
export { WorkspaceHistoryRepository } from './repositories/workspace-history-repository.ts';
export { AgentMemoryRepository } from './repositories/agent-memory-repository.ts';
export { EvolutionRepository } from './repositories/evolution-repository.ts';
export { GoalAutomationCursorRepository } from './repositories/goal-automation-cursor-repository.ts';
export { ProviderRepository } from './repositories/provider-repository.ts';
export { WorkflowHookStateRepository } from './repositories/workflow-hook-state-repository.ts';
export type { WorkflowHookStatePatch } from './repositories/workflow-hook-state-repository.ts';
export type { GoalAutomationCursor } from './repositories/goal-automation-cursor-repository.ts';
export type {
  AgentMemoryEntry,
  AgentMemorySearchResult,
} from './repositories/agent-memory-repository.ts';
export type { WorkspaceHistoryRow } from './repositories/workspace-history-repository.ts';
export type {
  ProviderRecord,
  CreateProviderParams,
  UpdateProviderParams,
} from '@hyperneo/shared';

export interface DatabaseOptions {
  messageSearchIndexFlushIntervalMs?: number;
  queryObservability?: SQLiteQueryObservabilityOptions;
}

export class Database {
  private logger = new Logger('Database');
  private core: DatabaseCore;
  private sessionRepo!: SessionRepository;
  private sdkMessageRepo!: SDKMessageRepository;
  private settingsRepo!: SettingsRepository;
  private inboxItemRepo!: InboxItemRepository;
  private jobQueueRepo!: JobQueueRepository;
  private appMcpServerRepo!: AppMcpServerRepository;
  private spaceTaskRepo!: SpaceTaskRepository;
  private nodeExecutionRepo!: NodeExecutionRepository;
  private longHorizonAgentRepo!: SpaceLongHorizonAgentRepository;
  private mcpEnablementRepo!: McpEnablementRepository;
  private skillRepo!: SkillRepository;
  private workspaceHistoryRepo!: WorkspaceHistoryRepository;
  private agentMemoryRepo!: AgentMemoryRepository;
  private readonly embedder = new WorkerAgentMemoryEmbedder();
  private sdkStatusReader: SDKStatusReader | null = null;
  private dbGateway: DbGateway | null = null;
  private evolutionRepo!: EvolutionRepository;
  private goalAutomationCursorRepo!: GoalAutomationCursorRepository;
  private providerRepo!: ProviderRepository;
  private shortIdAllocator!: ShortIdAllocator;
  private reactiveDb?: ReactiveDatabase;
  private messageSearchIndexTimer: ReturnType<typeof setInterval> | null = null;
  private messageSearchIndexFlushing = false;
  private readonly messageSearchIndexFlushIntervalMs: number;

  private static readonly MESSAGE_SEARCH_INDEX_FLUSH_INTERVAL_MS = 2_000;

  constructor(
    dbPath: string,
    private readonly options?: DatabaseOptions
  ) {
    this.core = new DatabaseCore(dbPath, { queryObservability: options?.queryObservability });
    this.messageSearchIndexFlushIntervalMs =
      options?.messageSearchIndexFlushIntervalMs ?? Database.MESSAGE_SEARCH_INDEX_FLUSH_INTERVAL_MS;
  }

  getDbPath(): string {
    return this.core.getDbPath();
  }

  readonly runSpaceTaskOp: RunDbOp = (op, args) => this.gateway.run(op, args);

  notifyChange(table: string, scope?: { sessionId?: string; taskId?: string }): void {
    this.reactiveDb?.notifyChange(table, scope);
  }

  async initialize(reactiveDb: ReactiveDatabase): Promise<void> {
    await this.core.initialize();
    this.reactiveDb = reactiveDb;
    bindGateway(this.core.getDb(), this.gateway);
    bindSpaceTaskLane(this.core.getDb(), this.gateway);
    if (reactiveDb) {
      const replay = (changes: TableChange[]) => {
        reactiveDb.beginTransaction();
        for (const { table, scope } of changes) reactiveDb.notifyChange(table, scope);
        reactiveDb.commitTransaction();
      };
      this.gateway.onChanges = replay;
    }

    const db = this.core.getDb();
    this.shortIdAllocator = new ShortIdAllocator(db);
    this.sessionRepo = new SessionRepository(db);
    this.sdkMessageRepo = new SDKMessageRepository(db, reactiveDb);
    this.settingsRepo = new SettingsRepository(db);
    this.inboxItemRepo = new InboxItemRepository(db);
    this.spaceTaskRepo = new SpaceTaskRepository(db, reactiveDb);
    this.nodeExecutionRepo = new NodeExecutionRepository(db, reactiveDb);
    this.longHorizonAgentRepo = new SpaceLongHorizonAgentRepository(db);
    this.jobQueueRepo = new JobQueueRepository(db);
    this.appMcpServerRepo = new AppMcpServerRepository(db, reactiveDb);
    this.mcpEnablementRepo = new McpEnablementRepository(db, reactiveDb);
    this.skillRepo = new SkillRepository(db, reactiveDb);
    this.workspaceHistoryRepo = new WorkspaceHistoryRepository(db);
    this.agentMemoryRepo = new AgentMemoryRepository(db, reactiveDb, this.embedder);
    this.evolutionRepo = new EvolutionRepository(db);
    this.goalAutomationCursorRepo = new GoalAutomationCursorRepository(db);
    this.providerRepo = new ProviderRepository(db, reactiveDb);
    this.agentMemoryRepo.backfillPendingEmbeddings();
    await this.flushMessageSearchIndex();
    if (this.messageSearchIndexFlushIntervalMs > 0) {
      this.messageSearchIndexTimer = setInterval(
        () => void this.flushMessageSearchIndex(),
        this.messageSearchIndexFlushIntervalMs
      );
      this.messageSearchIndexTimer.unref?.();
    }
  }

  private async flushMessageSearchIndex(): Promise<void> {
    if (this.messageSearchIndexFlushing) return;
    this.messageSearchIndexFlushing = true;
    try {
      let skip = 0;
      for (let batch = 0; batch < 5; batch++) {
        const { attempted, failed } = await this.gateway.call(
          messageSearchIndexWrites,
          'flushMessageSearchIndex',
          100,
          skip
        );
        if (attempted < 100) return;
        skip += failed;
      }
    } catch (err) {
      this.logger.warn('message search index flush failed:', err);
    } finally {
      this.messageSearchIndexFlushing = false;
    }
  }

  async createSession(session: Session, options?: SessionCreationOptions): Promise<void> {
    const selection = await this.gateway.call(
      sessionWrites,
      'createSessionWithToolDefaults',
      structuredClone(postable(session)),
      options ? structuredClone(options) : undefined
    );
    session.config.toolSelection = selection;
    this.reactiveDb?.forgetSessionTask(session.id);
  }

  isWorkspaceRegisteredToSpace(spaceId: string, workspacePath: string): boolean {
    return this.sessionRepo.isWorkspaceRegisteredToSpace(spaceId, workspacePath);
  }

  getSession(id: string): Session | null {
    return this.sessionRepo.getSession(id);
  }

  getSessionIncarnation(id: string): number | null {
    return this.sessionRepo.getSessionIncarnation(id);
  }

  listSessions(options?: {
    status?: string;
    includeArchived?: boolean;
    includeSpaceSessions?: boolean;
  }): Session[] {
    return this.sessionRepo.listSessions(options);
  }

  countHumanSessions(): number {
    return this.sessionRepo.countHumanSessions();
  }

  listSessionsBySpaceAgent(spaceId: string, agentId: string): Session[] {
    return this.sessionRepo.listSessionsBySpaceAgent(spaceId, agentId);
  }

  async clearAcpSessionIds(): Promise<void> {
    return this.gateway.call(sessionWrites, 'clearAcpSessionIds');
  }

  listProcessingSessionIds(): string[] {
    return this.sessionRepo.listProcessingSessionIds();
  }

  async markRestartInterruptedTurns(): Promise<number> {
    return this.gateway.call(sessionWrites, 'markRestartInterruptedTurns');
  }

  listRestartCooldownResumes(): Array<{ sessionId: string; resumeAt: number }> {
    return this.sessionRepo.listRestartCooldownResumes();
  }

  async takeRestartCooldownResume(sessionId: string): Promise<boolean> {
    return this.gateway.call(sessionWrites, 'takeRestartCooldownResume', sessionId);
  }

  listAcpSessionIds(): Array<{ sessionId: string; acpSessionId: string }> {
    return this.sessionRepo.listAcpSessionIds();
  }

  async updateSession(id: string, updates: Partial<Session>): Promise<SessionWriteOutcome> {
    const readStatus = updates.status ? (this.sessionRepo.getSession(id)?.status ?? null) : null;
    const outcome = await this.gateway.call(
      sessionWrites,
      'guardedUpdateSession',
      id,
      postable(updates),
      readStatus
    );
    if (outcome !== 'written') {
      this.logger.warn(
        `refused status ${updates.status} for session ${id}: ${outcome} (read ${readStatus})`
      );
      return outcome;
    }
    if (updates.type !== undefined || 'context' in updates) this.reactiveDb?.forgetSessionTask(id);
    return outcome;
  }

  captureSessionInputDraft(id: string): SessionInputDraftSnapshot | null {
    return this.sessionRepo.captureSessionInputDraft(id);
  }
  async casSessionInputDraft(
    snapshot: SessionInputDraftSnapshot,
    text: string | null
  ): Promise<'won' | 'superseded' | 'invalid'> {
    return this.gateway.call(sessionWrites, 'casSessionInputDraft', snapshot, text);
  }

  captureSessionRuntimeSettings(id: string): SessionRuntimeSettingsSnapshot | null {
    return this.sessionRepo.captureSessionRuntimeSettings(id);
  }
  async casSessionRuntimeSettings(
    snapshot: SessionRuntimeSettingsSnapshot,
    patch: RuntimeSettingsPatch
  ): Promise<'won' | 'superseded'> {
    return this.gateway.call(sessionWrites, 'casSessionRuntimeSettings', snapshot, patch);
  }

  async casSessionToolPreferences(
    snapshot: SessionRuntimeSettingsSnapshot,
    patch: RuntimeSettingsPatch,
    guards: readonly ToolPreferenceSnapshot[],
    override?: SessionMcpPreferenceEdit
  ): Promise<'won' | 'superseded'> {
    return this.gateway.call(
      sessionWrites,
      'casSessionToolPreferences',
      snapshot,
      patch,
      guards,
      override
    );
  }

  async deleteSession(id: string): Promise<void> {
    await this.gateway.call(sessionWrites, 'deleteSession', id);
    this.reactiveDb?.forgetSessionTask(id);
  }

  listChildSessions(parentId: string): Session[] {
    return this.sessionRepo.listChildren(parentId);
  }

  async detachSessionFromParent(id: string): Promise<void> {
    return this.gateway.call(sessionWrites, 'detachFromParent', id);
  }

  async setSessionParent(id: string, parentId: string | null): Promise<void> {
    return this.gateway.call(sessionWrites, 'setParent', id, parentId);
  }

  async setSessionLastError(id: string, lastError: string | null): Promise<void> {
    return this.gateway.call(sessionWrites, 'setLastError', id, lastError);
  }

  saveSDKMessage(
    sessionId: string,
    message: SDKMessage,
    origin?: MessageOrigin,
    options?: { stampInternalCompactionTurn?: boolean }
  ): Promise<boolean> {
    return this.writeSDKMessage('saveSDKMessage', sessionId, message, origin, options);
  }

  getSDKMessages(
    sessionId: string,
    limit?: number,
    before?: number,
    since?: number,
    beforeRowid?: number,
    sinceRowid?: number
  ): {
    messages: Array<
      ChatMessage & { timestamp: number; origin?: MessageOrigin; sendStatus?: string }
    >;
    hasMore: boolean;
  } {
    return this.sdkMessageRepo.getSDKMessages(
      sessionId,
      limit,
      before,
      since,
      beforeRowid,
      sinceRowid
    );
  }

  getBackgroundTaskMessages(sessionId: string): Array<ChatMessage & { timestamp: number }> {
    return this.sdkMessageRepo.getBackgroundTaskMessages(sessionId);
  }

  getSDKMessagesByType(
    sessionId: string,
    messageType: string,
    messageSubtype?: string,
    limit = 100
  ): SDKMessage[] {
    return this.sdkMessageRepo.getSDKMessagesByType(sessionId, messageType, messageSubtype, limit);
  }

  getRenderableTextMessages(
    sessionId: string,
    limit?: number
  ): Array<{ id: string; type: string; text: string; timestamp: number }> {
    return this.sdkMessageRepo.getRenderableTextMessages(sessionId, limit);
  }

  getSDKMessageCount(sessionId: string): number {
    return this.sdkMessageRepo.getSDKMessageCount(sessionId);
  }

  async saveUserMessage(
    sessionId: string,
    message: SDKMessage,
    sendStatus: SendStatus = 'consumed',
    origin?: MessageOrigin
  ): Promise<string> {
    return this.writeSDKMessage('saveUserMessage', sessionId, message, sendStatus, origin);
  }

  getUserMessagesByStatus(
    sessionId: string,
    status: SendStatus,
    limit?: number,
    direction?: 'asc' | 'desc'
  ): {
    messages: Array<SDKUserMessage & { dbId: string; timestamp: number }>;
    total: number;
  } {
    return this.sdkMessageRepo.getUserMessagesByStatus(sessionId, status, limit, direction);
  }

  async getUserMessagesByStatusAsync(sessionId: string, status: SendStatus, limit: number) {
    if (this.getDbPath() === ':memory:')
      return projectSDKStatusPage(this.getUserMessagesByStatus(sessionId, status, limit), status);
    return this.getSDKReader().read({ sessionId, status, limit });
  }

  async getNeoMessageStatusFactsAsync(refs: NeoMessageStatusRef[]) {
    if (this.getDbPath() === ':memory:')
      return this.getDatabase().transaction(() => readMessageFacts(this.getDatabase(), refs))();
    return this.getSDKReader().readNeoMessageStatusFacts(refs);
  }

  async getMessageFeedAsync(args: MessageFeedArgs) {
    if (this.getDbPath() === ':memory:')
      return this.getDatabase().transaction(() => readMessageFeed(this.getDatabase(), args))();
    return this.getSDKReader().readMessageFeed(args);
  }

  async getSDKMessagePageAsync(sessionId: string, page: SDKPageParams = {}) {
    if (this.getDbPath() === ':memory:')
      return readSDKMessagePage(this.sdkMessageRepo, { sessionId, page });
    return this.getSDKReader().readMessages({ sessionId, page });
  }

  searchNeoCardsAsync(query: string, cursor?: string, limit?: number): Promise<NeoCardSearchPage> {
    if (this.getDbPath() === ':memory:') {
      return Promise.resolve(
        searchNeoCards(
          (sql, bindings) =>
            this.core.getDb().prepare(sql).all(...bindings) as unknown[],
          query,
          cursor,
          limit
        )
      );
    }
    return this.getSDKReader().readNeoCardSearch({ cardQuery: { query, cursor, limit } });
  }

  async searchWorkChatsAsync(
    query: string,
    limit: number,
    semantic?: { vector: Float32Array; model: string },
    kinds?: readonly WorkChatKind[]
  ) {
    if (this.getDbPath() === ':memory:')
      return this.sdkMessageRepo.searchWorkChats(query, limit, semantic, kinds);
    return this.getSDKReader().readWorkChats({
      query,
      limit,
      semantic: semantic
        ? { model: semantic.model, vector: Array.from(semantic.vector) }
        : undefined,
      kinds,
    });
  }

  async readPendingTurnsAsync(model: string, dimensions: number, limit: number) {
    if (this.getDbPath() === ':memory:')
      return readPendingTurns(this.getDatabase(), model, dimensions, limit);
    return this.getSDKReader().readPendingTurns(model, dimensions, limit);
  }

  async countPendingTurnsAsync(model: string, dimensions: number) {
    if (this.getDbPath() === ':memory:')
      return countPendingTurns(this.getDatabase(), model, dimensions);
    return this.getSDKReader().countPendingTurns(model, dimensions);
  }

  async readHyperneoTurnEndsAsync(sessionId: string, since: number) {
    if (this.getDbPath() === ':memory:')
      return readHyperneoTurnEnds(this.getDatabase(), sessionId, since);
    return this.getSDKReader().readHyperneoTurnEnds(sessionId, since);
  }

  readCodexSnapshotAsync(statePath: string, includeClosed: boolean) {
    return this.getSDKReader().readCodexSnapshot(statePath, includeClosed);
  }

  get gateway(): DbGateway {
    return (this.dbGateway ??= new DbGateway(
      this.getDbPath(),
      this.getDbPath() === ':memory:' || typeof Worker === 'undefined' ? this.getDatabase() : null,
      this.options?.queryObservability
    ));
  }

  private getSDKReader() {
    return (this.sdkStatusReader ??= new SDKStatusReader(
      this.getDbPath(),
      undefined,
      undefined,
      this.options?.queryObservability,
      (args) =>
        'codexSnapshot' in args
          ? Promise.resolve()
          : this.core.waitForSdkMessageColumns(
              'sessionId' in args
                ? args.sessionId
                : 'hyperneoTurnEnds' in args
                  ? args.hyperneoTurnEnds.sessionId
                  : undefined,
              false
            )
    ));
  }

  getMessageByStatusAndUuid(
    sessionId: string,
    status: SendStatus,
    uuid: string
  ): (SDKMessage & { dbId: string; timestamp: number }) | null {
    return this.sdkMessageRepo.getMessageByStatusAndUuid(sessionId, status, uuid);
  }

  getMessageByStatusAndDbId(
    sessionId: string,
    status: SendStatus,
    dbId: string
  ): (SDKMessage & { dbId: string; timestamp: number }) | null {
    return this.sdkMessageRepo.getMessageByStatusAndDbId(sessionId, status, dbId);
  }

  getUserMessageIdsByStatus(
    sessionId: string,
    status: SendStatus
  ): Array<{ dbId: string; uuid: string | undefined; timestamp: number }> {
    return this.sdkMessageRepo.getUserMessageIdsByStatus(sessionId, status);
  }

  async updateMessageStatus(messageIds: string[], newStatus: SendStatus): Promise<void> {
    return this.writeSDKMessage('updateMessageStatus', messageIds, newStatus);
  }

  async updateMessageTimestamp(messageId: string, timestampMs?: number): Promise<void> {
    return this.writeSDKMessage('updateMessageTimestamp', messageId, timestampMs);
  }

  async deletePendingUserMessage(
    sessionId: string,
    messageId: string,
    expectedStatus?: 'deferred' | 'enqueued'
  ): Promise<{ dbId: string; uuid: string; status: 'deferred' | 'enqueued' } | null> {
    return this.writeSDKMessage('deletePendingUserMessage', sessionId, messageId, expectedStatus);
  }

  async deferEnqueuedUserMessage(
    sessionId: string,
    messageId: string
  ): Promise<{ dbId: string; uuid: string } | null> {
    return this.writeSDKMessage('deferEnqueuedUserMessage', sessionId, messageId);
  }

  beginTransaction?(): void;
  commitTransaction?(): void;
  abortTransaction?(): void;

  async deleteMessagesAfter(sessionId: string, afterTimestamp: number): Promise<number> {
    return this.writeSDKMessage('deleteMessagesAfter', sessionId, afterTimestamp);
  }

  async deleteMessagesAtAndAfter(sessionId: string, atTimestamp: number): Promise<number> {
    return this.writeSDKMessage('deleteMessagesAtAndAfter', sessionId, atTimestamp);
  }

  getUserMessages(sessionId: string): Array<{ uuid: string; timestamp: number; content: string }> {
    return this.sdkMessageRepo.getUserMessages(sessionId);
  }

  getUserMessageByUuid(
    sessionId: string,
    uuid: string
  ): { uuid: string; timestamp: number; content: string } | undefined {
    return this.sdkMessageRepo.getUserMessageByUuid(sessionId, uuid);
  }

  countMessagesAfter(sessionId: string, afterTimestamp: number): number {
    return this.sdkMessageRepo.countMessagesAfter(sessionId, afterTimestamp);
  }

  async saveHyperNeoActionMessage(
    sessionId: string,
    message: HyperNeoActionMessage
  ): Promise<string> {
    return this.writeSDKMessage('saveHyperNeoActionMessage', sessionId, message);
  }

  async updateHyperNeoActionMessage(rowId: string, updated: HyperNeoActionMessage): Promise<void> {
    return this.writeSDKMessage('updateHyperNeoActionMessage', rowId, updated);
  }

  async updateHyperNeoActionMessageByUuid(
    sessionId: string,
    messageUuid: string,
    updated: HyperNeoActionMessage
  ): Promise<void> {
    return this.writeSDKMessage(
      'updateHyperNeoActionMessageByUuid',
      sessionId,
      messageUuid,
      updated
    );
  }

  getGlobalToolsConfig(): GlobalToolsConfig {
    return this.settingsRepo.getGlobalToolsConfig();
  }

  getGlobalSettings(): GlobalSettings {
    return this.settingsRepo.getGlobalSettings();
  }

  saveGlobalSettings(settings: GlobalSettings): void {
    this.settingsRepo.saveGlobalSettings(settings);
  }

  updateGlobalSettings(updates: Partial<GlobalSettings>): GlobalSettings {
    return this.settingsRepo.updateGlobalSettings(updates);
  }

  createInboxItem(params: CreateInboxItemParams): InboxItem {
    return this.inboxItemRepo.createItem(params);
  }

  countInboxItemsByStatus(status: 'pending' | 'routed' | 'dismissed' | 'blocked'): number {
    return this.inboxItemRepo.countByStatus(status);
  }

  getDatabase(): BunDatabase {
    return this.core.getDb();
  }

  getShortIdAllocator(): ShortIdAllocator {
    return this.shortIdAllocator;
  }

  getSDKMessageRepo(): SDKMessageRepository {
    return this.sdkMessageRepo;
  }

  async writeSDKMessage<K extends SdkMessageWriteMethod>(
    method: K,
    ...args: Parameters<SDKMessageRepository[K]>
  ): Promise<ReturnType<SDKMessageRepository[K]>> {
    return this.sdkMessageRepo.write(method, ...args);
  }

  getSpaceTaskRepo(): SpaceTaskRepository {
    return this.spaceTaskRepo;
  }

  getNodeExecutionRepo(): NodeExecutionRepository {
    return this.nodeExecutionRepo;
  }

  getLongHorizonAgentRepo(): SpaceLongHorizonAgentRepository {
    return this.longHorizonAgentRepo;
  }

  getDatabasePath(): string {
    return this.core.getDbPath();
  }

  getDataMigrationStatus() {
    return this.core.getDataMigrationStatus();
  }

  waitForSdkMessageColumns(sessionId?: string, wait = true) {
    return this.core.waitForSdkMessageColumns(sessionId, wait);
  }

  stopSdkMessageColumnsBackfill(): void {
    this.core.stopSdkMessageColumnsBackfill();
  }

  startSdkMessageColumnsBackfill(changed?: () => void) {
    return this.core.startSdkMessageColumnsBackfill(changed);
  }

  startMessageSearchMerges(): void {
    this.core.startMessageSearchMerges();
  }

  startSdkMessageBodyCopy(): void {
    this.core.startSdkMessageBodyCopy();
  }

  getJobQueueRepo(): JobQueueRepository {
    return this.jobQueueRepo;
  }

  warmEmbedder(): void {
    this.embedder.warm();
  }

  getEmbedder(): AgentMemoryEmbedder {
    return this.embedder;
  }

  get appMcpServers(): AppMcpServerRepository {
    return this.appMcpServerRepo;
  }

  get mcpEnablement(): McpEnablementRepository {
    return this.mcpEnablementRepo;
  }

  get skills(): SkillRepository {
    return this.skillRepo;
  }

  get workspaceHistory(): WorkspaceHistoryRepository {
    return this.workspaceHistoryRepo;
  }

  get agentMemory(): AgentMemoryRepository {
    return this.agentMemoryRepo;
  }

  get evolution(): EvolutionRepository {
    return this.evolutionRepo;
  }

  get goalAutomationCursors(): GoalAutomationCursorRepository {
    return this.goalAutomationCursorRepo;
  }

  get providers(): ProviderRepository {
    return this.providerRepo;
  }

  close(): void | Promise<void> {
    this.embedder.stop();
    if (this.messageSearchIndexTimer) {
      clearInterval(this.messageSearchIndexTimer);
      this.messageSearchIndexTimer = null;
    }
    const gateway = this.dbGateway?.close();
    if (this.sdkStatusReader || gateway)
      return Promise.all([this.sdkStatusReader?.close(), gateway])
        .then(() => {})
        .finally(() => this.core.close());
    this.core.close();
  }
}

function postable<T extends Partial<Session>>(session: T): T {
  if (!session.config) return session;
  const config = Object.fromEntries(
    Object.entries(session.config).filter(
      ([key, value]) => value === undefined || sessionConfigReplacer(key, value) !== undefined
    )
  );
  return { ...session, config };
}
