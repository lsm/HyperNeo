import { describe, expect, it } from 'bun:test';
import { buildLastGoodDiscoveredModels } from '../../../../../src/lib/providers/shared/last-good-discovery';

const ROOMY_BUDGET = 64 * 1024;

describe('buildLastGoodDiscoveredModels ordering', () => {
  it('persists discovered models in discovery order, capped to id and name', () => {
    const rich = [{ id: 'm1', name: 'Model One', contextWindow: 128000, description: 'rich' }];
    const result = buildLastGoodDiscoveredModels(undefined, rich, ROOMY_BUDGET);
    expect(result.models).toEqual([{ id: 'm1', name: 'Model One' }]);
    expect(result.truncated).toBeUndefined();
  });

  it('persists every curated id before any discovered overflow', () => {
    const curated = [{ id: 'cur-two', name: 'Second' }, { id: 'cur-one' }];
    const discovered = [
      { id: 'disc-one', name: 'D1' },
      { id: 'cur-two', name: 'Ignored position' },
      { id: 'disc-two' },
    ];
    const result = buildLastGoodDiscoveredModels(curated, discovered, ROOMY_BUDGET);
    expect(result.models.map((m) => m.id)).toEqual(['cur-two', 'cur-one', 'disc-one', 'disc-two']);
  });

  it('keeps the curated name over a discovered name for the same id', () => {
    const result = buildLastGoodDiscoveredModels(
      [{ id: 'cur', name: 'Curated Name' }],
      [{ id: 'cur', name: 'Discovered Name' }],
      ROOMY_BUDGET
    );
    expect(result.models).toEqual([{ id: 'cur', name: 'Curated Name' }]);
  });

  it('fills a missing curated name from discovered metadata', () => {
    const result = buildLastGoodDiscoveredModels(
      [{ id: 'cur' }],
      [{ id: 'cur', name: 'Discovered Name' }],
      ROOMY_BUDGET
    );
    expect(result.models).toEqual([{ id: 'cur', name: 'Discovered Name' }]);
  });

  it('deduplicates repeated curated and discovered ids, first occurrence winning', () => {
    const result = buildLastGoodDiscoveredModels(
      [
        { id: 'cur', name: 'First' },
        { id: 'cur', name: 'Second' },
      ],
      [
        { id: 'disc', name: 'First' },
        { id: 'disc', name: 'Second' },
      ],
      ROOMY_BUDGET
    );
    expect(result.models).toEqual([
      { id: 'cur', name: 'First' },
      { id: 'disc', name: 'First' },
    ]);
  });

  it('persists curated models with no discovered input and no truncation marker', () => {
    const result = buildLastGoodDiscoveredModels(
      [{ id: 'cur-a', name: 'A' }, { id: 'cur-b' }],
      [],
      ROOMY_BUDGET
    );
    expect(result.models).toEqual([{ id: 'cur-a', name: 'A' }, { id: 'cur-b' }]);
    expect(result.truncated).toBeUndefined();
  });

  it('treats an empty curated list the same as an absent one', () => {
    const discovered = [{ id: 'disc', name: 'D' }];
    const absent = buildLastGoodDiscoveredModels(undefined, discovered, ROOMY_BUDGET);
    const empty = buildLastGoodDiscoveredModels([], discovered, ROOMY_BUDGET);
    expect(empty).toEqual(absent);
  });
});

describe('buildLastGoodDiscoveredModels bounding and truncation', () => {
  function overflowInput() {
    const curated = [{ id: 'keep-me', name: 'Kept' }];
    const discovered = Array.from({ length: 20 }, (_, i) => ({
      id: `disc-${i.toString().padStart(2, '0')}`,
      name: `Discovered ${i}`,
    }));
    return { curated, discovered };
  }

  it('keeps the whole list when the budget accommodates it', () => {
    const { curated, discovered } = overflowInput();
    const exact = JSON.stringify([...curated, ...discovered]).length;
    const result = buildLastGoodDiscoveredModels(curated, discovered, exact);
    expect(result.models).toEqual([...curated, ...discovered]);
    expect(result.truncated).toBeUndefined();
  });

  it('truncates discovered overflow while every curated id survives', () => {
    const { curated, discovered } = overflowInput();
    const exact = JSON.stringify([...curated, ...discovered]).length;
    const result = buildLastGoodDiscoveredModels(curated, discovered, exact - 100);
    expect(result.truncated).toBe(true);
    expect(result.models[0]).toEqual(curated[0]);
    expect(result.models.length).toBeGreaterThan(1);
    expect(result.models.length).toBeLessThan(curated.length + discovered.length);
    expect(JSON.stringify(result.models).length).toBeLessThanOrEqual(exact - 100);
    expect(result.models.slice(1).map((m) => m.id)).toEqual(
      discovered.slice(0, result.models.length - 1).map((m) => m.id)
    );
  });

  it('drops a discovered name to its bare id when only the bare form fits', () => {
    const result = buildLastGoodDiscoveredModels(undefined, [{ id: 'aaa', name: 'nnn' }], 20);
    expect(result.models).toEqual([{ id: 'aaa' }]);
    expect(result.truncated).toBeUndefined();
  });

  it('drops a curated name to its bare id instead of dropping the curated entry', () => {
    const result = buildLastGoodDiscoveredModels([{ id: 'aaa', name: 'nnn' }], [], 20);
    expect(result.models).toEqual([{ id: 'aaa' }]);
    expect(result.truncated).toBeUndefined();
  });

  it('throws when a curated entry cannot fit even without its name', () => {
    const curated = [{ id: 'cur-a' }, { id: 'cur-b', name: 'B' }];
    const onlyFirstFits = JSON.stringify([curated[0]]).length;
    expect(() => buildLastGoodDiscoveredModels(curated, [], onlyFirstFits)).toThrow(
      'Provider config has no capacity to retain all curated models'
    );
  });

  it('returns an empty truncated list when no entry fits and nothing is curated', () => {
    const result = buildLastGoodDiscoveredModels(undefined, [{ id: 'aaa', name: 'nnn' }], 12);
    expect(result.models).toEqual([]);
    expect(result.truncated).toBe(true);
  });

  it('admits an entry at the exact budget boundary and rejects it one char below', () => {
    const discovered = [{ id: 'a"b' }];
    const exact = JSON.stringify(discovered).length;
    expect(buildLastGoodDiscoveredModels(undefined, discovered, exact).models).toEqual(discovered);
    const below = buildLastGoodDiscoveredModels(undefined, discovered, exact - 1);
    expect(below.models).toEqual([]);
    expect(below.truncated).toBe(true);
  });
});
