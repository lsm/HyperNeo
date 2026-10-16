import { basename, dirname } from 'node:path';
import simpleGit from 'simple-git';
import type { Place, PlaceGroup } from './types.ts';

type CodeIdentity = Pick<Place, 'codeIdentity' | 'remotes' | 'repoName'>;

export function repoNameFromRemote(remote: string | undefined): string | null {
  const name = remote
    ?.trim()
    .replace(/\/+$/, '')
    .replace(/\.git$/, '')
    .split(/[/:]/)
    .at(-1);
  return name || null;
}

export function repoNameFromCommonDir(commonDir: string): string | null {
  const root = basename(commonDir) === '.git' ? dirname(commonDir) : commonDir;
  return basename(root).replace(/\.git$/, '') || null;
}

export async function readCodeIdentity(folder: string): Promise<CodeIdentity> {
  try {
    const git = simpleGit({ baseDir: folder, timeout: { block: 3_000 } });
    const shallow = (await git.raw(['rev-parse', '--is-shallow-repository'])).trim() !== 'false';
    const remotes = [
      ...new Set(
        (await git.getRemotes(true))
          .sort((a, b) => Number(b.name === 'origin') - Number(a.name === 'origin'))
          .flatMap(({ refs }) => [refs.fetch, refs.push])
          .filter(Boolean)
      ),
    ];
    const commonDir = (
      await git.raw(['rev-parse', '--path-format=absolute', '--git-common-dir'])
    ).trim();
    const repoName = repoNameFromRemote(remotes[0]) ?? repoNameFromCommonDir(commonDir);
    const named = repoName ? { repoName } : {};
    if (shallow) return remotes.length ? { remotes, ...named } : named;
    const roots = (await git.raw(['--no-replace-objects', 'rev-list', '--max-parents=0', 'HEAD']))
      .trim()
      .split(/\s+/)
      .filter((root) => /^[a-f0-9]{40,64}$/.test(root))
      .sort();
    if (!roots.length) return named;
    return { codeIdentity: `git:${roots.join(':')}`, remotes, ...named };
  } catch {
    return {};
  }
}

export function createCodeIdentityReader(read = readCodeIdentity, now = Date.now) {
  const cache = new Map<string, { until: number; value: Promise<CodeIdentity> }>();
  return (folder: string, refresh = false) => {
    const known = cache.get(folder);
    if (!refresh && known && known.until > now()) return known.value;
    const value = read(folder);
    cache.set(folder, { until: now() + 60_000, value });
    if (cache.size > 1024) cache.delete(cache.keys().next().value!);
    return value;
  };
}

export const readWorkspaceIdentity = createCodeIdentityReader();

export async function identifyWorkspaces(
  groups: readonly PlaceGroup[],
  read: (folder: string) => Promise<CodeIdentity> = readWorkspaceIdentity
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
    workspaces: (group.workspaces ?? [group.place])
      .concat(group.work.map((work) => work.place))
      .map(identify),
    work: group.work.map((work) => ({ ...work, place: identify(work.place) })),
  }));
}
