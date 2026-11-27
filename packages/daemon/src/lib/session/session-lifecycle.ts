import { OperationMcpHttpServer } from '../operations/operation-http-server.ts';
import {
  cleanupOwnedWorktree,
  releaseRemovedWorkerFolders,
  worktreeUnverified,
} from '../drivers/work-placement.ts';
import { getWorktreeBaseDir } from '../worktree-path-utils.ts';
import { releaseWorkerSandbox } from '../drivers/worker-sandbox.ts';
import type { SessionToolProfile } from '@hyperneo/shared/types/session-tool-choice';
import { TITLE_GENERATION_PROMPT } from '@hyperneo/prompts';
import type {
  MessageHub,
  Provider,
  Session,
  SessionMetadata,
  UnarchiveSessionResponse,
  WorktreeMetadata,
} from '@hyperneo/shared';
import { generateUUID } from '@hyperneo/shared';
import type { Database } from '../../storage/database.ts';
import { sessionSdkIds, sessionSdkPath } from '../session/sdk-path.ts';
import type { SessionInputDraftSnapshot } from '../../storage/repositories/session-input-draft-write.ts';
import { runOneShotModel } from '../agent/one-shot-model.ts';
import type { DaemonInternalEventMap, InternalEventBus } from '../internal-event-bus.ts';
import { Logger } from '../logger.ts';
import { teardownSessionDeliveries } from '../mailbox/cancellation.ts';
import { getProviderService } from '../provider-service.ts';
import { resolveNewSessionModel, type NewSessionModelSettings } from './new-session-model.ts';
import {
  archiveSDKSessions,
  deleteSDKSessions,
  withUnarchivedSDKSessions,
} from '../sdk-session-file-manager.ts';
import type { WorktreeManager } from '../worktree-manager.ts';
import type { WorkArchived } from '../drivers/types.ts';
import { admitCreateSessionConfig } from './create-session-config.ts';
import {
  codexSessionRefusal,
  effectiveOxapConfig,
  engineForProvider,
  OxapSessionAdmissionError,
  selectSessionEngine,
  thinkingRefusal,
} from '../agent/session-engine.ts';
import { isOxapHarness } from '@hyperneo/shared/types/oxap-harnesses';
import { savedOxapAdapter } from '../oxap/oxap-hub-config.ts';
import { newSessionOxapRefusal, type OxapSettingsDeps } from '../oxap/oxap-settings.ts';
import type { AgentSessionFactory, SessionCache } from './session-cache.ts';
import {
  commitSessionInputDraft,
  type SessionInputDraftCommitOutcome,
} from './session-input-draft-commit.ts';
import type { ToolsConfigManager } from './tools-config.ts';

export function buildTitleGenerationPrompt(messageText: string): string {
  return `${TITLE_GENERATION_PROMPT}\n${messageText.slice(0, 2000)}`;
}

export type ArchiveResourcesTrigger = 'ui_session_archive' | 'ui_task_archive' | 'work_archive';
export type DeleteResourcesTrigger = 'ui_session_delete';
type WorktreeCleanup = NonNullable<WorkArchived['worktree']>;

type SdkQueryFunction = typeof import('@anthropic-ai/claude-agent-sdk').query;
type TitleGenerationProviderService = Pick<
  ReturnType<typeof getProviderService>,
  | 'getDefaultProvider'
  | 'isProviderAvailable'
  | 'getTitleGenerationConfig'
  | 'getTitleGenerationModels'
  | 'getIsolatedEnvForModel'
>;

export interface SessionLifecycleConfig {
  defaultModel: string;
  maxTokens: number;
  temperature: number;
  disableWorktrees?: boolean;
  oxapCredentials?: Pick<OxapSettingsDeps, 'key' | 'environment'>;
  titleGenerationQueryForTesting?: SdkQueryFunction;
  titleGenerationProviderServiceForTesting?: TitleGenerationProviderService;
}

export class ModelUnavailableError extends Error {}

export interface CreateSessionParams {
  workspacePath?: string | null;
  initialTools?: string[];
  config?: Partial<Session['config']>;
  harness?: Session['config']['harness'];
  worktreeBaseBranch?: string;
  worktreeMode?: 'worktree' | 'direct';
  detectGit?: false;
  title?: string;
  sessionId?: string;
  executionProjectPath?: string;
  lobbyId?: string;
  spaceId?: string;
  createdBy?: 'human';
  sessionType?: 'worker' | 'lobby';
  pairedSessionId?: string;
  parentSessionId?: string;
  currentTaskId?: string;
  promptProvenance?: SessionMetadata['promptProvenance'];
  toolProfile?: SessionToolProfile;
  workerTemplate?: string;
}

export class SessionLifecycle {
  private readonly operationMcp = new OperationMcpHttpServer();
  private readonly resourceOperations = new Map<string, Promise<unknown>>();
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

    const providedWorkspacePath = params.workspacePath?.trim();
    const baseWorkspacePath = providedWorkspacePath ? providedWorkspacePath : undefined;

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

    const carriedConfig = admitCreateSessionConfig(params.config);

    let gitSupport: Awaited<ReturnType<typeof this.worktreeManager.detectGitSupport>> | undefined;
    let isGitRepo = false;
    if (baseWorkspacePath !== undefined && params.detectGit !== false) {
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
      params.detectGit !== false &&
      supportsWorktreeChoice &&
      !this.config.disableWorktrees &&
      (!isGitRepo || explicitWorktreeMode === 'worktree');

    const globalSettings = this.db.getGlobalSettings();

    const { id: modelId, provider: resolvedProvider } = await this.getValidatedModelId(
      params.config?.model || undefined,
      params.config?.provider,
      globalSettings
    );
    const provider = (params.config?.provider ?? resolvedProvider) as Provider;
    const sandbox = params.config?.sandbox
      ? { ...globalSettings.sandbox, ...params.config.sandbox }
      : globalSettings.sandbox;
    const providerRecord = () => this.db.providers.getProviderByProviderId(provider);
    const harness = selectSessionEngine(
      params.harness ?? engineForProvider(provider, providerRecord)
    );
    if (isOxapHarness(harness)) {
      const refusal =
        codexSessionRefusal(
          effectiveOxapConfig(
            { ...carriedConfig, sandbox, coordinatorMode: params.config?.coordinatorMode },
            globalSettings
          ),
          false,
          false
        ) ??
        thinkingRefusal(harness, params.config?.thinkingLevel, modelId) ??
        (await newSessionOxapRefusal(
          harness,
          provider,
          providerRecord(),
          globalSettings.oxapHub,
          this.config.oxapCredentials
        ));
      if (refusal) throw new OxapSessionAdmissionError(refusal);
    } else if (provider === 'deepseek') {
      const record = providerRecord();
      if (
        record &&
        savedOxapAdapter(record)?.modelProvider &&
        !(await getProviderService().isProviderAvailable(provider))
      ) {
        throw new OxapSessionAdmissionError('Claude Code needs DEEPSEEK_API_KEY for DeepSeek');
      }
    }

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
        ...carriedConfig,
        model: modelId,
        maxTokens: params.config?.maxTokens || this.config.maxTokens,
        temperature: params.config?.temperature || this.config.temperature,
        autoScroll: params.config?.autoScroll ?? globalSettings.autoScroll,
        thinkingLevel:
          params.config?.thinkingLevel ??
          (harness === 'oxap-codex' ? undefined : globalSettings.thinkingLevel),
        coordinatorMode: params.config?.coordinatorMode ?? globalSettings.coordinatorMode,
        provider,
        sandbox,
        ...(isOxapHarness(harness) ? { harness } : {}),
        settingSources: params.config?.settingSources ?? globalSettings.settingSources,
        ...(params.toolProfile ? { toolProfile: params.toolProfile } : {}),
      },
      metadata: {
        ...(params.workerTemplate ? { workerTemplate: params.workerTemplate } : {}),
        ...(params.executionProjectPath
          ? { executionProjectPath: params.executionProjectPath }
          : {}),
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
        ...(params.currentTaskId && { currentTaskId: params.currentTaskId }),
        ...(params.promptProvenance && { promptProvenance: params.promptProvenance }),
      },
      parentSessionId: params.parentSessionId ?? null,
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

    try {
      await this.db.createSession(session, {
        enforceWorkspaceOwnership: true,
        ownershipPath: baseWorkspacePath ?? undefined,
      });
    } catch (error) {
      if (
        worktreeMetadata &&
        error instanceof Error &&
        error.message.includes('is not registered to space')
      ) {
        await this.discardWorktree(worktreeMetadata);
      }
      throw error;
    }

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

  private async discardWorktree(worktree: WorktreeMetadata): Promise<void> {
    try {
      await this.worktreeManager.removeWorktree(worktree, true);
    } catch (removeError) {
      this.logger.error(
        '[SessionLifecycle] Failed to remove orphan worktree after admission failure:',
        removeError
      );
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

    await this.db.updateSession(sessionId, updatedSession);

    await agentSession.updateMetadata(updatedSession);

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

    const spaceId = session.context?.spaceId;
    if (spaceId && !this.db.isWorkspaceRegisteredToSpace(spaceId, normalizedPath)) {
      throw new Error(
        `Workspace ${normalizedPath} is not registered to space ${spaceId}; setWorkspace blocked`
      );
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

    if (spaceId && !this.db.isWorkspaceRegisteredToSpace(spaceId, normalizedPath)) {
      if (worktreeMetadata) {
        await this.discardWorktree(worktreeMetadata);
      }
      throw new Error(
        `Workspace ${normalizedPath} is no longer registered to space ${spaceId}; setWorkspace blocked`
      );
    }

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

    await this.db.updateSession(sessionId, updatedSession);

    await agentSession.updateMetadata(updatedSession);

    await this.internalEventBus.publish('session.updated', {
      sessionId,
      session: updatedSession,
    });

    return updatedSession;
  }

  async update(sessionId: string, updates: Partial<Session>): Promise<void> {
    const agentSession = this.sessionCache.has(sessionId) ? this.sessionCache.get(sessionId) : null;
    if (
      agentSession &&
      updates.config &&
      ('autoCompactPercent' in updates.config || 'autoCompactWindow' in updates.config)
    ) {
      const { config, ...metadata } = updates;
      await agentSession.updateMetadata(metadata);
      await agentSession.updateConfig(config);
      updates = {
        ...updates,
        config: agentSession.getSessionData().config,
        metadata: agentSession.getSessionData().metadata,
      };
    } else {
      await this.db.updateSession(sessionId, updates);
      if (agentSession) await agentSession.updateMetadata(updates);
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

  async updateInputDraftIf(
    snapshot: SessionInputDraftSnapshot,
    text: string | null
  ): Promise<SessionInputDraftCommitOutcome> {
    const outcome = await commitSessionInputDraft(
      snapshot,
      text,
      this.db,
      this.sessionCache,
      async (sessionId) => {
        const current = this.db.getSession(sessionId);
        if (!current) throw new Error(`Session ${sessionId} missing after draft commit`);
        await this.internalEventBus.publish('session.updated', {
          sessionId,
          source: 'input-draft-commit',
          session: { metadata: current.metadata },
        });
      }
    );
    if (outcome.kind === 'won' && !outcome.notified) {
      this.logger.warn(`session.updated publication failed after draft commit for ${snapshot.id}`);
    }
    return outcome;
  }

  private async cleanupSessionWorktree(worktree: WorktreeMetadata): Promise<WorktreeCleanup> {
    const cleanup = (await cleanupOwnedWorktree(worktree.worktreePath, [
      getWorktreeBaseDir(worktree.mainRepoPath),
    ])) ?? {
      directory: worktree.worktreePath,
      removed: false,
      reason: 'The worktree is outside its project root; kept.',
    };
    if (cleanup.removed) await this.worktreeManager.removeWorktree(worktree, true);
    return cleanup;
  }

  private async withSessionResources<T>(sessionId: string, effect: () => Promise<T>): Promise<T> {
    const previous = this.resourceOperations.get(sessionId);
    const pending = (previous?.catch(() => {}) ?? Promise.resolve()).then(effect);
    this.resourceOperations.set(sessionId, pending);
    try {
      return await pending;
    } finally {
      if (this.resourceOperations.get(sessionId) === pending)
        this.resourceOperations.delete(sessionId);
    }
  }

  operationMcpSession(session: ReturnType<AgentSessionFactory>) {
    const { id } = session.getSessionData();
    const stored = this.db.getSession(id);
    if (this.resourceOperations.has(id) || !stored || stored.status === 'archived')
      throw new Error('Operations MCP requires an open session.');
    return this.operationMcp;
  }

  closeOperationMcp() {
    return this.operationMcp.close();
  }

  unarchive(sessionId: string): Promise<UnarchiveSessionResponse> {
    return this.withSessionResources(sessionId, async () => {
      const session = this.db.getSession(sessionId);
      if (!session) return { success: false, reason: 'Session not found' };
      if (session.status === 'active') return { success: true };
      if (session.status !== 'archived')
        return { success: false, reason: 'Only archived sessions can be reopened' };
      return this.restoreArchivedSession(session);
    });
  }

  private async restoreArchivedSession(session: Session): Promise<UnarchiveSessionResponse> {
    const archived = session.metadata.archivedWorktree;
    let worktree = session.worktree ?? (archived && { ...archived, isWorktree: true });
    const sdkWorkspacePath = sessionSdkPath({ workspacePath: session.workspacePath, worktree });
    let worktreeBaseBranch: string | undefined;
    if (worktree && !(await this.worktreeManager.verifyWorktree(worktree))) {
      const { branch, mainRepoPath } = worktree;
      const base = await this.worktreeManager.resolveUnarchiveBase(mainRepoPath, branch);
      worktreeBaseBranch = base.branch;
      worktree =
        (await this.worktreeManager.createWorktree({
          sessionId: session.id,
          repoPath: mainRepoPath,
          branchName: `session/restored-${generateUUID()}`,
          baseBranch: base.ref,
        })) ?? undefined;
      if (!worktree) throw new Error('Could not recreate the archived worktree');
    }

    const updates = {
      status: 'active' as const,
      archivedAt: null,
      ...(worktree ? { worktree, gitBranch: worktree.branch } : {}),
    };
    let written = false;
    try {
      const commit = async () => (await this.db.updateSession(session.id, updates)) === 'written';
      written = sdkWorkspacePath
        ? await withUnarchivedSDKSessions(sdkWorkspacePath, sessionSdkIds(session), commit)
        : await commit();
    } finally {
      if (!written && worktreeBaseBranch && worktree)
        await this.worktreeManager.removeWorktree(worktree);
    }
    if (!written) return { success: false, reason: 'This session cannot be reopened' };

    this.sessionCache.remove(session.id);
    await this.internalEventBus
      .publish('session.updated', {
        sessionId: session.id,
        source: 'update',
        session: { ...updates, archivedAt: undefined },
      })
      .catch((error: unknown) => this.logger.warn('Could not publish session restore', error));
    return { success: true, ...(worktreeBaseBranch ? { worktreeBaseBranch } : {}) };
  }

  cleanupArchivedWorktree(sessionId: string): Promise<WorktreeCleanup | undefined> {
    return this.withSessionResources(sessionId, () =>
      this.cleanupArchivedWorktreeResources(sessionId)
    );
  }

  private async cleanupArchivedWorktreeResources(
    sessionId: string
  ): Promise<WorktreeCleanup | undefined> {
    const session = this.db.getSession(sessionId);
    if (session?.status !== 'archived' || !session.worktree) return undefined;
    const cleanup = await this.cleanupSessionWorktree(session.worktree);
    if (cleanup.removed) await this.update(sessionId, { worktree: undefined });
    return cleanup;
  }

  archiveResources(
    sessionId: string,
    trigger: ArchiveResourcesTrigger
  ): Promise<WorktreeCleanup | undefined> {
    return this.withSessionResources(sessionId, () =>
      this.archiveSessionResources(sessionId, trigger)
    );
  }

  private async archiveSessionResources(
    sessionId: string,
    trigger: ArchiveResourcesTrigger
  ): Promise<WorktreeCleanup | undefined> {
    const grantSession = await this.operationMcp.revoke(sessionId);
    const agentSession = this.sessionCache.has(sessionId) ? this.sessionCache.get(sessionId) : null;
    const session = this.db.getSession(sessionId);
    if (!session) {
      this.logger.warn(`[SessionLifecycle] archiveResources: session ${sessionId} not found`);
      return;
    }

    const completedPhases: string[] = [];
    const archivedAt = new Date().toISOString();

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

    try {
      await (agentSession ?? grantSession)?.oxap?.detach?.();
    } catch (error) {
      this.logger.error('[SessionLifecycle] archiveResources: OXAP detach failed:', error);
    }
    await releaseWorkerSandbox(sessionSdkPath(session));

    await this.update(sessionId, { status: 'archived', archivedAt });
    completedPhases.push('db-mark-archived');

    try {
      const failedDbIds = await teardownSessionDeliveries(sessionId, {
        db: this.db,
        internalEventBus: this.internalEventBus,
        settleSkipped: (sid, messageUuid) =>
          (this.sessionCache.has(sid) ? this.sessionCache.get(sid) : null)?.settleSkippedDelivery(
            messageUuid
          ) ?? Promise.resolve(),
      });
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

    try {
      const sdkWorkspacePath = sessionSdkPath(session);
      const archived = sdkWorkspacePath
        ? await archiveSDKSessions(sdkWorkspacePath, sessionSdkIds(session))
        : 0;
      completedPhases.push(archived ? 'sdk-session-archive' : 'sdk-session-archive-skipped');
    } catch (error) {
      this.logger.error(`[SessionLifecycle] archiveResources: SDK session archive failed:`, error);
    }

    let cleanup: WorktreeCleanup | undefined;
    if (session.worktree) {
      try {
        if (trigger === 'work_archive')
          cleanup = await this.cleanupSessionWorktree(session.worktree);
        else {
          await this.worktreeManager.removeWorktree(session.worktree, true);
          await releaseRemovedWorkerFolders(session.worktree.worktreePath);
        }
        if (cleanup?.removed !== false) completedPhases.push('worktree-remove');
      } catch (error) {
        this.logger.error(`[SessionLifecycle] archiveResources: worktree removal failed:`, error);
        if (trigger === 'work_archive')
          cleanup = {
            directory: session.worktree.worktreePath,
            removed: false,
            reason: worktreeUnverified(error),
          };
      }
    }
    const keepWorktree = cleanup?.removed === false;

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
      const metadataUpdate = archivedWorktreeMetadata;

      await this.update(sessionId, {
        status: 'archived',
        archivedAt,
        ...(session.worktree && !keepWorktree ? { worktree: undefined } : {}),
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
    return cleanup;
  }

  deleteResources(sessionId: string, trigger: DeleteResourcesTrigger): Promise<void> {
    return this.withSessionResources(sessionId, () =>
      this.deleteSessionResources(sessionId, trigger)
    );
  }

  private async deleteSessionResources(
    sessionId: string,
    trigger: DeleteResourcesTrigger
  ): Promise<void> {
    await this.operationMcp.revoke(sessionId);
    const agentSession = this.sessionCache.has(sessionId) ? this.sessionCache.get(sessionId) : null;
    const session = this.db.getSession(sessionId);

    const completedPhases: string[] = [];

    try {
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
        await releaseWorkerSandbox(sessionSdkPath(session));
        if (session.status !== 'archived') {
          await this.update(sessionId, {
            status: 'archived',
            archivedAt: new Date().toISOString(),
          });
          completedPhases.push('db-mark-archived');
        }
      }
      try {
        const failedDbIds = await teardownSessionDeliveries(sessionId, {
          db: this.db,
          internalEventBus: this.internalEventBus,
          settleSkipped: (sid, messageUuid) =>
            (this.sessionCache.has(sid) ? this.sessionCache.get(sid) : null)?.settleSkippedDelivery(
              messageUuid
            ) ?? Promise.resolve(),
        });
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

      if (session) {
        try {
          const sdkWorkspacePath = sessionSdkPath(session);
          const deleted = sdkWorkspacePath
            ? await deleteSDKSessions(sdkWorkspacePath, sessionSdkIds(session))
            : 0;
          completedPhases.push(deleted ? 'sdk-session-delete' : 'sdk-session-delete-skipped');
        } catch (error) {
          this.logger.error(
            `[SessionLifecycle] deleteResources: SDK session delete failed:`,
            error
          );
        }
      }

      if (session?.worktree) {
        try {
          await this.worktreeManager.removeWorktree(session.worktree, true);
          await releaseRemovedWorkerFolders(session.worktree.worktreePath);
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
        await this.db.deleteSession(sessionId);
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

      await this.db.updateSession(sessionId, updatedSession);

      await agentSession.updateMetadata(updatedSession);

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

      await this.db.updateSession(sessionId, fallbackSession);
      await agentSession.updateMetadata(fallbackSession);

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
      if (!config) {
        this.logger.warn(
          `[SessionLifecycle] Provider ${provider} has no visible models, using fallback title`
        );
        return {
          title: messageText.substring(0, 50).trim() || 'New Session',
          isFallback: true,
        };
      }
      modelId = config.modelId;
    }

    try {
      const title = await this.generateTitleWithSdk(provider, modelId, messageText);
      if (!title) {
        return {
          title: messageText.substring(0, 50).trim() || 'New Session',
          isFallback: true,
        };
      }
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
  ): Promise<string | null> {
    const query = this.config.titleGenerationQueryForTesting;
    const providerService =
      this.config.titleGenerationProviderServiceForTesting ?? getProviderService();

    const titleModels = await providerService.getTitleGenerationModels(provider, modelId);
    if (!titleModels) {
      this.logger.warn(
        `[SessionLifecycle] Provider ${provider} has no visible models, skipping title generation`
      );
      return null;
    }

    const prompt = buildTitleGenerationPrompt(messageText);

    let title =
      (await runOneShotModel({
        prompt,
        provider,
        model: titleModels.sdkModelId,
        thinkingModelId: titleModels.providerModelId,
        env: await providerService.getIsolatedEnvForModel(provider, titleModels.providerModelId),
        query,
      })) ?? '';

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
  }

  private async getValidatedModelId(
    explicitModel: string | undefined,
    explicitProvider: string | undefined,
    settings: NewSessionModelSettings
  ): Promise<{ id: string; provider?: string }> {
    const { catalog, decision } = await resolveNewSessionModel(
      explicitModel,
      explicitProvider,
      settings,
      this.config.defaultModel
    );
    if (catalog.error !== undefined)
      this.logger.error('[SessionLifecycle] Error getting models:', catalog.error);
    if (decision.kind === 'curated_out')
      throw new Error(
        `Model '${decision.model}' is curated out for provider '${decision.provider}' and cannot be used for a new session`
      );
    if (decision.kind === 'unavailable')
      throw new ModelUnavailableError(
        `Model '${decision.model}'${decision.provider ? ` (${decision.provider})` : ''} is not available and no fallback model is. Choose another default model in Settings.`
      );
    if (decision.fallbackFrom)
      this.logger.warn(
        `[SessionLifecycle] Model '${decision.fallbackFrom}' is not available; using fallback '${decision.id}' (${decision.provider})`
      );
    return { id: decision.id, ...(decision.provider ? { provider: decision.provider } : {}) };
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
