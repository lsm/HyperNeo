import type { NeoAsk } from '@hyperneo/shared/types/neo-ask';
import type { z } from 'zod';
import type { NeoTodoDraftSchema } from './todo-operations.ts';
import type { NeoPack } from './packs/types.ts';
import { neoRepositoryIdentity } from './project-mirror.ts';

type Draft = z.infer<typeof NeoTodoDraftSchema>;

export function neoGitRepo(remote: string | undefined): string | null {
  return neoRepositoryIdentity(remote)?.slice('repository:'.length) ?? null;
}

export function neoTodoRepo(
  draft: Draft,
  packs: readonly NeoPack[],
  ask: Pick<NeoAsk, 'repo'>
): string | null {
  const place = draft.target?.verb === 'start' ? draft.target.place : null;
  return (
    packs.map((pack) => pack.todos?.repository?.(draft) ?? null).find(Boolean) ??
    place?.remotes?.map(neoGitRepo).find(Boolean) ??
    ask.repo
  );
}
