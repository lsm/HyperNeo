import type { CreateEvidenceRefParams, SpaceTask } from '@hyperneo/shared';
import type {
  FrictionDigestTopPattern,
  ToolResultRecord,
  TraceAnalysis,
} from './trace-evidence-types.ts';
import { TRACE_CAPTURE_VERSION } from './trace-evidence-types.ts';
import { groupBy, unique } from './trace-evidence-parsing.ts';

const FRICTION_DIGEST_CATEGORY_LABELS: Record<string, string> = {
  repeatedError: 'repeated_error',
  retryLoop: 'retry_loop',
  slowToolCall: 'slow_tool_call',
  verificationFailure: 'verification_failure',
  permissionBlock: 'permission_block',
  toolFailure: 'tool_failure',
};

export function buildFrictionDigestParams(
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
