import type { EvidenceQualityPreflight, EvidenceRef } from './types/evolution.ts';

export interface EvidencePreflightTaskContext {
	title?: string | null;
	status?: string | null;
	reportedStatus?: string | null;
	reportedSummary?: string | null;
	result?: string | null;
}

export interface EvidencePreflightWorkflowRunContext {
	run?: {
		title?: string | null;
		status?: string | null;
		failureReason?: string | null;
	};
	tasks?: EvidencePreflightTaskContext[];
	artifacts?: Array<{
		type?: string | null;
		key?: string | null;
		data?: unknown;
	}>;
}

export interface EvidenceQualityScoreInput {
	evidence: EvidenceRef[];
	tasks?: EvidencePreflightTaskContext[];
	workflowRuns?: EvidencePreflightWorkflowRunContext[];
	metricSnapshotCount?: number;
}

const TASK_EVIDENCE_KINDS = new Set(['task', 'task_result']);
const WORKFLOW_ARTIFACT_EVIDENCE_KINDS = new Set(['workflow_run', 'artifact', 'error']);
const HIGH_CONFIDENCE_SCORE = 70;
const MEDIUM_CONFIDENCE_SCORE = 45;
const MAX_SCORE = 100;

const TASK_CONTEXT_SCORE = 30;
const WORKFLOW_ARTIFACT_SCORE = 30;
const METRIC_CONTEXT_SCORE = 15;
const NON_MANUAL_SCORE = 10;
const OUTCOME_SCORE = 8;
const MAX_OUTCOME_SCORE = 25;

const OUTCOME_PATTERNS: Array<[string, RegExp]> = [
	['pr', /\b(pr|pull request|github\.com\/[^\s]+\/pull\/)\b/],
	['qa', /\b(qa|quality assurance|validated|validation)\b/],
	['ci', /\b(ci|check|checks|build|test|tests|passed|failing|failed)\b/],
	['merge', /\b(merge|merged|landed)\b/],
	['error', /\b(error|failure|failed|exception|rework|regression)\b/],
	['task completion', /\b(done|completed|complete|approved|shipped)\b/],
];

export function scoreEvolutionEvidenceQuality(
	input: EvidenceQualityScoreInput
): EvidenceQualityPreflight {
	const evidence = input.evidence;
	const tasks = input.tasks ?? [];
	const workflowRuns = input.workflowRuns ?? [];
	const selectedMetricSnapshots = evidence.filter((item) => item.kind === 'metric_snapshot').length;
	const counts = {
		total: evidence.length,
		manualNotes: evidence.filter((item) => item.kind === 'manual_note').length,
		taskResults: evidence.filter((item) => TASK_EVIDENCE_KINDS.has(item.kind)).length,
		workflowArtifacts: evidence.filter((item) => WORKFLOW_ARTIFACT_EVIDENCE_KINDS.has(item.kind))
			.length,
		metricSnapshots: Math.max(
			selectedMetricSnapshots,
			(input.metricSnapshotCount ?? 0) > 0 ? 1 : 0
		),
		outcomes: countConcreteOutcomes(evidence, tasks, workflowRuns),
	};
	let score = 0;
	const reasons: string[] = [];
	const warnings: string[] = [];
	if (counts.taskResults > 0 || tasks.length > 0) {
		score += TASK_CONTEXT_SCORE;
		reasons.push('Selected evidence includes task context.');
	}
	if (
		counts.workflowArtifacts > 0 ||
		workflowRuns.some((run) => (run.artifacts ?? []).length > 0)
	) {
		score += WORKFLOW_ARTIFACT_SCORE;
		reasons.push('Selected evidence includes workflow run or artifact context.');
	}
	if (counts.metricSnapshots > 0) {
		score += METRIC_CONTEXT_SCORE;
		reasons.push('Metric snapshot context can calibrate outcomes.');
	}
	if (counts.outcomes > 0) {
		score += Math.min(MAX_OUTCOME_SCORE, counts.outcomes * OUTCOME_SCORE);
		reasons.push(
			'Evidence mentions concrete outcomes such as PR, QA, CI, merge, error, or completion.'
		);
	}
	if (counts.total > counts.manualNotes) {
		score += NON_MANUAL_SCORE;
	}
	const manualOnly = counts.total > 0 && counts.manualNotes === counts.total;
	if (manualOnly) {
		warnings.push(
			'Only manual notes selected; findings will be low confidence without task results or artifacts.'
		);
	}
	if (counts.taskResults === 0 && tasks.length === 0) {
		warnings.push('No task evidence selected.');
	}
	if (
		counts.workflowArtifacts === 0 &&
		workflowRuns.every((run) => (run.artifacts ?? []).length === 0)
	) {
		warnings.push('No workflow run or artifact evidence selected.');
	}
	if (counts.metricSnapshots === 0) {
		warnings.push('No metric snapshot context selected.');
	}
	if (counts.outcomes === 0) {
		warnings.push('No concrete PR, QA, CI, merge, error, or task-completion outcome found.');
	}
	const boundedScore = Math.min(MAX_SCORE, score);
	const level =
		boundedScore >= HIGH_CONFIDENCE_SCORE
			? 'high'
			: boundedScore >= MEDIUM_CONFIDENCE_SCORE
				? 'medium'
				: 'low';
	return {
		level,
		score: boundedScore,
		maxScore: MAX_SCORE,
		canGenerate: counts.total > 0,
		requiresConfirmation: manualOnly || level === 'low',
		reasons,
		warnings,
		counts,
	};
}

function countConcreteOutcomes(
	evidence: EvidenceRef[],
	tasks: EvidencePreflightTaskContext[],
	workflowRuns: EvidencePreflightWorkflowRunContext[]
): number {
	const seen = new Set<string>();
	const visit = (value: unknown) => {
		for (const token of extractOutcomeTokens(value)) {
			seen.add(token);
		}
	};
	for (const item of evidence) {
		visit(item.summary);
		visit(item.metadata);
		if (item.kind === 'error') seen.add('error');
	}
	for (const task of tasks) {
		visit(task.title);
		visit(task.status);
		visit(task.reportedStatus);
		visit(task.reportedSummary);
		visit(task.result);
		if (task.status === 'done' || task.status === 'approved') seen.add('task completion');
	}
	for (const { run, tasks: runTasks = [], artifacts = [] } of workflowRuns) {
		visit(run?.title);
		visit(run?.status);
		visit(run?.failureReason);
		for (const task of runTasks) {
			visit(task.title);
			visit(task.status);
			visit(task.reportedSummary);
			visit(task.result);
		}
		for (const artifact of artifacts) {
			visit(artifact.type);
			visit(artifact.key);
			visit(artifact.data);
		}
	}
	return seen.size;
}

function extractOutcomeTokens(value: unknown): string[] {
	const text = stringifyForOutcomeScan(value).toLowerCase();
	const tokens: string[] = [];
	for (const [token, pattern] of OUTCOME_PATTERNS) {
		if (pattern.test(text)) tokens.push(token);
	}
	return tokens;
}

function stringifyForOutcomeScan(value: unknown): string {
	if (value === null || value === undefined) return '';
	if (typeof value === 'string') return value;
	if (typeof value === 'number' || typeof value === 'boolean') return String(value);
	try {
		return JSON.stringify(value);
	} catch {
		return '';
	}
}
