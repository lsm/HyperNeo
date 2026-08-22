export { GITHUB_SECURITY_SYSTEM_PROMPT as SECURITY_AGENT_SYSTEM_PROMPT } from '@hyperneo/prompts';

export interface SecurityClassification {
  safe: boolean;
  injectionRisk: 'none' | 'low' | 'medium' | 'high';
  reason: string;
  requiresHumanReview: boolean;
  detectedPatterns?: string[];
}
