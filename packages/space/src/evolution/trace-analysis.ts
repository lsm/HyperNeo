import type {
  SlowToolCallRecord,
  ToolResultRecord,
  ToolUseRecord,
  TraceAnalysis,
  TraceRow,
  VerificationTriageRecord,
} from './trace-evidence-types.ts';
import {
  asRecord,
  extractFilePaths,
  extractToolResultText,
  groupBy,
  normalizeCommand,
  normalizeErrorFingerprint,
  parseJsonRecord,
  readContent,
  readFilePath,
  unique,
} from './trace-evidence-parsing.ts';

export const EDIT_TOOL_NAMES = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
export const SLOW_TOOL_CALL_THRESHOLD_MS = 30_000;

const VERIFICATION_PATTERN =
  /\b(test|vitest|playwright|check|build|lint|typecheck|tsc|biome|oxlint|knip)\b/i;
const TEST_PATTERN = /\b(test|vitest|playwright)\b/i;
const PERMISSION_PATTERN =
  /(permission denied|operation not permitted|not allowed|requires approval|user denied|blocked by|permission block)/i;

export function analyzeTrace(rows: TraceRow[]): TraceAnalysis {
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

export function hasProcessFriction(analysis: TraceAnalysis): boolean {
  return (
    analysis.failedToolCallCount > 0 ||
    analysis.repeatedErrors.length > 0 ||
    analysis.retryLoops.length > 0 ||
    analysis.permissionBlocks.length > 0 ||
    analysis.slowToolCalls.length > 0 ||
    analysis.verificationTriages.length > 0
  );
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
