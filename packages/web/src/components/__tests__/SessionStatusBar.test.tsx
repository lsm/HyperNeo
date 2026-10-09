// @ts-nocheck

import type { ContextInfo, ModelInfo } from '@hyperneo/shared';
import { act, cleanup, fireEvent, render } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectionState } from '../../lib/state';
import SessionStatusBar from '../SessionStatusBar';

const mockGetHubIfConnected = vi.fn(() => null);

vi.mock('../../lib/connection-manager', () => ({
  connectionManager: {
    getHubIfConnected: () => mockGetHubIfConnected(),
    onConnection: vi.fn(() => () => {}),
  },
}));

function makeModel(id: string, name: string): ModelInfo {
  return { id, alias: id, name, family: 'sonnet', provider: 'anthropic' } as ModelInfo;
}

const sonnet = makeModel('sonnet', 'Sonnet 4.5');
const opus = makeModel('opus', 'Opus 4.5');

const contextUsage: ContextInfo = {
  totalUsed: 50000,
  totalCapacity: 200000,
  percentUsed: 25,
  model: 'sonnet',
  breakdown: {},
};

function makeHub() {
  return {
    request: vi.fn((method: string) =>
      Promise.resolve(
        method === 'auth.providers'
          ? { providers: [{ id: 'anthropic', isAuthenticated: true }] }
          : null
      )
    ),
    onEvent: vi.fn(() => () => {}),
    onConnection: vi.fn(() => () => {}),
    isConnected: vi.fn(() => true),
  };
}

describe('SessionStatusBar', () => {
  const onModelSwitch = vi.fn(() => Promise.resolve());
  const onThinkingLevelChange = vi.fn();

  function renderBar(overrides: Record<string, unknown> = {}) {
    return render(
      <SessionStatusBar
        sessionId="session-1"
        isProcessing={false}
        currentModel="sonnet"
        currentModelInfo={sonnet}
        availableModels={[sonnet, opus]}
        modelSwitching={false}
        modelLoading={false}
        onModelSwitch={onModelSwitch}
        onThinkingLevelChange={onThinkingLevelChange}
        contextUsage={contextUsage}
        {...overrides}
      />
    );
  }

  async function openPicker(container: HTMLElement) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    fireEvent.click(container.querySelector('button[aria-label="Choose model and thinking"]')!);
  }

  beforeEach(() => {
    cleanup();
    onModelSwitch.mockClear();
    onThinkingLevelChange.mockClear();
    mockGetHubIfConnected.mockReturnValue(makeHub());
    connectionState.value = 'connected';
  });

  afterEach(() => {
    cleanup();
  });

  it('shows the current model in the shared model picker', () => {
    const { container } = renderBar();
    const picker = container.querySelector('button[aria-label="Choose model and thinking"]');
    expect(picker?.textContent).toContain('Sonnet');
    expect(picker?.getAttribute('aria-controls')).toBe('session-preferences');
  });

  it('switches the model from the picker menu', async () => {
    const { container, findByText } = renderBar();
    await openPicker(container);

    fireEvent.click(await findByText('Opus 4.5'));

    expect(onModelSwitch).toHaveBeenCalledWith(opus);
  });

  it('passes a thinking level choice to the session', async () => {
    const { container, getByRole } = renderBar({
      currentModelInfo: { ...sonnet, thinkingModes: 'granular' },
    });
    await openPicker(container);

    fireEvent.change(getByRole('slider', { name: 'Thinking' }), { target: { value: '4' } });

    expect(onThinkingLevelChange).toHaveBeenCalledTimes(1);
    expect(onThinkingLevelChange.mock.calls[0][0]).toBe('think32k');
  });

  it.each([
    ['switching models', { modelSwitching: true }],
    ['recovering', { isRecovering: true }],
    ['switching coordinator mode', { coordinatorSwitching: true }],
  ])('disables the picker while %s', (_label, overrides) => {
    const { container } = renderBar(overrides);
    const picker = container.querySelector('button[aria-label="Choose model and thinking"]');
    expect(picker?.hasAttribute('disabled')).toBe(true);
  });
});
