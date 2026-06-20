import { cleanup, render, waitFor } from '@testing-library/preact';
import { signal } from '@preact/signals';
import type {
  SpaceAgent,
  SpaceAutonomyLevel,
  SpaceLongHorizonAgent,
  SpaceWorkflow,
} from '@neokai/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let mockAgents: ReturnType<typeof signal<SpaceAgent[]>>;
let mockLongHorizonAgents: ReturnType<typeof signal<SpaceLongHorizonAgent[]>>;
let mockWorkflows: ReturnType<typeof signal<unknown[]>>;
let mockWorkflowDetails: ReturnType<typeof signal<SpaceWorkflow[]>>;
let mockWorkflowDetailsLoaded: ReturnType<typeof signal<boolean>>;
let mockLoading: ReturnType<typeof signal<boolean>>;

vi.mock('../../../lib/space-store', () => ({
  get spaceStore() {
    return {
      agents: mockAgents,
      longHorizonAgents: mockLongHorizonAgents,
      workflows: mockWorkflows,
      workflowDetails: mockWorkflowDetails,
      workflowDetailsLoaded: mockWorkflowDetailsLoaded,
      loading: mockLoading,
    };
  },
}));

mockAgents = signal<SpaceAgent[]>([]);
mockLongHorizonAgents = signal<SpaceLongHorizonAgent[]>([]);
mockWorkflows = signal<unknown[]>([]);
mockWorkflowDetails = signal<SpaceWorkflow[]>([]);
mockWorkflowDetailsLoaded = signal(false);
mockLoading = signal(false);

import { SpaceAgentList } from '../SpaceAgentList';

function makeLongHorizonAgent(
  overrides: Partial<SpaceLongHorizonAgent> = {}
): SpaceLongHorizonAgent {
  return {
    id: 'lh-agent-1',
    spaceId: 'space-1',
    handle: 'persistent-coder',
    displayName: 'Persistent Coder',
    templateKey: null,
    status: 'active',
    sessionId: null,
    instructions: '',
    autonomyLevel: null,
    model: null,
    thinkingLevel: null,
    provider: null,
    settingSources: null,
    toolPermissions: {},
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

function makeWorkflow(overrides: Partial<SpaceWorkflow> = {}): SpaceWorkflow {
  return {
    id: 'wf-1',
    spaceId: 'space-1',
    name: 'Coding Workflow',
    description: 'Build and review code',
    nodes: [
      {
        id: 'node-1',
        name: 'Coding',
        agents: [
          {
            agentId: 'coder-agent',
            name: 'coder',
            customPrompt: { value: 'Writes code and updates tests.' },
            extraMcpServers: { filesystem: { command: 'mcp-filesystem' } },
            toolGuards: [
              { matcher: 'Bash', pattern: '^rm', decision: 'deny', reason: 'No destructive ops' },
            ],
          },
        ],
      },
      {
        id: 'node-2',
        name: 'Review',
        agents: [
          {
            agentId: 'reviewer-agent',
            name: 'reviewer',
          },
        ],
      },
    ],
    startNodeId: 'node-1',
    tags: [],
    completionAutonomyLevel: 1 as SpaceAutonomyLevel,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

describe('SpaceAgentList', () => {
  beforeEach(() => {
    cleanup();
    mockAgents.value = [];
    mockLongHorizonAgents.value = [];
    mockWorkflows.value = [];
    mockWorkflowDetails.value = [];
    mockWorkflowDetailsLoaded.value = true;
    mockLoading.value = false;
  });

  afterEach(() => {
    cleanup();
  });

  it('renders loading state', () => {
    mockLoading.value = true;

    const { getByText } = render(<SpaceAgentList />);

    expect(getByText('Loading agents...')).toBeTruthy();
  });

  it('renders loading state while workflow details are still pending', () => {
    mockWorkflowDetails.value = [makeWorkflow()];
    mockWorkflowDetailsLoaded.value = false;

    const { getByText, queryByText } = render(<SpaceAgentList />);

    expect(getByText('Loading agents...')).toBeTruthy();
    expect(queryByText('Worker Agents · 2 configured')).toBeNull();
  });

  it('shows Worker Agents title and description', () => {
    mockWorkflowDetails.value = [makeWorkflow()];

    const { getByText } = render(<SpaceAgentList />);

    expect(getByText('Worker Agents · 2 configured')).toBeTruthy();
    expect(
      getByText(
        'Short-term agents that execute within workflows. They are created on-demand when tasks run and do not persist between sessions.'
      )
    ).toBeTruthy();
  });

  it('lists agent types from workflow definitions', () => {
    mockWorkflowDetails.value = [makeWorkflow()];

    const { getByText } = render(<SpaceAgentList />);

    expect(getByText('Coder')).toBeTruthy();
    expect(getByText('coder')).toBeTruthy();
    expect(getByText('Reviewer')).toBeTruthy();
    expect(getByText('reviewer')).toBeTruthy();
  });

  it('does not show long-horizon agents', () => {
    mockLongHorizonAgents.value = [makeLongHorizonAgent()];
    mockWorkflowDetails.value = [makeWorkflow()];

    const { queryByText } = render(<SpaceAgentList />);

    expect(queryByText('Persistent Coder')).toBeNull();
    expect(queryByText('persistent-coder')).toBeNull();
  });

  it('shows description and tool permissions for worker agent cards', () => {
    mockWorkflowDetails.value = [makeWorkflow()];

    const { getByText } = render(<SpaceAgentList />);

    expect(getByText('Writes code and updates tests.')).toBeTruthy();
    expect(getByText('filesystem')).toBeTruthy();
    expect(getByText('Bash guard')).toBeTruthy();
    expect(getByText('Default workflow permissions')).toBeTruthy();
  });

  it('shows empty state when no workflow details define worker agents', () => {
    mockWorkflows.value = [{ id: 'wf-1', name: 'Coding Workflow', nodeCount: 2 }];

    const { getByText, queryByText } = render(<SpaceAgentList />);

    expect(getByText('No worker agents configured.')).toBeTruthy();
    expect(getByText('Create a workflow to define worker agents.')).toBeTruthy();
    expect(queryByText('Coder')).toBeNull();
  });

  it('groups Used in workflow names per agent', () => {
    mockWorkflowDetails.value = [
      makeWorkflow(),
      makeWorkflow({
        id: 'wf-2',
        name: 'Coding with QA Workflow',
        nodes: [
          {
            id: 'node-3',
            name: 'QA',
            agents: [
              { agentId: 'coder-agent', name: 'coder' },
              { agentId: 'qa-agent', name: 'qa' },
            ],
          },
        ],
      }),
    ];

    const { getAllByText, getByText } = render(<SpaceAgentList />);

    expect(getAllByText('Coding Workflow').length).toBeGreaterThan(0);
    expect(getAllByText('Coding with QA Workflow').length).toBeGreaterThan(0);
    expect(getByText('Qa')).toBeTruthy();
  });

  it('does not merge slots with the same name but different agentId', () => {
    mockWorkflowDetails.value = [
      makeWorkflow({
        id: 'wf-1',
        name: 'Workflow A',
        nodes: [
          {
            id: 'node-1',
            name: 'Code',
            agents: [
              {
                agentId: 'coder-agent-a',
                name: 'coder',
                customPrompt: { value: 'Coder A' },
              },
            ],
          },
        ],
      }),
      makeWorkflow({
        id: 'wf-2',
        name: 'Workflow B',
        nodes: [
          {
            id: 'node-1',
            name: 'Code',
            agents: [
              {
                agentId: 'coder-agent-b',
                name: 'coder',
                customPrompt: { value: 'Coder B' },
              },
            ],
          },
        ],
      }),
    ];

    const { getByText } = render(<SpaceAgentList />);

    expect(getByText('Coder A')).toBeTruthy();
    expect(getByText('Coder B')).toBeTruthy();
    expect(getByText('coder-agent-a')).toBeTruthy();
    expect(getByText('coder-agent-b')).toBeTruthy();
  });

  it('keeps same-name same-agentId slots in different workflows separate', () => {
    mockWorkflowDetails.value = [
      makeWorkflow({
        id: 'wf-1',
        name: 'Workflow A',
        nodes: [
          {
            id: 'node-1',
            name: 'Code',
            agents: [
              {
                agentId: 'coder-agent',
                name: 'coder',
                customPrompt: { value: 'Coder A prompt' },
              },
            ],
          },
        ],
      }),
      makeWorkflow({
        id: 'wf-2',
        name: 'Workflow B',
        nodes: [
          {
            id: 'node-1',
            name: 'Code',
            agents: [
              {
                agentId: 'coder-agent',
                name: 'coder',
                customPrompt: { value: 'Coder B prompt' },
              },
            ],
          },
        ],
      }),
    ];

    const { getByText } = render(<SpaceAgentList />);

    expect(getByText('Coder A prompt')).toBeTruthy();
    expect(getByText('Coder B prompt')).toBeTruthy();
  });

  it('keeps same-name same-agentId slots in different nodes separate', () => {
    mockWorkflowDetails.value = [
      makeWorkflow({
        nodes: [
          {
            id: 'node-1',
            name: 'Code A',
            agents: [
              {
                agentId: 'coder-agent',
                name: 'coder',
                customPrompt: { value: 'Node A prompt' },
              },
            ],
          },
          {
            id: 'node-2',
            name: 'Code B',
            agents: [
              {
                agentId: 'coder-agent',
                name: 'coder',
                customPrompt: { value: 'Node B prompt' },
              },
            ],
          },
        ],
      }),
    ];

    const { getByText } = render(<SpaceAgentList />);

    expect(getByText('Node A prompt')).toBeTruthy();
    expect(getByText('Node B prompt')).toBeTruthy();
  });

  it('uses base agent prompt when slot does not override it', () => {
    mockAgents.value = [
      {
        id: 'coder-agent',
        spaceId: 'space-1',
        name: 'Coder',
        handle: 'coder',
        customPrompt: 'Base coder behavior.',
        tools: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ];
    mockWorkflowDetails.value = [
      makeWorkflow({
        nodes: [
          {
            id: 'node-1',
            name: 'Code',
            agents: [{ agentId: 'coder-agent', name: 'coder' }],
          },
        ],
      }),
    ];

    const { getByText, queryByText } = render(<SpaceAgentList />);

    expect(getByText('Base coder behavior.')).toBeTruthy();
    expect(queryByText('Coder worker agent.')).toBeNull();
  });

  it('combines base and slot prompts for worker description', () => {
    mockAgents.value = [
      {
        id: 'coder-agent',
        spaceId: 'space-1',
        name: 'Coder',
        handle: 'coder',
        customPrompt: 'Base coder behavior.',
        tools: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ];
    mockWorkflowDetails.value = [
      makeWorkflow({
        nodes: [
          {
            id: 'node-1',
            name: 'Code',
            agents: [
              {
                agentId: 'coder-agent',
                name: 'coder',
                customPrompt: { value: 'Slot-specific override.' },
              },
            ],
          },
        ],
      }),
    ];

    const { getByText, queryByText } = render(<SpaceAgentList />);

    expect(
      getByText(
        (_, element) => element?.textContent === 'Base coder behavior.\n\nSlot-specific override.'
      )
    ).toBeTruthy();
    expect(queryByText('Slot-specific override.')).toBeNull();
  });

  it('includes base agent tools in tool permissions', () => {
    mockAgents.value = [
      {
        id: 'coder-agent',
        spaceId: 'space-1',
        name: 'Coder',
        handle: 'coder',
        customPrompt: null,
        tools: ['Edit', 'Bash'],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ];
    mockWorkflowDetails.value = [
      makeWorkflow({
        nodes: [
          {
            id: 'node-1',
            name: 'Code',
            agents: [{ agentId: 'coder-agent', name: 'coder' }],
          },
        ],
      }),
    ];

    const { getByText, queryByText } = render(<SpaceAgentList />);

    expect(getByText('Bash')).toBeTruthy();
    expect(getByText('Edit')).toBeTruthy();
    expect(queryByText('Default workflow permissions')).toBeNull();
  });

  it('updates tool permissions when base agent tools change', async () => {
    mockWorkflowDetails.value = [
      makeWorkflow({
        nodes: [
          {
            id: 'node-1',
            name: 'Code',
            agents: [{ agentId: 'coder-agent', name: 'coder' }],
          },
        ],
      }),
    ];

    const { getByText, queryByText } = render(<SpaceAgentList />);
    expect(getByText('Default workflow permissions')).toBeTruthy();

    mockAgents.value = [
      {
        id: 'coder-agent',
        spaceId: 'space-1',
        name: 'Coder',
        handle: 'coder',
        customPrompt: null,
        tools: ['Edit'],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ];

    await waitFor(() => {
      expect(getByText('Edit')).toBeTruthy();
      expect(queryByText('Default workflow permissions')).toBeNull();
    });
  });
});
