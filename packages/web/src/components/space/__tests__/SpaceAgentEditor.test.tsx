// @ts-nocheck

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, waitFor, cleanup } from '@testing-library/preact';
import { KNOWN_TOOLS } from '@hyperneo/shared';
import type { SpaceWorkerAgent } from '@hyperneo/shared';

const mockCreateAgent = vi.fn();
const mockUpdateAgent = vi.fn();
let mockAgentTemplates: Array<{
  name: string;
  description: string;
  tools: string[];
  customPrompt: string;
}>;

vi.mock('../../../lib/space-store', () => ({
  get spaceStore() {
    return {
      createAgent: mockCreateAgent,
      updateAgent: mockUpdateAgent,
      agentTemplates: { value: mockAgentTemplates },
    };
  },
}));

vi.mock('../../../lib/utils', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
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
      <div role="dialog" aria-label={title}>
        <button onClick={onClose} aria-label="Close modal">
          X
        </button>
        {children}
      </div>
    );
  },
}));

vi.mock('../../ui/Button', () => ({
  Button: ({
    children,
    onClick,
    type,
    loading,
    disabled,
  }: {
    children: unknown;
    onClick?: () => void;
    type?: string;
    loading?: boolean;
    disabled?: boolean;
  }) => (
    <button type={type ?? 'button'} onClick={onClick} disabled={disabled || loading}>
      {loading ? 'Loading...' : children}
    </button>
  ),
}));

vi.mock('../visual-editor/WorkflowModelSelect', () => ({
  WorkflowModelSelect: ({
    value,
    onChange,
    testId,
    className,
  }: {
    value?: string;
    onChange: (
      value: string | undefined,
      selection?: { provider: string; modelId: string }
    ) => void;
    testId: string;
    className?: string;
  }) => (
    <select
      data-testid={testId}
      value={value ?? ''}
      onChange={(e) => {
        const value = (e.target as HTMLSelectElement).value || undefined;
        onChange(value, value ? { provider: 'anthropic', modelId: value } : undefined);
      }}
      class={className}
    >
      <option value="">— No override —</option>
      <option value="claude-sonnet-4-6">Claude Sonnet 4.6</option>
      <option value="claude-haiku-4-5">Claude Haiku 4.5</option>
      <option value="gpt-5.4">GPT-5.4</option>
    </select>
  ),
}));

import { SpaceAgentEditor } from '../SpaceAgentEditor';

const DEFAULT_PROPS = {
  agent: null,
  existingAgentNames: [],
  onSave: vi.fn(),
  onCancel: vi.fn(),
};

function makeAgent(overrides: Partial<SpaceWorkerAgent> = {}): SpaceWorkerAgent {
  return {
    id: 'agent-1',
    spaceId: 'space-1',
    name: 'My Coder',
    description: 'A test agent',
    model: 'claude-sonnet-4-6',
    customPrompt: 'Be helpful.',
    tools: ['Read', 'Write', 'Edit', 'Bash'],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

function fillName(getByPlaceholderText: (text: string) => HTMLElement, value: string) {
  const input = getByPlaceholderText('e.g., Senior Coder') as HTMLInputElement;
  fireEvent.input(input, { target: { value } });
}

function fillModel(getByTestId: (id: string) => HTMLElement, value: string) {
  const select = getByTestId('space-agent-model-select') as HTMLSelectElement;
  fireEvent.change(select, { target: { value } });
}

describe('SpaceAgentEditor', () => {
  beforeEach(() => {
    cleanup();
    mockCreateAgent.mockReset();
    mockUpdateAgent.mockReset();
    mockAgentTemplates = [];
    DEFAULT_PROPS.onSave.mockClear();
    DEFAULT_PROPS.onCancel.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders with "Create Agent" title in create mode', () => {
    const { getByRole } = render(<SpaceAgentEditor {...DEFAULT_PROPS} />);
    expect(getByRole('dialog', { name: 'Create Agent' })).toBeTruthy();
  });

  it('renders with edit title in edit mode', () => {
    const agent = makeAgent({ name: 'My Coder' });
    const { getByRole } = render(<SpaceAgentEditor {...DEFAULT_PROPS} agent={agent} />);
    expect(getByRole('dialog', { name: 'Edit Agent: My Coder' })).toBeTruthy();
  });

  it('pre-fills name field in edit mode', () => {
    const agent = makeAgent({ name: 'Speedy Agent' });
    const { getByPlaceholderText } = render(<SpaceAgentEditor {...DEFAULT_PROPS} agent={agent} />);
    const nameInput = getByPlaceholderText('e.g., Senior Coder') as HTMLInputElement;
    expect(nameInput.value).toBe('Speedy Agent');
  });

  it('pre-fills model field in edit mode', () => {
    const agent = makeAgent({ model: 'claude-haiku-4-5' });
    const { getByTestId } = render(<SpaceAgentEditor {...DEFAULT_PROPS} agent={agent} />);
    const modelSelect = getByTestId('space-agent-model-select') as HTMLSelectElement;
    expect(modelSelect.value).toBe('claude-haiku-4-5');
  });

  it('pre-fills description in edit mode', () => {
    const agent = makeAgent({ description: 'A frontend specialist' });
    const { getByPlaceholderText } = render(<SpaceAgentEditor {...DEFAULT_PROPS} agent={agent} />);
    const descInput = getByPlaceholderText(
      "Briefly describe this agent's specialization..."
    ) as HTMLInputElement;
    expect(descInput.value).toBe('A frontend specialist');
  });

  it('pre-fills system prompt in edit mode', () => {
    const agent = makeAgent({ customPrompt: 'Always be brief.' });
    const { container } = render(<SpaceAgentEditor {...DEFAULT_PROPS} agent={agent} />);
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    expect(textarea.value).toBe('Always be brief.');
  });

  it('shows name required error when submitting with empty name', async () => {
    const { getByRole, findByText } = render(<SpaceAgentEditor {...DEFAULT_PROPS} />);
    const form = getByRole('dialog').querySelector('form');
    fireEvent.submit(form!);
    expect(await findByText('Name is required')).toBeTruthy();
  });

  it('shows name uniqueness error when name conflicts with existing agent', async () => {
    const { getByPlaceholderText, getByRole, findByText } = render(
      <SpaceAgentEditor {...DEFAULT_PROPS} existingAgentNames={['Existing Agent']} />
    );
    fillName(getByPlaceholderText, 'Existing Agent');
    const form = getByRole('dialog').querySelector('form');
    fireEvent.submit(form!);
    expect(await findByText('An agent with this name already exists')).toBeTruthy();
  });

  it('name uniqueness check is case-insensitive', async () => {
    const { getByPlaceholderText, getByRole, findByText } = render(
      <SpaceAgentEditor {...DEFAULT_PROPS} existingAgentNames={['existing agent']} />
    );
    fillName(getByPlaceholderText, 'EXISTING AGENT');
    const form = getByRole('dialog').querySelector('form');
    fireEvent.submit(form!);
    expect(await findByText('An agent with this name already exists')).toBeTruthy();
  });

  it('allows submitting with an empty model to inherit the default', async () => {
    const { getByPlaceholderText, getByRole } = render(<SpaceAgentEditor {...DEFAULT_PROPS} />);
    fillName(getByPlaceholderText, 'My Agent');
    const form = getByRole('dialog').querySelector('form');
    fireEvent.submit(form!);
    await waitFor(() =>
      expect(mockCreateAgent).toHaveBeenCalledWith(expect.objectContaining({ name: 'My Agent' }))
    );
    expect(mockCreateAgent.mock.calls[0][0]).not.toHaveProperty('model');
  });

  it('allows saving with no explicit tool overrides (inherit all)', async () => {
    const { getByPlaceholderText, getByRole } = render(<SpaceAgentEditor {...DEFAULT_PROPS} />);
    fillName(getByPlaceholderText, 'My Agent');

    const form = getByRole('dialog').querySelector('form');
    fireEvent.submit(form!);

    await waitFor(() => expect(mockCreateAgent).toHaveBeenCalled());
    expect(mockCreateAgent.mock.calls[0][0]).toHaveProperty('tools', []);
  });

  it('renders all KNOWN_TOOLS as checkboxes', () => {
    const { getByText } = render(<SpaceAgentEditor {...DEFAULT_PROPS} />);
    for (const tool of KNOWN_TOOLS) {
      expect(getByText(tool)).toBeTruthy();
    }
  });

  it('renders built-in template options from spaceStore', () => {
    mockAgentTemplates = [
      {
        name: 'Coder',
        description: 'Implementation worker',
        tools: ['Read', 'Write', 'Edit', 'Bash'],
        customPrompt: 'You are a coder.',
      },
      {
        name: 'Reviewer',
        description: 'Review specialist',
        tools: ['Read', 'Bash', 'Grep', 'Glob'],
        customPrompt: 'You are a reviewer.',
      },
    ];

    const { getByLabelText } = render(<SpaceAgentEditor {...DEFAULT_PROPS} />);
    const select = getByLabelText('From Template') as HTMLSelectElement;

    expect(select).toBeTruthy();
    const values = Array.from(select.options).map((option) => option.value);
    expect(values).toContain('Coder');
    expect(values).toContain('Reviewer');
  });

  it('applies selected template fields in create mode', () => {
    mockAgentTemplates = [
      {
        name: 'Research',
        description: 'Research specialist',
        tools: ['Read', 'Bash', 'Grep', 'Glob', 'WebFetch', 'WebSearch'],
        customPrompt: 'You are a research specialist.',
        templateHash: 'research-hash',
      },
    ];

    const { getByLabelText, getByPlaceholderText, container } = render(
      <SpaceAgentEditor {...DEFAULT_PROPS} />
    );

    const select = getByLabelText('From Template') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'Research' } });

    const nameInput = getByPlaceholderText('e.g., Senior Coder') as HTMLInputElement;
    const descInput = getByPlaceholderText(
      "Briefly describe this agent's specialization..."
    ) as HTMLInputElement;
    const promptTextarea = container.querySelector('textarea') as HTMLTextAreaElement;

    expect(nameInput.value).toBe('Research');
    expect(descInput.value).toBe('Research specialist');
    expect(promptTextarea.value).toBe('You are a research specialist.');

    const checkedTools = Array.from(container.querySelectorAll('input[type="checkbox"]'))
      .filter((cb) => (cb as HTMLInputElement).checked)
      .map((cb) => (cb as HTMLInputElement).closest('label')?.textContent?.trim() ?? '');
    expect(checkedTools).toContain('Read');
    expect(checkedTools).toContain('WebSearch');
    expect(checkedTools).not.toContain('Write');
  });

  it('applies selected template in edit mode without replacing existing name', () => {
    mockAgentTemplates = [
      {
        name: 'Reviewer',
        description: 'Code review specialist',
        tools: ['Read', 'Bash', 'Grep', 'Glob', 'WebFetch', 'WebSearch'],
        customPrompt: 'You are an expert code reviewer.',
      },
    ];
    const agent = makeAgent({ name: 'Custom Agent', description: 'Existing description' });
    const { getByLabelText, getByPlaceholderText, container } = render(
      <SpaceAgentEditor {...DEFAULT_PROPS} agent={agent} />
    );

    const select = getByLabelText('From Template') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'Reviewer' } });

    const nameInput = getByPlaceholderText('e.g., Senior Coder') as HTMLInputElement;
    const descInput = getByPlaceholderText(
      "Briefly describe this agent's specialization..."
    ) as HTMLInputElement;
    const promptTextarea = container.querySelector('textarea') as HTMLTextAreaElement;

    expect(nameInput.value).toBe('Custom Agent');
    expect(descInput.value).toBe('Code review specialist');
    expect(promptTextarea.value).toBe('You are an expert code reviewer.');
  });

  it('clears explicit overrides via "Inherit defaults" (all tools inherited)', () => {
    const { getByText, container } = render(<SpaceAgentEditor {...DEFAULT_PROPS} />);
    fireEvent.click(getByText('Read Only'));
    fireEvent.click(getByText('Inherit defaults'));

    const checkboxes = Array.from(
      container.querySelectorAll('.grid.grid-cols-3 input[type="checkbox"]')
    ) as HTMLInputElement[];
    expect(checkboxes.length).toBeGreaterThan(0);
    for (const cb of checkboxes) {
      expect(cb.checked).toBe(true);
      expect(cb.disabled).toBe(true);
    }
    expect(getByText('SDK defaults are always inherited.')).toBeTruthy();
  });

  it('enters override mode from inherited when "Custom" is clicked', () => {
    const { getByText, container } = render(<SpaceAgentEditor {...DEFAULT_PROPS} />);

    fireEvent.click(getByText('Custom'));

    const checkboxes = Array.from(
      container.querySelectorAll('.grid.grid-cols-3 input[type="checkbox"]')
    ) as HTMLInputElement[];
    expect(checkboxes.length).toBeGreaterThan(0);
    for (const cb of checkboxes) {
      expect(cb.disabled).toBe(false);
      expect(cb.checked).toBe(true);
    }
  });

  it('applies "Read Only" preset and selects only Read, Grep, Glob', () => {
    const { getByText, container } = render(<SpaceAgentEditor {...DEFAULT_PROPS} />);
    fireEvent.click(getByText('Read Only'));

    const toolCheckboxes = Array.from(
      container.querySelectorAll('.grid.grid-cols-3 input[type="checkbox"]')
    );
    const checkedTools = toolCheckboxes
      .filter((cb) => (cb as HTMLInputElement).checked)
      .map((cb) => {
        const label = (cb as HTMLInputElement).closest('label');
        return label?.textContent?.trim() ?? '';
      });

    expect(checkedTools).toContain('Read');
    expect(checkedTools).toContain('Grep');
    expect(checkedTools).toContain('Glob');
    expect(checkedTools).not.toContain('Write');
    expect(checkedTools).not.toContain('Edit');
    expect(checkedTools).not.toContain('Bash');
  });

  it('switches active preset indicator to "Custom" when a tool is toggled manually', () => {
    const { getByText, container } = render(<SpaceAgentEditor {...DEFAULT_PROPS} />);

    fireEvent.click(getByText('Read Only'));
    const writeCb = Array.from(
      container.querySelectorAll('.grid.grid-cols-3 input[type="checkbox"]')
    ).find((cb) => {
      const label = (cb as HTMLInputElement).closest('label');
      return label?.textContent?.includes('Write');
    });
    if (writeCb) fireEvent.click(writeCb.closest('label')!);

    const customButton = getByText('Custom');
    expect(customButton.className).toContain('blue');
  });

  it('switches active preset indicator to "Inherited" when the last tool is unchecked', () => {
    const { getByText, container } = render(<SpaceAgentEditor {...DEFAULT_PROPS} />);

    fireEvent.click(getByText('Read Only'));
    for (const toolName of ['Read', 'Grep', 'Glob']) {
      const cb = Array.from(
        container.querySelectorAll('.grid.grid-cols-3 input[type="checkbox"]')
      ).find((input) => {
        const label = (input as HTMLInputElement).closest('label');
        return label?.textContent?.includes(toolName);
      });
      if (cb) fireEvent.click(cb.closest('label')!);
    }

    const inheritButton = getByText('Inherit defaults');
    expect(inheritButton.className).toContain('blue');
  });

  it('shows all tools as checked and disabled in inherited mode', () => {
    const { container } = render(<SpaceAgentEditor {...DEFAULT_PROPS} />);

    const checkboxes = Array.from(
      container.querySelectorAll('.grid.grid-cols-3 input[type="checkbox"]')
    ) as HTMLInputElement[];
    expect(checkboxes.length).toBeGreaterThan(0);
    for (const cb of checkboxes) {
      expect(cb.checked).toBe(true);
      expect(cb.disabled).toBe(true);
    }
  });

  it('uses direct system prompt edits without template buttons', () => {
    const { container, queryByText } = render(<SpaceAgentEditor {...DEFAULT_PROPS} />);
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;

    fireEvent.input(textarea, { target: { value: 'Exact prompt text' } });

    expect(textarea.value).toBe('Exact prompt text');
    expect(queryByText('Custom (blank)')).toBeNull();
    expect(queryByText('Research')).toBeNull();
  });

  it('calls spaceStore.createAgent with correct params in create mode', async () => {
    mockCreateAgent.mockResolvedValue({ id: 'new-agent', name: 'Fresh Agent' });

    const { getByPlaceholderText, getByTestId, getByRole } = render(
      <SpaceAgentEditor {...DEFAULT_PROPS} />
    );

    fillName(getByPlaceholderText, 'Fresh Agent');
    fillModel(getByTestId, 'claude-sonnet-4-6');

    const form = getByRole('dialog').querySelector('form');
    fireEvent.submit(form!);

    await waitFor(() => {
      expect(mockCreateAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Fresh Agent',
          model: 'claude-sonnet-4-6',
          tools: expect.any(Array),
        })
      );
    });
  });

  it('calls spaceStore.updateAgent in edit mode', async () => {
    const agent = makeAgent({ id: 'agent-1', name: 'My Coder', model: 'claude-haiku-4-5' });
    mockUpdateAgent.mockResolvedValue(agent);

    const { getByPlaceholderText, getByRole } = render(
      <SpaceAgentEditor {...DEFAULT_PROPS} agent={agent} />
    );

    const nameInput = getByPlaceholderText('e.g., Senior Coder') as HTMLInputElement;
    fireEvent.input(nameInput, { target: { value: 'Updated Coder' } });

    const form = getByRole('dialog').querySelector('form');
    fireEvent.submit(form!);

    await waitFor(() => {
      expect(mockUpdateAgent).toHaveBeenCalledWith(
        'agent-1',
        expect.objectContaining({ name: 'Updated Coder' })
      );
    });
  });

  it('sends nulls when clearing model and description overrides in edit mode', async () => {
    const agent = makeAgent({
      id: 'agent-1',
      description: 'Old description',
      model: 'claude-haiku-4-5',
      provider: 'anthropic',
    });
    mockUpdateAgent.mockResolvedValue(agent);

    const { getByPlaceholderText, getByTestId, getByRole } = render(
      <SpaceAgentEditor {...DEFAULT_PROPS} agent={agent} />
    );

    fireEvent.input(getByPlaceholderText("Briefly describe this agent's specialization..."), {
      target: { value: '' },
    });
    fireEvent.change(getByTestId('space-agent-model-select'), { target: { value: '' } });
    fireEvent.submit(getByRole('dialog').querySelector('form')!);

    await waitFor(() => {
      expect(mockUpdateAgent).toHaveBeenCalledWith(
        'agent-1',
        expect.objectContaining({ description: null, model: null, provider: null })
      );
    });
  });

  it('persists template metadata when creating from an unchanged built-in template', async () => {
    mockAgentTemplates = [
      {
        name: 'Research',
        description: 'Research specialist',
        tools: ['Read', 'Grep'],
        customPrompt: 'You are a research specialist.',
        templateHash: 'research-hash',
      },
    ];
    mockCreateAgent.mockResolvedValue({ id: 'new-agent' });

    const { getByLabelText, getByRole } = render(<SpaceAgentEditor {...DEFAULT_PROPS} />);

    fireEvent.change(getByLabelText('From Template'), { target: { value: 'Research' } });
    fireEvent.submit(getByRole('dialog').querySelector('form')!);

    await waitFor(() => {
      expect(mockCreateAgent).toHaveBeenCalledWith(
        expect.objectContaining({ templateName: 'Research', templateHash: 'research-hash' })
      );
    });
  });

  it('omits template metadata when template fields are customized before create', async () => {
    mockAgentTemplates = [
      {
        name: 'Research',
        description: 'Research specialist',
        tools: ['Read', 'Grep'],
        customPrompt: 'You are a research specialist.',
        templateHash: 'research-hash',
      },
    ];
    mockCreateAgent.mockResolvedValue({ id: 'new-agent' });

    const { getByLabelText, getByPlaceholderText, getByRole } = render(
      <SpaceAgentEditor {...DEFAULT_PROPS} />
    );

    fireEvent.change(getByLabelText('From Template'), { target: { value: 'Research' } });
    fireEvent.input(getByPlaceholderText("Briefly describe this agent's specialization..."), {
      target: { value: 'Custom research specialist' },
    });
    fireEvent.submit(getByRole('dialog').querySelector('form')!);

    await waitFor(() => expect(mockCreateAgent).toHaveBeenCalled());
    expect(mockCreateAgent.mock.calls[0][0]).not.toHaveProperty('templateName');
    expect(mockCreateAgent.mock.calls[0][0]).not.toHaveProperty('templateHash');
  });

  it('persists provider with model overrides', async () => {
    mockCreateAgent.mockResolvedValue({ id: 'new-agent' });

    const { getByPlaceholderText, getByTestId, getByRole } = render(
      <SpaceAgentEditor {...DEFAULT_PROPS} />
    );

    fillName(getByPlaceholderText, 'Provider Agent');
    fillModel(getByTestId, 'claude-sonnet-4-6');
    fireEvent.submit(getByRole('dialog').querySelector('form')!);

    await waitFor(() => {
      expect(mockCreateAgent).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'claude-sonnet-4-6', provider: 'anthropic' })
      );
    });
  });

  it('preserves inherited tools for edits until tools are customized', async () => {
    const agent = makeAgent({ id: 'agent-1', tools: undefined });
    mockUpdateAgent.mockResolvedValue(agent);

    const { getByPlaceholderText, getByRole } = render(
      <SpaceAgentEditor {...DEFAULT_PROPS} agent={agent} />
    );

    fireEvent.input(getByPlaceholderText('e.g., Senior Coder'), { target: { value: 'Renamed' } });
    fireEvent.submit(getByRole('dialog').querySelector('form')!);

    await waitFor(() => expect(mockUpdateAgent).toHaveBeenCalled());
    expect(mockUpdateAgent.mock.calls[0][1]).not.toHaveProperty('tools');
  });

  it('clears explicit tool overrides and template tracking when inheriting defaults in edit mode', async () => {
    const agent = makeAgent({
      id: 'agent-1',
      tools: ['Read', 'Grep'],
      templateName: 'Research',
      templateHash: 'research-hash',
    });
    mockUpdateAgent.mockResolvedValue(agent);

    const { getByText, getByRole } = render(<SpaceAgentEditor {...DEFAULT_PROPS} agent={agent} />);

    fireEvent.click(getByText('Inherit defaults'));
    fireEvent.submit(getByRole('dialog').querySelector('form')!);

    await waitFor(() => {
      expect(mockUpdateAgent).toHaveBeenCalledWith(
        'agent-1',
        expect.objectContaining({ tools: null, templateName: null, templateHash: null })
      );
    });
  });

  it('clears template tracking when preset-defining fields are customized', async () => {
    const agent = makeAgent({ id: 'agent-1', templateName: 'Coder', templateHash: 'hash-old' });
    mockUpdateAgent.mockResolvedValue(agent);

    const { getByPlaceholderText, getByRole } = render(
      <SpaceAgentEditor {...DEFAULT_PROPS} agent={agent} />
    );

    fireEvent.input(getByPlaceholderText("Briefly describe this agent's specialization..."), {
      target: { value: 'Custom description' },
    });
    fireEvent.submit(getByRole('dialog').querySelector('form')!);

    await waitFor(() => {
      expect(mockUpdateAgent).toHaveBeenCalledWith(
        'agent-1',
        expect.objectContaining({ templateName: null, templateHash: null })
      );
    });
  });

  it('calls onSave after successful create', async () => {
    const onSave = vi.fn();
    mockCreateAgent.mockResolvedValue({});

    const { getByPlaceholderText, getByTestId, getByRole } = render(
      <SpaceAgentEditor {...DEFAULT_PROPS} onSave={onSave} />
    );

    fillName(getByPlaceholderText, 'New Agent');
    fillModel(getByTestId, 'claude-sonnet-4-6');

    const form = getByRole('dialog').querySelector('form');
    fireEvent.submit(form!);

    await waitFor(() => {
      expect(onSave).toHaveBeenCalled();
    });
  });

  it('shows error message when save fails', async () => {
    mockCreateAgent.mockRejectedValue(new Error('Name already taken'));

    const { getByPlaceholderText, getByTestId, getByRole, findByText } = render(
      <SpaceAgentEditor {...DEFAULT_PROPS} />
    );

    fillName(getByPlaceholderText, 'New Agent');
    fillModel(getByTestId, 'claude-sonnet-4-6');

    const form = getByRole('dialog').querySelector('form');
    fireEvent.submit(form!);

    expect(await findByText('Name already taken')).toBeTruthy();
  });

  it('does not call onSave when save fails', async () => {
    const onSave = vi.fn();
    mockCreateAgent.mockRejectedValue(new Error('Server error'));

    const { getByPlaceholderText, getByTestId, getByRole } = render(
      <SpaceAgentEditor {...DEFAULT_PROPS} onSave={onSave} />
    );

    fillName(getByPlaceholderText, 'New Agent');
    fillModel(getByTestId, 'claude-sonnet-4-6');

    const form = getByRole('dialog').querySelector('form');
    fireEvent.submit(form!);

    await waitFor(() => {
      expect(mockCreateAgent).toHaveBeenCalled();
    });

    expect(onSave).not.toHaveBeenCalled();
  });

  describe('Reset to preset default button', () => {
    beforeEach(() => {
      mockAgentTemplates = [
        {
          name: 'Coder',
          description: 'Implementation worker.',
          tools: [],
          customPrompt: 'You are an expert software engineer.',
          templateHash: 'coder-hash',
        },
      ];
    });

    it('renders in edit mode when the agent name matches a preset', () => {
      const agent = makeAgent({ name: 'Coder' });
      const { getByText } = render(<SpaceAgentEditor {...DEFAULT_PROPS} agent={agent} />);
      expect(getByText('Reset to Coder default')).toBeTruthy();
    });

    it('does not render when the agent name matches no preset', () => {
      const agent = makeAgent({ name: 'CustomBot' });
      const { queryByText } = render(<SpaceAgentEditor {...DEFAULT_PROPS} agent={agent} />);
      expect(queryByText('Reset to Coder default')).toBeNull();
    });

    it('does not render in create mode even when the typed name matches a preset', () => {
      const { getByPlaceholderText, queryByText } = render(<SpaceAgentEditor {...DEFAULT_PROPS} />);
      fillName(getByPlaceholderText, 'Coder');
      expect(queryByText('Reset to Coder default')).toBeNull();
    });

    it('loads the preset description and custom prompt into the draft on click', () => {
      const agent = makeAgent({
        name: 'Coder',
        description: 'My custom description',
        customPrompt: 'My custom prompt',
      });
      const { getByText, getByPlaceholderText, container } = render(
        <SpaceAgentEditor {...DEFAULT_PROPS} agent={agent} />
      );

      fireEvent.click(getByText('Reset to Coder default'));

      const descInput = getByPlaceholderText(
        "Briefly describe this agent's specialization..."
      ) as HTMLInputElement;
      const promptTextarea = container.querySelector('textarea') as HTMLTextAreaElement;
      expect(descInput.value).toBe('Implementation worker.');
      expect(promptTextarea.value).toBe('You are an expert software engineer.');
    });

    it('re-stamps template tracking on save after reset (orphan recovery)', async () => {
      const agent = makeAgent({
        id: 'agent-1',
        name: 'Coder',
        templateName: null,
        templateHash: null,
      });
      mockUpdateAgent.mockResolvedValue(agent);

      const { getByText, getByRole } = render(
        <SpaceAgentEditor {...DEFAULT_PROPS} agent={agent} />
      );

      fireEvent.click(getByText('Reset to Coder default'));
      fireEvent.submit(getByRole('dialog').querySelector('form')!);

      await waitFor(() => {
        expect(mockUpdateAgent).toHaveBeenCalledWith(
          'agent-1',
          expect.objectContaining({ templateName: 'Coder', templateHash: 'coder-hash' })
        );
      });
    });
  });

  it('calls onCancel when Cancel button is clicked', () => {
    const onCancel = vi.fn();
    const { getByText } = render(<SpaceAgentEditor {...DEFAULT_PROPS} onCancel={onCancel} />);
    fireEvent.click(getByText('Cancel'));
    expect(onCancel).toHaveBeenCalled();
  });
});

describe('SpaceAgentEditor model pool', () => {
  it('defaults to single mode with no pool controls', () => {
    const { getByTestId, queryByTestId } = render(<SpaceAgentEditor {...DEFAULT_PROPS} />);
    expect(getByTestId('space-agent-model-select')).toBeTruthy();
    expect(queryByTestId('agent-model-pool')).toBeNull();
  });

  it('opens in pool mode when the agent has a pool', () => {
    const agent = makeAgent({
      modelPool: [{ model: 'claude-haiku-4-5', maxConcurrent: 2, weight: 40 }],
    });
    const { getByTestId, queryByTestId } = render(
      <SpaceAgentEditor {...DEFAULT_PROPS} agent={agent} />
    );
    expect(queryByTestId('space-agent-model-select')).toBeNull();
    expect(getByTestId('agent-model-pool')).toBeTruthy();
  });

  it('seeds one empty entry when switching to pool mode', () => {
    const { getByTestId, getAllByTestId } = render(<SpaceAgentEditor {...DEFAULT_PROPS} />);
    fireEvent.click(getByTestId('agent-model-mode-pool'));
    expect(getAllByTestId('pool-entry')).toHaveLength(1);
  });

  it('appends entries with the add button in pool mode', () => {
    const { getByTestId, getAllByTestId } = render(<SpaceAgentEditor {...DEFAULT_PROPS} />);
    fireEvent.click(getByTestId('agent-model-mode-pool'));
    fireEvent.click(getByTestId('pool-add-model-button'));
    expect(getAllByTestId('pool-entry')).toHaveLength(2);
  });

  it('sends modelPool in create params when entries are configured', async () => {
    mockCreateAgent.mockResolvedValue({ id: 'new-agent', name: 'Fresh Agent' });

    const { getByPlaceholderText, getByTestId, getByRole } = render(
      <SpaceAgentEditor {...DEFAULT_PROPS} />
    );

    fillName(getByPlaceholderText, 'Fresh Agent');
    fireEvent.click(getByTestId('agent-model-mode-pool'));

    const modelSelect = getByTestId('pool-entry-model-select') as HTMLSelectElement;
    fireEvent.change(modelSelect, { target: { value: 'claude-sonnet-4-6' } });
    fireEvent.input(getByTestId('pool-entry-max-input'), { target: { value: '8' } });
    fireEvent.input(getByTestId('pool-entry-weight-input'), { target: { value: '50' } });

    const form = getByRole('dialog').querySelector('form');
    fireEvent.submit(form!);

    await waitFor(() => {
      expect(mockCreateAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          modelPool: [
            {
              model: 'claude-sonnet-4-6',
              provider: 'anthropic',
              maxConcurrent: 8,
              weight: 50,
            },
          ],
        })
      );
    });
  });

  it('switching to pool mode clears the single model on save', async () => {
    const agent = makeAgent({ model: 'claude-haiku-4-5' });
    mockUpdateAgent.mockResolvedValue(agent);

    const { getByTestId, getByRole } = render(
      <SpaceAgentEditor {...DEFAULT_PROPS} agent={agent} />
    );

    fireEvent.click(getByTestId('agent-model-mode-pool'));
    fireEvent.change(getByTestId('pool-entry-model-select'), {
      target: { value: 'claude-sonnet-4-6' },
    });

    const form = getByRole('dialog').querySelector('form');
    fireEvent.submit(form!);

    await waitFor(() => {
      expect(mockUpdateAgent).toHaveBeenCalledWith(
        'agent-1',
        expect.objectContaining({
          modelPool: [
            { model: 'claude-sonnet-4-6', provider: 'anthropic', maxConcurrent: 1, weight: 100 },
          ],
          model: null,
          provider: null,
        })
      );
    });
  });

  it('switching to single mode clears the pool on save', async () => {
    const agent = makeAgent({
      modelPool: [{ model: 'claude-haiku-4-5', maxConcurrent: 2, weight: 40 }],
    });
    mockUpdateAgent.mockResolvedValue(agent);

    const { getByTestId, getByRole } = render(
      <SpaceAgentEditor {...DEFAULT_PROPS} agent={agent} />
    );

    fireEvent.click(getByTestId('agent-model-mode-single'));

    const form = getByRole('dialog').querySelector('form');
    fireEvent.submit(form!);

    await waitFor(() => {
      expect(mockUpdateAgent).toHaveBeenCalledWith(
        'agent-1',
        expect.objectContaining({ model: 'claude-sonnet-4-6', modelPool: null })
      );
    });
  });

  it('seeds pool state from the agent and persists edits', async () => {
    const agent = makeAgent({
      modelPool: [{ model: 'claude-haiku-4-5', maxConcurrent: 2, weight: 40 }],
    });
    mockUpdateAgent.mockResolvedValue(agent);

    const { getByTestId, getByRole } = render(
      <SpaceAgentEditor {...DEFAULT_PROPS} agent={agent} />
    );

    fireEvent.input(getByTestId('pool-entry-weight-input'), { target: { value: '80' } });

    const form = getByRole('dialog').querySelector('form');
    fireEvent.submit(form!);

    await waitFor(() => {
      expect(mockUpdateAgent).toHaveBeenCalledWith(
        'agent-1',
        expect.objectContaining({
          modelPool: [{ model: 'claude-haiku-4-5', maxConcurrent: 2, weight: 80 }],
        })
      );
    });
  });

  it('clears the pool with null in edit mode when all entries are removed', async () => {
    const agent = makeAgent({
      modelPool: [{ model: 'claude-haiku-4-5', maxConcurrent: 2, weight: 40 }],
    });
    mockUpdateAgent.mockResolvedValue(agent);

    const { getByTestId, getByRole } = render(
      <SpaceAgentEditor {...DEFAULT_PROPS} agent={agent} />
    );

    fireEvent.click(getByTestId('pool-entry-remove-button'));

    const form = getByRole('dialog').querySelector('form');
    fireEvent.submit(form!);

    await waitFor(() => {
      expect(mockUpdateAgent).toHaveBeenCalledWith(
        'agent-1',
        expect.objectContaining({ modelPool: null })
      );
    });
  });

  it('omits modelPool on create when no entries are added', async () => {
    mockCreateAgent.mockResolvedValue({ id: 'new-agent', name: 'Fresh Agent' });

    const { getByPlaceholderText, getByRole } = render(<SpaceAgentEditor {...DEFAULT_PROPS} />);

    fillName(getByPlaceholderText, 'Fresh Agent');

    const form = getByRole('dialog').querySelector('form');
    fireEvent.submit(form!);

    await waitFor(() => {
      expect(mockCreateAgent).toHaveBeenCalled();
    });
    const call = mockCreateAgent.mock.calls[0][0] as Record<string, unknown>;
    expect(call.modelPool).toBeUndefined();
  });
});
