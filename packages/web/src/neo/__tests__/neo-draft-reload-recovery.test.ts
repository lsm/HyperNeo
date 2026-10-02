import { describe, expect, it } from 'vitest';
import {
  admitNeoDraftRecovery,
  requireUntouchedComposer,
  settleNeoDraftRecovery,
} from '../useNeoDraftReloadRecovery.ts';

const entry = { id: 'capture', sessionId: 'neo:fictional', text: 'Newest edit', base: 'Saved' };

describe('reload draft recovery settlement', () => {
  it.each([
    [{ ok: true, notified: true }, 'restore'],
    [{ ok: true, notified: false }, 'restore'],
    [{ ok: false, reason: 'superseded' }, 'forget'],
    [{ ok: false, reason: 'submitted' }, 'forget'],
    [{ ok: false, reason: 'human_only' }, 'keep'],
    [{ ok: false, reason: 'session_not_found' }, 'keep'],
    [null, 'keep'],
    ['accepted', 'keep'],
    [{ kind: 'failed' }, 'keep'],
  ])('settles %j as %s on an untouched composer', (result, expected) => {
    expect(settleNeoDraftRecovery(result, entry, 'Saved')).toBe(expected);
  });

  it.each(['', '  ', 'Saved', ' Saved ', 'Newest edit'])('treats %j as untouched', (visible) => {
    expect(requireUntouchedComposer(entry, visible)).toBe('restore');
  });

  it('keeps text typed after the reload', () => {
    expect(settleNeoDraftRecovery({ ok: true }, entry, 'Something new')).toBe('keep');
    expect(requireUntouchedComposer({ ...entry, base: null }, 'Saved')).toBe('keep');
  });

  it('admits only an explicit ok', () => {
    expect(admitNeoDraftRecovery({ ok: true })).toEqual({ value: { ok: true } });
    expect(admitNeoDraftRecovery({ ok: 'true' })).toEqual({ reason: 'keep' });
  });
});
