import { SUBAGENT_REVIEWER_PROMPT } from '@hyperneo/prompts';
import type { AgentDefinition } from '@hyperneo/shared';

export const reviewerAgent: AgentDefinition = {
  description:
    'Review code for quality, security, and correctness. Use after code changes to verify they are sound.',
  tools: ['Read', 'Grep', 'Glob', 'Bash', 'WebFetch', 'WebSearch', 'Skill', 'ToolSearch'],
  model: 'opus',
  prompt: SUBAGENT_REVIEWER_PROMPT,
};
