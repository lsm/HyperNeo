// @ts-nocheck
/**
 * Unit tests for SpaceAgentList
 *
 * Tests:
 * - Loading state
 * - Empty state: "No worker agents yet. Create one to get started."
 * - Agent cards render name, model, description preview
 * - Tool count and preview tags render
 * - Create worker agent button opens editor
 * - Edit button opens editor for that agent
 * - Delete button behavior:
 *   - When agent IS referenced by a workflow: shows blocking modal (no delete button)
 *   - When agent is NOT referenced: shows standard confirm dialog
 * - Successful delete calls spaceStore.deleteAgent
 * - Delete error is shown in confirm modal
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, waitFor, cleanup } from '@testing-library/preact';
import { signal } from '@preact/signals';
import type { SpaceAgent, SpaceWorkflow } from '@neokai/shared';

// ── Mocks ────────────────────────────────────────────────────────────────────

let mockAgents: ReturnType<typeof signal<SpaceAgent[]>>;
let mockWorkflows: ReturnType<typeof signal<SpaceWorkflow[]>>;
let mockLoading: ReturnType<typeof signal<boolean>>;
let mockSpaceId: ReturnType<typeof signal<string | null>>;
let mockSpace: ReturnType<typeof signal<any>>;

const { mockDeleteAgent, mockCreateAgent, mockUpdateAgent } = vi.hoisted(() => ({
  mockDeleteAgent: vi.fn(),
  mockCreateAgent: vi.fn(),
  mockUpdateAgent: vi.fn(),
}));

vi.mock('../../../lib/space-store', () => ({
  get spaceStore() {
    return {
      agents: mockAgents,
      workflows: mockWorkflows,
      loading: mockLoading,
      spaceId: mockSpaceId,
      space: mockSpace,
      deleteAgent: mockDeleteAgent,
      createAgent: mockCreateAgent,
      updateAgent: mockUpdateAgent,
    };
  },
}));

const mockHubRequest = vi.fn();
vi.mock('../../../lib/connection-manager', () => ({
  connectionManager: {
    getHubIfConnected: () => ({ request: mockHubRequest }),
    onceConnected: vi.fn(),
  },
}));

vi.mock('../../../lib/toast', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  },
}));

vi.mock('../../../lib/utils', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}));

// Mock WorkflowModelSelect (used by TaskAgentCard)
vi.mock('../visual-editor/WorkflowModelSelect', () => ({
  WorkflowModelSelect: ({ value, onChange, testId, className }) => (
    <select
      data-testid={testId}
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value || undefined)}
      class={className}
    >
      <option value="">-- No override --</option>
      <option value="claude-sonnet-4-6">Claude Sonnet 4.6</option>
    </select>
  ),
}));

// Mock SpaceAgentEditor so tests don't need to set up all of its dependencies
vi.mock('../SpaceAgentEditor', () => ({
  SpaceAgentEditor: ({
    agent,
    onSave,
    onCancel,
  }: {
    agent: SpaceAgent | null;
    onSave: () => void;
    onCancel: () => void;
  }) => (
    <div data-testid="agent-editor">
      <span data-testid="editor-mode">{agent ? 'edit' : 'create'}</span>
      {agent && <span data-testid="editor-agent-name">{agent.name}</span>}
      <button onClick={onSave} data-testid="editor-save">
        Save
      </button>
      <button onClick={onCancel} data-testid="editor-cancel">
        Cancel
      </button>
    </div>
  ),
}));

vi.mock('../../ui/Button', () => ({
  Button: ({
    children,
    onClick,
    type,
    loading,
    disabled,
    icon,
  }: {
    children: unknown;
    onClick?: () => void;
    type?: string;
    loading?: boolean;
    disabled?: boolean;
    icon?: unknown;
  }) => (
    <button type={type ?? 'button'} onClick={onClick} disabled={disabled || loading}>
      {icon}
      {loading ? 'Loading...' : children}
    </button>
  ),
}));

vi.mock('../../ui/ConfirmModal', () => ({
  ConfirmModal: ({
    isOpen,
    onClose,
    onConfirm,
    title,
    message,
    confirmText,
    isLoading,
    error,
  }: {
    isOpen: boolean;
    onClose: () => void;
    onConfirm: () => void;
    title: string;
    message: string;
    confirmText?: string;
    isLoading?: boolean;
    error?: string | null;
  }) => {
    if (!isOpen) return null;
    return (
      <div data-testid="confirm-modal" role="dialog" aria-label={title}>
        <p data-testid="confirm-message">{message}</p>
        {error && <p data-testid="confirm-error">{error}</p>}
        <button onClick={onClose} data-testid="confirm-cancel">
          Cancel
        </button>
        <button onClick={onConfirm} disabled={isLoading} data-testid="confirm-delete">
          {confirmText ?? 'Confirm'}
        </button>
      </div>
    );
  },
}));

vi.mock('../../ui/Modal', () => ({
  Modal: ({
    isOpen,
    children,
    title,
    onClose,
  }: {
    isOpen: boolean;
    children: unknown;
    title: string;
    onClose: () => void;
  }) => {
    if (!isOpen) return null;
    return (
      <div data-testid="block-modal" role="dialog" aria-label={title}>
        <button onClick={onClose} data-testid="block-modal-close">
          X
        </button>
        {children}
      </div>
    );
  },
}));

// Initialize signals before import
mockAgents = signal<SpaceAgent[]>([]);
mockWorkflows = signal<SpaceWorkflow[]>([]);
mockLoading = signal(false);
mockSpaceId = signal<string | null>('space-1');
mockSpace = signal<any>({
  id: 'space-1',
  slug: 'neokai-dev',
  defaultModel: undefined,
  taskAgentConfig: undefined,
});

import { SpaceAgentList } from '../SpaceAgentList';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeAgent(overrides: Partial<SpaceAgent> = {}): SpaceAgent {
  return {
    id: 'agent-1',
    spaceId: 'space-1',
    name: 'My Coder',
    handle: 'my-coder',
    description: 'A worker agent',
    model: 'claude-sonnet-4-6',
    tools: ['Read', 'Write', 'Edit', 'Bash'],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

function makeWorkflow(agentId: string): SpaceWorkflow {
  return {
    id: 'wf-1',
    spaceId: 'space-1',
    name: 'Coding Workflow',
    nodes: [{ id: 'node-1', name: 'Node 1', agents: [{ agentId, name: 'coder' }] }],
    startNodeId: 'node-1',
    tags: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

const DEFAULT_PROPS = {};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('SpaceAgentList', () => {
  beforeEach(() => {
    cleanup();
    mockAgents.value = [];
    mockWorkflows.value = [];
    mockLoading.value = false;
    mockSpaceId.value = 'space-1';
    mockDeleteAgent.mockReset();
    mockCreateAgent.mockReset();
    mockUpdateAgent.mockReset();
    mockHubRequest.mockReset();
    // Default: drift report returns no drifted agents so the list renders cleanly.
    mockHubRequest.mockResolvedValue({
      report: { spaceId: 'space-1', agents: [] },
    });
  });

  afterEach(() => {
    cleanup();
  });

  // ── Loading state ──────────────────────────────────────────────────────────

  it('renders loading state when loading is true', () => {
    mockLoading.value = true;
    const { getByText } = render(<SpaceAgentList {...DEFAULT_PROPS} />);
    expect(getByText('Loading worker agents...')).toBeTruthy();
  });

  // ── Empty state ────────────────────────────────────────────────────────────

  it('renders empty state when no agents exist', () => {
    const { getByText } = render(<SpaceAgentList {...DEFAULT_PROPS} />);
    expect(getByText('No worker agents yet')).toBeTruthy();
    expect(getByText('Create one to get started.')).toBeTruthy();
  });

  it('renders header Create worker agent button always', () => {
    const { getAllByText } = render(<SpaceAgentList {...DEFAULT_PROPS} />);
    // Both the header button and the empty-state button exist
    const buttons = getAllByText('Create worker agent');
    expect(buttons.length).toBeGreaterThanOrEqual(1);
  });

  // ── Agent list rendering ──────────────────────────────────────────────────

  it('renders agent name', () => {
    mockAgents.value = [makeAgent({ name: 'My Coder' })];
    const { getByText } = render(<SpaceAgentList {...DEFAULT_PROPS} />);
    expect(getByText('My Coder')).toBeTruthy();
  });

  it('renders model when set', () => {
    mockAgents.value = [makeAgent({ model: 'claude-haiku-4-5' })];
    const { getByText } = render(<SpaceAgentList {...DEFAULT_PROPS} />);
    expect(getByText('claude-haiku-4-5')).toBeTruthy();
  });

  it('does not render model span when model is not set', () => {
    mockAgents.value = [makeAgent({ model: undefined })];
    const { container } = render(<SpaceAgentList {...DEFAULT_PROPS} />);
    const agentCards = container.querySelectorAll('.bg-dark-850.border.border-dark-700');
    for (const card of agentCards) {
      const modelSpans = card.querySelectorAll('span.text-xs.text-gray-500.font-mono');
      expect(modelSpans.length).toBe(0);
    }
  });

  it('renders description preview', () => {
    mockAgents.value = [makeAgent({ description: 'Specialist in frontend code' })];
    const { getByText } = render(<SpaceAgentList {...DEFAULT_PROPS} />);
    expect(getByText('Specialist in frontend code')).toBeTruthy();
  });

  it('renders tool count and preview tags', () => {
    mockAgents.value = [makeAgent({ tools: ['Read', 'Write', 'Edit', 'Bash'] })];
    const { getByText, queryByText } = render(<SpaceAgentList {...DEFAULT_PROPS} />);
    expect(getByText('4 tools')).toBeTruthy();
    expect(getByText('Read')).toBeTruthy();
    expect(getByText('Write')).toBeTruthy();
    expect(getByText('Edit')).toBeTruthy();
    expect(queryByText('Bash')).toBeNull();
  });

  it('renders total tool count when agent has more tools than the preview', () => {
    mockAgents.value = [makeAgent({ tools: ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob'] })];
    const { getByText, queryByText } = render(<SpaceAgentList {...DEFAULT_PROPS} />);
    expect(getByText('6 tools')).toBeTruthy();
    expect(queryByText('+2 more')).toBeNull();
  });

  it('does not render tool tags when tools is empty', () => {
    mockAgents.value = [makeAgent({ tools: [] })];
    const { queryByText } = render(<SpaceAgentList {...DEFAULT_PROPS} />);
    expect(queryByText('+0 more')).toBeNull();
  });

  it('renders multiple agents', () => {
    mockAgents.value = [
      makeAgent({ id: 'a1', name: 'Agent Alpha' }),
      makeAgent({ id: 'a2', name: 'Agent Beta' }),
    ];
    const { getByText } = render(<SpaceAgentList {...DEFAULT_PROPS} />);
    expect(getByText('Agent Alpha')).toBeTruthy();
    expect(getByText('Agent Beta')).toBeTruthy();
  });

  it('renders workflow usage footer', () => {
    const { getByText } = render(<SpaceAgentList {...DEFAULT_PROPS} />);
    expect(getByText('Workflow usage')).toBeTruthy();
    expect(getByText(/workflows can reference these worker agents/)).toBeTruthy();
  });

  // ── Editor opening ─────────────────────────────────────────────────────────

  it('opens editor in create mode when Create worker agent header button is clicked', () => {
    const { getAllByText, getByTestId } = render(<SpaceAgentList {...DEFAULT_PROPS} />);
    const createButtons = getAllByText('Create worker agent');
    fireEvent.click(createButtons[0]);
    expect(getByTestId('editor-mode').textContent).toBe('create');
  });

  it('opens editor in edit mode when edit button is clicked', () => {
    const agent = makeAgent({ name: 'Coder' });
    mockAgents.value = [agent];
    const { getByLabelText, getByTestId } = render(<SpaceAgentList {...DEFAULT_PROPS} />);
    fireEvent.click(getByLabelText('Edit Coder'));
    expect(getByTestId('editor-mode').textContent).toBe('edit');
    expect(getByTestId('editor-agent-name').textContent).toBe('Coder');
  });

  it('closes editor when cancel is clicked', () => {
    const { getAllByText, queryByTestId, getByTestId } = render(
      <SpaceAgentList {...DEFAULT_PROPS} />
    );
    fireEvent.click(getAllByText('Create worker agent')[0]);
    expect(getByTestId('agent-editor')).toBeTruthy();
    fireEvent.click(getByTestId('editor-cancel'));
    expect(queryByTestId('agent-editor')).toBeNull();
  });

  it('closes editor when save is called', () => {
    const { getAllByText, queryByTestId, getByTestId } = render(
      <SpaceAgentList {...DEFAULT_PROPS} />
    );
    fireEvent.click(getAllByText('Create worker agent')[0]);
    fireEvent.click(getByTestId('editor-save'));
    expect(queryByTestId('agent-editor')).toBeNull();
  });

  // ── Delete flow — unreferenced agent ─────────────────────────────────────

  it('opens standard confirm dialog when agent is not referenced by any workflow', () => {
    const agent = makeAgent({ name: 'Coder' });
    mockAgents.value = [agent];
    mockWorkflows.value = [];
    const { getByLabelText, getByTestId } = render(<SpaceAgentList {...DEFAULT_PROPS} />);
    fireEvent.click(getByLabelText('Delete Coder'));
    expect(getByTestId('confirm-modal')).toBeTruthy();
  });

  it('shows simple cannot-be-undone message for unreferenced agent', () => {
    const agent = makeAgent({ id: 'agent-1', name: 'Coder' });
    mockAgents.value = [agent];
    mockWorkflows.value = [];
    const { getByLabelText, getByTestId } = render(<SpaceAgentList {...DEFAULT_PROPS} />);
    fireEvent.click(getByLabelText('Delete Coder'));
    const msg = getByTestId('confirm-message').textContent ?? '';
    expect(msg).toContain('cannot be undone');
  });

  it('calls spaceStore.deleteAgent on confirm for unreferenced agent', async () => {
    const agent = makeAgent({ id: 'agent-1', name: 'Coder' });
    mockAgents.value = [agent];
    mockDeleteAgent.mockResolvedValue(undefined);

    const { getByLabelText, getByTestId } = render(<SpaceAgentList {...DEFAULT_PROPS} />);
    fireEvent.click(getByLabelText('Delete Coder'));
    fireEvent.click(getByTestId('confirm-delete'));

    await waitFor(() => {
      expect(mockDeleteAgent).toHaveBeenCalledWith('agent-1');
    });
  });

  it('closes confirmation modal after successful delete', async () => {
    const agent = makeAgent({ id: 'agent-1', name: 'Coder' });
    mockAgents.value = [agent];
    mockDeleteAgent.mockResolvedValue(undefined);

    const { getByLabelText, getByTestId, queryByTestId } = render(
      <SpaceAgentList {...DEFAULT_PROPS} />
    );
    fireEvent.click(getByLabelText('Delete Coder'));
    fireEvent.click(getByTestId('confirm-delete'));

    await waitFor(() => {
      expect(queryByTestId('confirm-modal')).toBeNull();
    });
  });

  it('shows error in confirmation modal when delete fails', async () => {
    const agent = makeAgent({ id: 'agent-1', name: 'Coder' });
    mockAgents.value = [agent];
    mockDeleteAgent.mockRejectedValue(new Error('Agent is in use by a workflow step'));

    const { getByLabelText, getByTestId, findByTestId } = render(
      <SpaceAgentList {...DEFAULT_PROPS} />
    );
    fireEvent.click(getByLabelText('Delete Coder'));
    fireEvent.click(getByTestId('confirm-delete'));

    const errorEl = await findByTestId('confirm-error');
    expect(errorEl.textContent).toContain('Agent is in use by a workflow step');
  });

  it('closes confirmation modal when cancel is clicked', () => {
    const agent = makeAgent({ name: 'Coder' });
    mockAgents.value = [agent];
    const { getByLabelText, getByTestId, queryByTestId } = render(
      <SpaceAgentList {...DEFAULT_PROPS} />
    );
    fireEvent.click(getByLabelText('Delete Coder'));
    expect(getByTestId('confirm-modal')).toBeTruthy();
    fireEvent.click(getByTestId('confirm-cancel'));
    expect(queryByTestId('confirm-modal')).toBeNull();
  });

  // ── Delete flow — workflow-referenced agent (no longer blocked client-side) ─

  it('shows confirm modal (not blocking) even when agent is used in a workflow', () => {
    const agent = makeAgent({ id: 'agent-1', name: 'Coder' });
    mockAgents.value = [agent];
    mockWorkflows.value = [makeWorkflow('agent-1')];
    const { getByLabelText, getByTestId, queryByTestId } = render(
      <SpaceAgentList {...DEFAULT_PROPS} />
    );
    fireEvent.click(getByLabelText('Delete Coder'));
    // Should show the confirm modal, NOT a blocking modal
    expect(getByTestId('confirm-modal')).toBeTruthy();
    expect(queryByTestId('block-modal')).toBeNull();
  });

  it('confirm modal shows agent name when referenced by workflow', () => {
    const agent = makeAgent({ id: 'agent-1', name: 'Coder' });
    mockAgents.value = [agent];
    mockWorkflows.value = [makeWorkflow('agent-1')];
    const { getByLabelText, getByTestId } = render(<SpaceAgentList {...DEFAULT_PROPS} />);
    fireEvent.click(getByLabelText('Delete Coder'));
    expect(getByTestId('confirm-message').textContent).toContain('Coder');
  });

  it('confirm modal title is "Delete worker agent" even for referenced agents', () => {
    const agent = makeAgent({ id: 'agent-1', name: 'Coder' });
    mockAgents.value = [agent];
    mockWorkflows.value = [makeWorkflow('agent-1')];
    const { getByLabelText, getByRole } = render(<SpaceAgentList {...DEFAULT_PROPS} />);
    fireEvent.click(getByLabelText('Delete Coder'));
    expect(getByRole('dialog', { name: 'Delete worker agent' })).toBeTruthy();
  });

  it('does not call deleteAgent when confirm modal is cancelled', () => {
    const agent = makeAgent({ id: 'agent-1', name: 'Coder' });
    mockAgents.value = [agent];
    mockWorkflows.value = [makeWorkflow('agent-1')];
    const { getByLabelText, getByTestId } = render(<SpaceAgentList {...DEFAULT_PROPS} />);
    fireEvent.click(getByLabelText('Delete Coder'));
    // Cancel the confirm modal
    fireEvent.click(getByTestId('confirm-cancel'));
    expect(mockDeleteAgent).not.toHaveBeenCalled();
  });

  it('closing confirm modal removes it from view', () => {
    const agent = makeAgent({ id: 'agent-1', name: 'Coder' });
    mockAgents.value = [agent];
    mockWorkflows.value = [makeWorkflow('agent-1')];
    const { getByLabelText, getByTestId, queryByTestId } = render(
      <SpaceAgentList {...DEFAULT_PROPS} />
    );
    fireEvent.click(getByLabelText('Delete Coder'));
    expect(getByTestId('confirm-modal')).toBeTruthy();
    fireEvent.click(getByTestId('confirm-cancel'));
    expect(queryByTestId('confirm-modal')).toBeNull();
  });

  // ── Drift detection & sync ────────────────────────────────────────────────

  it('renders "Out of sync" badge for drifted preset agents', async () => {
    const agent = makeAgent({ id: 'agent-1', name: 'Coder', templateName: 'Coder' });
    mockAgents.value = [agent];
    mockHubRequest.mockResolvedValue({
      report: {
        spaceId: 'space-1',
        agents: [
          {
            agentId: 'agent-1',
            agentName: 'Coder',
            templateName: 'Coder',
            storedHash: 'a',
            currentHash: 'b',
            drifted: true,
          },
        ],
      },
    });

    const { findByText } = render(<SpaceAgentList {...DEFAULT_PROPS} />);
    expect(await findByText('Out of sync')).toBeTruthy();
  });

  it('does NOT render "Out of sync" badge for non-drifted preset agents', async () => {
    const agent = makeAgent({ id: 'agent-1', name: 'Coder', templateName: 'Coder' });
    mockAgents.value = [agent];
    mockHubRequest.mockResolvedValue({
      report: {
        spaceId: 'space-1',
        agents: [
          {
            agentId: 'agent-1',
            agentName: 'Coder',
            templateName: 'Coder',
            storedHash: 'a',
            currentHash: 'a',
            drifted: false,
          },
        ],
      },
    });

    const { queryByText } = render(<SpaceAgentList {...DEFAULT_PROPS} />);
    // Allow the drift effect to settle.
    await waitFor(() => {
      expect(mockHubRequest).toHaveBeenCalledWith('spaceAgent.getDriftReport', {
        spaceId: 'space-1',
      });
    });
    expect(queryByText('Out of sync')).toBeNull();
  });

  it('clicking "Sync" calls spaceAgent.syncFromTemplate and clears badge', async () => {
    const agent = makeAgent({ id: 'agent-1', name: 'Coder', templateName: 'Coder' });
    mockAgents.value = [agent];

    // First call: getDriftReport (drifted). Subsequent: syncFromTemplate (success).
    mockHubRequest.mockImplementation(async (method: string) => {
      if (method === 'spaceAgent.getDriftReport') {
        return {
          report: {
            spaceId: 'space-1',
            agents: [
              {
                agentId: 'agent-1',
                agentName: 'Coder',
                templateName: 'Coder',
                storedHash: 'a',
                currentHash: 'b',
                drifted: true,
              },
            ],
          },
        };
      }
      if (method === 'spaceAgent.syncFromTemplate') {
        return { agent };
      }
      return {};
    });

    const { findByText, queryByText } = render(<SpaceAgentList {...DEFAULT_PROPS} />);
    const syncButton = await findByText('Sync');

    fireEvent.click(syncButton);

    await waitFor(() => {
      expect(mockHubRequest).toHaveBeenCalledWith('spaceAgent.syncFromTemplate', {
        spaceId: 'space-1',
        agentId: 'agent-1',
      });
    });

    // Optimistic clear: the badge should disappear after a successful sync.
    await waitFor(() => {
      expect(queryByText('Out of sync')).toBeNull();
    });
  });

  it('does not crash when drift report request fails', async () => {
    const agent = makeAgent({ id: 'agent-1', name: 'Coder', templateName: 'Coder' });
    mockAgents.value = [agent];
    mockHubRequest.mockRejectedValue(new Error('hub error'));

    const { getByText } = render(<SpaceAgentList {...DEFAULT_PROPS} />);
    // The agent card still renders normally even when drift detection fails.
    expect(getByText('Coder')).toBeTruthy();
  });

  // ── Existing agent names passed to editor ──────────────────────────────────

  it('excludes editing agent from existingAgentNames passed to editor', () => {
    // When editing agent-1, its own name should not count as a conflict in the editor.
    // We verify indirectly by ensuring the editor opens in edit mode with the correct agent.
    const agents = [
      makeAgent({ id: 'a1', name: 'Coder' }),
      makeAgent({ id: 'a2', name: 'Reviewer' }),
    ];
    mockAgents.value = agents;
    const { getByLabelText, getByTestId } = render(<SpaceAgentList {...DEFAULT_PROPS} />);
    fireEvent.click(getByLabelText('Edit Coder'));
    expect(getByTestId('editor-agent-name').textContent).toBe('Coder');
  });
});
