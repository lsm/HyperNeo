import { cleanup, fireEvent, render, waitFor } from '@testing-library/preact';
import { signal } from '@preact/signals';
import type {
  SpaceWorkerAgent,
  SpaceAutonomyLevel,
  SpaceLongHorizonAgent,
  SpaceWorkflow,
} from '@hyperneo/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let mockAgents: ReturnType<typeof signal<SpaceWorkerAgent[]>>;
let mockLongHorizonAgents: ReturnType<typeof signal<SpaceLongHorizonAgent[]>>;
let mockWorkflows: ReturnType<typeof signal<unknown[]>>;
let mockWorkflowDetails: ReturnType<typeof signal<SpaceWorkflow[]>>;
let mockWorkflowDetailsLoaded: ReturnType<typeof signal<boolean>>;
let mockLoading: ReturnType<typeof signal<boolean>>;
let mockSpaceId: ReturnType<typeof signal<string | null>>;
const mockDeleteAgent = vi.fn();
const mockSyncAgentFromTemplate = vi.fn();
const mockPreviewAgentTemplateSync = vi.fn();
const mockHubRequest = vi.fn();

vi.mock('../../../lib/space-store', () => ({
  get spaceStore() {
    return {
      agents: mockAgents,
      longHorizonAgents: mockLongHorizonAgents,
      workflows: mockWorkflows,
      workflowDetails: mockWorkflowDetails,
      workflowDetailsLoaded: mockWorkflowDetailsLoaded,
      loading: mockLoading,
      spaceId: mockSpaceId,
      deleteAgent: mockDeleteAgent,
      syncAgentFromTemplate: mockSyncAgentFromTemplate,
      previewAgentTemplateSync: mockPreviewAgentTemplateSync,
    };
  },
}));

vi.mock('../../../lib/connection-manager', () => ({
  connectionManager: {
    getHubIfConnected: () => ({ request: mockHubRequest }),
  },
}));

vi.mock('../../../lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

mockAgents = signal<SpaceWorkerAgent[]>([]);
mockLongHorizonAgents = signal<SpaceLongHorizonAgent[]>([]);
mockWorkflows = signal<unknown[]>([]);
mockWorkflowDetails = signal<SpaceWorkflow[]>([]);
mockWorkflowDetailsLoaded = signal(false);
mockLoading = signal(false);
mockSpaceId = signal('space-1');

import { SpaceWorkerAgentList } from '../SpaceWorkerAgentList';

function makeAgent(id: string, overrides: Partial<SpaceWorkerAgent> = {}): SpaceWorkerAgent {
  return {
    id,
    spaceId: 'space-1',
    name: `Agent ${id}`,
    handle: id,
    description: '',
    customPrompt: null,
    tools: ['Read'],
    model: 'claude-sonnet-4-6',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

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

describe('SpaceWorkerAgentList', () => {
  beforeEach(() => {
    cleanup();
    mockAgents.value = [];
    mockLongHorizonAgents.value = [];
    mockWorkflows.value = [];
    mockWorkflowDetails.value = [];
    mockWorkflowDetailsLoaded.value = true;
    mockLoading.value = false;
    mockSpaceId.value = 'space-1';
    mockDeleteAgent.mockReset();
    mockSyncAgentFromTemplate.mockReset();
    mockPreviewAgentTemplateSync.mockReset();
    mockHubRequest.mockResolvedValue({ report: { agents: [] } });
  });

  afterEach(() => {
    cleanup();
  });

  it('renders loading state', () => {
    mockLoading.value = true;

    const { getByText } = render(<SpaceWorkerAgentList />);

    expect(getByText('Loading agents...')).toBeTruthy();
  });

  it('shows Worker Agents title and persisted-agent description', () => {
    mockAgents.value = [makeAgent('coder-agent')];
    mockWorkflowDetails.value = [makeWorkflow()];

    const { getByText, queryByText } = render(<SpaceWorkerAgentList />);

    expect(getByText('Worker Agents · 1 configured')).toBeTruthy();
    expect(
      getByText(
        'Reusable worker agent types available to workflows in this space. Edit their model, tools, setting sources, and standing instructions.'
      )
    ).toBeTruthy();
    expect(queryByText('Worker Agents · 2 configured')).toBeNull();
  });

  it('lists persisted worker agents instead of workflow slots', () => {
    mockAgents.value = [makeAgent('persisted-coder')];
    mockWorkflowDetails.value = [makeWorkflow()];

    const { getByText, queryByText } = render(<SpaceWorkerAgentList />);

    expect(getByText('Agent persisted-coder')).toBeTruthy();
    expect(queryByText('Coder')).toBeNull();
    expect(queryByText('Reviewer')).toBeNull();
  });

  it('does not show long-horizon agents', () => {
    mockLongHorizonAgents.value = [makeLongHorizonAgent()];
    mockAgents.value = [makeAgent('worker')];

    const { queryByText } = render(<SpaceWorkerAgentList />);

    expect(queryByText('Persistent Coder')).toBeNull();
    expect(queryByText('persistent-coder')).toBeNull();
  });

  it('shows empty state when no persisted worker agents exist', () => {
    mockWorkflows.value = [{ id: 'wf-1', name: 'Coding Workflow', nodeCount: 2 }];
    mockWorkflowDetails.value = [makeWorkflow()];

    const { getByText, queryByText } = render(<SpaceWorkerAgentList />);

    expect(getByText('No worker agents configured.')).toBeTruthy();
    expect(getByText('Create a worker agent or seed one from a built-in template.')).toBeTruthy();
    expect(queryByText('Create a workflow to define worker agents.')).toBeNull();
  });

  it('confirms before syncing a drifted worker agent from its template', async () => {
    mockAgents.value = [makeAgent('coder-agent', { templateName: 'coder' })];
    mockHubRequest.mockResolvedValueOnce({
      report: { agents: [{ agentId: 'coder-agent', drifted: true }] },
    });

    const { getAllByText, getByText, queryByText } = render(<SpaceWorkerAgentList />);

    await waitFor(() => expect(getByText('Sync')).toBeTruthy());
    fireEvent.click(getByText('Sync'));

    expect(mockSyncAgentFromTemplate).not.toHaveBeenCalled();
    expect(getByText('Sync Worker Agent from Template')).toBeTruthy();

    fireEvent.click(getAllByText('Sync')[1]);

    await waitFor(() => expect(mockSyncAgentFromTemplate).toHaveBeenCalledWith('coder-agent'));
    await waitFor(() => expect(queryByText('Sync Worker Agent from Template')).toBeNull());
  });

  it('opens the preset diff modal when Diff is clicked on a drifted agent', async () => {
    mockAgents.value = [makeAgent('coder-agent', { name: 'Coder', templateName: 'Coder' })];
    mockHubRequest.mockResolvedValueOnce({
      report: { agents: [{ agentId: 'coder-agent', drifted: true }] },
    });
    mockPreviewAgentTemplateSync.mockResolvedValue({
      agentId: 'coder-agent',
      agentName: 'Coder',
      templateName: 'Coder',
      storedHash: 'stale',
      liveHash: 'live',
      drifted: true,
      diff: { customPrompt: { before: 'old prompt', after: 'new prompt' } },
    });

    const { getByText } = render(<SpaceWorkerAgentList />);

    await waitFor(() => expect(getByText('Diff')).toBeTruthy());
    fireEvent.click(getByText('Diff'));

    await waitFor(() => expect(getByText(/Preset diff/)).toBeTruthy());
    await waitFor(() => expect(mockPreviewAgentTemplateSync).toHaveBeenCalledWith('coder-agent'));
    // Before/after content rendered.
    expect(getByText('old prompt')).toBeTruthy();
    expect(getByText('new prompt')).toBeTruthy();
  });

  it('resets to preset from the diff modal and clears the drift badge', async () => {
    mockAgents.value = [makeAgent('coder-agent', { templateName: 'Coder' })];
    mockHubRequest.mockResolvedValueOnce({
      report: { agents: [{ agentId: 'coder-agent', drifted: true }] },
    });
    mockPreviewAgentTemplateSync.mockResolvedValue({
      agentId: 'coder-agent',
      agentName: 'Agent coder-agent',
      templateName: 'Coder',
      storedHash: 'stale',
      liveHash: 'live',
      drifted: true,
      diff: { customPrompt: { before: 'old', after: 'new' } },
    });
    mockSyncAgentFromTemplate.mockResolvedValue(
      makeAgent('coder-agent', { templateName: 'Coder' })
    );

    const { getByText, queryByText } = render(<SpaceWorkerAgentList />);

    // Badge present before reset.
    await waitFor(() => expect(getByText('Outdated')).toBeTruthy());

    fireEvent.click(getByText('Diff'));
    await waitFor(() => expect(getByText('Reset to preset')).toBeTruthy());
    fireEvent.click(getByText('Reset to preset'));

    await waitFor(() => expect(mockSyncAgentFromTemplate).toHaveBeenCalledWith('coder-agent'));
    await waitFor(() => expect(queryByText(/Preset diff/)).toBeNull());
    // Drift badge cleared eagerly after the reset.
    await waitFor(() => expect(queryByText('Outdated')).toBeNull());
  });

  it('clears stale modals when the active space changes', async () => {
    mockAgents.value = [makeAgent('coder-agent')];

    const { getByLabelText, getByText, queryByText, rerender } = render(<SpaceWorkerAgentList />);

    fireEvent.click(getByLabelText('Delete Agent coder-agent'));
    expect(getByText('Delete Worker Agent')).toBeTruthy();

    mockSpaceId.value = 'space-2';
    rerender(<SpaceWorkerAgentList />);

    await waitFor(() => expect(queryByText('Delete Worker Agent')).toBeNull());
    expect(mockDeleteAgent).not.toHaveBeenCalled();
  });
});
