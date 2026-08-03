/**
 * Connectors barrel (epic #2299).
 *
 * Re-exports the L2 connector contract + registry (production since P1 #2301),
 * the L3 domain-agnostic layer (`predicate.ts`, `external-state-validator.ts`,
 * promoted to production in P2 #2302), and the L4 coding-pack presets
 * (`presets.ts`).
 *
 * The L2 registry is seeded in production by `registerProductionConnectors()`
 * (see `production.ts`), imported for its side effect by the hook executor.
 * The L3/L4 preset factories register the github connector themselves so tests
 * can exercise them in isolation (idempotent — overwrites the production
 * registration).
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
