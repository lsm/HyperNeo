/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import {
  clearStructuredLogSubscribers,
  subscribeToStructuredLogs,
} from '../../../../src/lib/logger';
import {
  createRateAdmission,
  emitActionDispatchedEvent,
  RATE_ADMISSION_WINDOW_MS,
  resolveRateAdmissionOptions,
  SPACE_ACTIONS_RATE_LIMIT_ENV,
} from '../../../../src/lib/space/actions/dispatch-telemetry.ts';
import {
  type DispatchTelemetryEvent,
  runDispatchAction,
} from '../../../../src/lib/space/actions/dispatcher-pipeline.ts';
import { createActionRegistry, defineAction } from '../../../../src/lib/space/actions/registry.ts';

describe('emitActionDispatchedEvent', () => {
  test('emits an action.dispatched structured log with the dispatch fields', () => {
    const events: Array<{ message: string; level: string; metadata: Record<string, unknown> }> = [];
    const unsubscribe = subscribeToStructuredLogs((event) =>
      events.push({
        message: event.message,
        level: event.level,
        metadata: event.metadata,
      })
    );
    try {
      emitActionDispatchedEvent({
        actionName: 'create_scheduled_task',
        family: 'scheduled',
        safetyClass: 'mutate',
        role: 'coordinator',
        spaceId: 'space-1',
        taskId: 'task-1',
        workflowRunId: 'run-1',
        outcome: 'dispatched',
        elapsedMs: 12,
        timestamp: Date.now(),
      });
    } finally {
      unsubscribe();
      clearStructuredLogSubscribers();
    }

    expect(events).toHaveLength(1);
    expect(events[0].message).toBe('action.dispatched');
    expect(events[0].level).toBe('info');
    expect(events[0].metadata).toMatchObject({
      action: 'create_scheduled_task',
      family: 'scheduled',
      safetyClass: 'mutate',
      role: 'coordinator',
      spaceId: 'space-1',
      taskId: 'task-1',
      workflowRunId: 'run-1',
      outcome: 'dispatched',
      elapsedMs: 12,
    });
  });

  test('omits absent optional fields instead of logging undefined values', () => {
    const events: Array<Record<string, unknown>> = [];
    const unsubscribe = subscribeToStructuredLogs((event) => events.push(event.metadata));
    try {
      emitActionDispatchedEvent({
        actionName: 'get_external_event',
        role: 'long_term_agent',
        spaceId: 'space-1',
        outcome: 'denied',
        reason: 'role_denied',
        timestamp: Date.now(),
      });
    } finally {
      unsubscribe();
      clearStructuredLogSubscribers();
    }

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: 'get_external_event',
      outcome: 'denied',
      reason: 'role_denied',
    });
    expect(Object.keys(events[0])).not.toContain('family');
    expect(Object.keys(events[0])).not.toContain('safetyClass');
    expect(Object.keys(events[0])).not.toContain('elapsedMs');
    expect(Object.keys(events[0])).not.toContain('taskId');
  });

  test('logs failed dispatches at warn level', () => {
    const events: Array<{ level: string; metadata: Record<string, unknown> }> = [];
    const unsubscribe = subscribeToStructuredLogs((event) =>
      events.push({ level: event.level, metadata: event.metadata })
    );
    try {
      emitActionDispatchedEvent({
        actionName: 'inactivity_run_now',
        family: 'inactivity',
        safetyClass: 'mutate',
        role: 'coordinator',
        spaceId: 'space-1',
        outcome: 'failed',
        elapsedMs: 3,
        timestamp: Date.now(),
      });
    } finally {
      unsubscribe();
      clearStructuredLogSubscribers();
    }

    expect(events[0].level).toBe('warn');
    expect(events[0].metadata).toMatchObject({ action: 'inactivity_run_now', outcome: 'failed' });
  });
});

describe('rate admission — flag resolution', () => {
  test('is permissive by default when the flag is unset or blank', () => {
    expect(resolveRateAdmissionOptions({})).toBeNull();
    expect(resolveRateAdmissionOptions({ [SPACE_ACTIONS_RATE_LIMIT_ENV]: '' })).toBeNull();
    expect(resolveRateAdmissionOptions({ [SPACE_ACTIONS_RATE_LIMIT_ENV]: '   ' })).toBeNull();
  });

  test('rejects non-positive or unparseable flag values', () => {
    expect(resolveRateAdmissionOptions({ [SPACE_ACTIONS_RATE_LIMIT_ENV]: '0' })).toBeNull();
    expect(resolveRateAdmissionOptions({ [SPACE_ACTIONS_RATE_LIMIT_ENV]: '-5' })).toBeNull();
    expect(resolveRateAdmissionOptions({ [SPACE_ACTIONS_RATE_LIMIT_ENV]: 'abc' })).toBeNull();
    expect(resolveRateAdmissionOptions({ [SPACE_ACTIONS_RATE_LIMIT_ENV]: '1.5' })).toBeNull();
    expect(resolveRateAdmissionOptions({ [SPACE_ACTIONS_RATE_LIMIT_ENV]: '120junk' })).toBeNull();
  });

  test('parses exponent notation at its numeric value', () => {
    expect(resolveRateAdmissionOptions({ [SPACE_ACTIONS_RATE_LIMIT_ENV]: '1e3' })).toEqual({
      maxDispatchesPerWindow: 1000,
      windowMs: RATE_ADMISSION_WINDOW_MS,
    });
  });

  test('parses a positive per-minute limit into admission options', () => {
    expect(resolveRateAdmissionOptions({ [SPACE_ACTIONS_RATE_LIMIT_ENV]: '120' })).toEqual({
      maxDispatchesPerWindow: 120,
      windowMs: RATE_ADMISSION_WINDOW_MS,
    });
  });

  test('an unset flag resolves to a permissive admission', () => {
    expect(createRateAdmission(resolveRateAdmissionOptions({}))()).toBe(true);
  });
});

describe('rate admission — window enforcement', () => {
  test('admits up to the cap then denies until the window rolls over', () => {
    let now = 1_000_000;
    const admit = createRateAdmission({
      maxDispatchesPerWindow: 2,
      windowMs: 60_000,
      now: () => now,
    });

    expect(admit()).toBe(true);
    expect(admit()).toBe(true);
    expect(admit()).toBe(false);
    expect(admit()).toBe(false);

    now += 60_000;
    expect(admit()).toBe(true);
    expect(admit()).toBe(true);
    expect(admit()).toBe(false);
  });

  test('a backward clock step resets the window instead of wedging it shut', () => {
    let now = 1_000_000;
    const admit = createRateAdmission({
      maxDispatchesPerWindow: 1,
      windowMs: 60_000,
      now: () => now,
    });

    expect(admit()).toBe(true);
    expect(admit()).toBe(false);

    now -= 30_000;
    expect(admit()).toBe(true);
    expect(admit()).toBe(false);
  });

  test('a null configuration is always permissive', () => {
    const admit = createRateAdmission(null);
    for (let i = 0; i < 100; i++) expect(admit()).toBe(true);
  });
});

describe('dispatch telemetry through runDispatchAction', () => {
  const readAction = defineAction({
    name: 'list_scheduled_tasks',
    family: 'space',
    safetyClass: 'read',
    description: 'List schedules',
    paramsDoc: '{}',
    paramsSchema: z.object({}),
    handler: async () => ({ schedules: [] }),
  });

  test('the pipeline hands the emitter an event carrying elapsedMs', async () => {
    const telemetry: DispatchTelemetryEvent[] = [];
    const outcome = await runDispatchAction(
      {
        registry: createActionRegistry([readAction]),
        emitTelemetry: (event) => {
          telemetry.push(event);
        },
      },
      {
        actionName: 'list_scheduled_tasks',
        params: {},
        role: 'coordinator',
        spaceId: 'space-1',
      }
    );

    expect(outcome.action).toBe('dispatched');
    expect(telemetry).toHaveLength(1);
    expect(telemetry[0].actionName).toBe('list_scheduled_tasks');
    expect(telemetry[0].outcome).toBe('dispatched');
    expect(typeof telemetry[0].elapsedMs).toBe('number');
    expect(telemetry[0].elapsedMs).toBeGreaterThanOrEqual(0);
  });
});
