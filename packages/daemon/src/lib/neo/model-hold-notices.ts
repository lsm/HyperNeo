import type { NeoSessionNotice, NeoWorkingSession } from '@hyperneo/shared/types/neo-snapshot';
import type { NeoSessionSeen } from './session-watch.ts';

export const MODEL_HOLD_NOTICE_PREFIX = 'model-hold:';
const LONG_HOLD_MS = 30 * 60_000;

export function planModelHoldNotices(
  root: string,
  working: readonly NeoWorkingSession[],
  previous: ReadonlyMap<string, NeoSessionSeen>,
  now: number
) {
  const seen = new Map<string, NeoSessionSeen>();
  const active: NeoSessionNotice[] = [];
  const added: NeoSessionNotice[] = [];
  const groups = new Map<string, NeoWorkingSession[]>();
  for (const session of working) {
    const hold = session.role && session.modelHold;
    if (!hold) continue;
    const key = `${MODEL_HOLD_NOTICE_PREFIX}${hold.provider}:${hold.reason}`;
    const group = groups.get(key) ?? [];
    group.push(session);
    groups.set(key, group);
  }
  for (const [key, group] of groups) {
    const session = group.find((entry) => entry.role === 'neo') ?? group[0];
    const holds = group.map((entry) => entry.modelHold!);
    const episodes = group.map((entry) =>
      JSON.stringify([root, entry.sessionId, entry.modelHold!.since])
    );
    const recorded = JSON.parse(previous.get(key)?.listed ?? '[]') as string[];
    const known = episodes.some((episode) => recorded.includes(episode));
    const qualifies =
      holds[0].reason === 'login' ||
      (holds[0].reason === 'limit' &&
        (known ||
          holds.some((hold) => Math.max(now, hold.resetAt ?? now) - hold.since > LONG_HOLD_MS)));
    if (!qualifies) continue;
    const notice: NeoSessionNotice = {
      key,
      ref: { adapter: 'hyperneo', id: root },
      title: session.title,
      kind: 'needs_you',
      at: Math.min(...holds.map((hold) => hold.since)),
    };
    seen.set(key, { listed: JSON.stringify(episodes), status: 'needs_you' });
    active.push(notice);
    if (!known) added.push(notice);
  }
  return { seen, active, added };
}
