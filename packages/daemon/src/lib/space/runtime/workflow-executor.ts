import type { SpaceWorkflow, SpaceWorkflowRun, WorkflowCondition } from '@hyperneo/shared';
import { spawnProcess } from '../../runtime-spawn/index.ts';
import { buildWorkflowConditionEnv } from '../../spawn-env.ts';

export interface ConditionContext {
  workspacePath: string;
  humanApproved?: boolean;
  taskResult?: string;
}

export interface ConditionResult {
  passed: boolean;
  reason?: string;
}

export type CommandRunner = (
  args: string[],
  cwd: string,
  timeoutMs: number,
  env?: Record<string, string>
) => Promise<{ exitCode: number | null; timedOut?: boolean; stderr?: string }>;

const DEFAULT_CONDITION_TIMEOUT_MS = 60_000;
const MAX_CONDITION_TIMEOUT_MS = 300_000;

const defaultCommandRunner: CommandRunner = async (args, cwd, timeoutMs, env) => {
  const proc = spawnProcess(args, {
    cwd,
    env: env ?? buildWorkflowConditionEnv(undefined),
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

export class WorkflowExecutor {
  constructor(
    private workflow: SpaceWorkflow,
    private run: SpaceWorkflowRun,
    private commandRunner: CommandRunner = defaultCommandRunner
  ) {}

  isComplete(): boolean {
    return this.run.status === 'done' || this.run.status === 'cancelled';
  }

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
          condition.timeoutMs,
          condition.allowedEnv
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

  private async runConditionExpression(
    expression: string,
    cwd: string,
    timeoutMs?: number,
    allowedEnv?: string[]
  ): Promise<ConditionResult> {
    const effectiveTimeout = resolveTimeout(timeoutMs);
    const args = ['sh', '-c', expression.trim()];
    const env = buildWorkflowConditionEnv(allowedEnv);

    let result: { exitCode: number | null; timedOut?: boolean; stderr?: string };
    try {
      result = await this.commandRunner(args, cwd, effectiveTimeout, env);
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

function resolveTimeout(timeoutMs?: number): number {
  if (!timeoutMs || timeoutMs <= 0) return DEFAULT_CONDITION_TIMEOUT_MS;
  return Math.min(timeoutMs, MAX_CONDITION_TIMEOUT_MS);
}
