import type {
  AuthStatus,
  Session,
  SessionConfig,
  SessionMetadata,
  CommitInfo,
  WorktreeCommitStatus,
} from './types.ts';
import type { AppMcpServer } from './types/app-mcp-server.ts';
import type { SessionToolInventory } from './types/observed-tool-inventory.ts';
import type {
  CreateEvolutionScopeParams,
  CreateMetricSnapshotParams,
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
  createdBy?: 'human';
}

export interface CreateSessionResponse {
  sessionId: string;
  session?: Session;
}

export interface ListSessionsResponse {
  sessions: Session[];
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
  project?: { id: string; name: string; folders: string[] };
}

export interface WorkspaceHistoryResponse {
  entries: WorkspaceHistoryEntry[];
}

export interface WorkspaceAddResponse {
  entry: WorkspaceHistoryEntry;
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

export interface GitFileDiffResponse {
  sessionId: string;
  path: string;
  patch: string | null;
  truncated: boolean;
  additions: number;
  deletions: number;
  error?: string;
}

export type CloneChildrenChoice = 'cascade' | 'flatten';

export interface CloneSummary {
  id: string;
  title: string;
}

export interface ArchiveSessionResponse {
  success: boolean;
  requiresConfirmation?: boolean;
  commitStatus?: WorktreeCommitStatus;
  commitsRemoved?: number;
  reason?: 'has_clones' | 'agent_primary_session';
  clones?: CloneSummary[];
  agentName?: string;
}

export interface DeleteSessionResponse {
  success: boolean;
  reason?: 'has_clones' | 'agent_primary_session';
  clones?: CloneSummary[];
  agentName?: string;
}

export interface GetAuthStatusResponse {
  authStatus: AuthStatus;
}

export interface RuntimeMcpServerEntry {
  name: string;
}

export interface ListRuntimeMcpServersRequest {
  sessionId: string;
}

export interface GetSessionToolInventoryRequest {
  sessionId: string;
}

export type GetSessionToolInventoryResponse = SessionToolInventory;

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

export interface EvolutionTaskProposalUpdateRequest {
  id: string;
  params: UpdateTaskProposalParams;
}

export interface EvolutionTaskProposalUpdateResponse {
  proposal: TaskProposal | null;
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

export interface McpRegistryListResponse {
  servers: AppMcpServer[];
}

export interface McpRegistryCreateResponse {
  server: AppMcpServer;
}

export interface McpRegistryUpdateResponse {
  server: AppMcpServer;
}

export interface McpRegistryDeleteResponse {
  success: boolean;
}

export interface McpRegistrySetEnabledResponse {
  server: AppMcpServer;
}
