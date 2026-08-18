import { describe, expect, test } from 'bun:test';
import { isBroadcastHandoffTarget, resolveHandoffTransition } from '../src/lib/workflow-handoff.ts';
import { HANDOFF_TARGET_WILDCARD } from '../src/types/space.ts';
import type { HandoffTransition } from '../src/types/space.ts';

function transition(overrides: Partial<HandoffTransition> & { id: string }): HandoffTransition {
  return { target: 'Review', ...overrides };
}

describe('resolveHandoffTransition', () => {
  test('returns no_transitions when the node declares none', () => {
    expect(resolveHandoffTransition(undefined, 'Review')).toEqual({
      ok: false,
      reason: 'no_transitions',
    });
    expect(resolveHandoffTransition([], 'Review')).toEqual({ ok: false, reason: 'no_transitions' });
  });

  test('resolves an exact named target to its transition', () => {
    const t = transition({ id: 'to-review', target: 'Review', hookId: 'h1' });
    const result = resolveHandoffTransition([t], 'Review');
    expect(result).toEqual({ ok: true, transition: t });
  });

  test('resolves an agent-slot target, not just node names', () => {
    const t = transition({ id: 'to-reviewer-slot', target: 'Reviewer' });
    expect(resolveHandoffTransition([t], 'Reviewer')).toEqual({ ok: true, transition: t });
  });

  test('returns unknown_target when no transition matches', () => {
    const t = transition({ id: 'to-review', target: 'Review' });
    expect(resolveHandoffTransition([t], 'QA')).toEqual({ ok: false, reason: 'unknown_target' });
  });

  test('the broadcast wildcard is a literal target, not a catch-all', () => {
    const broadcast = transition({ id: 'broadcast', target: HANDOFF_TARGET_WILDCARD });
    expect(resolveHandoffTransition([broadcast], 'Review')).toEqual({
      ok: false,
      reason: 'unknown_target',
    });
    expect(resolveHandoffTransition([broadcast], HANDOFF_TARGET_WILDCARD)).toEqual({
      ok: true,
      transition: broadcast,
    });
  });

  test('returns ambiguous when two transitions share a target (defensive)', () => {
    const a = transition({ id: 'a', target: 'Review' });
    const b = transition({ id: 'b', target: 'Review', hookId: 'h1' });
    expect(resolveHandoffTransition([a, b], 'Review')).toEqual({ ok: false, reason: 'ambiguous' });
  });

  test('matches only the requested target when several transitions exist', () => {
    const toReview = transition({ id: 'to-review', target: 'Review' });
    const toQA = transition({ id: 'to-qa', target: 'QA', hookId: 'h1' });
    expect(resolveHandoffTransition([toReview, toQA], 'QA')).toEqual({
      ok: true,
      transition: toQA,
    });
  });
});

describe('isBroadcastHandoffTarget', () => {
  test('true only for the wildcard', () => {
    expect(isBroadcastHandoffTarget(HANDOFF_TARGET_WILDCARD)).toBe(true);
    expect(isBroadcastHandoffTarget('*')).toBe(true);
    expect(isBroadcastHandoffTarget('Review')).toBe(false);
    expect(isBroadcastHandoffTarget('')).toBe(false);
  });
});
