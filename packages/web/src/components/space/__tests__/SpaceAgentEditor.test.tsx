// @ts-nocheck
/**
 * Unit tests for SpaceAgentEditor
 *
 * Tests:
 * - Renders in create mode (no agent prop)
 * - Renders in edit mode (with agent prop, fields pre-filled)
 * - Form validation: name required
 * - Form validation: name uniqueness
 * - Form validation: model required
 * - Form validation: at least one tool selected
 * - Tool presets: "Full Coding" selects correct tools
 * - Tool presets: "Read Only" selects correct tools
 * - Tool presets: toggling a tool manually switches to "Custom"
 * - System prompt field accepts direct edits
 * - KNOWN_TOOLS: all tools are rendered as checkboxes
 * - Create mode: calls spaceStore.createAgent with correct params
 * - Edit mode: calls spaceStore.updateAgent with correct params
 * - Error from server is shown
 * - Cancel calls onCancel
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, waitFor, cleanup } from '@testing-library/preact';
import { KNOWN_TOOLS } from '@neokai/shared';
import type { SpaceAgent } from '@neokai/shared';

// ── Mocks ────────────────────────────────────────────────────────────────────

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
    onChange: (value: string | undefined) => void;
    testId: string;
    className?: string;
  }) => (
    <select
      data-testid={testId}
      value={value ?? ''}
      onChange={(e) => onChange((e.target as HTMLSelectElement).value || undefined)}
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

// ── Helpers ───────────────────────────────────────────────────────────────────

const DEFAULT_PROPS = {
  agent: null,
  existingAgentNames: [],
  onSave: vi.fn(),
  onCancel: vi.fn(),
};

function makeAgent(overrides: Partial<SpaceAgent> = {}): SpaceAgent {
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

/** Fill the name input with a value */
function fillName(getByPlaceholderText: (text: string) => HTMLElement, value: string) {
  const input = getByPlaceholderText('e.g., Senior Coder') as HTMLInputElement;
  fireEvent.input(input, { target: { value } });
}

/** Select a model value from the dropdown */
function fillModel(getByTestId: (id: string) => HTMLElement, value: string) {
  const select = getByTestId('space-agent-model-select') as HTMLSelectElement;
  fireEvent.change(select, { target: { value } });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

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

  // ── Render modes ──────────────────────────────────────────────────────────

  it('renders with "Create Agent" title in create mode', () => {
    const { getByRole } = render(<SpaceAgentEditor {...DEFAULT_PROPS} />);
    expect(getByRole('dialog', { name: 'Create worker agent' })).toBeTruthy();
  });

  it('renders with edit title in edit mode', () => {
    const agent = makeAgent({ name: 'My Coder' });
    const { getByRole } = render(<SpaceAgentEditor {...DEFAULT_PROPS} agent={agent} />);
    expect(getByRole('dialog', { name: 'Edit worker agent: My Coder' })).toBeTruthy();
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

  // ── Validation ────────────────────────────────────────────────────────────

  it('shows name required error when submitting with empty name', async () => {
    const { getByRole, findByText } = render(<SpaceAgentEditor {...DEFAULT_PROPS} />);
    // Submit with empty name — validation should fail before even checking model
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

  it('shows model required error when submitting with empty model', async () => {
    const { getByPlaceholderText, getByRole, findByText } = render(
      <SpaceAgentEditor {...DEFAULT_PROPS} />
    );
    fillName(getByPlaceholderText, 'My Agent');
    // Leave model empty
    const form = getByRole('dialog').querySelector('form');
    fireEvent.submit(form!);
    expect(await findByText('Model is required')).toBeTruthy();
  });

  it('shows tools error when no tools are selected', async () => {
    const { container, getByPlaceholderText, getByTestId, getByRole, findByText } = render(
      <SpaceAgentEditor {...DEFAULT_PROPS} />
    );
    fillName(getByPlaceholderText, 'My Agent');
    fillModel(getByTestId, 'claude-sonnet-4-6');

    // Uncheck all tools via the checkboxes
    const checkboxes = container.querySelectorAll('input[type="checkbox"]');
    checkboxes.forEach((cb) => {
      if ((cb as HTMLInputElement).checked) {
        fireEvent.change(cb, { target: { checked: false } });
      }
    });

    // Click each checked tool label to toggle off
    // Instead, find all tool labels and click them to deselect
    const toolLabels = Array.from(container.querySelectorAll('label')).filter((l) => {
      const cb = l.querySelector('input[type="checkbox"]');
      return cb && (cb as HTMLInputElement).checked;
    });
    for (const label of toolLabels) {
      fireEvent.click(label);
    }

    const form = getByRole('dialog').querySelector('form');
    fireEvent.submit(form!);
    expect(await findByText('At least one tool must be selected')).toBeTruthy();
  });

  // ── KNOWN_TOOLS ────────────────────────────────────────────────────────────

  it('renders all KNOWN_TOOLS as checkboxes', () => {
    const { getByText } = render(<SpaceAgentEditor {...DEFAULT_PROPS} />);
    for (const tool of KNOWN_TOOLS) {
      expect(getByText(tool)).toBeTruthy();
    }
  });

  // ── Tool presets ──────────────────────────────────────────────────────────

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

  it('applies "Full Coding" preset and selects expected tools', () => {
    const { getByText, container } = render(<SpaceAgentEditor {...DEFAULT_PROPS} />);
    fireEvent.click(getByText('Full Coding'));

    const expectedTools = [
      'Read',
      'Write',
      'Edit',
      'Bash',
      'Grep',
      'Glob',
      'WebFetch',
      'WebSearch',
    ];
    const toolCheckboxes = container.querySelectorAll('input[type="checkbox"]');

    for (const tool of expectedTools) {
      const found = Array.from(toolCheckboxes).some((cb) => {
        const label = (cb as HTMLInputElement).closest('label');
        return label?.textContent?.includes(tool) && (cb as HTMLInputElement).checked;
      });
      expect(found, `Expected ${tool} to be checked after Full Coding preset`).toBe(true);
    }
    // Task/TaskOutput/TaskStop should NOT be checked
    const taskNotChecked = Array.from(toolCheckboxes).every((cb) => {
      const label = (cb as HTMLInputElement).closest('label');
      const toolName = label?.textContent?.trim();
      if (toolName === 'Task' || toolName === 'TaskOutput' || toolName === 'TaskStop') {
        return !(cb as HTMLInputElement).checked;
      }
      return true;
    });
    expect(taskNotChecked).toBe(true);
  });

  it('applies "Read Only" preset and selects only Read, Grep, Glob', () => {
    const { getByText, container } = render(<SpaceAgentEditor {...DEFAULT_PROPS} />);
    fireEvent.click(getByText('Read Only'));

    const toolCheckboxes = Array.from(container.querySelectorAll('input[type="checkbox"]'));
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

    // Start with Full Coding preset
    fireEvent.click(getByText('Full Coding'));

    // Toggle one tool off
    const toolCheckboxes = Array.from(container.querySelectorAll('input[type="checkbox"]'));
    const readCb = toolCheckboxes.find((cb) => {
      const label = (cb as HTMLInputElement).closest('label');
      return label?.textContent?.includes('Read');
    });
    if (readCb) fireEvent.click(readCb.closest('label')!);

    // "Custom" preset button should now be active
    const customButton = getByText('Custom');
    expect(customButton.className).toContain('blue');
  });

  it('uses direct system prompt edits without template buttons', () => {
    const { container, queryByText } = render(<SpaceAgentEditor {...DEFAULT_PROPS} />);
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;

    fireEvent.input(textarea, { target: { value: 'Exact prompt text' } });

    expect(textarea.value).toBe('Exact prompt text');
    expect(queryByText('Custom (blank)')).toBeNull();
    expect(queryByText('Research')).toBeNull();
  });

  // ── Create / Update submission ────────────────────────────────────────────

  it('calls spaceStore.createAgent with correct params in create mode', async () => {
    mockCreateAgent.mockResolvedValue({ id: 'new-agent', name: 'Fresh Agent' });

    const { getByPlaceholderText, getByTestId, getByRole } = render(
      <SpaceAgentEditor {...DEFAULT_PROPS} />
    );

    fillName(getByPlaceholderText, 'Fresh Agent');
    fillModel(getByTestId, 'claude-sonnet-4-6');
    // Full Coding preset is active by default

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

    // Change name
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

  // ── Cancel ────────────────────────────────────────────────────────────────

  it('calls onCancel when Cancel button is clicked', () => {
    const onCancel = vi.fn();
    const { getByText } = render(<SpaceAgentEditor {...DEFAULT_PROPS} onCancel={onCancel} />);
    fireEvent.click(getByText('Cancel'));
    expect(onCancel).toHaveBeenCalled();
  });
});
