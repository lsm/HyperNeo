import type {
  EvidenceRef,
  EvolutionEvidenceListResponse,
  EvolutionPreflightTaskSummary,
  EvolutionScope,
  SpaceTask,
} from '@hyperneo/shared';
import type { EvolutionScopeServiceDeps } from './scope-service-types.ts';

const MAX_PREFLIGHT_ARTIFACTS_PER_RUN = 8;
const MAX_PREFLIGHT_ARTIFACT_TEXT = 500;

type PreflightContextDeps = Pick<
  EvolutionScopeServiceDeps,
  'taskRepo' | 'workflowRunRepo' | 'artifactRepo'
>;

export function buildPreflightContext(
  deps: PreflightContextDeps,
  scope: EvolutionScope,
  evidence: EvidenceRef[]
): NonNullable<EvolutionEvidenceListResponse['preflightContext']> {
  const taskEvidence = evidence.filter(
    (item) =>
      (item.kind === 'task' || item.kind === 'task_result' || item.kind === 'friction_digest') &&
      item.sourceId
  );
  const tasksById = new Map(
    deps.taskRepo
      .getTasksByIds(unique(taskEvidence.map((item) => item.sourceId as string)))
      .map((task) => [task.id, task])
  );
  const tasks = taskEvidence.flatMap((item) => {
    const task = tasksById.get(item.sourceId as string);
    if (!task || task.spaceId !== scope.spaceId) return [];
    return [{ evidenceId: item.id, task: summarizeTaskForPreflight(task) }];
  });

  const evidenceIdsByRunId = new Map<string, string[]>();
  for (const item of evidence) {
    if (item.kind !== 'workflow_run' && item.kind !== 'artifact' && item.kind !== 'error') {
      continue;
    }
    if (!item.sourceId) continue;
    const current = evidenceIdsByRunId.get(item.sourceId) ?? [];
    current.push(item.id);
    evidenceIdsByRunId.set(item.sourceId, current);
  }
  const runsById = new Map(
    deps.workflowRunRepo
      .getRunsByIds(unique([...evidenceIdsByRunId.keys()]))
      .filter((run) => run.spaceId === scope.spaceId)
      .map((run) => [run.id, run])
  );
  const validRunIds = unique([...evidenceIdsByRunId.keys()].filter((id) => runsById.has(id)));

  const tasksByRunId = bucketBy(
    deps.taskRepo.listByWorkflowRunIdsIncludingArchived(validRunIds),
    (task) => task.workflowRunId ?? ''
  );
  const artifactsByRunId = bucketBy(
    deps.artifactRepo?.listByRuns(validRunIds) ?? [],
    (artifact) => artifact.runId
  );

  const workflowRuns = Array.from(evidenceIdsByRunId.entries()).flatMap(([runId, evidenceIds]) => {
    const run = runsById.get(runId);
    if (!run) return [];
    return [
      {
        evidenceIds,
        run,
        tasks: (tasksByRunId.get(runId) ?? []).map(summarizeTaskForPreflight),
        artifacts: (artifactsByRunId.get(runId) ?? [])
          .slice(0, MAX_PREFLIGHT_ARTIFACTS_PER_RUN)
          .map((artifact) => ({
            id: artifact.id,
            runId: artifact.runId,
            nodeId: artifact.nodeId,
            artifactType: artifact.artifactType,
            artifactKey: artifact.artifactKey,
            data: { summary: summarizeArtifactData(artifact.data) },
            createdAt: artifact.createdAt,
            updatedAt: artifact.updatedAt,
          })),
      },
    ];
  });
  return { tasks, workflowRuns };
}

function summarizeTaskForPreflight(task: SpaceTask): EvolutionPreflightTaskSummary {
  return {
    title: task.title,
    status: task.status,
    reportedStatus: task.reportedStatus ?? null,
    reportedSummary: task.reportedSummary ?? null,
    result: task.result ?? null,
  };
}

function summarizeArtifactData(data: Record<string, unknown>): string {
  const text = stringifyArtifactField(data);
  return text.length > MAX_PREFLIGHT_ARTIFACT_TEXT
    ? `${text.slice(0, MAX_PREFLIGHT_ARTIFACT_TEXT)}…`
    : text;
}

function stringifyArtifactField(value: unknown): string {
  return typeof value === 'string' ? value : (JSON.stringify(value) ?? '');
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value);
      out.push(value);
    }
  }
  return out;
}

function bucketBy<T>(items: T[], keyOf: (item: T) => string): Map<string, T[]> {
  const buckets = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(item);
    else buckets.set(key, [item]);
  }
  return buckets;
}
