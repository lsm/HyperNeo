import { parseAddress } from '../../../../../messaging/src/address.ts';
import type { ResolveNodeAgentTargetsOutcome } from './agent-message-routing-gates.ts';
import { decisionRun } from './decision-pipeline.ts';

export type AgentMessageRoutingDecision =
  | { action: 'delegateGeneric' }
  | { action: 'failNoTopology' }
  | { action: 'failUnknownTarget'; reason: string }
  | {
      action: 'failUnauthorized';
      reason: string;
      unauthorizedAgentNames: string[];
      permittedTargets: string[];
    }
  | { action: 'routeTargets'; targetAgentNames: string[] };

export interface AgentMessageRoutingCtx {
  target: string | string[];
  requestedTargets: string[];
  topologyEmpty: boolean;
  spaceAgentAvailable: boolean;
  resolution: ResolveNodeAgentTargetsOutcome;
  decision: AgentMessageRoutingDecision | null;
}

export type AgentMessageRoutingInput = Omit<AgentMessageRoutingCtx, 'decision'>;

function decided(
  ctx: AgentMessageRoutingCtx,
  decision: AgentMessageRoutingDecision
): AgentMessageRoutingCtx {
  return { ...ctx, decision };
}

function isGenericAddress(target: string): boolean {
  try {
    parseAddress(target);
    return true;
  } catch {
    return false;
  }
}

export function applyGenericAddressDispatchGate(
  ctx: AgentMessageRoutingCtx
): AgentMessageRoutingCtx {
  const delegates = ctx.requestedTargets.length > 0 && ctx.requestedTargets.every(isGenericAddress);
  return delegates ? decided(ctx, { action: 'delegateGeneric' }) : ctx;
}

export function applyEmptyTopologyGate(ctx: AgentMessageRoutingCtx): AgentMessageRoutingCtx {
  const wantsSpaceAgent = ctx.target !== '*' && ctx.requestedTargets.includes('space-agent');
  const blocked = ctx.topologyEmpty && !(wantsSpaceAgent && ctx.spaceAgentAvailable);
  return blocked ? decided(ctx, { action: 'failNoTopology' }) : ctx;
}

export function applyTargetResolutionGate(ctx: AgentMessageRoutingCtx): AgentMessageRoutingCtx {
  if (ctx.resolution.status === 'resolved') return ctx;
  if (ctx.resolution.status === 'unauthorized') return ctx;
  return decided(ctx, { action: 'failUnknownTarget', reason: ctx.resolution.reason });
}

export function applyTopologyAuthorizationGate(
  ctx: AgentMessageRoutingCtx
): AgentMessageRoutingCtx {
  if (ctx.resolution.status === 'unauthorized') {
    return decided(ctx, {
      action: 'failUnauthorized',
      reason: ctx.resolution.reason,
      unauthorizedAgentNames: ctx.resolution.unauthorized,
      permittedTargets: ctx.resolution.permittedTargets,
    });
  }
  if (ctx.resolution.status === 'resolved') {
    return decided(ctx, {
      action: 'routeTargets',
      targetAgentNames: ctx.resolution.targetAgentNames,
    });
  }
  return ctx;
}

const agentMessageRoutingDecisionRun = decisionRun('agent-message-routing', [
  applyGenericAddressDispatchGate,
  applyEmptyTopologyGate,
  applyTargetResolutionGate,
  applyTopologyAuthorizationGate,
]);

export function decideAgentMessageRouting(
  input: AgentMessageRoutingInput
): AgentMessageRoutingDecision {
  const ctx = agentMessageRoutingDecisionRun(input);
  return ctx.decision ?? { action: 'routeTargets', targetAgentNames: [] };
}
