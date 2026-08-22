export interface RepeatedToolErrorKey {
  toolName: string;
  fingerprint: string;
}

export interface ToolResultError {
  toolUseId: string;
  toolName: string;
  errorText: string;
  fingerprint: string;
}

export type ToolResultContentClassification =
  | { kind: 'reset' }
  | { kind: 'ignore' }
  | { kind: 'errors'; errors: ToolResultError[] };

export interface ErrorObservationState {
  lastError: RepeatedToolErrorKey | null;
  consecutiveCount: number;
}

export type ConsecutiveErrorDecision =
  | { action: 'cooldown_reset' }
  | { action: 'count'; lastError: RepeatedToolErrorKey; consecutiveCount: number }
  | { action: 'intervene'; consecutiveCount: number };

export function repeatedToolErrorKey(toolName: string, fingerprint: string): string {
  return `${toolName}:${fingerprint}`;
}

export function normalizeErrorText(errorText: string, maxLength: number): string {
  const normalized = errorText.trim().toLowerCase().replace(/\s+/g, ' ');
  return normalized.length > maxLength ? normalized.slice(0, maxLength) : normalized;
}

export function isToolResultBlock(block: unknown): boolean {
  return (
    block !== null &&
    typeof block === 'object' &&
    (block as { type?: unknown }).type === 'tool_result'
  );
}

export function extractToolResultError(
  block: unknown,
  toolUseIdToName: ReadonlyMap<string, string>
): { toolUseId: string; toolName: string; errorText: string } | null {
  if (!isToolResultBlock(block)) return null;

  const b = block as {
    tool_use_id?: unknown;
    is_error?: unknown;
    content?: unknown;
  };

  if (b.is_error !== true) return null;
  const toolUseId = typeof b.tool_use_id === 'string' ? b.tool_use_id : '';
  if (!toolUseId) return null;

  const errorText = extractText(b.content);
  if (!errorText) return null;

  const toolName = toolUseIdToName.get(toolUseId) ?? 'unknown';
  return { toolUseId, toolName, errorText };
}

export function classifyToolResultContent(
  content: unknown,
  toolUseIdToName: ReadonlyMap<string, string>,
  errorFingerprintLength: number
): ToolResultContentClassification {
  if (typeof content === 'string') return { kind: 'reset' };
  if (!Array.isArray(content)) return { kind: 'ignore' };

  const errors: ToolResultError[] = [];
  const seenKeys = new Set<string>();
  let hasSuccessToolResult = false;
  for (const block of content) {
    const error = extractToolResultError(block, toolUseIdToName);
    if (error) {
      const fingerprint = normalizeErrorText(error.errorText, errorFingerprintLength);
      const key = repeatedToolErrorKey(error.toolName, fingerprint);
      if (!seenKeys.has(key)) {
        seenKeys.add(key);
        errors.push({ ...error, fingerprint });
      }
      continue;
    }
    if (isToolResultBlock(block)) {
      hasSuccessToolResult = true;
    }
  }

  if (hasSuccessToolResult || errors.length === 0) return { kind: 'reset' };
  return { kind: 'errors', errors };
}

export function decideConsecutiveError(args: {
  toolName: string;
  fingerprint: string;
  state: ErrorObservationState;
  lastInterventionAt: number | undefined;
  threshold: number;
  interventionCooldownMs: number;
  now: number;
}): ConsecutiveErrorDecision {
  const { toolName, fingerprint, state, lastInterventionAt, threshold, interventionCooldownMs } =
    args;

  if (lastInterventionAt !== undefined && args.now - lastInterventionAt < interventionCooldownMs) {
    return { action: 'cooldown_reset' };
  }

  const sameAsLast =
    state.lastError !== null &&
    state.lastError.toolName === toolName &&
    state.lastError.fingerprint === fingerprint;

  const consecutiveCount = sameAsLast ? state.consecutiveCount + 1 : 1;

  if (consecutiveCount >= threshold) {
    return { action: 'intervene', consecutiveCount };
  }
  return { action: 'count', lastError: { toolName, fingerprint }, consecutiveCount };
}

export function buildRepeatedToolErrorEvidence(args: {
  scopeId: string;
  toolName: string;
  fingerprint: string;
  count: number;
}): { scopeId: string; summary: string; metadata: Record<string, unknown> } {
  return {
    scopeId: args.scopeId,
    summary: `Repeated tool error: ${args.toolName} failed ${args.count} consecutive times with the same error`,
    metadata: {
      tool: args.toolName,
      error: args.fingerprint,
      count: args.count,
    },
  };
}

export function buildRecoveryMessage(toolName: string, errorText: string, count: number): string {
  const shortError = errorText.length > 200 ? `${errorText.slice(0, 200)}…` : errorText;
  return [
    `⚠️ Repeated tool error detected: \`${toolName}\` failed ${count} consecutive times with the same error.`,
    '',
    `Error: ${shortError}`,
    '',
    'Stop retrying this operation. Re-validate the arguments, try an alternative path, or ask the operator for help.',
  ].join('\n');
}

function extractText(content: unknown): string {
  if (content === null || content === undefined) return '';
  if (typeof content === 'string') return content;

  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const item of content) {
      if (
        item &&
        typeof item === 'object' &&
        typeof (item as { text?: unknown }).text === 'string'
      ) {
        parts.push((item as { text: string }).text);
      } else if (typeof item === 'string') {
        parts.push(item);
      }
    }
    return parts.join(' ');
  }

  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}
