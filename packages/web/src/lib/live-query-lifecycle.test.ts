import { describe, expect, it } from 'vitest';
import {
  createLiveQueryLifecycleState,
  DEFAULT_LIVE_QUERY_LIFECYCLE_CONFIG,
  type LiveQueryLifecycleConfig,
  type LiveQueryLifecycleEffect,
  type LiveQueryLifecycleEvent,
  type LiveQueryLifecycleState,
  type LiveQueryLifecycleStatus,
  transitionLiveQueryLifecycle,
} from './live-query-lifecycle.js';

const FIXTURE_CONFIG: LiveQueryLifecycleConfig = {
  snapshotRetryDelayMs: 2000,
  maxSnapshotRetries: 5,
};

function fixtureState(
  status: LiveQueryLifecycleStatus,
  overrides: Partial<LiveQueryLifecycleState> = {}
): LiveQueryLifecycleState {
  return {
    status,
    generation: 3,
    snapshotRetries: 2,
    error: null,
    config: FIXTURE_CONFIG,
    ...overrides,
  };
}

const EVENTS: Record<string, LiveQueryLifecycleEvent> = {
  subscribed: { type: 'subscribed', generation: 3 },
  'snapshot-arrived': { type: 'snapshot-arrived', generation: 3 },
  'snapshot-failed-messageless': { type: 'snapshot-failed', generation: 3 },
  'snapshot-failed-error': { type: 'snapshot-failed', generation: 3, message: 'query failed' },
  'delta-arrived': { type: 'delta-arrived', generation: 3 },
  'transport-error': { type: 'transport-error', generation: 3 },
  unsubscribe: { type: 'unsubscribe' },
};

interface TableCell {
  effectKinds: LiveQueryLifecycleEffect['kind'][];
  state: LiveQueryLifecycleState;
}

function cell(
  status: LiveQueryLifecycleStatus,
  effectKinds: LiveQueryLifecycleEffect['kind'][],
  overrides: Partial<LiveQueryLifecycleState> = {}
): TableCell {
  return { effectKinds, state: fixtureState(status, overrides) };
}

const TRANSITION_TABLE: Record<LiveQueryLifecycleStatus, Record<string, TableCell>> = {
  subscribing: {
    subscribed: cell('awaiting-snapshot', ['retry-with-backoff'], { snapshotRetries: 3 }),
    'snapshot-arrived': cell('live', ['emit-to-store']),
    'snapshot-failed-messageless': cell('error-retry', ['emit-to-store']),
    'snapshot-failed-error': cell('error-retry', ['emit-to-store'], { error: 'query failed' }),
    'delta-arrived': cell('subscribing', []),
    'transport-error': cell('subscribing', ['re-snapshot'], {
      generation: 4,
      snapshotRetries: 0,
    }),
    unsubscribe: cell('disposed', ['schedule-cleanup']),
  },
  'awaiting-snapshot': {
    subscribed: cell('awaiting-snapshot', []),
    'snapshot-arrived': cell('live', ['emit-to-store']),
    'snapshot-failed-messageless': cell('subscribing', ['re-snapshot'], { generation: 4 }),
    'snapshot-failed-error': cell('error-retry', ['emit-to-store'], { error: 'query failed' }),
    'delta-arrived': cell('awaiting-snapshot', []),
    'transport-error': cell('subscribing', ['re-snapshot'], {
      generation: 4,
      snapshotRetries: 0,
    }),
    unsubscribe: cell('disposed', ['schedule-cleanup']),
  },
  live: {
    subscribed: cell('live', []),
    'snapshot-arrived': cell('live', ['emit-to-store']),
    'snapshot-failed-messageless': cell('live', []),
    'snapshot-failed-error': cell('error-retry', ['emit-to-store'], { error: 'query failed' }),
    'delta-arrived': cell('live', ['emit-to-store']),
    'transport-error': cell('subscribing', ['re-snapshot'], {
      generation: 4,
      snapshotRetries: 0,
    }),
    unsubscribe: cell('disposed', ['schedule-cleanup']),
  },
  'error-retry': {
    subscribed: cell('error-retry', []),
    'snapshot-arrived': cell('live', ['emit-to-store']),
    'snapshot-failed-messageless': cell('error-retry', []),
    'snapshot-failed-error': cell('error-retry', []),
    'delta-arrived': cell('error-retry', []),
    'transport-error': cell('subscribing', ['re-snapshot'], {
      generation: 4,
      snapshotRetries: 0,
    }),
    unsubscribe: cell('disposed', ['schedule-cleanup']),
  },
  disposed: {
    subscribed: cell('disposed', []),
    'snapshot-arrived': cell('disposed', []),
    'snapshot-failed-messageless': cell('disposed', []),
    'snapshot-failed-error': cell('disposed', []),
    'delta-arrived': cell('disposed', []),
    'transport-error': cell('disposed', []),
    unsubscribe: cell('disposed', []),
  },
};

describe('live-query-lifecycle', () => {
  describe('createLiveQueryLifecycleState', () => {
    it('creates the initial subscribing state and declares the first subscribe', () => {
      const initial = createLiveQueryLifecycleState();
      expect(initial.state).toEqual({
        status: 'subscribing',
        generation: 1,
        snapshotRetries: 0,
        error: null,
        config: { snapshotRetryDelayMs: 2000, maxSnapshotRetries: 5 },
      });
      expect(initial.effects).toEqual([{ kind: 're-snapshot', generation: 1 }]);
    });

    it('merges partial config over the defaults', () => {
      expect(DEFAULT_LIVE_QUERY_LIFECYCLE_CONFIG).toEqual({
        snapshotRetryDelayMs: 2000,
        maxSnapshotRetries: 5,
      });
      const { state } = createLiveQueryLifecycleState({ maxSnapshotRetries: 2 });
      expect(state.config).toEqual({ snapshotRetryDelayMs: 2000, maxSnapshotRetries: 2 });
    });

    it('keeps defaults when partial config values are explicitly undefined', () => {
      const { state } = createLiveQueryLifecycleState({
        snapshotRetryDelayMs: undefined,
        maxSnapshotRetries: undefined,
      });
      expect(state.config).toEqual({
        snapshotRetryDelayMs: 2000,
        maxSnapshotRetries: 5,
      });
    });
  });

  describe('transition table', () => {
    it('pins every status x event cell', () => {
      for (const status of Object.keys(TRANSITION_TABLE) as LiveQueryLifecycleStatus[]) {
        for (const [key, expected] of Object.entries(TRANSITION_TABLE[status])) {
          const from = fixtureState(status);
          const result = transitionLiveQueryLifecycle(from, EVENTS[key]);
          expect(result.state, `${status} + ${key} state`).toEqual(expected.state);
          expect(
            result.effects.map((effect) => effect.kind),
            `${status} + ${key} effects`
          ).toEqual(expected.effectKinds);
          if (expected.effectKinds.length === 0) {
            expect(result.state, `${status} + ${key} keeps the same reference`).toBe(from);
          }
        }
      }
    });

    it('declares the backoff effect with generation and configured delay', () => {
      const result = transitionLiveQueryLifecycle(fixtureState('subscribing'), {
        type: 'subscribed',
        generation: 3,
      });
      expect(result.effects).toEqual([
        { kind: 'retry-with-backoff', generation: 3, delayMs: 2000 },
      ]);
    });

    it('declares the re-snapshot effect with the next generation', () => {
      const result = transitionLiveQueryLifecycle(fixtureState('awaiting-snapshot'), {
        type: 'snapshot-failed',
        generation: 3,
      });
      expect(result.effects).toEqual([{ kind: 're-snapshot', generation: 4 }]);
    });

    it('emits deltas only while live and keeps the state reference', () => {
      const live = fixtureState('live');
      const delta = transitionLiveQueryLifecycle(live, { type: 'delta-arrived', generation: 3 });
      expect(delta.state).toBe(live);
      expect(delta.effects).toEqual([{ kind: 'emit-to-store', emission: { type: 'delta' } }]);
    });

    it('accepts a snapshot that races ahead of the subscribe resolution', () => {
      const arrived = transitionLiveQueryLifecycle(fixtureState('subscribing'), {
        type: 'snapshot-arrived',
        generation: 3,
      });
      expect(arrived.state.status).toBe('live');
      const lateResolve = transitionLiveQueryLifecycle(arrived.state, {
        type: 'subscribed',
        generation: 3,
      });
      expect(lateResolve.state).toBe(arrived.state);
      expect(lateResolve.effects).toEqual([]);
    });

    it('settles snapshot errors with an error emission and revives on a late snapshot', () => {
      const failed = transitionLiveQueryLifecycle(fixtureState('awaiting-snapshot'), {
        type: 'snapshot-failed',
        generation: 3,
        message: 'query failed',
      });
      expect(failed.state).toEqual(fixtureState('error-retry', { error: 'query failed' }));
      expect(failed.effects).toEqual([
        { kind: 'emit-to-store', emission: { type: 'error', message: 'query failed' } },
      ]);
      const revived = transitionLiveQueryLifecycle(failed.state, {
        type: 'snapshot-arrived',
        generation: 3,
      });
      expect(revived.state).toEqual(fixtureState('live', { error: 'query failed' }));
      expect(revived.effects).toEqual([{ kind: 'emit-to-store', emission: { type: 'snapshot' } }]);
    });

    it('settles a rejected subscribe request as settled-empty without an error', () => {
      const rejected = transitionLiveQueryLifecycle(fixtureState('subscribing'), {
        type: 'snapshot-failed',
        generation: 3,
      });
      expect(rejected.state).toEqual(fixtureState('error-retry'));
      expect(rejected.effects).toEqual([
        { kind: 'emit-to-store', emission: { type: 'settled-empty' } },
      ]);
      const lateTimer = transitionLiveQueryLifecycle(rejected.state, {
        type: 'snapshot-failed',
        generation: 3,
      });
      expect(lateTimer.state).toBe(rejected.state);
      expect(lateTimer.effects).toEqual([]);
    });
  });

  describe('generation guard', () => {
    it('drops stale-generation events without changing state or declaring effects', () => {
      const staleEvents: LiveQueryLifecycleEvent[] = [
        { type: 'subscribed', generation: 2 },
        { type: 'snapshot-arrived', generation: 2 },
        { type: 'snapshot-failed', generation: 2 },
        { type: 'snapshot-failed', generation: 2, message: 'stale failure' },
        { type: 'delta-arrived', generation: 2 },
        { type: 'transport-error', generation: 2 },
      ];
      for (const status of ['subscribing', 'awaiting-snapshot', 'live', 'error-retry'] as const) {
        const from = fixtureState(status);
        for (const event of staleEvents) {
          const result = transitionLiveQueryLifecycle(from, event);
          expect(result.state, `${status} + ${event.type}`).toBe(from);
          expect(result.effects, `${status} + ${event.type}`).toEqual([]);
        }
      }
    });

    it('rejects generation-bound events dispatched without a generation', () => {
      const from = fixtureState('live');
      const result = transitionLiveQueryLifecycle(from, {
        type: 'delta-arrived',
        // @ts-expect-error generation is required so a stale event cannot bypass the guard untagged
        generation: undefined,
      });
      expect(result.state).toBe(from);
      expect(result.effects).toEqual([]);
    });

    it('applies events tagged with the current generation', () => {
      const result = transitionLiveQueryLifecycle(fixtureState('awaiting-snapshot'), {
        type: 'snapshot-arrived',
        generation: 3,
      });
      expect(result.state.status).toBe('live');
      expect(result.effects).toEqual([{ kind: 'emit-to-store', emission: { type: 'snapshot' } }]);
    });

    it('ignores a backoff timer from a generation superseded by a transport error', () => {
      const live = fixtureState('live', { snapshotRetries: 5 });
      const retry = transitionLiveQueryLifecycle(live, { type: 'transport-error', generation: 3 });
      expect(retry.state.generation).toBe(4);
      const staleTimer = transitionLiveQueryLifecycle(retry.state, {
        type: 'snapshot-failed',
        generation: 3,
      });
      expect(staleTimer.state).toBe(retry.state);
      expect(staleTimer.effects).toEqual([]);
      const resolved = transitionLiveQueryLifecycle(retry.state, {
        type: 'subscribed',
        generation: 4,
      });
      const currentTimer = transitionLiveQueryLifecycle(resolved.state, {
        type: 'snapshot-failed',
        generation: 4,
      });
      expect(currentTimer.state.generation).toBe(5);
    });
  });

  describe('snapshot retry limit', () => {
    it('gives up after the configured retries and settles empty without an error', () => {
      const initial = createLiveQueryLifecycleState();
      let { state } = initial;
      const subscribeDeclarations = [...initial.effects];
      for (let generation = 1; generation <= 5; generation += 1) {
        const resolved = transitionLiveQueryLifecycle(state, {
          type: 'subscribed',
          generation,
        });
        expect(resolved.state.status, `generation ${generation}`).toBe('awaiting-snapshot');
        expect(resolved.state.snapshotRetries, `generation ${generation}`).toBe(generation);
        expect(resolved.effects).toEqual([
          { kind: 'retry-with-backoff', generation, delayMs: 2000 },
        ]);
        const timedOut = transitionLiveQueryLifecycle(resolved.state, {
          type: 'snapshot-failed',
          generation,
        });
        expect(timedOut.state.status).toBe('subscribing');
        expect(timedOut.state.generation).toBe(generation + 1);
        expect(timedOut.state.snapshotRetries).toBe(generation);
        expect(timedOut.effects).toEqual([{ kind: 're-snapshot', generation: generation + 1 }]);
        subscribeDeclarations.push(...timedOut.effects);
        state = timedOut.state;
      }
      const exhausted = transitionLiveQueryLifecycle(state, { type: 'subscribed', generation: 6 });
      expect(exhausted.state.status).toBe('error-retry');
      expect(exhausted.state.error).toBeNull();
      expect(exhausted.state.snapshotRetries).toBe(5);
      expect(exhausted.effects).toEqual([
        { kind: 'emit-to-store', emission: { type: 'settled-empty' } },
      ]);
      expect(subscribeDeclarations).toHaveLength(6);
      const lateTimer = transitionLiveQueryLifecycle(exhausted.state, {
        type: 'snapshot-failed',
        generation: 6,
      });
      expect(lateTimer.state).toBe(exhausted.state);
      expect(lateTimer.effects).toEqual([]);
    });

    it('takes the backoff delay and retry budget from config', () => {
      const initial = createLiveQueryLifecycleState({
        snapshotRetryDelayMs: 500,
        maxSnapshotRetries: 1,
      });
      const armed = transitionLiveQueryLifecycle(initial.state, {
        type: 'subscribed',
        generation: 1,
      });
      expect(armed.effects).toEqual([{ kind: 'retry-with-backoff', generation: 1, delayMs: 500 }]);
      const retried = transitionLiveQueryLifecycle(armed.state, {
        type: 'snapshot-failed',
        generation: 1,
      });
      const exhausted = transitionLiveQueryLifecycle(retried.state, {
        type: 'subscribed',
        generation: 2,
      });
      expect(exhausted.state.status).toBe('error-retry');
      expect(exhausted.state.snapshotRetries).toBe(1);
      expect(exhausted.effects).toEqual([
        { kind: 'emit-to-store', emission: { type: 'settled-empty' } },
      ]);
    });

    it('resets the retry budget when a transport error forces a re-snapshot', () => {
      const spent = fixtureState('live', { snapshotRetries: 5 });
      const retry = transitionLiveQueryLifecycle(spent, { type: 'transport-error', generation: 3 });
      expect(retry.state).toEqual(
        fixtureState('subscribing', { generation: 4, snapshotRetries: 0 })
      );
      expect(retry.effects).toEqual([{ kind: 're-snapshot', generation: 4 }]);
      const resolved = transitionLiveQueryLifecycle(retry.state, {
        type: 'subscribed',
        generation: 4,
      });
      expect(resolved.state.status).toBe('awaiting-snapshot');
      expect(resolved.state.snapshotRetries).toBe(1);
      expect(resolved.effects).toEqual([
        { kind: 'retry-with-backoff', generation: 4, delayMs: 2000 },
      ]);
    });

    it('recovers when the transport drops while a subscribe request is pending', () => {
      const pending = fixtureState('subscribing', { snapshotRetries: 4 });
      const dropped = transitionLiveQueryLifecycle(pending, {
        type: 'transport-error',
        generation: 3,
      });
      expect(dropped.state).toEqual(
        fixtureState('subscribing', { generation: 4, snapshotRetries: 0 })
      );
      expect(dropped.effects).toEqual([{ kind: 're-snapshot', generation: 4 }]);
      const staleResolve = transitionLiveQueryLifecycle(dropped.state, {
        type: 'subscribed',
        generation: 3,
      });
      expect(staleResolve.state).toBe(dropped.state);
      expect(staleResolve.effects).toEqual([]);
      const resolved = transitionLiveQueryLifecycle(dropped.state, {
        type: 'subscribed',
        generation: 4,
      });
      expect(resolved.state.status).toBe('awaiting-snapshot');
      expect(resolved.state.snapshotRetries).toBe(1);
      expect(resolved.effects).toEqual([
        { kind: 'retry-with-backoff', generation: 4, delayMs: 2000 },
      ]);
    });

    it('clears a stale error when a fresh generation starts', () => {
      const errored = fixtureState('error-retry', { error: 'query failed' });
      const retry = transitionLiveQueryLifecycle(errored, {
        type: 'transport-error',
        generation: 3,
      });
      expect(retry.state).toEqual(
        fixtureState('subscribing', { generation: 4, snapshotRetries: 0 })
      );
      expect(retry.state.error).toBeNull();
      const revived = transitionLiveQueryLifecycle(retry.state, {
        type: 'snapshot-arrived',
        generation: 4,
      });
      expect(revived.state).toEqual(fixtureState('live', { generation: 4, snapshotRetries: 0 }));
      expect(revived.state.error).toBeNull();
      expect(revived.effects).toEqual([{ kind: 'emit-to-store', emission: { type: 'snapshot' } }]);
    });
  });

  describe('snapshot retry disabled', () => {
    it('moves to awaiting-snapshot without arming a backoff timer', () => {
      const initial = createLiveQueryLifecycleState({ snapshotRetryEnabled: false });
      expect(initial.state.config).toEqual({
        snapshotRetryDelayMs: 2000,
        maxSnapshotRetries: 5,
        snapshotRetryEnabled: false,
      });
      const resolved = transitionLiveQueryLifecycle(initial.state, {
        type: 'subscribed',
        generation: 1,
      });
      expect(resolved.state).toEqual(
        fixtureState('awaiting-snapshot', {
          generation: 1,
          snapshotRetries: 0,
          config: { ...FIXTURE_CONFIG, snapshotRetryEnabled: false },
        })
      );
      expect(resolved.effects).toEqual([]);
    });

    it('never exhausts a retry budget across transport-error resubscribes', () => {
      const initial = createLiveQueryLifecycleState({ snapshotRetryEnabled: false });
      let state = initial.state;
      for (let i = 0; i < 10; i += 1) {
        const generation = state.generation;
        const resolved = transitionLiveQueryLifecycle(state, {
          type: 'subscribed',
          generation,
        });
        expect(resolved.state.status).toBe('awaiting-snapshot');
        expect(resolved.state.snapshotRetries).toBe(0);
        expect(resolved.effects).toEqual([]);
        state = resolved.state;
      }
      expect(state.status).toBe('awaiting-snapshot');
    });
  });

  describe('disposed', () => {
    it('stays disposed for every event and never re-declares cleanup', () => {
      const disposed = fixtureState('disposed');
      for (const event of Object.values(EVENTS)) {
        const result = transitionLiveQueryLifecycle(disposed, event);
        expect(result.state, event.type).toBe(disposed);
        expect(result.effects, event.type).toEqual([]);
      }
    });
  });
});
