import type { NeoWork } from '@hyperneo/shared/types/neo-context';

type Rejection = { ok: false; reason: string };

export function requireNeoWorkSupersedable<T>(
  input: { supersedes?: string; concernId: string | null },
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
