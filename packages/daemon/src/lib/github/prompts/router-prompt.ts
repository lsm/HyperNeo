export { GITHUB_ROUTER_SYSTEM_PROMPT as ROUTER_AGENT_SYSTEM_PROMPT } from '@hyperneo/prompts';

export interface RoutingClassification {
  decision: 'route' | 'inbox' | 'reject';
  roomId: string | null;
  confidence: 'high' | 'medium' | 'low';
  reason: string;
  suggestedLabels?: string[];
}
