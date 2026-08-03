import { describe, expect, it } from 'bun:test';
import {
  detectStateTransitions,
  type StateObservation,
} from '../../../../src/lib/external-events/github/state-transition';

type State = 'mergeable' | 'merge_blocked';

describe('detectStateTransitions', () => {
  it('reports nothing when no state changed', () => {
    const previous: Record<string, State> = { '5': 'mergeable', '7': 'merge_blocked' };
    const current: StateObservation<State>[] = [
      { key: '5', state: 'mergeable' },
      { key: '7', state: 'merge_blocked' },
    ];
    expect(detectStateTransitions(previous, current)).toEqual([]);
  });

  it('reports only the keys whose state changed', () => {
    const previous: Record<string, State> = { '5': 'mergeable', '7': 'merge_blocked' };
    const current: StateObservation<State>[] = [
      { key: '5', state: 'merge_blocked' },
      { key: '7', state: 'merge_blocked' },
    ];
    expect(detectStateTransitions(previous, current)).toEqual([
      { key: '5', from: 'mergeable', to: 'merge_blocked' },
    ]);
  });

  it('reports a first-ever observation with from === null', () => {
    const previous: Record<string, State> = {};
    const current: StateObservation<State>[] = [{ key: '5', state: 'merge_blocked' }];
    expect(detectStateTransitions(previous, current)).toEqual([
      { key: '5', from: null, to: 'merge_blocked' },
    ]);
  });

  it('detects a flip back to a previously-held state (A→B→A)', () => {
    const previous: Record<string, State> = { '5': 'merge_blocked' };
    const current: StateObservation<State>[] = [{ key: '5', state: 'mergeable' }];
    expect(detectStateTransitions(previous, current)).toEqual([
      { key: '5', from: 'merge_blocked', to: 'mergeable' },
    ]);
  });

  it('ignores keys absent from current (pruning is the caller job)', () => {
    const previous: Record<string, State> = { '5': 'mergeable', '99': 'merge_blocked' };
    const current: StateObservation<State>[] = [{ key: '5', state: 'mergeable' }];
    // PR 99 is not observed this cycle — no transition, but also not pruned here.
    expect(detectStateTransitions(previous, current)).toEqual([]);
  });

  it('preserves current order and dedupes repeated keys (first wins)', () => {
    const previous: Record<string, State> = { '5': 'mergeable' };
    const current: StateObservation<State>[] = [
      { key: '7', state: 'merge_blocked' },
      { key: '5', state: 'merge_blocked' },
      { key: '7', state: 'mergeable' }, // duplicate key ignored
    ];
    expect(detectStateTransitions(previous, current)).toEqual([
      { key: '7', from: null, to: 'merge_blocked' },
      { key: '5', from: 'mergeable', to: 'merge_blocked' },
    ]);
  });

  it('handles an empty current observation set', () => {
    expect(detectStateTransitions({ '5': 'mergeable' }, [])).toEqual([]);
  });

  it('is generic over the state union (works for arbitrary string states)', () => {
    type CI = 'green' | 'red' | 'pending';
    const previous: Record<string, CI> = { '1': 'green' };
    const current: StateObservation<CI>[] = [{ key: '1', state: 'red' }];
    expect(detectStateTransitions(previous, current)).toEqual([
      { key: '1', from: 'green', to: 'red' },
    ]);
  });
});
