/**
 * L2 Connector abstraction — EPIC #2299 / SPIKE #2300 (THROWAWAY).
 *
 * A Connector is a typed external-state adapter: a registry of named "ops"
 * (e.g. `github.getPr`, `github.getReactions`) that the generic L3
 * `external_state` validator (see `external-state-validator.ts`) calls and
 * evaluates a domain-agnostic predicate against.
 *
 * Layering (the whole point of the spike):
 *   - L2 Connectors carry DOMAIN ops (github knows what a PR is). This file
 *     defines only the domain-agnostic contract — `Connector`, `ConnectorOp`,
 *     `ConnectorOutcome`, and a registry.
 *   - L3 `external_state` validator + `predicate` language are domain-agnostic
 *     (no PR/codex terms). See `external-state-validator.ts` / `predicate.ts`.
 *
 * NOT WIRED INTO THE ENGINE. This module is imported only by other throwaway
 * spike modules and by tests. The production hook executor
 * (`hook-executor.ts`) and hook engine (`workflow-hook-engine.ts`) are
 * untouched — there are no new `built_in` ids and no coding-specific branches.
 * Gated behind `HYPERNEO_WORKFLOW_CONNECTORS_SPIKE` so the registry's seeding
 * is inert unless explicitly enabled (and even then, nothing in production
 * calls it).
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
 * A connector: an id plus its named ops. The ops are where domain knowledge
 * lives; the validator + predicate never reference a connector's field names.
 */
export interface Connector {
  readonly id: string;
  readonly ops: Record<string, ConnectorOp>;
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

/** Look up a specific op on a connector. Returns undefined when missing. */
export function getConnectorOp(connectorId: string, opName: string): ConnectorOp | undefined {
  return connectorRegistry.get(connectorId)?.ops[opName];
}

/** Clear the registry (test helper). */
export function clearConnectorRegistry(): void {
  connectorRegistry.clear();
}

/**
 * Spike gate. The connector layer is throwaway and unwired; this flag makes
 * that explicit and keeps `registerSpikeConnectors()` (see `index.ts`) inert
 * unless an operator opts in. Production never calls that function regardless.
 */
export function isConnectorsSpikeEnabled(): boolean {
  return process.env.HYPERNEO_WORKFLOW_CONNECTORS_SPIKE === '1';
}
