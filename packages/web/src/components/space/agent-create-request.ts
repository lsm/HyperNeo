import { signal } from '@preact/signals';

export interface AgentCreateFromTemplate {
  spaceId: string;
  templateKey: string;
}

export const agentCreateRequest = signal<AgentCreateFromTemplate | null>(null);

export function requestAgentFromTemplate(spaceId: string, templateKey: string): void {
  agentCreateRequest.value = { spaceId, templateKey };
}

export function takeAgentCreateRequest(spaceId: string): string | null {
  const pending = agentCreateRequest.value;
  if (!pending || pending.spaceId !== spaceId) return null;
  agentCreateRequest.value = null;
  return pending.templateKey;
}
