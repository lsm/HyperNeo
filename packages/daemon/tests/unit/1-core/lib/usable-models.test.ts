import { describe, expect, test } from 'bun:test';
import type { ModelInfo } from '@hyperneo/shared';
import { usableModels } from '../../../../src/lib/usable-models';

const model = (id: string, provider: string, available?: boolean) =>
  ({ id, provider, ...(available === undefined ? {} : { available }) }) as ModelInfo;

describe('usableModels', () => {
  test('drops unavailable models and filters by provider when given', () => {
    const models = [model('a', 'p1'), model('b', 'p1', false), model('c', 'p2', true)];
    expect(usableModels(models).map(({ id }) => id)).toEqual(['a', 'c']);
    expect(usableModels(models, 'p2').map(({ id }) => id)).toEqual(['c']);
  });
});
