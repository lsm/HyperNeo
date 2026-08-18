// @ts-nocheck

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, waitFor, cleanup } from '@testing-library/preact';

const mockRequest = vi.fn();
const mockGetHubIfConnected = vi.fn();
const mockNavigateToSpace = vi.fn();

vi.mock('../../../lib/connection-manager', () => ({
  connectionManager: {
    get getHubIfConnected() {
      return mockGetHubIfConnected;
    },
  },
}));

vi.mock('../../../lib/router', () => ({
  get navigateToSpace() {
    return mockNavigateToSpace;
  },
}));

vi.mock('../../../lib/utils', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}));

vi.mock('../../../lib/runtime-capabilities', () => ({
  hasNativeFolderPicker: vi.fn(() => false),
  NATIVE_FOLDER_PICKER_TIMEOUT_MS: 605000,
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

import {
  hasNativeFolderPicker,
  NATIVE_FOLDER_PICKER_TIMEOUT_MS,
} from '../../../lib/runtime-capabilities';
import { SpaceCreateDialog } from '../SpaceCreateDialog';

const SPACE_MOCK = {
  id: 'space-abc',
  slug: 'my-app',
  name: 'my-app',
  workspacePath: '/projects/my-app',
  description: '',
  backgroundContext: '',
  sessionIds: [],
  status: 'active' as const,
  createdAt: Date.now(),
  updatedAt: Date.now(),
};

describe('SpaceCreateDialog', () => {
  let onClose: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    cleanup();
    onClose = vi.fn();
    mockRequest.mockReset();
    mockGetHubIfConnected.mockReset();
    mockNavigateToSpace.mockReset();
    vi.mocked(hasNativeFolderPicker).mockReturnValue(false);
  });

  afterEach(() => {
    cleanup();
  });

  it('renders nothing when isOpen is false', () => {
    const { container } = render(<SpaceCreateDialog isOpen={false} onClose={onClose} />);
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it('renders dialog when isOpen is true', () => {
    const { getByRole } = render(<SpaceCreateDialog isOpen={true} onClose={onClose} />);
    expect(getByRole('dialog')).toBeTruthy();
  });

  it('shows workspace path input with required indicator', () => {
    const { getByPlaceholderText, getByText } = render(
      <SpaceCreateDialog isOpen={true} onClose={onClose} />
    );
    expect(getByPlaceholderText('/Users/you/projects/my-app')).toBeTruthy();
    expect(getByText('Workspace Path')).toBeTruthy();
    expect(getByText('*')).toBeTruthy();
  });

  it('hides browse button when native folder picker is unavailable', () => {
    const { queryByText } = render(<SpaceCreateDialog isOpen={true} onClose={onClose} />);
    expect(queryByText('Browse')).toBeNull();
  });

  it('populates workspace path from browse selection', async () => {
    vi.mocked(hasNativeFolderPicker).mockReturnValue(true);
    mockGetHubIfConnected.mockReturnValue({ request: mockRequest });
    mockRequest.mockResolvedValue({ path: '/projects/picked-app' });

    const { getByPlaceholderText, getByText } = render(
      <SpaceCreateDialog isOpen={true} onClose={onClose} />
    );
    fireEvent.click(getByText('Browse'));

    const pathInput = getByPlaceholderText('/Users/you/projects/my-app') as HTMLInputElement;
    const nameInput = getByPlaceholderText('e.g., My App') as HTMLInputElement;

    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith('dialog.pickFolder', undefined, {
        timeout: NATIVE_FOLDER_PICKER_TIMEOUT_MS,
      });
      expect(pathInput.value).toBe('/projects/picked-app');
      expect(nameInput.value).toBe('picked-app');
    });
  });

  it('auto-suggests name from workspace path', () => {
    const { getByPlaceholderText } = render(<SpaceCreateDialog isOpen={true} onClose={onClose} />);
    const pathInput = getByPlaceholderText('/Users/you/projects/my-app');
    fireEvent.input(pathInput, { target: { value: '/projects/my-cool-app' } });

    const nameInput = getByPlaceholderText('e.g., My App') as HTMLInputElement;
    expect(nameInput.value).toBe('my-cool-app');
  });

  it('does not override name when user has already typed it', () => {
    const { getByPlaceholderText } = render(<SpaceCreateDialog isOpen={true} onClose={onClose} />);
    const nameInput = getByPlaceholderText('e.g., My App') as HTMLInputElement;
    fireEvent.input(nameInput, { target: { value: 'Custom Name' } });

    const pathInput = getByPlaceholderText('/Users/you/projects/my-app');
    fireEvent.input(pathInput, { target: { value: '/projects/different-dir' } });

    expect(nameInput.value).toBe('Custom Name');
  });

  it('shows validation error when workspace path is empty', async () => {
    mockGetHubIfConnected.mockReturnValue({ request: mockRequest });
    const { getByRole, findByText } = render(<SpaceCreateDialog isOpen={true} onClose={onClose} />);
    const form = getByRole('dialog').querySelector('form');
    fireEvent.submit(form!);
    expect(await findByText('Workspace path is required')).toBeTruthy();
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it('shows error when not connected', async () => {
    mockGetHubIfConnected.mockReturnValue(null);
    const { getByPlaceholderText, getByRole, findByText } = render(
      <SpaceCreateDialog isOpen={true} onClose={onClose} />
    );
    const pathInput = getByPlaceholderText('/Users/you/projects/my-app');
    fireEvent.input(pathInput, { target: { value: '/projects/foo' } });

    const form = getByRole('dialog').querySelector('form');
    fireEvent.submit(form!);

    expect(await findByText('Not connected to server')).toBeTruthy();
  });

  it('calls space.create RPC on submit with correct params', async () => {
    mockGetHubIfConnected.mockReturnValue({ request: mockRequest });
    mockRequest.mockResolvedValue(SPACE_MOCK);

    const { getByPlaceholderText, getByRole } = render(
      <SpaceCreateDialog isOpen={true} onClose={onClose} />
    );

    fireEvent.input(getByPlaceholderText('/Users/you/projects/my-app'), {
      target: { value: '/projects/my-app' },
    });

    const form = getByRole('dialog').querySelector('form');
    fireEvent.submit(form!);

    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith('space.create', {
        workspacePath: '/projects/my-app',
        name: 'my-app',
        description: undefined,
      });
    });
  });

  it('navigates to new space and closes on success', async () => {
    mockGetHubIfConnected.mockReturnValue({ request: mockRequest });
    mockRequest.mockResolvedValue(SPACE_MOCK);

    const { getByPlaceholderText, getByRole } = render(
      <SpaceCreateDialog isOpen={true} onClose={onClose} />
    );

    fireEvent.input(getByPlaceholderText('/Users/you/projects/my-app'), {
      target: { value: '/projects/my-app' },
    });

    const form = getByRole('dialog').querySelector('form');
    fireEvent.submit(form!);

    await waitFor(() => {
      expect(mockNavigateToSpace).toHaveBeenCalledWith('my-app');
      expect(onClose).toHaveBeenCalled();
    });
  });

  it('shows error message when space.create fails', async () => {
    mockGetHubIfConnected.mockReturnValue({ request: mockRequest });
    mockRequest.mockRejectedValue(new Error('Workspace path does not exist'));

    const { getByPlaceholderText, getByRole, findByText } = render(
      <SpaceCreateDialog isOpen={true} onClose={onClose} />
    );

    fireEvent.input(getByPlaceholderText('/Users/you/projects/my-app'), {
      target: { value: '/projects/nonexistent' },
    });

    const form = getByRole('dialog').querySelector('form');
    fireEvent.submit(form!);

    expect(await findByText('Workspace path does not exist')).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('calls onClose when Cancel is clicked', () => {
    const { getByText } = render(<SpaceCreateDialog isOpen={true} onClose={onClose} />);
    fireEvent.click(getByText('Cancel'));
    expect(onClose).toHaveBeenCalled();
  });

  it('includes description in RPC call when provided', async () => {
    mockGetHubIfConnected.mockReturnValue({ request: mockRequest });
    mockRequest.mockResolvedValue(SPACE_MOCK);

    const { getByPlaceholderText, getByRole } = render(
      <SpaceCreateDialog isOpen={true} onClose={onClose} />
    );

    fireEvent.input(getByPlaceholderText('/Users/you/projects/my-app'), {
      target: { value: '/projects/my-app' },
    });

    fireEvent.input(getByPlaceholderText('Briefly describe the purpose of this space...'), {
      target: { value: 'My project description' },
    });

    const form = getByRole('dialog').querySelector('form');
    fireEvent.submit(form!);

    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith(
        'space.create',
        expect.objectContaining({
          description: 'My project description',
        })
      );
    });
  });
});
