/**
 * L3 `external_state` validator (THROWAWAY spike, #2300).
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
 * (`(HookExecutorContext) => Promise<WorkflowHookResult>`), so a future PR
 * could register it behind a validator kind with no engine special-casing.
 * THIS SPIKE DOES NOT WIRE IT IN — it is exercised only by tests.
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
  /** Resolve op params from context. Defaults to extracting `prUrl` from
   *  `params.data.pr_url` → `rawParams.data.pr_url` → `hookLocalState.pr_url`. */
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function defaultPrUrlResolver(ctx: HookExecutorContext): Record<string, unknown> {
  const fromData = (params: Record<string, unknown> | undefined): string | undefined => {
    const data = params?.data;
    if (isRecord(data) && typeof data.pr_url === 'string') return data.pr_url;
    return undefined;
  };
  const prUrl =
    fromData(ctx.params) ??
    (ctx.rawParams ? fromData(ctx.rawParams) : undefined) ??
    (typeof ctx.hookLocalState?.pr_url === 'string' ? ctx.hookLocalState.pr_url : undefined);
  return prUrl ? { prUrl } : {};
}

/**
 * Create an `external_state` validator. The returned function mirrors the
 * built-in validator signature so it could be registered unchanged; the spike
 * calls it directly from tests instead.
 */
export function createExternalStateValidator(
  config: ExternalStateValidatorConfig
): (context: HookExecutorContext) => Promise<WorkflowHookResult> {
  const resolveParams = config.params ?? defaultPrUrlResolver;
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

    const opParams = resolveParams(context);
    if (!opParams.prUrl) {
      return {
        type: 'block',
        reason: `${config.label}: no pr_url available to evaluate external state`,
      };
    }

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
      return {
        type: 'retryable_block',
        reason: `${config.label}: pending external state`,
        retryAfterMs: pendingRetryMs,
      };
    }

    return { type: 'block', reason: `${config.label}: external-state condition not satisfied` };
  };
}
