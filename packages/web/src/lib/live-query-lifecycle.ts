export type LiveQueryLifecycleStatus =
  | 'subscribing'
  | 'awaiting-snapshot'
  | 'live'
  | 'error-retry'
  | 'disposed';

export interface LiveQueryLifecycleConfig {
  snapshotRetryDelayMs: number;
  maxSnapshotRetries: number;
}

export const DEFAULT_LIVE_QUERY_LIFECYCLE_CONFIG: LiveQueryLifecycleConfig = {
  snapshotRetryDelayMs: 2000,
  maxSnapshotRetries: 5,
};

export type LiveQueryEmission =
  | { type: 'snapshot' }
  | { type: 'delta' }
  | { type: 'error'; message: string }
  | { type: 'settled-empty' };

export type LiveQueryLifecycleEffect =
  | { kind: 're-snapshot'; generation: number }
  | { kind: 'retry-with-backoff'; generation: number; delayMs: number }
  | { kind: 'emit-to-store'; emission: LiveQueryEmission }
  | { kind: 'schedule-cleanup' };

export type LiveQueryLifecycleEvent =
  | { type: 'subscribed'; generation: number }
  | { type: 'snapshot-arrived'; generation: number }
  | { type: 'snapshot-failed'; generation: number; message?: string }
  | { type: 'delta-arrived'; generation: number }
  | { type: 'transport-error'; generation: number }
  | { type: 'unsubscribe' };

export interface LiveQueryLifecycleState {
  status: LiveQueryLifecycleStatus;
  generation: number;
  snapshotRetries: number;
  error: string | null;
  config: LiveQueryLifecycleConfig;
}

export interface LiveQueryLifecycleTransition {
  state: LiveQueryLifecycleState;
  effects: LiveQueryLifecycleEffect[];
}

export function createLiveQueryLifecycleState(
  config: Partial<LiveQueryLifecycleConfig> = {}
): LiveQueryLifecycleTransition {
  return {
    state: {
      status: 'subscribing',
      generation: 1,
      snapshotRetries: 0,
      error: null,
      config: { ...DEFAULT_LIVE_QUERY_LIFECYCLE_CONFIG, ...config },
    },
    effects: [{ kind: 're-snapshot', generation: 1 }],
  };
}

export function transitionLiveQueryLifecycle(
  state: LiveQueryLifecycleState,
  event: LiveQueryLifecycleEvent
): LiveQueryLifecycleTransition {
  if (state.status === 'disposed') {
    return { state, effects: [] };
  }
  if (event.type === 'unsubscribe') {
    return {
      state: { ...state, status: 'disposed' },
      effects: [{ kind: 'schedule-cleanup' }],
    };
  }
  if (event.generation !== state.generation) {
    return { state, effects: [] };
  }
  if (event.type === 'transport-error') {
    return resubscribe({ ...state, snapshotRetries: 0 });
  }
  switch (state.status) {
    case 'subscribing':
      return transitionSubscribing(state, event);
    case 'awaiting-snapshot':
      return transitionAwaitingSnapshot(state, event);
    case 'live':
      return transitionLive(state, event);
    case 'error-retry':
      return transitionErrorRetry(state, event);
    default:
      return { state, effects: [] };
  }
}

function transitionSubscribing(
  state: LiveQueryLifecycleState,
  event: LiveQueryLifecycleEvent
): LiveQueryLifecycleTransition {
  if (event.type === 'subscribed') {
    if (state.snapshotRetries >= state.config.maxSnapshotRetries) {
      return {
        state: { ...state, status: 'error-retry' },
        effects: [{ kind: 'emit-to-store', emission: { type: 'settled-empty' } }],
      };
    }
    return {
      state: {
        ...state,
        status: 'awaiting-snapshot',
        snapshotRetries: state.snapshotRetries + 1,
      },
      effects: [
        {
          kind: 'retry-with-backoff',
          generation: state.generation,
          delayMs: state.config.snapshotRetryDelayMs,
        },
      ],
    };
  }
  if (event.type === 'snapshot-arrived') {
    return {
      state: { ...state, status: 'live' },
      effects: [{ kind: 'emit-to-store', emission: { type: 'snapshot' } }],
    };
  }
  if (event.type === 'snapshot-failed') {
    if (event.message !== undefined) {
      return settleSnapshotError(state, event.message);
    }
    return {
      state: { ...state, status: 'error-retry' },
      effects: [{ kind: 'emit-to-store', emission: { type: 'settled-empty' } }],
    };
  }
  return { state, effects: [] };
}

function transitionAwaitingSnapshot(
  state: LiveQueryLifecycleState,
  event: LiveQueryLifecycleEvent
): LiveQueryLifecycleTransition {
  if (event.type === 'snapshot-arrived') {
    return {
      state: { ...state, status: 'live' },
      effects: [{ kind: 'emit-to-store', emission: { type: 'snapshot' } }],
    };
  }
  if (event.type === 'snapshot-failed') {
    if (event.message !== undefined) {
      return settleSnapshotError(state, event.message);
    }
    return resubscribe(state);
  }
  return { state, effects: [] };
}

function transitionLive(
  state: LiveQueryLifecycleState,
  event: LiveQueryLifecycleEvent
): LiveQueryLifecycleTransition {
  if (event.type === 'delta-arrived') {
    return { state, effects: [{ kind: 'emit-to-store', emission: { type: 'delta' } }] };
  }
  if (event.type === 'snapshot-arrived') {
    return { state, effects: [{ kind: 'emit-to-store', emission: { type: 'snapshot' } }] };
  }
  if (event.type === 'snapshot-failed' && event.message !== undefined) {
    return settleSnapshotError(state, event.message);
  }
  return { state, effects: [] };
}

function transitionErrorRetry(
  state: LiveQueryLifecycleState,
  event: LiveQueryLifecycleEvent
): LiveQueryLifecycleTransition {
  if (event.type === 'snapshot-arrived') {
    return {
      state: { ...state, status: 'live' },
      effects: [{ kind: 'emit-to-store', emission: { type: 'snapshot' } }],
    };
  }
  return { state, effects: [] };
}

function resubscribe(state: LiveQueryLifecycleState): LiveQueryLifecycleTransition {
  const generation = state.generation + 1;
  return {
    state: { ...state, status: 'subscribing', generation, error: null },
    effects: [{ kind: 're-snapshot', generation }],
  };
}

function settleSnapshotError(
  state: LiveQueryLifecycleState,
  message: string
): LiveQueryLifecycleTransition {
  return {
    state: { ...state, status: 'error-retry', error: message },
    effects: [{ kind: 'emit-to-store', emission: { type: 'error', message } }],
  };
}
