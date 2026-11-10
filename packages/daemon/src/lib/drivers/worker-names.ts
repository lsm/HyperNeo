import type { NeoWorkerNameSource } from '../neo/worker-name.ts';
import type { Place, WorkAdapter } from './types.ts';
import { placeKey } from './places.ts';

export function createWorkerNameSource(
  adapters: () => readonly WorkAdapter[],
  fallback: Place
): NeoWorkerNameSource {
  const lanes = new Map<string, Promise<void>>();
  const read = async (id: string, requested?: Place) => {
    const place = requested ?? fallback;
    const adapter = adapters().find((adapter) => adapter.id === id);
    const groups =
      (await adapter?.find({
        folder: place.folder,
        spaceId: place.spaceId,
        includeClosed: false,
        all: true,
        limit: Number.MAX_SAFE_INTEGER,
      })) ?? [];
    return {
      place,
      taken: groups
        .flatMap((group) => group.work)
        .filter(
          (work) =>
            work.ref.adapter === id &&
            work.status !== 'stopped' &&
            placeKey(work.place) === placeKey(place)
        )
        .map((work) => (id === 'space' ? work.title.replace(/^#\d+ /, '') : work.title)),
    };
  };
  return Object.assign(read, {
    withStart<T>(id: string, requested: Place | undefined, start: () => Promise<T>) {
      const key = `${id}\u0000${placeKey(requested ?? fallback)}`;
      const previous = lanes.get(key) ?? Promise.resolve();
      const result = previous.then(start);
      const settled = result.then(
        () => {},
        () => {}
      );
      lanes.set(key, settled);
      void settled.then(() => {
        if (lanes.get(key) === settled) lanes.delete(key);
      });
      return result;
    },
  });
}
