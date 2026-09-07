import { describe, expect, mock, test } from 'bun:test';
import {
  createMailboxDeferredReplayScheduler,
  type MailboxDeferredReplaySchedulerDeps,
} from '../../../../src/lib/mailbox/deferred-replay-scheduler';

const SESSION_ID = 'sess-1';

function makeDeps(
  publish: (sessionId: string) => Promise<unknown>
): MailboxDeferredReplaySchedulerDeps {
  return {
    internalEventBus: { publish: mock((_event: string, _data: unknown) => publish(SESSION_ID)) },
    sessionManager: {
      getCachedSession: () =>
        ({
          getSessionData: () => ({ config: { queryMode: 'immediate' } }),
          getProcessingState: () => ({ status: 'idle' }),
          stateManager: {},
        }) as never,
    },
    retryBackoffBaseMs: 1,
  };
}

function flush(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('createMailboxDeferredReplayScheduler', () => {
  test('publishes query.trigger once for an idle session', async () => {
    const publish = mock(async () => {});
    const scheduler = createMailboxDeferredReplayScheduler(makeDeps(publish));

    scheduler.schedule(SESSION_ID);
    await flush(20);

    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith(SESSION_ID);
  });

  test('requeues and retries after a publication failure', async () => {
    let failures = 2;
    const publish = mock(async () => {
      if (failures > 0) {
        failures -= 1;
        throw new Error('ClearConversationCancelledError');
      }
    });
    const scheduler = createMailboxDeferredReplayScheduler(makeDeps(publish));

    scheduler.schedule(SESSION_ID);
    await flush(60);

    expect(publish.mock.calls.length).toBe(3);
  });

  test('keeps retrying durably with capped backoff after repeated failures', async () => {
    const publish = mock(async () => {
      throw new Error('always fails');
    });
    const deps = makeDeps(publish);
    deps.retryBackoffCapMs = 1;
    const scheduler = createMailboxDeferredReplayScheduler(deps);

    scheduler.schedule(SESSION_ID);
    await flush(60);

    const observed = publish.mock.calls.length;
    expect(observed).toBeGreaterThan(5);
    await flush(30);
    expect(publish.mock.calls.length).toBeGreaterThan(observed);
    scheduler.cancel(SESSION_ID);
  });

  test('does not publish for manual mode sessions', async () => {
    const publish = mock(async () => {});
    const deps = makeDeps(publish);
    deps.sessionManager = {
      getCachedSession: () =>
        ({
          getSessionData: () => ({ config: { queryMode: 'manual' } }),
          getProcessingState: () => ({ status: 'idle' }),
          stateManager: {},
        }) as never,
    };
    const scheduler = createMailboxDeferredReplayScheduler(deps);

    scheduler.schedule(SESSION_ID);
    await flush(20);

    expect(publish).not.toHaveBeenCalled();
  });

  test('waits through waiting_for_input before publishing', async () => {
    const publish = mock(async () => {});
    const deps = makeDeps(publish);
    let status = 'waiting_for_input';
    let resolveIdle: (() => void) | undefined;
    deps.sessionManager = {
      getCachedSession: () =>
        ({
          getSessionData: () => ({ config: { queryMode: 'immediate' } }),
          getProcessingState: () => ({ status }),
          stateManager: {
            waitForIdleTransition: () => ({
              promise: new Promise<void>((resolve) => {
                resolveIdle = resolve;
              }),
              cancel: () => {},
            }),
          },
        }) as never,
    };
    const scheduler = createMailboxDeferredReplayScheduler(deps);

    scheduler.schedule(SESSION_ID);
    await flush(20);
    expect(publish).not.toHaveBeenCalled();

    status = 'idle';
    resolveIdle?.();
    await flush(20);
    expect(publish).toHaveBeenCalledWith(SESSION_ID);
  });

  test('parks while the session is interrupted and publishes after idle settles', async () => {
    const publish = mock(async () => {});
    const deps = makeDeps(publish);
    let status = 'interrupted';
    let resolveIdle: (() => void) | undefined;
    deps.sessionManager = {
      getCachedSession: () =>
        ({
          getSessionData: () => ({ config: { queryMode: 'immediate' } }),
          getProcessingState: () => ({ status }),
          stateManager: {
            waitForIdleTransition: () => ({
              promise: new Promise<void>((resolve) => {
                resolveIdle = resolve;
              }),
              cancel: () => {},
            }),
          },
        }) as never,
    };
    const scheduler = createMailboxDeferredReplayScheduler(deps);

    scheduler.schedule(SESSION_ID);
    await flush(20);
    expect(publish).not.toHaveBeenCalled();

    status = 'idle';
    resolveIdle?.();
    await flush(20);
    expect(publish).toHaveBeenCalledWith(SESSION_ID);
  });

  test('normalizes a stale interrupted state instead of parking forever', async () => {
    const publish = mock(async () => {});
    const deps = makeDeps(publish);
    let status = 'interrupted';
    deps.sessionManager = {
      getCachedSession: () =>
        ({
          getSessionData: () => ({ config: { queryMode: 'immediate' } }),
          getProcessingState: () => ({ status }),
          normalizeStaleInterruptedState: async () => {
            status = 'idle';
          },
          stateManager: {
            waitForIdleTransition: () => ({
              promise: new Promise<void>(() => {}),
              cancel: () => {},
            }),
          },
        }) as never,
    };
    const scheduler = createMailboxDeferredReplayScheduler(deps);

    scheduler.schedule(SESSION_ID);
    await flush(20);

    expect(publish).toHaveBeenCalledWith(SESSION_ID);
  });

  test('parks while the session is in rate-limit cooldown', async () => {
    const publish = mock(async () => {});
    const deps = makeDeps(publish);
    let status = 'rate_limit_cooldown';
    let resolveIdle: (() => void) | undefined;
    deps.sessionManager = {
      getCachedSession: () =>
        ({
          getSessionData: () => ({ config: { queryMode: 'immediate' } }),
          getProcessingState: () => ({ status }),
          stateManager: {
            waitForIdleTransition: () => ({
              promise: new Promise<void>((resolve) => {
                resolveIdle = resolve;
              }),
              cancel: () => {},
            }),
          },
        }) as never,
    };
    const scheduler = createMailboxDeferredReplayScheduler(deps);

    scheduler.schedule(SESSION_ID);
    await flush(20);
    expect(publish).not.toHaveBeenCalled();

    status = 'idle';
    resolveIdle?.();
    await flush(20);
    expect(publish).toHaveBeenCalledWith(SESSION_ID);
  });

  test('cancel during interrupt normalization prevents publication', async () => {
    const publish = mock(async () => {});
    const deps = makeDeps(publish);
    let status = 'interrupted';
    let resolveNormalize: (() => void) | undefined;
    deps.sessionManager = {
      getCachedSession: () =>
        ({
          getSessionData: () => ({ config: { queryMode: 'immediate' } }),
          getProcessingState: () => ({ status }),
          normalizeStaleInterruptedState: () =>
            new Promise<void>((resolve) => {
              resolveNormalize = resolve;
            }),
          stateManager: {
            waitForIdleTransition: () => ({
              promise: new Promise<void>(() => {}),
              cancel: () => {},
            }),
          },
        }) as never,
    };
    const scheduler = createMailboxDeferredReplayScheduler(deps);

    scheduler.schedule(SESSION_ID);
    await flush(10);
    scheduler.cancel(SESSION_ID);

    status = 'idle';
    resolveNormalize?.();
    await flush(20);

    expect(publish).not.toHaveBeenCalled();
  });

  test('reparks on the replacement session after a hard reset', async () => {
    const published: string[] = [];
    let firstStatus = 'processing';
    let secondStatus = 'processing';
    let resolveFirst: (() => void) | undefined;
    let resolveSecond: (() => void) | undefined;
    let useSecond = false;
    const makeSession = (status: () => string, park: (resolve: () => void) => void) =>
      ({
        getSessionData: () => ({ config: { queryMode: 'immediate' } }),
        getProcessingState: () => ({ status: status() }),
        stateManager: {
          waitForIdleTransition: () => ({
            promise: new Promise<void>((resolve) => {
              park(resolve);
            }),
            cancel: () => {},
          }),
        },
      }) as never;
    const deps: MailboxDeferredReplaySchedulerDeps = {
      internalEventBus: {
        publish: mock(async (_event: string, data: { sessionId: string }) => {
          published.push(data.sessionId);
        }),
      } as never,
      sessionManager: {
        getCachedSession: () =>
          useSecond
            ? makeSession(
                () => secondStatus,
                (resolve) => {
                  resolveSecond = resolve;
                }
              )
            : makeSession(
                () => firstStatus,
                (resolve) => {
                  resolveFirst = resolve;
                }
              ),
      },
    };
    const scheduler = createMailboxDeferredReplayScheduler(deps);

    scheduler.schedule(SESSION_ID);
    await flush(10);
    expect(resolveFirst).toBeDefined();

    useSecond = true;
    firstStatus = 'idle';
    resolveFirst?.();
    await flush(10);
    expect(published).toEqual([]);
    expect(resolveSecond).toBeDefined();

    secondStatus = 'idle';
    resolveSecond?.();
    await flush(10);
    expect(published).toEqual([SESSION_ID]);
  });

  test('revalidates the session after interrupt normalization', async () => {
    const published: string[] = [];
    let firstStatus = 'interrupted';
    let secondStatus = 'processing';
    let resolveNormalize: (() => void) | undefined;
    let resolveSecond: (() => void) | undefined;
    let useSecond = false;
    const makeReplacement = () =>
      ({
        getSessionData: () => ({ config: { queryMode: 'immediate' } }),
        getProcessingState: () => ({ status: secondStatus }),
        stateManager: {
          waitForIdleTransition: () => ({
            promise: new Promise<void>((resolve) => {
              resolveSecond = resolve;
            }),
            cancel: () => {},
          }),
        },
      }) as never;
    const deps: MailboxDeferredReplaySchedulerDeps = {
      internalEventBus: {
        publish: mock(async (_event: string, data: { sessionId: string }) => {
          published.push(data.sessionId);
        }),
      } as never,
      sessionManager: {
        getCachedSession: () =>
          useSecond
            ? makeReplacement()
            : ({
                getSessionData: () => ({ config: { queryMode: 'immediate' } }),
                getProcessingState: () => ({ status: firstStatus }),
                normalizeStaleInterruptedState: () =>
                  new Promise<void>((resolve) => {
                    resolveNormalize = resolve;
                  }),
                stateManager: {
                  waitForIdleTransition: () => ({
                    promise: new Promise<void>(() => {}),
                    cancel: () => {},
                  }),
                },
              } as never),
      },
    };
    const scheduler = createMailboxDeferredReplayScheduler(deps);

    scheduler.schedule(SESSION_ID);
    await flush(10);

    useSecond = true;
    firstStatus = 'idle';
    resolveNormalize?.();
    await flush(10);
    expect(published).toEqual([]);
    expect(resolveSecond).toBeDefined();

    secondStatus = 'idle';
    resolveSecond?.();
    await flush(10);
    expect(published).toEqual([SESSION_ID]);
  });

  test('cancel during normalization that stays busy skips the idle waiter', async () => {
    const publish = mock(async () => {});
    const deps = makeDeps(publish);
    let status = 'interrupted';
    let resolveNormalize: (() => void) | undefined;
    let waiterCalls = 0;
    deps.sessionManager = {
      getCachedSession: () =>
        ({
          getSessionData: () => ({ config: { queryMode: 'immediate' } }),
          getProcessingState: () => ({ status }),
          normalizeStaleInterruptedState: () =>
            new Promise<void>((resolve) => {
              resolveNormalize = resolve;
            }),
          stateManager: {
            waitForIdleTransition: () => {
              waiterCalls += 1;
              return { promise: new Promise<void>(() => {}), cancel: () => {} };
            },
          },
        }) as never,
    };
    const scheduler = createMailboxDeferredReplayScheduler(deps);

    scheduler.schedule(SESSION_ID);
    await flush(10);
    scheduler.cancel(SESSION_ID);
    resolveNormalize?.();
    await flush(20);

    expect(waiterCalls).toBe(0);
    expect(publish).not.toHaveBeenCalled();

    status = 'idle';
    scheduler.schedule(SESSION_ID);
    await flush(20);
    expect(publish).toHaveBeenCalledTimes(1);
  });

  test('drains a large burst of uncached sessions without recursion', async () => {
    const publish = mock(async () => {});
    const deps = makeDeps(publish);
    let fetches = 0;
    deps.sessionManager = {
      getCachedSession: () => {
        fetches += 1;
        return null;
      },
    };
    const scheduler = createMailboxDeferredReplayScheduler(deps);

    const ids = Array.from({ length: 20_000 }, (_, i) => `gone-${i}`);
    for (const id of ids) scheduler.schedule(id);
    await flush(500);

    expect(fetches).toBe(20_000);
  });

  test('skips replay for archived sessions at admission', async () => {
    const publish = mock(async () => {});
    const deps = makeDeps(publish);
    deps.sessionManager = {
      getCachedSession: () =>
        ({
          getSessionData: () => ({ config: { queryMode: 'immediate' }, status: 'archived' }),
          getProcessingState: () => ({ status: 'idle' }),
          stateManager: {},
        }) as never,
    };
    const scheduler = createMailboxDeferredReplayScheduler(deps);

    scheduler.schedule(SESSION_ID);
    await flush(20);

    expect(publish).not.toHaveBeenCalled();
  });

  test('skips publication when the session archives while parked', async () => {
    const publish = mock(async () => {});
    const deps = makeDeps(publish);
    let status = 'processing';
    let dataStatus = 'active';
    let resolveIdle: (() => void) | undefined;
    deps.sessionManager = {
      getCachedSession: () =>
        ({
          getSessionData: () => ({ config: { queryMode: 'immediate' }, status: dataStatus }),
          getProcessingState: () => ({ status }),
          stateManager: {
            waitForIdleTransition: () => ({
              promise: new Promise<void>((resolve) => {
                resolveIdle = resolve;
              }),
              cancel: () => {},
            }),
          },
        }) as never,
    };
    const scheduler = createMailboxDeferredReplayScheduler(deps);

    scheduler.schedule(SESSION_ID);
    await flush(10);

    dataStatus = 'archived';
    status = 'idle';
    resolveIdle?.();
    await flush(20);

    expect(publish).not.toHaveBeenCalled();
  });

  test('skips replay for sessions pending a worktree choice', async () => {
    const publish = mock(async () => {});
    const deps = makeDeps(publish);
    deps.sessionManager = {
      getCachedSession: () =>
        ({
          getSessionData: () => ({
            config: { queryMode: 'immediate' },
            status: 'pending_worktree_choice',
          }),
          getProcessingState: () => ({ status: 'idle' }),
          stateManager: {},
        }) as never,
    };
    const scheduler = createMailboxDeferredReplayScheduler(deps);

    scheduler.schedule(SESSION_ID);
    await flush(20);

    expect(publish).not.toHaveBeenCalled();
  });

  test('skips replay for paused sessions', async () => {
    const publish = mock(async () => {});
    const deps = makeDeps(publish);
    deps.sessionManager = {
      getCachedSession: () =>
        ({
          getSessionData: () => ({ config: { queryMode: 'immediate' }, status: 'paused' }),
          getProcessingState: () => ({ status: 'idle' }),
          stateManager: {},
        }) as never,
    };
    const scheduler = createMailboxDeferredReplayScheduler(deps);

    scheduler.schedule(SESSION_ID);
    await flush(20);

    expect(publish).not.toHaveBeenCalled();
  });

  test('waits for terminal-idle settlement before publishing', async () => {
    const publish = mock(async () => {});
    const deps = makeDeps(publish);
    let settling = true;
    let resolveIdle: (() => void) | undefined;
    deps.sessionManager = {
      getCachedSession: () =>
        ({
          getSessionData: () => ({ config: { queryMode: 'immediate' }, status: 'active' }),
          getProcessingState: () => ({ status: 'idle' }),
          stateManager: {
            isTerminalIdleInFlight: () => settling,
            waitForIdleTransition: () => ({
              promise: new Promise<void>((resolve) => {
                resolveIdle = resolve;
              }),
              cancel: () => {},
            }),
          },
        }) as never,
    };
    const scheduler = createMailboxDeferredReplayScheduler(deps);

    scheduler.schedule(SESSION_ID);
    await flush(10);
    expect(publish).not.toHaveBeenCalled();

    settling = false;
    resolveIdle?.();
    await flush(20);
    expect(publish).toHaveBeenCalledWith(SESSION_ID);
  });

  test('rechecks manual mode before publication after a park', async () => {
    const publish = mock(async () => {});
    const deps = makeDeps(publish);
    let status = 'processing';
    let queryMode = 'immediate';
    let resolveIdle: (() => void) | undefined;
    deps.sessionManager = {
      getCachedSession: () =>
        ({
          getSessionData: () => ({ config: { queryMode }, status: 'active' }),
          getProcessingState: () => ({ status }),
          stateManager: {
            waitForIdleTransition: () => ({
              promise: new Promise<void>((resolve) => {
                resolveIdle = resolve;
              }),
              cancel: () => {},
            }),
          },
        }) as never,
    };
    const scheduler = createMailboxDeferredReplayScheduler(deps);

    scheduler.schedule(SESSION_ID);
    await flush(10);

    queryMode = 'manual';
    status = 'idle';
    resolveIdle?.();
    await flush(20);

    expect(publish).not.toHaveBeenCalled();
  });

  test('skips publication when the cached session vanishes during a park', async () => {
    const published: string[] = [];
    let status = 'processing';
    let resolveIdle: (() => void) | undefined;
    let cached = true;
    const deps: MailboxDeferredReplaySchedulerDeps = {
      internalEventBus: {
        publish: mock(async (_event: string, data: { sessionId: string }) => {
          published.push(data.sessionId);
        }),
      } as never,
      sessionManager: {
        getCachedSession: () => {
          if (!cached) return null;
          return {
            getSessionData: () => ({ config: { queryMode: 'immediate' } }),
            getProcessingState: () => ({ status }),
            stateManager: {
              waitForIdleTransition: () => ({
                promise: new Promise<void>((resolve) => {
                  resolveIdle = resolve;
                }),
                cancel: () => {},
              }),
            },
          } as never;
        },
      },
    };
    const scheduler = createMailboxDeferredReplayScheduler(deps);

    scheduler.schedule(SESSION_ID);
    await flush(10);

    cached = false;
    status = 'idle';
    resolveIdle?.();
    await flush(20);

    expect(published).toEqual([]);
  });

  test('cancel wakes a parked replay and releases its idle waiter', async () => {
    const publish = mock(async () => {});
    const deps = makeDeps(publish);
    let status = 'waiting_for_input';
    deps.sessionManager = {
      getCachedSession: () =>
        ({
          getSessionData: () => ({ config: { queryMode: 'immediate' } }),
          getProcessingState: () => ({ status }),
          stateManager: {
            waitForIdleTransition: () => {
              let settle: () => void = () => {};
              const promise = new Promise<void>((resolve) => {
                settle = resolve;
              });
              return { promise, cancel: () => settle() };
            },
          },
        }) as never,
    };
    const scheduler = createMailboxDeferredReplayScheduler(deps);

    scheduler.schedule(SESSION_ID);
    await flush(10);
    scheduler.cancel(SESSION_ID);
    await flush(20);
    expect(publish).not.toHaveBeenCalled();

    status = 'idle';
    scheduler.schedule(SESSION_ID);
    await flush(20);

    expect(publish).toHaveBeenCalledTimes(1);
  });

  test('cancel during a pending failed publication installs no retry timer', async () => {
    let releasePublish: (() => void) | undefined;
    const publish = mock(
      () =>
        new Promise<void>((_resolve, reject) => {
          releasePublish = () => reject(new Error('transient'));
        })
    );
    const deps = makeDeps(() => publish());
    deps.retryBackoffBaseMs = 20;
    const scheduler = createMailboxDeferredReplayScheduler(deps);

    scheduler.schedule(SESSION_ID);
    await flush(10);
    expect(publish).toHaveBeenCalledTimes(1);
    scheduler.cancel(SESSION_ID);
    releasePublish?.();
    await flush(120);

    expect(publish).toHaveBeenCalledTimes(1);
  });

  test('pumps the queue immediately when a replay parks', async () => {
    const published: string[] = [];
    const waiters: Array<{ sessionId: string; resolve: () => void }> = [];
    const statuses = new Map<string, string>();
    const deps: MailboxDeferredReplaySchedulerDeps = {
      internalEventBus: {
        publish: mock(async (_event: string, data: { sessionId: string }) => {
          published.push(data.sessionId);
        }),
      } as never,
      sessionManager: {
        getCachedSession: (sessionId: string) => {
          const initial = sessionId === 'idle-9' ? 'idle' : 'waiting_for_input';
          statuses.set(sessionId, statuses.get(sessionId) ?? initial);
          return {
            getSessionData: () => ({ config: { queryMode: 'immediate' } }),
            getProcessingState: () => ({
              status: statuses.get(sessionId) ?? 'waiting_for_input',
            }),
            stateManager: {
              waitForIdleTransition: () => ({
                promise: new Promise<void>((resolve) => {
                  waiters.push({ sessionId, resolve });
                }),
                cancel: () => {},
              }),
            },
          } as never;
        },
      },
    };
    const scheduler = createMailboxDeferredReplayScheduler(deps);

    for (let i = 1; i <= 8; i += 1) scheduler.schedule(`parked-${i}`);
    scheduler.schedule('idle-9');
    await flush(30);

    expect(waiters).toHaveLength(8);
    expect(published).toEqual(['idle-9']);
  });

  test('retries when query.trigger delivers to no subscribers', async () => {
    let zeroDelivered = 1;
    const publish = mock(async () => {
      if (zeroDelivered > 0) {
        zeroDelivered -= 1;
        return { delivered: 0, failures: [] };
      }
      return { delivered: 1, failures: [] };
    });
    const deps = makeDeps(() => publish());
    deps.retryBackoffBaseMs = 5;
    const scheduler = createMailboxDeferredReplayScheduler(deps);

    scheduler.schedule(SESSION_ID);
    await flush(60);

    expect(publish).toHaveBeenCalledTimes(2);
  });

  test('parked sessions do not consume publication slots', async () => {
    const published: string[] = [];
    const waiters: Array<{ sessionId: string; resolve: () => void }> = [];
    const statuses = new Map<string, string>();
    const deps: MailboxDeferredReplaySchedulerDeps = {
      internalEventBus: {
        publish: mock(async (_event: string, data: { sessionId: string }) => {
          published.push(data.sessionId);
        }),
      } as never,
      sessionManager: {
        getCachedSession: (sessionId: string) => {
          statuses.set(sessionId, statuses.get(sessionId) ?? 'processing');
          return {
            getSessionData: () => ({ config: { queryMode: 'immediate' } }),
            getProcessingState: () => ({ status: statuses.get(sessionId) ?? 'processing' }),
            stateManager: {
              waitForIdleTransition: () => ({
                promise: new Promise<void>((resolve) => {
                  waiters.push({ sessionId, resolve });
                }),
                cancel: () => {},
              }),
            },
          } as never;
        },
      },
    };
    const scheduler = createMailboxDeferredReplayScheduler(deps);
    const ids = Array.from({ length: 12 }, (_, i) => `sess-${i + 1}`);
    for (const id of ids) scheduler.schedule(id);
    await flush(30);

    expect(waiters).toHaveLength(12);
    expect(published).toEqual([]);

    statuses.set('sess-12', 'idle');
    waiters[11]?.resolve();
    await flush(30);
    expect(published).toEqual(['sess-12']);
  });

  test('cancel drops a parked replay before publication', async () => {
    const published: string[] = [];
    let status = 'processing';
    let resolveIdle: (() => void) | undefined;
    const deps: MailboxDeferredReplaySchedulerDeps = {
      internalEventBus: {
        publish: mock(async (_event: string, data: { sessionId: string }) => {
          published.push(data.sessionId);
        }),
      } as never,
      sessionManager: {
        getCachedSession: () =>
          ({
            getSessionData: () => ({ config: { queryMode: 'immediate' } }),
            getProcessingState: () => ({ status }),
            stateManager: {
              waitForIdleTransition: () => ({
                promise: new Promise<void>((resolve) => {
                  resolveIdle = resolve;
                }),
                cancel: () => {},
              }),
            },
          }) as never,
      },
    };
    const scheduler = createMailboxDeferredReplayScheduler(deps);

    scheduler.schedule(SESSION_ID);
    await flush(20);
    scheduler.cancel(SESSION_ID);

    status = 'idle';
    resolveIdle?.();
    await flush(30);

    expect(published).toEqual([]);
  });

  test('cancel during retry backoff stops further publications', async () => {
    let failures = 1;
    const publish = mock(async () => {
      if (failures > 0) {
        failures -= 1;
        throw new Error('transient');
      }
    });
    const deps = makeDeps(publish);
    deps.retryBackoffBaseMs = 20;
    const scheduler = createMailboxDeferredReplayScheduler(deps);

    scheduler.schedule(SESSION_ID);
    await flush(5);
    expect(publish).toHaveBeenCalledTimes(1);
    scheduler.cancel(SESSION_ID);

    await flush(120);
    expect(publish).toHaveBeenCalledTimes(1);
  });

  test('a cancel that removes a ready replay clears the stale cancellation marker', async () => {
    let aFailures = 1;
    const publishCalls: string[] = [];
    const gates = new Map<string, () => void>();
    const gatePromises = new Map<string, Promise<void>>();
    const deps: MailboxDeferredReplaySchedulerDeps = {
      internalEventBus: {
        publish: mock(async (_event: string, data: { sessionId: string }) => {
          const { sessionId } = data;
          if (sessionId === SESSION_ID) {
            publishCalls.push(sessionId);
            if (aFailures > 0) {
              aFailures -= 1;
              throw new Error('transient');
            }
            return;
          }
          publishCalls.push(sessionId);
          if (!gatePromises.has(sessionId)) {
            gatePromises.set(
              sessionId,
              new Promise<void>((resolve) => {
                gates.set(sessionId, resolve);
              })
            );
          }
          await gatePromises.get(sessionId);
        }),
      } as never,
      sessionManager: {
        getCachedSession: () =>
          ({
            getSessionData: () => ({ config: { queryMode: 'immediate' } }),
            getProcessingState: () => ({ status: 'idle' }),
            stateManager: {},
          }) as never,
      },
      retryBackoffBaseMs: 20,
    };
    const scheduler = createMailboxDeferredReplayScheduler(deps);

    scheduler.schedule(SESSION_ID);
    await flush(5);
    expect(publishCalls.filter((id) => id === SESSION_ID)).toHaveLength(1);

    scheduler.cancel(SESSION_ID);
    const fillers = Array.from({ length: 8 }, (_, i) => `filler-${i + 1}`);
    for (const id of fillers) scheduler.schedule(id);
    await flush(30);
    scheduler.cancel(SESSION_ID);
    scheduler.schedule(SESSION_ID);

    for (const id of fillers) gates.get(id)?.();
    await flush(60);

    expect(publishCalls.filter((id) => id === SESSION_ID)).toHaveLength(2);
  });

  test('a fresh schedule during backoff revives a cancelled replay', async () => {
    let failures = 1;
    const publish = mock(async () => {
      if (failures > 0) {
        failures -= 1;
        throw new Error('transient');
      }
    });
    const deps = makeDeps(publish);
    deps.retryBackoffBaseMs = 20;
    const scheduler = createMailboxDeferredReplayScheduler(deps);

    scheduler.schedule(SESSION_ID);
    await flush(5);
    expect(publish).toHaveBeenCalledTimes(1);
    scheduler.cancel(SESSION_ID);
    scheduler.schedule(SESSION_ID);

    await flush(120);
    expect(publish).toHaveBeenCalledTimes(2);
  });

  test('cancel during an in-flight publication stops the dirty requeue', async () => {
    let releasePublish: (() => void) | undefined;
    const publish = mock(
      () =>
        new Promise<void>((resolve) => {
          releasePublish = resolve;
        })
    );
    const deps = makeDeps(async () => {
      await publish();
    });
    const scheduler = createMailboxDeferredReplayScheduler(deps);

    scheduler.schedule(SESSION_ID);
    await flush(10);
    expect(publish).toHaveBeenCalledTimes(1);
    scheduler.schedule(SESSION_ID);
    scheduler.cancel(SESSION_ID);

    releasePublish?.();
    await flush(30);

    expect(publish).toHaveBeenCalledTimes(1);
  });
});
