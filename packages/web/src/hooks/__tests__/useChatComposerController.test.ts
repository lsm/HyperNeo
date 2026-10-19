import { renderHook, act } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ModelInfo } from '@hyperneo/shared';

const switchModel = vi.hoisted(() => vi.fn());
vi.mock('../useModelSwitcher.ts', () => ({
  useModelSwitcher: () => ({
    currentModel: 'sonnet',
    currentModelInfo: { id: 'sonnet', provider: 'anthropic' },
    availableModels: [],
    switching: false,
    loading: false,
    switchModel,
  }),
}));

import { useChatComposerController } from '../useChatComposerController.ts';

afterEach(() => {
  vi.unstubAllGlobals();
  switchModel.mockReset();
});

describe('useChatComposerController', () => {
  it('switches the model mid-reply without warning that it interrupts', async () => {
    const confirm = vi.fn(() => false);
    vi.stubGlobal('confirm', confirm);
    const { result } = renderHook(() =>
      useChatComposerController({
        sessionId: 's1',
        agentState: { status: 'processing', messageId: 'm', phase: 'streaming' } as never,
        messages: [],
        isProcessing: true,
        coordinatorMode: false,
        setCoordinatorMode: vi.fn(),
        sandboxEnabled: false,
        setSandboxEnabled: vi.fn(),
      })
    );
    const opus = { id: 'opus', provider: 'anthropic' } as ModelInfo;
    await act(async () => {
      await result.current.handleModelSwitchWithConfirmation(opus);
    });
    expect(confirm).not.toHaveBeenCalled();
    expect(switchModel).toHaveBeenCalledWith(opus);
  });
});
