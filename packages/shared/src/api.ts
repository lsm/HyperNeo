import type {
	AuthStatus,
	DaemonConfig,
	FileInfo,
	FileTree,
	HealthStatus,
	Provider,
	ProviderInfo,
	Session,
	SessionConfig,
	Tool,
	ToolBundle,
	CommitInfo,
	WorktreeCommitStatus,
	// SDK Config types
	SDKConfig,
	SystemPromptConfig,
	ToolsSettings,
	AgentDefinition,
	SandboxSettings,
	McpServerConfig,
	OutputFormatConfig,
	SdkBeta,
	EnvironmentSettings,
	ModelSettings,
	ConfigUpdateResult,
} from './types.ts';
import type { PermissionMode } from './types/settings.ts';
import type {
	AppMcpServer,
	CreateAppMcpServerRequest,
	UpdateAppMcpServerRequest,
} from './types/app-mcp-server.ts';
import type { AppSkill, CreateSkillParams, UpdateSkillParams } from './types/skills.ts';
import type {
	CreateEvidenceRefParams,
	CreateEvolutionEpisodeParams,
	CreateEvolutionLessonParams,
	CreateEvolutionScopeParams,
	CreateMetricSnapshotParams,
	CreateTaskProposalParams,
	EvidenceQualityPreflight,
	EvidenceRef,
	EvolutionEpisode,
	EvolutionLesson,
	EvolutionScope,
	EvolutionScopeListParams,
	MetricSnapshot,
	TaskProposal,
	UpdateEvolutionEpisodeParams,
	UpdateEvolutionLessonParams,
	UpdateEvolutionScopeParams,
	UpdateTaskProposalParams,
} from './types/evolution.ts';
import type {
	SpaceGoal,
	SpaceTask,
	SpaceWorkflowRun,
	UpdateSpaceGoalParams,
} from './types/space.ts';

// Request types
export interface CreateSessionRequest {
	workspacePath?: string | null;
	initialTools?: string[];
	config?: Partial<SessionConfig>;
	worktreeBaseBranch?: string; // Base branch for worktree (default: HEAD)
	worktreeMode?: 'worktree' | 'direct'; // Explicit worktree decision — skips the in-chat choice prompt
	title?: string; // Optional title - if provided, skips auto-title generation
	roomId?: string; // Optional room ID to assign session to
	spaceId?: string; // Optional space ID to assign session to
	createdBy?: 'human'; // Creator type (defaults to 'human')
}

export interface CreateSessionResponse {
	sessionId: string;
	session?: Session; // Optionally include the full session for optimistic updates
}

export interface SetWorktreeModeRequest {
	sessionId: string;
	mode: 'worktree' | 'direct';
}

export interface SetWorktreeModeResponse {
	success: boolean;
	session?: Session;
}

export interface SetWorkspaceRequest {
	sessionId: string;
	workspacePath: string;
	worktreeMode: 'worktree' | 'direct';
}

export interface SetWorkspaceResponse {
	success: boolean;
	session: Session;
}

export interface ListSessionsResponse {
	sessions: Session[];
}

export interface GetSessionResponse {
	session: Session;
	activeTools: string[];
	context: {
		files: string[];
		workingDirectory: string | null;
	};
}

export interface UpdateSessionRequest {
	title?: string;
	workspacePath?: string | null;
	config?: Partial<SessionConfig>;
}

export interface WorkspaceHistoryEntry {
	path: string;
	lastUsedAt: number; // unix timestamp ms
	useCount: number;
}

export interface WorkspaceHistoryResponse {
	entries: WorkspaceHistoryEntry[];
}

export interface WorkspaceAddRequest {
	path: string;
}

export interface WorkspaceAddResponse {
	entry: WorkspaceHistoryEntry;
}

export interface WorkspaceRemoveRequest {
	path: string;
}

export interface WorkspaceRemoveResponse {
	success: boolean;
}

/** Response for `git.branches` — git context for a folder path. */
export interface GitBranchesResponse {
	/** Whether the path is inside a git repository. */
	isGitRepo: boolean;
	/** Absolute path to the repository root, or null when not a git repo. */
	gitRoot: string | null;
	/** Branch HEAD currently points to, or null when detached / unborn. */
	currentBranch: string | null;
	/** Best-guess default branch (origin/HEAD, else main/master), or null. */
	defaultBranch: string | null;
	/** Local branch names. */
	branches: string[];
	/** Whether the working tree has uncommitted changes. */
	isDirty: boolean;
}

export type GitSessionMode = 'worktree' | 'direct' | 'none';

export type GitFileStatusKind =
	| 'modified'
	| 'added'
	| 'deleted'
	| 'renamed'
	| 'untracked'
	| 'conflicted'
	| 'other';

export interface GitChangedFile {
	path: string;
	oldPath?: string;
	status: GitFileStatusKind;
	staged: boolean;
}

export type GitReviewFileSource = 'branch' | 'working_tree' | 'both';

export interface GitReviewFile {
	path: string;
	oldPath?: string;
	status: GitFileStatusKind;
	additions: number;
	deletions: number;
	patch: string | null;
	patchTruncated: boolean;
	source: GitReviewFileSource;
}

export interface GitPullRequestSummary {
	number: number;
	title: string;
	url: string;
	state: string;
	isDraft: boolean;
	mergeable: string | null;
	reviewDecision: string | null;
	headRefName: string | null;
	baseRefName: string | null;
	additions: number;
	deletions: number;
}

export interface GitCheckSummary {
	name: string;
	state: string;
	bucket: string | null;
	url: string | null;
}

export interface GitReviewSummary {
	files: GitReviewFile[];
	totalAdditions: number;
	totalDeletions: number;
	pullRequest: GitPullRequestSummary | null;
	checks: GitCheckSummary[];
	githubError?: string;
}

/** Response for `git.sessionStatus` — Git context for a specific chat session. */
export interface GitSessionStatusResponse {
	sessionId: string;
	mode: GitSessionMode;
	isGitRepo: boolean;
	workspacePath: string | null;
	worktreePath: string | null;
	mainRepoPath: string | null;
	branch: string | null;
	baseBranch: string | null;
	defaultBranch: string | null;
	isDirty: boolean;
	files: GitChangedFile[];
	commitsAhead: CommitInfo[];
	aheadCount: number | null;
	behindCount: number | null;
	review: GitReviewSummary;
	error?: string;
}

export interface ArchiveSessionRequest {
	sessionId: string;
	confirmed?: boolean;
}

export interface ArchiveSessionResponse {
	success: boolean;
	requiresConfirmation: boolean;
	commitStatus?: WorktreeCommitStatus;
	commitsRemoved?: number;
}

export interface SendMessageRequest {
	content: string;
	role?: 'user';
	attachments?: {
		files?: string[];
		images?: string[];
	};
}

export interface SendMessageResponse {
	messageId: string;
	status: 'processing';
}

export interface ReadFileRequest {
	path: string;
	encoding?: 'utf-8' | 'base64';
}

export interface ReadFileResponse {
	path: string;
	content: string;
	encoding: string;
	size: number;
	mtime: string;
}

export interface ListFilesRequest {
	path?: string;
	recursive?: boolean;
}

export interface ListFilesResponse {
	files: FileInfo[];
}

export interface GetFileTreeRequest {
	path?: string;
	maxDepth?: number;
}

export interface GetFileTreeResponse {
	tree: FileTree;
}

export interface ListToolsResponse {
	tools: Tool[];
	bundles: Record<string, ToolBundle>;
}

export interface LoadToolsRequest {
	tools?: string[];
	bundles?: string[];
}

export interface UnloadToolsRequest {
	tools: string[];
}

export interface GetActiveToolsResponse {
	activeTools: Array<{
		name: string;
		loadedAt: string;
		usageCount: number;
		lastUsed: string;
	}>;
}

export interface UpdateConfigRequest {
	defaultModel?: string;
	maxSessions?: number;
}

// Authentication API types
export interface GetAuthStatusResponse {
	authStatus: AuthStatus;
}

// Model API types
export interface GetCurrentModelRequest {
	sessionId: string;
}

export interface GetCurrentModelResponse {
	currentModel: string;
	modelInfo: {
		id: string;
		name: string;
		alias: string;
		family: 'opus' | 'sonnet' | 'haiku' | 'glm';
		contextWindow: number;
		description: string;
	} | null;
}

export interface SwitchModelRequest {
	sessionId: string;
	model: string; // Can be alias (e.g., "opus") or full ID
	provider: string; // Required — identifies which provider owns this model
}

export interface SwitchModelResponse {
	success: boolean;
	model: string; // The resolved model ID
	error?: string;
}

// ============================================================================
// SDK Config API Types
// ============================================================================

// --- Model Settings ---

export interface GetModelSettingsRequest {
	sessionId: string;
}

export interface GetModelSettingsResponse extends ModelSettings {
	// Inherits: model, fallbackModel, maxTurns, maxBudgetUsd, maxThinkingTokens
}

export interface UpdateModelSettingsRequest {
	sessionId: string;
	settings: Partial<ModelSettings>;
}

export interface UpdateModelSettingsResponse extends ConfigUpdateResult {
	// Inherits: applied, pending, errors
}

// --- System Prompt ---

export interface GetSystemPromptRequest {
	sessionId: string;
}

export interface GetSystemPromptResponse {
	systemPrompt?: SystemPromptConfig;
}

export interface UpdateSystemPromptRequest {
	sessionId: string;
	systemPrompt: SystemPromptConfig;
	restartQuery?: boolean;
}

export interface UpdateSystemPromptResponse {
	success: boolean;
	applied: boolean;
	error?: string;
	message?: string;
}

// --- Tools Configuration ---

export interface GetToolsConfigRequest {
	sessionId: string;
}

export interface GetToolsConfigResponse extends ToolsSettings {
	// Inherits: tools, allowedTools, disallowedTools
}

export interface UpdateToolsConfigRequest {
	sessionId: string;
	settings: Partial<ToolsSettings>;
	restartQuery?: boolean;
}

export interface UpdateToolsConfigResponse {
	success: boolean;
	applied: boolean;
	error?: string;
	message?: string;
}

// --- Agents/Subagents ---

export interface GetAgentsConfigRequest {
	sessionId: string;
}

export interface GetAgentsConfigResponse {
	agents?: Record<string, AgentDefinition>;
}

export interface UpdateAgentsConfigRequest {
	sessionId: string;
	agents: Record<string, AgentDefinition>;
	restartQuery?: boolean;
}

export interface UpdateAgentsConfigResponse {
	success: boolean;
	applied: boolean;
	error?: string;
	message?: string;
}

// --- Sandbox ---

export interface GetSandboxConfigRequest {
	sessionId: string;
}

export interface GetSandboxConfigResponse {
	sandbox?: SandboxSettings;
}

export interface UpdateSandboxConfigRequest {
	sessionId: string;
	sandbox: SandboxSettings;
	restartQuery?: boolean;
}

export interface UpdateSandboxConfigResponse {
	success: boolean;
	applied: boolean;
	error?: string;
	message?: string;
}

// --- MCP Servers ---

export interface McpServerStatus {
	name: string;
	status: 'connected' | 'disconnected' | 'error';
	error?: string;
}

export interface GetMcpConfigRequest {
	sessionId: string;
}

export interface GetMcpConfigResponse {
	mcpServers?: Record<string, McpServerConfig>;
	strictMcpConfig?: boolean;
	runtimeStatus?: McpServerStatus[];
}

export interface UpdateMcpConfigRequest {
	sessionId: string;
	mcpServers?: Record<string, McpServerConfig>;
	strictMcpConfig?: boolean;
	restartQuery?: boolean;
}

export interface UpdateMcpConfigResponse {
	success: boolean;
	applied: boolean;
	error?: string;
	message?: string;
}

export interface AddMcpServerRequest {
	sessionId: string;
	name: string;
	config: McpServerConfig;
	restartQuery?: boolean;
}

export interface AddMcpServerResponse {
	success: boolean;
	applied: boolean;
	error?: string;
	message?: string;
}

export interface RemoveMcpServerRequest {
	sessionId: string;
	name: string;
	restartQuery?: boolean;
}

export interface RemoveMcpServerResponse {
	success: boolean;
	applied: boolean;
	error?: string;
	message?: string;
}

/**
 * Entry describing a runtime-attached (in-process, SDK-type) MCP server.
 * These are injected by SpaceRuntimeService, TaskAgentManager, and similar
 * subsystems via `mergeRuntimeMcpServers`, and never appear in the skills
 * registry or in file-based MCP settings — so the Tool Modal needs a separate
 * path to surface them.
 */
export interface RuntimeMcpServerEntry {
	/** Key used in session.config.mcpServers (e.g. 'space-agent-tools'). */
	name: string;
}

export interface ListRuntimeMcpServersRequest {
	sessionId: string;
}

export interface ListRuntimeMcpServersResponse {
	servers: RuntimeMcpServerEntry[];
}

// --- Per-Space MCP Enablement (M4) ---

/**
 * One entry in the resolved per-space MCP list. Combines the registry row
 * with the resolved enabled-for-this-space state so the UI can render the
 * toggle without making a second call.
 */
export interface SpaceMcpEntry {
	serverId: string;
	name: string;
	description?: string;
	sourceType: 'stdio' | 'sse' | 'http';
	/** Provenance of the registry row (builtin / user / imported). */
	source: 'builtin' | 'user' | 'imported';
	/** Populated only when `source === 'imported'`. */
	sourcePath?: string;
	/** Whether this server is enabled globally in the registry. */
	globallyEnabled: boolean;
	/**
	 * True when there is an explicit `mcp_enablement` row for this
	 * (server, space) pair. When false, `enabled` equals `globallyEnabled`.
	 */
	overridden: boolean;
	/** Effective enabled state for this space (override if present, else global). */
	enabled: boolean;
}

export interface SpaceMcpListRequest {
	spaceId: string;
}

export interface SpaceMcpListResponse {
	entries: SpaceMcpEntry[];
}

export interface SpaceMcpSetEnabledRequest {
	spaceId: string;
	serverId: string;
	enabled: boolean;
}

export interface SpaceMcpSetEnabledResponse {
	ok: boolean;
}

export interface SpaceMcpClearOverrideRequest {
	spaceId: string;
	serverId: string;
}

export interface SpaceMcpClearOverrideResponse {
	ok: boolean;
}

// --- Forge evolution storage (Forge MVP 1) ---

export interface EvolutionScopeCreateRequest {
	params: CreateEvolutionScopeParams;
}

export interface EvolutionScopeCreateResponse {
	scope: EvolutionScope;
}

export interface EvolutionScopeGetRequest {
	id: string;
}

export interface EvolutionScopeGetResponse {
	scope: EvolutionScope | null;
}

export interface EvolutionScopeListRequest extends EvolutionScopeListParams {}

export interface EvolutionScopeListResponse {
	scopes: EvolutionScope[];
}

export interface EvolutionScopeUpdateRequest {
	id: string;
	params: UpdateEvolutionScopeParams;
}

export interface EvolutionScopeUpdateResponse {
	scope: EvolutionScope | null;
}

export interface EvolutionEvidenceCreateRequest {
	params: CreateEvidenceRefParams;
}

export interface EvolutionEvidenceCreateResponse {
	evidence: EvidenceRef;
}

export interface EvolutionEvidenceListRequest {
	scopeId: string;
	includePreflightContext?: boolean;
}

export interface EvolutionPreflightTaskSummary {
	title: string;
	status: string;
	reportedStatus: string | null;
	reportedSummary: string | null;
	result: string | null;
}

export interface EvolutionPreflightTaskContext {
	evidenceId: string;
	task: EvolutionPreflightTaskSummary;
}

export interface EvolutionPreflightWorkflowRunContext {
	evidenceIds: string[];
	run: SpaceWorkflowRun;
	tasks: EvolutionPreflightTaskSummary[];
	artifacts: Array<{
		id: string;
		runId: string;
		nodeId: string;
		artifactType: string;
		artifactKey: string;
		data: { summary: string };
		createdAt: number;
		updatedAt: number;
	}>;
}

export interface EvolutionEvidenceListResponse {
	evidence: EvidenceRef[];
	preflightContext?: {
		tasks: EvolutionPreflightTaskContext[];
		workflowRuns: EvolutionPreflightWorkflowRunContext[];
	};
}

export interface EvolutionEpisodeCreateRequest {
	params: CreateEvolutionEpisodeParams;
}

export interface EvolutionEpisodeCreateFromEvidenceRequest {
	scopeId: string;
	evidenceIds: string[];
	timeWindow?: EvolutionEpisode['timeWindow'];
	confirmLowConfidence?: boolean;
}

export interface EvolutionEpisodeCreateResponse {
	episode: EvolutionEpisode;
	lessons?: EvolutionLesson[];
	proposals?: TaskProposal[];
	preflight?: EvidenceQualityPreflight;
}

export interface EvolutionEpisodeReviewBundleResponse {
	episodes: EvolutionEpisode[];
	lessons: EvolutionLesson[];
	proposals: TaskProposal[];
}

export interface EvolutionEpisodeUpdateRequest {
	id: string;
	params: UpdateEvolutionEpisodeParams;
}

export interface EvolutionEpisodeUpdateResponse {
	episode: EvolutionEpisode | null;
}

export interface EvolutionEpisodeListRequest {
	scopeId: string;
}

export interface EvolutionEpisodeListResponse {
	episodes: EvolutionEpisode[];
}

export interface EvolutionLessonCreateRequest {
	params: CreateEvolutionLessonParams;
}

export interface EvolutionLessonCreateResponse {
	lesson: EvolutionLesson;
}

export interface EvolutionLessonUpdateRequest {
	id: string;
	params: UpdateEvolutionLessonParams;
}

export interface EvolutionLessonUpdateResponse {
	lesson: EvolutionLesson | null;
}

export interface EvolutionLessonListRequest {
	scopeId: string;
	status?: EvolutionLesson['status'];
}

export interface EvolutionLessonListResponse {
	lessons: EvolutionLesson[];
}

export interface EvolutionTaskLessonSelectRequest {
	taskId: string;
	limit?: number;
}

export interface EvolutionTaskLessonSelectResponse {
	lessons: EvolutionLesson[];
}

export interface EvolutionTaskProposalCreateRequest {
	params: CreateTaskProposalParams;
}

export interface EvolutionTaskProposalCreateResponse {
	proposal: TaskProposal;
}

export interface EvolutionTaskProposalUpdateRequest {
	id: string;
	params: UpdateTaskProposalParams;
}

export interface EvolutionTaskProposalUpdateResponse {
	proposal: TaskProposal | null;
}

export interface EvolutionTaskProposalListRequest {
	scopeId: string;
	status?: TaskProposal['status'];
}

export interface EvolutionTaskProposalListResponse {
	proposals: TaskProposal[];
}

export interface EvolutionTaskProposalCreateTaskRequest {
	id: string;
	params?: Partial<Pick<TaskProposal, 'title' | 'description' | 'reason' | 'priority'>> & {
		dependsOn?: string[];
	};
}

export interface EvolutionTaskProposalCreateTaskResponse {
	proposal: TaskProposal;
	task: SpaceTask;
}

export interface EvolutionRollupApplyRequest {
	episodeId: string;
	goalUpdate: Pick<UpdateSpaceGoalParams, 'summary' | 'progress' | 'nextSteps' | 'metrics'>;
}

export interface EvolutionRollupApplyResponse {
	episode: EvolutionEpisode;
	goal: SpaceGoal;
}

export interface EvolutionMetricSnapshotCreateRequest {
	params: CreateMetricSnapshotParams;
}

export interface EvolutionMetricSnapshotCreateResponse {
	snapshot: MetricSnapshot;
}

export interface EvolutionMetricSnapshotListRequest {
	scopeId: string;
}

export interface EvolutionMetricSnapshotListResponse {
	snapshots: MetricSnapshot[];
}

// --- MCP Imports (explicit refresh trigger for .mcp.json discovery) ---

export interface McpImportsRefreshRequest {
	/**
	 * Optional: limit the refresh scan to a single workspace path. When
	 * omitted, scans every registered workspace + `~/.claude/.mcp.json`.
	 */
	workspacePath?: string;
}

export interface McpImportsRefreshResponse {
	ok: boolean;
	/** Number of imported rows inserted or updated by this refresh. */
	imported: number;
	/** Number of imported rows removed because their source file no longer lists them. */
	removed: number;
	/** Human-readable notes (e.g. files not found, parse errors). */
	notes: string[];
}

// --- Output Format ---

export interface GetOutputFormatRequest {
	sessionId: string;
}

export interface GetOutputFormatResponse {
	outputFormat?: OutputFormatConfig;
}

export interface UpdateOutputFormatRequest {
	sessionId: string;
	outputFormat: OutputFormatConfig | null;
	restartQuery?: boolean;
}

export interface UpdateOutputFormatResponse {
	success: boolean;
	applied: boolean;
	error?: string;
	message?: string;
}

// --- Beta Features ---

export interface GetBetasConfigRequest {
	sessionId: string;
}

export interface GetBetasConfigResponse {
	betas: SdkBeta[];
}

export interface UpdateBetasConfigRequest {
	sessionId: string;
	betas: SdkBeta[];
	restartQuery?: boolean;
}

export interface UpdateBetasConfigResponse {
	success: boolean;
	applied: boolean;
	error?: string;
	message?: string;
}

// --- Environment Settings ---

export interface GetEnvConfigRequest {
	sessionId: string;
}

export interface GetEnvConfigResponse extends EnvironmentSettings {
	// Inherits: cwd, additionalDirectories, env, executable, executableArgs
}

export interface UpdateEnvConfigRequest {
	sessionId: string;
	settings: Partial<EnvironmentSettings>;
	restartQuery?: boolean;
}

export interface UpdateEnvConfigResponse {
	success: boolean;
	applied: boolean;
	error?: string;
	message?: string;
}

// --- Permissions ---

export interface GetPermissionsConfigRequest {
	sessionId: string;
}

export interface GetPermissionsConfigResponse {
	permissionMode?: PermissionMode;
	allowDangerouslySkipPermissions?: boolean;
}

export interface UpdatePermissionsConfigRequest {
	sessionId: string;
	permissionMode: PermissionMode;
}

export interface UpdatePermissionsConfigResponse {
	success: boolean;
	applied: boolean;
	error?: string;
}

// --- Bulk Configuration ---

export interface GetAllConfigRequest {
	sessionId: string;
}

export interface GetAllConfigResponse {
	config: SessionConfig;
}

export interface UpdateBulkConfigRequest {
	sessionId: string;
	config: Partial<SDKConfig>;
	restartQuery?: boolean;
}

export interface UpdateBulkConfigResponse extends ConfigUpdateResult {
	// Inherits: applied, pending, errors
}

// API client interface
export interface APIClient {
	// Sessions
	createSession(req: CreateSessionRequest): Promise<CreateSessionResponse>;
	listSessions(): Promise<ListSessionsResponse>;
	getSession(sessionId: string): Promise<GetSessionResponse>;
	updateSession(sessionId: string, req: UpdateSessionRequest): Promise<void>;
	deleteSession(sessionId: string): Promise<void>;
	setWorktreeMode(req: SetWorktreeModeRequest): Promise<SetWorktreeModeResponse>;

	// Messages
	sendMessage(sessionId: string, req: SendMessageRequest): Promise<SendMessageResponse>;
	clearMessages(sessionId: string): Promise<void>;

	// Files
	readFile(sessionId: string, req: ReadFileRequest): Promise<ReadFileResponse>;
	listFiles(sessionId: string, req: ListFilesRequest): Promise<ListFilesResponse>;
	getFileTree(sessionId: string, req: GetFileTreeRequest): Promise<GetFileTreeResponse>;

	// Tools
	listTools(): Promise<ListToolsResponse>;
	loadTools(sessionId: string, req: LoadToolsRequest): Promise<void>;
	unloadTools(sessionId: string, req: UnloadToolsRequest): Promise<void>;
	getActiveTools(sessionId: string): Promise<GetActiveToolsResponse>;

	// System
	health(): Promise<HealthStatus>;
	getConfig(): Promise<DaemonConfig>;
	updateConfig(req: UpdateConfigRequest): Promise<void>;

	// Authentication
	getAuthStatus(): Promise<GetAuthStatusResponse>;

	// Models
	getCurrentModel(sessionId: string): Promise<GetCurrentModelResponse>;
	switchModel(sessionId: string, model: string, provider: string): Promise<SwitchModelResponse>;

	// Providers
	listProviders(): Promise<ListProvidersResponse>;
	getSessionProvider(sessionId: string): Promise<GetSessionProviderResponse>;
	switchProvider(
		sessionId: string,
		provider: Provider,
		apiKey?: string
	): Promise<SwitchProviderResponse>;
}

// ============================================================================
// Provider API Types
// ============================================================================

export interface ListProvidersResponse {
	providers: ProviderInfo[];
}

export interface GetSessionProviderRequest {
	sessionId: string;
}

export interface GetSessionProviderResponse {
	provider: Provider;
	providerInfo: ProviderInfo | null;
}

export interface SwitchProviderRequest {
	sessionId: string;
	provider: Provider;
	/** Optional per-session API key (uses global env var if not provided) */
	apiKey?: string;
}

export interface SwitchProviderResponse {
	success: boolean;
	provider: Provider;
	error?: string;
	/** Warning about query restart requirement */
	warning?: string;
}

// ============================================================================
// SDK Session File Management API Types
// ============================================================================

/**
 * Information about an SDK session file in ~/.claude/projects/
 */
export interface SDKSessionFileInfo {
	path: string;
	sdkSessionId: string;
	kaiSessionIds: string[];
	size: number;
	modifiedAt: string; // ISO timestamp
}

/**
 * Information about an orphaned SDK session file
 */
export interface OrphanedSDKFileInfo extends SDKSessionFileInfo {
	reason: 'no-matching-session' | 'unknown-session';
}

/**
 * Request to scan SDK session files
 */
export interface SDKScanRequest {
	workspacePath: string;
}

/**
 * Response from sdk.scan RPC
 */
export interface SDKScanResponse {
	success: boolean;
	workspacePath: string;
	summary: {
		totalFiles: number;
		totalSize: number;
		orphanedFiles: number;
		orphanedSize: number;
	};
	files: SDKSessionFileInfo[];
	orphaned: OrphanedSDKFileInfo[];
}

/**
 * Request to cleanup SDK session files
 */
export interface SDKCleanupRequest {
	workspacePath: string;
	mode: 'archive' | 'delete';
	/** Optional: specific SDK session IDs to clean (cleans all if not provided) */
	sdkSessionIds?: string[];
}

/**
 * Response from sdk.cleanup RPC
 */
export interface SDKCleanupResponse {
	success: boolean;
	mode: 'archive' | 'delete';
	processedCount: number;
	totalSize: number;
	errors: string[];
}

// ---------------------------------------------------------------------------
// MCP Registry RPC types (mcp.registry.*)
//
// The *Response types below are intended for frontend (web) consumption — they
// are not imported by the daemon handlers (which use inline `satisfies`
// expressions).  They serve as a single source of truth for the shape callers
// can expect from each RPC endpoint.
// ---------------------------------------------------------------------------

export type { AppMcpServer, CreateAppMcpServerRequest, UpdateAppMcpServerRequest };

/** Response from mcp.registry.list */
export interface McpRegistryListResponse {
	servers: AppMcpServer[];
}

/** Response from mcp.registry.get */
export interface McpRegistryGetResponse {
	server: AppMcpServer;
}

/** Response from mcp.registry.create */
export interface McpRegistryCreateResponse {
	server: AppMcpServer;
}

/** Response from mcp.registry.update */
export interface McpRegistryUpdateResponse {
	server: AppMcpServer;
}

/** Request for mcp.registry.delete */
export interface McpRegistryDeleteRequest {
	id: string;
}

/** Response from mcp.registry.delete */
export interface McpRegistryDeleteResponse {
	success: boolean;
}

/** Request for mcp.registry.setEnabled */
export interface McpRegistrySetEnabledRequest {
	id: string;
	enabled: boolean;
}

/** Response from mcp.registry.setEnabled */
export interface McpRegistrySetEnabledResponse {
	server: AppMcpServer;
}

/**
 * A single startup/validation error for an MCP registry entry.
 * `serverId` matches the `id` field of AppMcpServer (mirrors McpStartupError in the daemon).
 */
export interface McpRegistryError {
	serverId: string;
	name: string;
	error: string;
}

/** Response from mcp.registry.listErrors */
export interface McpRegistryListErrorsResponse {
	errors: McpRegistryError[];
}

// ---------------------------------------------------------------------------
// Skills RPC types (skill.*)
//
// Request/Response types for the application-level Skills registry RPC methods.
// ---------------------------------------------------------------------------

export type { AppSkill, CreateSkillParams, UpdateSkillParams };

/** Request for skill.list */
export interface SkillListRequest {}

/** Response from skill.list */
export interface SkillListResponse {
	skills: AppSkill[];
}

/** Request for skill.get */
export interface SkillGetRequest {
	id: string;
}

/** Response from skill.get */
export interface SkillGetResponse {
	skill: AppSkill | null;
}

/** Request for skill.create */
export interface SkillCreateRequest {
	params: CreateSkillParams;
}

/** Response from skill.create */
export interface SkillCreateResponse {
	skill: AppSkill;
}

/** Request for skill.update */
export interface SkillUpdateRequest {
	id: string;
	params: UpdateSkillParams;
}

/** Response from skill.update */
export interface SkillUpdateResponse {
	skill: AppSkill;
}

/** Request for skill.delete */
export interface SkillDeleteRequest {
	id: string;
}

/** Response from skill.delete */
export interface SkillDeleteResponse {
	success: boolean;
}

/** Request for skill.setEnabled */
export interface SkillSetEnabledRequest {
	id: string;
	enabled: boolean;
}

/** Response from skill.setEnabled */
export interface SkillSetEnabledResponse {
	skill: AppSkill;
}
