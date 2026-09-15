import type { Database as BunDatabase } from '../../storage/sqlite-compat.ts';
import type {
  CreateEvolutionEpisodeParams,
  CreateEvolutionLessonParams,
  CreateTaskProposalParams,
  EvidenceQualityPreflight,
  EvidenceRef,
  EvolutionEpisode,
  EvolutionFinding,
  EvolutionLesson,
  EvolutionScope,
  SpaceTaskPriority,
  MetricSnapshot,
  SpaceGoal,
  SpaceTask,
  TaskProposal,
} from '@hyperneo/shared';
import type { EvolutionRepository } from '../../storage/repositories/evolution-repository.ts';
import type { SpaceRepository } from '../../storage/repositories/space-repository.ts';
import type { SpaceTaskRepository } from '../../storage/repositories/space-task-repository.ts';
import type { SpaceWorkflowRunRepository } from '../../storage/repositories/space-workflow-run-repository.ts';
import type {
  WorkflowRunArtifactRecord,
  WorkflowRunArtifactRepository,
} from '../../storage/repositories/workflow-run-artifact-repository.ts';
import type { SpaceGoalService } from '../goals/service.ts';
import type { WorkflowArtifactProfile } from '../space/runtime/artifact-profile.ts';

export interface CreateEpisodeFromEvidenceParams {
  scopeId: string;
  evidenceIds: string[];
  timeWindow?: CreateEvolutionEpisodeParams['timeWindow'];
  confirmLowConfidence?: boolean;
}

export interface CreateEpisodeFromEvidenceResult {
  episode: EvolutionEpisode;
  lessons: EvolutionLesson[];
  proposals: TaskProposal[];
  preflight: EvidenceQualityPreflight;
}

export interface EpisodeReviewBundle {
  episodes: EvolutionEpisode[];
  lessons: EvolutionLesson[];
  proposals: TaskProposal[];
}

export interface CreateTaskFromProposalParams {
  title?: string;
  description?: string;
  reason?: string;
  priority?: SpaceTaskPriority;
  dependsOn?: string[];
}

export interface CreateTaskFromProposalResult {
  proposal: TaskProposal;
  task: SpaceTask;
}

export interface ApplyRollupGoalUpdateParams {
  episodeId: string;
  goalUpdate: {
    summary?: string;
    progress?: number;
    nextSteps?: string[];
    metrics?: Record<string, string | number | boolean | null>;
  };
}

export interface ApplyRollupGoalUpdateResult {
  episode: EvolutionEpisode;
  goal: SpaceGoal;
}

export interface EvolutionEpisodeServiceDeps {
  evolutionRepo: EvolutionRepository;
  spaceRepo?: Pick<SpaceRepository, 'getSpace'>;
  taskRepo: SpaceTaskRepository;
  workflowRunRepo: SpaceWorkflowRunRepository;
  artifactRepo: WorkflowRunArtifactRepository;
  artifactProfile?: WorkflowArtifactProfile;
  goalService?: Pick<SpaceGoalService, 'getGoal' | 'updateGoal'>;
  taskIdFactory?: () => string;
  db?: BunDatabase;
  taskCreatedEventHub?: {
    publish: (event: string, data: Record<string, unknown>) => Promise<unknown>;
  };
  judgeEpisode?: (input: EpisodeJudgePromptInput) => Promise<EpisodeJudgeOutput>;
}

export interface EpisodeJudgePromptInput {
  scope: EvolutionScope;
  evidence: EvidenceRef[];
  metricSnapshots: MetricSnapshot[];
  tasks: EpisodeTaskContext[];
  workflowRuns: EpisodeWorkflowRunContext[];
  timeWindow: CreateEvolutionEpisodeParams['timeWindow'];
  preflight: EvidenceQualityPreflight;
  existingLessons: EvolutionLesson[];
  existingProposals: TaskProposal[];
}

export interface EpisodeTaskContext {
  evidenceId: string;
  task: SpaceTask;
}

export interface EpisodeWorkflowRunContext {
  evidenceId: string;
  run: NonNullable<ReturnType<SpaceWorkflowRunRepository['getRun']>>;
  tasks: SpaceTask[];
  artifacts: WorkflowRunArtifactRecord[];
}

export interface EpisodeJudgeOutput {
  title: string;
  outcomeSummary: string;
  findings: EvolutionFinding[];
  candidateLessons?: Array<Omit<CreateEvolutionLessonParams, 'scopeId' | 'evidenceEpisodeIds'>>;
  proposals?: Array<Omit<CreateTaskProposalParams, 'scopeId' | 'evidenceEpisodeIds'>>;
}
