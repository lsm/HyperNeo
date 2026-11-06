export const MAX_TASK_AGENT_CRASH_RETRIES = 2;

export const DEFAULT_AGENT_NO_PROGRESS_THRESHOLD_MS = 15 * 60 * 1000;

export const DEFAULT_SILENT_STALL_ATTENTION_THRESHOLD_MS = 2 * 60 * 60 * 1000;

export const DEFAULT_AGENT_STUCK_NAG_GRACE_MS = 2 * 60 * 1000;

export const DEFAULT_TOOL_USE_ACTIVE_TTL_MS = 60 * 60 * 1000;

export const MAX_TERMINAL_ERROR_CONTINUE_RETRIES = 2;

export const MAX_BLOCKED_RUN_RETRIES = 1;

export function blockedRunAttentionKey(runId: string): string {
  return `${runId}:needs_attention`;
}
