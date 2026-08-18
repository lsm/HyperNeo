import type { WorkflowHookResult } from '@hyperneo/shared';
import type { HookExecutorContext } from '../hook-executor';
import { getConnector } from './connector';
import type { Predicate } from './predicate';
import { evaluatePredicate } from './predicate';

const DEFAULT_PENDING_RETRY_MS = 30_000;

export type ParamResolver = (ctx: HookExecutorContext) => Record<string, unknown>;

export interface ExternalStateValidatorConfig {
  connector: string;
  op: string;
  pass: Predicate;
  pending?: Predicate;
  params?: ParamResolver;
  retryAfterMs?: number;
  dataProjection?: (data: Record<string, unknown>) => Record<string, unknown> | undefined;
  label: string;
}

function noopParamResolver(): Record<string, unknown> {
  return {};
}

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
