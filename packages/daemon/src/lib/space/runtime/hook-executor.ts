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
} from './script-utils.ts';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnProcess } from '../../runtime-spawn/index.ts';
import { PROXY_TLS_ENV_KEYS, startupEnvValue } from '../../spawn-env.ts';
import { validateWorkflowHookResult } from '../workflow-hook-validation.ts';
import type { Connector } from './connectors/connector.ts';
import {
  getConnector,
  getRegisteredConnectorIds,
  isConnectorsLayerEnabled,
} from './connectors/connector.ts';
import './connectors/production.ts';
import './built-in-validators/index.ts';
import { getBuiltInValidator } from './built-in-validator-registry.ts';
import { resolveGithubConfigDir } from './gh-lookup-helpers.ts';

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

const RESTRICTED_ENV_PREFIXES = [
  'ANTHROPIC_',
  'CLAUDE_',
  'GLM_',
  'ZHIPU_',
  'COPILOT_',
  'HYPERNEO_',
  'NEOKAI_',
];

const RESTRICTED_ENV_KEY_PATTERN = /SECRET|TOKEN|PASSWORD|CREDENTIAL|API_KEY/i;

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

const ALWAYS_ALLOWED_ENV_KEYS = new Set([
  'PATH',
  'HOME',
  'USER',
  'SHELL',
  'LANG',
  'TERM',
  'TMPDIR',
  'SystemRoot',
  'SystemDrive',
  'ComSpec',
  'PATHEXT',
  'TEMP',
  'TMP',
  'HYPERNEO_VALIDATION_BASE_REF',
]);

const GITHUB_LOOKUP_ENV_KEYS = new Set([
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
  'GH_HOST',
  'GH_CONFIG_DIR',
]);

const SSH_ENV_KEYS = new Set(['SSH_AUTH_SOCK', 'SSH_AGENT_LAUNCHER', 'SSH_AGENT_PID']);

const CREDENTIAL_PATH_ENV_KEYS = new Set([
  'KUBECONFIG',
  'DOCKER_CONFIG',
  'NPM_CONFIG_USERCONFIG',
  'AWS_CONFIG_FILE',
  'AWS_SHARED_CREDENTIALS_FILE',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'AZURE_CONFIG_DIR',
]);

export type BuiltInValidatorFn = (context: HookExecutorContext) => Promise<WorkflowHookResult>;

function resolvePermittedConnectorAuth(lookups: string[]): {
  permitted: Set<string>;
  managed: Set<string>;
  extraEnv: Record<string, string | undefined>;
} {
  if (isConnectorsLayerEnabled()) {
    const permitted = new Set<string>();
    const managed = new Set<string>();
    const extraEnv: Record<string, string | undefined> = {};
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

  const baselineEnvKeys = new Set<string>([
    ...ALWAYS_ALLOWED_ENV_KEYS,
    ...(permittedConnectorEnvKeys.size > 0 ? PROXY_TLS_ENV_KEYS : []),
    ...permittedConnectorEnvKeys,
  ]);
  for (const key of baselineEnvKeys) {
    if (connectorManagedEnvKeys.has(key) && !permittedConnectorEnvKeys.has(key)) continue;
    const value = startupEnvValue(key);
    if (value !== undefined) env[key] = value;
  }

  for (const [key, value] of Object.entries(connectorExtraEnv)) {
    if (value !== undefined) env[key] = value;
  }

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

  const validationBaseRef = env['HYPERNEO_VALIDATION_BASE_REF'];
  if (validationBaseRef !== undefined) {
    env['HYPERNEO_VALIDATION_BASE_REF'] = validationBaseRef;
  }

  if (scriptEnv) {
    for (const [key, value] of Object.entries(scriptEnv)) {
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
