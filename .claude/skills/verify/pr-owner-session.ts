import type { NeoSessionFacts } from '../../../packages/daemon/src/lib/neo/packs/types.ts';
import { codingRemoteRepo } from '../../../packages/daemon/src/lib/neo/packs/coding/pr-ledger.ts';
import { codingPrKey } from '../../../packages/daemon/src/lib/neo/packs/coding/todo-prs.ts';

export function claudeOwnerSession(value: NeoSessionFacts) {
  const keys = (urls: string[]) => urls.flatMap((url) => codingPrKey(url) ?? []);
  const linked = value.linkedPrs ?? [];
  return {
    ref: JSON.stringify(value.ref),
    active: value.lastActivityAt,
    repos: value.remotes.flatMap((remote) => codingRemoteRepo(remote) ?? []),
    branches: value.branches,
    owned: keys(linked.filter((pr) => pr.own && !pr.dismissed).map((pr) => pr.url)),
    prs: [] as string[],
    dismissed: keys(linked.filter((pr) => pr.dismissed).map((pr) => pr.url)),
  };
}
