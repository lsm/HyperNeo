import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, waitFor, fireEvent } from '@testing-library/preact';
import type { AppSkill } from '@hyperneo/shared';

const {
  mockAddSkill,
  mockUpdateSkill,
  mockRemoveSkill,
  mockSetEnabled,
  mockInstallSkillFromGit,
  mockToastError,
  mockToastSuccess,
  mockSubscribe,
  mockUnsubscribe,
  mockSkillsSignal,
  mockIsLoadingSignal,
  mockErrorSignal,
  mockGetHubIfConnected,
} = vi.hoisted(() => {
  const mockSkillsSignal = { value: [] as AppSkill[] };
  const mockIsLoadingSignal = { value: false };
  const mockErrorSignal = { value: null as string | null };
  return {
    mockAddSkill: vi.fn(),
    mockUpdateSkill: vi.fn(),
    mockRemoveSkill: vi.fn(),
    mockSetEnabled: vi.fn(),
    mockInstallSkillFromGit: vi.fn(),
    mockToastError: vi.fn(),
    mockToastSuccess: vi.fn(),
    mockSubscribe: vi.fn().mockResolvedValue(undefined),
    mockUnsubscribe: vi.fn(),
    mockSkillsSignal,
    mockIsLoadingSignal,
    mockErrorSignal,
    mockGetHubIfConnected: vi.fn(),
  };
});

vi.mock('../../../lib/skills-store.ts', () => ({
  skillsStore: {
    addSkill: (...args: unknown[]) => mockAddSkill(...args),
    updateSkill: (...args: unknown[]) => mockUpdateSkill(...args),
    removeSkill: (...args: unknown[]) => mockRemoveSkill(...args),
    setEnabled: (...args: unknown[]) => mockSetEnabled(...args),
    installSkillFromGit: (...args: unknown[]) => mockInstallSkillFromGit(...args),
  },
}));

vi.mock('../../../hooks/useSkills.ts', () => ({
  useSkills: () => ({
    skills: mockSkillsSignal.value,
    isLoading: mockIsLoadingSignal.value,
    error: mockErrorSignal.value,
  }),
}));

vi.mock('../../../lib/toast.ts', () => ({
  toast: {
    error: (msg: string) => mockToastError(msg),
    success: (msg: string) => mockToastSuccess(msg),
    info: vi.fn(),
    warning: vi.fn(),
  },
}));

vi.mock('../../../lib/connection-manager.ts', () => ({
  connectionManager: {
    getHubIfConnected: () => mockGetHubIfConnected(),
  },
}));

vi.mock('../../ui/Modal.tsx', () => ({
  Modal: ({
    isOpen,
    onClose,
    title,
    children,
  }: {
    isOpen: boolean;
    onClose: () => void;
    title: string;
    children: import('preact').ComponentChildren;
  }) =>
    isOpen ? (
      <div data-testid="modal">
        <h2 data-testid="modal-title">{title}</h2>
        <div data-testid="modal-content">{children}</div>
        <button data-testid="modal-close" onClick={onClose}>
          Close
        </button>
      </div>
    ) : null,
}));

vi.mock('../../ui/ConfirmModal.tsx', () => ({
  ConfirmModal: ({
    isOpen,
    onClose,
    onConfirm,
    title,
    message,
    confirmText,
    isLoading,
  }: {
    isOpen: boolean;
    onClose: () => void;
    onConfirm: () => void;
    title: string;
    message: string;
    confirmText?: string;
    isLoading?: boolean;
  }) =>
    isOpen ? (
      <div data-testid="confirm-modal">
        <span data-testid="confirm-title">{title}</span>
        <span data-testid="confirm-message">{message}</span>
        <button data-testid="confirm-cancel" onClick={onClose}>
          Cancel
        </button>
        <button data-testid="confirm-ok" onClick={onConfirm} disabled={isLoading}>
          {confirmText ?? 'Confirm'}
        </button>
      </div>
    ) : null,
}));

vi.mock('../SettingsSection.tsx', () => ({
  SettingsSection: ({
    title,
    children,
  }: {
    title: string;
    children: import('preact').ComponentChildren;
  }) => (
    <div data-testid="settings-section">
      <h3>{title}</h3>
      <div>{children}</div>
    </div>
  ),
  SettingsToggle: ({
    checked,
    onChange,
    disabled,
  }: {
    checked: boolean;
    onChange: (v: boolean) => void;
    disabled?: boolean;
  }) => (
    <button
      data-testid="settings-toggle"
      data-checked={String(checked)}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      Toggle
    </button>
  ),
}));

vi.mock('../../ui/Button.tsx', () => ({
  Button: ({
    children,
    variant,
    size,
    type,
    onClick,
    disabled,
    loading,
  }: {
    children: import('preact').ComponentChildren;
    variant?: string;
    size?: string;
    type?: 'button' | 'submit';
    onClick?: () => void;
    disabled?: boolean;
    loading?: boolean;
  }) => (
    <button
      data-testid={`button-${variant ?? 'primary'}`}
      data-size={size}
      type={type ?? 'button'}
      disabled={disabled ?? loading}
      onClick={onClick}
    >
      {loading && <span data-testid="button-loading">Loading...</span>}
      {children}
    </button>
  ),
}));

import { SkillsRegistry } from '../SkillsRegistry.tsx';
import { AddSkillDialog } from '../AddSkillDialog.tsx';
import { EditSkillDialog } from '../EditSkillDialog.tsx';

function makeSkill(id: string, overrides: Partial<AppSkill> = {}): AppSkill {
  return {
    id,
    name: `skill-${id}`,
    displayName: `Skill ${id}`,
    description: `Description for skill ${id}`,
    sourceType: 'builtin',
    config: { type: 'builtin', commandName: `cmd-${id}` },
    enabled: true,
    builtIn: false,
    validationStatus: 'valid',
    createdAt: 1000000,
    ...overrides,
  };
}

describe('SkillsRegistry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cleanup();
    mockSkillsSignal.value = [];
    mockIsLoadingSignal.value = false;
    mockErrorSignal.value = null;

    mockAddSkill.mockResolvedValue(makeSkill('new'));
    mockUpdateSkill.mockResolvedValue(makeSkill('1'));
    mockRemoveSkill.mockResolvedValue(true);
    mockSetEnabled.mockResolvedValue(makeSkill('1'));
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  describe('Skill List Display', () => {
    it('should show empty state when no skills', () => {
      render(<SkillsRegistry />);
      expect(screen.getByText(/No skills added yet/)).toBeTruthy();
    });

    it('should show loading state', () => {
      mockIsLoadingSignal.value = true;
      mockSkillsSignal.value = [];
      render(<SkillsRegistry />);
      expect(screen.getByText('Loading skills...')).toBeTruthy();
    });

    it('should show error state', () => {
      mockErrorSignal.value = 'Connection failed';
      render(<SkillsRegistry />);
      expect(screen.getByText(/Connection failed/)).toBeTruthy();
    });

    it('should display skill displayName and sourceType badge', () => {
      mockSkillsSignal.value = [
        makeSkill('1', { displayName: 'Web Search', sourceType: 'builtin' }),
        makeSkill('2', { displayName: 'My Plugin', sourceType: 'plugin' }),
      ];
      render(<SkillsRegistry />);
      expect(screen.getByText('Web Search')).toBeTruthy();
      expect(screen.getByText('My Plugin')).toBeTruthy();
      expect(screen.getByText('built-in')).toBeTruthy();
      expect(screen.getByText('plugin')).toBeTruthy();
    });

    it('should display description when present', () => {
      mockSkillsSignal.value = [makeSkill('1', { description: 'A useful skill' })];
      render(<SkillsRegistry />);
      expect(screen.getByText('A useful skill')).toBeTruthy();
    });

    it('should show edit and delete buttons for non-built-in skills', () => {
      mockSkillsSignal.value = [makeSkill('1', { builtIn: false })];
      render(<SkillsRegistry />);
      expect(screen.getByTitle('Edit')).toBeTruthy();
      expect(screen.getByTitle('Delete')).toBeTruthy();
    });

    it('should not show edit/delete buttons for built-in skills', () => {
      mockSkillsSignal.value = [makeSkill('1', { builtIn: true })];
      render(<SkillsRegistry />);
      expect(screen.queryByTitle('Edit')).toBeNull();
      expect(screen.queryByTitle('Delete')).toBeNull();
    });

    it('should show toggle for each skill', () => {
      mockSkillsSignal.value = [makeSkill('1')];
      render(<SkillsRegistry />);
      expect(screen.getByTestId('settings-toggle')).toBeTruthy();
    });

    it('should show Add Skill button', () => {
      render(<SkillsRegistry />);
      expect(screen.getByText('Add Skill')).toBeTruthy();
    });

    it('should show Install from Git button', () => {
      render(<SkillsRegistry />);
      expect(screen.getByText('Install from Git')).toBeTruthy();
    });
  });

  describe('Toggle', () => {
    it('should call setEnabled when toggle is clicked', async () => {
      mockSkillsSignal.value = [makeSkill('1', { enabled: true })];
      render(<SkillsRegistry />);

      fireEvent.click(screen.getByTestId('settings-toggle'));

      await waitFor(() => {
        expect(mockSetEnabled).toHaveBeenCalledWith('1', false);
      });
    });

    it('should show success toast after toggling', async () => {
      mockSkillsSignal.value = [makeSkill('1', { displayName: 'Web Search', enabled: true })];
      render(<SkillsRegistry />);

      fireEvent.click(screen.getByTestId('settings-toggle'));

      await waitFor(() => {
        expect(mockToastSuccess).toHaveBeenCalledWith('Disabled "Web Search"');
      });
    });

    it('should show error toast when toggle fails', async () => {
      mockSkillsSignal.value = [makeSkill('1', { enabled: true })];
      mockSetEnabled.mockRejectedValueOnce(new Error('Toggle failed'));
      render(<SkillsRegistry />);

      fireEvent.click(screen.getByTestId('settings-toggle'));

      await waitFor(() => {
        expect(mockToastError).toHaveBeenCalledWith('Toggle failed');
      });
    });
  });

  describe('Delete', () => {
    it('should show delete confirmation when Delete button is clicked', () => {
      mockSkillsSignal.value = [makeSkill('1', { displayName: 'My Skill', builtIn: false })];
      render(<SkillsRegistry />);

      fireEvent.click(screen.getByTitle('Delete'));

      expect(screen.getByTestId('confirm-modal')).toBeTruthy();
      expect(screen.getByTestId('confirm-title').textContent).toBe('Delete Skill');
      expect(screen.getByTestId('confirm-message').textContent).toContain('My Skill');
    });

    it('should call removeSkill when confirmed', async () => {
      mockSkillsSignal.value = [makeSkill('1', { builtIn: false })];
      render(<SkillsRegistry />);

      fireEvent.click(screen.getByTitle('Delete'));
      fireEvent.click(screen.getByTestId('confirm-ok'));

      await waitFor(() => {
        expect(mockRemoveSkill).toHaveBeenCalledWith('1');
      });
    });

    it('should show success toast after delete', async () => {
      mockSkillsSignal.value = [makeSkill('1', { displayName: 'My Skill', builtIn: false })];
      render(<SkillsRegistry />);

      fireEvent.click(screen.getByTitle('Delete'));
      fireEvent.click(screen.getByTestId('confirm-ok'));

      await waitFor(() => {
        expect(mockToastSuccess).toHaveBeenCalledWith('Deleted "My Skill"');
      });
    });

    it('should close confirmation after successful delete', async () => {
      mockSkillsSignal.value = [makeSkill('1', { builtIn: false })];
      render(<SkillsRegistry />);

      fireEvent.click(screen.getByTitle('Delete'));
      expect(screen.getByTestId('confirm-modal')).toBeTruthy();

      fireEvent.click(screen.getByTestId('confirm-ok'));

      await waitFor(() => {
        expect(screen.queryByTestId('confirm-modal')).toBeNull();
      });
    });

    it('should show error toast when delete fails', async () => {
      mockSkillsSignal.value = [makeSkill('1', { builtIn: false })];
      mockRemoveSkill.mockRejectedValueOnce(new Error('Delete failed'));
      render(<SkillsRegistry />);

      fireEvent.click(screen.getByTitle('Delete'));
      fireEvent.click(screen.getByTestId('confirm-ok'));

      await waitFor(() => {
        expect(mockToastError).toHaveBeenCalledWith('Delete failed');
      });
    });

    it('should close confirmation when Cancel is clicked', () => {
      mockSkillsSignal.value = [makeSkill('1', { builtIn: false })];
      render(<SkillsRegistry />);

      fireEvent.click(screen.getByTitle('Delete'));
      expect(screen.getByTestId('confirm-modal')).toBeTruthy();

      fireEvent.click(screen.getByTestId('confirm-cancel'));
      expect(screen.queryByTestId('confirm-modal')).toBeNull();
    });
  });

  describe('Open Add Dialog', () => {
    it('should open AddSkillDialog when Add Skill button is clicked', () => {
      render(<SkillsRegistry />);

      fireEvent.click(screen.getByText('Add Skill'));

      expect(screen.getByTestId('modal')).toBeTruthy();
      expect(screen.getByTestId('modal-title').textContent).toBe('Add Skill');
    });
  });

  describe('Open Install from Git Dialog', () => {
    it('should open InstallSkillFromGitDialog when Install from Git button is clicked', () => {
      render(<SkillsRegistry />);

      fireEvent.click(screen.getByText('Install from Git'));

      expect(screen.getByTestId('modal')).toBeTruthy();
      expect(screen.getByTestId('modal-title').textContent).toBe('Install Skill from Git');
    });
  });

  describe('Open Edit Dialog', () => {
    it('should open EditSkillDialog when Edit button is clicked', () => {
      mockSkillsSignal.value = [makeSkill('1', { builtIn: false })];
      render(<SkillsRegistry />);

      fireEvent.click(screen.getByTitle('Edit'));

      expect(screen.getByTestId('modal')).toBeTruthy();
      expect(screen.getByTestId('modal-title').textContent).toBe('Edit Skill');
    });
  });
});

describe('AddSkillDialog', () => {
  const onClose = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    cleanup();
    mockAddSkill.mockResolvedValue(makeSkill('new'));
    mockGetHubIfConnected.mockReturnValue(null);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('should render form when open', () => {
    render(<AddSkillDialog isOpen onClose={onClose} />);
    expect(screen.getByTestId('modal')).toBeTruthy();
    expect(screen.getByTestId('modal-title').textContent).toBe('Add Skill');
  });

  it('should not render when closed', () => {
    render(<AddSkillDialog isOpen={false} onClose={onClose} />);
    expect(screen.queryByTestId('modal')).toBeNull();
  });

  it('should auto-derive slug from display name', () => {
    render(<AddSkillDialog isOpen onClose={onClose} />);

    const displayNameInput = screen.getByPlaceholderText('e.g., Web Search');
    fireEvent.change(displayNameInput, { target: { value: 'My Cool Skill' } });

    const nameInput = screen.getByPlaceholderText('e.g., web-search');
    expect((nameInput as HTMLInputElement).value).toBe('my-cool-skill');
  });

  it('should not override slug when name was manually edited', () => {
    render(<AddSkillDialog isOpen onClose={onClose} />);

    const nameInput = screen.getByPlaceholderText('e.g., web-search');
    fireEvent.change(nameInput, { target: { value: 'custom-slug' } });

    const displayNameInput = screen.getByPlaceholderText('e.g., Web Search');
    fireEvent.change(displayNameInput, { target: { value: 'Something Else' } });

    expect((nameInput as HTMLInputElement).value).toBe('custom-slug');
  });

  it('should show validation error when display name is empty', async () => {
    render(<AddSkillDialog isOpen onClose={onClose} />);

    fireEvent.click(screen.getByTestId('button-primary'));

    await waitFor(() => {
      expect(screen.getByText('Display Name is required')).toBeTruthy();
    });
    expect(mockAddSkill).not.toHaveBeenCalled();
  });

  it('should show validation error when name has invalid chars', async () => {
    render(<AddSkillDialog isOpen onClose={onClose} />);

    const displayNameInput = screen.getByPlaceholderText('e.g., Web Search');
    fireEvent.change(displayNameInput, { target: { value: 'Test' } });

    const nameInput = screen.getByPlaceholderText('e.g., web-search');
    fireEvent.change(nameInput, { target: { value: 'Invalid Name!' } });

    fireEvent.click(screen.getByTestId('button-primary'));

    await waitFor(() => {
      expect(screen.getByText(/lowercase letters, numbers, and hyphens/)).toBeTruthy();
    });
  });

  it('should show command name field for built-in source type', () => {
    render(<AddSkillDialog isOpen onClose={onClose} />);
    expect(screen.getByPlaceholderText('e.g., update-config')).toBeTruthy();
  });

  it('should show plugin path field when plugin source type is selected', () => {
    render(<AddSkillDialog isOpen onClose={onClose} />);

    const pluginRadio = screen.getByDisplayValue('plugin');
    fireEvent.click(pluginRadio);

    expect(screen.getByPlaceholderText('/path/to/plugin-directory')).toBeTruthy();
  });

  it('should require command name for built-in type', async () => {
    render(<AddSkillDialog isOpen onClose={onClose} />);

    const displayNameInput = screen.getByPlaceholderText('e.g., Web Search');
    fireEvent.change(displayNameInput, { target: { value: 'My Skill' } });

    fireEvent.click(screen.getByTestId('button-primary'));

    await waitFor(() => {
      expect(screen.getByText('Command name is required for built-in skills')).toBeTruthy();
    });
    expect(mockAddSkill).not.toHaveBeenCalled();
  });

  it('should require plugin path for plugin type', async () => {
    render(<AddSkillDialog isOpen onClose={onClose} />);

    const pluginRadio = screen.getByDisplayValue('plugin');
    fireEvent.click(pluginRadio);

    const displayNameInput = screen.getByPlaceholderText('e.g., Web Search');
    fireEvent.change(displayNameInput, { target: { value: 'My Skill' } });

    fireEvent.click(screen.getByTestId('button-primary'));

    await waitFor(() => {
      expect(screen.getByText('Plugin directory path is required')).toBeTruthy();
    });
    expect(mockAddSkill).not.toHaveBeenCalled();
  });

  it('should call addSkill with correct params on valid submit', async () => {
    render(<AddSkillDialog isOpen onClose={onClose} />);

    fireEvent.change(screen.getByPlaceholderText('e.g., Web Search'), {
      target: { value: 'Web Search' },
    });
    fireEvent.change(screen.getByPlaceholderText('e.g., update-config'), {
      target: { value: 'web-search-cmd' },
    });

    fireEvent.click(screen.getByTestId('button-primary'));

    await waitFor(() => {
      expect(mockAddSkill).toHaveBeenCalledWith(
        expect.objectContaining({
          displayName: 'Web Search',
          name: 'web-search',
          sourceType: 'builtin',
          config: { type: 'builtin', commandName: 'web-search-cmd' },
          enabled: true,
        })
      );
    });
  });

  it('should show success toast and close after successful add', async () => {
    render(<AddSkillDialog isOpen onClose={onClose} />);

    fireEvent.change(screen.getByPlaceholderText('e.g., Web Search'), {
      target: { value: 'My Skill' },
    });
    fireEvent.change(screen.getByPlaceholderText('e.g., update-config'), {
      target: { value: 'my-cmd' },
    });

    fireEvent.click(screen.getByTestId('button-primary'));

    await waitFor(() => {
      expect(mockToastSuccess).toHaveBeenCalledWith('Added "My Skill"');
    });
    expect(onClose).toHaveBeenCalled();
  });

  it('should show error toast when add fails', async () => {
    mockAddSkill.mockRejectedValueOnce(new Error('Server error'));
    render(<AddSkillDialog isOpen onClose={onClose} />);

    fireEvent.change(screen.getByPlaceholderText('e.g., Web Search'), {
      target: { value: 'My Skill' },
    });
    fireEvent.change(screen.getByPlaceholderText('e.g., update-config'), {
      target: { value: 'my-cmd' },
    });

    fireEvent.click(screen.getByTestId('button-primary'));

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith('Server error');
    });
  });

  it('should close when Cancel is clicked', () => {
    render(<AddSkillDialog isOpen onClose={onClose} />);
    fireEvent.click(screen.getByText('Cancel'));
    expect(onClose).toHaveBeenCalled();
  });

  it('should show "no MCP servers" message when mcp_server type selected and no hub', () => {
    mockGetHubIfConnected.mockReturnValue(null);
    render(<AddSkillDialog isOpen onClose={onClose} />);

    const mcpRadio = screen.getByDisplayValue('mcp_server');
    fireEvent.click(mcpRadio);

    expect(screen.getByText(/No application MCP servers configured/)).toBeTruthy();
  });

  it('should populate MCP server dropdown when hub returns servers', async () => {
    const mockHub = {
      request: vi.fn().mockResolvedValue({
        servers: [{ id: 'srv-1', name: 'Fetch MCP', sourceType: 'stdio', enabled: true }],
      }),
    };
    mockGetHubIfConnected.mockReturnValue(mockHub);

    render(<AddSkillDialog isOpen onClose={onClose} />);

    const mcpRadio = screen.getByDisplayValue('mcp_server');
    fireEvent.click(mcpRadio);

    await waitFor(() => {
      expect(screen.getByText('Fetch MCP')).toBeTruthy();
    });
  });

  it('should require MCP server selection for mcp_server type', async () => {
    const mockHub = {
      request: vi.fn().mockResolvedValue({
        servers: [{ id: 'srv-1', name: 'Fetch MCP', sourceType: 'stdio', enabled: true }],
      }),
    };
    mockGetHubIfConnected.mockReturnValue(mockHub);

    render(<AddSkillDialog isOpen onClose={onClose} />);

    const mcpRadio = screen.getByDisplayValue('mcp_server');
    fireEvent.click(mcpRadio);

    await waitFor(() => {
      expect(screen.getByText('Fetch MCP')).toBeTruthy();
    });

    fireEvent.change(screen.getByPlaceholderText('e.g., Web Search'), {
      target: { value: 'My MCP Skill' },
    });

    fireEvent.click(screen.getByTestId('button-primary'));

    await waitFor(() => {
      expect(screen.getByText('Please select an MCP server')).toBeTruthy();
    });
  });
});

describe('EditSkillDialog', () => {
  const onClose = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    cleanup();
    mockUpdateSkill.mockResolvedValue(makeSkill('1'));
    mockGetHubIfConnected.mockReturnValue(null);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('should render form pre-populated with skill data', () => {
    const skill = makeSkill('1', {
      displayName: 'Test Skill',
      description: 'A test description',
      sourceType: 'builtin',
      config: { type: 'builtin', commandName: 'test-cmd' },
    });
    render(<EditSkillDialog skill={skill} isOpen onClose={onClose} />);

    expect(screen.getByTestId('modal-title').textContent).toBe('Edit Skill');
    expect((screen.getByDisplayValue('Test Skill') as HTMLInputElement).value).toBe('Test Skill');
    expect((screen.getByDisplayValue('test-cmd') as HTMLInputElement).value).toBe('test-cmd');
  });

  it('should show read-only ID and Created fields', () => {
    const skill = makeSkill('1', {
      id: 'test-uuid-123',
      createdAt: new Date('2024-01-01').getTime(),
    });
    render(<EditSkillDialog skill={skill} isOpen onClose={onClose} />);

    expect(screen.getByText('test-uuid-123')).toBeTruthy();
  });

  it('should show read-only name field', () => {
    const skill = makeSkill('1', { name: 'my-skill' });
    render(<EditSkillDialog skill={skill} isOpen onClose={onClose} />);

    expect(screen.getByText('my-skill')).toBeTruthy();
    expect(screen.getByText('Name cannot be changed after creation')).toBeTruthy();
  });

  it('should require display name', async () => {
    const skill = makeSkill('1', { displayName: 'Original' });
    render(<EditSkillDialog skill={skill} isOpen onClose={onClose} />);

    const displayNameInput = screen.getByDisplayValue('Original');
    fireEvent.change(displayNameInput, { target: { value: '' } });

    fireEvent.click(screen.getByText('Save Changes'));

    await waitFor(() => {
      expect(screen.getByText('Display Name is required')).toBeTruthy();
    });
    expect(mockUpdateSkill).not.toHaveBeenCalled();
  });

  it('should call updateSkill with correct params', async () => {
    const skill = makeSkill('1', {
      displayName: 'Old Name',
      sourceType: 'builtin',
      config: { type: 'builtin', commandName: 'old-cmd' },
    });
    render(<EditSkillDialog skill={skill} isOpen onClose={onClose} />);

    const displayNameInput = screen.getByDisplayValue('Old Name');
    fireEvent.change(displayNameInput, { target: { value: 'New Name' } });

    const cmdInput = screen.getByDisplayValue('old-cmd');
    fireEvent.change(cmdInput, { target: { value: 'new-cmd' } });

    fireEvent.click(screen.getByText('Save Changes'));

    await waitFor(() => {
      expect(mockUpdateSkill).toHaveBeenCalledWith(
        '1',
        expect.objectContaining({
          displayName: 'New Name',
          config: { type: 'builtin', commandName: 'new-cmd' },
        })
      );
    });
  });

  it('should show success toast and close after save', async () => {
    const skill = makeSkill('1', { displayName: 'My Skill' });
    render(<EditSkillDialog skill={skill} isOpen onClose={onClose} />);

    fireEvent.click(screen.getByText('Save Changes'));

    await waitFor(() => {
      expect(mockToastSuccess).toHaveBeenCalledWith('Updated "My Skill"');
    });
    expect(onClose).toHaveBeenCalled();
  });

  it('should show error toast when update fails', async () => {
    mockUpdateSkill.mockRejectedValueOnce(new Error('Update failed'));
    const skill = makeSkill('1', { displayName: 'My Skill' });
    render(<EditSkillDialog skill={skill} isOpen onClose={onClose} />);

    fireEvent.click(screen.getByText('Save Changes'));

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith('Update failed');
    });
  });

  it('should close when Cancel is clicked', () => {
    const skill = makeSkill('1');
    render(<EditSkillDialog skill={skill} isOpen onClose={onClose} />);

    fireEvent.click(screen.getByText('Cancel'));
    expect(onClose).toHaveBeenCalled();
  });

  it('should pre-populate plugin path for plugin skills', () => {
    const skill = makeSkill('1', {
      sourceType: 'plugin',
      config: { type: 'plugin', pluginPath: '/my/plugin/path' },
    });
    render(<EditSkillDialog skill={skill} isOpen onClose={onClose} />);

    expect((screen.getByDisplayValue('/my/plugin/path') as HTMLInputElement).value).toBe(
      '/my/plugin/path'
    );
  });

  it('should not render when closed', () => {
    const skill = makeSkill('1');
    render(<EditSkillDialog skill={skill} isOpen={false} onClose={onClose} />);
    expect(screen.queryByTestId('modal')).toBeNull();
  });
});
