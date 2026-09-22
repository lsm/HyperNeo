import type { CreateMetricSnapshotParams, EvidenceRef, EvolutionScope } from '@hyperneo/shared';
import type { EvolutionRepository } from '../../storage/repositories/evolution-repository.ts';
import type { JobQueueRepository } from '../../storage/repositories/job-queue-repository.ts';
import type { SpaceGoalRepository } from '../../storage/repositories/space-goal-repository.ts';
import type { SpaceRepository } from '../../storage/repositories/space-repository.ts';
import type { SpaceTaskRepository } from '../../storage/repositories/space-task-repository.ts';
import type { SpaceWorkflowRunRepository } from '../../storage/repositories/space-workflow-run-repository.ts';
import type { WorkflowRunArtifactRepository } from '../../storage/repositories/workflow-run-artifact-repository.ts';
import type { EvolutionTraceEvidenceService } from './trace-evidence-service.ts';
import type { TraceEvidenceDiagnostic } from './trace-evidence-types.ts';

export interface EvolutionScopeServiceDeps {
  evolutionRepo: EvolutionRepository;
  spaceRepo: SpaceRepository;
  goalRepo: SpaceGoalRepository;
  taskRepo: SpaceTaskRepository;
  workflowRunRepo: SpaceWorkflowRunRepository;
  artifactRepo?: WorkflowRunArtifactRepository;
  traceEvidenceService?: EvolutionTraceEvidenceService;
  jobQueue?: Pick<JobQueueRepository, 'enqueueUniquePending'>;
}

export interface ResolveScopeForGoalParams {
  spaceGoalId: string;
}

export interface AttachTaskEvidenceParams {
  scopeId?: string;
  taskId: string;
  summary?: string;
  metadata?: Record<string, unknown>;
}

export interface AttachWorkflowRunEvidenceParams {
  scopeId?: string;
  workflowRunId: string;
  summary?: string;
  metadata?: Record<string, unknown>;
}

export interface AddManualNoteEvidenceParams {
  scopeId: string;
  summary: string;
  metadata?: Record<string, unknown>;
  createdAt?: number;
}

export interface AddMetricSnapshotEvidenceParams {
  scopeId: string;
  values: CreateMetricSnapshotParams['values'];
  source: string;
  note?: string | null;
  capturedAt?: number;
  summary?: string;
  metadata?: Record<string, unknown>;
}

export interface ResolveScopeForTaskParams {
  taskId: string;
}

export interface SelectTaskLessonsParams {
  taskId: string;
  limit?: number;
}

export interface CaptureCompletedTaskEvidenceParams {
  taskId: string;
}

export interface CaptureCompletedTaskEvidenceResult {
  scope: EvolutionScope | null;
  evidence: EvidenceRef[];
  traceDiagnostic?: TraceEvidenceDiagnostic;
}
