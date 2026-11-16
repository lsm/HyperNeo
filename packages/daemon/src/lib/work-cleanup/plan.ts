import type { NeoTodo } from '@hyperneo/shared/types/neo-ask';

export type WorkOwner =
  | { kind: 'todo'; state: NeoTodo['state']; boundToLiveTodo: boolean }
  | { kind: 'session'; archived: boolean };

export type WorkFolderFacts = {
  owner: WorkOwner | null | 'unreadable';
  inUse: boolean | 'unreadable';
  unsaved: boolean | 'unreadable';
  evidence?: { since: number | null; referenced: boolean | 'unreadable' };
};

export type WorkRelease =
  | { remove: 'todo done' | 'todo removed' | 'session archived' }
  | { keep: 'unknown' | 'live' | 'in_use' | 'unsaved' | 'evidence' };

const DAY = 24 * 60 * 60 * 1000;
const LIVE: readonly NeoTodo['state'][] = ['todo', 'doing', 'blocked', 'failed'];

export function planWorkRelease(
  facts: WorkFolderFacts,
  now: number,
  evidenceDays = 7
): WorkRelease {
  const { owner, evidence } = facts;
  if (owner === null) return { keep: 'unknown' };
  if (
    owner === 'unreadable' ||
    (owner.kind === 'todo' && (LIVE.includes(owner.state) || owner.boundToLiveTodo)) ||
    (owner.kind === 'session' && !owner.archived)
  )
    return { keep: 'live' };
  if (facts.inUse !== false) return { keep: 'in_use' };
  if (facts.unsaved !== false) return { keep: 'unsaved' };
  if (
    evidence &&
    (evidence.since === null ||
      now - evidence.since < evidenceDays * DAY ||
      evidence.referenced !== false)
  )
    return { keep: 'evidence' };
  if (owner.kind === 'session') return { remove: 'session archived' };
  return owner.state === 'done' ? { remove: 'todo done' } : { remove: 'todo removed' };
}
