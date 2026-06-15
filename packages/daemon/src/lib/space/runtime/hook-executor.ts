/**
 * Hook Executor
 *
 * Executes workflow hook validators (built-in or script) and returns a typed
 * WorkflowHookResult. Script validators run in a restricted environment with
 * credential stripping, timeout-based SIGKILL, and bounded stdout capture.
 */

import type {
  WorkflowHook,
  WorkflowHookResult,
  WorkflowHookScriptValidator,
  WorkflowHookValidatorId,
} from '@neokai/shared';
import {
  collectWithMaxBuffer,
  deepMergeWithDepthLimit,
  MAX_BUFFER_BYTES,
  parseJsonStdout,
} from './gate-script-executor';
import { existsSync, mkdtempSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join } from 'path';
import { validateWorkflowHookResult } from '../workflow-hook-validation';
import { createPrReadyValidator } from './built-in-validators/pr-ready-validator';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Context provided to the hook executor for building script env vars. */
export interface HookExecutorContext {
  workspacePath: string;
  runId: string;
  hookId: string;
  methodName: string;
  /** Bounded action params safe for script env serialization. */
  params: Record<string, unknown>;
  /** Original unbounded action params. Built-in validators may inspect routing fields here. */
  rawParams?: Record<string, unknown>;
  nodeId: string;
  nodeName: string;
  sessionId: string;
  taskId: string;
  workflowRunCreatedAt?: number;
  targetNode?: string;
  hookLocalState: Record<string, unknown>;
  currentArtifacts: Record<string, unknown>[];
  permittedExternalLookups: string[];
  /** Optional bounded template data from the hook definition. */
  templateData?: Record<string, unknown>;
}

/** Result of executing a single hook validator. */
export interface HookExecutorResult {
  result: WorkflowHookResult;
  error?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default timeout for hook scripts (30 seconds). */
const DEFAULT_TIMEOUT_MS = 30_000;

/** Environment variable prefixes that are stripped from the restricted env. */
const RESTRICTED_ENV_PREFIXES = ['ANTHROPIC_', 'CLAUDE_', 'GLM_', 'ZHIPU_', 'COPILOT_', 'NEOKAI_'];

/** Environment variable keys matching this regex are stripped. */
const RESTRICTED_ENV_KEY_PATTERN = /SECRET|TOKEN|PASSWORD|CREDENTIAL|API_KEY/i;

/** Keys that are always allowed regardless of prefix/pattern. */
const ALWAYS_ALLOWED_ENV_KEYS = new Set([
  'PATH',
  'HOME',
  'USER',
  'SHELL',
  'LANG',
  'TERM',
  'TMPDIR',
  'NEOKAI_VALIDATION_BASE_REF',
]);

/** GitHub credential keys — only injected when hook declares externalLookups: ['github']. */
const GITHUB_LOOKUP_ENV_KEYS = new Set([
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
  'GH_HOST',
  'GH_CONFIG_DIR',
]);

/** SSH agent / Git credential helper keys — stripped from restricted env. */
const SSH_ENV_KEYS = new Set(['SSH_AUTH_SOCK', 'SSH_AGENT_LAUNCHER', 'SSH_AGENT_PID']);

/** Credential-bearing config path variables — stripped from restricted env. */
const CREDENTIAL_PATH_ENV_KEYS = new Set([
  'KUBECONFIG',
  'DOCKER_CONFIG',
  'NPM_CONFIG_USERCONFIG',
  'AWS_CONFIG_FILE',
  'AWS_SHARED_CREDENTIALS_FILE',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'AZURE_CONFIG_DIR',
]);

// ---------------------------------------------------------------------------
// Built-in validators
// ---------------------------------------------------------------------------

export type BuiltInValidatorFn = (context: HookExecutorContext) => Promise<WorkflowHookResult>;

const BUILT_IN_VALIDATORS: Map<WorkflowHookValidatorId, BuiltInValidatorFn> = new Map();

/** Register a built-in validator by ID. Overwrites existing entries. */
export function registerBuiltInValidator(
  id: WorkflowHookValidatorId,
  fn: BuiltInValidatorFn
): void {
  BUILT_IN_VALIDATORS.set(id, fn);
}

// Default registrations — fail closed until a real validator is wired.
// Production deployments should replace these with actual checks.
const NOT_IMPLEMENTED = 'Built-in validator not yet implemented';
registerBuiltInValidator('pr_open', async () => ({ type: 'block', reason: NOT_IMPLEMENTED }));
registerBuiltInValidator('pr_mergeable', async () => ({ type: 'block', reason: NOT_IMPLEMENTED }));
registerBuiltInValidator('github_review_approved', async () => ({
  type: 'block',
  reason: NOT_IMPLEMENTED,
}));
registerBuiltInValidator('codex_review_approved', async () => ({
  type: 'block',
  reason: NOT_IMPLEMENTED,
}));
registerBuiltInValidator('artifact_exists', async () => ({
  type: 'block',
  reason: NOT_IMPLEMENTED,
}));
registerBuiltInValidator('task_reported_status', async () => ({
  type: 'block',
  reason: NOT_IMPLEMENTED,
}));
registerBuiltInValidator('pr_ready', createPrReadyValidator());

// ---------------------------------------------------------------------------
// Environment builder
// ---------------------------------------------------------------------------

function resolveGithubConfigDir(): string | undefined {
  const explicit = process.env.GH_CONFIG_DIR;
  if (explicit && existsSync(explicit)) return explicit;

  const xdgConfigHome = process.env.XDG_CONFIG_HOME;
  if (xdgConfigHome) {
    const xdgGhConfig = join(xdgConfigHome, 'gh');
    if (existsSync(xdgGhConfig)) return xdgGhConfig;
  }

  const defaultGhConfig = join(homedir(), '.config', 'gh');
  if (existsSync(defaultGhConfig)) return defaultGhConfig;

  return undefined;
}

function buildHookRestrictedEnv(
  context: HookExecutorContext,
  scriptEnv?: Record<string, string>
): Record<string, string> {
  const env: Record<string, string> = {};

  const permitGithub = context.permittedExternalLookups.includes('github');

  for (const [key, value] of Object.entries(process.env) as [string, string | undefined][]) {
    if (value === undefined) continue;

    if (ALWAYS_ALLOWED_ENV_KEYS.has(key)) {
      env[key] = value as string;
      continue;
    }

    if (GITHUB_LOOKUP_ENV_KEYS.has(key)) {
      if (permitGithub) {
        env[key] = value as string;
      }
      continue;
    }

    const isPrefixRestricted = RESTRICTED_ENV_PREFIXES.some((prefix) => key.startsWith(prefix));
    if (isPrefixRestricted) continue;

    const isKeyRestricted = RESTRICTED_ENV_KEY_PATTERN.test(key);
    if (isKeyRestricted) continue;

    if (SSH_ENV_KEYS.has(key)) continue;

    if (CREDENTIAL_PATH_ENV_KEYS.has(key)) continue;

    env[key] = value as string;
  }

  if (permitGithub) {
    const githubConfigDir = resolveGithubConfigDir();
    if (githubConfigDir) env['GH_CONFIG_DIR'] = githubConfigDir;
  }

  // Inject hook-specific environment variables
  env['NEOKAI_HOOK_ID'] = context.hookId;
  env['NEOKAI_WORKFLOW_RUN_ID'] = context.runId;
  env['NEOKAI_WORKSPACE_PATH'] = context.workspacePath;
  env['NEOKAI_METHOD_NAME'] = context.methodName;
  env['NEOKAI_NODE_ID'] = context.nodeId;
  env['NEOKAI_NODE_NAME'] = context.nodeName;
  env['NEOKAI_SESSION_ID'] = context.sessionId;
  env['NEOKAI_TASK_ID'] = context.taskId;

  const workflowRunCreatedAt = (context.workflowRunCreatedAt ??
    context.templateData?.workflowRunCreatedAt ??
    context.templateData?.runCreatedAt) as unknown;
  if (typeof workflowRunCreatedAt === 'string') {
    env['NEOKAI_WORKFLOW_START_ISO'] = workflowRunCreatedAt;
  } else if (typeof workflowRunCreatedAt === 'number' && Number.isFinite(workflowRunCreatedAt)) {
    env['NEOKAI_WORKFLOW_START_ISO'] = new Date(workflowRunCreatedAt).toISOString();
  }

  if (context.targetNode) {
    env['NEOKAI_TARGET_NODE'] = context.targetNode;
  }

  try {
    env['NEOKAI_PARAMS_JSON'] = JSON.stringify(context.params);
  } catch {
    env['NEOKAI_PARAMS_JSON'] = '{}';
  }

  try {
    env['NEOKAI_HOOK_LOCAL_STATE_JSON'] = JSON.stringify(context.hookLocalState);
  } catch {
    env['NEOKAI_HOOK_LOCAL_STATE_JSON'] = '{}';
  }

  try {
    env['NEOKAI_CURRENT_ARTIFACTS_JSON'] = JSON.stringify(context.currentArtifacts);
  } catch {
    env['NEOKAI_CURRENT_ARTIFACTS_JSON'] = '[]';
  }

  if (context.permittedExternalLookups.length > 0) {
    env['NEOKAI_PERMITTED_EXTERNAL_LOOKUPS'] = context.permittedExternalLookups.join(',');
  }

  if (context.templateData) {
    try {
      env['NEOKAI_HOOK_TEMPLATE_DATA_JSON'] = JSON.stringify(context.templateData);
    } catch {
      env['NEOKAI_HOOK_TEMPLATE_DATA_JSON'] = '{}';
    }
  }

  // Merge user-specified env (cannot override injected vars)
  if (scriptEnv) {
    for (const [key, value] of Object.entries(scriptEnv)) {
      if (
        key.startsWith('NEOKAI_HOOK_') ||
        key.startsWith('NEOKAI_WORKFLOW_') ||
        key.startsWith('NEOKAI_NODE_') ||
        key.startsWith('NEOKAI_SESSION_') ||
        key.startsWith('NEOKAI_TASK_') ||
        key.startsWith('NEOKAI_METHOD_') ||
        key.startsWith('NEOKAI_CURRENT_') ||
        key.startsWith('NEOKAI_PERMITTED_')
      ) {
        continue;
      }
      const isAllowed =
        ALWAYS_ALLOWED_ENV_KEYS.has(key) || (GITHUB_LOOKUP_ENV_KEYS.has(key) && permitGithub);
      if (!isAllowed) {
        const isPrefixRestricted = RESTRICTED_ENV_PREFIXES.some((prefix) => key.startsWith(prefix));
        if (isPrefixRestricted) continue;
        const isKeyRestricted = RESTRICTED_ENV_KEY_PATTERN.test(key);
        if (isKeyRestricted) continue;
        if (SSH_ENV_KEYS.has(key)) continue;
        if (CREDENTIAL_PATH_ENV_KEYS.has(key)) continue;
      }
      env[key] = value;
    }
  }

  return env;
}

// ---------------------------------------------------------------------------
// Script executor
// ---------------------------------------------------------------------------

/**
 * Executes a hook script validator and returns the parsed WorkflowHookResult.
 *
 * Uses Bun.spawn in array form (no shell interpolation). Runs in a restricted
 * environment with credential stripping, streaming maxBuffer enforcement, and
 * timeout-based SIGKILL.
 *
 * Exit 0 with parseable JSON stdout → parsed WorkflowHookResult
 * Non-zero / timeout / malformed stdout → block result with error reason
 */
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

  // Isolate HOME to a temp directory so restricted hooks cannot read
  // disk-backed credentials from the user profile.
  const hookHome = mkdtempSync(join(tmpdir(), 'neokai-hook-'));
  restrictedEnv['HOME'] = hookHome;

  let proc;
  try {
    proc = Bun.spawn(args, {
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
        // Kill the entire process group so background children are reaped.
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

      // Reap any background children in the process group after the main
      // script exits (success, failure, or timeout).
      try {
        if (proc.pid) {
          process.kill(-proc.pid, 'SIGKILL');
        }
      } catch {
        // process group already gone
      }

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

  // Exit 0 — parse JSON stdout as WorkflowHookResult
  const parsed = parseJsonStdout(stdoutResult.text);
  if (!parsed) {
    return {
      result: {
        type: 'block',
        reason: 'Hook script produced empty or non-JSON stdout',
      },
    };
  }

  // Validate that parsed result has a recognized type
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

  // Validate required fields for the specific result type
  const validationErrors = validateWorkflowHookResult(parsed);
  if (validationErrors.length > 0) {
    return {
      result: {
        type: 'block',
        reason: `Hook script returned malformed result: ${validationErrors.join('; ')}`,
      },
    };
  }

  // Merge parsed data into the result shape
  const result = deepMergeWithDepthLimit({}, parsed) as unknown as WorkflowHookResult;

  return { result };
}

// ---------------------------------------------------------------------------
// Hook Executor class
// ---------------------------------------------------------------------------

export interface HookExecutorConfig {
  workspacePath: string;
}

export class HookExecutor {
  constructor(private readonly config: HookExecutorConfig) {}

  async execute(hook: WorkflowHook, context: HookExecutorContext): Promise<HookExecutorResult> {
    const validator = hook.validator;

    if (validator.kind === 'built_in') {
      const fn = BUILT_IN_VALIDATORS.get(validator.id);
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
