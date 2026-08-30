import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup, waitFor, act } from '@testing-library/preact';
import { signal, type Signal } from '@preact/signals';
import type { SpaceWorkerAgent, SpaceWorkflow } from '@hyperneo/shared';
import { makeBuiltInTemplateWorkflows } from '../../__tests__/fixtures/builtInTemplateWorkflows';

const mockAgents: Signal<SpaceWorkerAgent[]> = signal([]);
const mockWorkflows: Signal<SpaceWorkflow[]> = signal([]);
const mockWorkflowTemplates: Signal<SpaceWorkflow[]> = signal([]);
const mockNodeExecutionsByNodeId = signal(new Map<string, unknown[]>());
const mockWorkflowRuns = signal<unknown[]>([]);

const mockCreateWorkflow = vi.fn();
const mockUpdateWorkflow = vi.fn();
const mockEnsureNodeExecutions = vi.fn().mockResolvedValue(undefined);

vi.mock('../../../../lib/connection-manager', () => ({
  connectionManager: {
    getHubIfConnected: () => ({
      request: vi.fn(async (method: string) => {
        if (method === 'models.list') {
          return {
            models: [
              {
                id: 'claude-sonnet-4-6',
                display_name: 'Claude Sonnet 4.6',
                description: '',
                provider: 'anthropic',
              },
              {
                id: 'gpt-5.4',
                display_name: 'GPT-5.4',
                description: '',
                provider: 'openai',
              },
            ],
          };
        }
        return {};
      }),
    }),
  },
}));

vi.mock('../../../../lib/space-store', () => ({
  get spaceStore() {
    return {
      agents: mockAgents,
      workflows: mockWorkflows,
      workflowTemplates: mockWorkflowTemplates,
      nodeExecutionsByNodeId: mockNodeExecutionsByNodeId,
      workflowRuns: mockWorkflowRuns,
      createWorkflow: mockCreateWorkflow,
      updateWorkflow: mockUpdateWorkflow,
      ensureNodeExecutions: mockEnsureNodeExecutions,
    };
  },
}));

vi.mock('../../../../lib/utils', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}));

import { VisualWorkflowEditor } from '../VisualWorkflowEditor';
import type { VisualWorkflowEditorProps } from '../VisualWorkflowEditor';

function makeAgent(id: string, name: string, _role = 'coder'): SpaceWorkerAgent {
  return {
    id,
    spaceId: 'space-1',
    name,
    handle: id,
    customPrompt: null,
    createdAt: 0,
    updatedAt: 0,
  };
}

const STEP_1_ID = 'step-1';
const STEP_2_ID = 'step-2';

function makeWorkflow(overrides: Partial<SpaceWorkflow> = {}): SpaceWorkflow {
  return {
    id: 'wf-1',
    spaceId: 'space-1',
    name: 'My Workflow',
    description: 'A workflow description',
    nodes: [
      { id: STEP_1_ID, name: 'Plan', agents: [{ agentId: 'agent-1', name: 'planner' }] },
      { id: STEP_2_ID, name: 'Code', agents: [{ agentId: 'agent-2', name: 'coder' }] },
    ],
    startNodeId: STEP_1_ID,
    channels: [{ from: 'Plan', to: 'Code' }],
    tags: [],
    createdAt: 0,
    updatedAt: 0,
    completionAutonomyLevel: 3,
    ...overrides,
  };
}

function makeProps(overrides: Partial<VisualWorkflowEditorProps> = {}): VisualWorkflowEditorProps {
  return {
    onSave: vi.fn(),
    onCancel: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  cleanup();
  mockAgents.value = [
    makeAgent('agent-1', 'Planner', 'planner'),
    makeAgent('agent-2', 'Coder', 'coder'),
    makeAgent('agent-3', 'General', 'general'),
    makeAgent('agent-4', 'Reviewer', 'reviewer'),
    makeAgent('agent-5', 'Research', 'research'),
    makeAgent('agent-6', 'QA', 'qa'),
  ];
  mockWorkflows.value = [];
  mockWorkflowTemplates.value = makeBuiltInTemplateWorkflows();
  mockCreateWorkflow.mockResolvedValue({ id: 'new-wf', nodes: [], tags: [] });
  mockUpdateWorkflow.mockResolvedValue({ id: 'wf-1', nodes: [], tags: [] });
  mockCreateWorkflow.mockClear();
  mockUpdateWorkflow.mockClear();
  mockEnsureNodeExecutions.mockClear();
});

afterEach(() => {
  cleanup();
});

describe('VisualWorkflowEditor', () => {
  describe('rendering — create mode', () => {
    it('renders the editor container', () => {
      const { getByTestId } = render(<VisualWorkflowEditor {...makeProps()} />);
      expect(getByTestId('visual-workflow-editor')).toBeTruthy();
    });

    it('releases the node-execution subscription on unmount', async () => {
      const { unmount } = render(<VisualWorkflowEditor {...makeProps()} />);
      await waitFor(() => expect(mockEnsureNodeExecutions).toHaveBeenCalled());
      mockEnsureNodeExecutions.mockClear();
      unmount();
      expect(mockEnsureNodeExecutions).toHaveBeenCalledWith(null);
    });

    it('loads node executions for the relevant run and re-loads when the run changes', async () => {
      const wf = makeWorkflow();
      mockWorkflowRuns.value = [
        { id: 'run-a', workflowId: 'wf-1', status: 'in_progress', updatedAt: 1 },
      ];
      const { rerender } = render(<VisualWorkflowEditor {...makeProps({ workflow: wf })} />);

      await waitFor(() => expect(mockEnsureNodeExecutions).toHaveBeenCalledWith('run-a'));

      mockEnsureNodeExecutions.mockClear();
      mockWorkflowRuns.value = [
        { id: 'run-a', workflowId: 'wf-1', status: 'completed', updatedAt: 1 },
        { id: 'run-b', workflowId: 'wf-1', status: 'in_progress', updatedAt: 2 },
      ];
      rerender(<VisualWorkflowEditor {...makeProps({ workflow: wf })} />);
      await waitFor(() => expect(mockEnsureNodeExecutions).toHaveBeenCalledWith('run-b'));
    });

    it('renders "New Workflow" title', () => {
      const { getByText } = render(<VisualWorkflowEditor {...makeProps()} />);
      expect(getByText('New Workflow')).toBeTruthy();
    });

    it('renders name and description inputs', () => {
      const { getByTestId } = render(<VisualWorkflowEditor {...makeProps()} />);
      expect(getByTestId('workflow-name-input')).toBeTruthy();
      expect(getByTestId('workflow-description-input')).toBeTruthy();
    });

    it('shows "Create Workflow" on the save button in create mode', () => {
      const { getByTestId } = render(<VisualWorkflowEditor {...makeProps()} />);
      expect(getByTestId('save-button').textContent).toBe('Create Workflow');
    });
  });

  describe('rendering — edit mode', () => {
    it('renders "Edit Workflow" title when workflow prop is provided', () => {
      const { getByText } = render(
        <VisualWorkflowEditor {...makeProps({ workflow: makeWorkflow() })} />
      );
      expect(getByText('Edit Workflow')).toBeTruthy();
    });

    it('pre-fills name field', () => {
      const { getByTestId } = render(
        <VisualWorkflowEditor {...makeProps({ workflow: makeWorkflow() })} />
      );
      expect((getByTestId('workflow-name-input') as HTMLInputElement).value).toBe('My Workflow');
    });

    it('pre-fills description field', () => {
      const { getByTestId } = render(
        <VisualWorkflowEditor {...makeProps({ workflow: makeWorkflow() })} />
      );
      expect((getByTestId('workflow-description-input') as HTMLInputElement).value).toBe(
        'A workflow description'
      );
    });

    it('shows "Save Changes" on the save button', () => {
      const { getByTestId } = render(
        <VisualWorkflowEditor {...makeProps({ workflow: makeWorkflow() })} />
      );
      expect(getByTestId('save-button').textContent).toBe('Save Changes');
    });

    it('renders with saved layout positions without throwing', () => {
      const layout = { [STEP_1_ID]: { x: 50, y: 50 }, [STEP_2_ID]: { x: 300, y: 200 } };
      const { getByTestId } = render(
        <VisualWorkflowEditor {...makeProps({ workflow: makeWorkflow({ layout }) })} />
      );
      expect(getByTestId('visual-workflow-editor')).toBeTruthy();
    });

    it('renders without layout (auto-layout fallback) without throwing', () => {
      const { getByTestId } = render(
        <VisualWorkflowEditor {...makeProps({ workflow: makeWorkflow({ layout: undefined }) })} />
      );
      expect(getByTestId('visual-workflow-editor')).toBeTruthy();
    });
  });

  describe('Add Step', () => {
    it('adds a node when Add Step is clicked', () => {
      const { getByTestId, queryAllByTestId } = render(<VisualWorkflowEditor {...makeProps()} />);
      expect(queryAllByTestId(/^workflow-node-/).length).toBe(0);

      fireEvent.click(getByTestId('add-step-button'));

      expect(queryAllByTestId(/^workflow-node-/).length).toBe(1);
    });

    it('adding a second step does not replace the first', () => {
      const { getByTestId, getAllByTestId } = render(<VisualWorkflowEditor {...makeProps()} />);
      fireEvent.click(getByTestId('add-step-button'));
      fireEvent.click(getByTestId('add-step-button'));
      expect(getAllByTestId(/^workflow-node-/).length).toBe(2);
    });

    it('first added step gets the START badge', () => {
      const { getByTestId, getByText } = render(<VisualWorkflowEditor {...makeProps()} />);
      fireEvent.click(getByTestId('add-step-button'));
      expect(getByText('START')).toBeTruthy();
    });
  });

  describe('Cancel', () => {
    it('calls onCancel when Cancel button is clicked', () => {
      const onCancel = vi.fn();
      const { getByTestId } = render(<VisualWorkflowEditor {...makeProps({ onCancel })} />);
      fireEvent.click(getByTestId('cancel-button'));
      expect(onCancel).toHaveBeenCalledOnce();
    });

    it('calls onCancel when back arrow is clicked', () => {
      const onCancel = vi.fn();
      const { getByTestId } = render(<VisualWorkflowEditor {...makeProps({ onCancel })} />);
      fireEvent.click(getByTestId('back-button'));
      expect(onCancel).toHaveBeenCalledOnce();
    });
  });

  describe('Node selection — NodeConfigPanel', () => {
    it('clicking a node opens NodeConfigPanel', () => {
      const { getAllByTestId, queryByTestId } = render(
        <VisualWorkflowEditor {...makeProps({ workflow: makeWorkflow() })} />
      );
      expect(queryByTestId('node-config-panel')).toBeNull();

      const firstRegularNode = getAllByTestId(/^workflow-node-/)[0];
      fireEvent.click(firstRegularNode);

      expect(queryByTestId('node-config-panel')).toBeTruthy();
    });

    it('NodeConfigPanel close button dismisses the panel', () => {
      const { getAllByTestId, queryByTestId, getByTestId } = render(
        <VisualWorkflowEditor {...makeProps({ workflow: makeWorkflow() })} />
      );
      fireEvent.click(getAllByTestId(/^workflow-node-/)[0]);
      expect(queryByTestId('node-config-panel')).toBeTruthy();

      fireEvent.click(getByTestId('close-button'));
      expect(queryByTestId('node-config-panel')).toBeNull();
    });

    it('Set as Start Node button updates the start badge', () => {
      const { container, getAllByTestId, queryByTestId, getByTestId } = render(
        <VisualWorkflowEditor {...makeProps({ workflow: makeWorkflow() })} />
      );

      const nodes = getAllByTestId(/^workflow-node-/);
      const nonStartNode = nodes.find((n) => !n.querySelector('[data-testid="start-badge"]'));
      expect(nonStartNode).toBeTruthy();
      fireEvent.click(nonStartNode!);

      expect(queryByTestId('set-as-start-button')).toBeTruthy();
      fireEvent.click(getByTestId('set-as-start-button'));

      const updatedNodes = container.querySelectorAll('[data-testid^="workflow-node-"]');
      const startBadges = container.querySelectorAll('[data-testid="start-badge"]');
      expect(startBadges.length).toBe(1);
      const startNode = Array.from(updatedNodes).find((n) => n.contains(startBadges[0]));
      expect(startNode).toBe(
        nonStartNode!.closest('[data-testid^="workflow-node-"]') ?? nonStartNode
      );
    });

    it('deleting a node removes it from the canvas and closes the panel', () => {
      const { container, getAllByTestId, queryByTestId, getByTestId } = render(
        <VisualWorkflowEditor {...makeProps({ workflow: makeWorkflow() })} />
      );
      const nodesBefore = getAllByTestId(/^workflow-node-/).length;

      const nodes = getAllByTestId(/^workflow-node-/);
      const nonStartNode = nodes.find((n) => !n.querySelector('[data-testid="start-badge"]'))!;
      fireEvent.click(nonStartNode);

      fireEvent.click(getByTestId('delete-step-button'));
      fireEvent.click(getByTestId('delete-confirm-button'));

      expect(getAllByTestId(/^workflow-node-/).length).toBe(nodesBefore - 1);
      expect(queryByTestId('node-config-panel')).toBeNull();
    });

    it('keyboard Delete on start node — next regular node becomes start (wasStart=true path)', () => {
      const { container, getAllByTestId } = render(
        <VisualWorkflowEditor {...makeProps({ workflow: makeWorkflow() })} />
      );

      const allNodes = getAllByTestId(/^workflow-node-/);
      const startNode = allNodes.find((n) => n.querySelector('[data-testid="start-badge"]'))!;
      const nonStartRegular = allNodes.find(
        (n) => !n.querySelector('[data-testid="start-badge"]')
      )!;

      fireEvent.click(startNode);
      fireEvent.keyDown(document.body, { key: 'Delete' });

      expect(getAllByTestId(/^workflow-node-/).length).toBe(1);

      expect(nonStartRegular.querySelector('[data-testid="start-badge"]')).toBeTruthy();

      expect(container.querySelectorAll('[data-testid="start-badge"]')).toHaveLength(1);
    });

    it('editing step name in NodeConfigPanel updates the node step', () => {
      const { getAllByTestId, getByTestId } = render(
        <VisualWorkflowEditor {...makeProps({ workflow: makeWorkflow() })} />
      );
      fireEvent.click(getAllByTestId(/^workflow-node-/)[0]);

      const nameInput = getByTestId('step-name-input') as HTMLInputElement;
      fireEvent.input(nameInput, { target: { value: 'Updated Step Name' } });

      expect(nameInput.value).toBe('Updated Step Name');
    });
  });

  describe('handleCreateTransition', () => {
    it('renders no visible edges (transitions hidden; channels are primary connections)', () => {
      const { container } = render(
        <VisualWorkflowEditor {...makeProps({ workflow: makeWorkflow() })} />
      );
      expect(container.querySelectorAll('[data-edge-id]').length).toBe(0);
    });
  });

  describe('Save — validation', () => {
    it('shows error when name is empty', async () => {
      const { getByTestId, getByText } = render(<VisualWorkflowEditor {...makeProps()} />);
      fireEvent.click(getByTestId('save-button'));
      await waitFor(() => expect(getByText('Workflow name is required.')).toBeTruthy());
    });

    it('does not call createWorkflow when name is empty', async () => {
      const { getByTestId } = render(<VisualWorkflowEditor {...makeProps()} />);
      fireEvent.click(getByTestId('save-button'));
      await waitFor(() => expect(mockCreateWorkflow).not.toHaveBeenCalled());
    });

    it('shows error when there are no nodes', async () => {
      const { getByTestId, getByText } = render(<VisualWorkflowEditor {...makeProps()} />);
      fireEvent.input(getByTestId('workflow-name-input'), { target: { value: 'WF' } });
      fireEvent.click(getByTestId('save-button'));
      await waitFor(() =>
        expect(getByText('A workflow must have at least one node.')).toBeTruthy()
      );
    });

    it('shows error when a node has no agent', async () => {
      const { getByTestId, getByText } = render(<VisualWorkflowEditor {...makeProps()} />);
      fireEvent.input(getByTestId('workflow-name-input'), { target: { value: 'WF' } });
      fireEvent.click(getByTestId('add-step-button'));

      await act(async () => {
        fireEvent.click(getByTestId('save-button'));
      });
      await waitFor(() => expect(getByText('Node 1 requires an agent.')).toBeTruthy());
    });
  });

  describe('Save — new workflow', () => {
    it('calls createWorkflow with name and layout', async () => {
      const onSave = vi.fn();
      const { getByTestId, getAllByTestId } = render(
        <VisualWorkflowEditor {...makeProps({ onSave })} />
      );
      fireEvent.input(getByTestId('workflow-name-input'), { target: { value: 'Test WF' } });
      fireEvent.click(getByTestId('template-picker-button'));
      fireEvent.click(
        getAllByTestId('template-option').find(
          (el) => el.getAttribute('data-template-label') === 'Review-Only Workflow'
        )!
      );

      await act(async () => {
        fireEvent.click(getByTestId('save-button'));
      });
      await waitFor(() => expect(mockCreateWorkflow).toHaveBeenCalledOnce());

      const params = mockCreateWorkflow.mock.calls[0][0];
      expect(params.name).toBe('Test WF');
      expect(params).toHaveProperty('layout');
    });

    it('layout includes a position entry for each step', async () => {
      const { getByTestId, getAllByTestId } = render(<VisualWorkflowEditor {...makeProps()} />);
      fireEvent.input(getByTestId('workflow-name-input'), { target: { value: 'L' } });
      fireEvent.click(getByTestId('template-picker-button'));
      fireEvent.click(
        getAllByTestId('template-option').find(
          (el) => el.getAttribute('data-template-label') === 'Coding Workflow'
        )!
      );

      await act(async () => {
        fireEvent.click(getByTestId('save-button'));
      });
      await waitFor(() => expect(mockCreateWorkflow).toHaveBeenCalledOnce());

      const { layout } = mockCreateWorkflow.mock.calls[0][0];
      expect(Object.keys(layout).length).toBe(2);
      for (const pos of Object.values(layout) as { x: number; y: number }[]) {
        expect(typeof pos.x).toBe('number');
        expect(typeof pos.y).toBe('number');
      }
    });

    it('calls onSave after successful create', async () => {
      const onSave = vi.fn();
      const { getByTestId, getAllByTestId } = render(
        <VisualWorkflowEditor {...makeProps({ onSave })} />
      );
      fireEvent.input(getByTestId('workflow-name-input'), { target: { value: 'N' } });
      fireEvent.click(getByTestId('template-picker-button'));
      fireEvent.click(
        getAllByTestId('template-option').find(
          (el) => el.getAttribute('data-template-label') === 'Review-Only Workflow'
        )!
      );

      await act(async () => {
        fireEvent.click(getByTestId('save-button'));
      });
      await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    });
  });

  describe('Save — existing workflow', () => {
    it('calls updateWorkflow (not createWorkflow) when editing', async () => {
      const { getByTestId } = render(
        <VisualWorkflowEditor {...makeProps({ workflow: makeWorkflow() })} />
      );
      await act(async () => {
        fireEvent.click(getByTestId('save-button'));
      });
      await waitFor(() => {
        expect(mockUpdateWorkflow).toHaveBeenCalledOnce();
        expect(mockCreateWorkflow).not.toHaveBeenCalled();
      });
    });

    it('passes the workflow id to updateWorkflow', async () => {
      const { getByTestId } = render(
        <VisualWorkflowEditor {...makeProps({ workflow: makeWorkflow() })} />
      );
      await act(async () => {
        fireEvent.click(getByTestId('save-button'));
      });
      await waitFor(() => expect(mockUpdateWorkflow).toHaveBeenCalledOnce());
      expect(mockUpdateWorkflow.mock.calls[0][0]).toBe('wf-1');
    });

    it('includes layout in update params', async () => {
      const { getByTestId } = render(
        <VisualWorkflowEditor {...makeProps({ workflow: makeWorkflow() })} />
      );
      await act(async () => {
        fireEvent.click(getByTestId('save-button'));
      });
      await waitFor(() => expect(mockUpdateWorkflow).toHaveBeenCalledOnce());

      const params = mockUpdateWorkflow.mock.calls[0][1];
      expect(params).toHaveProperty('layout');
      expect(Object.keys(params.layout).length).toBe(2);
    });

    it('saved layout positions are preserved through save', async () => {
      const layout = { [STEP_1_ID]: { x: 100, y: 50 }, [STEP_2_ID]: { x: 400, y: 200 } };
      const { getByTestId } = render(
        <VisualWorkflowEditor {...makeProps({ workflow: makeWorkflow({ layout }) })} />
      );
      await act(async () => {
        fireEvent.click(getByTestId('save-button'));
      });
      await waitFor(() => expect(mockUpdateWorkflow).toHaveBeenCalledOnce());

      const positions = Object.values(mockUpdateWorkflow.mock.calls[0][1].layout) as {
        x: number;
        y: number;
      }[];
      expect(positions.some((p) => p.x === 100 && p.y === 50)).toBe(true);
    });
  });

  describe('Autonomy level selector', () => {
    it('renders all 5 autonomy level buttons', () => {
      const { getByTestId } = render(<VisualWorkflowEditor {...makeProps()} />);
      for (let level = 1; level <= 5; level++) {
        expect(getByTestId(`autonomy-level-${level}`)).toBeTruthy();
      }
    });

    it('defaults to level 3 in create mode', () => {
      const { getByTestId } = render(<VisualWorkflowEditor {...makeProps()} />);
      const btn3 = getByTestId('autonomy-level-3');
      expect(btn3.className).toContain('bg-accent/10');
    });

    it('reflects workflow completionAutonomyLevel in edit mode', () => {
      const { getByTestId } = render(
        <VisualWorkflowEditor
          {...makeProps({ workflow: makeWorkflow({ completionAutonomyLevel: 5 }) })}
        />
      );
      const btn5 = getByTestId('autonomy-level-5');
      expect(btn5.className).toContain('bg-accent/10');
    });

    it('includes completionAutonomyLevel in createWorkflow call', async () => {
      const { getByTestId, getAllByTestId } = render(<VisualWorkflowEditor {...makeProps()} />);
      fireEvent.input(getByTestId('workflow-name-input'), { target: { value: 'WF' } });
      fireEvent.click(getByTestId('autonomy-level-4'));
      fireEvent.click(getByTestId('template-picker-button'));
      fireEvent.click(
        getAllByTestId('template-option').find(
          (el) => el.getAttribute('data-template-label') === 'Review-Only Workflow'
        )!
      );
      await act(async () => {
        fireEvent.click(getByTestId('save-button'));
      });
      await waitFor(() => expect(mockCreateWorkflow).toHaveBeenCalledOnce());
      const params = mockCreateWorkflow.mock.calls[0][0];
      expect(params.completionAutonomyLevel).toBe(4);
    });

    it('includes completionAutonomyLevel in updateWorkflow call', async () => {
      const { getByTestId } = render(
        <VisualWorkflowEditor
          {...makeProps({ workflow: makeWorkflow({ completionAutonomyLevel: 3 }) })}
        />
      );
      fireEvent.click(getByTestId('autonomy-level-2'));
      await act(async () => {
        fireEvent.click(getByTestId('save-button'));
      });
      await waitFor(() => expect(mockUpdateWorkflow).toHaveBeenCalledOnce());
      const params = mockUpdateWorkflow.mock.calls[0][1];
      expect(params.completionAutonomyLevel).toBe(2);
    });
  });

  describe('Post-approval route', () => {
    it('reflects legacy workflow postApproval on the end node in edit mode', () => {
      const { getAllByTestId, getByTestId, queryByTestId } = render(
        <VisualWorkflowEditor
          {...makeProps({
            workflow: makeWorkflow({
              endNodeId: STEP_2_ID,
              postApproval: {
                targetAgent: 'coder',
                instructions: 'Deploy {{task_id}}.',
              },
            }),
          })}
        />
      );

      const codeNode = getAllByTestId(/^workflow-node-/).find((node) =>
        node.textContent?.includes('Code')
      )!;
      fireEvent.click(codeNode);

      expect((getByTestId('post-approval-enabled-checkbox') as HTMLInputElement).checked).toBe(
        true
      );
      expect(queryByTestId('post-approval-target-select')).toBeNull();
      expect(
        (getByTestId('post-approval-instructions-textarea') as HTMLTextAreaElement).value
      ).toBe('Deploy {{task_id}}.');
    });

    it('includes edited node postApproval in updateWorkflow call', async () => {
      const { getAllByTestId, getByTestId } = render(
        <VisualWorkflowEditor
          {...makeProps({
            workflow: makeWorkflow({
              endNodeId: STEP_2_ID,
              postApproval: {
                targetAgent: 'coder',
                instructions: 'Old instructions.',
              },
            }),
          })}
        />
      );

      const codeNode = getAllByTestId(/^workflow-node-/).find((node) =>
        node.textContent?.includes('Code')
      )!;
      fireEvent.click(codeNode);

      fireEvent.input(getByTestId('post-approval-instructions-textarea'), {
        target: { value: 'Deploy {{task_id}}.' },
      });
      await act(async () => {
        fireEvent.click(getByTestId('save-button'));
      });

      await waitFor(() => expect(mockUpdateWorkflow).toHaveBeenCalledOnce());
      const params = mockUpdateWorkflow.mock.calls[0][1];
      const codeParams = params.nodes.find((node: { name: string }) => node.name === 'Code');
      expect(codeParams.postApproval).toEqual({
        targetAgent: 'coder',
        instructions: 'Deploy {{task_id}}.',
      });
      expect(params.postApproval).toBeNull();
    });
  });

  describe('Tags', () => {
    it('does not render tag suggestion buttons', () => {
      const { queryByText } = render(<VisualWorkflowEditor {...makeProps()} />);
      expect(queryByText('+coding')).toBeNull();
      expect(queryByText('+review')).toBeNull();
    });

    it('removes a tag via × button', () => {
      const wf = makeWorkflow({ tags: ['research'] });
      const { getByLabelText, queryByText } = render(
        <VisualWorkflowEditor {...makeProps({ workflow: wf })} />
      );
      expect(queryByText('research')).toBeTruthy();

      fireEvent.click(getByLabelText('Remove tag research'));
      expect(queryByText('research')).toBeNull();
    });

    it('adds a tag by typing and pressing Enter', () => {
      const { container, queryByText } = render(<VisualWorkflowEditor {...makeProps()} />);
      const tagInput = container.querySelector(
        'input[placeholder="Add tags…"]'
      ) as HTMLInputElement;

      fireEvent.input(tagInput, { target: { value: 'mytag' } });
      fireEvent.keyDown(tagInput, { key: 'Enter' });

      expect(queryByText('mytag')).toBeTruthy();
    });
  });

  describe('Template picker', () => {
    it('shows template picker button in create mode', () => {
      const { getByTestId } = render(<VisualWorkflowEditor {...makeProps()} />);
      expect(getByTestId('template-picker-button')).toBeTruthy();
    });

    it('hides template picker button in edit mode', () => {
      const { queryByTestId } = render(
        <VisualWorkflowEditor {...makeProps({ workflow: makeWorkflow() })} />
      );
      expect(queryByTestId('template-picker-button')).toBeNull();
    });

    it('shows template dropdown when button is clicked', () => {
      const { getByTestId, getAllByTestId } = render(<VisualWorkflowEditor {...makeProps()} />);
      fireEvent.click(getByTestId('template-picker-button'));
      const options = getAllByTestId('template-option');
      expect(options.length).toBe(mockWorkflowTemplates.value.length);
    });

    it('hides dropdown when button clicked again', () => {
      const { getByTestId, queryAllByTestId } = render(<VisualWorkflowEditor {...makeProps()} />);
      fireEvent.click(getByTestId('template-picker-button'));
      fireEvent.click(getByTestId('template-picker-button'));
      expect(queryAllByTestId('template-option').length).toBe(0);
    });

    it('selecting a template populates nodes', () => {
      const { getByTestId, getAllByTestId } = render(<VisualWorkflowEditor {...makeProps()} />);
      fireEvent.click(getByTestId('template-picker-button'));

      const options = getAllByTestId('template-option');
      const codingOption = options.find(
        (el) => el.getAttribute('data-template-label') === 'Coding Workflow'
      );
      expect(codingOption).toBeTruthy();
      fireEvent.click(codingOption!);

      expect(getAllByTestId(/^workflow-node-/).length).toBe(2);
    });

    it('selecting a template creates nodes but no visible edges (transitions hidden)', () => {
      const { getByTestId, getAllByTestId, container } = render(
        <VisualWorkflowEditor {...makeProps()} />
      );
      fireEvent.click(getByTestId('template-picker-button'));
      const options = getAllByTestId('template-option');
      const codingOption = options.find(
        (el) => el.getAttribute('data-template-label') === 'Coding Workflow'
      );
      fireEvent.click(codingOption!);

      expect(container.querySelectorAll('[data-edge-id]').length).toBe(0);
    });

    it('selecting a template assigns autoLayout positions (non-zero for at least one node)', () => {
      const { getByTestId, getAllByTestId } = render(<VisualWorkflowEditor {...makeProps()} />);
      fireEvent.click(getByTestId('template-picker-button'));
      const options = getAllByTestId('template-option');
      const codingOption = options.find(
        (el) => el.getAttribute('data-template-label') === 'Coding Workflow'
      );
      fireEvent.click(codingOption!);

      const nodes = getAllByTestId(/^workflow-node-/);
      const hasNonZeroLeft = nodes.some((n) => {
        const left = n.style.left;
        return left !== '' && left !== '0px' && left !== '0';
      });
      expect(hasNonZeroLeft).toBe(true);
    });

    it('selects first step as start node after template applied', () => {
      const { getByTestId, getAllByTestId } = render(<VisualWorkflowEditor {...makeProps()} />);
      fireEvent.click(getByTestId('template-picker-button'));
      const options = getAllByTestId('template-option');
      const codingOption = options.find(
        (el) => el.getAttribute('data-template-label') === 'Coding Workflow'
      );
      fireEvent.click(codingOption!);

      const startBadges = getAllByTestId(/^workflow-node-/).filter((n) =>
        n.textContent?.includes('START')
      );
      expect(startBadges.length).toBe(1);
    });

    it('sets workflow name from template label when name is empty', () => {
      const { getByTestId, getAllByTestId } = render(<VisualWorkflowEditor {...makeProps()} />);
      fireEvent.click(getByTestId('template-picker-button'));
      const options = getAllByTestId('template-option');
      const codingOption = options.find(
        (el) => el.getAttribute('data-template-label') === 'Coding Workflow'
      );
      fireEvent.click(codingOption!);

      expect((getByTestId('workflow-name-input') as HTMLInputElement).value).toBe(
        'Coding Workflow'
      );
    });

    it('does not override existing name when applying template', () => {
      const { getByTestId, getAllByTestId } = render(<VisualWorkflowEditor {...makeProps()} />);
      fireEvent.input(getByTestId('workflow-name-input'), { target: { value: 'My Custom Name' } });

      fireEvent.click(getByTestId('template-picker-button'));
      const options = getAllByTestId('template-option');
      const codingOption = options.find(
        (el) => el.getAttribute('data-template-label') === 'Coding Workflow'
      );
      fireEvent.click(codingOption!);

      expect((getByTestId('workflow-name-input') as HTMLInputElement).value).toBe('My Custom Name');
    });

    it('closes template dropdown after selecting a template', () => {
      const { getByTestId, getAllByTestId, queryAllByTestId } = render(
        <VisualWorkflowEditor {...makeProps()} />
      );
      fireEvent.click(getByTestId('template-picker-button'));
      const options = getAllByTestId('template-option');
      fireEvent.click(options[0]);

      expect(queryAllByTestId('template-option').length).toBe(0);
    });

    it('keeps template button visible after nodes have been added manually', () => {
      const { getByTestId, queryByTestId } = render(<VisualWorkflowEditor {...makeProps()} />);
      expect(queryByTestId('template-picker-button')).toBeTruthy();

      fireEvent.click(getByTestId('add-step-button'));

      expect(queryByTestId('template-picker-button')).toBeTruthy();
    });

    it('keeps template button visible after a template is applied', () => {
      const { getByTestId, getAllByTestId, queryByTestId } = render(
        <VisualWorkflowEditor {...makeProps()} />
      );
      fireEvent.click(getByTestId('template-picker-button'));
      const options = getAllByTestId('template-option');
      fireEvent.click(options[0]);

      expect(queryByTestId('template-picker-button')).toBeTruthy();
    });

    it('reapplying a template without canvas edits does not show confirmation', () => {
      const { getByTestId, getAllByTestId, queryByTestId } = render(
        <VisualWorkflowEditor {...makeProps()} />
      );
      fireEvent.click(getByTestId('template-picker-button'));
      fireEvent.click(
        getAllByTestId('template-option').find(
          (el) => el.getAttribute('data-template-label') === 'Coding Workflow'
        )!
      );

      fireEvent.click(getByTestId('template-picker-button'));
      fireEvent.click(
        getAllByTestId('template-option').find(
          (el) => el.getAttribute('data-template-label') === 'Review-Only Workflow'
        )!
      );

      expect(queryByTestId('confirm-template-apply-button')).toBeNull();
      expect(getAllByTestId(/^workflow-node-/).length).toBe(1);
    });

    it('shows confirmation when selecting a template after canvas edits', () => {
      const { getByTestId, getAllByTestId, getByText } = render(
        <VisualWorkflowEditor {...makeProps()} />
      );
      fireEvent.click(getByTestId('template-picker-button'));
      fireEvent.click(
        getAllByTestId('template-option').find(
          (el) => el.getAttribute('data-template-label') === 'Coding Workflow'
        )!
      );

      fireEvent.click(getAllByTestId(/^workflow-node-/)[0]);
      fireEvent.input(getByTestId('step-name-input'), { target: { value: 'Planning Revised' } });

      fireEvent.click(getByTestId('template-picker-button'));
      fireEvent.click(
        getAllByTestId('template-option').find(
          (el) => el.getAttribute('data-template-label') === 'Review-Only Workflow'
        )!
      );

      expect(getByTestId('confirm-template-apply-button')).toBeTruthy();
      expect(getByText('Replace current canvas?')).toBeTruthy();
    });

    it('confirms before replacing a modified canvas with a new template', async () => {
      const { getByTestId, getAllByTestId, getByText, queryByText } = render(
        <VisualWorkflowEditor {...makeProps()} />
      );
      fireEvent.click(getByTestId('template-picker-button'));
      fireEvent.click(
        getAllByTestId('template-option').find(
          (el) => el.getAttribute('data-template-label') === 'Coding Workflow'
        )!
      );

      fireEvent.click(getAllByTestId(/^workflow-node-/)[0]);
      fireEvent.input(getByTestId('step-name-input'), { target: { value: 'Planning Revised' } });

      fireEvent.click(getByTestId('template-picker-button'));
      fireEvent.click(
        getAllByTestId('template-option').find(
          (el) => el.getAttribute('data-template-label') === 'Review-Only Workflow'
        )!
      );
      fireEvent.click(getByTestId('confirm-template-apply-button'));

      await waitFor(() => expect(getAllByTestId(/^workflow-node-/).length).toBe(1));
      expect(queryByText('Replace current canvas?')).toBeNull();
    });

    it('canceling template confirmation preserves the modified canvas', () => {
      const { getByTestId, getAllByTestId, getByText, queryByText, getAllByText } = render(
        <VisualWorkflowEditor {...makeProps()} />
      );
      fireEvent.click(getByTestId('template-picker-button'));
      fireEvent.click(
        getAllByTestId('template-option').find(
          (el) => el.getAttribute('data-template-label') === 'Coding Workflow'
        )!
      );

      fireEvent.click(getAllByTestId(/^workflow-node-/)[0]);
      fireEvent.input(getByTestId('step-name-input'), { target: { value: 'Planning Revised' } });

      fireEvent.click(getByTestId('template-picker-button'));
      fireEvent.click(
        getAllByTestId('template-option').find(
          (el) => el.getAttribute('data-template-label') === 'Review-Only Workflow'
        )!
      );
      fireEvent.click(getAllByText('Cancel').at(-1)!);

      expect(queryByText('Replace current canvas?')).toBeNull();
      expect(getAllByText('Planning Revised').length).toBeGreaterThan(0);
    });

    it('single-step template (Review-Only) creates one node and no edges', () => {
      const { getByTestId, getAllByTestId, container } = render(
        <VisualWorkflowEditor {...makeProps()} />
      );
      fireEvent.click(getByTestId('template-picker-button'));
      const options = getAllByTestId('template-option');
      const quickFixOption = options.find(
        (el) => el.getAttribute('data-template-label') === 'Review-Only Workflow'
      );
      fireEvent.click(quickFixOption!);

      expect(getAllByTestId(/^workflow-node-/).length).toBe(1);
      expect(container.querySelectorAll('[data-edge-id]').length).toBe(0);
    });

    it('shows Coding with QA Workflow template and creates 3 workflow nodes', () => {
      const { getByTestId, getAllByTestId, container } = render(
        <VisualWorkflowEditor {...makeProps()} />
      );
      fireEvent.click(getByTestId('template-picker-button'));
      const options = getAllByTestId('template-option');
      const qaOption = options.find(
        (el) => el.getAttribute('data-template-label') === 'Coding with QA Workflow'
      );
      expect(qaOption).toBeTruthy();
      fireEvent.click(qaOption!);

      expect(getAllByTestId(/^workflow-node-/).length).toBe(3);
      expect(getByTestId('native-workflow-canvas-panel')).toBeTruthy();
    });

    it('clicking a semantic channel edge opens the channel relation side panel', () => {
      const { getByTestId, getAllByTestId, container, queryByTestId } = render(
        <VisualWorkflowEditor {...makeProps()} />
      );
      fireEvent.click(getByTestId('template-picker-button'));
      const options = getAllByTestId('template-option');
      const qaOption = options.find(
        (el) => el.getAttribute('data-template-label') === 'Coding with QA Workflow'
      );
      fireEvent.click(qaOption!);

      expect(queryByTestId('channel-relation-config-panel')).toBeNull();
      const firstChannelHitbox = container.querySelector(
        '[data-channel-edge="true"] path[stroke="transparent"]'
      ) as SVGPathElement | null;
      expect(firstChannelHitbox).toBeTruthy();
      fireEvent.click(firstChannelHitbox!);

      expect(getByTestId('channel-relation-config-panel')).toBeTruthy();
    });

    it('one-way channel relation shows convert button and expands to explicit reverse link', async () => {
      const workflow = makeWorkflow({});
      const { container, getByTestId, getAllByTestId, getByText, queryByText } = render(
        <VisualWorkflowEditor {...makeProps({ workflow })} />
      );

      const firstChannelHitbox = container.querySelector(
        '[data-channel-edge="true"] path[stroke="transparent"]'
      ) as SVGPathElement | null;
      expect(firstChannelHitbox).toBeTruthy();
      fireEvent.click(firstChannelHitbox!);

      const relationPanel = getByTestId('channel-relation-config-panel');
      expect(relationPanel).toBeTruthy();
      expect(relationPanel.textContent).toContain('Plan → Code · 1 editable link');
      expect(getByTestId('convert-channel-relation-button')).toBeTruthy();
      expect(getAllByTestId('channel-edge-config-panel')).toHaveLength(1);

      fireEvent.click(getByTestId('convert-channel-relation-button'));

      await waitFor(() =>
        expect(getByTestId('channel-relation-config-panel').textContent).toContain(
          'Plan ↔ Code · 2 editable links'
        )
      );
      expect(getByText('Reverse links')).toBeTruthy();
      expect(getAllByTestId('channel-edge-config-panel')).toHaveLength(2);
    });

    it('converting to bidirectional shows cyclic info on the reverse link', async () => {
      const workflow = makeWorkflow({});
      const { container, getByTestId, getAllByTestId } = render(
        <VisualWorkflowEditor {...makeProps({ workflow })} />
      );

      const firstChannelHitbox = container.querySelector(
        '[data-channel-edge="true"] path[stroke="transparent"]'
      ) as SVGPathElement | null;
      expect(firstChannelHitbox).toBeTruthy();
      fireEvent.click(firstChannelHitbox!);
      fireEvent.click(getByTestId('convert-channel-relation-button'));

      await waitFor(() => expect(getAllByTestId('channel-cyclic-info')).toHaveLength(1));
    });

    it('deleting the reverse link downgrades a converted relation back to one-way', async () => {
      const workflow = makeWorkflow({});
      const { container, getByTestId, getAllByTestId, queryByText } = render(
        <VisualWorkflowEditor {...makeProps({ workflow })} />
      );

      const firstChannelHitbox = container.querySelector(
        '[data-channel-edge="true"] path[stroke="transparent"]'
      ) as SVGPathElement | null;
      expect(firstChannelHitbox).toBeTruthy();
      fireEvent.click(firstChannelHitbox!);
      fireEvent.click(getByTestId('convert-channel-relation-button'));

      const relationPanel = getByTestId('channel-relation-config-panel');
      await waitFor(() =>
        expect(
          relationPanel.querySelectorAll('[data-testid="delete-channel-button"]')
        ).toHaveLength(2)
      );
      fireEvent.click(relationPanel.querySelectorAll('[data-testid="delete-channel-button"]')[1]);

      await waitFor(() => {
        expect(getByTestId('channel-relation-config-panel').textContent).toContain(
          'Plan → Code · 1 editable link'
        );
        expect(getAllByTestId('channel-edge-config-panel')).toHaveLength(1);
      });
    });

    it('shows cyclic info for backward links that close a loop', async () => {
      const workflow = makeWorkflow({
        channels: [
          { from: 'Plan', to: 'Code' },
          { from: 'Code', to: 'Plan' },
        ],
      });
      const { container, getAllByTestId } = render(
        <VisualWorkflowEditor {...makeProps({ workflow })} />
      );

      const firstChannelHitbox = container.querySelector(
        '[data-channel-edge="true"] path[stroke="transparent"]'
      ) as SVGPathElement | null;
      expect(firstChannelHitbox).toBeTruthy();
      fireEvent.click(firstChannelHitbox!);

      await waitFor(() => expect(getAllByTestId('channel-edge-config-panel')).toHaveLength(2));
      expect(getAllByTestId('channel-cyclic-info')).toHaveLength(1);
    });

    it('node side panel lists channel links that open the nested relation view and back returns to node details', () => {
      const { getByTestId, getAllByTestId, getByText, queryAllByTestId } = render(
        <VisualWorkflowEditor {...makeProps()} />
      );
      fireEvent.click(getByTestId('template-picker-button'));
      const options = getAllByTestId('template-option');
      const qaOption = options.find(
        (el) => el.getAttribute('data-template-label') === 'Coding with QA Workflow'
      );
      fireEvent.click(qaOption!);

      const reviewNode = getAllByTestId('step-name').find((el) =>
        el.textContent?.includes('Review')
      );
      fireEvent.click(reviewNode!.closest('[data-testid^="workflow-node-"]')!);
      expect(getByTestId('node-config-panel')).toBeTruthy();

      const linkButtons = queryAllByTestId('node-channel-link-button');
      expect(linkButtons.length).toBeGreaterThan(0);
      fireEvent.click(linkButtons[0]);

      expect(getByTestId('channel-relation-config-panel')).toBeTruthy();
      expect(getByTestId('node-panel-back-button')).toBeTruthy();
      fireEvent.click(getByTestId('node-panel-back-button'));
      expect(getByTestId('node-config-panel')).toBeTruthy();
    });
  });
});
