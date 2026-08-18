import { describe, expect, it } from 'vitest';
import { calculateActiveIndex, Focus } from '../../src/internal/calculate-active-index.ts';

type TestItem = { id: string; dataRef: { current: { disabled: boolean } } };

function makeItem(id: string, disabled = false): TestItem {
  return { id, dataRef: { current: { disabled } } };
}

function makeResolvers(items: TestItem[], activeIndex: number | null = null) {
  return {
    resolveItems: () => items,
    resolveActiveIndex: () => activeIndex,
    resolveId: (item: TestItem) => item.id,
    resolveDisabled: (item: TestItem) => item.dataRef.current.disabled,
  };
}

describe('calculateActiveIndex', () => {
  describe('Focus.First', () => {
    it('returns index of first non-disabled item', () => {
      const items = [makeItem('a', true), makeItem('b'), makeItem('c')];
      const result = calculateActiveIndex({ focus: Focus.First }, makeResolvers(items));
      expect(result).toBe(1);
    });

    it('returns null when all items are disabled', () => {
      const items = [makeItem('a', true), makeItem('b', true)];
      const result = calculateActiveIndex({ focus: Focus.First }, makeResolvers(items));
      expect(result).toBeNull();
    });
  });

  describe('Focus.Last', () => {
    it('returns index of last non-disabled item', () => {
      const items = [makeItem('a'), makeItem('b'), makeItem('c', true)];
      const result = calculateActiveIndex({ focus: Focus.Last }, makeResolvers(items));
      expect(result).toBe(1);
    });

    it('returns index of last item when no disabled items', () => {
      const items = [makeItem('a'), makeItem('b'), makeItem('c')];
      const result = calculateActiveIndex({ focus: Focus.Last }, makeResolvers(items));
      expect(result).toBe(2);
    });

    it('returns null when all items are disabled', () => {
      const items = [makeItem('a', true), makeItem('b', true)];
      const result = calculateActiveIndex({ focus: Focus.Last }, makeResolvers(items));
      expect(result).toBeNull();
    });
  });

  describe('Focus.Next', () => {
    it('returns next non-disabled item from current active', () => {
      const items = [makeItem('a'), makeItem('b'), makeItem('c')];
      const result = calculateActiveIndex({ focus: Focus.Next }, makeResolvers(items, 0));
      expect(result).toBe(1);
    });

    it('skips disabled items', () => {
      const items = [makeItem('a'), makeItem('b', true), makeItem('c')];
      const result = calculateActiveIndex({ focus: Focus.Next }, makeResolvers(items, 0));
      expect(result).toBe(2);
    });

    it('returns current active when no next non-disabled item', () => {
      const items = [makeItem('a'), makeItem('b'), makeItem('c')];
      const result = calculateActiveIndex({ focus: Focus.Next }, makeResolvers(items, 2));
      expect(result).toBe(2);
    });
  });

  describe('Focus.Previous', () => {
    it('returns previous non-disabled item from current active', () => {
      const items = [makeItem('a'), makeItem('b'), makeItem('c')];
      const result = calculateActiveIndex({ focus: Focus.Previous }, makeResolvers(items, 2));
      expect(result).toBe(1);
    });

    it('skips disabled items going backwards', () => {
      const items = [makeItem('a'), makeItem('b', true), makeItem('c')];
      const result = calculateActiveIndex({ focus: Focus.Previous }, makeResolvers(items, 2));
      expect(result).toBe(0);
    });

    it('returns current active when no previous non-disabled item', () => {
      const items = [makeItem('a'), makeItem('b'), makeItem('c')];
      const result = calculateActiveIndex({ focus: Focus.Previous }, makeResolvers(items, 0));
      expect(result).toBe(0);
    });

    it('returns last non-disabled item when no active index', () => {
      const items = [makeItem('a'), makeItem('b')];
      const result = calculateActiveIndex({ focus: Focus.Previous }, makeResolvers(items, null));
      expect(result).toBe(1);
    });
  });

  describe('Focus.Specific', () => {
    it('returns index of specific item by id', () => {
      const items = [makeItem('a'), makeItem('b'), makeItem('c')];
      const result = calculateActiveIndex({ focus: Focus.Specific, id: 'b' }, makeResolvers(items));
      expect(result).toBe(1);
    });

    it('returns current active index when id not found', () => {
      const items = [makeItem('a'), makeItem('b')];
      const result = calculateActiveIndex(
        { focus: Focus.Specific, id: 'z' },
        makeResolvers(items, 1)
      );
      expect(result).toBe(1);
    });

    it('returns null when id not found and no current active', () => {
      const items = [makeItem('a'), makeItem('b')];
      const result = calculateActiveIndex(
        { focus: Focus.Specific, id: 'z' },
        makeResolvers(items, null)
      );
      expect(result).toBeNull();
    });
  });

  describe('Focus.Nothing', () => {
    it('returns null', () => {
      const items = [makeItem('a'), makeItem('b')];
      const result = calculateActiveIndex({ focus: Focus.Nothing }, makeResolvers(items, 1));
      expect(result).toBeNull();
    });
  });

  describe('empty list', () => {
    it('returns null for empty list', () => {
      const result = calculateActiveIndex({ focus: Focus.First }, makeResolvers([]));
      expect(result).toBeNull();
    });
  });
});
