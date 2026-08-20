import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, waitFor, fireEvent } from '@testing-library/preact';

const { mockUpdateProvider, mockFetchAcpModels, mockToastError, mockToastSuccess } = vi.hoisted(
  () => ({
    mockUpdateProvider: vi.fn(),
    mockFetchAcpModels: vi.fn(),
    mockToastError: vi.fn(),
    mockToastSuccess: vi.fn(),
  })
);

vi.mock('../../../lib/api-helpers.ts', () => ({
  updateProvider: (id: string, params: unknown) => mockUpdateProvider(id, params),
  fetchAcpModels: (id: string, command?: string) => mockFetchAcpModels(id, command),
}));

vi.mock('../../../lib/toast.ts', () => ({
  toast: {
    error: (msg: string) => mockToastError(msg),
    success: (msg: string) => mockToastSuccess(msg),
    info: vi.fn(),
    warning: vi.fn(),
  },
}));

vi.mock('../../ui/Button.tsx', () => ({
  Button: ({
    children,
    variant,
    onClick,
    disabled,
    loading,
  }: {
    children: import('preact').ComponentChildren;
    variant?: string;
    onClick?: () => void;
    disabled?: boolean;
    loading?: boolean;
  }) => (
    <button
      data-testid={`button-${variant || 'primary'}`}
      disabled={disabled || loading}
      onClick={onClick}
    >
      {loading && <span data-testid="button-loading">Loading...</span>}
      {children}
    </button>
  ),
}));

import { AcpEditorModal } from '../AcpEditorModal.tsx';

describe('AcpEditorModal', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders command and existing curated models', () => {
    render(
      <AcpEditorModal
        providerId="acp-1"
        providerName="ACP Agent"
        command="devin acp"
        models={[{ id: 'devin-model-a', name: 'Model A' }]}
        onClose={() => {}}
        onSaved={() => {}}
      />
    );

    expect(screen.getByDisplayValue('devin acp')).toBeTruthy();
    expect(screen.getByText('devin-model-a')).toBeTruthy();
  });

  it('fetches models and adds the selected ones on save', async () => {
    mockFetchAcpModels.mockResolvedValue({
      models: [
        { id: 'devin-model-a', name: 'Model A' },
        { id: 'devin-model-b', name: 'Model B' },
      ],
    });
    mockUpdateProvider.mockResolvedValue({ success: true });
    const onSaved = vi.fn();

    render(
      <AcpEditorModal
        providerId="acp-1"
        providerName="ACP Agent"
        command="devin acp"
        models={[]}
        onClose={() => {}}
        onSaved={onSaved}
      />
    );

    fireEvent.click(screen.getByText('Fetch models'));
    await waitFor(() => {
      expect(mockFetchAcpModels).toHaveBeenCalledWith('acp-1', 'devin acp');
      expect(screen.getByText('devin-model-a')).toBeTruthy();
    });

    fireEvent.click(screen.getByText('devin-model-b'));
    fireEvent.click(screen.getByText('Add selected'));

    fireEvent.click(screen.getByText('Save changes'));
    await waitFor(() => {
      expect(mockUpdateProvider).toHaveBeenCalledWith('acp-1', {
        configJson: JSON.stringify({
          command: 'devin acp',
          models: [{ id: 'devin-model-b', name: 'Model B' }],
        }),
      });
      expect(mockToastSuccess).toHaveBeenCalledWith('ACP Agent updated');
      expect(onSaved).toHaveBeenCalled();
    });
  });

  it('shows error when ACP command is empty on save', async () => {
    render(
      <AcpEditorModal
        providerId="acp-1"
        providerName="ACP Agent"
        command=""
        models={[]}
        onClose={() => {}}
        onSaved={() => {}}
      />
    );

    fireEvent.click(screen.getByText('Save changes'));

    await waitFor(() => {
      expect(screen.getByText('ACP command is required')).toBeTruthy();
      expect(mockUpdateProvider).not.toHaveBeenCalled();
    });
  });
});
