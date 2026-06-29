import { describe, test, expect } from 'bun:test';
import { buildCustomAgentTaskMessage } from '../../../../src/lib/space/agents/custom-agent.ts';
import type { Space, SpaceWorkerAgent, SpaceTask } from '@neokai/shared';
import type { AgentMemorySearchResult } from '../../../../src/storage/repositories/agent-memory-repository.ts';

const space: Space = {
  id: 'space-1',
  slug: 'space-1',
  workspacePath: '/tmp/space-1',
  name: 'Space 1',
  description: '',
  backgroundContext: 'Static project context.',
  instructions: '',
  sessionIds: [],
  status: 'active',
  paused: false,
  stopped: false,
  maxConcurrentTasks: 1,
  createdAt: 1,
  updatedAt: 1,
};

const task: SpaceTask = {
  id: 'task-1',
  spaceId: 'space-1',
  taskNumber: 1,
  title: 'Add validation',
  description: 'Add validation for settings form.',
  status: 'open',
  priority: 'normal',
  dependsOn: [],
  blockedBy: [],
  createdAt: 1,
  updatedAt: 1,
};

const agent: SpaceWorkerAgent = {
  id: 'agent-1',
  spaceId: 'space-1',
  name: 'coder',
  description: '',
  customPrompt: '',
  tools: [],
  createdAt: 1,
  updatedAt: 1,
};

const memories: AgentMemorySearchResult[] = [
  {
    rank: -1,
    memory: {
      key: 'conventions.forms',
      spaceId: 'space-1',
      content: 'Use zod schemas for form validation.',
      tags: ['forms', 'validation'],
      createdBySession: null,
      createdAt: 1,
      updatedAt: 1,
      accessCount: 0,
      lastAccessedAt: null,
    },
  },
];

describe('buildCustomAgentTaskMessage memory injection', () => {
  test('includes core memories before relevant memories and project context', () => {
    const message = buildCustomAgentTaskMessage({
      customAgent: agent,
      task,
      workflowRun: null,
      workflow: null,
      space,
      sessionId: 'session-1',
      workspacePath: '/tmp/space-1',
      coreMemories: [{ ...memories[0].memory, key: 'core.conventions', score: 10 }],
      relevantMemories: memories,
    });

    expect(message).toContain('## Core Memories');
    expect(message).toContain('- core.conventions [forms, validation]: Use zod schemas');
    expect(message.indexOf('## Core Memories')).toBeLessThan(
      message.indexOf('## Relevant Memories')
    );
    expect(message.indexOf('## Core Memories')).toBeLessThan(message.indexOf('## Project Context'));
  });

  test('caps core memory prompt size', () => {
    const message = buildCustomAgentTaskMessage({
      customAgent: agent,
      task,
      workflowRun: null,
      workflow: null,
      space,
      sessionId: 'session-1',
      workspacePath: '/tmp/space-1',
      coreMemories: [
        {
          ...memories[0].memory,
          key: 'core.large',
          content: 'x'.repeat(3_000),
          score: 10,
        },
      ],
    });
    const coreStart = message.indexOf('## Core Memories');
    const contextStart = message.indexOf('## Project Context');
    const coreSection = message.slice(coreStart, contextStart);

    expect(coreSection.length).toBeLessThanOrEqual(2_050);
    expect(coreSection).toContain('…');
    expect(coreSection).not.toContain('x'.repeat(2_001));
  });

  test('continues after oversized core memory prefix entries', () => {
    const message = buildCustomAgentTaskMessage({
      customAgent: agent,
      task,
      workflowRun: null,
      workflow: null,
      space,
      sessionId: 'session-1',
      workspacePath: '/tmp/space-1',
      coreMemories: [
        {
          ...memories[0].memory,
          key: 'x'.repeat(2_100),
          content: 'Oversized prefix should be skipped.',
          score: 10,
        },
        {
          ...memories[0].memory,
          key: 'core.small',
          content: 'Small memory should still render.',
          tags: [],
          score: 9,
        },
      ],
    });

    expect(message).toContain('## Core Memories');
    expect(message).toContain('- core.small: Small memory should still render.');
    expect(message).not.toContain('Oversized prefix should be skipped.');
  });

  test('includes relevant memories before project context', () => {
    const message = buildCustomAgentTaskMessage({
      customAgent: agent,
      task,
      workflowRun: null,
      workflow: null,
      space,
      sessionId: 'session-1',
      workspacePath: '/tmp/space-1',
      relevantMemories: memories,
    });

    expect(message).toContain('## Relevant Memories');
    expect(message).toContain('- conventions.forms [forms, validation]: Use zod schemas');
    expect(message.indexOf('## Relevant Memories')).toBeLessThan(
      message.indexOf('## Project Context')
    );
  });

  test('truncates long memory content in prompt', () => {
    const message = buildCustomAgentTaskMessage({
      customAgent: agent,
      task,
      workflowRun: null,
      workflow: null,
      space,
      sessionId: 'session-1',
      workspacePath: '/tmp/space-1',
      relevantMemories: [
        {
          rank: -1,
          memory: {
            ...memories[0].memory,
            content: 'x'.repeat(600),
          },
        },
      ],
    });

    expect(message).toContain(`${'x'.repeat(500)}…`);
    expect(message).not.toContain('x'.repeat(501));
  });
});
