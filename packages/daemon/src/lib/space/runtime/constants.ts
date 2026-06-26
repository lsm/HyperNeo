/**
 * Space Runtime Constants
 *
 * Shared configuration constants for the Space runtime layer.
 */

// ---------------------------------------------------------------------------
// Crash retry constants
// ---------------------------------------------------------------------------

/**
 * Maximum number of crash-and-retry cycles allowed for a single task agent
 * before the task is escalated to `needs_attention`.
 *
 * When an agent session is detected as dead:
 *   - If the task has crashed fewer than MAX_TASK_AGENT_CRASH_RETRIES times,
 *     it is reset to `pending` for re-spawn (transient failure recovery).
 *   - Once the limit is reached, the task transitions to `needs_attention` so
 *     a human can investigate before any further retries are attempted.
 *
 * This prevents silent infinite crash loops while still tolerating the
 * transient startup failures common in CI and cold-start environments.
 */
export const MAX_TASK_AGENT_CRASH_RETRIES = 2;

/**
 * Maximum silence window for an alive node-agent session before the runtime
 * treats a non-terminal last message as no observable progress.
 *
 * This is deliberately conservative: long-running agents are allowed, but an
 * alive session whose latest meaningful SDK message is old and non-terminal is
 * eligible for Layer 1 runtime recovery.
 */
export const DEFAULT_AGENT_NO_PROGRESS_THRESHOLD_MS = 15 * 60 * 1000;

/** Maximum runtime nudges sent to an alive stuck session before restart/block. */
export const MAX_AGENT_STUCK_NAGS = 1;

/**
 * Minimum wait after a runtime nag before restart/block recovery can proceed.
 *
 * Runtime nags are injected as synthetic user messages. If an agent is already
 * processing, that message can be queued but not yet consumed; this cooldown
 * prevents the next tick from restarting a live session before the agent has a
 * chance to reach a turn boundary and observe the nudge.
 */
export const DEFAULT_AGENT_STUCK_NAG_GRACE_MS = 2 * 60 * 1000;

/** Maximum time an SDK tool_use stays active for runtime recovery guards. */
export const DEFAULT_TOOL_USE_ACTIVE_TTL_MS = 60 * 60 * 1000;

/** Maximum per-agent session restarts for alive-but-stuck recovery. */
export const MAX_AGENT_STUCK_RESTARTS = 1;

/**
 * Maximum number of automatic "continue" injections for a node-agent session
 * that ended on a terminal error result (e.g. Codex 400, error_during_execution).
 *
 * A worker whose SDK stream terminates with an error subtype leaves the node
 * idle with a *live* session and no recovery fires — this cap bounds the
 * runtime's auto-continue before escalating to `blocked` (where
 * `attemptBlockedRunRecovery`, capped by `MAX_BLOCKED_RUN_RETRIES`, takes over
 * with a fresh re-spawn). Deterministic repeats (identical error signature) are
 * escalated immediately regardless of this count, since a plain continue cannot
 * fix them.
 */
export const MAX_TERMINAL_ERROR_CONTINUE_RETRIES = 2;

/**
 * Maximum number of automatic recovery attempts for a blocked workflow run.
 *
 * When a workflow run enters `blocked` status (e.g. a node agent failed after
 * exhausting its reminder attempts), the runtime will automatically:
 *   1. Reset the blocked node execution to `pending` for re-spawn.
 *   2. Transition the run back to `in_progress`.
 *   3. Emit a `task_retry` notification to the Space Agent.
 *
 * Once this limit is reached, the run stays blocked and a
 * `workflow_run_needs_attention` event is emitted for human/Space Agent
 * escalation.
 */
export const MAX_BLOCKED_RUN_RETRIES = 1;

/**
 * Maximum number of retry attempts for transient network errors
 * (e.g. `gh` CLI commands that fail with a network error).
 *
 * Total attempts = 1 initial + MAX_NETWORK_RETRIES retries.
 */
export const MAX_NETWORK_RETRIES = 3;

/**
 * Delay in milliseconds between successive retry attempts.
 * Index 0 = delay before attempt 2, index 1 = before attempt 3, etc.
 * The last entry is reused for any remaining attempts beyond the array length.
 */
export const NETWORK_RETRY_DELAYS_MS: readonly number[] = [5_000, 10_000, 20_000] as const;
