import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/preact';
import type { ModelInfo } from '@hyperneo/shared';
import { connectionState } from '../../../lib/state.ts';
import { NeoSettings, neoRouteModelChoice, neoRouteModelOptions } from '../NeoSettings.tsx';

const { hubRequest, hubRef } = vi.hoisted(() => ({
  hubRequest: vi.fn(),
  hubRef: { current: null as { request: (...args: unknown[]) => unknown } | null },
}));

vi.mock('../../../lib/connection-manager', () => ({
  connectionManager: { getHubIfConnected: () => hubRef.current },
}));

const model = (provider: string, id: string, name: string) =>
  ({ id, name, provider, alias: id, family: 'haiku', contextWindow: 0 }) as unknown as ModelInfo;

describe('neoRouteModelOptions', () => {
  it('offers the default first, then every model labelled by provider', () => {
    expect(
      neoRouteModelOptions([model('deepseek', 'deepseek-v4-flash', 'DeepSeek Flash')], '')
    ).toEqual([
      { value: '', label: "Default provider's title model" },
      { value: 'deepseek|deepseek-v4-flash', label: 'DeepSeek — DeepSeek Flash' },
    ]);
  });

  it('keeps a saved model that is no longer listed so the choice stays visible', () => {
    const saved = neoRouteModelChoice('glm', 'glm-5-turbo');
    expect(neoRouteModelOptions([], saved).at(-1)).toEqual({
      value: 'glm|glm-5-turbo',
      label: 'glm — glm-5-turbo (unavailable)',
    });
  });
});

describe('NeoSettings', () => {
  afterEach(() => {
    cleanup();
    hubRef.current = null;
    hubRequest.mockReset();
    connectionState.value = 'connecting';
  });

  it('loads the model list once the connection comes up after mount', async () => {
    connectionState.value = 'connecting';
    hubRequest.mockResolvedValue({
      models: [
        {
          id: 'deepseek-v4-flash',
          display_name: 'DeepSeek Flash',
          description: '',
          provider: 'deepseek',
        },
      ],
    });
    render(<NeoSettings />);
    expect(hubRequest).not.toHaveBeenCalled();

    hubRef.current = { request: hubRequest };
    connectionState.value = 'connected';

    await waitFor(() => expect(hubRequest).toHaveBeenCalledWith('models.list', { useCache: true }));
    await waitFor(() => expect(screen.getByText(/DeepSeek Flash/)).toBeTruthy());
  });
});
