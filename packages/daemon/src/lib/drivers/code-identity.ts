import simpleGit from 'simple-git';
import type { Place, PlaceGroup } from './types.ts';

type CodeIdentity = Pick<Place, 'codeIdentity' | 'remotes'>;

export async function readCodeIdentity(folder: string): Promise<CodeIdentity> {
  try {
    const git = simpleGit({ baseDir: folder, timeout: { block: 3_000 } });
    if ((await git.raw(['rev-parse', '--is-shallow-repository'])).trim() !== 'false') return {};
    const roots = (await git.raw(['--no-replace-objects', 'rev-list', '--max-parents=0', 'HEAD']))
      .trim()
      .split(/\s+/)
      .filter((root) => /^[a-f0-9]{40,64}$/.test(root))
      .sort();
    if (!roots.length) return {};
    const remotes = await git.getRemotes(true);
    return {
      codeIdentity: `git:${roots.join(':')}`,
      remotes: [...new Set(remotes.flatMap(({ refs }) => [refs.fetch, refs.push]).filter(Boolean))],
    };
  } catch {
    return {};
  }
}

export function createCodeIdentityReader(
  read = readCodeIdentity,
  now = Date.now
): (folder: string, refresh?: boolean) => Promise<CodeIdentity> {
  const cache = new Map<string, { until: number; value: Promise<CodeIdentity> }>();
  return (folder, refresh = false) => {
    const known = cache.get(folder);
    if (!refresh && known && known.until > now()) return known.value;
    const value = read(folder);
    cache.delete(folder);
    cache.set(folder, { until: now() + 60_000, value });
    if (cache.size > 1024) cache.delete(cache.keys().next().value!);
    return value;
  };
}

export async function identifyWorkspaces(
  groups: readonly PlaceGroup[],
  read: (folder: string) => Promise<CodeIdentity> = readCodeIdentity
): Promise<PlaceGroup[]> {
  const identities = new Map<string, CodeIdentity>();
  const folders = [
    ...new Set(
      groups.flatMap((group) =>
        [...(group.workspaces ?? [group.place]), ...group.work.map((work) => work.place)].flatMap(
          (place) => place.folder ?? []
        )
      )
    ),
  ];
  for (let offset = 0; offset < folders.length; offset += 8) {
    await Promise.all(
      folders.slice(offset, offset + 8).map(async (folder) => {
        identities.set(folder, await read(folder));
      })
    );
  }
  const identify = (place: Place): Place => ({
    ...place,
    ...(place.folder ? identities.get(place.folder) : {}),
  });
  return groups.map((group) => ({
    ...group,
    place: identify(group.place),
    workspaces: [
      ...(group.workspaces ?? [group.place]),
      ...group.work.map((work) => work.place),
    ].map(identify),
    work: group.work.map((work) => ({ ...work, place: identify(work.place) })),
  }));
}
