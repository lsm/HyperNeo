// @ts-nocheck

import type { ModelInfo } from '@hyperneo/shared';
import { act, cleanup, fireEvent, render } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelPicker } from '../ModelPicker';

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

describe('ModelPicker', () => {
  const onSelectModel = vi.fn();
  const onSelectThinking = vi.fn();

  const anthropicModels: ModelInfo[] = [
    makeModel('model-alpha', 'anthropic', 'Model Alpha'),
    makeModel('model-beta', 'anthropic', 'Model Beta'),
  ];

  const activeModelInfo = makeModel('model-alpha', 'anthropic', 'Model Alpha');

  function renderPicker(overrides: Record<string, unknown> = {}) {
    return render(
      <ModelPicker
        activeModelInfo={activeModelInfo}
        activeModelLabel="Model Alpha"
        availableModels={anthropicModels}
        loading={false}
        thinkingLevel="off"
        onSelectModel={onSelectModel}
        onSelectThinking={onSelectThinking}
        onReload={vi.fn()}
        {...overrides}
      />
    );
  }

  async function openDropdown(container: HTMLElement) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const button = container.querySelector('button[aria-label="Choose model and thinking"]')!;
    fireEvent.click(button);
  }

  beforeEach(() => {
    cleanup();
    onSelectModel.mockClear();
    onSelectThinking.mockClear();
    mockConnectionState.value = 'connected';
    mockGetHubIfConnected.mockReturnValue(null);
  });

  afterEach(() => {
    cleanup();
  });

  describe('thinking', () => {
    it('shows the chosen level on the trigger and reports a new one from the menu', async () => {
      const { container } = renderPicker({ thinkingLevel: 'think16k' });
      expect(container.querySelector('[aria-label="Thinking: Think 16k"]')).toBeTruthy();
      expect(container.querySelector('[data-thinking-level="think16k"] svg.absolute')).toBeTruthy();

      await openDropdown(container);
      fireEvent.click(container.querySelector('button[aria-label="Think 32k"]')!);

      expect(onSelectThinking).toHaveBeenCalledWith('think32k');
    });

    it('shows Off when the model cannot think at the chosen level', () => {
      const { container } = renderPicker({
        thinkingLevel: 'think16k',
        activeModelInfo: { ...activeModelInfo, thinkingModes: 'off' },
      });
      expect(container.querySelector('[aria-label="Thinking: Off"]')).toBeTruthy();
    });
  });

  describe('model filtering', () => {
    it('renders unavailable models as disabled and unselectable', async () => {
      const models: ModelInfo[] = [
        makeModel('model-alpha', 'anthropic', 'Model Alpha'),
        { ...makeModel('model-beta', 'anthropic', 'Model Beta'), available: false },
      ];
      const { container } = renderPicker({ availableModels: models });
      await openDropdown(container);

      const option = [...container.querySelectorAll('button')].find((button) =>
        button.textContent?.includes('Model Beta')
      )!;
      expect(option.disabled).toBe(true);
      expect(option.title).toBe('Not runnable on this account');

      fireEvent.click(option);
      expect(onSelectModel).not.toHaveBeenCalled();
    });

    it('keeps a transiently failed provider selectable', async () => {
      mockGetHubIfConnected.mockReturnValue(
        makeHub([{ id: 'anthropic', isAuthenticated: false, errorKind: 'transient' }])
      );

      const { container } = renderPicker();
      await openDropdown(container);

      const dropdown = container.querySelector('#model-preferences')!;
      expect(dropdown.textContent).toContain('Model Alpha');
      expect(dropdown.textContent).toContain('Model Beta');
    });

    it('blocks non-current models of the active provider under a definitive failure', async () => {
      mockGetHubIfConnected.mockReturnValue(
        makeHub([{ id: 'anthropic', isAuthenticated: false, errorKind: 'credential' }])
      );

      const { container } = renderPicker();
      await openDropdown(container);

      const dropdown = container.querySelector('#model-preferences')!;
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
