/**
 * Session Lifecycle Module
 *
 * Handles session CRUD operations:
 * - Session creation with worktree support
 * - Session update
 * - Session deletion with cleanup cascade
 * - Model validation
 * - Title generation and branch renaming
 */

import type { Provider, Session, WorktreeMetadata, MessageHub } from '@hyperneo/shared';
import { generateUUID } from '@hyperneo/shared';
import type { Database } from '../../storage/database';
import type { DaemonInternalEventMap, InternalEventBus } from '../internal-event-bus';
import type { WorktreeManager } from '../worktree-manager';
import { Logger } from '../logger';
import type { SessionCache, AgentSessionFactory } from './session-cache';
import type { ToolsConfigManager } from './tools-config';
import { getProviderService, mergeProviderEnvVars } from '../provider-service';
import { archiveSDKSessionFiles, deleteSDKSessionFiles } from '../sdk-session-file-manager';
import { resolveSDKCliPath, isRunningUnderBun } from '../agent/sdk-cli-resolver.js';
import { withSdkTranscriptRetention } from '../agent/sdk-transcript-retention';
import { KimiProvider } from '../providers/kimi-provider.js';
import { findInModels } from '../model-service';

/**
 * Trigger identifiers for the two UI-only primitives that touch session
 * worktrees, SDK `.jsonl` files, or the `sessions` DB row.
 *
 * **Invariant (Task #85):** only UI-initiated code paths may invoke
 * `archiveResources` / `deleteResources`. Every other lifecycle event
 * (task done, cancelled, spawn rollback, workflow end, daemon shutdown,
 * etc.) must stop at interrupting the in-memory SDK subprocess.
 *
 * Each trigger documents the originating UI RPC so non-UI callers stand
 * out during code review and the CI regression guard can locate them.
 */
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
  /** @internal Test-only SDK query override for title generation. */
  titleGenerationQueryForTesting?: SdkQueryFunction;
  /** @internal Test-only provider service override for title generation. */
  titleGenerationProviderServiceForTesting?: TitleGenerationProviderService;
}

export interface CreateSessionParams {
  workspacePath?: string | null;
  initialTools?: string[];
  config?: Partial<Session['config']>;
  worktreeBaseBranch?: string;
  /**
   * Explicit worktree decision. When set, the session is created already
   * decided (no `pending_worktree_choice` prompt). Only honored for worker
   * sessions that have a workspace path.
   */
  worktreeMode?: 'worktree' | 'direct';
  title?: string; // Optional title - if provided, skips auto-title generation
  sessionId?: string; // Optional custom session ID
  lobbyId?: string; // Optional lobby ID to assign session to
  /** Optional Space ID for space_chat sessions (space:chat:${spaceId}) */
  spaceId?: string;
  createdBy?: 'human'; // Creator type (defaults to 'human')
  // Session types:
  // - 'worker': Standard coding session with Claude Code system prompt
  // - 'lobby': Instance-level agent session
  // - 'space_chat': Per-space coordinator session (space:chat:${spaceId})
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

  /**
   * Create a new session
   */
  async create(params: CreateSessionParams): Promise<string> {
    // Use provided sessionId or generate a new one
    const sessionId = params.sessionId || generateUUID();
    const sessionType = params.sessionType ?? 'worker';

    // Session types that require a workspacePath.
    // Non-scoped sessions are allowed to be unbound (workspacePath = null).
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

    // Guard: when no workspace path is available (daemon started without --workspace and
    // session provides no explicit workspacePath), skip git-support detection and worktree
    // creation. This protects unbound sessions from causing
    // detectGitSupport(undefined) to crash.
    let gitSupport: Awaited<ReturnType<typeof this.worktreeManager.detectGitSupport>> | undefined;
    let isGitRepo = false;
    if (baseWorkspacePath !== undefined) {
      gitSupport = await this.worktreeManager.detectGitSupport(baseWorkspacePath);
      isGitRepo = gitSupport.isGitRepo;
    }

    // Worktree choice is only for worker sessions.
    const supportsWorktreeChoice = sessionType === 'worker';

    // An explicit worktree decision from the caller (e.g. the empty-state
    // composer) skips the in-chat choice prompt. Only meaningful for worker
    // sessions that actually have a workspace path and when worktrees are enabled.
    const explicitWorktreeMode =
      supportsWorktreeChoice && baseWorkspacePath !== undefined && !this.config.disableWorktrees
        ? validWorktreeMode
        : undefined;

    // Determine if worktree choice should be shown — git repos with no
    // explicit decision still go through the in-chat choice flow.
    const shouldShowChoice =
      supportsWorktreeChoice && isGitRepo && !this.config.disableWorktrees && !explicitWorktreeMode;

    // Determine if a worktree should be created immediately:
    //  - non-git repos (no choice flow exists for them), or
    //  - git repos where the caller explicitly chose 'worktree'.
    const shouldCreateWorktree =
      baseWorkspacePath !== undefined &&
      supportsWorktreeChoice &&
      !this.config.disableWorktrees &&
      (!isGitRepo || explicitWorktreeMode === 'worktree');

    // Read global settings for defaults (model, thinkingLevel, autoScroll)
    const globalSettings = this.db.getGlobalSettings();

    // Validate and resolve model ID using cached models
    // Priority: params.config.model > globalSettings.model > server default
    const requestedModel = params.config?.model || globalSettings.model;
    const { id: modelId, provider: resolvedProvider } = await this.getValidatedModelId(
      requestedModel,
      params.config?.provider
    );

    // Determine if title should be auto-generated
    // If title is provided, mark as generated to skip auto-title generation
    const providedTitle = params.title?.trim();
    const shouldSkipAutoTitle = Boolean(providedTitle);

    // Create worktree with appropriate branch name.
    // If no workspace is provided, keep the session unbound (workspacePath = null).
    let worktreeMetadata: WorktreeMetadata | undefined;
    let sessionWorkspacePath: string | null = baseWorkspacePath ?? null;
    const initialBranchName = shouldSkipAutoTitle
      ? generateBranchName(providedTitle!, sessionId) // Title is defined when shouldSkipAutoTitle is true
      : `session/${sessionId}`;

    // Create worktree for non-git repos
    // Git repos will go through choice flow
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
        // Continue without worktree - fallback to base workspace
      }
      if (explicitWorktreeMode === 'worktree' && !worktreeMetadata) {
        throw new Error('Failed to create worktree for the selected project');
      }
    }

    // Determine session status based on worktree choice needed
    const sessionStatus: Session['status'] = shouldShowChoice
      ? 'pending_worktree_choice'
      : 'active';

    // Detect current branch for non-worktree git repos
    let currentBranch: string | undefined = worktreeMetadata?.branch;
    if (!currentBranch && isGitRepo && gitSupport?.gitRoot) {
      try {
        // gitSupport and gitSupport.gitRoot are guaranteed non-null by the guard above
        const branch = await this.worktreeManager.getCurrentBranch(gitSupport!.gitRoot!);
        currentBranch = branch ?? undefined;
      } catch (error) {
        this.logger.debug('[SessionLifecycle] Failed to get current branch:', error);
        // Continue without branch info
      }
    }

    const session: Session = {
      id: sessionId,
      title: providedTitle || 'New Session',
      workspacePath: sessionWorkspacePath,
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      status: sessionStatus,
      // Session type: defaults to 'worker', can be set to 'lobby' or 'space_chat'
      type: sessionType,
      config: {
        model: modelId, // Use validated model ID
        maxTokens: params.config?.maxTokens || this.config.maxTokens,
        temperature: params.config?.temperature || this.config.temperature,
        // Apply global settings defaults for autoScroll and thinkingLevel
        autoScroll: params.config?.autoScroll ?? globalSettings.autoScroll,
        thinkingLevel: params.config?.thinkingLevel ?? globalSettings.thinkingLevel,
        coordinatorMode: params.config?.coordinatorMode ?? globalSettings.coordinatorMode,
        permissionMode: params.config?.permissionMode,
        // Provider: Allow explicit override; fall back to resolved provider from model alias.
        // Critical when providers share canonical IDs (e.g., Anthropic and
        // anthropic-copilot both owning claude-sonnet-4.6).
        provider: (params.config?.provider ?? resolvedProvider) as Provider,
        // Tools config: explicit value when provided, otherwise undefined.
        // MCP enablement is resolved at query-build time from the
        // `app_mcp_servers` registry + `mcp_enablement` overrides — there
        // is no per-session disabled list to seed here.
        tools: params.config?.tools,
        // Sandbox: Use global settings default (enabled with network access)
        // Global settings provide balanced security: filesystem isolation + dev domains allowed
        // If user provides partial sandbox config (e.g., just enabled: false), respect that
        sandbox: params.config?.sandbox ?? globalSettings.sandbox,
        // MCP servers: Allow room chat sessions to include room-agent-tools
        mcpServers: params.config?.mcpServers,
        // Setting sources: inherit from global settings so CLAUDE.md is loaded by default
        settingSources: params.config?.settingSources ?? globalSettings.settingSources,
      },
      metadata: {
        messageCount: 0,
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalCost: 0,
        toolCallCount: 0,
        // Mark as generated if title was provided to skip auto-title generation
        titleGenerated: shouldSkipAutoTitle,
        // Workspace is initialized only when a concrete workspace path exists.
        workspaceInitialized: sessionWorkspacePath !== null,
        // Pending when the choice UI will be shown; pre-completed when the
        // caller decided up front; otherwise omitted.
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
        // Dual-session architecture fields
        ...(params.sessionType && { sessionType: params.sessionType }),
        ...(params.pairedSessionId && { pairedSessionId: params.pairedSessionId }),
        ...(params.parentSessionId && { parentSessionId: params.parentSessionId }),
        ...(params.currentTaskId && { currentTaskId: params.currentTaskId }),
      },
      // Worktree set during creation (if enabled)
      worktree: worktreeMetadata,
      gitBranch: currentBranch ?? undefined,
      // Context for lobby/space sessions (includes links between chat and self sessions)
      context:
        params.lobbyId || params.spaceId
          ? {
              ...(params.lobbyId && { lobbyId: params.lobbyId }),
              ...(params.spaceId && { spaceId: params.spaceId }),
            }
          : undefined,
    };

    // Save to database
    this.db.createSession(session);

    // Create agent session and add to cache
    const agentSession = this.createAgentSession(session);
    this.sessionCache.set(sessionId, agentSession);

    // Emit event via InternalEventBus<DaemonInternalEventMap> (StateManager will handle publishing to MessageHub)
    await this.internalEventBus.publish('session.created', { sessionId, session });

    return sessionId;
  }

  /**
   * Create worktree internal helper
   *
   * Private method to handle worktree creation with proper error handling.
   * Used during session creation and when completing worktree choice.
   *
   * @param sessionId - Session ID for logging
   * @param baseWorkspacePath - Base workspace path
   * @param branchName - Branch name for the worktree
   * @param baseBranch - Base branch to create worktree from (default: 'HEAD')
   * @returns WorktreeMetadata if successful, undefined if creation fails
   */
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

  /**
   * Complete worktree setup after user makes choice
   *
   * @param sessionId - Session ID
   * @param choice - User's worktree choice ('worktree' or 'direct')
   * @returns Updated session data
   */
  async completeWorktreeChoice(sessionId: string, choice: 'worktree' | 'direct'): Promise<Session> {
    const agentSession = this.sessionCache.get(sessionId);
    if (!agentSession) {
      throw new Error(`Session ${sessionId} not found`);
    }

    const session = agentSession.getSessionData();
    const sessionType = session.type ?? 'worker';

    // Verify session is in pending state
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
      // Create worktree now
      // Generate branch name (use session ID based name since title should be generated by now)
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
      // Direct mode - use workspace as-is
      this.logger.info(
        `[SessionLifecycle] Worktree choice completed: direct mode for session ${sessionId}`
      );
    }

    // Detect current branch for direct mode (non-worktree)
    let currentBranch: string | undefined = worktreeMetadata?.branch;
    if (!currentBranch && effectiveChoice === 'direct' && baseWorkspacePath) {
      try {
        const branch = await this.worktreeManager.getCurrentBranch(baseWorkspacePath);
        currentBranch = branch ?? undefined;
      } catch (error) {
        this.logger.debug('[SessionLifecycle] Failed to get current branch:', error);
        // Continue without branch info
      }
    }

    // Re-read session data after async operations to pick up any concurrent metadata
    // updates (e.g. session.update clearing inputDraft) that arrived while we were
    // awaiting worktree creation. Using stale `session` here would overwrite those
    // updates when we call db.updateSession below.
    const latestSession = agentSession.getSessionData();

    // Update session
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

    // Save to database
    this.db.updateSession(sessionId, updatedSession);

    // Update in-memory agent session metadata
    agentSession.updateMetadata(updatedSession);

    // Emit event for state synchronization
    await this.internalEventBus.publish('session.updated', {
      sessionId,
      session: updatedSession,
    });

    return updatedSession;
  }

  /**
   * Set workspace on an existing session (post-creation)
   *
   * Called when user selects a workspace via the inline WorkspaceSelector in chat.
   * The session must be active with no workspace (workspacePath === null).
   *
   * @param sessionId - Session ID
   * @param workspacePath - Workspace path to set
   * @param worktreeMode - Whether to create a worktree or use direct mode
   * @returns Updated session data
   */
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

    // Only worker sessions support workspace setup
    if (session.type !== 'worker') {
      throw new Error(`Session ${sessionId} is not a worker session`);
    }

    // Session must be active
    if (session.status !== 'active') {
      throw new Error(
        `Session ${sessionId} status is ${session.status}, must be active to set workspace`
      );
    }

    // Guard against overwriting an existing workspace (would orphan old worktrees)
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
      // Detect current branch if git repo
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

    // Re-read to pick up any concurrent metadata updates
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

    // Save to database
    this.db.updateSession(sessionId, updatedSession);

    // Update in-memory agent session
    agentSession.updateMetadata(updatedSession);

    // Emit event for state synchronization
    await this.internalEventBus.publish('session.updated', {
      sessionId,
      session: updatedSession,
    });

    return updatedSession;
  }

  /**
   * Update a session
   */
  async update(sessionId: string, updates: Partial<Session>): Promise<void> {
    this.db.updateSession(sessionId, updates);

    // Update in-memory session if exists
    const agentSession = this.sessionCache.has(sessionId) ? this.sessionCache.get(sessionId) : null;
    if (agentSession) {
      agentSession.updateMetadata(updates);
    }

    // FIX: Emit event via InternalEventBus<DaemonInternalEventMap> - include data for decoupled state management.
    // Best-effort: the durable SQLite write above has already committed, so a
    // failing subscriber must NOT reject this call — callers (e.g. the voice
    // draft RPCs) would report a committed write as lost, and a client retry
    // would duplicate the already-persisted value.
    await this.internalEventBus
      .publish('session.updated', {
        sessionId,
        source: 'update',
        session: updates,
      })
      .catch((err: unknown) => {
        // Persistence already succeeded — the write stays valid. Log the failed
        // subscriber though: the bus collects and throws without logging, and a
        // silently failed state projection would leave consumers stale with no
        // diagnostic trail.
        this.logger.warn(
          `session.updated publication failed after commit for ${sessionId}: ${err instanceof Error ? err.message : String(err)}`
        );
      });
  }

  // =========================================================================
  // UI-only resource primitives (Task #85)
  // =========================================================================
  //
  // These two methods are the ONLY code paths allowed to remove a session's
  // worktree or SDK `.jsonl` files, or to delete its `sessions` DB row
  // (which cascades to `sdk_messages`). Every other lifecycle event —
  // task done, task cancelled, workflow end-node short-circuit, spawn
  // rollback, duplicate-task reconciliation, `space.stop`, daemon
  // shutdown/restart, session recovery — must preserve all persisted artifacts
  // and only interrupt the in-memory SDK subprocess (see
  // `SessionManager.interruptInMemorySession` and `TaskAgentManager.cleanup`).
  //
  // The `trigger` parameter documents the originating UI RPC. The CI
  // regression guard (`scripts/check-session-deletion-callers.sh`) lets
  // `archiveResources` / `deleteResources` be called only from the approved
  // UI handler files. Adding a new caller requires either extending the
  // guard allowlist or routing through an existing UI handler.

  /**
   * Archive a session's external resources (worktree + SDK `.jsonl` files)
   * while preserving the DB row and all `sdk_messages`.
   *
   * Stops the in-memory SDK subprocess (if any), archives the SDK session
   * files to a sibling `.archive/` directory (so they can be inspected or
   * recovered), removes the git worktree, and stamps the session as
   * `status='archived'` in the DB.
   *
   * Callable from UI archive paths only:
   *   - `session.archive` RPC handler
   *   - `task.archive` RPC handler (for each session attached to the task)
   */
  async archiveResources(sessionId: string, trigger: ArchiveResourcesTrigger): Promise<void> {
    const agentSession = this.sessionCache.has(sessionId) ? this.sessionCache.get(sessionId) : null;
    const session = this.db.getSession(sessionId);
    if (!session) {
      this.logger.warn(`[SessionLifecycle] archiveResources: session ${sessionId} not found`);
      return;
    }

    const completedPhases: string[] = [];
    const archivedAt = new Date().toISOString();

    // PHASE 0: Commit the persisted archive barrier BEFORE cancellation or any
    // teardown. Every enqueue/hydrate/claim/feed guard now sees archived for the
    // entire destructive window, so cancelForSession cannot be bypassed by a send
    // arriving between point-in-time cancellation and phase 4.
    await this.update(sessionId, { status: 'archived', archivedAt });
    completedPhases.push('db-mark-archived');

    // PHASE 1: Cancel active deliveries after the barrier. Terminalize any still
    // enqueued prompt so archive cannot leave a hidden orphan after deleting its
    // durable owner.
    try {
      const messageUuids =
        this.db.getJobQueueRepo?.()?.cancelForSessionWithMessages(sessionId) ?? [];
      const sdkRepo = this.db.getSDKMessageRepo?.();
      for (const messageUuid of messageUuids) {
        sdkRepo?.markDeliveryFailedByUuid(sessionId, messageUuid);
      }
      completedPhases.push('delivery-cancel');
    } catch (error) {
      this.logger.error(`[SessionLifecycle] archiveResources: delivery cancel failed:`, error);
    }

    // PHASE 2: Stop in-memory SDK subprocess.
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

    // PHASE 2: Archive SDK .jsonl files (move to .archive/ sidecar).
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

    // PHASE 3: Remove worktree.
    if (session.worktree) {
      try {
        await this.worktreeManager.removeWorktree(session.worktree, true);
        completedPhases.push('worktree-remove');
      } catch (error) {
        this.logger.error(`[SessionLifecycle] archiveResources: worktree removal failed:`, error);
      }
    }

    // FINALIZE: append cleanup metadata while preserving the archive barrier
    // committed before teardown. If the session had a worktree, clear it now that
    // the on-disk worktree has been removed.
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

  /**
   * Fully delete a session's external resources AND its DB row.
   *
   * Stops the in-memory SDK subprocess, deletes the SDK `.jsonl` files,
   * removes the worktree, deletes the `sessions` row (which cascades to
   * `sdk_messages`), removes the in-memory cache entry, and broadcasts
   * `session.deleted`.
   *
   * Callable from UI delete paths only:
   *   - `session.delete` RPC handler
   *   - `room.delete` RPC handler (cascades each room session through here)
   *
   * Uses a phased approach so partial failures are logged and surfaced via
   * global teardown rather than leaving the DB in an inconsistent state.
   */
  async deleteResources(sessionId: string, trigger: DeleteResourcesTrigger): Promise<void> {
    const agentSession = this.sessionCache.has(sessionId) ? this.sessionCache.get(sessionId) : null;
    const session = this.db.getSession(sessionId);

    const completedPhases: string[] = [];

    try {
      // PHASE 0: Commit the persisted archive barrier + cancel durable
      // deliveries BEFORE any teardown, mirroring archiveResources. Deletion
      // destroys the same resources (agent, SDK files, worktree) while the
      // session row is still `active`, so without the barrier a send or a
      // claimed delivery job passes the archived checks and drives against a
      // half-deleted session; job_queue has no session FK, so pending jobs
      // would also survive the row delete. See Codex (#3743968033).
      if (session && session.status !== 'archived') {
        await this.update(sessionId, {
          status: 'archived',
          archivedAt: new Date().toISOString(),
        });
        completedPhases.push('db-mark-archived');
      }
      try {
        const messageUuids =
          this.db.getJobQueueRepo?.()?.cancelForSessionWithMessages(sessionId) ?? [];
        const sdkRepo = this.db.getSDKMessageRepo?.();
        for (const messageUuid of messageUuids) {
          sdkRepo?.markDeliveryFailedByUuid(sessionId, messageUuid);
        }
        completedPhases.push('delivery-cancel');
      } catch (error) {
        this.logger.error(`[SessionLifecycle] deleteResources: delivery cancel failed:`, error);
      }

      // PHASE 1: Cleanup AgentSession (stops SDK subprocess)
      if (agentSession) {
        try {
          await agentSession.cleanup();
          completedPhases.push('agent-cleanup');
        } catch (error) {
          this.logger.error(
            `[SessionLifecycle] deleteResources: AgentSession cleanup failed:`,
            error
          );
          // Continue with deletion - SDK subprocess will be terminated when process exits
        }
      }

      // PHASE 1.5: Delete SDK session files from ~/.claude/projects/
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

      // PHASE 2: Delete worktree and branch
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

      // PHASE 3: Delete from database (point of no return)
      try {
        this.db.deleteSession(sessionId);
        completedPhases.push('db-delete');
      } catch (error) {
        this.logger.error(`[SessionLifecycle] deleteResources: Database deletion failed:`, error);
        throw error;
      }

      // PHASE 4: Remove from cache
      try {
        this.sessionCache.remove(sessionId);
        completedPhases.push('cache-remove');
      } catch (error) {
        this.logger.error(`[SessionLifecycle] deleteResources: Cache removal failed:`, error);
      }

      // PHASE 5: Broadcast deletion event
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

  /**
   * Get session metadata directly from database without loading SDK
   * Used for operations that don't require SDK initialization (e.g., removing tool outputs)
   */
  getFromDB(sessionId: string): Session | null {
    return this.db.getSession(sessionId);
  }

  /**
   * Get the in-memory AgentSession for a session ID.
   * Returns null if the session is not cached (e.g., not yet created or already deleted).
   */
  getAgentSession(sessionId: string): import('../agent/agent-session').AgentSession | null {
    return this.sessionCache.has(sessionId) ? this.sessionCache.get(sessionId) : null;
  }

  /**
   * Get AgentSession for a session ID, loading it from DB-backed cache if needed.
   */
  async getAgentSessionAsync(
    sessionId: string
  ): Promise<import('../agent/agent-session').AgentSession | null> {
    return this.sessionCache.getAsync(sessionId);
  }

  /**
   * Mark a message's tool output as removed from SDK session file
   * This updates the session metadata to track which outputs were deleted
   */
  async markOutputRemoved(sessionId: string, messageUuid: string): Promise<void> {
    const session = this.db.getSession(sessionId);
    if (!session) {
      throw new Error('Session not found');
    }

    // Add messageUuid to removedOutputs array (if not already present)
    const removedOutputs = session.metadata.removedOutputs || [];
    if (!removedOutputs.includes(messageUuid)) {
      removedOutputs.push(messageUuid);
    }

    // Update session metadata
    await this.update(sessionId, {
      metadata: {
        ...session.metadata,
        removedOutputs,
      },
    });
  }

  /**
   * Generate title and rename branch for a session
   * Called on first message to:
   * - Generate meaningful title from user message
   * - Rename branch from session/{uuid} to session/{slug}-{shortId}
   * - Update session record
   *
   * NOTE: Worktree is already created during session creation with session/{uuid} branch.
   * This method only generates title and renames the branch.
   *
   * @returns Object with title and isFallback flag indicating if title was actually generated
   */
  async generateTitleAndRenameBranch(
    sessionId: string,
    userMessageText: string
  ): Promise<{ title: string; isFallback: boolean }> {
    const agentSession = this.sessionCache.has(sessionId) ? this.sessionCache.get(sessionId) : null;
    if (!agentSession) {
      throw new Error(`Session ${sessionId} not found`);
    }

    const session = agentSession.getSessionData();

    // Respect a user-set title: never overwrite a manual rename with auto-gen.
    if (session.metadata.titleSetBy === 'user') {
      return { title: session.title, isFallback: false };
    }

    // Check if title already generated
    if (session.metadata.titleGenerated) {
      return { title: session.title, isFallback: false };
    }

    try {
      // Step 1: Generate title from user message using session's model
      // Cast to string: 'anthropic-copilot' is valid at runtime but not in the legacy Provider union.
      const { title, isFallback } = await this.generateTitleFromMessage(
        userMessageText,
        session.config.model,
        session.config.provider as string | undefined
      );

      // Re-check against fresh state BEFORE any irreversible work: a user may
      // have renamed during the generation await. Bail before renaming the
      // branch so we neither clobber the title nor rename the git branch and
      // then fail to persist it (which would desync metadata from the branch).
      const latest = agentSession.getSessionData();
      if (latest.metadata.titleSetBy === 'user') {
        return { title: latest.title, isFallback: false };
      }

      // Step 2: Rename branch if we have a worktree
      let newBranchName = session.worktree?.branch;
      if (session.worktree) {
        const newBranch = generateBranchName(title, sessionId);
        const oldBranch = session.worktree.branch;

        // Only rename if branch name is different (i.e., it's still session/{uuid})
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

      // Step 3: Update session record.
      // Re-read fresh state: a user may have renamed during the branch-rename
      // await above (renameBranch can also swallow errors and return false). If
      // so, keep their title (don't clobber it) but still persist any successful
      // branch rename so metadata and the git branch don't desync.
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
          // Only mark as generated when we actually generated (not on user rename).
          titleGenerated: userRenamed ? currentSession.metadata.titleGenerated : !isFallback,
        },
      };

      // Save to DB
      this.db.updateSession(sessionId, updatedSession);

      // Update in-memory session
      agentSession.updateMetadata(updatedSession);

      // Broadcast updates - include session data for decoupled state management
      await this.internalEventBus.publish('session.updated', {
        sessionId,
        source: 'title-generated',
        session: updatedSession,
      });

      // Return result so caller can check if it was a fallback
      return { title: finalTitle, isFallback: userRenamed ? false : isFallback };
    } catch (error) {
      // A user may have renamed during the (failed) generation; don't let the
      // fallback title overwrite it. Mirrors the pre-branch-rename re-check.
      const latest = agentSession.getSessionData();
      if (latest.metadata.titleSetBy === 'user') {
        return { title: latest.title, isFallback: false };
      }

      this.logger.error('[SessionLifecycle] Failed to generate title:', error);

      // Fallback: Use first 50 chars of message as title
      const fallbackTitle = userMessageText.substring(0, 50).trim() || 'New Session';
      const fallbackSession: Session = {
        ...session,
        title: fallbackTitle,
        metadata: {
          ...session.metadata,
          titleGenerated: false, // Mark as not generated (user can retry)
        },
      };

      this.db.updateSession(sessionId, fallbackSession);
      agentSession.updateMetadata(fallbackSession);

      // Include session data for decoupled state management
      await this.internalEventBus.publish('session.updated', {
        sessionId,
        source: 'title-generated',
        session: fallbackSession,
      });

      // Return result so caller can check if it was a fallback
      return { title: fallbackTitle, isFallback: true };
    }
  }

  /**
   * Generate title from first user message using direct API call
   * This bypasses the SDK subprocess and calls the Anthropic-like API directly
   *
   * @param sessionModel - The model to use for title generation (from session config)
   * @returns Object with title and isFallback flag
   */
  private async generateTitleFromMessage(
    messageText: string,
    sessionModel?: string,
    sessionProviderId?: string
  ): Promise<{ title: string; isFallback: boolean }> {
    const providerService =
      this.config.titleGenerationProviderServiceForTesting ?? getProviderService();

    // Determine which provider to use for title generation.
    // When the session has an explicit provider ID (e.g. 'anthropic-copilot'), use that
    // directly.  Otherwise fall back to the default configured provider.
    let provider: string;
    if (sessionProviderId) {
      provider = sessionProviderId;
    } else {
      provider = await providerService.getDefaultProvider();
    }

    // Fall back to the first 50 characters when the provider reports it is not
    // available (env vars, stored credentials, or provider-owned auth missing).
    // This delegates to each provider's own isAvailable() implementation so that
    // stored credentials are respected for title generation.
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

    // Use session model if provided, otherwise fall back to title generation config
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
      // Fallback to first 50 chars of message
      return {
        title: messageText.substring(0, 50).trim() || 'New Session',
        isFallback: true,
      };
    }
  }

  /**
   * Generate title using SDK query with proper environment setup
   *
   * Uses ProviderService to configure environment variables for the provider,
   * then calls the SDK's query function to generate the title.
   */
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

    // Apply provider-specific environment variables to process.env.
    // Use provider-facing title model so SDK tier/default routing points at the
    // provider's title override, not the session model.
    const originalEnv = await providerService.applyEnvVarsToProcessForProvider(
      provider,
      titleModels.providerModelId
    );

    try {
      const prompt = `Based on the user's request below, generate a concise 3-7 word title that captures the main intent or topic.

IMPORTANT: Return ONLY the title text itself, with NO formatting whatsoever:
- NO quotes around the title
- NO asterisks or markdown
- NO backticks
- NO punctuation at the end
- Just plain text words

User's request:
${messageText.slice(0, 2000)}`;

      // Get the environment variables to pass explicitly to SDK subprocess.
      // Pass the provider ID so that providers whose model IDs overlap with
      // Anthropic (e.g. anthropic-copilot using claude-opus-4.6) are looked up
      // by ID rather than auto-detected, which would return the wrong provider.
      const providerEnvVars = await providerService.getEnvVarsForModel(
        titleModels.providerModelId,
        provider
      );

      const cliPath = resolveSDKCliPath();

      // Merge provider env vars with parent process env vars
      // This ensures inherited vars (like ANTHROPIC_API_KEY) are preserved
      // while provider-specific vars (like ANTHROPIC_BASE_URL for GLM) override
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
          // Kimi K3 rejects `thinking.type` entirely, so omit the field for K3.
          // Kimi K2.7 models require thinking to be explicitly enabled. For all
          // other providers keep the previous disabled-thinking default.
          thinking:
            provider === 'kimi'
              ? KimiProvider.resolveKimiTitleThinkingConfig(titleModels.providerModelId)
              : { type: 'disabled' },
        },
      });

      // Extract title from the response. Keep this structural instead of importing
      // shared SDK type guards so unit tests are isolated from process-wide mock.module state.
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
            break; // Got the title, exit early
          }
        }
      }

      if (!title) {
        throw new Error('No text content in SDK response');
      }

      // Clean up the title
      title = title.replace(/\*\*(.+?)\*\*/g, '$1').replace(/\*(.+?)\*/g, '$1');

      // Remove wrapping quotes
      while (
        (title.startsWith('"') && title.endsWith('"')) ||
        (title.startsWith("'") && title.endsWith("'"))
      ) {
        title = title.slice(1, -1).trim();
      }

      // Remove backticks
      title = title.replace(/`/g, '');

      return title;
    } finally {
      // Always restore original environment variables
      providerService.restoreEnvVars(originalEnv);
    }
  }

  /**
   * Get a validated model ID by using cached dynamic models
   * Falls back to static model if dynamic loading failed or is unavailable
   *
   * Returns both the canonical model ID and the provider that owns it.
   * The provider is needed to correctly route providers whose models may share
   * canonical IDs with Anthropic (e.g., claude-sonnet-4.6).
   */
  private async getValidatedModelId(
    requestedModel?: string,
    explicitProvider?: string
  ): Promise<{ id: string; provider?: string }> {
    // Get available models from cache (already loaded on app startup)
    try {
      const { getAvailableModels } = await import('../model-service');
      const availableModels = getAvailableModels('global');

      if (availableModels.length > 0) {
        // If a specific model was requested, validate it (including accepted
        // provider aliases and alias prefixes such as moonshot-k3-*).
        if (requestedModel) {
          const found = findInModels(availableModels, requestedModel);
          if (found) {
            // When the caller explicitly selects a provider, don't let another
            // provider's aliases/prefixes silently take over the model.
            if (explicitProvider && found.provider !== explicitProvider) {
              // fall through to keep the requested model for its explicit provider
            } else {
              // Preserve documented [1m] context-window suffixes for the 1M Kimi
              // K3 flagship. findInModels returns the canonical unsuffixed ID, but
              // the SDK needs the suffix to avoid falling back to its default 200k
              // window. Only the 1M K3 qualifies — the 256K-capped `k3-256k` must
              // never carry the suffix.
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

          // If an explicit provider was requested and the model didn't resolve
          // to that provider's catalogue, trust the caller and leave the model
          // untouched. This prevents e.g. a custom-provider session with a
          // moonshot-* model ID from being rewritten to Kimi.
          if (explicitProvider) {
            return { id: requestedModel };
          }
        }

        // Use configured default model (from DEFAULT_MODEL env var or 'sonnet')
        // Try to find it by alias or ID in available models
        const configuredDefault = this.config.defaultModel;
        const defaultByConfig = findInModels(availableModels, configuredDefault);

        if (defaultByConfig) {
          return { id: defaultByConfig.id, provider: defaultByConfig.provider };
        }

        // Fallback: prefer Sonnet family if no configured default found
        const defaultModel =
          availableModels.find((m) => m.family === 'sonnet') || availableModels[0];

        if (defaultModel) {
          return { id: defaultModel.id, provider: defaultModel.provider };
        }
      }
    } catch (error) {
      this.logger.error('[SessionLifecycle] Error getting models:', error);
    }

    // Fallback to config default model or requested model
    // IMPORTANT: Always return full model ID, never aliases
    const fallbackModel = requestedModel || this.config.defaultModel;
    return { id: fallbackModel };
  }
}

/**
 * Generate branch name from title
 * Creates a slugified branch name like "session/fix-login-bug-abc123"
 */
export function generateBranchName(title: string, sessionId: string): string {
  // Slugify title: "Fix login bug" -> "fix-login-bug"
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-') // Replace non-alphanumeric with hyphens
    .replace(/^-|-$/g, '') // Remove leading/trailing hyphens
    .substring(0, 50); // Max 50 chars

  // Add short UUID to prevent conflicts
  const shortId = sessionId.substring(0, 8);

  return `session/${slug}-${shortId}`;
}

/**
 * Build environment variables for SDK query
 *
 * Merges provider-specific environment variables with parent process env vars.
 * This ensures inherited vars (like ANTHROPIC_API_KEY) are preserved while
 * provider-specific vars (like ANTHROPIC_BASE_URL for GLM) can override.
 *
 * @param providerEnvVars - Provider-specific environment variables
 * @returns Merged environment variables object
 */
function buildSdkQueryEnv(providerEnvVars: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return mergeProviderEnvVars(providerEnvVars as Record<string, string>);
}
