import { signal } from '@preact/signals';

/**
 * EntityStore<T> — generic Map-backed signal store for entity collections.
 *
 * Encapsulates the snapshot/delta application logic that would otherwise be
 * duplicated across task, goal, and skill stores. Entities are keyed by their
 * `id` string field and stored in a `Map` for O(1) lookup.
 *
 * Usage:
 *   const store = new EntityStore<MyEntity>();
 *   store.applySnapshot(rows);                      // replace entire collection
 *   store.applyDelta({ added, removed, updated });  // incremental update
 *   store.getById('abc');                           // O(1) lookup
 *   store.toArray();                                // ordered values
 *   store.clear();                                  // reset on room switch
 */
export class EntityStore<T extends { id: string }> {
  /** All entities keyed by id */
  readonly items = signal<Map<string, T>>(new Map());

  /** True while the initial snapshot is in flight */
  readonly loading = signal(false);

  /** Set when a subscribe/fetch operation fails */
  readonly error = signal<string | null>(null);

  /**
   * Replace the entire collection with `rows`.
   * Sets `loading` to false — call after receiving a LiveQuery snapshot.
   */
  applySnapshot(rows: T[]): void {
    const map = new Map<string, T>();
    for (const row of rows) {
      map.set(row.id, row);
    }
    this.items.value = map;
    this.loading.value = false;
  }

  /**
   * Apply an incremental delta from a LiveQuery delta event.
   *
   * Order of application: removed → updated → added
   * This matches the semantics of a database change-set where an entity can be
   * removed and re-added (with a new id) in the same batch.
   */
  applyDelta(delta: { added?: T[]; removed?: T[]; updated?: T[] }): void {
    const map = new Map(this.items.value);

    if (delta.removed?.length) {
      for (const item of delta.removed) {
        map.delete(item.id);
      }
    }

    if (delta.updated?.length) {
      for (const item of delta.updated) {
        map.set(item.id, item);
      }
    }

    if (delta.added?.length) {
      for (const item of delta.added) {
        map.set(item.id, item);
      }
    }

    this.items.value = map;
  }

  /** O(1) lookup by entity id. Returns undefined if not found. */
  getById(id: string): T | undefined {
    return this.items.value.get(id);
  }

  /** Returns all entities as an array (insertion/update order). */
  toArray(): T[] {
    return Array.from(this.items.value.values());
  }

  /** Empties the store — call on room switch or teardown. */
  clear(): void {
    this.items.value = new Map();
    this.loading.value = false;
    this.error.value = null;
  }
}
