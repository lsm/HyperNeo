import type { NeoAsk, NeoTodo } from '@hyperneo/shared/types/neo-ask';
import type { NeoAskTodoRepository } from '../../storage/repositories/neo-ask-todo-repository.ts';
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
  if (!repo || ask.repo === repo || (!split && !ask.repo)) return ask;
  const child = store.childAsk(ask.id, repo);
  if (child || ask.status !== 'open') return child ?? ask;
  return neoChildAsk(store, ask, repo);
}

function neoChildAsk(store: NeoAskTodoRepository, ask: NeoAsk, repo: string): NeoAsk {
  return store.openAsk({
    id: crypto.randomUUID(),
    projectId: ask.projectId,
    sessionId: ask.sessionId,
    originMessageId: ask.originMessageId,
    title: `${ask.title} · ${neoRepoName(repo)}`,
    request: ask.request,
    createdAt: Date.now(),
    repo,
    parentId: ask.id,
    goalId: ask.goalId ?? null,
  });
}

export function neoMoveTodo(
  store: NeoAskTodoRepository,
  todo: NeoTodo,
  repo: string | null
): NeoTodo | null {
  const ask = store.getAsk(todo.askId);
  if (!repo || todo.repo === repo || ask?.status !== 'open') return null;
  const root = (ask.parentId && store.getAsk(ask.parentId)) || ask;
  const home =
    root.repo === repo
      ? root
      : (store.childAsk(root.id, repo) ??
        (!ask.repo && !store.listChildAsks(root.id).length
          ? ask
          : root.status === 'open'
            ? neoChildAsk(store, root, repo)
            : root));
  return home.status === 'open' ? store.moveTodo(todo, home.id, repo, Date.now()) : null;
}

export function neoSplitOutcome(children: readonly NeoAsk[], filed: number): string {
  const names = children.flatMap((child) => (child.repo ? [neoRepoName(child.repo)] : []));
  return `Filed ${filed} todo${filed === 1 ? '' : 's'} across ${names.join(', ')} cards.`;
}
