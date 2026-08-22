import { SUBAGENT_TESTER_PROMPT } from '@hyperneo/prompts';
import type { AgentDefinition } from '@hyperneo/shared';

export const testerAgent: AgentDefinition = {
  description:
    'Write and run tests. Use for creating test cases, running test suites, and analyzing test results.',
  tools: [
    'Read',
    'Write',
    'Edit',
    'MultiEdit',
    'Bash',
    'Grep',
    'Glob',
    'WebFetch',
    'WebSearch',
    'Skill',
    'Agent',
    'Task',
    'TodoWrite',
    'TaskOutput',
    'TaskStop',
    'EnterPlanMode',
    'ExitPlanMode',
    'NotebookEdit',
    'ToolSearch',
  ],
  model: 'sonnet',
  prompt: SUBAGENT_TESTER_PROMPT,
};
