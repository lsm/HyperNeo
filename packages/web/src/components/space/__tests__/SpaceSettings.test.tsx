// @ts-nocheck

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, waitFor, cleanup } from '@testing-library/preact';

const mockRequest = vi.fn();
const mockGetHubIfConnected = vi.fn();
const mockNavigateToSpaces = vi.fn();
const mockToastSuccess = vi.fn();
const mockToastError = vi.fn();
const mockDownloadBundle = vi.fn();

vi.mock('../../../lib/connection-manager', () => ({
  connectionManager: {
    get getHubIfConnected() {
      return mockGetHubIfConnected;
    },
  },
}));

vi.mock('../../../lib/router', () => ({
  get navigateToSpaces() {
    return mockNavigateToSpaces;
  },
}));

vi.mock('../../../lib/toast', () => ({
  toast: {
    get success() {
      return mockToastSuccess;
    },
    get error() {
      return mockToastError;
    },
  },
}));

vi.mock('../export-import-utils', () => ({
  downloadBundle: (...args) => mockDownloadBundle(...args),
}));

vi.mock('../SpaceExternalEventsSettings', () => ({
  SpaceExternalEventsSettings: ({ spaceId }) => (
    <div data-testid="space-external-events-settings">External events for {spaceId}</div>
  ),
}));

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
      <option value="claude-opus-4">Claude Opus 4</option>
    </select>
  ),
}));

vi.mock('../../ui/Button', () => ({
  Button: ({ children, onClick, type, loading, disabled, variant }) => (
    <button
      type={type ?? 'button'}
      onClick={onClick}
      disabled={disabled || loading}
      data-variant={variant}
    >
      {loading ? 'Loading...' : children}
    </button>
  ),
}));

import { SpaceSettings } from '../SpaceSettings';
import type { Space } from '@hyperneo/shared';

function makeSpace(overrides: Partial<Space> = {}): Space {
  return {
    id: 'space-1',
    name: 'My Space',
    workspacePath: '/projects/my-space',
    description: 'Original description',
    instructions: 'Use TypeScript strict mode',
    backgroundContext: '',
    autonomyLevel: 1,
    maxConcurrentTasks: 1,
    sessionIds: [],
    status: 'active',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

const mockConfirm = vi.fn();
beforeEach(() => {
  (globalThis as unknown as { confirm: unknown }).confirm = mockConfirm;
});

describe('SpaceSettings', () => {
  beforeEach(() => {
    cleanup();
    mockRequest.mockReset();
    mockGetHubIfConnected.mockReset();
    mockNavigateToSpaces.mockReset();
    mockToastSuccess.mockReset();
    mockToastError.mockReset();
    mockConfirm.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders space name and description', () => {
    const space = makeSpace();
    const { getByDisplayValue, getByText } = render(<SpaceSettings space={space} />);
    expect(getByDisplayValue('My Space')).toBeTruthy();
    expect(getByDisplayValue('Original description')).toBeTruthy();
  });

  it('renders workspace path as read-only text', () => {
    const space = makeSpace();
    const { getByText } = render(<SpaceSettings space={space} />);
    expect(getByText('/projects/my-space')).toBeTruthy();
  });

  it('does not show Save Changes button when form is clean', () => {
    const space = makeSpace();
    const { queryByText } = render(<SpaceSettings space={space} />);
    expect(queryByText('Save Changes')).toBeNull();
  });

  it('shows Save Changes button when name is changed', () => {
    const space = makeSpace();
    const { getByDisplayValue, getByText } = render(<SpaceSettings space={space} />);
    fireEvent.input(getByDisplayValue('My Space'), { target: { value: 'New Name' } });
    expect(getByText('Save Changes')).toBeTruthy();
  });

  it('calls space.update with trimmed values on save', async () => {
    mockGetHubIfConnected.mockReturnValue({ request: mockRequest });
    mockRequest.mockResolvedValue({});

    const space = makeSpace();
    const { getByDisplayValue, getByText } = render(<SpaceSettings space={space} />);

    fireEvent.input(getByDisplayValue('My Space'), { target: { value: '  Updated Name  ' } });
    fireEvent.click(getByText('Save Changes'));

    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith('space.update', {
        id: 'space-1',
        name: 'Updated Name',
        description: 'Original description',
        instructions: 'Use TypeScript strict mode',
        backgroundContext: undefined,
        autonomyLevel: 1,
        maxConcurrentTasks: 1,
        defaultModel: null,
      });
    });
  });

  it('shows toast on successful save', async () => {
    mockGetHubIfConnected.mockReturnValue({ request: mockRequest });
    mockRequest.mockResolvedValue({});

    const space = makeSpace();
    const { getByDisplayValue, getByText } = render(<SpaceSettings space={space} />);
    fireEvent.input(getByDisplayValue('My Space'), { target: { value: 'Changed' } });
    fireEvent.click(getByText('Save Changes'));

    await waitFor(() => {
      expect(mockToastSuccess).toHaveBeenCalledWith('Space updated');
    });
  });

  it('Discard resets form to original values', () => {
    const space = makeSpace();
    const { getByDisplayValue, getByText, queryByText } = render(<SpaceSettings space={space} />);
    fireEvent.input(getByDisplayValue('My Space'), { target: { value: 'Changed' } });
    expect(getByText('Discard')).toBeTruthy();

    fireEvent.click(getByText('Discard'));
    expect(queryByText('Save Changes')).toBeNull();
    expect((getByDisplayValue('My Space') as HTMLInputElement).value).toBe('My Space');
  });

  it('shows error when not connected on save', async () => {
    mockGetHubIfConnected.mockReturnValue(null);
    const space = makeSpace();
    const { getByDisplayValue, getByText, findByText } = render(<SpaceSettings space={space} />);
    fireEvent.input(getByDisplayValue('My Space'), { target: { value: 'Changed' } });
    fireEvent.click(getByText('Save Changes'));
    expect(await findByText('Not connected to server')).toBeTruthy();
  });

  it('calls space.archive and navigates on confirm', async () => {
    mockConfirm.mockReturnValue(true);
    mockGetHubIfConnected.mockReturnValue({ request: mockRequest });
    mockRequest.mockResolvedValue({});

    const space = makeSpace();
    const { getByText } = render(<SpaceSettings space={space} />);
    fireEvent.click(getByText('Archive'));

    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith('space.archive', { id: 'space-1' });
      expect(mockNavigateToSpaces).toHaveBeenCalled();
    });
  });

  it('does not archive when confirm is dismissed', async () => {
    mockConfirm.mockReturnValue(false);
    const space = makeSpace();
    const { getByText } = render(<SpaceSettings space={space} />);
    fireEvent.click(getByText('Archive'));
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it('Archive button is disabled when space is already archived', () => {
    const space = makeSpace({ status: 'archived' });
    const { getByText } = render(<SpaceSettings space={space} />);
    const archiveBtn = getByText('Archive').closest('button')!;
    expect(archiveBtn.disabled).toBe(true);
  });

  it('calls space.delete and navigates on confirm', async () => {
    mockConfirm.mockReturnValue(true);
    mockGetHubIfConnected.mockReturnValue({ request: mockRequest });
    mockRequest.mockResolvedValue({});

    const space = makeSpace();
    const { getByText } = render(<SpaceSettings space={space} />);
    fireEvent.click(getByText('Delete'));

    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith('space.delete', { id: 'space-1' });
      expect(mockNavigateToSpaces).toHaveBeenCalled();
    });
  });

  it('does not delete when confirm is dismissed', async () => {
    mockConfirm.mockReturnValue(false);
    const space = makeSpace();
    const { getByText } = render(<SpaceSettings space={space} />);
    fireEvent.click(getByText('Delete'));
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it('shows validation error when saving with empty name', async () => {
    mockGetHubIfConnected.mockReturnValue({ request: mockRequest });
    const space = makeSpace();
    const { getByDisplayValue, getByText, findByText } = render(<SpaceSettings space={space} />);
    fireEvent.input(getByDisplayValue('My Space'), { target: { value: '' } });
    fireEvent.click(getByText('Save Changes'));
    expect(await findByText('Space name is required')).toBeTruthy();
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it('Archive button is disabled during archiving', async () => {
    mockConfirm.mockReturnValue(true);
    let resolveArchive: () => void;
    const archivePromise = new Promise<{}>((res) => {
      resolveArchive = () => res({});
    });
    mockGetHubIfConnected.mockReturnValue({ request: mockRequest });
    mockRequest.mockReturnValue(archivePromise);

    const space = makeSpace();
    const { getByText } = render(<SpaceSettings space={space} />);
    fireEvent.click(getByText('Archive'));

    await waitFor(() => {
      const btn = getByText('Loading...').closest('button')!;
      expect(btn.disabled).toBe(true);
    });

    resolveArchive!();
  });

  it('Delete button is disabled during deletion', async () => {
    mockConfirm.mockReturnValue(true);
    let resolveDelete: () => void;
    const deletePromise = new Promise<{}>((res) => {
      resolveDelete = () => res({});
    });
    mockGetHubIfConnected.mockReturnValue({ request: mockRequest });
    mockRequest.mockReturnValue(deletePromise);

    const space = makeSpace();
    const { getByText } = render(<SpaceSettings space={space} />);
    fireEvent.click(getByText('Delete'));

    await waitFor(() => {
      const btns = document.querySelectorAll('button[disabled]');
      expect(btns.length).toBeGreaterThan(0);
    });

    resolveDelete!();
  });

  it('renders instructions and backgroundContext textareas', () => {
    const space = makeSpace({
      backgroundContext: 'Bun + Hono backend',
    });
    const { getByDisplayValue, getByText } = render(<SpaceSettings space={space} />);
    expect(getByDisplayValue('Use TypeScript strict mode')).toBeTruthy();
    expect(getByDisplayValue('Bun + Hono backend')).toBeTruthy();
    expect(getByText('Instructions')).toBeTruthy();
    expect(getByText('Background context', { exact: false })).toBeTruthy();
  });

  it('shows Save Changes when instructions is changed', () => {
    const space = makeSpace();
    const { getByPlaceholderText, getByText } = render(<SpaceSettings space={space} />);
    fireEvent.input(
      getByPlaceholderText(
        'e.g. Always use TypeScript strict mode. Prefer functional components...'
      ),
      { target: { value: 'New instructions' } }
    );
    expect(getByText('Save Changes')).toBeTruthy();
  });

  it('shows Save Changes when backgroundContext is changed', () => {
    const space = makeSpace();
    const { getByPlaceholderText, getByText } = render(<SpaceSettings space={space} />);
    fireEvent.input(
      getByPlaceholderText(
        'e.g. This project uses Bun + Hono backend, Preact frontend with Tailwind CSS...'
      ),
      { target: { value: 'New context' } }
    );
    expect(getByText('Save Changes')).toBeTruthy();
  });

  it('includes instructions and backgroundContext in space.update payload', async () => {
    mockGetHubIfConnected.mockReturnValue({ request: mockRequest });
    mockRequest.mockResolvedValue({});

    const space = makeSpace();
    const { getByDisplayValue, getByPlaceholderText, getByText } = render(
      <SpaceSettings space={space} />
    );

    fireEvent.input(getByDisplayValue('My Space'), { target: { value: 'Updated' } });
    fireEvent.input(
      getByPlaceholderText(
        'e.g. Always use TypeScript strict mode. Prefer functional components...'
      ),
      { target: { value: '  Use strict mode  ' } }
    );
    fireEvent.input(
      getByPlaceholderText(
        'e.g. This project uses Bun + Hono backend, Preact frontend with Tailwind CSS...'
      ),
      { target: { value: '  Bun + Hono  ' } }
    );
    fireEvent.click(getByText('Save Changes'));

    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith('space.update', {
        id: 'space-1',
        name: 'Updated',
        description: 'Original description',
        instructions: 'Use strict mode',
        backgroundContext: 'Bun + Hono',
        autonomyLevel: 1,
        maxConcurrentTasks: 1,
        defaultModel: null,
      });
    });
  });

  it('Discard resets instructions and backgroundContext to original values', () => {
    const space = makeSpace({
      instructions: 'Original instructions',
      backgroundContext: 'Original context',
    });
    const { getByDisplayValue, getByText, queryByText } = render(<SpaceSettings space={space} />);

    fireEvent.input(getByDisplayValue('Original instructions'), {
      target: { value: 'Changed instructions' },
    });
    expect(getByText('Save Changes')).toBeTruthy();

    fireEvent.click(getByText('Discard'));
    expect(queryByText('Save Changes')).toBeNull();
    expect(getByDisplayValue('Original instructions')).toBeTruthy();
    expect(getByDisplayValue('Original context')).toBeTruthy();
  });

  it('shows character count for instructions and backgroundContext', () => {
    const space = makeSpace({
      instructions: 'hello',
      backgroundContext: 'world!',
    });
    const { getByText } = render(<SpaceSettings space={space} />);
    expect(getByText('5 characters')).toBeTruthy();
    expect(getByText('6 characters')).toBeTruthy();
  });

  it('calls spaceExport.bundle when Export Bundle is clicked', async () => {
    mockGetHubIfConnected.mockReturnValue({ request: mockRequest });
    mockRequest.mockResolvedValue({ bundle: { version: '1', spaces: [] } });

    const space = makeSpace();
    const { getByText } = render(<SpaceSettings space={space} />);
    fireEvent.click(getByText('Export Bundle'));

    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith('spaceExport.bundle', { spaceId: 'space-1' });
    });
  });

  describe('Concurrent Tasks', () => {
    it('renders concurrency slider with current value', () => {
      const space = makeSpace({ maxConcurrentTasks: 3 });
      const { container, getByTestId } = render(<SpaceSettings space={space} />);
      expect(getByTestId('concurrent-tasks-value').textContent).toBe('3');
      expect(container.querySelector('[data-testid="concurrent-tasks-slider"]')).toBeTruthy();
    });

    it('shows Save Changes when concurrency is changed', () => {
      const space = makeSpace({ maxConcurrentTasks: 1 });
      const { getByTestId, getByText } = render(<SpaceSettings space={space} />);
      fireEvent.input(getByTestId('concurrent-tasks-slider'), { target: { value: '5' } });
      expect(getByText('Save Changes')).toBeTruthy();
    });

    it('includes maxConcurrentTasks in save payload', async () => {
      mockGetHubIfConnected.mockReturnValue({ request: mockRequest });
      mockRequest.mockResolvedValue({});

      const space = makeSpace({ maxConcurrentTasks: 1 });
      const { getByTestId, getByText } = render(<SpaceSettings space={space} />);
      fireEvent.input(getByTestId('concurrent-tasks-slider'), { target: { value: '4' } });
      fireEvent.click(getByText('Save Changes'));

      await waitFor(() => {
        expect(mockRequest).toHaveBeenCalledWith(
          'space.update',
          expect.objectContaining({ maxConcurrentTasks: 4 })
        );
      });
    });

    it('Discard resets concurrency to original value', () => {
      const space = makeSpace({ maxConcurrentTasks: 2 });
      const { getByTestId, getByText, queryByText } = render(<SpaceSettings space={space} />);
      fireEvent.input(getByTestId('concurrent-tasks-slider'), { target: { value: '8' } });
      expect(getByText('Save Changes')).toBeTruthy();

      fireEvent.click(getByText('Discard'));
      expect(queryByText('Save Changes')).toBeNull();
      expect(getByTestId('concurrent-tasks-value').textContent).toBe('2');
    });
  });
});
