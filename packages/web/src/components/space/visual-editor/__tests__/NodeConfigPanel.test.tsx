import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, fireEvent, cleanup, act, waitFor } from '@testing-library/preact';
import { useState } from 'preact/hooks';
import type { SpaceWorkerAgent, WorkflowHook } from '@hyperneo/shared';

const mockModels = [
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
  {
    id: 'gpt-5.4',
    display_name: 'GPT-5.4 via Custom',
    description: '',
    provider: 'custom:endpoint-2',
  },
  {
    id: 'custom/model:with:colon',
    display_name: 'Colon Model',
    description: '',
    provider: 'custom:endpoint-1',
  },
  {
    id: 'endpoint-1:shared',
    display_name: 'Collision A',
    description: '',
    provider: 'custom',
  },
  {
    id: 'shared',
    display_name: 'Collision B',
    description: '',
    provider: 'custom:endpoint-1',
  },
];

const mockModelsResponse = {
  models: mockModels.map((model) => ({ ...model })),
};

const mockHub = {
  request: vi.fn(async (method: string) => {
    if (method === 'models.list') {
      return mockModelsResponse;
    }
    return {};
  }),
};

vi.mock('../../../../lib/connection-manager', () => ({
  connectionManager: {
    getHub: () => Promise.resolve(mockHub),
    getHubIfConnected: () => mockHub,
  },
}));

import { WorkflowModelSelect } from '../WorkflowModelSelect';
import { NodeConfigPanel } from '../NodeConfigPanel';
import type { NodeConfigPanelProps } from '../NodeConfigPanel';
import type { NodeDraft } from '../../WorkflowNodeCard';
import { skillsStore } from '../../../../lib/skills-store';
import type { AppSkill } from '@hyperneo/shared';

afterEach(() => {
  cleanup();
  mockModelsResponse.models = mockModels.map((model) => ({ ...model }));
});

function makeAgent(id: string, name: string, _role = 'coder'): SpaceWorkerAgent {
  return {
    id,
    spaceId: 'space-1',
    name,
    handle: id,
    customPrompt: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

function makeStep(overrides: Partial<NodeDraft> = {}): NodeDraft {
  return {
    localId: 'step-local-1',
    name: 'My Step',
    agentId: 'agent-1',
    ...overrides,
  };
}

const defaultAgents: SpaceWorkerAgent[] = [
  makeAgent('agent-1', 'Planner', 'planner'),
  makeAgent('agent-2', 'Coder', 'coder'),
];

function makeProps(overrides: Partial<NodeConfigPanelProps> = {}): NodeConfigPanelProps {
  return {
    step: makeStep(),
    agents: defaultAgents,
    isStartNode: false,
    isEndNode: false,
    onUpdate: vi.fn(),
    onSetAsStart: vi.fn(),
    onSetAsEnd: vi.fn(),
    onClose: vi.fn(),
    onDelete: vi.fn(),
    ...overrides,
  };
}

describe('NodeConfigPanel', () => {
  describe('rendering', () => {
    it('renders the panel element', () => {
      const { getByTestId } = render(<NodeConfigPanel {...makeProps()} />);
      expect(getByTestId('node-config-panel')).toBeTruthy();
    });

    it('shows the step name in the header', () => {
      const { getByText } = render(
        <NodeConfigPanel {...makeProps({ step: makeStep({ name: 'Parse Data' }) })} />
      );
      expect(getByText('Parse Data')).toBeTruthy();
    });

    it('shows "Unnamed Node" when name is empty', () => {
      const { getByText } = render(
        <NodeConfigPanel {...makeProps({ step: makeStep({ name: '' }) })} />
      );
      expect(getByText('Unnamed Node')).toBeTruthy();
    });

    it('renders the step name input with current value', () => {
      const { getByTestId } = render(<NodeConfigPanel {...makeProps()} />);
      const input = getByTestId('step-name-input') as HTMLInputElement;
      expect(input.value).toBe('My Step');
    });

    it('renders the agent dropdown with all agents', () => {
      const { getByTestId } = render(<NodeConfigPanel {...makeProps()} />);
      const select = getByTestId('agent-select') as HTMLSelectElement;
      const options = Array.from(select.querySelectorAll('option')).map((o) => o.textContent);
      expect(options).toContain('Planner');
      expect(options).toContain('Coder');
    });

    it('shows currently selected agent in dropdown', () => {
      const { getByTestId } = render(
        <NodeConfigPanel {...makeProps({ step: makeStep({ agentId: 'agent-2' }) })} />
      );
      const select = getByTestId('agent-select') as HTMLSelectElement;
      expect(select.value).toBe('agent-2');
    });

    it('does not render legacy node-level instructions textarea', () => {
      const { queryByTestId } = render(<NodeConfigPanel {...makeProps()} />);
      expect(queryByTestId('instructions-textarea')).toBeNull();
    });

    it('renders the single-agent model selector', async () => {
      const { getByTestId } = render(<NodeConfigPanel {...makeProps()} />);
      const input = getByTestId('single-agent-model-input') as HTMLSelectElement;
      await waitFor(() => expect(input.options.length).toBeGreaterThan(1));
      expect(input.value).toBe('');
    });

    it('shows selected single-agent model when provider is omitted', async () => {
      const { getByTestId } = render(
        <NodeConfigPanel {...makeProps({ step: makeStep({ model: 'gpt-5.4' }) })} />
      );
      const input = getByTestId('single-agent-model-input') as HTMLSelectElement;
      await waitFor(() => expect(input.options.length).toBeGreaterThan(1));
      expect(input.value).toBe('%5B%22openai%22%2C%22gpt-5.4%22%5D');
    });

    it('preserves provider-qualified selections containing colons', async () => {
      const onUpdate = vi.fn();
      const { getByTestId } = render(<NodeConfigPanel {...makeProps({ onUpdate })} />);
      const input = getByTestId('single-agent-model-input') as HTMLSelectElement;
      await waitFor(() => expect(input.options.length).toBeGreaterThan(1));
      input.value = '%5B%22custom%3Aendpoint-1%22%2C%22custom%2Fmodel%3Awith%3Acolon%22%5D';
      fireEvent.change(input);
      expect(onUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'custom/model:with:colon' })
      );
    });

    it('preserves raw colon IDs in out-of-list current selections', async () => {
      const onChange = vi.fn();
      const { getByTestId } = render(
        <WorkflowModelSelect
          value="stale:model:with:colon"
          onChange={onChange}
          testId="stale-colon-model-select"
        />
      );
      const input = getByTestId('stale-colon-model-select') as HTMLSelectElement;
      await waitFor(() => expect(input.options.length).toBeGreaterThan(1));
      expect(input.value).toBe('stale:model:with:colon');
      fireEvent.change(input);
      expect(onChange).toHaveBeenCalledWith('stale:model:with:colon', {
        modelId: 'stale:model:with:colon',
        provider: '',
      });
    });

    it('keeps selected provider for duplicate model IDs without provider prop', async () => {
      function Wrapper() {
        const [step, setStep] = useState(makeStep());
        return <NodeConfigPanel {...makeProps({ step, onUpdate: setStep })} />;
      }
      const { getByTestId } = render(<Wrapper />);
      const input = getByTestId('single-agent-model-input') as HTMLSelectElement;
      await waitFor(() => expect(input.options.length).toBeGreaterThan(1));
      input.value = '%5B%22custom%3Aendpoint-2%22%2C%22gpt-5.4%22%5D';
      fireEvent.change(input);
      expect(input.value).toBe('%5B%22custom%3Aendpoint-2%22%2C%22gpt-5.4%22%5D');
    });

    it('resets cached provider when providerless value changes', async () => {
      function Wrapper() {
        const [step, setStep] = useState(makeStep());
        return (
          <div>
            <button type="button" onClick={() => setStep(makeStep({ model: 'claude-sonnet-4-6' }))}>
              Switch model
            </button>
            <NodeConfigPanel {...makeProps({ step, onUpdate: setStep })} />
          </div>
        );
      }
      const { getByTestId, getByText } = render(<Wrapper />);
      const input = getByTestId('single-agent-model-input') as HTMLSelectElement;
      await waitFor(() => expect(input.options.length).toBeGreaterThan(1));
      input.value = '%5B%22custom%3Aendpoint-2%22%2C%22gpt-5.4%22%5D';
      fireEvent.change(input);
      expect(input.value).toBe('%5B%22custom%3Aendpoint-2%22%2C%22gpt-5.4%22%5D');
      fireEvent.click(getByText('Switch model'));
      expect(input.value).toBe('%5B%22anthropic%22%2C%22claude-sonnet-4-6%22%5D');
    });

    it('clears cached provider when provider prop is removed for the same value', async () => {
      function Wrapper() {
        const [provider, setProvider] = useState<string | undefined>('custom:endpoint-2');
        return (
          <div>
            <button type="button" onClick={() => setProvider(undefined)}>
              Clear provider
            </button>
            <WorkflowModelSelect
              value="gpt-5.4"
              provider={provider}
              onChange={vi.fn()}
              testId="provider-clear-model-select"
            />
          </div>
        );
      }
      const { getByTestId, getByText } = render(<Wrapper />);
      const input = getByTestId('provider-clear-model-select') as HTMLSelectElement;
      await waitFor(() => expect(input.options.length).toBeGreaterThan(1));
      expect(input.value).toBe('%5B%22custom%3Aendpoint-2%22%2C%22gpt-5.4%22%5D');
      fireEvent.click(getByText('Clear provider'));
      expect(input.value).toBe('%5B%22openai%22%2C%22gpt-5.4%22%5D');
    });

    it('keeps provider/model pairs distinct when colon-delimited keys collide', async () => {
      const { getByTestId } = render(<NodeConfigPanel {...makeProps()} />);
      const input = getByTestId('single-agent-model-input') as HTMLSelectElement;
      await waitFor(() => expect(input.options.length).toBeGreaterThan(1));
      const optionValues = Array.from(input.options).map((option) => option.value);
      expect(optionValues).toContain('%5B%22custom%22%2C%22endpoint-1%3Ashared%22%5D');
      expect(optionValues).toContain('%5B%22custom%3Aendpoint-1%22%2C%22shared%22%5D');
    });

    it('shows current fallback when cached provider value disappears but same model id remains', async () => {
      mockModelsResponse.models = mockModels
        .filter((model) => model.provider !== 'custom:endpoint-2')
        .map((model) => ({ ...model }));
      const { getByTestId, unmount } = render(
        <NodeConfigPanel {...makeProps({ step: makeStep({ model: 'gpt-5.4' }) })} />
      );
      const input = getByTestId('single-agent-model-input') as HTMLSelectElement;
      await waitFor(() => expect(input.options.length).toBeGreaterThan(1));
      expect(input.value).toBe('%5B%22openai%22%2C%22gpt-5.4%22%5D');
      unmount();

      function Wrapper() {
        const [step, setStep] = useState(makeStep());
        return <NodeConfigPanel {...makeProps({ step, onUpdate: setStep })} />;
      }
      mockModelsResponse.models = mockModels.map((model) => ({ ...model }));
      const { getByTestId: getByTestIdWithCustom } = render(<Wrapper />);
      const customInput = getByTestIdWithCustom('single-agent-model-input') as HTMLSelectElement;
      await waitFor(() => expect(customInput.options.length).toBeGreaterThan(1));
      customInput.value = '%5B%22custom%3Aendpoint-2%22%2C%22gpt-5.4%22%5D';
      fireEvent.change(customInput);
      expect(customInput.value).toBe('%5B%22custom%3Aendpoint-2%22%2C%22gpt-5.4%22%5D');
    });

    it('renders close button', () => {
      const { getByTestId } = render(<NodeConfigPanel {...makeProps()} />);
      expect(getByTestId('close-button')).toBeTruthy();
    });

    it('renders delete node button', () => {
      const { getByTestId } = render(<NodeConfigPanel {...makeProps()} />);
      expect(getByTestId('delete-step-button')).toBeTruthy();
    });
  });

  describe('start node badge', () => {
    it('shows START badge in header when isStartNode=true', () => {
      const { getByTestId } = render(<NodeConfigPanel {...makeProps({ isStartNode: true })} />);
      expect(getByTestId('start-node-badge')).toBeTruthy();
    });

    it('does not show START badge when isStartNode=false', () => {
      const { queryByTestId } = render(<NodeConfigPanel {...makeProps({ isStartNode: false })} />);
      expect(queryByTestId('start-node-badge')).toBeNull();
    });
  });

  describe('end node badge', () => {
    it('shows END badge in header when isEndNode=true', () => {
      const { getByTestId } = render(<NodeConfigPanel {...makeProps({ isEndNode: true })} />);
      expect(getByTestId('end-node-badge')).toBeTruthy();
    });

    it('does not show END badge when isEndNode=false', () => {
      const { queryByTestId } = render(<NodeConfigPanel {...makeProps({ isEndNode: false })} />);
      expect(queryByTestId('end-node-badge')).toBeNull();
    });
  });

  describe('"Set as Start" button', () => {
    it('is visible when node is not the start node', () => {
      const { getByTestId } = render(<NodeConfigPanel {...makeProps({ isStartNode: false })} />);
      expect(getByTestId('set-as-start-button')).toBeTruthy();
    });

    it('is hidden when node is already the start node', () => {
      const { queryByTestId } = render(<NodeConfigPanel {...makeProps({ isStartNode: true })} />);
      expect(queryByTestId('set-as-start-button')).toBeNull();
    });

    it('calls onSetAsStart with the step localId when clicked', () => {
      const onSetAsStart = vi.fn();
      const { getByTestId } = render(
        <NodeConfigPanel {...makeProps({ onSetAsStart, step: makeStep({ localId: 'my-step' }) })} />
      );
      fireEvent.click(getByTestId('set-as-start-button'));
      expect(onSetAsStart).toHaveBeenCalledWith('my-step');
    });
  });

  describe('"Set as End" button', () => {
    it('is visible when node is not the end node', () => {
      const { getByTestId } = render(<NodeConfigPanel {...makeProps({ isEndNode: false })} />);
      expect(getByTestId('set-as-end-button')).toBeTruthy();
    });

    it('is hidden when node is already the end node', () => {
      const { queryByTestId } = render(<NodeConfigPanel {...makeProps({ isEndNode: true })} />);
      expect(queryByTestId('set-as-end-button')).toBeNull();
    });

    it('shows "Unset End Node" button when node is the end node', () => {
      const { getByTestId } = render(<NodeConfigPanel {...makeProps({ isEndNode: true })} />);
      expect(getByTestId('unset-as-end-button')).toBeTruthy();
    });

    it('calls onSetAsEnd with the step localId when clicked', () => {
      const onSetAsEnd = vi.fn();
      const { getByTestId } = render(
        <NodeConfigPanel {...makeProps({ onSetAsEnd, step: makeStep({ localId: 'my-step' }) })} />
      );
      fireEvent.click(getByTestId('set-as-end-button'));
      expect(onSetAsEnd).toHaveBeenCalledWith('my-step');
    });

    it('"Unset End Node" button calls onSetAsEnd with the step localId', () => {
      const onSetAsEnd = vi.fn();
      const { getByTestId } = render(
        <NodeConfigPanel
          {...makeProps({ onSetAsEnd, isEndNode: true, step: makeStep({ localId: 'my-step' }) })}
        />
      );
      fireEvent.click(getByTestId('unset-as-end-button'));
      expect(onSetAsEnd).toHaveBeenCalledWith('my-step');
    });
  });

  describe('close button', () => {
    it('calls onClose when close button clicked', () => {
      const onClose = vi.fn();
      const { getByTestId } = render(<NodeConfigPanel {...makeProps({ onClose })} />);
      fireEvent.click(getByTestId('close-button'));
      expect(onClose).toHaveBeenCalledOnce();
    });
  });

  describe('field updates', () => {
    it('calls onUpdate with new name when step name changes', () => {
      const onUpdate = vi.fn();
      const { getByTestId } = render(<NodeConfigPanel {...makeProps({ onUpdate })} />);
      fireEvent.input(getByTestId('step-name-input'), { target: { value: 'New Name' } });
      expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ name: 'New Name' }));
    });

    it('calls onUpdate with new agentId when agent selection changes', () => {
      const onUpdate = vi.fn();
      const { getByTestId } = render(<NodeConfigPanel {...makeProps({ onUpdate })} />);
      fireEvent.change(getByTestId('agent-select'), { target: { value: 'agent-2' } });
      expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'agent-2' }));
    });

    it('calls onUpdate with new system prompt as WorkflowNodeAgentOverride from single prompts view', () => {
      const onUpdate = vi.fn();
      const { getByTestId } = render(<NodeConfigPanel {...makeProps({ onUpdate })} />);
      fireEvent.click(getByTestId('edit-single-prompts-button'));
      fireEvent.input(getByTestId('single-prompts-system-prompt'), {
        target: { value: 'Custom system prompt.' },
      });
      expect(onUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          customPrompt: { value: 'Custom system prompt.' },
        })
      );
    });

    it('calls onUpdate with new single-agent model when model selector changes', async () => {
      const onUpdate = vi.fn();
      const { getByTestId } = render(<NodeConfigPanel {...makeProps({ onUpdate })} />);
      await waitFor(() =>
        expect(
          (getByTestId('single-agent-model-input') as HTMLSelectElement).options.length
        ).toBeGreaterThan(1)
      );
      const input = getByTestId('single-agent-model-input') as HTMLSelectElement;
      input.value = '%5B%22openai%22%2C%22gpt-5.4%22%5D';
      fireEvent.change(input);
      expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ model: 'gpt-5.4' }));
    });

    it('clearing single-agent model sets model to undefined', async () => {
      const onUpdate = vi.fn();
      const { getByTestId } = render(
        <NodeConfigPanel {...makeProps({ onUpdate, step: makeStep({ model: 'gpt-5.4' }) })} />
      );
      await waitFor(() =>
        expect(
          (getByTestId('single-agent-model-input') as HTMLSelectElement).options.length
        ).toBeGreaterThan(1)
      );
      fireEvent.change(getByTestId('single-agent-model-input'), {
        target: { value: '' },
      });
      expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ model: undefined }));
    });

    it('shows edit prompts entry point for single-agent mode', () => {
      const { getByTestId, queryByTestId } = render(<NodeConfigPanel {...makeProps()} />);
      expect(getByTestId('edit-single-prompts-button')).toBeTruthy();
      expect(queryByTestId('single-agent-system-prompt')).toBeNull();
    });

    it('does not render the legacy inline instructions textarea', () => {
      const { queryByTestId } = render(<NodeConfigPanel {...makeProps()} />);
      expect(queryByTestId('instructions-textarea')).toBeNull();
    });
  });

  describe('delete node', () => {
    it('delete button is disabled for start node', () => {
      const { getByTestId } = render(<NodeConfigPanel {...makeProps({ isStartNode: true })} />);
      const btn = getByTestId('delete-step-button') as HTMLButtonElement;
      expect(btn.disabled).toBe(true);
    });

    it('delete button is enabled for non-start node', () => {
      const { getByTestId } = render(<NodeConfigPanel {...makeProps({ isStartNode: false })} />);
      const btn = getByTestId('delete-step-button') as HTMLButtonElement;
      expect(btn.disabled).toBe(false);
    });

    it('shows hint about designating another start node when start node is selected', () => {
      const { getByText } = render(<NodeConfigPanel {...makeProps({ isStartNode: true })} />);
      expect(getByText('Designate another node as start before deleting.')).toBeTruthy();
    });

    it('clicking delete shows confirmation dialog', () => {
      const { getByTestId } = render(<NodeConfigPanel {...makeProps()} />);
      fireEvent.click(getByTestId('delete-step-button'));
      expect(getByTestId('delete-confirm-button')).toBeTruthy();
      expect(getByTestId('delete-cancel-button')).toBeTruthy();
    });

    it('confirming delete calls onDelete with step localId', () => {
      const onDelete = vi.fn();
      const { getByTestId } = render(
        <NodeConfigPanel {...makeProps({ onDelete, step: makeStep({ localId: 'step-xyz' }) })} />
      );
      fireEvent.click(getByTestId('delete-step-button'));
      fireEvent.click(getByTestId('delete-confirm-button'));
      expect(onDelete).toHaveBeenCalledWith('step-xyz');
    });

    it('cancelling delete hides confirmation dialog', () => {
      const { getByTestId, queryByTestId } = render(<NodeConfigPanel {...makeProps()} />);
      fireEvent.click(getByTestId('delete-step-button'));
      expect(getByTestId('delete-confirm-button')).toBeTruthy();
      fireEvent.click(getByTestId('delete-cancel-button'));
      expect(queryByTestId('delete-confirm-button')).toBeNull();
      expect(getByTestId('delete-step-button')).toBeTruthy();
    });

    it('onDelete not called when cancel clicked', () => {
      const onDelete = vi.fn();
      const { getByTestId } = render(<NodeConfigPanel {...makeProps({ onDelete })} />);
      fireEvent.click(getByTestId('delete-step-button'));
      fireEvent.click(getByTestId('delete-cancel-button'));
      expect(onDelete).not.toHaveBeenCalled();
    });

    it('guard in handleDeleteClick suppresses dialog when isStartNode=true (defence-in-depth)', () => {
      const { getByTestId, queryByTestId } = render(
        <NodeConfigPanel {...makeProps({ isStartNode: true })} />
      );
      const btn = getByTestId('delete-step-button') as HTMLButtonElement;
      fireEvent.click(btn);
      expect(queryByTestId('delete-confirm-button')).toBeNull();
    });

    it('confirmation dialog is reset when selected step changes', async () => {
      const stepA = makeStep({ localId: 'step-a', name: 'Step A' });
      const stepB = makeStep({ localId: 'step-b', name: 'Step B' });
      const props = makeProps({ step: stepA });
      const { getByTestId, queryByTestId, rerender } = render(<NodeConfigPanel {...props} />);

      fireEvent.click(getByTestId('delete-step-button'));
      expect(getByTestId('delete-confirm-button')).toBeTruthy();

      await act(async () => {
        rerender(<NodeConfigPanel {...{ ...props, step: stepB }} />);
      });

      expect(queryByTestId('delete-confirm-button')).toBeNull();
      expect(getByTestId('delete-step-button')).toBeTruthy();
    });
  });

  describe('multi-agent mode', () => {
    it('shows single agent dropdown in single-agent mode', () => {
      const { getByTestId } = render(<NodeConfigPanel {...makeProps()} />);
      expect(getByTestId('agent-select')).toBeTruthy();
    });

    it('shows "Add agent" button in single-agent mode', () => {
      const { getByTestId } = render(<NodeConfigPanel {...makeProps()} />);
      expect(getByTestId('add-agent-button')).toBeTruthy();
    });

    it('clicking "Add agent" switches to multi-agent mode with existing agent', () => {
      const onUpdate = vi.fn();
      const { getByTestId } = render(<NodeConfigPanel {...makeProps({ onUpdate })} />);
      fireEvent.click(getByTestId('add-agent-button'));
      expect(onUpdate).toHaveBeenCalledOnce();
      const updatedStep = onUpdate.mock.calls[0][0];
      expect(updatedStep.agents).toHaveLength(2);
      expect(updatedStep.agents[0].agentId).toBe('agent-1');
      expect(updatedStep.agentId).toBe('');
    });

    it('carries replaceAgentPrompt onto the primary slot when adding a second agent', () => {
      const onUpdate = vi.fn();
      const { getByTestId } = render(
        <NodeConfigPanel
          {...makeProps({
            onUpdate,
            step: makeStep({ agentId: 'agent-1', replaceAgentPrompt: true }),
          })}
        />
      );
      fireEvent.click(getByTestId('add-agent-button'));
      const updatedStep = onUpdate.mock.calls[0][0];
      expect(updatedStep.agents[0].replaceAgentPrompt).toBe(true);
      expect(updatedStep.replaceAgentPrompt).toBeUndefined();
    });

    it('single→multi conversion carries resetContextPerTurn onto the primary slot', () => {
      const onUpdate = vi.fn();
      const { getByTestId } = render(
        <NodeConfigPanel
          {...makeProps({
            step: makeStep({ agentId: 'agent-1', resetContextPerTurn: true }),
            onUpdate,
          })}
        />
      );
      fireEvent.click(getByTestId('add-agent-button'));
      const updatedStep = onUpdate.mock.calls[onUpdate.mock.calls.length - 1][0];
      expect(updatedStep.agents[0].resetContextPerTurn).toBe(true);
    });

    it('does not auto-select Coordinator as the secondary agent', () => {
      const onUpdate = vi.fn();
      const agents = [
        makeAgent('coder-1', 'Coder'),
        makeAgent('coordinator-1', 'Coordinator'),
        makeAgent('general-1', 'General'),
      ];
      const { getByTestId } = render(
        <NodeConfigPanel
          {...makeProps({ agents, step: makeStep({ agentId: 'coder-1' }), onUpdate })}
        />
      );

      fireEvent.click(getByTestId('add-agent-button'));

      const updatedStep = onUpdate.mock.calls[0][0];
      expect(updatedStep.agents[0].agentId).toBe('coder-1');
      expect(updatedStep.agents[1].agentId).toBe('general-1');
    });

    it('shows agents list in multi-agent mode', () => {
      const step = makeStep({
        agentId: '',
        agents: [
          { agentId: 'agent-1', name: 'planner' },
          { agentId: 'agent-2', name: 'coder' },
        ],
      });
      const { getByTestId, queryByTestId } = render(<NodeConfigPanel {...makeProps({ step })} />);
      expect(getByTestId('agents-list')).toBeTruthy();
      expect(queryByTestId('agent-select')).toBeNull();
    });

    it('renders one entry per agent in multi-agent mode', () => {
      const step = makeStep({
        agentId: '',
        agents: [
          { agentId: 'agent-1', name: 'planner' },
          { agentId: 'agent-2', name: 'coder' },
        ],
      });
      const { getAllByTestId } = render(<NodeConfigPanel {...makeProps({ step })} />);
      expect(getAllByTestId('agent-entry')).toHaveLength(2);
    });

    it('shows agent name and role in each agent entry', () => {
      const step = makeStep({
        agentId: '',
        agents: [
          { agentId: 'agent-1', name: 'planner' },
          { agentId: 'agent-2', name: 'coder' },
        ],
      });
      const { getByTestId, getAllByTestId } = render(<NodeConfigPanel {...makeProps({ step })} />);
      const entry = getByTestId('agents-list');
      expect(entry.textContent).toContain('Planner');
      expect(entry.textContent).toContain('Coder');
      const roleInputs = getAllByTestId('agent-role-input') as HTMLInputElement[];
      expect(roleInputs[0].value).toBe('planner');
      expect(roleInputs[1].value).toBe('coder');
    });

    it('renders an agent selector for each multi-agent slot', () => {
      const step = makeStep({
        agentId: '',
        agents: [
          { agentId: 'agent-1', name: 'planner' },
          { agentId: 'agent-2', name: 'coder' },
        ],
      });
      const { getAllByTestId } = render(<NodeConfigPanel {...makeProps({ step })} />);
      const selects = getAllByTestId('agent-slot-select') as HTMLSelectElement[];
      expect(selects).toHaveLength(2);
      expect(selects[0].value).toBe('agent-1');
      expect(selects[1].value).toBe('agent-2');
    });

    it('remove agent button switches to single-agent mode when only one slot remains', () => {
      const onUpdate = vi.fn();
      const step = makeStep({
        agentId: '',
        agents: [
          { agentId: 'agent-1', name: 'planner' },
          { agentId: 'agent-2', name: 'coder' },
        ],
      });
      const { getAllByTestId } = render(<NodeConfigPanel {...makeProps({ step, onUpdate })} />);
      fireEvent.click(getAllByTestId('remove-agent-button')[0]);
      const updatedStep = onUpdate.mock.calls[0][0];
      expect(updatedStep.agents).toBeUndefined();
      expect(updatedStep.agentId).toBe('agent-2');
      expect(updatedStep.channels).toBeUndefined();
    });

    it('preserves replaceAgentPrompt in shorthand when removing down to a single agent', () => {
      const onUpdate = vi.fn();
      const step = makeStep({
        agentId: '',
        agents: [
          { agentId: 'agent-1', name: 'planner', replaceAgentPrompt: true },
          { agentId: 'agent-2', name: 'coder' },
        ],
      });
      const { getAllByTestId } = render(<NodeConfigPanel {...makeProps({ step, onUpdate })} />);
      fireEvent.click(getAllByTestId('remove-agent-button')[1]);
      const updatedStep = onUpdate.mock.calls[0][0];
      expect(updatedStep.agents).toBeUndefined();
      expect(updatedStep.replaceAgentPrompt).toBe(true);
    });

    it('removing one of three agents keeps multi-agent mode', () => {
      const onUpdate = vi.fn();
      const step = makeStep({
        agentId: '',
        agents: [
          { agentId: 'agent-1', name: 'planner' },
          { agentId: 'agent-2', name: 'coder' },
          { agentId: 'agent-1', name: 'planner-2' },
        ],
      });
      const { getAllByTestId } = render(<NodeConfigPanel {...makeProps({ step, onUpdate })} />);
      fireEvent.click(getAllByTestId('remove-agent-button')[2]);
      const updatedStep = onUpdate.mock.calls[0][0];
      expect(updatedStep.agents).toHaveLength(2);
      expect(updatedStep.agentId).toBe('');
      expect(updatedStep.channels).toEqual(step.channels);
    });

    it('shows add-agent-select dropdown with all agents (same agent may be added multiple times)', () => {
      const step = makeStep({
        agentId: '',
        agents: [
          { agentId: 'agent-1', name: 'planner' },
          { agentId: 'agent-2', name: 'coder' },
        ],
      });
      const { getByTestId } = render(<NodeConfigPanel {...makeProps({ step })} />);
      const select = getByTestId('add-agent-select');
      expect(select.textContent).toContain('Coder');
    });

    it('does not auto-create channels when adding an agent (channels are managed at workflow level)', () => {
      const onUpdate = vi.fn();
      const step = makeStep({
        agentId: '',
        agents: [
          { agentId: 'agent-1', name: 'planner' },
          { agentId: 'agent-2', name: 'coder' },
        ],
      });
      const { getByTestId } = render(<NodeConfigPanel {...makeProps({ step, onUpdate })} />);
      fireEvent.change(getByTestId('add-agent-select'), { target: { value: 'agent-2' } });
      const updatedStep = onUpdate.mock.calls[onUpdate.mock.calls.length - 1][0];
      expect(updatedStep.agents).toHaveLength(3);
      expect(updatedStep.channels).toBeUndefined();
    });

    it('adding the same agent twice generates a unique slot role with numeric suffix', () => {
      const onUpdate = vi.fn();
      const step = makeStep({
        agentId: '',
        agents: [
          { agentId: 'agent-2', name: 'Coder' },
          { agentId: 'agent-1', name: 'Planner' },
        ],
      });
      const { getByTestId } = render(<NodeConfigPanel {...makeProps({ step, onUpdate })} />);
      fireEvent.change(getByTestId('add-agent-select'), { target: { value: 'agent-2' } });
      const updatedStep = onUpdate.mock.calls[onUpdate.mock.calls.length - 1][0];
      expect(updatedStep.agents).toHaveLength(3);
      expect(updatedStep.agents[0].name).toBe('Coder');
      expect(updatedStep.agents[2].name).toBe('Coder-2');
    });

    it('adding the same agent three times produces Coder, Coder-2, Coder-3', () => {
      const onUpdate = vi.fn();
      const step = makeStep({
        agentId: '',
        agents: [
          { agentId: 'agent-2', name: 'Coder' },
          { agentId: 'agent-2', name: 'Coder-2' },
        ],
      });
      const { getByTestId } = render(<NodeConfigPanel {...makeProps({ step, onUpdate })} />);
      fireEvent.change(getByTestId('add-agent-select'), { target: { value: 'agent-2' } });
      const updatedStep = onUpdate.mock.calls[onUpdate.mock.calls.length - 1][0];
      expect(updatedStep.agents).toHaveLength(3);
      expect(updatedStep.agents[2].name).toBe('Coder-3');
    });
  });

  describe('per-slot fields', () => {
    it('renders a role input for each agent slot in multi-agent mode', () => {
      const step = makeStep({
        agentId: '',
        agents: [
          { agentId: 'agent-1', name: 'planner' },
          { agentId: 'agent-2', name: 'coder' },
        ],
      });
      const { getAllByTestId } = render(<NodeConfigPanel {...makeProps({ step })} />);
      const roleInputs = getAllByTestId('agent-role-input');
      expect(roleInputs).toHaveLength(2);
      expect((roleInputs[0] as HTMLInputElement).value).toBe('planner');
      expect((roleInputs[1] as HTMLInputElement).value).toBe('coder');
    });

    it('editing role input calls onUpdate with updated role', () => {
      const onUpdate = vi.fn();
      const step = makeStep({
        agentId: '',
        agents: [
          { agentId: 'agent-1', name: 'planner' },
          { agentId: 'agent-2', name: 'coder' },
        ],
      });
      const { getAllByTestId } = render(<NodeConfigPanel {...makeProps({ step, onUpdate })} />);
      fireEvent.input(getAllByTestId('agent-role-input')[0], { target: { value: 'lead-planner' } });
      const updatedStep = onUpdate.mock.calls[onUpdate.mock.calls.length - 1][0];
      expect(updatedStep.agents[0].name).toBe('lead-planner');
    });

    it('does not show legacy override badge in multi-agent list', () => {
      const step = makeStep({
        agentId: '',
        agents: [
          {
            agentId: 'agent-1',
            name: 'planner',
            customPrompt: { value: 'Be strict.' },
          },
          { agentId: 'agent-2', name: 'coder' },
        ],
      });
      const { queryByTestId } = render(<NodeConfigPanel {...makeProps({ step })} />);
      expect(queryByTestId('override-badge')).toBeNull();
    });

    it('renders a per-slot model selector for each agent', () => {
      const step = makeStep({
        agentId: '',
        agents: [
          { agentId: 'agent-1', name: 'planner' },
          { agentId: 'agent-2', name: 'coder' },
        ],
      });
      const { getAllByTestId } = render(<NodeConfigPanel {...makeProps({ step })} />);
      expect(getAllByTestId('agent-slot-model-input')).toHaveLength(2);
    });

    it('editing agent selection calls onUpdate with updated agentId', () => {
      const step = makeStep({
        agentId: '',
        agents: [
          { agentId: 'agent-1', name: 'planner' },
          { agentId: 'agent-2', name: 'coder' },
        ],
      });
      const onUpdate = vi.fn();
      const { getAllByTestId } = render(<NodeConfigPanel {...makeProps({ step, onUpdate })} />);
      fireEvent.change(getAllByTestId('agent-slot-select')[0], { target: { value: 'agent-2' } });
      const updatedStep = onUpdate.mock.calls[onUpdate.mock.calls.length - 1][0];
      expect(updatedStep.agents[0].agentId).toBe('agent-2');
    });

    it('reset-context toggle writes resetContextPerTurn onto the targeted slot', () => {
      const step = makeStep({
        agentId: '',
        agents: [
          { agentId: 'agent-1', name: 'planner' },
          { agentId: 'agent-2', name: 'coder' },
        ],
      });
      const onUpdate = vi.fn();
      const { getAllByTestId } = render(<NodeConfigPanel {...makeProps({ step, onUpdate })} />);
      const toggles = getAllByTestId('agent-slot-reset-context-toggle');
      expect(toggles).toHaveLength(2);
      expect((toggles[0] as HTMLInputElement).checked).toBe(false);
      fireEvent.click(toggles[0]);
      const updatedStep = onUpdate.mock.calls[onUpdate.mock.calls.length - 1][0];
      expect(updatedStep.agents[0].resetContextPerTurn).toBe(true);
      expect(updatedStep.agents[1].resetContextPerTurn).toBeUndefined();
    });

    it('reset-context toggle reflects an existing slot flag and clears it on uncheck', () => {
      const step = makeStep({
        agentId: '',
        agents: [
          { agentId: 'agent-1', name: 'planner', resetContextPerTurn: true },
          { agentId: 'agent-2', name: 'coder' },
        ],
      });
      const onUpdate = vi.fn();
      const { getAllByTestId } = render(<NodeConfigPanel {...makeProps({ step, onUpdate })} />);
      const toggles = getAllByTestId('agent-slot-reset-context-toggle');
      expect((toggles[0] as HTMLInputElement).checked).toBe(true);
      expect((toggles[1] as HTMLInputElement).checked).toBe(false);
      fireEvent.click(toggles[0]);
      const updatedStep = onUpdate.mock.calls[onUpdate.mock.calls.length - 1][0];
      expect(updatedStep.agents[0].resetContextPerTurn).toBeUndefined();
    });

    it('reset-context toggle writes the flag for a single-agent node', () => {
      const onUpdate = vi.fn();
      const { getByTestId } = render(
        <NodeConfigPanel {...makeProps({ step: makeStep({ agentId: 'agent-1' }), onUpdate })} />
      );
      const toggle = getByTestId('agent-slot-reset-context-toggle') as HTMLInputElement;
      expect(toggle.checked).toBe(false);
      fireEvent.click(toggle);
      const updatedStep = onUpdate.mock.calls[onUpdate.mock.calls.length - 1][0];
      expect(updatedStep.resetContextPerTurn).toBe(true);
    });

    it('opens slot prompts editor from multi-agent list', () => {
      const step = makeStep({
        agentId: '',
        agents: [
          { agentId: 'agent-1', name: 'planner' },
          { agentId: 'agent-2', name: 'coder' },
        ],
      });
      const { getAllByTestId, getByTestId } = render(<NodeConfigPanel {...makeProps({ step })} />);
      fireEvent.click(getAllByTestId('edit-slot-prompts-button')[0]);
      expect(getByTestId('slot-prompts-system-prompt')).toBeTruthy();
      expect(getByTestId('slot-prompts-model-input')).toBeTruthy();
    });

    it('adding same agent twice with different roles: both slots shown', () => {
      const step = makeStep({
        agentId: '',
        agents: [
          { agentId: 'agent-2', name: 'coder' },
          { agentId: 'agent-2', name: 'coder-2' },
        ],
      });
      const { getAllByTestId } = render(<NodeConfigPanel {...makeProps({ step })} />);
      const roleInputs = getAllByTestId('agent-role-input') as HTMLInputElement[];
      expect(roleInputs).toHaveLength(2);
      expect(roleInputs[0].value).toBe('coder');
      expect(roleInputs[1].value).toBe('coder-2');
    });

    it('slot prompt updates only affect the targeted slot', async () => {
      const onUpdate = vi.fn();
      const step = makeStep({
        agentId: '',
        agents: [
          {
            agentId: 'agent-2',
            name: 'coder',
            customPrompt: { value: 'Code carefully.' },
          },
          { agentId: 'agent-1', name: 'planner' },
        ],
      });
      const { getAllByTestId, getByTestId } = render(
        <NodeConfigPanel {...makeProps({ step, onUpdate })} />
      );
      fireEvent.click(getAllByTestId('edit-slot-prompts-button')[0]);

      await act(async () => {
        fireEvent.input(getByTestId('slot-prompts-system-prompt'), {
          target: { value: 'Be extra strict.' },
        });
      });

      const updatedStep = onUpdate.mock.calls[onUpdate.mock.calls.length - 1][0];
      expect(updatedStep.agents[0].customPrompt).toEqual({
        value: 'Be extra strict.',
      });
      expect(updatedStep.agents[1].customPrompt).toBeUndefined();
    });

    it('slot prompts editor stays addressable after a slot role rename', async () => {
      function Wrapper() {
        const [step, setStep] = useState(
          makeStep({
            agentId: '',
            agents: [
              { agentId: 'agent-1', name: 'planner' },
              { agentId: 'agent-2', name: 'coder' },
            ],
          })
        );
        return <NodeConfigPanel {...makeProps({ step, onUpdate: setStep })} />;
      }
      const { getAllByTestId, getByTestId, queryByTestId } = render(<Wrapper />);

      await act(async () => {
        fireEvent.input(getAllByTestId('agent-role-input')[0], {
          target: { value: 'lead-planner' },
        });
      });

      fireEvent.click(getAllByTestId('edit-slot-prompts-button')[0]);
      expect(queryByTestId('slot-prompts-system-prompt')).toBeTruthy();
      fireEvent.click(getByTestId('node-panel-back-button'));
      expect(queryByTestId('slot-prompts-system-prompt')).toBeNull();
    });
  });

  describe('prompt mode toggle', () => {
    function renderControlled(initialStep: NodeDraft) {
      const updates: NodeDraft[] = [];
      function Wrapper() {
        const [step, setStep] = useState(initialStep);
        return (
          <NodeConfigPanel
            {...makeProps({
              step,
              onUpdate: (next) => {
                updates.push(next);
                setStep(next);
              },
            })}
          />
        );
      }
      return { ...render(<Wrapper />), updates };
    }

    const multiAgentStep = (): NodeDraft =>
      makeStep({
        agentId: '',
        agents: [
          { agentId: 'agent-1', name: 'planner' },
          { agentId: 'agent-2', name: 'coder' },
        ],
      });

    const withReplace = (step: NodeDraft): NodeDraft => {
      step.agents![0].replaceAgentPrompt = true;
      return step;
    };

    it('defaults to append (no replace warning) in the slot prompts view', () => {
      const { getAllByTestId, queryByTestId } = render(
        <NodeConfigPanel {...makeProps({ step: multiAgentStep() })} />
      );
      fireEvent.click(getAllByTestId('edit-slot-prompts-button')[0]);
      expect(queryByTestId('prompt-mode-toggle')).toBeTruthy();
      expect(queryByTestId('replace-prompt-warning')).toBeNull();
    });

    it('reflects an existing replaceAgentPrompt=true slot in replace state', () => {
      const { getAllByTestId, getByTestId } = render(
        <NodeConfigPanel {...makeProps({ step: withReplace(multiAgentStep()) })} />
      );
      fireEvent.click(getAllByTestId('edit-slot-prompts-button')[0]);
      expect(getByTestId('replace-prompt-warning')).toBeTruthy();
      const replaceBtn = getByTestId('prompt-mode-replace') as HTMLButtonElement;
      expect(replaceBtn.className).toContain('bg-amber-600');
    });

    it('clicking replace persists replaceAgentPrompt on the targeted slot only', () => {
      const onUpdate = vi.fn();
      const { getAllByTestId, getByTestId } = render(
        <NodeConfigPanel {...makeProps({ step: multiAgentStep(), onUpdate })} />
      );
      fireEvent.click(getAllByTestId('edit-slot-prompts-button')[0]);
      fireEvent.click(getByTestId('prompt-mode-replace'));

      const updatedStep = onUpdate.mock.calls[onUpdate.mock.calls.length - 1][0];
      expect(updatedStep.agents[0].replaceAgentPrompt).toBe(true);
      expect(updatedStep.agents[1].replaceAgentPrompt).toBeUndefined();
    });

    it('clicking append clears replaceAgentPrompt on the slot', () => {
      const onUpdate = vi.fn();
      const { getAllByTestId, getByTestId } = render(
        <NodeConfigPanel {...makeProps({ step: withReplace(multiAgentStep()), onUpdate })} />
      );
      fireEvent.click(getAllByTestId('edit-slot-prompts-button')[0]);
      fireEvent.click(getByTestId('prompt-mode-append'));

      const updatedStep = onUpdate.mock.calls[onUpdate.mock.calls.length - 1][0];
      expect(updatedStep.agents[0].replaceAgentPrompt).toBeUndefined();
    });

    it('renders the replace warning after switching a slot to replace', () => {
      const { getAllByTestId, getByTestId } = renderControlled(multiAgentStep());
      fireEvent.click(getAllByTestId('edit-slot-prompts-button')[0]);
      fireEvent.click(getByTestId('prompt-mode-replace'));
      fireEvent.click(getAllByTestId('edit-slot-prompts-button')[0]);
      expect(getByTestId('replace-prompt-warning')).toBeTruthy();
    });

    it('persists replaceAgentPrompt on the single-agent shorthand step', () => {
      const onUpdate = vi.fn();
      const { getByTestId } = render(<NodeConfigPanel {...makeProps({ onUpdate })} />);
      fireEvent.click(getByTestId('edit-single-prompts-button'));
      fireEvent.click(getByTestId('prompt-mode-replace'));

      const updatedStep = onUpdate.mock.calls[onUpdate.mock.calls.length - 1][0];
      expect(updatedStep.replaceAgentPrompt).toBe(true);
    });

    it('clears the shorthand flag when a skill toggle materializes a slot, so Append then shows Append', () => {
      const skill: AppSkill = {
        id: 'skill-1',
        name: 's1',
        displayName: 'Skill One',
        description: '',
        sourceType: 'builtin',
        config: { type: 'builtin', commandName: 's1' },
        enabled: true,
        builtIn: true,
        validationStatus: 'unknown',
        createdAt: 0,
      };
      skillsStore.skills.value = [skill];
      const handleUpdate = vi.fn();
      try {
        function Wrapper() {
          const [step, setStep] = useState(
            makeStep({ agentId: 'agent-1', replaceAgentPrompt: true })
          );
          return (
            <NodeConfigPanel
              {...makeProps({
                step,
                onUpdate: (next) => {
                  handleUpdate(next);
                  setStep(next);
                },
              })}
            />
          );
        }
        const { container, getByTestId, queryByTestId } = render(<Wrapper />);

        fireEvent.click(container.querySelector('input[type="checkbox"]')!);
        const materialized = handleUpdate.mock.calls[handleUpdate.mock.calls.length - 1][0];
        expect(materialized.agents[0].replaceAgentPrompt).toBe(true);
        expect(materialized.replaceAgentPrompt).toBeUndefined();

        fireEvent.click(getByTestId('edit-single-prompts-button'));
        fireEvent.click(getByTestId('prompt-mode-append'));
        fireEvent.click(getByTestId('edit-single-prompts-button'));
        expect(queryByTestId('replace-prompt-warning')).toBeNull();
        expect((getByTestId('prompt-mode-append') as HTMLButtonElement).className).toContain(
          'bg-blue-600'
        );
      } finally {
        skillsStore.skills.value = [];
      }
    });
  });

  describe('hooks section', () => {
    it('adds a backend-valid script hook with an authorized caller for the node', () => {
      const onUpdateNodeHooks = vi.fn();
      const { getByTestId } = render(
        <NodeConfigPanel
          {...makeProps({
            nodeHooks: [],
            workflowNodeNames: ['My Step', 'Review'],
            onUpdateNodeHooks,
          })}
        />
      );

      fireEvent.click(getByTestId('add-hook-button'));

      expect(onUpdateNodeHooks).toHaveBeenCalledWith([
        expect.objectContaining({
          sourceNode: 'My Step',
          validator: expect.objectContaining({ kind: 'script', source: `echo '{"type":"allow"}'` }),
          authorizedCallers: [expect.objectContaining({ sourceNode: 'My Step' })],
        }),
      ]);
    });

    it('uses the node localId when adding a hook to an unnamed node', () => {
      const onUpdateNodeHooks = vi.fn();
      const { getByTestId } = render(
        <NodeConfigPanel
          {...makeProps({
            step: makeStep({ name: '', localId: 'local-unnamed' }),
            nodeHooks: [],
            workflowNodeNames: ['local-unnamed', 'Review'],
            onUpdateNodeHooks,
          })}
        />
      );

      fireEvent.click(getByTestId('add-hook-button'));

      expect(onUpdateNodeHooks).toHaveBeenCalledWith([
        expect.objectContaining({
          sourceNode: 'local-unnamed',
          authorizedCallers: [expect.objectContaining({ sourceNode: 'local-unnamed' })],
        }),
      ]);
    });

    it('updates existing hook configs from the embedded hook editor', () => {
      const onUpdateNodeHooks = vi.fn();
      const hook: WorkflowHook = {
        id: 'hook-1',
        enabled: true,
        sourceNode: 'My Step',
        method: 'send_message',
        validator: { kind: 'script', interpreter: 'bash', source: `echo '{"type":"allow"}'` },
        authorizedCallers: [{ sourceNode: 'My Step' }],
      };
      const { getByTestId } = render(
        <NodeConfigPanel
          {...makeProps({
            nodeHooks: [hook],
            workflowNodeNames: ['My Step', 'Review'],
            onUpdateNodeHooks,
          })}
        />
      );

      fireEvent.click(getByTestId('node-hook-button'));
      fireEvent.input(getByTestId('hook-editor-label'), { target: { value: 'Approval hook' } });

      expect(onUpdateNodeHooks).toHaveBeenCalledWith([
        expect.objectContaining({ id: 'hook-1', label: 'Approval hook' }),
      ]);
    });
  });

  describe('single-agent prompts slide', () => {
    it('opens single prompts view from the main panel', () => {
      const { getByTestId } = render(<NodeConfigPanel {...makeProps()} />);
      fireEvent.click(getByTestId('edit-single-prompts-button'));
      expect(getByTestId('single-prompts-system-prompt')).toBeTruthy();
    });

    it('custom prompt textarea calls onUpdate with customPrompt override', async () => {
      const onUpdate = vi.fn();
      const { getByTestId } = render(<NodeConfigPanel {...makeProps({ onUpdate })} />);
      fireEvent.click(getByTestId('edit-single-prompts-button'));

      await act(async () => {
        fireEvent.input(getByTestId('single-prompts-system-prompt'), {
          target: { value: 'Extra context.' },
        });
      });

      expect(onUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          customPrompt: { value: 'Extra context.' },
        })
      );
    });
  });

  describe('multi-agent slot prompts', () => {
    it('shows per-slot custom prompt field in slot prompts panel', () => {
      const step = makeStep({
        agentId: '',
        agents: [
          { agentId: 'agent-1', name: 'coder' },
          { agentId: 'agent-2', name: 'reviewer' },
        ],
      });
      const { getAllByTestId, getByTestId } = render(<NodeConfigPanel {...makeProps({ step })} />);
      fireEvent.click(getAllByTestId('edit-slot-prompts-button')[0]);
      expect(getByTestId('slot-prompts-system-prompt')).toBeTruthy();
    });

    it('typing in slot custom prompt calls onUpdate with customPrompt override', async () => {
      const onUpdate = vi.fn();
      const step = makeStep({
        agentId: '',
        agents: [
          {
            agentId: 'agent-1',
            name: 'coder',
            customPrompt: { value: 'Seed prompt.' },
          },
          { agentId: 'agent-2', name: 'reviewer' },
        ],
      });
      const { getAllByTestId, getByTestId } = render(
        <NodeConfigPanel {...makeProps({ step, onUpdate })} />
      );

      fireEvent.click(getAllByTestId('edit-slot-prompts-button')[0]);

      await act(async () => {
        fireEvent.input(getByTestId('slot-prompts-system-prompt'), {
          target: { value: 'Extra prompt.' },
        });
      });

      expect(onUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          agents: [
            expect.objectContaining({
              customPrompt: { value: 'Extra prompt.' },
            }),
            expect.anything(),
          ],
        })
      );
    });
  });
});
