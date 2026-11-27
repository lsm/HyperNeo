import { describe, expect, test } from 'bun:test';
import type { CustomEndpointConfig, ModelInfo } from '@hyperneo/shared';
import {
  canSwitchToDesktopModel,
  DesktopModelsExhaustedError,
  selectDesktopControlModel,
  type DesktopModelSources,
  type DesktopProviderFacts,
} from '../../../../src/lib/session/desktop-model-chain';

const model = (id: string, provider: string, extra: Partial<ModelInfo> = {}) =>
  ({ id, provider, alias: id, name: id, available: true, ...extra }) as ModelInfo;

const seeing = (available = true, extra: Partial<DesktopProviderFacts> = {}) => ({
  capabilities: { vision: true, functionCalling: true },
  sdk: true,
  isAvailable: () => available,
  ...extra,
});

function sources(
  models: ModelInfo[],
  providers: Record<string, DesktopProviderFacts>
): DesktopModelSources {
  return { catalog: () => models, provider: (id) => providers[id] ?? null };
}

const node = (type: CustomEndpointConfig['type'], vision?: boolean): CustomEndpointConfig => ({
  id: 'ai0',
  type,
  name: 'ai0',
  baseUrl: 'http://ai0:8080',
  models: [{ id: 'bonsai', ...(vision === undefined ? {} : { capabilities: { vision } }) }],
});

describe('selectDesktopControlModel', () => {
  test('starts on the first listed model that is available, keeping its effort, and snapshots the canonical list', async () => {
    const result = await selectDesktopControlModel(
      [
        { provider: 'a', model: 'one', thinkingLevel: 'think8k' },
        { provider: 'b', model: 'two-alias', thinkingLevel: 'think16k' },
        { provider: 'c', model: 'three' },
      ],
      [],
      sources([model('one', 'a'), model('two', 'b', { alias: 'two-alias' }), model('three', 'c')], {
        a: seeing(false),
        b: seeing(),
        c: seeing(),
      })
    );
    expect(result.selected).toEqual({ provider: 'b', model: 'two', thinkingLevel: 'think16k' });
    expect(result.chain).toEqual([
      { provider: 'a', model: 'one', thinkingLevel: 'think8k' },
      { provider: 'b', model: 'two', thinkingLevel: 'think16k' },
      { provider: 'c', model: 'three' },
    ]);
  });

  test('drops models that cannot see screenshots or use tools, unknown entries and repeats', async () => {
    const result = await selectDesktopControlModel(
      [
        { provider: 'blind', model: 'eyes-off' },
        { provider: 'nosdk', model: 'oxap-only' },
        { provider: 'a', model: 'missing' },
        { provider: 'a', model: 'one' },
        { provider: 'a', model: 'one-alias' },
      ],
      [],
      sources(
        [
          model('eyes-off', 'blind'),
          model('oxap-only', 'nosdk'),
          model('one', 'a', { alias: 'one-alias' }),
        ],
        {
          blind: seeing(true, { capabilities: { vision: false, functionCalling: true } }),
          nosdk: seeing(true, { sdk: false }),
          a: seeing(),
        }
      )
    );
    expect(result.chain).toEqual([{ provider: 'a', model: 'one' }]);
  });

  test('judges a custom node by its own model and protocol, not the endpoint as a whole', async () => {
    const pick = (endpoint: CustomEndpointConfig) =>
      selectDesktopControlModel(
        [{ provider: 'custom:ai0', model: 'bonsai' }],
        [endpoint],
        sources([model('bonsai', 'custom:ai0')], { 'custom:ai0': seeing() })
      );
    expect((await pick(node('anthropic-messages'))).selected.model).toBe('bonsai');
    for (const endpoint of [
      node('anthropic-messages', false),
      node('openai-chat', true),
      node('ollama-native', true),
    ])
      await expect(pick(endpoint)).rejects.toThrow(DesktopModelsExhaustedError);
  });

  test('keeps a temporarily unavailable model in the snapshot and treats a throwing check as unavailable', async () => {
    const result = await selectDesktopControlModel(
      [
        { provider: 'down', model: 'later' },
        { provider: 'flaky', model: 'boom' },
        { provider: 'a', model: 'one' },
      ],
      [],
      sources(
        [model('later', 'down', { available: false }), model('boom', 'flaky'), model('one', 'a')],
        {
          down: seeing(),
          flaky: seeing(true, {
            isAvailable: () => {
              throw new Error('probe failed');
            },
          }),
          a: seeing(),
        }
      )
    );
    expect(result.selected).toEqual({ provider: 'a', model: 'one' });
    expect(result.chain.map((entry) => entry.model)).toEqual(['later', 'boom', 'one']);
  });

  test('refuses when the catalog is empty or unreadable, or nothing in the list can run', async () => {
    const entries = [{ provider: 'a', model: 'one' }];
    await expect(
      selectDesktopControlModel(entries, [], sources([], { a: seeing() }))
    ).rejects.toThrow(/model catalog is not loaded/);
    await expect(
      selectDesktopControlModel(entries, [], {
        catalog: () => {
          throw new Error('catalog offline');
        },
        provider: () => seeing(),
      })
    ).rejects.toThrow(/model catalog is not loaded/);
    await expect(
      selectDesktopControlModel(entries, [], sources([model('one', 'a')], { a: seeing(false) }))
    ).rejects.toThrow(/available right now/);
    await expect(
      selectDesktopControlModel(
        entries,
        [],
        sources([model('one', 'a')], { a: seeing(true, { sdk: false }) })
      )
    ).rejects.toThrow(/can see screenshots and use tools/);
    await expect(
      selectDesktopControlModel(entries, [], sources([], { a: seeing() }))
    ).rejects.toThrow(DesktopModelsExhaustedError);
  });
});

describe('canSwitchToDesktopModel', () => {
  test('applies the start gate again before a switch, with the settings in force now', async () => {
    const entry = { provider: 'custom:ai0', model: 'bonsai' };
    const check = (endpoint: CustomEndpointConfig, available = true) =>
      canSwitchToDesktopModel(
        entry,
        [endpoint],
        sources([model('bonsai', 'custom:ai0')], { 'custom:ai0': seeing(available) })
      );
    expect(await check(node('anthropic-messages'))).toBe(true);
    expect(await check(node('anthropic-messages', false))).toBe(false);
    expect(await check(node('ollama-native', true))).toBe(false);
    expect(await check(node('anthropic-messages'), false)).toBe(false);
  });
});
