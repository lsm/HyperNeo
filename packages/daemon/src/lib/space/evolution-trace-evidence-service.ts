import type { Database as BunDatabase } from '../../storage/sqlite-compat.ts';
import type {
  CreateEvidenceRefParams,
  EvidenceKind,
  EvidenceRef,
  SpaceTask,
} from '@hyperneo/shared';
import type { EvolutionRepository } from '../../storage/repositories/evolution-repository.ts';
import type { SpaceTaskRepository } from '../../storage/repositories/space-task-repository.ts';

const TRACE_CAPTURE_VERSION = 1;
const TRACE_EVIDENCE_KINDS: EvidenceKind[] = [
  'error_cluster',
  'retry_loop',
  'tool_failure',
  'test_failure',
  'permission_block',
  'slow_tool_call',
  'verification_triage',
];
const EDIT_TOOL_NAMES = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
const VERIFICATION_PATTERN =
  /\b(test|vitest|playwright|check|build|lint|typecheck|tsc|biome|oxlint|knip)\b/i;
const TEST_PATTERN = /\b(test|vitest|playwright)\b/i;
const PERMISSION_PATTERN =
  /(permission denied|operation not permitted|not allowed|requires approval|user denied|blocked by|permission block)/i;
const MAX_ROWS = 500;
const SLOW_TOOL_CALL_THRESHOLD_MS = 30_000;

export interface EvolutionTraceEvidenceServiceDeps {
  db: BunDatabase;
  evolutionRepo: EvolutionRepository;
  taskRepo: Pick<SpaceTaskRepository, 'getTask'>;
}

export interface CaptureTraceEvidenceForTaskParams {
  scopeId: string;
  taskId: string;
}

export interface TraceEvidenceDiagnostic {
  status: 'generated' | 'no_trace_rows' | 'no_friction' | 'error';
  message: string;
  messageCount: number;
  toolCallCount: number;
  failedToolCallCount: number;
  slowToolCallCount: number;
  evidenceCount: number;
  error?: string;
}

export interface CaptureTraceEvidenceForTaskResult {
  evidence: EvidenceRef[];
  diagnostic: TraceEvidenceDiagnostic;
}

interface FrictionDigestTopPattern {
  category: string;
  count: number;
  example: string | null;
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
  hasToolUse: boolean;
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

interface SlowToolCallRecord {
  toolUseId: string;
  toolName: string;
  commandKey: string;
  durationMs: number;
  filePath: string | null;
  rowId: string;
  sessionId: string;
}

interface VerificationTriageRecord {
  key: string;
  command: string;
  category: ToolResultRecord['category'];
  failures: ToolResultRecord[];
  resolvedBy: ToolResultRecord | null;
  suspectedFix: string;
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
  slowToolCalls: SlowToolCallRecord[];
  repeatedErrors: Array<{ fingerprint: string; count: number; results: ToolResultRecord[] }>;
  retryLoops: Array<{
    key: string;
    failuresBeforeSuccess: ToolResultRecord[];
    success: ToolResultRecord;
  }>;
  fileChurn: Array<{ filePath: string; editCount: number }>;
  firstPassingVerification: ToolResultRecord | null;
  verificationTriages: VerificationTriageRecord[];
}

export class EvolutionTraceEvidenceService {
  constructor(private deps: EvolutionTraceEvidenceServiceDeps) {}

  captureForTask(params: CaptureTraceEvidenceForTaskParams): EvidenceRef[] {
    return this.captureForTaskWithDiagnostic(params).evidence;
  }

  captureForTaskWithDiagnostic(
    params: CaptureTraceEvidenceForTaskParams
  ): CaptureTraceEvidenceForTaskResult {
    const task = this.deps.taskRepo.getTask(params.taskId);
    if (!task) throw new Error(`Task not found: ${params.taskId}`);
    const rows = this.loadTraceRows(task.id);
    if (rows.length === 0) {
      return {
        evidence: [],
        diagnostic: buildTraceDiagnostic('no_trace_rows', rows.length),
      };
    }

    const analysis = analyzeTrace(rows);
    if (!hasProcessFriction(analysis)) {
      return {
        evidence: [],
        diagnostic: buildTraceDiagnostic('no_friction', rows.length, analysis),
      };
    }

    const existingByFingerprint = new Map(
      this.deps.evolutionRepo
        .listEvidence(params.scopeId)
        .filter(
          (item) =>
            item.sourceId === task.id &&
            TRACE_EVIDENCE_KINDS.includes(item.kind) &&
            item.metadata.traceCaptureVersion === TRACE_CAPTURE_VERSION
        )
        .map((item) => [String(item.metadata.traceFingerprint ?? ''), item])
    );

    const evidence = buildEvidenceParams(params.scopeId, task, analysis).map((item) => {
      const fingerprint = String(item.metadata?.traceFingerprint ?? '');
      const existing = existingByFingerprint.get(fingerprint);
      if (existing) {
        return this.deps.evolutionRepo.updateEvidence(existing.id, {
          summary: item.summary,
          metadata: item.metadata,
        });
      }
      return this.deps.evolutionRepo.createEvidence(item);
    });
    return {
      evidence,
      diagnostic: buildTraceDiagnostic('generated', rows.length, analysis, evidence.length),
    };
  }

  buildFrictionDigest(scopeId: string, taskId: string): EvidenceRef | null {
    const task = this.deps.taskRepo.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    const rows = this.loadTraceRows(task.id);
    if (rows.length === 0) return null;
    const analysis = analyzeTrace(rows);
    if (!hasProcessFriction(analysis)) return null;

    const params = buildFrictionDigestParams(scopeId, task, analysis);
    const existing = this.deps.evolutionRepo
      .listEvidence(scopeId)
      .find(
        (item) =>
          item.kind === 'friction_digest' &&
          item.sourceId === task.id &&
          item.metadata.frictionDigestFingerprint === params.metadata?.frictionDigestFingerprint
      );
    if (existing) {
      return this.deps.evolutionRepo.updateEvidence(existing.id, {
        summary: params.summary,
        metadata: params.metadata,
      });
    }
    return this.deps.evolutionRepo.createEvidence(params);
  }

  private loadTraceRows(taskId: string): TraceRow[] {
    const rows = this.deps.db
      .prepare(
        `SELECT id, session_id, message_type, sdk_message, timestamp, send_status
				 FROM (
					 SELECT id, session_id, message_type, sdk_message, timestamp, send_status
					 FROM sdk_messages
					 WHERE task_id = ?
						   AND COALESCE(message_subtype, '') NOT IN ('thinking_tokens', 'session_state_changed', 'commands_changed')
						   AND NOT EXISTS (
							 SELECT 1
							 FROM sdk_message_replacements replacement
							 WHERE replacement.task_id = sdk_messages.task_id
							   AND replacement.target_uuid = COALESCE(sdk_messages.sdk_uuid, sdk_messages.id)
						   )
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
      const hasToolUse = toolUse !== undefined;
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
        hasToolUse,
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

  const retryLoops = Array.from(
    groupBy(
      toolResults.filter((result) => result.hasToolUse),
      retryKey
    ).entries()
  ).flatMap(([key, results]) => detectRetryLoops(key, results));

  const slowToolCalls = toolResults.flatMap((result): SlowToolCallRecord[] => {
    if (!result.toolUseId) return [];
    const toolUse = toolUsesById.get(result.toolUseId);
    if (!toolUse) return [];
    const durationMs = result.timestamp - toolUse.timestamp;
    if (!Number.isFinite(durationMs) || durationMs < SLOW_TOOL_CALL_THRESHOLD_MS) return [];
    return [
      {
        toolUseId: result.toolUseId,
        toolName: result.toolName,
        commandKey: result.commandKey,
        durationMs,
        filePath: result.filePath,
        rowId: result.rowId,
        sessionId: result.sessionId,
      },
    ];
  });

  const verificationTriages = Array.from(
    groupBy(
      toolResults.filter((result) => result.hasToolUse && isVerificationCategory(result.category)),
      retryKey
    ).entries()
  ).flatMap(([key, results]) => detectVerificationTriages(key, results, toolUses));

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
    slowToolCalls,
    repeatedErrors,
    retryLoops,
    fileChurn: Array.from(editCountsByFile.entries())
      .filter(([, editCount]) => editCount > 1)
      .map(([filePath, editCount]) => ({ filePath, editCount })),
    firstPassingVerification,
    verificationTriages,
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

  for (const loop of analysis.retryLoops) {
    params.push({
      scopeId,
      kind: 'retry_loop',
      sourceId: task.id,
      summary: `Retry loop before success: ${loop.key} failed ${loop.failuresBeforeSuccess.length} times`,
      metadata: {
        ...base,
        traceFingerprint: `retry_loop:${loop.key}:${loop.success.toolUseId ?? loop.success.rowId}`,
        retryKey: loop.key,
        retriesBeforeSuccess: loop.failuresBeforeSuccess.length,
        timeBeforeFirstPassingVerificationMs: timeBeforeFirstPassingVerification(analysis),
        messageCountBeforeFirstPassingVerification:
          messageCountBeforeFirstPassingVerification(analysis),
        rawTraceRefs: rawRefs([...loop.failuresBeforeSuccess, loop.success], analysis),
      },
    });
  }

  for (const triage of analysis.verificationTriages) {
    const refs = triage.resolvedBy ? [...triage.failures, triage.resolvedBy] : triage.failures;
    const resolutionNote = triage.resolvedBy
      ? `Resolved on retry: ${triage.command} passed after ${triage.failures.length} failed attempt${plural(triage.failures.length)}.`
      : null;
    params.push({
      scopeId,
      kind: 'verification_triage',
      sourceId: task.id,
      summary: `Verification triage: '${triage.command}' failed ${triage.failures.length} time${plural(triage.failures.length)} (${triage.category}). Suspected fix: ${triage.suspectedFix}${resolutionNote ? ` [${resolutionNote}]` : ''}`,
      metadata: {
        ...base,
        traceFingerprint: `verification_triage:${triage.key}:${triage.failures[0].toolUseId ?? triage.failures[0].rowId}`,
        command: triage.command,
        category: triage.category,
        attemptCount: triage.failures.length,
        suspectedFix: triage.suspectedFix,
        resolutionNote,
        rawTraceRefs: rawRefs(refs, analysis),
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

  if (analysis.slowToolCalls.length > 0) {
    params.push({
      scopeId,
      kind: 'slow_tool_call',
      sourceId: task.id,
      summary: `Slow tool calls took over ${SLOW_TOOL_CALL_THRESHOLD_MS / 1000}s ${analysis.slowToolCalls.length} time${plural(analysis.slowToolCalls.length)}`,
      metadata: {
        ...base,
        traceFingerprint: 'slow_tool_call',
        slowToolCallCount: analysis.slowToolCalls.length,
        slowToolCalls: analysis.slowToolCalls.map(summarizeSlowToolCall),
        rawTraceRefs: rawRefsForSlowToolCalls(analysis.slowToolCalls, analysis),
      },
    });
  }

  const hasFailureEvidence = params.some((param) => param.kind !== 'slow_tool_call');
  if (analysis.failedToolCallCount > 0 && !hasFailureEvidence) {
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
    slowToolCallCount: analysis.slowToolCalls.length,
    verificationTriageCount: analysis.verificationTriages.length,
    fileChurn: analysis.fileChurn,
    messageCount: analysis.rows.length,
    traceSpan: {
      startMessageId: analysis.rows[0]?.id ?? null,
      endMessageId: analysis.rows.at(-1)?.id ?? null,
    },
  };
}

const FRICTION_DIGEST_CATEGORY_LABELS: Record<string, string> = {
  repeatedError: 'repeated_error',
  retryLoop: 'retry_loop',
  slowToolCall: 'slow_tool_call',
  verificationFailure: 'verification_failure',
  permissionBlock: 'permission_block',
  toolFailure: 'tool_failure',
};

function buildFrictionDigestParams(
  scopeId: string,
  task: SpaceTask,
  analysis: TraceAnalysis
): CreateEvidenceRefParams {
  const verificationFailureResults = analysis.toolResults.filter(
    (result) => result.failed && (result.category === 'test' || result.category === 'verification')
  );
  const repeatedErrorResults = new Set(
    analysis.repeatedErrors.flatMap((cluster) => cluster.results)
  );
  const retryLoopFailureResults = new Set(
    analysis.retryLoops.flatMap((loop) => loop.failuresBeforeSuccess)
  );
  const toolFailureResults = analysis.toolResults.filter(
    (result) =>
      result.failed &&
      (result.category === 'tool' || result.category === 'edit') &&
      !repeatedErrorResults.has(result) &&
      !retryLoopFailureResults.has(result)
  );

  const counts = {
    repeatedError: analysis.repeatedErrors.length,
    retryLoop: analysis.retryLoops.length,
    slowToolCall: analysis.slowToolCalls.length,
    verificationFailure: verificationFailureResults.length,
    permissionBlock: analysis.permissionBlocks.length,
    toolFailure: toolFailureResults.length,
  };
  const totalFrictionSignals = Object.values(counts).reduce((sum, count) => sum + count, 0);
  const topPattern = resolveTopFrictionPattern(analysis, counts, {
    verificationFailureResults,
    toolFailureResults,
  });
  const summary = `Friction digest: ${frictionDigestSummary(counts)}. Dominant pattern: ${topPattern.category}${topPattern.count > 1 ? ` (${topPattern.count})` : ''}.`;

  return {
    scopeId,
    kind: 'friction_digest',
    sourceId: task.id,
    summary,
    metadata: {
      autoCaptured: true,
      frictionDigest: true,
      traceCaptureVersion: TRACE_CAPTURE_VERSION,
      frictionDigestFingerprint: `friction_digest:${task.id}`,
      taskId: task.id,
      workflowRunId: task.workflowRunId ?? null,
      counts,
      totalFrictionSignals,
      topPattern,
      rawTraceRefs: frictionDigestRawRefs(analysis),
    },
  };
}

function frictionDigestSummary(counts: Record<string, number>): string {
  return Object.entries(counts)
    .filter(([, count]) => count > 0)
    .map(([key, count]) => `${FRICTION_DIGEST_CATEGORY_LABELS[key] ?? key} ${count}`)
    .join(', ');
}

function resolveTopFrictionPattern(
  analysis: TraceAnalysis,
  counts: Record<string, number>,
  context: {
    verificationFailureResults: ToolResultRecord[];
    toolFailureResults: ToolResultRecord[];
  }
): FrictionDigestTopPattern {
  const candidates = [
    {
      category: 'repeated_error',
      count: counts.repeatedError,
      example: topRepeatedErrorExample(analysis),
    },
    {
      category: 'retry_loop',
      count: counts.retryLoop,
      example: topRetryLoopExample(analysis),
    },
    {
      category: 'slow_tool_call',
      count: counts.slowToolCall,
      example: topSlowToolExample(analysis),
    },
    {
      category: 'verification_failure',
      count: counts.verificationFailure,
      example: topVerificationExample(context.verificationFailureResults),
    },
    {
      category: 'permission_block',
      count: counts.permissionBlock,
      example: topPermissionExample(analysis),
    },
    {
      category: 'tool_failure',
      count: counts.toolFailure,
      example: topToolFailureExample(context.toolFailureResults),
    },
  ].filter((candidate) => candidate.count > 0);

  if (candidates.length === 0) {
    return { category: 'tool_failure', count: 0, example: null };
  }

  candidates.sort((a, b) => b.count - a.count);
  const top = candidates[0] as FrictionDigestTopPattern;
  return top;
}

function topRepeatedErrorExample(analysis: TraceAnalysis): string | null {
  if (analysis.repeatedErrors.length === 0) return null;
  const top = analysis.repeatedErrors.slice().sort((a, b) => b.count - a.count)[0];
  return top?.fingerprint ?? null;
}

function topRetryLoopExample(analysis: TraceAnalysis): string | null {
  if (analysis.retryLoops.length === 0) return null;
  const top = analysis.retryLoops
    .slice()
    .sort((a, b) => b.failuresBeforeSuccess.length - a.failuresBeforeSuccess.length)[0];
  return top?.key ?? null;
}

function topSlowToolExample(analysis: TraceAnalysis): string | null {
  if (analysis.slowToolCalls.length === 0) return null;
  const top = analysis.slowToolCalls.slice().sort((a, b) => b.durationMs - a.durationMs)[0];
  return top ? `${top.toolName}:${top.commandKey}` : null;
}

function topVerificationExample(results: ToolResultRecord[]): string | null {
  if (results.length === 0) return null;
  const byKey = groupBy(results, (result) => result.commandKey);
  const top = Array.from(byKey.entries()).sort((a, b) => b[1].length - a[1].length)[0];
  return top?.[0] ?? null;
}

function topPermissionExample(analysis: TraceAnalysis): string | null {
  if (analysis.permissionBlocks.length === 0) return null;
  const byTool = groupBy(analysis.permissionBlocks, (result) => result.toolName);
  const top = Array.from(byTool.entries()).sort((a, b) => b[1].length - a[1].length)[0];
  return top?.[0] ?? null;
}

function topToolFailureExample(results: ToolResultRecord[]): string | null {
  if (results.length === 0) return null;
  const byFingerprint = groupBy(results, (result) => result.fingerprint);
  const top = Array.from(byFingerprint.entries()).sort((a, b) => b[1].length - a[1].length)[0];
  return top?.[0] ?? null;
}

function frictionDigestRawRefs(analysis: TraceAnalysis): Record<string, unknown> {
  const failed = analysis.toolResults.filter((result) => result.failed);
  const slow = analysis.slowToolCalls;
  const rowIds = unique([
    ...failed.map((result) => result.rowId),
    ...slow.map((call) => call.rowId),
  ]);
  const sessionIds = unique([
    ...failed.map((result) => result.sessionId),
    ...slow.map((call) => call.sessionId),
  ]);
  const toolUseIds = unique([
    ...failed.flatMap((result) => (result.toolUseId ? [result.toolUseId] : [])),
    ...slow.map((call) => call.toolUseId),
  ]);
  const indices = failed
    .map((result) => result.messageIndex)
    .filter((index) => Number.isFinite(index));
  return {
    sessionIds,
    messageIds: rowIds,
    toolUseIds,
    messageIndexRange:
      indices.length > 0 ? { start: Math.min(...indices), end: Math.max(...indices) } : null,
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
    analysis.permissionBlocks.length > 0 ||
    analysis.slowToolCalls.length > 0 ||
    analysis.verificationTriages.length > 0
  );
}

function buildTraceDiagnostic(
  status: TraceEvidenceDiagnostic['status'],
  messageCount: number,
  analysis?: TraceAnalysis,
  evidenceCount = 0
): TraceEvidenceDiagnostic {
  return {
    status,
    message: traceDiagnosticMessage(status),
    messageCount,
    toolCallCount: analysis?.toolCallCount ?? 0,
    failedToolCallCount: analysis?.failedToolCallCount ?? 0,
    slowToolCallCount: analysis?.slowToolCalls.length ?? 0,
    evidenceCount,
  };
}

function traceDiagnosticMessage(status: TraceEvidenceDiagnostic['status']): string {
  if (status === 'generated') return 'Trace-derived evidence generated';
  if (status === 'no_trace_rows')
    return 'No trace evidence generated: no SDK messages found for task';
  if (status === 'no_friction') {
    return 'No trace evidence generated: task trace had no meaningful failures, retries, permission blocks, or slow operations';
  }
  return 'Trace evidence capture failed';
}

function summarizeSlowToolCall(record: SlowToolCallRecord): Record<string, unknown> {
  return {
    toolUseId: record.toolUseId,
    toolName: record.toolName,
    commandKey: record.commandKey,
    durationMs: record.durationMs,
    filePath: record.filePath,
  };
}

function rawRefsForSlowToolCalls(
  calls: SlowToolCallRecord[],
  analysis: TraceAnalysis
): Record<string, unknown> {
  return {
    sessionIds: unique(calls.map((call) => call.sessionId)),
    messageIds: unique(calls.map((call) => call.rowId)),
    toolUseIds: unique(calls.map((call) => call.toolUseId)),
    traceSpan: {
      startMessageId: analysis.rows[0]?.id ?? null,
      endMessageId: analysis.rows.at(-1)?.id ?? null,
    },
  };
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

function detectRetryLoops(
  key: string,
  results: ToolResultRecord[]
): Array<TraceAnalysis['retryLoops'][number]> {
  const loops: Array<TraceAnalysis['retryLoops'][number]> = [];
  let pendingFailures: ToolResultRecord[] = [];
  for (const result of results) {
    if (result.failed) {
      pendingFailures.push(result);
      continue;
    }
    if (pendingFailures.length >= 2) {
      loops.push({ key, failuresBeforeSuccess: pendingFailures, success: result });
    }
    pendingFailures = [];
  }
  return loops;
}

function isVerificationCategory(category: ToolResultRecord['category']): boolean {
  return category === 'test' || category === 'verification';
}

const SOURCE_FILE_EXTENSIONS = new Set([
  'ts',
  'tsx',
  'js',
  'jsx',
  'py',
  'go',
  'rs',
  'java',
  'kt',
  'swift',
  'cpp',
  'c',
  'h',
  'md',
  'json',
  'yml',
  'yaml',
  'toml',
  'css',
  'html',
]);

function extractFilePaths(text: string): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const token of text.split(/[\s\n\r,:"'`()[\]{}]+/)) {
    const trimmed = token.trim();
    if (!trimmed) continue;
    const ext = trimmed.split('.').pop()?.toLowerCase() ?? '';
    if (!SOURCE_FILE_EXTENSIONS.has(ext)) continue;
    const looksLikeFile =
      trimmed.includes('/') || trimmed.includes('\\') || /^[\w.-]+\.[a-zA-Z0-9]+$/.test(trimmed);
    if (!looksLikeFile) continue;
    const short = trimmed.slice(0, 120);
    if (seen.has(short)) continue;
    seen.add(short);
    paths.push(short);
  }
  return paths;
}

function suspectedFixForTriage(
  triage: Pick<VerificationTriageRecord, 'failures' | 'command'>,
  toolUses: ToolUseRecord[]
): string {
  const errorPaths = unique(
    triage.failures.flatMap((failure) => extractFilePaths(failure.text))
  ).slice(0, 3);
  if (errorPaths.length > 0) {
    return `Address failures in ${errorPaths.join(', ')}`;
  }

  const firstFailure = triage.failures[0];
  const firstFailureTime = firstFailure?.timestamp;
  const sessionId = firstFailure?.sessionId;
  if (firstFailureTime !== undefined && sessionId !== undefined) {
    const recentEdit = toolUses
      .filter(
        (use) =>
          use.sessionId === sessionId &&
          EDIT_TOOL_NAMES.has(use.name) &&
          use.timestamp <= firstFailureTime &&
          readFilePath(use.input)
      )
      .sort((a, b) => b.timestamp - a.timestamp)[0];
    const recentPath = recentEdit ? readFilePath(recentEdit.input) : null;
    if (recentPath) {
      return `Review recent edit to ${recentPath}`;
    }
  }

  return `Review recent changes and re-run ${triage.command}`;
}

function detectVerificationTriages(
  key: string,
  results: ToolResultRecord[],
  toolUses: ToolUseRecord[]
): VerificationTriageRecord[] {
  const triages: VerificationTriageRecord[] = [];
  let pending: ToolResultRecord[] = [];

  const flush = (resolvedBy: ToolResultRecord | null) => {
    if (pending.length < 2) {
      pending = [];
      return;
    }
    const command = pending[0].commandKey;
    const category = pending[0].category;
    const suspectedFix = suspectedFixForTriage({ failures: pending, command }, toolUses);
    triages.push({ key, command, category, failures: pending, resolvedBy, suspectedFix });
    pending = [];
  };

  for (const result of results) {
    if (result.failed && isVerificationCategory(result.category)) {
      pending.push(result);
      continue;
    }
    flush(result);
  }
  flush(null);

  return triages;
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
