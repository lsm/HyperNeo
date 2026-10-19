import type { NeoAsk } from '@hyperneo/shared/types/neo-ask';
import type { NeoAskTodoRepository } from '../../storage/repositories/neo-ask-todo-repository.ts';
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

export function neoRepoName(repo: string): string {
  return repo.split('/').at(-1) ?? repo;
}

export function neoTodoHome(
  store: NeoAskTodoRepository,
  ask: NeoAsk,
  repo: string | null,
  split: boolean
): NeoAsk {
  if (!repo || (!split && (!ask.repo || ask.repo === repo))) return ask;
  return (
    store.childAsk(ask.id, repo) ??
    store.openAsk({
      id: crypto.randomUUID(),
      projectId: ask.projectId,
      sessionId: ask.sessionId,
      originMessageId: ask.originMessageId,
      title: `${ask.title} · ${neoRepoName(repo)}`,
      request: ask.request,
      createdAt: Date.now(),
      repo,
      parentId: ask.id,
    })
  );
}

export function neoSplitOutcome(children: readonly NeoAsk[], filed: number): string {
  const names = children.flatMap((child) => (child.repo ? [neoRepoName(child.repo)] : []));
  return `Filed ${filed} todo${filed === 1 ? '' : 's'} across ${names.join(', ')} cards.`;
}
