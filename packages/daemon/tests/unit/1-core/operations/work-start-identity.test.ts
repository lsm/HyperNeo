import { describe, expect, test } from 'bun:test';
import { workStartConfiguration } from '../../../../src/lib/drivers/start-configuration';
import { WorkRejectionSchema } from '../../../../src/lib/drivers/types';

const gate = workStartConfiguration.requireIdentity;

describe('workStartConfiguration.requireIdentity', () => {
  test('returns the full triple when provider comes from the adapter', () => {
    expect(
      gate(
        { adapter: 'codex-desktop', model: 'm', effort: 'high' },
        { fixedProvider: 'openai', configurable: true }
      )
    ).toEqual({ provider: 'openai', model: 'm', effort: 'high' });
  });

  test('names every missing field', () => {
    expect(gate({ adapter: 'hyperneo', model: 'm' }, { configurable: true })).toEqual({
      ok: false,
      reason: 'identity_required',
      detail:
        'identity_required: name provider, model and effort for new work (missing: provider, effort)',
    });
  });

  test('refuses a provider that contradicts the adapter', () => {
    expect(
      gate(
        { adapter: 'claude-desktop', provider: 'openai', model: 'm', effort: 'high' },
        { fixedProvider: 'anthropic', configurable: false }
      )
    ).toEqual({
      ok: false,
      reason: 'identity_required',
      detail: 'identity_required: adapter claude-desktop runs on provider anthropic, not openai',
    });
  });

  test('refuses a provider that contradicts the catalog owner of the model', () => {
    expect(
      gate(
        { adapter: 'hyperneo', provider: 'a', model: 'm', effort: 'high' },
        { catalogProvider: 'b', configurable: true }
      )
    ).toEqual({
      ok: false,
      reason: 'identity_required',
      detail: 'identity_required: the model catalog names provider b, not a',
    });
  });

  test('accepts a matching request provider and catalog owner', () => {
    expect(
      gate(
        { adapter: 'hyperneo', provider: 'a', model: 'm', effort: 'high' },
        { catalogProvider: 'a', configurable: true }
      )
    ).toEqual({ provider: 'a', model: 'm', effort: 'high' });
  });

  test('identity_required is a valid work rejection', () => {
    expect(WorkRejectionSchema.safeParse('identity_required').success).toBe(true);
  });
});
