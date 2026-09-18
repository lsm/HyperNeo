import type { WorkflowHook, WorkflowRunArtifact } from '@hyperneo/shared';
import { isConnectorsLayerEnabled } from '../github/connectors/connector.ts';
import { getBuiltInConnectorDeps } from '../github/connectors/production.ts';
import type { HookActionMeta, HookEngineConfig } from './hook-engine.ts';
import type { HookExecutorContext } from './hook-executor.ts';
import { boundArtifactData, boundHookLocalState, boundParams } from './hook-param-bounds.ts';

export const PR_READY_VALIDATED_IDENTITY_HOOK_ID = '__pr_ready_validated_identity__';

const MAX_ARTIFACTS_ARRAY_BYTES = 65_536;

function resolveFrozenPrUrl(config: HookEngineConfig): string | undefined {
  try {
    const st = config.hookStateRepo.get(
      config.addressing.scopeId,
      PR_READY_VALIDATED_IDENTITY_HOOK_ID
    );
    const url =
      st && typeof st.localState?.pr_url === 'string' ? (st.localState.pr_url as string) : '';
    return url || undefined;
  } catch {
    return undefined;
  }
}

export async function buildExecutorContext(
  config: HookEngineConfig,
  hook: WorkflowHook,
  methodName: string,
  params: Record<string, unknown>,
  meta: HookActionMeta
): Promise<HookExecutorContext> {
  const nodeName = config.addressing.resolveSourceName(meta);

  const hookState = config.hookStateRepo.ensure(
    config.addressing.scopeId,
    hook.id,
    hook.localState?.defaults ?? {}
  );

  let hookLocalState = hookState.localState;
  if (hook.localState?.recentResultRef) {
    const ref = hook.localState.recentResultRef;
    const refState = config.hookStateRepo.get(config.addressing.scopeId, ref.hookId);
    if (refState?.lastResult !== undefined) {
      hookLocalState = { ...hookLocalState, [ref.key]: refState.lastResult };
    }
  }

  let currentArtifacts: WorkflowRunArtifact[] = [];
  try {
    const all = config.artifactRepo?.listByRun(config.addressing.scopeId) ?? [];
    currentArtifacts = all
      .slice()
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 50);
  } catch {}

  const permittedExternalLookups: string[] =
    hook.validator.kind === 'script'
      ? (hook.validator.externalLookups ?? [])
      : isConnectorsLayerEnabled()
        ? [...getBuiltInConnectorDeps(hook.validator.id)]
        : hook.validator.id === 'pr_ready'
          ? ['github']
          : [];

  const mappedArtifacts: Array<{
    id: string;
    nodeId: string;
    type: string;
    key: string;
    data: unknown;
    createdAt: number;
    updatedAt: number;
  }> = [];
  for (const a of currentArtifacts) {
    const item = {
      id: a.id,
      nodeId: a.nodeId,
      type: a.artifactType,
      key: a.artifactKey,
      data: boundArtifactData(a.data),
      createdAt: a.createdAt,
      updatedAt: a.updatedAt,
    };
    const candidate = [...mappedArtifacts, item];
    const bytes = new TextEncoder().encode(JSON.stringify(candidate)).length;
    if (bytes > MAX_ARTIFACTS_ARRAY_BYTES) break;
    mappedArtifacts.push(item);
  }

  return {
    workspacePath: config.workspacePath ?? '',
    runId: config.addressing.scopeId,
    hookId: hook.id,
    workflowRunCreatedAt: config.workflowRunCreatedAt,
    methodName,
    params: boundParams(params),
    rawParams: params,
    nodeId: meta.nodeId,
    nodeName,
    sessionId: meta.sessionId,
    taskId: meta.taskId,
    taskStatus: config.getTaskStatus?.(meta.taskId),
    targetNode: hook.targetNode ?? meta.targetNode,
    hookLocalState: boundHookLocalState(hookLocalState),
    frozenPrUrl: resolveFrozenPrUrl(config),
    currentArtifacts: mappedArtifacts,
    permittedExternalLookups,
    templateData: hook.templateData,
  };
}
