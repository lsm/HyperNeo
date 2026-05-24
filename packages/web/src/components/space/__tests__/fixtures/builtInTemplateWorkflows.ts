import type { SpaceWorkflow, WorkflowNodeAgent } from '@neokai/shared';

type BuiltInTemplateFixtureOptions = {
  includeSystemPrompts?: boolean;
};

function agent(
  agentId: string,
  name: string,
  prompt: string,
  includeSystemPrompts: boolean
): WorkflowNodeAgent {
  if (!includeSystemPrompts) {
    return { agentId, name };
  }
  return {
    agentId,
    name,
    customPrompt: { value: prompt },
  };
}

export function makeBuiltInTemplateWorkflows(
  options: BuiltInTemplateFixtureOptions = {}
): SpaceWorkflow[] {
  const includeSystemPrompts = options.includeSystemPrompts === true;

  return [
    {
      id: 'tpl-coding',
      spaceId: 'space-1',
      name: 'Coding Workflow',
      description: 'Coding desc',
      nodes: [
        {
          id: 'c1',
          name: 'Code',
          agents: [agent('agent-2', 'coder', 'Code.', includeSystemPrompts)],
        },
        {
          id: 'c2',
          name: 'Review',
          agents: [agent('agent-4', 'reviewer', 'Review.', includeSystemPrompts)],
        },
      ],
      startNodeId: 'c1',
      endNodeId: 'c2',
      tags: [],
      createdAt: 0,
      updatedAt: 0,
      completionAutonomyLevel: 3,
    },
    {
      id: 'tpl-research',
      spaceId: 'space-1',
      name: 'Research Workflow',
      nodes: [
        {
          id: 'r1',
          name: 'Research',
          agents: [agent('agent-5', 'research', 'Research.', includeSystemPrompts)],
        },
        {
          id: 'r2',
          name: 'Review',
          agents: [agent('agent-4', 'reviewer', 'Review.', includeSystemPrompts)],
        },
      ],
      startNodeId: 'r1',
      endNodeId: 'r2',
      tags: [],
      createdAt: 0,
      updatedAt: 0,
      completionAutonomyLevel: 2,
    },
    {
      id: 'tpl-review-only',
      spaceId: 'space-1',
      name: 'Review-Only Workflow',
      nodes: [
        {
          id: 'ro1',
          name: 'Review',
          agents: [agent('agent-4', 'reviewer', 'Review.', includeSystemPrompts)],
        },
      ],
      startNodeId: 'ro1',
      endNodeId: 'ro1',
      tags: [],
      createdAt: 0,
      updatedAt: 0,
      completionAutonomyLevel: 2,
    },
    {
      id: 'tpl-plan-decompose',
      spaceId: 'space-1',
      name: 'Plan & Decompose Workflow',
      nodes: [
        {
          id: 'pd1',
          name: 'Planning',
          agents: [agent('agent-1', 'planner', 'Plan.', includeSystemPrompts)],
        },
        {
          id: 'pd2',
          name: 'Plan Review',
          agents: [
            agent('agent-4', 'architecture-reviewer', 'Architecture review.', includeSystemPrompts),
            agent('agent-4', 'security-reviewer', 'Security review.', includeSystemPrompts),
            agent('agent-4', 'correctness-reviewer', 'Correctness review.', includeSystemPrompts),
            agent('agent-4', 'ux-reviewer', 'UX review.', includeSystemPrompts),
          ],
        },
        {
          id: 'pd3',
          name: 'Task Dispatcher',
          agents: [agent('agent-3', 'task-dispatcher', 'Dispatch tasks.', includeSystemPrompts)],
        },
      ],
      startNodeId: 'pd1',
      endNodeId: 'pd3',
      tags: ['planning', 'decomposition'],
      createdAt: 0,
      updatedAt: 0,
      completionAutonomyLevel: 3,
      channels: [
        {
          from: 'Planning',
          to: 'Plan Review',
          gateId: 'plan-pr-gate',
          label: 'Planning → Plan Review',
        },
        {
          from: 'Plan Review',
          to: 'Task Dispatcher',
          gateId: 'plan-approval-gate',
          label: 'Plan Review → Task Dispatcher',
        },
        {
          from: 'Plan Review',
          to: 'Planning',
          maxCycles: 5,
          label: 'Plan Review → Planning (revision requested)',
        },
      ],
      gates: [
        {
          id: 'plan-pr-gate',
          description: 'Planning PR is open and mergeable so Plan Review can start.',
          fields: [
            {
              name: 'pr_url',
              type: 'string',
              writers: ['*'],
              check: { op: 'exists' },
            },
          ],
          script: { interpreter: 'bash', source: 'echo', timeoutMs: 30000 },
          resetOnCycle: true,
        },
        {
          id: 'plan-approval-gate',
          description: 'All four Plan Reviewers must approve the plan.',
          fields: [
            {
              name: 'approvals',
              type: 'map',
              writers: ['reviewer'],
              check: { op: 'count', match: 'approved', min: 4 },
            },
          ],
          resetOnCycle: true,
        },
      ],
    },
    {
      id: 'tpl-fullstack-qa-loop',
      spaceId: 'space-1',
      name: 'Coding with QA Workflow',
      nodes: [
        {
          id: 'fs1',
          name: 'Coding',
          agents: [agent('agent-2', 'coder', 'Code.', includeSystemPrompts)],
        },
        {
          id: 'fs2',
          name: 'Review',
          agents: [agent('agent-4', 'reviewer', 'Review.', includeSystemPrompts)],
        },
        {
          id: 'fs3',
          name: 'QA',
          agents: [agent('agent-6', 'qa', 'QA.', includeSystemPrompts)],
        },
      ],
      startNodeId: 'fs1',
      endNodeId: 'fs3',
      tags: [],
      createdAt: 0,
      updatedAt: 0,
      completionAutonomyLevel: 4,
      channels: [
        {
          from: 'Coding',
          to: 'Review',
          gateId: 'code-pr-gate',
          label: 'Coding → Review',
        },
        {
          from: 'Review',
          to: 'QA',
          gateId: 'review-approval-gate',
          label: 'Review → QA',
        },
        {
          from: 'Review',
          to: 'Coding',
          maxCycles: 6,
          label: 'Review → Coding (feedback)',
        },
        {
          from: 'QA',
          to: 'Coding',
          maxCycles: 6,
          label: 'QA → Coding (issues found)',
        },
      ],
      gates: [
        {
          id: 'code-pr-gate',
          description: 'PR URL captured',
          fields: [{ name: 'pr_url', type: 'string', writers: ['*'], check: { op: 'exists' } }],
          script: { interpreter: 'bash', source: 'echo', timeoutMs: 30000 },
          resetOnCycle: true,
        },
        {
          id: 'review-approval-gate',
          description: 'Reviewer approved',
          fields: [
            {
              name: 'approved',
              type: 'boolean',
              writers: ['reviewer'],
              check: { op: '==', value: true },
            },
          ],
          resetOnCycle: true,
        },
      ],
    },
  ];
}
