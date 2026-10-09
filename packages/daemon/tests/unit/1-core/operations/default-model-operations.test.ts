import { describe, expect, test } from 'bun:test';
import type { GlobalSettings, ModelInfo } from '@hyperneo/shared';
import {
  createDefaultModelOperations,
  type DefaultModelDeps,
  readDefaultModel,
  setDefaultModel,
} from '../../../../src/lib/rpc-handlers/family-operations/settings.ts';

const model = (id: string, provider: string, available = true): ModelInfo =>
  ({
    id,
    name: id.toUpperCase(),
    alias: id,
    provider,
    releaseDate: '2026-01-01',
    available,
  }) as ModelInfo;

function deps(models: ModelInfo[]) {
  let settings: Pick<GlobalSettings, 'model' | 'modelProvider'> = {
    model: 'sonnet',
    modelProvider: 'anthropic',
  };
  const writes: Array<[string, string]> = [];
  const value: DefaultModelDeps = {
    read: () => settings,
    write: (id, provider) => {
      writes.push([id, provider]);
      settings = { model: id, modelProvider: provider };
    },
    models: () => models,
  };
  return { value, writes };
}

describe('readDefaultModel', () => {
  test('returns the default and only the models that can run', () => {
    const { value } = deps([model('glm-5.3', 'glm'), model('opus', 'anthropic', false)]);
    expect(readDefaultModel(value)).toEqual({
      model: 'sonnet',
      provider: 'anthropic',
      availableModels: [{ id: 'glm-5.3', name: 'GLM-5.3', provider: 'glm' }],
    });
  });
});

describe('setDefaultModel', () => {
  test('sets the model with its own provider and reports the previous one', () => {
    const { value, writes } = deps([model('glm-5.3', 'glm')]);
    expect(setDefaultModel({ model: 'GLM-5.3' }, value)).toEqual({
      ok: true,
      previous: { model: 'sonnet', provider: 'anthropic' },
      model: 'glm-5.3',
      provider: 'glm',
    });
    expect(writes).toEqual([['glm-5.3', 'glm']]);
  });

  test('refuses a model that cannot run, or one from another provider, without writing', () => {
    const { value, writes } = deps([model('glm-5.3', 'glm'), model('opus', 'anthropic', false)]);
    const refused = setDefaultModel({ model: 'opus' }, value);
    expect(refused).toMatchObject({ ok: false, reason: 'model_unavailable' });
    expect(setDefaultModel({ model: 'glm-5.3', provider: 'anthropic' }, value)).toMatchObject({
      ok: false,
    });
    expect(writes).toEqual([]);
  });
});

describe('createDefaultModelOperations', () => {
  test('exposes a read and a narrow write to Neo only', () => {
    const operations = createDefaultModelOperations(deps([]).value);
    expect(operations.map((operation) => [operation.name, operation.policy])).toEqual([
      ['settings.model.get', { safetyClass: 'read', roles: ['neo'] }],
      ['settings.model.set', { safetyClass: 'mutate', roles: ['neo'] }],
    ]);
  });
});
