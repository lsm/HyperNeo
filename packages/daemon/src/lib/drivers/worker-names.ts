import type { NeoWorkerNameSource } from '../neo/worker-name.ts';
import type { Place, WorkAdapter } from './types.ts';
import { placeKey } from './places.ts';

export function createWorkerNameSource(
  adapters: () => readonly WorkAdapter[],
  fallback: Place
): NeoWorkerNameSource {
  return async (id, requested) => {
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
        .map((work) => work.title),
    };
  };
}
