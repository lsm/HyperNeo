import type { NeoWork } from '@hyperneo/shared/types/neo-context';

type Rejection = { ok: false; reason: string };
type SupersedeInput = { supersedes?: string | null; concernId: string | null };

export const NEO_SUPERSEDE_WINDOW_MS = 3 * 24 * 60 * 60_000;

export function neoWorkSupersedeCandidates(
  works: readonly Pick<NeoWork, 'id' | 'title' | 'status' | 'concernId' | 'updatedAt'>[],
  superseded: ReadonlySet<string>,
  concernId: string | null,
  now: number
): { id: string; title: string }[] {
  return works
    .filter(
      (work) =>
        work.concernId === concernId &&
        (work.status === 'failed' || work.status === 'cancelled') &&
        now - work.updatedAt < NEO_SUPERSEDE_WINDOW_MS &&
        !superseded.has(work.id)
    )
    .slice(0, 3)
    .map(({ id, title }) => ({ id, title }));
}

export function requireNeoWorkSupersedeDecision<T>(
  input: SupersedeInput,
  candidates: readonly { id: string; title: string }[],
  admitted: T
): { value: T } | { reason: Rejection } {
  if (input.supersedes !== undefined || candidates.length === 0) return { value: admitted };
  const listed = candidates.map((work) => `${work.id} ("${work.title}")`).join(', ');
  return {
    reason: {
      ok: false,
      reason: `This concern has failed or cancelled work from the last three days: ${listed}. Pass supersedes with the id this work replaces, or supersedes: null if it replaces none.`,
    },
  };
}

export function requireNeoWorkSupersedable<T>(
  input: SupersedeInput,
  old: Pick<NeoWork, 'id' | 'status' | 'concernId'> | null,
  admitted: T
): { value: T } | { reason: Rejection } {
  if (!input.supersedes) return { value: admitted };
  if (!old) return { reason: { ok: false, reason: 'The work this supersedes was not found.' } };
  if (old.status !== 'failed' && old.status !== 'cancelled')
    return {
      reason: {
        ok: false,
        reason: `Only failed or cancelled work can be superseded; ${old.id} is ${old.status}.`,
      },
    };
  return old.concernId === input.concernId
    ? { value: admitted }
    : { reason: { ok: false, reason: 'The work this supersedes belongs to another concern.' } };
}
