import type { SpaceTaskPriority } from './space.ts';

export type EvolutionScopeKind = 'mission' | 'project' | 'campaign' | 'workflow' | 'custom';
export type EvidenceKind =
  | 'task'
  | 'workflow_run'
  | 'session'
  | 'manual_note'
  | 'metric_snapshot'
  | 'task_result'
  | 'artifact'
  | 'error'
  | 'daemon_error'
  | 'runtime_crash'
  | 'runtime_warning'
  | 'uncaught_exception'
  | 'error_cluster'
  | 'retry_loop'
  | 'tool_failure'
  | 'test_failure'
  | 'permission_block'
  | 'slow_tool_call'
  | 'conversation_friction'
  | 'friction_digest'
  | 'verification_triage';
export type EvolutionEpisodeStatus = 'draft' | 'accepted' | 'dismissed';
export type EvolutionLessonStatus = 'candidate' | 'active' | 'dismissed';
export type TaskProposalStatus = 'proposed' | 'accepted' | 'dismissed' | 'created';
export type MetricDirection = 'increase' | 'decrease' | 'target' | 'maintain';
export type EvolutionFindingDomain = 'workflow' | 'target_artifact' | 'hyperneo_product';
export type EvolutionFindingKind =
  | 'friction'
  | 'bug'
  | 'optimization'
  | 'missing_capability'
  | 'new_opportunity';
export type EvolutionImpact = 'low' | 'medium' | 'high';
export type GoalForgeAutomationTriggerKind =
  | 'completed_task_threshold'
  | 'self_nag'
  | 'external_event';

export interface GoalForgeAutomationEventSubscription {
  topic: string;
  source?: string;
  filter?: Record<string, string | number | boolean | null>;
}

export interface GoalForgeAutomationPolicy {
  completedTaskThreshold?: number;
  completedTaskAutomationEnabled?: boolean;
  selfNagCronExpression?: string;
  selfNagTimezone?: string;
  eventSubscriptions?: GoalForgeAutomationEventSubscription[];
  maxEvidencePerEpisode?: number;
}

export interface EvolutionPolicy extends Record<string, unknown> {
  episodeJudgeModel?: string;
  episodeJudgeProvider?: string;
  automation?: GoalForgeAutomationPolicy;
}
export type MetricSnapshotValues = Record<string, string | number | boolean | null>;

export interface MetricDefinition {
  key: string;
  label: string;
  description?: string;
  direction: MetricDirection;
  targetValue?: number | string | boolean | null;
  unit?: string;
}

export interface EvolutionScope {
  id: string;
  spaceId: string;
  spaceGoalId: string | null;
  kind: EvolutionScopeKind;
  name: string;
  objective: string;
  parentScopeId: string | null;
  metricDefinitions: MetricDefinition[];
  policy: EvolutionPolicy;
  createdAt: number;
  updatedAt: number;
}

export interface CreateEvolutionScopeParams {
  spaceId: string;
  spaceGoalId?: string | null;
  kind: EvolutionScopeKind;
  name: string;
  objective: string;
  parentScopeId?: string | null;
  metricDefinitions?: MetricDefinition[];
  policy?: EvolutionPolicy;
}

export interface UpdateEvolutionScopeParams {
  spaceGoalId?: string | null;
  kind?: EvolutionScopeKind;
  name?: string;
  objective?: string;
  parentScopeId?: string | null;
  metricDefinitions?: MetricDefinition[];
  policy?: EvolutionPolicy;
  policyPatch?: EvolutionPolicy;
}

export interface EvidenceRef {
  id: string;
  scopeId: string;
  kind: EvidenceKind;
  summary: string;
  sourceId: string | null;
  metadata: Record<string, unknown>;
  createdAt: number;
}

export interface CreateEvidenceRefParams {
  scopeId: string;
  kind: EvidenceKind;
  summary: string;
  sourceId?: string | null;
  metadata?: Record<string, unknown>;
  createdAt?: number;
}

export type EvidenceQualityLevel = 'low' | 'medium' | 'high';

export type EvidenceArtifactDiagnosticsStatus = 'selected' | 'available_omitted' | 'none_available';

export interface EvidenceArtifactDiagnostics {
  status: EvidenceArtifactDiagnosticsStatus;
  availableKinds: string[];
  omittedCount: number;
  recommendations: string[];
}

export interface EvidenceQualityPreflight {
  level: EvidenceQualityLevel;
  score: number;
  maxScore: number;
  canGenerate: boolean;
  requiresConfirmation: boolean;
  reasons: string[];
  warnings: string[];
  counts: {
    total: number;
    manualNotes: number;
    taskResults: number;
    workflowArtifacts: number;
    metricSnapshots: number;
    outcomes: number;
  };
  artifactDiagnostics: EvidenceArtifactDiagnostics;
}

export interface EvolutionFinding {
  domain: EvolutionFindingDomain;
  kind: EvolutionFindingKind;
  impact: EvolutionImpact;
  confidence: number;
  evidence: string[];
  proposedAction: string;
}

export interface EvolutionEpisodeTimeWindow {
  start: number;
  end: number;
}

export interface EvolutionEpisode {
  id: string;
  scopeId: string;
  status: EvolutionEpisodeStatus;
  rollupAppliedAt: number | null;
  title: string;
  timeWindow: EvolutionEpisodeTimeWindow | null;
  evidenceIds: string[];
  outcomeSummary: string;
  findings: EvolutionFinding[];
  createdAt: number;
  updatedAt: number;
}

export interface CreateEvolutionEpisodeParams {
  scopeId: string;
  status?: EvolutionEpisodeStatus;
  title: string;
  timeWindow?: EvolutionEpisodeTimeWindow | null;
  evidenceIds?: string[];
  outcomeSummary?: string;
  findings?: EvolutionFinding[];
}

export interface UpdateEvolutionEpisodeParams {
  status?: EvolutionEpisodeStatus;
  rollupAppliedAt?: number | null;
  title?: string;
  timeWindow?: EvolutionEpisodeTimeWindow | null;
  evidenceIds?: string[];
  outcomeSummary?: string;
  findings?: EvolutionFinding[];
}

export interface EvolutionLesson {
  id: string;
  scopeId: string;
  status: EvolutionLessonStatus;
  appliesTo: string[];
  rule: string;
  why: string;
  evidenceEpisodeIds: string[];
  confidence: number;
  createdAt: number;
  updatedAt: number;
}

export interface CreateEvolutionLessonParams {
  scopeId: string;
  status?: EvolutionLessonStatus;
  appliesTo?: string[];
  rule: string;
  why: string;
  evidenceEpisodeIds?: string[];
  confidence?: number;
}

export interface UpdateEvolutionLessonParams {
  status?: EvolutionLessonStatus;
  appliesTo?: string[];
  rule?: string;
  why?: string;
  evidenceEpisodeIds?: string[];
  confidence?: number;
}

export interface TaskProposal {
  id: string;
  scopeId: string;
  title: string;
  description: string;
  reason: string;
  priority: SpaceTaskPriority;
  status: TaskProposalStatus;
  evidenceEpisodeIds: string[];
  createdTaskId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface CreateTaskProposalParams {
  scopeId: string;
  title: string;
  description: string;
  reason: string;
  priority?: SpaceTaskPriority;
  status?: TaskProposalStatus;
  evidenceEpisodeIds?: string[];
  createdTaskId?: string | null;
}

export interface UpdateTaskProposalParams {
  title?: string;
  description?: string;
  reason?: string;
  priority?: SpaceTaskPriority;
  status?: TaskProposalStatus;
  evidenceEpisodeIds?: string[];
  createdTaskId?: string | null;
}

export interface MetricSnapshot {
  id: string;
  scopeId: string;
  capturedAt: number;
  values: MetricSnapshotValues;
  source: string;
  note: string | null;
  createdAt: number;
}

export interface CreateMetricSnapshotParams {
  scopeId: string;
  capturedAt?: number;
  values: MetricSnapshotValues;
  source: string;
  note?: string | null;
}

export interface EvolutionScopeListParams {
  spaceId: string;
  spaceGoalId?: string | null;
  kind?: EvolutionScopeKind;
  limit?: number;
  offset?: number;
}

export interface EvolutionListPagination {
  limit?: number;
  offset?: number;
}
