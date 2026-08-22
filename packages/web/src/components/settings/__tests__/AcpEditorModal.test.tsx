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

    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByDisplayValue('devin acp')).toBeTruthy();
    expect(screen.getByText('devin-model-a')).toBeTruthy();
  });

  it('closes the dialog on Escape', () => {
    const onClose = vi.fn();
    render(
      <AcpEditorModal
        providerId="acp-1"
        providerName="ACP Agent"
        command="devin acp"
        models={[]}
        onClose={onClose}
        onSaved={() => {}}
      />
    );

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onClose).toHaveBeenCalled();
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

  it('preserves absent models on no-op save', async () => {
    mockUpdateProvider.mockResolvedValue({ success: true });

    render(
      <AcpEditorModal
        providerId="acp-1"
        providerName="ACP Agent"
        command="devin acp"
        onClose={() => {}}
        onSaved={() => {}}
      />
    );

    fireEvent.click(screen.getByText('Save changes'));

    await waitFor(() => {
      expect(mockUpdateProvider).toHaveBeenCalledWith('acp-1', {
        configJson: JSON.stringify({ command: 'devin acp' }),
      });
    });
  });

  it('preserves explicit empty models on no-op save', async () => {
    mockUpdateProvider.mockResolvedValue({ success: true });

    render(
      <AcpEditorModal
        providerId="acp-1"
        providerName="ACP Agent"
        command="devin acp"
        models={[]}
        onClose={() => {}}
        onSaved={() => {}}
      />
    );

    fireEvent.click(screen.getByText('Save changes'));

    await waitFor(() => {
      expect(mockUpdateProvider).toHaveBeenCalledWith('acp-1', {
        configJson: JSON.stringify({ command: 'devin acp', models: [] }),
      });
    });
  });

  it('preserves curated models for equivalent command formatting', async () => {
    mockUpdateProvider.mockResolvedValue({ success: true });

    render(
      <AcpEditorModal
        providerId="acp-1"
        providerName="ACP Agent"
        command="devin acp 'model one'"
        models={[{ id: 'existing-model' }]}
        onClose={() => {}}
        onSaved={() => {}}
      />
    );

    fireEvent.input(screen.getByDisplayValue("devin acp 'model one'"), {
      target: { value: 'devin  acp "model one"' },
    });
    fireEvent.click(screen.getByText('Save changes'));

    await waitFor(() => {
      expect(mockUpdateProvider).toHaveBeenCalledWith('acp-1', {
        configJson: JSON.stringify({
          command: 'devin  acp "model one"',
          models: [{ id: 'existing-model' }],
        }),
      });
    });
  });

  it('clears curated models when the command changes', async () => {
    mockUpdateProvider.mockResolvedValue({ success: true });

    render(
      <AcpEditorModal
        providerId="acp-1"
        providerName="ACP Agent"
        command="old acp"
        models={[{ id: 'old-model' }]}
        onClose={() => {}}
        onSaved={() => {}}
      />
    );

    fireEvent.input(screen.getByDisplayValue('old acp'), { target: { value: 'new acp' } });
    fireEvent.click(screen.getByText('Save changes'));

    await waitFor(() => {
      expect(mockUpdateProvider).toHaveBeenCalledWith('acp-1', {
        configJson: JSON.stringify({ command: 'new acp', models: [] }),
      });
    });
  });

  it('persists models fetched and selected for a changed command', async () => {
    mockFetchAcpModels.mockResolvedValue({
      models: [{ id: 'new-model', name: 'New Model' }],
    });
    mockUpdateProvider.mockResolvedValue({ success: true });

    render(
      <AcpEditorModal
        providerId="acp-1"
        providerName="ACP Agent"
        command="old acp"
        models={[{ id: 'old-model' }]}
        onClose={() => {}}
        onSaved={() => {}}
      />
    );

    fireEvent.input(screen.getByDisplayValue('old acp'), { target: { value: 'new acp' } });
    fireEvent.click(screen.getByText('Fetch models'));
    await waitFor(() => expect(screen.getByText('new-model')).toBeTruthy());
    fireEvent.click(screen.getByText('new-model'));
    fireEvent.click(screen.getByText('Add selected'));
    fireEvent.click(screen.getByText('Save changes'));

    await waitFor(() => {
      expect(mockUpdateProvider).toHaveBeenCalledWith('acp-1', {
        configJson: JSON.stringify({
          command: 'new acp',
          models: [{ id: 'new-model', name: 'New Model' }],
        }),
      });
    });
  });

  it('does not save fetched models after reverting to the original command', async () => {
    mockFetchAcpModels.mockResolvedValue({
      models: [{ id: 'new-model', name: 'New Model' }],
    });
    mockUpdateProvider.mockResolvedValue({ success: true });

    render(
      <AcpEditorModal
        providerId="acp-1"
        providerName="ACP Agent"
        command="old acp"
        models={[{ id: 'old-model' }]}
        onClose={() => {}}
        onSaved={() => {}}
      />
    );

    const commandInput = screen.getByDisplayValue('old acp');
    fireEvent.input(commandInput, { target: { value: 'new acp' } });
    fireEvent.click(screen.getByText('Fetch models'));
    await waitFor(() => expect(screen.getByText('new-model')).toBeTruthy());
    fireEvent.click(screen.getByText('new-model'));
    fireEvent.click(screen.getByText('Add selected'));
    fireEvent.input(commandInput, { target: { value: 'old acp' } });
    fireEvent.click(screen.getByText('Save changes'));

    await waitFor(() => {
      expect(mockUpdateProvider).toHaveBeenCalledWith('acp-1', {
        configJson: JSON.stringify({
          command: 'old acp',
          models: [{ id: 'old-model' }],
        }),
      });
    });
  });

  it('hides curated models from the list as soon as the command changes', async () => {
    mockUpdateProvider.mockResolvedValue({ success: true });

    render(
      <AcpEditorModal
        providerId="acp-1"
        providerName="ACP Agent"
        command="old acp"
        models={[{ id: 'old-model' }]}
        onClose={() => {}}
        onSaved={() => {}}
      />
    );

    expect(screen.getByText('old-model')).toBeTruthy();

    fireEvent.input(screen.getByDisplayValue('old acp'), { target: { value: 'new acp' } });

    expect(screen.queryByText('old-model')).toBeNull();
    expect(screen.getByText(/No models selected/)).toBeTruthy();
  });

  it('restores the initial model list in the display after reverting a fetched command', async () => {
    mockFetchAcpModels.mockResolvedValue({
      models: [{ id: 'fetch-model', name: 'Fetched Model' }],
    });

    render(
      <AcpEditorModal
        providerId="acp-1"
        providerName="ACP Agent"
        command="old acp"
        models={[{ id: 'old-model' }]}
        onClose={() => {}}
        onSaved={() => {}}
      />
    );

    const commandInput = screen.getByDisplayValue('old acp');
    fireEvent.input(commandInput, { target: { value: 'new acp' } });
    fireEvent.click(screen.getByText('Fetch models'));
    await waitFor(() => expect(screen.getByText('fetch-model')).toBeTruthy());
    fireEvent.click(screen.getByText('fetch-model'));
    fireEvent.click(screen.getByText('Add selected'));
    expect(screen.getByText('All fetched models are already added.')).toBeTruthy();

    fireEvent.input(commandInput, { target: { value: 'old acp' } });

    expect(screen.getByText('old-model')).toBeTruthy();
    expect(screen.queryByText('All fetched models are already added.')).toBeNull();
  });

  it('discards fetch results for a superseded command', async () => {
    let resolveFetch: (value: { models: Array<{ id: string }> }) => void = () => {};
    mockFetchAcpModels.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        })
    );

    render(
      <AcpEditorModal
        providerId="acp-1"
        providerName="ACP Agent"
        command="old acp"
        models={[]}
        onClose={() => {}}
        onSaved={() => {}}
      />
    );

    fireEvent.click(screen.getByText('Fetch models'));
    fireEvent.input(screen.getByDisplayValue('old acp'), { target: { value: 'new acp' } });

    resolveFetch({ models: [{ id: 'stale-model' }] });
    await waitFor(() => expect(mockFetchAcpModels).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(screen.queryByText('stale-model')).toBeNull();
    expect(screen.queryByText('1 model found')).toBeNull();
    expect(screen.queryByText('Failed to fetch models')).toBeNull();
  });

  it('removes a curated model and persists the removal', async () => {
    mockUpdateProvider.mockResolvedValue({ success: true });

    render(
      <AcpEditorModal
        providerId="acp-1"
        providerName="ACP Agent"
        command="devin acp"
        models={[{ id: 'keep-model' }, { id: 'drop-model' }]}
        onClose={() => {}}
        onSaved={() => {}}
      />
    );

    fireEvent.click(screen.getByLabelText('Remove drop-model'));

    expect(screen.queryByText('drop-model')).toBeNull();
    expect(screen.getByText('keep-model')).toBeTruthy();

    fireEvent.click(screen.getByText('Save changes'));

    await waitFor(() => {
      expect(mockUpdateProvider).toHaveBeenCalledWith('acp-1', {
        configJson: JSON.stringify({
          command: 'devin acp',
          models: [{ id: 'keep-model' }],
        }),
      });
    });
  });

  it('shows the save error and keeps the dialog open when updating fails', async () => {
    mockUpdateProvider.mockRejectedValue(new Error('Save exploded'));
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

    fireEvent.click(screen.getByText('Save changes'));

    await waitFor(() => expect(screen.getByText('Save exploded')).toBeTruthy());
    expect(onSaved).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeTruthy();
    const saveButton = screen.getByText('Save changes').closest('button');
    expect(saveButton?.hasAttribute('disabled')).toBe(false);
  });

  it('reports when discovery returns no models', async () => {
    mockFetchAcpModels.mockResolvedValue({ models: [] });

    render(
      <AcpEditorModal
        providerId="acp-1"
        providerName="ACP Agent"
        command="devin acp"
        models={[]}
        onClose={() => {}}
        onSaved={() => {}}
      />
    );

    fireEvent.click(screen.getByText('Fetch models'));

    await waitFor(() => {
      expect(screen.getByText('The ACP agent reported no models.')).toBeTruthy();
    });
    expect(screen.queryByText('All fetched models are already added.')).toBeNull();
  });

  it('shows fetch errors in the footer', async () => {
    mockFetchAcpModels.mockRejectedValue(new Error('Discovery failed'));

    render(
      <AcpEditorModal
        providerId="acp-1"
        providerName="ACP Agent"
        command="devin acp"
        models={[]}
        onClose={() => {}}
        onSaved={() => {}}
      />
    );

    fireEvent.click(screen.getByText('Fetch models'));

    await waitFor(() => expect(screen.getByText('Discovery failed')).toBeTruthy());
  });

  it('clears a stored command to restore the environment fallback on save', async () => {
    mockUpdateProvider.mockResolvedValue({ success: true });

    render(
      <AcpEditorModal
        providerId="acp-1"
        providerName="ACP Agent"
        command="devin acp"
        models={[{ id: 'old-model' }]}
        onClose={() => {}}
        onSaved={() => {}}
      />
    );

    fireEvent.input(screen.getByDisplayValue('devin acp'), { target: { value: '' } });
    fireEvent.click(screen.getByText('Save changes'));

    await waitFor(() => {
      expect(mockUpdateProvider).toHaveBeenCalledWith('acp-1', {
        configJson: JSON.stringify({ models: [] }),
      });
    });
  });

  it('fetches through the environment command after clearing a stored command', async () => {
    mockFetchAcpModels.mockResolvedValue({ models: [{ id: 'env-model' }] });

    render(
      <AcpEditorModal
        providerId="acp-1"
        providerName="ACP Agent"
        command="devin acp"
        models={[]}
        onClose={() => {}}
        onSaved={() => {}}
      />
    );

    fireEvent.input(screen.getByDisplayValue('devin acp'), { target: { value: '' } });
    fireEvent.click(screen.getByText('Fetch models'));

    await waitFor(() => {
      expect(mockFetchAcpModels).toHaveBeenCalledWith('acp-1', '');
      expect(screen.getByText('env-model')).toBeTruthy();
    });
  });

  it('fetches models through the environment command for env-backed providers', async () => {
    mockFetchAcpModels.mockResolvedValue({
      models: [{ id: 'env-model-a', name: 'Env Model A' }],
    });
    mockUpdateProvider.mockResolvedValue({ success: true });
    const onSaved = vi.fn();

    render(
      <AcpEditorModal
        providerId="acp-1"
        providerName="ACP Agent"
        command=""
        models={[]}
        envBacked
        onClose={() => {}}
        onSaved={onSaved}
      />
    );

    fireEvent.click(screen.getByText('Fetch models'));
    await waitFor(() => {
      expect(mockFetchAcpModels).toHaveBeenCalledWith('acp-1', '');
      expect(screen.getByText('env-model-a')).toBeTruthy();
    });

    fireEvent.click(screen.getByText('env-model-a'));
    fireEvent.click(screen.getByText('Add selected'));
    fireEvent.click(screen.getByText('Save changes'));

    await waitFor(() => {
      expect(mockUpdateProvider).toHaveBeenCalledWith('acp-1', {
        configJson: JSON.stringify({ models: [{ id: 'env-model-a', name: 'Env Model A' }] }),
      });
      expect(onSaved).toHaveBeenCalled();
    });
  });

  it('saves env-backed providers without persisting an empty command', async () => {
    mockUpdateProvider.mockResolvedValue({ success: true });

    render(
      <AcpEditorModal
        providerId="acp-1"
        providerName="ACP Agent"
        command=""
        models={[{ id: 'env-model-a' }]}
        envBacked
        onClose={() => {}}
        onSaved={() => {}}
      />
    );

    fireEvent.click(screen.getByText('Save changes'));

    await waitFor(() => {
      expect(mockUpdateProvider).toHaveBeenCalledWith('acp-1', {
        configJson: JSON.stringify({ models: [{ id: 'env-model-a' }] }),
      });
    });
  });
});
