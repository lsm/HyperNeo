import { describe, expect, test } from 'bun:test';
import {
  evictedYieldKey,
  isUnfencedGeneration,
  type YieldGenerationStamp,
  ownsLastYield,
  ownsYieldedGeneration,
  yieldStampOwnsGeneration,
  yieldStampSurvivesStopEpoch,
} from '../../../../src/lib/agent/yield-ownership-gates';

function stamp(generation: number, stopEpoch: number): YieldGenerationStamp {
  return { generation, stopEpoch };
}

type YieldedArgs = Parameters<typeof ownsYieldedGeneration>[0];

function yieldedArgs(overrides: Partial<YieldedArgs> = {}): YieldedArgs {
  return {
    yielded: [],
    lastYieldGenerations: new Map<string, YieldGenerationStamp>(),
    messageId: 'uuid-1',
    generation: 4,
    ...overrides,
  };
}

type LastYieldArgs = Parameters<typeof ownsLastYield>[0];

function lastYieldArgs(overrides: Partial<LastYieldArgs> = {}): LastYieldArgs {
  return {
    lastYieldGenerations: new Map<string, YieldGenerationStamp>(),
    evictedYieldEpochs: new Set<string>(),
    messageId: 'uuid-1',
    generation: 4,
    stopEpoch: 2,
    ...overrides,
  };
}

describe('isUnfencedGeneration', () => {
  test('a null query generation requests no fencing', () => {
    expect(isUnfencedGeneration(null)).toBe(true);
  });

  test('an undefined query generation requests no fencing', () => {
    expect(isUnfencedGeneration(undefined)).toBe(true);
  });

  test('a carried query generation must be fenced', () => {
    expect(isUnfencedGeneration(5)).toBe(false);
  });
});

describe('evictedYieldKey', () => {
  test('encodes the generation and stop epoch the eviction scan parses', () => {
    expect(evictedYieldKey(4, 2)).toBe('4:2');
  });
});

describe('yieldStampOwnsGeneration', () => {
  test('a stamp owns its recorded generation', () => {
    expect(yieldStampOwnsGeneration(stamp(4, 2), 4)).toBe(true);
  });

  test('a stamp fences a different generation', () => {
    expect(yieldStampOwnsGeneration(stamp(4, 2), 5)).toBe(false);
  });
});

describe('yieldStampSurvivesStopEpoch', () => {
  test('a stamp survives while its stop epoch is still current', () => {
    expect(yieldStampSurvivesStopEpoch(stamp(4, 2), 2)).toBe(true);
  });

  test('a stamp is fenced once a clear or restart advanced the stop epoch', () => {
    expect(yieldStampSurvivesStopEpoch(stamp(4, 2), 3)).toBe(false);
  });
});

describe('ownsYieldedGeneration', () => {
  test('a null generation acknowledgment is never fenced', () => {
    expect(
      ownsYieldedGeneration(
        yieldedArgs({
          yielded: [{ id: 'uuid-1', yieldQueryGeneration: 5 }],
          lastYieldGenerations: new Map([['uuid-1', stamp(5, 1)]]),
          generation: null,
        })
      )
    ).toBe(true);
  });

  test('an undefined generation acknowledgment is never fenced', () => {
    expect(ownsYieldedGeneration(yieldedArgs({ generation: undefined }))).toBe(true);
  });

  test('an unstamped yielded row trusts the acknowledgment', () => {
    expect(ownsYieldedGeneration(yieldedArgs({ yielded: [{ id: 'uuid-1' }] }))).toBe(true);
  });

  test('a yielded row stamped with the acknowledgment generation owns it', () => {
    expect(
      ownsYieldedGeneration(yieldedArgs({ yielded: [{ id: 'uuid-1', yieldQueryGeneration: 4 }] }))
    ).toBe(true);
  });

  test('a yielded row re-stamped by a later query generation fences the old one', () => {
    expect(
      ownsYieldedGeneration(yieldedArgs({ yielded: [{ id: 'uuid-1', yieldQueryGeneration: 5 }] }))
    ).toBe(false);
  });

  test('yielded rows for other messages never fence the acknowledgment', () => {
    expect(
      ownsYieldedGeneration(
        yieldedArgs({
          yielded: [
            { id: 'uuid-other', yieldQueryGeneration: 5 },
            { id: 'uuid-2', yieldQueryGeneration: 9 },
          ],
        })
      )
    ).toBe(true);
  });

  test('the first yielded row for the message decides the fence', () => {
    expect(
      ownsYieldedGeneration(
        yieldedArgs({
          yielded: [
            { id: 'uuid-1', yieldQueryGeneration: 4 },
            { id: 'uuid-1', yieldQueryGeneration: 5 },
          ],
        })
      )
    ).toBe(true);
  });

  test('a sent yield keeps ownership through its retained stamp', () => {
    expect(
      ownsYieldedGeneration(
        yieldedArgs({ lastYieldGenerations: new Map([['uuid-1', stamp(4, 2)]]) })
      )
    ).toBe(true);
  });

  test('a retained stamp re-recorded by a later generation fences the old one', () => {
    expect(
      ownsYieldedGeneration(
        yieldedArgs({ lastYieldGenerations: new Map([['uuid-1', stamp(5, 2)]]) })
      )
    ).toBe(false);
  });

  test('a message with no yield record anywhere trusts the acknowledgment', () => {
    expect(
      ownsYieldedGeneration(
        yieldedArgs({
          yielded: [{ id: 'uuid-other', yieldQueryGeneration: 5 }],
          lastYieldGenerations: new Map([['uuid-other', stamp(5, 2)]]),
        })
      )
    ).toBe(true);
  });
});

describe('ownsLastYield', () => {
  test('a null generation direct acknowledgment is never fenced', () => {
    expect(
      ownsLastYield(
        lastYieldArgs({
          lastYieldGenerations: new Map([['uuid-1', stamp(5, 1)]]),
          generation: null,
        })
      )
    ).toBe(true);
  });

  test('a stamp owning the generation at the current stop epoch passes', () => {
    expect(
      ownsLastYield(lastYieldArgs({ lastYieldGenerations: new Map([['uuid-1', stamp(4, 2)]]) }))
    ).toBe(true);
  });

  test('a stamp stopped by a clear or restart fences the acknowledgment', () => {
    expect(
      ownsLastYield(lastYieldArgs({ lastYieldGenerations: new Map([['uuid-1', stamp(4, 1)]]) }))
    ).toBe(false);
  });

  test('a stamp recorded for a different generation fences the acknowledgment', () => {
    expect(
      ownsLastYield(lastYieldArgs({ lastYieldGenerations: new Map([['uuid-1', stamp(5, 2)]]) }))
    ).toBe(false);
  });

  test('a retained stamp outranks contradicting evicted rows', () => {
    expect(
      ownsLastYield(
        lastYieldArgs({
          lastYieldGenerations: new Map([['uuid-1', stamp(4, 2)]]),
          evictedYieldEpochs: new Set([evictedYieldKey(4, 1)]),
        })
      )
    ).toBe(true);
  });

  test('a message with no yield record and no eviction trusts the acknowledgment', () => {
    expect(ownsLastYield(lastYieldArgs())).toBe(true);
  });

  test('an evicted stamp at the current stop epoch still owns its generation', () => {
    expect(
      ownsLastYield(lastYieldArgs({ evictedYieldEpochs: new Set([evictedYieldKey(4, 2)]) }))
    ).toBe(true);
  });

  test('an evicted stamp stopped by a clear or restart fences the acknowledgment', () => {
    expect(
      ownsLastYield(lastYieldArgs({ evictedYieldEpochs: new Set([evictedYieldKey(4, 1)]) }))
    ).toBe(false);
  });

  test('evicted stamps for other generations never fence the acknowledgment', () => {
    expect(
      ownsLastYield(
        lastYieldArgs({
          evictedYieldEpochs: new Set([evictedYieldKey(5, 2), evictedYieldKey(6, 2)]),
        })
      )
    ).toBe(true);
  });

  test('the first evicted row for the generation decides the fence', () => {
    expect(
      ownsLastYield(
        lastYieldArgs({
          evictedYieldEpochs: new Set([evictedYieldKey(4, 2), evictedYieldKey(4, 1)]),
        })
      )
    ).toBe(true);
  });
});
