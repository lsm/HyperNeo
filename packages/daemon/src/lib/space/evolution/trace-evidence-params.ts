import type { CreateEvidenceRefParams, SpaceTask } from '@hyperneo/shared';
import type {
  SlowToolCallRecord,
  ToolResultRecord,
  TraceAnalysis,
} from './trace-evidence-types.ts';
import { TRACE_CAPTURE_VERSION } from './trace-evidence-types.ts';
import { SLOW_TOOL_CALL_THRESHOLD_MS } from './trace-analysis.ts';
import { plural, unique } from './trace-evidence-parsing.ts';

export function buildEvidenceParams(
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
