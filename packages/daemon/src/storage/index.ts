import { bindGateway, DbGateway } from './db-gateway/db-gateway.ts';
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
import { SessionRepository } from './repositories/session-repository.ts';
import type { SessionInputDraftSnapshot } from './repositories/session-input-draft-write.ts';
import type {
  RuntimeSettingsPatch,
  SessionRuntimeSettingsSnapshot,
} from './repositories/session-runtime-settings-write.ts';
import {
  messageSearchIndexWrites,
  SDKMessageRepository,
  type SendStatus,
} from './repositories/sdk-message-repository.ts';
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

  notifyChange(table: string, scope?: { sessionId?: string; taskId?: string }): void {
    this.reactiveDb?.notifyChange(table, scope);
  }

  async initialize(reactiveDb: ReactiveDatabase): Promise<void> {
    await this.core.initialize();
    this.reactiveDb = reactiveDb;
    bindGateway(this.core.getDb(), this.gateway);
    this.gateway.onChanges = (changes) => {
      reactiveDb.beginTransaction();
      for (const { table, scope } of changes) reactiveDb.notifyChange(table, scope);
      reactiveDb.commitTransaction();
    };

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
      for (let batch = 0; batch < 5; batch++) {
        const flushed = await this.gateway.call(
          messageSearchIndexWrites,
          'flushMessageSearchIndex',
          100
        );
        if (flushed < 100) return;
      }
    } catch (err) {
      this.logger.warn('message search index flush failed:', err);
    } finally {
      this.messageSearchIndexFlushing = false;
    }
  }

  async createSession(
    session: Session,
    options?: { enforceWorkspaceOwnership?: boolean; ownershipPath?: string }
  ): Promise<void> {
    this.sessionRepo.createSession(session, options);
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
    this.sessionRepo.clearAcpSessionIds();
  }

  listProcessingSessionIds(): string[] {
    return this.sessionRepo.listProcessingSessionIds();
  }

  async markRestartInterruptedTurns(): Promise<number> {
    return this.sessionRepo.markRestartInterruptedTurns();
  }

  listRestartCooldownResumes(): Array<{ sessionId: string; resumeAt: number }> {
    return this.sessionRepo.listRestartCooldownResumes();
  }

  async takeRestartCooldownResume(sessionId: string): Promise<boolean> {
    return this.sessionRepo.takeRestartCooldownResume(sessionId);
  }

  listAcpSessionIds(): Array<{ sessionId: string; acpSessionId: string }> {
    return this.sessionRepo.listAcpSessionIds();
  }

  async updateSession(id: string, updates: Partial<Session>): Promise<void> {
    this.sessionRepo.updateSession(id, updates);
  }

  captureSessionInputDraft(id: string): SessionInputDraftSnapshot | null {
    return this.sessionRepo.captureSessionInputDraft(id);
  }
  async casSessionInputDraft(
    snapshot: SessionInputDraftSnapshot,
    text: string | null
  ): Promise<'won' | 'superseded' | 'invalid'> {
    return this.sessionRepo.casSessionInputDraft(snapshot, text);
  }

  captureSessionRuntimeSettings(id: string): SessionRuntimeSettingsSnapshot | null {
    return this.sessionRepo.captureSessionRuntimeSettings(id);
  }
  async casSessionRuntimeSettings(
    snapshot: SessionRuntimeSettingsSnapshot,
    patch: RuntimeSettingsPatch
  ): Promise<'won' | 'superseded'> {
    return this.sessionRepo.casSessionRuntimeSettings(snapshot, patch);
  }

  async deleteSession(id: string): Promise<void> {
    this.sessionRepo.deleteSession(id);
  }

  listChildSessions(parentId: string): Session[] {
    return this.sessionRepo.listChildren(parentId);
  }

  async detachSessionFromParent(id: string): Promise<void> {
    this.sessionRepo.detachFromParent(id);
  }

  async setSessionParent(id: string, parentId: string | null): Promise<void> {
    this.sessionRepo.setParent(id, parentId);
  }

  async setSessionLastError(id: string, lastError: string | null): Promise<void> {
    this.sessionRepo.setLastError(id, lastError);
  }

  saveSDKMessage(
    sessionId: string,
    message: SDKMessage,
    origin?: MessageOrigin,
    options?: { stampInternalCompactionTurn?: boolean }
  ): Promise<boolean> {
    return Promise.resolve(this.sdkMessageRepo.saveSDKMessage(sessionId, message, origin, options));
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
    return this.sdkMessageRepo.saveUserMessage(sessionId, message, sendStatus, origin);
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
      this.options?.queryObservability
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
    this.sdkMessageRepo.updateMessageStatus(messageIds, newStatus);
  }

  async updateMessageTimestamp(messageId: string, timestampMs?: number): Promise<void> {
    this.sdkMessageRepo.updateMessageTimestamp(messageId, timestampMs);
  }

  async deletePendingUserMessage(
    sessionId: string,
    messageId: string,
    expectedStatus?: 'deferred' | 'enqueued'
  ): Promise<{ dbId: string; uuid: string; status: 'deferred' | 'enqueued' } | null> {
    return this.sdkMessageRepo.deletePendingUserMessage(sessionId, messageId, expectedStatus);
  }

  async deferEnqueuedUserMessage(
    sessionId: string,
    messageId: string
  ): Promise<{ dbId: string; uuid: string } | null> {
    return this.sdkMessageRepo.deferEnqueuedUserMessage(sessionId, messageId);
  }

  beginTransaction?(): void;
  commitTransaction?(): void;
  abortTransaction?(): void;

  async deleteMessagesAfter(sessionId: string, afterTimestamp: number): Promise<number> {
    return this.sdkMessageRepo.deleteMessagesAfter(sessionId, afterTimestamp);
  }

  async deleteMessagesAtAndAfter(sessionId: string, atTimestamp: number): Promise<number> {
    return this.sdkMessageRepo.deleteMessagesAtAndAfter(sessionId, atTimestamp);
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
    return this.sdkMessageRepo.saveHyperNeoActionMessage(sessionId, message);
  }

  async updateHyperNeoActionMessage(rowId: string, updated: HyperNeoActionMessage): Promise<void> {
    this.sdkMessageRepo.updateHyperNeoActionMessage(rowId, updated);
  }

  async updateHyperNeoActionMessageByUuid(
    sessionId: string,
    messageUuid: string,
    updated: HyperNeoActionMessage
  ): Promise<void> {
    this.sdkMessageRepo.updateHyperNeoActionMessageByUuid(sessionId, messageUuid, updated);
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
