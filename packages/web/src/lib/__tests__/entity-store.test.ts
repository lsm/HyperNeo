import { describe, it, expect, beforeEach } from 'vitest';
import { computed } from '@preact/signals';
import { EntityStore } from '../entity-store';

interface Item {
  id: string;
  name: string;
  value: number;
}

function makeItem(id: string, name = `item-${id}`, value = 0): Item {
  return { id, name, value };
}

describe('EntityStore', () => {
  let store: EntityStore<Item>;

  beforeEach(() => {
    store = new EntityStore<Item>();
  });

  describe('applySnapshot', () => {
    it('populates items from rows', () => {
      store.applySnapshot([makeItem('a'), makeItem('b'), makeItem('c')]);
      expect(store.items.value.size).toBe(3);
      expect(store.items.value.get('a')).toEqual(makeItem('a'));
      expect(store.items.value.get('b')).toEqual(makeItem('b'));
      expect(store.items.value.get('c')).toEqual(makeItem('c'));
    });

    it('replaces previous contents entirely', () => {
      store.applySnapshot([makeItem('old1'), makeItem('old2')]);
      store.applySnapshot([makeItem('new1')]);
      expect(store.items.value.size).toBe(1);
      expect(store.items.value.has('old1')).toBe(false);
      expect(store.items.value.has('new1')).toBe(true);
    });

    it('sets loading to false', () => {
      store.loading.value = true;
      store.applySnapshot([makeItem('a')]);
      expect(store.loading.value).toBe(false);
    });

    it('handles empty snapshot', () => {
      store.applySnapshot([makeItem('a')]);
      store.applySnapshot([]);
      expect(store.items.value.size).toBe(0);
    });
  });

  describe('applyDelta with added', () => {
    it('inserts new items', () => {
      store.applySnapshot([makeItem('a')]);
      store.applyDelta({ added: [makeItem('b'), makeItem('c')] });
      expect(store.items.value.size).toBe(3);
      expect(store.items.value.has('b')).toBe(true);
      expect(store.items.value.has('c')).toBe(true);
    });

    it('does not remove existing items', () => {
      store.applySnapshot([makeItem('a')]);
      store.applyDelta({ added: [makeItem('b')] });
      expect(store.items.value.has('a')).toBe(true);
    });
  });

  describe('applyDelta with removed', () => {
    it('deletes items by id', () => {
      store.applySnapshot([makeItem('a'), makeItem('b'), makeItem('c')]);
      store.applyDelta({ removed: [makeItem('b')] });
      expect(store.items.value.size).toBe(2);
      expect(store.items.value.has('b')).toBe(false);
    });

    it('is a no-op for ids not in the store', () => {
      store.applySnapshot([makeItem('a')]);
      store.applyDelta({ removed: [makeItem('nonexistent')] });
      expect(store.items.value.size).toBe(1);
    });
  });

  describe('applyDelta with updated', () => {
    it('merges updated items', () => {
      store.applySnapshot([makeItem('a', 'original', 1)]);
      store.applyDelta({ updated: [makeItem('a', 'changed', 99)] });
      expect(store.items.value.get('a')).toEqual({ id: 'a', name: 'changed', value: 99 });
    });

    it('preserves items not in updated list', () => {
      store.applySnapshot([makeItem('a'), makeItem('b')]);
      store.applyDelta({ updated: [makeItem('a', 'updated')] });
      expect(store.items.value.has('b')).toBe(true);
    });
  });

  describe('applyDelta combined', () => {
    it('applies removed, then updated, then added in order', () => {
      store.applySnapshot([makeItem('a'), makeItem('b'), makeItem('c')]);
      store.applyDelta({
        removed: [makeItem('c')],
        updated: [makeItem('b', 'b-updated')],
        added: [makeItem('d')],
      });
      expect(store.items.value.size).toBe(3);
      expect(store.items.value.has('c')).toBe(false);
      expect(store.items.value.get('b')?.name).toBe('b-updated');
      expect(store.items.value.has('d')).toBe(true);
    });
  });

  describe('clear', () => {
    it('empties items', () => {
      store.applySnapshot([makeItem('a'), makeItem('b')]);
      store.clear();
      expect(store.items.value.size).toBe(0);
    });

    it('resets loading and error signals', () => {
      store.loading.value = true;
      store.error.value = 'something went wrong';
      store.clear();
      expect(store.loading.value).toBe(false);
      expect(store.error.value).toBeNull();
    });
  });

  describe('getById', () => {
    it('returns the correct item', () => {
      const item = makeItem('x', 'hello', 42);
      store.applySnapshot([item]);
      expect(store.getById('x')).toEqual(item);
    });

    it('returns undefined for unknown ids', () => {
      store.applySnapshot([makeItem('a')]);
      expect(store.getById('missing')).toBeUndefined();
    });
  });

  describe('toArray', () => {
    it('returns all values', () => {
      store.applySnapshot([makeItem('a'), makeItem('b'), makeItem('c')]);
      const arr = store.toArray();
      expect(arr).toHaveLength(3);
      const ids = arr.map((i) => i.id).sort();
      expect(ids).toEqual(['a', 'b', 'c']);
    });

    it('returns empty array when store is empty', () => {
      expect(store.toArray()).toEqual([]);
    });
  });

  describe('signal reactivity', () => {
    it('a computed that reads items.value re-evaluates after applyDelta', () => {
      store.applySnapshot([makeItem('a')]);

      const itemCount = computed(() => store.items.value.size);
      expect(itemCount.value).toBe(1);

      store.applyDelta({ added: [makeItem('b')] });
      expect(itemCount.value).toBe(2);

      store.applyDelta({ removed: [makeItem('a')] });
      expect(itemCount.value).toBe(1);
    });

    it('a computed tracking a specific item re-evaluates after update', () => {
      store.applySnapshot([makeItem('a', 'initial', 0)]);

      const itemName = computed(() => store.items.value.get('a')?.name);
      expect(itemName.value).toBe('initial');

      store.applyDelta({ updated: [makeItem('a', 'updated', 0)] });
      expect(itemName.value).toBe('updated');
    });
  });
});
