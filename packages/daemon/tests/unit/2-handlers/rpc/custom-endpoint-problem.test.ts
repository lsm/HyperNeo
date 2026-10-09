import { describe, expect, test } from 'bun:test';
import type { CustomEndpointConfig } from '@hyperneo/shared';
import { customEndpointProblem } from '../../../../src/lib/rpc-handlers/custom-endpoint-handlers';

const endpoint = (extra: Partial<CustomEndpointConfig> = {}) =>
  ({
    id: 'local',
    name: 'Local',
    baseUrl: 'http://localhost:8080/v1',
    models: [{ id: 'm1' }, { id: 'm2' }],
    ...extra,
  }) as CustomEndpointConfig;

describe('customEndpointProblem', () => {
  test.each([
    ['a valid endpoint', endpoint(), null],
    ['a missing id', endpoint({ id: '' }), 'Custom endpoint id is required'],
    ['a reserved id', endpoint({ id: 'exa' }), "Custom endpoint id 'exa' is reserved"],
    ['an invalid id', endpoint({ id: '-bad' }), 'is invalid (allowed'],
    ['an unknown type', endpoint({ type: 'soap' as never }), "type 'soap' is invalid"],
    ['a missing name', endpoint({ name: '' }), 'name is required'],
    ['a non-http baseUrl', endpoint({ baseUrl: 'ftp://host' }), 'must use http:// or https://'],
    ['an unparsable baseUrl', endpoint({ baseUrl: 'not a url' }), 'invalid baseUrl'],
    ['no models', endpoint({ models: [] }), 'at least one model is required'],
    [
      'a duplicate model',
      endpoint({ models: [{ id: 'm1' }, { id: 'm1' }] }),
      "duplicate model id 'm1'",
    ],
    [
      'an out-of-range autoCompactPercent',
      endpoint({ models: [{ id: 'm1', capabilities: { autoCompactPercent: 500 } }] }),
      'autoCompactPercent must be between',
    ],
    [
      'an unknown thinkingOffEffort',
      endpoint({ models: [{ id: 'm1', capabilities: { thinkingOffEffort: 'high' as never } }] }),
      'thinkingOffEffort must be none, minimal or low',
    ],
    [
      'a default model outside models[]',
      endpoint({ defaultModelId: 'm9' }),
      "defaultModelId 'm9' not in models[]",
    ],
  ])('%s', (_label, config, expected) => {
    const problem = customEndpointProblem(config);
    if (expected === null) expect(problem).toBeNull();
    else expect(problem).toContain(expected);
  });

  test('allows a reserved id the caller explicitly permits', () => {
    expect(
      customEndpointProblem(endpoint({ id: 'exa' }), { allowReservedIds: new Set(['exa']) })
    ).toBeNull();
  });
});
