import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { resetProviderRegistry, getProviderRegistry } from '../../../../src/lib/providers/registry';
import {
  resetProviderFactory,
  syncCustomEndpointProviders,
} from '../../../../src/lib/providers/factory';
import { CustomEndpointProvider } from '../../../../src/lib/providers/custom-endpoint-provider';
import type { CustomEndpointConfig } from '@hyperneo/shared';

const baseConfig: CustomEndpointConfig = {
  id: 'lmstudio',
  name: 'LM Studio',
  baseUrl: 'http://localhost:1234/v1',
  models: [{ id: 'qwen2.5-7b', capabilities: { toolUse: true } }],
};

describe('syncCustomEndpointProviders - diff skip', () => {
  beforeEach(() => {
    resetProviderFactory();
    resetProviderRegistry();
  });
  afterEach(() => {
    resetProviderFactory();
    resetProviderRegistry();
  });

  it('keeps the same provider instance when the config is unchanged', async () => {
    await syncCustomEndpointProviders([baseConfig]);
    const first = getProviderRegistry().get('custom:lmstudio') as CustomEndpointProvider;
    expect(first).toBeInstanceOf(CustomEndpointProvider);
    await syncCustomEndpointProviders([baseConfig]);
    const second = getProviderRegistry().get('custom:lmstudio');
    expect(second).toBe(first);
  });

  it('rebuilds the provider when its config changes', async () => {
    await syncCustomEndpointProviders([baseConfig]);
    const first = getProviderRegistry().get('custom:lmstudio');
    await syncCustomEndpointProviders([{ ...baseConfig, baseUrl: 'http://localhost:9999/v1' }]);
    const second = getProviderRegistry().get('custom:lmstudio');
    expect(second).not.toBe(first);
  });

  it('rebuilds the provider when a nested model capability changes', async () => {
    await syncCustomEndpointProviders([baseConfig]);
    const first = getProviderRegistry().get('custom:lmstudio');
    await syncCustomEndpointProviders([
      {
        ...baseConfig,
        models: [{ id: 'qwen2.5-7b', capabilities: { toolUse: false, vision: true } }],
      },
    ]);
    const second = getProviderRegistry().get('custom:lmstudio');
    expect(second).not.toBe(first);
  });

  it('rebuilds the provider when headers change', async () => {
    await syncCustomEndpointProviders([{ ...baseConfig, headers: { 'X-Org': 'acme' } }]);
    const first = getProviderRegistry().get('custom:lmstudio');
    await syncCustomEndpointProviders([{ ...baseConfig, headers: { 'X-Org': 'beta' } }]);
    const second = getProviderRegistry().get('custom:lmstudio');
    expect(second).not.toBe(first);
  });

  it('rebuilds the provider when providerModelId on a model changes', async () => {
    await syncCustomEndpointProviders([
      { ...baseConfig, models: [{ id: 'm', providerModelId: 'upstream-a' }] },
    ]);
    const first = getProviderRegistry().get('custom:lmstudio');
    await syncCustomEndpointProviders([
      { ...baseConfig, models: [{ id: 'm', providerModelId: 'upstream-b' }] },
    ]);
    const second = getProviderRegistry().get('custom:lmstudio');
    expect(second).not.toBe(first);
  });

  it('leaves untouched providers in place when an unrelated endpoint is edited', async () => {
    const other: CustomEndpointConfig = {
      id: 'vllm',
      name: 'vLLM',
      baseUrl: 'http://localhost:8000/v1',
      models: [{ id: 'meta-llama' }],
    };
    await syncCustomEndpointProviders([baseConfig, other]);
    const lmFirst = getProviderRegistry().get('custom:lmstudio');
    const vllmFirst = getProviderRegistry().get('custom:vllm');
    await syncCustomEndpointProviders([baseConfig, { ...other, name: 'vLLM (renamed)' }]);
    const lmSecond = getProviderRegistry().get('custom:lmstudio');
    const vllmSecond = getProviderRegistry().get('custom:vllm');
    expect(lmSecond).toBe(lmFirst);
    expect(vllmSecond).not.toBe(vllmFirst);
  });

  it('shuts down providers removed from the config list', async () => {
    await syncCustomEndpointProviders([baseConfig]);
    expect(getProviderRegistry().get('custom:lmstudio')).toBeDefined();
    await syncCustomEndpointProviders([]);
    expect(getProviderRegistry().get('custom:lmstudio')).toBeUndefined();
  });
});
