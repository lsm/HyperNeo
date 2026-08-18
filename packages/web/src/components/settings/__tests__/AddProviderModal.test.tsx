import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, waitFor, fireEvent } from '@testing-library/preact';

const { mockCreateProvider, mockLoginProvider, mockToastError, mockToastSuccess } = vi.hoisted(
  () => ({
    mockCreateProvider: vi.fn(),
    mockLoginProvider: vi.fn(),
    mockToastError: vi.fn(),
    mockToastSuccess: vi.fn(),
  })
);

vi.mock('../../../lib/api-helpers.ts', () => ({
  createProvider: (params: unknown, creds?: unknown) => mockCreateProvider(params, creds),
  loginProvider: (providerId: string) => mockLoginProvider(providerId),
  listCustomEndpointModels: vi.fn(),
}));

vi.mock('../../../lib/toast.ts', () => ({
  toast: {
    error: (msg: string) => mockToastError(msg),
    success: (msg: string) => mockToastSuccess(msg),
    info: vi.fn(),
    warning: vi.fn(),
  },
}));

vi.mock('../OAuthModal.tsx', () => ({
  OAuthModal: ({ onCancel, onComplete }: { onCancel: () => void; onComplete: () => void }) => (
    <div data-testid="oauth-modal">
      <button data-testid="oauth-cancel-btn" onClick={onCancel}>
        Cancel
      </button>
      <button data-testid="oauth-complete-btn" onClick={onComplete}>
        Complete
      </button>
    </div>
  ),
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

vi.mock('../CustomEndpointEditor.tsx', () => ({
  EditorModal: () => <div data-testid="editor-modal">Editor</div>,
  PresetPicker: () => <div data-testid="preset-picker">Presets</div>,
  presetToEditor: vi.fn(),
  editorToConfig: vi.fn(),
  validateEditor: vi.fn(() => null),
  testCustomEndpoint: vi.fn(),
}));

import { AddProviderModal } from '../AddProviderModal.tsx';

describe('AddProviderModal', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders quick-add provider cards', async () => {
    render(
      <AddProviderModal existingProviderIds={[]} onClose={() => {}} onProviderAdded={() => {}} />
    );
    await waitFor(() => {
      expect(screen.getByText('Anthropic')).toBeTruthy();
      expect(screen.getByText('OpenAI Codex')).toBeTruthy();
      expect(screen.getByText('OpenRouter')).toBeTruthy();
      expect(screen.getByText('Ollama')).toBeTruthy();
    });
  });

  it('shows already-added state for existing providers', async () => {
    render(
      <AddProviderModal
        existingProviderIds={['anthropic']}
        onClose={() => {}}
        onProviderAdded={() => {}}
      />
    );
    await waitFor(() => {
      expect(screen.getByText('Already added')).toBeTruthy();
    });
  });

  it('creates API key provider on add', async () => {
    mockCreateProvider.mockResolvedValue({
      success: true,
      provider: { id: '1', providerId: 'anthropic' },
    });
    const onProviderAdded = vi.fn();
    const onClose = vi.fn();

    render(
      <AddProviderModal
        existingProviderIds={[]}
        onClose={onClose}
        onProviderAdded={onProviderAdded}
      />
    );
    await waitFor(() => screen.getByText('Anthropic'));

    const input = screen.getAllByPlaceholderText('API key')[0] as HTMLInputElement;
    fireEvent.input(input, { target: { value: 'sk-test' } });

    const addButton = screen.getAllByText('Add')[0];
    fireEvent.click(addButton);

    await waitFor(() => {
      expect(mockCreateProvider).toHaveBeenCalledWith(
        expect.objectContaining({ providerId: 'anthropic', kind: 'built_in' }),
        { apiKey: 'sk-test' }
      );
      expect(mockToastSuccess).toHaveBeenCalledWith('Anthropic added');
      expect(onProviderAdded).toHaveBeenCalled();
    });
  });

  it('shows error when API key is empty for key-based provider', async () => {
    render(
      <AddProviderModal existingProviderIds={[]} onClose={() => {}} onProviderAdded={() => {}} />
    );
    await waitFor(() => screen.getByText('Anthropic'));

    const addButton = screen.getAllByText('Add')[0];
    fireEvent.click(addButton);

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith('API key is required');
    });
  });

  it('initiates OAuth login before creating provider record', async () => {
    mockLoginProvider.mockResolvedValue({ success: true, authUrl: 'https://example.com/oauth' });
    mockCreateProvider.mockResolvedValue({
      success: true,
      provider: { id: '1', providerId: 'anthropic' },
    });
    const onProviderAdded = vi.fn();

    render(
      <AddProviderModal
        existingProviderIds={[]}
        onClose={() => {}}
        onProviderAdded={onProviderAdded}
      />
    );
    await waitFor(() => screen.getByText('OpenAI Codex'));

    const connectButton = screen.getAllByText('Connect')[0];
    fireEvent.click(connectButton);

    await waitFor(() => {
      expect(mockLoginProvider).toHaveBeenCalledWith('anthropic-codex');
      expect(mockCreateProvider).toHaveBeenCalledWith(
        expect.objectContaining({
          providerId: 'anthropic-codex',
          kind: 'built_in',
          authType: 'oauth',
        }),
        undefined
      );
      expect(onProviderAdded).toHaveBeenCalled();
    });

    await waitFor(() => {
      expect(screen.getByTestId('oauth-modal')).toBeTruthy();
    });
  });

  it('does not create provider record when OAuth login fails', async () => {
    mockLoginProvider.mockResolvedValue({ success: false, error: 'OAuth denied' });

    render(
      <AddProviderModal existingProviderIds={[]} onClose={() => {}} onProviderAdded={() => {}} />
    );
    await waitFor(() => screen.getByText('GitHub Copilot'));

    const connectButton = screen.getAllByText('Connect')[1];
    fireEvent.click(connectButton);

    await waitFor(() => {
      expect(mockLoginProvider).toHaveBeenCalledWith('anthropic-copilot');
      expect(mockToastError).toHaveBeenCalledWith('OAuth denied');
    });

    expect(mockCreateProvider).not.toHaveBeenCalled();
  });

  it('expands more providers section', async () => {
    render(
      <AddProviderModal existingProviderIds={[]} onClose={() => {}} onProviderAdded={() => {}} />
    );
    await waitFor(() => screen.getByText('More providers'));

    fireEvent.click(screen.getByText('More providers'));

    await waitFor(() => {
      expect(screen.getByText('Kimi')).toBeTruthy();
      expect(screen.getByText('MiniMax')).toBeTruthy();
    });
  });

  it('opens preset picker for custom endpoint', async () => {
    render(
      <AddProviderModal existingProviderIds={[]} onClose={() => {}} onProviderAdded={() => {}} />
    );
    await waitFor(() => screen.getByText('Custom endpoint'));

    fireEvent.click(screen.getByText('Custom endpoint'));

    await waitFor(() => {
      expect(screen.getByTestId('preset-picker')).toBeTruthy();
    });
  });
});
