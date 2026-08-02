/**
 * L2 Connector abstraction — EPIC #2299 (P1 #2301).
 *
 * A Connector is a typed external-state adapter: a registry of named "ops"
 * (e.g. `github.getPr`, `github.getReactions`) plus an optional auth surface,
 * that the engine resolves generically — with no hardcoded connector ids.
 *
 * Layering:
 *   - L2 Connectors carry DOMAIN ops + auth (github knows what a PR is and
 *     which env keys it needs). This file defines only the domain-agnostic
 *     contract — `Connector`, `ConnectorOp`, `ConnectorOutcome`, `ConnectorAuth`,
 *     and the registry. The engine (`workflow-hook-engine.ts`,
 *     `workflow-hook-validation.ts`, `hook-executor.ts`) consults the registry
 *     rather than hardcoding `'github'`.
 *   - L3 `external_state` validator + `predicate` language (still experimental,
 *     gated behind `HYPERNEO_WORKFLOW_CONNECTORS_SPIKE`, see
 *     `external-state-validator.ts` / `predicate.ts`) are domain-agnostic too.
 *
 * The github connector is registered in production by `registerProductionConnectors()`
 * (see `production.ts`), imported for its side effect by the hook executor.
 */

/**
 * Outcome of a connector op.
 *
 * - `ok: true` — the lookup succeeded; `data` is the typed payload the
 *   predicate evaluates against.
 * - `ok: false` — the lookup failed. `retryable: true` (with `retryAfterMs`)
 *   signals a transient condition (e.g. GitHub rate limit, UNKNOWN
 *   mergeability) that the L3 validator maps to a `retryable_block` so the
 *   engine backs off. Non-retryable failures map to a terminal `block`.
 */
export type ConnectorOutcome =
  | { ok: true; data: unknown }
  | {
      ok: false;
      error: string;
      retryable?: boolean;
      retryAfterMs?: number;
    };

/**
 * Context handed to every connector op. Mirrors the subset of
 * `HookExecutorContext` a connector legitimately needs (workspace path +
 * bounded params/state) so ops can resolve inputs like `pr_url` without the
 * validator hardcoding field names.
 */
export interface ConnectorContext {
  workspacePath: string;
  /** Bounded action params (same projection the hook executor passes). */
  params: Record<string, unknown>;
  /** Original unbounded params (built-in validators may inspect routing here). */
  rawParams?: Record<string, unknown>;
  /** Hook-local state (e.g. a previously discovered `pr_url`). */
  hookLocalState: Record<string, unknown>;
}

/**
 * A single connector operation. Takes op-specific params (e.g.
 * `{ prUrl: '...' }`) plus the shared context, returns a `ConnectorOutcome`.
 */
export type ConnectorOp = (
  opParams: Record<string, unknown>,
  ctx: ConnectorContext
) => Promise<ConnectorOutcome>;

/**
 * Auth surface a connector exposes for SANDBOXED hook-script env injection.
 *
 * When a script hook declares `externalLookups: ['github']`, the hook executor
 * (`buildHookRestrictedEnv`) looks up each permitted connector's `auth` and:
 *   - passes through the listed `envKeys` from `process.env`, and
 *   - merges in any `resolveExtraEnv()` entries (e.g. a resolved `GH_CONFIG_DIR`).
 *
 * This is how credential injection becomes connector-driven rather than a
 * hardcoded `GITHUB_LOOKUP_ENV_KEYS` set in the executor. Connectors with no
 * credential needs omit `auth`.
 */
export interface ConnectorAuth {
  /** process.env keys to inject into a sandboxed hook env when this connector is
   *  permitted (e.g. GH_TOKEN). */
  readonly envKeys?: readonly string[];
  /** Extra derived env entries to inject when permitted. An `undefined` value
   *  skips the key. Evaluated lazily so the connector can probe the filesystem
   *  (e.g. resolve a config dir) only when actually needed. */
  readonly resolveExtraEnv?: () => Record<string, string | undefined>;
}

/**
 * A connector: an id plus its named ops (+ optional auth). The ops are where
 * domain knowledge lives; the registry, validator, and predicate never branch on
 * a connector's field names.
 */
export interface Connector {
  readonly id: string;
  readonly ops: Record<string, ConnectorOp>;
  readonly auth?: ConnectorAuth;
}

const connectorRegistry = new Map<string, Connector>();

/** Register a connector by id. Overwrites an existing entry with the same id. */
export function registerConnector(connector: Connector): void {
  connectorRegistry.set(connector.id, connector);
}

/** Look up a connector by id. Returns undefined when unregistered. */
export function getConnector(id: string): Connector | undefined {
  return connectorRegistry.get(id);
}

/** Whether a connector id is registered. Used by workflow validation to admit
 *  `externalLookups` entries generically (no hardcoded `'github'`). */
export function isRegisteredConnector(id: string): boolean {
  return connectorRegistry.has(id);
}

/** All registered connector ids. */
export function getRegisteredConnectorIds(): string[] {
  return [...connectorRegistry.keys()];
}

/** Clear the registry (test helper). */
export function clearConnectorRegistry(): void {
  connectorRegistry.clear();
}

/**
 * L2 connectors rollout gate (epic #2299, P1 #2301). Default ON: the engine
 * resolves external lookups, built-in connector deps, and sandbox env through
 * the connector registry instead of the legacy hardcoded `'github'` paths. Set
 * `HYPERNEO_WORKFLOW_CONNECTORS=0` to fall back to the legacy paths as a
 * rollback safety net.
 */
export function isConnectorsLayerEnabled(): boolean {
  return process.env.HYPERNEO_WORKFLOW_CONNECTORS !== '0';
}

/**
 * Spike gate for the experimental L3/L4 pieces (`external-state-validator.ts`,
 * `predicate.ts`, `presets.ts`). Those remain throwaway until P2 (#2302); this
 * flag keeps `registerSpikeConnectors()` (see `index.ts`) inert unless an
 * operator opts in. Distinct from `isConnectorsLayerEnabled` — the L2 layer is
 * production; the L3/L4 layer is not.
 */
export function isConnectorsSpikeEnabled(): boolean {
  return process.env.HYPERNEO_WORKFLOW_CONNECTORS_SPIKE === '1';
}
