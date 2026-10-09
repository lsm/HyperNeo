import { describe, expect, test } from 'bun:test';
import type { ModelInfo } from '@hyperneo/shared';
import {
  decideNewSessionModel,
  pickCatalogModel,
  planNewSessionModelRequest,
  type NewSessionModelCatalog,
} from '../../../../src/lib/session/new-session-model';

const model = (id: string, provider: string, alias = id) => ({ id, provider, alias }) as ModelInfo;
const models = [model('claude-sonnet-5', 'anthropic', 'sonnet'), model('glm-5', 'glm')];
const catalog = (extra: Partial<NewSessionModelCatalog> = {}): NewSessionModelCatalog => ({
  models,
  error: undefined,
  requestedCuratedOut: false,
  inferredCuratedOut: false,
  ...extra,
});
const plan = (
  explicitModel?: string,
  explicitProvider?: string,
  settings: Parameters<typeof planNewSessionModelRequest>[2] = {}
) => planNewSessionModelRequest(explicitModel, explicitProvider, settings, 'sonnet');

describe('planNewSessionModelRequest', () => {
  test('requests the explicit model, else the settings default, else the configured default', () => {
    expect(planNewSessionModelRequest('glm-5', 'glm', {}, 'sonnet')).toMatchObject({
      requestedModel: 'glm-5',
      requestedProvider: 'glm',
    });
    expect(
      planNewSessionModelRequest(undefined, 'glm', { model: 'glm-5' }, 'sonnet')
    ).toMatchObject({
      requestedModel: 'glm-5',
      requestedProvider: 'glm',
    });
    expect(planNewSessionModelRequest(undefined, undefined, {}, 'sonnet')).toMatchObject({
      requestedModel: 'sonnet',
      requestedProvider: undefined,
    });
    expect(
      planNewSessionModelRequest(undefined, 'glm', { modelProvider: 'anthropic' }, 'sonnet')
    ).toMatchObject({
      defaultProvider: 'anthropic',
    });
  });
});

describe('pickCatalogModel', () => {
  test('matches by id or alias, filtered to the provider when one is given', () => {
    expect(pickCatalogModel(models, 'sonnet', undefined)).toEqual({
      id: 'claude-sonnet-5',
      provider: 'anthropic',
    });
    expect(pickCatalogModel(models, 'sonnet', 'glm')).toBeNull();
  });
});

describe('decideNewSessionModel', () => {
  test.each([
    [
      'an explicit catalog model',
      plan('glm-5', 'glm'),
      catalog(),
      { kind: 'model', id: 'glm-5', provider: 'glm' },
    ],
    [
      'an explicit model off-catalog with a provider',
      plan('glm-9', 'glm'),
      catalog(),
      { kind: 'model', id: 'glm-9', provider: 'glm' },
    ],
    [
      'the default model by alias',
      plan(),
      catalog(),
      { kind: 'model', id: 'claude-sonnet-5', provider: 'anthropic' },
    ],
    [
      'a curated-out requested model',
      plan('glm-5', 'glm'),
      catalog({ requestedCuratedOut: true }),
      { kind: 'curated_out', model: 'glm-5', provider: 'glm' },
    ],
    [
      'a default with no catalog match and no fallback',
      plan(undefined, undefined, { model: 'missing' }),
      catalog(),
      { kind: 'unavailable', model: 'missing', provider: undefined },
    ],
    [
      'an empty catalog passes the request through',
      plan(undefined, undefined, { model: 'missing' }),
      catalog({ models: [] }),
      { kind: 'model', id: 'missing' },
    ],
    [
      'an empty catalog with a curated-out inferred provider',
      plan(undefined, undefined, { model: 'claude-old' }),
      catalog({ models: [], inferredCuratedOut: true }),
      { kind: 'curated_out', model: 'claude-old', provider: 'anthropic' },
    ],
  ] as const)('%s', (_label, request, current, expected) => {
    expect(decideNewSessionModel(request, current)).toEqual(expected);
  });

  test('falls back along the configured chain and names the model it replaced', () => {
    const request = plan(undefined, undefined, {
      model: 'missing',
      fallbackModels: [{ provider: 'glm', model: 'glm-5' }],
    });
    expect(decideNewSessionModel(request, catalog())).toEqual({
      kind: 'model',
      id: 'glm-5',
      provider: 'glm',
      fallbackFrom: 'missing',
    });
  });
});
