import type { AgentDefinition } from '@hyperneo/shared';

export const coderAgent: AgentDefinition = {
  description:
    'Write and modify code. Use for implementing features, fixing bugs, editing files, and making code changes.',
  tools: [
    'Read',
    'Edit',
    'Write',
    'MultiEdit',
    'Grep',
    'Glob',
    'Bash',
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
  prompt: `You are a focused code implementer. Your job is to achieve the stated goal by making precise, minimal code changes.

When given a task:
1. Understand the goal and acceptance criteria
2. Read the relevant files to understand existing patterns and architecture
3. Determine the best implementation approach yourself
4. Make minimal, focused changes that accomplish the goal
5. Follow existing code patterns and conventions
6. Report what you changed and why

You have full codebase access. The task tells you WHAT to achieve — you decide HOW.
Be precise and minimal. Only change what is needed for the goal.`,
};
