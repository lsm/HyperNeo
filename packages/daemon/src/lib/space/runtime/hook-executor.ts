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
} from '@hyperneo/shared';
import {
  collectWithMaxBuffer,
  deepMergeWithDepthLimit,
  MAX_BUFFER_BYTES,
  parseJsonStdout,
} from './script-utils';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { validateWorkflowHookResult } from '../workflow-hook-validation';
import type { Connector } from './connectors/connector';
import {
  getConnector,
  getRegisteredConnectorIds,
  isConnectorsLayerEnabled,
} from './connectors/connector';
// Side-effect: seeds the connector registry + built-in connector deps so the
// engine never sees an empty registry (see connectors/production.ts).
import './connectors/production';
// Side-effect: seeds the built-in validator registry (named presets, e.g.
// `pr_ready`/`pr_merged`) so dispatch + validation need no hardcoded ids. Also
// imported for its side effect by workflow-hook-validation.ts; ESM loads it
// once. (epic #2299, P2 #2302)
import './built-in-validators';
import { getBuiltInValidator } from './built-in-validator-registry';
import { resolveGithubConfigDir } from './gh-lookup-helpers';

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
  /**
   * Current status of the owning Space task (e.g. `'in_progress'`, `'approved'`,
   * `'done'`). Built-in validators use this to distinguish execution phases —
   * e.g. a `pr_ready` exemption for post-approval merge-blocker reports must
   * only fire while the task is `approved`, so an initial implementation
   * handoff cannot spoof it. Optional: omitted when the engine has no task
   * status provider.
   */
  taskStatus?: string;
  targetNode?: string;
  hookLocalState: Record<string, unknown>;
  /**
   * The run's frozen reviewed PR URL — the pr_url stamped by the `pr_ready`
   * validator's hook (the only source after the engine gates pr_url stamping on
   * that validator). Built-in validators that gate post-approval handoffs (e.g.
   * `post_approval_only`) compare the caller-supplied `pr_url` against this to
   * stop a prompt-injected post-approval worker from redirecting the approval
   * authority to a different PR. Undefined when no pr_ready handoff has frozen
   * an identity yet (the run's first handoff).
   */
  frozenPrUrl?: string;
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

/** Environment variable prefixes that are stripped from the restricted env.
 * `NEOKAI_` is retained as a stripped prefix so stale legacy internals from old
 * deployments do not leak into hook scripts, even though no NEOKAI_* aliases are
 * injected or read.
 */
const RESTRICTED_ENV_PREFIXES = [
  'ANTHROPIC_',
  'CLAUDE_',
  'GLM_',
  'ZHIPU_',
  'COPILOT_',
  'HYPERNEO_',
  'NEOKAI_',
];

/** Environment variable keys matching this regex are stripped. */
const RESTRICTED_ENV_KEY_PATTERN = /SECRET|TOKEN|PASSWORD|CREDENTIAL|API_KEY/i;

/**
 * Hook-specific env vars injected into every hook script under the canonical
 * `HYPERNEO_*` names.
 */
const HOOK_INJECTED_ENV_KEYS = new Set([
  'HYPERNEO_HOOK_ID',
  'HYPERNEO_WORKFLOW_RUN_ID',
  'HYPERNEO_WORKSPACE_PATH',
  'HYPERNEO_METHOD_NAME',
  'HYPERNEO_NODE_ID',
  'HYPERNEO_NODE_NAME',
  'HYPERNEO_SESSION_ID',
  'HYPERNEO_TASK_ID',
  'HYPERNEO_WORKFLOW_START_ISO',
  'HYPERNEO_TARGET_NODE',
  'HYPERNEO_PARAMS_JSON',
  'HYPERNEO_HOOK_LOCAL_STATE_JSON',
  'HYPERNEO_CURRENT_ARTIFACTS_JSON',
  'HYPERNEO_PERMITTED_EXTERNAL_LOOKUPS',
  'HYPERNEO_HOOK_TEMPLATE_DATA_JSON',
]);

/** Keys that are always allowed regardless of prefix/pattern. */
const ALWAYS_ALLOWED_ENV_KEYS = new Set([
  'PATH',
  'HOME',
  'USER',
  'SHELL',
  'LANG',
  'TERM',
  'TMPDIR',
  'HYPERNEO_VALIDATION_BASE_REF',
]);

/**
 * GitHub credential keys for the LEGACY env-injection fallback (used only when
 * `HYPERNEO_WORKFLOW_CONNECTORS=0`). The connectors-layer path reads this exact
 * surface from the github connector's `auth.envKeys` instead.
 */
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

/**
 * Signature every named preset (built-in validator) exposes. Concrete presets
 * are registered in `built-in-validators/index.ts` (e.g. `pr_ready` /
 * `pr_merged`) and dispatched generically via `getBuiltInValidator` from the
 * registry — the engine branches on no validator id (epic #2299, ADR #2).
 */
export type BuiltInValidatorFn = (context: HookExecutorContext) => Promise<WorkflowHookResult>;

// ---------------------------------------------------------------------------
// Environment builder
// ---------------------------------------------------------------------------

/**
 * Resolve the env-key sets + derived extras a sandboxed script hook may receive,
 * driven by its permitted connectors. When the connectors layer is enabled
 * (default), each permitted connector's `auth.envKeys` are admitted and its
 * `auth.resolveExtraEnv()` merged in — replacing the old hardcoded
 * `GITHUB_LOOKUP_ENV_KEYS` + `permitGithub` special-case. The legacy branch is
 * kept verbatim as a rollback fallback (`HYPERNEO_WORKFLOW_CONNECTORS=0`).
 *
 * `permitted` admits a key only for a connector the hook actually declared;
 * `managed` is the superset across ALL registered connectors. Connector auth
 * keys (e.g. GH_CONFIG_DIR, GH_HOST) don't match the SECRET/TOKEN strip
 * pattern, so without the managed set they would leak to hooks that omitted the
 * connector — they must be denied by default and admitted only when permitted.
 */
function resolvePermittedConnectorAuth(lookups: string[]): {
  permitted: Set<string>;
  managed: Set<string>;
  extraEnv: Record<string, string | undefined>;
} {
  if (isConnectorsLayerEnabled()) {
    const permitted = new Set<string>();
    const managed = new Set<string>();
    const extraEnv: Record<string, string | undefined> = {};
    // Every registered connector's auth keys are "managed" — denied unless that
    // connector is in `lookups`.
    for (const id of getRegisteredConnectorIds()) {
      const connector = getConnector(id);
      for (const key of connector?.auth?.envKeys ?? []) managed.add(key);
    }
    for (const id of lookups) {
      const connector: Connector | undefined = getConnector(id);
      if (!connector?.auth) continue;
      for (const key of connector.auth.envKeys ?? []) permitted.add(key);
      if (connector.auth.resolveExtraEnv) {
        for (const [key, value] of Object.entries(connector.auth.resolveExtraEnv())) {
          extraEnv[key] = value;
        }
      }
    }
    return { permitted, managed, extraEnv };
  }
  // Legacy fallback (pre-connectors): only 'github' is recognized.
  const permitGithub = lookups.includes('github');
  return {
    permitted: permitGithub ? new Set(GITHUB_LOOKUP_ENV_KEYS) : new Set(),
    managed: new Set(GITHUB_LOOKUP_ENV_KEYS),
    extraEnv: permitGithub ? { GH_CONFIG_DIR: resolveGithubConfigDir() } : {},
  };
}

function buildHookRestrictedEnv(
  context: HookExecutorContext,
  scriptEnv?: Record<string, string>
): Record<string, string> {
  const env: Record<string, string> = {};

  const {
    permitted: permittedConnectorEnvKeys,
    managed: connectorManagedEnvKeys,
    extraEnv: connectorExtraEnv,
  } = resolvePermittedConnectorAuth(context.permittedExternalLookups);

  for (const [key, value] of Object.entries(process.env) as [string, string | undefined][]) {
    if (value === undefined) continue;

    if (ALWAYS_ALLOWED_ENV_KEYS.has(key)) {
      env[key] = value as string;
      continue;
    }

    if (permittedConnectorEnvKeys.has(key)) {
      env[key] = value as string;
      continue;
    }

    // A connector-managed credential key whose connector was NOT permitted is
    // denied — these keys bypass the SECRET/TOKEN strip pattern below, so
    // without this they would leak to hooks that omitted the connector.
    if (connectorManagedEnvKeys.has(key)) continue;

    const isPrefixRestricted = RESTRICTED_ENV_PREFIXES.some((prefix) => key.startsWith(prefix));
    if (isPrefixRestricted) continue;

    const isKeyRestricted = RESTRICTED_ENV_KEY_PATTERN.test(key);
    if (isKeyRestricted) continue;

    if (SSH_ENV_KEYS.has(key)) continue;

    if (CREDENTIAL_PATH_ENV_KEYS.has(key)) continue;

    env[key] = value as string;
  }

  // Connector-derived extras (e.g. resolved GH_CONFIG_DIR) override any same-key
  // process.env value passed through above — matching the legacy precedence.
  for (const [key, value] of Object.entries(connectorExtraEnv)) {
    if (value !== undefined) env[key] = value;
  }

  // Inject hook-specific environment variables
  env['HYPERNEO_HOOK_ID'] = context.hookId;
  env['HYPERNEO_WORKFLOW_RUN_ID'] = context.runId;
  env['HYPERNEO_WORKSPACE_PATH'] = context.workspacePath;
  env['HYPERNEO_METHOD_NAME'] = context.methodName;
  env['HYPERNEO_NODE_ID'] = context.nodeId;
  env['HYPERNEO_NODE_NAME'] = context.nodeName;
  env['HYPERNEO_SESSION_ID'] = context.sessionId;
  env['HYPERNEO_TASK_ID'] = context.taskId;

  const workflowRunCreatedAt = (context.workflowRunCreatedAt ??
    context.templateData?.workflowRunCreatedAt ??
    context.templateData?.runCreatedAt) as unknown;
  if (typeof workflowRunCreatedAt === 'string') {
    env['HYPERNEO_WORKFLOW_START_ISO'] = workflowRunCreatedAt;
  } else if (typeof workflowRunCreatedAt === 'number' && Number.isFinite(workflowRunCreatedAt)) {
    env['HYPERNEO_WORKFLOW_START_ISO'] = new Date(workflowRunCreatedAt).toISOString();
  }

  if (context.targetNode) {
    env['HYPERNEO_TARGET_NODE'] = context.targetNode;
  }

  try {
    env['HYPERNEO_PARAMS_JSON'] = JSON.stringify(context.params);
  } catch {
    env['HYPERNEO_PARAMS_JSON'] = '{}';
  }

  try {
    env['HYPERNEO_HOOK_LOCAL_STATE_JSON'] = JSON.stringify(context.hookLocalState);
  } catch {
    env['HYPERNEO_HOOK_LOCAL_STATE_JSON'] = '{}';
  }

  try {
    env['HYPERNEO_CURRENT_ARTIFACTS_JSON'] = JSON.stringify(context.currentArtifacts);
  } catch {
    env['HYPERNEO_CURRENT_ARTIFACTS_JSON'] = '[]';
  }

  if (context.permittedExternalLookups.length > 0) {
    env['HYPERNEO_PERMITTED_EXTERNAL_LOOKUPS'] = context.permittedExternalLookups.join(',');
  }

  if (context.templateData) {
    try {
      env['HYPERNEO_HOOK_TEMPLATE_DATA_JSON'] = JSON.stringify(context.templateData);
    } catch {
      env['HYPERNEO_HOOK_TEMPLATE_DATA_JSON'] = '{}';
    }
  }

  // Resolve the validation base override from process env.
  const validationBaseRef = env['HYPERNEO_VALIDATION_BASE_REF'];
  if (validationBaseRef !== undefined) {
    env['HYPERNEO_VALIDATION_BASE_REF'] = validationBaseRef;
  }

  // Merge user-specified env (cannot override injected vars)
  if (scriptEnv) {
    for (const [key, value] of Object.entries(scriptEnv)) {
      // User env cannot override hook-injected vars (HYPERNEO_*)
      if (HOOK_INJECTED_ENV_KEYS.has(key)) {
        continue;
      }
      const isAllowed = ALWAYS_ALLOWED_ENV_KEYS.has(key) || permittedConnectorEnvKeys.has(key);
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
  const hookHome = mkdtempSync(join(tmpdir(), 'hyperneo-hook-'));
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
