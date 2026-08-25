import type { WorkflowHookValidatorId } from '@hyperneo/shared';
import { spawnProcess, type SpawnFn } from '../../../runtime-spawn/index.ts';
import { registerConnector } from './connector.ts';
import { createGithubConnector, GITHUB_CONNECTOR_ID } from './github-connector.ts';

const BUILT_IN_CONNECTOR_DEPS = new Map<WorkflowHookValidatorId, readonly string[]>([]);

export function registerBuiltInConnectorDeps(
  validatorId: WorkflowHookValidatorId,
  connectorIds: readonly string[]
): void {
  BUILT_IN_CONNECTOR_DEPS.set(validatorId, connectorIds);
}

export function getBuiltInConnectorDeps(validatorId: WorkflowHookValidatorId): readonly string[] {
  return BUILT_IN_CONNECTOR_DEPS.get(validatorId) ?? [];
}

export function clearBuiltInConnectorDeps(): void {
  BUILT_IN_CONNECTOR_DEPS.clear();
}

export function registerProductionConnectors(spawnImpl: SpawnFn = spawnProcess): void {
  registerConnector(createGithubConnector(spawnImpl));
  registerBuiltInConnectorDeps('pr_ready', [GITHUB_CONNECTOR_ID]);
  registerBuiltInConnectorDeps('pr_merged', [GITHUB_CONNECTOR_ID]);
  registerBuiltInConnectorDeps('review_posted', [GITHUB_CONNECTOR_ID]);
  registerBuiltInConnectorDeps('codex_review_approved', [GITHUB_CONNECTOR_ID]);
}

registerProductionConnectors();
