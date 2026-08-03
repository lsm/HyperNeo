/**
 * Production connector wiring (epic #2299, P1 #2301).
 *
 * The single place that binds concrete connectors to the engine:
 *   - registers the github connector (the one connector today), and
 *   - declares which connectors each built-in validator depends on.
 *
 * The hook engine and hook executor consult `getBuiltInConnectorDeps()` and the
 * registry instead of hardcoding `'github'`, so adding a connector or a new
 * built-in is a registration change here, not an engine special-case (the
 * epic's honesty test). Imported for its side effect by the hook executor
 * (`hook-executor.ts`), which guarantees registration before any hook runs.
 */

import type { WorkflowHookValidatorId } from '@hyperneo/shared';
import { registerConnector } from './connector';
import { GITHUB_CONNECTOR_ID, createGithubConnector } from './github-connector';

/**
 * Built-in validator → connector deps. Replaces the engine's old
 * `id === 'pr_ready' ? ['github'] : []` special-case with a generic registry
 * lookup. Both `pr_ready` and `pr_merged` carry a github external-state
 * dependency (they resolve a PR via the github connector).
 */
const BUILT_IN_CONNECTOR_DEPS = new Map<WorkflowHookValidatorId, readonly string[]>([]);

/** Declare the connectors a built-in validator needs. Idempotent. */
export function registerBuiltInConnectorDeps(
  validatorId: WorkflowHookValidatorId,
  connectorIds: readonly string[]
): void {
  BUILT_IN_CONNECTOR_DEPS.set(validatorId, connectorIds);
}

/** Resolve the connector ids a built-in validator depends on (empty when none). */
export function getBuiltInConnectorDeps(validatorId: WorkflowHookValidatorId): readonly string[] {
  return BUILT_IN_CONNECTOR_DEPS.get(validatorId) ?? [];
}

/**
 * Clear the built-in deps map. Mirrors `clearConnectorRegistry()` (in
 * `connector.ts`) so tests can fully reset connector state — the deps map and
 * the connector registry are separate module-level Maps, so a test that calls
 * only `clearConnectorRegistry()` would leave deps populated. Reset both for a
 * clean slate.
 */
export function clearBuiltInConnectorDeps(): void {
  BUILT_IN_CONNECTOR_DEPS.clear();
}

/**
 * Seed the connector registry + built-in deps for production. Safe to call
 * repeatedly (registration overwrites). Invoked once at module load (below) and
 * may be re-invoked by tests after clearing the registry.
 */
export function registerProductionConnectors(spawnImpl: typeof Bun.spawn = Bun.spawn): void {
  registerConnector(createGithubConnector(spawnImpl));
  registerBuiltInConnectorDeps('pr_ready', [GITHUB_CONNECTOR_ID]);
  registerBuiltInConnectorDeps('pr_merged', [GITHUB_CONNECTOR_ID]);
}

// Register at module load so importing the hook executor (or anything that
// validates/workflows through the runtime) seeds the registry before use.
registerProductionConnectors();
