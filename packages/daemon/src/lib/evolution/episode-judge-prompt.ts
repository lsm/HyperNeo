import type { EpisodeJudgePromptInput } from './episode-service-types.ts';

const MAX_TEXT = 1200;

export function buildEpisodeJudgePrompt(input: EpisodeJudgePromptInput): string {
  return `You are Forge Episode Judge for HyperNeo.

Build a structured draft episode from scoped evidence. Focus on factual outcomes, product/workflow findings, candidate lessons, and follow-up proposals. Do not mutate anything.

Return ONLY valid JSON with this shape:
{
  "title": "short episode title",
  "outcomeSummary": "what happened and why it matters",
  "findings": [
    { "domain": "workflow|target_artifact|hyperneo_product", "kind": "friction|bug|optimization|missing_capability|new_opportunity", "impact": "low|medium|high", "confidence": 0.0, "evidence": ["evidence id or summary"], "proposedAction": "specific action" }
  ],
  "candidateLessons": [
    { "appliesTo": ["workflow|prompt|tool|ui"], "rule": "lesson candidate", "why": "supporting reason", "confidence": 0.0 }
  ],
  "proposals": [
    { "title": "task title", "description": "task body", "reason": "why now", "priority": "low|normal|high|urgent" }
  ]
}

Scope:
${JSON.stringify({ id: input.scope.id, name: input.scope.name, objective: input.scope.objective, metrics: input.scope.metricDefinitions, policy: input.scope.policy }, null, 2)}

Time window:
${JSON.stringify(input.timeWindow)}

Evidence quality preflight:
${JSON.stringify(input.preflight, null, 2)}

Use this evidence quality context to calibrate finding and lesson confidence. If preflight level is low, avoid high-confidence findings unless directly supported by concrete task, artifact, metric, CI, QA, PR, merge, or error data.

Selected evidence:
${JSON.stringify(
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
)}

Task results and summaries:
${JSON.stringify(
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
)}

Workflow run artifacts:
${JSON.stringify(
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
)}

Metric snapshots and manual notes:
${JSON.stringify({ metricSnapshots: input.metricSnapshots, manualNotes: input.evidence.filter((item) => item.kind === 'manual_note').map((item) => ({ id: item.id, summary: item.summary, metadata: truncate(JSON.stringify(item.metadata), MAX_TEXT), createdAt: item.createdAt })) }, null, 2)}

Existing accepted and candidate lessons in this scope (do not re-derive these):
${JSON.stringify(
  input.existingLessons.map((lesson) => ({
    status: lesson.status,
    appliesTo: lesson.appliesTo,
    rule: truncate(lesson.rule, MAX_TEXT),
    confidence: lesson.confidence,
  })),
  null,
  2
)}

Open proposals in this scope (do not duplicate these):
${JSON.stringify(
  input.existingProposals.map((proposal) => ({
    title: truncate(proposal.title, MAX_TEXT),
    description: truncate(proposal.description, MAX_TEXT),
    reason: truncate(proposal.reason, MAX_TEXT),
    status: proposal.status,
    priority: proposal.priority,
  })),
  null,
  2
)}

When generating candidate lessons and proposals, omit any that duplicate or substantially overlap with the items above.`;
}

export function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
