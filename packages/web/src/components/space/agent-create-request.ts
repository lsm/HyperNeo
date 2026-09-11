import { signal } from '@preact/signals';
import superpipe, { type PipelineAPI } from 'superpipe';

export interface AgentCreateFromTemplate {
  spaceId: string;
  templateKey: string;
}

export type AgentCreateDecision =
  | { kind: 'take'; templateKey: string }
  | { kind: 'skip'; reason: 'no-request' | 'other-space' };

type CreateGate = { value: AgentCreateFromTemplate } | { reason: AgentCreateDecision };

export const agentCreateRequest = signal<AgentCreateFromTemplate | null>(null);

export function gateRequestRaised(request: AgentCreateFromTemplate | null): CreateGate {
  if (!request) return { reason: { kind: 'skip', reason: 'no-request' } };
  return { value: request };
}

export function gateRequestForSpace(request: AgentCreateFromTemplate, spaceId: string): CreateGate {
  if (request.spaceId !== spaceId) return { reason: { kind: 'skip', reason: 'other-space' } };
  return { value: request };
}

export function toTakeDecision(request: AgentCreateFromTemplate): AgentCreateDecision {
  return { kind: 'take', templateKey: request.templateKey };
}

export const decideAgentCreateRequest = (superpipe({})('agent-create-request') as PipelineAPI)
  .input(['request', 'spaceId'])
  .pipe(gateRequestRaised, 'request', 'result:decided')
  .pipe(gateRequestForSpace, ['decided', 'spaceId'], 'result:decided')
  .pipe(toTakeDecision, 'decided', 'decided')
  .end('decided') as (
  request: AgentCreateFromTemplate | null,
  spaceId: string
) => AgentCreateDecision;

export function requestAgentFromTemplate(spaceId: string, templateKey: string): void {
  agentCreateRequest.value = { spaceId, templateKey };
}

export function takeAgentCreateRequest(spaceId: string): string | null {
  const decision = decideAgentCreateRequest(agentCreateRequest.value, spaceId);
  if (decision.kind === 'skip') return null;
  agentCreateRequest.value = null;
  return decision.templateKey;
}
