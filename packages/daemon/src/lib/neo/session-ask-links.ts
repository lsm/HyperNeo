import type { WorkStatus } from '../drivers/types.ts';
import type { NeoListedSession } from './session-watch.ts';

export const NEO_SESSION_READS_MAX = 10;
export const NEO_SESSION_RECHECK_MS = 10 * 60_000;
const needsHuman = (status: WorkStatus) => status === 'needs_you' || status === 'failed';

export function planNeoSessionReads(
  listed: readonly NeoListedSession[],
  reading: readonly NeoListedSession[],
  checkedAt: ReadonlyMap<string, number>,
  now: number
): NeoListedSession[] {
  const read = new Set(reading.map((session) => session.key));
  const rank = (session: NeoListedSession) => (needsHuman(session.status) ? 0 : 1);
  const due = (key: string) => now - (checkedAt.get(key) ?? 0) >= NEO_SESSION_RECHECK_MS;
  return listed
    .filter((session) => due(session.key) && !read.has(session.key))
    .sort((a, b) => rank(a) - rank(b) || b.lastActivityAt - a.lastActivityAt)
    .slice(0, NEO_SESSION_READS_MAX);
}
