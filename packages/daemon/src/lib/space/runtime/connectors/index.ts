/**
 * Connectors spike barrel (THROWAWAY, #2300 / epic #2299).
 *
 * Re-exports the L2/L3/L4-coding-pack pieces. `registerSpikeConnectors()` is
 * the single would-be wiring point; it is gated behind
 * `HYPERNEO_WORKFLOW_CONNECTORS_SPIKE` and is NOT imported or called by any
 * production code path (the hook executor and hook engine are untouched). It
 * exists only so the abstraction is observable when an operator opts in.
 */

export type {
  Connector,
  ConnectorContext,
  ConnectorOp,
  ConnectorOutcome,
} from './connector';
export {
  clearConnectorRegistry,
  getConnector,
  getConnectorOp,
  isConnectorsSpikeEnabled,
  registerConnector,
} from './connector';
export { runGhJson } from './gh-client';
export { createGithubConnector, GITHUB_CONNECTOR_ID } from './github-connector';
export type { Path, Predicate } from './predicate';
export { evaluatePredicate, getPath } from './predicate';
export {
  createExternalStateValidator,
  type ExternalStateValidatorConfig,
  type ParamResolver,
} from './external-state-validator';
export {
  createCodexReviewBotValidator,
  createPrMergedValidator,
  createPrReadyValidatorV2,
  pollUntilAllow,
  registerGithubConnector,
} from './presets';

import { isConnectorsSpikeEnabled } from './connector';
import { registerGithubConnector } from './presets';

/**
 * Seed the connector registry with the github connector. Inert unless the
 * spike flag is set, and never invoked by production regardless — tests call
 * the preset factories directly, which register what they need.
 */
export function registerSpikeConnectors(spawnImpl: typeof Bun.spawn = Bun.spawn): void {
  if (!isConnectorsSpikeEnabled()) return;
  registerGithubConnector(spawnImpl);
}
