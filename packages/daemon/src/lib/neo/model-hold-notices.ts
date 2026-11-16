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
  for (const session of working) {
    const hold = session.role && session.modelHold;
    if (!hold) continue;
    const key = `${MODEL_HOLD_NOTICE_PREFIX}${session.sessionId}`;
    const listed = JSON.stringify([root, hold.provider, hold.reason, hold.since]);
    const known = previous.get(key)?.listed === listed;
    const qualifies =
      hold.reason === 'login' ||
      (hold.reason === 'limit' &&
        (known || Math.max(now, hold.resetAt ?? now) - hold.since > LONG_HOLD_MS));
    if (!qualifies) continue;
    const notice: NeoSessionNotice = {
      key,
      ref: { adapter: 'hyperneo', id: root },
      title: session.title,
      kind: 'needs_you',
      at: hold.since,
    };
    seen.set(key, { listed, status: 'needs_you' });
    active.push(notice);
    if (!known) added.push(notice);
  }
  return { seen, active, added };
}
