import type {
  CreateEvolutionEpisodeParams,
  EvidenceRef,
  EvolutionFinding,
  EvolutionScope,
  SpaceTask,
  SpaceTaskStatus,
} from '@hyperneo/shared';
import { normalizeMeaningfulTaskResult } from '../space/task-result-utils.ts';
import type {
  EpisodeJudgePromptInput,
  EpisodeTaskContext,
  EpisodeWorkflowRunContext,
  EvolutionEpisodeServiceDeps,
} from './episode-service-types.ts';

const MAX_ARTIFACTS_PER_RUN = 8;
const TERMINAL_TASK_STATUSES = new Set<SpaceTaskStatus>(['done']);

type EvidenceCollectionDeps = Pick<
  EvolutionEpisodeServiceDeps,
  'taskRepo' | 'workflowRunRepo' | 'artifactRepo' | 'artifactProfile'
>;

export function collectTasks(
  deps: EvidenceCollectionDeps,
  scope: EvolutionScope,
  evidence: EvidenceRef[]
): EpisodeTaskContext[] {
  const seenTaskIds = new Set<string>();
  return evidence.flatMap((item) => {
    if (
      item.kind !== 'task' &&
      item.kind !== 'task_result' &&
      item.kind !== 'error_cluster' &&
      item.kind !== 'retry_loop' &&
      item.kind !== 'tool_failure' &&
      item.kind !== 'test_failure' &&
      item.kind !== 'permission_block' &&
      item.kind !== 'slow_tool_call' &&
      item.kind !== 'conversation_friction' &&
      item.kind !== 'friction_digest' &&
      item.kind !== 'verification_triage'
    )
      return [];
    if (!item.sourceId || seenTaskIds.has(item.sourceId)) return [];
    const task = deps.taskRepo.getTask(item.sourceId);
    if (!task) return [];
    if (task.spaceId !== scope.spaceId) {
      throw new Error(`Task and scope must belong to the same space: ${task.id}`);
    }
    seenTaskIds.add(task.id);
    return [{ evidenceId: item.id, task }];
  });
}

export function collectWorkflowRuns(
  deps: EvidenceCollectionDeps,
  scope: EvolutionScope,
  evidence: EvidenceRef[]
): EpisodeWorkflowRunContext[] {
  const seenRunIds = new Set<string>();
  return evidence.flatMap((item) => {
    if (item.kind !== 'workflow_run' && item.kind !== 'artifact' && item.kind !== 'error')
      return [];
    if (!item.sourceId) return [];
    const run = deps.workflowRunRepo.getRun(item.sourceId);
    if (!run) return [];
    if (run.spaceId !== scope.spaceId) {
      throw new Error(`Workflow run and scope must belong to the same space: ${run.id}`);
    }
    if (seenRunIds.has(run.id)) return [];
    seenRunIds.add(run.id);
    return [
      {
        evidenceId: item.id,
        run,
        tasks: deps.taskRepo.listByWorkflowRunIncludingArchived(run.id),
        artifacts: deps.artifactRepo.listByRun(run.id).slice(0, MAX_ARTIFACTS_PER_RUN),
      },
    ];
  });
}

export function detectResultArtifactGaps(
  deps: EvidenceCollectionDeps,
  input: EpisodeJudgePromptInput
): EvolutionFinding[] {
  const gaps: EvolutionFinding[] = [];
  const processedTaskIds = new Set<string>();
  const runHasResultArtifact = new Map<string, boolean>();

  const processTask = (task: SpaceTask, taskEvidenceId?: string) => {
    if (processedTaskIds.has(task.id)) return;
    processedTaskIds.add(task.id);
    const runId = task.workflowRunId;
    if (!runId) return;
    if (!TERMINAL_TASK_STATUSES.has(task.status)) return;
    if (normalizeMeaningfulTaskResult(task.result) !== null) return;

    let hasResultArtifact = runHasResultArtifact.get(runId);
    if (hasResultArtifact === undefined) {
      hasResultArtifact = deps.artifactProfile?.summarizeRunOutcome(runId) != null;
      runHasResultArtifact.set(runId, hasResultArtifact);
    }
    if (!hasResultArtifact) return;

    const runContext = input.workflowRuns.find((wr) => wr.run.id === runId);
    const evidence = taskEvidenceId ? [taskEvidenceId] : [];
    if (runContext && runContext.evidenceId !== taskEvidenceId) {
      evidence.push(runContext.evidenceId);
    }
    gaps.push({
      domain: 'hyperneo_product',
      kind: 'bug',
      impact: 'medium',
      confidence: 0.9,
      evidence,
      proposedAction: `Backfill task.result for "${task.title}" from the result artifact on workflow run ${runId}; the artifact exists but the task record has no result.`,
    });
  };

  for (const { evidenceId: taskEvidenceId, task } of input.tasks) {
    processTask(task, taskEvidenceId);
  }
  for (const { tasks, evidenceId: runEvidenceId } of input.workflowRuns) {
    for (const task of tasks) {
      processTask(task, runEvidenceId);
    }
  }
  return gaps;
}

export function deriveTimeWindow(
  evidence: EvidenceRef[]
): CreateEvolutionEpisodeParams['timeWindow'] {
  if (evidence.length === 0) return null;
  const times = evidence.map((item) => item.createdAt);
  return { start: Math.min(...times), end: Math.max(...times) };
}
