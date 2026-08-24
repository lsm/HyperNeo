import type { Provider, Session, WorktreeMetadata, MessageHub } from '@hyperneo/shared';
import { TITLE_GENERATION_PROMPT } from '@hyperneo/prompts';
import { generateUUID } from '@hyperneo/shared';
import type { Database } from '../../storage/database.ts';
import type { DaemonInternalEventMap, InternalEventBus } from '../internal-event-bus.ts';
import type { WorktreeManager } from '../worktree-manager.ts';
import { Logger } from '../logger.ts';
import type { SessionCache, AgentSessionFactory } from './session-cache.ts';
import type { ToolsConfigManager } from './tools-config.ts';
import { getProviderService, mergeProviderEnvVars } from '../provider-service.ts';
import { archiveSDKSessionFiles, deleteSDKSessionFiles } from '../sdk-session-file-manager.ts';
import { resolveSDKCliPath, isRunningUnderBun } from '../agent/sdk-cli-resolver.js';
import { withSdkTranscriptRetention } from '../agent/sdk-transcript-retention.ts';
import { KimiProvider } from '../providers/kimi-provider.js';
import { inferProviderForModel } from '../providers/registry.ts';
import { findInModels } from '../model-service.ts';

export function buildTitleGenerationPrompt(messageText: string): string {
  return `${TITLE_GENERATION_PROMPT}\n${messageText.slice(0, 2000)}`;
}

export type ArchiveResourcesTrigger = 'ui_session_archive' | 'ui_task_archive';
export type DeleteResourcesTrigger = 'ui_session_delete';

type SdkQueryFunction = typeof import('@anthropic-ai/claude-agent-sdk').query;
type TitleGenerationProviderService = Pick<
  ReturnType<typeof getProviderService>,
  | 'getDefaultProvider'
  | 'isProviderAvailable'
  | 'getTitleGenerationConfig'
  | 'getTitleGenerationModels'
  | 'applyEnvVarsToProcessForProvider'
  | 'getEnvVarsForModel'
  | 'restoreEnvVars'
>;

function isAssistantMessageWithContent(
  message: unknown
): message is { type: 'assistant'; message: { content: Array<{ type: string; text?: string }> } } {
  if (!message || typeof message !== 'object') return false;
  const candidate = message as { type?: unknown; message?: { content?: unknown } };
  return candidate.type === 'assistant' && Array.isArray(candidate.message?.content);
}

export interface SessionLifecycleConfig {
  defaultModel: string;
  maxTokens: number;
  temperature: number;
  disableWorktrees?: boolean;
  titleGenerationQueryForTesting?: SdkQueryFunction;
  titleGenerationProviderServiceForTesting?: TitleGenerationProviderService;
}

export interface CreateSessionParams {
  workspacePath?: string | null;
  initialTools?: string[];
  config?: Partial<Session['config']>;
  worktreeBaseBranch?: string;
  worktreeMode?: 'worktree' | 'direct';
  title?: string;
  sessionId?: string;
  lobbyId?: string;
  spaceId?: string;
  createdBy?: 'human';
  sessionType?: 'worker' | 'lobby' | 'space_chat';
  pairedSessionId?: string;
  parentSessionId?: string;
  currentTaskId?: string;
}

export class SessionLifecycle {
  private logger: Logger;

  constructor(
    private db: Database,
    private worktreeManager: WorktreeManager,
    private sessionCache: SessionCache,
    private internalEventBus: InternalEventBus<DaemonInternalEventMap>,
    private messageHub: MessageHub,
    private config: SessionLifecycleConfig,
    private toolsConfigManager: ToolsConfigManager,
    private createAgentSession: AgentSessionFactory
  ) {
    this.logger = new Logger('SessionLifecycle');
  }

  async create(params: CreateSessionParams): Promise<string> {
    const sessionId = params.sessionId || generateUUID();
    const sessionType = params.sessionType ?? 'worker';

    const WORKSPACE_REQUIRING_SESSION_TYPES = ['space_chat'] as const;
    const providedWorkspacePath = params.workspacePath?.trim();
    const baseWorkspacePath = providedWorkspacePath ? providedWorkspacePath : undefined;
    if (
      (WORKSPACE_REQUIRING_SESSION_TYPES as readonly string[]).includes(sessionType) &&
      baseWorkspacePath === undefined
    ) {
      throw new Error(`Session type '${sessionType}' requires explicit workspacePath`);
    }

    const requestedWorktreeMode = params.worktreeMode as unknown;
    if (
      requestedWorktreeMode !== undefined &&
      requestedWorktreeMode !== 'worktree' &&
      requestedWorktreeMode !== 'direct'
    ) {
      throw new Error(
        `Invalid worktreeMode: ${String(requestedWorktreeMode)}. Must be 'worktree' or 'direct'`
      );
    }
    const validWorktreeMode = requestedWorktreeMode as 'worktree' | 'direct' | undefined;

    let gitSupport: Awaited<ReturnType<typeof this.worktreeManager.detectGitSupport>> | undefined;
    let isGitRepo = false;
    if (baseWorkspacePath !== undefined) {
      gitSupport = await this.worktreeManager.detectGitSupport(baseWorkspacePath);
      isGitRepo = gitSupport.isGitRepo;
    }

    const supportsWorktreeChoice = sessionType === 'worker';

    const explicitWorktreeMode =
      supportsWorktreeChoice && baseWorkspacePath !== undefined && !this.config.disableWorktrees
        ? validWorktreeMode
        : undefined;

    const shouldShowChoice =
      supportsWorktreeChoice && isGitRepo && !this.config.disableWorktrees && !explicitWorktreeMode;

    const shouldCreateWorktree =
      baseWorkspacePath !== undefined &&
      supportsWorktreeChoice &&
      !this.config.disableWorktrees &&
      (!isGitRepo || explicitWorktreeMode === 'worktree');

    const globalSettings = this.db.getGlobalSettings();

    const requestedModel = params.config?.model || globalSettings.model;
    const { id: modelId, provider: resolvedProvider } = await this.getValidatedModelId(
      requestedModel,
      params.config?.provider
    );

    const providedTitle = params.title?.trim();
    const shouldSkipAutoTitle = Boolean(providedTitle);

    let worktreeMetadata: WorktreeMetadata | undefined;
    let sessionWorkspacePath: string | null = baseWorkspacePath ?? null;
    const initialBranchName = shouldSkipAutoTitle
      ? generateBranchName(providedTitle!, sessionId)
      : `session/${sessionId}`;

    if (shouldCreateWorktree) {
      try {
        const result = await this.createWorktreeInternal(
          sessionId,
          baseWorkspacePath,
          initialBranchName,
          params.worktreeBaseBranch || 'HEAD'
        );

        if (result) {
          worktreeMetadata = result;
          sessionWorkspacePath = result.worktreePath;
        }
      } catch (error) {
        this.logger.error(
          '[SessionLifecycle] Failed to create worktree during session creation:',
          error
        );
      }
      if (explicitWorktreeMode === 'worktree' && !worktreeMetadata) {
        throw new Error('Failed to create worktree for the selected project');
      }
    }

    const sessionStatus: Session['status'] = shouldShowChoice
      ? 'pending_worktree_choice'
      : 'active';

    let currentBranch: string | undefined = worktreeMetadata?.branch;
    if (!currentBranch && isGitRepo && gitSupport?.gitRoot) {
      try {
        const branch = await this.worktreeManager.getCurrentBranch(gitSupport!.gitRoot!);
        currentBranch = branch ?? undefined;
      } catch (error) {
        this.logger.debug('[SessionLifecycle] Failed to get current branch:', error);
      }
    }

    const session: Session = {
      id: sessionId,
      title: providedTitle || 'New Session',
      workspacePath: sessionWorkspacePath,
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      status: sessionStatus,
      type: sessionType,
      config: {
        model: modelId,
        maxTokens: params.config?.maxTokens || this.config.maxTokens,
        temperature: params.config?.temperature || this.config.temperature,
        autoScroll: params.config?.autoScroll ?? globalSettings.autoScroll,
        thinkingLevel: params.config?.thinkingLevel ?? globalSettings.thinkingLevel,
        coordinatorMode: params.config?.coordinatorMode ?? globalSettings.coordinatorMode,
        permissionMode: params.config?.permissionMode,
        provider: (params.config?.provider ?? resolvedProvider) as Provider,
        tools: params.config?.tools,
        sandbox: params.config?.sandbox ?? globalSettings.sandbox,
        mcpServers: params.config?.mcpServers,
        settingSources: params.config?.settingSources ?? globalSettings.settingSources,
      },
      metadata: {
        messageCount: 0,
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalCost: 0,
        toolCallCount: 0,
        titleGenerated: shouldSkipAutoTitle,
        workspaceInitialized: sessionWorkspacePath !== null,
        worktreeChoice: shouldShowChoice
          ? {
              status: 'pending',
              createdAt: new Date().toISOString(),
            }
          : explicitWorktreeMode === 'direct' ||
              (explicitWorktreeMode === 'worktree' && worktreeMetadata)
            ? {
                status: 'completed',
                choice: explicitWorktreeMode,
                createdAt: new Date().toISOString(),
                completedAt: new Date().toISOString(),
              }
            : undefined,
        ...(params.sessionType && { sessionType: params.sessionType }),
        ...(params.pairedSessionId && { pairedSessionId: params.pairedSessionId }),
        ...(params.parentSessionId && { parentSessionId: params.parentSessionId }),
        ...(params.currentTaskId && { currentTaskId: params.currentTaskId }),
      },
      worktree: worktreeMetadata,
      gitBranch: currentBranch ?? undefined,
      context:
        params.lobbyId || params.spaceId
          ? {
              ...(params.lobbyId && { lobbyId: params.lobbyId }),
              ...(params.spaceId && { spaceId: params.spaceId }),
            }
          : undefined,
    };

    this.db.createSession(session);

    const agentSession = this.createAgentSession(session);
    this.sessionCache.set(sessionId, agentSession);

    await this.internalEventBus.publish('session.created', { sessionId, session });

    return sessionId;
  }

  private async createWorktreeInternal(
    sessionId: string,
    baseWorkspacePath: string,
    branchName: string,
    baseBranch?: string
  ): Promise<WorktreeMetadata | undefined> {
    try {
      const result = await this.worktreeManager.createWorktree({
        sessionId,
        repoPath: baseWorkspacePath,
        branchName,
        baseBranch,
      });

      if (result) {
        this.logger.info(
          `[SessionLifecycle] Created worktree at ${result.worktreePath} with branch ${result.branch}`
        );
      }

      return result || undefined;
    } catch (error) {
      this.logger.error(
        `[SessionLifecycle] Failed to create worktree for session ${sessionId}:`,
        error
      );
      return undefined;
    }
  }

  async completeWorktreeChoice(sessionId: string, choice: 'worktree' | 'direct'): Promise<Session> {
    const agentSession = this.sessionCache.get(sessionId);
    if (!agentSession) {
      throw new Error(`Session ${sessionId} not found`);
    }

    const session = agentSession.getSessionData();
    const sessionType = session.type ?? 'worker';

    if (session.status !== 'pending_worktree_choice') {
      throw new Error(
        `Session ${sessionId} is not pending worktree choice (current status: ${session.status})`
      );
    }

    let worktreeMetadata: WorktreeMetadata | undefined;
    const baseWorkspacePath = session.workspacePath;
    const effectiveChoice: 'worktree' | 'direct' = sessionType === 'worker' ? choice : 'direct';

    if (effectiveChoice === 'worktree') {
      if (!baseWorkspacePath) {
        throw new Error(`Session ${sessionId} has no workspacePath for worktree creation`);
      }
      const branchName = `session/${sessionId}`;

      worktreeMetadata = await this.createWorktreeInternal(
        sessionId,
        baseWorkspacePath,
        branchName,
        'HEAD'
      );

      this.logger.info(
        `[SessionLifecycle] Worktree choice completed: created worktree for session ${sessionId}`
      );
    } else {
      this.logger.info(
        `[SessionLifecycle] Worktree choice completed: direct mode for session ${sessionId}`
      );
    }

    let currentBranch: string | undefined = worktreeMetadata?.branch;
    if (!currentBranch && effectiveChoice === 'direct' && baseWorkspacePath) {
      try {
        const branch = await this.worktreeManager.getCurrentBranch(baseWorkspacePath);
        currentBranch = branch ?? undefined;
      } catch (error) {
        this.logger.debug('[SessionLifecycle] Failed to get current branch:', error);
      }
    }

    const latestSession = agentSession.getSessionData();

    const updatedSession: Session = {
      ...session,
      status: 'active',
      worktree: worktreeMetadata,
      gitBranch: currentBranch ?? undefined,
      metadata: {
        ...latestSession.metadata,
        worktreeChoice: {
          status: 'completed',
          choice: effectiveChoice,
          createdAt: session.metadata.worktreeChoice?.createdAt,
          completedAt: new Date().toISOString(),
        },
      },
    };

    this.db.updateSession(sessionId, updatedSession);

    agentSession.updateMetadata(updatedSession);

    await this.internalEventBus.publish('session.updated', {
      sessionId,
      session: updatedSession,
    });

    return updatedSession;
  }

  async setWorkspace(
    sessionId: string,
    workspacePath: string,
    worktreeMode: 'worktree' | 'direct'
  ): Promise<Session> {
    const agentSession = this.sessionCache.get(sessionId);
    if (!agentSession) {
      throw new Error(`Session ${sessionId} not found`);
    }

    const session = agentSession.getSessionData();

    if (session.type !== 'worker') {
      throw new Error(`Session ${sessionId} is not a worker session`);
    }

    if (session.status !== 'active') {
      throw new Error(
        `Session ${sessionId} status is ${session.status}, must be active to set workspace`
      );
    }

    if (session.workspacePath !== null) {
      throw new Error(`Session ${sessionId} already has a workspace`);
    }

    const normalizedPath = workspacePath.trim();
    if (!normalizedPath) {
      throw new Error('Workspace path cannot be empty');
    }

    let worktreeMetadata: WorktreeMetadata | undefined;
    let currentBranch: string | undefined;

    if (worktreeMode === 'worktree' && !this.config.disableWorktrees) {
      const branchName = `session/${sessionId}`;
      worktreeMetadata = await this.createWorktreeInternal(
        sessionId,
        normalizedPath,
        branchName,
        'HEAD'
      );
      if (!worktreeMetadata) {
        throw new Error(`Failed to create worktree for session ${sessionId}`);
      }
    } else if (worktreeMode === 'direct') {
      try {
        const gitSupport = await this.worktreeManager.detectGitSupport(normalizedPath);
        if (gitSupport.isGitRepo && gitSupport.gitRoot) {
          const branch = await this.worktreeManager.getCurrentBranch(gitSupport.gitRoot);
          currentBranch = branch ?? undefined;
        }
      } catch (error) {
        this.logger.debug('[SessionLifecycle] Failed to detect git/branch for direct mode:', error);
      }
    }

    const latestSession = agentSession.getSessionData();

    const updatedSession: Session = {
      ...latestSession,
      workspacePath: normalizedPath,
      worktree: worktreeMetadata,
      gitBranch: currentBranch ?? worktreeMetadata?.branch,
      metadata: {
        ...latestSession.metadata,
        workspaceInitialized: true,
        worktreeChoice: {
          status: 'completed',
          choice: worktreeMode,
          createdAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
        },
      },
    };

    this.db.updateSession(sessionId, updatedSession);

    agentSession.updateMetadata(updatedSession);

    await this.internalEventBus.publish('session.updated', {
      sessionId,
      session: updatedSession,
    });

    return updatedSession;
  }

  async update(sessionId: string, updates: Partial<Session>): Promise<void> {
    this.db.updateSession(sessionId, updates);

    const agentSession = this.sessionCache.has(sessionId) ? this.sessionCache.get(sessionId) : null;
    if (agentSession) {
      agentSession.updateMetadata(updates);
    }

    await this.internalEventBus
      .publish('session.updated', {
        sessionId,
        source: 'update',
        session: updates,
      })
      .catch((err: unknown) => {
        this.logger.warn(
          `session.updated publication failed after commit for ${sessionId}: ${err instanceof Error ? err.message : String(err)}`
        );
      });
  }

  async archiveResources(sessionId: string, trigger: ArchiveResourcesTrigger): Promise<void> {
    const agentSession = this.sessionCache.has(sessionId) ? this.sessionCache.get(sessionId) : null;
    const session = this.db.getSession(sessionId);
    if (!session) {
      this.logger.warn(`[SessionLifecycle] archiveResources: session ${sessionId} not found`);
      return;
    }

    const completedPhases: string[] = [];
    const archivedAt = new Date().toISOString();

    await this.update(sessionId, { status: 'archived', archivedAt });
    completedPhases.push('db-mark-archived');

    try {
      const failedDbIds: string[] = [];
      const messageUuids =
        this.db.getJobQueueRepo?.()?.cancelForSessionWithMessages(sessionId) ?? [];
      const sdkRepo = this.db.getSDKMessageRepo?.();
      for (const messageUuid of messageUuids) {
        const failedDbId = sdkRepo?.markDeliveryFailedByUuid(sessionId, messageUuid) ?? null;
        if (failedDbId) failedDbIds.push(failedDbId);
      }
      if (failedDbIds.length > 0) {
        await this.internalEventBus
          .publish('messages.statusChanged', {
            sessionId,
            messageIds: failedDbIds,
            status: 'failed',
          })
          .catch(() => {});
      }
      completedPhases.push('delivery-cancel');
    } catch (error) {
      this.logger.error(`[SessionLifecycle] archiveResources: delivery cancel failed:`, error);
    }

    if (agentSession) {
      try {
        await agentSession.cleanup();
        completedPhases.push('agent-cleanup');
      } catch (error) {
        this.logger.error(
          `[SessionLifecycle] archiveResources: AgentSession cleanup failed:`,
          error
        );
      }
    }

    let archiveMetadata:
      | {
          sdkArchivePath: string;
          sdkArchivedAt: string;
          sdkArchivedFileCount: number;
          sdkArchivedSize: number;
        }
      | undefined;
    try {
      const sdkWorkspacePath = session.worktree
        ? session.worktree.worktreePath
        : session.workspacePath;
      if (sdkWorkspacePath) {
        const result = archiveSDKSessionFiles(
          sdkWorkspacePath,
          session.sdkSessionId ?? null,
          sessionId
        );
        if (result.archivePath) {
          archiveMetadata = {
            sdkArchivePath: result.archivePath,
            sdkArchivedAt: new Date().toISOString(),
            sdkArchivedFileCount: result.archivedFiles.length,
            sdkArchivedSize: result.totalSize,
          };
        }
        completedPhases.push('sdk-files-archive');
      } else {
        completedPhases.push('sdk-files-archive-skipped');
      }
    } catch (error) {
      this.logger.error(`[SessionLifecycle] archiveResources: SDK file archive failed:`, error);
    }

    if (session.worktree) {
      try {
        await this.worktreeManager.removeWorktree(session.worktree, true);
        completedPhases.push('worktree-remove');
      } catch (error) {
        this.logger.error(`[SessionLifecycle] archiveResources: worktree removal failed:`, error);
      }
    }

    try {
      const archivedWorktreeMetadata = session.worktree
        ? {
            archivedWorktree: {
              mainRepoPath: session.worktree.mainRepoPath,
              worktreePath: session.worktree.worktreePath,
              branch: session.worktree.branch,
            },
          }
        : {};
      const metadataUpdate = {
        ...archiveMetadata,
        ...archivedWorktreeMetadata,
      };

      await this.update(sessionId, {
        status: 'archived',
        archivedAt,
        ...(session.worktree ? { worktree: undefined } : {}),
        ...(Object.keys(metadataUpdate).length > 0
          ? {
              metadata: {
                ...session.metadata,
                ...metadataUpdate,
              },
            }
          : {}),
      });
      completedPhases.push('db-finalize-archive');
    } catch (error) {
      this.logger.error(`[SessionLifecycle] archiveResources: status update failed:`, error);
      throw error;
    }

    this.logger.info(
      `[SessionLifecycle] archiveResources: session ${sessionId} archived (trigger=${trigger}, phases=${completedPhases.join(',')})`
    );
  }

  async deleteResources(sessionId: string, trigger: DeleteResourcesTrigger): Promise<void> {
    const agentSession = this.sessionCache.has(sessionId) ? this.sessionCache.get(sessionId) : null;
    const session = this.db.getSession(sessionId);

    const completedPhases: string[] = [];

    try {
      if (session && session.status !== 'archived') {
        await this.update(sessionId, {
          status: 'archived',
          archivedAt: new Date().toISOString(),
        });
        completedPhases.push('db-mark-archived');
      }
      try {
        const failedDbIds: string[] = [];
        const messageUuids =
          this.db.getJobQueueRepo?.()?.cancelForSessionWithMessages(sessionId) ?? [];
        const sdkRepo = this.db.getSDKMessageRepo?.();
        for (const messageUuid of messageUuids) {
          const failedDbId = sdkRepo?.markDeliveryFailedByUuid(sessionId, messageUuid) ?? null;
          if (failedDbId) failedDbIds.push(failedDbId);
        }
        if (failedDbIds.length > 0) {
          await this.internalEventBus
            .publish('messages.statusChanged', {
              sessionId,
              messageIds: failedDbIds,
              status: 'failed',
            })
            .catch(() => {});
        }
        completedPhases.push('delivery-cancel');
      } catch (error) {
        this.logger.error(`[SessionLifecycle] deleteResources: delivery cancel failed:`, error);
      }

      if (agentSession) {
        try {
          await agentSession.cleanup();
          completedPhases.push('agent-cleanup');
        } catch (error) {
          this.logger.error(
            `[SessionLifecycle] deleteResources: AgentSession cleanup failed:`,
            error
          );
        }
      }

      if (session) {
        try {
          const sdkWorkspacePath = session.worktree
            ? session.worktree.worktreePath
            : session.workspacePath;
          if (!sdkWorkspacePath) {
            completedPhases.push('sdk-files-delete-skipped');
          } else {
            const deleteResult = deleteSDKSessionFiles(
              sdkWorkspacePath,
              session.sdkSessionId ?? null,
              sessionId
            );
            completedPhases.push(
              deleteResult.success ? 'sdk-files-delete' : 'sdk-files-delete-partial'
            );
          }
        } catch (error) {
          this.logger.error(`[SessionLifecycle] deleteResources: SDK file deletion failed:`, error);
        }
      }

      if (session?.worktree) {
        try {
          await this.worktreeManager.removeWorktree(session.worktree, true);
          const stillExists = await this.worktreeManager.verifyWorktree(session.worktree);
          completedPhases.push(stillExists ? 'worktree-cleanup-partial' : 'worktree-cleanup');
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          this.logger.error(
            `[SessionLifecycle] deleteResources: worktree removal failed (global teardown will handle): ${errorMsg}`
          );
        }
      }

      try {
        this.db.deleteSession(sessionId);
        completedPhases.push('db-delete');
      } catch (error) {
        this.logger.error(`[SessionLifecycle] deleteResources: Database deletion failed:`, error);
        throw error;
      }

      try {
        this.sessionCache.remove(sessionId);
        completedPhases.push('cache-remove');
      } catch (error) {
        this.logger.error(`[SessionLifecycle] deleteResources: Cache removal failed:`, error);
      }

      try {
        this.messageHub.event(
          'session.deleted',
          { sessionId, reason: 'deleted' },
          { channel: 'global' }
        );
        await this.internalEventBus.publish('session.deleted', { sessionId });
        completedPhases.push('broadcast');
      } catch (error) {
        this.logger.error(`[SessionLifecycle] deleteResources: Failed to broadcast:`, error);
      }

      this.logger.info(
        `[SessionLifecycle] deleteResources: session ${sessionId} deleted (trigger=${trigger}, phases=${completedPhases.join(',')})`
      );
    } catch (error) {
      this.logger.error(
        `[SessionLifecycle] deleteResources FAILED (trigger=${trigger}, phases=${completedPhases.join(',')}):`,
        error
      );
      throw error;
    }
  }

  getFromDB(sessionId: string): Session | null {
    return this.db.getSession(sessionId);
  }

  getAgentSession(sessionId: string): import('../agent/agent-session.ts').AgentSession | null {
    return this.sessionCache.has(sessionId) ? this.sessionCache.get(sessionId) : null;
  }

  async getAgentSessionAsync(
    sessionId: string
  ): Promise<import('../agent/agent-session.ts').AgentSession | null> {
    return this.sessionCache.getAsync(sessionId);
  }

  async markOutputRemoved(sessionId: string, messageUuid: string): Promise<void> {
    const session = this.db.getSession(sessionId);
    if (!session) {
      throw new Error('Session not found');
    }

    const removedOutputs = session.metadata.removedOutputs || [];
    if (!removedOutputs.includes(messageUuid)) {
      removedOutputs.push(messageUuid);
    }

    await this.update(sessionId, {
      metadata: {
        ...session.metadata,
        removedOutputs,
      },
    });
  }

  async generateTitleAndRenameBranch(
    sessionId: string,
    userMessageText: string
  ): Promise<{ title: string; isFallback: boolean }> {
    const agentSession = this.sessionCache.has(sessionId) ? this.sessionCache.get(sessionId) : null;
    if (!agentSession) {
      throw new Error(`Session ${sessionId} not found`);
    }

    const session = agentSession.getSessionData();

    if (session.metadata.titleSetBy === 'user') {
      return { title: session.title, isFallback: false };
    }

    if (session.metadata.titleGenerated) {
      return { title: session.title, isFallback: false };
    }

    try {
      const { title, isFallback } = await this.generateTitleFromMessage(
        userMessageText,
        session.config.model,
        session.config.provider as string | undefined
      );

      const latest = agentSession.getSessionData();
      if (latest.metadata.titleSetBy === 'user') {
        return { title: latest.title, isFallback: false };
      }

      let newBranchName = session.worktree?.branch;
      if (session.worktree) {
        const newBranch = generateBranchName(title, sessionId);
        const oldBranch = session.worktree.branch;

        if (oldBranch !== newBranch) {
          const renamed = await this.worktreeManager.renameBranch(
            session.worktree.mainRepoPath,
            oldBranch,
            newBranch
          );

          if (renamed) {
            newBranchName = newBranch;
          }
        }
      }

      const currentSession = agentSession.getSessionData();
      const userRenamed = currentSession.metadata.titleSetBy === 'user';
      const finalTitle = userRenamed ? currentSession.title : title;
      const updatedSession: Session = {
        ...currentSession,
        title: finalTitle,
        worktree: currentSession.worktree
          ? {
              ...currentSession.worktree,
              branch: newBranchName ?? currentSession.worktree.branch,
            }
          : undefined,
        gitBranch: newBranchName ?? currentSession.gitBranch,
        metadata: {
          ...currentSession.metadata,
          titleGenerated: userRenamed ? currentSession.metadata.titleGenerated : !isFallback,
        },
      };

      this.db.updateSession(sessionId, updatedSession);

      agentSession.updateMetadata(updatedSession);

      await this.internalEventBus.publish('session.updated', {
        sessionId,
        source: 'title-generated',
        session: updatedSession,
      });

      return { title: finalTitle, isFallback: userRenamed ? false : isFallback };
    } catch (error) {
      const latest = agentSession.getSessionData();
      if (latest.metadata.titleSetBy === 'user') {
        return { title: latest.title, isFallback: false };
      }

      this.logger.error('[SessionLifecycle] Failed to generate title:', error);

      const fallbackTitle = userMessageText.substring(0, 50).trim() || 'New Session';
      const fallbackSession: Session = {
        ...session,
        title: fallbackTitle,
        metadata: {
          ...session.metadata,
          titleGenerated: false,
        },
      };

      this.db.updateSession(sessionId, fallbackSession);
      agentSession.updateMetadata(fallbackSession);

      await this.internalEventBus.publish('session.updated', {
        sessionId,
        source: 'title-generated',
        session: fallbackSession,
      });

      return { title: fallbackTitle, isFallback: true };
    }
  }

  private async generateTitleFromMessage(
    messageText: string,
    sessionModel?: string,
    sessionProviderId?: string
  ): Promise<{ title: string; isFallback: boolean }> {
    const providerService =
      this.config.titleGenerationProviderServiceForTesting ?? getProviderService();

    let provider: string;
    if (sessionProviderId) {
      provider = sessionProviderId;
    } else {
      provider = await providerService.getDefaultProvider();
    }

    const available =
      this.config.titleGenerationQueryForTesting !== undefined ||
      (await providerService.isProviderAvailable(provider));
    if (!available) {
      this.logger.warn(
        `[SessionLifecycle] Provider ${provider} not available, using fallback title`
      );
      return {
        title: messageText.substring(0, 50).trim() || 'New Session',
        isFallback: true,
      };
    }

    let modelId: string;
    if (sessionModel) {
      modelId = sessionModel;
    } else {
      const config = await providerService.getTitleGenerationConfig(provider);
      modelId = config.modelId;
    }

    try {
      const title = await this.generateTitleWithSdk(provider, modelId, messageText);
      return { title, isFallback: false };
    } catch (error) {
      this.logger.error('[SessionLifecycle] SDK title generation failed:', error);
      return {
        title: messageText.substring(0, 50).trim() || 'New Session',
        isFallback: true,
      };
    }
  }

  private async generateTitleWithSdk(
    provider: string,
    modelId: string,
    messageText: string
  ): Promise<string> {
    const query =
      this.config.titleGenerationQueryForTesting ??
      (await import('@anthropic-ai/claude-agent-sdk')).query;
    const providerService =
      this.config.titleGenerationProviderServiceForTesting ?? getProviderService();

    const titleModels = await providerService.getTitleGenerationModels(provider, modelId);

    const originalEnv = await providerService.applyEnvVarsToProcessForProvider(
      provider,
      titleModels.providerModelId
    );

    try {
      const prompt = buildTitleGenerationPrompt(messageText);

      const providerEnvVars = await providerService.getEnvVarsForModel(
        titleModels.providerModelId,
        provider
      );

      const cliPath = resolveSDKCliPath();

      const mergedEnv = buildSdkQueryEnv(providerEnvVars);

      const agentQuery = query({
        prompt,
        options: {
          model: titleModels.sdkModelId,
          maxTurns: 1,
          permissionMode: 'acceptEdits',
          allowDangerouslySkipPermissions: false,
          mcpServers: {},
          settingSources: [],
          tools: [],
          pathToClaudeCodeExecutable: cliPath,
          executable: isRunningUnderBun() ? 'bun' : undefined,
          settings: withSdkTranscriptRetention(),
          env: mergedEnv,
          thinking:
            provider === 'kimi'
              ? KimiProvider.resolveKimiTitleThinkingConfig(titleModels.providerModelId)
              : { type: 'disabled' },
        },
      });

      let title = '';

      for await (const message of agentQuery) {
        if (isAssistantMessageWithContent(message)) {
          const textBlocks = message.message.content.filter(
            (b: { type: string }) => b.type === 'text'
          ) as Array<{ text?: string }>;
          title = textBlocks
            .map((b) => b.text ?? '')
            .join(' ')
            .trim();

          if (title) {
            break;
          }
        }
      }

      if (!title) {
        throw new Error('No text content in SDK response');
      }

      title = title.replace(/\*\*(.+?)\*\*/g, '$1').replace(/\*(.+?)\*/g, '$1');

      while (
        (title.startsWith('"') && title.endsWith('"')) ||
        (title.startsWith("'") && title.endsWith("'"))
      ) {
        title = title.slice(1, -1).trim();
      }

      title = title.replace(/`/g, '');

      return title;
    } finally {
      providerService.restoreEnvVars(originalEnv);
    }
  }

  private async getValidatedModelId(
    requestedModel?: string,
    explicitProvider?: string
  ): Promise<{ id: string; provider?: string }> {
    if (requestedModel && explicitProvider) {
      const { isCuratedOutModel } = await import('../model-service.ts');
      if (isCuratedOutModel(requestedModel, explicitProvider)) {
        throw new Error(
          `Model '${requestedModel}' is curated out for provider '${explicitProvider}' and cannot be used for a new session`
        );
      }
    }

    try {
      const { getAvailableModels } = await import('../model-service.ts');
      const availableModels = getAvailableModels('global');

      if (availableModels.length > 0) {
        if (requestedModel) {
          const found = findInModels(availableModels, requestedModel);
          if (found) {
            if (explicitProvider && found.provider !== explicitProvider) {
            } else {
              const suffix = /\[1m\]$/i;
              if (
                requestedModel &&
                suffix.test(requestedModel.trim()) &&
                !suffix.test(found.id) &&
                KimiProvider.isKimiK3OneMModel(found.id)
              ) {
                return { id: `${found.id}[1m]`, provider: found.provider };
              }

              return { id: found.id, provider: found.provider };
            }
          }

          if (explicitProvider) {
            return { id: requestedModel };
          }
        }

        const configuredDefault = this.config.defaultModel;
        const defaultByConfig = findInModels(availableModels, configuredDefault);

        if (defaultByConfig) {
          return { id: defaultByConfig.id, provider: defaultByConfig.provider };
        }

        const defaultModel =
          availableModels.find((m) => m.family === 'sonnet') || availableModels[0];

        if (defaultModel) {
          return { id: defaultModel.id, provider: defaultModel.provider };
        }
      }
    } catch (error) {
      this.logger.error('[SessionLifecycle] Error getting models:', error);
    }

    const fallbackModel = requestedModel || this.config.defaultModel;
    if (requestedModel && fallbackModel === requestedModel) {
      const providerId = explicitProvider ?? inferProviderForModel(requestedModel);
      const { isCuratedOutModel } = await import('../model-service.ts');
      if (isCuratedOutModel(requestedModel, providerId)) {
        throw new Error(
          `Model '${requestedModel}' is curated out for provider '${providerId}' and cannot be used for a new session`
        );
      }
    }
    return { id: fallbackModel };
  }
}

export function generateBranchName(title: string, sessionId: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 50);

  const shortId = sessionId.substring(0, 8);

  return `session/${slug}-${shortId}`;
}

function buildSdkQueryEnv(providerEnvVars: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return mergeProviderEnvVars(providerEnvVars as Record<string, string>);
}
