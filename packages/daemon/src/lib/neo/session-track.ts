import type { NeoDriverTarget } from './driver-work.ts';
import type { WorkRef } from '../drivers/types.ts';
import { neoSessionKey, type NeoSessionNotice } from './session-watch.ts';

export const NEO_SESSION_TRACK_MS = 60 * 60_000;

type Rejection = { ok: false; reason: string };

export function requireNeoTrackRoot(
  root: string | undefined
): { value: string } | { reason: Rejection } {
  return root
    ? { value: root }
    : { reason: { ok: false, reason: 'Neo has not started yet; open Neo once, then tap Track.' } };
}

export function findNeoSessionNotice(
  notices: readonly NeoSessionNotice[],
  key: string
): { value: NeoSessionNotice } | { reason: Rejection } {
  const notice = notices.findLast((item) => item.key === key);
  return notice
    ? { value: notice }
    : { reason: { ok: false, reason: 'No notice for this session; track it from its notice.' } };
}

export function requireNeoTrackableSession(
  notice: NeoSessionNotice,
  followed: readonly WorkRef[]
): { value: NeoSessionNotice } | { reason: Rejection } {
  return followed.some((item) => neoSessionKey(item) === notice.key)
    ? { reason: { ok: false, reason: 'A Neo card already follows this session.' } }
    : { value: notice };
}

export function keepNeoTrackedSessions(
  tracked: ReadonlyMap<string, number>,
  key: string,
  now: number
): Map<string, number> {
  const kept = new Map([...tracked].filter(([, at]) => now - at < NEO_SESSION_TRACK_MS));
  kept.set(key, kept.get(key) ?? now);
  return kept;
}

export function reserveNeoAdoption(
  adopting: Set<string>,
  target: NeoDriverTarget | undefined
): { value: string | null } | { reason: Rejection } {
  if (target?.verb !== 'adopt') return { value: null };
  const key = neoSessionKey(target.ref);
  if (adopting.has(key))
    return { reason: { ok: false, reason: 'This session is already being adopted.' } };
  adopting.add(key);
  return { value: key };
}

export function requireNeoTrackedAdoption<T>(
  target: NeoDriverTarget | undefined,
  followed: readonly WorkRef[],
  value: T
): { value: T } | { reason: Rejection } {
  if (target?.verb !== 'adopt') return { value };
  const key = neoSessionKey(target.ref);
  if (followed.some((item) => neoSessionKey(item) === key))
    return { reason: { ok: false, reason: 'A Neo card already follows this session.' } };
  return { value };
}
