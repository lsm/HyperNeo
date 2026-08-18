import { signal } from '@preact/signals';

export class EntityStore<T extends { id: string }> {
  readonly items = signal<Map<string, T>>(new Map());

  readonly loading = signal(false);

  readonly error = signal<string | null>(null);

  applySnapshot(rows: T[]): void {
    const map = new Map<string, T>();
    for (const row of rows) {
      map.set(row.id, row);
    }
    this.items.value = map;
    this.loading.value = false;
  }

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

  getById(id: string): T | undefined {
    return this.items.value.get(id);
  }

  toArray(): T[] {
    return Array.from(this.items.value.values());
  }

  clear(): void {
    this.items.value = new Map();
    this.loading.value = false;
    this.error.value = null;
  }
}
