import type {
	CreateEvolutionEpisodeParams,
	CreateEvolutionLessonParams,
	CreateTaskProposalParams,
	EvidenceRef,
	EvolutionEpisode,
	EvolutionFinding,
	EvolutionFindingDomain,
	EvolutionFindingKind,
	EvolutionImpact,
	EvolutionLesson,
	EvolutionLessonStatus,
	EvolutionScope,
	SpaceTaskPriority,
	MetricSnapshot,
	SpaceTask,
	TaskProposal,
	TaskProposalStatus,
	UpdateEvolutionEpisodeParams,
	UpdateEvolutionLessonParams,
	UpdateTaskProposalParams,
} from '@neokai/shared';
import type { EvolutionRepository } from '../../storage/repositories/evolution-repository';
import type { SpaceTaskRepository } from '../../storage/repositories/space-task-repository';
import type { SpaceWorkflowRunRepository } from '../../storage/repositories/space-workflow-run-repository';
import type {
	WorkflowRunArtifactRecord,
	WorkflowRunArtifactRepository,
} from '../../storage/repositories/workflow-run-artifact-repository';
import { isRunningUnderBun, resolveSDKCliPath } from '../agent/sdk-cli-resolver';
import { Logger } from '../logger';
import { getProviderService, mergeProviderEnvVars } from '../provider-service';

const log = new Logger('evolution-episode-service');

const FINDING_DOMAINS: EvolutionFindingDomain[] = ['workflow', 'target_artifact', 'neokai_product'];
const FINDING_KINDS: EvolutionFindingKind[] = [
	'friction',
	'bug',
	'optimization',
	'missing_capability',
	'new_opportunity',
];
const IMPACTS: EvolutionImpact[] = ['low', 'medium', 'high'];
const LESSON_STATUSES: EvolutionLessonStatus[] = ['candidate', 'active', 'dismissed'];
const PROPOSAL_STATUSES: TaskProposalStatus[] = ['proposed', 'accepted', 'dismissed', 'created'];
const PRIORITIES: SpaceTaskPriority[] = ['low', 'normal', 'high', 'urgent'];
const MAX_TEXT = 1200;
const MAX_ARTIFACTS_PER_RUN = 8;

export interface CreateEpisodeFromEvidenceParams {
	scopeId: string;
	evidenceIds: string[];
	timeWindow?: CreateEvolutionEpisodeParams['timeWindow'];
}

export interface CreateEpisodeFromEvidenceResult {
	episode: EvolutionEpisode;
	lessons: EvolutionLesson[];
	proposals: TaskProposal[];
}

export interface EpisodeReviewBundle {
	episodes: EvolutionEpisode[];
	lessons: EvolutionLesson[];
	proposals: TaskProposal[];
}

export interface EvolutionEpisodeServiceDeps {
	evolutionRepo: EvolutionRepository;
	taskRepo: SpaceTaskRepository;
	workflowRunRepo: SpaceWorkflowRunRepository;
	artifactRepo: WorkflowRunArtifactRepository;
	judgeEpisode?: (input: EpisodeJudgePromptInput) => Promise<EpisodeJudgeOutput>;
}

export interface EpisodeJudgePromptInput {
	scope: EvolutionScope;
	evidence: EvidenceRef[];
	metricSnapshots: MetricSnapshot[];
	tasks: EpisodeTaskContext[];
	workflowRuns: EpisodeWorkflowRunContext[];
	timeWindow: CreateEvolutionEpisodeParams['timeWindow'];
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

export class EvolutionEpisodeService {
	constructor(private deps: EvolutionEpisodeServiceDeps) {}

	async createFromEvidence(
		params: CreateEpisodeFromEvidenceParams
	): Promise<CreateEpisodeFromEvidenceResult> {
		const input = this.buildEpisodeInput(params);
		const judged = this.deps.judgeEpisode
			? await this.deps.judgeEpisode(input)
			: await judgeEpisodeWithModel(input);
		const episode = this.deps.evolutionRepo.createEpisode({
			scopeId: input.scope.id,
			status: 'draft',
			title: judged.title,
			timeWindow: input.timeWindow,
			evidenceIds: input.evidence.map((item) => item.id),
			outcomeSummary: judged.outcomeSummary,
			findings: judged.findings,
		});
		const lessons = (judged.candidateLessons ?? []).map((lesson) =>
			this.deps.evolutionRepo.createLesson({
				...lesson,
				scopeId: input.scope.id,
				status: lesson.status ?? 'candidate',
				evidenceEpisodeIds: [episode.id],
			})
		);
		const proposals = (judged.proposals ?? []).map((proposal) =>
			this.deps.evolutionRepo.createTaskProposal({
				...proposal,
				scopeId: input.scope.id,
				status: proposal.status ?? 'proposed',
				evidenceEpisodeIds: [episode.id],
			})
		);
		return { episode, lessons, proposals };
	}

	buildEpisodeInput(params: CreateEpisodeFromEvidenceParams): EpisodeJudgePromptInput {
		const scope = this.requireScope(params.scopeId);
		const requestedIds = new Set(params.evidenceIds);
		if (requestedIds.size === 0) throw new Error('evidenceIds is required');
		const evidence = this.deps.evolutionRepo
			.listEvidence(params.scopeId)
			.filter((item) => requestedIds.has(item.id));
		if (evidence.length !== requestedIds.size) {
			throw new Error('All evidenceIds must belong to the scope');
		}
		const tasks = this.collectTasks(scope, evidence);
		const workflowRuns = this.collectWorkflowRuns(scope, evidence);
		return {
			scope,
			evidence,
			metricSnapshots: this.deps.evolutionRepo.listMetricSnapshots(scope.id),
			tasks,
			workflowRuns,
			timeWindow: params.timeWindow ?? deriveTimeWindow(evidence),
		};
	}

	listEpisodes(scopeId: string): EvolutionEpisode[] {
		this.requireScope(scopeId);
		return this.deps.evolutionRepo.listEpisodes(scopeId);
	}

	getEpisode(id: string): EvolutionEpisode | null {
		return this.deps.evolutionRepo.getEpisode(id);
	}

	createEpisode(params: CreateEvolutionEpisodeParams): EvolutionEpisode {
		this.requireScope(params.scopeId);
		return this.deps.evolutionRepo.createEpisode(params);
	}

	updateEpisode(id: string, params: UpdateEvolutionEpisodeParams): EvolutionEpisode | null {
		return this.deps.evolutionRepo.updateEpisode(id, params);
	}

	listReviewBundle(scopeId: string): EpisodeReviewBundle {
		this.requireScope(scopeId);
		return {
			episodes: this.deps.evolutionRepo.listEpisodes(scopeId),
			lessons: this.deps.evolutionRepo.listLessons(scopeId),
			proposals: this.deps.evolutionRepo.listTaskProposals(scopeId),
		};
	}

	listLessons(scopeId: string, status?: EvolutionLessonStatus): EvolutionLesson[] {
		this.requireScope(scopeId);
		return this.deps.evolutionRepo.listLessons(scopeId, status);
	}

	updateLesson(id: string, params: UpdateEvolutionLessonParams): EvolutionLesson | null {
		return this.deps.evolutionRepo.updateLesson(id, params);
	}

	listTaskProposals(scopeId: string, status?: TaskProposalStatus): TaskProposal[] {
		this.requireScope(scopeId);
		return this.deps.evolutionRepo.listTaskProposals(scopeId, status);
	}

	updateTaskProposal(id: string, params: UpdateTaskProposalParams): TaskProposal | null {
		return this.deps.evolutionRepo.updateTaskProposal(id, params);
	}

	private collectTasks(scope: EvolutionScope, evidence: EvidenceRef[]): EpisodeTaskContext[] {
		return evidence.flatMap((item) => {
			if (item.kind !== 'task' || !item.sourceId) return [];
			const task = this.deps.taskRepo.getTask(item.sourceId);
			if (!task) return [];
			if (task.spaceId !== scope.spaceId) {
				throw new Error(`Task and scope must belong to the same space: ${task.id}`);
			}
			return [{ evidenceId: item.id, task }];
		});
	}

	private collectWorkflowRuns(
		scope: EvolutionScope,
		evidence: EvidenceRef[]
	): EpisodeWorkflowRunContext[] {
		return evidence.flatMap((item) => {
			if (item.kind !== 'workflow_run' || !item.sourceId) return [];
			const run = this.deps.workflowRunRepo.getRun(item.sourceId);
			if (!run) return [];
			if (run.spaceId !== scope.spaceId) {
				throw new Error(`Workflow run and scope must belong to the same space: ${run.id}`);
			}
			return [
				{
					evidenceId: item.id,
					run,
					tasks: this.deps.taskRepo.listByWorkflowRunIncludingArchived(run.id),
					artifacts: this.deps.artifactRepo.listByRun(run.id).slice(0, MAX_ARTIFACTS_PER_RUN),
				},
			];
		});
	}

	private requireScope(scopeId: string): EvolutionScope {
		if (!scopeId) throw new Error('scopeId is required');
		const scope = this.deps.evolutionRepo.getScope(scopeId);
		if (!scope) throw new Error(`EvolutionScope not found: ${scopeId}`);
		return scope;
	}
}

export function buildEpisodeJudgePrompt(input: EpisodeJudgePromptInput): string {
	return `You are Forge Episode Judge for NeoKai.

Build a structured draft episode from scoped evidence. Focus on factual outcomes, product/workflow findings, candidate lessons, and follow-up proposals. Do not mutate anything.

Return ONLY valid JSON with this shape:
{
  "title": "short episode title",
  "outcomeSummary": "what happened and why it matters",
  "findings": [
    { "domain": "workflow|target_artifact|neokai_product", "kind": "friction|bug|optimization|missing_capability|new_opportunity", "impact": "low|medium|high", "confidence": 0.0, "evidence": ["evidence id or summary"], "proposedAction": "specific action" }
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

Selected evidence:
${JSON.stringify(
	input.evidence.map((item) => ({
		id: item.id,
		kind: item.kind,
		summary: item.summary,
		sourceId: item.sourceId,
		metadata: item.metadata,
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
		result: truncate(task.result ?? '', MAX_TEXT),
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
			result: truncate(task.result ?? '', 500),
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
${JSON.stringify({ metricSnapshots: input.metricSnapshots, manualNotes: input.evidence.filter((item) => item.kind === 'manual_note').map((item) => ({ id: item.id, summary: item.summary, metadata: item.metadata, createdAt: item.createdAt })) }, null, 2)}`;
}

export function parseEpisodeJudgeJson(raw: string): EpisodeJudgeOutput {
	let text = raw.trim();
	const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
	if (fenced?.[1]) {
		text = fenced[1].trim();
	} else {
		const start = text.indexOf('{');
		const end = text.lastIndexOf('}');
		if (start >= 0 && end > start) text = text.slice(start, end + 1);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (err) {
		throw new Error(
			`Episode judge returned invalid JSON: ${err instanceof Error ? err.message : String(err)}`
		);
	}
	return normalizeJudgeOutput(parsed);
}

async function judgeEpisodeWithModel(input: EpisodeJudgePromptInput): Promise<EpisodeJudgeOutput> {
	const providerService = getProviderService();
	const provider = await providerService.getDefaultProvider();
	const cfg = await providerService.getTitleGenerationConfig(provider);
	const modelId = cfg.modelId;
	const prompt = buildEpisodeJudgePrompt(input);
	const originalEnv = providerService.applyEnvVarsToProcessForProvider(provider, modelId);
	try {
		const { query } = await import('@anthropic-ai/claude-agent-sdk');
		const { isSDKAssistantMessage } = await import('@neokai/shared/sdk/type-guards');
		const agentQuery = query({
			prompt,
			options: {
				model: provider === 'glm' ? 'haiku' : modelId,
				maxTurns: 1,
				permissionMode: 'acceptEdits',
				allowDangerouslySkipPermissions: false,
				mcpServers: {},
				settingSources: [],
				tools: [],
				pathToClaudeCodeExecutable: resolveSDKCliPath(),
				executable: isRunningUnderBun() ? 'bun' : undefined,
				env: mergeProviderEnvVars(
					providerService.getEnvVarsForModel(modelId, provider) as Record<
						string,
						string | undefined
					>
				),
				thinking: { type: 'disabled' },
			},
		});
		let raw = '';
		for await (const message of agentQuery) {
			if (isSDKAssistantMessage(message)) {
				const textBlocks = message.message.content.filter(
					(block: { type: string }) => block.type === 'text'
				) as Array<{ text?: string }>;
				raw = textBlocks
					.map((block) => block.text ?? '')
					.join('\n')
					.trim();
				if (raw) break;
			}
		}
		if (!raw) throw new Error('Episode judge returned no text');
		return parseEpisodeJudgeJson(raw);
	} catch (err) {
		log.warn('Episode judge model call failed:', err);
		throw err;
	} finally {
		providerService.restoreEnvVars(originalEnv);
	}
}

function normalizeJudgeOutput(value: unknown): EpisodeJudgeOutput {
	const record = requireRecord(value, 'episode judge output');
	const title = requireString(record.title, 'title');
	const outcomeSummary = requireString(record.outcomeSummary, 'outcomeSummary');
	const findingsValue = Array.isArray(record.findings) ? record.findings : [];
	const findings = findingsValue.map(normalizeFinding);
	const candidateLessons = Array.isArray(record.candidateLessons)
		? record.candidateLessons.map(normalizeLesson)
		: [];
	const proposals = Array.isArray(record.proposals) ? record.proposals.map(normalizeProposal) : [];
	return { title, outcomeSummary, findings, candidateLessons, proposals };
}

function normalizeFinding(value: unknown): EvolutionFinding {
	const record = requireRecord(value, 'finding');
	return {
		domain: enumValue(record.domain, FINDING_DOMAINS, 'finding.domain'),
		kind: enumValue(record.kind, FINDING_KINDS, 'finding.kind'),
		impact: enumValue(record.impact, IMPACTS, 'finding.impact'),
		confidence: clampConfidence(record.confidence),
		evidence: stringArray(record.evidence),
		proposedAction: requireString(record.proposedAction, 'finding.proposedAction'),
	};
}

function normalizeLesson(
	value: unknown
): Omit<CreateEvolutionLessonParams, 'scopeId' | 'evidenceEpisodeIds'> {
	const record = requireRecord(value, 'candidate lesson');
	return {
		status:
			record.status === undefined
				? 'candidate'
				: enumValue(record.status, LESSON_STATUSES, 'lesson.status'),
		appliesTo: stringArray(record.appliesTo),
		rule: requireString(record.rule, 'lesson.rule'),
		why: requireString(record.why, 'lesson.why'),
		confidence: clampConfidence(record.confidence),
	};
}

function normalizeProposal(
	value: unknown
): Omit<CreateTaskProposalParams, 'scopeId' | 'evidenceEpisodeIds'> {
	const record = requireRecord(value, 'proposal');
	return {
		title: requireString(record.title, 'proposal.title'),
		description: requireString(record.description, 'proposal.description'),
		reason: requireString(record.reason, 'proposal.reason'),
		priority: enumValue(record.priority ?? 'normal', PRIORITIES, 'proposal.priority'),
		status:
			record.status === undefined
				? 'proposed'
				: enumValue(record.status, PROPOSAL_STATUSES, 'proposal.status'),
	};
}

function deriveTimeWindow(evidence: EvidenceRef[]): CreateEvolutionEpisodeParams['timeWindow'] {
	if (evidence.length === 0) return null;
	const times = evidence.map((item) => item.createdAt);
	return { start: Math.min(...times), end: Math.max(...times) };
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error(`${label} must be an object`);
	}
	return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string): string {
	if (typeof value !== 'string' || value.trim().length === 0) {
		throw new Error(`${label} is required`);
	}
	return value.trim();
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
	if (typeof value !== 'string' || !allowed.includes(value as T)) {
		throw new Error(`${label} must be one of: ${allowed.join(', ')}`);
	}
	return value as T;
}

function stringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}

function clampConfidence(value: unknown): number {
	const numeric = typeof value === 'number' && Number.isFinite(value) ? value : 0;
	return Math.max(0, Math.min(1, numeric));
}

function truncate(value: string, max: number): string {
	return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
