import type { WorkRef } from '../drivers/types.ts';
import { neoSessionKey, type NeoSessionNotice } from './session-watch.ts';

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
