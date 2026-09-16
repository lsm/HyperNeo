import { getWorkflowRunExecutionStatusLabel } from '@hyperneo/shared';
import type { EvidenceKind, SpaceTask, SpaceWorkflowRun } from '@hyperneo/shared';
import type { WorkflowRunArtifactRecord } from '../../storage/repositories/workflow-run-artifact-repository.ts';

export function buildTaskResultEvidenceSummary(task: SpaceTask): string {
  const outcome = task.result ?? task.reportedSummary ?? 'completed without task.result';
  return `Task #${task.taskNumber} done: ${task.title} — ${truncateText(outcome, 180)}`;
}

export function buildTaskResultEvidenceMetadata(task: SpaceTask): Record<string, unknown> {
  return {
    status: task.status,
    priority: task.priority,
    workflowRunId: task.workflowRunId ?? null,
    result: task.result ?? null,
    reportedSummary: task.reportedSummary ?? null,
    completedAt: task.completedAt ?? null,
  };
}

export function selectWorkflowEvidenceKind(
  run: SpaceWorkflowRun,
  artifacts: WorkflowRunArtifactRecord[]
): EvidenceKind {
  if (run.status === 'blocked' || run.status === 'cancelled') return 'error';
  return artifacts.length > 0 ? 'artifact' : 'workflow_run';
}

export function buildWorkflowRunEvidenceSummary(
  run: SpaceWorkflowRun,
  artifacts: WorkflowRunArtifactRecord[]
): string {
  const labels = summarizeArtifactTypes(artifacts);
  const detail =
    findArtifactDetail(artifacts) ?? activeFailureReason(run) ?? 'no artifacts captured';
  const statusLabel = getWorkflowRunExecutionStatusLabel(run.status);
  return `Workflow run ${statusLabel}: ${run.title} — ${labels.join(', ') || 'no artifact types'} — ${truncateText(detail, 180)}`;
}

function activeFailureReason(run: SpaceWorkflowRun): string | null {
  return run.status === 'blocked' || run.status === 'cancelled'
    ? (run.failureReason ?? null)
    : null;
}

export function summarizeArtifactTypes(artifacts: WorkflowRunArtifactRecord[]): string[] {
  return Array.from(new Set(artifacts.map((artifact) => artifact.artifactType))).sort();
}

export function summarizeArtifact(artifact: WorkflowRunArtifactRecord): Record<string, unknown> {
  return {
    nodeId: artifact.nodeId,
    type: artifact.artifactType,
    key: artifact.artifactKey,
    data: truncateStructuredData(artifact.data),
    createdAt: artifact.createdAt,
    updatedAt: artifact.updatedAt,
  };
}

function findArtifactDetail(artifacts: WorkflowRunArtifactRecord[]): string | null {
  for (const artifact of artifacts) {
    const detail = extractArtifactDetail(artifact.data);
    if (detail) return `${artifact.artifactType}/${artifact.artifactKey}: ${detail}`;
  }
  return null;
}

export function extractArtifactDetail(data: Record<string, unknown>): string | null {
  for (const key of [
    'url',
    'text',
    'recommendation',
    'summary',
    'result',
    'status',
    'pr_url',
    'review_url',
    'merge_commit',
    'error',
  ]) {
    const value = data[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function truncateStructuredData(value: Record<string, unknown>): Record<string, unknown> {
  const serialized = JSON.stringify(value);
  if (serialized.length <= 2000) return value;
  return { truncated: truncateText(serialized, 2000) };
}

function truncateText(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}
