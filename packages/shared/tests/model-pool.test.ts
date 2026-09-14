import { expect, test } from 'bun:test';
import {
  modelPoolEntryKey,
  pickModelPoolEntry,
  scoreModelPoolEntries,
} from '../src/types/space-utils.ts';

const entries = [
  { model: 'sonnet', maxConcurrent: 8, weight: 50 },
  { model: 'glm-5', maxConcurrent: 3, weight: 50 },
];

test('modelPoolEntryKey is the model id', () => {
  expect(modelPoolEntryKey({ model: 'sonnet' })).toBe('[null,"sonnet"]');
});

test('modelPoolEntryKey separates the same model across providers', () => {
  expect(modelPoolEntryKey({ model: 'gpt-5.4', provider: 'custom:endpoint-2' })).toBe(
    '["custom:endpoint-2","gpt-5.4"]'
  );
  expect(modelPoolEntryKey({ model: 'gpt-5.4', provider: 'openai' })).toBe('["openai","gpt-5.4"]');
  expect(modelPoolEntryKey({ model: 'gpt-5.4' })).toBe('[null,"gpt-5.4"]');
});

test('modelPoolEntryKey cannot collide across qualified and unqualified entries', () => {
  expect(modelPoolEntryKey({ model: 'b', provider: 'custom:a' })).not.toBe(
    modelPoolEntryKey({ model: 'custom:a::b' })
  );
  expect(modelPoolEntryKey({ model: 'b', provider: 'custom:a' })).not.toBe(
    modelPoolEntryKey({ model: '["custom:a","b"]' })
  );
});

test('blank providers key identically to providerless entries', () => {
  expect(modelPoolEntryKey({ model: 'sonnet', provider: '' })).toBe(
    modelPoolEntryKey({ model: 'sonnet' })
  );
  expect(modelPoolEntryKey({ model: 'sonnet', provider: '   ' })).toBe(
    modelPoolEntryKey({ model: 'sonnet' })
  );
  expect(modelPoolEntryKey({ model: 'sonnet', provider: ' glm ' })).toBe(
    modelPoolEntryKey({ model: 'sonnet', provider: 'glm' })
  );
});

test('padded provider entries score under their trimmed bucket', () => {
  const entries = [{ model: 'sonnet', provider: ' glm ', maxConcurrent: 1, weight: 50 }];
  const scored = scoreModelPoolEntries(entries, { '["glm","sonnet"]': 1 });
  expect(scored[0]).toMatchObject({ running: 1, left: 0 });
});

test('qualified entries count their own bucket plus providerless runs, not other providers', () => {
  const entries = [
    { model: 'gpt-5.4', provider: 'openai', maxConcurrent: 2, weight: 50 },
    { model: 'gpt-5.4', provider: 'custom:endpoint-2', maxConcurrent: 2, weight: 50 },
  ];
  const scored = scoreModelPoolEntries(entries, { '["openai","gpt-5.4"]': 1 });
  expect(scored[0]).toMatchObject({ running: 1, left: 1 });
  expect(scored[1]).toMatchObject({ running: 0, left: 2 });
  const withProviderless = scoreModelPoolEntries(entries, {
    '["openai","gpt-5.4"]': 1,
    '[null,"gpt-5.4"]': 1,
  });
  expect(withProviderless[1]).toMatchObject({ running: 1, left: 1 });
});

test('providerless entries count qualified runs against their model-wide cap', () => {
  const entries = [{ model: 'sonnet', maxConcurrent: 2, weight: 50 }];
  const scored = scoreModelPoolEntries(entries, { '["glm","sonnet"]': 1, '[null,"sonnet"]': 1 });
  expect(scored[0]).toMatchObject({ running: 2, left: 0 });
  expect(
    pickModelPoolEntry(entries, { '["glm","sonnet"]': 1, '[null,"sonnet"]': 1 }, () => 0.5)
  ).toBeNull();
});

test('provider-qualified entries count model-wide runs against their capacity', () => {
  const entries = [{ model: 'sonnet', provider: 'glm', maxConcurrent: 1, weight: 50 }];
  const scored = scoreModelPoolEntries(entries, { '[null,"sonnet"]': 1 });
  expect(scored[0]).toMatchObject({ running: 1, left: 0 });
});

test('scoring multiplies remaining capacity by weight', () => {
  const scored = scoreModelPoolEntries(entries, { '[null,"sonnet"]': 6, '[null,"glm-5"]': 1 });
  expect(scored[0]).toMatchObject({ left: 2, score: 100 });
  expect(scored[1]).toMatchObject({ left: 2, score: 100 });
});

test('pick distributes proportionally to remaining times weight', () => {
  const counts = { '[null,"sonnet"]': 6, '[null,"glm-5"]': 0 };
  const picked = [0.1, 0.45, 0.6, 0.9].map(
    (roll) => pickModelPoolEntry(entries, counts, () => roll)?.model
  );
  expect(picked).toEqual(['sonnet', 'glm-5', 'glm-5', 'glm-5']);
});

test('entries at capacity are excluded while any capacity remains', () => {
  const picked = pickModelPoolEntry(
    entries,
    { '[null,"sonnet"]': 8, '[null,"glm-5"]': 1 },
    () => 0.99
  );
  expect(picked?.model).toBe('glm-5');
});

test('all entries at capacity returns null so the spawn defers', () => {
  expect(
    pickModelPoolEntry(entries, { '[null,"sonnet"]': 8, '[null,"glm-5"]': 3 }, () => 0.5)
  ).toBeNull();
});

test('zero weights with capacity left never win a slot', () => {
  const zeroWeight = [
    { model: 'a', maxConcurrent: 2, weight: 0 },
    { model: 'b', maxConcurrent: 2, weight: 0 },
  ];
  expect(pickModelPoolEntry(zeroWeight, {}, () => 0.5)).toBeNull();
});

test('invalid caps are clamped to one slot', () => {
  const scored = scoreModelPoolEntries([{ model: 'a', maxConcurrent: 0, weight: 1 }], {});
  expect(scored[0]?.cap).toBe(1);
});

test('extreme weights keep scores finite and selection weighted', () => {
  const entries = [
    { model: 'huge', maxConcurrent: 8, weight: Number.MAX_VALUE },
    { model: 'tiny', maxConcurrent: 8, weight: 1 },
  ];
  const scored = scoreModelPoolEntries(entries, {});
  expect(Number.isFinite(scored[0]?.score ?? NaN)).toBe(true);
  const picked = [0.1, 0.9].map((roll) => pickModelPoolEntry(entries, {}, () => roll)?.model);
  expect(picked).toEqual(['huge', 'huge']);
});

test('extreme weights keep their configured ratio', () => {
  const entries = [
    { model: 'big', maxConcurrent: 1, weight: Number.MAX_VALUE },
    { model: 'half', maxConcurrent: 1, weight: Number.MAX_VALUE / 2 },
  ];
  const picked = [0.5, 0.9].map((roll) => pickModelPoolEntry(entries, {}, () => roll)?.model);
  expect(picked).toEqual(['big', 'half']);
});

test('empty pool returns null', () => {
  expect(pickModelPoolEntry([], {})).toBeNull();
});
