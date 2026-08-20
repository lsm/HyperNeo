import { Database as BunDatabase } from './sqlite-compat';
import { Logger } from '../lib/logger';
import type {
  Session,
  GlobalToolsConfig,
  GlobalSettings,
  RoomGitHubMapping,
  InboxItem,
  MessageOrigin,
  HyperNeoActionMessage,
  ChatMessage,
} from '@hyperneo/shared';
import type { GoalStatus, RoomGoal } from '@hyperneo/shared/types/neo';
import type { SDKMessage, SDKUserMessage } from '@hyperneo/shared/sdk';
import { DatabaseCore } from './database-core';
import { ShortIdAllocator } from '../lib/short-id-allocator';
export { ShortIdAllocator } from '../lib/short-id-allocator';
import { SessionRepository } from './repositories/session-repository';
import { SDKMessageRepository, type SendStatus } from './repositories/sdk-message-repository';
import { SettingsRepository } from './repositories/settings-repository';
import { GitHubMappingRepository } from './repositories/github-mapping-repository';
import {
  InboxItemRepository,
  type CreateInboxItemParams,
  type InboxItemFilter,
} from './repositories/inbox-item-repository';
import {
  GoalRepository,
  type CreateGoalParams,
  type UpdateGoalParams,
} from './repositories/goal-repository';
import { JobQueueRepository } from './repositories/job-queue-repository';
import { AppMcpServerRepository } from './repositories/app-mcp-server-repository';
import { TaskRepository } from './repositories/task-repository';
import { SpaceTaskRepository } from './repositories/space-task-repository';
import { NodeExecutionRepository } from './repositories/node-execution-repository';
import { McpEnablementRepository } from './repositories/mcp-enablement-repository';
import { SkillRepository } from './repositories/skill-repository';
import { WorkspaceHistoryRepository } from './repositories/workspace-history-repository';
import { TransformersAgentMemoryEmbedder } from './repositories/agent-memory-transformers';
import { AgentMemoryRepository } from './repositories/agent-memory-repository';
import { EvolutionRepository } from './repositories/evolution-repository';
import { GoalAutomationCursorRepository } from './repositories/goal-automation-cursor-repository';
import { ProviderRepository } from './repositories/provider-repository';
import type { ReactiveDatabase } from './reactive-database';

export type { SendStatus } from './repositories/sdk-message-repository';
export type { SQLiteValue } from './types';
export type { CreateInboxItemParams, InboxItemFilter } from './repositories/inbox-item-repository';
export type {
  CreateGoalParams,
  UpdateGoalParams,
  CreateExecutionParams,
  UpdateExecutionParams,
} from './repositories/goal-repository';
export { getEffectiveMaxPlanningAttempts } from './repositories/goal-repository';
export type { Job, EnqueueParams } from './repositories/job-queue-repository';
export { JobQueueProcessor } from './job-queue-processor';
export type {
  JobHandler,
  JobHandlerContext,
  JobQueueProcessorOptions,
} from './job-queue-processor';

// @public - Library export
export { GoalRepository } from './repositories/goal-repository';
export { TaskRepository } from './repositories/task-repository';
export { SpaceAgentRepository } from './repositories/space-agent-repository';
export { SpaceAgentInboxRepository } from './repositories/space-agent-inbox-repository';
export type {
  SpaceAgentInboxMessageRecord,
  SpaceAgentInboxMessageStatus,
} from './repositories/space-agent-inbox-repository';
export { AppMcpServerRepository } from './repositories/app-mcp-server-repository';
export { McpEnablementRepository } from './repositories/mcp-enablement-repository';
export { SkillRepository } from './repositories/skill-repository';
export { WorkspaceHistoryRepository } from './repositories/workspace-history-repository';
export { AgentMemoryRepository } from './repositories/agent-memory-repository';
export { EvolutionRepository } from './repositories/evolution-repository';
export { GoalAutomationCursorRepository } from './repositories/goal-automation-cursor-repository';
export { ProviderRepository } from './repositories/provider-repository';
export { WorkflowHookStateRepository } from './repositories/workflow-hook-state-repository';
export type { WorkflowHookStatePatch } from './repositories/workflow-hook-state-repository';
export type { GoalAutomationCursor } from './repositories/goal-automation-cursor-repository';
export type {
  AgentMemoryEntry,
  AgentMemorySearchResult,
} from './repositories/agent-memory-repository';
export type { WorkspaceHistoryRow } from './repositories/workspace-history-repository';
export type {
  ProviderRecord,
  CreateProviderParams,
  UpdateProviderParams,
} from '@hyperneo/shared';

export interface DatabaseOptions {
  messageSearchIndexFlushIntervalMs?: number;
}

export class Database {
  private logger = new Logger('Database');
  private core: DatabaseCore;
  private sessionRepo!: SessionRepository;
  private sdkMessageRepo!: SDKMessageRepository;
  private settingsRepo!: SettingsRepository;
  private githubMappingRepo!: GitHubMappingRepository;
  private inboxItemRepo!: InboxItemRepository;
  private goalRepo!: GoalRepository;
  private jobQueueRepo!: JobQueueRepository;
  private appMcpServerRepo!: AppMcpServerRepository;
  private taskRepo!: TaskRepository;
  private spaceTaskRepo!: SpaceTaskRepository;
  private nodeExecutionRepo!: NodeExecutionRepository;
  private mcpEnablementRepo!: McpEnablementRepository;
  private skillRepo!: SkillRepository;
  private workspaceHistoryRepo!: WorkspaceHistoryRepository;
  private agentMemoryRepo!: AgentMemoryRepository;
  private evolutionRepo!: EvolutionRepository;
  private goalAutomationCursorRepo!: GoalAutomationCursorRepository;
  private providerRepo!: ProviderRepository;
  private shortIdAllocator!: ShortIdAllocator;
  private reactiveDb?: ReactiveDatabase;
  private messageSearchIndexTimer: ReturnType<typeof setInterval> | null = null;
  private readonly messageSearchIndexFlushIntervalMs: number;

  private static readonly MESSAGE_SEARCH_INDEX_FLUSH_INTERVAL_MS = 2_000;

  constructor(dbPath: string, options?: DatabaseOptions) {
    this.core = new DatabaseCore(dbPath);
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

    const db = this.core.getDb();
    this.shortIdAllocator = new ShortIdAllocator(db);
    const shortIdAllocator = this.shortIdAllocator;
    this.sessionRepo = new SessionRepository(db);
    this.sdkMessageRepo = new SDKMessageRepository(db, reactiveDb);
    this.settingsRepo = new SettingsRepository(db);
    this.githubMappingRepo = new GitHubMappingRepository(db);
    this.inboxItemRepo = new InboxItemRepository(db);
    this.goalRepo = new GoalRepository(db, reactiveDb, shortIdAllocator);
    this.taskRepo = new TaskRepository(db, reactiveDb, shortIdAllocator);
    this.spaceTaskRepo = new SpaceTaskRepository(db, reactiveDb);
    this.nodeExecutionRepo = new NodeExecutionRepository(db, reactiveDb);
    this.jobQueueRepo = new JobQueueRepository(db);
    this.appMcpServerRepo = new AppMcpServerRepository(db, reactiveDb);
    this.mcpEnablementRepo = new McpEnablementRepository(db, reactiveDb);
    this.skillRepo = new SkillRepository(db, reactiveDb);
    this.workspaceHistoryRepo = new WorkspaceHistoryRepository(db);
    this.agentMemoryRepo = new AgentMemoryRepository(
      db,
      reactiveDb,
      new TransformersAgentMemoryEmbedder()
    );
    this.evolutionRepo = new EvolutionRepository(db);
    this.goalAutomationCursorRepo = new GoalAutomationCursorRepository(db);
    this.providerRepo = new ProviderRepository(db, reactiveDb);
    this.agentMemoryRepo.backfillPendingEmbeddings();
    this.sdkMessageRepo.flushMessageSearchIndex();
    if (this.messageSearchIndexFlushIntervalMs > 0) {
      this.messageSearchIndexTimer = setInterval(() => {
        try {
          this.sdkMessageRepo.flushMessageSearchIndex();
        } catch (err) {
          this.logger.warn('message search index flush failed:', err);
        }
      }, this.messageSearchIndexFlushIntervalMs);
      this.messageSearchIndexTimer.unref?.();
    }
  }

  createSession(session: Session): void {
    this.sessionRepo.createSession(session);
  }

  getSession(id: string): Session | null {
    return this.sessionRepo.getSession(id);
  }

  listSessions(options?: {
    status?: string;
    includeArchived?: boolean;
    includeSpaceSessions?: boolean;
  }): Session[] {
    return this.sessionRepo.listSessions(options);
  }

  listSessionsBySpaceAgent(spaceId: string, agentId: string): Session[] {
    return this.sessionRepo.listSessionsBySpaceAgent(spaceId, agentId);
  }

  updateSession(id: string, updates: Partial<Session>): void {
    this.sessionRepo.updateSession(id, updates);
  }

  deleteSession(id: string): void {
    this.sessionRepo.deleteSession(id);
  }

  saveSDKMessage(sessionId: string, message: SDKMessage, origin?: MessageOrigin): boolean {
    return this.sdkMessageRepo.saveSDKMessage(sessionId, message, origin);
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

  saveUserMessage(
    sessionId: string,
    message: SDKMessage,
    sendStatus: SendStatus = 'consumed',
    origin?: MessageOrigin
  ): string {
    return this.sdkMessageRepo.saveUserMessage(sessionId, message, sendStatus, origin);
  }

  getMessagesByStatus(
    sessionId: string,
    status: SendStatus
  ): Array<SDKMessage & { dbId: string; timestamp: number }> {
    return this.sdkMessageRepo.getMessagesByStatus(sessionId, status);
  }

  getUserMessagesByStatus(
    sessionId: string,
    status: SendStatus,
    limit: number
  ): {
    messages: Array<SDKUserMessage & { dbId: string; timestamp: number }>;
    total: number;
  } {
    return this.sdkMessageRepo.getUserMessagesByStatus(sessionId, status, limit);
  }

  getMessageByStatusAndUuid(
    sessionId: string,
    status: SendStatus,
    uuid: string
  ): (SDKMessage & { dbId: string; timestamp: number }) | null {
    return this.sdkMessageRepo.getMessageByStatusAndUuid(sessionId, status, uuid);
  }

  updateMessageStatus(messageIds: string[], newStatus: SendStatus): void {
    this.sdkMessageRepo.updateMessageStatus(messageIds, newStatus);
  }

  updateMessageTimestamp(messageId: string, timestampMs?: number): void {
    this.sdkMessageRepo.updateMessageTimestamp(messageId, timestampMs);
  }

  deletePendingUserMessage(
    sessionId: string,
    messageId: string,
    expectedStatus?: 'deferred' | 'enqueued'
  ): { dbId: string; uuid: string; status: 'deferred' | 'enqueued' } | null {
    return this.sdkMessageRepo.deletePendingUserMessage(sessionId, messageId, expectedStatus);
  }

  deferEnqueuedUserMessage(
    sessionId: string,
    messageId: string
  ): { dbId: string; uuid: string } | null {
    return this.sdkMessageRepo.deferEnqueuedUserMessage(sessionId, messageId);
  }

  beginTransaction?(): void;
  commitTransaction?(): void;
  abortTransaction?(): void;

  getMessageCountByStatus(sessionId: string, status: SendStatus): number {
    return this.sdkMessageRepo.getMessageCountByStatus(sessionId, status);
  }

  deleteMessagesAfter(sessionId: string, afterTimestamp: number): number {
    return this.sdkMessageRepo.deleteMessagesAfter(sessionId, afterTimestamp);
  }

  deleteMessagesAtAndAfter(sessionId: string, atTimestamp: number): number {
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

  saveHyperNeoActionMessage(sessionId: string, message: HyperNeoActionMessage): string {
    return this.sdkMessageRepo.saveHyperNeoActionMessage(sessionId, message);
  }

  updateHyperNeoActionMessage(rowId: string, updated: HyperNeoActionMessage): void {
    this.sdkMessageRepo.updateHyperNeoActionMessage(rowId, updated);
  }

  updateHyperNeoActionMessageByUuid(
    sessionId: string,
    messageUuid: string,
    updated: HyperNeoActionMessage
  ): void {
    this.sdkMessageRepo.updateHyperNeoActionMessageByUuid(sessionId, messageUuid, updated);
  }

  getGlobalToolsConfig(): GlobalToolsConfig {
    return this.settingsRepo.getGlobalToolsConfig();
  }

  saveGlobalToolsConfig(config: GlobalToolsConfig): void {
    this.settingsRepo.saveGlobalToolsConfig(config);
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

  createGitHubMapping(params: {
    roomId: string;
    repositories: Array<{
      owner: string;
      repo: string;
      labels?: string[];
      issueNumbers?: number[];
    }>;
    priority?: number;
  }): RoomGitHubMapping {
    return this.githubMappingRepo.createMapping(params);
  }

  getGitHubMapping(id: string): RoomGitHubMapping | null {
    return this.githubMappingRepo.getMapping(id);
  }

  getGitHubMappingByRoomId(roomId: string): RoomGitHubMapping | null {
    return this.githubMappingRepo.getMappingByRoomId(roomId);
  }

  listGitHubMappings(): RoomGitHubMapping[] {
    return this.githubMappingRepo.listMappings();
  }

  listGitHubMappingsForRepository(owner: string, repo: string): RoomGitHubMapping[] {
    return this.githubMappingRepo.listMappingsForRepository(owner, repo);
  }

  updateGitHubMapping(
    id: string,
    params: {
      repositories?: Array<{
        owner: string;
        repo: string;
        labels?: string[];
        issueNumbers?: number[];
      }>;
      priority?: number;
    }
  ): RoomGitHubMapping | null {
    return this.githubMappingRepo.updateMapping(id, params);
  }

  deleteGitHubMapping(id: string): void {
    this.githubMappingRepo.deleteMapping(id);
  }

  deleteGitHubMappingByRoomId(roomId: string): void {
    this.githubMappingRepo.deleteMappingByRoomId(roomId);
  }

  createInboxItem(params: CreateInboxItemParams): InboxItem {
    return this.inboxItemRepo.createItem(params);
  }

  getInboxItem(id: string): InboxItem | null {
    return this.inboxItemRepo.getItem(id);
  }

  listInboxItems(filter?: InboxItemFilter): InboxItem[] {
    return this.inboxItemRepo.listItems(filter);
  }

  listPendingInboxItems(limit?: number): InboxItem[] {
    return this.inboxItemRepo.listPendingItems(limit);
  }

  updateInboxItemStatus(
    id: string,
    status: 'pending' | 'routed' | 'dismissed' | 'blocked',
    routedToRoomId?: string
  ): InboxItem | null {
    return this.inboxItemRepo.updateItemStatus(id, status, routedToRoomId);
  }

  dismissInboxItem(id: string): InboxItem | null {
    return this.inboxItemRepo.dismissItem(id);
  }

  routeInboxItem(id: string, roomId: string): InboxItem | null {
    return this.inboxItemRepo.routeItem(id, roomId);
  }

  blockInboxItem(id: string): InboxItem | null {
    return this.inboxItemRepo.blockItem(id);
  }

  deleteInboxItem(id: string): void {
    this.inboxItemRepo.deleteItem(id);
  }

  deleteInboxItemsForRepository(repository: string): number {
    return this.inboxItemRepo.deleteItemsForRepository(repository);
  }

  countInboxItemsByStatus(status: 'pending' | 'routed' | 'dismissed' | 'blocked'): number {
    return this.inboxItemRepo.countByStatus(status);
  }

  createGoal(params: CreateGoalParams): RoomGoal {
    return this.goalRepo.createGoal(params);
  }

  getGoal(id: string): RoomGoal | null {
    return this.goalRepo.getGoal(id);
  }

  getGoalByShortId(roomId: string, shortId: string): RoomGoal | null {
    return this.goalRepo.getGoalByShortId(roomId, shortId);
  }

  listGoals(roomId: string, status?: GoalStatus): RoomGoal[] {
    return this.goalRepo.listGoals(roomId, status);
  }

  updateGoal(id: string, params: UpdateGoalParams): RoomGoal | null {
    return this.goalRepo.updateGoal(id, params);
  }

  deleteGoal(id: string): boolean {
    return this.goalRepo.deleteGoal(id);
  }

  linkTaskToGoal(goalId: string, taskId: string): RoomGoal | null {
    return this.goalRepo.linkTaskToGoal(goalId, taskId);
  }

  unlinkTaskFromGoal(goalId: string, taskId: string): RoomGoal | null {
    return this.goalRepo.unlinkTaskFromGoal(goalId, taskId);
  }

  getGoalsForTask(taskId: string): RoomGoal[] {
    return this.goalRepo.getGoalsForTask(taskId);
  }

  getActiveGoalCount(roomId: string): number {
    return this.goalRepo.getActiveGoalCount(roomId);
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

  getGoalRepo(): GoalRepository {
    return this.goalRepo;
  }

  getTaskRepo(): TaskRepository {
    return this.taskRepo;
  }

  getSpaceTaskRepo(): SpaceTaskRepository {
    return this.spaceTaskRepo;
  }

  getNodeExecutionRepo(): NodeExecutionRepository {
    return this.nodeExecutionRepo;
  }

  getDatabasePath(): string {
    return this.core.getDbPath();
  }

  getJobQueueRepo(): JobQueueRepository {
    return this.jobQueueRepo;
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

  close(): void {
    if (this.messageSearchIndexTimer) {
      clearInterval(this.messageSearchIndexTimer);
      this.messageSearchIndexTimer = null;
    }
    this.core.close();
  }
}
