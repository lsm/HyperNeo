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
  SessionMetadata,
  Tool,
  ToolBundle,
  CommitInfo,
  WorktreeCommitStatus,
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

export interface CreateSessionRequest {
  workspacePath?: string | null;
  initialTools?: string[];
  config?: Partial<SessionConfig>;
  worktreeBaseBranch?: string;
  worktreeMode?: 'worktree' | 'direct';
  title?: string;
  roomId?: string;
  spaceId?: string;
  createdBy?: 'human';
}

export interface CreateSessionResponse {
  sessionId: string;
  session?: Session;
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
  metadata?: Partial<SessionMetadata>;
}

export interface WorkspaceHistoryEntry {
  path: string;
  lastUsedAt: number;
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

export interface GitBranchesResponse {
  isGitRepo: boolean;
  gitRoot: string | null;
  currentBranch: string | null;
  defaultBranch: string | null;
  branches: string[];
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
  unstaged: boolean;
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

export interface GitSessionStatusResponse {
  sessionId: string;
  mode: GitSessionMode;
  isGitRepo: boolean;
  workspacePath: string | null;
  worktreePath: string | null;
  mainRepoPath: string | null;
  gitRoot: string | null;
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

export interface GitFileDiffRequest {
  sessionId: string;
  path: string;
}

export interface GitFileDiffResponse {
  sessionId: string;
  path: string;
  patch: string | null;
  truncated: boolean;
  additions: number;
  deletions: number;
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

export interface GetAuthStatusResponse {
  authStatus: AuthStatus;
}

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
  model: string;
  provider: string;
}

export interface SwitchModelResponse {
  success: boolean;
  model: string;
  error?: string;
}

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

export interface RuntimeMcpServerEntry {
  name: string;
}

export interface ListRuntimeMcpServersRequest {
  sessionId: string;
}

export interface ListRuntimeMcpServersResponse {
  servers: RuntimeMcpServerEntry[];
}

export interface SpaceMcpEntry {
  serverId: string;
  name: string;
  description?: string;
  sourceType: 'stdio' | 'sse' | 'http';
  source: 'builtin' | 'user' | 'imported';
  sourcePath?: string;
  globallyEnabled: boolean;
  overridden: boolean;
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
  limit?: number;
  offset?: number;
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
  limit?: number;
  offset?: number;
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
  limit?: number;
  offset?: number;
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
  limit?: number;
  offset?: number;
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
  limit?: number;
  offset?: number;
}

export interface EvolutionMetricSnapshotListResponse {
  snapshots: MetricSnapshot[];
}

export interface McpImportsRefreshRequest {
  workspacePath?: string;
}

export interface McpImportsRefreshResponse {
  ok: boolean;
  imported: number;
  removed: number;
  notes: string[];
}

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

export interface APIClient {
  createSession(req: CreateSessionRequest): Promise<CreateSessionResponse>;
  listSessions(): Promise<ListSessionsResponse>;
  getSession(sessionId: string): Promise<GetSessionResponse>;
  updateSession(sessionId: string, req: UpdateSessionRequest): Promise<void>;
  deleteSession(sessionId: string): Promise<void>;
  setWorktreeMode(req: SetWorktreeModeRequest): Promise<SetWorktreeModeResponse>;

  sendMessage(sessionId: string, req: SendMessageRequest): Promise<SendMessageResponse>;
  clearMessages(sessionId: string): Promise<void>;

  readFile(sessionId: string, req: ReadFileRequest): Promise<ReadFileResponse>;
  listFiles(sessionId: string, req: ListFilesRequest): Promise<ListFilesResponse>;
  getFileTree(sessionId: string, req: GetFileTreeRequest): Promise<GetFileTreeResponse>;

  listTools(): Promise<ListToolsResponse>;
  loadTools(sessionId: string, req: LoadToolsRequest): Promise<void>;
  unloadTools(sessionId: string, req: UnloadToolsRequest): Promise<void>;
  getActiveTools(sessionId: string): Promise<GetActiveToolsResponse>;

  health(): Promise<HealthStatus>;
  getConfig(): Promise<DaemonConfig>;
  updateConfig(req: UpdateConfigRequest): Promise<void>;

  getAuthStatus(): Promise<GetAuthStatusResponse>;

  getCurrentModel(sessionId: string): Promise<GetCurrentModelResponse>;
  switchModel(sessionId: string, model: string, provider: string): Promise<SwitchModelResponse>;

  listProviders(): Promise<ListProvidersResponse>;
  getSessionProvider(sessionId: string): Promise<GetSessionProviderResponse>;
  switchProvider(
    sessionId: string,
    provider: Provider,
    apiKey?: string
  ): Promise<SwitchProviderResponse>;
}

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
  apiKey?: string;
}

export interface SwitchProviderResponse {
  success: boolean;
  provider: Provider;
  error?: string;
  warning?: string;
}

export interface SDKSessionFileInfo {
  path: string;
  sdkSessionId: string;
  kaiSessionIds: string[];
  size: number;
  modifiedAt: string;
}

export interface OrphanedSDKFileInfo extends SDKSessionFileInfo {
  reason: 'no-matching-session' | 'unknown-session';
}

export interface SDKScanRequest {
  workspacePath: string;
}

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

export interface SDKCleanupRequest {
  workspacePath: string;
  mode: 'archive' | 'delete';
  sdkSessionIds?: string[];
}

export interface SDKCleanupResponse {
  success: boolean;
  mode: 'archive' | 'delete';
  processedCount: number;
  totalSize: number;
  errors: string[];
}

export type { AppMcpServer, CreateAppMcpServerRequest, UpdateAppMcpServerRequest };

export interface McpRegistryListResponse {
  servers: AppMcpServer[];
}

export interface McpRegistryGetResponse {
  server: AppMcpServer;
}

export interface McpRegistryCreateResponse {
  server: AppMcpServer;
}

export interface McpRegistryUpdateResponse {
  server: AppMcpServer;
}

export interface McpRegistryDeleteRequest {
  id: string;
}

export interface McpRegistryDeleteResponse {
  success: boolean;
}

export interface McpRegistrySetEnabledRequest {
  id: string;
  enabled: boolean;
}

export interface McpRegistrySetEnabledResponse {
  server: AppMcpServer;
}

export interface McpRegistryError {
  serverId: string;
  name: string;
  error: string;
}

export interface McpRegistryListErrorsResponse {
  errors: McpRegistryError[];
}

export type { AppSkill, CreateSkillParams, UpdateSkillParams };

export interface SkillListRequest {}

export interface SkillListResponse {
  skills: AppSkill[];
}

export interface SkillGetRequest {
  id: string;
}

export interface SkillGetResponse {
  skill: AppSkill | null;
}

export interface SkillCreateRequest {
  params: CreateSkillParams;
}

export interface SkillCreateResponse {
  skill: AppSkill;
}

export interface SkillUpdateRequest {
  id: string;
  params: UpdateSkillParams;
}

export interface SkillUpdateResponse {
  skill: AppSkill;
}

export interface SkillDeleteRequest {
  id: string;
}

export interface SkillDeleteResponse {
  success: boolean;
}

export interface SkillSetEnabledRequest {
  id: string;
  enabled: boolean;
}

export interface SkillSetEnabledResponse {
  skill: AppSkill;
}
