import type { WorkSummary } from './types.ts';

export type ClaudeRuntimeIdentity = Pick<WorkSummary, 'model' | 'effort' | 'identityObservation'>;

type AssistantIdentityEntry = {
  type?: unknown;
  isSidechain?: unknown;
  uuid?: unknown;
  effort?: unknown;
  perTurnEffort?: unknown;
  message?: { model?: unknown };
};

function recordedValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() && value !== 'unknown' ? value : undefined;
}

export function observeClaudeIdentity(
  entry: AssistantIdentityEntry,
  at: number | undefined
): ClaudeRuntimeIdentity | null {
  if (entry.type !== 'assistant' || entry.isSidechain === true) return null;
  const model = recordedValue(entry.message?.model);
  const effort = recordedValue(
    entry.perTurnEffort !== undefined ? entry.perTurnEffort : entry.effort
  );
  if (!model && !effort) return {};
  return {
    ...(model && !model.startsWith('<') ? { model } : {}),
    ...(effort ? { effort } : {}),
    identityObservation: {
      source: 'assistant-transcript',
      ...(at !== undefined ? { at } : {}),
      ...(typeof entry.uuid === 'string' && entry.uuid ? { messageId: entry.uuid } : {}),
    },
  };
}

export function withClaudeIdentity(
  identity: ClaudeRuntimeIdentity | null | undefined
): ClaudeRuntimeIdentity {
  return {
    ...(identity?.model ? { model: identity.model } : {}),
    ...(identity?.effort ? { effort: identity.effort } : {}),
    ...(identity?.identityObservation ? { identityObservation: identity.identityObservation } : {}),
  };
}
