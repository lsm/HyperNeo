import type { NeoAsk, NeoTodo } from '@hyperneo/shared/types/neo-ask';
import type { NeoDriverTarget, NeoTodoTarget } from './driver-work.ts';
import type { NeoPack } from './pack-contract.ts';
import { neoRepositoryIdentity } from './project-mirror.ts';

type Draft = Pick<NeoTodo, 'check' | 'named'> & {
  id?: string;
  target?: NeoDriverTarget | NeoTodoTarget | null;
};

export function neoGitRepo(remote: string | undefined): string | null {
  return neoRepositoryIdentity(remote)?.slice('repository:'.length) ?? null;
}

export function neoTodoRepo(
  draft: Draft,
  packs: readonly { todos?: Pick<NonNullable<NeoPack['todos']>, 'repository'> }[],
  ask: Pick<NeoAsk, 'repo'>
): string | null {
  const place = draft.target?.verb === 'start' ? draft.target.place : null;
  return (
    packs.map((pack) => pack.todos?.repository?.(draft) ?? null).find(Boolean) ??
    place?.remotes?.map(neoGitRepo).find(Boolean) ??
    (place ? null : ask.repo)
  );
}
