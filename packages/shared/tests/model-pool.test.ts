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
