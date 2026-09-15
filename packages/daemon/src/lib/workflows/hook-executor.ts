import type {
  WorkflowHook,
  WorkflowHookResult,
  WorkflowHookScriptValidator,
} from '@hyperneo/shared';
import {
  collectWithMaxBuffer,
  deepMergeWithDepthLimit,
  MAX_BUFFER_BYTES,
  parseJsonStdout,
} from '../utils/script-utils.ts';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnProcess } from '../runtime-spawn/index.ts';
import { validateWorkflowHookResult } from './hook-validation.ts';
import '../github/connectors/production.ts';
import './built-in-validators/index.ts';
import { getBuiltInValidator } from './built-in-validator-registry.ts';
import { buildHookRestrictedEnv } from './hook-script-env.ts';

export interface HookExecutorContext {
  workspacePath: string;
  runId: string;
  hookId: string;
  methodName: string;
  params: Record<string, unknown>;
  rawParams?: Record<string, unknown>;
  nodeId: string;
  nodeName: string;
  sessionId: string;
  taskId: string;
  workflowRunCreatedAt?: number;
  taskStatus?: string;
  targetNode?: string;
  hookLocalState: Record<string, unknown>;
  frozenPrUrl?: string;
  currentArtifacts: Record<string, unknown>[];
  permittedExternalLookups: string[];
  templateData?: Record<string, unknown>;
}

export interface HookExecutorResult {
  result: WorkflowHookResult;
  error?: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export type BuiltInValidatorFn = (context: HookExecutorContext) => Promise<WorkflowHookResult>;

export async function executeHookScript(
  validator: WorkflowHookScriptValidator,
  context: HookExecutorContext
): Promise<HookExecutorResult> {
  const timeoutMs = validator.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let args: string[];
  switch (validator.interpreter) {
    case 'bash':
      args = ['bash', '-c', validator.source];
      break;
    default:
      return {
        result: {
          type: 'block',
          reason: `Unknown interpreter: ${validator.interpreter as string}`,
        },
      };
  }

  const restrictedEnv = buildHookRestrictedEnv(context);

  const hookHome = mkdtempSync(join(tmpdir(), 'hyperneo-hook-'));
  restrictedEnv['HOME'] = hookHome;

  let proc;
  try {
    proc = spawnProcess(args, {
      cwd: context.workspacePath,
      env: restrictedEnv,
      stdout: 'pipe',
      stderr: 'pipe',
      detached: true,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      result: {
        type: 'block',
        reason: `Failed to spawn ${validator.interpreter}: ${message}`,
      },
    };
  }

  const controller = new AbortController();
  let killed = false;

  const [stdoutResult, stderrResult, exitCode] = await Promise.all([
    collectWithMaxBuffer(proc.stdout, MAX_BUFFER_BYTES, controller.signal),
    collectWithMaxBuffer(proc.stderr, MAX_BUFFER_BYTES, controller.signal),
    (async () => {
      const killTimer = setTimeout(() => {
        killed = true;
        try {
          if (proc.pid) {
            process.kill(-proc.pid, 'SIGKILL');
          } else {
            proc.kill('SIGKILL');
          }
        } catch {
          proc.kill('SIGKILL');
        }
        controller.abort();
      }, timeoutMs);

      const code = await proc.exited;
      clearTimeout(killTimer);

      try {
        if (proc.pid) {
          process.kill(-proc.pid, 'SIGKILL');
        }
      } catch {}

      return { code, timedOut: killed };
    })(),
  ]);

  if (exitCode.timedOut) {
    return {
      result: {
        type: 'block',
        reason: `Hook script timed out after ${timeoutMs}ms`,
      },
    };
  }

  if (exitCode.code !== 0) {
    const stderrText = stderrResult.text.trim();
    return {
      result: {
        type: 'block',
        reason: stderrText || `Hook script exited with code ${exitCode.code}`,
      },
    };
  }

  const parsed = parseJsonStdout(stdoutResult.text);
  if (!parsed) {
    return {
      result: {
        type: 'block',
        reason: 'Hook script produced empty or non-JSON stdout',
      },
    };
  }

  const validTypes = new Set([
    'allow',
    'block',
    'retryable_block',
    'patch_params',
    'emit_follow_up',
    'record_state',
  ]);
  if (typeof parsed.type !== 'string' || !validTypes.has(parsed.type)) {
    return {
      result: {
        type: 'block',
        reason: `Hook script returned unrecognized result type: ${JSON.stringify(parsed.type)}`,
      },
    };
  }

  const validationErrors = validateWorkflowHookResult(parsed);
  if (validationErrors.length > 0) {
    return {
      result: {
        type: 'block',
        reason: `Hook script returned malformed result: ${validationErrors.join('; ')}`,
      },
    };
  }

  const result = deepMergeWithDepthLimit({}, parsed) as unknown as WorkflowHookResult;

  return { result };
}

export interface HookExecutorConfig {
  workspacePath: string;
}

export class HookExecutor {
  constructor(private readonly config: HookExecutorConfig) {}

  async execute(hook: WorkflowHook, context: HookExecutorContext): Promise<HookExecutorResult> {
    const validator = hook.validator;

    if (validator.kind === 'built_in') {
      const fn = getBuiltInValidator(validator.id);
      if (!fn) {
        return {
          result: {
            type: 'block',
            reason: `Built-in validator "${validator.id}" is not registered`,
          },
        };
      }
      const result = await fn(context);
      return { result };
    }

    return executeHookScript(validator, context);
  }
}
