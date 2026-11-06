import { EVOLUTION_EPISODE_JUDGE_PROMPT, fillPrompt } from '@hyperneo/prompts';
import type { EpisodeJudgePromptInput } from './episode-service-types.ts';

const MAX_TEXT = 1200;

export function buildEpisodeJudgePrompt(input: EpisodeJudgePromptInput): string {
  return fillPrompt(EVOLUTION_EPISODE_JUDGE_PROMPT, {
    scope: JSON.stringify(
      {
        id: input.scope.id,
        name: input.scope.name,
        objective: input.scope.objective,
        metrics: input.scope.metricDefinitions,
        policy: input.scope.policy,
      },
      null,
      2
    ),
    time_window: JSON.stringify(input.timeWindow),
    preflight: JSON.stringify(input.preflight, null, 2),
    evidence: JSON.stringify(
      input.evidence.map((item) => ({
        id: item.id,
        kind: item.kind,
        summary: item.summary,
        sourceId: item.sourceId,
        metadata: truncate(JSON.stringify(item.metadata), MAX_TEXT),
        createdAt: item.createdAt,
      })),
      null,
      2
    ),
    tasks: JSON.stringify(
      input.tasks.map(({ evidenceId, task }) => ({
        evidenceId,
        id: task.id,
        number: task.taskNumber,
        title: task.title,
        status: task.status,
        reportedStatus: task.reportedStatus,
        reportedSummary: truncate(task.reportedSummary ?? '', MAX_TEXT),
        result: truncate(
          task.result ??
            (task.status === 'done' || task.status === 'blocked' ? task.reportedSummary : '') ??
            '',
          MAX_TEXT
        ),
      })),
      null,
      2
    ),
    workflow_runs: JSON.stringify(
      input.workflowRuns.map(({ evidenceId, run, tasks, artifacts }) => ({
        evidenceId,
        run: {
          id: run.id,
          title: run.title,
          status: run.status,
          failureReason: run.failureReason ?? null,
        },
        tasks: tasks.map((task) => ({
          id: task.id,
          title: task.title,
          status: task.status,
          reportedSummary: truncate(task.reportedSummary ?? '', 500),
          result: truncate(
            task.result ??
              (task.status === 'done' || task.status === 'blocked' ? task.reportedSummary : '') ??
              '',
            500
          ),
        })),
        artifacts: artifacts.map((artifact) => ({
          nodeId: artifact.nodeId,
          type: artifact.artifactType,
          key: artifact.artifactKey,
          data: truncate(JSON.stringify(artifact.data), MAX_TEXT),
        })),
      })),
      null,
      2
    ),
    metrics: JSON.stringify(
      {
        metricSnapshots: input.metricSnapshots,
        manualNotes: input.evidence
          .filter((item) => item.kind === 'manual_note')
          .map((item) => ({
            id: item.id,
            summary: item.summary,
            metadata: truncate(JSON.stringify(item.metadata), MAX_TEXT),
            createdAt: item.createdAt,
          })),
      },
      null,
      2
    ),
    lessons: JSON.stringify(
      input.existingLessons.map((lesson) => ({
        status: lesson.status,
        appliesTo: lesson.appliesTo,
        rule: truncate(lesson.rule, MAX_TEXT),
        confidence: lesson.confidence,
      })),
      null,
      2
    ),
    proposals: JSON.stringify(
      input.existingProposals.map((proposal) => ({
        title: truncate(proposal.title, MAX_TEXT),
        description: truncate(proposal.description, MAX_TEXT),
        reason: truncate(proposal.reason, MAX_TEXT),
        status: proposal.status,
        priority: proposal.priority,
      })),
      null,
      2
    ),
  });
}

export function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
