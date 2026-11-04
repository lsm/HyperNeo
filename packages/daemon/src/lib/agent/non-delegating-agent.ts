import type { AgentDefinition } from '@hyperneo/shared';
import { NON_DELEGATING_GENERAL_PROMPT } from '@hyperneo/prompts';

export const NON_DELEGATING_GENERAL_AGENT: AgentDefinition = {
  description:
    'Investigate a focused question using files, search, shell commands, and web sources. Complete the assigned work directly; do not delegate it to another agent.',
  tools: ['Read', 'Bash', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'Skill', 'ToolSearch'],
  disallowedTools: ['Agent', 'Task', 'TaskOutput', 'TaskStop'],
  prompt: NON_DELEGATING_GENERAL_PROMPT,
  model: 'inherit',
};
