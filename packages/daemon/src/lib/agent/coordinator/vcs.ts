import { SUBAGENT_VCS_PROMPT } from '@hyperneo/prompts';
import type { AgentDefinition } from '@hyperneo/shared';

export const vcsAgent: AgentDefinition = {
  description:
    'Version control specialist. Creates logical commits, pushes to remote, creates PRs, monitors CI status, and reports failures back for resolution.',
  tools: ['Bash', 'Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'Skill', 'ToolSearch'],
  model: 'sonnet',
  prompt: SUBAGENT_VCS_PROMPT,
};
