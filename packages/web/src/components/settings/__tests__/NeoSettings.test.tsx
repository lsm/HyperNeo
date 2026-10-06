import { describe, expect, it } from 'vitest';
import type { ModelInfo } from '@hyperneo/shared';
import { neoRouteModelChoice, neoRouteModelOptions } from '../NeoSettings.tsx';

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
