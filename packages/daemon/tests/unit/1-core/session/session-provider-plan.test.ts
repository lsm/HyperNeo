import { describe, expect, it } from 'bun:test';
import type { ModelInfo } from '@hyperneo/shared';
import type { Provider } from '@hyperneo/shared/provider';
import {
  decideSessionProvider,
  NO_PROVIDER_NOTICE,
  planSessionProvider,
  PROVIDER_UNREACHABLE_NOTICE,
} from '../../../../src/lib/session/session-provider-plan.ts';

const model = (id: string, provider: string, extra: Partial<ModelInfo> = {}) =>
  ({ id, alias: id, name: id, provider, ...extra }) as ModelInfo;

const on = (...models: ModelInfo[]) => ({ models, unreachable: false });

const request = {
  wanted: 'anthropic',
  pinned: false,
  model: 'sonnet',
  settings: {},
};

describe('decideSessionProvider', () => {
  it('waits and says why once when no provider is on', () => {
    expect(decideSessionProvider(request, on())).toEqual({
      kind: 'wait',
      notice: NO_PROVIDER_NOTICE,
    });
  });

  it('moves an unpinned session silently', () => {
    expect(decideSessionProvider(request, on(model('gpt', 'anthropic-copilot')))).toEqual({
      kind: 'move',
      provider: 'anthropic-copilot',
      model: 'gpt',
      notice: null,
    });
  });

  it('tells the human when a pinned session moves', () => {
    const plan = decideSessionProvider(
      { ...request, pinned: true },
      on(model('gpt', 'anthropic-copilot'))
    );

    expect(plan).toMatchObject({ kind: 'move', provider: 'anthropic-copilot' });
    expect(plan.notice).toContain('anthropic, which is off');
    expect(plan.notice).toContain('gpt on anthropic-copilot');
  });

  it('keeps the same model when a provider that is on offers it', () => {
    const plan = decideSessionProvider(
      { ...request, model: 'shared' },
      on(model('other', 'glm'), model('shared', 'anthropic-copilot'))
    );

    expect(plan).toMatchObject({ provider: 'anthropic-copilot', model: 'shared' });
  });

  it('prefers the configured default model over the first one listed', () => {
    const plan = decideSessionProvider(
      { ...request, settings: { model: 'chosen', modelProvider: 'glm' } },
      on(model('first', 'anthropic-copilot'), model('chosen', 'glm'))
    );

    expect(plan).toMatchObject({ provider: 'glm', model: 'chosen' });
  });

  it('ignores models marked unavailable', () => {
    const plan = decideSessionProvider(request, on(model('gone', 'glm', { available: false })));

    expect(plan.kind).toBe('wait');
  });
});

describe('planSessionProvider', () => {
  it('does not ask a logged-in user to log in when their service is not answering', async () => {
    const unreachable = {
      id: 'custom:down',
      isAvailable: async () => true,
      getModels: async () => {
        throw new Error('probe failed');
      },
    } as unknown as Provider;

    expect(await planSessionProvider(request, [unreachable])).toEqual({
      kind: 'wait',
      notice: PROVIDER_UNREACHABLE_NOTICE,
    });
  });

  const provider = (id: string, available: boolean | Error) =>
    ({
      id,
      isAvailable: async () => {
        if (available instanceof Error) throw available;
        return available;
      },
      getModels: async () => [model(`${id}-model`, 'wrong')],
    }) as unknown as Provider;

  it('reads only providers that are on', async () => {
    const plan = await planSessionProvider(request, [
      provider('logged-out', false),
      provider('broken', new Error('down')),
      provider('on', true),
    ]);

    expect(plan).toMatchObject({ kind: 'move', provider: 'on', model: 'on-model' });
  });

  it('waits when every provider is off', async () => {
    expect((await planSessionProvider(request, [provider('off', false)])).kind).toBe('wait');
  });
});
