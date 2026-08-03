/**
 * L3 `external_state` validator (epic #2299; promoted from the #2300 spike in
 * P2 #2302).
 *
 * The generic rule primitive: parameterised by (connector, op, predicate), it
 * calls a connector op, evaluates domain-agnostic predicates against the
 * result, and maps the outcome to a `WorkflowHookResult`. It knows nothing
 * about PRs or codex — those are encoded by the preset configs
 * (`presets.ts`) that choose a connector/op/predicate.
 *
 * Three-way decision (matches how the production pr_ready validator behaves):
 *   - op returns retryable failure (rate limit) → `retryable_block`
 *   - op returns non-retryable failure          → `block`
 *   - op ok + `pass` predicate holds            → `allow` (+ projected data)
 *   - op ok + `pass` fails + `pending` holds     → `retryable_block` (transient)
 *   - op ok + `pass` fails + no/missed pending   → `block` (terminal)
 *
 * The returned function has the same signature as a built-in validator
 * (`(HookExecutorContext) => Promise<WorkflowHookResult>`), so a preset factory
 * registers it behind a validator id with no engine special-casing. It backs
 * the `pr_merged` preset (and the forward-looking `pr_ready` V2 form); the
 * production hook executor dispatches both through the registry.
 */

import type { WorkflowHookResult } from '@hyperneo/shared';
import type { HookExecutorContext } from '../hook-executor';
import { getConnector } from './connector';
import type { Predicate } from './predicate';
import { evaluatePredicate } from './predicate';

const DEFAULT_PENDING_RETRY_MS = 30_000;

/** Resolve op params (e.g. `{ prUrl }`) from the hook context. */
export type ParamResolver = (ctx: HookExecutorContext) => Record<string, unknown>;

export interface ExternalStateValidatorConfig {
  /** Connector id resolved via the connector registry. */
  connector: string;
  /** Op name on that connector. */
  op: string;
  /** Predicate that, when true over the op result, yields `allow`. */
  pass: Predicate;
  /** Predicate that, when `pass` is false but this is true, yields
   *  `retryable_block` (a transient/pending state such as UNKNOWN mergeability
   *  or a merge/codex-bot check still in flight). Optional. */
  pending?: Predicate;
  /** Resolve op params from context. Defaults to a no-op (no params extracted);
   *  a preset whose op needs inputs (e.g. an id or URL) supplies its own
   *  resolver. Domain-neutral — the validator itself carries no field-name
   *  knowledge, so each op validates the params it receives (epic #2299
   *  honesty test). */
  params?: ParamResolver;
  /** `retryAfterMs` used when `pending` holds and the op itself did not
   *  supply one. Defaults to 30s (matches the production pr_ready backoff). */
  retryAfterMs?: number;
  /** Project the op result into the `allow` result's `data` (e.g.
   *  `{ pr_url }`). Optional. */
  dataProjection?: (data: Record<string, unknown>) => Record<string, unknown> | undefined;
  /** Human-readable label used in block/retry reasons. */
  label: string;
}

/**
 * Domain-neutral default param resolver: extracts nothing. A preset whose op
 * needs inputs supplies its own `params` resolver (coding knowledge lives in
 * the preset, L4 — not here).
 */
function noopParamResolver(): Record<string, unknown> {
  return {};
}

/**
 * Create an `external_state` validator. The returned function mirrors the
 * built-in validator signature so a preset factory can register it unchanged;
 * the preset tests also call it directly.
 */
export function createExternalStateValidator(
  config: ExternalStateValidatorConfig
): (context: HookExecutorContext) => Promise<WorkflowHookResult> {
  const resolveParams = config.params ?? noopParamResolver;
  const pendingRetryMs = config.retryAfterMs ?? DEFAULT_PENDING_RETRY_MS;

  return async (context: HookExecutorContext): Promise<WorkflowHookResult> => {
    const connector = getConnector(config.connector);
    if (!connector) {
      return {
        type: 'block',
        reason: `${config.label}: connector "${config.connector}" is not registered`,
      };
    }
    const op = connector.ops[config.op];
    if (!op) {
      return {
        type: 'block',
        reason: `${config.label}: connector "${config.connector}" has no op "${config.op}"`,
      };
    }

    // The op owns param validation — it returns a non-retryable failure (which
    // we map to `block`) when its required inputs are missing. The validator
    // carries no field-name knowledge (e.g. no `prUrl`), keeping L3 neutral.
    const opParams = resolveParams(context);
    const outcome = await op(opParams, {
      workspacePath: context.workspacePath,
      params: context.params,
      rawParams: context.rawParams,
      hookLocalState: context.hookLocalState,
    });

    if (!outcome.ok) {
      if (outcome.retryable) {
        return {
          type: 'retryable_block',
          reason: `${config.label}: ${outcome.error}`,
          retryAfterMs: outcome.retryAfterMs ?? pendingRetryMs,
        };
      }
      return { type: 'block', reason: `${config.label}: ${outcome.error}` };
    }

    const data = outcome.data;
    if (evaluatePredicate(config.pass, data)) {
      const projected = config.dataProjection?.(data as Record<string, unknown>);
      return projected ? { type: 'allow', data: projected } : { type: 'allow' };
    }

    if (config.pending && evaluatePredicate(config.pending, data)) {
      // Tag predicate-pending results so a composing wrapper (e.g.
      // `pollUntilAllow`) can tell them apart from a *connector failure* that
      // also presents as `retryable_block` (rate limit / outage). A pending
      // state ("the bot hasn't +1'd yet") is safe to time out into an allow;
      // a lookup failure is not — an outage must never open the gate. See
      // presets.ts:pollUntilAllow.
      return {
        type: 'retryable_block',
        reason: `${config.label}: pending external state`,
        retryAfterMs: pendingRetryMs,
        data: { externalStatePending: true },
      };
    }

    return { type: 'block', reason: `${config.label}: external-state condition not satisfied` };
  };
}
