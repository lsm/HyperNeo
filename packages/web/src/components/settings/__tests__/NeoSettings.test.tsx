import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/preact';
import type { ModelInfo } from '@hyperneo/shared';
import { connectionState } from '../../../lib/state.ts';
import {
  NeoSettings,
  neoRouteModelChoice,
  neoRouteFailureText,
  neoRouteModelOptions,
  neoRouteTimeoutOptions,
} from '../NeoSettings.tsx';

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

describe('neoRouteTimeoutOptions', () => {
  it('offers preset timeouts in milliseconds and marks 15 s as the default', () => {
    const options = neoRouteTimeoutOptions(15_000);
    expect(options.map((option) => option.value)).toEqual([
      '5000',
      '10000',
      '15000',
      '20000',
      '30000',
      '60000',
    ]);
    expect(options.find((option) => option.value === '15000')?.label).toBe('15 s (default)');
  });

  it('keeps a saved timeout that is not a preset', () => {
    expect(neoRouteTimeoutOptions(4_000).map((option) => option.value)).toContain('4000');
  });
});

describe('neoRouteFailureText', () => {
  it('names when the last routing failure happened and why', () => {
    expect(
      neoRouteFailureText(
        { at: 1_000_000, signal: 'classifier-failed', cause: 'route model returned 429' },
        1_000_000 + 3 * 60_000
      )
    ).toBe('Last routing failure · 3m ago — route model returned 429');
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

  it('shows the latest routing failure under the routing model', async () => {
    hubRequest.mockImplementation(async (method: string, params?: { name?: string }) =>
      method === 'operation.invoke' && params?.name === 'neo.route.failure'
        ? {
            failure: {
              at: Date.now() - 3 * 60_000,
              signal: 'classifier-failed',
              cause: 'route model returned 429',
            },
          }
        : { models: [] }
    );
    hubRef.current = { request: hubRequest };
    connectionState.value = 'connected';
    render(<NeoSettings />);

    await waitFor(() =>
      expect(
        screen.getByText('Last routing failure · 3m ago — route model returned 429')
      ).toBeTruthy()
    );
  });

  it('shows no failure line when routing never failed', async () => {
    hubRequest.mockImplementation(async (method: string) =>
      method === 'operation.invoke' ? { failure: null } : { models: [] }
    );
    hubRef.current = { request: hubRequest };
    connectionState.value = 'connected';
    render(<NeoSettings />);

    await waitFor(() =>
      expect(hubRequest).toHaveBeenCalledWith('operation.invoke', {
        name: 'neo.route.failure',
        input: {},
      })
    );
    expect(screen.queryByText(/Last routing failure/)).toBeNull();
  });
});
