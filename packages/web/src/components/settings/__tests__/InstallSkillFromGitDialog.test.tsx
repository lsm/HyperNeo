import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, waitFor, fireEvent } from '@testing-library/preact';
import type { AppSkill } from '@hyperneo/shared';

const { mockInstallSkillFromGit, mockToastError, mockToastSuccess } = vi.hoisted(() => ({
  mockInstallSkillFromGit: vi.fn(),
  mockToastError: vi.fn(),
  mockToastSuccess: vi.fn(),
}));

vi.mock('../../../lib/skills-store.ts', () => ({
  skillsStore: {
    installSkillFromGit: (...args: unknown[]) => mockInstallSkillFromGit(...args),
  },
}));

vi.mock('../../../lib/toast.ts', () => ({
  toast: {
    error: (msg: string) => mockToastError(msg),
    success: (msg: string) => mockToastSuccess(msg),
    info: vi.fn(),
    warning: vi.fn(),
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

vi.mock('../../ui/Button.tsx', () => ({
  Button: ({
    children,
    variant,
    type,
    onClick,
    disabled,
    loading,
  }: {
    children: import('preact').ComponentChildren;
    variant?: string;
    type?: 'button' | 'submit';
    onClick?: () => void;
    disabled?: boolean;
    loading?: boolean;
  }) => (
    <button
      data-testid={`button-${variant ?? 'primary'}`}
      type={type ?? 'button'}
      disabled={disabled ?? loading}
      onClick={onClick}
    >
      {loading && <span data-testid="button-loading">Loading...</span>}
      {children}
    </button>
  ),
}));

import { InstallSkillFromGitDialog } from '../InstallSkillFromGitDialog.tsx';

function makeSkill(overrides: Partial<AppSkill> = {}): AppSkill {
  return {
    id: 'skill-1',
    name: 'playwright',
    displayName: 'Playwright',
    description: 'Browser automation',
    sourceType: 'builtin',
    config: { type: 'builtin', commandName: 'playwright' },
    enabled: true,
    builtIn: false,
    validationStatus: 'valid',
    createdAt: 1000000,
    ...overrides,
  };
}

describe('InstallSkillFromGitDialog', () => {
  const onClose = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    cleanup();
    mockInstallSkillFromGit.mockResolvedValue(makeSkill());
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('should render modal when open', () => {
    render(<InstallSkillFromGitDialog isOpen onClose={onClose} />);
    expect(screen.getByTestId('modal')).toBeTruthy();
    expect(screen.getByTestId('modal-title').textContent).toBe('Install Skill from Git');
  });

  it('should not render when closed', () => {
    render(<InstallSkillFromGitDialog isOpen={false} onClose={onClose} />);
    expect(screen.queryByTestId('modal')).toBeNull();
  });

  it('should auto-derive skill name from the URL last path segment', () => {
    render(<InstallSkillFromGitDialog isOpen onClose={onClose} />);

    const urlInput = screen.getByPlaceholderText(
      'https://github.com/owner/repo/tree/main/skills/my-skill'
    );
    fireEvent.input(urlInput, {
      target: { value: 'https://github.com/openai/skills/tree/main/skills/.curated/playwright' },
    });

    const nameInput = screen.getByPlaceholderText('e.g., playwright');
    expect((nameInput as HTMLInputElement).value).toBe('playwright');
  });

  it('should not override skill name once it has been manually edited', () => {
    render(<InstallSkillFromGitDialog isOpen onClose={onClose} />);

    const nameInput = screen.getByPlaceholderText('e.g., playwright');
    fireEvent.input(nameInput, { target: { value: 'my-custom-name' } });

    const urlInput = screen.getByPlaceholderText(
      'https://github.com/owner/repo/tree/main/skills/my-skill'
    );
    fireEvent.input(urlInput, {
      target: { value: 'https://github.com/openai/skills/tree/main/skills/.curated/playwright' },
    });

    expect((nameInput as HTMLInputElement).value).toBe('my-custom-name');
  });

  it('should show error when URL is empty on submit', async () => {
    render(<InstallSkillFromGitDialog isOpen onClose={onClose} />);

    fireEvent.click(screen.getByTestId('button-primary'));

    await waitFor(() => {
      expect(screen.getByText('Repository URL is required')).toBeTruthy();
    });
    expect(mockInstallSkillFromGit).not.toHaveBeenCalled();
  });

  it('should show error when URL does not start with https:// (git protocol)', async () => {
    render(<InstallSkillFromGitDialog isOpen onClose={onClose} />);

    const urlInput = screen.getByPlaceholderText(
      'https://github.com/owner/repo/tree/main/skills/my-skill'
    );
    fireEvent.input(urlInput, { target: { value: 'git@github.com:openai/skills.git' } });

    fireEvent.click(screen.getByTestId('button-primary'));

    await waitFor(() => {
      expect(screen.getByText('URL must start with https://')).toBeTruthy();
    });
    expect(mockInstallSkillFromGit).not.toHaveBeenCalled();
  });

  it('should show error when URL uses http:// (not https://)', async () => {
    render(<InstallSkillFromGitDialog isOpen onClose={onClose} />);

    const urlInput = screen.getByPlaceholderText(
      'https://github.com/owner/repo/tree/main/skills/my-skill'
    );
    fireEvent.input(urlInput, {
      target: { value: 'http://github.com/openai/skills/tree/main/skill' },
    });

    fireEvent.click(screen.getByTestId('button-primary'));

    await waitFor(() => {
      expect(screen.getByText('URL must start with https://')).toBeTruthy();
    });
    expect(mockInstallSkillFromGit).not.toHaveBeenCalled();
  });

  it('should show error when skill name is empty', async () => {
    render(<InstallSkillFromGitDialog isOpen onClose={onClose} />);

    const urlInput = screen.getByPlaceholderText(
      'https://github.com/owner/repo/tree/main/skills/my-skill'
    );
    fireEvent.input(urlInput, { target: { value: 'https://example.com/skill' } });

    const nameInput = screen.getByPlaceholderText('e.g., playwright');
    fireEvent.input(nameInput, { target: { value: '' } });
    fireEvent.input(nameInput, { target: { value: '' } });

    fireEvent.click(screen.getByTestId('button-primary'));

    await waitFor(() => {
      expect(screen.getByText('Skill name is required')).toBeTruthy();
    });
  });

  it('should show error when skill name contains invalid characters', async () => {
    render(<InstallSkillFromGitDialog isOpen onClose={onClose} />);

    const urlInput = screen.getByPlaceholderText(
      'https://github.com/owner/repo/tree/main/skills/my-skill'
    );
    fireEvent.input(urlInput, { target: { value: 'https://example.com/skill' } });

    const nameInput = screen.getByPlaceholderText('e.g., playwright');
    fireEvent.input(nameInput, { target: { value: 'Invalid Name!' } });

    fireEvent.click(screen.getByTestId('button-primary'));

    await waitFor(() => {
      expect(screen.getByText(/lowercase letters, numbers, and hyphens/)).toBeTruthy();
    });
    expect(mockInstallSkillFromGit).not.toHaveBeenCalled();
  });

  it('should call installSkillFromGit with trimmed URL and name on valid submit', async () => {
    render(<InstallSkillFromGitDialog isOpen onClose={onClose} />);

    const urlInput = screen.getByPlaceholderText(
      'https://github.com/owner/repo/tree/main/skills/my-skill'
    );
    fireEvent.input(urlInput, {
      target: {
        value: '  https://github.com/openai/skills/tree/main/skills/.curated/playwright  ',
      },
    });

    const nameInput = screen.getByPlaceholderText('e.g., playwright');
    fireEvent.input(nameInput, { target: { value: 'playwright' } });

    fireEvent.click(screen.getByTestId('button-primary'));

    await waitFor(() => {
      expect(mockInstallSkillFromGit).toHaveBeenCalledWith({
        repoUrl: 'https://github.com/openai/skills/tree/main/skills/.curated/playwright',
        commandName: 'playwright',
      });
    });
  });

  it('should show success toast and close after successful install', async () => {
    render(<InstallSkillFromGitDialog isOpen onClose={onClose} />);

    const urlInput = screen.getByPlaceholderText(
      'https://github.com/owner/repo/tree/main/skills/my-skill'
    );
    fireEvent.input(urlInput, {
      target: { value: 'https://github.com/openai/skills/tree/main/skills/.curated/playwright' },
    });

    fireEvent.click(screen.getByTestId('button-primary'));

    await waitFor(() => {
      expect(mockToastSuccess).toHaveBeenCalledWith('Installed "Playwright" from Git');
    });
    expect(onClose).toHaveBeenCalled();
  });

  it('should use skill.name as fallback when displayName is empty', async () => {
    mockInstallSkillFromGit.mockResolvedValueOnce(makeSkill({ displayName: '' }));
    render(<InstallSkillFromGitDialog isOpen onClose={onClose} />);

    const urlInput = screen.getByPlaceholderText(
      'https://github.com/owner/repo/tree/main/skills/my-skill'
    );
    fireEvent.input(urlInput, {
      target: { value: 'https://github.com/openai/skills/tree/main/skills/.curated/playwright' },
    });

    fireEvent.click(screen.getByTestId('button-primary'));

    await waitFor(() => {
      expect(mockToastSuccess).toHaveBeenCalledWith('Installed "playwright" from Git');
    });
  });

  it('should show error toast when install fails', async () => {
    mockInstallSkillFromGit.mockRejectedValueOnce(new Error('Network error'));
    render(<InstallSkillFromGitDialog isOpen onClose={onClose} />);

    const urlInput = screen.getByPlaceholderText(
      'https://github.com/owner/repo/tree/main/skills/my-skill'
    );
    fireEvent.input(urlInput, {
      target: { value: 'https://github.com/openai/skills/tree/main/skills/.curated/playwright' },
    });

    fireEvent.click(screen.getByTestId('button-primary'));

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith('Network error');
    });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('should NOT close on error — so the user can fix the URL', async () => {
    mockInstallSkillFromGit.mockRejectedValueOnce(new Error('Invalid URL'));
    render(<InstallSkillFromGitDialog isOpen onClose={onClose} />);

    const urlInput = screen.getByPlaceholderText(
      'https://github.com/owner/repo/tree/main/skills/my-skill'
    );
    fireEvent.input(urlInput, {
      target: { value: 'https://example.com/bad-skill' },
    });

    const nameInput = screen.getByPlaceholderText('e.g., playwright');
    fireEvent.input(nameInput, { target: { value: 'bad-skill' } });

    fireEvent.click(screen.getByTestId('button-primary'));

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalled();
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId('modal')).toBeTruthy();
  });

  it('should close when Cancel is clicked', () => {
    render(<InstallSkillFromGitDialog isOpen onClose={onClose} />);
    fireEvent.click(screen.getByTestId('button-secondary'));
    expect(onClose).toHaveBeenCalled();
  });

  it('should reset form on close', async () => {
    render(<InstallSkillFromGitDialog isOpen onClose={onClose} />);

    const urlInput = screen.getByPlaceholderText(
      'https://github.com/owner/repo/tree/main/skills/my-skill'
    );
    fireEvent.input(urlInput, { target: { value: 'https://example.com/skill' } });

    fireEvent.click(screen.getByTestId('button-secondary'));

    cleanup();
    render(<InstallSkillFromGitDialog isOpen onClose={onClose} />);

    const freshUrlInput = screen.getByPlaceholderText(
      'https://github.com/owner/repo/tree/main/skills/my-skill'
    );
    expect((freshUrlInput as HTMLInputElement).value).toBe('');
  });
});
