import { SUBAGENT_VERIFIER_PROMPT } from '@hyperneo/prompts';
import type { AgentDefinition } from '@hyperneo/shared';

export const verifierAgent: AgentDefinition = {
  description:
    'Critical result verification. Use as the final step to verify that work actually meets the original requirements. Catches cut corners, incomplete implementations, and claims that do not match reality.',
  tools: ['Read', 'Grep', 'Glob', 'Bash', 'WebFetch', 'WebSearch', 'Skill', 'ToolSearch'],
  model: 'opus',
  prompt: SUBAGENT_VERIFIER_PROMPT,
};
