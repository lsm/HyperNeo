import { parseAddress } from '../../../../messaging/src/address.ts';
import type { ResolveNodeAgentTargetsOutcome } from './routing-gates.ts';
import superpipe, { type PipelineAPI } from 'superpipe';

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

export interface AgentMessageRoutingInput {
  target: string | string[];
  requestedTargets: string[];
  topologyEmpty: boolean;
  resolution: ResolveNodeAgentTargetsOutcome;
}

export function isGenericAddress(target: string): boolean {
  try {
    parseAddress(target);
    return true;
  } catch {
    return false;
  }
}

export function delegatesToGenericAddress(input: AgentMessageRoutingInput): boolean {
  return input.requestedTargets.length > 0 && input.requestedTargets.every(isGenericAddress);
}

export function classifyAgentMessageRouting(
  input: AgentMessageRoutingInput
): AgentMessageRoutingDecision {
  if (delegatesToGenericAddress(input)) return { action: 'delegateGeneric' };
  if (input.topologyEmpty) return { action: 'failNoTopology' };
  if (input.resolution.status === 'unauthorized') {
    return {
      action: 'failUnauthorized',
      reason: input.resolution.reason,
      unauthorizedAgentNames: input.resolution.unauthorized,
      permittedTargets: input.resolution.permittedTargets,
    };
  }
  if (input.resolution.status === 'resolved') {
    return { action: 'routeTargets', targetAgentNames: input.resolution.targetAgentNames };
  }
  return { action: 'failUnknownTarget', reason: input.resolution.reason };
}

export const decideAgentMessageRouting = (superpipe({})('agent-message-routing') as PipelineAPI)
  .input(['input'])
  .pipe(classifyAgentMessageRouting, 'input', 'decision')
  .end('decision') as (input: AgentMessageRoutingInput) => AgentMessageRoutingDecision;
