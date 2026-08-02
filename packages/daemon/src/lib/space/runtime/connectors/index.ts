/**
 * Connectors barrel (epic #2299 / P1 #2301).
 *
 * Re-exports the L2 connector pieces (now production) and the experimental L3/L4
 * pieces (still gated behind `HYPERNEO_WORKFLOW_CONNECTORS_SPIKE`).
 *
 * The L2 registry is seeded in production by `registerProductionConnectors()`
 * (see `production.ts`), imported for its side effect by the hook executor.
 * `registerSpikeConnectors()` remains for the L3/L4 experimental layer and is
 * inert unless the spike flag is set.
 */

export type {
  Connector,
  ConnectorAuth,
  ConnectorContext,
  ConnectorOp,
  ConnectorOutcome,
} from './connector';
export {
  clearConnectorRegistry,
  getConnector,
  getRegisteredConnectorIds,
  isConnectorsLayerEnabled,
  isConnectorsSpikeEnabled,
  isRegisteredConnector,
  registerConnector,
} from './connector';
export { runGhJson } from '../gh-lookup-helpers';
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
 * Seed the connector registry with the github connector for the EXPERIMENTAL
 * L3/L4 spike. Inert unless the spike flag is set, and redundant with
 * `registerProductionConnectors()` (which always registers github) regardless —
 * kept so the spike presets can be exercised in isolation. Tests call the preset
 * factories directly, which register what they need.
 */
export function registerSpikeConnectors(spawnImpl: typeof Bun.spawn = Bun.spawn): void {
  if (!isConnectorsSpikeEnabled()) return;
  registerGithubConnector(spawnImpl);
}
