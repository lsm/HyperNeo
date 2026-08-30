// @ts-nocheck

import type { ModelInfo } from '@hyperneo/shared';
import { act, cleanup, fireEvent, render } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NewChatModelPicker } from '../NewChatModelPicker';

const mockGetHubIfConnected = vi.fn(() => null);

vi.mock('../../lib/connection-manager', () => ({
  connectionManager: {
    getHubIfConnected: () => mockGetHubIfConnected(),
  },
}));

const { mockConnectionState } = vi.hoisted(() => {
  const obj = { value: 'connected' };
  return { mockConnectionState: obj };
});

vi.mock('../../lib/state', () => ({
  connectionState: mockConnectionState,
}));

function makeModel(id: string, provider: string, name: string): ModelInfo {
  return { id, alias: id, name, family: 'sonnet', provider } as ModelInfo;
}

function makeHub(providers: Array<Record<string, unknown>>) {
  return {
    request: vi.fn().mockImplementation((method: string) => {
      if (method === 'auth.providers') {
        return Promise.resolve({ providers });
      }
      return Promise.resolve(null);
    }),
    onEvent: vi.fn(() => () => {}),
    onConnection: vi.fn(() => () => {}),
    isConnected: vi.fn(() => true),
  };
}

describe('NewChatModelPicker', () => {
  const onSelectModel = vi.fn();

  const anthropicModels: ModelInfo[] = [
    makeModel('model-alpha', 'anthropic', 'Model Alpha'),
    makeModel('model-beta', 'anthropic', 'Model Beta'),
  ];

  const activeModelInfo = makeModel('model-alpha', 'anthropic', 'Model Alpha');

  function renderPicker(overrides: Record<string, unknown> = {}) {
    return render(
      <NewChatModelPicker
        activeModelInfo={activeModelInfo}
        activeModelLabel="Model Alpha"
        availableModels={anthropicModels}
        loading={false}
        onSelectModel={onSelectModel}
        {...overrides}
      />
    );
  }

  async function openDropdown(container: HTMLElement) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const button = container.querySelector('button[aria-label="Choose model"]')!;
    fireEvent.click(button);
  }

  beforeEach(() => {
    cleanup();
    onSelectModel.mockClear();
    mockConnectionState.value = 'connected';
    mockGetHubIfConnected.mockReturnValue(null);
  });

  afterEach(() => {
    cleanup();
  });

  describe('availability dot', () => {
    it('renders the transient failure as neutral, not danger', async () => {
      mockGetHubIfConnected.mockReturnValue(
        makeHub([{ id: 'anthropic', isAuthenticated: false, errorKind: 'transient' }])
      );

      const { container } = renderPicker();
      await openDropdown(container);

      const dropdown = container.querySelector('.absolute.bottom-full')!;
      expect(dropdown.querySelector('.bg-fg-faint')).toBeTruthy();
      expect(dropdown.querySelector('.bg-danger')).toBeFalsy();
    });

    it('renders an authenticated transient failure as degraded, not healthy', async () => {
      mockGetHubIfConnected.mockReturnValue(
        makeHub([{ id: 'anthropic', isAuthenticated: true, errorKind: 'transient' }])
      );

      const { container } = renderPicker();
      await openDropdown(container);

      const dropdown = container.querySelector('.absolute.bottom-full')!;
      expect(dropdown.querySelector('.bg-fg-faint')).toBeTruthy();
      expect(dropdown.querySelector('.bg-success')).toBeFalsy();
    });

    it('renders a definitive credential failure as danger', async () => {
      mockGetHubIfConnected.mockReturnValue(
        makeHub([{ id: 'anthropic', isAuthenticated: false, errorKind: 'credential' }])
      );

      const { container } = renderPicker();
      await openDropdown(container);

      const dropdown = container.querySelector('.absolute.bottom-full')!;
      expect(dropdown.querySelector('.bg-danger')).toBeTruthy();
    });
  });

  describe('model filtering', () => {
    it('keeps a transiently failed provider selectable', async () => {
      mockGetHubIfConnected.mockReturnValue(
        makeHub([{ id: 'anthropic', isAuthenticated: false, errorKind: 'transient' }])
      );

      const { container } = renderPicker();
      await openDropdown(container);

      const dropdown = container.querySelector('.absolute.bottom-full')!;
      expect(dropdown.textContent).toContain('Model Alpha');
      expect(dropdown.textContent).toContain('Model Beta');
    });

    it('blocks non-current models of the active provider under a definitive failure', async () => {
      mockGetHubIfConnected.mockReturnValue(
        makeHub([{ id: 'anthropic', isAuthenticated: false, errorKind: 'credential' }])
      );

      const { container } = renderPicker();
      await openDropdown(container);

      const dropdown = container.querySelector('.absolute.bottom-full')!;
      expect(dropdown.textContent).toContain('Model Alpha');
      expect(dropdown.textContent).not.toContain('Model Beta');
    });
  });

  describe('auth status refetch', () => {
    it('refetches auth providers when providers.changed fires', async () => {
      const eventHandlers = new Map<string, () => void>();
      const hub = {
        request: vi.fn().mockImplementation((method: string) => {
          if (method === 'auth.providers') {
            return Promise.resolve({
              providers: [{ id: 'anthropic', isAuthenticated: true }],
            });
          }
          return Promise.resolve(null);
        }),
        onEvent: vi.fn((event: string, handler: () => void) => {
          eventHandlers.set(event, handler);
          return () => eventHandlers.delete(event);
        }),
        onConnection: vi.fn(() => () => {}),
        isConnected: vi.fn(() => true),
      };
      mockGetHubIfConnected.mockReturnValue(hub);

      renderPicker();
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      const authRequests = () =>
        hub.request.mock.calls.filter(([method]) => method === 'auth.providers').length;
      expect(authRequests()).toBe(1);

      await act(async () => {
        eventHandlers.get('providers.changed')!();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      expect(authRequests()).toBe(2);
    });
  });
});
