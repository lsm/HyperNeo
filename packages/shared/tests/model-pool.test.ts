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
  expect(modelPoolEntryKey({ model: 'sonnet' })).toBe('sonnet');
});

test('scoring multiplies remaining capacity by weight', () => {
  const scored = scoreModelPoolEntries(entries, { sonnet: 6, 'glm-5': 1 });
  expect(scored[0]).toMatchObject({ left: 2, score: 100 });
  expect(scored[1]).toMatchObject({ left: 2, score: 100 });
});

test('pick distributes proportionally to remaining times weight', () => {
  const counts = { sonnet: 6, 'glm-5': 0 };
  const picked = [0.1, 0.45, 0.6, 0.9].map(
    (roll) => pickModelPoolEntry(entries, counts, () => roll)?.model
  );
  expect(picked).toEqual(['sonnet', 'glm-5', 'glm-5', 'glm-5']);
});

test('entries at capacity are excluded while any capacity remains', () => {
  const picked = pickModelPoolEntry(entries, { sonnet: 8, 'glm-5': 1 }, () => 0.99);
  expect(picked?.model).toBe('glm-5');
});

test('all entries at capacity returns null so the spawn defers', () => {
  expect(pickModelPoolEntry(entries, { sonnet: 8, 'glm-5': 3 }, () => 0.5)).toBeNull();
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

test('empty pool returns null', () => {
  expect(pickModelPoolEntry([], {})).toBeNull();
});
