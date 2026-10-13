import { describe, expect, test } from 'bun:test';
import { workStartConfiguration as policy } from '../../../../src/lib/drivers/start-configuration';
import { workResultSchema, WorkSummarySchema } from '../../../../src/lib/drivers/types';

const models = Object.freeze([
  Object.freeze({
    id: 'gpt-6.1-sol',
    aliases: Object.freeze(['sol 6.1']),
    efforts: Object.freeze(['low', 'medium']),
    isDefault: true,
  }),
  Object.freeze({
    id: 'other',
    aliases: Object.freeze(['fast']),
    efforts: Object.freeze(['high']),
  }),
]);

describe('workStartConfiguration', () => {
  test.each(['gpt-6.1-sol', 'sol 6.1', ' SOL   6.1 '])('resolves %s to the catalog ID', (model) => {
    expect(policy.select({ model, effort: ' MEDIUM ' }, models)).toEqual({
      model: 'gpt-6.1-sol',
      effort: 'medium',
    });
  });
  test('does not add overrides when none were requested', () => {
    expect(policy.select({}, [])).toEqual({});
    expect(policy.select({}, models)).toEqual({});
  });
  test('selects the catalog default for an effort-only request', () => {
    expect(policy.select({ effort: 'low' }, models)).toEqual({
      model: 'gpt-6.1-sol',
      effort: 'low',
    });
    expect(policy.select({ effort: 'medium' }, [])).toMatchObject({
      ok: false,
      reason: 'unsupported_effort',
    });
    expect(
      policy.select({ effort: 'medium' }, [models[0], { ...models[1], isDefault: true }])
    ).toMatchObject({ ok: false, reason: 'unsupported_effort' });
  });
  test.each(['unknown', 'sol', ''])(
    'refuses unsupported model %s without falling back',
    (model) => {
      expect(policy.select({ model, effort: 'medium' }, models)).toMatchObject({
        ok: false,
        reason: 'unsupported_model',
      });
    }
  );
  test('rejects an ambiguous alias but prioritizes an exact ID', () => {
    const overlapping = [models[0], { ...models[1], aliases: ['sol 6.1', 'gpt-6.1-sol'] }];
    expect(policy.select({ model: 'sol 6.1' }, overlapping)).toMatchObject({
      ok: false,
      reason: 'unsupported_model',
    });
    expect(policy.select({ model: 'gpt-6.1-sol' }, overlapping)).toEqual({ model: 'gpt-6.1-sol' });
    expect(policy.select({ model: 'gpt-6.1-sol' }, [models[0], models[0]])).toMatchObject({
      ok: false,
      reason: 'unsupported_model',
    });
  });
  test.each(['high', 'ultra', ''])(
    'rejects unsupported effort %s for the selected model',
    (effort) => {
      expect(policy.select({ model: 'gpt-6.1-sol', effort }, models)).toMatchObject({
        ok: false,
        reason: 'unsupported_effort',
      });
    }
  );
  test('uses only the selected model efforts and does not mutate inputs', () => {
    const request = Object.freeze({ model: 'fast', effort: 'HIGH' });
    expect(policy.select(request, models)).toEqual({ model: 'other', effort: 'high' });
    expect(request).toEqual({ model: 'fast', effort: 'HIGH' });
    expect(policy.select({ model: 'other', effort: 'medium' }, models)).toMatchObject({
      ok: false,
      reason: 'unsupported_effort',
    });
  });
  test('configuration and work-result schemas retain explicit choices and typed refusals', () => {
    expect(policy.schema.parse({ model: ' sol 6.1 ', effort: ' medium ' })).toEqual({
      model: 'sol 6.1',
      effort: 'medium',
    });
    expect(policy.schema.safeParse({ model: ' ' }).success).toBe(false);
    expect(policy.schema.safeParse({ effort: ' ' }).success).toBe(false);
    const result = workResultSchema(WorkSummarySchema);
    for (const reason of ['unsupported_model', 'unsupported_effort']) {
      const refusal = { ok: false, reason, detail: 'Choose a supported value.' };
      expect(result.parse(refusal)).toEqual(refusal);
    }
  });
});
