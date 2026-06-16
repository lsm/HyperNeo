import { cleanup, render } from '@testing-library/preact';
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
let mockWorkflows: ReturnType<typeof signal<SpaceWorkflow[]>>;
let mockLoading: ReturnType<typeof signal<boolean>>;

vi.mock('../../../lib/space-store', () => ({
  get spaceStore() {
    return {
      agents: mockAgents,
      longHorizonAgents: mockLongHorizonAgents,
      workflows: mockWorkflows,
      loading: mockLoading,
    };
  },
}));

mockAgents = signal<SpaceAgent[]>([]);
mockLongHorizonAgents = signal<SpaceLongHorizonAgent[]>([]);
mockWorkflows = signal<SpaceWorkflow[]>([]);
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
    completionAutonomyLevel: 0 as SpaceAutonomyLevel,
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

  it('shows Worker Agents title and description', () => {
    mockWorkflows.value = [makeWorkflow()];

    const { getByText } = render(<SpaceAgentList />);

    expect(getByText('Worker Agents · 2 configured')).toBeTruthy();
    expect(
      getByText(
        'Short-term agents that execute within workflows. They are created on-demand when tasks run and do not persist between sessions.'
      )
    ).toBeTruthy();
  });

  it('lists agent types from workflow definitions', () => {
    mockWorkflows.value = [makeWorkflow()];

    const { getByText } = render(<SpaceAgentList />);

    expect(getByText('Coder')).toBeTruthy();
    expect(getByText('coder')).toBeTruthy();
    expect(getByText('Reviewer')).toBeTruthy();
    expect(getByText('reviewer')).toBeTruthy();
  });

  it('does not show long-horizon agents', () => {
    mockLongHorizonAgents.value = [makeLongHorizonAgent()];
    mockWorkflows.value = [makeWorkflow()];

    const { queryByText } = render(<SpaceAgentList />);

    expect(queryByText('Persistent Coder')).toBeNull();
    expect(queryByText('persistent-coder')).toBeNull();
  });

  it('shows description and tool permissions for worker agent cards', () => {
    mockWorkflows.value = [makeWorkflow()];

    const { getByText } = render(<SpaceAgentList />);

    expect(getByText('Writes code and updates tests.')).toBeTruthy();
    expect(getByText('filesystem')).toBeTruthy();
    expect(getByText('Bash guard')).toBeTruthy();
    expect(getByText('Default workflow permissions')).toBeTruthy();
  });

  it('shows empty state when no workflows define worker agents', () => {
    const { getByText } = render(<SpaceAgentList />);

    expect(getByText('No worker agents configured.')).toBeTruthy();
    expect(getByText('Create a workflow to define worker agents.')).toBeTruthy();
  });

  it('groups Used in workflow names per agent', () => {
    mockWorkflows.value = [
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
});
