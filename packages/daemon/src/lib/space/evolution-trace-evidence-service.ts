import type { Database as BunDatabase } from 'bun:sqlite';
import type { CreateEvidenceRefParams, EvidenceKind, EvidenceRef, SpaceTask } from '@neokai/shared';
import type { EvolutionRepository } from '../../storage/repositories/evolution-repository';
import type { SpaceTaskRepository } from '../../storage/repositories/space-task-repository';

const TRACE_CAPTURE_VERSION = 1;
const TRACE_EVIDENCE_KINDS: EvidenceKind[] = [
	'error_cluster',
	'retry_loop',
	'tool_failure',
	'test_failure',
	'permission_block',
];
const EDIT_TOOL_NAMES = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
const VERIFICATION_PATTERN =
	/\b(test|vitest|playwright|check|build|lint|typecheck|tsc|biome|oxlint|knip)\b/i;
const TEST_PATTERN = /\b(test|vitest|playwright)\b/i;
const PERMISSION_PATTERN =
	/(permission denied|operation not permitted|not allowed|requires approval|user denied|blocked by|permission block)/i;
const MAX_ROWS = 500;

export interface EvolutionTraceEvidenceServiceDeps {
	db: BunDatabase;
	evolutionRepo: EvolutionRepository;
	taskRepo: Pick<SpaceTaskRepository, 'getTask'>;
}

export interface CaptureTraceEvidenceForTaskParams {
	scopeId: string;
	taskId: string;
}

interface TraceRow {
	id: string;
	sessionId: string;
	messageType: string;
	sdkMessage: string;
	timestamp: string;
	sendStatus: string | null;
}

interface ToolUseRecord {
	id: string;
	name: string;
	input: Record<string, unknown>;
	rowId: string;
	sessionId: string;
	messageIndex: number;
	timestamp: number;
}

interface ToolResultRecord {
	toolUseId: string | null;
	toolName: string;
	commandKey: string;
	rowId: string;
	sessionId: string;
	messageIndex: number;
	timestamp: number;
	failed: boolean;
	text: string;
	fingerprint: string;
	category: 'test' | 'verification' | 'edit' | 'tool' | 'permission';
	filePath: string | null;
}

interface TraceAnalysis {
	rows: TraceRow[];
	toolUses: ToolUseRecord[];
	toolResults: ToolResultRecord[];
	toolCallCount: number;
	failedToolCallCount: number;
	editFailures: ToolResultRecord[];
	testFailures: ToolResultRecord[];
	permissionBlocks: ToolResultRecord[];
	repeatedErrors: Array<{ fingerprint: string; count: number; results: ToolResultRecord[] }>;
	retryLoops: Array<{
		key: string;
		failuresBeforeSuccess: ToolResultRecord[];
		success: ToolResultRecord;
	}>;
	fileChurn: Array<{ filePath: string; editCount: number }>;
	firstPassingVerification: ToolResultRecord | null;
}

export class EvolutionTraceEvidenceService {
	constructor(private deps: EvolutionTraceEvidenceServiceDeps) {}

	captureForTask(params: CaptureTraceEvidenceForTaskParams): EvidenceRef[] {
		const task = this.deps.taskRepo.getTask(params.taskId);
		if (!task) throw new Error(`Task not found: ${params.taskId}`);
		const rows = this.loadTraceRows(task.id);
		if (rows.length === 0) return [];

		const analysis = analyzeTrace(rows);
		if (!hasProcessFriction(analysis)) return [];

		const existingFingerprints = new Set(
			this.deps.evolutionRepo
				.listEvidence(params.scopeId)
				.filter(
					(item) =>
						item.sourceId === task.id &&
						TRACE_EVIDENCE_KINDS.includes(item.kind) &&
						item.metadata.traceCaptureVersion === TRACE_CAPTURE_VERSION
				)
				.map((item) => String(item.metadata.traceFingerprint ?? ''))
		);

		const evidenceParams = buildEvidenceParams(params.scopeId, task, analysis).filter(
			(item) => !existingFingerprints.has(String(item.metadata?.traceFingerprint ?? ''))
		);
		return evidenceParams.map((item) => this.deps.evolutionRepo.createEvidence(item));
	}

	private loadTraceRows(taskId: string): TraceRow[] {
		const rows = this.deps.db
			.prepare(
				`SELECT id, session_id, message_type, sdk_message, timestamp, send_status
				 FROM (
					 SELECT id, session_id, message_type, sdk_message, timestamp, send_status
					 FROM sdk_messages
					 WHERE task_id = ?
					 ORDER BY timestamp DESC, id DESC
					 LIMIT ?
				 ) recent_trace_rows
				 ORDER BY timestamp ASC, id ASC`
			)
			.all(taskId, MAX_ROWS) as Array<{
			id: string;
			session_id: string;
			message_type: string;
			sdk_message: string;
			timestamp: string;
			send_status: string | null;
		}>;
		return rows.map((row) => ({
			id: row.id,
			sessionId: row.session_id,
			messageType: row.message_type,
			sdkMessage: row.sdk_message,
			timestamp: row.timestamp,
			sendStatus: row.send_status,
		}));
	}
}

function analyzeTrace(rows: TraceRow[]): TraceAnalysis {
	const toolUsesById = new Map<string, ToolUseRecord>();
	const toolUses: ToolUseRecord[] = [];
	const toolResults: ToolResultRecord[] = [];
	const editCountsByFile = new Map<string, number>();

	rows.forEach((row, messageIndex) => {
		const parsed = parseJsonRecord(row.sdkMessage);
		if (!parsed) return;
		const content = readContent(parsed);
		if (!Array.isArray(content)) return;

		for (const block of content) {
			const record = asRecord(block);
			if (!record) continue;
			if (record.type === 'tool_use') {
				const id = typeof record.id === 'string' ? record.id : null;
				const name = typeof record.name === 'string' ? record.name : null;
				if (!id || !name) continue;
				const input = asRecord(record.input) ?? {};
				const toolUse: ToolUseRecord = {
					id,
					name,
					input,
					rowId: row.id,
					sessionId: row.sessionId,
					messageIndex,
					timestamp: Date.parse(row.timestamp),
				};
				toolUsesById.set(id, toolUse);
				toolUses.push(toolUse);
				const filePath = readFilePath(input);
				if (EDIT_TOOL_NAMES.has(name) && filePath) {
					editCountsByFile.set(filePath, (editCountsByFile.get(filePath) ?? 0) + 1);
				}
				continue;
			}
			if (record.type !== 'tool_result') continue;

			const toolUseId = typeof record.tool_use_id === 'string' ? record.tool_use_id : null;
			const toolUse = toolUseId ? toolUsesById.get(toolUseId) : undefined;
			const toolName = toolUse?.name ?? 'unknown';
			const text = extractToolResultText(record);
			const failed = record.is_error === true || /^(error|failed):/i.test(text.trim());
			const command = typeof toolUse?.input.command === 'string' ? toolUse.input.command : '';
			const commandKey = command ? normalizeCommand(command) : toolName;
			const category = classifyResult(toolName, command, text);
			const filePath = readFilePath(toolUse?.input ?? {});
			const fingerprint = normalizeErrorFingerprint(text || `${toolName} failed`);
			toolResults.push({
				toolUseId,
				toolName,
				commandKey,
				rowId: row.id,
				sessionId: row.sessionId,
				messageIndex,
				timestamp: Date.parse(row.timestamp),
				failed,
				text,
				fingerprint,
				category,
				filePath,
			});
		}
	});

	const failedResults = toolResults.filter((result) => result.failed);
	const failuresByFingerprint = groupBy(failedResults, (result) => result.fingerprint);
	const repeatedErrors = Array.from(failuresByFingerprint.entries())
		.filter(([, results]) => results.length > 1)
		.map(([fingerprint, results]) => ({ fingerprint, count: results.length, results }));

	const retryLoops = Array.from(groupBy(toolResults, retryKey).entries()).flatMap(
		([key, results]) => {
			const firstSuccessIndex = results.findIndex((result) => !result.failed);
			if (firstSuccessIndex < 0) return [];
			const failuresBeforeSuccess = results
				.slice(0, firstSuccessIndex)
				.filter((result) => result.failed);
			if (failuresBeforeSuccess.length < 2) return [];
			return [{ key, failuresBeforeSuccess, success: results[firstSuccessIndex] }];
		}
	);

	const verificationSuccesses = toolResults.filter(
		(result) => !result.failed && (result.category === 'test' || result.category === 'verification')
	);
	const firstPassingVerification = verificationSuccesses[0] ?? null;

	return {
		rows,
		toolUses,
		toolResults,
		toolCallCount: toolUses.length,
		failedToolCallCount: failedResults.length,
		editFailures: failedResults.filter((result) => result.category === 'edit'),
		testFailures: failedResults.filter((result) => result.category === 'test'),
		permissionBlocks: failedResults.filter((result) => result.category === 'permission'),
		repeatedErrors,
		retryLoops,
		fileChurn: Array.from(editCountsByFile.entries())
			.filter(([, editCount]) => editCount > 1)
			.map(([filePath, editCount]) => ({ filePath, editCount })),
		firstPassingVerification,
	};
}

function buildEvidenceParams(
	scopeId: string,
	task: SpaceTask,
	analysis: TraceAnalysis
): CreateEvidenceRefParams[] {
	const base = buildBaseMetadata(task, analysis);
	const params: CreateEvidenceRefParams[] = [];

	for (const cluster of analysis.repeatedErrors) {
		params.push({
			scopeId,
			kind: 'error_cluster',
			sourceId: task.id,
			summary: `Repeated tool error occurred ${cluster.count} times: ${cluster.fingerprint}`,
			metadata: {
				...base,
				traceFingerprint: `error_cluster:${cluster.fingerprint}`,
				errorFingerprint: cluster.fingerprint,
				repeatedSameErrorCount: cluster.count,
				rawTraceRefs: rawRefs(cluster.results, analysis),
			},
		});
	}

	if (analysis.retryLoops.length > 0) {
		const loop = analysis.retryLoops[0];
		params.push({
			scopeId,
			kind: 'retry_loop',
			sourceId: task.id,
			summary: `Retry loop before success: ${loop.key} failed ${loop.failuresBeforeSuccess.length} times`,
			metadata: {
				...base,
				traceFingerprint: `retry_loop:${loop.key}`,
				retryKey: loop.key,
				retriesBeforeSuccess: loop.failuresBeforeSuccess.length,
				timeBeforeFirstPassingVerificationMs: timeBeforeFirstPassingVerification(analysis),
				messageCountBeforeFirstPassingVerification:
					messageCountBeforeFirstPassingVerification(analysis),
				rawTraceRefs: rawRefs([...loop.failuresBeforeSuccess, loop.success], analysis),
			},
		});
	}

	if (analysis.testFailures.length > 0) {
		params.push({
			scopeId,
			kind: 'test_failure',
			sourceId: task.id,
			summary: `Verification failed ${analysis.testFailures.length} time${plural(analysis.testFailures.length)}`,
			metadata: {
				...base,
				traceFingerprint: 'test_failure',
				testFailureCycles: analysis.testFailures.length,
				rawTraceRefs: rawRefs(analysis.testFailures, analysis),
			},
		});
	}

	if (analysis.permissionBlocks.length > 0) {
		params.push({
			scopeId,
			kind: 'permission_block',
			sourceId: task.id,
			summary: `Permission or blocked-action friction appeared ${analysis.permissionBlocks.length} time${plural(analysis.permissionBlocks.length)}`,
			metadata: {
				...base,
				traceFingerprint: 'permission_block',
				permissionBlockCount: analysis.permissionBlocks.length,
				rawTraceRefs: rawRefs(analysis.permissionBlocks, analysis),
			},
		});
	}

	if (analysis.failedToolCallCount > 0 && params.length === 0) {
		params.push({
			scopeId,
			kind: 'tool_failure',
			sourceId: task.id,
			summary: `Tool calls failed ${analysis.failedToolCallCount} time${plural(analysis.failedToolCallCount)}`,
			metadata: {
				...base,
				traceFingerprint: 'tool_failure',
				rawTraceRefs: rawRefs(
					analysis.toolResults.filter((result) => result.failed),
					analysis
				),
			},
		});
	}

	return params;
}

function buildBaseMetadata(task: SpaceTask, analysis: TraceAnalysis): Record<string, unknown> {
	return {
		traceDerived: true,
		traceCaptureVersion: TRACE_CAPTURE_VERSION,
		taskId: task.id,
		workflowRunId: task.workflowRunId ?? null,
		toolCallCount: analysis.toolCallCount,
		failedToolCallCount: analysis.failedToolCallCount,
		editFailureCount: analysis.editFailures.length,
		testFailureCycles: analysis.testFailures.length,
		permissionBlockCount: analysis.permissionBlocks.length,
		fileChurn: analysis.fileChurn,
		messageCount: analysis.rows.length,
		traceSpan: {
			startMessageId: analysis.rows[0]?.id ?? null,
			endMessageId: analysis.rows.at(-1)?.id ?? null,
		},
	};
}

function hasProcessFriction(analysis: TraceAnalysis): boolean {
	return (
		analysis.failedToolCallCount > 0 ||
		analysis.repeatedErrors.length > 0 ||
		analysis.retryLoops.length > 0 ||
		analysis.permissionBlocks.length > 0
	);
}

function rawRefs(results: ToolResultRecord[], analysis: TraceAnalysis): Record<string, unknown> {
	const rowIds = unique(results.map((result) => result.rowId));
	const sessionIds = unique(results.map((result) => result.sessionId));
	return {
		sessionIds,
		messageIds: rowIds,
		toolUseIds: unique(results.flatMap((result) => (result.toolUseId ? [result.toolUseId] : []))),
		messageIndexRange: {
			start: Math.min(...results.map((result) => result.messageIndex)),
			end: Math.max(...results.map((result) => result.messageIndex)),
		},
		traceSpan: {
			startMessageId: analysis.rows[0]?.id ?? null,
			endMessageId: analysis.rows.at(-1)?.id ?? null,
		},
	};
}

function classifyResult(
	toolName: string,
	command: string,
	text: string
): ToolResultRecord['category'] {
	if (PERMISSION_PATTERN.test(text)) return 'permission';
	if (EDIT_TOOL_NAMES.has(toolName)) return 'edit';
	if (toolName === 'Bash' && TEST_PATTERN.test(command)) return 'test';
	if (toolName === 'Bash' && VERIFICATION_PATTERN.test(command)) return 'verification';
	return 'tool';
}

function retryKey(result: ToolResultRecord): string {
	const target = result.filePath ?? result.commandKey;
	return `${result.sessionId}:${result.toolName}:${target}`;
}

function normalizeCommand(command: string): string {
	return command.trim().replace(/\s+/g, ' ').slice(0, 160);
}

function normalizeErrorFingerprint(text: string): string {
	const normalized = text
		.split('\n')
		.map((line) => line.trim())
		.find((line) => line.length > 0)
		?.replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, '<uuid>')
		.replace(/\b\d+\b/g, '<n>')
		.slice(0, 180);
	return normalized || 'unknown tool failure';
}

function extractToolResultText(record: Record<string, unknown>): string {
	const content = record.content;
	if (typeof content === 'string') return content;
	if (!Array.isArray(content)) return '';
	return content
		.map((item) => {
			const block = asRecord(item);
			if (!block) return '';
			return typeof block.text === 'string' ? block.text : '';
		})
		.filter(Boolean)
		.join('\n');
}

function readContent(message: Record<string, unknown>): unknown {
	const nested = asRecord(message.message);
	return nested?.content;
}

function readFilePath(input: Record<string, unknown>): string | null {
	const candidates = [input.file_path, input.notebook_path, input.path];
	for (const candidate of candidates) {
		if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
	}
	return null;
}

function parseJsonRecord(value: string): Record<string, unknown> | null {
	try {
		return asRecord(JSON.parse(value));
	} catch {
		return null;
	}
}

function asRecord(value: unknown): Record<string, unknown> | null {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
	return value as Record<string, unknown>;
}

function groupBy<T>(items: T[], keyFor: (item: T) => string): Map<string, T[]> {
	const grouped = new Map<string, T[]>();
	for (const item of items) {
		const key = keyFor(item);
		const bucket = grouped.get(key) ?? [];
		bucket.push(item);
		grouped.set(key, bucket);
	}
	return grouped;
}

function unique(values: string[]): string[] {
	return Array.from(new Set(values));
}

function plural(count: number): string {
	return count === 1 ? '' : 's';
}

function timeBeforeFirstPassingVerification(analysis: TraceAnalysis): number | null {
	if (!analysis.firstPassingVerification || analysis.rows.length === 0) return null;
	const firstTraceTime = Date.parse(analysis.rows[0]?.timestamp ?? '');
	if (
		!Number.isFinite(firstTraceTime) ||
		!Number.isFinite(analysis.firstPassingVerification.timestamp)
	) {
		return null;
	}
	return Math.max(0, analysis.firstPassingVerification.timestamp - firstTraceTime);
}

function messageCountBeforeFirstPassingVerification(analysis: TraceAnalysis): number | null {
	if (!analysis.firstPassingVerification) return null;
	return analysis.firstPassingVerification.messageIndex + 1;
}
