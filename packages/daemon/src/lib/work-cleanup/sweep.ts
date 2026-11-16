import { isAbsolute, relative, resolve, sep } from 'node:path';
import superpipe, { type PipelineAPI } from 'superpipe';
import { planWorkRelease, type WorkFolderFacts } from './plan.ts';

type Digest = { removed: { directory: string; reason: string }[]; kept: Record<string, string[]> };
type Dependencies = {
  list(): Promise<string[]>;
  read(folder: string): Promise<WorkFolderFacts>;
  release(folder: string): Promise<true | { keep: string }>;
  tell(digest: Digest): Promise<void>;
};

export function insideFolder(root: string, path: string): boolean {
  const child = relative(resolve(root), resolve(path));
  return !isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`);
}

export function listWorkCleanupFolders(
  folders: readonly string[],
  owned: readonly { path: string }[],
  sharedRoots: readonly string[]
): string[] {
  const known = new Set(owned.map(({ path }) => resolve(path)));
  return [...new Set(folders)].filter(
    (folder) =>
      known.has(resolve(folder)) || !sharedRoots.some((root) => insideFolder(root, folder))
  );
}

export const sweepWorkCleanup = (superpipe({})('work.cleanup.sweep') as PipelineAPI)
  .input('deps')
  .pipe((deps: Dependencies) => deps.list(), 'deps', 'folders')
  .pipe(
    async (folders: string[], deps: Dependencies) => {
      const digest: Digest = { removed: [], kept: {} };
      const plan = async (folder: string) => {
        try {
          return planWorkRelease(await deps.read(folder), Date.now());
        } catch {
          return { keep: 'error' } as const;
        }
      };
      const initial: { folder: string; plan: Awaited<ReturnType<typeof plan>> }[] = [];
      for (let offset = 0; offset < folders.length; offset += 4)
        initial.push(
          ...(await Promise.all(
            folders.slice(offset, offset + 4).map(async (folder) => ({
              folder,
              plan: await plan(folder),
            }))
          ))
        );
      for (const { folder, plan: first } of initial) {
        const fresh = 'remove' in first ? await plan(folder) : first;
        const released =
          'remove' in fresh ? await deps.release(folder).catch(() => ({ keep: 'error' })) : fresh;
        const outcome = released === true ? fresh : released;
        if ('remove' in outcome) digest.removed.push({ directory: folder, reason: outcome.remove });
        else (digest.kept[outcome.keep] ??= []).push(folder);
      }
      return digest;
    },
    ['folders', 'deps'],
    'digest'
  )
  .pipe(
    async (digest: Digest, deps: Dependencies) => {
      await deps.tell(digest);
      return digest;
    },
    ['digest', 'deps'],
    'digest'
  )
  .endAsync('digest') as (deps: Dependencies) => Promise<Digest>;
