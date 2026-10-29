import { existsSync } from 'node:fs';
import { opendir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import superpipe, { type PipelineAPI } from 'superpipe';
import { skipSpaceQuery } from './hyperneo-adapter.ts';
import { mergePlaceGroups } from './places.ts';
import type { FindQuery, PlaceGroup, WorkAdapter, WorkSummary } from './types.ts';

type OwnedSummary = WorkSummary & { archived?: boolean };

export function copilotOwnsSession(directory: string, id: string): boolean {
  return /^[0-9a-f-]{36}$/.test(id) && existsSync(join(directory, `${id}.json`));
}

export function createCopilotFind(
  discovery: WorkAdapter,
  directory: string,
  owns: (id: string) => boolean,
  summary: (id: string) => Promise<OwnedSummary | undefined>
) {
  let listing: Promise<string[]> | undefined;
  const list = () =>
    (listing ??= (async () => {
      const ids: { id: string; at: number }[] = [];
      try {
        const dir = await opendir(directory, { bufferSize: 64 });
        try {
          for (let scanned = 0; scanned < 4096; scanned++) {
            const entry = await dir.read();
            if (!entry) break;
            if (entry.isFile() && /^[0-9a-f-]{36}\.json$/.test(entry.name))
              ids.push({
                id: entry.name.slice(0, -5),
                at: (await stat(join(directory, entry.name))).mtimeMs,
              });
          }
        } finally {
          await dir.close();
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      return ids
        .sort((a, b) => b.at - a.at)
        .slice(0, 200)
        .map((item) => item.id);
    })().finally(() => {
      listing = undefined;
    }));
  const loadOwned = async () => {
    const owned: OwnedSummary[] = [];
    for (const id of await list()) {
      const work = await summary(id);
      if (work) owned.push(work);
    }
    return owned;
  };
  const load = async (query: FindQuery) => {
    const [external, owned] = await Promise.allSettled([
      Promise.resolve().then(() => discovery.find(query)),
      loadOwned(),
    ]);
    if (owned.status === 'rejected') throw owned.reason;
    if (external.status === 'rejected' && !owned.value.length) throw external.reason;
    return {
      external: external.status === 'fulfilled' ? external.value : [],
      owned:
        external.status === 'fulfilled'
          ? owned.value
          : owned.value.map((work) => ({
              ...work,
              watchHint:
                `${work.watchHint ?? ''} External Copilot discovery unavailable; this list contains owned work only.`.trim(),
            })),
    };
  };
  const combine = (loaded: { external: PlaceGroup[]; owned: OwnedSummary[] }, query: FindQuery) => {
    const external = loaded.external.map((group) => {
      const work = group.work.filter((item) => !owns(item.ref.id));
      return {
        ...group,
        work,
        openCount: Math.max(0, group.openCount - (group.work.length - work.length)),
      };
    });
    const groups = loaded.owned.map(({ archived, ...work }) => ({
      place: work.place,
      lastActivityAt: work.lastActivityAt,
      openCount: archived ? 0 : 1,
      archivedCount: archived ? 1 : 0,
      adapters: [discovery.id],
      work: [work],
    }));
    const text = query.text?.toLowerCase();
    return mergePlaceGroups([...external, ...groups], Number.MAX_SAFE_INTEGER).flatMap((group) => {
      if (query.folder && group.place.folder !== query.folder) return [];
      const placeMatches =
        !text || `${group.place.name} ${group.place.folder ?? ''}`.toLowerCase().includes(text);
      const work = group.work
        .filter(
          (item) =>
            (query.includeClosed || item.status !== 'stopped') &&
            (placeMatches || item.title.toLowerCase().includes(text!))
        )
        .slice(0, 20);
      return work.length || (placeMatches && !text) ? [{ ...group, work }] : [];
    });
  };
  return (superpipe({})('copilot-find') as PipelineAPI)
    .input(['query'])
    .pipe(skipSpaceQuery, 'query', 'result:groups')
    .pipe(load, 'query', 'loaded')
    .pipe(combine, ['loaded', 'query'], 'groups')
    .endAsync('groups') as (query: FindQuery) => Promise<PlaceGroup[]>;
}
