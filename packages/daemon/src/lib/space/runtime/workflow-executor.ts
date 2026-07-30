/**
 * WorkflowExecutor
 *
 * Manages workflow run state within a Space using a directed graph model.
 * Steps are nodes; transitions are edges with optional conditions.
 *
 * Responsibilities:
 * - Graph navigation (getCurrentStep, isComplete)
 * - Condition evaluation for transitions (always, human, condition, task_result)
 * - Timeout enforcement on condition-type evaluations
 *
 * In the agent-centric model, agents self-direct via send_message and by setting
 * `task.reportedStatus`. Workflow advancement is driven by agent-to-agent messaging
 * (channel routing), not by an explicit advance() call. This class provides
 * read-only graph navigation and condition evaluation utilities used by the
 * runtime and channel layer.
 */

import type { SpaceWorkflow, SpaceWorkflowRun } from '@hyperneo/shared';

// ---------------------------------------------------------------------------
// Legacy condition types (removed from @hyperneo/shared, kept locally for
// backward-compatible evaluateCondition API)
// ---------------------------------------------------------------------------

type WorkflowConditionType = 'always' | 'human' | 'condition' | 'task_result';

interface WorkflowCondition {
  type: WorkflowConditionType;
  expression?: string;
  description?: string;
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Context passed to condition evaluation.
 */
export interface ConditionContext {
  /** Absolute path to the workspace (cwd for condition-type expressions) */
  workspacePath: string;
  /**
   * Whether a human has explicitly approved advancement.
   * Set externally (e.g. via RPC) into run.config.humanApproved before retry.
   */
  humanApproved?: boolean;
  /**
   * Result string from the most recently completed task on the current node.
   * Used by `task_result` conditions for prefix matching.
   */
  taskResult?: string;
}

/** Result of a single condition evaluation attempt */
export interface ConditionResult {
  /** Whether the condition passed */
  passed: boolean;
  /** Human-readable explanation when the condition did not pass */
  reason?: string;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/**
 * Injectable command runner for condition-type evaluations.
 * The default uses Bun.spawn; tests inject a mock to avoid real subprocess calls.
 */
export type CommandRunner = (
  args: string[],
  cwd: string,
  timeoutMs: number
) => Promise<{ exitCode: number | null; timedOut?: boolean; stderr?: string }>;

// ---------------------------------------------------------------------------
// Default timeout constants
// ---------------------------------------------------------------------------

const DEFAULT_CONDITION_TIMEOUT_MS = 60_000;
const MAX_CONDITION_TIMEOUT_MS = 300_000;

// ---------------------------------------------------------------------------
// Default command runner (real Bun.spawn)
// ---------------------------------------------------------------------------

const defaultCommandRunner: CommandRunner = async (args, cwd, timeoutMs) => {
  const proc = Bun.spawn(args, {
    cwd,
    // stdout is ignored — only the exit code matters for condition evaluation.
    // stderr is piped so we can capture it for failure diagnostics.
    // IMPORTANT: drain stderr concurrently with proc.exited to prevent pipe deadlock
    // when the process writes more than ~64KB to stderr.
    stdout: 'ignore',
    stderr: 'pipe',
  });

  let killed = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;

  if (timeoutMs > 0) {
    killTimer = setTimeout(() => {
      killed = true;
      proc.kill();
    }, timeoutMs);
  }

  const [stderr] = await Promise.all([
    new Response(proc.stderr).text().catch(() => ''),
    proc.exited,
  ]);

  if (killTimer !== undefined) clearTimeout(killTimer);

  if (killed) {
    return { exitCode: null, timedOut: true, stderr };
  }
  return { exitCode: proc.exitCode, stderr };
};

// ---------------------------------------------------------------------------
// WorkflowExecutor
// ---------------------------------------------------------------------------

export class WorkflowExecutor {
  constructor(
    private workflow: SpaceWorkflow,
    private run: SpaceWorkflowRun,
    private commandRunner: CommandRunner = defaultCommandRunner
  ) {}

  // -------------------------------------------------------------------------
  // Navigation
  // -------------------------------------------------------------------------

  /**
   * Returns true when the execution attempt has finished successfully or was cancelled.
   */
  isComplete(): boolean {
    return this.run.status === 'done' || this.run.status === 'cancelled';
  }

  // -------------------------------------------------------------------------
  // Condition checks (single evaluation, no retry)
  // -------------------------------------------------------------------------

  /**
   * Evaluates a single condition against the given context.
   *
   * Condition types:
   *   always    — always passes
   *   human     — passes when context.humanApproved is true
   *   condition — runs the expression as a shell command; passes on exit code 0
   *   task_result — passes when context.taskResult starts with condition.expression
   */
  async evaluateCondition(
    condition: WorkflowCondition,
    context: ConditionContext
  ): Promise<ConditionResult> {
    switch (condition.type) {
      case 'always':
        return { passed: true };

      case 'human':
        if (context.humanApproved) {
          return { passed: true };
        }
        return { passed: false, reason: 'Waiting for human approval' };

      case 'condition': {
        if (!condition.expression || !condition.expression.trim()) {
          return { passed: false, reason: 'condition type requires a non-empty expression' };
        }
        return this.runConditionExpression(
          condition.expression,
          context.workspacePath,
          condition.timeoutMs
        );
      }

      case 'task_result': {
        if (!condition.expression || !condition.expression.trim()) {
          return {
            passed: false,
            reason: 'task_result type requires a non-empty expression',
          };
        }
        if (context.taskResult === undefined) {
          return {
            passed: false,
            reason: 'No task result available for evaluation',
          };
        }
        if (context.taskResult.startsWith(condition.expression)) {
          return { passed: true };
        }
        return {
          passed: false,
          reason: `Task result "${context.taskResult}" does not match "${condition.expression}"`,
        };
      }

      default: {
        const _exhaustive: never = condition.type;
        return { passed: false, reason: `Unknown condition type: ${_exhaustive}` };
      }
    }
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Executes a condition expression via the shell and returns whether it exited with code 0.
   *
   * The expression is passed to `sh -c` so that shell semantics (quoting, pipes,
   * redirects, arguments with spaces) work as expected.
   */
  private async runConditionExpression(
    expression: string,
    cwd: string,
    timeoutMs?: number
  ): Promise<ConditionResult> {
    const effectiveTimeout = resolveTimeout(timeoutMs);
    const args = ['sh', '-c', expression.trim()];

    let result: { exitCode: number | null; timedOut?: boolean; stderr?: string };
    try {
      result = await this.commandRunner(args, cwd, effectiveTimeout);
    } catch (err) {
      return {
        passed: false,
        reason: `Expression execution error: ${(err as Error).message}`,
      };
    }

    if (result.timedOut) {
      return { passed: false, reason: `Expression timed out after ${effectiveTimeout}ms` };
    }

    if (result.exitCode !== 0) {
      const stderrSnippet = result.stderr?.trim() ? `: ${result.stderr.slice(-500).trim()}` : '';
      return {
        passed: false,
        reason: `Expression exited with code ${result.exitCode ?? 'null'}${stderrSnippet}`,
      };
    }

    return { passed: true };
  }
}

// ---------------------------------------------------------------------------
// Module-level helpers
// ---------------------------------------------------------------------------

/** Clamps/resolves the condition timeout to the valid range. */
function resolveTimeout(timeoutMs?: number): number {
  if (!timeoutMs || timeoutMs <= 0) return DEFAULT_CONDITION_TIMEOUT_MS;
  return Math.min(timeoutMs, MAX_CONDITION_TIMEOUT_MS);
}
